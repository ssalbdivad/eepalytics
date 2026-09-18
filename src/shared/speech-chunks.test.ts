import assert from "node:assert/strict"
import { test } from "node:test"
import { SILENCE_TOKEN, SpeechChunker, speechChunks } from "./speech-chunks.ts"

/** Deltas the way a provider actually sends them: a few characters at a time, word-aligned or not. */
const feed = (text: string, size: number): { chunks: string[]; firstAfter: number } => {
	const c = new SpeechChunker()
	const chunks: string[] = []
	let firstAfter = -1
	for (let i = 0; i < text.length; i += size) {
		const got = c.push(text.slice(i, i + size))
		if (got.length > 0 && firstAfter === -1) firstAfter = Math.min(i + size, text.length)
		chunks.push(...got)
	}
	chunks.push(...c.flush())
	return { chunks, firstAfter }
}

const LINE =
	"Fiddlesticks is level five to your four, so take your raptors now and path to drake, " +
	"you can be at the pit twenty six seconds before it spawns."

test("nothing is added, dropped or reordered", () => {
	for (const size of [1, 3, 7, 40, 500]) {
		const { chunks } = feed(LINE, size)
		assert.equal(chunks.join(""), LINE, `delta size ${size}`)
	}
})

test("the silence token is never spoken", () => {
	for (const size of [1, 2, 4, 99]) {
		const { chunks } = feed(SILENCE_TOKEN, size)
		assert.deepEqual(chunks, [], `delta size ${size}`)
	}
	// Nor with the whitespace a provider may pad it with.
	assert.deepEqual(speechChunks("  PASS\n"), [])
})

test("a word that merely starts like the silence token is spoken in full", () => {
	const text = "Passive gold is still gold, keep clearing your own camps first."
	assert.equal(speechChunks(text).join(""), text)
	assert.ok(speechChunks(text).length >= 1)
})

test("the first chunk lands long before the line finishes", () => {
	const { firstAfter } = feed(LINE, 4)
	assert.ok(firstAfter > 0, "something was emitted")
	// The whole point: the mouth starts moving on a fraction of the sentence.
	assert.ok(firstAfter < LINE.length * 0.5, `first chunk at ${firstAfter} of ${LINE.length}`)
})

test("chunks end on punctuation or a word boundary, never mid-word", () => {
	for (const size of [1, 5, 13]) {
		const { chunks } = feed(LINE, size)
		for (const c of chunks.slice(0, -1)) {
			const last = c.trimEnd().slice(-1)
			assert.ok(
				/[.!?;:—,]/.test(last) || c.endsWith(" "),
				`chunk ends mid-word: ${JSON.stringify(c)}`
			)
		}
	}
})

test("a short line still gets said", () => {
	assert.deepEqual(speechChunks("Back now."), ["Back now."])
})
