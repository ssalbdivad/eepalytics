/**
 * WHY SHE IS QUIET — one state, named, in one place.
 *
 * ## The failure this exists for
 *
 * The coach is being cut back to roughly six spoken lines in a twenty-eight minute game. That is
 * four minutes of silence between lines, by design — and this app has a documented failure mode
 * where silence looks exactly like breakage. The ground-truth fetch failed for weeks and nothing
 * on screen said so, because a coach that is correctly quiet and a coach that has died produce the
 * identical empty panel.
 *
 * There are exactly three reasons for silence and they are not the same thing:
 *
 *   1. **Nothing has changed.** The schedule fires on a contestable future state; between those
 *      moments she is never asked at all, so no turn goes out and nothing fails.
 *   2. **She was asked and declined.** A turn went out, she judged the moment, and passed. That is
 *      the feature working at its most expensive — and from the outside it is invisible.
 *   3. **Something is broken.** The socket is down, the block is not arriving, the share died.
 *
 * Today all three render as the same nothing. This file turns the readings the page already holds
 * into one of them, with the age that makes it checkable.
 *
 * ## Why it is here and not in the component
 *
 * `ScreenCoach` draws this twice — the full panel and the 380px strip he actually plays with —
 * and those two disagreeing is precisely how the strip came to say "In a game — coach arming"
 * over a coach that had given up. One function, two call sites, and a state a test can pin.
 *
 * ## The one rule it obeys
 *
 * Nothing here reaches the model, and nothing here is a claim about the GAME. It is a statement
 * about this app's own machinery, which is the only thing it can observe directly. The owner's
 * rule — nothing may tell the model what to say — is untouched: this is panel copy for a human.
 */

import { age } from "./boardView.ts"

/** The named states. Every one of these is something a person can say out loud. */
export type CoachState =
	/** Not sharing. Nothing is running and nothing is claimed. */
	| "off"
	/** Sharing, but the client is not in a game — nothing is being sent, on purpose. */
	| "standby"
	/** The journal is recording and only the VOICE is blocked, for want of a key. */
	| "nokey"
	/** The socket is on its way up, or on its way back. */
	| "connecting"
	/** Something is wrong. The fault list owns the words. */
	| "broken"
	/** Live, in a game, and not yet asked anything this game. */
	| "unasked"
	/** She was asked, recently, and said nothing. Reason 2. */
	| "passed"
	/** She has not been asked since the last thing happened. Reason 1. */
	| "idle"
	/** She spoke, recently enough that it is still the answer to "what is she doing". */
	| "spoke"

/**
 * The worst thing currently wrong, as `lib/liveFaults.ts` reports it.
 *
 * `text` travels as well as `short` because the 380px popout has no fault list under it — the
 * whole panel is a `compact` branch that returns first — so at that width the strip is the only
 * place a fault can be read, and a tooltip is not readable with a hand on the mouse.
 */
export interface PulseFault {
	level: "warn" | "error"
	short: string
	text: string
	fix: string | null
}

export interface CoachPulseInput {
	/** Is a screen being shared at all? */
	sharing: boolean
	/** The League client is in champion select or later — the gate on everything being sent. */
	armed: boolean
	/** The socket's own state. */
	status: "off" | "connecting" | "live" | "reconnecting" | "error"
	/** The worst current fault, or null when nothing is wrong. */
	fault: PulseFault | null
	/** Why nothing is being sent, in the gate's own words, or null when the gate is open. */
	standby: string | null
	/** False when the DAEMON is unreachable — not the same as the League client being closed. */
	daemonReachable: boolean
	/** True when there is no working Gemini key, so the voice half cannot run. */
	needsKey: boolean
	/**
	 * When the last ground-truth block landed — which IS when she was last asked.
	 *
	 * The block is fetched per turn and only when a turn is actually going out (`groundTruth` in
	 * `ScreenCoach`), so its arrival time is the send time of the last turn to within a fetch. It
	 * is the only timestamp on this page that means "she was asked", and using anything else —
	 * a turn COUNTER, say — cannot tell "asked three minutes ago" from "asked four seconds ago".
	 */
	askedAtMs: number | null
	/** When she last said something of her own. A question he typed is not her speaking. */
	spokeAtMs: number | null
	/** Completed turns this session, hers and his together. */
	turns: number
	/** Her own lines this session. */
	spokenLines: number
	nowMs: number
}

export interface CoachPulse {
	state: CoachState
	/** The strip's one line. Kept under ~34 characters, because 380px is the width he plays at. */
	short: string
	/**
	 * The answer to "why is it quiet", or null when silence is not the thing being explained.
	 *
	 * One sentence. It names which of the three reasons this is, and carries the age that makes
	 * it checkable — "quiet" with no number is an assurance, and this app does not ship those.
	 */
	why: string | null
	/** Rule 3 of the design system: teal is the live socket, amber attention, red a failure. */
	tone: "off" | "live" | "quiet" | "warn" | "error"
}

