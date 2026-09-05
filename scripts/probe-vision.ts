/**
 * Does the picture actually reach the live coach, or is she coaching from the block alone?
 *
 * ## Why this exists
 *
 * The owner turned the coach off mid-game and said: *"seems to indicate again that the agent is
 * not looking at the actual frames at all — its stuff that could all be inferred from the logs."*
 * Every line of the transcript he quit on was derivable from the ground-truth block. That is a
 * real observation and it has (at least) four different causes, which argument cannot separate and
 * measurement can:
 *
 *   1. the frame never leaves the browser (`grabFrame` returned null, or the share is frozen);
 *   2. the frame leaves but the socket does not deliver it to the model;
 *   3. the frame is delivered but the model cannot read a 1536x864 JPEG of a League HUD;
 *   4. the frame is delivered AND readable, and the coach simply never says anything about it —
 *      which is what the prompt *tells* her to do ("Never narrate what he is watching").
 *
 * Only (4) is a prompt problem. The other three are bugs, and they look identical from the couch.
 * This probe separates them with numbers.
 *
 * ## What it probes with
 *
 * Real frames. `data/journal/` holds 1,323 JPEGs written by the SAME `grabFrame()` the coach sends
 * (1536px wide, JPEG q0.72), each one stamped by the daemon with the live game clock at the moment
 * it was taken, and most carry the exact ground-truth block the coach was holding. So the journal
 * is not a substitute for what Gemini was sent — it IS what Gemini was sent, kept on disk.
 *
 * ## What it asks
 *
 * Only questions the picture can answer and the block cannot:
 *
 *   - **the game clock in the top-right corner.** Its ground truth is `journal_frame.tSec`, read
 *     from the Live Client Data API by the daemon, on the other side of the process from the
 *     picture. So this is scored against a number the model was never shown and that no human
 *     (including the author of this script) typed in. It is also the one picture-only fact that is
 *     available for every frame, which is what makes a rate rather than an anecdote possible.
 *   - **the FPS counter**, top-right under the clock. Nothing in the client feed carries it; the
 *     labels below were read off the pictures by hand.
 *
 * The clock is *also* in the block, which is the point: the same question can be asked with the
 * block absent, with the block's clock line deleted, and with the block's clock line deliberately
 * FALSIFIED. If the answer follows the falsified block the model is not reading the picture; if it
 * follows the picture, it is.
 *
 * ## Conditions
 *
 *   bare       one frame, a plain "read this" system prompt, no block.            capability floor
 *   stripped   frame + the real block with its `Clock` line removed.              block present
 *   conflict   frame + the real block with a FALSE clock (+7:00).                 who wins
 *   shipped    the real system prompt, the real turn as the app sends it, then    shipped config
 *              the question as a second turn — the app's own `ask()` path.
 *   blind      the question with NO frame at all.                                 confabulation
 *   scene      is the picture even OF the game? He shares a whole monitor.        what arrives
 *   drama      the real prompt and the real block with its fact list EMPTIED,     can it ever
 *              over frames of five-man fights — the one state in which the        speak from
 *              prompt permits a line to come from the picture.                    the picture
 *
 * `blind` is the control that makes the rest mean anything: a model that invents a plausible clock
 * when it cannot see one would score above zero by luck, and this measures exactly that.
 *
 * Run it (from a checkout whose data/ has a journal — the key lives there too):
 *
 *   EEPALYTICS_DATA_DIR=/path/to/data node --experimental-strip-types scripts/probe-vision.ts \
 *     --n 10 --out /tmp/vision.json
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { DB_PATH } from "../src/shared/constants.ts"
import { GEMINI_LIVE_MODEL, GEMINI_LIVE_WS, geminiKey } from "../src/review/gemini-live.ts"
import { LIVE_COACH_SYSTEM_PROMPT } from "../src/shared/live-prompt.ts"

/* ------------------------------------------------------------ hand labels */

/**
 * Picture-only facts read off these frames BY HAND, by opening the JPEG and looking at it.
 *
 * Labelled rather than computed because that is the honest description of where they came from:
 * nothing in the client feed, the database or the ground-truth block carries an FPS counter. The
 * clock is deliberately NOT taken from here — it comes from `journal_frame.tSec`, so the headline
 * number in this probe does not depend on the author's eyesight.
 *
 * `shop` marks the one frame in the set where the item shop is open over the game. It is the case
 * the block is structurally blind to, and the one where a coach reading only the block will talk
 * about farm to a man who is dead and shopping.
 */
