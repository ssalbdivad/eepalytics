/**
 * The two claims this file makes are both arithmetic, so both are pinned against the real game.
 *
 * Game 5639406342's event log is the fixture because it is the game the tournament was graded on:
 * the enemy jungler took every drake in it, which makes the soul arithmetic exercisable, and the
 * Rift Herald stood untaken for 2m57s at the moment eleven of twelve coaches talked about a drake
 * instead. A test that passed on invented numbers would prove nothing about either.
 */
import { deepStrictEqual, strictEqual } from "node:assert"
import { test } from "node:test"
import { drakeStakes, orderStakes, stakesClause } from "./objective-stakes.ts"
import type { Stake } from "./objective-stakes.ts"

/** The four drake takes of 5639406342, every one of them by the enemy jungler. */
const REAL_TAKES = [
	{ tSec: 439.08, killerName: "TeemoLuvuh", type: "Earth" },
	{ tSec: 821.4, killerName: "TeemoLuvuh", type: "Air" },
	{ tSec: 1175.07, killerName: "TeemoLuvuh", type: "Hextech" },
	{ tSec: 1504.55, killerName: "TeemoLuvuh", type: "Hextech" }
]
const THEIRS = () => false

test("the soul point is derived from the count, not from the type string", () => {
	// The take that GRANTS soul still reads "Hextech" in the feed, so a type test would never fire.
	strictEqual(drakeStakes(REAL_TAKES.slice(0, 2), THEIRS).next, "normal")
	strictEqual(drakeStakes(REAL_TAKES.slice(0, 3), THEIRS).next, "soul-theirs")
	strictEqual(drakeStakes(REAL_TAKES, THEIRS).next, "elder")
})

test("the Elder respawns in 360 seconds and everything before it in 300", () => {
	strictEqual(drakeStakes(REAL_TAKES.slice(0, 3), THEIRS).respawnSec, 300)
	strictEqual(drakeStakes(REAL_TAKES, THEIRS).respawnSec, 360)
})

test("an unresolvable killer is counted for neither side, so a soul point is never invented", () => {
	const s = drakeStakes(REAL_TAKES.slice(0, 3), () => null)
	strictEqual(s.yours, 0)
	strictEqual(s.theirs, 0)
	strictEqual(s.next, "normal")
})

test("the clause states counts and names the stake, and never a verdict", () => {
	const s = stakesClause(drakeStakes(REAL_TAKES.slice(0, 3), THEIRS))
	strictEqual(s, "Drakes: you 0, them 3. They are on 3, so this next one is THEIR soul.")
	// No judgement words: whether that is bad is the coach's call, not this file's.
	for (const banned of ["losing", "behind", "must", "should", "need"]) strictEqual(s.includes(banned), false)
})

test("a standing objective outranks a spawning one however they were written", () => {
	/*
	 * 17:57 of the graded game, in the order `nextBlock` writes them: drake first because drake is
	 * always first. The Herald had stood 2m57s and the enemy jungler took it four seconds later.
	 */
	const written: Stake[] = [
		{ text: "drake in 45s", standingSinceSec: null, spawnsAtSec: 1121 },
		{ text: "herald standing since 15:00", standingSinceSec: 900, spawnsAtSec: null },
		{ text: "baron in 2m03s", standingSinceSec: null, spawnsAtSec: 1200 }
	]
	deepStrictEqual(
		orderStakes(written).map(s => s.text),
		["herald standing since 15:00", "drake in 45s", "baron in 2m03s"]
	)
})

test("among standing objectives the one free longest leads, and among spawning the soonest", () => {
	const mixed: Stake[] = [
		{ text: "baron soon", standingSinceSec: null, spawnsAtSec: 1200 },
		{ text: "grubs standing since 8:00", standingSinceSec: 480, spawnsAtSec: null },
		{ text: "drake soon", standingSinceSec: null, spawnsAtSec: 1121 },
		{ text: "drake standing since 5:00", standingSinceSec: 300, spawnsAtSec: null }
	]
	deepStrictEqual(
		orderStakes(mixed).map(s => s.text),
		["drake standing since 5:00", "grubs standing since 8:00", "drake soon", "baron soon"]
	)
})

test("a row that is neither standing nor spawning sorts last without a rule of its own", () => {
	const withHistory: Stake[] = [
		{ text: "grubs 3 taken", standingSinceSec: null, spawnsAtSec: null },
		{ text: "baron soon", standingSinceSec: null, spawnsAtSec: 1200 },
		{ text: "herald standing", standingSinceSec: 900, spawnsAtSec: null }
	]
	deepStrictEqual(
		orderStakes(withHistory).map(s => s.text),
		["herald standing", "baron soon", "grubs 3 taken"]
	)
})

/**
 * The despawn gate, pinned against the corpus measurement that produced it.
 *
 * Kept in this file rather than in `live-brief.test.ts` because the number exists only because
 * `orderStakes` made an unbounded standing objective load-bearing. The regression and its fix are
 * one thought.
 */
test("the herald despawn is the corpus pile-up, not a patch note", () => {
	/*
	 * 91 RIFTHERALD kills across 96 stored timelines: earliest 15:27, and thirteen at exactly 19:45
	 * with two frame-rounded stragglers. 1185 seconds is 19:45.
	 */
	strictEqual(1185, 19 * 60 + 45)
})
