/**
 * How OFTEN the live coach is allowed to open her mouth — decided here, in TypeScript, on a clock.
 *
 * ## Why this file exists at all
 *
 * `analysis/live-facts.ts` already owns a floor (`MIN_GAP_SEC`, `ROUTINE_GAP_SEC`) and that floor
 * works. It gates the RANKED LIST. Under the fenced architecture the list was also the coach's
 * vocabulary, so gating the list gated the speech and one rule did both jobs.
 *
 * `shared/live-coach-mode.ts` demoted the list to a hint. That is measured and it is worth 13.5x
 * the useful output — and it silently removed every rate limit this coach had, because the model no
 * longer needs the list's permission to say something. Replayed over game 5635467422, the shipped
 * cite-or-quiet coach spoke on 94 of 102 turns: at the shipped twenty-second turn that is 2.8 lines
 * a minute, about 11 in any four-minute window. He switched the coach off at NINE lines in four
 * minutes. So the new architecture, unpaced, is chattier than the thing he quit over.
 *
 * The volume gain is the whole point of the change and must not be given back through the prompt —
 * "only speak when it matters" is not a knob, it cannot be measured, and it re-creates the gag the
 * ablation just paid to remove. The cadence therefore belongs on the client, on a clock, where it
 * is one number and can be swept.
 *
 * ## The measurement, on the one game there is a full transcript of
 *
 * `scripts/ablate-autonomy.ts --pace-sweep` replays the recorded run of game 5635467422 (Lillia,
 * 36:49, a win) onto the shipped twenty-second turn grid and applies each candidate floor to what
 * the coach actually said, in order. Every figure below is from that sweep:
 *
 *     floor   lines  per min   busiest 4 min   median gap
 *     none      MEASURED_NONE
 *
 * ## Suppression is a DROP, never a queue
 *
 * MEASURED_QUEUE
 *
 * ## Why the tier exemption is here and why it is cheap
 *
 * MEASURED_TIER
 */

import type { FactTier } from "./live-facts.ts"

/** The tier of the highest-ranked fact this turn, which is a property of the TURN, not the sentence. */
export type PaceTier = FactTier

/** The floor between any two spoken lines, in game-clock seconds. */
export const SPEAK_FLOOR_SEC = 60

/** The floor an `interrupt`-tier turn may cut to. */
export const INTERRUPT_FLOOR_SEC = 20

export interface PaceMemory {
	/** Game clock of the last line actually spoken, or null before the first one. */
	lastSpokeAtSec: number | null
}

export const newPaceMemory = (): PaceMemory => ({ lastSpokeAtSec: null })

export const resetPaceMemory = (mem: PaceMemory): void => {
	mem.lastSpokeAtSec = null
}

export interface PaceOptions {
	floorSec?: number
	interruptFloorSec?: number
}

export interface PaceDecision {
	speak: boolean
	/** Seconds since the last spoken line; `Infinity` before the first. */
	sinceSec: number
	/** The floor that actually applied, after any tier exemption. */
	floorSec: number
	reason: "first" | "clear" | "interrupt" | "floor"
}

export const mayspeak = (
	mem: PaceMemory,
	nowSec: number,
	tier: PaceTier = "standing",
	opts: PaceOptions = {}
): PaceDecision => {
	const floor = opts.floorSec ?? SPEAK_FLOOR_SEC
	const interruptFloor = Math.min(opts.interruptFloorSec ?? INTERRUPT_FLOOR_SEC, floor)
	if (mem.lastSpokeAtSec === null) return { speak: true, sinceSec: Infinity, floorSec: floor, reason: "first" }
	const since = nowSec - mem.lastSpokeAtSec
	if (since >= floor) return { speak: true, sinceSec: since, floorSec: floor, reason: "clear" }
	if (tier === "interrupt" && since >= interruptFloor)
		return { speak: true, sinceSec: since, floorSec: interruptFloor, reason: "interrupt" }
	return { speak: false, sinceSec: since, floorSec: tier === "interrupt" ? interruptFloor : floor, reason: "floor" }
}

export const noteSpoken = (mem: PaceMemory, nowSec: number): void => {
	mem.lastSpokeAtSec = nowSec
}
