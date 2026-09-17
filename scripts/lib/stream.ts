/**
 * The paired-stream builder: the only place that decides which frames on disk go with which raw
 * client samples, and the only place that rebuilds the block the coach actually held.
 *
 * ## Why a library and not another harness
 *
 * Five harnesses in `scripts/` have each done a version of this join by hand, and every one of them
 * got a different answer. `bench-providers.ts` pairs ONE JPEG with every state it replays and says
 * so in its own output ("THE SAME FRAME FOR EVERY STATE"), which makes a model that reads the
 * picture score WORSE than one that ignores it, because the picture is of a different minute.
 * `eval-live.ts` rebuilds states from the POST-GAME timeline, which has no enemy CS, no items and
 * no roles — the exact three facts the coach was rebuilt around — and AGENTS.md already records
 * what that measures: improvisation, not coaching. This file exists so the next harness cannot
 * invent a sixth join.
 *
 * ## What is actually on disk, and why the join is fiddly
 *
 * Two independent recorders wrote into `data/`, on two different clocks:
 *
 *   - `journal_frame` (SQLite) — a JPEG of his whole monitor every ~5s of WALL clock, POSTed by
 *     the browser, stamped by the daemon with the GAME clock (`tSec`) and the wall clock (`atMs`),
 *     carrying `truthJson`: the ground-truth block that was ACTUALLY SENT at that instant.
 *   - `data/live-samples/*.ndjson` — the raw `allgamedata` payload every ~5s of GAME clock, taken
 *     from the SUPERVISOR's own poll (`src/daemon/live-sampler.ts`), so a game played with the page
 *     closed is still recorded. Lines are `{atMs, gameTime, data}`.
 *
 * Neither recorder knows about the other, so the only thing they share is the wall clock, and the
 * two cadences beat against each other: several frames legitimately land on one sample (4 in
 * split-03, 8 in the Gwen game). They are NOT deduplicated — they are different pictures of one
 * client state, and throwing away three of four frames would throw away the variation the ablation
 * is looking for.
 *
 * The PAIRED corpus is smaller than it looks, and the distinction between "paired" and "benchable"
 * is the one to hold on to. Of 1876 frames only a few hundred have a raw sample within 3s of them:
 * the sampler started recording after most journal frames had already been written, and several of
 * the long frame runs that cover whole games have no raw data beside them. Two of the four paired
 * windows therefore run out of PICTURES at 4:04 and 6:43.
 *
 * They do not run out of GAME. `buildStream` reads the whole sample file from line 1 regardless of
 * where the frames start or stop, so a paired window benches all 37 minutes of its game with images
 * on the turns that have one. And `discoverTextWindows` adds the thirteen games that have raw
 * samples and NO frames at all — whole games the daemon's own poll recorded with the browser
 * closed. Seventeen games, 23:53 to 42:55, thirteen distinct enemy junglers.
 *
 * What is genuinely absent is a paired LATE-GAME FRAME. Any caller that wants to say something
 * about what a picture of minute 30 is worth has to say out loud that it does not have one; the
 * stored `truthJson` blocks from those instants cannot be re-rendered either, because the raw
 * client JSON that produced them was never kept.
 *
 * ## The traps, each of which cost a wrong answer before it was found
 *
 * 1. **`journal_frame.path` is an absolute path under `/home/ssalb/coachskaffur`** — the repo's
 *    name before it was renamed to `eepalytics`. 503 of 1876 rows point at a directory that does
 *    not exist, so `existsSync(row.path)` is false for every frame written before the rename. A
 *    harness that tests the stored path concludes the frames are gone and silently evaluates a
 *    text-only coach while reporting that it evaluated a vision one. Frames are rebased and then
 *    OPENED; a frame whose bytes cannot be parsed as a JPEG is excluded and counted, never assumed.
 * 2. **`journal_session.gameId` is not per-game.** Session `js-mtn2jrku-8ae9` has ONE row, ONE
 *    gameId, and 1470 frames spanning 11.5 hours across seven games. Runs are cut out of a session
 *    by the game clock running backwards or the wall clock jumping, and each run's gameId is then
 *    resolved independently from when its clock read zero. Six of the eleven runs disagree with the
 *    session's own id.
 * 3. **A sample FILE is not a game either.** `js-mtn2jrku-8ae9.ndjson` holds four, and
 *    `split-01..04.ndjson` are exactly those four games, one per file, byte for byte (213+353+363+292
 *    = 1221 lines). A multi-game file is suppressed rather than used, because a window has to be one
 *    game before the ranker can be stepped through it from that game's t=0.
 * 4. **`buildFacts` keeps module-scoped memory.** Each death is announced once, gold once per 800g
 *    and only after it has been held, farm once per three minutes, and the state-shaped facts once
 *    per game. So `state.unseen` at a checkpoint is a function of the ENTIRE preceding stream, and a
 *    replay that starts in the middle — or that skips the samples between checkpoints — is a
 *    different coach. `buildStream` steps every sample of the segment from its first line and
 *    reports how many it stepped, so a caller can check.
 *
 * ## What is shipped code here, and what is not
 *
 * Imported, never reimplemented:
 *
 *   - `buildLiveStateForBench`  `src/server/routes/live.ts` — the daemon's own state builder,
 *                               including `buildFacts`, so `state.unseen` is the ranked,
 *                               rate-limited list the coach was actually handed.
 *   - `renderBlockForMode`      `src/shared/live-coach-mode.ts` — the block for the SHIPPED mode.
 *                               NOT `renderState`: under `cite-or-quiet` (the default) `renderState`
 *                               writes the fence's own instructions into the middle of the ground
 *                               truth, and that is a different block from the one the coach gets.
 *   - `focusAreas` + `recentFeedbackItems` — the "## From his PAST reviews" section, rebuilt from
 *                               the same two calls `standingFocus` in `routes/live.ts` makes.
 *                               `standingFocus` itself is a closure inside `createLiveRoute` and
 *                               cannot be imported; this is its body, not a paraphrase of it —
 *                               with one addition the live path does not need: the items are cut
 *                               off at the replayed game's `gameCreationMs`, the same restriction
 *                               `baselineDuring` puts on the farm average, so a review written
 *                               after the game cannot change the block a replay renders.
 *   - `readVerbatim`, `baselineDuring`  DEFINED BELOW — the ndjson reader that keeps
 *                               1-based line numbers (the sampler's own `readSamples` drops torn
 *                               lines silently and returns none), and the rolling farm baseline
 *                               restricted to games created strictly BEFORE this one, so the
 *                               block's `Farm baseline:` line is the number that existed at the
 *                               time rather than one the future set.
 *   - `coachStateFrom`          DEFINED BELOW — a SECOND, independent view of the same
 *                               samples, for the staleness checker. Deliberately not the ranker's
 *                               own view: a premise checked against the state the ranker produced
 *                               is the ranker's opinion of itself.
 *
 * ## What this module refuses to do
 *
 * It never says a frame shows the game. Steps that drop post-game frames (a `tSec` past the game's
 * own duration catches a full-screen shot of his CODE EDITOR and a champ-select screen, both
 * confirmed by eye) are FILTERS, not answers — the code-editor frame has `clock: 'live'`, 169KB,
 * the right resolution and a perfectly truthful `truthJson` saying he was dead with 45 seconds to
 * wait. He alt-tabbed. No cheap test catches that, so the only thing entitled to say a frame shows
 * a game is a human opening it, and `windowNotes` records what was filtered rather than claiming
 * what remains.
 *
 * It never fakes a state. A sample that cannot produce one — the loading screen, a torn tail line
 * from a killed daemon — is skipped and counted.
 *
 * It prints nothing. This is a library; the driver owns the report.
 *
 * ## The two discovery calls, and which one to reach for
 *
 *   - `discoverWindows()` — the PAIRED windows, unchanged and in the same order it has always
 *     returned them. Every graded run on disk was replayed from an id this produces, and a rename
 *     or a reorder here silently makes `--window latest` a different game.
 *   - `discoverBenchable()` — those, plus one text-only window per game that has no paired one,
 *     plus every file that is NOT a benchable game with the reason it was refused. This is what a
 *     multi-game bench should call. A game that cannot be replayed is DATA: returning only the
 *     successes is what made a seventeen-game corpus look like a two-game one.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { basename, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DATA_DIR, DB_PATH } from "../../src/shared/constants.ts"
import { buildLiveStateForBench } from "../../src/server/routes/live.ts"
import type { VisionState } from "../../src/shared/live-state.ts"
import { renderBlockForMode } from "../../src/shared/live-coach-mode.ts"
import { buildBrief } from "../../src/shared/live-brief.ts"
import type { LiveCoachMode } from "../../src/shared/live-coach-mode.ts"
import { focusAreas } from "../../src/analysis/focus.ts"
import { getSettings, recentFeedbackItems } from "../../src/db/queries.ts"
import { baselineFromRows, perGameMetrics } from "../../src/analysis/index.ts"
import { loadCorpus } from "../../src/daemon/corpus.ts"
import type { CoachState } from "../../src/analysis/timeliness.ts"
import {
	commitTurn,
	describeTurn,
	dueTurn,
	newEventWatch,
	observeTick,
	projectTick
} from "../../src/analysis/live-events.ts"
import type { LiveAllGameData } from "../../src/shared/schema/live.ts"

/* =============================================================== the samples

   ONE reader for the recorded client stream, and one view of it for the staleness check.

   Both of these used to live in a HARNESS — `readVerbatim`/`baselineDuring` in
   `scripts/e2e-real-game.ts`, `coachStateFrom` in `scripts/eval-useful.ts` — and this library
   imported them upward, which is how the repo ended up with the library depending on two drivers
   it supersedes. They are the same code, moved down; the two harnesses re-export them so their
   pinned tests in `src/` keep pointing at the same functions.

   ============================================================================ */

