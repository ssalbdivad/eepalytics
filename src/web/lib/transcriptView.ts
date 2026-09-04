/**
 * What the "What she said, earlier" panel should be showing, decided in one place.
 *
 * This is here rather than inline in `LiveTranscript.tsx` because it is the exact logic that hid
 * a real bug for a whole game. The panel used to hold one `Line[] | null`: `null` meant loading,
 * anything else meant "here is the transcript". A fetch that FAILED wrote `[]` into that same
 * slot, so a broken read and a coach who had said nothing yet rendered the identical grey
 * sentence — and the sentence was the reassuring one.
 *
 * Four states, and no two of them are the same sentence. Pure, so the distinction is a test
 * rather than something you have to break the daemon to see.
 */

export interface TranscriptViewInput {
	/** Lines from the most recent SUCCESSFUL read, or null if none has succeeded yet. */
	lines: readonly unknown[] | null
	/** Why the most recent read failed, or null if it succeeded. */
	readError: string | null
}

export type TranscriptView =
	/** No read has finished yet. */
	| { kind: "loading" }
	/** No read has ever succeeded, and the last one failed. Nothing is known. */
	| { kind: "unreadable"; reason: string }
	/** A read succeeded and the transcript is genuinely empty. */
	| { kind: "empty" }
	/**
	 * There are lines to show. `staleReason` is set when a LATER read failed — the list is real
	 * but may be behind, which is worth saying and is not worth throwing the list away over.
	 */
	| { kind: "lines"; staleReason: string | null }

export const transcriptView = ({ lines, readError }: TranscriptViewInput): TranscriptView => {
	if (lines === null) return readError === null ? { kind: "loading" } : { kind: "unreadable", reason: readError }
	if (lines.length === 0) return readError === null ? { kind: "empty" } : { kind: "unreadable", reason: readError }
	return { kind: "lines", staleReason: readError }
}
