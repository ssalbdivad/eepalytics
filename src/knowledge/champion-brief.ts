/**
 * The champion section of the prompt, built ONLY out of provenanced claims. NODE ONLY.
 *
 * ## What changes here, against `live-knowledge-full.ts` and `prompt.ts`
 *
 * Both of those read a markdown file a model wrote and paste its prose into the prompt. The prose
 * has one provenance header for the whole file, which is why `lillia.md` can cite "op.gg
 * jungle-paths (16.17)" — an endpoint that does not exist, probed three ways on 2026-09-18 — while
 * every sentence under it reads exactly like a sourced one. A file-level citation cannot be wrong
 * about a sentence, because it does not describe sentences.
 *
 * This module never sees prose. It reads the GENERATED table the fetcher writes, checks every claim
 * against the evidence stored beside it, and renders one line per claim with that claim's own
 * source, revision and fetch date in the line. What the model receives is auditable at the
 * granularity a mistake actually has.
 *
 * ## Fail closed, separately per tier
 *
 * Tier 1 is three publishers that agree; a claim of theirs that fails its check is dropped and
 * SHOUTED about in `diagnostics`, because one bad row should not cost the rest of the kit.
 *
 * Tier 2 is one undocumented endpoint with no terms grant and no schema promise. A shape change
 * there does not produce an error, it produces plausible numbers in the wrong places — and a stale
 * build recommendation reads exactly like a fresh one. So if ANY tier-2 claim for a champion fails
 * its check, every tier-2 claim for that champion is dropped and the section simply has no meta
 * block. Half a meta section is worse than none: the model cannot tell which half it is holding.
 *
 * ## The unsourceable half, and the recommendation
 *
 * Routes, gank conditions, clear tempo, spike timing, what an item purchase implies — roughly half
 * of what the hand-written files say — have no source. I probed for one and there is not one:
 * op.gg's payload contains no key matching path/route/camp, and the three aggregate sites that
 * might have published clear routes are 403, Cloudflare-gated and DNS-dead respectively.
 *
 * The honest options are to drop that material or to ship it marked. This module does BOTH, split
 * by who is speaking:
 *
 * - From an agent or a model: DROPPED, with no override. There is no field for it, no derivation
 *   that accepts it and no code path that renders it. This is the owner's instruction and it is
 *   also the measurement: withholding the champion file entirely moved the live path by +1.1 points
 *   [-2.1, +4.2], p = 0.547, so the prose is inert where it is loudest and wrong where it is
 *   quietest. Nothing measurable is lost by dropping it and one measured error goes with it.
 * - From the OWNER: rendered, under a heading that says it has no source, from `knowledge/owner/
 *   <champion>.md` with `author: owner` in the header. He is the only person in this system who
 *   actually knows whether a route is right, his notes are the material that the fetch pipeline
 *   structurally cannot supply, and a coach with his judgment in it is the product. The tripwire is
 *   in `champion-brief.test.ts`: the digest of that directory is pinned, so an agent adding a file
 *   there fails the suite and has to say out loud, in a diff, that it wrote champion prose.
 *
 * Marking is NOT a substitute for accuracy and must not be used as one. This repo already measured
 * that hedging language cannot repair a wrong quantity — "a farm lead of at least 81 CS" was
 * correctly hedged and still false, because the field was a visibility counter. So the unsourced
 * channel carries JUDGMENT, where there is no quantity to be wrong about, and never a number
 * dressed as one.
 */

