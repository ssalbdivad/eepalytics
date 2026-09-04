/**
 * The turn's QUESTION — the thing that turns a fact into a decision.
 *
 * ## The failure this exists to fix
 *
 * The live coach was true and useless. Real lines from a real session:
 *
 *     Drake is back in 52s.  /  You have 1334g sitting unspent.  /  Wukong just died for 32s.
 *
 * Every one of those is already on his screen, or one keypress away. The ground-truth block was
 * built to stop hallucination by restricting the coach to client facts, and it worked — but
 * client facts are precisely what the player is looking at, so a design optimised for TRUE
 * arrived at USELESS.
 *
 * The other failure is the one a naive fix produces MORE of. Handed champion notes as background
 * colour, a coach says *"Viego is your jungle counterpart so watch for his ganks"* — true, and it
 * could have been said in any game he has ever played, at any minute of it.
 *
 * ## What this computes
 *
 * Not the advice. The QUESTION the advice has to answer, keyed by the state that is true right
 * now and naming the champions actually in this game. The model answers it out of the champion
 * notes it was given, and neither factor is worth saying alone:
 *
 *     generic:  "Viego resets on takedowns, be careful in fights."
 *     specific: "Viego just ulted bot — no reset for 90 seconds, take his red now."
 *
 * The question is computed here, in TypeScript, for the same reason the facts are (see
 * `live-facts.ts`): a model asked to "be actionable" invents, and a model asked a specific
 * question about a state it was handed answers it. It is derived from the top-ranked fact, so it
 * inherits every rate limit that list already enforces — no facts, no question, and PASS remains
 * the answer.
 *
 * ## What it may NOT do
 *
 * It states no number the block does not carry, and asserts nothing about where anybody is. When
 * the enemy jungler is alive the question says he is *unaccounted for*, because that is the true
 * state of our knowledge: the live API publishes positions for nobody.
 *
 * PURE.
 */

import type { TaggedFact } from "./live-facts.ts"

export interface DecisionInput {
	/** His champion, so every question is anchored to a champion in THIS game. */
	myChampion: string
	/** The enemy jungler's champion, or null when nothing identified one. */
	enemyJungler: string | null
	/** That jungler's respawn timer, when he is among the dead right now. Null when he is up. */
	enemyJunglerDeadSec: number | null
	/** The fact the ranker put first. Null when there is nothing worth saying. */
	top: TaggedFact | null
	/** His own respawn, when he is dead. */
	meDeadForSec: number | null
	alliesAlive: number
	enemiesAlive: number
}

/**
 * One question, or null when the coach has nothing worth interrupting for.
 *
 * Deliberately never two. The block already offers up to three facts, and the whole point of this
 * section is that exactly one decision matters in the next thirty seconds.
 */
export const buildDecision = (input: DecisionInput): string | null => {
	const { top, myChampion: me } = input
	if (!top) return null
	const ej = input.enemyJungler
	const ejDead = input.enemyJunglerDeadSec

	/*
	 * Being dead outranks the fact list, whatever it says.
	 *
	 * The one decision a corpse can still make is what he does the moment he lands, and it is the
	 * only decision he currently has time to think about. Deciding it on the walk back is how the
	 * first thirty seconds of a respawn get spent going nowhere in particular.
	 */
	if ((input.meDeadForSec ?? 0) > 0)
		return `He is on the respawn screen. What has ${me} decided before he lands — which camp, and which half of the map?`

	/*
	 * Outnumbered. `buildFacts` already strips windows and deaths in this state, so the surviving
	 * fact is gold, farm or an objective — and the honest question is what he takes INSTEAD of the
	 * fight, not how to win one he cannot.
	 */
	if (input.enemiesAlive > input.alliesAlive + 1)
		return `He is outnumbered ${input.alliesAlive} to ${input.enemiesAlive}. What does ${me} take in the next thirty seconds that is not a fight?`

	switch (top.kind) {
		case "window":
			return `That window is the whole turn. What does ${me} convert it into before it closes — an objective, ${
				ej === null ? "their jungle" : `${ej}'s camps`
			}, or nothing at all?`

		case "objective":
			return ej === null ?
					`Where does ${me} have to be when that lands, and what does he give up to be there?`
				: ejDead !== null ?
					`${ej} cannot contest it. Is that enough for ${me} to start it, and where does he start it from?`
				:	`${ej} is alive and unaccounted for. Does ${me} want that contest, or the map while it happens?`

		case "death":
			/*
			 * The enemy jungler dying is the highest-value state this coach ever sees: it is exact,
			 * it is invisible without opening the scoreboard, and it is the one death whose
			 * consequence is knowable — nobody is clearing his camps while he is on the floor.
			 */
			return ej !== null && ejDead !== null ?
					`${ej} is off the map for ${Math.round(ejDead)}s and nothing is clearing his camps. What is worth taking, and can ${me} get back out?`
				:	`Is that death long enough for ${me} to take something, or is it only information?`

		case "gold":
			return `He is carrying gold he has not spent. What does ${me} want out of the shop next, and which camp is the moment to go and get it?`

		case "farm":
			return `Which camps does ${me} take to close that, and what does he give up to take them?`

		case "praise":
			/*
			 * The game already told him, with a full-screen banner and a sound cue. The only thing
			 * left with information in it is what he does next, so that is what the question asks.
			 */
			return `That already happened and he watched it. What does ${me} do with the thirty seconds after it?`
	}
}
