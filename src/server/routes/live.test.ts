/**
 * The seam where the PICTURE becomes something the coach may say.
 *
 * `analysis/live-facts.ts` decides what a frame read is worth; this route decides what survives to
 * be offered one at all. Two rules live here and both are measured, so both are pinned:
 *
 *   - the read is COARSENED to a half of the map at the door, because that is the only granularity
 *     that measured well enough to act on (his own half right on 17 of 18 hand-scored reads, his own
 *     zone on 15 of 18) and precision that is never stored cannot later be reached for;
 *   - two consecutive reads that disagree about the half mark the observation `low`, because two
 *     reads of ONE picture agreed on only 56 of 60 pairs and a disagreement is that 7% arriving.
 *
 * The fence itself (`frameReadFaults`) is tested in `review/frame-read.test.ts`; what is tested here
 * is the step after it.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { observationFrom } from "./live.ts"
import { FRAME_FRESH_SEC } from "../../analysis/live-facts.ts"
import type { FrameRead } from "../../review/frame-read.ts"

const read = (you: FrameRead["you"]): FrameRead => ({
	enemiesOnMinimap: [],
	alliesOnMinimap: 0,
	you,
	activity: "moving",
	youChampion: null
})

describe("observationFrom", () => {
	it("keeps the half and throws the zone away", () => {
		/*
		 * `OWN_JUNGLE_TOP` and `BARON_PIT` are different places and the same decision. Storing the
		 * zone would leave a 83%-accurate answer sitting in a field that a later sentence could
		 * name a camp from, which is exactly the class of claim the enemy-sighting measurement
		 * ruled out.
		 */
		deepStrictEqual(observationFrom(read("OWN_JUNGLE_TOP"), null, 600), {
			where: "topside",
			atSec: 600,
			confidence: "medium"
		})
		strictEqual(observationFrom(read("DRAGON_PIT"), null, 600).where, "botside")
		strictEqual(observationFrom(read("LANE_MID"), null, 600).where, "mid")
		strictEqual(observationFrom(read("OWN_BASE"), null, 600).where, "base")
	})

	it("passes a refusal through as a refusal, not as a place", () => {
		// The reader is offered "not visible" precisely so that guessing is never its only move.
		// Turning that into a half here would undo the whole point of offering it.
		strictEqual(observationFrom(read(null), null, 600).where, null)
	})

	it("doubts a read that disagrees with the one before it", () => {
		const previous = { where: "topside" as const, atSec: 595 }
		strictEqual(observationFrom(read("DRAGON_PIT"), previous, 600).confidence, "low")
		strictEqual(observationFrom(read("BARON_PIT"), previous, 600).confidence, "medium")
	})

	it("does not doubt a read that simply came much later", () => {
		/*
		 * He crosses the map. Two reads a minute apart disagreeing is a man walking, not a reader
		 * contradicting itself, and treating it as doubt would make the coach quietest in exactly
		 * the games where he is moving most.
		 */
		const previous = { where: "topside" as const, atSec: 500 }
		strictEqual(
			observationFrom(read("DRAGON_PIT"), previous, 500 + FRAME_FRESH_SEC + 1).confidence,
			"medium"
		)
	})

	it("counts a lost icon as a disagreement when it follows a sighting", () => {
		// One read placed him and the next could not find him at all. That is the reader being
		// unstable on the same picture, and it is the case a "compare two halves" test would miss
		// if null were quietly excused.
		const previous = { where: "botside" as const, atSec: 598 }
		strictEqual(observationFrom(read(null), previous, 600).confidence, "low")
	})
})
