/**
 * The frame accounting in `scripts/ablate-autonomy.ts`.
 *
 * This file exists because a run of that harness reported a result about PICTURES on a corpus that
 * carried none, twice, and both times the printed table looked fine. The three helpers tested here
 * are the three places a frame can vanish, pulled out of `buildStates` so a filesystem, a database
 * and a Gemini key are not required to prove they still work:
 *
 *   - `lateEligible`   — the filter that silently dropped every frame-bearing sample from the LATE
 *                        grid whenever anyone asked for a whole-game grid with pictures on it;
 *   - `relocateFrame`  — the `existsSync` that dropped a quarter of the corpus because the absolute
 *                        path in the row was written by a checkout that has since been renamed;
 *   - `frameCoverage`  — the count that makes both of the above impossible to report past.
 *
 * The bar for each test is not "the helper computes something". It is "the exact failure that cost
 * a round would now fail this test".
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { frameCoverage, lateEligible, pickGridSample, relocateFrame, statsFor } from "../../scripts/ablate-autonomy.ts"
import type { Cell, CellTurn } from "../../scripts/ablate-autonomy.ts"

/* =========================================================== lateEligible */

/** Samples arrive about every six seconds; the frames only reach 0:06–6:42 of this game. */
const built = Array.from({ length: 60 }, (_, i) => ({ line: i + 1, tSec: 6 + i * 6 }))
/** The samples a frame joined — the first seven minutes, which is where every picture lives. */
const framed = new Set(built.filter(b => b.tSec <= 402).map(b => b.line))

test("a whole-game LATE grid keeps the frame-bearing samples", () => {
	const eligible = lateEligible(built, 0, framed, false)
	assert.equal(eligible.length, built.length)
	// The point: the window the pictures exist for is still in the grid.
	assert.ok(eligible.some(b => b.tSec <= 402))
})

test("--late-skip-paired is exactly the bug: it empties the frame window", () => {
	const eligible = lateEligible(built, 0, framed, true)
	// Not one sample survives inside the frame window, so `--late-frames` can attach nothing there.
	assert.equal(eligible.filter(b => b.tSec <= 402).length, 0)
	// And it looks harmless, because the grid is still most of the game.
	assert.equal(eligible.length, built.filter(b => b.tSec > 402).length)
})

test("the exclusion was always redundant in the default configuration", () => {
	// The default LATE set starts after the last paired frame, so `tSec > fromSec` already excludes
	// every paired sample. Skipping them on top of that changes nothing — which is why the flag went
	// unnoticed until someone moved `--late-from` back over the frames.
	assert.deepEqual(lateEligible(built, 402, framed, true), lateEligible(built, 402, framed, false))
})

/* ========================================================= pickGridSample */

const none = new Set<number>()
const never = () => false

test("without pictures the grid still takes the sample nearest the mark", () => {
	const c = [{ line: 1, tSec: 14 }, { line: 2, tSec: 20 }, { line: 3, tSec: 26 }]
	assert.equal(pickGridSample(c, 20, 10, none, never, false)?.line, 2)
})

test("a mark with nothing inside its tolerance takes nothing", () => {
	assert.equal(pickGridSample([{ line: 1, tSec: 60 }], 20, 10, none, never, false), null)
})

test("a sample already taken by an earlier mark is not taken twice", () => {
	const c = [{ line: 1, tSec: 20 }, { line: 2, tSec: 26 }]
	assert.equal(pickGridSample(c, 20, 10, new Set([1]), never, false)?.line, 2)
})

test("--late-frames prefers the neighbour that carries a picture, inside the same tolerance", () => {
	// The nearest sample to the mark has no frame within the gate; the one six seconds later does.
	// Taking the nearest is how a twenty-second grid came out mostly blind over a window where every
	// state had a picture available.
	const c = [{ line: 1, tSec: 20 }, { line: 2, tSec: 26 }]
	const framed = (b: { line: number }) => b.line === 2
	assert.equal(pickGridSample(c, 20, 10, none, framed, true)?.line, 2)
	assert.equal(pickGridSample(c, 20, 10, none, framed, false)?.line, 1)
})

test("the preference never reaches outside the tolerance the grid promised", () => {
	// A picture eleven seconds off a twenty-second mark is a different moment, not a better one.
	const c = [{ line: 1, tSec: 20 }, { line: 2, tSec: 31 }]
	const framed = (b: { line: number }) => b.line === 2
	assert.equal(pickGridSample(c, 20, 10, none, framed, true)?.line, 1)
})

test("when no candidate has a picture the preference changes nothing", () => {
	const c = [{ line: 1, tSec: 20 }, { line: 2, tSec: 26 }]
	assert.equal(pickGridSample(c, 20, 10, none, never, true)?.line, 1)
})

/* ========================================================== relocateFrame */

const on = (...paths: string[]): ((p: string) => boolean) => {
	const set = new Set(paths)
	return p => set.has(p)
}

