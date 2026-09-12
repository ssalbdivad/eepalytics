/**
 * `GET /api/form` — how he is playing lately, and what to work on.
 *
 * Everything here is derived from data already stored: grades computed at analysis time, focus
 * areas aggregated from reviews already generated. No model call, so it is instant, free, and
 * returns the same answer every time it is asked — which matters for something the user checks
 * repeatedly and would notice drifting.
 */

import { Hono } from "hono"
import { getSettings, recentFeedbackItems, recentGrades } from "../../db/queries.ts"
import { rollingAverage } from "../../analysis/grade.ts"
import { focusAreas } from "../../analysis/focus.ts"
import { FormResponse } from "../../shared/schema/api.ts"
import { intQuery, send } from "../respond.ts"

export const createFormRoute = (): Hono => {
	const app = new Hono()

	app.get("/form", c => {
		const window = intQuery(c.req.query("games"), getSettings().gamesForTrends, 3, 200)
		// Two windows deep, so "rolling average" can be shown as movement rather than a bare
		// number. A grade with no direction is much less useful than a grade with one.
		const grades = recentGrades(window * 2)
		const recent = grades.slice(0, window).map(g => g.score)
		const previous = grades.slice(window, window * 2).map(g => g.score)

		const items = recentFeedbackItems(window * 8)
		const focus = focusAreas(items, 3)

		return send(
			c,
			FormResponse,
			{
				grades: grades.slice(0, window),
				rollingAverage: rollingAverage(recent, window),
				previousAverage: rollingAverage(previous, window),
				focus,
				windowGames: new Set(items.map(i => i.gameId)).size
			},
			"GET /api/form"
		)
	})

	return app
}
