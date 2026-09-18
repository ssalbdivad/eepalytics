/**
 * What the screenshot is worth, measured with an instrument that can actually see it.
 *
 * ## Why this file exists beside `frame-value.ts`
 *
 * `frame-value.ts` asked the right question with the wrong yardstick and said so in its own
 * output. It graded each spoken line `useful` / `false` and compared the rates between arms — and
 * then measured its own noise floor with `--agree`: run the SAME arm twice, same window, same
 * prompt, true difference exactly zero, and its verdicts agree with themselves on **13 of 30**
 * turns for `useful` and 15 of 30 for `false`. At that discordance McNemar needs roughly nine of
 * ten discordant turns to fall one way before it prints a small p, i.e. about **27 points of
 * useful-rate on one game**. The ablation came back null, and null on that instrument means
 * "nothing bigger than a quarter of the scale", which is not an answer to whether the picture is
 * worth 30% of the prompt bill.
 *
 * The noise is not the judge being sloppy. It is the coach: a live coach asked the same question
 * twice writes two different sentences about two different things, both defensible, and a verdict
 * about the WHOLE SENTENCE inherits all of that variance. So the fix is not a better judge or more
 * games. It is a question whose answer does not depend on which of several true things the coach
 * decided to say.
 *
 * ## The instrument: forced-choice frame identification
 *
 * For each turn, two arms are run that are identical in every respect except the picture: one gets
 * the REAL frame for that instant, the other gets a DECOY — a frame from the same game at least
 * five minutes away. Same payload text, same system prompt, same thread position, same wall clock,
 * interleaved on the same round. Then a judge is shown ONE screenshot and BOTH sentences, with no
 * payload, no clock and no labels, and must answer a single question:
 *
 *     which of these two sentences was written by someone looking at this screenshot?
 *
 * Every trial is run in BOTH directions — once showing the real frame, where the correct answer is
 * the real-frame arm's line, and once showing the decoy, where the correct answer is the decoy
 * arm's line. That mirror is not decoration, it is what makes the null exact. A judge that simply
 * picks whichever sentence sounds less grounded scores 100% in one direction and 0% in the other
 * and lands on 50% pooled, which is also where a coach that never opened the picture lands. So
 * **50% is the null, and it is a null by construction rather than by assumption.**
 *
 * The power is a different order of magnitude from a verdict rate. A verdict has to survive the
 * coach choosing a different subject; a forced choice only has to survive the coach's sentence
 * carrying ANY trace of which picture it saw. Against a 50% null, ~130 trials clustered in ~65
 * turns separates 65% from chance with about 85% power and 62% with about 60% — where the verdict
 * instrument needed 27 points. That is the whole reason this file exists, and the run prints the
 * calculation beside the result rather than leaving it to a reader.
 *
 * ## What it does NOT answer
 *
 * Discriminability is a NECESSARY condition for the picture to be worth anything and not a
 * sufficient one: a coach could read the frame, be changed by it, and be changed for the worse.
 * That is why `useful` / `false` is still graded here, with `frame-value.ts`'s own judge prompt
 * imported byte-for-byte so the rates sit beside the stored ones — and with its power stated as
 * the floor it is. Read the two together: discrimination says whether the picture reaches the
 * sentence, the verdicts say whether that was a good thing, and only the first of them is powered.
 *
 * ## The arms
 *
 *   `full`    THE SHIPPED PATH — the whole 1536x864 frame, real, every turn.
 *   `fullD`   the same, with a decoy frame. The read-through control, and `full`'s pair.
 *   `none`    no picture at all. The ablation.
 *   `map`     the 288px minimap square alone, upscaled 4x — `minimapRect`, the same crop
 *             `minimap-watch.ts` sends the reader. Real.
 *   `mapD`    that crop, from a decoy frame. `map`'s pair.
 *   `hud`     the bottom HUD band alone, upscaled 2x: his health, his mana, his abilities, his
 *             ITEM and SUMMONER cooldowns. Chosen because those cooldowns are the one thing on his
 *             screen that the Live Client Data feed genuinely cannot supply — AGENTS.md lists
 *             summoner timers among the things the app must refuse to guess.
 *   `hudD`    that crop, from a decoy frame. `hud`'s pair.
 *   `full2`   `full` a second time, in the same run. THE NOISE FLOOR.
 *   `sparse`  the real whole frame on every THIRD turn and nothing on the others. The cost lever,
 *             and the only one there is: a crop does NOT cost less than a frame (see below).
 *
 * ## The one cost fact that decides the shape of the recommendation
 *
 * A smaller picture is not a cheaper picture. Gemini pads a small image to the same tile budget:
 * `frame-read.ts` measured 1,089 image tokens for the 288px minimap crop, 1,089 for that same crop
 * upscaled to 1152px, and 1,100 for the whole 1536x864 frame. So `map` and `hud` are quality
 * candidates, never savings, and the ONLY way to cut the frame share of the bill is to send fewer
 * pictures. That is `sparse`, and it is why cadence is an arm rather than an afterthought.
 *
 * ## Schedule
 *
 * `level: "commentary"`, named out loud, for the two reasons AGENTS.md gives: it is the schedule
 * every stored measurement in this repo was taken on, and it is the only one that produces enough
 * turns to measure anything. The SHIPPED schedule is `big-calls` at ~8.5 asks a game, so every
 * per-game cost in this report is restated for both.
 *
 * ## Corpus
 *
 * Frames exist for three games, not twenty-eight. `discoverBenchable()` returns 3 paired windows
 * and 37 text-only ones, and a text-only window cannot answer a question about a picture at all.
 * Two of the three are whole games with frames throughout (5639406342, Lillia into Kayn, 28:14,
 * 333 frames; 5639409343, Lillia into Fiddlesticks, 31:15, 370 frames) and the third has four
 * minutes of frames on a 37-minute game. So "use more games" has a hard ceiling of two, and the
 * power had to come from the instrument. It did.
 *
 * ## Usage
 *
 *     node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *       scripts/frame-power.ts --pics full,fullD,none --turns 6 --dry
 *
 *     --windows a,b        which paired windows to replay (default: the two whole-game ones)
 *     --pics a,b,c         which picture arms to run. NOT `--arms`: this file imports the socket
 *                          driver out of `frame-value.ts`, whose own module-level `--arms` parse
 *                          runs on import and throws on a name it does not know
 *     --turns N            cap the turns per window
 *     --judge <provider>   who grades (default anthropic). `--judge none` runs the sockets only
 *     --judge-model <id>   free text, as everywhere in this app
 *     --no-verdicts        skip the useful/false pass, keep the forced choice
 *     --no-choice          skip the forced choice, keep the verdicts
 *     --no-read            no minimap pre-pass, so no turn carries a position
 *     --dry                no network and no bill: every arm echoes the payload's first bullet
 *     --out <path>         where the run JSON goes
 *     --summarize <path>   re-print and re-score a stored run without calling anything
 *     --verdicts <path>    grade a stored run's lines that have no verdict yet, checkpointing after
 *                          every turn, and write the file back. The socket/turn calls in a stored
 *                          run are already paid for; a judging pass that dies should never cost
 *                          them again, and the first version of this file lost a whole verdict pass
 *                          exactly that way
 *     --rechoose <path>    re-ask a stored run's OWN forced-choice trials of a different judge, and
 *                          write a NEW file beside it. This is the instrument's own reliability
 *                          check — `frame-value.ts` needed a whole second socket run to measure its
 *                          noise floor, and this one needs no coach at all, because the trials are
 *                          already written down. The original file is never touched
 *     --stored <path>      run the FORCED CHOICE over a stored `frame-value.ts` run's own lines,
 *                          at zero socket cost. That run already holds a `frame` arm and a `decoy`
 *                          arm over 31 paired turns of game 5639406342, said on the payload of
 *                          2026-09-11 — a second, independent corpus for this instrument that
 *                          nobody has to pay for twice, and the only way to ask the question of
 *                          the OLD payload now that the old payload is gone
 *
 * DO NOT run this while a game is in progress: it holds several Gemini Live sockets at once and the
 * live coach wants one of them. NODE ONLY.
 */

