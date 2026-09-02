/**
 * Per-game metrics, jungler-first.
 *
 * Every number here traces to real data. Where the data cannot support a number we emit NO
 * metric rather than a plausible one — a 10-minute remake must not report a CS@20.
 *
 * ## Banding
 * Bands are ALWAYS relative to the user's own rolling baseline (`trends.rollingBaseline`),
 * never to invented "pro benchmarks". With fewer than `MIN_BASELINE_GAMES` games of history
 * the band is `"unknown"` and `vsBaseline` is `null`: we will not colour a number we cannot
 * rank. The threshold is half a standard deviation of the user's own spread, which is stated
 * in the `explain` string so it can be argued with.
 *
 * ## Confidence
 *  - `high`   — an end-of-game stat or an exact event (`killerId`, `CHAMPION_KILL`).
 *  - `medium` — computed from real frame values, which are sampled once per minute.
 *  - `low`    — depends on interpolation between frames, or on an attribution heuristic.
 */

import { TEAM_BLUE } from "../shared/constants.ts"
import { dist, half, type Pos, type TeamId } from "../shared/map.ts"
import type { LcuEvent, LcuGame, LcuTimeline } from "../shared/schema/lcu.ts"
import type { Band, Confidence, Metric } from "../shared/schema/domain.ts"
import {
	allEvents,
	clamp,
	framesOf,
	interpScalar,
	lastFrameMs,
	mean,
	median,
	percentile,
	pfOf,
	round,
	stepScalar,
	teamGoldAt
} from "./frames.ts"
import type { RoleInference } from "./roles.ts"
import { alliesOf, enemiesOf, laneOpponent } from "./roles.ts"

/* ============================================================ definitions */

/** How stable a metric is across games — the prior from `.research/analytics.md` §7.2. */
export type TrendTier = "stable" | "noisy" | "not-trendable"

export interface MetricDef {
	key: string
	label: string
	unit: string
	/** `null` for descriptive metrics that are neither good nor bad. */
	higherIsBetter: boolean | null
	tier: TrendTier
	/**
	 * True when the metric is mostly an EFFECT of winning rather than a lever you can pull.
	 * `enemy_half_pct` correlates +0.69 with winning almost entirely because teams that are
	 * already winning push into the enemy half. Telling the user to "spend more time in the
	 * enemy half" is exactly backwards, so confounded metrics are never trended as levers.
	 */
	confounded?: boolean
	note?: string
	/** Decimal places for display. Counts round to 0; indices keep 2. */
	dp?: number
}

const def = (
	key: string,
	label: string,
	unit: string,
	higherIsBetter: boolean | null,
	tier: TrendTier,
	extra: { confounded?: boolean; note?: string; dp?: number } = {}
): MetricDef => ({ key, label, unit, higherIsBetter, tier, dp: DEFAULT_DP[unit] ?? 2, ...extra })

/** Decimal places per unit. A camp count is an integer; an over-extension index is not. */
const DEFAULT_DP: Record<string, number> = {
	cs: 0,
	gold: 0,
	xp: 0,
	lvl: 0,
	units: 0,
	"%": 1,
	min: 2,
	"/min": 2,
	"": 2
}

/**
 * The registry. `tier` comes from the measured stability table over 22 games; runtime CV can
 * only confirm it, never promote a metric above its measured prior.
 */
