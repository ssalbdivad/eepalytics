/**
 * The loader for the FETCHED champion table — the sourced replacement for hand-written prose.
 *
 * ## The rule this module exists to enforce
 *
 * Every sentence it returns is a string that `scripts/fetch-champions.ts` copied off a URL, or a
 * label naming the field that string came from. Nothing here writes a claim about a champion, and
 * nothing here may start to: if a fact is not in `champion-table.ts`, the honest output is its
 * absence. That is the whole difference between this file and the 232KB of `knowledge/champions/`
 * prose it is built to replace, which read exactly the same whether it was true or invented.
 *
 * So the renderer below reformats and labels. It never summarises, never paraphrases, never fills
 * a gap and never decides what a fact implies. "Swirlseed detonates upon hitting an enemy or
 * terrain" reaches the model because the wiki wrote it; "so use it to check the far side of a
 * wall" does not reach the model at all, because nobody published it.
 *
 * ## Provenance is content, not a header to strip
 *
 * `src/review/live-knowledge-full.ts` throws away everything before the first `\n---` in a
 * markdown note, on the grounds that a provenance header is not coaching prose. Under a generated
 * pipeline that is backwards: the source, the patch and the date are the most valuable lines in
 * the block, because they are what lets a claim be dismissed by AGE rather than by vibe. So the
 * block this module renders puts its provenance IN the text, at the top, where the model reads it.
 *
 * ## Staleness is a state, not a warning nobody sees
 *
 * `stalenessWarning` in `./index.ts` already does this for hand-written notes. The same idea
 * applies harder here: a table fetched on 16.18 and read during a 16.20 game is not wrong, it is
 * UNVERIFIED, and the difference has to be said out loud rather than left for a reader to work
 * out from a version string.
 *
 * Node-friendly and browser-safe: this module is pure data and string work. The table it imports
 * is large, so nothing in `src/web/` should pull it in.
 */

import { itemOf } from "../shared/items.ts"
import {
	CHAMPION_ROWS,
	CHAMPION_TABLE_PATCH,
	CHAMPION_TABLE_SOURCES,
	RUNE_NAMES,
	SUMMONER_SPELL_NAMES
} from "./champion-table.ts"
import type { ChampionAbilityRow, ChampionRow, ChampionTier2Row } from "./champion-table.ts"

export type { ChampionAbilityRow, ChampionRow, ChampionTier2Row }
export { CHAMPION_ROWS, CHAMPION_TABLE_PATCH, CHAMPION_TABLE_SOURCES, RUNE_NAMES, SUMMONER_SPELL_NAMES }

/** `Bel'Veth` -> `belveth`, `Nunu & Willump` -> `nunuwillump`. Same key the markdown notes use. */
export const championKey = (name: string): string => name.toLowerCase().replace(/[^a-z]/g, "")

const BY_KEY = new Map<string, ChampionRow>(CHAMPION_ROWS.map(r => [r.key, r]))
const BY_APINAME = new Map<string, ChampionRow>(CHAMPION_ROWS.map(r => [r.apiname.toLowerCase(), r]))
const BY_ID = new Map<number, ChampionRow>(CHAMPION_ROWS.map(r => [r.id, r]))

/**
 * The row for a champion, or `null`.
 *
 * `null` is a normal state and must degrade to "say nothing champion-specific", never to a guess.
 * The client spells champions three different ways across its endpoints, so both the display name
 * and the apiname resolve here.
 */
export const championRow = (name: string): ChampionRow | null =>
	BY_KEY.get(championKey(name)) ?? BY_APINAME.get(name.toLowerCase()) ?? null

export const championRowById = (id: number): ChampionRow | null => BY_ID.get(id) ?? null

export const championCount = (): number => CHAMPION_ROWS.length

/* --------------------------------------------------------------- staleness */

/** `16.18.1` and `16.18.712.9876` are the same patch; `16.20` is not. */
const patchPair = (patch: string): string => patch.split(".").slice(0, 2).join(".")

/**
 * `null` when the table was fetched on the game's own patch; otherwise the sentence to put in
 * front of the model.
 *
 * Not a silent pass and not a refusal. A champion's kit is usually the same across two patches and
 * occasionally is not, and the only honest thing to do with that is say which patch the numbers
 * came from and let the reader discount them.
 */
export const championTableStaleness = (gamePatch: string): string | null => {
	if (gamePatch === "") return null
	const table = patchPair(CHAMPION_TABLE_PATCH)
	const game = patchPair(gamePatch)
	if (table === game) return null
	return (
		`These champion facts were fetched on patch ${CHAMPION_TABLE_PATCH} and this game is patch ${gamePatch}. ` +
		`Ability behaviour rarely moves between patches and numbers often do, so treat every figure below as ` +
		`the ${table} figure rather than as this game's, and say so rather than asserting it.`
	)
}

/* ---------------------------------------------------------- the provenance line */

const dateOf = (iso: string): string => (iso.length >= 10 ? iso.slice(0, 10) : iso)

/**
 * Where every number in the block came from, as one line the model can quote or discount.
 *
 * Revision ids are included because they are the only thing that makes a wiki claim checkable
 * after the fact: the page moves, the revision does not.
 */
export const championProvenance = (row: ChampionRow): string => {
	const parts = [
		`Riot Data Dragon patch ${CHAMPION_TABLE_SOURCES.ddragon.patch}, ` +
			`fetched ${dateOf(CHAMPION_TABLE_SOURCES.ddragon.fetchedAt)}`,
		`League of Legends Wiki ability data, revisions ` +
			`${row.abilities.map(a => a.wikiRevId).join("/")}, ` +
			`fetched ${dateOf(CHAMPION_TABLE_SOURCES.wikiAbilities.fetchedAt)}`
	]
	if (row.tier2)
		parts.push(
			`op.gg ${row.tier2.role} ${row.tier2.tier} on patch ${row.tier2.metaVersion}, ` +
				`fetched ${dateOf(row.tier2.fetchedAt)}`
		)
	return parts.join(" · ")
}

/*
 * THE RENDERER THAT USED TO LIVE HERE IS DELETED, 2026-09-19.
 *
 * `renderChampionKnowledge` turned a row into a markdown block with its own labels, its own
 * headings and its own idea of what each field means — a second renderer for the same data, beside
 * `champion-brief.ts`. Nothing imported it but this file's own test: the app reads
 * `knowledge/context/`, which is committed text, and the runtime has no renderer at all.
 *
 * It goes rather than staying dormant because a second labelling of the same numbers is a second
 * place to be wrong about them, and it WAS wrong in the same place the live path was: it labelled
 * the wiki's `speed` field "Missile speed" on all 308 abilities that carry one, where the wiki
 * documents it as "Speed of a missile OR DASH" and 89 of those abilities are dashes. One fix in
 * one place is the whole point of having one place.
 *
 * What survives here is lookup and provenance — `championRow`, `championRowById`,
 * `championTableStaleness`, `championProvenance`, `fetchedChampions` — none of which can produce a
 * sentence about League.
 */

/**
 * The champions with a fetched row, for the UI and for `doctor`.
 *
 * Parallel to `knownChampions()` in `./index.ts`, which lists hand-written markdown instead. Both
 * exist while the two knowledge paths do.
 */
export const fetchedChampions = (): string[] => CHAMPION_ROWS.map(r => r.name).sort()
