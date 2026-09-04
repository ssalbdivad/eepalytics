/**
 * Teachable-moment selection — the handoff to the capture pipeline.
 *
 * A moment is worth a screenshot when it COST something, is FIXABLE, and REPEATS. That is
 * literally the score (`.research/analytics.md` §8.2):
 *
 *     score = costGold * fixability * (1 + 0.35 * ln(max(recurrenceCount, 1)))
 *
 * `recurrenceCount` is counted over the WHOLE CORPUS, not this one game — a mistake you make
 * every night is worth a clip, the same mistake made once is a footnote.
 *
 * Two rules the research prototype got wrong and this must not:
 *  - **Exclude the game-ending sequence.** The prototype's top pick for game 5633857616 was a
 *    38:23 death in the enemy base during the losing team's last defence. Dying while the
 *    nexus falls is not a lesson.
 *  - **De-duplicate in time.** Without a 25-second guard one lost teamfight yields five
 *    near-identical clips.
 *
 * And one product rule: the coach is *encouraging*. Positive moments (a stolen baron, a clean
 * solo kill on the enemy jungler) compete on their own scale and at least one is guaranteed a
 * slot when one exists, so a review is never a pure list of failures.
 *
 * Every emitted `Moment` carries `tSec` and `cameraTarget` — that pair IS the capture contract.
 * Use `captureWindow()` for the lead-in/lead-out the replay seeker should use.
 */

import { dist, zoneOf, type Pos, type TeamId } from "../shared/map.ts"
import { fmtClock } from "../shared/time.ts"
import type { LcuEvent, LcuGame, LcuTimeline } from "../shared/schema/lcu.ts"
import {
	makeMomentId,
	type Metric,
	type Moment,
	type MomentKind
} from "../shared/schema/domain.ts"
import { allEvents, clamp, framesOf, interpPosition, round, teamGoldAt } from "./frames.ts"
import { alliesOf, enemiesOf, laneOpponent, type RoleInference } from "./roles.ts"
import { PRESENCE_RADIUS, type DeathAnalysis } from "./deaths.ts"

/* ================================================================ tuning */

/** Lead-in / lead-out per moment family. A death needs its APPROACH, not the death itself. */
export const CAPTURE_WINDOWS = {
	death: { leadIn: 12, leadOut: 8 },
	kill: { leadIn: 12, leadOut: 8 },
	objective: { leadIn: 20, leadOut: 10 },
	objective_missed: { leadIn: 20, leadOut: 10 },
	teamfight: { leadIn: 15, leadOut: 12 },
	default: { leadIn: 15, leadOut: 10 }
} as const

/**
 * Objective values, in gold. These are FIXED PROXIES, not measurements — the timeline has no
 * objective-gold field. Every moment built on them says so in its `evidence` line, and the
 * measured 90-second team-gold swing is reported next to the proxy wherever frames allow.
 */
export const OBJECTIVE_VALUE: Record<string, number> = {
	BARON_NASHOR: 1500,
	ELDER_DRAGON: 1500,
	DRAGON: 500,
	RIFTHERALD: 600,
	HORDE: 200
}

/** Nothing scored below this gets a slot, however empty the list would otherwise be. */
export const MIN_MOMENT_SCORE = 60

export interface SelectMomentsOptions {
	/** Target 5-8 per game. */
	topN?: number
	/** Reject a moment within this many seconds of an already-selected one. */
	dedupeSec?: number
	/** Corpus-wide `ZONE|PHASE|ISOLATION` counts from `deaths.signatureCounts`. */
	recurrence?: Map<string, number>
	/** Guarantee this many positive moments when any exist. */
	minPositives?: number
	/** Cap on positives in the primary pass. The fill pass may exceed it on a clean game. */
	maxPositives?: number
	/** Drop deaths in the last N seconds of the game — the losing defence is not teachable. */
	endgameGuardSec?: number
}

/* ================================================================= types */

