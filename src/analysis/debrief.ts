/**
 * THE SPINE — one game as a shape, computed from the post-game timeline.
 *
 * ## Why this is a module and not a query
 *
 * The debrief screen's second band draws the whole game as one object: gold against the enemy
 * jungler per minute, a diamond per neutral objective, a bar per death whose WIDTH is the time
 * he actually spent watching a grey screen. Every one of those marks has to be a fact, and the
 * only place all of them exist together is `data/blobs/<gameId>/timeline.json.gz`.
 *
 * `game-truth.ts` already turns that blob into exact per-frame rows for all ten players and
 * into events with the two upstream corruptions fenced off (`assistingParticipantIds` on an
 * objective is never read; `killerId` is). This module is the thin layer above it that answers
 * the four questions the picture asks, and NOTHING else — it ranks nothing and judges nothing,
 * because the ranking already happened in `metrics` and the judging is the review's job.
 *
 * ## The counterpart is the timeline's, never the live feed's
 *
 * `scores.creepScore` for an enemy in the Live Client Data API is a visibility counter: it read
 * 70 against a true 183 in game 5639406342 and every comparison built on it was sign-flipped.
 * Everything here comes from the timeline, where all ten players are exact at every frame. A CS
 * comparison on this screen is therefore the one place in the app that number can be trusted.
 *
 * ## The one estimate, and it is labelled everywhere it appears
 *
 * Time spent dead is NOT in the data. A one-minute frame cannot measure a 20-50s timer, so the
 * bar widths come from `BRW_BY_LEVEL x timeIncreaseFactor` in `deaths.ts`, which is a community
 * reference table, not a measurement. It travels with `downtimeSource` so no consumer can print
 * it as if the client had said it, and the UI renders it with "est." attached.
 */

import { BRW_BY_LEVEL, timeIncreaseFactor } from "./deaths.ts"
import {
	buildTruth,
	seatsOf,
	truthEvents,
	type TruthFrame,
	type TruthRow,
	type TruthSeat
} from "./game-truth.ts"
import { toMinimapPct, type Pos } from "../shared/map.ts"
import type { LcuTimeline } from "../shared/schema/lcu.ts"
import type { ParticipantSummary } from "../shared/schema/domain.ts"
import type { SpineResponse } from "../shared/schema/api.ts"

const round1 = (n: number): number => Math.round(n * 10) / 10

/**
 * The enemy in his seat: the enemy jungler, by this app's OWN role inference.
 *
 * `participants[].timeline.role` from the LCU is wrong 4 times in 10 (AGENTS.md), so the role
 * on the row is the one this app inferred from Smite and frame positions. When no enemy carries
 * `JGL` there is no counterpart and the screen says so rather than picking someone plausible.
 */
export const counterpartOf = (
	participants: readonly ParticipantSummary[]
): ParticipantSummary | null => {
	const user = participants.find(p => p.isUser)
	if (!user) return null
	return participants.find(p => p.teamId !== user.teamId && p.role === user.role) ?? null
}

/** Seconds he was dead, from an UNVERIFIED respawn table. Never presented as a measurement. */
export const estimatedDowntime = (level: number, atSec: number): number => {
	const brw = BRW_BY_LEVEL[Math.max(1, Math.min(18, Math.round(level))) - 1] ?? 30
	return Math.round(brw * (1 + timeIncreaseFactor(atSec)))
}

export const DOWNTIME_SOURCE =
	"estimated from level and game clock (BRW_TABLE_ESTIMATE) — the timeline has no respawn field"

export interface SpineInput {
	timeline: LcuTimeline | null | undefined
	participants: readonly ParticipantSummary[]
	gameDurationSec: number
}

/**
 * Everything the spine draws, in one pass over the timeline.
 *
 * Answers with `available: false` and a sentence rather than throwing: a game whose blob was
 * pruned is an ordinary state on this screen, and the band above it still renders.
 */
