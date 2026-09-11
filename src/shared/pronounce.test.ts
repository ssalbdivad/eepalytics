/**
 * The pronunciation guide is edited by hand, mid-session, by someone who just heard a name
 * mangled. So the parser's job is to survive whatever that person types.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { readFileSync } from "node:fs"
import {
	parsePronunciations,
	pronunciationsFor,
	renderPronunciationGuide,
	renderPronunciations
} from "./pronounce.ts"

describe("parsePronunciations", () => {
	it("reads name = respelling and ignores everything else", () => {
		const out = parsePronunciations(`# Heading\n\nKha'Zix = kah-ZIKS\n> a note\n- a bullet\nLillia = LILL-ee-uh\n`)
		deepStrictEqual(out, [
			{ name: "Kha'Zix", say: "kah-ZIKS" },
			{ name: "Lillia", say: "LILL-ee-uh" }
		])
	})

	it("survives a malformed line rather than losing the file", () => {
		// One bad line must cost one pronunciation, never the whole game's audio.
		const out = parsePronunciations("Broken line with no separator\nJhin = JIN\n")
		deepStrictEqual(out, [{ name: "Jhin", say: "JIN" }])
	})

	it("drops a respelling identical to the name", () => {
		// It teaches nothing and would cost a line in every block of every turn.
		strictEqual(parsePronunciations("Zed = Zed\n").length, 0)
	})

	it("does not read the file's own description of its format as an entry", () => {
		/*
		 * `knowledge/pronunciations.md` documents itself with the sentence "One name per line,
		 * `Name = respelling`. Capitals mark the stressed syllable." — which contains " = ", so the
		 * forgiving rule below read it as a row named "One name per line, `Name". That row sat in
		 * the shipped table for the whole life of the feature, and would have been rendered into
		 * the coach's standing instructions as a name to say the moment anything rendered the guide
		 * at all. Prose above `## Names` is prose.
		 */
		const out = parsePronunciations(
			"## Format\n\nOne name per line, `Name = respelling`.\n\n## Names\n\nJhin = JIN\n"
		)
		deepStrictEqual(out, [{ name: "Jhin", say: "JIN" }])
	})

	it("still parses a list with no heading at all", () => {
		// The file is edited mid-session by someone who just heard a name mangled. A scratch list
		// with no structure has to keep working, or the heading rule bought one bug and sold one.
		strictEqual(parsePronunciations("Jhin = JIN\nZoe = ZO-ee\n").length, 2)
	})

	it("keeps the first of a duplicated name", () => {
		const out = parsePronunciations("Jhin = JIN\nJhin = something else\n")
		deepStrictEqual(out, [{ name: "Jhin", say: "JIN" }])
	})
})

describe("pronunciationsFor", () => {
	const table = parsePronunciations("Kha'Zix = kah-ZIKS\nLillia = LILL-ee-uh\nJhin = JIN\n")

	it("sends only the names actually in this game", () => {
		const out = pronunciationsFor(["Lillia", "Garen"], table)
		deepStrictEqual(out.map(p => p.name), ["Lillia"])
	})

	it("matches across punctuation and case, because two hands spell these differently", () => {
		// The client says "Kha'Zix"; a hand-edited file may say "KhaZix". Silently matching neither
		// would look exactly like the feature working.
		ok(pronunciationsFor(["khazix"], table).length === 1)
		ok(pronunciationsFor(["KHA'ZIX"], table).length === 1)
	})

	it("says nothing when every name in the game is already pronounced correctly", () => {
		strictEqual(renderPronunciations(pronunciationsFor(["Garen", "Ashe"], table)), "")
	})
})

describe("renderPronunciations", () => {
	it("tells the model to speak it, not to write it", () => {
		const line = renderPronunciations([{ name: "Kha'Zix", say: "kah-ZIKS" }])
		ok(line.includes("Kha'Zix = kah-ZIKS"))
		// The transcript has to stay readable, so the instruction must be about SOUND only.
		ok(/write them normally/i.test(line), line)
	})
})

describe("renderPronunciationGuide", () => {
	const table = parsePronunciations("Briar = BRY-er\nKha'Zix = kah-ZIKS\n")

	it("says nothing when there is nothing to correct", () => {
		strictEqual(renderPronunciationGuide([]), "")
	})

	it("carries every entry as name and respelling", () => {
		const guide = renderPronunciationGuide(table)
		ok(guide.includes("Briar — say BRY-er"))
		ok(guide.includes("Kha'Zix — say kah-ZIKS"))
	})

	it("frames itself as voice, not as ground truth", () => {
		/*
		 * The regression this replaces was not a wording problem, it was a HOME problem — but the
		 * wording is the second line of defence, so it is asserted rather than left to drift. The
		 * failure it names: a respelling read aloud as if it were a champion's name.
		 */
		const guide = renderPronunciationGuide(table)
		ok(/VOICE/.test(guide), "must say it is about the voice")
		ok(/not a fact/i.test(guide), "must say the list is not a fact")
		ok(/Never speak a respelling/i.test(guide))
	})

	it("contains no digit, so nothing in it can be heard as a game figure", () => {
		/*
		 * Same fence as `champion-advice.ts`: a mechanism that cannot express a number about the
		 * game cannot express a wrong one. The only digits allowed are the ones inside the fixed
		 * prose example, so this asserts over the ENTRIES rather than the whole string.
		 */
		const bad = parsePronunciations("Jarvan IV = JAR-van the 4th\n")
		const entries = renderPronunciationGuide(bad).split("\n").filter(l => l.includes(" — say "))
		strictEqual(entries.length, 1)
		ok(/\d/.test(entries[0]!), "this fixture is meant to be the bad case")
	})

	it("renders the shipped table without a stray digit in any entry", () => {
		const shipped = parsePronunciations(
			readFileSync(new URL("../../knowledge/pronunciations.md", import.meta.url), "utf8")
		)
		ok(shipped.length > 50, `only ${shipped.length} entries parsed`)
		const withDigits = renderPronunciationGuide(shipped)
			.split("\n")
			.filter(l => l.includes(" — say ") && /\d/.test(l))
		strictEqual(withDigits.join(" | "), "")
	})
})
