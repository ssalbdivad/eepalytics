/**
 * `analysis-run` — turn one game's stored match + timeline into metrics, moments and a digest.
 *
 * `src/analysis/` is a pure function over JSON: no database, no files, no network. That split
 * is deliberate (it is the part that has to be *right*, so it has to be testable without a
 * League client), which makes this handler the I/O half of the pipeline:
 *
 *   read blobs -> assemble the corpus context -> analyzeGame() -> validate -> persist
 *
 * The corpus context is not optional garnish. Without a BASELINE every metric band is
 * meaningless (a "bad" cs@10 is only bad relative to this user's own history), and without
 * CORPUS DEATHS every death looks like a one-off instead of the fourth repetition of the same
 * mistake — which is the difference between a stat and a coaching point.
 *
 * The digest is written to a blob here rather than rebuilt at review time, so the exact bytes
 * the coach saw are recoverable later.
 *
 * NODE ONLY.
 */

import { ANALYSIS_VERSION } from "../../shared/constants.ts"
import { Metric, Moment, parseOrThrow } from "../../shared/schema/domain.ts"
import { BLOB_DIGEST, writeBlob } from "../../db/blobs.ts"
import {
	getGame,
	getParticipants,
	getSettings,
	kvGet,
	replaceMetrics,
	replaceMoments,
	setGameAnalysisVersion,
	setGameRole
} from "../../db/queries.ts"
import { analyzeGame, baselineFromRows, perGameMetrics } from "../../analysis/index.ts"
import { publish } from "../bus.ts"
import {
	championNameMap,
	corpusDeaths,
	forgetGame,
	loadCorpus,
	loadMatch,
	loadTimeline
} from "../corpus.ts"
import { enqueueGameReview, enqueueMediaGenerate, enqueueTrendReview } from "../queue.ts"
import { shouldRefreshTrend } from "../reconcile.ts"
import type { JobContext, JobOutcome } from "../context.ts"

const MetricList = Metric.array()
const MomentList = Moment.array()

export const runAnalysisJob = async (ctx: JobContext): Promise<JobOutcome> => {
	const gameId = ctx.job.gameId
	if (gameId === null) throw new Error("analysis-run requires a gameId")

	const game = getGame(gameId)
	if (!game)
		return {
			defer: {
				reason: "waiting for match-ingest to write the game row",
				untilMs: Date.now() + 30_000
			}
		}

	// Re-ingest may have replaced the blobs under a cached copy.
	forgetGame(gameId)
	const match = loadMatch(gameId)
	if (!match)
		return {
			defer: {
				reason: "no match blob stored yet",
				untilMs: Date.now() + 60_000
			}
		}
	const timeline = loadTimeline(gameId)
	if (!timeline)
		ctx.log.warn("no timeline; metrics will be end-of-game only", { gameId })

	const settings = getSettings()

	/* ---- corpus context: baseline + recurrence ---- */
	const corpus = loadCorpus(settings.gamesForTrends, { excludeGameId: gameId })
	const baselineRows = perGameMetrics(corpus)
	const baseline = baselineFromRows(baselineRows)
	const deaths = corpusDeaths(corpus)
	ctx.progress(
		`analysing with a ${corpus.length}-game baseline and ${deaths.length} prior deaths`
	)

	const championNames = championNameMap(
		kvGet<Record<string, string>>("championNames", {})
	)
	const riotIds: Record<number, string> = {}
	for (const p of getParticipants(gameId)) if (p.riotId) riotIds[p.participantId] = p.riotId

	const result = analyzeGame({
		match,
		timeline,
		baseline,
		corpusDeaths: deaths,
		championNames,
		riotIds,
		momentLimit: settings.maxMomentsPerGame
	})

	if (!result)
		// `analyzeGame` returns null when the user is not in the match — a spectated game or a
		// mis-keyed puuid. Normal, not an error, and retrying will not change it.
		return { note: "the configured user is not a participant in this game; skipped" }

	/* ---- validate before writing: a malformed moment poisons the review screen, the
	        capture queue and the coaching prompt at once ---- */
	const metrics = parseOrThrow(MetricList, result.metrics, `metrics for ${gameId}`)
	const moments = parseOrThrow(MomentList, result.moments, `moments for ${gameId}`)
	const capped = [...moments]
		.sort((a, b) => b.severity - a.severity)
		.slice(0, settings.maxMomentsPerGame)

	replaceMetrics(gameId, metrics)
	replaceMoments(gameId, capped)

	// Role inference belongs to the analysis unit; ingest only ever wrote a Smite placeholder.
	const role = result.roles.roles[result.userId]
	const confidence = result.roles.confidence[result.userId]
	if (role) setGameRole(gameId, role, confidence ?? "low")

	// Keep the exact bytes the coach will see, so a review stays explainable months later.
	writeBlob(gameId, BLOB_DIGEST, result.digest)

	setGameAnalysisVersion(gameId, ANALYSIS_VERSION)

	ctx.progress(
		`analysed: ${metrics.length} metrics, ${capped.length} moments, role ${role ?? "UNKNOWN"}` +
			`${result.roles.wellFormed ? "" : " (role inference is shaky — see notes)"}`
	)
	publish(
		"game",
		{
			gameId,
			stage: "analyzed",
			metricCount: metrics.length,
			momentCount: capped.length,
			role: role ?? "UNKNOWN",
			rolesWellFormed: result.roles.wellFormed
		},
		gameId
	)

	/* ---- chain ---- */
	if (capped.length > 0) enqueueMediaGenerate(gameId)
	if (settings.autoReviewNewGames) {
		enqueueGameReview(gameId)
		if (shouldRefreshTrend(settings.gamesForTrends)) enqueueTrendReview()
	}

	return {
		note: `${metrics.length} metrics, ${capped.length} moments, ${deaths.length} corpus deaths`
	}
}

export default runAnalysisJob
