/**
 * Vendor the CHAMPION table the coach needs, from sources that publish it — the way
 * `scripts/fetch-items.ts` already vendors the item table.
 *
 * ## Why this file exists at all
 *
 * `knowledge/champions/*.md` was 232KB of prose written by a model out of its own head. It was
 * never wrong in a way anything here could catch, because the only thing that ever read it back
 * was another model handed the same file. Measured on 2026-09-18: `lillia.md` said Swirlseed
 * "rolls OVER TERRAIN, and grants VISION of what it rolls past" and said W "deals BONUS DAMAGE TO
 * MONSTERS". Riot's own tooltip says the seed "rolls until it hits an enemy or collides with
 * terrain"; the wiki says it "detonates upon hitting an enemy or terrain while on the ground" and
 * that the reveal is 2 seconds on the enemies the cone hits. There is no monster modifier on W in
 * either source on 16.18 — the wiki's modifier runs the other way, 50% damage to MINIONS. That one
 * false Swirlseed clause licensed 38% of every champion-specific line the live coach has produced
 * and 7.3% of 1,075 stored post-game feedback items.
 *
 * A model-authored knowledge base has an unbounded error rate and no way to notice. A FETCHED one
 * has the error rate of its sources and a diff when they change. So: mechanics are COPIED, never
 * recalled. Every string this script emits came off a URL it called, and every record carries the
 * URL, the patch and the timestamp it came from.
 *
 * ## Nothing in here evaluates a wiki template by hand
 *
 * The richest Tier 1 source is the wiki's per-ability `Template:Data <Champion>/<Ability>`, whose
 * fields are wikitext: `{{ap|60 to 160}}`, not `60 / 85 / 110 / 135 / 160`. Re-implementing that
 * arithmetic here would be exactly the failure this script exists to end — a number that LOOKS
 * fetched and was computed by the thing doing the fetching. So the wiki expands its own templates:
 * every field value is posted back to `action=parse&contentmodel=wikitext` in one call per
 * champion, with markers between them, and what comes back is rendered HTML that only has to be
 * stripped of tags. Reformatting a fetched string is allowed here; producing one is not.
 *
 * A field posted back ALONE is not the same field. It loses two things its own page gives it, and
 * both were losing numbers until 2026-09-19: `{{#var:abilityprogressionname}}`, which decides
 * whether `{{ap|150 to 110}}` is three ranks or five, and the `{{#vardefine:}}` block the page
 * writes above its field list, which holds the actual figures — so `{{#var:r_ap}}` expanded to
 * nothing and the wiki returned "Physical Damage Per Shot: to (+ % AD) (+ % AP)" with a straight
 * face. Both now ride along with every fragment, copied off the page byte for byte. Anything that
 * still comes back with an error or a hole in it is WITHHELD rather than shipped: see
 * `renderFault`, and `scripts/verify-fetched.ts`, which is what found this by going back to the
 * URL and comparing the delivered line to what the source says today.
 *
 * ## The four sources, and what each is for
 *
 * 1. `Module:ChampionData/data` (wiki, one call for everybody) — the JOIN TABLE. apiname -> wiki
 *    page name -> numeric id, plus base stats, growth, release patch, last-changed patch and the
 *    ability NAME in each slot. This is what removes every hand-written name map: MonkeyKing,
 *    Bel'Veth, Nunu & Willump and Renata Glasc all resolve out of the wiki's own data.
 * 2. Data Dragon `championFull.json` (one call for everybody) — Riot's own words, patch-pinned.
 *    `description` is the short client line; `tooltip` is the long one and is where the terrain
 *    clause actually lives, placeholders and all. Kept verbatim, placeholders included, because
 *    resolving them here would again be this script inventing numbers.
 * 3. The wiki ability templates — cast time, queue threshold, missile speeds, effect radius,
 *    targeting, damage classification, spell-shield interaction and the per-ability notes block.
 *    None of that exists in Riot's static data at all.
 * 4. op.gg `/api/na/champions/ranked/<apiname>/<role>` — TIER 2, what is actually built, maxed and
 *    won with, as counts. Jungle only, because that is the only role this app coaches.
 *
 * ## The validation is the point of the script, not a nicety
 *
 * `fetch-items.ts` licenses its arithmetic by joining the table against every item this app has
 * ever observed and checking `price === gold.base` on all 215. The equivalent here is a
 * CROSS-SOURCE agreement check: for every slot, Data Dragon and the wiki must agree on the
 * ability's NAME, its COOLDOWN per rank and its COST per rank. They are independent transcriptions
 * of the same patch, so a disagreement means one of them is stale — and shipping either alone is
 * how a wrong number comes out sounding like a right one. A slot that disagrees keeps its prose
 * (both sources carry the same sentences) and has its NUMBERS WITHHELD, with the conflict recorded
 * in the row so a reader can see what was dropped and why.
 *
 * ## Fail closed, separately per tier
 *
 * Tier 1 is three sources that agree. Tier 2 is one undocumented endpoint with no terms grant, so
 * it is validated with ArkType at the boundary and on any shape change it emits NO tier-2 section
 * rather than a degraded one. A stale build recommendation reads exactly like a fresh one.
 *
 * A source that cannot be reached leaves the previous cache and the previous generated table
 * untouched and exits non-zero. There is no half table.
 *
 * ## The cache, and why a re-run is byte-identical
 *
 * `data/champions/<patch>/` holds every payload exactly as fetched. A cached file is never
 * rewritten while its content is unchanged, so `fetchedAt` means "when this content was first
 * seen" and a re-run on the same patch produces the same bytes on disk and the same generated
 * module. A new patch is a new directory and a visible diff in `src/knowledge/champion-table.ts`.
 *
 * Run:
 *   pnpm fetch:champions
 *   pnpm fetch:champions -- --patch 16.18.1
 *   pnpm fetch:champions -- --only Lillia,Kayn --refresh
 *   pnpm fetch:champions -- --no-tier2
 *
 * Read-only on the database; never touches the LCU.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { type } from "arktype"

const UA = "eepalytics/0.1 (personal LoL coaching tool; ssalbdivad@gmail.com)"
export const WIKI_API = "https://wiki.leagueoflegends.com/en-us/api.php"
export const WIKI_MODULE = "https://wiki.leagueoflegends.com/en-us/Module:ChampionData/data?action=raw"
const DDRAGON_VERSIONS = "https://ddragon.leagueoflegends.com/api/versions.json"
const OPGG = "https://lol-api-champion.op.gg/api/na/champions/ranked"

const CACHE_ROOT = "data/champions"
const OUT = "src/knowledge/champion-table.ts"

/**
 * Bumped whenever the way a fetched page becomes TEXT changes, so the rendered cache is re-cut
 * instead of silently mixing two renderers. The file is `wiki-rendered-<n>.json` and the older ones
 * stay on disk: each is the evidence of what the corpus shipped at the time was cut from.
 *
 * 1. the original — every field rendered ALONE, so 204 fields across 47 champions lost the numbers
 *    their page defines above the field list (`{{#var:r_ap}}` -> the empty string -> "(+ % AP)");
 * 2. + the page's own `{{#vardefine:}}` preamble, so the wiki fills those in;
 * 3. + the wiki's footnote markers and footnote list removed — `[17]` pointed at a list that is not
 *    in the delivered file, and its number depended on what else was in the same parse request;
 * 4. + bare external links, which autonumber into the same kind of bracketed integer.
 */
const RENDERER_VERSION = 4

/** One request at a time to the wiki, with a gap. It is a volunteer wiki, not a CDN. */
const WIKI_GAP_MS = 350
const OPGG_GAP_MS = 400

/* ------------------------------------------------------------------ argv */

const arg = (flag: string): string | null => {
	const i = process.argv.indexOf(flag)
	return i === -1 ? null : (process.argv[i + 1] ?? null)
}
const has = (flag: string): boolean => process.argv.includes(flag)

/* ------------------------------------------------------------------ io */

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export class SourceDown extends Error {}

/**
 * Three tries with a widening gap, then give up LOUDLY.
 *
 * Every caller of this treats a throw as fatal. That is deliberate: the repo's rule is that a
 * feature which cannot fail loudly will fail silently for a month, and a champion table that
 * quietly lost half its rows to one flaky fetch is exactly that failure.
 */
