/**
 * `review-game` — run Coach Skaffur over one game and store the result.
 *
 * `src/review/` owns the persona, the prompt template, the Claude call and the parser; all of
 * them are pure or near-pure. The daemon owns the I/O and the money:
 *
 *   read persisted metrics/moments -> digest -> promptHash -> (skip if we already paid) ->
 *   runCoach -> parse + enforce citations -> persist
 *
 * THE SKIP MATTERS. `promptHash` covers the persona text, the template version,
 * `REVIEW_VERSION`, the model and the digest, so an unchanged game with an unchanged prompt is
 * a guaranteed-identical review. Even a trivial Claude call costs ~14k cache-creation tokens;
 * a real one was measured at 120 s and $0.19. Re-opening a game must never re-bill.
 *
 * A run that fails still writes a row. `failedReview()` is filtered out of
 * `reviewExistsForPrompt` (it only counts `status = 'ok'`), so the UI can show the user what
 * went wrong instead of an empty space, and a fixed prompt retries cleanly.
 *
 * NODE ONLY.
 */

import { ANALYSIS_VERSION, REVIEW_VERSION } from "../../shared/constants.ts"
import { Review, parseOrThrow } from "../../shared/schema/domain.ts"
import {
	getGame,
	getMetrics,
	getMoments,
	getParticipants,
	getReview,
	getSettings,
	insertReview,
	reviewExistsForPrompt,
	setGameReviewVersion
} from "../../db/queries.ts"
import { baselineFromRows, perGameMetrics } from "../../analysis/index.ts"
import { buildReview, failedReview, seriousWarnings } from "../../review/parse.ts"
import { gamePrompt } from "../../review/prompt.ts"
import { runCoach } from "../../review/claude.ts"
import { publish } from "../bus.ts"
import { BLOB_REVIEW_DIGEST, writeBlob } from "../../db/blobs.ts"
import { loadCorpus, loadTimeline } from "../corpus.ts"
import { refreshChampionContextInBackground } from "../../knowledge/research.ts"
import { buildGameDigest } from "../digest.ts"
import { allowlistOf } from "../../review/digest-contract.ts"
import { enqueueMediaGenerate } from "../queue.ts"
import type { JobContext, JobOutcome } from "../context.ts"

