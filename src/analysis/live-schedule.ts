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
 * The third one is the best moment in the corpus. Kayn — the enemy jungler, the man being raced —
 * had just taken Herald at the top side, which both LOCATES him and makes the drake spawning in 39
 * seconds free; the ground-truth block at 18:02 carried every ingredient, complete, correct and one
 * second old. The coach said PASS, because it had already spent a sentence at 17:50 on the same
 * drake and another six seconds before that on a Herald that had been standing for nearly three
 * minutes. Three questions, one decision, and the sentence was gone before the decision was worth
 * anything.
 *
 * The opposite failure is in the same game and is bigger. From 4:21 to 7:17 the detector raises
 * NOTHING — two minutes fifty-six seconds — and the drake spawned at 5:00 and stood untaken until
 * roughly 7:20. `objective.contested` sees it, and `asks` is false on it, so the longest open
 * decision in the first ten minutes of the game was the one stretch the coach was never asked
 * about.
 *
 * Both failures are the same missing idea: **the schedule has no notion of what an ask is WORTH.**
 * So this file supplies one, and `live-events.ts` spends it.
 *
 * ## What this is not
 *
 * It is not a rate limit and it does not touch the model. It decides which question to ask and when
 * to ask it, which is the harness's job; every word of the answer, and whether there is an answer at
 * all, stays the model's. Nothing here can suppress a sentence, because nothing here sees one.
 *
 * Nor is it a cooldown. There is no floor between turns and none is added: the two mechanisms are a
 * SETTLE — a standing ask waits a few seconds in case something bigger is about to join it — and a
 * PREEMPTION, which is that a materially bigger ask ends the wait immediately. Both act before the
 * question is asked, on a queue of asks the detector has already raised, and neither can drop one:
 * a held ask stays in `watch.pending` and goes out with the turn it waited for, carrying its own
 * timestamp, exactly as `dueTurn`'s existing `inFlight` deferral does.
 *
 * ## Why the values live here and the queue lives there
 *
 * Every number below is computed from the feed at the moment the event is detected — in
 * `observeTick`, where the tick is — and travels on the event as `LiveEvent.value`. By the time
 * `dueTurn` compares two asks it is comparing two numbers and nothing else. That split is what
 * keeps this file free of the tick: it has no imports from `live-events.ts` at all (its inputs are
 * structural), so the dependency runs one way and the value model can be tested on numbers.
 */

/* ------------------------------------------------------------ the prize */

/**
 * What each epic is worth if he gets it, on one scale.
 *
 * **These five numbers are a ranking, not a measurement, and saying so is the point.** Nothing in
 * this repo measures what a Herald is worth against a drake, and a table that looked derived would
 * be a judgement wearing a measurement's clothes. What IS measured is the ORDER they produce over
 * the corpus — see the replay numbers in the module docblock of `live-events.ts` and the report in
 * `data/eval/`.
 *
 * The order itself is the uncontroversial part of jungle coaching: Baron rewrites what the whole map
 * is allowed to do; Herald is a free tower; a drake is a stack toward something that ends games; the
 * grubs are a tower's worth of damage and they are gone by 14:00.
 *
 * The GAPS are chosen so that being free promotes a contest exactly one tier and never two: a drake
 * the counterpart cannot contest (55 x 1.6 = 88) outranks a Herald nobody has touched (60), and does
 * not outrank a Baron (100), because a Baron nobody is contesting yet is still the bigger decision.
 * `live-schedule.test.ts` asserts both halves, so a re-price that breaks the ordering fails rather
 * than quietly changing what the coach is asked about.
 */
export const OBJECTIVE_PRIZE: Record<string, number> = {
	baron: 100,
	"rift herald": 60,
	drake: 55,
	voidgrubs: 40
}

/**
 * A drake when either team is on three stacks.
 *
 * The one place the prize table is not flat, and it is flat everywhere else deliberately. A fourth
 * drake is a different object from a first: it either wins the soul or denies it, and every jungler
 * knows the difference, which is precisely why a coach that prices them the same reads as a stat
 * sheet. Equal to Baron, because at the soul point they are the same decision.
 */
export const SOUL_POINT_PRIZE = 100

/** An ask with no objective behind it at all — the blind floor under silence. */
export const NO_OBJECTIVE_PRIZE = 10

/* ------------------------------------------- how open the decision actually is */

