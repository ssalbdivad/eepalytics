/**
 * blind-judge — hand an ablation's spoken lines to a human judge with the arm labels stripped.
 *
 * ## Why this exists as a script rather than as a paragraph in a report
 *
 * Every percentage in this project so far has survived being green while the product was bad, and
 * the one instrument that has never lied is a person reading the sentences. But a person reading
 * sentences that are grouped by arm is not judging the sentences, he is judging the arm — the
 * label does the work, and the fifty lines under the heading he already believes in read better
 * than the fifty under the one he does not.
 *
 * So this shuffles every spoken line into one flat list, gives each an opaque id, and prints the
 * evidence needed to check it — the clock, the player's own line, the enemy jungler's line, who is
 * down, the scoreboard, what just happened, and whatever the ranker offered. The key from id back
 * to arm is written to a SEPARATE file that the judging pass does not open.
 *
 * `--reveal <key> <verdicts>` joins the two back up afterwards and prints the per-arm rates with
 * Wilson intervals, so the join is done by code and cannot be done by wishful reading.
 *
 * ## The four verdicts, and why they are these four
 *
 * They are the two tests in AGENTS.md turned into questions a reader can answer in five seconds:
 *
 *   `false`        it contradicts the block, or asserts something no channel in this app knows.
 *                  This is the only fatal one. It is what the whole citation rule exists to stop.
 *   `unverifiable` it may be true and nothing here can check it. Costs trust the same way.
 *   `generic`      true, checkable, and it would read identically in a different game or five
 *                  minutes earlier. The failure that is hardest to see in a rate, because every
 *                  mechanical check passes.
 *   `useful`       true, specific to this instant, and it names something to DO.
 *
 * Usage:
 *     node --experimental-strip-types scripts/blind-judge.ts <ablation.json> [--per-arm N] [--out-dir data/eval]
 *     node --experimental-strip-types scripts/blind-judge.ts --reveal <key.json> <verdicts.json>
 *
 * NODE ONLY. Reads a stored run; makes no network call and spends nothing.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { DATA_DIR } from "../src/shared/constants.ts"
import { wilson } from "../src/analysis/coach-score.ts"
import { shuffled } from "./lib/stats.ts"
import type { Interval } from "../src/analysis/coach-score.ts"

/* ==================================================================== sampling */

/**
 * The lines from a cell, capped per arm so a loud arm cannot buy itself a wider interval.
 *
 * Taken evenly across the cell rather than from the front: the first states of a game are the
 * quietest and the most alike, and a judge shown only those would be scoring the opening minute.
 */
export const evenly = <T,>(items: readonly T[], n: number): T[] => {
	if (items.length <= n) return [...items]
	const out: T[] = []
	for (let i = 0; i < n; i++) out.push(items[Math.floor((i * items.length) / n)]!)
	return out
}

/* ================================================================== the evidence */

/**
 * The part of the block a judge needs to check one sentence, and no more.
 *
 * The whole block is about forty lines and most of it is standing instruction. A judge given forty
 * lines per sentence reads none of them by the twentieth sentence, which is how a blind judging
 * pass quietly becomes a vibe check.
 */
export const evidenceOf = (block: string): string => {
	const keep: string[] = []
	let inList = false
	for (const raw of block.split("\n")) {
		const l = raw.trimEnd()
		if (l.startsWith("###")) {
			inList = /looking at|Ranked highest|Nothing/.test(l)
			if (inList) keep.push(l)
			continue
		}
		if (l.startsWith("**The ten champions")) inList = false
		if (inList && l.startsWith("- ")) keep.push(l)
		if (
			l.startsWith("Clock ") ||
			l.startsWith("You: ") ||
			l.startsWith("Enemy jungler right now:") ||
			l.startsWith("Farm baseline") ||
			l.startsWith("Your team:") ||
			l.startsWith("Enemy team:") ||
			l.startsWith("Alive right now:") ||
			l.startsWith("Down right now") ||
			l.startsWith("Just happened:") ||
			l.startsWith("Objectives")
		)
			keep.push(l)
	}
	return keep.join("\n")
}

/* ======================================================================= types */

export interface JudgeItem {
	id: string
	clock: string
	frame: boolean
	line: string
	evidence: string
}
export interface KeyRow {
	id: string
	arm: string
	set: string
	withFrame: boolean
	stateId: string
	clock: string
	line: string
	mechanicalFaults: string[]
}

export const VERDICTS = ["false", "unverifiable", "generic", "useful"] as const
export type Verdict = (typeof VERDICTS)[number]

/* ======================================================================= reveal */

export interface ArmVerdict {
	arm: string
	judged: number
	false: Interval
	unverifiable: Interval
	generic: Interval
	useful: Interval
	/**
	 * How many lines this arm was OFFERED, against the `judged` it got answers for.
	 *
	 * A human judging pass stops when he gets bored, and the tally silently dropped every line he
	 * had not filled in: 20 answers out of 60 offered printed as `judged 20` and four confident
	 * rates, with nothing on the page saying two thirds of the sheet was blank. Worse than a small
	 * n, because a judge who abandons a sheet does not abandon it at random — he answers the easy
	 * ones. The gap is now on the same row as the rates it qualifies.
	 */
	offered: number
}

