/**
 * The adapter, run over the whole generated table.
 *
 * This is the test that says whether the fence is affordable: if attributing a real table produced
 * a pile of refusals, the fence would be a nice idea that nobody could ship. It does not. On the
 * committed 16.18.1 table, 173 champions yield 16,608 claims and NONE fails.
 *
 * Both of those numbers moved and the previous ones are kept here because the delta is the point.
 * It used to read 22,626 claims and ONE refusal — a raw `<span>` that survived the fetcher's tag
 * stripping in Dr. Mundo's E. The claims that left are the flattened wiki tables the adapter now
 * drops: 6,026 cells over 157 runs in 87 champion files, and 22,634 − 6,026 = 16,608 is the whole
 * of the difference. The refusal did NOT leave with them and this change cannot take credit for it:
 * re-checked on the committed table, ZERO of the 937 abilities carry a note with an HTML tag in it
 * at all, so the `<span>` went out with a fetch, not with this filter.
 *
 * Bounds rather than exact counts, because the table is regenerated every patch and a test that has
 * to be edited on every patch is a test that gets deleted on the second one.
 */

import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { factsFromRow, flattenedTableCells, soleSourcedClaims, FLATTENED_TABLE_FIELDS } from "./claims-from-row.ts"
import { championBrief } from "./champion-brief.ts"
import { auditAssembled, checkClaim, tracePhrase } from "./provenance.ts"
import type { ChampionFacts } from "./provenance.ts"

const table = await (async () => {
	try {
		const mod = (await import("./champion-table.ts")) as {
			CHAMPION_ROWS?: readonly { key: string }[]
			CHAMPION_TABLE_SOURCES?: unknown
		}
		return mod.CHAMPION_ROWS ? { rows: mod.CHAMPION_ROWS, sources: mod.CHAMPION_TABLE_SOURCES } : null
	} catch {
		return null
	}
})()

const adaptAll = (): { facts: ChampionFacts[]; withheld: string[] } => {
	const facts: ChampionFacts[] = []
	const withheld: string[] = []
	for (const row of table?.rows ?? []) {
		const r = factsFromRow(row, table?.sources)
		if (!r) continue
		facts.push(r.facts)
		withheld.push(...r.skipped)
	}
	return { facts, withheld }
}

describe("factsFromRow, over the real table", () => {
	it("attributes the whole table and almost everything checks out", (t) => {
		if (table === null) return t.skip("no generated champion table in this checkout")
		const { facts } = adaptAll()
		let claims = 0
		const failures: string[] = []
		for (const f of facts) {
			const sources = new Map(f.sources.map(s => [s.id, s]))
			for (const c of f.claims) {
				claims += 1
				const why = checkClaim(c, sources)
				if (why !== null) failures.push(why)
			}
		}
		console.log(
			`${facts.length} champions, ${claims} claims, ${failures.length} refused: ${failures.slice(0, 3).join(" | ")}`
		)
		ok(claims > 10_000, `expected a real table, got ${claims} claims`)
		/*
		 * A handful of refusals is the fence working on upstream noise. A flood would mean the
		 * attribution in `claims-from-row.ts` has drifted from what the fetcher writes, and the right
		 * response then is to fix the adapter rather than to relax the check.
		 */
		ok(failures.length < claims / 100, `${failures.length} of ${claims} claims refused`)
	})

	it("refuses raw HTML that survived the fetcher rather than sending it to a model", (t) => {
		if (table === null) return t.skip("no generated champion table in this checkout")
		const { facts } = adaptAll()
		for (const f of facts) {
			const sources = new Map(f.sources.map(s => [s.id, s]))
			for (const c of f.claims)
				if (/<[a-zA-Z/][^>]*>/.test(c.text))
					ok(
						checkClaim(c, sources) !== null,
						`${c.id} carries a tag and was not refused: ${c.text.slice(0, 80)}`
					)
		}
	})

	/** The cross-check made structural: a slot the two tier-1 sources disagreed on ships no number. */
	it("withholds name, cooldown and cost wherever the sources disagreed", (t) => {
		if (table === null) return t.skip("no generated champion table in this checkout")
		const { facts, withheld } = adaptAll()
		const disagreed = withheld.filter(w => /sources disagreed/.test(w))
		ok(disagreed.length > 0, "expected the table to record at least one disagreement")
		for (const w of disagreed) {
			const prefix = w.split(":")[0]!
			const key = prefix.split(".")[0]!
			const ids = facts.find(x => x.key === key)!.claims.map(c => c.id)
			for (const suffix of ["name", "cooldown", "cost"])
				ok(
					!ids.includes(`${prefix}.${suffix}`),
					`${prefix} shipped a ${suffix} the sources disagreed about`
				)
		}
	})
})

