/**
 * Did the live coach actually run this game, and did he hear anything?
 *
 * ## Why this file exists
 *
 * On 2026-09-18 he reported that the coach had been giving him bad feedback. The first thing any
 * investigation wants is the transcript of what it said in those games, and there was none:
 * `data/logs/live-transcript.jsonl` had not been appended to since 2026-09-10, across five games
 * that day and more before it. Nothing on the machine could distinguish the three explanations,
 * and they want completely different fixes:
 *
 *   - he never opened the page, or never shared his screen, so the coach never ran;
 *   - the page ran and the SOCKET could not be opened — which is exactly what would have happened
 *     after ~14:40 that day, because the Gemini key's prepaid credit was depleted and every call,
 *     socket or HTTPS, answers `429 "Your prepayment credits are depleted"`;
 *   - the page ran, the coach spoke, and the lines failed to reach the disk.
 *
 * The browser already counts its own failed transcript POSTs (`setUnsaved`), but that count lives
 * in a tab he closes. The daemon sees every game whether or not a tab exists, so the daemon is the
 * only place a per-game answer can be written down. This module writes it.
 *
 * It changes NOTHING about what the coach says or when it is asked. It is a measurement of our own
 * plumbing, taken once per game, at the moment the client leaves `InProgress`. Nothing in this file
 * reaches a prompt, so nothing in it can tell the model what to say or when.
 *
 * ## THE INSTRUMENT BUILT SO SILENT FAILURE COULD NOT HAPPEN WAS ITSELF SILENT
 *
 * Until 2026-09-22 this module computed a verdict and `main.ts` logged it, and that was the whole
 * of it. `AGENTS.md` said "writes one line per game"; it wrote nothing, and
 * `data/logs/coach-coverage.jsonl` did not exist on the machine after a week of play. Verified
 * before the fix:
 *
 *     ls -la data/logs/            ->  coach.jsonl, daemon-live.log, electron.log,
 *                                      live-transcript.jsonl, research*.log, vite.log — no coverage
 *     journalctl --user -u eepalytics --since "7 days ago" | grep -o "live coach [a-z-]*" | sort | uniq -c
 *                                  ->  43 "live coach absent", 1 "live coach coached"
 *
 * So the one record that answers "did the coach run in the game he is complaining about" survived
 * only in journald, only until it rotates, and only for someone who thinks to run `journalctl`.
 * Forty-four games of evidence sat one log rotation from gone. `appendCoverage` below writes it to
 * a file, in the same flat-JSONL shape and for the same reason as the transcript beside it: this
 * exists to be read by a person with `grep` and by the next round of plumbing work, and neither
 * wants a migration.
 *
 * NODE ONLY — reads the transcript file, the sample directory and the journal tables.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { LOGS_DIR } from "../shared/constants.ts"
import { countJournalFrames, journalSessionsBetween } from "../db/queries.ts"
import { readTranscript, TRANSCRIPT_MAX_LIMIT } from "../review/gemini-live.ts"
import { SAMPLE_DIR } from "./live-sampler.ts"
import { errText, makeLogger } from "./log.ts"

const log = makeLogger("coverage")

/**
 * What the two counts mean together.
 *
 * Kept as a pure function of two integers so the four cases can be tested without a disk, a game or
 * a socket — and so the wording a human reads is written down once rather than assembled at three
 * call sites. The distinction that matters is the middle one: frames WITHOUT lines is the only
 * outcome that says the product was in front of him and failed anyway.
 */
export type CoverageVerdict = "coached" | "heard-nothing" | "unwatched" | "absent"

export const judgeCoverage = (input: {
	frames: number
	lines: number
}): { verdict: CoverageVerdict; note: string } => {
	const { frames, lines } = input
	if (frames > 0 && lines > 0)
		return { verdict: "coached", note: `${lines} lines over ${frames} frames` }
	if (frames > 0)
		return {
			verdict: "heard-nothing",
			// The one that is OUR fault by construction: the share was up, the frames landed, and
			// the coach said nothing the whole game. A dead socket looks exactly like this.
			note: `${frames} frames and NOT ONE LINE — the share was running and the coach never spoke`
		}
	if (lines > 0)
		return {
			verdict: "unwatched",
			// A turn-based provider with no picture, or a journal rejecting every frame. Neither is
			// fatal — the brief carries the game either way — but it is not the shipped shape.
			note: `${lines} lines with no stored frames`
		}
	return {
		verdict: "absent",
		note: "no frames and no lines — the coach page was not open, not sharing, or could not start"
	}
}

