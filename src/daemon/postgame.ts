/**
 * "A game just ended, and it was that one."
 *
 * The supervisor sees the gameflow phase leave `InProgress` and fires `onGameEnded`. That is
 * the only place in the app that knows a game finished the moment it finished — but it is a
 * callback in a long-lived process, and the thing that needs to know is a browser window that
 * may not be open yet.
 *
 * So it is written down. One `kv` row, which means it survives a daemon restart, a page
 * reload, and the user alt-tabbing into a window that has never seen this session. `/api/live`
 * reads it back on the poll the overlay is already making — see `src/shared/postgame.ts` for
 * the decision it feeds.
 *
 * Dismissal lives here too, for the same reason: a debrief closed in one window must stay
 * closed in the next one. Keyed on the end time rather than the gameId, because the id can
 * still be unknown while the panel is on screen.
 *
 * NODE ONLY.
 */

import { kvDelete, kvGet, kvSet } from "../db/queries.ts"
import type { GameEndedMarker } from "../shared/postgame.ts"
import { publish } from "./bus.ts"

const KV_ENDED = "lastGameEnded"
const KV_DISMISSED = "debriefDismissedEndedAtMs"

const isMarker = (v: unknown): v is GameEndedMarker => {
	if (typeof v !== "object" || v === null) return false
	const m = v as Record<string, unknown>
	return (
		typeof m.endedAtMs === "number" &&
		Number.isFinite(m.endedAtMs) &&
		(m.gameId === null || (typeof m.gameId === "number" && Number.isFinite(m.gameId)))
	)
}

/**
 * Record the game that just ended. Called from the phase transition, so it must not throw:
 * failing to write this must never take the supervisor down with it.
 */
export const noteGameEnded = (gameId: number | null): void => {
	const marker: GameEndedMarker = {
		gameId: typeof gameId === "number" && Number.isFinite(gameId) && gameId > 0 ? gameId : null,
		endedAtMs: Date.now()
	}
	try {
		kvSet(KV_ENDED, marker)
		// A NEW game supersedes any earlier dismissal — otherwise closing one debrief would
		// silently suppress the next one, which is the same bug as a state machine that never
		// resets.
		kvDelete(KV_DISMISSED)
		publish("daemon", { gameEnded: true, gameId: marker.gameId }, marker.gameId)
	} catch {
		/* the marker is a convenience; the reconcile that follows is what actually matters */
	}
}

export const lastGameEnded = (): GameEndedMarker | null => {
	const raw = kvGet<unknown>(KV_ENDED, null)
	return isMarker(raw) ? raw : null
}

/** The end time of the debrief the user closed, or null if none was. */
export const dismissedDebrief = (): number | null => {
	const raw = kvGet<unknown>(KV_DISMISSED, null)
	return typeof raw === "number" && Number.isFinite(raw) ? raw : null
}

/** Close the debrief for the game that ended at `endedAtMs`, permanently. */
export const dismissDebrief = (endedAtMs: number): void => {
	kvSet(KV_DISMISSED, endedAtMs)
}
