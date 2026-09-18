import assert from "node:assert/strict"
import { test } from "node:test"
import {
	DEFAULT_HABIT,
	HABITS,
	MIN_GAMES_FOR_RATE,
	MIN_GAMES_PER_SIDE,
	baseRateOf,
	evidenceSentence,
	gameHabit,
	habitDef,
	habitInput,
	habitRecord,
	type HabitGame
} from "./habit.ts"
import type { LcuEvent, LcuTimeline } from "../shared/schema/lcu.ts"

/* ------------------------------------------------------------------ fixtures */

/**
 * A timeline carrying only what a habit reads. Six frames minimum, because `habitInput` refuses
 * anything shorter — a game with five frames cannot answer a question about minute fifteen.
 */
const timelineOf = (events: LcuEvent[], frameCount = 20): LcuTimeline =>
	({
		frames: Array.from({ length: frameCount }, (_, i) => ({
			timestamp: i * 60_000,
			participantFrames: {},
			// Everything hangs off the first frame; the counter sorts events itself.
			events: i === 0 ? events : []
		}))
	}) as unknown as LcuTimeline

const death = (minute: number): LcuEvent =>
	({ type: "CHAMPION_KILL", timestamp: minute * 60_000, victimId: 5, killerId: 7 }) as LcuEvent

const monster = (minute: number, monsterType: string, killerId: number): LcuEvent =>
	({ type: "ELITE_MONSTER_KILL", timestamp: minute * 60_000, monsterType, killerId }) as LcuEvent

const meta = (over: Partial<Parameters<typeof gameHabit>[2]> = {}) => ({
	gameId: 1,
	createdMs: 0,
	championName: "Lillia",
	win: true,
	durationSec: 1800,
	...over
})

const answer = (events: LcuEvent[], key = DEFAULT_HABIT, over = {}): HabitGame =>
	gameHabit(habitDef(key), habitInput(timelineOf(events), 5, [1, 2, 3, 4, 5]), meta(over))

/* ------------------------------------------------------- the window is the window */

test("a death inside 10:00-15:00 makes the game dirty; one outside does not", () => {
	assert.equal(answer([death(12)]).clean, false)
	assert.equal(answer([death(12)]).value, 1)
	assert.equal(answer([death(9)]).clean, true)
	assert.equal(answer([death(16)]).clean, true)
	assert.equal(answer([death(9), death(16), death(30)]).value, 0)
})

test("the window is open at 10:00 and closed at 15:00, exactly as what-wins measured it", () => {
	// `timestamp > 10:00 && <= 15:00` — a death at exactly 10:00 belongs to the earlier window
	// and a death at exactly 15:00 belongs to this one. Matching the stored measurement matters
	// more than which boundary is prettier: the card quotes that measurement's win rates.
	assert.equal(answer([death(10)]).value, 0)
	assert.equal(answer([death(15)]).value, 1)
})

test("a game that ended before the window closed has NO answer, and says why", () => {
	const g = answer([], DEFAULT_HABIT, { durationSec: 12 * 60 })
	assert.equal(g.value, null)
	assert.equal(g.clean, null)
	assert.match(g.excluded ?? "", /ended before 15:00/)
})

test("no timeline is an absent answer, never a clean one", () => {
	const g = gameHabit(habitDef(DEFAULT_HABIT), null, meta())
	assert.equal(g.clean, null)
	assert.equal(g.excluded, "no timeline stored")
})

/* ------------------------------------------------------------- objective credit */

test("early objectives count takes minus concessions before 10:00, by KILLER only", () => {
	const events = [
		monster(4, "HORDE", 2), // mine
		monster(4, "HORDE", 2), // mine
		monster(6, "DRAGON", 9), // theirs
		monster(12, "DRAGON", 2) // after 10:00 — not in this window
	]
	const g = answer(events, "early-objectives")
	assert.equal(g.value, 1)
	assert.equal(g.clean, true)
})

test("level on early objectives is NOT clean — the cut is ahead, not level", () => {
	const g = answer([monster(4, "HORDE", 2), monster(6, "DRAGON", 9)], "early-objectives")
	assert.equal(g.value, 0)
	assert.equal(g.clean, false)
})

test("baron is not an early objective", () => {
	assert.equal(answer([monster(9, "BARON_NASHOR", 2)], "early-objectives").value, 0)
})

/* ------------------------------------------------------------------- the record */

