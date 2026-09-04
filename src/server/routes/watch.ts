/**
 * `POST /api/games/:gameId/watch` — look at the captured frames for one moment.
 *
 *   GET  /api/games/:gameId/watch  -> { notes }
 *
 * ON DEMAND ONLY, and never automatic. The visual pass needs captured frames, capture takes
 * over the League client, and the user was clear that the game launching itself is the worst
 * thing this app can do. So nothing here queues a capture: it works with frames that already
 * exist and says plainly when there are none.
 *
 * Runs inline rather than through the queue for the same reason chat does — it touches Claude
 * and SQLite, not the League client, so the gate has nothing to protect here.
 */

import { Hono } from "hono"
import { dirname } from "node:path"
import {
	getGame,
	getMetrics,
	getMoments,
	getReview,
	listMediaForGame,
	listWatchNotes,
	upsertWatchNote
} from "../../db/queries.ts"
import { resolveDataPath } from "../../db/blobs.ts"
import { championNote } from "../../knowledge/index.ts"
import { watchMoment } from "../../review/watch.ts"
import { fail, intParam, notFound, send } from "../respond.ts"
import { WatchListResponse } from "../../shared/schema/api.ts"
import type { WatchNote } from "../../shared/schema/domain.ts"

export const createWatchRoutes = (): Hono => {
	const app = new Hono()

	app.get("/games/:gameId/watch", c => {
		const gameId = intParam(c.req.param("gameId"))
		if (gameId === null) return fail(c, 400, "gameId must be an integer", "bad-game-id")
		if (!getGame(gameId)) return notFound(c, `game ${gameId}`)
		return send(
			c,
			WatchListResponse,
			{ notes: listWatchNotes(gameId) },
			`GET /api/games/${gameId}/watch`
		)
	})

	app.post("/games/:gameId/watch", async c => {
		const gameId = intParam(c.req.param("gameId"))
		if (gameId === null) return fail(c, 400, "gameId must be an integer", "bad-game-id")
		const game = getGame(gameId)
		if (!game) return notFound(c, `game ${gameId}`)

		const body = (await c.req.json().catch(() => null)) as { momentId?: unknown } | null
		const momentId = typeof body?.momentId === "string" ? body.momentId : ""
		if (momentId === "") return fail(c, 400, "momentId is required", "bad-moment")

		const moment = getMoments(gameId).find(m => m.id === momentId)
		if (!moment) return notFound(c, `moment ${momentId}`)

		// Only REAL frames. A generated map diagram shows position, which the data review already
		// covers; it says nothing about execution, and feeding it to a visual pass would produce
		// confident prose about a picture that contains no new information.
		const frames = listMediaForGame(gameId)
			.filter(m => m.momentId === momentId && m.source === "replay" && m.kind === "screenshot")
			.sort((a, b) => a.tSec - b.tSec)

		if (frames.length === 0)
			return fail(
				c,
				409,
				"no replay frames captured for this moment yet — run a capture on this game first",
				"no-frames",
				"Capture takes over the League client, so it only runs when you ask for it and the client is idle."
			)

		const metrics = getMetrics(gameId)
		// Moments carry no metric keys, so attach the metrics the REVIEW cited for this moment —
		// that is the set a human would have had in front of them looking at these frames.
		const cited = new Set(
			(getReview(gameId)?.items ?? [])
				.filter(i => i.momentIds.includes(momentId))
				.flatMap(i => i.metricKeys)
		)
		const context = metrics
			.filter(m => cited.has(m.key))
			.map(m => `${m.label}: ${m.value}${m.unit}${m.baselineText ? ` (${m.baselineText})` : ""}`)

		const note = championNote(game.championName)
		const result = await watchMoment({
			championName: game.championName,
			role: game.role,
			moment,
			frames: frames.map(f => ({ path: resolveDataPath(f.path), tSec: f.tSec })),
			context,
			championNotes: note && !note.isDefault ? note.text : null,
			mediaDir: dirname(resolveDataPath(frames[0]!.path))
		})

		const stored: WatchNote = {
			id: `wn-${gameId}-${momentId}`,
			gameId,
			momentId,
			text: result.ok ? result.text : "",
			model: (process.env.EEPALYTICS_COACH_MODEL ?? process.env.CSK_COACH_MODEL) ?? "claude-sonnet-5",
			costUsd: result.costUsd ?? null,
			frameCount: frames.length,
			status: result.ok ? "ok" : "failed",
			error: result.error ?? null,
			createdMs: Date.now()
		}
		upsertWatchNote(stored)

		return c.json({ note: stored })
	})

	return app
}
