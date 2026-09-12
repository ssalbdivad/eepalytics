import { describe, it } from "node:test"
import { strictEqual } from "node:assert"
import { age, clock, csFloor, freshnessOf, reachText } from "./boardView.ts"
import type { BoardObjective, BoardRead } from "./boardView.ts"

const read = (over: Partial<BoardRead> = {}): BoardRead => ({
	coarse: "topside",
	label: "enemy red-side jungle (top)",
	ageSec: 4,
	confidence: "medium",
	positioned: true,
	...over
})

const obj = (over: Partial<BoardObjective> = {}): BoardObjective => ({
	label: "Drake",
	windowSec: 45,
	origin: "minimap",
	ageSec: 4,
	constrained: true,
	etaMinSec: 18,
	etaMaxSec: 26,
	marginMinSec: 19,
	marginMaxSec: 27,
	...over
})

describe("clock", () => {
	it("keeps sub-minute windows in seconds, because that is how a jungler counts them", () => {
		strictEqual(clock(45), "45s")
		strictEqual(clock(0), "0s")
	})
	it("never renders a negative window as a negative number", () => {
		strictEqual(clock(-12), "0s")
	})
	it("pads the seconds past a minute", () => {
		strictEqual(clock(65), "1:05")
		strictEqual(clock(600), "10:00")
	})
})

describe("age", () => {
	it("is exact under a minute and coarse past it", () => {
		strictEqual(age(9), "9s")
		strictEqual(age(59), "59s")
		strictEqual(age(60), "1m")
		strictEqual(age(95), "1m+")
	})
})

describe("csFloor", () => {
	/*
	 * The whole point of the suffix: the client floors `creepScore` to a multiple of ten, so 40 is
	 * a HUD reading anything from 40 to 49 — and he is looking at the HUD while he reads this.
	 */
	it("marks every CS figure as the floor it is", () => {
		strictEqual(csFloor(40), "40+")
		strictEqual(csFloor(0), "0+")
	})
	it("renders an absent figure as absent rather than as zero", () => {
		strictEqual(csFloor(null), "—")
		strictEqual(csFloor(undefined), "—")
	})
})

describe("freshnessOf", () => {
	it("calls a read inside the fresh window a statement about now", () => {
		strictEqual(freshnessOf(read({ ageSec: 4 }), 10, 30), "now")
		strictEqual(freshnessOf(read({ ageSec: 10 }), 10, 30), "now")
	})
	it("demotes a read past the fresh window to the past tense", () => {
		strictEqual(freshnessOf(read({ ageSec: 11 }), 10, 30), "was")
		strictEqual(freshnessOf(read({ ageSec: 30 }), 10, 30), "was")
	})
	/*
	 * The measured cliff: past thirty seconds the half is a coin flip, so the board stops calling
	 * it a position at all. This is the case the whole surface is aimed at — a ninety-second-old
	 * read must not render as a place he is.
	 */
	it("stops calling a read past the carry window a position", () => {
		strictEqual(freshnessOf(read({ ageSec: 31 }), 10, 30), "unknown")
		strictEqual(freshnessOf(read({ ageSec: 90 }), 10, 30), "unknown")
	})
	it("treats a doubted read as no read, at any age", () => {
		strictEqual(freshnessOf(read({ ageSec: 1, confidence: "low" }), 10, 30), "unknown")
	})
	it("treats a refused or absent read as unknown rather than as stale", () => {
		strictEqual(freshnessOf(null, 10, 30), "unknown")
		strictEqual(freshnessOf(undefined, 10, 30), "unknown")
	})
	it("takes the thresholds from the payload rather than knowing any of its own", () => {
		strictEqual(freshnessOf(read({ ageSec: 20 }), 25, 60), "now")
	})
})

describe("reachText", () => {
	it("quotes the walk as an interval, and only proves the negative", () => {
		strictEqual(reachText(obj(), 0), "18–26s away · reachable")
		// The spawn beats even the fastest arrival the read allows. Terrain can only make it worse.
		strictEqual(
			reachText(obj({ marginMinSec: -20, marginMaxSec: -12 }), 0),
			"18–26s away · won't make it"
		)
		strictEqual(reachText(obj({ marginMinSec: -4, marginMaxSec: 6 }), 0), "18–26s away · tight")
	})
	it("names the absent input rather than printing a blank", () => {
		strictEqual(reachText(obj({ etaMinSec: null, etaMaxSec: null, origin: null }), 0), "no position")
		// An origin with no eta is a missing move speed: the loading screen, or a torn payload.
		strictEqual(
			reachText(obj({ etaMinSec: null, etaMaxSec: null, origin: "minimap" }), 0),
			"no travel time"
		)
	})
	/*
	 * `constrained` false means everywhere he could have walked to since the read includes the pit.
	 * That is not a failure and it is not a number — it is the one thing the read still says.
	 */
	it("says he may already be standing in it when the read no longer bounds the walk", () => {
		strictEqual(reachText(obj({ constrained: false }), 0), "could already be there")
	})
	it("drops the verdict once the window is already open", () => {
		strictEqual(reachText(obj({ windowSec: -30 }), 0), "18–26s away")
		// And the same objective goes verdict-less as the interpolated clock crosses the spawn.
		strictEqual(reachText(obj({ windowSec: 5 }), 6), "18–26s away")
	})
	it("says where a dead player's walk starts, because that origin is exact", () => {
		strictEqual(
			reachText(obj({ origin: "fountain", etaMinSec: 40, etaMaxSec: 40, marginMinSec: 5, marginMaxSec: 5 }), 0),
			"40s away from base · reachable"
		)
	})
	it("renders a walk over a minute as a clock rather than as raw seconds", () => {
		strictEqual(
			reachText(obj({ etaMinSec: 58, etaMaxSec: 72, marginMinSec: -30, marginMaxSec: -16 }), 0),
			"58s–1:12 away · won't make it"
		)
	})
})
