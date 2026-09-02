/**
 * `GET /api/trends?games=N` — the cross-game screen.
 *
 * The coaching half (`review`) is produced by the daemon and simply read back here. The
 * statistical half is computed on the fly from the stored per-game metrics, and it is the one
 * place in this app where the temptation to lie is strongest: a line through 10 noisy points
 * looks like insight and usually is not.
 *
 * So `trendable` is computed, not assumed — and it is computed from the SAME registry the
 * analysis layer and the coaching prompt use (`METRIC_DEFS` + `TIER_RULES`), never from a
 * second opinion living here.
 *
 * This route used to carry its own regex-based verdict (`/^(gd|csd|xpd|dpd)\d*$|diff|delta/i`
 * plus hard-coded CV cutoffs). It disagreed with the analysis layer on the user's real data:
 *
 *   - `ownHalfPct` (CV 0.237 over 20 games) came back `trendable: true` and got a trend line,
 *     even though `METRIC_DEFS` marks it `confounded` — it moves because you are winning, so
 *     a slope on it is reverse causality drawn in green. §7.4 is explicit that this is the
 *     one metric that must never be presented as a lever.
 *   - `firstBackMin` (CV 0.151) came back `trendable: true`, though it is quantised to whole
 *     minutes: a trend line on it reads noise off the quantiser, which is why the registry
 *     marks it not-trendable.
 *
 * Both are now decided by `METRIC_DEFS`, so the Trends screen and the sentence Claude is shown
 * can no longer disagree about whether a direction exists.
 *
 * The second, stricter gate is `slopeSignificant`: `trendable` says the LEVEL is stable enough
 * to quote, but §7.3 forbids claiming a direction unless the slope's own 95% CI excludes zero,
 * and a drawn trend line IS that claim. Measured on this user's live 20-game window, 18 series
 * are trendable and exactly 2 of them have a slope CI that excludes zero, so that distinction
 * is the whole ballgame.
 *
 * When `trendable` is false the UI must render the points as a scatter with no trend line and
 * show `note` verbatim.
 */

import { Hono } from "hono"
import { METRIC_DEFS } from "../../analysis/metrics.ts"
import { TIER_RULES, linearSlope } from "../../analysis/trends.ts"
import {
	countGames,
	getMetric,
	getSettings,
	getTrendReview,
	metricKeys,
	metricSeries
} from "../../db/queries.ts"
import { TrendsResponse } from "../../shared/schema/api.ts"
import type { TrendSeries } from "../../shared/schema/domain.ts"
import { intQuery, send } from "../respond.ts"

const mean = (xs: readonly number[]): number =>
	xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length

/** Sample standard deviation (n-1). Zero for n < 2 — one point has no spread to report. */
const stdev = (xs: readonly number[], mu: number): number => {
	if (xs.length < 2) return 0
	const ss = xs.reduce((a, x) => a + (x - mu) ** 2, 0)
	return Math.sqrt(ss / (xs.length - 1))
}

const round = (n: number, places = 3): number => {
	const f = 10 ** places
	return Math.round(n * f) / f
}

interface Verdict {
	trendable: boolean
	note: string
}

/**
 * The verdict, delegated to the metric registry. `tier` and `confounded` are the measured
 * priors from `.research/analytics.md` §7.2/§7.4; a lucky run of games can confirm them but
 * can never promote a metric above them.
 */
