/**
 * The fence, tested against the bytes the real sources returned.
 *
 * Every fixture in this file is a QUOTE, not an invention: each one carries the URL it came from
 * and the date it was fetched, and nothing here asserts anything about League that those bytes do
 * not say. That is the same rule the module enforces, applied to its own tests — a test file full
 * of plausible champion facts would be the next place an invention hides.
 *
 * The headline case is `refuses the sentence that shipped`: the exact clause that has been in
 * `knowledge/champions/lillia.md` since 2026-09-09, handed the exact evidence it claims to rest on,
 * and refused. That is the whole thesis in one assertion.
 */

import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import {
	CLAIM_FIELDS,
	ProvenanceError,
	STRUCTURE_TEMPLATES,
	assemble,
	auditAssembled,
	checkClaim,
	isSourcedLine,
	renderClaimLine,
	resolveWikitext,
	structureLine,
	traceProse,
	tracePhrase,
	wikitextField
} from "./provenance.ts"
import type { ClaimRecord, SourceRecord } from "./provenance.ts"

const HERE = dirname(fileURLToPath(import.meta.url))

/* ----------------------------------------------------------------------------- the fixtures */

/**
 * Data Dragon 16.18.1, `Lillia.json`, `spells[2].description`, fetched 2026-09-18.
 * https://ddragon.leagueoflegends.com/cdn/16.18.1/data/en_US/champion/Lillia.json
 */
const DDRAGON_E_DESCRIPTION =
	"Lillia hurls a seed that damages and slows those it lands on. If it doesn't hit anything, it will continue rolling until it hits a wall or target."

/** The same file's `spells[2].tooltip`, which still carries Riot's unresolved placeholders. */
const DDRAGON_E_TOOLTIP =
	"Lillia lobs a swirlseed overhead, dealing <magicDamage>{{ impactdamagetotal }} magic damage</magicDamage> where it lands and revealing and <status>Slowing</status> them by {{ slowamount*100 }}% for {{ slowduration }} seconds. If no enemies are hit, the seed rolls until it hits an enemy or collides with terrain."

/**
 * The wiki's ability-data template for the same ability, fetched 2026-09-18 (page revision of
 * `Template:Data Lillia/Swirlseed`, wikitext, templates unresolved).
 * https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template:Data_Lillia/E&prop=wikitext
 */
const WIKI_E_TEMPLATE = `|champion     = Lillia
|skill        = E
|blurb        = {{sbc|Active:}} {{ci|Lillia}} lobs a seed at the target area that rolls forward indefinitely.
|description  = {{sbc|Active:}} '''Lillia''' lobs a seed at the target location that rolls forward indefinitely. The seed detonates upon hitting an enemy or terrain while on the ground, dealing {{as|magic damage}} to enemies in a cone, {{tip|slow|slowing}} them by 40% for 3 seconds and {{tip|standard sight|revealing}} them for 2 seconds.
|leveling     = {{st|Magic Damage|{{ap|60 to 160}} {{as|(+ 50% AP)}}}}
|cooldown     = 12
|cast time    = {{fd|0.4}}
|cost         = 70
|costtype     = Mana
|target range = {{dv|{{tt|700|Lob range}}|{{tt|Global|Roll missile range}}}}
|width        = {{tip|er|icononly = true}} {{tt|120|Lobbed and rolling seed missile width (lobbed seed missile does not collide by itself)}}
|speed        = {{dv|{{tt|5000|Lobbed missile speed}}|{{tt|1400|Rolling missile speed}}}}
|targeting    = Location
}}`

/**
 * Community Dragon 16.18, champion 876, `spells[0]` — the Q, whose per-rank cooldowns are the one
 * thing CDragon has that Data Dragon flattens into a burn string.
 * https://raw.communitydragon.org/16.18/plugins/rcp-be-lol-game-data/global/default/v1/champions/876.json
 */
const CDRAGON_Q_SPELL = `{"spellKey":"q","name":"Blooming Blows","cost":[65,65,65,65,65,65],"cooldownCoefficients":[6,5.5,5,4.5,4,4]}`

