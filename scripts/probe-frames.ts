/**
 * How should the live coach's PICTURE be cut? Measured, not assumed.
 *
 * The page sends one downscaled JPEG of the whole monitor per turn and nobody had ever checked
 * what a model can actually READ off it. That matters more than it sounds: the graded run of 52
 * lines found 14 false ones, and reading the frames behind them showed the model getting his mana,
 * his gold and what he was doing wrong — not inventing coaching out of nothing, but coaching a
 * screen it had misread.
 *
 * So this measures READING, never coaching. The system prompt here is a neutral reader's, NOT
 * `liveCoachSystemPrompt` — which is why it goes through `modelHandleFor` rather than `coachTurn`
 * (whose invariant is that its system prompt is not a parameter). Four treatments over the same
 * real journal frames:
 *
 *   A  the frame exactly as shipped today
 *   B  the frame + a native-resolution minimap crop, upscaled  (same rect as `grabMinimap`)
 *
 * RESULT, kept here because it is the only place it survives: over three real journal frames from
 * game 5635467422, 21 hand-read HUD facts per treatment, gemini-3.6-flash standing in for the
 * socket's model family — the frame alone scored 20/21, and frame+minimap, frame+previous-frame
 * and frame+HUD-crop each scored 21/21. That is a CEILING, not a separation: the evidence is thin
 * and picks no winner. A `grabTurnImages` helper pairing the frame with the crop was written on the
 * strength of it, never wired to anything, and has been removed — a second image is about 1,089
 * extra tokens a turn against a difference of one fact in twenty-one, and the socket had an
 * unexplained latency regression open at the time. The minimap DOES reach the coach, by the other
 * route: `ScreenCoach.readMinimap` posts the crop to `/api/live/frame-read` and the read lands in
 * the payload's NOW line as `Picture: ...`. The previous-frame and HUD-strip treatments are the
 * ones worth measuring next, on questions that are not already at the ceiling.
 *   C  the frame + the frame ~5s earlier, so motion is visible
 *   D  the frame + a native-resolution crop of the HUD strip (bars, items, gold)
 *
 * Ground truth is hand-read from the images by a human/agent with the Read tool and written into
 * `FRAMES` below — the numbers are the ones printed on his HUD, so they are checkable by anyone
 * who opens the same file. n is SMALL (three frames, one game) and every report from this must say
 * so out loud.
 *
 * Run: node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *        scripts/probe-frames.ts [--provider gemini-http] [--model gemini-3.6-flash]
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MINIMAP_REGION } from "../src/review/frame-read.ts"
import { modelHandleFor, providerById, providerKey } from "../src/review/live-providers.ts"

const JOURNAL = "data/journal/js-mtn2jrku-8ae9"

/** The HUD strip: his bars, abilities, items and gold. Fractions of the frame, measured off it. */
const HUD_REGION = { left: 0.18, top: 0.855, width: 0.55, height: 0.145 }

/** Four times native, the same trade `grabMinimap` already took: more readable, same tile budget. */
const CROP_READ_PX = 1152

interface Truth {
	mana: string
	gold: number
	cs: number
	hpFull: boolean
	atBase: boolean
	banner: boolean
	deadAllies: number
}

interface Frame {
	clock: string
	/** Journal index; the file is `${JOURNAL}/js-mtn2jrku-8ae9-${index}.jpg`. */
	index: number
	truth: Truth
}

/*
 * Hand-read from the three images. Every figure is printed on his own HUD in the frame, so a
 * disagreement here is a typo somebody can settle by opening the file — not a judgement call.
 */
const FRAMES: Frame[] = [
	{
		clock: "4:32",
		index: 2730,
		truth: { mana: "227/523", gold: 313, cs: 34, hpFull: false, atBase: false, banner: false, deadAllies: 0 }
	},
	{
		clock: "6:08",
		index: 3683,
		// The Hextech drake banner is across the middle of this one — the "banner" case.
		truth: { mana: "186/564", gold: 788, cs: 46, hpFull: false, atBase: false, banner: true, deadAllies: 0 }
	},
	{
		clock: "6:43",
		index: 4034,
		// Dead and respawned: in the fountain, full bars, two allies still on a respawn timer.
		truth: { mana: "564/564", gold: 34, cs: 46, hpFull: true, atBase: true, banner: false, deadAllies: 2 }
	}
]

