/**
 * Turn the GENERATED champion table into checked claims.
 *
 * `scripts/fetch-champions.ts` writes `src/knowledge/champion-table.ts` as one row per champion,
 * with the fetch recorded at TABLE level (`CHAMPION_TABLE_SOURCES`) and a wiki revision recorded per
 * ability. That shape is good for a renderer and not quite enough for a fence: a fence needs to know
 * which URL each SENTENCE came from, and a table-level header cannot say that.
 *
 * So this module does the attribution, and it does it only where the table's own header is
 * unambiguous about who supplied what:
 *
 * - ability prose, numbers and notes -> the wiki's ability template, cited with that ability's own
 *   `wikiRevId`, because the header says those fields are the wiki's expansion and nothing else in
 *   the pipeline produces them;
 * - identity, base stats, release and last-changed patch, positions -> `Module:ChampionData/data`,
 *   which the header names for exactly those fields;
 * - win rate and skill order -> op.gg, with op.gg's own sample sizes attached.
 *
 * Everything else in the table is deliberately NOT adapted, and the omissions are the honest part:
 *
 * - `ratings` is in the row and is named in no source line of the header, so nothing here can say
 *   where it came from. A claim whose provenance is a guess is the thing this module exists to stop.
 * - `riotSummary` and `riotTooltip` are Riot's words but the tooltip still carries
 *   `{{ placeholders }}`, and `checkClaim` refuses unresolved markup — correctly, since a
 *   placeholder that reaches a model is a number waiting to be invented. The wiki's expansion says
 *   the same things with the numbers filled in, so nothing is lost.
 * - item, rune and summoner-spell builds are ID LISTS that only become sentences after a join
 *   against another generated table. That join belongs where the join lives; the corpus audit in
 *   `knowledge-audit.ts` is what checks it. Adding a derivation here that reads a second table would
 *   put a second table's provenance inside this one's claims.
 * - counters, trends and game-length curves are arrays of objects that only become a sentence by
 *   being composed, and a composition is a sentence nobody published.
 *
 * The result is that the MECHANICS half of a champion becomes per-claim sourced — which is the half
 * where being wrong is expensive, and the half where `lillia.md` was wrong.
 *
 * Browser-safe: pure data. NODE ONLY in practice, because the table it adapts is large.
 */

import { type } from "arktype"
import type { ChampionFacts, ClaimGroup, ClaimRecord, SourceRecord, WithheldNotice } from "./provenance.ts"

/**
 * What this module needs from a row, validated at the boundary because the fetcher is a separate
 * program on its own schedule. Deliberately a SUBSET: a field the fetcher adds cannot break this,
 * and a field it renames simply stops producing claims, loudly, rather than producing wrong ones.
 */
export const AbilityRowShape = type({
	slot: "string",
	name: "string",
	"wikiDescription?": "string",
	"leveling?": "string[]",
	"cooldown?": "string",
	"staticCooldown?": "string",
	"recharge?": "string",
	"cost?": "string",
	"costType?": "string",
	"targetRange?": "string",
	"castTime?": "string",
	"effectRadius?": "string",
	"width?": "string",
	"speed?": "string",
	"targeting?": "string",
	"damageType?": "string",
	"spellShield?": "string",
	"notes?": "string[]",
	"wikiTitle?": "string",
	"wikiRevId?": "number",
	"agreed?": "boolean",
	"withheld?": "string[]"
})

export const ChampionRowShape = type({
	key: "string",
	"apiname?": "string",
	name: "string",
	"title?": "string",
	"resource?": "string",
	"rangeType?": "string",
	"positions?": "string[]",
	"releasePatch?": "string",
	"lastChangedPatch?": "string",
	"stats?": "Record<string, number>",
	abilities: AbilityRowShape.array(),
	"tier2?": "unknown"
})