import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DATA_DIR } from "../src/shared/constants.ts"
import { buildStream, discoverWindows, clockText } from "./lib/stream.ts"
import type { BuiltStream, PairedFrame, StreamTurn, StreamWindow } from "./lib/stream.ts"
import { HEARTBEAT_SEC } from "../src/analysis/live-events.ts"
import { protocolFor, readWhere } from "./bench-stream.ts"
import type { Arm, TurnWhere } from "./bench-stream.ts"
import { JUDGE_SYSTEM, openArm } from "./frame-value.ts"
import type { OpenArm } from "./frame-value.ts"
import { socketSystemPrompt } from "../src/server/routes/live.ts"
import { GEMINI_LIVE_MODEL } from "../src/review/gemini-live.ts"
import { fullKnowledge } from "../src/review/live-knowledge-full.ts"
import { MINIMAP_REGION } from "../src/review/frame-read.ts"
import { modelHandleFor, providerById, providerKey } from "../src/review/live-providers.ts"
import { wilson } from "../src/analysis/coach-score.ts"
import { mcnemar, mulberry32, shuffled } from "./lib/stats.ts"

/* ================================================================== arguments */

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : fallback
}
const has = (name: string): boolean => argv.includes(`--${name}`)

/** The two paired windows that cover a WHOLE game. The third has four minutes of frames. */
const DEFAULT_WINDOWS = "js-mtvxb5f4-f81a-t29817812,js-mtvxb5f4-f81a-t29817845"

const windowsArg = arg("windows", DEFAULT_WINDOWS)
const armsArg = arg("pics", "full,fullD,none,map,mapD")
const turnsWanted = Number(arg("turns", "999"))
const judgeProvider = arg("judge", "anthropic")
const judgeModelArg = arg("judge-model", "")
const wantVerdicts = !has("no-verdicts") && judgeProvider !== "none"
const wantChoice = !has("no-choice") && judgeProvider !== "none"
const noRead = has("no-read")
const dry = has("dry")
const summarize = arg("summarize", "")
const stored = arg("stored", "")
const rechoose = arg("rechoose", "")
const verdictsOf = arg("verdicts", "")
/**
 * SOCKET or TURN, and they are different experiments rather than two settings of one.
 *
 * `socket` is the shipped live coach: one Gemini Live session per game, a thread the model keeps,
 * native audio. `turn` is `coachTurn` — one stateless HTTPS call per beat through the AI SDK, which
 * is how every non-Google model in this app is reachable, because no Anthropic model on this key
 * serves a live audio socket at all. A turn arm ALWAYS resyncs a full brief (`protocolFor` sees
 * `shape: "turn"`), it has no thread, and therefore it has none of the socket's frame compounding.
 * A number from one shape may not be printed in the same column as a number from the other, which
 * is why the shape is written into the run file rather than inferred from the provider.
 */
const shape: "socket" | "turn" = arg("shape", "socket") === "turn" ? "turn" : "socket"
const coachProvider = arg("provider", "gemini-live")
const coachModel = arg("model", "")

/* ==================================================================== the arms */

/** What rides with the turn. `full+map` is what `useScreenShare` already produces for the page. */
type Pic = "none" | "full" | "map" | "hud" | "full+map"

interface PicArm {
	id: string
	pic: Pic
	source: "real" | "decoy"
	/** 1 = a picture every turn. 3 = every third turn and nothing on the other two. */
	cadence: number
	/** The arm this one is the decoy twin of, for the forced choice. Null when it has no twin. */
	twinOf: string | null
	what: string
}

const ARMS: readonly PicArm[] = [
	{ id: "full", pic: "full", source: "real", cadence: 1, twinOf: null, what: "THE SHIPPED PATH" },
	{ id: "fullD", pic: "full", source: "decoy", cadence: 1, twinOf: "full", what: "whole frame, wrong minute" },
	/*
	 * `full` a SECOND TIME, byte-identical, and it is the most important arm in the table.
	 *
	 * `frame-value.ts` had to run its noise floor as a separate invocation (`--agree`), which means
	 * the floor was measured on a different afternoon from the effects it was the floor FOR. Here it
	 * is an arm: same round, same rotation, same wall clock, true difference exactly zero. Any
	 * verdict gap between `full` and `full2` is the instrument talking, and no gap smaller than it
	 * may be read as a finding anywhere else on the page.
	 */
	{ id: "full2", pic: "full", source: "real", cadence: 1, twinOf: null, what: "THE NOISE FLOOR — `full` again" },
	{ id: "none", pic: "none", source: "real", cadence: 1, twinOf: null, what: "no picture at all" },
	{ id: "map", pic: "map", source: "real", cadence: 1, twinOf: null, what: "the minimap crop, 4x, alone" },
	{ id: "mapD", pic: "map", source: "decoy", cadence: 1, twinOf: "map", what: "that crop, wrong minute" },
	{ id: "hud", pic: "hud", source: "real", cadence: 1, twinOf: null, what: "the HUD band, 2x, alone" },
	{ id: "hudD", pic: "hud", source: "decoy", cadence: 1, twinOf: "hud", what: "that band, wrong minute" },
	{ id: "both", pic: "full+map", source: "real", cadence: 1, twinOf: null, what: "frame AND minimap crop" },
	{ id: "bothD", pic: "full+map", source: "decoy", cadence: 1, twinOf: "both", what: "both, wrong minute" },
	{ id: "sparse", pic: "full", source: "real", cadence: 3, twinOf: null, what: "the frame every third turn" }
]

const chosen: PicArm[] = armsArg
	.split(",")
	.map(s => s.trim())
	.filter(s => s !== "")
	.map(id => {
		const a = ARMS.find(x => x.id === id)
		if (!a) throw new Error(`no arm called ${id}; have ${ARMS.map(x => x.id).join(",")}`)
		return a
	})

/**
 * The `Arm` the shipped protocol builder expects.
 *
 * `mode: "trusted"`, `shape: "socket"`, `knowledge: "full"` because that is the shipped path and
 * the only one this file benches. `vision` is carried so `protocolFor` sees the same arm shape
 * `bench-stream.ts` sees; the image is attached by the pump below, never by the protocol.
 */
const asBenchArm = (a: PicArm): Arm => ({
	id: a.id,
	provider: shape === "turn" ? coachProvider : "gemini-live",
	model: shape === "turn" ? coachModel : GEMINI_LIVE_MODEL,
	mode: "trusted",
	shape,
	trim: null,
	add: null,
	knowledge: "full",
	vision: a.pic !== "none",
	available: true,
	unavailable: ""
})

/* ===================================================================== crops */

/**
 * The HUD band, as fractions of the frame, measured the way `MINIMAP_REGION` was — by opening a
 * real 1536x864 journal frame and reading the rectangle off it.
 *
 * It runs x 280..1130 and y 730..864: the champion panel and its per-minute stats on the left, the
 * portrait and level, the five ability boxes with their cooldowns, the two SUMMONER boxes with
 * theirs, the health and mana bars with their regen, the six item slots and the gold counter. The
 * top-right score strip (score, KDA, CS, game clock) is deliberately NOT in it — every number up
 * there is already in the payload, so including it would blur what this arm is testing.
 *
 * What is in this band and in no channel the app has: his exact health and mana, his ability
 * cooldowns, his item cooldowns and his SUMMONER SPELL cooldowns. AGENTS.md lists summoner timers
 * among the things the coach must refuse to guess because the client will not tell it. His own are
 * on his own screen.
 */
const HUD_REGION = {
	left: 280 / 1536,
	top: 730 / 864,
	width: 850 / 1536,
	height: 134 / 864
} as const

/** Matching `minimap-watch.ts`: the model reads a bigger picture of the same pixels better. */
const MAP_UPSCALE = 4
const HUD_UPSCALE = 2

const CROP_DIR = `${DATA_DIR}/eval/frame-power-crops`
const cropCache = new Map<string, string | null>()

