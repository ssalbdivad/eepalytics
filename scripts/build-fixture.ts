/**
 * Freeze one real game into a replayable fixture: `data/eval/fixture-<gameId>.json`.
 *
 * ## Why this exists
 *
 * The live coach has been tried about ten times and it is still bad, and nothing on disk could
 * say *why*. `scripts/bench-providers.ts` reads ONE JPEG and pairs it with every state it
 * replays — it prints "THE SAME FRAME FOR EVERY STATE" — and scores the answers with a fault
 * detector that asks "did you break a rule", never "was this right". Under that instrument a
 * model that ignores the picture scores the same as one that reads it perfectly, and a model
 * that actually *uses* the picture scores WORSE, because the picture is of a different moment
 * than the block it arrives with.
 *
 * This builds the missing half: a frozen sequence of instants where the FRAME and the RAW
 * CLIENT DATA are from the same second of the same game, so an answer can be judged against
 * what was actually on screen.
 *
 * ## The join
 *
 * Two independent recordings survive for game 5635467422:
 *
 *   - `data/live-samples/split-03.ndjson` — 363 verbatim `allgamedata` reads, ~6.1s apart,
 *     covering the whole 36:49.
 *   - `journal_frame` — the JPEGs the page actually uploaded, ~5s apart, with the file on disk.
 *
 * Both carry wall-clock `atMs`, so they can be joined. Only 43 frames fall inside this game
 * (0:02 to 6:43); the rest of the frames on disk belong to other games, and the 503 rows whose
 * JPEG is missing were written under the pre-rename path, which is gone. There are no replays
 * left either — they expire ~30 minutes after the game — so this window cannot be widened. It
 * is the only window in the database where a real frame and real raw data exist for the same
 * instant, and it is not sampled down for that reason.
 *
 * A frame from a different moment is the exact defect this fixture exists to eliminate, so a
 * pairing worse than `--max-skew` seconds is DROPPED rather than shipped with a caveat.
 *
 * ## Why the block is re-rendered rather than read back
 *
 * `journal_frame.truthJson` holds the block as it was sent at the time — and it was rendered by
 * code with a measured bug: `championOf` matched on `riotId`/`summonerName` while the event feed
 * sends the BARE game name, so 0 of 131 kills in this game ever resolved to a champion. Every
 * fight reached the model as unmappable proper nouns. Using the stored block would freeze that
 * bug into the fixture and make the fix unmeasurable.
 *
 * So every block here is re-rendered from the raw sample through the SHIPPED path —
 * `buildLiveStateForBench` then `renderState` — and the stored one is carried alongside as
 * `storedBlock` so the difference is visible rather than asserted.
 *
 * The whole sample stream is replayed in order, not just the checkpoints, because the fact list
 * is rate-limited through module-level memory (each death announced once, gold once per 800g,
 * farm once per three minutes). Building only the checkpoints would produce blocks whose
 * `unseen` list nobody would ever have seen.
 *
 * ## Usage
 *
 *     node --experimental-strip-types scripts/build-fixture.ts
 *     node --experimental-strip-types scripts/build-fixture.ts \
 *       --samples data/live-samples/split-03.ndjson --game 5635467422 --spacing 30
 *
 *     --samples <path>    the verbatim ndjson to freeze
 *     --game <id>         the match id these samples belong to (the samples do not carry one)
 *     --out <path>        default data/eval/fixture-<gameId>.json
 *     --max-skew <sec>    drop a frame/sample pairing worse than this (default 3)
 *     --spacing <sec>     frame-less checkpoint spacing across the rest of the game (default 30)
 *     --print <n>         print n complete checkpoints at the end (default 3)
 *
 * Touches no League API and no LCU endpoint. Reads the database read-only.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DATA_DIR, DB_PATH } from "../src/shared/constants.ts"
import { renderState } from "../src/shared/live-state.ts"
import { buildLiveStateForBench } from "../src/server/routes/live.ts"
import { baselineFromRows, perGameMetrics } from "../src/analysis/index.ts"
import { loadCorpus } from "../src/daemon/corpus.ts"

/* ------------------------------------------------------------------ arguments */

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}

