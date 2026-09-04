/**
 * `renderState` is the one definition of "what is true" shared by the glance path, the Gemini
 * live socket and the eval harness. It is pure, so it is cheap to pin.
 *
 * The first test is a regression: `unseen` — the ranked list of facts the player is not
 * tracking — was computed on every glance and silently dropped from the rendered block for its
 * entire life, while both system prompts instructed the model to "take your line from" it. Being
 * ordered to speak from a list that does not exist is what produced invented execution coaching
 * ("clear faster, you need to use more abilities") in a real game.
 */

import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { renderState } from "../shared/live-state.ts"
import type { VisionState } from "../shared/live-state.ts"

const base = (over: Partial<VisionState> = {}): VisionState => ({
	clock: "14:30",
	me: { champion: "Lillia", level: 11, k: 3, d: 2, a: 4, cs: 120, gold: 1450 },
	allies: [{ champion: "Darius", level: 12, k: 4, d: 3, a: 2 }],
	enemies: [{ champion: "Graves", level: 12, k: 6, d: 3, a: 3, dead: true, respawnSec: 22 }],
	recentEvents: [],
	unseen: [],
	...over
})

describe("renderState", () => {
	it("emits every unseen fact verbatim", () => {
		const out = renderState(base({ unseen: ["Graves is DEAD for another 22s", "1450g sitting unspent"] }))
		ok(out.includes("Graves is DEAD for another 22s"), "dead-enemy fact missing from the block")
		ok(out.includes("1450g sitting unspent"), "unspent-gold fact missing from the block")
	})

	it("uses the heading the prompts tell the model to look for", () => {
		// If this drifts, the model is pointed at a section that does not exist.
		const out = renderState(base({ unseen: ["Graves is DEAD for another 22s"] }))
		ok(out.includes("What he is NOT looking at"), "heading does not match the prompt")
	})

	it("names the empty case instead of leaving a gap", () => {
		/*
		 * Regression: an omitted section is ambiguous, and at a tick where the list was empty the
		 * coach announced a death that never happened. The block must say "nothing" out loud.
		 */
		const out = renderState(base())
		strictEqual(out.includes("NOT looking at"), false, "no dangling heading")
		ok(out.includes("Nothing he is missing right now"), "the empty case must be stated")
		ok(out.includes("PASS"), "and it must name the correct answer")
	})

	it("gives the roster no death state to invent a timer from", () => {
		/*
		 * Twice a regression. `DEAD (14s)` let the model read timers past the vetted list; a bare
		 * `DEAD` let it invent one ("Qiyana is down for 8 seconds", when Qiyana had no timer) and
		 * announce a death to the last man alive in a 1v4. Who is down is the fact list's job,
		 * where the rules about it apply.
		 */
		const out = renderState(
			base({ enemies: [{ champion: "Graves", level: 12, k: 6, d: 3, a: 3, dead: true, respawnSec: 22 }] })
		)
		strictEqual(/DEAD/.test(out), false, "no death marker in the roster")
		strictEqual(out.includes("22"), false, "and certainly no timer")
		ok(out.includes("Alive right now"), "the count is still available")
	})

	it("still names the roster and the clock", () => {
		const out = renderState(base())
		ok(out.includes("Clock 14:30"))
		ok(out.includes("Lillia"))
		ok(out.includes("Graves"))
	})
})
