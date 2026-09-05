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
import { championNote, defaultNote, pronunciationTable } from "../../knowledge/index.ts"
import {
	mergeClauses,
	newAdviceCursor,
	parseChampionClauses,
	resetAdviceCursor,
	rotatingAdvice
} from "../../shared/champion-advice.ts"
import { pronunciationsFor } from "../../shared/pronounce.ts"
import { dragonPhrase } from "../../shared/dragons.ts"
import { hasSmite } from "../../shared/smite.ts"
import { getGame, getSettings, listGames, recentFeedbackItems } from "../../db/queries.ts"
import { dismissDebrief, dismissedDebrief, lastGameEnded } from "../../daemon/postgame.ts"
import { matchesMarker, postGameDebrief } from "../../shared/postgame.ts"
import { coachTurn, providerById, providerStatus, setProviderKey } from "../../review/live-providers.ts"
import { matchupPromptSection } from "../../shared/matchup-prompt.ts"
import type { EndedGame, JustEnded } from "../../shared/postgame.ts"
import { LiveResponse, MatchupResponse } from "../../shared/schema/api.ts"
import { isCoachingPhase } from "../../shared/schema/lcu.ts"
import type { GameflowSession } from "../../shared/schema/lcu.ts"
import type { LiveAllGameData, LivePlayer } from "../../shared/schema/live.ts"
import { QUEUE_NAMES, USER_PUUID } from "../../shared/constants.ts"
import { liveCoachSystemPrompt, renderBlockForMode } from "../../shared/live-coach-mode.ts"
import { objectiveSchedule } from "../../shared/live-state.ts"
import type { ObjectiveEvent } from "../../shared/live-state.ts"
import { buildArc, renderArc } from "../../analysis/arc.ts"
import type { ArcSample } from "../../analysis/arc.ts"
import { habitCues } from "../../analysis/habits.ts"
import { liveChampionKnowledge } from "../../review/live-coach-knowledge.ts"
import { openSessionStatus, writeFrame } from "../../daemon/journal.ts"
import { buildFacts, FRAME_FRESH_SEC, newFactMemory, resetFactMemory } from "../../analysis/live-facts.ts"
import type { FrameObservation } from "../../analysis/live-facts.ts"
import {
	asFrameRead,
	coarseOf,
	frameReadFaults,
	parseFrameRead,
	parseFrameReadXY,
	truthFromState
} from "../../review/frame-read.ts"
import { readMinimap } from "../../review/read-minimap.ts"
import type { Coarse, FrameRead, FrameTruth } from "../../review/frame-read.ts"
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
/**
 * What counts as a finished item for the purpose of being worth a sentence.
 *
 * The client reports `price` and nothing else about completeness, so this is a threshold and it is
 * treated as one: it decides whether to MENTION an item, never what to claim about it. The line
 * names the item, so the number never reaches him.
 */
const LEGENDARY_ITEM_GOLD = 2000

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
 * Which champion he is on, from whichever source can answer yet.
 *
 * The socket sets its system prompt ONCE, at champion select, and that is minutes before the live
 * client on :2999 answers anything at all — so a prompt built from `allgamedata` alone would ship
 * every socket session with no champion knowledge in it, while the turn-based path (which builds
 * its prompt per turn, in a game) got the clauses. Same coach, two architectures, silently
 * different prompts: exactly the confound `coachTurn` refuses to allow.
 *
 * `/lol-gameflow/v1/session` publishes the locked champion from champ select onward and is already
 * how `GET /api/live/matchup` names it, so this reuses that join rather than reading the champ
 * select delegate directly — `/lol-champ-select/v1/session` 404s with "No active delegate" the
 * moment the draft ends, which is the half of the window this needs most.
 *
 * The game comes FIRST when there is one: a reconnect mid-game re-mints a token, and by then the
 * live client is authoritative about who is actually being played.
 *
 * `""` on every failure, which is a supported answer and not an error — a champion with no notes
 * on file gets a coach that reasons from the block alone, which is what it did for this app's
 * whole life.
 */
const lockedChampion = async (): Promise<string> => {
	const handle = await lcu()
	if (!handle) return ""
	const data = await handle.live.allGameData().catch(() => null)
	const inGame = data ? findMe(data) : null
	if (inGame?.championName) return inGame.championName
	const session = await handle.client.gameflowSession().catch(() => null)
	if (!session) return ""
	// Hourly-cached and a no-op in the common case; without it every id resolves to "".
	await refreshChampionNames()
	return championFromSession(session, championName)
}

/**
 * The champion he has locked, read off a gameflow session. Pure, so it can be tested.
 *
 * Split out from `lockedChampion` because the interesting half is the JOIN — the client publishes
 * the roster and the champion selections separately, and during the draft they disagree in a
 * specific way (the roster rows lag a swap). `buildMatchupBrief` already resolves that, and
 * resolving it a second time here is how the two would drift.
 *
 * `""` for every "not yet": no roster published, no lock, an unknown id, a phase that is not a
 * game. Never a guess — `championName` returns `""` for an id it does not know rather than
 * inventing one, and a wrong champion in the prompt is worse than none, because the clauses would
 * then be advice about a kit he is not playing.
 */
