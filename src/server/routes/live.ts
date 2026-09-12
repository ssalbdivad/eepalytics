/**
 * `GET /api/live` — coaching for the game happening right now.
 *
 * ## Read-only, always
 *
 * This reads the in-game Live Client Data API on :2999, which serves information already on the
 * player's own screen. Nothing is written, no input is sent, nothing is automated — the same
 * category as the overlays people already run. The app no longer writes to the client at all —
 * `src/daemon/gate.ts`, which used to guard those writes, was deleted along with the last of them.
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
import { projectTick } from "../../analysis/live-events.ts"
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
import { pronunciationsFor, renderPronunciationGuide } from "../../shared/pronounce.ts"
import type { Pronunciation } from "../../shared/pronounce.ts"
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
import { QUEUE_NAMES, TEAM_BLUE, TEAM_RED, USER_PUUID } from "../../shared/constants.ts"
import { liveCoachSystemPrompt, renderBlockForMode } from "../../shared/live-coach-mode.ts"
import type { LiveCoachMode } from "../../shared/live-coach-mode.ts"
import { liveChampionKnowledge } from "../../review/live-coach-knowledge.ts"
import { fullKnowledge } from "../../review/live-knowledge-full.ts"
import { buildBrief, buildDelta } from "../../shared/live-brief.ts"
import type { PositionFix } from "../../shared/live-brief.ts"
/*
 * The coach's memory of its own game, which is the thing the turn protocol was missing.
 *
 * Four calls, and each is a different half of "what has already happened here":
 *   `observe`    — every sample, so the log outlives the client's own short event array;
 *   `noteSaid`   — every spoken line, fed from the REAL transcript route, which is the only place
 *                  the coach's own words exist on this side of the wire;
 *   `renderSaid` — the section the delta prints.
 *
 * There is no reset function and none is wanted: the state is a plain growing log, so a new game
 * is `newMemory()`. Carrying one across a game boundary is the same class of bug as a socket
 * spanning two games — game one's advice spoken into game two.
 */
import {
	cpSeenAt,
	deathsSeen,
	newMemory,
	noteSaid,
	observe,
	renderGameSoFar,
	renderSaidWithin
} from "../../analysis/coach-memory.ts"
import type { MemoryState } from "../../analysis/coach-memory.ts"
import { openSessionStatus, writeFrame } from "../../daemon/journal.ts"
import {
	latestMinimapRead,
	minimapTrack,
	minimapWatchStatus,
	offerFrame as offerMinimapFrame,
	resetMinimapWatch,
	takeMinimapReads
} from "../../daemon/minimap-watch.ts"
import { buildFacts, FRAME_FRESH_SEC, newFactMemory, resetFactMemory } from "../../analysis/live-facts.ts"
import type { FrameObservation } from "../../analysis/live-facts.ts"
import {
	asFrameRead,
	pctOf,
	coarseOf,
	zoneLabelForTeam,
	frameReadFaults,
	parseFrameRead,
	parseFrameReadXY,
	truthFromState
} from "../../review/frame-read.ts"
import type { TeamId, Zone } from "../../shared/map.ts"
import { readMinimap } from "../../review/read-minimap.ts"
import type { Coarse, FrameRead, FrameReadXY, FrameTruth } from "../../review/frame-read.ts"
import { reachFromLive } from "../../analysis/reach-live.ts"
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
/**
 * The previous raw `allgamedata` payload, for the brief's delta section.
 *
 * Module scope because the brief's "what he is doing right now" is a DIFFERENCE — CS ticking, gold
 * ticking, health falling — and a stateless route has nothing to difference against. One payload,
 * overwritten each poll: the coach only ever asks what changed since the last thing it was told.
 */
let previousSample: { raw: unknown; gameTimeSec: number } | null = null

/**
 * The coach's memory of what it has already said this game, and of the states it said it into.
 *
 * Module scope for exactly the reason `factMemory` is: one local user, one game at a time, one
 * process. It is the daemon's copy on purpose — the browser holds the socket, but the browser is
 * also the thing that is reloaded mid-game, and a memory that dies with a page refresh is not a
 * memory. Fed from `POST /live/gemini/transcript`, which already receives every spoken line.
 */
let coachMemory: MemoryState = newMemory()

/**
 * The last few blocks SERVED, by turn number, so a reply can be matched to the block it answered.
 *
 * Small and bounded: a reply that arrives more turns late than this is one the memory is better
 * off dating from `turnSeq` than from a guess. Cleared with the sequence, because a turn number
 * from the previous game names a different block.
 */
const servedTurns = new Map<number, { servedAtMs: number; gameTimeSec: number }>()
const SERVED_TURNS_KEEP = 8

/** The roster the current `coachMemory` belongs to. A different one is a different game. */
let memoryRoster: string | null = null

/**
 * How stale the last payload may be before the next one has to be a FULL brief again.
 *
 * A delta is a sentence about a difference, and a difference against a sample from a minute ago is
 * not the difference the model is being told it is. Turns are seconds apart in normal running, so
 * anything past this gap means something broke — a reconnect, a backgrounded tab, a run of failed
 * fetches — and the honest repair is to re-establish the whole picture rather than to describe a
 * change nobody saw the start of.
 */
/**
 * How stale a sequence may get before the next payload is a full brief again.
 *
 * Raised from 45 because 45 is inside the real turn spacing. The stored `--every 30` run has
 * inter-turn gaps of 42.6s repeatedly and one of 48.75s, which resynced — producing two full briefs
 * where the bench's own comment claims "1 is the healthy number for a whole game" and this never
 * fires. In the app, `TURN_CHOICES` offers a 40s beat, so a single skipped poll gives an 80s gap.
 * A resync is expensive (it re-sends the whole roster table), so the threshold belongs well clear
 * of the slowest offered beat rather than just above the fastest.
 */
const RESYNC_AFTER_SEC = 90

/**
 * Bytes the utterance log may take out of the delta before its oldest rows are dropped.
 *
 * It had none, and it grows: its rows gain verdict text as windows close, so from about 3:00 of
 * the stored run it plateaued above `DELTA_HARD_CAP` and evicted CLOCKS — the objective timers —
 * from every remaining turn of the game. A section with no budget is a section that spends
 * everyone else's.
 */
const SAID_BUDGET = 380

/** The same, for the accumulated beat log. See `renderNarrativeWithin`. */
const NARRATIVE_BUDGET = 380

/**
 * Where the trusted protocol's turn sequence lives. Null means "no sequence": the next payload is
 * the full brief.
 *
 * The DAEMON owns this rather than the page, because the daemon is the only side that knows what it
 * has already sent. The page can ask for a resync (it knows when its socket is new, which the daemon
 * cannot see) but it cannot be the record of what the thread already holds.
 */
let turnSeq: {
	turns: number
	lastAtSec: number
	roster: string
	/**
	 * Wall clock when the payload went out, which is how the coach's own latency gets MEASURED
	 * rather than assumed.
	 *
	 * `noteSaid` wants the delay between a brief being built and the first syllable, because that is
	 * what turns "he said it at 4:03" into "he was heard at 4:06" — and a countdown that expires in
	 * between is a line the player hears after it stopped being true. The daemon is the only side
	 * that sees both ends: it served this block, and the transcript for the line it produced comes
	 * back through this same process.
	 */
	servedAtMs: number
} | null = null

/**
 * A game's identity, from the only thing in `allgamedata` that has one.
 *
 * There is no game id in this feed. The roster is the next best invariant and it is a good one: two
 * consecutive games with the same ten champions in the same order is not a case worth defending
 * against, and the clock going backwards catches it anyway.
 */
const rosterKey = (data: LiveAllGameData): string =>
	(data.allPlayers ?? []).map(p => p.championName ?? "?").join("|")

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
 * The ENEMY JUNGLER's champion, for the counterpart half of the knowledge pack.
 *
 * Derived exactly as `buildLiveState` derives it — declared position first, Smite second, because
 * Smite is renamed on upgrade and a name equality test recognised 18.5% of the real ones.
 *
 * ## The gameflow fallback, which is the whole reason this is not one read
 *
 * It used to read `allgamedata` and stop, and the comment here said "in champ select there is no
 * `allgamedata` at all, so the socket opens with only his own champion's notes". That was written
 * as a graceful degradation and it is in fact the ONLY case: the socket's system instruction is
 * minted exactly once, at ChampSelect (`isCoachingPhase` includes it, and `ScreenCoach` calls
 * `gem.start()` on `gate.armed`), which is precisely when :2999 answers nothing. So
 * `fullKnowledge({ champion, counterpart: null })` dropped the entire `# THE ENEMY JUNGLER` section
 * for the LIFE of every socket — for the whole game — while `TRUSTED_PROMPT` told the model "both
 * junglers' champion notes are at the end of these instructions, in full", and
 * `knowledge/champions/briar.md` was dead on arrival.
 *
 * Worse for comparison work: the turn-based route resolves the counterpart PER TURN and does get
 * it, so `trusted` was two different prompts depending on transport — the exact confound
 * `coachTurn`'s no-prompt-parameter invariant exists to prevent, and the same defect class as the
 * `socketSystemPrompt` fix. `lockedChampion` one function above already answers this same "not yet"
 * from the gameflow session; this is that fallback, on the other half of the matchup.
 *
 * `buildMatchupBrief` owns the derivation there for the same reason `championFromSession` uses it:
 * during the draft the roster rows lag a swap, and resolving that a second time by hand is how the
 * two would drift. Its own basis rules are the ones above — declared position first, the lone enemy
 * Smite holder second — so both paths agree by construction.
 *
 * `null` on every real failure. A wrong counterpart would put a whole matchup essay in the prompt
 * about a champion not in the game, which is worse than none.
 */
