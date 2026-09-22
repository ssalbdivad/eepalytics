/**
 * The instrument that opens the loop, pinned — and one live run of it, skipped when the wiki is
 * down rather than failed.
 *
 * `verify-fetched.ts` is the only check in this repo that can see a pipeline misreading its source,
 * because it goes back to the URL each delivered line cites. That makes its own parser the thing
 * nobody else can catch: if `parseDelivered` silently stopped recognising a line shape, the script
 * would report "0 mismatches" over a corpus it had not read, which is exactly the shape of a clean
 * result that means nothing. So the parser is pinned against text copied out of the committed
 * tree, and one champion is really fetched.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { parseDelivered, verify, DEFAULT_SAMPLE } from "./verify-fetched.ts"

/** Copied out of `knowledge/context/champions/lillia.md`, trimmed to one line of each shape. */
const DELIVERED = `## LILLIA — FETCHED FACTS (copied from the sources named on each line)

### Identity
- title: The Bashful Bloom [wikiModule raw@2026-09-18, fetched 2026-09-18]
- released in patch: V10.15 [wikiModule raw@2026-09-18, fetched 2026-09-18]

### E
- name: Swirlseed [wiki-e rev-4007662, fetched 2026-09-18]
- cooldown: 12 [wiki-e rev-4007662, fetched 2026-09-18]
- damage by rank: Magic Damage: 60 / 85 / 110 / 135 / 160 (+ 50% AP) [wiki-e rev-4007662, fetched 2026-09-18]
- WITHHELD (name, cooldown, cost): Data Dragon and the wiki disagree about it on this patch, so no value is shown. This app does not know what it is — say nothing about it.

### Where this section came from
- wikiModule: League of Legends Wiki, Module:ChampionData/data, revision raw@2026-09-18, fetched 2026-09-18 — 7 lines — https://wiki.leagueoflegends.com/en-us/Module:ChampionData/data?action=raw
- wiki-e: League of Legends Wiki, ability data template, revision rev-4007662, fetched 2026-09-18 — 18 lines — https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Lillia%2FSwirlseed&prop=text
`

describe("reading the delivered file", () => {
	const parsed = parseDelivered("lillia", DELIVERED)

	it("takes the label, the value and the citation off every line", () => {
		deepStrictEqual(
			parsed.lines.map(l => [l.label, l.sourceId, l.revision]),
			[
				["title", "wikiModule", "raw@2026-09-18"],
				["released in patch", "wikiModule", "raw@2026-09-18"],
				["name", "wiki-e", "rev-4007662"],
				["cooldown", "wiki-e", "rev-4007662"],
				["damage by rank", "wiki-e", "rev-4007662"]
			]
		)
		strictEqual(parsed.lines[4]!.value, "Magic Damage: 60 / 85 / 110 / 135 / 160 (+ 50% AP)")
	})

	/*
	 * A WITHHELD notice is the one delivered line with no citation, because it cites nothing — it
	 * says a value the sources hold did not survive the fence. Counting it as uncited would make
	 * every champion with a disagreement look like a provenance failure.
	 */
	it("exempts the withheld notice and nothing else", () => {
		deepStrictEqual(parsed.uncited, [])
		const tampered = parseDelivered(
			"lillia",
			DELIVERED.replace("### Where this section came from", "- the seed rolls over terrain and grants vision\n\n### Where this section came from")
		)
		deepStrictEqual(tampered.uncited, ["- the seed rolls over terrain and grants vision"])
	})

	it("reads the footer so a line can be taken back to the page it names", () => {
		strictEqual(
			parsed.urls.get("wiki-e"),
			"https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template%3AData%20Lillia%2FSwirlseed&prop=text"
		)
	})

	/** His champion and the counterparts the stored corpus pairs him against, not a random draw. */
	it("samples the champions this app actually meets", () => {
		ok(DEFAULT_SAMPLE.includes("lillia"))
		ok(DEFAULT_SAMPLE.includes("kayn"))
		ok(DEFAULT_SAMPLE.length >= 15)
	})
})

describe("one champion, against the live wiki", () => {
	/*
	 * Skipped rather than failed when the wiki is unreachable: a suite that goes red on someone
	 * else's outage gets ignored, and an ignored suite catches nothing. A MISMATCH is a real
	 * failure — it means a delivered line says something the source does not — while `stale` is the
	 * wiki having been edited since the fetch, which is news rather than a defect.
	 */
	it("finds every Lillia line in the source it cites", async t => {
		let results
		try {
			results = await verify(["lillia"])
		} catch {
			return t.skip("the wiki is unreachable")
		}
		/*
		 * MISMATCH is a defect and fails. STALE is the source having moved since the fetch, which
		 * is not a defect and must not turn this suite red — on 2026-09-22 a new League patch
		 * changed Lillia's base armour and her last-changed patch, and this case failed for a
		 * reason no change in this repo could fix. A suite that is red for an unfixable reason
		 * hides the next real failure. See the module note in `verify-fetched.ts`.
		 */
		const mismatched = results.filter(r => r.verdict === "mismatch")
		deepStrictEqual(
			mismatched.map(r => `${r.label}: delivered ${r.delivered.slice(0, 60)} | source ${(r.source ?? "").slice(0, 60)}`),
			[]
		)
		for (const r of results.filter(r => r.verdict === "stale"))
			t.diagnostic(`stale (the source moved, not a defect): ${r.label} — ${r.note ?? ""}`)
		ok(
			results.filter(r => r.verdict === "match").length > 60,
			`only ${results.filter(r => r.verdict === "match").length} lines were checked, which is not an audit`
		)
	})
})
