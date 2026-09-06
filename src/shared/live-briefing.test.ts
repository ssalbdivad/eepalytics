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
		["Dragon coming 240", "Void grubs coming 420"]
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
 * The grubs leave the schedule as soon as any are taken, and this is the one rule here that was
 * measured on the coach rather than on the data. Kept in the list after the pit had been worked —
 * phrased to assert only the spawn time and the tally — the model supplied the missing claim
 * itself: with all three of game 5635467422's grubs already dead it said "Void grubs have been
 * open 3 minutes 8 seconds, so go finish the pit" and two rewordings of it, at 09:08, 11:29 and
 * 12:10. A place in a schedule is a place to go.
 *
 * Six is the patch-note number and the four recorded games contain exactly three HordeKill events
 * each, so nothing here can say whether one is left. Off the list beats a guess on it.
 */
test("the grubs are a place to go only while nobody has touched them", () => {
	const fresh = renderSchedule(objectiveSchedule([], 520))
	assert.match(fresh, /Void grubs: UP and untaken since 8:00/)
	const worked = objectiveSchedule([{ kind: "grub", tSec: 500, side: "mine" }], 520)
	assert.equal(worked.some(o => o.name === "Void grubs"), false, "a worked pit is still being offered")
	// And no count of what is left, ever, in either state.
	assert.equal(/left|remain|of the six|unclaimed|six/i.test(fresh), false, fresh)
	const grubLine = fresh.split("\n").find(l => l.includes("grubs"))!
	assert.equal(/\b6\b(?!:)/.test(grubLine), false, `a grub count reached the block: ${grubLine}`)
})

/*
 * The invariant the whole section rests on: everything in the schedule is either a first spawn
 * nobody has killed or a respawn computed from the last kill, so it is still standing there.
 */