const lockedCounterpart = async (): Promise<string | null> => {
	const handle = await lcu()
	if (!handle) return null
	const data = await handle.live.allGameData().catch(() => null)
	const me = data ? findMe(data) : null
	if (data && me) {
		const enemies = (data.allPlayers ?? []).filter(p => p.team !== me.team)
		const byRole = enemies.find(p => (p.position ?? "").toUpperCase() === "JUNGLE")
		const jungler = byRole ?? enemies.find(hasSmite)
		if (jungler?.championName) return jungler.championName
	}
	const session = await handle.client.gameflowSession().catch(() => null)
	if (!session) return null
	// Both hourly-cached and no-ops in the common case; without them every id resolves to "".
	await refreshChampionNames()
	await refreshSummonerSpellNames()
	return counterpartFromSession(session, championName)
}

/**
 * The enemy jungler off a gameflow session. Pure, so the route test can mint a ChampSelect prompt.
 *
 * Split out for the same reason `championFromSession` is: the interesting half is a join the draft
 * makes awkward, `buildMatchupBrief` already resolves it, and a second copy is a second thing to
 * drift. `null` for every "not yet" — no roster, no lock, an unknown id, a phase that is not a
 * game, or a counterpart the brief could not identify at all.
 */
export const counterpartFromSession = (
	session: GameflowSession,
	nameOf: (championId: number) => string
): string | null => {
	if (!isCoachingPhase(session.phase)) return null
	const { brief } = buildMatchupBrief({
		session,
		puuid: USER_PUUID,
		championName: nameOf,
		/*
		 * SPELLS ARE READ HERE, unlike in `championFromSession`, and the difference matters.
		 * `buildMatchupBrief` falls back to the lone enemy Smite holder when nobody declared a
		 * position — which is most solo-queue drafts — and `hasSmite` needs the spell NAME to do
		 * it. `championFromSession` only ever wanted `brief.you`, so it could pass a stub.
		 */
		spellName: summonerSpellName
	})
	const champion = brief?.opponent?.champion ?? ""
	return champion === "" ? null : champion
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
 * Both live in `analysis/live-facts.ts` — pure, tested, and shared with the benches. They used to
 * be inlined here and hand-copied into the eval with the tuning constants re-typed as bare
 * literals, which meant the eval was scoring a lookalike of the coach rather than the coach. One
 * definition, or the measurement is fiction.
 *
 * Module-level memory is right for this daemon: one local user, one game at a time. It is reset
 * whenever there is no game.
 */
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
 * When this was written the coach could only speak from the ranked list `buildFacts` returns, and
 * every candidate in that list was computed from the game client. Measured: two coaching arms of 14
 * turns, identical blocks and prompt, differing only in whether the frame was attached, made the
 * same speak-or-PASS call on 13 of 14 turns — while the same model read the clock off those same
 * frames 6 times in 6. The screenshot was being looked at and had nowhere to land.
 *
 * The list is no longer a fence (`shared/live-coach-mode.ts`, default `trusted`) and this seam
 * outlived it: a position read has to be MADE somewhere whatever reads it, because the coach's own
 * view of a downscaled minimap is at chance. `POST /api/live/frame-read` and `daemon/minimap-watch.ts`
 * are where it is made, `buildFacts` still decides what it is worth for the ranked modes, and
 * `buildBrief` renders it for the default one. These hold the one observation in between.
 *
 * Module-level for the same reason `factMemory` is: one local user, one game at a time, one process.
 */

/** The last read that survived the client's fence, or null. Handed to `buildFacts` as `frame`. */
let frameRead: FrameObservation | null = null
/**
 * The accepted read's PROSE zone and its anonymous enemy icons, kept beside the coarsened
 * observation because `FrameObservation` throws both away at the door and `PositionFix` needs them.
 * Cleared in lockstep with `frameRead` — a label surviving a refused read would put last minute's
 * position into this minute's brief.
 */
let frameZone: { you: Zone; enemies: Zone[] } | null = null

/**
 * Forget the picture. Every variable above, in one call, from every branch that ends a game.
 *
 * A frame read belongs to the game it was taken in, and carrying one across is the same class of
 * bug as a socket spanning two games: the roster changes, the clock restarts, and a half of the map
 * from the last game would gate a real objective call in the first minute of the next one.
 *
 * IT IS A FUNCTION BECAUSE THE ONE CALL SITE IT HAD WAS UNREACHABLE. The reset lived inline in
 * `buildLiveState`'s out-of-game branch, and under `trusted` — the shipped default —
 * `GET /live/ground-truth` returns above `buildLiveState` entirely. So in the shipped app nothing
 * ever cleared these: the first minimap read of game N+1 was fenced by `frameReadFaults` against
 * game N's roster, the response schema handed to the model enumerated game N's champions, and the
 * read was stamped from game N's FINAL poll — a paid Gemini call checked against the wrong game,
 * saved from becoming a false claim only by `pictureLine`'s `ageSec < 0` guard.
 *
 * `frameZone` was in NO reset list at all, despite its own doc claiming it is "cleared in lockstep
 * with `frameRead`". That is the failure a hand-written list produces on its next field, which is
 * the same reason `resetFactMemory` exists one line above the old copy of this.
 */
const resetFrameState = (): void => {
	frameRead = null
	frameZone = null
	carriedRead = null
	carriedZone = null
	carriedPct = null
	lastFrameSide = null
	lastTruth = null
	/*
	 * And the watcher's own track, including reads that were accepted but not landed yet.
	 *
	 * The watcher rolls its track on a new journal session by itself, which is the earlier and more
	 * reliable of the two signals. This is the other end of the same rule, for the case where the
	 * daemon notices the game ended before the next frame arrives: a read accepted at 28:14 of game
	 * N must not be drained into game N+1's first turn.
	 */
	resetMinimapWatch()
}

/**
 * Land every accepted read the watcher has taken since the last turn, in order.
 *
 * THE ORDER AND THE EXACTLY-ONCE ARE LOAD-BEARING, which is why this drains a queue rather than
 * reading a latest-value. `observationFrom` marks a read `low` when it disagrees with the previous
 * one taken inside `FRAME_FRESH_SEC` — the measured 7% where two looks at one picture part company
 * — and that comparison is only meaningful against the read that actually came before it. Skipping
 * the middle of three reads would compare two that are ten seconds apart and call an honest
 * rotation a disagreement.
 *
 * EVERY RULE ABOUT WHAT A READ MEANS STAYS WHERE IT WAS. This function supplies; `observationFrom`,
 * `carryable`, `landRead`, `pictureLine` and `buildFacts` decide. That separation is the whole
 * reason the watcher was worth building as a supply change: the ranked modes' rules — a refusal
 * nulls `frameRead`, `FRAME_FRESH_SEC` is re-checked downstream — are untouched, and every stored
 * measurement of them was taken under exactly those rules.
 */
const drainMinimapReads = (): void => {
	for (const taken of takeMinimapReads())
		landRead(observationFrom(taken.read, lastFrameSide, taken.atSec), zoneSideOf(taken.read), taken.xy)
}

/*
 * THE ROLLING LAST-KNOWN READ, and why it is a SECOND pair of variables rather than a relaxed rule
 * on the first.
 *
 * `frameRead` is what the RANKER is handed, and the ranker uses the read as a GATE as well as a
 * sentence ("drake is back in 40s — looks like you're topside, walk down"). Its rules are the strict
 * ones and they are not mine to widen: a refused read nulls it, and `buildFacts` re-checks
 * `FRAME_FRESH_SEC` on top of that. Every stored measurement of the ranked modes was taken under
 * exactly those two rules, so they are left byte-identical by construction — nothing below touches
 * the variables they read.
 *
 * The BRIEF is a different consumer with a different job. It does not gate on the position, it
 * PRINTS it, and a printed position carries its own age. So the brief gets the last read that was
 * accepted, placed and undoubted, whether or not the current turn produced one.
 *
 * ## The defect this exists for
 *
 * 42% of the event-driven turns on the graded run of game 5639406342 were REACTIVE — a death, a
 * respawn, `resource.low` — and a reactive turn deliberately skips the 1.3-3.0s minimap call,
 * because a death's premise is 40% stale at one second. Correct, and it meant the position reached
 * the model on 7 of 23 turns, absent on precisely the turns where where-he-is matters most. A turn
 * that is racing has no business paying for a read; it has every business seeing the read from
 * eleven seconds ago.
 *
 * ## A REFUSAL DOES NOT TOUCH THIS, in either direction
 *
 * A refused read is not evidence about anything — not about where he is, and not about the read
 * that came before it. 44% of reads on the graded game were refused and the fence was right every
 * time (16 of them were the model pointing at a red-ringed Singed inside his camera box). So a
 * refusal neither lands here nor clears what is here, and a game in which nothing was ever accepted
 * carries nothing: silence stays silence.
 */
let carriedRead: FrameObservation | null = null
let carriedZone: { you: Zone; enemies: Zone[] } | null = null
/*
 * The SAME carry, in the units the reachability arithmetic needs.
 *
 * `carriedRead` is prose and a coarse half; `carriedZone` is a 13-way label. Neither can be
 * subtracted from a pit's coordinates, so the accepted read's own percentages ride alongside them
 * and age exactly as they do. Written only by `landRead`, like the other two, so a refusal cannot
 * displace it and a doubt cannot become one.
 */
let carriedPct: { pct: { left: number; top: number }; atSec: number } | null = null

/**
 * How old the last-known read may be before the brief stops printing it at all.
 *
 * MEASURED, on the 94 stored games, by the only sub-minute position source the post-game timeline
 * has: a participant frame is stamped once a minute, but a ChampionKill or ELITE_MONSTER_KILL
 * carries its own position and its own millisecond stamp, so pairing a frame with a later event the
 * player was IN gives 2,602 (lag, same-coarse-zone?) pairs at lags from zero to a minute. Chance
 * agreement — guessing his half from the marginal distribution alone — is 31.8%.
 *
 *      0-5s   n=234   96.2% same half    (this end of the range is `FRAME_FRESH_SEC`, and a fact)
 *      5-10s  n=220   88.2%
 *     10-15s  n=205   77.1%
 *     15-20s  n=218   76.1%
 *     20-25s  n=243   70.4%
 *     25-30s  n=208   67.3%
 *     ------------------------------ the knee
 *     30-35s  n=212   51.9%
 *     35-40s  n=225   46.7%
 *     40-45s  n=212   44.3%           and then FLAT: 48.9 / 42.8 / 46.2 out to 62s
 *
 * THE BREAK IS REAL AND NOT AN ARTEFACT OF WHERE THE BUCKETS WERE DRAWN. The decay from 0 to 30
 * seconds is gradual — about six points per five seconds — and then one 5-second bucket costs
 * fifteen, after which the curve is flat at a coin flip all the way to a minute. Something commits
 * a jungler to a half for about half a minute (a clear, a gank, a pit) and past that he has
 * rotated, so an older read is not a weaker version of the same fact, it is a different fact.
 *
 * Thirty seconds is therefore where a coarse read stops being a better-than-even bet about the half
 * he is on. Past it the line would still be TRUE — it is rendered in the past tense, with its age —
 * but true and uninformative, and this payload has a fixed character budget in which an
 * uninformative line is paid for by whatever falls off the bottom. A second measurement, at minute
 * granularity over whole games rather than around events, agrees about where this ends: 36.0% at a
 * 60s lag against 31.8% chance, and 25.6% at 120s, which is BELOW chance — a jungler's
 * topside/botside oscillation makes a two-minute-old read actively misleading.
 *
 * The reader's own accuracy (17 of 18 on his half) is a separate factor and is not compounded in
 * here; it is stated in the line itself.
 */
export const CARRY_MAX_SEC = 30

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
 * during a game for data the ground-truth poll fetched a moment ago.
 *
 * `atMs` IS WHY THE READER WAS PAID FOR AND NEVER HEARD. `atSec` used to double as the stamp on the
 * read as well as the fence, on the argument that the browser grabs its frame from the same screen
 * it is polling this route about — "an approximation of a few seconds". It is not a few seconds, and
 * the size of the error is a whole BEAT: a turn does the read FIRST and fetches the block after it
 * (`geminiLive.ts`), so the poll this route has cached when a crop arrives is the previous turn's.
 * The two cadences then part company, and the ranked modes lost outright:
 *
 *   cite-or-quiet / fenced, 20s beat   age 21-23s against FRAME_FRESH_SEC of 10 — DISCARDED, every
 *                                      read, every turn, in every game ever played
 *   trusted, 6s beat                   age ~7s for a picture taken ~1.3s ago — inside the window,
 *                                      but printed into the brief five seconds older than it is,
 *                                      and one skipped beat puts it outside
 *
 * The bill was paid in full either way: on game 5639406342 the reader is 7/8 exact on the zone with
 * 1.8% median position error, 101 reads cost a measured p50 1,239ms apiece, and in the mode that
 * ranks facts not one of them ever modified or gated a line.
 *
 * So the wall clock rides along and `frameClockSec` carries the game clock forward to the instant
 * the crop actually arrived. See it for why an extrapolation is allowed here at all.
 */
let lastTruth: { truth: FrameTruth; atSec: number; atMs: number } | null = null

/**
 * The game clock a picture arriving NOW was taken at, carried forward from the last poll.
 *
 * The game clock and the wall clock advance together while a game is running, so this is exact
 * rather than a guess for the whole of a normal game — the LCU's `gameTime` is a stopwatch, and the
 * only thing that separates the two is a PAUSE, which stops the game clock while the wall clock
 * keeps going.
 *
 * That single failure mode is why this is safe to do at all: a pause makes the answer too LARGE,
 * never too small. A stamp in the future is thrown away whole by `buildFacts` (`nowSec - atSec >= 0`)
 * and by the freshness rule at the `where` call site, so the direction of failure is the coach
 * saying nothing about where he is — the same cheap direction every other rule around this read
 * chooses. The reverse would be the expensive one: a picture presented as fresher than it is, which
 * is precisely the inverted half `FRAME_FRESH_SEC` exists to prevent.
 *
 * Clamped at zero because a clock that has gone backwards is a new game, not a negative age.
 *
 * The two stamps are taken in the order that fails the same way: `atMs` is read AFTER the poll it
 * belongs to has come back, so it is a few milliseconds LATER than the clock it is paired with, and
 * the extrapolation therefore lands a hair short rather than a hair long — an age over-stated by
 * the round trip, which the bridge measures at 2.3ms against a ten-second window.
 */
export const frameClockSec = (
	cached: { atSec: number; atMs: number },
	nowMs: number
): number => cached.atSec + Math.max(0, (nowMs - cached.atMs) / 1000)

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

/**
 * The picture as the ONE sentence the brief prints, or nothing at all.
 *
 * Exported and pure for the same reason `observationFrom` is: every rule about whether the read may
 * be spoken of lives in one testable place rather than inside a handler that needs a running game
 * to reach. `shared/live-brief.ts` renders this verbatim inside NOW and computes nothing from
 * pixels, so the hedging has to be IN THE STRING — which half, how old, and where it came from.
 *
 * FOUR WAYS TO BE NOTHING, and all four are silence rather than a guess:
 *
 *   - no read at all — the pre-pass is off, the call failed, or the client's fence threw it away
 *     whole (44% of reads on the graded game were refused, and that refusal is the reader working:
 *     16 of them were the model pointing at a red-ringed Singed inside his camera box);
 *   - a read that could not place him, which the reader is offered precisely so guessing is never
 *     its only move;
 *   - a read two consecutive looks disagreed about — the measured 7% arriving;
 *   - a picture old enough to be about somewhere else, or stamped ahead of the clock.
 *
 * The confidence is quoted as the measurement rather than as a word. `medium` is the ceiling this
 * reader has by construction and "a read of a picture" alone does not say how good a read; 17 of 18
 * is a figure the model can price a sentence against, and it is the same figure `FrameObservation`
 * is documented with. ENEMY icons are not here and their absence is the finding: 63% per-icon zone
 * accuracy is not shippable as a claim that SENDS HIM SOMEWHERE.
 */
export const pictureLine = (read: FrameObservation | null, nowSec: number): string | null => {
	if (read === null || read.where === null || read.confidence === "low") return null
	const ageSec = nowSec - read.atSec
	/*
	 * TWO WINDOWS, because there are two honest things to say and they are not the same sentence.
	 *
	 * `FRAME_FRESH_SEC` — ten seconds, the ranker's one freshness rule, imported rather than retyped
	 * — is where a read is still a statement about the PRESENT: measured, the half holds on 92.3% of
	 * 454 pairs at that age. A jungler crosses from his topside jungle to the drake pit in the high
	 * teens of seconds, so past it a present-tense claim can be exactly INVERTED, and an inverted
	 * half is worse than no half: it is specific, confident, and it sends him back the way he came.
	 *
	 * `CARRY_MAX_SEC` — thirty — is where a read stops being worth PRINTING AT ALL, in any tense.
	 * Between the two the sentence changes tense rather than disappearing, which is the whole of
	 * this round's position work: see `carriedRead` for the reactive turns that had nothing, and
	 * `CARRY_MAX_SEC` for the measured cliff at thirty seconds.
	 *
	 * The upper test was absent entirely once and the age was clamped with `Math.max(0, …)`, which
	 * is the one shape that converts an honest failure into a dishonest one: a read the browser
	 * stopped refreshing printed as "0s ago" forever, and so does a stamp from the future, which is
	 * what a PAUSED game produces (see `frameClockSec`). Both are still simply not in the brief.
	 */
	if (ageSec < 0 || ageSec > CARRY_MAX_SEC) return null
	/*
	 * "YOUR own icon", not "his". The pronoun is the whole sentence.
	 *
	 * This line was written in the third person while every other line of the payload addresses the
	 * player in the second — NOW opens "Lillia (JUNGLE) lvl 6, alive" and NEXT opens "You: blue-side
	 * jungle (top)" — and the only other person in the payload is the enemy jungler. So "his own
	 * icon read topside" had a genuinely ambiguous referent, and the coach resolved it the wrong
	 * way. Measured on the 23-turn event-driven run of game 5639406342: of the seven turns that
	 * carried this line, THREE produced an inverted claim about the counterpart —
	 *
	 *   6:46  "Kayn's been spotted topside"      (Kayn was botside, dragon pit)
	 *   15:54 "Kayn ... just appeared topside"   (Kayn was river-bot, then mid)
	 *   23:01 "Kayn was just spotted botside,
	 *          so absolutely take this Baron"    (Kayn was standing IN the baron pit)
	 *
	 * — each one his OWN position, repeated back to him as the enemy's, and the last of them sends
	 * him into a Baron the enemy jungler is already at. A read that is 17-of-18 accurate about the
	 * right person becomes worse than no read at all when the sentence names the wrong one.
	 *
	 * The measurement accuracy clause used to keep "his own half" on the argument that there it
	 * refers to the SUBJECT of the hand-scoring rather than to anyone in this game. That argument is
	 * correct and it does not matter: the model does not know which "his" is a citation, and a
	 * sentence whose only job is that there is exactly one person in it cannot afford to introduce a
	 * second one in a subordinate clause. It says "your own half" now.
	 */
	/*
	 * NOT ONE THIRD-PERSON WORD IN EITHER TENSE, and the accuracy clause is the reason this is worth
	 * a note. It used to read "right about the player's own half", which is not a pronoun but is
	 * still a third party appearing in a sentence whose entire job is that there is only one person
	 * in it. `live-brief.test.ts` pins the rendered section against a pronoun list; this is the text
	 * that has to survive it.
	 */
	const whose = `A read of a picture, right about your own half on 17 of 18 hand-scored reads, not something this feed knows`
	return ageSec <= FRAME_FRESH_SEC ?
			`YOUR own icon read ${read.where} on the minimap ${Math.round(ageSec)}s ago — this is where YOU are, not where anyone else is. ${whose}`
		:	`YOUR own icon read ${read.where} on the minimap ${Math.round(ageSec)}s ago — that is where YOU WERE then, not where anyone else was, and old enough that you may have moved since. ${whose}`
}

/**
 * The SAME read, as data, for the prospective joins in NEXT — or nothing, on exactly the same rules.
 *
 * `pictureLine` above is prose, and prose can only be printed. The join this round is chasing —
 * "drake is up in 45s and you are in base with 100g" — needs the position as a VALUE, because
 * something has to compare the pit's side with his. `shared/live-brief.ts` will do that comparison
 * in TypeScript when it is handed a `PositionFix`, and it was never handed one: the route passed
 * `where` and stopped, so `prospectHead` printed "no position read this turn" on every turn of
 * every game while the read sat in `frameRead` one field away. That is the second half of the same
 * defect as the clock stamp — the reader ran, was paid for, and was discarded.
 *
 * GATED THROUGH `pictureLine` RATHER THAN BESIDE IT, deliberately. Two gates over one read is two
 * places to drift, and the failure that drift produces is the worst shape available here: NOW
 * saying nothing about where he is while NEXT confidently joins an objective to a position the
 * prose declined to state. One `null` check, so the prose and the data are true together or absent
 * together.
 *
 * The label and the enemy icons cannot come from `FrameObservation` — it is coarsened at the door,
 * which is the right thing for a fact that gates a sentence — so the accepted read's own zone is
 * kept beside it by the endpoint and passed in here. Enemy icons stay ANONYMOUS: the reader cannot
 * tell Kayn's dot from Singed's, and 16 of its refusals on the graded game were exactly that
 * mistake.
 */
/**
 * The accepted read's ZONES — his and the anonymous enemy icons. Null when it could not place him.
 *
 * ZONES AND NOT LABELS, which is the fix for an inversion. `zoneLabel` is blue-absolute by design
 * ("blue-side jungle (top)"), and the label was minted here, where nothing knows which side he is
 * on. Rendered into the delta that reads `You: blue-side jungle (top), 3s old.` — and on a red-side
 * game that sentence means he is standing in the ENEMY jungle, with nothing in the payload to
 * settle it. The team id is known one layer up, so the label is minted one layer up.
 */
const zoneSideOf = (read: FrameRead): { you: Zone; enemies: Zone[] } | null =>
	read.you === null ? null : { you: read.you, enemies: [...read.enemiesOnMinimap] }

/**
 * Land an accepted read in BOTH stores, and nowhere else.
 *
 * `frameRead`/`frameZone` are the ranker's, and are nulled by a refusal one line up in every branch
 * that calls this. `carriedRead`/`carriedZone` are the brief's and survive a refusal — so the only
 * way into them is an acceptance, and this is the one function that performs one.
 *
 * A `low`-confidence observation (two consecutive reads disagreed about his half, the measured 7%
 * arriving) or one that placed nobody is accepted by the fence and still does not land: it is not a
 * read of a position, so carrying it forward would be carrying a doubt as though it were a fact.
 * The previous carried read is left exactly where it is, because a doubt is not evidence against it
 * either.
 */
/**
 * Whether a read is worth REMEMBERING past the turn it was taken on — pure, so it can be pinned.
 *
 * A read that placed nobody, or one two consecutive looks disagreed about, is a doubt rather than a
 * position. Carrying a doubt forward would launder it into a fact on the next turn, when the doubt
 * itself has aged out of view. It also does not DISPLACE the read already carried, because a doubt
 * is not evidence against one either.
 */
export const carryable = (
	seen: FrameObservation,
	zone: { you: Zone; enemies: Zone[] } | null
): boolean => seen.where !== null && seen.confidence !== "low" && zone !== null

const landRead = (
	seen: FrameObservation,
	zone: { you: Zone; enemies: Zone[] } | null,
	/** The read as a POINT. Absent on the legacy zone-name body, which carries no coordinates. */
	xy?: FrameReadXY | null
): void => {
	lastFrameSide = { where: seen.where, atSec: seen.atSec }
	frameRead = seen
	frameZone = zone
	if (!carryable(seen, zone)) return
	carriedRead = seen
	carriedZone = zone
	/*
	 * Cleared rather than left standing when this acceptance has no point. The prose carry has just
	 * MOVED, and a pct from the previous read paired with the new read's age would put a confident
	 * travel time on a position the app has already replaced.
	 */
	carriedPct =
		xy?.you ? { pct: pctOf(xy.you), atSec: seen.atSec } : null
}

export const pictureFix = (
	read: FrameObservation | null,
	zone: { you: Zone; enemies: Zone[] } | null,
	nowSec: number,
	teamId: TeamId
): PositionFix | null => {
	if (pictureLine(read, nowSec) === null) return null
	if (read === null || read.where === null || zone === null) return null
	return {
		// See `zoneLabelForTeam`: "own blue-side jungle (top)" / "enemy red-side jungle (bot)". The
		// absolute half is kept because it is the half the picture verified.
		label: zoneLabelForTeam(zone.you, teamId),
		coarse: read.where,
		atSec: read.atSec,
		/*
		 * WHICH TENSE THE RENDERER MAY USE, decided here because this is where `FRAME_FRESH_SEC`
		 * lives. `shared/` may not import `analysis/`, so handing the brief the boundary as a word
		 * is the alternative to either copying the constant into `shared/` — a second definition of
		 * the app's one freshness rule, which is the drift `pictureFix` delegating to `pictureLine`
		 * exists to avoid — or letting the renderer pick a threshold of its own.
		 *
		 * `"now"` is a 92.3%-accurate statement about the present. `"last-known"` is a statement
		 * about the past, which is true at any age this function will still return at.
		 */
		asOf: nowSec - read.atSec <= FRAME_FRESH_SEC ? "now" : "last-known",
		enemies: zone.enemies.map(z => zoneLabelForTeam(z, teamId))
	}
}

/**
 * His team id, from the live feed's `"ORDER"`/`"CHAOS"`. Blue when the feed cannot say.
 *
 * A default is required because `pictureFix` must return a label or nothing, and defaulting to blue
 * reproduces exactly the behaviour every stored measurement was taken under — so a game whose team
 * field is missing is no worse off than it was, and every game that has one is right.
 */
const myTeamId = (data: LiveAllGameData | null): TeamId =>
	(data ? findMe(data)?.team : null) === "CHAOS" ? TEAM_RED : TEAM_BLUE

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
		resetFrameState()
		factMemory.lastFarmCs = 0
		factMemory.lastGoldAtSec = 0
		factMemory.goldSinceSec = 0
		factMemory.praiseSaid.clear()
		factMemory.lastRaceAtSec = 0
		factMemory.lastRaceGap = 0
		factMemory.saidRestraint = false
		factMemory.saidLevelGap = false
		factMemory.saidKillShare = false
		factMemory.saidOwnDeath = false
		factMemory.saidSwing = false
		factMemory.saidObjectives = false
		factMemory.goldMentions = 0
		factMemory.lastObjectiveAtSec = 0
		factMemory.sawCounterpartBuild = false
		factMemory.seenCounterpartItems.clear()
		factMemory.lastLedWithDeath = false
		factMemory.lastGoldMentioned = 0
		factMemory.lastFarmAtSec = 0
		resetAdviceCursor(adviceCursor)
		return null
	}
	const secs = gameTimeSec ?? data.gameData?.gameTime ?? 0
	const clock = `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`
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
		)
	}
	/*
	 * The fence's ground truth, cached off this poll rather than fetched again by the frame-read
	 * handler. Narrowed through `truthFromState` so the daemon and `scripts/probe-minimap.ts` fence
	 * against the same five fields — a fence only one caller can build is a fence only one caller
	 * uses.
	 */
	lastTruth = { truth: truthFromState(state), atSec: secs, atMs: Date.now() }
	return state
}

