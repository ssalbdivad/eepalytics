/**
 * Write the PRE-GENERATED context tree: `knowledge/context/`. NODE ONLY, no network.
 *
 * ## Why this exists at all, when `champion-brief.ts` already renders the same text
 *
 * It rendered it AT RUNTIME. The owner's correction is that nothing may be generated while the app
 * is running: the artefact is committed text in the repo, one file per champion, one per role, one
 * general, and at runtime the app picks the right combination and concatenates. The reason is not
 * performance and it is not caching — it is that a rendered block is a block nobody read. A
 * committed file is reviewable, diffable, and greppable by a human who wants to know what his coach
 * was told about Lillia, and a new patch becomes a pull request instead of a silent change of mind.
 *
 * So the pipeline is now two halves with a file boundary between them, and the boundary is the
 * point:
 *
 *   fetch  ->  src/knowledge/champion-table.ts   (generated, committed, 5 sources, per-field dates)
 *   render ->  knowledge/context/**.md           (generated, committed, THIS script)
 *   run    ->  src/knowledge/champion-context.ts (reads those files and joins them. Nothing else.)
 *
 * Everything that can invent a sentence lives above the boundary and runs on a developer's machine
 * with a diff at the end of it. Below the boundary there is no renderer, no template, no claim
 * checker and no branch that can produce a word — only `readFileSync` and `join`.
 *
 * ## Two files per champion, and the one thing the second one may do
 *
 * `<key>.md` is everything fetched. `<key>.core.md` is the same block with the wiki's per-ability
 * edge-case notes dropped, which is 50% of the corpus by weight (3.09 MB against 1.55 MB). That
 * switch is a BUDGET decision and it already existed as `edgeCases: false` on four call sites — the
 * counterpart's section, the champ-select brief, the watch-a-moment call. It survives as a second
 * FILE rather than as a runtime filter for the same reason everything else here did: a filter is a
 * branch, and a branch is somewhere a sentence could come from. Two committed files are two things
 * a human can read.
 *
 * The core file can only ever CONTAIN FEWER LINES than the full one. It cannot reword one, and the
 * test asserts that its every line appears in the full file — so the worst failure available to the
 * budget switch is the coach knowing less, never the coach being wrong.
 *
 * ## Reproducibility is the contract
 *
 * Re-running this on an unchanged table must reproduce every byte. No wall clock reaches a file:
 * dates come from the table's own per-source `fetchedAt`. `champion-context.test.ts` regenerates
 * the whole tree into a temp directory and diffs it against what is committed, so a hand edit to a
 * generated file — the exact move that produced the Swirlseed sentence — fails the suite.
 *
 * ## What is in the tree that was NOT fetched, and it is two things
 *
 * `roles/jungle.md` is model-authored prose from the pre-fetch era. It is kept, and it is kept
 * labelled: the file opens with the line that says no source backs it and that a fetched line wins
 * any disagreement. It survives because it makes no claim about any champion's kit, which is the
 * class of error that was actually measured — but it is unsourced and the report says so.
 *
 * `owner/<champion>.md` is his own judgment and is baked into the champion file under a heading
 * that says it has no source. Baking it in is what makes the runtime a reader: the cost is that
 * editing a note means re-running this script, and the sync test is what makes that impossible to
 * forget.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
	championBrief,
	championTableSync,
	ownerNotes,
	OWNER_DIR
} from "../src/knowledge/champion-brief.ts"
import { CHAMPION_TABLE_PATCH, CHAMPION_TABLE_SOURCES } from "../src/knowledge/champion-table.ts"
import { assemble, structureLine } from "../src/knowledge/provenance.ts"
import { flattenedTableCells, soleSourcedClaims } from "../src/knowledge/claims-from-row.ts"
import type { SourceRecord } from "../src/knowledge/provenance.ts"
import { championKey } from "../src/knowledge/index.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, "..")

/** The committed tree. Everything under it is generated; nothing under it may be hand-edited. */
export const CONTEXT_DIR = join(REPO, "knowledge", "context")

