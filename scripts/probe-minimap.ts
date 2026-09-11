/**
 * What can actually be read off the minimap, with numbers.
 *
 * ## KEPT in the 2026-09-11 harness consolidation, and this is the question it still answers
 *
 * Six harnesses were retired that day because `bench-stream.ts` asks their question better. This
 * one survived because nothing else asks its question at all: **how accurate is a minimap read,
 * against ground truth the model never saw and against itself?** `src/review/read-minimap.ts` and
 * `src/daemon/minimap-watch.ts` both SHIP on the answer, and a shipped channel whose error rate
 * cannot be re-derived is a channel nobody can argue with. `bench-stream` consumes the read; it
 * does not grade it. `minimap-track.ts` produces a whole-game position track; it does not grade it
 * either. Its scorer is pinned in `scripts/probe-minimap.test.ts`, beside it.
 *
 * ## The question
 *
 * `src/review/frame-read.ts` explains why a vision pre-pass is worth building at all: the coach
 * demonstrably reads the frame (6/6 on the game clock) and demonstrably never says anything from it
 * (13/14 identical speak-or-PASS decisions with the JPEG removed), because `analysis/live-facts.ts`
 * ranks every candidate line in TypeScript and not one candidate is computed from pixels.
 *
 * This probe answers the next question, which is the one that decides whether any of it ships:
 * **is a minimap read accurate enough to coach from?** A confident wrong "an enemy is in your
 * topside jungle" costs more than ten dull lines, because it sends him somewhere. So the bar is
 * high and the honest answer may be no.
 *
 * ## How it establishes truth, twice, on purpose
 *
 *   1. **The client, which never saw the picture.** How many enemies are alive, whether he is on the
 *      respawn screen and what he is playing are all in the stored ground-truth block, computed by
 *      the daemon from the Live Client Data API. A read claiming four red rings when three enemies
 *      are alive is wrong without anybody having looked at anything. This is `frameReadFaults`, it
 *      needs no labels, and it runs on every frame in the set.
 *   2. **Agreement with itself.** The same frame is read `--repeats` times. Two answers that
 *      disagree cannot both be right, so disagreement is a floor on the error rate that costs no
 *      ground truth at all — and it is the number to look at first, because a reader that cannot
 *      reproduce its own answer has no accuracy left to measure.
 *
 * Hand labels are the third leg and they are deliberately the smallest: at 1536x864 a minimap
 * champion icon is about 18 pixels across and the portrait inside its ring is about 12, which is
 * small enough that the author's own reading of a cluttered frame is worth ±1 and is recorded as
 * such in `HAND`.
 *
 * ## The conditions
 *
 * A condition names two independent choices, because neither can be inferred from the other:
 *
 *   full       the whole 1536x864 frame, exactly what `useScreenShare` sends.   what ships today
 *   crop       the 288px minimap square alone.                                 does isolating help
 *   crop4x     that crop upscaled to 1152px.                                   does size help
 *   ...-xy     ask for a POSITION and let `zoneAtMinimapPct` name it, instead of asking the model
 *              to pick one of thirteen zone names.                             who does the geography
 *
 * MEASURED FIRST, because it changes how to read everything else: the cut costs nothing. Gemini
 * bills 1,100 image tokens for the full frame and 1,089 for the 288px crop AND for the same crop at
 * 1152px — a small image is padded to the same tile budget as a large one. So there is no accuracy
 * against cost trade-off to weigh; cropping is either better or pointless.
 *
 * The results are in `src/review/frame-read.ts`, next to the code they are about. The short version
 * is that the whole frame is blind — a median position error of 43% of the map's width, which is a
 * randomly chosen point — and the cropped, upscaled, pointed-at version is right about where HE is
 * and still not right enough about where THEY are to say it out loud.
 *
 * Run it (the key and the journal both live under the real data directory — this repo's own `data/`
 * has neither, so the variable is not optional):
 *
 *   EEPALYTICS_DATA_DIR=/home/ssalb/eepalytics/data node --experimental-strip-types \
 *     scripts/probe-minimap.ts --n 20 --repeats 3 --out /tmp/minimap.json
 *
 * `--conditions` defaults to the four above, `--model` to `gemini-3.1-flash-lite`. Every read is one
 * `generateContent` call with a `responseSchema`, deliberately NOT the live socket: a pre-pass
 * produces facts for `analysis/live-facts.ts` to rank, it does not speak, and the two shapes are not
 * interchangeable (see AGENTS.md on why that distinction is kept everywhere else too).
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DB_PATH, DATA_DIR } from "../src/shared/constants.ts"
import type { Zone } from "../src/shared/map.ts"
import {
	FRAME_READ_QUESTION_XY,
	FRAME_READ_SYSTEM,
	agreementOf,
	asFrameRead,
	coarseOf,
	frameReadQuestion,
	frameReadFaults,
	frameReadSchema,
	frameReadSchemaXY,
	minimapRect,
	parseFrameRead,
	parseFrameReadXY,
	zoneAtMinimapPct
} from "../src/review/frame-read.ts"
import type { FrameRead, FrameTruth, Sighting } from "../src/review/frame-read.ts"
import { geminiKey } from "../src/review/gemini-live.ts"

/* ------------------------------------------------------------ hand labels */

