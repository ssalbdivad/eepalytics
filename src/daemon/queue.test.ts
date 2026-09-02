/**
 * The durable job queue, against a real in-memory SQLite database.
 *
 * What is actually being defended here:
 *   * enqueueing the same (kind, gameId) twice must not spawn two Claude runs,
 *   * a crashed worker must cost ONE ATTEMPT, not the job,
 *   * a missed 30-minute replay window must go terminal instead of retrying forever, and
 *   * "the gate said no" must be distinguishable from "this job is broken".
 *
 * Run: pnpm test
 */

import { strict as assert } from "node:assert"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, it } from "node:test"
import { closeDb, migrate, useDb } from "../db/index.ts"
import { getJob, listJobs } from "../db/queries.ts"
import {
	abandon,
	claim,
	defer,
	depth,
	enqueueJob,
	enqueueReplayDownload,
	expire,
	finish,
	replayDeadlineMs,
	replayWindowOpen,
	sweep
} from "./queue.ts"
import { REPLAY_EXPIRY_MS } from "../shared/constants.ts"

let db: DatabaseSync

beforeEach(() => {
	db = new DatabaseSync(":memory:")
	db.exec("PRAGMA foreign_keys = ON")
	migrate(db)
	useDb(db)
})

afterEach(() => {
	closeDb()
})

describe("replay deadlines", () => {
	it("puts the deadline 30 minutes after the game ended", () => {
		const ended = 1_700_000_000_000
		assert.equal(replayDeadlineMs(ended), ended + REPLAY_EXPIRY_MS)
		assert.equal(REPLAY_EXPIRY_MS, 30 * 60 * 1000)
	})

	it("refuses to queue a download with less than a minute of slack left", () => {
		const now = Date.now()
		assert.equal(replayWindowOpen(now - 60_000, now), true)
		assert.equal(replayWindowOpen(now - 28 * 60_000, now), true)
		// Exactly one minute left is not MORE than the minimum slack, so it is too late.
		assert.equal(replayWindowOpen(now - 29 * 60_000, now), false)
		assert.equal(replayWindowOpen(now - 29.6 * 60_000, now), false)
		assert.equal(replayWindowOpen(now - 40 * 60_000, now), false)
	})

	it("does not create a job at all once the window has closed", () => {
		const id = enqueueReplayDownload(1, Date.now() - 45 * 60_000)
		assert.equal(id, null, "a job that can only expire should never be created")
		assert.equal(depth(), 0)
	})

	it("creates one carrying the hard deadline while the window is open", () => {
		const ended = Date.now() - 60_000
		const id = enqueueReplayDownload(2, ended)
		assert.ok(id !== null)
		assert.equal(getJob(id!)?.deadlineMs, replayDeadlineMs(ended))
	})
})

describe("dedup", () => {
	it("returns the SAME job for a repeated (kind, gameId) while one is live", () => {
		const a = enqueueJob({ kind: "review-game", gameId: 42 })
		const b = enqueueJob({ kind: "review-game", gameId: 42 })
		assert.equal(a, b, "double-clicking review must not spawn two Claude runs")
		assert.equal(depth(), 1)
	})

	it("keeps different kinds and different games apart", () => {
		enqueueJob({ kind: "review-game", gameId: 42 })
		enqueueJob({ kind: "analysis-run", gameId: 42 })
		enqueueJob({ kind: "review-game", gameId: 43 })
		assert.equal(depth(), 3)
	})
})

