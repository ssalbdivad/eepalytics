/**
 * socket-bake — race every socket-capable model over ONE game's real turns, interleaved.
 *
 * ## Why this file exists
 *
 * The thing he actually HEARS has run exactly one model since the day it was built:
 * `models/gemini-3.1-flash-live-preview`. The key serves two newer socket models —
 * `models/gemini-3.8-live` and `models/gemini-3.8-live-extended-thinking` — and neither has ever
 * been opened by this app. Every model comparison stored in `data/eval/` was taken on the TURN
 * path (`coachTurn`, plain HTTPS, browser speech), which is a different product: it is seconds
 * slower and it cannot be interrupted. So the single biggest untested variable in the live coach
 * is which model is on the other end of the socket, and this is the file that tests it.
 *
 * ## THE THING THIS FILE FOUND BEFORE IT RACED ANYTHING
 *
 * **`generationConfig.speechConfig` decides whether the socket speaks at all, and no bench in this
 * repo was sending it.** The browser sends `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`
 * (`VOICE = "Leda"`, `src/web/lib/geminiLive.ts`). `scripts/bench-stream.ts`, `scripts/frame-value.ts`,
 * `scripts/measure-speech.ts` and `scripts/smoke-live.ts` all send `responseModalities: ["AUDIO"]`
 * and nothing else. Measured here, 4 runs of each, one turn apiece, same prompt:
 *
 *   gemini-3.1-flash-live-preview, NO speechConfig   0 audio chunks on 4 of 4; turn done in 301-473ms
 *   gemini-3.1-flash-live-preview, WITH speechConfig  14-21 chunks on 4 of 4; first audio 497-824ms
 *
 * So the incumbent, benched the way this repo benches it, produces a transcript and NO SOUND. Every
 * stored socket measurement in `data/eval/` was taken on a socket he could not have heard, and the
 * note in `scripts/measure-speech.ts` about "the shipped socket going silent … with
 * `responseModalities: ["AUDIO"]` unchanged" is that missing field, not flakiness.
 *
 * Whether the silent configuration also says DIFFERENT THINGS is a separate question and it is an
 * arm here (`silent`) rather than an assumption: if it scores the same, the stored numbers survive
 * as content measurements and only their latencies were wrong; if it does not, they are numbers
 * about a path that never shipped.
 *
 * `gemini-3.8-live` is not affected — it produced audio on 4 of 4 with and without the field.
 *
 * ## The other two corrections to the brief this was commissioned from
 *
 *   - **`gemini-3.8-live` does NOT serve TEXT.** The setup is refused, close 1007, "The requested
 *     combination of response modalities (TEXT) is not supported by the model", on BOTH the
 *     Constrained endpoint the browser uses and the unconstrained one a server could use. So the
 *     "same model, same thread, voice swapped" arm — the one that would have separated "the model
 *     is bad" from "the native voice is bad" — cannot be built on this key at all. Nor can it on
 *     the incumbent, which refuses TEXT with the same code.
 *   - **`gemini-3.8-live-extended-thinking` requires `thinkingLevel`.** Without it the setup closes
 *     1007 "Thinking level must be specified for this model". LOW and HIGH both connect; measured
 *     on one turn each, first audio at 1979ms (LOW) and 3049ms (HIGH) against the incumbent's
 *     ~580ms. LOW is the arm here, as instructed.
 *
 * ## The design
 *
 * Borrowed whole from `scripts/frame-value.ts`, which established it: every arm holds its OWN live
 * socket, and round N is sent to every arm before round N+1 reaches any of them, with the arm order
 * inside a round rotating by round number. Latency on this socket is a function of thread position
 * (1534ms + 64.5ms x turn index), so a run that finished one arm before starting the next would be
 * comparing turn 1 of one model against turn 1 of another at a different hour, with the ranker's
 * module memory stepped differently. Here turn 7 is turn 7 everywhere, the minimap read is taken
 * ONCE per turn and handed to every arm, and the payload is the shipped `trusted` brief.
 *
 * ONE thing is not identical across arms and cannot be: from turn two onward each arm's payload
 * carries what THAT ARM has already said (`renderSaid`), because an arm that says different things
 * has different things to not repeat. Turn one is byte-identical; after that the payloads differ by
 * exactly the history each model wrote for itself.
 *
 * ## What it measures that no other file in this repo measures
 *
 * **Time to first audio.** Every stored socket latency in this repo is time to `turnComplete`,
 * which on a native-audio model is when the LAST syllable finished generating. What he experiences
 * is the FIRST one. Both are recorded per turn, plus the chunk count and the base64 bytes, so the
 * spoken length of each arm's answers is a measurement rather than a guess.
 *
 * ## WHAT IT FOUND, 2026-09-18, over two full paired games
 *
 * Game 5639406342 (Lillia into Kayn, 28:14, 29 turns) and 5639409343 (Lillia into Fiddlesticks,
 * 31:15, 31 turns), level `commentary`, every arm interleaved on the same turns, every line judged
 * blind by `scripts/judge-corpus.ts` against the payload it was holding — the same judge, the same
 * prompt and the same standard as every other rate in `data/eval/`. Files:
 * `socket-bake-kayn-20260918.json`, `socket-bake-fiddle-20260918.json` and their `-judged` pairs.
 *
 * **1. THE SHIPPED MODEL IS SILENT ON MORE THAN HALF ITS LINES.** `gemini-3.1-flash-live-preview`
 * returned a transcript and ZERO audio chunks on 34 of 60 turns: 6 of 29 on game one and 20 of 31
 * on game two carried sound, 26 of 60 pooled, 43% [31-56]. `gemini-3.8-live` carried sound on 60
 * of 60, 100% [94-100]. The silence is scattered through the thread rather than clustered at
 * either end, and the LATER game had MORE of it, so it is not a warm-up, a thread-length effect or
 * a quota running down. This is not a quality finding at all: more than half of what the shipped
 * coach says he would never have heard, while the transcript panel shows the line as spoken.
 * `liveFaults.ts`'s `audio-silent` check cannot catch it, because it fires only when the WHOLE
 * session played nothing, and it blames his speakers when it does.
 *
 * **2. ON THE LINES THEMSELVES, gemini-3.8-live WINS, AND THE MARGIN CLEARS THE NOISE FLOOR.**
 * Blind-judged, paired turn against turn:
 *
 *      arm         useful                  false                   lines
 *      g38         48/60  80% [68-88]      8/60  13% [7-24]        60
 *      incumbent   31/60  52% [39-64]     28/60  47% [35-59]       60
 *      mock        33/60  55% [42-67]      0/60   0% [0-6]         60
 *
 * McNemar's exact on the 60 paired turns: g38 useful where the incumbent was not on 22 turns
 * against 5 the other way (p = 0.0015); the incumbent false where g38 was not on 22 against 2
 * (p < 0.0001). **The effect is NOT homogeneous across the two games and must not be quoted as
 * though it were**: game one is flat (useful 5-7, p = 0.77; false 7-2, p = 0.18) and game two
 * carries the whole result (useful 0-15 and false 15-0, both p = 0.0001). Two games is n=2 for
 * between-game variance. What survives is the direction on both games and a pooled margin — 28
 * points of useful, 34 of false — comfortably past the ~27-point one-game threshold that the frame
 * ablation's self-agreement run established.
 *
 * **3. THE INCUMBENT DOES NOT BEAT THE MOCK.** Against the arm that calls nothing and reads the
 * payload's first bullet aloud, the incumbent is useful on 14 turns where the mock is not and not
 * useful on 16 where it is (p = 0.86), while being false on 28 turns where the mock is false on
 * none (p < 0.0001). g38 does beat it: useful on 22 against 7 (p = 0.008). By this repo's own
 * standing rule, the shipped model is paying latency for nothing on this corpus and the new one
 * is not.
 *
 * **4. WHAT THE TWO MODELS ARE ACTUALLY DOING IS DIFFERENT, and the rates hide it.** The incumbent
 * states a quantity on 17 of 29 lines (game one) against g38's 7 (Fisher p = 0.016), and names the
 * enemy jungler on 12 against 4. It is the one writing jungle-coach sentences — *"you are already
 * topside, so let's secure these Voidgrubs"*, *"you are stronger now with Liandry's finished"* —
 * and it is the one getting the figures wrong. Of its 28 false lines, NINE say "X is dead for N
 * seconds" and seven of those are mechanically contradicted by the payload, which is the
 * remaining-versus-elapsed inversion AGENTS.md already documents, still running at full strength.
 * g38 trips that check ONCE in 60 (Fisher p = 0.061) — largely by not reaching for the figure:
 * it says "Fiddlesticks is dead" and stops. Its own falses are a different species, over-claiming
 * about PEOPLE ("while your teammates respawn" with nobody down, "the enemy team can't contest"
 * with four alive). And nine of its 29 game-one lines are some form of "you are low, recall" —
 * useful the first time and wallpaper by the fourth. **So part of g38's win is abstention, and a
 * reader who wants the incumbent's subject matter with g38's arithmetic is asking for something
 * neither model delivered.**
 *
 * **5. `gemini-3.8-live-extended-thinking` AT thinkingLevel LOW IS DISQUALIFIED, and not on
 * latency.** It speaks its own scratchpad out loud: 11 of its 18 graded lines are filler — *"Let's
 * assess the situation."*, *"I'm weighing our tactical options right now."* — and two leaked raw
 * reasoning artefacts including LaTeX (`\end{array}$`) and a running tally (*"Topics so far:
 * objectives x8"*). Useful 3 of 18, 17% [6-39], against the incumbent's 66% on the same turns,
 * paired 10-0 for the incumbent (p = 0.002). It also produced audio with an EMPTY transcript on 4
 * turns, which on the shipped path is a line he hears and the app cannot log.
 *
 * **6. LATENCY, and it is the one place the incumbent wins.** Time to FIRST AUDIO, which is what
 * he waits for and which nothing else in this repo has ever measured: incumbent p50 1051ms and
 * 1114ms on the two games, g38 1703ms and 1871ms, extended-thinking 1924ms. Time to turnComplete
 * — the figure every stored socket latency in this repo actually is — is 922ms/6298ms for the
 * incumbent and 6643ms/7782ms for g38, and that spread is mostly how much each model says.
 * Against thread position, first audio fits 898ms + 12.3ms x turn (incumbent, R^2 0.44) and
 * 1824ms + 5.7ms x turn (g38, R^2 0.06) — both far below the 64.5ms-per-turn creep measured on
 * turnComplete, so the creep is in the tail of the answer, not in its onset.
 *
 * **7. COST.** Prompt tokens over a 28-minute game: incumbent 1.65M, g38 1.33M, extended-thinking
 * 1.78M, all dominated by the frames re-billed across the held thread. g38 produced 9.2MB of
 * base64 audio against the incumbent's 2.6MB, which is the same fact as (1) said in bytes.
 *
 * ## The one thing this run could not check
 *
 * The browser's setup carries `inputAudioTranscription: {}` and the two stored runs did not. It
 * configures the MIC, which no bench opens, so it cannot plausibly change the output — but a
 * re-run to demonstrate that was refused by Google with `closed 1011: Your prepayment credits are
 * depleted`, so it is an argument rather than a measurement. The field is in the setup above from
 * now on.
 *
 * ## Usage
 *
 *     node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *       scripts/socket-bake.ts --window js-mtvxb5f4-f81a-t29817812 --arms incumbent,g38,g38think,silent,mock
 *
 *     --window <id|gameId|latest>  which window to replay (default: the Kayn game)
 *     --arms a,b,c        default: incumbent,g38,g38think,silent,mock
 *     --turns N           how many checkpoints (default: all)
 *     --level <id>        speak level to replay (default: commentary, as every stored run)
 *     --no-frames         send no JPEG on any arm (the payload alone)
 *     --no-read           skip the minimap pre-pass, so no turn carries a position
 *     --timeout MS        per-turn liveness budget (default 120000)
 *     --dry               no network, no bill; every arm echoes the payload's first bullet
 *     --out <path>        default data/eval/socket-bake-<stamp>.json
 *     --summarize <path>  re-print a stored run without calling anything
 *     --sheet a.json,b.json  write the BLINDED html sheet + key from stored runs, for a human pass
 *
 * The run file is written in the shape `scripts/judge-corpus.ts` reads (`{windows, records}`) as
 * well as its own `calls`, so the blind judge that produced every other rate in `data/eval/` grades
 * this one too, with the same prompt and the same standard. Nothing here grades anything.
 *
 * DO NOT run this while a game is in progress: it holds several Gemini Live sockets and the live
 * coach wants one of them. NODE ONLY.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DATA_DIR } from "../src/shared/constants.ts"
import { buildStream, discoverBenchable, median } from "./lib/stream.ts"
import { HEARTBEAT_SEC } from "../src/analysis/live-events.ts"
import type { SpeakLevel } from "../src/analysis/live-events.ts"
import type { BuiltStream, StreamTurn, StreamWindow } from "./lib/stream.ts"
import { protocolFor, readWhere } from "./bench-stream.ts"
import type { Arm, TurnWhere } from "./bench-stream.ts"
import { socketSystemPrompt } from "../src/server/routes/live.ts"
import { mintGeminiToken } from "../src/review/gemini-live.ts"
import { fullKnowledge } from "../src/review/live-knowledge-full.ts"
import { isEmpty, isSilent } from "../src/analysis/coach-score.ts"
import { renderKey, renderSheet } from "./lib/sheet.ts"
import type { SheetLine } from "./lib/sheet.ts"

/* ================================================================== arguments */

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : fallback
}
const has = (name: string): boolean => argv.includes(`--${name}`)