/**
 * One crop, through ffmpeg, cached on disk so a re-run of the same window does not re-encode 700
 * JPEGs. Proportional fractions rather than a pixel rectangle, for `cropMinimap`'s reason: a frame
 * at another size then gets the same crop instead of a rectangle measured for a screen it has not
 * got. Null on any failure, and a null is COUNTED by the caller rather than silently sent blind.
 */
const crop = async (framePath: string, kind: "map" | "hud"): Promise<string | null> => {
	const key = `${kind}:${framePath}`
	const cached = cropCache.get(key)
	if (cached !== undefined) return cached
	const region = kind === "map" ? MINIMAP_REGION : HUD_REGION
	const scale = kind === "map" ? MAP_UPSCALE : HUD_UPSCALE
	const out = `${CROP_DIR}/${kind}-${framePath.split("/").pop()}`
	if (existsSync(out)) {
		const b64 = readFileSync(out).toString("base64")
		cropCache.set(key, b64)
		return b64
	}
	const filter =
		`crop=iw*${region.width}:ih*${region.height}:iw*${region.left}:ih*${region.top},` +
		`scale=iw*${scale}:ih*${scale}:flags=lanczos`
	const b64 = await new Promise<string | null>(resolve => {
		execFile(
			"ffmpeg",
			["-y", "-loglevel", "error", "-i", framePath, "-vf", filter, "-q:v", "4", out],
			{ timeout: 15_000 },
			err => {
				if (err || !existsSync(out)) return resolve(null)
				resolve(readFileSync(out).toString("base64"))
			}
		)
	})
	cropCache.set(key, b64)
	return b64
}

/* ============================================================== the decoy frame */

/**
 * A frame from the SAME game and a DIFFERENT minute, as far away as the window allows.
 *
 * The selection rule is `decoyFor`'s in `frame-value.ts`, unchanged — furthest readable frame at
 * least five minutes away — so a decoy here is the same kind of object the stored ablation used.
 * This one hands back the FRAME rather than its bytes, because the crop arms need a path to feed
 * ffmpeg and the forced-choice judge needs to be shown the decoy's whole picture.
 */
const DECOY_MIN_GAP_SEC = 300

const decoyFrameFor = (turn: StreamTurn, window: StreamWindow): PairedFrame | null => {
	let best: { f: PairedFrame; gap: number } | null = null
	for (const f of window.frames) {
		const gap = Math.abs(f.tSec - turn.atSec)
		if (gap < DECOY_MIN_GAP_SEC) continue
		if (best !== null && gap <= best.gap) continue
		try {
			readFileSync(f.path)
			best = { f, gap }
		} catch {
			/* a frame whose bytes will not read is not a decoy, it is a hole */
		}
	}
	return best === null ? null : best.f
}

/* =================================================================== the record */

export interface PowerCall {
	window: string
	gameId: string
	arm: string
	index: number
	atSec: number
	clock: string
	text: string
	spoke: boolean
	latencyMs: number
	/** What rode with this turn: how many image parts, from which frame, and how big. */
	images: number
	pic: Pic
	source: "real" | "decoy"
	realFramePath: string | null
	sentFramePath: string | null
	sentFrameTSec: number | null
	imageB64Chars: number
	payloadChars: number
	payloadKind: string
	promptTokens: number | null
	responseTokens: number | null
	threadTurn: number
	recycled: boolean
	error: string | null
}

/** One forced-choice trial: one picture, two sentences, one answer. */
export interface ChoiceTrial {
	window: string
	index: number
	clock: string
	/** The pair under test, e.g. `full`/`fullD`. */
	realArm: string
	decoyArm: string
	/** Which picture the judge was shown. The correct answer is that picture's own arm. */
	shown: "real" | "decoy"
	shownPath: string
	/** The two sentences, in the order the judge saw them. */
	a: { arm: string; text: string }
	b: { arm: string; text: string }
	pick: "A" | "B" | null
	confidence: string
	correct: boolean | null
	why: string
	error: string | null
}

export interface Graded {
	window: string
	arm: string
	index: number
	clock: string
	text: string
	verdict: string
	framePower: string
	why: string
}

export interface RunFile {
	ranAt: string
	argv: string[]
	level: string
	shape: "socket" | "turn"
	coach: { provider: string; model: string }
	arms: PicArm[]
	windows: { id: string; gameId: string; champion: string; turns: number; framed: number }[]
	judge: { provider: string; model: string } | null
	calls: PowerCall[]
	trials: ChoiceTrial[]
	graded: Graded[]
}

/* ==================================================================== the pump */

const runWindow = async (
	window: StreamWindow,
	stream: BuiltStream,
	wheres: Map<number, TurnWhere> | undefined,
	arms: readonly PicArm[]
): Promise<{ calls: PowerCall[]; decoys: Map<number, PairedFrame | null> }> => {
	const counterpart = stream.turns.find(t => t.counterpart !== null)?.counterpart ?? null
	const knowledge = fullKnowledge({ champion: window.champion, counterpart })
	const system = socketSystemPrompt({ mode: "trusted", championKnowledge: knowledge })

	const protos = new Map(arms.map(a => [a.id, protocolFor(asBenchArm(a), stream, wheres)]))
	const decoys = new Map<number, PairedFrame | null>()
	for (const t of stream.turns) decoys.set(t.index, decoyFrameFor(t, window))

	/*
	 * EVERY image this window needs, built before the first socket opens.
	 *
	 * ffmpeg takes ~125ms a crop and a socket turn takes ~1.2s, so cropping inside the pump would
	 * put a tenth of a turn of dead air between two arms of the same round — small, but it is
	 * exactly the kind of asymmetry the interleaving exists to remove, and it would fall on the
	 * crop arms only.
	 */
	const needed = new Set<string>()
	for (const a of arms) {
		if (a.pic !== "map" && a.pic !== "hud" && a.pic !== "full+map") continue
		for (const t of stream.turns) {
			const f = a.source === "decoy" ? decoys.get(t.index) : t.frame
			if (f) needed.add(`${a.pic === "hud" ? "hud" : "map"}:${f.path}`)
		}
	}
	if (needed.size > 0) {
		mkdirSync(CROP_DIR, { recursive: true })
		process.stdout.write(`cropping ${needed.size} image(s)…`)
		for (const n of needed) {
			const kind = n.slice(0, 3) as "map" | "hud"
			await crop(n.slice(4), kind)
		}
		const failed = [...needed].filter(n => cropCache.get(n) === null).length
		process.stdout.write(` done${failed > 0 ? `, ${failed} FAILED` : ""}\n`)
	}

	/** The image parts for one arm on one turn, in the order they are sent. */
	const partsFor = async (a: PicArm, t: StreamTurn, round: number): Promise<{ b64: string; of: PairedFrame }[]> => {
		if (a.pic === "none") return []
		if (round % a.cadence !== 0) return []
		const f = a.source === "decoy" ? (decoys.get(t.index) ?? null) : t.frame
		if (f === null) return []
		const out: { b64: string; of: PairedFrame }[] = []
		if (shape === "turn" && a.pic === "full+map")
			throw new Error("`full+map` needs two images and the turn path carries one; run it on the socket")
		if (a.pic === "full" || a.pic === "full+map") {
			const b64 = a.source === "decoy" ? readFileSync(f.path).toString("base64") : t.frameB64
			if (b64 !== null) out.push({ b64, of: f })
		}
		if (a.pic === "map" || a.pic === "full+map") {
			const b64 = await crop(f.path, "map")
			if (b64 !== null) out.push({ b64, of: f })
		}
		if (a.pic === "hud") {
			const b64 = await crop(f.path, "hud")
			if (b64 !== null) out.push({ b64, of: f })
		}
		return out
	}

	const sockets = new Map<string, OpenArm>()
	const calls: PowerCall[] = []
	if (!dry && shape === "socket")
		for (const a of arms) {
			sockets.set(a.id, await openArm(`${window.id}/${a.id}`, system))
			process.stdout.write(`opened ${a.id}\n`)
		}

	try {
		for (const [round, turn] of stream.turns.entries()) {
			/* The arm order rotates, so no arm is permanently the one sent first after the pause. */
			const order = arms.map((_, i) => arms[(i + round) % arms.length]!)
			for (const a of order) {
				const sent = protos.get(a.id)!.payload(turn)
				const images = await partsFor(a, turn, round)
				const parts: unknown[] = [
					...images.map(i => ({ inlineData: { mimeType: "image/jpeg", data: i.b64 } })),
					{ text: sent.text }
				]
				const r =
					dry ?
						{
							text: sent.text.split("\n").find(l => l.startsWith("- "))?.slice(2, 110) ?? "",
							latencyMs: 0,
							promptTokens: null,
							responseTokens: null,
							threadTurn: round,
							recycled: false,
							error: null
						}
					: shape === "turn" ?
						await (async () => {
							/*
							 * `coachTurn` carries ONE image, which is all any arm in this table needs
							 * except `full+map`. An arm that wanted two on this path would be a
							 * different experiment and is refused above rather than silently sent one.
							 */
							const { coachTurn } = await import("../src/review/live-providers.ts")
							const res = await coachTurn({
								provider: coachProvider as never,
								model: coachModel,
								blockText: sent.text,
								mode: "trusted",
								champion: window.champion,
								counterpart,
								...(images[0] ? { frameJpegBase64: images[0].b64 } : {})
							})
							return {
								text: res.text,
								latencyMs: res.latencyMs,
								promptTokens: null,
								responseTokens: null,
								threadTurn: round,
								recycled: false,
								error: res.ok ? null : (res.reason ?? "turn failed")
							}
						})()
					:	await sockets.get(a.id)!.send(turn, parts)

				const text = r.text.trim()
				const spoke = text !== "" && text.toUpperCase() !== "PASS" && r.error === null
				if (r.error === null) protos.get(a.id)!.heard(turn, text, r.latencyMs)
				calls.push({
					window: window.id,
					gameId: window.gameId,
					arm: a.id,
					index: turn.index,
					atSec: turn.atSec,
					clock: turn.clock,
					text,
					spoke,
					latencyMs: r.latencyMs,
					images: images.length,
					pic: a.pic,
					source: a.source,
					realFramePath: turn.frame?.path ?? null,
					sentFramePath: images[0]?.of.path ?? null,
					sentFrameTSec: images[0]?.of.tSec ?? null,
					imageB64Chars: images.reduce((s, i) => s + i.b64.length, 0),
					payloadChars: sent.text.length,
					payloadKind: sent.kind,
					promptTokens: r.promptTokens,
					responseTokens: r.responseTokens,
					threadTurn: r.threadTurn,
					recycled: r.recycled,
					error: r.error
				})
				process.stdout.write(
					`${turn.clock} ${a.id.padEnd(7)} ${sent.kind} ${String(images.length)}img ` +
						`${r.recycled ? "RECYCLED " : ""}${r.error ? `ERROR ${r.error}` : `${String(r.latencyMs).padStart(5)}ms`} ` +
						`${spoke ? text.slice(0, 76) : r.error ? "" : "PASS"}\n`
				)
			}
		}
	} finally {
		for (const s of sockets.values()) s.close()
	}
	return { calls, decoys }
}

