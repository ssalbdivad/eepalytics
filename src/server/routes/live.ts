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
/**
 * A death with less than this left is not worth interrupting for.
 *
 * A judge pass over 27 spoken lines found eleven timers under ten seconds: by the time the
 * sentence is spoken and heard, the enemy is already walking back, so the information is spent
 * before it arrives. Twelve seconds is roughly "long enough to cross a camp and act on it".
 */
const DEATH_WORTH_SAYING_SEC = 12

/**
 * Deaths already announced this game. Bounded because a 45-minute game has maybe 60 of them.
 *
 * Cleared when a game ends — `buildLiveState` returns null with no game, and the next game's
 * respawn instants start from a fresh clock, so a stale entry could only collide by landing on
 * the same 2-second bucket for the same champion, which is harmless.
 */
const announcedDeaths = new Set<string>()

/**
 * Did the previous turn's list lead with a death?
 *
 * Deaths are the most frequent fact by a wide margin, so without alternating they dominate
 * everything else. This is the "never two of the same kind running" rule, made structural.
 */
let lastLedWithDeath = false

/** Praise-worthy events already mentioned, by the feed's own monotonic id. */
const announcedEvents = new Set<number>()

/** Riot's KillStreak counter, as words. */
const MULTI: Record<number, string> = {
	2: "double kill",
	3: "triple kill",
	4: "quadra kill",
	5: "PENTAKILL"
}

/** Four minutes of game clock between farm-pace mentions. */
const FARM_COOLDOWN_SEC = 180
let lastFarmAtSec = 0

/** Below this, unspent gold is not worth a sentence. */
const GOLD_FLOOR = 1200
/** How much more must accumulate before it is news again. */
const GOLD_STEP = 800
let lastGoldMentioned = 0

