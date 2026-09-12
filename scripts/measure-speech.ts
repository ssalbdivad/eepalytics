/**
 * Does the coach SAY it right? — the measurement that has never been run.
 *
 * ## Why a new instrument
 *
 * Everything else this repo measures about the live coach is measured on TEXT: `coach-score.ts`
 * reads the transcript, `blind-judge.ts` judges it, `bench-stream.ts` compares transcripts.
 * The player's complaint is about AUDIO — "52s" heard as "fifty two seds", champion names
 * "insanely wrong" — and a transcript cannot see that. `outputAudioTranscription` is Google's own
 * read-back of the audio and it NORMALISES: it writes "52 seconds" whether the voice said
 * "fifty-two seconds" or "five two ess". So the existing instruments are blind to the exact defect
 * they were asked to fix, and reading them was how "fixed" was claimed for a thing that was not.
 *
 * So this script keeps the AUDIO. It runs the real socket, saves the PCM the voice actually
 * produced, and sends that audio to a second model with one job: write down what you HEAR, in
 * syllables, and do not correct anything into a word you recognise. That second pass is the
 * measurement; the transcript is only context beside it.
 *
 * ## The two arms
 *
 * `plain`  — `LIVE_COACH_SYSTEM_PROMPT` exactly as it ships today.
 * `guide`  — the same prompt with `renderPronunciationGuide(...)` appended, which is the change
 *            being proposed. Both arms get byte-identical blocks, so a difference between them is
 *            the guide and nothing else.
 *
 * Two things are being decided, and they pull in opposite directions:
 *
 *   1. does the guide FIX the names (the point), and
 *   2. does the guide get READ ALOUD (the regression that made the last attempt worse than
 *      nothing — "BRY-er is still at 0 CS", to the player, repeatedly).
 *
 * A guide that fixes pronunciation and is occasionally spoken is a FAILURE, not a trade. Arm 2 is
 * therefore reported as a count of respellings appearing in a transcript, and any non-zero count
 * sinks the proposal.
 *
 * ## Usage
 *
 *   node --env-file-if-exists=.env --experimental-strip-types scripts/measure-speech.ts \
 *     [--turns 6] [--arms plain,guide] [--out data/eval/speech]
 *
 * Real socket, real billing. It is deliberately small: six turns an arm is enough to see a name
 * mangled, and this is a pronunciation check rather than a coaching benchmark.
 *
 * ## What it found, and the limits of what it can find
 *
 * - the shipped voice said **"one hundred thirty-four gold"** for a block reading `1334 gold`,
 *   while the transcript recorded "1334". Two separate listens of the same WAV agree.
 * - `models/gemini-3.1-flash-live-preview` returned NO AUDIO AT ALL on three consecutive runs
 *   after returning it happily on a fourth, with `responseModalities: ["AUDIO"]` unchanged. That
 *   is the shipped socket going silent, and it is why `--live-model` exists.
 * - the pronunciation guide was never once read aloud: zero respellings in six spoken turns.
 * - **the ear disagrees with itself at the word level.** The same recording came back as "fifty-two
 *   seds" and as "fifty-two seconds", and as "guldens" and "guilders", on two runs. Figures were
 *   stable across both. So: trust this script on NUMBERS, treat a single word-level reading as a
 *   lead rather than a result, and re-listen before believing one.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { LIVE_COACH_SYSTEM_PROMPT } from "../src/shared/live-prompt.ts"
import { renderState } from "../src/shared/live-state.ts"
import type { VisionState } from "../src/shared/live-state.ts"
import { parsePronunciations, renderPronunciationGuide } from "../src/shared/pronounce.ts"
import { sayCs, sayDuration, sayGold, sayMinutes, sayNumber } from "../src/shared/say-numbers.ts"
import { geminiKey, GEMINI_LIVE_MODEL } from "../src/review/gemini-live.ts"
import { numbersIn } from "../src/analysis/coach-score.ts"

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1]!
}

const OUT = arg("out", "data/eval/speech")
const TURNS = Number(arg("turns", "6"))
/**
 * Which question is being asked. They need different fixtures and different summaries, and one
 * script that answered both at once would answer neither clearly.
 *
 *   `names`   — does the pronunciation guide fix names, and does it leak into the transcript?
 *   `numbers` — does a figure written in DIGITS survive the trip to the speaker?
 */
