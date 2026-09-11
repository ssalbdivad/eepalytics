/**
 * The prose that ships UNPARSED into the default system prompt, and the one claim it may not make.
 *
 * `fullKnowledge` is the only loader in the app with no fence in front of it. The two older modes
 * run every champion line through `parseChampionClauses`, which rejects digits and drops anything
 * outside `## Live coaching`; this one takes the markdown whole, on purpose, because the numbers
 * and the reasons were the point. That trade means a sentence typed into a knowledge file lands in
 * the model's instructions verbatim, LAST, after everything `TRUSTED_PROMPT` said.
 *
 * ## The claim, and why it gets a test of its own
 *
 * The enemy jungler's CS in the live feed is a count of what the player's OWN CLIENT witnessed, not
 * his farm. Measured against the post-game timeline of game 5639406342, Kayn's row read
 * 0/20/30/50/60/70 at minutes 5/10/14/20/25/28 against a true 32/58/84/125/156/183 — under-reporting
 * by 2.6x at the end of a game he was level on farm the whole way through. The coach reading that
 * column told the user he was up 71 and then up 92, and both of the only two lines a human grader
 * has ever marked FALSE in this app are that number.
 *
 * `TRUSTED_PROMPT` says so at length, `buildBrief` deliberately omits the figure and states the
 * omission, and `buildDelta` omits it silently. And then it came BACK, in a new role file written
 * after the fix, as "This app can see the enemy jungler's CS, level and completed items. That is
 * real information" — appended after the paragraph that refutes it, which is the position a reader
 * weights most. Twice is a pattern, so it gets a check rather than a comment.
 *
 * Two inferences get pinned alongside it because they are worse than the raw number: the counter
 * CLIMBS when he is visible and STALLS when he is not, so "his CS is climbing, he is on a route"
 * and "his CS has stalled, he is not farming" are both exactly backwards. `coach-memory.ts` calls
 * the second one a fabrication in prose; this is the same statement as an assertion.
 *
 * ## What this cannot do
 *
 * It matches phrasings, so it is a floor and not a proof — a new file could say the same false thing
 * in words no pattern here anticipates. What it does guarantee is that the specific sentences that
 * have already shipped once cannot ship again, and that anyone adding a counterpart-farm claim has
 * to walk past a failing test with this comment attached to do it.
 */

import { ok } from "node:assert/strict"
import { describe, it } from "node:test"
import { fullKnowledge } from "./live-knowledge-full.ts"

/**
 * The prompt as the socket receives it, for a real matchup off disk.
 *
 * Lillia is what he plays; Briar is the counterpart file added this round, and it is here rather
 * than Kayn because Kayn has no notes on disk and a missing file renders as nothing — which would
 * make the matchup assertion below pass vacuously against a loader that had stopped working.
 */
const prompt = (): string => fullKnowledge({ champion: "Lillia", counterpart: "Briar" })

interface Banned {
	pattern: RegExp
	why: string
}

const BANNED: Banned[] = [
	{
		pattern: /(?:can see|reads?|gives? you|carries|reports?)[^.\n]{0,60}enemy jungler'?s?[^.\n]{0,40}\bCS\b/i,
		why: "the enemy jungler's CS is a visibility counter, not his farm — see the header"
	},
	{
		pattern: /counterpart'?s?[^.\n]{0,40}\bCS\b[^.\n]{0,40}(?:is real|real information|beats)/i,
		why: "same claim, worded as a recommendation to trust it"
	},
	{
		pattern: /\bCS\b[^.\n]{0,60}(?:gap|lead|ahead|behind)[^.\n]{0,40}(?:counterpart|enemy jungler)/i,
		why: "there is no farm gap between the two junglers anywhere in this payload"
	},
	{
		pattern: /(?:counterpart|enemy jungler|his)[^.\n]{0,30}\bCS\b[^.\n]{0,30}(?:is climbing|climbing steadily)/i,
		why: "the counter climbs when he is VISIBLE, so climbing is not evidence he is on a route"
	},
	{
		pattern: /\bCS\b[^.\n]{0,30}has stalled/i,
		why: "the counter stalls when nobody watched him, which is a jungler's normal state — it is not evidence he stopped farming"
	},
	{
		pattern: /a \d+-CS gap is real/i,
		why: "the flooring rule does not apply: the measured error on the counterpart was +113, not +/-9"
	}
]

describe("the full-knowledge prompt", () => {
	it("makes no claim about the counterpart's CS", () => {
		const text = prompt()
		for (const b of BANNED) {
			const hit = b.pattern.exec(text)
			ok(
				hit === null,
				`the shipped system prompt asserts something about the enemy jungler's CS: ${JSON.stringify(hit?.[0])}\n  ${b.why}`
			)
		}
	})

	/*
	 * The counterpart section is what `lockedCounterpart` was silently dropping for the life of
	 * every socket, so this pins that the loader itself does produce one when it is told who he is.
	 * The route test covers the resolution; this covers the render.
	 */
	it("carries the role file and both champions when the counterpart is known", () => {
		const text = prompt()
		ok(text.includes("# THE ROLE"), "the role file is missing from the prompt")
		ok(text.includes("# YOUR CHAMPION: Lillia"), "his own champion's notes are missing")
		ok(text.includes("# THE ENEMY JUNGLER: Briar"), "the matchup half is missing")
	})
})
