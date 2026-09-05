/**
 * The checks in `scripts/e2e-coach.ts`, run against the transcript that made the owner quit.
 *
 * Every case below is a real sentence Coach Lillia said out loud in a real game, or the smallest
 * change to one that ought to be fine. Both halves matter: a checker that fires on everything is
 * as useless as one that fires on nothing, and the nine lines here were each individually true,
 * individually grounded, and — apart from `BRY-er` — individually defensible. What was wrong with
 * them was the transcript, which is the thing no unit test in this repo could see.
 *
 * The blocks are built with the real `renderState`, so the CONTEXT-ONLY marker, the pronunciation
 * arm and the enemy-jungler paragraph are the shapes the model actually receives rather than a
 * convenient fake.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { renderState } from "../shared/live-state.ts"
import type { VisionState } from "../shared/live-state.ts"
import {
	artefactsIn,
	auditTranscript,
	claimsOwnAverage,
	contextOnlyNumbers,
	isPass,
	listOffersPace,
	sharpenBlock,
	spokenTurns,
	subjectOf
} from "../../scripts/e2e-coach.ts"
import type { CoachTurn } from "../../scripts/e2e-coach.ts"

/* ------------------------------------------------------------- the fixture */

const ROSTER = ["Lillia", "Urgot", "Taliyah", "Smolder", "Braum", "Ornn", "Briar", "Lissandra", "Jhin", "Senna"]

/** Every champion the app knows, for the invented-name arm. Short on purpose. */
const CHAMPIONS = [...ROSTER, "Kayn", "Renekton", "Qiyana", "Shyvana"]

const stateAt = (over: Partial<VisionState> = {}): VisionState => ({
	clock: "10:20",
	me: { champion: "Lillia", level: 9, k: 2, d: 1, a: 3, cs: 40, gold: 700 },
	pace: { cs: 40, expected: 42, exact: true, source: "your 10-minute average over 23 games" },
	counterpart: { champion: "Briar", cs: 90, level: 11 },
	pronounce: [{ name: "Briar", say: "BRY-er" }],
	allies: [
		{ champion: "Urgot", level: 9, k: 1, d: 2, a: 1 },
		{ champion: "Taliyah", level: 9, k: 3, d: 0, a: 2 },
		{ champion: "Smolder", level: 8, k: 0, d: 1, a: 1 },
		{ champion: "Braum", level: 7, k: 0, d: 3, a: 4 }
	],
	enemies: [
		{ champion: "Ornn", level: 9, k: 2, d: 1, a: 0 },
		{ champion: "Briar", level: 11, k: 4, d: 0, a: 3 },
		{ champion: "Lissandra", level: 9, k: 1, d: 2, a: 5 },
		{ champion: "Jhin", level: 8, k: 3, d: 1, a: 2 },
		{ champion: "Senna", level: 8, k: 0, d: 2, a: 6 }
	],
	recentEvents: [],
	unseen: [],
	...over
})

const turnAt = (atSec: number, text: string, over: Partial<VisionState> = {}): CoachTurn => {
	const s = stateAt({ clock: `${Math.floor(atSec / 60)}:${String(atSec % 60).padStart(2, "0")}`, ...over })
	return {
		gameId: "test",
		atSec,
		clock: s.clock,
		block: renderState(s),
		pronounce: s.pronounce,
		list: s.unseen,
		roster: ROSTER,
		text,
		hadFrame: true,
		ms: 900
	}
}

/**
 * The nine lines, in order, exactly as they were spoken — four minutes of a real game, after which
 * he shut the coach off mid-match. Nothing here is paraphrased.
 */
const QUIT_TRANSCRIPT = [
	"That is a tough one, but they took Hextech drake.",
	"Nice work clearing, your 40 farm is just behind your average of 42.",
	"Awesome clear, you are farming above your average of 37 right now.",
	"You are 30 CS up on BRY-er, so keep the route moving.",
	"BRY-er is still at 0 CS, so farm your camps to keep building this lead.",
	"Try to pick up the pace, your 20 farm is not pacing to match your average of 30.",
	"Try to pick it up, your 20 farm is not pacing to match your 28 CS average.",
	"Look at that farm lead, you have 20 CS to BRY-er 0 CS.",
	"Great job on that clear, you are 20 CS up on BRY-er."
]

/** The nine lines on a 20s heartbeat, with the three PASSes that fill out four minutes. */
const quitRun = (): CoachTurn[] => {
	const out: CoachTurn[] = []
	for (let i = 0; i < 12; i++)
		out.push(turnAt(600 + i * 20, QUIT_TRANSCRIPT[i] ?? "PASS"))
	return out
}

