/**
 * The live coach's quality is decided here, so it is pinned here.
 *
 * Every case below is a failure a judge or the owner found in a real session and a structural rule
 * that was added to stop it. They are not hypotheticals: "the same corpse announced on every poll",
 * "four drake timers in one session" and "chose a fourth Morgana timer over an explicit
 * unspent-gold flag beside it" all happened, and all are one regression away from happening again.
 *
 * The newest group of them is the SAY / CONTEXT split. The coach was true and useless — "Drake is
 * back in 52s", "You have 1334g sitting unspent", "Wukong just died for 32s", all of it on his own
 * screen while it was read to him. So the tests below assert twice about most facts: that it is
 * still computed, and that it is no longer a sentence.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import {
	buildFacts,
	newFactMemory,
	FARM_COOLDOWN_SEC,
	GOLD_NAG_SEC,
	MAX_CONTEXT,
	MAX_FACTS,
	TOPIC_COOLDOWN_SEC
} from "./live-facts.ts"
import type { FactInput, FactSet } from "./live-facts.ts"

const input = (over: Partial<FactInput> = {}): FactInput => ({
	nowSec: 600,
	meDeadForSec: null,
	myHpFrac: null,
	alliesAlive: 5,
	enemiesAlive: 5,
	deadEnemies: [],
	currentGold: null,
	pace: null,
	myEvents: [],
	fights: [],
	drakeBackInSec: null,
	baronBackInSec: null,
	heraldBackInSec: null,
	...over
})

/** What the coach may actually say this turn. */
const said = (f: FactSet): string[] => f.say.map(s => s.line)
/** What it may only reason from. */
const bg = (f: FactSet): string[] => f.context.map(c => c.line)

const fight = (over: Partial<FactInput["fights"][number]> = {}) => ({
	id: "f1",
	atSec: 590,
	won: 0,
	lost: 0,
	involved: false,
	died: false,
	...over
})

describe("buildFacts — the two tests", () => {
	it("demotes a lone enemy death to context: he can see the greyed portrait", () => {
		/*
		 * The owner's transcript: "Wukong just died for 32s". True, and one tab away. It is not
		 * deleted — the timer must stay in the block or the model invents one, which is measured
		 * ("Qiyana is down for 8 seconds", when Qiyana had none) — it just cannot be the sentence.
		 */
		const out = buildFacts(
			input({ deadEnemies: [{ champion: "Wukong", respawnSec: 32 }] }),
			newFactMemory()
		)
		deepStrictEqual(said(out), [])
		ok(
			bg(out).some(c => c.includes("Wukong is down 32s")),
			`the timer must survive as context, got: ${bg(out).join(" | ")}`
		)
	})

	it("demotes a bare objective timer: it is printed beside his minimap", () => {
		// Four of these in one session is the same sentence with a smaller number each time.
		const out = buildFacts(input({ drakeBackInSec: 52 }), newFactMemory())
		deepStrictEqual(said(out), [])
		ok(bg(out).some(c => c === "Drake is back in 52s"))
	})

	it("demotes bare unspent gold: it is the biggest number on his HUD", () => {
		/*
		 * Three unspent-gold lines in the owner's transcript. The number is kept as context and
		 * becomes a sentence only composed with a reason to go back — see the next test.
		 */
		const out = buildFacts(
			input({ currentGold: 1334, deadEnemies: [{ champion: "Wukong", respawnSec: 32 }] }),
			newFactMemory()
		)
		strictEqual(said(out).some(s => s.includes("1334")), false)
		ok(bg(out).some(c => c === "he has 1334g unspent"))
	})

	it("keeps the farm gap spoken — it is his own history and is on no screen", () => {
		const out = buildFacts(
			input({ pace: { cs: 130, expected: 148, exact: true } }),
			newFactMemory()
		)
		ok(
			said(out).some(s => s.includes("130") && s.includes("148")),
			`got: ${said(out).join(" | ")}`
		)
	})

	it("never writes a context line as a script", () => {
		/*
		 * The second lock on the split: spoken facts are second person because they ARE the
		 * sentence, context is third person so a model reading one out produces an audibly wrong
		 * "he has 1334g unspent" instead of a plausible line.
		 */
		const out = buildFacts(
			input({
				currentGold: 1500,
				myHpFrac: 0.31,
				pace: { cs: 100, expected: 104, exact: true },
				deadEnemies: [{ champion: "Wukong", respawnSec: 32 }],
				drakeBackInSec: 40
			}),
			newFactMemory()
		)
		ok(bg(out).length >= 4, `expected several context lines, got ${bg(out).length}`)
		for (const c of bg(out)) strictEqual(/\byou\b|\byour\b/i.test(c), false, `a script: ${c}`)
	})

	it("caps the context so the block does not become something to read from", () => {
		const out = buildFacts(
			input({
				currentGold: 1500,
				myHpFrac: 0.2,
				pace: { cs: 100, expected: 104, exact: true },
				deadEnemies: [
					{ champion: "Wukong", respawnSec: 32 },
					{ champion: "Jinx", respawnSec: 30 },
					{ champion: "Karma", respawnSec: 28 },
					{ champion: "Viego", respawnSec: 26 }
				],
				drakeBackInSec: 40,
				baronBackInSec: 50,
				heraldBackInSec: 20
			}),
			newFactMemory()
		)
		ok(bg(out).length <= MAX_CONTEXT, `expected at most ${MAX_CONTEXT}, got ${bg(out).length}`)
	})
})

