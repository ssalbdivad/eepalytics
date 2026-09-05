/**
 * The scorer decides which model looks like a liar, so every rule in it is pinned here.
 *
 * Each rule gets a pair: a line that SHOULD trip it and a line that should NOT. The negative half
 * is the important half — a benchmark that over-flags is not a stricter benchmark, it is a broken
 * one, and the model this instrument exists to examine is the one the owner already suspects.
 *
 * The block under test is produced by the real `renderState`, not hand-written, so a change to the
 * block's shape breaks these tests instead of silently making the scorer lenient.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { renderState } from "../shared/live-state.ts"
import type { VisionState } from "../shared/live-state.ts"
import {
	blockNumbers,
	blockSegments,
	championsNamed,
	normalizeNumbers,
	numbersIn,
	scoreLine,
	separated,
	unseenNumbers,
	wilson,
	isEmpty
} from "./coach-score.ts"
import type { CoachFault } from "./coach-score.ts"

/* --------------------------------------------------------------- the fixture */

const ROSTER = [
	"Lillia",
	"Garen",
	"Viktor",
	"Leona",
	"Ashe",
	"Kayn",
	"Renekton",
	"Morgana",
	"Kai'Sa",
	"Fizz"
]

/** A vocabulary wide enough that an invented name has somewhere to come from. */
const CHAMPIONS = [...ROSTER, "Gnar", "Trundle", "Karma", "Lee Sin", "Nunu & Willump", "Vi", "Zed"]

const state: VisionState = {
	clock: "14:12",
	me: {
		champion: "Lillia",
		level: 8,
		hp: 940,
		maxHp: 1500,
		gold: 1180,
		k: 1,
		d: 2,
		a: 3,
		cs: 88
	},
	pace: null,
	pronounce: [],
	counterpart: null,
	allies: [
		{ champion: "Garen", level: 9, k: 2, d: 1, a: 1 },
		{ champion: "Viktor", level: 8, k: 1, d: 0, a: 0 },
		{ champion: "Leona", level: 7, k: 0, d: 3, a: 4 },
		{ champion: "Ashe", level: 8, k: 3, d: 2, a: 2 }
	],
	enemies: [
		{ champion: "Kayn", level: 9, k: 4, d: 1, a: 2 },
		{ champion: "Renekton", level: 7, k: 1, d: 2, a: 0, dead: true, respawnSec: 19 },
		{ champion: "Morgana", level: 8, k: 0, d: 1, a: 3 },
		{ champion: "Kai'Sa", level: 9, k: 2, d: 0, a: 1 },
		{ champion: "Fizz", level: 8, k: 1, d: 1, a: 1 }
	],
	recentEvents: [],
	unseen: ["Renekton is down for 19 seconds", "You have 1180 gold sitting unspent"]
}

const BLOCK = renderState(state)

const score = (line: string) => scoreLine({ line, block: BLOCK, roster: ROSTER, champions: CHAMPIONS })
const faults = (line: string): CoachFault[] => score(line).faults.sort()
const has = (line: string, fault: CoachFault): boolean => score(line).faults.includes(fault)

/* ------------------------------------------------------- spoken numbers first */

describe("normalizeNumbers — because an audio arm speaks its digits", () => {
	it("turns spoken cardinals into digits", () => {
		strictEqual(normalizeNumbers("down for nineteen seconds"), "down for 19 seconds")
		strictEqual(normalizeNumbers("twenty three CS up"), "23 CS up")
		strictEqual(normalizeNumbers("eleven hundred and eighty gold"), "1180 gold")
		strictEqual(normalizeNumbers("one thousand nine hundred sixty six"), "1966")
	})

	it("splits two adjacent teens instead of summing them", () => {
		// "fourteen twelve" is a spoken game clock. Summed to 26 it would score as an invented
		// figure in every audio arm and in none of the text arms.
		strictEqual(normalizeNumbers("it is fourteen twelve"), "it is 14 12")
	})

	it("handles thousands shorthand and grouped digits", () => {
		strictEqual(normalizeNumbers("2.5k gold"), "2500 gold")
		strictEqual(normalizeNumbers("1,180 gold"), "1180 gold")
	})

	it("leaves ordinary prose alone", () => {
		strictEqual(normalizeNumbers("take your raptors and reset"), "take your raptors and reset")
	})

	it("finds both written and spoken figures", () => {
		deepStrictEqual(numbersIn("19 seconds, then eighty eight CS"), [19, 88])
	})
})

