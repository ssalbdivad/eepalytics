/**
 * WHEN to ask, when two things are worth asking about and there is only one sentence.
 *
 * `live-events.ts` answers *has a decision just opened or closed?* and it answers it per event.
 * That was enough while the question was volume — 85 timer beats down to 28 event turns — and it
 * stops being enough the moment two decisions are open at once, because the detector's queue is
 * FIRST-COME-FIRST-SERVED and the coach has exactly one mouth.
 *
 * ## The measurement that produced this file
 *
 * Game 5639406342, replayed through the shipped detector, raises three turns inside twelve seconds:
 *
 * ```
 *  17:51  window.changed  rift herald up 171s — he backed
 *  17:57  window.open     drake in 45s (lead)
 *  18:03  window.changed  drake in 39s — another objective fell
 * ```
 *
 * Three questions, one decision, and the sentence was gone before the decision was worth anything.
 * So a standing ask waits a few seconds to see whether something else is about to join it, and the
 * three go out as one turn carrying all three notes.
 *
 * ## THE VALUE MODEL THAT USED TO LIVE HERE, AND WHY IT DOES NOT
 *
 * Until 2026-09-11 this file was 364 lines, and most of them priced an ask: a prize table per
 * epic, multipliers for the counterpart being dead, for two enemies down and for the reachability
 * port's verdict, a timing curve, nine carry weights and a cap. `askValue` turned that into one
 * number, `turnValue` summed a queue into another, and `PREEMPT_RATIO` compared two of them.
 *
 * Two measurements retired the whole apparatus, both over the 19-game corpus in
 * `data/eval/mixfix-corpus-20260911.json` and the blind verdicts beside it.
 *
 * **It did not predict quality.** Every one of the 630 judged lines was rejoined to the `askValue`
 * of the turn that produced it — the detector replayed over the stored samples, turn instants
 * matching the run 631 of 631 — and correlated against the blind judge's verdict:
 *
 * ```
 *   turnValue x useful      r = 0.099  [0.021, 0.176]   n=630
 *   askValue  x useful      r = 0.090  [0.012, 0.167]
 *   within game, pooled     r = 0.111  [0.030, 0.191]
 * ```
 *
 * A hair above zero — and it is not even that, because the whole of it is one kind of turn. The 19
 * `game.start` asks are the cheapest thing the table prices (`NO_OBJECTIVE_PRIZE`, a flat 10) and
 * they graded useful 0 times out of 18. Drop them and the correlation is gone:
 *
 * ```
 *   drop game.start                 r = 0.015  [-0.065, 0.094]   n=611
 *   drop game.start and heartbeat   r = 0.012  [-0.069, 0.093]   n=585
 *   objective-window turns only     r = 0.017  [-0.070, 0.103]   n=516
 * ```
 *
 * What DOES separate a useful line from a useless one is the KIND of the ask, not its price:
 * `objective.taken` 91% [83-95] and `shop.trip` 90% [81-95] against `window.open` 67% [50-80] and
 * `game.start` 0% [0-18]. The prize table orders those almost backwards — `shop.trip` is a carry
 * weight of 3 and a window opening is 55 to 100.
 *
 * **And it changed almost nothing anyway.** Replaying all 19 games three ways — shipped, the same
 * detector with every value forced flat, and no settle at all — over 617 minutes and 631 turns:
 *
 * ```
 *   shipped                631 turns   settled 11   preempted 1   heartbeat yielded 1
 *   values flat            631 turns   settled 12   preempted 0   heartbeat yielded 1
 *   no settle at all       645 turns
 * ```
 *
 * The value model's only behavioural consumer was `PREEMPT_RATIO`, and it fired ONCE in ten hours
 * of League. Forcing every value flat moves two turn instants out of 631: the one preempted turn
 * becomes a settled one, twelve seconds later at the outside. `lastTurnValue` and `TurnReason.value`
 * were written and never read by anything at all.
 *
 * So the settle stayed and the price tag went. What is left is a clock: a standing ask waits
 * `SETTLE_SEC` when another contest window is provably about to open, and nothing else in this
 * repo has an opinion about what an ask is worth.
 *
 * ## What this is not
 *
 * It is not a rate limit and it does not touch the model. It decides when to ask, which is the
 * harness's job; every word of the answer, and whether there is an answer at all, stays the
 * model's. Nothing here can suppress a sentence, because nothing here sees one.
 *
 * Nor is it a cooldown. There is no floor between turns and none is added. The settle acts before
 * the question is asked, on a queue of asks the detector has already raised, and it cannot drop
 * one: a held ask stays in `watch.pending` and goes out with the turn it waited for, carrying its
 * own timestamp, exactly as `dueTurn`'s existing `inFlight` deferral does.
 */

/**
 * The least of the counterpart's death timer worth DETECTING in the open ground.
 *
 * A window he cannot act inside is not a window. Riot's death timers run from about 10 seconds at
 * level 1 to over 50 late, and the reachability arithmetic this repo already ships puts a pit at
 * 20-30 seconds away from an ordinary jungle position — so under ten seconds left there is nothing
 * he could start and finish, and the note would be about a man already walking back.
 *
 * It gated an ASK until the fifth cut; `death.counterpart` no longer asks anything (see its fire
 * site in `live-events.ts` for the 47 turns that took it out), so what this now decides is whether
 * the death is carried as context at all. Left where it is: the threshold is a statement about
 * when the fact stops being actionable, and that is true of a carried note as much as of a
 * question. Raising it was tested against the same corpus and is not the fix — the ask's wrong
 * lines are spread across every bucket of the remaining timer, and the 45s-and-over bucket is its
 * BEST one (15 useful of 27) rather than its worst.
 */