const LABELS: Record<string, { fps: number; pingMs: number; shop?: boolean }> = {
	"js-mtn2jrku-8ae9-2352": { fps: 86, pingMs: 26 },
	"js-mtn2jrku-8ae9-2430": { fps: 106, pingMs: 25 },
	"js-mtn2jrku-8ae9-3199": { fps: 116, pingMs: 26 },
	"js-mtn2jrku-8ae9-4034": { fps: 51, pingMs: 25 },
	"js-mtn2jrku-8ae9-4956": { fps: 90, pingMs: 26 },
	"js-mtn2jrku-8ae9-6253": { fps: 76, pingMs: 26 },
	"js-mtn2jrku-8ae9-6758": { fps: 94, pingMs: 25 },
	"js-mtn2jrku-8ae9-7686": { fps: 113, pingMs: 27 },
	"js-mtn2jrku-8ae9-8136": { fps: 111, pingMs: 26 },
	"js-mtn2jrku-8ae9-13260": { fps: 60, pingMs: 26, shop: true },
	"js-mtn2jrku-8ae9-15267": { fps: 69, pingMs: 26 },
	"js-mtn2jrku-8ae9-15963": { fps: 81, pingMs: 27 },
	"js-mtn2jrku-8ae9-18500": { fps: 48, pingMs: 26 }
}

/* ------------------------------------------------------------ pure parts */

export interface Frame {
	id: string
	path: string
	/** Game clock in seconds, stamped by the daemon from the live client. The clock's ground truth. */
	tSec: number
	/** The exact block the coach was holding when this frame was taken, or null. */
	truth: string | null
	bytes: number
}

/** Digits, or the words a speech transcript uses for them. The answers arrive as spoken audio. */
const WORDS: Record<string, number> = {
	zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
	nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
	sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
	fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
}

/**
 * Seconds off a spoken or written clock, or null.
 *
 * Written wide on purpose. This is a native-audio model, so its words arrive through
 * `outputAudioTranscription` and the same reading comes back as "13:33", "1333", "13 33" or
 * "thirteen thirty three" depending on how it chose to say it. A parser that only accepted one of
 * those would score a correct read as a miss, and the whole point of the probe is the rate.
 */
export const parseClockSeconds = (raw: string): number | null => {
	const t = raw.toLowerCase()
	const colon = /(\d{1,2})\s*:\s*(\d{2})/.exec(t)
	if (colon) return Number(colon[1]) * 60 + Number(colon[2])
	const run = /\b(\d{3,4})\b/.exec(t)
	if (run) {
		const d = run[1]!
		return Number(d.slice(0, d.length - 2)) * 60 + Number(d.slice(-2))
	}
	const spaced = /\b(\d{1,2})\s+(\d{2})\b/.exec(t)
	if (spaced) return Number(spaced[1]) * 60 + Number(spaced[2])
	// "thirteen thirty three", "six forty three", "four oh two"
	const tokens = t.split(/[^a-z]+/).filter(w => w in WORDS).map(w => WORDS[w]!)
	if (tokens.length >= 2) {
		const [min, ...rest] = tokens
		const sec = rest.length >= 2 && rest[0]! % 10 === 0 ? rest[0]! + rest[1]! : rest[0]!
		if (min !== undefined && sec !== undefined && sec < 60) return min * 60 + sec
	}
	return null
}

/** The first integer in a reply, spoken or written. Used for the FPS counter. */
export const parseFirstInt = (raw: string): number | null => {
	const t = raw.toLowerCase()
	const digits = /\b(\d{1,4})\b/.exec(t)
	if (digits) return Number(digits[1])
	const tokens = t.split(/[^a-z]+/).filter(w => w in WORDS).map(w => WORDS[w]!)
	if (tokens.length === 0) return null
	if (tokens.length >= 2 && tokens[0]! >= 20 && tokens[0]! % 10 === 0 && tokens[1]! < 10)
		return tokens[0]! + tokens[1]!
	return tokens[0]!
}

/** Drop the block's own `Clock m:ss.` line, so the only clock left in the turn is in the picture. */
export const stripClockLine = (block: string): string =>
	block.replace(/^Clock .*$/m, "").replace(/\n{3,}/, "\n\n")

/**
 * Replace the block's clock with a false one, seven minutes ahead.
 *
 * Seven minutes rather than seven seconds because the two readings have to be distinguishable
 * through a speech transcript and through a sloppy answer. A model that says "about 13 minutes"
 * has still told you which of the two it read.
 */
export const falsifyClock = (block: string, tSec: number): { block: string; falseSec: number } => {
	const falseSec = Math.round(tSec) + 420
	const mm = Math.floor(falseSec / 60)
	const ss = String(falseSec % 60).padStart(2, "0")
	return { block: block.replace(/^Clock .*$/m, `Clock ${mm}:${ss}.`), falseSec }
}

/**
 * Replace the block's ranked fact list with the "nothing is missing" wording the renderer emits
 * when there is genuinely nothing to say.
 *
 * This is the only condition under which the shipped prompt permits a line to come from the
 * picture: it says PASS is the answer when nothing is missing, with "exactly two exceptions" —
 * an enemy visibly channelling an objective, or him visibly walking into a collapse. So this is
 * how you find out whether that escape hatch has ever been reachable, using frames that are
 * pictures of a five-man fight.
 */
