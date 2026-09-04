/**
 * The pronunciation guide is edited by hand, mid-session, by someone who just heard a name
 * mangled. So the parser's job is to survive whatever that person types.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { parsePronunciations, pronunciationsFor, renderPronunciations } from "./pronounce.ts"

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