export const TableSourcesShape = type({
	ddragon: { url: "string", patch: "string", fetchedAt: "string" },
	wikiModule: { url: "string", fetchedAt: "string" },
	wikiAbilities: { "api?": "string", fetchedAt: "string" }
})

const Tier2Shape = type({
	sourceUrl: "string",
	metaVersion: "string",
	fetchedAt: "string",
	"tier?": "string",
	"play?": "number",
	"winRate?": "number",
	"skillOrder?": { order: "string[]", play: "number", win: "number" }
})

const SLOT_GROUP: Record<string, ClaimGroup> = { P: "passive", Q: "Q", W: "W", E: "E", R: "R" }

const wikiPageUrl = (title: string): string =>
	`https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=${encodeURIComponent(title)}&prop=text`

export interface AdaptResult {
	facts: ChampionFacts
	/** Fields present in the row that produced no claim, and why. Never swallowed. */
	skipped: string[]
}

/**
 * One row -> one `ChampionFacts`, with every claim carrying the URL, revision and fetch time of the
 * source the table's header attributes it to.
 *
 * Nothing here is checked: `checkClaim` in `provenance.ts` is the single place that decides what may
 * ship, and running it twice with two implementations is how the two drift apart. What this does is
 * ATTRIBUTE. The loader checks.
 */
