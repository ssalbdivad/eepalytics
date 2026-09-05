/**
 * Did giving the picture somewhere to land actually change what the coach says?
 *
 * ## The finding this re-tests
 *
 * `scripts/probe-vision.ts` established two results that only make sense together: the model READS
 * the frame (the game clock, 6/6 exact, against 0/6 and a plausible invention 6/6 with no image),
 * and it IGNORES the frame when coaching (14 turns with the JPEG against 14 without, identical
 * blocks and the shipped prompt: the speak-or-PASS decision matched on 13 of 14 and the lines
 * paraphrased each other). The diagnosis was architectural — `buildFacts` ranks every candidate
 * line in TypeScript, the prompt lets the model speak only from that list, and not one ranked fact
 * was computed from pixels.
 *
 * `FactInput.frame` is the fix under test. This script measures whether it landed, in three arms,
 * on the real socket, with real stored frames and the blocks the coach was actually holding.
 *
 *   attach   the ORIGINAL experiment, replayed. Identical block, shipped prompt, arms differing
 *            only in whether the JPEG rides along. Answers: does the picture ITSELF matter yet?
 *   fire     the arms the shipped change actually creates. Same frame, same instant, same prompt,
 *            and the block differs by exactly what `buildFacts` does with a REAL minimap read of
 *            that frame — a rotation clause, or a withheld line. Answers: does the frame matter
 *            once it is ranked?
 *   read     the minimap reader alone over N frames, printing the coarse half it would hand
 *            `buildFacts` and the crop it read, so a human can check every one against the picture.
 *            Answers the only question that decides whether the feature is safe: is it TRUE?
 *
 * ## What the corpus can and cannot support, stated before any number
 *
 * The feature only ever fires on a turn that already carries an objective timer (which it rewrites
 * or withholds) or a window (which it withholds when he is in base). Counted over this data:
 *
 *   - `data/live-samples/split-03.ndjson` is the ONLY recorded `allgamedata` that overlaps stored
 *     frames, and the overlap is 42 samples covering tSec 7-403. Replayed through today's
 *     `buildFacts` that game offers 21 lines in 91 turns and the FIRST of them lands at 6:05 — so
 *     inside the frame-covered window the ranker offers one line, "they took Hextech drake", which
 *     carries no timer and no window. **On the only game where a frame and a client sample coexist,
 *     the shipped branch fires zero times.**
 *   - So `fire` uses the other join available: the block the coach was HOLDING, stored on the frame
 *     itself, filtered to blocks within 3s of their own frame's clock (`probe-minimap.ts` measured
 *     that most stored blocks are stale, one by nine minutes). Of 1,751 stored blocks, 252 are
 *     contemporaneous, 29 of those carry a fact list at all, 2 carry an objective timer and 6 carry
 *     a window.
 *
 * n=2 and n=6 are the whole population, not a sample of it, and no amount of re-running makes them
 * larger. Every rate below is quoted with its denominator for that reason.
 *
 * Run it:
 *
 *   EEPALYTICS_DATA_DIR=/home/ssalb/eepalytics/data node --experimental-strip-types \
 *     scripts/probe-frame-arms.ts --arm attach --n 20 --out data/eval/frame-arms-attach.json
 *     ... --arm fire  --out data/eval/frame-arms-fire.json
 *     ... --arm read  --n 24 --out data/eval/frame-arms-read.json
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DATA_DIR, DB_PATH } from "../src/shared/constants.ts"
import { buildFacts, newFactMemory } from "../src/analysis/live-facts.ts"
import type { FactInput, FrameObservation } from "../src/analysis/live-facts.ts"
import {
	FRAME_READ_QUESTION_XY,
	FRAME_READ_SYSTEM,
	asFrameRead,
	coarseOf,
	frameReadFaults,
	frameReadSchemaXY,
	minimapRect,
	parseFrameReadXY
} from "../src/review/frame-read.ts"
import type { Coarse, FrameRead, FrameTruth } from "../src/review/frame-read.ts"
import { GEMINI_LIVE_MODEL, GEMINI_LIVE_WS, geminiKey } from "../src/review/gemini-live.ts"
import { LIVE_COACH_SYSTEM_PROMPT } from "../src/shared/live-prompt.ts"
import { blockClockSec, truthFromBlock } from "./probe-minimap.ts"

/* ------------------------------------------------------------ the frames */

