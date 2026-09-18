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
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
	CHAMPION_ROWS,
	CHAMPION_TABLE_PATCH,
	CHAMPION_TABLE_SOURCES,
	championProvenance,
	championRow,
	championRowById,
	championTableStaleness,
	renderChampionKnowledge
} from "./champion-data.ts"
import { fetchWikitextBatch, parseTemplateFields, renderWikitext, stripFileLinks } from "../../scripts/fetch-champions.ts"

const lillia = championRow("Lillia")

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
		assert.equal(championRow("Bel'Veth")?.apiname, "Belveth")
		assert.equal(championRow("Belveth")?.apiname, "Belveth")
		assert.equal(championRow("MonkeyKing")?.name, "Wukong")
		assert.equal(championRow("Wukong")?.apiname, "MonkeyKing")
		assert.equal(championRow("Nunu & Willump")?.apiname, "Nunu")
		assert.equal(championRowById(876)?.name, "Lillia")
		assert.equal(championRow("Not A Champion"), null)
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

describe("the rendered block", () => {
	const block = renderChampionKnowledge("Lillia", { gamePatch: CHAMPION_TABLE_PATCH })!

	it("leads with its provenance rather than hiding it in a header a consumer strips", () => {
		assert.match(block, /EVERY LINE BELOW WAS FETCHED, NOT WRITTEN/)
		assert.ok(block.includes(championProvenance(lillia!)))
		assert.match(block, new RegExp(`Data Dragon patch ${CHAMPION_TABLE_PATCH.replace(/\./g, "\\.")}`))
	})

	it("carries the sourced Swirlseed text and not the invented one", () => {
		assert.match(block, /detonates upon hitting an enemy or terrain/i)
		assert.doesNotMatch(block, /roll\w*\s+(over|through|past)\s+(terrain|walls?)/i)
	})

	it("says which patch it is speaking for when that is not the game's", () => {
		assert.equal(championTableStaleness(CHAMPION_TABLE_PATCH), null)
		assert.equal(championTableStaleness(`${CHAMPION_TABLE_PATCH}.712.9876`), null)
		const stale = championTableStaleness("16.24.1")
		assert.ok(stale !== null)
		assert.match(stale, /16\.24\.1/)
		assert.match(renderChampionKnowledge("Lillia", { gamePatch: "16.24.1" })!, /^STALE:/m)
	})

	it("turns op.gg's ids into words out of Riot's own tables", () => {
		assert.match(block, /op\.gg, jungle/)
		assert.match(block, /Summoners: Flash \+ Smite/)
		assert.match(block, /keystone Conqueror; Precision —/)
		// Item ids join to the existing generated item table rather than to a map written by hand.
		assert.doesNotMatch(block.split("## What actually wins")[1] ?? "", /item \d+/)
	})

	it("returns null for a champion nobody fetched, rather than something that reads like knowledge", () => {
		assert.equal(renderChampionKnowledge("Not A Champion"), null)
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
