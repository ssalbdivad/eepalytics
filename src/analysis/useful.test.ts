/**
 * The six-axis usefulness instrument, and the transcript it exists to condemn.
 *
 * ## The acceptance test
 *
 * `QUIT_TRANSCRIPT` is nine sentences Coach Lillia said out loud in a real game, in order, after
 * which the owner turned her off mid-match. Nothing is paraphrased. Every one of those lines is
 * TRUE, and `analysis/coach-score.ts` — the only instrument this app had until today — scores the
 * set clean on the four faults that make its headline.
 *
 * So the contract of this file is blunt: **if the instrument does not mark that transcript as bad,
 * the instrument is broken.** That is asserted below with the specific numbers, not with a
 * boolean, so a regression says which axis stopped working rather than only that something did.
 *
 * ## Why the acceptance test carries no ground-truth block
 *
 * Axes 1 and 6 need the block and the client state that produced each line, and those were not
 * kept for this run. Pairing the nine lines with a block assembled to fit them would mean writing
 * invented League stats into a fixture, which `AGENTS.md` forbids in as many words — and it would
 * also be the easy way to make the instrument look better than it is.
 *
 * The stronger claim is available without them: the transcript is condemned on the axes that need
 * NO block at all. That is the finding, not a limitation of the test. Axes 1, 5 and 6 are covered
 * separately below on a fixture built for the purpose, where every figure is consistent by
 * construction and labelled as synthetic.
 *
 * ## The other half of the contract
 *
 * A checker that fires on everything is exactly as useless as one that fires on nothing. So
 * `GOOD_TRANSCRIPT` — nine lines of the shape `AGENTS.md` asks for, varied, specific, each naming
 * a physical act — must come back `useful` with no problems at all.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
	AXES,
	DEFAULT_THRESHOLDS,
	NEAR_DUPLICATE_SIM,
	VAGUE_IMPERATIVES,
	bestFirst,
	leadClause,
	compareRuns,
	maskedTokens,
	rankTakenOf,
	scoreTranscript,
	scoreUsefulLine,
	screenOfPremise,
	screenOfText,
	similarity,
	strippedOfVague,
	topicOfPremise,
	topicOfText,
	vagueImperative,
	worstFirst
} from "./useful.ts"
import type { UsefulInput } from "./useful.ts"
import { renderState } from "../shared/live-state.ts"
import type { VisionState } from "../shared/live-state.ts"
import type { CoachState } from "./timeliness.ts"

/* ------------------------------------------------------------------ fixtures */

const ROSTER = [
	"Lillia",
	"Urgot",
	"Taliyah",
	"Smolder",
	"Braum",
	"Ornn",
	"Briar",
	"Lissandra",
	"Jhin",
	"Senna"
]

/**
 * The nine lines, verbatim, in the order they were spoken.
 *
 * Four minutes of a real game. `BRY-er` is the block's own pronunciation respelling of Briar, the
 * enemy jungler, read out loud — which is why the aliases below are load-bearing rather than
 * cosmetic: four of these nine lines are about the counterpart and would be misread as HUD
 * readouts if the respelling were not matched.
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

/** Nine lines over four minutes — the span he reported, so the rate is his rate and not a guess. */
const quitRun = (): UsefulInput[] =>
	QUIT_TRANSCRIPT.map((text, i) => ({
		text,
		atSec: 600 + i * 30,
		latencySec: 1,
		roster: ROSTER,
		me: "Lillia",
		aliases: ["BRY-er"]
	}))

/**
 * The counter-fixture: nine lines of the shape the persona actually asks for.
 *
 * Written to the two tests `AGENTS.md` states — not visible on his screen, not sayable about a
 * different game — with one physical act each, spread across seven subjects, on a cadence near the
 * shipped design point. If this comes back `poor`, the instrument is condemning good coaching and
 * its findings can be ignored, which is the habit this repo exists to break.
 */