interface Frame {
	id: string
	path: string
	tSec: number
	/** The block the coach was holding at this instant, verbatim. */
	block: string
	truth: FrameTruth
	/** The ranked lines inside that block, already stripped of their bullets. */
	facts: string[]
}

/**
 * The `## Ground truth` block's own ranked list, back out of the rendered text.
 *
 * Parsed rather than rebuilt because the rebuild is not available: these frames pre-date the
 * recorded `allgamedata`, so there is no input from which today's `buildFacts` could re-derive
 * them. What is on disk is the list the coach was handed, which is the thing the arms need.
 */
const factsOf = (block: string): string[] => {
	const m = /### What he is NOT looking at — prefer these\n\n([\s\S]*?)\n\n\*\*/.exec(block)
	if (m === null) return []
	return m[1]!.split("\n").map(l => l.replace(/^- /, "").trim()).filter(l => l !== "")
}

/**
 * The stored block, brought forward to TODAY's renderer where the two differ.
 *
 * One paragraph changed with this work and it is exactly the paragraph an attach-or-not experiment
 * turns on: the block used to end "Use the screenshot for **where things are**" and now ends with a
 * measured refusal of that. Sending the arms the OLD sentence would measure the old design. Nothing
 * else in `renderState` moved, so this is the whole of the difference.
 */
const OLD_TAIL =
	"Use the screenshot for **where things are** — positions, who is grouped, what is happening on\nscreen. Use this block for **what is true**."

const NEW_TAIL = `**The video is context, not a source — and that includes positions.** Measured on this app's own
frames: asked where the champions were on the screenshot it sends you, the answer was a median 43%
of the map's width from the truth and matched its own previous answer about the same picture 5 times
in 60. That is not reading a minimap, it is imagining a game of League. Where anybody is has either
been worked out for you and put in the list above, hedged, or is not known at all. If a position is
not in the list, you do not know it, and there is nothing on screen you may fill the gap with.`

const modernise = (block: string): string => block.replace(OLD_TAIL, NEW_TAIL)

