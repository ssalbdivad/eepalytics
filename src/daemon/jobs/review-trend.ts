/**
 * `review-trend` — the cross-game pass: goals and patterns over the recent window.
 *
 * The honesty rule the DAEMON enforces here, before any money is spent: a trend needs at
 * least three analysed games behind it, and the metric series handed to the coach carry their
 * own `trendable` flag and `ci95` so a noisy metric cannot be narrated as a direction. The
 * prompt hedges too, but the cheapest place to stop a fake trend is before the call.
 *
 * Prior feedback is included so the coach can follow up on what it already said rather than
 * repeating itself — "you are still doing the 8-minute thing" is worth more than a fresh
 * observation of the same fact.
 *
 * NODE ONLY.
 */

import { ANALYSIS_VERSION } from "../../shared/constants.ts"
import { Review, parseOrThrow } from "../../shared/schema/domain.ts"
import type { TrendSeries } from "../../shared/schema/domain.ts"
import {
	getSettings,
	insertReview,
	listGames,
	recentFeedbackItems,
	reviewExistsForPrompt
} from "../../db/queries.ts"
import { perGameMetrics, trendDetailsFromRows } from "../../analysis/index.ts"
import { buildReview, seriousWarnings } from "../../review/parse.ts"
import { trendPrompt } from "../../review/prompt.ts"
import { runCoach } from "../../review/claude.ts"
import { publish } from "../bus.ts"
import { loadCorpus } from "../corpus.ts"
import { buildTrendDigest } from "../digest.ts"
import { deferForCoachError, recordFailedReview } from "./review-failure.ts"
import type { JobContext, JobOutcome } from "../context.ts"

/** Fewer than this many analysed games and there is no trend to speak of. */
export const MIN_GAMES_FOR_TREND = 3

export const runTrendReviewJob = async (ctx: JobContext): Promise<JobOutcome> => {
	const settings = getSettings()
	const window = Math.max(MIN_GAMES_FOR_TREND, settings.gamesForTrends)
	const games = listGames(window).filter(g => g.analysisVersion >= ANALYSIS_VERSION)

	if (games.length < MIN_GAMES_FOR_TREND)
		return {
			defer: {
				reason: `only ${games.length} analysed game(s); a trend needs at least ${MIN_GAMES_FOR_TREND}`,
				untilMs: Date.now() + 10 * 60_000
			}
		}

	const corpus = loadCorpus(window, { requireTimeline: false })
	const rows = perGameMetrics(corpus)
	const details = trendDetailsFromRows(rows)
	// `TrendDetail` carries diagnostics the prompt does not render; keep the payload honest
	// and small by passing the `TrendSeries` fields only.
	const series: TrendSeries[] = details.map(d => ({
		key: d.key,
		label: d.label,
		points: d.points,
		mean: d.mean,
		ci95: d.ci95,
		trendable: d.trendable,
		// `trendable` licenses the LEVEL; only this licenses a direction (§7.3).
		slopeSignificant: d.slope === null ? null : d.slope.significant,
		slopePerGame: d.slope === null ? null : d.slope.perGame,
		note: d.note
	}))

	const digest = buildTrendDigest({
		games,
		series,
		priorFeedback: recentFeedbackItems(40).map(f => ({
			gameId: f.gameId,
			title: f.title,
			severity: f.severity,
			...(f.category ? { category: f.category } : {})
		})),
		analysisVersion: ANALYSIS_VERSION,
		notes: [
			`${series.filter(s => s.trendable).length} of ${series.length} metrics have enough games behind them to support a direction.`
		]
	})

	const prompt = trendPrompt(digest, {
		intensity: settings.coachIntensity,
		model: settings.model
	})

	if (reviewExistsForPrompt(null, prompt.promptHash))
		return { note: "the same window was already summarised; no call made" }

	ctx.progress(
		`asking ${settings.model} for trends across ${games.length} games ` +
			`(${series.filter(s => s.trendable).length} trendable metrics)`
	)

	const result = await runCoach({
		system: prompt.system,
		user: prompt.user,
		model: settings.model,
		schema: prompt.schema,
		label: `review-trend:job${ctx.job.id}`,
		signal: ctx.signal
	})

	/* Everything a stored failure row needs, whichever stage failed. */
	const failureId = {
		kind: "trend",
		gameId: null,
		model: settings.model,
		promptHash: prompt.promptHash
	} as const

	if (!result.ok) {
		recordFailedReview({ ...failureId, code: result.code, error: result.error, meta: result.meta })
		const deferred = deferForCoachError(result.code)
		if (deferred) return deferred
		throw new Error(`${result.code}: ${result.error}`)
	}

	const built = buildReview({
		raw: result.data,
		kind: "trend",
		gameId: null,
		model: settings.model,
		promptHash: prompt.promptHash,
		// A trend item cites metric SERIES, never a single game's moment ids.
		allowed: {
			momentIds: new Set<string>(),
			metricKeys: new Set(series.map(s => s.key)),
			// Trend series carry no per-metric baseline line, so there is nothing to police here.
			baselineByMetric: new Map<string, Set<string>>(),
			baselineFigures: new Set<string>()
		},
		analysisVersion: ANALYSIS_VERSION,
		meta: result.meta
	})

	if (!built.ok) {
		recordFailedReview({ ...failureId, code: built.code, error: built.error, meta: result.meta })
		throw new Error(`unusable coach output (${built.code}): ${built.error}`)
	}

	const review = parseOrThrow(Review, built.value, "trend review")
	insertReview(review)

	const loud = seriousWarnings(built.warnings)
	ctx.progress(`trend review ready: ${review.headline}`)
	publish("review", {
		gameId: null,
		reviewId: review.id,
		headline: review.headline,
		gameCount: games.length,
		goalCount: review.goals.length,
		warnings: loud.length
	})

	return {
		note: `${games.length} games, ${review.goals.length} goals, ${review.items.length} items`
	}
}

export default runTrendReviewJob