/* ------------------------------------------------------------------ speech */

describe("what counts as speaking", () => {
	it("PASS and an empty answer are not lines", () => {
		assert.equal(isPass("PASS"), true)
		assert.equal(isPass("pass."), true)
		assert.equal(isPass("Pass on this one, take raptors."), false)
		const turns = [turnAt(600, "PASS"), turnAt(620, ""), turnAt(640, "Briar is down 21 seconds.")]
		assert.deepEqual(spokenTurns(turns).map(t => t.text), ["Briar is down 21 seconds."])
	})
})

/* --------------------------------------------------- 1. spoken scaffolding */

describe("artefactsIn", () => {
	it("catches the respelling that started this", () => {
		const hits = artefactsIn("BRY-er is still at 0 CS, so farm your camps.", {
			pronounce: [{ name: "Briar", say: "BRY-er" }],
			roster: ROSTER
		})
		assert.ok(hits.some(h => h.includes("BRY-er")), hits.join("; "))
	})

	it("catches a respelling shape the block never offered", () => {
		// Nothing in this game's table says this. The SHAPE is the signal.
		const hits = artefactsIn("kah-ZIKS is down for a while.", { pronounce: [], roster: ROSTER })
		assert.ok(hits.some(h => h.includes("kah-ZIKS")), hits.join("; "))
	})

	it("leaves the real name alone", () => {
		assert.deepEqual(
			artefactsIn("Briar is still at 0 CS, so keep clearing.", {
				pronounce: [{ name: "Briar", say: "BRY-er" }],
				roster: ROSTER
			}),
			[]
		)
	})

	it("catches the roster line and the level shorthand read aloud", () => {
		assert.ok(artefactsIn("Briar is 4/0/3 and pulling ahead.").some(h => h.includes("4/0/3")))
		assert.ok(artefactsIn("Briar is lv11 to your 9.").some(h => h.includes("lv11")))
	})

	it("catches units said as letters", () => {
		assert.ok(artefactsIn("Briar is down 21s.").some(h => h.includes("21s")))
		assert.ok(artefactsIn("You have 1334g unspent.").some(h => h.includes("1334g")))
		// The same facts, spelled out, are the whole point of the prompt rule.
		assert.deepEqual(artefactsIn("Briar is down 21 seconds with 1334 gold unspent."), [])
	})

	it("leaves alone the headings that are also ordinary coaching English", () => {
		/*
		 * Found by running this file's own checker over sentences the coach is SUPPOSED to say.
		 * With "alive right now" and "just happened" matched anywhere in the line, both of these
		 * failed — and a harness that fails good lines gets its findings skipped, which is the
		 * habit the whole exercise exists to break.
		 */
		assert.deepEqual(artefactsIn("Three of them are alive right now, so take drake."), [])
		assert.deepEqual(artefactsIn("Look at what just happened bot, rotate."), [])
		assert.deepEqual(artefactsIn("The enemy jungler right now is topside, so take your raptors."), [])
	})

	it("still catches those headings when they OPEN the sentence, which is how a heading is read", () => {
		assert.ok(
			artefactsIn("Alive right now: 5 of yours against 5 of theirs.").some(h =>
				h.includes("alive right now")
			)
		)
		assert.ok(
			artefactsIn("Take drake. Just happened: Cloud drake taken.").some(h =>
				h.includes("just happened")
			)
		)
		assert.ok(
			artefactsIn("Ground truth from the game client, clock 10:20.").some(h =>
				h.includes("ground truth")
			)
		)
	})

	it("catches the block's own furniture and markdown", () => {
		assert.ok(artefactsIn("Your farm baseline is fine.").some(h => h.includes("farm baseline")))
		assert.ok(artefactsIn("**Take drake now.**").some(h => h.includes("markdown")))
		assert.ok(artefactsIn("Nothing urgent, PASS for now.").some(h => h.includes("PASS")))
		// A bare PASS is the sanctioned answer, not an artefact.
		assert.deepEqual(artefactsIn("PASS"), [])
	})
})

/* ------------------------------------------------- 2. the CONTEXT-ONLY line */