const SAMPLES = arg("samples", `${DATA_DIR}/live-samples/split-03.ndjson`)
const GAME_ID = arg("game", "5635467422")
const OUT = arg("out", `${DATA_DIR}/eval/fixture-${GAME_ID}.json`)
const MAX_SKEW_SEC = Number(arg("max-skew", "3"))
const SPACING_SEC = Number(arg("spacing", "30"))
const PRINT_N = Number(arg("print", "3"))

/**
 * Frames that do NOT show the game, by journal_frame id.
 *
 * He shares a whole monitor rather than the League window, so a frame can legitimately be his
 * desktop, a browser, or the post-game screen — and such a frame is worse than no frame, because
 * the judge would be asking a coach to react to a picture of nothing.
 *
 * This list is filled by EYE, not by code. 19 of the 43 frames in this game's window were opened
 * and looked at while building the fixture, chosen to span it end to end (0:02, 0:37, 0:52, 1:22,
 * 1:37, 1:42, 2:22, 2:42, 3:02, 3:07, 3:32, 3:47, 4:12, 4:32, 4:52, 5:33, 6:08, 6:18, 6:43) and to
 * include the byte-size extremes, since a desktop or browser screenshot would compress nothing
 * like a League frame. Every one was the League client mid-game at 1536x864 with the HUD, the
 * scoreboard, the chat log and the minimap all legible, and the in-game clock in the top right
 * matched the row's `tSec` at every one. The other 24 sit inside that continuous in-game stretch,
 * never more than ~10s from an inspected neighbour, at 98-211 KB like the rest.
 *
 * So the list is empty because nothing suspect was found, not because nothing was checked. Add an
 * id here if a future capture shows a desktop, a browser or the post-game screen — such a frame is
 * WORSE than no frame, because it asks a coach to react to a picture of nothing.
 */
const FRAME_NOT_GAME = new Set<string>([])

/* ------------------------------------------------------------------- the raw stream */

interface Sample {
	/** 1-based line number in the ndjson, so a checkpoint points at bytes a human can go read. */
	line: number
	atMs: number
	gameTime: number
	data: unknown
}

const readVerbatim = (path: string): Sample[] => {
	const out: Sample[] = []
	const lines = readFileSync(path, "utf8").split("\n")
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!
		if (raw.trim() === "") continue
		try {
			const o = JSON.parse(raw) as { atMs: number; gameTime: number; data: unknown }
			out.push({ line: i + 1, atMs: o.atMs, gameTime: o.gameTime, data: o.data })
		} catch {
			// The tail of a killed daemon. Everything before it is still good.
		}
	}
	return out
}

const samples = readVerbatim(SAMPLES)
if (samples.length === 0) throw new Error(`no samples in ${SAMPLES}`)

const clockOf = (sec: number): string =>
	`${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`

/* ------------------------------------------------------------------- the baseline */

/*
 * His rolling farm average, as the daemon would have had it DURING this game.
 *
 * Games created after this one are excluded, not only this game itself: the corpus on disk has
 * since grown a newer game, and letting the future set the average would make the fixture's
 * `Farm baseline:` line a number that never existed at the time.
 *
 * This line matters more than it looks. `pace` is the only baseline in the block, and a missing
 * one was measured to be an invitation: asked "how am I doing" with no baseline, the coach
 * invented one in 2 of 5 answers. A fixture that always says NONE would never exercise the
 * failure the app most needs to catch.
 */
const db = new DatabaseSync(DB_PATH, { readOnly: true })
const createdMs = Number(
	(db.prepare("SELECT gameCreationMs FROM game WHERE gameId = ?").get(Number(GAME_ID)) as
		| { gameCreationMs: number | bigint }
		| undefined
	)?.gameCreationMs ?? 0
)
db.close()

