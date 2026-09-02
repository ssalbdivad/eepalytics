/**
 * The worker pool.
 *
 * TWO LANES, and the split is the whole point:
 *
 *   * 2 NORMAL workers. Every non-intrusive kind — HTTP reads, the replay-download POST,
 *     analysis, Claude reviews, SVG rendering. These run at any time, including while the user
 *     is mid-game, because none of them touch the screen. Two, not one, because a Claude review
 *     is I/O-bound for tens of seconds and must not block an urgent replay download behind it.
 *
 *   * 1 INTRUSIVE worker. `replay-capture` takes over the League client, so it is strictly
 *     serial AND gated: the worker asks `gate.ts` BEFORE claiming anything, and passes
 *     `allowIntrusive` to the claim so the SQL itself cannot hand it work it is not allowed to
 *     do. While a capture runs, `watchForAbort` is armed and the job's `AbortSignal` fires the
 *     moment the user queues up.
 *
 * A claimed job holds a LEASE, not a lock. `kill -9` on the daemon costs one attempt, not the
 * job: `queue.sweep()` returns expired leases to `queued` on the next boot.
 *
 * NODE ONLY.
 */

import { JOB_KINDS, JOB_LEASE_MS } from "../shared/constants.ts"
import type { Job, JobKind } from "../shared/schema/domain.ts"
import { getGame, getSettings, listJobs } from "../db/queries.ts"
import { publish, sleep, sleepUntilWake, wake } from "./bus.ts"
import { canRunIntrusive } from "./gate.ts"
import { handlerFor } from "./jobs/index.ts"
import { roflPathFor } from "./jobs/replay-download.ts"
import { abandon, claim, defer, expire, finish, sweep } from "./queue.ts"
import type { JobContext, JobOutcome } from "./context.ts"
import { errText, makeLogger } from "./log.ts"

const log = makeLogger("workers")

const INTRUSIVE_KINDS: readonly JobKind[] = ["replay-capture"]
const NORMAL_KINDS: readonly JobKind[] = JOB_KINDS.filter(
	k => !INTRUSIVE_KINDS.includes(k)
)

/** How long a normal worker naps when the queue is empty. A `wake()` cuts it short. */
const IDLE_POLL_MS = 1_000
/** The intrusive worker asks the gate at most this often — each ask is one LCU round trip. */
const GATE_POLL_MS = 5_000

export interface PoolStatus {
	running: number
	intrusiveRunning: boolean
	/** What the gate last said, so the UI can explain why a capture has not started. */
	lastGateReason: string | null
	inFlight: { id: number; kind: JobKind; gameId: number | null; sinceMs: number }[]
}

export interface WorkerPool {
	status: () => PoolStatus
	/** Stop claiming, let in-flight jobs finish (or abort), release their leases. */
	stop: (graceMs?: number) => Promise<void>
}

interface InFlight {
	job: Job
	startedMs: number
	abort: AbortController
}

