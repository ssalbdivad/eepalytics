/**
 * How OFTEN the live coach may open her mouth — decided here, in TypeScript, on a clock.
 *
 * ## Why this file exists at all
 *
 * `analysis/live-facts.ts` already owns a floor and that floor works. It gates the RANKED LIST.
 * Under the fenced architecture the list was also the coach's whole vocabulary, so gating the list
 * gated the speech and one rule did both jobs.
 *
 * `shared/live-coach-mode.ts` demoted the list to a hint. That is measured and it is worth 13.5x
 * the useful output — and it silently removed every rate limit this coach had, because she no
 * longer needs the list's permission to say something. Replayed over game 5635467422 at the shipped
 * twenty-second turn, the unpaced cite-or-quiet coach spoke on 103 of 110 turns: 2.84 lines a
 * minute, a median gap of NINETEEN seconds, and THIRTEEN lines in its busiest four minutes.
 *
 * He switched the previous coach off at nine lines in four minutes, one every twenty-five seconds.
 * So the new architecture, unpaced, is 44% chattier than the thing he quit over. The volume gain is
 * the entire point of the change and it cannot be given back through the prompt — "only speak when
 * it matters" is not a knob, it cannot be swept, and it re-creates the gag the ablation just paid
 * to remove. The cadence belongs on the client, on a clock, as ONE NUMBER.
 *
 * ## The sweep
 *
 * A sweep replayed 110 real recorded turns of that game — the coach's own sentences, in order, on
 * a 19.8-second grid — and applied each candidate floor to what she actually said. It ran through
 * `scripts/ablate-autonomy.ts --pace-sweep`, and NEITHER its input (`data/eval/pace-grid20.json`)
 * nor its output (`data/eval/pace-sweep-grid20.json`) is on disk; the script was retired on
 * 2026-09-11. So the table below is the whole surviving record and it cannot be re-derived — say
 * that plainly rather than citing a file that is gone. To re-decide the floor, sweep a
 * `bench-stream` run's transcript instead:
 *
 *     floor    lines   per min   busiest 4 min   min gap   median gap
 *     none       103      2.84        13            18s        19s
 *      30s        52      1.43         7            36s        42s
 *      45s        35      0.96         5            55s        61s
 *      60s        30      0.83         4            61s        79s
 *      90s        22      0.61         3            97s        98s
 *     120s        16      0.44         2           122s       140s
 *
 * For scale in the other direction: the FENCED coach these numbers replace managed 13 lines in a
 * whole game, 0.35 a minute, six of them judged useful (`live-coach-mode.ts`).
 *
 * `SPEAK_FLOOR_SEC` is 45 because it is the largest floor that stays clearly under his own quit
 * rate — five lines in the busiest four minutes against the nine he walked out on — while losing
 * the least. Of the 68 lines it drops, 42 are covered inside two minutes by a line he DOES hear;
 * at a 90-second floor that falls to 38 of 81, so the wider floor throws away 17 more topics that
 * then reach him not at all. It is also, arrived at independently, `MIN_GAP_SEC` in
 * `analysis/live-facts.ts` — "the shortest gap at which the previous line has plausibly been acted
 * on", from the fact that rerouting or declining a fight takes ten to thirty seconds. Two different
 * arguments landing on the same number is the reason to believe either.
 *
 * It is restated here rather than imported, deliberately. The two floors mean the same thing today
 * and they answer to different evidence; a change made to the ranker's floor for a ranking reason
 * must not silently retune how often she speaks.
 *
 * ## A floor QUANTIZES to the turn, so there is no point tuning it finely
 *
 * Turns arrive every `DEFAULT_TURN_MS`, so a floor of F seconds delivers a line every
 * `ceil(F / turn) * turn`. Measured: at a 19.8-second grid the 45-second floor produced a minimum
 * gap of 55 seconds and a median of 61. Any floor in (40, 60] behaves as "about one line a minute".
 * Moving 45 to 50 changes nothing that can be heard.
 *
 * ## Suppression is a DROP, and that was measured, not assumed
 *
 * Queueing the suppressed line and speaking it when the floor clears sounds strictly better and is
 * not. Simulated on the same 110 turns at a 45-second floor: 34 deliveries, median age 19 seconds,
 * worst 43 — and **17 of the 34 quoted a figure the ground-truth block no longer carried by the
 * time it would have been spoken.** Half of a queue's output breaks the app's own citation rule,
 * which is the one rule the whole architecture rests on. It buys nothing to pay for that with: the
 * fresh line each delivery DISPLACES was itself judged useful 32 times against the stale line's 34.
 * A fact worth saying at 12:04 is not worth saying at 12:49, and the coach has a fresher one in
 * hand at 12:49 anyway. So there is no queue in this module and no pending line in `PaceMemory` —
 * the shape of the API is the finding.
 *
 * ## The tier exemption is measured, and it is refused
 *
 * `buildFacts` tags every fact with a `tier`, and letting an `interrupt` — the enemy took Baron, a
 * fight happened without him — cut the floor looks nearly free. It is nearly free because it is
 * nearly inert. Over the same game a 45-second floor with interrupts cut to 20 spoke 36 lines
 * against the plain floor's 35: ONE extra line in thirty-six minutes, because on six interrupt
 * turns in a game the floor has usually already cleared. It is paid for with the floor's one
 * guarantee — the minimum gap falls from 55 seconds to 37.
 *
 * And on half of those turns she is not talking about the interrupt at all. Read from the sweep's
 * own output: offered "they have Herald and a free tower charge" at 15:38 she said "With Urgot and
 * Taliyah down, clear your camps to get your level back"; offered "that fight was 3 for 1, so take
 * the free camps while you are up bodies" at 17:40 she said "Briar is at least 41 CS behind you".
 * The tier belongs to the TURN and not to the sentence, and an exemption that fires on the turn
 * lets a farm line jump the queue as readily as a Baron.
 *
 * `interruptFloorSec` therefore exists, defaults to the floor (inert), and is here so the sweep can
 * keep measuring it. If the ranked fact ever becomes what she actually says — the arm to run is one
 * where the interrupt is offered ALONE and the sentence is checked against it — this is the one line
 * to change.
 *
 * ## What was measured and rejected alongside it
 *
 *   - **A floor that scales with how much is happening.** 90 seconds quiet, 45 when the turn
 *     carries an expiring or interrupt fact: 23 lines, against 22 for the flat 90. Only 12 of 110
 *     turns carry a non-standing fact, so "how much is happening" as the app can see it is almost
 *     always the same answer.
 *   - **A budget that may bunch.** Four lines per rolling four minutes with a 20-second hard floor
 *     delivers the same 35 lines as the flat 45 — with a minimum gap of 24 seconds and a median of
 *     37. It spends its whole budget in a burst and then goes quiet, which is precisely the shape
 *     he quit over, at the same daily volume. Bunching is the failure mode, not the feature.
 *
 * ## Re-measured with the floor actually applied, against the fence it replaces
 *
 * The sweep above pages through floors on one arm. The question that decides the DEFAULT is
 * whether the paced coach still beats the fence, and both arms were therefore re-run on the same
 * 110-turn grid with the real frames attached and the floor applied before the turn, as the socket
 * applies it (`data/eval/paced-grid20-arms.json`, the table in `shared/live-coach-mode.ts`). Paced,
 * cite-or-quiet says 34 useful lines in the game against the fence's 7, at five lines in its
 * busiest four minutes against the nine he quit over. The fence's own first sentence of that game
 * arrives at 8:37.
 *
 * The floor's cost showed up in the transcript rather than in any rate: 13 of the 36 lines he hears
 * restate something from the previous three minutes, 18 of 36 say "camps" and 12 say recall. That
 * is the predicted consequence of keeping the EARLIEST line in each window — the standing farm and
 * gold facts are true on every turn, so they win every window. Dropping a line that restates one
 * from the last three minutes takes 36 to 29 with the cadence untouched (min gap 54s, median 61s)
 * and reads far better. It is not in this file because a floor is a clock and cannot know what she
 * is about to say: a novelty gate has to run AFTER the turn, which the turn-based path can do and
 * the Live socket, which speaks the audio itself, cannot. The socket's own thread and the prompt's
 * do-not-repeat rule are what fight this there, and neither exists in the stateless harness these
 * 36% came from, so 36% is an upper bound and not a measurement of the shipped socket.
 *
 * ## What the floor does NOT do
 *
 * It does not improve what she says. It keeps the EARLIEST line in each window, never the best one:
 * on the judged corpus (`data/eval/pace-sweep-judged.json`, 39 lines carrying a blind verdict) a
 * 45-second floor kept 13 useful and 0 false while dropping 20 useful and 3 false, and at 60 it
 * kept 2 of the 3 false lines instead. Three fabrications is not a mechanism, it is noise. Anything
 * that makes a line WRONG is still the citation rule's job; this file only decides how often.
 */