/** The two fields `coachStateFrom` reads. Every sample shape in `scripts/` satisfies it. */
export interface ClientSample {
	gameTime: number
	data: unknown
}

export interface RawSample {
	/** 1-based line in the ndjson, so a checkpoint points at bytes a human can go read. */
	line: number
	atMs: number
	gameTime: number
	data: unknown
}

/**
 * The verbatim stream, keeping line numbers AND a count of what it could not read.
 *
 * Kept separate from the sampler's own `readSamples` on purpose: that one drops torn lines
 * silently and returns no line numbers, and `sampleLine` is the join key a replay needs.
 * (This began as a copy of `scripts/build-fixture.ts`, which is deleted; this is now the
 * only definition, so there is no longer a second copy to drift from.)
 *
 * ## Why the torn lines are COUNTED, and where the count goes
 *
 * A torn line is normal in exactly one place: the last line of a file a killed daemon was still
 * writing. Anywhere else it is a sample the replay will never see — one fewer state stepped
 * through the ranker, one fewer turn in the schedule, a rate limiter that reaches a different
 * place — and the instrument used to swallow it in a bare `catch` with a comment. The module
 * header claims a skipped sample is "skipped and counted"; before this it was counted only when a
 * state failed to build, never when the JSON itself failed, so the one loss nobody could see was
 * the one that happened before any of the counting started.
 *
 * `tornMid` is the number that matters: a tear that is NOT the final readable line means the file
 * is damaged rather than merely truncated, and `buildStream` turns it into a warning that rides
 * on the window into every report and stored run.
 */
export interface VerbatimRead {
	rows: RawSample[]
	/** Lines that would not parse, at all. */
	torn: number
	/** Torn lines that were not the file's last non-blank line — i.e. damage, not truncation. */
	tornMid: number
	/** 1-based line numbers of the torn lines, capped so a shredded file cannot flood a report. */
	tornLines: number[]
}

export const readVerbatimCensus = (path: string): VerbatimRead => {
	const out: RawSample[] = []
	const tornLines: number[] = []
	const lines = readFileSync(path, "utf8").split("\n")
	let lastNonBlank = 0
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!
		if (raw.trim() === "") continue
		lastNonBlank = i + 1
		try {
			const o = JSON.parse(raw) as { atMs: number; gameTime: number; data: unknown }
			out.push({ line: i + 1, atMs: o.atMs, gameTime: o.gameTime, data: o.data })
		} catch {
			// The tail of a killed daemon, usually. Recorded either way — see the doc above.
			tornLines.push(i + 1)
		}
	}
	return {
		rows: out,
		torn: tornLines.length,
		tornMid: tornLines.filter(l => l !== lastNonBlank).length,
		tornLines: tornLines.slice(0, 20)
	}
}

/** The rows alone, for the callers that only ever wanted them. See `readVerbatimCensus`. */
export const readVerbatim = (path: string): RawSample[] => readVerbatimCensus(path).rows

/**
 * His rolling farm average as the daemon would have had it DURING this game.
 *
 * Games created after this one are excluded, not merely this game itself, because the corpus on
 * disk keeps growing and letting the future set the average would make the block's
 * `Farm baseline:` line a number that never existed at the time. This was the same rule and the
 * same numbers as `scripts/build-fixture.ts`, which is deleted — so this is now the sole
 * definition and the block assertion below is what still checks it.
 */
export const baselineDuring = (gameId: string) => {
	const db = new DatabaseSync(DB_PATH, { readOnly: true })
	const row = db.prepare("SELECT gameCreationMs FROM game WHERE gameId = ?").get(Number(gameId)) as
		| { gameCreationMs: number | bigint }
		| undefined
	db.close()
	const createdMs = Number(row?.gameCreationMs ?? 0)
	const corpus = loadCorpus(200)
		.filter(e => createdMs === 0 || Number(e.row.gameCreationMs) < createdMs)
		.slice(0, 20)
	return { baseline: corpus.length > 0 ? baselineFromRows(perGameMetrics(corpus)) : null, games: corpus.length }
}

const OBJECTIVE_EVENTS = new Set(["DragonKill", "BaronKill", "HeraldKill"])
const DRAGON_RESPAWN_SEC = 300
const BARON_RESPAWN_SEC = 360
const HERALD_RESPAWN_SEC = 360

/**
 * The recorded client payload, untyped on purpose.
 *
 * `schema/live.ts` types what the app CONSUMES; a recorded sample is whatever the client wrote on
 * the patch it was running, and a harness that refuses to parse an old sample because a field
 * moved would throw away the only real games on disk. `buildLiveStateForBench` does the same thing
 * one line later with its own cast.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const lastEventTime = (d: Any, name: string, respawn: number, now: number): number | null => {
	const ev: Any[] = d?.events?.Events ?? []
	for (let i = ev.length - 1; i >= 0; i--)
		if (ev[i].EventName === name && ev[i].EventTime !== undefined)
			return Math.round(ev[i].EventTime + respawn - now)
	return null
}

/**
 * The raw sample as the STALENESS check needs it.
 *
 * This is the only thing in this file that restates logic the daemon owns, and it is deliberate:
 * `timeliness.ts` must be able to check a premise against a state the RANKER did not produce, or
 * it is checking the ranker's opinion of the world against itself. Structurally `CoachState` is a
 * subset of `FactInput`, so the two agree by construction on every field that matters; what is not
 * shared is the derivation, which is the point.
 *
 * `pace` is null for the same reason `buildLiveStateForBench` leaves it null: a recorded sample
 * carries the client's facts and not his rolling average, so the two CS rules are structurally
 * absent from any replay. That is a real hole in this instrument and it is stated in the report
 * rather than hidden — six of the nine lines he quit on were exactly those rules.
 */
export const coachStateFrom = (row: ClientSample): CoachState | null => {
	const d = row.data as Any
	const id = d?.activePlayer?.riotId ?? d?.activePlayer?.summonerName ?? ""
	const me = (d?.allPlayers ?? []).find((p: Any) => (p.riotId ?? p.summonerName ?? "") === id)
	if (!me) return null
	const mine = me.team
	const others = (d.allPlayers ?? []).filter((p: Any) => p !== me)
	const enemies = others.filter((p: Any) => p.team !== mine)
	// Declared position first, Smite second — the same order `live.ts` uses, and for the same reason.
	const jungler =
		enemies.find((p: Any) => (p.position ?? "").toUpperCase() === "JUNGLE") ??
		enemies.find((p: Any) =>
			[
				p.summonerSpells?.summonerSpellOne?.displayName,
				p.summonerSpells?.summonerSpellTwo?.displayName
			].some((n: string) => (n ?? "").toLowerCase() === "smite")
		)
	const now = row.gameTime
	let mineN = 0
	let theirs = 0
	for (const e of (d.events?.Events ?? []) as Any[]) {
		if (!OBJECTIVE_EVENTS.has(e.EventName)) continue
		const k = (d.allPlayers ?? []).find(
			(p: Any) => p.riotId === e.KillerName || p.summonerName === e.KillerName
		)
		if (!k) continue
		if (k.team === mine) mineN += 1
		else theirs += 1
	}
	return {
		nowSec: now,
		meDeadForSec: me.isDead ? (me.respawnTimer ?? 0) : null,
		deadEnemies: enemies
			.filter((p: Any) => p.isDead && (p.respawnTimer ?? 0) > 0)
			.map((p: Any) => ({
				champion: p.championName ?? "an enemy",
				respawnSec: p.respawnTimer ?? 0,
				isJungler: (p.position ?? "").toUpperCase() === "JUNGLE"
			})),
		currentGold: d.activePlayer?.currentGold ?? null,
		pace: null,
		myCs: me.scores?.creepScore,
		meLevel: me.level,
		counterpart:
			jungler ?
				{ champion: jungler.championName, cs: jungler.scores?.creepScore, level: jungler.level }
			:	null,
		counterpartItems: ((jungler?.items ?? []) as Any[])
			.filter(i => !i.consumable && (i.price ?? 0) >= 2000 && i.displayName)
			.map(i => i.displayName as string),
		objectiveCount: { mine: mineN, theirs },
		enemyObjectives: ((d.events?.Events ?? []) as Any[])
			.filter(e => OBJECTIVE_EVENTS.has(e.EventName))
			.filter(e => {
				const k = (d.allPlayers ?? []).find(
					(p: Any) => (p.riotId ?? p.summonerName) === e.KillerName
				)
				// An unresolvable killer counts for nobody, never against him.
				return k ? k.team !== mine : false
			})
			.map(e => ({ name: e.EventName as string, atSec: (e.EventTime ?? 0) as number })),
		alliesAlive:
			(me.isDead ? 0 : 1) + others.filter((p: Any) => p.team === mine && !p.isDead).length,
		enemiesAlive: enemies.filter((p: Any) => !p.isDead).length,
		drakeBackInSec: lastEventTime(d, "DragonKill", DRAGON_RESPAWN_SEC, now),
		baronBackInSec: lastEventTime(d, "BaronKill", BARON_RESPAWN_SEC, now),
		heraldBackInSec: lastEventTime(d, "HeraldKill", HERALD_RESPAWN_SEC, now),
		killSecs: ((d.events?.Events ?? []) as Any[])
			.filter(e => e.EventName === "ChampionKill")
			.map(e => (e.EventTime ?? 0) as number)
	}
}

/**
 * Every champion the client knows, for the invented-champion check. Empty disables that fault.
 *
 * Passed in rather than hardcoded for the reason `coach-score.ts` gives: a list baked into source
 * silently misses every champion released after it was written, and `kv.championNames` is the
 * client's own map for the patch the game was played on. Byte-identical private copies of this
 * lived in `e2e-real-game.ts` and `ablate-autonomy.ts` until 2026-09-11.
 */
