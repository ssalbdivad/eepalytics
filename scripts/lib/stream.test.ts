/**
 * The pure half of the join, tested without the database, the disk or the network.
 *
 * What is worth testing here is not "does it run" — a driver answers that in four seconds — but the
 * four decisions that are INVISIBLE in a report when they are wrong. Every case below is a defect
 * that actually happened or was one edit away:
 *
 *   - a `cut.length > 1` suppression, meant to reject a file holding several GAMES, deleted the Gwen
 *     window instead: that file is one game cut in two by 80 seconds of loading screen. It removed
 *     the entire second arm of the benchmark, and the run that lost it still printed a clean table.
 *   - a median that averages the two middle values reports 1265ms where the window census reports
 *     1339ms. Both are "the median skew". Only one of them matches the recon this is built on.
 *   - a cadence that advances from the REQUESTED second rather than the second actually taken
 *     drifts a whole turn behind on a stream whose samples land every five seconds.
 *   - a frame path that "exists" is not a frame: 503 of 1876 rows point under the repo's former
 *     name, and a harness that trusts `existsSync` evaluates a text-only coach while reporting a
 *     vision one.
 *
 * `pnpm test` runs this: the script's globs are `src/**\/*.test.ts` AND `scripts/**\/*.test.ts`,
 * widened in the same change that added this file. Run it alone when that is faster:
 *
 *     node --experimental-strip-types --no-warnings=ExperimentalWarning --test scripts/lib/stream.test.ts
 */

import { test } from "node:test"
import { readVerbatim } from "../e2e-real-game.ts"
import assert from "node:assert/strict"
import {
	CLOCK_BACK_TOLERANCE_SEC,
	clockText,
	jpegSize,
	pickEventCheckpoints,
	median,
	nearestSample,
	pickCheckpoints,
	rebaseFramePath,
	resolveGame,
	segment,
	WALL_GAP_MS,
	buildStream,
	discoverWindows
} from "./stream.ts"
import { protocolFor } from "../bench-stream.ts"
import type { Arm } from "../bench-stream.ts"

/* ==================================================================== median */

test("median is the upper-middle observation, never an average of two", () => {
	// The convention the window census used. Averaging would give 3 here and 1265ms on the real
	// window where the census reports 1339ms.
	assert.equal(median([1, 2, 4, 8]), 4)
	assert.equal(median([5, 1, 3]), 3)
	assert.equal(median([]), 0)
})

test("clockText matches the block's own m:ss, unpadded minutes", () => {
	assert.equal(clockText(7.43), "0:07")
	assert.equal(clockText(403.36), "6:43")
	assert.equal(clockText(2210), "36:50")
})

/* =================================================================== segment */

const rows = (xs: [number, number][]): { atMs: number; t: number }[] =>
	xs.map(([atMs, t]) => ({ atMs, t }))
const cut = (xs: [number, number][]): number[][] =>
	segment(
		rows(xs),
		r => r.atMs,
		r => r.t
	).map(run => run.map(r => r.t))

test("a backwards game clock is a new game", () => {
	assert.deepEqual(
		cut([
			[0, 100],
			[5000, 105],
			[10_000, 0],
			[15_000, 5]
		]),
		[[100, 105], [0, 5]]
	)
})

test("a slow poll does not split one game", () => {
	// Within the tolerance: the clock read a shade early and then a shade late. One game.
	assert.deepEqual(
		cut([
			[0, 100],
			[5000, 100 - CLOCK_BACK_TOLERANCE_SEC + 0.5]
		]).length,
		1
	)
})

test("a long wall gap is him sitting on his desktop between two games", () => {
	assert.deepEqual(
		cut([
			[0, 10],
			[WALL_GAP_MS + 1, 20]
		]).length,
		2
	)
})

test("one game cut in two by the loading screen is still two SEGMENTS — the caller rejoins them", () => {
	/*
	 * This is the Gwen file's exact shape: one line at gameTime 0, then 80 seconds of wall clock,
	 * then the game proper from gameTime 5. The cut is correct and must stay; what must not happen
	 * is the file being suppressed because it produced two segments, since both resolve to the same
	 * game. `discoverWindows` rejoins on the GAME id, not the segment count.
	 */
	assert.deepEqual(
		cut([
			[0, 0],
			[80_000, 5],
			[85_000, 10]
		]),
		[[0], [5, 10]]
	)
})

