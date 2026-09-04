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
import {
	buildFacts,
	newFactMemory,
	FARM_COOLDOWN_SEC,
	GOLD_NAG_SEC,
	GOLD_STEP,
	MAX_FACTS
} from "./live-facts.ts"
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
		// A quiet turn in between: deaths alternate, and silence clears the alternation.
		deepStrictEqual(buildFacts(input({ nowSec: 700 }), mem), [])
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

	it("drops deaths entirely from the turn after one was offered", () => {
		const mem = newFactMemory()
		const first = buildFacts(
			input({ nowSec: 600, deadEnemies: [{ champion: "Graves", respawnSec: 30 }] }),
			mem
		)
		ok(first[0]!.includes("just died"), "nothing else was on offer, so the death leads")

		const second = buildFacts(
			input({
				nowSec: 640,
				deadEnemies: [{ champion: "Jinx", respawnSec: 30 }],
				currentGold: 1500
			}),
			mem
		)
		strictEqual(
			second.some(f => f.includes("just died")),
			false,
			"a death was offered last turn, so none may be offered this turn — demoting was not enough"
		)
		ok(second.some(f => f.includes("unspent")), "the other fact is still offered")

		// And the turn after that, deaths are available again.
		const third = buildFacts(
			input({ nowSec: 700, deadEnemies: [{ champion: "Karma", respawnSec: 30 }] }),
			mem
		)
		ok(third.some(f => f.includes("just died")), "alternation, not suppression")
	})

	it("does not suppress deaths forever through a quiet stretch", () => {
		/*
		 * Regression: the flag was only updated on non-empty turns, so after one death a game with
		 * nothing else to report would never mention another.
		 */
		const mem = newFactMemory()
		buildFacts(input({ nowSec: 600, deadEnemies: [{ champion: "Graves", respawnSec: 30 }] }), mem)
		deepStrictEqual(buildFacts(input({ nowSec: 640 }), mem), [], "nothing to say")
		const after = buildFacts(
			input({ nowSec: 700, deadEnemies: [{ champion: "Jinx", respawnSec: 30 }] }),
			mem
		)
		ok(after.some(f => f.includes("just died")), "silence must clear the alternation")
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

	it("raises persistent gold again even without a step, because persistence is the point", () => {
		/*
		 * A judge found the coach silent through six minutes of an unspent item while spending
		 * eight lines on death timers. Novel events were treated as valuable and durable state as
		 * one-shot, which is backwards — the longer it sits, the more it is worth saying.
		 */
		const mem = newFactMemory()
		ok(buildFacts(input({ nowSec: 600, currentGold: 1400 }), mem).some(f => f.includes("unspent")))
		strictEqual(
			buildFacts(input({ nowSec: 700, currentGold: 1400 }), mem).some(f => f.includes("unspent")),
			false,
			"a hundred seconds later is still nagging"
		)
		const later = buildFacts(input({ nowSec: 600 + GOLD_NAG_SEC, currentGold: 1400 }), mem)
		ok(later.some(f => f.includes("STILL unspent")), "four minutes on, it has earned a re-mention")
	})

	it("does not restate the farm gap when his CS has not moved", () => {
		/*
		 * Regression: stated three times in ten minutes with a bigger number each time, over a
		 * stretch where CS did not change at all — the deficit grew only because the expected
		 * curve rises. That is scolding someone with a number they cannot affect.
		 */
		const mem = newFactMemory()
		ok(
			buildFacts(input({ nowSec: 600, pace: { cs: 100, expected: 130, exact: true } }), mem).some(
				f => f.startsWith("FARM:")
			)
		)
		const frozen = buildFacts(
			// Long past the cooldown, bigger gap — but he has not farmed a single camp.
			input({ nowSec: 600 + FARM_COOLDOWN_SEC * 2, pace: { cs: 100, expected: 160, exact: true } }),
			mem
		)
		strictEqual(frozen.some(f => f.startsWith("FARM:")), false, "same CS, so nothing new to say")

		const moved = buildFacts(
			input({ nowSec: 600 + FARM_COOLDOWN_SEC * 2, pace: { cs: 130, expected: 175, exact: true } }),
			mem
		)
		ok(moved.some(f => f.startsWith("FARM:")), "once he has actually farmed, the gap is news again")
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
			buildFacts(
				// Past the cooldown AND he has actually farmed since — both are required.
				input({ nowSec: 600 + FARM_COOLDOWN_SEC, pace: { cs: 130, expected: 165, exact: true } }),
				mem
			).some(f => f.startsWith("FARM:")),
			"after the cooldown, with real progress, it has earned a second mention"
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

describe("buildFacts — the window", () => {
	it("calls two enemies down as a window, not as two deaths", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				deadEnemies: [
					{ champion: "Graves", respawnSec: 30 },
					{ champion: "Jinx", respawnSec: 18 }
				]
			}),
			mem
		)
		ok(out[0]!.includes("2 of them are dead"), `window should lead, got: ${out[0]}`)
		// Counted from the SHORTEST timer: the window closes when the first of them is back.
		ok(out[0]!.includes("18s"), `must use the shortest timer, got: ${out[0]}`)
	})

	it("does not call a window when one of them is already walking back", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				deadEnemies: [
					{ champion: "Graves", respawnSec: 30 },
					{ champion: "Jinx", respawnSec: 4 }
				]
			}),
			mem
		)
		strictEqual(out.some(f => f.includes("of them are dead")), false)
	})

	it("ranks a window above gold and farm", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				deadEnemies: [
					{ champion: "Graves", respawnSec: 25 },
					{ champion: "Jinx", respawnSec: 22 }
				],
				currentGold: 3000,
				pace: { cs: 100, expected: 140, exact: true }
			}),
			mem
		)
		ok(out[0]!.includes("of them are dead"))
	})
})

describe("buildFacts — ranking", () => {
	it("phrases every fact in the second person", () => {
		/*
		 * The model reads these strings aloud. When they said "HE secured the dragon" it said
		 * exactly that, in the third person, about the person it was talking to — four times in
		 * one session.
		 */
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				myEvents: [{ id: 1, name: "DragonKill" }],
				pace: { cs: 100, expected: 130, exact: true }
			}),
			mem
		)
		for (const f of out) strictEqual(/\bHE\b|\bhis\b/.test(f), false, `third person in: ${f}`)
	})

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
		ok(out[0]!.startsWith("PRAISE: you just got a triple kill"), `praise should lead, got: ${out[0]}`)
	})

	it("names a steal as a steal", () => {
		const mem = newFactMemory()
		const out = buildFacts(input({ myEvents: [{ id: 7, name: "BaronKill", stolen: true }] }), mem)
		ok(out[0]!.includes("you STOLE Baron"))
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
		strictEqual(out.filter(f => f.includes("just died")).length, 1)
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
