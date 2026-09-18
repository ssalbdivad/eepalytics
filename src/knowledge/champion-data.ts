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

/* ------------------------------------------------------------------ rendering */

const line = (label: string, value: string): string | null => (value.trim() === "" ? null : `${label}: ${value}`)

const join = (parts: (string | null)[], sep: string): string => parts.filter(p => p !== null && p !== "").join(sep)

const SLOT_LABEL: Record<ChampionAbilityRow["slot"], string> = {
	P: "Passive",
	Q: "Q",
	W: "W",
	E: "E",
	R: "R (ultimate)"
}

const renderAbility = (a: ChampionAbilityRow): string => {
	const out: string[] = [`### ${SLOT_LABEL[a.slot]} — ${a.name}`]
	// Riot's own wording and the wiki's own wording, both verbatim and both attributed, because they
	// are independent transcriptions and a reader who can see both can see when one is thin.
	if (a.riotTooltip !== "") out.push(`Riot's tooltip, verbatim: ${a.riotTooltip}`)
	else if (a.riotSummary !== "") out.push(`Riot's description, verbatim: ${a.riotSummary}`)
	if (a.wikiDescription !== "") out.push(`Wiki, with the numbers filled in: ${a.wikiDescription}`)
	for (const l of a.leveling) out.push(l)

	const stats = join(
		[
			line("Cooldown", a.cooldown),
			line("Cost", join([a.cost, a.costType], " ")),
			line("Target range", a.targetRange),
			line("Cast time", a.castTime),
			line("Effect radius", a.effectRadius),
			line("Width", a.width),
			line("Missile speed", a.speed),
			line("Queue threshold", a.queueThreshold)
		],
		" · "
	)
	if (stats !== "") out.push(stats)

	const shape = join(
		[
			line("Targeting", a.targeting),
			line("Affects", a.affects),
			line("Damage type", a.damageType),
			line("Projectile", a.projectile),
			line("Spell shield", a.spellShield)
		],
		" · "
	)
	if (shape !== "") out.push(shape)

	if (a.notes.length > 0) out.push(["Wiki notes on this ability:", ...a.notes.map(n => `- ${n}`)].join("\n"))
	// A withheld number is stated as withheld. Silence here would read as "there is no cooldown".
	if (!a.agreed)
		out.push(
			`NUMBERS WITHHELD on this ability: Data Dragon and the wiki disagree (${a.conflicts.join("; ")}), ` +
				`so no figure for it is quotable. Say the behaviour, not the number.`
		)
	return out.join("\n")
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`

const itemNames = (ids: number[]): string =>
	ids.map(id => itemOf(id)?.name ?? `item ${id}`).join(" → ")

/**
 * Tier 2 — what is built, maxed and won with. Counts only.
 *
 * Every figure carries its sample, and nothing here is turned into advice. op.gg publishes that
 * Lillia loses 53% into Shyvana; it publishes nothing at all about WHY or what to do, and the gap
 * between those two is exactly where a model starts writing coaching out of its own head.
 */
const runeName = (id: number): string => RUNE_NAMES[id] ?? `rune ${id}`
const spellName = (ids: number[]): string => ids.map(id => SUMMONER_SPELL_NAMES[id] ?? `spell ${id}`).join(" + ")

const renderTier2 = (t: ChampionTier2Row): string => {
	const out: string[] = [
		`## What actually wins on this patch (op.gg, ${t.role.toLowerCase()}, ${t.tier}, patch ${t.metaVersion})`,
		`These are COUNTS from ranked games, not opinions, and they say what is picked and what wins — ` +
			`never why. ${t.play.toLocaleString()} games: ${pct(t.winRate)} win, ${pct(t.pickRate)} pick, ` +
			`${pct(t.banRate)} ban` +
			(t.opggTier !== null ? `, op.gg tier ${t.opggTier} rank ${t.opggRank}` : "") +
			(t.opggRankPrevPatch !== null ? ` (rank ${t.opggRankPrevPatch} last patch)` : "") +
			"."
	]
	if (t.skillOrder)
		out.push(
			`Skill order, ${t.skillOrder.play.toLocaleString()} games / ${t.skillOrder.win.toLocaleString()} wins: ` +
				t.skillOrder.order.join(" ")
		)
	const build = (label: string, rows: { ids: number[]; play: number; win: number }[]): void => {
		for (const r of rows.slice(0, 3))
			out.push(`${label}: ${itemNames(r.ids)} — ${r.play.toLocaleString()} games, ${r.win.toLocaleString()} wins`)
	}
	build("Starter", t.starterItems)
	build("Boots", t.boots)
	build("Core", t.coreItems)
	build("Most-finished item", t.lastItems)
	for (const s of t.summonerSpells.slice(0, 2))
		out.push(`Summoners: ${spellName(s.ids)} — ${s.play.toLocaleString()} games, ${s.win.toLocaleString()} wins`)
	if (t.runePage)
		out.push(
			`Runes, ${t.runePage.play.toLocaleString()} games / ${t.runePage.win.toLocaleString()} wins: ` +
				`keystone ${runeName(t.runePage.keystone)}; ` +
				`${runeName(t.runePage.primaryTree)} — ${t.runePage.primaryRunes.map(runeName).join(", ")}; ` +
				`${runeName(t.runePage.secondaryTree)} — ${t.runePage.secondaryRunes.map(runeName).join(", ")}; ` +
				// Riot publishes no name table for the stat shards, so they stay ids and are labelled as
				// ids. Naming them from memory is exactly the move this whole pipeline exists to stop.
				`stat shard ids (Riot publishes no names for these): ${t.runePage.shards.join(", ")}`
		)
	if (t.counters.length > 0)
		out.push(
			`Win rate INTO other champions (a rate, not advice — nothing here says why): ` +
				t.counters
					.map(c => {
						const foe = championRowById(c.championId)
						return `${foe?.name ?? `champion ${c.championId}`} ${pct(c.win / Math.max(1, c.play))} of ${c.play}`
					})
					.join(", ")
		)
	if (t.trend.length > 1)
		out.push(`Win rate by patch: ${t.trend.map(p => `${p.version} ${pct(p.rate)}`).join(", ")}`)
	return out.join("\n")
}

