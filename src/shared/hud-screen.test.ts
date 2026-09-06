/**
 * The refusal: a turn whose whole content is his own HUD offers PASS.
 *
 * The line this exists to kill is *"Dragon spawns in 44 seconds, path to the pit"* — every digit
 * exact, grounded, actionable, and worthless, because his minimap printed that number before this
 * app polled for it and the directive follows from it for anybody. Fifteen of one blind judge's
 * forty-six lines were that shape.
 *
 * The line it must KEEP is *"Lissandra is down — that untaken drake is the window, start walking to
 * the pit now."* Both sentences are about things on his screen. The difference is that the second
 * one's premise — how long the drake has stood untaken, and that an enemy is down — is measurably
 * not printed anywhere he can look (`data/eval/is-the-timer-visible.md`, 1,876 real frames).
 *
 * **Visible is not disqualifying and a test that says it is would be worse than no test.** Over 554
 * blind-judged lines, visible AND specific is the best quadrant in the corpus at 67%; generic is
 * what kills a line, at 14% against 55%. So every assertion below is about whether the BLOCK still
 * carries something he could not have read, never about whether a subject is allowed.
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import {
	MINIMAP_COUNTDOWN_SEC,
	factScreen,
	hudOnlyTurn,
	objectiveSchedule,
	renderBriefing,
	renderSchedule,
	scheduleScreen,
	screenSplit
} from "./live-state.ts"
import type { ScheduledObjective, VisionState } from "./live-state.ts"

const state = (over: Partial<VisionState> = {}): VisionState => ({
	clock: "4:16",
	me: { champion: "Lillia", level: 5, k: 0, d: 1, a: 0, cs: 40, gold: 732 },
	pace: null,
	pronounce: [],
	counterpart: { champion: "Briar", cs: 0, level: 3 },
	allies: [{ champion: "Urgot", level: 5, k: 0, d: 1, a: 0 }],
	enemies: [
		{ champion: "Ornn", level: 5, k: 0, d: 0, a: 1 },
		{ champion: "Lissandra", level: 5, k: 1, d: 1, a: 1 }
	],
	recentEvents: [],
	unseen: [],
	...over
})

/*
 * The two states are the same game seven minutes apart — split-03, game 5635467422, the roster in
 * `data/eval/target-lines.md`. The first drake spawns at 5:00 and Briar took it at 6:04.
 */
const comingSoon: ScheduledObjective = { name: "Dragon", state: "coming", atSec: 300, sec: 44 }
const standing: ScheduledObjective = { name: "Dragon", state: "up", atSec: 300, sec: 140 }

test("a countdown his own minimap is printing does not earn a turn", () => {
	const s = state({ schedule: [comingSoon] })
	assert.equal(scheduleScreen(comingSoon), "hud")
	assert.deepEqual(screenSplit(s).offScreen, [])
	assert.equal(hudOnlyTurn(s), true)
	assert.match(renderBriefing(s), /the answer this turn is PASS/)
})

