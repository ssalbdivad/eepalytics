/**
 * The value model and the two decisions built on it.
 *
 * Nothing here reads a game. `live-schedule.ts` takes numbers and answers with numbers, which is
 * the whole reason it exists as a separate file — the facts are read off the feed in `observeTick`,
 * where the tick is, and the JUDGEMENT about what those facts are worth is here, where it can be
 * argued with and re-priced without touching the detector.
 *
 * The replay of the two paired games lives in `live-events.test.ts`, next to the detector it
 * exercises. These are the invariants that must hold whatever the corpus says.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import {
	askValue,
	chooseTurn,
	turnValue,
	CARRY_ENEMY_TAKE,
	CARRY_FRESH_SEC,
	CARRY_MAX,
	OBJECTIVE_PRIZE,
	PREEMPT_RATIO,
	SETTLE_SEC,
	SOUL_POINT_PRIZE,
	type AskFacts,
	type ScheduledAsk
} from "./live-schedule.ts"

/** A contest nobody is contesting: the prize and the clock, with every modifier at rest. */
const facts = (o: Partial<AskFacts> = {}): AskFacts => ({
	what: "drake",
	untilSpawnSec: null,
	standing: true,
	cpDead: false,
	enemiesDown: 0,
	reach: "unknown",
	drakeStacks: 0,
	...o
})

describe("askValue", () => {
	it("ranks the epics in the order a jungler would", () => {
		const at = (what: string): number => askValue(facts({ what }))
		ok(at("baron") > at("rift herald"), "baron over herald")
		ok(at("rift herald") > at("drake"), "herald over drake")
		ok(at("drake") > at("voidgrubs"), "drake over grubs")
		// A turn with no objective behind it is the floor and must never outrank a contest.
		ok(askValue(facts({ what: null, standing: false })) < at("voidgrubs"))
	})

	/*
	 * THE SOUL POINT is the one place the prize table is not flat, and it is the difference between
	 * a coach and a stat sheet: a fourth drake either wins the soul or denies it, and every jungler
	 * knows that a first drake and a fourth are not the same object.
	 */
	it("prices a fourth drake as Baron, whichever side is on three", () => {
		strictEqual(askValue(facts({ what: "drake", drakeStacks: 3 })), SOUL_POINT_PRIZE)
		ok(askValue(facts({ what: "drake", drakeStacks: 3 })) > askValue(facts({ what: "drake" })))
		strictEqual(askValue(facts({ what: "drake", drakeStacks: 2 })), OBJECTIVE_PRIZE.drake)
	})

	/*
	 * THE MULTIPLIERS ARE A MAXIMUM, NOT A PRODUCT, and the reason is that they are usually the same
	 * event. The counterpart dying and two of the enemy being down is one fight seen twice; pricing
	 * it twice would let a skirmish outrank Baron, which is exactly the ordering this file exists to
	 * get right.
	 */
	it("does not charge one fight twice", () => {
		const both = askValue(facts({ cpDead: true, enemiesDown: 3 }))
		const one = askValue(facts({ cpDead: true }))
		strictEqual(both, one)
		ok(one > askValue(facts()), "the counterpart being dead is still worth something")
	})

	it("discounts what he cannot reach and is inert until the port answers", () => {
		ok(askValue(facts({ reach: "cannot" })) < askValue(facts()))
		ok(askValue(facts({ reach: "can" })) > askValue(facts()))
		// The shipped port answers `unknown` for everything, so today every window prices the same.
		strictEqual(askValue(facts({ reach: "unknown" })), askValue(facts()))
	})

	it("a decision he has now beats the same decision forty seconds out", () => {
		const now = askValue(facts({ what: "drake", standing: true }))
		const soon = askValue(facts({ what: "drake", standing: false, untilSpawnSec: 40 }))
		const far = askValue(facts({ what: "drake", standing: false, untilSpawnSec: 95 }))
		ok(now > soon && soon > far, `${now} ${soon} ${far}`)
	})

	/*
	 * THE ONE CROSS-TIER CLAIM the gaps in `OBJECTIVE_PRIZE` are chosen to make true: being FREE can
	 * promote a contest past the objective above it, and never past the one above that. A free drake
	 * beats a contested Herald; it does not beat a Baron, because a Baron nobody is contesting yet
	 * is still the bigger decision.
	 */
	it("free promotes one tier and not two", () => {
		const freeDrake = askValue(facts({ what: "drake", cpDead: true }))
		ok(freeDrake > askValue(facts({ what: "rift herald" })), "free drake over a herald")
		ok(freeDrake < askValue(facts({ what: "baron" })), "and not over a baron")
	})
})

/** An ask or a note on the queue, spelled out. */
const q = (o: Partial<ScheduledAsk> = {}): ScheduledAsk => ({
	asks: true,
	reactive: false,
	seenAtSec: 100,
	value: 50,
	...o
})

