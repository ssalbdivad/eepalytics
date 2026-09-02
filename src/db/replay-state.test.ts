/**
 * A re-ingest must not forget that the replay was already downloaded.
 *
 * NO caller ever passes `replayState` to `upsertGame` — the download path owns it, through
 * `setGameReplayState`. The upsert nonetheless bound it as a plain `excluded.replayState`,
 * whose value is the `?? "absent"` default, so every re-ingest silently reset the column to
 * `'absent'` while `replayPath` — which IS coalesced — survived. That produced a row claiming
 * no replay existed while naming the `.rofl` sitting on disk, and it was not hypothetical:
 * `match-ingest` re-writes a stub row every 30 s for any game the client is still assembling,
 * which is exactly when the 30-minute download window is open.
 *
 * Two things break downstream when it happens:
 *   * `needsReplay()` in `match-ingest.ts` treats `'absent'` as "worth downloading", so the
 *     no-op download job is re-queued over and over, and
 *   * `gamesForRetentionPrune` only ever selects `'available'` rows, so the 15 MB `.rofl`
 *     never gets cleaned up.
 *
 * Run: pnpm test
 */

import { strict as assert } from "node:assert"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, it } from "node:test"
import { closeDb, migrate, useDb } from "./index.ts"
import { getGame, setGameReplayState, upsertGame } from "./queries.ts"
import type { GameUpsert } from "./queries.ts"

const GAME = 5633952046
const ROFL = "/mnt/c/Users/ssalb/Documents/League of Legends/Replays/NA1-5633952046.rofl"

/** Exactly the field set `match-ingest.ts` passes — note the absence of `replayState`. */
const ingest = (): GameUpsert => ({
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

let db: DatabaseSync

beforeEach(() => {
	db = new DatabaseSync(":memory:")
	migrate(db)
	useDb(db)
})

afterEach(() => {
	closeDb()
})

describe("upsertGame and replayState", () => {
	it("defaults a brand-new game to absent", () => {
		upsertGame(ingest())
		assert.equal(getGame(GAME)!.replayState, "absent")
	})

	it("keeps 'available' across a re-ingest that omits the field", () => {
		upsertGame(ingest())
		setGameReplayState(GAME, "available", ROFL)

		upsertGame(ingest())
		const after = getGame(GAME)!
		assert.equal(after.replayState, "available", "a re-ingest must not forget the download")
		assert.equal(after.replayPath, ROFL, "and the path it names must still be there")
	})

	it("survives the repeated stub writes match-ingest makes while a game is assembling", () => {
		upsertGame(ingest())
		setGameReplayState(GAME, "available", ROFL)
		for (let i = 0; i < 5; i++) upsertGame(ingest())
		assert.equal(getGame(GAME)!.replayState, "available")
	})

	it("never leaves a row that names a .rofl while claiming none exists", () => {
		upsertGame(ingest())
		setGameReplayState(GAME, "available", ROFL)
		upsertGame(ingest())
		const g = getGame(GAME)!
		assert.ok(
			!(g.replayPath !== null && g.replayState === "absent"),
			`self-contradictory row: replayState=${g.replayState} replayPath=${g.replayPath}`
		)
	})

	it("keeps a terminal state that is not 'available' too", () => {
		upsertGame(ingest())
		setGameReplayState(GAME, "pruned")
		upsertGame(ingest())
		assert.equal(getGame(GAME)!.replayState, "pruned")

		setGameReplayState(GAME, "expired")
		upsertGame(ingest())
		assert.equal(getGame(GAME)!.replayState, "expired")
	})

	it("still lets a caller set the state explicitly", () => {
		upsertGame(ingest())
		setGameReplayState(GAME, "available", ROFL)
		upsertGame({ ...ingest(), replayState: "expired" })
		assert.equal(getGame(GAME)!.replayState, "expired")
	})
})
