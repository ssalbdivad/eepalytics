/**
 * How often is a whole turn nothing but his own HUD, and what does refusing those cost?
 *
 * Three measurements over real data, no model calls, no billing:
 *
 * 1. **the rate** — replay his four recorded games through the daemon's own `buildLiveStateForBench`
 *    at the shipped twenty-second turn and count the turns where `hudOnlyTurn` is true;
 * 2. **the cost** — join every recorded `briefing`-arm transcript on split-03 back to the state it
 *    held and cross-tab the rule against what the blind judges called useful. This is the number
 *    that argues AGAINST the rule and it is printed first among the transcript figures on purpose;
 * 3. **the aim** — score the rule against `data/eval/target-lines.md`, the 32 hand-written moments,
 *    which is the only "good" in this repo that a model did not write.
 *
 * Usage: `node --experimental-strip-types scripts/measure-hud-screen.ts`
 */
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { hudOnlyTurn, screenSplit } from "../src/shared/live-state.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const TURN_SEC = 20
const SAMPLES = `${ROOT}/data/live-samples`

interface Row {
	gameTime: number
	data: unknown
}
const readGame = (file: string): Row[] =>
	readFileSync(`${SAMPLES}/${file}`, "utf8")
		.split("\n")
		.filter(l => l.trim() !== "")
		.map(l => JSON.parse(l) as Row)

/*
 * A FRESH MODULE PER REPLAY, because `buildLiveState` holds the fact memory and the retirement
 * ledger at module scope — one process replaying two games in sequence would carry game one's
 * spent answers into game two. `scripts/measure-staleness.ts` does the same, for the same reason.
 */
let cacheBust = 0
const freshDaemon = async () =>
	(await import(`../src/server/routes/live.ts?hud=${cacheBust++}`)) as typeof import("../src/server/routes/live.ts")

/* ------------------------------------------------------------------ 1. the rate */

const games = readdirSync(SAMPLES).filter(f => /^split-\d+\.ndjson$/.test(f)).sort()
let turns = 0
let pass = 0
const offBy: Record<string, number> = {}

const bucket = (s: string): string =>
	/^(Dragon|Void grubs|Rift Herald|Baron|Elder Dragon)\b/.test(s) ?
		`schedule (${/UP and untaken/.test(s) ? "standing" : "coming"})`
	: /^down right now on their side/.test(s) ? "an enemy is down"
	: /is down \d+ seconds/.test(s) ? "the enemy jungler is down"
	: /of them are dead/.test(s) ? "a respawn window"
	: /gold/.test(s) ? "gold, held"
	: /CS|levels/.test(s) ? "the jungle race"
	: "a ranked fact of another kind"

for (const file of games) {
	const mod = await freshDaemon()
	let last = -1e9
	for (const row of readGame(file)) {
		if (row.gameTime - last < TURN_SEC) continue
		last = row.gameTime
		const st = mod.buildLiveStateForBench(row.data, row.gameTime)
		if (!st) continue
		turns++
		const off = screenSplit(st).offScreen
		if (off.length === 0) pass++
		for (const o of off) offBy[bucket(o)] = (offBy[bucket(o)] ?? 0) + 1
	}
}

