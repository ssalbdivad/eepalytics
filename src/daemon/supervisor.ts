/**
 * The League client connection state machine.
 *
 *      lockfile appears        ┌──────────────┐  lockfile gone / transport dead
 *   ────────────────────────>  │  CONNECTING  │ <───────────────────────────────┐
 *                              └──────┬───────┘                                 │
 *                                     │ a phase read succeeds                   │
 *                                     v                                         │
 *                              ┌──────────────┐  port/password rotate           │
 *                              │  CONNECTED   │ ────────────────────> rebuild ──┘
 *                              └──────┬───────┘
 *                                     │ 3 consecutive read failures
 *                                     v
 *                              ┌──────────────┐
 *                              │ DISCONNECTED │   client closed — this is NORMAL
 *                              └──────────────┘
 *
 * Three things make this survive real life:
 *   * `fs.watch` (inotify) SILENTLY NEVER FIRES on the `/mnt/c` 9p mount — it registers
 *     without error and then does nothing. `fs.watchFile` stat-polling is the only thing that
 *     works, and it is what `watchLockfile` uses.
 *   * The password rotates on every client restart, so a changed port *or* password tears the
 *     transport down and rebuilds it. Credentials are never cached across a rotation.
 *   * All job state is in SQLite, so the WebSocket/poll is a LATENCY optimisation, not a
 *     correctness dependency. Every reconnect runs a reconciliation sweep, which is what
 *     actually guarantees no game is missed.
 *
 * NODE ONLY.
 */

import { getSettings } from "../db/queries.ts"
import { publish } from "./bus.ts"
import { notePhase } from "./gate.ts"
import { isPidAlive, readLockfileSync, sameLockfile, watchLockfile } from "../lcu/index.ts"
import type { Lockfile } from "../lcu/index.ts"
import {
	fetchCurrentGameId,
	fetchGameflowPhase,
	lcu,
	resetTransport,
	transportName
} from "./lcu.ts"
import type { TransportName } from "./lcu.ts"
import { errText, makeLogger } from "./log.ts"
import { currentSampleKey, sampleDue, sampleLive } from "./live-sampler.ts"
import { observeLiveSample } from "../server/routes/live.ts"
import { openSessionStatus } from "./journal.ts"

const log = makeLogger("supervisor")

export type ConnectionState = "CONNECTING" | "CONNECTED" | "DISCONNECTED"

export interface SupervisorStatus {
	state: ConnectionState
	transport: TransportName
	phase: string | null
	/** The gameId the client last told us it was playing, if any. */
	currentGameId: number | null
	lastPhaseChangeMs: number | null
	lastErrorText: string | null
	consecutiveFailures: number
	staleLockfile: boolean
}

export interface SupervisorEvents {
	/** Any gameflow phase transition, including to/from `null` (client closed). */
	onPhase?: (phase: string | null, previous: string | null) => void
	/**
	 * The client left `InProgress`. THE schedule-critical moment: the replay for `gameId`
	 * (when we know it) is deleted 30 minutes from now.
	 */
	onGameEnded?: (gameId: number | null) => void
	onConnected?: () => void
	onDisconnected?: () => void
}

const BACKOFF_START_MS = 1_000
const BACKOFF_MAX_MS = 30_000
/** Consecutive failed reads before we conclude the client is gone rather than busy. */
const FAILURE_THRESHOLD = 3

export interface Supervisor {
	status: () => SupervisorStatus
	/** Force an immediate phase read; returns the phase or null. */
	poll: () => Promise<string | null>
	stop: () => Promise<void>
}

