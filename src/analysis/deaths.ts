/**
 * Death analysis — the highest-value output in the app.
 *
 * ## What is FACT and what is a GUESS, kept strictly apart
 * FACT (straight off a `CHAMPION_KILL` event): the timestamp, the exact position, the killer,
 * the assist list, and therefore how many enemies were credited. `killerId === 0` happens in
 * 4 of 1416 events (an execute / minion / turret kill) and is kept, not filtered — dying to
 * the wave under tower is one of the most teachable deaths there is.
 *
 * GUESS (anything derived from interpolated positions): who was standing near you. Frames are
 * one per minute; the median player moves 4082 units between samples. Validated against 85
 * objectives the user provably smited, positional presence detection tops out at ~65%
 * sensitivity at a usable false-positive rate (`.research/analytics.md` §4.3). **There is no
 * operating point that gives a trustworthy binary "was he there".**
 *
 * So `IsolationEstimate` always carries both an event-derived `provenAlliesPresent` list
 * (hard evidence — an ally scored or took a kill within +/-10 s and 2500 units) and a soft
 * interpolated distance, plus a `confidence` and a `note` written for a human to read.
 * The UI and the coaching prompt must say "likely alone", never "you were alone".
 */

import {
	classifyZone,
	dist,
	half,
	zoneOf,
	type Half,
	type Pos,
	type TeamId,
	type Zone
} from "../shared/map.ts"
import { fmtClock } from "../shared/time.ts"
import type { LcuEvent, LcuGame, LcuTimeline } from "../shared/schema/lcu.ts"
import type { Confidence } from "../shared/schema/domain.ts"
import {
	allEvents,
	framesOf,
	interpPosition,
	interpScalar,
	round,
	stepScalar,
	teamGoldAt
} from "./frames.ts"
import { alliesOf, enemiesOf, laneOpponent, type RoleInference } from "./roles.ts"

/* ================================================================ tuning */

/** Recommended operating point from §4.3: interpolated position, 2400 units, ~65% sensitivity. */
export const PRESENCE_RADIUS = 2400
export const PRESENCE_SENSITIVITY = 0.65
/** An ally who scored or took a kill this close in space and time was provably there. */
export const PROOF_RADIUS = 2500
export const PROOF_WINDOW_MS = 10_000
/** Beyond this the interpolation error (median 1452 units) cannot explain the gap away. */
export const UNAMBIGUOUS_ISOLATION = 5000

export type DeathPhase = "EARLY" | "MID" | "LATE"
export type DeathEconomy = "BEHIND" | "EVEN" | "AHEAD"
export type DeathIsolation = "SOLO" | "PARTIAL" | "WITH_TEAM"
export type DeathOutnumbering = "1v1" | "2v" | "OUTNUMBERED"

export const phaseOf = (tSec: number): DeathPhase =>
	tSec < 600 ? "EARLY" : tSec < 1500 ? "MID" : "LATE"

export const economyOf = (goldDelta: number | null): DeathEconomy =>
	goldDelta === null ? "EVEN"
	: goldDelta < -400 ? "BEHIND"
	: goldDelta > 400 ? "AHEAD"
	: "EVEN"

export const outnumberingOf = (enemiesCredited: number): DeathOutnumbering =>
	enemiesCredited <= 1 ? "1v1" : enemiesCredited === 2 ? "2v" : "OUTNUMBERED"

/**
 * Objective spawn model.
 *
 * **UNVERIFIED as exact constants.** First-spawn times change patch to patch and a 22-game
 * corpus can only give a lower bound (earliest observed kill: dragon 5:34, grubs 8:11,
 * herald 15:30, baron 21:02). The RESPAWN INTERVALS are well supported by the observed gap
 * distributions (dragon median 5:40 between kills, baron median 7:11). Callers may override.
 */
export interface SpawnModel {
	dragonFirstSec: number
	dragonRespawnSec: number
	baronFirstSec: number
	baronRespawnSec: number
}

