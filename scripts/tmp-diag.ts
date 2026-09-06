import { readFileSync, readdirSync } from "node:fs"
import { DATA_DIR } from "../src/shared/constants.ts"
import { baselineFromRows, perGameMetrics } from "../src/analysis/index.ts"
import { loadCorpus } from "../src/daemon/corpus.ts"

const dir = `${DATA_DIR}/live-samples`
const games = readdirSync(dir).filter(f => /^split-\d+\.ndjson$/.test(f)).sort()
let turns = 0, standing = 0, bodies = 0, both = 0
for (const file of games) {
	const mod = (await import(`../src/server/routes/live.ts?d=${file}`)) as typeof import("../src/server/routes/live.ts")
	const samples = readFileSync(`${dir}/${file}`, "utf8").split("\n").filter(l => l.trim() !== "").map(l => JSON.parse(l) as { atMs: number; gameTime: number; data: any })
	const startedMs = samples[0]?.atMs ?? 0
	const corpus = loadCorpus(200).filter(e => startedMs === 0 || Number(e.row.gameCreationMs) < startedMs).slice(0, 20)
	const baseline = corpus.length > 0 ? baselineFromRows(perGameMetrics(corpus)) : null
	let last = -1e9
	for (const row of samples) {
		if (row.gameTime - last < 20) continue
		last = row.gameTime
		const state = mod.buildLiveStateForBench(row.data, row.gameTime, baseline)
		if (!state) continue
		turns++
		const text = JSON.stringify(state)
		const hasStanding = /UP and untaken/.test(text)
		const d = row.data
		const me = (d.allPlayers ?? []).find((p: any) => p.summonerName === d.activePlayer?.summonerName || p.riotIdGameName === d.activePlayer?.riotIdGameName)
		const deadN = me ? (d.allPlayers ?? []).filter((p: any) => p.team !== me.team && p.isDead).length : 0
		const ej = me ? (d.allPlayers ?? []).some((p: any) => p.team !== me.team && p.isDead && (p.summonerSpells?.summonerSpellOne?.displayName === "Smite" || p.summonerSpells?.summonerSpellTwo?.displayName === "Smite")) : false
		const hasBodies = ej || deadN >= 2
		if (hasStanding) standing++
		if (hasBodies) bodies++
		if (hasStanding && hasBodies) both++
	}
}
console.log({ turns, standing, bodies, both })