export const startSupervisor = (events: SupervisorEvents = {}): Supervisor => {
	let state: ConnectionState = "DISCONNECTED"
	let phase: string | null = null
	let currentGameId: number | null = null
	let lastPhaseChangeMs: number | null = null
	let lastErrorText: string | null = null
	let failures = 0
	let staleLockfile = false
	let backoffMs = BACKOFF_START_MS
	let timer: NodeJS.Timeout | null = null
	let stopped = false
	let polling = false

	const setState = (next: ConnectionState, note?: string): void => {
		if (state === next) return
		const previous = state
		state = next
		log.info(`lcu ${previous} -> ${next}`, { note, transport: transportName() })
		publish("daemon", {
			lcu: next === "CONNECTED" ? "connected" : "disconnected",
			state: next,
			transport: transportName(),
			...(note ? { note } : {})
		})
		if (next === "CONNECTED") events.onConnected?.()
		if (next === "DISCONNECTED") events.onDisconnected?.()
	}

	const setPhase = (next: string | null): void => {
		if (next === phase) return
		const previous = phase
		phase = next
		lastPhaseChangeMs = Date.now()
		notePhase(next)
		log.info("gameflow phase", { from: previous ?? "—", to: next ?? "—" })
		publish("daemon", { gameflowPhase: next, previousPhase: previous })
		events.onPhase?.(next, previous)

		// Leaving InProgress is the moment the 30-minute replay clock starts.
		if (previous === "InProgress" && next !== "InProgress") {
			const ended = currentGameId
			log.info("game ended", { gameId: ended })
			events.onGameEnded?.(ended)
		}
		if (next === "None" || next === "Lobby") currentGameId = null
	}

	/**
	 * Read the current gameId out of the gameflow session. Only worth doing on the transition
	 * INTO a game — it is an 11 KB response and we need one field from it.
	 */
	const readCurrentGameId = async (): Promise<void> => {
		const id = await fetchCurrentGameId()
		if (typeof id === "number" && id > 0) {
			currentGameId = id
			log.info("current game", { gameId: id })
		}
	}

	/**
	 * Deliberately `null`, NOT `readLockfileSync()`.
	 *
	 * `watchLockfile` fires once immediately, and `onLockfileChanged` short-circuits on
	 * `sameLockfile(bound, next)`. Seeding `bound` with the lockfile that is already on disk
	 * therefore made that first callback a no-op, and the whole boot path below it — the
	 * `isPidAlive` staleness probe in particular — never ran for the case it exists to catch:
	 * a lockfile left behind by a client that crashed BEFORE the daemon started. The daemon
	 * then did exactly what the comment there warns about, retrying a dead port on a widening
	 * backoff, and `staleLockfile` stayed false so the UI never got to say why.
	 */
	let bound: Lockfile | null = null

	const onLockfileChanged = (next: Lockfile | null): void => {
		if (sameLockfile(bound, next)) return
		bound = next
		void (async () => {
			// Port AND password rotate on every client restart — never reuse a stale transport.
			await resetTransport()
			failures = 0
			backoffMs = BACKOFF_START_MS
			staleLockfile = false

			if (!next) {
				setPhase(null)
				setState("DISCONNECTED", "lockfile removed")
				return
			}
			log.info("lockfile changed", { port: next.port, pid: next.pid })
			setState("CONNECTING", "lockfile appeared or rotated")
			// tasklist.exe costs ~300 ms — only ever on a transition, never in the poll loop.
			// The client does not always clean the file up after a crash, and a stale lockfile
			// would otherwise have us retrying a dead port forever.
			if (!(await isPidAlive(next.pid))) {
				staleLockfile = true
				log.warn("lockfile names a dead pid; treating the client as closed", {
					pid: next.pid
				})
				setState("DISCONNECTED", "stale lockfile")
				return
			}
			await lcu()
			void tick()
		})()
	}

	/**
 * Take one live sample if the clock says one is due.
 *
 * Reads `allgamedata` only when a sample is wanted, so an idle in-game poll costs nothing extra.
 * Never throws — this sits inside the supervisor tick, which must not fail because a disk is full.
 */
const sampleCurrentGame = async (): Promise<void> => {
	try {
		if (!sampleDue()) return
		const handle = await lcu()
		if (!handle) return
		const data = await handle.live.allGameData().catch(() => null)
		const t = data?.gameData?.gameTime
		if (typeof t !== "number") return
		sampleLive({ gameId: openSessionStatus().sessionId ?? currentSampleKey(t), gameTimeSec: t, data })
		/*
		 * The coach's memory, fed from THIS poll and not only from the browser's turns.
		 *
		 * `coach-memory.ts` was designed around exactly this call — a back, a death and a completed
		 * item can all land between two turns, and a memory that only sees turns misses them. It
		 * was never wired, so the whole module ran at browser cadence, and a beat held back by the
		 * pace floor fed it nothing at all. `observe` ignores a repeated or out-of-order clock and
		 * `observeLiveSample` owns the per-game reset, so calling it here is idempotent and safe to
		 * do on every sample.
		 */
		observeLiveSample(data, t)
	} catch {
		// A failed sample is one missing row in an evaluation aid. It is never worth a log line
		// during a game, let alone an interrupted tick.
	}
}

const tick = async (): Promise<void> => {
		if (stopped || polling) return
		polling = true
		try {
			const creds = readLockfileSync()
			if (!creds) {
				setPhase(null)
				setState("DISCONNECTED", "no lockfile")
				return
			}
			if (transportName() === "none") await lcu()

			const next = await fetchGameflowPhase()
			if (next === null) {
				failures++
				lastErrorText = "gameflow phase read failed"
				if (failures >= FAILURE_THRESHOLD) {
					// Re-read the lockfile before giving up: the client may have restarted on a
					// new port while we were away.
					const fresh = readLockfileSync()
					if (!sameLockfile(fresh, creds)) {
						onLockfileChanged(fresh)
						return
					}
					setPhase(null)
					setState("DISCONNECTED", `${failures} consecutive failed reads`)
					await resetTransport()
					backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS)
				} else setState("CONNECTING", "read failed")
				return
			}

			failures = 0
			lastErrorText = null
			backoffMs = BACKOFF_START_MS
			setState("CONNECTED")
			const wasInGame = phase === "InProgress"
			setPhase(next)
			if (next === "InProgress" && !wasInGame) await readCurrentGameId()

			/*
			 * Sample the live client while a game is running, from the DAEMON's own poll.
			 *
			 * It was first hooked to `/api/live/ground-truth`, which only fires while the browser's
			 * coach is running — so a game played with the page closed recorded nothing, which is
			 * exactly the game an evaluation would most want. This loop runs whenever the daemon
			 * does, and `sampleLive` rate-limits itself on the game clock, so an extra read is only
			 * taken when a sample is actually due.
			 */
			if (next === "InProgress") await sampleCurrentGame()
		} catch (err) {
			failures++
			lastErrorText = errText(err)
			log.warn("supervisor tick failed", { err: lastErrorText })
		} finally {
			polling = false
		}
	}

	const schedule = (): void => {
		if (stopped) return
		const settings = getSettings()
		/*
		 * The in-game branch used to return `pollIdleMs` as well, so all three arms were the same
		 * value and `pollInGameMs` drove nothing — while Settings offered it as a control and
		 * described what it did. A setting that does nothing is worse than one that is absent,
		 * because the user changes it and concludes the app is broken elsewhere.
		 */
		const base =
			state === "DISCONNECTED" ? Math.max(backoffMs, settings.pollIdleMs)
			: phase === "InProgress" ? settings.pollInGameMs
			: settings.pollIdleMs
		timer = setTimeout(() => {
			void tick().finally(schedule)
		}, base)
		timer.unref?.()
	}

	const unwatch = watchLockfile(onLockfileChanged, { intervalMs: 2000 })
	void tick().finally(schedule)

	return {
		status: () => ({
			state,
			transport: transportName(),
			phase,
			currentGameId,
			lastPhaseChangeMs,
			lastErrorText,
			consecutiveFailures: failures,
			staleLockfile
		}),
		poll: async () => {
			await tick()
			return phase
		},
		stop: async () => {
			stopped = true
			unwatch()
			if (timer) clearTimeout(timer)
			await resetTransport()
		}
	}
}