const DDRAGON: SourceRecord = {
	id: "ddragon",
	tier: "tier1-mechanics",
	publisher: "Riot Data Dragon",
	url: "https://ddragon.leagueoflegends.com/cdn/16.18.1/data/en_US/champion/Lillia.json",
	revision: "16.18.1",
	fetchedAt: "2026-09-18T18:15:00Z"
}

const WIKI: SourceRecord = {
	id: "wiki",
	tier: "tier1-mechanics",
	publisher: "League of Legends Wiki",
	url: "https://wiki.leagueoflegends.com/en-us/api.php?action=parse&page=Template:Data_Lillia/E",
	revision: "rev-1448428",
	fetchedAt: "2026-09-18T18:17:00Z"
}

const CDRAGON: SourceRecord = {
	id: "cdragon",
	tier: "tier1-mechanics",
	publisher: "Community Dragon",
	url: "https://raw.communitydragon.org/16.18/plugins/rcp-be-lol-game-data/global/default/v1/champions/876.json",
	revision: "16.18",
	fetchedAt: "2026-09-18T18:15:00Z"
}

const OPGG: SourceRecord = {
	id: "opgg",
	tier: "tier2-aggregate",
	publisher: "op.gg",
	url: "https://lol-api-champion.op.gg/api/na/champions/ranked/lillia/jungle",
	revision: "16.18",
	fetchedAt: "2026-09-19T07:16:16Z"
}

const SOURCES = new Map([DDRAGON, WIKI, CDRAGON, OPGG].map(s => [s.id, s]))

const claim = (over: Partial<ClaimRecord> = {}): ClaimRecord => ({
	id: "lillia.e.effect",
	subject: "lillia",
	group: "E",
	field: "ability.effect",
	text: "If it doesn't hit anything, it will continue rolling until it hits a wall or target.",
	sourceId: "ddragon",
	evidence: DDRAGON_E_DESCRIPTION,
	derivation: { kind: "verbatim" },
	...over
})

/* ------------------------------------------------------------------------------ the wikitext */

describe("resolveWikitext", () => {
	it("renders the wiki's own description the way the wiki renders it", () => {
		const field = wikitextField(WIKI_E_TEMPLATE, "description")
		ok(field !== null)
		strictEqual(
			resolveWikitext(field),
			"Active: Lillia lobs a seed at the target location that rolls forward indefinitely. The seed detonates upon hitting an enemy or terrain while on the ground, dealing magic damage to enemies in a cone, slowing them by 40% for 3 seconds and revealing them for 2 seconds."
		)
	})

	it("keeps the number out of a {{tt}} and drops the icon-only parameter beside it", () => {
		strictEqual(resolveWikitext(wikitextField(WIKI_E_TEMPLATE, "width")!), "120")
		strictEqual(resolveWikitext(wikitextField(WIKI_E_TEMPLATE, "target range")!), "700 / Global")
		strictEqual(
			resolveWikitext(wikitextField(WIKI_E_TEMPLATE, "leveling")!),
			"Magic Damage: 60 to 160 (+ 50% AP)"
		)
	})

	/*
	 * The alternative — strip the braces and keep whatever is inside — is how
	 * `{{tt|120|Lobbed and rolling seed missile width}}` becomes a coaching sentence about a missile
	 * width that nobody wrote. Refusing is the only safe default for a template nobody has read.
	 */
	it("refuses a template it has no rule for rather than guessing at it", () => {
		strictEqual(resolveWikitext("{{未知|17|a number}}"), null)
		strictEqual(resolveWikitext("{{{1|fallback}}}"), null)
	})
})

/* ------------------------------------------------------------------------------- the refusal */