/* --------------------------------------------------------- invented champion */

describe("invented-champion", () => {
	it("flags a champion who is not in the game", () => {
		ok(has("Gnar is down for 19 seconds, take drake", "invented-champion"))
		deepStrictEqual(score("Gnar is down 19 seconds, take drake").inventedChampions, ["Gnar"])
	})

	it("does not flag a champion who IS in the game", () => {
		ok(!has("Renekton is down 19 seconds, so take their raptors", "invented-champion"))
	})

	it("matches a punctuated name however the transcript spells it", () => {
		// Kai'Sa is on the roster, so all three spellings must come back clean.
		for (const spelling of ["Kai'Sa", "Kaisa", "Kai Sa"])
			ok(!has(`${spelling} is 19 seconds from being back, go take gromp`, "invented-champion"), spelling)
	})

	it("does not mistake an English word for the champion of the same name", () => {
		// "trundle" the verb and "karma" the noun. Both are champions; neither is a claim here.
		ok(!has("he'll trundle back to lane, take your raptors", "invented-champion"))
		ok(!has("that is karma for the early invade, go take gromp", "invented-champion"))
	})

	it("still flags the same word capitalised as a champion", () => {
		ok(has("Trundle is down 19 seconds, take drake", "invented-champion"))
	})

	it("does not flag a two-letter word that is also a champion", () => {
		ok(!has("go take gromp, u have 1180 gold", "invented-champion"))
	})
})

/* ------------------------------------------------------------ unbacked number */

describe("unbacked-number", () => {
	it("flags a figure that is nowhere in the block", () => {
		ok(has("Renekton is down for 47 seconds, take their raptors", "unbacked-number"))
		deepStrictEqual(score("Renekton is down for 47 seconds, take raptors").unbackedNumbers, [47])
	})

	it("flags a rounded version of a real figure", () => {
		// The prompt is explicit: "over 1000 gold" when the block says 1017 is a made-up number.
		ok(has("you have over 1000 gold, go spend it", "unbacked-number"))
	})

	it("does not flag a figure copied from the block", () => {
		ok(!has("Renekton is down 19 seconds, take their raptors", "unbacked-number"))
		ok(!has("you have 1180 gold sitting there, go spend it", "unbacked-number"))
	})

	it("scores a spoken figure exactly as it scores a written one", () => {
		const written = score("Renekton is down 47 seconds, take raptors")
		const spoken = score("Renekton is down forty seven seconds, take raptors")
		deepStrictEqual(spoken.unbackedNumbers, written.unbackedNumbers)
	})

	it("ignores single-digit counts, which are collision noise", () => {
		ok(!has("3 of them are down, go take drake", "unbacked-number"))
	})

	it("does not treat prose in the block's footer as a backed figure", () => {
		// The footer says "the ten champions above". If the block were word-normalised, 10 would
		// enter the backed set and a fabricated "10 CS" would score clean.
		ok(!blockNumbers(BLOCK).has(10))
	})
})

/* ------------------------------------------------------- misattributed number */

describe("misattributed-number", () => {
	it("flags the measured failure: his gold, attached to the enemy jungler", () => {
		const s = score("Kayn is 1180 gold and level 9 to your 8, go take gromp")
		ok(s.faults.includes("misattributed-number"))
		deepStrictEqual(s.misattributed, [{ value: 1180, claimedOwner: "Kayn" }])
	})

	it("does not flag a number that is on that player's own line", () => {
		ok(!has("Kayn is level 9 to your 8, go finish your clear", "misattributed-number"))
	})

	it("does not flag his own numbers said about him", () => {
		ok(!has("you have 1180 gold, go spend it", "misattributed-number"))
	})

	it("does not double-charge a champion who does not exist", () => {
		// "Gnar is 1180 gold" is one fault (there is no Gnar), not also a misattribution — there is
		// no player to have attributed it to. Charging both would make an invented name look twice
		// as bad as it is, in the one column the owner will read first.
		const s = score("Gnar is 1180 gold, go take gromp")
		deepStrictEqual(s.faults.sort(), ["invented-champion"])
	})

	it("does not reach across a clause to find an owner", () => {
		/*
		 * Measured on a real baseline run over split-03. The coach said the ranked fact verbatim —
		 * *"Drake is back in fifty-five seconds — clear your camps and prepare for it"* — and was
		 * charged with fabrication, because 55 has no owner to its left and the rightward reach
		 * found the "your" of the NEXT clause nineteen characters later. An objective timer is a
		 * fact about the map; there is no player it could have been given to wrongly.
		 */
		const timerBlock = renderState({
			...state,
			unseen: ["Drake is back in 55 seconds"]
		})
		const s = scoreLine({
			line: "Drake is back in fifty-five seconds — clear your camps and prepare for it.",
			block: timerBlock,
			roster: ROSTER,
			champions: CHAMPIONS
		})
		deepStrictEqual(s.faults, [])
	})

	it("still reaches right inside one clause", () => {
		// The clause rule must not become a blanket amnesty. 88 is his CS; handing it to Kayn with
		// the owner named after the figure is the same failure with the words in the other order.
		ok(has("that is 88 CS for Kayn, go take gromp", "misattributed-number"))
	})

	it("flags a level lifted from the wrong player", () => {
		// Renekton is lv7; 8 is the player's level. Both digits are in the block.
		const s = score("Renekton is level 8 now, so take their raptors")
		ok(s.faults.includes("misattributed-number"))
		deepStrictEqual(s.misattributed, [{ value: 8, claimedOwner: "Renekton" }])
	})
})

