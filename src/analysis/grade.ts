/**
 * A game's grade, computed — not judged.
 *
 * ## What it measures, and what it does not
 *
 * The grade compares this game against **the player's own recent form**, metric by metric. It is
 * not a skill rating, not a rank, and not a comparison to anyone else: this app has no data
 * about other players, so a number implying one would be invented. 50 means "an ordinary game
 * for you". 80 means "well above your own baseline". The UI has to say that out loud, because a
 * bare 0-100 reads like a leaderboard score.
 *
 * ## Why it is computed rather than asked for
 *
 * A model asked to "grade this out of 100" produces a number that looks precise and is not
 * reproducible — two runs over identical data disagree, and nothing can be checked. Every input
 * here is already in the digest, so the same game always grades the same, and a grade can be
 * explained by pointing at the metrics that moved it.
 *
 * ## Confounded metrics are excluded, and this is the important part
 *
 * `enemy_half_pct` correlates +0.69 with winning almost entirely because teams that are already
 * ahead push into the enemy half. Grading on it would mean the grade largely restates the
 * result — "you won, therefore you played well" — which is worthless as feedback and actively
 * misleading on a loss where the player was the reason it was close. Only metrics flagged as
 * levers count.
 *
 * PURE. No I/O, no clock, no randomness.
 */

import { clamp } from "./frames.ts"
import { METRIC_DEFS } from "./metrics.ts"
import type { Baseline } from "./index.ts"
import type { Metric } from "../shared/schema/domain.ts"

/** Below this many prior games a baseline is too thin to grade against. */
export const MIN_BASELINE_GAMES = 5
/** Below this many usable metrics the grade would swing on one or two numbers. */
export const MIN_METRICS = 6

/** z is clamped before averaging so one freak metric cannot dominate the whole grade. */
const Z_CLAMP = 3

export type Rank = "S+" | "S" | "A" | "B" | "C" | "D" | "E"

export interface GradeBreakdown {
	key: string
	label: string
	/** Signed so positive is always better, whatever the metric's direction. */
	z: number
}

export interface Grade {
	/** 0-100 against the player's OWN recent form. 50 is an ordinary game for them. */
	score: number
	rank: Rank
	/** How many metrics actually fed the score. */
	metricCount: number
	/** How many prior games the baseline covers. */
	baselineGames: number
	/** The three metrics that helped most and the three that hurt most. */
	best: GradeBreakdown[]
	worst: GradeBreakdown[]
}


/**
 * Logistic rather than linear, so the extremes compress.
 *
 * A linear map makes one outstanding metric worth as much at the top of the range as in the
 * middle, and a single blowout game then pins the grade at 100 with nowhere left to go. The
 * curve keeps the middle sensitive, which is where almost every game actually sits.
 */
export const scoreFromZ = (meanZ: number): number =>
	Math.round(100 / (1 + Math.exp(-1.15 * clamp(meanZ, -Z_CLAMP, Z_CLAMP))))

export const rankFor = (score: number): Rank =>
	score >= 90 ? "S+"
	: score >= 80 ? "S"
	: score >= 70 ? "A"
	: score >= 58 ? "B"
	: score >= 44 ? "C"
	: score >= 30 ? "D"
	: "E"

/**
 * `null` when the corpus is too thin or too few metrics are scoreable — a grade off two games
 * of history is noise wearing a number, and showing it would be worse than showing nothing.
 */
export const gradeGame = (
	metrics: readonly Metric[],
	baseline: Baseline | undefined
): Grade | null => {
	if (!baseline) return null

	const parts: GradeBreakdown[] = []
	let baselineGames = 0

	for (const metric of metrics) {
		const def = METRIC_DEFS[metric.key]
		// Descriptive metrics have no better direction; confounded ones mostly restate the
		// result. Neither belongs in a grade meant to say how well he PLAYED.
		if (!def || def.higherIsBetter === null || def.confounded) continue

		const stat = baseline[metric.key]
		if (!stat || stat.n < MIN_BASELINE_GAMES || !(stat.sd > 0)) continue

		baselineGames = Math.max(baselineGames, stat.n)
		const z = ((metric.value - stat.mean) / stat.sd) * (def.higherIsBetter ? 1 : -1)
		parts.push({ key: metric.key, label: metric.label, z: clamp(z, -Z_CLAMP, Z_CLAMP) })
	}

	if (parts.length < MIN_METRICS) return null

	const meanZ = parts.reduce((sum, p) => sum + p.z, 0) / parts.length
	const byZ = [...parts].sort((a, b) => b.z - a.z)

	return {
		score: scoreFromZ(meanZ),
		rank: rankFor(scoreFromZ(meanZ)),
		metricCount: parts.length,
		baselineGames,
		best: byZ.slice(0, 3),
		worst: byZ.slice(-3).reverse()
	}
}

/** Rolling mean of the most recent grades, newest first. `null` under three games. */
export const rollingAverage = (scores: readonly number[], window = 10): number | null => {
	const recent = scores.slice(0, window)
	if (recent.length < 3) return null
	return Math.round(recent.reduce((a, b) => a + b, 0) / recent.length)
}
