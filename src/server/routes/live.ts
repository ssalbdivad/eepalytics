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
import { liveNudges, paceReading } from "../../analysis/live-coach.ts"
import type { LiveState } from "../../analysis/live-coach.ts"
import { baselineFromRows, perGameMetrics } from "../../analysis/index.ts"
import { focusAreas } from "../../analysis/focus.ts"
import { loadCorpus } from "../../daemon/corpus.ts"
import { lcu } from "../../daemon/lcu.ts"
import { getSettings, recentFeedbackItems } from "../../db/queries.ts"
import { LiveResponse } from "../../shared/schema/api.ts"
import type { LiveAllGameData, LivePlayer } from "../../shared/schema/live.ts"
import { USER_PUUID } from "../../shared/constants.ts"
import { renderState } from "../../shared/live-state.ts"
import { buildFacts, newFactMemory } from "../../analysis/live-facts.ts"
import {
	appendTranscript,
	checkGeminiKey,
	geminiKey,
	mintGeminiToken,
	readTranscript,
	setGeminiKey
} from "../../review/gemini-live.ts"
import type { VisionState, VisionStatePlayer } from "../../shared/live-state.ts"
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


/**
 * Turn one `allgamedata` read into the ground-truth block the coach is given.
 *
 * Returns null when there is no game, which is honest: the prompt then tells the model it has no
 * roster and must not name champions at all, rather than leaving it free to guess.
 */
/**
 * The facts, and the memory that keeps them from repeating.
 *
 * Both live in `analysis/live-facts.ts` — pure, tested, and shared with `scripts/eval-live.ts`.
 * They used to be inlined here and hand-copied into the eval with the tuning constants re-typed
 * as bare literals, which meant the eval was scoring a lookalike of the coach rather than the
 * coach. One definition, or the measurement is fiction.
 *
 * Module-level memory is right for this daemon: one local user, one game at a time. It is reset
 * whenever there is no game.
 */
const factMemory = newFactMemory()

/** Seconds since the most recent event of a kind, or null if it has not happened. */
const sinceEvent = (data: LiveAllGameData, name: string, nowSec: number): number | null => {
	const events = data.events?.Events ?? []
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i]!
		if (e.EventName === name && e.EventTime !== undefined)
			return Math.max(0, Math.round(nowSec - e.EventTime))
	}
	return null
}

