import assert from "node:assert/strict"
import { test } from "node:test"
import { speechDurationSec } from "./timeliness.ts"
import {
	CS_DEADLINE_GRACE_SEC,
	CS_DEADLINE_SEC,
	GRUB_WINDOW_CLOSE_SEC,
	GRUB_WINDOW_OPEN_SEC,
	HABITS,
	HABITS_CORPUS,
	HABIT_PROHIBITIONS,
	habitCues,
	type HabitInput
} from "./habits.ts"

/** A state in which nothing fires. Each test overrides only the field its cue reads. */
const idle = (over: Partial<HabitInput> = {}): HabitInput => ({
	tSec: 200,
	cs: 30,
	grubs: { mine: 0, theirs: 0 },
	heralds: { mine: 0, theirs: 0 },
	...over
})

/* ============================================================ the honesty check */

/**
 * THE LOAD-BEARING TEST. Every number that reaches a spoken line must be either a live reading
 * or a figure the habit declared, and `Habit.figures` is checked against `data/eval/his-habits.md`
 * by a human exactly once. A career statistic invented by a future edit sounds precisely like a
 * measured one — the parser in `review/parse.ts` exists for the same reason on the review side,
 * and this is that guard for the live side.
 */
test("no cue speaks a number that is neither live nor declared", () => {
	const states: HabitInput[] = [
		idle({ tSec: 280, cs: 20 }),
		idle({ tSec: 400, cs: 30 }),
		idle({ tSec: 440, grubs: { mine: 0, theirs: 0 } }),
		idle({ tSec: 900, heralds: { mine: 0, theirs: 1 } }),
		idle({ tSec: 700, grubs: { mine: 0, theirs: 3 } })
	]
	let seen = 0
	for (const s of states)
		for (const cue of habitCues(s)) {
			seen++
			const declared = HABITS.find(h => h.key === cue.key)
			assert.ok(declared, `cue ${cue.key} has no habit`)
			const live = new Set<number>([
				Math.floor(s.tSec / 60),
				Math.round(s.tSec % 60),
				s.cs ?? -1,
				...CS_DEADLINE_SEC.map(d => d.cs)
			])
			for (const raw of cue.text.match(/\d+/g) ?? []) {
				const n = Number(raw)
				assert.ok(
					live.has(n) || declared.figures.includes(n),
					`cue ${cue.key} speaks ${n}, which is neither a live reading nor one of its declared figures [${declared.figures.join(", ")}]`
				)
			}
		}
	assert.ok(seen >= 4, `expected the fixtures to exercise several cues, got ${seen}`)
})

test("every habit carries its sample size and its evidence", () => {
	for (const h of HABITS) {
		assert.ok(h.n >= 30, `${h.key} claims a habit from ${h.n} games`)
		assert.ok(h.n <= HABITS_CORPUS.games, `${h.key} claims more games than the corpus holds`)
		assert.ok(/p\s*[=<]/.test(h.evidence), `${h.key} states no test result`)
		assert.ok(h.figures.length > 0, `${h.key} declares no figures`)
		assert.ok(h.claim.length < 260, `${h.key} claim reads as prose, not a claim`)
	}
})

test("every prohibition carries the number that killed it", () => {
	assert.ok(HABIT_PROHIBITIONS.length >= 10)
	for (const p of HABIT_PROHIBITIONS)
		assert.ok(/\d/.test(p.refutation), `"${p.claim}" is refused without a number`)
})

/* ============================================================ H1, the first clear */

test("the clear cue fires only after a deadline he has actually missed", () => {
	// 30 CS is due by 270 seconds. At 260 with 20 CS there is still time.
	assert.equal(habitCues(idle({ tSec: 260, cs: 20 })).length, 0)
	const late = habitCues(idle({ tSec: 280, cs: 20 }))
	assert.equal(late[0]?.key, "slow-first-clear")
	// Reaching it on time says nothing at all — silence is the default.
	assert.equal(habitCues(idle({ tSec: 280, cs: 30 })).length, 0)
})

test("a decile reading floored to tens still decides the deadline exactly", () => {
	// The live client only ever reports multiples of ten, so 29 true CS arrives as 20 and 30 as
	// 30. `floor10(cs) >= 30` is true exactly when `cs >= 30`, which is why the cue asks about a
	// decile and never about a CS figure.
	for (const reading of [0, 10, 20]) assert.equal(habitCues(idle({ tSec: 280, cs: reading })).length, 1)
	for (const reading of [30, 40, 50]) assert.equal(habitCues(idle({ tSec: 280, cs: reading })).length, 0)
})

test("the clear cue goes quiet once the clear can no longer be rescued", () => {
	const last = CS_DEADLINE_SEC[CS_DEADLINE_SEC.length - 1]!
	assert.equal(habitCues(idle({ tSec: last.bySec + 10, cs: 20 }))[0]?.key, "slow-first-clear")
	assert.equal(
		habitCues(idle({ tSec: last.bySec + CS_DEADLINE_GRACE_SEC + 10, cs: 20 })).filter(
			c => c.key === "slow-first-clear"
		).length,
		0,
		"a missed clear announced two minutes late is a post-mortem, not coaching"
	)
})