/* ============================================================ the forced choice */

/**
 * The judge is told what the trial is and nothing else.
 *
 * No payload, no clock, no arm labels, no hint that one sentence came from a coach who was shown a
 * picture of a different minute. It is given the sentences in a shuffled order and one picture, and
 * the correct answer is whichever arm that picture belongs to — which is the real arm in half the
 * trials and the decoy arm in the other half, so a judge with any fixed preference between the two
 * writing styles scores exactly 50%.
 */
export const CHOICE_SYSTEM = `Two live coaches were watching the same League of Legends game and each said one sentence at the
same moment. They were given the same numbers. They were NOT looking at the same screenshot: each
was shown a different frame of the game.

You are shown ONE of those two screenshots, and both sentences. Decide which sentence was said by
the coach who was looking at THIS screenshot.

Look for anything in the sentence that ties it to what is visible here rather than to the other
frame: where he is standing, what is around him, whether he is fighting, recalling, dead, in base,
clearing a camp or alone; who is on screen; how much of his health bar is gone; what the map looks
like; how far into the game the scene is. Both sentences will sound plausible. Ignore which is
better advice and ignore which is better written — you are only matching a sentence to a picture.

You MUST pick one. If nothing in either sentence ties it to this screenshot, say so with
"confidence":"guess" and still pick one.

Reply with JSON only: {"pick":"A"|"B","confidence":"high"|"low"|"guess","why":"under 15 words"}`

type ModelHandle = Awaited<ReturnType<typeof modelHandleFor>>

const askChoice = async (
	handle: ModelHandle,
	imagePath: string,
	a: string,
	b: string
): Promise<{ pick: "A" | "B" | null; confidence: string; why: string; error: string | null }> => {
	const { generateText } = await import("ai")
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const res = await generateText({
				model: handle,
				system: CHOICE_SYSTEM,
				messages: [
					{
						role: "user",
						content: [
							{ type: "image" as const, image: readFileSync(imagePath) },
							{ type: "text" as const, text: `A: ${a}\n\nB: ${b}` }
						]
					}
				],
				maxOutputTokens: 4000
			})
			const raw = (res.text ?? "").trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim()
			const j = JSON.parse(raw) as { pick?: string; confidence?: string; why?: string }
			const pick = j.pick === "A" || j.pick === "B" ? j.pick : null
			return {
				pick,
				confidence: String(j.confidence ?? "").slice(0, 12),
				why: String(j.why ?? "").slice(0, 120),
				error: pick === null ? `judge answered "${String(j.pick).slice(0, 20)}"` : null
			}
		} catch (e) {
			if (attempt === 1)
				return { pick: null, confidence: "", why: "", error: e instanceof Error ? e.message : String(e) }
		}
	}
	return { pick: null, confidence: "", why: "", error: "fell through" }
}

/** Run the trials with a small concurrency, because each one is a separate picture. */
const runChoice = async (
	handle: ModelHandle,
	calls: readonly PowerCall[],
	decoysByWindow: Map<string, Map<number, PairedFrame | null>>,
	arms: readonly PicArm[]
): Promise<ChoiceTrial[]> => {
	const pairs = arms.filter(a => a.twinOf !== null && arms.some(x => x.id === a.twinOf))
	const want: Omit<ChoiceTrial, "pick" | "confidence" | "correct" | "why" | "error">[] = []
	for (const decoyArm of pairs) {
		const realId = decoyArm.twinOf!
		const byKey = new Map<string, PowerCall>()
		for (const c of calls) byKey.set(`${c.window}|${c.arm}|${c.index}`, c)
		for (const c of calls) {
			if (c.arm !== realId || !c.spoke) continue
			const d = byKey.get(`${c.window}|${decoyArm.id}|${c.index}`)
			if (!d || !d.spoke) continue
			if (c.realFramePath === null) continue
			const decoyFrame = decoysByWindow.get(c.window)?.get(c.index) ?? null
			if (decoyFrame === null) continue
			for (const shown of ["real", "decoy"] as const) {
				/*
				 * The A/B order is seeded per trial rather than per turn, so the two directions of
				 * one turn do not present the sentences in the same order — otherwise a judge that
				 * always answered "A" would score 100% in one direction and 0% in the other and
				 * pooled 50%, which is right, but a judge that always answered "the first one" on a
				 * turn it half-remembers would not be cancelled.
				 */
				const seed = c.index * 7919 + (shown === "real" ? 11 : 97) + realId.length * 31
				const two = shuffled(
					[
						{ arm: realId, text: c.text },
						{ arm: decoyArm.id, text: d.text }
					],
					seed
				)
				want.push({
					window: c.window,
					index: c.index,
					clock: c.clock,
					realArm: realId,
					decoyArm: decoyArm.id,
					shown,
					shownPath: shown === "real" ? c.realFramePath : decoyFrame.path,
					a: two[0]!,
					b: two[1]!
				})
			}
		}
	}

	const out: ChoiceTrial[] = []
	const CONCURRENCY = 6
	let next = 0
	let done = 0
	const worker = async (): Promise<void> => {
		while (next < want.length) {
			const t = want[next++]!
			const r = await askChoice(handle, t.shownPath, t.a.text, t.b.text)
			const picked = r.pick === "A" ? t.a.arm : r.pick === "B" ? t.b.arm : null
			const correctArm = t.shown === "real" ? t.realArm : t.decoyArm
			out.push({ ...t, ...r, correct: picked === null ? null : picked === correctArm })
			done += 1
			if (done % 20 === 0) process.stdout.write(`  forced choice ${done}/${want.length}\n`)
		}
	}
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, want.length) }, worker))
	out.sort((x, y) => x.window.localeCompare(y.window) || x.index - y.index || x.shown.localeCompare(y.shown))
	return out
}

