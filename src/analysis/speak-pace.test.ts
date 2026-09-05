/**
 * The cadence is pinned here, because it is the number he actually experiences.
 *
 * Every case below is either a figure out of `data/eval/pace-sweep-grid20.json` — 110 real recorded
 * turns of game 5635467422 on the shipped twenty-second grid — or a property of the gate that a
 * plausible refactor would break silently. The two that matter most are the last two: a suppressed
 * turn must not start the clock, and there must be no queue.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { SPEAK_FLOOR_SEC, mayspeak, newPaceMemory, noteSpoken, resetPaceMemory } from "./speak-pace.ts"
import type { PaceTier } from "./speak-pace.ts"

/** Speak on every turn the gate allows, and report the game clocks he would have heard. */
const heard = (
	turns: { tSec: number; tier?: PaceTier }[],
	opts?: { floorSec?: number; interruptFloorSec?: number }
): number[] => {
	const mem = newPaceMemory()
	const out: number[] = []
	for (const t of turns)
		if (mayspeak(mem, t.tSec, t.tier ?? "standing", opts ?? {}).speak) {
			out.push(t.tSec)
			noteSpoken(mem, t.tSec)
		}
	return out
}

/** The shipped turn cadence, from 0 to `endSec`. */
const grid = (endSec: number, everySec = 20): { tSec: number }[] =>
	Array.from({ length: Math.floor(endSec / everySec) + 1 }, (_, i) => ({ tSec: i * everySec }))

describe("the floor", () => {
	it("is 45 seconds, and is the same number live-facts arrived at separately", () => {
		strictEqual(SPEAK_FLOOR_SEC, 45)
	})

	it("always lets the first line of the game through", () => {
		const mem = newPaceMemory()
		const d = mayspeak(mem, 0)
		ok(d.speak)
		strictEqual(d.reason, "first")
		strictEqual(d.sinceSec, Infinity)
	})

	it("blocks inside the floor and clears exactly on it", () => {
		const mem = newPaceMemory()
		noteSpoken(mem, 100)
		strictEqual(mayspeak(mem, 144).speak, false)
		strictEqual(mayspeak(mem, 145).speak, true)
		strictEqual(mayspeak(mem, 145).reason, "clear")
	})

	/*
	 * The finding that says there is no point tuning this finely: a floor is rounded UP to the turn
	 * that follows it, so everything in (40, 60] is "about one line a minute" on the shipped
	 * twenty-second turn. Measured on the real corpus, the 45-second floor's minimum gap was 55
	 * seconds and its median 61.
	 */
	it("quantizes to the turn — 45 and 60 are the same coach at a 20-second cadence", () => {
		deepStrictEqual(heard(grid(300), { floorSec: 45 }), heard(grid(300), { floorSec: 60 }))
		deepStrictEqual(heard(grid(300), { floorSec: 45 }), [0, 60, 120, 180, 240, 300])
	})

	/*
	 * The number he cares about. He turned the previous coach off at NINE lines in four minutes;
	 * unpaced, this architecture measured thirteen in its busiest four. The floor is what stands
	 * between those two facts, so the bound is asserted rather than described.
	 */
	it("caps a four-minute window at five lines, against the nine he quit over", () => {
		const spoken = heard(grid(240))
		ok(spoken.length <= 5, `${spoken.length} lines in four minutes`)
		deepStrictEqual(spoken, [0, 60, 120, 180, 240])
	})

	it("a whole 36-minute game lands near the measured 35 lines", () => {
		// 0.96 lines a minute in the sweep; a synthetic grid with no PASSes is the ceiling of that.
		const spoken = heard(grid(2196))
		ok(spoken.length >= 35 && spoken.length <= 38, `${spoken.length} lines`)
	})
})

describe("the tier exemption", () => {
	it("is inert by default — an interrupt does not cut the shipped floor", () => {
		const mem = newPaceMemory()
		noteSpoken(mem, 100)
		strictEqual(mayspeak(mem, 130, "interrupt").speak, false)
		strictEqual(mayspeak(mem, 130, "interrupt").reason, "floor")
	})

	it("cuts the floor only when the sweep asks it to", () => {
		const mem = newPaceMemory()
		noteSpoken(mem, 100)
		const d = mayspeak(mem, 130, "interrupt", { floorSec: 45, interruptFloorSec: 20 })
		ok(d.speak)
		strictEqual(d.reason, "interrupt")
		strictEqual(d.floorSec, 20)
	})

	it("never lets an exemption be LOOSER than the floor it exempts from", () => {
		const mem = newPaceMemory()
		noteSpoken(mem, 100)
		// A misconfigured interrupt floor above the plain floor must not silence an interrupt.
		strictEqual(mayspeak(mem, 150, "interrupt", { floorSec: 45, interruptFloorSec: 200 }).speak, true)
	})

	it("an expiring or standing fact never cuts the floor, whatever the exemption is set to", () => {
		const mem = newPaceMemory()
		noteSpoken(mem, 100)
		for (const tier of ["expiring", "standing"] as const)
			strictEqual(mayspeak(mem, 130, tier, { floorSec: 45, interruptFloorSec: 20 }).speak, false)
	})
})

describe("suppression is a drop", () => {
	/*
	 * Measured and refused: queueing a suppressed line to the next clear turn delivered 34 lines at
	 * a median age of 19 seconds, and SEVENTEEN of them quoted a figure the block no longer carried
	 * by then — half the output of a queue breaks the citation rule the architecture rests on.
	 * There is nowhere in this memory to hold a line, and that is the guard.
	 */
	it("has no pending line to deliver — the memory holds one clock and nothing else", () => {
		deepStrictEqual(Object.keys(newPaceMemory()), ["lastSpokeAtSec"])
	})

	/*
	 * A suppressed turn must not move the clock. If it did, a busy stretch would push the next
	 * permitted line further and further out and the coach would go silent exactly when the game
	 * is at its loudest — the opposite of what a floor is for.
	 */
	it("a run of suppressed turns does not extend the silence", () => {
		const mem = newPaceMemory()
		noteSpoken(mem, 100)
		for (const t of [110, 120, 130, 140]) strictEqual(mayspeak(mem, t).speak, false)
		strictEqual(mem.lastSpokeAtSec, 100)
		strictEqual(mayspeak(mem, 145).speak, true)
	})

	it("deciding does not write — only noteSpoken does", () => {
		const mem = newPaceMemory()
		mayspeak(mem, 100)
		strictEqual(mem.lastSpokeAtSec, null)
		noteSpoken(mem, 100)
		strictEqual(mem.lastSpokeAtSec, 100)
	})
})

describe("one game, one pace", () => {
	it("reset makes the next line the first line again", () => {
		const mem = newPaceMemory()
		noteSpoken(mem, 2000)
		strictEqual(mayspeak(mem, 2010).speak, false)
		resetPaceMemory(mem)
		strictEqual(mayspeak(mem, 2010).reason, "first")
	})
})
