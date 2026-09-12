/**
 * The live coach's quality is decided here, so it is pinned here.
 *
 * Every case below is a failure a judge found in a real session and a structural rule that was
 * added to stop it. They are not hypotheticals: "the same corpse announced on every poll" and
 * "chose a fourth Morgana timer over an explicit unspent-gold flag beside it" both happened, and
 * both are one regression away from happening again.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { readFileSync } from "node:fs"
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
	LEVEL_HOLD_SEC,
	LEVEL_MIN_SEC,
	MAX_FACTS,
	MIN_GAP_SEC,
	ROUTINE_GAP_SEC,
	CLOCK_BACK_SEC,
	SOCKET_PIPE_SEC,
	TURN_PIPE_SEC,
	VISION_MIN_SEC,
	WINDOW_MIN_SEC
} from "./live-facts.ts"
import type { FactInput, FactMemory } from "./live-facts.ts"
import { premiseOf, speechDurationSec } from "./timeliness.ts"

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
 * Gold requires GOLD_MIN_HELD_SEC of holding before it is ever mentioned — the amount is on his
 * HUD and only the duration is news. Tests that use a gold line as "some other fact" have to
 * respect that, so they prime through this rather than each inventing its own timeline.
 */
const holdGold = (mem: FactMemory, gold: number, crossedAt: number): number => {
	buildFacts(input({ nowSec: crossedAt, currentGold: gold }), mem)
	return crossedAt + GOLD_MIN_HELD_SEC
}

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
	it("says nothing about gold until it has actually been sitting there", () => {
		/*
		 * Simulated across a full game, gold was 8 of the coach's 12 lines — the most frequent
		 * thing it said and the least valuable, because the amount is on his HUD. What is NOT on
		 * his HUD is that it has been there for minutes, so duration is now the gate.
		 */
		const mem = newFactMemory()
		strictEqual(
			buildFacts(input({ nowSec: 300, currentGold: 1300 }), mem).some(f => f.includes("unspent")),
			false,
			"crossing the threshold is not news; sitting on it is"
		)
	})

	it("mentions gold once it has been held, then only after another step", () => {
		const mem = newFactMemory()
		// Crossing starts the clock; the mention comes once it has been held long enough.
		buildFacts(input({ nowSec: 300, currentGold: 1300 }), mem)
		const said = 300 + GOLD_MIN_HELD_SEC
		ok(buildFacts(input({ nowSec: said, currentGold: 1300 }), mem).some(f => f.includes("unspent")))
		/*
		 * The follow-ups are a full ROUTINE_GAP_SEC later, one turn apart.
		 *
		 * They used to sit on the same tick as the first mention, which tested the step rule in
		 * isolation and is now unreachable: the global floor silences a second line on the same
		 * second whatever it is about, so a same-tick assertion would pass for the wrong reason.
		 */
		strictEqual(
			buildFacts(input({ nowSec: said + ROUTINE_GAP_SEC, currentGold: 1400 }), mem).some(f =>
				f.includes("unspent")
			),
			false,
			"a hundred more gold is not news"
		)
		ok(
			buildFacts(
				input({ nowSec: said + ROUTINE_GAP_SEC, currentGold: 1300 + GOLD_STEP }),
				mem
			).some(f => f.includes("unspent")),
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
		// It CROSSES here, which starts the duration clock; the first mention waits for the hold.
		const crossed = 600
		buildFacts(input({ nowSec: crossed, currentGold: 1400 }), mem)
		ok(
			buildFacts(input({ nowSec: crossed + GOLD_MIN_HELD_SEC, currentGold: 1400 }), mem).some(f =>
				f.includes("unspent")
			)
		)
		strictEqual(
			buildFacts(input({ nowSec: crossed + GOLD_MIN_HELD_SEC + 100, currentGold: 1400 }), mem).some(
				f => f.includes("unspent")
			),
			false,
			"a hundred seconds later is still nagging"
		)
		// A different figure: a re-mention needs time AND change, or it is the same sentence twice.
		const at = crossed + GOLD_MIN_HELD_SEC + GOLD_NAG_SEC
		const later = buildFacts(input({ nowSec: at, currentGold: 1450 }), mem)
		// Computed, not hardcoded: the point is that it counts from the CROSSING, not the mention.
		const expectMin = Math.round((at - crossed) / 60)
		ok(
			later.some(f => f.includes(`unspent for ${expectMin} minutes`)),
			`should count from the crossing: ${later.join(" | ")}`
		)
		/*
		 * States the duration and NOTHING about its cause. The previous phrasing, "4m since you
		 * last had a chance", was read as "since you last died" and turned into a fabricated
		 * twelve-minutes-ago anchor — an invented number in a system whose whole premise is that
		 * it never invents numbers.
		 */
		for (const f of later) strictEqual(/since you/.test(f), false, `causal anchor in: ${f}`)
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

	it("counts the unspent duration from when it crossed, not from the last mention", () => {
		/*
		 * Regression: every re-mention reset the clock, so it said "4m" forever — at 23:20 and
		 * again at 27:20, into a game state that had not moved. The player can see that is wrong.
		 */
		const mem = newFactMemory()
		const crossed = 600
		buildFacts(input({ nowSec: crossed, currentGold: 1400 }), mem)
		buildFacts(input({ nowSec: crossed + GOLD_MIN_HELD_SEC, currentGold: 1400 }), mem)
		const at1 = crossed + GOLD_MIN_HELD_SEC + GOLD_NAG_SEC
		const later = buildFacts(input({ nowSec: at1, currentGold: 1500 }), mem)
		ok(
			later.some(f => f.includes(`unspent for ${Math.round((at1 - crossed) / 60)} minutes`)),
			`got: ${later.join(" | ")}`
		)
		const at2 = at1 + GOLD_NAG_SEC
		const later2 = buildFacts(input({ nowSec: at2, currentGold: 1600 }), mem)
		ok(
			later2.some(f => f.includes(`unspent for ${Math.round((at2 - crossed) / 60)} minutes`)),
			`duration must keep growing: ${later2.join(" | ")}`
		)
	})

	it("says nothing about gold while he is on the respawn screen", () => {
		// He is looking at the shop. Telling him his gold is unspent there reads as a scold.
		const mem = newFactMemory()
		deepStrictEqual(buildFacts(input({ meDeadForSec: 15, currentGold: 3000 }), mem), [])
	})

	it("does not repeat the gold line when nothing has changed", () => {
		const mem = newFactMemory()
		buildFacts(input({ nowSec: 600 - GOLD_MIN_HELD_SEC, currentGold: 1400 }), mem)
		buildFacts(input({ nowSec: 600, currentGold: 1400 }), mem)
		deepStrictEqual(
			buildFacts(input({ nowSec: 600 + GOLD_NAG_SEC, currentGold: 1400 }), mem),
			[],
			"same gold, same sentence — say nothing"
		)
	})

	it("forgets gold after a recall", () => {
		const mem = newFactMemory()
		buildFacts(input({ nowSec: holdGold(mem, 1500, 300), currentGold: 1500 }), mem)
		const spentAt = 300 + GOLD_MIN_HELD_SEC + 60
		buildFacts(input({ nowSec: spentAt, currentGold: 200 }), mem) // spent it
		// Accumulating again starts a NEW hold, which must also be respected.
		ok(
			buildFacts(
				input({ nowSec: holdGold(mem, 1300, spentAt + 60), currentGold: 1300 }),
				mem
			).some(f => f.includes("unspent")),
			"after spending, the next accumulation is news"
		)
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
		// Being outnumbered does not make his unspent gold less true.
		const mem = newFactMemory()
		const at = holdGold(mem, 2000, 400)
		const out = buildFacts(input({ nowSec: at, alliesAlive: 1, enemiesAlive: 4, currentGold: 2000 }), mem)
		ok(out.some(f => f.includes("unspent")), `got: ${out.join(" | ")}`)
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
		// Gold rides along from the first turn rather than being primed out of order: a turn whose
		// clock runs backwards is treated as a new game and wipes the memory, as it should.
		const out = [
			...buildFacts(
				input({
					nowSec: t[0],
					currentGold: 2000,
					myEvents: [{ id: 1, name: "DragonKill", stolen: true }]
				}),
				mem
			),
			...buildFacts(
				input({ nowSec: t[1], currentGold: 2000, pace: { cs: 193, expected: 169, exact: false } }),
				mem
			),
			...buildFacts(input({ nowSec: t[2], currentGold: 2000 }), mem),
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
		// The blackout is a window, not a mute button — but gold still needs its own hold.
		const at = holdGold(mem, 3000, 1490 + 120)
		const later = buildFacts(
			input({ nowSec: at, enemyObjectives: [baron(1490)], currentGold: 3000 }),
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
			counterpart: { champion: "Karthus", ward: 40 },
			meWard: 5
		}))
		const farmLines = spoken.flatMap(t => t.lines).filter(f => /CS/.test(f))
		const minutes = (30 * TURN_SEC) / 60
		ok(
			farmLines.length <= minutes / 2,
			`${farmLines.length} CS lines in ${minutes} minutes: ${farmLines.join(" | ")}`
		)
	})

	it("never offers two CS baselines in one list", () => {
		/*
		 * THE CONTRADICTION, at its source. Two baselines for the same subject in one message is
		 * what produced "your 20 farm is not pacing to match your average of 30" and, twenty-five
		 * seconds later, "your 20 farm is not pacing to match your 28 CS average" — same CS, two
		 * averages, and no line in any block ever said either pair. Offer one CS fact or none.
		 *
		 * The counterpart's CS was the second baseline and is now deleted outright, so this holds
		 * by construction — which is a reason to keep asserting it, not to stop.
		 */
		const out = buildFacts(
			input({
				nowSec: 900,
				pace: { cs: 100, expected: 140, exact: true },
				counterpart: { champion: "Karthus", level: 12, ward: 40 },
				meLevel: 10,
				meWard: 5
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

	/*
	 * THE COMEBACK LINE IS GONE WITH THE RACE IT WAS ABOUT.
	 *
	 * "you've pulled 12 CS back on Karthus" was the best encouragement this coach had, and it was
	 * built on the enemy jungler's `creepScore` — a count of what this player's own client
	 * witnessed, which read 70 against a true 183 over one audited game. A swing in that number is
	 * a swing in how much of Karthus's farm he happened to SEE, so the comeback was as likely to
	 * be a report on his own vision as on his own clear. It is not replaceable by a better
	 * threshold, and nothing here pretends otherwise.
	 */
	it("makes no comeback claim about the enemy jungler's farm, at any gap", () => {
		const mem = newFactMemory()
		const lines = [600, 600 + ROUTINE_GAP_SEC * 2, 600 + ROUTINE_GAP_SEC * 4].flatMap(nowSec =>
			buildFacts(
				input({
					nowSec,
					pace: { cs: 60 + nowSec / 10, expected: 70 + nowSec / 10, exact: true },
					counterpart: { champion: "Karthus", level: 11, ward: 30 },
					meLevel: 11,
					meWard: 28
				}),
				mem
			)
		)
		strictEqual(
			lines.some(f => /pulled .* back on/.test(f) || /up on Karthus/.test(f)),
			false,
			lines.join(" | ")
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

	it("does not spend the gold cooldown on a turn where gold was withheld", () => {
		const mem = newFactMemory()
		const ready = holdGold(mem, 2000, 300)
		// A window is offered on the same turn the gold becomes sayable, and wins.
		const first = buildFacts(
			input({
				nowSec: ready,
				currentGold: 2000,
				deadEnemies: [
					{ champion: "Karthus", respawnSec: 40, isJungler: true },
					{ champion: "Jinx", respawnSec: 35 }
				]
			}),
			mem
		)
		ok(first.some(f => /of them are dead/.test(f)), first.join(" | "))
		strictEqual(first.some(f => /unspent/.test(f)), false, "the window is offered alone")
		ok(
			buildFacts(input({ nowSec: ready + ROUTINE_GAP_SEC, currentGold: 2000 }), mem).some(f =>
				/unspent/.test(f)
			),
			"gold was withheld, not spent"
		)
	})
})

/*
 * THE VISION RACE — what the counterpart comparison is now measured on.
 *
 * `wardScore` is the one cross-player field the audit found exact for enemies: over all ten
 * players of game 5639406342 the live float sat a median 0.7 above the post-game integer, which
 * is the post-game figure being floored. It is the only race left that is both true and invisible.
 */
describe("buildFacts — the vision race", () => {
	const cp = (ward: number): Partial<FactInput> => ({
		counterpart: { champion: "Karthus", ward },
		meWard: 5
	})

	it("names the counterpart's ward-score lead once it is worth a sentence", () => {
		const out = buildFacts(input({ nowSec: VISION_MIN_SEC, ...cp(30) }), newFactMemory())
		ok(
			out.some(f => /Karthus is 25 points of vision score up on you/.test(f)),
			out.join(" | ")
		)
	})

	it("says nothing about a gap inside the noise of one trinket charge", () => {
		const out = buildFacts(input({ nowSec: VISION_MIN_SEC, ...cp(9) }), newFactMemory())
		strictEqual(out.some(f => /vision score/.test(f)), false, out.join(" | "))
	})

	it("waits for the game to be old enough for a ward score to mean anything", () => {
		const out = buildFacts(input({ nowSec: VISION_MIN_SEC - 60, ...cp(40) }), newFactMemory())
		strictEqual(out.some(f => /vision score/.test(f)), false, out.join(" | "))
	})

	it("does not recite a gap that is widening on its own", () => {
		/*
		 * The exact failure the retired CS race left behind: six lines reciting a number that grew
		 * without him doing anything about it. Said once here, deliberately.
		 */
		const mem = newFactMemory()
		const spoken = session(
			40,
			nowSec => ({ counterpart: { champion: "Karthus", ward: nowSec / 20 }, meWard: 5 }),
			mem,
			VISION_MIN_SEC
		)
		const races = spoken.flatMap(t => t.lines).filter(f => /vision score up on you/.test(f))
		strictEqual(races.length, 1, `a widening gap is one line, not many: ${races.join(" | ")}`)
	})

	it("never says a lead — there is no decision in being ahead on wards", () => {
		const out = buildFacts(
			input({ nowSec: VISION_MIN_SEC, counterpart: { champion: "Karthus", ward: 2 }, meWard: 40 }),
			newFactMemory()
		)
		strictEqual(out.some(f => /vision score/.test(f)), false, out.join(" | "))
	})
})

/*
 * THE LEVEL RACE, and the hold rule that makes an enemy level safe to quote.
 *
 * `level` is exact for him and his allies and 94.5% for enemies. The 5.5% is staleness with a
 * shape: a frozen row is wrong by at most two, always too LOW, and snaps to truth on sight. Too
 * low on the enemy row invents a lead for him, which is the direction the deleted CS counter lied
 * in, so the same care applies.
 */
describe("buildFacts — the level race", () => {
	const held = LEVEL_MIN_SEC + LEVEL_HOLD_SEC

	it("will not quote a level gap that has not survived the hold", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({ nowSec: LEVEL_MIN_SEC, counterpart: { champion: "Karthus", level: 12 }, meLevel: 10 }),
			mem
		)
		strictEqual(out.some(f => /levels/.test(f)), false, out.join(" | "))
	})

	it("quotes it once the same gap is still there after the hold", () => {
		const mem = newFactMemory()
		buildFacts(
			input({ nowSec: LEVEL_MIN_SEC, counterpart: { champion: "Karthus", level: 12 }, meLevel: 10 }),
			mem
		)
		const out = buildFacts(
			input({ nowSec: held, counterpart: { champion: "Karthus", level: 12 }, meLevel: 10 }),
			mem
		)
		ok(out.some(f => /Karthus is 2 levels up on you/.test(f)), out.join(" | "))
	})

	it("forgets the hold when the gap closes, so a flicker never accumulates one", () => {
		/*
		 * A stale enemy row reads a level or two behind and CORRECTS ITSELF on the next sighting.
		 * Measured on game 5639406342, Kayn read low at 2:00, 3:00, 6:00, 11:00 and 20:00 and read
		 * exactly right at the whistle. Every one of those is a gap that appears and closes, and
		 * the clock has to go back to zero each time or five artefacts add up to a claim.
		 */
		const mem = newFactMemory()
		buildFacts(
			input({ nowSec: LEVEL_MIN_SEC, counterpart: { champion: "Karthus", level: 12 }, meLevel: 10 }),
			mem
		)
		// Sighted: the row snaps and the gap is gone.
		buildFacts(
			input({
				nowSec: LEVEL_MIN_SEC + LEVEL_HOLD_SEC - 5,
				counterpart: { champion: "Karthus", level: 10 },
				meLevel: 10
			}),
			mem
		)
		const out = buildFacts(
			input({ nowSec: held, counterpart: { champion: "Karthus", level: 12 }, meLevel: 10 }),
			mem
		)
		strictEqual(out.some(f => /levels/.test(f)), false, out.join(" | "))
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
				fight: { quiet: false, line: "that fight happened without you" }
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

	it("holds his gold while he is standing in the shop", () => {
		/*
		 * MEASURED: the one `impossible` gold verdict in four games is "he spent it: 373 gold when
		 * it lands, was told 2511" — built while he was in the fountain buying. Nothing in the
		 * client says so; the frame does.
		 */
		const mem = newFactMemory()
		const at = holdGold(mem, 2000, 400)
		const inBase = buildFacts(
			input({ nowSec: at, currentGold: 2000, frame: { where: "base", atSec: at, confidence: "medium" } }),
			mem
		)
		strictEqual(inBase.some(f => f.includes("unspent")), false, `got: ${inBase.join(" | ")}`)
		// Delayed, never deleted: the clock kept running, so it is still there when he walks out.
		ok(
			buildFacts(input({ nowSec: at + 60, currentGold: 2000 }), mem).some(f => f.includes("unspent"))
		)
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
		{ fight: { quiet: false, line: "that fight was 0 for 3 without you", kind: "fight-absent" } }
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
		const mem = newFactMemory()
		const at = holdGold(mem, 2000, 400)
		ok(
			buildFacts(input({ nowSec: at, currentGold: 2000 }), mem, { path: "turn" }).some(f =>
				f.includes("unspent")
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

/**
 * THE GUARD. If this file ever cites the enemy jungler's CS again, this fails.
 *
 * Not a style test. `scores.creepScore` on an ENEMY row is a count of what THIS player's client
 * witnessed, and the audit in `scripts/audit-live-fields.ts` put it at 70 against a true 183 over
 * one full game, exact at 2 of 29 checkpoints against 29 of 29 for every other player in the
 * lobby. It is the one field in the feed whose error lands on the one comparison this app was
 * built to make, and it lands in the direction that flatters him — "you are at least 91 CS up on
 * Kayn", said to a man 18 CS behind, on the game he graded 0/10.
 *
 * The field is still in the payload and it is still the most tempting thing in it, so the rule is
 * asserted three ways: the input type does not carry it, no sentence this function returns pairs
 * the counterpart with a CS figure, and the source of the two files on the coach's path does not
 * read an enemy's `creepScore` at all.
 */
describe("buildFacts — the enemy jungler's CS may never come back", () => {
	it("never pairs the counterpart with a CS figure, over a whole simulated game", () => {
		/*
		 * Driven with every counterpart field populated and moving, because the failure this
		 * guards was not one rule — it was three (the race, the swing and the settle) all reading
		 * one field. A replacement rule that reached for it again would be a fourth.
		 */
		const mem = newFactMemory()
		const spoken = session(
			60,
			nowSec => ({
				pace: { cs: Math.round(nowSec / 6), expected: Math.round(nowSec / 3), exact: true },
				counterpart: {
					champion: "Karthus",
					level: 6 + Math.floor(nowSec / 120),
					ward: nowSec / 30,
					killShare: 0.6,
					items: ["Hubris"]
				},
				meLevel: 5 + Math.floor(nowSec / 130),
				meWard: nowSec / 90,
				myKillShare: 0.2
			}),
			mem,
			60
		)
		const lines = spoken.flatMap(t => t.lines)
		ok(lines.length > 0, "the session has to actually say things for this to prove anything")
		const offenders = lines.filter(f => /Karthus/.test(f) && /\bCS\b/.test(f))
		deepStrictEqual(offenders, [], `a counterpart CS comparison came back: ${offenders.join(" | ")}`)
	})

	it("does not accept a counterpart CS even when a caller tries to pass one", () => {
		/*
		 * The type forbids it, and a type is erased at runtime — `--experimental-strip-types` means
		 * a JavaScript caller, a JSON fixture or a cast lands the field on the object anyway. So
		 * the behaviour is asserted with the field actually present.
		 */
		const mem = newFactMemory()
		const cp = { champion: "Karthus", level: 12, ward: 30 }
		Object.assign(cp, { cs: 70 })
		const out = buildFacts(
			input({
				nowSec: 1200,
				pace: { cs: 160, expected: 150, exact: true },
				counterpart: cp,
				meLevel: 12,
				meWard: 5
			}),
			mem
		)
		strictEqual(
			out.some(f => /Karthus/.test(f) && /\bCS\b/.test(f)),
			false,
			out.join(" | ")
		)
	})

	it("reads no enemy creepScore anywhere on the coach's path", () => {
		/*
		 * The two files the spoken line is actually built from. The live board renders a labelled
		 * "CS he has been seen to clear" for the human, which is a different thing and lives
		 * elsewhere; nothing the MODEL is handed may carry the number at all.
		 */
		for (const file of ["src/analysis/live-facts.ts", "src/shared/live-state.ts"]) {
			const src = readFileSync(file, "utf8")
			const code = src
				// Comments are where the measurement is written down, so they must be free to name it.
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/\/\/[^\n]*/g, "")
			strictEqual(/creepScore/.test(code), false, `${file} reads creepScore in code`)
			strictEqual(
				/counterpart[^\n]*\bcs\b/.test(code),
				false,
				`${file} puts a cs field on the counterpart`
			)
		}
	})
})

/**
 * HIS OWN SPIKE — the sentence the model kept trying to say and could not support.
 *
 * "hit recall to finish your Liandry's Torment" was the largest cluster of false live lines, and
 * the arithmetic behind it is now exact (`shared/items.ts`). What is asserted here is the GATE:
 * the line may only exist when a back actually turns his gold into the item.
 */
describe("buildFacts — what he is about to finish", () => {
	const near = (over: Partial<FactInput>): string[] =>
		buildFacts(input({ nowSec: 640, currentGold: 1067, ...over }), newFactMemory())

	it("names the item and the exact gold when a back would finish it", () => {
		const out = near({ myBuild: { target: "Liandry's Torment", remaining: 800, ready: true } })
		ok(
			out.some(f => /Liandry's Torment is 800 gold away and you have 1067/.test(f)),
			out.join(" | ")
		)
	})

	it("stays quiet when he cannot afford the rest of it", () => {
		/*
		 * The measured failure, exactly: at 10:39 of one recorded game the coach said "take one
		 * camp right out of base for the seventy gold you need to finish Liandry's" while he held
		 * 731g against 800 left to pay. The number in that sentence was invented; the gap was 69.
		 */
		const out = near({ currentGold: 731, myBuild: { target: "Liandry's Torment", remaining: 800, ready: true } })
		strictEqual(out.some(f => /Liandry/.test(f)), false, out.join(" | "))
	})

	it("stays quiet when pieces still have to be BOUGHT, however much gold he has", () => {
		/*
		 * "recall right now to finish your Zhonya's with that twenty-nine hundred gold", said nine
		 * times across the corpus while a Needlessly Large Rod and two Amplifying Tomes were still
		 * in the shop. Gold is not the only thing between him and the item, and `ready` is the part
		 * the old payload could not express at all.
		 */
		const out = near({
			currentGold: 2900,
			myBuild: { target: "Zhonya's Hourglass", remaining: 2650, ready: false }
		})
		strictEqual(out.some(f => /Zhonya/.test(f)), false, out.join(" | "))
	})

	it("says it once per item and never nags", () => {
		const mem = newFactMemory()
		const b = { target: "Liandry's Torment", remaining: 800, ready: true }
		const first = buildFacts(input({ nowSec: 640, currentGold: 1067, myBuild: b }), mem)
		ok(first.some(f => /Liandry/.test(f)), first.join(" | "))
		const again = buildFacts(
			input({ nowSec: 640 + ROUTINE_GAP_SEC * 3, currentGold: 1500, myBuild: b }),
			mem
		)
		strictEqual(again.some(f => /Liandry/.test(f)), false, again.join(" | "))
	})

	it("has nothing to say when nothing is in progress", () => {
		const out = near({ myBuild: null })
		strictEqual(out.some(f => /gold away/.test(f)), false, out.join(" | "))
	})
})