/* ================================================================ the verdicts */

const judgeTurn = async (
	handle: ModelHandle,
	turn: StreamTurn,
	lines: readonly { id: string; arm: string; text: string }[]
): Promise<Map<string, { verdict: string; framePower: string; why: string }>> => {
	const { generateText } = await import("ai")
	const image = turn.frame === null ? null : readFileSync(turn.frame.path)
	const prompt =
		`Game clock ${turn.clock}.\n\n` +
		`## The ground-truth payload at this instant\n\n${turn.brief || turn.block}\n\n` +
		`## The candidate sentences\n\n` +
		lines.map(l => `${l.id}: ${l.text}`).join("\n")
	const res = await generateText({
		model: handle,
		system: JUDGE_SYSTEM,
		messages: [
			{
				role: "user",
				content: [
					...(image === null ? [] : [{ type: "image" as const, image }]),
					{ type: "text" as const, text: prompt }
				]
			}
		],
		maxOutputTokens: 8000
	})
	const raw = (res.text ?? "").trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim()
	const parsed = JSON.parse(raw) as { grades?: { id?: string; verdict?: string; framePower?: string; why?: string }[] }
	const asked = new Set(lines.map(l => l.id))
	const out = new Map<string, { verdict: string; framePower: string; why: string }>()
	for (const g of parsed.grades ?? []) {
		if (!g.id || !asked.has(g.id)) continue
		out.set(g.id, {
			verdict: String(g.verdict ?? "ungraded"),
			framePower: String(g.framePower ?? "unknown"),
			why: String(g.why ?? "").slice(0, 160)
		})
	}
	return out
}

const runVerdicts = async (
	handle: ModelHandle,
	window: StreamWindow,
	stream: BuiltStream,
	calls: readonly PowerCall[]
): Promise<Graded[]> => {
	const LABELS = "ABCDEFGHIJ"
	const graded: Graded[] = []
	const byTurn = new Map<number, PowerCall[]>()
	for (const c of calls) {
		if (c.window !== window.id || !c.spoke) continue
		const list = byTurn.get(c.index) ?? []
		list.push(c)
		byTurn.set(c.index, list)
	}
	for (const turn of stream.turns) {
		const spoken = byTurn.get(turn.index) ?? []
		if (spoken.length === 0) continue
		const order = shuffled(spoken, turn.index * 7919 + 13)
		const lines = order.map((c, i) => ({ id: LABELS[i]!, arm: c.arm, text: c.text }))
		let verdicts = new Map<string, { verdict: string; framePower: string; why: string }>()
		try {
			verdicts = await judgeTurn(handle, turn, lines)
		} catch (e) {
			process.stdout.write(`  verdict batch ${turn.clock} failed: ${e instanceof Error ? e.message : String(e)}\n`)
		}
		for (const l of lines) {
			const v = verdicts.get(l.id) ?? { verdict: "ungraded", framePower: "unknown", why: "judge did not answer" }
			graded.push({
				window: window.id,
				arm: l.arm,
				index: turn.index,
				clock: turn.clock,
				text: l.text,
				verdict: v.verdict,
				framePower: v.framePower,
				why: v.why
			})
		}
		process.stdout.write(`  judged ${turn.clock} (${lines.length})\n`)
	}
	return graded
}

/* ================================================================== statistics */

/** Exact two-sided binomial against p = 1/2. */
export const signTest = (k: number, n: number): number => {
	if (n === 0) return 1
	const logC = (a: number, b: number): number => {
		let s = 0
		for (let i = 1; i <= b; i++) s += Math.log(a - b + i) - Math.log(i)
		return s
	}
	let tail = 0
	const extreme = Math.min(k, n - k)
	for (let i = 0; i <= extreme; i++) tail += Math.exp(logC(n, i) - n * Math.LN2)
	return Math.min(1, 2 * tail)
}

/**
 * A percentile bootstrap that resamples TURNS, not trials.
 *
 * The two directions of one turn share a pair of sentences, so they are not independent draws and
 * a binomial interval over trials is narrower than the truth. Resampling the cluster is the cheap
 * honest fix, and the plain binomial is printed beside it so the size of the correction is visible
 * rather than assumed.
 */
export const clusterBootstrap = (
	clusters: readonly { k: number; n: number }[],
	seed = 20260918,
	iters = 4000
): { lo: number; hi: number } => {
	if (clusters.length < 2) return { lo: Number.NaN, hi: Number.NaN }
	const rand = mulberry32(seed)
	const draws: number[] = []
	for (let it = 0; it < iters; it++) {
		let k = 0
		let n = 0
		for (let i = 0; i < clusters.length; i++) {
			const c = clusters[Math.floor(rand() * clusters.length)]!
			k += c.k
			n += c.n
		}
		if (n > 0) draws.push(k / n)
	}
	draws.sort((a, b) => a - b)
	const at = (q: number): number => draws[Math.min(draws.length - 1, Math.max(0, Math.round(q * (draws.length - 1))))]!
	return { lo: at(0.025), hi: at(0.975) }
}

const pctOf = (i: { p: number; lo: number; hi: number; k: number; n: number }): string =>
	`${(100 * i.p).toFixed(0)}% [${(100 * i.lo).toFixed(0)}-${(100 * i.hi).toFixed(0)}] ${i.k}/${i.n}`

/* ==================================================================== the report */