/**
 * Where the window's START came from, which is the difference between a measurement and a guess.
 *
 * `phase` is the daemon watching the client cross INTO `InProgress` — exact to the poll, a couple
 * of seconds. `samples` is a recovery for the case below and is exact to the MINUTE. A record
 * carries which one it was because the two support different readings: a `samples` window can be
 * up to a minute wide at the front, so the handful of ChampSelect frames at the edge of it are not
 * evidence about this game and a reader must not treat a frame count as exact.
 */
export type CoverageStartSource = "phase" | "samples"

export interface CoachCoverage {
	gameId: number | null
	startedMs: number
	endedMs: number
	frames: number
	lines: number
	verdict: CoverageVerdict
	note: string
	/** See `CoverageStartSource`. Absent on rows written before 2026-09-22; those are all `phase`. */
	startSource?: CoverageStartSource
}

/* ------------------------------------------------ recovering the game's start after a restart */

/**
 * A League game, generously. Used only to refuse a recovered start that cannot belong to the game
 * that just ended. The longest game in the benchable corpus is 42:55 (`AGENTS.md`), so 90 minutes
 * is about double the worst real case and is a sanity bound rather than a model of anything.
 */
const MAX_GAME_MS = 90 * 60_000

/**
 * How far apart two sample-file stamps can be and still be the SAME game.
 *
 * `live-sampler.ts` keys its file on `round((now - gameTime * 1000) / 60_000)` — the minute the
 * game clock read zero — and rolls the key whenever that value changes, so one game routinely
 * writes two files a minute apart as the rounding drifts. Measured over every recorder file on
 * this machine:
 *
 *     ls data/live-samples/ | grep -oE '(^g-|-t)[0-9]+\.ndjson$' | grep -oE '[0-9]+' \
 *       | sort -n | uniq | (gap histogram)
 *     -> 94 distinct stamps; the 19 smallest gaps are ALL exactly 1 minute, and the next
 *        smallest gap is 3 minutes.
 *
 * The 3-minute gap is real and is a remake/dodge sequence (2026-09-19 21:36, 21:39, 21:40), so it
 * is the tightest constraint that exists and one minute clears it by two. A wider window would
 * merge a remake into the game after it and report the wrong start; a narrower one would take the
 * later half of a rolled pair and lose a minute off the front.
 */
const SAME_GAME_ROLL_MS = 60_000

/**
 * The stamp a recorder file's name ends in, or null for anything else in that directory.
 *
 * Deliberately the same shape as `isRecorderFile` in `live-sampler.ts` and for the same reason:
 * the measurement work PLACES files here by hand (`split-01..04` were a paired corpus four tests
 * still read by name) and a reader that cannot tell them apart from the recorder's own files will
 * date a game from a fixture.
 */
const sampleStampMs = (name: string): number | null => {
	const m = /(?:^g-|-t)(\d+)\.ndjson$/.exec(name)
	if (!m) return null
	const minutes = Number(m[1])
	return Number.isFinite(minutes) ? minutes * 60_000 : null
}