const READER_SYSTEM = `You are reading a screenshot of a League of Legends game as carefully as you can.
Answer ONLY about what is visible in the images. Never guess from what is likely in a game of League.
If you cannot read something, answer "unknown" for that field rather than inventing a value.
Return STRICT JSON, no markdown fence, with exactly these keys:
{"mana":"<current>/<max> from the player's own blue bar","gold":"<the player's gold number>","cs":"<the player's creep score, the number by the minion icon top right>","hpFull":"yes|no|unknown (is the player's own health bar completely full?)","atBase":"yes|no|unknown (is the player standing in his own fountain / base?)","banner":"yes|no|unknown (is an objective announcement banner, e.g. a dragon or herald kill, drawn across the screen?)","deadAllies":"<how many ally portraits on the right edge show a respawn countdown number instead of a health bar>"}`

const args = process.argv.slice(2)
const argOf = (name: string, fallback: string) => {
	const i = args.indexOf(`--${name}`)
	return i >= 0 && args[i + 1] ? args[i + 1]! : fallback
}
const providerId = argOf("provider", "gemini-http")
const modelId = argOf("model", "")

const framePath = (index: number) => `${JOURNAL}/js-mtn2jrku-8ae9-${index}.jpg`
const dataUrl = (path: string) => `data:image/jpeg;base64,${readFileSync(path).toString("base64")}`

const tmp = mkdtempSync(join(tmpdir(), "probe-frames-"))
let cropSeq = 0
/** Crop by FRACTIONS of the source and upscale, with ffmpeg — the only image tool on this box. */
const crop = (path: string, r: { left: number; top: number; width: number; height: number }) => {
	const out = join(tmp, `crop-${cropSeq++}.jpg`)
	const filter = `crop=iw*${r.width}:ih*${r.height}:iw*${r.left}:ih*${r.top},scale=${CROP_READ_PX}:-1:flags=lanczos`
	execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", path, "-vf", filter, "-q:v", "2", out])
	return dataUrl(out)
}

/*
 * The neighbour ~5s back. Journal indices run at about 10 per second of game clock, but only about
 * a third of them were kept, so the nearest EXISTING file below the target is the honest choice —
 * the treatment is "a frame a few seconds ago", not "a frame exactly 5.0s ago".
 */
const available = readdirSync(JOURNAL)
	.map(f => Number(f.replace(/^.*-(\d+)\.jpg$/, "$1")))
	.filter(n => Number.isFinite(n))
	.sort((a, b) => a - b)
const earlierIndex = (index: number) => {
	const target = index - 50
	let best = available[0]!
	for (const n of available) if (n <= target && n > best) best = n
	return best
}

type Treatment = "A-frame" | "B-frame+minimap" | "C-frame+prev" | "D-frame+hud"

const imagesFor = (t: Treatment, f: Frame): string[] => {
	const main = dataUrl(framePath(f.index))
	if (t === "A-frame") return [main]
	if (t === "B-frame+minimap") return [main, crop(framePath(f.index), MINIMAP_REGION)]
	if (t === "C-frame+prev") return [main, dataUrl(framePath(earlierIndex(f.index)))]
	return [main, crop(framePath(f.index), HUD_REGION)]
}

const promptFor = (t: Treatment): string => {
	if (t === "B-frame+minimap")
		return "Image 1 is the full screen. Image 2 is the minimap from the same instant, enlarged. Answer about image 1, using image 2 wherever it is clearer."
	if (t === "C-frame+prev")
		return "Image 1 is the screen NOW. Image 2 is the same screen about five seconds EARLIER. Answer about image 1; image 2 is only there to show what has changed."
	if (t === "D-frame+hud")
		return "Image 1 is the full screen. Image 2 is the bottom HUD strip from the same instant, enlarged. Answer about image 1, using image 2 wherever it is clearer."
	return "Answer about this screenshot."
}