export const METRIC_DEFS: Record<string, MetricDef> = Object.fromEntries(
	[
		def("cs@10", "Camps + CS @10", "cs", true, "stable"),
		def("cs@14", "Camps + CS @14", "cs", true, "stable"),
		def("cs@20", "Camps + CS @20", "cs", true, "stable"),
		def("csDelta@10", "CS diff vs opponent @10", "cs", true, "not-trendable", {
			note: "sd 13.5 around a mean of -1.5 over 21 games; the 95% CI contains zero."
		}),
		def("csDelta@14", "CS diff vs opponent @14", "cs", true, "not-trendable"),
		def("csDelta@20", "CS diff vs opponent @20", "cs", true, "not-trendable"),
		def("goldDelta@10", "Gold diff vs opponent @10", "gold", true, "not-trendable", {
			note: "sd 682 around a mean of -224 over 21 games. You would need ~45 games for a +/-200g CI."
		}),
		def("goldDelta@14", "Gold diff vs opponent @14", "gold", true, "not-trendable"),
		def("xpDelta@10", "XP diff vs opponent @10", "xp", true, "not-trendable"),
		def("xpDelta@14", "XP diff vs opponent @14", "xp", true, "not-trendable"),
		def("levelDelta@14", "Level diff vs opponent @14", "lvl", true, "not-trendable"),
		def("firstBackMin", "First back (upper bound)", "min", null, "not-trendable", {
			note: "60s resolution — the back happened in the minute BEFORE this mark, so the measurement granularity (1.0 min) is coarser than the game-to-game spread. A trend line on a value that can only take whole-minute values would be reading noise off the quantiser."
		}),
		def("firstBackDeltaMin", "First back vs opponent", "min", null, "not-trendable"),
		def("campsPerMin", "Camps per minute", "/min", true, "stable"),
		def("enemyJungleShare", "Camps taken in enemy jungle", "%", true, "not-trendable", {
			note: "CV 0.82 across 22 games — genuinely noisy, and the half attribution is a heuristic."
		}),
		def("kda", "KDA", "", true, "noisy"),
		def("kills", "Kills", "", true, "not-trendable"),
		def("assists", "Assists", "", true, "not-trendable"),
		def("deaths", "Deaths", "", false, "noisy"),
		def("deathsPerMin", "Deaths per minute", "/min", false, "noisy"),
		def("killParticipation", "Kill participation", "%", true, "noisy"),
		def("damageShare", "Share of team damage", "%", true, "noisy"),
		def("damagePerMin", "Damage to champions per min", "/min", true, "not-trendable", {
			note: "CV 0.61 over 22 games — swings with game state, not with skill."
		}),
		def("damagePerGold", "Damage per gold", "", true, "noisy"),
		def("goldPerMin", "Gold per minute", "/min", true, "stable"),
		def("visionPerMin", "Vision score per minute", "/min", true, "noisy"),
		def("eliteControlPct", "Share of elite objectives taken", "%", true, "noisy"),
		def("elitesSecuredByUser", "Elite objectives you smited", "", true, "noisy"),
		def("ownHalfPct", "Time in your own half", "%", null, "stable", {
			confounded: true,
			note: "Mirrors enemy-half share; both are driven by who is winning, not by a decision."
		}),
		def("neutralHalfPct", "Time on neutral ground", "%", null, "noisy"),
		def("enemyHalfPct", "Time in the enemy half", "%", null, "not-trendable", {
			confounded: true,
			note: "r=+0.69 with winning, but that is reverse causality: winning teams push in. Not a lever."
		}),
		def("medianCentroidDist", "Distance from your team", "units", false, "stable"),
		def("medianNearestAlly", "Distance to nearest ally", "units", false, "noisy"),
		def("medOverExtension", "Over-extension (median)", "", false, "stable"),
		def("p90OverExtension", "Over-extension (p90)", "", false, "stable"),
		def("goldLostToDeaths", "Gold handed to the enemy", "gold", false, "noisy"),
		def("goldSwingAfterDeath90s", "Team gold swing 90s after your deaths", "gold", true, "not-trendable", {
			note: "Per-death sd is ~1150g. Only the mean over ~100 deaths means anything."
		})
	].map(d => [d.key, d])
)

/* =============================================================== baseline */

/** One metric's rolling history. Produced by `trends.rollingBaseline`. */
export interface BaselineStat {
	key: string
	n: number
	mean: number
	sd: number
	median: number
}

export type Baseline = Record<string, BaselineStat>

/** Below this many prior games we refuse to band. Five is already thin; say so in the copy. */
export const MIN_BASELINE_GAMES = 5

/** Half a standard deviation of the user's own spread. Stated in every banded `explain`. */
export const BAND_Z = 0.5

/* =============================================================== helpers */

const durationMin = (match: LcuGame): number => Math.max(1 / 60, match.gameDuration / 60)

const statsOf = (match: LcuGame, pid: number) =>
	match.participants.find(p => p.participantId === pid)?.stats ?? null

const teamOf = (match: LcuGame, pid: number): TeamId =>
	(match.participants.find(p => p.participantId === pid)?.teamId ?? TEAM_BLUE) as TeamId

