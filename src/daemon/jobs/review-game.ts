/**
 * `review-game` — run Coach Lillia over one game and store the result.
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

import { uncoachableReason } from "../../shared/coachable.ts"
import { ANALYSIS_VERSION, REVIEW_VERSION } from "../../shared/constants.ts"
import { Review, parseOrThrow } from "../../shared/schema/domain.ts"
import {
	getGame,
	getMetrics,
	getMoments,
	getParticipants,
	getReview,
	listMediaForGame,
	getSettings,
	insertReview,
	reviewExistsForPrompt,
	setGameReviewVersion
} from "../../db/queries.ts"
import { baselineFromRows, perGameMetrics } from "../../analysis/index.ts"
import { journalFramesForGame } from "../../db/journal-frames.ts"
import { buildGamePack, renderPack } from "../../review/pack.ts"
import {
	POSTGAME_MODEL,
	chooseFrames,
	postgameArmAvailable,
	runPostgameCoach
} from "../../review/postgame-call.ts"
import { buildReview, seriousWarnings } from "../../review/parse.ts"
import { gamePrompt } from "../../review/prompt.ts"
import { runCoach } from "../../review/claude.ts"
import { publish } from "../bus.ts"
import { BLOB_GAME_PACK, BLOB_REVIEW_DIGEST, writeBlob } from "../../db/blobs.ts"
import { loadCorpus, loadTimeline } from "../corpus.ts"
import { refreshChampionContextInBackground } from "../../knowledge/research.ts"
import { buildGameDigest } from "../digest.ts"
import { deferForCoachError, recordFailedReview } from "./review-failure.ts"
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
	const notCoachable = uncoachableReason(game)
	if (notCoachable !== null) return { note: `${notCoachable}; skipped` }

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
	const participants = getParticipants(gameId)
	const timeline = loadTimeline(gameId)

	/*
	 * THE PACK, and why it is built here rather than in its own job.
	 *
	 * It is a pure read of blobs already on disk — measured at 40 ms for a 28-minute game — so a
	 * separate job would add a queue hop, a lease and a failure mode to save nothing. What it buys
	 * is the one number the app has been getting wrong: the counterpart's CS, level and gold, off
	 * the post-game timeline where they are exact for all ten players, instead of the live feed's
	 * visibility counter that read 70 against a true 183 and produced both of the two items he
	 * graded false out of 37.
	 */
	const pack = buildGamePack({
		game,
		participants,
		timeline,
		frames: journalFramesForGame(gameId)
	})
	const packText = renderPack(pack)

	/*
	 * THE PICTURES. `chooseFrames` picks at decision moments out of the pack's own event list, so
	 * a frame and the sentence about it cannot drift apart.
	 *
	 * An empty list is the normal case — he screen-shares about one game in thirty — and it is
	 * not a failure: the review then goes out on the pack and the digest alone, and the prompt's
	 * "no replay frames, stay on the numbers" section stays switched on, which is exactly the
	 * honest posture for a game nobody watched.
	 */
	const chosen = chooseFrames(pack)

	/*
	 * The cheap arm, when this machine has a key for it.
	 *
	 * Measured on the identical frozen 16-frame bundle: flash 43 s, pro 129 s, sonnet 155 s,
	 * gpt-5 161 s, opus 330 s — and the five were indistinguishable on the blinded grading. The
	 * model is not a lever on quality and is a large one on how long he waits, so the default is
	 * the fast one and the slow path is the FALLBACK rather than the other way round.
	 *
	 * `runCoach` (the `claude` CLI) cannot carry an image at all, so a game with frames has only
	 * one transport that can use them.
	 */
	const useCheapArm = postgameArmAvailable()
	const model = useCheapArm ? POSTGAME_MODEL : settings.model

	const digest = buildGameDigest({
		game,
		participants,
		metrics,
		moments,
		timeline,
		baseline: baselineFromRows(perGameMetrics(corpus)),
		/*
		 * Frames now means JOURNAL frames — his own screen, recorded while he played — and not
		 * the replay screenshots this field was written for. Replay capture produced zero media in
		 * the app's entire history and its job is gone, so the old test was false for every game
		 * and every review carried the "nobody has watched this game" section even when sixteen
		 * pictures of it were about to be attached. The old test is kept beside the new one
		 * because a historical game may still have real replay screenshots on disk.
		 */
		hasFrames:
			chosen.length > 0 ||
			listMediaForGame(gameId).some(m => m.source === "replay" && m.kind === "screenshot"),
		analysisVersion: ANALYSIS_VERSION
	})

	const prompt = gamePrompt(digest, {
		intensity: settings.coachIntensity,
		model,
		pack: packText,
		// The pictures are not hashed; their identity is. Two runs that attached different frames
		// are different reviews, two that attached the same ones must not re-bill.
		frameKey: chosen.map(c => c.frame.id).join(",")
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
		existing.model === model
	) {
		setGameReviewVersion(gameId, REVIEW_VERSION)
		return { note: "already reviewed at this exact prompt" }
	}

	ctx.progress(
		`asking ${model} to review game ${gameId} (${Math.round(prompt.approxChars / 1000)}k chars, ${chosen.length} frame(s))`
	)

	const cli = () =>
		runCoach({
			system: prompt.system,
			user: prompt.user,
			model: settings.model,
			schema: prompt.schema,
			label: `review-game:${gameId}:job${ctx.job.id}`,
			signal: ctx.signal
		})

	/*
	 * One call, then one fallback, and the fallback is never silent.
	 *
	 * A provider outage must not cost him the debrief — the CLI path is authenticated against his
	 * own subscription and does not depend on a key file — but the arm that answered has to end up
	 * in the stored row, because the model is part of the prompt hash and a review attributed to
	 * the wrong one would be re-used for the wrong prompt forever.
	 */
	let result =
		useCheapArm ?
			await runPostgameCoach({
				system: prompt.system,
				user: prompt.user,
				frames: chosen,
				...(ctx.signal ? { signal: ctx.signal } : {})
			})
		:	await cli()
	let answeredBy = useCheapArm ? model : settings.model
	if (useCheapArm && !result.ok && result.code !== "aborted") {
		ctx.log.warn("the cheap arm failed; falling back to the CLI", {
			gameId,
			model,
			code: result.code,
			err: result.error
		})
		const retry = await cli()
		if (retry.ok) {
			result = retry
			answeredBy = settings.model
		}
	}

	/* Everything a stored failure row needs, whichever stage failed. */
	const failureId = {
		kind: "game",
		gameId,
		model: answeredBy,
		promptHash: prompt.promptHash
	} as const

	if (!result.ok) {
		recordFailedReview({ ...failureId, code: result.code, error: result.error, meta: result.meta })
		publish("error", { gameId, message: `coach failed: ${result.code}` }, gameId)
		const deferred = deferForCoachError(result.code)
		if (deferred) return deferred
		throw new Error(`${result.code}: ${result.error}`)
	}

	const built = buildReview({
		raw: result.data,
		kind: "game",
		gameId,
		model: answeredBy,
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
		recordFailedReview({ ...failureId, code: built.code, error: built.error, meta: result.meta })
		throw new Error(`unusable coach output (${built.code}): ${built.error}`)
	}

	// Validate against the shared schema before it reaches the database, even though the review
	// unit built it: one malformed row would break the review screen for good.
	const review = parseOrThrow(Review, built.value, `review for game ${gameId}`)
	insertReview(review)
	// Store the exact bytes the coach was given, and store them HERE — beside the review they
	// produced, only when a review was actually written.
	//
	// Writing it earlier looked equivalent and was not: the prompt-reuse check above can skip
	// the Claude call and keep the existing review, so an early write would pair today's digest
	// with an older review. Baselines move with the rolling window, so the audit would then
	// report figures the coach copied correctly as fabrications — which it did, six of them in
	// one review, before this was moved.
	writeBlob(gameId, BLOB_REVIEW_DIGEST, digest)
	// The pack goes beside it, with the frames that were actually attached named in it, so the
	// debrief screen can show the evidence without rebuilding anything.
	writeBlob(gameId, BLOB_GAME_PACK, {
		...pack,
		attachedFrames: chosen.map(c => ({
			id: c.frame.id,
			tSec: c.frame.tSec,
			clock: c.frame.clock,
			momentSec: c.momentSec,
			gapSec: c.gapSec,
			because: c.because
		}))
	})
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
