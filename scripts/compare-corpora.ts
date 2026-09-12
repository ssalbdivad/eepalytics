/**
 * compare-corpora — the PAIRED comparison between two `judge-corpus` runs of the same games.
 *
 * `compare-arms.ts` compares two arms INSIDE one run, where the pairing is exact: the two arms
 * answered the same turn, blinded, in one judge conversation. This file answers the other
 * question, the one a night of fixes actually asks — *did the coach get better between yesterday
 * and today?* — and it is a WEAKER comparison for reasons that must be printed next to it:
 *
 *   - two runs are two judge conversations, so a difference of a couple of points can be the
 *     judge's own run-to-run noise rather than the coach's. The replicate floor measured on this
 *     harness is about ±6pp useful and ±9pp false; `--floor-useful` / `--floor-false` print it
 *     beside every rate so nothing smaller than the instrument reads as a movement;
 *   - the turn SCHEDULE is recomputed per run from the event detector, so two runs of one game do
 *     not answer the identical set of questions. The pairing here is therefore per GAME, never
 *     per turn, and the unit is the game.
 *
 * ## What it reports, and in which order
 *
 * LINES PER GAME first, rates second. He listens to a coach; he hears LINES. A run that improves
 * its useful RATE while speaking 21% more can raise the number of false lines he hears, and the
 * ratio hides exactly that — it happened on 2026-09-11 -> 09-12 (useful/game +31%, false/game
 * +12%, while the false RATE fell).
 *
 * The test is a paired t on the per-game differences plus a sign test, printed together. The t
 * assumes the differences are roughly normal across games and the sign test does not; when they
 * disagree, believe the sign test.
 *
 * Usage:
 *     node --experimental-strip-types scripts/compare-corpora.ts \
 *       --now data/eval/<new>-judged.json --before data/eval/<old>-judged.json [--arm gemini-http]
 *
 *     --arm <id>            arm to compare in both files (default gemini-http)
 *     --floor-useful <pp>   replicate-noise floor for the useful rate (default 6)
 *     --floor-false <pp>    replicate-noise floor for the false rate (default 9)
 *     --out <path>          write the per-game table and the tests as JSON
 *
 * NODE ONLY. Reads two stored files and writes only where `--out` says.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { tCrit975 } from "../src/analysis/trends.ts"
import { wilson } from "../src/analysis/coach-score.ts"
import { mcnemarExact } from "./lib/stats.ts"

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : fallback
}

const nowPath = arg("now", "")
const beforePath = arg("before", "")
if (nowPath === "" || beforePath === "")
	throw new Error("usage: compare-corpora.ts --now <judged.json> --before <judged.json>")
const armWanted = arg("arm", "gemini-http")
const floorUseful = Number(arg("floor-useful", "6"))
const floorFalse = Number(arg("floor-false", "9"))

interface PerGame {
	/** Absent in files written before the multi-arm judge; such a file holds one arm and only one. */
	arm?: string
	gameId: string
	label: string
	n: number
	useful: number
	false_: number
	generic: number
	unverifiable: number
	ungraded: number
}

const gamesOf = (path: string): Map<string, PerGame> => {
	const j = JSON.parse(readFileSync(path, "utf8")) as { perGame: PerGame[] }
	const rows = j.perGame.filter(g => g.arm === undefined || g.arm === armWanted)
	if (rows.length > 0 && rows[0]!.arm === undefined)
		console.log(`  note: ${path} predates the per-arm judge and its rows carry no arm label; taking all of them`)
	return new Map(rows.map(g => [g.gameId, g]))
}

const now = gamesOf(nowPath)
const before = gamesOf(beforePath)
const shared = [...now.keys()].filter(id => before.has(id))
const onlyNow = [...now.keys()].filter(id => !before.has(id))
const onlyBefore = [...before.keys()].filter(id => !now.has(id))

/** Mean, 95% CI (t, df = n-1) and the two-sided p of a paired difference. */
const paired = (diffs: number[]) => {
	const n = diffs.length
	const mean = diffs.reduce((a, d) => a + d, 0) / n
	const sd = Math.sqrt(diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / (n - 1))
	const se = sd / Math.sqrt(n)
	const half = tCrit975(n - 1) * se
	const t = se === 0 ? 0 : mean / se
	const up = diffs.filter(d => d > 0).length
	const dn = diffs.filter(d => d < 0).length
	return { n, mean, sd, se, t, lo: mean - half, hi: mean + half, up, dn, signP: mcnemarExact(up, dn) }
}

const f2 = (x: number): string => (x >= 0 ? `+${x.toFixed(2)}` : x.toFixed(2))
const f1 = (x: number): string => (x >= 0 ? `+${x.toFixed(1)}` : x.toFixed(1))