describe("checkClaim", () => {
	it("accepts a sentence that occurs in the bytes it cites", () => {
		strictEqual(checkClaim(claim(), SOURCES), null)
	})

	/**
	 * THE ONE THAT MATTERS.
	 *
	 * `knowledge/champions/lillia.md`, written by a model on 2026-09-09 and shipped every day since,
	 * says Swirlseed "rolls **over terrain**" and "**grants vision of what it rolls past**". Its
	 * header cites ddragon and the wiki. Handed the actual bytes of either one, the claim cannot be
	 * built: Riot says the seed "collides with terrain" and the wiki says it "detonates upon hitting
	 * an enemy or terrain".
	 *
	 * That clause licensed 38% of champion-specific live lines and 7.3% of 1,075 stored post-game
	 * items. Nothing in the repo could see it, because nothing in the repo compared a sentence to a
	 * source. This assertion is that comparison.
	 */
	it("refuses the sentence that shipped: Swirlseed does not roll over terrain", () => {
		const invented = claim({
			id: "lillia.e.invented",
			text: "It rolls over terrain, and grants vision of what it rolls past.",
			evidence: DDRAGON_E_DESCRIPTION
		})
		const reason = checkClaim(invented, SOURCES)
		ok(reason !== null)
		match(reason, /does not occur in its own evidence/)

		// And not through the wiki either, which is the other source the file cites.
		const viaWiki = claim({
			id: "lillia.e.invented-wiki",
			sourceId: "wiki",
			evidence: WIKI_E_TEMPLATE,
			derivation: { kind: "wikitext", field: "description" },
			text: "It rolls over terrain, and grants vision of what it rolls past."
		})
		ok(checkClaim(viaWiki, SOURCES) !== null)
	})

	/**
	 * The second false Lillia clause: "W deals bonus damage to monsters, which makes it the engine
	 * of the clear". No monster modifier exists in either tier-1 source on 16.18. A claim asserting
	 * one against the E evidence is refused for the same reason — but the point of this case is the
	 * FIELD: `ability.unit-modifier` exists, so a real modifier CAN ship, and the fence is about
	 * whether the bytes say it rather than about whether the subject is allowed.
	 */
	it("refuses a monster-damage modifier that its evidence does not contain", () => {
		const invented = claim({
			id: "lillia.w.monsters",
			group: "W",
			field: "ability.unit-modifier",
			text: "Deals bonus damage to monsters.",
			evidence: DDRAGON_E_DESCRIPTION
		})
		ok(checkClaim(invented, SOURCES) !== null)
	})

	it("refuses Riot's own tooltip while it still carries placeholders", () => {
		const raw = claim({
			id: "lillia.e.tooltip",
			text: DDRAGON_E_TOOLTIP,
			evidence: DDRAGON_E_TOOLTIP
		})
		const reason = checkClaim(raw, SOURCES)
		ok(reason !== null)
		match(reason, /unresolved markup/)
	})

	it("refuses a mechanic sourced to an aggregator and a win rate sourced to Riot", () => {
		const fromOpgg = claim({ id: "x.1", field: "ability.cooldown", sourceId: "opgg" })
		match(checkClaim(fromOpgg, SOURCES)!, /tier1-mechanics field and opgg is tier2-aggregate/)

		const fromRiot: ClaimRecord = {
			id: "x.2",
			subject: "lillia",
			group: "meta",
			field: "meta.winrate",
			text: "49.67% in jungle",
			sourceId: "ddragon",
			evidence: `{"win_rate":"49.67% in jungle"}`,
			derivation: { kind: "json", path: "win_rate" },
			sample: { games: 5186 }
		}
		ok(checkClaim(fromRiot, SOURCES) !== null)
	})

	it("refuses a tier-2 number with no sample size behind it", () => {
		const noSample: ClaimRecord = {
			id: "lillia.meta.winrate",
			subject: "lillia",
			group: "meta",
			field: "meta.winrate",
			text: "49.67",
			sourceId: "opgg",
			evidence: `{"summary":{"win_rate":49.67,"play":5186}}`,
			derivation: { kind: "json", path: "summary.win_rate" }
		}
		match(checkClaim(noSample, SOURCES)!, /may not ship without its sample size/)
		strictEqual(checkClaim({ ...noSample, sample: { games: 5186, bracket: "emerald+" } }, SOURCES), null)
	})

	/**
	 * The `fetch-items.ts` discipline, as it stands after 2026-09-19: a cross-checked field must SAY
	 * what happened with the second source, and silence is refused.
	 *
	 * What changed is the accepted answers, not the strictness. It used to be satisfiable only by
	 * `agreesWith`, and `claims-from-row.ts` satisfied it on 294 claims by inferring agreement from
	 * an empty conflict list — Data Dragon publishes no passive and only the first form of each
	 * slot, so on 245 of 937 abilities there was nothing to conflict with. `soleSource` is the
	 * second answer, from a closed set, and the reasoning for allowing it rather than dropping 245
	 * passive names out of the corpus is written at `crossChecked` in `provenance.ts`.
	 */
	it("refuses a cross-checked field that says nothing about the second source", () => {
		const alone: ClaimRecord = {
			id: "lillia.e.cooldown",
			subject: "lillia",
			group: "E",
			field: "ability.cooldown",
			text: "12",
			sourceId: "wiki",
			evidence: WIKI_E_TEMPLATE,
			derivation: { kind: "wikitext", field: "cooldown" }
		}
		match(checkClaim(alone, SOURCES)!, /must say what happened with the second tier-1 source/)
		strictEqual(checkClaim({ ...alone, agreesWith: ["ddragon"] }, SOURCES), null)
	})

	it("lets a cross-checked field ship on one source only when it names WHY there is no second", () => {
		const passive: ClaimRecord = {
			id: "lillia.e.cooldown",
			subject: "lillia",
			group: "E",
			field: "ability.cooldown",
			text: "12",
			sourceId: "wiki",
			evidence: WIKI_E_TEMPLATE,
			derivation: { kind: "wikitext", field: "cooldown" }
		}
		strictEqual(checkClaim({ ...passive, soleSource: "ddragon-publishes-no-passive" }, SOURCES), null)
		strictEqual(
			checkClaim({ ...passive, soleSource: "ddragon-publishes-one-form-per-slot" }, SOURCES),
			null
		)
		// The reason vocabulary is closed, so a new excuse is a reviewed code change and not a string.
		match(
			checkClaim({ ...passive, soleSource: "seemed-fine" as never }, SOURCES)!,
			/is not one of the 2 recorded reasons/
		)
		// A claim cannot both have been corroborated and have had nothing to corroborate it.
		match(
			checkClaim(
				{ ...passive, agreesWith: ["ddragon"], soleSource: "ddragon-publishes-no-passive" },
				SOURCES
			)!,
			/only one of those can be true/
		)
	})

	it("refuses a source that is not on the tier's host list, and one with no fetch time", () => {
		const elsewhere = new Map(SOURCES)
		elsewhere.set("blog", {
			id: "blog",
			tier: "tier1-mechanics",
			publisher: "someone's blog",
			url: "https://example.com/lillia",
			revision: "16.18",
			fetchedAt: "2026-09-18T00:00:00Z"
		})
		match(checkClaim(claim({ sourceId: "blog" }), elsewhere)!, /not a sanctioned host/)

		const undated = new Map(SOURCES)
		undated.set("ddragon", { ...DDRAGON, fetchedAt: "" })
		match(checkClaim(claim(), undated)!, /missing a url, a revision or a fetch time/)
	})

	it("re-derives a number out of JSON and an array of them out of CDragon", () => {
		const cooldowns: ClaimRecord = {
			id: "lillia.q.cooldown",
			subject: "lillia",
			group: "Q",
			field: "ability.cooldown",
			text: "6 / 5.5 / 5 / 4.5 / 4 / 4",
			sourceId: "cdragon",
			evidence: CDRAGON_Q_SPELL,
			derivation: { kind: "json-join", path: "cooldownCoefficients", sep: " / " },
			agreesWith: ["ddragon"]
		}
		strictEqual(checkClaim(cooldowns, SOURCES), null)
		// One digit wrong is the entire failure mode, and it is caught by arithmetic, not by taste.
		match(checkClaim({ ...cooldowns, text: "6 / 5.5 / 5 / 4.5 / 4 / 3" }, SOURCES)!, /joins to/)

		const name: ClaimRecord = {
			id: "lillia.q.name",
			subject: "lillia",
			group: "Q",
			field: "ability.name",
			text: "Blooming Blows",
			sourceId: "cdragon",
			evidence: CDRAGON_Q_SPELL,
			derivation: { kind: "json", path: "name" },
			agreesWith: ["ddragon", "wiki"]
		}
		strictEqual(checkClaim(name, SOURCES), null)
	})

	it("refuses a field that does not exist, which is how prose would have to arrive", () => {
		match(
			checkClaim(claim({ field: "ability.how-to-path" as never }), SOURCES)!,
			/unknown field/
		)
	})
})