const buildLiveState = (
	data: LiveAllGameData | null,
	me: ReturnType<typeof findMe>,
	gameTimeSec: number | null,
	baseline: ReturnType<typeof baselineFromRows> | null
): VisionState | null => {
	if (!data || !me || !me.championName) {
		// Between games: forget what was announced so the next game starts clean.
		// Between games: forget everything, so the next game starts clean.
		factMemory.announcedDeaths.clear()
		factMemory.announcedEvents.clear()
		factMemory.lastLedWithDeath = false
		factMemory.lastGoldMentioned = 0
		factMemory.lastFarmAtSec = 0
		return null
	}
	const secs = gameTimeSec ?? data.gameData?.gameTime ?? 0
	const clock = `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`
	const mine = me.team
	const asPlayer = (p: LivePlayer): VisionStatePlayer => ({
		champion: p.championName ?? "unknown",
		level: p.level,
		k: p.scores?.kills,
		d: p.scores?.deaths,
		a: p.scores?.assists,
		dead: p.isDead,
		respawnSec: p.respawnTimer
	})
	const others = (data.allPlayers ?? []).filter(p => p !== me)
	const stats = data.activePlayer?.championStats

	/*
	 * Only the last few events, newest last. The whole list runs to hundreds by late game, and
	 * the coach is being asked about *this* moment — older events are noise that crowd out the
	 * roster, which is the part that actually stops the hallucinating.
	 */
	const recentEvents = (data.events?.Events ?? [])
		.slice(-6)
		.map(e => {
			if (e.EventName === "DragonKill")
				return `${e.DragonType ?? ""} dragon taken by ${e.KillerName ?? "someone"}`.trim()
			if (e.EventName === "BaronKill") return `Baron taken by ${e.KillerName ?? "someone"}`
			if (e.EventName === "HeraldKill") return `Herald taken by ${e.KillerName ?? "someone"}`
			if (e.EventName === "TurretKilled") return `turret down (${e.TurretKilled ?? "?"})`
			if (e.EventName === "ChampionKill")
				return `${e.KillerName ?? "?"} killed ${e.VictimName ?? "?"}`
			return ""
		})
		.filter(t => t !== "")

	return {
		clock,
		me: {
			champion: me.championName,
			level: me.level,
			hp: stats?.currentHealth,
			maxHp: stats?.maxHealth,
			gold: data.activePlayer?.currentGold,
			k: me.scores?.kills,
			d: me.scores?.deaths,
			a: me.scores?.assists,
			cs: me.scores?.creepScore,
			dead: me.isDead,
			respawnSec: me.respawnTimer
		},
		allies: others.filter(p => p.team === mine).map(asPlayer),
		enemies: others.filter(p => p.team !== mine).map(asPlayer),
		recentEvents,
		unseen: buildFacts(
			{
				nowSec: secs,
				deadEnemies: others
					.filter(p => p.team !== mine && p.isDead && (p.respawnTimer ?? 0) > 0)
					.map(p => ({ champion: p.championName ?? "an enemy", respawnSec: p.respawnTimer ?? 0 })),
				currentGold: data.activePlayer?.currentGold ?? null,
				pace:
					baseline ?
						(() => {
							const r = paceReading({
								live: {
									gameTimeSec: secs,
									championName: me.championName ?? "",
									cs: me.scores?.creepScore ?? 0,
									deaths: me.scores?.deaths ?? 0,
									kills: me.scores?.kills ?? 0,
									assists: me.scores?.assists ?? 0,
									level: me.level ?? 0,
									observed: { dragonSec: null, baronSec: null, heraldSec: null }
								},
								baseline,
								focus: []
							})
							return r ? { cs: r.cs, expected: r.expected, exact: r.exact } : null
						})()
					:	null,
				myEvents: (data.events?.Events ?? [])
					.filter(e => e.KillerName !== undefined && e.KillerName === (me.riotId ?? me.summonerName ?? ""))
					.map(e => ({
						id: e.EventID,
						name: e.EventName,
						killStreak: e.KillStreak,
						dragonType: e.DragonType,
						stolen: e.Stolen === "True"
					})),
				sinceDrakeSec: sinceEvent(data, "DragonKill", secs),
				sinceBaronSec: sinceEvent(data, "BaronKill", secs)
			},
			factMemory
		)
	}
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

	/**
	 * Focus areas change when a review lands, not between two glances a few seconds apart, and
	 * rebuilding them means aggregating every recent feedback item. Cached for a minute so the
	 * observe path does no SQL at all in the common case.
	 */
	/**
	 * The player's own farm baseline, cached like the focus list.
	 *
	 * The live prompt names "farm against his own average" as a legitimate thing to criticise, and
	 * for its whole life nothing computed one — so the model was invited to make a comparison it
	 * had no number for, which is exactly how invented coaching starts. Rebuilding it means
	 * aggregating the whole corpus, far too slow for a per-glance call, and it changes only when a
	 * game finishes.
	 */
	let paceCache: { atMs: number; value: ReturnType<typeof baselineFromRows> } | null = null
	const cachedBaseline = () => {
		const now = Date.now()
		if (paceCache && now - paceCache.atMs < 60_000) return paceCache.value
		const value = baselineFromRows(perGameMetrics(loadCorpus(getSettings().gamesForTrends)))
		paceCache = { atMs: now, value }
		return value
	}

	let focusCache: { atMs: number; value: ReturnType<typeof standingFocus> } | null = null
	const cachedFocus = (): ReturnType<typeof standingFocus> => {
		const now = Date.now()
		if (focusCache && now - focusCache.atMs < 60_000) return focusCache.value
		const value = standingFocus()
		focusCache = { atMs: now, value }
		return value
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
	 * `GET /api/live/ground-truth` — the computed facts, as the text the coach is given.
	 *
	 * The Gemini path runs in the browser and talks to Google directly, so it cannot call
	 * `buildLiveState` itself. It polls this instead and forwards the block verbatim, which
	 * keeps exactly one definition of "what is true" for both coaching paths.
	 */
	app.get("/live/ground-truth", async c => {
		const handle = await lcu()
		const data = handle ? await handle.live.allGameData().catch(() => null) : null
		const me = data ? findMe(data) : null
		const state = buildLiveState(data, me, data?.gameData?.gameTime ?? null, cachedBaseline())
		if (!state) return c.json({ inGame: false, text: "" })
		const focus = cachedFocus().map(f => f.fix).filter(f => f !== "")
		/*
		 * The focus list is appended OUTSIDE the ground-truth block and labelled as coming from
		 * past reviews. Inside it, under a heading that says "these are FACTS", a criticism from
		 * a game three days ago reads as something happening right now — which is how a coach
		 * ends up telling someone to stop doing a thing they are not currently doing.
		 */
		return c.json({
			inGame: true,
			text: `${renderState(state)}${
				focus.length > 0 ?
					`\n\n## From his PAST reviews — not from this game\n\nThese are habits he is working on. Mention one only if THIS game's facts show it happening again.\n\n${focus
						.map(f => `- ${f}`)
						.join("\n")}`
				:	""
			}`
		})
	})

	/**
	 * `POST /api/live/gemini/token` — a one-session credential for the browser.
	 *
	 * The page cannot be given the API key: it would sit in a devtools network tab and in any
	 * screen recording of the app. So the daemon mints a token good for one connection and a
	 * few minutes, and the page connects to Google directly with that. This is Google's own
	 * client-to-server shape, and it is the reason the browser can hold the socket at all —
	 * proxying audio and video through this daemon would give back the second of latency the
	 * whole feature exists to remove.
	 */
	app.post("/live/gemini/token", async c => {
		const minted = await mintGeminiToken()
		if (!minted.ok) return c.json({ ok: false, error: minted.error }, 200)
		return c.json({ ok: true, ...minted.value })
	})

	/**
	 * `POST /api/live/gemini/transcript` — record what the live coach actually said.
	 *
	 * The Gemini path runs in the browser and talks to Google directly, which is what makes it
	 * fast and also what made it unauditable: the first real session produced advice the user
	 * called "dumb and overly critical" and there was no record of a single line of it. A coach
	 * that cannot be reviewed cannot be improved, so every line lands in a JSONL file that both
	 * the user and the next iteration can read.
	 */
	app.post("/live/gemini/transcript", async c => {
		const body = (await c.req.json().catch(() => null)) as {
			text?: unknown
			fromUser?: unknown
			gameTimeSec?: unknown
			groundTruth?: unknown
		} | null
		if (typeof body?.text !== "string" || body.text.trim() === "")
			return fail(c, 400, "text is required", "bad-line")
		appendTranscript({
			atMs: Date.now(),
			text: body.text.slice(0, 2000),
			fromUser: body.fromUser === true,
			gameTimeSec: typeof body.gameTimeSec === "number" ? body.gameTimeSec : null,
			...(typeof body.groundTruth === "string" && body.groundTruth !== "" ?
				{ groundTruth: body.groundTruth.slice(0, 8000) }
			:	{})
		})
		return c.json({ ok: true })
	})

	/** `GET /api/live/gemini/transcript` — the last N lines, newest first, for review. */
	app.get("/live/gemini/transcript", c =>
		c.json({ lines: readTranscript(Number(c.req.query("limit") ?? 200)) })
	)

	/**
	 * `PUT /api/live/gemini/key` — set or clear the key.
	 *
	 * Write-only on purpose. There is no GET that returns it; `status` reports whether one works
	 * and shows four characters at each end, which is enough to tell two keys apart and useless
	 * to anyone else.
	 */
	app.put("/live/gemini/key", async c => {
		const body = (await c.req.json().catch(() => null)) as { key?: unknown } | null
		if (typeof body?.key !== "string") return fail(c, 400, "key must be a string", "bad-key")
		if (body.key.length > 500) return fail(c, 400, "that is not an API key", "bad-key")
		setGeminiKey(body.key)
		const key = geminiKey()
		if (key === "") return c.json({ ok: true, configured: false })
		const checked = await checkGeminiKey(key)
		return c.json({
			ok: true,
			configured: true,
			works: checked.ok,
			error: checked.ok ? null : checked.error
		})
	})

	/** `GET /api/live/gemini/status` — is a key present, and does it work? For the settings UI. */
	app.get("/live/gemini/status", async c => {
		const key = geminiKey()
		if (key === "") return c.json({ configured: false, ok: false, error: "no key set" })
		const checked = await checkGeminiKey(key)
		return c.json({
			configured: true,
			ok: checked.ok,
			error: checked.ok ? null : checked.error,
			// Never the key. Enough to tell two keys apart when someone pastes the wrong one.
			hint: `${key.slice(0, 4)}…${key.slice(-4)}`
		})
	})

	return app
}