const SUITE = arg("suite", "names")
const ARMS = arg("arms", SUITE === "numbers" ? "digits,spelled" : "plain,guide").split(",")
/**
 * The audio judge. Free text for the same reason every model id in this repo is — and this run
 * proved the point again: the first attempt used `gemini-2.5-flash` and every call came back "no
 * longer available to new users", after the socket had already been paid for.
 */
const EAR_MODEL = arg("ear", "gemini-3.6-flash")
/**
 * Re-run the EAR over WAVs already on disk, without touching the socket.
 *
 * The audio is the expensive, slow, once-only half and the transcriber is the cheap half whose
 * model name expires. Separating them means a dead judge costs a re-listen instead of a re-run,
 * and it means the same recording can be judged again by a better ear later — which is the only
 * way a stored measurement stays worth keeping.
 */
const RELISTEN = process.argv.includes("--relisten")
/**
 * The voice under test. Defaults to the shipped one.
 *
 * Overridable because the shipped socket went TEXT-ONLY mid-measurement: three consecutive runs of
 * `models/gemini-3.1-flash-live-preview` returned `modelTurn.parts[].text` and not one audio part,
 * after an earlier run of the same code had returned 200 kB of PCM a turn. A pronunciation script
 * that cannot get a voice must be able to name a different one rather than report silence as a
 * result.
 */
const LIVE_MODEL = arg("live-model", GEMINI_LIVE_MODEL)

/* ------------------------------------------------------------- the states */

/**
 * Blocks built by hand, not replayed from a game.
 *
 * A replayed block is the right fixture for coaching quality and the wrong one here: it says
 * whatever that game happened to contain, and this needs the specific SHAPES that were reported
 * broken. Every name below is on the shipped table, every figure is one the coach really emits,
 * and the `unseen` list is what the prompt permits it to speak — so a name only gets said if the
 * list puts it there.
 */
const base = (over: Partial<VisionState>): VisionState => ({
	clock: "14:32",
	me: { champion: "Lillia", level: 11, hp: 1420, maxHp: 1980, gold: 1334, k: 3, d: 2, a: 6, cs: 132 },
	pace: { cs: 132, expected: 141, exact: true, source: "your own average" },
	pronounce: [],
	counterpart: { champion: "Briar", level: 12 },
	allies: [
		{ champion: "Urgot", level: 11, k: 2, d: 3, a: 1 },
		{ champion: "Taliyah", level: 10, k: 1, d: 4, a: 5 },
		{ champion: "Smolder", level: 11, k: 4, d: 2, a: 3 },
		{ champion: "Braum", level: 9, k: 0, d: 3, a: 8 }
	],
	enemies: [
		{ champion: "Ornn", level: 11, k: 1, d: 2, a: 4 },
		{ champion: "Briar", level: 12, k: 5, d: 1, a: 2 },
		{ champion: "Lissandra", level: 11, k: 3, d: 3, a: 3 },
		{ champion: "Jhin", level: 11, k: 4, d: 2, a: 1 },
		{ champion: "Senna", level: 10, k: 0, d: 4, a: 6 }
	],
	recentEvents: [],
	unseen: [],
	...over
})

/**
 * One turn each, and each one FORCES a shape that was reported broken out loud.
 *
 * The list is the only thing the prompt lets the coach speak from, so putting exactly one item in
 * it makes the spoken sentence predictable enough to measure. Anything vaguer measures whether the
 * coach felt like mentioning a name today.
 */