const GOOD_TRANSCRIPT = [
	"Briar is down 34 seconds — take her red and get out.",
	"Drake is back in 40 seconds, so start the pit side of your clear now.",
	"Briar is 23 CS up on you, so clear your whole camp rotation before you look at a lane.",
	"You have 1600 gold unspent, back on this camp not the next one.",
	"That fight was 3 for 1 and you were not in it — path toward mid on your next clear.",
	"Briar is 2 levels up on you, so take your raptors and match her clear instead of trading camps.",
	"Briar just finished Sundered Sky, so do not solo her at your red.",
	"3 of them are dead and you have about 22 seconds, so start Baron.",
	"You secured the Herald, and it was the right call over the drake."
]

const goodRun = (): UsefulInput[] =>
	GOOD_TRANSCRIPT.map((text, i) => ({
		text,
		atSec: 600 + i * 90,
		latencySec: 1,
		roster: ROSTER,
		me: "Lillia",
		aliases: ["BRY-er"]
	}))

/* =============================================== THE ACCEPTANCE TEST */

describe("the transcript he quit on", () => {
	it("is marked poor", () => {
		const v = scoreTranscript(quitRun())
		assert.equal(v.verdict, "poor", v.problems.join(" | "))
	})

	it("is caught for being too chatty", () => {
		const v = scoreTranscript(quitRun())
		// Nine lines in four minutes. The shipped design point after the readout gates is 0.40/min.
		assert.equal(v.spoken, 9)
		assert.equal(v.spanSec, 240)
		assert.ok(
			Math.abs(v.linesPerMin - 2.25) < 0.01,
			`expected 2.25 lines/min, got ${v.linesPerMin}`
		)
		assert.ok(v.linesPerMin > DEFAULT_THRESHOLDS.chattyPerMin)
		assert.ok(v.problems.some(p => p.startsWith("CHATTY")), v.problems.join(" | "))
	})

	it("is caught for being a farm monoculture", () => {
		const v = scoreTranscript(quitRun())
		assert.equal(v.topics[0]!.topic, "farm")
		assert.equal(v.topics[0]!.n, 8, JSON.stringify(v.topics))
		assert.ok(v.problems.some(p => p.startsWith("MONOCULTURE")), v.problems.join(" | "))
	})

	it("is caught for restating his own HUD", () => {
		const v = scoreTranscript(quitRun())
		// The five farm-average / gold / objective-taken lines. The four counterpart lines are not
		// HUD facts and must NOT be counted here — they are the one good half of this transcript.
		assert.equal(v.hud.interval.k, 5, JSON.stringify(v.lines.map(l => [l.clock, l.screen])))
		assert.equal(v.hud.interval.n, 9)
		assert.ok(v.problems.some(p => p.startsWith("REDUNDANT")), v.problems.join(" | "))
	})

	it("is caught for naming almost no physical action", () => {
		const v = scoreTranscript(quitRun())
		const act = v.rates.actionable.interval
		assert.equal(act.n, 9)
		// Only "so farm your camps" names a thing to do. Everything else is an observation or an
		// exhortation.
		assert.equal(act.k, 1, JSON.stringify(v.lines.map(l => [l.clock, l.axes.actionable])))
		assert.ok(v.problems.some(p => p.startsWith("NOT ACTIONABLE")), v.problems.join(" | "))
	})

	it("is caught for saying the same sentence twice", () => {
		const v = scoreTranscript(quitRun())
		// "Try to pick up the pace, your 20 farm is not pacing to match your average of 30" and
		// "Try to pick it up, your 20 farm is not pacing to match your 28 CS average" are the same
		// sentence with the digits moved.
		assert.equal(v.nearDuplicate.interval.k, 2)
		const dups = v.lines.filter(l => l.axes["not-generic"] === "fail")
		assert.equal(dups.length, 2)
		assert.ok(dups.every(l => /pick (up|it)/.test(l.text)), dups.map(l => l.text).join(" | "))
		assert.ok(v.problems.some(p => p.startsWith("REPEATED")), v.problems.join(" | "))
	})

	it("is NOT caught by the fabrication scorer, which is the whole point", () => {
		/*
		 * The instrument that shipped for months has nothing to say about this transcript. That is
		 * not a bug in `coach-score.ts` — every line really is true. It is the reason five new axes
		 * exist, and if this assertion ever starts failing the two instruments have been confused
		 * with each other.
		 */
		const v = scoreTranscript(quitRun())
		assert.equal(v.rates.correct.interval.n, 0, "no block was supplied, so nothing is checkable")
		assert.ok(!v.problems.some(p => p.startsWith("FABRICATED")), v.problems.join(" | "))
		assert.ok(v.problems.length >= 5, v.problems.join(" | "))
	})

	it("condemns it without needing a single block or client state", () => {
		const v = scoreTranscript(quitRun())
		// Axes 1 and 6 are unmeasured throughout, and the verdict stands anyway.
		assert.equal(v.rates.timely.interval.n, 0)
		assert.equal(v.rates.correct.interval.n, 0)
		assert.equal(v.verdict, "poor")
	})

	it("leads the report with the worst line, and it is one of the repeats", () => {
		const v = scoreTranscript(quitRun())
		const worst = worstFirst(v.lines)[0]!
		assert.equal(worst.score, 0)
		assert.ok(/pick (up|it)/.test(worst.text), worst.text)
		// And the best of a bad set is the one line that names a camp.
		assert.ok(bestFirst(v.lines)[0]!.text.startsWith("BRY-er is still at 0 CS"))
	})
})

