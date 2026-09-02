/**
 * The durable job queue.
 *
 * All state lives in SQLite (`src/db/queries.ts` owns the SQL), so a client restart, a bridge
 * crash or a `kill -9` on the daemon loses nothing: on boot we reclaim every lease that has
 * expired and carry on. This module is the daemon-facing *policy* layer on top of that —
 * deadlines, dedup, state transitions and the SSE events that go with them.
 *
 * Two facts drive every scheduling decision here:
 *   * A `.rofl` is dropped by the client 30 minutes after the game ends, so `replay-download`
 *     carries a HARD deadline and, once missed, is `expired` forever rather than retried.
 *   * Only `replay-capture` is intrusive. Everything else — including the download POST —
 *     runs happily while the user is in champ select for their next game.
 *
 * NODE ONLY.
 */

import {
	JOB_PRIORITY,
	REPLAY_DOWNLOAD_MIN_SLACK_MS,
	REPLAY_EXPIRY_MS
} from "../shared/constants.ts"
import type { Job, JobKind, JobRequest, JobState } from "../shared/schema/domain.ts"
import {
	cancelJob,
	claimNextJob,
	completeJob,
	deferJob,
	enqueue,
	expireJob,
	expireOverdueJobs,
	failJob,
	getJob,
	listJobs,
	pruneJobs,
	queueDepth,
	reclaimExpiredLeases,
	retryJob
} from "../db/queries.ts"
import type { ClaimOptions } from "../db/queries.ts"
import { publish, wake } from "./bus.ts"
import { makeLogger } from "./log.ts"

const log = makeLogger("queue")

/* ============================================================= deadlines */

/**
 * The wall-clock instant after which the client will have thrown the replay away.
 * `minutesUntilReplayConsideredLost: 30`, read from `/lol-replays/v1/configuration`.
 */
export const replayDeadlineMs = (endedAtMs: number): number =>
	endedAtMs + REPLAY_EXPIRY_MS

/**
 * Is there enough of the window left to be worth starting a download? Below one minute of
 * slack the download cannot realistically finish, and queueing it just produces an `expired`
 * job that looks like a bug. Say "too late" honestly instead.
 */
export const replayWindowOpen = (endedAtMs: number, now = Date.now()): boolean =>
	replayDeadlineMs(endedAtMs) - now > REPLAY_DOWNLOAD_MIN_SLACK_MS

/* =============================================================== enqueue */

/**
 * Enqueue, dedup, announce.
 *
 * `enqueue()` is idempotent per (kind, gameId) while a job is `queued`/`deferred`/`leased`, so
 * double-clicking "review this game" cannot spawn two Claude runs and reconcile can be run as
 * often as we like.
 */
const announced = new Set<number>()

export const enqueueJob = (req: JobRequest): number => {
	const id = enqueue(req)
	// `enqueue` hands back the EXISTING live job when there is one, so announce each id once
	// per process. Reconcile runs every few minutes and must not spam the event feed.
	if (!announced.has(id)) {
		announced.add(id)
		const job = getJob(id)
		if (job) {
			log.info("job queued", { job: id, kind: job.kind, gameId: job.gameId })
			publish("job", { id, kind: job.kind, state: job.state }, job.gameId)
		}
	}
	wake()
	return id
}

export const enqueueMatchIngest = (gameId: number): number =>
	enqueueJob({ kind: "match-ingest", gameId })

/**
 * URGENT. Carries the 30-minute hard deadline; if the window has already closed we do not
 * queue anything at all rather than manufacturing a job that can only expire.
 */
export const enqueueReplayDownload = (
	gameId: number,
	endedAtMs: number
): number | null => {
	if (!replayWindowOpen(endedAtMs)) {
		log.info("replay window already closed; not queueing download", { gameId })
		return null
	}
	return enqueueJob({
		kind: "replay-download",
		gameId,
		deadlineMs: replayDeadlineMs(endedAtMs)
	})
}

export const enqueueAnalysis = (gameId: number): number =>
	enqueueJob({ kind: "analysis-run", gameId })

export const enqueueGameReview = (gameId: number): number =>
	enqueueJob({ kind: "review-game", gameId })

export const enqueueTrendReview = (): number =>
	enqueueJob({ kind: "review-trend", gameId: null })

