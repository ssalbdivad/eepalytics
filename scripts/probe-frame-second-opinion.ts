/**
 * A SECOND OPINION on one question: does the live coach's model actually read the picture?
 *
 * ## Why a second script
 *
 * `scripts/probe-vision.ts` already answers a version of this, and it answers it with the game
 * clock — a number that is printed on the HUD *and* present in the ground-truth block, which is
 * what makes its conflict arm possible. That is a good design and it has one weakness: the clock
 * is the single easiest string on a League HUD to read, it is in a fixed corner, and it is the
 * one picture fact the model has also been told. A reader that scores 6/6 on the clock has not
 * yet been shown to read anything else.
 *
 * So this probe is deliberately built the other way round. Every question here is about something
 * the ground-truth block **structurally cannot contain**, verified by reading the renderer's
 * output rather than by assuming:
 *
 *   - **mana.** `renderState` prints `979/979 HP` and no mana, ever. A jungler at 81/564 mana is
 *     a jungler who cannot clear or gank, and the block is blind to it.
 *   - **the FPS counter.** Nothing in the Live Client Data API carries it. Nothing in the database
 *     carries it. It exists only as pixels.
 *   - **whether he is standing in his own fountain.** The block never says where anybody is —
 *     it says so out loud, twice. "In base" versus "on the map" is the cheapest possible position
 *     question and the block cannot answer it.
 *   - **whether the chat log is open on screen.** Pure client UI state.
 *
 * The ground truth for all four was read off the JPEGs BY HAND (see `TRUTH`), which is the honest
 * description of where it came from: there is no feed to check them against, which is exactly why
 * they are the right questions.
 *
 * ## The arms, and why each one is needed
 *
 *   picture   frame + the real re-rendered block, a neutral reader prompt.   can it read?
 *   shipped   the REAL system prompt and the REAL turn the app sends, then
 *             the questions as a second turn down the same socket.          does the shipped
 *                                                                          config still read?
 *   blind     the same questions and the same block with NO frame.          confabulation floor
 *
 * `blind` is what makes the other two mean anything. Four questions with 3, open, 3 and 2 answers
 * are guessable at roughly 1/3, ~0, 1/3 and 1/2, and a model that answers confidently from nothing
 * would post a non-zero score by luck alone. Measuring that floor is cheaper than arguing about it.
 *
 * ## And the reverse, which is the failure that actually shipped
 *
 * A model that reads pixels well is only half the requirement. The other half is that it does NOT
 * read pixels it cannot see. So the last two arms ask for the enemy jungler's champion and CS —
 * a fact that is in the block, is on NO frame in this set (the scoreboard is only drawn while Tab
 * is held), and that the coach has invented before. With the block it should be right; with only
 * the picture it should say NOT VISIBLE. An invention there is worse than a wrong mana bucket,
 * because it is the exact shape of the hallucination this whole app is built to prevent.
 *
 *   EEPALYTICS_DATA_DIR=/home/ssalb/eepalytics/data node --experimental-strip-types \
 *     scripts/probe-frame-second-opinion.ts --out /tmp/second-opinion.json
 */

import { readFileSync, writeFileSync } from "node:fs"
import { GEMINI_LIVE_MODEL, GEMINI_LIVE_WS, geminiKey } from "../src/review/gemini-live.ts"
import { LIVE_COACH_SYSTEM_PROMPT } from "../src/shared/live-prompt.ts"

/* ------------------------------------------------------------------ truth */

/**
 * Read off the nine JPEGs by hand, one at a time, by opening them.
 *
 * `manaBucket` is bucketed rather than exact because the answer has to survive being SPOKEN: the
 * live model is native-audio-out and the text comes back through `outputAudioTranscription`, so
 * "81 of 564" and "eighty one out of five hundred and sixty four" are the same answer and a
 * three-way bucket is scoreable without a speech-to-number argument. The thresholds are handed to
 * the model verbatim in the question, so the bucket boundary is never the thing being measured.
 *
 * `chat` is null for the 00:07 frame on purpose: at that point the bottom-left holds the client's
 * "Type /help for a list of commands" hint and no message history, and a question whose truth the
 * author has to argue for is not a question. Excluded rather than fudged.
 */
const TRUTH: Record<
	string,
	{
		mana: string
		manaBucket: "LOW" | "MID" | "HIGH"
		fps: number
		place: "BASE" | "MAP" | "DEAD"
		chat: boolean | null
		note: string
	}
