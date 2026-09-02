/**
 * Cross-game trends, and the honesty rules that keep them from lying.
 *
 * This file exists because the tempting version of this feature is a lie. Over 22 real games
 * of this user's, **every single opponent-delta metric's 95% CI contains zero**
 * (`.research/analytics.md` §3.3, §7). `gd10` has sd = 682 around a mean of -224: you would
 * need about 45 games for a +/-200g confidence interval, and 854g of true effect to detect a
 * change between two 10-game blocks. "Your gold diff at 10 is trending down" built on ten
 * games is noise, essentially always.
 *
 * So the rules here are hard, not advisory:
 *  1. Every series reports `n` and a 95% CI half-width.
 *  2. `trendable` is false — and the UI must draw NO trend line — whenever the sample cannot
 *     support one. `note` always says why, in words.
 *  3. The words "improving" and "declining" appear only when the slope's own CI excludes zero.
 *  4. Metrics that are mostly an EFFECT of winning (`enemyHalfPct`, `ownHalfPct`) are never
 *     presented as levers, however stable they look.
 *  5. Consecutive games are correlated (they are played back to back, often on a tilt streak),
 *     so every CI carries the caveat that it assumes independence and is therefore optimistic.
 */

import { USER_PUUID } from "../shared/constants.ts"
import type { LcuGame, LcuTimeline } from "../shared/schema/lcu.ts"
import type { Metric, TrendSeries } from "../shared/schema/domain.ts"
import { mean, round, stdev } from "./frames.ts"
import {
	computeMetrics,
	METRIC_DEFS,
	type Baseline,
	type BaselineStat,
	type MetricDef,
	type TrendTier
} from "./metrics.ts"
import { findUser, inferRoles } from "./roles.ts"

/* ================================================================= input */

export interface TrendGameInput {
	match: LcuGame
	timeline?: LcuTimeline | null
}

export interface TrendOptions {
	/** Whose games these are. Defaults to the configured user. */
	puuid?: string
	/** Use only the most recent N games. */
	limit?: number
}

/* ================================================== per-tier requirements */

/**
 * Sample requirements per stability tier, from the measured CV table in §7.2.
 * A metric can never be promoted above its measured prior by a lucky run of games.
 */
export const TIER_RULES: Record<TrendTier, { minN: number; maxCv: number }> = {
	stable: { minN: 10, maxCv: 0.3 },
	noisy: { minN: 20, maxCv: 0.6 },
	"not-trendable": { minN: Infinity, maxCv: 0 }
}

export type Reliability = "TRENDABLE" | "NOISY" | "NOT_TRENDABLE_AT_THIS_N"

/* ================================================================= stats */

/** 95% CI half-width of the mean, normal approximation. `null` for n < 3. */
export const ci95Half = (sd: number, n: number): number | null =>
	n < 3 ? null : (1.96 * sd) / Math.sqrt(n)

/** Games needed for a CI half-width of `halfWidth`, at this spread. */
export const gamesForPrecision = (sd: number, halfWidth: number): number =>
	halfWidth <= 0 ? Infinity : Math.ceil((1.96 * sd / halfWidth) ** 2)

/** Minimum detectable difference between two 10-game blocks at 80% power. */
export const mdd10v10 = (sd: number): number => 2.8 * sd * Math.sqrt(2 / 10)

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf). */
const normalCdf = (z: number): number => {
	const t = 1 / (1 + 0.2316419 * Math.abs(z))
	const d = 0.3989422804014327 * Math.exp(-z * z / 2)
	const p =
		d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
	return z > 0 ? 1 - p : p
}

/**
 * Two-sided 97.5% quantile of Student's t with `df` degrees of freedom, Cornish-Fisher
 * expansion around z = 1.95996 (Abramowitz & Stegun 26.7.5).
 *
 * The slope's standard error is ESTIMATED from the same residuals it is testing, so the
 * sampling distribution is t with n-2 df, not normal. At the sample sizes this app actually
 * sees that is not a rounding detail: with 20 games, df = 18, t = 2.101 against z = 1.960 —
 * a 95% interval built on z is 7% too narrow, and this number is the switch that decides
 * whether the app is allowed to say "rising" or "falling" at all. Erring narrow here means
 * claiming a direction that the data does not support, which is the one mistake §7.3 says
 * never to make.
 *
 * Accuracy against the published table: df=5 -> 2.5703 (exact 2.5706), df=10 -> 2.2281 (2.2281),
 * df=18 -> 2.1009 (2.1009), df=30 -> 2.0423 (2.0423). Worst case in the range this app uses is
 * df=3, 3.1786 vs 3.1824 — 0.1% narrow, far below the effect of the independence assumption.
 */