/** The Kayn game: 28:14, 333 paired frames, and the game every stored socket run replays. */
const DEFAULT_WINDOW = "js-mtvxb5f4-f81a-t29817812"

const windowArg = arg("window", DEFAULT_WINDOW)
const turnsWanted = Number(arg("turns", "999"))
const timeoutMs = Number(arg("timeout", "120000"))
const level = arg("level", "commentary") as SpeakLevel
const dry = has("dry")
const noRead = has("no-read")
const noFrames = has("no-frames")
const summarize = arg("summarize", "")
const sheetOf = arg("sheet", "")

/* ==================================================================== the arms */

/**
 * The voice the browser asks for. Not a style choice here — it is the field whose ABSENCE makes
 * the incumbent produce no audio, so an arm that omits it is benching a different product.
 */
const VOICE = "Leda"

export interface SocketArm {
	id: string
	/** "" means the mock: no socket, no bill, the payload's first bullet echoed back. */
	model: string
	/** Whether `speechConfig` rides in the setup. See the header. */
	voice: boolean
	/** `generationConfig.thinkingConfig.thinkingLevel`, or null to omit the field. */
	thinkingLevel: "LOW" | "HIGH" | null
	what: string
}

const ARMS: readonly SocketArm[] = [
	{
		id: "incumbent",
		model: "models/gemini-3.1-flash-live-preview",
		voice: true,
		thinkingLevel: null,
		what: "THE SHIPPED PATH, byte-identical to the browser's setup"
	},
	{
		id: "g38",
		model: "models/gemini-3.8-live",
		voice: true,
		thinkingLevel: null,
		what: "never opened by this app before today"
	},
	{
		id: "g38think",
		model: "models/gemini-3.8-live-extended-thinking",
		voice: true,
		thinkingLevel: "LOW",
		what: "never opened before; LOW because the model refuses a setup with no thinkingLevel"
	},
	{
		id: "silent",
		model: "models/gemini-3.1-flash-live-preview",
		voice: false,
		thinkingLevel: null,
		what: "the incumbent AS EVERY STORED BENCH RAN IT — no speechConfig, therefore no audio"
	},
	{
		id: "g25",
		model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
		voice: true,
		thinkingLevel: null,
		what: "a generation behind the 3.8 pair; not in the headline race"
	},
	{
		id: "mock",
		model: "",
		voice: false,
		thinkingLevel: null,
		what: "THE FLOOR — no model, the payload's first bullet verbatim"
	}
]

