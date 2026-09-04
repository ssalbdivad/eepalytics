/**
 * The live coach's quality is decided here, so it is pinned here.
 *
 * Every case below is a failure a judge found in a real session and a structural rule that was
 * added to stop it. They are not hypotheticals: "the same corpse announced on every poll" and
 * "chose a fourth Morgana timer over an explicit unspent-gold flag beside it" both happened, and
 * both are one regression away from happening again.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { buildFacts, newFactMemory, FARM_COOLDOWN_SEC, GOLD_STEP, MAX_FACTS } from "./live-facts.ts"
import type { FactInput } from "./live-facts.ts"

const input = (over: Partial<FactInput> = {}): FactInput => ({
	nowSec: 600,
	deadEnemies: [],
	currentGold: null,
	pace: null,
	myEvents: [],
	sinceDrakeSec: null,
	sinceBaronSec: null,
	...over
})

describe("buildFacts — deaths", () => {
	it("announces a death once, not on every poll", () => {
		const mem = newFactMemory()
		const dead = [{ champion: "Graves", respawnSec: 30 }]
		const first = buildFacts(input({ nowSec: 600, deadEnemies: dead }), mem)
		ok(first.some(f => f.includes("Graves")), "first sighting should be announced")

		// Five seconds later the same corpse has 25s left — the SAME death, not a new one.
		const second = buildFacts(
			input({ nowSec: 605, deadEnemies: [{ champion: "Graves", respawnSec: 25 }] }),
			mem
		)
		strictEqual(
			second.some(f => f.includes("Graves")),
			false,
			"the same death must not be announced twice"
		)
	})

	it("treats a second death of the same champion as new", () => {
		const mem = newFactMemory()
		buildFacts(input({ nowSec: 600, deadEnemies: [{ champion: "Graves", respawnSec: 30 }] }), mem)
		// Much later, a different death: the respawn instant is far from the first one.
		const later = buildFacts(
			input({ nowSec: 900, deadEnemies: [{ champion: "Graves", respawnSec: 30 }] }),
			mem
		)
		ok(later.some(f => f.includes("Graves")), "a genuinely new death must be announced")
	})

	it("ignores a death that will be over before it can be said", () => {
		const mem = newFactMemory()
		const out = buildFacts(input({ deadEnemies: [{ champion: "Jinx", respawnSec: 5 }] }), mem)
		deepStrictEqual(out, [])
	})

	it("never leads with a death two turns running", () => {
		const mem = newFactMemory()
		const first = buildFacts(
			input({ nowSec: 600, deadEnemies: [{ champion: "Graves", respawnSec: 30 }] }),
			mem
		)
		ok(first[0]!.includes("JUST died"), "nothing else was on offer, so the death leads")

		const second = buildFacts(
			input({
				nowSec: 640,
				deadEnemies: [{ champion: "Jinx", respawnSec: 30 }],
				currentGold: 1500
			}),
			mem
		)
		strictEqual(
			second[0]!.includes("JUST died"),
			false,
			"a death led last turn, so something else must lead this one"
		)
	})
})

describe("buildFacts — rate limiting", () => {
	it("mentions gold once, then only after another step", () => {
		const mem = newFactMemory()
		ok(buildFacts(input({ currentGold: 1300 }), mem).some(f => f.includes("unspent")))
		strictEqual(
			buildFacts(input({ currentGold: 1400 }), mem).some(f => f.includes("unspent")),
			false,
			"a hundred more gold is not news"
		)
		ok(
			buildFacts(input({ currentGold: 1300 + GOLD_STEP }), mem).some(f => f.includes("unspent")),
			"a full step later it is news again"
		)
	})

	it("forgets gold after a recall", () => {
		const mem = newFactMemory()
		buildFacts(input({ currentGold: 1500 }), mem)
		buildFacts(input({ currentGold: 200 }), mem) // spent it
		ok(
			buildFacts(input({ currentGold: 1300 }), mem).some(f => f.includes("unspent")),
			"after spending, the next accumulation is news"
		)
	})

	it("mentions the farm gap once, then not for minutes", () => {
		const mem = newFactMemory()
		const pace = { cs: 100, expected: 130, exact: true }
		ok(buildFacts(input({ nowSec: 600, pace }), mem).some(f => f.startsWith("FARM:")))
		strictEqual(
			buildFacts(input({ nowSec: 660, pace }), mem).some(f => f.startsWith("FARM:")),
			false,
			"a minute later is nagging"
		)
		ok(
			buildFacts(input({ nowSec: 600 + FARM_COOLDOWN_SEC, pace }), mem).some(f =>
				f.startsWith("FARM:")
			),
			"after the cooldown it has earned a second mention"
		)
	})

	it("says nothing about farm when the gap is small", () => {
		const mem = newFactMemory()
		deepStrictEqual(buildFacts(input({ pace: { cs: 100, expected: 104, exact: true } }), mem), [])
	})

	it("marks an interpolated farm reading as approximate", () => {
		const mem = newFactMemory()
		const out = buildFacts(input({ pace: { cs: 100, expected: 130, exact: false } }), mem)
		ok(out[0]!.includes("approximate"), "a between-checkpoints reading must carry its hedge")
	})
})

describe("buildFacts — ranking", () => {
	it("puts praise above everything, including a fresh death", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				myEvents: [{ id: 1, name: "ChampionKill", killStreak: 3 }],
				deadEnemies: [{ champion: "Graves", respawnSec: 30 }],
				currentGold: 2000
			}),
			mem
		)
		ok(out[0]!.startsWith("HE just got a triple kill"), `praise should lead, got: ${out[0]}`)
	})

	it("names a steal as a steal", () => {
		const mem = newFactMemory()
		const out = buildFacts(input({ myEvents: [{ id: 7, name: "BaronKill", stolen: true }] }), mem)
		ok(out[0]!.includes("STOLE Baron"))
	})

	it("announces each event once", () => {
		const mem = newFactMemory()
		const ev = [{ id: 42, name: "DragonKill" }]
		ok(buildFacts(input({ myEvents: ev }), mem).length > 0)
		deepStrictEqual(buildFacts(input({ myEvents: ev }), mem), [])
	})

	it("offers at most one death even when four people are dead", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				deadEnemies: [
					{ champion: "Graves", respawnSec: 30 },
					{ champion: "Jinx", respawnSec: 28 },
					{ champion: "Karma", respawnSec: 25 },
					{ champion: "Katarina", respawnSec: 22 }
				]
			}),
			mem
		)
		strictEqual(out.filter(f => f.includes("JUST died")).length, 1)
	})

	it("never offers more than the cap", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				myEvents: [{ id: 1, name: "ChampionKill", killStreak: 2 }],
				pace: { cs: 100, expected: 140, exact: true },
				currentGold: 3000,
				deadEnemies: [{ champion: "Graves", respawnSec: 30 }],
				sinceDrakeSec: 200,
				sinceBaronSec: 400
			}),
			mem
		)
		ok(out.length <= MAX_FACTS, `expected at most ${MAX_FACTS}, got ${out.length}`)
	})

	it("says nothing when there is nothing — PASS is a real answer", () => {
		deepStrictEqual(buildFacts(input(), newFactMemory()), [])
	})
})