export const enqueueMediaGenerate = (gameId: number): number =>
	enqueueJob({ kind: "media-generate", gameId })

/** Intrusive. Queued freely; `gate.ts` decides whether it may ever actually start. */
export const enqueueReplayCapture = (gameId: number): number =>
	enqueueJob({ kind: "replay-capture", gameId, priority: JOB_PRIORITY["replay-capture"] })

/* ============================================================== claiming */

export const claim = (opts: ClaimOptions = {}): Job | null => {
	const job = claimNextJob(opts)
	if (job) publish("job", { id: job.id, kind: job.kind, state: "leased" }, job.gameId)
	return job
}

/* ==================================================== state transitions */

const announce = (job: Job, state: JobState, note?: string): void => {
	publish(
		"job",
		{ id: job.id, kind: job.kind, state, ...(note ? { note } : {}) },
		job.gameId
	)
}

export const finish = (job: Job, note?: string): void => {
	completeJob(job.id, note)
	log.info("job done", { job: job.id, kind: job.kind, gameId: job.gameId, note })
	announce(job, "done", note)
	// Completing one job usually unblocks the next one in the chain.
	wake()
}

/** Retry with backoff, or go terminal-`failed` once `maxAttempts` is spent. */
export const abandon = (job: Job, error: string): void => {
	const after = failJob(job.id, error)
	const state = after?.state ?? "failed"
	if (state === "failed")
		log.error("job failed permanently", {
			job: job.id,
			kind: job.kind,
			gameId: job.gameId,
			err: error
		})
	else
		log.warn("job failed, will retry", {
			job: job.id,
			kind: job.kind,
			attempts: after?.attempts,
			of: after?.maxAttempts,
			err: error
		})
	announce(job, state, error)
}

/**
 * Put a job back to sleep because the world is not ready — the client is closed, a sibling
 * unit is not installed, the gate said no. Does NOT consume an attempt: "not now" is not a
 * failure, and a job that has been waiting three days for the capture gate should not be
 * indistinguishable from one that crashed.
 */
export const defer = (job: Job, reason: string, untilMs?: number): void => {
	deferJob(job.id, reason, untilMs)
	log.debug("job deferred", { job: job.id, kind: job.kind, reason })
	announce(job, "deferred", reason)
}

/** Terminal and never retried. Only the replay window reaches this. */
export const expire = (job: Job, reason: string): void => {
	expireJob(job.id, reason)
	log.warn("job expired", { job: job.id, kind: job.kind, gameId: job.gameId, reason })
	announce(job, "expired", reason)
}

export const cancel = (id: number): boolean => {
	const job = getJob(id)
	const ok = cancelJob(id)
	if (ok && job) announce(job, "failed", "cancelled by user")
	return ok
}

export const retry = (id: number): boolean => {
	const ok = retryJob(id)
	if (ok) {
		const job = getJob(id)
		if (job) announce(job, "queued")
		wake()
	}
	return ok
}

/* ============================================================== sweeping */

export interface SweepResult {
	expired: number
	reclaimed: number
}

/**
 * Housekeeping, run on boot and on every daemon tick:
 *   * jobs past their hard deadline become `expired` (the replay is gone; stop trying), and
 *   * jobs whose lease ran out go back to `queued` (a crashed worker costs one attempt, not
 *     the job).
 */
export const sweep = (nowMs = Date.now()): SweepResult => {
	const expired = expireOverdueJobs(nowMs)
	const reclaimed = reclaimExpiredLeases(nowMs)
	if (expired > 0) log.warn("expired overdue jobs", { count: expired })
	if (reclaimed > 0) log.info("reclaimed abandoned leases", { count: reclaimed })
	if (reclaimed > 0) wake()
	return { expired, reclaimed }
}

/** Drop terminal jobs older than `days` so the queue screen stays readable. */
export const prune = (days = 14): number =>
	pruneJobs(Date.now() - days * 24 * 60 * 60 * 1000)

/* =============================================================== reading */

export const depth = (): number => queueDepth()

export const pending = (kinds?: readonly JobKind[]): Job[] =>
	listJobs({ states: ["queued", "deferred", "leased"], kinds, limit: 200 })

export const recent = (limit = 100): Job[] => listJobs({ limit })
