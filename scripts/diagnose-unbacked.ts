/**
 * diagnose-unbacked — classify every figure the live coach SPOKE against the payload it held.
 *
 * ## Why this exists
 *
 * The 17-game corpus (`data/eval/integrate-corpus-20260911.json`, 529 turns, the shipped trusted
 * prompt) came back with **35% of lines carrying a figure the block does not back**. That number
 * has no model opinion in it — `scoreLine` produced it mechanically — so it was the largest
 * measured defect in the coach and the one least able to hide behind the judge dispute.
 *
 * It was also, mostly, wrong. This script is the instrument that established that, and it stays so
 * the claim can be re-derived rather than believed: it re-scores the stored corpus, puts every
 * charged figure into ONE class, and names the block figure it thinks the coach was actually
 * saying. Nothing here calls a model.
 *
 * ## The classes, and what each one means for where a fix belongs
 *
 * - `rounded`      a faithful rounding of a payload figure of the SAME unit — "twelve hundred gold"
 *                  off `1195g in hand`, "fifty seconds" off `back in 49s`. **A scorer bug.** A
 *                  coach who speaks rounds, and charging him with fabrication for it measures
 *                  diction. Fixed in `coach-score.ts` by `roundsTo`.
 * - `map-timer`    a respawn or spawn clock the old attribution rule hung on a PERSON, because the
 *                  clause naming it named nobody and rule 5 carried the sentence subject over.
 *                  **A scorer bug**, fixed by `mapTimer`.
 * - `misowned`     the figure is in the payload verbatim and the sentence really does hang it on
 *                  somebody who does not have it. **A real fault**, and the one the misattribution
 *                  rule was written for.
 * - `level-goal`   "full clear to level four" — a plan, not a reading. **A scorer bug**, fixed by
 *                  `LEVEL_GOAL`.
 * - `derived`      the figure is arithmetic ON payload figures: a sum, a difference, a minutes/
 *                  seconds conversion. **A data-layer defect** — the model should be handed the
 *                  answer rather than asked to compute it, because a model that computes will
 *                  sometimes compute wrong and nothing downstream can tell the two apart.
 * - `invented`     nothing in the payload explains it. **The dangerous class**, and the only one
 *                  where the prompt or the model is the right thing to change.
 *
 * Usage:
 *   node --experimental-strip-types scripts/diagnose-unbacked.ts [corpus.json] [--dump <class>]
 *
 * NODE ONLY (reads a run off disk). Read-only: it writes nothing and touches no database.
 */

import { readFileSync } from "node:fs"
import {
	FABRICATION_FAULTS,
	normalizeNumbers,
	blockFigures,
	mapTimer,
	roundsTo,
	scoreLine,
	unitAt,
	unitsAgree,
	wilson
} from "../src/analysis/coach-score.ts"
import type { Figure, FigureUnit, Interval } from "../src/analysis/coach-score.ts"

/* ============================================================== the classifier */

export type FigureClass = "rounded" | "map-timer" | "misowned" | "level-goal" | "derived" | "invented"

export interface ClassifiedFigure {
	value: number
	unit: FigureUnit
	klass: FigureClass
	/** The payload figure this one is read as standing for, when there is one. */
	source: number | null
	/** How `source` becomes `value`, in words, for a human checking the call by eye. */
	via: string
	/**
	 * Is `source` the figure the sentence is plainly ABOUT — his gold in hand, or a respawn clock?
	 *
	 * The rounding rule's one real risk is that a ten-thousand-character brief holds enough
	 * integers for something to land within the tolerance by accident, so that the instrument stops
	 * charging a fabrication for the wrong reason. This is the check on that, and it is printed
	 * next to every call: a `rounded` verdict whose source is NOT the payload's own `1195g in hand`
	 * or `back in 49s` is one to go and look at.
	 */
	anchored: boolean
}

/**
 * The figures the payload PRESENTS as the answer to the coach's question, rather than mentions.
 *
 * A brief holds his gold in hand, and it also holds every item price, every enemy's CS and a
 * hundred other integers. "Nine hundred gold" is a faithful rounding of the 953 the payload calls
 * `953g in hand`; it is also, arithmetically, a faithful rounding of an 880-gold item price four
 * lines down. Only the first is what the sentence means, and a report that cannot tell them apart
 * cannot be used to check the rounding rule at all.
 *
 * So the anchors are pulled out by NAME — `953g in hand`, `back in 49s`, `respawns in 49s`,
 * `in 42s` — and a rounding is reported as anchored only when one of them explains it. Fifteen of
 * the corpus's 154 roundings came back unanchored before this existed and every one of them turned
 * out, by hand, to be the gold in hand or a respawn clock that a nearer unrelated figure had
 * shadowed.
 */
