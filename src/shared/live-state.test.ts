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
import { csGap, csGapWorthSaying, csPhrase, renderState } from "../shared/live-state.ts"
import type { VisionState } from "../shared/live-state.ts"

const base = (over: Partial<VisionState> = {}): VisionState => ({
	clock: "14:30",
	me: { champion: "Lillia", level: 11, k: 3, d: 2, a: 4, cs: 120, gold: 1450 },
	pace: null,
	counterpart: null,
	pronounce: [],
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

/**
 * The counterpart line went missing once, silently: the edit that added it did not match, nothing
 * asserted it, and the block shipped without the app's single most valuable comparison for hours.
 * The ranked facts still worked, which is exactly why nobody noticed.
 */
describe("the enemy jungler line", () => {
	it("is in the block whenever a counterpart is known", () => {
		const out = renderState(base({ counterpart: { champion: "Karthus", level: 15, ward: 23.2 } }))
		ok(out.includes("Enemy jungler right now: Karthus"), out.slice(0, 400))
		ok(out.includes("level 15"))
		ok(out.includes("ward score 23.2"))
	})

	it("says the role is a guess when it came from Smite", () => {
		const out = renderState(
			base({ counterpart: { champion: "Karthus", level: 15, inferred: true } })
		)
		ok(/strong guess/i.test(out), "an inferred role must be hedged in the sentence")
	})

	it("states that an enemy's gold is not knowable, so the gap cannot be filled", () => {
		// A gap gets filled: with the enemy's level present and gold absent, the coach attributed
		// HIS gold to the enemy out loud.
		const out = renderState(base({ counterpart: { champion: "Karthus", level: 15 } }))
		ok(/gold is not listed and is not knowable/i.test(out))
	})

	/*
	 * The counterpart's FARM is gone, and its absence is asserted rather than assumed.
	 *
	 * The feed reports an enemy jungler's `creepScore` as a count of what this player's own client
	 * witnessed: 70 against a true 183 over one audited game, exact at 2 of 29 checkpoints, and the
	 * source of "you are at least 91 CS up on Kayn" said to a man 18 CS behind. A block that leaves
	 * the number out without saying why leaves a gap, and a model fills a gap — so the payload
	 * carries the refusal.
	 */
	it("never puts a CS figure next to the enemy jungler, and says why it is missing", () => {
		const out = renderState(base({ counterpart: { champion: "Karthus", level: 15, ward: 23.2 } }))
		const line = out.split("\n").find(l => l.startsWith("Enemy jungler right now:")) ?? ""
		ok(line !== "", out.slice(0, 400))
		strictEqual(/\d+\s*CS/.test(line.split("HIS FARM IS NOT LISTED")[0] ?? ""), false, line)
		ok(/read 70 where the truth was 183/.test(line), "the refusal states its own measurement")
	})

	it("says nothing at all when there is no counterpart", () => {
		strictEqual(renderState(base({ counterpart: null })).includes("Enemy jungler right now"), false)
	})
})

/**
 * The client reports CS in tens and rounds DOWN — 12210 readings across four real games, not one
 * of them a non-multiple of ten, and two journal frames settle the direction (HUD 16 against a
 * block of 10 at 02:42, HUD 46 against a block of 40 at 06:43). Every test below is about the
 * consequence: a reported figure is a floor, and the app may say only what a floor supports.
 */
describe("the CS quantum", () => {
	it("says a floored figure as a lower bound, never as the number", () => {
		strictEqual(csPhrase(120), "at least 120 CS")
	})

	it("gives zero its own wording, because that is the one that was said out loud", () => {
		// "BRY-er is still at 0 CS" reached the player about a jungler who had up to nine.
		strictEqual(csPhrase(0), "under 10 CS")
	})

	it("refuses to call him behind when the whole gap fits inside the rounding", () => {
		/*
		 * The bias that produced the farm nagging: a floored live figure minus an exact historical
		 * mean is understated by up to nine, always in the same direction. Measured over the 107
		 * baseline-carrying checkpoints of fixture-5635467422, 104 read as behind and 21 of those
		 * had a gap of nine or less — states where he may have been level or ahead.
		 */
		const g = csGap(40, 46, false)
		strictEqual(g.direction, "level")
		strictEqual(g.certain, 0)
		strictEqual(csGapWorthSaying(g), false)
	})

	it("keeps only the part of a baseline gap that survives the rounding", () => {
		const g = csGap(120, 141, false)
		strictEqual(g.direction, "behind")
		strictEqual(g.certain, 12, "21 reported, but nine of it is rounding")
		strictEqual(csGapWorthSaying(g), true)
	})

	it("widens the interval at both ends when the other figure is floored too", () => {
		// Both junglers come off the same client, so a reported 20 is a true 11 to 29.
		const g = csGap(120, 140, true)
		strictEqual(g.low, -29)
		strictEqual(g.high, -11)
		strictEqual(g.certain, 11)
	})

	it("treats a one-quantum lead as not worth a sentence", () => {
		/*
		 * A reported ten-CS gap between the two junglers is a true gap of one to nineteen, so the
		 * certain part of it is ONE. Saying that is the four-CS farm nag with a new subject, which
		 * is what RACE_MIN_GAP exists to suppress — and on 612 real blocks every reported race gap
		 * was a multiple of ten, so this is the smallest gap that can ever be reported at all.
		 */
		const g = csGap(110, 100, true)
		strictEqual(g.direction, "ahead")
		strictEqual(g.certain, 1)
		strictEqual(csGapWorthSaying(g), false)
	})
})

describe("the block never states a CS it cannot support", () => {
	const withFarm = (over: Partial<VisionState> = {}): string =>
		renderState(
			base({
				me: { champion: "Lillia", level: 11, k: 3, d: 2, a: 4, cs: 120, gold: 1450 },
				...over
			})
		)

	it("renders his own farm as a floor", () => {
		const out = withFarm()
		const you = out.split("\n").find(l => l.startsWith("You: ")) ?? ""
		ok(you.includes("at least 120 CS"), "his CS must be hedged as the floor it is")
		strictEqual(you.includes(", 120 CS"), false, "no bare CS count on the You line")
	})

	it("renders no farm for the enemy jungler at all, at any value", () => {
		const out = withFarm({ counterpart: { champion: "Briar", level: 12, ward: 9.4 } })
		strictEqual(/Briar[^\n]*\d+ CS/.test(out), false, "the witness counter is not a farm figure")
		ok(/Do not compare their farm/.test(out))
	})

	it("states the certain part of the pace gap, not the reported one", () => {
		const out = withFarm({
			pace: { cs: 120, expected: 141, exact: true, source: "your 14-minute average over 20 games" }
		})
		ok(out.includes("at least 12 CS BEHIND his own average"), out.slice(0, 900))
		strictEqual(out.includes("21 CS"), false, "the biased subtraction must not appear anywhere")
	})

	it("refuses to call him off his pace when the gap is inside the rounding", () => {
		/*
		 * The single most valuable line here. This is the state the coach used to scold him in, and
		 * a fifth of the baseline-carrying states measured were this state.
		 */
		const out = withFarm({
			pace: { cs: 120, expected: 126, exact: true, source: "your 14-minute average over 20 games" }
		})
		ok(/neither measurably ahead nor behind/.test(out))
		ok(/Do not say he is either/.test(out))
	})

	it("tells the model the grain, since it is the model that has to phrase it", () => {
		ok(/Every CS figure above is a FLOOR/.test(withFarm()))
	})
})
