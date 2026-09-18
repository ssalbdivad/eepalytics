/**
 * The audit, run against the real fetched table and against the prose it is replacing.
 *
 * The third suite is the answer to "what happens today when the existing hand-written prose meets
 * this fence", and it is a measurement rather than an opinion: of 3,223 fragments in the 23 shipped
 * champion files, 93 — 2.9% — occur anywhere in the fetched data for that same champion.
 *
 * Read that number carefully, because it is easy to quote as more than it is. It is a TRACEABILITY
 * rate, not a falsity rate: a sentence that is true but phrased in a human's words traces no better
 * than an invented one, and that is exactly the property that makes the prose unauditable. What it
 * establishes is that nobody — no test, no judge, no reviewer — can tell the two apart by looking,
 * which is the case for replacing the files rather than editing them.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { auditRenderedBlock, pinnable, sourceCorpus, summarise } from "./knowledge-audit.ts"

const HERE = dirname(fileURLToPath(import.meta.url))

/** The generated table, or `null` — the fetcher is a separate program and may not have run. */
const table = await (async () => {
	try {
		const mod = (await import("./champion-table.ts")) as {
			CHAMPION_ROWS?: readonly { key: string }[]
		}
		return mod.CHAMPION_ROWS ?? null
	} catch {
		return null
	}
})()

const rowFor = (key: string): unknown => table?.find(r => r.key === key) ?? null

describe("sourceCorpus", () => {
	it("flattens any shape, and counts what went into it", () => {
		const c = sourceCorpus({ a: "Swirlseed", b: [{ cooldown: "12" }, 5186], c: null })
		ok(c.text.includes("swirlseed"))
		ok(c.numbers.has("12"))
		ok(c.numbers.has("5186"))
		strictEqual(c.leaves, 3)
	})

	it("admits a stored fraction in the form a renderer prints it", () => {
		const c = sourceCorpus({ winRate: 0.496722 })
		ok(c.numbers.has("49.67"))
		ok(c.numbers.has("49.7"))
		ok(c.numbers.has("50"))
	})

	it("counts a generated vocabulary as sourced, because it was fetched too", () => {
		const c = sourceCorpus({ coreItems: [6653] }, ["Liandry's Torment"])
		const audit = auditRenderedBlock("- core items: Liandry's Torment", c)
		strictEqual(audit.untraced.filter(f => f.text.includes("Liandry")).length, 0)
	})
})

describe("auditRenderedBlock", () => {
	const corpus = sourceCorpus({
		name: "Swirlseed",
		wikiDescription:
			"Active: Lillia lobs a seed at the target location that rolls forward indefinitely. The seed detonates upon hitting an enemy or terrain while on the ground.",
		cooldown: "12"
	})

	it("traces a line that quotes the data", () => {
		const audit = auditRenderedBlock(
			"### E — Swirlseed\n- what it does: The seed detonates upon hitting an enemy or terrain while on the ground.\n- cooldown: 12",
			corpus
		)
		deepStrictEqual(
			pinnable(audit).filter(t => !["what it does", "cooldown"].includes(t)),
			["E — Swirlseed"]
		)
		strictEqual(audit.unsourcedNumbers.length, 0)
	})

	/**
	 * The sentence that shipped, against the data it claims to rest on. A renderer that paraphrases
	 * is caught here with no help from its own author, which is the point of auditing from the
	 * outside.
	 */
	it("catches the paraphrase that turned a collision into a capability", () => {
		const audit = auditRenderedBlock(
			"- It rolls over terrain, and grants vision of what it rolls past.",
			corpus
		)
		deepStrictEqual(
			audit.untraced.map(f => f.text),
			["It rolls over terrain, and grants vision of what it rolls past."]
		)
	})

	it("flags a number that appears nowhere in the data, which is the loudest signal it has", () => {
		const audit = auditRenderedBlock("- cooldown: 9 at rank five", corpus)
		strictEqual(audit.unsourcedNumbers.length, 1)
		strictEqual(audit.unsourcedNumbers[0]!.token, "9")
	})

	it("reports the whole block when there is nothing to check it against", () => {
		const audit = auditRenderedBlock("She wants blue buff more than most junglers.", sourceCorpus(null))
		strictEqual(audit.traced, 0)
		strictEqual(audit.untraced.length, 1)
	})
})

describe("against the real fetched table", () => {
	it("traces the wiki's own sentence and refuses the one in lillia.md", (t) => {
		const row = rowFor("lillia")
		if (row === null) return t.skip("no generated champion table in this checkout")
		const corpus = sourceCorpus(row)

		const fromTheSource = auditRenderedBlock(
			"- The seed detonates upon hitting an enemy or terrain while on the ground, dealing magic damage to enemies in a cone, slowing them by 40% for 3 seconds and revealing them for 2 seconds.",
			corpus
		)
		strictEqual(fromTheSource.untraced.length, 0)
		strictEqual(fromTheSource.unsourcedNumbers.length, 0)

		// `knowledge/champions/lillia.md`, lines 36-38 and again at 145, 199 and 218.
		const asShipped = auditRenderedBlock(
			"It travels a long way, rolls over terrain, and grants vision of what it rolls past and reveals the first champion it hits.",
			corpus
		)
		strictEqual(asShipped.traced, 0)
	})
})

describe("the hand-written files, measured against what was fetched", () => {
	const dir = resolve(HERE, "../../knowledge/champions")

	it("finds almost none of the shipped prose in the sources it cites", (t) => {
		if (table === null) return t.skip("no generated champion table in this checkout")
		let files: string[]
		try {
			files = readdirSync(dir).filter(f => f.endsWith(".md") && !f.startsWith("_"))
		} catch {
			return t.skip("the hand-written files are gone, which is the outcome this measured")
		}
		if (files.length === 0) return t.skip("the hand-written files are gone")

		let fragments = 0
		let traced = 0
		let unsourcedNumbers = 0
		for (const f of files) {
			const row = rowFor(f.slice(0, -3))
			if (row === null) continue
			const raw = readFileSync(join(dir, f), "utf8")
			// The provenance header is not a claim about the champion; only the prose is audited.
			const body = raw.slice(raw.indexOf("\n---") + 4)
			const audit = auditRenderedBlock(body, sourceCorpus(row))
			fragments += audit.fragments
			traced += audit.traced
			unsourcedNumbers += audit.unsourcedNumbers.length
		}
		const rate = traced / fragments
		console.log(
			`hand-written champion prose: ${traced}/${fragments} fragments trace to the fetched table (${(rate * 100).toFixed(1)}%), ${unsourcedNumbers} numbers appear nowhere in it`
		)
		/*
		 * Stated as a bound rather than a fixed count so the files can be deleted, regenerated or
		 * trimmed without this becoming a chore. If it ever rises above a tenth, something is
		 * rendering from the table and this test should be pointed at that instead.
		 */
		ok(rate < 0.1, `expected almost nothing to trace, got ${(rate * 100).toFixed(1)}%`)
		ok(unsourcedNumbers > 0)
	})

	it("summarises in one line, for a log", () => {
		const audit = auditRenderedBlock("- cooldown: 9", sourceCorpus({ cooldown: "12" }))
		ok(summarise(audit).includes("numbers appear nowhere in it"))
	})
})