/**
 * When the game that ended at `endedMs` started, read off the live sampler's own filenames.
 *
 * Pure, so the recorded filenames from a real evening can be a test fixture rather than a disk.
 *
 * ## Why the sampler and not the journal
 *
 * This recovery exists for the case where the daemon did not see the game begin, and the case that
 * matters inside THAT case is the one where he played with the coach page closed — five of his six
 * most recent games. There are then no journal frames, no transcript lines and no journal session:
 * every browser-side record is empty by construction, so none of them can date the game. The
 * SAMPLER runs in the supervisor's own poll and writes whether or not a tab exists — 66 of the 95
 * files in `data/live-samples/` are `g-`keyed, which is the key it uses when there is no journal
 * session at all — and its filename literally encodes the minute the game clock read zero.
 *
 * Checked against the phase log for every game this machine has sample files for (`journalctl
 * --user -u eepalytics` for `gameflow phase ... to=InProgress`, joined to the decoded stamp): the
 * offsets are 18, 8, 36, -19, 16, -5, 12 and 3 seconds, 8 of 8 inside -19..+36s. The positive side
 * is the loading screen — the phase fires when the client says the game started and the game clock
 * reaches zero once everyone has loaded — and the negative side is the rounding, which is bounded
 * at 30s by construction. The positive side is the one that would under-count, and
 * `SAMPLE_STAMP_SLACK_MS` pays it back with 84 seconds to spare. `coach-coverage.test.ts` pins all
 * eight offsets, because the first draft of this paragraph said "8 to 78 seconds, never before"
 * from eyeballing a table and the test is what found the -19.
 *
 * ## And the recovered window measures the same thing the watched one does
 *
 * Replayed over the real journal tables and the real `live-transcript.jsonl` for the seven games
 * on 2026-09-20 and 2026-09-22 that have both a phase log and sample files, each game measured
 * twice — once from the `to=InProgress` wall clock and once from this recovery:
 *
 *     5645995390  phase coached 353f/9l  |  recovered coached 353f/9l  |  start 112s earlier
 *     5646051543  phase absent    0f/0l  |  recovered absent    0f/0l  |  start  84s earlier
 *     5646109709  phase absent    0f/0l  |  recovered absent    0f/0l  |  start 139s earlier
 *     5646163495  phase absent    0f/0l  |  recovered absent    0f/0l  |  start 104s earlier
 *     5647002759  phase absent    0f/0l  |  recovered absent    0f/0l  |  start 125s earlier
 *     5647008005  phase absent    0f/0l  |  recovered absent    0f/0l  |  start 108s earlier
 *     5647036219  phase absent    0f/0l  |  recovered absent    0f/0l  |  start 117s earlier
 *
 * Same verdict and same counts to the frame and the line, 7 of 7, over windows that begin 84 to
 * 139 seconds earlier. The coached row is the one that carries the weight: journald recorded
 * `live coach coached: 9 lines over 353 frames gameId=5645995390` at the time, and both windows
 * reproduce it exactly.
 */
export const gameStartFromSampleNames = (
	names: readonly string[],
	endedMs: number
): number | null => {
	const stamps = names
		.map(sampleStampMs)
		.filter((ms): ms is number => ms !== null && ms <= endedMs && endedMs - ms <= MAX_GAME_MS)
		.sort((a, b) => b - a)
	if (stamps.length === 0) return null
	// Walk back through the rolled twins of the newest stamp and stop at the first real gap.
	let start = stamps[0]!
	for (const ms of stamps) {
		if (start - ms > SAME_GAME_ROLL_MS) break
		start = ms
	}
	return start
}

/**
 * How much earlier than the recovered stamp the window is allowed to begin.
 *
 * The error that matters makes the stamp LATE: the game clock reaches zero only once everyone has
 * loaded, measured at up to +36s after the phase transition over 8 of 8 recorded games, and the
 * minute rounding can add another 30s on top. Two minutes covers both with 84 seconds spare.
 *
 * Widening is the safe direction here and the asymmetry is the whole argument. Too NARROW hides
 * frames and lines that exist, and turns a `coached` game into `absent` — the exact silent lie
 * this module was written to prevent. Too WIDE would reach into the PREVIOUS game and turn an
 * `absent` one into `coached`, which is the same lie facing the other way, so it is fenced rather
 * than argued away: `clampToPreviousGame` below refuses to start a window before the last game we
 * have a record for finished.
 */
const SAMPLE_STAMP_SLACK_MS = 2 * 60_000

/**
 * Never begin a window before the previous game ended.
 *
 * Two minutes of slack is comfortable against the ordinary case — the tightest gap between two
 * games' clock-zeros on this machine is 3 minutes — but that 3 was a remake/dodge sequence
 * (2026-09-19 21:36, 21:39, 21:40) and a remake can END within the slack of the next game's start.
 * The frames of a remake are not evidence about the game after it, and counting them would report
 * a game as `coached` that nobody watched.
 *
 * The bound is the newest STORED record's `endedMs`, which is exact — the daemon wrote it from its
 * own clock when that game left `InProgress`. It is available precisely when it is needed: this
 * recovery only runs after a restart mid-game, and a restart mid-game means the previous game
 * ended before the restart and has a record. When there is no record (nothing has been stored yet,
 * or that game was one of the ones this module declines to guess at) there is nothing to clamp to
 * and the slack stands, which is the pre-existing behaviour rather than a new risk.
 */
