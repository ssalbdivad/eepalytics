/**
 * audit-citations — re-run the citation and baseline checks over reviews already in the database.
 *
 * `parse.ts` runs these at review time, but a check is only worth having if you can point it at
 * everything already stored. This rebuilds each game's digest, reconstructs the allowlist the
 * coach was held to, and feeds the stored review back through `buildReview` — the same code path,
 * so the audit and the daemon can never disagree about what counts as a violation.
 *
 * Usage: node --experimental-strip-types scripts/audit-citations.ts [gameId ...]
 * Exits non-zero if any review has a serious warning. NODE ONLY.
 */

import {
	getGame,
	getMetrics,
	getMoments,
	getParticipants,
	getReview,
	listGames
} from "../src/db/queries.ts"
import { baselineFromRows, perGameMetrics } from "../src/analysis/index.ts"
import { loadCorpus, loadTimeline } from "../src/daemon/corpus.ts"
import { buildGameDigest } from "../src/daemon/digest.ts"
import { allowlistOf } from "../src/review/digest-contract.ts"
import { buildReview, seriousWarnings } from "../src/review/parse.ts"
import { ANALYSIS_VERSION } from "../src/shared/constants.ts"

const auditGame = (gameId: number) => {
	const game = getGame(gameId)
	const review = getReview(gameId)
	if (!game || !review || review.status !== "ok") return null
	if (game.analysisVersion < ANALYSIS_VERSION) return null

	const digest = buildGameDigest({
		game,
		participants: getParticipants(gameId),
		metrics: getMetrics(gameId),
		moments: getMoments(gameId),
		timeline: loadTimeline(gameId),
		baseline: baselineFromRows(perGameMetrics(loadCorpus(20, { excludeGameId: gameId }))),
		analysisVersion: ANALYSIS_VERSION
	})

	// Reshape the stored review back into the coach's own output shape.
	const rebuilt = buildReview({
		raw: {
			headline: review.headline,
			encouragement: review.encouragement,
			items: review.items.map(i => ({
				title: i.title,
				body: i.body,
				severity: i.severity,
				category: i.category,
				tSec: i.tSec,
				momentIds: i.momentIds,
				metricKeys: i.metricKeys
			})),
			goals: review.goals
		},
		kind: "game",
		gameId,
		model: review.model,
		promptHash: review.promptHash,
		allowed: allowlistOf(digest),
		durationSec: game.gameDurationSec
	})

	return { game, review, warnings: rebuilt.warnings, serious: seriousWarnings(rebuilt.warnings) }
}

const ids =
	process.argv.slice(2).length ?
		process.argv.slice(2).map(Number)
	:	listGames(40).map(g => g.gameId)

let reviewed = 0
let serious = 0
for (const id of ids) {
	const r = auditGame(id)
	if (!r) continue
	reviewed++
	serious += r.serious.length
	const flag = r.serious.length ? "FAIL" : " ok "
	console.log(
		`[${flag}] ${id} ${r.game.championName.padEnd(9)} ${r.review.items.length} items — ${
			r.serious.length
		} serious, ${r.warnings.length - r.serious.length} minor`
	)
	for (const w of r.serious) console.log(`        ${w.code}  item[${w.itemIndex}]  ${w.message}`)
}
console.log(`\n${reviewed} review(s) audited, ${serious} serious warning(s).`)
process.exit(serious ? 1 : 0)