const buildUnseen = (
	data: LiveAllGameData,
	me: LivePlayer,
	nowSec: number,
	pace: { cs: number; expected: number; exact: boolean; source: string } | null
): string[] => {
	const out: string[] = []

	/*
	 * Farm against his own history, which is the one comparison here that is genuinely his and
	 * not a generic benchmark. Only when it is far enough off to matter: a coach announcing a
	 * four-camp difference every twenty seconds is noise, and the reading between checkpoints is
	 * interpolated, so a small gap is inside its own error bar.
	 */
	/*
	 * The farm gap is true for the whole game once it opens, so emitting it every turn made the
	 * coach recite a widening deficit — "57 camps behind", then 60, then 63, three turns running.
	 * That is nagging, and when the news is bad it is also just grinding someone down.
	 *
	 * Once, then not again for FARM_COOLDOWN_SEC of game clock. The prompt says as much in words;
	 * this is the part that makes it true.
	 */
	if (
		pace &&
		Math.abs(pace.cs - pace.expected) >= 12 &&
		(lastFarmAtSec === 0 || nowSec - lastFarmAtSec >= FARM_COOLDOWN_SEC)
	) {
		lastFarmAtSec = nowSec
		const behind = pace.expected - pace.cs
		out.push(
			behind > 0 ?
				`FARM: ${behind} camps behind his own pace (${pace.cs} vs his usual ${pace.expected})${pace.exact ? "" : " — interpolated, approximate"}`
			:	`FARM: ${-behind} camps AHEAD of his own pace (${pace.cs} vs his usual ${pace.expected})${pace.exact ? "" : " — interpolated, approximate"}`
		)
	}

	/*
	 * Enemies who are dead right now, longest first. This is the highest-value line the coach can
	 * say to a jungler: it is exact, it is invisible without opening the scoreboard, and it has a
	 * shelf life measured in the seconds it takes to walk somewhere.
	 */
	const deadEnemies = (data.allPlayers ?? [])
		.filter(p => p.team !== me.team && p.isDead && (p.respawnTimer ?? 0) >= DEATH_WORTH_SAYING_SEC)
		.sort((a, b) => (b.respawnTimer ?? 0) - (a.respawnTimer ?? 0))
	for (const p of deadEnemies) {
		/*
		 * Announce each death ONCE.
		 *
		 * Without this the same corpse is reported on every poll for its whole respawn, so at a
		 * 20s heartbeat a 30s death is news twice and a teamfight makes the coach recite a list.
		 * Measured over 37 turns, nearly every spoken line was "X is DEAD for Ns" — accurate,
		 * and exhausting.
		 *
		 * `respawnTimer` counts down, so nowSec + it is the death's respawn INSTANT, which is
		 * stable across polls and unique per death. Rounding to 2s absorbs poll jitter without
		 * merging two separate deaths of the same champion.
		 */
		const id = `${p.championName}@${Math.round((nowSec + (p.respawnTimer ?? 0)) / 2)}`
		if (announcedDeaths.has(id)) continue
		announcedDeaths.add(id)
		out.push(`${p.championName ?? "an enemy"} JUST died — down for ${Math.round(p.respawnTimer ?? 0)}s`)
	}

	/*
	 * Unspent gold, but only when it has actually changed.
	 *
	 * Gold above the threshold stays true for minutes, so emitting it on every glance made the
	 * coach a nag: measured over nine turns of one game it raised gold five times, and a coach
	 * repeating itself is one the player stops hearing. It is emitted the first time, and then
	 * only after a further GOLD_STEP has accumulated — which is roughly "you could buy something
	 * else now", i.e. the point at which it is news again.
	 *
	 * Module-level state is fine here: this is a single-user local daemon with one game at a
	 * time. It resets when gold drops, which is what a recall looks like.
	 */
	const gold = data.activePlayer?.currentGold
	if (gold !== undefined) {
		if (gold < GOLD_FLOOR) lastGoldMentioned = 0
		else if (lastGoldMentioned === 0 || gold - lastGoldMentioned >= GOLD_STEP) {
			out.push(`${Math.round(gold)}g sitting unspent`)
			lastGoldMentioned = gold
		}
	}

	const events = data.events?.Events ?? []

	/*
	 * Things he did well, straight off the event feed.
	 *
	 * Without these the coach had nothing warm that was also grounded, so it either stayed silent
	 * (48% of turns, measured) or reached for a compliment it could not support. A multi-kill, a
	 * stolen objective and a secured objective are all exact, all his, and all worth interrupting
	 * for — which is the definition this file uses for everything else.
	 *
	 * `EventID` is monotonic and unique, so announcing each once is exact rather than heuristic.
	 */
	const myName = me.riotId ?? me.summonerName ?? ""
	for (const e of events) {
		if (e.EventID === undefined || announcedEvents.has(e.EventID)) continue
		const mine = e.KillerName !== undefined && e.KillerName === myName
		if (!mine) continue
		let praise = ""
		if (e.EventName === "ChampionKill" && (e.KillStreak ?? 0) >= 2)
			praise = `HE just got a ${MULTI[e.KillStreak!] ?? `${e.KillStreak}-kill`}`
		else if (e.EventName === "DragonKill")
			praise = e.Stolen === "True" ? `HE STOLE the ${e.DragonType ?? ""} dragon`.trim() : "HE secured the dragon"
		else if (e.EventName === "BaronKill")
			praise = e.Stolen === "True" ? "HE STOLE Baron" : "HE secured Baron"
		else if (e.EventName === "HeraldKill") praise = "HE secured Herald"
		if (praise === "") continue
		announcedEvents.add(e.EventID)
		out.unshift(`${praise} — worth saying so`)
	}

	/*
	 * Elapsed time since the last objective take, as a fact. Late in a game the event list runs
	 * long, so scan from the end.
	 */
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

	/*
	 * Order and cap, rather than handing over everything and hoping.
	 *
	 * A judge pass found 40 of 55 spoken lines were respawn timers — including one that chose a
	 * fourth Morgana timer over an explicit "1393g sitting unspent" sitting next to it in the same
	 * list. The model takes the top item most of the time, so the ranking has to be here.
	 *
	 * Praise first because it is rare and time-critical; then the comparisons he cannot make
	 * himself; then ONE death, because deaths are frequent enough to crowd out everything else if
	 * they are all offered. If the previous turn led with a death, a death is not allowed to lead
	 * this one — that is the variety rule, enforced rather than requested.
	 */
	const praise = out.filter(t => t.startsWith("HE "))
	const farm = out.filter(t => t.startsWith("FARM:"))
	const money = out.filter(t => t.includes("unspent"))
	const deaths = out.filter(t => t.includes("JUST died"))
	const rest = out.filter(t => !praise.includes(t) && !farm.includes(t) && !money.includes(t) && !deaths.includes(t))

	const nonDeath = [...praise, ...farm, ...money, ...rest]
	const leadWithDeath = lastLedWithDeath === false && deaths.length > 0
	const ranked =
		praise.length > 0 ? [...praise, ...farm, ...money, ...deaths.slice(0, 1)]
		: leadWithDeath ? [...deaths.slice(0, 1), ...nonDeath]
		: [...nonDeath, ...deaths.slice(0, 1)]

	const finalList = ranked.slice(0, 3)
	if (finalList.length > 0) lastLedWithDeath = finalList[0]!.includes("JUST died")
	return finalList
}

const buildLiveState = (
	data: LiveAllGameData | null,
	me: ReturnType<typeof findMe>,
	gameTimeSec: number | null,
	baseline: ReturnType<typeof baselineFromRows> | null
): VisionState | null => {
	if (!data || !me || !me.championName) {
		// Between games: forget what was announced so the next game starts clean.
		announcedDeaths.clear()
		announcedEvents.clear()
		lastLedWithDeath = false
		lastGoldMentioned = 0
		lastFarmAtSec = 0
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
		unseen: buildUnseen(
			data,
			me,
			secs,
			baseline ?
				paceReading({
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
			:	null
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
