/**
 * The adapter, run over the whole generated table.
 *
 * This is the test that says whether the fence is affordable: if attributing a real table produced
 * a pile of refusals, the fence would be a nice idea that nobody could ship. It does not. At the
 * time of writing, 173 champions yield 22,626 claims and ONE fails — a raw `<span>` that survived
 * the fetcher's tag stripping in Dr. Mundo's E, which is exactly the kind of thing that reaches a
 * model and is never noticed.
 *
 * Bounds rather than exact counts, because the table is regenerated every patch and a test that has
 * to be edited on every patch is a test that gets deleted on the second one.
 */

import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { factsFromRow } from "./claims-from-row.ts"
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
