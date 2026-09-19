/**
 * The fence: a sentence reaches the model with its source attached, or it does not reach the model.
 *
 * ## Why this exists, in one measured paragraph
 *
 * `knowledge/champions/lillia.md` says Swirlseed "rolls over terrain" and "grants vision of what it
 * rolls past". Riot's own text for that ability, fetched 2026-09-18, says the seed "rolls until it
 * hits an enemy or collides with terrain", and the wiki says it "detonates upon hitting an enemy or
 * terrain while on the ground" and reveals the enemies it hits for 2 seconds. The file is wrong in
 * the one direction that matters — it invents a capability — and that clause licensed 38% of every
 * champion-specific live line and 7.3% of 1,075 stored post-game items before anyone checked it
 * (`data/eval/KNOWLEDGE-THESIS-20260918.md`).
 *
 * Nothing in the repo could have caught it. `parseChampionAdvice` refuses a clause with a digit, so
 * it validates FORM and never SUBJECT. `champion-claims.test.ts` writes down what each clause bets
 * on, which makes the bet explicit but is still a register of assertions, not a source. And the
 * blind judge is handed the same file, so a shared error grades as truth.
 *
 * The only thing that closes this is provenance: the text that ships must be mechanically
 * re-derivable from bytes that a named URL returned at a named time, and anything else must be
 * unable to get into the prompt by accident. That is what this module is.
 *
 * ## The shape of the fence
 *
 * 1. A `ClaimRecord` carries `text` AND the `evidence` it came from AND a `derivation` naming, from
 *    a CLOSED set of pure functions in this file, how one becomes the other. `checkClaim` re-runs
 *    that derivation. A claim whose text cannot be reproduced from its own evidence is refused —
 *    which is exactly what happens to the Swirlseed sentence when it is handed the bytes it cites.
 * 2. The derivation set is closed HERE, in the consumer, not in the fetcher. A fetcher that wants a
 *    new transform has to add it to this file, where it is reviewed and tested, rather than
 *    shipping a string and asserting it is faithful.
 * 3. The FIELD vocabulary is closed too, and each field is bound to a source tier. A tier-2
 *    aggregator cannot supply an ability cooldown and Riot cannot supply a win rate; a claim that
 *    crosses that line is refused rather than rendered.
 * 4. A rendered line can only be built by `renderClaimLine`, which takes a checked claim and its
 *    source and puts the citation in the line itself. There is no path that turns a bare string
 *    into a prompt line, which is the "make the wrong thing hard rather than documented" part.
 * 5. Everything rendered goes into a LEDGER, and `auditAssembled` compares a finished prompt
 *    section against that ledger line for line. A sentence no source produced shows up as
 *    `untraced`, whoever added it and however it got there.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not fetch (a colleague owns `scripts/fetch-champions.ts`), it does not decide what a
 * champion does, and it does not write prose. Its only opinions about League are the field names,
 * and a field name is not a claim. Every sentence about a champion that this module can emit came
 * out of `evidence` that a fetch put there.
 *
 * It also cannot tell whether a source is RIGHT. Riot can ship a wrong tooltip; the wiki can be
 * mid-edit. What it can do is make every sentence attributable and dated, so a wrong one is found
 * with `tracePhrase` in one command instead of a night, and so a claim can be dismissed by age.
 *
 * Browser-safe: no `node:` imports. The loader that reads the generated table is
 * `src/knowledge/champion-brief.ts` and is node-only.
 */

import { type } from "arktype"

/* ------------------------------------------------------------------------------ sources */

export const SOURCE_TIERS = ["tier1-mechanics", "tier2-aggregate", "owner-authored"] as const

export type SourceTier = (typeof SOURCE_TIERS)[number]

/**
 * One fetch. `revision` is whatever that publisher versions the world by — a patch for Data
 * Dragon, `meta.version` for op.gg, a page revid for the wiki — and it is required, because a
 * source that cannot state which version of the game it describes cannot be checked for staleness.
 */
export interface SourceRecord {
	id: string
	tier: SourceTier
	publisher: string
	/** The exact URL that was called, so the fetch can be repeated by hand. */
	url: string
	/** Patch, `meta.version`, or page revision. Never empty. */
	revision: string
	/** ISO 8601, so a claim can be dismissed by age rather than by argument. */
	fetchedAt: string
}

/**
 * Which hosts may back which tier.
 *
 * Narrower than `knowledge/SOURCES.md`'s domain list on purpose: that list governs a research agent
 * reading pages, this one governs machine-readable endpoints whose shape is validated. u.gg,
 * lolalytics and jungler.gg are absent because they were probed on 2026-09-18 and returned 403,
 * 404-behind-Cloudflare and DNS failure respectively — a host that cannot be fetched cannot be a
 * source, and leaving it in the allowlist invites prose that claims it.
 */
export const TIER_HOSTS: Record<SourceTier, readonly string[]> = {
	"tier1-mechanics": [
		"ddragon.leagueoflegends.com",
		"raw.communitydragon.org",
		"wiki.leagueoflegends.com"
	],
	"tier2-aggregate": ["lol-api-champion.op.gg", "op.gg", "www.op.gg"],
	/* Owner notes are not fetched; their "url" is the repo path he wrote them in. */
	"owner-authored": []
}

/* ------------------------------------------------------------------------------- fields */

/**
 * Every field a claim may occupy, what it is labelled in the prompt, and which tier may supply it.
 *
 * Closed on purpose. An open label is a hole the size of a paragraph: "note: she wants blue buff
 * more than most junglers" would sail through every other check in this file while being exactly
 * the model-authored judgment the owner banned. A field that does not exist here cannot be
 * rendered, so adding one is a reviewed code change with a test attached.
 *
 * `crossChecked` marks the three fields the fetcher must see agreed by two independent tier-1
 * sources before it writes them. That is the same discipline `scripts/fetch-items.ts` applies with
 * its 215/215 `price === gold.base` join: a disagreement means a patch landed mid-fetch or one
 * source is stale, and shipping either one alone is how a wrong number sounds like a right one.
 */
export interface FieldSpec {
	label: string
	tier: SourceTier
	/** Tier-2 fields are counts of real games and may not ship without their sample size. */
	requiresSample?: boolean
	/** Must be corroborated by a second tier-1 source. */
	crossChecked?: boolean
}