const anchorFigures = (block: string): Figure[] => [
	...[...block.matchAll(/(\d+)g in hand/g)].map(m => ({ value: Number(m[1]), unit: "gold" as FigureUnit })),
	...[...block.matchAll(/(?:back in|respawns in|spawns in|up in|, in) (\d+)s/g)].map(m => ({
		value: Number(m[1]),
		unit: "seconds" as FigureUnit
	}))
]

/**
 * The NEAREST payload figure `value` could be a rounding of, not the first one in reading order.
 *
 * `scoreLine` only asks whether such a figure exists, and for a verdict that is enough. For a
 * REPORT it is not: a brief carries the same clock twice — the opening snapshot and this turn's
 * delta — so the first hit for "forty seconds" was a stale 38 while the live row said 42, and the
 * dump then invited a reader to go and check a call that was never in doubt.
 */
const nearestRounding = (value: number, unit: FigureUnit, figures: readonly Figure[]): Figure | null => {
	let best: Figure | null = null
	for (const f of figures)
		if (unitsAgree(unit, f.unit) && roundsTo(value, f.value))
			if (best === null || Math.abs(f.value - value) < Math.abs(best.value - value)) best = f
	return best
}

/**
 * Arithmetic the coach performed on two payload figures, which is the class that is NOT a scorer
 * bug.
 *
 * Kept deliberately short. Every extra operation makes it likelier that some pair of the ~300
 * integers in a brief hits the answer by accident, and a class that absorbs everything tells you
 * nothing about where to fix it. Sum, difference and the two minute/second conversions are the
 * ones the payload actually invites: it prints `in 2m19s`, and it prints his gold and an item
 * price on separate lines.
 */
const derivedFrom = (
	value: number,
	figures: readonly Figure[]
): { source: number; via: string } | null => {
	for (const f of figures) {
		if (f.unit === "minutes" && f.value * 60 === value) return { source: f.value, via: `${f.value}m as seconds` }
		if (f.unit === "seconds" && value * 60 === f.value) return { source: f.value, via: `${f.value}s as minutes` }
	}
	const big = figures.filter(f => f.value >= 10)
	for (let i = 0; i < big.length; i++)
		for (let j = i + 1; j < big.length; j++) {
			const a = big[i]!
			const b = big[j]!
			if (a.unit !== b.unit) continue
			if (a.value + b.value === value) return { source: a.value, via: `${a.value} + ${b.value}` }
			if (Math.abs(a.value - b.value) === value) return { source: a.value, via: `${a.value} - ${b.value}` }
		}
	return null
}

/**
 * Is this level a READING of somebody's level, or the level he is being told to go and get?
 *
 * The same question `LEVEL_GOAL` answers inside the scorer, asked here because a goal level often
 * happens to be a number that IS in the payload — half the roster is level four at some point —
 * and it would otherwise be filed as a misattribution rather than as the plan it is.
 */
const exactLevel = (line: string, at: number): boolean =>
	!/\b(?:to|for|want|until|before|by)\b[^.;:!?]{0,26}$/i.test(line.slice(Math.max(0, at - 40), at))

/**
 * Classify every SIGNIFICANT figure in one spoken line.
 *
 * Significance is delegated to `scoreLine` rather than re-implemented: a figure it does not charge
 * is a figure this script has no opinion about, and two thresholds that drift apart would make the
 * before/after meaningless.
 */