export const verdict = (key: string, n: number, mu: number, sd: number): Verdict => {
	const cvText = Math.abs(mu) < 1e-9 ? "n/a" : round(sd / Math.abs(mu), 2).toString()
	const d = METRIC_DEFS[key]
	const registryNote = d?.note ? ` ${d.note}` : ""

	if (n < 2)
		return {
			trendable: false,
			note: `n=${n} — one game is a data point, not a pattern.`
		}

	if (d?.tier === "not-trendable")
		return {
			trendable: false,
			note: `n=${n}, CV ${cvText} — measured as not trendable at any sample size this app will see. No trend line.${registryNote}`
		}

	if (d?.confounded)
		return {
			trendable: false,
			note: `n=${n}, CV ${cvText} — this is an OUTCOME, not a lever: it moves because of whether you were winning, so a slope on it is reverse causality. Scatter only, and never coached as an instruction.${registryNote}`
		}

	const cv = Math.abs(mu) < 1e-9 ? Infinity : sd / Math.abs(mu)
	const rule = TIER_RULES[d?.tier ?? "noisy"]

	if (n >= rule.minN && cv <= rule.maxCv)
		return {
			trendable: true,
			note: `n=${n}, CV ${cvText} — the LEVEL is stable enough to quote (needs n>=${rule.minN}, CV<=${rule.maxCv}). Always read it with the interval.${registryNote}`
		}
	if (n < rule.minN)
		return {
			trendable: false,
			note: `n=${n}, CV ${cvText} — needs ${rule.minN} games before a trend line is honest; ${rule.minN - n} to go.${registryNote}`
		}
	return {
		trendable: false,
		note: `n=${n}, CV ${cvText} — the game-to-game spread swamps any slope (ceiling ${rule.maxCv} for this metric). Scatter only.${registryNote}`
	}
}

const buildSeries = (key: string, limit: number): TrendSeries | null => {
	const points = metricSeries(key, limit)
	if (points.length === 0) return null

	const values = points.map(p => p.value)
	const mu = mean(values)
	const sd = stdev(values, mu)
	const n = values.length
	const { trendable, note } = verdict(key, n, mu, sd)

	// A 95% interval from fewer than 5 games is arithmetic, not evidence.
	const ci95 = n >= 5 ? round((1.96 * sd) / Math.sqrt(n)) : null

	/*
	 * `points` arrive newest-first; a slope against the index has to run in game order or its
	 * sign is inverted. Only computed when the level is trendable at all — there is no reading
	 * of a slope worth having on a series whose mean is already noise.
	 */
	const slope = trendable ? linearSlope([...values].reverse()) : null
	const direction =
		!trendable ? ""
		: slope === null ? " Too few games to fit a slope at all, so no direction is drawn."
		: slope.significant ?
			` The slope is ${slope.perGame > 0 ? "rising" : "falling"} by ${round(Math.abs(slope.perGame))} per game and its own 95% CI (${round(slope.ci95[0])} to ${round(slope.ci95[1])}) excludes zero, so a direction may be claimed.`
		:	` NO direction may be claimed: the slope's own 95% CI (${round(slope.ci95[0])} to ${round(slope.ci95[1])}) contains zero. Read the level, not the shape — no trend line is drawn.`

	// metricSeries carries no label; the newest row for this key does.
	const newest = points[points.length - 1]
	const label = (newest && getMetric(newest.gameId, key)?.label) || key

	return {
		key,
		label,
		points,
		mean: round(mu),
		ci95,
		trendable,
		slopeSignificant: slope === null ? null : slope.significant,
		slopePerGame: slope === null ? null : round(slope.perGame),
		note: note + direction
	}
}

export const createTrendsRoute = (): Hono => {
	const app = new Hono()

	app.get("/trends", c => {
		let windowSize = 20
		try {
			windowSize = getSettings().gamesForTrends
		} catch {
			/* empty database — the default window is fine */
		}
		const limit = intQuery(c.req.query("games"), windowSize, 3, 200)

		const series = metricKeys()
			.map(k => buildSeries(k, limit))
			.filter((s): s is TrendSeries => s !== null)
			// Trendable first, then widest sample, then alphabetical: the UI reads top-down.
			.sort(
				(a, b) =>
					Number(b.trendable) - Number(a.trendable) ||
					b.points.length - a.points.length ||
					a.key.localeCompare(b.key)
			)

		const covered = new Set<number>()
		for (const s of series) for (const p of s.points) covered.add(p.gameId)

		const body = {
			review: getTrendReview(),
			series,
			// Games actually behind these numbers — not how many games exist. On a fresh
			// install with games ingested but not yet analysed, that difference is the whole
			// explanation for an empty screen.
			gameCount: covered.size > 0 ? covered.size : Math.min(countGames(), limit),
			generatedMs: Date.now()
		}

		return send(c, TrendsResponse, body, "GET /api/trends")
	})

	return app
}