/** Effective CS at a mark: lane minions + jungle camps, interpolated. `null` past the last frame. */
export const csAt = (
	frames: ReturnType<typeof framesOf>,
	pid: number,
	minute: number
): number | null => {
	const ms = minute * 60_000
	const lane = interpScalar(frames, pid, ms, "minionsKilled")
	const jgl = interpScalar(frames, pid, ms, "jungleMinionsKilled")
	return lane === null || jgl === null ? null : lane + jgl
}

/* ------------------------------------------------------------ first back */

export interface Back {
	/** The shop visit happened somewhere in (windowStartMin, windowEndMin]. Frames are 1/min. */
	windowStartMin: number
	windowEndMin: number
	goldSpent: number
}

/**
 * There are no `ITEM_PURCHASED` events in the LCU timeline, but `currentGold` only ever
 * decreases when you buy, and you can only buy in the fountain. A frame-to-frame drop of
 * >= `thresholdGold` is therefore a proven shop visit — resolved to +/-60 s, no better.
 *
 * The frame-0 -> frame-1 transition is SKIPPED: that is the starting item purchase
 * (a 445-450 g drop in 22/22 games), not a back.
 */
export const detectBacks = (
	frames: ReturnType<typeof framesOf>,
	pid: number,
	thresholdGold = 250
): Back[] => {
	const out: Back[] = []
	for (let i = 1; i < frames.length - 1; i++) {
		const a = pfOf(frames[i]!, pid)
		const b = pfOf(frames[i + 1]!, pid)
		if (!a || !b) continue
		const drop = a.currentGold - b.currentGold
		if (drop >= thresholdGold)
			out.push({
				windowStartMin: round(frames[i]!.timestamp / 60_000, 2),
				windowEndMin: round(frames[i + 1]!.timestamp / 60_000, 2),
				goldSpent: drop
			})
	}
	return out
}

/* ------------------------------------------------------- jungle farm split */

export interface JungleFarmSplit {
	ownHalfCamps: number
	enemyHalfCamps: number
	/** Scuttle and river camps inside the +/-900u neutral band. Never folded into a side. */
	neutralBandCamps: number
	totalCamps: number
	enemyShare: number
	campsPerMinute: number
}

/**
 * `neutralMinionsKilledEnemyJungle` and `...TeamJungle` are 0 in every game — dead fields.
 * Instead attribute each frame-to-frame increase in `jungleMinionsKilled` to the half the
 * player occupied at the LATER frame (that is where the camp finished).
 *
 * This is a heuristic: a camp cleared at 07:59 is credited to the 08:00 position.
 */
export const jungleFarmSplit = (
	frames: ReturnType<typeof framesOf>,
	pid: number,
	teamId: TeamId,
	durationSec: number
): JungleFarmSplit => {
	let own = 0
	let enemy = 0
	let neutral = 0
	let total = 0
	for (let i = 1; i < frames.length; i++) {
		const a = pfOf(frames[i - 1]!, pid)
		const b = pfOf(frames[i]!, pid)
		if (!a || !b) continue
		const d = b.jungleMinionsKilled - a.jungleMinionsKilled
		if (d <= 0) continue
		total += d
		const h = half(b.position, teamId)
		if (h === "own") own += d
		else if (h === "enemy") enemy += d
		else neutral += d
	}
	return {
		ownHalfCamps: own,
		enemyHalfCamps: enemy,
		neutralBandCamps: neutral,
		totalCamps: total,
		enemyShare: total > 0 ? enemy / total : 0,
		campsPerMinute: durationSec > 0 ? total / (durationSec / 60) : 0
	}
}

/* ------------------------------------------------------------ positioning */

export interface PositioningMetrics {
	halfShare: { own: number; neutral: number; enemy: number }
	medianCentroidDist: number
	medianNearestAlly: number
	medOverExtension: number
	p90OverExtension: number
	framesUsed: number
	/** True when there are too few frames for any of this to mean anything (< 15). */
	underSampled: boolean
}

/**
 * Frame-sampled positioning. Positions are REAL here (not interpolated) but they are sampled
 * once per minute, so a 25-minute game contributes ~25 observations. Under 15 frames the
 * numbers are dominated by which minute happened to be sampled.
 *
 * `overExtension = nearestAlly / (nearestEnemy + 1500)`: far from friends and close to
 * enemies scores high. The +1500 floor keeps it finite and damps sampling noise. It is an
 * index, not a measurement — the p90 is what actually separates games (0.64-1.28) while the
 * median barely moves (0.31-0.72).
 */