const STAT_LINES: [key: string, label: string, growth: string | null][] = [
	["hp_base", "HP", "hp_lvl"],
	["mp_base", "resource", "mp_lvl"],
	["dam_base", "attack damage", "dam_lvl"],
	["arm_base", "armour", "arm_lvl"],
	["mr_base", "magic resist", "mr_lvl"],
	["as_base", "base attack speed", "as_lvl"],
	["range", "attack range", null],
	["ms", "move speed", null]
]

export interface RenderOptions {
	/** The game's patch, so the block can say it is speaking for a different one. */
	gamePatch?: string
	/** `false` drops the op.gg section — the tier whose source has no terms grant. */
	tier2?: boolean
}

/**
 * The whole sourced block for one champion, as markdown.
 *
 * Returns `null` when the champion is not in the table, which is the correct output for a champion
 * nobody fetched: a coach with no notes still coaches the role and the numbers, and that is a far
 * better failure than a coach handed prose somebody made up.
 */
export const renderChampionKnowledge = (name: string, opts: RenderOptions = {}): string | null => {
	const row = championRow(name)
	if (!row) return null
	const out: string[] = [`# ${row.name} — ${row.title}`]

	out.push(
		`EVERY LINE BELOW WAS FETCHED, NOT WRITTEN. Sources: ${championProvenance(row)}. ` +
			`If something about this champion is not in this block, it was not published by any of those ` +
			`sources and you do not know it — say so rather than filling the gap.`
	)
	const stale = opts.gamePatch ? championTableStaleness(opts.gamePatch) : null
	if (stale) out.push(`STALE: ${stale}`)

	out.push("## Identity")
	out.push(
		join(
			[
				row.rangeType,
				row.resource === "" ? null : `${row.resource} user`,
				row.positions.length > 0 ? `client position ${row.positions.join(", ")}` : null,
				row.roles.length > 0 ? `wiki role ${row.roles.join(", ")}` : null,
				row.releasePatch === "" ? null : `released ${row.releasePatch}`,
				row.lastChangedPatch === "" ? null : `last changed ${row.lastChangedPatch}`
			],
			" · "
		)
	)
	const stats = STAT_LINES.map(([key, label, growth]) => {
		const base = row.stats[key]
		if (base === undefined) return null
		const g = growth ? row.stats[growth] : undefined
		return `${base}${g === undefined ? "" : ` (+${g}/lvl)`} ${label}`
	})
	const statLine = join(stats, " · ")
	if (statLine !== "") out.push(`Base stats: ${statLine}`)

	if (row.abilities.length > 0) {
		out.push("## Abilities")
		for (const a of row.abilities) out.push(renderAbility(a))
	}

	if (opts.tier2 !== false && row.tier2) out.push(renderTier2(row.tier2))

	return out.join("\n\n")
}

/**
 * The champions with a fetched row, for the UI and for `doctor`.
 *
 * Parallel to `knownChampions()` in `./index.ts`, which lists hand-written markdown instead. Both
 * exist while the two knowledge paths do.
 */
export const fetchedChampions = (): string[] => CHAMPION_ROWS.map(r => r.name).sort()
