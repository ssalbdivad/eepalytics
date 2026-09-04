/**
 * Attaching a journal session to the game it recorded.
 *
 * A frame is written while the game is in progress; the `gameId` the rest of the app keys on
 * arrives afterwards, from match history. Most of the time the League client tells us the id
 * mid-game and the session is claimed at birth — that is the fast path, and it is why this file is
 * short. This covers the rest: the client was unreachable, or the bridge was down, or the daemon
 * restarted mid-game.
 *
 * ## It is allowed to say "I don't know"
 *
 * The matcher claims only when exactly one game fits. Zero candidates or several leaves the
 * session `unclaimed` and visible, because attaching one game's frames to another game's coaching
 * would be fabrication with pictures — a review illustrated with screenshots of a different match
 * is worse than one with no screenshots at all.
 */

import { makeLogger } from "./log.ts"
import { claimJournalSession, getGame, unclaimedJournalSessions } from "../db/queries.ts"

const log = makeLogger("claim")

/**
 * How far a session's estimated start may sit from the game's creation and still be the same game.
 *
 * `estimatedStartMs` is `firstFrameWallMs − firstFrameGameTimeSec×1000`, and `gameCreation`
 * precedes the game clock's zero by a loading screen of variable length. Ten minutes is loose
 * enough to absorb that and a slow harvest, and tight enough that two games in one session cannot
 * both match — they are at least fifteen minutes apart.
 */
export const CLAIM_WINDOW_MS = 10 * 60 * 1000

export interface ClaimResult {
	claimed: number
	ambiguous: number
	unmatched: number
}

/**
 * Try to attach any unclaimed session to `gameId`, called once a game has been ingested.
 *
 * Pure decision, impure edges: the candidate test is a comparison of stored numbers, so a wrong
 * claim is a logic bug rather than a timing accident.
 */
export const claimSessionsForGame = (gameId: number): ClaimResult => {
	const game = getGame(gameId)
	const result: ClaimResult = { claimed: 0, ambiguous: 0, unmatched: 0 }
	if (!game) return result

	const sessions = unclaimedJournalSessions()
	if (sessions.length === 0) return result

	const candidates = sessions.filter(s => {
		// A session with no frames recorded nothing worth attaching.
		if (s.frameCount === 0) return false
		// Same champion is the cheapest strong discriminator: two games in a row on different
		// champions can never be confused, and he plays one champion most of the time so this
		// rarely decides anything alone.
		if (s.championName && game.championName && s.championName !== game.championName) return false
		if (s.estimatedStartMs === null) return false
		return Math.abs(s.estimatedStartMs - game.gameCreationMs) <= CLAIM_WINDOW_MS
	})

	if (candidates.length === 1) {
		claimJournalSession(candidates[0]!.id, gameId, "matched")
		result.claimed = 1
		log.info(`claimed session ${candidates[0]!.id} for game ${gameId} (${candidates[0]!.frameCount} frames)`)
		return result
	}

	if (candidates.length > 1) {
		/*
		 * Deliberately claims nothing. Two sessions inside ten minutes of the same game means the
		 * evidence cannot distinguish them, and guessing here would illustrate coaching with the
		 * wrong game's screenshots — the one failure this whole design exists to avoid.
		 */
		result.ambiguous = candidates.length
		log.warn(
			`${candidates.length} journal sessions could be game ${gameId} — leaving them unclaimed rather than guessing`
		)
		return result
	}

	result.unmatched = sessions.length
	return result
}