/**
 * How recent an ask still counts as the thing that happened.
 *
 * Under the shipped schedule she is asked when the game moves, with a floor under silence; an ask
 * inside this window is still the most recent event and "she passed on it" is the true sentence.
 * Beyond it the ask is history and the true sentence is that the schedule has not fired since —
 * the two are different facts about the machine and they must not share one line.
 *
 * 45 seconds, i.e. comfortably inside the silence floor, so the state only turns over once she
 * could have been asked again and was not.
 */
const RECENT_ASK_MS = 45_000

/** Same reasoning for a line she actually said: after this it stops being the current answer. */
const RECENT_LINE_MS = 45_000

const ago = (ms: number): string => age(ms / 1000)

export const coachPulse = (i: CoachPulseInput): CoachPulse => {
	if (!i.sharing)
		return {
			state: "off",
			short: i.needsKey ? "Live coach needs a key" : "Live coach",
			why: null,
			tone: "off"
		}

	/*
	 * A fault outranks everything below it, including standby.
	 *
	 * A green dot over a broken coach is the single most misleading thing this strip can show, and
	 * it showed exactly that. Warnings do NOT outrank: "N blind check-ins" is a degradation and
	 * she is still coaching, so it rides along in `why` rather than taking the headline.
	 */
	if (i.fault !== null && i.fault.level === "error")
		return {
			state: "broken",
			short: i.fault.short,
			why: i.fault.fix === null ? i.fault.text : `${i.fault.text} ${i.fault.fix}`,
			tone: "error"
		}

	/*
	 * Sharing, nothing being sent, and that is correct. With the share persisting across games this
	 * is the state the window spends most of an evening in, so it has to read as deliberate — the
	 * gate already owns the sentence, and saying it a second way here is how two surfaces drift.
	 */
	if (i.standby !== null)
		return {
			state: "standby",
			short: i.daemonReachable ? "Sharing — waiting for your game" : "Sharing — can't reach eepalytics",
			why: i.standby,
			tone: i.daemonReachable ? "off" : "warn"
		}

	if (i.needsKey)
		return {
			state: "nokey",
			short: "Recording — voice needs a key",
			/* The free half is running. Saying only "needs a key" hides the half that works. */
			why: "Frames are being saved for the graded review; only the spoken coach is blocked.",
			tone: "warn"
		}

	if (i.status === "connecting" || i.status === "reconnecting")
		return {
			state: "connecting",
			short: i.status === "connecting" ? "Coach connecting…" : "Coach reconnecting…",
			why:
				i.status === "reconnecting" ?
					"The session credential lasts about half an hour and games run longer — a reconnect mid-game is routine."
				:	"Opening the socket. She cannot speak until it is up.",
			tone: "warn"
		}

	/*
	 * Live, armed, and nothing is wrong. Everything from here down is a SILENCE, and the job is
	 * to say which of the two legitimate kinds it is.
	 */
	if (i.status !== "live")
		return {
			state: "broken",
			short: "Coach is not connected",
			why: "The socket is closed, so nothing is being asked and nothing can be said.",
			tone: "error"
		}

	const sinceAsk = i.askedAtMs === null ? null : i.nowMs - i.askedAtMs
	const sinceLine = i.spokeAtMs === null ? null : i.nowMs - i.spokeAtMs

	if (sinceAsk === null)
		return {
			state: "unasked",
			short: "Watching · not asked yet",
			why:
				"She has not been asked anything yet — the game has not reached a moment worth spending a sentence on.",
			tone: "quiet"
		}

	/* The most recent thing that happened was a LINE: she was asked and she answered. */
	if (sinceLine !== null && sinceLine <= sinceAsk) {
		if (sinceLine < RECENT_LINE_MS)
			return {
				state: "spoke",
				short: `Spoke ${ago(sinceLine)} ago`,
				why: null,
				tone: "live"
			}
		return {
			state: "idle",
			short: "Quiet · nothing has changed",
			why: `Nothing has changed since she last spoke, ${ago(sinceLine)} ago — she is only asked when the game moves.`,
			tone: "quiet"
		}
	}

	/* The most recent thing that happened was an ASK she declined. */
	const passed = Math.max(0, i.turns - i.spokenLines)
	if (sinceAsk < RECENT_ASK_MS)
		return {
			state: "passed",
			short: `Quiet · asked ${ago(sinceAsk)} ago`,
			why: `She was asked ${ago(sinceAsk)} ago and had nothing worth saying — ${passed} of ${i.turns} check-in${i.turns === 1 ? "" : "s"} this game went that way.`,
			tone: "quiet"
		}

	return {
		state: "idle",
		short: "Quiet · nothing has changed",
		why: `Nothing has changed since she was last asked, ${ago(sinceAsk)} ago — she is only asked when the game moves.`,
		tone: "quiet"
	}
}
