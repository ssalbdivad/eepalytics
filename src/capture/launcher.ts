/**
 * Replay launch state machine.
 *
 * Drives the League client into a replay, waits for the game's Replay API on :2999 to come
 * up, hands back a session, and — always, in a `finally` — tears the replay back down.
 *
 * The single worst bug this app could have is leaving the user's client stuck in a replay,
 * because that blocks their next game. Every path out of `withReplaySession` runs teardown,
 * teardown has three escalating fallbacks, and teardown verifies itself against the client's
 * own `isPlayingReplay` flag rather than trusting that a POST worked.
 *
 * Sources: `.research/replay-capture.md` §4 (LCU launch), §6 (state machine, timing budget,
 * failure modes, clean exit). Timing numbers there are measured for a *live game* launch
 * (~10 s to main loop); the replay-specific part is UNVERIFIED, hence the generous timeouts.
 */

import { open, stat } from "node:fs/promises"
import { spawn } from "node:child_process"
import {
	IDLE_PHASES,
	LEAGUE_DIR,
	PLATFORM_ID,
	REPLAY_DIR_WSL,
	patchOf
} from "../shared/constants.ts"
import {
	ReplayConfiguration,
	ReplayMetadata,
	parseOrNull
} from "../shared/schema/lcu.ts"
import { COACHING_SCENE, HUD_OFF, type RenderSettings } from "./camera.ts"
import { curlClients, jsonOf, okJson } from "./transport.ts"
import {
	CaptureError,
	type CaptureClients,
	type LaunchFailureReason,
	type ReplayGameInfo,
	type ReplayObject,
	type ReplayPlayback
} from "./types.ts"

/* ================================================================ timing */

/** How long the client may take to acknowledge the watch request at all. */
export const WATCH_ACK_TIMEOUT_MS = 25_000
/** How long from `POST .../watch` until the game process reports WatchInProgress. */
export const LAUNCH_TIMEOUT_MS = 90_000
/** How long after that until :2999 answers `/replay/game`. Budget is 15-30 s in practice. */
export const API_TIMEOUT_MS = 120_000
/** A single seek. Long scrubs replay chunks forward from the nearest keyframe. */
export const SEEK_TIMEOUT_MS = 60_000
/** Teardown verification. */
export const TEARDOWN_TIMEOUT_MS = 30_000
/** Poll interval for every "wait until" loop below. */
export const POLL_MS = 500
/** Seek is considered landed within this many seconds of the target. */
export const SEEK_TOLERANCE_SEC = 0.25
/** Seek slightly before the target so the engine has settled by the time we record. */
export const SEEK_LEAD_SEC = 2.0

const WIN_TASKKILL = "/mnt/c/WINDOWS/system32/taskkill.exe"

/* =============================================================== helpers */

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new CaptureError("aborted", "aborted while waiting"))
			return
		}
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort)
			resolve()
		}, ms)
		const onAbort = () => {
			clearTimeout(t)
			reject(new CaptureError("aborted", "aborted while waiting"))
		}
		signal?.addEventListener("abort", onAbort, { once: true })
	})

export const throwIfAborted = (signal?: AbortSignal): void => {
	if (signal?.aborted) throw new CaptureError("aborted", "aborted by caller")
}

/* ============================================================ rofl on disk */

/** The client writes `<platformId>-<gameId>.rofl`. Verified from the binary's format string. */
export const roflFileName = (gameId: number, platformId: string = PLATFORM_ID): string =>
	`${platformId}-${gameId}.rofl`

export const roflPathFor = (gameId: number, platformId: string = PLATFORM_ID): string =>
	`${REPLAY_DIR_WSL}/${roflFileName(gameId, platformId)}`

export interface RoflHeader {
	gameVersion: string
	patch: string
}