/**
 * Frames the author opened and counted BY HAND, at 4x with a percentage grid drawn over the map,
 * zooming to 12-16x on every cluster before calling a ring red or white.
 *
 * A label is a CLICK, not a zone name: each entry is where on the minimap an icon sat, as
 * percentages across the playable square, and `zoneAtMinimapPct` turns it into a zone using
 * `map.ts`'s own inverse transform and classifier. That is deliberate. A hand-typed zone name is an
 * opinion about geography as well as about pixels, and the geography is already settled code.
 *
 * `soft` marks frames where icons overlap badly enough that the count is worth ±1. Recorded rather
 * than dropped: dropping the hard frames is how a label set flatters a model on exactly the frames
 * that matter, and three of these six are hard.
 *
 * There is no champion column, and that is a finding rather than an omission. A minimap portrait is
 * about 12 pixels of JPEG at q0.72 inside an 18-pixel ring — the author could not name one either,
 * on any frame, at any zoom. What survives at that size is the RING COLOUR, which is why every
 * question here is about where an icon is and whose it is, and never who.
 */
export const HAND: Record<
	string,
	{ enemies: [number, number][]; you: [number, number] | null; soft?: boolean }
> = {
	"js-mtn2jrku-8ae9-2348": { enemies: [[57, 44], [85, 74]], you: [50, 45] },
	"js-mtn2jrku-8ae9-4155": { enemies: [[20, 21], [54, 48], [89, 68]], you: [72, 65] },
	"js-mtn1cf3k-91bb-6887": { enemies: [[11, 20], [47, 55], [82, 81]], you: [79, 57], soft: true },
	"js-mtn2jrku-8ae9-11509": { enemies: [[19, 31], [75, 82]], you: [14, 47], soft: true },
	"js-mtn2jrku-8ae9-12692": { enemies: [[89, 47]], you: [48, 51] },
	"js-mtn2jrku-8ae9-13792": { enemies: [[36, 46], [45, 54]], you: [47, 34] }
}

/** The hand labels as zones, computed rather than typed. */
export const handZones = (id: string): { enemies: Zone[]; you: Zone | null; soft: boolean } | null => {
	const h = HAND[id]
	if (!h) return null
	return {
		enemies: h.enemies.map(([l, t]) => zoneAtMinimapPct(l, t)),
		you: h.you === null ? null : zoneAtMinimapPct(h.you[0], h.you[1]),
		soft: h.soft === true
	}
}

/* ------------------------------------------------------------ pure parts */

