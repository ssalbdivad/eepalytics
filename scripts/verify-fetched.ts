/**
 * Check the DELIVERED champion text against the LIVE source it cites, line by line.
 *
 * ## What this is for, and how it differs from everything else already here
 *
 * `scripts/audit-knowledge.ts` proves a delivered line traces to a claim in the ledger.
 * `src/knowledge/champion-context.test.ts` proves the committed tree is what the generator writes.
 * Both of those are closed loops: they compare the pipeline against itself, so a pipeline that
 * misreads its source passes every one of them. That is precisely the failure that cost this app
 * months — `lillia.md` was internally consistent and said the Swirlseed rolls over terrain.
 *
 * This script opens the loop. It reads `knowledge/context/champions/<key>.md` — the bytes the
 * coach is actually handed — pulls the citation off the end of every line, GOES BACK TO THAT URL,
 * and requires the value on the line to be what the source says today. Nothing in it reads the
 * cache, the table or the generator's output.
 *
 * It found the thing it was written to find. Before 2026-09-19 the fetcher rendered each template
 * field on its own, without the `{{#vardefine:}}` preamble its own page writes above the field
 * list, so every `{{#var:}}` in a field expanded to the empty string and the wiki returned prose
 * with the numbers deleted:
 *
 *     delivered: "- damage by rank: Physical Damage Per Shot: to (+ % AD) (+ % AP) [wiki-r ...]"
 *     source:    "Physical Damage Per Shot: 15 / 30 / 45 (+ 25% AD) (+ 15% AP)"
 *
 * 204 fields over 75 ability pages and 47 champions were in that state and NOTHING downstream
 * could see it, because a line with its number removed is still a grammatical line with a citation
 * on the end of it.
 *
 * ## What a mismatch means, and what it does not
 *
 * The wiki is edited continuously, so a value that moved since the fetch is NOT a defect — it is a
 * stale fetch, and the report says `stale` and prints both revisions. A mismatch is only reported
 * as a defect when the cited revision is still the current one and the text still disagrees.
 *
 * Tier 2 (op.gg) is not checked. Its numbers change every few hours by design, so re-fetching them
 * can only ever produce a difference, which would say nothing about the renderer.
 *
 * ## The one thing it does NOT establish
 *
 * It reuses `renderWikitext` from the fetcher to expand a template field, because the wiki's own
 * template arithmetic is not something to re-implement in a checker — re-implementing it is how a
 * checker starts agreeing with a bug. So a fault INSIDE that call is invisible here; what this
 * proves is that the delivered bytes are what that call returns today, per line, per source.
 *
 * Run:
 *   pnpm verify:fetched                       # the default sample: his champion and his counterparts
 *   pnpm verify:fetched -- --champions lillia,kayn,briar
 *   pnpm verify:fetched -- --all              # all 173, a few thousand wiki renders, slow
 *   pnpm verify:fetched -- --out data/eval/verify-fetched-<date>.json
 *
 * Network only. Read-only on the repo unless `--out` is given. Never touches the LCU.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
	fetchWikitextBatch,
	pageVariablePreamble,
	parseChampionData,
	parseTemplateFields,
	renderFault,
	renderWikitext,
	stripFileLinks,
	htmlToText,
	WIKI_MODULE,
	fetchText
} from "./fetch-champions.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, "..")
const CONTEXT = join(REPO, "knowledge", "context", "champions")

/**
 * The default sample, and it is not arbitrary: his own champion, then every enemy jungler the
 * stored corpus actually paired him against, then the champions whose SHAPE is awkward — two forms,
 * two names in a slot, a slot Data Dragon and the wiki spell differently. A clean result on a
 * random sample says much less than a clean result on the ones most likely to break.
 */
export const DEFAULT_SAMPLE = [
	"lillia",
	"kayn",
	"fiddlesticks",
	"briar",
	"shyvana",
	"hecarim",
	"masteryi",
	"viego",
	"zed",
	"sylas",
	"shaco",
	"morgana",
	"belveth",
	"wukong",
	"jarvaniv",
	"nidalee",
	"elise",
	"gnar",
	"aphelios",
	"lucian"
] as const

/** Which rendered template field a delivered label was cut from. The renderer's own mapping. */
const LABEL_FIELD: Record<string, string> = {
	"what it does": "description",
	"damage by rank": "leveling",
	cooldown: "cooldown",
	cost: "cost",
	"target range": "target range",
	"cast time": "cast time",
	"effect radius": "effect radius",
	width: "width",
	"missile speed": "speed",
	targeting: "targeting",
	"damage type": "damagetype",
	"spell shield": "spellshield",
	"edge case": "notes"
}

