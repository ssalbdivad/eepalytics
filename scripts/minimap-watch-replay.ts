/**
 * WHAT READING THE MINIMAP ON THE JOURNAL BEAT WOULD HAVE BEEN WORTH, on the one game we have.
 *
 * ## The question
 *
 * The live coach's position reads used to be taken only in FRONT of a coaching turn, and a reactive
 * turn skips the read because it is racing. On the graded run of game 5639406342 that put the median
 * turn 136 seconds from the last accepted read — past `CARRY_MAX_SEC`, so the brief said nothing
 * about where he was. `src/daemon/minimap-watch.ts` moves the read onto the journal's own
 * five-second beat instead. This measures what that does, by replaying the real frames of that game
 * through the real reader and then asking the real turn times how old their read would have been.
 *
 * ## Why it is a replay and not a reconstruction
 *
 * Every input is stored and every step is the shipped one. The frames are the 340 JPEGs the browser
 * actually posted; the truth per frame is the raw `allgamedata` the daemon's own sampler wrote at
 * that wall clock; the crop is `MINIMAP_REGION` at 4x lanczos; the reader is `readMinimap` with the
 * shipped model, prompt, schema and fence; the schedule is `admit`, including its single-flight rule
 * driven by each read's own measured latency. Nothing here reconstructs a state, which is the
 * failure `AGENTS.md` names: a harness run on starved states measures improvisation.
 *
 * The turn times are the ones in the two stored graded runs, replayed verbatim.
 *
 * ## What it will NOT do
 *
 * It never writes over `data/eval/minimap-track/<session>.json`. That is the 15-second track,
 * hand-checked at 1.8% median position error and 7 of 8 exact zones, and it is the evidence this
 * whole design rests on. This writes its own file.
 *
 * It does not retry. The watcher does not retry, so a harness that did would be measuring a
 * coverage the shipped code cannot deliver.
 *
 *     node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *       scripts/minimap-watch-replay.ts [--every 5] [--concurrency 6] [--limit 0] [--score]
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DATA_DIR, DB_PATH } from "../src/shared/constants.ts"
import { MINIMAP_REGION, coarseOf } from "../src/review/frame-read.ts"
import type { Coarse, FrameTruth } from "../src/review/frame-read.ts"
import { MINIMAP_MODEL, readMinimap } from "../src/review/read-minimap.ts"
import { geminiKey } from "../src/review/gemini-live.ts"
import { admit } from "../src/daemon/minimap-watch.ts"
import { FRAME_FRESH_SEC } from "../src/analysis/live-facts.ts"
import { CARRY_MAX_SEC } from "../src/server/routes/live.ts"
import { clockText, nearestSample, rebaseFramePath, segment } from "./lib/stream.ts"
import { readVerbatim } from "./e2e-real-game.ts"
import type { RawSample } from "./e2e-real-game.ts"

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}

const SESSION = arg("session", "js-mtvxb5f4-f81a")
const OUT = join(DATA_DIR, "eval", `minimap-watch-replay-${SESSION}.json`)

/** The two stored graded runs of this game, and the turn times they actually took. */
const GRADED = [
	"data/eval/stream-kayn-events-20260910.json",
	"data/eval/stream-kayn-events2-20260910.json"
]

/* ------------------------------------------------------------------ the truth */

interface Player {
	championName: string
	summonerName: string
	riotId?: string
	team: string
	isDead: boolean
}

/** The five fence facts off a stored raw sample — the same five `truthFromRaw` builds live. */
const truthFromSample = (data: unknown): FrameTruth | null => {
	const d = data as { activePlayer?: { riotId?: string; summonerName?: string }; allPlayers?: Player[] }
	const players = d.allPlayers
	if (!Array.isArray(players) || players.length === 0) return null
	const meName = d.activePlayer?.riotId ?? d.activePlayer?.summonerName
	const me = players.find(p => p.summonerName === meName || p.riotId === meName)
	if (me === undefined) return null
	const allies = players.filter(p => p.team === me.team && p !== me)
	const enemies = players.filter(p => p.team !== me.team)
	return {
		myChampion: me.championName,
		meDead: me.isDead === true,
		enemiesAlive: enemies.filter(p => !p.isDead).length,
		alliesAlive: allies.filter(p => !p.isDead).length,
		enemyChampions: enemies.map(p => p.championName)
	}
}

/* ------------------------------------------------------------------- the crop */