export const tCrit975 = (df: number): number => {
	if (df <= 0) return Infinity
	if (df === 1) return 12.7062
	if (df === 2) return 4.30265
	const z = 1.959963985
	const z2 = z * z
	const z3 = z2 * z
	const z5 = z3 * z2
	const z7 = z5 * z2
	const z9 = z7 * z2
	return (
		z +
		(z3 + z) / (4 * df) +
		(5 * z5 + 16 * z3 + 3 * z) / (96 * df * df) +
		(3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3) +
		(79 * z9 + 776 * z7 + 1482 * z5 - 1920 * z3 - 945 * z) / (92160 * df ** 4)
	)
}

export interface Slope {
	perGame: number
	ci95: [number, number]
	/**
	 * Two-sided p, from the normal approximation to the t statistic. Reported for context
	 * only — `significant` is decided by the t-based CI above, never by this.
	 */
	pValue: number
	/** True only when the CI excludes zero — the only case where direction may be claimed. */
	significant: boolean
}

/** Ordinary least squares of `values` against their index. `null` for n < 4. */
export const linearSlope = (values: number[]): Slope | null => {
	const n = values.length
	if (n < 4) return null
	const xs = values.map((_, i) => i)
	const mx = mean(xs)
	const my = mean(values)
	let sxx = 0
	let sxy = 0
	for (let i = 0; i < n; i++) {
		sxx += (xs[i]! - mx) ** 2
		sxy += (xs[i]! - mx) * (values[i]! - my)
	}
	if (sxx === 0) return null
	const b = sxy / sxx
	let sse = 0
	for (let i = 0; i < n; i++) sse += (values[i]! - (my + b * (xs[i]! - mx))) ** 2
	const se = Math.sqrt(sse / (n - 2) / sxx)
	if (!Number.isFinite(se) || se === 0)
		/*
		 * Zero residual variance. A noiseless rising line does genuinely exclude zero, but a
		 * PERFECTLY FLAT series also lands here with b = 0 — and the old code called that
		 * `significant: true`, i.e. reported a claimable direction on a line that does not
		 * move at all. Significance here is exactly "the slope is not zero".
		 */
		return { perGame: b, ci95: [b, b], pValue: b === 0 ? 1 : 0, significant: b !== 0 }
	const t = tCrit975(n - 2)
	const lo = b - t * se
	const hi = b + t * se
	return {
		perGame: b,
		ci95: [lo, hi],
		pValue: 2 * (1 - normalCdf(Math.abs(b / se))),
		significant: lo > 0 || hi < 0
	}
}

/** Pearson correlation. `NaN` when either series is constant. */
export const pearson = (xs: number[], ys: number[]): number => {
	const n = Math.min(xs.length, ys.length)
	if (n < 3) return NaN
	const mx = mean(xs.slice(0, n))
	const my = mean(ys.slice(0, n))
	let sxy = 0
	let sxx = 0
	let syy = 0
	for (let i = 0; i < n; i++) {
		const dx = xs[i]! - mx
		const dy = ys[i]! - my
		sxy += dx * dy
		sxx += dx * dx
		syy += dy * dy
	}
	return sxx === 0 || syy === 0 ? NaN : sxy / Math.sqrt(sxx * syy)
}

/* ============================================================== per-game */

export interface GameMetrics {
	gameId: number
	tMs: number
	win: boolean
	durationSec: number
	metrics: Metric[]
}

/** Run the analysis pipeline over a corpus once, so trends and baselines share the work. */
export const perGameMetrics = (
	games: TrendGameInput[],
	options: TrendOptions = {}
): GameMetrics[] => {
	const puuid = options.puuid ?? USER_PUUID
	const rows: GameMetrics[] = []
	for (const g of games) {
		const userId = findUser(g.match, puuid)
		if (userId === null) continue
		const roles = inferRoles(g.match, g.timeline)
		const stats = g.match.participants.find(p => p.participantId === userId)?.stats
		rows.push({
			gameId: g.match.gameId,
			tMs: g.match.gameCreation,
			win: stats?.win ?? false,
			durationSec: g.match.gameDuration,
			metrics: computeMetrics(g.match, g.timeline, roles, userId)
		})
	}
	rows.sort((a, b) => a.tMs - b.tMs)
	return options.limit ? rows.slice(-options.limit) : rows
}

/* ============================================================== baseline */

/**
 * The user's rolling history, keyed by metric. This is what `computeMetrics` bands against —
 * the user's own past, never an invented "pro benchmark".
 *
 * Pass only the games you want in the baseline. To band a game without letting it grade
 * itself, exclude it from the corpus you pass here.
 */
export const rollingBaseline = (
	games: TrendGameInput[],
	options: TrendOptions = {}
): Baseline => baselineFromRows(perGameMetrics(games, options))

