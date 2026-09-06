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
	DEATH_FACT,
	GOLD_MIN_HELD_SEC,
	newFactMemory,
	FARM_COOLDOWN_SEC,
	FRAME_FRESH_SEC,
	GOLD_NAG_SEC,
	GOLD_STEP,
	MAX_FACTS,
	MIN_GAP_SEC,
	OBJECTIVE_START_WINDOW_SEC,
	ROUTINE_GAP_SEC,
	TREND_VETO_SEC,
	CLOCK_BACK_SEC,
	SOCKET_PIPE_SEC,
	TURN_PIPE_SEC,
	WINDOW_MIN_SEC
} from "./live-facts.ts"
import type { FactInput, FactMemory, FactTrace } from "./live-facts.ts"
import { premiseOf, speechDurationSec } from "./timeliness.ts"
import { SCHEDULE_UNCONTESTED_SEC } from "../shared/live-state.ts"

/**
 * A countdown as this file will SPEAK it: the raw figure minus the pipe — the provider's latency
 * plus however long the sentence takes to say.
 *
 * Written out rather than hard-coded, so every assertion below states the RULE ("the number he can
 * act on when he hears it") instead of pinning a digit that moves the moment a word in the sentence
 * changes. The argument is a renderer because the sentence's own length is part of the arithmetic:
 * the rotation line is four syllables longer than the plain timer and therefore costs more.
 */
const heard = (raw: number, line: (n: number) => string, pipeSec = SOCKET_PIPE_SEC): number =>
	Math.round(raw - pipeSec - speechDurationSec(line(Math.round(raw))))

/**
 * Let gold sit long enough to be worth saying, then return the tick at which it is.
 *
 * Gold requires GOLD_MIN_HELD_SEC of holding before it is ever BUILT — the amount is on his HUD
 * and only the duration is news. It is never offered any more (see `recall-and-spend` below), so
 * this now primes the tests that assert on what the ranker builds and refuses.
 */
const holdGold = (mem: FactMemory, gold: number, crossedAt: number): number => {
	buildFacts(input({ nowSec: crossedAt, currentGold: gold }), mem)
	return crossedAt + GOLD_MIN_HELD_SEC
}

/**
 * Every fact BUILT this turn and what became of it — the only way to assert on a banned family.
 *
 * A ban is a rejection rather than a missing `push` precisely so it stays visible here: a family
 * that is simply deleted looks identical to a threshold that never fired, which is the confusion
 * `FactOptions.trace` was added to end.
 */
const built = (i: FactInput, mem: FactMemory): FactTrace[] => {
	const out: FactTrace[] = []
	buildFacts(i, mem, { trace: r => out.push(r) })
	return out
}

/**
 * A standing objective, which is what the tests below reach for when they need "some other slow
 * fact" to sit beside the one under test.
 *
 * It used to be an unspent-gold line. Gold is banned now, so a test that used it as scenery was
 * asserting on a family that can no longer speak — and every one of those failures looked like a
 * bug in the rule actually being tested.
 */
const slow = (name = "Baron", atSec = 300, heldSec = SCHEDULE_UNCONTESTED_SEC + 60) => ({
	standing: [{ name, atSec, heldSec }]
})
const SLOW_LINE = /nobody has taken it/

const input = (over: Partial<FactInput> = {}): FactInput => ({
	nowSec: 600,
	meDeadForSec: null,
	alliesAlive: 5,
	enemiesAlive: 5,
	deadEnemies: [],
	currentGold: null,
	pace: null,
	enemyObjectives: [],
	counterpart: null,
	myEvents: [],
	drakeBackInSec: null,
	baronBackInSec: null,
	heraldBackInSec: null,
	...over
})

describe("buildFacts — deaths", () => {
	it("announces a death once, not on every poll", () => {
		const mem = newFactMemory()
		const dead = [{ champion: "Graves", respawnSec: 30, isJungler: true }]
		const first = buildFacts(input({ nowSec: 600, deadEnemies: dead }), mem)
		ok(first.some(f => f.includes("Graves")), "first sighting should be announced")

		// Five seconds later the same corpse has 25s left — the SAME death, not a new one.
		const second = buildFacts(
			input({ nowSec: 605, deadEnemies: [{ champion: "Graves", respawnSec: 25, isJungler: true }] }),
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
		buildFacts(input({ nowSec: 600, deadEnemies: [{ champion: "Graves", respawnSec: 30, isJungler: true }] }), mem)
		// A quiet turn in between: deaths alternate, and silence clears the alternation.
		deepStrictEqual(buildFacts(input({ nowSec: 700 }), mem), [])
		// Much later, a different death: the respawn instant is far from the first one.
		const later = buildFacts(
			input({ nowSec: 900, deadEnemies: [{ champion: "Graves", respawnSec: 30, isJungler: true }] }),
			mem
		)
		ok(later.some(f => f.includes("Graves")), "a genuinely new death must be announced")
	})

	it("ignores a death that will be over before it can be said", () => {
		const mem = newFactMemory()
		const out = buildFacts(input({ deadEnemies: [{ champion: "Jinx", respawnSec: 5, isJungler: true }] }), mem)
		deepStrictEqual(out, [])
	})

	it("drops deaths entirely from the turn after one was offered", () => {
		const mem = newFactMemory()
		holdGold(mem, 1500, 400)
		const first = buildFacts(
			// Gold stays present across both turns; dropping it would reset the hold clock.
			input({
				nowSec: 600,
				currentGold: 1500,
				deadEnemies: [{ champion: "Graves", respawnSec: 30, isJungler: true }]
			}),
			mem
		)
		// Asserts PRESENCE, not position: gold is primed here so the next turn has an alternative,
		// and which of the two ranks higher is a different test's business.
		ok(first.some(f => DEATH_FACT.test(f)), `the death should be offered: ${first.join(" | ")}`)

		/*
		 * MIN_GAP_SEC later, which is the earliest anything at all may follow, and the alternative
		 * is an objective timer rather than a farm or gold line: inside ROUTINE_GAP_SEC nothing
		 * standing may be offered either, so only another expiring fact can prove that the death
		 * was dropped for being a repeat rather than for being early.
		 */
		const secondAt = 600 + MIN_GAP_SEC
		const second = buildFacts(
			input({
				nowSec: secondAt,
				deadEnemies: [{ champion: "Jinx", respawnSec: 30, isJungler: true }],
				baronBackInSec: 40
			}),
			mem
		)
		strictEqual(
			second.some(f => DEATH_FACT.test(f)),
			false,
			"a death was offered last turn, so none may be offered this turn — demoting was not enough"
		)
		ok(second.some(f => f.includes("Baron")), `the other fact is still offered: ${second.join(" | ")}`)

		// And once the subject bar has expired, deaths are available again.
		const third = buildFacts(
			input({
				nowSec: secondAt + ROUTINE_GAP_SEC,
				deadEnemies: [{ champion: "Karma", respawnSec: 30, isJungler: true }]
			}),
			mem
		)
		ok(third.some(f => DEATH_FACT.test(f)), "alternation, not suppression")
	})

	it("does not suppress deaths forever, but a quiet turn is not what lifts the bar", () => {
		/*
		 * Regression, both ways round. The bar must lift — after one death, a game with nothing
		 * else to report used to go silent about deaths for good — and it must NOT lift merely
		 * because a turn in between had nothing to say. At the shipped twenty-second turn the coach
		 * is empty on most turns, so clearing the bar on silence made it unreachable: measured on a
		 * real game, two "two of them are dead" lines forty-nine seconds apart went straight
		 * through it. The clock lifts the bar; an empty turn does not.
		 */
		const mem = newFactMemory()
		buildFacts(input({ nowSec: 600, deadEnemies: [{ champion: "Graves", respawnSec: 30, isJungler: true }] }), mem)
		deepStrictEqual(buildFacts(input({ nowSec: 640 }), mem), [], "nothing to say")
		deepStrictEqual(
			buildFacts(
				input({ nowSec: 700, deadEnemies: [{ champion: "Jinx", respawnSec: 30, isJungler: true }] }),
				mem
			),
			[],
			"a hundred seconds later is still the same subject twice"
		)
		const after = buildFacts(
			input({
				nowSec: 600 + ROUTINE_GAP_SEC,
				deadEnemies: [{ champion: "Jinx", respawnSec: 30, isJungler: true }]
			}),
			mem
		)
		ok(after.some(f => DEATH_FACT.test(f)), "the clock lifts the bar")
	})
})

describe("buildFacts — rate limiting", () => {
	/*
	 * THE GOLD BAN, and it is the cleanest one in this file because it is a count rather than a
	 * judgement.
	 *
	 * Across both blind rounds 102 lines whose imperative was of the recall-and-spend family were
	 * graded and NOT ONE cleared the bar. In the round-3 sheet alone that is 13 lines over four
	 * directive labels — recall-and-spend, spend-gold-and-clear, spend-gold-while-dead,
	 * recall-before-baron — and zero clears from either of two independent judges.
	 *
	 * The premise was never the problem: the duration really is invisible, and the hold gate below
	 * still measures it. It is the ACTION. He knows to spend gold, so the instruction is one he
	 * would have given himself, and this family has no other instruction to give.
	 *
	 * What went with the ban, recorded so nobody re-derives it as a regression: the step rule
	 * (GOLD_STEP), the persistence re-mention (GOLD_NAG_SEC), the per-game cap and the
	 * count-from-the-crossing arithmetic are all spent in `commit`, which runs only when a fact is
	 * OFFERED. A banned fact is never offered, so all four are unreachable while the ban stands and
	 * cannot be asserted through any public seam. They are still in `live-facts.ts`, unchanged, so
	 * lifting the ban restores them intact.
	 */
	it("builds the gold line once it has been held, and refuses it", () => {
		const mem = newFactMemory()
		const early = built(input({ nowSec: 300, currentGold: 1300 }), mem)
		strictEqual(
			early.some(r => r.subject === "gold"),
			false,
			"crossing the threshold is not news; sitting on it is"
		)
		const held = built(input({ nowSec: 300 + GOLD_MIN_HELD_SEC, currentGold: 1300 }), mem)
		const gold = held.filter(r => r.subject === "gold")
		strictEqual(gold.length, 1, JSON.stringify(held))
		ok(gold[0]!.text.includes("1300 gold sitting unspent"), gold[0]!.text)
		strictEqual(gold[0]!.reason, "recall-and-spend", "built, traced, and refused by name")
	})

	it("never says anything about gold, however long it sits", () => {
		const mem = newFactMemory()
		const said: string[] = []
		for (let t = 300; t <= 2400; t += 20)
			said.push(...buildFacts(input({ nowSec: t, currentGold: 1300 + t }), mem))
		strictEqual(
			said.filter(f => /gold/.test(f)).length,
			0,
			`gold is retired: ${said.join(" | ")}`
		)
	})

	it("does not even build a gold line while he is standing in the shop", () => {
		/*
		 * MEASURED, and it survives the ban because `stranded` gates the BUILD rather than the
		 * offer: the one `impossible` gold verdict in four games is "he spent it: 373 gold when it
		 * lands, was told 2511" — built while he was in the fountain buying. Nothing in the client
		 * says so; the frame does.
		 */
		const mem = newFactMemory()
		const at = holdGold(mem, 2000, 400)
		strictEqual(
			built(
				input({ nowSec: at, currentGold: 2000, frame: { where: "base", atSec: at, confidence: "medium" } }),
				mem
			).some(r => r.subject === "gold"),
			false
		)
		// Delayed, never deleted: the clock kept running, so the fact is back the moment he walks out.
		ok(built(input({ nowSec: at + 60, currentGold: 2000 }), mem).some(r => r.subject === "gold"))
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
				f => /CS (down|up) on your own pace/.test(f)
			)
		)
		const frozen = buildFacts(
			// Long past the cooldown, bigger gap — but he has not farmed a single camp.
			input({ nowSec: 600 + FARM_COOLDOWN_SEC * 2, pace: { cs: 100, expected: 160, exact: true } }),
			mem
		)
		strictEqual(frozen.some(f => /CS (down|up) on your own pace/.test(f)), false, "same CS, so nothing new to say")

		const moved = buildFacts(
			input({ nowSec: 600 + FARM_COOLDOWN_SEC * 2, pace: { cs: 130, expected: 175, exact: true } }),
			mem
		)
		ok(moved.some(f => /CS (down|up) on your own pace/.test(f)), "once he has actually farmed, the gap is news again")
	})

	it("mentions the farm gap once, then not for minutes", () => {
		const mem = newFactMemory()
		const pace = { cs: 100, expected: 130, exact: true }
		ok(buildFacts(input({ nowSec: 600, pace }), mem).some(f => /CS (down|up) on your own pace/.test(f)))
		strictEqual(
			buildFacts(input({ nowSec: 660, pace }), mem).some(f => /CS (down|up) on your own pace/.test(f)),
			false,
			"a minute later is nagging"
		)
		/*
		 * Past the cooldown, and he HAS farmed thirty CS since — and it still says nothing, because
		 * the gap is 35 where it was 30. That reversal is deliberate. Over a real 36-minute game the
		 * old rule produced "you're 27 CS down on your own pace", then 29, then 29, then 26, then
		 * 40: five lines saying the same thing, because his CS always moves and the expected curve
		 * always rises with it. A restatement has to be WORSE NEWS, not later news.
		 */
		strictEqual(
			buildFacts(
				input({ nowSec: 600 + FARM_COOLDOWN_SEC, pace: { cs: 130, expected: 165, exact: true } }),
				mem
			).some(f => /CS (down|up) on your own pace/.test(f)),
			false,
			"the same gap restated is the same sentence, however much time has passed"
		)
		ok(
			buildFacts(
				input({
					nowSec: 600 + FARM_COOLDOWN_SEC * 2,
					pace: { cs: 130, expected: 175, exact: true }
				}),
				mem
			).some(f => /CS (down|up) on your own pace/.test(f)),
			"a gap that has genuinely got worse is news again"
		)
	})

	it("says nothing about farm when the gap is small", () => {
		const mem = newFactMemory()
		deepStrictEqual(buildFacts(input({ pace: { cs: 100, expected: 104, exact: true } }), mem), [])
	})

	it("marks an interpolated farm reading as approximate", () => {
		const mem = newFactMemory()
		const out = buildFacts(input({ pace: { cs: 100, expected: 130, exact: false } }), mem)
		ok(out[0]!.includes("roughly"), "a between-checkpoints reading must carry its hedge")
	})
})

