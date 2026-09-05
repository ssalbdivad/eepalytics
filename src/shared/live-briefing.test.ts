/**
 * The briefing, and the four things it may not get wrong.
 *
 * The rebuild rests on one measurement (`data/eval/why-shallow.md`): nine layers of context
 * replayed through one model over 88 real states of this player's own games, every line judged
 * blind. The block that ships today scored 29% useful lines; the same block plus a schedule of
 * what is up and what is next scored 55% (p = 0.0009), while ninety seconds of exactly-computed
 * history scored 30% (p = 0.94). So the schedule is the whole change and everything here is about
 * keeping it TRUE, because the same run also showed what an untrue schedule does: told to prefer
 * objectives and given no timers, the model said *"take dragon"* fifty-six seconds before the
 * first dragon existed.
 *
 * The four hazards, each of which has cost this app a spoken sentence:
 *
 * 1. a timer that was never measured (grubs remaining, a Herald respawn that does not exist);
 * 2. a figure attached to the wrong player;
 * 3. an instruction hidden in the content — the pronunciation table was read out verbatim;
 * 4. a fact that survives being moved to a different game, which is the definition of shallow.
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import {
	BARON_VISIBLE_FROM_SEC,
	HERALD_VISIBLE_FROM_SEC,
	OBJECTIVE_SPAWN,
	objectiveSchedule,
	renderBriefing,
	renderSchedule,
	renderState,
	spokenDuration
} from "./live-state.ts"
import type { ObjectiveEvent, VisionState } from "./live-state.ts"
import { BRIEFING_HINT, LIVE_COACH_MODES, liveCoachSystemPrompt, renderBlockForMode } from "./live-coach-mode.ts"

const state = (over: Partial<VisionState> = {}): VisionState => ({
	clock: "9:40",
	me: { champion: "Lillia", level: 8, k: 2, d: 1, a: 3, cs: 88, gold: 1017 },
	pace: { cs: 88, expected: 96, exact: true, source: "your own average: 96" },
	pronounce: [],
	counterpart: { champion: "Briar", cs: 111, level: 9 },
	allies: [{ champion: "Urgot", level: 8, k: 0, d: 0, a: 0 }],
	enemies: [{ champion: "Ornn", level: 9, k: 1, d: 0, a: 2 }],
	recentEvents: [],
	unseen: ["1017 gold sitting unspent"],
	...over
})

/* ------------------------------------------------------------- the schedule */

test("with no objective events at all, the schedule is the map's opening times", () => {
	const s = objectiveSchedule([], 60)
	assert.deepEqual(
		s.map(o => `${o.name} ${o.state} ${o.sec}`),
		["Dragon coming 240", "Void grubs coming 300"]
	)
	// Baron and Herald are seven and thirteen minutes out at this point: trivia, not a route.
	assert.equal(
		s.some(o => o.name === "Baron" || o.name === "Rift Herald"),
		false
	)
})

test("an untaken objective carries how long it has stood there, which is the fact nothing else can reach", () => {
	const out = renderSchedule(objectiveSchedule([], 460))
	assert.match(out, /Dragon: UP and untaken since 5:00, 2 minutes 40 seconds ago\./)
})

test("a dragon respawn is counted from the last one taken, and the tally is side-resolved", () => {
	const ev: ObjectiveEvent[] = [
		{ kind: "dragon", tSec: 365, side: "theirs" },
		{ kind: "dragon", tSec: 842, side: "theirs" }
	]
	const drake = objectiveSchedule(ev, 900).find(o => o.name === "Dragon")
	assert.ok(drake)
	assert.equal(drake.atSec, 842 + OBJECTIVE_SPAWN.dragonRespawnSec)
	assert.deepEqual(drake.taken, { mine: 0, theirs: 2 })
	assert.match(renderSchedule([drake]), /Taken so far this game: 0 by you, 2 by them\./)
})

/*
 * Soul. Never observed in the four recorded games — no side reached four drakes in any of them —
 * so this is the one branch in the file resting on the patch rather than on his own data, and it
 * is pinned here so that fact is visible rather than buried.
 */
test("once a side has soul the next spawn is named Elder and timed as Elder", () => {
	const ev: ObjectiveEvent[] = [300, 700, 1100, 1500].map(tSec => ({ kind: "dragon", tSec, side: "theirs" }) as const)
	const next = objectiveSchedule(ev, 1600).find(o => o.name.includes("Dragon"))
	assert.ok(next)
	assert.equal(next.name, "Elder Dragon")
	assert.equal(next.atSec, 1500 + OBJECTIVE_SPAWN.elderRespawnSec)
})