/* -------------------------------------------------------------------- rendering and the audit */

describe("rendering", () => {
	it("puts the citation in the line, with the sample when there is one", () => {
		const line = renderClaimLine(claim(), SOURCES)
		ok(isSourcedLine(line))
		strictEqual(
			line.text,
			"- what it does: If it doesn't hit anything, it will continue rolling until it hits a wall or target. [ddragon 16.18.1, fetched 2026-09-18]"
		)

		const meta = renderClaimLine(
			{
				id: "lillia.meta.summoners",
				subject: "lillia",
				group: "meta",
				field: "meta.summoners",
				text: "Flash + Smite",
				sourceId: "opgg",
				evidence: `{"summoner_spells":[{"label":"Flash + Smite","play":5029}]}`,
				derivation: { kind: "json", path: "summoner_spells.0.label" },
				sample: { games: 5029, wins: 2500, bracket: "emerald+" }
			},
			SOURCES
		)
		strictEqual(
			meta.text,
			"- summoner spells: Flash + Smite (n=5,029 games, 2,500 wins, emerald+) [opgg 16.18, fetched 2026-09-19]"
		)
	})

	it("throws rather than rendering an unchecked claim", () => {
		throws(
			() => renderClaimLine(claim({ text: "She wants blue buff more than most junglers." }), SOURCES),
			ProvenanceError
		)
	})

	it("refuses to assemble a line nobody minted", () => {
		const good = renderClaimLine(claim(), SOURCES)
		throws(
			() => assemble([good, "Swirlseed rolls over terrain." as never], [claim()], [DDRAGON]),
			ProvenanceError
		)
	})

	/**
	 * The structural text is pinned as literals because it is the only prose in the pipeline that a
	 * source did not produce. Pinning it means a reviewer sees any change to it as a diff in a test,
	 * which is the difference between scaffolding and a sentence about League that arrived quietly.
	 */
	it("pins the structural templates, which are the only unsourced words in the section", () => {
		strictEqual(
			STRUCTURE_TEMPLATES["section.heading"]({ champion: "Lillia" }),
			"## LILLIA — FETCHED FACTS (copied from the sources named on each line)"
		)
		strictEqual(
			STRUCTURE_TEMPLATES["section.preamble"](),
			"Every line below was copied from the source in brackets at the end of it, on the date shown. Nothing here was written from memory. If something you want to say is not on a line here, no source published it — say less rather than filling the gap."
		)
		strictEqual(
			STRUCTURE_TEMPLATES["owner.warning"](),
			"The lines under this heading have no source. They are the owner's own judgment, written by him on the date shown. Treat them as opinion you may act on, never as a fact you may assert."
		)
		strictEqual(
			STRUCTURE_TEMPLATES["role.none"]({ role: "support" }),
			"Nothing here. No source this app fetches publishes anything about the support role, and nothing was written to stand in for one. If the coach wants to say something about this role, it is saying it out of its own head and should say less instead."
		)
		strictEqual(
			STRUCTURE_TEMPLATES["general.patch"]({
				patch: "16.18.1",
				champions: 173,
				claims: 9,
				withheld: 1,
				broken: 2,
				tableCells: 6026,
				soleSourced: 294
			}),
			"Patch 16.18.1. 173 champions, 9 checked lines, 1 ability slot withheld because two sources disagreed about the name, the cooldown or the cost, 2 fields withheld because the wiki's own expansion of it came back broken, and 6026 cells of tables inside the wiki's notes withheld because the rows and columns did not survive being flattened to text — a header and its value arrived as two separate lines and neither says anything on its own. 294 of the checked lines rest on ONE tier-1 source rather than two, because Data Dragon files a passive outside its spell list and publishes only the first form of each slot; each of those lines names the single wiki revision it was copied from."
		)
		/*
		 * The two WITHHELD notices are pinned like the rest. They are the only lines in a champion
		 * file that carry no citation, and they may carry none because they assert nothing about
		 * League — they say a value the sources hold did not reach the page, and which one.
		 */
		strictEqual(
			STRUCTURE_TEMPLATES["group.withheld.disagreed"]({ fields: "name, cooldown, cost" }),
			"- WITHHELD (name, cooldown, cost): Data Dragon and the wiki disagree about it on this patch, so no value is shown. This app does not know what it is — say nothing about it."
		)
		/*
		 * REWORDED 2026-09-19 and the old words are here so the change is visible in the diff rather
		 * than only in the corpus: it used to read "the wiki's own expansion of the field came back
		 * broken", which was true of the two `Expression error` cases it then covered and false of
		 * the flattened-table drop it now also covers, where the wiki's expansion succeeded and the
		 * HTML-to-text flattening downstream of it lost the table's rows and columns.
		 */
		strictEqual(
			STRUCTURE_TEMPLATES["group.withheld.render"]({ fields: "notes" }),
			"- WITHHELD (notes): the source publishes it and it did not survive being rendered into plain text, so no value is shown. This app does not know what it is — say nothing about it."
		)
		strictEqual(
			STRUCTURE_TEMPLATES["group.withheld.render"]({ fields: "38 cells of a table in the wiki's notes" }),
			"- WITHHELD (38 cells of a table in the wiki's notes): the source publishes it and it did not survive being rendered into plain text, so no value is shown. This app does not know what it is — say nothing about it."
		)
		deepStrictEqual(Object.keys(STRUCTURE_TEMPLATES).sort(), [
			"blank",
			"general.heading",
			"general.patch",
			"general.silent",
			"group.heading",
			"group.withheld.disagreed",
			"group.withheld.render",
			"owner.heading",
			"owner.warning",
			"role.none",
			"section.heading",
			"section.preamble",
			"sources.heading",
			"sources.line"
		])
	})
})

