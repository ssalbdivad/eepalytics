/**
 * `GET /api/games` and `GET /api/games/:gameId`.
 *
 * The list view renders badges (has a review? how many moments? how much media?) without a
 * second round trip, so the counts are joined in here from the three count queries rather
 * than N+1'd per row.
 *
 * The detail view is deliberately one request: the review screen needs the game, the
 * scoreboard, the metrics, the moments, the review and the media all at once, and shipping
 * them separately would make the screen render in five janky stages.
 *
 * `timelineAvailable` is the honest switch. It is true only when the timeline blob is
 * genuinely on disk — not merely when the DB row claims it should be. Without it the
 * scoreboard and the review still render, but the minimap, the scrubber and every positional
 * metric must be hidden rather than faked.
 */

import { Hono } from "hono"
import { BLOB_TIMELINE, hasBlob } from "../../db/blobs.ts"
import {
	countGames,
	gameIdsWithReviews,
	getGame,
	getMetrics,
	getMoments,
	getParticipants,
	getReview,
	withMomentMedia,
	listGames,
	listMediaForGame,
	mediaCounts,
	momentCounts
} from "../../db/queries.ts"
import { GameDetailResponse, GameListResponse } from "../../shared/schema/api.ts"
import type { GameListItem } from "../../shared/schema/api.ts"
import { fail, intParam, intQuery, notFound, send } from "../respond.ts"

export const createGamesRoutes = (): Hono => {
	const app = new Hono()

	/** Newest first. Empty database => `{ games: [] }`, never a 500. */
	app.get("/games", c => {
		const limit = intQuery(c.req.query("limit"), 50, 1, 500)
		const offset = intQuery(c.req.query("offset"), 0, 0, 100_000)

		const rows = listGames(limit, offset)
		const reviewed = rows.length > 0 ? gameIdsWithReviews() : new Set<number>()
		const moments = rows.length > 0 ? momentCounts() : new Map<number, number>()
		const media = rows.length > 0 ? mediaCounts() : new Map<number, number>()

		const games: GameListItem[] = rows.map(g => ({
			...g,
			hasReview: reviewed.has(g.gameId),
			momentCount: moments.get(g.gameId) ?? 0,
			mediaCount: media.get(g.gameId) ?? 0
		}))

		return send(c, GameListResponse, { games }, "GET /api/games")
	})

	/** Count only — cheap enough to be its own route and it keeps the list page honest. */
	app.get("/games/count", c => c.json({ count: countGames() }))

	app.get("/games/:gameId", c => {
		const gameId = intParam(c.req.param("gameId"))
		if (gameId === null) return fail(c, 400, "gameId must be an integer", "bad-game-id")

		const game = getGame(gameId)
		if (!game) return notFound(c, `game ${gameId}`)

		const body = {
			game,
			participants: getParticipants(gameId),
			metrics: getMetrics(gameId),
			moments: getMoments(gameId),
			review: withMomentMedia(getReview(gameId)),
			media: listMediaForGame(gameId),
			// The row's own flag AND the blob actually being there. A pruned data dir must not
			// make the UI promise a minimap it cannot draw.
			timelineAvailable: game.hasTimeline && hasBlob(gameId, BLOB_TIMELINE)
		}

		return send(c, GameDetailResponse, body, `GET /api/games/${gameId}`)
	})

	return app
}
