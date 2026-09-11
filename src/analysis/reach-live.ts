/**
 * REACH-LIVE — the wire between the live feed and `reachability.ts`.
 *
 * `reachability.ts` is pure arithmetic over three arguments and deliberately knows nothing about
 * the League client. This file is the adapter, and it exists as its own module for the same reason
 * the arithmetic does not import the schema: a change to the client's JSON must not be able to
 * reach the map math.
 *
 * ## Why it was written
 *
 * Because the arithmetic shipped with NO CALLER. `buildReach` was imported by exactly one file —
 * its own test — and `BriefInput.reach` was optional, so every payload of every game rendered the
 * objective lines with no travel time on them and nothing anywhere reported a problem. The
 * renderer was tested, the math was tested, and the coach never once saw either. A dead wire of
 * this shape is invisible precisely because both ends are healthy.
 *
 * ## What it does, and the two joins that make it honest
 *
 * 1. **The targets are the ones NEXT will actually render.** `objectiveStates` is the same source
 *    the event detector uses for windows, so a drake this file computes a distance to and a drake
 *    the brief prints a clock for are the same instance. The label is mapped to `live-brief.ts`'s
 *    own spelling ("Drake", "Voidgrubs", "Rift Herald", "Baron") because the renderer joins BY
 *    LABEL — an unmatched row silently loses its clause, which is the failure mode that looks like
 *    "the feature does nothing".
 * 2. **The position is the ACCEPTED read's own percentages, at the PICTURE's clock.** Not the
 *    zone, and not the turn's clock. A zone is a 13-way label and the pit distance wants a point;
 *    the turn's clock would report every read as fresh, which is the one input `reachability.ts`
 *    uses to decide whether it may quote a number at all.
 *
 * Returns an empty array when there is no game, which renders as no clauses rather than as a hedge.
 */

import { buildReach, pitFor } from "./reachability.ts"
import type { Reach, ReachTarget } from "./reachability.ts"
import { objectiveStates, projectTick } from "./live-events.ts"
import { teamIdOfLiveTeam } from "../shared/schema/live.ts"
import type { LiveAllGameData } from "../shared/schema/live.ts"
import type { TeamId } from "../shared/map.ts"

/**
 * `objectiveStates`'s plain noun -> the label NEXT puts at the head of the line.
 *
 * A lookup rather than a title-case helper: "rift herald" -> "Rift Herald" happens to work and
 * "voidgrubs" -> "Voidgrubs" happens to work, but the join is load-bearing and a casing rule that
 * silently produces "Baron Nashor" one patch later would delete the clause on the objective that
 * decides the most games.
 */
const NEXT_LABEL: Record<string, string> = {
	drake: "Drake",
	voidgrubs: "Voidgrubs",
	"rift herald": "Rift Herald",
	baron: "Baron"
}

/** The accepted read, as this file needs it: the reader's own percentages and the PICTURE's clock. */
export interface ReachPosition {
	pct: { left: number; top: number }
	atSec: number
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/**
 * Every objective NEXT can render, with how long the walk to it is.
 *
 * `read` is null on the common turn and that is a real answer, not a missing input: a dead player's
 * origin is his own fountain and the arithmetic is then EXACT, so a turn with no position still
 * produces the most decidable line this section has.
 */
export const reachFromLive = (input: {
	raw: LiveAllGameData
	nowSec: number
	read: ReachPosition | null
}): Reach[] => {
	const tick = projectTick(input.raw)
	if (tick === null) return []
	const targets: ReachTarget[] = []
	for (const o of objectiveStates(tick)) {
		const label = NEXT_LABEL[o.what]
		if (label === undefined) continue
		const pos = pitFor(label)
		if (pos === null) continue
		targets.push({ label, pos, atSec: o.spawnSec })
	}
	if (targets.length === 0) return []
	const stats = (input.raw.activePlayer as { championStats?: Record<string, unknown> } | undefined)?.championStats
	const team: TeamId = teamIdOfLiveTeam(tick.me.team)
	return buildReach({
		now: input.nowSec,
		read: input.read,
		moveSpeed: num(stats?.moveSpeed),
		dead: tick.me.dead,
		respawnSec: tick.me.respawn,
		team,
		targets
	})
}
