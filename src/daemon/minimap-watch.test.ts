/**
 * The watcher's two testable halves: WHETHER a frame is read, and what a HISTORY is worth.
 *
 * Everything between them — the crop, the model call, the fence — is `readMinimap`, which is
 * imported rather than reimplemented and is measured by its own harnesses against real pictures.
 * What is new here is a dispatch that runs inside a live game every five seconds, and every way it
 * can go wrong is a way it can silently spend nothing or spend everything. So `admit` is pure and
 * pinned, and the stateful half is a counter over it.
 */

import { describe, it } from "node:test"
import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { WATCH_EVERY_SEC, admit, minimapDrift } from "./minimap-watch.ts"
import { MINIMAP_TIMEOUT_MS } from "../review/read-minimap.ts"
import type { WatchedRead } from "./minimap-watch.ts"
import type { FrameRead } from "../review/frame-read.ts"
import type { Zone } from "../shared/map.ts"

const NOW_MS = 1_700_000_000_000

const state = (over: Partial<Parameters<typeof admit>[0]> = {}): Parameters<typeof admit>[0] => ({
	enabled: true,
	inFlight: false,
	cooldownUntilMs: 0,
	lastReadSec: 100,
	sessionId: "js-a",
	...over
})

const frame = (tSec: number, sessionId = "js-a") => ({ tSec, sessionId })

describe("the beat", () => {
	it("cannot be outrun by a single read, so a wedged read costs one frame and not the game", () => {
		/*
		 * The floor is on the GAME clock and the timeouts are on the wall clock, which for a
		 * running game advance together. A read that could exceed the floor by more than a frame
		 * would leave `inFlight` true across the next beat as a matter of course, and the watcher
		 * would drop every other frame while looking like it was working.
		 */
		const worstReadMs = MINIMAP_TIMEOUT_MS + 1500
		strictEqual(worstReadMs <= (WATCH_EVERY_SEC + 1) * 1000, true)
	})

	it("sits below the journal's beat, so its JITTER does not pace a third of the frames out", () => {
		/*
		 * The browser's beat is five seconds and it wobbles: over the 340 frames of game
		 * 5639406342 the gap is p50 5.01s and p10 4.96s, and 117 of 339 gaps fall just UNDER five.
		 * A floor at the nominal beat refuses every one of those for being hundredths of a second
		 * early — measured, eleven points of present-tense coverage. See `WATCH_EVERY_SEC`.
		 */
		strictEqual(WATCH_EVERY_SEC < 4.96, true)
	})
})

describe("admit", () => {
	it("reads when the cadence floor has been cleared", () => {
		strictEqual(admit(state(), frame(100 + WATCH_EVERY_SEC), NOW_MS), "read")
	})

	it("paces on the GAME clock, so a paused game does not keep paying", () => {
		strictEqual(admit(state(), frame(100 + WATCH_EVERY_SEC - 0.5), NOW_MS), "paced")
	})

	it("drops a frame that arrives while a read is in flight rather than queueing it", () => {
		// The queue that is not a queue. The next frame is five seconds away and is a better
		// picture than the one that would have been waiting.
		strictEqual(admit(state({ inFlight: true }), frame(200), NOW_MS), "busy")
	})

	it("stays quiet while backing off, and speaks again the instant the backoff expires", () => {
		strictEqual(admit(state({ cooldownUntilMs: NOW_MS + 1 }), frame(200), NOW_MS), "cooldown")
		strictEqual(admit(state({ cooldownUntilMs: NOW_MS }), frame(200), NOW_MS), "read")
	})

	it("reads the first frame of a new session, whatever every other gate says", () => {
		/*
		 * The game boundary is above every gate, and this is the case that makes it matter: a
		 * 120-second rate-limit backoff started in game N would otherwise hold game N's last read
		 * in the track through the first two minutes of game N+1 — a position from a different
		 * game, gating a real objective call.
		 */
		const busyAndCooling = state({ inFlight: true, cooldownUntilMs: NOW_MS + 120_000 })
		strictEqual(admit(busyAndCooling, frame(3, "js-b"), NOW_MS), "new-game")
	})

	it("treats a clock that went backwards inside one session as a new game", () => {
		strictEqual(admit(state({ lastReadSec: 1600 }), frame(4), NOW_MS), "new-game")
	})

	it("is off when it is off, before anything else is considered", () => {
		strictEqual(admit(state({ enabled: false }), frame(9999, "js-z"), NOW_MS), "off")
	})

	it("does not read the same second twice", () => {
		strictEqual(admit(state({ lastReadSec: 100 }), frame(100), NOW_MS), "paced")
	})
})

const read = (you: Zone | null): FrameRead => ({
	enemiesOnMinimap: [],
	alliesOnMinimap: 0,
	you,
	activity: "unclear",
	youChampion: "Lillia"
})

const entry = (atSec: number, you: Zone | null): WatchedRead => ({
	read: read(you),
	// The point form of the same read. The centre of the map: this fixture is about the TRACK, not
	// about any distance, and a coordinate here would read as one.
	xy: {
		enemies: [],
		enemyZones: [],
		alliesOnMinimap: 0,
		you: you === null ? null : { x: 500, y: 500 },
		youZone: you,
		activity: "unclear",
		youChampion: "Lillia"
	},
	atSec,
	atMs: NOW_MS + atSec * 1000,
	ms: 1200,
	sessionId: "js-a"
})

describe("minimapDrift", () => {
	it("names the move across the window, which is what a second read buys", () => {
		deepStrictEqual(minimapDrift([entry(100, "OWN_JUNGLE_TOP"), entry(110, "DRAGON_PIT")], 112), {
			from: "topside",
			to: "botside",
			overSec: 10
		})
	})

	it("says nothing when he has not moved — standing still is not a direction", () => {
		strictEqual(
			minimapDrift([entry(100, "OWN_JUNGLE_TOP"), entry(110, "ENEMY_JUNGLE_TOP")], 112),
			null
		)
	})

	it("says nothing from one read, because one read is a point", () => {
		strictEqual(minimapDrift([entry(110, "DRAGON_PIT")], 112), null)
	})

	it("ignores reads that could not place him rather than treating them as a move", () => {
		strictEqual(minimapDrift([entry(100, null), entry(110, "DRAGON_PIT")], 112), null)
	})

	it("only looks inside the window, so an old half is not the start of a new vector", () => {
		// The measured curve is flat at a coin flip past thirty seconds. A vector drawn from a
		// coin flip to a fact is a coin flip.
		strictEqual(
			minimapDrift([entry(60, "OWN_JUNGLE_TOP"), entry(110, "DRAGON_PIT")], 112, 20),
			null
		)
	})
})
