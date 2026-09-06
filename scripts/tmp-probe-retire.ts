import { DatabaseSync } from "node:sqlite"
import { DB_PATH } from "../src/shared/constants.ts"
import { baselineFromRows, perGameMetrics } from "../src/analysis/index.ts"
import { loadCorpus } from "../src/daemon/corpus.ts"
import { buildLiveStateForBench } from "../src/server/routes/live.ts"
import { readSamples } from "../src/daemon/live-sampler.ts"
import { renderBlockForMode } from "../src/shared/live-coach-mode.ts"

const cadence = Number(process.argv[2] ?? "0")
const samples = readSamples("split-03")
const db = new DatabaseSync(DB_PATH, { readOnly: true })
const createdMs = Number((db.prepare("SELECT gameCreationMs FROM game WHERE gameId = ?").get(5635467422) as any)?.gameCreationMs ?? 0)
db.close()
const corpus = loadCorpus(200).filter(e => createdMs === 0 || Number(e.row.gameCreationMs) < createdMs).slice(0, 20)
const baseline = corpus.length > 0 ? baselineFromRows(perGameMetrics(corpus)) : null
console.log("baseline?", baseline !== null, "corpus", corpus.length)

let use = samples
if (cadence > 0) {
	const picked: typeof samples = []
	const end = samples[samples.length - 1]!.gameTime
	const taken = new Set<number>()
	for (let mark = 0; mark <= end; mark += cadence) {
		let best = -1, bestSkew = Infinity
		for (let i = 0; i < samples.length; i++) {
			if (taken.has(i)) continue
			const s = Math.abs(samples[i]!.gameTime - mark)
			if (s < bestSkew) { bestSkew = s; best = i }
		}
		if (best >= 0 && bestSkew <= cadence / 2) { taken.add(best); picked.push(samples[best]!) }
	}
	use = picked
}
let n = 0
for (const s of use) {
	const st = buildLiveStateForBench(s.data, s.gameTime, baseline)
	if (!st) continue
	const b = renderBlockForMode(st, "briefing")
	const mark = Math.round(s.gameTime)
	if (cadence > 0 || mark % 20 < 6) {
		const live = (b.match(/^- .*$/gm) ?? []).length
		const covered = b.includes("Already covered")
		if (n++ % 5 === 0) console.log(String(Math.floor(mark/60)) + ":" + String(mark%60).padStart(2,"0"), "listLines", live, "covered", covered, "len", b.length)
	}
}