describe("buildFacts — the window", () => {
	it("subtracts his own respawn from the window he is offered", () => {
		/*
		 * Regression: told a corpse "two are down, you have about 14s" while his own respawn was
		 * 19s — he came back after they did, so the window did not exist. His timer was in the
		 * block the whole time and was simply never read.
		 */
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				meDeadForSec: 8,
				deadEnemies: [
					{ champion: "Graves", respawnSec: 30, isJungler: true },
					{ champion: "Jinx", respawnSec: 28, isJungler: true }
				]
			}),
			mem
		)
		/*
		 * The figure is the one that will be true when the sentence FINISHES: what is left of the
		 * shorter respawn after the LATER of his own feet and the last syllable. A line that quotes
		 * the state it was computed from is a line that was true for nobody.
		 *
		 * His own respawn is no longer named — it is the biggest number on the screen he is looking
		 * at, and the nine words cost 1.7 seconds of the window they described. The regression this
		 * test was written for is the SUBTRACTION, which is asserted, not the naming.
		 */
		const said = (left: number): string => `2 of them are dead — you have about ${left} seconds`
		const pipe = SOCKET_PIPE_SEC + speechDurationSec(said(20))
		deepStrictEqual(out[0], said(Math.round(28 - Math.max(8, pipe))))
	})

	it("says nothing when he respawns after they do", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				meDeadForSec: 19,
				deadEnemies: [
					{ champion: "Graves", respawnSec: 22, isJungler: true },
					{ champion: "Jinx", respawnSec: 20, isJungler: true }
				]
			}),
			mem
		)
		strictEqual(
			out.some(f => f.includes("of them are dead")),
			false,
			"a window he cannot reach is not a window"
		)
	})

	it("drops a single death that ends before he is back up", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({ meDeadForSec: 20, deadEnemies: [{ champion: "Graves", respawnSec: 25, isJungler: true }] }),
			mem
		)
		deepStrictEqual(out, [])
	})

	it("calls two enemies down as a window, not as two deaths", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				deadEnemies: [
					{ champion: "Graves", respawnSec: 30, isJungler: true },
					{ champion: "Jinx", respawnSec: 18, isJungler: true }
				]
			}),
			mem
		)
		ok(out[0]!.includes("2 of them are dead"), `window should lead, got: ${out[0]}`)
		// Counted from the SHORTEST timer — the window closes when the first of them is back — and
		// then from the moment he can act on it, which is when the sentence has finished.
		const said = (left: number): string => `2 of them are dead — you have about ${left} seconds`
		strictEqual(out[0], said(heard(18, said)))
	})

	it("does not call a window when one of them is already walking back", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				deadEnemies: [
					{ champion: "Graves", respawnSec: 30, isJungler: true },
					{ champion: "Jinx", respawnSec: 4, isJungler: true }
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
					{ champion: "Graves", respawnSec: 25, isJungler: true },
					{ champion: "Jinx", respawnSec: 22, isJungler: true }
				],
				currentGold: 3000,
				pace: { cs: 100, expected: 140, exact: true }
			}),
			mem
		)
		ok(out[0]!.includes("of them are dead"))
	})
})

describe("buildFacts — outnumbered", () => {
	it("offers no window when his team is dead and theirs is not", () => {
		/*
		 * Regression: "Graves just died — down for 21s" while all four teammates were dead against
		 * four living enemies. Every word true; "here's your window" is how someone walks into a
		 * 1v4. A window is only a window if he can take it.
		 */
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				alliesAlive: 1,
				enemiesAlive: 4,
				deadEnemies: [{ champion: "Graves", respawnSec: 21, isJungler: true }]
			}),
			mem
		)
		strictEqual(out.some(f => DEATH_FACT.test(f)), false)
	})

	it("still offers a window when the teams are even", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				alliesAlive: 4,
				enemiesAlive: 4,
				deadEnemies: [{ champion: "Graves", respawnSec: 21, isJungler: true }]
			}),
			mem
		)
		ok(out.some(f => DEATH_FACT.test(f)))
	})

	it("still says the things he can act on alone", () => {
		/*
		 * Being outnumbered suppresses the facts that send him at somebody — a window, a free
		 * jungle, a pit with bodies in it. It does not make an objective standing untaken for four
		 * minutes less true, and that is a fact about the map rather than an instruction to walk
		 * into four people.
		 *
		 * This used to assert on an unspent-gold line, which is banned now; the rule under test was
		 * never about gold.
		 */
		const mem = newFactMemory()
		const out = buildFacts(input({ nowSec: 600, alliesAlive: 1, enemiesAlive: 4, ...slow() }), mem)
		ok(out.some(f => SLOW_LINE.test(f)), `got: ${out.join(" | ")}`)
	})
})

describe("buildFacts — objectives", () => {
	it("calls an objective that is coming back soon, at the number he will hear", () => {
		/*
		 * MEASURED: "Drake is back in 48 seconds" was 35 seconds away by the time its last syllable
		 * landed, and "back in 24" was 12. The timer is on his HUD, so a call that disagrees with
		 * the number in front of him is worse than no call — and the correction is arithmetic.
		 */
		const mem = newFactMemory()
		const plain = (n: number): string => `Baron is back in ${n} seconds`
		const out = buildFacts(input({ baronBackInSec: 40 }), mem)
		ok(out.some(f => f.includes(plain(heard(40, plain)))), `got: ${out.join(" | ")}`)
		ok(out.every(f => !f.includes(plain(40))), `the raw figure is already wrong: ${out.join(" | ")}`)
	})

	it("stays quiet about one that is minutes away", () => {
		const mem = newFactMemory()
		deepStrictEqual(buildFacts(input({ drakeBackInSec: 240 }), mem), [])
	})

	it("says NOW rather than counting down to zero", () => {
		const mem = newFactMemory()
		const out = buildFacts(input({ drakeBackInSec: 3 }), mem)
		ok(out.some(f => f.includes("Drake is up NOW")))
	})

	it("does not repeat the same objective window every turn", () => {
		const mem = newFactMemory()
		ok(buildFacts(input({ nowSec: 600, baronBackInSec: 50 }), mem).length > 0)
		// Ten seconds later it is the SAME window, forty seconds out.
		deepStrictEqual(buildFacts(input({ nowSec: 610, baronBackInSec: 40 }), mem), [])
	})

	it("ranks an objective above farm and gold", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				baronBackInSec: 30,
				currentGold: 3000,
				pace: { cs: 100, expected: 140, exact: true }
			}),
			mem
		)
		ok(out[0]!.includes("Baron"), `got: ${out[0]}`)
	})
})