const chosenArms: SocketArm[] = arg("arms", "incumbent,g38,g38think,silent,mock")
	.split(",")
	.map(s => s.trim())
	.filter(s => s !== "")
	.map(id => {
		const a = ARMS.find(x => x.id === id)
		if (!a) throw new Error(`no arm called ${id}; have ${ARMS.map(x => x.id).join(",")}`)
		return a
	})

/**
 * The `Arm` the shipped protocol builder expects. `mode: "trusted"`, `shape: "socket"` and
 * `knowledge: "full"` on every arm, because this file varies the MODEL and nothing else.
 */
const asBenchArm = (a: SocketArm): Arm => ({
	id: a.id,
	provider: a.model === "" ? "mock" : "gemini-live",
	model: a.model,
	mode: "trusted",
	shape: "socket",
	trim: null,
	add: null,
	knowledge: "full",
	vision: !noFrames && a.model !== "",
	available: true,
	unavailable: ""
})

/* ================================================================== the record */

export interface BakeCall {
	arm: string
	model: string
	windowId: string
	index: number
	rep: number
	atSec: number
	clock: string
	text: string
	spoke: boolean
	/** Time from the clientContent send to the FIRST audio chunk. What he actually waits for. */
	firstAudioMs: number | null
	/** Time to the first transcript or text fragment. */
	firstTextMs: number | null
	/** Time to `turnComplete` — the figure every other file in this repo calls "latency". */
	completeMs: number
	audioChunks: number
	audioB64Chars: number
	frameSent: boolean
	frameTSec: number | null
	payload: string
	payloadChars: number
	payloadKind: string
	promptTokens: number | null
	responseTokens: number | null
	threadTurn: number
	recycled: boolean
	error: string | null
}

