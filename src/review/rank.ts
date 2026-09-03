/**
 * Ranking and filtering coaching items.
 *
 * ## Why the app ranks instead of the model
 *
 * Asking the model to "sort by importance" gives a different ordering every run and nothing to
 * check it against. The model is good at the three judgments — how much did this cost, is the
 * fix followable, am I sure — and bad at applying a stable weighting across them. So it supplies
 * the axes and this file does the arithmetic, which makes the order reproducible, tunable in one
 * place, and testable.
 *
 * ## The three axes
 *
 *   impact         what the play plausibly cost, grounded in a real figure from the digest.
 *                  NOT a win-rate delta: this data cannot support one, and a percentage that
 *                  looks derived but is guessed is exactly the fabrication the app exists to
 *                  prevent.
 *   actionability  a rule he can follow mid-game beats a correct observation he cannot act on.
 *   confidence     whether the read is solid enough to change behaviour over.
 *
 * ## Why confidence gates rather than just sorts
 *
 * A low-confidence "you misplayed this" is worse than useless — it teaches him to distrust the
 * whole review, and the one thing this app cannot afford is being confidently wrong. But
 * deleting it loses a real observation. So a shaky read is DEMOTED to `info`: still shown,
 * no longer an instruction. That also covers the genuine trade-off — a gank and two plates for
 * a drake is not a mistake, it is a decision with a cost, and it should read as one.
 */

import type { FeedbackItem, FeedbackSeverity } from "../shared/schema/domain.ts"

/** Ordinal weights. Impact leads: a small certain gain loses to a large likely one. */
const IMPACT = { high: 1.0, medium: 0.55, low: 0.2 } as const
const ACTIONABILITY = { high: 1.0, medium: 0.6, low: 0.25 } as const
const CONFIDENCE = { high: 1.0, medium: 0.7, low: 0.35 } as const

/**
 * Confidence MULTIPLIES rather than adds.
 *
 * A guess about something huge should not outrank a certainty about something moderate — that is
 * how a review ends up leading with its least reliable claim. Multiplying makes low confidence
 * scale the whole item down instead of docking it a fixed amount.
 */
export const scoreItem = (item: {
	impact: FeedbackItem["impact"]
	actionability: FeedbackItem["actionability"]
	confidence: FeedbackItem["confidence"]
}): number => {
	const merit = 0.65 * IMPACT[item.impact] + 0.35 * ACTIONABILITY[item.actionability]
	return Math.round(merit * CONFIDENCE[item.confidence] * 1000) / 1000
}

/** Below this, a critical item is not solid enough to be stated as a correction. */
export const DEMOTE_BELOW = 0.32

export interface RankedItem extends FeedbackItem {
	priority: number
}

/**
 * Score, demote and sort. Praise is never demoted — "keep doing this" carries no risk of
 * teaching a bad habit, and a low-confidence compliment is still a compliment.
 */
export const rankItems = <T extends Omit<FeedbackItem, "priority">>(
	items: readonly T[]
): (T & { priority: number; severity: FeedbackSeverity })[] =>
	items
		.map(item => {
			const priority = scoreItem(item)
			const isPraise = item.category === "praise" || item.severity === "info"
			const tooShaky = !isPraise && (item.confidence === "low" || priority < DEMOTE_BELOW)
			return {
				...item,
				priority,
				// Demoted, never deleted: the observation survives, the instruction does not.
				severity: tooShaky ? ("info" as FeedbackSeverity) : item.severity
			}
		})
		.sort((a, b) => {
			if (b.priority !== a.priority) return b.priority - a.priority
			// Stable, meaningful tiebreak: earlier in the game first, so a read top to bottom
			// follows the game rather than jumping around it.
			const at = a.tSec ?? Number.MAX_SAFE_INTEGER
			const bt = b.tSec ?? Number.MAX_SAFE_INTEGER
			return at - bt
		})

/** Human label for the badge. */
export const priorityBand = (priority: number): "top" | "worth-it" | "fyi" =>
	priority >= 0.62 ? "top" : priority >= DEMOTE_BELOW ? "worth-it" : "fyi"