export const emptyUnseen = (block: string): string =>
	block.replace(
		/### What he is NOT looking at[\s\S]*?(?=\*\*The ten champions)/,
		`### Nothing he is missing right now

There is no fact worth interrupting him for at this instant. Unless the video shows something
plain and urgent, the correct answer is PASS.

`
	)

/** mm:ss, the way the game's own HUD writes it. */
export const clockText = (sec: number): string =>
	`${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`

/* ------------------------------------------------------------ the socket */

export interface TurnResult {
	text: string
	ms: number
	/** Gemini's own per-modality accounting for the prompt. The proof that an image was ingested. */
	imageTokens: number
	textTokens: number
	totalTokens: number
}

interface TurnSpec {
	frameB64?: string
	text: string
}

/**
 * One socket, one or more turns, exactly the shape `geminiLive.ts` sends.
 *
 * A fresh socket per question rather than one long session: the model can see everything it has
 * already been told, so asking about ten frames down one socket would let turn ten answer from
 * turn nine's picture. That is a real effect and it would flatter the score.
 *
 * The frame rides INSIDE the turn as `inlineData`, which is what the app does and what
 * `geminiLive.ts` has a measurement block explaining — streaming it through `realtimeInput.video`
 * measurably does not reach the answer. A probe that used the other shape would be testing a path
 * nothing runs.
 */
const runTurns = async (systemPrompt: string, turns: TurnSpec[]): Promise<TurnResult[]> => {
	const key = geminiKey()
	if (key === "") throw new Error("no Gemini key — set one in the app or GEMINI_API_KEY")
	const mint = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
		method: "POST",
		headers: { "x-goog-api-key": key, "content-type": "application/json" },
		body: JSON.stringify({ uses: 1 })
	})
	const token = ((await mint.json()) as { name?: string }).name
	if (!token) throw new Error("could not mint a token")

	return await new Promise<TurnResult[]>((resolve, reject) => {
		const ws = new WebSocket(`${GEMINI_LIVE_WS}?access_token=${encodeURIComponent(token)}`)
		const out: TurnResult[] = []
		const queue = [...turns]
		let partial = ""
		let sentAt = 0
		let usage: {
			promptTokensDetails?: { modality?: string; tokenCount?: number }[]
			totalTokenCount?: number
		} | null = null

		const next = () => {
			const spec = queue.shift()
			if (spec === undefined) {
				ws.close()
				resolve(out)
				return
			}
			const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = []
			if (spec.frameB64 !== undefined)
				parts.push({ inlineData: { mimeType: "image/jpeg", data: spec.frameB64 } })
			parts.push({ text: spec.text })
			sentAt = Date.now()
			ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts }], turnComplete: true } }))
		}

		ws.onopen = () =>
			ws.send(
				JSON.stringify({
					setup: {
						model: GEMINI_LIVE_MODEL,
						generationConfig: { responseModalities: ["AUDIO"] },
						outputAudioTranscription: {},
						systemInstruction: { parts: [{ text: systemPrompt }] }
					}
				})
			)

		ws.onmessage = async ev => {
			const m = JSON.parse(
				typeof ev.data === "string" ? ev.data : await (ev.data as Blob).text()
			) as {
				setupComplete?: unknown
				usageMetadata?: typeof usage
				serverContent?: {
					turnComplete?: boolean
					outputTranscription?: { text?: string }
					modelTurn?: { parts?: { text?: string }[] }
				}
			}
			if (m.usageMetadata) usage = m.usageMetadata
			if (m.setupComplete) {
				next()
				return
			}
			const sc = m.serverContent
			if (!sc) return
			if (sc.outputTranscription?.text) partial += sc.outputTranscription.text
			for (const p of sc.modelTurn?.parts ?? []) if (p.text) partial += p.text
			if (sc.turnComplete) {
				const detail = (mod: string) =>
					usage?.promptTokensDetails?.find(d => d.modality === mod)?.tokenCount ?? 0
				out.push({
					text: partial.trim(),
					ms: Date.now() - sentAt,
					imageTokens: detail("IMAGE"),
					textTokens: detail("TEXT"),
					totalTokens: usage?.totalTokenCount ?? 0
				})
				partial = ""
				next()
			}
		}
		ws.onerror = () => reject(new Error("socket error"))
		ws.onclose = e => {
			if (e.code !== 1000 && out.length === 0)
				reject(new Error(`closed ${e.code}: ${String(e.reason).slice(0, 160)}`))
			else resolve(out)
		}
		setTimeout(() => {
			ws.close()
			resolve(out)
		}, 90_000)
	})
}

/* ------------------------------------------------------------ the frames */

/** JPEG dimensions, straight out of the SOF marker. No decoder, and none needed. */
export const jpegSize = (buf: Buffer): { w: number; h: number } | null => {
	let i = 2
	while (i + 9 < buf.length) {
		if (buf[i] !== 0xff) {
			i++
			continue
		}
		const marker = buf[i + 1]!
		if (marker >= 0xc0 && marker <= 0xc3)
			return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
		if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
			i += 2
			continue
		}
		i += 2 + buf.readUInt16BE(i + 2)
	}
	return null
}