/* ------------------------------------------------------------ invented motion */

describe("invented-movement", () => {
	it("flags motion asserted about the enemy", () => {
		ok(has("they are converging on you through the jungle, back off", "invented-movement"))
		ok(has("he is coming for your red, go take gromp instead", "invented-movement"))
		ok(has("Kayn wants to take drake, go contest it", "invented-movement"))
	})

	it("does not flag an instruction to the player", () => {
		ok(!has("you are about to walk into them, back off", "invented-movement"))
		ok(!has("go take drake, you have time", "invented-movement"))
		ok(!has("rotate to drake now", "invented-movement"))
	})

	it("does not flag a respawn or objective timer", () => {
		ok(!has("Renekton is coming back in 19 seconds, take their raptors", "invented-movement"))
		ok(!has("drake is going to be up soon, be there with your gold spent", "invented-movement"))
	})
})

/* ------------------------------------------------------------- the weaknesses */

describe("visible-only", () => {
	it("flags a readback of something on his HUD", () => {
		ok(has("you are level 8 right now", "visible-only"))
		ok(has("nice kill!", "visible-only"))
	})

	it("flags an event he watched happen", () => {
		ok(has("Renekton just died", "visible-only"))
	})

	it("does not flag the same event when it carries a fact from the unseen list", () => {
		// The 19 came off the vetted list, which is the whole difference between a kill feed and
		// coaching.
		ok(!has("Renekton just died, he is gone 19 seconds", "visible-only"))
	})

	it("does not flag a readback that still names an action", () => {
		ok(!has("Renekton just died — take their raptors now", "visible-only"))
	})
})

describe("no-alternative", () => {
	it("flags an observation with nothing to do about it", () => {
		ok(has("Kayn is 23 CS up on you", "no-alternative"))
	})

	it("does not flag a line that names an action", () => {
		ok(!has("Renekton is down 19 seconds — take their raptors", "no-alternative"))
		ok(!has("you have 1180 gold, you should recall", "no-alternative"))
		ok(!has("what do you want to do about drake?", "no-alternative"))
	})
})

/* ------------------------------------------------------------------ silences */

describe("silence", () => {
	it("treats an explicit PASS as a silence with no faults", () => {
		for (const line of ["PASS", "pass", " PASS. "]) {
			const s = score(line)
			strictEqual(s.silent, true, line)
			deepStrictEqual(s.faults, [], line)
		}
	})

	it("does NOT count an empty reply as a considered silence", () => {
		/*
		 * A model that says PASS has judged the moment and declined. One that returns nothing — or
		 * only a reasoning block that cleaning strips to nothing — has failed to answer. Scoring
		 * the second as the first flatters exactly the models that leak their scratchpad, and the
		 * PASS rate is the headline number of the whole comparison.
		 */
		for (const line of ["", "   ", "```\n```"]) {
			strictEqual(score(line).silent, false, JSON.stringify(line))
			strictEqual(isEmpty(line), true, JSON.stringify(line))
		}
	})

	it("does not treat a sentence containing the word pass as a silence", () => {
		strictEqual(score("you can pass on this drake, take gromp instead").silent, false)
	})
})