export const classifyLine = (
	line: string,
	block: string,
	roster: readonly string[]
): ClassifiedFigure[] => {
	const literal = scoreLine({ line, block, roster, champions: roster }, { literal: true })
	if (literal.silent) return []
	const norm = literal.normalized
	const figures = blockFigures(block)
	const anchors = anchorFigures(block)
	const exact = new Set(figures.map(f => f.value))
	const charged = new Map<number, "unbacked" | "misattributed">()
	for (const v of literal.unbackedNumbers) charged.set(v, "unbacked")
	for (const m of literal.misattributed) if (!charged.has(m.value)) charged.set(m.value, "misattributed")
	const out: ClassifiedFigure[] = []
	const seen = new Set<number>()
	for (const m of norm.matchAll(/\d+/g)) {
		if (m.index === undefined) continue
		const value = Number(m[0])
		const how = charged.get(value)
		if (how === undefined || seen.has(value)) continue
		seen.add(value)
		const unit = unitAt(norm, m.index, m[0])
		/*
		 * Order matters and it is the argument of this script. A figure that is in the payload
		 * verbatim was never invented, whatever the attribution rule said about it, so the
		 * misattribution classes are tried first and the invention classes only afterwards.
		 */
		if (how === "misattributed" && mapTimer(norm, m.index, unit)) {
			out.push({ value, unit, klass: "map-timer", source: value, via: "a clock the map owns", anchored: true })
			continue
		}
		if (unit === "level" && !exactLevel(norm, m.index)) {
			out.push({ value, unit, klass: "level-goal", source: null, via: "a level he is told to reach", anchored: true })
			continue
		}
		if (how === "misattributed" && exact.has(value)) {
			const round = nearestRounding(value, unit, anchors.filter(f => f.value !== value))
			out.push(
				round ?
					{
						value,
						unit,
						klass: "rounded",
						source: round.value,
						via: `${round.value} ${round.unit}, said round`,
						anchored: true
					}
				:	{ value, unit, klass: "misowned", source: value, via: "in the payload, on somebody else's row", anchored: true }
			)
			continue
		}
		const anchored = nearestRounding(value, unit, anchors)
		const round = anchored ?? nearestRounding(value, unit, figures)
		if (round) {
			out.push({
				value,
				unit,
				klass: "rounded",
				source: round.value,
				via: `${round.value} ${round.unit}, said round`,
				anchored: anchored !== null
			})
			continue
		}
		const derived = derivedFrom(value, figures)
		if (derived) {
			out.push({ value, unit, klass: "derived", source: derived.source, via: derived.via, anchored: false })
			continue
		}
		out.push({ value, unit, klass: "invented", source: null, via: "nothing in the payload", anchored: false })
	}
	return out
}

/**
 * The check that does not go through the scorer at all: how far each figure the coach SPOKE is
 * from the payload's own answer.
 *
 * `scoreLine` asks "is this number somewhere in ten thousand characters", which is a weak question
 * — a brief holds three hundred integers and something is nearly always close. This asks the
 * strong one. His gold is `953g in hand` and nothing else; a respawn is `back in 49s`. If the
 * coach's money is right to within a rounding, no amount of argument about the scorer changes it,
 * and if it is not, no amount of scorer fixing helps.
 */
const spokenErrors = (line: string, block: string): { unit: FigureUnit; error: number }[] => {
	const anchors = anchorFigures(block)
	const norm = normalizeNumbers(line)
	const out: { unit: FigureUnit; error: number }[] = []
	for (const m of norm.matchAll(/\d+/g)) {
		if (m.index === undefined) continue
		const unit = unitAt(norm, m.index, m[0])
		if (unit !== "gold" && unit !== "seconds") continue
		const value = Number(m[0])
		const mine = anchors.filter(a => a.unit === unit)
		if (mine.length === 0) continue
		let best = mine[0]!.value
		for (const a of mine) if (Math.abs(a.value - value) < Math.abs(best - value)) best = a.value
		out.push({ unit, error: value - best })
	}
	return out
}

/* ================================================================ the corpus */

interface Turn {
	index: number
	brief: string
	roster: string[]
}
interface Window {
	id: string
	champion: string
	counterpart: string
	turns: Turn[]
}
interface Record_ {
	arm: string
	windowId: string
	index: number
	text: string
	payload: string | null
	error: string | null
}

const path = process.argv[2]?.startsWith("--") ? undefined : process.argv[2]
const corpusPath = path ?? "data/eval/integrate-corpus-20260911.json"
const dumpAt = process.argv.indexOf("--dump")
const dumping = dumpAt === -1 ? null : process.argv[dumpAt + 1] ?? null

const run = JSON.parse(readFileSync(corpusPath, "utf8")) as {
	mode: string
	windows: Window[]
	records: Record_[]
}
const byWindow = new Map(run.windows.map(w => [w.id, w]))
const turnsOf = new Map(run.windows.map(w => [w.id, new Map(w.turns.map(t => [t.index, t]))]))

/**
 * The block a line is scored against, exactly as `bench-stream.ts` assembles it.
 *
 * Under `trusted` the socket keeps a thread, so a figure from the opening brief is still backed at
 * turn nine even though that turn's delta does not restate it — hence brief AND payload. Copied
 * rather than imported because the harness builds it inside a closure over live state; if the two
 * ever disagree, this script is the one that is wrong.
 */
const blockFor = (r: Record_, t: Turn): string =>
	run.mode !== "trusted" ? t.brief
	: r.payload === null || r.payload === t.brief ? t.brief
	: `${t.brief}\n\n${r.payload}`