/**
 * Parse the ROFL2 header prefix. Layout verified by hand against a real file:
 * `52 49 4f 54 02 00` magic, 8 bytes network-protocol digest, one length byte, then that
 * many bytes of ASCII gameVersion ("16.17.810.4348").
 *
 * This is deliberately a 64-byte peek and NOT a rofl decoder — `src/rofl/` owns that. All we
 * need is the patch, to refuse an incompatible replay before we take over the client.
 */
export const parseRoflHeader = (buf: Uint8Array): RoflHeader | null => {
	if (buf.length < 16) return null
	const magic = [0x52, 0x49, 0x4f, 0x54, 0x02, 0x00]
	for (let i = 0; i < magic.length; i++) if (buf[i] !== magic[i]) return null
	const len = buf[14]
	if (len === undefined || len === 0 || 15 + len > buf.length) return null
	let gameVersion = ""
	for (let i = 0; i < len; i++) {
		const b = buf[15 + i]
		if (b === undefined || b < 0x20 || b > 0x7e) return null
		gameVersion += String.fromCharCode(b)
	}
	return { gameVersion, patch: patchOf(gameVersion) }
}

export const readRoflHeader = async (path: string): Promise<RoflHeader | null> => {
	let handle
	try {
		handle = await open(path, "r")
		const buf = new Uint8Array(64)
		const { bytesRead } = await handle.read(buf, 0, 64, 0)
		return parseRoflHeader(buf.subarray(0, bytesRead))
	} catch {
		return null
	} finally {
		await handle?.close().catch(() => {})
	}
}

export const roflExists = async (path: string): Promise<number | null> => {
	try {
		const s = await stat(path)
		return s.isFile() ? s.size : null
	} catch {
		return null
	}
}

/* ============================================================= preflight */

export interface PreflightVerdict {
	ok: boolean
	reason: LaunchFailureReason | null
	/** Human sentence for the job row and the UI. Always populated. */
	note: string
	phase: string | null
	watch: string | null
	config: ReplayConfiguration | null
	roflPath: string | null
	roflPatch: string | null
	clientPatch: string | null
}

const fail = (
	reason: LaunchFailureReason,
	note: string,
	partial: Partial<PreflightVerdict> = {}
): PreflightVerdict => ({
	ok: false,
	reason,
	note,
	phase: null,
	watch: null,
	config: null,
	roflPath: null,
	roflPatch: null,
	clientPatch: null,
	...partial
})

/**
 * Every precondition from `.research/replay-capture.md` §6.1, read fresh. This overlaps the
 * daemon's G1-G9 gate on purpose: the gate decides *whether to start*, this decides *whether
 * it is still true right now*, and between the two there is a queue and a scheduler.
 */
