/**
 * Is the coach's own line still TRUE when its last syllable lands?
 *
 *     node --experimental-strip-types scripts/measure-staleness.ts
 *     node --experimental-strip-types scripts/measure-staleness.ts --latencies 0,1,5,9 --out data/eval/staleness.json
 *
 * ## Why this file exists
 *
 * `analysis/timeliness.ts` is the arithmetic and it has unit tests; this is the DRIVER that points
 * it at four real recorded games so a change to `analysis/live-facts.ts` can be reported as a
 * before/after rather than argued. Nothing here reimplements the ranker: the lines come from
 * `buildLiveStateForBench` -> `buildLiveState` -> `buildFacts`, which is the daemon's own path, and
 * the states they are checked against come from the raw samples through `coachStateFrom`, which is
 * NOT the ranker's own view of the world — checking the ranker against itself would prove nothing.
 *
 * One module instance per game, by import query, because `routes/live.ts` keeps its fact memory at
 * module scope: replaying four games through one import carries game one's rate limits into game
 * two. Same trick and same reason as `scripts/probe-attention.ts`.
 *
 * ## The grouping, and why there are two of them
 *
 * `tier` is what `live-facts.ts` acts on — it is the field the turn-provider gate reads — so the
 * table is grouped by it. `premise` is what `timeliness.ts` can recover from a rendered sentence,
 * and the two are printed side by side deliberately: the gate is only defensible if the tier it
 * filters on lines up with the shape that actually goes stale.
 *
 * `unknown` verdicts are EXCLUDED from every denominator, never counted fresh. A premise this
 * harness cannot parse, or a t_end with no sample within six seconds, is an unmeasured line.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { DATA_DIR } from "../src/shared/constants.ts"
import { coachStateFrom } from "./eval-useful.ts"
import { premiseOf, speechDurationSec, stalenessOf, stateAt } from "../src/analysis/timeliness.ts"
import type { CoachState, PremiseKind, StaleKind } from "../src/analysis/timeliness.ts"

/**
 * Wilson, because every rate here is a proportion on a few dozen trials and reads as stronger than
 * it is. Copied from `scripts/probe-attention.ts` rather than imported: that file runs its `main`
 * on import, so importing one helper from it starts a different measurement.
 */
const wilson = (k: number, n: number): string => {
	if (n === 0) return "n/a"
	const p = k / n
	const z = 1.96
	const d = 1 + (z * z) / n
	const centre = (p + (z * z) / (2 * n)) / d
	const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
	return `${(100 * p).toFixed(1)}% [${(100 * Math.max(0, centre - half)).toFixed(0)}, ${(100 * Math.min(1, centre + half)).toFixed(0)}]`
}

/** The shipped middle turn cadence, the same one every other replay in this repo uses. */
const TURN_SEC = 20

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}

/**
 * Which `FactTier` a rendered line was built as.
 *
 * Recovered from the premise rather than carried on the string, because a transcript is a list of
 * strings and this harness must be pointable at one. The map is the one `live-facts.ts` writes:
 * the two objective-loss tiers split on the objective, and a level gap is `expiring` only in its
 * restraint form, which is the variant that exists because an objective is live.
 */
const tierOfLine = (text: string): "interrupt" | "expiring" | "standing" => {
	const p = premiseOf(text)
	switch (p.kind) {
		case "window":
		case "jungler-down":
		case "objective-timer":
			return "expiring"
		case "levels":
			return p.restraint ? "expiring" : "standing"
		case "objective-lost":
			return p.name === "DragonKill" ? "expiring" : "interrupt"
		case "fight":
			return "interrupt"
		default:
			return "standing"
	}
}

/** The task's own split: a fact about a THING THAT HAPPENED against a fact about how the game stands. */
const EVENT_SHAPED = new Set<PremiseKind>(["window", "jungler-down", "fight"])

interface Line {
	game: string
	atSec: number
	text: string
	tier: "interrupt" | "expiring" | "standing"
	premise: PremiseKind
	spokenSec: number
}