/** The ranking inputs, exported so a bad pick can always be argued with. */
export interface MomentDetail {
	moment: Moment
	kind: MomentKind
	positive: boolean
	costGold: number
	fixability: number
	recurrenceCount: number
	score: number
	signature: string
	zoneLabel: string
	/** Measured team gold-lead swing over the 90 s after the moment, when frames allow. */
	measuredSwing90s: number | null
	why: string
}

export interface CaptureWindow {
	gameId: number
	startSec: number
	endSec: number
	/** The frame worth screenshotting. Same clock as `gameDuration` and the live API. */
	focusSec: number
	camera:
		| { mode: "FOLLOW_PARTICIPANT"; participantId: number }
		| { mode: "FIXED_WORLD_POSITION"; x: number; y: number }
	wantMinimap: boolean
}

/* =============================================================== helpers */

const teamOfPid = (pid: number): TeamId => (pid <= 5 ? 100 : 200)

const eliteName = (e: LcuEvent): string => {
	const sub = e.monsterSubType ?? ""
	const base = e.monsterType ?? "elite monster"
	return (sub || base).toLowerCase().replace(/_/g, " ")
}

const eliteValue = (e: LcuEvent): number =>
	OBJECTIVE_VALUE[e.monsterSubType || ""] ??
	OBJECTIVE_VALUE[e.monsterType || ""] ??
	400

/**
 * Fixability multiplier, §8.2. A solo death is a choice; a 5v1 collapse is not; a level-1
 * invade is a team decision the jungler mostly does not own.
 */
export const fixabilityOf = (d: DeathAnalysis): number => {
	let f = 1
	if (d.isolation.verdict === "SOLO") f *= 1.6
	f *= d.enemiesCredited <= 2 ? 1.4 : 0.8
	if (d.half === "enemy" && d.economy === "BEHIND") f *= 1.3
	if (d.tSec < 90) f *= 0.6
	return f
}

const recurrenceBoost = (count: number): number =>
	1 + 0.35 * Math.log(Math.max(count, 1))

/** Saturating map from a gold-scale score to the 0..1 severity the schema wants. */
export const severityOf = (score: number): number =>
	round(clamp(1 - Math.exp(-Math.max(score, 0) / 1500), 0.02, 1), 3)

/* ============================================================ candidates */

/**
 * Rank every teachable moment in one game, with the scoring inputs attached.
 *
 * @param userId the user's participantId
 * @param metrics the game's metrics — cited by id from feedback, and used to colour the copy
 * @param deaths the output of `analyzeDeaths` for THIS game
 */