/** Which key of `Module:ChampionData/data` a delivered identity label was cut from. */
const LABEL_MODULE: Record<string, string> = {
	title: "title",
	resource: "resource",
	"melee or ranged": "rangeType",
	"positions Riot's client lists": "positions",
	"released in patch": "releasePatch",
	"last changed in patch": "lastChangedPatch",
	"base stat": "stats"
}

export interface DeliveredLine {
	label: string
	value: string
	sourceId: string
	revision: string
	fetchedOn: string
}

export interface ParsedFile {
	key: string
	lines: DeliveredLine[]
	/** sourceId -> the URL the file itself prints for it. */
	urls: Map<string, string>
	/** Lines that carry no citation at all. Any non-zero count here is the alarm. */
	uncited: string[]
}

const LINE = /^- (.+?): (.*) \[([A-Za-z0-9-]+) ([^,\]]+), fetched (\d{4}-\d{2}-\d{2})\]$/
const SOURCE_LINE = /^- ([A-Za-z0-9-]+): .*? — \d+ lines? — (\S+)$/

/**
 * Read one committed champion file into lines and their citations.
 *
 * Deliberately a fresh parser over the delivered text rather than anything the renderer exports: a
 * checker that shares the renderer's idea of what a line looks like cannot see a line the renderer
 * got wrong.
 */
export const parseDelivered = (key: string, text: string): ParsedFile => {
	const [body = "", footer = ""] = text.split("### Where this section came from")
	const urls = new Map<string, string>()
	for (const raw of footer.split("\n")) {
		const m = SOURCE_LINE.exec(raw.trim())
		if (m) urls.set(m[1]!, m[2]!)
	}
	const lines: DeliveredLine[] = []
	const uncited: string[] = []
	for (const raw of body.split("\n")) {
		if (!raw.startsWith("- ")) continue
		// The WITHHELD notices are the one line shape with no citation, and correctly so: they cite
		// nothing because they say a value did not survive. Everything else must carry one.
		if (raw.startsWith("- WITHHELD (")) continue
		const m = LINE.exec(raw)
		if (!m) {
			uncited.push(raw)
			continue
		}
		lines.push({ label: m[1]!, value: m[2]!, sourceId: m[3]!, revision: m[4]!, fetchedOn: m[5]! })
	}
	return { key, lines, urls, uncited }
}

/** The page title out of the `action=parse&page=…` URL the file prints for an ability source. */
const titleFromUrl = (url: string): string | null => {
	const m = /[?&]page=([^&]+)/.exec(url)
	return m ? decodeURIComponent(m[1]!.replace(/\+/g, " ")) : null
}

const fold = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim()

export type Verdict = "match" | "mismatch" | "stale" | "unchecked"

export interface LineResult {
	champion: string
	label: string
	sourceId: string
	verdict: Verdict
	delivered: string
	source?: string
	note?: string
}

/* ------------------------------------------------------------------ the module half */

interface ModuleFacts {
	title: string
	resource: string
	rangeType: string
	positions: string[]
	releasePatch: string
	lastChangedPatch: string
	stats: Record<string, number>
}

const STAT_ORDER = [
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
]

const moduleValue = (facts: ModuleFacts, label: string): string | null => {
	const key = LABEL_MODULE[label]
	if (key === undefined) return null
	if (key === "positions") return facts.positions.join(", ")
	if (key === "stats")
		return STAT_ORDER.filter(k => facts.stats[k] !== undefined)
			.map(k => `${k} ${facts.stats[k]}`)
			.join(", ")
	return String((facts as unknown as Record<string, unknown>)[key] ?? "")
}

/* ------------------------------------------------------------------------- the run */

const arg = (flag: string): string | null => {
	const i = process.argv.indexOf(flag)
	return i === -1 ? null : (process.argv[i + 1] ?? null)
}

