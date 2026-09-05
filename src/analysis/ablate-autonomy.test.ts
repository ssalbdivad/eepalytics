/**
 * The parts of `scripts/ablate-autonomy.ts` that decide what the ablation MEANS.
 *
 * The code under test lives in `scripts/`; the test lives here because `pnpm test` runs the `src`
 * tree, following `src/review/e2e-real-game.test.ts`. Importing the script is free — everything
 * with a side effect is inside `main`, gated on `import.meta.main`.
 *
 * What is worth testing here is not the arithmetic. It is the three claims the run's headline
 * rests on:
 *
 *   1. arms 3 and 4 see the SAME ground truth as arms 1 and 2, minus exactly the fence — if the
 *      surgery took a fact with it, "the unfenced arm said something new" is meaningless;
 *   2. arm 1 is byte-identical to what ships, and arm 2 is arm 1 plus text — if either drifted, the
 *      baseline is not the baseline;
 *   3. the champion knowledge handed to the unfenced arms carries no digits, which is the one rule
 *      that keeps `cite-or-quiet` honest about numbers by construction rather than by obedience.
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { liveCoachSystemPrompt } from "../shared/live-coach-mode.ts"
import { liveChampionKnowledge } from "../review/live-coach-knowledge.ts"
import { LIVE_COACH_SYSTEM_PROMPT } from "../shared/live-prompt.ts"
import { renderState } from "../shared/live-state.ts"
import type { VisionState } from "../shared/live-state.ts"
import {
	ARMS,
	REPAIRS,
	REPEAT_GATE,
	armTurns,
	championKnowledge,
	containment,
	contentOf,
	countRankedFacts,
	isSpecific,
	median,
	pacedRow,
	picturePhrases,
	quantile,
	repeatFlags,
	statsFor,
	stripRankedList,
	subjectOf
} from "../../scripts/ablate-autonomy.ts"
import type { Cell, CellTurn } from "../../scripts/ablate-autonomy.ts"

const state = (unseen: string[]): VisionState => ({
	clock: "9:40",
	me: { champion: "Lillia", level: 8, k: 2, d: 1, a: 3, cs: 88, gold: 1017 },
	pace: { cs: 88, expected: 96, exact: true, source: "your own average: 96" },
	pronounce: [],
	counterpart: { champion: "Briar", cs: 111, level: 9 },
	allies: [{ champion: "Urgot", level: 8, k: 0, d: 0, a: 0 }],
	enemies: [{ champion: "Ornn", level: 9, k: 1, d: 0, a: 2 }],
	recentEvents: [],
	unseen
})

const FULL = renderState(state(["Briar is down 27 seconds — their camps are free", "1017 gold sitting unspent"]))
const EMPTY = renderState(state([]))

/* ------------------------------------------------------------- block surgery */

test("stripRankedList removes the ranked list and nothing above it", () => {
	const cut = stripRankedList(FULL)
	assert.equal(cut.includes("What he is NOT looking at"), false)
	assert.equal(cut.includes("Briar is down 27 seconds"), false)
	assert.equal(cut.includes("1017 gold sitting unspent"), false)
	// Everything above the list survives byte for byte, apart from the recorded repairs.
	let head = FULL.slice(0, FULL.indexOf("### What he is NOT looking at"))
	for (const r of REPAIRS) head = head.replace(r.from, r.to)
	assert.equal(cut.startsWith(head), true)
	// "at least", because the client reports creepScore floored to a multiple of ten (1221 samples,
	// not one non-multiple) and the block now says so instead of speaking a number that is
	// understated by up to nine against the HUD he is looking at.
	assert.equal(cut.includes("Enemy jungler right now: Briar, at least 111 CS, level 9"), true)
	assert.equal(cut.includes("You: Lillia lv8 2/1/3, at least 88 CS"), true)
	assert.equal(cut.includes("**The ten champions above"), true)
})

test("stripRankedList removes the empty-case paragraph too, because that is the fence speaking", () => {
	assert.equal(EMPTY.includes("the correct answer is PASS"), true)
	const cut = stripRankedList(EMPTY)
	assert.equal(cut.includes("Nothing he is missing right now"), false)
	assert.equal(cut.includes("the correct answer is PASS"), false)
	assert.equal(cut.includes("Alive right now:"), true)
})

test("stripRankedList leaves no pointer at a list that is no longer there", () => {
	// Every repair must still match the shipped renderer, or it is silently doing nothing.
	for (const r of REPAIRS)
		assert.equal(FULL.includes(r.from), true, `renderState no longer contains: ${r.from}`)
	for (const cut of [stripRankedList(FULL), stripRankedList(EMPTY)]) {
		assert.equal(cut.includes("the list below"), false)
		for (const r of REPAIRS) assert.equal(cut.includes(r.to), true)
	}
})

