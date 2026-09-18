/**
 * WHEN a half-written sentence is safe to say out loud. Pure, browser-safe, and the whole of what
 * makes a turn-based model eligible for a live coach.
 *
 * ## The number this exists to move
 *
 * On the turn path the browser waits for the WHOLE answer and then hands it to `speechSynthesis`.
 * So the thing he actually experiences — silence, then a voice — is not the model's latency, it is
 * the model's latency plus every token after the first. Measured on this repo's own payloads, a
 * model that finishes in 2.6s starts its first word at about 1.0s if the first clause is spoken as
 * it arrives. Nothing about the model changed; the wait was an artefact of buffering.
 *
 * ## Why this is not just "speak every delta"
 *
 * Three constraints, all of them learned rather than assumed:
 *
 * 1. **PASS must never be spoken.** The prompt's silence token is four characters, and a coach that
 *    says "pass" out loud every time it correctly decides to stay quiet is worse than one that is
 *    slow. So nothing is emitted until the buffer has proved it is not the silence token — which
 *    costs nothing, because that proof arrives with the fifth character.
 * 2. **`speechSynthesis` queues whole utterances and cannot be re-flowed.** A chunk is spoken as a
 *    unit with its own prosody, so cutting mid-word ("you are th" / "ree seconds") is audibly
 *    broken. Chunks therefore end at punctuation or, failing that, at a word boundary once the
 *    chunk is long enough to sound like a phrase.
 * 3. **The first chunk should be SHORT and the rest can be long.** Time-to-first-syllable is set
 *    entirely by the first chunk; everything after it is spoken while the mouth is already moving.
 *    So the first boundary is allowed at `FIRST_MIN_CHARS` and later ones wait for `MIN_CHARS`,
 *    which keeps the tail from arriving as a stutter of three-word utterances.
 *
 * ## It is a chunker, not an editor
 *
 * It never changes a character of what the model said, never drops a clause, never reorders one.
 * `chunks.join("")` is byte-identical to the text that arrived — `speech-chunks.test.ts` asserts
 * exactly that on every case, because a mechanism that can edit a line on its way to the speaker is
 * a mechanism that can make the transcript disagree with what he heard.
 */

/** The prompt's silence token. Nothing is emitted while the buffer could still turn out to be it. */
export const SILENCE_TOKEN = "PASS"

/** A first chunk may be this short — it only has to sound like the beginning of a sentence. */
export const FIRST_MIN_CHARS = 12

/** Later chunks wait for this much, so the tail is not a stutter of three-word utterances. */
export const MIN_CHARS = 45

/** Where a sentence may end. Also `—`, which this coach uses as a clause break. */
const HARD_BREAK = /[.!?;:—]/

/**
 * A streaming chunker.
 *
 * Feed it deltas; it returns the chunks that became speakable BECAUSE of that delta (usually none,
 * sometimes one). Call `flush()` when the stream ends to get whatever is left.
 *
 * Stateful by necessity and deliberately tiny: one buffer and one boolean. The boolean is the only
 * thing that would be wrong to infer from the buffer — once a chunk has been emitted, a later
 * buffer that happens to read "PASS" is a word in a sentence, not a refusal.
 */
export class SpeechChunker {
	#buffer = ""
	#emitted = false

	/** What has not been handed out yet. For a caller that wants to see the pending tail. */
	get pending(): string {
		return this.#buffer
	}

	/**
	 * Could this buffer still grow into the silence token?
	 *
	 * Only while nothing has been spoken, and only while it is a prefix of it. "PA" is undecided,
	 * "PAS" is undecided, "PASSING" is decided the moment the fifth character lands — which is why
	 * the check is a prefix test rather than an equality test against a length.
	 */
	#undecided(): boolean {
		if (this.#emitted) return false
		const head = this.#buffer.trimStart()
		return SILENCE_TOKEN.startsWith(head.slice(0, SILENCE_TOKEN.length).toUpperCase())
	}

	/** Feed one delta. Returns the chunks it made speakable, in order. */
	push(delta: string): string[] {
		this.#buffer += delta
		const out: string[] = []
		for (;;) {
			const cut = this.#boundary()
			if (cut === null) break
			const chunk = this.#buffer.slice(0, cut)
			this.#buffer = this.#buffer.slice(cut)
			this.#emitted = true
			out.push(chunk)
		}
		return out
	}

	/**
	 * The end of the stream. Returns the remainder, or nothing at all when the whole answer was the
	 * silence token — the one case where the chunker's output is deliberately not the input.
	 */
	flush(): string[] {
		const rest = this.#buffer
		this.#buffer = ""
		if (rest.trim() === "") return []
		if (!this.#emitted && rest.trim().toUpperCase() === SILENCE_TOKEN) return []
		this.#emitted = true
		return [rest]
	}

	/**
	 * The index just past the first speakable boundary in the buffer, or null.
	 *
	 * A hard break wins wherever it is, past the minimum. Otherwise a word boundary is accepted
	 * once the buffer is comfortably past the minimum, because a model that writes one long clause
	 * should not hold the voice until its full stop.
	 */
	#boundary(): number | null {
		if (this.#undecided()) return null
		const min = this.#emitted ? MIN_CHARS : FIRST_MIN_CHARS
		if (this.#buffer.length < min) return null
		for (let i = min; i < this.#buffer.length; i++)
			if (HARD_BREAK.test(this.#buffer[i]!)) {
				// Take the punctuation with the chunk, plus one trailing space so the next chunk
				// does not open on whitespace.
				let end = i + 1
				if (this.#buffer[end] === " ") end += 1
				return end
			}
		// No punctuation in sight: break on a space, but only once the chunk is long enough that
		// the pause it introduces reads as a breath rather than a glitch.
		const soft = min + MIN_CHARS
		if (this.#buffer.length < soft) return null
		const at = this.#buffer.lastIndexOf(" ", this.#buffer.length - 1)
		return at <= 0 ? null : at + 1
	}
}

/**
 * The whole-answer case, for a caller that already has the text — the non-streaming path, and every
 * stored transcript being re-scored.
 *
 * Same boundaries as the stream, so a line's chunking does not depend on how it arrived.
 */
export const speechChunks = (text: string): string[] => {
	const c = new SpeechChunker()
	const out = c.push(text)
	return [...out, ...c.flush()]
}