const corpus = loadCorpus(200)
	.filter(e => createdMs === 0 || Number(e.row.gameCreationMs) < createdMs)
	.slice(0, 20)
const baseline = corpus.length > 0 ? baselineFromRows(perGameMetrics(corpus)) : null

/* ------------------------------------------------------------------- replay */

/*
 * Every sample, in order, through the shipped builder — the whole stream, not the checkpoints.
 * The fact list carries memory (a death is announced once, gold once per 800g), so a block built
 * out of sequence is a block nobody would ever have been shown.
 */
const blocks = new Map<number, string>()
for (const s of samples) {
	const state = buildLiveStateForBench(s.data, s.gameTime, baseline)
	if (!state) continue
	blocks.set(s.line, renderState(state))
}

/* ------------------------------------------------------------------- frames */

interface FrameRow {
	id: string
	path: string
	atMs: number
	tSec: number
	truthJson: string | null
	bytes: number
}

const firstMs = samples[0]!.atMs
const lastMs = samples[samples.length - 1]!.atMs
const fdb = new DatabaseSync(DB_PATH, { readOnly: true })
const frameRows = (
	fdb
		.prepare("SELECT id, path, atMs, tSec, truthJson, bytes FROM journal_frame WHERE atMs BETWEEN ? AND ? ORDER BY atMs")
		.all(firstMs - MAX_SKEW_SEC * 1000, lastMs + MAX_SKEW_SEC * 1000) as unknown[]
).map(r => {
	const row = r as Record<string, unknown>
	return {
		id: String(row.id),
		path: String(row.path),
		atMs: Number(row.atMs),
		tSec: Number(row.tSec),
		truthJson: row.truthJson === null ? null : String(row.truthJson),
		bytes: Number(row.bytes)
	} satisfies FrameRow
})
fdb.close()

const nearest = (atMs: number): Sample => {
	let best = samples[0]!
	let bestD = Math.abs(best.atMs - atMs)
	for (const s of samples) {
		const d = Math.abs(s.atMs - atMs)
		if (d < bestD) {
			bestD = d
			best = s
		}
	}
	return best
}

/* ------------------------------------------------------------------- checkpoints */

interface Checkpoint {
	id: string
	tSec: number
	clock: string
	sampleLine: number
	framePath: string | null
	frameSkewSec: number | null
	/** Null when there is no frame in this corpus that shows the game at this instant. */
	frameShowsGame: boolean | null
	block: string
	/** `truthJson` as it was actually sent, or null when no frame is paired here. */
	storedBlock: string | null
}

const checkpoints: Checkpoint[] = []
const claimedLines = new Set<number>()
const dropped: { id: string; why: string; skewSec?: number }[] = []

/*
 * Frame-bearing checkpoints first, and ALL of them: this is the entire visual corpus that
 * survives, 43 instants out of a 36:49 game, and a fixture that samples it down throws away the
 * only evidence about whether the coach reads a picture at all.
 */
for (const f of frameRows) {
	if (!existsSync(f.path)) {
		dropped.push({ id: f.id, why: "jpeg missing from disk (pre-rename path)" })
		continue
	}
	const s = nearest(f.atMs)
	const skew = Math.abs(s.atMs - f.atMs) / 1000
	if (skew > MAX_SKEW_SEC) {
		dropped.push({ id: f.id, why: `frame/sample skew ${skew.toFixed(2)}s over the ${MAX_SKEW_SEC}s gate`, skewSec: +skew.toFixed(2) })
		continue
	}
	const block = blocks.get(s.line)
	if (block === undefined) {
		dropped.push({ id: f.id, why: "no state could be built from the paired sample" })
		continue
	}
	const tSec = Math.round(f.tSec)
	checkpoints.push({
		id: `cp-${String(tSec).padStart(4, "0")}`,
		tSec,
		clock: clockOf(tSec),
		sampleLine: s.line,
		framePath: f.path,
		frameSkewSec: +skew.toFixed(2),
		frameShowsGame: !FRAME_NOT_GAME.has(f.id),
		block,
		storedBlock: f.truthJson === null || f.truthJson === "null" ? null : f.truthJson
	})
	claimedLines.add(s.line)
}