import type { FactTier } from "./live-facts.ts"

/**
 * The tier of the loudest ranked fact this turn.
 *
 * A property of the TURN, not of the sentence — she is free to speak about something else, and
 * measured, she often does. See the module comment before keying anything important off it.
 */
export type PaceTier = FactTier

/**
 * The floor between any two spoken lines, in game-clock seconds. The only number in this file.
 *
 * 45. Measured: 35 lines in a 36-minute game, 0.96 a minute, five in the busiest four minutes
 * against the nine he quit over — and the smallest amount of original material lost of any floor
 * that stays under that rate. See the module comment for the sweep and for why it is not imported
 * from `live-facts.ts` even though that file arrived at 45 as well.
 */
export const SPEAK_FLOOR_SEC = 45

export interface PaceMemory {
	/**
	 * Game clock of the last line actually SPOKEN, or null before the first.
	 *
	 * The only field, and the absence of a `pending` beside it is deliberate — see the module
	 * comment on why a queue was measured and refused.
	 */
	lastSpokeAtSec: number | null
}

export const newPaceMemory = (): PaceMemory => ({ lastSpokeAtSec: null })

/** One socket, one game (`shared/live-coach-mode.ts`), so one pace memory per game too. */
export const resetPaceMemory = (mem: PaceMemory): void => {
	mem.lastSpokeAtSec = null
}

