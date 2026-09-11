/**
 * REACHABILITY — how far he is from a pit, in seconds, and whether that beats the clock.
 *
 * ## Why this exists
 *
 * Every one of the ten lines graded useful in round 2 of game 5639406342 was the SAME OBJECT: a
 * WINDOW (an objective clock or a death timer), WHERE the contest will be, and WHETHER HE CAN BE
 * THERE — resolved into one action. The first two are already computed: `live-brief.ts`'s NEXT
 * holds the schedule, and `review/read-minimap.ts` holds the position. The third was not computed
 * anywhere, and it is the one no HUD shows him. He can see the drake timer. He can see his own
 * champion. He cannot see that the pit is nineteen seconds away.
 *
 * It is arithmetic and nothing more: a distance in game units, divided by a speed in units per
 * second, compared against a clock. Nothing here decides whether he should go — that is the
 * model's job, and a `verdict` field is the shape that decision would take, which is why there
 * isn't one.
 *
 * ## The three inputs, and where each comes from
 *
 * - POSITION, from the accepted minimap read (`review/read-minimap.ts`), as the same
 *   `{left, top}` percentages the reader returns. `shared/map.ts`'s `fromMinimapPct` converts it,
 *   and that is the ONLY conversion used here — the app has exactly one world<->minimap transform
 *   and a second one would drift from it.
 * - GEOMETRY, from `shared/map.ts`'s `PITS` and `NEXUS`. Those are not estimates: `PITS` is the
 *   mean of `ELITE_MONSTER_KILL.position` over the stored corpus and `NEXUS` is
 *   `BUILDING_KILL.position`, whose spread across 22 games is exactly zero. The unit scale is
 *   therefore the GAME's own unit, straight off the timeline, and the map spans 14,990 of them.
 * - SPEED, from `activePlayer.championStats.moveSpeed`. League's move speed is units per second,
 *   and this was CHECKED rather than assumed — see `MOVE_SPEED_IS_UNITS_PER_SECOND`.
 *
 * ## Three honesties, each of which changes the number
 *
 * 1. A STRAIGHT LINE IS A FLOOR. Walls, terrain and the jungle mean the walked path is longer than
 *    the line. No correction factor is applied and that is a measured decision, not laziness: over
 *    the 39 accepted read-pairs of game 5639406342 that are 10-25s apart, straight-line
 *    displacement divided by (gap x instantaneous move speed) came out p50 0.32, p90 0.74, p95
 *    0.97, max 1.14. The p95 sitting at essentially 1.0 says the floor is ATTAINABLE on the
 *    segments where he actually commits to travelling, so inflating it by a detour factor would
 *    make the number wrong in the direction that matters — it would tell him a pit he can reach is
 *    out of reach. The p50 of 0.32 is not a detour measurement; it is mostly him clearing camps
 *    rather than commuting. So: render the floor, and say it is a floor.
 * 2. THE POSITION HAS AN AGE, and the age is not decoration. Between the read and now he could
 *    have moved `age x speed` units in ANY direction, so the true straight-line distance lies in
 *    `[d - drift, d + drift]`. When `drift >= d` the read no longer bounds the distance AT ALL,
 *    and `constrained` goes false — the answer is then "this payload does not know", which is the
 *    honest output and the one the renderer prints. That is a DERIVED staleness rule rather than a
 *    threshold somebody picked, and it is why a 136-second-old read produces no number.
 * 3. HE MAY BE DEAD. A corpse's reachability does not start from where the corpse is, it starts
 *    from the fountain at `now + respawnTimer`. Death and respawn are read straight off the feed
 *    and are not fog-gated, so that origin is EXACT — `drift` is zero and the read's age does not
 *    enter. This is the one case where reachability is more certain than usual, and it is also the
 *    case a coach most wants: "you respawn in 22s and the pit is 23s from your fountain" settles a
 *    drake call on its own.
 *
 * The move speed is INSTANTANEOUS and carries whatever buff he holds at that instant — measured
 * across this game it swung from 333 (Lillia's base) to 847. So the eta is a floor for a second
 * reason, and the renderer says which speed it used rather than laundering it into "his speed".
 *
 * Pure: no fs, no db, no network, no clock. Everything comes in as arguments.
 */

import { dist, fromMinimapPct, NEXUS, PITS } from "../shared/map.ts"
import type { Pos, TeamId } from "../shared/map.ts"

/**
 * League reports `moveSpeed` in game units per second, so `distance / moveSpeed` is seconds.
 *
 * Not taken on faith. Over the 39 accepted read-pairs of game 5639406342 spaced 10-25s apart,
 * straight-line displacement divided by `gap * moveSpeed` peaked at 1.14 and had a p95 of 0.97.
 * A unit error of any size — per-100ms, per-frame, anything — would have put that ceiling somewhere
 * other than 1. The one segment above 1.0 is what a dash, a Flash or a read error looks like.
 */
export const MOVE_SPEED_IS_UNITS_PER_SECOND = true

/** Below this the reading is the loading screen or a torn payload, not a speed. */
export const MIN_USABLE_MOVE_SPEED = 50

/**
 * The pits, by the label `live-brief.ts`'s NEXT uses for them.
 *
 * Baron, Rift Herald and the Voidgrubs share the north-west pit and drake is alone in the
 * south-east one — the same fact `shared/map.ts` states, restated as a lookup so a caller does not
 * have to know which monster lives where.
 */
export const OBJECTIVE_PITS = {
	Drake: PITS.DRAGON,
	Baron: PITS.BARON,
	"Rift Herald": PITS.HERALD,
	Voidgrubs: PITS.GRUBS
} as const satisfies Record<string, Pos>

