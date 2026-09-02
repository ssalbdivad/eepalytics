/**
 * `GET /api/trends?games=N` — the cross-game screen.
 *
 * The coaching half (`review`) is produced by the daemon and simply read back here. The
 * statistical half is computed on the fly from the stored per-game metrics, and it is the one
 * place in this app where the temptation to lie is strongest: a line through 10 noisy points
 * looks like insight and usually is not.
 *
 * So `trendable` is computed, not assumed, straight from `.research/analytics.md` §7:
 *
 *   - CV = sd/|mean| is the noise-to-level ratio measured over the user's real 22 games.
 *   - CV <= 0.25 at n >= 10 was measured to be stable (cs10, gpm, camps/min, centroid
 *     distance, over-extension, own-half %). Those get a trend line.
 *   - CV <= 0.55 needs n >= 20 before a block mean means anything (deaths/min, vision, deaths).
 *   - Opponent-delta metrics (gd10/csd10/xpd10/gd14) are NEVER trendable at this sample size.
 *     gd10 has sd 682 around a mean of -224: a +/-200g CI needs ~45 games. "Your gold diff at
 *     10 is trending down" over 10 games is noise essentially always.
 *   - Half-of-map occupancy correlates with winning at r ~ 0.69, and that is reverse
 *     causality — teams that are winning push into the enemy half. The note says so, because
 *     surfacing it as a lever tells the user to do exactly the wrong thing.
 *
 * When `trendable` is false the UI must render the points as a scatter with no trend line and
 * show `note` verbatim.
 */

import { Hono } from "hono"
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

/** Keys whose game-to-game noise swamps any slope at the sample sizes this app will ever see. */
const NEVER_TRENDABLE = /^(gd|csd|xpd|dpd)\d*$|diff|delta/i

/** Keys that move because you are winning, rather than the other way round. */
const REVERSE_CAUSAL = /half_pct|halfPct|enemyHalf|ownHalf/i

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

const verdict = (key: string, n: number, mu: number, sd: number): Verdict => {
	const cvText = Math.abs(mu) < 1e-9 ? "n/a" : round(sd / Math.abs(mu), 2).toString()

	if (n < 2)
		return {
			trendable: false,
			note: `n=${n} — one game is a data point, not a pattern.`
		}
	if (NEVER_TRENDABLE.test(key))
		return {
			trendable: false,
			note: `n=${n}, CV ${cvText} — opponent-delta metrics need roughly 45 games for a usable interval. No trend line at this sample size.`
		}

	const cv = Math.abs(mu) < 1e-9 ? Infinity : sd / Math.abs(mu)
	const causal =
		REVERSE_CAUSAL.test(key) ?
			" Note this one moves because you are winning, not the reverse — do not treat it as a lever."
		:	""

	if (n >= 10 && cv <= 0.25)
		return {
			trendable: true,
			note: `n=${n}, CV ${cvText} — stable enough that the block mean means something.${causal}`
		}
	if (n >= 20 && cv <= 0.55)
		return {
			trendable: true,
			note: `n=${n}, CV ${cvText} — trendable, but always read it with the interval.${causal}`
		}
	if (cv <= 0.25)
		return {
			trendable: false,
			note: `n=${n}, CV ${cvText} — steady, but needs 10 games before a trend line is honest. ${10 - n} to go.${causal}`
		}
	return {
		trendable: false,
		note: `n=${n}, CV ${cvText} — the game-to-game spread swamps any slope. Scatter only.${causal}`
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

	// metricSeries carries no label; the newest row for this key does.
	const newest = points[points.length - 1]
	const label = (newest && getMetric(newest.gameId, key)?.label) || key

	return { key, label, points, mean: round(mu), ci95, trendable, note }
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
