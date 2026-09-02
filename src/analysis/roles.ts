/**
 * Role inference — because the LCU's own labels are garbage.
 *
 * In game 5633857616 FOUR of ten players are labelled `timeline.lane === "JUNGLE"`, one of
 * them with 273 lane CS, and `timeline.role` is `"NONE"` for four of them. Every
 * `*PerMinDeltas` map is empty `{}`. There is no shortcut (`.research/analytics.md` §2).
 *
 * The recipe below produced a well-formed `{TOP,JGL,MID,ADC,SUP}` set for both teams in
 * 22/22 of the user's games:
 *
 *   1. Jungler = the Smite holder (spell id 11). Exactly one per team in 44/44 team-games.
 *      Fallback when that count is not 1: highest `neutralMinionsKilled`.
 *   2. For the other four, take the MEDIAN distance to each lane polyline over laning-phase
 *      frames (2:00-9:30).
 *   3. TOP = argmin(distance to top). Then MID = argmin(distance to mid) among the rest.
 *      TOP first, because the top polyline is the most isolated and least ambiguous.
 *   4. The remaining two are bot lane: ADC = more lane CS, SUP = less.
 *
 * Diagnostics are returned alongside, because the coach must shut up about role-specific
 * things when the inference was shaky: `botCsGap < 40` or fewer than 5 laning frames means
 * ADC/SUP are a coin flip (the one narrow case in the corpus was a 7.5-minute surrender).
 */

import {
	LANING_END_SEC,
	LANING_START_SEC,
	SMITE_SPELL_ID,
	TEAM_BLUE,
	TEAM_RED
} from "../shared/constants.ts"
import { distToLane, type Lane, type TeamId } from "../shared/map.ts"
import type { LcuGame, LcuParticipant, LcuTimeline } from "../shared/schema/lcu.ts"
import type { Confidence, Role } from "../shared/schema/domain.ts"
import { framesBetween, framesOf, median, pfOf } from "./frames.ts"

export interface TeamRoleDiagnostics {
	/** Exactly one Smite holder on this team — the strong case. */
	jungleBySmite: boolean
	/** Median-lane-distance margin between the assigned TOP and the runner-up, in game units. */
	topMargin: number | null
	/** Same for MID. */
	midMargin: number | null
	/** End-of-game lane-CS gap between the assigned ADC and SUP. */
	botCsGap: number | null
	/** Laning-phase frames the inference had to work with. */
	frames: number
}

export interface RoleInference {
	/** participantId -> role. Missing participants are absent, not `UNKNOWN`. */
	roles: Record<number, Role>
	/** participantId -> how much that assignment should be trusted. */
	confidence: Record<number, Confidence>
	diagnostics: Record<TeamId, TeamRoleDiagnostics>
	/** True when both teams produced a complete, distinct {TOP,JGL,MID,ADC,SUP}. */
	wellFormed: boolean
	/** Why the inference is shaky, if it is. Empty when everything is clean. */
	notes: string[]
}

const EMPTY_DIAG: TeamRoleDiagnostics = {
	jungleBySmite: false,
	topMargin: null,
	midMargin: null,
	botCsGap: null,
	frames: 0
}

const hasSmite = (p: LcuParticipant): boolean =>
	p.spell1Id === SMITE_SPELL_ID || p.spell2Id === SMITE_SPELL_ID

/** Lane CS only — junglers score near zero here, which is exactly what separates ADC from SUP. */
const laneCs = (p: LcuParticipant): number => p.stats.totalMinionsKilled

/**
 * Infer everyone's role from positions and Smite.
 *
 * Degrades: with no timeline it falls back to Smite + CS ordering at `medium`/`low`
 * confidence; with a match-history list entry (one participant) it returns just that player.
 */
