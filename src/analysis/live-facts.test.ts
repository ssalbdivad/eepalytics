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
	newFactMemory,
	FARM_COOLDOWN_SEC,
	GOLD_NAG_SEC,
	GOLD_STEP,
	MAX_FACTS
} from "./live-facts.ts"
import type { FactInput } from "./live-facts.ts"

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
		ok(DEATH_FACT.test(first[0]!), "nothing else was on offer, so the death leads")

		const second = buildFacts(
			input({
				nowSec: 640,
				deadEnemies: [{ champion: "Jinx", respawnSec: 30 }],
				currentGold: 1500
			}),
			mem
		)
		strictEqual(
			second.some(f => DEATH_FACT.test(f)),
			false,
			"a death was offered last turn, so none may be offered this turn — demoting was not enough"
		)
		ok(second.some(f => f.includes("unspent")), "the other fact is still offered")

		// And the turn after that, deaths are available again.
		const third = buildFacts(
			input({ nowSec: 700, deadEnemies: [{ champion: "Karma", respawnSec: 30 }] }),
			mem
		)
		ok(third.some(f => DEATH_FACT.test(f)), "alternation, not suppression")
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
		ok(after.some(f => DEATH_FACT.test(f)), "silence must clear the alternation")
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
		// A different figure: a re-mention needs time AND change, or it is the same sentence twice.
		const later = buildFacts(input({ nowSec: 600 + GOLD_NAG_SEC, currentGold: 1450 }), mem)
		ok(later.some(f => f.includes("unspent for 4 minutes")), "four minutes on, it has earned a re-mention")
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
		buildFacts(input({ nowSec: 600, currentGold: 1400 }), mem)
		const later = buildFacts(input({ nowSec: 600 + GOLD_NAG_SEC, currentGold: 1500 }), mem)
		ok(later.some(f => f.includes("unspent for 4 minutes")), `got: ${later.join(" | ")}`)
		const later2 = buildFacts(input({ nowSec: 600 + GOLD_NAG_SEC * 2, currentGold: 1600 }), mem)
		ok(later2.some(f => f.includes("unspent for 8 minutes")), `duration must keep growing: ${later2.join(" | ")}`)
	})

	it("says nothing about gold while he is on the respawn screen", () => {
		// He is looking at the shop. Telling him his gold is unspent there reads as a scold.
		const mem = newFactMemory()
		deepStrictEqual(buildFacts(input({ meDeadForSec: 15, currentGold: 3000 }), mem), [])
	})

	it("does not repeat the gold line when nothing has changed", () => {
		const mem = newFactMemory()
		buildFacts(input({ nowSec: 600, currentGold: 1400 }), mem)
		deepStrictEqual(
			buildFacts(input({ nowSec: 600 + GOLD_NAG_SEC, currentGold: 1400 }), mem),
			[],
			"same gold, same sentence — say nothing"
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
		ok(buildFacts(input({ nowSec: 600, pace }), mem).some(f => /CS (down|up) on your own pace/.test(f)))
		strictEqual(
			buildFacts(input({ nowSec: 660, pace }), mem).some(f => /CS (down|up) on your own pace/.test(f)),
			false,
			"a minute later is nagging"
		)
		ok(
			buildFacts(
				// Past the cooldown AND he has actually farmed since — both are required.
				input({ nowSec: 600 + FARM_COOLDOWN_SEC, pace: { cs: 130, expected: 165, exact: true } }),
				mem
			).some(f => /CS (down|up) on your own pace/.test(f)),
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
					{ champion: "Graves", respawnSec: 30 },
					{ champion: "Jinx", respawnSec: 28 }
				]
			}),
			mem
		)
		ok(out[0]!.includes("up in 8 seconds"), `must name his own respawn, got: ${out[0]}`)
		ok(out[0]!.includes("20 seconds of window"), `must subtract it, got: ${out[0]}`)
	})

	it("says nothing when he respawns after they do", () => {
		const mem = newFactMemory()
		const out = buildFacts(
			input({
				meDeadForSec: 19,
				deadEnemies: [
					{ champion: "Graves", respawnSec: 22 },
					{ champion: "Jinx", respawnSec: 20 }
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
			input({ meDeadForSec: 20, deadEnemies: [{ champion: "Graves", respawnSec: 25 }] }),
			mem
		)
		deepStrictEqual(out, [])
	})

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
		ok(out[0]!.includes("18 seconds"), `must use the shortest timer, got: ${out[0]}`)
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
				deadEnemies: [{ champion: "Graves", respawnSec: 21 }]
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
				deadEnemies: [{ champion: "Graves", respawnSec: 21 }]
			}),
			mem
		)
		ok(out.some(f => DEATH_FACT.test(f)))
	})

	it("still says the things he can act on alone", () => {
		// Being outnumbered does not make his unspent gold less true.
		const mem = newFactMemory()
		const out = buildFacts(input({ alliesAlive: 1, enemiesAlive: 4, currentGold: 2000 }), mem)
		ok(out.some(f => f.includes("unspent")))
	})
})

describe("buildFacts — objectives", () => {
	it("calls an objective that is coming back soon", () => {
		const mem = newFactMemory()
		const out = buildFacts(input({ baronBackInSec: 40 }), mem)
		ok(out.some(f => f.includes("Baron is back in 40 seconds")), `got: ${out.join(" | ")}`)
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
		const mem = newFactMemory()
		const out = [
			...buildFacts(input({ myEvents: [{ id: 1, name: "DragonKill", stolen: true }] }), mem),
			...buildFacts(input({ nowSec: 700, pace: { cs: 193, expected: 169, exact: false } }), mem),
			...buildFacts(input({ nowSec: 800, currentGold: 2000 }), mem),
			...buildFacts(
				input({ nowSec: 900, deadEnemies: [{ champion: "Graves", respawnSec: 30 }] }),
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
					{ champion: "Graves", respawnSec: 30 },
					{ champion: "Jinx", respawnSec: 28 },
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
				deadEnemies: [{ champion: "Graves", respawnSec: 30 }],
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
					{ champion: "Ashe", respawnSec: 28 }
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
		const later = buildFacts(
			input({
				nowSec: 1490 + 200,
				enemyObjectives: [baron(1490)],
				currentGold: 3000
			}),
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