interface GameRow {
	game: string
	spoken: number
	before: number
	after: number
	/**
	 * How many of the game's lines mention his gold at all.
	 *
	 * Here because the per-game spread was the thing that most looked like a finding and least was
	 * one: 61% of one game's lines were charged and 20% of another's. Both games' figures are the
	 * same figures said the same way, and the column that tracks the spread is this one — on this
	 * corpus the correlation between a game's charge rate and its gold-mention rate is r=0.76,
	 * which is a fact about what the coach chose to talk about and not about whether it was true.
	 */
	goldLines: number
	classes: Map<FigureClass, number>
}

const rows = new Map<string, GameRow>()
const overall = new Map<FigureClass, number>()
const dumped: string[] = []
let spoken = 0
let before = 0
let after = 0
let unanchored = 0
const goldError: number[] = []
const timerError: number[] = []

for (const r of run.records) {
	if (r.arm === "mock" || r.error !== null) continue
	const w = byWindow.get(r.windowId)
	const t = turnsOf.get(r.windowId)?.get(r.index)
	if (!w || !t) continue
	const block = blockFor(r, t)
	const scored = scoreLine({ line: r.text, block, roster: t.roster, champions: t.roster })
	const was = scoreLine({ line: r.text, block, roster: t.roster, champions: t.roster }, { literal: true })
	if (scored.silent) continue
	const klasses = classifyLine(r.text, block, t.roster)
	const game = `${w.counterpart} (${w.id})`
	const row = rows.get(game) ?? { game, spoken: 0, before: 0, after: 0, goldLines: 0, classes: new Map() }
	row.spoken++
	spoken++
	// AFTER is what the scorer says today.
	const bad = scored.faults.some(f => FABRICATION_FAULTS.includes(f))
	if (bad) {
		row.after++
		after++
	}
	if (was.faults.some(f => FABRICATION_FAULTS.includes(f))) {
		row.before++
		before++
	}
	if (spokenErrors(r.text, block).some(e => e.unit === "gold")) row.goldLines++
	for (const e of spokenErrors(r.text, block)) {
		if (e.unit === "gold") goldError.push(e.error)
		else timerError.push(e.error)
	}
	for (const k of klasses) {
		if (!k.anchored) unanchored++
		row.classes.set(k.klass, (row.classes.get(k.klass) ?? 0) + 1)
		overall.set(k.klass, (overall.get(k.klass) ?? 0) + 1)
		if (dumping !== null && k.klass === dumping)
			dumped.push(
				`${game} ${k.value} ${k.unit} <- ${k.source ?? "—"} (${k.via})${k.anchored ? "" : "  [UNANCHORED]"}\n    ${r.text}`
			)
	}
	rows.set(game, row)
}

const pct = (i: Interval): string =>
	i.n === 0 ? "--" : `${(100 * i.p).toFixed(0)}% [${(100 * i.lo).toFixed(0)}-${(100 * i.hi).toFixed(0)}]`

console.log(`corpus ${corpusPath}`)
console.log(`${spoken} spoken lines over ${rows.size} games\n`)
console.log(`lines carrying a charged figure   BEFORE ${before}/${spoken} ${pct(wilson(before, spoken))}`)
console.log(`                                   AFTER ${after}/${spoken} ${pct(wilson(after, spoken))}\n`)

const ORDER: FigureClass[] = ["rounded", "map-timer", "level-goal", "misowned", "derived", "invented"]
const total = ORDER.reduce((a, k) => a + (overall.get(k) ?? 0), 0)
console.log("charged figures by class")
for (const k of ORDER) {
	const n = overall.get(k) ?? 0
	console.log(`  ${k.padEnd(12)} ${String(n).padStart(4)}  ${total === 0 ? "" : `${((100 * n) / total).toFixed(0)}%`}`)
}
console.log(`  ${"total".padEnd(12)} ${String(total).padStart(4)}`)
console.log(
	`  of which the payload does NOT anchor to a gold-in-hand or a clock: ${unanchored} — check these by eye\n`
)

const spread = (xs: number[], what: string): string => {
	if (xs.length === 0) return `  ${what}: none spoken`
	const s = [...xs].sort((a, b) => a - b)
	const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))]!
	const within = (t: number): number => s.filter(x => Math.abs(x) <= t).length
	return `  ${what.padEnd(18)} n=${String(s.length).padStart(3)}  p05 ${String(q(0.05)).padStart(4)}  median ${String(q(0.5)).padStart(4)}  p95 ${String(q(0.95)).padStart(4)}  |err|<=${what === "gold (g)" ? "100g" : "5s"}: ${within(what === "gold (g)" ? 100 : 5)}/${s.length}`
}
console.log("how far each SPOKEN figure is from the payload's own answer — no scorer involved")
console.log(spread(goldError, "gold (g)"))
console.log(spread(timerError, "clock (s)"))
console.log()