export const tally = (key: readonly KeyRow[], verdicts: Record<string, Verdict>): ArmVerdict[] => {
	const arms = [...new Set(key.map(k => k.arm))]
	return arms.map(arm => {
		const offered = key.filter(k => k.arm === arm)
		const rows = offered.filter(k => verdicts[k.id] !== undefined)
		const n = rows.length
		const c = (v: Verdict) => rows.filter(r => verdicts[r.id] === v).length
		return {
			arm,
			judged: n,
			offered: offered.length,
			false: wilson(c("false"), n),
			unverifiable: wilson(c("unverifiable"), n),
			generic: wilson(c("generic"), n),
			useful: wilson(c("useful"), n)
		}
	})
}

/* ========================================================================= main */

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback
}

const pct = (i: Interval): string => `${(i.p * 100).toFixed(0)}% [${(i.lo * 100).toFixed(0)}–${(i.hi * 100).toFixed(0)}]`

const main = (): void => {
	if (argv[0] === "--reveal") {
		const key = JSON.parse(readFileSync(argv[1]!, "utf8")) as { seed: number; rows: KeyRow[] }
		const verdicts = JSON.parse(readFileSync(argv[2]!, "utf8")) as Record<string, Verdict>
		const rows = tally(key.rows, verdicts)
		console.log("arm             judged/offered  false          unverifiable   generic        useful")
		for (const r of rows)
			console.log(
				`${r.arm.padEnd(15)} ${`${r.judged}/${r.offered}`.padStart(14)}  ${pct(r.false).padEnd(14)} ${pct(r.unverifiable).padEnd(14)} ` +
					`${pct(r.generic).padEnd(14)} ${pct(r.useful)}`
			)
		const blank = rows.reduce((a, r) => a + (r.offered - r.judged), 0)
		if (blank > 0)
			console.log(
				`\n  ${blank} offered line(s) carry NO verdict and are excluded from every rate above. A part-judged\n` +
					`  sheet is not a small sample of a whole one: the lines a tired judge skips are the hard ones.`
			)
		return
	}

	const runPath = argv[0]
	if (!runPath || !existsSync(runPath)) throw new Error("usage: blind-judge.ts <ablation.json>")
	const run = JSON.parse(readFileSync(runPath, "utf8")) as {
		stamp: string
		cells: { set: string; arm: string; withFrame: boolean; turns: { stateId: string; clock: string; line: string; ok: boolean; silent: boolean; faults: string[] }[] }[]
		states: { paired: { id: string; block: string; blockNoList: string; blockShipped: string }[]; late: { id: string; block: string; blockNoList: string; blockShipped: string }[] }
		arms: { id: string; blockKind: string }[]
	}
	const perArm = Number(arg("per-arm", "40"))
	const outDir = arg("out-dir", `${DATA_DIR}/eval`)

	const blockOf = new Map<string, { full: string; stripped: string; shipped: string }>()
	for (const s of [...run.states.paired, ...run.states.late])
		blockOf.set(s.id, { full: s.block, stripped: s.blockNoList, shipped: s.blockShipped })
	const kindOf = new Map(run.arms.map(a => [a.id, a.blockKind]))

	const pool: (KeyRow & { evidence: string; frame: boolean })[] = []
	for (const arm of new Set(run.cells.map(c => c.arm))) {
		/*
		 * With-frame cells only for PAIRED. The blind half of the paired set exists to measure
		 * whether the picture moves the decision, not to double an arm's share of the judging.
		 */
		const cells = run.cells.filter(c => c.arm === arm && (c.set === "late" || c.withFrame))
		const spoken = cells.flatMap(c =>
			c.turns
				.filter(t => t.ok && !t.silent)
				.map(t => ({ cell: c, t }))
		)
		for (const { cell, t } of evenly(spoken, perArm)) {
			const kind = kindOf.get(arm) ?? "full"
			const blocks = blockOf.get(t.stateId)
			const block = kind === "shipped" ? blocks!.shipped : kind === "stripped" ? blocks!.stripped : blocks!.full
			pool.push({
				id: "",
				arm,
				set: cell.set,
				withFrame: cell.withFrame,
				stateId: t.stateId,
				clock: t.clock,
				line: t.line,
				mechanicalFaults: t.faults,
				evidence: evidenceOf(block),
				frame: cell.withFrame
			})
		}
	}

	const seed = 20260905
	const mixed = shuffled(pool, seed)
	mixed.forEach((r, i) => (r.id = `L${String(i + 1).padStart(3, "0")}`))

	const items: JudgeItem[] = mixed.map(r => ({ id: r.id, clock: r.clock, frame: r.frame, line: r.line, evidence: r.evidence }))
	const key = {
		seed,
		run: runPath,
		rows: mixed.map(({ id, arm, set, withFrame, stateId, clock, line, mechanicalFaults }) => ({
			id,
			arm,
			set,
			withFrame,
			stateId,
			clock,
			line,
			mechanicalFaults
		}))
	}

	const itemsPath = `${outDir}/blind-items-${run.stamp}.json`
	const keyPath = `${outDir}/blind-key-${run.stamp}.json`
	for (const p of [itemsPath, keyPath])
		if (existsSync(p)) throw new Error(`${p} exists — every measurement is kept, nothing is overwritten`)
	writeFileSync(itemsPath, `${JSON.stringify(items, null, 1)}\n`)
	writeFileSync(keyPath, `${JSON.stringify(key, null, 1)}\n`)
	console.log(`${items.length} lines, labels stripped, seed ${seed}`)
	console.log(`  judge these  ${itemsPath}`)
	console.log(`  do NOT open  ${keyPath}`)
}

if (import.meta.main) main()
