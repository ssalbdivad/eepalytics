/**
 * The settle, and the two decisions built on it.
 *
 * Nothing here reads a game. `live-schedule.ts` takes a queue and a clock and answers with a
 * decision, which is the whole reason it exists as a separate file — the facts are read off the
 * feed in `observeTick`, where the tick is.
 *
 * The replay of the two paired games lives in `live-events.test.ts`, next to the detector it
 * exercises. These are the invariants that must hold whatever the corpus says.
 *
 * **The value model that this file used to hold is gone, and so are its tests.** It priced every
 * ask on a prize-times-openness-times-timing scale and it was measured, against 630 blind verdicts
 * over 19 games, at r = 0.099 [0.021, 0.176] with usefulness — all of which was carried by the 19
 * `game.start` asks, the cheapest thing it priced and the only kind that never once graded useful.
 * Drop those and it is r = 0.015 [-0.065, 0.094]. Its only behavioural consumer, `PREEMPT_RATIO`,
 * fired once in 617 minutes of League. See the module docblock for the full numbers.
 */
import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { chooseTurn, SETTLE_SEC, type ScheduledAsk } from "./live-schedule.ts"

/** An ask or a note on the queue, spelled out. */
const q = (o: Partial<ScheduledAsk> = {}): ScheduledAsk => ({
	asks: true,
	reactive: false,
	...o
})

describe("chooseTurn", () => {
	const base = {
		nowSec: 100,
		settleSinceSec: null as number | null,
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
			settleSinceSec: 98
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
			settleSinceSec: 100 - SETTLE_SEC + 1
		})
		strictEqual(waiting.fire, false)
		strictEqual(waiting.why, "waiting")
		const due = chooseTurn({
			...base,
			pending: [q()],
			settleSinceSec: 100 - SETTLE_SEC
		})
		strictEqual(due.fire, true)
		strictEqual(due.why, "settled")
	})

	/*
	 * THE DEADLINE IS THE WHOLE MECHANISM NOW. A bigger ask arriving mid-wait used to end it early
	 * — `PREEMPT_RATIO`, deleted — and the corpus says that path was taken once in 631 turns. What
	 * replaces it is nothing: the ask that arrives joins the queue and goes out with it, at most
	 * `SETTLE_SEC` later than it would have.
	 */
	it("a second ask arriving mid-wait joins the queue rather than jumping it", () => {
		const c = chooseTurn({
			...base,
			pending: [q(), q()],
			settleSinceSec: 99
		})
		strictEqual(c.fire, false)
		strictEqual(c.why, "waiting")
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
		const pending = [q(), q({ asks: false })]
		const before = pending.map(e => ({ ...e }))
		chooseTurn({ ...base, pending, settleSinceSec: 99 })
		deepStrictEqual(pending, before)
	})
})