export const CLAIM_FIELDS = {
	"identity.title": { label: "title", tier: "tier1-mechanics" },
	"identity.resource": { label: "resource", tier: "tier1-mechanics" },
	"identity.range-type": { label: "melee or ranged", tier: "tier1-mechanics" },
	"identity.release": { label: "released in patch", tier: "tier1-mechanics" },
	"identity.last-changed": { label: "last changed in patch", tier: "tier1-mechanics" },
	"identity.positions": { label: "positions Riot's client lists", tier: "tier1-mechanics" },
	"identity.ratings": { label: "Riot's own ratings", tier: "tier1-mechanics" },

	"stat.base": { label: "base stat", tier: "tier1-mechanics" },

	"ability.name": { label: "name", tier: "tier1-mechanics", crossChecked: true },
	"ability.effect": { label: "what it does", tier: "tier1-mechanics" },
	"ability.damage": { label: "damage by rank", tier: "tier1-mechanics" },
	"ability.cooldown": { label: "cooldown", tier: "tier1-mechanics", crossChecked: true },
	"ability.cost": { label: "cost", tier: "tier1-mechanics", crossChecked: true },
	"ability.range": { label: "target range", tier: "tier1-mechanics" },
	"ability.radius": { label: "effect radius", tier: "tier1-mechanics" },
	"ability.width": { label: "width", tier: "tier1-mechanics" },
	/*
	 * The wiki documents this field as "Speed of a missile OR DASH", and 89 of the 308 abilities
	 * that carry one describe a dash rather than a projectile — Tristana's W, Xin Zhao's E,
	 * Rammus's R. Labelling all 308 "missile speed" made the LABEL a claim about the game that the
	 * source does not make, on a line whose value was copied correctly. The source's own words fit
	 * both.
	 */
	"ability.speed": { label: "missile or dash speed", tier: "tier1-mechanics" },
	/*
	 * The two cooldowns that were FETCHED and never delivered. The fetcher already reads `static`
	 * and `recharge` — it falls back to them when it cross-checks a slot's cooldown against Data
	 * Dragon — and then dropped them, so 51 abilities whose cooldown lives in `static` shipped with
	 * no cooldown line at all: Anivia's Rebirth is a 240-second egg and her file said nothing.
	 * The parenthetical on each label is the wiki's own documentation of the field, not a reading
	 * of it: "Static cooldown, not affected by ability haste" and "Recharge timer for stock
	 * abilities".
	 */
	"ability.static-cooldown": { label: "static cooldown, not affected by ability haste", tier: "tier1-mechanics" },
	"ability.recharge": { label: "recharge timer for a stocked charge", tier: "tier1-mechanics" },
	"ability.cast-time": { label: "cast time", tier: "tier1-mechanics" },
	"ability.cc": { label: "crowd control", tier: "tier1-mechanics" },
	"ability.targeting": { label: "targeting", tier: "tier1-mechanics" },
	"ability.damage-type": { label: "damage type", tier: "tier1-mechanics" },
	"ability.spellshield": { label: "spell shield", tier: "tier1-mechanics" },
	"ability.unit-modifier": { label: "damage to minions or monsters", tier: "tier1-mechanics" },
	"ability.note": { label: "edge case", tier: "tier1-mechanics" },

	"meta.winrate": { label: "win rate this patch", tier: "tier2-aggregate", requiresSample: true },
	"meta.skill-order": { label: "skill order", tier: "tier2-aggregate", requiresSample: true },
	"meta.runes": { label: "rune page", tier: "tier2-aggregate", requiresSample: true },
	"meta.core-items": { label: "core items", tier: "tier2-aggregate", requiresSample: true },
	"meta.boots": { label: "boots", tier: "tier2-aggregate", requiresSample: true },
	"meta.starter": { label: "starting items", tier: "tier2-aggregate", requiresSample: true },
	"meta.last-items": { label: "finished items", tier: "tier2-aggregate", requiresSample: true },
	"meta.summoners": { label: "summoner spells", tier: "tier2-aggregate", requiresSample: true },
	"meta.counter": { label: "win rate into", tier: "tier2-aggregate", requiresSample: true },
	"meta.game-length": { label: "win rate by game length", tier: "tier2-aggregate", requiresSample: true },
	"meta.trend": { label: "win rate over patches", tier: "tier2-aggregate", requiresSample: true },

	/**
	 * The one unsourceable channel, and it is the OWNER'S voice, not an agent's.
	 *
	 * Routes, gank conditions, spike timing and what an item purchase implies are real knowledge
	 * that no endpoint publishes (probed 2026-09-18: op.gg has no path/route/camp key anywhere in
	 * its payload, and `lillia.md`'s citation of "op.gg jungle-paths" points at an endpoint that
	 * does not exist). The honest options are to drop them or to mark them; the recommendation in
	 * `champion-brief.ts` is: drop them from any agent, allow them from him, and render them under
	 * a heading that says what they are.
	 */
	"judgment.note": { label: "unverified — the owner's own note", tier: "owner-authored" }
} as const satisfies Record<string, FieldSpec>

export type ClaimField = keyof typeof CLAIM_FIELDS

export const isClaimField = (s: string): s is ClaimField => s in CLAIM_FIELDS

/**
 * Where a claim sits in the rendered section. Closed, and rendered in this order — his own kit
 * first, then what the numbers say wins, because the kit is durable and the meta is not.
 */
export const CLAIM_GROUPS = [
	"identity",
	"stats",
	"passive",
	"Q",
	"W",
	"E",
	"R",
	"meta",
	"judgment"
] as const

export type ClaimGroup = (typeof CLAIM_GROUPS)[number]

/* ------------------------------------------------------------------------- derivations */

/**
 * How `text` is reproduced from `evidence`. A CLOSED set of pure functions, all implemented below.
 *
 * This is the load-bearing idea. Storing the evidence beside the claim proves a fetch happened;
 * re-running a named transform on it proves the SENTENCE came from that fetch rather than from
 * beside it. "The bytes are in the file and the sentence is above them" is how a paraphrase becomes
 * an invention with a citation attached.
 */
