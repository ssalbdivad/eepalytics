/**
 * `baseline-mismatch` — the check for a number that is real but belongs to another metric.
 *
 * Observed in a shipped review: elite control was reported as "right around your own 45.9%
 * baseline". 45.9 was kill participation's average; elite control's was 48.66. A presence-only
 * check passes that, because 45.9 really was in the digest.
 */

import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { buildReview } from "./parse.ts"
import type { CitationAllowlist } from "./digest-contract.ts"

const allowed: CitationAllowlist = {
	momentIds: new Set(["m1"]),
	metricKeys: new Set(["eliteControlPct", "killParticipation"]),
	baselineByMetric: new Map([
		["eliteControlPct", new Set(["48.66", "33.55", "20"])],
		["killParticipation", new Set(["45.9", "20.21", "20"])]
	]),
	baselineFigures: new Set(["48.66", "33.55", "45.9", "20.21", "20"])
}

const review = (body: string, metricKeys: string[]) =>
	buildReview({
		raw: {
			headline: "h",
			encouragement: "e",
			items: [{ title: "t", body, severity: "minor", category: "objectives", tSec: 10, momentIds: ["m1"], metricKeys }],
			goals: ["g"]
		},
		kind: "game",
		gameId: 1,
		model: "m",
		promptHash: "p",
		allowed
	})

const codes = (r: ReturnType<typeof review>) => r.warnings.map(w => w.code)

describe("baseline-mismatch", () => {
	it("flags another metric's average quoted as this one's", () => {
		const r = review("Elite control landed at 44.4%, right around your own 45.9% baseline.", ["eliteControlPct"])
		ok(codes(r).includes("baseline-mismatch"))
		const msg = r.warnings.find(w => w.code === "baseline-mismatch")!.message
		ok(msg.includes("killParticipation"), `should name the owning metric: ${msg}`)
	})

	it("accepts the cited metric's own average", () => {
		const r = review("Elite control landed at 44.4%, under your 20-game average 48.66%.", ["eliteControlPct"])
		ok(!codes(r).includes("baseline-mismatch"))
	})

	it("accepts a figure once the item cites the metric it belongs to", () => {
		const r = review("Your usual 45.9% kill participation held up.", ["killParticipation"])
		ok(!codes(r).includes("baseline-mismatch"))
	})

	it("flags a baseline figure that is in no metric at all", () => {
		const r = review("Well under your usual 61.2% there.", ["eliteControlPct"])
		const w = r.warnings.find(x => x.code === "baseline-mismatch")
		ok(w, "expected a warning")
		ok(w!.message.includes("no metric's baseline"))
	})

	it("ignores numbers that are not baseline claims", () => {
		const r = review("You died at 812 gold and gave up 4 objectives.", ["eliteControlPct"])
		ok(!codes(r).includes("baseline-mismatch"))
	})

	it("keeps the item — this is a warning, not a drop", () => {
		const r = review("Right around your own 45.9% baseline.", ["eliteControlPct"])
		ok(r.ok)
		strictEqual(r.ok && r.value.items.length, 1)
	})
})

/**
 * Regression cases taken verbatim from real reviews. The first version of this check flagged
 * three figures per review that were not baselines at all — clock digits, and this-game values
 * standing just before a baseline cue. A check that cries wolf gets switched off.
 */
describe("baseline-mismatch — false positives from real reviews", () => {
	const withMetrics = (body: string, keys: string[]) => {
		const r = buildReview({
			raw: {
				headline: "h",
				encouragement: "e",
				items: [{ title: "t", body, severity: "minor", category: "tempo", tSec: 10, momentIds: ["m1"], metricKeys: keys }],
				goals: ["g"]
			},
			kind: "game",
			gameId: 1,
			model: "m",
			promptHash: "p",
			allowed: {
				momentIds: new Set(["m1"]),
				metricKeys: new Set(["eliteControlPct", "elitesSecuredByUser", "csDelta@20"]),
				baselineByMetric: new Map([
					["eliteControlPct", new Set(["48.2"])],
					["elitesSecuredByUser", new Set(["3"])],
					["csDelta@20", new Set(["-7.8"])]
				]),
				baselineFigures: new Set(["48.2", "3", "-7.8"])
			}
		})
		return r.warnings.filter(w => w.code === "baseline-mismatch").map(w => w.message)
	}

	it("does not flag a clock time", () => {
		// "10:00" contributed a bare "00" under the old cue-radius rule
		const w = withMetrics("Your own average at 10:00 is 3 elites.", ["elitesSecuredByUser"])
		strictEqual(w.length, 0, w.join(" | "))
	})

	it("does not flag this game's value sitting before a baseline cue", () => {
		const w = withMetrics(
			"You were ahead on CS diff at 20 (+7, when your average there is -7.8).",
			["csDelta@20"]
		)
		strictEqual(w.length, 0, w.join(" | "))
	})

	it("does not flag this game's value in a versus construction", () => {
		const w = withMetrics(
			"Your team took 54.5% of everything contested versus your usual 48.2%.",
			["eliteControlPct"]
		)
		strictEqual(w.length, 0, w.join(" | "))
	})

	it("still catches the possessive form the coach actually writes", () => {
		// "against your own 2692g average" — the figure precedes the cue word
		const w = withMetrics("You handed over 4650g, against your own 2692g average.", ["eliteControlPct"])
		strictEqual(w.length, 1, w.join(" | "))
		ok(w[0]!.includes("2692"))
	})

	it("catches 'your own average there is only X'", () => {
		const w = withMetrics("Down 1593 XP, and your own average there is only -283.", ["csDelta@20"])
		strictEqual(w.length, 1, w.join(" | "))
		ok(w[0]!.includes("-283"))
	})

	/**
	 * The digest prints "2692.1gold"; the coach wrote "2692g". That is the same measurement with
	 * one fewer decimal, and flagging it trains the reader to ignore the warning. Changing the
	 * VALUE is what hard rule 4 is about.
	 */
	it("accepts a faithful quote that drops a decimal", () => {
		const r = buildReview({
			raw: {
				headline: "h",
				encouragement: "e",
				items: [{ title: "t", body: "against your own 2692g average, and your usual -283 xp", severity: "minor", category: "deaths", tSec: 1, momentIds: [], metricKeys: ["goldLostToDeaths", "xpDelta@14"] }],
				goals: ["g"]
			},
			kind: "game",
			gameId: 1,
			model: "m",
			promptHash: "p",
			allowed: {
				momentIds: new Set<string>(),
				metricKeys: new Set(["goldLostToDeaths", "xpDelta@14"]),
				baselineByMetric: new Map([
					["goldLostToDeaths", new Set(["2692.1", "1555.2"])],
					["xpDelta@14", new Set(["-283.3", "919.5"])]
				]),
				baselineFigures: new Set(["2692.1", "1555.2", "-283.3", "919.5"])
			}
		})
		strictEqual(r.warnings.filter(w => w.code === "baseline-mismatch").length, 0)
	})

	it("still rejects a value changed rather than shortened", () => {
		const w = withMetrics("versus your usual 52%.", ["eliteControlPct"])
		strictEqual(w.length, 1, w.join(" | "))
	})
})

