/**
 * The live coach, for every provider that is not Gemini Live.
 *
 * ## Two shapes, not one
 *
 * Gemini Live is a socket: native audio, continuous frames, barge-in, a thread the model keeps.
 * Everything else — Anthropic, OpenAI, Kimi, GLM, and Gemini over plain HTTPS — is a TURN: send a
 * frame and a block, get text, speak it here. Flattening the two would be a lie, and the
 * differences are ones he will feel in a game:
 *
 *   - it is SLOWER. Measured on the HTTPS path: about two and a half seconds against roughly one,
 *     and fifteen seconds for a reasoning model's first answer.
 *   - it CANNOT BE INTERRUPTED usefully. The sentence was written and paid for before the first
 *     syllable, so cutting it off saves nothing and loses the rest.
 *   - it has NO MEMORY of earlier turns, because each request is fresh.
 *
 * The settings screen says all three where he chooses, rather than letting him discover them
 * mid-game.
 *
 * ## The key never comes here
 *
 * The browser POSTs the frame and the block to the daemon, which holds the key and supplies the
 * system prompt. That is the same rule the Gemini key follows, and it also means the prompt is
 * identical across providers by construction — a comparison in which the prompt could drift would
 * measure the wrong thing.
 */

/** What the daemon answers. Failure is a 200 with `ok: false`, never a status code. */
export interface TurnResult {
	ok: boolean
	text: string
	model: string
	frameSent: boolean
	latencyMs: number
	reason?: string
	/**
	 * When the first delta arrived, and when the first fragment a voice could SAY did. Streaming
	 * turns only.
	 *
	 * Two numbers rather than one because they answer different questions: the first is the
	 * provider's, the second is his. A model that opens on a token nobody can pronounce has a fast
	 * `ttftMs` and a slow coach.
	 */
	ttftMs?: number
	speakableMs?: number
	/**
	 * Say-it-like-this rows for this game's roster, for `SystemVoice.setPronunciations`.
	 *
	 * On the response rather than fetched separately because this path already makes exactly one
	 * request per turn and the table lives behind the daemon (it is editable markdown, which the
	 * browser cannot read). Optional, so a daemon that does not send it changes nothing.
	 */
	pronounce?: SpokenName[]
}

export const runCoachTurn = async (input: {
	provider: string
	model: string
	/** JPEG data URL or bare base64; the daemon strips the prefix either way. */
	frame: string | null
	block: string
	signal?: AbortSignal
}): Promise<TurnResult> => {
	try {
		const res = await fetch("/api/live/coach/turn", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				provider: input.provider,
				model: input.model,
				...(input.frame ? { frame: input.frame } : {}),
				block: input.block
			}),
			...(input.signal ? { signal: input.signal } : {})
		})
		return (await res.json()) as TurnResult
	} catch (err) {
		// A dropped request must never interrupt a game; it is one missed turn.
		return {
			ok: false,
			text: "",
			model: input.model,
			frameSent: false,
			latencyMs: 0,
			reason: err instanceof Error ? err.message : String(err)
		}
	}
}

/**
 * The same turn, spoken as it is written.
 *
 * ## The number this moves
 *
 * `runCoachTurn` above waits for the whole sentence and then speaks it, so the first syllable
 * lands after the LAST token was paid for. Measured over six real turns of game 5639409343,
 * claude-sonnet-5 at low effort reached a speakable fragment at a median 1,553ms this way against
 * 2,513ms buffered — faster on 6 of 6 turns, sign test p=0.031 — with the total generation time
 * unchanged. A coach that starts talking a second earlier is a different product in a game where
 * the moment being described lasts four seconds.
 *
 * It is not a universal win and the caller should not assume one: gemini-3.8-flash returns its
 * whole answer in a single burst, so on that model this behaves exactly like the buffered route.
 *
 * ## What `onChunk` receives
 *
 * SPEAKABLE fragments, not provider deltas: the daemon runs `SpeechChunker`, so a fragment ends on
 * punctuation or a word boundary and the silence token `PASS` is never handed over at all. Speak
 * each one as it arrives — `speechSynthesis` queues them and reads them as one continuous line.
 *
 * ## Failure is still a quiet turn
 *
 * Same contract as the buffered call: a dropped connection resolves with `ok: false` rather than
 * throwing, because a network hiccup must cost one turn and never interrupt a game. Anything
 * already spoken stays spoken — there is no way to unsay it and no reason to try.
 */
