/**
 * kind -> handler registry.
 *
 * NODE ONLY.
 */

import type { JobKind } from "../../shared/schema/domain.ts"
import type { JobHandler } from "../context.ts"
import runAnalysisJob from "./analysis-run.ts"
import runMatchIngest from "./match-ingest.ts"
import runMediaGenerate from "./media-generate.ts"
import runReplayDownload from "./replay-download.ts"
import runGameReviewJob from "./review-game.ts"
import runTrendReviewJob from "./review-trend.ts"

export const HANDLERS: Record<JobKind, JobHandler> = {
	"match-ingest": runMatchIngest,
	"replay-download": runReplayDownload,
	"analysis-run": runAnalysisJob,
	"review-game": runGameReviewJob,
	"review-trend": runTrendReviewJob,
	"media-generate": runMediaGenerate
}

export const handlerFor = (kind: string): JobHandler | null =>
	HANDLERS[kind as JobKind] ?? null

export {
	runAnalysisJob,
	runGameReviewJob,
	runMatchIngest,
	runMediaGenerate,
	runReplayDownload,
	runTrendReviewJob
}
