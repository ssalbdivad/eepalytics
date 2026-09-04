/**
 * The digit rule is the whole fence, so it is tested harder than anything else here.
 *
 * The mechanism this replaces breached within a day: a general benchmark renderer validated the
 * FORM of a rule and never its SUBJECT, so "his flash is usually back in thirty seconds" rendered
 * and was spoken aloud. A mechanism that can express a number about the game can express a wrong
 * one, so this mechanism cannot express a number at all.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { parseChampionAdvice, withAdvice } from "./champion-advice.ts"

const wrap = (body: string): string => `intro prose\n\n## Live coaching\n\n${body}\n\n## After\n\nmore`

describe("parseChampionAdvice", () => {
	it("reads clauses for the kinds it knows", () => {
		const a = parseChampionAdvice(wrap("race-behind: finish the route you started\ndeath: you have no dash"))
		deepStrictEqual(a, { "race-behind": "finish the route you started", death: "you have no dash" })
	})

	it("REJECTS any clause containing a digit", () => {
		// The benchmark vector, in both of its shapes.
		const a = parseChampionAdvice(wrap("race-behind: a good Lillia finishes by 3:15\nrestraint: his flash is back in 30 seconds"))
		deepStrictEqual(a, {})
	})

	it("rejects a digit anywhere in the clause, not just at the start", () => {
		strictEqual(parseChampionAdvice(wrap("death: speed will not save you past level 6")).death, undefined)
	})

	it("ignores kinds it does not know, rather than trusting the file", () => {
		strictEqual(Object.keys(parseChampionAdvice(wrap("ward-score: place more wards"))).length, 0)
	})

	it("survives a malformed line, losing only that clause", () => {
		const a = parseChampionAdvice(wrap("this line has no separator\nbuild: itemise into what they built"))
		deepStrictEqual(a, { build: "itemise into what they built" })
	})

	it("stops at the next heading so it cannot swallow the file", () => {
		const md = "## Live coaching\n\nrace-behind: keep the route going\n\n## Other\n\ndeath: should not load"
		strictEqual(parseChampionAdvice(md).death, undefined)
	})

	it("returns nothing when the section is absent", () => {
		deepStrictEqual(parseChampionAdvice("# Notes\n\nprose only"), {})
	})
})

describe("withAdvice", () => {
	it("puts the number first and the advice second", () => {
		strictEqual(
			withAdvice("Kayn is 23 CS up on you.", "finish the route you started"),
			"Kayn is 23 CS up on you — finish the route you started"
		)
	})

	it("drops a generic tail rather than stacking two instructions", () => {
		// The fight module's lines close on their own advice; the champion clause is the better of
		// the two, and one breath does not hold both.
		strictEqual(
			withAdvice(
				"that fight was 0 for 2 without you, so back off and catch up",
				"get on the map before the next one starts"
			),
			"that fight was 0 for 2 without you — get on the map before the next one starts"
		)
	})

	it("keeps a fact that merely contains the word so", () => {
		strictEqual(
			withAdvice("Kayn is 23 CS up on you", "finish the route"),
			"Kayn is 23 CS up on you — finish the route"
		)
	})

	it("returns the fact untouched when the champion has no note", () => {
		strictEqual(withAdvice("Kayn is 23 CS up on you", undefined), "Kayn is 23 CS up on you")
	})
})