/**
 * Frames to probe, newest-session-first and spread across the game clock.
 *
 * Spread rather than consecutive because a run of frames from one minute would all show the same
 * corner of the map, and a model that guessed "about 6 minutes" would score well on all of them.
 */
const pickFrames = (n: number, onlyLabelled: boolean): Frame[] => {
	const db = new DatabaseSync(DB_PATH, { readOnly: true })
	/*
	 * `tSec > 60` because the first frames of a session are the loading screen and the first
	 * seconds of the game, where the HUD clock does not exist yet. Asked to read a clock off one of
	 * those the model answered NOTHING VISIBLE, which is the correct answer and would still have
	 * scored as a miss — a frame with no clock in it cannot measure whether a clock can be read.
	 */
	const rows = db
		.prepare(
			"SELECT id, path, tSec, truthJson, bytes FROM journal_frame WHERE clock = 'live' AND tSec > 60 ORDER BY tSec"
		)
		.all() as unknown as {
		id: string
		path: string
		tSec: number
		truthJson: string | null
		bytes: number
	}[]
	db.close()
	const usable = rows
		.filter(r => existsSync(r.path))
		.filter(r => !onlyLabelled || r.id in LABELS)
		.map(r => ({ id: r.id, path: r.path, tSec: r.tSec, truth: r.truthJson, bytes: r.bytes }))
	if (usable.length <= n) return usable
	const step = usable.length / n
	return Array.from({ length: n }, (_, i) => usable[Math.floor(i * step)]!)
}

/* ------------------------------------------------------------ the probes */

const READER_PROMPT =
	"You are looking at a screenshot of a League of Legends game. Answer exactly what is asked, " +
	"as digits, and nothing else. If you cannot see the thing being asked about, say NOTHING VISIBLE."

const CLOCK_Q =
	"What does the game clock in the top right corner of the screenshot say? Answer with only the " +
	"digits, like 1333 for 13:33."

const FPS_Q =
	"What number is next to FPS in the top right corner of the screenshot? Answer with only that number."

interface Scored {
	check: string
	frame: string
	expected: number | null
	got: number | null
	ok: boolean
	text: string
	ms: number
	imageTokens: number
	totalTokens: number
	/**
	 * Did the socket come back with words at all?
	 *
	 * Kept separate from `ok` because a turn that produced NOTHING is not a model that could not
	 * read the picture — it is a probe that did not get an answer, and scoring the two the same way
	 * turns an infrastructure hiccup into a finding. That is not hypothetical: on a 60-frame scene
	 * run, `js-mtn2jrku-8ae9-13091` came back empty and was printed as NOT THE GAME. Opened by hand
	 * it is unmistakably the game — a five-man river fight at 21:48 with the shop tooltip up. One
	 * empty socket had inflated the "his desktop got uploaded" rate by 50%.
	 */
	answered: boolean
	/** Set when the turn threw rather than answered, so one dead socket cannot end a long run. */
	error?: string
	/** Set on the conflict check when the answer matched the FALSE clock in the block. */
	followedBlock?: boolean
}

/**
 * Run one scored probe, and turn a thrown socket into a row rather than the end of the run.
 *
 * `pool` runs these under `Promise.all`, so before this a single transient socket error discarded
 * every result already measured and wrote no `--out` file. The rows it produces are marked
 * `answered: false`, which keeps them out of the rates instead of counting as model failures.
 */
const guard = async (check: string, frame: string, fn: () => Promise<Scored>): Promise<Scored> => {
	try {
		return await fn()
	} catch (e) {
		return {
			check,
			frame,
			expected: null,
			got: null,
			ok: false,
			answered: false,
			error: String(e),
			text: "",
			ms: 0,
			imageTokens: 0,
			totalTokens: 0
		}
	}
}

/** How many of the rows that actually came back were right. Unanswered rows are not evidence. */
export const rateOf = (rows: { ok: boolean; answered: boolean }[]): string => {
	const live = rows.filter(r => r.answered)
	const missing = rows.length - live.length
	return `${live.filter(r => r.ok).length}/${live.length}${missing > 0 ? ` (${missing} no answer)` : ""}`
}

/**
 * How often the model must read the clock off the picture before the probe is happy.
 *
 * Measured twice on the real socket with real stored frames: 6 of 6 exact on one run, 22 of 23 on a
 * larger one. Eight tenths is deliberately BELOW both — a threshold set at the measurement is a
 * threshold that fails on one unlucky frame, and a probe that cries wolf is a probe somebody adds
 * `|| true` to. What this has to catch is the regression that motivated the whole vision pre-pass:
 * the day the model, or the frame pipeline, stops seeing the picture at all. That looks like zero,
 * not like four out of five.
 */
export const MIN_SIGHT_RATE = 0.8