/**
 * The counterpart is DEAD, so the thing in the pit is his to take.
 *
 * The biggest single multiplier here, because it is the one fact about a contest that he most often
 * cannot see and the one the post-game reviewer's best objective items all turn on. The graded run's
 * 20:53 line — *"Baron is still free with Kayn dead"* — is this term.
 */
export const OPEN_CP_DEAD = 1.6

/** Two or more of the enemy team are down. See `ENEMIES_DOWN_FREE` in `live-events.ts`. */
export const OPEN_TWO_DOWN = 1.35

/**
 * The reachability port's verdict, priced.
 *
 * `cannot` is a heavy discount rather than a zero, because the port is allowed to be wrong and
 * because "you cannot get there, so do the other thing" is a real line. `can` is a light premium:
 * being able to reach an objective is the ordinary case, not news.
 *
 * Until the minimap reader answers anything but `unknown` both of these are inert — every window
 * prices at 1.0 and the ordering below is unchanged. That is the honest default and it is why the
 * port's own docblock refuses to answer `can` on a guess.
 */
export const REACH_CAN = 1.25
export const REACH_CANNOT = 0.35

/**
 * How live the decision is, as a function of the clock.
 *
 * A thing STANDING in the pit is a decision he has right now; a thing spawning in forty seconds is
 * a decision he is about to have; a thing ninety seconds out is a route, which is worth asking about
 * on the tick he leaves the fountain and not much otherwise. The boundary at 20 seconds is the point
 * at which a jungler has to already be moving.
 */
export const TIMING_IMMINENT_SEC = 20
export const TIMING_LEAD = 0.85
export const TIMING_FAR = 0.6

/* ------------------------------------------------------ what rides along */

/**
 * What a CONTEXT event adds to the turn that carries it.
 *
 * Context does not ask — see `LiveEvent.asks` — but it is the difference between "drake in 39s" and
 * "drake in 39s and the enemy jungler is top side, because he just took Herald". Both of round 2's
 * useful `objective.taken` lines are that join and nothing else, which is why the enemy's take is
 * the largest entry here and an ally's take, which re-prices the map without locating anybody, is a
 * quarter of it.
 */
export const CARRY_ENEMY_TAKE = 40
export const CARRY_ALLY_TAKE = 12
export const CARRY_CP_DEATH = 35
export const CARRY_RESPAWN_SELF = 10
export const CARRY_CP_UNSEEN = 8
export const CARRY_FIGHT = 6
export const CARRY_ITEM = 6
export const CARRY_LEVEL = 5
export const CARRY_SHOP = 3

/**
 * The most context may add, however much of it is queued.
 *
 * A cap rather than a sum, because otherwise a quiet stretch that accumulates five small notes
 * outranks a Baron standing free, and the coach would be asked about the pile rather than about the
 * decision. 50 is below the gap between the drake and Baron rows of `OBJECTIVE_PRIZE`, so context
 * can promote a contest past its neighbour and can never promote it past the tier above.
 */
export const CARRY_MAX = 50

/**
 * How fresh a carried note has to be to count toward the value of a turn.
 *
 * `CONTEXT_CARRY_SEC` (90s) is when a note becomes a false premise and is dropped. This is shorter,
 * because a note stops being a REASON to ask well before it becomes a lie: a kill 80 seconds ago is
 * true, sayable, and not why anybody should be asked anything now.
 */
export const CARRY_FRESH_SEC = 45

/* ------------------------------------------------------------ the value model */

export interface AskFacts {
	/** The plain noun from `ObjectiveState.what`, or null when the ask is not about an objective. */
	what: string | null
	/** Seconds until it spawns; <= 0 or null when it is already standing. */
	untilSpawnSec: number | null
	/** Is it up and untaken right now? */
	standing: boolean
	/** Is the enemy jungler lying down? */
	cpDead: boolean
	/** How many of the enemy team are dead. */
	enemiesDown: number
	/** The reachability port's verdict for this objective. */
	reach: "can" | "cannot" | "unknown"
	/** The largest drake count either team is holding — the soul point. */
	drakeStacks: number
}

/**
 * What this ask can buy him, as one number.
 *
 * `prize x openness x timing`, and the multipliers are taken as a MAXIMUM rather than a product.
 * That is deliberate: the counterpart being dead and two of the enemy being down are usually the
 * same fight, and multiplying them would price one event twice and let a skirmish outrank Baron.
 */