export const clampToPreviousGame = (
	start: number,
	endedMs: number,
	previousEndedMs: number | null
): number => {
	if (previousEndedMs === null || previousEndedMs <= start || previousEndedMs >= endedMs)
		return start
	return previousEndedMs
}

/**
 * The same thing, against the real directory. Never throws: a coverage record is a nicety and an
 * unreadable directory must not be able to interrupt the end of a game.
 */
export const recoverGameStartMs = (endedMs: number): number | null => {
	try {
		const start = gameStartFromSampleNames(readdirSync(SAMPLE_DIR), endedMs)
		if (start === null) return null
		return clampToPreviousGame(
			start - SAMPLE_STAMP_SLACK_MS,
			endedMs,
			readCoverage(1)[0]?.endedMs ?? null
		)
	} catch {
		// The directory not existing before the first sample is the normal state, not a fault.
		return null
	}
}

/* ------------------------------------------------------------------- measuring, and writing it */

/**
 * Count what the coach left behind for one game's wall-clock window.
 *
 * The window is wall clock rather than game clock on purpose: a game that produced nothing has no
 * game clock to search by, and "nothing" is the case this whole file was written for.
 *
 * Both counts are cheap. Frames are a `COUNT(*)` per session, and sessions are a handful of rows;
 * the transcript is a few hundred KB of JSONL after months of play and is read whole exactly once
 * per game. Neither is on any path a coaching turn waits for.
 */
export const measureCoverage = (input: {
	gameId: number | null
	startedMs: number
	endedMs: number
	startSource?: CoverageStartSource
}): CoachCoverage => {
	const sessions = journalSessionsBetween(input.startedMs, input.endedMs)
	const frames = sessions.reduce((n, s) => n + countJournalFrames(s.id), 0)
	/*
	 * A line counts for this game if it was WRITTEN inside the window. `gameTimeSec` would be the
	 * better key and it is null on every one of the stored rows, so it cannot be used to answer a
	 * question about the past — and the past is what this measurement is for.
	 */
	const lines = readTranscript(TRANSCRIPT_MAX_LIMIT).filter(
		l => l.atMs >= input.startedMs && l.atMs <= input.endedMs
	).length
	return { ...input, frames, lines, ...judgeCoverage({ frames, lines }) }
}

/**
 * One JSON object per game, appended.
 *
 * A flat file rather than a table, for the same reasons `live-transcript.jsonl` is one: it is read
 * by a person with `grep` and by whoever next asks "when did this stop working", and neither wants
 * a migration. It also means the record outlives the database, which matters because the question
 * it answers is usually asked after something has gone wrong.
 */
export const COVERAGE_PATH = `${LOGS_DIR}/coach-coverage.jsonl`

/**
 * Whether the record reached the disk.
 *
 * Reported rather than swallowed, and never thrown: this runs at the end of a game, beside the
 * replay download that has thirty minutes to live, and a full disk must not be able to take that
 * with it. A silent write failure here would be the same defect as the one this file exists to
 * fix, one level down.
 */
export const appendCoverage = (row: CoachCoverage): boolean => {
	try {
		mkdirSync(LOGS_DIR, { recursive: true })
		appendFileSync(COVERAGE_PATH, `${JSON.stringify(row)}\n`)
		return true
	} catch (err) {
		log.warn(`coverage append failed: ${errText(err)}`)
		return false
	}
}

/**
 * Parse a coverage log, NEWEST FIRST.
 *
 * Split from the file read so the ordering, the limit, the de-duplication and a torn last line can
 * be tested without a disk — the same split `parseTranscript` makes, for the same reason.
 *
 * De-duplicated by `gameId`, newest kept. `onGameEnded` fires on every departure from `InProgress`
 * and the phase log shows that is not always once per game: on 2026-09-19 a single game left to
 * `None`, came back through `ChampSelect`, and left again. A game appearing twice in a history is
 * a game counted twice in "your last N", so the dedupe belongs here rather than at the write, where
 * refusing to append would throw away the second, better-informed measurement. Rows with no gameId
 * are never merged — the client did not tell us what they were, so nothing says they are the same.
 */
