/**
 * G5 idle continuity.
 *
 * This is the bug that meant replay capture had NEVER run. `IDLE_PHASES` is `["None", "Lobby"]`
 * and a client sitting untouched moves between the two; `notePhase` reset the streak on any
 * change, so the clock restarted every few seconds and the gate reported "only idle for 0s of
 * the required 120s" forever. Two callers feed it — the supervisor's poll and every gate
 * evaluation — sampling different instants, so they reset each other indefinitely.
 */

import { ok, strictEqual } from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"
import { idleForMs, isIdlePhase, notePhase, resetIdleTracking } from "./gate.ts"

beforeEach(() => resetIdleTracking())

describe("idle continuity", () => {
	it("counts from when the client entered idle", () => {
		notePhase("Lobby", 1_000)
		strictEqual(idleForMs(61_000), 60_000)
	})

	it("keeps counting across None <-> Lobby, which is the whole bug", () => {
		notePhase("None", 0)
		notePhase("Lobby", 5_000)
		notePhase("None", 10_000)
		notePhase("Lobby", 15_000)
		// Continuously idle since 0, not since the last flip.
		strictEqual(idleForMs(120_000), 120_000)
	})

	it("survives the two callers alternating on the same idle client", () => {
		// The supervisor sees None, the gate read sees Lobby, repeatedly.
		for (let t = 0; t < 100_000; t += 5_000) notePhase(t % 10_000 === 0 ? "None" : "Lobby", t)
		ok(idleForMs(100_000) >= 100_000, `expected a full streak, got ${idleForMs(100_000)}`)
	})

	it("voids the streak the moment the client stops being idle", () => {
		notePhase("Lobby", 0)
		notePhase("ChampSelect", 50_000)
		strictEqual(idleForMs(60_000), 0)
	})

	it("restarts the clock on returning to idle after a game", () => {
		notePhase("Lobby", 0)
		notePhase("InProgress", 10_000)
		notePhase("Lobby", 20_000)
		// 20s of idle, NOT the 20s that includes the game.
		strictEqual(idleForMs(30_000), 10_000)
	})

	it("treats an unreadable phase as not idle", () => {
		notePhase("Lobby", 0)
		notePhase(null, 10_000)
		strictEqual(idleForMs(20_000), 0)
		strictEqual(isIdlePhase(null), false)
	})

	it("does not let a queue dodge look like continuous idle", () => {
		// Lobby -> Matchmaking -> dodge back to Lobby must not carry the earlier streak.
		notePhase("Lobby", 0)
		notePhase("Matchmaking", 100_000)
		notePhase("Lobby", 101_000)
		strictEqual(idleForMs(102_000), 1_000)
	})
})

/**
 * G8 must not count the caller's own lease.
 *
 * The worker leases a capture job before running it, and the handler re-checks the gate
 * mid-flight. Without excluding itself the job read its own lease as "another capture already
 * holds the client" and settled having captured nothing — the second reason replay capture had
 * never completed a run.
 */
/**
 * The streak must survive a failed read.
 *
 * `readGateState` only calls `notePhase` when the snapshot was reachable. Before that, a
 * transient LCU hiccup produced a null phase, which is not idle, which wiped the clock — and
 * with two pollers running, capture sat at "only idle for 31s of the required 120s" forever.
 */
describe("transient read failures", () => {
	it("does not reset when the phase was never observed", () => {
		notePhase("Lobby", 0)
		// A failed read must NOT reach notePhase at all; simulate the call simply not happening.
		strictEqual(idleForMs(60_000), 60_000)
	})

	it("still resets when the client genuinely reports something else", () => {
		notePhase("Lobby", 0)
		notePhase("ChampSelect", 30_000)
		strictEqual(idleForMs(60_000), 0)
	})
})

describe("G8 self-exclusion", () => {
	const state = (otherIntrusiveRunning: boolean) => ({
		phase: "Lobby",
		isPlayingGame: false,
		isPlayingReplay: false,
		liveApiAnswering: false,
		idleForMs: 999_000,
		settings: { captureEnabled: true, idleGraceMs: 120_000 },
		otherIntrusiveRunning,
		roflOnDisk: true,
		reachable: true
	})

	it("opens when nothing else holds the client", async () => {
		const { evaluateGate } = await import("./gate.ts")
		const v = evaluateGate(state(false))
		ok(v.ok, `expected the gate to open, got: ${v.reason}`)
	})

	it("still refuses when a genuinely different capture is running", async () => {
		const { evaluateGate } = await import("./gate.ts")
		const v = evaluateGate(state(true))
		strictEqual(v.ok, false)
		ok(v.failed.includes("G8"))
	})
})