/**
 * How often the SAME question with NO picture attached may be answered correctly.
 *
 * The control arm, and the reason a bare rate alone cannot be trusted. Measured: with no image the
 * model was right 0 times in 6 and invented a plausible number 6 times in 6. So a blind arm that
 * starts scoring well is not good news about the model — it means the clock is reaching the model
 * through some channel other than the pixels (the block leaking back in, a frame id in the prompt,
 * a cached turn), and every "the model can see" number in this repo would be measuring that leak
 * instead. One in five is noise on a two-digit guess; more than that is a broken instrument.
 *
 * This is the check nobody would have thought to fail on, which is exactly why it is here.
 */
export const MAX_BLIND_RATE = 0.2

/**
 * How many answered rows an arm needs before its rate means anything.
 *
 * `rateOf` of an arm where nothing came back is `0/0`, and `0/0` compared against a threshold is
 * whatever the arithmetic happens to do — which is how a run whose socket was dead the entire time
 * exits green. Four is the smallest n at which a single miss does not cross the sight threshold on
 * its own, and it is far below the probe's default of eight frames.
 */
export const MIN_ANSWERED = 4

/**
 * PASS, FAIL, or "this run proved nothing" — and the third is not the second.
 *
 * Kept pure and exported so the thresholds are pinned by `src/review/probe-vision.test.ts` rather
 * than by running the probe, which costs API calls and needs a database of frames. The verdict this
 * returns is the process exit code's only input.
 *
 * An arm that was not requested (`--check bare`) contributes NOTHING: no rows means not run, which
 * is skipped rather than failed. An arm that WAS run and came back empty is `inconclusive`, because
 * a dead socket is an infrastructure fact and reporting it as a coaching regression is how a probe
 * gets ignored — the failure mode this whole file exists to avoid, applied to itself.
 */
export interface ProbeVerdict {
	verdict: "pass" | "fail" | "inconclusive"
	/** 0 pass, 1 a real regression, 2 nothing was measured. Straight to `process.exitCode`. */
	code: 0 | 1 | 2
	reasons: string[]
}

export const probeVerdict = (rows: { check: string; ok: boolean; answered: boolean }[]): ProbeVerdict => {
	const arm = (check: string) => rows.filter(r => r.check === check)
	const reasons: string[] = []
	let fail = false
	let inconclusive = false

	const sight = arm("bare")
	if (sight.length === 0) reasons.push("bare: not run")
	else {
		const live = sight.filter(r => r.answered)
		if (live.length < MIN_ANSWERED) {
			inconclusive = true
			reasons.push(`bare: only ${live.length} of ${sight.length} turns answered, need ${MIN_ANSWERED}`)
		} else {
			const rate = live.filter(r => r.ok).length / live.length
			if (rate < MIN_SIGHT_RATE) {
				fail = true
				reasons.push(
					`bare: read the clock off the picture ${live.filter(r => r.ok).length}/${live.length} ` +
						`(${(rate * 100).toFixed(0)}%), below ${(MIN_SIGHT_RATE * 100).toFixed(0)}%`
				)
			} else reasons.push(`bare: ${live.filter(r => r.ok).length}/${live.length} ok`)
		}
	}

	const blind = arm("blind")
	if (blind.length === 0) reasons.push("blind: not run")
	else {
		const live = blind.filter(r => r.answered)
		if (live.length < MIN_ANSWERED) {
			inconclusive = true
			reasons.push(`blind: only ${live.length} of ${blind.length} turns answered, need ${MIN_ANSWERED}`)
		} else {
			const rate = live.filter(r => r.ok).length / live.length
			if (rate > MAX_BLIND_RATE) {
				fail = true
				reasons.push(
					`blind: answered correctly with NO picture ${live.filter(r => r.ok).length}/${live.length} ` +
						`(${(rate * 100).toFixed(0)}%) — the clock is reaching the model without the pixels`
				)
			} else reasons.push(`blind: ${live.filter(r => r.ok).length}/${live.length} correct with no picture`)
		}
	}

	// A real regression outranks a thin run: if the arm that DID answer answered badly, that is a
	// finding, and burying it behind "some other arm was quiet" is how the loud thing goes quiet.
	if (fail) return { verdict: "fail", code: 1, reasons }
	if (inconclusive) return { verdict: "inconclusive", code: 2, reasons }
	return { verdict: "pass", code: 0, reasons }
}

/**
 * YES / NO / neither, for the scene classifier.
 *
 * `unknown` exists because the alternative — treating "not the word yes" as NO — is what reported a
 * real game frame as the player's desktop.
 */
export const sceneVerdict = (raw: string): "yes" | "no" | "unknown" => {
	if (/\byes\b/i.test(raw)) return "yes"
	if (/\bno\b/i.test(raw)) return "no"
	return "unknown"
}

