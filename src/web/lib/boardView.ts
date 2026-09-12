/**
 * Every decision the board makes about a number, in one testable place.
 *
 * `components/LiveBoard.tsx` is layout: it fetches one payload and arranges the strings this file
 * returns. Everything that could be WRONG rather than merely ugly lives here — which reading counts
 * as a position, which counts as a memory, which counts as nothing at all, and when a travel time
 * may be quoted. Those rules are the whole honesty claim of that surface, and a rule inside a JSX
 * ternary cannot be pinned by a test.
 *
 * The thresholds are never constants here. They arrive in the payload from the daemon, which is the
 * one place they are measured; a copy in the browser is a copy that drifts, and this particular
 * drift shows up as a stale position drawn as a live one.
 */

/** One objective instance, exactly as `GET /api/live/board` hands it over. */
export interface BoardObjective {
	label: string
	/** Seconds until it spawns. Negative means it is standing right now. */
	windowSec: number
	/** Where the walk starts, or null when nothing says where he is. */
	origin: "minimap" | "fountain" | null
	ageSec: number | null
	/** False when the read is old enough that the drift circle swallows the pit. */
	constrained: boolean
	etaMinSec: number | null
	etaMaxSec: number | null
	marginMinSec: number | null
	marginMaxSec: number | null
}

/** The last accepted minimap read, with its real age however old that is. */
export interface BoardRead {
	coarse: string
	label: string
	ageSec: number
	confidence: "low" | "medium" | "high"
	positioned: boolean
}

/** `1:05` / `45s`. Seconds under a minute stay seconds — a jungler thinks in them. */
export const clock = (sec: number): string => {
	const s = Math.max(0, Math.round(sec))
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** An age, coarsened as it grows. Nothing on this board is a stopwatch. */
export const age = (sec: number): string => {
	const s = Math.max(0, Math.round(sec))
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 >= 30 ? "+" : ""}`
}

/**
 * A CS figure, said the only way it is true.
 *
 * The client reports every `creepScore` floored to a multiple of ten, so a figure of 40 is a HUD
 * that reads anything from 40 to 49 — and he is looking at the HUD. Printing a bare 40 beside his
 * own screen reading 46 is the fastest way to lose the benefit of the doubt on the numbers that
 * ARE exact, which on this board is most of them.
 */
export const csFloor = (cs: number | null | undefined): string =>
	cs === null || cs === undefined ? "—" : `${cs}+`

/**
 * What the board may say about where he is, from the read's age alone.
 *
 * Both boundaries are the daemon's own measurements, passed in rather than known here. Ten seconds
 * is where a read is still a statement about the PRESENT (92.3% same-half over 454 pairs). Thirty
 * is the measured cliff past which the half is a coin flip and the read stops being a position at
 * all — past it the board says `unknown` and keeps the age beside it, because "nothing has been
 * read for two minutes" is how he notices the watcher has died.
 *
 * A `low`-confidence read is `unknown` at any age. That is two consecutive looks disagreeing about
 * his half — the measured 7% — and the rest of the app treats it as no read rather than a weak one.
 */
export type Freshness = "now" | "was" | "unknown"

export const freshnessOf = (
	read: BoardRead | null | undefined,
	freshSec: number,
	carrySec: number
): Freshness =>
	!read || read.confidence === "low" ? "unknown"
	: read.ageSec <= freshSec ? "now"
	: read.ageSec <= carrySec ? "was"
	: "unknown"

/**
 * The travel clause for one objective, or the reason there isn't one.
 *
 * ## What the numbers actually are
 *
 * `buildReach` measures a STRAIGHT LINE from the accepted read to the pit and divides by his
 * instantaneous move speed, so both ends of the interval are FLOORS — the real path bends around
 * terrain and the real walk is at least this long. The board says "away" and puts the rest on the
 * row's tooltip rather than pretending to a precision the map does not allow.
 *
 * That asymmetry decides the verdicts, and they are deliberately not symmetrical:
 *
 *   - "won't make it" is PROVEN. It fires when the spawn beats even the fastest arrival the read
 *     allows, and terrain can only make that worse.
 *   - "reachable" is NOT a promise, which is why it does not say "you make it". It means nothing in
 *     this arithmetic says he is late; a wall, a wave or a ward can still.
 *
 * ## Four ways to have no number, each printing as itself rather than as a blank
 *
 *   - no origin at all — nothing has been accepted this game, so there is nowhere to walk from;
 *   - no usable move speed, which is the loading screen or a torn payload;
 *   - the drift circle has grown past the pit (`constrained` false): everywhere he could have
 *     reached since the read INCLUDES the pit, so the honest reading is that he may be standing in
 *     it already, not a number;
 *   - a window that has already opened, where the walk is still true and "will you make it" has
 *     stopped being a question.
 */
export const reachText = (o: BoardObjective, elapsedSec: number): string => {
	if (o.etaMinSec === null || o.etaMaxSec === null)
		return o.origin === null ? "no position" : "no travel time"
	const from = o.origin === "fountain" ? " from base" : ""
	if (!o.constrained) return "could already be there"
	const min = Math.max(0, Math.round(o.etaMinSec))
	const max = Math.max(min, Math.round(o.etaMaxSec))
	const walk =
		min === max ? clock(min)
		: max < 60 ? `${min}–${max}s`
		: `${clock(min)}–${clock(max)}`
	if (o.windowSec - elapsedSec <= 0) return `${walk} away${from}`
	if (o.marginMaxSec !== null && o.marginMaxSec < 0) return `${walk} away${from} · won't make it`
	if (o.marginMinSec !== null && o.marginMinSec > 0) return `${walk} away${from} · reachable`
	return `${walk} away${from} · tight`
}
