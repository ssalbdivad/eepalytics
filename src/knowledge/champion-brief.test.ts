/**
 * The loader, the renderer and the two tripwires.
 *
 * Two of these tests are about what happens when something is WRONG with the generated table, and
 * they matter more than the happy path. The repo's standing lesson is that a feature which cannot
 * fail loudly will fail silently for a month; a champion table is a file that stops being updated
 * without anything on screen changing, and a build recommendation from a patch that shipped in July
 * reads exactly like one from this morning.
 *
 * Every fixture is a quote from a real payload, with its URL and fetch date, for the same reason as
 * in `provenance.test.ts`: a test file full of invented champion facts would be the next hiding
 * place for the thing this module exists to stop.
 */

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { after, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

/*
 * The knowledge root is read at import time, so it is set BEFORE the module under test loads. Each
 * test file runs in its own process under `node --test`, so this cannot leak into another file.
 */
const ROOT = mkdtempSync(join(tmpdir(), "eep-brief-"))
process.env.EEPALYTICS_KNOWLEDGE_DIR = ROOT
/*
 * The generated table is pointed at nothing, so every case here is about THIS module rather than
 * about whatever the fetcher last wrote. The cases that want a table pass one explicitly.
 */
process.env.EEPALYTICS_CHAMPION_TABLE = join(ROOT, "absent.mjs")
mkdirSync(join(ROOT, "owner"), { recursive: true })

const {
	championBrief,
	championBriefFor,
	championBriefSync,
	clearChampionTableCache,
	loadChampionTable,
	ownerDirDigest,
	ownerNotes,
	GROUP_TITLES
} = await import("./champion-brief.ts")
const { auditAssembled, tracePhrase } = await import("./provenance.ts")

after(() => rmSync(ROOT, { recursive: true, force: true }))

/* ------------------------------------------------------------------------------- fixtures */

/** Data Dragon 16.18.1 `Lillia.json`, fetched 2026-09-18. */
const DDRAGON = {
	id: "ddragon",
	tier: "tier1-mechanics",
	publisher: "Riot Data Dragon",
	url: "https://ddragon.leagueoflegends.com/cdn/16.18.1/data/en_US/champion/Lillia.json",
	revision: "16.18.1",
	fetchedAt: "2026-09-18T18:15:00Z"
}

/** op.gg champion API, `meta.version` 16.18, `cached_at` 2026-09-19 07:16:16. */
const OPGG = {
	id: "opgg",
	tier: "tier2-aggregate",
	publisher: "op.gg",
	url: "https://lol-api-champion.op.gg/api/na/champions/ranked/lillia/jungle",
	revision: "16.18",
	fetchedAt: "2026-09-19T07:16:16Z"
}

const E_DESCRIPTION =
	"Lillia hurls a seed that damages and slows those it lands on. If it doesn't hit anything, it will continue rolling until it hits a wall or target."

const facts = (over: Record<string, unknown> = {}) => ({
	key: "lillia",
	apiname: "Lillia",
	displayName: "Lillia",
	sources: [DDRAGON, OPGG],
	claims: [
		{
			id: "lillia.e.name",
			subject: "lillia",
			group: "E",
			field: "ability.name",
			text: "Swirlseed",
			sourceId: "ddragon",
			evidence: `{"id":"LilliaE","name":"Swirlseed","cooldownBurn":"12","costBurn":"70"}`,
			derivation: { kind: "json", path: "name" },
			agreesWith: ["wiki"]
		},
		{
			id: "lillia.e.effect",
			subject: "lillia",
			group: "E",
			field: "ability.effect",
			text: "If it doesn't hit anything, it will continue rolling until it hits a wall or target.",
			sourceId: "ddragon",
			evidence: E_DESCRIPTION,
			derivation: { kind: "verbatim" }
		},
		{
			id: "lillia.meta.summoners",
			subject: "lillia",
			group: "meta",
			field: "meta.summoners",
			text: "Flash + Smite",
			sourceId: "opgg",
			evidence: `{"summoner_spells":[{"label":"Flash + Smite","play":5029,"win":2500}]}`,
			derivation: { kind: "json", path: "summoner_spells.0.label" },
			sample: { games: 5029, wins: 2500, bracket: "emerald+" }
		}
	],
	...over
})

let n = 0

/** Write a throwaway generated table and hand back a specifier the loader can import. */
const tableModule = (rows: unknown): string => {
	const file = join(ROOT, `table-${n++}.mjs`)
	writeFileSync(file, `export const CHAMPION_FACTS = ${JSON.stringify(rows, null, "\t")}\n`)
	return `file://${file}`
}

/* --------------------------------------------------------------------------------- loading */

describe("loadChampionTable", () => {
	it("says so, in words, when no table has been generated yet", async () => {
		clearChampionTableCache()
		const load = await loadChampionTable(`file://${join(ROOT, "nothing-here.mjs")}`)
		strictEqual(load.facts.size, 0)
		strictEqual(load.diagnostics.length, 1)
		match(load.diagnostics[0]!, /no generated champion table/)
	})

	it("ships nothing at all from a table that does not match the contract", async () => {
		const load = await loadChampionTable(tableModule([{ key: "lillia", claims: "all of them" }]))
		strictEqual(load.facts.size, 0)
		match(load.diagnostics[0]!, /does not match the ChampionFacts contract/)
	})

	it("loads claims that check out", async () => {
		const load = await loadChampionTable(tableModule([facts()]))
		strictEqual(load.diagnostics.length, 0)
		strictEqual(load.facts.get("lillia")!.claims.length, 3)
	})

	/**
	 * A tier-1 row that fails is dropped alone: the three mechanics publishers agree with each other
	 * and a single bad row is a bad row. Losing the rest of the kit over it would trade a wrong line
	 * for no lines.
	 */
	it("drops one bad tier-1 claim and keeps the rest, loudly", async () => {
		const bad = facts()
		bad.claims[1]!.text = "It rolls over terrain, and grants vision of what it rolls past."
		const load = await loadChampionTable(tableModule([bad]))
		const kept = load.facts.get("lillia")!.claims.map(c => c.id)
		deepStrictEqual(kept, ["lillia.e.name", "lillia.meta.summoners"])
		match(load.diagnostics.join("\n"), /REFUSED .*does not occur in its own evidence/)
	})

	/**
	 * A tier-2 row that fails means op.gg's undocumented shape moved, and nothing in the payload says
	 * which other fields the move touched. So the whole tier goes and the section simply has no meta
	 * block — the model cannot tell which half of a half-section it is holding.
	 */
	it("drops EVERY tier-2 claim when one of them fails, and keeps tier 1", async () => {
		const bad = facts()
		const extra = structuredClone(bad.claims[2]!)
		extra.id = "lillia.meta.core-items"
		extra.field = "meta.core-items"
		extra.text = "Liandry's Torment, Riftmaker, Rabadon's Deathcap"
		const broken = structuredClone(bad.claims[2]!)
		broken.id = "lillia.meta.winrate"
		broken.field = "meta.winrate"
		broken.text = "49.67"
		broken.derivation = { kind: "json", path: "summary.win_rate" }
		bad.claims.push(extra as never, broken as never)

		const load = await loadChampionTable(tableModule([bad]))
		const kept = load.facts.get("lillia")!.claims.map(c => c.id)
		deepStrictEqual(kept, ["lillia.e.name", "lillia.e.effect"])
		match(load.diagnostics.join("\n"), /dropped every tier-2 claim/)
	})
})

/* ------------------------------------------------------------------------------- rendering */

describe("championBrief", () => {
	it("renders one line per claim, every one of them traceable", async () => {
		const load = await loadChampionTable(tableModule([facts()]))
		const brief = championBrief(load.facts.get("lillia")!)!
		const report = auditAssembled(brief.text, brief)
		ok(report.ok, `untraced: ${report.untraced.join(" | ")}`)
		strictEqual(report.claimLines, 3)
		strictEqual(report.unsourcedClaims, 0)
		deepStrictEqual(report.revisions, ["ddragon 16.18.1", "opgg 16.18"])
		ok(brief.text.includes(GROUP_TITLES.E))
		ok(brief.text.includes("[ddragon 16.18.1, fetched 2026-09-18]"))
		ok(brief.text.includes("(n=5,029 games, 2,500 wins, emerald+)"))
		// The source list at the foot is what makes the section auditable from the prompt alone.
		ok(brief.text.includes(OPGG.url))
	})

	it("returns nothing rather than an empty promise of facts", () => {
		strictEqual(championBrief(null), null)
	})

	it("finds a phrase's source in one call", async () => {
		const load = await loadChampionTable(tableModule([facts()]))
		const brief = championBrief(load.facts.get("lillia")!)!
		const hits = tracePhrase(brief, "continue rolling")
		strictEqual(hits.length, 1)
		strictEqual(hits[0]!.source!.revision, "16.18.1")
		strictEqual(tracePhrase(brief, "over terrain").length, 0)
	})
})

/* --------------------------------------------------------------------------- the owner's own */

describe("the unsourced channel", () => {
	const write = (name: string, body: string) => writeFileSync(join(ROOT, "owner", name), body)

	it("renders his notes under a heading that says they have no source", async () => {
		write(
			"lillia.md",
			"author: owner\nwrittenAt: 2026-09-18\n---\n- Full clear to four before you look at a lane.\n"
		)
		const brief = (await championBriefFor("Lillia"))!
		ok(brief.text.includes("UNVERIFIED — his own notes, not fetched from anywhere"))
		ok(brief.text.includes("- unverified — the owner's own note: Full clear to four before you look at a lane. [owner hand-written, fetched 2026-09-18]"))
		const report = auditAssembled(brief.text, brief)
		ok(report.ok)
		strictEqual(report.unsourcedClaims, 1)
	})

	/*
	 * An agent dropping a file here without the header gets nothing rendered. This is not a security
	 * control — an agent can type the header — it is a declaration, and the digest below is what
	 * makes typing it loud.
	 */
	it("ignores a note that does not declare who wrote it", async () => {
		write("kayn.md", "sourcedAt: 2026-09-18\n---\n- He hits level six fast.\n")
		strictEqual(ownerNotes("Kayn"), null)
		strictEqual(await championBriefFor("Kayn"), null)
	})

	it("can be withheld entirely, which is what every automated caller should do", async () => {
		write("viego.md", "author: owner\nwrittenAt: 2026-09-18\n---\n- Respect the reset.\n")
		ok((await championBriefFor("Viego")) !== null)
		strictEqual(await championBriefFor("Viego", { owner: false }), null)
	})

	/**
	 * THE TRIPWIRE. `knowledge/owner/` is the only directory in this repo whose contents may reach a
	 * prompt without a source, so its digest is pinned here. An agent that adds a file fails the
	 * suite and has to change this constant in the same diff — which is the visible admission the
	 * owner asked for, since no mechanism can stop a determined writer.
	 *
	 * Today the directory does not exist, and this is the digest of nothing.
	 */
	it("pins the digest of the directory where unsourced notes would live", () => {
		strictEqual(
			ownerDirDigest(resolve(HERE, "../../knowledge/owner")),
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
		)
	})
})

/**
 * The sync door, against the table that actually ships.
 *
 * Everything above points the loader at fixtures, which is right for testing the loader and wrong
 * for testing the thing the app calls: `championBriefSync` reads the checked-in
 * `champion-table.ts` deliberately, so a caller cannot be handed a different table by an
 * environment variable. These cases are therefore about the real 173 rows.
 *
 * The lookup has two doors because Riot spells champions two ways. Wukong's apiname is
 * `MonkeyKing`, and a miss here is SILENT — the coach just says nothing champion-specific about
 * him — which is the failure mode this whole directory exists to make loud.
 */
describe("championBriefSync, against the shipped table", () => {
	it("resolves a display name, an apiname and a punctuated name", () => {
		for (const [name, expected] of [
			["Lillia", "LILLIA"],
			["Wukong", "WUKONG"],
			["MonkeyKing", "WUKONG"],
			["Bel'Veth", "BEL'VETH"],
			["Nunu & Willump", "NUNU & WILLUMP"]
		] as const) {
			const brief = championBriefSync(name)
			ok(brief !== null, `${name} has no fetched row`)
			match(brief.text, new RegExp(`^## ${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — FETCHED FACTS`))
		}
	})

	it("returns null for a champion nobody fetched, rather than an empty section", () => {
		// An empty section is a prompt that invites the model to fill it. Absence is the honest state.
		strictEqual(championBriefSync(""), null)
		strictEqual(championBriefSync("Zzznotachampion"), null)
	})

	it("carries no sentence that no source published", () => {
		const brief = championBriefSync("Lillia")!
		for (const pattern of [/rolls? over terrain/i, /vision of what it rolls past/i, /bonus damage to monsters/i])
			strictEqual(pattern.test(brief.text), false, `the deleted prose is back: ${pattern}`)
		// And what IS there is the wiki's own sentence, which says the opposite.
		match(brief.text, /detonates upon hitting an enemy or terrain while on the ground/i)
	})
})