/**
 * The five facts the frame-read fence needs, straight off a raw `allgamedata`.
 *
 * `truthFromState` takes a `VisionState`, which the `trusted` path deliberately never builds. Same
 * five fields, same derivation, so a read is fenced identically in every mode — see the call site.
 */
export const truthFromRaw = (data: LiveAllGameData): FrameTruth => {
	const me = findMe(data)
	const players = data.allPlayers ?? []
	const allies = players.filter(p => me !== null && p.team === me.team && p !== me)
	const enemies = players.filter(p => me === null || p.team !== me.team)
	return {
		myChampion: me?.championName ?? "",
		meDead: me?.isDead === true,
		enemiesAlive: enemies.filter(p => p.isDead !== true).length,
		alliesAlive: allies.filter(p => p.isDead !== true).length,
		enemyChampions: enemies.map(p => p.championName ?? "")
	}
}

/**
 * THE GAME SO FAR plus how old the enemy jungler's figures are, rendered and budgeted.
 *
 * Composed here rather than in `live-brief.ts` because `shared/` may not import `analysis/` — the
 * brief prints a section, it does not own a memory. Both halves are facts with no instruction in
 * them: what happened, and when each of his opponent's frozen figures last moved.
 */
const memoryNarrative = (nowSec: number): string => renderGameSoFar(coachMemory, nowSec, NARRATIVE_BUDGET)

