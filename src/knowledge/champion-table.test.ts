/**
 * The generated champion table, checked against the sources it claims to have come from.
 *
 * Two jobs, and the second is the one that matters.
 *
 * 1. The table is internally coherent — it joins, it carries provenance, it says when it is stale.
 * 2. **It does not contain the two claims this repo invented.** `knowledge/champions/lillia.md`
 *    said Swirlseed "rolls OVER TERRAIN, and grants VISION of what it rolls past", and said W
 *    "deals BONUS DAMAGE TO MONSTERS". Neither is true and neither had a source. The point of a
 *    fetched table is that those sentences become impossible rather than merely absent, so these
 *    tests assert the fetched text says the OPPOSITE — terrain STOPS the seed, and the wiki's only
 *    minion/monster modifier on W runs the other way.
 *
 * The network test is skipped rather than failed when the wiki is unreachable. A test suite that
 * goes red on someone else's outage gets ignored, and an ignored suite catches nothing.
 *
 * ## Why the filename says `champion-data` and nothing else does
 *
 * `src/knowledge/champion-data.ts` was DELETED on 2026-09-19. It was a facade: `championRow`,
 * `championRowById`, `championCount`, `championProvenance`, `championTableStaleness` and
 * `fetchedChampions`, with no importer anywhere in `src/` or `scripts/` except this file. The app
 * reads `knowledge/context/`, which is committed text; `champion-context.ts` does its own key
 * lookup over filenames and carries its own staleness sentence, character for character. A fix
 * applied in the facade could not have changed anything a player saw.
 *
 * It outlived its usefulness by a day because deleting it would have deleted THIS file, which is
 * the only place the generated table is checked against a FRESH WIKI FETCH and the only place the
 * two refuted Lillia claims are asserted absent. So every assertion it made is still here, re-homed
 * onto `champion-table.ts` and onto the parsers in `scripts/fetch-champions.ts` directly — the two
 * things this file was ever really testing. The four-line lookup the facade exported now lives
 * below as `row()`, because a test needing to find Lillia is not a reason to ship a module.
 *
 * The file keeps its name only because renaming it to `champion-table.test.ts` was outside the set
 * of files this change was allowed to touch. That rename is the last step and it is not done.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
	CHAMPION_ROWS,
	CHAMPION_TABLE_FETCHED_AT,
	CHAMPION_TABLE_PATCH,
	CHAMPION_TABLE_SOURCES
} from "./champion-table.ts"
import type { ChampionRow } from "./champion-table.ts"
import { championKey } from "../shared/champion-key.ts"
import { type } from "arktype"
import {
	OpggResponse,
	toTier2,
	fetchWikitextBatch,
	htmlToText,
	pageVariablePreamble,
	parseTemplateFields,
	renderFault,
	renderWikitext,
	stripFileLinks
} from "../../scripts/fetch-champions.ts"

/*
 * What `championRow` did, in the one place that needed it. The client spells champions three ways
 * across its endpoints — display name, apiname, and `MonkeyKing` for Wukong — so both the key and
 * the apiname resolve here. `null` is a normal answer and must degrade to "say nothing
 * champion-specific", never to a guess, which is the assertion on `Not A Champion` below.
 */
const BY_KEY = new Map<string, ChampionRow>(CHAMPION_ROWS.map(r => [r.key, r]))
const BY_APINAME = new Map<string, ChampionRow>(CHAMPION_ROWS.map(r => [r.apiname.toLowerCase(), r]))
const BY_ID = new Map<number, ChampionRow>(CHAMPION_ROWS.map(r => [r.id, r]))

const row = (name: string): ChampionRow | null =>
	BY_KEY.get(championKey(name)) ?? BY_APINAME.get(name.toLowerCase()) ?? null

const lillia = row("Lillia")