describe("auditAssembled", () => {
	const build = () => {
		const c = claim()
		const lines = [
			structureLine("section.heading", { champion: "Lillia" }),
			structureLine("group.heading", { title: "E" }),
			renderClaimLine(c, SOURCES)
		]
		return assemble(lines, [c], [DDRAGON])
	}

	it("traces every line of a section it built", () => {
		const a = build()
		const report = auditAssembled(a.text, a)
		ok(report.ok)
		strictEqual(report.claimLines, 1)
		strictEqual(report.structureLines, 2)
		deepStrictEqual(report.usage.map(u => [u.source.id, u.claims]), [["ddragon", 1]])
		strictEqual(report.oldestFetchedAt, "2026-09-18T18:15:00Z")
		deepStrictEqual(report.revisions, ["ddragon 16.18.1"])
	})

	/**
	 * The failure this is really for: a sentence appended to the block after it was built — from a
	 * markdown file, a template, a well-meant "just add this one line". The audit does not care how
	 * it arrived.
	 */
	it("names a sentence no source produced", () => {
		const a = build()
		const tampered = `${a.text}\nSwirlseed rolls over terrain and grants vision along its path.`
		const report = auditAssembled(tampered, a)
		strictEqual(report.ok, false)
		deepStrictEqual(report.untraced, [
			"Swirlseed rolls over terrain and grants vision along its path."
		])
	})

	it("notices a line that was dropped after assembly", () => {
		const a = build()
		const report = auditAssembled(a.text.split("\n").slice(0, 2).join("\n"), a)
		strictEqual(report.ok, false)
		strictEqual(report.missing.length, 1)
	})

	it("traces a phrase back to the URL, the revision and the day it was fetched", () => {
		const a = build()
		const hits = tracePhrase(a, "continue rolling")
		strictEqual(hits.length, 1)
		strictEqual(hits[0]!.claim.id, "lillia.e.effect")
		strictEqual(hits[0]!.source!.url, DDRAGON.url)
		strictEqual(hits[0]!.source!.revision, "16.18.1")
		// And the phrase from the false clause is in nothing, which is the point.
		strictEqual(tracePhrase(a, "over terrain").length, 0)
	})
})

