/**
 * WHY THE RANKER IS QUIET — every fact it built, and what stopped it.
 *
 *     node --experimental-strip-types scripts/measure-starve.ts
 *     node --experimental-strip-types scripts/measure-starve.ts --turn 20 --out data/eval/starve.json
 *
 * ## Why this exists
 *
 * Three blind judges on three models converged on the same finding: the lines `buildFacts` ranks
 * are several times more useful per line than anything else in the block, and it offers one on
 * roughly a tenth of turns. "It is starved" was as far as the evidence went, because the function
 * returns what it offers and says nothing at all about what it built and threw away — so a
 * threshold that never fired and a floor that withheld a real line are the same observation.
 *
 * This replays the four recorded games through the daemon's OWN path — the same
 * `buildLiveStateForBench` the retirement measurement uses, one module instance per game so game
 * one's rate limits do not leak into game two — with `FactOptions.trace` attached, and counts:
 *
 *   - turns where the ranked list was non-empty, which is the number under discussion;
 *   - every fact BUILT, by subject, whether or not it was offered;
 *   - for every fact not offered, the RULE that stopped it.
 *
 * The last column is the whole point. A subject that never appears was never built and its
 * threshold is the thing to look at; a subject that is built forty times and offered twice is
 * being eaten by a floor, and the floor is named.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { DATA_DIR } from "../src/shared/constants.ts"
import type { FactTrace } from "../src/analysis/live-facts.ts"
import type { VisionState } from "../src/shared/live-state.ts"
import { baselineFromRows, perGameMetrics } from "../src/analysis/index.ts"
import { loadCorpus } from "../src/daemon/corpus.ts"

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}

interface Row extends FactTrace {
	game: string
	atSec: number
}

const main = async (): Promise<void> => {
	const turnSec = Number(arg("turn", "20"))
	const out = arg("out", "")
	const dir = `${DATA_DIR}/live-samples`
	const games = readdirSync(dir)
		.filter(f => /^split-\d+\.ndjson$/.test(f))
		.sort()

	const rows: Row[] = []
	let turns = 0
	let speakingTurns = 0
	const perGame: Record<string, unknown>[] = []

	for (const file of games) {
		const game = file.replace(".ndjson", "")
		const mod = (await import(
			`../src/server/routes/live.ts?starve=${game}`
		)) as typeof import("../src/server/routes/live.ts")
		const samples = readFileSync(`${dir}/${file}`, "utf8")
			.split("\n")
			.filter(l => l.trim() !== "")
			.map(l => JSON.parse(l) as { atMs: number; gameTime: number; data: unknown })

		const startedMs = samples[0]?.atMs ?? 0
		const corpus = loadCorpus(200)
			.filter(e => startedMs === 0 || Number(e.row.gameCreationMs) < startedMs)
			.slice(0, 20)
		const baseline = corpus.length > 0 ? baselineFromRows(perGameMetrics(corpus)) : null

		let mineTurns = 0
		let mineSpeaking = 0
		let last = -1e9
		for (const row of samples) {
			if (row.gameTime - last < turnSec) continue
			last = row.gameTime
			const here: Row[] = []
			const state: VisionState | null = mod.buildLiveStateForBench(row.data, row.gameTime, baseline, {
				trace: (rec: FactTrace) => here.push({ ...rec, game, atSec: row.gameTime })
			})
			if (!state) continue
			turns++
			mineTurns++
			if (state.unseen.length > 0) {
				speakingTurns++
				mineSpeaking++
			}
			rows.push(...here)
		}
		perGame.push({
			game,
			turns: mineTurns,
			speaking: mineSpeaking,
			built: rows.filter(r => r.game === game).length,
			offered: rows.filter(r => r.game === game && r.reason === null).length,
			baselineGames: corpus.length
		})
	}

	console.log(
		`## ${rows.length} facts BUILT over ${turns} turns of ${games.length} games at ${turnSec}s turns\n`
	)
	console.log(
		`  the ranked list was non-empty on ${speakingTurns} of ${turns} turns — ${(
			(100 * speakingTurns) /
			Math.max(1, turns)
		).toFixed(1)}%\n`
	)
	console.log(`  ${"game".padEnd(9)} ${"turns".padStart(5)} ${"speaking".padStart(8)} ${"built".padStart(5)} ${"offered".padStart(7)} ${"baseline".padStart(8)}`)
	for (const g of perGame)
		console.log(
			`  ${String(g.game).padEnd(9)} ${String(g.turns).padStart(5)} ${String(g.speaking).padStart(8)} ${String(
				g.built
			).padStart(5)} ${String(g.offered).padStart(7)} ${String(g.baselineGames).padStart(8)}`
		)

	console.log("\n## every subject: built, offered, and what stopped the rest\n")
	const subjects = [...new Set(rows.map(r => r.subject))].sort()
	const reasons = [...new Set(rows.map(r => r.reason).filter((r): r is string => r !== null))].sort()
	console.log(`  ${"subject".padEnd(15)} ${"built".padStart(5)} ${"offer".padStart(5)}  ${reasons.map(r => r.padStart(12)).join(" ")}`)
	for (const s of subjects) {
		const mine = rows.filter(r => r.subject === s)
		console.log(
			`  ${s.padEnd(15)} ${String(mine.length).padStart(5)} ${String(
				mine.filter(r => r.reason === null).length
			).padStart(5)}  ${reasons
				.map(r => String(mine.filter(x => x.reason === r).length || "").padStart(12))
				.join(" ")}`
		)
	}
	const all = rows
	console.log(
		`  ${"TOTAL".padEnd(15)} ${String(all.length).padStart(5)} ${String(
			all.filter(r => r.reason === null).length
		).padStart(5)}  ${reasons.map(r => String(all.filter(x => x.reason === r).length).padStart(12)).join(" ")}`
	)

	if (out !== "") {
		if (!existsSync(`${DATA_DIR}/eval`)) mkdirSync(`${DATA_DIR}/eval`, { recursive: true })
		writeFileSync(out, JSON.stringify({ turnSec, turns, speakingTurns, perGame, rows }, null, "\t"))
		console.log(`\nwrote ${out}`)
	}
}

if (import.meta.main) await main()