console.log(`NOW    ${nowPath}`)
console.log(`BEFORE ${beforePath}`)
console.log(`arm ${armWanted} — ${shared.length} game(s) in both`)
if (onlyNow.length > 0) console.log(`  only in NOW:    ${onlyNow.join(", ")}`)
if (onlyBefore.length > 0) console.log(`  only in BEFORE: ${onlyBefore.join(", ")}`)
console.log("")

const rows = shared.map(id => {
	const a = now.get(id)!
	const b = before.get(id)!
	return {
		gameId: id,
		label: a.label,
		spokenNow: a.n,
		spokenBefore: b.n,
		usefulNow: a.useful,
		usefulBefore: b.useful,
		falseNow: a.false_,
		falseBefore: b.false_,
		usefulRateNow: a.n === 0 ? 0 : a.useful / a.n,
		usefulRateBefore: b.n === 0 ? 0 : b.useful / b.n,
		falseRateNow: a.n === 0 ? 0 : a.false_ / a.n,
		falseRateBefore: b.n === 0 ? 0 : b.false_ / b.n
	}
})

console.log("PER GAME — lines he hears (useful / false / spoken), before -> now")
console.log("  game        matchup                       useful        false       spoken")
for (const r of rows)
	console.log(
		`  ${r.gameId}  ${r.label.padEnd(26)}  ${String(r.usefulBefore).padStart(3)} -> ${String(r.usefulNow).padEnd(3)}  ${String(
			r.falseBefore
		).padStart(3)} -> ${String(r.falseNow).padEnd(3)}  ${String(r.spokenBefore).padStart(3)} -> ${String(r.spokenNow).padEnd(3)}`
	)
console.log("")

const tests = {
	usefulPerGame: paired(rows.map(r => r.usefulNow - r.usefulBefore)),
	falsePerGame: paired(rows.map(r => r.falseNow - r.falseBefore)),
	spokenPerGame: paired(rows.map(r => r.spokenNow - r.spokenBefore)),
	usefulRatePp: paired(rows.map(r => 100 * (r.usefulRateNow - r.usefulRateBefore))),
	falseRatePp: paired(rows.map(r => 100 * (r.falseRateNow - r.falseRateBefore)))
}

const totals = (pick: (r: (typeof rows)[number]) => [number, number]) =>
	rows.reduce(
		(a, r) => {
			const [x, y] = pick(r)
			return [a[0] + x, a[1] + y] as [number, number]
		},
		[0, 0] as [number, number]
	)
const [uN, uB] = totals(r => [r.usefulNow, r.usefulBefore])
const [fN, fB] = totals(r => [r.falseNow, r.falseBefore])
const [sN, sB] = totals(r => [r.spokenNow, r.spokenBefore])

console.log("PRODUCT METRIC — lines per game, paired over the shared games")
for (const [name, key, tot] of [
	["USEFUL lines per game", "usefulPerGame", [uB, uN]],
	["FALSE  lines per game", "falsePerGame", [fB, fN]],
	["SPOKEN lines per game", "spokenPerGame", [sB, sN]]
] as const) {
	const t = tests[key]
	const [tb, tn] = tot as [number, number]
	console.log(
		`  ${name}: ${(tb / rows.length).toFixed(2)} -> ${(tn / rows.length).toFixed(2)}  (${f2(t.mean)} per game, 95% CI [${f2(
			t.lo
		)},${f2(t.hi)}], t=${t.t.toFixed(2)}, ${t.up} up / ${t.dn} down of ${t.n}, sign p=${t.signP.toFixed(3)})`
	)
}
console.log("")

console.log("JUDGED RATES — pooled, with the paired per-game movement and the replicate floor")
for (const [name, a, b, key, floor] of [
	["useful", uN, uB, "usefulRatePp", floorUseful],
	["false ", fN, fB, "falseRatePp", floorFalse]
] as const) {
	const wn = wilson(a, sN)
	const wb = wilson(b, sB)
	const t = tests[key]
	const moved = Math.abs(t.mean) > floor
	console.log(
		`  ${name}: ${(100 * wb.p).toFixed(0)}% [${(100 * wb.lo).toFixed(0)}-${(100 * wb.hi).toFixed(0)}] -> ${(
			100 * wn.p
		).toFixed(0)}% [${(100 * wn.lo).toFixed(0)}-${(100 * wn.hi).toFixed(0)}]  (paired ${f1(t.mean)}pp, 95% CI [${f1(
			t.lo
		)},${f1(t.hi)}], t=${t.t.toFixed(2)}, ${t.up} up / ${t.dn} down, sign p=${t.signP.toFixed(3)})`
	)
	console.log(
		`          replicate-noise floor ±${floor}pp — ${
			moved ? "the paired movement is larger than the floor" : "SMALLER THAN THE FLOOR: report no movement"
		}`
	)
}