/** `Clock 11:06.` out of a stored block, in seconds, or null when there is no such line. */
export const blockClockSec = (block: string): number | null => {
	const m = /^Clock (\d+):(\d\d)\./m.exec(block)
	return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/**
 * The fence's five facts, read out of a block the daemon wrote.
 *
 * A regex over a rendered block is the same hazard the retired `probe-vision.ts` recorded: a silent no-match
 * would leave the probe scoring reads against a truth of zeroes and reporting a fabrication rate of
 * zero. So this returns null rather than a default when any line is missing, the caller drops the
 * frame, and the test pins it against real block text.
 *
 * "Alive right now: 4 of yours against 3 of theirs" counts HIM among "yours" when he is alive —
 * `live-state.ts` renders `1 + allies alive - (me dead ? 1 : 0)` — so his own row has to be
 * subtracted back out to get the allies the minimap can draw beside him.
 */
export const truthFromBlock = (block: string): FrameTruth | null => {
	const me = /^You: (\S+(?: \S+)*?) lv\d+/m.exec(block)
	const alive = /^Alive right now: (\d+) of yours against (\d+) of theirs\.$/m.exec(block)
	const enemies = /^Enemy team: (.*)$/m.exec(block)
	if (!me || !alive || !enemies) return null
	const meDead = /^You: .*, DEAD/m.test(block)
	const yours = Number(alive[1])
	return {
		myChampion: me[1]!,
		meDead,
		enemiesAlive: Number(alive[2]),
		alliesAlive: Math.max(0, yours - (meDead ? 0 : 1)),
		enemyChampions: enemies[1]!.split(" · ").map(s => s.replace(/ lv\d+ \d+\/\d+\/\d+$/, ""))
	}
}

/** How often a boolean was true, as `k/n (pp%)`, or `n/a` when nothing was scored. */
export const pct = (hits: number, n: number): string =>
	n === 0 ? "n/a" : `${hits}/${n} (${Math.round((100 * hits) / n)}%)`

/** Every unordered pair agreed, per question. The floor on accuracy, and it needs no truth. */
export const pairwiseAgreement = (reads: FrameRead[]): { field: string; same: number; n: number }[] => {
	const fields = ["enemyCount", "enemyZones", "you", "activity", "youChampion"] as const
	const out = fields.map(field => ({ field: String(field), same: 0, n: 0 }))
	for (let i = 0; i < reads.length; i++)
		for (let j = i + 1; j < reads.length; j++) {
			const a = agreementOf(reads[i]!, reads[j]!)
			for (const row of out) {
				row.n++
				if (a[row.field as keyof typeof a]) row.same++
			}
		}
	return out
}

/**
 * Model sightings paired with hand-clicked ones, nearest first, with the distance between them in
 * percent of the map's width.
 *
 * Per-ICON scoring exists because the all-or-nothing version conflates two different failures: a
 * read that put every enemy in the right place but saw one too many scores zero, exactly like a read
 * that saw the right number in the wrong half of the map. Those are not the same mistake and only
 * one of them would send him somewhere.
 *
 * Greedy nearest-first, and only matched pairs are scored — an extra sighting with nothing left to
 * match is already counted as a wrong COUNT, and scoring it again as a huge distance would punish
 * the same mistake twice and drag the median around by how many icons happened to be on the map. A
 * distance is also the honest unit for a position: "0 of 18 zone sets exact" and "off by 3% of the
 * map" are both true of the same run, and only the second says whether the read is directionally
 * useful.
 */
export const matchIcons = (
	got: Sighting[],
	want: [number, number][]
): { error: number; zone: Zone; wantZone: Zone }[] => {
	const left = want.map(([x, y]) => ({ x, y }))
	const out: { error: number; zone: Zone; wantZone: Zone }[] = []
	for (const raw of [...got]) {
		const g = { x: raw.x / 10, y: raw.y / 10 }
		let best = -1
		let bestD = Infinity
		left.forEach((w, i) => {
			const d = Math.hypot(g.x - w.x, g.y - w.y)
			if (d < bestD) {
				bestD = d
				best = i
			}
		})
		if (best === -1) break
		const w = left.splice(best, 1)[0]!
		out.push({
			error: bestD,
			zone: zoneAtMinimapPct(g.x, g.y),
			wantZone: zoneAtMinimapPct(w.x, w.y)
		})
	}
	return out
}

/* ------------------------------------------------------------ the frames */

interface Frame {
	id: string
	path: string
	tSec: number
	block: string
	truth: FrameTruth
}

/**
 * Frames whose stored block is CONTEMPORANEOUS with the picture.
 *
 * This filter is load-bearing and it was not obvious. `journal_frame.truthJson` is the block the
 * coach was holding, and it is often not the block for THIS frame: measured across all 1,751 stored
 * blocks, only 635 are within 3 seconds of their own frame's clock, 164 are 16-60s stale and 145 are
 * more than a minute stale — one froze at 13:06 and rode along for nine minutes of frames. Scoring a
 * read of a 22:36 picture against a 13:06 truth would report fabrications that are the harness's
 * fault, so anything past three seconds is dropped.
 */
const pickFrames = (n: number): Frame[] => {
	const db = new DatabaseSync(DB_PATH, { readOnly: true })
	const rows = db
		.prepare(
			"SELECT id, sessionId, tSec, truthJson FROM journal_frame WHERE clock = 'live' AND tSec > 90 AND truthJson IS NOT NULL ORDER BY sessionId, tSec"
		)
		.all() as unknown as { id: string; sessionId: string; tSec: number; truthJson: string }[]
	db.close()
	const usable: Frame[] = []
	for (const r of rows) {
		const clock = blockClockSec(r.truthJson)
		if (clock === null || Math.abs(r.tSec - clock) > 3) continue
		const path = `${DATA_DIR}/journal/${r.sessionId}/${r.id}.jpg`
		if (!existsSync(path)) continue
		const truth = truthFromBlock(r.truthJson)
		if (truth === null) continue
		usable.push({ id: r.id, path, tSec: r.tSec, block: r.truthJson, truth })
	}
	/*
	 * Spread across games AND across the clock. A run of consecutive frames is one game state read
	 * many times, which measures the same thing repeats already measure and inflates n.
	 */
	/*
	 * The hand-labelled frames are always in, whatever `--n` is. They are the only frames carrying a
	 * human's count, so a run that happened not to sample them would report the fence and the
	 * agreement and nothing about accuracy.
	 */
	const forced = usable.filter(f => f.id in HAND)
	const rest = usable.filter(f => !(f.id in HAND))
	const want = Math.max(0, n - forced.length)
	if (rest.length <= want) return [...forced, ...rest]
	const step = rest.length / want
	const spread = Array.from({ length: want }, (_, i) => rest[Math.floor(i * step)]!)
	return [...forced, ...spread].sort((a, b) => a.id.localeCompare(b.id))
}

/* ------------------------------------------------------------ the images */

const WORK = mkdtempSync(join(tmpdir(), "minimap-"))

/**
 * The three ways to send one frame.
 *
 * ffmpeg rather than a decoder dependency: the crop rectangle comes from `minimapRect` so the probe
 * and the browser cut the same pixels out, which is the only thing that makes a measurement here
 * mean anything about what would ship.
 */
const imageFor = (frame: Frame, condition: string): string => {
	if (condition === "full") return readFileSync(frame.path).toString("base64")
	const out = join(WORK, `${frame.id}-${condition}.jpg`)
	if (!existsSync(out)) {
		const r = minimapRect(1536, 864)
		const scale = condition === "crop4x" ? `,scale=${r.w * 4}:${r.h * 4}:flags=lanczos` : ""
		execFileSync("ffmpeg", [
			"-y", "-loglevel", "error", "-i", frame.path,
			"-vf", `crop=${r.w}:${r.h}:${r.x}:${r.y}${scale}`,
			"-q:v", "3", out
		])
	}
	return readFileSync(out).toString("base64")
}

/* ------------------------------------------------------------ the model */

interface Answer {
	json: unknown
	ms: number
	imageTokens: number
	error?: string
}

/**
 * A condition is `<image>` or `<image>-xy`: how the frame is cut, and whether the answer is a zone
 * NAME or a POSITION. Both halves matter and neither can be inferred from the other, so they are
 * varied together in one string rather than as two flags nobody would remember to set.
 */
const isXY = (condition: string): boolean => condition.endsWith("-xy")
const imageOf = (condition: string): string => condition.replace(/-xy$/, "")

const ask = async (model: string, key: string, frame: Frame, condition: string): Promise<Answer> => {
	const xy = isXY(condition)
	const body = {
		systemInstruction: { parts: [{ text: FRAME_READ_SYSTEM }] },
		contents: [
			{
				role: "user",
				parts: [
					{ inlineData: { mimeType: "image/jpeg", data: imageFor(frame, imageOf(condition)) } },
					{ text: xy ? FRAME_READ_QUESTION_XY : frameReadQuestion() }
				]
			}
		],
		generationConfig: {
			responseMimeType: "application/json",
			responseSchema: (xy ? frameReadSchemaXY : frameReadSchema)({
				enemyChampions: frame.truth.enemyChampions,
				myChampion: frame.truth.myChampion
			})
		}
	}
	const started = Date.now()
	try {
		const res = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
			{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
		)
		const j = (await res.json()) as {
			candidates?: { content?: { parts?: { text?: string }[] } }[]
			usageMetadata?: { promptTokensDetails?: { modality?: string; tokenCount?: number }[] }
		}
		const text = j.candidates?.[0]?.content?.parts?.[0]?.text
		return {
			json: text === undefined ? null : JSON.parse(text),
			ms: Date.now() - started,
			imageTokens:
				j.usageMetadata?.promptTokensDetails?.find(d => d.modality === "IMAGE")?.tokenCount ?? 0
		}
	} catch (e) {
		/*
		 * A thrown call is a row, never the end of the run. The retired `probe-vision.ts` recorded the same
		 * lesson: one transient socket discarded every result already measured.
		 */
		return { json: null, ms: Date.now() - started, imageTokens: 0, error: String(e) }
	}
}

/* ------------------------------------------------------------ the run */

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}