describe("buildFacts — every string is a script", () => {
	it("emits nothing a person would not say out loud", () => {
		/*
		 * The coach reads these verbatim. It once said "Praise, you just got a double kill!" —
		 * reading an internal label aloud — and "14 camps AHEAD of your own pace (193 vs your
		 * usual 179)", parenthetical and shouting included, while dropping the hedge that trailed
		 * after it.
		 */
		/*
		 * Each turn is a full ROUTINE_GAP_SEC after the last, because the point of this test is the
		 * WORDING of every kind of line and the global floor would otherwise withhold most of them.
		 * Turns packed together prove the budget, not the script.
		 */
		const mem = newFactMemory()
		const t = [600, 600 + ROUTINE_GAP_SEC, 600 + ROUTINE_GAP_SEC * 2, 600 + ROUTINE_GAP_SEC * 3]
		/*
		 * A standing objective rides along where an unspent-gold line used to. Gold is banned, so a
		 * turn primed with gold now contributes no line at all and this test would have been
		 * checking the wording of three sentences while claiming to check four.
		 */
		const out = [
			...buildFacts(
				input({
					nowSec: t[0],
					myEvents: [{ id: 1, name: "DragonKill", stolen: true }]
				}),
				mem
			),
			...buildFacts(
				input({ nowSec: t[1], pace: { cs: 193, expected: 169, exact: false } }),
				mem
			),
			...buildFacts(input({ nowSec: t[2], ...slow() }), mem),
			...buildFacts(
				input({
					nowSec: t[3],
					deadEnemies: [{ champion: "Graves", respawnSec: 30, isJungler: true }]
				}),
				mem
			)
		]
		ok(out.length >= 4, `expected several facts, got ${out.length}`)
		for (const f of out) {
			strictEqual(/^[A-Z]+:/.test(f), false, `internal label in: ${f}`)
			strictEqual(/\(/.test(f), false, `parenthetical in: ${f}`)
			strictEqual(/\b[A-Z]{4,}\b/.test(f), false, `shouting in: ${f}`)
		}
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

	it("never lets praise displace a fact", () => {
		/*
		 * A dragon, a baron and a multi-kill are announced by the game itself — banner and sound —
		 * so praising them adds no information. Their value is warmth, and warmth must not cost a
		 * fact: a judge found the coach congratulating him on a banner he was watching on a tick
		 * that also carried "12 CS behind your own pace", the one thing he could not see.
		 */
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				myEvents: [{ id: 1, name: "ChampionKill", killStreak: 3 }],
				currentGold: 2000,
				pace: { cs: 100, expected: 130, exact: true }
			}),
			mem
		)
		strictEqual(/just got a/.test(out[0]!), false, `a fact must lead, got: ${out[0]}`)
		ok(out.some(f => /just got a/.test(f)), "but the praise is still offered")
	})

	it("offers praise when nothing else is on the table", () => {
		const mem = newFactMemory()
		const out = buildFacts(input({ myEvents: [{ id: 1, name: "BaronKill" }] }), mem)
		ok(out[0]! === "you secured Baron", `got: ${out[0]}`)
	})

	it("never repeats the same congratulation", () => {
		const mem = newFactMemory()
		ok(buildFacts(input({ myEvents: [{ id: 1, name: "DragonKill" }] }), mem).length > 0)
		// A second dragon is a second event, but it is the same sentence.
		deepStrictEqual(buildFacts(input({ myEvents: [{ id: 2, name: "DragonKill" }] }), mem), [])
	})

	it("does not read his own kill back to him", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({ deadEnemies: [{ champion: "Renekton", respawnSec: 30, killedByMe: true }] }),
			mem
		)
		deepStrictEqual(out, [], "he was there — that is a readback, not scouting")
	})

	it("names a steal as a steal", () => {
		const mem = newFactMemory()
		const out = buildFacts(input({ myEvents: [{ id: 7, name: "BaronKill", stolen: true }] }), mem)
		ok(out[0]!.includes("you stole Baron"))
	})

	it("announces each event once", () => {
		const mem = newFactMemory()
		const ev = [{ id: 42, name: "DragonKill" }]
		ok(buildFacts(input({ myEvents: ev }), mem).length > 0)
		deepStrictEqual(buildFacts(input({ myEvents: ev }), mem), [])
	})

	it("collapses four dead enemies into one window, not four timers", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				deadEnemies: [
					{ champion: "Graves", respawnSec: 30, isJungler: true },
					{ champion: "Jinx", respawnSec: 28, isJungler: true },
					{ champion: "Karma", respawnSec: 25 },
					{ champion: "Katarina", respawnSec: 22 }
				]
			}),
			mem
		)
		/*
		 * Four dead is a window, and a window is offered ALONE — there is no list to count deaths
		 * in. That is the stronger version of "at most one death": zero, plus the thing that
		 * actually matters.
		 */
		strictEqual(out.length, 1)
		ok(out[0]!.includes("of them are dead"), `got: ${out[0]}`)
	})

	it("never offers more than the cap", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				myEvents: [{ id: 1, name: "ChampionKill", killStreak: 2 }],
				pace: { cs: 100, expected: 140, exact: true },
				currentGold: 3000,
				deadEnemies: [{ champion: "Graves", respawnSec: 30, isJungler: true }],
				drakeBackInSec: 40,
				baronBackInSec: 55,
				heraldBackInSec: null
			}),
			mem
		)
		ok(out.length <= MAX_FACTS, `expected at most ${MAX_FACTS}, got ${out.length}`)
	})

	it("says nothing when there is nothing — PASS is a real answer", () => {
		deepStrictEqual(buildFacts(input(), newFactMemory()), [])
	})
})

/**
 * The worst line the project produced: seconds after the enemy took Baron, the coach said
 * "oh deer, your farm is slightly behind".
 *
 * It was not a tone bug. Losing an objective was not a candidate fact at all — only HIM taking one
 * was — so the ranker offered farm and gold and the model picked the best of a worthless list.
 * These tests pin both halves of the fix: the loss must be sayable, and the small talk must stop.
 */
/**
 * THE SUPPLY AUDIT — the two families this round changed, and the measurements behind them.
 *
 * Every fact family was scored on two axes that had never been put beside each other: how much of
 * the coach's OUTPUT it occupies across the four recorded games, and what share of the lines it
 * produced cleared the bar in the blind judged runs on disk (`data/eval/offered/`,
 * `data/eval/judge-r3/`, two independent judges over the same 103 lines).
 *
 *   family      offers / 109   judged lines   cleared (opus / r3)
 *   fight            39             19            1 / 1      <- 36% of supply, 5% yield
 *   stood            11              5            5 / 3      <- 10% of supply, best yield
 *   prey              5              2            2 / 2
 *   obj-timer         7              3            0 / 0
 *   window            3              2            0 / 0
 *   race              5              2            0 / 0
 *   gold              4              0            —
 *
 * And the finding that mattered more than any row: 16 of the 24 lines the judge passed were "a
 * named neutral objective is takeable and several of them are dead, so go start it now", and NONE
 * of them came from this file. The model was assembling that conjunction out of two halves of the
 * block on its own, and every time it did, it cleared.
 */
describe("buildFacts — an objective, and the bodies that make it free", () => {
	const pit = { standing: [{ name: "Baron", atSec: 900, heldSec: 200 }] }

	it("names the objective, the body and the deadline in one sentence", () => {
		const out = buildFacts(
			input({
				nowSec: 1100,
				...pit,
				deadEnemies: [{ champion: "Briar", respawnSec: 45, isJungler: true }]
			}),
			newFactMemory()
		)
		deepStrictEqual(out.length, 1, out.join(" | "))
		ok(/^Baron is up and Briar is down — start it now, you have about \d+ seconds$/.test(out[0]!), out.join(" | "))
	})

	it("counts bodies when it is not their jungler", () => {
		const out = buildFacts(
			input({
				nowSec: 1100,
				...pit,
				deadEnemies: [
					{ champion: "Jhin", respawnSec: 45 },
					{ champion: "Senna", respawnSec: 50 }
				]
			}),
			newFactMemory()
		)
		ok(out.some(f => /^Baron is up and 2 of them are dead/.test(f)), out.join(" | "))
	})

	it("says nothing when only one of them is down and it is not their jungler", () => {
		/*
		 * A support dying does not free a pit. The enemy jungler is the one who reliably contests
		 * it, which is why he alone is enough and anybody else has to be two.
		 */
		const out = buildFacts(
			input({ nowSec: 1100, ...pit, deadEnemies: [{ champion: "Senna", respawnSec: 45 }] }),
			newFactMemory()
		)
		strictEqual(out.some(f => /start it now/.test(f)), false, out.join(" | "))
	})

	it("refuses a window that will have closed before he could start", () => {
		// The floor is applied to the figure he HEARS, like every other countdown in this file.
		const out = buildFacts(
			input({
				nowSec: 1100,
				...pit,
				deadEnemies: [{ champion: "Briar", respawnSec: OBJECTIVE_START_WINDOW_SEC + 2, isJungler: true }]
			}),
			newFactMemory()
		)
		strictEqual(out.some(f => /start it now/.test(f)), false, out.join(" | "))
	})

	it("names the objective that has stood longest, not the first in the list", () => {
		const out = buildFacts(
			input({
				nowSec: 1100,
				standing: [
					{ name: "Void grubs", atSec: 1050, heldSec: 50 },
					{ name: "Dragon", atSec: 800, heldSec: 300 }
				],
				deadEnemies: [{ champion: "Briar", respawnSec: 45, isJungler: true }]
			}),
			newFactMemory()
		)
		ok(out.some(f => /^Dragon is up/.test(f)), out.join(" | "))
	})

	it("says it once per spawn and per window", () => {
		const mem = newFactMemory()
		const at = (t: number, respawn: number) =>
			buildFacts(
				input({
					nowSec: t,
					...pit,
					deadEnemies: [{ champion: "Briar", respawnSec: respawn, isJungler: true }]
				}),
				mem
			)
		ok(at(1100, 45).some(f => /start it now/.test(f)))
		// The same death, twenty seconds on: the same window, so the same sentence.
		strictEqual(at(1120, 25).some(f => /start it now/.test(f)), false)
		// A different death entirely, well past every floor: news again.
		ok(at(1400, 45).some(f => /start it now/.test(f)), "a new window is a new sentence")
	})

	it("outranks the bare window, which is the same fact with nothing to spend it on", () => {
		/*
		 * "2 of them are dead — you have about 12 seconds" is 0 clears from 2 judged lines under
		 * both judges: he is handed a window and left to find the thing to spend it on. With an
		 * objective standing, this file can name it.
		 */
		const out = buildFacts(
			input({
				nowSec: 1100,
				...pit,
				deadEnemies: [
					{ champion: "Briar", respawnSec: 45, isJungler: true },
					{ champion: "Jhin", respawnSec: 40 }
				]
			}),
			newFactMemory()
		)
		deepStrictEqual(out.length, 1, out.join(" | "))
		ok(/start it now/.test(out[0]!), out[0])
	})

	it("is not offered to a turn provider, because it is a countdown on a respawn", () => {
		/*
		 * The turn provider still hears about the pit — `stood` is standing and survives — it just
		 * does not get the half of the sentence that is arithmetic on somebody's respawn. That is
		 * the tier gate doing exactly its job: expiring facts are 77% stale at nine seconds.
		 */
		const out = buildFacts(
			input({
				nowSec: 1100,
				...pit,
				deadEnemies: [{ champion: "Briar", respawnSec: 45, isJungler: true }]
			}),
			newFactMemory(),
			{ path: "turn" }
		)
		strictEqual(out.some(f => /start it now/.test(f)), false, out.join(" | "))
	})

	it("stays quiet when he is in base, where none of it is his to take", () => {
		const out = buildFacts(
			input({
				nowSec: 1100,
				...pit,
				deadEnemies: [{ champion: "Briar", respawnSec: 45, isJungler: true }],
				frame: { where: "base", atSec: 1100, confidence: "medium" }
			}),
			newFactMemory()
		)
		strictEqual(out.some(f => /start it now/.test(f)), false, out.join(" | "))
	})
})

/**
 * THE FIGHT BAN — 36% of the coach's output, 1 clear in 19 judged lines, both `wrong` verdicts.
 *
 * A fight line has two halves. The head is the trade, which is exact and off his HUD. The tail is
 * either what the fight BOUGHT them — an objective, from the event feed, at a named interval — or
 * an imperative, and every imperative available here is static text: `fights.ts`'s five-branch
 * `tail` or the champion markdown, neither of which can name a place, a time or a number. So the
 * sentence it ends is transplantable to any game in which a fight went the same way, which is the
 * second of AGENTS.md's two tests failing by construction rather than by accident.
 */
