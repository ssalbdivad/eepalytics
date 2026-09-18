/**
 * What is the screenshot worth, and is it being read at all?
 *
 * ## The question, and why it is still open
 *
 * Every turn of the live coach carries a JPEG of his whole monitor: 1536x864, a median 167KB on
 * disk and 223KB once it is base64'd into the socket frame. Two stored measurements disagree about
 * whether that is money well spent.
 *
 *   - In the twelve-variant tournament the FRAME-ONLY arm scored worst by a distance — 1 useful
 *     against 7 false on the truth judge — and the NO-FRAME arm scored top on value. Read on its
 *     own that says drop the picture.
 *   - But that tournament ran before `minimap-watch.ts`. The frame-only arm was being asked to
 *     supply POSITION by reading two-pixel dots off a downscaled minimap, which `probe-minimap.ts`
 *     measured landing a median 43% of the map's width from the truth, i.e. at chance. Position now
 *     comes from a dedicated read of a magnified crop, fenced against the client, and rides in the
 *     payload as text. So the tournament measured the picture doing the one job it is worst at, and
 *     the job it is worst at has since been taken off it.
 *
 * Nobody has measured what is LEFT. That is this file.
 *
 * ## The design, and the one thing it refuses to do
 *
 * It refuses to run the two arms one after the other. Everything this app has learned about its own
 * measurements says a difference between two runs is a difference in two runs: the ranker's memory,
 * the model version, the network, the hour. So every arm here runs on ONE schedule over ONE game,
 * and the turns are INTERLEAVED — each arm holds its own live socket, and round N is sent to every
 * arm in turn, seconds apart, before round N+1 is sent to any of them. The arm ORDER inside a round
 * rotates, so no arm is permanently the one that sends first after the pause.
 *
 * What that buys: thread position is identical across arms (turn 7 is turn 7 everywhere, which
 * matters because latency is measured at 1534ms + 64.5ms x turn index), wall clock is shared to
 * within seconds, and the block is the same replayed state. The minimap read is taken ONCE per turn
 * and handed to every arm, so a difference between two arms is never a second roll of the reader.
 *
 * ONE THING IS NOT IDENTICAL AND CANNOT BE. The shipped protocol carries what the coach has already
 * said into the next payload (`renderSaid`), so from turn two onward each arm's payload contains
 * its own history. That is a consequence of the frame, not a confound beside it — an arm that says
 * different things has different things to not repeat — but it does mean the payloads are
 * byte-identical only on turn one, and a reader who wants a pure block ablation should say so.
 *
 * ## The arms
 *
 *   `frame`    THE SHIPPED PATH. `[inlineData(jpeg), text]`, the real frame for that instant.
 *   `noframe`  The same turn with the picture removed. The ablation.
 *   `decoy`    The shipped path with a frame from a DIFFERENT MINUTE of the same game, chosen to be
 *              at least five minutes away. This is the control that `frame` vs `noframe` cannot
 *              be: if the two arms agree, that is either "the model looked and the picture added
 *              nothing" or "the model never looked", and only a picture that CONTRADICTS the text
 *              can tell them apart. Borrowed whole from `scripts/frame-swap.ts`, which established
 *              the technique on the turn-based path.
 *   `last`     The shipped prompt with the JPEG sent AFTER the text instead of before it. The
 *              ORDERING candidate for the two misuses below.
 *   `check`    The shipped ordering with `PICTURE_NOW` appended to the system prompt. The PROMPT
 *              candidate for the same two misuses.
 *
 * ## The two misuses these last two arms are aimed at
 *
 * From the graded stream of game 5639406342, and they are the opposite of the failure the rest of
 * this app fights. Nothing was fabricated; the picture simply was not consulted:
 *
 *   18:39  "kite this team fight out"                  — the frame shows him ALONE in an empty river.
 *   20:53  "you are near spawn, back immediately"       — the frame shows him MID-FIGHT taking damage.
 *
 * Both are a clause that was true seconds ago spoken as an instruction about now. Whether the fix
 * is where the bytes sit or what the prompt says about them is an empirical question, so both are
 * arms rather than an opinion.
 *
 * ## The judge
 *
 * A line is graded against ITS OWN TURN'S REAL FRAME whatever arm produced it — including the decoy
 * arm's lines, which are judged against the picture the coach should have been looking at rather
 * than the one it got. Arm labels are stripped; every line for one turn is graded together in one
 * shuffled batch, so the judge is comparing sentences about one instant and cannot be reading a
 * label. The four verdicts are `blind-judge.ts`'s four, unchanged, so these rates sit beside the
 * ones already in `data/eval/`.
 *
 * On top of them one extra field, which is the actual question:
 *
 *   `only-with-picture`       the line could not have been written from the text alone.
 *   `either`                  the text carries it.
 *   `contradicted-by-picture` the frame shows the line is wrong about this instant. THE MISUSE.
 *
 * `only-with-picture` is what the frame BOUGHT. `contradicted-by-picture` is what ignoring it COST.
 * The judge is a different model family from the coach on purpose.
 *
 * ## The statistics
 *
 * The arms are PAIRED — same turn, same state — so two independent Wilson intervals are the wrong
 * test and would be the conservative kind of wrong that hides a real effect. The paired test is
 * McNemar's on the discordant turns, exact binomial, and it is printed beside the Wilson intervals
 * rather than instead of them so a reader can see both.
 *
 * ## What it found, 2026-09-11, on game 5639406342 (Lillia into Kayn, 28:14)
 *
 * Two interleaved runs over the whole game, five arms between them, 181 spoken lines, every line
 * re-judged against its own real frame. The files are
 * `data/eval/frame-value-20260911-ablation*.json` and `...-fixes*.json`; the `-rejudged-` files are
 * a SECOND score of the same socket transcripts, written beside the first rather than over it.
 *
 *   1. **THE ABLATION IS NULL.** `frame` and `noframe` scored identically — 10 of 30 useful and 13
 *      of 30 false, each. McNemar p = 1.000 on both axes, on 10 discordant turns split 5-5.
 *   2. **AND THE RUN COULD NOT HAVE SEEN A SMALL EFFECT.** Run the SAME arm twice and it agrees
 *      with itself on 13 of 30 turns for `useful` and 15 of 30 for `false`, and repeats not one of
 *      its 30 sentences (`--agree`). At that discordance the exact test needs about 9 of 10
 *      discordant turns to fall one way, i.e. roughly 27 points of useful rate on one game. So
 *      "no difference" here means "nothing bigger than a quarter of the scale", not "nothing".
 *   3. **THE PICTURE IS READ — the decoy is the only arm that moved.** A frame from a different
 *      minute took `false` from 13 of 30 to 18 of 30 (McNemar 9 against 4, p = 0.267). The
 *      direction is that a wrong picture actively misleads, which means the right one is being
 *      looked at; the magnitude is not established.
 *   4. **NEITHER FIX FOR THE TWO MISUSES IS SUPPORTED.** Sending the JPEG after the text instead of
 *      before it changed nothing (37% useful against 37%, p = 1.000). `PICTURE_NOW`, the paragraph
 *      telling the coach the frame outranks the text about the present, scored WORSE on both axes
 *      (23% useful, 60% false; p = 0.424) and did not reduce `contradicted-by-picture`. It is kept
 *      in this file, refuted, rather than shipped.
 *   5. **`only-with-picture` IS NOT A USABLE MEASUREMENT and the run says so itself.** The BLIND
 *      arm was given that label on 7 of 30 lines, which is impossible by construction, while the
 *      sighted arm got it on 3 of 30. The label's error rate is at least 23% and it points the
 *      wrong way, so "what the frame bought" is NOT answered here. The calibration is printed in
 *      every report rather than left for a reader to notice.
 *   6. **THE PRICE IS THE ONE HARD NUMBER.** One picture adds 1,102 prompt tokens (1,040-1,159,
 *      measured from the socket's own `usageMetadata`). But one socket per game keeps every frame
 *      in the thread, so the 31 pictures cost 543,412 prompt tokens across the game — 30% of the
 *      whole prompt bill, 493 times the marginal price of the pictures themselves — plus 6.5MB of
 *      JPEG uploaded. And it is SLOW: paired turn against paired turn, the frame arm came back
 *      later on 28 of 31 turns by a median 345ms, sign test p < 0.00001 — about a quarter of the
 *      p50 this app is already trying to cut, and the only effect anywhere in this file that
 *      separates at all.
 *   7. Two things fell out that are nobody's arm. Under `trusted` on the event schedule the coach
 *      spoke on **every one of 31 turns** and never once passed, so any comparison of the
 *      speak-or-pass decision has no variance in it. And the frame at 0:00 of this game is a
 *      SCREENSHOT OF A CODE EDITOR, which the judge caught on all three arms at once.
 *
 * ## Cost
 *
 * It prints the exact number of paid socket turns and judge calls before the first one. Nothing is
 * spent under `--dry`, which walks the whole path — stream, wheres, payloads, report — with every
 * arm answering the payload's first bullet, so the plumbing can be exercised for free.
 *
 * ## Usage
 *
 *     node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *       scripts/frame-value.ts --window js-mtvxb5f4-f81a-t29817812 --arms frame,noframe --turns 12
 *
 *     --window <id|latest>    which paired frame+sample window to replay (default: the Kayn game)
 *     --arms a,b,c            any of frame,noframe,decoy,last,check (default: frame,noframe)
 *     --turns N               how many checkpoints (default: all of them)
 *     --from SEC              game clock to start sending at; the ranker is stepped from 0 anyway
 *     --judge <provider>      who grades (default: anthropic). `--judge none` skips grading
 *     --judge-model <id>      free text, as everywhere in this app
 *     --no-read               skip the minimap pre-pass, so no turn carries a position
 *     --timeout MS            per-turn liveness budget for each socket (default 120000)
 *     --dry                   no network, no bill; every arm echoes the payload's first bullet
 *     --out <path>            where the run JSON goes (default data/eval/frame-value-<stamp>.json)
 *     --sheet                 also write the blinded HTML sheet and its key, for a human pass
 *     --agree <a> <b>         THE NOISE FLOOR: take one arm that appears in both runs and print how
 *                             often its verdicts agree with THEMSELVES across the two. Read every
 *                             between-arm difference against this number, never against zero
 *     --summarize <path>      re-print a stored run, and re-score it, without calling anything
 *     --rejudge <path>        re-grade a stored run's spoken lines and write a NEW file beside it.
 *                             Costs judge calls and no socket turns, so a judging bug is fixable
 *                             without re-spending on the model or losing the lines already said.
 *                             The original file is never touched
 *
 * DO NOT run this while a game is in progress: it holds several Gemini Live sockets, and the live
 * coach wants one of them. NODE ONLY.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DATA_DIR } from "../src/shared/constants.ts"
import { buildStream, discoverWindows } from "./lib/stream.ts"
import { HEARTBEAT_SEC } from "../src/analysis/live-events.ts"
import type { BuiltStream, StreamTurn, StreamWindow } from "./lib/stream.ts"
import { protocolFor, readWhere } from "./bench-stream.ts"
import type { Arm, TurnWhere } from "./bench-stream.ts"
import { socketSystemPrompt } from "../src/server/routes/live.ts"
import { GEMINI_LIVE_MODEL, mintGeminiToken } from "../src/review/gemini-live.ts"
import { fullKnowledge } from "../src/review/live-knowledge-full.ts"
import { modelHandleFor, providerById, providerKey } from "../src/review/live-providers.ts"
import { wilson } from "../src/analysis/coach-score.ts"
import type { Interval } from "../src/analysis/coach-score.ts"
import { mcnemar, shuffled } from "./lib/stats.ts"
import { renderKey, renderSheet } from "./lib/sheet.ts"
import type { SheetLine } from "./lib/sheet.ts"

/* ================================================================== arguments */

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : fallback
}
/** The nth word after a flag, for the two-argument `--agree`. */
const argN = (name: string, n: number): string => {
	const i = argv.indexOf(`--${name}`)
	const v = i >= 0 ? argv[i + 1 + n] : undefined
	return v !== undefined && !v.startsWith("--") ? v : ""
}
const has = (name: string): boolean => argv.includes(`--${name}`)