export const championVocabulary = (): { names: string[]; source: string } => {
	try {
		const db = new DatabaseSync(DB_PATH, { readOnly: true })
		const row = db.prepare("SELECT value FROM kv WHERE key = 'championNames'").get() as
			| { value: string }
			| undefined
		db.close()
		if (row) {
			const names = Object.values(JSON.parse(row.value) as Record<string, string>).filter(
				n => typeof n === "string" && n !== ""
			)
			if (names.length > 0) return { names, source: `${DB_PATH} kv.championNames` }
		}
	} catch {
		/* the daemon may be mid-write, or the DB may not exist in this checkout */
	}
	return { names: [], source: "" }
}

/* ==================================================================== knobs */

/** Past this, the frame is a picture of a different moment. Named because it is arguable. */
export const DEFAULT_MAX_SKEW_MS = 3000

/**
 * Cut a run here: the game clock cannot decrease except by a new game starting at zero.
 *
 * The two seconds of tolerance stop a slow poll — the clock read a shade early, then a shade late —
 * from splitting one game into two runs of half the frames each.
 */
export const CLOCK_BACK_TOLERANCE_SEC = 2

/** And cut here: the page sat on his desktop between two games. */
export const WALL_GAP_MS = 60_000

/**
 * How far a run's zero-instant may sit from a game's `gameCreationMs` and still be that game.
 *
 * Observed gaps are 16s to 95s across all eleven runs, which is the loading screen: creation is
 * stamped when the game is made, and the clock reaches zero when everyone has loaded in. 180s is
 * comfortably past the worst of those and nowhere near the gap to the neighbouring game. A run
 * outside it is reported unmatched; it is never given to its nearest game anyway.
 */
export const MAX_START_GAP_MS = 180_000

/**
 * Below this many paired frames a "window" is a session-rollover artefact, not a game.
 *
 * The two real artefacts in the corpus are both a single frame — the loading screen of the Gwen
 * game, joined to the one `allgamedata` line that was written under the previous session's key four
 * seconds before the sampler rolled over. That frame carries no `truthJson`, so the coach never had
 * a block for it.
 */
export const MIN_PAIRED_FRAMES = 10

/**
 * Below this many raw samples, a TEXT-ONLY game is a rollover artefact rather than a game.
 *
 * Two files on disk hold exactly one line each — `js-mtn2jrku-8ae9-t29810607.ndjson` and
 * `js-mtoryjv8-690a-t29817812.ndjson` — written under the outgoing session's key in the four
 * seconds before the sampler rolled over to the new one. Both are the first sample of a game whose
 * real file lives elsewhere and is 279 and 370 lines long. Thirty samples is 2m30s of game clock,
 * which is the least that can carry a first clear; anything under it is reported in `rejected`
 * rather than benched, because a two-turn "game" pooled beside a 400-turn one moves a rate and
 * measures nothing.
 */
export const MIN_TEXT_SAMPLES = 30

/* ================================================================ the shapes */

export interface PairedFrame {
	id: string
	/** Rebased and CONFIRMED OPENABLE. See trap 1 in the header. */
	path: string
	/** The FRAME's game clock. The block renders the SAMPLE's; the gap is `skewMs`, never smoothed. */
	tSec: number
	atMs: number
	/** `live`, or `interpolated` when the clock read failed and the last anchor was extended. */
	clock: string
	/** What was ACTUALLY SENT at this instant, by the code of the day. Compare, never substitute. */
	storedBlock: string | null
	bytes: number
}

export interface StreamWindow {
	/** Short and stable: the sample file's basename, disambiguated only if two windows share one. */
	id: string
	sampleFile: string
	gameId: string
	champion: string
	/**
	 * `paired` — journal frames and raw samples for the same instants, the only shape this module
	 * produced before 2026-09-10 and the shape every stored run on disk was replayed from.
	 * `text-only` — raw samples and NO frames: a real, whole, replayable game whose turns simply
	 * carry no image.
	 *
	 * Optional so that a caller predating the split keeps compiling, and so that the two stored
	 * runs, whose window objects were serialised without it, still read back. Absent means `paired`.
	 *
	 * The distinction is worth a field rather than `frames.length === 0`, because those are not the
	 * same statement: a paired window whose frames all failed to open is a BROKEN paired window and
	 * should be read as a defect, while a text-only window has nothing missing — the browser was
	 * closed, the daemon's own poll recorded the game anyway, and that is the normal case for 13 of
	 * the 17 games in this corpus.
	 */
	kind?: "paired" | "text-only"
	/** Only frames that paired within `maxSkewMs`, sorted by tSec. Empty on a text-only window. */
	frames: PairedFrame[]
	medianSkewMs: number
	tSecFrom: number
	tSecTo: number
	/* ---- additive provenance; every consumer may ignore all of it ---- */
	/** The step-7 name: `<sampleFile basename>@<sessionId>#<runOrdinal>`. Never a gameId. */
	windowId?: string
	/** Frames inside the wall-clock overlap whose nearest sample was worse than `maxSkewMs`. */
	refusedFrames?: number
	/** Frames dropped because `tSec` ran past the game's own duration. A filter, not a verdict. */
	droppedPostGame?: number
	/** How many distinct sample lines the frames landed on. Lower than `frames.length` is normal. */
	distinctSampleLines?: number
	/** Said plainly, for a report to quote. Contains no claim about what any frame SHOWS. */
	windowNotes?: string[]
	/** Raw samples in the segment. The turns come out of these, frames or no frames. */
	samples?: number
	/**
	 * Game clock of the LAST sample — with `firstSampleSec`, the span a turn can actually be built
	 * in, which on a paired window is NOT `tSecFrom`/`tSecTo`. The Gwen game's frames stop at 4:04
	 * and its samples run to 37:27; a report that printed the frame span as the covered span would
	 * say this harness can only see the first four minutes of a game it can see all of.
	 */
	lastSampleSec?: number
	/**
	 * The game's own duration from the `game` table, which is NOT `tSecTo`.
	 *
	 * On a paired window `tSecFrom`/`tSecTo` is the span of the FRAMES — 0:04 to 4:04 on the Gwen
	 * game, whose file covers all 37 minutes — so a table that printed it as the game's length
	 * would report a four-minute game. Both facts are wanted and they are different facts.
	 */
	gameDurationSec?: number
	/**
	 * The game clock of the FIRST sample, which is not always ~0.
	 *
	 * `split-01.ndjson` begins at 844s because the sampler was started 14:04 into that game. Every
	 * fact `buildFacts` rate-limits — each death announced once, gold once per 800g and only after
	 * it has been HELD, farm once per three minutes, the state-shaped facts once per game — is a
	 * function of the whole preceding stream, and that stream's first fourteen minutes are not on
	 * disk. The turns are still real turns off real client JSON; what is NOT reproduced is the
	 * coach's memory, so a game with a late start is benchable and must be labelled.
	 */
	firstSampleSec?: number
}

export interface StreamTurn {
	index: number
	/** Game clock of the SAMPLE the block was built from. */
	atSec: number
	clock: string
	/** THE SHIPPED BLOCK: `renderBlockForMode(state, mode)` + the past-reviews focus section. */
	block: string
	/** `state.unseen` — the ranked, rate-limited fact list. An empty list means PASS is correct. */
	offered: string[]
	roster: string[]
	aliases: string[]
	me: string
	frame: PairedFrame | null
	frameB64: string | null
	/** Wall-clock distance between the frame and the sample its block came from. */
	skewMs: number | null
	/**
	 * Did THIS turn's block carry a farm baseline, i.e. is `state.pace` non-null?
	 *
	 * A separate fact from `BuiltStream.baselineGames`, and conflating the two printed a false
	 * reassurance in a report. `baselineGames` counts what `baselineDuring` FOUND in the corpus;
	 * this says whether the rendered block could USE it. `paceReading` returns null before
	 * `EARLIEST_PACE_SEC` (240s, `src/analysis/live-coach.ts`) unless the clock is inside a
	 * 10/14/20-minute checkpoint window, and `live-state.ts` then renders the literal string
	 * "Farm baseline: NONE — you have no average to compare his farm against right now". Both
	 * paired windows on disk end at 4:04 and 6:43, so almost every turn this module can produce
	 * is inside that dead zone: with 20 earlier games in the corpus, 8 of 8 turns of the first
	 * real run still said NONE. Any report that says the farm axis was exercised must test THIS.
	 */
	paceInBlock: boolean
	/** 1-based line in the ndjson, so a turn points at bytes a human can go read. */
	sampleLine: number
	/**
	 * WHY she was asked, under the event schedule — `describeTurn`. Null on the timer schedule,
	 * where the honest answer is "because twenty seconds passed", which is the thing being replaced.
	 * Never sent to the model: it is the harness's reason for asking, not material for the line.
	 */
	why: string | null
	/** Whether a minimap read would have been paid for in front of this turn. */
	readMinimap: boolean
	/** The event kinds this turn carried. Empty on the timer schedule. */
	kinds: string[]
	/**
	 * The SAME instant rendered as the `trusted` brief, so an arm may be benched under either
	 * architecture off one replay.
	 *
	 * Built here rather than in the bench because the brief needs the RAW sample and the sample
	 * before it — the delta section is a difference — and only this module still holds them. Empty
	 * when the payload could not make one, which is the same "no facts, no turn" the shipped path
	 * applies.
	 */
	brief: string
	/** The enemy jungler the brief locked onto, so an arm can load his knowledge file too. */
	counterpart: string | null
	/**
	 * The raw `allgamedata` this turn was rendered from, handed back UNCHANGED.
	 *
	 * `brief` above is one rendering of this instant, made eagerly under the old architecture where
	 * every turn sent the whole thing. The shipped path no longer does that: turn one is a full
	 * brief and every turn after it is a `buildDelta` against the previous TURN, carrying what the
	 * coach has already said. A delta cannot be precomputed here, because it depends on lines the
	 * model has not spoken yet — so the raw payload rides along and the bench builds the payload at
	 * turn time, the same way `routes/live.ts` does. Keeping `brief` as well costs nothing and
	 * keeps the two stored runs re-scorable against the payload they were actually graded on.
	 */
	raw: unknown
}