describe("buildFacts — the fight family, gated on what the fight bought", () => {
	it("says the line that names what they took", () => {
		const out = buildFacts(
			input({
				nowSec: 600,
				fight: {
					quiet: false,
					line: "that fight was 2 for 0 without you, and they took the dragon 18 seconds later",
					bought: true
				}
			}),
			newFactMemory()
		)
		deepStrictEqual(out, ["that fight was 2 for 0 without you, and they took the dragon 18 seconds later"])
	})

	it("builds the tail-only line, traces it, and refuses it by name", () => {
		const traced = built(
			input({
				nowSec: 600,
				fight: { quiet: false, line: "that fight was 0 for 3, so back off and catch up" }
			}),
			newFactMemory()
		)
		const fight = traced.filter(r => r.subject === "fight")
		strictEqual(fight.length, 1, JSON.stringify(traced))
		strictEqual(fight[0]!.reason, "generic-directive")
	})

	it("does not let a banned fight take the turn from a fact that earns it", () => {
		/*
		 * The failure this fixes. A fight is `interrupt` and was offered ALONE, so one turn of a
		 * transplantable imperative took the whole turn from whatever else was on the list — 39
		 * turns of 306 across the four recorded games.
		 */
		const out = buildFacts(
			input({
				nowSec: 600,
				...slow(),
				fight: { quiet: false, line: "that fight was 0 for 3, so back off and catch up" }
			}),
			newFactMemory()
		)
		ok(out.some(f => SLOW_LINE.test(f)), out.join(" | "))
	})

	it("still goes silent while kills are landing", () => {
		// `quiet` is a different thing from the line and is not touched by the ban: a sentence
		// arriving behind a live teamfight is noise at the moment noise costs most.
		deepStrictEqual(
			buildFacts(input({ nowSec: 600, ...slow(), fight: { quiet: true, line: null } }), newFactMemory()),
			[]
		)
	})
})

describe("buildFacts — losing an objective", () => {
	const baron = (atSec: number) => ({ name: "BaronKill", atSec })

	it("says the enemy took Baron, and says it alone", () => {
		const out = buildFacts(
			input({
				nowSec: 1500,
				enemyObjectives: [baron(1490)],
				currentGold: 3000,
				pace: { cs: 100, expected: 140, exact: true }
			}),
			newFactMemory()
		)
		strictEqual(out.length, 1, `the loss must not share a turn with trivia, got: ${out.join(" | ")}`)
		ok(/Baron/.test(out[0]!), `expected the Baron loss, got: ${out[0]}`)
	})

	it("goes quiet rather than offering farm in the minute after", () => {
		const mem = newFactMemory()
		// The first turn announces it; the point of this test is the turn AFTER.
		buildFacts(input({ nowSec: 1500, enemyObjectives: [baron(1490)] }), mem)
		const next = buildFacts(
			input({
				nowSec: 1520,
				enemyObjectives: [baron(1490)],
				currentGold: 3000,
				pace: { cs: 100, expected: 140, exact: true }
			}),
			mem
		)
		strictEqual(next.length, 0, `silence beats a farm nag here, got: ${next.join(" | ")}`)
	})

	it("still offers a window that expires in seconds, even during the quiet", () => {
		// Being quiet must not cost him the one thing that is about the next ten seconds.
		const out = buildFacts(
			input({
				nowSec: 1520,
				enemyObjectives: [baron(1490)],
				deadEnemies: [
					{ champion: "Jhin", respawnSec: 30 },
					{ champion: "Ashe", respawnSec: 28, isJungler: true }
				],
				alliesAlive: 5,
				enemiesAlive: 3
			}),
			newFactMemory()
		)
		ok(out.length > 0, "a live window must survive the blackout")
	})

	it("lets normal facts back once the loss is old news", () => {
		const mem = newFactMemory()
		buildFacts(input({ nowSec: 1500, enemyObjectives: [baron(1490)] }), mem)
		// The blackout is a window, not a mute button. The fact that comes back used to be an
		// unspent-gold line; gold is banned, so it is a standing objective instead.
		const later = buildFacts(
			input({ nowSec: 1490 + 120 + 60, enemyObjectives: [baron(1490)], ...slow() }),
			mem
		)
		ok(later.length > 0, "the blackout is a window, not a mute button")
	})

	it("does not call his OWN Baron a loss", () => {
		// The route filters by team; this pins that an empty list stays empty rather than
		// inventing a disaster out of a good thing.
		const out = buildFacts(input({ nowSec: 1500, enemyObjectives: [], currentGold: 3000 }), newFactMemory())
		strictEqual(out.some(f => /they have Baron/.test(f)), false)
	})
})

/*
 * ============================================================================================
 * The transcript he quit on.
 *
 * Nine lines in four minutes, six of them about how much he had cleared, and two of those six
 * contradicting each other about his own average. Every per-fact cooldown in this file was in
 * force at the time and not one of them had fired twice: the failure was that nothing bounded the
 * COACH, only the individual rules. These are the three rules that bound the coach.
 * ============================================================================================
 */

/** A turn every twenty seconds, which is what the app actually sends. */
const TURN_SEC = 20

/**
 * Run `turns` turns at the shipped cadence, with the same state every time, and collect the lines.
 *
 * The state is deliberately held still: a fact that stays true is the case every rule here exists
 * for, and it is the case the real transcript was.
 */
const session = (
	turns: number,
	at: (nowSec: number) => Partial<FactInput>,
	mem: FactMemory = newFactMemory(),
	startSec = 600
): { atSec: number; lines: string[] }[] => {
	const out: { atSec: number; lines: string[] }[] = []
	for (let i = 0; i < turns; i++) {
		const nowSec = startSec + i * TURN_SEC
		const lines = buildFacts(input({ nowSec, ...at(nowSec) }), mem)
		if (lines.length > 0) out.push({ atSec: nowSec, lines })
	}
	return out
}

describe("buildFacts — how often it may speak at all", () => {
	it("never offers two lines closer together than the floor", () => {
		/*
		 * The whole complaint, as one number. Nine lines in four minutes is one every twenty-five
		 * seconds; a jungler cannot act on an instruction and hear the next one inside that.
		 *
		 * Every kind of fact is available on every turn here, which is the worst case and is not
		 * far off a real teamfight minute.
		 */
		const spoken = session(60, nowSec => ({
			deadEnemies: [
				{ champion: "Karthus", respawnSec: 40, isJungler: true },
				{ champion: "Jinx", respawnSec: 35 },
				{ champion: "Lux", respawnSec: 30 }
			],
			currentGold: 1400 + nowSec,
			pace: { cs: Math.round(nowSec / 5), expected: Math.round(nowSec / 3), exact: true },
			counterpart: { champion: "Karthus", cs: Math.round(nowSec / 3), level: 12 },
			meLevel: 9,
			myKillShare: 0.05,
			objectiveCount: { mine: 0, theirs: 3 },
			baronBackInSec: 40
		}))
		for (let i = 1; i < spoken.length; i++) {
			const gap = spoken[i]!.atSec - spoken[i - 1]!.atSec
			ok(
				gap >= MIN_GAP_SEC,
				`${gap} seconds between "${spoken[i - 1]!.lines[0]}" and "${spoken[i]!.lines[0]}"`
			)
		}
		// And the rate over the whole stretch is nothing like one line every twenty-five seconds.
		const minutes = (60 * TURN_SEC) / 60
		ok(
			spoken.length / minutes <= 1,
			`${(spoken.length / minutes).toFixed(2)} lines per minute over ${minutes} minutes`
		)
	})

	it("still lets an enemy Baron cut in on a line said seconds ago", () => {
		/*
		 * The floor is a budget, not a gag. Losing Baron changes how the next three minutes may be
		 * played, and there is no rate worth protecting by staying quiet about it.
		 */
		const mem = newFactMemory()
		ok(buildFacts(input({ nowSec: 1500, baronBackInSec: 40 }), mem).length > 0)
		const cut = buildFacts(
			input({ nowSec: 1510, enemyObjectives: [{ name: "BaronKill", atSec: 1508 }] }),
			mem
		)
		ok(cut.some(f => /they have Baron/.test(f)), `ten seconds later: ${cut.join(" | ")}`)
	})
})

describe("buildFacts — one subject at a time", () => {
	it("does not let three farm rules add up to six farm lines", () => {
		/*
		 * SIX OF NINE. His own pace, the race against the enemy jungler and the comeback line are
		 * three generators with three separate cooldowns, and to the man hearing them they are one
		 * topic: how much he has cleared. The cooldowns all held. The subject is what was missing.
		 */
		const spoken = session(30, nowSec => ({
			pace: { cs: Math.round(nowSec / 6), expected: Math.round(nowSec / 3), exact: true },
			counterpart: { champion: "Karthus", cs: Math.round(nowSec / 3) }
		}))
		const farmLines = spoken.flatMap(t => t.lines).filter(f => /CS/.test(f))
		const minutes = (30 * TURN_SEC) / 60
		ok(
			farmLines.length <= minutes / 2,
			`${farmLines.length} CS lines in ${minutes} minutes: ${farmLines.join(" | ")}`
		)
	})

	it("never offers his own pace and the enemy jungler's CS in the same list", () => {
		/*
		 * THE CONTRADICTION, at its source. Two baselines for the same subject in one message is
		 * what produced "your 20 farm is not pacing to match your average of 30" and, twenty-five
		 * seconds later, "your 20 farm is not pacing to match your 28 CS average" — same CS, two
		 * averages, and no line in any block ever said either pair. Offer one CS fact or none.
		 */
		const out = buildFacts(
			input({
				nowSec: 900,
				pace: { cs: 100, expected: 140, exact: true },
				counterpart: { champion: "Karthus", cs: 160 }
			}),
			newFactMemory()
		)
		const csLines = out.filter(f => /CS/.test(f))
		ok(csLines.length <= 1, `two CS baselines in one list: ${csLines.join(" | ")}`)
	})

	it("counts a respawn timer and a two-are-dead window as the same subject", () => {
		/*
		 * Replayed over a real game these landed at 14:04, 14:28 and 14:53 — three lines about who
		 * was down inside fifty seconds, from two different rules, neither of which repeated.
		 */
		const mem = newFactMemory()
		const first = buildFacts(
			input({
				nowSec: 840,
				deadEnemies: [
					{ champion: "Karthus", respawnSec: 40, isJungler: true },
					{ champion: "Jinx", respawnSec: 35 }
				]
			}),
			mem
		)
		ok(first.length > 0)
		const next = buildFacts(
			input({
				nowSec: 840 + MIN_GAP_SEC + 5,
				deadEnemies: [{ champion: "Karthus", respawnSec: 40, isJungler: true }]
			}),
			mem
		)
		deepStrictEqual(next, [], "a window and a respawn timer are one topic")
	})

	it("prefers the comeback to the deficit rather than saying both", () => {
		/*
		 * "you've pulled 12 CS back on Karthus" beside "Karthus is 14 CS up on you" is the coach
		 * arguing with itself about one race. The encouraging one wins outright.
		 */
		const mem = newFactMemory()
		const behind = buildFacts(
			input({
				nowSec: 600,
				pace: { cs: 60, expected: 70, exact: true },
				counterpart: { champion: "Karthus", cs: 100 }
			}),
			mem
		)
		ok(behind.some(f => /Karthus is 40 CS up on you/.test(f)), behind.join(" | "))
		const back = buildFacts(
			input({
				nowSec: 600 + ROUTINE_GAP_SEC * 2,
				pace: { cs: 110, expected: 130, exact: true },
				counterpart: { champion: "Karthus", cs: 130 }
			}),
			mem
		)
		ok(back.some(f => /pulled 20 CS back/.test(f)), back.join(" | "))
		strictEqual(
			back.some(f => /is 20 CS up on you/.test(f)),
			false,
			`both spins on one race: ${back.join(" | ")}`
		)
	})
})