export const runCoachTurnStreaming = async (input: {
	provider: string
	model: string
	frame: string | null
	block: string
	onChunk: (chunk: string) => void
	signal?: AbortSignal
}): Promise<TurnResult> => {
	const started = Date.now()
	try {
		const res = await fetch("/api/live/coach/turn/stream", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				provider: input.provider,
				model: input.model,
				...(input.frame ? { frame: input.frame } : {}),
				block: input.block
			}),
			...(input.signal ? { signal: input.signal } : {})
		})
		if (!res.body) return (await res.json()) as TurnResult
		const reader = res.body.getReader()
		const decoder = new TextDecoder()
		let buffered = ""
		let done: TurnResult | null = null
		let spoken = ""
		for (;;) {
			const { value, done: end } = await reader.read()
			if (end) break
			buffered += decoder.decode(value, { stream: true })
			// Newline-delimited JSON: a partial line at the tail is normal and waits for more bytes.
			const lines = buffered.split("\n")
			buffered = lines.pop() ?? ""
			for (const line of lines) {
				if (line.trim() === "") continue
				const msg = JSON.parse(line) as { chunk?: string; done?: TurnResult }
				if (typeof msg.chunk === "string") {
					spoken += msg.chunk
					input.onChunk(msg.chunk)
				}
				if (msg.done) done = msg.done
			}
		}
		return (
			done ?? {
				ok: spoken !== "",
				text: spoken,
				model: input.model,
				frameSent: input.frame !== null,
				latencyMs: Date.now() - started,
				reason: spoken === "" ? "the stream ended without an answer" : undefined
			}
		)
	} catch (err) {
		return {
			ok: false,
			text: "",
			model: input.model,
			frameSent: false,
			latencyMs: Date.now() - started,
			reason: err instanceof Error ? err.message : String(err)
		}
	}
}

/* ------------------------------------------------- saying it out loud */

/**
 * A champion name and how it should be said. Structurally the same row as `shared/pronounce.ts`,
 * restated here so this module stays a leaf the browser can load without pulling in the daemon's
 * knowledge loader.
 */
export interface SpokenName {
	name: string
	say: string
}

/**
 * Abbreviations that are only ever wrong out loud.
 *
 * Measured, in a real game: "52s" was spoken as "fifty two seds" and "1334g" as a letter. The
 * facts `buildFacts` writes spell their units out for exactly this reason, but on this path the
 * sentence was written by a model we do not control, so it can still arrive abbreviated.
 *
 * Only a unit GLUED TO DIGITS is touched. A bare "s" or "g" in prose is a letter in a word, and a
 * rule that rewrote those would turn every sentence into nonsense to fix one token.
 */
const GLUED_UNITS: readonly [RegExp, string][] = [
	[/(\d)\s?s\b/g, "$1 seconds"],
	[/(\d)\s?g\b/g, "$1 gold"],
	[/(\d)\s?m\b/g, "$1 minutes"]
]

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * One alternation over every name, longest first.
 *
 * ONE pass, not one per entry, and that is load-bearing: replacing entry by entry lets a
 * respelling that happens to contain another champion's letters be respelled again on a later
 * pass. A single alternation cannot revisit text it has already written.
 *
 * Punctuation between the words of a name is flexible because two hands spell these differently —
 * "Kha'Zix", "KhaZix" and "Kha Zix" are the same champion and only one of them is what the model
 * will have typed. The bridge is capped at three characters so a multi-word name cannot reach
 * across a sentence boundary and swallow the words in between.
 */
const namePattern = (names: readonly SpokenName[]): RegExp | null => {
	const parts = [...names]
		.sort((a, b) => b.name.length - a.name.length)
		.map(p =>
			p.name
				.split(/[^A-Za-z0-9]+/)
				.filter(x => x !== "")
				.map(escape)
				.join("[^A-Za-z0-9]{0,3}")
		)
		.filter(x => x !== "")
	if (parts.length === 0) return null
	return new RegExp(`(?<![A-Za-z0-9])(?:${parts.join("|")})(?![A-Za-z0-9])`, "gi")
}

