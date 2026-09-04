/**
 * The rule that makes background operation safe.
 *
 * Exactly one job kind is INTRUSIVE: `replay-capture`, which POSTs `/rofls/{id}/watch` and
 * takes over the League client — a full-screen game window appears on the user's desktop.
 * Doing that while someone is queueing, in champ select, or playing would be unforgivable, so
 * it is allowed only when every one of nine conditions holds, and it is aborted the instant
 * any of them stops holding.
 *
 * Everything else — HTTP reads, the replay-download POST, analysis, Claude calls, SVG
 * rendering — is non-intrusive and runs any time, including mid-game.
 *
 * The gate FAILS CLOSED: an unrecognised gameflow phase, an unreachable client, or a read
 * error all read as "not idle".
 *
 * NODE ONLY.
 */

import { IDLE_PHASES } from "../shared/constants.ts"
import type { Settings } from "../shared/schema/settings.ts"
import { intrusiveJobRunning } from "../db/queries.ts"
import { readAnyLockfileSync, sameLockfile } from "../lcu/index.ts"
import type { Lockfile } from "../lcu/index.ts"
import { fetchIdleSnapshot, roflExistsOnDisk } from "./lcu.ts"
import { sleep } from "./bus.ts"
import { errText, makeLogger } from "./log.ts"

const log = makeLogger("gate")

/** The allowlist. Anything else — including phases we have never seen — is "busy". */
export const isIdlePhase = (phase: string | null): boolean =>
	phase !== null && (IDLE_PHASES as readonly string[]).includes(phase)

/* ========================================================== idle tracking */

let idleSinceMs: number | null = null
let lastPhase: string | null = null

/**
 * Fed by the supervisor on every phase observation. G5 needs *continuous* idleness, which
 * cannot be read from a single sample — a user who dodges a queue is briefly back in `Lobby`
 * and must not have their client hijacked in that gap.
 *
 * THE CLOCK RESTARTS ON LEAVING IDLE, NOT ON EVERY CHANGE. `IDLE_PHASES` has two members,
 * `None` and `Lobby`, and a client sitting untouched moves between them — creating a lobby,
 * backing out of one. Both are idle; neither is the user starting something. Worse, two callers
 * feed this (the supervisor on its poll, and `readGateState` on every gate evaluation) and they
 * do not always sample the same instant, so the pair alternated `None`/`Lobby` and reset each
 * other forever.
 *
 * The effect was total: G5 reported "only idle for 0s of the required 120s" indefinitely, so the
 * capture gate could never open and replay capture had never once run. Continuity is about
 * whether the client left idle — not about which idle phase it is in.
 */
export const notePhase = (phase: string | null, nowMs = Date.now()): void => {
	if (phase === lastPhase) return
	lastPhase = phase
	if (!isIdlePhase(phase)) {
		// Any non-idle phase — champ select, a game, an unreadable client — voids the streak.
		idleSinceMs = null
	} else if (idleSinceMs === null) {
		// Entering idle from anywhere else starts the clock.
		idleSinceMs = nowMs
	}
	// Already idle and still idle: keep the existing start time. This is the fix.
	log.debug("phase observed", { phase, idleForMs: idleForMs(nowMs) })
}

export const currentPhase = (): string | null => lastPhase

export const idleForMs = (nowMs = Date.now()): number =>
	idleSinceMs === null ? 0 : nowMs - idleSinceMs

/** Test seam. */
export const resetIdleTracking = (): void => {
	idleSinceMs = null
	lastPhase = null
}

/* ============================================================ evaluation */

export interface GateState {
	/** G1 */
	phase: string | null
	/** G2 */
	isPlayingGame: boolean
	/** G3 */
	isPlayingReplay: boolean
	/** G4 — port 2999 only answers while a game or replay is actually running. */
	liveApiAnswering: boolean
	/** G5 */
	idleForMs: number
	/** G6 + G5's threshold */
	settings: Pick<Settings, "captureEnabled" | "idleGraceMs">
	/** G8 */
	otherIntrusiveRunning: boolean
	/** True when a human clicked "capture" for this job, which satisfies G5 on its own. */
	userRequested?: boolean
	/** G9 */
	roflOnDisk: boolean
	/** Whether the client answered at all. */
	reachable: boolean
}

export interface GateVerdict {
	ok: boolean
	/** One short sentence, shown verbatim in the UI and stored in `job.lastError`. */
	reason: string
	/** Which rules failed, e.g. `["G1", "G5"]` — for the queue screen's detail view. */
	failed: string[]
	/** When it is worth asking again. */
	retryAfterMs: number
}