describe("buildFacts — a withheld fact is delayed, never deleted", () => {
	it("keeps a death for the next turn instead of burning it against the floor", () => {
		/*
		 * The floor withholds facts constantly now, and the memory writes that mark a fact as said
		 * used to run as the fact was BUILT. That would make the budget delete the rarest lines
		 * rather than delay them — the death here is announce-once, so burning it while withholding
		 * it means it is never said at all.
		 */
		const mem = newFactMemory()
		ok(buildFacts(input({ nowSec: 600, baronBackInSec: 40 }), mem).length > 0)
		const dead = [{ champion: "Karthus", respawnSec: 300, isJungler: true }]
		deepStrictEqual(buildFacts(input({ nowSec: 610, deadEnemies: dead }), mem), [], "too soon")
		ok(
			buildFacts(input({ nowSec: 600 + MIN_GAP_SEC, deadEnemies: dead }), mem).some(f =>
				DEATH_FACT.test(f)
			),
			"the same death is still available once the floor clears"
		)
	})

	it("does not spend a slow fact's turn when a sole line took it", () => {
		/*
		 * A fact held back by a sole line has not been said, so nothing about it may be marked as
		 * spent — otherwise the budget deletes facts instead of delaying them, and the rarest and
		 * best lines are exactly the ones a floor lands on.
		 *
		 * This used to be asserted with an unspent-gold line, which is banned; the rule it pins has
		 * nothing to do with gold.
		 */
		const mem = newFactMemory()
		const first = buildFacts(
			input({
				nowSec: 600,
				...slow(),
				deadEnemies: [
					{ champion: "Karthus", respawnSec: 40, isJungler: true },
					{ champion: "Jinx", respawnSec: 35 }
				]
			}),
			mem
		)
		/*
		 * And the sole line is the CONJUNCTION, not the bare window: an objective is standing and
		 * their jungler is dead, which is the one shape the judges cleared. "2 of them are dead —
		 * you have about 12 seconds" is 0 clears from 2 judged lines; it only speaks when there is
		 * nothing to spend the window on.
		 */
		ok(first.some(f => /start it now/.test(f)), first.join(" | "))
		strictEqual(first.some(f => SLOW_LINE.test(f)), false, "the sole line takes the turn")
		ok(
			buildFacts(input({ nowSec: 600 + ROUTINE_GAP_SEC, ...slow() }), mem).some(f => SLOW_LINE.test(f)),
			"withheld, not spent"
		)
	})
})

describe("buildFacts — the race is news when it turns against him", () => {
	it("does not recite a lead at all, growing or otherwise", () => {
		/*
		 * Replayed over a real game this produced "you're 20 CS up on Karthus", then 40, 50, 60,
		 * 100 and 130 — six lines, every cooldown respected, reciting a lead that was widening
		 * without him doing anything about it. Trimming it to one line was the first fix; the ban
		 * is the second and it takes the whole ahead side.
		 *
		 * He wins this race in four recorded games of four, by about a factor of two, and is ahead
		 * by minute five in every one — so the ahead-side sentence is nearly always the answer, and
		 * the advice it carries is `race-ahead`, static markdown that comes out as some rewording
		 * of *keep the route running*. Judged: 2 spoken lines, both marginal, both labelled
		 * keep-clearing, and keep-clearing is 18 lines and 0 clears across the round-3 sheet.
		 *
		 * The BEHIND side is untouched — see the test below.
		 */
		const mem = newFactMemory()
		const spoken = session(
			40,
			nowSec => ({
				pace: { cs: Math.round(nowSec / 3), expected: Math.round(nowSec / 3), exact: true },
				// His lead grows steadily; Karthus falls further behind every turn.
				counterpart: { champion: "Karthus", cs: Math.round(nowSec / 3) - Math.round(nowSec / 20) }
			}),
			mem,
			600
		)
		const races = spoken.flatMap(t => t.lines).filter(f => /CS up on Karthus/.test(f))
		strictEqual(races.length, 0, `a lead earns no line at all: ${races.join(" | ")}`)
	})

	it("still raises the race when it gets worse", () => {
		const mem = newFactMemory()
		const first = buildFacts(
			input({
				nowSec: 600,
				pace: { cs: 100, expected: 100, exact: true },
				counterpart: { champion: "Karthus", cs: 120 }
			}),
			mem
		)
		ok(first.some(f => /Karthus is 20 CS up on you/.test(f)), first.join(" | "))
		const worse = buildFacts(
			input({
				nowSec: 600 + 300,
				pace: { cs: 130, expected: 130, exact: true },
				counterpart: { champion: "Karthus", cs: 165 }
			}),
			mem
		)
		ok(worse.some(f => /Karthus is 35 CS up on you/.test(f)), `it got worse: ${worse.join(" | ")}`)
	})
})

describe("buildFacts — a backwards clock is a new game", () => {
	it("does not carry the last game's budget into the next one", () => {
		/*
		 * Every limit in this file compares against `nowSec`, so a 35-minute game's timestamps read
		 * as "said seconds ago" at 0:40 of the next one, and the coach goes silent for the whole
		 * game. Caught on a replay: 19 of 20 turns passed, because the harness walks its samples in
		 * an order the game clock does not follow.
		 *
		 * The daemon does clear part of this between games, by listing fields by hand — six of the
		 * twenty on `FactMemory`. That list is exactly the thing that goes stale, which is why the
		 * check lives here instead.
		 */
		const mem = newFactMemory()
		const dead = [{ champion: "Karthus", respawnSec: 40, isJungler: true }]
		ok(buildFacts(input({ nowSec: 2100, deadEnemies: dead }), mem).length > 0, "game one")
		ok(
			buildFacts(input({ nowSec: 40, deadEnemies: dead }), mem).length > 0,
			"game two must not inherit game one's clock"
		)
	})

	it("treats a small backwards step as poll jitter, not a new game", () => {
		const mem = newFactMemory()
		const dead = [{ champion: "Karthus", respawnSec: 40, isJungler: true }]
		ok(buildFacts(input({ nowSec: 600, deadEnemies: dead }), mem).length > 0)
		deepStrictEqual(
			buildFacts(input({ nowSec: 600 - (CLOCK_BACK_SEC - 5), deadEnemies: dead }), mem),
			[],
			"two reads that disagree by a few seconds are the same game"
		)
	})
})

/**
 * THE PICTURE, and the two things it is allowed to do.
 *
 * These are the regression tests for the finding this whole channel exists to fix: a coaching turn
 * with the JPEG attached and one without made the same speak-or-PASS decision on 13 of 14 turns,
 * because every ranked fact was computed from the game client and the model may only speak from the
 * ranked list. The frame now reaches a sentence — but only through a client fact, only hedged, and
 * only at the one granularity that measured well enough (his own HALF of the map: 17 of 18 hand-
 * scored reads, and two reads of one picture agreeing on 56 of 60 pairs).
 *
 * The `degrades` cases are the most important ones here. Vision failing must cost a CLAUSE and never
 * a LINE, so each of them asserts the output is byte-identical to the output with no frame at all.
 */