export const preflight = async (
	gameId: number,
	clients: CaptureClients,
	opts: { platformId?: string; signal?: AbortSignal } = {}
): Promise<PreflightVerdict> => {
	throwIfAborted(opts.signal)

	const configReply = await clients.lcu
		.request("GET", "/lol-replays/v1/configuration")
		.catch(() => null)
	if (!configReply || configReply.status !== 200)
		return fail("gated", "League client is not reachable (is it running?)")

	const config = parseOrNull(ReplayConfiguration, jsonOf(configReply))
	if (!config) return fail("gated", "replay configuration did not parse")

	if (config.isPlayingGame)
		return fail("gated", "you are in a game — capture waits until you are back in the lobby", {
			config
		})
	if (config.isPlayingReplay)
		return fail("gated", "a replay is already playing", { config })
	if (config.isPatching) return fail("gated", "the client is patching", { config })
	if (config.isLoggedIn === false) return fail("gated", "the client is not logged in", { config })
	if (config.isInTournament) return fail("gated", "tournament mode is active", { config })
	if (config.isReplaysEnabled === false)
		return fail("gated", "replays are disabled in the client", { config })
	if (config.isReplaysForMatchHistoryEnabled === false)
		return fail("gated", "match-history replays are disabled in the client", { config })

	const phase = okJson<string>(
		await clients.lcu.request("GET", "/lol-gameflow/v1/gameflow-phase").catch(() => ({
			status: 0,
			body: ""
		}))
	)
	if (phase === null) return fail("gated", "could not read the gameflow phase", { config })
	if (!(IDLE_PHASES as readonly string[]).includes(phase))
		return fail("gated", `client is busy (phase ${phase})`, { config, phase })

	const watch = okJson<string>(
		await clients.lcu.request("GET", "/lol-gameflow/v1/watch").catch(() => ({
			status: 0,
			body: ""
		}))
	)
	if (watch !== null && watch !== "None")
		return fail("gated", `a watch is already running (${watch})`, { config, phase, watch })

	// G9 + patch compatibility, straight off the filesystem.
	const roflPath = roflPathFor(gameId, opts.platformId)
	const size = await roflExists(roflPath)
	if (size === null)
		return fail("rofl-missing", `no replay file on disk at ${roflPath}`, {
			config,
			phase,
			watch,
			roflPath
		})

	const header = await readRoflHeader(roflPath)
	const clientPatch = config.gameVersion ? patchOf(config.gameVersion) : null
	if (header && clientPatch && header.patch !== clientPatch)
		return fail(
			"patch-mismatch",
			`replay is patch ${header.patch}, client is on ${clientPatch} — old replays die on patch day`,
			{ config, phase, watch, roflPath, roflPatch: header.patch, clientPatch }
		)

	return {
		ok: true,
		reason: null,
		note: "idle, replay on disk, patch matches",
		phase,
		watch,
		config,
		roflPath,
		roflPatch: header?.patch ?? null,
		clientPatch
	}
}

/* ================================================== pure state machine */

export type LaunchPhase =
	| "idle"
	| "preflight"
	| "ensure-rofl"
	| "ready"
	| "launching"
	| "api-wait"
	| "up"
	| "teardown"
	| "closed"
	| "failed"

export type LaunchSignal =
	| { kind: "start" }
	| { kind: "preflight-ok" }
	| { kind: "preflight-refused"; reason: LaunchFailureReason }
	| { kind: "rofl-ready" }
	| { kind: "rofl-unavailable"; reason: LaunchFailureReason }
	| { kind: "watch-accepted" }
	| { kind: "watch-failed" }
	| { kind: "launch-timeout" }
	| { kind: "api-up" }
	| { kind: "api-timeout" }
	| { kind: "teardown" }
	| { kind: "closed" }
	| { kind: "abort" }

export interface LaunchStatus {
	phase: LaunchPhase
	failure: LaunchFailureReason | null
}

export const INITIAL_LAUNCH_STATUS: LaunchStatus = { phase: "idle", failure: null }

/**
 * Pure transition function. Exported so the state machine can be tested exhaustively without
 * ever touching the client — which is the only way to test it, because launching a replay
 * while the user might be playing is forbidden.
 *
 * Rules: `abort` is legal from anywhere and always routes through teardown if a process may
 * exist. Unknown signals are ignored rather than throwing, so a late poll result arriving
 * after a failure cannot resurrect the machine.
 */