test("the farm baseline survives the surgery as a FACT, with only the gate removed", () => {
	// The fence tells the model not to say this unless the ranker offered it. That instruction is
	// not ground truth, and leaving it in would have gagged the unfenced arms on the one number
	// that compares him to himself.
	assert.match(FULL, /Farm baseline \(CONTEXT ONLY — never say this unless it also appears in the list below\): at least 88 CS against 96/)
	assert.match(stripRankedList(FULL), /Farm baseline: at least 88 CS against 96/)
})

test("stripRankedList is idempotent, so a double-stripped block is not a different experiment", () => {
	const once = stripRankedList(FULL)
	assert.equal(stripRankedList(once), once)
})

test("countRankedFacts counts what the fence offered", () => {
	assert.equal(countRankedFacts(FULL), 2)
	assert.equal(countRankedFacts(EMPTY), 0)
})

/* -------------------------------------------------------------------- the arms */

test("the fenced arm is byte-identical to what ships", () => {
	const fenced = ARMS.find(a => a.id === "fenced")!
	assert.equal(fenced.system("Lillia"), LIVE_COACH_SYSTEM_PROMPT)
	assert.equal(fenced.seesList, true)
})

test("fenced-see is fenced plus text, so the difference between them is only the permission", () => {
	const see = ARMS.find(a => a.id === "fenced-see")!
	assert.equal(see.system("Lillia").startsWith(LIVE_COACH_SYSTEM_PROMPT), true)
	assert.equal(see.system("Lillia").length > LIVE_COACH_SYSTEM_PROMPT.length, true)
	assert.equal(see.seesList, true)
	// It has to actually lift the empty-list rule, or it is the fenced arm with extra words.
	assert.match(see.system("Lillia"), /empty list is no longer automatically a PASS/)
})

test("cite-or-quiet and free share a persona and differ only in the rule", () => {
	const cite = ARMS.find(a => a.id === "cite-or-quiet")!
	const free = ARMS.find(a => a.id === "free")!
	assert.equal(cite.seesList, false)
	assert.equal(free.seesList, false)
	const a = cite.system("Lillia")
	const b = free.system("Lillia")
	let i = 0
	while (i < a.length && i < b.length && a[i] === b[i]) i++
	// The shared prefix is the whole persona, which is over a thousand characters.
	assert.equal(i > 900, true, `shared prefix was only ${i} characters`)
	assert.match(a, /cite it or say nothing/i)
	assert.equal(/cite it or say nothing/i.test(b), false)
})

test("every arm names the PASS escape, or a silence cannot be read as a decision", () => {
	for (const arm of ARMS) assert.match(arm.system("Lillia"), /PASS/)
})

/*
 * The fifth arm is the only one that is not a reconstruction, and that is the whole reason it is
 * worth its share of the bill. `cite-or-quiet` measured an architecture; `shipped` measures the
 * code. If someone reimplements the prompt here rather than calling the app's own function, the
 * run silently starts measuring a copy — which is exactly where a shipped regression hides.
 */
test("the shipped arm calls the app's own prompt builder rather than restating it", () => {
	const shipped = ARMS.find(a => a.id === "shipped")!
	assert.equal(
		shipped.system("Lillia"),
		liveCoachSystemPrompt({ mode: "cite-or-quiet", championKnowledge: liveChampionKnowledge("Lillia") })
	)
	assert.equal(shipped.blockKind, "shipped")
	// It keeps the ranked list, unlike the arm it descends from — that is the difference under test.
	assert.equal(shipped.seesList, true)
})

test("the shipped arm is the measured arm plus the list hint, not a rewrite of it", () => {
	const cite = ARMS.find(a => a.id === "cite-or-quiet")!.system("Lillia")
	const shipped = ARMS.find(a => a.id === "shipped")!.system("Lillia")
	// Champion knowledge is appended last in both, so compare the part before it.
	const head = cite.slice(0, cite.indexOf("\n\n## What a one-trick"))
	assert.equal(shipped.startsWith(head), true, "the shipped prompt no longer opens on the measured text")
	assert.match(shipped, /a HINT, not a menu/)
})

/* ---------------------------------------------------------- champion knowledge */

test("the champion knowledge handed to the unfenced arms contains no digit", () => {
	const notes = championKnowledge("Lillia")
	assert.equal(notes.length > 0, true, "Lillia has notes on disk")
	const body = notes.split("\n").filter(l => l.startsWith("- "))
	assert.equal(body.length > 0, true)
	for (const l of body) assert.equal(/\d/.test(l), false, `a digit reached the prompt: ${l}`)
})

test("a champion with no notes contributes nothing rather than an empty heading", () => {
	assert.equal(championKnowledge("Nobodyatall"), "")
})

/* ------------------------------------------------------------------ the scoring */