/* ================================ the other half: good coaching must survive */

describe("nine lines of the shape the persona asks for", () => {
	it("comes back useful, with nothing to say against it", () => {
		const v = scoreTranscript(goodRun())
		assert.deepEqual(v.problems, [])
		assert.equal(v.verdict, "useful")
	})

	it("is varied, actionable and mostly off his HUD", () => {
		const v = scoreTranscript(goodRun())
		assert.ok(v.topics[0]!.share <= 0.5, JSON.stringify(v.topics))
		assert.ok(v.topics.length >= 5, JSON.stringify(v.topics))
		const act = v.rates.actionable.interval
		// The praise line is exempt from naming an action; the other eight all name one.
		assert.equal(act.n, 8)
		assert.equal(act.k, 8, JSON.stringify(v.lines.map(l => [l.clock, l.axes.actionable, l.notes.actionable])))
		assert.ok(v.hud.interval.p < 0.5, `${v.hud.interval.k}/${v.hud.interval.n}`)
	})

	it("separates from the quit transcript on actionability", () => {
		const cmp = compareRuns(scoreTranscript(goodRun()), scoreTranscript(quitRun()))
		const act = cmp.find(c => c.axis === "actionable")!
		assert.equal(act.separated, true, JSON.stringify(act))
		// And it says so honestly where it cannot: neither run carries a block.
		const correct = cmp.find(c => c.axis === "correct")!
		assert.equal(correct.separated, false)
		assert.match(correct.verdict, /not measured/)
	})
})

/* ============================================================ axis 2: the HUD */

describe("axis 2 — is it already on his screen", () => {
	it("classes the counterpart's numbers as things he cannot see", () => {
		for (const p of ["race", "levels", "build", "kill-share", "window", "jungler-down", "fight"] as const)
			assert.equal(screenOfPremise[p], "unseen", p)
	})

	it("classes his own readouts as things he can", () => {
		for (const p of ["farm-pace", "gold", "my-death", "objective-timer", "objective-lost"] as const)
			assert.equal(screenOfPremise[p], "hud", p)
	})

	it("matches the spoken respelling, not just the champion's real name", () => {
		const who = { roster: ROSTER, me: "Lillia", aliases: ["BRY-er"] }
		assert.equal(screenOfText("You are 30 CS up on BRY-er, so keep going.", who), "unseen")
		assert.equal(screenOfText("You are 30 CS up on Briar, so keep going.", who), "unseen")
		// His own champion is not somebody else.
		assert.equal(screenOfText("Lillia's passive is stacked, your 40 farm is behind your average.", who), "hud")
	})

	it("does not guess when the sentence carries neither signal", () => {
		assert.equal(screenOfText("Okay.", { roster: ROSTER }), "unknown")
	})
})

/* ================================================== axis 3: subject and template */