/**
 * Feed one raw sample to the coach's memory. The DAEMON'S poll calls this, not only the browser's.
 *
 * `coach-memory.ts` was written on the premise that the 5s sampler feeds it — "a browser-owned
 * memory would miss the back that happened between two turns" — and it did not: the only call site
 * was inside `GET /live/ground-truth`, at browser TURN cadence, and `beat()` returns on the pace
 * floor BEFORE that fetch, so a paced-out beat fed the memory nothing at all. Several of the
 * module's constants assume a dense grid: `respawning` tests whether any retained sample inside
 * `BACK_COALESCE_SEC` (20s) showed him dead, so at a 25s cadence every `respawn-buy` beat degrades
 * to a plain `back` and the narrative says "you backed and spent 1038 gold" about a moment he had
 * just been killed.
 *
 * The memory's LIFECYCLE lives here rather than in the turn handler, and that is the point of
 * extracting it: the turn handler used to reset on its own `newSequence`, which would have thrown
 * away everything this poll had accumulated before the page ever beat. One rule, one place — a new
 * roster or a clock that went backwards is a new game.
 *
 * Trusted only, exactly like the utterance log: nothing else reads the memory, `observe` never ran
 * in the other modes, and a memory quietly accumulating across games in a mode nobody reads is the
 * cross-game leak this app's design exists to fight.
 */