const NAME_SUITE: { why: string; state: VisionState }[] = [
	{
		why: "a respawn timer — the '52s heard as fifty two seds' case",
		state: base({ unseen: ["Briar is down 52 seconds — their camps are free"] })
	},
	{
		why: "a gold figure — the '1334g heard as a letter' case",
		state: base({ unseen: ["1334 gold sitting unspent — spend it before the next fight"] })
	},
	{
		why: "the hardest names on the roster to say",
		state: base({
			counterpart: { champion: "Kha'Zix", level: 12 },
			enemies: [
				{ champion: "Kha'Zix", level: 12, k: 5, d: 1, a: 2 },
				{ champion: "Rek'Sai", level: 11, k: 1, d: 2, a: 4 },
				{ champion: "Lissandra", level: 11, k: 3, d: 3, a: 3 },
				{ champion: "Jhin", level: 11, k: 4, d: 2, a: 1 },
				{ champion: "Senna", level: 10, k: 0, d: 4, a: 6 }
			],
			unseen: ["Kha'Zix is 14 CS up on you — finish your clear before you look at a lane"]
		})
	},
	{
		why: "a name the coach mangled in the transcript he quit on",
		state: base({ unseen: ["Briar is 14 CS up on you — take your own camps first"] })
	},
	{
		why: "a two-word name, and a level",
		state: base({
			counterpart: { champion: "Nunu & Willump", level: 13 },
			enemies: [
				{ champion: "Nunu & Willump", level: 13, k: 5, d: 1, a: 2 },
				{ champion: "Ornn", level: 11, k: 1, d: 2, a: 4 },
				{ champion: "Lissandra", level: 11, k: 3, d: 3, a: 3 },
				{ champion: "Jhin", level: 11, k: 4, d: 2, a: 1 },
				{ champion: "Senna", level: 10, k: 0, d: 4, a: 6 }
			],
			unseen: ["you are 2 levels down on Nunu & Willump — do not take that fight, clear instead"]
		})
	},
	{
		why: "a window, with two figures in one sentence",
		state: base({
			unseen: ["3 of them are dead — you have about 24 seconds", "Lissandra is down 41 seconds"]
		})
	}
]

/**
 * The NUMBER suite, and the reason it exists.
 *
 * The first run of this script found the defect nobody was looking for. The block said `1334 gold`;
 * the voice said **"one hundred thirty-four gold"** — a digit dropped, out loud, from a figure that
 * was exactly right in the block. `outputAudioTranscription` wrote back "1334 gold", so every
 * instrument in this repo scored that turn as perfectly grounded while the player was being told a
 * number that was off by a factor of ten.
 *
 * That is a FABRICATION, it is invisible to text, and it is the thing `shared/say-numbers.ts`
 * makes impossible: a figure already written as words has no digits left to drop.
 *
 * So: the same eight facts, twice. `digits` writes them the way `buildFacts` writes them today;
 * `spelled` writes them through `say-numbers.ts`. Same prompt, same roster, same sentences —
 * the ONLY difference is the shape of the figure, which is what makes the comparison worth
 * anything. Four-digit gold is over-represented on purpose: that is where the failure was seen,
 * and a suite that sampled figures evenly would need three times the turns to see it again.
 */
const NUMBER_FACTS: { digits: string; spelled: string; want: number[] }[] = [
	{ digits: "1334 gold sitting unspent", spelled: `${sayGold(1334)} sitting unspent`, want: [1334] },
	{ digits: "1966 gold sitting unspent", spelled: `${sayGold(1966)} sitting unspent`, want: [1966] },
	{ digits: "2874 gold sitting unspent", spelled: `${sayGold(2874)} sitting unspent`, want: [2874] },
	{ digits: "1017 gold unspent for 4 minutes now", spelled: `${sayGold(1017)} unspent for ${sayMinutes(4)} now`, want: [1017, 4] },
	{ digits: "Briar is down 52 seconds — their camps are free", spelled: `Briar is down ${sayDuration(52)} — their camps are free`, want: [52] },
	{ digits: "Briar is down 41 seconds — their camps are free", spelled: `Briar is down ${sayDuration(41)} — their camps are free`, want: [41] },
	{ digits: "Briar is 23 CS up on you — finish your clear first", spelled: `Briar is ${sayCs(23)} up on you — finish your clear first`, want: [23] },
	{ digits: "3 of them are dead — you have about 24 seconds", spelled: `${sayNumber(3)} of them are dead — you have about ${sayDuration(24)}`, want: [3, 24] }
]

const numberSuite = (form: "digits" | "spelled"): { why: string; state: VisionState; want: number[] }[] =>
	NUMBER_FACTS.map(f => ({
		why: `${form}: ${f[form]}`,
		state: base({ unseen: [f[form]] }),
		want: f.want
	}))

/* --------------------------------------------------------------- the socket */

interface Turn {
	arm: string
	i: number
	why: string
	block: string
	transcript: string
	audio: Buffer
	ms: number
}

