/**
 * The live-coach transcript: writing a line, and getting it back.
 *
 * ## Why these tests exist
 *
 * A real game recorded 33 spoken lines into `data/logs/live-transcript.jsonl` and the panel that
 * reads them back said "Nothing recorded yet." Nothing in this layer had a test, and every failure
 * on this path presents as the same thing — an empty list — so an empty list was the one outcome
 * nobody could tell apart from success.
 *
 * Each case below is one way that has happened or could happen while every log stays quiet:
 * an unreadable `?limit=`, a write that failed and reported `{ok: true}` anyway, a torn last line
 * from a daemon killed mid-append, and the ordering the panel depends on.
 *
 * Run: pnpm test
 */

import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

/*
 * DATA_DIR is read at module-eval time, so the temp directory has to be in the environment before
 * the module is imported — hence the dynamic import. Node's test runner gives each file its own
 * process, so this cannot leak into another test.
 */
const dir = mkdtempSync(join(tmpdir(), "fawnsei-transcript-"))
process.env.FAWNSEI_DATA_DIR = dir
after(() => rmSync(dir, { recursive: true, force: true }))

const { appendTranscript, parseTranscript, readTranscript, transcriptLimit, TRANSCRIPT_DEFAULT_LIMIT } =
	await import("./gemini-live.ts")

const FILE = join(dir, "logs", "live-transcript.jsonl")

const line = (atMs: number, text: string) =>
	JSON.stringify({ atMs, text, fromUser: false, gameTimeSec: null })

describe("parseTranscript", () => {
	it("returns the newest line first — the panel shows the top of this list", () => {
		const got = parseTranscript(`${line(1, "first")}\n${line(2, "second")}\n${line(3, "third")}\n`)
		assert.deepEqual(
			got.map(l => l.text),
			["third", "second", "first"]
		)
	})

	it("keeps every line before a torn final one", () => {
		// What a daemon killed mid-append leaves behind: a complete file plus half a record.
		const torn = `${line(1, "kept")}\n${line(2, "also kept")}\n{"atMs":3,"text":"tor`
		const got = parseTranscript(torn)
		assert.deepEqual(
			got.map(l => l.text),
			["also kept", "kept"],
			"a half-written last line must cost you that line and nothing else"
		)
	})

	it("survives a torn line in the MIDDLE of the file", () => {
		const got = parseTranscript(`${line(1, "a")}\n{"atMs":2,"text":\n${line(3, "c")}\n`)
		assert.deepEqual(
			got.map(l => l.text),
			["c", "a"]
		)
	})

	it("skips blank lines and JSON that is not a transcript record", () => {
		const got = parseTranscript(`${line(1, "real")}\n\n   \nnull\n[1,2,3]\n{"atMs":9}\n`)
		assert.deepEqual(
			got.map(l => l.text),
			["real"],
			"a row with no text would render as an empty line in the panel"
		)
	})

	it("keeps the ground-truth block intact, escaped newlines and all", () => {
		// This is the whole value of a stored line: the answer next to the question.
		const truth = "## Ground truth\n\nClock 14:19.\n\nYou: Lillia lv9"
		const raw = JSON.stringify({ atMs: 1, text: "said", fromUser: false, gameTimeSec: null, groundTruth: truth })
		const got = parseTranscript(`${raw}\n`)
		assert.equal(got.length, 1, "an embedded newline must not be read as a record separator")
		assert.equal(got[0]!.groundTruth, truth)
	})

	it("returns the newest N when a limit is given", () => {
		const text = [1, 2, 3, 4, 5].map(n => line(n, `l${n}`)).join("\n")
		assert.deepEqual(
			parseTranscript(text, 2).map(l => l.text),
			["l5", "l4"]
		)
	})

	/*
	 * The regression that would have shown the bug's shape. `Number("")` is 0 and `Number("all")`
	 * is NaN; the loop condition `out.length < limit` is false on the first pass for both, so the
	 * endpoint answered `{lines: []}` over a full file and the panel said "nothing recorded yet".
	 */
	it("never answers with nothing because the limit was unreadable", () => {
		const text = [1, 2, 3].map(n => line(n, `l${n}`)).join("\n")
		for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY])
			assert.equal(parseTranscript(text, bad).length, 3, `limit ${bad} must not empty the transcript`)
	})
})

