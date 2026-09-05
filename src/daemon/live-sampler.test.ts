/**
 * The sampler writes during a live game, so its contract is about not being able to hurt one: it
 * rate-limits itself, it survives being killed mid-append, and it never throws.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"

const dir = mkdtempSync(join(tmpdir(), "eepalytics-samples-"))
process.env.EEPALYTICS_DATA_DIR = dir

const { SAMPLE_DIR, SAMPLE_EVERY_SEC, pruneSamples, readSamples, sampleCount, sampleLive } =
	await import("./live-sampler.ts")

describe("sampleLive", () => {
	it("writes the first sample and then rate-limits on the GAME clock", () => {
		const g = "js-rate"
		strictEqual(sampleLive({ gameId: g, gameTimeSec: 100, data: { a: 1 } }), true)
		// Wall-clock does not matter; the game clock does, because that is what an eval replays.
		strictEqual(sampleLive({ gameId: g, gameTimeSec: 101, data: { a: 2 } }), false)
		strictEqual(sampleLive({ gameId: g, gameTimeSec: 100 + SAMPLE_EVERY_SEC, data: { a: 3 } }), true)
		strictEqual(sampleCount(g), 2)
	})

	it("starts a new file when the clock jumps backwards, because that is a new game", () => {
		const g = "js-roll"
		sampleLive({ gameId: g, gameTimeSec: 900, data: {} })
		// A backwards clock is the earliest reliable "new game" signal, same as the frame journal.
		strictEqual(sampleLive({ gameId: g, gameTimeSec: 5, data: {} }), true)
	})

	it("refuses a sample it cannot place: no session, or no clock", () => {
		strictEqual(sampleLive({ gameId: null, gameTimeSec: 100, data: {} }), false)
		strictEqual(sampleLive({ gameId: "js-x", gameTimeSec: NaN, data: {} }), false)
		strictEqual(sampleCount("js-x"), 0)
	})

	it("round-trips the game clock and the payload", () => {
		const g = "js-round"
		sampleLive({ gameId: g, gameTimeSec: 42, data: { champion: "Lillia" } })
		const [s] = readSamples(g)
		strictEqual(s?.gameTime, 42)
		strictEqual((s?.data as { champion: string }).champion, "Lillia")
	})
})

describe("readSamples", () => {
	it("drops a torn last line rather than losing the game", () => {
		// The daemon can be killed mid-append. One truncated sample must not cost the whole game's
		// evaluation data.
		const g = "js-torn"
		sampleLive({ gameId: g, gameTimeSec: 10, data: { ok: true } })
		writeFileSync(join(SAMPLE_DIR, `${g}.ndjson`), `${readFileSync(join(SAMPLE_DIR, `${g}.ndjson`), "utf8")}{"atMs":1,"gam`)
		strictEqual(readSamples(g).length, 1)
	})

	it("answers empty for a game that was never sampled", () => {
		strictEqual(readSamples("js-nope").length, 0)
		strictEqual(sampleCount("js-nope"), 0)
	})
})

describe("pruneSamples", () => {
	it("keeps recent files and removes stale ones", () => {
		sampleLive({ gameId: "js-fresh", gameTimeSec: 10, data: {} })
		strictEqual(pruneSamples(Date.now()), 0)
		ok(sampleCount("js-fresh") > 0)
		// Far enough in the future that everything on disk is past the window.
		ok(pruneSamples(Date.now() + 400 * 86_400_000) > 0)
	})
})

process.on("exit", () => rmSync(dir, { recursive: true, force: true }))