const report = (run: RunFile): void => {
	const ids = run.arms.map(a => a.id)
	console.log(`\n${"=".repeat(86)}`)
	console.log(`frame-power — ${run.windows.map(w => `${w.gameId} (${w.turns} turns, ${w.framed} framed)`).join(", ")}`)
	console.log(`schedule level: ${run.level}   judge: ${run.judge ? `${run.judge.provider} ${run.judge.model}` : "none"}`)
	console.log(`${"=".repeat(86)}\n`)

	/* -------------------------------------------------------------- speaking */
	console.log("SPEAKING")
	console.log("  arm      turns  spoke  pass  err  recyc   p50 ms   imgs   img KB   prompt tok (last turn)")
	for (const id of ids) {
		const cs = run.calls.filter(c => c.arm === id)
		if (cs.length === 0) continue
		const spoke = cs.filter(c => c.spoke)
		const err = cs.filter(c => c.error !== null)
		const lat = spoke.map(c => c.latencyMs).sort((a, b) => a - b)
		const imgs = cs.reduce((s, c) => s + c.images, 0)
		const kb = cs.reduce((s, c) => s + c.imageB64Chars, 0) / 1024
		const lastPrompt = [...cs].reverse().find(c => c.promptTokens !== null)?.promptTokens ?? null
		console.log(
			`  ${id.padEnd(8)} ${String(cs.length).padStart(5)} ${String(spoke.length).padStart(6)} ` +
				`${String(cs.length - spoke.length - err.length).padStart(5)} ${String(err.length).padStart(4)} ` +
				`${String(cs.filter(c => c.recycled).length).padStart(6)} ${(lat.length === 0 ? "—" : String(lat[Math.floor(lat.length / 2)]!)).padStart(8)} ` +
				`${String(imgs).padStart(6)} ${kb.toFixed(0).padStart(8)} ${String(lastPrompt ?? "—").padStart(12)}`
		)
	}

	/* ------------------------------------------------- THE FORCED CHOICE */
	if (run.trials.length > 0) {
		console.log("\nFORCED-CHOICE FRAME IDENTIFICATION — can a reader tell which picture the line was said about?")
		console.log("  null is 50% BY CONSTRUCTION: every turn is asked twice, once showing each picture.\n")
		console.log("  pair            trials  correct              both-directions  p (sign)  cluster 95%")
		const pairsSeen = [...new Set(run.trials.map(t => `${t.realArm}/${t.decoyArm}`))]
		for (const pair of pairsSeen) {
			const ts = run.trials.filter(t => `${t.realArm}/${t.decoyArm}` === pair && t.correct !== null)
			if (ts.length === 0) continue
			const k = ts.filter(t => t.correct).length
			const w = wilson(k, ts.length)
			const byTurn = new Map<string, { k: number; n: number }>()
			for (const t of ts) {
				const key = `${t.window}|${t.index}`
				const c = byTurn.get(key) ?? { k: 0, n: 0 }
				c.k += t.correct ? 1 : 0
				c.n += 1
				byTurn.set(key, c)
			}
			const both = [...byTurn.values()].filter(c => c.n === 2 && c.k === 2).length
			const bothOf = [...byTurn.values()].filter(c => c.n === 2).length
			const boot = clusterBootstrap([...byTurn.values()])
			console.log(
				`  ${pair.padEnd(15)} ${String(ts.length).padStart(6)}  ${pctOf(w).padEnd(20)} ` +
					`${`${both}/${bothOf}`.padStart(15)}  ${signTest(k, ts.length).toFixed(4).padStart(8)}  ` +
					`[${(100 * boot.lo).toFixed(0)}-${(100 * boot.hi).toFixed(0)}]`
			)
		}
		console.log("\n  by direction — a judge with a fixed style preference scores 100/0 here and 50% pooled")
		for (const pair of pairsSeen) {
			for (const shown of ["real", "decoy"] as const) {
				const ts = run.trials.filter(t => `${t.realArm}/${t.decoyArm}` === pair && t.shown === shown && t.correct !== null)
				if (ts.length === 0) continue
				const w = wilson(ts.filter(t => t.correct).length, ts.length)
				console.log(`    ${pair.padEnd(15)} shown ${shown.padEnd(6)} ${pctOf(w)}`)
			}
		}
		const guesses = run.trials.filter(t => t.confidence === "guess")
		const confident = run.trials.filter(t => t.confidence === "high" && t.correct !== null)
		if (guesses.length > 0 || confident.length > 0)
			console.log(
				`\n  the judge called ${guesses.length} of ${run.trials.length} trial(s) a GUESS; on the ` +
					`${confident.length} it called HIGH confidence it was right ` +
					`${confident.length === 0 ? "—" : `${((100 * confident.filter(t => t.correct).length) / confident.length).toFixed(0)}%`}`
			)
		const failed = run.trials.filter(t => t.correct === null).length
		if (failed > 0) console.log(`  ${failed} trial(s) returned no usable pick and are OUT of every rate above.`)
	}

	/* ------------------------------------------------------------- verdicts */
	if (run.graded.length > 0) {
		console.log("\nVERDICTS — every line judged against ITS OWN TURN'S REAL FRAME and payload")
		console.log("  arm      graded  useful                false                 generic  unverif  ungraded")
		for (const id of ids) {
			const g = run.graded.filter(x => x.arm === id)
			if (g.length === 0) continue
			console.log(
				`  ${id.padEnd(8)} ${String(g.length).padStart(6)}  ` +
					`${pctOf(wilson(g.filter(x => x.verdict === "useful").length, g.length)).padEnd(21)} ` +
					`${pctOf(wilson(g.filter(x => x.verdict === "false").length, g.length)).padEnd(21)} ` +
					`${String(g.filter(x => x.verdict === "generic").length).padStart(7)} ` +
					`${String(g.filter(x => x.verdict === "unverifiable").length).padStart(8)} ` +
					`${String(g.filter(x => x.verdict === "ungraded").length).padStart(8)}`
			)
		}
		const vbase = ids.includes("full") ? "full" : ids[0]!
		console.log(`\n  PAIRED against \`${vbase}\`, turn by turn — McNemar exact on the discordant turns.`)
		console.log("  Read every p here against this file's own noise floor, printed at the end.")
		for (const id of ids) {
			if (id === vbase) continue
			for (const axis of ["useful", "false"] as const) {
				const pairs: { a: boolean; b: boolean }[] = []
				for (const g of run.graded.filter(x => x.arm === vbase)) {
					const o = run.graded.find(x => x.arm === id && x.window === g.window && x.index === g.index)
					if (!o) continue
					pairs.push({ a: g.verdict === axis, b: o.verdict === axis })
				}
				if (pairs.length === 0) continue
				const m = mcnemar(pairs)
				console.log(
					`    ${vbase} vs ${id.padEnd(8)} ${axis.padEnd(7)} ${m.aOnly} against ${m.bOnly} of ` +
						`${pairs.length} paired turns, p = ${m.p.toFixed(3)}`
				)
			}
		}
	}

	/* --------------------------------------------------------------- latency */

	/*
	 * PAIRED, turn against turn, because latency on this socket is a property of the THREAD: it is
	 * regressed at 1534ms + 64.5ms x turn index, so any two arms compared across different turn
	 * positions are being compared on thread depth. Every arm here answers turn N, so the
	 * difference on a turn is the payload's, and the sign test over turns is the whole test.
	 */
	const base = ids.includes("full") ? "full" : ids[0]!
	const baseByTurn = new Map<string, PowerCall>()
	for (const c of run.calls) if (c.arm === base) baseByTurn.set(`${c.window}|${c.index}`, c)
	const answered = run.calls.filter(c => c.error === null && c.latencyMs > 0)
	if (answered.length > 0) {
		console.log(`\nLATENCY — paired against \`${base}\` turn by turn, sign test over the turns`)
		console.log("  arm      p50 ms   vs base: later on   median delta   p (sign)")
		for (const id of ids) {
			if (id === base) continue
			const deltas: number[] = []
			for (const c of run.calls) {
				if (c.arm !== id || c.error !== null || c.latencyMs <= 0) continue
				const b = baseByTurn.get(`${c.window}|${c.index}`)
				if (!b || b.error !== null || b.latencyMs <= 0) continue
				deltas.push(c.latencyMs - b.latencyMs)
			}
			if (deltas.length === 0) continue
			const later = deltas.filter(d => d > 0).length
			const ties = deltas.filter(d => d === 0).length
			const sorted = [...deltas].sort((a, b) => a - b)
			const mine = run.calls.filter(c => c.arm === id && c.error === null && c.latencyMs > 0).map(c => c.latencyMs).sort((a, b) => a - b)
			console.log(
				`  ${id.padEnd(8)} ${String(mine[Math.floor(mine.length / 2)] ?? 0).padStart(6)} ` +
					`${`${later}/${deltas.length - ties}`.padStart(18)} ${`${sorted[Math.floor(sorted.length / 2)]!}ms`.padStart(14)}   ` +
					`${signTest(later, deltas.length - ties).toFixed(4)}`
			)
		}
		console.log(
			"  The picture's latency is UPLOAD, not tokens: a 288px crop and a 1536x864 frame bill the\n" +
				"  same ~1,089 image tokens, and differ by about 10x in bytes on the wire."
		)
	}

	/* ------------------------------------------------------------------ cost */
	console.log("\nCOST — measured from the socket's own usageMetadata, not looked up")
	const withImg = run.calls.filter(c => c.images > 0 && c.promptTokens !== null)
	const noImgArm = run.calls.filter(c => c.arm === "none" && c.promptTokens !== null)
	if (withImg.length > 0) {
		const perGameArm = new Map<string, PowerCall[]>()
		for (const c of run.calls) {
			const key = `${c.window}|${c.arm}`
			perGameArm.set(key, [...(perGameArm.get(key) ?? []), c])
		}
		console.log("  window/arm                      turns  imgs   img MB   total prompt tok   tok/turn")
		for (const [key, cs] of perGameArm) {
			const total = cs.reduce((s, c) => s + (c.promptTokens ?? 0), 0)
			console.log(
				`  ${key.padEnd(32)} ${String(cs.length).padStart(4)} ${String(cs.reduce((s, c) => s + c.images, 0)).padStart(5)} ` +
					`${(cs.reduce((s, c) => s + c.imageB64Chars, 0) / 1024 / 1024).toFixed(1).padStart(8)} ` +
					`${String(total).padStart(18)} ${String(Math.round(total / Math.max(1, cs.length))).padStart(10)}`
			)
		}
		if (noImgArm.length > 0) {
			const fullArm = run.calls.filter(c => c.arm === "full" && c.promptTokens !== null)
			if (fullArm.length > 0) {
				const f = fullArm.reduce((s, c) => s + (c.promptTokens ?? 0), 0)
				const n = noImgArm.reduce((s, c) => s + (c.promptTokens ?? 0), 0)
				console.log(
					`\n  the pictures' share of the whole prompt bill: ${(((f - n) / f) * 100).toFixed(0)}% ` +
						`(${(f - n).toLocaleString()} of ${f.toLocaleString()} tokens across ${fullArm.length} turns).`
				)
				console.log(
					"  That is the COMPOUNDING, not the marginal price: one socket per game keeps every frame in\n" +
						"  the thread, so a picture sent at 3:00 is re-billed on every turn after it."
				)
			}
		}
	}

	console.log(
		"\nPOWER — stated before any winner is named.\n" +
			"  The forced choice is a binomial against an exact 50% null, so ~130 trials in ~65 turns\n" +
			"  separates 65% from chance at about 85% power and 62% at about 60%. The verdict rates below\n" +
			"  it are on the OLD instrument, whose own noise floor (`frame-value.ts --agree`) is a same-arm\n" +
			"  agreement of 13 of 30 turns — about 27 points of useful-rate before it can see anything.\n" +
			"  A null verdict comparison in this file means 'smaller than a quarter of the scale' and\n" +
			"  nothing more. The forced choice is the powered measurement here; the verdicts are context."
	)
}