const mintToken = async (key: string): Promise<string> => {
	const r = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
		method: "POST",
		headers: { "x-goog-api-key": key, "content-type": "application/json" },
		body: JSON.stringify({ uses: 1 })
	})
	const name = ((await r.json()) as { name?: string }).name
	if (!name) throw new Error(`could not mint a token (HTTP ${r.status})`)
	return name
}

const runArm = async (
	arm: string,
	systemPrompt: string,
	key: string,
	states: { why: string; state: VisionState }[]
): Promise<Turn[]> => {
	const token = await mintToken(key)
	return await new Promise<Turn[]>((resolve, reject) => {
		const ws = new WebSocket(
			`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`
		)
		const out: Turn[] = []
		const queue = states.slice(0, TURNS).map((s, i) => ({ ...s, i }))
		let current: (typeof queue)[number] | null = null
		let startedAt = 0
		let text = ""
		let pcm: Buffer[] = []
		// Per TURN, not per socket: a mime type left over from an earlier turn made the "no audio"
		// warning name a format that this turn never sent, which is worse than saying nothing.
		let seenMime = new Set<string>()

		const next = () => {
			const s = queue.shift()
			if (!s) {
				ws.close(1000)
				resolve(out)
				return
			}
			current = s
			startedAt = Date.now()
			text = ""
			pcm = []
			seenMime = new Set()
			ws.send(
				JSON.stringify({
					clientContent: {
						turns: [{ role: "user", parts: [{ text: renderState(s.state) }] }],
						turnComplete: true
					}
				})
			)
		}

		ws.onopen = () =>
			ws.send(
				JSON.stringify({
					setup: {
						model: LIVE_MODEL,
						generationConfig: { responseModalities: ["AUDIO"] },
						outputAudioTranscription: {},
						systemInstruction: { parts: [{ text: systemPrompt }] }
					}
				})
			)

		ws.onmessage = async ev => {
			const raw = typeof ev.data === "string" ? ev.data : await (ev.data as Blob).text()
			const m = JSON.parse(raw) as {
				setupComplete?: unknown
				serverContent?: {
					turnComplete?: boolean
					outputTranscription?: { text?: string }
					modelTurn?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] }
				}
			}
			if (m.setupComplete) return next()
			const sc = m.serverContent
			if (!sc) return
			if (sc.outputTranscription?.text) text += sc.outputTranscription.text
			for (const p of sc.modelTurn?.parts ?? []) {
				if (p.text) text += p.text
				/*
				 * The audio is the whole point of this script; the transcript is only its label.
				 *
				 * Deliberately permissive about the mime type, and LOUD when a turn arrives with
				 * none. A run where every capture came back empty looked exactly like a run where
				 * the voice was fine, and cost a socket to work out.
				 */
				if (p.inlineData?.data) {
					seenMime.add(p.inlineData.mimeType ?? "(none)")
					pcm.push(Buffer.from(p.inlineData.data, "base64"))
				}
			}
			if (sc.turnComplete && current) {
				if (pcm.length === 0 && text.trim() !== "" && !/^pass\b/i.test(text.trim()))
					process.stderr.write(
						`      !! turn ${current.i} produced TEXT but no audio — mime seen: ${[...seenMime].join(",") || "none"}\n`
					)
				out.push({
					arm,
					i: current.i,
					why: current.why,
					block: renderState(current.state),
					transcript: text.trim(),
					audio: Buffer.concat(pcm),
					ms: Date.now() - startedAt
				})
				next()
			}
		}
		ws.onerror = () => reject(new Error("socket error"))
		ws.onclose = e => {
			if (e.code !== 1000 && out.length === 0)
				reject(new Error(`closed ${e.code}: ${String(e.reason).slice(0, 200)}`))
			else resolve(out)
		}
		setTimeout(() => {
			ws.close()
			resolve(out)
		}, 180_000)
	})
}

/* ------------------------------------------------------------------- the ear */

