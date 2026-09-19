/**
 * The three copies of `championKey`, checked against each other rather than asserted to agree.
 *
 * Two of the three were collapsed into `champion-key.ts` on 2026-09-19 after their source text was
 * verified byte-identical. The third — `scripts/fetch-champions.ts`'s private one — stays, because
 * the generator must not import from the tree it generates into, and its comment says so. A comment
 * is not a check, and nothing anywhere tested one copy against another, so the two cases below do
 * it: one on the SOURCE the generator still carries, one on the 173 keys it actually produced.
 *
 * The output case is the stronger of the two. It compares this function to what the generator
 * really wrote on 173 real champion names rather than to a regex match on a line of its source, so
 * a divergence that a reword hides still fails it.
 *
 * NODE-ONLY test of a browser-safe module: it reads `scripts/fetch-champions.ts` off disk and
 * imports the 2.9 MB generated table. Neither reaches `champion-key.ts` itself, which imports
 * nothing.
 */

import { ok, strictEqual } from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { CHAMPION_ROWS } from "../knowledge/champion-table.ts"
import { championKey } from "./champion-key.ts"

const HERE = dirname(fileURLToPath(import.meta.url))

describe("championKey", () => {
	it("normalises the spellings Riot actually returns", () => {
		strictEqual(championKey("Bel'Veth"), "belveth")
		strictEqual(championKey("Dr. Mundo"), "drmundo")
		strictEqual(championKey("Nunu & Willump"), "nunuwillump")
		strictEqual(championKey("Lillia"), "lillia")
		// The apiname and the display name have to land on the same key or the join fails.
		strictEqual(championKey("Belveth"), championKey("Bel'Veth"))
		strictEqual(championKey("Nunu"), "nunu")
	})

	/*
	 * Digits are stripped along with the punctuation, which is safe only while no champion's name
	 * carries an Arabic numeral. It is written down here rather than in a comment alone because the
	 * day Riot ships one, this case is what will be read.
	 */
	it("strips digits too, so a roman numeral survives and an Arabic one would not", () => {
		strictEqual(championKey("Jarvan IV"), "jarvaniv")
		strictEqual(championKey("Jarvan 4"), "jarvan")
	})

	/*
	 * `""` is a sentinel the callers read: `championContext()` returns null on it rather than
	 * reading `champions/.md`, and `roleContext()` does the same. It is not a degenerate case.
	 */
	it("yields the empty string for a name with no letters, rather than throwing", () => {
		strictEqual(championKey(""), "")
		strictEqual(championKey("???"), "")
		strictEqual(championKey("  "), "")
	})
})

describe("the copy the generator keeps", () => {
	/*
	 * `scripts/fetch-champions.ts` writes `champion-table.ts`, whose `key` column is this
	 * function's output, so it depends on nothing in `src/` for it. This is the check that stops
	 * that independence from drifting into disagreement.
	 */
	it("is still byte-identical to the shared one", () => {
		const body = (path: string): string => {
			const m = readFileSync(resolve(HERE, path), "utf8").match(
				/championKey = \(name: string\): string => (.+)$/m
			)
			ok(m, `no championKey definition in ${path}`)
			return m[1]!
		}
		strictEqual(body("../../scripts/fetch-champions.ts"), body("./champion-key.ts"))
	})

	it("produced every key in the committed table from the champion's own name", () => {
		const wrong = CHAMPION_ROWS.filter(r => r.key !== championKey(r.name)).map(r => `${r.name} -> ${r.key}`)
		strictEqual(wrong.join(", "), "")
		// The check is only worth running because the names are not already keys. Measured on the
		// committed 16.18.1 table: 173 rows, every one of them exercising the lowercasing, and 19
		// — `Bel'Veth`, `Dr. Mundo`, `Nunu & Willump`, `Jarvan IV`, `Kai'Sa` and the rest —
		// carrying a character the strip actually removes.
		ok(CHAMPION_ROWS.length > 150, `only ${CHAMPION_ROWS.length} champions`)
		const stripped = CHAMPION_ROWS.filter(r => /[^A-Za-z]/.test(r.name))
		ok(stripped.length >= 19, `only ${stripped.length} names exercise the strip`)
	})
})