export const startWorkers = (opts: { normal?: number } = {}): WorkerPool => {
	const normalCount = Math.max(1, opts.normal ?? 2)
	const inFlight = new Map<number, InFlight>()
	const shutdown = new AbortController()
	let lastGateReason: string | null = null
	let stopping = false
	const loops: Promise<void>[] = []

	/* ------------------------------------------------------------ running */

	const makeContext = (job: Job, abort: AbortController, scope: string): JobContext => ({
		job,
		settings: getSettings(),
		log: log.child(scope),
		signal: abort.signal,
		progress: (note, extra) => {
			log.info(note, { job: job.id, kind: job.kind, ...extra })
			publish(
				"job",
				{ id: job.id, kind: job.kind, state: "leased", note, ...extra },
				job.gameId
			)
		}
	})

	const settle = (job: Job, outcome: JobOutcome | void): void => {
		// The capture unit writes its own job row; re-writing it here would clobber a
		// deliberate `deferred` with a blanket `done`.
		if (outcome && outcome.selfManaged) {
			log.info("job settled by its handler", {
				job: job.id,
				kind: job.kind,
				note: outcome.note
			})
			wake()
			return
		}
		if (outcome && outcome.expire) expire(job, outcome.expire.reason)
		else if (outcome && outcome.defer)
			defer(job, outcome.defer.reason, outcome.defer.untilMs)
		else finish(job, outcome?.note)
	}

	const runOne = async (job: Job, scope: string): Promise<void> => {
		const handler = handlerFor(job.kind)
		if (!handler) {
			abandon(job, `no handler registered for kind "${job.kind}"`)
			return
		}
		const abort = new AbortController()
		// Shutdown cancels every in-flight job; handlers that honour `signal` unwind cleanly.
		const onShutdown = () => abort.abort()
		shutdown.signal.addEventListener("abort", onShutdown, { once: true })
		inFlight.set(job.id, { job, startedMs: Date.now(), abort })
		log.info("job start", {
			job: job.id,
			kind: job.kind,
			gameId: job.gameId,
			attempt: job.attempts,
			of: job.maxAttempts
		})
		try {
			const outcome = await handler(makeContext(job, abort, scope))
			settle(job, outcome)
		} catch (err) {
			// An aborted job is a deferral, not a failure: nothing was wrong with the work.
			if (abort.signal.aborted)
				defer(job, "daemon shut down mid-job", Date.now() + 5_000)
			else abandon(job, errText(err))
		} finally {
			shutdown.signal.removeEventListener("abort", onShutdown)
			inFlight.delete(job.id)
		}
	}

	/* ------------------------------------------------------ normal lane */

	const normalLoop = async (index: number): Promise<void> => {
		const scope = `w${index}`
		while (!stopping) {
			let job: Job | null = null
			try {
				job = claim({
					allowIntrusive: false,
					kinds: NORMAL_KINDS,
					leaseMs: JOB_LEASE_MS
				})
			} catch (err) {
				log.error("claim failed", { err: errText(err) })
			}
			if (!job) {
				await sleepUntilWake(IDLE_POLL_MS, shutdown.signal)
				continue
			}
			await runOne(job, scope)
		}
	}

	/* --------------------------------------------------- intrusive lane */

	/**
	 * Peek at the next capture job WITHOUT claiming it, so we can ask the gate about that
	 * specific game's `.rofl` (rule G9) before taking the job out of the queue. Claiming first
	 * and deferring would churn the queue every five seconds for as long as capture is off.
	 */
	const peekCapture = (): Job | null => {
		const now = Date.now()
		const [next] = listJobs({
			states: ["queued", "deferred"],
			kinds: INTRUSIVE_KINDS,
			limit: 5
		}).filter(j => j.notBeforeMs <= now)
		return next ?? null
	}

	const intrusiveLoop = async (): Promise<void> => {
		while (!stopping) {
			const next = peekCapture()
			if (!next) {
				await sleepUntilWake(GATE_POLL_MS, shutdown.signal)
				continue
			}

			const settings = getSettings()
			// Cheapest possible "no": capture is off, so do not even touch the client.
			const game = next.gameId === null ? null : getGame(next.gameId)
			const roflPath =
				game?.replayPath ?? (game ? roflPathFor(game.gameId, game.platformId) : null)

			const verdict = await canRunIntrusive(settings, roflPath)
			lastGateReason = verdict.ok ? null : verdict.reason
			if (!verdict.ok) {
				const claimed = claim({
					allowIntrusive: true,
					kinds: INTRUSIVE_KINDS,
					leaseMs: 60_000
				})
				// Record the reason ON the job so "why has this not run" is answerable in the UI.
				if (claimed)
					defer(
						claimed,
						`gate ${verdict.failed.join("+")}: ${verdict.reason}`,
						Date.now() + verdict.retryAfterMs
					)
				await sleep(GATE_POLL_MS, shutdown.signal)
				continue
			}

			const job = claim({
				allowIntrusive: true,
				kinds: INTRUSIVE_KINDS,
				leaseMs: JOB_LEASE_MS
			})
			if (!job) {
				await sleep(GATE_POLL_MS, shutdown.signal)
				continue
			}
			log.warn("starting INTRUSIVE job — the League client is about to be taken over", {
				job: job.id,
				gameId: job.gameId
			})
			await runOne(job, "intrusive")
		}
	}

	/* ------------------------------------------------------------- boot */

	// Anything a previous run was holding when it died comes back now.
	sweep()

	for (let i = 0; i < normalCount; i++) loops.push(normalLoop(i + 1))
	loops.push(intrusiveLoop())
	log.info("worker pool started", { normal: normalCount, intrusive: 1 })

	return {
		status: () => ({
			running: inFlight.size,
			intrusiveRunning: [...inFlight.values()].some(f => f.job.intrusive),
			lastGateReason,
			inFlight: [...inFlight.values()].map(f => ({
				id: f.job.id,
				kind: f.job.kind,
				gameId: f.job.gameId,
				sinceMs: f.startedMs
			}))
		}),
		stop: async (graceMs = 5_000) => {
			if (stopping) return
			stopping = true
			log.info("worker pool stopping", { inFlight: inFlight.size })
			shutdown.abort()
			const deadline = Date.now() + graceMs
			while (inFlight.size > 0 && Date.now() < deadline) await sleep(100)
			// Anything still holding a lease is handed straight back so a restart picks it up
			// immediately instead of waiting out the 10-minute lease.
			for (const { job } of inFlight.values())
				defer(job, "daemon shut down mid-job", Date.now())
			await Promise.race([Promise.allSettled(loops), sleep(1_000)])
			log.info("worker pool stopped")
		}
	}
}
