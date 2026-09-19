/**
 * The classifier behind the ONE number in `persona-ab.ts` that has no model in it.
 *
 * The A/B's primary claim is a SHARE — what fraction of a review's items are about the 10:00-15:00
 * death window or the early objective ledger — so the whole claim rests on `classify` agreeing with
 * what the prompt under test actually asks for. The fixtures below are therefore not invented
 * items: they are the worked examples written into Part 2 of `AGENTS.md` itself, copied with their
 * own category and `tSec`. If the classifier disagrees with the persona's own examples of the thing
 * it is asking for, the share is measuring something else.
 *
 * Example E is the case that earns its place. "Drake at 14:12 while you took bot plates" is an
 * `objectives` item and it is NOT the early ledger — the measured row is the ledger BY 10:00 — so a
 * classifier that counted every objectives item would score the OLD arm as on-target for coaching
 * a drake at 14:12 and the number would mean nothing.
 *
 * Run: node --experimental-strip-types --test scripts/persona-ab.test.ts
 */

import { equal } from "node:assert/strict"
import { test } from "node:test"
import { classify, EARLY_HI, PATTERNS, WINDOW_HI, WINDOW_LO } from "./persona-ab.ts"

const item = (over: Partial<Parameters<typeof classify>[0]>) =>
	classify(
		{
			title: "",
			fix: "",
			body: "",
			severity: "minor",
			category: "deaths",
			impact: "medium",
			actionability: "medium",
			confidence: "high",
			tSec: null,
			momentIds: [],
			metricKeys: [],
			...over
		},
		MOMENTS,
		"test",
		1,
		0
	)

/** Ids in the shape the analysis writes them: `g<gameId>-<kind>-<tSec>`. */
const MOMENTS = [
	{ id: "g1-death-700", tSec: 700, kind: "death" },
	{ id: "g1-death-1500", tSec: 1500, kind: "death" },
	{ id: "g1-objective-300", tSec: 300, kind: "objective" }
]

test("the persona's own example D — a deaths item inside the window — is on target", () => {
	const it = item({
		category: "deaths",
		tSec: 738,
		title: "Two deaths between 10:00 and 15:00, both in the top river"
	})
	equal(it.windowDeath, true)
	equal(it.onTarget, true)
})

test("the persona's own example B — the ledger before 10:00 — is on target", () => {
	const it = item({
		category: "objectives",
		tSec: 512,
		title: "Their side of the ledger: both grub sets and drake before 10:00"
	})
	equal(it.earlyObjective, true)
	equal(it.onTarget, true)
})

test("the persona's own example E — an objectives item at 14:12 — is NOT the early ledger", () => {
	const it = item({ category: "objectives", tSec: 852, title: "Drake at 14:12 while you took bot plates" })
	equal(it.earlyObjective, false)
	equal(it.onTarget, false)
})

test("praise late in the game is on neither target", () => {
	const it = item({ category: "praise", tSec: 1920 })
	equal(it.onTarget, false)
})

test("a cited moment supplies the clock when the item carries no tSec", () => {
	const it = item({ category: "deaths", tSec: null, momentIds: ["g1-death-700"] })
	equal(it.anchors.includes(700), true)
	equal(it.windowDeath, true)
})

test("a cited id the digest does not hold contributes no anchor and cannot fake a hit", () => {
	const it = item({ category: "deaths", tSec: null, momentIds: ["g1-death-9999"] })
	equal(it.anchors.length, 0)
	equal(it.windowDeath, false)
})

test("the window is half-open at the top, the same convention what-wins.ts measured on", () => {
	equal(item({ category: "deaths", tSec: WINDOW_LO }).windowDeath, true)
	equal(item({ category: "deaths", tSec: WINDOW_HI - 1 }).windowDeath, true)
	equal(item({ category: "deaths", tSec: WINDOW_HI }).windowDeath, false)
	equal(item({ category: "objectives", tSec: EARLY_HI }).earlyObjective, true)
	equal(item({ category: "objectives", tSec: EARLY_HI + 1 }).earlyObjective, false)
})

test("a deaths item in the window stays a deaths item — the category is required, not inferred", () => {
	equal(item({ category: "tempo", tSec: 700 }).windowDeath, false)
	equal(item({ category: "tempo", tSec: 300 }).earlyObjective, false)
})

/*
 * The keyword patterns are SECONDARY evidence and this pins them against real lines the run
 * produced, so a later edit to a regex cannot silently change a count that was already reported.
 * Both strings below are verbatim item titles this harness produced on real games of his.
 */
test("the unspent-gold pattern fires on the line the re-aim was written against", () => {
	equal(PATTERNS.unspentGold.test("Died at 15:11 sitting on 2,070 unspent gold"), true)
	equal(PATTERNS.unspentGold.test("Collapsed on at 14:43 in your own bot jungle"), false)
})

test("the enemy-jungle pattern catches both spellings of the place and neither his own half nor the man", () => {
	equal(PATTERNS.enemyJungle.test("Caught at 16:53 in enemy blue jungle with 1024g"), true)
	equal(PATTERNS.enemyJungle.test("Caught at 16:53 in the enemy blue-side jungle"), true)
	equal(PATTERNS.enemyJungle.test("Died in their red jungle"), true)
	// His own half is not the withdrawn advice, and neither is naming the counterpart.
	equal(PATTERNS.enemyJungle.test("Collapsed on at 14:43 in your own bot jungle"), false)
	equal(PATTERNS.enemyJungle.test("The enemy jungler was level 6 before you"), false)
})