/**
 * Grade a stored run's lines, resuming where a previous pass stopped.
 *
 * Verdicts are the slow half of this file — one batch is an image, a whole brief and every arm's
 * sentence, and a reasoning judge can spend minutes on it — so the pass is written to be killable.
 * Turns already in `graded` are skipped and the file is written after every turn, which means a
 * pass that dies at turn 40 has kept 40 turns and the next invocation costs 20.
 */
const gradeStored = async (handle: ModelHandle, path: string): Promise<void> => {
	const run = JSON.parse(readFileSync(path, "utf8")) as RunFile
	const already = new Set(run.graded.map(g => `${g.window}|${g.index}`))
	for (const w of run.windows) {
		const window = discoverWindows().find(x => x.id === w.id)
		if (!window) throw new Error(`stored run names window ${w.id}, which discovery no longer returns`)
		const stream = buildStream(window, {
			everySec: 20,
			fromSec: 0,
			turns: 999,
			requireFrame: false,
			schedule: "events",
			level: "commentary",
			heartbeatSec: HEARTBEAT_SEC
		})
		for (const turn of stream.turns) {
			if (already.has(`${window.id}|${turn.index}`)) continue
			const one = await runVerdicts(handle, window, { ...stream, turns: [turn] }, run.calls)
			run.graded.push(...one)
			writeFileSync(path, JSON.stringify(run, null, "\t"))
		}
	}
	report(run)
	console.log(`\nwrote ${path}`)
}

/* ========================================== the free corpus: a stored frame-value run */

/**
 * Re-ask the forced choice of a run that has already been paid for.
 *
 * `frame-value.ts`'s ablation run holds a `frame` arm and a `decoy` arm over the same 31 turns of
 * game 5639406342, which is exactly the pair this instrument needs — it simply was never asked this
 * question. Nothing is re-sent to any coach; only the judge is called. The decoy frame's PATH was
 * not recorded (the run stored `framePath: null` for the decoy arm and kept its `frameTSec`), so it
 * is recovered from the window by matching that clock, and a turn whose decoy cannot be found again
 * is DROPPED and counted rather than paired against the wrong picture.
 */
const runStored = async (handle: ModelHandle, path: string): Promise<RunFile> => {
	const old = JSON.parse(readFileSync(path, "utf8")) as {
		windowId: string
		gameId: string
		calls: {
			arm: string
			index: number
			atSec: number
			clock: string
			text: string
			spoke: boolean
			framePath: string | null
			frameTSec: number | null
		}[]
	}
	const window = discoverWindows().find(w => w.id === old.windowId)
	if (!window) throw new Error(`stored run names window ${old.windowId}, which discovery no longer returns`)

	const realPath = new Map<number, string>()
	for (const c of old.calls) if (c.arm === "frame" && c.framePath) realPath.set(c.index, c.framePath)

	const decoys = new Map<number, PairedFrame | null>()
	let lost = 0
	for (const c of old.calls) {
		if (c.arm !== "decoy" || c.frameTSec === null) continue
		const f = window.frames.find(x => Math.abs(x.tSec - c.frameTSec!) < 0.5) ?? null
		if (f === null) lost += 1
		decoys.set(c.index, f)
	}
	if (lost > 0) console.log(`  ${lost} decoy frame(s) could not be found again by clock and are dropped`)

	const calls: PowerCall[] = old.calls
		.filter(c => c.arm === "frame" || c.arm === "decoy")
		.map(c => ({
			window: old.windowId,
			gameId: old.gameId,
			arm: c.arm,
			index: c.index,
			atSec: c.atSec,
			clock: c.clock,
			text: c.text,
			spoke: c.spoke,
			latencyMs: 0,
			images: 1,
			pic: "full" as Pic,
			source: c.arm === "decoy" ? ("decoy" as const) : ("real" as const),
			realFramePath: realPath.get(c.index) ?? null,
			sentFramePath: c.framePath,
			sentFrameTSec: c.frameTSec,
			imageB64Chars: 0,
			payloadChars: 0,
			payloadKind: "stored",
			promptTokens: null,
			responseTokens: null,
			threadTurn: 0,
			recycled: false,
			error: null
		}))

	const arms: PicArm[] = [
		{ id: "frame", pic: "full", source: "real", cadence: 1, twinOf: null, what: "the stored shipped arm" },
		{ id: "decoy", pic: "full", source: "decoy", cadence: 1, twinOf: "frame", what: "the stored decoy arm" }
	]
	const trials = await runChoice(handle, calls, new Map([[old.windowId, decoys]]), arms)
	return {
		ranAt: new Date().toISOString(),
		argv,
		level: "commentary (as the stored run was replayed)",
		shape: "socket",
		coach: { provider: "gemini-live", model: GEMINI_LIVE_MODEL },
		arms,
		windows: [
			{
				id: old.windowId,
				gameId: old.gameId,
				champion: window.champion,
				turns: new Set(old.calls.map(c => c.index)).size,
				framed: realPath.size
			}
		],
		judge: { provider: judgeProvider, model: judgeModelArg || providerById(judgeProvider)!.defaultModel },
		calls,
		trials,
		graded: []
	}
}

/**
 * The instrument's own reliability: the SAME trials, a different judge.
 *
 * `frame-value.ts` could only measure its noise floor by paying for a second socket run, because a
 * verdict rate is a property of the coach and the judge together. A forced choice is not: the
 * trials — this picture, these two sentences, this correct answer — are written down in the run
 * file, so a second judge can be asked exactly the same questions for the price of the judge alone.
 * Where the two judges agree, the discrimination is a property of the LINES; where they disagree it
 * is a property of whoever was reading them.
 */