export const runGameReviewJob = async (ctx: JobContext): Promise<JobOutcome> => {
	const gameId = ctx.job.gameId
	if (gameId === null) throw new Error("review-game requires a gameId")

	const game = getGame(gameId)
	if (!game)
		return {
			defer: {
				reason: "waiting for match-ingest to write the game row",
				untilMs: Date.now() + 30_000
			}
		}
	if (game.analysisVersion < ANALYSIS_VERSION)
		return {
			defer: {
				reason: "waiting for analysis-run to produce metrics and moments",
				untilMs: Date.now() + 60_000
			}
		}

	const settings = getSettings()
	const metrics = getMetrics(gameId)
	const moments = getMoments(gameId)
	if (metrics.length === 0)
		return {
			defer: {
				reason: "no metrics stored for this game; nothing to review honestly",
				untilMs: Date.now() + 5 * 60_000
			}
		}

	/* ---- champion context, at most once per champion per patch ---- */
	// NOT awaited. Research is web search plus a model call — minutes, not seconds — and a
	// review must not hold a queue worker on a network round trip, nor fail because a source
	// site was down. This review reads whatever notes are on disk; the refreshed ones are there
	// for the next one, so the notes converge within a single review of a patch bump.
	refreshChampionContextInBackground(game.championName)

	/* ---- the exact bytes the coach will see ---- */
	const corpus = loadCorpus(settings.gamesForTrends, { excludeGameId: gameId })
	const digest = buildGameDigest({
		game,
		participants: getParticipants(gameId),
		metrics,
		moments,
		timeline: loadTimeline(gameId),
		baseline: baselineFromRows(perGameMetrics(corpus)),
		analysisVersion: ANALYSIS_VERSION
	})

	// Keep the exact bytes the coach was given. A digest rebuilt later uses a rolling baseline
	// window that has since moved, so it is not evidence of what this review was held to.
	// `scripts/audit-citations.ts` reads this rather than rebuilding.
	writeBlob(gameId, BLOB_REVIEW_DIGEST, digest)

	const prompt = gamePrompt(digest, {
		intensity: settings.coachIntensity,
		model: settings.model
	})

	if (reviewExistsForPrompt(gameId, prompt.promptHash)) {
		setGameReviewVersion(gameId, REVIEW_VERSION)
		return { note: "an identical prompt was already reviewed; no call made" }
	}
	// A game reviewed at the current versions by the current model with the same analysis.
	const existing = getReview(gameId)
	if (
		existing &&
		existing.status !== "failed" &&
		existing.promptHash === prompt.promptHash &&
		existing.model === settings.model
	) {
		setGameReviewVersion(gameId, REVIEW_VERSION)
		return { note: "already reviewed at this exact prompt" }
	}

	ctx.progress(
		`asking ${settings.model} to review game ${gameId} (${Math.round(prompt.approxChars / 1000)}k chars)`
	)

	const result = await runCoach({
		system: prompt.system,
		user: prompt.user,
		model: settings.model,
		schema: prompt.schema,
		label: `review-game:${gameId}:job${ctx.job.id}`,
		signal: ctx.signal
	})

	if (!result.ok) {
		insertReview(
			failedReview({
				kind: "game",
				gameId,
				model: settings.model,
				promptHash: prompt.promptHash,
				error: `${result.code}: ${result.error}`,
				analysisVersion: ANALYSIS_VERSION,
				meta: result.meta
			})
		)
		publish("error", { gameId, message: `coach failed: ${result.code}` }, gameId)
		// No `claude` CLI and no API key is a configuration problem, not a flaky call: retrying
		// it three times in a minute helps nobody.
		if (result.code === "no-transport")
			return {
				defer: {
					reason:
						"no way to reach Claude: neither an authenticated `claude` CLI nor ANTHROPIC_API_KEY",
					untilMs: Date.now() + 30 * 60_000
				}
			}
		if (result.code === "aborted")
			return { defer: { reason: "cancelled", untilMs: Date.now() + 5_000 } }
		throw new Error(`${result.code}: ${result.error}`)
	}

	const built = buildReview({
		raw: result.data,
		kind: "game",
		gameId,
		model: settings.model,
		promptHash: prompt.promptHash,
		// Derived from the DIGEST, not the raw rows: the digest restated every baseline
		// from the live corpus, and the allowlist has to police the figures the coach was
		// actually shown.
		allowed: allowlistOf(digest),
		durationSec: game.gameDurationSec,
		analysisVersion: ANALYSIS_VERSION,
		meta: result.meta
	})

	if (!built.ok) {
		insertReview(
			failedReview({
				kind: "game",
				gameId,
				model: settings.model,
				promptHash: prompt.promptHash,
				error: `${built.code}: ${built.error}`,
				analysisVersion: ANALYSIS_VERSION,
				meta: result.meta
			})
		)
		throw new Error(`unusable coach output (${built.code}): ${built.error}`)
	}

	// Validate against the shared schema before it reaches the database, even though the review
	// unit built it: one malformed row would break the review screen for good.
	const review = parseOrThrow(Review, built.value, `review for game ${gameId}`)
	insertReview(review)
	setGameReviewVersion(gameId, REVIEW_VERSION)

	const loud = seriousWarnings(built.warnings)
	for (const w of loud)
		ctx.log.warn("coach output warning", { gameId, code: w.code, detail: w.message })

	ctx.progress(`review ready: ${review.headline}`)
	publish(
		"review",
		{
			gameId,
			reviewId: review.id,
			headline: review.headline,
			itemCount: review.items.length,
			costUsd: review.costUsd ?? null,
			warnings: loud.length
		},
		gameId
	)

	// Every cited moment needs a picture, and the generated map is the one that always exists.
	enqueueMediaGenerate(gameId)

	return {
		note:
			`${review.items.length} items, ${review.goals.length} goals` +
			`${review.costUsd === null || review.costUsd === undefined ? "" : `, $${review.costUsd.toFixed(4)}`}` +
			`${loud.length > 0 ? `, ${loud.length} citation warning(s)` : ""}`
	}
}

export default runGameReviewJob