interface Row {
	frame: string
	tSec: number
	condition: string
	repeat: number
	read: FrameRead | null
	/** Present only in the `-xy` conditions: the raw positions, before `map.ts` named them. */
	enemyPoints: Sighting[] | null
	youPoint: Sighting | null
	rejected: string | null
	dropped: string[]
	faults: string[]
	ms: number
	imageTokens: number
	error?: string
}

const main = async () => {
	const key = geminiKey()
	if (key === "") throw new Error("no Gemini key — set one in the app or GEMINI_API_KEY")
	const model = arg("model", "gemini-3.1-flash-lite")
	const n = Number(arg("n", "12"))
	const repeats = Number(arg("repeats", "3"))
	const conditions = arg("conditions", "full,crop4x,crop4x-xy").split(",")
	const frames = pickFrames(n)
	console.log(`${frames.length} frames · ${conditions.join(", ")} · ${repeats} repeats · ${model}\n`)

	const rows: Row[] = []
	for (const frame of frames) {
		for (const condition of conditions) {
			const jobs = Array.from({ length: repeats }, () => ask(model, key, frame, condition))
			const answers = await Promise.all(jobs)
			answers.forEach((a, repeat) => {
				const ctx = {
					myChampion: frame.truth.myChampion,
					enemyChampions: frame.truth.enemyChampions
				}
				const xy = isXY(condition) ? parseFrameReadXY(a.json, ctx) : null
				const parsed =
					xy ?
						{ read: xy.read === null ? null : asFrameRead(xy.read), rejected: xy.rejected, dropped: xy.dropped }
					:	parseFrameRead(a.json, ctx)
				rows.push({
					frame: frame.id,
					tSec: frame.tSec,
					condition,
					repeat,
					read: parsed.read,
					enemyPoints: xy?.read?.enemies ?? null,
					youPoint: xy?.read?.you ?? null,
					rejected: parsed.rejected,
					dropped: parsed.dropped,
					faults: parsed.read ? frameReadFaults(parsed.read, frame.truth).map(f => `${f.code} (${f.detail})`) : [],
					ms: a.ms,
					imageTokens: a.imageTokens,
					error: a.error
				})
			})
		}
		process.stdout.write(".")
	}
	console.log("\n")

	report(frames, rows, conditions)
	const out = arg("out", "")
	if (out !== "") {
		mkdirSync(join(out, ".."), { recursive: true })
		writeFileSync(out, JSON.stringify({ model, frames: frames.map(f => f.id), rows }, null, 2))
		console.log(`\nwrote ${out}`)
	}
}