/** Gemini Live sends signed 16-bit little-endian mono PCM at 24 kHz. */
const wav = (pcm: Buffer, rate = 24_000): Buffer => {
	const head = Buffer.alloc(44)
	head.write("RIFF", 0)
	head.writeUInt32LE(36 + pcm.length, 4)
	head.write("WAVE", 8)
	head.write("fmt ", 12)
	head.writeUInt32LE(16, 16)
	head.writeUInt16LE(1, 20)
	head.writeUInt16LE(1, 22)
	head.writeUInt32LE(rate, 24)
	head.writeUInt32LE(rate * 2, 28)
	head.writeUInt16LE(2, 32)
	head.writeUInt16LE(16, 34)
	head.write("data", 36)
	head.writeUInt32LE(pcm.length, 40)
	return Buffer.concat([head, pcm])
}

/**
 * What a listener actually hears.
 *
 * The instruction fights the transcriber's strongest instinct, which is to be helpful: an ASR
 * asked for a transcript writes "Briar" when it hears "bree-arr", because "Briar" is the word that
 * exists. That helpfulness is exactly what hid this bug for months, so the prompt asks for
 * syllables and says outright not to repair anything.
 */
const EAR_PROMPT = `Listen to this audio and write down EXACTLY what you hear, syllable by syllable.

This is a pronunciation test. Do NOT correct anything into a word you recognise, do NOT normalise
numbers, and do NOT guess what was meant. If a word is said oddly, spell the sounds you actually
hear, hyphenated: "fifty-two seds", "bry-ur", "kah-ZIKS".

Write numbers as the WORDS you hear ("fifty-two"), never as digits, even when the digits would be
obvious. Reply with the transcription only, no commentary.`

