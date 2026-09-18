/**
 * The knowledge the shipped cite-or-quiet coach gets, against the knowledge the ablation measured.
 *
 * That run is the entire justification for changing the coach's architecture, and champion prose is
 * the one input it carried that no scorer checks — the parser guarantees it holds no digits, and
 * nothing guarantees it holds the same SENTENCES.
 *
 * The two were byte-identical until 2026-09-18. They now differ by exactly the two clauses in
 * `RETRACTIONS`, both of which taught the Swirlseed as a scouting tool that rolls past terrain, and
 * both of which are refuted by the wiki's own Swirlseed text and by Riot's tooltip. The difference
 * is asserted in BOTH directions: the player stops hearing them, and the arm that reproduces the run
 * still holds them. A retraction that also edited the measured corpus would destroy the run it was
 * trying to correct.
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { RETRACTIONS } from "../knowledge/legacy-clauses.ts"
import { ablationChampionKnowledge as championKnowledge } from "./ablation-arms.ts"
import { liveChampionKnowledge } from "./live-coach-knowledge.ts"

test("Lillia's knowledge is the measured text minus exactly the retracted clauses", () => {
	const shipped = liveChampionKnowledge("Lillia")
	const measured = championKnowledge("Lillia")
	assert.equal(shipped.length > 0, true, "the frozen Lillia section no longer parses to any clause")

	const dropped = RETRACTIONS.filter(r => r.key === "lillia")
	assert.equal(dropped.length > 0, true, "no Lillia retraction is recorded, so this test proves nothing")

	const shippedLines = shipped.split("\n")
	const measuredLines = measured.split("\n")
	assert.deepEqual(
		measuredLines.filter(l => !dropped.some(r => l.endsWith(r.clause))),
		shippedLines,
		"the shipped text differs from the measured one by something other than the retractions"
	)
	for (const r of dropped) {
		assert.equal(shipped.includes(r.clause), false, `still shipping: ${r.clause}`)
		assert.equal(measured.includes(r.clause), true, `the measured corpus lost: ${r.clause}`)
	}
})

test("a champion with no clauses degrades to nothing rather than to the role default", () => {
	// Twenty of the twenty-four deleted files never had a clause section, and the measured arm found
	// nothing for those champions either. Silently substituting the role clauses would make the
	// comparison meaningless — and would put jungle-general advice in a slot labelled "a one-trick
	// on <champion> would add".
	assert.equal(liveChampionKnowledge("Zzznotachampion"), "")
	assert.equal(liveChampionKnowledge(""), "")
	assert.equal(liveChampionKnowledge("_default"), "")
})

test("no clause carries a digit, whatever the corpus holds", () => {
	for (const line of liveChampionKnowledge("Lillia").split("\n").filter(l => l.startsWith("- (")))
		assert.equal(/[0-9]/.test(line), false, `a digit reached the live prompt: ${line}`)
})
