/**
 * compare-arms — the paired comparison between two arms of one `judge-corpus` run.
 *
 * ## Why this is not a second judge
 *
 * It calls nothing. It reads a `*-judged.json` that `judge-corpus.ts` already wrote — one judge,
 * one blinded pool, every arm shuffled together — and does the arithmetic that file's own per-arm
 * table deliberately stops short of: the pairing.
 *
 * ## The pairing, and why unpaired lines are printed rather than dropped quietly
 *
 * Two arms of one `bench-stream` run answer the SAME turns: the schedule is computed once per
 * window from the samples and replayed to every arm, so `(windowId, clock)` names one question and
 * each arm's answer to it. Comparing two independent Wilson intervals throws that away. So the
 * headline test here is McNemar's exact on the turns where the two arms were graded differently,
 * from `lib/stats.ts`, where it is unit-tested through both of its callers.
 *
 * A turn can still go unpaired — one arm's batch failed to parse, one arm errored — and that is
 * counted and printed, because an ablation whose arms were judged on different subsets is not an
 * ablation.
 *
 * ## Two tests, because the lines are not independent
 *
 * The turn-level McNemar treats each turn as its own trial. They are not: the protocol feeds an
 * arm its own previous lines, so a run of bad lines inside one game is correlated and the p-value
 * is anti-conservative. The GAME-LEVEL sign test is the conservative twin — one vote per game, no
 * within-game dependence to launder — and it is printed beside it. When they disagree, believe the
 * one with fewer assumptions.
 *
 * ## The negative control is free, and it is in the data
 *
 * When a champion has no file on disk, withholding it changes nothing: the two arms were handed a
 * byte-identical system prompt for that game. Those games are marked `same prompt` in the table and
 * excluded from the tests, because they measure the model's own run-to-run noise rather than the
 * ablation — which makes them the noise floor every other row should be read against.
 *
 * Usage:
 *     node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *       scripts/compare-arms.ts data/eval/<run>-judged.json --a gemini-http --b gemini-http+nocp
 *
 *     --a <arm>    the arm under test (printed first)
 *     --b <arm>    the baseline it is compared against
 *     --games <ids>  restrict to a comma list of gameIds (for comparing against an older corpus)
 *
 * NODE ONLY. Reads two stored files and writes none.
 */

import { readFileSync } from "node:fs"
import { wilson } from "../src/analysis/coach-score.ts"
import { mcnemar } from "./lib/stats.ts"
import { fullKnowledge } from "../src/review/live-knowledge-full.ts"

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : fallback
}
const judgedPath = argv.find(a => !a.startsWith("--") && a.endsWith(".json"))
if (!judgedPath) throw new Error("usage: compare-arms.ts <judged.json> --a <arm> --b <arm>")
const armA = arg("a", "")
const armB = arg("b", "")
if (armA === "" || armB === "") throw new Error("both --a and --b are required")
const onlyGames = new Set(arg("games", "").split(",").map(s => s.trim()).filter(s => s !== ""))

type Verdict = "useful" | "generic" | "unverifiable" | "false" | "ungraded"
interface JudgedLine {
	arm: string
	windowId: string
	/** Present on files written since judge-corpus carried them; absent on older ones. */
	index?: number
	rep?: number
	clock: string
	text: string
	verdict: Verdict
	why: string
}
interface JudgedFile {
	of: string
	judge: string
	lines: JudgedLine[]
}
interface Window_ {
	id: string
	gameId: string
	champion: string
	counterpart?: string | null
}

const judged = JSON.parse(readFileSync(judgedPath, "utf8")) as JudgedFile
const run = JSON.parse(readFileSync(judged.of, "utf8")) as { windows: Window_[] }
const windows = new Map(run.windows.map(w => [w.id, w]))

/**
 * Did the ablation actually change this game's system prompt?
 *
 * Asked of `fullKnowledge` itself rather than of a list of champion names kept in step by hand —
 * the files on disk are the truth, and a list would be wrong the first time one is added.
 */
const prompts = (w: Window_): { full: string; nocp: string; noown: string } => ({
	full: fullKnowledge({ champion: w.champion, counterpart: w.counterpart ?? null }),
	nocp: fullKnowledge({ champion: w.champion, counterpart: null }),
	noown: fullKnowledge({ champion: "", counterpart: w.counterpart ?? null })
})
const promptFor = (w: Window_, arm: string): string => {
	const p = prompts(w)
	return arm.includes("+noown") ? p.noown : arm.includes("+nocp") ? p.nocp : p.full
}

const pct = (k: number, n: number): string => (n === 0 ? "   — " : `${Math.round((100 * k) / n)}%`.padStart(4))
const band = (k: number, n: number): string => {
	const i = wilson(k, n)
	return `[${Math.round(i.lo * 100)}-${Math.round(i.hi * 100)}]`
}