export const positioning = (
	frames: ReturnType<typeof framesOf>,
	pid: number,
	teamId: TeamId,
	allies: number[],
	enemies: number[]
): PositioningMetrics => {
	const halves = { own: 0, neutral: 0, enemy: 0 }
	const centroidDists: number[] = []
	const nearestAllies: number[] = []
	const overExt: number[] = []
	let used = 0

	for (const f of frames) {
		if (f.timestamp <= 0) continue
		const me = pfOf(f, pid)
		if (!me) continue
		used++
		halves[half(me.position, teamId)]++

		const allyPos: Pos[] = []
		for (const a of allies) {
			const p = pfOf(f, a)
			if (p) allyPos.push(p.position)
		}
		if (allyPos.length > 0) {
			const cx = mean(allyPos.map(p => p.x))
			const cy = mean(allyPos.map(p => p.y))
			centroidDists.push(dist(me.position, { x: cx, y: cy }))
			const nearAlly = Math.min(...allyPos.map(p => dist(me.position, p)))
			nearestAllies.push(nearAlly)

			const enemyPos: Pos[] = []
			for (const e of enemies) {
				const p = pfOf(f, e)
				if (p) enemyPos.push(p.position)
			}
			if (enemyPos.length > 0) {
				const nearEnemy = Math.min(...enemyPos.map(p => dist(me.position, p)))
				overExt.push(nearAlly / (nearEnemy + 1500))
			}
		}
	}

	const total = halves.own + halves.neutral + halves.enemy || 1
	return {
		halfShare: {
			own: halves.own / total,
			neutral: halves.neutral / total,
			enemy: halves.enemy / total
		},
		medianCentroidDist: centroidDists.length ? median(centroidDists) : 0,
		medianNearestAlly: nearestAllies.length ? median(nearestAllies) : 0,
		medOverExtension: overExt.length ? median(overExt) : 0,
		p90OverExtension: overExt.length ? percentile(overExt, 0.9) : 0,
		framesUsed: used,
		underSampled: used < 15
	}
}

/* ============================================================== the build */

interface MetricInput {
	key: string
	value: number
	confidence: Confidence
	explain: string
}

const bandFor = (
	d: MetricDef,
	value: number,
	stat: BaselineStat | undefined
): { band: Band; vsBaseline: number | null; suffix: string } => {
	if (!stat || stat.n < MIN_BASELINE_GAMES || !Number.isFinite(stat.mean))
		return {
			band: "unknown",
			vsBaseline: null,
			suffix: stat ?
				` No band yet — ${stat.n} prior game${stat.n === 1 ? "" : "s"} of history, ${MIN_BASELINE_GAMES} needed.`
			:	" No band yet — no history to compare against."
		}
	const vs = value - stat.mean
	const shown = `${vs >= 0 ? "+" : ""}${round(vs, 2)}`
	const base = ` Your ${stat.n}-game average is ${round(stat.mean, d.dp ?? 2)} (sd ${round(stat.sd, d.dp ?? 2)}); this game is ${shown}.`
	if (d.higherIsBetter === null || stat.sd === 0)
		return { band: "unknown", vsBaseline: vs, suffix: `${base} Descriptive, not scored.` }
	const z = vs / stat.sd
	const dir = d.higherIsBetter ? 1 : -1
	const band: Band = z * dir > BAND_Z ? "good" : z * dir < -BAND_Z ? "bad" : "ok"
	// The banding rule itself is stated once, in the digest's `baselineNote` — not 37 times here.
	return { band, vsBaseline: vs, suffix: base }
}

/**
 * Compute every metric this game's data supports.
 *
 * @param userId the user's participantId (`roles.findUser`)
 * @param baseline the user's rolling history (`trends.rollingBaseline`); omit on a cold start
 */