describe("axis 3 — could this have come from another game", () => {
	it("groups race and farm-pace into one subject, because he hears one subject", () => {
		assert.equal(topicOfPremise.race, "farm")
		assert.equal(topicOfPremise["farm-pace"], "farm")
		/*
		 * The measurement this encodes: by PREMISE the quit transcript is 4 race and 4 farm-pace,
		 * neither over half, and the monoculture disappears into the bucketing. The complaint was
		 * that he heard farm nine times.
		 */
		const v = scoreTranscript(quitRun())
		assert.ok(v.topics[0]!.share > 0.8, JSON.stringify(v.topics))
	})

	it("reads the subject off the sentence when no ranked list was kept", () => {
		assert.equal(topicOfText("they took Hextech drake."), "objectives")
		assert.equal(topicOfText("Briar is down 21 seconds."), "tempo")
		assert.equal(topicOfText("1334 gold sitting unspent."), "economy")
		assert.equal(topicOfText("that fight was 3 for 1."), "fighting")
		assert.equal(topicOfText("you're 20 CS down on your own pace."), "farm")
		assert.equal(topicOfText("Briar is 2 levels up on you."), "levels")
	})

	it("prefers the objective to the clear when a line mentions both", () => {
		// Order in the pattern table is the design, and this is the case that fixes it.
		assert.equal(topicOfText("Drake is back in 40 seconds, so finish your clear at the pit."), "objectives")
	})

	it("calls two sentences the same when only the digits differ", () => {
		const a = maskedTokens("Try to pick up the pace, your 20 farm is not pacing to match your average of 30.", ROSTER)
		const b = maskedTokens("Try to pick it up, your 20 farm is not pacing to match your 28 CS average.", ROSTER)
		assert.ok(similarity(a, b) >= NEAR_DUPLICATE_SIM, String(similarity(a, b)))
	})

	it("does not call two different facts about the same champion the same line", () => {
		const a = maskedTokens("Briar is 23 CS up on you, so full clear.", ROSTER)
		const b = maskedTokens("Briar just finished Sundered Sky, so do not solo her.", ROSTER)
		assert.ok(similarity(a, b) < NEAR_DUPLICATE_SIM, String(similarity(a, b)))
	})

	it("takes a judge's verdict when one was run, and stays unmeasured when it was not", () => {
		const base = { text: "Briar is 23 CS up on you, so full clear.", atSec: 600, latencySec: 1, roster: ROSTER }
		assert.equal(scoreUsefulLine(base).axes["not-generic"], "unmeasured")
		assert.equal(scoreUsefulLine({ ...base, identified: false }).axes["not-generic"], "fail")
		assert.equal(scoreUsefulLine({ ...base, identified: true }).axes["not-generic"], "pass")
	})
})

/* ===================================================== axis 4: the vague imperative */

describe("axis 4 — can you name the physical action in five words", () => {
	it("fails an instruction that names no act", () => {
		for (const text of [
			"Try to pick up the pace.",
			"Just keep it moving.",
			"Lock in and play better.",
			"Keep doing that."
		]) {
			assert.notEqual(vagueImperative(text), null, text)
			assert.equal(
				scoreUsefulLine({ text, atSec: 600, latencySec: 1, roster: ROSTER }).axes.actionable,
				"fail",
				text
			)
		}
	})

	it("passes an act even when an exhortation is bolted on after it", () => {
		const text = "BRY-er is still at 0 CS, so farm your camps to keep building this lead."
		assert.equal(vagueImperative(text), "keep building")
		assert.match(strippedOfVague(text), /farm your camps/)
		assert.equal(
			scoreUsefulLine({ text, atSec: 600, latencySec: 1, roster: ROSTER, aliases: ["BRY-er"] })
				.axes.actionable,
			"pass"
		)
	})

	it("strips the lead-in verb with the phrase, which is what fooled the old scorer", () => {
		// "try to" is credited as an action by `coach-score.ts`, deliberately and generously. If
		// the strip left it behind, "try to pick up the pace" would keep scoring clean.
		assert.doesNotMatch(strippedOfVague("Try to pick up the pace, your farm is behind."), /try/i)
	})

	it("exempts praise from naming anything to do", () => {
		const l = scoreUsefulLine({
			text: "You secured the Herald, and it was the right call over the drake.",
			atSec: 600,
			latencySec: 1,
			roster: ROSTER
		})
		assert.equal(l.topic, "praise")
		assert.equal(l.axes.actionable, "unmeasured")
	})

	it("does NOT exempt a compliment bolted onto a readout", () => {
		/*
		 * "Nice work clearing, your 40 farm is just behind your average of 42" is not praise, it is
		 * a farm readout with a compliment on the front, and the persona's praise rule is for a
		 * warm line after something he actually did. Widening the exemption to any warm adjective
		 * would exempt four of the nine lines below.
		 */
		const l = scoreUsefulLine({
			text: "Nice work clearing, your 40 farm is just behind your average of 42.",
			atSec: 600,
			latencySec: 1,
			roster: ROSTER
		})
		assert.equal(l.topic, "farm")
		assert.equal(l.axes.actionable, "fail")
	})

	it("keeps every vague phrase distinct, so the report can name which one fired", () => {
		const labels = VAGUE_IMPERATIVES.map(v => v.label)
		assert.equal(new Set(labels).size, labels.length)
	})
})

