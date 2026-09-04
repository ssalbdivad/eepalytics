/**
 * A Practice Tool game jammed the queue: the LCU never returns its full match, so match-ingest
 * deferred every 30 seconds forever (103 times in 52 minutes, measured) and dragged a stuck
 * analysis and review behind it. These pin what is and is not worth coaching.
 */

import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { isCoachable, uncoachableReason } from "./coachable.ts"

describe("uncoachableReason", () => {
	it("refuses Practice Tool by mode, type and queue independently", () => {
		ok(uncoachableReason({ gameMode: "PRACTICETOOL" }))
		ok(uncoachableReason({ gameType: "CUSTOM_GAME" }))
		ok(uncoachableReason({ queueId: 3140 }))
		// The real row that caused this, exactly as stored.
		ok(
			uncoachableReason({
				gameMode: "PRACTICETOOL",
				gameType: "CUSTOM_GAME",
				queueId: 3140,
				gameDurationSec: 286
			})
		)
	})

	it("refuses tutorials", () => {
		ok(uncoachableReason({ gameMode: "TUTORIAL_MODULE_1" }))
	})

	it("refuses a remake, which has no stat block to read", () => {
		ok(uncoachableReason({ gameMode: "CLASSIC", gameType: "MATCHED_GAME", queueId: 420, gameDurationSec: 240 }))
	})

	it("coaches ranked solo", () => {
		strictEqual(
			uncoachableReason({
				gameMode: "CLASSIC",
				gameType: "MATCHED_GAME",
				queueId: 420,
				gameDurationSec: 1830
			}),
			null
		)
	})

	it("coaches a normal draft game", () => {
		ok(isCoachable({ gameMode: "CLASSIC", gameType: "MATCHED_GAME", queueId: 400, gameDurationSec: 1600 }))
	})

	it("is case-insensitive, because the LCU is not consistent about case", () => {
		ok(uncoachableReason({ gameMode: "practicetool" }))
	})

	it("does not refuse a game whose duration is simply unknown", () => {
		strictEqual(uncoachableReason({ gameMode: "CLASSIC", gameType: "MATCHED_GAME", queueId: 420 }), null)
	})
})