export const launchTransition = (
	status: LaunchStatus,
	signal: LaunchSignal
): LaunchStatus => {
	const { phase } = status
	if (phase === "closed" || phase === "failed") return status

	if (signal.kind === "abort") {
		// Anything that may have spawned a process must be torn down, not just dropped.
		const needsTeardown =
			phase === "launching" || phase === "api-wait" || phase === "up" || phase === "teardown"
		return needsTeardown ?
				{ phase: "teardown", failure: "aborted" }
			:	{ phase: "failed", failure: "aborted" }
	}

	switch (phase) {
		case "idle":
			return signal.kind === "start" ? { phase: "preflight", failure: null } : status
		case "preflight":
			if (signal.kind === "preflight-ok") return { phase: "ensure-rofl", failure: null }
			if (signal.kind === "preflight-refused")
				return { phase: "failed", failure: signal.reason }
			return status
		case "ensure-rofl":
			if (signal.kind === "rofl-ready") return { phase: "ready", failure: null }
			if (signal.kind === "rofl-unavailable")
				return { phase: "failed", failure: signal.reason }
			return status
		case "ready":
			if (signal.kind === "watch-accepted") return { phase: "launching", failure: null }
			if (signal.kind === "watch-failed")
				return { phase: "failed", failure: "launch-timeout" }
			return status
		case "launching":
			if (signal.kind === "api-up") return { phase: "up", failure: null }
			if (signal.kind === "watch-accepted") return { phase: "api-wait", failure: null }
			if (signal.kind === "launch-timeout")
				return { phase: "teardown", failure: "launch-timeout" }
			if (signal.kind === "watch-failed")
				return { phase: "teardown", failure: "launch-timeout" }
			return status
		case "api-wait":
			if (signal.kind === "api-up") return { phase: "up", failure: null }
			if (signal.kind === "api-timeout") return { phase: "teardown", failure: "api-timeout" }
			return status
		case "up":
			return signal.kind === "teardown" ?
					{ phase: "teardown", failure: status.failure }
				:	status
		case "teardown":
			return signal.kind === "closed" ?
					{ phase: status.failure ? "failed" : "closed", failure: status.failure }
				:	status
		default:
			return status
	}
}

/* =============================================================== session */

export interface ReplaySession {
	readonly gameId: number
	readonly clients: CaptureClients
	/** PID reported by `GET /replay/game`, used as the last-resort teardown lever. */
	readonly processId: number | null
	/** Wall-clock ms from `POST .../watch` to the Replay API answering. Worth recording. */
	readonly launchMs: number
	readonly status: () => LaunchStatus
	getPlayback(): Promise<ReplayPlayback>
	setPlayback(body: ReplayPlayback): Promise<void>
	setRender(body: RenderSettings): Promise<void>
	getRender(): Promise<Record<string, unknown> | null>
	objects(types?: string, detail?: boolean): Promise<ReplayObject[]>
	/** Seek to `tSec` and wait until the engine says it has landed there. */
	seek(tSec: number, signal?: AbortSignal): Promise<number>
	/** Tear down the replay. Resolves `true` only when the client CONFIRMED it is out. */
	close(): Promise<boolean>
}

const replayGet = async <T>(clients: CaptureClients, path: string): Promise<T | null> => {
	try {
		return okJson<T>(await clients.game.request("GET", path))
	} catch {
		return null
	}
}

/** Wait until `probe` returns a value, or give up. Returns null on timeout. */
const waitFor = async <T>(
	probe: () => Promise<T | null>,
	timeoutMs: number,
	signal?: AbortSignal,
	pollMs = POLL_MS
): Promise<T | null> => {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		throwIfAborted(signal)
		const v = await probe()
		if (v !== null && v !== undefined) return v
		if (Date.now() >= deadline) return null
		await sleep(pollMs, signal)
	}
}

export interface LaunchOptions {
	clients?: CaptureClients
	platformId?: string
	signal?: AbortSignal
	/** Told about each phase change so the daemon can emit `capture` SSE events. */
	onPhase?: (phase: LaunchPhase, note: string) => void
	/** Skip preflight (the daemon's gate already ran it). Defaults to false — belt and braces. */
	skipPreflight?: boolean
	/** Apply the coaching scene (HUD off, fog off) as soon as the API is up. */
	applyScene?: boolean
	componentType?: string
}

/**
 * Take the client into a replay of `gameId` and return a live session.
 *
 * DANGEROUS: this drives the user's real game client. Call it only behind the daemon gate,
 * or through `src/capture/manual-test.ts`, which requires an explicit confirmation flag.
 *
 * Always prefer `withReplaySession`, which guarantees teardown.
 */