export const DEFAULT_SPAWN_MODEL: SpawnModel = {
	dragonFirstSec: 300,
	dragonRespawnSec: 300,
	baronFirstSec: 1200,
	baronRespawnSec: 360
}

/** A death inside [spawn - 45s, spawn + 90s] was a death "on the objective clock". */
export const SPAWN_WINDOW_BEFORE = 45
export const SPAWN_WINDOW_AFTER = 90

/**
 * Base respawn wait by level, seconds.
 *
 * **UNVERIFIED.** One-minute frames cannot measure a 20-50 second timer, and the LCU exposes
 * no respawn field. These are the community-reference values; the build should re-source them
 * from the client's game data and pin them per patch. Everything that uses this table reports
 * `downtimeSource: "BRW_TABLE_ESTIMATE"` so no consumer can mistake it for a measurement.
 */
export const BRW_BY_LEVEL: readonly number[] = [
	10, 10, 12, 12, 14, 16, 20, 21, 22, 24, 25, 28, 32.5, 35, 37.5, 40, 42.5, 45
]

/** Time-increase factor. Also UNVERIFIED — a rough late-game multiplier, not a measurement. */
export const timeIncreaseFactor = (tSec: number): number => {
	if (tSec < 900) return 0
	if (tSec < 1800) return ((tSec - 900) / 30) * 0.00425
	if (tSec < 2700) return 0.1275 + ((tSec - 1800) / 30) * 0.003
	return 0.2175 + ((tSec - 2700) / 30) * 0.0145
}

/** Measured, not modelled: excess team-gold cost of a death over the following 90s (§4.5). */
export const MEASURED_EXCESS_GOLD_PER_DEATH = -418

/* ================================================================= types */

export interface IsolationEstimate {
	/** Allies PROVEN present: they scored or took a kill within +/-10 s and 2500 units. */
	provenAlliesPresent: number[]
	/** Interpolated distance to the nearest ally. SOFT — median reconstruction error 1452u. */
	nearestAllyDistance: number | null
	alliesWithin2000: number
	verdict: DeathIsolation
	confidence: Confidence
	/** Human-readable hedge. Never asserts presence as fact. */
	note: string
}

export interface ObjectiveContext {
	/** Enemy elite objectives taken in the 45 s AFTER this death. Exact — from events. */
	objectiveConcededWithin45s: string[]
	secondsToNextDragonSpawn: number | null
	secondsToNextBaronSpawn: number | null
	inSpawnWindow: boolean
	note: string
}

export interface DeathCost {
	/** Enemy kill gold. 300 base + 150/assist. A FLOOR: the timeline has no bounty field. */
	goldToEnemy: number
	/** Own gold-per-minute times estimated downtime. */
	goldForgone: number
	estimatedDowntimeSec: number
	/** 500 per elite objective conceded in the following 45 s. */
	objectivePenalty: number
	totalGold: number
	downtimeSource: "BRW_TABLE_ESTIMATE"
	/** Measured team gold-lead swing over the 90 s after the death, or null outside frames. */
	measuredTeamGoldSwing90s: number | null
	note: string
}

export interface DeathAnalysis {
	gameId: number
	/** Exact, from the event — NOT interpolated. */
	tSec: number
	clock: string
	position: Pos
	zone: Zone
	zoneLabel: string
	half: Half
	/** Step value from the last frame at or before the death. */
	level: number | null
	totalGold: number | null
	goldDeltaVsOpponent: number | null
	levelDeltaVsOpponent: number | null
	/** EXACT: 1 + assist count. `killerId === 0` (execute/minion/turret) credits 0 champions. */
	enemiesCredited: number
	killerId: number
	assistIds: number[]
	isolation: IsolationEstimate
	objectiveContext: ObjectiveContext
	cost: DeathCost
	phase: DeathPhase
	economy: DeathEconomy
	outnumbering: DeathOutnumbering
	/** Coarse recurrence key: `ZONE|PHASE|ISOLATION`. Used for cross-game repetition. */
	signature: string
	/** One honest sentence. Safe to hand to Claude verbatim. */
	summary: string
}

/* ============================================================== analysis */