export interface BuiltStream {
	window: StreamWindow
	/** "events" or "timer" — a run file that does not say this cannot be read years later. */
	schedule: "timer" | "events"
	/** Every turn the detector raised, INCLUDING the ones `stride` declined to pay for. */
	scheduled: ScheduledTurn[]
	stride: number
	mode: string
	/** 0 means there is NO baseline: the two farm-versus-his-own-average rules cannot fire. Say so. */
	baselineGames: number
	turns: StreamTurn[]
	/** `CoachState[]`, one per sample that could make one — the staleness checker's own view. */
	states: unknown[]
	stateAtSec: unknown[]
	/** Samples that produced a state, from the segment's first line. Memory fidelity, checkable. */
	stepped: number
	/* ---- additive ---- */
	/** Samples that could not make a state (loading screen, torn line). Skipped, never faked. */
	skipped?: number
	/** True when the focus section could be rebuilt; false when there was nothing to append. */
	focusSection?: string
	/** How many of `turns` rendered a real `Farm baseline:` figure. See `StreamTurn.paceInBlock`. */
	turnsWithPace?: number
	/** Things the caller must not paper over. Empty is the normal case. */
	warnings?: string[]
	/**
	 * The farm baseline AS IT WAS during this game, so a caller building its own payloads uses the
	 * same one the turns were rendered with rather than today's.
	 */
	baseline?: unknown
	/**
	 * EVERY sample that made a state, in order — not only the checkpoint ones.
	 *
	 * `coach-memory.observe` is documented to see every poll, because a back, a death and a
	 * completed item can all land between two turns and "since your last look" is only true if the
	 * memory watched the gap. A bench that observed only its own checkpoints would hold a thinner
	 * memory than the app and would then report the memory sections as emptier than they are.
	 */
	samples?: { raw: unknown; gameTimeSec: number; line: number }[]
}

/* ============================================================ pure utilities */

/**
 * The upper-middle element, NOT the average of the two middle ones.
 *
 * A real observation rather than a number nobody measured, and it is also the convention the
 * authoritative window census used: averaging gives 1265ms and 1602ms for the two windows where the
 * census reports 1339ms and 1619ms. Those are the same skews described two ways, and a harness that
 * silently reports a different figure from the recon it was built on invites an afternoon of
 * looking for a join bug that is not there.
 */
export const median = (xs: readonly number[]): number => {
	if (xs.length === 0) return 0
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.floor(s.length / 2)]!
}

export const clockText = (sec: number): string =>
	`${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`

/**
 * The rename fix, isolated so a test can hold it.
 *
 * The stored path is absolute and points at `/home/ssalb/coachskaffur/data/journal/<session>/<file>`.
 * When it resolves, it is used unchanged — some rows were written after the rename and are already
 * right. Otherwise the basename is re-hung under this checkout's own journal directory.
 */
export const rebaseFramePath = (storedPath: string, sessionId: string, dataDir = DATA_DIR): string =>
	existsSync(storedPath) ? storedPath : join(dataDir, "journal", sessionId, basename(storedPath))

/**
 * Width and height off the JPEG header, or null when these bytes are not a JPEG.
 *
 * The point is not the dimensions, it is that the file was OPENED. A frame is excluded on anything
 * that is not a parseable image rather than assumed present, because the failure this replaces is a
 * harness that believed 503 missing files were fine and reported a vision result from a text-only
 * run.
 *
 * Only the first 64KB is scanned: every SOF in this corpus is in the first few hundred bytes, and a
 * scan that walks a 200KB entropy-coded scan segment looking for a marker will find one by accident.
 */
export const jpegSize = (buf: Buffer): { width: number; height: number } | null => {
	if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
	const limit = Math.min(buf.length, 65_536)
	let i = 2
	while (i + 3 < limit) {
		if (buf[i] !== 0xff) return null
		let marker = buf[i + 1]!
		// Fill bytes: any number of 0xFF may precede a marker.
		let j = i + 1
		while (marker === 0xff && j + 1 < limit) {
			j += 1
			marker = buf[j]!
		}
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			i = j + 1
			continue
		}
		// Start of scan: the header is over and everything after it is compressed data.
		if (marker === 0xda) return null
		const lenAt = j + 1
		if (lenAt + 1 >= limit) return null
		const len = buf.readUInt16BE(lenAt)
		const isSof =
			marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
		if (isSof) {
			if (lenAt + 6 >= buf.length) return null
			return { height: buf.readUInt16BE(lenAt + 3), width: buf.readUInt16BE(lenAt + 5) }
		}
		i = lenAt + len
	}
	return null
}

/**
 * Cut an ordered stream into per-game segments.
 *
 * The two rules are the ones `src/daemon/live-sampler.ts` rolls its own session on: the game clock
 * running backwards is a new game, and a long wall-clock gap is him sitting on his desktop between
 * two. Pure, and exported, because getting it wrong merges two games into one window and every
 * number downstream is then a number about neither.
 */
export const segment = <T>(
	rows: readonly T[],
	atMs: (row: T) => number,
	gameSec: (row: T) => number
): T[][] => {
	const out: T[][] = []
	let run: T[] = []
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]!
		const prev = rows[i - 1]
		const cut =
			prev !== undefined &&
			(gameSec(row) < gameSec(prev) - CLOCK_BACK_TOLERANCE_SEC ||
				atMs(row) - atMs(prev) > WALL_GAP_MS)
		if (cut && run.length > 0) {
			out.push(run)
			run = []
		}
		run.push(row)
	}
	if (run.length > 0) out.push(run)
	return out
}

export interface GameRow {
	gameId: string
	gameCreationMs: number
	gameDurationSec: number
	championName: string
}

/**
 * Which game a run belongs to, from when its clock read zero — never from a session id.
 *
 * `journal_session.gameId` is one id for a session that spans seven games (trap 2), so it cannot be
 * the answer, and the same is true of a sample file that holds four (trap 3). The zero-instant is
 * the only thing a run and a game row genuinely share. A run further than `MAX_START_GAP_MS` from
 * every game is returned unmatched rather than handed to its nearest one.
 */
export const resolveGame = (zeroInstantMs: number, games: readonly GameRow[]): GameRow | null => {
	let best: GameRow | null = null
	let bestGap = Infinity
	for (const g of games) {
		const gap = Math.abs(g.gameCreationMs - zeroInstantMs)
		if (gap < bestGap) {
			bestGap = gap
			best = g
		}
	}
	return best !== null && bestGap <= MAX_START_GAP_MS ? best : null
}

/**
 * Nearest sample by wall clock, or a refusal.
 *
 * Refusals are counted and reported, never quietly dropped: a frame from a different moment is the
 * exact defect this module exists to eliminate, and it is what made `bench-providers` score a
 * frame-reading model worse than a frame-ignoring one.
 */
export const nearestSample = (
	atMs: number,
	samples: readonly RawSample[],
	maxSkewMs: number
): { sample: RawSample; skewMs: number } | null => {
	let best: RawSample | null = null
	let bestSkew = Infinity
	for (const s of samples) {
		const skew = Math.abs(s.atMs - atMs)
		if (skew < bestSkew) {
			bestSkew = skew
			best = s
		}
	}
	return best !== null && bestSkew <= maxSkewMs ? { sample: best, skewMs: bestSkew } : null
}

/**
 * Which candidates become turns, by game-clock cadence.
 *
 * Separated out and pure because the off-by-one here is invisible in a report: a cadence that
 * advances from the REQUESTED time rather than from the time actually taken drifts a whole turn
 * behind on a stream whose samples land every five seconds.
 */
/**
 * WHICH samples the coach is asked at, when the schedule is the EVENT DETECTOR rather than a timer.
 *
 * The bench existed before `src/analysis/live-events.ts` did, so it only ever knew how to ask on a
 * cadence. That is now the wrong instrument: the shipped `trusted` path asks when the game moves,
 * and a bench that asks every twenty seconds measures a coach nobody runs. Worse, it measures the
 * exact thing the event work was meant to remove — a model invited to speak at a moment when
 * nothing happened, whose only remaining material is his own HUD.
 *
 * The detector is stepped over EVERY sample, not only the ones that become turns, for the same
 * reason `buildFacts` is: `observeTick` diffs against the previous tick and `EventWatch` carries
 * fired-once keys, a fight cluster and the counterpart-absence clock. Stepping only the checkpoints
 * would diff across twenty-second holes and invent transitions that never happened.
 *
 * `stride` subsamples the DUE turns and exists for cost, not for policy. Sixty-seven due turns at
 * one paid call each is more than a run of this script is authorised to spend, and truncating with
 * `turns` instead would buy a bench of the first nine minutes — no baron window, no late objective,
 * none of the prospective calls this round is trying to measure. Every skipped turn is a question
 * the coach was not asked; nothing is suppressed and no event is dropped, because the events a
 * skipped turn would have carried stay in `watch.pending` and ride the next one. A stride > 1 is
 * recorded on the run so no reader can mistake the sample for the whole game.
 */
export interface ScheduledTurn {
	/** 1-based ndjson line of the sample the turn fires on. */
	sampleLine: number
	atSec: number
	/** `describeTurn` — why she was asked. For the sheet and the report, never for the model. */
	why: string
	/** False when any pending event is reactive: the read would land after the moment it is about. */
	readMinimap: boolean
	kinds: string[]
	/** True for a turn the detector raised and `stride` declined to spend a call on. */
	skipped: boolean
}