describe("buildFacts — the frame", () => {
	const frame = (where: string, atSec = 600): Partial<FactInput> => ({
		frame: { where: where as never, atSec, confidence: "medium" }
	})

	it("turns an objective timer into a rotation when he is on the wrong side", () => {
		/*
		 * The whole point, in one assertion. "Drake is back in 40 seconds" is a readout — the timer
		 * is on his HUD. The same sentence with where he is standing attached is a decision, and
		 * where he is standing is in no other channel this app has.
		 */
		const mem = newFactMemory()
		const rotation = (n: number): string =>
			`Drake is back in ${n} seconds — looks like you're topside, walk down`
		const out = buildFacts(input({ nowSec: 600, drakeBackInSec: 40, ...frame("topside") }), mem)
		deepStrictEqual(out, [rotation(heard(40, rotation))])
	})

	it("walks him UP for Baron and Herald, which share a pit", () => {
		for (const key of ["baronBackInSec", "heraldBackInSec"] as const) {
			const mem = newFactMemory()
			const out = buildFacts(input({ nowSec: 600, [key]: 40, ...frame("botside") }), mem)
			ok(out[0]!.endsWith("walk up"), `${key}: ${out[0]}`)
		}
	})

	it("hedges, because the read is right about 94 times in 100 and not 100", () => {
		const mem = newFactMemory()
		const out = buildFacts(input({ nowSec: 600, drakeBackInSec: 40, ...frame("topside") }), mem)
		ok(/looks like you're/.test(out[0]!), `an unhedged position is a claim the pixels cannot pay for: ${out[0]}`)
	})

	it("withholds the timer entirely when he is already standing there", () => {
		/*
		 * MEASURED: of 66 lines offered across four replayed games, 32 were a window or an objective
		 * timer whose entire point is where he should be, said by a coach with no idea where he is.
		 * Standing in the drake pit and being told drake is back in forty seconds is that failure.
		 */
		const mem = newFactMemory()
		deepStrictEqual(buildFacts(input({ nowSec: 600, drakeBackInSec: 40, ...frame("botside") }), mem), [])
	})

	it("does not SPEND the cooldown on a call it withheld", () => {
		/*
		 * Withheld, not consumed — the same rule every other fact in this file follows. A gate that
		 * burnt the seven-minute objective cooldown would delete the call rather than delay it, and
		 * the rarest lines are exactly the ones a budget lands on.
		 */
		const mem = newFactMemory()
		buildFacts(input({ nowSec: 600, drakeBackInSec: 40, ...frame("botside") }), mem)
		strictEqual(mem.lastObjectiveAtSec, 0, "a withheld call must not look like a call that was made")
		const later = buildFacts(input({ nowSec: 700, drakeBackInSec: 40, ...frame("topside", 700) }), mem)
		ok(later.length === 1 && /Drake/.test(later[0]!), `still callable once he walks away: ${later.join(" | ")}`)
	})

	it("leaves 'up NOW' alone, wherever he is standing", () => {
		/*
		 * The frame may only modify the ADVANCE WARNING. There is nothing to start walking to once
		 * the thing has spawned, and that call is the highest-stakes five seconds on this route — it
		 * is not going to depend on a channel that is right 94 times in 100.
		 */
		const mem = newFactMemory()
		deepStrictEqual(buildFacts(input({ nowSec: 600, drakeBackInSec: 3, ...frame("botside") }), mem), [
			"Drake is up NOW"
		])
	})

	it("says nothing new when he is mid, because mid names no direction", () => {
		const mem = newFactMemory()
		const plain = (n: number): string => `Drake is back in ${n} seconds`
		deepStrictEqual(buildFacts(input({ nowSec: 600, drakeBackInSec: 40, ...frame("mid") }), mem), [
			plain(heard(40, plain))
		])
	})

	it("offers a rotation ALONE", () => {
		/*
		 * Ordering is a suggestion to a model; the contents of the list are not — measured three
		 * separate times in this file. A rotation is the only line the coach has about the next
		 * thirty seconds of walking, so it does not share a list with a farm number.
		 */
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				nowSec: 600,
				drakeBackInSec: 40,
				pace: { cs: 100, expected: 140, exact: true },
				...frame("topside")
			}),
			mem
		)
		strictEqual(out.length, 1)
		ok(/walk down/.test(out[0]!), `got: ${out[0]}`)
	})

	it("loses to a fight, and to a lost Baron", () => {
		const quiet = newFactMemory()
		deepStrictEqual(
			buildFacts(input({ nowSec: 600, drakeBackInSec: 40, ...frame("topside"), fight: { quiet: true, line: null } }), quiet),
			[],
			"kills still landing: nothing at all, from any source"
		)

		const fighting = newFactMemory()
		const out = buildFacts(
			input({
				nowSec: 600,
				drakeBackInSec: 40,
				...frame("topside"),
				fight: { quiet: false, line: "that fight happened without you", bought: true }
			}),
			fighting
		)
		deepStrictEqual(out, ["that fight happened without you"])

		/*
		 * And it stays inside the blackout. A forty-second advance warning is not something that
		 * expires in seconds, and after Baron the only things worth saying are about the thing that
		 * happened — the rule that came out of "oh deer, your farm is slightly behind", said seconds
		 * after the enemy took Baron.
		 */
		const after = newFactMemory()
		deepStrictEqual(
			buildFacts(
				input({
					nowSec: 600,
					drakeBackInSec: 40,
					...frame("topside"),
					enemyObjectives: [{ name: "BaronKill", atSec: 540 }]
				}),
				after
			),
			[]
		)
	})

	it("carries no subject of its own, so map facts cannot stack", () => {
		/*
		 * The rotation is subject `objectives`, the SAME subject as the plain timer and the objective
		 * deficit. That is what makes "three map facts in a row" impossible by construction rather
		 * than by a new rule: the frame inherits the budget this file already spends on not talking
		 * about objectives twice.
		 */
		const mem = newFactMemory()
		const first = buildFacts(input({ nowSec: 600, objectiveCount: { mine: 0, theirs: 3 } }), mem)
		ok(first.some(f => /objectives/.test(f)), `got: ${first.join(" | ")}`)
		deepStrictEqual(
			buildFacts(
				input({ nowSec: 600 + ROUTINE_GAP_SEC - 10, drakeBackInSec: 40, ...frame("topside", 590 + ROUTINE_GAP_SEC) }),
				mem
			),
			[],
			"a rotation may not follow an objectives line inside the routine gap"
		)
	})

	it("will not send him at a window he cannot reach from the fountain", () => {
		/*
		 * The gate, and the case the client is structurally blind to: he is ALIVE, so nothing in the
		 * block suggests anything is wrong, and he is standing in his own base having just recalled.
		 * "Two of them are dead, you have about twenty seconds" is then a sprint at something he
		 * cannot reach, and it spends the turn.
		 *
		 * A wrong gate costs a line; a wrong claim costs a decision. That is the whole reason a
		 * 94%-accurate read is allowed to withhold long before it is allowed to assert.
		 */
		const down = [
			{ champion: "Karthus", respawnSec: 30, isJungler: true },
			{ champion: "Ahri", respawnSec: 28 }
		]
		const gated = newFactMemory()
		deepStrictEqual(buildFacts(input({ nowSec: 600, deadEnemies: down, ...frame("base") }), gated), [])

		// The control: the identical turn with no read is the coach exactly as it ships today.
		const open = newFactMemory()
		const out = buildFacts(input({ nowSec: 600, deadEnemies: down }), open)
		ok(out.length > 0 && /dead/.test(out[0]!), `got: ${out.join(" | ")}`)
	})

	describe("degrades to today's coach whenever the read is not usable", () => {
		/*
		 * Four ways for vision to fail and one required outcome for all of them. A missing pre-pass,
		 * a failed call, a read the client's fence threw away, a read that could not find his icon,
		 * a read the daemon doubts, and a read of a picture that is now about somewhere else must
		 * every one of them produce the sentence this route has always produced. The coach going
		 * quiet because vision went quiet is the same failure as the coach going quiet because the
		 * ground-truth fetch failed, and this app already refuses to do that.
		 */
		const withoutFrame = (over: Partial<FactInput>): string[] =>
			buildFacts(input({ nowSec: 600, drakeBackInSec: 40, ...over }), newFactMemory())

		const cases: [string, Partial<FactInput>][] = [
			["no read at all", {}],
			[
				"a read that could not place him",
				{ frame: { where: null, atSec: 600, confidence: "medium" } }
			],
			[
				"a read the daemon doubts",
				{ frame: { where: "botside", atSec: 600, confidence: "low" } }
			],
			[
				"a picture older than a map crossing",
				{ frame: { where: "botside", atSec: 600 - FRAME_FRESH_SEC - 1, confidence: "medium" } }
			],
			[
				"a stamp from the future, which is a broken producer",
				{ frame: { where: "botside", atSec: 620, confidence: "medium" } }
			]
		]
		for (const [name, over] of cases)
			it(name, () => {
				/*
				 * `botside` deliberately, in the three cases that carry a half: it is the half that
				 * would WITHHOLD the drake call. So a bug that let an unusable read through would
				 * show up here as silence, which is the failure that matters — not as a clause.
				 */
				const plain = (n: number): string => `Drake is back in ${n} seconds`
				deepStrictEqual(withoutFrame(over), [plain(heard(40, plain))], name)
			})

		it("and a low-confidence read does not gate a window either", () => {
			/*
			 * `low` means NOTHING, in both directions. Suppressing a line on a read that may be wrong
			 * is still acting on it, and it is the direction that is invisible when it goes wrong.
			 */
			const mem = newFactMemory()
			const out = buildFacts(
				input({
					nowSec: 600,
					deadEnemies: [
						{ champion: "Karthus", respawnSec: 30, isJungler: true },
						{ champion: "Ahri", respawnSec: 28 }
					],
					frame: { where: "base", atSec: 600, confidence: "low" }
				}),
				mem
			)
			ok(out.length > 0, "a doubted read must not silence the coach")
		})
	})
})

/**
 * The pipe: how long between the state being read and the last syllable landing.
 *
 * MEASURED, on four recorded games replayed through this function at the shipped twenty-second
 * turn — 66 offered lines, 46 of them with a real sample within six seconds of the last syllable
 * to check the premise against (`scripts/measure-staleness.ts`, and the arithmetic is
 * `analysis/timeliness.ts`, which is not imported by the ranker itself):
 *
 *                     stale at 0s   at 5s   at 9s
 *   expiring facts       31%          34%     77%
 *   standing facts        9%          18%     18%
 *
 * At ZERO provider latency 8 of 18 window lines were already stale by their own last syllable,
 * purely because the sentence takes a measured median of 3.6 seconds to say. Provider latency does
 * not move that number — 0s and 5s give the identical 8 of 18 — so the only fix available is the
 * sentence: say fewer words, and say the figure that will be true when the words run out.
 */
describe("buildFacts — the sentence is part of the arithmetic", () => {
	/** Every premise whose truth is a moment rather than a state. Mirrors `Fact.tier`. */
	const expiring = (line: string): boolean => {
		const p = premiseOf(line)
		return (
			p.kind === "window" ||
			p.kind === "jungler-down" ||
			p.kind === "objective-timer" ||
			(p.kind === "levels" && p.restraint) ||
			(p.kind === "objective-lost" && p.name === "DragonKill")
		)
	}

	/** One input per expiring template this file can produce, so the budget covers all of them. */
	const everyExpiringLine = (): string[] => {
		const cases: Partial<FactInput>[] = [
			{
				deadEnemies: [
					{ champion: "Karthus", respawnSec: 40, isJungler: true },
					{ champion: "Ahri", respawnSec: 38 }
				]
			},
			{ deadEnemies: [{ champion: "Karthus", respawnSec: 40, isJungler: true }] },
			{ drakeBackInSec: 55 },
			{ drakeBackInSec: 55, frame: { where: "topside", atSec: 600, confidence: "medium" } },
			{ baronBackInSec: 55, frame: { where: "botside", atSec: 600, confidence: "medium" } },
			{ drakeBackInSec: 3 },
			{
				counterpart: { champion: "Karthus", level: 9 },
				meLevel: 6,
				drakeBackInSec: 30
			},
			{ enemyObjectives: [{ name: "DragonKill", atSec: 590, dragonType: "Fire" }] }
		]
		return cases.flatMap(over => buildFacts(input({ nowSec: 600, ...over }), newFactMemory()))
	}

	/**
	 * The budget, and it is not a taste call.
	 *
	 * Every syllable of an expiring line is subtracted from the thing it is describing, because the
	 * countdown it speaks is the raw figure minus the sentence. The corpus median coach line is
	 * 3.93 seconds and the two longest expiring templates measured 5.53 and 5.15 before this work —
	 * 1.7 and 1.0 seconds of window and of walking time, spent on his own respawn timer and on the
	 * words "it", "and", "start" and "now".
	 *
	 * 4.5 is a RATCHET rather than an optimum: it is the longest surviving template (the Baron
	 * rotation, 4.39s) rounded up. Its job is to fail when a template grows, which is how both of
	 * the ones above got there — a clause at a time, each of them defensible on its own.
	 */
	const EXPIRING_BUDGET_SEC = 4.5

	it("keeps every expiring line inside the speech budget", () => {
		for (const line of everyExpiringLine().filter(expiring))
			ok(
				speechDurationSec(line) <= EXPIRING_BUDGET_SEC,
				`${speechDurationSec(line).toFixed(2)}s of a ${EXPIRING_BUDGET_SEC}s budget: ${line}`
			)
	})

	it("never speaks a countdown that will have run past by the last syllable", () => {
		/*
		 * The invariant, over every countdown template at once: the figure spoken, plus the pipe it
		 * is spoken through, may not exceed the figure the client actually reported. A number that
		 * was true when it was computed and false when it is heard is the same failure as a stale
		 * fact, and unlike a stale fact it is arithmetic.
		 */
		const raw = 55
		const cases: Partial<FactInput>[] = [
			{ drakeBackInSec: raw },
			{ drakeBackInSec: raw, frame: { where: "topside", atSec: 600, confidence: "medium" } },
			{ deadEnemies: [{ champion: "Karthus", respawnSec: raw, isJungler: true }] },
			{
				deadEnemies: [
					{ champion: "Karthus", respawnSec: raw, isJungler: true },
					{ champion: "Ahri", respawnSec: raw + 2 }
				]
			}
		]
		for (const over of cases) {
			const [line] = buildFacts(input({ nowSec: 600, ...over }), newFactMemory())
			ok(line !== undefined, `nothing said for ${JSON.stringify(over)}`)
			const p = premiseOf(line!)
			const said =
				p.kind === "window" ? p.seconds
				: p.kind === "jungler-down" ? p.seconds
				: p.kind === "objective-timer" ? p.seconds
				: -1
			ok(said >= 0, `unparsed countdown: ${line}`)
			ok(
				said + SOCKET_PIPE_SEC + speechDurationSec(line!) <= raw + 1,
				`says ${said} of a real ${raw} but takes ${(SOCKET_PIPE_SEC + speechDurationSec(line!)).toFixed(1)}s to arrive: ${line}`
			)
		}
	})

	it("drops a countdown that will be under the floor before he hears it", () => {
		/*
		 * MEASURED: "Zed is down 13 seconds — their camps are free" had 7 seconds left when its last
		 * syllable landed, under the ten-second floor that decided it was worth saying at all. The
		 * floor now applies to the number he will hear, so the line is not said.
		 */
		const mem = newFactMemory()
		deepStrictEqual(
			buildFacts(input({ deadEnemies: [{ champion: "Zed", respawnSec: 13, isJungler: true }] }), mem),
			[]
		)
		// And the same death with enough left is still said — a floor, not a ban.
		ok(
			buildFacts(
				input({ nowSec: 900, deadEnemies: [{ champion: "Zed", respawnSec: 30, isJungler: true }] }),
				newFactMemory()
			).some(f => DEATH_FACT.test(f))
		)
	})

	it("drops a window one of them will have respawned out of", () => {
		/*
		 * MEASURED: 2 of the 18 window lines were "told 2 were down; 1 still is by the time it
		 * landed" — a count that had never been true at the moment he could act on it, which is the
		 * difference between a dive and a 2v2. Both respawn timers were in the block.
		 */
		const mem = newFactMemory()
		deepStrictEqual(
			buildFacts(
				input({
					deadEnemies: [
						{ champion: "Karthus", respawnSec: 40, isJungler: true },
						{ champion: "Ahri", respawnSec: 13 }
					]
				}),
				mem
			).filter(f => /of them are dead/.test(f)),
			[],
			"one of the two is back on his feet before the sentence ends"
		)
	})

	it("drops a window an enemy respawn will have turned into a fight he is losing", () => {
		/*
		 * `impossible` rather than merely late: an instruction he must actively ignore. He is 1v1
		 * now and 1v3 by the time the sentence lands, because two of the four corpses have less
		 * than five seconds left — numbers already in the block. Two of them are still down for
		 * forty seconds, so the window is real; it is just not his.
		 */
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				alliesAlive: 1,
				enemiesAlive: 1,
				deadEnemies: [
					{ champion: "Karthus", respawnSec: 40, isJungler: true },
					{ champion: "Ahri", respawnSec: 38 },
					{ champion: "Jhin", respawnSec: 4 },
					{ champion: "Lux", respawnSec: 3 }
				]
			}),
			mem
		)
		deepStrictEqual(out.filter(f => /of them are dead/.test(f)), [])
	})

})

