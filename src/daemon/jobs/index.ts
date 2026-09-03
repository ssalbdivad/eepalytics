/**
 * kind -> handler registry.
 *
 * `replay-capture` is deliberately absent from the static imports: the capture unit owns
 * `jobs/replay-capture.ts`, and until it exists the daemon must still boot, ingest, analyse
 * and review. It is resolved lazily through `deps.loadCapture()`, and a capture job simply
 * defers (with the reason on the queue screen) while the module is missing.
 *
 * NODE ONLY.
 */

import type { JobKind } from "../../shared/schema/domain.ts"
import type { JobContext, JobHandler, JobOutcome } from "../context.ts"
import { loadCapture } from "../deps.ts"
import { canRunIntrusive } from "../gate.ts"
import { getGame, getSettings } from "../../db/queries.ts"
import { publish } from "../bus.ts"
import { roflPathFor } from "../lcu.ts"
import runAnalysisJob from "./analysis-run.ts"
import runMatchIngest from "./match-ingest.ts"
import runMediaGenerate from "./media-generate.ts"
import runReplayDownload from "./replay-download.ts"
import runGameReviewJob from "./review-game.ts"
import runTrendReviewJob from "./review-trend.ts"

/**
 * INTRUSIVE. Never reached unless `gate.ts` said yes; `workers.ts` is the only place that may
 * claim an intrusive job, and it asks first.
 *
 * The capture unit owns its own job row — it knows things about a half-finished capture (media
 * already produced, how far the client got) that the worker cannot see — so its result comes
 * back `selfManaged` and the worker records nothing further. It is also handed a live `gate`
 * so it can re-check mid-run, and the `signal` that `watchForAbort` fires on.
 */
const runReplayCapture = async (ctx: JobContext): Promise<JobOutcome> => {
	const capture = await loadCapture()
	if (!capture)
		return {
			defer: {
				reason: "the capture unit is not installed",
				untilMs: Date.now() + 10 * 60_000
			}
		}

	const result = await capture(ctx.job, {
		signal: ctx.signal,
		gate: {
			allowIntrusive: async (gameId: number) => {
				const game = getGame(gameId)
				// Exclude our own lease: this job IS the intrusive job holding the client.
				const verdict = await canRunIntrusive(
					getSettings(),
					game?.replayPath ?? roflPathFor(gameId, game?.platformId),
					ctx.job.id
				)
				return { allowed: verdict.ok, reason: verdict.reason }
			}
		},
		onProgress: p => {
			publish("capture", { gameId: ctx.job.gameId, ...p }, ctx.job.gameId)
		}
	})

	if (!result) return { selfManaged: false }
	return {
		selfManaged: true,
		note: `${result.note} (${result.mediaIds.length} media, ${result.failures} failed)`
	}
}

export const HANDLERS: Record<JobKind, JobHandler> = {
	"match-ingest": runMatchIngest,
	"replay-download": runReplayDownload,
	"analysis-run": runAnalysisJob,
	"review-game": runGameReviewJob,
	"review-trend": runTrendReviewJob,
	"replay-capture": runReplayCapture,
	"media-generate": runMediaGenerate
}

export const handlerFor = (kind: JobKind): JobHandler | null => HANDLERS[kind] ?? null

export {
	runAnalysisJob,
	runGameReviewJob,
	runMatchIngest,
	runMediaGenerate,
	runReplayCapture,
	runReplayDownload,
	runTrendReviewJob
}
