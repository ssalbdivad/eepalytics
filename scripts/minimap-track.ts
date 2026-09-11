/**
 * The POSITION TRACK: where he was, for a whole game, read off the minimap offline.
 *
 * ## Why this can exist offline and cannot exist live
 *
 * `src/review/read-minimap.ts` has been built, measured and shipped for months and has never once
 * run over a whole game. Not because it does not work — over 20 frames from five games it puts him
 * in the right HALF of the map 94% of the time and its position lands 3% of the map's width from a
 * hand label — but because the live path cannot reach it from the browser: the page holds an
 * ephemeral token that is `uses: 1` and accepted only by the Constrained WebSocket endpoint, and
 * `generateContent` refuses it. Live, the read also has to finish inside a coaching turn, so it
 * runs at most once every twenty seconds against a three-second timeout.
 *
 * Offline none of that is true. The daemon holds the real key, there is no turn to precede, and a
 * game that finished hours ago will hold still for as many reads as it takes. So this is the one
 * channel the live coach never had — the whole reason his verdict on that path was "generic and
 * often hilariously wrong": the block knows the roster, the gold, the clock and the CS, and it
 * does not know where anybody IS. It told him to take Rift Herald eight times without ever being
 * able to see that he was on the other side of the map.
 *
 * ## What this produces, and what it refuses to
 *
 * One entry per checkpoint: the model's own answer verbatim, the position it pointed at, and the
 * zone `shared/map.ts` derives from that position. It is a TRACK, not a story. Nothing here decides
 * what a position means, nobody's advice comes out of it, and per the measured numbers in
 * `frame-read.ts` an ENEMY sighting is not shippable as a sentence at any granularity — the enemy
 * rows are written because a re-score should not need the model again, not because they are ready
 * to be spoken.
 *
 * ## The shipped reader, unchanged
 *
 * `readMinimap` is imported, not reimplemented. That matters more here than in most harnesses:
 * every number quoted above was measured through that exact call with that exact prompt, so a
 * second reader written "just for the track" would be a track whose accuracy nobody has measured.
 * The crop is `minimapRect` and 4x lanczos through ffmpeg, byte-identical to `probe-minimap.ts`'s
 * `crop4x` condition, which is the condition all of those numbers come from.
 *
 * The fence is the shipped fence too, and it is the reason the truth block is joined in at all: a
 * read that puts his icon on the map while the client says he is on the respawn screen, or that
 * sees more red rings than there are living enemies, is thrown away WHOLE. Those refusals are kept
 * in the file as `rejectedRead` rather than deleted, because how often the fence fires and on what
 * is a measurement, but they are deliberately NOT in the `you` / `enemies` fields, so a consumer
 * that reads the obvious field cannot pick up a read the fence refused.
 *
 * ## Cadence
 *
 * Every 15 seconds of GAME clock, not every frame. Frames land every ~5s, so this is one read in
 * three and about 110 over a 28-minute game. Fifteen seconds is chosen from what a champion can
 * physically do with the gap rather than from a budget: at ~400 units/second he covers at most
 * ~6000 of the map's 14820 units, so consecutive reads are still CONSTRAINED — a jump bigger than
 * that is a lie the track can catch by itself, with no hand labelling at all (`--every 5` would
 * catch more of them but reads three times as much of the same walk). It is also about the
 * granularity a jungler's decision turns on: a path, a camp, a recall and an objective setup all
 * survive 15 seconds, and none of them is legible at 60.
 *
 * ## Failures are data
 *
 * Every checkpoint appears in the output whatever happened to it, carrying `ok`, `reason`,
 * `attempts` and `faults`. A transient refusal (a 429, a 5xx, a timeout, an empty body) is retried;
 * a `fenced` or `schema` outcome is NOT, because those are answers about this picture and retrying
 * one until it passes is how a harness launders a wrong read into a right one. A gap in the track
 * is a row saying what failed, never a missing row.
 *
 *     node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *       scripts/minimap-track.ts --session js-mtvxb5f4-f81a --every 15
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DATA_DIR, DB_PATH } from "../src/shared/constants.ts"
import { fromMinimapPct, zoneOf } from "../src/shared/map.ts"
import type { Zone } from "../src/shared/map.ts"
import {
	coarseOf,
	minimapRect,
	parseFrameReadXY,
	pctOf,
	zoneAtMinimapPct
} from "../src/review/frame-read.ts"
import type { FrameTruth, Sighting } from "../src/review/frame-read.ts"
import { MINIMAP_MODEL, readMinimap } from "../src/review/read-minimap.ts"
import { geminiKey } from "../src/review/gemini-live.ts"
import {
	clockText,
	jpegSize,
	nearestSample,
	pickCheckpoints,
	rebaseFramePath,
	segment
} from "./lib/stream.ts"
import { readVerbatim } from "./e2e-real-game.ts"
import type { RawSample } from "./e2e-real-game.ts"

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}

/* ================================================================= the truth */