export const observeLiveSample = (data: LiveAllGameData | null, gameTimeSec: number | null): void => {
	if (!data || gameTimeSec === null || getSettings().liveCoachMode !== "trusted") return
	const roster = rosterKey(data)
	if (memoryRoster !== roster || gameTimeSec < coachMemory.lastSec) {
		coachMemory = newMemory()
		memoryRoster = roster
		/*
		 * A different roster or a clock that went backwards is a DIFFERENT GAME, and the picture
		 * belongs to the game it was taken in as much as the memory does. The daemon's own 5s poll
		 * calls this whether or not the page is beating, so this is the earliest of the three
		 * boundaries to notice a new game — and the one that notices it when the page was closed.
		 */
		resetFrameState()
	}
	coachMemory = observe(coachMemory, data, gameTimeSec)
}

/**
 * Everything the socket is told ONCE, at setup: the mode's standing rules, the champion knowledge,
 * and how to say the names.
 *
 * ## The bug this function exists to close
 *
 * `renderPronunciationGuide` was written, documented, unit-tested — and called from nothing but
 * `scripts/measure-speech.ts`. The block had stopped rendering the guide on purpose (it produced
 * "BRY-er is still at 0 CS" out loud; see `shared/pronounce.ts`), the system instruction never
 * started, and the feature shipped DEAD in between. Measured on game 5639406342, the first full
 * paired stream this app has: **zero of 715 ground-truth blocks carried a pronunciation section**,
 * so the audio model free-styled every champion name for 28 minutes and the player graded the
 * result "a total disaster".
 *
 * A pure unit test could never have caught that, because every pure unit passed. So the guide is
 * composed HERE, one line from the route that mints the token, and the test asserts on this
 * function's output for a roster read off a real recorded sample: the thing under test is the
 * payload, not the renderer.
 *
 * ## Why the socket, and not the brief
 *
 * The guide is static for a whole game — the roster is fixed at champ select — and the per-turn
 * brief is rebuilt every few seconds. A hundred rows in the system instruction is about 1.2k
 * tokens paid ONCE per socket; the same rows in the brief would be 1.2k tokens times ~85 turns, to
 * fix at most ten names. It is also the only home that has ever been safe: the brief is CONTENT,
 * every other line in it is a fact the coach may speak, and a line shaped like data gets spoken.
 *
 * ## The whole table, not the roster's slice
 *
 * `pronunciationsFor` filters to a roster and is right to, for anything built per turn. This is
 * minted at CHAMP SELECT, where the live client reports no champions at all, so filtering here
 * would produce an empty guide in exactly the moment the socket opens — a guide that never runs.
 *
 * ## Every mode, and the old arms are still byte-identical
 *
 * How a name SOUNDS is orthogonal to which architecture decides what to say, so the guide rides on
 * all three modes. The measured arms are unaffected: `src/review/ablation-arms.ts` and the benches
 * build their prompts from `liveCoachSystemPrompt` directly, and that function's output for
 * `fenced` and `cite-or-quiet` is unchanged to the byte — this composition happens one level up,
 * in the thing the live socket is handed.
 */
