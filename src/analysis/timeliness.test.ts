import assert from "node:assert/strict"
import { test } from "node:test"
import {
	endOfSec,
	numberWords,
	premiseOf,
	speechDurationSec,
	stalenessOf,
	stateAt,
	syllablesOf,
	type CoachState,
	type SpokenLine
} from "./timeliness.ts"

/** A state with nothing happening. Each test overrides only the field its premise reads. */
const idle = (over: Partial<CoachState> = {}): CoachState => ({
	nowSec: 600,
	meDeadForSec: null,
	deadEnemies: [],
	currentGold: 0,
	pace: null,
	counterpart: null,
	enemyObjectives: [],
	alliesAlive: 5,
	enemiesAlive: 5,
	drakeBackInSec: null,
	baronBackInSec: null,
	heraldBackInSec: null,
	...over
})

const said = (text: string, over: Partial<SpokenLine> = {}): SpokenLine => ({
	text,
	atSec: 600,
	latencySec: 1,
	...over
})

test("numberWords says a gold figure the way a voice does", () => {
	assert.equal(numberWords(0), "zero")
	assert.equal(numberWords(12), "twelve")
	assert.equal(numberWords(40), "forty")
	assert.equal(numberWords(28), "twenty eight")
	assert.equal(numberWords(1334), "one thousand three hundred thirty four")
})

test("syllables count the spoken form, not the characters", () => {
	// CS has no vowel and is spelled out — the single most common token in the fact set.
	assert.equal(syllablesOf("CS"), 2)
	// A digit is one character and many syllables. This is why the estimate expands numbers.
	assert.ok(syllablesOf("1334 gold") > syllablesOf("12 gold"))
	// NOW keeps its vowel, so it stays one word rather than three letters.
	assert.equal(syllablesOf("NOW"), 1)
})

test("speech duration reproduces the measured Gemini renders within their fit error", () => {
	/*
	 * Three of the twenty-four measured lines, with their real PCM durations. If someone retunes
	 * the constants without re-measuring, this fails.
	 */
	const measured: [string, number][] = [
		["Baron is up NOW", 2.091],
		["that fight was 0 for 3 without you, so back off and catch up", 4.371],
		["they have Baron — for the next three minutes their minions push on their own, so do not take a fight in the open", 6.491]
	]
	for (const [text, sec] of measured) {
		const est = speechDurationSec(text)
		assert.ok(
			Math.abs(est - sec) <= 1.05,
			`${text}: estimated ${est.toFixed(2)}s against a measured ${sec}s`
		)
	}
})

test("a line ends after the state it was built from, by latency plus speech", () => {
	const line = said("Baron is up NOW", { atSec: 900, latencySec: 5 })
	assert.ok(endOfSec(line) > 905)
	// A measured duration wins over the estimate.
	assert.equal(endOfSec({ ...line, spokenSec: 3 }), 908)
})

test("every shipped fact template parses to a premise", () => {
	const cases: [string, string][] = [
		["3 of them are dead — you have about 22 seconds", "window"],
		["2 of them are dead — you are up in 8 seconds with about 14 seconds of window left", "window"],
		["Briar is down 28 seconds — their camps are free", "jungler-down"],
		["Drake is back in 40 seconds", "objective-timer"],
		["Baron is up NOW", "objective-timer"],
		["they have Baron — for the next three minutes their minions push on their own, so do not take a fight in the open", "objective-lost"],
		["they have Herald and a free tower charge", "objective-lost"],
		["they took Infernal drake", "objective-lost"],
		["they have taken 3 of the objectives and you have taken none", "objective-count"],
		["objectives are 3 to 1 against you", "objective-count"],
		["that fight was 0 for 3 without you, so back off and catch up", "fight"],
		["1334 gold sitting unspent", "gold"],
		["1720 gold unspent for 4 minutes now", "gold"],
		["Briar is 30 CS up on you", "race"],
		["you're 20 CS up on Briar", "race"],
		["you've pulled 12 CS back on Briar", "race"],
		["you were 24 CS down on Briar and you're ahead now", "race"],
		["you're roughly 27 CS down on your own pace", "farm-pace"],
		["you're 14 CS up on your own pace, 193 against 179 — keep taking the free camps", "farm-pace"],
		["Briar is 2 levels up on you", "levels"],
		["you're 2 levels down on Briar — take the camps that are up instead", "levels"],
		["Briar is in 31 percent more of his team's kills than you are — get to the next fight before it starts, not after", "kill-share"],
		["Briar just finished Sundered Sky", "build"],
		["you secured Infernal drake", "praise"],
		["you just got a double kill", "praise"]
	]
	for (const [text, kind] of cases)
		assert.equal(premiseOf(text).kind, kind, `${text} should parse as ${kind}`)
})