describe("baseline-mismatch — the gap between cue and figure", () => {
	const check = (body: string) =>
		buildReview({
			raw: {
				headline: "h",
				encouragement: "e",
				items: [{ title: "t", body, severity: "minor", category: "vision", tSec: 1, momentIds: [], metricKeys: ["visionPerMin"] }],
				goals: ["g"]
			},
			kind: "game",
			gameId: 1,
			model: "m",
			promptHash: "p",
			allowed: {
				momentIds: new Set<string>(),
				metricKeys: new Set(["visionPerMin"]),
				baselineByMetric: new Map([["visionPerMin", new Set(["0.8"])]]),
				baselineFigures: new Set(["0.8"])
			}
		}).warnings.filter(w => w.code === "baseline-mismatch")

	it("does not read across a clause boundary", () => {
		// Real prose. "40" is the game length, not a baseline, but sat 28 chars after "baseline".
		const w = check("A step down from your baseline in a game that went nearly 40 minutes.")
		strictEqual(w.length, 0, w.map(x => x.message).join(" | "))
	})

	it("still matches through ordinary filler", () => {
		strictEqual(check("Your own 20-game average is 0.8 vision score per minute.").length, 0)
		strictEqual(check("Your average there is only 0.8.").length, 0)
		strictEqual(check("Your own average sits at 0.9.").length, 1)
	})
})

/**
 * The warning has to reach the READER, not just the daemon log.
 *
 * A wrong baseline reads exactly like a right one, so logging it server-side and rendering the
 * figure unmarked is the wrong half of the "warn, don't drop" trade. These pin that the message
 * rides on the item itself.
 */
describe("baseline warnings are carried on the item", () => {
	const build = (body: string, metricKeys: string[]) =>
		buildReview({
			raw: {
				headline: "h",
				encouragement: "e",
				items: [{ title: "t", body, severity: "minor", category: "deaths", tSec: 5, momentIds: ["m1"], metricKeys }],
				goals: ["g"]
			},
			kind: "game",
			gameId: 1,
			model: "m",
			promptHash: "p",
			allowed: {
				momentIds: new Set(["m1"]),
				metricKeys: new Set(["goldSwingAfterDeath90s"]),
				baselineByMetric: new Map([["goldSwingAfterDeath90s", new Set(["-325.8"])]]),
				baselineFigures: new Set(["-325.8"])
			}
		})

	it("attaches the message to the item the reader will see", () => {
		// The real case: the digest said -325.8 and the review said -423.
		const r = build("Swings averaged -1101g against your own 19-game average of -423g.", [
			"goldSwingAfterDeath90s"
		])
		ok(r.ok)
		const item = r.ok ? r.value.items[0]! : null
		ok(item?.warnings && item.warnings.length === 1, "item should carry exactly one warning")
		ok(item!.warnings![0]!.includes("-423"))
	})

	it("leaves the item unmarked when the baseline was copied correctly", () => {
		const r = build("Swings averaged -1101g against your own 19-game average of -325.8g.", [
			"goldSwingAfterDeath90s"
		])
		ok(r.ok)
		const item = r.ok ? r.value.items[0]! : null
		strictEqual(item?.warnings?.length ?? 0, 0)
	})

	it("keeps the item either way — a marked item is still coaching", () => {
		const r = build("Your own average of -423g there.", ["goldSwingAfterDeath90s"])
		strictEqual(r.ok && r.value.items.length, 1)
	})
})