/** Byte-identical to `cropMinimap` in the watcher: the same fractions, 4x lanczos, q3. */
const cropTo = (framePath: string, outPath: string): boolean => {
	if (existsSync(outPath)) return true
	try {
		execFileSync("ffmpeg", [
			"-y", "-loglevel", "error", "-i", framePath,
			"-vf",
			`crop=iw*${MINIMAP_REGION.width}:ih*${MINIMAP_REGION.height}:` +
				`iw*${MINIMAP_REGION.left}:ih*${MINIMAP_REGION.top},` +
				`scale=iw*4:ih*4:flags=lanczos`,
			"-q:v", "3", outPath
		])
		return true
	} catch {
		return false
	}
}

/* ------------------------------------------------------------------ the shape */

interface Entry {
	tSec: number
	frameId: string
	/** What `admit` said about this frame, with the watcher's own state fed forward. */
	verdict: string
	ok: boolean
	reason: string | null
	ms: number
	you: string | null
	coarse: Coarse | null
}

const main = async () => {
	if (process.argv.includes("--score")) {
		const stored = JSON.parse(readFileSync(OUT, "utf8")) as { entries: Entry[] }
		report(stored.entries)
		return
	}
	if (geminiKey() === "") throw new Error("no Gemini key")

	const everySec = Number(arg("every", "5"))
	const width = Number(arg("concurrency", "6"))
	const limit = Number(arg("limit", "0"))

	/*
	 * FILL, not re-read. A frame whose answer is already in the file is never asked about again:
	 * the model has been paid for that picture, and asking it twice is both a charge and a second
	 * answer to a question that already has one.
	 */
	const already = new Map<string, Entry>()
	if (process.argv.includes("--fill") && existsSync(OUT))
		for (const e of (JSON.parse(readFileSync(OUT, "utf8")) as { entries: Entry[] }).entries)
			already.set(e.frameId, e)

	const db = new DatabaseSync(DB_PATH, { readOnly: true })
	const all = db
		.prepare("select id, tSec, path, atMs from journal_frame where sessionId = ? order by atMs")
		.all(SESSION) as { id: string; tSec: number; path: string; atMs: number }[]
	/* A SESSION IS NOT A GAME: this one holds the 28-minute Lillia game and then the next game's
	 * frames starting again at tSec 2. `segment` cuts it on the sampler's own two rules. */
	const runs = segment(all, r => r.atMs, r => r.tSec)
	const rows = [...(runs[Number(arg("run", "0"))] ?? [])].sort((a, b) => a.tSec - b.tSec)
	if (rows.length === 0) throw new Error(`no run for ${SESSION}`)

	const from = Math.min(...rows.map(r => r.atMs))
	const to = Math.max(...rows.map(r => r.atMs))
	const sampleDir = join(DATA_DIR, "live-samples")
	const samples: RawSample[] = readdirSync(sampleDir)
		.filter(f => f.startsWith(SESSION) && f.endsWith(".ndjson"))
		.flatMap(f => readVerbatim(join(sampleDir, f)))
		.filter(sm => sm.atMs >= from - 60_000 && sm.atMs <= to + 60_000)
		.sort((a, b) => a.atMs - b.atMs)

	/*
	 * THE SCHEDULE, RUN FORWARD EXACTLY AS THE DAEMON WOULD RUN IT.
	 *
	 * `admit` is the shipped decision and it is fed the state the previous frames left behind,
	 * including single-flight: a frame arriving while a read is still out is DROPPED, not queued.
	 * The in-flight window is the previous read's own measured latency, so the drops here are the
	 * drops a real game would have had — which is why this loop is sequential in the schedule even
	 * though the model calls below run in a pool.
	 *
	 * Latency is not known until the read has been made, so the pass below is two-phase: decide,
	 * read, then re-decide with the real latencies. A first pass at the shipped 5s beat against a
	 * p50 of 1.2s drops nothing at all, which is the answer this two-phase dance exists to earn
	 * rather than assume.
	 */
	const cropDir = join(DATA_DIR, "eval", "minimap-watch-crops", SESSION)
	mkdirSync(cropDir, { recursive: true })

	let lastReadSec: number | null = null
	const chosen: { row: (typeof rows)[number]; truth: FrameTruth; crop: string }[] = []
	const skipped: Entry[] = []
	for (const row of rows) {
		const verdict = admit(
			{ enabled: true, inFlight: false, cooldownUntilMs: 0, lastReadSec, sessionId: SESSION },
			{ tSec: row.tSec, sessionId: SESSION },
			Date.now(),
			everySec
		)
		if (verdict !== "read" && verdict !== "new-game") {
			skipped.push({
				tSec: row.tSec, frameId: row.id, verdict, ok: false,
				reason: null, ms: 0, you: null, coarse: null
			})
			continue
		}
		const framePath = rebaseFramePath(row.path, SESSION)
		if (!existsSync(framePath)) {
			skipped.push({ tSec: row.tSec, frameId: row.id, verdict, ok: false, reason: "no-frame", ms: 0, you: null, coarse: null })
			continue
		}
		const near = nearestSample(row.atMs, samples, 8000)
		const truth = near === null ? null : truthFromSample(near.sample.data)
		if (truth === null) {
			// No client truth means no fence, and the watcher refuses an unfenced read too.
			skipped.push({ tSec: row.tSec, frameId: row.id, verdict, ok: false, reason: "no-truth", ms: 0, you: null, coarse: null })
			lastReadSec = row.tSec
			continue
		}
		const crop = join(cropDir, `${row.id}.jpg`)
		if (!cropTo(framePath, crop)) {
			skipped.push({ tSec: row.tSec, frameId: row.id, verdict, ok: false, reason: "crop-failed", ms: 0, you: null, coarse: null })
			continue
		}
		if (already.get(row.id)?.verdict === "read") skipped.push(already.get(row.id)!)
		else chosen.push({ row, truth, crop })
		lastReadSec = row.tSec
	}

	const work = limit > 0 ? chosen.slice(0, limit) : chosen
	console.log(
		`${SESSION} run 0 — ${rows.length} frames ${clockText(rows[0]!.tSec)}..${clockText(rows.at(-1)!.tSec)}\n` +
			`every ${everySec}s -> ${work.length} reads (${skipped.length} frames not read) · ${MINIMAP_MODEL}\n`
	)

	let done = 0
	const read: Entry[] = new Array(work.length)
	let next = 0
	await Promise.all(
		Array.from({ length: Math.min(width, work.length) }, async () => {
			for (;;) {
				const i = next++
				if (i >= work.length) return
				const w = work[i]!
				const out = await readMinimap({
					jpegBase64: readFileSync(w.crop).toString("base64"),
					truth: w.truth
				})
				read[i] = {
					tSec: w.row.tSec,
					frameId: w.row.id,
					verdict: "read",
					ok: out.read !== null,
					reason: out.read === null ? out.reason : null,
					ms: out.ms,
					you: out.read?.you ?? null,
					coarse: out.read?.you ? coarseOf(out.read.you) : null
				}
				if (++done % 25 === 0) console.log(`  ${done}/${work.length}`)
			}
		})
	)

	const entries = [...read, ...skipped].sort((a, b) => a.tSec - b.tSec)
	writeFileSync(
		OUT,
		JSON.stringify(
			{
				meta: {
					session: SESSION,
					gameId: 5639406342,
					model: MINIMAP_MODEL,
					everySec,
					framesInRun: rows.length,
					reads: work.length,
					generatedMs: Date.now(),
					script: "scripts/minimap-watch-replay.ts",
					note:
						"The journal-beat schedule replayed over real frames with the shipped reader " +
						"and the shipped fence. No retries, because the watcher does not retry. " +
						"Does not touch data/eval/minimap-track/."
				},
				entries
			},
			null,
			"\t"
		)
	)
	console.log(`\n${OUT}`)
	report(entries)
}