import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { type } from "arktype"
import { KNOWLEDGE_DIR, championKey } from "./index.ts"
import { CHAMPION_ROWS, CHAMPION_TABLE_SOURCES } from "./champion-table.ts"
import { factsFromRow } from "./claims-from-row.ts"
import {
	CLAIM_FIELDS,
	CLAIM_GROUPS,
	ChampionFactsTableSchema,
	assemble,
	checkClaim,
	renderClaimLine,
	structureLine
} from "./provenance.ts"
import type {
	Assembled,
	ChampionFacts,
	ClaimGroup,
	ClaimRecord,
	SourceRecord,
	SourcedLine
} from "./provenance.ts"

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Where the generated table is expected, in the order it is looked for.
 *
 * Two names because the fetcher is being written in parallel with this and the module that wins is
 * whichever one it emits; both are checked and the one found is reported, so a mismatch shows up as
 * "no champion table found, looked in ..." rather than as a section that silently never renders.
 * `EEPALYTICS_CHAMPION_TABLE` overrides for tests and for a one-off audit of an older table.
 *
 * The contract, which is the whole handshake with `scripts/fetch-champions.ts`: a module exporting
 * `CHAMPION_FACTS: readonly ChampionFacts[]` (or that array as its default export), where
 * `ChampionFacts` is the interface in `provenance.ts`. Same precedent as `src/shared/item-table.ts`
 * — a checked-in `.ts` module rather than JSON, because `--experimental-strip-types` runs it with
 * no build step and no import attribute.
 */
export const CHAMPION_TABLE_CANDIDATES = ["./champion-table.ts", "../shared/champion-table.ts"] as const

export interface TableLoad {
	/** Champion key -> facts, with every claim already checked. Empty when nothing loaded. */
	facts: ReadonlyMap<string, ChampionFacts>
	/** Which specifier answered, or `null` when none did. */
	specifier: string | null
	/**
	 * Everything refused, in words. NEVER swallowed: `pnpm doctor` and the tests read this, because
	 * a knowledge base that quietly ships less than it should is the failure this module exists to
	 * end.
	 */
	diagnostics: string[]
}

const EMPTY: TableLoad = { facts: new Map(), specifier: null, diagnostics: [] }

let cached: Promise<TableLoad> | null = null

/** Test seam. */
export const clearChampionTableCache = (): void => {
	cached = null
	syncCache = null
}

/**
 * Run `checkClaim` over every claim of every champion, and fail closed per tier.
 *
 * Shared by the dynamic loader and the sync one so that the two cannot drift: a claim the async
 * path refuses and the sync path ships would be a fence with a door in it, and the sync path is the
 * one the app actually renders from.
 */
const checkAll = (
	incoming: readonly ChampionFacts[],
	specifier: string,
	diagnostics: string[]
): TableLoad => {
	const facts = new Map<string, ChampionFacts>()
	for (const row of incoming) {
		const sources = new Map<string, SourceRecord>(row.sources.map(s => [s.id, s]))
		const kept: ClaimRecord[] = []
		let tier2Poisoned = false
		for (const claim of row.claims) {
			const reason = checkClaim(claim, sources)
			if (reason === null) {
				kept.push(claim)
				continue
			}
			const tier = CLAIM_FIELDS[claim.field]?.tier
			diagnostics.push(`${row.key}: REFUSED ${reason}`)
			if (tier === "tier2-aggregate" || tier === undefined) tier2Poisoned = true
		}
		/*
		 * One bad tier-2 row means the endpoint moved, and the rest of its numbers are then
		 * unverifiable rather than merely unverified — nothing in the payload says which fields
		 * a reshuffle touched. So the whole tier goes.
		 */
		const claims =
			tier2Poisoned ?
				kept.filter(c => CLAIM_FIELDS[c.field]?.tier !== "tier2-aggregate")
			:	kept
		if (tier2Poisoned)
			diagnostics.push(
				`${row.key}: dropped every tier-2 claim because at least one failed its check — half a meta section is worse than none`
			)
		facts.set(championKey(row.key), { ...row, claims })
	}
	return { facts, specifier, diagnostics }
}

/**
 * Two shapes are accepted, and the difference is which end did the attribution.
 *
 * `CHAMPION_FACTS` is this module's own contract: claims that already carry their source. Nothing
 * writes it today, and it is what a fetcher should emit if per-claim provenance ever moves upstream.
 *
 * `CHAMPION_ROWS` is what `scripts/fetch-champions.ts` writes now — per champion, with the fetch
 * recorded at table level. `claims-from-row.ts` attributes it, using only the fields that table's
 * own header is unambiguous about.
 */