describe("the CONTEXT-ONLY farm baseline", () => {
	it("finds the figure that lives only on that line", () => {
		const block = renderState(stateAt())
		const only = contextOnlyNumbers(block)
		assert.ok(only.has(42), `expected 42 to be context-only, got ${[...only].join(",")}`)
		// His own CS is on the `You:` line too, so it is NOT context-only and needs no exception.
		assert.equal(only.has(40), false)
	})

	it("does not treat the metric's NAME as one of its figures", () => {
		/*
		 * The real 4:52 block from the game he quit on renders the source as "interpolated between
		 * your measured 10/14/20-minute averages". Before this, a spoken "20 CS" fired a
		 * context-only finding whose printed evidence read "30 CS against 36" — the right verdict
		 * with proof that did not contain the number.
		 */
		const block = renderState(
			stateAt({
				pace: {
					cs: 30,
					expected: 36,
					exact: false,
					source: "interpolated between your measured 10/14/20-minute averages"
				}
			})
		)
		const only = contextOnlyNumbers(block)
		assert.equal(only.has(36), true, "the baseline itself is still context-only")
		for (const label of [10, 14, 20])
			assert.equal(only.has(label), false, `${label} is part of the metric's name`)
	})

	it("recognises an own-average comparison however it is phrased", () => {
		for (const line of [
			"your 40 farm is just behind your average of 42",
			"you are farming above your average of 37 right now",
			"your 20 farm is not pacing to match your average of 30",
			"your 20 farm is not pacing to match your 28 CS average",
			"that is a bit below your usual for this point"
		])
			assert.ok(claimsOwnAverage(line), `missed: ${line}`)
	})

	it("does not fire on a comparison against the enemy jungler", () => {
		assert.equal(claimsOwnAverage("You are 30 CS up on Briar, so keep the route moving."), false)
		assert.equal(claimsOwnAverage("Briar is 23 CS up on you — finish the clear."), false)
	})

	it("allows the comparison when the vetted list actually offers one", () => {
		assert.equal(listOffersPace([]), false)
		assert.equal(
			listOffersPace(["you're 22 CS behind your usual pace, 40 against your usual 62"]),
			true
		)
		const offered = ["you're 22 CS behind your usual pace, 40 against your usual 62"]
		const { findings } = auditTranscript(
			[turnAt(600, "You're 22 CS behind your usual pace — finish the clear before you look at a lane.", { unseen: offered })],
			{ champions: CHAMPIONS }
		)
		assert.deepEqual(findings.filter(f => f.check === "context-only"), [])
	})

	it("fires on the line from the real game", () => {
		const { findings } = auditTranscript(
			[turnAt(600, "Nice work clearing, your 40 farm is just behind your average of 42.")],
			{ champions: CHAMPIONS }
		)
		const ctx = findings.filter(f => f.check === "context-only")
		assert.equal(ctx.length, 2, JSON.stringify(ctx, null, 1))
		// The finding carries the sentence, not a rate. That is the whole design.
		assert.ok(ctx[0]!.line.includes("your average of 42"))
	})
})

/* ------------------------------------------------------ 3. figures and owners */

describe("figures, and whose they are", () => {
	it("catches a number that is in the block but belongs to the enemy jungler", () => {
		const { findings } = auditTranscript([turnAt(600, "You're at 90 CS — keep the route moving.")], {
			champions: CHAMPIONS
		})
		const bad = findings.filter(f => f.check === "bad-figure")
		assert.ok(bad.some(f => f.what.includes("90")), JSON.stringify(findings, null, 1))
	})

	it("needs sharpenBlock to catch it, which is why sharpenBlock exists", () => {
		// The enemy-jungler paragraph is ONE line and ends with the word "you", so line-based
		// segmentation makes him a co-owner of Briar's CS. Splitting sentences is what fixes it.
		const block = renderState(stateAt())
		const counterpartLine = block.split("\n").find(l => l.startsWith("Enemy jungler right now"))!
		assert.ok(counterpartLine.includes("90"))
		assert.ok(/\byou\b/i.test(counterpartLine))
		const sharpened = sharpenBlock(block)
		const segment = sharpened.split("\n").find(l => l.startsWith("Enemy jungler right now"))!
		assert.ok(segment.includes("90"))
		assert.equal(/\byou\b/i.test(segment), false)
	})

	it("catches a figure that is in no line of the block at all", () => {
		const { findings } = auditTranscript([turnAt(600, "You are 4500 gold up on them right now.")], {
			champions: CHAMPIONS
		})
		assert.ok(findings.some(f => f.check === "bad-figure" && f.what.includes("4500")))
	})

	it("catches a champion who is not in this game", () => {
		const { findings } = auditTranscript([turnAt(600, "Kayn is down, take the drake.")], {
			champions: CHAMPIONS
		})
		assert.ok(findings.some(f => f.check === "bad-figure" && f.what.includes("Kayn")))
	})

	it("passes a line whose every figure is on the right line of the block", () => {
		const { findings } = auditTranscript(
			[turnAt(600, "Briar is 90 CS to your 40 — finish the clear before you look at a lane.")],
			{ champions: CHAMPIONS }
		)
		assert.deepEqual(findings.filter(f => f.check === "bad-figure"), [])
	})
})

