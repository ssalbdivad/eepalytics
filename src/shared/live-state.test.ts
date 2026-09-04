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

	it("prints the role the client reported, in brackets, on every player who has one", () => {
		/*
		 * The live client's `position` is the reliable one (`shared/schema/live.ts`), unlike the
		 * match-history lane that mislabels 4 of 10 players. Without it the coach could not say
		 * "their mid" about anyone and every matchup line collapsed into "watch for his ganks".
		 */
		const out = renderState(
			base({
				me: { champion: "Lillia", role: "jungle", level: 11, cs: 130 },
				allies: [{ champion: "Darius", role: "top", level: 12 }],
				enemies: [{ champion: "Viego", role: "jungle", level: 11 }]
			})
		)
		ok(out.includes("Lillia (jungle)"), "his own role")
		ok(out.includes("Darius (top)"), "an ally's role")
	})

	it("says nothing about a role the client did not give", () => {
		const out = renderState(base({ allies: [{ champion: "Darius", level: 12 }] }))
		ok(out.includes("Darius lv12"), "no invented bracket")
	})

	it("carries his build and the enemy jungler's, and marks what was just bought", () => {
		const out = renderState(
			base({
				me: {
					champion: "Lillia",
					role: "jungle",
					cs: 130,
					items: [{ name: "Riftmaker" }, { name: "Stealth Ward", trinket: true }]
				},
				enemies: [
					{
						champion: "Viego",
						role: "jungle",
						level: 11,
						cs: 118,
						items: [{ name: "Sundered Sky", justBought: true }]
					}
				]
			})
		)
		ok(out.includes("Your items: Riftmaker, Stealth Ward (trinket)"), "his own build")
		ok(out.includes("Viego (their jungler) lv11, 118 CS"), "the counterpart he plays against")
		ok(out.includes("Sundered Sky (just bought)"), "the delta that makes the fact actionable")
	})

	it("hands over the camp gap already worked out", () => {
		// The prompt forbids arithmetic on the block, so a difference it is meant to use has to
		// arrive computed or it cannot be used at all.
		const out = renderState(
			base({
				me: { champion: "Lillia", role: "jungle", cs: 130, items: [] },
				enemies: [{ champion: "Viego", role: "jungle", cs: 118, items: [] }]
			})
		)
		ok(out.includes("12 camps behind you"), `gap missing: ${out}`)
	})

	it("states the inventories are complete, so an unlisted item cannot be claimed", () => {
		const out = renderState(base({ me: { champion: "Lillia", items: [{ name: "Riftmaker" }] } }))
		ok(out.includes("Complete inventories, item for item"), "the fence")
		ok(/what one cost, or when it was bought/.test(out), "no prices, no purchase times")
		ok(/"\(just bought\)" is true only where THIS/.test(out), "the mark expires with the message")
	})

	it("names an empty inventory rather than leaving the line out", () => {
		// Same rule as the empty fact list: an omitted section is a gap, and a model fills a gap.
		const out = renderState(base({ me: { champion: "Lillia", items: [] } }))
		ok(out.includes("Your items: nothing bought yet"))
	})

	it("separates an empty inventory from no inventory at all", () => {
		/*
		 * The eval harness rebuilds states from post-game timelines, which carry no purchases —
		 * so its `items` are undefined. Rendering that as "nothing bought yet" would tell the
		 * model a 24-minute jungler owns nothing: a fabricated fact, handed over by the block
		 * whose entire job is preventing them.
		 */
		const out = renderState(base())
		strictEqual(out.includes("nothing bought yet"), false)
		ok(out.includes("No build data this tick"), "the absence is named")
		ok(out.includes("say\nnothing about builds at all"), "and it forbids the guess")
	})

	it("says nothing about a jungler whose inventory was never read", () => {
		/*
		 * Two enemies claiming the jungle makes `junglerOf` refuse to pick one, so no inventory is
		 * attached. Printing "holding: nothing bought yet" off the role alone would state that a
		 * man at minute 20 owns nothing — a fabrication wearing the block's own authority.
		 */
		const out = renderState(
			base({
				me: { champion: "Lillia", items: [] },
				enemies: [{ champion: "Viego", role: "jungle", level: 13 }]
			})
		)
		strictEqual(out.includes("their jungler"), false)
	})

	it("says nothing about an enemy jungler it could not identify", () => {
		const out = renderState(
			base({ me: { champion: "Lillia", items: [] }, enemies: [{ champion: "Graves", level: 12 }] })
		)
		strictEqual(out.includes("their jungler"), false)
		ok(out.includes("Your items:"), "his own build still stands alone")
	})

	it("gives his health as a percentage and never as a readable number", () => {
		/*
		 * `412/1830 HP` was two mistakes at once: the model is forbidden from doing arithmetic on
		 * the block, so it could not turn the ratio into the thing that gates an aggressive call,
		 * and the raw figure invited a readback of something already on his own HUD.
		 */
		const out = renderState(base({ me: { champion: "Lillia", hp: 412, maxHp: 1830 } }))
		ok(out.includes("23% HP"), `percentage missing: ${out}`)
		strictEqual(out.includes("412"), false, "no raw health to read back")
		strictEqual(out.includes("1830"), false)
	})
})
