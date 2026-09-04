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
import { observeFrame } from "../../review/live-vision.ts"
import { renderState } from "../../review/live-vision.ts"
import { checkGeminiKey, geminiKey, mintGeminiToken, setGeminiKey } from "../../review/gemini-live.ts"
import type { VisionState, VisionStatePlayer } from "../../review/live-vision.ts"
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
 * The facts worth saying, computed here rather than inferred by the model.
 *
 * This is the same split the rest of the app uses: code derives the numbers, the model may only
 * choose one and phrase it. It exists because forcing a vision model to "be actionable" from a
 * screenshot is how you get confident nonsense — the fix is that it is not being asked to work
 * anything out. Every string below is read straight off `allgamedata`.
 *
 * Deliberately NOT computed: objective respawn timers. Dragon and Baron respawn windows are
 * patch-tunable, and a timer that is quietly thirty seconds wrong is worse than no timer at all,
 * so the elapsed time since the take is reported as the fact it is and the inference is left
 * alone.
 */
const buildUnseen = (data: LiveAllGameData, me: LivePlayer, nowSec: number): string[] => {
	const out: string[] = []

	/*
	 * Enemies who are dead right now, longest first. This is the highest-value line the coach can
	 * say to a jungler: it is exact, it is invisible without opening the scoreboard, and it has a
	 * shelf life measured in the seconds it takes to walk somewhere.
	 */
	const deadEnemies = (data.allPlayers ?? [])
		.filter(p => p.team !== me.team && p.isDead && (p.respawnTimer ?? 0) > 1)
		.sort((a, b) => (b.respawnTimer ?? 0) - (a.respawnTimer ?? 0))
	for (const p of deadEnemies)
		out.push(`${p.championName ?? "an enemy"} is DEAD for another ${Math.round(p.respawnTimer ?? 0)}s`)

	const gold = data.activePlayer?.currentGold
	if (gold !== undefined && gold >= 1200) out.push(`${Math.round(gold)}g sitting unspent`)

	/*
	 * Elapsed time since the last objective take, as a fact. Late in a game the event list runs
	 * long, so scan from the end.
	 */
	const events = data.events?.Events ?? []
	const lastOf = (name: string) => {
		for (let i = events.length - 1; i >= 0; i--) if (events[i]!.EventName === name) return events[i]
		return null
	}
	const drake = lastOf("DragonKill")
	if (drake?.EventTime !== undefined) {
		const ago = Math.max(0, Math.round(nowSec - drake.EventTime))
		out.push(`last drake (${drake.DragonType ?? "unknown"}) was taken ${Math.floor(ago / 60)}m${ago % 60}s ago`)
	}
	const baron = lastOf("BaronKill")
	if (baron?.EventTime !== undefined) {
		const ago = Math.max(0, Math.round(nowSec - baron.EventTime))
		out.push(`last Baron was taken ${Math.floor(ago / 60)}m${ago % 60}s ago`)
	}

	return out.slice(0, 6)
}

const buildLiveState = (
	data: LiveAllGameData | null,
	me: ReturnType<typeof findMe>,
	gameTimeSec: number | null
): VisionState | null => {
	if (!data || !me || !me.championName) return null
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
		unseen: buildUnseen(data, me, secs)
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
			/** Supplied by the overlay, which already polls for them. Saves an LCU round trip. */
			championName?: unknown
			gameTimeSec?: unknown
			/** A spoken question. Present only when the user actually asked something. */
			question?: unknown
		} | null

		const frame = typeof body?.frame === "string" ? body.frame : ""
		const b64 = frame.replace(/^data:image\/\w+;base64,/, "")
		if (b64 === "" || b64.length > 12_000_000)
			return fail(c, 400, "frame must be a base64 image under ~12MB", "bad-frame")

		/*
		 * The frame goes straight into the model message. It is never written to disk: these are
		 * screenshots of the user's whole screen, and the previous version's write-then-delete
		 * was both a privacy surface and a latency cost for no benefit.
		 */
		/*
		 * Context comes from the CALLER when it has it.
		 *
		 * This route used to re-read the live client and rebuild the focus list on every glance,
		 * which put an LCU round trip and a pile of SQL in front of a call whose entire value is
		 * being fast. The overlay already polls /api/live every few seconds and holds both the
		 * champion and the clock, so it can simply say what it knows. The LCU read stays as a
		 * fallback for callers that do not.
		 */
		/*
		 * The live client is read on EVERY glance now, and that is a deliberate reversal.
		 *
		 * It was skipped to save a round trip, on the theory that the overlay already knew the
		 * champion and the clock. But the model then had nothing but pixels, and pixels do not
		 * contain the roster: League's default HUD shows no champion list at all unless you are
		 * holding Tab. Asked who was on screen, it guessed — it named Gnar, who was not in the
		 * game, four times in seven minutes, and called a teammate a threat.
		 *
		 * `allgamedata` costs about 30ms against a call that takes 3000ms. Trading 1% of the
		 * latency for the difference between coaching and fiction is not a close decision.
		 */
		const handle = await lcu()
		const data = handle ? await handle.live.allGameData().catch(() => null) : null
		const me = data ? findMe(data) : null

		const championName =
			(typeof body?.championName === "string" ? body.championName : null) ?? me?.championName ?? null
		const gameTimeSec =
			(typeof body?.gameTimeSec === "number" ? body.gameTimeSec : null) ??
			data?.gameData?.gameTime ??
			null

		const state = buildLiveState(data, me, gameTimeSec)

		const focus = cachedFocus().map(f => f.fix).filter(f => f !== "")

		const result = await observeFrame({
			imageBase64: b64,
			mediaType: /^data:(image\/\w+);/.exec(frame)?.[1] ?? "image/jpeg",
			championName,
			gameTimeSec,
			focus,
			recent:
				Array.isArray(body?.recent) ?
					((body.recent as unknown[]).filter(r => typeof r === "string").slice(-4) as string[])
				:	[],
			question: typeof body?.question === "string" ? body.question.slice(0, 400) : null,
			state
		})

		return c.json({
			ok: result.ok,
			text: result.text,
			costUsd: result.costUsd,
			durationMs: result.durationMs,
			...(result.error ? { error: result.error } : {})
		})

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
		const state = buildLiveState(data, me, data?.gameData?.gameTime ?? null)
		if (!state) return c.json({ inGame: false, text: "" })
		const focus = cachedFocus().map(f => f.fix).filter(f => f !== "")
		return c.json({
			inGame: true,
			text: `${renderState(state)}${
				focus.length > 0 ? `\n\n### What he is working on\n\n${focus.map(f => `- ${f}`).join("\n")}` : ""
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
