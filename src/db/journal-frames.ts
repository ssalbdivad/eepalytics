/**
 * ONE QUERY: every journal frame of a game's session, IN THE ORDER THEY WERE TAKEN.
 *
 * ## Why this is not in `queries.ts`, and why it should be
 *
 * `queries.ts` says SQL lives there and nowhere else, and that rule is right. This file exists
 * because `framesForGame` returns `ORDER BY f.tSec` and does not select `atMs`, and BOTH of those
 * are fatal to attributing a picture to a game:
 *
 *   * a session that recorded two games holds two runs of the game clock, and sorting by the game
 *     clock INTERLEAVES them into one plausible-looking ascending run — the two games become
 *     indistinguishable by construction, before any consumer gets a look;
 *   * wall-clock order is the only thing that separates them, and `atMs` is the only column that
 *     carries it.
 *
 * Measured on this install's four screen-shared sessions: sorted by `tSec`, ZERO of 715 frames in
 * `js-mtvxb5f4-f81a` step backwards. Sorted by `atMs`, exactly one does — at frame 340, from
 * 1695.8s to 2.3s — and that one step is the boundary between game 5639406342 and game 5639409343.
 * The "no frame steps backwards, so the session cannot span two games" reading came from the first
 * ordering and is an artefact of it.
 *
 * FOLD THIS BACK. The moment `queries.ts` is free, `framesForGame` should select `atMs` and order
 * by it, every caller should take the extra field, and this file should be deleted. It is a
 * temporary home for one statement, not a second place for SQL to live.
 *
 * NODE-ONLY.
 */

import { getDb } from "./index.ts"

/** A journal frame with both clocks: the game's, and the wall's. */
export interface JournalFrameRow {
	id: string
	path: string
	/** Game clock at the shutter, from a live-client read. Restarts at zero every game. */
	tSec: number
	/** Wall clock at the shutter. The only field that orders two games in one session. */
	atMs: number
	/** The ground-truth block the live coach was holding when the shutter fired, if any. */
	truthJson: string | null
}

/**
 * Every frame recorded under this game's session, OLDEST FIRST BY WALL CLOCK.
 *
 * Joined through the session because that is where the gameId lives. The rows this returns are
 * still only *candidates* — a session can hold several games and they all come back under the
 * first one's id. `framesForThisGame` in `src/review/pack.ts` does the attribution.
 */
export const journalFramesForGame = (gameId: number): JournalFrameRow[] =>
	getDb()
		.prepare(
			`SELECT f.id AS id, f.path AS path, f.tSec AS tSec, f.atMs AS atMs, f.truthJson AS truthJson
			   FROM journal_frame f
			   JOIN journal_session s ON s.id = f.sessionId
			  WHERE s.gameId = ?
			  ORDER BY f.atMs ASC`
		)
		.all(gameId) as unknown as JournalFrameRow[]