/**
 * The roles the app knows about, in the order a human reads a scoreboard.
 *
 * All five get a file. Four of them say, in the frozen `role.none` words, that nothing is published
 * about them and nothing was invented — which is the whole instruction working: an empty answer,
 * written down, beats a plausible one.
 */
export const ROLES = ["jungle", "top", "middle", "bottom", "support"] as const

/** Where the one surviving piece of role prose lives, and it is not fetched. */
const ROLE_PROSE: Partial<Record<(typeof ROLES)[number], string>> = {
	jungle: join(REPO, "knowledge", "general", "jungle.md")
}

/**
 * The line above the role prose, identical to the one `live-knowledge-full.ts` used to add at
 * runtime. It moves into the FILE because that is where a reader of the file needs it: a caveat
 * applied on the way to the model is a caveat nobody reviewing the repo ever sees.
 */
export const ROLE_CAVEAT =
	"NOT FETCHED, unlike everything above it. This section is general jungle judgment written for " +
	"this app; no site publishes it and no source backs it. It is about the ROLE and says nothing " +
	"about any champion's kit. Where it disagrees with a fetched line above, the fetched line wins."

/** Everything before the first `\n---` is the old file's provenance header, not coaching prose. */
const stripHeader = (raw: string): string => {
	const split = raw.indexOf("\n---")
	return (split === -1 ? raw : raw.slice(split + 4)).trim()
}

export interface GeneratedFile {
	/** Path relative to `knowledge/context/`, forward slashes, so a manifest is machine-stable. */
	path: string
	text: string
}

/** One champion's two files, or nothing when the table has no row and he has no notes. */
const championFiles = (displayName: string): GeneratedFile[] => {
	const key = championKey(displayName)
	const { facts } = championTableSync()
	const row = facts.get(key) ?? null
	const owner = ownerNotes(displayName)
	const full = championBrief(row, { owner })
	if (!full) return []
	const core = championBrief(row, { owner, edgeCases: false })
	const out: GeneratedFile[] = [{ path: `champions/${key}.md`, text: `${full.text.trim()}\n` }]
	if (core) out.push({ path: `champions/${key}.core.md`, text: `${core.text.trim()}\n` })
	return out
}

/** The general file: the patch, the sources, and the list of what nobody publishes. */
const generalFile = (): GeneratedFile => {
	const { facts, diagnostics } = championTableSync()
	const claims = [...facts.values()].reduce((n, f) => n + f.claims.length, 0)
	// Counted apart: one is a fact about the patch, the other a fact about this pipeline.
	const withheld = diagnostics.filter(d => d.includes("sources disagreed")).length
	const broken = diagnostics.filter(d => d.includes("expansion broke")).length
	/*
	 * The two 2026-09-19 figures. Both are counted off the RECORDS rather than off the diagnostic
	 * strings, so they cannot drift from what the champion files actually contain, and both are
	 * reported here because a champion file cannot carry them: `auditAssembled` builds its ledger
	 * from `championBrief`'s own minted lines, so a sentence this generator adds to a champion file
	 * after the fact reads as `untraced` in `pnpm audit:knowledge --all`.
	 */
	const tableCells = flattenedTableCells(facts.values())
	const soleSourced = soleSourcedClaims(facts.values())

	/*
	 * The trailing source list is the table's own source records rather than a per-claim tally,
	 * because this file makes no claim about any champion — it describes the pipeline. `claims: 0`
	 * would suppress the line, so each source is reported with the number of champion files it
	 * contributed to, which is every one of them.
	 */
	const sources: SourceRecord[] = [
		{
			id: "ddragon",
			tier: "tier1-mechanics",
			publisher: "Riot Data Dragon",
			url: CHAMPION_TABLE_SOURCES.ddragon.url,
			revision: CHAMPION_TABLE_SOURCES.ddragon.patch,
			fetchedAt: CHAMPION_TABLE_SOURCES.ddragon.fetchedAt
		},
		{
			id: "wikiModule",
			tier: "tier1-mechanics",
			publisher: "League of Legends Wiki, Module:ChampionData/data",
			url: CHAMPION_TABLE_SOURCES.wikiModule.url,
			revision: "raw",
			fetchedAt: CHAMPION_TABLE_SOURCES.wikiModule.fetchedAt
		},
		{
			id: "wikiAbility",
			tier: "tier1-mechanics",
			publisher: "League of Legends Wiki, Template:Data <Champion>/<Ability>",
			url: CHAMPION_TABLE_SOURCES.wikiAbilities.api,
			revision: "per-ability revid, on each line",
			fetchedAt: CHAMPION_TABLE_SOURCES.wikiAbilities.fetchedAt
		}
	]

	const lines = [
		structureLine("general.heading"),
		structureLine("blank"),
		structureLine("section.preamble"),
		structureLine("blank"),
		structureLine("general.patch", {
			patch: CHAMPION_TABLE_PATCH,
			champions: facts.size,
			claims,
			withheld,
			broken,
			tableCells,
			soleSourced
		}),
		structureLine("blank"),
		structureLine("general.silent"),
		structureLine("blank"),
		structureLine("sources.heading"),
		...sources.map(source => structureLine("sources.line", { source, claims: facts.size }))
	]
	return { path: "general.md", text: `${assemble(lines, [], sources).text.trim()}\n` }
}