/** Replace the block's ranked list with a different one, leaving every other byte alone. */
export const withFacts = (block: string, facts: string[]): string => {
	const listed = `### What he is NOT looking at — prefer these\n\n${facts.map(f => `- ${f}`).join("\n")}`
	const empty = `### Nothing he is missing right now

There is no fact worth interrupting him for at this instant. Unless the video shows something
plain and urgent, the correct answer is PASS.`
	const hasList = /### What he is NOT looking at — prefer these\n\n[\s\S]*?\n\n\*\*/.test(block)
	const replacement = facts.length === 0 ? empty : listed
	if (hasList)
		return block.replace(/### What he is NOT looking at — prefer these\n\n[\s\S]*?(\n\n\*\*)/, `${replacement}$1`)
	return block.replace(empty, replacement)
}

const loadFrames = (): Frame[] => {
	const db = new DatabaseSync(DB_PATH, { readOnly: true })
	const rows = db
		.prepare(
			"SELECT id, sessionId, tSec, truthJson FROM journal_frame WHERE clock = 'live' AND truthJson IS NOT NULL ORDER BY sessionId, tSec"
		)
		.all() as unknown as { id: string; sessionId: string; tSec: number; truthJson: string }[]
	db.close()
	const out: Frame[] = []
	for (const r of rows) {
		const clock = blockClockSec(r.truthJson)
		// The same 3s freshness rule `probe-minimap.ts` uses, and for the same reason: a read of a
		// 22:36 picture scored against a 13:06 block reports the harness's staleness as fabrication.
		if (clock === null || Math.abs(r.tSec - clock) > 3) continue
		const path = `${DATA_DIR}/journal/${r.sessionId}/${r.id}.jpg`
		if (!existsSync(path)) continue
		const truth = truthFromBlock(r.truthJson)
		if (truth === null) continue
		out.push({ id: r.id, path, tSec: r.tSec, block: r.truthJson, truth, facts: factsOf(r.truthJson) })
	}
	return out
}

/** The frame ~5s before this one, which is what `observationFrom` compares a read against. */
const previousFrame = (all: Frame[], f: Frame): Frame | null => {
	const session = f.id.replace(/-\d+$/, "")
	const mine = all.filter(o => o.id.startsWith(session) && o.tSec < f.tSec && f.tSec - o.tSec <= 8)
	return mine.length === 0 ? null : mine[mine.length - 1]!
}

/* ------------------------------------------------------------ the images */

const WORK = mkdtempSync(join(tmpdir(), "frame-arms-"))

/** The minimap crop at 4x, the rendering `probe-minimap.ts` measured best. Same rectangle as ships. */
const cropPath = (frame: Frame): string => {
	const out = join(WORK, `${frame.id}-crop4x.jpg`)
	if (!existsSync(out)) {
		const r = minimapRect(1536, 864)
		execFileSync("ffmpeg", [
			"-y", "-loglevel", "error", "-i", frame.path,
			"-vf", `crop=${r.w}:${r.h}:${r.x}:${r.y},scale=${r.w * 4}:${r.h * 4}:flags=lanczos`,
			"-q:v", "3", out
		])
	}
	return out
}

/* ------------------------------------------------------------ the reader */

interface ReadRow {
	frame: string
	tSec: number
	read: FrameRead | null
	where: Coarse | null
	/** The half the read named before the client's fence was applied. Counterfactual only. */
	whereUnfenced?: Coarse | null
	faults: string[]
	rejected: string | null
	ms: number
	crop: string
	error?: string
}

const READER_MODEL = "gemini-3.1-flash-lite"

const readMinimap = async (key: string, frame: Frame): Promise<ReadRow> => {
	const crop = cropPath(frame)
	const body = {
		systemInstruction: { parts: [{ text: FRAME_READ_SYSTEM }] },
		contents: [
			{
				role: "user",
				parts: [
					{ inlineData: { mimeType: "image/jpeg", data: readFileSync(crop).toString("base64") } },
					{ text: FRAME_READ_QUESTION_XY }
				]
			}
		],
		generationConfig: {
			responseMimeType: "application/json",
			responseSchema: frameReadSchemaXY({
				enemyChampions: frame.truth.enemyChampions,
				myChampion: frame.truth.myChampion
			})
		}
	}
	const started = Date.now()
	try {
		const res = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${READER_MODEL}:generateContent?key=${key}`,
			{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
		)
		const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
		const text = j.candidates?.[0]?.content?.parts?.[0]?.text
		const parsed = parseFrameReadXY(text === undefined ? null : JSON.parse(text), {
			myChampion: frame.truth.myChampion,
			enemyChampions: frame.truth.enemyChampions
		})
		if (parsed.read === null)
			return {
				frame: frame.id, tSec: frame.tSec, read: null, where: null, faults: [],
				rejected: parsed.rejected, ms: Date.now() - started, crop
			}
		const read = asFrameRead(parsed.read)
		const faults = frameReadFaults(read, frame.truth)
		return {
			frame: frame.id,
			tSec: frame.tSec,
			read,
			// The client's fence first: a read it contradicts is thrown away WHOLE, never repaired.
			where: faults.length > 0 || read.you === null ? null : coarseOf(read.you),
			/*
			 * The same half with the fence BYPASSED, recorded only so the counterfactual arm can
			 * exist. It is never the shipped value and nothing but `--arm fire`'s third list reads
			 * it: with the fence refusing half of all reads, a probe that only measured the shipped
			 * path would have nothing to score for truthfulness at all.
			 */
			whereUnfenced: read.you === null ? null : coarseOf(read.you),
			faults: faults.map(f => `${f.code}(${f.detail})`),
			rejected: null,
			ms: Date.now() - started,
			crop
		}
	} catch (e) {
		return {
			frame: frame.id, tSec: frame.tSec, read: null, where: null, faults: [],
			rejected: "error", ms: Date.now() - started, crop, error: String(e)
		}
	}
}

/**
 * The daemon's own rule, copied here rather than imported because `observationFrom` lives inside
 * `routes/live.ts` behind module state a script cannot reach. It is four lines and it is pinned by
 * `src/server/routes/live.test.ts`; if the two ever disagree that test is the one that is right.
 */
const observationOf = (
	where: Coarse | null,
	previous: { where: Coarse | null; atSec: number } | null,
	atSec: number
): FrameObservation => ({
	where,
	atSec,
	confidence: previous !== null && atSec - previous.atSec <= 10 && previous.where !== where ? "low" : "medium"
})

/* ------------------------------------------------------------ the socket */

interface TurnResult {
	text: string
	ms: number
	imageTokens: number
}

/** One socket per turn, exactly the shape `geminiLive.ts` sends. See `probe-vision.ts` on why. */
const runTurn = async (systemPrompt: string, block: string, frameB64?: string): Promise<TurnResult> => {
	const key = geminiKey()
	if (key === "") throw new Error("no Gemini key")
	const mint = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
		method: "POST",
		headers: { "x-goog-api-key": key, "content-type": "application/json" },
		body: JSON.stringify({ uses: 1 })
	})
	const token = ((await mint.json()) as { name?: string }).name
	if (!token) throw new Error("could not mint a token")
	return await new Promise<TurnResult>((resolve, reject) => {
		const ws = new WebSocket(`${GEMINI_LIVE_WS}?access_token=${encodeURIComponent(token)}`)
		let partial = ""
		let sentAt = 0
		let usage: { promptTokensDetails?: { modality?: string; tokenCount?: number }[] } | null = null
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
			const m = JSON.parse(typeof ev.data === "string" ? ev.data : await (ev.data as Blob).text()) as {
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
				const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = []
				if (frameB64 !== undefined)
					parts.push({ inlineData: { mimeType: "image/jpeg", data: frameB64 } })
				parts.push({ text: block })
				sentAt = Date.now()
				ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts }], turnComplete: true } }))
				return
			}
			const sc = m.serverContent
			if (!sc) return
			if (sc.outputTranscription?.text) partial += sc.outputTranscription.text
			for (const p of sc.modelTurn?.parts ?? []) if (p.text) partial += p.text
			if (sc.turnComplete) {
				ws.close()
				resolve({
					text: partial.trim(),
					ms: Date.now() - sentAt,
					imageTokens:
						usage?.promptTokensDetails?.find(d => d.modality === "IMAGE")?.tokenCount ?? 0
				})
			}
		}
		ws.onerror = () => reject(new Error("socket error"))
		ws.onclose = e => {
			if (e.code !== 1000) reject(new Error(`closed ${e.code}: ${String(e.reason).slice(0, 120)}`))
		}
		setTimeout(() => {
			ws.close()
			resolve({ text: partial.trim(), ms: Date.now() - sentAt, imageTokens: 0 })
		}, 90_000)
	})
}

/**
 * One turn, retried through the Live API's rate limit.
 *
 * MEASURED the hard way: the first run of this probe went out at three sockets at a time and 59 of
 * 80 turns came back `closed 1011: You exceeded your current quota`. Those rows are indistinguishable
 * from a PASS at the call site — empty text, no image tokens — so a run that does not retry reports
 * a rate limit as a silent coach, which is exactly the confusion this whole line of work exists to
 * clear up. One socket at a time, and a refusal is retried rather than recorded.
 */
const runTurnPatiently = async (
	systemPrompt: string,
	block: string,
	frameB64: string | undefined,
	tries: number
): Promise<TurnResult> => {
	let last: unknown = null
	for (let i = 0; i < tries; i++) {
		try {
			return await runTurn(systemPrompt, block, frameB64)
		} catch (e) {
			last = e
			if (!/quota|1011|429/i.test(String(e))) throw e
			await new Promise(r => setTimeout(r, 4000 * (i + 1)))
		}
	}
	throw last
}

/** PASS is the prompt's own word for "nothing to say". Anything else is a spoken line. */
export const spoke = (text: string): boolean => text !== "" && !/^pass\b/i.test(text.trim())

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

/* ------------------------------------------------------------------ main */

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}

/**
 * The exact line `buildFacts` produces for this objective, at this second, from this half.
 *
 * Generated by CALLING it rather than by writing the sentence out here, because a harness that
 * retypes the string under test is measuring the harness. Everything else in the input is empty:
 * the only branch being exercised is `soon`, and a second candidate fact would change the ordering
 * as well as the wording.
 */
export const objectiveLine = (
	label: "Baron" | "Drake" | "Herald",
	sec: number,
	nowSec: number,
	frame?: FrameObservation
): string[] => {
	const input: FactInput = {
		nowSec,
		meDeadForSec: null,
		deadEnemies: [],
		currentGold: null,
		pace: null,
		counterpart: null,
		enemyObjectives: [],
		myEvents: [],
		alliesAlive: 5,
		enemiesAlive: 5,
		drakeBackInSec: label === "Drake" ? sec : null,
		baronBackInSec: label === "Baron" ? sec : null,
		heraldBackInSec: label === "Herald" ? sec : null,
		frame
	}
	return buildFacts(input, newFactMemory())
}

const main = async () => {
	const mode = arg("arm", "attach")
	const n = Number(arg("n", "20"))
	// One socket at a time by default. See `runTurnPatiently`: three at a time is over the quota.
	const conc = Number(arg("conc", "1"))
	const out = arg("out", "")
	const key = geminiKey()
	const all = loadFrames()
	console.log(`${all.length} frames whose stored block is within 3s of their own clock`)
	const rows: unknown[] = []

	if (mode === "read") {
		const withList = all.filter(f => f.facts.length > 0)
		const rest = all.filter(f => f.facts.length === 0)
		const step = rest.length / Math.max(1, n - withList.length)
		const pick = [
			...withList,
			...Array.from({ length: Math.max(0, n - withList.length) }, (_, i) => rest[Math.floor(i * step)]!)
		].filter(f => f !== undefined)
		const read = await pool(pick, 4, f => readMinimap(key, f))
		for (const r of read)
			console.log(
				`  ${r.frame}  ${Math.floor(r.tSec / 60)}:${String(Math.floor(r.tSec % 60)).padStart(2, "0")}  ` +
					`where=${r.where ?? "—"}  zone=${r.read?.you ?? "—"}  activity=${r.read?.activity ?? "—"}  ` +
					`faults=[${r.faults.join(" ")}]  ${r.ms}ms  ${r.crop}`
			)
		const placed = read.filter(r => r.where !== null).length
		console.log(`\nplaced him at all: ${placed}/${read.length}   fenced off: ${read.filter(r => r.faults.length > 0).length}`)
		rows.push(...read)
	}

	if (mode === "attach") {
		/*
		 * The original experiment, replayed against the changed code. Both arms get the SAME block,
		 * built by today's renderer, and differ only in whether the JPEG rides along.
		 *
		 * Stratified: every frame whose block carries a ranked list, then the rest spread evenly.
		 * An unstratified draw from this corpus is 92% empty lists, and two arms that both say PASS
		 * because there was nothing to say measure the corpus rather than the coach.
		 */
		const withList = all.filter(f => f.facts.length > 0)
		const rest = all.filter(f => f.facts.length === 0)
		const want = Math.max(0, n - withList.length)
		const step = rest.length / Math.max(1, want)
		const pick = [...withList, ...Array.from({ length: want }, (_, i) => rest[Math.floor(i * step)]!)].filter(
			f => f !== undefined
		)
		const jobs = pick.flatMap(f => [
			{ f, picture: true },
			{ f, picture: false }
		])
		const done = await pool(jobs, conc, async j => {
			const block = modernise(j.f.block)
			try {
				const r = await runTurnPatiently(
					LIVE_COACH_SYSTEM_PROMPT,
					block,
					j.picture ? readFileSync(j.f.path).toString("base64") : undefined,
					6
				)
				return { frame: j.f.id, tSec: j.f.tSec, picture: j.picture, facts: j.f.facts, ...r }
			} catch (e) {
				return {
					frame: j.f.id, tSec: j.f.tSec, picture: j.picture, facts: j.f.facts,
					text: "", ms: 0, imageTokens: 0, error: String(e)
				}
			}
		})
		rows.push(...done)
		for (const f of pick) {
			const withPic = done.find(d => d.frame === f.id && d.picture)!
			const without = done.find(d => d.frame === f.id && !d.picture)!
			const agree = spoke(withPic.text) === spoke(without.text)
			console.log(
				`\n${f.id}  ${Math.floor(f.tSec / 60)}:${String(Math.floor(f.tSec % 60)).padStart(2, "0")}  ` +
					`list=[${f.facts.join(" | ")}]  ${agree ? "same call" : "DIFFERENT"}`
			)
			console.log(`   picture (${withPic.imageTokens} img tok): ${withPic.text || "(nothing)"}`)
			console.log(`   text    (${without.imageTokens} img tok): ${without.text || "(nothing)"}`)
		}
		const arm = (picture: boolean) => done.filter(d => d.picture === picture && d.error === undefined)
		const said = (picture: boolean) => arm(picture).filter(d => spoke(d.text)).length
		const pairs = pick.filter(f =>
			done.every(d => d.frame !== f.id || d.error === undefined)
		)
		const differ = pairs.filter(f => {
			const a = done.find(d => d.frame === f.id && d.picture)!
			const b = done.find(d => d.frame === f.id && !d.picture)!
			return spoke(a.text) !== spoke(b.text)
		})
		console.log(
			`\nwith picture: ${said(true)} spoke, ${arm(true).length - said(true)} passed` +
				`\ntext only   : ${said(false)} spoke, ${arm(false).length - said(false)} passed` +
				`\ndecision differed on ${differ.length} of ${pairs.length} turns`
		)
	}

	if (mode === "fire") {
		/*
		 * The arms the shipped change actually creates.
		 *
		 * Every frame whose contemporaneous block carries a line the frame is allowed to touch — an
		 * objective timer, or a window it can withhold. The `where` is a REAL read of that REAL
		 * frame through the shipped reader, fenced against that frame's own block, and doubted
		 * against a real read of the frame five seconds earlier, exactly as the daemon would.
		 */
		const eligible = all.filter(f =>
			f.facts.some(l => /is back in \d+ seconds/.test(l) || /of them are dead/.test(l))
		)
		console.log(`${eligible.length} frames carry a line the frame is allowed to touch`)
		const jobs: {
			frame: Frame
			obs: FrameObservation
			prevWhere: Coarse | null
			read: ReadRow
			before: string[]
			after: string[]
			/** What would have been said had the client's fence not refused the read. */
			counterfactual: string[]
		}[] = []
		for (const f of eligible) {
			const prev = previousFrame(all, f)
			const prevRead = prev === null ? null : await readMinimap(key, prev)
			const read = await readMinimap(key, f)
			const obs = observationOf(
				read.where,
				prevRead === null ? null : { where: prevRead.where, atSec: prev!.tSec },
				f.tSec
			)
			/*
			 * Rebuild the list THROUGH `buildFacts` for both arms, so the difference between them is
			 * whatever the shipped function does and not whatever this script would have written.
			 * Only the timer line is regenerated; a window line is a gate, so the "after" list simply
			 * loses it when the read says base.
			 */
			const forced: FrameObservation = {
				where: read.whereUnfenced ?? null,
				atSec: f.tSec,
				confidence: "medium"
			}
			const before: string[] = []
			const after: string[] = []
			const counterfactual: string[] = []
			for (const line of f.facts) {
				const timer = /^(Baron|Drake|Herald) is back in (\d+) seconds$/.exec(line)
				if (timer !== null) {
					const label = timer[1] as "Baron" | "Drake" | "Herald"
					const sec = Number(timer[2])
					before.push(...objectiveLine(label, sec, f.tSec))
					after.push(...objectiveLine(label, sec, f.tSec, obs))
					counterfactual.push(...objectiveLine(label, sec, f.tSec, forced))
					continue
				}
				const window = /of them are dead/.test(line)
				before.push(line)
				// The base gate: a window is not his to take from the fountain.
				if (!(window && obs.where === "base" && obs.confidence === "medium")) after.push(line)
				if (!(window && forced.where === "base")) counterfactual.push(line)
			}
			jobs.push({ frame: f, obs, prevWhere: prevRead?.where ?? null, read, before, after, counterfactual })
		}
		for (const j of jobs) {
			const changed = JSON.stringify(j.before) !== JSON.stringify(j.after)
			console.log(
				`\n${j.frame.id}  ${Math.floor(j.frame.tSec / 60)}:${String(Math.floor(j.frame.tSec % 60)).padStart(2, "0")}  ` +
					`read=${j.read.where ?? "—"} unfenced=${j.read.whereUnfenced ?? "—"} (prev ${j.prevWhere ?? "—"}) conf=${j.obs.confidence} ` +
					`faults=[${j.read.faults.join(" ")}]  ${changed ? "LIST CHANGED" : "list unchanged"}`
			)
			console.log(`   blind    : [${j.before.join(" | ")}]`)
			console.log(`   shipped  : [${j.after.join(" | ")}]`)
			console.log(`   unfenced : [${j.counterfactual.join(" | ")}]`)
		}
		const spoken = await pool(
			jobs.flatMap(j => [
				{ j, fed: "blind", facts: j.before },
				{ j, fed: "shipped", facts: j.after },
				{ j, fed: "unfenced", facts: j.counterfactual }
			]),
			conc,
			async t => {
				const block = withFacts(modernise(t.j.frame.block), t.facts)
				try {
					const r = await runTurnPatiently(
						LIVE_COACH_SYSTEM_PROMPT,
						block,
						readFileSync(t.j.frame.path).toString("base64"),
						6
					)
					return { frame: t.j.frame.id, tSec: t.j.frame.tSec, fed: t.fed, facts: t.facts, ...r }
				} catch (e) {
					return {
						frame: t.j.frame.id, tSec: t.j.frame.tSec, fed: t.fed, facts: t.facts,
						text: "", ms: 0, imageTokens: 0, error: String(e)
					}
				}
			}
		)
		rows.push(
			...jobs.map(j => ({
				frame: j.frame.id, tSec: j.frame.tSec, where: j.read.where,
				whereUnfenced: j.read.whereUnfenced ?? null, confidence: j.obs.confidence,
				prevWhere: j.prevWhere, faults: j.read.faults, before: j.before, after: j.after,
				counterfactual: j.counterfactual, crop: j.read.crop, path: j.frame.path
			})),
			...spoken
		)
		for (const j of jobs) {
			console.log(`\n${j.frame.id}  ${j.frame.path}`)
			for (const label of ["blind", "shipped", "unfenced"]) {
				const r = spoken.find(s => s.frame === j.frame.id && s.fed === label)!
				console.log(`   ${label.padEnd(9)}: ${r.text || "(nothing)"}`)
			}
		}
		const said = (fed: string) => spoken.filter(s => s.fed === fed && spoke(s.text)).length
		const total = (fed: string) => spoken.filter(s => s.fed === fed && s.error === undefined).length
		for (const label of ["blind", "shipped", "unfenced"])
			console.log(`\n${label.padEnd(9)} list: ${said(label)} spoke of ${total(label)}`)
	}

	if (out !== "") {
		mkdirSync(dirname(out), { recursive: true })
		writeFileSync(out, JSON.stringify({ at: Date.now(), mode, model: GEMINI_LIVE_MODEL, reader: READER_MODEL, rows }, null, 2))
		console.log(`\nwrote ${out}`)
	}
}

if (import.meta.main) await main()
