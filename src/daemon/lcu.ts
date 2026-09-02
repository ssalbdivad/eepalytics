/**
 * The daemon's single handle on the League client.
 *
 * `src/lcu/` owns the hard parts — the Windows-side `node.exe` bridge (p50 2.3 ms), the
 * `curl.exe` fallback (~88 ms), lockfile parsing, and the typed clients. This module owns the
 * *lifecycle*: one `Lcu` handle for the whole process, torn down and rebuilt when the client
 * restarts (the port AND the password rotate every time), plus the few batched reads the
 * daemon does often enough to be worth naming.
 *
 * Everything here degrades instead of throwing. "The League client is closed" is the normal
 * state of this machine most of the day, not an error path: every helper returns `null` or
 * `false` and the caller defers.
 *
 * NODE ONLY.
 */

import { statSync } from "node:fs"
import { PLATFORM_ID, REPLAY_DIR_WSL, USER_PUUID } from "../shared/constants.ts"
import type {
	LcuGame,
	LcuMatchHistory,
	LcuTimeline,
	ReplayConfiguration,
	ReplayMetadata
} from "../shared/schema/lcu.ts"
import { createLcu, isClientClosed, readLockfileSync, sameLockfile } from "../lcu/index.ts"
import type { Lcu, Lockfile, TransportKind } from "../lcu/index.ts"
import { getSettings } from "../db/queries.ts"
import { errText, makeLogger } from "./log.ts"

const log = makeLogger("lcu")

export type { Lockfile }
export type TransportName = TransportKind | "none"

/* ============================================================== lifecycle */

let handle: Lcu | null = null
let starting: Promise<Lcu | null> | null = null
/** The lockfile generation the current handle was built for. */
let boundTo: Lockfile | null = null

/**
 * The shared handle, started on demand.
 *
 * Both transports start happily with the client closed, so this succeeds even then — the
 * *requests* are what fail, and they fail with `CLIENT_CLOSED`.
 */
export const lcu = async (): Promise<Lcu | null> => {
	if (handle) return handle
	if (starting) return starting
	starting = (async () => {
		try {
			const settings = getSettings()
			const made = await createLcu(settings, {
				puuid: USER_PUUID,
				onLog: line => log.debug(line.replace(/^\[lcu\]\s*/, "")),
				onWarn: message => log.warn(message)
			})
			handle = made
			boundTo = readLockfileSync()
			log.info("transport ready", {
				kind: made.kind,
				fallbackReason: made.fallbackReason ?? undefined
			})
			return made
		} catch (err) {
			log.error("could not start any LCU transport", { err: errText(err) })
			return null
		} finally {
			starting = null
		}
	})()
	return starting
}

/** Tear the handle down. The next call rebuilds it against the current lockfile. */
export const resetTransport = async (): Promise<void> => {
	const old = handle
	handle = null
	boundTo = null
	try {
		await old?.stop()
	} catch {
		/* already gone */
	}
}

/**
 * Rebuild if the client restarted. The password rotates on every restart, so a stale handle
 * would 401 forever; never reuse credentials across a rotation.
 */
export const ensureBoundToCurrentClient = async (): Promise<void> => {
	const now = readLockfileSync()
	if (handle && !sameLockfile(boundTo, now)) {
		log.info("lockfile rotated; rebuilding transport")
		await resetTransport()
	}
	if (now) await lcu()
}

/**
 * Which transport would carry the next request. `"none"` when there is no lockfile: both
 * transports START happily with the client closed, so `handle.kind` alone would claim a
 * working connection where there is none.
 */
export const transportName = (): TransportName =>
	readLockfileSync() === null ? "none" : (handle?.kind ?? "none")

export const getCreds = (): Lockfile | null => readLockfileSync()

export const closeTransport = resetTransport

/* ================================================================ reads */

/** Run `fn` against the client, turning "client is closed" into `null` rather than a throw. */
const tryCall = async <T>(
	what: string,
	fn: (client: Lcu) => Promise<T>
): Promise<T | null> => {
	const h = await lcu()
	if (!h) return null
	try {
		return await fn(h)
	} catch (err) {
		if (isClientClosed(err)) log.debug(`${what}: client closed`)
		else log.warn(`${what} failed`, { err: errText(err) })
		return null
	}
}

export const ping = async (): Promise<boolean> =>
	(await tryCall("ping", h => h.client.ping())) ?? false

export const fetchGameflowPhase = async (): Promise<string | null> =>
	tryCall("gameflow-phase", h => h.client.gameflowPhase())

export const fetchCurrentGameId = async (): Promise<number | null> =>
	tryCall("current-game-id", h => h.client.currentGameId())

export const fetchReplayConfiguration = async (): Promise<ReplayConfiguration | null> =>
	tryCall("replay-configuration", h => h.client.replayConfiguration())

/**
 * The recent-games window.
 *
 * `begIndex`/`endIndex` are parsed and then SILENTLY IGNORED — every range returns the same
 * server-chosen ~20 games, and the window was observed shrinking from 21 to 5 inside twenty
 * minutes. Treat it as "recent games, count unspecified", never as a page: deep history comes
 * from harvesting these ids into SQLite, and `/games/{id}` accepts arbitrary ids forever after.
 */