export const launchReplay = async (
	gameId: number,
	opts: LaunchOptions = {}
): Promise<ReplaySession> => {
	const clients = opts.clients ?? curlClients()
	const signal = opts.signal
	let status = launchTransition(INITIAL_LAUNCH_STATUS, { kind: "start" })
	const announce = (note: string) => opts.onPhase?.(status.phase, note)

	const step = (sig: LaunchSignal, note: string) => {
		status = launchTransition(status, sig)
		announce(note)
	}

	if (!opts.skipPreflight) {
		const verdict = await preflight(gameId, clients, {
			platformId: opts.platformId,
			signal
		})
		if (!verdict.ok) {
			step({ kind: "preflight-refused", reason: verdict.reason ?? "gated" }, verdict.note)
			throw new CaptureError(verdict.reason ?? "gated", verdict.note)
		}
		step({ kind: "preflight-ok" }, verdict.note)
	} else {
		step({ kind: "preflight-ok" }, "preflight skipped (caller vouched)")
	}

	// ENSURE_ROFL — the file must be there. We never trigger a download here: that is
	// `replay-download`'s job and it has its own 30-minute deadline.
	const roflPath = roflPathFor(gameId, opts.platformId)
	if ((await roflExists(roflPath)) === null) {
		step({ kind: "rofl-unavailable", reason: "rofl-missing" }, `missing ${roflPath}`)
		throw new CaptureError("rofl-missing", `no replay file at ${roflPath}`, roflPath)
	}
	step({ kind: "rofl-ready" }, "replay file present")

	// READY -> LAUNCHING. `componentType` is telemetry only; any non-empty string works.
	const t0 = Date.now()
	const watchReply = await clients.lcu.request(
		"POST",
		`/lol-replays/v1/rofls/${gameId}/watch`,
		{ componentType: opts.componentType ?? "coachskaffur" }
	)
	if (watchReply.status >= 400) {
		step({ kind: "watch-failed" }, `client refused the watch (HTTP ${watchReply.status})`)
		await teardown(clients, null, signal).catch(() => {})
		throw new CaptureError(
			"launch-timeout",
			`client refused the watch request (HTTP ${watchReply.status})`,
			watchReply.body.slice(0, 300)
		)
	}
	step({ kind: "watch-accepted" }, "watch requested")

	// The client must at least leave "None" within the ack window, or the request never took.
	const acked = await waitFor(
		async () => {
			const w = okJson<string>(
				await clients.lcu.request("GET", "/lol-gameflow/v1/watch").catch(() => ({
					status: 0,
					body: ""
				}))
			)
			if (w === "WatchFailedToLaunch") return "failed"
			return w && w !== "None" ? w : null
		},
		WATCH_ACK_TIMEOUT_MS,
		signal
	)
	if (acked === null || acked === "failed") {
		step(
			{ kind: "launch-timeout" },
			acked === "failed" ? "client reported WatchFailedToLaunch" : "watch never started"
		)
		await teardown(clients, null, signal).catch(() => {})
		throw new CaptureError(
			"launch-timeout",
			acked === "failed" ?
				"the client reported WatchFailedToLaunch"
			:	`the watch never left "None" within ${WATCH_ACK_TIMEOUT_MS} ms`
		)
	}
	step({ kind: "watch-accepted" }, `watch ${acked}`)

	// LAUNCHING/API_WAIT -> UP. The game process has to boot (~10 s to main loop for a live
	// game; replay adds asset load + keyframe seek) and then register the /replay handlers.
	const game = await waitFor<ReplayGameInfo>(
		async () => {
			const g = await replayGet<ReplayGameInfo>(clients, "/replay/game")
			return g && typeof g.processID === "number" ? g : null
		},
		LAUNCH_TIMEOUT_MS + API_TIMEOUT_MS,
		signal,
		1_000
	)
	if (!game) {
		step({ kind: "api-timeout" }, "Replay API never answered on :2999")
		await teardown(clients, null, signal).catch(() => {})
		throw new CaptureError(
			"api-timeout",
			"the game started but the Replay API on :2999 never answered — " +
				"if this persists, see README.md on EnableReplayApi"
		)
	}
	const launchMs = Date.now() - t0
	step({ kind: "api-up" }, `Replay API up after ${launchMs} ms`)

	const processId = typeof game.processID === "number" ? game.processID : null

	const session: ReplaySession = {
		gameId,
		clients,
		processId,
		launchMs,
		status: () => status,
		getPlayback: async () =>
			(await replayGet<ReplayPlayback>(clients, "/replay/playback")) ?? {},
		setPlayback: async body => {
			await clients.game.request("POST", "/replay/playback", body)
		},
		setRender: async body => {
			await clients.game.request("POST", "/replay/render", body)
		},
		getRender: async () => await replayGet<Record<string, unknown>>(clients, "/replay/render"),
		objects: async (types = "hero", detail = true) => {
			const q = `?types=${encodeURIComponent(types)}${detail ? "&detail=true" : ""}`
			const raw = await replayGet<{ objects?: ReplayObject[] } | ReplayObject[]>(
				clients,
				`/replay/objects${q}`
			)
			if (!raw) return []
			return Array.isArray(raw) ? raw : (raw.objects ?? [])
		},
		seek: (tSec, sig) => seekTo(clients, tSec, sig ?? signal),
		close: async () => {
			step({ kind: "teardown" }, "tearing down")
			const confirmed = await teardown(clients, processId, undefined)
			step(
				{ kind: "closed" },
				confirmed ? "replay closed" : "teardown UNCONFIRMED — check the client"
			)
			return confirmed
		}
	}

	if (opts.applyScene !== false) await applySceneSetup(session)

	return session
}

