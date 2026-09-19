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

/**
 * The `fields` string a flattened-table notice carries, so the count can be read back.
 *
 * Exported and matched rather than re-derived: `generate-context.ts` prints a corpus-level total in
 * `general.md`, and a second implementation of the detector there would be a second thing that can
 * disagree with this one about what a table cell is.
 */
export const FLATTENED_TABLE_FIELDS = /^(\d+) cells of a table in the wiki's notes$/

/** How many wiki-table cells were withheld across a set of champion records. */
export const flattenedTableCells = (facts: Iterable<ChampionFacts>): number => {
	let n = 0
	for (const f of facts)
		for (const notice of f.withheld ?? []) {
			const m = FLATTENED_TABLE_FIELDS.exec(notice.fields)
			if (m) n += Number(m[1])
		}
	return n
}

/** How many shipped claims rest on one tier-1 source because no second one publishes the field. */
export const soleSourcedClaims = (facts: Iterable<ChampionFacts>): number => {
	let n = 0
	for (const f of facts) for (const c of f.claims) if (c.soleSource !== undefined) n += 1
	return n
}

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
		 *
		 * ## `agreed` is NOT the same statement on every slot, and until 2026-09-19 it was treated
		 * as though it were
		 *
		 * `agreed` is the absence of a recorded conflict, and an absence means two different things
		 * depending on whether there was ever anything to conflict WITH. Data Dragon's `spells`
		 * array holds one entry per Q/W/E/R slot and files the passive separately with no cooldown
		 * or cost arrays, so the fetcher's cross-check reaches the FIRST form of each non-passive
		 * slot and stops. Counted over the committed 16.18.1 table: 937 abilities, 692 reached, and
		 * 245 not — 181 passives and 64 second forms of a slot, Lee Sin's Resonating Strike, Elise's
		 * spider-form Q, Jayce's second R. On those 245 nothing could have been recorded as
		 * conflicting, and this file minted `agreesWith: ["ddragon"]` on 294 claims — 245 names, 29
		 * cooldowns, 20 costs — saying a source agreed that had not been asked.
		 *
		 * It never reached a prompt (`agreesWith` is read only by `checkClaim`), so no one was told
		 * anything wrong. What was wrong is that the GATE could be satisfied by an inference. Now
		 * the two cases are distinguished HERE, where the row knows which it is, and the claim
		 * carries the answer rather than the inference. The gate's side of the argument — why the
		 * 294 still ship rather than being refused — is written out at `crossChecked` in
		 * `provenance.ts`.
		 */
		const agreed = ability.agreed === true
		/*
		 * Derived from the row rather than from a fetcher flag on purpose: `slot` and `nth` are the
		 * two facts that decide whether Data Dragon published a counterpart, both are already here,
		 * and a second flag written upstream would be a second thing that can disagree with this.
		 */
		const ddragonPublished = ability.slot !== "P" && nth === 1
		const corroboration: Partial<ClaimRecord> =
			ddragonPublished ? { agreesWith: ["ddragon"] }
			: { soleSource: ability.slot === "P" ? "ddragon-publishes-no-passive" : "ddragon-publishes-one-form-per-slot" }
		if (agreed) {
			push("name", "ability.name", ability.name, { kind: "json", path: "name" }, corroboration)
			push("cooldown", "ability.cooldown", ability.cooldown, { kind: "json", path: "cooldown" }, corroboration)
			push("cost", "ability.cost", ability.cost, { kind: "json", path: "cost" }, corroboration)
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
			withheld.push({ group, slotId, fields: "name, cooldown, cost", kind: "disagreed" })
		}
		/*
		 * A field the wiki could not expand. The fetcher records WHICH ones rather than leaving the
		 * table's empty string to mean two different things, and this is where that reaches the page
		 * the model reads.
		 */
		const broken = (ability.withheld ?? []).map(w => w.split(":")[0]!.trim()).filter(w => w !== "")
		if (broken.length > 0) {
			skipped.push(`${row.key}.${slotId}: the wiki's expansion broke, so ${broken.join(", ")} withheld`)
			withheld.push({ group, slotId, fields: broken.join(", "), kind: "render" })
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
		/*
		 * ## The wiki's notes carry TABLES, and a table does not survive being flattened to a list
		 *
		 * `htmlToText` in `scripts/fetch-champions.ts` turns `</th>` into ": " and `</tr>` into a
		 * newline, which is right for every other shape the notes take and wrong for a table laid
		 * out with its header cells in their own rows. Those arrive as three consecutive notes — the
		 * header, a bare ":", and the value — so one wiki table row became three claim lines and
		 * none of them says anything:
		 *
		 *     - edge case: Attacking [wiki-p rev-4053172, fetched 2026-09-18]
		 *     - edge case: : [wiki-p rev-4053172, fetched 2026-09-18]
		 *     - edge case: Disabled [wiki-p rev-4053172, fetched 2026-09-18]
		 *
		 * Measured over the committed 16.18.1 corpus before this landed: 2,116 bare-":" lines across
		 * 87 champion files (118,575 bytes), and 6,006 of the 13,205 `edge case` lines — 17.4% of all
		 * 34,433 delivered claim lines — with a value of 25 characters or fewer. The top values were
		 * "Disabled" x681, "Interrupted by" x465, "Usable" x402, "N/A" x363 and the six column
		 * headers at x155 each. None of it is FALSE and every line carries its revision; it is the
		 * other failure this repo names — true and useless — sitting in the prompt at scale, worst
		 * on `ambessa.md` (78 bare colons), `tahmkench.md` (69) and `briar.md` (67). It missed
		 * `lillia.md` entirely, which is why nobody noticed.
		 *
		 * ## Why the header is not rejoined to its value, which was the first thing tried
		 *
		 * `notes[i-1] + notes[i] + " " + notes[i+1]` reads "Attacking: Disabled" and looks free. It
		 * is not: on 319 of the 2,113 triples (15.1%) the header is ITSELF the value of the triple
		 * before it, because the wiki table has nested or merged cells. Kayn's passive flattens to
		 * `Items / : / Usable / : / N/A`, so the triple reading ships both "Items: Usable" and
		 * "Usable: N/A" and at most one of those is a pairing the wiki makes. A 15% rate of invented
		 * pairings is worse than the 8.0% mechanical error rate that got the hand-written corpus
		 * deleted, and the pairing would arrive wearing a revision id. Nothing in the stored
		 * evidence recovers the table's shape — the fetch cache holds the already-flattened text,
		 * not the HTML — so the join cannot be done without composing, and composing is the one
		 * thing this pipeline may not do.
		 *
		 * ## And the whole run goes, not just the bare colon
		 *
		 * Dropping only the ":" would leave "Attacking" and "Disabled" as two separate sourced
		 * lines, which is the same defect one line shorter. The long cells are the stronger case,
		 * not the weaker one: 76 of the cells end in a full stop — "Umbral Dash can be cast. Other
		 * abilities are disabled.", "Registers input for Drakehound's Step." — and a table cell
		 * severed from its header is a statement whose CONDITION has been deleted. "Disabled" is
		 * useless; "Other abilities are disabled." is a general claim about the champion that the
		 * wiki never made. So a note is dropped if it is a bare ":" or if it is adjacent to one,
		 * which removes 6,026 lines in 157 runs across 87 files and leaves the sentence that
		 * introduces the table ("The following table refers for interactions while Kayn is
		 * transforming:") standing, followed by the WITHHELD notice that says where the rest went.
		 *
		 * Note ids are the note's own index and are NOT renumbered, so a surviving line keeps the id
		 * it had before this filter existed.
		 *
		 * ## What this does NOT catch, measured, so nobody re-derives it from scratch
		 *
		 * 473 `edge case` lines of the 7,179 that survive still have a value of 25 characters or
		 * fewer — down from 6,006 of 13,205 — and they are two different things. Most are the wiki
		 * saying something short and self-contained ("No additional details." x22), which is true,
		 * useless and NOT this defect: dropping it would be a judgment about usefulness rather than
		 * about structure, and this filter only claims to know about structure.
		 *
		 * 48 of them are the real residue: a table cell that got separated from its own separator by
		 * a `<br>`. Kayn's R ends `"Interrupted by" / ":" / "Death" / "Cast-inhibiting effects"` —
		 * the last cell held two lines, the `<br>` between them became a note boundary, and the
		 * second line is two notes away from the ":" and therefore survives. ("Cast-inhibiting
		 * effects" x53 is the single commonest residual value in the corpus.)
		 *
		 * The obvious extension — take the transitive closure, keep absorbing notes adjacent to a
		 * dropped one — was NOT taken, and it is not a close call: the note immediately BEFORE the
		 * first header is the sentence that introduces the table ("The following table refers for
		 * interactions while Kayn is transforming:"), which is a real, whole, useful claim, and the
		 * closure would eat it in every one of the 157 runs. A forward-only closure would need a
		 * rule for when to stop, every candidate rule is a guess about sentence-hood, and the trade
		 * is 48 lines against the risk of silently deleting real notes.
		 *
		 * The fix that actually closes it is upstream and outside this file: `htmlToText` in
		 * `scripts/fetch-champions.ts` turns `</th>` into ": " and `<br>` into a newline, so a table
		 * row is shredded before anything here sees it. Emitting one line per `<tr>` would let the
		 * header and value arrive joined by the WIKI, which is the only party allowed to join them,
		 * and this filter would then find nothing and cost nothing. That is a change to the fetcher
		 * and a re-fetch, and it is not done.
		 */
		const notes = ability.notes ?? []
		const isSeparator = (n: string | undefined): boolean => n !== undefined && n.trim() === ":"
		const droppedNotes = notes.filter(
			(note, i) => isSeparator(note) || isSeparator(notes[i - 1]) || isSeparator(notes[i + 1])
		).length
		for (const [i, note] of notes.entries()) {
			if (isSeparator(note) || isSeparator(notes[i - 1]) || isSeparator(notes[i + 1])) continue
			push(`note${i + 1}`, "ability.note", note, { kind: "json", path: `notes.${i}` })
		}
		if (droppedNotes > 0) {
			/*
			 * Phrased as a property of the SOURCE DOCUMENT — a table in the notes — and never as a
			 * claim about what the table was about, which this app does not know once the rows are
			 * gone. The substring "a table in the wiki's notes" is what `generate-context.ts` counts
			 * for the corpus-level figure in `general.md`; the two other diagnostic shapes here are
			 * counted by "sources disagreed" and "expansion broke", and none of the three collide.
			 */
			skipped.push(
				`${row.key}.${slotId}: a table in the wiki's notes lost its rows and columns when it was flattened to text, so ${droppedNotes} cells withheld`
			)
			withheld.push({
				group,
				slotId,
				fields: `${droppedNotes} cells of a table in the wiki's notes`,
				kind: "render"
			})
		}
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