test("isSpecific means the line could not have been said about another game", () => {
	const roster = ["Lillia", "Urgot", "Briar", "Ornn"]
	assert.equal(isSpecific("Briar is 23 up on you, finish the clear", roster, "Lillia"), true)
	assert.equal(isSpecific("Briar is ahead, finish the clear", roster, "Lillia"), true)
	assert.equal(isSpecific("lock in, you have got this", roster, "Lillia"), false)
	// His OWN champion does not make a line specific — every line of his is about Lillia.
	assert.equal(isSpecific("keep the Lillia clear moving", roster, "Lillia"), false)
})

test("subjectOf partitions rather than overlaps, and prefers the sharper subject", () => {
	assert.equal(subjectOf("Briar is down 27 seconds, take their camps"), "respawn-window")
	assert.equal(subjectOf("Drake is back in fifty five seconds, be there"), "objective")
	assert.equal(subjectOf("you are 30 CS up on Briar, keep the route moving"), "counterpart-race")
	assert.equal(subjectOf("finish the clear before you look at a lane"), "farm")
	assert.equal(subjectOf("you have 1017 gold sitting there, go spend it"), "gold")
	assert.equal(subjectOf("lock in and keep going"), "other")
})

test("picturePhrases only fires on things the block never states", () => {
	assert.deepEqual(picturePhrases("Briar is down 27 seconds"), [])
	assert.equal(picturePhrases("he is on the minimap in your blue side").length > 0, true)
	assert.equal(picturePhrases("you are in a corridor with no exit").length > 0, true)
})

/* ----------------------------------------------------------------- the statistics */

const turn = (over: Partial<CellTurn>): CellTurn => ({
	stateId: "s",
	tSec: 0,
	clock: "0:00",
	rankedFacts: 0,
	framePath: null,
	line: "",
	ok: true,
	ms: 100,
	silent: false,
	faults: [],
	fabricated: false,
	inventedChampions: [],
	unbackedNumbers: [],
	misattributed: [],
	movement: [],
	subject: "other",
	picturePhrases: [],
	specific: true,
	useful: true,
	...over
})

test("silences are excluded from every rate, not scored as clean", () => {
	const cell: Cell = {
		set: "paired",
		arm: "x",
		withFrame: false,
		turns: [
			turn({ silent: true, useful: false, specific: false }),
			turn({ silent: true, useful: false, specific: false }),
			turn({ line: "a", fabricated: true, faults: ["unbacked-number"], useful: false })
		]
	}
	const s = statsFor(cell, 1)
	assert.equal(s.spoke, 1)
	// One spoken line, and it fabricated. A per-TURN rate would have said 33%.
	assert.equal(s.fabrication.n, 1)
	assert.equal(s.fabrication.p, 1)
	assert.equal(s.spokeRate.p, 1 / 3)
})

test("a failed call is an error, never a PASS", () => {
	const cell: Cell = {
		set: "paired",
		arm: "x",
		withFrame: false,
		turns: [turn({ ok: false, silent: true, reason: "429" }), turn({ line: "a" })]
	}
	const s = statsFor(cell, 1)
	assert.equal(s.errors, 1)
	assert.equal(s.spokeRate.n, 1, "the failed call is not in the denominator")
})

test("median and quantile survive an empty sample", () => {
	assert.equal(median([]), 0)
	assert.equal(quantile([], 0.9), 0)
	assert.equal(median([3, 1, 2]), 2)
	assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 10)
})

/* ------------------------------------------------------- the paced re-read */

/**
 * `--paced` re-reads a stored run with the speak floor applied, and it decides the DEFAULT, so the
 * two things it could get wrong quietly are worth pinning: which turn a floor lets through, and
 * what the denominator means once some turns are never asked.
 */

const pacedTurn = (tSec: number, over: Partial<CellTurn> = {}): CellTurn => ({
	stateId: `s-${tSec}`,
	tSec,
	clock: `${Math.floor(tSec / 60)}:${String(tSec % 60).padStart(2, "0")}`,
	rankedFacts: 0,
	framePath: null,
	line: "a line",
	ok: true,
	ms: 1,
	silent: false,
	faults: [],
	fabricated: false,
	inventedChampions: [],
	unbackedNumbers: [],
	misattributed: [],
	movement: [],
	subject: "farm",
	picturePhrases: [],
	specific: true,
	useful: true,
	...over
})

test("the floor keeps the EARLIEST line in its window, never the best one", () => {
	const turns = [0, 20, 40, 60, 80].map(t => pacedTurn(t))
	const r = pacedRow("x", turns, 45)
	// 0 speaks; 20 and 40 are inside the floor; 60 is the next one asked at all.
	assert.deepEqual(r.spokenAt, [0, 60])
	assert.equal(r.asked, 2, "a suppressed turn is never sent to the model")
	assert.equal(r.offered, 5)
})