/**
 * Pure, and therefore testable without a League client. `readGateState` does the I/O.
 *
 * G7 (a user-configurable capture time window) is defined in the research but there is no
 * `captureWindow` field in `Settings`, so it is not evaluated. It is deliberately omitted
 * rather than faked — see the unit report.
 */
export const evaluateGate = (s: GateState): GateVerdict => {
	const failed: string[] = []
	const reasons: string[] = []

	if (!s.settings.captureEnabled) {
		failed.push("G6")
		reasons.push("replay capture is switched off in Settings")
	}
	if (!s.reachable) {
		failed.push("G1")
		reasons.push("the League client is not running")
	} else {
		if (!isIdlePhase(s.phase)) {
			failed.push("G1")
			reasons.push(`client is in ${s.phase ?? "an unknown phase"}, not None/Lobby`)
		}
		if (s.isPlayingGame) {
			failed.push("G2")
			reasons.push("a game is in progress")
		}
		if (s.isPlayingReplay) {
			failed.push("G3")
			reasons.push("a replay is already playing")
		}
		if (s.liveApiAnswering) {
			failed.push("G4")
			reasons.push("the in-game API on port 2999 is answering")
		}
		/*
		 * G5 exists to prove a capture is not hijacking an unattended client — that the user
		 * really has stopped playing rather than being between two actions. A DELIBERATE CLICK
		 * is that proof, so a user-requested capture skips the wait entirely.
		 *
		 * Every other gate still applies: in a game, a replay already open, the in-game API
		 * answering, no .rofl on disk. Those are about whether capture CAN run safely; G5 is
		 * only about whether the user meant it, and here they said so.
		 */
		if (!s.userRequested && isIdlePhase(s.phase) && s.idleForMs < s.settings.idleGraceMs) {
			failed.push("G5")
			reasons.push(
				`only idle for ${Math.round(s.idleForMs / 1000)}s of the required ${Math.round(
					s.settings.idleGraceMs / 1000
				)}s`
			)
		}
	}
	if (s.otherIntrusiveRunning) {
		failed.push("G8")
		reasons.push("another capture already holds the client")
	}
	if (!s.roflOnDisk) {
		failed.push("G9")
		reasons.push("the .rofl file is not on disk")
	}

	if (failed.length === 0)
		return { ok: true, reason: "client is idle", failed: [], retryAfterMs: 0 }

	// How long to wait before asking again, by how permanent the blocker is.
	const retryAfterMs =
		failed.includes("G6") ? 30 * 60 * 1000
		: failed.includes("G9") ? 10 * 60 * 1000
		: failed.includes("G5") ?
			Math.max(5_000, s.settings.idleGraceMs - s.idleForMs)
		:	60_000

	return { ok: false, reason: reasons.join("; "), failed, retryAfterMs }
}

/* ================================================================== I/O */

/**
 * Read G1-G4 in ONE batched round trip (~35 ms on curl, ~5 ms on the bridge), then fold in
 * the local facts. Never throws — an unreachable client produces a "no" verdict, not a crash.
 */
export const readGateState = async (
	settings: Settings,
	roflPath: string | null,
	exceptJobId?: number,
	userRequested = false
): Promise<GateState> => {
	let snapshot = {
		phase: null as string | null,
		config: null as { isPlayingGame?: boolean; isPlayingReplay?: boolean } | null,
		liveApiAnswering: false,
		reachable: false
	}
	try {
		snapshot = await fetchIdleSnapshot()
	} catch (err) {
		log.warn("gate read failed; treating client as busy", { err: errText(err) })
	}

	/*
	 * ONLY a successful read may reset the idle streak.
	 *
	 * `fetchIdleSnapshot` returns `reachable: false` with a null phase when it throws or when
	 * the client did not answer — and `isIdlePhase(null)` is false, so feeding that to
	 * `notePhase` wiped the streak. With the gate and the supervisor both polling every few
	 * seconds, a single transient hiccup reset 120 seconds of accumulated idle to zero, and the
	 * capture gate could sit at "only idle for 31s of the required 120s" indefinitely. Observed
	 * repeatedly after games.
	 *
	 * Failing to ASK is not the same as being told the client is busy. An unreadable client
	 * still fails G1 on `reachable` below, so nothing becomes less safe by leaving the clock
	 * alone here.
	 */
	if (snapshot.reachable) notePhase(snapshot.phase)

	return {
		phase: snapshot.phase,
		isPlayingGame: snapshot.config?.isPlayingGame ?? !snapshot.reachable,
		isPlayingReplay: snapshot.config?.isPlayingReplay ?? false,
		liveApiAnswering: snapshot.liveApiAnswering,
		idleForMs: idleForMs(),
		settings: {
			captureEnabled: settings.captureEnabled,
			idleGraceMs: settings.idleGraceMs
		},
		otherIntrusiveRunning: intrusiveJobRunning(exceptJobId),
		userRequested,
		roflOnDisk: roflExistsOnDisk(roflPath),
		reachable: snapshot.reachable
	}
}