export const inferRoles = (
	match: LcuGame,
	timeline: LcuTimeline | null | undefined
): RoleInference => {
	const roles: Record<number, Role> = {}
	const confidence: Record<number, Confidence> = {}
	const notes: string[] = []
	const diagnostics: Record<TeamId, TeamRoleDiagnostics> = {
		100: { ...EMPTY_DIAG },
		200: { ...EMPTY_DIAG }
	}

	const frames = framesOf(timeline)
	const laningFrames = framesBetween(
		frames,
		LANING_START_SEC * 1000,
		LANING_END_SEC * 1000
	)
	if (frames.length === 0)
		notes.push(
			"No timeline available: roles inferred from Smite and end-of-game CS only."
		)
	else if (laningFrames.length < 5)
		notes.push(
			`Only ${laningFrames.length} laning-phase frames (need 5+): lane assignments are low confidence.`
		)

	for (const teamId of [TEAM_BLUE, TEAM_RED] as TeamId[]) {
		const team = match.participants.filter(p => p.teamId === teamId)
		if (team.length === 0) continue
		const diag = diagnostics[teamId]
		diag.frames = laningFrames.length

		/* ---- 1. jungler ---- */
		const smiters = team.filter(hasSmite)
		let jungler: LcuParticipant | undefined
		if (smiters.length === 1) {
			jungler = smiters[0]
			diag.jungleBySmite = true
		} else {
			jungler = [...team].sort(
				(a, b) => b.stats.neutralMinionsKilled - a.stats.neutralMinionsKilled
			)[0]
			if (team.length >= 5)
				notes.push(
					`Team ${teamId}: ${smiters.length} Smite holders (expected 1) — jungler picked by camp count.`
				)
		}
		if (jungler) {
			roles[jungler.participantId] = "JGL"
			confidence[jungler.participantId] = diag.jungleBySmite ? "high" : "medium"
		}

		const rest = team.filter(p => p.participantId !== jungler?.participantId)
		if (rest.length === 0) continue

		/* ---- 2. median lane distances ---- */
		const laneDist = new Map<number, Record<Lane, number>>()
		for (const p of rest) {
			const samples: Record<Lane, number[]> = { TOP: [], MID: [], BOT: [] }
			for (const f of laningFrames) {
				const pfr = pfOf(f, p.participantId)
				if (!pfr) continue
				samples.TOP.push(distToLane(pfr.position, "TOP"))
				samples.MID.push(distToLane(pfr.position, "MID"))
				samples.BOT.push(distToLane(pfr.position, "BOT"))
			}
			laneDist.set(p.participantId, {
				TOP: samples.TOP.length ? median(samples.TOP) : Number.POSITIVE_INFINITY,
				MID: samples.MID.length ? median(samples.MID) : Number.POSITIVE_INFINITY,
				BOT: samples.BOT.length ? median(samples.BOT) : Number.POSITIVE_INFINITY
			})
		}

		const positional = laningFrames.length > 0

		/* ---- 3. greedy TOP then MID ---- */
		let pool = [...rest]
		const pickBy = (lane: Lane): LcuParticipant | undefined => {
			if (!positional || pool.length === 0) return undefined
			const ranked = [...pool].sort(
				(a, b) =>
					(laneDist.get(a.participantId)?.[lane] ?? Infinity) -
					(laneDist.get(b.participantId)?.[lane] ?? Infinity)
			)
			return ranked[0]
		}
		const marginFor = (lane: Lane, chosen: LcuParticipant | undefined): number | null => {
			if (!chosen) return null
			const others = pool
				.filter(p => p.participantId !== chosen.participantId)
				.map(p => laneDist.get(p.participantId)?.[lane] ?? Infinity)
			if (others.length === 0) return null
			const best = laneDist.get(chosen.participantId)?.[lane] ?? Infinity
			const runnerUp = Math.min(...others)
			return Number.isFinite(runnerUp - best) ? runnerUp - best : null
		}

		const top = pickBy("TOP")
		diag.topMargin = marginFor("TOP", top)
		if (top) {
			roles[top.participantId] = "TOP"
			pool = pool.filter(p => p.participantId !== top.participantId)
		}
		const mid = pickBy("MID")
		diag.midMargin = marginFor("MID", mid)
		if (mid) {
			roles[mid.participantId] = "MID"
			pool = pool.filter(p => p.participantId !== mid.participantId)
		}

		/* ---- 4. bot lane by lane CS ---- */
		const bot = [...pool].sort((a, b) => laneCs(b) - laneCs(a))
		if (bot.length >= 1) {
			diag.botCsGap =
				bot.length >= 2 ? laneCs(bot[0]!) - laneCs(bot[1]!) : null
			roles[bot[0]!.participantId] = "ADC"
			if (bot[1]) roles[bot[1].participantId] = "SUP"
			for (const p of bot.slice(2)) roles[p.participantId] = "UNKNOWN"
		}

		/* ---- confidence ---- */
		const laneConf: Confidence =
			!positional ? "low"
			: laningFrames.length < 5 ? "low"
			: (diag.topMargin ?? 0) >= 1500 ? "high"
			: "medium"
		if (top) confidence[top.participantId] = laneConf
		if (mid)
			confidence[mid.participantId] =
				laneConf === "high" && (diag.midMargin ?? 0) < 800 ? "medium" : laneConf
		const botConf: Confidence =
			!positional || laningFrames.length < 5 ? "low"
			: (diag.botCsGap ?? 0) < 40 ? "low"
			: "high"
		for (const p of bot.slice(0, 2)) confidence[p.participantId] = botConf
		for (const p of bot.slice(2)) confidence[p.participantId] = "low"

		if (botConf === "low" && team.length >= 5)
			notes.push(
				`Team ${teamId}: ADC/SUP split is unreliable (lane-CS gap ${diag.botCsGap ?? "n/a"}, ${laningFrames.length} frames) — suppress bot-lane-specific coaching.`
			)
	}

	const wellFormed = ([TEAM_BLUE, TEAM_RED] as TeamId[]).every(t => {
		const team = match.participants.filter(p => p.teamId === t)
		if (team.length < 5) return false
		const set = new Set(team.map(p => roles[p.participantId]))
		return (
			set.size === 5 &&
			["TOP", "JGL", "MID", "ADC", "SUP"].every(r => set.has(r as Role))
		)
	})

	return { roles, confidence, diagnostics, wellFormed, notes }
}

