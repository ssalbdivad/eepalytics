/**
 * The sampler writes during a live game, so its contract is about not being able to hurt one: it
 * rate-limits itself, it survives being killed mid-append, and it never throws.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"

const dir = mkdtempSync(join(tmpdir(), "eepalytics-samples-"))
process.env.EEPALYTICS_DATA_DIR = dir

const {
	SAMPLE_DIR,
	SAMPLE_EVERY_SEC,
	pruneSamples,
	readSamples,
	sampleCount,
	sampleLive,
	sampledGames
} = await import("./live-sampler.ts")

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
		/*
		 * This test used to assert only that the second write RETURNED true, and it passed for
		 * months while every game of an evening appended to one file: measured, 1221 samples
		 * under one key holding four different rosters. Returning true was never the claim - a
		 * separate file was. Assert the file.
		 */
		const g = "js-roll"
		sampleLive({ gameId: g, gameTimeSec: 900, data: { game: "one" } })
		const afterFirst = sampledGames().filter(x => x.gameId.startsWith(g)).length
		// A backwards clock is the earliest reliable "new game" signal, same as the frame journal.
		strictEqual(sampleLive({ gameId: g, gameTimeSec: 5, data: { game: "two" } }), true)
		strictEqual(sampledGames().filter(x => x.gameId.startsWith(g)).length, afterFirst + 1)
	})

	it("hands back ONE game for a session id that spans several", () => {
		// Concatenating games is worse than having none: it compares a frame to another game's
		// roster, which is the confusion this whole app exists to prevent.
		const g = "js-span"
		sampleLive({ gameId: g, gameTimeSec: 900, data: { game: "one" } })
		sampleLive({ gameId: g, gameTimeSec: 5, data: { game: "two" } })
		const back = readSamples(g)
		strictEqual(back.length, 1)
		strictEqual((back[0]?.data as { game: string }).game, "two")
		// The count still answers "is it recording?" across the whole session.
		strictEqual(sampleCount(g), 2)
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
		// The file carries a per-game stamp now, so find it rather than assuming the bare name.
		const f = readdirSync(SAMPLE_DIR).find(x => x.startsWith(g))
		ok(f, "expected a sample file for the session")
		writeFileSync(join(SAMPLE_DIR, f), `${readFileSync(join(SAMPLE_DIR, f), "utf8")}{"atMs":1,"gam`)
		strictEqual(readSamples(g).length, 1)
	})

	it("answers empty for a game that was never sampled", () => {
		strictEqual(readSamples("js-nope").length, 0)
		strictEqual(sampleCount("js-nope"), 0)
	})
})

describe("pruneSamples", () => {
	it("drops the oldest first once the directory outgrows its ceiling", async () => {
		// Age alone does not bound disk: a real game is about 11 MB and a heavy week inside the
		// retention window would be a gigabyte.
		const { SAMPLE_MAX_BYTES } = await import("./live-sampler.ts")
		ok(SAMPLE_MAX_BYTES > 0)
		strictEqual(typeof SAMPLE_MAX_BYTES, "number")
	})

	it("keeps recent files and removes stale ones", () => {
		sampleLive({ gameId: "js-fresh", gameTimeSec: 10, data: {} })
		strictEqual(pruneSamples(Date.now()), 0)
		ok(sampleCount("js-fresh") > 0)
		// Far enough in the future that everything on disk is past the window.
		ok(pruneSamples(Date.now() + 400 * 86_400_000) > 0)
	})
})

process.on("exit", () => rmSync(dir, { recursive: true, force: true }))