interface LivePlayer {
	championName: string
	summonerName: string
	riotId?: string
	team: string
	isDead: boolean
	position: string
}

interface AllGameData {
	activePlayer?: { riotId?: string; summonerName?: string }
	allPlayers?: LivePlayer[]
}

/**
 * The five fields the fence checks, out of the raw `allgamedata` the sampler stored.
 *
 * Read from the SAMPLE rather than from `journal_frame.truthJson`, even though the stored block is
 * the one the coach actually held: the block is rendered PROSE, and recovering "how many enemies
 * are alive right now" from prose is a parser nobody should write when the structured JSON that
 * produced it is sitting in `data/live-samples/` on the same wall clock.
 */
const truthFromSample = (data: unknown): FrameTruth | null => {
	const d = data as AllGameData
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

/* ================================================================== the crop */

const CROP_QUALITY = "3"

/**
 * The `crop4x` condition, and nothing else.
 *
 * `minimapRect` is the same rectangle the browser cuts, so the pixels sent here are the pixels the
 * live path would have sent; the 4x lanczos upscale is what `probe-minimap.ts` measured and it is
 * free — Gemini pads a 288px image to the same 1,089 image tokens as a 1152px one.
 */
const cropFor = (framePath: string, outPath: string, size: { width: number; height: number }) => {
	if (existsSync(outPath)) return
	const r = minimapRect(size.width, size.height)
	execFileSync("ffmpeg", [
		"-y", "-loglevel", "error", "-i", framePath,
		"-vf", `crop=${r.w}:${r.h}:${r.x}:${r.y},scale=${r.w * 4}:${r.h * 4}:flags=lanczos`,
		"-q:v", CROP_QUALITY, outPath
	])
}

/* ================================================================ the shapes */

interface Placed {
	xy: Sighting
	/** Percentages of the crop, which is what `zoneAtMinimapPct` consumes. */
	pct: { left: number; top: number }
	zone: Zone
	/** The absolute prose name — "blue-side jungle (top)", never "your jungle". */
	label: string
	coarse: string
}

interface ReadFields {
	you: Placed | null
	enemies: Placed[]
	alliesOnMinimap: number
	activity: string
	youChampion: string | null
}

interface Entry {
	tSec: number
	clock: string
	frameId: string
	framePath: string
	cropPath: string
	atMs: number
	/** The sample the truth came from, and how far away it was on the wall clock. */
	sampleLine: number | null
	skewMs: number | null
	truth: FrameTruth | null
	ok: boolean
	reason: string | null
	faults: { code: string; detail: string }[]
	attempts: number
	ms: number
	/** Present only when the read passed the fence. */
	read: ReadFields | null
	/** Present only when it did NOT. Kept as a measurement; never a position anybody may use. */
	rejectedRead: ReadFields | null
	/** The model's own JSON, verbatim, so a re-score never needs the model again. */
	raw: unknown
}

const place = (p: Sighting): Placed => {
	const pct = pctOf(p)
	const zone = zoneAtMinimapPct(pct.left, pct.top)
	return { xy: p, pct, zone, label: zoneOf(fromMinimapPct(pct.left, pct.top)), coarse: coarseOf(zone) }
}

const fieldsFrom = (raw: unknown, truth: FrameTruth): ReadFields | null => {
	const parsed = parseFrameReadXY(raw, {
		myChampion: truth.myChampion,
		enemyChampions: truth.enemyChampions
	})
	if (parsed.read === null) return null
	return {
		you: parsed.read.you === null ? null : place(parsed.read.you),
		enemies: parsed.read.enemies.map(place),
		alliesOnMinimap: parsed.read.alliesOnMinimap,
		activity: parsed.read.activity,
		youChampion: parsed.read.youChampion
	}
}

/* ================================================================== the pool */

const pool = async <T, R>(items: T[], width: number, run: (item: T, i: number) => Promise<R>) => {
	const out: R[] = new Array(items.length)
	let next = 0
	const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
		for (;;) {
			const i = next++
			if (i >= items.length) return
			out[i] = await run(items[i]!, i)
		}
	})
	await Promise.all(workers)
	return out
}