export const factsFromRow = (rawRow: unknown, rawSources: unknown): AdaptResult | null => {
	const row = ChampionRowShape(rawRow)
	if (row instanceof type.errors) return null
	const tableSources = TableSourcesShape(rawSources)
	if (tableSources instanceof type.errors) return null

	const skipped: string[] = []
	const sources: SourceRecord[] = []
	const claims: ClaimRecord[] = []
	const withheld: WithheldNotice[] = []

	/* ------------------------------------------------------------------ identity and stats */

	const wikiModule: SourceRecord = {
		id: "wikiModule",
		tier: "tier1-mechanics",
		publisher: "League of Legends Wiki, Module:ChampionData/data",
		url: tableSources.wikiModule.url,
		/*
		 * The module is served with `action=raw` and publishes no revision id, so the fetch date IS
		 * the revision. Saying that out loud beats leaving the field to look like a version.
		 */
		revision: `raw@${tableSources.wikiModule.fetchedAt.slice(0, 10)}`,
		fetchedAt: tableSources.wikiModule.fetchedAt
	}
	sources.push(wikiModule)

	const identity = {
		title: row.title ?? "",
		resource: row.resource ?? "",
		rangeType: row.rangeType ?? "",
		positions: row.positions ?? [],
		releasePatch: row.releasePatch ?? "",
		lastChangedPatch: row.lastChangedPatch ?? "",
		stats: row.stats ?? {}
	}
	const identityEvidence = JSON.stringify(identity)
	const idClaim = (
		id: string,
		field: ClaimRecord["field"],
		text: string,
		derivation: ClaimRecord["derivation"]
	): void => {
		if (text.trim() === "") {
			skipped.push(`${row.key}.${id}: the table has no value for it`)
			return
		}
		claims.push({
			id: `${row.key}.${id}`,
			subject: row.key,
			group: id.startsWith("stat") ? "stats" : "identity",
			field,
			text,
			sourceId: "wikiModule",
			evidence: identityEvidence,
			derivation
		})
	}

	idClaim("title", "identity.title", identity.title, { kind: "json", path: "title" })
	idClaim("resource", "identity.resource", identity.resource, { kind: "json", path: "resource" })
	idClaim("rangetype", "identity.range-type", identity.rangeType, { kind: "json", path: "rangeType" })
	idClaim("positions", "identity.positions", identity.positions.join(", "), {
		kind: "json-join",
		path: "positions",
		sep: ", "
	})
	idClaim("release", "identity.release", identity.releasePatch, { kind: "json", path: "releasePatch" })
	/*
	 * Its OWN field, not a second `identity.release`. Both lines used to carry the label
	 * "released / last changed", so Lillia's file said that twice — once with V10.15 and once with
	 * V26.08 — and nothing in the text said which was which. A reader who takes the second line is
	 * told she was released two years from now.
	 */
	idClaim("lastchanged", "identity.last-changed", identity.lastChangedPatch, {
		kind: "json",
		path: "lastChangedPatch"
	})
	const statText = Object.entries(identity.stats)
		.map(([k, v]) => `${k} ${v}`)
		.join(", ")
	idClaim("stats", "stat.base", statText, {
		kind: "json-entries",
		path: "stats",
		sep: ", ",
		assign: " "
	})

	/* ----------------------------------------------------------------------------- abilities */

	/*
	 * A slot is not unique: Jayce carries two R rows, one per stance, and both are real abilities. So
	 * the claim id and the per-ability source id are numbered on the second and later occurrence,
	 * because two claims sharing an id would silently overwrite each other in any ledger that keys by
	 * it — and the second stance is exactly the kind of thing a coach gets wrong.
	 */
	const slotSeen = new Map<string, number>()
	for (const ability of row.abilities) {
		const group = SLOT_GROUP[ability.slot]
		if (!group) {
			skipped.push(`${row.key}: ability slot ${ability.slot} is not one of P/Q/W/E/R`)
			continue
		}
		const revId = ability.wikiRevId
		const title = ability.wikiTitle
		if (revId === undefined || title === undefined) {
			skipped.push(`${row.key}.${ability.slot}: no wiki revision recorded, so nothing can cite it`)
			continue
		}
		const nth = (slotSeen.get(ability.slot) ?? 0) + 1
		slotSeen.set(ability.slot, nth)
		const slotId = `${ability.slot.toLowerCase()}${nth === 1 ? "" : nth}`
		const sourceId = `wiki-${slotId}`
		sources.push({
			id: sourceId,
			tier: "tier1-mechanics",
			publisher: "League of Legends Wiki, ability data template",
			url: wikiPageUrl(title),
			revision: `rev-${revId}`,
			fetchedAt: tableSources.wikiAbilities.fetchedAt
		})
		const evidence = JSON.stringify(ability)
		const push = (
			suffix: string,
			field: ClaimRecord["field"],
			text: string | undefined,
			derivation: ClaimRecord["derivation"],
			extra: Partial<ClaimRecord> = {}
		): void => {
			if (text === undefined || text.trim() === "") return
			claims.push({
				id: `${row.key}.${slotId}.${suffix}`,
				subject: row.key,
				group,
				field,
				text,
				sourceId,
				evidence,
				derivation,
				...extra
			})
		}

		/*
		 * Name, cooldown and cost are the three fields the fetcher cross-checks between Data Dragon
		 * and the wiki, and it BLANKS the numbers on a slot where they disagreed. So `agreed` is the
		 * corroboration this fence requires; without it the three fields simply do not ship, which is
		 * the same answer the fetcher already reached by blanking them.
		 */
		const agreed = ability.agreed === true
		if (agreed) {
			push("name", "ability.name", ability.name, { kind: "json", path: "name" }, {
				agreesWith: ["ddragon"]
			})
			push("cooldown", "ability.cooldown", ability.cooldown, { kind: "json", path: "cooldown" }, {
				agreesWith: ["ddragon"]
			})
			push("cost", "ability.cost", ability.cost, { kind: "json", path: "cost" }, {
				agreesWith: ["ddragon"]
			})
			/*
			 * NOT marked `agreesWith`, deliberately. The fetcher compares Data Dragon's cooldown
			 * against `cooldown || static || recharge`, so whichever of the three it actually used
			 * was corroborated and the other two were not looked at. They ride the slot's `agreed`
			 * flag — a slot with any disagreement ships none of them — without claiming a second
			 * source read the specific number on the line.
			 */
			push("static", "ability.static-cooldown", ability.staticCooldown, {
				kind: "json",
				path: "staticCooldown"
			})
			push("recharge", "ability.recharge", ability.recharge, { kind: "json", path: "recharge" })
		} else {
			skipped.push(
				`${row.key}.${slotId}: sources disagreed, so name/cooldown/cost withheld`
			)
			withheld.push({ group, fields: "name, cooldown, cost", kind: "disagreed" })
		}
		/*
		 * A field the wiki could not expand. The fetcher records WHICH ones rather than leaving the
		 * table's empty string to mean two different things, and this is where that reaches the page
		 * the model reads.
		 */
		const broken = (ability.withheld ?? []).map(w => w.split(":")[0]!.trim()).filter(w => w !== "")
		if (broken.length > 0) {
			skipped.push(`${row.key}.${slotId}: the wiki's expansion broke, so ${broken.join(", ")} withheld`)
			withheld.push({ group, fields: broken.join(", "), kind: "render" })
		}

		push("effect", "ability.effect", ability.wikiDescription, {
			kind: "json",
			path: "wikiDescription"
		})
		if (ability.leveling && ability.leveling.length > 0)
			push("damage", "ability.damage", ability.leveling.join(" · "), {
				kind: "json-join",
				path: "leveling",
				sep: " · "
			})
		push("range", "ability.range", ability.targetRange, { kind: "json", path: "targetRange" })
		push("casttime", "ability.cast-time", ability.castTime, { kind: "json", path: "castTime" })
		push("radius", "ability.radius", ability.effectRadius, { kind: "json", path: "effectRadius" })
		push("width", "ability.width", ability.width, { kind: "json", path: "width" })
		push("speed", "ability.speed", ability.speed, { kind: "json", path: "speed" })
		push("targeting", "ability.targeting", ability.targeting, { kind: "json", path: "targeting" })
		push("damagetype", "ability.damage-type", ability.damageType, { kind: "json", path: "damageType" })
		push("spellshield", "ability.spellshield", ability.spellShield, {
			kind: "json",
			path: "spellShield"
		})
		for (const [i, note] of (ability.notes ?? []).entries())
			push(`note${i + 1}`, "ability.note", note, { kind: "json", path: `notes.${i}` })
	}

	/* ---------------------------------------------------------------------------- what wins */

	const tier2 = row.tier2 === undefined ? null : Tier2Shape(row.tier2)
	if (tier2 !== null && !(tier2 instanceof type.errors)) {
		sources.push({
			id: "opgg",
			tier: "tier2-aggregate",
			publisher: "op.gg",
			url: tier2.sourceUrl,
			revision: tier2.metaVersion,
			fetchedAt: tier2.fetchedAt
		})
		const evidence = JSON.stringify(tier2)
		const bracket = tier2.tier
		if (tier2.winRate !== undefined && tier2.play !== undefined)
			claims.push({
				id: `${row.key}.meta.winrate`,
				subject: row.key,
				group: "meta",
				field: "meta.winrate",
				text: `${(tier2.winRate * 100).toFixed(2)}%`,
				sourceId: "opgg",
				evidence,
				derivation: { kind: "json-percent", path: "winRate", decimals: 2 },
				sample: { games: tier2.play, bracket }
			})
		const skill = tier2.skillOrder
		if (skill)
			claims.push({
				id: `${row.key}.meta.skill-order`,
				subject: row.key,
				group: "meta",
				field: "meta.skill-order",
				text: skill.order.join(" > "),
				sourceId: "opgg",
				evidence,
				derivation: { kind: "json-join", path: "skillOrder.order", sep: " > " },
				sample: { games: skill.play, wins: skill.win, bracket }
			})
	} else if (row.tier2 !== undefined && row.tier2 !== null)
		skipped.push(`${row.key}: the op.gg block did not match its expected shape, so no tier-2 claims`)

	return {
		facts: {
			key: row.key,
			apiname: row.apiname ?? row.name,
			displayName: row.name,
			sources,
			claims,
			withheld
		},
		skipped
	}
}