export const pickEventCheckpoints = (
	rows: readonly { line: number; gameTime: number; data: unknown }[],
	opts: { heartbeatSec?: number; stride?: number; fromSec?: number } = {}
): ScheduledTurn[] => {
	const watch = newEventWatch()
	const stride = Math.max(1, opts.stride ?? 1)
	const fromSec = opts.fromSec ?? 0
	const out: ScheduledTurn[] = []
	let due = 0
	for (const row of rows) {
		const tick = projectTick(row.data as LiveAllGameData)
		// A sample that makes no tick is the loading screen or a torn tail line. It is skipped and
		// never faked, exactly as `buildLiveStateForBench` skips it above.
		if (!tick) continue
		/*
		 * Two statements: `observeTick`'s new-game branch replaces `watch.pending`, and JS evaluates
		 * the member expression before the arguments — so a one-liner pushes onto the detached array.
		 */
		/*
		 * `commentary` — the FULL schedule, named out loud.
		 *
		 * The shipped default is now `big-calls` (see `SPEAK_LEVELS`), and a bench that silently
		 * inherited it would compare models on a third of the turns and would quietly stop being
		 * comparable with every run already on disk. Which schedule a replay replays is a property
		 * of the replay, so it is stated here rather than defaulted into.
		 */
		const fired = observeTick(watch, tick, { level: "commentary" })
		watch.pending.push(...fired)
		const reason = dueTurn(watch, tick.gameTimeSec, {
			heartbeatSec: opts.heartbeatSec,
			level: "commentary"
		})
		if (!reason) continue
		/*
		 * `dueTurn` PEEKS; the queue is spent by `commitTurn`, because in the app a send can fail
		 * and the events must survive it. A replay always "sends", so it commits every turn — and
		 * it must, or `lastTurnAtSec` never advances, every subsequent tick answers due, and a
		 * 28-minute game reports 279 turns instead of 67.
		 */
		commitTurn(watch, reason, tick.gameTimeSec)
		if (tick.gameTimeSec < fromSec) continue
		const skipped = due % stride !== 0
		due += 1
		out.push({
			sampleLine: row.line,
			atSec: tick.gameTimeSec,
			why: describeTurn(reason),
			readMinimap: reason.readMinimap,
			kinds: reason.heartbeat ? ["heartbeat"] : reason.events.map(e => e.kind),
			skipped
		})
	}
	return out
}

export const pickCheckpoints = (
	atSecs: readonly number[],
	opts: { everySec: number; fromSec: number; turns: number }
): number[] => {
	const out: number[] = []
	let nextAt = opts.fromSec
	for (let i = 0; i < atSecs.length && out.length < opts.turns; i++) {
		const at = atSecs[i]!
		if (at < nextAt) continue
		out.push(i)
		nextAt = at + opts.everySec
	}
	return out
}

/* ================================================================= discovery */

interface FrameRow {
	id: string
	sessionId: string
	tSec: number
	path: string
	atMs: number
	clock: string
	truthJson: string | null
	bytes: number
}

/** One game's worth of raw samples, cut out of one file and resolved to one game row. */
export interface SampleSegment {
	/** Absolute path to the ndjson the samples came out of. */
	file: string
	game: GameRow
	/** Every sample of that game, in order, with 1-based line numbers kept. */
	samples: RawSample[]
}

/**
 * A sample file, or a game, that CANNOT be benched, and the reason in one sentence.
 *
 * Returned rather than skipped. Every one of these is a game somebody might reasonably expect in a
 * 15-game table, and a harness that drops them silently reports a smaller corpus than exists with
 * no way to tell a corrupt file from a file nobody looked at. A reader who sees the row can go open
 * the bytes; a reader who sees nothing cannot.
 */
export interface RejectedSegment {
	file: string
	/** The game it resolved to, when it resolved to exactly one. */
	gameId: string | null
	samples: number
	why: string
}

/**
 * Every game row, once, for a discovery pass that needs to resolve runs and segments against them.
 *
 * Read-only, like everything else in this module: the daemon owns the database and may be holding a
 * game open while this runs.
 */
export const readGames = (): GameRow[] => {
	const db = new DatabaseSync(DB_PATH, { readOnly: true })
	const rows = db
		.prepare("SELECT gameId, gameCreationMs, gameDurationSec, championName FROM game")
		.all() as unknown as {
		gameId: number | bigint
		gameCreationMs: number | bigint
		gameDurationSec: number | bigint
		championName: string | null
	}[]
	db.close()
	return rows.map(g => ({
		gameId: String(g.gameId),
		gameCreationMs: Number(g.gameCreationMs),
		gameDurationSec: Number(g.gameDurationSec),
		championName: g.championName ?? ""
	}))
}

/**
 * Every sample file on disk, cut into one-game segments — the reader BOTH discovery paths share.
 *
 * Lifted verbatim out of `discoverWindows`, where it was steps 5 and 8 of the join spec, because
 * the text-only path needs exactly the same rules and a second copy of them is how five harnesses
 * came to disagree about what a game is. The two rules, and the two traps they answer:
 *
 * A file that holds more than one GAME is SUPERSEDED, not used. `js-mtn2jrku-8ae9.ndjson` is four
 * games and `split-01..04.ndjson` are those same four, one per file, byte for byte (213+353+363+292
 * = 1221 lines). Benchmarking both would double-count them, and a window has to be one game before
 * `buildFacts` can be stepped through it from that game's t=0. The suppressed file comes back in
 * `rejected` with its game count, so the table can say WHY the corpus is 17 games and not 21.
 *
 * ONE GAME CUT IN TWO IS STILL ONE GAME. `js-mtoryjv8-690a-t29810607.ndjson` is a single line at
 * gameTime 0 and then 369 lines from gameTime 5, with 80 SECONDS of wall clock between them: the
 * loading screen, where the client answers with a clock that is not moving. The wall-gap rule cuts
 * there, correctly, and both halves resolve to game 5635921368. Suppressing the file on the SEGMENT
 * count rather than the GAME count deleted that entire arm once already. Same-game segments are
 * rejoined in order.
 */
export const sampleSegments = (
	games: readonly GameRow[],
	dataDir = DATA_DIR
): { segments: SampleSegment[]; rejected: RejectedSegment[] } => {
	const segments: SampleSegment[] = []
	const rejected: RejectedSegment[] = []
	const dir = join(dataDir, "live-samples")
	const files = existsSync(dir) ?
		readdirSync(dir)
			.filter(f => f.endsWith(".ndjson"))
			.sort()
	:	[]
	for (const file of files) {
		const path = join(dir, file)
		const read = readVerbatimCensus(path)
		const rows = read.rows
		if (rows.length === 0) {
			rejected.push({
				file: path,
				gameId: null,
				samples: 0,
				// "no readable lines" and "every line was torn" are different faults with different
				// fixes, and a rejection line that cannot tell them apart sends a human to the wrong
				// place. The torn count is on the row that refuses the file.
				why:
					read.torn === 0 ?
						"no ndjson lines at all — the file is empty"
					:	`no readable ndjson lines: all ${read.torn} non-blank line(s) failed to parse`
			})
			continue
		}
		const cut = segment(
			rows,
			r => r.atMs,
			r => r.gameTime
		)
		const resolved = cut.map(samples => ({
			samples,
			game: resolveGame(median(samples.map(s => s.atMs - s.gameTime * 1000)), games)
		}))
		const ids = new Set(resolved.map(r => r.game?.gameId ?? "unmatched"))
		if (ids.size > 1) {
			rejected.push({
				file: path,
				gameId: null,
				samples: rows.length,
				why:
					`holds ${ids.size} games (${[...ids].join(", ")}) appended into one file — SUPERSEDED. ` +
					"A window has to be one game before the ranker can be stepped through it from that " +
					"game's t=0; use the per-game split files instead, never both."
			})
			continue
		}
		const game = resolved[0]?.game
		if (!game) {
			rejected.push({
				file: path,
				gameId: null,
				samples: rows.length,
				why:
					`no game row within ${MAX_START_GAP_MS / 1000}s of the instant its clock read zero — ` +
					"the match was never harvested, so there is no duration, champion or baseline for it"
			})
			continue
		}
		segments.push({ file: path, game, samples: resolved.flatMap(r => r.samples) })
	}
	return { segments, rejected }
}

/**
 * Every window in the corpus where a REAL FRAME and REAL RAW CLIENT DATA exist for the same
 * instant, with the join spec applied end to end.
 *
 * Read-only on the database throughout — this is safe to run while a game is in progress, unlike
 * anything that opens a Gemini Live socket, which the live coach wants for itself.
 */
