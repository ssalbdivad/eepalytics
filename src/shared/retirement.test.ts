/**
 * A fact that returns the same answer every turn is not information.
 *
 * The mechanism is in `shared/live-state.ts`; the cases below are the two failures that forced it,
 * a game apart and with different subjects. The first was the jungle CS race — 82 of 88 recorded
 * states said "he is behind you" and none said "ahead". The second was the objective schedule that
 * replaced it: the dragon entry was in the block on 300 turns of 306, and the soul/baron pair
 * switched on at 19:42 and was still being read out at 36:43.
 *
 * Both directions are pinned. A rule that only ever goes quieter would be indistinguishable from
 * deleting the section, so every retirement test here has a partner that proves the fact comes back
 * when its answer flips.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
	newRetirementMemory,
	objectiveSchedule,
	renderSchedule,
	resetRetirementMemory,
	retireSchedule,
	SCHEDULE_SOON_SEC,
	SCHEDULE_UNCONTESTED_SEC,
	scheduleQuestion,
	spendAnswer,
	standingOf
} from "./live-state.ts"
import type { Question } from "./live-state.ts"

const race = (verdict: string, budget?: number): Question => ({ key: "race", verdict, ...(budget ? { budget } : {}) })

describe("the retirement ledger", () => {
	it("answers a question once and then retires it", () => {
		const mem = newRetirementMemory()
		assert.equal(standingOf(mem, race("ahead"), 300).open, true)
		spendAnswer(mem, race("ahead"), 300)
		assert.equal(standingOf(mem, race("ahead"), 320).open, false)
		assert.equal(standingOf(mem, race("ahead"), 2000).open, false)
	})

	it("brings it back the moment the answer flips, and says what it flipped from", () => {
		/*
		 * The only time this fact was ever news. A settled race becoming a question again is worth
		 * cutting in on, which is why a retired question is retired rather than deleted — nothing
		 * that has been deleted can flip.
		 */
		const mem = newRetirementMemory()
		spendAnswer(mem, race("ahead"), 300)
		const flip = standingOf(mem, race("behind"), 900)
		assert.equal(flip.open, true)
		assert.equal(flip.flipped, true)
		assert.equal(flip.from, "ahead")
		assert.equal(flip.heldSec, 0)
	})

	it("does not report the same flip twice, and reports it twice in the same turn", () => {
		/*
		 * `standingOf` writes as it looks — noticing a change IS the observation — so it has to be
		 * safe to call more than once on one turn. `allowed` in `analysis/live-facts.ts` calls it
		 * once per candidate list.
		 */
		const mem = newRetirementMemory()
		spendAnswer(mem, race("ahead"), 300)
		assert.equal(standingOf(mem, race("behind"), 900).flipped, true)
		assert.equal(standingOf(mem, race("behind"), 900).flipped, true)
		assert.equal(standingOf(mem, race("behind"), 920).flipped, false)
	})

	it("counts how long the current answer has stood", () => {
		const mem = newRetirementMemory()
		standingOf(mem, race("ahead"), 300)
		assert.equal(standingOf(mem, race("ahead"), 480).heldSec, 180)
	})

	it("spends a budget bigger than one before retiring", () => {
		const mem = newRetirementMemory()
		spendAnswer(mem, race("ahead", 2), 300)
		assert.equal(standingOf(mem, race("ahead", 2), 320).open, true)
		spendAnswer(mem, race("ahead", 2), 320)
		assert.equal(standingOf(mem, race("ahead", 2), 340).open, false)
	})

	it("keeps questions apart by key", () => {
		const mem = newRetirementMemory()
		spendAnswer(mem, race("ahead"), 300)
		assert.equal(standingOf(mem, { key: "farm-pace", verdict: "ahead" }, 300).open, true)
	})

	it("forgets everything between games", () => {
		const mem = newRetirementMemory()
		spendAnswer(mem, race("ahead"), 300)
		resetRetirementMemory(mem)
		assert.equal(standingOf(mem, race("ahead"), 300).open, true)
	})
})