/* ---------------------------------------------------------------- the pairing */

/*
 * The key names ONE answer, not one clock.
 *
 * `windowId|clock` is not unique: `bench-stream --repeats N` asks the same turn N times and every
 * repetition carries the same clock, so building the map on that key kept the last repetition and
 * dropped the others into nothing — no warning, a smaller n, and a comparison run on whichever
 * answers happened to be last. Files written since `judge-corpus` carried `index`/`rep` are keyed
 * on those; older files fall back to the clock and are CHECKED for collisions below rather than
 * assumed to have none.
 */
const keyOf = (l: JudgedLine): string =>
	l.index === undefined ? `${l.windowId}|${l.clock}` : `${l.windowId}|${l.index}|${l.rep ?? 1}`
const collisions: string[] = []
const byArm = (arm: string): Map<string, JudgedLine> => {
	const out = new Map<string, JudgedLine>()
	for (const l of judged.lines) {
		if (l.arm !== arm) continue
		if (onlyGames.size > 0 && !onlyGames.has(windows.get(l.windowId)?.gameId ?? "")) continue
		const k = keyOf(l)
		if (out.has(k)) collisions.push(`${arm} ${k}`)
		out.set(k, l)
	}
	return out
}
const a = byArm(armA)
const b = byArm(armB)
if (collisions.length > 0)
	throw new Error(
		`${collisions.length} line(s) share a key and would be silently overwritten — this judged file predates ` +
			`\`index\`/\`rep\` and holds repeats, so a clock does not name one answer. Re-run judge-corpus on the ` +
			`run to get the fields. First few: ${collisions.slice(0, 5).join(", ")}`
	)
if (a.size === 0 || b.size === 0)
	throw new Error(`arm(s) not in ${judgedPath} — present: ${[...new Set(judged.lines.map(l => l.arm))].join(", ")}`)

const paired = [...a.keys()].filter(k => b.has(k))
const aOnlyKeys = [...a.keys()].filter(k => !b.has(k))
const bOnlyKeys = [...b.keys()].filter(k => !a.has(k))

console.log(`\n${judgedPath}`)
console.log(`judge ${judged.judge}`)
console.log(`\nA = ${armA}   B = ${armB}`)
console.log(
	`paired turns ${paired.length}   judged in A only ${aOnlyKeys.length}   in B only ${bOnlyKeys.length}` +
		(aOnlyKeys.length + bOnlyKeys.length === 0 ? "" : "   (unpaired turns are excluded from every test below)")
)

/* ---------------------------------------------------------------- per game */

interface Row {
	gameId: string
	label: string
	same: boolean
	n: number
	uA: number
	uB: number
	fA: number
	fB: number
}
const rows: Row[] = []
for (const w of run.windows) {
	if (onlyGames.size > 0 && !onlyGames.has(w.gameId)) continue
	const keys = paired.filter(k => k.startsWith(`${w.id}|`))
	if (keys.length === 0) continue
	const count = (m: Map<string, JudgedLine>, v: Verdict) => keys.filter(k => m.get(k)!.verdict === v).length
	rows.push({
		gameId: w.gameId,
		label: `${w.champion} vs ${w.counterpart ?? "?"}`,
		same: promptFor(w, armA) === promptFor(w, armB),
		n: keys.length,
		uA: count(a, "useful"),
		uB: count(b, "useful"),
		fA: count(a, "false"),
		fB: count(b, "false")
	})
}

console.log(`\nPER GAME — "same prompt" means the ablated section was not on disk for that champion,`)
console.log(`so those rows are this model's run-to-run noise and nothing else. No intervals here on`)
console.log(`purpose: on a 25-line game the interval covers almost any claim.\n`)
/** Per-game deltas in PERCENTAGE POINTS, so the delta column and the two rate columns share units. */
const pp = (kA: number, kB: number, n: number): string => {
	const d = n === 0 ? 0 : (100 * (kA - kB)) / n
	return `${d >= 0 ? "+" : ""}${d.toFixed(0)}pp`.padStart(6)
}
console.log("  gameId       matchup                turns     useful A     B  delta       false A     B  delta")
for (const r of rows)
	console.log(
		`  ${r.gameId}  ${r.label.padEnd(22)}${r.same ? "*" : " "}${String(r.n).padStart(4)}      ` +
			`${pct(r.uA, r.n)} ${pct(r.uB, r.n)} ${pp(r.uA, r.uB, r.n)}      ` +
			`${pct(r.fA, r.n)} ${pct(r.fB, r.n)} ${pp(r.fA, r.fB, r.n)}`
	)
console.log("  * same prompt in both arms — the negative control, excluded from the tests below")

/* ---------------------------------------------------------------- pooled + tests */