const clockProbe = async (
	check: string,
	f: Frame,
	b64: string | undefined,
	block: string | null,
	falseSec: number | null
): Promise<Scored> => {
	const text = block === null ? CLOCK_Q : `${block}\n\n${CLOCK_Q}`
	const [r] = await runTurns(READER_PROMPT, [{ frameB64: b64, text }])
	const got = r ? parseClockSeconds(r.text) : null
	const expected = Math.floor(f.tSec)
	return {
		check,
		frame: f.id,
		expected,
		got,
		// The HUD ticks in whole seconds and the daemon's read is a moment either side of the grab.
		ok: got !== null && Math.abs(got - expected) <= 3,
		answered: (r?.text ?? "") !== "",
		text: r?.text ?? "",
		ms: r?.ms ?? 0,
		imageTokens: r?.imageTokens ?? 0,
		totalTokens: r?.totalTokens ?? 0,
		followedBlock: falseSec === null ? undefined : got !== null && Math.abs(got - falseSec) <= 3
	}
}

/**
 * The shipped configuration, end to end.
 *
 * Turn one is byte-for-byte the turn `geminiLive.ts` sends every heartbeat: the real system
 * prompt, the frame inline, the real block. Turn two is the app's `ask()` path — a typed question
 * down the same socket. So this measures the thing that actually ships, including whatever the
 * 12,000 characters of coaching instructions do to the model's willingness to read a picture.
 */
const shippedProbe = async (f: Frame, b64: string): Promise<Scored[]> => {
	const block = f.truth ?? ""
	const results = await runTurns(LIVE_COACH_SYSTEM_PROMPT, [
		{ frameB64: b64, text: block },
		{ text: `${CLOCK_Q} Answer even if it is not worth coaching about.` },
		{ text: `${FPS_Q} Answer even if it is not worth coaching about.` }
	])
	const [heartbeat, clockAnswer, fpsAnswer] = results
	const expected = Math.floor(f.tSec)
	const got = clockAnswer ? parseClockSeconds(clockAnswer.text) : null
	const fps = fpsAnswer ? parseFirstInt(fpsAnswer.text) : null
	const label = LABELS[f.id]
	return [
		{
			check: "shipped-heartbeat",
			frame: f.id,
			expected: null,
			got: null,
			ok: true,
			answered: (heartbeat?.text ?? "") !== "",
			text: heartbeat?.text ?? "",
			ms: heartbeat?.ms ?? 0,
			imageTokens: heartbeat?.imageTokens ?? 0,
			totalTokens: heartbeat?.totalTokens ?? 0
		},
		{
			check: "shipped-clock",
			frame: f.id,
			expected,
			got,
			ok: got !== null && Math.abs(got - expected) <= 3,
			answered: (clockAnswer?.text ?? "") !== "",
			text: clockAnswer?.text ?? "",
			ms: clockAnswer?.ms ?? 0,
			imageTokens: clockAnswer?.imageTokens ?? 0,
			totalTokens: clockAnswer?.totalTokens ?? 0
		},
		{
			check: "shipped-fps",
			frame: f.id,
			expected: label?.fps ?? null,
			got: fps,
			ok: label !== undefined && fps === label.fps,
			answered: (fpsAnswer?.text ?? "") !== "",
			text: fpsAnswer?.text ?? "",
			ms: fpsAnswer?.ms ?? 0,
			imageTokens: fpsAnswer?.imageTokens ?? 0,
			totalTokens: fpsAnswer?.totalTokens ?? 0
		}
	]
}

/* ------------------------------------------------------------------ main */

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}
const has = (name: string): boolean => process.argv.includes(`--${name}`)

/** Run at most `width` promises at a time. Sockets are cheap; a hundred of them at once are not. */
const pool = async <T, R>(items: T[], width: number, fn: (t: T) => Promise<R>): Promise<R[]> => {
	const out: R[] = new Array(items.length)
	let cursor = 0
	const worker = async () => {
		for (;;) {
			const i = cursor++
			if (i >= items.length) return
			out[i] = await fn(items[i]!)
		}
	}
	await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker))
	return out
}

const rate = (rows: Scored[]): string => rateOf(rows)

