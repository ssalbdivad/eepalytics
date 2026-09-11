/**
 * What did a stored run of the live coach actually say, and how does it score TODAY?
 *
 * ## Why this file exists
 *
 * `data/eval/` holds about thirty runs from 2026-09-04 in one shape — `{ at, scored: [{ said,
 * score }] }` — written by `scripts/eval-live.ts`. That script was deleted on 2026-09-11 because
 * `bench-stream.ts` supersedes it as an INSTRUMENT: eval-live rebuilt its states from the
 * post-game timeline, which carries no enemy CS, no items and no roles, so a comparison run on it
 * measured improvisation rather than coaching. Deleting it was right.
 *
 * Deleting its READER was not. The standing rule here is that a stored measurement is never
 * deleted or rewritten and every run in `data/eval/` stays re-scorable, and those thirty files
 * became unreadable the moment their writer left the tree. This is the reader that was owed.
 *
 * ## It re-scores rather than reprinting
 *
 * Each stored line carries the full `VisionState` it was said against, so the block can be
 * rebuilt with today's `renderState` and the line put through today's `scoreLine` from
 * `src/analysis/coach-score.ts` — the shipped scorer, not the private one eval-live carried. So
 * the two columns below are different claims and are printed apart:
 *
 *   `stored`  the verdict eval-live recorded at the time, verbatim out of the file
 *   `today`   the same sentence through the current scorer, over the block rebuilt from the
 *             same state
 *
 * Where they disagree the SCORER changed, not the coach, and that is the interesting row. Neither
 * column is edited into the file: this script only reads.
 *
 * ## What it cannot do
 *
 * It cannot re-run the model. The states in these files came from the post-game timeline and are
 * exactly the starved inputs that made eval-live the wrong instrument; replaying them would
 * reproduce the flaw, not the measurement. To ask a model a new question, use `bench-stream.ts`,
 * which replays the RAW recorded client samples instead.
 *
 * Usage:
 *     node --experimental-strip-types scripts/rescore-runs.ts data/eval/run22.json
 *     node --experimental-strip-types scripts/rescore-runs.ts --all
 *     node --experimental-strip-types scripts/rescore-runs.ts data/eval/run22.json --lines
 *
 *     --all      every file in data/eval/ that is in this shape, one row each
 *     --lines    print every sentence with its clock and the faults it draws today
 *
 * NODE ONLY. Reads stored files and the read-only DB; makes no network call and spends nothing.
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { DATA_DIR } from "../src/shared/constants.ts"
import { renderState } from "../src/shared/live-state.ts"
import type { VisionState } from "../src/shared/live-state.ts"
import { scoreLine, wilson } from "../src/analysis/coach-score.ts"
import type { Interval } from "../src/analysis/coach-score.ts"
import { championVocabulary } from "./lib/stream.ts"

/* ============================================================== the stored shape */

/**
 * Deliberately loose, and every field optional.
 *
 * These files were written by a script that no longer exists and cannot be consulted, and the
 * corpus spans a week of edits to its own output — `run1.json` and `run22.json` do not carry
 * identical keys. A strict parser here would reject the older half of the evidence to gain
 * nothing, so each field is read defensively and a file that carries none is reported as not
 * being in this shape rather than throwing.
 */
interface StoredSaid {
	gameId?: string
	atSec?: number
	clock?: string
	text?: string
	ms?: number
	state?: VisionState
}

interface StoredRow {
	said?: StoredSaid
	score?: Record<string, unknown>
}

interface StoredRun {
	at?: number
	scored?: StoredRow[]
}

/** True when this file is the eval-live corpus shape, false for every other thing in data/eval. */
const isRunFile = (v: unknown): v is StoredRun =>
	typeof v === "object" && v !== null && Array.isArray((v as StoredRun).scored)

/* ==================================================================== scoring */

interface Tally {
	file: string
	lines: number
	silent: number
	/** Spoken lines only — a silence is not a clean line, it is no line. */
	spoken: number
	storedFaulty: number
	todayFaulty: number
	disagree: number
	rows: LineRow[]
}

interface LineRow {
	clock: string
	text: string
	storedFaults: string[]
	todayFaults: string[]
}

/**
 * The verdict eval-live stored, turned back into a fault list.
 *
 * Its score object held four arrays and two booleans; a non-empty array or a true boolean was a
 * fault. `hasNumber` and `chars` were descriptive and are not faults, so they are not read here.
 */
const storedFaults = (score: Record<string, unknown> | undefined): string[] => {
	if (!score) return []
	const out: string[] = []
	for (const k of ["invented", "forbidden", "unbacked"])
		if (Array.isArray(score[k]) && (score[k] as unknown[]).length > 0) out.push(k)
	for (const k of ["inventedDeath", "motif"]) if (score[k] === true) out.push(k)
	return out
}

const rosterOf = (s: VisionState): string[] =>
	[s.me?.champion, ...(s.allies ?? []).map(p => p.champion), ...(s.enemies ?? []).map(p => p.champion)]
		.filter((c): c is string => typeof c === "string" && c !== "")

