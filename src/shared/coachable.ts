/**
 * Which games are worth coaching at all.
 *
 * ## Why this needs to exist
 *
 * A Practice Tool game sat in the queue deferring every thirty seconds, forever: `match-ingest`
 * writes a stub row so a replay download can start, then waits for the full match — and for
 * PRACTICETOOL the LCU never returns one. Measured previously at 103 deferrals in 52 minutes for
 * a single game. Downstream, `analysis-run` waits on the match blob and `review-game` waits on
 * analysis, so one unreviewable game produces three permanently stuck jobs and a queue that
 * always looks busy.
 *
 * Beyond the plumbing, coaching a Practice Tool session is meaningless: there is no opponent, no
 * objective pressure and no consequence, so every metric it produces would also pollute the
 * rolling baseline that every real review is judged against.
 *
 * ## What counts
 *
 * `gameMode` is the reliable signal — PRACTICETOOL and TUTORIAL are never real games. Custom
 * games are excluded too: they can be five-stacks or one-versus-one warmups, and the app cannot
 * tell which, so it declines rather than guessing.
 *
 * Browser-safe: no I/O, so both the daemon and the UI can ask the same question and agree.
 */

/** Modes that are never a real game, whatever the queue says. */
const UNCOACHABLE_MODES = new Set(["PRACTICETOOL", "TUTORIAL", "TUTORIAL_MODULE_1", "TUTORIAL_MODULE_2", "TUTORIAL_MODULE_3"])

/** `CUSTOM_GAME` covers practice tool, 1v1 warmups and full custom lobbies alike. */
const UNCOACHABLE_TYPES = new Set(["CUSTOM_GAME", "TUTORIAL_GAME"])

/** Riot's Practice Tool queue. Kept alongside the mode check as a belt-and-braces. */
const UNCOACHABLE_QUEUES = new Set([0, 3140])

export interface CoachableInput {
	gameMode?: string | null
	gameType?: string | null
	queueId?: number | null
	gameDurationSec?: number | null
}

/**
 * `null` when the game should be coached; otherwise the reason it should not, phrased for the UI.
 */
export const uncoachableReason = (g: CoachableInput): string | null => {
	const mode = (g.gameMode ?? "").toUpperCase()
	const type = (g.gameType ?? "").toUpperCase()

	if (UNCOACHABLE_MODES.has(mode)) return "Practice Tool and tutorial games aren't coached"
	if (UNCOACHABLE_TYPES.has(type)) return "Custom games aren't coached"
	if (g.queueId !== null && g.queueId !== undefined && UNCOACHABLE_QUEUES.has(g.queueId))
		return "Practice Tool games aren't coached"

	/*
	 * A remake. Riot writes no end-of-game stat block for a game ended this early, so there is
	 * nothing to analyse — and the few minutes that did happen say nothing about how he plays.
	 */
	if (
		g.gameDurationSec !== null &&
		g.gameDurationSec !== undefined &&
		g.gameDurationSec > 0 &&
		g.gameDurationSec < 5 * 60
	)
		return "Too short to coach — remakes have no meaningful stats"

	return null
}

export const isCoachable = (g: CoachableInput): boolean => uncoachableReason(g) === null