/**
 * The sentence as it should be HEARD, which is not the sentence he reads.
 *
 * ## Why this is safe here and was not safe in the block
 *
 * The first attempt at this shipped a phonetic table INTO the ground-truth block and the model
 * read the respellings out loud — "BRY-er is still at 0 CS", to the player, repeatedly. That
 * failure is impossible on this path, because the model is never shown a respelling: the text
 * comes back finished, the transcript keeps it verbatim, and the substitution happens in the last
 * few milliseconds before `speechSynthesis` sees it. Nothing that respells can reach a prompt.
 *
 * The displayed line is deliberately NOT respelt. The log is what makes the coach auditable, and
 * "kah-ZIKS is 14 CS up" in a transcript is a worse artefact than a mispronounced name.
 */
export const respellForSpeech = (text: string, names: readonly SpokenName[] = []): string => {
	let out = text
	for (const [re, to] of GLUED_UNITS) out = out.replace(re, to)
	const re = namePattern(names)
	if (!re) return out
	const byKey = new Map(names.map(p => [p.name.toLowerCase().replace(/[^a-z0-9]/g, ""), p.say]))
	return out.replace(re, m => byKey.get(m.toLowerCase().replace(/[^a-z0-9]/g, "")) ?? m)
}

/**
 * Speak a line with the system voice.
 *
 * `speechSynthesis` rather than an audio stream, because these providers return TEXT and adding a
 * TTS service would put a second key, a second bill and a second point of failure between him and
 * a sentence. It does not sound like Leda and it cannot: that is inherent to the shape, not a
 * tuning gap, and pretending otherwise would be the wrong trade to hide.
 */
export class SystemVoice {
	/** Chosen once — enumerating voices on every line is slow and the list is stable. */
	#voice: SpeechSynthesisVoice | null = null
	/**
	 * Say-it-like-this rows, applied to the AUDIO only.
	 *
	 * Empty by default, which is exactly today's behaviour — a voice with no table respells no
	 * names and the only thing that changes is that "52s" stops being read as "fifty two seds".
	 * Handed in rather than imported so this stays a leaf module: the table is editable markdown
	 * that only the daemon can read.
	 */
	#names: readonly SpokenName[] = []
	available = typeof window !== "undefined" && "speechSynthesis" in window

	/** Replace the pronunciation table. Safe to call every turn; it is a reference swap. */
	setPronunciations(names: readonly SpokenName[]): void {
		this.#names = names
	}

	#pick(): SpeechSynthesisVoice | null {
		if (this.#voice) return this.#voice
		if (!this.available) return null
		const all = window.speechSynthesis.getVoices()
		if (all.length === 0) return null
		/*
		 * Prefer a local English voice. A network voice adds latency to a path that is already the
		 * slow one, and this coach's whole problem is arriving after the moment it describes.
		 */
		this.#voice =
			all.find(v => v.localService && /^en/i.test(v.lang)) ??
			all.find(v => /^en/i.test(v.lang)) ??
			all[0]!
		return this.#voice
	}

	/**
	 * Speak it — respelt.
	 *
	 * The respelling lives HERE rather than at the call site, and that placement is the guarantee:
	 * `geminiLive.ts` records and renders `text` before calling this, so there is no path by which
	 * a respelling reaches the transcript, the fault scorer or a prompt. The version that shipped a
	 * phonetic table into the ground-truth block failed precisely because it was upstream of a
	 * prompt; nothing downstream of `speechSynthesis` can repeat that.
	 */
	speak(text: string): void {
		if (!this.available || text.trim() === "") return
		const u = new SpeechSynthesisUtterance(respellForSpeech(text, this.#names))
		const v = this.#pick()
		if (v) u.voice = v
		// Slightly quick: this is a sentence over a game, not an audiobook.
		u.rate = 1.1
		window.speechSynthesis.speak(u)
	}

	/**
	 * Stop talking.
	 *
	 * Kept even though a turn-based provider cannot truly barge in — the sentence is already
	 * bought. What this DOES do is stop a stale line finishing over a new fight, which is worth
	 * having even when the token cost is sunk.
	 */
	silence(): void {
		if (!this.available) return
		window.speechSynthesis.cancel()
	}

	get speaking(): boolean {
		return this.available && window.speechSynthesis.speaking
	}
}
