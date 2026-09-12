/**
 * The baseline rule is the one that has actually shipped wrong, so it is pinned first.
 *
 * Three real reviews printed a baseline they had DERIVED — `value - vsBaseline`, rounded — and
 * all three read exactly like a measurement while being off by a few units. These tests assert
 * that the debrief can only ever print digits that were already in the digest.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { baselineOf, keptLine, pickTiles, shapeLine } from "./debrief-view.ts"
import type { Metric } from "./schema/domain.ts"

const metric = (over: Partial<Metric>): Metric => ({
	key: "cs@14",
	label: "CS @14",
	value: 80,
	unit: "cs",
	band: "bad",
	vsBaseline: -21,
	confidence: "medium",
	explain: "80 CS by 14:00. Your 20-game average is 101.4 (sd 9); this game is -21.42.",
	...over
})

describe("baselineOf — copied, never computed", () => {
	it("reads the digits out of the explain sentence", () => {
		strictEqual(baselineOf(metric({})), "101.4")
	})

	it("does not round the baseline into a rounder-sounding number", () => {
		// 101.4 must not become 101. A rounded baseline still reads as a measurement.
		strictEqual(baselineOf(metric({})), "101.4")
	})

	it("never derives the baseline by subtracting the delta from the value", () => {
		// value - vsBaseline is 101.42 here, and the digest says 101.4. If this ever returns the
		// arithmetic, rule 4 has been broken in exactly the way it was broken before.
		strictEqual(baselineOf(metric({ value: 80, vsBaseline: -21.42 })), "101.4")
	})

	it("prefers the digest's own baselineText when one was carried", () => {
		strictEqual(
			baselineOf(metric({ baselineText: "your own average: 2874", explain: "irrelevant" })),
			"2874"
		)
	})

	it("returns null rather than inventing one", () => {
		strictEqual(baselineOf(metric({ explain: "4 assists." })), null)
	})
})

describe("pickTiles", () => {
	it("excludes low-confidence metrics from the three he actually reads", () => {
		const tiles = pickTiles([
			metric({ key: "interp", vsBaseline: -900, value: 10, confidence: "low" }),
			metric({ key: "solid", vsBaseline: -21, value: 80, confidence: "medium" })
		])
		deepStrictEqual(tiles.map(t => t.key), ["solid"])
	})

	it("ranks by the normalised move, so gold cannot win on unit size alone", () => {
		const tiles = pickTiles([
			metric({
				key: "goldPerMin",
				value: 395,
				vsBaseline: -24,
				unit: "gold",
				explain: "Your 20-game average is 419 (sd 30)."
			}),
			metric({
				key: "eliteControlPct",
				value: 0,
				vsBaseline: -51.3,
				unit: "%",
				explain: "Your 20-game average is 51.27 (sd 20)."
			})
		])
		strictEqual(tiles[0]?.key, "eliteControlPct")
	})

	it("does not let a metric that came out at zero win by dividing by itself", () => {
		// The instability that shipped: |vs| / |value| makes any zero-valued metric enormous, so a
		// game with no objectives ranked "0 elites smited" above a 21-CS deficit. Twice.
		const tiles = pickTiles(
			[
				metric({
					key: "elitesSecuredByUser",
					value: 0,
					vsBaseline: -3.8,
					unit: "",
					explain: "Your 20-game average is 3.8 (sd 2)."
				}),
				metric({
					key: "cs@14",
					value: 80,
					vsBaseline: -21.4,
					explain: "Your 20-game average is 101.4 (sd 9)."
				})
			],
			2
		)
		strictEqual(tiles[0]?.key, "elitesSecuredByUser", "a whole average lost is still the bigger move")
		strictEqual(tiles.length, 2)
	})

	it("never shows the same fact twice — one tile per family", () => {
		const tiles = pickTiles([
			metric({
				key: "eliteControlPct",
				value: 0,
				vsBaseline: -51.3,
				explain: "Your 20-game average is 51.27."
			}),
			metric({
				key: "elitesSecuredByUser",
				value: 0,
				vsBaseline: -3.8,
				explain: "Your 20-game average is 3.8."
			}),
			metric({ key: "cs@14", value: 80, vsBaseline: -21.4, explain: "Your 20-game average is 101.4." })
		])
		deepStrictEqual(tiles.map(t => t.key), ["eliteControlPct", "cs@14"])
	})
})

describe("shapeLine", () => {
	const objs = (enemy: number, his: number, taker = "Kayn") => [
		...Array.from({ length: enemy }, () => ({ side: "enemy" as const, takenBy: taker })),
		...Array.from({ length: his }, () => ({ side: "his" as const, takenBy: "Lillia" }))
	]

	it("names the counterpart only when he took every single one", () => {
		const line = shapeLine({ objectives: objs(9, 0), counterpartName: "Kayn", metrics: [] })
		strictEqual(line?.lead, "Nine neutral objectives in this game.")
		strictEqual(line?.turn, "All nine went to Kayn.")
		strictEqual(line?.direction, "against")
	})

	it("credits the team, not a player, when the takers were mixed", () => {
		const line = shapeLine({
			objectives: [...objs(5, 0, "Kayn"), ...objs(1, 0, "Draven")],
			counterpartName: "Kayn",
			metrics: []
		})
		strictEqual(line?.turn, "All of them went to the enemy team.")
	})

	it("counts a split honestly", () => {
		const line = shapeLine({ objectives: objs(5, 3), counterpartName: "Kayn", metrics: [] })
		strictEqual(line?.turn, "Five went to the enemy team.")
	})

	it("falls back to a copied checkpoint figure when there is no timeline", () => {
		const line = shapeLine({ objectives: [], counterpartName: null, metrics: [metric({})] })
		strictEqual(line?.turn, "Your own average is 101.4.")
	})

	it("says nothing at all rather than something empty", () => {
		strictEqual(shapeLine({ objectives: [], counterpartName: null, metrics: [] }), null)
	})
})

describe("keptLine", () => {
	const m = (over: Partial<Metric>): Metric => ({
		key: "csDelta@10",
		label: "CS diff vs opponent @10",
		value: 10,
		unit: "cs",
		band: "good",
		vsBaseline: 5,
		confidence: "medium",
		explain: "You had 68 CS at 10:00 vs 58. Your 20-game average is 5 (sd 14).",
		...over
	})

	it("counts the takedowns rather than praising the effort", () => {
		strictEqual(
			keptLine({
				metrics: [],
				counterpartTakedowns: [
					{ clock: "3:32", kind: "kill" },
					{ clock: "12:26", kind: "kill" },
					{ clock: "21:18", kind: "assist" }
				],
				counterpartName: "Kayn"
			}),
			"You killed Kayn twice — 3:32 and 12:26"
		)
	})

	it("copies the baseline into the praise too", () => {
		strictEqual(
			keptLine({ metrics: [m({})], counterpartTakedowns: [], counterpartName: "Kayn" }),
			"CS diff vs opponent @10: 10 against your own average of 5"
		)
	})

	it("says nothing rather than manufacturing a compliment", () => {
		strictEqual(
			keptLine({
				metrics: [m({ band: "bad", vsBaseline: -9 })],
				counterpartTakedowns: [{ clock: "4:00", kind: "assist" }],
				counterpartName: "Kayn"
			}),
			null
		)
	})
})

describe("keptLine does not restate a tile", () => {
	it("skips a metric already shown above it", () => {
		const m: Metric = {
			key: "xpDelta@10",
			label: "XP diff vs opponent @10",
			value: 902,
			unit: "xp",
			band: "good",
			vsBaseline: 809,
			confidence: "medium",
			explain: "Your 20-game average is 93 (sd 400)."
		}
		strictEqual(
			keptLine({ metrics: [m], counterpartTakedowns: [], counterpartName: "Kayn", excludeKeys: ["xpDelta@10"] }),
			null
		)
	})
})