export const socketSystemPrompt = (opts: {
	mode: LiveCoachMode
	championKnowledge: string
	/** Defaults to the shipped `knowledge/pronunciations.md`; passed in only by tests and benches. */
	pronunciations?: readonly Pronunciation[]
}): string => {
	const guide = renderPronunciationGuide(opts.pronunciations ?? pronunciationTable())
	const prompt = liveCoachSystemPrompt({
		mode: opts.mode,
		championKnowledge: opts.championKnowledge
	})
	return guide === "" ? prompt : `${prompt}\n\n${guide}`
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
	 * READ-ONLY, like the rest of this file, and now the only thing keeping that true. The gate
	 * that used to enforce it (`src/daemon/gate.ts`) is deleted, because the writes it guarded are
	 * gone. It matters that this stays true: this endpoint runs *in* champ select, which is exactly
	 * where the gate refused to let the app act. It looks and it does not touch.
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
			truth: typeof body?.truth === "string" ? body.truth : null,
			/*
			 * THE MINIMAP, READ ON THIS BEAT INSTEAD OF IN FRONT OF A TURN.
			 *
			 * Measured, position SUPPLY was the binding constraint on the live coach, not how long a
			 * read may be carried: a read was only ever taken in front of a coaching turn, a
			 * reactive turn skips it because it is racing, and 42% of the event-driven turns on the
			 * graded run of game 5639406342 were reactive. The median reactive turn therefore sat
			 * 136 seconds from the last accepted read — past `CARRY_MAX_SEC`, so the brief said
			 * nothing about where he was on exactly the turns where where-he-is decides the
			 * sentence.
			 *
			 * This beat is five seconds and it runs whether or not a turn is being taken, so nearly
			 * every turn now has a read inside `FRAME_FRESH_SEC` instead of one past the knee.
			 *
			 * `offerFrame` returns synchronously and never throws. The model call is detached: a
			 * slow read, a failed read or a missing `ffmpeg` costs a POSITION and never a line, and
			 * never the journal write either — the frame is already on disk by the time this runs.
			 *
			 * The truth is built from the poll that STAMPED this frame, not from `lastTruth`. Who is
			 * dead and how many are alive change inside five seconds, and the fence is the one thing
			 * about this read that is not allowed to get looser.
			 */
			onStored: stored =>
				offerMinimapFrame({
					framePath: stored.framePath,
					tSec: stored.tSec,
					sessionId: stored.sessionId,
					truth: truthFromRaw(stored.raw)
				})
		})
		// 200 either way: a refused frame is a normal outcome (no game, practice tool), not an
		// error the page should surface as broken.
		return c.json(result)
	})

	/** `GET /api/live/journal` — is the journal actually recording? A number, not a claim. */
	app.get("/live/journal", c => c.json(openSessionStatus()))

	/**
	 * `GET /api/live/minimap-watch` — the position track, and what it cost to get.
	 *
	 * Counters and a track, no claims. The counters are here because every one of them is a way the
	 * watcher can be silently doing nothing — disabled, backing off after a 429, dropping every
	 * frame because a read is wedged in flight — and a reader that is off looks exactly like a
	 * reader that is refusing, which is the failure mode replay capture lived in for its whole life.
	 *
	 * The TRACK is the history, oldest first, which is more than the freshest read: two reads ten
	 * seconds apart say which way he is moving and neither one alone does. It is deliberately not in
	 * any coaching payload — see the report — because a direction is a new fact and a new fact
	 * belongs in `buildFacts` behind its own measurement, not smuggled in through a status route.
	 */
	app.get("/live/minimap-watch", c => {
		drainMinimapReads()
		return c.json({
			...minimapWatchStatus(),
			track: minimapTrack().map(t => ({
				tSec: Math.round(t.atSec * 10) / 10,
				where: t.read.you === null ? null : coarseOf(t.read.you),
				zone: t.read.you,
				ms: t.ms
			}))
		})
	})

	/**
	 * `GET /api/live/tick` — the raw feed, projected, so the browser can decide WHEN to ask.
	 *
	 * The event-driven coach (`analysis/live-events.ts`) has to see the feed move before it can ask
	 * a question about it, and the browser holds the socket. Everything it needs is already in the
	 * one `allgamedata` poll this daemon makes anyway, so this hands back a projection of it and
	 * nothing else.
	 *
	 * DELIBERATELY STATELESS, and that is the whole reason it is a separate route rather than a
	 * flag on `/live/ground-truth`. That one CONSUMES state on every call: it advances the delta's
	 * baseline, increments the turn sequence, and caches the fence's `lastTruth`. Polling it every
	 * couple of seconds to look for a death would mean the next real turn's delta covered two
	 * seconds instead of the ninety since the coach last spoke — the changes would be absorbed by
	 * a poll that produced no turn, which is the same class of bug as an announce-once fact
	 * consumed to build a turn that is then dropped. This route touches none of it.
	 *
	 * It is also why the minimap read is NOT taken here: it costs 1.3-3.0s and a model call, and
	 * it is only worth paying in front of a turn that is actually going to be sent. The browser
	 * pays it after the decision, and only for events whose value does not decay in seconds.
	 */
	app.get("/live/tick", async c => {
		const handle = await lcu()
		const data = handle ? await handle.live.allGameData().catch(() => null) : null
		return c.json({ tick: projectTick(data) })
	})

	/**
	 * `POST /api/live/frame-read` — one reading of the minimap, from whoever took it.
	 *
	 * ## What this is for
	 *
	 * It is the seam the screenshot has never had. When it was built, `analysis/live-facts.ts` ranked
	 * every line the coach could speak, an empty list meant PASS, and every candidate in that list was
	 * computed from the game client — so measured, a coaching turn with the JPEG attached and one
	 * without made the same speak-or-PASS decision on 13 of 14 turns and paraphrased each other where
	 * both spoke. The frame was being looked at and had nowhere to land. It lands here. The fence has
	 * since gone (default mode `trusted`); the read still has to be made and fenced against the
	 * client, and `daemon/minimap-watch.ts` now also makes it on the journal beat.
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
		/*
		 * THE PICTURE'S OWN CLOCK, taken HERE — before the model call, not after it.
		 *
		 * The browser grabs the crop and posts it in the same breath, so the request arriving is
		 * within milliseconds of the shutter; `readMinimap` then costs a measured 1.3-3.0 seconds,
		 * and stamping on the way out would age the picture by the reader's own latency and spend a
		 * third of `FRAME_FRESH_SEC` on the act of looking. The stamp is when it was TAKEN, which is
		 * what `FrameObservation.atSec` says it is and what the freshness rule downstream assumes.
		 */
		const takenAtSec = frameClockSec(cached, Date.now())
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
			/*
			 * THE READ THE DAEMON ALREADY HAS, served without a model call.
			 *
			 * This route is awaited by the browser in front of a coaching turn, so `readMinimap`'s
			 * measured p50 of 1,239ms (p99 2,615ms, over 101 reads on game 5639406342) is p50 1.2
			 * SECONDS ON THE CRITICAL PATH OF EVERY PROACTIVE TURN. The daemon now reads the
			 * minimap on the journal's own five-second beat, so by the time a turn asks there is
			 * almost always a read of a picture taken within a beat of this one — the same reader,
			 * the same crop rectangle, the same fence, from a frame seconds older at worst.
			 *
			 * So the model call is skipped when the watcher's freshest accepted read is inside
			 * `FRAME_FRESH_SEC` of the crop's own stamp. That is the same window `buildFacts` uses
			 * to decide a read is a statement about the PRESENT, which is what this turn wanted one
			 * for: a read it would have accepted as current is not worth 1.2 seconds and a second
			 * charge to take again.
			 *
			 * IT FALLS THROUGH RATHER THAN REFUSING when there is no such read — the watcher is off,
			 * `ffmpeg` is missing, it is backing off a 429, or the last few reads were fenced. The
			 * old path is then exactly the old path, which is what keeps a script or a probe posting
			 * a crop working unchanged and keeps this route honest when the cheap answer is absent.
			 */
			drainMinimapReads()
			const watched = latestMinimapRead()
			/*
			 * `frameRead` and not a fresh `observationFrom`, because the drain one line up has
			 * ALREADY landed this read through every rule there is — including the doubt test
			 * against the read before it, which would come out `medium` every time if it were
			 * re-run here against a `lastFrameSide` this same read had just written.
			 */
			if (
				watched !== null &&
				frameRead !== null &&
				Math.abs(takenAtSec - watched.atSec) <= FRAME_FRESH_SEC
			)
				return c.json({
					accepted: true,
					where: frameRead.where,
					confidence: frameRead.confidence,
					ms: 0,
					source: "watch",
					ageSec: Math.round((takenAtSec - watched.atSec) * 10) / 10
				})
			const out = await readMinimap({ jpegBase64: b64, truth: cached.truth })
			if (!out.read) {
				frameRead = null
				frameZone = null
				return c.json({
					accepted: false,
					reason: out.reason,
					ms: out.ms,
					...(out.faults ? { faults: out.faults.map(f => `${f.code} (${f.detail})`) } : {})
				})
			}
			const seen = observationFrom(out.read, lastFrameSide, takenAtSec)
			landRead(seen, zoneSideOf(out.read), out.xy)
			return c.json({ accepted: true, where: seen.where, confidence: seen.confidence, ms: out.ms })
		}
		// The coordinate form first, because it measured best. `RawFrameReadXY` refuses the
		// zone-name form on shape alone, so the fallback is a decode and never a guess.
		const xy = parseFrameReadXY(body?.read ?? null, ctx)
		const parsed = xy.read ? { read: asFrameRead(xy.read), rejected: null } : parseFrameRead(body?.read ?? null, ctx)
		if (!parsed.read) {
			frameRead = null
			frameZone = null
			return c.json({ accepted: false, reason: parsed.rejected ?? "schema" })
		}
		const faults = frameReadFaults(parsed.read, cached.truth)
		if (faults.length > 0) {
			frameRead = null
			frameZone = null
			return c.json({
				accepted: false,
				reason: "fenced",
				faults: faults.map(f => `${f.code} (${f.detail})`)
			})
		}
		const observation = observationFrom(parsed.read, lastFrameSide, takenAtSec)
		landRead(observation, zoneSideOf(parsed.read), xy.read)
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
		/*
		 * LAND WHAT THE WATCHER READ SINCE THE LAST TURN, before anything is built from it.
		 *
		 * Every consumer below — `buildLiveState`'s `frame`, the brief's `where` and `at` — reads
		 * `frameRead` or `carriedRead`, and those are only as current as the last drain. Draining
		 * here rather than inside each branch is one call before all of them, which is also why it
		 * is above the `trusted` early return that has swallowed three other things.
		 */
		drainMinimapReads()
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
		const mode = getSettings().liveCoachMode
		/*
		 * Under `trusted` the coach is handed the FULL brief instead of the ranked block.
		 *
		 * Not a render option on the same state: `buildLiveState` throws away everything the ranker
		 * did not need — mana, per-player items, the event log's ages — and those are the four holes
		 * that produced the false lines. So the brief reads the raw payload again, and the delta
		 * section compares it against the previous poll.
		 */
		if (mode === "trusted") {
			const nowSec = data?.gameData?.gameTime ?? null
			/*
			 * Out of game: forget the sequence, the delta's baseline AND the coach's memory.
			 *
			 * `buildLiveState` does this for every other mode — and `trusted` returns above it, so
			 * for the whole of this mode's life nothing was reset between games. `previousSample`
			 * therefore carried game N-1's final roster into game N's first delta, and the memory
			 * would have carried game N-1's advice into game N's first sentence. Same class of bug
			 * as a socket spanning two games, which is the one this app's design exists to fight.
			 */
			if (!data || nowSec === null) {
				turnSeq = null
				previousSample = null
				coachMemory = newMemory()
				memoryRoster = null
				servedTurns.clear()
				/*
				 * And the picture, which this branch forgot. `buildLiveState` does it for the other
				 * modes and `trusted` returns above that, so the frame state was never cleared in
				 * the shipped app at all — see `resetFrameState`.
				 */
				resetFrameState()
				return c.json({ inGame: false, text: "", gameTimeSec: null })
			}
			const roster = rosterKey(data)
			/*
			 * THREE ways a payload has to be the full brief again, and they are different questions.
			 *
			 * - a NEW SEQUENCE — no turns sent yet, the roster changed, or the clock went backwards.
			 *   This is the first turn of a game and the only turn on which a roster table earns its
			 *   tokens, because it is the only turn on which the thread does not already hold one.
			 * - the PAGE ASKED. Only the browser knows its socket is new: a reconnect gives Gemini a
			 *   fresh thread holding nothing, and the daemon cannot see that from here. It also asks
			 *   again when a payload never left the page, because a brief the model never received
			 *   is a brief that was not sent.
			 * - STALENESS. See `RESYNC_AFTER_SEC`.
			 */
			const newSequence =
				turnSeq === null || turnSeq.roster !== roster || nowSec < turnSeq.lastAtSec
			/*
			 * The delta's baseline resets with the sequence; the MEMORY does not.
			 *
			 * `observeLiveSample` owns the memory's lifecycle now, and the daemon's own 5s poll
			 * feeds it whether or not this page is beating. Wiping it here would throw away every
			 * sample taken before the first turn — which is most of a game when the page was
			 * opened late, and is the whole reason the poll feeds it at all.
			 */
			if (newSequence) previousSample = null
			const full =
				newSequence ||
				c.req.query("resync") === "1" ||
				nowSec - turnSeq!.lastAtSec > RESYNC_AFTER_SEC
			/*
			 * The frame read, which under this mode was COMPUTED AND THROWN AWAY twice over: once
			 * because `trusted` returned before anything read it, and then because every read it did
			 * store was stamped a whole turn late (see `lastTruth`). It goes into the brief's
			 * situation line, worded as a read of a picture. `pictureLine` owns every rule about
			 * whether there is a sentence at all.
			 */
			/*
			 * THE CARRIED READ, not this turn's — see `carriedRead`. A reactive turn skips the
			 * 1.3-3.0s minimap call because it is racing, and 42% of the event-driven turns on the
			 * graded run were reactive, so the brief was handed nothing on exactly the turns where
			 * where-he-is decides the sentence. `pictureLine` ages it and picks the tense.
			 */
			const where = pictureLine(carriedRead, nowSec)
			// The same read as DATA, so `prospectHead` can join it to the objective clocks instead
			// of printing "no usable position". Same gate as `where` — see `pictureFix`.
			const at = pictureFix(carriedRead, carriedZone, nowSec, myTeamId(data))
			/*
			 * HOW FAR EACH PIT IS, IN SECONDS — the third input of the unit of value, and the one
			 * no HUD shows him. `buildReach` decides whether the read is still fresh enough to
			 * bound anything; a null carry is not a missing input, because a DEAD player's origin
			 * is his own fountain and that answer is exact.
			 */
			const reach = reachFromLive({ raw: data, nowSec, read: carriedPct })
			/*
			 * THE FENCE, cached here too, or the minimap read is structurally dead in this mode.
			 *
			 * `POST /api/live/frame-read` refuses everything unless `lastTruth` is set, and
			 * `lastTruth` was assigned in exactly one place: inside `buildLiveState`, which this
			 * branch returns above. So under `trusted` no read was ever accepted, `frameRead`
			 * stayed null forever, and `where` was null on every turn — while `ScreenCoach` went
			 * on uploading a 17 KB minimap crop every beat to be refused. That is the one
			 * mechanism in the app aimed at the failure the owner actually named: at 1:37 the
			 * coach said "Center your W on the red buff" about a man standing on a topside camp.
			 *
			 * Narrowed straight off the raw payload rather than by building a `VisionState` for
			 * its side effect: `FrameTruth` is five fields and this mode has no use for the rest.
			 * Same five facts, same fence, so `frameReadFaults` behaves identically in every mode.
			 */
			lastTruth = { truth: truthFromRaw(data), atSec: nowSec, atMs: Date.now() }
			const built =
				full ?
					buildBrief({
						raw: data,
						gameTimeSec: nowSec,
						previous: previousSample,
						baseline: cachedBaseline(),
						where,
						at,
						reach,
						/*
						 * How old the counterpart's row is. `cpSeen` has been computed on every
						 * `observe` since `coach-memory.ts` was written and nothing ever read it
						 * into a payload, so every turn of every game told the coach his level was
						 * current. See `cpSeenAt` for the line that fact produced at 2:06.
						 */
						counterpartSeenSec: cpSeenAt(coachMemory),
						/*
						 * WHEN EACH MAN WENT DOWN, so the payload can state the elapsed half of a
						 * dead clock instead of leaving the model to convert the remaining half
						 * into it — which it did, wrongly, in 71 of 153 stored lines.
						 */
						deathsSeen: deathsSeen(coachMemory),
						/*
						 * And when this memory STARTED watching, because a null age above has two
						 * opposite meanings. Without it `counterpartClause` reported the game clock
						 * as the age of its own ignorance — "his row has NEVER moved in 7m23s" after
						 * 43 seconds of watching, on a replay with the memory started at 400s.
						 */
						counterpartWatchedFromSec: coachMemory.observedFrom,
						/*
						 * The memory rides on this path too. A resync happens because the thread is
						 * EMPTY — a reconnect, a gap, a dropped send — which is an argument for
						 * more history, not less. The two `brief` turns of the stored run were the
						 * only two payloads with no record of what had already been said, and one
						 * of them was mid-game at 5:22 with six lines already spoken.
						 */
						said: renderSaidWithin(coachMemory, nowSec, SAID_BUDGET).split("\n").slice(1),
						narrative: memoryNarrative(nowSec),
						/*
						 * The feed notes are dropped from the payload, not moved: every bullet of
						 * that 1,190-character block is already in `TRUSTED_PROMPT`, which rides
						 * once in the socket's system instruction. Sending it again every turn was
						 * 26% of a payload spent restating the standing instructions.
						 */
						feedNotes: false
					})
				:	buildDelta({
						raw: data,
						gameTimeSec: nowSec,
						previous: previousSample,
						baseline: cachedBaseline(),
						where,
						at,
						reach,
						counterpartSeenSec: cpSeenAt(coachMemory),
						/*
						 * WHEN EACH MAN WENT DOWN, so the payload can state the elapsed half of a
						 * dead clock instead of leaving the model to convert the remaining half
						 * into it — which it did, wrongly, in 71 of 153 stored lines.
						 */
						deathsSeen: deathsSeen(coachMemory),
						/*
						 * And when this memory STARTED watching, because a null age above has two
						 * opposite meanings. Without it `counterpartClause` reported the game clock
						 * as the age of its own ignorance — "his row has NEVER moved in 7m23s" after
						 * 43 seconds of watching, on a replay with the memory started at 400s.
						 */
						counterpartWatchedFromSec: coachMemory.observedFrom,
						/*
						 * What the coach already said, and what the feed did next.
						 *
						 * Rendered to plain lines at this boundary because `shared/` may not import
						 * `analysis/` — the brief prints a section, it does not own a memory. The
						 * heading is dropped because `saidBlock` writes its own; keeping both would
						 * put the same title on the section twice.
						 */
						said: renderSaidWithin(coachMemory, nowSec, SAID_BUDGET).split("\n").slice(1),
						/*
						 * THE GAME SO FAR — the half of the memory the owner actually asked for.
						 *
						 * `renderNarrative` was written, tested and never called: the delta's only
						 * history was `newEventsBlock`, one inter-turn gap, so a kill left the
						 * thread forever the moment the client's own `events.Events` stopped
						 * carrying it. At 6:42 of the stored run the payload held three events from
						 * the last 37 seconds and the Hextech drake taken at 6:04 was already gone.
						 */
						narrative: memoryNarrative(nowSec)
					})
			previousSample = { raw: data, gameTimeSec: nowSec }
			if (!built) return c.json({ inGame: false, text: "", gameTimeSec: nowSec })
			if (newSequence) servedTurns.clear()
			turnSeq = {
				turns: (newSequence ? 0 : turnSeq!.turns) + 1,
				lastAtSec: nowSec,
				roster,
				servedAtMs: Date.now()
			}
			servedTurns.set(turnSeq.turns, { servedAtMs: turnSeq.servedAtMs, gameTimeSec: nowSec })
			for (const k of servedTurns.keys())
				if (k <= turnSeq.turns - SERVED_TURNS_KEEP) servedTurns.delete(k)
			/*
			 * `gameTimeSec` rides with the block so the browser can stamp the transcript with it.
			 * All 154 stored transcript rows have a null clock because the page never had one to
			 * send — it holds a socket and a screenshot, and the game clock only ever existed on
			 * this side of the wire.
			 */
			return c.json({
				inGame: true,
				text: built.text,
				gameTimeSec: nowSec,
				full,
				turn: turnSeq.turns
			})
		}
		const state = buildLiveState(data, me, data?.gameData?.gameTime ?? null, cachedBaseline())
		/*
		 * The two older modes keep their path byte for byte; `gameTimeSec` is the one addition, and
		 * it changes nothing they send the model. It is metadata beside the block, so the browser
		 * can stamp its transcript rows with a clock in every mode rather than only in `trusted`.
		 */
		if (!state) return c.json({ inGame: false, text: "", gameTimeSec: null })
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
			gameTimeSec: data?.gameData?.gameTime ?? null,
			text: `${renderBlockForMode(state, mode)}${
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
		const mode = getSettings().liveCoachMode
		const counterpart = await lockedCounterpart()
		/*
		 * Under `trusted` the socket's ONE-TIME system instruction carries the whole of the champion
		 * knowledge — his champion, the enemy jungler's, and the role's — unparsed and with its
		 * numbers intact. That is the point of biasing to Gemini Live: static context rides once at
		 * setup and costs nothing per turn, so the per-turn payload stays the brief and the frame.
		 *
		 * The older modes keep `liveChampionKnowledge`, which is the digit-free clause list their
		 * own measurements were taken against. Byte-identical, deliberately.
		 */
		return c.json({
			ok: true,
			...minted.value,
			/*
			 * `socketSystemPrompt`, not `liveCoachSystemPrompt`: the say-it-like-this guide rides
			 * with the standing rules. This call is the whole fix for the pronunciations — the
			 * renderer had existed and been tested for weeks with no caller, so the guide reached
			 * the socket in zero of 715 turns of the one game he graded.
			 */
			systemPrompt: socketSystemPrompt({
				mode,
				championKnowledge:
					mode === "trusted" ?
						fullKnowledge({ champion, counterpart })
					:	liveChampionKnowledge(champion)
			}),
			mode,
			counterpart,
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
			/** The `turn` number the block this line answers was served with. See `servedTurns`. */
			turn?: unknown
		} | null
		if (typeof body?.text !== "string" || body.text.trim() === "")
			return fail(c, 400, "text is required", "bad-line")
		const line = {
			atMs: Date.now(),
			text: body.text.slice(0, 2000),
			fromUser: body.fromUser === true,
			gameTimeSec: typeof body.gameTimeSec === "number" ? body.gameTimeSec : null,
			...(typeof body.groundTruth === "string" && body.groundTruth !== "" ?
				{ groundTruth: body.groundTruth.slice(0, 8000) }
			:	{})
		}
		const stored = appendTranscript(line)
		/*
		 * INTO THE MEMORY, and before the write is checked.
		 *
		 * This is the route every spoken line already came through, so it is the only place the
		 * coach's own words exist on this side of the wire. Feeding it here is what makes "you are
		 * STILL low on mana" expressible at all: nothing anywhere recorded what had been said, so
		 * the coach repeated itself — the CS lead was cited on six consecutive turns of one graded
		 * run and never once became a decision.
		 *
		 * Before the `stored` check on purpose. A failed disk write costs the audit trail, which is
		 * recoverable; letting it also cost the next turn's memory would make one failure two.
		 *
		 * The stored row keeps whatever clock the browser sent — including null, which is the honest
		 * record of an older page that had none. The MEMORY gets this route's own last sampled clock
		 * as a fallback, because a line with no time cannot be placed in a sequence, and the ground
		 * truth this line answers was polled seconds ago.
		 */
		/*
		 * The turn this line ANSWERS, not the most recent one served.
		 *
		 * `turnSeq.servedAtMs` is overwritten on every ground-truth call, so when a reply arrives
		 * after the next turn has already gone out — the normal case for the turn-based providers
		 * the comment below cites, at 7.9s and 20.5s p50 against a ~25s turn interval — the
		 * latency was the age of an UNRELATED payload and was understated by a whole turn. Every
		 * follow-through window built from it opened that much early. The browser now echoes the
		 * `turn` number it was served with, and this looks that turn up; a page that sends none
		 * falls back to the old behaviour rather than failing.
		 */
		const answered =
			typeof body?.turn === "number" ? servedTurns.get(body.turn) ?? null : null
		const atSec = line.gameTimeSec ?? answered?.gameTimeSec ?? turnSeq?.lastAtSec ?? null
		/*
		 * HIS lines are not the coach's memory of what it said.
		 *
		 * `noteSaid` is the log of advice, and a question the player typed is not advice — counting
		 * it would make "you already said this" refer to sentences the coach never spoke.
		 */
		/*
		 * TRUSTED ONLY. The memory is reset inside the trusted branch of `/live/ground-truth` and
		 * nowhere else, but this route had no mode check — so under `cite-or-quiet` or `fenced`
		 * the utterance log accumulated across games and across the whole daemon lifetime, and
		 * since `observe` never runs in those modes `closeWindows` never fired and every entry
		 * stayed open forever. Inert today only because nothing reads the memory outside trusted,
		 * which is a reason to close it now rather than a reason to leave it.
		 */
		if (!line.fromUser && atSec !== null && getSettings().liveCoachMode === "trusted")
			coachMemory = noteSaid(
				coachMemory,
				line.text,
				atSec,
				/*
				 * The latency is MEASURED, not assumed: wall clock from serving the block this line
				 * answers to the line coming back. That is the whole of the delay the player
				 * experiences — the model's thinking, the socket, and the daemon's own hop — and it
				 * is what makes `endSec` the moment the advice landed rather than the moment it was
				 * thought. The two shapes differ by seconds here (a socket p50 of 790ms against a
				 * turn-based several), so a constant would have been wrong for one of them.
				 */
				answered !== null ? (Date.now() - answered.servedAtMs) / 1000
				: turnSeq === null ? 0
				: (Date.now() - turnSeq.servedAtMs) / 1000
			)
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
			champion: await lockedChampion(),
			counterpart: await lockedCounterpart()
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
 * Exported so `scripts/bench-stream.ts` replays states through the SAME code the daemon runs,
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
	 * a bench passes the corpus baseline with the replayed game EXCLUDED — including it would let
	 * the game being replayed set its own average.
	 *
	 * Defaulting to null keeps a replay byte-identical to what it replayed before.
	 */
	baseline: ReturnType<typeof baselineFromRows> | null = null
): VisionState | null => {
	const data = raw as LiveAllGameData | null
	const me = findMe(data ?? ({} as LiveAllGameData))
	if (!data || !me) return null
	return buildLiveState(data, me, gameTimeSec, baseline)
}