export const fetchText = async (url: string, init?: RequestInit): Promise<string> => {
	let last = ""
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const res = await fetch(url, {
				...init,
				headers: { "User-Agent": UA, ...(init?.headers ?? {}) },
				signal: AbortSignal.timeout(60_000)
			})
			if (!res.ok) {
				last = `HTTP ${res.status}`
			} else return await res.text()
		} catch (e) {
			last = e instanceof Error ? e.message : String(e)
		}
		if (attempt < 3) await sleep(attempt * 1500)
	}
	throw new SourceDown(`${url} — ${last}`)
}

export const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> =>
	JSON.parse(await fetchText(url, init)) as T

const writeCache = (path: string, content: string): { fetchedAt: string; changed: boolean } => {
	const metaPath = `${path}.fetched`
	if (existsSync(path) && readFileSync(path, "utf8") === content && existsSync(metaPath))
		return { fetchedAt: readFileSync(metaPath, "utf8").trim(), changed: false }
	const fetchedAt = new Date().toISOString()
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, content)
	writeFileSync(metaPath, `${fetchedAt}\n`)
	return { fetchedAt, changed: true }
}

const readCache = (path: string): { content: string; fetchedAt: string } | null => {
	const metaPath = `${path}.fetched`
	if (!existsSync(path) || !existsSync(metaPath)) return null
	return { content: readFileSync(path, "utf8"), fetchedAt: readFileSync(metaPath, "utf8").trim() }
}

/* ------------------------------------------------------- HTML -> plain text */

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	hellip: "…",
	times: "×"
}

const decodeEntities = (s: string): string =>
	s
		.replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
		.replace(/&([a-zA-Z]+);/g, (m, n: string) => ENTITIES[n] ?? m)

/**
 * The wiki's rendered HTML, flattened to the text a reader sees.
 *
 * This only ever REMOVES markup. It never rewrites a number, a word or an order, which is the
 * line this whole script is drawn along: the wiki computed `60 / 85 / 110 / 135 / 160`, and all
 * that happens here is that the `<dd>` around it goes away.
 */
export const htmlToText = (html: string): string => {
	let s = html
	s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
	/*
	 * The wiki's own footnotes, and they are two separate defects in one feature.
	 *
	 * The INLINE marker renders as `<sup class="reference"><a>[17]</a></sup>`, which survives
	 * tag-stripping as the bare text `[17]` — a bracketed integer in a coaching prompt pointing at a
	 * reference list that is nowhere in the delivered file. 167 of them shipped across 28 champions.
	 * Worse, the number is assigned by the wiki PER PARSE REQUEST, so it counts refs from every
	 * other field rendered in the same POST: the same note came back `[17]` in the fetcher's batch
	 * and `[5]` when re-rendered alone. A value that depends on what it was batched with is not
	 * reproducible, and reproducibility is the contract this cache is built on.
	 *
	 * The LIST itself renders as `<div class="mw-references-wrap">`, whose backlink arrows survive
	 * as their own lines — which is how `- edge case: ↑ Bard Q&A comment by Rabid Llama` reached
	 * Bard's file twice, dressed as an ability interaction.
	 *
	 * Both go before anything else is read. Nothing is rewritten: the footnote is removed whole.
	 */
	s = s.replace(/<div[^>]*class="[^"]*mw-references-wrap[^"]*"[\s\S]*?<\/div>/gi, "")
	s = s.replace(/<ol[^>]*class="[^"]*references[^"]*"[\s\S]*?<\/ol>/gi, "")
	s = s.replace(/<sup[^>]*class="[^"]*reference[^"]*"[\s\S]*?<\/sup>/gi, "")
	/*
	 * And the OTHER bracketed integer, which is not a footnote at all: a bare `[https://…]` in
	 * wikitext renders as `<a class="external autonumber">[1]</a>`, numbered per parse request the
	 * same way. Fiora's Riposte notes carry three of them pointing at YouTube clips. The link text
	 * is the number, so removing the anchor removes the whole thing.
	 */
	s = s.replace(/<a[^>]*class="[^"]*autonumber[^"]*"[^>]*>[\s\S]*?<\/a>/gi, "")
	// Icons carry an `alt` describing the icon ("An icon representing the keyword Slow"), which is
	// about the picture and not about the ability. The linked word next to it survives.
	s = s.replace(/<img\b[^>]*>/gi, "")
	s = s.replace(/<\/(dt|th)>/gi, ": ")
	s = s.replace(/<br\s*\/?>/gi, "\n")
	s = s.replace(/<\/(dd|p|div|tr|li|ul|ol|dl|h[1-6])>/gi, "\n")
	s = s.replace(/<li\b[^>]*>/gi, "- ")
	s = s.replace(/<[^>]+>/g, "")
	s = decodeEntities(s)
	return s
		.split("\n")
		.map(line => line.replace(/[ \t    ]+/g, " ").trim())
		.map(line => line.replace(/:\s*:\s*/g, ": ").replace(/\s+([,.;])/g, "$1"))
		.filter(line => line !== "")
		.join("\n")
		.trim()
}

/* --------------------------------------------- the wiki's ChampionData module */

interface WikiChampion {
	wikiPage: string
	id: number
	apiname: string
	title: string
	resource: string
	rangeType: string
	releasePatch: string
	lastChangedPatch: string
	positions: string[]
	roles: string[]
	stats: Record<string, number>
	ratings: Record<string, number>
	/** slot -> ability names, in the wiki's own order. Q may legitimately carry two. */
	skills: Record<"P" | "Q" | "W" | "E" | "R", string[]>
}

const STAT_KEYS = [
	"hp_base",
	"hp_lvl",
	"mp_base",
	"mp_lvl",
	"arm_base",
	"arm_lvl",
	"mr_base",
	"mr_lvl",
	"hp5_base",
	"hp5_lvl",
	"mp5_base",
	"mp5_lvl",
	"dam_base",
	"dam_lvl",
	"as_base",
	"as_lvl",
	"range",
	"ms"
] as const

const RATING_KEYS = ["difficulty", "damage", "toughness", "control", "mobility", "utility"] as const

/** Balanced-brace slice of `["key"] = { ... }` inside a Lua table literal. */
export const luaBlock = (src: string, key: string): string | null => {
	const at = src.indexOf(`["${key}"]`)
	if (at === -1) return null
	const open = src.indexOf("{", at)
	if (open === -1) return null
	let depth = 0
	for (let i = open; i < src.length; i++) {
		if (src[i] === "{") depth += 1
		else if (src[i] === "}") {
			depth -= 1
			if (depth === 0) return src.slice(open + 1, i)
		}
	}
	return null
}

const luaString = (src: string, key: string): string | null => {
	const m = new RegExp(`\\["${key}"\\]\\s*=\\s*"([^"]*)"`).exec(src)
	return m ? m[1]! : null
}

const luaNumber = (src: string, key: string): number | null => {
	const m = new RegExp(`\\["${key}"\\]\\s*=\\s*(-?[0-9.]+)`).exec(src)
	return m ? Number(m[1]) : null
}

const luaStringList = (src: string, key: string): string[] => {
	const block = luaBlock(src, key)
	if (block === null) return []
	return [...block.matchAll(/"([^"]*)"/g)].map(m => m[1]!)
}