const report = (frames: Frame[], rows: Row[], conditions: string[]) => {
	for (const condition of conditions) {
		const mine = rows.filter(r => r.condition === condition)
		const live = mine.filter(r => r.read !== null)
		console.log(`## ${condition}  —  ${live.length}/${mine.length} answered`)
		const tokens = live.map(r => r.imageTokens)
		console.log(
			`   image tokens ${tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : 0}` +
				` · ${Math.round(live.reduce((a, r) => a + r.ms, 0) / Math.max(1, live.length))} ms per read`
		)

		/* 1. the client's own contradictions — no labels needed */
		const clean = live.filter(r => r.faults.length === 0).length
		console.log(`   passes the client's fence   ${pct(clean, live.length)}`)
		const byFault = new Map<string, number>()
		for (const r of live)
			for (const f of r.faults) {
				const code = f.split(" (")[0]!
				byFault.set(code, (byFault.get(code) ?? 0) + 1)
			}
		for (const [code, count] of [...byFault].sort((a, b) => b[1] - a[1]))
			console.log(`     ${code.padEnd(26)} ${count}`)
		const droppedValues = live.flatMap(r => r.dropped)
		if (droppedValues.length > 0)
			console.log(`   answers outside the enums   ${droppedValues.length}: ${[...new Set(droppedValues)].slice(0, 6).join(", ")}`)

		/* 2. agreement with itself */
		const agree = [{ field: "enemyCount", same: 0, n: 0 }, { field: "enemyZones", same: 0, n: 0 },
			{ field: "you", same: 0, n: 0 }, { field: "activity", same: 0, n: 0 },
			{ field: "youChampion", same: 0, n: 0 }]
		for (const frame of frames) {
			const reads = live.filter(r => r.frame === frame.id).map(r => r.read!)
			if (reads.length < 2) continue
			for (const row of pairwiseAgreement(reads)) {
				const into = agree.find(a => a.field === row.field)!
				into.same += row.same
				into.n += row.n
			}
		}
		for (const a of agree) console.log(`   agrees with itself: ${a.field.padEnd(12)} ${pct(a.same, a.n)}`)

		/* 3. hand labels, where they exist */
		let enemyExact = 0
		let enemyWithin1 = 0
		let zonesExact = 0
		let coarseExact = 0
		let youExact = 0
		let youCoarse = 0
		let handN = 0
		const errors: number[] = []
		let iconN = 0
		let iconZone = 0
		let iconSide = 0
		for (const r of live) {
			const hand = handZones(r.frame)
			if (!hand) continue
			handN++
			const seen = r.read!.enemiesOnMinimap
			if (seen.length === hand.enemies.length) enemyExact++
			if (Math.abs(seen.length - hand.enemies.length) <= 1) enemyWithin1++
			if ([...seen].sort().join(",") === [...hand.enemies].sort().join(",")) zonesExact++
			const coarse = (z: Zone[]) => z.map(coarseOf).sort().join(",")
			if (coarse(seen) === coarse(hand.enemies)) coarseExact++
			if (r.read!.you === hand.you) youExact++
			if (
				(r.read!.you === null) === (hand.you === null) &&
				(hand.you === null || coarseOf(r.read!.you!) === coarseOf(hand.you))
			)
				youCoarse++
			if (r.enemyPoints !== null)
				for (const m of matchIcons(r.enemyPoints, HAND[r.frame]!.enemies)) {
					errors.push(m.error)
					iconN++
					if (m.zone === m.wantZone) iconZone++
					if (coarseOf(m.zone) === coarseOf(m.wantZone)) iconSide++
				}
		}
		if (handN > 0) {
			console.log(`   vs hand labels (${handN} reads over ${Object.keys(HAND).length} frames)`)
			console.log(`     enemy count exact         ${pct(enemyExact, handN)}`)
			console.log(`     enemy count within 1      ${pct(enemyWithin1, handN)}`)
			console.log(`     every enemy zone right    ${pct(zonesExact, handN)}`)
			console.log(`     every enemy SIDE right    ${pct(coarseExact, handN)}`)
			console.log(`     his own zone right        ${pct(youExact, handN)}`)
			console.log(`     his own SIDE right        ${pct(youCoarse, handN)}`)
			if (iconN > 0) {
				console.log(`     per matched icon: zone  ${pct(iconZone, iconN)}`)
				console.log(`     per matched icon: side  ${pct(iconSide, iconN)}`)
			}
			if (errors.length > 0) {
				const sorted = [...errors].sort((a, b) => a - b)
				console.log(
					`     where an icon was, off by ${Math.round(sorted[Math.floor(sorted.length / 2)]!)}% of the map (median of ${sorted.length} matched icons)`
				)
			}
		}
		console.log("")
	}
}

/*
 * Only when run, never when imported. `src/review/frame-read.test.ts` imports the scorers from here
 * — `pnpm test` runs the `src` glob and nothing else, so a probe's scorer is only pinned if the test
 * can import it, and without this guard importing it would try to mint a key and start a run.
 */
if (import.meta.main) await main()
