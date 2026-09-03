/**
 * The durable job queue.
 *
 * All state lives in SQLite (`src/db/queries.ts` owns the SQL), so a client restart, a bridge
 * crash or a `kill -9` on the daemon loses nothing: on boot `adoptOrphanedLeases()` hands back
 * everything the dead process was holding, and `sweep()` keeps doing so on a timer thereafter. This module is the daemon-facing *policy* layer on top of that —
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
	kvGet,
	kvSet,
	queueDepth,
	reclaimAllLeases,
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
 * How far out to push the next wake-up of a job that keeps saying "not yet".
 *
 * Handlers pick their own retry cadence for the case they expect ("the client is still
 * assembling this match" — 30 s, because it usually resolves in one or two minutes). Some
 * conditions never resolve. Measured live on this machine: `match-ingest` for a PRACTICETOOL
 * game the LCU only ever returns one participant for deferred 103 times in 52 minutes, one
 * LCU round-trip and two log lines each, held `queueDepth` at 1 forever, and would have kept
 * going for the life of the daemon. This app is meant to sit in the background while the user
 * plays, so a stuck job has to get quieter rather than louder.
 *
 * The handler's own cadence is honoured for the first five minutes — long enough for every
 * condition that does resolve on its own. After that the floor grows. Jobs carrying a
 * deadline (only `replay-download`, which loses the .rofl 30 minutes after the game ends) are
 * exempt: there the tight cadence is the whole point, and `expire` ends the loop anyway.
 */
const stuckFloorMs = (job: Job, now: number): number => {
	if (job.deadlineMs !== null) return 0
	const stuckFor = now - job.createdMs
	if (stuckFor < 5 * 60_000) return 0
	if (stuckFor < 30 * 60_000) return 2 * 60_000
	return 10 * 60_000
}

/**
 * Put a job back to sleep because the world is not ready — the client is closed, a sibling
 * unit is not installed, the gate said no. Does NOT consume an attempt: "not now" is not a
 * failure, and a job that has been waiting three days for the capture gate should not be
 * indistinguishable from one that crashed.
 */
/**
 * How long a job may keep saying "not yet" before we accept it never will.
 *
 * `stuckFloorMs` makes a stuck job quiet, but nothing made it STOP: the PRACTICETOOL match the
 * LCU only ever returns one participant for would defer every ten minutes for the life of the
 * daemon, forever, because the condition it is waiting on cannot occur. A day is far longer than
 * any real condition here takes — the client being closed, a match still assembling, the capture
 * gate waiting for the user to stop playing — and the job stays visible as `expired` with its
 * reason rather than vanishing.
 */
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000

export const defer = (job: Job, reason: string, untilMs?: number): void => {
	const now = Date.now()

	// Jobs with a deadline are exempt: `replay-download` loses the .rofl 30 minutes after the
	// game ends and `expire` already ends that loop on its own terms.
	if (job.deadlineMs === null && now - job.createdMs > GIVE_UP_AFTER_MS) {
		expire(
			job,
			`gave up after ${Math.round((now - job.createdMs) / 3_600_000)}h of deferrals — last reason: ${reason}`
		)
		return
	}

	const asked = untilMs ?? now + 60_000
	const until = Math.max(asked, now + stuckFloorMs(job, now))
	deferJob(job.id, reason, until)
	log.debug("job deferred", {
		job: job.id,
		kind: job.kind,
		reason,
		forMs: until - now
	})
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

/**
 * Boot-time lease recovery.
 *
 * `sweep()` only reclaims leases that have EXPIRED, which is correct while the daemon runs but
 * wrong the moment it starts: a daemon that has just booted holds nothing, so every `leased`
 * row is residue from a process that died. Left to `sweep()`, that work sat untouched for the
 * remainder of its lease — up to `JOB_LEASE_MS` (10 minutes) — while the Queue screen showed it
 * as running. A `kill -9` mid-review therefore stalled the whole pipeline for ten minutes.
 *
 * The one thing a blanket reclaim must not do is steal leases from a SECOND daemon sharing this
 * database, so the owning pid is recorded in `kv` and the sweep is skipped when that pid is
 * still alive. When it is (or when the pid has been recycled by an unrelated process) we simply
 * fall back to the old lease-timeout behaviour, which is safe — never wrong, only slower.
 */
const KV_OWNER_PID = "daemonOwnerPid"

const processAlive = (pid: number): boolean => {
	if (!Number.isInteger(pid) || pid <= 0) return false
	try {
		// Signal 0 checks for existence without delivering anything.
		process.kill(pid, 0)
		return true
	} catch (err) {
		// EPERM means it exists but belongs to someone else — still alive.
		return (err as NodeJS.ErrnoException).code === "EPERM"
	}
}

export const adoptOrphanedLeases = (): number => {
	const prior = kvGet<number | null>(KV_OWNER_PID, null)

	if (prior !== null && prior !== process.pid && processAlive(prior)) {
		// Ownership deliberately stays with the daemon that is actually running: if we claimed
		// it here and then died, a third daemon would see OUR dead pid and blanket-reclaim the
		// live one's leases.
		log.info("another daemon holds this database; leaving its leases to time out", {
			pid: prior
		})
		return 0
	}
	kvSet(KV_OWNER_PID, process.pid)

	const reclaimed = reclaimAllLeases()
	if (reclaimed > 0) {
		log.warn("reclaimed jobs a previous daemon was holding when it died", {
			count: reclaimed,
			previousPid: prior
		})
		wake()
	}
	return reclaimed
}

/** Drop terminal jobs older than `days` so the queue screen stays readable. */
export const prune = (days = 14): number =>
	pruneJobs(Date.now() - days * 24 * 60 * 60 * 1000)

/* =============================================================== reading */

export const depth = (): number => queueDepth()

export const pending = (kinds?: readonly JobKind[]): Job[] =>
	listJobs({ states: ["queued", "deferred", "leased"], kinds, limit: 200 })

export const recent = (limit = 100): Job[] => listJobs({ limit })