/**
 * The one call the intrusive worker makes before claiming anything.
 *
 * `roflPath` is the absolute path of the `.rofl` for the game about to be captured. Pass
 * `null` for a generic "could we capture anything right now" check — G9 will fail, which is
 * the honest answer when we do not yet know which game we are asking about.
 */
/**
 * `exceptJobId` excludes the caller's own lease from G8. A job re-checking the gate while it
 * runs must not count itself as the capture that is already holding the client.
 */
export const canRunIntrusive = async (
	settings: Settings,
	roflPath: string | null,
	exceptJobId?: number,
	userRequested = false
): Promise<GateVerdict> =>
	evaluateGate(await readGateState(settings, roflPath, exceptJobId, userRequested))

/* =============================================================== aborts */

export type AbortRule = "A1" | "A2" | "A3" | "A4" | "A5"

export interface AbortEvent {
	rule: AbortRule
	reason: string
}

export interface WatchForAbortOptions {
	/** How often to re-check. The research budgets 1 Hz while a capture runs (~35 ms/tick). */
	intervalMs?: number
	/** A5: wall-clock ceiling on one capture. */
	budgetMs?: number
	/** A4: shutdown, or the user hitting "Stop". */
	signal?: AbortSignal
	/** A3: the lockfile the capture started with; a change means the client restarted. */
	creds?: Lockfile | null
}

/**
 * Watch for any reason to stop an in-flight intrusive job, and call `onAbort` exactly once.
 *
 *   A1  phase leaves None/Lobby      — the user queued up
 *   A2  isPlayingGame becomes true   — a game started
 *   A3  lockfile port/password moved — the client restarted under us
 *   A4  shutdown or the UI's Stop    — via `signal`
 *   A5  wall-clock budget exceeded
 *
 * Returns a `stop()` to tear the watcher down. The caller is responsible for leaving the
 * client somewhere sane; this only tells it when to.
 */
export const watchForAbort = (
	onAbort: (event: AbortEvent) => void,
	opts: WatchForAbortOptions = {}
): (() => void) => {
	const intervalMs = opts.intervalMs ?? 1000
	const budgetMs = opts.budgetMs ?? 10 * 60 * 1000
	const startedMs = Date.now()
	const startCreds = opts.creds ?? readAnyLockfileSync()
	let stopped = false

	const fire = (rule: AbortRule, reason: string): void => {
		if (stopped) return
		stopped = true
		log.warn("aborting intrusive job", { rule, reason })
		try {
			onAbort({ rule, reason })
		} catch (err) {
			log.error("abort handler threw", { err: errText(err) })
		}
	}

	const onSignal = (): void => fire("A4", "stopped by the user or a daemon shutdown")
	if (opts.signal?.aborted) queueMicrotask(onSignal)
	else opts.signal?.addEventListener("abort", onSignal, { once: true })

	void (async () => {
		// Give the client a moment to actually enter the replay before policing it.
		await sleep(intervalMs)
		while (!stopped) {
			if (Date.now() - startedMs > budgetMs) {
				fire("A5", `capture exceeded its ${Math.round(budgetMs / 60000)} minute budget`)
				break
			}
			if (!sameLockfile(startCreds, readAnyLockfileSync())) {
				fire("A3", "the League client restarted (lockfile rotated)")
				break
			}
			try {
				const snap = await fetchIdleSnapshot()
				// While a replay plays, phase stays None/Lobby and isPlayingReplay is true.
				if (snap.reachable && !isIdlePhase(snap.phase)) {
					fire("A1", `client moved to ${snap.phase ?? "an unknown phase"}`)
					break
				}
				if (snap.config?.isPlayingGame === true) {
					fire("A2", "a game started")
					break
				}
			} catch (err) {
				log.debug("abort check failed", { err: errText(err) })
			}
			await sleep(intervalMs)
		}
	})()

	return () => {
		stopped = true
		opts.signal?.removeEventListener("abort", onSignal)
	}
}