export const fetchMatchHistory = async (): Promise<LcuMatchHistory | null> =>
	tryCall("match-history", h => h.client.matchHistory())

export const fetchGame = async (gameId: number): Promise<LcuGame | null> =>
	tryCall("game", h => h.client.game(gameId))

export const fetchTimeline = async (gameId: number): Promise<LcuTimeline | null> =>
	tryCall("timeline", h => h.client.timeline(gameId))

export const fetchChampionSummary = async (): Promise<
	{ id: number; name?: string; alias?: string }[] | null
> => tryCall("champion-summary", h => h.client.championSummary())

/**
 * Replay metadata is LOCAL client state, not a server query.
 *
 * `null` means the client has never created a local record for this gameId — POST the create
 * endpoint first. It does NOT mean the replay expired; that is `state: "missingOrExpired"`.
 * `downloadProgress` is uninitialised garbage until `state === "downloading"`.
 */
export const fetchReplayMetadata = async (
	gameId: number
): Promise<ReplayMetadata | null> =>
	tryCall("replay-metadata", h => h.client.replayMetadata(gameId))

/* =============================================================== writes */

/**
 * The daemon issues exactly three POSTs, all of them client-local replay bookkeeping:
 * `createReplayMetadata`, `downloadReplay` and (from the capture unit only, behind the gate)
 * `watchReplay`. Nothing else in this app ever mutates the League client.
 */
export const createReplayMetadata = async (args: {
	gameId: number
	gameVersion: string
	gameType: string
	queueId: number
	gameEndMs: number
}): Promise<{ ok: boolean; error?: string }> => {
	const h = await lcu()
	if (!h) return { ok: false, error: "League client is closed" }
	try {
		await h.client.createReplayMetadata(args.gameId, {
			gameVersion: args.gameVersion,
			gameType: args.gameType,
			queueId: args.queueId,
			gameEnd: args.gameEndMs
		})
		return { ok: true }
	} catch (err) {
		return { ok: false, error: errText(err) }
	}
}

/**
 * Ask the client to fetch the `.rofl` in the background. NON-INTRUSIVE — no window opens and
 * no game launches — and URGENT, because the replay is gone 30 minutes after the game ends.
 */
export const startReplayDownload = async (
	gameId: number
): Promise<{ ok: boolean; error?: string }> => {
	const h = await lcu()
	if (!h) return { ok: false, error: "League client is closed" }
	try {
		await h.client.downloadReplay(gameId, { componentType: "coachskaffur" })
		return { ok: true }
	} catch (err) {
		return { ok: false, error: errText(err) }
	}
}

/* ============================================================ snapshots */

/**
 * Everything the intrusive-job gate needs (G1-G4) in one pass.
 *
 * Reads are issued together so the bridge pipelines them and curl reuses one TLS connection
 * (`--next`: 33 ms for the first request, 2 ms for each after). Evaluating the whole gate
 * costs one round trip, not four.
 */
export interface IdleSnapshot {
	phase: string | null
	config: ReplayConfiguration | null
	/** Port 2999 only answers while a game or a replay is actually running. */
	liveApiAnswering: boolean
	reachable: boolean
}

export const fetchIdleSnapshot = async (): Promise<IdleSnapshot> => {
	const h = await lcu()
	if (!h)
		return { phase: null, config: null, liveApiAnswering: false, reachable: false }

	const [phase, config, live] = await Promise.all([
		h.client.gameflowPhase().catch(() => null),
		h.client.replayConfiguration().catch(() => null),
		h.live.isAlive().catch(() => false)
	])

	return {
		phase,
		config,
		liveApiAnswering: live === true,
		reachable: phase !== null || config !== null
	}
}

/**
 * One static asset (champion icon, item icon, …) through the AUTHENTICATED transport.
 *
 * The LCU serves these locally and they need the same basic auth as everything else, so the
 * browser cannot fetch them directly — the HTTP layer proxies through here. Returns `null`
 * when the client is closed, and the server falls back to CommunityDragon.
 */
export const fetchLcuAsset = async (
	assetPath: string
): Promise<{ body: Uint8Array; contentType: string } | null> => {
	const bytes = await tryCall("asset", h => h.client.asset(assetPath))
	if (!bytes) return null
	return { body: new Uint8Array(bytes), contentType: contentTypeOf(assetPath) }
}

const contentTypeOf = (path: string): string => {
	const ext = path.slice(path.lastIndexOf(".")).toLowerCase()
	return (
		{
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".webp": "image/webp",
			".svg": "image/svg+xml",
			".json": "application/json"
		}[ext] ?? "application/octet-stream"
	)
}

/* ================================================================ disk */

/** `{platformId}-{gameId}.rofl`, verified against the one file on this machine. */
export const roflPathFor = (
	gameId: number,
	platformId: string = PLATFORM_ID
): string => `${REPLAY_DIR_WSL}/${platformId || PLATFORM_ID}-${gameId}.rofl`

export const roflExistsOnDisk = (path: string | null): boolean => {
	if (!path) return false
	try {
		return statSync(path).size > 0
	} catch {
		return false
	}
}
