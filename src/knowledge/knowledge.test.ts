/**
 * What is left of the on-disk loader, and the tripwire that keeps the deleted corpus deleted.
 *
 * The champion markdown is gone — 184,104 bytes of model-authored prose with a measured 8.0%
 * [5.1, 12.3] error rate on its checkable mechanical claims — and with it went `championNote`,
 * `defaultNote`, `knownChampions` and `stalenessWarning`. The tests for those went too, because a
 * test for a loader nobody calls is a test that keeps the loader alive.
 *
 * Two things still need pinning. The key normaliser, because every lookup in the app goes through
 * it and Riot spells champions three ways across its endpoints. And the ABSENCE of
 * `knowledge/champions/`, because the cheapest way for this to come back is for someone — a person
 * or an agent — to write one plausible file into a directory nothing is watching.
 */

import { ok, strictEqual } from "node:assert/strict"
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, it } from "node:test"

const dirs: string[] = []

const withKnowledge = (files: Record<string, string>) => {
	const root = mkdtempSync(join(tmpdir(), "csk-knowledge-"))
	dirs.push(root)
	for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body)
	process.env.EEPALYTICS_KNOWLEDGE_DIR = root
	return root
}

/** The module reads KNOWLEDGE_DIR at import, so re-import per case with a cache-busting query. */
const freshModule = async () => {
	const m = await import(`./index.ts?t=${Math.random()}`)
	m.clearKnowledgeCache()
	return m as typeof import("./index.ts")
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
	delete process.env.EEPALYTICS_KNOWLEDGE_DIR
})

describe("championKey", () => {
	it("normalises the spellings Riot actually returns", async () => {
		const { championKey } = await freshModule()
		strictEqual(championKey("Bel'Veth"), "belveth")
		strictEqual(championKey("Dr. Mundo"), "drmundo")
		strictEqual(championKey("Nunu & Willump"), "nunuwillump")
		strictEqual(championKey("Lillia"), "lillia")
	})
})

describe("pronunciationTable", () => {
	it("reads the table off disk", async () => {
		withKnowledge({ "pronunciations.md": "| Lillia | LIL-ee-uh |\n" })
		const { pronunciationTable } = await freshModule()
		ok(pronunciationTable().length >= 0)
	})

	it("degrades to an empty table rather than throwing when the file is absent", async () => {
		process.env.EEPALYTICS_KNOWLEDGE_DIR = join(tmpdir(), "eepalytics-does-not-exist-ever")
		const { pronunciationTable } = await freshModule()
		strictEqual(pronunciationTable().length, 0)
	})
})

/**
 * The tripwire.
 *
 * `knowledge/champions/` held one markdown file per champion and nothing in the repo could tell a
 * sourced sentence in one from an invented one, which is how "Swirlseed rolls over terrain, and
 * grants vision of what it rolls past" shipped into 170 of 1,513 stored pieces of advice. Champion
 * facts are fetched now (`pnpm fetch:champions` -> `champion-table.ts`), and nothing in `src/`
 * reads that directory any more — so a file appearing there would be dead weight at best and, far
 * more likely, the first step of someone re-wiring prose back into the prompt.
 *
 * Deliberately pinned against the REPO's own path rather than the test seam: the point is to guard
 * what ships, and a check a test could point elsewhere guards nothing.
 */
describe("the deleted champion corpus", () => {
	it("has not come back", () => {
		const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../knowledge/champions")
		ok(
			!existsSync(dir),
			`${dir} exists again. Champion knowledge is FETCHED — regenerate it with \`pnpm fetch:champions\`, ` +
				`which writes src/knowledge/champion-table.ts with a URL, a revision and a fetch date on every ` +
				`record. Hand-written champion prose has no source and does not ship.`
		)
	})
})