test("an empty stream segments into nothing rather than one empty run", () => {
	assert.deepEqual(cut([]), [])
})

/* =============================================================== resolveGame */

const game = (gameId: string, gameCreationMs: number) => ({
	gameId,
	gameCreationMs,
	gameDurationSec: 2000,
	championName: "Lillia"
})

test("a run belongs to the game whose creation is nearest the instant its clock read zero", () => {
	const games = [game("A", 1_000_000), game("B", 3_000_000)]
	// 60s of loading screen sits between gameCreationMs and the clock reaching zero. Observed gaps
	// across all eleven real runs are 16s to 95s.
	assert.equal(resolveGame(1_060_000, games)?.gameId, "A")
	assert.equal(resolveGame(3_030_000, games)?.gameId, "B")
})

test("a run further than the start gap from every game is unmatched, never given to its nearest", () => {
	assert.equal(resolveGame(9_000_000, [game("A", 1_000_000)]), null)
	assert.equal(resolveGame(1_000_000, []), null)
})

/* ============================================================= nearestSample */

const samples = (ats: number[]) => ats.map((atMs, i) => ({ line: i + 1, atMs, gameTime: i * 5, data: {} }))

test("the nearest sample wins, and its 1-based line comes back with it", () => {
	const hit = nearestSample(10_400, samples([0, 5000, 10_000, 15_000]), 3000)
	assert.equal(hit?.sample.line, 3)
	assert.equal(hit?.skewMs, 400)
})

test("a pairing worse than the skew is REFUSED, not returned as the best available", () => {
	// The defect this whole module exists to remove: a frame of a different moment, scored as if it
	// were of this one. `bench-providers` did exactly this and scored a frame-reading model worse
	// than a frame-ignoring one.
	assert.equal(nearestSample(20_000, samples([0, 5000, 10_000]), 3000), null)
	assert.equal(nearestSample(0, [], 3000), null)
})

/* ============================================================ pickCheckpoints */

test("the cadence advances from the second actually taken, not the one requested", () => {
	// Samples every 5s, asked for one every 30s. Taking 0, 30, 60 would require samples at exactly
	// those seconds; what exists is 30 and 60. The drift this guards against is subtle: advancing
	// from the REQUEST would take 0, 30, 60 here but 0, 32, 62 on a stream whose samples sit at odd
	// seconds, and by turn ten it is a whole turn behind.
	const at = [0, 5, 10, 15, 20, 25, 31, 35, 40, 45, 50, 55, 62]
	assert.deepEqual(
		pickCheckpoints(at, { everySec: 30, fromSec: 0, turns: 3 }).map(i => at[i]),
		[0, 31, 62]
	)
})

test("fromSec skips the head of the game and turns caps the tail", () => {
	const at = [0, 10, 20, 30, 40, 50]
	assert.deepEqual(
		pickCheckpoints(at, { everySec: 10, fromSec: 20, turns: 2 }).map(i => at[i]),
		[20, 30]
	)
	assert.deepEqual(pickCheckpoints(at, { everySec: 10, fromSec: 999, turns: 5 }), [])
	assert.deepEqual(pickCheckpoints([], { everySec: 10, fromSec: 0, turns: 5 }), [])
})

/* ========================================================== rebaseFramePath */

test("a stored path under the repo's FORMER name is rebased onto this checkout", () => {
	// /home/ssalb/coachskaffur does not exist; 503 of 1876 rows point there.
	assert.equal(
		rebaseFramePath(
			"/home/ssalb/coachskaffur/data/journal/js-mtn2jrku-8ae9/js-mtn2jrku-8ae9-0.jpg",
			"js-mtn2jrku-8ae9",
			"/nowhere/data"
		),
		"/nowhere/data/journal/js-mtn2jrku-8ae9/js-mtn2jrku-8ae9-0.jpg"
	)
})

test("a path that resolves is left exactly as it was", () => {
	// Rows written after the rename are already right, and rewriting them would be a second guess.
	const self = new URL(import.meta.url).pathname
	assert.equal(rebaseFramePath(self, "whatever", "/nowhere/data"), self)
})

/* ================================================================== jpegSize */

