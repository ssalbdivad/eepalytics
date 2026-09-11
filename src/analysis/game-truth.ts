/**
 * THE POST-GAME TRUTH — what actually happened, for all ten players, from the ingested timeline.
 *
 * ## Why this module exists
 *
 * Everything the app knew about the enemy during game 5639406342 came from the Live Client Data
 * API, and one of its fields is not the quantity its name claims. `scores.creepScore` for an
 * ENEMY is a **visibility counter**: it counts only the last hits YOUR client witnessed, and it
 * never catches up. Measured on Kayn in that game, against this timeline:
 *
 *     clock   the client said   the truth   his real CS lead   what the coach told him
 *      5:00         0              32             -4                   +28
 *     10:00        20              58            +10                   +48
 *     14:00        30              84             -4                   +50
 *     20:00        50             125             -4                   +71
 *     25:00        60             156             -4                   +92
 *     28:00        70             183            -18                   +95
 *
 * He was level on farm the entire game and was told he was up ninety. Two of the five blinded
 * post-game reviews of that game were graded FALSE on exactly this number, and — this is the part
 * worth remembering — BOTH had hedged correctly while saying it ("a farm lead of at least 81 CS
 * on Kayn by 27:00 (160 to his last-seen 70)"). **Hedging language cannot repair a wrong
 * quantity.** The only fix is a different source, and this module is that source.
 *
 * ## What it is
 *
 * Pure, no I/O, browser-safe, and it decides nothing. It turns `data/blobs/<gameId>/timeline.json.gz`
 * — thirty frames, one per minute, exact for all ten players — into rows a renderer can print and
 * a tally can count. The caller does the loading (`readBlob(gameId, BLOB_TIMELINE)` and the
 * `participant` rows) and hands both in.
 *
 * ## Three traps it is built around
 *
 * FRAMES ARE NOT ON THE MINUTE. The timestamps of game 5639406342 run 0, 60.028, … 1440.501,
 * 1680.57, 1694.384. A row labelled "20:00" that actually holds the 20:00.43 frame is a small lie
 * that becomes a large one the moment somebody joins an event to it, so every `TruthRow` carries
 * the frame's OWN `atSec` and every join states its gap.
 *
 * THE TIMELINE HAS NO ITEMS. Only `CHAMPION_KILL`, `ELITE_MONSTER_KILL` and `BUILDING_KILL` exist
 * in it (verified over 22 games / 1928 events, `src/shared/schema/lcu.ts`), and no participant
 * frame carries a purchase. Item identity therefore stays with the live samples, where his own
 * list is exact and an enemy's is first-SEEN. Nothing here invents one.
 *
 * `ELITE_MONSTER_KILL.assistingParticipantIds` IS CORRUPT — 19% of entries name players on the
 * opposing team (`AGENTS.md`). `truthEvents` reads assists for champion kills only and returns an
 * empty list for objectives, so a caller cannot accidentally credit the wrong team for a drake.
 */

import { half, toMinimapPct, zoneOf, type Half, type Pos, type TeamId } from "../shared/map.ts"
import { dragonPhrase } from "../shared/dragons.ts"
import type { LcuEvent, LcuFrame, LcuTimeline } from "../shared/schema/lcu.ts"
import { fmtClock } from "../shared/time.ts"
import { framesOf, pfOf } from "./frames.ts"

/* ==================================================================== seats */

/**
 * One player, as the `participant` table already knows him.
 *
 * `handle` is the join key nothing else can supply: the live event feed names killers by riot
 * handle (`uglysand`, `FIRE BLAZE 533`) and the timeline names them by `participantId`, so the
 * two channels can only be cross-checked through this row.
 */
export interface TruthSeat {
	participantId: number
	championName: string
	/** `riotId.split("#")[0]` — the ONLY name the live event feed uses. */
	handle: string
	riotId: string
	teamId: number
	side: "his" | "enemy"
	role: string
	isUser: boolean
}

/** Build seats from `participant` rows. `isUser` decides which side is "his"; nothing is guessed. */
export const seatsOf = (
	rows: readonly {
		participantId: number
		teamId: number
		riotId: string
		championName: string
		role: string
		isUser: number | boolean
	}[]
): TruthSeat[] => {
	const user = rows.find(r => r.isUser === 1 || r.isUser === true)
	const hisTeam = user?.teamId ?? rows[0]?.teamId ?? 100
	return rows
		.map(r => ({
			participantId: r.participantId,
			championName: r.championName,
			handle: (r.riotId ?? "").split("#")[0] ?? "",
			riotId: r.riotId ?? "",
			teamId: r.teamId,
			side: (r.teamId === hisTeam ? "his" : "enemy") as "his" | "enemy",
			role: r.role ?? "UNKNOWN",
			isUser: r.isUser === 1 || r.isUser === true
		}))
		.sort((a, b) => a.participantId - b.participantId)
}

