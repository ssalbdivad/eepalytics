/**
 * `GET /api/habit?habit=<key>&games=<n>` — the habit tracker's rows.
 *
 * No model call. Everything here is counted off timelines already on disk, so it is instant,
 * free, and returns the same answer every time it is asked — which matters for a number he is
 * meant to check between games and would notice drifting.
 *
 * The route's whole job is the read. The cut, the interval, the streak and the sentence all come
 * from `analysis/habit.ts`, which is pure and which the UI also imports — so the screen and this
 * endpoint cannot disagree about what a clean game is.
 *
 * `games` defaults to 20 rather than to the trends window: the question is "how am I doing at
 * this lately", and the measurement behind the habit is a separate, fixed, 138-game one that
 * does not move with the window.
 */

import { Hono } from "hono"
import { habitDef } from "../../analysis/habit.ts"
import { loadHabitRecord } from "../../db/habit.ts"
import { HabitResponse } from "../../shared/schema/api.ts"
import { intQuery, send } from "../respond.ts"

/** Twenty games is about two evenings, which is the horizon he actually thinks in. */
export const DEFAULT_HABIT_WINDOW = 20

export const createHabitRoute = (): Hono => {
	const app = new Hono()

	app.get("/habit", c => {
		const window = intQuery(c.req.query("games"), DEFAULT_HABIT_WINDOW, 3, 200)
		// An unknown key resolves to the default rather than 400ing: a stale bookmark or an old
		// build asking for a habit this one dropped should show him the default habit, not an
		// error where the card goes.
		const def = habitDef(c.req.query("habit"))
		const record = loadHabitRecord(def, window)

		return send(
			c,
			HabitResponse,
			{
				key: record.key,
				games: record.games,
				counted: record.counted,
				rate: record.rate,
				streak: record.streak,
				change: record.change,
				baseRate: record.baseRate,
				head: record.head,
				verdict: record.verdict,
				note: record.note,
				windowGames: window,
				generatedMs: Date.now()
			},
			"GET /api/habit"
		)
	})

	return app
}