describe("claiming", () => {
	it("hands out the lowest-priority-number job first", () => {
		enqueueJob({ kind: "review-game", gameId: 1 })
		enqueueJob({ kind: "match-ingest", gameId: 1 })
		const first = claim()
		assert.equal(first?.kind, "match-ingest", "ingest (10) outranks review (40)")
	})

	it("never hands an intrusive job to a worker that was not cleared for one", () => {
		enqueueJob({ kind: "replay-capture", gameId: 7 })
		assert.equal(claim({ allowIntrusive: false }), null)
		const job = claim({ allowIntrusive: true, kinds: ["replay-capture"] })
		assert.equal(job?.kind, "replay-capture")
		assert.equal(job?.intrusive, true)
	})

	it("cannot hand the same job to two workers", () => {
		enqueueJob({ kind: "match-ingest", gameId: 9 })
		const a = claim()
		const b = claim()
		assert.ok(a)
		assert.equal(b, null)
	})

	it("does not claim a job whose notBeforeMs is in the future", () => {
		enqueueJob({ kind: "match-ingest", gameId: 9, notBeforeMs: Date.now() + 60_000 })
		assert.equal(claim(), null)
	})
})

describe("outcomes", () => {
	it("finish marks the job done and records the note", () => {
		enqueueJob({ kind: "media-generate", gameId: 3 })
		const job = claim()!
		finish(job, "12 map images")
		const after = getJob(job.id)!
		assert.equal(after.state, "done")
		assert.equal(after.lastError, "12 map images")
	})

	it("abandon retries with exponential backoff while attempts remain", () => {
		enqueueJob({ kind: "analysis-run", gameId: 4, maxAttempts: 3 })
		const job = claim()!
		abandon(job, "boom 1")
		const after = getJob(job.id)!
		assert.equal(after.state, "queued", "first failure retries")
		assert.ok(after.notBeforeMs > Date.now(), "and it backs off before retrying")
		assert.equal(after.lastError, "boom 1")
	})

	it("abandon goes terminal-failed once maxAttempts is spent, keeping the error", () => {
		enqueueJob({ kind: "analysis-run", gameId: 5, maxAttempts: 1 })
		const job = claim()!
		assert.equal(job.attempts, 1, "claiming consumes the attempt")
		abandon(job, "boom final")
		const after = getJob(job.id)!
		assert.equal(after.state, "failed")
		assert.equal(after.lastError, "boom final", "the reason survives for the UI to show")
	})

	it("defer does NOT consume an attempt — 'not now' is not a failure", () => {
		enqueueJob({ kind: "replay-capture", gameId: 15 })
		const job = claim({ allowIntrusive: true })!
		assert.equal(job.attempts, 1)
		defer(job, "gate G6: capture is switched off", Date.now() + 60_000)
		const after = getJob(job.id)!
		assert.equal(after.state, "deferred")
		assert.equal(after.attempts, 0, "a job waiting on the gate must not look like a crash")
		assert.match(after.lastError ?? "", /G6/)
	})

	it("expire is terminal and keeps its reason", () => {
		enqueueJob({ kind: "replay-download", gameId: 6 })
		const job = claim()!
		expire(job, "the 30-minute replay window closed")
		const after = getJob(job.id)!
		assert.equal(after.state, "expired")
		assert.match(after.lastError ?? "", /30-minute/)
	})
})

describe("sweep", () => {
	it("returns work a crashed worker was holding, at the cost of one attempt", () => {
		enqueueJob({ kind: "match-ingest", gameId: 8 })
		const job = claim({ leaseMs: -1 })! // a lease that expired the instant it was taken
		assert.equal(job.state, "leased")
		const { reclaimed } = sweep()
		assert.equal(reclaimed, 1)
		const after = getJob(job.id)!
		assert.equal(after.state, "queued", "kill -9 costs an attempt, never the job")
		assert.equal(after.attempts, 1)
	})

	it("expires anything past its hard deadline without touching live jobs", () => {
		enqueueJob({ kind: "replay-download", gameId: 10, deadlineMs: Date.now() - 1 })
		enqueueJob({ kind: "analysis-run", gameId: 10 })
		const { expired } = sweep()
		assert.equal(expired, 1)
		const states = listJobs({}).map(j => [j.kind, j.state])
		assert.deepEqual(
			states.sort(),
			[
				["analysis-run", "queued"],
				["replay-download", "expired"]
			].sort()
		)
	})
})
