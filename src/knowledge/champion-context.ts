/**
 * The runtime half of champion knowledge: read a committed file, join it to another one, stop.
 * NODE ONLY.
 *
 * ## The rule this module exists to obey
 *
 * "NOTHING SHOULD BE GENERATED DYNAMICALLY." Every sentence the coach is told about a champion was
 * written to disk by `scripts/generate-context.ts`, reviewed as a diff, and committed. At runtime
 * the app picks the right combination — his champion, the enemy jungler's, his role — and
 * concatenates. There is no renderer here, no template, no claim checker, no branch that can emit a
 * word about League. `readFileSync` and `join` are the whole of it, and that is deliberate: if this
 * file could produce a sentence, the design would be wrong.
 *
 * The two transformations it does perform are both provably incapable of producing a word.
 * `demoteHeadings` adds `#` characters to lines that already start with one, and the wrapper
 * headings (`# YOUR CHAMPION: <name>`, `# THE ENEMY JUNGLER: <name>`, `# THE ROLE`) are frozen
 * literals with a champion NAME interpolated — a name the client supplied, not a fact this app
 * asserted. Those three strings are located by name in `compare-arms.ts` and `audit-knowledge.ts`,
 * so they are pinned by `champion-context.test.ts` rather than free to be tidied.
 *
 * ## Why not just keep rendering it, when the renderer was already provenanced
 *
 * Because a rendered block is a block nobody read. `champion-brief.ts` checks every claim against
 * its evidence and puts a URL on every line, and it did all of that at request time, inside the
 * process, where the only person who ever saw the result was the model. A committed file is
 * greppable by a human who wants to know what his coach was told about Lillia, a patch becomes a
 * pull request, and the sync test in `champion-context.test.ts` means a hand edit to a generated
 * file — the exact move that produced the Swirlseed sentence — fails the suite.
 *
 * As a side effect the app stops importing `champion-table.ts` at all: 2.8 MB of generated module
 * that used to be parsed to produce text that is now just sat on disk.
 *
 * ## Scope: `full` and `core`, and the only thing `core` may differ by
 *
 * `core` is the same block with the wiki's per-ability edge-case notes dropped — half the corpus by
 * weight, and the budget switch four call sites already made. It is a separate FILE, not a filter,
 * so it is reviewable; and the test asserts every line of a core file appears in its full file, so
 * the worst failure the switch can cause is the coach knowing less rather than the coach being
 * wrong.
 *
 * ## Degrading
 *
 * A missing file is a normal state and returns `null`, exactly as a missing markdown file did
 * before any of this. No fallback text, no stand-in, no "no notes available for this champion"
 * line: an empty section is a prompt that invites the model to fill it.
 */

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { championKey } from "./index.ts"

const HERE = dirname(fileURLToPath(import.meta.url))

/** Overridable so a test can point at a generated tree in a temp directory. */
export const CONTEXT_DIR =
	process.env.EEPALYTICS_CONTEXT_DIR ?? resolve(HERE, "../../knowledge/context")

/**
 * `full` is everything fetched. `core` drops the wiki's per-ability interaction notes.
 *
 * HIS champion gets `full`, because every line the coach speaks is about the champion he is playing
 * and the notes are the layer that decides whether such a line is true. The counterpart, the
 * champ-select brief and the watch-a-moment call get `core`: that material is 50% of the bytes, it
 * is measured inert — 0.13% of 5,347 live lines mention the counterpart's kit at all — and what a
 * coach needs about the man being raced is his numbers, not whether a spell shield eats a
 * detonation.
 */
export type ContextScope = "full" | "core"

const cache = new Map<string, string | null>()

/** Test seam — `clearContextCache()` after regenerating the tree on disk. */
export const clearContextCache = (): void => {
	cache.clear()
}

const read = (rel: string): string | null => {
	const hit = cache.get(rel)
	if (hit !== undefined) return hit
	let text: string | null
	try {
		text = readFileSync(join(CONTEXT_DIR, rel), "utf8").trim()
		if (text === "") text = null
	} catch {
		text = null
	}
	cache.set(rel, text)
	return text
}

/**
 * The committed block for one champion, or `null` when no file was generated for him.
 *
 * `core` falls back to the full file rather than to nothing: a champion whose edge-case variant is
 * missing should cost the caller some tokens, never the whole section.
 */
export const championContext = (championName: string, scope: ContextScope = "full"): string | null => {
	const key = championKey(championName)
	if (key === "") return null
	if (scope === "core") return read(`champions/${key}.core.md`) ?? read(`champions/${key}.md`)
	return read(`champions/${key}.md`)
}