/** Worth another look at the same picture. A refused ANSWER is not on this list, on purpose. */
const transient = (reason: string): boolean =>
	reason === "timeout" ||
	reason === "empty" ||
	reason === "error" ||
	reason === "not-json" ||
	reason.startsWith("http-5") ||
	reason === "http-429"

/* =================================================================== the run */

const main = async () => {
	const session = arg("session", "js-mtvxb5f4-f81a")

	/*
	 * Re-scoring costs nothing and must never cost a model call — that is the whole reason `raw` is
	 * stored. It is also a guard rail: a `--limit 2` smoke run writes a two-entry file over a full
	 * track, so the way to look at a track again is the mode that cannot overwrite it.
	 */
	if (process.argv.includes("--score")) {
		const path = join(DATA_DIR, "eval", "minimap-track", `${session}.json`)
		const stored = JSON.parse(readFileSync(path, "utf8")) as { meta: { everySec: number }; entries: Entry[] }
		console.log(`${path} — ${stored.entries.length} reads, ${stored.entries.filter(e => e.ok).length} past the fence`)
		score(stored.entries, stored.meta.everySec, session)
		return
	}

	if (geminiKey() === "") throw new Error("no Gemini key — set one in the app or GEMINI_API_KEY")
	const everySec = Number(arg("every", "15"))
	const width = Number(arg("concurrency", "6"))
	const model = arg("model", MINIMAP_MODEL)
	const timeoutMs = Number(arg("timeout", "30000"))
	const limit = Number(arg("limit", "0"))
	const maxSkewMs = Number(arg("max-skew", "8000"))

	const db = new DatabaseSync(DB_PATH, { readOnly: true })
	const meta = db
		.prepare("select id, gameId, championName, riotId from journal_session where id = ?")
		.get(session) as { gameId: number | null; championName: string | null; riotId: string | null }
	const all = db
		.prepare("select id, tSec, path, atMs, clock from journal_frame where sessionId = ? order by atMs")
		.all(session) as { id: string; tSec: number; path: string; atMs: number; clock: string }[]
	if (all.length === 0) throw new Error(`no frames for session ${session}`)

	/*
	 * A SESSION IS NOT A GAME — trap 2 in `lib/stream.ts`, and this session is a live example of it:
	 * `js-mtvxb5f4-f81a` holds 340 frames of the 28-minute Lillia game and then, five wall-clock
	 * minutes later, the frames of the NEXT game starting again at tSec 2. Selecting by session and
	 * ordering by tSec interleaves the two into one impossible track that walks the map twice. The
	 * run is cut by `segment`, on the sampler's own two rules, and named by ordinal.
	 */
	const runs = segment(all, r => r.atMs, r => r.tSec)
	const runIndex = Number(arg("run", "0"))
	const rows = [...(runs[runIndex] ?? [])].sort((a, b) => a.tSec - b.tSec)
	if (rows.length === 0) throw new Error(`session ${session} has no run ${runIndex} (${runs.length} runs)`)
	const runFrom = Math.min(...rows.map(r => r.atMs))
	const runTo = Math.max(...rows.map(r => r.atMs))

	/* Every sample file this session wrote, merged and ordered — the sampler rolls a new file on a
	 * supervisor restart, and a track that read only the first one would go blind mid-game. */
	const sampleDir = join(DATA_DIR, "live-samples")
	const sampleFiles = readdirSync(sampleDir)
		.filter(f => f.startsWith(session) && f.endsWith(".ndjson"))
		.map(f => join(sampleDir, f))
	const samples: RawSample[] = sampleFiles
		.flatMap(f => readVerbatim(f))
		.filter(sm => sm.atMs >= runFrom - 60_000 && sm.atMs <= runTo + 60_000)
		.sort((a, b) => a.atMs - b.atMs)

	const picked = pickCheckpoints(rows.map(r => r.tSec), { everySec, fromSec: 0, turns: 10_000 })
	const chosen = (limit > 0 ? picked.slice(0, limit) : picked).map(i => rows[i]!)

	const outDir = join(DATA_DIR, "eval", "minimap-track")
	const cropDir = join(outDir, session)
	mkdirSync(cropDir, { recursive: true })

	console.log(
		`${session} · game ${meta?.gameId ?? "?"} · ${meta?.championName ?? "?"}\n` +
			`run ${runIndex} of ${runs.length}: ${rows.length} frames, ` +
			`${clockText(rows[0]!.tSec)}-${clockText(rows[rows.length - 1]!.tSec)}, ` +
			`${samples.length} samples in its window from ${sampleFiles.length} file(s)\n` +
			`every ${everySec}s -> ${chosen.length} reads · ${model} · concurrency ${width}\n`
	)

	let done = 0
	const entries = await pool(chosen, width, async row => {
		const framePath = rebaseFramePath(row.path, session)
		const entry: Entry = {
			tSec: row.tSec,
			clock: row.clock,
			frameId: row.id,
			framePath,
			cropPath: join(cropDir, `${row.id}-crop4x.jpg`),
			atMs: row.atMs,
			sampleLine: null,
			skewMs: null,
			truth: null,
			ok: false,
			reason: null,
			faults: [],
			attempts: 0,
			ms: 0,
			read: null,
			rejectedRead: null,
			raw: null
		}

		if (!existsSync(framePath)) {
			entry.reason = "no-frame"
			return entry
		}
		const size = jpegSize(readFileSync(framePath))
		if (size === null) {
			entry.reason = "not-a-jpeg"
			return entry
		}

		const near = nearestSample(row.atMs, samples, maxSkewMs)
		if (near === null) {
			/* No client truth means no fence, and an unfenced read is not something this file will
			 * write into a position field. It is still counted, because a stretch of the game with
			 * no samples is a fact about the corpus. */
			entry.reason = "no-truth"
			return entry
		}
		entry.sampleLine = near.sample.line
		entry.skewMs = near.skewMs
		const truth = truthFromSample(near.sample.data)
		if (truth === null) {
			entry.reason = "truth-unbuildable"
			return entry
		}
		entry.truth = truth

		cropFor(framePath, entry.cropPath, size)
		const jpegBase64 = readFileSync(entry.cropPath).toString("base64")

		for (let attempt = 1; attempt <= 3; attempt++) {
			entry.attempts = attempt
			const out = await readMinimap({ jpegBase64, truth, model, timeoutMs })
			entry.ms += out.ms
			entry.raw = out.raw ?? null
			if (out.read !== null) {
				entry.ok = true
				entry.reason = null
				entry.faults = []
				entry.read = fieldsFrom(out.raw, truth)
				break
			}
			entry.reason = out.reason
			entry.faults = (out.faults ?? []).map(f => ({ code: f.code, detail: f.detail }))
			entry.rejectedRead = out.raw === undefined ? null : fieldsFrom(out.raw, truth)
			if (!transient(out.reason)) break
			await new Promise(r => setTimeout(r, 400 * attempt))
		}

		done++
		if (done % 20 === 0) console.log(`  ${done}/${chosen.length}`)
		return entry
	})

	const ok = entries.filter(e => e.ok)
	const outPath = join(outDir, `${session}.json`)
	writeFileSync(
		outPath,
		JSON.stringify(
			{
				meta: {
					session,
					gameId: meta?.gameId ?? null,
					champion: meta?.championName ?? null,
					riotId: meta?.riotId ?? null,
					model,
					everySec,
					generatedMs: Date.now(),
					runIndex,
					runsInSession: runs.length,
					framesInRun: rows.length,
					tSecFrom: rows[0]!.tSec,
					tSecTo: rows[rows.length - 1]!.tSec,
					reads: entries.length,
					ok: ok.length,
					crop: minimapRect(1536, 864),
					upscale: 4,
					script: "scripts/minimap-track.ts",
					note:
						"Zones are BLUE-RELATIVE and absolute in prose (blue base bottom-left). `read` " +
						"passed the shipped fence; `rejectedRead` did not and is a measurement only. " +
						"`raw` is unparsed model output — re-score through parseFrameReadXY."
				},
				entries
			},
			null,
			"\t"
		)
	)

	/* ---- what came back, said plainly ---- */
	const byReason = new Map<string, number>()
	for (const e of entries.filter(e => !e.ok))
		byReason.set(e.reason ?? "?", (byReason.get(e.reason ?? "?") ?? 0) + 1)
	console.log(`\n${ok.length}/${entries.length} reads passed the fence`)
	for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1]))
		console.log(`  ${reason.padEnd(20)} ${n}`)
	const located = ok.filter(e => e.read?.you)
	console.log(`his icon placed on ${located.length}/${ok.length} of those`)
	console.log(`\n${outPath}`)
	console.log(`crops: ${cropDir}`)

	score(entries, everySec, session)
}