/*
 * TURN-LEVEL PAIRING, when the two runs asked the same questions.
 *
 * The event schedule is computed from the samples by a deterministic detector, so two runs of one
 * game usually raise the identical turns — and when they do, `(windowId, index)` names ONE question
 * that both coaches answered, which is a far tighter pairing than the game.
 *
 * It is checked rather than assumed, and it is checked against the RUN files, not the judged ones.
 * A judged file lists only the turns somebody SPOKE on, so a turn present in one schedule and
 * absent from the other is indistinguishable there from a turn both were asked and one passed on —
 * and taking the union of spoken lines as the question set is how a 17-game run "wins" 650 turns
 * against a 28-game one. The intersection of the two SCHEDULES is the only honest question set.
 *
 * A turn nobody spoke on is a concordant "neither" and contributes nothing to McNemar. Silence is
 * scored as neither useful nor false, which is what the player hears.
 */
interface Line {
	arm?: string
	windowId: string
	index: number
	clock: string
	verdict: string
}
interface Record_ {
	arm: string
	windowId: string
	index: number
	clock: string
}
const judged = (path: string) => JSON.parse(readFileSync(path, "utf8")) as { of: string; lines: Line[] }
const key = (l: { windowId: string; index: number }): string => `${l.windowId}@${l.index}`

const askedOf = (judgedPath: string): Map<string, string> => {
	const runPath = judged(judgedPath).of
	const run = JSON.parse(readFileSync(runPath, "utf8")) as { records: Record_[] }
	return new Map(run.records.filter(r => r.arm === armWanted).map(r => [key(r), r.clock]))
}

const spokenOf = (judgedPath: string): Map<string, Line> =>
	new Map(
		judged(judgedPath)
			.lines.filter(l => l.arm === undefined || l.arm === armWanted)
			.map(l => [key(l), l])
	)

console.log("")
try {
	const askedNow = askedOf(nowPath)
	const askedBefore = askedOf(beforePath)
	const asked = [...askedNow.keys()].filter(k => askedBefore.has(k))
	const clash = asked.filter(k => askedNow.get(k) !== askedBefore.get(k))
	const lNow = spokenOf(nowPath)
	const lBefore = spokenOf(beforePath)
	if (asked.length === 0) console.log("TURN-LEVEL PAIRING SKIPPED — the two runs share no turn id at all.")
	else if (clash.length > 0)
		console.log(
			`TURN-LEVEL PAIRING SUPPRESSED — ${clash.length} of ${asked.length} shared turn ids sit at different clocks in the two runs, so the schedules are not the same questions.`
		)
	else {
		const cell = (pick: (v: string | undefined) => boolean) => {
			const aOnly = asked.filter(k => pick(lNow.get(k)?.verdict) && !pick(lBefore.get(k)?.verdict)).length
			const bOnly = asked.filter(k => !pick(lNow.get(k)?.verdict) && pick(lBefore.get(k)?.verdict)).length
			return { aOnly, bOnly, p: mcnemarExact(aOnly, bOnly) }
		}
		const u = cell(v => v === "useful")
		const f = cell(v => v === "false")
		console.log(
			`TURN-LEVEL — the same question asked twice: ${asked.length} turn(s) in both schedules (of ${askedNow.size} now, ${askedBefore.size} before); silence counts as neither`
		)
		console.log(`  USEFUL: ${u.aOnly} turns useful only NOW, ${u.bOnly} only BEFORE, McNemar exact p=${u.p.toFixed(4)}`)
		console.log(`  FALSE:  ${f.aOnly} turns false only NOW, ${f.bOnly} only BEFORE, McNemar exact p=${f.p.toFixed(4)}`)
		console.log(
			"  Turns inside one game are not independent — the arm is fed its own previous lines — so this p is anti-conservative beside the game-level sign test above."
		)
	}
} catch (e) {
	console.log(`TURN-LEVEL PAIRING SKIPPED — ${e instanceof Error ? e.message : String(e)}`)
}

const out = arg("out", "")
if (out !== "") {
	writeFileSync(
		out,
		`${JSON.stringify(
			{
				ranAt: new Date().toISOString(),
				now: nowPath,
				before: beforePath,
				arm: armWanted,
				floors: { useful: floorUseful, false: floorFalse },
				sharedGames: shared.length,
				onlyNow,
				onlyBefore,
				rows,
				tests
			},
			null,
			2
		)}\n`
	)
	console.log(`\nwrote ${out}`)
}
