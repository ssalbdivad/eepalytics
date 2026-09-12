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

import { getGame, getReview, listGames } from "../src/db/queries.ts"
import { BLOB_REVIEW_DIGEST, readBlob } from "../src/db/blobs.ts"
import type { GameDigest } from "../src/review/digest-contract.ts"
import { allowlistOf } from "../src/review/digest-contract.ts"
import { buildReview, seriousWarnings } from "../src/review/parse.ts"
import { ANALYSIS_VERSION } from "../src/shared/constants.ts"

const auditGame = (gameId: number) => {
	const game = getGame(gameId)
	const review = getReview(gameId)
	if (!game || !review || review.status !== "ok") return null
	if (game.analysisVersion < ANALYSIS_VERSION) return null

	// The digest AS SENT, not a rebuild.
	//
	// Baselines are a rolling window over recent games. Rebuilding one now uses a window that
	// has moved since the review was written, so a figure the coach copied correctly at the time
	// reads as a violation today. That flaw made this script's aggregate count meaningless: a
	// run reporting 39 violations was measuring corpus drift, not the reviews.
	//
	// Reviews written before `review-digest` blobs existed have nothing to check against, and are
	// reported as unauditable rather than being judged against the wrong evidence.
	const digest = readBlob<GameDigest>(gameId, BLOB_REVIEW_DIGEST)
	if (digest === null) return { gameId, unauditable: true as const, game }

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
let unauditable = 0
for (const id of ids) {
	const r = auditGame(id)
	if (!r) continue
	if ("unauditable" in r) {
		unauditable++
		console.log(
			`[skip] ${id} ${r.game.championName.padEnd(9)} reviewed before the digest was stored — ` +
				`re-review it to make it auditable`
		)
		continue
	}
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
console.log(
	`\n${reviewed} review(s) audited, ${serious} serious warning(s)` +
		`${unauditable > 0 ? `, ${unauditable} skipped for want of a stored digest` : ""}.`
)
process.exit(serious ? 1 : 0)
