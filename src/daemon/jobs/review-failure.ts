/**
 * What the two review jobs do IDENTICALLY when a coaching call does not produce a usable
 * review.
 *
 * `review-game` and `review-trend` differ in almost everything — one digest builder, one
 * allowlist, one set of published events each — but they agree exactly on failure: write a
 * `failedReview` row so the UI can show what went wrong instead of an empty space, and, for
 * the one error code that is a configuration problem rather than a flaky call, defer instead
 * of retrying.
 *
 * That agreement was previously four copies of the same object literal and two copies of the
 * same defer window. The windows are the part worth protecting: 30 minutes for a missing
 * transport and 5 seconds for a cancellation are tuned numbers, and two copies of a tuned
 * number is one copy that will eventually be wrong.
 *
 * NODE ONLY.
 */

import { ANALYSIS_VERSION } from "../../shared/constants.ts"
import { insertReview } from "../../db/queries.ts"
import { failedReview } from "../../review/parse.ts"
import type { CoachMeta } from "../../review/claude.ts"
import type { JobOutcome } from "../context.ts"

export interface ReviewFailure {
	kind: "game" | "trend"
	gameId: number | null
	model: string
	promptHash: string
	/** The failing stage's own code and message, rendered as the stored `error` string. */
	code: string
	error: string
	meta?: CoachMeta
}

/** Persist a failed review so the screen can explain itself. */
export const recordFailedReview = (f: ReviewFailure): void => {
	insertReview(
		failedReview({
			kind: f.kind,
			gameId: f.gameId,
			model: f.model,
			promptHash: f.promptHash,
			error: `${f.code}: ${f.error}`,
			analysisVersion: ANALYSIS_VERSION,
			meta: f.meta
		})
	)
}

/**
 * The defer a `runCoach` error code earns, or `null` when the code is a real failure the
 * worker should see thrown.
 *
 * No `claude` CLI and no API key is a configuration problem, not a flaky call: retrying it
 * three times in a minute helps nobody.
 */
export const deferForCoachError = (code: string): JobOutcome | null =>
	code === "no-transport" ?
		{
			defer: {
				reason:
					"no way to reach Claude: neither an authenticated `claude` CLI nor ANTHROPIC_API_KEY",
				untilMs: Date.now() + 30 * 60_000
			}
		}
	: code === "aborted" ? { defer: { reason: "cancelled", untilMs: Date.now() + 5_000 } }
	: null