describe("buildFacts — composition is what earns a sentence", () => {
	it("composes gold with the objective it should be spent before", () => {
		/*
		 * Neither half is worth saying: he can see his gold and he can see the drake timer. The
		 * product is a decision and is on no screen. This is also the exact tail the prompt bans
		 * as an invention — legitimate here because both figures come from one tick of one block.
		 */
		const out = buildFacts(input({ currentGold: 1450, drakeBackInSec: 45 }), newFactMemory())
		const line = said(out)[0] ?? ""
		ok(line.includes("1450") && line.includes("45s"), `got: ${line}`)
		ok(line.includes("back now"), `must name the decision, got: ${line}`)
	})

	it("does not compose with an objective that is four minutes out", () => {
		// Nothing to do about a Baron at 240s, so the gold is context and the timer is not offered.
		const out = buildFacts(input({ currentGold: 1450, baronBackInSec: 240 }), newFactMemory())
		deepStrictEqual(said(out), [])
	})

	it("turns the enemy jungler's death into a decision, not a character note", () => {
		/*
		 * The owner's example of a worthless line, verbatim: "Viego is your jungle counterpart so
		 * watch for his ganks." True in every game he has ever played. This is the same subject
		 * multiplied by state, and it is true for 34 seconds.
		 */
		const out = buildFacts(
			input({ deadEnemies: [{ champion: "Viego", respawnSec: 34, isJungler: true }] }),
			newFactMemory()
		)
		const line = said(out)[0] ?? ""
		ok(line.includes("Viego is down 34s"), `got: ${line}`)
		ok(line.includes("camps"), `must name what it buys, got: ${line}`)
	})

	it("composes the jungler's death with an objective when there is one", () => {
		const out = buildFacts(
			input({
				deadEnemies: [{ champion: "Viego", respawnSec: 40, isJungler: true }],
				drakeBackInSec: 20
			}),
			newFactMemory()
		)
		const line = said(out)[0] ?? ""
		ok(line.includes("Viego") && line.includes("drake") && line.includes("20s"), `got: ${line}`)
	})

	it("leaves a laner's death as context even when an objective is up", () => {
		// Only the jungler's death changes what a jungler may safely do next.
		const out = buildFacts(
			input({ deadEnemies: [{ champion: "Jinx", respawnSec: 40 }], drakeBackInSec: 20 }),
			newFactMemory()
		)
		deepStrictEqual(said(out), [])
	})

	it("composes a window with the objective it is a window for", () => {
		const out = buildFacts(
			input({
				deadEnemies: [
					{ champion: "Graves", respawnSec: 30 },
					{ champion: "Jinx", respawnSec: 25 }
				],
				drakeBackInSec: 12
			}),
			newFactMemory()
		)
		const line = said(out)[0] ?? ""
		ok(line.includes("2 of them are dead") && line.includes("drake"), `got: ${line}`)
	})
})