> = {
	"cp-0007": { mana: "410/410", manaBucket: "HIGH", fps: 164, place: "BASE", chat: null, note: "fountain, five allies, LEVEL UP splash" },
	"cp-0103": { mana: "307/446", manaBucket: "MID", fps: 104, place: "MAP", chat: false, note: "alone on a camp, 128 damage number" },
	"cp-0163": { mana: "343/483", manaBucket: "MID", fps: 112, place: "MAP", chat: true, note: "FIRST BLOOD banner, chat log open" },
	"cp-0243": { mana: "523/523", manaBucket: "HIGH", fps: 106, place: "MAP", chat: true, note: "walking through the dark river, full HP" },
	"cp-0293": { mana: "204/523", manaBucket: "MID", fps: 110, place: "MAP", chat: false, note: "attacking a 1703/2665 camp" },
	"cp-0333": { mana: "81/564", manaBucket: "LOW", fps: 86, place: "MAP", chat: false, note: "ENEMY SLAIN banner, mana at 14%" },
	"cp-0368": { mana: "186/564", manaBucket: "MID", fps: 91, place: "MAP", chat: true, note: "Hextech drake banner, at the pit" },
	"cp-0378": { mana: "0/564", manaBucket: "LOW", fps: 90, place: "DEAD", chat: false, note: "grey screen, BACK IN 12, death recap open" },
	"cp-0403": { mana: "564/564", manaBucket: "HIGH", fps: 51, place: "BASE", chat: true, note: "respawned in the fountain, 34 gold" }
}

/* ------------------------------------------------------------- the socket */

interface TurnSpec {
	frameB64?: string
	text: string
}

interface TurnResult {
	text: string
	ms: number
	imageTokens: number
	totalTokens: number
}

/**
 * One socket per probe, exactly the message shape `geminiLive.ts` sends: the frame rides INSIDE
 * the turn as `inlineData`. A fresh socket per probe rather than one long session, because the
 * model can see everything it has already been told and frame nine would otherwise be answerable
 * from frame eight.
 */
const runTurns = async (systemPrompt: string, turns: TurnSpec[]): Promise<TurnResult[]> => {
	const key = geminiKey()
	if (key === "") throw new Error("no Gemini key")
	// MEASURED: minting hung indefinitely on the fourth socket of a run and took the whole probe
	// with it — `fetch` has no default timeout, so a stalled connection is a hang, not an error.
	// Three tries with a deadline turns that into a retry.
	let token: string | undefined
	for (let attempt = 0; attempt < 3 && token === undefined; attempt++) {
		try {
			const mint = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
				method: "POST",
				headers: { "x-goog-api-key": key, "content-type": "application/json" },
				body: JSON.stringify({ uses: 1 }),
				signal: AbortSignal.timeout(20_000)
			})
			token = ((await mint.json()) as { name?: string }).name
		} catch {
			token = undefined
		}
	}
	if (token === undefined) throw new Error("could not mint a token")

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
			ws.send(
				JSON.stringify({ clientContent: { turns: [{ role: "user", parts }], turnComplete: true } })
			)
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
			if (sc.outputTranscription?.text !== undefined) partial += sc.outputTranscription.text
			for (const p of sc.modelTurn?.parts ?? []) if (p.text !== undefined) partial += p.text
			if (sc.turnComplete) {
				out.push({
					text: partial.trim(),
					ms: Date.now() - sentAt,
					imageTokens:
						usage?.promptTokensDetails?.find(d => d.modality === "IMAGE")?.tokenCount ?? 0,
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
		}, 60_000)
	})
}

/* -------------------------------------------------------------- questions */

const READER_PROMPT =
	"You are reading one screenshot of a League of Legends game for an analyst. Answer the four " +
	"questions exactly in the format asked, with nothing else. If you cannot tell, answer UNKNOWN " +
	"for that line rather than guessing."

const QUESTIONS =
	"Answer these four questions about this instant, one per line, in this exact format and " +
	"nothing else.\n" +
	"1) MANA: LOW if the player's own mana is under a quarter of his maximum, MID if it is " +
	"between a quarter and three quarters, HIGH if it is over three quarters. Say LOW, MID or HIGH.\n" +
	"2) FPS: the number next to FPS in the top right corner, digits only.\n" +
	"3) PLACE: BASE if the player's champion is standing in his own base or fountain, DEAD if he " +
	"is dead and waiting to respawn, MAP if he is out on the map. Say BASE, DEAD or MAP.\n" +
	"4) CHAT: YES if a list of chat or system messages is drawn in the bottom left of the screen, " +
	"NO if that corner is empty. Say YES or NO."

const REVERSE_QUESTION =
	"Two questions, one per line, nothing else.\n" +
	"1) JUNGLER: which champion is the ENEMY jungler in this game? Answer NOT VISIBLE if you " +
	"cannot know.\n" +
	"2) JUNGLERCS: how many CS does the enemy jungler have right now? Digits only, or NOT VISIBLE " +
	"if you cannot know."

/* ---------------------------------------------------------------- parsing */

