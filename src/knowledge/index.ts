/**
 * `knowledge/` — champion context, loaded from markdown the user can edit.
 *
 * Same pattern as the persona in `AGENTS.md`: the file IS the behaviour. This module only
 * finds, parses and caches; it never decides what the coach does with the prose.
 *
 * THE FENCE. Everything here is general champion knowledge, and none of it is measured from
 * the user's game. The app's guarantee is that a number in a review came from the digest, and
 * a guide can be checked against nothing. So these notes are allowed to justify a FIX and are
 * never allowed to become a number, a stat, or a claim about what happened — `src/review/
 * prompt.ts` states that fence to the model, and `knowledge/README.md` states it to whoever
 * edits the files.
 *
 * NODE ONLY (reads the filesystem).
 */

import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

/** Overridable so tests do not depend on the repo's own `knowledge/` contents. */
export const KNOWLEDGE_DIR = (process.env.FAWNSEI_KNOWLEDGE_DIR ?? process.env.CSK_KNOWLEDGE_DIR) ?? resolve(HERE, "../../knowledge")

export interface ChampionNote {
	/** The lookup key: champion name, lowercased, non-letters stripped. */
	key: string
	/** The patch the note was written against, or "durable" for champion identity. */
	patch: string
	sourcedAt: string
	source: string
	/** Everything after the `---`, verbatim. */
	text: string
	/** True when `_default.md` was used because no champion file matched. */
	isDefault: boolean
}

/**
 * `Bel'Veth` -> `belveth`, `Dr. Mundo` -> `drmundo`, `Nunu & Willump` -> `nunuwillump`.
 * Riot's own spellings vary across endpoints, so normalise hard rather than trusting them.
 */
export const championKey = (name: string): string => name.toLowerCase().replace(/[^a-z]/g, "")

// `sources` is accepted as an alias for `source`: a research pass that cites three pages
// naturally reaches for the plural, and rejecting a well-sourced note over an "s" would throw
// away good work for nothing.
const HEADER_KEYS = ["patch", "sourcedAt", "source", "sources"] as const

const parseNote = (key: string, raw: string, isDefault: boolean): ChampionNote => {
	const split = raw.indexOf("\n---")
	const head = split === -1 ? "" : raw.slice(0, split)
	const text = (split === -1 ? raw : raw.slice(split + 4)).trim()
	const header: Record<string, string> = {}
	for (const line of head.split("\n")) {
		const m = /^([A-Za-z]+):\s*(.*)$/.exec(line.trim())
		if (m && (HEADER_KEYS as readonly string[]).includes(m[1]!)) header[m[1]!] = m[2]!.trim()
	}
	return {
		key,
		patch: header.patch ?? "durable",
		sourcedAt: header.sourcedAt ?? "unknown",
		source: header.source ?? header.sources ?? "unknown",
		text,
		isDefault
	}
}

const cache = new Map<string, ChampionNote | null>()

/** Test seam — `clearKnowledgeCache()` after editing files on disk. */
export const clearKnowledgeCache = (): void => cache.clear()

/**
 * The note for a champion, or the `_default` note, or `null` when neither exists.
 *
 * A missing directory is not an error: champion context is an enhancement, and a coach with no
 * notes must still produce a review. Every failure here degrades to `null`.
 */
export const championNote = (championName: string): ChampionNote | null => {
	const key = championKey(championName)
	if (key === "") return null
	const hit = cache.get(key)
	if (hit !== undefined) return hit

	const read = (file: string, isDefault: boolean): ChampionNote | null => {
		try {
			return parseNote(key, readFileSync(join(KNOWLEDGE_DIR, "champions", file), "utf8"), isDefault)
		} catch {
			return null
		}
	}

	const note = read(`${key}.md`, false) ?? read("_default.md", true)
	cache.set(key, note)
	return note
}

/** Which champions have hand-written notes. Used by the UI and by `doctor`. */
export const knownChampions = (): string[] => {
	try {
		return readdirSync(join(KNOWLEDGE_DIR, "champions"))
			.filter(f => f.endsWith(".md") && !f.startsWith("_"))
			.map(f => f.slice(0, -3))
			.sort()
	} catch {
		return []
	}
}

/**
 * `null` when the note is safe to quote as-is; otherwise the reason the coach should hedge.
 *
 * `durable` notes describe champion identity — clear shape, ability roles, spikes — which is
 * exactly the material that survives a patch, so they never go stale. A note pinned to a patch
 * that is not the game's patch might.
 */
export const stalenessWarning = (note: ChampionNote, gamePatch: string): string | null =>
	note.patch === "durable" || note.patch === "" || note.patch === gamePatch ?
		null
	:	`These notes were written for patch ${note.patch} and this game is patch ${gamePatch}. ` +
		`Treat anything that could have been tuned as uncertain, and say so rather than asserting it.`
