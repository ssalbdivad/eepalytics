/**
 * The committed context tree, checked as a committed artefact rather than as a renderer.
 *
 * Two of these tests are the reason the tree exists at all.
 *
 * `regenerates byte for byte` is the one that makes a hand edit impossible to land quietly. The
 * Swirlseed sentence got in because a file was writable and a file-level header could not be wrong
 * about a sentence; a generated tree closes that only if something notices when the bytes on disk
 * stop matching what the generator produces.
 *
 * `every champion line carries its own source` is the one that makes the FIRST failure loud. A line
 * without a bracket is a line nobody can date or dismiss, and that is the whole shape of the error
 * this directory replaced.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { dirname } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { CONTEXT_DIR, championContext, composeKnowledge, contextManifest, contextPatch, contextStaleness, generalContext, roleContext } from "./champion-context.ts"
import { buildContext, generateContext, ROLES } from "../../scripts/generate-context.ts"

const HERE = dirname(fileURLToPath(import.meta.url))

const walk = (dir: string, root: string = dir): string[] => {
	const out: string[] = []
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) out.push(...walk(p, root))
		else out.push(relative(root, p).split(sep).join("/"))
	}
	return out
}

const onDisk = walk(CONTEXT_DIR).sort()

describe("the committed context tree", () => {
	/**
	 * The sync test. Regenerating into a temp directory and diffing is the only check that catches
	 * BOTH failure directions: a generator change nobody re-ran, and a file somebody edited by hand.
	 */
	it("regenerates byte for byte, so nothing in it was hand-written", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "eepalytics-context-"))
		try {
			const manifest = await generateContext(tmp)
			const fresh = walk(tmp).sort()
			deepStrictEqual(
				fresh,
				onDisk,
				"the set of generated files moved — re-run `pnpm generate:context` and commit the diff"
			)
			const mismatched: string[] = []
			for (const rel of fresh) {
				if (rel === "MANIFEST.json") continue
				if (readFileSync(join(tmp, rel), "utf8") !== readFileSync(join(CONTEXT_DIR, rel), "utf8"))
					mismatched.push(rel)
			}
			deepStrictEqual(
				mismatched,
				[],
				"these committed files are not what the generator produces — hand edits do not survive here"
			)
			strictEqual(manifest.sha256, contextManifest()?.sha256)
		} finally {
			rmSync(tmp, { recursive: true, force: true })
		}
	})

	it("has a file for every champion the table carries, and for every role", () => {
		const manifest = contextManifest()
		ok(manifest !== null, "MANIFEST.json is missing — run `pnpm generate:context`")
		strictEqual(onDisk.filter(f => f.startsWith("champions/") && !f.endsWith(".core.md")).length, manifest.champions)
		deepStrictEqual(ROLES.map(r => `roles/${r}.md`).sort(), onDisk.filter(f => f.startsWith("roles/")))
		ok(manifest.champions > 150, `only ${manifest.champions} champions — the table is short`)
	})

	/**
	 * Every line that says something about a champion must end in its own citation. The exceptions
	 * are structural — headings, blanks, the preamble, the source list, and the owner's own block,
	 * which is unsourced BY CONSTRUCTION and carries the warning that says so.
	 */
	it("gives every champion line its own source, revision and date", () => {
		const bad: string[] = []
		for (const rel of onDisk.filter(f => f.startsWith("champions/"))) {
			const text = readFileSync(join(CONTEXT_DIR, rel), "utf8")
			let unsourced = false
			for (const line of text.split("\n")) {
				// The owner's block is unsourced by construction; the trailing list IS the sources.
				if (line.startsWith("### UNVERIFIED") || line.startsWith("### Where this section came from"))
					unsourced = true
				/*
				 * A WITHHELD notice is the one line that says something about a champion and cites
				 * nothing, and that is correct rather than an oversight: it says a value the sources
				 * hold did not survive the fence, so there is nothing to cite. It is minted from a
				 * frozen structure template like every other unsourced word here, it carries no
				 * number, and `provenance.test.ts` pins its wording.
				 */
				if (!line.startsWith("- ") || unsourced || line.startsWith("- WITHHELD (")) continue
				if (!/\[[^\]]+, fetched \d{4}-\d{2}-\d{2}\]$/.test(line.trimEnd())) bad.push(`${rel}: ${line.slice(0, 90)}`)
			}
		}
		deepStrictEqual(bad.slice(0, 5), [], `${bad.length} champion lines arrived without a source`)
	})

	/**
	 * The budget switch, fenced. `core` may only ever drop lines — it may not reword one — so the
	 * worst it can do is leave the coach knowing less, which is never the failure that matters here.
	 */
	it("lets the core variant drop lines and never reword one", () => {
		const offenders: string[] = []
		/*
		 * The trailing source list is excluded, and it is the one place the two files legitimately
		 * differ: each `sources.line` carries how many lines that source contributed, so dropping
		 * the notes changes the COUNT. That is bookkeeping about the file, not a claim about a
		 * champion, and it is generated from the same closed template either way.
		 */
		const body = (text: string): string[] => text.split("### Where this section came from")[0]!.split("\n")
		for (const rel of onDisk.filter(f => f.endsWith(".core.md"))) {
			const full = new Set(body(readFileSync(join(CONTEXT_DIR, rel.replace(".core.md", ".md")), "utf8")))
			for (const line of body(readFileSync(join(CONTEXT_DIR, rel), "utf8")))
				if (line !== "" && !full.has(line)) offenders.push(`${rel}: ${line.slice(0, 80)}`)
		}
		deepStrictEqual(offenders.slice(0, 5), [], `${offenders.length} core lines are not in the full file`)
	})

	/**
	 * THE ONE THAT MATTERS. The sentence that licensed 38% of every champion-specific live line and
	 * 170 of 1,513 stored pieces of post-game advice, asserted absent from the corpus that replaced
	 * it — and the fetched sentence that refutes it, asserted present.
	 */
	it("does not say Swirlseed rolls over terrain, and does say what the sources say", () => {
		const lillia = championContext("Lillia")
		ok(lillia !== null)
		ok(!/rolls over terrain/i.test(lillia), "the refuted clause is back")
		ok(!/vision of what it rolls past/i.test(lillia), "the refuted clause is back")
		ok(/collides with terrain|detonates upon hitting an enemy or terrain/i.test(lillia))

		const offenders = onDisk
			.filter(f => f.startsWith("champions/"))
			.filter(f => /rolls over terrain|vision of what it rolls past/i.test(readFileSync(join(CONTEXT_DIR, f), "utf8")))
		deepStrictEqual(offenders, [])
	})

	it("names no source for the role file, and says so on its first line", () => {
		const jungle = roleContext("jungle")
		ok(jungle !== null)
		ok(jungle.startsWith("NOT FETCHED"), "the role file must open by saying nothing fetched it")
		for (const role of ROLES.filter(r => r !== "jungle")) {
			const text = roleContext(role)
			ok(text !== null && text.startsWith("Nothing here."), `${role} should be the empty answer`)
		}
		strictEqual(roleContext("no-such-role"), null)
	})

	it("says in the general file what no source publishes", () => {
		const general = generalContext()
		ok(general !== null)
		ok(general.includes("NOT PUBLISHED ANYWHERE"))
		ok(general.includes("jungle clear routes and camp order"))
		ok(general.includes(contextPatch()))
	})

	it("degrades to nothing for a champion nobody fetched", () => {
		strictEqual(championContext("Not A Champion"), null)
		strictEqual(championContext(""), null)
		strictEqual(composeKnowledge({ champion: "Not A Champion", counterpart: null, role: false }), "")
	})

	it("composes the three sections under the headings the arms locate them by", () => {
		const text = composeKnowledge({ champion: "Lillia", counterpart: "Briar" })
		ok(text.includes("# YOUR CHAMPION: Lillia"))
		ok(text.includes("# THE ENEMY JUNGLER: Briar"))
		ok(text.includes("\n# THE ROLE"))
		ok(text.indexOf("# YOUR CHAMPION") < text.indexOf("# THE ENEMY JUNGLER"))
		// The counterpart is `core`: its half must be shorter than Briar's own full file.
		const [, vs] = text.split("\n\n---\n\n")
		ok(vs!.length < championContext("Briar")!.length, "the counterpart's section should be the edge-case-free one")
	})

	it("withholds the counterpart when the client never named one", () => {
		const text = composeKnowledge({ champion: "Lillia", counterpart: null })
		ok(!text.includes("# THE ENEMY JUNGLER"))
	})

	it("says which patch the facts came from when the game is on another one", () => {
		strictEqual(contextStaleness(contextPatch()), null)
		strictEqual(contextStaleness(""), null)
		const warning = contextStaleness("99.1.1")
		ok(warning !== null && warning.includes(contextPatch()) && warning.includes("99.1.1"))
	})

	/**
	 * The architectural assertion, not a style one. The runtime loader must not be able to reach the
	 * generated table, the claim checker or the renderer — if it can, a future edit can quietly put
	 * rendering back on the request path and nothing else in this suite would notice.
	 */
	it("keeps the renderer out of the runtime path", () => {
		const src = readFileSync(join(HERE, "champion-context.ts"), "utf8")
		for (const forbidden of ["champion-table.ts", "champion-brief.ts", "claims-from-row.ts", "provenance.ts"])
			ok(!src.includes(`from "./${forbidden}"`), `champion-context.ts imports ${forbidden}`)
	})

	it("builds the same file list in memory as it writes to disk", () => {
		deepStrictEqual(
			buildContext().map(f => f.path).sort(),
			onDisk.filter(f => f !== "MANIFEST.json")
		)
	})
})