console.log("per game (before -> after, share of lines that mention gold, and the classes that closed the gap)")
for (const row of [...rows.values()].sort((a, b) => b.before / b.spoken - a.before / a.spoken)) {
	const cl = ORDER.filter(k => row.classes.has(k))
		.map(k => `${k} ${row.classes.get(k)}`)
		.join(", ")
	console.log(
		`  ${row.game.padEnd(34)} ${String(row.before).padStart(3)}/${String(row.spoken).padEnd(3)} ${String(Math.round((100 * row.before) / row.spoken)).padStart(3)}% -> ${String(row.after).padStart(3)} ${String(Math.round((100 * row.after) / row.spoken)).padStart(3)}%   gold ${String(Math.round((100 * row.goldLines) / row.spoken)).padStart(3)}%   ${cl}`
	)
}

/* =========================================================== the teeth check */

/**
 * Inject a KNOWN error into every gold and clock figure the coach spoke, and see how often the
 * scorer charges it.
 *
 * This is the other half of the before/after, and without it the headline is worthless. Taking a
 * fabrication rate from 35% to 0% is trivially achievable by deleting the rule; the question is
 * whether the instrument can still tell a corrupted line from an honest one. So: same lines, same
 * payloads, every figure moved by a fixed amount, and the number that matters is the LIFT — how
 * much likelier a charge is against a line that is wrong than against a line that is right.
 *
 * Measured on this corpus at +300 gold and +30 seconds:
 *
 *     literal   charges 54% of honest lines, 79% of corrupted        lift 24pp
 *     today     charges  0% of honest lines, 69% of corrupted        lift 68pp
 *
 * Today's rules catch ten points FEWER of the injected errors, and that cost is real: a respawn
 * understated by nine seconds now passes. They are three times better at separating a wrong line
 * from a right one, which is the only thing the instrument is for.
 */
const corrupt = (line: string, shiftGold: number, shiftSec: number): string => {
	const norm = normalizeNumbers(line)
	let out = ""
	let last = 0
	for (const m of norm.matchAll(/\d+/g)) {
		if (m.index === undefined) continue
		const u = unitAt(norm, m.index, m[0])
		if (u !== "gold" && u !== "seconds") continue
		out += norm.slice(last, m.index) + String(Math.max(0, Number(m[0]) + (u === "gold" ? shiftGold : shiftSec)))
		last = m.index + m[0].length
	}
	return out + norm.slice(last)
}

if (process.argv.includes("--inject")) {
	const pool = run.records.filter(r => {
		if (r.arm === "mock" || r.error !== null) return false
		const t = turnsOf.get(r.windowId)?.get(r.index)
		return t !== undefined && corrupt(r.text, 300, 30) !== normalizeNumbers(r.text)
	})
	const chargeRate = (shiftGold: number, shiftSec: number, literal: boolean): Interval => {
		let n = 0
		let k = 0
		for (const r of pool) {
			const t = turnsOf.get(r.windowId)!.get(r.index)!
			const sc = scoreLine(
				{
					line: corrupt(r.text, shiftGold, shiftSec),
					block: blockFor(r, t),
					roster: t.roster,
					champions: t.roster
				},
				{ literal }
			)
			if (sc.silent) continue
			n++
			if (sc.faults.some(f => FABRICATION_FAULTS.includes(f))) k++
		}
		return wilson(k, n)
	}
	console.log(`\ninjected-error check, on the ${pool.length} lines that carry a gold or clock figure`)
	for (const literal of [true, false]) {
		const clean = chargeRate(0, 0, literal)
		console.log(`  ${literal ? "literal" : "today  "}  honest lines charged ${pct(clean)}`)
		for (const [g, s] of [
			[150, 15],
			[300, 30],
			[700, 60]
		] as [number, number][]) {
			const c = chargeRate(g, s, literal)
			console.log(
				`           +${String(g).padStart(3)}g/+${String(s).padStart(2)}s charged ${pct(c)}   lift ${Math.round(100 * (c.p - clean.p))}pp`
			)
		}
	}
}

if (dumping !== null) {
	console.log(`\n--- every "${dumping}" figure (${dumped.length}) ---`)
	for (const d of dumped) console.log(d)
}