export const selectMomentsDetailed = (
	match: LcuGame,
	timeline: LcuTimeline | null | undefined,
	roles: RoleInference,
	userId: number,
	metrics: Metric[],
	deaths: DeathAnalysis[],
	options: SelectMomentsOptions = {}
): MomentDetail[] => {
	const topN = options.topN ?? 8
	const dedupeSec = options.dedupeSec ?? 25
	const recurrence = options.recurrence ?? new Map<string, number>()
	const minPositives = options.minPositives ?? 1
	const maxPositives = options.maxPositives ?? 2
	const endgameGuard = options.endgameGuardSec ?? 30

	const meP = match.participants.find(p => p.participantId === userId)
	if (!meP) return []
	const teamId = meP.teamId as TeamId
	const frames = framesOf(timeline)
	const events = allEvents(timeline)
	const allies = alliesOf(match, userId)
	const enemies = enemiesOf(match, userId)
	const oppId = laneOpponent(roles, match, userId)
	const durSec = match.gameDuration
	const gameId = match.gameId

	const swingAt = (tMs: number): number | null => {
		const a = teamGoldAt(frames, [userId, ...allies], tMs)
		const b = teamGoldAt(frames, [userId, ...allies], tMs + 90_000)
		const ea = teamGoldAt(frames, enemies, tMs)
		const eb = teamGoldAt(frames, enemies, tMs + 90_000)
		return a !== null && b !== null && ea !== null && eb !== null ?
				round(b - a - (eb - ea))
			:	null
	}

	/** Last inhibitor of the ENEMY team to fall — after that, a base death is the win, not a lesson. */
	let lastEnemyInhibMs: number | null = null
	for (const e of events)
		if (e.type === "BUILDING_KILL" && e.buildingType === "INHIBITOR_BUILDING" && e.teamId !== teamId)
			lastEnemyInhibMs = Math.max(lastEnemyInhibMs ?? 0, e.timestamp)

	const out: MomentDetail[] = []

	/* ------------------------------------------------------------- deaths */

	for (const d of deaths) {
		if (durSec > 0 && d.tSec > durSec - endgameGuard) continue
		if (d.zone === "ENEMY_BASE" && lastEnemyInhibMs !== null && d.tSec * 1000 >= lastEnemyInhibMs)
			continue

		const fix = fixabilityOf(d)
		const recur = recurrence.get(d.signature) ?? 1
		const score = d.cost.totalGold * fix * recurrenceBoost(recur)
		const swing = d.cost.measuredTeamGoldSwing90s
		const conceded = d.objectiveContext.objectiveConcededWithin45s

		const title =
			d.isolation.verdict === "SOLO" ?
				`Likely caught alone in the ${d.zoneLabel}`
			: d.outnumbering === "OUTNUMBERED" ?
				`Collapsed on by ${d.enemiesCredited} in the ${d.zoneLabel}`
			: d.outnumbering === "1v1" ?
				`Lost a 1v1 in the ${d.zoneLabel}`
			:	`Died in the ${d.zoneLabel}`

		out.push({
			moment: {
				id: makeMomentId(gameId, "death", d.tSec),
				gameId,
				tSec: d.tSec,
				kind: "death",
				title,
				severity: severityOf(score),
				mapX: d.position.x,
				mapY: d.position.y,
				cameraTarget: null,
				participantsInvolved: [
					userId,
					...(d.killerId > 0 ? [d.killerId] : []),
					...d.assistIds
				],
				costGold: d.cost.totalGold,
				confidence: d.isolation.confidence,
				evidence: `CHAMPION_KILL at ${d.clock} (victimId ${userId}, killerId ${d.killerId}, ${d.assistIds.length} assists) at exactly (${Math.round(d.position.x)}, ${Math.round(d.position.y)}). costGold is a MODEL (300g + 150g/assist handed over, plus ${d.cost.estimatedDowntimeSec}s of forgone income from an UNVERIFIED respawn table${d.cost.objectivePenalty > 0 ? `, plus ${d.cost.objectivePenalty}g for conceded objectives` : ""}); the measured team gold-lead swing over the next 90s was ${swing === null ? "unavailable" : `${swing}g`}.`
			},
			kind: "death",
			positive: false,
			costGold: d.cost.totalGold,
			fixability: round(fix, 3),
			recurrenceCount: recur,
			score: round(score),
			signature: d.signature,
			zoneLabel: d.zoneLabel,
			measuredSwing90s: swing,
			why: `${d.summary}${
				recur > 1 ?
					` This exact signature (${d.zone.toLowerCase().replace(/_/g, " ")}, ${d.phase.toLowerCase()} game, ${d.isolation.verdict.toLowerCase().replace(/_/g, " ")}) has now happened ${recur} times across the reviewed games.`
				:	""
			}${conceded.length > 0 ? "" : ""}`
		})
	}

	/* ------------------------------------------------- objectives conceded */

	/*
	 * When was the user dead?
	 *
	 * An objective conceded while he was on the respawn timer is not a missed objective — it is
	 * something he could not have contested under any circumstances, and calling it "while you
	 * were elsewhere" is simply false. A real review said exactly that about a baron taken 20
	 * seconds after he died.
	 *
	 * The window is deliberately GENEROUS. Respawn time scales with level and game time and can
	 * exceed a minute late on, and this app cannot see the exact timer. Over-suppressing costs a
	 * few real observations; under-suppressing produces confident accusations about moments the
	 * player was physically unable to affect, which is far worse.
	 */
	const deathTimes = events
		.filter(e => e.type === "CHAMPION_KILL" && (e.victimId ?? 0) === userId)
		.map(e => e.timestamp)
		.sort((a, b) => a - b)
	const DEAD_WINDOW_MS = 75_000
	const wasDead = (tMs: number): boolean =>
		deathTimes.some(d => tMs >= d && tMs - d <= DEAD_WINDOW_MS)

	for (const e of events) {
		if (e.type !== "ELITE_MONSTER_KILL") continue
		const killer = e.killerId ?? 0
		if (killer === 0 || teamOfPid(killer) === teamId) continue
		const tMs = e.timestamp
		const tSec = round(tMs / 1000, 1)
		if (durSec > 0 && tSec > durSec - endgameGuard) continue
		// Could not possibly have been there. Not a coaching moment.
		if (wasDead(tMs)) continue
		const objPos: Pos =
			e.position ? { x: e.position.x, y: e.position.y } : { x: 0, y: 0 }
		const mePos = interpPosition(frames, userId, tMs)
		const away = mePos ? dist(mePos, objPos) : null
		// Present (within the ~65%-sensitive presence radius) means it was contested, not missed.
		if (away !== null && away <= PRESENCE_RADIUS) continue

		const value = eliteValue(e)
		const fix = away !== null && away > 4000 ? 1.3 : 0.9
		const sig = `OBJ_CONCEDED|${e.monsterType ?? "UNKNOWN"}|${
			tSec < 600 ? "EARLY"
			: tSec < 1500 ? "MID"
			: "LATE"
		}`
		const recur = recurrence.get(sig) ?? 1
		const score = value * fix * recurrenceBoost(recur)
		const swing = swingAt(tMs)
		const name = eliteName(e)

		out.push({
			moment: {
				id: makeMomentId(gameId, "objective_missed", tSec),
				gameId,
				tSec,
				kind: "objective_missed",
				// A FACT, not an accusation. "While you were elsewhere" asserted both that he was
				// absent and that being absent was wrong. The app can establish neither: position
				// is interpolated, and whether contesting was even possible depends on who else
				// was alive, whether smite was up, and whether pushing was the better trade —
				// none of which is in this data.
				title: `Enemy took ${name} at ${fmtClock(tSec)}`,
				severity: severityOf(score),
				mapX: mePos ? round(mePos.x) : objPos.x,
				mapY: mePos ? round(mePos.y) : objPos.y,
				cameraTarget: { x: objPos.x, y: objPos.y },
				participantsInvolved: [userId, killer],
				costGold: value,
				confidence: mePos ? "low" : "medium",
				evidence: `ELITE_MONSTER_KILL ${e.monsterType}${e.monsterSubType ? `/${e.monsterSubType}` : ""} at ${fmtClock(tSec)}, killerId ${killer} (enemy team). He was ALIVE (deaths within 75s are excluded). Your position is INTERPOLATED between once-per-minute frames — estimated ${away === null ? "unknown" : `${Math.round(away)} units`} away, a guess with median error around 1450 units. THIS IS NOT EVIDENCE OF A MISTAKE: contesting depends on teammates alive, smite availability and whether a cross-map trade was better, none of which is recorded here. Report it as a fact about the game, not as something he did wrong. The ${value}g cost is a fixed objective-value proxy, not a measurement; the measured team gold-lead swing over the next 90s was ${swing === null ? "unavailable" : `${swing}g`}.`
			},
			kind: "objective_missed",
			positive: false,
			costGold: value,
			fixability: fix,
			recurrenceCount: recur,
			score: round(score),
			signature: sig,
			zoneLabel: zoneOf(objPos, teamId),
			measuredSwing90s: swing,
			why: `${fmtClock(tSec)} — the enemy took ${name} in the ${zoneOf(objPos, teamId)}. Your estimated distance was ${away === null ? "unknown" : `about ${Math.round(away)} units`}, interpolated between once-per-minute frames. This does NOT establish that contesting was possible: whether it was depends on who else was alive, whether smite was up and whether a trade elsewhere was better, none of which this data contains.`
		})
	}

	/* ------------------------------------------------- objectives secured */

	for (const e of events) {
		if (e.type !== "ELITE_MONSTER_KILL") continue
		if ((e.killerId ?? 0) !== userId) continue
		const tMs = e.timestamp
		const tSec = round(tMs / 1000, 1)
		const value = eliteValue(e)
		const objPos: Pos =
			e.position ? { x: e.position.x, y: e.position.y } : { x: 0, y: 0 }
		const swing = swingAt(tMs)
		// Scored at full objective value: securing a baron IS the highlight of a game, while
		// a set of grubs scores low enough that it only surfaces when nothing bigger happened.
		const score = value
		const name = eliteName(e)

		out.push({
			moment: {
				id: makeMomentId(gameId, "objective", tSec),
				gameId,
				tSec,
				kind: "objective",
				title: `You smited ${name}`,
				severity: severityOf(score),
				mapX: objPos.x,
				mapY: objPos.y,
				cameraTarget: null,
				participantsInvolved: [userId],
				costGold: value,
				confidence: "high",
				evidence: `ELITE_MONSTER_KILL ${e.monsterType}${e.monsterSubType ? `/${e.monsterSubType}` : ""} at ${fmtClock(tSec)} with killerId ${userId} — that field is exact and is the one objective field the API gets right (the assist list on these events is corrupt and is ignored). The ${value}g figure is a fixed objective-value proxy; measured team gold-lead swing over the next 90s was ${swing === null ? "unavailable" : `${swing}g`}.`
			},
			kind: "objective",
			positive: true,
			costGold: value,
			fixability: 1,
			recurrenceCount: 1,
			score: round(score),
			signature: `OBJ_SECURED|${e.monsterType ?? "UNKNOWN"}`,
			zoneLabel: zoneOf(objPos, teamId),
			measuredSwing90s: swing,
			why: `${fmtClock(tSec)} — you landed the smite on ${name}. Exact, from killerId.`
		})
	}

	/* ------------------------------------------------------ clean kills */

	for (const e of events) {
		if (e.type !== "CHAMPION_KILL") continue
		if ((e.killerId ?? 0) !== userId) continue
		const assists = (e.assistingParticipantIds ?? []).filter(id => id > 0)
		const victim = e.victimId ?? 0
		const soloKill = assists.length === 0
		const onOpponent = oppId !== null && victim === oppId
		if (!soloKill && !onOpponent) continue
		const tMs = e.timestamp
		const tSec = round(tMs / 1000, 1)
		const pos: Pos = e.position ? { x: e.position.x, y: e.position.y } : { x: 0, y: 0 }
		const score = soloKill && onOpponent ? 700 : soloKill ? 500 : 380
		const swing = swingAt(tMs)
		const zl = zoneOf(pos, teamId)

		out.push({
			moment: {
				id: makeMomentId(gameId, "kill", tSec),
				gameId,
				tSec,
				kind: "kill",
				title:
					soloKill && onOpponent ? `Solo kill on the enemy jungler in the ${zl}`
					: soloKill ? `Solo kill in the ${zl}`
					: `Killed your opposite number in the ${zl}`,
				severity: severityOf(score),
				mapX: pos.x,
				mapY: pos.y,
				cameraTarget: null,
				participantsInvolved: [userId, victim, ...assists],
				costGold: score,
				confidence: "high",
				evidence: `CHAMPION_KILL at ${fmtClock(tSec)} with killerId ${userId}, victimId ${victim}, ${assists.length} assists — exact, from the event. The gold figure is a flat proxy for a kill's worth, not a measurement; measured team gold-lead swing over the next 90s was ${swing === null ? "unavailable" : `${swing}g`}.`
			},
			kind: "kill",
			positive: true,
			costGold: score,
			fixability: 1,
			recurrenceCount: 1,
			score,
			signature: `KILL|${soloKill ? "SOLO" : "ASSISTED"}|${onOpponent ? "OPPONENT" : "OTHER"}`,
			zoneLabel: zl,
			measuredSwing90s: swing,
			why: `${fmtClock(tSec)} — ${soloKill ? "solo kill" : "kill"}${onOpponent ? " on your opposite number" : ""} in the ${zl}.`
		})
	}

	/* -------------------------------------------------------- teamfights */

	const kills = events.filter(e => e.type === "CHAMPION_KILL")
	const usedInFight = new Set<LcuEvent>()
	for (let i = 0; i < kills.length; i++) {
		const seed = kills[i]!
		if (usedInFight.has(seed)) continue
		const window = kills.filter(
			k => k.timestamp >= seed.timestamp && k.timestamp <= seed.timestamp + 20_000
		)
		if (window.length < 3) continue
		const involved = window.some(k =>
			[k.killerId ?? 0, k.victimId ?? 0, ...(k.assistingParticipantIds ?? [])].includes(
				userId
			)
		)
		if (!involved) continue
		for (const k of window) usedInFight.add(k)
		const ourKills = window.filter(k => (k.killerId ?? 0) > 0 && teamOfPid(k.killerId!) === teamId).length
		const theirKills = window.length - ourKills
		const net = ourKills - theirKills
		const tMs = seed.timestamp
		const tSec = round(tMs / 1000, 1)
		if (durSec > 0 && tSec > durSec - endgameGuard) continue
		const pos: Pos =
			seed.position ? { x: seed.position.x, y: seed.position.y } : { x: 0, y: 0 }
		const swing = swingAt(tMs)
		const score = Math.abs(net) * 400 + window.length * 60
		const zl = zoneOf(pos, teamId)

		out.push({
			moment: {
				id: makeMomentId(gameId, "teamfight", tSec),
				gameId,
				tSec,
				kind: "teamfight",
				title:
					net > 0 ? `Won a ${window.length}-kill fight in the ${zl} (+${net})`
					: net < 0 ? `Lost a ${window.length}-kill fight in the ${zl} (${net})`
					: `Even ${window.length}-kill fight in the ${zl}`,
				severity: severityOf(score),
				mapX: pos.x,
				mapY: pos.y,
				cameraTarget: null,
				participantsInvolved: [
					...new Set(
						window.flatMap(k => [
							k.killerId ?? 0,
							k.victimId ?? 0,
							...(k.assistingParticipantIds ?? [])
						])
					)
				].filter(p => p > 0),
				costGold: Math.abs(net) * 400,
				confidence: "medium",
				evidence: `${window.length} CHAMPION_KILL events between ${fmtClock(tSec)} and ${fmtClock(tSec + 20)} within 20 seconds of each other, ${ourKills} for your team and ${theirKills} against, with you credited on at least one. Grouping kills into a "fight" is a 20-second heuristic — the timeline has no fight boundary. The gold figure is a flat 400g-per-net-kill proxy; measured team gold-lead swing over the next 90s was ${swing === null ? "unavailable" : `${swing}g`}.`
			},
			kind: "teamfight",
			positive: net > 0,
			costGold: Math.abs(net) * 400,
			fixability: 1,
			recurrenceCount: 1,
			score: round(score),
			signature: `FIGHT|${net > 0 ? "WON" : net < 0 ? "LOST" : "EVEN"}`,
			zoneLabel: zl,
			measuredSwing90s: swing,
			why: `${fmtClock(tSec)} — a ${window.length}-kill fight in the ${zl}, ${ourKills}-${theirKills} in your favour${net < 0 ? " (i.e. against you)" : ""}.`
		})
	}

	/* ----------------------------------------------- metric-driven moments */

	/*
	 * These two are anchored to a metric rather than to an event, so they are the only
	 * moments whose `costGold` is openly a conversion factor. Both cite their metric key so
	 * the UI can link the moment straight to the number that produced it.
	 */
	const csGap = metrics.find(m => m.key === "csDelta@14")
	if (csGap && csGap.value <= -20 && durSec > 14 * 60 + endgameGuard) {
		const tSec = 14 * 60
		const mePos = interpPosition(frames, userId, tSec * 1000)
		const cost = Math.round(Math.abs(csGap.value) * 25)
		const score = cost * 0.8
		out.push({
			moment: {
				id: makeMomentId(gameId, "cs_gap", tSec),
				gameId,
				tSec,
				kind: "cs_gap",
				title: `${Math.abs(csGap.value)} camps behind your opposite number by 14:00`,
				severity: severityOf(score),
				mapX: mePos ? round(mePos.x) : 0,
				mapY: mePos ? round(mePos.y) : 0,
				cameraTarget: null,
				participantsInvolved: oppId === null ? [userId] : [userId, oppId],
				costGold: cost,
				confidence: "medium",
				evidence: `Metric csDelta@14 = ${csGap.value}, interpolated from the once-per-minute frames. The gold figure converts a camp at a flat 25g and is a rough proxy, not a measurement.`
			},
			kind: "cs_gap",
			positive: false,
			costGold: cost,
			fixability: 0.8,
			recurrenceCount: 1,
			score: round(score),
			signature: "CS_GAP|14",
			zoneLabel: mePos ? zoneOf(mePos, teamId) : "unknown",
			measuredSwing90s: null,
			why: `By 14:00 you were ${Math.abs(csGap.value)} camps behind. ${csGap.explain}`
		})
	}

	const oxMetric = metrics.find(m => m.key === "p90OverExtension")
	if (oxMetric && frames.length >= 15) {
		let worst: { tMs: number; ox: number; pos: Pos } | null = null
		for (const f of frames) {
			if (f.timestamp <= 0) continue
			const me = f.participantFrames[String(userId)]
			if (!me) continue
			const allyD: number[] = []
			for (const a of allies) {
				const p = f.participantFrames[String(a)]
				if (p) allyD.push(dist(me.position, p.position))
			}
			const enemyD: number[] = []
			for (const en of enemies) {
				const p = f.participantFrames[String(en)]
				if (p) enemyD.push(dist(me.position, p.position))
			}
			if (allyD.length === 0 || enemyD.length === 0) continue
			const ox = Math.min(...allyD) / (Math.min(...enemyD) + 1500)
			if (!worst || ox > worst.ox)
				worst = { tMs: f.timestamp, ox, pos: { x: me.position.x, y: me.position.y } }
		}
		if (worst && worst.ox >= oxMetric.value) {
			const tSec = round(worst.tMs / 1000, 1)
			if (durSec <= 0 || tSec <= durSec - endgameGuard) {
				const cost = Math.round(worst.ox * 700)
				const score = cost * 0.9
				const zl = zoneOf(worst.pos, teamId)
				out.push({
					moment: {
						id: makeMomentId(gameId, "positioning", tSec),
						gameId,
						tSec,
						kind: "positioning",
						title: `Furthest from your team all game, in the ${zl}`,
						severity: severityOf(score),
						mapX: worst.pos.x,
						mapY: worst.pos.y,
						cameraTarget: null,
						participantsInvolved: [userId],
						costGold: cost,
						confidence: "medium",
						evidence: `Frame at ${fmtClock(tSec)}: over-extension index ${round(worst.ox, 2)} (nearest ally / (nearest enemy + 1500)), the highest of ${frames.length} once-per-minute samples in this game, and at or above your p90 for the game (metric p90OverExtension = ${oxMetric.value}). Positions here are REAL frame samples, not interpolated, but they are one snapshot per minute — you may well have been somewhere else ten seconds later. The gold figure is a conversion of the index, not a measurement.`
					},
					kind: "positioning",
					positive: false,
					costGold: cost,
					fixability: 0.9,
					recurrenceCount: 1,
					score: round(score),
					signature: "POSITIONING|P90_OX",
					zoneLabel: zl,
					measuredSwing90s: swingAt(worst.tMs),
					why: `${fmtClock(tSec)} — your worst over-extension sample of the game (index ${round(worst.ox, 2)}) in the ${zl}. One frame per minute, so treat it as a snapshot of a habit rather than proof of a moment.`
				})
			}
		}
	}

	/* ---------------------------------------------------------- selection */

	const ranked = [...out]
		.filter(m => m.score >= MIN_MOMENT_SCORE)
		.sort((a, b) => b.score - a.score)

	const chosen: MomentDetail[] = []
	const tooClose = (t: number): boolean =>
		chosen.some(c => Math.abs(c.moment.tSec - t) < dedupeSec)

	/*
	 * Primary pass: best first, capped at `maxPositives` so a good game does not become a
	 * highlight reel with nothing to learn from.
	 */
	let positives = 0
	for (const m of ranked) {
		if (chosen.length >= topN) break
		if (tooClose(m.moment.tSec)) continue
		if (m.positive && positives >= maxPositives) continue
		chosen.push(m)
		if (m.positive) positives++
	}

	/* Guarantee the encouraging bit: swap the weakest negative for the best unused positive. */
	if (positives < minPositives) {
		const bestPositive = ranked.find(
			m => m.positive && !chosen.includes(m) && !tooClose(m.moment.tSec)
		)
		if (bestPositive) {
			if (chosen.length >= topN) {
				const weakestNegativeIdx = chosen.reduce(
					(worst, m, i) =>
						!m.positive && (worst < 0 || m.score < chosen[worst]!.score) ? i : worst,
					-1
				)
				if (weakestNegativeIdx >= 0) chosen.splice(weakestNegativeIdx, 1)
			}
			chosen.push(bestPositive)
			positives++
		}
	}

	/*
	 * Fill pass: a clean game (the user died zero times in fixture 5633418474) runs out of
	 * mistakes long before it runs out of slots. Rather than pad the review with noise or
	 * leave it nearly empty, lift the positives cap and top up from what is left.
	 */
	if (chosen.length < topN)
		for (const m of ranked) {
			if (chosen.length >= topN) break
			if (chosen.includes(m)) continue
			if (tooClose(m.moment.tSec)) continue
			chosen.push(m)
		}

	return chosen.sort((a, b) => a.moment.tSec - b.moment.tSec)
}