const WORDS: Record<string, number> = {
	zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
	ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
	seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
	sixty: 60, seventy: 70, eighty: 80, ninety: 90
}

/**
 * Spoken numbers, back to digits. The live model is native audio out, so a transcript reads
 * "eighty six" as often as "86" and a probe that only matched digits would score a correct answer
 * as a miss. Handles up to "nine hundred and ninety nine", which is every number this asks for.
 */
export const spokenNumber = (raw: string): number | null => {
	const digits = raw.match(/\d+/)
	if (digits !== null) return Number(digits[0])
	let total = 0
	let current = 0
	let saw = false
	for (const tok of raw.toLowerCase().replace(/[^a-z\s-]/g, " ").split(/[\s-]+/)) {
		if (tok === "hundred") {
			current = (current === 0 ? 1 : current) * 100
			saw = true
			continue
		}
		if (tok === "and" || tok === "") continue
		const v = WORDS[tok]
		if (v === undefined) continue
		current += v
		saw = true
	}
	total += current
	return saw ? total : null
}

/**
 * Answers come back POSITIONALLY, not labelled, and that is not a bug to work around.
 *
 * Measured on the first run: asked for `MANA: LOW` the live model spoke `LOW`, `86`, `MAP`, `NO`
 * — four bare lines, no labels, every one of them correct. A label-only parser scored that
 * perfect answer 0/4, which is exactly the shape of a measurement bug that reads as a model
 * failure. So the parser takes the Nth answer line as the Nth question and only falls back to
 * label matching when the model volunteers labels.
 */
export const answerLines = (text: string): string[] =>
	text
		.split(/\n+/)
		.map(l => l.replace(/^\s*\**\s*\d\s*[).:-]\s*/, "").trim())
		.filter(l => l !== "")

/** The Nth answer, preferring an explicit label when the model used one. */
export const slot = (text: string, index: number, label: string): string => {
	const labelled = new RegExp(`${label}\\s*[:\\-]\\s*([^\\n]+)`, "i").exec(text)
	if (labelled?.[1] !== undefined) return labelled[1].trim()
	return answerLines(text)[index] ?? ""
}

const pick = (raw: string, options: string[]): string => {
	const up = raw.toUpperCase()
	for (const o of options) if (up.includes(o)) return o
	return "UNKNOWN"
}

/* -------------------------------------------------------------------- run */

interface Trial {
	id: string
	arm: string
	question: string
	answer: string
	truth: string
	correct: boolean | null
}

const scoreFour = (id: string, arm: string, text: string): Trial[] => {
	const t = TRUTH[id]
	if (t === undefined) return []
	const manaSaid = pick(slot(text, 0, "MANA"), ["LOW", "MID", "HIGH", "UNKNOWN"])
	const fpsSaid = spokenNumber(slot(text, 1, "FPS"))
	const placeSaid = pick(slot(text, 2, "PLACE"), ["BASE", "DEAD", "MAP", "UNKNOWN"])
	const chatSaid = pick(slot(text, 3, "CHAT"), ["YES", "NO", "UNKNOWN"])
	const out: Trial[] = [
		{ id, arm, question: "mana", answer: manaSaid, truth: t.manaBucket, correct: manaSaid === t.manaBucket },
		{
			id,
			arm,
			question: "fps",
			answer: fpsSaid === null ? "UNKNOWN" : String(fpsSaid),
			truth: String(t.fps),
			// +-2 because the counter ticks between the frame being encoded and being looked at;
			// it is a live readout, not a stored field, and nothing here turns on the last digit.
			correct: fpsSaid !== null && Math.abs(fpsSaid - t.fps) <= 2
		},
		{ id, arm, question: "place", answer: placeSaid, truth: t.place, correct: placeSaid === t.place }
	]
	if (t.chat !== null)
		out.push({
			id,
			arm,
			question: "chat",
			answer: chatSaid,
			truth: t.chat ? "YES" : "NO",
			correct: chatSaid === (t.chat ? "YES" : "NO")
		})
	return out
}