export const discoverWindows = (opts?: { maxSkewMs?: number }): StreamWindow[] => {
	const maxSkewMs = opts?.maxSkewMs ?? DEFAULT_MAX_SKEW_MS
	const db = new DatabaseSync(DB_PATH, { readOnly: true })
	const frameRows = db
		.prepare("SELECT id, sessionId, tSec, path, atMs, clock, truthJson, bytes FROM journal_frame ORDER BY atMs")
		.all() as unknown as FrameRow[]
	db.close()
	const games = readGames()

	/* -- step 1: rebase, then OPEN. A frame that cannot be read is excluded and counted. -- */
	const usable: FrameRow[] = []
	let unopenable = 0
	for (const row of frameRows) {
		const path = rebaseFramePath(row.path, row.sessionId)
		let ok = false
		try {
			ok = jpegSize(readFileSync(path)) !== null
		} catch {
			ok = false
		}
		if (!ok) {
			unopenable += 1
			continue
		}
		usable.push({ ...row, path, tSec: Number(row.tSec), atMs: Number(row.atMs), bytes: Number(row.bytes) })
	}

	/* -- steps 2 and 3: cut runs out of each session, resolve each run's game on its own -- */
	interface Run {
		windowId: string
		sessionId: string
		ordinal: number
		game: GameRow
		frames: FrameRow[]
		droppedPostGame: number
	}
	const runs: Run[] = []
	const sessions = [...new Set(usable.map(f => f.sessionId))]
	for (const sessionId of sessions) {
		const mine = usable.filter(f => f.sessionId === sessionId)
		const cut = segment(
			mine,
			f => f.atMs,
			f => f.tSec
		)
		for (let ordinal = 0; ordinal < cut.length; ordinal++) {
			const frames = cut[ordinal]!
			const game = resolveGame(
				median(frames.map(f => f.atMs - f.tSec * 1000)),
				games
			)
			// Unmatched is reported by absence: a run with no game cannot be paired to a sample
			// segment by gameId either, so it can never reach a window. It is never guessed into one.
			if (!game) continue
			/* -- step 4: a frame past the game's own duration is not of this game -- */
			const kept = frames.filter(f => f.tSec <= game.gameDurationSec + 2)
			runs.push({
				windowId: "",
				sessionId,
				ordinal,
				game,
				frames: kept,
				droppedPostGame: frames.length - kept.length
			})
		}
	}

	/* -- steps 5 and 8: sample files, cut the same way; a multi-game file is never a window -- */
	const { segments } = sampleSegments(games)

	/* -- steps 6 and 7: pair, refuse anything worse than the skew, and name it stably -- */
	const windows: StreamWindow[] = []
	for (const seg of segments) {
		const first = seg.samples[0]!.atMs
		const last = seg.samples[seg.samples.length - 1]!.atMs
		for (const run of runs) {
			if (run.game.gameId !== seg.game.gameId) continue
			const inWindow = run.frames.filter(f => f.atMs >= first - maxSkewMs && f.atMs <= last + maxSkewMs)
			if (inWindow.length === 0) continue
			const paired: PairedFrame[] = []
			const skews: number[] = []
			const lines = new Set<number>()
			let refused = 0
			for (const f of inWindow) {
				const hit = nearestSample(f.atMs, seg.samples, maxSkewMs)
				if (!hit) {
					refused += 1
					continue
				}
				skews.push(hit.skewMs)
				lines.add(hit.sample.line)
				paired.push({
					id: f.id,
					path: f.path,
					tSec: f.tSec,
					atMs: f.atMs,
					clock: f.clock,
					storedBlock: f.truthJson,
					bytes: f.bytes
				})
			}
			if (paired.length < MIN_PAIRED_FRAMES) continue
			paired.sort((a, b) => a.tSec - b.tSec)
			windows.push({
				id: basename(seg.file, ".ndjson"),
				sampleFile: seg.file,
				gameId: seg.game.gameId,
				champion: seg.game.championName,
				kind: "paired",
				samples: seg.samples.length,
				gameDurationSec: seg.game.gameDurationSec,
				firstSampleSec: Math.round(seg.samples[0]!.gameTime),
				lastSampleSec: Math.round(seg.samples[seg.samples.length - 1]!.gameTime),
				frames: paired,
				medianSkewMs: median(skews),
				tSecFrom: paired[0]!.tSec,
				tSecTo: paired[paired.length - 1]!.tSec,
				windowId: `${basename(seg.file, ".ndjson")}@${run.sessionId}#${run.ordinal}`,
				refusedFrames: refused,
				droppedPostGame: run.droppedPostGame,
				distinctSampleLines: lines.size,
				windowNotes: [
					`${paired.length} frames paired within ${maxSkewMs}ms; ${refused} refused as too far from any sample.`,
					`${lines.size} distinct sample lines carry those ${paired.length} frames — several frames legitimately share one client state and are NOT deduplicated.`,
					`${run.droppedPostGame} frames dropped for a tSec past the game's own ${run.game.gameDurationSec}s duration. That is a FILTER, not a verdict: nothing here claims any remaining frame shows the game. Only a human opening one may say that.`,
					`${unopenable} frames corpus-wide could not be opened or parsed as JPEG and were excluded.`,
					`journal_session.gameId is not used; this run's game was resolved from when its clock read zero.`
				]
			})
		}
	}

	/* Two windows sharing a basename get the full step-7 name, so an id is never ambiguous. */
	const seen = new Map<string, number>()
	for (const w of windows) seen.set(w.id, (seen.get(w.id) ?? 0) + 1)
	for (const w of windows) if ((seen.get(w.id) ?? 0) > 1) w.id = w.windowId!

	windows.sort((a, b) => b.frames.length - a.frames.length || a.id.localeCompare(b.id))
	return windows
}

/**
 * Every game with raw samples and NO paired frames, as a first-class window.
 *
 * ## Why this exists
 *
 * Every tuning decision taken on this app was made on one game, and then on two. The reason was
 * never that the corpus was two games — it is seventeen — it was that `discoverWindows` can only
 * see a game the BROWSER was watching, because a window needed a journal frame. The daemon's own
 * sampler (`src/daemon/live-sampler.ts`) recorded thirteen more games in full, on the supervisor's
 * poll, with the page closed. Those games hold exactly the thing an evaluation most wants — a game
 * played the way he actually plays — and the harness could not enumerate them.
 *
 * A text-only window is not a degraded paired one. Its block is built by the same
 * `buildLiveStateForBench`, its facts are ranked by the same `buildFacts` stepped from the same
 * t=0, its brief is the same `buildBrief`. The single difference is that `frames` is empty, so a
 * turn carries no image and a sighted arm's request is byte-identical to its blind twin's. Which is
 * to say: on these games the FRAME axis cannot be measured at all, and everything else can.
 *
 * ## The three hazards, each of which is handled here rather than left to the caller
 *
 * 1. **One file, several games.** `sampleSegments` supersedes a multi-game file and reports it in
 *    `rejected`; the per-game `split-01..04.ndjson` are used instead, never both.
 * 2. **Two files, one game.** `js-mtn2jrku-8ae9-t29810607.ndjson` is a single line of game
 *    5635921368, written under the outgoing session's key four seconds before the sampler rolled
 *    over; the real file has 370. When two segments resolve to one game the longer one wins and the
 *    shorter is reported, because benching both would pool one game twice under two ids.
 * 3. **A game already paired.** The four games that have journal frames keep their paired window
 *    and get no text twin. A paired window already steps the whole file — `buildStream` reads the
 *    segment from line 1 regardless of where the frames start — so a text twin would be the same
 *    game a second time with one axis deleted.
 *
 * A game whose samples start late (`split-01` begins at 14:04) is NOT excluded. It is real client
 * JSON and every block built from it is a block the coach could have held; what is missing is the
 * coach's MEMORY of the first fourteen minutes, and that is said in `windowNotes` and carried in
 * `firstSampleSec` so a report can label it rather than a discovery pass silently deleting the
 * longest game in the corpus.
 */
export const discoverTextWindows = (opts?: {
	/** Game ids that already have a paired window and must not get a text twin. */
	exclude?: ReadonlySet<string>
	minSamples?: number
}): { windows: StreamWindow[]; rejected: RejectedSegment[] } => {
	const minSamples = opts?.minSamples ?? MIN_TEXT_SAMPLES
	const exclude = opts?.exclude ?? new Set<string>()
	const games = readGames()
	const { segments, rejected } = sampleSegments(games)

	/* -- hazard 2: one game, several files. The longest segment is the game; the rest are said. -- */
	const best = new Map<string, SampleSegment>()
	for (const seg of segments) {
		const prev = best.get(seg.game.gameId)
		if (prev === undefined || seg.samples.length > prev.samples.length) best.set(seg.game.gameId, seg)
	}
	for (const seg of segments) {
		const winner = best.get(seg.game.gameId)!
		if (winner === seg) continue
		rejected.push({
			file: seg.file,
			gameId: seg.game.gameId,
			samples: seg.samples.length,
			why:
				`a second file for game ${seg.game.gameId}, which ${basename(winner.file)} covers with ` +
				`${winner.samples.length} samples — a session-rollover fragment, not a game. Benching both ` +
				"would pool one game twice under two ids."
		})
	}

	const windows: StreamWindow[] = []
	for (const seg of best.values()) {
		/* -- hazard 3: a game with frames keeps its paired window and gets no twin -- */
		if (exclude.has(seg.game.gameId)) continue
		if (seg.samples.length < minSamples) {
			rejected.push({
				file: seg.file,
				gameId: seg.game.gameId,
				samples: seg.samples.length,
				why: `only ${seg.samples.length} samples, under the ${minSamples}-sample floor for a text-only game`
			})
			continue
		}
		const from = Math.round(seg.samples[0]!.gameTime)
		const to = Math.round(seg.samples[seg.samples.length - 1]!.gameTime)
		const notes = [
			`${seg.samples.length} raw client samples, ${clockText(from)}–${clockText(to)} of a ${clockText(seg.game.gameDurationSec)} game.`,
			"TEXT-ONLY: no journal frame exists for any instant of this game, because the browser was " +
				"not watching it. Every turn carries a block and no image, so the frame axis is not " +
				"measured here and a sighted arm's request is byte-identical to a blind one's.",
			"The block, the ranked list and the brief are the shipped ones — same `buildLiveStateForBench`, " +
				"same `buildFacts` stepped from this game's own first sample, same `buildBrief`."
		]
		if (from > 30)
			notes.push(
				`!! THE SAMPLER STARTED ${clockText(from)} INTO THIS GAME. The turns are real, but the ` +
					"coach's MEMORY is not: `buildFacts` announces each death once, gold once per 800g and " +
					"only after it has been HELD, farm once per three minutes, and the state-shaped facts " +
					"once per game — all of which are functions of a stream whose first " +
					`${clockText(from)} was never recorded. Read a fact that fires here as possibly one the ` +
					"live coach would already have spent."
			)
		windows.push({
			id: basename(seg.file, ".ndjson"),
			sampleFile: seg.file,
			gameId: seg.game.gameId,
			champion: seg.game.championName,
			kind: "text-only",
			gameDurationSec: seg.game.gameDurationSec,
			frames: [],
			medianSkewMs: 0,
			tSecFrom: from,
			tSecTo: to,
			windowId: `${basename(seg.file, ".ndjson")}@text#0`,
			refusedFrames: 0,
			droppedPostGame: 0,
			distinctSampleLines: seg.samples.length,
			samples: seg.samples.length,
			firstSampleSec: from,
			lastSampleSec: to,
			windowNotes: notes
		})
	}
	windows.sort((a, b) => a.gameId.localeCompare(b.gameId))
	return { windows, rejected }
}