describe("buildFacts — fights", () => {
	it("leads on a fight his team lost without him", () => {
		/*
		 * The owner asked for this in as many words — "give more feedback on fights not just
		 * camps" — and it was not a tuning problem: there was no fight fact of any kind, so the
		 * best possible output was a well-phrased camp count.
		 */
		const out = buildFacts(
			input({
				fights: [fight({ won: 1, lost: 3, involved: false })],
				currentGold: 2000,
				pace: { cs: 100, expected: 140, exact: true }
			}),
			newFactMemory()
		)
		strictEqual(said(out).length, 1, "a fight is offered alone")
		ok(said(out)[0]!.includes("1 for 3"), `got: ${said(out)[0]}`)
	})

	it("claims nothing about where he was", () => {
		/*
		 * The live API has no positions for anybody. Absence is the absence of his name from every
		 * side of the cluster, which the feed proves; "you should have been there" would be an
		 * invention wearing a coaching voice.
		 */
		const out = buildFacts(
			input({ fights: [fight({ won: 1, lost: 3 })] }),
			newFactMemory()
		)
		const line = said(out)[0] ?? ""
		strictEqual(/\bmid\b|\btop\b|\bbot\b|\briver\b|should have been/i.test(line), false, line)
	})

	it("does not blame a corpse for missing a fight", () => {
		const out = buildFacts(
			input({ meDeadForSec: 20, fights: [fight({ won: 1, lost: 3 })] }),
			newFactMemory()
		)
		deepStrictEqual(said(out), [])
	})

	it("credits a life traded for two", () => {
		const out = buildFacts(
			input({ fights: [fight({ won: 2, lost: 1, involved: true, died: true })] }),
			newFactMemory()
		)
		ok(said(out)[0]!.includes("you went down but that one was 2 for 1"), `got: ${said(out)[0]}`)
	})

	it("says one thing about one fight, however long it stays fresh", () => {
		const mem = newFactMemory()
		const f = [fight({ won: 1, lost: 3 })]
		ok(said(buildFacts(input({ nowSec: 600, fights: f }), mem)).length > 0)
		deepStrictEqual(said(buildFacts(input({ nowSec: 605, fights: f }), mem)), [])
	})

	it("forgets a fight that is a minute old", () => {
		// He has moved on and so has the map; a stale skirmish is a story, not coaching.
		const out = buildFacts(
			input({ nowSec: 700, fights: [fight({ atSec: 600, won: 1, lost: 3 })] }),
			newFactMemory()
		)
		deepStrictEqual(said(out), [])
	})

	it("outranks farm, gold and a window", () => {
		const out = buildFacts(
			input({
				fights: [fight({ won: 0, lost: 3, involved: true, died: true })],
				deadEnemies: [
					{ champion: "Graves", respawnSec: 30 },
					{ champion: "Jinx", respawnSec: 25 }
				],
				currentGold: 3000,
				pace: { cs: 100, expected: 140, exact: true }
			}),
			newFactMemory()
		)
		strictEqual(said(out).length, 1)
		ok(said(out)[0]!.includes("0 for 3 and cost you"), `got: ${said(out)[0]}`)
	})

	it("ignores a single kill — that is a kill feed, not a fight", () => {
		const out = buildFacts(input({ fights: [fight({ won: 1, lost: 0 })] }), newFactMemory())
		deepStrictEqual(said(out), [])
	})
})