/**
 * THE TIER GATE — the one rule that makes the socket structurally different rather than faster.
 *
 * A turn-based provider is several seconds behind by construction: the sentence is written and paid
 * for before its first syllable. Measured over the same four games, that is the difference between
 * an expiring fact being 34% stale and 77% stale, while standing facts sit at 18% either way. The
 * lesson recorded four times in this file is that ordering is a suggestion to a model and the
 * contents of the list are not, so the slow path is not TRUSTED to skip the reactive line — it is
 * not offered one.
 */
describe("buildFacts — a turn provider may not carry a reactive line", () => {
	const reactive: Partial<FactInput>[] = [
		{
			deadEnemies: [
				{ champion: "Karthus", respawnSec: 40, isJungler: true },
				{ champion: "Ahri", respawnSec: 38 }
			]
		},
		{ deadEnemies: [{ champion: "Karthus", respawnSec: 40, isJungler: true }] },
		{ drakeBackInSec: 55 },
		{ drakeBackInSec: 3 },
		{ enemyObjectives: [{ name: "DragonKill", atSec: 590, dragonType: "Fire" }] },
		{ counterpart: { champion: "Karthus", level: 9 }, meLevel: 6, drakeBackInSec: 30 },
		{ fight: { quiet: false, line: "that fight was 0 for 3 without you", kind: "fight-absent", bought: true } }
	]

	it("says all of them to the socket and none of them to a turn provider", () => {
		for (const over of reactive) {
			const at = input({ nowSec: 600, ...over })
			ok(buildFacts(at, newFactMemory()).length > 0, `socket: ${JSON.stringify(over)}`)
			deepStrictEqual(
				buildFacts(at, newFactMemory(), { path: "turn" }),
				[],
				`turn: ${JSON.stringify(over)}`
			)
		}
	})

	it("still hands a turn provider the facts that stay true for minutes", () => {
		ok(
			buildFacts(input({ nowSec: 600, ...slow() }), newFactMemory(), { path: "turn" }).some(f =>
				SLOW_LINE.test(f)
			)
		)
		ok(
			buildFacts(
				input({ nowSec: 900, objectiveCount: { mine: 0, theirs: 3 } }),
				newFactMemory(),
				{ path: "turn" }
			).length > 0
		)
	})

	it("still hands a turn provider a lost Baron, which interrupts and does not expire", () => {
		/*
		 * The gate is on DURABILITY, not on the tier, and this is why the two are separate
		 * questions. Baron is an `interrupt` because it is worth cutting into anything, and it
		 * shapes the next three minutes — a coach that went quiet about it because it arrived four
		 * seconds late would be silent about the largest thing that happens in a game.
		 */
		const out = buildFacts(
			input({ nowSec: 1500, enemyObjectives: [{ name: "BaronKill", atSec: 1490 }] }),
			newFactMemory(),
			{ path: "turn" }
		)
		ok(out.some(f => /they have Baron/.test(f)), `got: ${out.join(" | ")}`)
	})

	it("does not SPEND a fact the gate withheld", () => {
		/*
		 * Withheld, not consumed — the rule every other budget in this file follows. A gate that
		 * burnt the announce-once memory would delete the line rather than route it, and the socket
		 * would then be silent about a death the turn provider was never allowed to mention.
		 */
		const mem = newFactMemory()
		const dead = [{ champion: "Karthus", respawnSec: 40, isJungler: true }]
		deepStrictEqual(buildFacts(input({ nowSec: 600, deadEnemies: dead }), mem, { path: "turn" }), [])
		ok(
			buildFacts(input({ nowSec: 605, deadEnemies: [{ ...dead[0]!, respawnSec: 35 }] }), mem).some(f =>
				DEATH_FACT.test(f)
			),
			"the same death is still the socket's to say"
		)
	})

	it("charges a turn provider its own pipe when it does speak", () => {
		/*
		 * The gate removes the countdowns, so this is about the facts that remain: a turn provider
		 * is five seconds behind, and anything it says is being decided against a state five seconds
		 * older than the socket's. `pipeSec` is a parameter rather than a constant because a caller
		 * that has measured its own provider knows better than this file does.
		 */
		strictEqual(TURN_PIPE_SEC > SOCKET_PIPE_SEC, true)
		const plain = (n: number): string => `Drake is back in ${n} seconds`
		const out = buildFacts(input({ nowSec: 600, drakeBackInSec: 55 }), newFactMemory(), {
			pipeSec: TURN_PIPE_SEC
		})
		deepStrictEqual(out, [plain(heard(55, plain, TURN_PIPE_SEC))])
	})
})


describe("buildFacts — a question that has been answered", () => {
	/*
	 * THE DISEASE THIS APP HAS CAUGHT TWICE. Over 88 states of his own games the block's jungle-race
	 * verdict read "he is behind you" in 82 and "ahead" in none, and farm, CS, clearing and routing
	 * together produced three useful lines out of eighty-four. A comparison whose answer never
	 * changes cannot drive a decision, however exact both numbers are.
	 *
	 * The general mechanism is in `shared/live-state.ts` and pinned in `shared/retirement.test.ts`;
	 * these two cases are about it actually reaching the ranked list.
	 */
	const racing = (nowSec: number, gap: number): FactInput =>
		input({
			nowSec,
			pace: { cs: 100, expected: 100, exact: true },
			counterpart: { champion: "Karthus", cs: 100 + gap }
		})

	it("says the race once and then stops, however long the game runs", () => {
		const mem = newFactMemory()
		const said: string[] = []
		/*
		 * Twenty minutes of the same decisive verdict. Every per-fact cooldown in the file lapses
		 * several times over, and retirement is what holds it to one line.
		 *
		 * The gap is now the BEHIND side. It used to be the lead — four of four recorded games look
		 * like that — but the ahead side is banned outright, so a run of it would prove retirement
		 * by proving nothing was ever built. Retirement is a rule about a verdict that stops
		 * changing, and it holds on whichever side of the race the verdict sits.
		 */
		for (let t = 400; t <= 1600; t += 20) said.push(...buildFacts(racing(t, 40), mem).filter(f => /Karthus/.test(f)))
		strictEqual(said.length, 1, said.join(" | "))
	})

	it("lets the flip cut the routine floor, but never the floor between any two lines", () => {
		/*
		 * A settled question becoming a question again is not the same standing fact coming round on
		 * its cooldown, so it must not queue behind the two-minute routine floor that exists to stop
		 * exactly that. It still waits out `MIN_GAP_SEC`, which is the shortest gap at which the
		 * previous instruction has plausibly been carried out.
		 */
		const mem = newFactMemory()
		for (let t = 400; t <= 1200; t += 20) buildFacts(racing(t, -40), mem)
		// Something else is said, so the routine floor is freshly against him.
		ok(
			buildFacts(input({ nowSec: 1400, deadEnemies: [{ champion: "Graves", respawnSec: 40, isJungler: true }] }), mem)
				.length > 0
		)
		strictEqual(buildFacts(racing(1400 + MIN_GAP_SEC - 5, 40), mem).length, 0, "inside the floor")
		const after = buildFacts(racing(1400 + MIN_GAP_SEC + 5, 40), mem)
		ok(after.some(f => /Karthus is 40 CS up on you/.test(f)), `${1400 + MIN_GAP_SEC + 5}: ${after.join(" | ")}`)
	})

	it("but comes back the moment the race turns against him", () => {
		/*
		 * The flip is the only time this fact was ever news, so a rule that merely went quiet would
		 * be worse than the nagging: it would be silent about the one state worth hearing.
		 */
		const mem = newFactMemory()
		for (let t = 400; t <= 1200; t += 20) buildFacts(racing(t, -40), mem)
		const turned = buildFacts(racing(1400, 40), mem)
		ok(turned.some(f => /Karthus is 40 CS up on you/.test(f)), turned.join(" | "))
	})
})

describe("buildFacts — an event may veto a trend", () => {
	/*
	 * THE TRAP, from `data/eval/target-lines.md` M25: between 30:24 and 33:15 his CS floor does not
	 * move for 171 seconds, and in exactly that window he solo'd a drake, his team aced and he took
	 * Baron. A farm line there is not useless, it is wrong coaching about the best three minutes he
	 * played, and every rate limit in this file would have let it through — each of them asks
	 * whether time has passed and none asks whether anything happened.
	 */
	const behind = (nowSec: number, over: Partial<FactInput> = {}): FactInput =>
		input({ nowSec, pace: { cs: 100, expected: 140, exact: true }, ...over })

	it("says nothing about his farm right after he takes Baron himself", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			behind(2000, { myEvents: [{ id: 1, name: "BaronKill", atSec: 1990 }] }),
			mem
		)
		strictEqual(out.some(f => /own pace/.test(f)), false, out.join(" | "))
	})

	it("says it again once the play is far enough behind him", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			behind(2000, { myEvents: [{ id: 1, name: "BaronKill", atSec: 2000 - TREND_VETO_SEC - 10 }] }),
			mem
		)
		ok(out.some(f => /own pace/.test(f)), out.join(" | "))
	})

	it("is not fooled by an event with no clock on it", () => {
		/*
		 * Every fixture in this repo predates `atSec`, so it is optional — and a veto that treated a
		 * timeless event as recent would silence his farm for the rest of a game after one drake.
		 */
		const mem = newFactMemory()
		const out = buildFacts(behind(2000, { myEvents: [{ id: 1, name: "BaronKill" }] }), mem)
		ok(out.some(f => /own pace/.test(f)), out.join(" | "))
	})

	it("a triple kill vetoes it too, and three grubs do not", () => {
		const mem = newFactMemory()
		strictEqual(
			buildFacts(
				behind(2000, { myEvents: [{ id: 1, name: "ChampionKill", atSec: 1980, killStreak: 3 }] }),
				mem
			).some(f => /own pace/.test(f)),
			false
		)
		const fresh = newFactMemory()
		ok(
			buildFacts(behind(2000, { myEvents: [{ id: 2, name: "HordeKill", atSec: 1980 }] }), fresh).some(f =>
				/own pace/.test(f)
			)
		)
	})

	it("still lets him hear that an enemy is down while it holds", () => {
		/*
		 * A veto on the CRITICISM, never a blackout. The window a corpse opens is the most
		 * actionable thing this coach has, and his own Baron is a reason to use it rather than a
		 * reason to go quiet.
		 */
		const mem = newFactMemory()
		const out = buildFacts(
			behind(2000, {
				myEvents: [{ id: 1, name: "BaronKill", atSec: 1990 }],
				deadEnemies: [{ champion: "Karthus", respawnSec: 40, isJungler: true }]
			}),
			mem
		)
		ok(out.some(f => /Karthus/.test(f)), out.join(" | "))
	})
})