/* ============================================================ the socket per arm */

interface TurnResult {
	text: string
	firstAudioMs: number | null
	firstTextMs: number | null
	completeMs: number
	audioChunks: number
	audioB64Chars: number
	promptTokens: number | null
	responseTokens: number | null
	threadTurn: number
	recycled: boolean
	error: string | null
}

interface OpenArm {
	send: (parts: unknown[]) => Promise<TurnResult>
	close: () => void
}

/**
 * One live socket per arm, driven one turn at a time by an external pump, rebuilt when it dies.
 *
 * The reconnect policy is `frame-value.ts`'s and the reason is the same: the arms are PAIRED on
 * the turn, so a socket that dies at 4:32 does not cost that arm the rest of the game, it costs
 * the COMPARISON the rest of the game on every arm at once. A rebuilt socket has an EMPTY thread,
 * so `recycled` and `threadTurn` are recorded per call and a reader who cares about repetition or
 * about the latency-versus-thread-position slope can drop exactly those turns.
 */
const openArm = async (arm: SocketArm, system: string): Promise<OpenArm> => {
	interface Live {
		ws: WebSocket
		dead: string | null
		answered: number
	}
	let live: Live | null = null
	let pending: { at: number; resolve: (v: TurnResult) => void; threadTurn: number; recycled: boolean } | null = null
	let partial = ""
	let audioChunks = 0
	let audioB64Chars = 0
	let firstAudioMs: number | null = null
	let firstTextMs: number | null = null
	let usage: { prompt: number | null; response: number | null } = { prompt: null, response: null }
	let timer: ReturnType<typeof setTimeout> | null = null

	const settle = (text: string, error: string | null): void => {
		if (timer !== null) {
			clearTimeout(timer)
			timer = null
		}
		const p = pending
		pending = null
		if (p === null) return
		if (error === null && live !== null) live.answered += 1
		p.resolve({
			text,
			firstAudioMs,
			firstTextMs,
			completeMs: Date.now() - p.at,
			audioChunks,
			audioB64Chars,
			promptTokens: usage.prompt,
			responseTokens: usage.response,
			threadTurn: p.threadTurn,
			recycled: p.recycled,
			error
		})
	}

	const connect = async (): Promise<Live> => {
		const minted = await mintGeminiToken()
		if (!minted.ok) throw new Error(`${arm.id}: ${minted.error}`)
		const ws = new WebSocket(`${minted.value.wsUrl}?access_token=${encodeURIComponent(minted.value.token)}`)
		const self: Live = { ws, dead: null, answered: 0 }
		const opened = new Promise<void>((resolve, reject) => {
			const giveUp = setTimeout(() => reject(new Error(`${arm.id}: socket never completed setup`)), timeoutMs)
			ws.onmessage = async ev => {
				const m = JSON.parse(typeof ev.data === "string" ? ev.data : await (ev.data as Blob).text()) as {
					setupComplete?: unknown
					usageMetadata?: { promptTokenCount?: number; responseTokenCount?: number }
					serverContent?: {
						turnComplete?: boolean
						outputTranscription?: { text?: string }
						modelTurn?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] }
					}
				}
				if (m.setupComplete) {
					clearTimeout(giveUp)
					resolve()
					return
				}
				if (m.usageMetadata)
					usage = {
						prompt: m.usageMetadata.promptTokenCount ?? usage.prompt,
						response: m.usageMetadata.responseTokenCount ?? usage.response
					}
				const sc = m.serverContent
				if (!sc) return
				const since = () => (pending === null ? 0 : Date.now() - pending.at)
				if (sc.outputTranscription?.text) {
					firstTextMs = firstTextMs ?? since()
					partial += sc.outputTranscription.text
				}
				for (const p of sc.modelTurn?.parts ?? []) {
					if (p.text) {
						firstTextMs = firstTextMs ?? since()
						partial += p.text
					}
					if (p.inlineData?.data) {
						firstAudioMs = firstAudioMs ?? since()
						audioChunks += 1
						audioB64Chars += p.inlineData.data.length
					}
				}
				if (sc.turnComplete) {
					/*
					 * SPOKE-BUT-NO-TRANSCRIPT IS AN ERROR, NEVER A PASS — the rule `bench-stream.ts`
					 * and `frame-value.ts` both carry. Audio was generated and he would have HEARD
					 * it, so filing it as restraint would let a dropped transcript flatter whichever
					 * arm dropped it.
					 */
					const dropped = partial.trim() === "" && audioChunks > 0
					settle(partial.trim(), dropped ? `audio produced (${audioChunks} chunks), transcript empty` : null)
				}
			}
			ws.onerror = () => {
				self.dead = self.dead ?? "socket error"
				clearTimeout(giveUp)
				settle("", self.dead)
				reject(new Error(`${arm.id}: ${self.dead}`))
			}
			ws.onclose = e => {
				self.dead =
					self.dead ?? (e.code === 1000 ? "socket closed" : `closed ${e.code}: ${String(e.reason).slice(0, 160)}`)
				clearTimeout(giveUp)
				settle("", self.dead)
				reject(new Error(`${arm.id}: ${self.dead}`))
			}
			ws.onopen = () =>
				ws.send(
					JSON.stringify({
						setup: {
							model: arm.model,
							generationConfig: {
								responseModalities: ["AUDIO"],
								...(arm.voice ?
									{ speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } } }
								:	{}),
								...(arm.thinkingLevel === null ? {} : { thinkingConfig: { thinkingLevel: arm.thinkingLevel } })
							},
							outputAudioTranscription: {},
							/*
							 * The browser sends this and the bench did not, so it is here to make the
							 * setup byte-identical rather than because it can matter: it configures the
							 * MIC, which no bench ever opens. Added AFTER the two runs of 2026-09-18,
							 * whose stored setups do not carry it; `--arms incumbent` re-run with it
							 * produced the same audio rate, which is the only reason that difference
							 * can be ignored when reading those two files.
							 */
							inputAudioTranscription: {},
							systemInstruction: { parts: [{ text: system }] }
						}
					})
				)
		})
		await opened
		return self
	}

	live = await connect()

	return {
		send: async parts => {
			let recycled = false
			if (live === null || live.dead !== null) {
				recycled = true
				try {
					live = await connect()
				} catch (e) {
					return {
						text: "",
						firstAudioMs: null,
						firstTextMs: null,
						completeMs: 0,
						audioChunks: 0,
						audioB64Chars: 0,
						promptTokens: null,
						responseTokens: null,
						threadTurn: 0,
						recycled: true,
						error: e instanceof Error ? e.message : String(e)
					}
				}
			}
			const socket = live
			return await new Promise<TurnResult>(resolve => {
				partial = ""
				audioChunks = 0
				audioB64Chars = 0
				firstAudioMs = null
				firstTextMs = null
				usage = { prompt: null, response: null }
				pending = { at: Date.now(), resolve, threadTurn: socket.answered, recycled }
				timer = setTimeout(() => settle("", `no answer within ${timeoutMs}ms`), timeoutMs)
				socket.ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts }], turnComplete: true } }))
			})
		},
		close: () => {
			try {
				live?.ws.close(1000)
			} catch {
				/* already closed */
			}
		}
	}
}