describe("buildFacts — repetition", () => {
	it("will not offer the same KIND of fact two turns running", () => {
		/*
		 * The per-fact limits were not enough and the transcript proves it: four drake timers and
		 * three unspent-gold lines were four and three DIFFERENT facts by the old rules, because
		 * each carried a new number. What the listener hears is one sentence over and over.
		 */
		const mem = newFactMemory()
		const first = buildFacts(
			input({ nowSec: 600, fights: [fight({ id: "a", atSec: 598, won: 1, lost: 3 })] }),
			mem
		)
		ok(said(first).length > 0)
		const second = buildFacts(
			input({ nowSec: 620, fights: [fight({ id: "b", atSec: 618, won: 0, lost: 2 })] }),
			mem
		)
		deepStrictEqual(said(second), [], "a second fight line 20s later is a monologue")
	})

	it("lets a topic back in once its cooldown has run", () => {
		const mem = newFactMemory()
		buildFacts(input({ nowSec: 600, fights: [fight({ id: "a", atSec: 598, won: 1, lost: 3 })] }), mem)
		// Something else has to be said in between, or the alternation rule alone would hold it.
		buildFacts(input({ nowSec: 700, pace: { cs: 100, expected: 140, exact: true } }), mem)
		const later = buildFacts(
			input({
				nowSec: 600 + TOPIC_COOLDOWN_SEC.fight + 5,
				fights: [fight({ id: "c", atSec: 640, won: 0, lost: 2 })]
			}),
			mem
		)
		ok(said(later).length > 0, "a new fight after the cooldown is genuinely new")
	})

	it("does not repeat an unchanged gold figure because a timer fired", () => {
		const mem = newFactMemory()
		ok(said(buildFacts(input({ nowSec: 600, currentGold: 1400, drakeBackInSec: 40 }), mem)).length > 0)
		deepStrictEqual(
			said(buildFacts(input({ nowSec: 600 + GOLD_NAG_SEC, currentGold: 1400, drakeBackInSec: 40 }), mem)),
			[],
			"same number, same state — an unchanged criticism restated is how he learns to tune it out"
		)
	})

	it("resets the gold clock when he spends it", () => {
		const mem = newFactMemory()
		buildFacts(input({ nowSec: 600, currentGold: 1500, drakeBackInSec: 40 }), mem)
		buildFacts(input({ nowSec: 660, currentGold: 200 }), mem) // spent it
		const again = buildFacts(input({ nowSec: 900, currentGold: 1300, drakeBackInSec: 40 }), mem)
		ok(said(again).some(s => s.includes("1300")), "a fresh 1300g is fresh news")
	})

	it("does not restate the farm gap while his CS has not moved", () => {
		/*
		 * Measured: stated three times in ten minutes with a bigger number each time, during a
		 * stretch where his CS had not changed at all — the deficit grew purely because the
		 * expected-pace curve keeps rising. That is scolding someone with a number they cannot
		 * affect between mentions.
		 */
		const mem = newFactMemory()
		ok(said(buildFacts(input({ nowSec: 600, pace: { cs: 100, expected: 130, exact: true } }), mem)).length > 0)
		const frozen = buildFacts(
			input({ nowSec: 600 + FARM_COOLDOWN_SEC + 10, pace: { cs: 100, expected: 140, exact: true } }),
			mem
		)
		deepStrictEqual(said(frozen), [])
		const moved = buildFacts(
			input({ nowSec: 600 + FARM_COOLDOWN_SEC * 2, pace: { cs: 120, expected: 160, exact: true } }),
			mem
		)
		ok(said(moved).length > 0, "once his CS has moved the comparison is new")
	})

	it("stays quiet about a farm gap that is inside the noise", () => {
		const out = buildFacts(
			input({ pace: { cs: 100, expected: 104, exact: true } }),
			newFactMemory()
		)
		deepStrictEqual(said(out), [])
	})

	it("marks an interpolated farm reading as approximate", () => {
		const out = buildFacts(
			input({ pace: { cs: 100, expected: 130, exact: false } }),
			newFactMemory()
		)
		ok(said(out)[0]!.includes("roughly"), "a between-checkpoints reading must carry its hedge")
	})
})