/** Same, when you already have the per-game metrics. */
export const baselineFromRows = (rows: GameMetrics[]): Baseline => {
	const buckets = new Map<string, number[]>()
	for (const r of rows)
		for (const m of r.metrics) {
			const b = buckets.get(m.key)
			if (b) b.push(m.value)
			else buckets.set(m.key, [m.value])
		}
	const out: Baseline = {}
	for (const [key, values] of buckets) {
		const sorted = [...values].sort((a, b) => a - b)
		const mid = sorted.length >> 1
		const stat: BaselineStat = {
			key,
			n: values.length,
			mean: mean(values),
			sd: stdev(values),
			median:
				sorted.length % 2 === 1 ?
					sorted[mid]!
				:	(sorted[mid - 1]! + sorted[mid]!) / 2
		}
		out[key] = stat
	}
	return out
}

/* ================================================================ trends */

export interface TrendDetail extends TrendSeries {
	n: number
	sd: number
	cv: number
	reliability: Reliability
	tier: TrendTier
	/** `null` when there are too few games, or when the metric is not trendable at this n. */
	slope: Slope | null
	/** Minimum change a 10-vs-10 block comparison could detect at 80% power. */
	mdd10v10: number
	/** Games needed for a CI half-width of 10% of the mean. */
	gamesForTenPercent: number
	confounded: boolean
	unit: string
	higherIsBetter: boolean | null
}

const defOf = (key: string): MetricDef =>
	METRIC_DEFS[key] ?? {
		key,
		label: key,
		unit: "",
		higherIsBetter: null,
		tier: "noisy"
	}

const fmt = (n: number, dp: number): string => String(round(n, dp))

/**
 * Build one series per metric across the corpus, with the honesty verdict baked in.
 *
 * A caller rendering these must obey `trendable`: false means scatter, no line, and show the
 * `note`. Nothing here ever says "improving" unless the slope CI excludes zero.
 */
export const computeTrendDetails = (
	games: TrendGameInput[],
	options: TrendOptions = {}
): TrendDetail[] => trendDetailsFromRows(perGameMetrics(games, options))

export const trendDetailsFromRows = (rows: GameMetrics[]): TrendDetail[] => {
	const keys = new Set<string>()
	for (const r of rows) for (const m of r.metrics) keys.add(m.key)

	const out: TrendDetail[] = []
	for (const key of keys) {
		const d = defOf(key)
		const points: TrendSeries["points"] = []
		for (const r of rows) {
			const m = r.metrics.find(x => x.key === key)
			if (m) points.push({ gameId: r.gameId, tMs: r.tMs, value: m.value })
		}
		if (points.length === 0) continue
		const values = points.map(p => p.value)
		const n = values.length
		const mu = mean(values)
		const sd = stdev(values)
		const cv = mu === 0 ? Infinity : sd / Math.abs(mu)
		const ci = ci95Half(sd, n)
		const rule = TIER_RULES[d.tier]
		const dp = d.dp ?? 2

		const meetsSample = n >= rule.minN && cv <= rule.maxCv
		const reliability: Reliability =
			d.tier === "not-trendable" ? "NOT_TRENDABLE_AT_THIS_N"
			: meetsSample ? "TRENDABLE"
			: "NOISY"
		const trendable = reliability === "TRENDABLE" && !d.confounded
		const slope = trendable ? linearSlope(values) : null

		const parts: string[] = []
		parts.push(
			`${fmt(mu, dp)}${d.unit ? ` ${d.unit}` : ""} over ${n} game${n === 1 ? "" : "s"}${
				ci === null ? " (too few games for a confidence interval)" : ` (95% CI +/-${fmt(ci, dp)})`
			}.`
		)
		if (d.tier === "not-trendable")
			parts.push(
				`Not trendable at this sample size — the game-to-game spread (sd ${fmt(sd, dp)}) swamps any change worth talking about. Shown as a scatter with no trend line.`
			)
		else if (!meetsSample)
			parts.push(
				n < rule.minN ?
					`Needs at least ${rule.minN} games before a trend means anything; you have ${n}. Shown as a scatter with no trend line.`
				:	`Too noisy to trend: coefficient of variation ${fmt(cv, 2)} against a ceiling of ${rule.maxCv} for this metric. Shown as a scatter with no trend line.`
			)
		if (d.confounded)
			parts.push(
				`This is an OUTCOME, not a lever: it moves because of whether you were winning, so chasing it directly is backwards. Never coached as an instruction.`
			)
		if (slope)
			parts.push(
				slope.significant ?
					`${slope.perGame > 0 ? "Rising" : "Falling"} by ${fmt(Math.abs(slope.perGame), dp + 1)} per game (95% CI ${fmt(slope.ci95[0], dp + 1)} to ${fmt(slope.ci95[1], dp + 1)}), which excludes zero.`
				:	`No direction can be claimed: the slope's own 95% CI (${fmt(slope.ci95[0], dp + 1)} to ${fmt(slope.ci95[1], dp + 1)}) contains zero.`
			)
		if (n >= 4)
			parts.push(
				`A 10-vs-10 block comparison could only detect a change of ${fmt(mdd10v10(sd), dp)} or more.`
			)
		parts.push(
			`CI assumes the games are independent draws; these were played back to back, often in one session, so the real interval is wider than shown.`
		)
		if (d.note) parts.push(d.note)

		out.push({
			key,
			label: d.label,
			points,
			mean: round(mu, dp),
			ci95: ci === null ? null : round(ci, dp),
			trendable,
			note: parts.join(" "),
			n,
			sd: round(sd, dp),
			cv: round(cv, 3),
			reliability,
			tier: d.tier,
			slope,
			mdd10v10: round(mdd10v10(sd), dp),
			gamesForTenPercent:
				mu === 0 ? Infinity : gamesForPrecision(sd, Math.abs(mu) * 0.1),
			confounded: d.confounded ?? false,
			unit: d.unit,
			higherIsBetter: d.higherIsBetter
		})
	}

	/* Trendable first, then by how much signal there is relative to the noise. */
	return out.sort(
		(a, b) => Number(b.trendable) - Number(a.trendable) || a.cv - b.cv
	)
}

