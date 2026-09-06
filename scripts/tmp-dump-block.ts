import { DatabaseSync } from "node:sqlite"
import { DB_PATH } from "../src/shared/constants.ts"
import { baselineFromRows, perGameMetrics } from "../src/analysis/index.ts"
import { loadCorpus } from "../src/daemon/corpus.ts"
import { buildLiveStateForBench } from "../src/server/routes/live.ts"
import { readSamples } from "../src/daemon/live-sampler.ts"
import { renderBlockForMode } from "../src/shared/live-coach-mode.ts"
const want = process.argv.slice(2).map(Number)
const samples = readSamples("split-03")
const db = new DatabaseSync(DB_PATH, { readOnly: true })
const createdMs = Number((db.prepare("SELECT gameCreationMs FROM game WHERE gameId = ?").get(5635467422) as any)?.gameCreationMs ?? 0)
db.close()
const corpus = loadCorpus(200).filter(e => createdMs === 0 || Number(e.row.gameCreationMs) < createdMs).slice(0, 20)
const baseline = baselineFromRows(perGameMetrics(corpus))
for (const s of samples) {
	const st = buildLiveStateForBench(s.data, s.gameTime, baseline)
	if (!st) continue
	if (want.some(w => Math.abs(s.gameTime - w) < 3)) {
		console.log("======== t=", Math.round(s.gameTime))
		console.log(renderBlockForMode(st, "briefing"))
	}
}