/** The committed block for one role. Four of the five say, in so many words, that there is nothing. */
export const roleContext = (role = "jungle"): string | null => {
	const key = role.toLowerCase().replace(/[^a-z]/g, "")
	return key === "" ? null : read(`roles/${key}.md`)
}

/** The general file: the patch, the sources, and the list of what nobody publishes. */
export const generalContext = (): string | null => read("general.md")

/** Whether a champion has a committed file at all — what `pnpm doctor` and the tests ask. */
export const hasChampionContext = (championName: string): boolean =>
	championContext(championName) !== null

export interface ContextManifest {
	patch: string
	champions: number
	roles: readonly string[]
	files: number
	bytes: number
	generatedFrom: string
	sha256: string
}

/** What was generated, and from which patch. `null` when the tree has never been written. */
export const contextManifest = (): ContextManifest | null => {
	const raw = read("MANIFEST.json")
	if (raw === null) return null
	try {
		return JSON.parse(raw) as ContextManifest
	} catch {
		return null
	}
}

/** The patch the committed tree was generated on, or `""` when nothing has been generated. */
export const contextPatch = (): string => contextManifest()?.patch ?? ""

/** `16.18.1` and `16.18.712.9876` are the same patch; `16.20` is not. */
const patchPair = (patch: string): string => patch.split(".").slice(0, 2).join(".")

/**
 * `null` when the tree was generated on the game's own patch; otherwise the sentence to put in
 * front of the model.
 *
 * Moved off `champion-data.ts` so the running app no longer imports `champion-table.ts` — 2.8 MB of
 * generated module that was being parsed to answer one string comparison. The wording is unchanged
 * from `championTableStaleness`, which still exists for the fetcher and the audit scripts.
 *
 * Not a silent pass and not a refusal. A champion's kit is usually the same across two patches and
 * occasionally is not, and the only honest thing to do with that is say which patch the numbers
 * came from and let the reader discount them.
 */
export const contextStaleness = (gamePatch: string): string | null => {
	const patch = contextPatch()
	if (gamePatch === "" || patch === "") return null
	const table = patchPair(patch)
	if (table === patchPair(gamePatch)) return null
	return (
		`These champion facts were fetched on patch ${patch} and this game is patch ${gamePatch}. ` +
		`Ability behaviour rarely moves between patches and numbers often do, so treat every figure below as ` +
		`the ${table} figure rather than as this game's, and say so rather than asserting it.`
	)
}

/* ------------------------------------------------------------------- the frozen composition */

/** Every heading drops one level, so the wrapper heading below is the section's top. */
const demoteHeadings = (text: string): string => text.replace(/^(#+)(\s)/gm, "#$1$2")

/**
 * The three section headings, frozen.
 *
 * `compare-arms.ts` withholds a section by name to measure what it is worth, and
 * `audit-knowledge.ts` splits the block at `\n# THE ROLE`. Renaming one of these silently retires
 * an arm, so they are constants with a test on them rather than string literals in a template.
 */
export const SECTION_HEADINGS = {
	champion: (name: string) => `# YOUR CHAMPION: ${name}`,
	counterpart: (name: string) => `# THE ENEMY JUNGLER: ${name}`,
	role: () => "# THE ROLE"
} as const

export interface ComposeOptions {
	champion: string
	counterpart?: string | null
	/** Which role file rides along. `false` withholds it; that is the 2026-09-11 ablation's flag. */
	role?: boolean | string
}

/**
 * The knowledge block for one game: his champion, the enemy jungler's, and the role file.
 *
 * Joined in the order the model should weight them — his own champion first, because that is the
 * one every line is about — with `\n\n---\n\n` between sections. The counterpart's half only
 * appears when the client has actually named him: guessing a counterpart would put a whole matchup
 * section in the prompt about a champion who is not in the game.
 */
export const composeKnowledge = (opts: ComposeOptions): string => {
	const parts: string[] = []

	const own = championContext(opts.champion, "full")
	if (own) parts.push(`${SECTION_HEADINGS.champion(opts.champion)}\n\n${demoteHeadings(own)}`)

	const vs = opts.counterpart ? championContext(opts.counterpart, "core") : null
	if (vs) parts.push(`${SECTION_HEADINGS.counterpart(opts.counterpart!)}\n\n${demoteHeadings(vs)}`)

	const role =
		opts.role === false ? null
		: typeof opts.role === "string" ? roleContext(opts.role)
		: roleContext()
	if (role) parts.push(`${SECTION_HEADINGS.role()}\n\n${role}`)

	return parts.join("\n\n---\n\n")
}