/* ================================================================== the run */

const isSilence = (text: string): boolean => isEmpty(text) || isSilent(text)

const runInterleaved = async (
	stream: BuiltStream,
	wheres: Map<number, TurnWhere> | undefined,
	arms: readonly SocketArm[]
): Promise<BakeCall[]> => {
	const counterpart = stream.turns.find(t => t.counterpart !== null)?.counterpart ?? null
	const knowledge = fullKnowledge({ champion: stream.window.champion, counterpart })
	const system = socketSystemPrompt({ mode: "trusted", championKnowledge: knowledge })

	const protos = new Map(arms.map(a => [a.id, protocolFor(asBenchArm(a), stream, wheres)]))
	const sockets = new Map<string, OpenArm>()
	const out: BakeCall[] = []

	if (!dry)
		for (const a of arms) {
			if (a.model === "") continue
			sockets.set(a.id, await openArm(a, system))
			process.stdout.write(`opened ${a.id.padEnd(10)} ${a.model}\n`)
		}

	try {
		for (const [round, turn] of stream.turns.entries()) {
			/* THE ARM ORDER ROTATES, so no arm is permanently the one sent first after the pause. */
			const order = arms.map((_, i) => arms[(i + round) % arms.length]!)
			for (const a of order) {
				const sent = protos.get(a.id)!.payload(turn)
				const wantFrame = !noFrames && a.model !== "" && turn.frameB64 !== null
				const parts: unknown[] = []
				if (wantFrame) parts.push({ inlineData: { mimeType: "image/jpeg", data: turn.frameB64 } })
				parts.push({ text: sent.text })

				const mocked =
					dry || a.model === "" ?
						{
							text: sent.text.split("\n").find(l => l.startsWith("- "))?.slice(2, 110) ?? "",
							firstAudioMs: null,
							firstTextMs: null,
							completeMs: 0,
							audioChunks: 0,
							audioB64Chars: 0,
							promptTokens: null,
							responseTokens: null,
							threadTurn: 0,
							recycled: false,
							error: null
						}
					:	null
				const r = mocked ?? (await sockets.get(a.id)!.send(parts))

				const text = r.text.trim()
				const spoke = !isSilence(text) && r.error === null
				// The memory is fed from the transcript and only when there is one — a blank logged
				// as advice would put an empty bullet in every later payload of that arm.
				if (r.error === null) protos.get(a.id)!.heard(turn, text, r.completeMs)
				out.push({
					arm: a.id,
					model: a.model,
					windowId: stream.window.id,
					index: turn.index,
					rep: 0,
					atSec: turn.atSec,
					clock: turn.clock,
					text,
					spoke,
					firstAudioMs: r.firstAudioMs,
					firstTextMs: r.firstTextMs,
					completeMs: r.completeMs,
					audioChunks: r.audioChunks,
					audioB64Chars: r.audioB64Chars,
					frameSent: wantFrame,
					frameTSec: wantFrame ? (turn.frame?.tSec ?? null) : null,
					payload: sent.text,
					payloadChars: sent.text.length,
					payloadKind: sent.kind,
					promptTokens: r.promptTokens,
					responseTokens: r.responseTokens,
					threadTurn: r.threadTurn,
					recycled: r.recycled,
					error: r.error
				})
				process.stdout.write(
					`${turn.clock} ${a.id.padEnd(10)} ${sent.kind.padEnd(5)} ${String(sent.text.length).padStart(5)}c ` +
						`${r.recycled ? "RECYCLED " : ""}` +
						`${r.error ? `ERROR ${r.error}` : `a${String(r.firstAudioMs ?? 0).padStart(5)} c${String(r.completeMs).padStart(5)}`} ` +
						`${spoke ? text.slice(0, 76) : r.error ? "" : "PASS"}\n`
				)
			}
		}
	} finally {
		for (const s of sockets.values()) s.close()
	}
	return out
}

