/**
 * The digit rule is the whole fence, so it is tested harder than anything else here.
 *
 * The mechanism this replaces breached within a day: a general benchmark renderer validated the
 * FORM of a rule and never its SUBJECT, so "his flash is usually back in thirty seconds" rendered
 * and was spoken aloud. A mechanism that can express a number about the game can express a wrong
 * one, so this mechanism cannot express a number at all.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import {
	ADVICE_KINDS,
	championAdvice,
	parseAdviceVariants,
	parseChampionAdvice,
	withAdvice
} from "./champion-advice.ts"
import type { AdviceKind } from "./champion-advice.ts"

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

describe("variants and rotation", () => {
	it("keeps every clause a file offers for one kind", () => {
		const v = parseAdviceVariants(wrap("death: no dash\ndeath: no blink\nbuild: read the item"))
		deepStrictEqual(v.death, ["no dash", "no blink"])
	})

	it("rotates between them, so a kind that fires twice does not rhyme", () => {
		const md = wrap("farm-behind: finish the route\nfarm-behind: the skipped camp is the speed")
		strictEqual(parseChampionAdvice(md, 0)["farm-behind"], "finish the route")
		strictEqual(parseChampionAdvice(md, 1)["farm-behind"], "the skipped camp is the speed")
		// Same index, same clause: a single turn must not depend on which fact asked first.
		strictEqual(parseChampionAdvice(md, 2)["farm-behind"], "finish the route")
	})

	it("defaults to the first clause, which is what every caller had before", () => {
		const md = wrap("death: no dash\ndeath: no blink")
		strictEqual(parseChampionAdvice(md).death, "no dash")
	})

	it("survives a clock that is negative, fractional or not a number", () => {
		const md = wrap("death: no dash\ndeath: no blink")
		strictEqual(parseChampionAdvice(md, -1).death, "no blink")
		strictEqual(parseChampionAdvice(md, 1.7).death, "no blink")
		strictEqual(parseChampionAdvice(md, Number.NaN).death, "no dash")
	})

	it("still drops a clause with a digit while keeping its siblings", () => {
		const v = parseAdviceVariants(wrap("death: no dash\ndeath: speed is gone past level 6"))
		deepStrictEqual(v.death, ["no dash"])
	})
})

describe("championAdvice", () => {
	const champ = wrap("death: you have no dash")
	const role = wrap("death: pick the timer you walk to\nfarm-behind: run the route to the end")

	it("prefers the champion clause and fills the bare kinds from the role default", () => {
		const a = championAdvice(champ, role)
		strictEqual(a.death, "you have no dash")
		strictEqual(a["farm-behind"], "run the route to the end")
	})

	it("is the role default alone when the champion file has no live section", () => {
		// leesin, trundle and belveth were all in this state, so all three silently had NO champion
		// knowledge live rather than falling back to the role.
		deepStrictEqual(championAdvice("# Lee Sin\n\nprose only", role), {
			death: "pick the timer you walk to",
			"farm-behind": "run the route to the end"
		})
	})

	it("is empty when there is neither, rather than throwing", () => {
		deepStrictEqual(championAdvice(null, null), {})
	})
})

/*
 * The shipped files, read off disk.
 *
 * Knowledge the parser silently drops is worse than none, because it looks like progress: a clause
 * with a digit in it is refused at load time and nothing anywhere says so. These tests are the
 * thing that says so.
 */
const KNOWLEDGE = resolve(dirname(fileURLToPath(import.meta.url)), "../../knowledge/champions")
const noteText = (file: string): string => {
	const raw = readFileSync(join(KNOWLEDGE, file), "utf8")
	const split = raw.indexOf("\n---")
	return split === -1 ? raw : raw.slice(split + 4)
}
const shipped = readdirSync(KNOWLEDGE).filter(f => f.endsWith(".md"))

describe("the shipped knowledge files", () => {
	it("has notes on disk to check", () => {
		ok(shipped.includes("lillia.md"))
		ok(shipped.includes("_default.md"))
	})

	for (const file of shipped)
		describe(file, () => {
			const text = noteText(file)

			it("has a Live coaching section", () => {
				ok(text.includes("## Live coaching"), `${file} would contribute nothing to the live coach`)
			})

			it("loses no clause to the digit rule", () => {
				const variants = parseAdviceVariants(text)
				const loaded = Object.values(variants).reduce((n, v) => n + v.length, 0)
				// Every line that LOOKS like a clause, whether or not it survived.
				const written = text
					.slice(text.indexOf("## Live coaching"))
					.split("\n")
					.filter(l => ADVICE_KINDS.some(k => l.trim().startsWith(`${k}:`))).length
				strictEqual(loaded, written, `${file}: ${written - loaded} clause(s) refused, probably for a digit`)
			})

			it("offers more than one clause wherever it speaks at all", () => {
				// One clause per kind means the identical half-sentence every time that kind fires,
				// which is the sameness the coach was quit over.
				for (const [kind, v] of Object.entries(parseAdviceVariants(text)))
					ok(v.length > 1, `${file}: ${kind} has a single clause and will repeat verbatim`)
			})
		})

	it("covers every kind for every champion once the role default is merged", () => {
		const role = noteText("_default.md")
		for (const file of shipped) {
			const a = championAdvice(noteText(file), role)
			for (const kind of ADVICE_KINDS)
				ok(a[kind], `${file}: ${kind} is bare even after the role default`)
		}
	})

	it("reaches a spoken sentence — the real Lillia note, a real fact kind", () => {
		// The end-to-end assertion: file on disk -> parser -> the sentence the socket says.
		const advice = championAdvice(noteText("lillia.md"), noteText("_default.md"))
		const line = withAdvice("Kayn is 23 CS up on you", advice["race-behind"])
		ok(line.startsWith("Kayn is 23 CS up on you — "), line)
		ok(line.length > "Kayn is 23 CS up on you — ".length + 20, line)
		// The number is still the client's, and the advice still carries none of its own.
		strictEqual(/\d/.test(line.slice(line.indexOf(" — "))), false, line)
	})

	it("says something about his own death with no number in it at all", () => {
		// `death` is spoken ALONE, on the respawn screen — there is no fact in front of it, so the
		// clause has to stand up as a whole sentence by itself.
		const advice = championAdvice(noteText("lillia.md"), noteText("_default.md"))
		const clause = advice.death!
		ok(clause.length > 30, clause)
		strictEqual(/\d/.test(clause), false, clause)
	})

	it("gives a different clause a minute later, for every kind Lillia speaks to", () => {
		const text = noteText("lillia.md")
		for (const [kind, v] of Object.entries(parseAdviceVariants(text))) {
			const seen = new Set<string>()
			for (let minute = 0; minute < v.length; minute++)
				seen.add(parseChampionAdvice(text, minute)[kind as AdviceKind]!)
			strictEqual(seen.size, v.length, `lillia.md: ${kind} did not rotate through all of its clauses`)
		}
	})
})