/**
 * The two 2026-09-19 fixes, pinned on the real table rather than on a fixture, because both are
 * claims about what the corpus contains and a fixture cannot be wrong about the corpus.
 */
describe("what the adapter refuses to flatten, and what it refuses to infer", () => {
	it("drops a wiki table that lost its rows and columns, and says how many cells went", (t) => {
		if (table === null) return t.skip("no generated champion table in this checkout")
		const { facts, withheld } = adaptAll()
		/*
		 * The shape the defect took: `htmlToText` turns `</th>` into ": ", so a table laid out with
		 * its header cells in their own rows arrives as header / ":" / value, three notes deep. Not
		 * one bare ":" may survive into a claim, and neither may its neighbours — a cell severed
		 * from its header is a statement whose condition has been deleted, which is worse for the
		 * long ones ("Other abilities are disabled.") than for "Disabled".
		 */
		for (const f of facts)
			for (const c of f.claims)
				if (c.field === "ability.note")
					ok(c.text.trim() !== ":", `${c.id} is a bare table separator: ${JSON.stringify(c.text)}`)

		const dropped = withheld.filter(w => /a table in the wiki's notes/.test(w))
		ok(dropped.length > 0, "expected the 16.18.1 table to carry at least one flattened wiki table")
		const cells = flattenedTableCells(facts)
		ok(cells > 1_000, `only ${cells} cells withheld — the detector has stopped finding the tables`)
		// Every drop is announced in the champion's own file, so a reader sees why the lines are gone.
		for (const f of facts) {
			const notices = (f.withheld ?? []).filter(n => FLATTENED_TABLE_FIELDS.test(n.fields))
			for (const n of notices) strictEqual(n.kind, "render")
		}
	})

	it("says Data Dragon agreed only where Data Dragon published something", (t) => {
		if (table === null) return t.skip("no generated champion table in this checkout")
		const { facts } = adaptAll()
		/*
		 * Data Dragon files the passive outside `spells` and publishes one entry per Q/W/E/R slot,
		 * so the fetcher's cross-check reaches the first form of each non-passive slot and stops. A
		 * passive claim that says `agreesWith: ["ddragon"]` is asserting agreement from a source
		 * that was never asked — which is what 294 claims did until this was split.
		 */
		let sole = 0
		for (const f of facts)
			for (const c of f.claims) {
				const parts = c.id.split(".")
				// `<key>.<slotId>.<suffix>` is an ability claim; `<key>.<field>` is identity or meta.
				if (parts.length !== 3) continue
				const slotId = parts[1]!
				if (!/^[pqwer]\d?$/.test(slotId)) continue
				// A passive, or any second-and-later form of a slot — the 245 Data Dragon never sees.
				if (slotId[0] !== "p" && !/\d$/.test(slotId)) continue
				ok(
					c.agreesWith === undefined,
					`${c.id} claims Data Dragon agreed about a slot Data Dragon does not publish`
				)
				if (c.soleSource !== undefined) sole += 1
			}
		strictEqual(sole, soleSourcedClaims(facts))
		ok(sole > 0, "expected passives and second forms to be marked single-sourced")
	})
})

describe("the Lillia section this produces", () => {
	it("says what the wiki says about Swirlseed, and cites the revision it read", (t) => {
		if (table === null) return t.skip("no generated champion table in this checkout")
		const row = table.rows.find(r => r.key === "lillia")
		if (!row) return t.skip("no Lillia row")
		const { facts } = factsFromRow(row, table.sources)!
		const brief = championBrief(facts)!

		const report = auditAssembled(brief.text, brief)
		ok(report.ok, `untraced: ${report.untraced.slice(0, 3).join(" | ")}`)
		ok(report.claimLines > 40, `expected a substantial section, got ${report.claimLines} lines`)

		const effect = facts.claims.find(c => c.id === "lillia.e.effect")!
		ok(effect.text.includes("detonates upon hitting an enemy or terrain"))
		// Every line carries the wiki revision it came from, which is what makes it dismissible by age.
		const cited = tracePhrase(brief, "detonates upon hitting an enemy or terrain")
		strictEqual(cited.length, 1)
		ok(/^rev-\d+$/.test(cited[0]!.source!.revision))
	})

	it("contains nothing that says the seed rolls over terrain", (t) => {
		if (table === null) return t.skip("no generated champion table in this checkout")
		const { facts } = adaptAll()
		for (const f of facts)
			for (const c of f.claims)
				ok(
					!/rolls over terrain|vision of what it rolls/i.test(c.text),
					`${c.id} still says it: ${c.text.slice(0, 80)}`
				)
	})
})