describe("buildFacts — the window", () => {
	it("subtracts his own respawn from the window he is offered", () => {
		/*
		 * Regression: told a corpse "two are down, you have about 14s" while his own respawn was
		 * 19s — he came back after they did, so the window did not exist. His timer was in the
		 * block the whole time and was simply never read.
		 */
		const out = buildFacts(
			input({
				meDeadForSec: 8,
				deadEnemies: [
					{ champion: "Graves", respawnSec: 30 },
					{ champion: "Jinx", respawnSec: 28 }
				]
			}),
			newFactMemory()
		)
		ok(said(out)[0]!.includes("up in 8s"), `must name his own respawn, got: ${said(out)[0]}`)
		ok(said(out)[0]!.includes("20s of window"), `must subtract it, got: ${said(out)[0]}`)
	})

	it("says nothing when he respawns after they do", () => {
		const out = buildFacts(
			input({
				meDeadForSec: 19,
				deadEnemies: [
					{ champion: "Graves", respawnSec: 22 },
					{ champion: "Jinx", respawnSec: 20 }
				]
			}),
			newFactMemory()
		)
		strictEqual(said(out).some(s => s.includes("of them are dead")), false)
	})

	it("counts the window from the shortest timer", () => {
		const out = buildFacts(
			input({
				deadEnemies: [
					{ champion: "Graves", respawnSec: 30 },
					{ champion: "Jinx", respawnSec: 18 }
				]
			}),
			newFactMemory()
		)
		ok(said(out)[0]!.includes("2 of them are dead"), `got: ${said(out)[0]}`)
		ok(said(out)[0]!.includes("18s"), `must use the shortest timer, got: ${said(out)[0]}`)
	})

	it("does not call a window when one of them is already walking back", () => {
		const out = buildFacts(
			input({
				deadEnemies: [
					{ champion: "Graves", respawnSec: 30 },
					{ champion: "Jinx", respawnSec: 4 }
				]
			}),
			newFactMemory()
		)
		strictEqual(said(out).some(s => s.includes("of them are dead")), false)
	})

	it("collapses four dead enemies into one window, not four timers", () => {
		const out = buildFacts(
			input({
				deadEnemies: [
					{ champion: "Graves", respawnSec: 30 },
					{ champion: "Jinx", respawnSec: 28 },
					{ champion: "Karma", respawnSec: 25 },
					{ champion: "Katarina", respawnSec: 22 }
				]
			}),
			newFactMemory()
		)
		strictEqual(said(out).length, 1)
		ok(said(out)[0]!.includes("of them are dead"), `got: ${said(out)[0]}`)
	})
})

describe("buildFacts — advice he can act on", () => {
	it("offers no window when his team is dead and theirs is not", () => {
		/*
		 * Regression: "Graves just died — down for 21s" while all four teammates were dead against
		 * four living enemies. Every word true; "here's your window" is how someone walks into a
		 * 1v4.
		 */
		const out = buildFacts(
			input({
				alliesAlive: 1,
				enemiesAlive: 4,
				deadEnemies: [
					{ champion: "Graves", respawnSec: 21, isJungler: true },
					{ champion: "Jinx", respawnSec: 20 }
				]
			}),
			newFactMemory()
		)
		deepStrictEqual(said(out), [])
	})

	it("does not send a man on 18% health to take a camp", () => {
		/*
		 * Health is on his own screen, so it is never a line — but the coach had no way to know it
		 * at all, which is how "go take his camps" reaches someone who is one auto from dying. The
		 * same class of error as telling a dead player to recall.
		 */
		const out = buildFacts(
			input({
				myHpFrac: 0.18,
				deadEnemies: [
					{ champion: "Viego", respawnSec: 40, isJungler: true },
					{ champion: "Jinx", respawnSec: 35 }
				],
				currentGold: 2000,
				drakeBackInSec: 40
			}),
			newFactMemory()
		)
		deepStrictEqual(said(out), [])
		ok(bg(out).some(c => c.includes("18% health")), "and the reason is in the context")
	})

	it("does not tell him about his gold while he is on the respawn screen", () => {
		// The shop is open in front of him. Saying it there is a scold about what he is looking at.
		const out = buildFacts(
			input({ meDeadForSec: 15, currentGold: 3000, drakeBackInSec: 40 }),
			newFactMemory()
		)
		deepStrictEqual(said(out), [])
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
			...said(buildFacts(input({ myEvents: [{ id: 1, name: "DragonKill", stolen: true }] }), mem)),
			...said(buildFacts(input({ nowSec: 700, pace: { cs: 193, expected: 179, exact: false } }), mem)),
			...said(buildFacts(input({ nowSec: 800, currentGold: 2000, drakeBackInSec: 40 }), mem)),
			...said(
				buildFacts(
					input({
						nowSec: 900,
						deadEnemies: [{ champion: "Graves", respawnSec: 30, isJungler: true }]
					}),
					mem
				)
			)
		]
		ok(out.length >= 4, `expected several facts, got ${out.length}`)
		for (const f of out) {
			strictEqual(/^[A-Z]+:/.test(f), false, `internal label in: ${f}`)
			strictEqual(/\(/.test(f), false, `parenthetical in: ${f}`)
			strictEqual(/\b[A-Z]{4,}\b/.test(f), false, `shouting in: ${f}`)
			// He hears one sentence, mid-fight. The prompt's own limit is 110 characters.
			ok(f.length <= 125, `too long to say (${f.length}): ${f}`)
		}
	})

	it("never talks about the listener in the third person", () => {
		/*
		 * The model reads these strings aloud. When they said "HE secured the dragon" it said
		 * exactly that, in the third person, about the person it was talking to — four times in
		 * one session.
		 */
		const out = buildFacts(
			input({
				myEvents: [{ id: 1, name: "DragonKill" }],
				pace: { cs: 100, expected: 130, exact: true }
			}),
			newFactMemory()
		)
		for (const f of said(out))
			strictEqual(/\bhe (is|has|was)\b|\bhis (farm|gold|health)\b/i.test(f), false, `third person: ${f}`)
	})
})