describe("the schedule, retired", () => {
	it("puts a spawn in front of him once per answer, not once per turn", () => {
		/*
		 * THE MEASURED FAULT. Replayed over his four recorded games at the shipped turn, the dragon
		 * entry was in the block on 300 turns of 306 and 579 of 673 offered context items repeated a
		 * subject the previous turn had already carried.
		 */
		const mem = newRetirementMemory()
		const live = (t: number) =>
			retireSchedule(objectiveSchedule([], t), mem, t).filter(o => !o.retired && o.name === "Dragon")
		assert.equal(live(60).length, 1, "the first telling")
		assert.equal(live(80).length, 0, "the same answer twenty seconds later")
		assert.equal(live(120).length, 0)
	})

	it("comes back when the countdown becomes a route, and again when it spawns", () => {
		const mem = newRetirementMemory()
		const live = (t: number) =>
			retireSchedule(objectiveSchedule([], t), mem, t).filter(o => !o.retired && o.name === "Dragon")
		assert.equal(live(60).length, 1, "far out")
		assert.equal(live(300 - SCHEDULE_SOON_SEC).length, 1, "close enough to walk")
		assert.equal(live(300 - SCHEDULE_SOON_SEC + 20).length, 0)
		assert.equal(live(305).length, 1, "standing there")
		assert.equal(live(325).length, 0)
		assert.equal(live(300 + SCHEDULE_UNCONTESTED_SEC).length, 1, "and nobody has contested it")
		assert.equal(live(300 + SCHEDULE_UNCONTESTED_SEC + 20).length, 0)
	})

	it("treats the next spawn as a new question, because it is", () => {
		const mem = newRetirementMemory()
		const at = (t: number, ev: Parameters<typeof objectiveSchedule>[0]) =>
			retireSchedule(objectiveSchedule(ev, t), mem, t).filter(o => !o.retired && o.name === "Dragon")
		assert.equal(at(310, []).length, 1)
		assert.equal(at(330, []).length, 0)
		// Taken at 340: the entry now points at a spawn that did not exist a turn ago.
		assert.equal(at(360, [{ kind: "dragon", tSec: 340, side: "theirs" }]).length, 1)
	})

	it("never retires two different objectives together", () => {
		const mem = newRetirementMemory()
		const t = 1300
		const first = retireSchedule(objectiveSchedule([], t), mem, t)
		assert.equal(first.every(o => !o.retired), true, first.map(o => o.name).join(", "))
		const again = retireSchedule(objectiveSchedule([], t + 20), mem, t + 20)
		assert.equal(again.every(o => o.retired), true, again.map(o => o.name).join(", "))
	})

	it("keeps the retired timer in the block, fenced, and never deletes it", () => {
		/*
		 * Deleting is the cheaper change and the wrong one: the map's clock exists nowhere else, and
		 * an arm prompted to prefer objectives WITHOUT the timers reached 37% against the schedule's
		 * 55% and told him to take a dragon fifty-six seconds before the first dragon spawned.
		 */
		const mem = newRetirementMemory()
		retireSchedule(objectiveSchedule([], 60), mem, 60)
		const out = renderSchedule(retireSchedule(objectiveSchedule([], 80), mem, 80))
		assert.match(out, /Already covered/)
		assert.match(out, /Dragon spawns at 5:00/)
		assert.match(out, /not to be said again/)
		assert.equal(out.includes("### What is coming"), false)
	})

	it("labels a spawn and a standing objective as different answers", () => {
		const up = scheduleQuestion({ name: "Baron", state: "up", atSec: 1200, sec: 10 })
		const held = scheduleQuestion({ name: "Baron", state: "up", atSec: 1200, sec: SCHEDULE_UNCONTESTED_SEC })
		const coming = scheduleQuestion({ name: "Baron", state: "coming", atSec: 1200, sec: 30 })
		assert.equal(up.key, held.key)
		assert.equal(up.key, coming.key)
		assert.notEqual(up.verdict, held.verdict)
		assert.notEqual(up.verdict, coming.verdict)
	})

	it("does not let a countdown be its own answer", () => {
		/*
		 * The whole trick. "Dragon spawns in 214 seconds" is a different string every turn and the
		 * same information every turn; a verdict that carried the countdown could never retire.
		 */
		assert.equal(
			scheduleQuestion({ name: "Dragon", state: "coming", atSec: 300, sec: 214 }).verdict,
			scheduleQuestion({ name: "Dragon", state: "coming", atSec: 300, sec: 190 }).verdict
		)
	})
})