test("an objective standing untaken does, and so does an enemy who is down", () => {
	const s = state({
		clock: "11:22",
		schedule: [standing],
		enemies: [
			{ champion: "Ornn", level: 9, k: 1, d: 1, a: 3 },
			{ champion: "Lissandra", level: 9, k: 3, d: 2, a: 2, dead: true, respawnSec: 21 }
		]
	})
	assert.equal(scheduleScreen(standing), "off-screen")
	assert.equal(hudOnlyTurn(s), false)
	assert.deepEqual(
		screenSplit(s).offScreen,
		[
			"Dragon: UP and untaken since 5:00, 2 minutes 20 seconds ago.",
			"down right now on their side: Lissandra"
		]
	)
	const out = renderBriefing(s)
	assert.equal(out.includes("the answer this turn is PASS"), false)
	// And it is in the LEAD group, not the demoted one — this is the sentence worth interrupting for.
	assert.match(out, /### What is coming — and this is the part his own map does not print\n\n- Dragon: UP/)
})

/*
 * The boundary, and it is the one number in this file that could go stale.
 *
 * Bounded on game 4 of the frame corpus: no entry at 1:48 with 3:13 to go, an entry at 2:03 with
 * 2:58 to go. Games 7, 8 and 9 first show one at 178, 157 and 175 seconds remaining. If the overlay
 * that draws it is ever turned off, this constant is the thing to revisit and nothing else here is.
 */
test("the map's own window is three minutes, and outside it the app is genuinely early", () => {
	const early: ScheduledObjective = { name: "Dragon", state: "coming", atSec: 300, sec: MINIMAP_COUNTDOWN_SEC + 1 }
	const late: ScheduledObjective = { name: "Dragon", state: "coming", atSec: 300, sec: MINIMAP_COUNTDOWN_SEC }
	assert.equal(scheduleScreen(early), "off-screen")
	assert.equal(scheduleScreen(late), "hud")
})

/*
 * The tally is off-screen and the app's own premise-to-screen table says otherwise.
 *
 * `screenOfPremise` in `analysis/useful.ts` marks `objective-count` as `hud` with the comment "the
 * top bar's drake icons". Measured on real frames afterwards, the top bar carries kills, his KDA,
 * his CS and the clock and nothing else — game 4 at 25:29 with the drakes 3-1 prints the count
 * nowhere, and game 3 at 18:40 with the enemy one drake from soul likewise. So a schedule entry
 * carrying a tally is off-screen here, and so is the ranked line that reports one.
 */
test("the drake tally needs TAB, so an entry carrying one is not a readback", () => {
	const withTally: ScheduledObjective = {
		name: "Dragon",
		state: "coming",
		atSec: 1200,
		sec: 44,
		taken: { mine: 1, theirs: 2 }
	}
	assert.equal(scheduleScreen(withTally), "off-screen")
	assert.equal(factScreen("they have taken 2 of the objectives and you have taken none"), "off-screen")
	assert.equal(factScreen("objectives are 3 to 1 against you"), "off-screen")
	// But an objective TAKE is a banner across his screen, and that stays a readout.
	assert.equal(factScreen("they took Cloud drake"), "hud")
	assert.equal(factScreen("they have Herald and a free tower charge"), "hud")
})

/*
 * Gold splits on the DURATION, and `live-facts.ts` is the authority for that rather than taste:
 * "he can read 1280 gold, he cannot feel that it has been sitting there for three minutes while he
 * walked past two recalls." The hand-written target set makes the same call at M13.
 */
test("a gold total is his HUD and a gold HOLD is not", () => {
	assert.equal(factScreen("2694 gold sitting unspent"), "hud")
	assert.equal(factScreen("2694 gold unspent for 3 minutes now"), "off-screen")
})

test("the ranker's own readouts are recognised, and everything else is treated as off-screen", () => {
	for (const hud of [
		"Drake is back in 27 seconds",
		"Baron is up NOW",
		"Herald is back in 41 seconds — looks like you're botside, walk up",
		"you're roughly 20 CS down on your own pace — take the far camps on the way",
		"you just got a double kill",
		"you secured Herald"
	])
		assert.equal(factScreen(hud), "hud", hud)
	/*
	 * An UNRECOGNISED line is off-screen, and the direction is the safety property: a template added
	 * to `live-facts.ts` tomorrow makes this coach speak on a turn it might have passed, rather than
	 * silently gagging it. Same posture `analysis/useful.ts` takes with `unmeasured`.
	 */
	for (const off of [
		"Briar is 23 CS up on you",
		"Briar is down 19 seconds — their camps are free",
		"3 of them are dead — you have about 18 seconds",
		"Briar is in 48 percent more of his team's kills than you are — get to the next fight before it starts, not after",
		"you're 2 levels down on Briar — get the level back off a full clear",
		"Briar just finished Sundered Sky",
		"a fact template nobody has written yet"
	])
		assert.equal(factScreen(off), "off-screen", off)
})

/*
 * The MARKING half. A demoted entry keeps its digits exact and loses only its place, for the reason
 * the retired group already records: a coach that wants to talk about a dragon and has no dragon
 * timer invents one — measured at 37% useful against the schedule's 55%, telling him to take a
 * dragon fifty-six seconds before the first dragon existed.
 */
test("a readback keeps its exact timer and loses only its heading", () => {
	const out = renderSchedule([comingSoon])
	assert.match(out, /### Also on the map's clock/)
	assert.match(out, /Dragon spawns at 5:00 — in 44 seconds\./)
	assert.equal(out.includes("### What is coming"), false)
})

/*
 * The mark is a HEADING, never a suffix on the fact. `Briar = BRY-er` was introduced as a
 * pronunciation hint and read out to the player verbatim mid-game, because everything else in the
 * block is a fact to be said. Nothing this section adds may end up inside a sentence.
 */
test("no marker is attached to a line that could be spoken", () => {
	const out = renderSchedule([comingSoon, standing])
	for (const line of out.split("\n").filter(l => l.startsWith("- ")))
		for (const leak of ["minimap", "HUD", "readback", "off-screen", "PASS"])
			assert.equal(line.includes(leak), false, `a marker leaked into a spoken line: ${line}`)
})

/*
 * The standing background is deliberately not weighed, and this pins it.
 *
 * His own bar, the two rosters, the jungle race and the farm baseline are printed on every turn of
 * every game. Measured, the race verdict read "he is behind you" in 82 states of 88 and "ahead" in
 * none, so it cannot be the reason to speak NOW. When the race genuinely becomes news,
 * `live-facts.ts` ranks it and it arrives in `unseen`, where it is weighed — which the case below
 * is the whole point of.
 */
test("the always-present background never blocks a PASS, and the ranked list always can", () => {
	assert.equal(hudOnlyTurn(state({ schedule: [comingSoon] })), true)
	assert.equal(
		hudOnlyTurn(state({ schedule: [comingSoon], unseen: ["Briar is 23 CS up on you"] })),
		false,
		"a race that became news must re-enter through the ranked list"
	)
})

/*
 * Retirement and this rule compose, and the composition is the whole cadence.
 *
 * `retireSchedule` answers "has he been told this"; this answers "could he read it himself". A turn
 * where the only live entry is a retired one and a countdown he is looking at has nothing left.
 */
test("a retired entry is not news, so it cannot hold a turn open", () => {
	const s = state({ schedule: [{ ...standing, retired: true }] })
	assert.deepEqual(screenSplit(s).offScreen, [])
	assert.equal(hudOnlyTurn(s), true)
})

/*
 * A real schedule, at the real clock, rather than three hand-built entries: at 4:16 of a game with
 * no objective taken yet the grubs are 3 minutes 44 seconds out, which his map does not print, so
 * the turn is NOT a pass even though the dragon half of it is a readback. That is the intended
 * reading and it is worth pinning, because it is the case that would otherwise look like a bug.
 */
test("the app's genuine head start survives — an early spawn is not a readback", () => {
	const s = state({ schedule: objectiveSchedule([], 256) })
	assert.equal(hudOnlyTurn(s), false)
	assert.deepEqual(screenSplit(s).offScreen, ["Void grubs spawns at 8:00 — in 3 minutes 44 seconds."])
	assert.deepEqual(screenSplit(s).hud, ["Dragon spawns at 5:00 — in 44 seconds."])
})