export type ObjectiveLabel = keyof typeof OBJECTIVE_PITS

/** One accepted read of his own icon. The percentages `review/read-minimap.ts` returns, unchanged. */
export interface ReachRead {
	pct: { left: number; top: number }
	/** The game clock of the PICTURE, not of the turn that carries it. */
	atSec: number
}

export interface ReachTarget {
	label: string
	pos: Pos
	/** The game clock it is up at. In the past means it is already standing. */
	atSec: number
}

export interface ReachInput {
	/** Game clock of this turn. */
	now: number
	/** The accepted read, or null when there is none — which is a real and common state. */
	read: ReachRead | null
	/** `activePlayer.championStats.moveSpeed`. Instantaneous, buffs included. */
	moveSpeed: number | null
	/** `allPlayers[me].isDead`. */
	dead: boolean
	/** `allPlayers[me].respawnTimer`, seconds. Exact, and not fog-gated. */
	respawnSec: number
	/** His team, so a dead origin is HIS fountain. */
	team: TeamId
	targets: readonly ReachTarget[]
}

export interface Reach {
	label: string
	/** Seconds until it is up. Negative means it is already standing. */
	windowSec: number
	/** Where the walk starts. `null` when nothing in the payload says where he is. */
	origin: "minimap" | "fountain" | null
	/** Age of the read, seconds. `null` for a fountain origin, which has no age. */
	ageSec: number | null
	/** Straight-line units from the origin to the pit. A FLOOR on the walked path. */
	units: number | null
	/** How far in any direction he could have gone since the read: `age * speed`. Zero when dead. */
	driftUnits: number
	/** False when `driftUnits >= units`: the read no longer bounds the distance. */
	constrained: boolean
	/** The speed the arithmetic used, units per second. */
	speed: number | null
	/** Seconds before he can start moving: 0 alive, `respawnSec` dead. */
	delaySec: number
	/** Earliest arrival from now, in seconds: `delay + (units - drift) / speed`. */
	etaMinSec: number | null
	/** Latest arrival the read still allows: `delay + (units + drift) / speed`. Still a floor. */
	etaMaxSec: number | null
	/** `windowSec - etaMaxSec`. Positive on both margins means he beats the spawn either way. */
	marginMinSec: number | null
	/** `windowSec - etaMinSec`. */
	marginMaxSec: number | null
}

/**
 * The whole computation, per target. Returns one `Reach` per target in the order given — including
 * for targets it can say nothing about, because "no number for the drake" is itself the answer and
 * dropping the row would render as silence about the drake instead.
 */
export const buildReach = (input: ReachInput): Reach[] => {
	const speed =
		input.moveSpeed !== null && Number.isFinite(input.moveSpeed) && input.moveSpeed >= MIN_USABLE_MOVE_SPEED ?
			input.moveSpeed
		:	null

	/*
	 * DEATH WINS OVER THE READ, and it makes the answer MORE certain rather than less.
	 *
	 * A dead player's next step is out of his own fountain, at a clock the feed states exactly. So
	 * the origin is a constant, the drift is zero, and the read's age stops mattering — which is why
	 * this branch is taken even when a perfectly fresh read exists. A reachability computed from
	 * where his corpse is lying would be a confident number about a position he is about to leave.
	 */
	const origin: { pos: Pos; kind: "minimap" | "fountain"; ageSec: number | null } | null =
		input.dead ? { pos: NEXUS[input.team], kind: "fountain", ageSec: null }
		: input.read !== null ?
			{
				pos: fromMinimapPct(input.read.pct.left, input.read.pct.top),
				kind: "minimap",
				ageSec: Math.max(0, input.now - input.read.atSec)
			}
		:	null

	const delaySec = input.dead ? Math.max(0, input.respawnSec) : 0
	const driftUnits =
		origin === null || origin.ageSec === null || speed === null ? 0 : origin.ageSec * speed

	return input.targets.map(t => {
		const windowSec = t.atSec - input.now
		if (origin === null || speed === null)
			return {
				label: t.label,
				windowSec,
				origin: origin?.kind ?? null,
				ageSec: origin?.ageSec ?? null,
				units: null,
				driftUnits: 0,
				constrained: false,
				speed,
				delaySec,
				etaMinSec: null,
				etaMaxSec: null,
				marginMinSec: null,
				marginMaxSec: null
			}

		const units = dist(origin.pos, t.pos)
		const constrained = driftUnits < units
		/*
		 * The near edge of the drift circle, floored at zero: if he could already be standing in the
		 * pit, the earliest arrival is `delay`, not a negative number.
		 */
		const nearUnits = Math.max(0, units - driftUnits)
		const etaMinSec = delaySec + nearUnits / speed
		const etaMaxSec = delaySec + (units + driftUnits) / speed
		return {
			label: t.label,
			windowSec,
			origin: origin.kind,
			ageSec: origin.ageSec,
			units,
			driftUnits,
			constrained,
			speed,
			delaySec,
			etaMinSec,
			etaMaxSec,
			marginMinSec: windowSec - etaMaxSec,
			marginMaxSec: windowSec - etaMinSec
		}
	})
}

/**
 * The pit for one of NEXT's four objective labels, or null.
 *
 * Null rather than a throw: NEXT's labels are written for a human and a caller that adds a fifth
 * one should lose the reachability clause on that line, not the turn.
 */
export const pitFor = (label: string): Pos | null =>
	label in OBJECTIVE_PITS ? OBJECTIVE_PITS[label as ObjectiveLabel] : null