/*
 * Then the rest of the game, which has raw data and no pixels at all.
 *
 * Two kinds, because even spacing alone would miss the moments and the moments alone would hide
 * the long quiet stretches where the coach's real failure is talking anyway:
 *
 *   - the first sample AFTER each objective, ace, inhibitor and each kill involving him, so the
 *     block's "Just happened" line actually carries the event a judge would expect a word about;
 *   - one every `--spacing` seconds otherwise, so the whole 36:49 arc is represented.
 *
 * A candidate whose sample is already claimed by a frame checkpoint is skipped rather than
 * duplicated — inside the frame window the picture-bearing checkpoint is strictly better.
 */
const ME = "Gooskaffur"
const lastEvents =
	((samples[samples.length - 1]!.data as { events?: { Events?: Record<string, unknown>[] } }).events?.Events ?? [])

const eventTimes: number[] = []
for (const e of lastEvents) {
	const name = String(e.EventName ?? "")
	const t = Number(e.EventTime ?? -1)
	if (t < 0) continue
	const big = name === "DragonKill" || name === "BaronKill" || name === "HeraldKill" ||
		name === "InhibKilled" || name === "Ace" || name === "FirstBlood"
	const mine = name === "ChampionKill" &&
		(e.KillerName === ME || e.VictimName === ME || (Array.isArray(e.Assisters) && e.Assisters.includes(ME)))
	if (big || mine) eventTimes.push(t)
}

const candidates = new Map<number, string>()
for (const t of eventTimes) {
	const s = samples.find(x => x.gameTime >= t)
	if (s) candidates.set(s.line, "event")
}
let nextAt = 0
for (const s of samples) {
	if (s.gameTime + 0.001 < nextAt) continue
	if (!candidates.has(s.line)) candidates.set(s.line, "spacing")
	nextAt = s.gameTime + SPACING_SEC
}

for (const [line, why] of [...candidates].sort((a, b) => a[0] - b[0])) {
	if (claimedLines.has(line)) continue
	const block = blocks.get(line)
	if (block === undefined) {
		dropped.push({ id: `line-${line}`, why: `no state from sample (${why})` })
		continue
	}
	const s = samples.find(x => x.line === line)!
	const tSec = Math.round(s.gameTime)
	checkpoints.push({
		id: `cp-${String(tSec).padStart(4, "0")}`,
		tSec,
		clock: clockOf(tSec),
		sampleLine: line,
		framePath: null,
		frameSkewSec: null,
		frameShowsGame: null,
		block,
		storedBlock: null
	})
	claimedLines.add(line)
}

checkpoints.sort((a, b) => a.tSec - b.tSec)

const perLine = new Map<number, number>()
for (const c of checkpoints) perLine.set(c.sampleLine, (perLine.get(c.sampleLine) ?? 0) + 1)
const sharedSampleLines = [...perLine.values()].filter(n => n > 1).length

const ids = new Set(checkpoints.map(c => c.id))
if (ids.size !== checkpoints.length)
	throw new Error(`duplicate checkpoint ids: ${checkpoints.length} checkpoints, ${ids.size} ids`)

/* ------------------------------------------------------------------- write */