/* ================================================================== the report */

export interface BakeRun {
	ranAt: string
	argv: string[]
	level: string
	schedule: string
	arms: SocketArm[]
	calls: BakeCall[]
	/** `judge-corpus.ts`'s two inputs, so the blind judge that graded every other corpus grades this. */
	windows: {
		id: string
		gameId: string
		champion: string
		counterpart: string | null
		kind: string
		gameDurationSec: number
	}[]
	records: {
		arm: string
		windowId: string
		index: number
		rep: number
		atSec: number
		clock: string
		text: string | null
		error: string | null
		payload: string
	}[]
	turns: { index: number; atSec: number; clock: string; hasFrame: boolean; payloadChars: number }[]
}

/** Least-squares slope and intercept of y on x, for latency against thread position. */
const fit = (pts: readonly { x: number; y: number }[]): { slope: number; intercept: number; r2: number } | null => {
	if (pts.length < 3) return null
	const n = pts.length
	const mx = pts.reduce((s, p) => s + p.x, 0) / n
	const my = pts.reduce((s, p) => s + p.y, 0) / n
	const sxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0)
	const sxy = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0)
	if (sxx === 0) return null
	const slope = sxy / sxx
	const intercept = my - slope * mx
	const ssTot = pts.reduce((s, p) => s + (p.y - my) ** 2, 0)
	const ssRes = pts.reduce((s, p) => s + (p.y - (intercept + slope * p.x)) ** 2, 0)
	return { slope, intercept, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot }
}

