/**
 * kind -> handler registry.
 *
 * Every kind here is NON-INTRUSIVE: HTTP reads, the replay-download POST, analysis, Claude
 * reviews, SVG rendering. Nothing in this app launches the game client any more.
 *
 * `JobKind` still carries the retired `replay-capture` member so the job rows that kind left
 * behind keep parsing (see the union in `schema/domain.ts`). `handlerFor` answers `null` for it,
 * so a retried one is abandoned with a reason on the queue screen rather than sitting there.
 *
 * NODE ONLY.
 */

import type { JobKindConst } from "../../shared/constants.ts"
import type { JobKind } from "../../shared/schema/domain.ts"
import type { JobHandler } from "../context.ts"
import runAnalysisJob from "./analysis-run.ts"
import runMatchIngest from "./match-ingest.ts"
import runMediaGenerate from "./media-generate.ts"
import runReplayDownload from "./replay-download.ts"
import runGameReviewJob from "./review-game.ts"
import runTrendReviewJob from "./review-trend.ts"

export const HANDLERS: Record<JobKindConst, JobHandler> = {
	"match-ingest": runMatchIngest,
	"replay-download": runReplayDownload,
	"analysis-run": runAnalysisJob,
	"review-game": runGameReviewJob,
	"review-trend": runTrendReviewJob,
	"media-generate": runMediaGenerate
}

export const handlerFor = (kind: JobKind): JobHandler | null =>
	HANDLERS[kind as JobKindConst] ?? null

export {
	runAnalysisJob,
	runGameReviewJob,
	runMatchIngest,
	runMediaGenerate,
	runReplayDownload,
	runTrendReviewJob
}