const reChoose = async (handle: ModelHandle, path: string): Promise<RunFile> => {
	const old = JSON.parse(readFileSync(path, "utf8")) as RunFile
	if (old.trials.length === 0) throw new Error(`${path} holds no trials to re-ask`)
	const out: ChoiceTrial[] = []
	let done = 0
	const CONCURRENCY = 6
	let next = 0
	const worker = async (): Promise<void> => {
		while (next < old.trials.length) {
			const t = old.trials[next++]!
			const r = await askChoice(handle, t.shownPath, t.a.text, t.b.text)
			const picked = r.pick === "A" ? t.a.arm : r.pick === "B" ? t.b.arm : null
			const correctArm = t.shown === "real" ? t.realArm : t.decoyArm
			out.push({ ...t, ...r, correct: picked === null ? null : picked === correctArm })
			done += 1
			if (done % 20 === 0) process.stdout.write(`  re-asked ${done}/${old.trials.length}\n`)
		}
	}
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, old.trials.length) }, worker))
	out.sort((x, y) => x.window.localeCompare(y.window) || x.index - y.index || x.shown.localeCompare(y.shown))

	/* The agreement between the two readings, printed here because nothing else will compute it. */
	const byKey = new Map(old.trials.map(t => [`${t.window}|${t.index}|${t.shown}|${t.realArm}`, t]))
	let both = 0
	let agree = 0
	for (const t of out) {
		const o = byKey.get(`${t.window}|${t.index}|${t.shown}|${t.realArm}`)
		if (!o || o.correct === null || t.correct === null) continue
		both += 1
		if (o.correct === t.correct) agree += 1
	}
	console.log(
		`\nJUDGE AGAINST JUDGE — the same ${both} trial(s), read twice: they agree on ${agree} ` +
			`(${((100 * agree) / Math.max(1, both)).toFixed(0)}%).\n` +
			"  This is the forced choice's own noise floor, and it costs no coach turns at all."
	)
	return { ...old, ranAt: new Date().toISOString(), argv, judge: { provider: judgeProvider, model: judgeModelArg }, trials: out }
}

/* ====================================================================== main */

const main = async (): Promise<void> => {
	if (summarize !== "") {
		report(JSON.parse(readFileSync(summarize, "utf8")) as RunFile)
		return
	}

	const all = discoverWindows()
	const windows = stored !== "" || rechoose !== "" || verdictsOf !== "" ? [] : windowsArg
		.split(",")
		.map(s => s.trim())
		.filter(s => s !== "")
		.map(id => {
			const w = all.find(x => x.id === id || x.gameId === id)
			if (!w) throw new Error(`no window ${id}; have ${all.map(x => x.id).join(", ")}`)
			return w
		})

	const handle =
		judgeProvider === "none" || dry ? null
		: await (async () => {
				const p = providerById(judgeProvider)
				if (!p) throw new Error(`no provider called ${judgeProvider}`)
				const key = providerKey(p)
				if (!key) throw new Error(`no key for ${judgeProvider} — put one in data/${p.keyFile}`)
				return await modelHandleFor(p, key, judgeModelArg || p.defaultModel)
			})()

	if (verdictsOf !== "") {
		if (handle === null) throw new Error("--verdicts needs a judge")
		await gradeStored(handle, verdictsOf)
		return
	}

	if (rechoose !== "") {
		if (handle === null) throw new Error("--rechoose needs a judge")
		const re = await reChoose(handle, rechoose)
		const outPath = arg("out", rechoose.replace(/\.json$/, `-rechosen-${(judgeModelArg || "judge").replace(/[^a-z0-9-]/gi, "")}.json`))
		writeFileSync(outPath, JSON.stringify(re, null, "\t"))
		report(re)
		console.log(`\nwrote ${outPath}`)
		return
	}

	if (stored !== "") {
		if (handle === null) throw new Error("--stored needs a judge; it is a judging pass and nothing else")
		const re = await runStored(handle, stored)
		const outPath = arg("out", `${DATA_DIR}/eval/frame-power-stored-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}.json`)
		mkdirSync(dirname(outPath), { recursive: true })
		writeFileSync(outPath, JSON.stringify(re, null, "\t"))
		report(re)
		console.log(`\nwrote ${outPath}`)
		return
	}

	const run: RunFile = {
		ranAt: new Date().toISOString(),
		argv,
		level: "commentary",
		shape,
		coach: { provider: shape === "turn" ? coachProvider : "gemini-live", model: shape === "turn" ? coachModel : GEMINI_LIVE_MODEL },
		arms: [...chosen],
		windows: [],
		judge:
			handle === null ? null : (
				{ provider: judgeProvider, model: judgeModelArg || providerById(judgeProvider)!.defaultModel }
			),
		calls: [],
		trials: [],
		graded: []
	}
	const decoysByWindow = new Map<string, Map<number, PairedFrame | null>>()
	const streams: { window: StreamWindow; stream: BuiltStream }[] = []

	for (const window of windows) {
		const stream = buildStream(window, {
			everySec: 20,
			fromSec: 0,
			turns: turnsWanted,
			requireFrame: false,
			schedule: "events",
			level: "commentary",
			heartbeatSec: HEARTBEAT_SEC
		})
		for (const w of stream.warnings ?? []) console.log(`WARNING  ${w}`)
		streams.push({ window, stream })
		const framed = stream.turns.filter(t => t.frameB64 !== null).length
		run.windows.push({
			id: window.id,
			gameId: window.gameId,
			champion: window.champion,
			turns: stream.turns.length,
			framed
		})
		console.log(
			`\n${window.id}  game ${window.gameId}  ${window.champion}  ${clockText(window.gameDurationSec ?? 0)}  ` +
				`${stream.turns.length} turns (${framed} with a frame), ${stream.stepped} samples stepped`
		)
	}
	const totalTurns = run.windows.reduce((s, w) => s + w.turns, 0)
	console.log(`\narms: ${chosen.map(a => `${a.id} (${a.what})`).join(", ")}`)
	console.log(
		`about to spend: ${dry ? 0 : totalTurns * chosen.length} socket turns` +
			`${wantVerdicts ? `, up to ${totalTurns} verdict calls` : ""}` +
			`${wantChoice ? `, up to ${totalTurns * 2 * chosen.filter(a => a.twinOf !== null).length} forced-choice calls` : ""}\n`
	)

	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")
	const out = arg("out", `${DATA_DIR}/eval/frame-power-${stamp}.json`)
	mkdirSync(dirname(out), { recursive: true })
	/*
	 * CHECKPOINT AFTER EVERY WINDOW, and on the way out of a crash.
	 *
	 * The first attempt at this run lost 174 paid coaching turns because the provider's credit ran
	 * out while the SECOND window's sockets were opening and the process died before anything was
	 * written. Lines that have been paid for are evidence; keeping them only in memory until the
	 * very end means one failure in the last five percent of a run destroys all of it.
	 */
	const checkpoint = (why: string): void => {
		writeFileSync(out, JSON.stringify(run, null, "\t"))
		console.log(`checkpoint (${why}): ${run.calls.length} call(s) safe in ${out}`)
	}
	try {
		for (const { window, stream } of streams) {
			const wheres = noRead ? undefined : await readWhere(stream, `${DATA_DIR}/eval/bench-crops/${window.id}`)
			const { calls, decoys } = await runWindow(window, stream, wheres, chosen)
			run.calls.push(...calls)
			decoysByWindow.set(window.id, decoys)
			checkpoint(`after ${window.id}`)
		}
	} catch (e) {
		checkpoint("CRASH")
		throw e
	}

	if (handle !== null && wantChoice) {
		console.log("\nrunning the forced choice…")
		run.trials = await runChoice(handle, run.calls, decoysByWindow, chosen)
		checkpoint("after the forced choice")
	}
	if (handle !== null && wantVerdicts) {
		console.log("\ngrading verdicts…")
		for (const { window, stream } of streams) run.graded.push(...(await runVerdicts(handle, window, stream, run.calls)))
	}

	writeFileSync(out, JSON.stringify(run, null, "\t"))
	report(run)
	console.log(`\nwrote ${out}`)
}

if (import.meta.main) await main()