/* ------------------------------------------------------ what happens to the prose that exists */

describe("the hand-written knowledge as it stands today", () => {
	/**
	 * Not a failure to fix — a measurement to keep. `knowledge/champions/*.md` carries ONE header
	 * for a whole file, so no sentence in it can be traced to anything. This test states that in a
	 * number, and it is the number that should change when the fetched table lands.
	 */
	it("traces none of lillia.md, because a file-level header is not per-claim provenance", () => {
		let prose: string
		try {
			prose = readFileSync(resolve(HERE, "../../knowledge/champions/lillia.md"), "utf8")
		} catch {
			// Deleted and regenerated: then there is no unprovenanced prose left and this is moot.
			return
		}
		const report = traceProse(prose, null)
		ok(report.sentences > 50, `expected a substantial file, got ${report.sentences} sentences`)
		strictEqual(report.traced, 0)
		strictEqual(report.untraced.length, report.sentences)
	})

	/** Its own header cites a source that does not exist. A per-claim fence cannot express this. */
	it("shows the file-level citation cannot be checked, and one of them is fabricated", () => {
		let head: string
		try {
			head = readFileSync(resolve(HERE, "../../knowledge/champions/lillia.md"), "utf8").slice(0, 400)
		} catch {
			return
		}
		// op.gg has no jungle-path endpoint: three shapes probed 2026-09-18, two 404, one ignored the
		// parameter, and no key in the 17KB payload matches path/route/camp.
		match(head, /op\.gg jungle-paths/)
	})

	it("counts what a per-claim fence would have to replace", () => {
		let files: string[]
		try {
			files = readdirSync(resolve(HERE, "../../knowledge/champions")).filter(f => f.endsWith(".md"))
		} catch {
			return
		}
		let sentences = 0
		for (const f of files)
			sentences += traceProse(
				readFileSync(resolve(HERE, "../../knowledge/champions", f), "utf8"),
				null
			).sentences
		ok(sentences > 0)
		// Every one of them is unsourced at the sentence level. That is the state this fence ends.
		strictEqual(
			traceProse(
				files
					.map(f => readFileSync(resolve(HERE, "../../knowledge/champions", f), "utf8"))
					.join("\n"),
				null
			).traced,
			0
		)
	})
})

describe("the field vocabulary", () => {
	/*
	 * The unsourceable list, encoded: there is no field for a route, a gank condition, a clear
	 * tempo, a spike, or what an item purchase implies. A fetcher that wanted to ship one would have
	 * to add a field here, in a reviewed diff, which is exactly the visibility the owner asked for.
	 */
	it("has no field that could hold a route, a gank condition or a power spike", () => {
		const fields = Object.keys(CLAIM_FIELDS)
		for (const banned of ["route", "path", "clear", "gank", "spike", "tempo", "intent"])
			ok(
				!fields.some(f => f.includes(banned)),
				`${banned} has a field, and no source publishes it per champion`
			)
	})

	it("binds every field to exactly one tier, so a source cannot speak out of turn", () => {
		for (const [name, spec] of Object.entries(CLAIM_FIELDS)) {
			ok(spec.label.length > 0, `${name} has no label`)
			ok(["tier1-mechanics", "tier2-aggregate", "owner-authored"].includes(spec.tier))
			if (spec.tier === "tier2-aggregate")
				ok(spec.requiresSample === true, `${name} is tier 2 and must carry its sample size`)
		}
	})
})
