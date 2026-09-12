/**
 * `gamesNeedingIngest` must not chase a game the app will never coach.
 *
 * `match-ingest` writes a stub row with no blobs so the 30-minute replay download can start,
 * and leans on this query to re-queue the game until the full match shows up. For a real game
 * that terminates. For a Practice Tool game the LCU never returns a full match, so the stub
 * stays blob-less forever and reconcile re-enqueues it every five minutes for as long as the
 * daemon runs.
 *
 * Measured on the real database before the filter: all ELEVEN games the query returned were
 * PRACTICETOOL, and about 5,300 of the 8,475 rows in the `job` table were those re-queues,
 * every one of them refused the moment it ran.
 *
 * Run: pnpm test
 */

import { strict as assert } from "node:assert"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, it } from "node:test"
import { closeDb, migrate, useDb } from "./index.ts"
import { gamesNeedingIngest, setGameBlobs, upsertGame } from "./queries.ts"
import type { GameUpsert } from "./queries.ts"

const base = (gameId: number, over: Partial<GameUpsert>): GameUpsert => ({
	gameId,
	platformId: "NA1",
	queueId: 420,
	gameMode: "CLASSIC",
	gameType: "MATCHED_GAME",
	gameVersion: "16.18.1",
	patch: "16.18",
	gameCreationMs: 1789000000000 + gameId,
	gameDurationSec: 1800,
	participantId: 7,
	teamId: 200,
	championId: 876,
	win: true,
	...over
})

let db: DatabaseSync

beforeEach(() => {
	db = new DatabaseSync(":memory:")
	migrate(db)
	useDb(db)
})

afterEach(() => {
	closeDb()
})

describe("gamesNeedingIngest", () => {
	it("returns a real game that has no blobs yet", () => {
		upsertGame(base(1, {}))
		assert.deepEqual(gamesNeedingIngest(50), [1])
	})

	it("skips a Practice Tool game, which never gets a full match", () => {
		upsertGame(base(2, { gameMode: "PRACTICETOOL", gameType: "CUSTOM_GAME", queueId: 3140 }))
		assert.deepEqual(gamesNeedingIngest(50), [])
	})

	it("skips a custom game, and a remake too short to coach", () => {
		upsertGame(base(3, { gameType: "CUSTOM_GAME" }))
		upsertGame(base(4, { gameDurationSec: 120 }))
		assert.deepEqual(gamesNeedingIngest(50), [])
	})

	it("does not let a backlog of practice games starve the limit of real ones", () => {
		// The filter runs after the SQL LIMIT, so the query over-fetches; without that, ten
		// practice games ahead of one real game in `gameCreationMs` order would hide it.
		for (let i = 0; i < 10; i++)
			upsertGame(
				base(100 + i, {
					gameMode: "PRACTICETOOL",
					gameType: "CUSTOM_GAME",
					queueId: 3140,
					gameCreationMs: 1789900000000 + i
				})
			)
		upsertGame(base(5, { gameCreationMs: 1789800000000 }))
		assert.deepEqual(gamesNeedingIngest(3), [5])
	})

	it("stops returning a game once both blobs are present", () => {
		upsertGame(base(6, {}))
		assert.deepEqual(gamesNeedingIngest(50), [6])
		setGameBlobs(6, { matchBlob: "blobs/6/match.json.gz", timelineBlob: "blobs/6/tl.json.gz" })
		assert.deepEqual(gamesNeedingIngest(50), [])
	})
})