const TableModule = type({
	"CHAMPION_FACTS?": "unknown",
	"CHAMPION_ROWS?": "unknown",
	"CHAMPION_TABLE_SOURCES?": "unknown",
	"default?": "unknown"
})

interface FoundTable {
	specifier: string
	facts?: unknown
	rows?: unknown
	tableSources?: unknown
}

const importTable = async (specifier: string): Promise<FoundTable | null> => {
	try {
		const mod = TableModule(await import(specifier))
		if (mod instanceof type.errors) return null
		const facts = mod.CHAMPION_FACTS ?? mod.default
		if (facts !== undefined) return { specifier, facts }
		if (mod.CHAMPION_ROWS !== undefined)
			return { specifier, rows: mod.CHAMPION_ROWS, tableSources: mod.CHAMPION_TABLE_SOURCES }
		return null
	} catch {
		return null
	}
}

/**
 * Load, validate and check the generated table. Never throws; an absent table is a normal state.
 *
 * The check is per claim and it is the same `checkClaim` the renderer runs, so nothing can be in
 * this map that the renderer would refuse. Doing it at load time means the diagnostics exist before
 * a game starts rather than in the middle of a coaching turn.
 */
export const loadChampionTable = async (override?: string): Promise<TableLoad> => {
	if (!override && cached) return cached
	const run = async (): Promise<TableLoad> => {
		/*
		 * An explicit override is exclusive. A fallback behind it would mean a test or an audit that
		 * meant to read one table quietly reading the shipped one, and reporting on the wrong bytes is
		 * worse than reporting on none.
		 */
		const candidates =
			override ? [override]
			: process.env.EEPALYTICS_CHAMPION_TABLE ? [process.env.EEPALYTICS_CHAMPION_TABLE]
			: [...CHAMPION_TABLE_CANDIDATES]

		let found: FoundTable | null = null
		for (const c of candidates) {
			found = await importTable(c)
			if (found) break
		}
		if (!found)
			return {
				...EMPTY,
				diagnostics: [
					`no generated champion table: looked for ${candidates.join(", ")}. Nothing champion-specific ships until \`scripts/fetch-champions.ts\` writes one.`
				]
			}

		const diagnostics: string[] = []
		let incoming: ChampionFacts[]
		if (found.facts !== undefined) {
			const parsed = ChampionFactsTableSchema(found.facts)
			if (parsed instanceof type.errors)
				return {
					...EMPTY,
					specifier: found.specifier,
					diagnostics: [
						`${found.specifier} does not match the ChampionFacts contract, so NOTHING from it ships: ${parsed.summary}`
					]
				}
			incoming = parsed as unknown as ChampionFacts[]
		} else {
			const rows = Array.isArray(found.rows) ? found.rows : []
			if (rows.length === 0)
				return {
					...EMPTY,
					specifier: found.specifier,
					diagnostics: [`${found.specifier} carries no champion rows, so nothing ships`]
				}
			incoming = []
			for (const raw of rows) {
				const adapted = factsFromRow(raw, found.tableSources)
				if (adapted === null) {
					diagnostics.push(
						`${found.specifier}: a row did not match the shape this loader knows how to attribute, so it ships nothing`
					)
					continue
				}
				incoming.push(adapted.facts)
				/*
				 * Withheld fields are not noise. "sources disagreed, so name/cooldown/cost withheld"
				 * is the fence working, and a reader of the diagnostics should see it happen rather
				 * than wonder why a champion has no cooldowns.
				 */
				diagnostics.push(...adapted.skipped.map(s => `WITHHELD ${s}`))
			}
		}

		return checkAll(incoming, found.specifier, diagnostics)
	}
	const p = run()
	if (!override) cached = p
	return p
}

/* ----------------------------------------------------------------------------- the sync door */

/**
 * The same load, synchronously, off the checked-in table.
 *
 * Every consumer this replaces — the post-game digest, the live system instruction, the champ-select
 * matchup brief — is synchronous today, and making them async to read a checked-in file would spread
 * a promise through three call graphs to buy nothing. The table is a module literal: importing it is
 * a parse, not I/O.
 *
 * The dynamic loader above stays, and it is not redundant. It is the one that can be pointed at a
 * DIFFERENT table — an older patch, a fixture, a candidate regeneration — which is what an audit and
 * every test of this module need. Both run the identical `checkAll`, so a claim cannot ship on one
 * path and be refused on the other.
 */