describe("turnValue", () => {
	/*
	 * THE BEST ASK, NOT THE SUM. The coach gets one sentence and will spend it on one thing: a
	 * second open window does not make the first more valuable. Summing is how a quiet stretch full
	 * of small notes outranks a Baron standing free.
	 */
	it("takes the best ask rather than adding them up", () => {
		strictEqual(turnValue([q({ value: 40 }), q({ value: 90 }), q({ value: 20 })], 100), 90)
	})

	it("adds what the fresh context is worth, up to the cap", () => {
		const asks = [q({ value: 50 })]
		const note = (value: number, seenAtSec = 100): ScheduledAsk =>
			q({ asks: false, value, seenAtSec })
		strictEqual(turnValue([...asks, note(CARRY_ENEMY_TAKE)], 100), 50 + CARRY_ENEMY_TAKE)
		strictEqual(
			turnValue([...asks, note(40), note(40), note(40)], 100),
			50 + CARRY_MAX,
			"stacked context can promote a contest past its neighbour, never past the tier above"
		)
	})

	/*
	 * A note stops being a REASON to ask long before it becomes a lie. `CONTEXT_CARRY_SEC` (90s) is
	 * when the detector drops it as a false premise; this is shorter, because a kill eighty seconds
	 * ago is true, sayable, and not why anybody should be asked anything now.
	 */
	it("stops counting context that is no longer why anyone should be asked", () => {
		const stale = q({ asks: false, value: 40, seenAtSec: 100 })
		strictEqual(turnValue([q({ value: 50 }), stale], 100 + CARRY_FRESH_SEC), 90)
		strictEqual(turnValue([q({ value: 50 }), stale], 100 + CARRY_FRESH_SEC + 1), 50)
	})
})

describe("chooseTurn", () => {
	const base = {
		nowSec: 100,
		settleSinceSec: null as number | null,
		settleBestValue: 0,
		heartbeat: false,
		nextOpeningSec: null as number | null
	}

	it("says nothing when nothing asks", () => {
		const c = chooseTurn({ ...base, pending: [q({ asks: false })] })
		strictEqual(c.fire, false)
		strictEqual(c.why, "nothing")
	})

	/*
	 * A REACTIVE ASK NEVER WAITS. `live-facts.ts` measured reactive premises 40% stale at ONE
	 * second, and this is also what protects the graded-useful 20:53 / 21:05 pair in game
	 * 5639406342 — twelve seconds apart, both reactive, both still asked.
	 */
	it("fires a decision that decays in seconds, even mid-settle", () => {
		const c = chooseTurn({
			...base,
			pending: [q({ reactive: true })],
			settleSinceSec: 98,
			settleBestValue: 1000
		})
		strictEqual(c.fire, true)
		strictEqual(c.why, "reactive")
	})

	it("fires at once when nothing started a wait", () => {
		strictEqual(chooseTurn({ ...base, pending: [q()] }).why, "now")
	})

	it("waits while the clock is running and fires on the deadline", () => {
		const waiting = chooseTurn({
			...base,
			pending: [q()],
			settleSinceSec: 100 - SETTLE_SEC + 1,
			settleBestValue: 50
		})
		strictEqual(waiting.fire, false)
		strictEqual(waiting.why, "waiting")
		const due = chooseTurn({
			...base,
			pending: [q()],
			settleSinceSec: 100 - SETTLE_SEC,
			settleBestValue: 50
		})
		strictEqual(due.fire, true)
		strictEqual(due.why, "settled")
	})

	/*
	 * PREEMPTION — the half that makes 18:03 fire BECAUSE it is bigger rather than because the
	 * deadline happened to land there. `settleBestValue` is frozen at the start of the wait on
	 * purpose: if it tracked the current best it would climb with the very ask trying to pass it.
	 */
	it("a materially bigger ask ends the wait early, and a small one does not", () => {
		const at = (value: number) =>
			chooseTurn({
				...base,
				pending: [q({ value })],
				settleSinceSec: 99,
				settleBestValue: 60
			})
		strictEqual(at(60 * PREEMPT_RATIO).why, "preempt")
		strictEqual(at(60 * PREEMPT_RATIO - 0.01).why, "waiting")
	})

	/*
	 * THE HEARTBEAT YIELDS. The floor under silence asks about nothing in particular by
	 * construction, so spending it seconds before a real window opens is the emptiest turn in the
	 * game followed by the full one arriving too late. Game 5639409343 does this at 10:21, six
	 * seconds before the drake window.
	 */
	it("holds the floor for a window that is about to open, and only for that", () => {
		const beat = (nextOpeningSec: number | null) =>
			chooseTurn({ ...base, pending: [], heartbeat: true, nextOpeningSec })
		strictEqual(beat(null).why, "heartbeat")
		strictEqual(beat(100 + SETTLE_SEC).why, "waiting")
		strictEqual(beat(100 + SETTLE_SEC + 1).why, "heartbeat")
		/*
		 * STRICTLY IN THE FUTURE. The lookahead is cached on the watch and `dueTurn` may be called
		 * on a later clock than the tick that computed it, so an opening already past arrives here
		 * as a negative distance — which a one-sided comparison reads as "seconds away" and which
		 * deferred the floor for the rest of the game until this was caught.
		 */
		strictEqual(beat(99).why, "heartbeat")
	})

	/*
	 * THE STANDING RULE, as a test. Everything in this file decides WHEN TO ASK. A turn it declines
	 * is a question that was not put — never a sentence that was suppressed — so nothing here may
	 * ever drop an ask, and the caller's queue is untouched by it.
	 */
	it("never removes an ask, whatever it decides", () => {
		const pending = [q({ value: 10 }), q({ asks: false, value: 5 })]
		const before = pending.map(e => ({ ...e }))
		chooseTurn({ ...base, pending, settleSinceSec: 99, settleBestValue: 60 })
		deepStrictEqual(pending, before)
	})
})
