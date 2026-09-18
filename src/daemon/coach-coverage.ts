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
 * plumbing, taken once per game, at the moment the client leaves `InProgress`.
 *
 * NODE ONLY — reads the transcript file and the journal tables.
 */

import { countJournalFrames, journalSessionsBetween } from "../db/queries.ts"
import { readTranscript, TRANSCRIPT_MAX_LIMIT } from "../review/gemini-live.ts"

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

export interface CoachCoverage {
	gameId: number | null
	startedMs: number
	endedMs: number
	frames: number
	lines: number
	verdict: CoverageVerdict
	note: string
}

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