/** The Kayn game: 28:14, 333 paired frames, and the game both measured misuses are in. */
const DEFAULT_WINDOW = "js-mtvxb5f4-f81a-t29817812"

const windowArg = arg("window", DEFAULT_WINDOW)
const turnsWanted = Number(arg("turns", "999"))
const fromSec = Number(arg("from", "0"))
const timeoutMs = Number(arg("timeout", "120000"))
const dry = has("dry")
const noRead = has("no-read")
const wantSheet = has("sheet")
const judgeProvider = arg("judge", "anthropic")
const judgeModelArg = arg("judge-model", "")
const summarize = arg("summarize", "")
const rejudge = arg("rejudge", "")
const agreeA = argN("agree", 0)
const agreeB = argN("agree", 1)

/* ============================================== the prompt candidate, and its verdict */

/**
 * A CANDIDATE that was benched and REFUTED. It lives here, not in the shipped prompt, for that
 * reason — and it stays runnable so the arm that refuted it can be re-run.
 *
 * The two failures it was written against are both in the graded stream of game 5639406342, and
 * both are the opposite of the failure the rest of this app fights. Nothing was fabricated; the
 * picture simply was not consulted:
 *
 *   18:39  "kite this team fight out"                 — the frame shows him ALONE in an empty river.
 *   20:53  "you are near spawn, back immediately"      — the frame shows him MID-FIGHT taking damage.
 *
 * Both are a clause that was true seconds ago spoken as an instruction about now. The paragraph
 * says nothing about WHAT to say or WHEN to speak; it says what the frame IS relative to the text
 * and how far its authority reaches. It was benched as the `check` arm against the shipped prompt
 * over one full game, interleaved, and it did not help on any axis this instrument measures.
 * `data/eval/frame-value-20260911-fixes.json` holds the run.
 *
 * It is kept rather than deleted because a refuted candidate with its run attached is the only kind
 * of evidence that stops the same paragraph being written again in six weeks.
 */
export const PICTURE_NOW = `

## The picture is the only part of this turn that is NOW

Everything written in the payload has an age. A minimap read was taken some seconds ago, the feed
is a list of things that have already finished, a count came from the last poll. The frame was
taken at the instant you are being asked about, and nothing else here was.

So when the words and the picture disagree about what is happening to HIM at this moment, the
picture settles it. If the text has him in base and the frame has him fighting, he is fighting. An
instruction about what to do in the next thirty seconds is a claim about his situation, and his
situation is in the frame — check it there before you spend the sentence on it.

That authority stops at the edge of his camera, and the asymmetry is the whole of the rule. He is
always in his own frame, so what it shows about HIM is a fact: that he is taking damage, that he is
in a fight, that he is recalling, that he is in base, that he is dead, that nobody else is on the
screen with him. Everybody else is only in it when his camera happens to be pointed their way, so
the picture can ADD a champion to the moment and can never REMOVE one. An ally who is not in the
frame is off camera, not missing; an enemy who is not in the frame is unseen, not elsewhere.`

/* ==================================================================== the arms */

export type FrameArmId = "frame" | "noframe" | "decoy" | "last" | "check"

export interface FrameArm {
	id: FrameArmId
	/** Does a JPEG ride with the turn at all? */
	vision: boolean
	/** Where the image part sits relative to the text part. The ORDERING candidate. */
	order: "image-first" | "image-last"
	/** The real frame for this instant, or one from a different minute of the same game. */
	source: "real" | "decoy"
	/** Appended to the system instruction. The PROMPT candidate. */
	appendix: string
	what: string
}

