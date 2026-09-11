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
 * The corpus is also smaller than it looks. Of 1876 frames, only ~90 have a raw sample within 3s of
 * them at all: the sampler started recording after most journal frames had already been written,
 * and the long frame runs that cover whole games have no raw data beside them. Everything this
 * module can honestly produce is therefore the first 0-7 minutes of two games. THERE IS NO PAIRED
 * LATE-GAME DATA ANYWHERE. Any caller that wants to say something about objective setup, the enemy
 * jungler's completed items, or gold held has to say out loud that it is working from stored
 * `truthJson` blocks that cannot be re-rendered, because the raw client JSON that produced them was
 * never kept.
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
 *   - `readVerbatim`, `baselineDuring`  `scripts/e2e-real-game.ts` — the ndjson reader that keeps
 *                               1-based line numbers (the sampler's own `readSamples` drops torn
 *                               lines silently and returns none), and the rolling farm baseline
 *                               restricted to games created strictly BEFORE this one, so the
 *                               block's `Farm baseline:` line is the number that existed at the
 *                               time rather than one the future set.
 *   - `coachStateFrom`          `scripts/eval-useful.ts` — a SECOND, independent view of the same
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
import { baselineDuring, readVerbatim } from "../e2e-real-game.ts"
import type { RawSample } from "../e2e-real-game.ts"
import { coachStateFrom } from "../eval-useful.ts"
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
	/** Only frames that paired within `maxSkewMs`, sorted by tSec. */
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
		const fired = observeTick(watch, tick)
		watch.pending.push(...fired)
		const reason = dueTurn(watch, tick.gameTimeSec, { heartbeatSec: opts.heartbeatSec })
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
	const games = (
		db
			.prepare("SELECT gameId, gameCreationMs, gameDurationSec, championName FROM game")
			.all() as unknown as {
			gameId: number | bigint
			gameCreationMs: number | bigint
			gameDurationSec: number | bigint
			championName: string | null
		}[]
	).map(g => ({
		gameId: String(g.gameId),
		gameCreationMs: Number(g.gameCreationMs),
		gameDurationSec: Number(g.gameDurationSec),
		championName: g.championName ?? ""
	}))
	db.close()

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
	interface Segment {
		file: string
		game: GameRow
		samples: RawSample[]
	}
	const segments: Segment[] = []
	const dir = join(DATA_DIR, "live-samples")
	const files = existsSync(dir) ?
		readdirSync(dir)
			.filter(f => f.endsWith(".ndjson"))
			.sort()
	:	[]
	for (const file of files) {
		const path = join(dir, file)
		const rows = readVerbatim(path)
		if (rows.length === 0) continue
		const cut = segment(
			rows,
			r => r.atMs,
			r => r.gameTime
		)
		const resolved = cut.map(samples => ({
			samples,
			game: resolveGame(median(samples.map(s => s.atMs - s.gameTime * 1000)), games)
		}))
		/*
		 * A file that holds more than one GAME is SUPERSEDED, not used.
		 *
		 * `js-mtn2jrku-8ae9.ndjson` is four games and `split-01..04.ndjson` are those same four, one
		 * per file, byte for byte. Benchmarking both would double-count the one window that matters,
		 * and a window has to be one game before `buildFacts` can be stepped through it from that
		 * game's t=0.
		 */
		const ids = new Set(resolved.map(r => r.game?.gameId ?? "unmatched"))
		if (ids.size > 1) continue
		/*
		 * ONE GAME CUT IN TWO IS STILL ONE GAME, and the cut rules exist to separate games.
		 *
		 * `js-mtoryjv8-690a-t29810607.ndjson` — the Gwen game, and one of only two real paired
		 * windows in the whole corpus — is a single line at gameTime 0 and then 369 lines from
		 * gameTime 5, with 80 SECONDS of wall clock between them: the loading screen, where the
		 * client answers with a clock that is not moving. The wall-gap rule cuts there, correctly,
		 * and both halves resolve to game 5635921368. Suppressing the file on the SEGMENT count
		 * rather than the GAME count deleted that entire arm, and a comparison run on the one
		 * remaining game is a result about one game. Same-game segments are rejoined in order, so
		 * the ranker is stepped from the game's own t=0.
		 */
		const game = resolved[0]?.game
		if (!game) continue
		segments.push({ file: path, game, samples: resolved.flatMap(r => r.samples) })
	}

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
 * How many streams this PROCESS has built, for the one warning that cannot be fixed from here.
 *
 * `routes/live.ts` keeps `factMemory`, `fightMemory` and `adviceCursor` at module scope, and the
 * only code that resets any of them is the between-games branch of `buildLiveState` — which
 * `buildLiveStateForBench` returns before ever reaching, because it bails on a null `data`/`me`
 * one call earlier. `buildFacts` saves itself: it resets on a clock that runs backwards, which a
 * second window at t=0 always does. The other two do not.
 *
 *   - `fights.ts` keys its announce-once set on `fight@<gameClockSecond>`, so a fight at 6:12 of
 *     window two is silently suppressed because a fight at 6:12 of window one was announced.
 *   - `adviceCursor` counts FIRINGS per fact kind to rotate the champion clauses, so window two
 *     continues window one's rotation and renders a different clause than the live coach — which
 *     starts every game at the top — would have shown.
 *
 * Node cannot purge an ESM module, and this function is synchronous by contract, so neither can be
 * repaired here. It is stated instead: build one window per process when the fight lines or the
 * champion clauses matter.
 */
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
	if (streamsBuiltInThisProcess > 1)
		warnings.push(
			"This is not the first stream built in this process. `fights.ts` keeps its announce-once " +
				"set (`fight@<gameClockSecond>`) in module scope, and `adviceCursor` keeps each fact " +
				"kind's champion-clause rotation index there too; nothing outside `routes/live.ts` can " +
				"reset either, so a fight line at a second already announced in an earlier window will " +
				"be missing here and the champion clauses continue the earlier window's rotation " +
				"instead of starting over. `buildFacts` resets itself on the backwards clock; fights " +
				"and the advice cursor do not. Build one window per process when either matters."
		)

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
	const seg = readVerbatim(window.sampleFile)
	if (seg.length === 0) throw new Error(`${window.sampleFile} holds no readable samples`)
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