describe("buildFacts — ranking", () => {
	it("never lets praise displace a fact", () => {
		/*
		 * A dragon, a baron and a multi-kill are announced by the game itself — banner and sound —
		 * so praising them adds no information. Their value is warmth, and warmth must not cost a
		 * fact: a judge found the coach congratulating him on a banner he was watching on a tick
		 * that also carried "12 camps behind your own pace", the one thing he could not see.
		 */
		const out = buildFacts(
			input({
				myEvents: [{ id: 1, name: "ChampionKill", killStreak: 3 }],
				pace: { cs: 100, expected: 130, exact: true }
			}),
			newFactMemory()
		)
		strictEqual(/just got a/.test(said(out)[0]!), false, `a fact must lead, got: ${said(out)[0]}`)
		ok(said(out).some(s => /just got a/.test(s)), "but the praise is still offered")
	})

	it("offers praise when nothing else is on the table", () => {
		const out = buildFacts(input({ myEvents: [{ id: 1, name: "BaronKill" }] }), newFactMemory())
		strictEqual(said(out)[0], "you secured Baron")
	})

	it("never repeats the same congratulation", () => {
		const mem = newFactMemory()
		ok(said(buildFacts(input({ myEvents: [{ id: 1, name: "DragonKill" }] }), mem)).length > 0)
		// A second dragon is a second event, but it is the same sentence.
		deepStrictEqual(said(buildFacts(input({ nowSec: 700, myEvents: [{ id: 2, name: "DragonKill" }] }), mem)), [])
	})

	it("names a steal as a steal", () => {
		const out = buildFacts(
			input({ myEvents: [{ id: 7, name: "BaronKill", stolen: true }] }),
			newFactMemory()
		)
		ok(said(out)[0]!.includes("you stole Baron"))
	})

	it("does not read his own kill back to him", () => {
		const out = buildFacts(
			input({
				deadEnemies: [
					{ champion: "Renekton", respawnSec: 30, killedByMe: true, isJungler: true }
				]
			}),
			newFactMemory()
		)
		deepStrictEqual(said(out), [], "he was there — that is a readback, not scouting")
	})

	it("never offers more than the cap", () => {
		const out = buildFacts(
			input({
				myEvents: [{ id: 1, name: "ChampionKill", killStreak: 2 }],
				pace: { cs: 100, expected: 140, exact: true },
				currentGold: 3000,
				deadEnemies: [{ champion: "Graves", respawnSec: 30, isJungler: true }],
				drakeBackInSec: 40,
				baronBackInSec: 55
			}),
			newFactMemory()
		)
		ok(said(out).length <= MAX_FACTS, `expected at most ${MAX_FACTS}, got ${said(out).length}`)
	})

	it("says nothing when there is nothing — PASS is a real answer", () => {
		const out = buildFacts(input(), newFactMemory())
		deepStrictEqual(said(out), [])
		deepStrictEqual(bg(out), [])
	})
})