/** The smallest thing that is genuinely a JPEG header: SOI, then a baseline SOF0 of 864x1536. */
const sof0 = (width: number, height: number): Buffer =>
	Buffer.concat([
		Buffer.from([0xff, 0xd8]),
		Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
		Buffer.from([(height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff]),
		Buffer.alloc(6)
	])

test("a JPEG header yields its real dimensions", () => {
	assert.deepEqual(jpegSize(sof0(1536, 864)), { width: 1536, height: 864 })
})

test("a JPEG with a segment before the SOF is still read", () => {
	const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x06, 0, 0, 0, 0])
	const buf = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0(1536, 864).subarray(2)])
	assert.deepEqual(jpegSize(buf), { width: 1536, height: 864 })
})

test("anything that is not a JPEG is null — a frame is EXCLUDED, never assumed present", () => {
	assert.equal(jpegSize(Buffer.from("not an image at all")), null)
	assert.equal(jpegSize(Buffer.alloc(0)), null)
	// SOI and then straight into a scan: no SOF, so no dimensions, so no claim.
	assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02])), null)
})

/* ============================================ the trusted delta protocol */

/**
 * The bench must send what the app sends, and the app stopped sending the full brief every turn.
 *
 * `routes/live.ts` opens a sequence with `buildBrief` and follows it with `buildDelta`s carrying
 * the coach's own spoken lines. A bench that sent twelve full briefs would be benchmarking the
 * architecture that was replaced — which it silently did until this test existed, and every line
 * such a run produced is evidence about nothing. These assertions are the SHAPE of the protocol,
 * never its wording: how many full briefs go out, that a delta is smaller than the brief that
 * opened the sequence, and that a line the arm actually said comes back in the next payload.
 *
 * Skipped when the corpus holds no `split-03`, because these read real samples off disk rather
 * than a fixture — a fixture of a payload is a payload nobody sent.
 */
const armOf = (mode: Arm["mode"]): Arm => ({
	id: "t",
	provider: "mock",
	model: "",
	mode,
	shape: "turn",
	vision: false,
	available: true,
	unavailable: ""
})
const splitO3 = () => discoverWindows().find(w => w.id === "split-03") ?? null

test("the trusted protocol opens with one full brief and sends deltas after it", () => {
	const w = splitO3()
	if (!w) return
	const stream = buildStream(w, { everySec: 30, fromSec: 0, turns: 4, requireFrame: true })
	const proto = protocolFor(armOf("trusted"), stream)
	const kinds: string[] = []
	let opening = 0
	for (const [n, t] of stream.turns.entries()) {
		const sent = proto.payload(t)
		kinds.push(sent.kind)
		if (n === 0) opening = sent.text.length
		else
			assert.ok(
				sent.text.length < opening,
				`turn ${n} sent ${sent.text.length} chars, not less than the opening brief's ${opening}`
			)
		proto.heard(t, `line ${n} about the raptors`, 800)
	}
	assert.equal(kinds[0], "brief")
	// Every checkpoint within RESYNC_AFTER_SEC of the last one is a delta. A wider cadence
	// legitimately resyncs, which is why the run PRINTS the count rather than assuming it.
	assert.deepEqual(kinds.slice(1), ["delta", "delta", "delta"])
})

test("the trusted protocol puts what the arm SAID into the next payload", () => {
	const w = splitO3()
	if (!w) return
	const stream = buildStream(w, { everySec: 30, fromSec: 0, turns: 3, requireFrame: true })
	const proto = protocolFor(armOf("trusted"), stream)
	proto.payload(stream.turns[0]!)
	proto.heard(stream.turns[0]!, "Kite the blue toward gromp", 900)
	const second = proto.payload(stream.turns[1]!)
	assert.match(second.text, /ALREADY SAID/)
	assert.match(second.text, /Kite the blue toward gromp/)
})

test("a silence is never logged as advice, because it advised nothing", () => {
	const w = splitO3()
	if (!w) return
	const stream = buildStream(w, { everySec: 30, fromSec: 0, turns: 3, requireFrame: true })
	const proto = protocolFor(armOf("trusted"), stream)
	proto.payload(stream.turns[0]!)
	proto.heard(stream.turns[0]!, "PASS", 700)
	const second = proto.payload(stream.turns[1]!)
	assert.ok(!second.text.includes("PASS"), "a PASS reached the ALREADY SAID section")
})

test("a non-trusted arm still gets the ranked block, unchanged", () => {
	const w = splitO3()
	if (!w) return
	const stream = buildStream(w, { everySec: 30, fromSec: 0, turns: 2, requireFrame: true })
	const proto = protocolFor(armOf("cite-or-quiet"), stream)
	const sent = proto.payload(stream.turns[0]!)
	assert.equal(sent.kind, "block")
	assert.equal(sent.text, stream.turns[0]!.block)
})

