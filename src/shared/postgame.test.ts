/**
 * The post-game panel's whole decision. Each of these is a rule the UI depends on: an
 * uncoachable game must produce nothing, a dismissal must outlive a reload, and a match the
 * client never returns must not leave a spinner up for the rest of the session.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { INGEST_GRACE_MS, matchesMarker, postGameDebrief } from "./postgame.ts"
import type { PostGameInput } from "./postgame.ts"

const NOW = 1_800_000_000_000
const ENDED = NOW - 20_000

const real = {
	gameId: 5_000_000_001,
	gameMode: "CLASSIC",
	gameType: "MATCHED_GAME",
	queueId: 420,
	gameDurationSec: 1840,
	championName: "Lillia",
	win: false
}

const input = (patch: Partial<PostGameInput> = {}): PostGameInput => ({
	marker: { gameId: real.gameId, endedAtMs: ENDED },
	dismissedEndedAtMs: null,
	game: real,
	nowMs: NOW,
	...patch
})

describe("postGameDebrief", () => {
	it("says nothing when no game has ended", () => {
		strictEqual(postGameDebrief(input({ marker: null })), null)
	})

	it("reports a stored game with the header the panel can draw immediately", () => {
		deepStrictEqual(postGameDebrief(input()), {
			gameId: real.gameId,
			endedAtMs: ENDED,
			stage: "stored",
			championName: "Lillia",
			win: false
		})
	})

	it("reports the wait while the client is still assembling the match", () => {
		deepStrictEqual(postGameDebrief(input({ game: null })), {
			gameId: real.gameId,
			endedAtMs: ENDED,
			stage: "ingesting"
		})
	})

	it("carries no id when the gameflow session never gave one", () => {
		const out = postGameDebrief(input({ game: null, marker: { gameId: null, endedAtMs: ENDED } }))
		strictEqual(out?.gameId, null)
		strictEqual(out?.stage, "ingesting")
	})

	it("gives up on a match that never arrived rather than spinning forever", () => {
		strictEqual(
			postGameDebrief(input({ game: null, nowMs: ENDED + INGEST_GRACE_MS + 1 })),
			null
		)
	})

	it("never shows a debrief for a game the coach refuses to read", () => {
		for (const game of [
			{ ...real, gameMode: "PRACTICETOOL" },
			{ ...real, gameType: "CUSTOM_GAME" },
			{ ...real, queueId: 3140 },
			// A remake: Riot writes no end-of-game stats for a game this short.
			{ ...real, gameDurationSec: 210 }
		])
			strictEqual(postGameDebrief(input({ game })), null, game.gameMode)
	})

	it("stays dismissed, and the dismissal is keyed on the end time so it survives a reload", () => {
		strictEqual(postGameDebrief(input({ dismissedEndedAtMs: ENDED })), null)
		// A dismissal of the PREVIOUS game must not swallow this one.
		strictEqual(postGameDebrief(input({ dismissedEndedAtMs: ENDED - 3_000_000 }))?.stage, "stored")
	})

	it("comes back for the next game after one was dismissed", () => {
		const next = { gameId: real.gameId + 1, endedAtMs: ENDED + 2_400_000 }
		const out = postGameDebrief(
			input({ marker: next, dismissedEndedAtMs: ENDED, nowMs: next.endedAtMs + 5_000 })
		)
		strictEqual(out?.endedAtMs, next.endedAtMs)
	})
})

describe("matchesMarker", () => {
	it("accepts the game that just ended and rejects the one before it", () => {
		strictEqual(matchesMarker(ENDED - 30_000, ENDED), true)
		strictEqual(matchesMarker(ENDED - 40 * 60_000, ENDED), false)
	})
})