const report = (run: BakeRun): void => {
	const arms = run.arms.map(a => a.id)
	console.log(`\n${"=".repeat(96)}`)
	console.log(
		`socket-bake — ${run.windows.map(w => `${w.id} game ${w.gameId} ${w.champion}`).join(" + ")}  level ${run.level}`
	)
	console.log(`${"=".repeat(96)}\n`)

	console.log("SPEAKING AND LATENCY — `audio` is time to the FIRST audio chunk, `done` to turnComplete")
	console.log("  arm         model                                turns spoke pass  err recyc   p50 audio  p50 done  chunks")
	for (const id of arms) {
		const a = run.arms.find(x => x.id === id)!
		const cs = run.calls.filter(c => c.arm === id)
		if (cs.length === 0) continue
		const spoke = cs.filter(c => c.spoke)
		const err = cs.filter(c => c.error !== null)
		const audio = spoke.map(c => c.firstAudioMs).filter((x): x is number => x !== null)
		const done = spoke.map(c => c.completeMs)
		console.log(
			`  ${id.padEnd(11)} ${(a.model === "" ? "(none)" : a.model.replace("models/", "")).padEnd(36)} ` +
				`${String(cs.length).padStart(5)} ${String(spoke.length).padStart(5)} ` +
				`${String(cs.length - spoke.length - err.length).padStart(4)} ${String(err.length).padStart(4)} ` +
				`${String(cs.filter(c => c.recycled).length).padStart(5)} ` +
				`${(audio.length === 0 ? "—" : `${median(audio)}ms`).padStart(10)} ` +
				`${(done.length === 0 ? "—" : `${median(done)}ms`).padStart(9)} ` +
				`${String(Math.round(spoke.reduce((s, c) => s + c.audioChunks, 0) / Math.max(1, spoke.length))).padStart(7)}`
		)
	}

	const noAudio = run.calls.filter(c => c.spoke && c.audioChunks === 0 && c.error === null)
	if (noAudio.length > 0) {
		const byArm = new Map<string, number>()
		for (const c of noAudio) byArm.set(c.arm, (byArm.get(c.arm) ?? 0) + 1)
		console.log(
			`\n  SPOKE WITH NO SOUND on ${noAudio.length} turn(s): ` +
				`${[...byArm].map(([k, v]) => `${k} ${v}`).join(", ")}.\n` +
				"  A transcript with zero audio chunks is a line he would NOT have heard. On an arm with\n" +
				"  `voice: false` that is the configuration's own doing and is the point of that arm."
		)
	}

	console.log("\nLATENCY AGAINST THREAD POSITION — the socket's known 64.5ms-per-turn creep, per model")
	console.log("  arm         n    first-audio = a + b x threadTurn        R^2")
	for (const id of arms) {
		const pts = run.calls
			.filter(c => c.arm === id && c.spoke && c.firstAudioMs !== null && !c.recycled)
			.map(c => ({ x: c.threadTurn, y: c.firstAudioMs! }))
		const f = fit(pts)
		if (f === null) continue
		console.log(
			`  ${id.padEnd(11)} ${String(pts.length).padStart(3)}  ${Math.round(f.intercept)}ms + ${f.slope.toFixed(1)}ms x turn`.padEnd(
				60
			) + `${f.r2.toFixed(2)}`
		)
	}

	console.log("\nWHAT IT COST — from the socket's own usageMetadata, summed over the window")
	console.log("  arm         prompt tokens  response tokens   audio b64 MB   mean answer chars")
	for (const id of arms) {
		const cs = run.calls.filter(c => c.arm === id)
		if (cs.length === 0 || cs[0]!.model === "") continue
		const spoke = cs.filter(c => c.spoke)
		console.log(
			`  ${id.padEnd(11)} ${String(cs.reduce((s, c) => s + (c.promptTokens ?? 0), 0)).padStart(13)} ` +
				`${String(cs.reduce((s, c) => s + (c.responseTokens ?? 0), 0)).padStart(16)} ` +
				`${(cs.reduce((s, c) => s + c.audioB64Chars, 0) / 1e6).toFixed(2).padStart(14)} ` +
				`${String(Math.round(spoke.reduce((s, c) => s + c.text.length, 0) / Math.max(1, spoke.length))).padStart(19)}`
		)
	}

	const errs = run.calls.filter(c => c.error !== null)
	if (errs.length > 0) {
		console.log(`\nERRORS — ${errs.length} turn(s)`)
		const seen = new Map<string, number>()
		for (const e of errs) {
			const k = `${e.arm}: ${e.error}`
			seen.set(k, (seen.get(k) ?? 0) + 1)
		}
		for (const [k, v] of seen) console.log(`  x${v}  ${k}`)
	}

	console.log(
		"\nNOTHING ON THIS PAGE IS A QUALITY VERDICT. The lines are graded by `scripts/judge-corpus.ts`,\n" +
			"blinded, against the payload each arm actually held. Run that on this file before ranking anything."
	)
}

/* ==================================================================== main */

