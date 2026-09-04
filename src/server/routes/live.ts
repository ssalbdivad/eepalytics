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
 *
 * ## And "a game just ended" is one of them
 *
 * `justEnded` rides on the same payload rather than arriving on a stream of its own. The
 * overlay already polls this route, the daemon already wrote down which game finished, and a
 * poll is correct in the case that actually happens: he alt-tabs out of the client into a
 * window that was not open when the game ended, so there is no event it could have missed.
 * SSE would have been a second mechanism for a fact this route can simply state.
 */

import { Hono } from "hono"
import {
	BARON_RESPAWN_SEC,
	DRAGON_RESPAWN_SEC,
	HERALD_RESPAWN_SEC,
	liveNudges,
	paceReading
} from "../../analysis/live-coach.ts"
import type { LiveState } from "../../analysis/live-coach.ts"
import { baselineFromRows, perGameMetrics } from "../../analysis/index.ts"
import { focusAreas } from "../../analysis/focus.ts"
import { buildMatchupBrief } from "../../analysis/matchup.ts"
import { loadCorpus } from "../../daemon/corpus.ts"
import { championName, refreshChampionNames } from "../../daemon/champions.ts"
import { summonerSpellName, refreshSummonerSpellNames } from "../../daemon/spells.ts"
import { lcu } from "../../daemon/lcu.ts"
import { championNote, pronunciationTable } from "../../knowledge/index.ts"
import { pronunciationsFor } from "../../shared/pronounce.ts"
import { dragonPhrase } from "../../shared/dragons.ts"
import { getGame, getSettings, listGames, recentFeedbackItems } from "../../db/queries.ts"
import { dismissDebrief, dismissedDebrief, lastGameEnded } from "../../daemon/postgame.ts"
import { matchesMarker, postGameDebrief } from "../../shared/postgame.ts"
import { matchupPromptSection } from "../../shared/matchup-prompt.ts"
import type { EndedGame, JustEnded } from "../../shared/postgame.ts"
import { LiveResponse, MatchupResponse } from "../../shared/schema/api.ts"
import { isCoachingPhase } from "../../shared/schema/lcu.ts"
import type { LiveAllGameData, LivePlayer } from "../../shared/schema/live.ts"
import { QUEUE_NAMES, USER_PUUID } from "../../shared/constants.ts"
import { renderState } from "../../shared/live-state.ts"
import { openSessionStatus, writeFrame } from "../../daemon/journal.ts"
import { buildFacts, newFactMemory } from "../../analysis/live-facts.ts"
import { newFightMemory, readFight, resetFightMemory } from "../../analysis/fights.ts"
import {
	appendTranscript,
	checkGeminiKey,
	geminiKey,
	mintGeminiToken,
	readTranscript,
	setGeminiKey,
	transcriptLimit
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
const fightMemory = newFightMemory()

/** Who last killed this player, by riotId, or "" if nothing in the feed says. */
const lastKillerOf = (data: LiveAllGameData, victim: string): string => {
	if (victim === "") return ""
	const events = data.events?.Events ?? []
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i]!
		if (e.EventName === "ChampionKill" && e.VictimName === victim) return e.KillerName ?? ""
	}
	return ""
}

/**
 * Seconds until an objective is back, counted from a take we ACTUALLY SAW this session.
 *
 * Null when nothing was observed — never assumed from the clock, which is the same rule the
 * overlay already follows. The respawn constants are shared with `analysis/live-coach.ts` rather
 * than retyped, so the coach and the overlay cannot drift apart on a patch.
 */
