import { DatabaseSync } from "node:sqlite"
import { baselineFromRows, perGameMetrics } from "../src/analysis/index.ts"
import { loadCorpus } from "../src/daemon/corpus.ts"
import { readSamples } from "../src/daemon/live-sampler.ts"
import { buildLiveStateForBench } from "../src/server/routes/live.ts"
import { DB_PATH } from "../src/shared/constants.ts"

const db = new DatabaseSync(DB_PATH, { readOnly: true })
const createdMs = Number(
	(db.prepare("SELECT gameCreationMs FROM game WHERE gameId = ?").get(5635467422) as any)?.gameCreationMs ?? 0
)
db.close()
const corpus = loadCorpus(200).filter(e => createdMs === 0 || Number(e.row.gameCreationMs) < createdMs).slice(0, 20)
const baseline = corpus.length > 0 ? baselineFromRows(perGameMetrics(corpus)) : null

const samples = readSamples("split-03")
for (const s of samples) {
	const st = buildLiveStateForBench(s.data, s.gameTime, baseline)
	if (!st) continue
	const t = Math.round(s.gameTime)
	if (t >= 340 && t <= 430) console.log(t, s.gameTime, (st.unseen ?? []).length, JSON.stringify(st.unseen ?? []))
}