/**
 * THE WHOLE BENCHABLE CORPUS, in one call: every game that can be replayed, and every one that
 * cannot with the reason why.
 *
 * The paired windows come back exactly as `discoverWindows` returns them, in the same order, so a
 * caller that only wants the old behaviour gets the old behaviour. The text-only windows are the
 * games that have no paired one. `rejected` is the rest, and it is not decoration — a game that
 * cannot be replayed is DATA, and the thing that made this corpus look like two games for a month
 * was a discovery pass that returned only its successes.
 */
export const discoverBenchable = (opts?: {
	maxSkewMs?: number
	minSamples?: number
}): { paired: StreamWindow[]; textOnly: StreamWindow[]; rejected: RejectedSegment[] } => {
	const paired = discoverWindows({ maxSkewMs: opts?.maxSkewMs })
	const { windows, rejected } = discoverTextWindows({
		exclude: new Set(paired.map(w => w.gameId)),
		minSamples: opts?.minSamples
	})
	return { paired, textOnly: windows, rejected }
}

/* ================================================================== the walk */

/**
 * Every game's creation instant, so the two time-restricted sections can share one read.
 *
 * A map rather than a query per item: `recentFeedbackItems` returns up to 160 rows and the cutoff
 * below has to test every one of them.
 */
const gameCreationMsOf = (gameId: string): number => {
	const db = new DatabaseSync(DB_PATH, { readOnly: true })
	const row = db.prepare("SELECT gameCreationMs FROM game WHERE gameId = ?").get(Number(gameId)) as
		| { gameCreationMs: number | bigint }
		| undefined
	db.close()
	return Number(row?.gameCreationMs ?? 0)
}

const gameCreationMsById = (): Map<number, number> => {
	const db = new DatabaseSync(DB_PATH, { readOnly: true })
	const rows = db.prepare("SELECT gameId, gameCreationMs FROM game").all() as {
		gameId: number | bigint
		gameCreationMs: number | bigint
	}[]
	db.close()
	return new Map(rows.map(r => [Number(r.gameId), Number(r.gameCreationMs)]))
}

/**
 * The past-reviews section, rebuilt from the two calls `standingFocus` makes — and CUT OFF at the
 * replayed game, exactly as the farm baseline is.
 *
 * Appended OUTSIDE the ground-truth block and labelled as coming from past reviews, exactly as
 * `routes/live.ts` does it. Inside the block, under a heading that says these are FACTS, a
 * criticism from a game three days ago reads as something happening right now — which is how a
 * coach ends up telling him to stop doing a thing he is not currently doing.
 *
 * The cutoff is the correction. `baselineDuring` already drops games created at or after the
 * replayed one, "because letting the future set the average would make the block's
 * `Farm baseline:` line a number that never existed at the time" — and the identical argument
 * applies to a focus bullet, which is a sentence some later review wrote. It bites harder here:
 * on a window whose ranked list is empty the mock control speaks the first `- ` line of the
 * block, which IS a focus bullet, so without the cutoff the run's own zero point is a function of
 * reviews written after the game, and two replays of one window on two different days are
 * silently not comparable.
 *
 * `beforeMs === 0` means the replayed game is not in the `game` table at all. Nothing is filtered
 * then — inventing a cutoff from a creation time nobody has would be worse — and the caller warns.
 */
const focusSectionText = (
	beforeMs: number
): { text: string; considered: number; eligible: number; restricted: boolean } => {
	const settings = getSettings()
	const items = recentFeedbackItems(settings.gamesForTrends * 8)
	const createdMs = beforeMs === 0 ? new Map<number, number>() : gameCreationMsById()
	const eligible =
		beforeMs === 0 ? items
		:	items.filter(i => i.gameId !== null && (createdMs.get(i.gameId) ?? 0) < beforeMs)
	const focus = focusAreas(eligible, 3)
		.map(f => f.fixes[0] ?? "")
		.filter(f => f !== "")
	const text =
		focus.length > 0 ?
			`\n\n## From his PAST reviews — not from this game\n\nThese are habits he is working on. Mention one only if THIS game's facts show it happening again.\n\n${focus
				.map(f => `- ${f}`)
				.join("\n")}`
		:	""
	return { text, considered: items.length, eligible: eligible.length, restricted: beforeMs !== 0 }
}

/**
 * BETWEEN GAMES, driven the way the daemon drives it — the fix that makes a multi-game run honest.
 *
 * `routes/live.ts` keeps `factMemory`, `fightMemory`, `adviceCursor` and the carried frame state at
 * module scope, and the only code that clears them is the between-games branch of `buildLiveState`.
 * `buildFacts` saves itself — it resets on a clock that runs backwards, which a second window at
 * t=0 always does — but the other three do not, and until this existed the module said so and gave
 * up: *"build one window per process when the fight lines or the champion clauses matter."* That
 * was tolerable when the harness could see two games. It is not tolerable at fifteen, where it
 * would corrupt fourteen of them:
 *
 *   - `fights.ts` keys its announce-once set on `fight@<gameClockSecond>`, so a fight at 6:12 of
 *     game two is silently suppressed because a fight at 6:12 of game one was announced. Across
 *     fifteen 30-minute games almost every second of game clock is eventually spoken for, so the
 *     later games would lose most of their fight lines and would look like a quieter coach.
 *   - `adviceCursor` counts FIRINGS per fact kind to rotate the champion clauses, so game two
 *     continues game one's rotation and renders a different clause than the live coach — which
 *     starts every game at the top — would have shown.
 *
 * Node cannot purge an ESM module and nothing in `src/` exports a reset for the daemon's own
 * singletons. So this does not reach into them: it DRIVES THE TRANSITION, by handing
 * `buildLiveStateForBench` the payload shape the live client produces between two games — a player
 * who is on no champion. `buildLiveState` takes its `!me.championName` branch, which is the branch
 * whose entire body is the reset, and returns null. That is the same code path, in the same order,
 * that runs on his machine when one game ends and the next is drafted; nothing here is a copy of
 * it, so it cannot go stale the way a hand-written field list did (counted at the time it was
 * replaced, that list named 22 of 26 fields).
 *
 * Deliberately called BEFORE each window rather than after, including the first. Before the first
 * it is a no-op on a fresh process — every singleton is already at its initial value — which is
 * what keeps a single-window run byte-identical to the runs already stored on disk. Before the
 * second it is the whole point.
 */
export const resetCoachMemoryBetweenGames = (): void => {
	/*
	 * `findMe` matches `activePlayer.riotId` against the roster, so both have to be present or it
	 * returns null and `buildLiveStateForBench` bails one call EARLIER than the reset — which is
	 * exactly the trap this replaces. The champion is empty on purpose: that is what the live
	 * client reports between games, and it is the condition the reset branch tests.
	 */
	buildLiveStateForBench(
		{
			activePlayer: { riotId: "bench-between-games" },
			allPlayers: [{ riotId: "bench-between-games", championName: "" }]
		},
		0,
		null
	)
}

/** How many streams this PROCESS has built, so the one thing still not repaired can be said. */
let streamsBuiltInThisProcess = 0