test("the objective count is not mistaken for an objective loss", () => {
	// Both start "they have"; ordering the patterns wrongly is a silent, plausible break.
	assert.deepEqual(premiseOf("they have taken 3 of the objectives and you have taken none"), {
		kind: "objective-count",
		mine: 0,
		theirs: 3
	})
})

test("the farm pace is not mistaken for the race — both end in CS up on something", () => {
	assert.deepEqual(premiseOf("you're 14 CS up on your own pace, 193 against 179 — keep taking the free camps"), {
		kind: "farm-pace",
		behind: -14
	})
	assert.deepEqual(premiseOf("you're 14 CS up on Briar"), {
		kind: "race",
		champion: "Briar",
		gap: -14
	})
})

test("the race gap is signed the way the coach says it", () => {
	assert.deepEqual(premiseOf("Briar is 30 CS up on you"), { kind: "race", champion: "Briar", gap: 30 })
})

test("an unmatched sentence is unknown, and is never called fresh", () => {
	const r = stalenessOf(said("go stand near the drake pit"), idle(), idle({ nowSec: 606 }))
	assert.equal(r.premise, "unknown")
	assert.equal(r.kind, "unknown")
	assert.equal(r.stale, false)
})

test("a missing sample at t_end is unknown rather than fresh", () => {
	const r = stalenessOf(said("Briar is 30 CS up on you"), idle(), null)
	assert.equal(r.kind, "unknown")
	assert.match(r.why, /no sample within/)
})

// --- window ------------------------------------------------------------------------------------

test("a window that has closed by the last syllable is situation-over", () => {
	const at = idle({ deadEnemies: [{ champion: "Briar", respawnSec: 14 }, { champion: "Jhin", respawnSec: 12 }] })
	const end = idle({ nowSec: 606, deadEnemies: [{ champion: "Briar", respawnSec: 8 }] })
	const r = stalenessOf(said("2 of them are dead — you have about 12 seconds"), at, end)
	assert.equal(r.kind, "situation-over")
	assert.equal(r.stale, true)
})

test("a window still open with most of its seconds left is fresh", () => {
	const at = idle({ deadEnemies: [{ champion: "Briar", respawnSec: 40 }, { champion: "Jhin", respawnSec: 45 }] })
	const end = idle({ nowSec: 605, deadEnemies: [{ champion: "Briar", respawnSec: 35 }, { champion: "Jhin", respawnSec: 40 }] })
	const r = stalenessOf(said("2 of them are dead — you have about 40 seconds"), at, end)
	assert.equal(r.kind, "fresh")
})

test("a window whose seconds have run down past the drift is number-moved", () => {
	const at = idle({ deadEnemies: [{ champion: "Briar", respawnSec: 18 }, { champion: "Jhin", respawnSec: 20 }] })
	const end = idle({ nowSec: 607, deadEnemies: [{ champion: "Briar", respawnSec: 11 }, { champion: "Jhin", respawnSec: 13 }] })
	const r = stalenessOf(said("2 of them are dead — you have about 18 seconds"), at, end)
	assert.equal(r.kind, "number-moved")
	assert.match(r.why, /18s of window, 11s left/)
})

test("a window he is outnumbered in by the time it lands is impossible, not merely stale", () => {
	const at = idle({ deadEnemies: [{ champion: "Briar", respawnSec: 40 }, { champion: "Jhin", respawnSec: 40 }] })
	const end = idle({
		nowSec: 606,
		alliesAlive: 1,
		enemiesAlive: 3,
		deadEnemies: [{ champion: "Briar", respawnSec: 35 }, { champion: "Jhin", respawnSec: 35 }]
	})
	assert.equal(stalenessOf(said("2 of them are dead — you have about 40 seconds"), at, end).kind, "impossible")
})

test("a tempo line he is dead for by the last syllable is impossible", () => {
	const at = idle({ deadEnemies: [{ champion: "Briar", respawnSec: 40 }, { champion: "Jhin", respawnSec: 40 }] })
	const end = idle({
		nowSec: 606,
		meDeadForSec: 22,
		deadEnemies: [{ champion: "Briar", respawnSec: 35 }, { champion: "Jhin", respawnSec: 35 }]
	})
	assert.equal(stalenessOf(said("2 of them are dead — you have about 40 seconds"), at, end).kind, "impossible")
})

// --- the enemy jungler's death -----------------------------------------------------------------

test("a jungler who is back up before the sentence ends is situation-over", () => {
	const at = idle({ deadEnemies: [{ champion: "Briar", respawnSec: 6, isJungler: true }] })
	const end = idle({ nowSec: 607, deadEnemies: [] })
	const r = stalenessOf(said("Briar is down 6 seconds — their camps are free"), at, end)
	assert.equal(r.kind, "situation-over")
	assert.match(r.why, /Briar is back up/)
})