export type Derivation =
	/** `text` occurs inside `evidence`, byte for byte once whitespace and quotes are normalised. */
	| { kind: "verbatim" }
	/** `evidence` is JSON; the value at `path` stringifies to exactly `text`. */
	| { kind: "json"; path: string }
	/** `evidence` is JSON; the array at `path`, joined by `sep`, is exactly `text`. */
	| { kind: "json-join"; path: string; sep: string }
	/** `evidence` is JSON; the object at `path` rendered as `key<assign>value` pairs joined by `sep`. */
	| { kind: "json-entries"; path: string; sep: string; assign: string }
	/**
	 * `evidence` is JSON; the FRACTION at `path` as a percentage to `decimals` places.
	 *
	 * op.gg stores a win rate as 0.496722 and every reader of it writes 49.67%. Refusing that would
	 * push the conversion into the renderer, where nothing re-checks it — and a win rate off by a
	 * factor of a hundred is the kind of number that reads as fine.
	 */
	| { kind: "json-percent"; path: string; decimals: number }
	/** `evidence` is wiki template source; `field`, with templates resolved, is exactly `text`. */
	| { kind: "wikitext"; field: string }
	/** The owner wrote it. `text` is `evidence`; nothing external can corroborate it. */
	| { kind: "owner" }

/* -------------------------------------------------------------------------------- claims */

/**
 * Why a `crossChecked` field shipped on ONE source, from a closed set.
 *
 * Closed, and free text is deliberately not allowed, for the same reason `CLAIM_FIELDS` is closed:
 * an open reason field is a place to write an excuse, and an excuse that reads well is how an
 * uncorroborated number keeps shipping. Each entry names a property of the SOURCES — what Data
 * Dragon publishes — and says nothing about League, which is what makes it writable here at all.
 *
 * Both entries are measured on the committed 16.18.1 table, and the two populations are disjoint
 * and exhaustive over the 245 abilities Data Dragon's spell list does not reach: 181 passives and
 * 64 second forms.
 */
export const SOLE_SOURCE_REASONS = {
	"ddragon-publishes-no-passive": "Data Dragon lists a champion's passive outside `spells`, with no cooldown or cost array, so there is no second transcription of this value to compare against",
	"ddragon-publishes-one-form-per-slot": "Data Dragon publishes exactly one spell per Q/W/E/R slot, so a second form of the same slot has no counterpart in it to compare against"
} as const satisfies Record<string, string>

export type SoleSourceReason = keyof typeof SOLE_SOURCE_REASONS

export const isSoleSourceReason = (s: string): s is SoleSourceReason => s in SOLE_SOURCE_REASONS

export interface ClaimSample {
	games: number
	wins?: number
	/** The rank bracket op.gg was asked for. A tier-2 number without its bracket is not comparable. */
	bracket?: string
}

export interface ClaimRecord {
	/** Stable and greppable: `lillia.e.cooldown`. Also what `tracePhrase` reports. */
	id: string
	/** `championKey()` of the champion this is about. */
	subject: string
	group: ClaimGroup
	field: ClaimField
	/** What the model reads. Never written by hand; always reproduced from `evidence`. */
	text: string
	sourceId: string
	/** The bytes the fetch returned, kept so the claim can be re-checked with no network. */
	evidence: string
	derivation: Derivation
	/**
	 * Other source ids that INDEPENDENTLY PRODUCED THE SAME `text`. Not "no source contradicted it".
	 *
	 * The distinction is the whole of the 2026-09-19 fix. See `soleSource` below and the long note
	 * on `crossChecked` in `checkClaim`.
	 */
	agreesWith?: readonly string[]
	/**
	 * The other half of the corroboration answer: this claim has ONE source and here is the
	 * structural reason no second one could be consulted.
	 *
	 * A `crossChecked` field must carry `agreesWith` or this, and may not carry both. Before this
	 * existed, `claims-from-row.ts` inferred agreement from an EMPTY CONFLICT LIST — the fetcher
	 * cross-checks Data Dragon against the wiki and blanks a slot's numbers on disagreement, so
	 * `agreed === true` was read as "Data Dragon agreed". Measured on the committed 16.18.1 table
	 * (`node --experimental-strip-types scripts/…`, re-derivable from `CHAMPION_ROWS`): Data Dragon
	 * publishes one spell per non-passive slot, so of 937 abilities the cross-check reaches 692 and
	 * stops. The other 245 — 181 passives and 64 second forms, Lee Sin's Resonating Strike, Elise's
	 * spider-form Q — were transcribed from the wiki alone, nothing could be recorded as conflicting
	 * with them, and 294 claims (245 names, 29 cooldowns, 20 costs) were minted saying Data Dragon
	 * agreed when Data Dragon had said nothing at all.
	 */
	soleSource?: SoleSourceReason
	sample?: ClaimSample
}

/** A champion's whole fetched record. This is the contract `scripts/fetch-champions.ts` writes. */
/**
 * A field the sources HAVE and this app does not ship, and which group it belongs under.
 *
 * It is not a claim: it makes no statement about League, only about the fetch. It exists because a
 * withheld number and a number nobody publishes look identical in a file that says nothing about
 * either, and those are different facts about the world. `Hecarim Q` shipped with no name, no
 * cooldown and no damage line and no word about why; a reader of that file — human or model —
 * cannot tell it from an ability the wiki never documented.
 */
export interface WithheldNotice {
	group: ClaimGroup
	/**
	 * Which ability in the group, as `claims-from-row` numbers them — `r`, `r2`. A slot is not one
	 * ability: Jayce carries two R rows, one per stance, and a notice parked at the end of the group
	 * would read as being about whichever stance the reader was looking at.
	 */
	slotId: string
	/** The ability or field list this is about, as the table spells it. */
	fields: string
	kind: "disagreed" | "render"
}

export interface ChampionFacts {
	/** `championKey()` — lowercase letters only. */
	key: string
	/** Riot's api name, e.g. `MonkeyKing`. Kept so a row can be joined back to a fetch. */
	apiname: string
	displayName: string
	sources: readonly SourceRecord[]
	claims: readonly ClaimRecord[]
	/** What the fence dropped, so the file can SAY it dropped it. Never a claim. */
	withheld?: readonly WithheldNotice[]
}

/* -------------------------------------------------------------- the generated-table contract */

/**
 * ArkType at the boundary, because the generated module is an I/O boundary in every sense that
 * matters: it is written by a different program, on a schedule, from four endpoints that can change
 * shape without telling anyone.
 *
 * The repo's rule is that a feature which cannot fail loudly will fail silently for a month, and a
 * stale or malformed build recommendation reads exactly like a fresh one. So this validates, and
 * `champion-brief.ts` fails closed on what it rejects.
 */
export const SourceRecordSchema = type({
	id: "string",
	tier: "'tier1-mechanics'|'tier2-aggregate'|'owner-authored'",
	publisher: "string",
	url: "string",
	revision: "string",
	fetchedAt: "string"
})