export const buildStream = (
	window: StreamWindow,
	opts: {
		everySec: number
		fromSec: number
		turns: number
		requireFrame: boolean
		/** "events" runs the shipped detector; "timer" keeps the old cadence for comparison. */
		schedule?: "timer" | "events"
		/** Cost-only subsample of the due turns. See `pickEventCheckpoints`. */
		stride?: number
		heartbeatSec?: number
	}
): BuiltStream => {
	const warnings: string[] = []
	streamsBuiltInThisProcess += 1
	/*
	 * Every window starts the way a game starts on his machine: with the between-games transition
	 * already run. On the first window of a process this changes nothing — the singletons are at
	 * their initial values — which is what keeps a one-window run identical to the stored ones.
	 */
	resetCoachMemoryBetweenGames()

	/*
	 * -- the segment: the whole file, because discovery only emits one-game files --
	 *
	 * `discoverWindows` suppresses any sample file whose segments resolve to more than one game, and
	 * rejoins same-game segments (the Gwen file's 80-second loading-screen gap). So the segment for a
	 * window this module produced is the file, from line 1 — which is what step 9 of the join spec
	 * asks for: the ranker stepped from that game's own t=0, not from the first paired frame.
	 *
	 * Checked rather than assumed: a window whose frames do not lie inside the file's wall-clock span
	 * is a window built somewhere else, and replaying it here would silently measure a different
	 * game.
	 */
	const read = readVerbatimCensus(window.sampleFile)
	const seg = read.rows
	if (seg.length === 0) throw new Error(`${window.sampleFile} holds no readable samples`)
	/*
	 * A torn line is a sample this replay will never step through, so it is said out loud rather
	 * than absorbed. The last-line case is the ordinary one — a daemon killed mid-write — and is
	 * reported without alarm; a tear anywhere else means the file is damaged and the replay is of
	 * a stream with holes in it, which is a fact about every number computed from this window.
	 */
	if (read.torn > 0)
		warnings.push(
			`${read.torn} torn line(s) in ${window.sampleFile} (line${read.tornLines.length === 1 ? "" : "s"} ` +
				`${read.tornLines.join(", ")}${read.torn > read.tornLines.length ? ", …" : ""}) could not be parsed and ` +
				`are absent from this replay: ${seg.length} sample(s) of ${seg.length + read.torn} were readable. ` +
				(read.tornMid === 0 ?
					"All of them are the file's last line — a daemon killed mid-write, and everything before it is good."
				:	`${read.tornMid} of them are NOT the last line, so the file is DAMAGED rather than truncated and ` +
					"this window has holes in the middle of it.")
		)
	const firstFrameMs = window.frames[0]?.atMs ?? 0
	const lastFrameMs = window.frames[window.frames.length - 1]?.atMs ?? 0
	if (
		window.frames.length > 0 &&
		(firstFrameMs < seg[0]!.atMs - DEFAULT_MAX_SKEW_MS ||
			lastFrameMs > seg[seg.length - 1]!.atMs + DEFAULT_MAX_SKEW_MS)
	)
		throw new Error(
			`window ${window.id} has frames outside the wall-clock span of ${window.sampleFile} — ` +
				`it was not built by discoverWindows against this file`
		)

	/* -- the frames, re-paired to sample lines by the same rule, so nothing is stashed -- */
	const frameBySampleLine = new Map<number, { frame: PairedFrame; skewMs: number }>()
	for (const f of window.frames) {
		const hit = nearestSample(f.atMs, seg, DEFAULT_MAX_SKEW_MS)
		if (!hit) continue
		const prev = frameBySampleLine.get(hit.sample.line)
		// When several frames share one sample line — the normal case, since frames arrive on the
		// WALL clock and samples on the GAME clock — the closest one wins the checkpoint. The others
		// remain in `window.frames`; a caller wanting all of them has them there.
		if (prev === undefined || hit.skewMs < prev.skewMs)
			frameBySampleLine.set(hit.sample.line, { frame: f, skewMs: hit.skewMs })
	}

	/* -- the baseline as it was DURING this game, never as the future set it -- */
	const { baseline, games: baselineGames } = baselineDuring(window.gameId)
	if (baselineGames === 0)
		warnings.push(
			"No farm baseline: the corpus holds no game created before this one, so the block's " +
				"`Farm baseline:` line states its own absence and the two farm-versus-his-own-average " +
				"rules cannot fire at all. Any report from this stream must say so."
		)

	const mode: LiveCoachMode = getSettings().liveCoachMode
	/*
	 * The focus bullets are restricted to reviews of games created strictly BEFORE this one, the
	 * same rule and for the same reason as the baseline two statements up. Without it the block is
	 * a function of reviews written after the game, and the mock control — which speaks the block's
	 * first `- ` line, and on an empty ranked list that line IS a focus bullet — quietly changes
	 * text every time a later game is reviewed.
	 */
	const createdMs = gameCreationMsOf(window.gameId)
	const focusOut = focusSectionText(createdMs)
	const focus = focusOut.text
	if (createdMs === 0)
		warnings.push(
			`Game ${window.gameId} has no row in the \`game\` table, so the past-reviews focus section ` +
				"could NOT be cut off at this game's creation the way the farm baseline is. Its bullets " +
				"may come from reviews written after the game being replayed."
		)
	if (focus === "")
		warnings.push(
			"No past-reviews focus section: `focusAreas(recentFeedbackItems(...))` returned nothing " +
				`with a fix on it (${focusOut.eligible} of ${focusOut.considered} recent items are from ` +
				"games created before this one). The shipped block appends one when there is one, so " +
				"this stream is missing a section a live turn would have carried."
		)

	/*
	 * EVERY sample, in order, from the segment's first line — not from the first paired one.
	 *
	 * `buildFacts` carries memory: each death announced once, gold once per 800g and only after it
	 * has been held, farm once per three minutes, the state-shaped facts once per game. A stream
	 * that skips samples is a different coach, so the whole segment is stepped and only the
	 * checkpoints are kept.
	 */
	const states: CoachState[] = []
	const stateAtSec: number[] = []
	const built: { sample: RawSample; state: VisionState }[] = []
	let stepped = 0
	let skipped = 0
	for (const row of seg) {
		const state = buildLiveStateForBench(row.data, row.gameTime, baseline)
		// The loading screen and a torn tail line make no state. Skipped, counted, never faked.
		if (!state) {
			skipped += 1
			continue
		}
		stepped += 1
		built.push({ sample: row, state })
		const cs = coachStateFrom(row)
		if (cs) {
			states.push(cs)
			stateAtSec.push(row.gameTime)
		}
	}

	/* -- the checkpoints -- */
	const candidates = built.filter(
		b => !opts.requireFrame || frameBySampleLine.has(b.sample.line)
	)
	/*
	 * Under "events" the detector runs over the WHOLE segment and the turns are the samples it
	 * raised. `requireFrame` then filters that list rather than steering it: a due turn whose
	 * instant has no paired picture is dropped, and it is dropped AFTER the detector saw the tick,
	 * so the fired-once keys and the fight cluster are unaffected by what the camera happened to
	 * catch. `everySec` is not consulted at all on this path, and a report from an event run may
	 * not quote it as the cadence.
	 */
	const schedule = opts.schedule ?? "timer"
	let scheduled: ScheduledTurn[] = []
	let picked: number[] = []
	if (schedule === "events") {
		scheduled = pickEventCheckpoints(
			built.map(b => ({ line: b.sample.line, gameTime: b.sample.gameTime, data: b.sample.data })),
			{ heartbeatSec: opts.heartbeatSec, stride: opts.stride, fromSec: opts.fromSec }
		)
		const byLine = new Map(candidates.map((c, i) => [c.sample.line, i]))
		const wanted = scheduled.filter(t => !t.skipped)
		const missingFrame = wanted.filter(t => !byLine.has(t.sampleLine)).length
		if (missingFrame > 0)
			warnings.push(
				`${missingFrame} of ${wanted.length} event-driven turns had no candidate sample ` +
					`(requireFrame=${opts.requireFrame}) and were not sent. The coach WOULD have been ` +
					"asked at those instants in the app."
			)
		for (const t of wanted) {
			const ci = byLine.get(t.sampleLine)
			if (ci !== undefined && picked.length < opts.turns) picked.push(ci)
		}
	} else {
		picked = pickCheckpoints(
			candidates.map(c => c.sample.gameTime),
			opts
		)
	}
	const whyByLine = new Map(scheduled.map(t => [t.sampleLine, t]))
	const turns: StreamTurn[] = picked.map((ci, index) => {
		const { sample, state } = candidates[ci]!
		const sched = whyByLine.get(sample.line) ?? null
		// The sample immediately before this one in the SEGMENT, for the brief's deltas; the shipped
		// route differences against its own previous poll, and this is that poll.
		const prevRow = built[built.findIndex(b => b.sample.line === sample.line) - 1]?.sample ?? null
		const hit = frameBySampleLine.get(sample.line) ?? null
		const brief = buildBrief({
			raw: sample.data,
			gameTimeSec: sample.gameTime,
			previous: prevRow ? { raw: prevRow.data, gameTimeSec: prevRow.gameTime } : null,
			baseline
		})
		return {
			index,
			atSec: sample.gameTime,
			clock: clockText(sample.gameTime),
			block: `${renderBlockForMode(state, mode)}${focus}`,
			offered: state.unseen,
			roster: [
				state.me.champion,
				...state.allies.map(p => p.champion),
				...state.enemies.map(p => p.champion)
			].filter(c => c !== ""),
			aliases: state.pronounce.map(p => p.say),
			me: state.me.champion,
			frame: hit?.frame ?? null,
			frameB64: hit ? readFileSync(hit.frame.path).toString("base64") : null,
			skewMs: hit?.skewMs ?? null,
			brief: brief?.text ?? "",
			counterpart: brief?.counterpart ?? null,
			raw: sample.data,
			paceInBlock: state.pace !== null,
			sampleLine: sample.line,
			why: sched?.why ?? null,
			readMinimap: sched?.readMinimap ?? true,
			kinds: sched?.kinds ?? []
		}
	})

	/*
	 * The corpus having a baseline and the BLOCK having one are two different facts, and the
	 * warning has to be about the second. `baselineGames === 0` above is the corpus case and stays;
	 * this is the case that actually fires on every window on disk.
	 */
	const turnsWithPace = turns.filter(t => t.paceInBlock).length
	if (turns.length > 0 && turnsWithPace < turns.length)
		warnings.push(
			`${turns.length - turnsWithPace} of ${turns.length} turns render "Farm baseline: NONE" — ` +
				`the corpus has ${baselineGames} earlier game(s), but \`paceReading\` returns null before ` +
				"4:00 outside a 10/14/20-minute checkpoint window, so the block carried no average to " +
				"compare his farm against. The two farm-versus-his-own-average rules CANNOT FIRE on " +
				"those turns, and no report from this stream may say that axis was exercised."
		)

	return {
		window,
		schedule,
		scheduled,
		stride: Math.max(1, opts.stride ?? 1),
		mode,
		baselineGames,
		turns,
		states,
		stateAtSec,
		stepped,
		skipped,
		focusSection: focus,
		turnsWithPace,
		warnings,
		baseline,
		samples: built.map(b => ({
			raw: b.sample.data,
			gameTimeSec: b.sample.gameTime,
			line: b.sample.line
		}))
	}
}
