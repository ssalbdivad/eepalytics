/**
 * `GET /api/live` — coaching for the game happening right now.
 *
 * ## Read-only, always
 *
 * This reads the in-game Live Client Data API on :2999, which serves information already on the
 * player's own screen. Nothing is written, no input is sent, nothing is automated — the same
 * category as the overlays people already run. `src/daemon/gate.ts` guards WRITES to the client
 * and launching it; there is nothing here for it to protect.
 *
 * ## No model call
 *
 * An overlay refreshes every few seconds, and the useful things to say mid-game are arithmetic:
 * whether he is behind his own farm pace, when an objective he watched die is back, whether the
 * habit he is working on is happening again. `src/analysis/live-coach.ts` computes them, so this
 * is instant, free, and identical every tick — none of which a model call would be.
 *
 * ## Every state is a real state
 *
 * Client closed, in the lobby, in champ select, in a game with no data yet: each answers 200
 * with something truthful. An overlay that errors is an overlay that gets closed.
 */

import { Hono } from "hono"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { liveNudges, paceReading } from "../../analysis/live-coach.ts"
import type { LiveState } from "../../analysis/live-coach.ts"
import { baselineFromRows, perGameMetrics } from "../../analysis/index.ts"
import { focusAreas } from "../../analysis/focus.ts"
import { loadCorpus } from "../../daemon/corpus.ts"
import { lcu } from "../../daemon/lcu.ts"
import { getSettings, recentFeedbackItems } from "../../db/queries.ts"
import { LiveResponse } from "../../shared/schema/api.ts"
import type { LiveAllGameData } from "../../shared/schema/live.ts"
import { DATA_DIR, USER_PUUID } from "../../shared/constants.ts"
import { observeFrame } from "../../review/live-vision.ts"
import { fail, send } from "../respond.ts"

/** Event names that mark an objective take we can time a respawn from. */
const OBJECTIVE_EVENTS = new Set(["DragonKill", "BaronKill", "HeraldKill"])

/**
 * The user's own row in the live player list.
 *
 * The live API has no puuid, so this matches on Riot ID — which is why the fallback matters: on
 * a mismatch we return no player rather than coaching a stranger's stats.
 */
const findMe = (data: LiveAllGameData) => {
	const riotId = data.activePlayer?.riotId ?? data.activePlayer?.summonerName ?? ""
	if (riotId === "") return null
	return (
		data.allPlayers?.find(p => (p.riotId ?? p.summonerName ?? "") === riotId) ?? null
	)
}