let syncCache: TableLoad | null = null

export const championTableSync = (): TableLoad => {
	if (syncCache) return syncCache
	const diagnostics: string[] = []
	const incoming: ChampionFacts[] = []
	for (const raw of CHAMPION_ROWS) {
		const adapted = factsFromRow(raw, CHAMPION_TABLE_SOURCES)
		if (adapted === null) {
			diagnostics.push(
				"champion-table.ts: a row did not match the shape this loader knows how to attribute, so it ships nothing"
			)
			continue
		}
		incoming.push(adapted.facts)
		diagnostics.push(...adapted.skipped.map(s => `WITHHELD ${s}`))
	}
	syncCache = checkAll(incoming, "./champion-table.ts", diagnostics)
	return syncCache
}

/**
 * The checked facts for one champion, or `null` — which is a normal state, not a failure.
 *
 * Two lookups, because Riot spells champions two ways and the app sees both. `championKey()` covers
 * every display name the client and the match history return; the apiname fallback covers the
 * handful where Riot's own id is a different word, of which `MonkeyKing` for Wukong is the one that
 * actually appears. Getting this wrong is silent — the coach simply says nothing champion-specific
 * about Wukong — which is exactly the kind of failure this directory exists to stop being silent.
 */
export const championFactsSync = (championName: string): ChampionFacts | null => {
	const { facts } = championTableSync()
	const direct = facts.get(championKey(championName))
	if (direct) return direct
	const wanted = championName.toLowerCase()
	for (const f of facts.values()) if (f.apiname.toLowerCase() === wanted) return f
	return null
}

/**
 * The rendered section for one champion, synchronously. `null` when nothing sourced exists.
 *
 * This is the function the app ships. `championBriefFor` is its async twin and exists for callers
 * that want to aim at another table.
 */
export const championBriefSync = (
	championName: string,
	opts: { owner?: boolean; edgeCases?: boolean } = {}
): Assembled | null =>
	championBrief(championFactsSync(championName), {
		owner: opts.owner === false ? null : ownerNotes(championName),
		edgeCases: opts.edgeCases
	})

/* ------------------------------------------------------------------------- the owner's notes */

export interface OwnerNotes {
	key: string
	writtenAt: string
	claims: readonly ClaimRecord[]
	source: SourceRecord
}

/** Where his own unsourced judgment lives. Nothing else in the repo writes here. */
export const OWNER_DIR = join(KNOWLEDGE_DIR, "owner")

/**
 * His notes for one champion, or `null`.
 *
 * The header must say `author: owner`. That is not a security control — an agent can type it — it
 * is a declaration that makes the diff legible, and the digest pinned in `champion-brief.test.ts`
 * is what makes it loud.
 */
export const ownerNotes = (championName: string): OwnerNotes | null => {
	const key = championKey(championName)
	if (key === "") return null
	let raw: string
	const rel = join("owner", `${key}.md`)
	try {
		raw = readFileSync(join(KNOWLEDGE_DIR, rel), "utf8")
	} catch {
		return null
	}
	const split = raw.indexOf("\n---")
	if (split === -1) return null
	const head = raw.slice(0, split)
	const body = raw.slice(split + 4)
	const header: Record<string, string> = {}
	for (const line of head.split("\n")) {
		const m = /^([A-Za-z]+):\s*(.*)$/.exec(line.trim())
		if (m) header[m[1]!] = (m[2] ?? "").trim()
	}
	if (header.author !== "owner") return null
	const writtenAt = header.writtenAt ?? ""
	if (Number.isNaN(Date.parse(writtenAt))) return null

	const source: SourceRecord = {
		id: "owner",
		tier: "owner-authored",
		publisher: "the owner, by hand",
		url: `knowledge/${rel.replace(/\\/g, "/")}`,
		revision: "hand-written",
		fetchedAt: writtenAt
	}
	const claims: ClaimRecord[] = []
	for (const line of body.split("\n")) {
		const m = /^\s*[-*]\s+(.*)$/.exec(line)
		const text = (m?.[1] ?? "").trim()
		if (text === "") continue
		claims.push({
			id: `${key}.owner.${claims.length + 1}`,
			subject: key,
			group: "judgment",
			field: "judgment.note",
			text,
			sourceId: "owner",
			evidence: text,
			derivation: { kind: "owner" }
		})
	}
	return claims.length === 0 ? null : { key, writtenAt, claims, source }
}

