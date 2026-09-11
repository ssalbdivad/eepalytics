/**
 * The analysis unit's public surface, plus the one-call pipeline the daemon's `analysis-run`
 * job wants.
 *
 * Everything under `src/analysis/` is a pure function over match + timeline JSON: no I/O, no
 * database, no network. That is deliberate — it is the part of the app that has to be right,
 * so it has to be testable without a League client running.
 */

export * from "./frames.ts"
export * from "./roles.ts"
export * from "./metrics.ts"
export * from "./deaths.ts"
export * from "./moments.ts"
export * from "./trends.ts"

import { ANALYSIS_VERSION, USER_PUUID } from "../shared/constants.ts"
import type { LcuGame, LcuTimeline } from "../shared/schema/lcu.ts"
import type { Metric, Moment } from "../shared/schema/domain.ts"
import { analyzeDeaths, clusterDeaths, signatureCounts, type DeathAnalysis, type DeathPattern } from "./deaths.ts"
import { computeMetrics, type Baseline } from "./metrics.ts"
import { selectMomentsDetailed, type MomentDetail } from "./moments.ts"
import { findUser, inferRoles, type RoleInference } from "./roles.ts"

export interface AnalyzeGameInput {
	match: LcuGame
	timeline?: LcuTimeline | null
	/** The user's rolling baseline (`rollingBaseline`), for banding. Omit on a cold start. */
	baseline?: Baseline
	/**
	 * Deaths from every OTHER reviewed game, so a moment can be scored by how often its
	 * signature repeats. Without it every `recurrenceCount` is 1 and nothing is boosted.
	 */
	corpusDeaths?: DeathAnalysis[]
	puuid?: string
	momentLimit?: number
}

export interface AnalyzeGameResult {
	analysisVersion: number
	userId: number
	roles: RoleInference
	metrics: Metric[]
	deaths: DeathAnalysis[]
	patterns: DeathPattern[]
	momentDetails: MomentDetail[]
	moments: Moment[]
}

/**
 * Run the whole pipeline for one game.
 *
 * Returns `null` when the user is not in the match — that is a normal outcome (a spectated
 * game, a mis-keyed puuid), not an error, and the caller should skip rather than throw.
 */
export const analyzeGame = (input: AnalyzeGameInput): AnalyzeGameResult | null => {
	const { match, timeline, baseline, corpusDeaths = [] } = input
	const userId = findUser(match, input.puuid ?? USER_PUUID)
	if (userId === null) return null

	const roles = inferRoles(match, timeline)
	const metrics = computeMetrics(match, timeline, roles, userId, baseline ?? {})
	const deaths = analyzeDeaths(match, timeline, roles, userId)

	/*
	 * Recurrence is counted over the corpus INCLUDING this game — a signature that appears
	 * twice tonight is exactly the repetition worth a clip. Patterns, however, are mined over
	 * the corpus as given, so a single game on its own produces none (minSupport 6, 4 games).
	 */
	const allDeaths = [...corpusDeaths, ...deaths]
	const recurrence = signatureCounts(allDeaths)
	const patterns = clusterDeaths(allDeaths)

	const momentDetails = selectMomentsDetailed(
		match,
		timeline,
		roles,
		userId,
		metrics,
		deaths,
		{ recurrence, topN: input.momentLimit ?? 8 }
	)

	return {
		analysisVersion: ANALYSIS_VERSION,
		userId,
		roles,
		metrics,
		deaths,
		patterns,
		momentDetails,
		moments: momentDetails.map(d => d.moment)
	}
}