describe("the consumers", () => {
	/** The live block is this module's output and nothing else's. */
	it("hands the live coach the composed files", async () => {
		const { fullKnowledge } = await import("../review/live-knowledge-full.ts")
		strictEqual(
			fullKnowledge({ champion: "Lillia", counterpart: "Briar" }),
			composeKnowledge({ champion: "Lillia", counterpart: "Briar" })
		)
	})

	/**
	 * `role: false` is the 2026-09-11 ablation's flag and the only way to withhold the one section
	 * that has no name to withhold. Keeping it working is what keeps that arm replayable.
	 */
	it("can still withhold the role file, which is how that arm was measured", async () => {
		const { fullKnowledge } = await import("../review/live-knowledge-full.ts")
		ok(!fullKnowledge({ champion: "Lillia", counterpart: null, role: false }).includes("# THE ROLE"))
		ok(fullKnowledge({ champion: "Lillia", counterpart: null }).includes("# THE ROLE"))
	})

	it("resolves a champion however the client spells him", () => {
		const a = championContext("Bel'Veth")
		const b = championContext("Belveth")
		ok(a !== null)
		strictEqual(a, b)
		strictEqual(championContext("Nunu & Willump") !== null, true)
	})

	/** `core` never returns nothing when `full` has something: a missing variant costs tokens, not the section. */
	it("falls back from core to full rather than to silence", () => {
		strictEqual(championContext("Lillia", "core") !== null, true)
		ok(championContext("Lillia", "core")!.length < championContext("Lillia")!.length)
	})
})