console.log(`## 1. The rate — ${games.length} recorded games at a ${TURN_SEC}s turn\n`)
console.log(`${pass} of ${turns} turns (${((100 * pass) / turns).toFixed(1)}%) carry nothing he could not read himself.\n`)
console.log("What holds the other turns open:")
for (const [k, v] of Object.entries(offBy).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`)

/* ------------------------------------------------------------------ 2. the cost */

const RUNS = [
	"data/eval/gpt5/whole-game-retired-20260905.json",
	"data/eval/opus-briefing/ab-opus-late.json",
	"data/eval/opus-briefing/ab-opus-frames.json",
	"data/eval/sonnet-briefing-ab.json",
	"data/eval/whole-game-opus3.json",
	"data/eval/gpt5/paired-gpt5-20260905.json"
]
interface JudgedTurn {
	tSec: number
	line: string
	useful?: boolean
}
const split03 = readGame("split-03.ndjson")
const sampleAt = (tSec: number): Row | null => {
	let best: Row | null = null
	for (const r of split03) {
		if (r.gameTime > tSec + 1) break
		best = r
	}
	return best
}

const cost = { pass: { spoke: 0, useful: 0 }, open: { spoke: 0, useful: 0 } }
let cells = 0
for (const f of RUNS) {
	const run = JSON.parse(readFileSync(`${ROOT}/${f}`, "utf8")) as {
		cells: { arm: string; turns: JudgedTurn[] }[]
	}
	for (const cell of run.cells) {
		if (cell.arm !== "briefing") continue
		cells++
		const mod = await freshDaemon()
		for (const t of cell.turns) {
			const row = sampleAt(t.tSec)
			if (!row) continue
			const st = mod.buildLiveStateForBench(row.data, t.tSec)
			if (!st) continue
			const where = hudOnlyTurn(st) ? cost.pass : cost.open
			if (t.line === "PASS" || t.line.trim() === "") continue
			where.spoke++
			if (t.useful) where.useful++
		}
	}
}
const rate = (b: { spoke: number; useful: number }) =>
	b.spoke === 0 ? "-" : `${((100 * b.useful) / b.spoke).toFixed(0)}%`
console.log(`\n\n## 2. The cost — ${cells} recorded briefing cells on split-03, judged blind\n`)
console.log(`On turns this rule would offer PASS: ${cost.pass.spoke} lines spoken, ${cost.pass.useful} judged useful (${rate(cost.pass)}).`)
console.log(`On turns it leaves open:            ${cost.open.spoke} lines spoken, ${cost.open.useful} judged useful (${rate(cost.open)}).`)
console.log(
	`\nSo it silences ${cost.pass.spoke} of ${cost.pass.spoke + cost.open.spoke} lines the coach actually said, and the judges` +
		` called ${cost.pass.useful} of them useful. Read that against measurement 3, not on its own: the same judges` +
		` returned betterThanLastRound false on a round the owner called garbage, and the hand-written set marks` +
		` several of these exact clocks SILENCE.`
)

/* ------------------------------------------------------------------- 3. the aim */

/*
 * `data/eval/target-lines.md`, split-03 only, transcribed by moment id. SILENCE is the author's own
 * word; SAY means he wrote a line for that moment. M25 is deliberately absent: its silence is about
 * FARM specifically and the same entry offers a line, so it is not a verdict this rule can be
 * scored against without misquoting the document.
 */
const targets: [string, number, "SILENCE" | "SAY"][] = [
	["M01", 36, "SILENCE"], ["M02", 162, "SAY"], ["M03", 200, "SILENCE"], ["M04", 255, "SAY"],
	["M05", 292, "SILENCE"], ["M06", 341, "SAY"], ["M07", 365, "SAY"], ["M08", 377, "SAY"],
	["M09", 402, "SILENCE"], ["M10", 438, "SILENCE"], ["M11", 499, "SAY"], ["M12", 530, "SAY"],
	["M13", 554, "SAY"], ["M14", 578, "SILENCE"], ["M15", 637, "SAY"], ["M16", 682, "SILENCE"],
	["M17", 765, "SAY"], ["M18", 804, "SAY"], ["M19", 853, "SAY"], ["M20", 940, "SAY"],
	["M21", 980, "SAY"], ["M22", 1175, "SAY"], ["M23", 1219, "SILENCE"], ["M24", 1341, "SAY"]
]

const daemon = await freshDaemon()
const verdicts = new Map<number, { pass: boolean; off: string[] }>()
let last = -1e9
for (const row of split03) {
	if (row.gameTime - last < TURN_SEC) continue
	last = row.gameTime
	const st = daemon.buildLiveStateForBench(row.data, row.gameTime)
	if (!st) continue
	verdicts.set(Math.round(row.gameTime), { pass: hudOnlyTurn(st), off: screenSplit(st).offScreen })
}
const nearest = (t: number) => {
	let best: [number, { pass: boolean; off: string[] }] | null = null
	for (const e of verdicts) if (!best || Math.abs(e[0] - t) < Math.abs(best[0] - t)) best = e
	return best!
}

console.log(`\n\n## 3. The aim — against the ${targets.length} hand-written split-03 moments\n`)
let agree = 0
for (const [id, t, want] of targets) {
	const [at, v] = nearest(t)
	const got = v.pass ? "SILENCE" : "SAY"
	if (got === want) agree++
	console.log(
		`${id} ${String(Math.floor(t / 60)).padStart(2)}:${String(t % 60).padStart(2, "0")}  want ${want.padEnd(7)} got ${got.padEnd(7)} ${
			got === want ? "ok  " : "MISS"
		} @${at}s  ${v.off.join(" | ").slice(0, 90)}`
	)
}
const sil = targets.filter(t => t[2] === "SILENCE")
const say = targets.filter(t => t[2] === "SAY")
console.log(
	`\n${agree} of ${targets.length} agree.  Silences caught ${sil.filter(t => nearest(t[1])[1].pass).length}/${sil.length}` +
		`,  lines kept open ${say.filter(t => !nearest(t[1])[1].pass).length}/${say.length}.`
)
