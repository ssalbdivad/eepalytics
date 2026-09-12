/**
 * ADJUDICATE the build claims in the graded live corpus, against the recipes, with no model in it.
 *
 * ## Why
 *
 * Build claims were named as the largest cluster of FALSE live lines: "hit recall to finish your
 * Liandry's Torment" said to a man holding Fated Ashes and Haunting Guise, "farm toward your
 * second item" said to a man holding five items. Both readings came from a judge that was handed
 * the same payload the coach was handed — item NAMES and a `price` that is the item's own cost
 * line — so neither of them could tell a finished item from a component, work out what a set of
 * parts builds into, or say what the rest of it costs.
 *
 * `shared/items.ts` can now answer all three, exactly, from Riot's static data. So the verdicts
 * can be re-derived rather than re-asked. Nothing here calls a model and nothing here is an
 * opinion: an ordinal claim is checked against the count of FINISHED items, and an affordability
 * claim is checked against the recipe total minus what he already holds.
 *
 * ## What it does not do
 *
 * It does not overwrite a stored verdict. It writes its own file beside them and reports the
 * disagreement, which is the measurement.
 *
 * Read-only on the database; never touches the LCU. Run:
 *
 *   node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/audit-build-claims.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildTargets, inventoryOf, itemOf } from "../src/shared/items.ts"

const EVAL = "data/eval"
const SAMPLES = "data/live-samples"
const USER_CHAMPION = "Lillia"

interface JudgedLine {
	id?: string
	arm?: string
	windowId?: string
	clock?: string
	text?: string
	verdict?: string
	why?: string
}

/** The ordinals a coach uses about a build, and which finished-item number each one means. */
const ORDINALS: Record<string, number> = {
	first: 1,
	second: 2,
	third: 3,
	fourth: 4,
	fifth: 5,
	sixth: 6
}