export const buildSpine = (input: SpineInput): SpineResponse => {
	const user = input.participants.find(p => p.isUser) ?? null
	const counterpart = counterpartOf(input.participants)

	const unavailable = (reason: string): SpineResponse => ({
		available: false,
		reason,
		counterpart: null,
		minutes: [],
		objectives: [],
		deaths: [],
		takedowns: [],
		downtimeSource: DOWNTIME_SOURCE
	})

	// Both reasons are written for a person to read. A remake has no scoreboard at all, which is
	// a different thing from a pruned blob, and a screen that says "no participant rows" has
	// told him about the database rather than about his game.
	if (user === null)
		return unavailable("There is no scoreboard stored for this game — short games and remakes end without one.")
	if (!input.timeline?.frames?.length)
		return unavailable("There is no timeline for this game, so its shape can't be drawn.")

	const seats: TruthSeat[] = seatsOf(
		input.participants.map(p => ({
			participantId: p.participantId,
			teamId: p.teamId,
			riotId: p.riotId,
			championName: p.championName,
			role: p.role,
			isUser: p.isUser
		}))
	)
	const frames = buildTruth(input.timeline, seats)
	const events = truthEvents(input.timeline, seats)

	const minutes: SpineResponse["minutes"] = frames.flatMap(f => {
		const me = f.seats[user.participantId]
		if (!me) return []
		const them = counterpart === null ? null : (f.seats[counterpart.participantId] ?? null)
		return [
			{
				atSec: f.atSec,
				clock: f.clock,
				goldDiff: them === null ? 0 : me.totalGold - them.totalGold,
				goldMe: me.totalGold,
				csMe: me.cs,
				csThem: them?.cs ?? 0,
				levelMe: me.level,
				levelThem: them?.level ?? 0,
				minimapPct: me.minimapPct
			}
		]
	})

	const objectives: SpineResponse["objectives"] = events
		.filter(e => e.kind === "objective")
		.map(e => ({
			atSec: e.atSec,
			clock: e.clock,
			name: e.monsterName ?? "an objective",
			// `killerId` is the reliable half of an ELITE_MONSTER_KILL; the assist list is not
			// read at all, here or in game-truth.
			side: e.killerSide ?? "enemy",
			takenBy: e.killer?.championName ?? "",
			zone: e.zone,
			minimapPct: e.pos === null ? null : pctOf(e.pos)
		}))

	const deaths: SpineResponse["deaths"] = events
		.filter(e => e.kind === "kill" && e.victim?.participantId === user.participantId)
		.map(e => {
			/*
			 * The frame AT OR BEFORE the death, not the nearest one. Level only ever goes up, so
			 * the preceding frame is the honest lower bound on what he was when he died; the
			 * nearest frame can be the one after it, which would credit him a level he did not
			 * have and lengthen the estimated timer. With one-minute frames this is never more
			 * than a minute stale.
			 */
			const row = lastRowAtOrBefore(frames, user.participantId, e.atSec)
			const level = row?.level ?? 1
			return {
				atSec: e.atSec,
				clock: e.clock,
				killer: e.killer?.championName ?? "",
				zone: e.zone ?? "",
				level,
				downtimeSec: estimatedDowntime(level, e.atSec),
				goldHeld: row?.goldInHand ?? null,
				minimapPct: e.pos === null ? null : pctOf(e.pos)
			}
		})

	const takedowns: SpineResponse["takedowns"] = events
		.filter(
			e =>
				e.kind === "kill" &&
				(e.killer?.participantId === user.participantId ||
					e.assists.some(a => a.participantId === user.participantId))
		)
		.map(e => ({
			atSec: e.atSec,
			clock: e.clock,
			kind: e.killer?.participantId === user.participantId ? "kill" : "assist",
			victim: e.victim?.championName ?? ""
		}))

	return {
		available: true,
		counterpart:
			counterpart === null ?
				null
			:	{
					championName: counterpart.championName,
					riotId: counterpart.riotId,
					cs: counterpart.cs + counterpart.jungleCs,
					gold: counterpart.gold,
					level: counterpart.champLevel,
					kda: `${counterpart.kills}/${counterpart.deaths}/${counterpart.assists}`
				},
		minutes,
		objectives,
		deaths,
		takedowns,
		durationSec: round1(
			input.gameDurationSec > 0 ? input.gameDurationSec : (minutes.at(-1)?.atSec ?? 0)
		),
		downtimeSource: DOWNTIME_SOURCE
	}
}

/** The last frame at or before a second, for a quantity that only moves one way. */
const lastRowAtOrBefore = (
	frames: readonly TruthFrame[],
	participantId: number,
	atSec: number
): TruthRow | null => {
	let out: TruthRow | null = null
	for (const f of frames) {
		if (f.atSec > atSec) break
		out = f.seats[participantId] ?? out
	}
	return out ?? frames[0]?.seats[participantId] ?? null
}

/**
 * Map units -> percentages of the minimap box, through the ONE conversion in `shared/map.ts`.
 * Re-deriving the y-flip locally is how a heatmap ends up mirrored; this only rounds.
 */
const pctOf = (p: Pos): { left: number; top: number } => {
	const { left, top } = toMinimapPct(p)
	return { left: round1(left), top: round1(top) }
}