/* ================================================== axis 5: which fact was taken */

describe("axis 5 — of everything true then, was this the thing that mattered", () => {
	const OFFERED = [
		"Briar is down 34 seconds",
		"you're 20 CS down on your own pace",
		"1334 gold sitting unspent"
	]

	it("recovers the ranked fact through the model's rephrasing", () => {
		assert.equal(rankTakenOf("Briar is down for 34 seconds — take her red.", OFFERED, ROSTER), 0)
		assert.equal(rankTakenOf("You are 20 CS down on your own pace, so full clear.", OFFERED, ROSTER), 1)
		assert.equal(rankTakenOf("You have 1334 gold sitting unspent, back now.", OFFERED, ROSTER), 2)
	})

	it("reports -1 when the line matches nothing it was offered", () => {
		assert.equal(rankTakenOf("Ward the river before you cross.", OFFERED, ROSTER), -1)
	})

	it("passes only the top fact, and says what was passed over", () => {
		const top = scoreUsefulLine({
			text: "Briar is down for 34 seconds — take her red.",
			atSec: 600,
			latencySec: 1,
			offered: OFFERED,
			roster: ROSTER
		})
		assert.equal(top.axes.prioritised, "pass")
		assert.equal(top.rankTaken, 0)

		const lower = scoreUsefulLine({
			text: "You have 1334 gold sitting unspent, back now.",
			atSec: 600,
			latencySec: 1,
			offered: OFFERED,
			roster: ROSTER
		})
		assert.equal(lower.axes.prioritised, "fail")
		assert.match(lower.notes.prioritised!, /rank 3 of 3/)
		assert.match(lower.notes.prioritised!, /Briar is down 34 seconds/)
	})

	it("takes the premise from the ranked fact, not from the sentence", () => {
		/*
		 * `premiseOf` parses the RANKER's templates and returns `unknown` for all nine lines of the
		 * quit transcript, because a model rephrases. This is the fix, and it is why axis 1 can be
		 * measured on real spoken lines at all.
		 */
		const l = scoreUsefulLine({
			text: "Briar is down for 34 seconds — take her red.",
			atSec: 600,
			latencySec: 1,
			offered: OFFERED,
			roster: ROSTER
		})
		assert.equal(l.premise, "jungler-down")
		assert.equal(l.fromOffer, true)
		assert.equal(l.screen, "unseen")
	})

	it("matches through the champion clause the model drops", () => {
		/*
		 * Measured on a real Gemini run against split-03: the ranker offered the fact with its
		 * champion advice appended after an em dash, and the coach dropped the advice. Matching on
		 * the whole fact scores that 0.5 and reports the line as spoken off-list, which would have
		 * put a false "the model ignored the ranked list" finding in the report.
		 */
		const withAdvice = [
			"you're 2 levels down on Briar — declining that is correct play rather than timidity, take your own camps and be full for the objective"
		]
		assert.equal(
			rankTakenOf(
				"You're 2 levels down on Briar — focus on clearing your camps when you respawn.",
				withAdvice,
				ROSTER
			),
			0
		)
		assert.equal(leadClause(withAdvice[0]!), "you're 2 levels down on Briar")
		// And a line about something else still does not match it.
		assert.equal(rankTakenOf("Drake is back in 40 seconds, so path bot.", withAdvice, ROSTER), -1)
	})

	it("stays unmeasured when no list was recorded", () => {
		const l = scoreUsefulLine({ text: "Take your raptors.", atSec: 600, latencySec: 1 })
		assert.equal(l.axes.prioritised, "unmeasured")
		assert.equal(l.rankTaken, null)
	})
})