/** Every heading drops one level, so the `# THE ROLE` wrapper the composer adds is the file's top. */
const demoteHeadings = (text: string): string => text.replace(/^(#+)(\s)/gm, "#$1$2")

/**
 * One file per role. Four of the five are the honest empty answer.
 *
 * No file carries its own top heading: `composeKnowledge` supplies `# THE ROLE`, and it supplies it
 * under that exact name because `compare-arms.ts` and `audit-knowledge.ts` locate the section by it.
 * So the body starts with the caveat, which is also the right first line for a human opening the
 * file — the thing it most needs to say about itself is that nothing fetched it.
 */
const roleFiles = (): GeneratedFile[] =>
	ROLES.map(role => {
		const prose = ROLE_PROSE[role]
		if (prose === undefined)
			return {
				path: `roles/${role}.md`,
				text: `${assemble([structureLine("role.none", { role })], [], []).text.trim()}\n`
			}
		// The caveat is minted; the body is the committed file, byte for byte, header stripped.
		return {
			path: `roles/${role}.md`,
			text: `${ROLE_CAVEAT}\n\n${demoteHeadings(stripHeader(readFileSync(prose, "utf8")))}\n`
		}
	})

/**
 * The note a human finds when they open the directory. NEVER sent to a model — it is documentation
 * about the pipeline, not context — which is why it may be written in words rather than minted.
 */
const readmeFile = (files: readonly GeneratedFile[]): GeneratedFile => {
	const champions = files.filter(f => f.path.startsWith("champions/") && !f.path.endsWith(".core.md")).length
	return {
		path: "README.md",
		text: `# knowledge/context — generated. Do not edit by hand.

Every file here is written by \`pnpm generate:context\` (\`scripts/generate-context.ts\`) out of the
fetched \`src/knowledge/champion-table.ts\`, and \`pnpm fetch:champions\` runs it for you. Patch
${CHAMPION_TABLE_PATCH}, ${champions} champions, ${ROLES.length} roles.

A hand edit here does not survive: \`src/knowledge/champion-context.test.ts\` regenerates the whole
tree into a temp directory and diffs it against what is committed. That test exists because the
error this directory replaced — \`lillia.md\` saying the Swirlseed "rolls over terrain, and grants
vision of what it rolls past", which it does neither — got in through a writable file under a
file-level provenance header that could not be wrong about a sentence.

- \`champions/<key>.md\` — everything fetched for that champion. Every line ends with the source,
  revision and date it was copied from.
- \`champions/<key>.core.md\` — the same block without the wiki's per-ability interaction notes, for
  the callers on a token budget. It may only ever drop lines, and a test asserts that.
- \`roles/<role>.md\` — one per role. Four of the five say there is nothing, because no source
  publishes anything about a role and nothing was written to stand in for one.
- \`general.md\` — the patch, the sources, and the list of what nobody publishes.
- \`MANIFEST.json\` — patch, counts and a sha256 over the tree.

At runtime \`src/knowledge/champion-context.ts\` reads these files and joins them. It cannot render,
template or compute a sentence, and that is the design rather than an accident of it.
`
	}
}

/** Everything the tree should contain, sorted, with no file written yet. */
export const buildContext = (): GeneratedFile[] => {
	const { facts } = championTableSync()
	const files: GeneratedFile[] = [generalFile(), ...roleFiles()]
	for (const f of [...facts.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)))
		files.push(...championFiles(f.displayName))
	// A champion with owner notes but no fetched row still deserves a file.
	let ownerNames: string[] = []
	try {
		ownerNames = readdirSync(OWNER_DIR).filter(n => n.endsWith(".md")).map(n => n.slice(0, -3))
	} catch {
		ownerNames = []
	}
	const have = new Set(files.map(f => f.path))
	for (const name of ownerNames.sort())
		for (const file of championFiles(name)) if (!have.has(file.path)) files.push(file)
	files.push(readmeFile(files))
	return files.sort((a, b) => a.path.localeCompare(b.path))
}

export interface Manifest {
	patch: string
	champions: number
	roles: readonly string[]
	files: number
	bytes: number
	/** Newest source timestamp in the table. NOT the wall clock — see the reproducibility note. */
	generatedFrom: string
	sha256: string
}

/** A digest over sorted `path\ntext` pairs: stable across machines, unaffected by mtimes. */
const digestOf = async (files: readonly GeneratedFile[]): Promise<string> => {
	const { createHash } = await import("node:crypto")
	const h = createHash("sha256")
	for (const f of files) {
		h.update(f.path)
		h.update("\n")
		h.update(f.text)
	}
	return h.digest("hex")
}

export const manifestFor = async (files: readonly GeneratedFile[]): Promise<Manifest> => {
	const { facts } = championTableSync()
	const stamps = [
		CHAMPION_TABLE_SOURCES.ddragon.fetchedAt,
		CHAMPION_TABLE_SOURCES.wikiModule.fetchedAt,
		CHAMPION_TABLE_SOURCES.wikiAbilities.fetchedAt
	].sort()
	return {
		patch: CHAMPION_TABLE_PATCH,
		champions: facts.size,
		roles: ROLES,
		files: files.length,
		bytes: files.reduce((n, f) => n + Buffer.byteLength(f.text), 0),
		generatedFrom: stamps.at(-1) ?? "",
		sha256: await digestOf(files)
	}
}

/**
 * Write the tree. Removes `champions/` and `roles/` first so a champion Riot deleted, or a `.core`
 * file that stopped being generated, leaves rather than lingering as a file the app would still
 * happily read.
 */
export const generateContext = async (dir: string = CONTEXT_DIR): Promise<Manifest> => {
	const files = buildContext()
	for (const sub of ["champions", "roles"]) rmSync(join(dir, sub), { recursive: true, force: true })
	mkdirSync(dir, { recursive: true })
	for (const file of files) {
		const out = join(dir, file.path)
		mkdirSync(dirname(out), { recursive: true })
		writeFileSync(out, file.text)
	}
	const manifest = await manifestFor(files)
	writeFileSync(join(dir, "MANIFEST.json"), `${JSON.stringify(manifest, null, "\t")}\n`)
	return manifest
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
	const manifest = await generateContext()
	console.log(
		`wrote knowledge/context/: ${manifest.files} files, ${(manifest.bytes / 1024 / 1024).toFixed(2)} MB, ` +
			`${manifest.champions} champions, patch ${manifest.patch}`
	)
	console.log(`sha256 ${manifest.sha256}`)
	const { diagnostics } = championTableSync()
	if (diagnostics.length > 0) console.log(`${diagnostics.length} diagnostics (WITHHELD slots and refusals)`)
}