/* ------------------------------------------------------------- 4. subjects */

describe("subjectOf", () => {
	it("puts every CS line in one bucket, whoever the CS belongs to", () => {
		assert.equal(subjectOf("You are 30 CS up on Briar, so keep the route moving."), "farm")
		assert.equal(subjectOf("Nice work clearing, your 40 farm is behind your average."), "farm")
		assert.equal(subjectOf("Briar is still at 0 CS, so farm your camps."), "farm")
	})

	it("ranks the things that expire above the things that do not", () => {
		assert.equal(subjectOf("That is a tough one, but they took Hextech drake."), "objectives")
		assert.equal(subjectOf("Briar is down 21 seconds — their side is short one."), "deaths")
		assert.equal(subjectOf("You have 1400 gold unspent, so recall on this clear."), "gold")
	})
})

/* -------------------------------------------- the whole four minutes at once */

describe("the transcript he quit on", () => {
	const run = quitRun()
	const { findings, stats } = auditTranscript(run, { champions: CHAMPIONS })
	const of = (check: string) => findings.filter(f => f.check === check)

	it("is measured as nine lines in four minutes", () => {
		assert.equal(stats.spoken, 9)
		assert.equal(stats.passed, 3)
		assert.equal(Math.round(stats.linesPerMinute * 100) / 100, 2.25)
	})

	it("fails the rate check, and prints the lines", () => {
		const chatty = of("too-chatty")
		assert.ok(chatty.length >= 1, "expected the rate ceiling to fail")
		assert.ok(chatty[0]!.line.includes("BRY-er is still at 0 CS"), chatty[0]!.line)
	})

	it("fails because it is eight-ninths one subject", () => {
		const one = of("one-note")
		assert.equal(one.length, 1, JSON.stringify(one.map(f => f.what)))
		assert.ok(one[0]!.what.startsWith("89% of spoken lines were about farm"), one[0]!.what)
	})

	it("fails on the respelling, on all four lines that carried it", () => {
		const said = new Set(of("spoken-artefact").map(f => f.line))
		assert.equal(said.size, 4, [...said].join(" / "))
		for (const line of said) assert.ok(line.includes("BRY-er"), line)
	})

	it("fails on the farm baseline being read back", () => {
		const ctx = of("context-only")
		assert.ok(ctx.length >= 4, `expected the average lines to be caught, got ${ctx.length}`)
		assert.ok(ctx.every(f => /average|pacing/i.test(f.line)))
	})

	it("does not blame the coach for going blind, because these turns had pictures", () => {
		assert.deepEqual(of("blind-turn"), [])
	})
})

describe("the rate checks have a floor under them", () => {
	it("does not call two turns out of two a chatty coach", () => {
		const turns = [
			turnAt(600, "Briar is down 21 seconds — take your raptors.", {
				unseen: ["21 seconds without Briar"]
			}),
			turnAt(620, "You have 1400 gold unspent — recall on this clear.", {
				unseen: ["1400 gold sitting unspent"]
			})
		]
		const { findings } = auditTranscript(turns, { champions: CHAMPIONS })
		assert.deepEqual(findings.filter(f => f.check === "too-chatty"), [])
	})
})

/* ------------------------------------------------------------ 6. blind turns */

describe("a turn sent with no picture", () => {
	it("is reported even when what she said was fine", () => {
		const blind = { ...turnAt(600, "Briar is down 21 seconds — take the drake."), hadFrame: false }
		const { findings, stats } = auditTranscript([blind], { champions: CHAMPIONS })
		assert.equal(stats.blind, 1)
		const f = findings.filter(x => x.check === "blind-turn")
		assert.equal(f.length, 1)
		assert.ok(f[0]!.what.includes("1 of 1 turns went out with no picture"), f[0]!.what)
		// The sentence is quoted, so nobody has to take "blind: 1" on trust.
		assert.ok(f[0]!.line.includes("Briar is down 21 seconds"))
	})

	it("is reported even when she declined every blind turn", () => {
		const blind = { ...turnAt(600, "PASS"), hadFrame: false }
		const { findings } = auditTranscript([blind], { champions: CHAMPIONS })
		const f = findings.filter(x => x.check === "blind-turn")
		assert.equal(f.length, 1)
		/*
		 * A stated absence, never a bare `""`.
		 *
		 * The first real run of the harness printed exactly that — 2 of 18 turns blind, both
		 * declined, and a finding whose quoted line was two quotation marks with nothing between
		 * them. It reads as a broken harness and invites the reader to skip the finding, which is
		 * the habit this whole file exists to break.
		 */
		assert.ok(f[0]!.line.length > 20, JSON.stringify(f[0]!.line))
		assert.ok(/said nothing/.test(f[0]!.line), f[0]!.line)
	})
})