export const computeMetrics = (
	match: LcuGame,
	timeline: LcuTimeline | null | undefined,
	roles: RoleInference,
	userId: number,
	baseline: Baseline = {}
): Metric[] => {
	const raw: MetricInput[] = []
	const frames = framesOf(timeline)
	const events = allEvents(timeline)
	const me = statsOf(match, userId)
	if (!me) return []

	const teamId = teamOf(match, userId)
	const allies = alliesOf(match, userId)
	const enemies = enemiesOf(match, userId)
	const oppId = laneOpponent(roles, match, userId)
	const role = roles.roles[userId] ?? "UNKNOWN"
	const durMin = durationMin(match)
	const lastMs = lastFrameMs(frames)

	const push = (
		key: string,
		value: number | null,
		confidence: Confidence,
		explain: string
	): void => {
		if (value === null || !Number.isFinite(value)) return
		raw.push({ key, value, confidence, explain })
	}

	/* ---------------------------------------------------- lane/jungle phase */

	const oppLabel =
		oppId === null ? "your opposite number"
		: role === "JGL" ? "the enemy jungler"
		: `the enemy ${role}`

	for (const mark of [10, 14, 20] as const) {
		const markMs = mark * 60_000
		const mine = csAt(frames, userId, mark)
		if (mine === null) {
			continue
		}
		push(
			`cs@${mark}`,
			mine,
			"medium",
			`${round(mine)} camps + lane minions by ${mark}:00, interpolated from the once-per-minute frames.`
		)
		if (oppId !== null) {
			const theirs = csAt(frames, oppId, mark)
			if (theirs !== null)
				push(
					`csDelta@${mark}`,
					mine - theirs,
					"medium",
					`You had ${round(mine)} CS at ${mark}:00 vs ${round(theirs)} for ${oppLabel}.`
				)
			if (mark !== 20) {
				const gm = interpScalar(frames, userId, markMs, "totalGold")
				const go = interpScalar(frames, oppId, markMs, "totalGold")
				if (gm !== null && go !== null)
					push(
						`goldDelta@${mark}`,
						gm - go,
						"medium",
						`${round(gm)}g vs ${round(go)}g for ${oppLabel} at ${mark}:00. Over 21 past games this stat's spread (sd ~680g) is three times its average, so one game says almost nothing.`
					)
				const xm = interpScalar(frames, userId, markMs, "xp")
				const xo = interpScalar(frames, oppId, markMs, "xp")
				if (xm !== null && xo !== null)
					push(
						`xpDelta@${mark}`,
						xm - xo,
						"medium",
						`${round(xm)} xp vs ${round(xo)} for ${oppLabel} at ${mark}:00.`
					)
			}
			if (mark === 14) {
				const lm = stepScalar(frames, userId, markMs, "level")
				const lo = stepScalar(frames, oppId, markMs, "level")
				if (lm !== null && lo !== null)
					push(
						"levelDelta@14",
						lm - lo,
						"medium",
						`Level ${lm} vs ${lo} for ${oppLabel} at 14:00.`
					)
			}
		}
	}

	/* ------------------------------------------------------------ first back */

	const myBacks = detectBacks(frames, userId)
	const firstBack = myBacks[0]
	if (firstBack)
		push(
			"firstBackMin",
			firstBack.windowEndMin,
			"medium",
			`First shop visit somewhere between ${round(firstBack.windowStartMin, 1)}:00 and ${round(firstBack.windowEndMin, 1)}:00 — detected from a ${firstBack.goldSpent}g drop in carried gold, which can only happen in the fountain. Frames are 1/min so this is a 60-second window, not a timestamp.`
		)
	if (firstBack && oppId !== null) {
		const oppBack = detectBacks(frames, oppId)[0]
		if (oppBack)
			push(
				"firstBackDeltaMin",
				firstBack.windowEndMin - oppBack.windowEndMin,
				"low",
				`You backed by ${round(firstBack.windowEndMin, 1)}:00, ${oppLabel} by ${round(oppBack.windowEndMin, 1)}:00. Both are 60-second windows, so a difference under 1 minute is inside the noise.`
			)
	}

	/* ------------------------------------------------------------- farming */

	const split = jungleFarmSplit(frames, userId, teamId, match.gameDuration)
	push(
		"campsPerMin",
		me.neutralMinionsKilled / durMin,
		"high",
		`${me.neutralMinionsKilled} camps over ${round(durMin, 1)} minutes, from the end-of-game stat block.`
	)
	if (split.totalCamps > 0)
		push(
			"enemyJungleShare",
			split.enemyShare * 100,
			"low",
			`${split.enemyHalfCamps} of ${split.totalCamps} camps finished while you were in the enemy half (${split.ownHalfCamps} own half, ${split.neutralBandCamps} in the neutral river band). Attribution assigns each camp to your position at the NEXT frame, so it is approximate.`
		)

	/* --------------------------------------------------------- fighting */

	const teamKills = match.participants
		.filter(p => p.teamId === teamId)
		.reduce((a, p) => a + p.stats.kills, 0)
	const teamDamage = match.participants
		.filter(p => p.teamId === teamId)
		.reduce((a, p) => a + p.stats.totalDamageDealtToChampions, 0)

	push(
		"kda",
		me.deaths === 0 ? me.kills + me.assists : (me.kills + me.assists) / me.deaths,
		"high",
		`${me.kills}/${me.deaths}/${me.assists}${me.deaths === 0 ? " (perfect game — KDA shown as K+A)" : ""}.`
	)
	push("kills", me.kills, "high", `${me.kills} kills.`)
	push("assists", me.assists, "high", `${me.assists} assists.`)
	push("deaths", me.deaths, "high", `${me.deaths} deaths.`)
	push(
		"deathsPerMin",
		me.deaths / durMin,
		"high",
		`${me.deaths} deaths over ${round(durMin, 1)} minutes.`
	)
	if (teamKills > 0)
		push(
			"killParticipation",
			((me.kills + me.assists) / teamKills) * 100,
			"high",
			`You were credited on ${me.kills + me.assists} of your team's ${teamKills} kills.`
		)
	if (teamDamage > 0)
		push(
			"damageShare",
			(me.totalDamageDealtToChampions / teamDamage) * 100,
			"high",
			`${me.totalDamageDealtToChampions} of your team's ${teamDamage} damage to champions.`
		)
	push(
		"damagePerMin",
		me.totalDamageDealtToChampions / durMin,
		"high",
		`${me.totalDamageDealtToChampions} damage to champions over ${round(durMin, 1)} minutes. This one swings with how the game went, not with how you played.`
	)
	if (me.goldEarned > 0)
		push(
			"damagePerGold",
			me.totalDamageDealtToChampions / me.goldEarned,
			"high",
			`${me.totalDamageDealtToChampions} damage for ${me.goldEarned} gold earned — how much you converted your income into champion damage.`
		)
	push(
		"goldPerMin",
		me.goldEarned / durMin,
		"high",
		`${me.goldEarned} gold over ${round(durMin, 1)} minutes.`
	)
	push(
		"visionPerMin",
		me.visionScore / durMin,
		"high",
		`Vision score ${me.visionScore} over ${round(durMin, 1)} minutes. The timeline carries no ward events, so there is no per-ward timing behind this.`
	)

	/* ------------------------------------------------------- objectives */

	const elites = events.filter(e => e.type === "ELITE_MONSTER_KILL")
	let ourElites = 0
	let theirElites = 0
	let smitedByUser = 0
	const byType: Record<string, number> = {}
	for (const e of elites) {
		const k = e.killerId ?? 0
		if (k === 0) continue
		const kTeam: TeamId = k <= 5 ? 100 : 200
		if (kTeam === teamId) {
			ourElites++
			if (k === userId) {
				smitedByUser++
				const t = e.monsterType || "UNKNOWN"
				byType[t] = (byType[t] ?? 0) + 1
			}
		} else theirElites++
	}
	if (ourElites + theirElites > 0)
		push(
			"eliteControlPct",
			(ourElites / (ourElites + theirElites)) * 100,
			"high",
			`Your team took ${ourElites} of the ${ourElites + theirElites} dragons/barons/heralds/grubs killed this game. Counted from ELITE_MONSTER_KILL.killerId, which is the reliable field (the assist list on those events is corrupt and is ignored).`
		)
	if (elites.length > 0)
		push(
			"elitesSecuredByUser",
			smitedByUser,
			"high",
			`You personally landed the killing blow on ${smitedByUser} elite objective${smitedByUser === 1 ? "" : "s"}${
				Object.keys(byType).length ?
					` (${Object.entries(byType)
							.map(([t, n]) => `${n}x ${t.toLowerCase().replace(/_/g, " ")}`)
							.join(", ")})`
				:	""
			}. Exact — this is the one objective field the API gets right.`
		)

	/* ------------------------------------------------------ positioning */

	const pos = positioning(frames, userId, teamId, allies, enemies)
	const sampleNote =
		pos.underSampled ?
			` Only ${pos.framesUsed} position samples in this game — treat this as an anecdote, not a measurement.`
		:	` From ${pos.framesUsed} once-per-minute position samples.`
	if (pos.framesUsed > 0) {
		push(
			"ownHalfPct",
			pos.halfShare.own * 100,
			"medium",
			`You were in your own half in ${round(pos.halfShare.own * 100)}% of samples (neutral river band +/-900u excluded).${sampleNote}`
		)
		push(
			"neutralHalfPct",
			pos.halfShare.neutral * 100,
			"medium",
			`${round(pos.halfShare.neutral * 100)}% of samples were inside the +/-900u neutral band around the river.${sampleNote}`
		)
		push(
			"enemyHalfPct",
			pos.halfShare.enemy * 100,
			"medium",
			`${round(pos.halfShare.enemy * 100)}% of samples were in the enemy half.${sampleNote} Note: across 22 games this correlates strongly with winning, but that is almost entirely because winning teams get to push in. It is a symptom, not a lever.`
		)
		push(
			"medianCentroidDist",
			pos.medianCentroidDist,
			"medium",
			`Median ${round(pos.medianCentroidDist)} units from the centre of your four teammates.${sampleNote}`
		)
		push(
			"medianNearestAlly",
			pos.medianNearestAlly,
			"medium",
			`Median ${round(pos.medianNearestAlly)} units to your closest teammate.${sampleNote}`
		)
		push(
			"medOverExtension",
			pos.medOverExtension,
			"medium",
			`Over-extension index (distance to nearest ally / (distance to nearest enemy + 1500)), median ${round(pos.medOverExtension, 2)}.${sampleNote} It is an index, not a distance.`
		)
		push(
			"p90OverExtension",
			pos.p90OverExtension,
			"medium",
			`Your worst-tenth over-extension was ${round(pos.p90OverExtension, 2)}.${sampleNote} The p90 is what separates games; the median barely moves.`
		)
	}

	/* ------------------------------------------------------------ deaths */

	const myDeaths = events.filter(e => e.type === "CHAMPION_KILL" && e.victimId === userId)
	if (myDeaths.length > 0) {
		const handed = myDeaths.reduce(
			(a, e) => a + 300 + 150 * (e.assistingParticipantIds?.length ?? 0),
			0
		)
		push(
			"goldLostToDeaths",
			handed,
			"medium",
			`Roughly ${handed}g handed over across ${myDeaths.length} deaths, at 300g base + 150g per assisting enemy. The timeline carries no bounty field, so real shutdowns (up to +1000g) are invisible and this is a FLOOR.`
		)

		const swings: number[] = []
		for (const d of myDeaths) {
			const a = teamGoldAt(frames, [userId, ...allies], d.timestamp)
			const b = teamGoldAt(frames, [userId, ...allies], d.timestamp + 90_000)
			const ea = teamGoldAt(frames, enemies, d.timestamp)
			const eb = teamGoldAt(frames, enemies, d.timestamp + 90_000)
			if (a !== null && b !== null && ea !== null && eb !== null)
				swings.push(b - a - (eb - ea))
		}
		if (swings.length > 0)
			push(
				"goldSwingAfterDeath90s",
				mean(swings),
				"low",
				`Your team's gold lead moved ${round(mean(swings))}g on average in the 90 seconds after each of your ${swings.length} measurable deaths. Across 103 past deaths the average was -368g against a +51g baseline for a random window, i.e. about -418g of excess cost per death — but the per-death spread (sd ~1150g) means a ${swings.length}-death sample like this one is mostly noise.`
			)
	}

	/* ------------------------------------------------------------- shape */

	const out: Metric[] = []
	for (const m of raw) {
		const d = METRIC_DEFS[m.key] ?? def(m.key, m.key, "", null, "not-trendable")
		const { band, vsBaseline, suffix } = bandFor(d, m.value, baseline[m.key])
		out.push({
			key: m.key,
			label: d.label,
			value: round(m.value, d.dp ?? 2),
			unit: d.unit,
			band,
			vsBaseline: vsBaseline === null ? null : round(vsBaseline, d.dp ?? 2),
			confidence: m.confidence,
			explain: `${m.explain}${suffix}${d.note ? ` ${d.note}` : ""}`
		})
	}
	return out
}

/** Convenience: look one up without scanning. */
export const metricByKey = (metrics: Metric[], key: string): Metric | undefined =>
	metrics.find(m => m.key === key)