const ARMS: readonly FrameArm[] = [
	{
		id: "frame",
		vision: true,
		order: "image-first",
		source: "real",
		appendix: "",
		what: "the shipped path"
	},
	{
		id: "noframe",
		vision: false,
		order: "image-first",
		source: "real",
		appendix: "",
		what: "the same turn, blind"
	},
	{
		id: "decoy",
		vision: true,
		order: "image-first",
		source: "decoy",
		appendix: "",
		what: "a frame from a different minute — is the picture read at all?"
	},
	{
		id: "last",
		vision: true,
		order: "image-last",
		source: "real",
		appendix: "",
		what: "the JPEG after the text instead of before it"
	},
	{
		id: "check",
		vision: true,
		order: "image-first",
		source: "real",
		appendix: PICTURE_NOW,
		what: "the shipped path plus PICTURE_NOW"
	}
]

const armById = (id: string): FrameArm | undefined => ARMS.find(a => a.id === id)

const chosenArms: FrameArm[] = arg("arms", "frame,noframe")
	.split(",")
	.map(s => s.trim())
	.filter(s => s !== "")
	.map(id => {
		const a = armById(id)
		if (!a) throw new Error(`no arm called ${id}; have ${ARMS.map(x => x.id).join(",")}`)
		return a
	})

/**
 * The `Arm` the shipped protocol builder expects.
 *
 * `mode: "trusted"` and `shape: "socket"` because that is the shipped path and the only one this
 * file benches. `vision` is carried so `protocolFor` sees the same arm shape it sees in
 * `bench-stream.ts`; the image itself is attached by `sendTurn` below, not by the protocol.
 */
const asBenchArm = (a: FrameArm): Arm => ({
	id: a.id,
	provider: "gemini-live",
	model: GEMINI_LIVE_MODEL,
	mode: "trusted",
	shape: "socket",
	trim: null,
	add: null,
	// This file benches the FRAME, never the prompt: every arm here gets the shipped knowledge.
	knowledge: "full",
	vision: a.vision,
	available: true,
	unavailable: ""
})

/* =============================================================== the decoy frame */

/**
 * A frame from the SAME game and a DIFFERENT minute, as far away as the window allows.
 *
 * Far away matters more than any particular distance: the decoy's whole job is to contradict the
 * text it arrives with, and a frame thirty seconds off might legitimately show the same fight.
 * `frame-swap.ts` picked its two decoys by hand for maximum contradiction (a greyscale death
 * screen against a block saying he is alive); this has to run over a whole game, so it takes the
 * furthest frame instead and reports the median distance it achieved.
 */
const DECOY_MIN_GAP_SEC = 300

const decoyFor = (turn: StreamTurn, window: StreamWindow): { b64: string; tSec: number } | null => {
	let best: { b64: string; tSec: number; gap: number } | null = null
	for (const f of window.frames) {
		const gap = Math.abs(f.tSec - turn.atSec)
		if (gap < DECOY_MIN_GAP_SEC) continue
		if (best !== null && gap <= best.gap) continue
		try {
			best = { b64: readFileSync(f.path).toString("base64"), tSec: f.tSec, gap }
		} catch {
			/* a frame whose bytes will not read is not a decoy, it is a hole */
		}
	}
	return best === null ? null : { b64: best.b64, tSec: best.tSec }
}

/* ================================================================== the record */

export interface FrameCall {
	arm: FrameArmId
	index: number
	atSec: number
	clock: string
	/** What came back, trimmed. "" is a considered PASS; `error` says when it is not. */
	text: string
	spoke: boolean
	latencyMs: number
	/** Which picture rode with this turn, and from when. */
	frameSent: boolean
	framePath: string | null
	frameTSec: number | null
	/** The bytes and the tokens, so the price is measured rather than looked up. */
	frameB64Chars: number
	payloadChars: number
	payloadKind: string
	promptTokens: number | null
	responseTokens: number | null
	/** Position in this socket's own thread, and whether the socket was rebuilt in front of it. */
	threadTurn: number
	recycled: boolean
	error: string | null
}

/* ============================================================ the socket per arm */

interface TurnResult {
	text: string
	latencyMs: number
	promptTokens: number | null
	responseTokens: number | null
	/** How many turns this socket had already answered when this one was sent. */
	threadTurn: number
	/** True when this socket had to be rebuilt in front of this turn, losing the thread. */
	recycled: boolean
	error: string | null
}

interface OpenArm {
	send: (turn: StreamTurn, parts: unknown[]) => Promise<TurnResult>
	close: () => void
}

/**
 * One live socket per arm, driven one turn at a time by an external pump, rebuilt when it dies.
 *
 * `runSocketArm` in `bench-stream.ts` owns its own queue and drains it as fast as the model
 * answers, which is right for a single arm and exactly wrong here: this file's whole claim is that
 * round N reaches every arm before round N+1 reaches any of them, and that requires the pump to sit
 * OUTSIDE the socket. The transport shape — `clientContent` with `inlineData`, never
 * `realtimeInput.video` — is the same one, and for the same measured reason recorded there: on the
 * streaming shape the audio went silent and the model named champions who were not on screen, 6/6.
 *
 * ## Why this one reconnects and that one does not
 *
 * `runSocketArm` writes an error row for every turn a dead socket never reached, which is the
 * honest thing for a run whose arms are independent. Here they are not: the arms are PAIRED on the
 * turn, so a socket that dies at 4:32 does not cost that arm 28 turns, it costs the COMPARISON 28
 * turns, on every arm at once. Measured on the first attempt of this script: five concurrent live
 * sessions on one key, and the `frame` arm — the baseline — took `closed 1011: service currently
 * unavailable` on its ninth turn and stayed dead for the rest of the game.
 *
 * So a dead socket is rebuilt in front of the next turn. What that costs is stated rather than
 * hidden: the rebuilt socket has an EMPTY thread, so the model no longer has its own previous lines
 * to avoid repeating, and `recycled` and `threadTurn` are recorded per call so a reader can find
 * every turn where that happened and drop them if the question is about repetition.
 */