const monsterLabel = (e: LcuEvent): string => {
	const t = (e.monsterType ?? "").toLowerCase().replace(/_/g, " ")
	const s = (e.monsterSubType ?? "").toLowerCase().replace(/_/g, " ")
	return s || t || "elite monster"
}

/** `ZONE|PHASE|ISOLATION` — the coarse triple used for recurrence, per §8.2. */
export const signatureOf = (d: {
	zone: Zone
	phase: DeathPhase
	isolation: { verdict: DeathIsolation }
}): string => `${d.zone}|${d.phase}|${d.isolation.verdict}`

/**
 * Analyse every death the user suffered in one game.
 *
 * Needs the timeline for gold/level/position context; without it you still get the exact
 * event facts (time, position, killer, assists) and everything else degrades to `null`.
 */
export const analyzeDeaths = (
	match: LcuGame,
	timeline: LcuTimeline | null | undefined,
	roles: RoleInference,
	userId: number,
	spawnModel: SpawnModel = DEFAULT_SPAWN_MODEL
): DeathAnalysis[] => {
	const frames = framesOf(timeline)
	const events = allEvents(timeline)
	const meP = match.participants.find(p => p.participantId === userId)
	if (!meP) return []
	const teamId = meP.teamId as TeamId
	const allies = alliesOf(match, userId)
	const enemies = enemiesOf(match, userId)
	const oppId = laneOpponent(roles, match, userId)
	const gpm =
		match.gameDuration > 0 ? meP.stats.goldEarned / (match.gameDuration / 60) : 0

	const kills = events.filter(e => e.type === "CHAMPION_KILL")
	const elites = events.filter(e => e.type === "ELITE_MONSTER_KILL")
	const myDeaths = kills.filter(e => e.victimId === userId)

	const priorEliteOfType = (
		type: "DRAGON" | "BARON_NASHOR",
		beforeMs: number
	): number | null => {
		let last: number | null = null
		for (const e of elites)
			if (e.monsterType === type && e.timestamp <= beforeMs) last = e.timestamp
		return last
	}

	const out: DeathAnalysis[] = []
	for (const ev of myDeaths) {
		const tMs = ev.timestamp
		const tSec = tMs / 1000
		const pos: Pos =
			ev.position ?
				{ x: ev.position.x, y: ev.position.y }
			:	(interpPosition(frames, userId, tMs) ?? { x: 0, y: 0 })
		const zone = classifyZone(pos, teamId)
		const assistIds = (ev.assistingParticipantIds ?? []).filter(
			id => id > 0 && id !== userId
		)
		const killerId = ev.killerId ?? 0
		const enemiesCredited = (killerId > 0 ? 1 : 0) + assistIds.length

		/* ---- economy ---- */
		const level = stepScalar(frames, userId, tMs, "level")
		const totalGold = interpScalar(frames, userId, tMs, "totalGold")
		const oppGold =
			oppId === null ? null : interpScalar(frames, oppId, tMs, "totalGold")
		const oppLevel = oppId === null ? null : stepScalar(frames, oppId, tMs, "level")
		const goldDelta =
			totalGold !== null && oppGold !== null ? totalGold - oppGold : null
		const levelDelta = level !== null && oppLevel !== null ? level - oppLevel : null

		/* ---- isolation ---- */
		const proven = new Set<number>()
		for (const k of kills) {
			if (k === ev) continue
			if (Math.abs(k.timestamp - tMs) > PROOF_WINDOW_MS) continue
			if (!k.position) continue
			if (dist(k.position, pos) > PROOF_RADIUS) continue
			const parties = [
				k.killerId ?? 0,
				k.victimId ?? 0,
				...(k.assistingParticipantIds ?? [])
			]
			for (const p of parties) if (p > 0 && allies.includes(p)) proven.add(p)
		}
		// The user's own death event names the assisting ENEMIES, never allies.
		const allyDists: number[] = []
		for (const a of allies) {
			const ap = interpPosition(frames, a, tMs)
			if (ap) allyDists.push(dist(ap, pos))
		}
		const nearestAlly = allyDists.length > 0 ? Math.min(...allyDists) : null
		const within2000 = allyDists.filter(d => d <= 2000).length
		const provenList = [...proven].sort((a, b) => a - b)
		const verdict: DeathIsolation =
			provenList.length >= 2 ? "WITH_TEAM"
			: (
				provenList.length === 0 &&
				nearestAlly !== null &&
				nearestAlly > PRESENCE_RADIUS
			) ?
				"SOLO"
			:	"PARTIAL"
		const isoConfidence: Confidence =
			provenList.length >= 1 ? "high"
			: nearestAlly !== null && nearestAlly > UNAMBIGUOUS_ISOLATION ? "medium"
			: "low"
		const isoNote =
			provenList.length >= 1 ?
				`${provenList.length} teammate${provenList.length === 1 ? " was" : "s were"} provably in the fight — they scored or took a kill within 10 seconds and ${PROOF_RADIUS} units of this spot.`
			: verdict === "SOLO" ?
				nearestAlly !== null && nearestAlly > UNAMBIGUOUS_ISOLATION ?
					`Likely alone: nearest teammate an estimated ${round(nearestAlly)} units away. Positions are sampled once a minute; the measured interpolation error on ONE player is median ~1450 and p90 ~4215 units, and this is a distance between TWO independently interpolated positions, so the errors add. A gap this large is unlikely to be sampling error alone — but "unlikely" is the strongest word the data supports, not "impossible".`
				:	`Likely alone (low confidence): nearest teammate an estimated ${round(nearestAlly ?? 0)} units away, from positions sampled once per minute. Presence detection built on those is only about ${Math.round(PRESENCE_SENSITIVITY * 100)}% sensitive, so treat this as a hint, not a fact.`
			:	`Unclear who was nearby. No teammate is provably in the fight, and the interpolated nearest-ally distance (${nearestAlly === null ? "unknown" : `about ${round(nearestAlly)} units`}) is inside the sampling error.`

		/* ---- objective context ---- */
		const conceded: string[] = []
		for (const e of elites) {
			if (e.timestamp <= tMs || e.timestamp > tMs + 45_000) continue
			const k = e.killerId ?? 0
			if (k === 0) continue
			const kTeam: TeamId = k <= 5 ? 100 : 200
			if (kTeam !== teamId) conceded.push(monsterLabel(e))
		}
		const nextSpawn = (
			type: "DRAGON" | "BARON_NASHOR",
			first: number,
			respawn: number
		): number | null => {
			const prev = priorEliteOfType(type, tMs)
			const spawnSec = prev === null ? first : prev / 1000 + respawn
			const delta = spawnSec - tSec
			return delta >= -SPAWN_WINDOW_AFTER ? round(delta, 1) : null
		}
		const toDragon = nextSpawn(
			"DRAGON",
			spawnModel.dragonFirstSec,
			spawnModel.dragonRespawnSec
		)
		const toBaron = nextSpawn(
			"BARON_NASHOR",
			spawnModel.baronFirstSec,
			spawnModel.baronRespawnSec
		)
		const inWindow = [toDragon, toBaron].some(
			d => d !== null && d <= SPAWN_WINDOW_BEFORE && d >= -SPAWN_WINDOW_AFTER
		)

		/* ---- cost ---- */
		const lvl = Math.max(1, Math.min(18, Math.round(level ?? 1)))
		const brw = BRW_BY_LEVEL[lvl - 1] ?? 30
		const downtime = brw * (1 + timeIncreaseFactor(tSec))
		const goldToEnemy = 300 + 150 * assistIds.length
		const goldForgone = (gpm * downtime) / 60
		const objectivePenalty = conceded.length * 500
		const gA = teamGoldAt(frames, [userId, ...allies], tMs)
		const gB = teamGoldAt(frames, [userId, ...allies], tMs + 90_000)
		const eA = teamGoldAt(frames, enemies, tMs)
		const eB = teamGoldAt(frames, enemies, tMs + 90_000)
		const swing =
			gA !== null && gB !== null && eA !== null && eB !== null ?
				round(gB - gA - (eB - eA))
			:	null

		const cost: DeathCost = {
			goldToEnemy,
			goldForgone: round(goldForgone),
			estimatedDowntimeSec: round(downtime, 1),
			objectivePenalty,
			totalGold: round(goldToEnemy + goldForgone + objectivePenalty),
			downtimeSource: "BRW_TABLE_ESTIMATE",
			measuredTeamGoldSwing90s: swing,
			note: `Ranking figure only. The ${round(downtime)}s downtime comes from an UNVERIFIED respawn table (one-minute frames cannot measure a 20-50s timer) and the ${goldToEnemy}g handed over is a floor, because the timeline carries no shutdown-bounty field. The honest measured number is about ${MEASURED_EXCESS_GOLD_PER_DEATH}g of excess team-gold cost per death, averaged over 103 past deaths.`
		}

		const phase = phaseOf(tSec)
		const economy = economyOf(goldDelta)
		const outnumbering = outnumberingOf(enemiesCredited)
		const zoneLabel = zoneOf(pos, teamId)
		const isolation: IsolationEstimate = {
			provenAlliesPresent: provenList,
			nearestAllyDistance: nearestAlly === null ? null : round(nearestAlly),
			alliesWithin2000: within2000,
			verdict,
			confidence: isoConfidence,
			note: isoNote
		}

		const killerLabel =
			killerId === 0 ?
				"no champion credited (execute, minion or turret)"
			:	`${enemiesCredited} enemy champion${enemiesCredited === 1 ? "" : "s"} credited`

		out.push({
			gameId: match.gameId,
			tSec: round(tSec, 1),
			clock: fmtClock(tSec),
			position: { x: pos.x, y: pos.y },
			zone,
			zoneLabel,
			half: half(pos, teamId),
			level,
			totalGold: totalGold === null ? null : round(totalGold),
			goldDeltaVsOpponent: goldDelta === null ? null : round(goldDelta),
			levelDeltaVsOpponent: levelDelta,
			enemiesCredited,
			killerId,
			assistIds,
			isolation,
			objectiveContext: {
				objectiveConcededWithin45s: conceded,
				secondsToNextDragonSpawn: toDragon,
				secondsToNextBaronSpawn: toBaron,
				inSpawnWindow: inWindow,
				note: `Spawn timings are estimated from this game's own objective kills plus a respawn interval (dragon ${spawnModel.dragonRespawnSec}s, baron ${spawnModel.baronRespawnSec}s). First-spawn times are UNVERIFIED and move between patches. Across 22 past games, 18% of the user's deaths were followed by a conceded elite objective within 45s, against a 10% base rate for a random window.`
			},
			cost,
			phase,
			economy,
			outnumbering,
			signature: `${zone}|${phase}|${verdict}`,
			summary: `${fmtClock(tSec)} — died in the ${zoneLabel}, ${killerLabel}, ${
				goldDelta === null ? "gold state unknown"
				: goldDelta < 0 ? `${round(-goldDelta)}g behind your opposite number`
				: `${round(goldDelta)}g ahead of your opposite number`
			}. ${isoNote}${
				conceded.length > 0 ?
					` The enemy took ${conceded.join(" and ")} within 45 seconds.`
				:	""
			}`
		})
	}
	return out.sort((a, b) => a.tSec - b.tSec)
}