/*
 * The count that is not in the client. Six is the patch-note number; the four recorded games
 * contain exactly three `HordeKill` events each and never a second cluster. A remaining-grub count
 * would therefore be arithmetic on a number nobody here measured, and it would be spoken as a
 * place to walk to.
 */
test("the grubs never claim how many are left, and stop claiming to be standing once any are taken", () => {
	const fresh = renderSchedule(objectiveSchedule([], 400))
	assert.match(fresh, /Void grubs: UP and untaken since 6:00/)
	const worked = renderSchedule(objectiveSchedule([{ kind: "grub", tSec: 380, side: "mine" }], 400))
	assert.match(worked, /Void grubs: the pit opened at 6:00/)
	assert.equal(/UP and untaken/.test(worked.split("\n").find(l => l.includes("grubs"))!), false)
	for (const out of [fresh, worked]) {
		assert.equal(/left|remain|still up|of the six|unclaimed|six/i.test(out), false, out)
		// The only digits on a grub line are the spawn clock and the tally of what was taken.
		const grubLine = out.split("\n").find(l => l.includes("grubs"))!
		assert.equal(/\b6\b(?!:)/.test(grubLine), false, `a grub count reached the block: ${grubLine}`)
	}
})

/*
 * Herald. Taken at 934, 1029 and 1065 across the four recorded games and NEVER TWICE in any of
 * them, including two games that ran past 35 minutes. A respawn timer for a thing that does not
 * respawn is a fabrication with a number and a place on it, so taking it removes it entirely.
 */
test("Herald appears once, and taking it removes it rather than starting a phantom respawn", () => {
	const before = objectiveSchedule([], HERALD_VISIBLE_FROM_SEC + 10)
	assert.equal(before.some(o => o.name === "Rift Herald"), true)
	const after = objectiveSchedule([{ kind: "herald", tSec: 934, side: "theirs" }], 1000)
	assert.equal(after.some(o => o.name === "Rift Herald"), false)
	// And it is gone by the time Baron is up, whether or not anyone took it.
	assert.equal(objectiveSchedule([], OBJECTIVE_SPAWN.heraldGoneSec).some(o => o.name === "Rift Herald"), false)
})

test("Baron enters the schedule three minutes before it exists, and not before", () => {
	assert.equal(objectiveSchedule([], BARON_VISIBLE_FROM_SEC - 1).some(o => o.name === "Baron"), false)
	const b = objectiveSchedule([], BARON_VISIBLE_FROM_SEC).find(o => o.name === "Baron")
	assert.ok(b)
	assert.equal(b.state, "coming")
	assert.equal(b.atSec, OBJECTIVE_SPAWN.baronFirstSec)
})

/* Spoken aloud, so a timer is words. "in 446 seconds" is not a sentence anybody says. */
test("durations are written the way they are said", () => {
	assert.equal(spokenDuration(45), "45 seconds")
	assert.equal(spokenDuration(60), "1 minute")
	assert.equal(spokenDuration(150), "2 minutes 30 seconds")
	assert.equal(renderSchedule(objectiveSchedule([], 0)).includes("in 5 minutes."), true)
})

/* ------------------------------------------------------------- the briefing */

test("the schedule leads the briefing, and the farm comparison is below the board", () => {
	const out = renderBriefing(state({ schedule: objectiveSchedule([], 460) }))
	const at = (s: string) => {
		const i = out.indexOf(s)
		assert.notEqual(i, -1, `missing from the briefing: ${s}`)
		return i
	}
	assert.ok(at("### What is coming") < at("### The board"), "the measured layer is not first")
	assert.ok(at("### The board") < at("### The jungle race"), "the 4%-useful subject is above the 41% one")
	assert.ok(at("Farm baseline:") > at("### The board"))
})

/*
 * Every figure the shipped block carries is still here. The rebuild demotes the farm comparison by
 * POSITION and by the prompt's priority order; it does not delete the number, because a model with
 * a gap where a comparison should be invents one — measured, twice, in five answers.
 */
test("demoting the farm subject took none of its figures with it", () => {
	const s = state({ schedule: objectiveSchedule([], 460) })
	const out = renderBriefing(s)
	for (const fact of ["88 CS against 96", "at least 111 CS", "1017 gold", "Briar", "Urgot", "Ornn", "Clock 9:40"])
		assert.equal(out.includes(fact), true, `the rebuild lost a fact: ${fact}`)
	for (const u of s.unseen) assert.equal(out.includes(u), true)
})