test("missing both deadlines speaks the more recent one", () => {
	const cue = habitCues(idle({ tSec: 400, cs: 20 }))[0]!
	assert.ok(cue.text.includes("40 CS"), cue.text)
	assert.ok(!cue.text.includes("30 CS"), cue.text)
})

test("no CS reading, no clear cue", () => {
	assert.equal(habitCues(idle({ tSec: 280, cs: null })).length, 0)
	assert.equal(habitCues({ tSec: 280 }).length, 0)
})

/* ============================================================ H2, the grub window */

test("the grub cue fires in the minute before his counterpart commits, and not after", () => {
	const before = habitCues(idle({ tSec: GRUB_WINDOW_OPEN_SEC - 20, cs: 40 }))
	assert.equal(before.length, 0)
	const inside = habitCues(idle({ tSec: 440, cs: 40 }))
	assert.equal(inside[0]?.key, "grub-window")
	const after = habitCues(idle({ tSec: GRUB_WINDOW_CLOSE_SEC + 30, cs: 60 }))
	assert.equal(after.filter(c => c.key === "grub-window").length, 0)
})

test("the grub cue is silent once a grub has been taken by anyone", () => {
	assert.equal(habitCues(idle({ tSec: 440, cs: 40, grubs: { mine: 1, theirs: 0 } })).length, 0)
	const conceded = habitCues(idle({ tSec: 440, cs: 40, grubs: { mine: 0, theirs: 1 } }))
	assert.equal(conceded.filter(c => c.key === "grub-window").length, 0)
})

test("no grub count, no grub cue", () => {
	assert.equal(habitCues({ tSec: 440, cs: 40 }).length, 0)
})

/* ============================================================ H3, the consequence */

test("the topside cue waits until topside has actually been conceded", () => {
	assert.equal(habitCues(idle({ tSec: 900, cs: 90, heralds: { mine: 1, theirs: 0 } })).length, 0)
	const lost = habitCues(idle({ tSec: 900, cs: 90, heralds: { mine: 0, theirs: 1 } }))
	assert.equal(lost[0]?.key, "topside-conceded")
	// One grub down is a fight, not a habit; two is the pattern.
	assert.equal(habitCues(idle({ tSec: 700, cs: 70, grubs: { mine: 1, theirs: 2 } })).length, 0)
	assert.equal(
		habitCues(idle({ tSec: 700, cs: 70, grubs: { mine: 0, theirs: 2 } }))[0]?.key,
		"topside-conceded"
	)
})

test("the topside cue names the dragon, because that is what makes it specific", () => {
	const cue = habitCues(idle({ tSec: 900, cs: 90, heralds: { mine: 0, theirs: 1 } }))[0]!
	assert.match(cue.text, /dragon/i)
})

/* ============================================================ speaking once, and out loud */

test("a habit already spoken this game is not offered again", () => {
	const s = idle({ tSec: 280, cs: 20, spoken: ["slow-first-clear"] })
	assert.equal(habitCues(s).length, 0)
})

test("no cue contains an abbreviation a voice would mangle", () => {
	const states: HabitInput[] = [
		idle({ tSec: 280, cs: 20 }),
		idle({ tSec: 440, cs: 40 }),
		idle({ tSec: 900, cs: 90, heralds: { mine: 0, theirs: 1 } })
	]
	for (const s of states)
		for (const cue of habitCues(s)) {
			// "52s" came out as "fifty two seds" and "1334g" as a letter, in a real game, out loud.
			assert.doesNotMatch(cue.text, /\d+\s*[sg]\b/, cue.text)
			assert.doesNotMatch(cue.text, /%/, cue.text)
			assert.ok(cue.text.length <= 220, `${cue.key} is too long to say: ${cue.text.length}`)
		}
})

/**
 * The sentence is part of the arithmetic. `speechDurationSec` is a least-squares fit over
 * twenty-four of this coach's own lines rendered through real TTS (n = 24, R2 0.895); everything
 * the app already says runs 2.1 to 7.5 seconds, median 3.9. The first drafts of these cues ran
 * 12.9, 9.3 and 11.4 — long enough that the fight the line was about is over before it is.
 */
test("no cue takes longer to say than the coach's own longest line", () => {
	const states: HabitInput[] = [
		idle({ tSec: 280, cs: 20 }),
		idle({ tSec: 400, cs: 30 }),
		idle({ tSec: 440, cs: 40 }),
		idle({ tSec: 900, cs: 90, heralds: { mine: 0, theirs: 1 } }),
		idle({ tSec: 700, cs: 70, grubs: { mine: 0, theirs: 3 } })
	]
	for (const s of states)
		for (const cue of habitCues(s)) {
			const sec = speechDurationSec(cue.text)
			assert.ok(sec <= 6, `${cue.key} takes ${sec.toFixed(1)} seconds to say: ${cue.text}`)
		}
})

test("every cue carries the evidence it was built from", () => {
	for (const s of [idle({ tSec: 280, cs: 20 }), idle({ tSec: 440, cs: 40 })])
		for (const cue of habitCues(s)) assert.ok(cue.because.length > 40, cue.key)
})