const tally = (file: string, run: StoredRun, champions: readonly string[]): Tally => {
	const rows: LineRow[] = []
	let silent = 0
	let storedBad = 0
	let todayBad = 0
	let disagree = 0

	for (const r of run.scored ?? []) {
		const text = r.said?.text ?? ""
		const state = r.said?.state
		const stored = storedFaults(r.score)
		/*
		 * No state means no block, and no block means the number rules cannot run. Such a line is
		 * counted and printed with `today` blank rather than scored against an empty block, which
		 * would clear every unbacked number by pretending nothing was known.
		 */
		const score =
			state ?
				scoreLine({ line: text, block: renderState(state), roster: rosterOf(state), champions })
			:	null
		const today = score?.faults ?? null
		if (score?.silent === true) {
			silent += 1
			continue
		}
		if (stored.length > 0) storedBad += 1
		if (today !== null && today.length > 0) todayBad += 1
		if (today !== null && (stored.length > 0) !== (today.length > 0)) disagree += 1
		rows.push({
			clock: r.said?.clock ?? (r.said?.atSec !== undefined ? String(r.said.atSec) : "?"),
			text,
			storedFaults: stored,
			todayFaults: today ?? ["(no state stored — not scorable)"]
		})
	}

	return {
		file,
		lines: (run.scored ?? []).length,
		silent,
		spoken: rows.length,
		storedFaulty: storedBad,
		todayFaulty: todayBad,
		disagree,
		rows
	}
}

const rate = (k: number, n: number): string => {
	if (n === 0) return "     —      "
	const i: Interval = wilson(k, n)
	return `${String(Math.round((k / n) * 100)).padStart(3)}% [${Math.round(i.lo * 100)}–${Math.round(i.hi * 100)}]`
}

/* ======================================================================= main */

const argv = process.argv.slice(2)
const showLines = argv.includes("--lines")
const files =
	argv.includes("--all") ?
		readdirSync(join(DATA_DIR, "eval"))
			.filter(f => f.endsWith(".json"))
			.sort()
			.map(f => join(DATA_DIR, "eval", f))
	:	argv.filter(a => !a.startsWith("--"))

if (files.length === 0) {
	console.error("usage: rescore-runs.ts <file.json> [--lines]   |   rescore-runs.ts --all")
	process.exit(2)
}

const vocab = championVocabulary()
if (vocab.names.length === 0)
	console.log(
		"NOTE: no champion vocabulary in the DB, so the invented-champion fault cannot fire today.\n"
	)

const tallies: Tally[] = []
const skipped: string[] = []
for (const f of files) {
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(f, "utf8"))
	} catch {
		skipped.push(`${f}  (not JSON)`)
		continue
	}
	if (!isRunFile(parsed)) {
		skipped.push(`${f}  (not the eval-live run shape)`)
		continue
	}
	tallies.push(tally(f, parsed, vocab.names))
}

console.log(
	`\n${tallies.length} stored run(s), scored with today's src/analysis/coach-score.ts over the\n` +
		`state each line was said against. "stored" is the verdict the file already carried.\n`
)
console.log("file                                        lines  silent  spoken   stored faulty   today faulty   differ")
for (const t of tallies)
	console.log(
		`${t.file.split("/").pop()!.padEnd(42)} ${String(t.lines).padStart(5)}  ${String(t.silent).padStart(6)}  ${String(
			t.spoken
		).padStart(6)}   ${rate(t.storedFaulty, t.spoken)}   ${rate(t.todayFaulty, t.spoken)}   ${String(
			t.disagree
		).padStart(6)}`
	)

/*
 * WHICH fault, not just how many.
 *
 * The first run of this reader put run22.json at 0% faulty stored against 92% faulty today, which
 * reads like a broken rebuild until you see that every one of those is `no-alternative` — a rule
 * today's scorer has and the 2026-09-04 one did not. That is the "true but useless" failure this
 * app spent months on, measured retroactively on the corpus that predates the rule. A count alone
 * would have been thrown away as an artefact, so the breakdown is printed, not optional.
 */
const byFault = new Map<string, number>()
for (const t of tallies) for (const r of t.rows) for (const f of r.todayFaults) byFault.set(f, (byFault.get(f) ?? 0) + 1)
if (byFault.size > 0) {
	console.log("\nwhich fault today's scorer draws, over every spoken line above:")
	for (const [f, n] of [...byFault].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${f}`)
	console.log(
		"\nA fault the stored column never shows is a rule that did not exist when the run was made.\n" +
			"That is the scorer changing, not the coach — read the row, not the delta."
	)
}

if (showLines)
	for (const t of tallies) {
		console.log(`\n${"─".repeat(98)}\n${t.file}`)
		for (const r of t.rows)
			console.log(
				`  ${r.clock.padStart(6)}  ${r.text.slice(0, 74).padEnd(74)}  stored:${
					r.storedFaults.join(",") || "clean"
				}  today:${r.todayFaults.join(",") || "clean"}`
			)
	}

if (skipped.length > 0 && !argv.includes("--all"))
	for (const s of skipped) console.log(`skipped ${s}`)
if (argv.includes("--all"))
	console.log(`\n(${skipped.length} other file(s) in data/eval are not in this shape and were skipped)`)