const openArm = async (arm: FrameArm, system: string): Promise<OpenArm> => {
	interface Live {
		ws: WebSocket
		dead: string | null
		answered: number
	}
	let live: Live | null = null
	let pending: { at: number; resolve: (v: TurnResult) => void; threadTurn: number; recycled: boolean } | null = null
	let partial = ""
	let audioParts = 0
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
			latencyMs: Date.now() - p.at,
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
						modelTurn?: { parts?: { text?: string; inlineData?: { mimeType?: string } }[] }
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
				if (sc.outputTranscription?.text) partial += sc.outputTranscription.text
				for (const p of sc.modelTurn?.parts ?? []) {
					if (p.text) partial += p.text
					if (p.inlineData) audioParts += 1
				}
				if (sc.turnComplete) {
					/*
					 * SPOKE-BUT-NO-TRANSCRIPT IS AN ERROR, NEVER A PASS — the same rule, and the
					 * same reason, as `runSocketArm`: audio was generated and he would have HEARD
					 * it, so filing it as restraint would let a dropped transcript flatter whichever
					 * arm dropped it.
					 */
					const dropped = partial.trim() === "" && audioParts > 0
					settle(partial.trim(), dropped ? `audio produced (${audioParts} chunks), transcript empty` : null)
					partial = ""
					audioParts = 0
				}
			}
			ws.onerror = () => {
				self.dead = self.dead ?? "socket error"
				clearTimeout(giveUp)
				settle("", self.dead)
				reject(new Error(`${arm.id}: ${self.dead}`))
			}
			ws.onclose = e => {
				self.dead = self.dead ?? (e.code === 1000 ? "socket closed" : `closed ${e.code}: ${String(e.reason).slice(0, 160)}`)
				clearTimeout(giveUp)
				settle("", self.dead)
				reject(new Error(`${arm.id}: ${self.dead}`))
			}
			ws.onopen = () =>
				ws.send(
					JSON.stringify({
						setup: {
							model: GEMINI_LIVE_MODEL,
							generationConfig: { responseModalities: ["AUDIO"] },
							outputAudioTranscription: {},
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
		send: async (turn, parts) => {
			let recycled = false
			if (live === null || live.dead !== null) {
				recycled = true
				try {
					live = await connect()
				} catch (e) {
					return {
						text: "",
						latencyMs: 0,
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
				audioParts = 0
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

const runInterleaved = async (
	stream: BuiltStream,
	wheres: Map<number, TurnWhere> | undefined,
	arms: readonly FrameArm[]
): Promise<FrameCall[]> => {
	const counterpart = stream.turns.find(t => t.counterpart !== null)?.counterpart ?? null
	const knowledge = fullKnowledge({ champion: stream.window.champion, counterpart })
	const base = socketSystemPrompt({ mode: "trusted", championKnowledge: knowledge })

	const protos = new Map(arms.map(a => [a.id, protocolFor(asBenchArm(a), stream, wheres)]))
	const decoys = new Map<number, { b64: string; tSec: number } | null>()
	if (arms.some(a => a.source === "decoy"))
		for (const t of stream.turns) decoys.set(t.index, decoyFor(t, stream.window))

	const sockets = new Map<FrameArmId, OpenArm>()
	const out: FrameCall[] = []

	if (!dry)
		for (const a of arms) {
			sockets.set(a.id, await openArm(a, `${base}${a.appendix}`))
			process.stdout.write(`opened ${a.id}\n`)
		}

	try {
		for (const [round, turn] of stream.turns.entries()) {
			/*
			 * THE ARM ORDER ROTATES. Inside a round the arms go one after another, so the first one
			 * sent is the one closest to the previous round's pause and the last one has had the
			 * others' latency added in front of it. Rotating by the round number spreads that
			 * evenly rather than giving it to one arm for the whole game.
			 */
			const order = arms.map((_, i) => arms[(i + round) % arms.length]!)
			for (const a of order) {
				const sent = protos.get(a.id)!.payload(turn)
				const parts: unknown[] = []
				const decoy = a.source === "decoy" ? (decoys.get(turn.index) ?? null) : null
				const b64 =
					!a.vision ? null
					: a.source === "decoy" ? (decoy?.b64 ?? null)
					: turn.frameB64
				const image = b64 === null ? null : { inlineData: { mimeType: "image/jpeg", data: b64 } }
				if (image !== null && a.order === "image-first") parts.push(image)
				parts.push({ text: sent.text })
				if (image !== null && a.order === "image-last") parts.push(image)

				const r =
					dry ?
						{
							text: sent.text.split("\n").find(l => l.startsWith("- "))?.slice(2, 110) ?? "",
							latencyMs: 0,
							promptTokens: null,
							responseTokens: null,
							threadTurn: 0,
							recycled: false,
							error: null
						}
					:	await sockets.get(a.id)!.send(turn, parts)

				const text = r.text.trim()
				const spoke = text !== "" && text.toUpperCase() !== "PASS" && r.error === null
				// The memory is fed from the transcript and only when there is one — a blank logged
				// as advice would put an empty bullet in every later payload of that arm.
				if (r.error === null) protos.get(a.id)!.heard(turn, text, r.latencyMs)
				out.push({
					arm: a.id,
					index: turn.index,
					atSec: turn.atSec,
					clock: turn.clock,
					text,
					spoke,
					latencyMs: r.latencyMs,
					frameSent: image !== null,
					framePath: a.source === "decoy" ? null : (turn.frame?.path ?? null),
					frameTSec: a.source === "decoy" ? (decoy?.tSec ?? null) : (turn.frame?.tSec ?? null),
					frameB64Chars: b64?.length ?? 0,
					payloadChars: sent.text.length,
					payloadKind: sent.kind,
					promptTokens: r.promptTokens,
					responseTokens: r.responseTokens,
					threadTurn: r.threadTurn,
					recycled: r.recycled,
					error: r.error
				})
				process.stdout.write(
					`${turn.clock} ${a.id.padEnd(8)} ${sent.kind} ${String(sent.text.length).padStart(5)}c ` +
						`${r.recycled ? "RECYCLED " : ""}${r.error ? `ERROR ${r.error}` : `${String(r.latencyMs).padStart(5)}ms`} ` +
						`${spoke ? text.slice(0, 84) : r.error ? "" : "PASS"}\n`
				)
			}
		}
	} finally {
		for (const s of sockets.values()) s.close()
	}
	return out
}

/* ================================================================== the judge */

/*
 * `ungraded` and `unknown` are the two states this judge used to have no way to say.
 *
 * A batch that would not parse twice had every line in it DROPPED — the count went to stdout and
 * nowhere else, and the rates below were computed over the survivors. Worse for this instrument
 * than for any other in the repo, because `contradicted-by-picture` is the label the central
 * open question turns on: a verdict word the judge phrased oddly was silently rewritten to
 * "unverifiable", and a framePower it phrased oddly was silently rewritten to "either" — the
 * MODAL value, so every parse wobble pushed the tally towards "the picture changed nothing".
 * A parse failure now says so in its own name and stays in the denominator, where it makes every
 * rate a visible floor instead of an invisible one.
 */
export type Verdict = "useful" | "generic" | "unverifiable" | "false" | "ungraded"
export type FramePower = "only-with-picture" | "either" | "contradicted-by-picture" | "unknown"
const VERDICTS = ["useful", "generic", "unverifiable", "false"] as const
const POWERS = ["only-with-picture", "either", "contradicted-by-picture"] as const

export interface Graded {
	arm: FrameArmId
	index: number
	atSec: number
	clock: string
	text: string
	verdict: Verdict
	framePower: FramePower
	why: string
}

/** The AI SDK's opaque model handle, named so `judgeBatch` does not have to say `unknown`. */
type ModelHandle = Awaited<ReturnType<typeof modelHandleFor>>

const JUDGE_SYSTEM = `You are grading single sentences a live League of Legends coach said out loud to a jungle
main, mid-game, while he was playing.

For each candidate you are given: the game clock, the ground-truth payload the app computed from
the game client at that instant, and the SCREENSHOT of his monitor at that same instant. The
screenshot is the truth about what was on his screen; the payload is the truth about the numbers.
Some candidates were produced by a coach that could not see the screenshot, and some by one that
was shown a screenshot from a completely different minute. You are not told which is which and you
must not guess — grade the sentence against the REAL screenshot and payload you are given here.

Return one verdict per candidate:

  "false"        it contradicts the payload or the screenshot, or it asserts something no channel
                 here could know. This is the only fatal verdict.
  "unverifiable" it may be true and nothing in the payload or the picture can check it.
  "generic"      true and checkable, but it would read identically in a different game or five
                 minutes earlier in this one.
  "useful"       true, specific to this instant, and it names something he can DO in the next
                 thirty seconds.

And one judgement about the picture's part in it:

  "only-with-picture"       the sentence could not have been written from the payload text alone —
                            it depends on something visible in the screenshot.
  "either"                  the payload text carries everything the sentence needs.
  "contradicted-by-picture" the screenshot shows the sentence is wrong about this instant, whatever
                            the payload says. Example shapes: telling him to disengage a fight when
                            he is alone on an empty screen; telling him to recall when he is taking
                            damage mid-fight; describing his surroundings as something they visibly
                            are not.

Reply with JSON only: {"grades":[{"id":"A","verdict":"...","framePower":"...","why":"under 20 words"}]}`

const judgeBatch = async (
	handle: ModelHandle,
	turn: StreamTurn,
	lines: readonly { id: string; arm: FrameArmId; text: string }[]
): Promise<Map<string, { verdict: Verdict; framePower: FramePower; why: string }>> => {
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
		/*
		 * 8000, not 4000. At 4000 the judge truncated mid-object on 10 of 31 batches in the first
		 * ablation run and 4 of 30 in the second, and a truncated batch drops EVERY line in it — so
		 * a third of the run vanished, unevenly across turns, for a reason that looked like nothing.
		 * A tight cap does not shorten a reasoning model, it cuts it off; the same lesson is already
		 * written down in AGENTS.md about the coach, and it applies to the instrument too.
		 */
		maxOutputTokens: 8000
	})
	const raw = (res.text ?? "").trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim()
	const parsed = JSON.parse(raw) as { grades?: { id?: string; verdict?: string; framePower?: string; why?: string }[] }
	const out = new Map<string, { verdict: Verdict; framePower: FramePower; why: string }>()
	// Only ids that were in this batch. An invented id used to land in the map, where it satisfied
	// the "did we get an answer" check for a line that never got one.
	const asked = new Set(lines.map(l => l.id))
	for (const g of parsed.grades ?? []) {
		if (!g.id || !asked.has(g.id)) continue
		const knownVerdict = VERDICTS.includes((g.verdict ?? "") as (typeof VERDICTS)[number])
		const knownPower = POWERS.includes((g.framePower ?? "") as (typeof POWERS)[number])
		out.set(g.id, {
			verdict: knownVerdict ? (g.verdict as Verdict) : "ungraded",
			framePower: knownPower ? (g.framePower as FramePower) : "unknown",
			why:
				knownVerdict && knownPower ? String(g.why ?? "").slice(0, 160)
				:	`judge returned ${knownVerdict ? "" : `verdict "${String(g.verdict).slice(0, 24)}" `}` +
					`${knownPower ? "" : `framePower "${String(g.framePower).slice(0, 24)}" `}— not a known value`
		})
	}
	return out
}

/**
 * One batch, then its HALVES — the same splitter `judge-corpus.ts` carries, and for the same
 * measured reason: a batch dies when ONE answer trips the parse and takes its neighbours with it.
 *
 * Here a "batch" is one TURN's worth of arms, so a dropped batch removes the turn from the paired
 * McNemar test entirely — it is not merely a smaller n, it is a turn that silently stopped voting.
 * Halving recovers every line whose own answer parsed. A line that fails alone is recorded
 * `ungraded` rather than dropped, so the turn still appears and the loss is visible in the table.
 */
const judgeSlice = async (
	handle: ModelHandle,
	turn: StreamTurn,
	lines: readonly { id: string; arm: FrameArmId; text: string }[],
	label: string
): Promise<Map<string, { verdict: Verdict; framePower: FramePower; why: string }>> => {
	const ungraded = (why: string) =>
		new Map(lines.map(l => [l.id, { verdict: "ungraded" as Verdict, framePower: "unknown" as FramePower, why }]))
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const got = await judgeBatch(handle, turn, lines)
			// A batch that parses but answers about only SOME of its lines is a partial failure and
			// is treated as one. `verdicts.size > 0` used to count as success, so the unanswered
			// lines were dropped without a retry.
			const missing = lines.filter(l => !got.has(l.id))
			if (missing.length === 0 || lines.length === 1) return got
			for (const [id, v] of await judgeSlice(handle, turn, missing, `${label}/missing`)) got.set(id, v)
			return got
		} catch (e) {
			const why = e instanceof Error ? e.message : String(e)
			if (attempt === 1) {
				if (lines.length === 1) {
					process.stdout.write(`  ${label}: one line failed alone twice, recorded UNGRADED: ${why}
`)
					return ungraded(`judge failed twice on this line alone: ${why.slice(0, 100)}`)
				}
				const mid = Math.ceil(lines.length / 2)
				const out = await judgeSlice(handle, turn, lines.slice(0, mid), `${label}a`)
				for (const [id, v] of await judgeSlice(handle, turn, lines.slice(mid), `${label}b`)) out.set(id, v)
				return out
			}
			process.stdout.write(`  ${label}: judge failed, retrying: ${why}
`)
		}
	}
	return ungraded("judgeSlice fell through")
}

const gradeRun = async (stream: BuiltStream, calls: readonly FrameCall[]): Promise<Graded[]> => {
	if (judgeProvider === "none") return []
	const p = providerById(judgeProvider)
	if (!p) throw new Error(`no provider called ${judgeProvider}`)
	const key = providerKey(p)
	if (!key) throw new Error(`no key for ${judgeProvider} — put one in data/${p.keyFile}`)
	const handle = await modelHandleFor(p, key, judgeModelArg || p.defaultModel)

	const graded: Graded[] = []
	const byTurn = new Map<number, FrameCall[]>()
	for (const c of calls) {
		if (!c.spoke) continue
		const list = byTurn.get(c.index) ?? []
		list.push(c)
		byTurn.set(c.index, list)
	}
	const LABELS = "ABCDEFGH"
	for (const turn of stream.turns) {
		const spoken = byTurn.get(turn.index) ?? []
		if (spoken.length === 0) continue
		const order = shuffled(spoken, turn.index * 7919 + 13)
		const lines = order.map((c, i) => ({ id: LABELS[i]!, arm: c.arm, text: c.text }))
		const verdicts = await judgeSlice(handle, turn, lines, `turn ${turn.clock}`)
		for (const l of lines) {
			/*
			 * An ungraded line is RECORDED, never dropped and never defaulted. A default would be a
			 * verdict this run invented and it would land on whichever arm the judge choked on;
			 * dropping it takes the turn out of the paired test without saying so. `ungraded` is
			 * neither — it is in every denominator and it is named in the table.
			 */
			const v = verdicts.get(l.id) ?? {
				verdict: "ungraded" as Verdict,
				framePower: "unknown" as FramePower,
				why: "no verdict returned for this line"
			}
			graded.push({
				arm: l.arm,
				index: turn.index,
				atSec: turn.atSec,
				clock: turn.clock,
				text: l.text,
				verdict: v.verdict,
				framePower: v.framePower,
				why: v.why
			})
		}
		process.stdout.write(`graded ${turn.clock} (${lines.length} line${lines.length === 1 ? "" : "s"})\n`)
	}
	return graded
}

/* ================================================================== statistics */

/**
 * McNemar's exact test on the discordant turns — the implementation is `lib/stats.ts`.
 *
 * The arms here are PAIRED — the same turn, the same state, seconds apart — and comparing two
 * independent Wilson intervals throws that pairing away. The information about a difference is in
 * the turns where the two arms DISAGREE; the ones where both were useful or both were not say
 * nothing either way. With b and c the two kinds of disagreement, the null is that a discordant
 * turn is equally likely to go either way, so the p-value is the two-sided exact binomial on
 * b of b+c at one half.
 *
 * Reported beside the Wilson intervals rather than instead of them: the intervals say how precisely
 * each rate is known, and this says whether the DIFFERENCE survives.
 *
 * It moved DOWN into the library on 2026-09-12 because `adjudicate.ts` had written the same test a
 * second time and `compare-arms.ts` was importing this copy out of a harness. Re-exported from here
 * so this file's own unit test and every stored run's numbers stay attached to the file that
 * produced them.
 */
export { mcnemar }
export type { McNemar } from "./lib/stats.ts"

const pct = (i: Interval): string =>
	`${(i.p * 100).toFixed(0)}% [${(i.lo * 100).toFixed(0)}-${(i.hi * 100).toFixed(0)}] ${i.k}/${i.n}`

/* ================================================================== the report */

interface RunFile {
	ranAt: string
	argv: string[]
	windowId: string
	gameId: string
	champion: string
	schedule: string
	arms: FrameArm[]
	judge: string
	calls: FrameCall[]
	graded: Graded[]
	turns: { index: number; atSec: number; clock: string; hasFrame: boolean; frameBytes: number; payloadChars: number }[]
}

const report = (run: RunFile): void => {
	const arms = run.arms.map(a => a.id)
	console.log(`\n${"=".repeat(78)}`)
	console.log(`frame-value — ${run.windowId}  game ${run.gameId}  ${run.champion}`)
	console.log(`${"=".repeat(78)}\n`)

	/* ---------------------------------------------------------- spoke / passed */
	console.log("SPEAKING")
	console.log("  arm       turns  spoke   pass   err   recyc   p50 latency")
	for (const id of arms) {
		const cs = run.calls.filter(c => c.arm === id)
		const spoke = cs.filter(c => c.spoke)
		const err = cs.filter(c => c.error !== null)
		const lat = spoke.map(c => c.latencyMs).sort((a, b) => a - b)
		console.log(
			`  ${id.padEnd(9)} ${String(cs.length).padStart(5)} ${String(spoke.length).padStart(6)} ` +
				`${String(cs.length - spoke.length - err.length).padStart(6)} ${String(err.length).padStart(5)} ` +
				`${String(cs.filter(c => c.recycled).length).padStart(7)}   ` +
				`${lat.length === 0 ? "—" : `${lat[Math.floor(lat.length / 2)]!}ms`}`
		)
	}

	const recycles = run.calls.filter(c => c.recycled).length
	if (recycles > 0)
		console.log(
			`  ${recycles} turn(s) were sent on a REBUILT socket with an empty thread — the model no longer had\n` +
				"  its own earlier lines to avoid repeating. `recycled` marks every one of them in the JSON."
		)

	if (run.graded.length === 0) {
		console.log("\n(no grading in this run)")
	} else {
		/* ------------------------------------------------------------- verdicts */
		console.log("\nVERDICTS — every line judged against ITS OWN TURN'S REAL FRAME")
		console.log("  arm       graded  useful               false                generic  unverif  ungraded")
		for (const id of arms) {
			const g = run.graded.filter(x => x.arm === id)
			if (g.length === 0) continue
			const u = wilson(g.filter(x => x.verdict === "useful").length, g.length)
			const f = wilson(g.filter(x => x.verdict === "false").length, g.length)
			console.log(
				`  ${id.padEnd(9)} ${String(g.length).padStart(6)}  ${pct(u).padEnd(20)} ${pct(f).padEnd(20)} ` +
					`${String(g.filter(x => x.verdict === "generic").length).padStart(7)} ` +
					`${String(g.filter(x => x.verdict === "unverifiable").length).padStart(8)} ` +
					`${String(g.filter(x => x.verdict === "ungraded").length).padStart(8)}`
			)
		}
		/*
		 * The ungraded lines are IN `graded` and therefore in every denominator above and below, so
		 * every rate on this page is a floor whenever this count is not zero. Said here rather than
		 * left to a reader to notice a column: the whole point of naming the state was to stop the
		 * loss being invisible, and a column nobody reads is still invisible.
		 */
		const lost = run.graded.filter(x => x.verdict === "ungraded")
		const powerless = run.graded.filter(x => x.framePower === "unknown")
		if (lost.length > 0 || powerless.length > 0)
			console.log(
				`\n  UNGRADED ${lost.length} of ${run.graded.length} line(s); framePower unknown on ${powerless.length}.\n` +
					`  They are counted in every denominator on this page, so each rate above is a FLOOR and its\n` +
					`  ceiling is that rate plus ${((100 * lost.length) / Math.max(1, run.graded.length)).toFixed(0)}pp. A judge that cannot answer is a fact about the run.`
			)

		/* ------------------------------------------------ what the frame bought */
		console.log("\nWHAT THE PICTURE DID — of the lines each arm spoke")
		console.log("  arm       only-with-picture   contradicted-by-picture")
		for (const id of arms) {
			const g = run.graded.filter(x => x.arm === id)
			if (g.length === 0) continue
			const only = wilson(g.filter(x => x.framePower === "only-with-picture").length, g.length)
			const bad = wilson(g.filter(x => x.framePower === "contradicted-by-picture").length, g.length)
			console.log(`  ${id.padEnd(9)} ${pct(only).padEnd(19)} ${pct(bad)}`)
		}
		const bought = run.graded.filter(x => x.framePower === "only-with-picture")
		if (bought.length > 0) {
			console.log("\n  the lines that could ONLY have been said with the picture:")
			for (const b of bought.slice(0, 14))
				console.log(`    ${b.clock} ${b.arm.padEnd(8)} [${b.verdict}] ${b.text.slice(0, 92)}`)
		}
		const misuse = run.graded.filter(x => x.framePower === "contradicted-by-picture")
		if (misuse.length > 0) {
			console.log("\n  THE MISUSE — lines the frame contradicts:")
			for (const b of misuse.slice(0, 14))
				console.log(`    ${b.clock} ${b.arm.padEnd(8)} [${b.verdict}] ${b.text.slice(0, 92)}`)
		}

		/* ------------------------------------------------- the judge's own error rate */
		/*
		 * THE BLIND ARM IS THE CALIBRATION, and it costs nothing.
		 *
		 * `only-with-picture` is the label the recommendation turns on, and it is a judgement about
		 * where a sentence COULD have come from, which is exactly the kind of thing a judge holding
		 * the picture will over-attribute to the picture. The `noframe` arm never saw one. So every
		 * `noframe` line labelled `only-with-picture` is a demonstrated error, and their share is a
		 * floor under the label's error rate — measured on this run, by this judge, not assumed.
		 */
		if (arms.includes("noframe")) {
			const blind = run.graded.filter(x => x.arm === "noframe")
			const wrong = blind.filter(x => x.framePower === "only-with-picture")
			console.log(
				`\nJUDGE CALIBRATION  ${wrong.length} of ${blind.length} lines from the BLIND arm were labelled ` +
					`"only-with-picture".\n  That arm never saw a frame, so each is a judge error: ` +
					`${pct(wilson(wrong.length, blind.length))} is a floor under this label's error rate.`
			)
			for (const w of wrong.slice(0, 6)) console.log(`    ${w.clock} ${w.text.slice(0, 96)}`)
		}

		/* -------------------------------------------------------- the paired test */
		const baseline = arms.includes("frame") ? "frame" : arms[0]!
		console.log(`\nPAIRED, against ${baseline} — McNemar's exact on the turns where the two disagree`)
		console.log("  arm       useful: won lost  p        false: won lost  p")
		for (const id of arms) {
			if (id === baseline) continue
			const pairsFor = (test: (v: Verdict) => boolean) => {
				const out: { a: boolean; b: boolean }[] = []
				for (const t of run.turns) {
					const a = run.graded.find(x => x.arm === baseline && x.index === t.index)
					const b = run.graded.find(x => x.arm === id && x.index === t.index)
					// A turn where either arm was silent is NOT a pair. Silence is a decision, and
					// scoring it as "not useful" would make the quietest arm the worst one.
					if (!a || !b) continue
					out.push({ a: test(a.verdict), b: test(b.verdict) })
				}
				return out
			}
			const u = mcnemar(pairsFor(v => v === "useful"))
			const f = mcnemar(pairsFor(v => v === "false"))
			console.log(
				`  ${id.padEnd(9)}         ${String(u.bOnly).padStart(3)} ${String(u.aOnly).padStart(4)}  ${u.p.toFixed(3)}` +
					`          ${String(f.bOnly).padStart(3)} ${String(f.aOnly).padStart(4)}  ${f.p.toFixed(3)}`
			)
		}
		console.log(
			`  (won = turns where this arm was ${baseline} was not; lost = the other way. Only turns where\n` +
				"   BOTH arms spoke are pairs — a turn one arm passed on carries no comparison.)"
		)

		/* ---------------------------------------------------- the decoy, if it ran */
		/*
		 * THE DECOY IS THE ONLY ARM THAT CAN TELL BLINDNESS FROM BAD PRECEDENCE, and the first
		 * version of this section asked it the wrong question.
		 *
		 * It compared the SPEAK-OR-PASS decision, on the theory that a model which had looked at a
		 * contradictory picture would more often decline to speak. Measured: every arm spoke on
		 * every one of the 31 turns, so that comparison had no variance in it at all and printed
		 * 31 of 31 as though it were a finding. Under this architecture PASS does not happen, which
		 * is worth knowing and is not evidence about the frame.
		 *
		 * What the decoy CAN be asked is whether a wrong picture produces worse lines than the
		 * right one against the same real frame. A decoy that grades the same as the sighted arm
		 * means the picture is inert; a decoy that grades worse means it is being read.
		 */
		if (arms.includes("decoy") && arms.includes("frame")) {
			const g = (id: string, test: (x: Graded) => boolean) => {
				const all = run.graded.filter(x => x.arm === id)
				return wilson(all.filter(test).length, all.length)
			}
			const everPassed = run.calls.some(c => !c.spoke && c.error === null)
			console.log("\nTHE DECOY — a frame from a different minute, graded against the RIGHT one")
			console.log(
				`  useful      real ${pct(g("frame", x => x.verdict === "useful"))}   ` +
					`decoy ${pct(g("decoy", x => x.verdict === "useful"))}`
			)
			console.log(
				`  false       real ${pct(g("frame", x => x.verdict === "false"))}   ` +
					`decoy ${pct(g("decoy", x => x.verdict === "false"))}`
			)
			console.log(
				`  contradicted real ${pct(g("frame", x => x.framePower === "contradicted-by-picture"))}   ` +
					`decoy ${pct(g("decoy", x => x.framePower === "contradicted-by-picture"))}`
			)
			console.log(
				everPassed ?
					"  (both arms declined to speak on some turns, so the speak-or-pass decision carries signal too)"
				:	`  Every arm spoke on every one of the ${run.turns.length} turns — PASS never happened under this\n` +
					"  architecture, so the speak-or-pass decision carries NO information about the picture here."
			)
		}
	}

	/* ---------------------------------------------------------------- the price */
	console.log("\nPRICE")
	const withFrame = run.turns.filter(t => t.hasFrame)
	const med = (xs: number[]): number => (xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!)
	const frameBytes = withFrame.map(t => t.frameBytes)
	console.log(`  turns in this game: ${run.turns.length}, of which ${withFrame.length} carry a frame`)
	console.log(
		`  on the wire: median ${Math.round(med(frameBytes) / 1024)}KB of base64 per turn, ` +
			`${(frameBytes.reduce((a, b) => a + b, 0) / 1024 / 1024).toFixed(1)}MB uploaded over the game`
	)
	console.log(`  payload text: median ${med(run.turns.map(t => t.payloadChars))} chars`)
	/*
	 * THE PICTURE IS BILLED ONCE AND PAID FOR EVERY TURN AFTER IT, and the first version of this
	 * report got that wrong in the direction that flatters the frame.
	 *
	 * `promptTokenCount` on a live socket is the WHOLE CONTEXT, not this turn's new bytes. So the
	 * raw frame-minus-noframe difference at turn N is not the cost of one image, it is the cost of
	 * every image sent so far — it read 1,102 on turn one of the ablation run and 34,024 on turn
	 * thirty-one, and quoting its median as a per-turn figure reports a 17,448-token image. Three
	 * different numbers are needed and they are printed as three:
	 *
	 *   marginal   what ONE picture adds to the context. The first difference of the differences.
	 *   standing   what the pictures already sent are costing on the LAST turn of the game.
	 *   total      every prompt token billed across the game, with and without. This is the bill,
	 *              and it is the only one of the three that answers "what would dropping it save".
	 */
	const diffs: { index: number; diff: number }[] = []
	let frameTotal = 0
	let blindTotal = 0
	for (const t of run.turns) {
		const a = run.calls.find(c => c.arm === "frame" && c.index === t.index)?.promptTokens
		const b = run.calls.find(c => c.arm === "noframe" && c.index === t.index)?.promptTokens
		if (typeof a !== "number" || typeof b !== "number") continue
		diffs.push({ index: t.index, diff: a - b })
		frameTotal += a
		blindTotal += b
	}
	if (diffs.length < 2) {
		console.log("  (no paired frame/noframe prompt-token counts in this run — cannot price the tokens)")
		return
	}
	diffs.sort((a, b) => a.index - b.index)
	const marginal = diffs.map((d, i) => (i === 0 ? d.diff : d.diff - diffs[i - 1]!.diff))
	console.log(
		`  MEASURED, from the socket's own usageMetadata over ${diffs.length} paired turns:\n` +
			`    marginal  one picture adds ${med(marginal)} prompt tokens (${Math.min(...marginal)}-${Math.max(...marginal)})\n` +
			`    standing  by the last turn the pictures already sent cost ${diffs[diffs.length - 1]!.diff} tokens on EVERY turn\n` +
			`    total     ${frameTotal.toLocaleString()} prompt tokens billed over the game against ${blindTotal.toLocaleString()} blind\n` +
			`    => dropping the frame saves ${(frameTotal - blindTotal).toLocaleString()} prompt tokens per game, ` +
			`${((100 * (frameTotal - blindTotal)) / frameTotal).toFixed(0)}% of the prompt bill`
	)
	/*
	 * AND THE LATENCY, PAIRED — the one axis where the picture has a clearly measured cost.
	 *
	 * A sign test rather than a mean, because the two arms are the same turn seconds apart and the
	 * question is simply which of the two came back first. On the ablation run the frame arm was
	 * slower on 28 of 31 turns by a median 345ms, p < 0.00001 — about a quarter of the p50 the app
	 * is already trying to cut. That is the only effect in this whole file that separates.
	 */
	const lat: number[] = []
	for (const t of run.turns) {
		const a = run.calls.find(c => c.arm === "frame" && c.index === t.index)
		const b = run.calls.find(c => c.arm === "noframe" && c.index === t.index)
		if (a && b && a.error === null && b.error === null) lat.push(a.latencyMs - b.latencyMs)
	}
	if (lat.length > 0) {
		const slower = lat.filter(x => x > 0).length
		const sign = mcnemar(lat.map(x => ({ a: x > 0, b: x < 0 })))
		console.log(
			`    latency   the frame arm was slower on ${slower} of ${lat.length} turns, ` +
				`median ${med(lat)}ms (sign test p ${sign.p < 0.0001 ? "< 0.0001" : sign.p.toFixed(4)})`
		)
	}
	console.log(
		"  The compounding is the point: one socket per game keeps every frame in the thread, so a picture\n" +
			"  sent at 3:00 is re-billed on all 28 turns after it. That is what makes the per-game figure\n" +
			`  ${Math.round((frameTotal - blindTotal) / med(marginal))}x the ${diffs.length} pictures actually sent.`
	)
}

/* ================================================================== main */

/**
 * Re-grade a stored run, spending nothing on the model that produced it.
 *
 * The socket half of a run costs real money and cannot be repeated identically; the judging half is
 * an instrument and instruments get fixed. So this reloads a run, rebuilds the stream it was taken
 * from — for the frames and the ground truth the judge needs — grades the lines again and writes a
 * NEW file. The original is never touched, which is the standing rule: a stored measurement stays
 * re-scorable, and "re-scorable" means a second score sits BESIDE the first, not on top of it.
 *
 * Turns are matched by GAME CLOCK and not by index. `buildStream` does not always produce the same
 * number of checkpoints for one window across processes — the two runs of 2026-09-11 on this same
 * window came out at 31 turns and 30 — so an index from the stored file is not a promise about the
 * stream rebuilt today, and a silent off-by-one would judge every line against the wrong picture.
 */
const rejudgeStored = async (path: string): Promise<void> => {
	const stored = JSON.parse(readFileSync(path, "utf8")) as RunFile
	const windows = discoverWindows()
	const window = windows.find(w => w.id === stored.windowId)
	if (!window) throw new Error(`the window ${stored.windowId} this run was taken from is no longer on disk`)
	const stream = buildStream(window, {
		everySec: 20,
		fromSec: 0,
		turns: 999,
		requireFrame: false,
		schedule: "events",
		heartbeatSec: HEARTBEAT_SEC
	})

	/* -- match stored turns to rebuilt turns by clock, and say what did not match -- */
	const MATCH_SEC = 1
	const byStoredIndex = new Map<number, StreamTurn>()
	for (const st of stored.turns) {
		const hit = stream.turns.find(t => Math.abs(t.atSec - st.atSec) <= MATCH_SEC)
		if (hit) byStoredIndex.set(st.index, hit)
	}
	const missing = stored.turns.length - byStoredIndex.size
	console.log(
		`re-judging ${path}\n  ${stored.turns.length} stored turns, ${stream.turns.length} rebuilt, ` +
			`${byStoredIndex.size} matched within ${MATCH_SEC}s of game clock` +
			(missing === 0 ? "" : `, ${missing} UNMATCHED and therefore not re-judged`)
	)

	const spokenByTurn = new Map<number, FrameCall[]>()
	for (const c of stored.calls) {
		if (!c.spoke || !byStoredIndex.has(c.index)) continue
		const list = spokenByTurn.get(c.index) ?? []
		list.push(c)
		spokenByTurn.set(c.index, list)
	}

	/*
	 * `gradeRun` takes a stream and a call list, so it is handed a stream whose turns are the
	 * REBUILT ones addressed by the STORED indexes. Building that shim here rather than teaching
	 * `gradeRun` about two coordinate systems keeps the grading path identical for a live run and
	 * a re-judged one — which is the only way the two files are comparable.
	 */
	const shim: BuiltStream = {
		...stream,
		turns: stored.turns
			.filter(st => byStoredIndex.has(st.index))
			.map(st => ({ ...byStoredIndex.get(st.index)!, index: st.index }))
	}
	const graded = await gradeRun(shim, stored.calls.filter(c => spokenByTurn.has(c.index)))

	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
	const out = arg("out", path.replace(/\.json$/, `-rejudged-${stamp}.json`))
	const next: RunFile = {
		...stored,
		ranAt: new Date().toISOString(),
		argv,
		judge: judgeProvider === "none" ? "none" : `${judgeProvider}/${judgeModelArg || providerById(judgeProvider)?.defaultModel}`,
		graded
	}
	writeFileSync(out, JSON.stringify(next, null, 2))
	report(next)
	console.log(`\nwrote ${out}  (a SECOND score of ${path}, which is unchanged)`)
}

/**
 * THE NOISE FLOOR, and it is the number that decides how everything else here should be read.
 *
 * The same arm, on the same window, with the same prompt, run twice, is a comparison whose true
 * difference is ZERO by construction. Whatever this prints is what the instrument produces out of
 * nothing: the model's own sampling, plus the judge's. A between-arm difference smaller than it is
 * not evidence, however neat the table looks.
 *
 * Measured on the two runs of 2026-09-11: the `frame` arm agreed with itself on 13 of 30 turns for
 * `useful` and 15 of 30 for `false`, and not one of its 30 sentences was the same sentence twice.
 * At that discordance, McNemar needs about 9 of 10 discordant turns to fall one way before it will
 * call a difference — roughly 27 percentage points of useful rate on one game. This run found none,
 * which is a statement about the run's power at least as much as about the picture.
 */
const reportAgreement = (pathA: string, pathB: string): void => {
	const a = JSON.parse(readFileSync(pathA, "utf8")) as RunFile
	const b = JSON.parse(readFileSync(pathB, "utf8")) as RunFile
	const shared = a.arms.map(x => x.id).filter(id => b.arms.some(y => y.id === id))
	if (shared.length === 0) throw new Error("these two runs have no arm in common, so there is nothing to compare")
	console.log(`\nSELF-AGREEMENT — the same arm, the same window, two runs. True difference: zero.`)
	console.log(`  ${pathA}\n  ${pathB}\n`)
	for (const id of shared) {
		const byClock = (r: RunFile) => new Map(r.graded.filter(x => x.arm === id).map(x => [x.clock, x]))
		const ga = byClock(a)
		const gb = byClock(b)
		const clocks = [...ga.keys()].filter(c => gb.has(c))
		if (clocks.length === 0) continue
		console.log(`  arm ${id} — ${clocks.length} clocks graded in both`)
		for (const axis of ["useful", "false"] as const) {
			const pairs = clocks.map(c => ({ a: ga.get(c)!.verdict === axis, b: gb.get(c)!.verdict === axis }))
			const m = mcnemar(pairs)
			console.log(
				`    ${axis.padEnd(7)} agreed on ${m.both + m.neither}/${clocks.length}, ` +
					`flipped on ${m.aOnly + m.bOnly}  (McNemar p ${m.p.toFixed(3)} — a run against ITSELF)`
			)
		}
		const same = clocks.filter(c => ga.get(c)!.text === gb.get(c)!.text).length
		console.log(`    and it said the identical sentence on ${same} of ${clocks.length} of those clocks`)
	}
	console.log(
		"\n  Read every arm-versus-arm table in this file against these figures. A difference that is\n" +
			"  smaller than what one configuration produces against itself is not a difference."
	)
}

const main = async (): Promise<void> => {
	if (summarize !== "") {
		report(JSON.parse(readFileSync(summarize, "utf8")) as RunFile)
		return
	}
	if (rejudge !== "") {
		await rejudgeStored(rejudge)
		return
	}
	if (agreeA !== "" && agreeB !== "") {
		reportAgreement(agreeA, agreeB)
		return
	}

	const windows = discoverWindows()
	const window =
		windowArg === "latest" ? windows[0] : windows.find(w => w.id === windowArg || w.gameId === windowArg)
	if (!window) throw new Error(`no window ${windowArg}; have ${windows.map(w => w.id).join(", ")}`)

	const stream = buildStream(window, {
		everySec: 20,
		fromSec,
		turns: turnsWanted,
		requireFrame: false,
		schedule: "events",
		heartbeatSec: HEARTBEAT_SEC
	})
	for (const w of stream.warnings ?? []) console.log(`WARNING  ${w}`)

	const framed = stream.turns.filter(t => t.frameB64 !== null).length
	console.log(
		`\n${window.id}  game ${window.gameId}  ${window.champion}  ` +
			`${stream.turns.length} turns (${framed} with a frame), ${stream.stepped} samples stepped`
	)
	console.log(`arms: ${chosenArms.map(a => `${a.id} (${a.what})`).join(", ")}`)
	console.log(
		`about to spend: ${dry ? 0 : stream.turns.length * chosenArms.length} socket turns` +
			`${judgeProvider === "none" ? "" : ` and up to ${stream.turns.length} judge calls`}\n`
	)

	const wheres = noRead ? undefined : await readWhere(stream, `${DATA_DIR}/eval/bench-crops/${window.id}`)
	const calls = await runInterleaved(stream, wheres, chosenArms)
	const graded = dry ? [] : await gradeRun(stream, calls)

	const run: RunFile = {
		ranAt: new Date().toISOString(),
		argv,
		windowId: window.id,
		gameId: window.gameId,
		champion: window.champion,
		schedule: stream.schedule,
		arms: [...chosenArms],
		judge: judgeProvider === "none" ? "none" : `${judgeProvider}/${judgeModelArg || providerById(judgeProvider)?.defaultModel}`,
		calls,
		graded,
		turns: stream.turns.map(t => ({
			index: t.index,
			atSec: t.atSec,
			clock: t.clock,
			hasFrame: t.frameB64 !== null,
			frameBytes: t.frameB64?.length ?? 0,
			payloadChars: t.brief.length
		}))
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
	const out = arg("out", `${DATA_DIR}/eval/frame-value-${stamp}.json`)
	mkdirSync(dirname(out), { recursive: true })
	writeFileSync(out, JSON.stringify(run, null, 2))
	report(run)
	console.log(`\nwrote ${out}`)

	if (wantSheet) {
		const spoken = calls.filter(c => c.spoke)
		const lines: SheetLine[] = spoken.map((c, i) => {
			const t = stream.turns.find(x => x.index === c.index)!
			return {
				id: `L${String(i + 1).padStart(2, "0")}`,
				armKey: c.arm,
				clock: c.clock,
				atSec: c.atSec,
				text: c.text,
				latencyMs: c.latencyMs,
				block: t.brief || t.block,
				offered: t.offered,
				frameB64: t.frameB64,
				windowId: run.windowId,
				skewMs: t.skewMs
			}
		})
		const storeKey = `frame-value-${stamp}`
		const sheetPath = out.replace(/\.json$/, "-sheet.html")
		const keyPath = out.replace(/\.json$/, "-key.json")
		writeFileSync(
			sheetPath,
			renderSheet(lines, {
				title: "Is the picture worth sending?",
				storeKey,
				note:
					"Every line below was said at the clock shown, about the state shown, by one of several arms " +
					"that differ ONLY in whether — and how — a screenshot rode with the turn. Which arm said which " +
					"is not on this page. Grade what the line is worth to a jungler at that instant."
			})
		)
		writeFileSync(keyPath, renderKey(lines, storeKey))
		console.log(`wrote ${sheetPath}\nwrote ${keyPath}  (the key — do not open it before grading)`)
	}
}

if (import.meta.main) await main()
