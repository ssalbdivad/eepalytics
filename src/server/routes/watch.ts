/**
 * `/api/games/:gameId/watch` — look at the recorded frames for one moment.
 *
 *   GET  /api/games/:gameId/watch  -> { notes }
 *   POST /api/games/:gameId/watch  -> { note }
 *
 * ON DEMAND ONLY, and never automatic: the model call costs money and takes about a minute, and
 * nobody wants either spent on a moment they were not asking about.
 *
 * THE FRAMES COME FROM THE JOURNAL — the screenshots the browser posts while the player shares
 * his screen. This route used to read `media` rows with `source = 'replay'`, which was replay
 * capture's output. That feature is deleted, and it never wrote one row in the app's whole
 * history, so this endpoint could only ever answer 409 — and the 409 told the user to "run a
 * capture on this game first", which is an instruction for a button that no longer exists.
 * The UI half was moved at the amputation and the route's was not; `WatchGamePanel`, which carried
 * it, has since gone with the ten-panel review screen. `pages/Debrief.tsx` is the caller now.
 *
 * Runs inline rather than through the queue for the same reason chat does — it touches Claude
 * and SQLite, not the League client.
 */

import { Hono } from "hono"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
	framesForGame,
	getGame,
	getMetrics,
	getMoments,
	getReview,
	listWatchNotes,
	upsertWatchNote
} from "../../db/queries.ts"
import { championBriefSync } from "../../knowledge/champion-brief.ts"
import { watchMoment } from "../../review/watch.ts"
import { fail, intParam, notFound, send } from "../respond.ts"
import { DATA_DIR, WATCH_FRAME_WINDOW_SEC } from "../../shared/constants.ts"
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

		/*
		 * Only REAL frames — his own screen, recorded while he played. A generated map diagram
		 * shows position, which the data review already covers; it says nothing about execution,
		 * and feeding it to a visual pass would produce confident prose about a picture that
		 * contains no new information.
		 *
		 * A window rather than an exact match, because a journal frame is stamped with the game
		 * clock it was taken at and lands where it lands — nothing aims it at a moment. Sorted by
		 * time because the prompt asks the model to read what CHANGED between them.
		 */
		const recorded = framesForGame(gameId)
			.filter(f => Math.abs(f.tSec - moment.tSec) <= WATCH_FRAME_WINDOW_SEC)
			.sort((a, b) => a.tSec - b.tSec)

		/*
		 * A ROW IS NOT A PICTURE, and the two come apart.
		 *
		 * `journal_frame.path` is stored absolute, and 356 rows in this database point into a
		 * directory that stopped existing when the app was renamed. Those rows are a true record
		 * that a frame was taken and a false promise that it can be looked at. Handing the model a
		 * path it cannot read would fail deep inside the CLI with a message about a missing file;
		 * checking here lets the refusal say which of the two things went wrong.
		 *
		 * The containment check is `media.ts`'s, for its reason: a stored path is not trusted to
		 * stay inside the data directory just because this app wrote it.
		 */
		const dataRoot = resolve(DATA_DIR)
		const frames = recorded
			.map(f => ({ path: resolve(f.path), tSec: f.tSec }))
			.filter(f => f.path.startsWith(`${dataRoot}/`) && existsSync(f.path))

		if (frames.length === 0)
			return fail(
				c,
				409,
				recorded.length === 0 ?
					`no recorded frames within ${WATCH_FRAME_WINDOW_SEC}s of this moment`
				:	`${recorded.length} frames were recorded around this moment, but the files are no longer on disk`,
				"no-frames",
				recorded.length === 0 ?
					"Frames come from the live coach's journal — share your screen while you play and the games after that one will have them."
				:	"Nothing can recover them. Later games recorded with the live coach open are unaffected."
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

		/*
		 * FETCHED, not prose. Same cutover as the digest and the live block: every line carries its
		 * own source. Edge-case notes are off — this call looks at a handful of frames of one
		 * moment, so what helps is the kit, not the wiki's interaction minutiae.
		 */
		const brief = championBriefSync(game.championName, { edgeCases: false })
		const result = await watchMoment({
			championName: game.championName,
			role: game.role,
			moment,
			// Already absolute and already checked to exist — see the containment check above.
			frames,
			context,
			championNotes: brief?.text ?? null,
			mediaDir: dirname(frames[0]!.path)
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