export const parseChampionData = (lua: string): Map<string, WikiChampion> => {
	const out = new Map<string, WikiChampion>()
	// Entries are one two-space-indented `["Name"] = {` per champion. If the module's formatting
	// ever changes this yields nothing, and the caller refuses to write — which is the right
	// failure, because a silently empty join table would take every ability with it.
	const starts = [...lua.matchAll(/^ {2}\["([^"]+)"\] = \{$/gm)]
	for (let i = 0; i < starts.length; i++) {
		const from = starts[i]!.index
		const to = i + 1 < starts.length ? starts[i + 1]!.index : lua.length
		const block = lua.slice(from, to)
		const apiname = luaString(block, "apiname")
		const id = luaNumber(block, "id")
		if (apiname === null || id === null) continue
		// `["Kled & Skaarl"]` is a second entry under the SAME apiname carrying id 240.1 — the wiki's
		// way of giving a transformed form its own ability box. Riot has one champion 240, so the
		// fractional entry is skipped rather than allowed to overwrite the real one.
		if (!Number.isInteger(id)) continue
		const statsBlock = luaBlock(block, "stats") ?? ""
		const stats: Record<string, number> = {}
		for (const k of STAT_KEYS) {
			const v = luaNumber(statsBlock, k)
			if (v !== null) stats[k] = v
		}
		const ratings: Record<string, number> = {}
		for (const k of RATING_KEYS) {
			const v = luaNumber(block, k)
			if (v !== null) ratings[k] = v
		}
		out.set(apiname, {
			wikiPage: starts[i]![1]!,
			id,
			apiname,
			title: luaString(block, "title") ?? "",
			resource: luaString(block, "resource") ?? "",
			rangeType: luaString(block, "rangetype") ?? "",
			releasePatch: luaString(block, "patch") ?? "",
			lastChangedPatch: luaString(block, "changes") ?? "",
			positions: luaStringList(block, "client_positions"),
			roles: luaStringList(block, "role"),
			stats,
			ratings,
			skills: {
				P: luaStringList(block, "skill_i"),
				Q: luaStringList(block, "skill_q"),
				W: luaStringList(block, "skill_w"),
				E: luaStringList(block, "skill_e"),
				R: luaStringList(block, "skill_r")
			}
		})
	}
	return out
}

/* ----------------------------------------------------------- Data Dragon */

interface DdSpell {
	id: string
	name: string
	description: string
	tooltip: string
	maxrank: number
	cooldownBurn: string
	costBurn: string
	rangeBurn: string
	costType: string
	resource?: string
}

interface DdChampion {
	id: string
	key: string
	name: string
	title: string
	tags: string[]
	partype: string
	spells: DdSpell[]
	passive: { name: string; description: string }
}

/* -------------------------------------------------- the wiki ability templates */

/**
 * `|key = value` at the start of a line, value running to the next such line.
 *
 * Deliberately NOT a general wikitext parser. Every `Template:Data X/Y` on this wiki is written
 * one field per line, and values that span lines (the `notes` bullet list) never start a line with
 * `|`. A field this misses simply does not appear, which loses a number; a field it invents cannot
 * happen, because every key and value is a slice of the fetched bytes.
 */
export const parseTemplateFields = (wikitext: string): Record<string, string> => {
	const marks = [...wikitext.matchAll(/^\|\s*([A-Za-z][A-Za-z0-9 _'-]*?)\s*=\s*/gm)]
	const out: Record<string, string> = {}
	for (let i = 0; i < marks.length; i++) {
		const m = marks[i]!
		const start = m.index + m[0].length
		const end = i + 1 < marks.length ? marks[i + 1]!.index : wikitext.lastIndexOf("}}")
		out[m[1]!.trim().toLowerCase()] = wikitext.slice(start, end === -1 ? undefined : end).trim()
	}
	return out
}

/**
 * The `{{#vardefine:...}}` calls a `Template:Data X/Y` page makes ABOVE its own field list.
 *
 * This is the second thing a field loses when it is rendered on its own, and it is the expensive
 * one. `Template:Data Lucian/The Culling` opens with
 *
 *     {{#vardefine:r_d1|15}}{{#vardefine:r_d3|45}}{{#vardefine:r_ad|25}}{{#vardefine:r_ap|15}}
 *
 * and then writes `|leveling = {{st|Physical Damage Per Shot|{{ap|{{#var:r_d1}} to {{#var:r_d3}}}}
 * {{as|(+ {{#var:r_ad}}% AD)}} {{as|(+ {{#var:r_ap}}% AP)}}}}`. Rendered alone, every `{{#var:}}`
 * expands to the EMPTY STRING and the wiki cheerfully returns
 *
 *     Physical Damage Per Shot: to (+ % AD) (+ % AP)
 *
 * — a grammatical sentence with the numbers deleted, which is worse than an error because nothing
 * downstream can see it. That is what shipped: measured on the 16.18.1 cache, 204 of 14,984
 * rendered fields across 75 ability pages and 47 champions referenced a variable their own page
 * defines outside the field, and 31 delivered lines carried a visible "Expression error" while the
 * rest simply lost their quantities.
 *
 * So each fragment is prefixed with the vardefines its own page wrote, copied byte for byte and in
 * order (a later one may read an earlier one). This is still the wiki doing the arithmetic on the
 * wiki's own values; it is only being handed the values its own page set.
 */
export const pageVariablePreamble = (wikitext: string): string => {
	const first = /^\|\s*[A-Za-z]/m.exec(wikitext)
	const head = first ? wikitext.slice(0, first.index) : wikitext
	const out: string[] = []
	for (let i = head.indexOf("{{#vardefine:"); i !== -1; i = head.indexOf("{{#vardefine:", i + 2)) {
		// Balanced, because `{{#vardefine:i_maxd|{{#expr:1+({{#var:i_maxs}} - 1)*{{#var:i_s}}}}}}`
		// is a real line on Briar's page and a non-greedy `[^{}]*` would cut it in half.
		let depth = 0
		let end = -1
		for (let j = i; j < head.length - 1; j++) {
			if (head[j] === "{" && head[j + 1] === "{") {
				depth += 1
				j += 1
			} else if (head[j] === "}" && head[j + 1] === "}") {
				depth -= 1
				j += 1
				if (depth === 0) {
					end = j + 1
					break
				}
			}
		}
		if (end === -1) break
		out.push(head.slice(i, end))
		i = end - 2
	}
	return out.join("")
}

/**
 * Whether a rendered field came back BROKEN, and why.
 *
 * The preamble above recovers the variables a page defines for itself. Thirteen `{{#var:}}` uses in
 * the 16.18.1 cache name variables the page never defines — they come from the champion's stat
 * block, which only exists while the whole ability box is rendering — and those cannot be recovered
 * by handing the wiki anything this pipeline holds. A field in that state renders as an expression
 * error, or as prose with a hole in it, and BOTH have to fail closed: an empty field is a fact this
 * app does not have, which is the answer it is allowed to give.
 *
 * The dangling-operand patterns are the ones a missing `{{#var:}}` leaves behind — `(+ % AP)`,
 * `Damage: to `, `( to )`. They are deliberately aggressive. The cost of a false positive is a
 * withheld line; the cost of a false negative is a coach reading "(+ % AP)" out loud.
 */
export const renderFault = (text: string): string | null => {
	if (/Expression error|Script error|Lua error|Template loop detected/i.test(text))
		return "the wiki returned an expression or script error"
	// `nil` is what a wiki Lua module prints when it is handed an empty argument. Master Yi's Q
	// leveling line said "(+ nil% AD)" for as long as the fields were rendered alone.
	if (/\bnil\b/.test(text)) return "a wiki Lua module was handed an empty value and printed nil"
	if (/\{\{|\}\}|#var:|#expr:/.test(text)) return "unexpanded wikitext survived the render"
	if (/\(\+\s*%|\(\+\s*-\s*%|:\s*to\s|\sto\s*%|\(\s*to\s*\)|\/\s*to\s*\//.test(text))
		return "an operand is missing — a number the source supplies did not reach the text"
	return null
}

/**
 * `[[File: Swirlseed collision indicator.png|175px|thumb|left|Collision indicator]]` renders as a
 * figure whose CAPTION survives tag-stripping and arrives looking like an ability note. There are
 * no images in this pipeline's output, so the whole link goes before rendering.
 */
export const stripFileLinks = (wikitext: string): string =>
	wikitext.replace(/\[\[\s*(File|Image)\s*:[^\[\]]*(\[\[[^\[\]]*\]\][^\[\]]*)*\]\]/gi, "")

/** Which template fields are worth rendering and keeping. Anything else is wiki bookkeeping. */
export const KEPT_FIELDS = [
	"description",
	"description2",
	"description3",
	"description4",
	"leveling",
	"leveling2",
	"leveling3",
	"leveling4",
	"cooldown",
	"cooldown2",
	"static",
	"recharge",
	"cost",
	"costtype",
	"cast time",
	"target range",
	"effect radius",
	"width",
	"angle",
	"speed",
	"queue time",
	"targeting",
	"affects",
	"damagetype",
	"projectile",
	"spelleffects",
	"spellshield",
	"knockback",
	"grounded",
	"notes"
] as const

interface WikiAbility {
	slot: "P" | "Q" | "W" | "E" | "R"
	/** The ability name as `Module:ChampionData` spells it — the title we asked for. */
	name: string
	title: string
	revId: number
	/** The template's own `|skill =` field, so the slot can be checked rather than assumed. */
	declaredSlot: string
	/** Rendered, plain text, one entry per kept field that was non-empty. */
	fields: Record<string, string>
}

type WikiPage = { title: string; revId: number; wikitext: string }

/**
 * Up to 40 titles per query. The API normalises and redirects titles, so the response is matched
 * back by the mappings it returns rather than by assuming the title came back as it went out.
 */
export const fetchWikitextBatch = async (titles: string[]): Promise<Map<string, WikiPage>> => {
	const url =
		`${WIKI_API}?action=query&prop=revisions&rvslots=main&rvprop=content|ids&format=json` +
		`&formatversion=2&redirects=1&titles=${encodeURIComponent(titles.join("|"))}`
	const j = await fetchJson<{
		query?: {
			normalized?: { from: string; to: string }[]
			redirects?: { from: string; to: string }[]
			pages?: {
				title: string
				missing?: boolean
				revisions?: { revid: number; slots?: { main?: { content?: string } } }[]
			}[]
		}
	}>(url)
	const byTitle = new Map<string, WikiPage>()
	for (const p of j.query?.pages ?? []) {
		if (p.missing) continue
		const rev = p.revisions?.[0]
		if (!rev?.slots?.main?.content) continue
		byTitle.set(p.title, { title: p.title, revId: rev.revid, wikitext: rev.slots.main.content })
	}
	// Walk `asked -> normalized -> redirected` so every requested title finds its page.
	const hop = new Map<string, string>()
	for (const n of j.query?.normalized ?? []) hop.set(n.from, n.to)
	for (const r of j.query?.redirects ?? []) hop.set(r.from, r.to)
	const out = new Map<string, WikiPage>()
	for (const asked of titles) {
		let cur = asked
		for (let i = 0; i < 4 && !byTitle.has(cur); i++) {
			const next = hop.get(cur)
			if (next === undefined) break
			cur = next
		}
		const page = byTitle.get(cur)
		if (page) out.set(asked, page)
	}
	return out
}

/**
 * Hand a pile of wikitext fragments back to the wiki and get the reader's text for each.
 *
 * The markers survive as their own paragraphs, so the response splits on them cleanly. This is the
 * only place template arithmetic happens anywhere in this pipeline, and it happens on the wiki's
 * own servers with the wiki's own templates.
 */
export const renderWikitext = async (fragments: { wikitext: string; skill: string }[]): Promise<string[]> => {
	if (fragments.length === 0) return []
	/*
	 * `{{ap|150 to 110}}` means three ranks on an ultimate and five on a basic ability, and the
	 * template works that out from `{{#var:abilityprogressionname}}` — a page variable that
	 * `Ability data` sets while rendering a whole ability box. Rendering one field on its own loses
	 * it, and the wiki then silently interpolates FIVE ranks for an ultimate: Lillia's R came back
	 * `150 / 140 / 130 / 120 / 110` where Data Dragon says `150/130/110`. So each fragment re-sets
	 * the wiki's own variable to the slot the field belongs to. This is still the wiki doing the
	 * arithmetic; it is only being told which ability it is doing it for.
	 */
	const marked = fragments
		.map((f, i) => `@@${i}@@\n\n{{#vardefine:abilityprogressionname|${f.skill}}}${f.wikitext}`)
		.join("\n\n")
	const body = new URLSearchParams({
		action: "parse",
		text: marked,
		contentmodel: "wikitext",
		prop: "text",
		format: "json",
		formatversion: "2",
		disablelimitreport: "1",
		wrapoutputclass: ""
	})
	const j = await fetchJson<{ parse?: { text?: string }; error?: { code?: string } }>(WIKI_API, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body
	})
	if (typeof j.parse?.text !== "string")
		throw new SourceDown(`wiki parse returned no text (${j.error?.code ?? "unknown"})`)
	const text = htmlToText(j.parse.text)
	const out: string[] = new Array(fragments.length).fill("")
	const marks = [...text.matchAll(/^@@(\d+)@@$/gm)]
	for (let i = 0; i < marks.length; i++) {
		const idx = Number(marks[i]![1])
		const from = marks[i]!.index + marks[i]![0].length
		const to = i + 1 < marks.length ? marks[i + 1]!.index : text.length
		if (idx >= 0 && idx < out.length) out[idx] = text.slice(from, to).trim()
	}
	return out
}

/* ------------------------------------------------------ tier 2: op.gg, fenced */

const OpggStatCount = type({ play: "number", win: "number", "pick_rate?": "number" })

const OpggIdBuild = OpggStatCount.and({ ids: "(number|string)[]" })

const OpggRunePage = type({
	id: "number",
	play: "number",
	win: "number",
	builds: type({
		id: "number",
		primary_page_id: "number",
		primary_rune_ids: "number[]",
		secondary_page_id: "number",
		secondary_rune_ids: "number[]",
		stat_mod_ids: "number[]",
		play: "number",
		win: "number"
	}).array()
})

export const OpggResponse = type({
	meta: { version: "string", "cached_at?": "string" },
	data: {
		summary: {
			id: "number",
			positions: type({
				name: "string",
				stats: {
					play: "number",
					win_rate: "number",
					pick_rate: "number",
					ban_rate: "number",
					kda: "number",
					"tier_data?": { tier: "number", rank: "number", "rank_prev_patch?": "number" }
				}
			}).array()
		},
		// Ordered best-first by op.gg. An ARRAY, not an object — the first draft of this schema said
		// object and every one of the 45 jungle champions was withheld for a "shape change" that was
		// this file's mistake. Fail-closed is only honest when the closed state means the SOURCE moved.
		"skills?": OpggStatCount.and({ order: "string[]" }).array(),
		"core_items?": OpggIdBuild.array(),
		"boots?": OpggIdBuild.array(),
		"starter_items?": OpggIdBuild.array(),
		"last_items?": OpggIdBuild.array(),
		"summoner_spells?": OpggIdBuild.array(),
		"rune_pages?": OpggRunePage.array(),
		"counters?": type({ champion_id: "number", play: "number", win: "number" }).array(),
		"trends?": {
			// `rank` is null on a patch op.gg had not ranked yet.
			"win?": type({ version: "string", rate: "number", "rank?": "number|null" }).array()
		},
		// `rate` is null for a bucket with no games in it.
		"game_lengths?": type({ game_length: "number", "rate?": "number|null" }).array()
	}
})

export interface Tier2 {
	sourceUrl: string
	metaVersion: string
	cachedAt: string
	fetchedAt: string
	role: string
	tier: string
	play: number
	winRate: number
	pickRate: number
	banRate: number
	opggTier: number | null
	opggRank: number | null
	opggRankPrevPatch: number | null
	skillOrder: { order: string[]; play: number; win: number } | null
	coreItems: { ids: number[]; play: number; win: number }[]
	boots: { ids: number[]; play: number; win: number }[]
	starterItems: { ids: number[]; play: number; win: number }[]
	lastItems: { ids: number[]; play: number; win: number }[]
	summonerSpells: { ids: number[]; play: number; win: number }[]
	runePage: {
		keystone: number
		primaryTree: number
		primaryRunes: number[]
		secondaryTree: number
		secondaryRunes: number[]
		shards: number[]
		play: number
		win: number
	} | null
	counters: { championId: number; play: number; win: number }[]
	trend: { version: string; rate: number; rank: number | null }[]
	gameLengths: { minutes: number; rate: number }[]
}

const numIds = (ids: (number | string)[]): number[] => ids.map(Number).filter(n => Number.isFinite(n))

export const toTier2 = (
	raw: typeof OpggResponse.infer,
	opts: { sourceUrl: string; fetchedAt: string; role: string; tier: string }
): Tier2 | null => {
	const pos = raw.data.summary.positions.find(p => p.name.toUpperCase() === opts.role.toUpperCase())
	if (!pos) return null
	const page = raw.data.rune_pages?.[0]
	const build = page?.builds?.[0]
	const topN = <T extends { ids: (number | string)[]; play: number; win: number }>(rows: T[] | undefined, n: number) =>
		(rows ?? []).slice(0, n).map(r => ({ ids: numIds(r.ids), play: r.play, win: r.win }))
	return {
		sourceUrl: opts.sourceUrl,
		metaVersion: raw.meta.version,
		cachedAt: raw.meta.cached_at ?? "",
		fetchedAt: opts.fetchedAt,
		role: opts.role,
		tier: opts.tier,
		play: pos.stats.play,
		winRate: pos.stats.win_rate,
		pickRate: pos.stats.pick_rate,
		banRate: pos.stats.ban_rate,
		opggTier: pos.stats.tier_data?.tier ?? null,
		opggRank: pos.stats.tier_data?.rank ?? null,
		opggRankPrevPatch: pos.stats.tier_data?.rank_prev_patch ?? null,
		skillOrder:
			raw.data.skills?.[0] ?
				{ order: raw.data.skills[0]!.order, play: raw.data.skills[0]!.play, win: raw.data.skills[0]!.win }
			:	null,
		coreItems: topN(raw.data.core_items, 3),
		boots: topN(raw.data.boots, 2),
		starterItems: topN(raw.data.starter_items, 2),
		lastItems: topN(raw.data.last_items, 3),
		summonerSpells: topN(raw.data.summoner_spells, 2),
		runePage:
			page && build ?
				{
					keystone: build.primary_rune_ids[0] ?? page.id,
					primaryTree: build.primary_page_id,
					primaryRunes: build.primary_rune_ids,
					secondaryTree: build.secondary_page_id,
					secondaryRunes: build.secondary_rune_ids,
					shards: build.stat_mod_ids,
					play: build.play,
					win: build.win
				}
			:	null,
		counters: (raw.data.counters ?? [])
			.slice()
			.sort((a, b) => b.play - a.play)
			.slice(0, 12)
			.map(c => ({ championId: c.champion_id, play: c.play, win: c.win })),
		trend: (raw.data.trends?.win ?? []).slice(0, 6).map(t => ({ version: t.version, rate: t.rate, rank: t.rank ?? null })),
		gameLengths: (raw.data.game_lengths ?? [])
			.filter(g => typeof g.rate === "number")
			.map(g => ({ minutes: g.game_length, rate: g.rate as number }))
	}
}

/* ------------------------------------------------ cross-source agreement check */

/**
 * `"16/15/14/13/12"`, `"16 / 15 / 14 / 13 / 12"` and `"16"` (a wiki scalar standing for a flat
 * cooldown) all have to compare equal, and a genuinely different number has to compare unequal.
 *
 * So: pull the numbers out in order, collapse a run of identical values to one, and compare. A
 * value that carries no digits at all ("No cost", "None") collapses to the empty string, which
 * matches Data Dragon's `"0"` only after the zero is dropped too — done by the caller.
 */
export const numberSignature = (s: string): string => {
	const nums = (s.match(/-?\d+(?:\.\d+)?/g) ?? []).map(n => String(Number(n)))
	const collapsed: string[] = []
	for (const n of nums) if (collapsed[collapsed.length - 1] !== n) collapsed.push(n)
	return collapsed.join("/")
}

const nameSignature = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "")

/* ----------------------------------------------------------- the row shape */

interface AbilityRow {
	slot: "P" | "Q" | "W" | "E" | "R"
	name: string
	/** Data Dragon's short client line, verbatim. */
	riotSummary: string
	/** Data Dragon's long tooltip, verbatim, `{{ placeholders }}` intact. */
	riotTooltip: string
	/** The wiki's rendered description — the same sentences with the numbers filled in. */
	wikiDescription: string
	leveling: string[]
	cooldown: string
	cost: string
	costType: string
	targetRange: string
	castTime: string
	effectRadius: string
	width: string
	speed: string
	queueThreshold: string
	targeting: string
	affects: string
	damageType: string
	projectile: string
	spellShield: string
	notes: string[]
	wikiTitle: string
	wikiRevId: number
	/** Data Dragon and the wiki agree on name, cooldown and cost for this slot. */
	agreed: boolean
	/** What they disagreed about, in the form `field: ddragon vs wiki`. Empty when `agreed`. */
	conflicts: string[]
	/**
	 * Fields the wiki returned BROKEN, in the form `field: why`. They are empty above, and this is
	 * the difference between "the source publishes no cast time" and "the cast time did not survive
	 * the render" — two answers that otherwise look identical to every reader downstream.
	 */
	withheld: string[]
}

interface ChampionRow {
	key: string
	apiname: string
	id: number
	name: string
	title: string
	wikiPage: string
	resource: string
	rangeType: string
	positions: string[]
	roles: string[]
	tags: string[]
	releasePatch: string
	lastChangedPatch: string
	stats: Record<string, number>
	ratings: Record<string, number>
	abilities: AbilityRow[]
	tier2: Tier2 | null
}

const championKey = (name: string): string => name.toLowerCase().replace(/[^a-z]/g, "")

/* -------------------------------------------------------------------- main */

const main = async (): Promise<void> => {
	const onlyArg = arg("--only")
	const only = onlyArg ? new Set(onlyArg.split(",").map(s => s.trim().toLowerCase())) : null
	const refresh = has("--refresh")
	const skipTier2 = has("--no-tier2")
	const tier2Tier = arg("--tier") ?? "emerald_plus"
	const tier2Role = arg("--role") ?? "jungle"

	/* ------------------------------------------------------- tier 1, sources 1 and 2 */

	const versions = await fetchJson<string[]>(DDRAGON_VERSIONS)
	const patch = arg("--patch") ?? versions[0]!
	const cacheDir = join(CACHE_ROOT, patch)
	console.log(`patch ${patch} — cache ${cacheDir}`)

	const ddUrl = `https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/championFull.json`
	const ddPath = join(cacheDir, "ddragon-championFull.json")
	const ddCached = refresh ? null : readCache(ddPath)
	const ddRaw = ddCached?.content ?? (await fetchText(ddUrl))
	const ddMeta = writeCache(ddPath, ddRaw)
	const ddData = (JSON.parse(ddRaw) as { data: Record<string, DdChampion> }).data

	/*
	 * op.gg answers in IDS — rune 8010, summoner 4 — and an id is not something anyone can say out
	 * loud. Riot publishes both name tables on the same patch-pinned CDN, so the names are FETCHED
	 * like everything else here rather than written down from memory, which is how a rune map ends
	 * up one season out of date and nobody notices.
	 */
	const runesUrl = `https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/runesReforged.json`
	const runesPath = join(cacheDir, "ddragon-runesReforged.json")
	const runesCached = refresh ? null : readCache(runesPath)
	const runesRaw = runesCached?.content ?? (await fetchText(runesUrl))
	writeCache(runesPath, runesRaw)
	const runeNames: Record<number, string> = {}
	for (const tree of JSON.parse(runesRaw) as {
		id: number
		name: string
		slots: { runes: { id: number; name: string }[] }[]
	}[]) {
		runeNames[tree.id] = tree.name
		for (const slot of tree.slots) for (const r of slot.runes) runeNames[r.id] = r.name
	}

	const summUrl = `https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/summoner.json`
	const summPath = join(cacheDir, "ddragon-summoner.json")
	const summCached = refresh ? null : readCache(summPath)
	const summRaw = summCached?.content ?? (await fetchText(summUrl))
	writeCache(summPath, summRaw)
	const summonerNames: Record<number, string> = {}
	for (const s of Object.values((JSON.parse(summRaw) as { data: Record<string, { key: string; name: string }> }).data))
		summonerNames[Number(s.key)] = s.name

	const modPath = join(cacheDir, "wiki-championdata.lua")
	const modCached = refresh ? null : readCache(modPath)
	const modRaw = modCached?.content ?? (await fetchText(WIKI_MODULE))
	const modMeta = writeCache(modPath, modRaw)
	const wikiByApi = parseChampionData(modRaw)
	if (wikiByApi.size < 100)
		throw new SourceDown(`Module:ChampionData parsed to ${wikiByApi.size} champions — the module's shape changed`)
	console.log(
		`  ddragon: ${Object.keys(ddData).length} champions (${ddMeta.changed ? "fetched" : "cached"})` +
			` · wiki module: ${wikiByApi.size} entries (${modMeta.changed ? "fetched" : "cached"})`
	)

	/* --------------------------------------------------- the join, before anything else */

	const roster: { dd: DdChampion; wiki: WikiChampion }[] = []
	const unjoined: string[] = []
	for (const dd of Object.values(ddData).sort((a, b) => Number(a.key) - Number(b.key))) {
		const wiki = wikiByApi.get(dd.id)
		if (!wiki) {
			unjoined.push(`${dd.id} (${dd.name}) — no entry in Module:ChampionData`)
			continue
		}
		if (wiki.id !== Number(dd.key)) {
			unjoined.push(`${dd.id} — ddragon key ${dd.key}, wiki id ${wiki.id}`)
			continue
		}
		if (only && !only.has(dd.id.toLowerCase()) && !only.has(championKey(dd.name))) continue
		roster.push({ dd, wiki })
	}
	console.log(`  joined ${roster.length} champions by apiname + numeric id${only ? " (filtered by --only)" : ""}`)
	for (const u of unjoined.slice(0, 20)) console.log(`  UNJOINED ${u}`)
	if (!only && unjoined.length > 0) {
		console.error(`refusing to write: ${unjoined.length} champions do not join across the two sources`)
		process.exit(1)
	}

	/* ------------------------------------------ tier 1, source 3: the ability templates */

	const wanted: { apiname: string; slot: "P" | "Q" | "W" | "E" | "R"; name: string; title: string }[] = []
	for (const { wiki } of roster)
		for (const slot of ["P", "Q", "W", "E", "R"] as const)
			for (const name of wiki.skills[slot])
				wanted.push({ apiname: wiki.apiname, slot, name, title: `Template:Data ${wiki.wikiPage}/${name}` })

	const abilityPath = join(cacheDir, "wiki-abilities.json")
	const abilityCached = refresh ? null : readCache(abilityPath)
	let rawAbilities: Record<string, { revId: number; wikitext: string }> =
		abilityCached ? (JSON.parse(abilityCached.content) as Record<string, { revId: number; wikitext: string }>) : {}
	const missingTitles = wanted.filter(w => rawAbilities[w.title] === undefined).map(w => w.title)
	if (missingTitles.length > 0) {
		console.log(`  fetching ${missingTitles.length} ability templates from the wiki…`)
		for (let i = 0; i < missingTitles.length; i += 40) {
			const batch = missingTitles.slice(i, i + 40)
			const pages = await fetchWikitextBatch(batch)
			for (const t of batch) {
				const p = pages.get(t)
				if (p) rawAbilities[t] = { revId: p.revId, wikitext: p.wikitext }
			}
			process.stdout.write(`\r    ${Math.min(i + 40, missingTitles.length)}/${missingTitles.length}`)
			await sleep(WIKI_GAP_MS)
		}
		process.stdout.write("\n")
	}
	// Sorted keys so the cache file is byte-stable whatever order the batches came back in.
	const sortedAbilities: Record<string, { revId: number; wikitext: string }> = {}
	for (const k of Object.keys(rawAbilities).sort()) sortedAbilities[k] = rawAbilities[k]!
	rawAbilities = sortedAbilities
	const abilityMeta = writeCache(abilityPath, `${JSON.stringify(rawAbilities, null, "\t")}\n`)

	/* ---------------------------- tier 1, source 3b: let the WIKI expand its own templates */

	const renderPath = join(cacheDir, `wiki-rendered-${RENDERER_VERSION}.json`)
	const renderCached = refresh ? null : readCache(renderPath)
	let rendered: Record<string, Record<string, string>> =
		renderCached ? (JSON.parse(renderCached.content) as Record<string, Record<string, string>>) : {}
	const toRender = wanted.filter(w => rawAbilities[w.title] !== undefined && rendered[w.title] === undefined)
	if (toRender.length > 0) {
		console.log(`  asking the wiki to expand ${toRender.length} ability templates…`)
		// One POST per champion: small enough for a form body, large enough that 170 champions is a
		// couple of minutes rather than an hour.
		const byChampion = new Map<string, typeof toRender>()
		for (const w of toRender) byChampion.set(w.apiname, [...(byChampion.get(w.apiname) ?? []), w])
		let done = 0
		for (const [, group] of byChampion) {
			const keys: { title: string; field: string }[] = []
			const fragments: { wikitext: string; skill: string }[] = []
			for (const w of group) {
				const fields = parseTemplateFields(rawAbilities[w.title]!.wikitext)
				// The template names its own slot ("I" for the innate, "Q".."R" otherwise); the module's
				// slot letter is the fallback. Riot and the wiki disagree on nothing here, but the
				// wiki's own spelling is what its own templates key off.
				const skill = (fields.skill ?? "").trim() || (w.slot === "P" ? "I" : w.slot)
				const preamble = pageVariablePreamble(rawAbilities[w.title]!.wikitext)
				for (const f of KEPT_FIELDS) {
					const v = fields[f]
					if (v === undefined || v.trim() === "") continue
					keys.push({ title: w.title, field: f })
					fragments.push({ wikitext: preamble + stripFileLinks(v), skill })
				}
			}
			const texts = await renderWikitext(fragments)
			for (const w of group) rendered[w.title] ??= {}
			for (let i = 0; i < keys.length; i++) {
				const k = keys[i]!
				if (texts[i] !== undefined && texts[i] !== "") rendered[k.title]![k.field] = texts[i]!
			}
			done += group.length
			process.stdout.write(`\r    ${done}/${toRender.length}`)
			await sleep(WIKI_GAP_MS)
		}
		process.stdout.write("\n")
	}
	const sortedRendered: Record<string, Record<string, string>> = {}
	for (const k of Object.keys(rendered).sort()) {
		const inner: Record<string, string> = {}
		for (const f of Object.keys(rendered[k]!).sort()) inner[f] = rendered[k]![f]!
		sortedRendered[k] = inner
	}
	rendered = sortedRendered
	const renderMeta = writeCache(renderPath, `${JSON.stringify(rendered, null, "\t")}\n`)

	/* --------------------------------------------------------------- tier 2: op.gg */

	const tier2ByApi = new Map<string, Tier2>()
	const tier2Refused: string[] = []
	if (!skipTier2) {
		const junglers = roster.filter(r => r.wiki.positions.includes("Jungle"))
		console.log(`  tier 2: ${junglers.length} jungle champions from op.gg (${tier2Role}, ${tier2Tier})`)
		let n = 0
		for (const { dd } of junglers) {
			const slug = dd.id.toLowerCase()
			const url = `${OPGG}/${slug}/${tier2Role}?tier=${tier2Tier}`
			const path = join(cacheDir, "opgg", `${slug}-${tier2Role}-${tier2Tier}.json`)
			const cached = refresh ? null : readCache(path)
			let raw: string
			try {
				raw = cached?.content ?? (await fetchText(url))
			} catch (e) {
				tier2Refused.push(`${dd.id}: unreachable — ${e instanceof Error ? e.message : String(e)}`)
				continue
			}
			if (!cached) await sleep(OPGG_GAP_MS)
			// Cached BEFORE validation on purpose. A payload that fails the schema is the single most
			// useful thing to have on disk — it is the evidence that the endpoint moved — and refusing
			// to keep it means the next run refetches it only to refuse it again.
			const meta = writeCache(path, raw)
			let parsed: unknown
			try {
				parsed = JSON.parse(raw)
			} catch {
				tier2Refused.push(`${dd.id}: response is not JSON`)
				continue
			}
			const checked = OpggResponse(parsed)
			if (checked instanceof type.errors) {
				tier2Refused.push(`${dd.id}: shape changed — ${checked.summary.split("\n")[0]}`)
				continue
			}
			if (checked.data.summary.id !== Number(dd.key)) {
				tier2Refused.push(`${dd.id}: op.gg returned champion id ${checked.data.summary.id}, expected ${dd.key}`)
				continue
			}
			const t2 = toTier2(checked, { sourceUrl: url, fetchedAt: meta.fetchedAt, role: tier2Role, tier: tier2Tier })
			if (t2) tier2ByApi.set(dd.id, t2)
			else tier2Refused.push(`${dd.id}: no ${tier2Role} position in the payload`)
			n += 1
			if (n % 10 === 0) process.stdout.write(`\r    ${n}/${junglers.length}`)
		}
		process.stdout.write("\n")
		for (const r of tier2Refused.slice(0, 20)) console.log(`  TIER2 WITHHELD ${r}`)
		console.log(`  tier 2: ${tier2ByApi.size} champions carry a section, ${tier2Refused.length} withheld`)
	}

	/* ------------------------------------------------------------ assemble + validate */

	const rows: ChampionRow[] = []
	let slotsChecked = 0
	let slotsAgreed = 0
	const conflictLines: string[] = []

	for (const { dd, wiki } of roster) {
		const abilities: AbilityRow[] = []
		/*
		 * `Template:Data Lillia/Prance` REDIRECTS to `Template:Data Lillia/Blooming Blows` — the wiki
		 * names Q's passive separately in `Module:ChampionData` and documents it on the same page. The
		 * query follows the redirect, so asking for both titles returns the same revision twice, and
		 * without this the block would carry Blooming Blows under two headings. Elise's and Nidalee's
		 * genuinely separate sub-abilities have their own revisions and survive.
		 */
		const seenRevs = new Set<number>()

		const ddBySlot: Record<"P" | "Q" | "W" | "E" | "R", DdSpell | null> = {
			P: null,
			Q: dd.spells[0] ?? null,
			W: dd.spells[1] ?? null,
			E: dd.spells[2] ?? null,
			R: dd.spells[3] ?? null
		}

		for (const slot of ["P", "Q", "W", "E", "R"] as const) {
			const names = wiki.skills[slot]
			for (let idx = 0; idx < names.length; idx++) {
				const name = names[idx]!
				const title = `Template:Data ${wiki.wikiPage}/${name}`
				const src = rawAbilities[title]
				if (!src) continue
				if (seenRevs.has(src.revId)) continue
				seenRevs.add(src.revId)
				const fields = parseTemplateFields(src.wikitext)
				const r = rendered[title] ?? {}
				/*
				 * The fault check lives HERE and not in the render loop on purpose: the cache holds
				 * what the wiki said, faults included, because that file is the evidence. The table
				 * holds what passed the fence. A field the wiki could not expand is dropped and the
				 * drop is recorded per ability, so "no cast time" and "the cast time did not survive
				 * the render" are different answers in the row rather than the same empty string.
				 */
				const renderWithheld: string[] = []
				const pick = (k: string): string => {
					const v = r[k] ?? ""
					if (v === "") return ""
					const fault = renderFault(v)
					if (fault === null) return v
					renderWithheld.push(`${k}: ${fault}`)
					return ""
				}
				const spell = idx === 0 ? ddBySlot[slot] : null

				const conflicts: string[] = []
				if (spell) {
					slotsChecked += 1
					/*
					 * Data Dragon names a two-form slot "Sonic Wave / Resonating Strike"; the wiki gives
					 * each form its own template and `Module:ChampionData` lists both under `skill_q`.
					 * Matching against either side is agreement, not laxity — both sources name the same
					 * two abilities.
					 *
					 * The PIPE is there because Riot uses both separators and the difference is nothing
					 * but punctuation: Yunara's W is "Arc of Judgment | Arc of Ruin". Splitting only on
					 * the slash made that a name CONFLICT, which withheld her W's and E's cooldown and
					 * cost — two numbers both sources agreed on — for a spelling reason. Failing closed
					 * is right when the sources disagree and is a bug when they do not.
					 */
					const ddNames = spell.name.split(/[/|]/).map(nameSignature)
					if (!ddNames.includes(nameSignature(name)))
						conflicts.push(`name: ddragon "${spell.name}" vs wiki "${name}"`)
					const ddCd = numberSignature(spell.cooldownBurn)
					const wkCd = numberSignature(pick("cooldown") || pick("static") || pick("recharge"))
					if (ddCd !== "" && wkCd !== "" && ddCd !== wkCd)
						conflicts.push(`cooldown: ddragon ${ddCd} vs wiki ${wkCd}`)
					const ddCost = numberSignature(spell.costBurn).replace(/^0$/, "")
					const wkCost = numberSignature(pick("cost")).replace(/^0$/, "")
					if (ddCost !== "" && wkCost !== "" && ddCost !== wkCost)
						conflicts.push(`cost: ddragon ${ddCost} vs wiki ${wkCost}`)
					if (conflicts.length === 0) slotsAgreed += 1
					else conflictLines.push(`${dd.id} ${slot} ${name} — ${conflicts.join("; ")}`)
				}
				// A slot whose two sources disagree keeps its PROSE (the sentences are the same in
				// both) and loses its NUMBERS. A wrong number is the failure this pipeline exists to
				// prevent, and a withheld one is visible in the row.
				const trust = conflicts.length === 0
				const declared = fields.skill ?? ""
				const leveling = [pick("leveling"), pick("leveling2"), pick("leveling3"), pick("leveling4")].filter(
					s => s !== ""
				)
				const description = [pick("description"), pick("description2"), pick("description3"), pick("description4")]
					.filter(s => s !== "")
					.join("\n\n")

				abilities.push({
					slot,
					name,
					riotSummary: spell?.description ?? (idx === 0 && slot === "P" ? dd.passive.description : ""),
					riotTooltip: spell?.tooltip ?? "",
					wikiDescription: description,
					leveling: trust ? leveling : [],
					cooldown: trust ? pick("cooldown") : "",
					cost: trust ? pick("cost") : "",
					costType: pick("costtype"),
					targetRange: trust ? pick("target range") : "",
					castTime: trust ? pick("cast time") : "",
					effectRadius: trust ? pick("effect radius") : "",
					width: trust ? pick("width") : "",
					speed: trust ? pick("speed") : "",
					queueThreshold: trust ? pick("queue time") : "",
					targeting: pick("targeting"),
					affects: pick("affects"),
					damageType: pick("damagetype"),
					projectile: pick("projectile"),
					spellShield: pick("spellshield"),
					notes: pick("notes")
						.split("\n")
						.map(l => l.replace(/^-\s*/, "").trim())
						.filter(l => l !== ""),
					wikiTitle: title,
					wikiRevId: src.revId,
					agreed: conflicts.length === 0,
					withheld: [...new Set(renderWithheld)].sort(),
					conflicts:
						declared !== "" && idx === 0 && declared.toUpperCase() !== slot && slot !== "P" ?
							[...conflicts, `slot: module says ${slot}, template says ${declared}`]
						:	conflicts
				})
			}
		}

		rows.push({
			key: championKey(dd.name),
			apiname: dd.id,
			id: Number(dd.key),
			name: dd.name,
			/*
			 * The WIKI's title, not Data Dragon's, and the difference is a provenance bug rather
			 * than a spelling one. `claims-from-row.ts` attributes `identity.title` to
			 * `Module:ChampionData/data`, so every champion file said "title: the Darkin Blade
			 * [wikiModule ...]" while the string came off Riot's `championFull.json`. Measured on
			 * 16.18.1 the two differ on 149 of 173 champions (the wiki capitalises the article), so
			 * the line was citing a source it had not read on 86% of the roster. Taking the value
			 * from the source the line names is the one-word repair.
			 */
			title: wiki.title || dd.title,
			wikiPage: wiki.wikiPage,
			resource: wiki.resource || dd.partype,
			rangeType: wiki.rangeType,
			positions: wiki.positions,
			roles: wiki.roles,
			tags: dd.tags,
			releasePatch: wiki.releasePatch,
			lastChangedPatch: wiki.lastChangedPatch,
			stats: wiki.stats,
			ratings: wiki.ratings,
			abilities,
			tier2: tier2ByApi.get(dd.id) ?? null
		})
	}

	console.log(
		`  cross-source agreement: ${slotsAgreed}/${slotsChecked} slots agree on name, cooldown and cost` +
			` (${((100 * slotsAgreed) / Math.max(1, slotsChecked)).toFixed(1)}%)`
	)
	for (const c of conflictLines.slice(0, 25)) console.log(`  CONFLICT ${c}`)
	if (conflictLines.length > 25) console.log(`  … and ${conflictLines.length - 25} more`)

	const abilityCount = rows.reduce((a, r) => a + r.abilities.length, 0)
	if (rows.length === 0 || abilityCount === 0) {
		console.error("refusing to write: nothing was assembled")
		process.exit(1)
	}
	if (has("--strict") && conflictLines.length > 0) {
		console.error(`--strict: ${conflictLines.length} slots disagree across sources; not writing`)
		process.exit(1)
	}

	/* --------------------------------------------------------------- write it out */

	const manifest = {
		patch,
		generatedFrom: {
			ddragon: { url: ddUrl, fetchedAt: ddMeta.fetchedAt },
			wikiModule: { url: WIKI_MODULE, fetchedAt: modMeta.fetchedAt },
			wikiAbilities: { api: WIKI_API, fetchedAt: abilityMeta.fetchedAt, templates: Object.keys(rawAbilities).length },
			wikiRendered: { api: WIKI_API, fetchedAt: renderMeta.fetchedAt },
			opgg: { api: OPGG, role: tier2Role, tier: tier2Tier, champions: tier2ByApi.size, withheld: tier2Refused }
		},
		champions: rows.length,
		abilities: abilityCount,
		slotsChecked,
		slotsAgreed,
		conflicts: conflictLines
	}
	writeCache(join(cacheDir, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`)

	// `--only` builds a partial table, which is fine for probing one champion and is NOT fine to
	// leave on disk as if it were the whole roster.
	if (only) {
		console.log(`--only: ${rows.length} champions assembled and cached; NOT rewriting ${OUT}`)
		console.log(JSON.stringify(rows[0]?.abilities.find(a => a.slot === "E") ?? rows[0], null, 2).slice(0, 3000))
		return
	}

	const header = `/**
 * GENERATED by \`scripts/fetch-champions.ts\`. Do not edit by hand — an edit here is a champion
 * claim with no source, which is the exact failure this table was built to end.
 *
 * Every string in this file was fetched from one of four sources and is reproduced or
 * tag-stripped, never rewritten:
 *
 * - Data Dragon patch ${patch} — \`${ddUrl}\`
 *   \`riotSummary\` and \`riotTooltip\` are Riot's own words, verbatim. The tooltip keeps its
 *   \`{{ placeholders }}\`: resolving them here would mean this file computing a number it claims
 *   to have been told.
 * - \`${WIKI_MODULE}\` — identity, base stats, growth, release and
 *   last-changed patch, and the ability name in each slot. This is the join table; there is no
 *   hand-written name map anywhere in the pipeline.
 * - \`Template:Data <Champion>/<Ability>\` on the same wiki, expanded BY THE WIKI through
 *   \`action=parse\`, which is why \`leveling\` reads \`60 / 85 / 110 / 135 / 160\` rather than
 *   \`{{ap|60 to 160}}\`. Cast time, queue threshold, missile speed, effect radius, targeting,
 *   damage classification, spell-shield behaviour and the notes exist in no Riot endpoint.
 * - Data Dragon \`runesReforged.json\` and \`summoner.json\` on the same patch, for \`RUNE_NAMES\`
 *   and \`SUMMONER_SPELL_NAMES\` — op.gg answers in ids and nobody can say an id out loud.
 * - op.gg \`${OPGG}\`, jungle only, for \`tier2\` — what is built, maxed
 *   and won with, as counts with their sample sizes. Validated with ArkType at the boundary; a
 *   champion whose payload changed shape carries \`tier2: null\` rather than a degraded section.
 *
 * ## What \`agreed\` means, and why some fields are empty
 *
 * Data Dragon and the wiki are independent transcriptions of the same patch, so for every slot
 * this table checks that they agree on the ability's NAME, its COOLDOWN per rank and its COST per
 * rank. ${slotsAgreed} of ${slotsChecked} slots agree. A slot that does not keeps its prose — both sources
 * carry the same sentences — and has every NUMERIC field blanked, with the disagreement recorded
 * in \`conflicts\`. An empty \`cooldown\` therefore means "the sources disagreed and the number was
 * withheld", never "no cooldown".
 *
 * Regenerate with \`pnpm fetch:champions\`. A new patch is a new diff.
 */

export interface ChampionAbilityRow {
	slot: "P" | "Q" | "W" | "E" | "R"
	name: string
	/** Data Dragon's short client line, verbatim. */
	riotSummary: string
	/** Data Dragon's long tooltip, verbatim, placeholders intact. */
	riotTooltip: string
	/** The wiki's rendered description: the same sentences with the numbers filled in. */
	wikiDescription: string
	/** Per-rank damage and ratio lines, already evaluated by the wiki. */
	leveling: string[]
	cooldown: string
	cost: string
	costType: string
	targetRange: string
	castTime: string
	effectRadius: string
	width: string
	speed: string
	queueThreshold: string
	targeting: string
	affects: string
	damageType: string
	projectile: string
	spellShield: string
	/** The wiki's per-ability edge cases. The layer that decides whether a coaching line is true. */
	notes: string[]
	wikiTitle: string
	wikiRevId: number
	agreed: boolean
	conflicts: string[]
	/** Fields the wiki could not expand, as \`field: why\`. Empty above, and SAID to be empty. */
	withheld: string[]
}

export interface ChampionTier2Row {
	sourceUrl: string
	metaVersion: string
	cachedAt: string
	fetchedAt: string
	role: string
	tier: string
	play: number
	winRate: number
	pickRate: number
	banRate: number
	opggTier: number | null
	opggRank: number | null
	opggRankPrevPatch: number | null
	skillOrder: { order: string[]; play: number; win: number } | null
	coreItems: { ids: number[]; play: number; win: number }[]
	boots: { ids: number[]; play: number; win: number }[]
	starterItems: { ids: number[]; play: number; win: number }[]
	lastItems: { ids: number[]; play: number; win: number }[]
	summonerSpells: { ids: number[]; play: number; win: number }[]
	runePage: {
		keystone: number
		primaryTree: number
		primaryRunes: number[]
		secondaryTree: number
		secondaryRunes: number[]
		shards: number[]
		play: number
		win: number
	} | null
	counters: { championId: number; play: number; win: number }[]
	trend: { version: string; rate: number; rank: number | null }[]
	gameLengths: { minutes: number; rate: number }[]
}

export interface ChampionRow {
	/** \`championKey()\`: lowercased, non-letters stripped. The app's lookup key everywhere. */
	key: string
	apiname: string
	id: number
	name: string
	title: string
	wikiPage: string
	resource: string
	rangeType: string
	positions: string[]
	roles: string[]
	tags: string[]
	releasePatch: string
	lastChangedPatch: string
	stats: Record<string, number>
	ratings: Record<string, number>
	abilities: ChampionAbilityRow[]
	/** \`null\` when op.gg had no usable payload for this champion in the jungle. */
	tier2: ChampionTier2Row | null
}

/**
 * Where Tier 1 came from. ONE record for the whole table rather than a copy per champion: all
 * ${rows.length} rows are cut from the same two fetches, and repeating that per champion is pure noise in
 * every patch diff. Per-ability provenance is the \`wikiTitle\` and \`wikiRevId\` on each ability,
 * which is the part that actually differs between them.
 */
export interface ChampionTableSources {
	ddragon: { url: string; patch: string; fetchedAt: string }
	wikiModule: { url: string; fetchedAt: string }
	wikiAbilities: { api: string; fetchedAt: string }
}

/**
 * Rune and summoner-spell names, from Data Dragon on the same patch. op.gg's tier-2 rows are ids
 * and nothing else; these are what turn \`8010\` into a word without anybody writing a map by hand.
 */
export const RUNE_NAMES: Readonly<Record<number, string>> = ${JSON.stringify(runeNames, null, "\t")}

export const SUMMONER_SPELL_NAMES: Readonly<Record<number, string>> = ${JSON.stringify(summonerNames, null, "\t")}

export const CHAMPION_TABLE_SOURCES: ChampionTableSources = ${JSON.stringify(
		{
			ddragon: { url: ddUrl, patch, fetchedAt: ddMeta.fetchedAt },
			wikiModule: { url: WIKI_MODULE, fetchedAt: modMeta.fetchedAt },
			wikiAbilities: { api: WIKI_API, fetchedAt: abilityMeta.fetchedAt }
		},
		null,
		"\t"
	)}

/** The Data Dragon patch every Tier 1 field above was fetched at. */
export const CHAMPION_TABLE_PATCH = ${JSON.stringify(patch)}

/**
 * The NEWEST source timestamp in this table, not the wall clock at generation.
 *
 * Deliberate: re-running the generator against an unchanged cache must produce the same bytes, or
 * every run is a one-line diff and a real change stops being visible in the noise.
 */
export const CHAMPION_TABLE_FETCHED_AT = ${JSON.stringify(
		[ddMeta.fetchedAt, modMeta.fetchedAt, abilityMeta.fetchedAt, renderMeta.fetchedAt].sort().at(-1) ?? ""
	)}

export const CHAMPION_ROWS: readonly ChampionRow[] = ${JSON.stringify(rows, null, "\t")}
`
	mkdirSync(dirname(OUT), { recursive: true })
	writeFileSync(OUT, header)
	console.log(
		`wrote ${OUT}: ${rows.length} champions, ${abilityCount} abilities, ${tier2ByApi.size} tier-2 sections, ` +
			`${(header.length / 1024).toFixed(0)} KB`
	)
	console.log(`cache: ${cacheDir}`)

	/*
	 * The table is an intermediate, not the artefact. What the app reads is `knowledge/context/`,
	 * written from the table by `generate-context.ts` — so a fetch that stopped here would leave the
	 * repo in the one state this design does not allow: fresh facts on disk and a coach still
	 * reading last patch's text, with nothing to say which. The import is dynamic and comes after
	 * the write, because the generator reads the module that was just written.
	 */
	const { generateContext } = await import("./generate-context.ts")
	const tree = await generateContext()
	console.log(
		`wrote knowledge/context/: ${tree.files} files, ${(tree.bytes / 1024 / 1024).toFixed(2)} MB, ` +
			`sha256 ${tree.sha256}`
	)
}

/*
 * Only when run as a command. `src/knowledge/champion-data.test.ts` imports the parsers above to
 * check the generated table against a FRESH fetch, and a test that fetched the whole roster as a
 * side effect of importing would be a test nobody runs.
 */
if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1]))
	void main().catch((e: unknown) => {
		if (e instanceof SourceDown) {
			console.error(`SOURCE UNREACHABLE — keeping the previous cache and the previous ${OUT}.`)
			console.error(`  ${e.message}`)
			process.exit(1)
		}
		throw e
	})