/* ============================================================ clustering */

export type PatternDim =
	| "zone"
	| "phase"
	| "economy"
	| "isolation"
	| "outnumbering"
	| "half"

export interface DeathPattern {
	dims: PatternDim[]
	values: string[]
	/** Human sentence: "before 10:00, in a straight 1v1". */
	label: string
	support: number
	/** Distinct games the pattern spans — the anti-overfit guard. */
	gamesSpanned: number
	gameIds: number[]
	share: number
	/** observed / (product of marginals). Above 1 means over-represented. */
	lift: number
	/** One-sided binomial P(X >= support) against the marginal-product null. */
	pValue: number
	/** How many itemsets were tested. Print this next to every p-value. */
	hypothesesTested: number
	/** Benjamini-Hochberg adjusted p across the tested itemsets. */
	pAdjusted: number
	deathTs: number[]
}

const dimValue = (d: DeathAnalysis, dim: PatternDim): string => {
	switch (dim) {
		case "zone":
			return d.zone
		case "phase":
			return d.phase
		case "economy":
			return d.economy
		case "isolation":
			return d.isolation.verdict
		case "outnumbering":
			return d.outnumbering
		case "half":
			return d.half
	}
}

const PRETTY: Record<PatternDim, (v: string) => string> = {
	zone: v => v.toLowerCase().replace(/_/g, " "),
	phase: v =>
		({
			EARLY: "before 10:00",
			MID: "between 10:00 and 25:00",
			LATE: "after 25:00"
		})[v] ?? v,
	economy: v =>
		({
			BEHIND: "while behind in gold",
			EVEN: "while even in gold",
			AHEAD: "while ahead in gold"
		})[v] ?? v,
	isolation: v =>
		({
			SOLO: "likely alone",
			PARTIAL: "with unclear team support",
			WITH_TEAM: "with teammates provably present"
		})[v] ?? v,
	outnumbering: v =>
		({
			"1v1": "in a straight 1v1",
			"2v": "against two enemies",
			OUTNUMBERED: "outnumbered by three or more"
		})[v] ?? v,
	half: v => `in the ${v} half`
}