export interface PaceOptions {
	floorSec?: number
	/**
	 * The floor an `interrupt`-tier turn may cut to. Defaults to `floorSec`, i.e. inert.
	 *
	 * Measured and refused for the shipped default — see the module comment. It stays a parameter
	 * so `--pace-sweep` can keep re-measuring it as the coach changes.
	 */
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

/**
 * May she say the line she has in hand?
 *
 * Pure, and it does not write — `noteSpoken` does, and only when the line is really spoken. A
 * decision that recorded itself would let a line suppressed by a LATER rule (an empty answer, a
 * gameflow phase change, a dropped socket) start the floor running as if he had heard something.
 *
 * The `tier` argument is worth passing even while the exemption is inert: it is what the sweep
 * reads to keep the refusal honest as the coach changes.
 */
export const mayspeak = (
	mem: PaceMemory,
	nowSec: number,
	tier: PaceTier = "standing",
	opts: PaceOptions = {}
): PaceDecision => {
	const floor = opts.floorSec ?? SPEAK_FLOOR_SEC
	const interruptFloor = Math.min(opts.interruptFloorSec ?? floor, floor)
	if (mem.lastSpokeAtSec === null) return { speak: true, sinceSec: Infinity, floorSec: floor, reason: "first" }
	const since = nowSec - mem.lastSpokeAtSec
	if (since >= floor) return { speak: true, sinceSec: since, floorSec: floor, reason: "clear" }
	if (tier === "interrupt" && since >= interruptFloor)
		return { speak: true, sinceSec: since, floorSec: interruptFloor, reason: "interrupt" }
	return { speak: false, sinceSec: since, floorSec: tier === "interrupt" ? interruptFloor : floor, reason: "floor" }
}

/**
 * Mark a line as SAID. Call it once the line has actually gone out, never on the decision.
 *
 * The clock is the GAME clock, not the wall clock, for the same reason every other rate limit in
 * this app is: a paused game, a loading screen and a five-minute lobby all stop it, and a floor
 * that expired while nothing was happening is a floor that fires twice on the first real turn.
 */
export const noteSpoken = (mem: PaceMemory, nowSec: number): void => {
	mem.lastSpokeAtSec = nowSec
}
