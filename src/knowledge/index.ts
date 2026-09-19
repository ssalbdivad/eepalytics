/**
 * `knowledge/` — where the editable, on-disk knowledge lives, and what is left of it.
 *
 * ## What this module used to do, and why it does not any more
 *
 * It loaded `knowledge/champions/<champion>.md`: a per-champion markdown file with a four-line
 * provenance header and several thousand characters of prose under it. Twenty-four of those files
 * existed, 184,104 bytes, and every sentence in every one of them was written by a model — by
 * `src/knowledge/research.ts`, which spawned an agent with web access and had it compose champion
 * knowledge into the file that the next review would paste into its prompt.
 *
 * Audited on 2026-09-18 against the wiki's rendered ability pages and Data Dragon 16.18.1, that
 * corpus ran 18 wrong sentences in 225 adjudicated mechanical claims — 8.0% [5.1, 12.3] — and one
 * of them mattered enormously. `lillia.md` said Swirlseed "rolls over terrain, and grants vision of
 * what it rolls past". It does neither. That single clause is traceable to 170 of the 1,513 stored
 * pieces of post-game advice and 38% of the champion-specific lines the live coach has ever spoken.
 *
 * The failure was not the sentences. It was that a file-level header cannot be wrong about a
 * sentence, so nothing on disk or in the repo could tell a sourced line from an invented one by
 * looking — and the grader was handed the same file, so no measurement could either.
 *
 * So the files are deleted and champion knowledge is FETCHED: `pnpm fetch:champions` writes the
 * generated `champion-table.ts`, `claims-from-row.ts` attributes it per sentence, `provenance.ts`
 * re-derives each sentence from the bytes it came from, and `champion-brief.ts` renders it with the
 * URL, revision and fetch date inline. `championNote`, `defaultNote`, `knownChampions` and
 * `stalenessWarning` are gone with the files they read; the staleness that replaced the last of
 * them is `championContextStaleness` in `champion-context.ts`, which asks the COMMITTED tree's own
 * manifest which patch it was cut on. (`championTableStaleness` in `champion-data.ts` is the same
 * sentence over `champion-table.ts`, and nothing outside that file's own test calls it.)
 *
 * ## What still lives on disk here
 *
 * - `knowledge/general/jungle.md` — ROLE prose, and it is a GENERATOR INPUT rather than a runtime
 *   read: `scripts/generate-context.ts` demotes its headings, puts `ROLE_CAVEAT` above it and
 *   writes it out as `knowledge/context/roles/jungle.md`, which is the file
 *   `review/live-knowledge-full.ts` actually reads. Still model-authored and still unsourced, and
 *   labelled as such in the prompt. It survives the deletion because it makes no claim about any
 *   champion's kit, which is the class of error that was actually measured.
 * - `knowledge/owner/<champion>.md` — HIS notes, read by `champion-brief.ts` at GENERATION time.
 *   The one channel allowed to carry unsourced judgment, because he is the only person here who
 *   has it. The directory does not exist today: `ownerDirDigest` returns the digest of nothing and
 *   `champion-brief.test.ts` pins that, so the first file to appear there fails the suite.
 * - `knowledge/pronunciations.md` — the say-it-like-this table below.
 *
 * NODE ONLY (reads the filesystem).
 */

import { readFileSync } from "node:fs"
import { parsePronunciations } from "../shared/pronounce.ts"
import type { Pronunciation } from "../shared/pronounce.ts"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

/** Overridable so tests do not depend on the repo's own `knowledge/` contents. */
export const KNOWLEDGE_DIR = (process.env.EEPALYTICS_KNOWLEDGE_DIR ?? process.env.CSK_KNOWLEDGE_DIR) ?? resolve(HERE, "../../knowledge")

/**
 * `Bel'Veth` -> `belveth`, `Dr. Mundo` -> `drmundo`, `Nunu & Willump` -> `nunuwillump`.
 * Riot's own spellings vary across endpoints, so normalise hard rather than trusting them.
 */
export const championKey = (name: string): string => name.toLowerCase().replace(/[^a-z]/g, "")

/** Test seam — `clearKnowledgeCache()` after editing files on disk. */
export const clearKnowledgeCache = (): void => {
	pronCache = null
}

/**
 * The say-it-like-this table, from `knowledge/pronunciations.md`.
 *
 * Cached and cleared by `clearKnowledgeCache`, so correcting a respelling that sounded wrong is an
 * edit to a markdown file rather than a code change — which is the whole point of it living in
 * `knowledge/`.
 *
 * A missing or unreadable file yields an empty table and the coach simply says the names the way it
 * always did. Pronunciation is a polish feature; it must never be able to stop a game being
 * coached.
 */
let pronCache: Pronunciation[] | null = null

export const pronunciationTable = (): Pronunciation[] => {
	if (pronCache) return pronCache
	try {
		pronCache = parsePronunciations(readFileSync(join(KNOWLEDGE_DIR, "pronunciations.md"), "utf8"))
	} catch {
		pronCache = []
	}
	return pronCache
}