/* --- binomial tail, for honest p-values --------------------------------- */

const logGamma = (z: number): number => {
	const g = 7
	const c = [
		0.99999999999980993, 676.5203681218851, -1259.1392167224028,
		771.32342877765313, -176.61502916214059, 12.507343278686905,
		-0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
	]
	if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z)
	const zz = z - 1
	let x = c[0]!
	for (let i = 1; i < g + 2; i++) x += c[i]! / (zz + i)
	const t = zz + g + 0.5
	return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x)
}

const logChoose = (n: number, k: number): number =>
	logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1)

/** One-sided P(X >= k) for X ~ Binomial(n, p). */
export const binomialTail = (k: number, n: number, p: number): number => {
	if (p <= 0) return k <= 0 ? 1 : 0
	if (p >= 1) return k <= n ? 1 : 0
	if (k <= 0) return 1
	if (k > n) return 0
	let sum = 0
	for (let i = k; i <= n; i++)
		sum += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p))
	return Math.min(1, sum)
}

const combinations = <T,>(xs: T[], k: number): T[][] => {
	if (k === 0) return [[]]
	if (xs.length < k) return []
	const [head, ...tail] = xs
	return [...combinations(tail, k - 1).map(c => [head!, ...c]), ...combinations(tail, k)]
}