/**
 * The ranked teachable moments for one game, ready for the DB and the UI.
 * 5-8 per game by default, chronological, each with `tSec` + `cameraTarget` for capture.
 */
export const selectMoments = (
	match: LcuGame,
	timeline: LcuTimeline | null | undefined,
	roles: RoleInference,
	userId: number,
	metrics: Metric[],
	deaths: DeathAnalysis[],
	options: SelectMomentsOptions = {}
): Moment[] =>
	selectMomentsDetailed(match, timeline, roles, userId, metrics, deaths, options).map(
		d => d.moment
	)

/**
 * What the replay seeker should do with a moment.
 *
 * The lead-in matters more than the moment: for a death you need the APPROACH, which is where
 * the mistake was actually made. `FIXED_WORLD_POSITION` is only requested when the moment's
 * camera target genuinely differs from the user's own position — the replay API's camera
 * schema is UNVERIFIED (`.research/replay-capture.md`), and only the follow-participant mode
 * is safe to assume, so the caller must be able to fall back.
 */
export const captureWindow = (
	moment: Moment,
	userId: number,
	durationSec = Infinity
): CaptureWindow => {
	const w =
		CAPTURE_WINDOWS[moment.kind as keyof typeof CAPTURE_WINDOWS] ??
		CAPTURE_WINDOWS.default
	return {
		gameId: moment.gameId,
		startSec: Math.max(0, round(moment.tSec - w.leadIn, 1)),
		endSec: Math.min(durationSec, round(moment.tSec + w.leadOut, 1)),
		focusSec: moment.tSec,
		camera:
			moment.cameraTarget ?
				{ mode: "FIXED_WORLD_POSITION", x: moment.cameraTarget.x, y: moment.cameraTarget.y }
			:	{ mode: "FOLLOW_PARTICIPANT", participantId: userId },
		wantMinimap:
			moment.kind === "objective_missed" ||
			moment.kind === "positioning" ||
			moment.kind === "tempo"
	}
}

/** Corpus-wide signature counts a caller can feed back in as `options.recurrence`. */
export const momentSignatureCounts = (
	details: MomentDetail[]
): Map<string, number> => {
	const m = new Map<string, number>()
	for (const d of details) m.set(d.signature, (m.get(d.signature) ?? 0) + 1)
	return m
}