describe("buildFacts — how long it has stood there", () => {
	/*
	 * THE ONE FACT ON NO CHANNEL HE HAS. `data/eval/is-the-timer-visible.md` read 1,876 real journal
	 * frames of nine of his own games: the spawn countdown is on his minimap from three minutes out,
	 * exact, in 9 of 9 — and while the thing is STANDING the display prints no digits at all. It was
	 * already computed and already in the block's prose; it was never ranked, which in this app is
	 * the same as not existing.
	 */
	const standing = (heldSec: number, over: Partial<FactInput> = {}): FactInput =>
		input({ nowSec: 1400, standing: [{ name: "Baron", atSec: 1400 - heldSec, heldSec }], ...over })

	it("says nothing while it has only just spawned", () => {
		const mem = newFactMemory()
		const out = buildFacts(standing(20), mem)
		strictEqual(out.some(f => /nobody has taken it/.test(f)), false, out.join(" | "))
	})

	it("speaks once it has been ignored long enough for the ignoring to be the news", () => {
		const mem = newFactMemory()
		const out = buildFacts(standing(SCHEDULE_UNCONTESTED_SEC + 5), mem)
		ok(
			out.some(f => /^Baron has been up 2 minutes 5 seconds and nobody has taken it/.test(f)),
			out.join(" | ")
		)
	})

	it("does not restate the same standing objective on the next turn", () => {
		const mem = newFactMemory()
		buildFacts(standing(150), mem)
		const again = buildFacts(
			input({ nowSec: 1400 + ROUTINE_GAP_SEC + 10, standing: [{ name: "Baron", atSec: 1250, heldSec: 160 }] }),
			mem
		)
		strictEqual(again.some(f => /nobody has taken it/.test(f)), false, again.join(" | "))
	})

	it("says it a second time once it has stood long enough to be a different sentence", () => {
		const mem = newFactMemory()
		buildFacts(standing(150), mem)
		const later = buildFacts(
			input({ nowSec: 1700, standing: [{ name: "Baron", atSec: 1250, heldSec: 450 }] }),
			mem
		)
		ok(later.some(f => /Baron has been up 7 minutes 30 seconds/.test(f)), later.join(" | "))
	})

	it("a retake starts a fresh clock and is a genuine flip, not a continuation", () => {
		const mem = newFactMemory()
		buildFacts(standing(150), mem)
		const respawned = buildFacts(
			input({ nowSec: 2000, standing: [{ name: "Baron", atSec: 1850, heldSec: 150 }] }),
			mem
		)
		ok(respawned.some(f => /nobody has taken it/.test(f)), respawned.join(" | "))
	})

	it("is withheld when the frame says he is already standing on it", () => {
		/*
		 * The same gate `soon` applies to a timer, for the same reason: standing in the pit and being
		 * told nobody has taken the thing in the pit is the readout this whole file refuses. Withheld
		 * rather than demoted, so nothing is spent and it is still available when he walks away.
		 */
		const mem = newFactMemory()
		const out = buildFacts(
			standing(150, { frame: { where: "topside", atSec: 1398, confidence: "medium" } }),
			mem
		)
		strictEqual(out.some(f => /nobody has taken it/.test(f)), false, out.join(" | "))
		const away = buildFacts(
			standing(150, { frame: { where: "botside", atSec: 1398, confidence: "medium" } }),
			newFactMemory()
		)
		ok(away.some(f => /nobody has taken it/.test(f)), away.join(" | "))
	})

	it("is a standing fact, so a turn provider may carry it", () => {
		// It is true for minutes by construction — that is the entire content of the claim — so it
		// must not be stripped by the tier gate the way a countdown is.
		const mem = newFactMemory()
		const out = buildFacts(standing(150), mem, { path: "turn" })
		ok(out.some(f => /nobody has taken it/.test(f)), out.join(" | "))
	})

	it("parses back to its own premise rather than to the build line", () => {
		strictEqual(premiseOf("Baron has been up 2 minutes and nobody has taken it").kind, "uncontested")
	})
})

describe("buildFacts — who keeps killing whom", () => {
	/*
	 * The largest single gap the target corpus found: the block renders `0/5/4` and cannot know that
	 * three of those five are one champion. Both halves are one `GROUP BY` over the event feed.
	 */
	const kill = (killer: string, victim: string, atSec: number) => ({ killer, victim, atSec })

	it("says nothing at two, because two is a rematch", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({ meChampion: "Lillia", kills: [kill("Briar", "Lillia", 100), kill("Briar", "Lillia", 200)] }),
			mem
		)
		strictEqual(out.some(f => /deaths are/.test(f)), false, out.join(" | "))
	})

	it("names his nemesis with the count and the total from ONE source", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				meChampion: "Lillia",
				kills: [
					kill("Briar", "Lillia", 100),
					kill("Briar", "Lillia", 200),
					kill("Briar", "Lillia", 300),
					kill("Jhin", "Lillia", 400),
					kill("Senna", "Lillia", 500)
				]
			}),
			mem
		)
		ok(out.some(f => /^3 of your 5 deaths are Briar/.test(f)), out.join(" | "))
	})

	it("does not restate the same verdict as the count creeps up", () => {
		const mem = newFactMemory()
		const kills = [kill("Briar", "Lillia", 100), kill("Briar", "Lillia", 200), kill("Briar", "Lillia", 300)]
		buildFacts(input({ meChampion: "Lillia", kills }), mem)
		const again = buildFacts(
			input({
				nowSec: 600 + ROUTINE_GAP_SEC + 10,
				meChampion: "Lillia",
				kills: [...kills, kill("Briar", "Lillia", 700)]
			}),
			mem
		)
		strictEqual(again.some(f => /deaths are Briar/.test(f)), false, again.join(" | "))
	})

	it("says it once more when it stops being a pattern and becomes the game", () => {
		const mem = newFactMemory()
		const kills = [kill("Briar", "Lillia", 100), kill("Briar", "Lillia", 200), kill("Briar", "Lillia", 300)]
		buildFacts(input({ meChampion: "Lillia", kills }), mem)
		const decided = buildFacts(
			input({
				nowSec: 600 + ROUTINE_GAP_SEC + 10,
				meChampion: "Lillia",
				kills: [...kills, kill("Briar", "Lillia", 700), kill("Briar", "Lillia", 800)]
			}),
			mem
		)
		ok(decided.some(f => /^5 of your 5 deaths are Briar/.test(f)), decided.join(" | "))
	})

	it("names who the enemy jungler keeps farming, as context and never as blame", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				meChampion: "Lillia",
				counterpart: { champion: "Briar" },
				kills: [
					kill("Briar", "Urgot", 100),
					kill("Briar", "Urgot", 200),
					kill("Briar", "Urgot", 300)
				]
			}),
			mem
		)
		ok(out.some(f => /^Briar has killed your Urgot 3 times/.test(f)), out.join(" | "))
	})

	it("puts his own deaths above a teammate's, and never both in one list", () => {
		/*
		 * One subject, so `distinct` keeps one — and the one about the fight HE keeps taking wins,
		 * because it is the only one of the two he can act on by himself.
		 */
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				meChampion: "Lillia",
				counterpart: { champion: "Briar" },
				kills: [
					kill("Briar", "Lillia", 100),
					kill("Briar", "Lillia", 200),
					kill("Briar", "Lillia", 300),
					kill("Briar", "Urgot", 400),
					kill("Briar", "Urgot", 500),
					kill("Briar", "Urgot", 600)
				]
			}),
			mem
		)
		strictEqual(out.filter(f => /Briar/.test(f)).length, 1, out.join(" | "))
		ok(out.some(f => /deaths are Briar/.test(f)), out.join(" | "))
	})

	it("parses back to its own premise", () => {
		strictEqual(premiseOf("3 of your 5 deaths are Briar").kind, "matchup")
		strictEqual(premiseOf("Briar has killed your Urgot 5 times").kind, "matchup")
	})
})

describe("buildFacts — an interrupt does not charge a floor it exempted itself from", () => {
	/*
	 * MEASURED over the four recorded games (`scripts/measure-starve.ts`): 493 facts were built and
	 * 84 offered, and of the 314 stopped by a floor, 176 — 56% — were stopped by a floor started by
	 * a `fight` line. A fight is `interrupt`, so it skips every rate in this function for itself and
	 * then charged the full two-minute routine quiet to everything else. One turn of high-stakes
	 * news bought two minutes of silence about everything he could not see.
	 *
	 * The routine floor's own comment says what it is for — farm, gold and the objective count are
	 * "the ones that turn into nagging, because the state that produced them is still there next
	 * turn". That is a statement about SLOW facts following each other, so it is counted from the
	 * last slow fact. `MIN_GAP_SEC` is still charged by everything, because its argument — the
	 * previous instruction has plausibly been acted on — is about any two lines.
	 */
	it("lets a standing fact follow a fight at the general floor rather than the routine one", () => {
		const mem = newFactMemory()
		const fought = buildFacts(
			input({ nowSec: 600, fight: { quiet: false, line: "that fight was 0 for 3 without you", bought: true } }),
			mem
		)
		ok(fought.length === 1, fought.join(" | "))
		const after = buildFacts(
			input({
				nowSec: 600 + MIN_GAP_SEC + 1,
				standing: [{ name: "Baron", atSec: 400, heldSec: 245 }]
			}),
			mem
		)
		ok(after.some(f => /nobody has taken it/.test(f)), after.join(" | "))
	})

	it("still keeps two slow facts two minutes apart", () => {
		const mem = newFactMemory()
		const first = buildFacts(
			input({ nowSec: 600, standing: [{ name: "Baron", atSec: 400, heldSec: 200 }] }),
			mem
		)
		ok(first.some(f => /nobody has taken it/.test(f)), first.join(" | "))
		const soon = buildFacts(
			input({
				nowSec: 600 + MIN_GAP_SEC + 1,
				meChampion: "Lillia",
				kills: [
					{ killer: "Briar", victim: "Lillia", atSec: 100 },
					{ killer: "Briar", victim: "Lillia", atSec: 200 },
					{ killer: "Briar", victim: "Lillia", atSec: 300 }
				]
			}),
			mem
		)
		deepStrictEqual(soon, [], "a second slow fact inside two minutes is still withheld")
	})
})

describe("buildFacts — the one plural pit", () => {
	it("says the grubs HAVE been up and nobody has taken THEM", () => {
		/*
		 * This string is read out loud. `spokenDuration` carries the same note for the same reason,
		 * after a model read "spawns in 1 seconds" to him verbatim off the schedule.
		 */
		const mem = newFactMemory()
		const out = buildFacts(
			input({ nowSec: 800, standing: [{ name: "Void grubs", atSec: 480, heldSec: 320 }] }),
			mem
		)
		ok(
			out.some(f => /^Void grubs have been up 5 minutes 20 seconds and nobody has taken them/.test(f)),
			out.join(" | ")
		)
		strictEqual(premiseOf("Void grubs have been up 5 minutes and nobody has taken them").kind, "uncontested")
	})
})