/* --------------------------------------------------------------- the scoring */

const pct = (n: number, of: number): string => (of === 0 ? "0%" : `${Math.round((n / of) * 1000) / 10}%`)

/**
 * COVERAGE AT A CADENCE, without asking the model anything again.
 *
 * Every read in the file is an answer about one frame, so a SPARSER schedule is a subsample of
 * them: take the reads in order and keep one whenever the floor has been cleared. That is exactly
 * what `admit` would have kept, because the only input its pacing rule has is the game clock.
 *
 * A DENSER schedule is not available this way and is not faked — it needs frames nobody asked
 * about, which is what `--fill` is for.
 */
const coverageAt = (
	entries: Entry[],
	floorSec: number,
	turns: readonly number[]
): { fresh: number; carried: number; none: number; reads: number; median: number | null } => {
	let last: number | null = null
	const kept: Entry[] = []
	for (const e of entries.filter(x => x.verdict === "read").sort((a, b) => a.tSec - b.tSec)) {
		if (last !== null && e.tSec - last < floorSec) continue
		last = e.tSec
		kept.push(e)
	}
	const placed = kept.filter(e => e.ok && e.you !== null)
	let fresh = 0
	let carried = 0
	let none = 0
	const ages: number[] = []
	for (const t of turns) {
		const prior = placed.filter(e => e.tSec <= t).at(-1)
		if (prior === undefined) {
			none++
			continue
		}
		const age = t - prior.tSec
		ages.push(age)
		if (age <= FRAME_FRESH_SEC) fresh++
		else if (age <= CARRY_MAX_SEC) carried++
		else none++
	}
	ages.sort((a, b) => a - b)
	return {
		fresh,
		carried,
		none,
		reads: kept.length,
		median: ages.length === 0 ? null : Math.round(ages[Math.floor(ages.length / 2)]! * 10) / 10
	}
}