const listen = async (audio: Buffer, key: string): Promise<string> => {
	const r = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${EAR_MODEL}:generateContent`,
		{
			method: "POST",
			headers: { "x-goog-api-key": key, "content-type": "application/json" },
			body: JSON.stringify({
				contents: [
					{
						role: "user",
						parts: [
							{ text: EAR_PROMPT },
							{ inlineData: { mimeType: "audio/wav", data: wav(audio).toString("base64") } }
						]
					}
				]
			})
		}
	)
	const j = (await r.json()) as {
		candidates?: { content?: { parts?: { text?: string }[] } }[]
		error?: { message?: string }
	}
	if (j.error) return `[ear failed: ${j.error.message ?? "unknown"}]`
	return (j.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? "").join("").trim()
}

/*
 * The number check compares the figures HEARD against the figures the fact was BUILT from — never
 * against the transcript. The transcript is Google's own normalised read-back, and it wrote "1334
 * gold" over a voice that said "one hundred thirty-four gold", which is exactly how this defect
 * survived every instrument in the repo.
 *
 * The pair reading is not leniency, it is correctness. English says a four-digit figure as two
 * halves — "thirteen thirty-four" is 1334 said properly, by a person, and `numbersIn` splits it
 * into 13 and 34 on purpose so that a spoken game clock is not summed into an invented number. A
 * checker that ignored that would have scored the two most natural readings in the whole run as
 * wrong numbers, which is the instrument flattering the fix instead of testing it.
 */
const pairReading = (n: number): number[] | null =>
	n >= 1000 && n < 10_000 ? [Math.floor(n / 100), n % 100] : null

const heardWrong = (want: number[] | undefined, heard: string): number[] => {
	if (!want) return []
	const got = numbersIn(heard)
	return want.filter(n => {
		if (got.includes(n)) return false
		const pair = pairReading(n)
		if (!pair) return true
		// "twenty-eight seventy-four" for 2874. Both halves, in order, adjacent in what was heard.
		for (let i = 0; i + 1 < got.length; i++)
			if (got[i] === pair[0] && got[i + 1] === pair[1]) return false
		return true
	})
}

/* -------------------------------------------------------------------- report */

/** Strip the 44-byte header back off, so a saved WAV can be re-judged like a fresh capture. */
const readWav = (path: string): Buffer => readFileSync(path).subarray(44)

const relisten = async (key: string): Promise<void> => {
	const prior = JSON.parse(readFileSync(join(OUT, "report.json"), "utf8")) as {
		rows: { arm: string; i: number; why: string; transcript: string; heard: string }[]
	}
	for (const r of prior.rows) {
		const path = join(OUT, `${r.arm}-${r.i}.wav`)
		const pcm = readWav(path)
		r.heard = pcm.length === 0 ? "[no audio]" : await listen(pcm, key)
		/*
		 * Re-judged here as well as in the summary. A re-listen exists so a stored recording can be
		 * scored again by a better ear or a corrected checker; leaving the old verdict beside the
		 * new transcription would be the worst of both.
		 */
		const wrong = SUITE === "numbers" ? heardWrong(NUMBER_FACTS[r.i]?.want, r.heard) : []
		;(r as { wrongFigures?: number[] }).wrongFigures = wrong
		process.stderr.write(`  [${r.arm} ${r.i}] ${r.why}\n      said : ${r.transcript}\n      heard: ${r.heard}\n`)
	}
	writeFileSync(
		join(OUT, "report.json"),
		JSON.stringify({ ...prior, ear: EAR_MODEL, relistenedAt: new Date().toISOString() }, null, "\t")
	)
}

const main = async () => {
	const key = geminiKey()
	if (key === "") throw new Error("no Gemini key — set one in the app or GEMINI_API_KEY")
	mkdirSync(OUT, { recursive: true })
	if (RELISTEN) return await relisten(key)

	const table = parsePronunciations(readFileSync("knowledge/pronunciations.md", "utf8"))
	const guide = renderPronunciationGuide(table)
	process.stderr.write(
		`table ${table.length} entries, guide ${guide.length} chars (~${Math.round(guide.length / 4)} tokens, once per socket)\n`
	)

	const rows: (Turn & { heard: string })[] = []
	for (const arm of ARMS) {
		// Only the `guide` arm changes the prompt. In the number suite BOTH arms hold the shipped
		// prompt, so the single variable is the shape of the figure — which is the whole claim.
		const prompt = arm === "guide" ? `${LIVE_COACH_SYSTEM_PROMPT}\n\n${guide}` : LIVE_COACH_SYSTEM_PROMPT
		const states =
			SUITE === "numbers" ? numberSuite(arm === "spelled" ? "spelled" : "digits") : NAME_SUITE
		process.stderr.write(`\n== arm ${arm} (${prompt.length} prompt chars, ${states.length} states)\n`)
		const turns = await runArm(arm, prompt, key, states)
		for (const t of turns) {
			writeFileSync(join(OUT, `${t.arm}-${t.i}.wav`), wav(t.audio))
			const heard = t.audio.length === 0 ? "[no audio]" : await listen(t.audio, key)
			rows.push({ ...t, heard })
			process.stderr.write(`  [${t.i}] ${t.why}\n      said : ${t.transcript}\n      heard: ${heard}\n`)
		}
	}

	/*
	 * The two counts that decide it, and they are counted separately because they are different
	 * questions: one is "did the audio get better", the other is "did the fix leak into the words".
	 */
	const respellings = table.map(p => p.say).filter(s => s.length >= 4)
	const wants = SUITE === "numbers" ? NUMBER_FACTS.map(f => f.want) : []
	const summary = ARMS.map(arm => {
		const mine = rows.filter(r => r.arm === arm)
		const leaked = mine.filter(r =>
			respellings.some(s => r.transcript.toLowerCase().includes(s.toLowerCase()))
		)
		const digitsHeard = mine.filter(r => /\d/.test(r.heard))
		const digitsSaid = mine.filter(r => /\d/.test(r.transcript))
		const audible = mine.filter(r => r.heard !== "[no audio]")
		const wrong = audible.filter(r => heardWrong(wants[r.i], r.heard).length > 0)
		return {
			arm,
			turns: mine.length,
			audible: audible.length,
			leaked: leaked.length,
			digitsHeard: digitsHeard.length,
			digitsSaid: digitsSaid.length,
			...(SUITE === "numbers" ?
				{
					figuresWrongInAudio: wrong.length,
					misheard: wrong.map(
						r => `${r.i}: wanted ${heardWrong(wants[r.i], r.heard).join("/")} — heard "${r.heard}"`
					)
				}
			:	{})
		}
	})

	writeFileSync(
		join(OUT, "report.json"),
		JSON.stringify(
			{ at: new Date().toISOString(), model: LIVE_MODEL, ear: EAR_MODEL, summary, rows: rows.map(r => ({ ...r, audio: undefined, block: undefined })) },
			null,
			"\t"
		)
	)
	process.stderr.write(`\n${JSON.stringify(summary, null, "\t")}\nwrote ${OUT}/report.json\n`)
}

await main()