/* ======================================== axes 1 and 6, on a synthetic but consistent state */

/**
 * A block whose figures agree with each other, built for the two axes that need one.
 *
 * SYNTHETIC and labelled as such. Nothing here is a measurement of a real game — it exists so the
 * delegated scorers can be shown to engage through this module, which is the only claim these
 * three tests make.
 */
const testState = (over: Partial<VisionState> = {}): VisionState => ({
	clock: "10:00",
	me: { champion: "Lillia", level: 9, k: 2, d: 1, a: 3, cs: 40, gold: 700 },
	pace: null,
	counterpart: { champion: "Briar", cs: 90, level: 11 },
	pronounce: [{ name: "Briar", say: "BRY-er" }],
	allies: [],
	enemies: [{ champion: "Briar", level: 11, k: 4, d: 0, a: 3 }],
	recentEvents: [],
	unseen: ["Briar is 50 CS up on you"],
	...over
})

const coachState = (over: Partial<CoachState> = {}): CoachState => ({
	nowSec: 600,
	meDeadForSec: null,
	deadEnemies: [],
	currentGold: 700,
	pace: null,
	counterpart: { champion: "Briar", cs: 90, level: 11 },
	enemyObjectives: [],
	alliesAlive: 5,
	enemiesAlive: 5,
	drakeBackInSec: null,
	baronBackInSec: null,
	heraldBackInSec: null,
	...over
})

describe("axis 6 — the fabrication scorer, reached through this module", () => {
	it("passes a line whose figures are all in the block", () => {
		const block = renderState(testState())
		const l = scoreUsefulLine({
			text: "Briar is 50 CS up on you, so full clear before you look at a lane.",
			atSec: 600,
			latencySec: 1,
			block,
			roster: ROSTER,
			champions: ROSTER
		})
		assert.equal(l.axes.correct, "pass", l.notes.correct!)
	})

	it("fails a line carrying a figure the block does not", () => {
		const block = renderState(testState())
		const l = scoreUsefulLine({
			text: "Briar is 77 CS up on you, so full clear.",
			atSec: 600,
			latencySec: 1,
			block,
			roster: ROSTER,
			champions: ROSTER
		})
		assert.equal(l.axes.correct, "fail")
		assert.match(l.notes.correct!, /unbacked-number/)
	})

	it("stays unmeasured with no block, rather than counting as a pass", () => {
		const l = scoreUsefulLine({ text: "Briar is 77 CS up on you.", atSec: 600, latencySec: 1, roster: ROSTER })
		assert.equal(l.axes.correct, "unmeasured")
		assert.match(l.notes.correct!, /no block supplied/)
	})
})

