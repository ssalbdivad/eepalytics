/**
 * The loader has one job the review depends on: never throw. Champion context is an
 * enhancement, so a missing directory, a malformed header or an unknown champion must all
 * degrade to something the digest can carry, not to a failed review.
 */

import { ok, strictEqual } from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "node:test"

const dirs: string[] = []

const withKnowledge = (files: Record<string, string>) => {
	const root = mkdtempSync(join(tmpdir(), "csk-knowledge-"))
	dirs.push(root)
	mkdirSync(join(root, "champions"), { recursive: true })
	for (const [name, body] of Object.entries(files))
		writeFileSync(join(root, "champions", name), body)
	process.env.CSK_KNOWLEDGE_DIR = root
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
	delete process.env.CSK_KNOWLEDGE_DIR
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

describe("championNote", () => {
	it("parses the header and returns the prose verbatim", async () => {
		withKnowledge({
			"lillia.md": "patch: 16.17\nsourcedAt: 2026-09-03\nsource: model-knowledge\n---\nShe clears fast.\n"
		})
		const { championNote } = await freshModule()
		const note = championNote("Lillia")!
		strictEqual(note.patch, "16.17")
		strictEqual(note.source, "model-knowledge")
		strictEqual(note.text, "She clears fast.")
		strictEqual(note.isDefault, false)
	})

	it("falls back to _default and says so", async () => {
		withKnowledge({ "_default.md": "patch: durable\n---\nCoach the role only.\n" })
		const { championNote } = await freshModule()
		const note = championNote("Zilean")!
		ok(note.isDefault)
		strictEqual(note.text, "Coach the role only.")
	})

	it("returns null when there is no knowledge directory at all", async () => {
		process.env.CSK_KNOWLEDGE_DIR = join(tmpdir(), "csk-does-not-exist-ever")
		const { championNote } = await freshModule()
		strictEqual(championNote("Lillia"), null)
	})

	it("survives a file with no header block", async () => {
		withKnowledge({ "lillia.md": "just prose, no header" })
		const { championNote } = await freshModule()
		const note = championNote("Lillia")!
		strictEqual(note.patch, "durable")
		strictEqual(note.text, "just prose, no header")
	})

	it("ignores an empty champion name", async () => {
		withKnowledge({ "_default.md": "---\nx\n" })
		const { championNote } = await freshModule()
		strictEqual(championNote(""), null)
	})
})

describe("stalenessWarning", () => {
	it("never fires for durable notes — champion identity survives tuning", async () => {
		const { stalenessWarning } = await freshModule()
		strictEqual(
			stalenessWarning({ patch: "durable" } as never, "16.17"),
			null
		)
	})

	it("is silent when the patches match", async () => {
		const { stalenessWarning } = await freshModule()
		strictEqual(stalenessWarning({ patch: "16.17" } as never, "16.17"), null)
	})

	it("asks for a hedge when the note predates the game's patch", async () => {
		const { stalenessWarning } = await freshModule()
		const w = stalenessWarning({ patch: "15.2" } as never, "16.17")!
		ok(w.includes("15.2") && w.includes("16.17"))
	})
})

describe("knownChampions", () => {
	it("lists hand-written notes and hides the default", async () => {
		withKnowledge({ "lillia.md": "---\na", "belveth.md": "---\nb", "_default.md": "---\nc" })
		const { knownChampions } = await freshModule()
		strictEqual(knownChampions().join(","), "belveth,lillia")
	})
})

/**
 * `sourcesAreTrusted` is the only thing standing between an unverified claim and the coaching
 * prompt, so it has to be strict. It also has to be right: it once rejected a correctly-sourced
 * 8 KB Lee Sin note because the header mentioned Data Dragon's `LeeSin.json` and a filename
 * matches any reasonable domain pattern. A validator that discards good work over a file
 * extension is one you end up switching off.
 */
describe("sourcesAreTrusted", () => {
	const trusted = async () => (await import("./research.ts")).sourcesAreTrusted

	it("accepts a header naming only sanctioned domains", async () => {
		ok((await trusted())("op.gg jungle-paths (patch 16.17) + leagueoflegends.com patch notes"))
		ok((await trusted())("www.u.gg and lolalytics.com, both patch 16.17"))
	})

	it("accepts a data file cited alongside a sanctioned domain", async () => {
		ok((await trusted())("ddragon.leagueoflegends.com 16.17.1 — LeeSin.json, for ability roles"))
		ok((await trusted())("op.gg 16.17; ddragon LeeSin.json; notes.md"))
	})

	it("rejects an unsanctioned domain even beside good ones", async () => {
		strictEqual((await trusted())("op.gg, u.gg and mobafire.com"), false)
	})

	it("rejects a header with no provenance at all", async () => {
		for (const empty of ["", "   ", "unknown", "my own knowledge", "assorted guides"])
			strictEqual((await trusted())(empty), false, `should reject ${JSON.stringify(empty)}`)
	})

	it("ignores www. when matching", async () => {
		strictEqual((await trusted())("www.op.gg"), (await trusted())("op.gg"))
	})
})
