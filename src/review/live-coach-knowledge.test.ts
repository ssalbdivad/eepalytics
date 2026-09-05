/**
 * One thing worth pinning: the knowledge the shipped cite-or-quiet coach gets is the knowledge the
 * ablation's unfenced arms got. That run is the entire justification for changing the coach's
 * architecture, and champion prose is the one input it carried that no scorer checks — the parser
 * guarantees it holds no digits, and nothing guarantees it holds the same SENTENCES.
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { championKnowledge } from "../../scripts/ablate-autonomy.ts"
import { liveChampionKnowledge } from "./live-coach-knowledge.ts"

test("Lillia's knowledge is byte-identical to what the ablation measured", () => {
	const shipped = liveChampionKnowledge("Lillia")
	assert.equal(shipped.length > 0, true, "lillia.md no longer parses to any clause")
	assert.equal(shipped, championKnowledge("Lillia"))
})

test("a champion with no note degrades to nothing rather than to the role default", () => {
	// `championNote` falls back to `_default.md`; the measured arm read the champion file or found
	// none. Silently substituting different prose would make the comparison meaningless.
	assert.equal(liveChampionKnowledge("Zzznotachampion"), "")
	assert.equal(liveChampionKnowledge(""), "")
})

test("no clause carries a digit, whatever is on disk", () => {
	for (const line of liveChampionKnowledge("Lillia").split("\n").filter(l => l.startsWith("- (")))
		assert.equal(/[0-9]/.test(line), false, `a digit reached the live prompt: ${line}`)
})