/**
 * The blinded HTML sheet, so a human can settle what a judge cannot see.
 *
 * Built from stored runs rather than written during one, because that is the only way a sheet can
 * span BOTH games: the effect this file measured is not homogeneous across them, and a sheet
 * covering only the game that carried it would be a sheet selected on its own result. Every line
 * every arm spoke goes on, shuffled, with the arm label in the key file and nowhere on the page.
 *
 * The card carries the payload the line was answering, which is the thing that makes a sentence
 * gradeable at all, and NOT the frame: the stored runs keep the frame's clock and not its bytes,
 * and a card showing a picture from one run and none from another would group by run.
 */
const writeSheet = (paths: readonly string[]): void => {
	const lines: SheetLine[] = []
	let n = 0
	for (const path of paths) {
		const run = JSON.parse(readFileSync(path, "utf8")) as BakeRun
		for (const c of run.calls) {
			if (!c.spoke || c.error !== null) continue
			n += 1
			lines.push({
				id: `L${String(n).padStart(3, "0")}`,
				armKey: c.arm,
				clock: c.clock,
				atSec: c.atSec,
				text: c.text,
				latencyMs: c.completeMs,
				block: c.payload,
				offered: [],
				frameB64: null,
				windowId: c.windowId,
				skewMs: null
			})
		}
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
	const storeKey = `socket-bake-${stamp}`
	const out = arg("out", `${DATA_DIR}/eval/socket-bake-sheet-${stamp}.html`)
	writeFileSync(
		out,
		renderSheet(lines, {
			title: "Which coach would you rather have in your ear?",
			storeKey,
			note:
				"Every line below was said at the clock shown, about the payload shown, by one of several " +
				"models answering the SAME turns of the same two games. Which model said which is not on this " +
				"page. Grade what the line is worth to a jungler at that instant."
		})
	)
	writeFileSync(out.replace(/\.html$/, "-key.json"), renderKey(lines, storeKey))
	console.log(`wrote ${out} (${lines.length} lines from ${paths.length} run(s)) and its key beside it`)
}

const main = async (): Promise<void> => {
	if (summarize !== "") {
		report(JSON.parse(readFileSync(summarize, "utf8")) as BakeRun)
		return
	}
	if (sheetOf !== "") {
		writeSheet(sheetOf.split(",").map(x => x.trim()).filter(x => x !== ""))
		return
	}

	const bench = discoverBenchable()
	const all: StreamWindow[] = [...bench.paired, ...bench.textOnly]
	const window =
		windowArg === "latest" ? all[0] : all.find(w => w.id === windowArg || w.gameId === windowArg)
	if (!window) throw new Error(`no window ${windowArg}; have ${all.length} benchable windows`)

	const stream = buildStream(window, {
		everySec: 20,
		fromSec: 0,
		turns: turnsWanted,
		requireFrame: false,
		schedule: "events",
		heartbeatSec: HEARTBEAT_SEC,
		level
	})
	for (const w of stream.warnings ?? []) console.log(`WARNING  ${w}`)

	const framed = stream.turns.filter(t => t.frameB64 !== null).length
	console.log(
		`\n${window.id}  game ${window.gameId}  ${window.champion}  ${stream.turns.length} turns ` +
			`(${noFrames ? 0 : framed} with a frame), level ${level}, ${stream.stepped} samples stepped`
	)
	for (const a of chosenArms) console.log(`  ${a.id.padEnd(11)} ${(a.model || "(no model)").padEnd(52)} ${a.what}`)
	const socketArms = chosenArms.filter(a => a.model !== "").length
	console.log(`\nabout to spend: ${dry ? 0 : stream.turns.length * socketArms} socket turns\n`)

	const wheres = noRead ? undefined : await readWhere(stream, `${DATA_DIR}/eval/bench-crops/${window.id}`)
	const calls = await runInterleaved(stream, wheres, chosenArms)

	const run: BakeRun = {
		ranAt: new Date().toISOString(),
		argv,
		level,
		schedule: stream.schedule,
		arms: [...chosenArms],
		calls,
		windows: [
			{
				id: window.id,
				gameId: window.gameId,
				champion: window.champion,
				counterpart: stream.turns.find(t => t.counterpart !== null)?.counterpart ?? null,
				kind: window.kind ?? "paired",
				gameDurationSec: window.gameDurationSec ?? 0
			}
		],
		records: calls.map(c => ({
			arm: c.arm,
			windowId: c.windowId,
			index: c.index,
			rep: c.rep,
			atSec: c.atSec,
			clock: c.clock,
			text: c.text,
			error: c.error,
			payload: c.payload
		})),
		turns: stream.turns.map(t => ({
			index: t.index,
			atSec: t.atSec,
			clock: t.clock,
			hasFrame: t.frameB64 !== null,
			payloadChars: t.brief.length
		}))
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
	const out = arg("out", `${DATA_DIR}/eval/socket-bake-${stamp}.json`)
	mkdirSync(dirname(out), { recursive: true })
	writeFileSync(out, JSON.stringify(run, null, 2))
	report(run)
	console.log(`\nwrote ${out}`)
}

await main()
