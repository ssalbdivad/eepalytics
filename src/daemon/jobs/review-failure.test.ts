/**
 * The failure half of `review-game` and `review-trend`, pinned.
 *
 * These assertions are the RECORD OF WHAT THE TWO JOBS DID before the four copies of this
 * logic were folded into one module: the stored `error` string is `"<code>: <message>"`, a
 * failed row is stored rather than swallowed, and the two defer windows are 30 minutes for a
 * missing transport and 5 seconds for a cancellation. If a later edit changes any of those,
 * this file is the thing that says it was a change and not a tidy-up.
 *
 * Run: pnpm test
 */

import { strict as assert } from "node:assert"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, it } from "node:test"
import { closeDb, migrate, useDb } from "../../db/index.ts"
import { latestReviewOutcome, upsertGame } from "../../db/queries.ts"
import { deferForCoachError, recordFailedReview } from "./review-failure.ts"

const GAME = 5640037727

describe("deferForCoachError", () => {
	it("defers a missing transport for half an hour — it is configuration, not flakiness", () => {
		const before = Date.now()
		const out = deferForCoachError("no-transport")
		assert.ok(out?.defer)
		assert.match(out.defer.reason, /neither an authenticated `claude` CLI nor ANTHROPIC_API_KEY/)
		assert.ok(out.defer.untilMs! - before >= 30 * 60_000 - 50)
		assert.ok(out.defer.untilMs! - before <= 30 * 60_000 + 5_000)
	})

	it("defers a cancellation by five seconds, so a stop is not a retry storm either", () => {
		const before = Date.now()
		const out = deferForCoachError("aborted")
		assert.equal(out?.defer?.reason, "cancelled")
		assert.ok(out!.defer!.untilMs! - before >= 5_000 - 50)
		assert.ok(out!.defer!.untilMs! - before <= 5_000 + 5_000)
	})

	it("returns null for every other code, so the worker sees the throw", () => {
		for (const code of ["bad-json", "http-500", "timeout", "schema", ""])
			assert.equal(deferForCoachError(code), null, code)
	})
})

describe("recordFailedReview", () => {
	beforeEach(() => {
		const db = new DatabaseSync(":memory:")
		migrate(db)
		useDb(db)
		// A review row is FOREIGN KEYed to its game, so a failure can only be stored for a game
		// the ingest already wrote. Both jobs read the game row before they ever call the coach.
		upsertGame({
			gameId: GAME,
			platformId: "NA1",
			queueId: 420,
			gameMode: "CLASSIC",
			gameVersion: "16.17.810.4348",
			patch: "16.17",
			gameCreationMs: 1788385737360,
			gameDurationSec: 2070,
			participantId: 7,
			teamId: 200,
			championId: 876,
			win: true
		})
	})
	afterEach(closeDb)

	it("stores the row a failed run is supposed to leave, with `code: message` as the error", () => {
		recordFailedReview({
			kind: "game",
			gameId: GAME,
			model: "claude-test",
			promptHash: "abc123",
			code: "bad-json",
			error: "no object in the response"
		})
		const out = latestReviewOutcome(GAME)
		assert.equal(out?.status, "failed")
		assert.equal(out?.error, "bad-json: no object in the response")
	})

	it("accepts the trend shape, whose gameId is null", () => {
		recordFailedReview({
			kind: "trend",
			gameId: null,
			model: "claude-test",
			promptHash: "def456",
			code: "aborted",
			error: "cancelled"
		})
		// A trend failure is not a game failure: it must not surface on any game's row.
		assert.equal(latestReviewOutcome(GAME), null)
	})
})
