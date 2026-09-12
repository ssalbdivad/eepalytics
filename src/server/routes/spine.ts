/**
 * `GET /api/games/:gameId/spine` — the whole game as one shape.
 *
 * Its own route rather than more fields on `GET /api/games/:gameId`, because it is the only
 * thing in the app that decompresses and walks the timeline blob on a page load. The review
 * screen does not need it and should not pay for it; the debrief asks for it second, after the
 * band above has already drawn.
 *
 * Answers 200 with `available: false` and a sentence for a game whose blob was pruned or that
 * never had a timeline. A missing shape is an ordinary state of this screen, not an error —
 * the same reason `/api/live` answers 200 when no game is running.
 */

import { Hono } from "hono"
import { BLOB_TIMELINE, readBlob } from "../../db/blobs.ts"
import { getGame, getParticipants } from "../../db/queries.ts"
import { buildSpine } from "../../analysis/debrief.ts"
import { SpineResponse } from "../../shared/schema/api.ts"
import type { LcuTimeline } from "../../shared/schema/lcu.ts"
import { fail, intParam, notFound, send } from "../respond.ts"

export const createSpineRoute = (): Hono => {
	const app = new Hono()

	app.get("/games/:gameId/spine", c => {
		const gameId = intParam(c.req.param("gameId"))
		if (gameId === null) return fail(c, 400, "gameId must be an integer", "bad-game-id")

		const game = getGame(gameId)
		if (!game) return notFound(c, `game ${gameId}`)

		const timeline = readBlob<LcuTimeline>(gameId, BLOB_TIMELINE)
		const body = buildSpine({
			timeline,
			participants: getParticipants(gameId),
			gameDurationSec: game.gameDurationSec
		})

		return send(c, SpineResponse, body, `GET /api/games/${gameId}/spine`)
	})

	return app
}