/**
 * Run `fn` against a replay session and ALWAYS tear the replay down afterwards, including on
 * throw, on abort, and on a teardown that itself fails. This is the only entry point the
 * pipeline uses.
 */
export const withReplaySession = async <T>(
	gameId: number,
	opts: LaunchOptions,
	fn: (session: ReplaySession) => Promise<T>
): Promise<T> => {
	const session = await launchReplay(gameId, opts)
	try {
		return await fn(session)
	} finally {
		// Teardown is best-effort but never skipped, and never masks the original error.
		await session.close().catch(() => {})
	}
}

/**
 * Scene setup, in two requests on purpose: Riot does not document whether `interfaceAll`
 * beats the individual `interface*` flags when both are in one body, so we send the master
 * switch first and the specifics second. The result is defined either way.
 */
export const applySceneSetup = async (session: ReplaySession): Promise<void> => {
	await session.setRender(HUD_OFF)
	await session.setRender(COACHING_SCENE)
	await session.setPlayback({ paused: true, speed: 1.0 })
}

/* ================================================================== seek */

/**
 * Seek to `tSec` and wait until the engine reports it has landed.
 *
 * The clocks line up: `timeline.timestamp / 1000 === Playback.time === LiveClientData
 * EventTime` (§6.4, cross-checked against gameDuration). That equality is the thing most
 * likely to silently produce a picture of the wrong moment, so `manual-test.ts` re-verifies
 * it once against a known CHAMPION_KILL before any capture is trusted.
 *
 * Returns the time actually landed on.
 */
export const seekTo = async (
	clients: CaptureClients,
	tSec: number,
	signal?: AbortSignal,
	timeoutMs = SEEK_TIMEOUT_MS
): Promise<number> => {
	const target = Math.max(0, tSec)
	await clients.game.request("POST", "/replay/playback", {
		paused: true,
		speed: 1.0,
		time: Math.max(0, target - SEEK_LEAD_SEC)
	})
	// Nudge to the exact target after the coarse scrub, so the lead-in has been rendered.
	const landed = await waitFor<number>(
		async () => {
			const p = await replayGet<ReplayPlayback>(clients, "/replay/playback")
			if (!p || typeof p.time !== "number") return null
			if (p.seeking) return null
			return p.time
		},
		timeoutMs,
		signal
	)
	if (landed === null)
		throw new CaptureError("seek-timeout", `seek to ${target}s never settled`)

	await clients.game.request("POST", "/replay/playback", { paused: true, time: target })
	const final = await waitFor<number>(
		async () => {
			const p = await replayGet<ReplayPlayback>(clients, "/replay/playback")
			if (!p || typeof p.time !== "number" || p.seeking) return null
			return Math.abs(p.time - target) <= SEEK_TOLERANCE_SEC ? p.time : null
		},
		timeoutMs,
		signal
	)
	if (final === null)
		throw new CaptureError(
			"seek-timeout",
			`seek landed but never reached ${target}s within ${SEEK_TOLERANCE_SEC}s`
		)
	return final
}