const run = (pattern: readonly (boolean | null)[], key = DEFAULT_HABIT) =>
	habitRecord(
		habitDef(key),
		// Newest first, which is the order the DB hands them over in.
		pattern.map((clean, i) => ({
			gameId: i,
			createdMs: 1_000_000 - i,
			championName: "Lillia",
			win: true,
			durationSec: 1800,
			value: clean === null ? null : clean ? 0 : 1,
			clean,
			excluded: clean === null ? "game ended before 15:00" : null
		}))
	)

test("uncountable games are excluded from the denominator, not scored clean", () => {
	const r = run([true, null, false, null])
	assert.equal(r.counted, 2)
	assert.equal(r.rate.k, 1)
	assert.equal(r.rate.n, 2)
})

test("the streak steps over an uncountable game rather than breaking on it", () => {
	assert.equal(run([true, null, true, false]).streak, 2)
	assert.equal(run([false, true, true]).streak, 0)
})

test("one game is called a data point, not a pattern", () => {
	assert.match(run([true]).note, /data point, not a pattern/)
})

test("under the rate floor it refuses to call the number a rate", () => {
	const r = run(Array.from({ length: MIN_GAMES_FOR_RATE - 1 }, () => true))
	assert.match(r.note, /arithmetic, not a rate/)
})

test("with too few games per side it refuses the question of direction", () => {
	const r = run(Array.from({ length: MIN_GAMES_PER_SIDE * 2 - 2 }, (_, i) => i % 2 === 0))
	assert.equal(r.change, null)
	assert.match(r.note, /not enough games on each side/i)
})

test("an overlapping change is stated as NOT distinguishable from noise", () => {
	// 12 games: 4 of 6 clean recently, 3 of 6 before. Nowhere near separation.
	const r = run([true, true, true, true, false, false, true, true, true, false, false, false])
	assert.ok(r.change)
	assert.equal(r.change?.separated, false)
	assert.match(r.change?.note ?? "", /NOT distinguishable from noise/)
	assert.match(r.note, /NOT distinguishable from noise/)
})

test("a change is only called real when the two Wilson intervals do not overlap", () => {
	// The extreme case: 8 of 8 against 0 of 8. Anything less does not separate at this n, which
	// is the point of using the conservative test.
	const r = run([
		...Array.from({ length: 8 }, () => true),
		...Array.from({ length: 8 }, () => false)
	])
	assert.equal(r.change?.separated, true)
	assert.match(r.change?.note ?? "", /real change and it is better/)
})

test("the recent half is the NEWEST games, so a direction is not reported backwards", () => {
	const r = run([
		...Array.from({ length: 8 }, () => false),
		...Array.from({ length: 8 }, () => true)
	])
	assert.equal(r.change?.recent.p, 0)
	assert.match(r.change?.note ?? "", /worse/)
})

/* ------------------------------------------------- the evidence cannot drift quietly */

test("the base rate is rebuilt from the stored decision block and matches what-wins", () => {
	// 53 clean windows of 138 ranked games; 64 of 138 ahead on early objectives.
	assert.deepEqual(
		[baseRateOf(habitDef("survive-10-15")).k, baseRateOf(habitDef("survive-10-15")).n],
		[53, 138]
	)
	assert.deepEqual(
		[baseRateOf(habitDef("early-objectives")).k, baseRateOf(habitDef("early-objectives")).n],
		[64, 138]
	)
})

test("every habit quotes a measurement that survived the scoreboard control", () => {
	for (const h of HABITS) {
		const c = h.evidence.controlled
		// An odds ratio whose interval contains 1 did not survive, and nothing that did not
		// survive belongs on this card — that is the test that separates a lever from a symptom.
		assert.ok(c.lo > 1 || c.hi < 1, `${h.key} does not survive the scoreboard control`)
		assert.ok(h.evidence.q < 0.05, `${h.key} is above the q threshold`)
	}
})

test("the evidence sentence quotes the stored file and never the window on screen", () => {
	const s = evidenceSentence(habitDef("survive-10-15"))
	assert.match(s, /Over 138 ranked games/)
	assert.match(s, /70% \[56%-80%\] of the 53/)
	assert.match(s, /38% \[28%-48%\] of the 85/)
	assert.match(s, /odds ratio 0\.63 \[0\.43-0\.93\]/)
})

test("an unknown habit key resolves to the default rather than throwing", () => {
	assert.equal(habitDef("nonsense").key, DEFAULT_HABIT)
	assert.equal(habitDef(null).key, DEFAULT_HABIT)
})

test("there are exactly two habits, and adding a third is a decision not an accident", () => {
	// A tracker that follows six numbers is a dashboard, and a dashboard is what he ignores.
	assert.equal(HABITS.length, 2)
})