const backInSec = (
	data: LiveAllGameData,
	name: string,
	respawnSec: number,
	nowSec: number
): number | null => {
	const events = data.events?.Events ?? []
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i]!
		if (e.EventName === name && e.EventTime !== undefined)
			return Math.round(e.EventTime + respawnSec - nowSec)
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
		factMemory.announcedLosses.clear()
		resetFightMemory(fightMemory)
		factMemory.lastLedWithDeath = false
		factMemory.lastGoldMentioned = 0
		factMemory.lastFarmAtSec = 0
		return null
	}
	const secs = gameTimeSec ?? data.gameData?.gameTime ?? 0
	const clock = `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`
	const myName = me.riotId ?? me.summonerName ?? ""
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
	/*
	 * Champion names, never riotIds.
	 *
	 * The event feed names people by summoner name, and this rendered them straight into a block
	 * whose every other line is champions. The coach then spoke them as champions: "You got Baron
	 * with Electrician" reached the player out loud, about a Baron he did not take, while he was
	 * dead. It reads as a hallucination and it is a namespace leak - the model was repeating
	 * exactly what it was handed.
	 */
	const championOf = (who: string | undefined): string => {
		if (!who) return "someone"
		const p = (data.allPlayers ?? []).find(x => (x.riotId ?? x.summonerName) === who)
		return p?.championName ?? who
	}
	const recentEvents = (data.events?.Events ?? [])
		.slice(-6)
		.map(e => {
			if (e.EventName === "DragonKill")
				return `${dragonPhrase(e.DragonType)} taken by ${championOf(e.KillerName)}`
			if (e.EventName === "BaronKill") return `Baron taken by ${championOf(e.KillerName)}`
			if (e.EventName === "HeraldKill") return `Herald taken by ${championOf(e.KillerName)}`
			if (e.EventName === "TurretKilled") return `turret down (${e.TurretKilled ?? "?"})`
			if (e.EventName === "ChampionKill")
				return `${championOf(e.KillerName)} killed ${championOf(e.VictimName)}`
			return ""
		})
		.filter(t => t !== "")

	/*
	 * Read ONCE, and used twice: the rate-limited "you're N camps behind" fact, and the standing
	 * `Farm baseline:` line in the block. It used to feed only the first, so between farm mentions
	 * the block carried a CS with nothing to compare it to — and a gap is where the model invents.
	 */
	const pace =
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

	const counterpart = (() => {
			const enemies = others.filter(p => p.team !== mine)
			const byRole = enemies.find(p => (p.position ?? "").toUpperCase() === "JUNGLE")
			const bySmite =
				byRole ??
				enemies.find(p =>
					[p.summonerSpells?.summonerSpellOne?.displayName, p.summonerSpells?.summonerSpellTwo?.displayName]
						.some(n => (n ?? "").toLowerCase() === "smite")
				)
			if (!bySmite) return null
			return {
				champion: bySmite.championName ?? "their jungler",
				...(bySmite.scores?.creepScore !== undefined ? { cs: bySmite.scores.creepScore } : {}),
				...(bySmite.level !== undefined ? { level: bySmite.level } : {}),
				...(byRole ? {} : { inferred: true })
			}
	})()

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
		/*
		 * The enemy jungler, by declared position, falling back to Smite.
		 *
		 * `position` is reliable in the LIVE api (see schema/live.ts) but some queues report none,
		 * and Smite has been exactly right in every game measured — it is still an inference, so it
		 * is flagged as one rather than asserted.
		 */
		counterpart,

		pace,
		/*
		 * Only the champions in THIS game, and only those the model says wrongly. The table has a
		 * hundred rows and this block is rebuilt every turn, so sending all of it would cost a
		 * hundred lines per turn to fix at most ten names.
		 */
		pronounce: pronunciationsFor(
			[me.championName ?? "", ...others.map(p => p.championName ?? "")].filter(n => n !== ""),
			pronunciationTable()
		),
		allies: others.filter(p => p.team === mine).map(asPlayer),
		enemies: others.filter(p => p.team !== mine).map(asPlayer),
		recentEvents,
		unseen: buildFacts(
			{
				nowSec: secs,
				// His own respawn — every tempo line has to be reachable by the person hearing it.
				meDeadForSec: me.isDead ? (me.respawnTimer ?? null) : null,
				// He counts himself among the living only when he is actually on the map.
				alliesAlive:
					(me.isDead ? 0 : 1) + others.filter(p => p.team === mine && !p.isDead).length,
				enemiesAlive: others.filter(p => p.team !== mine && !p.isDead).length,
				deadEnemies: others
					.filter(p => p.team !== mine && p.isDead && (p.respawnTimer ?? 0) > 0)
					.map(p => ({
						champion: p.championName ?? "an enemy",
						respawnSec: p.respawnTimer ?? 0,
						/*
						 * Did HE make this kill? The event feed names killer and victim by riotId,
						 * and a kill he made is something he was present for — announcing it back
						 * is a readback, not scouting. Only the most recent kill of that victim
						 * matters, which is the one still on the respawn clock.
						 */
						killedByMe: lastKillerOf(data, p.riotId ?? p.summonerName ?? "") === myName,
						// `position` is reliable in the LIVE api (unlike match history), so the
						// jungler is known rather than inferred.
						isJungler: (p.position ?? "").toUpperCase() === "JUNGLE"
					})),
				/*
				 * Objectives the ENEMY took. `myEvents` is filtered to his own name, so before this
				 * the coach was structurally incapable of noticing that the other team had just
				 * taken Baron — the single largest event in the game.
				 */
				counterpart,
				meLevel: me.level,
				/*
				 * The fight read is computed HERE and handed in already phrased, because the
				 * arithmetic over kill clusters belongs in its own module and the ranker only needs
				 * to know whether there is a line and whether it must stay quiet.
				 */
				fight: (() => {
					const champ = (who: string | undefined): string =>
						championOf(who) === "someone" ? "" : championOf(who)
					const r = readFight(
						{
							nowSec: secs,
							me: me.championName ?? "",
							allies: others.filter(p => p.team === mine).map(p => p.championName ?? ""),
							enemies: others.filter(p => p.team !== mine).map(p => p.championName ?? ""),
							kills: (data.events?.Events ?? [])
								.filter(e => e.EventName === "ChampionKill")
								.map(e => ({
									atSec: e.EventTime ?? 0,
									killer: champ(e.KillerName),
									victim: champ(e.VictimName),
									assisters: (e.Assisters ?? []).map(champ).filter(n => n !== "")
								})),
							objectives: (data.events?.Events ?? [])
								.filter(e => OBJECTIVE_EVENTS.has(e.EventName))
								.map(e => ({
									atSec: e.EventTime ?? 0,
									name: e.EventName,
									// KNOWN to be theirs, never assumed. An unresolvable killer arrives
									// as false, because a lookup miss must not become an accusation.
									byEnemy: (() => {
										const k = (data.allPlayers ?? []).find(
											p => (p.riotId ?? p.summonerName) === e.KillerName
										)
										return k ? k.team !== mine : false
									})()
								})),
							meDeadForSec: me.isDead ? (me.respawnTimer ?? 0) : null,
							hp: data.activePlayer?.championStats?.currentHealth ?? null,
							maxHp: data.activePlayer?.championStats?.maxHealth ?? null,
							alliesAlive: others.filter(p => p.team === mine && !p.isDead).length + (me.isDead ? 0 : 1),
							enemiesAlive: others.filter(p => p.team !== mine && !p.isDead).length
						},
						fightMemory
					)
					return { quiet: r.quiet, line: r.line }
				})(),
				enemyObjectives: (data.events?.Events ?? [])
					.filter(e => OBJECTIVE_EVENTS.has(e.EventName) && e.KillerName !== myName)
					.filter(e => {
						// A take by one of HIS team is not a loss. Team membership comes from the
						// roster, since the event feed gives only a name.
						const killer = (data.allPlayers ?? []).find(
							p => (p.riotId ?? p.summonerName) === e.KillerName
						)
						return killer ? killer.team !== mine : true
					})
					.map(e => ({
						name: e.EventName,
						atSec: e.EventTime ?? 0,
						...(e.DragonType ? { dragonType: e.DragonType } : {})
					})),
				currentGold: data.activePlayer?.currentGold ?? null,
				pace: pace ? { cs: pace.cs, expected: pace.expected, exact: pace.exact } : null,
				myEvents: (data.events?.Events ?? [])
					.filter(e => e.KillerName !== undefined && e.KillerName === myName)
					.map(e => ({
						id: e.EventID,
						name: e.EventName,
						killStreak: e.KillStreak,
						dragonType: e.DragonType,
						stolen: e.Stolen === "True"
					})),
				drakeBackInSec: backInSec(data, "DragonKill", DRAGON_RESPAWN_SEC, secs),
				baronBackInSec: backInSec(data, "BaronKill", BARON_RESPAWN_SEC, secs),
				heraldBackInSec: backInSec(data, "HeraldKill", HERALD_RESPAWN_SEC, secs)
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

	/**
	 * The game that just ended, if there is one worth showing.
	 *
	 * The daemon wrote down WHICH game and WHEN (`src/daemon/postgame.ts`); this resolves that
	 * marker against the library and lets `postGameDebrief` decide. Two rows and a clock read —
	 * cheap enough to sit on a route the overlay polls every three seconds.
	 *
	 * `uncoachableReason` is asked with the stored row, which does not carry `gameType`. That
	 * costs nothing in practice: a custom game and the Practice Tool both land on `queueId 0`,
	 * which the same check rejects. `src/daemon/jobs/analysis-run.ts` makes exactly this call.
	 */
	const justEnded = (): JustEnded | null => {
		const marker = lastGameEnded()
		if (!marker) return null

		/*
		 * Normally the marker names the game. When the gameflow session could not be read on
		 * the way in it does not, and the newest row has to be matched by time instead — with a
		 * window tight enough that the PREVIOUS game cannot be mistaken for this one.
		 */
		const game =
			marker.gameId !== null ? getGame(marker.gameId)
			: (listGames(1)[0] ?? null)

		const resolved =
			game && (marker.gameId !== null || matchesMarker(game.endedAtMs, marker.endedAtMs)) ?
				(game as EndedGame)
			:	null

		return postGameDebrief({
			marker,
			dismissedEndedAtMs: dismissedDebrief(),
			game: resolved,
			nowMs: Date.now()
		})
	}

	app.get("/live", async c => {
		const handle = await lcu()
		/*
		 * Only computed when there is no game running. During a game the screen's job is the
		 * game — and the marker for the game he is playing has not been written yet anyway.
		 */
		if (!handle) {
			const ended = justEnded()
			return send(
				c,
				LiveResponse,
				{
					inGame: false,
					// He closed the client after playing. The debrief is still the point of the
					// screen, so the reason line stops being the headline.
					reason: "the League client is not running",
					nudges: [],
					focus: standingFocus(),
					...(ended ? { justEnded: ended } : {})
				},
				"GET /api/live"
			)
		}

		const data = await handle.live.allGameData().catch(() => null)
		if (!data?.gameData) {
			const ended = justEnded()
			return send(
				c,
				LiveResponse,
				{
					inGame: false,
					reason: "no game in progress",
					nudges: [],
					focus: standingFocus(),
					...(ended ? { justEnded: ended } : {})
				},
				"GET /api/live"
			)
		}

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
	 * `POST /api/live/dismiss` — close the post-game debrief.
	 *
	 * Server-side on purpose. He reads the debrief, closes it, and alt-tabs into a fresh window
	 * ten seconds later; a dismissal held in the page would come straight back, and one held in
	 * `localStorage` would be per-browser-profile — the overlay window and a browser tab are two
	 * of those. One row in `kv` is the only version of this that is true everywhere at once.
	 *
	 * Keyed on the end time rather than the gameId because the panel is dismissable while the
	 * match is still being assembled, when there is no id yet.
	 */
	app.post("/live/dismiss", async c => {
		const body = (await c.req.json().catch(() => null)) as { endedAtMs?: unknown } | null
		const endedAtMs = typeof body?.endedAtMs === "number" ? body.endedAtMs : null
		if (endedAtMs === null || !Number.isFinite(endedAtMs))
			return fail(c, 400, "endedAtMs must be the number from the justEnded payload", "bad-dismiss")
		dismissDebrief(endedAtMs)
		return c.json({ ok: true })
	})

	/**
	 * `GET /api/live/phase` — the one thing that decides whether the coach sends anything.
	 *
	 * The screen share persists across games now, so "is a stream open" no longer answers "is he
	 * playing". This does. It is deliberately its own route rather than a field on `/api/live`:
	 * that one reads the in-game API on :2999, which does not answer until the game process is up
	 * and therefore cannot see champion select at all — the exact window this gate exists to open.
	 *
	 * `GET /api/health` already carries `gameflowPhase`, and it is the wrong source here: it is
	 * polled every 20 seconds, which would leave the coach dead for a third of a minute after the
	 * loading screen, and it drags a Vanguard probe and a database read behind it. This is one
	 * gameflow read (p50 2.3 ms over the bridge) and nothing else.	 *
	 * Null phase means the League client is closed. That is a state, not an error — it answers
	 * 200 disarmed, and the browser says so rather than showing a broken coach.
	 */
	app.get("/live/phase", async c => {
		const handle = await lcu()
		const phase = handle ? await handle.client.gameflowPhase().catch(() => null) : null
		return c.json({
			phase,
			armed: isCoachingPhase(phase),
			/** A game is actually running, as opposed to drafting or loading into one. */
			inGame: phase === "InProgress" || phase === "Reconnect"
		})
	})

	/**
	 * `POST /api/live/journal/frame` — store one frame of the shared screen.
	 * `GET /api/live/matchup` — the champ-select / loading-screen brief.
	 *
	 * The fourth coach state, and the only one that runs before anything has happened. It reads
	 * `/lol-gameflow/v1/session`, which publishes both comps, every declared position and every
	 * player's summoner spells from champ select onward — verified against the live client.
	 *
	 * READ-ONLY, like the rest of this file. `src/daemon/gate.ts` guards writes and launching the
	 * client; there is nothing here for it to protect. It matters that this stays true: the gate
	 * exists partly to keep this app out of champ select, and this endpoint is *in* champ select.
	 * It looks and it does not touch.
	 *
	 * Every state answers 200. Client closed, sitting in the lobby, locked in but the client has
	 * not published selections yet — all of them are normal, and a poller that sees a 500 while a
	 * game is loading is a poller the user turns off.
	 */
	app.get("/live/matchup", async c => {
		const handle = await lcu()
		if (!handle)
			return send(
				c,
				MatchupResponse,
				{ available: false, reason: "the League client is not running" },
				"GET /api/live/matchup"
			)

		const session = await handle.client.gameflowSession().catch(() => null)
		if (!session)
			return send(
				c,
				MatchupResponse,
				{ available: false, reason: "the client is not setting up a game right now" },
				"GET /api/live/matchup"
			)

		// The same list `/live/phase` arms on — two copies of one phase set will drift apart.
		if (!isCoachingPhase(session.phase))
			return send(
				c,
				MatchupResponse,
				{
					available: false,
					phase: session.phase,
					reason: "no game is being set up right now"
				},
				"GET /api/live/matchup"
			)

		// Both tables are hourly-cached and no-op in the common case. Names are the whole point of
		// this endpoint, so it is worth one round trip the first time after a client restart.
		await Promise.all([refreshChampionNames(), refreshSummonerSpellNames()])

		const queueId = session.gameData?.queue?.id
		const { brief, reason } = buildMatchupBrief({
			session,
			puuid: USER_PUUID,
			championName,
			spellName: summonerSpellName,
			// `_default.md` is treated as "no notes on file", because it does not describe a
			// champion — it tells the coach to stop talking about the champion. Passing it through
			// as context would invite exactly the improvisation it exists to prevent.
			noteFor: champion => {
				const note = championNote(champion)
				return note && !note.isDefault ?
						{ champion, text: note.text, patch: note.patch, source: note.source }
					:	null
			},
			queue:
				typeof queueId === "number" ?
					(QUEUE_NAMES[queueId] ?? `Queue ${queueId}`)
				:	null
		})

		return send(
			c,
			MatchupResponse,
			brief ?
				{ available: true, phase: session.phase, brief, text: matchupPromptSection(brief) }
			:	{ available: false, phase: session.phase, reason: reason ?? "nothing to brief yet" },
			"GET /api/live/matchup"
		)
	})

	/**
	 * `POST /api/live/journal/frame` — store one frame of the shared screen.
	 *
	 * Deliberately independent of the Gemini coach. Sharing the screen is what earns a graded
	 * review; the live voice is an optional extra on top of it, and costs money, and should not be
	 * a prerequisite for being coached after the game.
	 *
	 * The daemon stamps the game clock itself — see `daemon/journal.ts`. The browser sends pixels
	 * and, when it has one, the ground-truth block; it never sends a time.
	 */
	app.post("/live/journal/frame", async c => {
		const body = (await c.req.json().catch(() => null)) as {
			frame?: unknown
			truth?: unknown
		} | null
		const frame = typeof body?.frame === "string" ? body.frame : ""
		const b64 = frame.replace(/^data:image\/\w+;base64,/, "")
		if (b64 === "" || b64.length > 12_000_000)
			return fail(c, 400, "frame must be a base64 image under ~12MB", "bad-frame")

		const result = await writeFrame({
			jpeg: Buffer.from(b64, "base64"),
			truth: typeof body?.truth === "string" ? body.truth : null
		})
		// 200 either way: a refused frame is a normal outcome (no game, practice tool), not an
		// error the page should surface as broken.
		return c.json(result)
	})

	/** `GET /api/live/journal` — is the journal actually recording? A number, not a claim. */
	app.get("/live/journal", c => c.json(openSessionStatus()))

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
		const stored = appendTranscript({
			atMs: Date.now(),
			text: body.text.slice(0, 2000),
			fromUser: body.fromUser === true,
			gameTimeSec: typeof body.gameTimeSec === "number" ? body.gameTimeSec : null,
			...(typeof body.groundTruth === "string" && body.groundTruth !== "" ?
				{ groundTruth: body.groundTruth.slice(0, 8000) }
			:	{})
		})
		/*
		 * The truth about the write, not a reflex `{ok: true}`.
		 *
		 * The browser holds the only copy of the line. Telling it the line was stored when it was
		 * not is how a whole game of coaching went missing while every diagnostic said fine.
		 */
		if (!stored)
			return fail(c, 500, "the line could not be written to the transcript", "transcript-write")
		return c.json({ ok: true })
	})

	/**
	 * `GET /api/live/gemini/transcript` — the last N lines, newest first, for review.
	 *
	 * `?limit=` is clamped rather than coerced. `Number("")` is 0 and `Number("all")` is NaN, and
	 * both used to answer `{lines: []}` — an empty transcript and an unreadable limit rendered as
	 * the same sentence on screen.
	 */
	app.get("/live/gemini/transcript", c =>
		c.json({ lines: readTranscript(transcriptLimit(c.req.query("limit"))) })
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