export const seatOf = (seats: readonly TruthSeat[], participantId: number): TruthSeat | null =>
	seats.find(s => s.participantId === participantId) ?? null

/* ===================================================================== rows */

export interface TruthRow {
	/** The frame's OWN timestamp in seconds. Never rounded to a minute — frames drift. */
	atSec: number
	clock: string
	level: number
	/** `minionsKilled + jungleMinionsKilled`. What every CS figure in this app means. */
	cs: number
	laneCs: number
	jungleCs: number
	totalGold: number
	/** Gold in hand at the frame boundary. Drops discontinuously at a purchase. */
	goldInHand: number
	xp: number
	pos: Pos
	zone: string
	half: Half
	minimapPct: { left: number; top: number }
}

export interface TruthFrame {
	atSec: number
	clock: string
	seats: Record<number, TruthRow>
}

const round1 = (n: number): number => Math.round(n * 10) / 10

const rowOf = (frame: LcuFrame, seat: TruthSeat, atSec: number): TruthRow | null => {
	const pf = pfOf(frame, seat.participantId)
	if (!pf) return null
	const pos: Pos = { x: pf.position.x, y: pf.position.y }
	return {
		atSec,
		clock: fmtClock(atSec),
		level: pf.level,
		cs: pf.minionsKilled + pf.jungleMinionsKilled,
		laneCs: pf.minionsKilled,
		jungleCs: pf.jungleMinionsKilled,
		totalGold: pf.totalGold,
		goldInHand: pf.currentGold,
		xp: pf.xp,
		pos,
		zone: zoneOf(pos, seat.teamId as TeamId),
		half: half(pos, seat.teamId as TeamId),
		minimapPct: (() => {
			const p = toMinimapPct(pos)
			return { left: round1(p.left), top: round1(p.top) }
		})()
	}
}

/** Every frame, every seat. Exact — this is the post-game record, not a reading of the client. */
export const buildTruth = (
	timeline: LcuTimeline | null | undefined,
	seats: readonly TruthSeat[]
): TruthFrame[] =>
	framesOf(timeline).map(f => {
		const atSec = round1(f.timestamp / 1000)
		const rows: Record<number, TruthRow> = {}
		for (const seat of seats) {
			const row = rowOf(f, seat, atSec)
			if (row) rows[seat.participantId] = row
		}
		return { atSec, clock: fmtClock(atSec), seats: rows }
	})

/**
 * The nearest truth frame to a game clock, with the gap it cost to get there.
 *
 * NOT interpolated, and that is the whole point. A frame 28 seconds from a baron is a fact about
 * a different moment; `interpPosition` would hand back a plausible point with a 1452-unit median
 * error and no way for the caller to tell. Here the caller sees `gapSec` and decides.
 */
export const truthAt = (
	frames: readonly TruthFrame[],
	atSec: number,
	tolSec = 35
): { frame: TruthFrame; gapSec: number } | null => {
	let best: TruthFrame | null = null
	let bestGap = Infinity
	for (const f of frames) {
		const gap = Math.abs(f.atSec - atSec)
		if (gap < bestGap) {
			bestGap = gap
			best = f
		}
	}
	return best === null || bestGap > tolSec ? null : { frame: best, gapSec: round1(bestGap) }
}

/** One seat's row at a clock, or null. Convenience over `truthAt`. */
export const truthRowAt = (
	frames: readonly TruthFrame[],
	participantId: number,
	atSec: number,
	tolSec = 35
): { row: TruthRow; gapSec: number } | null => {
	const hit = truthAt(frames, atSec, tolSec)
	const row = hit?.frame.seats[participantId]
	return hit && row ? { row, gapSec: hit.gapSec } : null
}

/* =================================================================== events */

