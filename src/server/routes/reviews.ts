/**
 * Review + capture triggers.
 *
 *   GET  /api/games/:gameId/review   -> Review | null   (convenience; the detail route has it too)
 *   POST /api/games/:gameId/review   -> JobAccepted      (re-run the coach on this game)
 *   POST /api/games/:gameId/capture  -> JobAccepted      (queue INTRUSIVE replay capture)
 *
 * Both POSTs only ever *enqueue*. Nothing here talks to Claude, launches a replay, or touches
 * the League client — every side effect belongs to `src/daemon`, behind the gate. `enqueue` is
 * deduplicated by a partial unique index on (kind, gameId), so double-clicking the button
 * returns the id of the job that is already live rather than starting a second Claude run.
 *
 * Capture is the one intrusive thing this app does, so the route refuses the cases that can
 * never work — an expired or pruned replay is gone forever and no amount of gating brings it
 * back — and lets the daemon's gate handle everything that is merely *not yet* possible.
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

	app.post("/games/:gameId/capture", c => {
		const gameId = intParam(c.req.param("gameId"))
		if (gameId === null) return fail(c, 400, "gameId must be an integer", "bad-game-id")

		const game = getGame(gameId)
		if (!game) return notFound(c, `game ${gameId}`)

		if (game.replayState === "expired")
			return fail(
				c,
				409,
				"that replay expired — Riot stops serving a .rofl about 30 minutes after the game ends",
				"replay-expired",
				"Nothing can recover it. Generated map images still work for every moment."
			)
		if (game.replayState === "pruned")
			return fail(
				c,
				409,
				"that replay was deleted under the retention policy",
				"replay-pruned",
				`Raise "keep replays for" in Settings to hold on to future ones longer.`
			)

		const jobId = enqueue({ kind: "replay-capture", gameId, intrusive: true })
		publish("job", { id: jobId, kind: "replay-capture", gameId, state: "queued" }, gameId)

		return send(c, JobAccepted, { jobId }, `POST /api/games/${gameId}/capture`, 202)
	})

	return app
}