const main = async (): Promise<void> => {
	const latencies = arg("latencies", "0,1,5,9").split(",").map(Number)
	const out = arg("out", "")
	const dir = `${DATA_DIR}/live-samples`
	const games = readdirSync(dir).filter(f => /^split-\d+\.ndjson$/.test(f)).sort()

	const lines: Line[] = []
	const statesByGame = new Map<string, CoachState[]>()

	for (const file of games) {
		const game = file.replace(".ndjson", "")
		const mod = (await import(
			`../src/server/routes/live.ts?staleness=${game}`
		)) as typeof import("../src/server/routes/live.ts")
		const rows = readFileSync(`${dir}/${file}`, "utf8")
			.split("\n")
			.filter(l => l.trim() !== "")
			.map(l => JSON.parse(l) as { atMs: number; gameTime: number; data: unknown })
		const states: CoachState[] = []
		for (const row of rows) {
			const s = coachStateFrom(row)
			if (s) states.push(s)
		}
		statesByGame.set(game, states)
		let last = -1e9
		for (const row of rows) {
			if (row.gameTime - last < TURN_SEC) continue
			last = row.gameTime
			const state = mod.buildLiveStateForBench(row.data, row.gameTime)
			if (!state) continue
			for (const text of state.unseen)
				lines.push({
					game,
					atSec: row.gameTime,
					text,
					tier: tierOfLine(text),
					premise: premiseOf(text).kind,
					spokenSec: speechDurationSec(text)
				})
		}
	}

	console.log(
		`## ${lines.length} lines offered over ${games.length} games at ${TURN_SEC}s, median sentence ${median(
			lines.map(l => l.spokenSec)
		).toFixed(2)}s\n`
	)

	const rows: Record<string, unknown>[] = []
	for (const latencySec of latencies) {
		const verdicts = lines.map(l => {
			const states = statesByGame.get(l.game)!
			const atT = stateAt(states, l.atSec, 6)
			const endSec = l.atSec + latencySec + l.spokenSec
			const v =
				atT === null ?
					null
				:	stalenessOf({ text: l.text, atSec: l.atSec, latencySec }, atT, stateAt(states, endSec, 6))
			return { line: l, v }
		})
		for (const { line, v } of verdicts)
			rows.push({
				game: line.game,
				atSec: line.atSec,
				latencySec,
				text: line.text,
				tier: line.tier,
				premise: line.premise,
				spokenSec: line.spokenSec,
				kind: v?.kind ?? "unknown",
				why: v?.why ?? "no state at t"
			})

		const rate = (label: string, keep: (l: Line) => boolean): void => {
			const scored = verdicts.filter(x => keep(x.line) && x.v !== null && x.v.kind !== "unknown")
			const stale = scored.filter(x => x.v!.stale)
			const impossible = scored.filter(x => x.v!.kind === "impossible")
			console.log(
				`  ${label.padEnd(16)} stale ${String(stale.length).padStart(3)}/${String(scored.length).padEnd(3)} ${wilson(
					stale.length,
					scored.length
				)}   impossible ${impossible.length}`
			)
		}
		console.log(`latency ${latencySec}s`)
		rate("all", () => true)
		rate("expiring", l => l.tier === "expiring")
		rate("interrupt", l => l.tier === "interrupt")
		rate("standing", l => l.tier === "standing")
		rate("event-shaped", l => EVENT_SHAPED.has(l.premise))
		rate("state-shaped", l => !EVENT_SHAPED.has(l.premise))
		for (const p of [...new Set(lines.map(l => l.premise))].sort())
			rate(`  ${p}`, l => l.premise === p)
		console.log("")
	}

	// Every stale verdict, quoted, because a rate hides the sentence that caused it.
	const worst = rows.filter(r => r.kind === "impossible" || r.kind === "situation-over" || r.kind === "number-moved")
	console.log(`## ${worst.length} stale verdicts across all latencies\n`)
	for (const r of worst.slice(0, 60))
		console.log(`  ${String(r.latencySec).padStart(2)}s ${String(r.kind).padEnd(15)} ${String(r.text).slice(0, 70).padEnd(72)} ${r.why}`)

	if (out !== "") {
		if (!existsSync(`${DATA_DIR}/eval`)) mkdirSync(`${DATA_DIR}/eval`, { recursive: true })
		writeFileSync(out, JSON.stringify({ turnSec: TURN_SEC, latencies, rows }, null, "\t"))
		console.log(`\nwrote ${out}`)
	}
}

const median = (xs: number[]): number => {
	if (xs.length === 0) return 0
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.floor(s.length / 2)]!
}

if (import.meta.main) await main()