/*
 * The fence's own instructions are gone from the CONTENT, and this is the pronunciation lesson:
 * a line shaped like data gets read as data, and a line shaped like an instruction gets read out
 * loud. "Briar = BRY-er" reached the player mid-game, verbatim, repeatedly. Ranking lives in the
 * system prompt now, where instructions live.
 */
test("no instruction is hidden in the content", () => {
	const out = renderBriefing(state({ schedule: objectiveSchedule([], 460) }))
	for (const gag of ["CONTEXT ONLY", "never say this unless", "prefer these", "the correct answer is PASS"])
		assert.equal(out.includes(gag), false, `an instruction is sitting in the content: ${gag}`)
	// The ranking rule it replaced is in the prompt instead, so nothing was simply dropped.
	assert.match(BRIEFING_HINT, /in the order that was measured/)
})

test("the briefing is not longer than the block it replaces", () => {
	const s = state({
		schedule: objectiveSchedule([], 460),
		arc: "### The arc\n\n- You have been holding 1501 gold and have not been to a shop in 3:34.",
		habits: ["Topside again: 21 heralds to their 41, while you win the dragon."],
		said: "### Already said\n\n- at 8:12 you said: start the drake now"
	})
	assert.ok(
		renderBriefing(s).length <= renderState(s).length + 400,
		`the briefing grew: ${renderBriefing(s).length} against ${renderState(s).length}`
	)
})

test("the layers with no measured gain are optional, and their absence is silent", () => {
	const out = renderBriefing(state({ schedule: objectiveSchedule([], 460) }))
	for (const heading of ["### The arc", "Already said", "From his own finished games"])
		assert.equal(out.includes(heading), false, `an empty section left a heading behind: ${heading}`)
})

/*
 * An absent schedule is STATED. Measured on the ranked list: a heading that simply vanishes is a
 * gap, and at one tick with an empty list this coach announced a death that had not happened.
 */
test("no schedule says so rather than leaving a hole", () => {
	assert.match(renderBriefing(state()), /No objective clock is available this turn/)
})

/* ------------------------------------------------------------------ the modes */

test("briefing is the default and the two measured architectures are still reachable", () => {
	const ids = LIVE_COACH_MODES.map(m => m.id)
	assert.deepEqual(ids, ["briefing", "cite-or-quiet", "fenced"])
	assert.equal(renderBlockForMode(state(), "briefing"), renderBriefing(state()))
	// Unchanged, because a default change that deletes its own control is not a comparison.
	assert.equal(renderBlockForMode(state(), "fenced"), renderState(state()))
})

test("the briefing prompt is the measured persona plus one reviewable delta", () => {
	const brief = liveCoachSystemPrompt({ mode: "briefing" })
	const cite = liveCoachSystemPrompt({ mode: "cite-or-quiet" })
	// Same citation rule; only the hint after it differs.
	const shared = brief.slice(0, brief.indexOf(BRIEFING_HINT))
	assert.equal(cite.startsWith(shared), true, "the briefing quietly reworded the measured half")
	assert.equal(brief.endsWith(BRIEFING_HINT), true)
})

/*
 * No loose digits in the hint. An earlier prompt offered two catchphrases as examples and got them
 * in 71% of its lines; every figure put in front of this model is a figure it can say back, and a
 * figure from the PROMPT belongs to no player and no game, so it cannot be checked against the
 * block the way the citation rule checks every other number.
 *
 * Quoted spans are exempt, and only those: the one figure left in this text sits inside
 * *"Alive right now: 4 of yours against 5 of theirs"*, which is quoted as the arithmetic NOT to
 * reason from. A figure introduced as a mistake is labelled; a figure loose in a sentence reads as
 * a fact. The sample sizes that justify the priority order live in the doc comment above the
 * constant, where the model never sees them.
 */
test("the priority order carries no loose numbers for the model to repeat", () => {
	const outsideQuotes = BRIEFING_HINT.replace(/"[^"]*"/g, "")
	assert.equal(/[0-9]/.test(outsideQuotes), false, outsideQuotes.match(/.{0,60}[0-9].{0,60}/)?.[0] ?? "")
})

test("the hint reverses the visibility rule rather than restating it", () => {
	// Measured: lines about something on his screen were judged useful 45% against 27% for
	// invisible ones, and the best quadrant is visible AND specific at 67%.
	assert.match(BRIEFING_HINT, /You are NOT forbidden from talking about what is on his screen/)
	assert.match(BRIEFING_HINT, /would have been equally\s+true five minutes ago/)
})