/* ================================================== the event schedule */

/*
 * `pickEventCheckpoints` is the bench's half of the thing that replaced the timer, and the two
 * failures below are the ones that would leave a run LOOKING right.
 *
 * The graded game 5639406342 is on disk, so these are pinned against the real file rather than a
 * fixture: a fixture of an event stream is a fixture of the answer.
 */
const kaynGame = () =>
	discoverWindows().find(w => w.id === "js-mtvxb5f4-f81a-t29817812") ?? null

const rowsOf = (w: NonNullable<ReturnType<typeof kaynGame>>) =>
	readVerbatim(w.sampleFile).map(r => ({ line: r.line, gameTime: r.gameTime, data: r.data }))

test("the detector is stepped over EVERY sample, not only the turns it raises", () => {
	const w = kaynGame()
	if (!w) return
	const rows = rowsOf(w)
	const all = pickEventCheckpoints(rows)
	// Stepping only every fifth sample diffs across four-sample holes: fired-once keys land on the
	// wrong tick, the fight cluster never closes at its own quiet point, and the counterpart's
	// absence clock jumps. The counts must therefore NOT agree — if they did, the detector would be
	// stateless and the whole EventWatch would be decoration.
	const sparse = pickEventCheckpoints(rows.filter((_, i) => i % 5 === 0))
	assert.notDeepEqual(
		all.map(t => t.atSec),
		sparse.map(t => t.atSec)
	)
})

test("stride subsamples the questions and never the events", () => {
	const w = kaynGame()
	if (!w) return
	const rows = rowsOf(w)
	const all = pickEventCheckpoints(rows)
	const strided = pickEventCheckpoints(rows, { stride: 3 })
	// Same turns raised, same clocks, same reasons — stride only marks which ones a run pays for.
	// A stride that CHANGED the schedule would mean the bench measured a coach asked at different
	// moments than the app asks at, which is the defect this flag is one edit away from being.
	assert.deepEqual(
		all.map(t => t.atSec),
		strided.map(t => t.atSec)
	)
	assert.deepEqual(
		all.map(t => t.why),
		strided.map(t => t.why)
	)
	const sent = strided.filter(t => !t.skipped)
	assert.ok(sent.length > 0 && sent.length < all.length, `stride 3 kept ${sent.length} of ${all.length}`)
})

test("a reactive turn does not pay for the minimap read", () => {
	const w = kaynGame()
	if (!w) return
	const turns = pickEventCheckpoints(rowsOf(w))
	// The read costs 1.3-3.0s. Any turn carrying a death, a respawn or a resource threshold must
	// decline it, or the line lands after the moment it is about.
	for (const t of turns)
		if (t.kinds.some(k => k.startsWith("death.") || k.startsWith("respawn.") || k === "resource.low"))
			assert.equal(t.readMinimap, false, `${t.why} at ${t.atSec}s asked for the read`)
})

/*
 * THE COUNT ITSELF, because it is the one number that says the schedule is still a schedule.
 *
 * `dueTurn` peeks and `commitTurn` spends — a split made so a send that fails does not throw the
 * events away and reset the silence floor. A caller that forgets to commit never advances
 * `lastTurnAtSec`, so every subsequent tick answers "due" and the detector degrades into the
 * per-sample timer it replaced. It is silent: the run still completes, the payloads are still
 * right, and only the turn count moves. It happened to this file, and the tell was 279 turns on a
 * 28-minute game where the module's own doc says sixty-seven.
 *
 * A wide range on purpose. The exact figure moves with the detector's rules, and pinning it would
 * make every future rule change look like a regression. What must never happen is one turn per
 * sample, and the recorded game has 279 of those.
 */
test("the event schedule asks tens of times in a game, not once per sample", () => {
	const w = kaynGame()
	if (!w) return
	const rows = rowsOf(w)
	const turns = pickEventCheckpoints(rows)
	assert.ok(turns.length > 20, `only ${turns.length} turns in 28 minutes — the detector fired almost never`)
	assert.ok(
		turns.length < rows.length / 2,
		`${turns.length} turns from ${rows.length} samples — the schedule has degraded into a per-sample timer, which is what happens when a caller of dueTurn forgets commitTurn`
	)
})