test("a jungler down long enough survives the pipe", () => {
	const at = idle({ deadEnemies: [{ champion: "Briar", respawnSec: 40, isJungler: true }] })
	const end = idle({ nowSec: 605, deadEnemies: [{ champion: "Briar", respawnSec: 35, isJungler: true }] })
	assert.equal(stalenessOf(said("Briar is down 40 seconds — their camps are free"), at, end).kind, "fresh")
})

// --- objective timers --------------------------------------------------------------------------

test("an objective timer that runs down past the drift is number-moved", () => {
	const at = idle({ drakeBackInSec: 20 })
	const end = idle({ nowSec: 607, drakeBackInSec: 13 })
	const r = stalenessOf(said("Drake is back in 20 seconds"), at, end)
	assert.equal(r.kind, "number-moved")
})

test("a long objective timer survives, because the drift is a fraction and not a constant", () => {
	const at = idle({ drakeBackInSec: 60 })
	const end = idle({ nowSec: 607, drakeBackInSec: 53 })
	assert.equal(stalenessOf(said("Drake is back in 60 seconds"), at, end).kind, "fresh")
})

test("an objective taken while the sentence was being said is situation-over", () => {
	const at = idle({ drakeBackInSec: 8 })
	const end = idle({
		nowSec: 608,
		drakeBackInSec: null,
		enemyObjectives: [{ name: "DragonKill", atSec: 604 }]
	})
	const r = stalenessOf(said("Drake is back in 8 seconds", { latencySec: 5 }), at, end)
	assert.equal(r.kind, "situation-over")
	assert.match(r.why, /taken between/)
})

// --- an objective the enemy took ---------------------------------------------------------------

test("a drake take stays worth saying for its window and not past it", () => {
	const take = { name: "DragonKill", atSec: 590 }
	const fresh = stalenessOf(
		said("they took Infernal drake", { atSec: 600 }),
		idle({ enemyObjectives: [take] }),
		idle({ nowSec: 604, enemyObjectives: [take] })
	)
	assert.equal(fresh.kind, "fresh")
	const old = stalenessOf(
		said("they took Infernal drake", { atSec: 632 }),
		idle({ nowSec: 632, enemyObjectives: [take] }),
		idle({ nowSec: 638, enemyObjectives: [take] })
	)
	assert.equal(old.kind, "situation-over")
})

test("Baron's claim outlives a drake's, because the buff is three minutes long", () => {
	const take = { name: "BaronKill", atSec: 600 }
	const r = stalenessOf(
		said("they have Baron — for the next three minutes their minions push on their own", { atSec: 660 }),
		idle({ nowSec: 660, enemyObjectives: [take] }),
		idle({ nowSec: 668, enemyObjectives: [take] })
	)
	assert.equal(r.kind, "fresh")
})

// --- fights ------------------------------------------------------------------------------------

test("a kill landing mid-sentence makes the trade he was told out of date", () => {
	const at = idle({ killSecs: [598, 599] })
	const end = idle({ nowSec: 607, killSecs: [598, 599, 603] })
	const r = stalenessOf(said("that fight was 0 for 2 without you"), at, end)
	assert.equal(r.kind, "number-moved")
	assert.match(r.why, /1 more kill landed/)
})

test("a settled fight with nothing landing after it is fresh", () => {
	const at = idle({ killSecs: [598, 599] })
	const end = idle({ nowSec: 607, killSecs: [598, 599] })
	assert.equal(stalenessOf(said("that fight was 0 for 2 without you"), at, end).kind, "fresh")
})

// --- gold --------------------------------------------------------------------------------------

test("gold he spent below the floor makes the instruction already carried out", () => {
	const r = stalenessOf(
		said("1400 gold sitting unspent"),
		idle({ currentGold: 1400 }),
		idle({ nowSec: 606, currentGold: 150 })
	)
	assert.equal(r.kind, "impossible")
	assert.match(r.why, /he spent it/)
})

test("gold partly spent but still worth saying is number-moved", () => {
	const r = stalenessOf(
		said("2400 gold sitting unspent"),
		idle({ currentGold: 2400 }),
		idle({ nowSec: 606, currentGold: 1500 })
	)
	assert.equal(r.kind, "number-moved")
})

test("gold cannot fall on its own, so unspent gold is fresh", () => {
	const r = stalenessOf(
		said("1400 gold sitting unspent"),
		idle({ currentGold: 1400 }),
		idle({ nowSec: 606, currentGold: 1450 })
	)
	assert.equal(r.kind, "fresh")
})