/** The API-shaped series. Same data, minus the diagnostics the UI does not render. */
export const computeTrends = (
	games: TrendGameInput[],
	n?: number,
	options: TrendOptions = {}
): TrendSeries[] =>
	computeTrendDetails(games, { ...options, limit: n ?? options.limit }).map(d => ({
		key: d.key,
		label: d.label,
		points: d.points,
		mean: d.mean,
		ci95: d.ci95,
		trendable: d.trendable,
		note: d.note
	}))

/* ================================================= win correlation trap */

export interface WinCorrelation {
	key: string
	label: string
	r: number
	pValue: number
	n: number
	/** Bonferroni threshold: 0.05 / (metrics tested). */
	threshold: number
	survivesCorrection: boolean
	confounded: boolean
	note: string
}

/**
 * Correlate each metric against win/loss — and immediately tell the truth about it.
 *
 * The research ran exactly this over 18 metrics and 22 games. Only ONE survived Bonferroni
 * correction (`enemy_half_pct`, r = +0.69) and it is the least actionable metric in the set,
 * because it is reverse causality: teams that are winning get to stand in the enemy half.
 * Meanwhile `cs10` at p = 0.03 "looks publishable and is not". Both lessons are encoded here:
 * the corrected threshold ships next to every r, and confounded metrics are flagged.
 */
export const metricWinCorrelations = (
	games: TrendGameInput[],
	options: TrendOptions = {}
): WinCorrelation[] => winCorrelationsFromRows(perGameMetrics(games, options))

export const winCorrelationsFromRows = (rows: GameMetrics[]): WinCorrelation[] => {
	const keys = new Set<string>()
	for (const r of rows) for (const m of r.metrics) keys.add(m.key)
	const tested = keys.size
	const threshold = tested === 0 ? 0.05 : 0.05 / tested

	const out: WinCorrelation[] = []
	for (const key of keys) {
		const d = defOf(key)
		const xs: number[] = []
		const ys: number[] = []
		for (const r of rows) {
			const m = r.metrics.find(x => x.key === key)
			if (!m) continue
			xs.push(m.value)
			ys.push(r.win ? 1 : 0)
		}
		if (xs.length < 5) continue
		const r = pearson(xs, ys)
		if (!Number.isFinite(r)) continue
		const n = xs.length
		const z = (r * Math.sqrt(n - 1))
		const p = 2 * (1 - normalCdf(Math.abs(z)))
		const survives = p < threshold
		/*
		 * Both halves of the note are always present. The correction verdict is what stops a
		 * p of 0.03 reading as a discovery; the causality warning is what stops the ONE metric
		 * that does survive from being turned into advice. Neither is optional.
		 */
		const correction =
			survives ?
				`Survives Bonferroni correction for the ${tested} metrics tested (threshold p < ${threshold.toExponential(1)}).`
			:	`Does NOT survive correction for the ${tested} metrics tested (threshold p < ${threshold.toExponential(1)}). An uncorrected p near 0.03 across this many metrics is expected by chance alone.`
		out.push({
			key,
			label: d.label,
			r: round(r, 3),
			pValue: p,
			n,
			threshold,
			survivesCorrection: survives,
			confounded: d.confounded ?? false,
			note:
				d.confounded ?
					`Correlates with winning, but backwards: this metric is a CONSEQUENCE of being ahead, not a cause of it. Never present it as something to do. ${correction}`
				:	correction
		})
	}
	return out.sort((a, b) => Math.abs(b.r) - Math.abs(a.r))
}