const digits = (s: string) => (s.match(/-?\d+/g) ?? []).join("/")
const yes = (s: string) => /^y/i.test(s.trim())

/** One graded field. `got` is kept verbatim so a wrong answer can be read, not just counted. */
interface Graded {
	field: string
	ok: boolean
	want: string
	got: string
}

const grade = (truth: Truth, a: Record<string, string>): Graded[] => {
	const g = (field: string, want: string, got: string, ok: boolean): Graded => ({ field, ok, want, got })
	const s = (k: string) => String(a[k] ?? "missing").trim()
	return [
		g("mana", truth.mana, s("mana"), digits(s("mana")) === truth.mana.replace("/", "/")),
		g("gold", String(truth.gold), s("gold"), Number(digits(s("gold"))) === truth.gold),
		g("cs", String(truth.cs), s("cs"), Number(digits(s("cs"))) === truth.cs),
		g("hpFull", String(truth.hpFull), s("hpFull"), yes(s("hpFull")) === truth.hpFull),
		g("atBase", String(truth.atBase), s("atBase"), yes(s("atBase")) === truth.atBase),
		g("banner", String(truth.banner), s("banner"), yes(s("banner")) === truth.banner),
		g("deadAllies", String(truth.deadAllies), s("deadAllies"), Number(digits(s("deadAllies"))) === truth.deadAllies)
	]
}

const main = async () => {
	const p = providerById(providerId)
	if (!p) throw new Error(`no provider called ${providerId}`)
	const key = providerKey(p)
	if (!key) throw new Error(`no key — put one in data/${p.keyFile}`)
	const model = modelId || p.defaultModel
	const handle = await modelHandleFor(p, key, model)
	const { generateText } = await import("ai")

	const treatments: Treatment[] = ["A-frame", "B-frame+minimap", "C-frame+prev", "D-frame+hud"]
	const rows: { t: Treatment; correct: number; total: number; misses: string[]; ms: number }[] = []

	for (const t of treatments) {
		let correct = 0
		let total = 0
		let ms = 0
		const misses: string[] = []
		for (const f of FRAMES) {
			const images = imagesFor(t, f)
			const started = Date.now()
			let answer: Record<string, string> = {}
			let raw = ""
			try {
				const res = await generateText({
					model: handle,
					system: READER_SYSTEM,
					messages: [
						{
							role: "user",
							content: [
								...images.map(image => ({ type: "image" as const, image })),
								{ type: "text" as const, text: promptFor(t) }
							]
						}
					],
					maxOutputTokens: 2000
				})
				raw = (res.text ?? "").trim()
				answer = JSON.parse(raw.replace(/^```(?:json)?/, "").replace(/```$/, "").trim())
			} catch (e) {
				misses.push(`${f.clock} whole turn failed: ${e instanceof Error ? e.message : String(e)}${raw ? ` (said: ${raw.slice(0, 120)})` : ""}`)
			}
			ms += Date.now() - started
			for (const gr of grade(f.truth, answer)) {
				total++
				if (gr.ok) correct++
				else misses.push(`${f.clock} ${gr.field}: said "${gr.got}", is ${gr.want}`)
			}
		}
		rows.push({ t, correct, total, misses, ms })
		console.log(`${t}\t${correct}/${total}\t${Math.round(ms / FRAMES.length)}ms/turn`)
		for (const m of misses) console.log(`   ${m}`)
	}

	console.log(`\nn = ${FRAMES.length} frames from one game, ${rows[0]!.total} graded fields per treatment. Thin.`)
	console.log(`provider ${providerId} model ${model}`)
	console.log(JSON.stringify({ provider: providerId, model, frames: FRAMES.map(f => f.index), rows }, null, "\t"))
}

await main()