/**
 * A stable digest of `knowledge/owner/`, so its contents cannot change without a test noticing.
 *
 * Sorted names and content hashes rather than a hash of a tar: reproducible across machines and
 * unaffected by mtimes.
 */
export const ownerDirDigest = (dir: string = OWNER_DIR): string => {
	let names: string[] = []
	try {
		names = readdirSync(dir).filter(f => f.endsWith(".md")).sort()
	} catch {
		names = []
	}
	const h = createHash("sha256")
	for (const n of names) {
		h.update(n)
		h.update("\n")
		h.update(createHash("sha256").update(readFileSync(join(dir, n))).digest("hex"))
		h.update("\n")
	}
	return h.digest("hex")
}

/* ------------------------------------------------------------------------------- rendering */

/**
 * The heading over each group. Structural, frozen, and pinned by a test.
 *
 * These say what KIND of thing follows and where it came from. None of them says anything about a
 * champion — the moment one does, it is champion prose I wrote, which is the thing this whole
 * module exists to make impossible.
 */
export const GROUP_TITLES: Record<ClaimGroup, string> = {
	identity: "Identity",
	stats: "Base stats",
	passive: "Passive",
	Q: "Q",
	W: "W",
	E: "E",
	R: "R",
	meta: "What real games did this patch — counts, not advice",
	judgment: "Unverified"
}

export interface BriefOptions {
	/** His own notes. Omit them and nothing unsourced can appear at all. */
	owner?: OwnerNotes | null
	/** The trailing source list. On by default; the only reason to drop it is a token budget. */
	sourceList?: boolean
	/**
	 * `false` drops the wiki's per-ability edge-case notes. On by default.
	 *
	 * They are the most valuable Tier 1 material there is — "spell shield does not prevent the seed
	 * from detonating" exists in no Riot endpoint and is exactly the layer that decides whether a
	 * coaching line is true — and they are also 60% of a champion's bytes: 20,018 of Briar's 34,121
	 * characters. So this is a BUDGET switch and nothing else. It can only ever remove fetched
	 * lines, never add or reword one, which means the failure it can cause is the coach knowing
	 * less, not the coach being wrong.
	 */
	edgeCases?: boolean
}

/**
 * Build the section. `null` when there is nothing sourced to say, which is a normal outcome and is
 * the one the app is in today.
 *
 * A champion with no fetched facts and no owner notes produces NOTHING rather than a header
 * promising facts and delivering none — an empty section is a prompt that invites the model to fill
 * it, which is the failure mode the whole file is about.
 */