/* ================================================================ the scoring */

const at = (sorted: readonly number[], q: number): number =>
	sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!

/**
 * What the track can check about itself, with nobody having looked at a frame.
 *
 * He cannot cross the map in fifteen seconds, so a track that says he did is lying about at least
 * one of the two reads. This is the same argument as the probe's self-agreement — a floor on the
 * error rate that needs no ground truth — moved from "the same picture twice" to "two pictures a
 * walk apart", which is the only version available once the model has been asked each question once.
 *
 * ADJACENCY IS ENFORCED. Fenced reads leave holes, and a pair straddling a hole is 30 or 45 seconds
 * apart, which is long enough to walk home and back out. Scoring those against a 15-second bound
 * would manufacture impossible jumps out of perfectly good reads, so a pair is only judged when the
 * two checkpoints are genuinely consecutive.
 */
const score = (entries: readonly Entry[], everySec: number, session: string) => {
	const pairs: { from: number; to: number; dt: number; pct: number; dead: boolean }[] = []
	for (let i = 1; i < entries.length; i++) {
		const a = entries[i - 1]!
		const b = entries[i]!
		if (!a.read?.you || !b.read?.you) continue
		pairs.push({
			from: a.tSec,
			to: b.tSec,
			dt: b.tSec - a.tSec,
			pct: Math.hypot(
				a.read.you.pct.left - b.read.you.pct.left,
				a.read.you.pct.top - b.read.you.pct.top
			),
			dead: (a.truth?.meDead ?? false) || (b.truth?.meDead ?? false)
		})
	}
	const adjacent = pairs.filter(p => p.dt <= everySec * 1.5)
	const sorted = adjacent.map(p => p.pct).sort((x, y) => x - y)
	console.log(
		`\nCONTINUITY over ${adjacent.length} consecutive pairs — a fenced read in between removes the ` +
			`pair rather than stretching it, and ${pairs.length - adjacent.length} more were dropped for a ` +
			`frame gap longer than the cadence\n` +
			`  straight-line movement, % of the map: median ${at(sorted, 0.5).toFixed(1)}  ` +
			`p90 ${at(sorted, 0.9).toFixed(1)}  max ${at(sorted, 1).toFixed(1)}`
	)
	/*
	 * The bound is PER PAIR, from that pair's own gap, and it took a false alarm to write it that
	 * way. `pickCheckpoints` advances from the time actually taken, so a nominally 15-second cadence
	 * lands 15 OR 20 seconds apart, and judging a 20-second pair against the 15-second bound flagged
	 * three "impossible" jumps. Two of them were opened by hand and BOTH ENDS WERE RIGHT: 0:16 in the
	 * fountain to 0:36 at his first camp, and 3:57 at the dragon pit to 4:12 in his own base, which
	 * is a recall. The track was honest and the ruler was short.
	 *
	 * 400 units/second is the generous ceiling (Lillia's base is 330 and this is early enough that
	 * nobody has boots), 14820 units is the map, so 1% of the map is 148.2 units. The straight line
	 * also under-states the walk, since he has to go around terrain — which is what makes the bound
	 * safe to call a contradiction rather than a fast rotation.
	 *
	 * A RECALL still beats it, and no live channel can rule one out: `allgamedata` has no positions,
	 * which is the whole reason this file exists. So a flagged pair is a read to go LOOK at, never a
	 * scored error, and the count below is an upper bound on the track's contradictions.
	 */
	const bound = (p: { dt: number }) => (p.dt * 400) / 148.2
	const impossible = adjacent.filter(p => p.pct > bound(p))
	console.log(
		`  further than he could walk in the gap (>${(400 / 148.2).toFixed(1)}%/s): ` +
			`${impossible.length}/${adjacent.length} (${((100 * impossible.length) / Math.max(1, adjacent.length)).toFixed(0)}%)`
	)
	for (const p of impossible.slice(0, 12))
		console.log(
			`    ${clockText(p.from)} -> ${clockText(p.to)}  ${p.pct.toFixed(0)}% in ${p.dt.toFixed(0)}s ` +
				`(bound ${bound(p).toFixed(0)}%)${p.dead ? "  — dead at one end, so a respawn" : ""}`
		)
	const fastest = [...adjacent].sort((a, b) => b.pct / b.dt - a.pct / a.dt).slice(0, 3)
	console.log(
		`  fastest: ${fastest.map(p => `${clockText(p.from)}->${clockText(p.to)} ${(p.pct / p.dt).toFixed(1)}%/s`).join("  ")}`
	)

	/* ---- what the fence costs, since it refuses the read WHOLE ---- */
	const refused = entries.filter(e => !e.ok && e.faults.length > 0)
	const byCode = new Map<string, number>()
	for (const e of refused)
		for (const f of e.faults) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1)
	console.log(`\nTHE FENCE refused ${refused.length}/${entries.length} reads (a read trips one fault or several)`)
	for (const [code, n] of [...byCode].sort((a, b) => b[1] - a[1])) console.log(`  ${code.padEnd(26)} ${n}`)
	/*
	 * The canary is the expensive one, and it is doing its job — `frame-read.ts` measured the same
	 * model naming his own champion WRONG 12 times in 60 from a 12-pixel portrait. It is worth
	 * saying out loud what it costs here, because a downstream consumer will be tempted to relax it:
	 * a read refused ONLY for the champion name still carries a position, and this counts how many.
	 * Counting is as far as this goes. Whether those positions are any good is a question for a
	 * human with the crops, not for the harness that produced them.
	 */
	const canaryOnly = refused.filter(e => e.faults.every(f => f.code === "wrong-self-champion"))
	console.log(
		`  of those, ${canaryOnly.length} were refused ONLY by the champion canary and still carry a ` +
			`position (${canaryOnly.filter(e => e.rejectedRead?.you).length} with his icon placed)`
	)

	/* ---- against hand labels, when a human has left some ---- */
	const labelPath = join(DATA_DIR, "eval", "minimap-track", `${session}-handlabels.json`)
	if (!existsSync(labelPath)) return
	const labels = JSON.parse(readFileSync(labelPath, "utf8")) as {
		labels: { frameId: string; left: number; top: number; note?: string; set?: string }[]
	}
	/*
	 * Grouped by `set`, and the grouping is the honest part. `spread` frames were chosen by the
	 * clock — eight points across the game, before anybody knew what the model had said. `audit`
	 * frames were chosen BECAUSE the continuity check flagged them, so they are a biased sample and
	 * averaging them into the accuracy number would be picking the marking scheme after the exam.
	 */
	const sets = [...new Set(labels.labels.map(l => l.set ?? "spread"))]
	for (const set of sets) {
	const group = labels.labels.filter(l => (l.set ?? "spread") === set)
	console.log(`\nHAND LABELS · ${set} (${group.length}) — a human opened the crop and found his icon`)
	let zoneHits = 0
	let coarseHits = 0
	let halfHits = 0
	const errs: number[] = []
	for (const l of group) {
		const e = entries.find(x => x.frameId === l.frameId)
		const truthZone = zoneAtMinimapPct(l.left, l.top)
		const got = e?.read?.you ?? null
		const err = got === null ? null : Math.hypot(got.pct.left - l.left, got.pct.top - l.top)
		if (err !== null) errs.push(err)
		if (got?.zone === truthZone) zoneHits++
		if (got !== null && got.coarse === coarseOf(truthZone)) coarseHits++
		/* His own half: blue is the bottom-left triangle, so left+top>100 is the enemy half. */
		if (got !== null && l.left + l.top > 100 === got.pct.left + got.pct.top > 100) halfHits++
		console.log(
			`  ${clockText(e?.tSec ?? 0).padStart(5)}  hand ${zoneOf(fromMinimapPct(l.left, l.top)).padEnd(24)}` +
				`model ${(got?.label ?? "(no read)").padEnd(24)}` +
				`${err === null ? "" : `${err.toFixed(0)}% off`}${l.note ? `  ${l.note}` : ""}`
		)
	}
	const n = group.length
	const se = errs.slice().sort((a, b) => a - b)
	console.log(
		`  exact zone ${zoneHits}/${n} · topside/botside/mid ${coarseHits}/${n} · right half ${halfHits}/${n} · ` +
			`median error ${at(se, 0.5).toFixed(1)}% of the map`
	)
	}
}

await main()