export const verify = async (keys: readonly string[]): Promise<LineResult[]> => {
	const results: LineResult[] = []

	/* One fetch of the join table for everybody, because it is one page for the whole roster. */
	const moduleRaw = await fetchText(WIKI_MODULE)
	const byApi = parseChampionData(moduleRaw)
	const byKey = new Map<string, ModuleFacts & { apiname: string }>()
	for (const [apiname, w] of byApi)
		byKey.set(apiname.toLowerCase().replace(/[^a-z]/g, ""), {
			apiname,
			title: w.title,
			resource: w.resource,
			rangeType: w.rangeType,
			positions: w.positions,
			releasePatch: w.releasePatch,
			lastChangedPatch: w.lastChangedPatch,
			stats: w.stats
		})
	/*
	 * The file's key is `championKey(displayName)` — `belveth`, `monkeyking` — and the module is
	 * keyed by apiname. They agree for all but the handful whose display name is not their apiname,
	 * so the wiki page name is tried as well before anything is called unresolvable.
	 */
	const byPage = new Map<string, ModuleFacts & { apiname: string }>()
	for (const [apiname, w] of byApi) {
		const facts = byKey.get(apiname.toLowerCase().replace(/[^a-z]/g, ""))!
		byPage.set(w.wikiPage.toLowerCase().replace(/[^a-z]/g, ""), facts)
	}

	for (const key of keys) {
		const path = join(CONTEXT, `${key}.md`)
		if (!existsSync(path)) {
			results.push({
				champion: key,
				label: "(file)",
				sourceId: "-",
				verdict: "unchecked",
				delivered: "",
				note: `no committed file at ${path}`
			})
			continue
		}
		const file = parseDelivered(key, readFileSync(path, "utf8"))
		for (const raw of file.uncited)
			results.push({
				champion: key,
				label: "(uncited line)",
				sourceId: "-",
				verdict: "mismatch",
				delivered: raw.slice(0, 200),
				note: "a delivered line with no citation on it"
			})

		const facts = byKey.get(key) ?? byPage.get(key) ?? null

		/* ------------------------------------------------- identity and stats, against the module */

		for (const line of file.lines.filter(l => l.sourceId === "wikiModule")) {
			if (facts === null) {
				results.push({ ...base(key, line), verdict: "unchecked", note: "no module entry for this key" })
				continue
			}
			const want = moduleValue(facts, line.label)
			if (want === null) {
				results.push({ ...base(key, line), verdict: "unchecked", note: `no module field for "${line.label}"` })
				continue
			}
			results.push({
				...base(key, line),
				verdict: want === line.value ? "match" : "mismatch",
				source: want
			})
		}

		/* ------------------------------------------------ abilities, against the template it cites */

		const abilityLines = file.lines.filter(l => l.sourceId.startsWith("wiki-"))
		const titles = new Map<string, string>()
		for (const l of abilityLines) {
			const url = file.urls.get(l.sourceId)
			const title = url ? titleFromUrl(url) : null
			if (title) titles.set(l.sourceId, title)
		}
		const pages = titles.size > 0 ? await fetchWikitextBatch([...new Set(titles.values())]) : new Map()

		/* Group the champion's fragments into ONE render call, the way the fetcher does. */
		const fragKeys: { sourceId: string; field: string }[] = []
		const frags: { wikitext: string; skill: string }[] = []
		const wanted = new Map<string, Set<string>>()
		for (const l of abilityLines) {
			const field = LABEL_FIELD[l.label]
			if (field === undefined) continue
			const set = wanted.get(l.sourceId) ?? new Set<string>()
			// `what it does` and `damage by rank` are joins of up to four numbered fields.
			if (field === "description") for (const n of ["", "2", "3", "4"]) set.add(`description${n}`)
			else if (field === "leveling") for (const n of ["", "2", "3", "4"]) set.add(`leveling${n}`)
			else set.add(field)
			wanted.set(l.sourceId, set)
		}
		for (const [sourceId, fields] of wanted) {
			const title = titles.get(sourceId)
			const page = title ? pages.get(title) : undefined
			if (!page) continue
			const parsed = parseTemplateFields(page.wikitext)
			const preamble = pageVariablePreamble(page.wikitext)
			const skill = (parsed.skill ?? "").trim() || "Q"
			for (const field of fields) {
				const v = parsed[field]
				if (v === undefined || v.trim() === "") continue
				fragKeys.push({ sourceId, field })
				frags.push({ wikitext: preamble + stripFileLinks(v), skill })
			}
		}
		const texts = frags.length > 0 ? await renderWikitext(frags) : []
		const live = new Map<string, Record<string, string>>()
		for (let i = 0; i < fragKeys.length; i++) {
			const k = fragKeys[i]!
			const rec = live.get(k.sourceId) ?? {}
			rec[k.field] = texts[i] ?? ""
			live.set(k.sourceId, rec)
		}

		for (const line of abilityLines) {
			const title = titles.get(line.sourceId)
			const page = title ? pages.get(title) : undefined
			if (!page) {
				results.push({ ...base(key, line), verdict: "unchecked", note: `could not fetch ${title ?? "the page"}` })
				continue
			}
			const cited = Number(line.revision.replace(/^rev-/, ""))
			const stale = Number.isFinite(cited) && cited !== page.revId
			const field = LABEL_FIELD[line.label]
			const rec = live.get(line.sourceId) ?? {}
			let source: string | null = null
			if (line.label === "name") source = title!.split("/").slice(1).join("/")
			else if (field === "description")
				source = fold(
					["description", "description2", "description3", "description4"]
						.map(k => rec[k] ?? "")
						.filter(s => s !== "")
						.join("\n\n")
				)
			else if (field === "leveling")
				source = fold(
					["leveling", "leveling2", "leveling3", "leveling4"]
						.map(k => rec[k] ?? "")
						.filter(s => s !== "")
						.join(" · ")
				)
			else if (field === "notes") {
				const notes = (rec.notes ?? "")
					.split("\n")
					.map(l => fold(l.replace(/^-\s*/, "")))
					.filter(l => l !== "")
				source = notes.includes(line.value) ? line.value : (notes[0] ?? "")
			} else if (field !== undefined) source = fold(rec[field] ?? "")

			if (source === null) {
				results.push({ ...base(key, line), verdict: "unchecked", note: `no source field for "${line.label}"` })
				continue
			}
			const ok = source === line.value
			results.push({
				...base(key, line),
				verdict: ok ? "match"
				: stale ? "stale"
				: "mismatch",
				source,
				note:
					stale ? `cited rev-${cited}, the wiki is on rev-${page.revId}`
					: ok ? undefined
					: (renderFault(line.value) ?? undefined)
			})
		}

		/* op.gg is deliberately not re-fetched — see the header. */
		for (const line of file.lines.filter(l => l.sourceId === "opgg"))
			results.push({ ...base(key, line), verdict: "unchecked", note: "tier 2 changes hourly; not re-fetched" })
	}
	return results
}