const withFrame = checkpoints.filter(c => c.framePath !== null)
const fixture = {
	gameId: GAME_ID,
	source: { samples: SAMPLES.replace(`${DATA_DIR}/`, "data/"), frameJoin: "atMs" },
	/*
	 * Everything a reader needs to trust the file without re-deriving it, including the things
	 * that are NOT 1:1 with a live game. A fixture that hides its own gaps is worse than one that
	 * names them, because it gets quoted.
	 */
	built: {
		atMs: Date.now(),
		samples: samples.length,
		checkpoints: checkpoints.length,
		withFrame: withFrame.length,
		withoutFrame: checkpoints.length - withFrame.length,
		maxSkewSec: MAX_SKEW_SEC,
		spacingSec: SPACING_SEC,
		framePixels: "1536x864",
		baselineGames: corpus.length,
		/** Checkpoints that share a sample line with another, because frames are denser than samples. */
		sharedSampleLines,
		dropped
	},
	notes: [
		"`block` is re-rendered from the raw sample through the shipped path (buildLiveStateForBench then renderState); `storedBlock` is what was actually sent at the time, by code whose championOf matched on riotId/summonerName and so resolved 0 of 131 kills in this game. Compare, do not substitute.",
		"The whole 363-sample stream is replayed in order to build these blocks, because the `unseen` fact list is rate-limited through memory. Blocks are not independently reproducible from a single line.",
		"`tSec` on a frame-bearing checkpoint is the FRAME's timestamp; the paired sample can be up to `frameSkewSec` seconds off, so the `Clock` line inside `block` may differ from `clock` by that much. That gap is recorded rather than smoothed over.",
		"Frames exist only from 0:02 to 6:43. There are no replays left for this game, so the visual corpus cannot be widened.",
		"19 of the 43 frames were opened and inspected by eye, spanning the window end to end and including the byte-size extremes; all show the League client mid-game at 1536x864 with the HUD, scoreboard, chat log and minimap legible, and none show a desktop, a browser or the post-game screen.",
		"Samples are ~6.1s apart and frames ~5s apart, so a few frames pair with the same sample. Those checkpoints carry the SAME block with a DIFFERENT picture taken ~5s apart — treat them as one state seen twice, not as two independent states."
	],
	checkpoints
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(fixture, null, "\t")}\n`)

/* ------------------------------------------------------------------- report */

console.log(`wrote ${OUT}`)
console.log(`  samples        ${samples.length} from ${SAMPLES}`)
console.log(`  baseline       ${corpus.length} games, all created before this one`)
console.log(`  checkpoints    ${checkpoints.length}  (${withFrame.length} with a frame, ${checkpoints.length - withFrame.length} without)`)
console.log(`  frame window   ${withFrame[0]?.clock ?? "-"} .. ${withFrame[withFrame.length - 1]?.clock ?? "-"}`)
const skews = withFrame.map(c => c.frameSkewSec!).sort((a, b) => a - b)
if (skews.length > 0)
	console.log(`  frame skew     median ${skews[Math.floor(skews.length / 2)]!.toFixed(2)}s, worst ${skews[skews.length - 1]!.toFixed(2)}s`)
console.log(`  shared samples ${sharedSampleLines} sample lines carry two frames (same block, two pictures ~5s apart)`)
for (const d of dropped) console.log(`  DROPPED ${d.id}: ${d.why}`)

const pick = [
	checkpoints.find(c => c.framePath !== null && c.tSec >= 360),
	checkpoints.find(c => c.framePath !== null && c.tSec >= 375),
	checkpoints.find(c => c.framePath === null && c.tSec >= 840)
].filter(c => c !== undefined) as Checkpoint[]

for (const c of pick.slice(0, PRINT_N)) {
	console.log(`\n${"=".repeat(100)}\n${c.id}  t=${c.tSec}s  clock ${c.clock}  sample line ${c.sampleLine}`)
	console.log(`frame: ${c.framePath ?? "(none)"}${c.frameSkewSec === null ? "" : `  skew ${c.frameSkewSec}s  showsGame ${c.frameShowsGame}`}`)
	console.log(`${"-".repeat(100)}\n${c.block}`)
}