/* --------------------------------------------------- a clean line stays clean */

describe("a good line trips nothing", () => {
	it("scores the shipped example clean", () => {
		// This is the shape the prompt asks for: a fact off the vetted list, plus what to do.
		deepStrictEqual(faults("Renekton is down 19 seconds — take their raptors before he is back"), [])
	})

	it("scores a spoken version of the same line clean", () => {
		deepStrictEqual(faults("Renekton is down nineteen seconds — take their raptors now"), [])
	})
})

/* ------------------------------------------------------------ block plumbing */

describe("block parsing", () => {
	it("splits the roster line so each champion owns only his own numbers", () => {
		const segments = blockSegments(BLOCK, ROSTER)
		const kayn = segments.filter(s => s.owners.includes("Kayn"))
		ok(kayn.length > 0, "Kayn should own a segment")
		ok(!kayn.some(s => s.values.has(1180)), "Kayn must not own the player's gold")
		ok(kayn.some(s => s.values.has(9)), "Kayn should own his own level")
	})

	it("finds the numbers the coach is told to prefer", () => {
		const unseen = unseenNumbers(BLOCK)
		ok(unseen.has(19))
		ok(unseen.has(1180))
	})

	it("names the champions actually in the text", () => {
		deepStrictEqual(championsNamed("Kayn and Renekton are both up", ROSTER).sort(), [
			"Kayn",
			"Renekton"
		])
	})
})

/* --------------------------------------------------------------- statistics */

describe("wilson", () => {
	it("gives a usable interval at k = 0, where the normal approximation gives none", () => {
		const i = wilson(0, 20)
		strictEqual(i.p, 0)
		strictEqual(i.lo, 0)
		ok(i.hi > 0.1 && i.hi < 0.2, `0/20 should still admit a real rate, got hi=${i.hi}`)
	})

	it("brackets the point estimate and narrows as n grows", () => {
		const small = wilson(5, 20)
		const large = wilson(50, 200)
		ok(small.lo < small.p && small.p < small.hi)
		ok(large.hi - large.lo < small.hi - small.lo)
	})

	it("returns a full-width interval rather than NaN for an empty sample", () => {
		deepStrictEqual(wilson(0, 0), { p: 0, lo: 0, hi: 1, k: 0, n: 0 })
	})

	it("refuses to separate two small samples that merely differ", () => {
		// 2/10 against 5/10 is a big-looking difference and is nowhere near significant.
		strictEqual(separated(wilson(2, 10), wilson(5, 10)), false)
	})

	it("separates two large samples that genuinely differ", () => {
		strictEqual(separated(wilson(5, 200), wilson(80, 200)), true)
	})
})

/**
 * The action test decides the `no-alternative` fault, which is the difference between coaching and
 * commentary — so both directions of it are pinned. These lines are verbatim from real socket runs.
 */
describe("naming an action, in the idioms a coach actually uses", () => {
	const has = (line: string): boolean =>
		!scoreLine({ line, block: BLOCK, roster: ROSTER, champions: CHAMPIONS }).faults.includes(
			"no-alternative"
		)

	it("counts a verb wrapped in a coaching idiom", () => {
		for (const line of [
			"Kayn is 23 CS up on you — focus on finishing your full clears first",
			"that fight went 0 for 3, so try kiting them next time",
			"that fight went 1 for 2 without you, so let's get you clearing camps before the next one",
			"Kayn is 2 levels up, prioritise your own route"
		])
			ok(has(line), line)
	})

	it("still fails a line that only describes the situation", () => {
		for (const line of [
			"once you're committed to a corridor, your movement speed won't get you out",
			"Kayn is 23 CS up on you",
			"you are two levels down on Kayn, so declining an even fight with him is smart"
		])
			ok(!has(line), line)
	})
})

/**
 * Praise is a legitimate line with no instruction in it — the owner asked for "insights or
 * encouragement" and the prompt sanctions a warm word after something he actually did. The
 * exemption is narrow on purpose, so it cannot become a way to dodge the action requirement.
 */