/* ------------------------------------ the blind spots, pinned rather than promised */

/**
 * The two limits the header claims, asserted — because a documented blind spot that quietly closes
 * is a stale document, and one that quietly WIDENS is a defect nobody is looking for.
 */
describe("what the reused scorer cannot catch", () => {
	it("does not call a fabricated figure unbacked when it collides with the clock", () => {
		/*
		 * Measured against the real 6:29 block from the game he quit on: the only `29` anywhere in
		 * it is the clock, and `scoreLine` therefore reports no unbacked number for a sentence that
		 * hands Briar a CS figure out of thin air. Attribution catches this one because the
		 * sentence names an owner.
		 */
		const t = turnAt(389, "You are on 40 CS to Briar's 29.")
		assert.equal(t.clock, "6:29")
		const { findings } = auditTranscript([t], { champions: CHAMPIONS })
		const bad = findings.filter(f => f.check === "bad-figure")
		assert.ok(
			bad.every(f => !/appear nowhere/.test(f.what)),
			`expected no unbacked finding, got ${bad.map(f => f.what).join(" / ")}`
		)
		assert.ok(
			bad.some(f => f.what.includes("29 is in the block, but not as Briar's")),
			bad.map(f => f.what).join(" / ") || "(no bad-figure finding at all)"
		)
	})

	it("and catches nothing at all when that figure names no owner", () => {
		// The honest half. This is why checks 1, 2, 4 and 5 do not route through `scoreLine`.
		const { findings } = auditTranscript([turnAt(389, "There are 29 seconds on that camp.")], {
			champions: CHAMPIONS
		})
		assert.deepEqual(findings.filter(f => f.check === "bad-figure"), [])
	})

	it("cannot fail a pile of individually grounded lines — only the transcript checks can", () => {
		// Each line here is clean on its own; `scoreLine` finds nothing wrong with any of them.
		const lines = [
			"You are on 40 CS to Briar's 90 — get back on the camps.",
			"Briar is on 90 CS while you sit on 40.",
			"Your route is behind: 40 CS against Briar's 90.",
			"Take raptors now — Briar has 90 CS to your 40.",
			"Camps first, because Briar's 90 is pulling away from your 40.",
			/*
			 * "your 40" rather than "40". Dropping the pronoun makes Briar the nearest named owner
			 * of BOTH figures and `scoreLine` reports 40 as misattributed — a real false positive
			 * on an ownerless clause, found by writing this test. Left named here because the point
			 * of this case is a pile of clean lines, not that one.
			 */
			"Clear the topside quad; your 40 CS to Briar's 90 is a real gap."
		]
		const turns = lines.map((l, i) => turnAt(600 + i * 20, l))
		const { findings } = auditTranscript(turns, { champions: CHAMPIONS })
		assert.deepEqual(
			findings.filter(f => f.check === "bad-figure"),
			[],
			"every line is individually grounded, which is the point"
		)
		assert.ok(findings.some(f => f.check === "one-note"), "the pile must still fail")
		assert.ok(findings.some(f => f.check === "too-chatty"), "the pile must still fail")
	})
})

/* ------------------------------------------------- the checker is not a rubber stamp */

describe("a transcript that should pass", () => {
	it("produces no findings at all", () => {
		const list = ["21 seconds without Briar — their side of the map is short one"]
		const turns: CoachTurn[] = [
			turnAt(600, "Briar is down 21 seconds — take your raptors and be at drake.", { unseen: list }),
			turnAt(620, "PASS"),
			turnAt(640, "PASS"),
			turnAt(660, "PASS"),
			turnAt(680, "PASS"),
			turnAt(700, "You have 1400 gold unspent — recall on this clear, not after the fight.", {
				unseen: ["1400 gold sitting unspent"]
			}),
			turnAt(720, "PASS"),
			turnAt(740, "PASS"),
			turnAt(760, "PASS"),
			turnAt(780, "PASS"),
			turnAt(800, "PASS"),
			turnAt(820, "PASS")
		]
		const { findings } = auditTranscript(turns, { champions: CHAMPIONS })
		assert.deepEqual(findings, [], JSON.stringify(findings, null, 1))
	})
})