export const DerivationSchema = type({ kind: "'verbatim'" })
	.or({ kind: "'json'", path: "string" })
	.or({ kind: "'json-join'", path: "string", sep: "string" })
	.or({ kind: "'json-entries'", path: "string", sep: "string", assign: "string" })
	.or({ kind: "'json-percent'", path: "string", decimals: "number" })
	.or({ kind: "'wikitext'", field: "string" })
	.or({ kind: "'owner'" })

export const ClaimRecordSchema = type({
	id: "string",
	subject: "string",
	group: "string",
	field: "string",
	text: "string",
	sourceId: "string",
	evidence: "string",
	derivation: DerivationSchema,
	"agreesWith?": "string[]",
	/*
	 * A string here rather than the literal union, so a table written by a fetcher that learned a
	 * new reason validates and is then refused BY NAME in `checkClaim` with the reason printed.
	 * A schema failure would reject the whole row and lose every claim in it.
	 */
	"soleSource?": "string",
	"sample?": { games: "number", "wins?": "number", "bracket?": "string" }
})

export const ChampionFactsSchema = type({
	key: "string",
	apiname: "string",
	displayName: "string",
	sources: SourceRecordSchema.array(),
	claims: ClaimRecordSchema.array()
})

export const ChampionFactsTableSchema = ChampionFactsSchema.array()

/* --------------------------------------------------------------------------- normalising */

/**
 * The comparison used everywhere a claim is checked against its evidence.
 *
 * Case-insensitive and whitespace-collapsed because the same sentence arrives from three publishers
 * with three typographies — Riot writes "Lillia lobs a swirlseed", the wiki writes "'''Lillia'''
 * lobs a seed" — and refusing a claim over a curly apostrophe would push the fetcher toward looser
 * derivations, which is the opposite of the point. Nothing here changes a word or a number.
 */