describe("axis 1 — timeliness, reached through this module", () => {
	const offered = ["Briar is down 34 seconds"]

	it("passes a window that is still open when the sentence ends", () => {
		const l = scoreUsefulLine({
			text: "Briar is down for 34 seconds — take her red and get out.",
			atSec: 600,
			latencySec: 1,
			offered,
			roster: ROSTER,
			stateAtT: coachState({ deadEnemies: [{ champion: "Briar", respawnSec: 34, isJungler: true }] }),
			stateAtEnd: coachState({
				nowSec: 606,
				deadEnemies: [{ champion: "Briar", respawnSec: 28, isJungler: true }]
			})
		})
		assert.equal(l.axes.timely, "pass", l.notes.timely!)
	})

	it("fails one that has already closed", () => {
		const l = scoreUsefulLine({
			text: "Briar is down for 34 seconds — take her red and get out.",
			atSec: 600,
			latencySec: 9,
			offered,
			roster: ROSTER,
			stateAtT: coachState({ deadEnemies: [{ champion: "Briar", respawnSec: 34, isJungler: true }] }),
			stateAtEnd: coachState({ nowSec: 615, deadEnemies: [] })
		})
		assert.equal(l.axes.timely, "fail", l.notes.timely!)
		assert.match(l.notes.timely!, /situation-over|impossible/)
	})

	it("uses what he actually heard for the clock, not the ranker's wording", () => {
		/*
		 * The premise comes from the ranked fact; the duration comes from the spoken sentence. A
		 * short fact rephrased into a long sentence must land later, or the measurement is of a
		 * sentence nobody said.
		 */
		const at = coachState({ deadEnemies: [{ champion: "Briar", respawnSec: 34, isJungler: true }] })
		const short = scoreUsefulLine({
			text: "Briar is down 34 seconds — take her red.",
			atSec: 600,
			latencySec: 1,
			offered,
			roster: ROSTER,
			stateAtT: at,
			stateAtEnd: at
		})
		const long = scoreUsefulLine({
			text: "Briar is down for thirty four seconds, so this is your window to walk into her red buff, take it, and get back out before she respawns.",
			atSec: 600,
			latencySec: 1,
			offered,
			roster: ROSTER,
			stateAtT: at,
			stateAtEnd: at
		})
		assert.ok(long.staleness!.endSec > short.staleness!.endSec + 4, `${short.staleness!.endSec} vs ${long.staleness!.endSec}`)
		assert.equal(short.premise, "jungler-down")
		assert.equal(long.premise, "jungler-down")
	})

	it("stays unmeasured when no state was recorded", () => {
		const l = scoreUsefulLine({ text: "Briar is down 34 seconds.", atSec: 600, latencySec: 1, offered })
		assert.equal(l.axes.timely, "unmeasured")
		assert.equal(l.staleness, null)
	})
})

/* ================================================================== bookkeeping */

describe("the bookkeeping the report depends on", () => {
	it("never counts an unmeasured axis as a pass", () => {
		const l = scoreUsefulLine({ text: "Take your raptors.", atSec: 600, latencySec: 1 })
		assert.equal(l.measured, AXES.filter(a => l.axes[a] !== "unmeasured").length)
		assert.equal(l.passed, AXES.filter(a => l.axes[a] === "pass").length)
		assert.ok(l.passed <= l.measured)
	})

	it("excludes PASS and empty answers from every rate", () => {
		const v = scoreTranscript([
			{ text: "PASS", atSec: 600, latencySec: 1 },
			{ text: "", atSec: 630, latencySec: 1 },
			{ text: "Briar is down 34 seconds — take her red.", atSec: 660, latencySec: 1, roster: ROSTER }
		])
		assert.equal(v.spoken, 1)
		assert.equal(v.lines.length, 1)
	})

	it("has no rate at all for a single line, rather than a made-up one", () => {
		const v = scoreTranscript([{ text: "Take your raptors.", atSec: 600, latencySec: 1 }])
		assert.equal(v.spanSec, 0)
		assert.equal(v.linesPerMin, 0)
		assert.ok(!v.problems.some(p => p.startsWith("CHATTY")))
	})

	it("says outright when two runs are not distinguishable", () => {
		const a = scoreTranscript(goodRun().slice(0, 3))
		const b = scoreTranscript(goodRun().slice(3, 6))
		const act = compareRuns(a, b).find(c => c.axis === "actionable")!
		assert.match(act.verdict, /NOT DISTINGUISHABLE at n=\d+ and n=\d+/)
	})

	it("sorts unmeasured lines last, and ties between them consistently", () => {
		const bare = (atSec: number): UsefulInput => ({ text: "Okay.", atSec, latencySec: 1 })
		const v = scoreTranscript([
			bare(600),
			bare(700),
			{ text: "Briar is down 34 seconds — take her red.", atSec: 800, latencySec: 1, roster: ROSTER }
		])
		const order = worstFirst(v.lines)
		assert.equal(order[0]!.measured > 0, true, JSON.stringify(order.map(l => [l.clock, l.measured])))
		assert.equal(bestFirst(v.lines).every(l => l.measured > 0), true)
	})

	it("carries a Wilson interval on every axis rate", () => {
		const v = scoreTranscript(quitRun())
		for (const axis of AXES) {
			const i = v.rates[axis].interval
			assert.ok(i.lo <= i.hi)
			assert.ok(i.k <= i.n)
		}
	})
})
