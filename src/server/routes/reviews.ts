/**
 * Review triggers.
 *
 *   GET  /api/games/:gameId/review   -> Review | null   (convenience; the detail route has it too)
 *   POST /api/games/:gameId/review   -> JobAccepted      (re-run the coach on this game)
 *
 * The POST only ever *enqueues*. Nothing here talks to Claude or touches the League client —
 * every side effect belongs to `src/daemon`. `enqueue` is deduplicated by a partial unique index
 * on (kind, gameId), so double-clicking the button returns the id of the job that is already
 * live rather than starting a second Claude run.
 *
 * There used to be a `POST /games/:gameId/capture` here that queued an intrusive replay capture.
 * It is gone with the subsystem behind it; the frames now come from the screen-share journal.
 */

import { Hono } from "hono"
import {
	enqueue as dbEnqueue,
	getGame,
	getReview,
	withMomentMedia
} from "../../db/queries.ts"
import { ANALYSIS_VERSION } from "../../shared/constants.ts"
import { JobAccepted } from "../../shared/schema/api.ts"
import { Review } from "../../shared/schema/domain.ts"
import type { ServerDeps } from "../deps.ts"
import { publish } from "../events.ts"
import { fail, intParam, notFound, send } from "../respond.ts"

/** `Review | null`, as its own validator so the GET can be contract-checked like everything else. */
const ReviewOrNull = Review.or("null")

export const createReviewRoutes = (deps: ServerDeps): Hono => {
	const app = new Hono()
	const enqueue = deps.enqueue ?? dbEnqueue

	app.get("/games/:gameId/review", c => {
		const gameId = intParam(c.req.param("gameId"))
		if (gameId === null) return fail(c, 400, "gameId must be an integer", "bad-game-id")
		if (!getGame(gameId)) return notFound(c, `game ${gameId}`)
		return send(c, ReviewOrNull, withMomentMedia(getReview(gameId)), `GET /api/games/${gameId}/review`)
	})

	app.post("/games/:gameId/review", c => {
		const gameId = intParam(c.req.param("gameId"))
		if (gameId === null) return fail(c, 400, "gameId must be an integer", "bad-game-id")

		const game = getGame(gameId)
		if (!game) return notFound(c, `game ${gameId}`)

		// A review is only as good as the metrics it cites. If analysis is stale, queue that
		// first — the queue runs in priority order, so the coach sees fresh numbers.
		if (game.analysisVersion < ANALYSIS_VERSION)
			enqueue({ kind: "analysis-run", gameId })

		const jobId = enqueue({ kind: "review-game", gameId })
		publish("job", { id: jobId, kind: "review-game", gameId, state: "queued" }, gameId)

		return send(c, JobAccepted, { jobId }, `POST /api/games/${gameId}/review`, 202)
	})

	return app
}