// --- the standing facts ------------------------------------------------------------------------

test("a CS race gap does not move inside one sentence", () => {
	const r = stalenessOf(
		said("Briar is 30 CS up on you"),
		idle({ myCs: 100, counterpart: { champion: "Briar", cs: 130 } }),
		idle({ nowSec: 606, myCs: 102, counterpart: { champion: "Briar", cs: 131 } })
	)
	assert.equal(r.kind, "fresh")
})

test("a race gap that really did move is caught", () => {
	const r = stalenessOf(
		said("Briar is 30 CS up on you"),
		idle({ myCs: 100, counterpart: { champion: "Briar", cs: 130 } }),
		idle({ nowSec: 606, myCs: 118, counterpart: { champion: "Briar", cs: 131 } })
	)
	assert.equal(r.kind, "number-moved")
})

test("a farm pace gap survives the pipe", () => {
	const r = stalenessOf(
		said("you're roughly 27 CS down on your own pace"),
		idle({ pace: { cs: 100, expected: 127 } }),
		idle({ nowSec: 606, pace: { cs: 101, expected: 129 } })
	)
	assert.equal(r.kind, "fresh")
})

test("a restraint line whose objective is gone is about nothing", () => {
	const at = idle({ meLevel: 9, counterpart: { champion: "Briar", level: 11 }, drakeBackInSec: 10 })
	const end = idle({
		nowSec: 608,
		meLevel: 9,
		counterpart: { champion: "Briar", level: 11 },
		drakeBackInSec: null
	})
	const r = stalenessOf(said("you're 2 levels down on Briar — take the camps that are up instead"), at, end)
	assert.equal(r.kind, "situation-over")
})

test("a plain level gap is not tied to an objective and stays fresh", () => {
	const at = idle({ meLevel: 9, counterpart: { champion: "Briar", level: 11 } })
	const end = idle({ nowSec: 606, meLevel: 9, counterpart: { champion: "Briar", level: 11 } })
	assert.equal(stalenessOf(said("Briar is 2 levels up on you"), at, end).kind, "fresh")
})

test("praise is never stale, because a thing he did stays done", () => {
	assert.equal(
		stalenessOf(said("you secured Infernal drake"), idle(), idle({ nowSec: 606 })).kind,
		"fresh"
	)
})

test("the champion death note is recognised by his being dead, and dies when he respawns", () => {
	const note = "your kit wants you moving, so plan the route out before you press anything"
	const at = idle({ meDeadForSec: 5 })
	const backUp = stalenessOf(said(note), at, idle({ nowSec: 607, meDeadForSec: null }))
	assert.equal(backUp.premise, "my-death")
	assert.equal(backUp.kind, "situation-over")
	const stillDown = stalenessOf(said(note), at, idle({ nowSec: 604, meDeadForSec: 1 }))
	assert.equal(stillDown.kind, "fresh")
})

// --- looking the state up ----------------------------------------------------------------------

test("stateAt takes the nearest sample, and nothing when the recording has a hole", () => {
	const states = [idle({ nowSec: 600 }), idle({ nowSec: 605 }), idle({ nowSec: 610 })]
	assert.equal(stateAt(states, 606)!.nowSec, 605)
	assert.equal(stateAt(states, 609)!.nowSec, 610)
	assert.equal(stateAt(states, 700), null)
})

test("latency is what decides the verdict, which is the whole point of the axis", () => {
	/*
	 * One fact, one game, two providers. The socket's line lands while the window is still open;
	 * the turn-based provider's lands after it has closed. Nothing about the coach changed.
	 */
	const at = idle({ nowSec: 600, deadEnemies: [{ champion: "Briar", respawnSec: 25 }, { champion: "Jhin", respawnSec: 26 }] })
	const states = [
		at,
		idle({ nowSec: 605, deadEnemies: [{ champion: "Briar", respawnSec: 20 }, { champion: "Jhin", respawnSec: 21 }] }),
		idle({ nowSec: 610, deadEnemies: [{ champion: "Briar", respawnSec: 10 }, { champion: "Jhin", respawnSec: 11 }] }),
		idle({ nowSec: 615, deadEnemies: [] })
	]
	const text = "2 of them are dead — you have about 25 seconds"
	const socket = said(text, { atSec: 600, latencySec: 1, spokenSec: 3.5 })
	const turn = said(text, { atSec: 600, latencySec: 6, spokenSec: 3.5 })
	assert.equal(stalenessOf(socket, at, stateAt(states, endOfSec(socket))).kind, "fresh")
	assert.equal(stalenessOf(turn, at, stateAt(states, endOfSec(turn))).stale, true)
})