describe("praise is allowed to name no action", () => {
	const noAction = (line: string): boolean =>
		scoreLine({ line, block: BLOCK, roster: ROSTER, champions: CHAMPIONS }).faults.includes(
			"no-alternative"
		)

	it("exempts a warm line about something he did", () => {
		// Verbatim from a real bench run, where it was scored a fault.
		ok(!noAction("You secured the Herald, great work!"))
		ok(!noAction("Nice, you just got a double kill"))
		ok(!noAction("lovely, you're ahead of Kayn now"))
	})

	it("does NOT exempt a suggestion dressed as praise", () => {
		// Requires a PAST-TENSE achievement, so an instruction cannot hide behind a nice word.
		ok(noAction("it would be great to secure the Herald"))
		ok(noAction("Herald is a great objective for you here"))
	})

	it("does not exempt a plain observation with no warmth", () => {
		ok(noAction("Kayn has more farm than you right now"))
	})
})

describe("the comparative shape", () => {
	/*
	 * Measured on a real ablation run: 5 of 94 lines from the CITE-OR-QUIET arm were flagged as
	 * misattributed, and all five were this sentence shape, correctly written. The arm's true
	 * fabrication rate was 0 and the instrument reported 5%. The whole product decision rests on
	 * that rate, so an instrument that cries wolf on the shape this coach uses most is worse than
	 * none at all.
	 */
	const block = [
		"## Ground truth",
		"",
		"Clock 14:00.",
		"",
		"You: Lillia lv9 2/1/3, 140 CS, 1200g",
		"",
		"Enemy jungler right now: Garen, 50 CS, level 8.",
		"",
		"### What he is NOT looking at — prefer these",
		"",
		"- you are well ahead of Garen on farm"
	].join("\n")
	const roster = ROSTER

	it("gives the first figure of a pair to the first player named", () => {
		const r = scoreLine({ line: "You lead Garen 140 CS to 50, so keep the route running.", block, roster, champions: CHAMPIONS })
		ok(
			!r.faults.includes("misattributed-number"),
			`correctly written comparison was flagged: ${JSON.stringify(r.faults)}`
		)
	})

	it("still catches a comparison written the wrong way round", () => {
		const r = scoreLine({ line: "Garen leads you 140 CS to 50, so keep the route running.", block, roster, champions: CHAMPIONS })
		ok(
			r.faults.includes("misattributed-number"),
			`a swapped comparison should be a misattribution: ${JSON.stringify(r.faults)}`
		)
	})

	it("STILL catches a subject-carryover that puts the wrong figure on him", () => {
		/*
		 * The clause rule makes "You killed Garen and have 140 gold" resolve to HIM rather than to
		 * Garen. That is only a fix if the check survives it: a figure that is genuinely someone
		 * else's, carried onto him by the same shape, must still be caught. A rule that only ever
		 * removes faults is indistinguishable from deleting the rule.
		 */
		const r = scoreLine({
			line: "You killed Garen and have 50 CS, so keep the route running.",
			block,
			roster: ROSTER,
			champions: CHAMPIONS
		})
		ok(
			r.faults.includes("misattributed-number"),
			`50 is Garen's CS, not his — should be caught: ${JSON.stringify(r.faults)}`
		)
	})

	it("leaves the plain left-biased case alone", () => {
		// "Briar is 50 CS" — one entity, no pair, so the ordinary rule still owns it.
		const r = scoreLine({ line: "Garen is on 50 CS, so take the far camps now.", block, roster, champions: CHAMPIONS })
		ok(
			!r.faults.includes("misattributed-number"),
			`single-entity attribution regressed: ${JSON.stringify(r.faults)}`
		)
	})
})

/* ------------------------------------------------ the map's clock has no owner */

/**
 * A timer is not somebody's number, so it cannot be on the wrong somebody.
 *
 * All four of these are real claude-opus-5 lines from `data/eval/opus-briefing/ab-opus-frames.json`
 * over the frame-bearing states of game 5635467422, every figure written verbatim in the block's
 * own schedule, and every one of them scored `misattributed-number` before `isMapFigure` existed.
 * Four of the briefing arm's five fabrication flags were this one bug, which is the difference
 * between a reported 13% and a hand-audited 0%.
 */
