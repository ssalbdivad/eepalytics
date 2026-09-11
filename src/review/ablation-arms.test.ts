/**
 * The measured ablation arms, pinned — the shipped prompt IS the one the run was taken over.
 *
 * The arms live in `./ablation-arms.ts` as frozen data. Their driver,
 * `scripts/ablate-autonomy.ts`, was retired on 2026-09-11 once `bench-stream.ts` superseded it as
 * an instrument; the TEXT is not superseded by anything, because it is what
 * `data/eval/ablation-20260905-073028.json` measured.
 *
 * Three claims the run's headline rests on, and none of them is arithmetic:
 *
 *   1. arms 3 and 4 see the SAME ground truth as arms 1 and 2, minus exactly the fence — if the
 *      surgery took a fact with it, "the unfenced arm said something new" is meaningless;
 *   2. arm 1 is byte-identical to what ships, and arm 2 is arm 1 plus text — if either drifted, the
 *      baseline is not the baseline;
 *   3. the champion knowledge handed to the unfenced arms carries no digits, which is the one rule
 *      that keeps `cite-or-quiet` honest about numbers by construction rather than by obedience.
 *
 * A reworded arm fails here. That is the feature: it is where somebody decides whether the stored
 * number still describes the prompt that ships.
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { liveCoachSystemPrompt } from "../shared/live-coach-mode.ts"
import { liveChampionKnowledge } from "./live-coach-knowledge.ts"
import { LIVE_COACH_SYSTEM_PROMPT } from "../shared/live-prompt.ts"
import { renderState } from "../shared/live-state.ts"
import type { VisionState } from "../shared/live-state.ts"
import {
	ABLATION_ARMS as ARMS,
	ABLATION_PROMPT_FINGERPRINTS as FINGERPRINTS,
	ABLATION_REPAIRS as REPAIRS,
	FINGERPRINT_CHAMPION,
	promptSha,
	ablationChampionKnowledge as championKnowledge,
	countRankedFacts,
	stripRankedList
} from "./ablation-arms.ts"

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

/* ------------------------------------------------------- the run's own record */

/**
 * Every arm against the fingerprint the RUN recorded, not against a copy somebody typed.
 *
 * This is the pin that survives a `fenced` arm defined by reference. Three arms own their words
 * here and reproduce the measured sha exactly; two are `LIVE_COACH_SYSTEM_PROMPT` plus a
 * supplement, and have already drifted from it — see `ABLATION_PROMPT_FINGERPRINTS`. Both columns
 * are asserted, so a reword fails whichever half it moves, and the drift cannot grow unremarked.
 */
test("every arm still emits the exact text its fingerprint claims", () => {
	for (const arm of ARMS) {
		const fp = FINGERPRINTS[arm.id]
		assert.ok(fp, `${arm.id} has no recorded fingerprint — add one or the arm is unpinned`)
		const text = arm.system(FINGERPRINT_CHAMPION)
		assert.equal(
			promptSha(text),
			fp.today.sha,
			`${arm.id} was reworded: ${fp.today.chars} chars became ${text.length}. If that is deliberate, ` +
				`re-run the ablation — the stored numbers describe the old text.`
		)
		assert.equal(text.length, fp.today.chars, `${arm.id} length moved`)
	}
})

test("the three arms that own their words are byte-identical to the measured run", () => {
	for (const id of ["cite-or-quiet", "free", "shipped"]) {
		const fp = FINGERPRINTS[id]!
		assert.equal(fp.drift, "", `${id} is supposed to be frozen and now claims a drift`)
		assert.equal(fp.today.sha, fp.measured.sha, `${id} no longer matches the 2026-09-05 run`)
		assert.equal(fp.today.chars, fp.measured.chars)
	}
})

/*
 * The honest half. `fenced` points AT `live-prompt.ts` rather than holding a copy of it, so it
 * cannot drift from itself and nothing noticed when that module grew 3,692 characters. The
 * assertion is therefore that the drift is EXACTLY the known one: re-freezing the old text would
 * quietly change what `--arms fenced` means in the next run to make an old number look current.
 */
test("the two arms that point at the live prompt are drifted, and say so", () => {
	for (const id of ["fenced", "fenced-see"]) {
		const fp = FINGERPRINTS[id]!
		assert.notEqual(fp.drift, "", `${id} must name why it is not the measured text`)
		assert.notEqual(fp.today.sha, fp.measured.sha, `${id} matches the run again — delete the drift note`)
		assert.equal(fp.today.chars - fp.measured.chars, 3692, `${id}'s drift from the measured text moved`)
	}
})
