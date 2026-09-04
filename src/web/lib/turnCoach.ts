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
 * Speak a line with the system voice.
 *
 * `speechSynthesis` rather than an audio stream, because these providers return TEXT and adding a
 * TTS service would put a second key, a second bill and a second point of failure between him and
 * a sentence. It does not sound like Leda and it cannot: that is inherent to the shape, not a
 * tuning gap, and pretending otherwise would be the wrong trade to hide.
 */
export class SystemVoice {
	#current: SpeechSynthesisUtterance | null = null
	/** Chosen once — enumerating voices on every line is slow and the list is stable. */
	#voice: SpeechSynthesisVoice | null = null
	available = typeof window !== "undefined" && "speechSynthesis" in window

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

	speak(text: string): void {
		if (!this.available || text.trim() === "") return
		const u = new SpeechSynthesisUtterance(text)
		const v = this.#pick()
		if (v) u.voice = v
		// Slightly quick: this is a sentence over a game, not an audiobook.
		u.rate = 1.1
		this.#current = u
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
		this.#current = null
	}

	get speaking(): boolean {
		return this.available && window.speechSynthesis.speaking
	}
}