/** The user's participantId, matched on puuid. `summonerName` is `""` — never match on it. */
export const findUser = (match: LcuGame, puuid: string): number | null => {
	const hit = match.participantIdentities.find(pi => pi.player?.puuid === puuid)
	return hit ? hit.participantId : null
}

/**
 * The opposing player in the same role. For this user — a jungler in 22/22 games — that is
 * the enemy jungler, which is what "lane opponent" means for every jungle metric in the app.
 */
export const laneOpponent = (
	inference: RoleInference,
	match: LcuGame,
	userId: number
): number | null => {
	const role = inference.roles[userId]
	if (!role || role === "UNKNOWN") return null
	const me = match.participants.find(p => p.participantId === userId)
	if (!me) return null
	const opp = match.participants.find(
		p => p.teamId !== me.teamId && inference.roles[p.participantId] === role
	)
	return opp ? opp.participantId : null
}

/** Everyone on the same team as `participantId` (excluding them). */
export const alliesOf = (match: LcuGame, participantId: number): number[] => {
	const me = match.participants.find(p => p.participantId === participantId)
	if (!me) return []
	return match.participants
		.filter(p => p.teamId === me.teamId && p.participantId !== participantId)
		.map(p => p.participantId)
}

export const enemiesOf = (match: LcuGame, participantId: number): number[] => {
	const me = match.participants.find(p => p.participantId === participantId)
	if (!me) return []
	return match.participants
		.filter(p => p.teamId !== me.teamId)
		.map(p => p.participantId)
}

/** `roleConfidence` for the user, the value that lands in `Game.roleConfidence`. */
export const roleConfidenceOf = (
	inference: RoleInference,
	participantId: number
): Confidence => inference.confidence[participantId] ?? "low"