export const createLiveRoute = (): Hono => {
	const app = new Hono()

	/**
	 * Focus areas, for the states where there is no game to report on.
	 *
	 * The idle overlay used to be a single line saying nothing was happening, which makes it
	 * worth closing. What you are working on is true whether or not a game is running, and it is
	 * clearly labelled as coming from past reviews rather than from anything live.
	 */
	const standingFocus = () => {
		const settings = getSettings()
		return focusAreas(recentFeedbackItems(settings.gamesForTrends * 8), 3).map(f => ({
			category: f.category,
			games: f.games,
			fix: f.fixes[0] ?? ""
		}))
	}

	app.get("/live", async c => {
		const handle = await lcu()
		if (!handle)
			return send(
				c,
				LiveResponse,
				{
					inGame: false,
					reason: "the League client is not running",
					nudges: [],
					focus: standingFocus()
				},
				"GET /api/live"
			)

		const data = await handle.live.allGameData().catch(() => null)
		if (!data?.gameData)
			return send(
				c,
				LiveResponse,
				{ inGame: false, reason: "no game in progress", nudges: [], focus: standingFocus() },
				"GET /api/live"
			)

		const me = findMe(data)
		const gameTimeSec = Math.round(data.gameData.gameTime ?? 0)
		if (!me)
			return send(
				c,
				LiveResponse,
				{
					inGame: true,
					reason: "in a game, but your player row could not be matched in the live data",
					gameTimeSec,
					nudges: []
				},
				"GET /api/live"
			)

		/*
		 * Respawn timers are only shown for objectives whose take we actually SAW in this
		 * game's event feed. The windows are fixed and public, so the arithmetic is a rule
		 * rather than a guess — but only once there is a real take to count from. Assuming one
		 * from the clock would be inventing a timer.
		 */
		const observed = { dragonSec: null as number | null, baronSec: null as number | null, heraldSec: null as number | null }
		for (const e of data.events?.Events ?? []) {
			if (!OBJECTIVE_EVENTS.has(e.EventName)) continue
			const at = Math.round(e.EventTime ?? 0)
			if (e.EventName === "DragonKill") observed.dragonSec = at
			if (e.EventName === "BaronKill") observed.baronSec = at
			if (e.EventName === "HeraldKill") observed.heraldSec = at
		}

		const live: LiveState = {
			gameTimeSec,
			championName: me.championName ?? "",
			cs: me.scores?.creepScore ?? 0,
			deaths: me.scores?.deaths ?? 0,
			kills: me.scores?.kills ?? 0,
			assists: me.scores?.assists ?? 0,
			level: me.level ?? 0,
			observed
		}

		const settings = getSettings()
		const baseline = baselineFromRows(perGameMetrics(loadCorpus(settings.gamesForTrends)))
		const focus = focusAreas(recentFeedbackItems(settings.gamesForTrends * 8), 3)

		return send(
			c,
			LiveResponse,
			{
				inGame: true,
				gameTimeSec,
				championName: live.championName,
				score: { kills: live.kills, deaths: live.deaths, assists: live.assists, cs: live.cs, level: live.level },
				nudges: liveNudges({ live, baseline, focus }),
				pace: paceReading({ live, baseline, focus }),
				// Always sent, so the overlay has something useful even in a quiet minute.
				focus: focus.map(f => ({ category: f.category, games: f.games, fix: f.fixes[0] ?? "" }))
			},
			"GET /api/live"
		)
	})

	/**
	 * `POST /api/live/observe` — one screen frame in, at most one sentence out.
	 *
	 * The frame arrives as a data URL from the renderer's screen capture, is written to a
	 * scratch file for the CLI to read, and is deleted immediately afterwards. Nothing is kept:
	 * these are screenshots of the user's whole screen, and an app that silently accumulates
	 * those on disk is doing something the user did not ask for.
	 */
	app.post("/live/observe", async c => {
		const body = (await c.req.json().catch(() => null)) as {
			frame?: unknown
			recent?: unknown
			/** A spoken question. Present only when the user actually asked something. */
			question?: unknown
		} | null

		const frame = typeof body?.frame === "string" ? body.frame : ""
		const b64 = frame.replace(/^data:image\/\w+;base64,/, "")
		if (b64 === "" || b64.length > 12_000_000)
			return fail(c, 400, "frame must be a base64 image under ~12MB", "bad-frame")

		const dir = join(DATA_DIR, "live-frames")
		await mkdir(dir, { recursive: true })
		const path = join(dir, `frame-${Date.now()}.png`)

		try {
			await writeFile(path, Buffer.from(b64, "base64"))

			const settings = getSettings()
			const focus = standingFocus().map(f => f.fix).filter(f => f !== "")
			// Best effort: the game may have ended between the capture and this call.
			const handle = await lcu()
			const data = handle ? await handle.live.allGameData().catch(() => null) : null
			const me = data ? findMe(data) : null

			const result = await observeFrame({
				framePath: path,
				dir,
				championName: me?.championName ?? null,
				gameTimeSec: data?.gameData?.gameTime ?? null,
				focus,
				recent: Array.isArray(body?.recent) ? (body.recent as unknown[]).filter(r => typeof r === "string").slice(-4) as string[] : [],
				question: typeof body?.question === "string" ? body.question.slice(0, 400) : null
			})

			return c.json({
				ok: result.ok,
				text: result.text,
				costUsd: result.costUsd,
				durationMs: result.durationMs,
				...(result.error ? { error: result.error } : {})
			})
		} finally {
			// Always, including on failure. See the route comment.
			await rm(path, { force: true }).catch(() => {})
		}
	})

	return app
}