test("a path that is where the row says it is comes back untouched", () => {
	const found = relocateFrame("/home/me/eepalytics/data/journal/js-a/js-a-1.jpg", "/home/me/eepalytics/data", on("/home/me/eepalytics/data/journal/js-a/js-a-1.jpg"))
	assert.deepEqual(found, { path: "/home/me/eepalytics/data/journal/js-a/js-a-1.jpg", relocated: false })
})

test("a frame recorded under the project's OLD name is found, not dropped", () => {
	// 503 of the 1876 rows in the live database look exactly like this.
	const found = relocateFrame(
		"/home/me/coachskaffur/data/journal/js-a/js-a-1.jpg",
		"/home/me/eepalytics/data",
		on("/home/me/eepalytics/data/journal/js-a/js-a-1.jpg")
	)
	assert.deepEqual(found, { path: "/home/me/eepalytics/data/journal/js-a/js-a-1.jpg", relocated: true })
})

test("a frame that is genuinely gone returns null so it can be COUNTED", () => {
	assert.equal(relocateFrame("/old/data/journal/js-a/js-a-1.jpg", "/new/data", on()), null)
	// No `/journal/` segment means there is nothing to rebase, and guessing would invent a picture.
	assert.equal(relocateFrame("/somewhere/else/js-a-1.jpg", "/new/data", on("/new/data/js-a-1.jpg")), null)
})

test("relocation never reaches outside the data directory it was given", () => {
	const found = relocateFrame("/old/data/journal/js-a/js-a-1.jpg", "/new/data", on("/other/data/journal/js-a/js-a-1.jpg"))
	assert.equal(found, null)
})

/* ========================================================== frameCoverage */

const st = (framePath: string | null, frameSkewSec: number | null, frameSession: string | null, frameGameId: number | null) => ({
	framePath,
	frameSkewSec,
	frameSession,
	frameGameId
})

test("coverage counts images, not intentions", () => {
	const c = frameCoverage([
		st("/d/journal/js-a/1.jpg", 0.4, "js-a", 5635467422),
		st("/d/journal/js-a/2.jpg", 2.9, "js-a", 5635467422),
		st(null, null, null, null),
		st(null, null, null, null)
	])
	assert.equal(c.states, 4)
	assert.equal(c.framed, 2)
	assert.equal(c.blind, 2)
	assert.equal(c.frameRate, 0.5)
	assert.equal(c.skewMaxSec, 2.9)
	assert.deepEqual(c.sessions, ["js-a"])
	assert.deepEqual(c.gameIds, [5635467422])
})

test("a set with no pictures reports zero rather than nothing", () => {
	const c = frameCoverage([st(null, null, null, null), st(null, null, null, null)])
	assert.equal(c.framed, 0)
	assert.equal(c.frameRate, 0)
	assert.equal(c.skewMaxSec, 0)
	assert.deepEqual(c.sessions, [])
	assert.deepEqual(c.gameIds, [])
})

test("an empty set does not divide by zero", () => {
	const c = frameCoverage([])
	assert.equal(c.states, 0)
	assert.equal(c.frameRate, 0)
})

test("frames from two journal sessions are visible, because the join is on wall clock", () => {
	// The query has no game filter — "never across games" is a property of the clocks, not the SQL.
	// If it ever stops being true, it has to be READABLE, not inferred.
	const c = frameCoverage([
		st("/d/journal/js-a/1.jpg", 0.1, "js-a", 5635467422),
		st("/d/journal/js-b/1.jpg", 0.1, "js-b", 5635921368)
	])
	assert.deepEqual(c.sessions, ["js-a", "js-b"])
	assert.equal(c.gameIds.length, 2)
})

/* ================================================= the cell contradicts itself */

const turn = (framePath: string | null): CellTurn => ({
	stateId: "s",
	tSec: 100,
	clock: "1:40",
	rankedFacts: 0,
	framePath,
	line: "take raptors",
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
	useful: true
})

test("a cell that ASKED for frames and sent none says so in its own stats", () => {
	// This is the whole guarantee. `withFrame` is what the run intended; `framesAttached` is what it
	// did. A report calling this cell a vision result contradicts the same object it is quoting.
	const blind: Cell = { set: "late", arm: "shipped", withFrame: true, framesAttached: 0, turns: [turn(null), turn(null)] }
	const s = statsFor(blind, 1)
	assert.equal(s.withFrame, true)
	assert.equal(s.framesAttached, 0)
	assert.equal(s.turns, 2)
})

test("a cell that sent pictures counts them", () => {
	const seeing: Cell = {
		set: "paired",
		arm: "shipped",
		withFrame: true,
		framesAttached: 1,
		turns: [turn("/d/journal/js-a/1.jpg"), turn(null)]
	}
	assert.equal(statsFor(seeing, 1).framesAttached, 1)
})