test("nothing reaches the schedule that might already be empty", () => {
	const ev: ObjectiveEvent[] = [
		{ kind: "dragon", tSec: 365, side: "theirs" },
		{ kind: "grub", tSec: 523, side: "mine" },
		{ kind: "herald", tSec: 934, side: "theirs" },
		{ kind: "baron", tSec: 1341, side: "mine" }
	]
	const kindOf = (name: string) =>
		name.includes("Dragon") ? "dragon"
		: name.includes("grubs") ? "grub"
		: name.includes("Herald") ? "herald"
		: "baron"
	for (const t of [400, 700, 1000, 1400, 1800])
		for (const o of objectiveSchedule(ev, t).filter(x => x.state === "up")) {
			const takenSince = ev.filter(e => e.kind === kindOf(o.name) && e.tSec >= o.atSec)
			assert.equal(takenSince.length, 0, `${o.name} is offered as up at ${t}, but one was taken after ${o.atSec}`)
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
	/* Said aloud. claude-opus-5 read *"Dragon spawns in 1 seconds"* out of a real block. */
	assert.equal(spokenDuration(1), "1 second")
	assert.equal(spokenDuration(60), "1 minute")
	assert.equal(spokenDuration(150), "2 minutes 30 seconds")
	assert.equal(renderSchedule(objectiveSchedule([], 0)).includes("in 5 minutes."), true)
})

/*
 * The schedule counts SIDES and never names a killer, and that is a hard rule rather than an
 * omission. The event feed names people by bare summoner name while both roster id fields carry
 * the tag, so a one-sided lookup resolved 0 of 37 event names in a real capture and rendered raw
 * proper nouns into a block whose every other line is champions — "You got Baron with Electrician"
 * reached the player out loud. A name that cannot be resolved to a champion is never spoken here
 * because no name is spoken here at all.
 */
test("the schedule carries sides and clocks, never a person", () => {
	const ev: ObjectiveEvent[] = [
		{ kind: "dragon", tSec: 365, side: "theirs" },
		{ kind: "dragon", tSec: 700, side: null },
		{ kind: "grub", tSec: 523, side: "mine" }
	]
	const out = renderSchedule(objectiveSchedule(ev, 800))
	for (const word of ["killed", "taken by", "Gooskaffur", "someone"])
		assert.equal(out.includes(word), false, `the schedule named somebody: ${out}`)
	// An unresolved killer counts for neither side rather than being guessed onto one.
	assert.deepEqual(objectiveSchedule(ev, 800).find(o => o.name === "Dragon")?.taken, { mine: 0, theirs: 1 })
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

/*
 * The rule the FOUR-JUDGE run added. Three of four models scored the briefing above the shipped
 * block and all four said it was not worth talking to yet, for one reason each of them found
 * independently: the monotone fact used to be the CS race and is now the objective schedule. In
 * one game the soul-and-baron pair switched on at 19:42 was still being read out at 36:43,
 * eighteen turns later, because nothing in the text retired a fact that stayed true.
 */
test("a standing fact is news once, and the hint says so", () => {
	assert.match(BRIEFING_HINT, /A standing fact hands you the\s+same true sentence/)
	assert.match(BRIEFING_HINT, /is not news now/)
	// And it points at sections that exist: the schedule's own "since" clause, and the said layer.
	assert.match(renderBriefing(state({ schedule: objectiveSchedule([], 460) })), /UP and untaken since/)
})

/*
 * The two layers the ladder measured at nothing (p = 0.94 for ninety seconds of exact history,
 * p = 0.58 for career habits on top of the schedule) do not reach the model any more. They are cut
 * at the last possible moment — `renderBriefing` still renders them — so restoring them is one
 * call, and so `data/eval`'s replays of the old block still mean what they meant.
 */
test("the layers measured at nothing are out of the shipped block and still reachable", () => {
	const s = state({
		schedule: objectiveSchedule([], 460),
		arc: "### The arc\n\n- You have been holding 1501 gold and have not been to a shop in 3:34.",
		habits: ["Topside again: 21 heralds to their 41, while you win the dragon."],
		said: "### Already said\n\n- at 8:12 you said: start the drake now"
	})
	const shipped = renderBlockForMode(s, "briefing")
	for (const gone of ["### The arc", "1501 gold", "From his own finished games", "21 heralds"])
		assert.equal(shipped.includes(gone), false, `a layer measured at nothing is still in the block: ${gone}`)
	// The memory stays: it is the only section that says which subjects are used up.
	assert.match(shipped, /Already said/)
	// Nothing was deleted, only withheld.
	assert.match(renderBriefing(s), /1501 gold/)
	assert.match(renderBriefing(s), /21 heralds/)
	assert.ok(shipped.length < renderBriefing(s).length)
})

test("the hint reverses the visibility rule rather than restating it", () => {
	// Measured: lines about something on his screen were judged useful 45% against 27% for
	// invisible ones, and the best quadrant is visible AND specific at 67%.
	assert.match(BRIEFING_HINT, /You are NOT forbidden from talking about what is on his screen/)
	assert.match(BRIEFING_HINT, /would have been equally\s+true five minutes ago/)
})

/*
 * The guard on the one branch whose NAME and TIMER both hang on a count that could be wrong.
 * Never observed — the event feed has resolved every killer since `riotIdGameName` was consulted —
 * and pinned because its failure mode is a confident timer for the wrong monster.
 */
test("an unresolvable killer withholds the dragon line rather than guessing at soul", () => {
	const ev: ObjectiveEvent[] = [
		{ kind: "dragon", tSec: 300, side: "theirs" },
		{ kind: "dragon", tSec: 700, side: "theirs" },
		{ kind: "dragon", tSec: 1100, side: "theirs" },
		{ kind: "dragon", tSec: 1500, side: null }
	]
	assert.equal(objectiveSchedule(ev, 1600).some(o => o.name.includes("Dragon")), false)
	// Resolve that last one and the line comes back, named for what it actually is.
	const resolved = ev.map(e => (e.side === null ? { ...e, side: "theirs" as const } : e))
	assert.equal(objectiveSchedule(resolved, 1600).find(o => o.name.includes("Dragon"))?.name, "Elder Dragon")
})