export interface TruthEvent {
	atSec: number
	clock: string
	kind: "kill" | "objective" | "building"
	/** The raw LCU type, kept so a caller can tell a HORDE from a DRAGON without re-deriving. */
	type: string
	killer: TruthSeat | null
	killerSide: "his" | "enemy" | null
	victim: TruthSeat | null
	/**
	 * CHAMPION_KILL only. Always `[]` for an objective — `assistingParticipantIds` on an
	 * `ELITE_MONSTER_KILL` names an opposing-team player 19% of the time.
	 */
	assists: TruthSeat[]
	monsterType: string | null
	monsterSubType: string | null
	/** "Mountain drake", "Rift Herald", "Baron Nashor", "a voidgrub" — what a human calls it. */
	monsterName: string | null
	buildingType: string | null
	towerType: string | null
	laneType: string | null
	/**
	 * `BUILDING_KILL.teamId` is the team that LOST the building, not the one that took it. Named
	 * for what it means so nobody has to remember that twice.
	 */
	belongedTo: "his" | "enemy" | null
	pos: Pos | null
	/** Zoned from HIS point of view, so "enemy red-side jungle" reads the way he would say it. */
	zone: string | null
	half: Half | null
}

/** "EARTH_DRAGON" -> "Mountain drake". The timeline spells drakes differently from the feed. */
const monsterNameOf = (type: string | undefined, subType: string | undefined): string | null => {
	if (type === "DRAGON") return dragonPhrase((subType ?? "").replace(/_DRAGON$/, ""))
	if (type === "RIFTHERALD") return "Rift Herald"
	if (type === "BARON_NASHOR") return "Baron Nashor"
	if (type === "HORDE") return "a voidgrub"
	return type ?? null
}

const kindOf = (type: string): TruthEvent["kind"] =>
	type === "CHAMPION_KILL" ? "kill"
	: type === "BUILDING_KILL" ? "building"
	: "objective"

export const truthEvents = (
	timeline: LcuTimeline | null | undefined,
	seats: readonly TruthSeat[]
): TruthEvent[] => {
	const user = seats.find(s => s.isUser)
	const hisTeam = user?.teamId ?? 100
	const flat: LcuEvent[] = []
	for (const f of framesOf(timeline)) if (f.events) flat.push(...f.events)
	flat.sort((a, b) => a.timestamp - b.timestamp)
	return flat.map(e => {
		const atSec = round1(e.timestamp / 1000)
		const killer = e.killerId === undefined ? null : seatOf(seats, e.killerId)
		const kind = kindOf(e.type)
		const pos = e.position ? { x: e.position.x, y: e.position.y } : null
		return {
			atSec,
			clock: fmtClock(atSec),
			kind,
			type: e.type,
			killer,
			killerSide: killer?.side ?? null,
			victim: e.victimId === undefined ? null : seatOf(seats, e.victimId),
			assists:
				kind === "kill" ?
					(e.assistingParticipantIds ?? [])
						.map(id => seatOf(seats, id))
						.filter((s): s is TruthSeat => s !== null)
				:	[],
			monsterType: e.monsterType ?? null,
			monsterSubType: e.monsterSubType ?? null,
			monsterName: kind === "objective" ? monsterNameOf(e.monsterType, e.monsterSubType) : null,
			buildingType: e.buildingType ?? null,
			towerType: e.towerType ?? null,
			laneType: e.laneType ?? null,
			belongedTo:
				kind !== "building" || e.teamId === undefined ? null
				: e.teamId === hisTeam ? "his"
				: "enemy",
			pos,
			zone: pos === null ? null : zoneOf(pos, hisTeam as TeamId),
			half: pos === null ? null : half(pos, hisTeam as TeamId)
		}
	})
}

/* =============================================================== checkpoints */

export interface Checkpoint {
	/** The minute mark asked for. */
	askedAtSec: number
	askedClock: string
	/** The frame that answered, and how far it was from the mark. */
	atSec: number
	clock: string
	gapSec: number
	rows: Record<number, TruthRow>
}

/**
 * The frames nearest a set of minute marks — the shape a "CS at 10 / 14 / 20" table wants.
 *
 * Marks past the last frame are DROPPED, never answered with the last frame: a 10-minute remake
 * would otherwise proudly report a CS@20 (`src/analysis/frames.ts` learned this the hard way).
 */
export const checkpoints = (
	frames: readonly TruthFrame[],
	markSec: readonly number[],
	tolSec = 35
): Checkpoint[] => {
	const out: Checkpoint[] = []
	const lastAt = frames[frames.length - 1]?.atSec ?? 0
	for (const mark of markSec) {
		if (mark > lastAt + tolSec) continue
		const hit = truthAt(frames, mark, tolSec)
		if (!hit) continue
		out.push({
			askedAtSec: mark,
			askedClock: fmtClock(mark),
			atSec: hit.frame.atSec,
			clock: hit.frame.clock,
			gapSec: hit.gapSec,
			rows: hit.frame.seats
		})
	}
	return out
}