const main = async () => {
	const args = process.argv.slice(2)
	const outPath = args[args.indexOf("--out") + 1] ?? "/tmp/second-opinion.json"
	const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null

	const fixture = JSON.parse(
		readFileSync("data/eval/fixture-5635467422.json", "utf8")
	) as {
		checkpoints: { id: string; clock: string; framePath: string | null; block: string }[]
	}

	const targets = fixture.checkpoints.filter(
		c => TRUTH[c.id] !== undefined && c.framePath !== null && (only === null || c.id === only)
	)

	const trials: Trial[] = []
	const raw: Record<string, Record<string, string>> = {}
	let imageTokens = 0

	for (const c of targets) {
		const b64 = readFileSync(c.framePath as string).toString("base64")
		raw[c.id] = {}
		// Enemy jungler, straight out of the block under test — never typed in here.
		const jm = c.block.match(/Enemy jungler right now:\s*(\w+),\s*(\d+) CS/)
		const jungler = jm?.[1] ?? "?"
		const junglerCs = jm?.[2] ?? "?"

		const runs: { arm: string; go: () => Promise<TurnResult[]> }[] = [
			{
				arm: "picture",
				go: () => runTurns(READER_PROMPT, [{ frameB64: b64, text: `${c.block}\n\n${QUESTIONS}` }])
			},
			{
				arm: "blind",
				go: () => runTurns(READER_PROMPT, [{ text: `${c.block}\n\n${QUESTIONS}` }])
			},
			{
				// The app's own shape: the real prompt, the real coaching turn, then the question
				// down the same socket — the `ask()` path, so the frame is in context exactly as
				// it is when he types into the chat box mid-game.
				arm: "shipped",
				go: () =>
					runTurns(LIVE_COACH_SYSTEM_PROMPT, [
						{ frameB64: b64, text: c.block },
						{ text: QUESTIONS }
					])
			},
			{
				arm: "reverse-frame-only",
				go: () => runTurns(READER_PROMPT, [{ frameB64: b64, text: REVERSE_QUESTION }])
			},
			{
				arm: "reverse-with-block",
				go: () =>
					runTurns(READER_PROMPT, [{ frameB64: b64, text: `${c.block}\n\n${REVERSE_QUESTION}` }])
			}
		]

		for (const r of runs) {
			let res: TurnResult[] = []
			try {
				res = await r.go()
			} catch (e) {
				console.error(`${c.id} ${r.arm}: ${String(e)}`)
			}
			const text = res.at(-1)?.text ?? ""
			imageTokens += res[0]?.imageTokens ?? 0
			raw[c.id]![r.arm] = text
			if (r.arm.startsWith("reverse")) {
				const said = slot(text, 0, "JUNGLER(?!CS)")
				const saidCs = slot(text, 1, "JUNGLERCS")
				const abstained = /NOT VISIBLE|UNKNOWN|CAN'?T|CANNOT/i.test(said + " " + saidCs)
				trials.push({
					id: c.id,
					arm: r.arm,
					question: "jungler-name",
					answer: said.slice(0, 60),
					truth: r.arm === "reverse-frame-only" ? "NOT VISIBLE" : jungler,
					correct:
						r.arm === "reverse-frame-only" ?
							abstained || !new RegExp(jungler, "i").test(said)
						:	new RegExp(jungler, "i").test(said)
				})
				trials.push({
					id: c.id,
					arm: r.arm,
					question: "jungler-cs",
					answer: saidCs.slice(0, 60),
					truth: r.arm === "reverse-frame-only" ? "NOT VISIBLE" : junglerCs,
					correct:
						r.arm === "reverse-frame-only" ?
							/NOT VISIBLE|UNKNOWN|CAN'?T|CANNOT/i.test(saidCs)
						:	spokenNumber(saidCs) === Number(junglerCs)
				})
				// Named-but-wrong is the interesting failure, so keep it visible in the log.
				console.log(
					`${c.id} ${r.arm.padEnd(20)} jungler="${said.slice(0, 40)}" cs="${saidCs.slice(0, 20)}"`
				)
				continue
			}
			const scored = scoreFour(c.id, r.arm, text)
			trials.push(...scored)
			console.log(
				`${c.id} ${r.arm.padEnd(20)} ${scored.map(s => `${s.question}=${s.answer}${s.correct === true ? "" : `(≠${s.truth})`}`).join(" ")}`
			)
		}
	}

	const rate = (arm: string, question?: string) => {
		const set = trials.filter(t => t.arm === arm && (question === undefined || t.question === question))
		const hit = set.filter(t => t.correct === true).length
		return { n: set.length, hit, pct: set.length === 0 ? 0 : Math.round((hit / set.length) * 100) }
	}

	const summary = {
		frames: targets.length,
		imageTokens,
		byArm: Object.fromEntries(
			["picture", "blind", "shipped", "reverse-frame-only", "reverse-with-block"].map(a => [
				a,
				rate(a)
			])
		),
		byQuestion: Object.fromEntries(
			["mana", "fps", "place", "chat"].map(q => [
				q,
				{ picture: rate("picture", q), blind: rate("blind", q), shipped: rate("shipped", q) }
			])
		)
	}
	console.log(JSON.stringify(summary, null, 2))
	writeFileSync(outPath, JSON.stringify({ summary, trials, raw, truth: TRUTH }, null, 2))
	console.log(`wrote ${outPath}`)
}

if (process.argv[1]?.endsWith("probe-frame-second-opinion.ts")) await main()
