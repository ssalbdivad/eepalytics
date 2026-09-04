/**
 * The tier decides whether the app is allowed to have an opinion, so it is pinned hard.
 *
 * The first test is the one that matters. Two designs for this metric were proposed and both used
 * span or in-span density, which a handful of clustered frames satisfies — five frames at the
 * start and one at the end scoring 0.91 for a game nobody watched. That would have unlocked
 * grading on almost every game and quietly defeated the entire rewrite.
 */

import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { BUCKET_SEC, WATCHED_MIN_COVERAGE, WATCHED_MIN_FRAMES, evidenceOf } from "./evidence.ts"

/** Frames every `everySec` across `[from, to]`, the shape a healthy journal produces. */
const spread = (from: number, to: number, everySec: number): number[] => {
	const out: number[] = []
	for (let t = from; t <= to; t += everySec) out.push(t)
	return out
}

describe("evidenceOf — clustering cannot buy a grade", () => {
	it("refuses a game watched only at the start and the end", () => {
		// The exact shape that defeats a span metric: a dense cluster plus one late frame.
		const e = evidenceOf({
			frameTimesSec: [...spread(120, 240, 1), 2040],
			gameDurationSec: 2100
		})
		strictEqual(e.tier, "numbers", `span was ${Math.round((2040 - 120) / 2100 * 100)}% but nobody watched it`)
		ok(e.coverage < 0.2, `coverage should be low, got ${e.coverage}`)
	})

	it("counts a bucket once however many frames land in it", () => {
		const e = evidenceOf({ frameTimesSec: spread(0, 29, 0.5), gameDurationSec: 1800 })
		strictEqual(e.bucketsCovered, 1)
		ok(e.frames > 50, "plenty of frames…")
		strictEqual(e.tier, "numbers", "…but only half a minute of the game")
	})

	it("grades a game that was genuinely on screen throughout", () => {
		const e = evidenceOf({ frameTimesSec: spread(0, 1800, 5), gameDurationSec: 1800 })
		strictEqual(e.tier, "watched")
		strictEqual(e.shortfall, null)
		ok(e.coverage > 0.95)
	})

	it("tolerates a share that dropped for a couple of minutes", () => {
		const t = spread(0, 1800, 5).filter(s => s < 600 || s > 740)
		strictEqual(evidenceOf({ frameTimesSec: t, gameDurationSec: 1800 }).tier, "watched")
	})

	it("refuses a share that only started halfway", () => {
		const e = evidenceOf({ frameTimesSec: spread(950, 1800, 5), gameDurationSec: 1800 })
		strictEqual(e.tier, "numbers")
		ok(e.shortfall!.includes("%"), `should name the coverage, got: ${e.shortfall}`)
	})
})

describe("evidenceOf — edges", () => {
	it("has no opinion with no frames, and says why in words", () => {
		const e = evidenceOf({ frameTimesSec: [], gameDurationSec: 1800 })
		strictEqual(e.tier, "numbers")
		strictEqual(e.frames, 0)
		ok(e.shortfall!.includes("wasn't shared"), e.shortfall!)
	})

	it("ignores frames outside the game rather than trusting them", () => {
		// Loading screens and the post-game lobby produce these.
		const e = evidenceOf({ frameTimesSec: [-30, -5, 100, 99999], gameDurationSec: 600 })
		strictEqual(e.frames, 1)
	})

	it("does not let a short game be graded on a handful of frames", () => {
		// 4 minutes is 8 buckets; 5 well-spread frames would "cover" 62% of it.
		const e = evidenceOf({ frameTimesSec: [10, 45, 100, 150, 200], gameDurationSec: 240 })
		ok(e.coverage >= WATCHED_MIN_COVERAGE, "coverage alone would have passed it")
		strictEqual(e.tier, "numbers", "the frame floor is what stops it")
		ok(e.shortfall!.includes(String(WATCHED_MIN_FRAMES)))
	})

	it("never divides by zero on a zero-length game", () => {
		const e = evidenceOf({ frameTimesSec: [], gameDurationSec: 0 })
		strictEqual(e.buckets, 1)
		strictEqual(e.tier, "numbers")
		ok(Number.isFinite(e.coverage))
	})

	it("buckets at the documented width", () => {
		// Two frames one bucket apart cover two buckets; two within one cover one.
		strictEqual(evidenceOf({ frameTimesSec: [0, BUCKET_SEC], gameDurationSec: 600 }).bucketsCovered, 2)
		strictEqual(
			evidenceOf({ frameTimesSec: [0, BUCKET_SEC - 1], gameDurationSec: 600 }).bucketsCovered,
			1
		)
	})
})