/** `zone` already implies `half`; pairing them manufactures a spurious top-lift result. */
const REDUNDANT_PAIRS: ReadonlyArray<readonly [PatternDim, PatternDim]> = [
	["zone", "half"]
]

export interface ClusterOptions {
	minSupport?: number
	minGamesSpanned?: number
	maxDims?: number
	dims?: PatternDim[]
	/** Minimum lift to be reported. Below ~1.2 an itemset is just its own marginal. */
	minLift?: number
	limit?: number
}

/**
 * Mine repeated categorical death signatures across games.
 *
 * Deliberately NOT k-means on `(x, y, t)`: the coaching value is in categorical signatures a
 * player can act on ("you keep dying 1v1 before ten minutes"), not in a cloud centroid.
 *
 * Guard rails, all mandatory and all from §4.6:
 *  - `minSupport >= 6` AND `minGamesSpanned >= 4` — a pattern inside one game is one bad game.
 *  - redundant dimension pairs are skipped.
 *  - hundreds of itemsets get tested, so every pattern carries `hypothesesTested` and a
 *    Benjamini-Hochberg adjusted p alongside the raw one. Never quote the raw p alone.
 */
export const clusterDeaths = (
	deaths: DeathAnalysis[],
	options: ClusterOptions = {}
): DeathPattern[] => {
	const minSupport = options.minSupport ?? 6
	const minGames = options.minGamesSpanned ?? 4
	const maxDims = options.maxDims ?? 3
	const dims: PatternDim[] = options.dims ?? [
		"zone",
		"phase",
		"economy",
		"isolation",
		"outnumbering",
		"half"
	]
	const n = deaths.length
	if (n === 0) return []

	const marginal = new Map<string, number>()
	for (const dim of dims) {
		const counts = new Map<string, number>()
		for (const d of deaths) {
			const v = dimValue(d, dim)
			counts.set(v, (counts.get(v) ?? 0) + 1)
		}
		for (const [v, c] of counts) marginal.set(`${dim}=${v}`, c / n)
	}

	const raw: DeathPattern[] = []
	for (let k = 1; k <= Math.min(maxDims, dims.length); k++)
		for (const combo of combinations(dims, k)) {
			if (REDUNDANT_PAIRS.some(([a, b]) => combo.includes(a) && combo.includes(b)))
				continue
			const groups = new Map<string, DeathAnalysis[]>()
			for (const d of deaths) {
				const key = JSON.stringify(combo.map(dim => dimValue(d, dim)))
				const g = groups.get(key)
				if (g) g.push(d)
				else groups.set(key, [d])
			}
			for (const [key, members] of groups) {
				if (members.length < minSupport) continue
				const games = [...new Set(members.map(m => m.gameId))]
				if (games.length < minGames) continue
				const values = JSON.parse(key) as string[]
				const expected = combo.reduce(
					(acc, dim, i) => acc * (marginal.get(`${dim}=${values[i]}`) ?? 0),
					1
				)
				raw.push({
					dims: [...combo],
					values,
					label: combo.map((dim, i) => PRETTY[dim](values[i]!)).join(", "),
					support: members.length,
					gamesSpanned: games.length,
					gameIds: games.sort((a, b) => a - b),
					share: members.length / n,
					lift: expected > 0 ? members.length / n / expected : Infinity,
					pValue: binomialTail(members.length, n, expected),
					hypothesesTested: 0,
					pAdjusted: 1,
					deathTs: members.map(m => m.tSec)
				})
			}
		}

	/* Benjamini-Hochberg across everything tested. */
	const m = raw.length
	const ordered = [...raw].sort((a, b) => a.pValue - b.pValue)
	let prev = 1
	for (let i = ordered.length - 1; i >= 0; i--) {
		const p = ordered[i]!
		p.pAdjusted = Math.min(1, Math.min(prev, (p.pValue * m) / (i + 1)))
		prev = p.pAdjusted
	}
	for (const p of raw) p.hypothesesTested = m

	/*
	 * Rank by lift, exactly as the research prototype did. A single-dimension itemset has a
	 * lift of 1 BY CONSTRUCTION (it is its own marginal), so `minLift` also quietly drops the
	 * marginals that would otherwise fill the top of the table with "62% of your deaths
	 * happened while behind in gold" — true, but not a pattern.
	 */
	const minLift = options.minLift ?? 1.2
	return raw
		.filter(p => p.lift >= minLift)
		.sort((a, b) => b.lift - a.lift || b.support - a.support)
		.slice(0, options.limit ?? 12)
}

/** Corpus-wide recurrence counts, keyed by the coarse `ZONE|PHASE|ISOLATION` signature. */
export const signatureCounts = (deaths: DeathAnalysis[]): Map<string, number> => {
	const m = new Map<string, number>()
	for (const d of deaths) m.set(d.signature, (m.get(d.signature) ?? 0) + 1)
	return m
}

/** Aggregate zone histogram — what the death heatmap shows, as numbers. */
export const deathZoneHistogram = (
	deaths: DeathAnalysis[]
): { zone: Zone; n: number; share: number }[] => {
	const counts = new Map<Zone, number>()
	for (const d of deaths) counts.set(d.zone, (counts.get(d.zone) ?? 0) + 1)
	const total = deaths.length || 1
	return [...counts]
		.map(([zone, n]) => ({ zone, n, share: n / total }))
		.sort((a, b) => b.n - a.n)
}