describe("transcriptLimit", () => {
	it("falls back to the default rather than to zero", () => {
		for (const raw of [undefined, null, "", "   ", "all", "abc", "0", "-1", "NaN"])
			assert.equal(transcriptLimit(raw), TRANSCRIPT_DEFAULT_LIMIT, `?limit=${String(raw)}`)
	})

	it("takes a number it can read", () => {
		assert.equal(transcriptLimit("25"), 25)
		assert.equal(transcriptLimit("25.9"), 25)
	})

	it("caps a limit that would read the whole file into one response", () => {
		assert.equal(transcriptLimit("999999999"), 5000)
	})
})

describe("appendTranscript / readTranscript", () => {
	it("reads back what it wrote, newest first, creating the log directory on the way", () => {
		assert.deepEqual(readTranscript(), [], "no file yet is not a failure")

		assert.equal(appendTranscript({ atMs: 1000, text: "Drake is back in 60s.", fromUser: false, gameTimeSec: 840 }), true)
		assert.equal(
			appendTranscript({
				atMs: 2000,
				text: "what should I be doing",
				fromUser: true,
				gameTimeSec: 850,
				groundTruth: "Clock 14:10."
			}),
			true
		)

		const got = readTranscript()
		assert.deepEqual(
			got.map(l => l.text),
			["what should I be doing", "Drake is back in 60s."]
		)
		assert.equal(got[0]!.fromUser, true)
		assert.equal(got[1]!.groundTruth, undefined)

		// One record per line, so the file stays greppable — that is why it is JSONL and not JSON.
		assert.equal(readFileSync(FILE, "utf8").trimEnd().split("\n").length, 2)
	})

	it("reports a write it could not make, instead of claiming the line was stored", () => {
		// The browser holds the only copy of a line until this returns true. Answering `{ok: true}`
		// when the write failed is how a session goes missing with nothing on screen to say so.
		rmSync(FILE, { force: true })
		mkdirSync(FILE) // a DIRECTORY where the log file goes: every append to it must fail
		try {
			assert.equal(
				appendTranscript({ atMs: 1, text: "lost", fromUser: false, gameTimeSec: null }),
				false,
				"a failed write must be reported, not swallowed"
			)
			assert.deepEqual(readTranscript(), [], "and an unreadable file reads as no lines, not a crash")
		} finally {
			rmSync(FILE, { recursive: true, force: true })
		}
	})
})

describe("what the panel decides to show", async () => {
	const { transcriptView } = await import("../web/lib/transcriptView.ts")

	/*
	 * The bug this whole file exists for. "The read failed" and "she has said nothing" used to be
	 * the same `[]`, rendered as the same reassuring sentence — so a panel that could not reach
	 * the daemon looked exactly like a coach having a quiet game.
	 */
	it("never calls a failed read an empty transcript", () => {
		assert.deepEqual(transcriptView({ lines: null, readError: "the daemon answered HTTP 404" }), {
			kind: "unreadable",
			reason: "the daemon answered HTTP 404"
		})
		assert.deepEqual(transcriptView({ lines: [], readError: "Failed to fetch" }), {
			kind: "unreadable",
			reason: "Failed to fetch"
		})
	})

	it("says empty only when a read actually succeeded and came back empty", () => {
		assert.deepEqual(transcriptView({ lines: [], readError: null }), { kind: "empty" })
	})

	it("waits before claiming either", () => {
		assert.deepEqual(transcriptView({ lines: null, readError: null }), { kind: "loading" })
	})

	it("keeps showing lines when a later refresh fails, and marks them as behind", () => {
		assert.deepEqual(transcriptView({ lines: [{}], readError: null }), { kind: "lines", staleReason: null })
		assert.deepEqual(transcriptView({ lines: [{}], readError: "timed out" }), {
			kind: "lines",
			staleReason: "timed out"
		})
	})
})