/* ------------------------------------------------------- the second instrument: the article */

/**
 * The same numbers, against the page a HUMAN reads.
 *
 * Everything above compares the delivered line to the `Template:Data` page the fetcher reads,
 * expanded the way the fetcher expands it. That shares a render path with the pipeline, so a fault
 * inside `renderWikitext` would be invisible to it — and a fault inside `renderWikitext` is exactly
 * what shipped: fields expanded alone came back with their numbers deleted and the checker, had it
 * existed, would have agreed with them.
 *
 * So this fetches `wiki.leagueoflegends.com/en-us/<Champion>/LoL`, the rendered article, where the
 * wiki assembles the whole ability box itself with every variable it sets, and requires every
 * per-rank run this app delivers — `60 / 85 / 110 / 135 / 160` — to appear in it verbatim. A run is
 * distinctive enough that finding it is evidence and cheap enough that all 173 champions can be
 * asked. It is the one check in this repo that shares NO code with the thing it is checking.
 */
export const verifyArticles = async (
	keys: readonly string[],
	pageOf: (key: string) => string | null
): Promise<LineResult[]> => {
	const out: LineResult[] = []
	const RUN = /\d[\d.]*(?: \/ \d[\d.]*)+/g
	const NUMERIC_LABEL = /^(cooldown|cost|damage by rank|effect radius|target range)$/
	for (const key of keys) {
		const path = join(CONTEXT, `${key}.md`)
		if (!existsSync(path)) continue
		const page = pageOf(key)
		if (page === null) {
			out.push({ champion: key, label: "(article)", sourceId: "wiki", verdict: "unchecked", delivered: "", note: "no wiki page name" })
			continue
		}
		let article: string
		try {
			/*
			 * `<Champion>/LoL` is the ability page for everyone who also exists in another Riot game,
			 * which is nearly everyone — but the five newest champions (Ambessa, Mel, Yunara, Zaahen,
			 * Locke on 16.18.1) have no such subpage and 404, so the base article is the fallback
			 * rather than a champion silently going unchecked.
			 */
			const url = `https://wiki.leagueoflegends.com/en-us/${encodeURIComponent(page)}`
			article = htmlToText(await fetchText(`${url}/LoL`).catch(() => fetchText(url)))
		} catch (e) {
			out.push({
				champion: key,
				label: "(article)",
				sourceId: "wiki",
				verdict: "unchecked",
				delivered: "",
				note: `could not fetch the article — ${e instanceof Error ? e.message : String(e)}`
			})
			continue
		}
		const flat = article.replace(/\s+/g, " ")
		for (const line of parseDelivered(key, readFileSync(path, "utf8")).lines) {
			if (!NUMERIC_LABEL.test(line.label)) continue
			for (const run of line.value.match(RUN) ?? [])
				out.push({
					champion: key,
					label: line.label,
					sourceId: "article",
					verdict: flat.includes(run) ? "match" : "mismatch",
					delivered: run,
					note: flat.includes(run) ? undefined : `not present in ${page}/LoL`
				})
		}
	}
	return out
}