const report = (title: string, all: readonly string[], games: readonly Row[]): void => {
	if (all.length === 0) return
	/*
	 * A pair where EITHER arm is `ungraded` is not a pair this test may use.
	 *
	 * Left in, an ungraded line reads as "not useful" and "not false", so a turn where A was useful
	 * and B was ungraded becomes a discordant turn won by A — a difference manufactured out of the
	 * judge failing to parse, and it lands on whichever arm the judge happened to choke on. Dropping
	 * them is right and it is also a loss, so the count is printed on the same line as the n it
	 * changed rather than left to be inferred from two numbers that no longer match.
	 */
	const keys = all.filter(k => a.get(k)!.verdict !== "ungraded" && b.get(k)!.verdict !== "ungraded")
	const dropped = all.length - keys.length
	if (keys.length === 0) {
		console.log(`\n${title} — all ${all.length} paired turns had an ungraded line in one arm. Nothing to test.`)
		return
	}
	const u = (m: Map<string, JudgedLine>) => keys.filter(k => m.get(k)!.verdict === "useful").length
	const f = (m: Map<string, JudgedLine>) => keys.filter(k => m.get(k)!.verdict === "false").length
	const n = keys.length
	console.log(
		`\n${title} — ${n} paired turns across ${games.length} game(s)` +
			(dropped === 0 ? "" : `   (${dropped} more pair(s) excluded: one arm's line was UNGRADED)`) +
			`\n`
	)
	console.log(
		`  useful   A ${String(u(a)).padStart(3)}/${n} ${pct(u(a), n)} ${band(u(a), n)}    ` +
			`B ${String(u(b)).padStart(3)}/${n} ${pct(u(b), n)} ${band(u(b), n)}`
	)
	console.log(
		`  false    A ${String(f(a)).padStart(3)}/${n} ${pct(f(a), n)} ${band(f(a), n)}    ` +
			`B ${String(f(b)).padStart(3)}/${n} ${pct(f(b), n)} ${band(f(b), n)}`
	)

	for (const axis of ["useful", "false"] as const) {
		const m = mcnemar(keys.map(k => ({ a: a.get(k)!.verdict === axis, b: b.get(k)!.verdict === axis })))
		/*
		 * THE EFFECT SIZE, beside the p-value, because a null result without one says nothing about
		 * how big an effect was ruled out. This is the paired difference in rates with its standard
		 * error taken from the discordant counts (the usual `sqrt(b + c - (b-c)^2/n) / n`), which
		 * is the paired analogue of a Wilson interval and the only honest way to say "we would have
		 * seen an effect this large".
		 */
		const diff = (m.aOnly - m.bOnly) / n
		const se = Math.sqrt(m.aOnly + m.bOnly - ((m.aOnly - m.bOnly) * (m.aOnly - m.bOnly)) / n) / n
		console.log(
			`\n  McNemar exact on ${axis.padEnd(6)} A only ${m.aOnly}, B only ${m.bOnly}, ` +
				`both ${m.both}, neither ${m.neither}   p = ${m.p < 0.001 ? m.p.toExponential(2) : m.p.toFixed(3)}`
		)
		console.log(
			`    A − B = ${(diff * 100 >= 0 ? "+" : "") + (diff * 100).toFixed(1)}pp  ` +
				`95% [${((diff - 1.96 * se) * 100).toFixed(1)}, ${((diff + 1.96 * se) * 100).toFixed(1)}]`
		)
	}

	// One vote per game: the conservative twin of the turn-level test. See the header.
	for (const axis of ["useful", "false"] as const) {
		const delta = games.map(r => (axis === "useful" ? r.uA / r.n - r.uB / r.n : r.fA / r.n - r.fB / r.n))
		const sign = mcnemar(delta.map(d => ({ a: d > 0, b: d < 0 })))
		const sorted = [...delta].sort((x, y) => x - y)
		const median =
			sorted.length === 0 ? 0
			: sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2]!
			: (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
		console.log(
			`  sign test on ${axis.padEnd(6)}   A higher in ${sign.aOnly} game(s), B higher in ${sign.bOnly}, ` +
				`tied ${games.length - sign.aOnly - sign.bOnly}   p = ${sign.p.toFixed(3)}   ` +
				`median per-game delta ${(median * 100 >= 0 ? "+" : "") + (median * 100).toFixed(1)}pp`
		)
	}
}

const changed = rows.filter(r => !r.same)
const changedKeys = paired.filter(k => changed.some(r => r.gameId === windows.get(k.split("|")[0]!)!.gameId))
const sameKeys = paired.filter(k => !changedKeys.includes(k))
report("WHERE THE PROMPT ACTUALLY DIFFERED", changedKeys, changed)
report("NEGATIVE CONTROL — identical prompts, so this is the noise floor", sameKeys, rows.filter(r => r.same))
report("EVERY GAME POOLED — dilutes the effect with the control; here for completeness", paired, rows)