const clockSec = (clock: string): number | null => {
	const m = /^(\d+):(\d{2})$/.exec(clock.trim())
	return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/* ----------------------------------------------------------------- the stored payloads */

interface Sample {
	tSec: number
	itemIds: number[]
	gold: number
}

const samplesByWindow = new Map<string, Sample[]>()
for (const f of readdirSync(SAMPLES)) {
	if (!f.endsWith(".ndjson")) continue
	const rows: Sample[] = []
	for (const line of readFileSync(join(SAMPLES, f), "utf8").split("\n")) {
		if (line.trim() === "") continue
		let o: {
			gameTime?: number
			data?: {
				activePlayer?: { currentGold?: number }
				allPlayers?: { championName?: string; items?: { itemID?: number }[] }[]
			}
		}
		try {
			o = JSON.parse(line)
		} catch {
			continue
		}
		const me = o.data?.allPlayers?.find(p => p.championName === USER_CHAMPION)
		if (!me) continue
		rows.push({
			tSec: o.gameTime ?? 0,
			itemIds: (me.items ?? []).map(i => i.itemID).filter((n): n is number => n !== undefined),
			gold: Math.round(o.data?.activePlayer?.currentGold ?? 0)
		})
	}
	if (rows.length > 0) samplesByWindow.set(f.replace(".ndjson", ""), rows)
}

const sampleAt = (windowId: string, atSec: number): Sample | null => {
	const rows = samplesByWindow.get(windowId)
	if (!rows) return null
	let best: Sample | null = null
	for (const r of rows) if (!best || Math.abs(r.tSec - atSec) < Math.abs(best.tSec - atSec)) best = r
	// Ten seconds is under two of the supervisor's polls; further away is a different moment.
	return best && Math.abs(best.tSec - atSec) <= 10 ? best : null
}

/* ------------------------------------------------------------------- the two checkable claims */

type Ruling = { verdict: "TRUE" | "FALSE"; because: string } | null

/** "your second item", "your third item" — an ordinal over FINISHED items. */
const ruleOrdinal = (text: string, s: Sample): Ruling => {
	const m = /\b(first|second|third|fourth|fifth|sixth)\s+item\b/i.exec(text)
	if (!m) return null
	const claimed = ORDINALS[m[1]!.toLowerCase()]!
	const done = inventoryOf(s.itemIds).completed.length
	/*
	 * The item he is working toward is the NEXT one, so a claim of N is right when he has N-1
	 * finished. Boots are not counted: a player says "two items and boots" and never "three".
	 */
	return claimed === done + 1 ?
			{ verdict: "TRUE", because: `${done} finished item(s) held, so the next one is the ${m[1]}` }
		:	{
				verdict: "FALSE",
				because: `${done} finished item(s) held, so the next one is number ${done + 1}, not the ${m[1]}`
			}
}

/**
 * "finish your Liandry's", "complete your X" — an affordability claim about a named item.
 *
 * The matcher is deliberately narrow, and the first draft of it was not, which is worth recording
 * because it is the same mistake the coach makes. It fired on *"With Zhonya's complete, clear the
 * supers out of base"* — a sentence that OBSERVES he has the item — and ruled it false on the
 * grounds that there was nothing left to finish. A verb near a noun is not a claim about it. The
 * verb has to come BEFORE the item and the phrase must not be a `with ...` aside.
 */
const ruleAffordable = (text: string, s: Sample): Ruling => {
	const targets = buildTargets(s.itemIds)
	const owned = new Set(s.itemIds)
	// Match on the item name the sentence actually used, longest first so "Liandry's Torment"
	// wins over a bare "Liandry's".
	const named = [...targets]
		.map(t => t.name)
		.concat([...owned].map(id => itemOf(id)?.name ?? ""))
		.filter(n => n !== "")
		.sort((a, b) => b.length - a.length)
	const lower = text.toLowerCase()
	let hit: string | undefined
	for (const n of named) {
		const stem = n
			.replace(/'s\b.*$/, "'s")
			.replace(/[^A-Za-z' ]/g, "")
			.toLowerCase()
		const at = lower.indexOf(stem)
		if (at === -1) continue
		const before = lower.slice(Math.max(0, at - 40), at)
		// The verb has to be aimed AT the item, and `with <item> complete` aims the other way.
		if (!/\b(finish|finishing|complete|completed|buy|buying)\b/.test(before)) continue
		if (/\bwith\b[^.]{0,20}$/.test(before)) continue
		// `you've got your completed X`, `you have your complete X` — an observation with an
		// adjective in it, not an instruction to go and buy the thing.
		if (/\b(got|have|has|holding|sitting on)\b[^.]{0,25}$/.test(before)) continue
		hit = n
		break
	}
	if (!hit) return null
	const t = targets.find(x => x.name === hit)
	if (!t)
		return {
			verdict: "FALSE",
			because: `he already owns ${hit}, so there is nothing of it left to finish`
		}
	if (t.missing.length > 0)
		return {
			verdict: "FALSE",
			because: `${hit} still needs ${t.missing.join(" + ")} bought in pieces, so a back does not finish it`
		}
	return s.gold >= t.remaining ?
			{ verdict: "TRUE", because: `${hit} is ${t.remaining}g away and he holds ${s.gold}g` }
		:	{
				verdict: "FALSE",
				because: `${hit} is ${t.remaining}g away and he holds only ${s.gold}g`
			}
}

/* ------------------------------------------------------------------------------- the run */

interface Row {
	file: string
	id: string
	windowId: string
	clock: string
	text: string
	stored: string
	/** The judge's own stated reason, verbatim — the field that decides whether a flip counts. */
	why: string
	/** Does that reason turn on the build at all? See `WHY_IS_BUILD`. */
	whyIsBuild: boolean
	ruled: "TRUE" | "FALSE"
	because: string
	rule: "ordinal" | "affordable"
}

/**
 * Does the judge's stated reason turn on the BUILD?
 *
 * This is the honest part of the count. A line can carry a build clause and be marked false for
 * something else entirely — "Baron spawns in 13s per payload, not ten seconds" — and settling its
 * build clause does not settle the verdict. Only a false whose REASON was the build can be flipped
 * by a recipe, so the headline is the subset where it was, and the rest is reported separately
 * rather than folded in.
 */
const WHY_IS_BUILD =
	/\bitem\b|\bitems\b|\bbuild\b|component|recipe|\bgold\b|finish|complete|Liandry|Riftmaker|Hubris|price|afford/i

const rows: Row[] = []
let claimsSeen = 0
let unresolved = 0
for (const f of readdirSync(EVAL)) {
	if (!f.endsWith("-judged.json")) continue
	let j: { lines?: JudgedLine[] }
	try {
		j = JSON.parse(readFileSync(join(EVAL, f), "utf8"))
	} catch {
		continue
	}
	for (const l of j.lines ?? []) {
		const text = l.text ?? ""
		if (!/\bitem\b|finish|complete/i.test(text)) continue
		claimsSeen += 1
		const at = clockSec(l.clock ?? "")
		const s = at === null || !l.windowId ? null : sampleAt(l.windowId, at)
		if (!s) {
			unresolved += 1
			continue
		}
		const ord = ruleOrdinal(text, s)
		const aff = ord ? null : ruleAffordable(text, s)
		const ruling = ord ?? aff
		if (!ruling) {
			unresolved += 1
			continue
		}
		rows.push({
			file: f,
			id: l.id ?? "",
			windowId: l.windowId!,
			clock: l.clock ?? "",
			text,
			stored: l.verdict ?? "",
			why: l.why ?? "",
			whyIsBuild: WHY_IS_BUILD.test(l.why ?? ""),
			ruled: ruling.verdict,
			because: ruling.because,
			rule: ord ? "ordinal" : "affordable"
		})
	}
}

const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length))

/**
 * Wilson score interval, 95%.
 *
 * A bare proportion over 129 lines reads as stronger than it is, and the owner's standing rule is
 * that an effect size arrives with its interval or it does not arrive.
 */
const wilson = (k: number, n: number): string => {
	if (n === 0) return "n/a"
	const z = 1.96
	const p = k / n
	const d = 1 + (z * z) / n
	const centre = (p + (z * z) / (2 * n)) / d
	const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
	return `${(100 * p).toFixed(1)}% [${(100 * (centre - half)).toFixed(0)}, ${(100 * (centre + half)).toFixed(0)}]`
}

console.log(`BUILD CLAIMS, re-derived from the recipes — no model in the loop`)
console.log(
	`  ${claimsSeen} lines in the judged corpora mention an item; ${rows.length} carry a claim this can settle mechanically, ${unresolved} do not`
)
console.log()

const storedFalse = rows.filter(r => r.stored === "false")
/*
 * A flip only counts when the judge's own reason was the build. Otherwise the line is false for
 * something this script cannot see and the recipe settles a clause rather than a verdict.
 */
const onBuild = storedFalse.filter(r => r.whyIsBuild)
const flipped = onBuild.filter(r => r.ruled === "TRUE")
const upheld = onBuild.filter(r => r.ruled === "FALSE")
const elsewhere = storedFalse.filter(r => !r.whyIsBuild && r.ruled === "TRUE")
const storedUseful = rows.filter(r => r.stored === "useful")
const missedFalse = storedUseful.filter(r => r.ruled === "FALSE")

console.log(`  stored FALSE, settled here:              ${storedFalse.length}`)
console.log(`    of those, false FOR A BUILD REASON:    ${onBuild.length}`)
console.log(
	`      recipes say the build claim was TRUE: ${flipped.length}  (${wilson(flipped.length, onBuild.length)})`
)
console.log(`      upheld:                               ${upheld.length}`)
console.log(
	`    false for some other reason, build clause true: ${elsewhere.length} (the verdict stands; only the clause is settled)`
)
console.log(`  stored USEFUL, settled here:             ${storedUseful.length}`)
console.log(
	`    recipes refuse the build claim:        ${missedFalse.length}  (${wilson(missedFalse.length, storedUseful.length)})`
)
console.log()

/*
 * SENSITIVITY — does the answer depend on whether boots count as an item?
 *
 * The ordinal rule counts FINISHED items and leaves boots out, because a player says "two items
 * and boots" and never "three". That is a reading of English rather than a fact about the game, so
 * it is the one judgement in this script and it gets re-run the other way rather than asserted.
 */
const ordinals = rows.filter(r => r.rule === "ordinal")
let wouldFlip = 0
for (const r of ordinals) {
	const at = clockSec(r.clock)
	const sample = at === null ? null : sampleAt(r.windowId, at)
	if (!sample) continue
	const inv = inventoryOf(sample.itemIds)
	const m = /\b(first|second|third|fourth|fifth|sixth)\s+item\b/i.exec(r.text)!
	const claimed = ORDINALS[m[1]!.toLowerCase()]!
	const withBoots = inv.completed.length + (inv.boots ? 1 : 0)
	const other: "TRUE" | "FALSE" = claimed === withBoots + 1 ? "TRUE" : "FALSE"
	if (other !== r.ruled) wouldFlip += 1
}
console.log(
	`  sensitivity: ${ordinals.length} ordinal claims; counting boots as an item would change ${wouldFlip} of them`
)
console.log(
	`  => the ORDINAL result is not robust and is reported apart from the affordability one, which is arithmetic and has no reading of English in it.`
)
console.log()

const byRule = (rule: "ordinal" | "affordable"): void => {
	const on = onBuild.filter(r => r.rule === rule)
	const t = on.filter(r => r.ruled === "TRUE")
	const useful = storedUseful.filter(r => r.rule === rule)
	const missed = useful.filter(r => r.ruled === "FALSE")
	console.log(
		`  ${pad(rule, 11)} stored-false-on-build ${pad(String(on.length), 4)} -> true ${pad(String(t.length), 4)} (${wilson(t.length, on.length)}) | stored-useful ${pad(String(useful.length), 4)} -> false ${pad(String(missed.length), 4)} (${wilson(missed.length, useful.length)})`
	)
}
console.log("BY RULE")
byRule("affordable")
byRule("ordinal")
console.log()
for (const group of [
	["FLIPPED — the judge called these false and the recipes say they were true", flipped],
	["UPHELD — false, and now sayable as to why", upheld],
	["MISSED — the judge let these through and the recipes refuse them", missedFalse]
] as [string, Row[]][]) {
	if (group[1].length === 0) continue
	console.log(group[0])
	for (const r of group[1])
		console.log(
			`  ${pad(r.windowId, 28)} ${pad(r.clock, 6)} ${pad(r.rule, 10)} ${r.text.slice(0, 96)}\n      => ${r.because}`
		)
	console.log()
}

const out = join(EVAL, `build-claims-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.json`)
writeFileSync(
	out,
	JSON.stringify(
		{
			ranAt: new Date().toISOString(),
			note: "Build claims from the judged live corpora, re-derived from Data Dragon recipes via src/shared/items.ts. No model in the loop. Stored verdicts are NOT modified.",
			claimsSeen,
			settled: rows.length,
			unresolved,
			storedFalseOnBuildReason: onBuild.length,
			flipped: flipped.length,
			upheld: upheld.length,
			falseElsewhereButBuildClauseTrue: elsewhere.length,
			missedFalse: missedFalse.length,
			rows
		},
		null,
		"\t"
	)
)
console.log(`wrote ${out}`)
