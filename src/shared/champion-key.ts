/**
 * `Bel'Veth` -> `belveth`, `Nunu & Willump` -> `nunuwillump`. The app's lookup key for a champion.
 *
 * ## Why this is four lines in its own file
 *
 * Riot spells champions differently on every endpoint it owns — the display name (`Nunu &
 * Willump`), the apiname (`Nunu`), `MonkeyKing` for the champion everyone else calls Wukong — and
 * the wiki spells them a fourth way. Nothing joins those without a hard normalisation, so this
 * function is the join key for `knowledge/context/champions/<key>.md`, for `ChampionRow.key` in the
 * generated table, for `legacy-clauses.ts`, and for the claim ledger's `subject` field. It is
 * therefore load-bearing in a way its length does not advertise.
 *
 * It lived in THREE places until 2026-09-19: `knowledge/index.ts` (the copy every runtime and
 * generation caller reached), `knowledge/champion-data.ts` (a facade whose only importer was its
 * own test, now deleted) and a private one in `scripts/fetch-champions.ts`. All three were verified
 * byte-identical before the collapse — the matched source text of each was
 * `name.toLowerCase().replace(/[^a-z]/g, "")` in all three, and `champion-key.test.ts` re-checks
 * the generator's copy against this one on every run rather than leaving that as a claim in a
 * comment.
 *
 * It is HERE rather than in `knowledge/index.ts` because that module imports `node:fs` to read
 * `knowledge/pronunciations.md`, so every browser-side caller of a four-line string function was
 * pulling the filesystem in behind it. This file is pure string work and imports nothing.
 *
 * ## The generator keeps its own copy on purpose
 *
 * `scripts/fetch-champions.ts` still defines a private `championKey`, and that is deliberate rather
 * than an oversight this move missed: the generator WRITES `champion-table.ts`, whose `key` column
 * is this function's output, so it must depend on nothing it generates for. A generator that
 * imports from `src/` to compute a column of its own output can be broken by an edit to the thing
 * it produces. What replaces the shared import is a test: `champion-key.test.ts` reads that file
 * and pins its copy's source to this one, and separately checks the OUTPUT — every one of the 173
 * rows in the committed table has `key === championKey(name)`, 19 of which carry a character this
 * function strips, so the check is not vacuous.
 *
 * ## What it is not
 *
 * Not reversible, and not a display name: `drmundo` has no dot to put back. Say the champion's
 * `name`, never its key. And note it strips DIGITS as well as punctuation — `Jarvan IV` is
 * `jarvaniv`, which is only safe because no champion's name carries an Arabic numeral, and would
 * silently collide the day one does.
 *
 * A name with no letters in it yields `""`, which callers treat as "no champion" rather than as a
 * key — `championContext()` returns `null` on it instead of reading `champions/.md`. That empty
 * string is a load-bearing sentinel, not a degenerate case to tidy away.
 *
 * Browser-safe: no imports, no I/O, no wall clock.
 */
export const championKey = (name: string): string => name.toLowerCase().replace(/[^a-z]/g, "")