test("PASS costs nothing — a silent turn does not start the floor running", () => {
	const turns = [pacedTurn(0, { silent: true, useful: false }), pacedTurn(20)]
	const r = pacedRow("x", turns, 45)
	assert.deepEqual(r.spokenAt, [20], "the PASS at 0 must not have blocked the line at 20")
	assert.equal(r.asked, 2)
	assert.equal(r.spoke, 1)
})

test("a paced rate is out of the turns actually ASKED, not the whole grid", () => {
	const turns = [0, 20, 40, 60].map(t => pacedTurn(t, t === 60 ? { silent: true, useful: false } : {}))
	const r = pacedRow("x", turns, 45)
	assert.equal(r.offered, 4)
	assert.equal(r.asked, 2)
	assert.equal(r.spokeRate.n, 2, "the 20s and 40s turns were never sent, so they are not PASSes")
	assert.equal(r.spokeRate.p, 0.5)
})

test("the unpaced row is the same transcript with no floor", () => {
	const turns = [0, 20, 40].map(t => pacedTurn(t))
	const r = pacedRow("x", turns, null)
	assert.equal(r.paced, false)
	assert.equal(r.spoke, 3)
	assert.equal(r.asked, 3)
	assert.equal(r.usefulLines, 3)
})

test("armTurns takes one turn per game clock, prefers the frame-bearing cell, and sorts", () => {
	const cells: Cell[] = [
		{ set: "paired", arm: "a", withFrame: true, turns: [pacedTurn(40, { line: "with picture" })] },
		{ set: "paired", arm: "a", withFrame: false, turns: [pacedTurn(40, { line: "blind" })] },
		{ set: "late", arm: "a", withFrame: false, turns: [pacedTurn(80), pacedTurn(60)] },
		{ set: "late", arm: "b", withFrame: false, turns: [pacedTurn(10, { line: "other arm" })] }
	]
	const t = armTurns(cells, "a")
	assert.deepEqual(t.map(x => x.tSec), [40, 60, 80])
	assert.equal(t[0]!.line, "with picture", "the blind copy of a paired state is a second condition, not a second turn")
})

/* ============================================================== repetition */

test("contentOf keeps the subject and the figure and drops the scaffolding", () => {
	const c = contentOf("Finish this camp clean, you're right on pace with Briar at 20 CS.")
	assert.equal(c.has("finish"), true)
	assert.equal(c.has("briar"), true)
	assert.equal(c.has("#20"), true)
	/* "you're" and "with" carry no subject; if they counted, every line would overlap every line. */
	assert.equal(c.has("you"), false)
	assert.equal(c.has("with"), false)
})

test("containment scores the restatement, not the padding", () => {
	/* The two lines Opus 5 said 6 seconds apart in the run that started this work. */
	const a = contentOf("Leave the fountain now — your clear only gets faster while it keeps running, so start the route.")
	const b = contentOf("Start it now and don't stop — your clear only gets faster while it keeps running.")
	assert.equal(containment(a, b) >= REPEAT_GATE, true)
})

test("two lines about different objectives are not a repeat, however alike they sound", () => {
	const a = contentOf("Dragon's up in 44 seconds, path there now.")
	const b = contentOf("Grubs spawn in 31 seconds, get there first.")
	assert.equal(containment(a, b) >= REPEAT_GATE, false)
})

test("a repeat is a relation to an EARLIER line, so the first of a pair is never flagged", () => {
	const turns = [
		{ line: "Finish the whole clear now, the route only pays off if it keeps moving.", silent: false, ok: true, tSec: 48 },
		{ line: "Finish clearing this camp, the route only pays off if it keeps moving.", silent: false, ok: true, tSec: 139 }
	]
	const flags = repeatFlags(turns)
	assert.equal(flags[0]!.repeat, false)
	assert.equal(flags[1]!.repeat, true)
	assert.equal(flags[1]!.ofTSec, 48)
})

test("the lookback window is game clock, so a restatement half a game later is not a recent one", () => {
	const turns = [
		{ line: "Take your own raptors while Briar is topside.", silent: false, ok: true, tSec: 100 },
		{ line: "Take your own raptors while Briar is topside.", silent: false, ok: true, tSec: 900 }
	]
	assert.equal(repeatFlags(turns)[1]!.repeat, true)
	assert.equal(repeatFlags(turns, 180)[1]!.repeat, false)
})

test("a silence is not a line, so it neither repeats nor can be repeated", () => {
	const turns = [
		{ line: "PASS", silent: true, ok: true, tSec: 10 },
		{ line: "PASS", silent: true, ok: true, tSec: 40 }
	]
	assert.deepEqual(repeatFlags(turns).map(f => f.repeat), [false, false])
})