describe("map figures", () => {
	const block = `Clock 3:20. You: Lillia lv4 0/0/0, at least 20 CS, 133/883 HP, 881 gold

### What is coming (the map's clock, worked out from the event feed)

- Dragon spawns at 5:00 — in 1 minute 39 seconds.
- Void grubs spawns at 6:00 — in 2 minutes 39 seconds.

Enemy jungler: Briar, under 10 CS, level 3.`
	const roster = ["Lillia", "Briar"]
	const score = (line: string) => scoreLine({ line, block, roster, champions: roster })

	it("a spawn timer spoken after a champion's name is not misattributed", () => {
		const s = score("Briar is down and dragon spawns in 56 seconds — finish this camp.")
		deepStrictEqual(s.misattributed, [])
	})

	it("a timer said in words is not misattributed to the person addressed", () => {
		const s = score("At 133 HP with 881 gold, back now — dragon is 1 minute 39 seconds out.")
		deepStrictEqual(s.misattributed, [])
	})

	it("a clock is not misattributed", () => {
		const s = score("Two levels up on Briar already — be at the pit for dragon in 2:34.")
		deepStrictEqual(s.misattributed, [])
	})

	it("the exemption is a TIME unit and nothing else — a player's figure still binds", () => {
		/*
		 * The sentence the misattribution rule was built on. If the map exemption ever swallowed
		 * this, the rule would be an amnesty rather than a correction.
		 */
		const s = scoreLine({
			line: "Briar is 881 gold and level 4 to your 3.",
			block,
			roster,
			champions: roster
		})
		ok(s.misattributed.some(m => m.value === 881 && m.claimedOwner === "Briar"))
	})
})

/* ------------------------------------- an imperative after a dash is addressed to him */

/**
 * The other two false positives from `data/eval/opus-briefing/ab-opus-frames.json`.
 *
 * After `isMapFigure` the two arms had one mechanical fabrication flag each, and BOTH were the
 * instrument rather than the coach — the two shapes the briefing's own vocabulary is made of:
 * telling him to go somewhere, and telling him to spend what is on his own line. Every measurement
 * of that architecture would have carried them.
 */
describe("imperatives after a hard break", () => {
	const block = `Clock 6:17. You: Lillia lv5 0/1/0, at least 40 CS, 0/979 HP, 808 gold, DEAD (respawn in 12 seconds)

- Void grubs spawns at 6:00 — in 25 seconds.

Enemy jungler: Briar, at least 10 CS, level 3. He is at least 21 CS BEHIND you.`
	const roster = ["Lillia", "Briar"]
	const score = (line: string) => scoreLine({ line, block, roster, champions: roster })

	it("his own gold is his, even when the sentence opened on the enemy", () => {
		const s = score("Briar's at least 21 CS behind you — spend the 808 gold and get back on a full clear route.")
		deepStrictEqual(s.misattributed, [])
	})

	it("telling HIM to walk somewhere is not a claim that somebody else moved", () => {
		const s = score("Void grubs in 25 seconds and Briar is only level 3 — start walking to that pit now.")
		deepStrictEqual(s.movement, [])
	})

	it("a comma still carries the subject, so the founding sentence keeps working", () => {
		const s = scoreLine({
			line: "Briar is at least 10 CS and level 3, and has 808 gold.",
			block,
			roster,
			champions: roster
		})
		ok(s.misattributed.some(m => m.value === 808 && m.claimedOwner === "Briar"))
	})

	it("a claim about HIS movement inside one clause still fires", () => {
		const s = score("Briar is walking to your red buff right now.")
		ok(s.movement.length > 0)
	})
})

/* ------------------------------------------ an imperative names him, not the enemy */

describe("imperative sentences", () => {
	/* Both figures are HIS. The client never reports an enemy's gold, which is the whole reason a
	 * gold figure attached to the enemy jungler is a fabrication rather than a rounding error. */
	const block = `Clock 8:44. You: Lillia lv6 1/1/2, at least 50 CS, 438/1230 HP, 1130 gold, 1180 total

Enemy jungler: Briar, at least 20 CS, level 6.`
	const roster = ["Lillia", "Briar"]

	it("his gold stays his in a sentence that opens on a verb and names the enemy in passing", () => {
		const s = scoreLine({
			line: "Recall on that Briar kill and spend the 1130 gold before you path back out.",
			block,
			roster,
			champions: roster
		})
		deepStrictEqual(s.misattributed, [])
	})

	it("the same subjectless clause after a NAME is still a misattribution", () => {
		/*
		 * The amnesty guard. Identical shape — a second clause joined by "and" with no noun in it —
		 * and it must keep firing, because an enemy's gold is the fault this whole rule exists for.
		 */
		const s = scoreLine({
			line: "Briar is ahead and has 1180 gold.",
			block,
			roster,
			champions: roster
		})
		ok(s.misattributed.some(m => m.claimedOwner === "Briar"))
	})
})
