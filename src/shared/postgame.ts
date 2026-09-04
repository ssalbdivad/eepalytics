/**
 * Whether there is a debrief to show, and how far the pipeline has got with it.
 *
 * ## The problem this solves
 *
 * The daemon knows a game ended — the gameflow phase left `InProgress` and `supervisor.ts`
 * fires `onGameEnded`. The coach window does not: it polls `/api/live`, which only ever said
 * "not in a game", so the moment a game finished the screen went blank and stayed blank.
 *
 * The daemon therefore writes down WHICH game ended and WHEN (`src/daemon/postgame.ts`), and
 * `/api/live` reports it back as `justEnded`. Nothing new to subscribe to, nothing to keep in
 * the page's memory, and it is correct in a browser tab opened thirty seconds later — which is
 * the actual case, because he alt-tabs out of the client into a fresh window.
 *
 * ## Why this file is pure
 *
 * The decision has four inputs (a marker, a dismissal, the stored row, the clock) and one
 * output, and every branch is a product judgement worth testing: a Practice Tool game must
 * produce NO debrief, a dismissed one must stay dismissed across a reload, and a match the
 * client never handed over must not leave a spinner up forever. Keeping it here means the test
 * needs no database and no daemon.
 *
 * Browser-safe: no I/O.
 */

import { uncoachableReason } from "./coachable.ts"
import type { CoachableInput } from "./coachable.ts"

/**
 * What the daemon wrote down when the client left the game.
 *
 * `gameId` is null when the gameflow session could not be read on the way in — the phase
 * transition is still reliable, the id is the part that occasionally is not.
 */
export interface GameEndedMarker {
	gameId: number | null
	/** When the client left `InProgress`, epoch ms. Doubles as the dismissal key. */
	endedAtMs: number
}

/** The stored row for the ended game, once ingest has written one. */
export interface EndedGame extends CoachableInput {
	gameId: number
	championName?: string
	win?: boolean
}

export interface PostGameInput {
	marker: GameEndedMarker | null
	/** `endedAtMs` of the debrief the user closed, if any. */
	dismissedEndedAtMs: number | null
	/** The row for the ended game, or null while the client is still assembling the match. */
	game: EndedGame | null
	nowMs: number
}

/**
 * What `/api/live` reports about the game that just finished.
 *
 * `stage` is deliberately coarse. It answers one question — is there a row to fetch? —
 * because every finer state (analysed or not, review written, review failed) is already in
 * `GET /api/games/:id`, and duplicating it here would give the UI two sources that can
 * disagree.
 */
export interface JustEnded {
	gameId: number | null
	endedAtMs: number
	stage: "ingesting" | "stored"
	championName?: string
	win?: boolean
}

/**
 * How long a game may sit un-ingested before the panel gives up on it.
 *
 * This is NOT the debrief timing out — a debrief that exists never expires on a clock. It
 * bounds the state BEFORE one exists, where the client has not handed the match over and
 * there is nothing to show but a spinner. Ten minutes is far past the seconds a real ingest
 * takes; anything still waiting at that point is a game the LCU is never going to return, and
 * the Queue screen is where that gets diagnosed.
 */
export const INGEST_GRACE_MS = 10 * 60_000

/**
 * Marker to panel. `null` means show nothing — which is a real answer, not a failure: no game
 * has ended, the debrief was dismissed, or the game is one this app declines to coach.
 */
export const postGameDebrief = (input: PostGameInput): JustEnded | null => {
	const { marker, dismissedEndedAtMs, game, nowMs } = input
	if (!marker) return null

	/*
	 * Dismissal is keyed on the END TIME, not the id, because the id can still be null while
	 * the panel is on screen. It lives in the daemon rather than in the page, so closing the
	 * debrief survives a reload, a new window, and the app being restarted.
	 */
	if (dismissedEndedAtMs !== null && dismissedEndedAtMs === marker.endedAtMs) return null

	/*
	 * A custom game, the Practice Tool or a remake gets no debrief at all. Not an empty one,
	 * not a "nothing to say here" — the panel simply never appears, exactly as
	 * `src/daemon/jobs/analysis-run.ts` and `review-game.ts` decline to produce anything for
	 * these games. Showing a coaching frame around a game the coach refused to read would be
	 * promising a write-up that is never coming.
	 */
	if (game && uncoachableReason(game) !== null) return null

	if (!game)
		return nowMs - marker.endedAtMs > INGEST_GRACE_MS ?
				null
			:	{ gameId: marker.gameId, endedAtMs: marker.endedAtMs, stage: "ingesting" }

	return {
		gameId: game.gameId,
		endedAtMs: marker.endedAtMs,
		stage: "stored",
		...(game.championName !== undefined && game.championName !== "" ?
			{ championName: game.championName }
		:	{}),
		...(game.win !== undefined ? { win: game.win } : {})
	}
}

/**
 * How close a stored row has to be to the marker to be the game it refers to.
 *
 * Only used when the gameflow session never gave us an id, so the newest row has to be matched
 * by time. A game that just ended lands within seconds of the marker; the one before it is a
 * queue, a champion select and a game away. Five minutes separates those without being generous
 * enough to attach the previous game's debrief to this one.
 */
export const MARKER_MATCH_MS = 5 * 60_000

/** Whether a row that ended at `gameEndedAtMs` is plausibly the game the marker refers to. */
export const matchesMarker = (gameEndedAtMs: number, markerEndedAtMs: number): boolean =>
	Math.abs(gameEndedAtMs - markerEndedAtMs) < MARKER_MATCH_MS