export const normalise = (s: string): string =>
	s
		.normalize("NFKC")
		.replace(/[‘’ʼ]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/[‐-―−]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()

/* ----------------------------------------------------------------------- wikitext, resolved */

/**
 * What to do with each wiki template, by name. Anything not listed REFUSES the claim.
 *
 * Refusing on an unknown template is the whole discipline. The alternative — strip the braces and
 * keep the arguments — is how `{{tt|120|Lobbed and rolling seed missile width}}` becomes
 * "120 Lobbed and rolling seed missile width" in a coaching line, and how a hidden named parameter
 * becomes a sentence. If a new template appears, someone adds a rule here and a test with it.
 *
 * - `first` / `last`: keep that positional argument ({{tt|120|note}} is the number; {{tip|slow|
 *   slowing}} is the display text).
 * - `slash`: a double value, rendered the way the wiki renders it ({{dv|700|Global}}).
 * - `colon`: a labelled value ({{st|Magic Damage|60 to 160 (+ 50% AP)}}).
 * - `drop`: contributes nothing (icons).
 */
export const TEMPLATE_RULES: Record<string, "first" | "last" | "slash" | "colon" | "drop"> = {
	sbc: "first",
	ci: "first",
	cai: "first",
	as: "first",
	ap: "first",
	ad: "first",
	fd: "first",
	tt: "first",
	pp: "first",
	nay: "first",
	dv: "slash",
	st: "colon",
	tip: "last",
	sti: "colon",
	g: "first"
}

const INNERMOST_TEMPLATE = /\{\{([^{}]*)\}\}/

/**
 * Resolve wiki templates to the text the wiki renders, or `null` if anything is unrecognised.
 *
 * Innermost first, repeatedly, so nesting resolves without a parser:
 * `{{dv|{{tt|700|Lob range}}|{{tt|Global|Roll}}}}` -> `{{dv|700|Global}}` -> `700 / Global`.
 */
export const resolveWikitext = (raw: string): string | null => {
	let s = raw.replace(/<!--[\s\S]*?-->/g, "")
	// `[[File: ...]]` and `[[Page|label]]`: the label is what a reader sees.
	s = s.replace(/\[\[File:[^\]]*\]\]/gi, "")
	s = s.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2").replace(/\[\[([^\]]*)\]\]/g, "$1")
	// Unresolved template PARAMETERS ({{{1|...}}}) mean this wikitext was never meant to stand alone.
	if (/\{\{\{/.test(s)) return null

	for (let guard = 0; guard < 200; guard++) {
		const m = INNERMOST_TEMPLATE.exec(s)
		if (!m) {
			const out = s
				.replace(/'''/g, "")
				.replace(/''/g, "")
				.replace(/\s+/g, " ")
				.trim()
			// A stray tag or brace left over means something was not understood. Refuse.
			return /[{}]|<[a-zA-Z/]/.test(out) ? null : out
		}
		const body = m[1] ?? ""
		const parts = body.split("|")
		const name = (parts[0] ?? "").trim().toLowerCase()
		const rule = TEMPLATE_RULES[name]
		if (!rule) return null
		const args = parts.slice(1).map(a => a.trim())
		// A named argument is configuration, never content: `{{tip|er|icononly = true}}` is an icon.
		const positional = args.filter(a => !a.includes("="))
		const iconOnly = args.some(a => /icononly/i.test(a))
		const value =
			rule === "drop" || iconOnly ? ""
			: rule === "first" ? (positional[0] ?? "")
			: rule === "last" ? (positional[positional.length - 1] ?? "")
			: rule === "slash" ? positional.join(" / ")
			: positional.join(": ")
		s = s.slice(0, m.index) + value + s.slice(m.index + m[0].length)
	}
	return null
}

/** One `|field = value` out of an ability-data template, unresolved. */
export const wikitextField = (raw: string, field: string): string | null => {
	const lines = raw.split("\n")
	const want = field.trim().toLowerCase()
	let collecting = false
	const out: string[] = []
	for (const line of lines) {
		if (collecting) {
			if (/^\s*\|/.test(line) || /^\s*\}\}/.test(line)) break
			out.push(line)
			continue
		}
		const m = /^\s*\|\s*([^=|]+?)\s*=\s*(.*)$/.exec(line)
		if (!m) continue
		if ((m[1] ?? "").trim().toLowerCase() !== want) continue
		collecting = true
		out.push(m[2] ?? "")
	}
	return collecting ? out.join("\n").trim() : null
}

/* ------------------------------------------------------------------------ the check itself */

const jsonPath = (value: unknown, path: string): unknown => {
	let cur: unknown = value
	for (const seg of path.split(".")) {
		if (cur === null || cur === undefined) return undefined
		if (Array.isArray(cur)) {
			const i = Number(seg)
			if (!Number.isInteger(i)) return undefined
			cur = cur[i]
			continue
		}
		if (typeof cur !== "object") return undefined
		cur = (cur as Record<string, unknown>)[seg]
	}
	return cur
}

const stringifyLeaf = (v: unknown): string | null =>
	typeof v === "string" ? v
	: typeof v === "number" || typeof v === "boolean" ? String(v)
	: null

/**
 * Re-run a claim's derivation against its own evidence. `null` means it reproduces; a string is the
 * reason it does not, phrased for a human reading a failing test at midnight.
 */
export const recheckDerivation = (claim: ClaimRecord): string | null => {
	const d = claim.derivation
	if (d.kind === "verbatim")
		return normalise(claim.evidence).includes(normalise(claim.text)) ? null : (
			`text does not occur in its own evidence (${claim.text.slice(0, 80)})`
		)
	if (d.kind === "owner")
		return normalise(claim.evidence) === normalise(claim.text) ? null : (
			"owner note does not match the file it was read from"
		)
	if (d.kind === "json" || d.kind === "json-join" || d.kind === "json-entries" || d.kind === "json-percent") {
		let parsed: unknown
		try {
			parsed = JSON.parse(claim.evidence)
		} catch {
			return "evidence is not JSON"
		}
		const at = jsonPath(parsed, d.path)
		if (at === undefined) return `no value at ${d.path} in the evidence`
		if (d.kind === "json") {
			const leaf = stringifyLeaf(at)
			if (leaf === null) return `value at ${d.path} is not a scalar`
			return normalise(leaf) === normalise(claim.text) ? null : (
				`value at ${d.path} is ${JSON.stringify(leaf)}, claim says ${JSON.stringify(claim.text)}`
			)
		}
		if (d.kind === "json-percent") {
			if (typeof at !== "number") return `value at ${d.path} is not a number`
			const pct = `${(at * 100).toFixed(d.decimals)}%`
			return normalise(pct) === normalise(claim.text) ? null : (
				`value at ${d.path} is ${pct}, claim says ${JSON.stringify(claim.text)}`
			)
		}
		if (d.kind === "json-entries") {
			if (at === null || typeof at !== "object" || Array.isArray(at))
				return `value at ${d.path} is not an object`
			const pairs: string[] = []
			for (const [k, v] of Object.entries(at as Record<string, unknown>)) {
				const leaf = stringifyLeaf(v)
				if (leaf === null) return `entry ${k} at ${d.path} is not a scalar`
				pairs.push(`${k}${d.assign}${leaf}`)
			}
			const rendered = pairs.join(d.sep)
			return normalise(rendered) === normalise(claim.text) ? null : (
				`object at ${d.path} renders as ${JSON.stringify(rendered.slice(0, 120))}, claim says ${JSON.stringify(claim.text.slice(0, 120))}`
			)
		}
		if (!Array.isArray(at)) return `value at ${d.path} is not an array`
		const parts = at.map(stringifyLeaf)
		if (parts.some(p => p === null)) return `array at ${d.path} holds a non-scalar`
		const joined = parts.join(d.sep)
		return normalise(joined) === normalise(claim.text) ? null : (
			`array at ${d.path} joins to ${JSON.stringify(joined)}, claim says ${JSON.stringify(claim.text)}`
		)
	}
	const field = wikitextField(claim.evidence, d.field)
	if (field === null) return `no |${d.field} field in the evidence`
	const resolved = resolveWikitext(field)
	if (resolved === null) return `|${d.field} carries a template this module does not resolve`
	return normalise(resolved) === normalise(claim.text) ? null : (
		`|${d.field} resolves to ${JSON.stringify(resolved.slice(0, 120))}, claim says ${JSON.stringify(claim.text.slice(0, 120))}`
	)
}

/** Riot's tooltips carry `<magicDamage>` tags and `{{ slowamount*100 }}` holes. Neither may ship. */
const UNRESOLVED = /\{\{|\}\}|\[\[|<[a-zA-Z/][^>]*>/

const hostOf = (url: string): string | null => {
	try {
		return new URL(url).host
	} catch {
		return null
	}
}

/**
 * Everything that must be true before a claim may be rendered. `null` is a pass.
 *
 * Ordered so the cheapest structural failures report first: a caller reading the first line of a
 * diagnostic should learn the most actionable thing.
 */
export const checkClaim = (
	claim: ClaimRecord,
	sources: ReadonlyMap<string, SourceRecord>
): string | null => {
	if (claim.id.trim() === "") return "claim has no id"
	if (claim.text.trim() === "") return `${claim.id}: empty text`
	if (!isClaimField(claim.field)) return `${claim.id}: unknown field ${claim.field}`
	if (!(CLAIM_GROUPS as readonly string[]).includes(claim.group))
		return `${claim.id}: unknown group ${claim.group}`
	if (UNRESOLVED.test(claim.text))
		return `${claim.id}: text still carries unresolved markup, which is how a placeholder becomes a number`

	const spec: FieldSpec = CLAIM_FIELDS[claim.field]
	const source = sources.get(claim.sourceId)
	if (!source) return `${claim.id}: cites source ${claim.sourceId}, which is not in the record`
	if (source.tier !== spec.tier)
		return `${claim.id}: ${claim.field} is a ${spec.tier} field and ${source.id} is ${source.tier}`
	if (source.url.trim() === "" || source.revision.trim() === "" || source.fetchedAt.trim() === "")
		return `${claim.id}: source ${source.id} is missing a url, a revision or a fetch time`
	if (Number.isNaN(Date.parse(source.fetchedAt)))
		return `${claim.id}: source ${source.id} has an unparseable fetchedAt (${source.fetchedAt})`
	if (source.tier !== "owner-authored") {
		const host = hostOf(source.url)
		if (host === null) return `${claim.id}: source ${source.id} has no parseable URL`
		if (!TIER_HOSTS[source.tier].includes(host))
			return `${claim.id}: ${host} is not a sanctioned host for ${source.tier}`
	}
	if (spec.requiresSample && (claim.sample === undefined || claim.sample.games <= 0))
		return `${claim.id}: ${claim.field} is a count of real games and may not ship without its sample size`
	/*
	 * ## What `crossChecked` requires, and why it is NOT "two sources agreed"
	 *
	 * It requires the claim to STATE what happened with the second source, from a closed set, and
	 * refuses silence. It does not require agreement, and the decision to stop short of that is the
	 * one a later reader will want to argue with, so here is the argument.
	 *
	 * The old test was `agreesWith` non-empty, and `claims-from-row.ts` satisfied it by INFERRING
	 * agreement from an empty conflict list: the fetcher compares Data Dragon against the wiki and
	 * blanks a slot's name, cooldown and cost when they disagree, so `agreed === true` was read as
	 * "Data Dragon agreed". Measured over the committed 16.18.1 `CHAMPION_ROWS`: 937 abilities, of
	 * which Data Dragon's `spells` array reaches 692. The other 245 are 181 passives (Riot files a
	 * passive outside `spells`) and 64 second forms of a slot (Lee Sin's Resonating Strike, Elise's
	 * spider-form Q), and NOTHING could be recorded as conflicting with them. 294 claims — 245
	 * names, 29 cooldowns, 20 costs — carried `agreesWith: ["ddragon"]` on a source that said
	 * nothing. Nobody was ever told a wrong thing by it, because `agreesWith` never reaches a
	 * prompt; the GATE was weaker than its name, which is a different defect and still a defect.
	 *
	 * ### Why the gate does not simply refuse those 294
	 *
	 * Refusing them is the move that looks principled and costs truth. It would delete the NAME of
	 * every passive in the corpus — 245 lines across 173 champion files, "The Darkin Scythe" off
	 * `kayn.md` — for zero gain in honesty, because:
	 *
	 * 1. The delivered LINE was never the thing that lied. Each of those 245 already ends in the
	 *    single wiki revision it was copied from (`[wiki-p rev-4053172, fetched 2026-09-18]`), which
	 *    is one source, visibly. Nothing in the file ever claimed two.
	 * 2. "Uncorroborated" here means NO SECOND PUBLISHER EXISTS, not "the second publisher was not
	 *    asked". A rule whose effect is "Riot files passives differently, so this app may not say
	 *    what a passive is called" is a rule about Riot's JSON layout wearing the clothes of a rule
	 *    about truth.
	 * 3. The error this fence was built for — `lillia.md`'s Swirlseed rolling over terrain — was an
	 *    INVENTED CAPABILITY, not an uncorroborated name, and it would have been refused here by
	 *    `recheckDerivation` regardless of any second source.
	 * 4. These lines are already checked by an instrument that shares no code with this one:
	 *    `scripts/verify-fetched.ts --articles` compares the delivered value against the rendered
	 *    wiki article a human reads.
	 *
	 * So the gate asks for the thing it can actually get — an explicit, closed-vocabulary statement
	 * of the corroboration state — and refuses a claim that states nothing. That is strictly
	 * stronger than the old test in the way that matters: `agreesWith` can no longer be minted by
	 * inference, because `claims-from-row.ts` now has to decide, per slot, whether Data Dragon
	 * published anything at all.
	 *
	 * If a later reader wants the strict gate anyway, the change is to make the `soleSource` branch
	 * return a refusal instead of `null`. Before doing it, price it: 294 claims and 245 passive
	 * names leave the corpus, and `knowledge/context/` must be regenerated in the same commit.
	 */
	if (spec.crossChecked) {
		const agrees = claim.agreesWith !== undefined && claim.agreesWith.length > 0
		const sole = claim.soleSource !== undefined
		if (agrees && sole)
			return `${claim.id}: ${claim.field} says both that a second source agreed and that no second source exists, and only one of those can be true`
		if (!agrees && !sole)
			return `${claim.id}: ${claim.field} must say what happened with the second tier-1 source — either agreesWith, or soleSource naming why there is no second one`
		if (sole && !isSoleSourceReason(claim.soleSource!))
			return `${claim.id}: ${claim.soleSource} is not one of the ${Object.keys(SOLE_SOURCE_REASONS).length} recorded reasons a tier-1 field can ship on one source`
	}
	if (spec.tier === "owner-authored" && claim.derivation.kind !== "owner")
		return `${claim.id}: an owner note must use the owner derivation`
	if (spec.tier !== "owner-authored" && claim.derivation.kind === "owner")
		return `${claim.id}: the owner derivation cannot back a fetched field`

	return recheckDerivation(claim)
}

/* ------------------------------------------------------------------------------ rendering */

const SOURCED = Symbol.for("eepalytics.knowledge.sourced-line")

/**
 * A line that is allowed into a prompt. The only constructors are in this file, and both of them
 * either validate a claim or draw from a frozen structural template.
 *
 * The brand is a runtime symbol rather than a TypeScript-only marker because `--experimental-strip-
 * types` erases types: a compile-time brand would be a comment by the time the code runs, and the
 * whole point is that an unsourced string cannot reach the renderer even through `any`.
 */
export interface SourcedLine {
	readonly [SOURCED]: true
	readonly text: string
	readonly origin: LineOrigin
}

export type LineOrigin =
	| { kind: "claim"; claimId: string; sourceId: string }
	| { kind: "structure"; template: StructureId }

export const isSourcedLine = (v: unknown): v is SourcedLine =>
	typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[SOURCED] === true

export class ProvenanceError extends Error {}

const mint = (text: string, origin: LineOrigin): SourcedLine => ({
	[SOURCED]: true,
	text,
	origin
})

const sampleText = (s: ClaimSample | undefined): string => {
	if (!s) return ""
	const wins = s.wins === undefined ? "" : `, ${s.wins.toLocaleString("en-US")} wins`
	const bracket = s.bracket ? `, ${s.bracket}` : ""
	return ` (n=${s.games.toLocaleString("en-US")} games${wins}${bracket})`
}

/**
 * One claim, as the model sees it: label, value, sample, and the citation IN the line.
 *
 * The citation is inline rather than in a footnote because a model reading a mixed prompt weighs a
 * sentence by what is attached to it, and because the audit is a line-for-line comparison — a
 * citation that lives somewhere else is a citation that can be separated from its claim by an edit.
 *
 * Throws on an unchecked claim. There is no soft path: a renderer that returns `null` for a bad
 * claim invites a caller that ignores it.
 */
export const renderClaimLine = (
	claim: ClaimRecord,
	sources: ReadonlyMap<string, SourceRecord>
): SourcedLine => {
	const reason = checkClaim(claim, sources)
	if (reason !== null) throw new ProvenanceError(reason)
	const source = sources.get(claim.sourceId)!
	const label = CLAIM_FIELDS[claim.field].label
	const cite = `[${source.id} ${source.revision}, fetched ${source.fetchedAt.slice(0, 10)}]`
	/*
	 * A claim's text may carry newlines — a wiki description runs to paragraphs — and a prompt line
	 * is a line. Folding them is a layout change and nothing else: `checkClaim` has already compared
	 * the text to its evidence, and the audit compares lines, so a claim that spanned three of them
	 * could never be traced back to the ledger entry that produced it.
	 */
	const folded = claim.text.replace(/\s*\n\s*/g, " ").trim()
	return mint(`- ${label}: ${folded}${sampleText(claim.sample)} ${cite}`, {
		kind: "claim",
		claimId: claim.id,
		sourceId: claim.sourceId
	})
}

/**
 * The only non-claim text allowed in the section, frozen here so a reviewer sees any change to it
 * as a diff in this file rather than as a sentence appearing in a prompt.
 *
 * Every one of these is about PROVENANCE or LAYOUT. None of them says anything about League, which
 * is the line this module draws: the fetcher supplies the game, this file supplies the scaffolding.
 * `provenance.test.ts` pins them as literals for exactly that reason.
 */
export const STRUCTURE_TEMPLATES = {
	"section.heading": (v: { champion: string }) =>
		`## ${v.champion.toUpperCase()} — FETCHED FACTS (copied from the sources named on each line)`,
	"section.preamble": () =>
		"Every line below was copied from the source in brackets at the end of it, on the date shown. " +
		"Nothing here was written from memory. If something you want to say is not on a line here, no " +
		"source published it — say less rather than filling the gap.",
	"group.heading": (v: { title: string }) => `### ${v.title}`,
	"owner.heading": () => "### UNVERIFIED — his own notes, not fetched from anywhere",
	"owner.warning": () =>
		"The lines under this heading have no source. They are the owner's own judgment, written by " +
		"him on the date shown. Treat them as opinion you may act on, never as a fact you may assert.",
	/*
	 * The two WITHHELD notices. They say that a value exists upstream and is not here, and they say
	 * which one — nothing about League, which is why they may be written down in this file at all.
	 * Both end on the same sentence because the reader's next move is the same either way: this app
	 * does not know the number, so nothing may be said about it.
	 *
	 * `group.withheld.render` was REWORDED on 2026-09-19 and the old words are recorded here so the
	 * change is arguable rather than invisible. It used to read "the wiki's own expansion of the
	 * field came back broken", which was true of the two cases it then covered — a field carrying
	 * an `Expression error`, a Lua `nil` or surviving wikitext — and became FALSE the moment it also
	 * had to cover the flattened-table drop, where the wiki's expansion succeeded and it was the
	 * HTML-to-text flattening downstream of it that lost the rows and columns. Blaming the wiki for
	 * our own renderer is exactly the small untruth this module exists to refuse, so the sentence
	 * now names the stage rather than the party, and the `fields` slot carries which case it is.
	 *
	 * A THIRD `kind` was the obvious alternative and is not available: `champion-brief.ts` picks the
	 * template with `notice.kind === "disagreed" ? disagreed : render`, so any new kind silently
	 * renders as this one. Adding one is a one-line change there, in a file this change did not own.
	 */
	"group.withheld.disagreed": (v: { fields: string }) =>
		`- WITHHELD (${v.fields}): Data Dragon and the wiki disagree about it on this patch, so no value is shown. This app does not know what it is — say nothing about it.`,
	"group.withheld.render": (v: { fields: string }) =>
		`- WITHHELD (${v.fields}): the source publishes it and it did not survive being rendered into plain text, so no value is shown. This app does not know what it is — say nothing about it.`,

	"sources.heading": () => "### Where this section came from",
	"sources.line": (v: { source: SourceRecord; claims: number }) =>
		`- ${v.source.id}: ${v.source.publisher}, revision ${v.source.revision}, fetched ${v.source.fetchedAt.slice(0, 10)} — ${v.claims} line${v.claims === 1 ? "" : "s"} — ${v.source.url}`,

	/*
	 * The five below exist for the PRE-GENERATED context tree in `knowledge/context/`, which is
	 * committed text rather than something a running app renders. They are here and not in the
	 * generator for one reason: this table is the whole of the unsourced vocabulary, it is pinned
	 * literal-for-literal by `provenance.test.ts`, and a second table somewhere else would be a
	 * second place a sentence about League could enter without a reviewer seeing it as a diff.
	 */
	"general.heading": () => "# GENERAL CONTEXT — where every champion line in this app comes from",
	/*
	 * The two clauses after `broken` were added on 2026-09-19 and are the corpus-level half of the
	 * two fixes landed that day. They are here rather than in the champion files because both are
	 * facts about the PIPELINE, and because a line added to a champion file that `championBrief`
	 * did not mint shows up as `untraced` in `auditAssembled` — the ledger is built from the
	 * renderer's own lines, so the generator cannot add a sentence to a file after the fact.
	 */
	"general.patch": (v: {
		patch: string
		champions: number
		claims: number
		withheld: number
		broken: number
		tableCells: number
		soleSourced: number
	}) =>
		`Patch ${v.patch}. ${v.champions} champions, ${v.claims} checked lines, ${v.withheld} ability slot${v.withheld === 1 ? "" : "s"} withheld because two sources disagreed about the name, the cooldown or the cost, ${v.broken} field${v.broken === 1 ? "" : "s"} withheld because the wiki's own expansion of it came back broken, and ${v.tableCells} cell${v.tableCells === 1 ? "" : "s"} of tables inside the wiki's notes withheld because the rows and columns did not survive being flattened to text — a header and its value arrived as two separate lines and neither says anything on its own. ${v.soleSourced} of the checked lines rest on ONE tier-1 source rather than two, because Data Dragon files a passive outside its spell list and publishes only the first form of each slot; each of those lines names the single wiki revision it was copied from.`,
	/*
	 * The negative half, and it is the honest one. Every entry names a CATEGORY that was probed for
	 * and came back empty — it is a statement about sources, not about League, which is why it can
	 * be written down here at all. The probes are recorded in `knowledge/SOURCES.md`.
	 */
	"general.silent": () =>
		"NOT PUBLISHED ANYWHERE, so this app says nothing about it: jungle clear routes and camp order; " +
		"gank-failure conditions; how to read a clear's tempo; what an item purchase implies about intent; " +
		"objective-pressure narrative; power-spike timing; matchup advice as distinct from matchup win " +
		"rate; where a champion tends to die. Each was probed for and each came back empty — u.gg 403, " +
		"lolalytics behind a challenge, mobalytics needs auth, blitz DNS-dead, and Riot's own allytips " +
		"and enemytips return empty arrays. None of it was written to fill the gap, and a gap is the " +
		"correct output.",
	"role.none": (v: { role: string }) =>
		`Nothing here. No source this app fetches publishes anything about the ${v.role} role, and nothing was written to stand in for one. If the coach wants to say something about this role, it is saying it out of its own head and should say less instead.`,

	blank: () => ""
} as const

export type StructureId = keyof typeof STRUCTURE_TEMPLATES

/** The structural half of the renderer. Same brand, closed vocabulary, no arguments but its own. */
export const structureLine = <K extends StructureId>(
	id: K,
	...args: Parameters<(typeof STRUCTURE_TEMPLATES)[K]>
): SourcedLine =>
	mint((STRUCTURE_TEMPLATES[id] as (...a: unknown[]) => string)(...args), {
		kind: "structure",
		template: id
	})

/* ------------------------------------------------------------------------ assembly + audit */

export interface Assembled {
	text: string
	lines: readonly SourcedLine[]
	claims: readonly ClaimRecord[]
	sources: readonly SourceRecord[]
}

/**
 * Join minted lines into the block that goes in the prompt.
 *
 * Refuses anything that is not a `SourcedLine` at RUNTIME, not just in the type system. A caller
 * that has a string and a good reason has to go and get a source for it, which is the entire
 * design: the wrong thing is hard, not merely discouraged.
 */
export const assemble = (
	lines: readonly SourcedLine[],
	claims: readonly ClaimRecord[],
	sources: readonly SourceRecord[]
): Assembled => {
	for (const [i, line] of lines.entries())
		if (!isSourcedLine(line))
			throw new ProvenanceError(
				`line ${i} was not produced by renderClaimLine or structureLine, so nothing knows where it came from`
			)
	return { text: lines.map(l => l.text).join("\n"), lines, claims, sources }
}

export interface SourceUsage {
	source: SourceRecord
	claims: number
}

export interface AuditReport {
	ok: boolean
	claimLines: number
	structureLines: number
	/** Lines present in the text that no ledger entry produced. This is the alarm. */
	untraced: string[]
	/** Ledger lines the text no longer contains — an edit that dropped something. */
	missing: string[]
	usage: SourceUsage[]
	/** The oldest fetch anything in this section rests on, so a section can be dismissed by age. */
	oldestFetchedAt: string | null
	revisions: string[]
	unsourcedClaims: number
}

/**
 * What is this prompt section standing on?
 *
 * Takes the TEXT as a separate argument from the ledger on purpose. The interesting failure is not
 * "the renderer built something odd" — the renderer refuses that. It is "something was appended,
 * templated in, or edited into the block after it was built", which is how the Swirlseed sentence
 * would arrive today: from a file, through a concatenation, into a prompt. Comparing the delivered
 * bytes against the ledger catches that whatever inserted it.
 */
export const auditAssembled = (text: string, assembled: Assembled): AuditReport => {
	const ledger = new Map<string, LineOrigin>()
	for (const line of assembled.lines) if (line.text.trim() !== "") ledger.set(line.text, line.origin)

	const untraced: string[] = []
	const seen = new Set<string>()
	let claimLines = 0
	let structureLines = 0
	for (const raw of text.split("\n")) {
		const line = raw.trimEnd()
		if (line.trim() === "") continue
		const origin = ledger.get(line)
		if (!origin) {
			untraced.push(line)
			continue
		}
		seen.add(line)
		if (origin.kind === "claim") claimLines += 1
		else structureLines += 1
	}
	const missing = [...ledger.keys()].filter(l => !seen.has(l))

	const byId = new Map(assembled.sources.map(s => [s.id, s]))
	const counts = new Map<string, number>()
	for (const c of assembled.claims) counts.set(c.sourceId, (counts.get(c.sourceId) ?? 0) + 1)
	const usage: SourceUsage[] = []
	for (const [id, n] of counts) {
		const source = byId.get(id)
		if (source) usage.push({ source, claims: n })
	}
	usage.sort((a, b) => b.claims - a.claims)

	const dates = assembled.sources.map(s => s.fetchedAt).filter(d => !Number.isNaN(Date.parse(d)))
	dates.sort()

	return {
		ok: untraced.length === 0 && missing.length === 0,
		claimLines,
		structureLines,
		untraced,
		missing,
		usage,
		oldestFetchedAt: dates[0] ?? null,
		revisions: [...new Set(assembled.sources.map(s => `${s.id} ${s.revision}`))].sort(),
		unsourcedClaims: assembled.claims.filter(
			c => CLAIM_FIELDS[c.field]?.tier === "owner-authored"
		).length
	}
}

export interface Trace {
	claim: ClaimRecord
	source: SourceRecord | null
}

/**
 * Find the next Swirlseed in one command.
 *
 * Given an assembled section and a phrase — "terrain", "vision", "bonus damage to monsters" — this
 * returns every claim carrying it with the URL, the revision and the fetch date that put it there,
 * plus the evidence to read. The night it took to establish that one sentence in `lillia.md` was
 * false is the cost this function removes.
 */
export const tracePhrase = (assembled: Assembled, phrase: string): Trace[] => {
	const needle = normalise(phrase)
	if (needle === "") return []
	const byId = new Map(assembled.sources.map(s => [s.id, s]))
	return assembled.claims
		.filter(c => normalise(c.text).includes(needle))
		.map(c => ({ claim: c, source: byId.get(c.sourceId) ?? null }))
}

/**
 * The verdict on a body of prose that carries no per-claim provenance — i.e. on everything in
 * `knowledge/champions/` today.
 *
 * Deliberately a REPORT rather than a throw. The hand-written files still ship while the fetched
 * table is built, and a function that refused to look at them would leave the question "how much of
 * this is sourced?" answerable only by reading 232KB. The answer it gives today is zero of them,
 * and that number belongs in a test where it can change when the pipeline lands.
 */
export interface ProseTrace {
	sentences: number
	traced: number
	untraced: string[]
}

export const traceProse = (prose: string, assembled: Assembled | null): ProseTrace => {
	const sentences = prose
		.split("\n")
		.map(l => l.replace(/^[-*>#\s]+/, "").trim())
		.filter(l => l !== "")
		.flatMap(l => l.split(/(?<=[.!?])\s+(?=[A-Z"'*])/))
		.map(s => s.trim())
		.filter(s => s.length > 24)
	const claims = assembled?.claims ?? []
	const untraced: string[] = []
	let traced = 0
	for (const s of sentences) {
		const bare = normalise(s.replace(/[*_`]/g, ""))
		if (claims.some(c => normalise(c.text).includes(bare))) traced += 1
		else untraced.push(s)
	}
	return { sentences: sentences.length, traced, untraced }
}