export const parseCoverageLog = (text: string, limit = 50): CoachCoverage[] => {
	const capped = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 50
	const out: CoachCoverage[] = []
	const seen = new Set<number>()
	const lines = text.split("\n")
	for (let i = lines.length - 1; i >= 0 && out.length < capped; i--) {
		const raw = lines[i]!.trim()
		if (raw === "") continue
		try {
			const parsed = JSON.parse(raw) as CoachCoverage
			// A line that parses but is not a record would render as an empty row.
			if (typeof parsed?.verdict !== "string" || typeof parsed?.endedMs !== "number") continue
			if (typeof parsed.gameId === "number") {
				if (seen.has(parsed.gameId)) continue
				seen.add(parsed.gameId)
			}
			out.push(parsed)
		} catch {
			/* a torn final line during a crash is not worth failing the read for */
		}
	}
	return out
}

/** Newest first. Reads the whole file: one short line per game is a few KB a year. */
export const readCoverage = (limit = 50): CoachCoverage[] => {
	try {
		return parseCoverageLog(readFileSync(COVERAGE_PATH, "utf8"), limit)
	} catch {
		// The file not existing yet is the normal state before the first game, not a fault.
		return []
	}
}

/* --------------------------------------------------------------- saying it where he would see it */

export interface CoverageSummary {
	/** How many games this reading is over. Zero means there is nothing to say, not "no coach". */
	games: number
	/** Games where the coach said at least one line — `coached` or `unwatched`. */
	spoke: number
	/** Games where frames arrived and no line did — the subset that is OURS by construction. */
	heardNothing: number
	/** Consecutive most-recent games that produced no coaching line at all. */
	quietStreak: number
	/** One plain sentence, or null when the history cannot support one. */
	sentence: string | null
}

/**
 * Turn a history into the one sentence he should see on a page he already opens.
 *
 * ## Why this is a sentence and not a notification
 *
 * Five of his six most recent games were `absent` — he played with the page closed — and today that
 * is a WARN line in a journal he never reads. The fix that suggests itself is to tell him at the
 * time, and that fix is DELETED FROM THIS REPO ALREADY: `src/capture/` was the one intrusive job
 * kind, it was gated on the user being idle, and "wait until the user is idle" resolves to "fire
 * the moment he sits down to play". It produced 0 done jobs in the app's whole history. Nothing
 * here may pop a window, steal focus, spawn the client or interrupt a game. A number on a page he
 * already opens is the shape that is allowed, so this returns a string and a caller renders it.
 *
 * Pure, so the wording is testable and lives in one place — the same argument as `judgeCoverage`'s
 * `note`. It states our plumbing's own history and nothing else: it never reaches a prompt, and it
 * makes no claim about the game he played.
 *
 * The streak counts games that produced NO LINE, which merges `absent` (not ours) with
 * `heard-nothing` (ours by construction) — because from where he sits they are the same
 * experience, silence. The sentence then splits them again, because they want different fixes, and
 * `heardNothing` is carried separately so a caller can lead with the one that is our bug.
 */
export const describeCoverage = (rows: readonly CoachCoverage[]): CoverageSummary => {
	const games = rows.length
	const spoke = rows.filter(r => r.verdict === "coached" || r.verdict === "unwatched").length
	const heardNothing = rows.filter(r => r.verdict === "heard-nothing").length
	let quietStreak = 0
	for (const r of rows) {
		if (r.verdict === "coached" || r.verdict === "unwatched") break
		quietStreak++
	}
	if (games === 0) return { games, spoke, heardNothing, quietStreak, sentence: null }
	if (quietStreak === 0)
		return {
			games,
			spoke,
			heardNothing,
			quietStreak,
			sentence: `The coach ran in your last game, and in ${spoke} of your last ${games}.`
		}
	const streakRows = rows.slice(0, quietStreak)
	const ours = streakRows.filter(r => r.verdict === "heard-nothing").length
	const noun = quietStreak === 1 ? "game" : "games"
	if (ours === quietStreak)
		// Every one of them had the share running. This is not him; it is us, and it says so.
		return {
			games,
			spoke,
			heardNothing,
			quietStreak,
			sentence: `Your screen reached the coach in your last ${quietStreak} ${noun} and it said nothing — that is a fault on our side, not a setting of yours.`
		}
	if (ours > 0)
		return {
			games,
			spoke,
			heardNothing,
			quietStreak,
			sentence: `The coach did not speak in your last ${quietStreak} ${noun}. In ${ours} of them your screen was reaching it and it stayed silent anyway.`
		}
	return {
		games,
		spoke,
		heardNothing,
		quietStreak,
		sentence: `The coach did not run in your last ${quietStreak} ${noun} — the page was not open or not sharing your screen.`
	}
}