const base = (champion: string, line: DeliveredLine): Omit<LineResult, "verdict"> => ({
	champion,
	label: line.label,
	sourceId: line.sourceId,
	delivered: line.value
})

const main = async (): Promise<void> => {
	const all = process.argv.includes("--all")
	const listed = arg("--champions")
	const keys =
		all ? readdirSync(CONTEXT)
				.filter(n => n.endsWith(".md") && !n.endsWith(".core.md"))
				.map(n => n.slice(0, -3))
				.sort()
		: listed ? listed.split(",").map(s => s.trim().toLowerCase())
		: [...DEFAULT_SAMPLE]

	if (process.argv.includes("--articles")) {
		const module_ = parseChampionData(await fetchText(WIKI_MODULE))
		const pages = new Map<string, string>()
		for (const [apiname, w] of module_) pages.set(apiname.toLowerCase().replace(/[^a-z]/g, ""), w.wikiPage)
		// The file key is the DISPLAY name's key (`wukong`), the module is keyed by apiname
		// (`MonkeyKing`), so the page is also indexed by its own name before anything is given up on.
		for (const [, w] of module_) pages.set(w.wikiPage.toLowerCase().replace(/[^a-z]/g, ""), w.wikiPage)
		console.log(`checking ${keys.length} champions' numbers against the wiki ARTICLE…`)
		const results = await verifyArticles(keys, k => pages.get(k) ?? null)
		const counts = { match: 0, mismatch: 0, unchecked: 0 }
		for (const r of results) counts[r.verdict as "match" | "mismatch" | "unchecked"] += 1
		for (const r of results.filter(r => r.verdict !== "match"))
			console.log(`${r.verdict.toUpperCase()} ${r.champion} — ${r.label}: ${r.delivered} (${r.note ?? ""})`)
		console.log(
			`\n${keys.length} champions, ${results.length} per-rank runs: ${counts.match} appear verbatim in the ` +
				`article a human reads, ${counts.mismatch} do not, ${counts.unchecked} unchecked.`
		)
		const outPath = arg("--out")
		if (outPath) {
			const p = resolve(REPO, outPath)
			mkdirSync(dirname(p), { recursive: true })
			writeFileSync(p, `${JSON.stringify({ at: new Date().toISOString(), mode: "articles", keys, counts, results }, null, "\t")}\n`)
			console.log(`wrote ${outPath}`)
		}
		if (counts.mismatch > 0) process.exitCode = 1
		return
	}

	console.log(`verifying ${keys.length} champions against the live sources they cite…`)
	const results = await verify(keys)
	const counts = { match: 0, mismatch: 0, stale: 0, unchecked: 0 }
	for (const r of results) counts[r.verdict] += 1

	for (const r of results.filter(r => r.verdict === "mismatch")) {
		console.log(`\nMISMATCH ${r.champion} — ${r.label} [${r.sourceId}]`)
		console.log(`  delivered: ${r.delivered.slice(0, 220)}`)
		console.log(`  source:    ${(r.source ?? "").slice(0, 220)}`)
		if (r.note) console.log(`  note:      ${r.note}`)
	}
	for (const r of results.filter(r => r.verdict === "stale"))
		console.log(`\nSTALE ${r.champion} — ${r.label}: ${r.note}`)

	console.log(
		`\n${keys.length} champions, ${results.length} delivered lines: ` +
			`${counts.match} match the live source, ${counts.mismatch} do not, ` +
			`${counts.stale} moved since the fetch, ${counts.unchecked} not checkable here.`
	)

	const out = arg("--out")
	if (out) {
		const path = resolve(REPO, out)
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), keys, counts, results }, null, "\t")}\n`)
		console.log(`wrote ${out}`)
	}
	if (counts.mismatch > 0) process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