/* ============================================================== teardown */

/**
 * Get out of the replay, and prove it.
 *
 * Three levers, escalating (§6.6):
 *   1. `POST :2999/Exit`  — documented, present in the live OpenAPI paths.
 *   2. nothing            — there is no `/lol-gameflow/v1/watch/quit` in the LCU registry.
 *   3. `taskkill /PID`    — blunt but reliable. NEVER by image name: that would kill a live
 *                           game. Only the PID `/replay/game` gave us.
 *
 * Then verify against `watch == "None"` and `isPlayingReplay == false`, because a leaked
 * replay process blocks the user's next game.
 */
export const teardown = async (
	clients: CaptureClients,
	processId: number | null,
	signal?: AbortSignal
): Promise<boolean> => {
	// Deliberately does NOT honour `signal` for the abort itself — when the user starts
	// queueing, closing the replay is exactly what we must still do.
	void signal

	await clients.game.request("POST", "/Exit", {}).catch(() => {})

	if (await waitForIdle(clients, TEARDOWN_TIMEOUT_MS / 2)) return true

	if (processId !== null && processId > 0) {
		await killPid(processId).catch(() => {})
		if (await waitForIdle(clients, TEARDOWN_TIMEOUT_MS / 2)) return true
	}
	return false
}

/** Poll the client until it agrees no replay is playing. */
export const waitForIdle = async (
	clients: CaptureClients,
	timeoutMs: number
): Promise<boolean> => {
	const got = await waitFor<boolean>(
		async () => {
			const w = okJson<string>(
				await clients.lcu
					.request("GET", "/lol-gameflow/v1/watch")
					.catch(() => ({ status: 0, body: "" }))
			)
			const cfg = parseOrNull(
				ReplayConfiguration,
				jsonOf(
					await clients.lcu
						.request("GET", "/lol-replays/v1/configuration")
						.catch(() => ({ status: 0, body: "" }))
				)
			)
			const watchIdle = w === null || w === "None"
			const replayIdle = !cfg || cfg.isPlayingReplay !== true
			return watchIdle && replayIdle ? true : null
		},
		timeoutMs,
		undefined,
		1_000
	)
	return got === true
}

const killPid = (pid: number): Promise<void> =>
	new Promise(resolve => {
		const child = spawn(WIN_TASKKILL, ["/PID", String(pid), "/F"], { stdio: "ignore" })
		child.on("error", () => resolve())
		child.on("close", () => resolve())
	})

/* ======================================================= replay metadata */

/**
 * `GET /lol-replays/v1/metadata/{gameId}`. A 404 means "the client has never created local
 * metadata for this game", which is NOT the same as expired. Returned as `null` so callers
 * can tell the difference.
 */
export const replayMetadata = async (
	gameId: number,
	clients: CaptureClients
): Promise<ReplayMetadata | null> => {
	const reply = await clients.lcu
		.request("GET", `/lol-replays/v1/metadata/${gameId}`)
		.catch(() => null)
	if (!reply || reply.status !== 200) return null
	return parseOrNull(ReplayMetadata, jsonOf(reply))
}

/** Where the install lives, for the README's manual-test instructions. */
export const LEAGUE_INSTALL = LEAGUE_DIR