export const championBrief = (
	facts: ChampionFacts | null,
	opts: BriefOptions = {}
): Assembled | null => {
	const owner = opts.owner ?? null
	const all = [...(facts?.claims ?? []), ...(owner?.claims ?? [])]
	const claims = opts.edgeCases === false ? all.filter(c => c.field !== "ability.note") : all
	if (claims.length === 0) return null

	const sources: SourceRecord[] = [...(facts?.sources ?? [])]
	if (owner) sources.push(owner.source)
	const byId = new Map(sources.map(s => [s.id, s]))
	const display = facts?.displayName ?? owner?.key ?? ""

	const lines: SourcedLine[] = [
		structureLine("section.heading", { champion: display }),
		structureLine("blank"),
		structureLine("section.preamble"),
		structureLine("blank")
	]

	const used: ClaimRecord[] = []
	for (const group of CLAIM_GROUPS) {
		if (group === "judgment") continue
		const inGroup = claims.filter(c => c.group === group)
		const notices = (facts?.withheld ?? []).filter(n => n.group === group)
		// A group with nothing but notices still gets its heading: "this ability exists and every
		// number about it was withheld" is the most important thing that file can say.
		if (inGroup.length === 0 && notices.length === 0) continue
		lines.push(structureLine("group.heading", { title: GROUP_TITLES[group] }))
		/*
		 * A notice belongs beside the ability it is about, not at the end of the group. `claims.id`
		 * is `<champion>.<slotId>.<field>`, so the slot a claim belongs to is read back off its own
		 * id rather than carried in a second place that could disagree with it.
		 */
		const slotOf = (claim: ClaimRecord): string => claim.id.split(".")[1] ?? ""
		const emitted = new Set<string>()
		const emitNotices = (slotId: string): void => {
			if (emitted.has(slotId)) return
			emitted.add(slotId)
			for (const notice of notices.filter(n => n.slotId === slotId))
				lines.push(
					structureLine(
						notice.kind === "disagreed" ? "group.withheld.disagreed" : "group.withheld.render",
						{ fields: notice.fields }
					)
				)
		}
		for (const [i, claim] of inGroup.entries()) {
			lines.push(renderClaimLine(claim, byId))
			used.push(claim)
			const next = inGroup[i + 1]
			if (next === undefined || slotOf(next) !== slotOf(claim)) emitNotices(slotOf(claim))
		}
		/*
		 * Anything left — a slot where every single line was withheld, so there was no claim to hang
		 * the notice after. They are not claims and carry no citation, because they cite nothing:
		 * they say a value the sources hold did not survive the fence. Without them an ability whose
		 * cooldown was withheld and an ability nobody documents render identically, and Hecarim's Q
		 * shipped with no name, no cooldown and no damage line, with nothing saying that was on
		 * purpose.
		 */
		for (const notice of notices) emitNotices(notice.slotId)
		lines.push(structureLine("blank"))
	}

	const judgments = claims.filter(c => c.group === "judgment")
	if (judgments.length > 0) {
		lines.push(structureLine("owner.heading"))
		lines.push(structureLine("owner.warning"))
		for (const claim of judgments) {
			lines.push(renderClaimLine(claim, byId))
			used.push(claim)
		}
		lines.push(structureLine("blank"))
	}

	if (opts.sourceList !== false) {
		lines.push(structureLine("sources.heading"))
		const counts = new Map<string, number>()
		for (const c of used) counts.set(c.sourceId, (counts.get(c.sourceId) ?? 0) + 1)
		for (const source of sources) {
			const n = counts.get(source.id) ?? 0
			if (n === 0) continue
			lines.push(structureLine("sources.line", { source, claims: n }))
		}
	}

	return assemble(lines, used, sources)
}

/**
 * The convenience the consumers will call: everything for one champion, loaded and rendered.
 *
 * Async because the table is a dynamic import — which is also why the section is built once per
 * game rather than per turn. `null` degrades exactly the way a missing knowledge file does today.
 */
export const championBriefFor = async (
	championName: string,
	opts: { owner?: boolean } = {}
): Promise<Assembled | null> => {
	const { facts } = await loadChampionTable()
	const key = championKey(championName)
	return championBrief(facts.get(key) ?? null, {
		owner: opts.owner === false ? null : ownerNotes(championName)
	})
}

/** What `pnpm doctor` should print: what shipped, what was refused, and how old it is. */
export const briefDiagnostics = async (): Promise<string[]> => {
	const { facts, specifier, diagnostics } = await loadChampionTable()
	const head =
		specifier === null ?
			"champion table: NONE"
		:	`champion table: ${specifier}, ${facts.size} champions, ${[...facts.values()].reduce((n, f) => n + f.claims.length, 0)} checked claims`
	return [head, ...diagnostics]
}

/** Resolved here so a caller does not have to know how `knowledge/` is found. */
export const CHAMPIONS_DIR = resolve(HERE, "../../knowledge/champions")