export const askValue = (f: AskFacts): number => {
	const base =
		f.what === null ? NO_OBJECTIVE_PRIZE
		: f.what === "drake" && f.drakeStacks >= 3 ? SOUL_POINT_PRIZE
		: (OBJECTIVE_PRIZE[f.what] ?? NO_OBJECTIVE_PRIZE)
	const open = Math.max(
		1,
		f.cpDead ? OPEN_CP_DEAD : 1,
		f.enemiesDown >= 2 ? OPEN_TWO_DOWN : 1
	)
	const reach = f.reach === "can" ? REACH_CAN : f.reach === "cannot" ? REACH_CANNOT : 1
	const timing =
		f.standing ? 1
		: f.untilSpawnSec === null ? TIMING_FAR
		: f.untilSpawnSec <= TIMING_IMMINENT_SEC ? 1
		: f.untilSpawnSec <= 45 ? TIMING_LEAD
		: TIMING_FAR
	return base * open * reach * timing
}

/* ------------------------------------------------------------ the decision */

/**
 * The shape `chooseTurn` compares. `LiveEvent` satisfies it structurally, which is how this file
 * stays free of any import from `live-events.ts`.
 */
export interface ScheduledAsk {
	asks: boolean
	reactive: boolean
	/** When the detector SAW it — not when the thing it is about became true. */
	seenAtSec: number
	/** `askValue` for an ask; the carry weight for a context note. */
	value: number
}

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
 */
export const SETTLE_SEC = 12

/**
 * How much bigger a late arrival has to be to end the wait early.
 *
 * The preemption half, and the reason the 18:03 turn fires at 18:03 rather than at whatever second
 * the deadline happens to land on. The Herald take promotes the drake ask from 46.8 to 86.8 against
 * the 60 that was on the table when the wait started — a ratio of 1.45 — so at 1.4 the ask goes out
 * BECAUSE it is bigger, which is the property worth having rather than the timing that happens to
 * follow from it.
 *
 * Below about 1.25 ordinary re-prices trip it and the settle stops existing; above about 1.6 only a
 * change of objective tier can, and the join this file was built for does not qualify.
 */
export const PREEMPT_RATIO = 1.4

export interface TurnChoice {
	/** Ask now? */
	fire: boolean
	/** The value of the best ask on the table, plus what its carried context adds. */
	value: number
	/** One word for the fault panel and the bench: why it fired, or why it is waiting. */
	why: "now" | "reactive" | "preempt" | "settled" | "heartbeat" | "waiting" | "nothing"
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
	/** The best turn value on the table at that moment — what the wait is being judged against. */
	settleBestValue: number
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
	const value = turnValue(args.pending, args.nowSec)
	if (asks.length === 0) {
		if (!args.heartbeat) return { fire: false, value, why: "nothing" }
		/*
		 * THE HEARTBEAT YIELDS, and it is the cheapest yield in the file.
		 *
		 * The floor under silence asks about nothing in particular by construction — that is what it
		 * is for. So a heartbeat that fires seconds before a real contest window opens spends the
		 * coach's sentence on the emptiest question available and then hands her the full one too
		 * late to matter. Game 5639409343 does exactly this at 10:21: a heartbeat worth 8, and the
		 * drake window opens at 10:27.
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
			return { fire: false, value, why: "waiting" }
		return { fire: true, value, why: "heartbeat" }
	}
	// A decision that decays in seconds cannot afford to wait for a better one.
	if (asks.some(e => e.reactive)) return { fire: true, value, why: "reactive" }
	// Nothing is scheduled to arrive, so there is nothing to wait for. The ordinary case.
	if (args.settleSinceSec === null) return { fire: true, value, why: "now" }
	if (args.nowSec - args.settleSinceSec >= (args.settleSec ?? SETTLE_SEC))
		return { fire: true, value, why: "settled" }
	if (args.settleBestValue > 0 && value >= args.settleBestValue * PREEMPT_RATIO)
		return { fire: true, value, why: "preempt" }
	return { fire: false, value, why: "waiting" }
}

/**
 * What the whole queue is worth as one turn: the best ask, plus what the fresh context adds.
 *
 * The best ask rather than the sum, because the coach gets one sentence and will spend it on one
 * thing — a second open window does not make the first one more valuable, and summing them is how a
 * quiet stretch full of small notes outranks a Baron standing free.
 */
export const turnValue = (pending: readonly ScheduledAsk[], nowSec: number): number => {
	let best = 0
	let carried = 0
	for (const e of pending) {
		if (e.asks) best = Math.max(best, e.value)
		else if (nowSec - e.seenAtSec <= CARRY_FRESH_SEC) carried += e.value
	}
	return best + Math.min(CARRY_MAX, carried)
}
