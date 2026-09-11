/**
 * The worker pool.
 *
 * 2 workers. Every job kind — HTTP reads, the replay-download POST, analysis, Claude reviews,
 * SVG rendering — runs at any time, including while the user is mid-game, because none of them
 * touch the screen. Two, not one, because a Claude review is I/O-bound for tens of seconds and
 * must not block an urgent replay download behind it.
 *
 * There was a second, strictly-serial INTRUSIVE lane, for `replay-capture` — the one job that
 * took over the League client. Nothing is intrusive any more: in the app's entire recorded
 * history that job produced zero media (4 expired, 2 failed, 0 done) and the frame journal
 * replaced it, so it and its lane are gone.
 *
 * A claimed job holds a LEASE, not a lock. `kill -9` on the daemon costs one attempt, not the
 * job: `queue.sweep()` returns expired leases to `queued` on the next boot.
 *
 * NODE ONLY.
 */

import { JOB_LEASE_MS } from "../shared/constants.ts"
import type { Job, JobKind } from "../shared/schema/domain.ts"
import { getSettings } from "../db/queries.ts"
import { publish, sleep, sleepUntilWake, wake } from "./bus.ts"
import { handlerFor } from "./jobs/index.ts"
import { abandon, claim, defer, expire, finish, sweep } from "./queue.ts"
import type { JobContext, JobOutcome } from "./context.ts"
import { errText, makeLogger } from "./log.ts"

const log = makeLogger("workers")

/** How long a worker naps when the queue is empty. A `wake()` cuts it short. */
const IDLE_POLL_MS = 1_000

export interface PoolStatus {
	running: number
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
		// A handler that wrote its own job row; re-writing it here would clobber a deliberate
		// `deferred` with a blanket `done`.
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

	/* ------------------------------------------------------------- lane */

	const normalLoop = async (index: number): Promise<void> => {
		const scope = `w${index}`
		while (!stopping) {
			let job: Job | null = null
			try {
				job = claim({ leaseMs: JOB_LEASE_MS })
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

	/* ------------------------------------------------------------- boot */

	// Anything a previous run was holding when it died comes back now.
	sweep()

	/*
	 * ...and every 30s thereafter, which the sweep docstring always claimed but nothing did.
	 *
	 * `sweep()` was called on boot only. A job whose hard deadline passed therefore stayed in
	 * `deferred` for the life of the daemon: `claim()` correctly refuses to run it, but nothing
	 * moved it to `expired`. On the Queue screen that read as a row filed under "Waiting" whose
	 * own status line ended in "expired" — a contradiction the user reasonably found baffling.
	 */
	const sweepTimer = setInterval(() => {
		if (stopping) return
		const result = sweep()
		if (result.expired > 0 || result.reclaimed > 0)
			log.info("swept", { expired: result.expired, reclaimed: result.reclaimed })
	}, 30_000)
	sweepTimer.unref?.()

	for (let i = 0; i < normalCount; i++) loops.push(normalLoop(i + 1))
	log.info("worker pool started", { normal: normalCount })

	return {
		status: () => ({
			running: inFlight.size,
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
			clearInterval(sweepTimer)
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