export const FIELD_CP_MIN_SEC = 10

/**
 * How long a standing ask waits to see whether something bigger is coming.
 *
 * The whole cost of this file, and it is paid only by asks whose subject is tens of seconds away.
 * A window opens `OBJECTIVE_LEAD_SEC` (45s) before a spawn, so twelve seconds of settling still
 * leaves the question thirty-three seconds ahead of the thing it is about — and the browser polls
 * the feed every two seconds (`EVENT_TICK_MS`), so the wait is genuinely twelve seconds and not a
 * sampling artefact.
 *
 * REACTIVE asks do not pay it at all. A respawn and the counterpart's death decay in seconds —
 * `live-facts.ts` measured reactive premises 40% stale at ONE second — so they fire on the tick they
 * are detected, which is also what protects the graded-useful 20:53 and 21:05 pair, twelve seconds
 * apart and both reactive.
 *
 * Twelve rather than twenty: over the two paired games, 12s coalesces every cluster the corpus
 * contains (the largest real gap inside one is the 6+6 at 17:51-18:03) without reaching across into
 * the next decision, whose nearest neighbour in the corpus is 24 seconds away.
 *
 * Over the whole 19-game corpus the settle is a small mechanism honestly measured: 11 turns of 631
 * waited it out, and without it the corpus raises 645 turns instead of 631.
 */
export const SETTLE_SEC = 12

/* ------------------------------------------------------------ the decision */

/**
 * The shape `chooseTurn` compares. `LiveEvent` satisfies it structurally, which is how this file
 * stays free of any import from `live-events.ts`.
 */
export interface ScheduledAsk {
	asks: boolean
	reactive: boolean
}

export interface TurnChoice {
	/** Ask now? */
	fire: boolean
	/** One word for the fault panel and the bench: why it fired, or why it is waiting. */
	why: "now" | "reactive" | "settled" | "heartbeat" | "waiting" | "nothing"
}

/**
 * Should the queue go out now?
 *
 * PURE — it reads the queue and answers. The settle clock itself lives on the watch, because only
 * `observeTick` knows when an ask arrived and only `commitTurn` knows when one left; see `dueTurn`,
 * which has never mutated and still does not.
 */
export const chooseTurn = (args: {
	pending: readonly ScheduledAsk[]
	nowSec: number
	/** When the oldest un-sent ask was detected, or null when the queue holds no ask. */
	settleSinceSec: number | null
	/** True when the silence floor is what raised this, with nothing asking. */
	heartbeat: boolean
	/**
	 * When the next contest window is due to OPEN, from `nextOpeningSec` — the schedule's only
	 * honest lookahead. Used here for the heartbeat alone; the settle clock for real asks is started
	 * against the same number in `observeTick`, which is where the objectives are.
	 */
	nextOpeningSec?: number | null
	settleSec?: number
}): TurnChoice => {
	const asks = args.pending.filter(e => e.asks)
	if (asks.length === 0) {
		if (!args.heartbeat) return { fire: false, why: "nothing" }
		/*
		 * THE HEARTBEAT YIELDS, and it is the cheapest yield in the file.
		 *
		 * The floor under silence asks about nothing in particular by construction — that is what it
		 * is for. So a heartbeat that fires seconds before a real contest window opens spends the
		 * coach's sentence on the emptiest question available and then hands her the full one too
		 * late to matter. Game 5639409343 does exactly this at 10:21: the drake window opens at
		 * 10:27.
		 *
		 * Deferring costs nothing that can be lost. The silence condition stays true on the next
		 * tick, so the floor is not skipped, only moved by at most `SETTLE_SEC` onto the question
		 * that was already coming.
		 */
		const opening = args.nextOpeningSec ?? null
		/*
		 * STRICTLY IN THE FUTURE. The lookahead is cached on the watch and the caller may ask on a
		 * clock later than the tick it was computed from, so an opening already in the past arrives
		 * here as a negative distance — which reads as "seconds away" to a one-sided comparison and
		 * defers the floor for the rest of the game. Caught by the quiet-stretch test.
		 */
		if (
			opening !== null &&
			opening > args.nowSec &&
			opening - args.nowSec <= (args.settleSec ?? SETTLE_SEC)
		)
			return { fire: false, why: "waiting" }
		return { fire: true, why: "heartbeat" }
	}
	// A decision that decays in seconds cannot afford to wait for a better one.
	if (asks.some(e => e.reactive)) return { fire: true, why: "reactive" }
	// Nothing is scheduled to arrive, so there is nothing to wait for. The ordinary case.
	if (args.settleSinceSec === null) return { fire: true, why: "now" }
	if (args.nowSec - args.settleSinceSec >= (args.settleSec ?? SETTLE_SEC))
		return { fire: true, why: "settled" }
	return { fire: false, why: "waiting" }
}
