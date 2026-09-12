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
	it("has a ceiling, and it is the only bound left", async () => {
		const mod = await import("./live-sampler.ts")
		ok(mod.SAMPLE_MAX_BYTES > 0)
		strictEqual(typeof mod.SAMPLE_MAX_BYTES, "number")
		/*
		 * THE AGE BOUND IS GONE AND MUST STAY GONE. Asserting its absence is not pedantry: it was
		 * removed because it had already destroyed one corpus and was thirteen hours from
		 * destroying six more games, and the obvious "fix" for a full disk is to put it back.
		 * Whoever does should have to delete this line and read why first.
		 */
		strictEqual(
			(mod as Record<string, unknown>).SAMPLE_KEEP_DAYS,
			undefined,
			"an age bound on this directory deletes evidence; size is the bound — see live-sampler.ts"
		)
	})

	it("keeps every game when the directory is under the ceiling, however old", () => {
		sampleLive({ gameId: "js-fresh", gameTimeSec: 10, data: {} })
		// The default ceiling is 600 MB and this directory holds a few bytes, so nothing goes.
		strictEqual(pruneSamples(), 0)
		ok(sampleCount("js-fresh") > 0)
		/*
		 * And age genuinely cannot evict any more. Before this change the same call with a clock
		 * 400 days ahead deleted the lot; there is no clock in the signature to move now, and a
		 * roomy ceiling keeps everything no matter what the mtimes say.
		 */
		strictEqual(pruneSamples(), 0)
		ok(sampleCount("js-fresh") > 0)
	})

	it("drops the oldest first, and only once the ceiling is actually crossed", () => {
		const before = readdirSync(SAMPLE_DIR).filter(f => /-t\d+\.ndjson$/.test(f))
		ok(before.length >= 2, "need at least two recorder files to order an eviction")
		// A ceiling of one byte is below any real directory, so everything the prune MAY take, it
		// takes — which is the set this asserts, not the ordering's cutoff.
		const gone = pruneSamples(1)
		ok(gone > 0, "a ceiling under the directory size must evict something")
		const left = readdirSync(SAMPLE_DIR).filter(f => /-t\d+\.ndjson$/.test(f))
		strictEqual(left.length, 0, "every recorder file is fair game under a one-byte ceiling")
	})

	it("never deletes a file the recorder did not write, at any size", () => {
		/*
		 * A real loss, not a hypothetical. `split-01..04.ndjson` and the multi-game capture they
		 * were cut from sat in this directory as the paired evaluation corpus; a daemon restart
		 * on 2026-09-12 aged all five out and no copy existed anywhere else. The recorder's own
		 * files always carry the `-t<stamp>` game key, so that pattern is the whole permission.
		 *
		 * That guard covered only what a human had placed, which on the same day was measured to
		 * be the smaller half of the problem — the recorder's own files ARE the corpus now. The
		 * age bound is gone for that reason; this test pins the half that survives it.
		 */
		writeFileSync(`${SAMPLE_DIR}/split-03.ndjson`, '{"gameTime":1}\n')
		writeFileSync(`${SAMPLE_DIR}/notes.md`, "hand written\n")
		sampleLive({ gameId: "js-doomed", gameTimeSec: 10, data: {} })

		// A one-byte ceiling: past every bound the prune still has.
		pruneSamples(1)

		const left = readdirSync(SAMPLE_DIR)
		ok(left.includes("split-03.ndjson"), "a hand-placed fixture must survive the prune")
		ok(left.includes("notes.md"), "a non-sample file must survive the prune")
		ok(
			!left.some(f => /^js-doomed-t\d+\.ndjson$/.test(f)),
			"the recorder's own file must still be evictable on size"
		)
	})
})

process.on("exit", () => rmSync(dir, { recursive: true, force: true }))