describe("the generated table", () => {
	it("joins every champion to an id, a key and at least one ability", () => {
		assert.ok(CHAMPION_ROWS.length > 150, `only ${CHAMPION_ROWS.length} champions`)
		const keys = new Set<string>()
		const ids = new Set<number>()
		for (const r of CHAMPION_ROWS) {
			assert.notEqual(r.key, "", `${r.apiname} has no key`)
			assert.ok(r.id > 0, `${r.apiname} has no id`)
			assert.ok(r.abilities.length >= 4, `${r.apiname} has ${r.abilities.length} abilities`)
			assert.ok(!keys.has(r.key), `duplicate key ${r.key}`)
			assert.ok(!ids.has(r.id), `duplicate id ${r.id}`)
			keys.add(r.key)
			ids.add(r.id)
		}
	})

	it("resolves the spellings the client actually uses", () => {
		assert.equal(row("Bel'Veth")?.apiname, "Belveth")
		assert.equal(row("Belveth")?.apiname, "Belveth")
		assert.equal(row("MonkeyKing")?.name, "Wukong")
		assert.equal(row("Wukong")?.apiname, "MonkeyKing")
		assert.equal(row("Nunu & Willump")?.apiname, "Nunu")
		assert.equal(BY_ID.get(876)?.name, "Lillia")
		assert.equal(row("Not A Champion"), null)
	})

	it("carries every ability's own wiki revision, so a claim stays checkable after the page moves", () => {
		for (const a of lillia!.abilities) {
			assert.ok(a.wikiRevId > 0, `${a.name} has no revid`)
			assert.match(a.wikiTitle, /^Template:Data Lillia\//)
		}
	})

	it("blanks the numbers on any ability whose two sources disagree, and says it did", () => {
		for (const r of CHAMPION_ROWS)
			for (const a of r.abilities) {
				if (a.agreed) continue
				assert.equal(a.cooldown, "", `${r.apiname} ${a.name} kept a cooldown despite ${a.conflicts.join("; ")}`)
				assert.equal(a.cost, "", `${r.apiname} ${a.name} kept a cost despite ${a.conflicts.join("; ")}`)
				assert.deepEqual(a.leveling, [], `${r.apiname} ${a.name} kept a leveling table`)
				assert.ok(a.conflicts.length > 0, `${r.apiname} ${a.name} is not agreed but names no conflict`)
			}
	})

	it("agrees across sources on the overwhelming majority of slots", () => {
		const checked = CHAMPION_ROWS.flatMap(r => r.abilities).filter(a => a.slot !== "P")
		const agreed = checked.filter(a => a.agreed).length
		// Measured at 95.4% on 16.18.1. The survivors are real divergences — Data Dragon reports a
		// cooldown of 0 for ability-haste-scaling and resourceless abilities where the wiki reports
		// the real one — and they are WITHHELD rather than guessed between.
		assert.ok(agreed / checked.length > 0.9, `only ${agreed}/${checked.length} slots agree`)
	})
})

describe("the two claims this repo invented", () => {
	const e = lillia!.abilities.find(a => a.slot === "E" && a.name === "Swirlseed")!
	const w = lillia!.abilities.find(a => a.slot === "W")!

	it("Swirlseed: terrain STOPS the seed — it does not roll over it", () => {
		assert.match(e.riotTooltip, /collides with terrain/i)
		assert.match(e.wikiDescription, /detonates upon hitting an enemy or terrain/i)
		// The exact shape of the invented claim: rolling THROUGH, OVER or PAST terrain.
		const sourced = `${e.riotTooltip}\n${e.riotSummary}\n${e.wikiDescription}\n${e.notes.join("\n")}`
		assert.doesNotMatch(sourced, /roll\w*\s+(over|through|past)\s+(terrain|walls?)/i)
		assert.doesNotMatch(sourced, /(over|through)\s+(terrain|walls?)/i)
	})

	it("Swirlseed: the reveal is on the enemies it hits, for a stated time — not a trail of vision", () => {
		assert.match(e.wikiDescription, /revealing them for 2 seconds/i)
		const sourced = `${e.riotTooltip}\n${e.wikiDescription}\n${e.notes.join("\n")}`
		assert.doesNotMatch(sourced, /vision (of|along|down)/i)
		assert.doesNotMatch(sourced, /reveals (whoever|whatever) it rolls/i)
	})

	it("Watch Out! Eep!: no source gives it a bonus against monsters", () => {
		const sourced = `${w.riotTooltip}\n${w.riotSummary}\n${w.wikiDescription}\n${w.notes.join("\n")}\n${w.leveling.join("\n")}`
		assert.doesNotMatch(sourced, /monster/i)
		// And the modifier that IS published runs the other way.
		assert.match(sourced, /50% damage to minions/i)
	})

	it("the numbers the wiki computed are carried whole, not re-derived here", () => {
		assert.deepEqual(e.leveling, ["Magic Damage: 60 / 85 / 110 / 135 / 160 (+ 50% AP)"])
		assert.equal(e.cooldown, "12")
		assert.equal(e.cost, "70")
		assert.equal(e.costType, "Mana")
		assert.equal(e.castTime, "0.4")
		assert.equal(e.queueThreshold, "0.5")
		// An ultimate has three ranks, and the wiki only knows that when told which slot it is
		// rendering. This asserts the fix: five interpolated ranks here would be a fabricated number.
		const r = lillia!.abilities.find(a => a.slot === "R")!
		assert.equal(r.cooldown, "150 / 130 / 110")
	})
})

/*
 * `renderChampionKnowledge` is DELETED and so are the four tests that exercised it. It was a second
 * renderer for data `champion-brief.ts` already renders, nothing outside this file imported it, and
 * the app reads committed text.
 *
 * `championTableStaleness` and `championProvenance` are deleted too, 2026-09-19, and the two cases
 * below are what their tests were actually asserting once the dead function is taken out of the
 * middle. The provenance case reads the table's own source record instead of a sentence assembled
 * from it. The staleness case went to `champion-context.test.ts`, onto the function that ships.
 */
describe("what the table says about itself", () => {
	/*
	 * The four-part patch case that used to squat here MOVED to `champion-context.test.ts` on
	 * 2026-09-19, onto `contextStaleness` itself, which is where it always belonged.
	 */
	it("names every source a champion's numbers rest on, with the revisions that make them checkable", () => {
		// One source record for the whole table — all 173 rows are cut from the same two fetches —
		// so the per-champion half of provenance is the revision on each ability and the tier-2
		// row's own url and date. Both halves have to be present or a line cannot be re-checked.
		assert.equal(CHAMPION_TABLE_SOURCES.ddragon.patch, CHAMPION_TABLE_PATCH)
		for (const [name, url, fetchedAt] of [
			["ddragon", CHAMPION_TABLE_SOURCES.ddragon.url, CHAMPION_TABLE_SOURCES.ddragon.fetchedAt],
			["wikiModule", CHAMPION_TABLE_SOURCES.wikiModule.url, CHAMPION_TABLE_SOURCES.wikiModule.fetchedAt],
			["wikiAbilities", CHAMPION_TABLE_SOURCES.wikiAbilities.api, CHAMPION_TABLE_SOURCES.wikiAbilities.fetchedAt],
			["wikiRendered", CHAMPION_TABLE_SOURCES.wikiRendered.api, CHAMPION_TABLE_SOURCES.wikiRendered.fetchedAt]
		] as [string, string, string][]) {
			assert.match(url, /^https:\/\//, `${name} names no url`)
			assert.match(fetchedAt, /^\d{4}-\d{2}-\d{2}T/, `${name} has no fetch date`)
		}
		assert.ok(
			lillia!.abilities.every(a => a.wikiRevId > 0),
			"an ability with no revision cannot be re-checked after the page moves"
		)
		assert.equal(lillia!.tier2?.role, "jungle")
		assert.match(lillia!.tier2!.sourceUrl, /op\.gg/)
		assert.match(lillia!.tier2!.fetchedAt, /^\d{4}-\d{2}-\d{2}T/)
	})

	/*
	 * `CHAMPION_TABLE_FETCHED_AT` calls itself "the NEWEST source timestamp in this table, not the
	 * wall clock at generation", and that sentence is load-bearing: it is why re-running the
	 * generator against an unchanged cache reproduces the file byte for byte instead of minting a
	 * one-line diff that buries a real change. NOTHING CHECKED IT, so this does.
	 *
	 * Two things measured on the table committed on 2026-09-19 — the tier-2 half is what the case
	 * below computes, and the cache stamps come from
	 * `find data/champions -name '?.fetched' -exec sh -c 'echo "$(cat "$1") $1"' _ {} + | sort`
	 * (glob the name as `*` + `.fetched`; it is written that way here only because the literal
	 * would close this comment) — both of which a reader will otherwise trip over:
	 *
	 * Both halves of it were wrong when this case was written, in the same direction, and both are
	 * FIXED as of 2026-09-19 — which is why the case now asserts EQUALITY rather than an
	 * inequality, and why that is the stronger statement:
	 *
	 * 1. The declared stamp was 2026-09-19T07:26:27.648Z while the newest of the 46 stamps the
	 *    table PUBLISHED was 2026-09-18T22:36:19.603Z — 8h50m older, which reads exactly like a
	 *    wall clock leaking in and was not one. The generator maxed over FOUR cache stamps and
	 *    published three; the fourth was the wiki RENDER cache
	 *    (`data/champions/16.18.1/wiki-rendered-4.json.fetched`, whose stamp is that date exactly).
	 *    `CHAMPION_TABLE_SOURCES` now names it as `wikiRendered`, so the record can account for its
	 *    own date.
	 * 2. The max did NOT include the 43 tier-2 stamps, so "the newest source timestamp in this
	 *    table" held only because op.gg happened to be fetched before the last render — refresh
	 *    op.gg alone and the table would have declared a date older than 43 of its own rows while
	 *    the reproducibility argument still read as true. The max now includes them.
	 */
	it("declares exactly the newest of the stamps it publishes", () => {
		assert.match(CHAMPION_TABLE_FETCHED_AT, /^\d{4}-\d{2}-\d{2}T/)
		const published = [
			CHAMPION_TABLE_SOURCES.ddragon.fetchedAt,
			CHAMPION_TABLE_SOURCES.wikiModule.fetchedAt,
			CHAMPION_TABLE_SOURCES.wikiAbilities.fetchedAt,
			CHAMPION_TABLE_SOURCES.wikiRendered.fetchedAt,
			...CHAMPION_ROWS.flatMap(r => (r.tier2 ? [r.tier2.fetchedAt] : []))
		]
		assert.equal(published.length, 47, "the table publishes 4 Tier 1 fetches and 43 tier-2 rows")
		assert.equal(
			CHAMPION_TABLE_FETCHED_AT,
			[...published].sort().at(-1),
			"the declared date is not the newest stamp this table publishes"
		)
	})
})

describe("the table against a fresh fetch", () => {
	const reachable = async (): Promise<boolean> => {
		try {
			await fetch(CHAMPION_TABLE_SOURCES.wikiAbilities.api, { signal: AbortSignal.timeout(10_000) })
			return true
		} catch {
			return false
		}
	}

	it("Lillia's E is still, byte for byte, what the wiki serves today", async t => {
		if (!(await reachable())) return t.skip("wiki unreachable")
		const title = "Template:Data Lillia/Swirlseed"
		const pages = await fetchWikitextBatch([title])
		const page = pages.get(title)
		assert.ok(page, "the wiki no longer serves the page the table cites")

		const fields = parseTemplateFields(page.wikitext)
		const [description, leveling, cooldown, cost] = await renderWikitext(
			["description", "leveling", "cooldown", "cost"].map(f => ({
				wikitext: stripFileLinks(fields[f] ?? ""),
				skill: "E"
			}))
		)

		const stored = lillia!.abilities.find(a => a.name === "Swirlseed")!
		assert.equal(page.revId, stored.wikiRevId, "the wiki page was edited since the table was generated")
		assert.equal(description, stored.wikiDescription)
		assert.equal(leveling, stored.leveling[0])
		assert.equal(cooldown, stored.cooldown)
		assert.equal(cost, stored.cost)

		// And the freshly fetched text still refutes the claim the markdown file made.
		assert.match(description!, /detonates upon hitting an enemy or terrain/i)
		assert.doesNotMatch(description!, /over terrain/i)
	})

	it("Riot still says the seed collides with terrain", async t => {
		const url = `https://ddragon.leagueoflegends.com/cdn/${CHAMPION_TABLE_PATCH}/data/en_US/champion/Lillia.json`
		let tooltip: string
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
			if (!res.ok) return t.skip(`ddragon HTTP ${res.status}`)
			tooltip = ((await res.json()) as { data: { Lillia: { spells: { tooltip: string }[] } } }).data.Lillia.spells[2]!
				.tooltip
		} catch {
			return t.skip("ddragon unreachable")
		}
		assert.equal(tooltip, lillia!.abilities.find(a => a.name === "Swirlseed")!.riotTooltip)
		assert.match(tooltip, /collides with terrain/i)
	})
})

/**
 * The three ways the wiki's own answer arrives BROKEN, and what the fetcher does about each.
 *
 * All three were shipping on 2026-09-18 and none of them could be seen from inside the pipeline:
 * every one produces a grammatical line with a citation on the end of it, which is the exact shape
 * a correct line has. They were found by going back to the URL — `scripts/verify-fetched.ts` — and
 * they are pinned here so that a change to the renderer has to argue with a test rather than with
 * a reader six weeks later.
 */
describe("what the wiki returns when a field is rendered on its own", () => {
	it("keeps the page's own variable definitions, in order, and nothing else from the head", () => {
		const page =
			"<!-- comment -->{{#vardefine:r_d1|15}}{{#vardefine:r_ap|15}}" +
			"{{#vardefine:total|{{#expr:{{#var:r_d1}}*3}}}}\n" +
			"{{{{{1|Ability data}}}|The Culling\n|champion = Lucian\n|leveling = {{#var:r_d1}}\n}}"
		assert.equal(
			pageVariablePreamble(page),
			"{{#vardefine:r_d1|15}}{{#vardefine:r_ap|15}}{{#vardefine:total|{{#expr:{{#var:r_d1}}*3}}}}"
		)
		// Nothing below the first field line is preamble, however many braces it carries.
		assert.equal(pageVariablePreamble("|leveling = {{#vardefine:x|1}}"), "")
	})

	/*
	 * The fault detector is deliberately aggressive: the cost of a false positive is a withheld
	 * line, and the cost of a false negative is a coach reading "(+ % AP)" out loud. Every string
	 * in the first list is one that really shipped.
	 */
	it("refuses a field whose numbers did not survive the render", () => {
		for (const broken of [
			"Physical Damage Per Shot: to (+ % AD) (+ % AP)",
			"Primary Physical Damage: to (+ nil% AD)",
			"Each Scalemail stack is worth Expression error: Unexpected * operator.",
			"Damage per second: / to / (+ Expression error: Unexpected / operator.% AP)",
			"Shield Strength: to (+ % AP) (+ % of maximum health)",
			"a field with {{ap|60 to 160}} still in it"
		])
			assert.notEqual(renderFault(broken), null, `passed: ${broken}`)

		for (const fine of [
			"Physical Damage Per Shot: 15 / 30 / 45 (+ 25% AD) (+ 15% AP)",
			"Magic Damage: 60 / 85 / 110 / 135 / 160 (+ 50% AP)",
			"6 / 5.5 / 5 / 4.5 / 4",
			"Active: Lillia lobs a seed at the target location that rolls forward indefinitely.",
			"Critical strike damage with Infinity Edge: 253% AD"
		])
			assert.equal(renderFault(fine), null, `refused: ${fine}`)
	})

	/*
	 * A footnote marker is a bracketed integer pointing at a list that is nowhere in the delivered
	 * file, and the integer is assigned PER PARSE REQUEST — the same note came back `[17]` inside
	 * the fetcher's batch and `[5]` rendered alone. So it is both noise in a prompt and a value
	 * that depends on what it was batched with, which the cache's byte-reproducibility rests on.
	 */
	it("drops the wiki's footnote markers and the footnote list itself", () => {
		const html =
			'<ul><li>a note<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">' +
			'<span class="cite-bracket">[</span>1<span class="cite-bracket">]</span></a></sup> end</li></ul>' +
			'<div class="mw-references-wrap"><ol class="references">' +
			'<li id="cite_note-1"><span class="mw-cite-backlink"><a href="#cite_ref-1">↑</a></span> ' +
			'<span class="reference-text">Bard Q&amp;A comment by Rabid Llama</span></li></ol></div>'
		assert.equal(htmlToText(html), "- a note end")
	})

	/** And none of the three survives anywhere in the table that shipped. */
	it("leaves no broken field, no footnote and no backlink in the generated table", () => {
		const bad: string[] = []
		for (const row of CHAMPION_ROWS)
			for (const ability of row.abilities)
				for (const [field, value] of [
					["wikiDescription", ability.wikiDescription],
					["cooldown", ability.cooldown],
					["cost", ability.cost],
					["castTime", ability.castTime],
					["targetRange", ability.targetRange],
					...ability.leveling.map((l, i) => [`leveling.${i}`, l]),
					...ability.notes.map((n, i) => [`notes.${i}`, n])
				] as [string, string][]) {
					if (value === "") continue
					const fault = renderFault(value)
					if (fault !== null) bad.push(`${row.name} ${ability.slot} ${field}: ${fault}`)
					if (/\[\d+\]|↑/.test(value)) bad.push(`${row.name} ${ability.slot} ${field}: a footnote survived`)
				}
		assert.deepEqual(bad.slice(0, 5), [])
	})
})

/**
 * Tier 2 fails closed, per champion, and the two ways it can fail are different answers.
 *
 * op.gg is one undocumented endpoint with no terms grant, so the rule is that a payload which
 * changed SHAPE yields no tier-2 section rather than a degraded one — a stale build recommendation
 * reads exactly like a fresh one. The check is exercised here rather than trusted, because the
 * first draft of this schema said `skills` was an object, every jungle champion was withheld for a
 * "shape change" that was this repo's own mistake, and fail-closed is only honest when the closed
 * state means the SOURCE moved.
 */
describe("the op.gg fence", () => {
	const payload = (over: Record<string, unknown> = {}) => ({
		meta: { version: "16.18", cached_at: "2026-09-18T00:00:00Z" },
		data: {
			summary: {
				id: 876,
				positions: [
					{
						name: "JUNGLE",
						stats: { play: 5186, win_rate: 0.4967, pick_rate: 0.05, ban_rate: 0.01, kda: 3.1 }
					}
				]
			},
			skills: [{ play: 2596, win: 1488, order: ["Q", "W", "E"] }],
			...over
		}
	})

	it("accepts the shape the endpoint actually serves", () => {
		const checked = OpggResponse(payload())
		assert.ok(!(checked instanceof type.errors))
		const row = toTier2(checked as never, {
			sourceUrl: "https://example.invalid",
			fetchedAt: "2026-09-18T00:00:00Z",
			role: "jungle",
			tier: "emerald_plus"
		})
		assert.equal(row?.play, 5186)
		assert.deepEqual(row?.skillOrder?.order, ["Q", "W", "E"])
	})

	it("refuses a payload whose shape moved, rather than shipping part of it", () => {
		// `skills` as an object is the exact shape mistake that withheld all 45 junglers once.
		assert.ok(OpggResponse(payload({ skills: { order: ["Q"] } })) instanceof type.errors)
		// A win rate that arrived as a string is the shape change that would otherwise be rendered.
		const bad = payload()
		;(bad.data.summary.positions[0]!.stats as Record<string, unknown>).win_rate = "49.67%"
		assert.ok(OpggResponse(bad) instanceof type.errors)
	})

	it("returns nothing for a champion op.gg does not list in this role", () => {
		const checked = OpggResponse(payload())
		assert.ok(!(checked instanceof type.errors))
		assert.equal(
			toTier2(checked as never, {
				sourceUrl: "https://example.invalid",
				fetchedAt: "2026-09-18T00:00:00Z",
				role: "support",
				tier: "emerald_plus"
			}),
			null
		)
	})

	/** And the shipped table shows the same fence working on real payloads. */
	it("leaves a champion without a tier-2 section rather than half of one", () => {
		for (const row of CHAMPION_ROWS) {
			if (row.tier2 === null) continue
			assert.ok(row.tier2.play > 0, `${row.name} carries a tier-2 section with no sample`)
			assert.equal(row.tier2.role, "jungle")
			assert.notEqual(row.tier2.sourceUrl, "")
		}
	})
})