const main = async () => {
	const n = Number(arg("n", "8"))
	const conc = Number(arg("conc", "3"))
	const checks = arg("check", "all")
	const want = (name: string) => checks === "all" || checks.split(",").includes(name)
	const frames = pickFrames(n, has("labelled"))
	if (frames.length === 0) {
		console.error(`no journal frames under ${DB_PATH} — run this against a data/ that has some`)
		process.exit(1)
	}

	console.log(`\n=== what is actually being sent ===\n`)
	for (const f of frames.slice(0, 3)) {
		const buf = readFileSync(f.path)
		const size = jpegSize(buf)
		console.log(
			`${f.id}  ${size ? `${size.w}x${size.h}` : "?"}  ${(buf.length / 1024).toFixed(0)}KB jpeg  ` +
				`${Math.ceil((buf.length * 4) / 3 / 1024)}KB base64  block ${f.truth?.length ?? 0} chars`
		)
	}

	const all: Scored[] = []
	const b64 = new Map(frames.map(f => [f.id, readFileSync(f.path).toString("base64")]))

	if (want("bare")) {
		const rows = await pool(frames, conc, f =>
			guard("bare", f.id, () => clockProbe("bare", f, b64.get(f.id), null, null))
		)
		all.push(...rows)
		console.log(`\nbare      clock read from the picture alone      ${rate(rows)}`)
		for (const r of rows)
			console.log(
				`  ${r.ok ? "ok  " : "MISS"} ${r.frame}  want ${clockText(r.expected ?? 0)}  got ${
					r.got === null ? "—" : clockText(r.got)
				}  "${r.text.slice(0, 40)}"  ${r.imageTokens} image tokens  ${r.ms}ms`
			)
	}

	if (want("blind")) {
		const rows = await pool(frames, conc, f =>
			guard("blind", f.id, () => clockProbe("blind", f, undefined, null, null))
		)
		all.push(...rows)
		const invented = rows.filter(r => r.answered && r.got !== null).length
		console.log(
			`\nblind     the same question with NO picture       ${rate(rows)} correct, ` +
				`${invented}/${rows.length} answered with a number at all`
		)
		for (const r of rows) console.log(`  ${r.frame}  "${r.text.slice(0, 60)}"  ${r.imageTokens} image tokens`)
	}

	if (want("stripped")) {
		const usable = frames.filter(f => f.truth !== null)
		const rows = await pool(usable, conc, f =>
			guard("stripped", f.id, () =>
				clockProbe("stripped", f, b64.get(f.id), stripClockLine(f.truth!), null)
			)
		)
		all.push(...rows)
		console.log(`\nstripped  block present, its clock line deleted  ${rate(rows)}`)
		for (const r of rows)
			console.log(
				`  ${r.ok ? "ok  " : "MISS"} ${r.frame}  want ${clockText(r.expected ?? 0)}  got ${
					r.got === null ? "—" : clockText(r.got)
				}  ${r.imageTokens} image tokens`
			)
	}

	if (want("conflict")) {
		const usable = frames.filter(f => f.truth !== null)
		const rows = await pool(usable, conc, f =>
			guard("conflict", f.id, () => {
				const { block, falseSec } = falsifyClock(f.truth!, f.tSec)
				return clockProbe("conflict", f, b64.get(f.id), block, falseSec)
			})
		)
		all.push(...rows)
		const followed = rows.filter(r => r.followedBlock).length
		console.log(
			`\nconflict  block says a FALSE clock (+7:00)          picture ${rate(rows)}, ` +
				`block ${followed}/${rows.length}`
		)
		for (const r of rows)
			console.log(
				`  ${r.ok ? "picture" : r.followedBlock ? "BLOCK  " : "neither"} ${r.frame}  ` +
					`picture ${clockText(r.expected ?? 0)}  got ${r.got === null ? "—" : clockText(r.got)}`
			)
	}

	if (want("fps")) {
		const labelled = frames.filter(f => f.id in LABELS)
		const rows = await pool(labelled, conc, f => guard("fps", f.id, async () => {
			const [r] = await runTurns(READER_PROMPT, [{ frameB64: b64.get(f.id), text: FPS_Q }])
			const got = r ? parseFirstInt(r.text) : null
			return {
				check: "fps",
				frame: f.id,
				expected: LABELS[f.id]!.fps,
				got,
				ok: got === LABELS[f.id]!.fps,
				answered: (r?.text ?? "") !== "",
				text: r?.text ?? "",
				ms: r?.ms ?? 0,
				imageTokens: r?.imageTokens ?? 0,
				totalTokens: r?.totalTokens ?? 0
			} satisfies Scored
		}))
		all.push(...rows)
		console.log(`\nfps       a number in NO feed, only the HUD      ${rate(rows)}`)
		for (const r of rows)
			console.log(`  ${r.ok ? "ok  " : "MISS"} ${r.frame}  want ${r.expected}  got ${r.got}  "${r.text.slice(0, 30)}"`)
	}

	if (want("drama")) {
		/*
		 * Can the picture EVER reach her mouth?
		 *
		 * The shipped prompt says PASS is the answer whenever the block has nothing missing, and
		 * names two exceptions that are both purely visual. This sends the real prompt and the real
		 * block with the fact list emptied, over frames that are pictures of five-man fights — the
		 * most urgent thing a screen can show. Whatever comes back is the honest ceiling on how much
		 * of this feature is vision at all.
		 */
		const usable = frames.filter(f => f.truth !== null)
		const rows = await pool(usable, conc, f => guard("drama", f.id, async () => {
			const [r] = await runTurns(LIVE_COACH_SYSTEM_PROMPT, [
				{ frameB64: b64.get(f.id), text: emptyUnseen(f.truth!) }
			])
			const passed = /^pass\b/i.test(r?.text.trim() ?? "")
			return {
				check: "drama",
				frame: f.id,
				expected: null,
				got: null,
				ok: !passed,
				answered: (r?.text ?? "") !== "",
				text: r?.text ?? "",
				ms: r?.ms ?? 0,
				imageTokens: r?.imageTokens ?? 0,
				totalTokens: r?.totalTokens ?? 0
			} satisfies Scored
		}))
		all.push(...rows)
		console.log(
			`\ndrama     block emptied, picture left to speak      ${rate(rows)} said anything at all`
		)
		for (const r of rows) console.log(`  ${r.frame}  "${r.text.slice(0, 100)}"`)
	}

	if (want("scene")) {
		/*
		 * Is the picture even of the game?
		 *
		 * He shares his whole MONITOR, not the League window, which is the right call for a share
		 * that has to outlive a game — and it means every alt-tab is uploaded to Google, filed in the
		 * journal as evidence, and handed to the coach with a ground-truth block saying the game is
		 * at 19:29. The first run of this probe found one by accident: `js-mtn2jrku-8ae9-11690`,
		 * stamped `clock = 'live'` at 19:29 of a real game, is a screenshot of his editor.
		 *
		 * Scored as a rate rather than described, because "sometimes" is not a number anyone can act
		 * on. The classifier is checked against thirteen frames verified by eye first; anything it
		 * calls NO is worth opening.
		 */
		const rows = await pool(frames, conc, f => guard("scene", f.id, async () => {
			const [r] = await runTurns(
				"You classify screenshots. Answer with one word.",
				[
					{
						frameB64: b64.get(f.id),
						text:
							"Is this screenshot the League of Legends game itself — the 3D game view with the " +
							"in-game HUD? Answer YES or NO."
					}
				]
			)
			const verdict = sceneVerdict(r?.text ?? "")
			return {
				check: "scene",
				frame: f.id,
				expected: null,
				got: null,
				ok: verdict === "yes",
				answered: verdict !== "unknown",
				text: r?.text ?? "",
				ms: r?.ms ?? 0,
				imageTokens: r?.imageTokens ?? 0,
				totalTokens: r?.totalTokens ?? 0
			} satisfies Scored
		}))
		all.push(...rows)
		const notGame = rows.filter(r => r.answered && !r.ok)
		const noAnswer = rows.filter(r => !r.answered)
		console.log(
			`\nscene     frames that are the GAME                 ${rate(rows)}` +
				`${notGame.length > 0 ? ` — ${notGame.length} are something else` : ""}`
		)
		for (const r of notGame) console.log(`  NOT THE GAME  ${r.frame}  "${r.text.slice(0, 40)}"`)
		for (const r of noAnswer)
			console.log(`  no answer     ${r.frame}  — not counted either way${r.error ? `  ${r.error}` : ""}`)
	}

	if (want("shipped")) {
		const usable = frames.filter(f => f.truth !== null)
		const rows = (
			await pool(usable, conc, async f => {
				try {
					return await shippedProbe(f, b64.get(f.id)!)
				} catch (e) {
					return [await guard("shipped-clock", f.id, () => Promise.reject(e))]
				}
			})
		).flat()
		all.push(...rows)
		const clock = rows.filter(r => r.check === "shipped-clock")
		const fps = rows.filter(r => r.check === "shipped-fps" && r.expected !== null)
		console.log(`\nshipped   real prompt + real block, then asked   clock ${rate(clock)}  fps ${rate(fps)}`)
		for (const r of rows.filter(r => r.check === "shipped-heartbeat"))
			console.log(`  heartbeat ${r.frame}: "${r.text.slice(0, 90)}"`)
		for (const r of clock)
			console.log(
				`  ${r.ok ? "ok  " : "MISS"} ${r.frame}  want ${clockText(r.expected ?? 0)}  got ${
					r.got === null ? "—" : clockText(r.got)
				}  "${r.text.slice(0, 40)}"`
			)
	}

	const out = arg("out", "")
	if (out !== "") {
		writeFileSync(out, JSON.stringify({ at: Date.now(), model: GEMINI_LIVE_MODEL, all }, null, 2))
		console.log(`\nwrote ${out}`)
	}

	/*
	 * THE EXIT CODE, which this probe did not have.
	 *
	 * It printed rates and exited 0 no matter what they said, had no pnpm script, and was therefore
	 * a thing nobody would ever have run in anger — the frame-reading number every comment in
	 * `analysis/live-facts.ts` and `review/frame-read.ts` rests on could have gone to zero and
	 * nothing would have made a sound. `pnpm probe:vision` now fails on a real regression (1) and
	 * says so separately from a run that measured nothing (2), because a dead socket reported as a
	 * regression is how a check gets an `|| true` and stops being a check.
	 */
	const verdict = probeVerdict(all)
	console.log(`\n=== ${verdict.verdict.toUpperCase()} ===`)
	for (const r of verdict.reasons) console.log(`  ${r}`)
	process.exitCode = verdict.code
}

if (import.meta.main) await main()