export const championFromSession = (
	session: GameflowSession,
	nameOf: (championId: number) => string
): string => {
	// The same list `/live/phase` arms on; a lobby has no champion and a post-game screen's is over.
	if (!isCoachingPhase(session.phase)) return ""
	const { brief } = buildMatchupBrief({
		session,
		puuid: USER_PUUID,
		championName: nameOf,
		// Spells are not read here; the brief needs a lookup, and an empty name is its own "unknown".
		spellName: () => ""
	})
	return brief?.you.champion ?? ""
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
/**
 * The game so far, one sample every few seconds, for `analysis/arc.ts`.
 *
 * A rolling buffer rather than a re-read of the sampler's file: the poll has already parsed this
 * object and dropping it only to read it back off disk every turn is work for nothing. The spacing
 * matches the daemon's own sampler, because the arc's stall detection is judged against his median
 * run LENGTH and a denser series does not make a stall more real, only more expensive.
 *
 * CLEARED BETWEEN GAMES beside `resetFactMemory`, and that is the whole hazard: a buffer that
 * outlives its game gives game two a stall computed from game one's clear, which is the same class
 * of bug as a socket spanning two games.
 */
const arcSamples: ArcSample[] = []
const ARC_SAMPLE_SPACING_SEC = 5
/** ~50 minutes at that spacing. A cap so a forgotten reset cannot become a leak. */
const ARC_SAMPLE_CAP = 600

/**
 * When each career-habit cue first became true this game, so a STANDING one stops repeating.
 *
 * `habitCues` is pure and stateless by design — `habits.ts` says so, and rate-limiting lives with
 * the caller. Without one, "topside conceded" is true from the moment it fires until the game ends,
 * and a fact that is true for twenty minutes is read out for twenty minutes. That is the exact
 * monotone failure the whole rebuild is against: measured over 88 states, the block's one
 * comparative fact returned the same verdict in 82 of them and none the other way.
 */
const habitFirstSeen = new Map<string, number>()
/** How long a career cue stays in the block after it first becomes true. */
const HABIT_WINDOW_SEC = 120

const factMemory = newFactMemory()
const fightMemory = newFightMemory()
/**
 * Where each fact kind is up to in its champion-advice rotation.
 *
 * Beside `factMemory` and reset on the same boundary, because it is the same kind of thing: state
 * that exists to stop the coach saying one sentence over and over, and that must not survive into
 * the next game. Counting FIRINGS rather than reading the clock is load-bearing — a clock index
 * shares a factor with the cooldowns and lands every firing of a kind on the same clause.
 */
const adviceCursor = newAdviceCursor()

/*
 * WHERE THE PICTURE ENTERS. Three variables, and the reason each of them exists.
 *
 * The coach may only speak from the ranked list `buildFacts` returns, and until now every candidate
 * in that list was computed from the game client. Measured: two coaching arms of 14 turns, identical
 * blocks and prompt, differing only in whether the frame was attached, made the same speak-or-PASS
 * call on 13 of 14 turns — while the same model read the clock off those same frames 6 times in 6.
 * The screenshot was being looked at and had nowhere to land. `POST /api/live/frame-read` is the
 * landing, `buildFacts` decides what if anything it is worth, and these hold the one observation in
 * between.
 *
 * Module-level for the same reason `factMemory` is: one local user, one game at a time, one process.
 */

/** The last read that survived the client's fence, or null. Handed to `buildFacts` as `frame`. */
let frameRead: FrameObservation | null = null

/**
 * The half of the map the PREVIOUS accepted read named, which is the whole of the confidence test.
 *
 * MEASURED: two reads of one picture agreed about the half on 56 of 60 pairs. So a disagreement
 * between two reads taken seconds apart is the 7% showing itself — one of them is wrong, or he is
 * standing on a boundary — and either way there is nothing here worth building a sentence on. Marked
 * `low` rather than dropped so the fact stays legible; `buildFacts` treats `low` as no read at all,
 * for a sentence AND for a gate. Direction of failure is silence, which is the cheap direction.
 */
let lastFrameSide: { where: Coarse | null; atSec: number } | null = null

/**
 * What the client last established, cached off the poll the coach already makes.
 *
 * A frame read has to be fenced against the client before any of it is believed — more enemies than
 * are alive, his icon on the map while he is on the respawn screen, his own champion read as
 * somebody else — and re-polling the LCU inside the frame-read handler would double the traffic
 * during a game for data the ground-truth poll fetched a moment ago. `atSec` doubles as the stamp
 * on the read itself: the browser grabs its frame from the same screen it is polling this route
 * about, so the last poll's clock is the closest honest time the picture has. It is an
 * approximation of a few seconds and `FRAME_FRESH_SEC` is sized to absorb it.
 */
let lastTruth: { truth: FrameTruth; atSec: number } | null = null

/**
 * A fenced read, plus the previous one, into the single observation `buildFacts` is handed.
 *
 * Exported and pure so the two rules in it can be pinned by a test rather than living inside a
 * handler that needs a running game to reach.
 *
 * COARSENED HERE, and nothing finer is ever stored. The zone the reader answered was right on 15 of
 * 18 hand-scored reads; the HALF was right on 17 of 18, and the half is the granularity a jungler's
 * decision actually turns on — "he is topside" changes whether to take drake, "he is on raptors
 * rather than wolves" does not. Throwing the precision away at the door means no later caller can
 * be tempted by it.
 *
 * DOUBTED WHEN TWO READS DISAGREE. Measured: two reads of one picture agreed about the half on 56
 * of 60 pairs, so a disagreement between reads taken seconds apart is that 7% showing itself — one
 * of them is wrong, or he is standing on a boundary, and either way there is nothing here to build
 * a sentence on. `buildFacts` treats `low` as no read at all, for a gate as well as for a sentence,
 * so the direction of failure is silence.
 */
export const observationFrom = (
	read: FrameRead,
	previous: { where: Coarse | null; atSec: number } | null,
	atSec: number
): FrameObservation => {
	const where = read.you === null ? null : coarseOf(read.you)
	const doubted =
		previous !== null && atSec - previous.atSec <= FRAME_FRESH_SEC && previous.where !== where
	return { where, atSec, confidence: doubted ? "low" : "medium" }
}

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
		/*
		 * Between games: forget everything, in ONE call.
		 *
		 * This block used to name the fields by hand, and a hand-written list is right until the
		 * next field is added. Counted against the interface at the time it was replaced it named 22
		 * of 26, and the four it missed — `lastOfferedAtSec`, `lastSubjects`, `lastSeenSec`,
		 * `lastFarmBehind` — were the global speech budget itself, so game two would open believing
		 * the coach had just spoken. `resetFactMemory` cannot go stale that way.
		 */
		resetFactMemory(factMemory)
		resetFightMemory(fightMemory)
		arcSamples.length = 0
		habitFirstSeen.clear()
		/*
		 * And forget the picture. A frame read belongs to the game it was taken in, and carrying one
		 * across is the same class of bug as a socket spanning two games: the roster changes, the
		 * clock restarts, and a half of the map from the last game would gate a real objective call
		 * in the first minute of the next one.
		 */
		frameRead = null
		lastFrameSide = null
		lastTruth = null
		/*
		 * ONE CALL, not a list of fields.
		 *
		 * This was twenty-one assignments naming fields by hand, and it was already stale: counted
		 * against `FactMemory`, it cleared 22 of 26 fields, and the four it missed were the four
		 * most recently added. `resetFactMemory` exists precisely to end that — it assigns a fresh
		 * memory in place, so a field added tomorrow is reset today. Leaking one across games is
		 * the same class of bug as a socket spanning two: an announce-once fact that was already
		 * spent stays spent, and the coach silently loses a line for the whole next game.
		 */
		resetFactMemory(factMemory)
		resetAdviceCursor(adviceCursor)
		return null
	}
	const secs = gameTimeSec ?? data.gameData?.gameTime ?? 0
	const clock = `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`
	const lastArcSample = arcSamples[arcSamples.length - 1]
	if (!lastArcSample || secs - lastArcSample.atSec >= ARC_SAMPLE_SPACING_SEC) {
		arcSamples.push({ atSec: secs, data })
		if (arcSamples.length > ARC_SAMPLE_CAP) arcSamples.shift()
	}
	/*
	 * The EVENT feed names people by BARE game name; the roster's `riotId` and `summonerName`
	 * both carry the tag. Matching on the tagged fields therefore never matches, and every one
	 * of these sites silently fell through.
	 *
	 * Measured on a real recorded game, one paragraph apart in the SAME block: the prose said
	 * "Baron taken by Lillia" while the ranked list — the only thing the model is permitted to
	 * speak — said "they have Baron, do not take a fight in the open". Four seconds after he
	 * soloed Baron. `myEvents` was empty for the whole game, so "you secured Baron" could never
	 * fire, and `objectiveCount` returned {mine: 0, theirs: 0} in every block of a 36-minute
	 * game with three drakes, a herald and a baron in it.
	 */
	const nameOf = (p: LivePlayer | undefined): string =>
		p?.riotIdGameName ?? p?.riotId ?? p?.summonerName ?? ""
	const playerNamed = (who: string | undefined): LivePlayer | undefined =>
		who === undefined ? undefined : (
			(data.allPlayers ?? []).find(
				x => x.riotIdGameName === who || x.riotId === who || x.summonerName === who
			)
		)
	const myName = nameOf(me)
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
		/*
		 * Match on BOTH names, because the two feeds disagree.
		 *
		 * The roster carries riotIds and the EVENT feed sends bare summoner names, so a one-sided
		 * lookup misses and falls through to the raw string. It did: "jestericide killed Smael"
		 * reached the player in a block whose every other line is champions. Half-fixing this was
		 * worse than not fixing it, because the remaining misses look exactly like hallucination.
		 */
		const p = (data.allPlayers ?? []).find(
			x => x.riotIdGameName === who || x.riotId === who || x.summonerName === who
		)
		/*
		 * NEVER fall through to the raw name.
		 *
		 * It did, and this was measured on a real capture (data/live-samples): matching on
		 * `riotId`/`summonerName` resolved 0 of 37 event names, because the event feed sends the
		 * BARE game name ("Gooskaffur") while both of those fields carry the tag
		 * ("Gooskaffur#NA1"). `riotIdGameName` is the one that joins, and it was the one field
		 * not being consulted.
		 *
		 * The cost was not cosmetic. Every kill in the block arrived as an unmappable proper
		 * noun, in a block that also says "these ten champions are the only champions in this
		 * game" - so the single richest signal available, who killed whom, was noise the model
		 * could not use, and it fell back on the only clean numbers left. Six of nine lines in
		 * one real transcript were about CS.
		 *
		 * Returning the sentinel keeps an unresolved name OUT of the block entirely, which is
		 * the only safe direction: a name we cannot tie to a champion is indistinguishable from
		 * a hallucination once it has been spoken.
		 */
		return p?.championName ?? "someone"
	}
	const recentEvents = (data.events?.Events ?? [])
		.slice(-6)
		.map(e => {
			if (e.EventName === "DragonKill")
				return `${dragonPhrase(e.DragonType)} taken by ${championOf(e.KillerName)}`
			if (e.EventName === "BaronKill") return `Baron taken by ${championOf(e.KillerName)}`
			if (e.EventName === "HeraldKill") return `Herald taken by ${championOf(e.KillerName)}`
			if (e.EventName === "TurretKilled") return `turret down (${e.TurretKilled ?? "?"})`
			if (e.EventName === "ChampionKill") {
				/*
				 * Drop the event when NEITHER side resolves. "someone killed someone" is not a
				 * fact, it is a line of filler that pushes a real one out of the six-event window.
				 * One resolved side is still worth saying.
				 */
				const k = championOf(e.KillerName)
				const v = championOf(e.VictimName)
				return k === "someone" && v === "someone" ? "" : `${k} killed ${v}`
			}
			return ""
		})
		.filter(t => t !== "")

	/*
	 * Read ONCE, and used twice: the rate-limited "you're N camps behind" fact, and the standing
	 * `Farm baseline:` line in the block. It used to feed only the first, so between farm mentions
	 * the block carried a CS with nothing to compare it to — and a gap is where the model invents.
	 */
	/*
	 * `creepScore` is FLOORED to a multiple of ten by the client (`CS_QUANTUM` in
	 * `shared/live-state.ts`, where it is measured), and `expected` here is an exact mean over
	 * finished games. They are handed on as they are, unaltered — adding anything back would be
	 * inventing a digit — and every consumer is responsible for comparing them as an interval
	 * rather than a subtraction. `renderState` does; `analysis/live-facts.ts` still subtracts.
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
			/*
			 * `hasSmite` rather than a name check here: Smite is RENAMED when it upgrades, and an
			 * equality test on "Smite" recognised 18.5% of the ones the client actually sent. See
			 * `shared/smite.ts` for the counts.
			 */
			const bySmite = byRole ?? enemies.find(hasSmite)
			if (!bySmite) return null
			return {
				champion: bySmite.championName ?? "their jungler",
				// Floored the same way his own is, so the gap between the two is a multiple of ten and
				// is worth ±9 less than it looks. `renderState` states the part that survives.
				...(bySmite.scores?.creepScore !== undefined ? { cs: bySmite.scores.creepScore } : {}),
				...(bySmite.level !== undefined ? { level: bySmite.level } : {}),
				/*
				 * Legendary items by NAME. `price` is the only completeness signal the client gives,
				 * so it gates what is worth mentioning — but the line names the item rather than
				 * counting them, so no threshold is ever spoken as a fact.
				 */
				...(() => {
					// Share of his own team's kills. Exact — every K/A is in the block.
					const theirKills = enemies.reduce((n, p) => n + (p.scores?.kills ?? 0), 0)
					return theirKills > 0 ?
							{
								killShare:
									((bySmite.scores?.kills ?? 0) + (bySmite.scores?.assists ?? 0)) / theirKills
							}
						:	{}
				})(),
				items: (bySmite.items ?? [])
					.filter(i => !i.consumable && (i.price ?? 0) >= LEGENDARY_ITEM_GOLD && i.displayName)
					.map(i => i.displayName!),
				...(byRole ? {} : { inferred: true })
			}
	})()

	const state: VisionState = {
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
						killedByMe: lastKillerOf(data, nameOf(p)) === myName,
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
				/*
				 * His champion's own note, or the role default. Parsed every call and cached by the
				 * knowledge module, so editing the markdown mid-session takes effect on the next
				 * game with no restart.
				 */
				advice: (() => {
					const note = championNote(me.championName ?? "")
					if (!note) return undefined
					/*
					 * The role defaults UNDER the champion's own clauses, merged per fact kind.
					 *
					 * `championNote` only falls back to `_default.md` when no champion file exists
					 * at all, so a champion file that says nothing about deaths used to leave the
					 * coach with nothing to say about deaths — having a file was strictly worse
					 * than having none. Merging per kind means a file overrides only where it has
					 * something better, and every kind still has a clause.
					 */
					const clauses =
						note.isDefault ?
							parseChampionClauses(note.text)
						:	mergeClauses(
								parseChampionClauses(defaultNote()?.text ?? ""),
								parseChampionClauses(note.text)
							)
					/*
					 * A fresh view per turn over a cursor that outlives the turn. Reading a kind is
					 * what advances it, and `buildFacts` reads a kind exactly when it renders a
					 * fact of that kind — so the rotation index is the count of firings, which is
					 * the only thing the cooldowns cannot collide with.
					 */
					return rotatingAdvice(clauses, adviceCursor)
				})(),
				meLevel: me.level,
				objectiveCount: (() => {
					let mineN = 0
					let theirs = 0
					for (const e of data.events?.Events ?? []) {
						if (!OBJECTIVE_EVENTS.has(e.EventName)) continue
						const k = playerNamed(e.KillerName)
						// An unresolvable killer counts for nobody rather than for the enemy.
						if (!k) continue
						if (k.team === mine) mineN += 1
						else theirs += 1
					}
					return { mine: mineN, theirs }
				})(),
				myKillShare: (() => {
					const ourKills =
						others.filter(p => p.team === mine).reduce((n, p) => n + (p.scores?.kills ?? 0), 0) +
						(me.scores?.kills ?? 0)
					return ourKills > 0 ?
							((me.scores?.kills ?? 0) + (me.scores?.assists ?? 0)) / ourKills
						:	undefined
				})(),
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
										const k = playerNamed(e.KillerName)
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
					/*
					 * Which champion clause fits. Absence and a lost fight want different advice —
					 * "be on the map before the next one" against "you want the long fight" — and
					 * handing the wrong one over is how champion knowledge starts sounding generic.
					 */
					const kind =
						!r.fight ? undefined
						: r.fight.participation === "absent" ? ("fight-absent" as const)
						: r.fight.lost > r.fight.won ? ("fight-lost" as const)
						: undefined
					return { quiet: r.quiet, line: r.line, ...(kind ? { kind } : {}) }
				})(),
				enemyObjectives: (data.events?.Events ?? [])
					.filter(e => OBJECTIVE_EVENTS.has(e.EventName) && e.KillerName !== myName)
					.filter(e => {
						// A take by one of HIS team is not a loss. Team membership comes from the
						// roster, since the event feed gives only a name.
						const killer = playerNamed(e.KillerName)
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
				heraldBackInSec: backInSec(data, "HeraldKill", HERALD_RESPAWN_SEC, secs),
				/*
				 * The picture's one observation, or nothing at all.
				 *
				 * Passed as-is: staleness, doubt and a read that could not place him are all decided
				 * inside `buildFacts`, because that is where the rules about what may be said live
				 * and a producer that decides for itself is a second copy of a rule that drifts.
				 */
				...(frameRead ? { frame: frameRead } : {})
			},
			factMemory
		),
		/*
		 * WHAT IS COMING — the map's own clock, and the only layer the ladder measured to move
		 * anything (`data/eval/why-shallow.md`: 29% useful lines to 55%, p = 0.0009, against 30%
		 * for ninety seconds of exactly-computed history).
		 *
		 * Side resolution goes through the ROSTER, never the event feed's name, for the reason
		 * every other join in this function does: the feed sends the bare game name and both
		 * roster id fields carry the tag. An unresolved killer becomes `null` rather than
		 * "theirs" — a mis-sided objective count is a false claim about his own game.
		 */
		schedule: objectiveSchedule(
			(data.events?.Events ?? [])
				.map((e): ObjectiveEvent | null => {
					const kind =
						e.EventName === "DragonKill" ? ("dragon" as const)
						: e.EventName === "HordeKill" ? ("grub" as const)
						: e.EventName === "HeraldKill" ? ("herald" as const)
						: e.EventName === "BaronKill" ? ("baron" as const)
						: null
					if (kind === null) return null
					const killer = playerNamed(e.KillerName)
					return {
						kind,
						tSec: e.EventTime ?? 0,
						side: killer ? (killer.team === mine ? "mine" : "theirs") : null
					}
				})
				.filter((e): e is ObjectiveEvent => e !== null),
			secs
		),
		/*
		 * The arc, and an honest note about what it bought: nothing measurable on top of the
		 * schedule (51% against 55%, inside each other's intervals). It is here because it is the
		 * only thing in the app that can notice a farm stall that lasted five minutes with three
		 * deaths inside it, and because it costs a few hundred characters. It is the first thing
		 * to cut if latency ever needs cutting.
		 */
		...(() => {
			const arc = buildArc(arcSamples)
			const text = arc ? renderArc(arc) : ""
			return text === "" ? {} : { arc: text }
		})(),
		/*
		 * At most ONE career line, and only while it is fresh.
		 *
		 * `habitCues` returns them ranked; taking the first is the rule `habits.ts` documents for
		 * its callers. The window is what stops a standing habit from being in every block for the
		 * rest of the game.
		 */
		...(() => {
			const grubSide = (name: string) => {
				const c = { mine: 0, theirs: 0 }
				for (const e of data.events?.Events ?? []) {
					if (e.EventName !== name) continue
					const killer = playerNamed(e.KillerName)
					if (!killer) continue
					if (killer.team === mine) c.mine++
					else c.theirs++
				}
				return c
			}
			const cue = habitCues({
				tSec: secs,
				cs: me.scores?.creepScore ?? null,
				grubs: grubSide("HordeKill"),
				heralds: grubSide("HeraldKill")
			})[0]
			if (!cue) return {}
			if (!habitFirstSeen.has(cue.key)) habitFirstSeen.set(cue.key, secs)
			return secs - (habitFirstSeen.get(cue.key) ?? secs) <= HABIT_WINDOW_SEC ? { habits: [cue.text] } : {}
		})()
	}
	/*
	 * The fence's ground truth, cached off this poll rather than fetched again by the frame-read
	 * handler. Narrowed through `truthFromState` so the daemon and `scripts/probe-minimap.ts` fence
	 * against the same five fields — a fence only one caller can build is a fence only one caller
	 * uses.
	 */
	lastTruth = { truth: truthFromState(state), atSec: secs }
	return state
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
	 * `POST /api/live/frame-read` — one reading of the minimap, from whoever took it.
	 *
	 * ## What this is for
	 *
	 * It is the seam the screenshot has never had. `analysis/live-facts.ts` computes and ranks every
	 * line the coach may speak, an empty list means PASS, and every candidate in that list was
	 * computed from the game client — so measured, a coaching turn with the JPEG attached and one
	 * without made the same speak-or-PASS decision on 13 of 14 turns and paraphrased each other where
	 * both spoke. The frame was being looked at and had nowhere to land. It lands here.
	 *
	 * ## What it accepts, and why it is a POST rather than a model call
	 *
	 * A reader — the browser, which already holds the frame and can crop `MINIMAP_REGION` out of it
	 * without a round trip, or a script — sends the reader's raw JSON in `read`. Either shape from
	 * `review/frame-read.ts` is understood: the coordinate form measured best (his own half right on
	 * 17 of 18 hand-scored reads, against 14 of 18 for the zone-name form) and is tried first, and
	 * the zone-name form is the fallback. The daemon deliberately does not make the model call
	 * itself: the picture is in the browser, a second upload of it per turn is the latency this
	 * feature exists to avoid, and a key-holding call on the coach's own thread is a way for a slow
	 * pre-pass to eat the turn it is supposed to precede — 12.3 seconds a read, measured, on the
	 * larger model.
	 *
	 * ## Nothing is believed before the client has had a say
	 *
	 * `frameReadFaults` is run against the truth this route cached on its own last poll, and a read
	 * that trips ANY of it is thrown away WHOLE rather than repaired — more icons than there are
	 * living players, his icon placed while he is on the respawn screen, or his own champion read as
	 * somebody else. Those are five facts the client settles for free without anyone having looked at
	 * the picture, and a read that contradicts them is not a hard read, it is a wrong one. The
	 * canary earns its place: with the answer set sorted so the first entry carried no hint, the
	 * reader named his own champion — the easiest portrait on the map — wrong 12 times in 60.
	 *
	 * ## And a refused read is a normal outcome
	 *
	 * 200 either way, with the reason. Vision failing must cost the coach a clause and never a line,
	 * so there is nothing here for the caller to treat as broken and nothing that makes the coach go
	 * quiet: `frameRead` simply returns to null and `buildFacts` says exactly what it says today.
	 */
	app.post("/live/frame-read", async c => {
		const body = (await c.req.json().catch(() => null)) as {
			read?: unknown
			crop?: unknown
		} | null
		const cached = lastTruth
		/*
		 * No game, or no poll since the last one ended. There is nothing to fence against, and an
		 * unfenced read is precisely the thing this design refuses to hold.
		 */
		if (!cached) return c.json({ accepted: false, reason: "no-truth" })
		const ctx = {
			myChampion: cached.truth.myChampion,
			enemyChampions: cached.truth.enemyChampions
		}
		/*
		 * A CROP instead of a read, because the browser cannot make the model call.
		 *
		 * This route was written to take a read the browser had already made — the picture is in
		 * the browser and a second upload per turn is latency. The credential does not exist: the
		 * page holds a `uses: 1` ephemeral token accepted only by the Constrained WebSocket
		 * endpoint, `generateContent` refuses it, and a raw key in the page is the one thing this
		 * app will not do. So the seam sat built and unreachable, which is why the screenshot still
		 * had nowhere to land.
		 *
		 * The latency argument does not survive its own number either: measured on a real journal
		 * frame the minimap crop is 17,122 bytes against the whole frame's 152,742, sent to
		 * 127.0.0.1 by a page that already uploads the whole frame here every five seconds for the
		 * journal. The `read` form is kept — scripts and the probes use it — and a crop simply
		 * takes the extra step of asking.
		 */
		if (typeof body?.crop === "string" && body.crop !== "") {
			const b64 = body.crop.replace(/^data:image\/\w+;base64,/, "")
			if (b64.length > 4_000_000) return c.json({ accepted: false, reason: "crop-too-big" })
			const out = await readMinimap({ jpegBase64: b64, truth: cached.truth })
			if (!out.read) {
				frameRead = null
				return c.json({
					accepted: false,
					reason: out.reason,
					ms: out.ms,
					...(out.faults ? { faults: out.faults.map(f => `${f.code} (${f.detail})`) } : {})
				})
			}
			const seen = observationFrom(out.read, lastFrameSide, cached.atSec)
			lastFrameSide = { where: seen.where, atSec: seen.atSec }
			frameRead = seen
			return c.json({ accepted: true, where: seen.where, confidence: seen.confidence, ms: out.ms })
		}
		// The coordinate form first, because it measured best. `RawFrameReadXY` refuses the
		// zone-name form on shape alone, so the fallback is a decode and never a guess.
		const xy = parseFrameReadXY(body?.read ?? null, ctx)
		const parsed = xy.read ? { read: asFrameRead(xy.read), rejected: null } : parseFrameRead(body?.read ?? null, ctx)
		if (!parsed.read) {
			frameRead = null
			return c.json({ accepted: false, reason: parsed.rejected ?? "schema" })
		}
		const faults = frameReadFaults(parsed.read, cached.truth)
		if (faults.length > 0) {
			frameRead = null
			return c.json({
				accepted: false,
				reason: "fenced",
				faults: faults.map(f => `${f.code} (${f.detail})`)
			})
		}
		const observation = observationFrom(parsed.read, lastFrameSide, cached.atSec)
		lastFrameSide = { where: observation.where, atSec: observation.atSec }
		frameRead = observation
		return c.json({ accepted: true, where: observation.where, confidence: observation.confidence })
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
		/*
		 * Sample here, on the read the coach already makes.
		 *
		 * A separate poll would double the traffic to the client during a game for data that is
		 * identical to what this call just fetched. `sampleLive` rate-limits itself on the game
		 * clock, so calling it every turn costs one comparison.
		 */
		const state = buildLiveState(data, me, data?.gameData?.gameTime ?? null, cachedBaseline())
		if (!state) return c.json({ inGame: false, text: "" })
		const focus = cachedFocus().map(f => f.fix).filter(f => f !== "")
		/*
		 * The focus list is appended OUTSIDE the ground-truth block and labelled as coming from
		 * past reviews. Inside it, under a heading that says "these are FACTS", a criticism from
		 * a game three days ago reads as something happening right now — which is how a coach
		 * ends up telling someone to stop doing a thing they are not currently doing.
		 */
		/*
		 * The block is rendered FOR THE SELECTED ARCHITECTURE, not once for both.
		 *
		 * `renderState` writes the fence's own instructions into the middle of the ground truth —
		 * "never say this unless it also appears in the list below", "the correct answer is PASS" —
		 * and those are not facts. Under `cite-or-quiet` they gag the arm this app measured as
		 * 13.5x more useful, from inside the block, where no prompt change can reach them. See
		 * `shared/live-coach-mode.ts` for what each repair is and what it was measured against.
		 */
		return c.json({
			inGame: true,
			text: `${renderBlockForMode(state, getSettings().liveCoachMode)}${
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
		/*
		 * The SYSTEM PROMPT rides with the token, and it has to.
		 *
		 * The browser cannot build it: the champion clauses come from `knowledge/champions/*.md`,
		 * which is a filesystem the renderer has no access to, and the mode is a setting the daemon
		 * owns. The page used to hold a hardcoded `LIVE_COACH_SYSTEM_PROMPT`, which meant the mode
		 * picker in Settings changed the block and not the standing instructions — a coach told to
		 * speak only from a list it was no longer being given one.
		 *
		 * It is minted with the token rather than fetched separately because the socket already
		 * blocks on this call before `setup`, and a second request is a second thing that can fail
		 * in the one place where failing means connecting with no prompt at all.
		 */
		const champion = await lockedChampion()
		return c.json({
			ok: true,
			...minted.value,
			systemPrompt: liveCoachSystemPrompt({
				mode: getSettings().liveCoachMode,
				championKnowledge: liveChampionKnowledge(champion)
			}),
			// Echoed so a transcript can say which champion's knowledge the session was opened on.
			champion
		})
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
	 * `GET /api/live/coach/providers` — which models the live coach can be pointed at.
	 *
	 * Reports availability, never the key. A provider with no key is listed as unavailable with a
	 * sentence the UI can show, because an option that silently does nothing is worse than one
	 * that says why it cannot.
	 */
	app.get("/live/coach/providers", c => c.json({ providers: providerStatus() }))

	/**
	 * `PUT /api/live/coach/key/:provider` — store a provider key, or clear it with an empty body.
	 *
	 * Write-only, like the Gemini key. Nothing reads a key back to the browser.
	 */
	app.put("/live/coach/key/:provider", async c => {
		const p = providerById(c.req.param("provider"))
		if (!p) return fail(c, 404, "no such provider", "unknown-provider")
		const body = (await c.req.json().catch(() => null)) as { key?: unknown } | null
		if (typeof body?.key !== "string")
			return fail(c, 400, "send { key } — an empty string clears it", "bad-key")
		setProviderKey(p, body.key)
		return c.json({ ok: true, available: body.key.trim() !== "" })
	})

	/**
	 * `POST /api/live/coach/turn` — one coaching turn from a turn-based provider.
	 *
	 * The browser sends the frame and the block; the daemon holds the key and the system prompt.
	 * Answers 200 in every state including failure, because this is called from a live game and an
	 * error status would surface as a broken coach rather than a quiet one.
	 */
	app.post("/live/coach/turn", async c => {
		const body = (await c.req.json().catch(() => null)) as {
			provider?: unknown
			model?: unknown
			frame?: unknown
			block?: unknown
		} | null
		if (typeof body?.provider !== "string" || typeof body?.block !== "string")
			return c.json({ ok: false, text: "", reason: "provider and block are required" })
		const frame =
			typeof body.frame === "string" ? body.frame.replace(/^data:[^,]+,/, "") : undefined
		/*
		 * The mode and the champion are resolved HERE, never taken from the request.
		 *
		 * `coachTurn`'s invariant is that the prompt text is not a parameter, so a bench comparison
		 * cannot accidentally have varied the wording as well. A browser that could post a mode
		 * would be one step from a browser that posts a prompt; the daemon owns the setting and the
		 * champion notes, so it owns both halves of what the model is told.
		 */
		const r = await coachTurn({
			provider: body.provider as never,
			...(typeof body.model === "string" ? { model: body.model } : {}),
			...(frame ? { frameJpegBase64: frame } : {}),
			blockText: body.block,
			mode: getSettings().liveCoachMode,
			champion: await lockedChampion()
		})
		return c.json(r)
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

/**
 * Rebuild a block from a recorded `allgamedata` sample, for the benchmark.
 *
 * Exported so `scripts/bench-providers.ts` replays states through the SAME code the daemon runs,
 * rather than a second reconstruction that could quietly drift from it. A comparison whose harness
 * builds a different block from the coach's is measuring a different thing.
 *
 * Returns null for a sample that cannot produce a state — the loading screen, a torn line — so a
 * replay skips it rather than inventing one.
 */
export const buildLiveStateForBench = (
	raw: unknown,
	gameTimeSec: number,
	/*
	 * His rolling farm average, when the caller has one.
	 *
	 * Omitted, `pace` is null and the block says so — honest, but NOT what a real game looks
	 * like: the daemon always has a baseline from `loadCorpus`, and the `Farm baseline:` line is
	 * where several of the measured inventions came from ("ahead of your usual pace of 85"). A
	 * fixture meant to be 1:1 with a real game has to be able to carry it, so
	 * `scripts/build-fixture.ts` passes the corpus baseline with the replayed game EXCLUDED —
	 * including it would let the game being replayed set its own average.
	 *
	 * Defaulting to null keeps `scripts/bench-providers.ts` byte-identical to what it replayed
	 * before.
	 */
	baseline: ReturnType<typeof baselineFromRows> | null = null
): VisionState | null => {
	const data = raw as LiveAllGameData | null
	const me = findMe(data ?? ({} as LiveAllGameData))
	if (!data || !me) return null
	return buildLiveState(data, me, gameTimeSec, baseline)
}