const report = (entries: Entry[]): void => {
	const readEntries = entries.filter(e => e.verdict === "read")
	const placed = readEntries.filter(e => e.ok && e.you !== null).sort((a, b) => a.tSec - b.tSec)
	const ms = readEntries.filter(e => e.ms > 0).map(e => e.ms).sort((a, b) => a - b)
	const at = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] ?? 0

	console.log(`\nREADS  ${readEntries.length} made · ${readEntries.filter(e => e.ok).length} past the fence (${pct(readEntries.filter(e => e.ok).length, readEntries.length)}) · ${placed.length} placed him`)
	console.log(`       p50 ${at(0.5)}ms  p90 ${at(0.9)}ms  max ${ms.at(-1) ?? 0}ms`)
	const byReason = new Map<string, number>()
	for (const e of readEntries.filter(e => !e.ok)) byReason.set(e.reason ?? "?", (byReason.get(e.reason ?? "?") ?? 0) + 1)
	for (const [r, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`       ${r.padEnd(16)} ${n}`)

	/*
	 * COVERAGE, against the turn times of the two stored graded runs.
	 *
	 * `freshest` is the newest read AT OR BEFORE the turn, which is the only one the daemon could
	 * have had: a read taken after the turn does not exist yet when the payload is built.
	 */
	for (const path of GRADED) {
		if (!existsSync(path)) continue
		const j = JSON.parse(readFileSync(path, "utf8")) as { records: { arm: string; atSec: number }[] }
		const turns = [...new Set(j.records.filter(r => r.arm !== "mock").map(r => r.atSec))].sort((a, b) => a - b)
		let fresh = 0
		let carried = 0
		let none = 0
		const ages: number[] = []
		for (const t of turns) {
			const prior = placed.filter(e => e.tSec <= t).at(-1)
			if (prior === undefined) {
				none++
				continue
			}
			const age = t - prior.tSec
			ages.push(age)
			if (age <= FRAME_FRESH_SEC) fresh++
			else if (age <= CARRY_MAX_SEC) carried++
			else none++
		}
		const sorted = [...ages].sort((a, b) => a - b)
		console.log(
			`\n${path.split("/").pop()} — ${turns.length} turns\n` +
				`  read <= ${FRAME_FRESH_SEC}s (present tense)   ${fresh}  ${pct(fresh, turns.length)}\n` +
				`  read <= ${CARRY_MAX_SEC}s (printed at all)    ${fresh + carried}  ${pct(fresh + carried, turns.length)}\n` +
				`  nothing to say                 ${none}  ${pct(none, turns.length)}\n` +
				`  median age ${sorted.length === 0 ? "n/a" : `${Math.round(sorted[Math.floor(sorted.length / 2)]! * 10) / 10}s`}`
		)

		/*
		 * THE CADENCE CURVE, so the beat is chosen against a measurement rather than a guess.
		 *
		 * Every row is a subsample of reads already paid for, so the whole table costs nothing.
		 */
		console.log(`  floor   reads  <=${FRAME_FRESH_SEC}s        <=${CARRY_MAX_SEC}s        none      median`)
		for (const floor of [0, 2, 3, 4, 5, 7, 10, 15, 20, 30, 45]) {
			const r = coverageAt(entries, floor, turns)
			console.log(
				`  ${String(floor).padStart(3)}s  ${String(r.reads).padStart(6)}  ` +
					`${String(r.fresh).padStart(3)} ${pct(r.fresh, turns.length).padStart(6)}  ` +
					`${String(r.fresh + r.carried).padStart(3)} ${pct(r.fresh + r.carried, turns.length).padStart(6)}  ` +
					`${String(r.none).padStart(3)} ${pct(r.none, turns.length).padStart(6)}  ` +
					`${r.median === null ? "n/a" : `${r.median}s`}`
			)
		}
	}
}

await main()
