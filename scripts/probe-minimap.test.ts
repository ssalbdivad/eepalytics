/**
 * The scorer of `probe-minimap.ts`, pinned — a probe whose scorer is wrong produces a number that
 * looks measured.
 *
 * It lived in `src/review/frame-read.test.ts` back when `pnpm test` ran the `src` glob alone. The
 * glob now covers `scripts/**` too, so the check lives beside the probe it checks and the `src`
 * tree no longer reaches into `scripts/` to keep a harness alive.
 *
 * Two of the four things below are the probe's own ground truth and not its arithmetic:
 * `truthFromBlock` reads the DAEMON's block, which the model never saw, and `handZones` turns the
 * author's recorded clicks into zones via `shared/map.ts` rather than a typed-in name. A silent
 * no-match in either scores every read against a truth of zeroes and reports a fabrication rate of
 * zero — a measurement that looks clean because it measured nothing.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { blockClockSec, handZones, matchIcons, pct, truthFromBlock } from "./probe-minimap.ts"

/**
 * A block the DAEMON wrote, copied out of `journal_frame.truthJson` and trimmed to the lines the
 * regexes touch. Hand-typed text can only prove a regex matches a shape its author had in mind.
 */
const REAL_BLOCK = `## Ground truth (from the game client — these are FACTS, the screenshot is not)

Clock 11:06.

You: Lillia lv8 2/2/1, 70 CS, 1641/1641 HP, 101 gold

Your team: Qiyana lv10 3/1/1 · Vel'Koz lv9 2/0/0 · Caitlyn lv7 1/3/0 · Leona lv7 0/2/2

Enemy team: Teemo lv8 2/4/0 · Kayn lv8 0/1/3 · Nasus lv9 1/2/0 · Yunara lv7 3/1/2 · Anivia lv7 2/0/3

Alive right now: 5 of yours against 4 of theirs.
`

describe("truthFromBlock", () => {
	it("reads the fence's facts off a block the daemon really wrote", () => {
		deepStrictEqual(truthFromBlock(REAL_BLOCK), {
			myChampion: "Lillia",
			meDead: false,
			enemiesAlive: 4,
			// "5 of yours" counts HIM, so four teammates are left to draw beside him.
			alliesAlive: 4,
			enemyChampions: ["Teemo", "Kayn", "Nasus", "Yunara", "Anivia"]
		})
	})

	it("keeps a two-word champion whole", () => {
		const block = REAL_BLOCK.replace("You: Lillia lv8", "You: Dr. Mundo lv8")
		strictEqual(truthFromBlock(block)?.myChampion, "Dr. Mundo")
	})

	it("does not subtract him from his own team when he is dead", () => {
		const block = REAL_BLOCK.replace(
			"101 gold",
			"101 gold, DEAD (respawn in 6 seconds)"
		).replace("5 of yours", "4 of yours")
		const truth = truthFromBlock(block)
		strictEqual(truth?.meDead, true)
		strictEqual(truth?.alliesAlive, 4)
	})

	/*
	 * Null, never a default. A silent no-match would score every read against a truth of zeroes and
	 * report a fabrication rate of zero — a measurement that looks clean because it measured nothing.
	 */
	it("returns null rather than zeroes when a line it needs is missing", () => {
		strictEqual(truthFromBlock("Clock 11:06."), null)
		strictEqual(truthFromBlock(REAL_BLOCK.replace(/^Alive right now.*$/m, "")), null)
	})

	it("reads the clock line the daemon writes", () => {
		strictEqual(blockClockSec(REAL_BLOCK), 11 * 60 + 6)
		strictEqual(blockClockSec("no clock here"), null)
	})
})

describe("handZones", () => {
	it("turns a click into a zone with map.ts rather than a typed-in name", () => {
		const hand = handZones("js-mtn2jrku-8ae9-13792")
		deepStrictEqual(hand?.enemies, ["RIVER_TOP", "LANE_MID"])
		strictEqual(hand?.you, "ENEMY_JUNGLE_TOP")
	})

	it("has nothing to say about a frame nobody labelled", () => {
		strictEqual(handZones("js-nope-1"), null)
	})
})

describe("matchIcons", () => {
	it("pairs each sighting with the nearest label, once", () => {
		const got = [{ x: 500, y: 500 }, { x: 200, y: 200 }]
		const matched = matchIcons(got, [[20, 20], [50, 50]])
		deepStrictEqual(matched.map(m => Math.round(m.error)), [0, 0])
		deepStrictEqual(matched.map(m => m.zone), ["LANE_MID", "OWN_JUNGLE_TOP"])
	})

	/*
	 * A sighting with nothing left to match is NOT scored as a huge distance. It is already counted
	 * as a wrong count, and charging it twice would move the median by how many icons happened to be
	 * on the map rather than by how well they were placed.
	 */
	it("stops when the labels run out rather than inventing a distance", () => {
		strictEqual(matchIcons([{ x: 500, y: 500 }, { x: 100, y: 100 }], [[50, 50]]).length, 1)
		strictEqual(matchIcons([{ x: 500, y: 500 }], []).length, 0)
	})
})

describe("pct", () => {
	it("says n/a rather than dividing by nothing", () => {
		strictEqual(pct(0, 0), "n/a")
		strictEqual(pct(3, 4), "3/4 (75%)")
	})
})
