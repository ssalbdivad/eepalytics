/**
 * The gate is the rule that makes background operation safe, so it is the one piece of the
 * daemon that gets tested exhaustively: every rule denies on its own, and the whole thing
 * fails CLOSED on anything unexpected.
 *
 * `evaluateGate` is pure, which is exactly why it was written that way — none of this needs a
 * League client, a bridge, or a database.
 *
 * Run: pnpm test
 */

import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { evaluateGate, isIdlePhase } from "./gate.ts"
import type { GateState } from "./gate.ts"

/** The one state in which an intrusive capture is allowed. Every case below mutates it. */
const allowed = (): GateState => ({
	phase: "None",
	isPlayingGame: false,
	isPlayingReplay: false,
	liveApiAnswering: false,
	idleForMs: 300_000,
	settings: { captureEnabled: true, idleGraceMs: 120_000 },
	otherIntrusiveRunning: false,
	roflOnDisk: true,
	reachable: true
})

describe("isIdlePhase", () => {
	it("allows only None and Lobby", () => {
		assert.equal(isIdlePhase("None"), true)
		assert.equal(isIdlePhase("Lobby"), true)
		for (const busy of [
			"Matchmaking",
			"ReadyCheck",
			"ChampSelect",
			"GameStart",
			"InProgress",
			"Reconnect",
			"WaitingForStats",
			"PreEndOfGame",
			"EndOfGame"
		])
			assert.equal(isIdlePhase(busy), false, `${busy} must not count as idle`)
	})

	it("treats an unknown phase as busy, so a new Riot phase fails closed", () => {
		assert.equal(isIdlePhase("SomePhaseRiotAddedInPatch1720"), false)
		assert.equal(isIdlePhase(null), false)
	})
})

describe("evaluateGate", () => {
	it("allows a fully idle client with the replay on disk", () => {
		const v = evaluateGate(allowed())
		assert.equal(v.ok, true)
		assert.deepEqual(v.failed, [])
	})

	it("G1: denies any non-idle phase", () => {
		const v = evaluateGate({ ...allowed(), phase: "ChampSelect" })
		assert.equal(v.ok, false)
		assert.ok(v.failed.includes("G1"))
		assert.match(v.reason, /ChampSelect/)
	})

	it("G2: denies while a game is in progress", () => {
		const v = evaluateGate({ ...allowed(), isPlayingGame: true })
		assert.equal(v.ok, false)
		assert.ok(v.failed.includes("G2"))
	})

	it("G3: denies while a replay is already playing", () => {
		const v = evaluateGate({ ...allowed(), isPlayingReplay: true })
		assert.ok(v.failed.includes("G3"))
	})

	it("G4: denies when port 2999 answers, even if every other signal says idle", () => {
		// Belt and braces: the in-game API only answers while something is actually running,
		// so this catches a stale gameflow phase.
		const v = evaluateGate({ ...allowed(), liveApiAnswering: true })
		assert.ok(v.failed.includes("G4"))
	})

	it("G5: requires CONTINUOUS idleness, not a single idle sample", () => {
		const v = evaluateGate({ ...allowed(), idleForMs: 5_000 })
		assert.equal(v.ok, false)
		assert.ok(v.failed.includes("G5"))
		assert.match(v.reason, /only idle for 5s of the required 120s/)
		// And it asks again just as the grace period expires, not a minute later.
		assert.ok(v.retryAfterMs <= 115_000 && v.retryAfterMs > 0)
	})

	it("G6: denies when capture is switched off, whatever the client is doing", () => {
		const v = evaluateGate({
			...allowed(),
			settings: { captureEnabled: false, idleGraceMs: 120_000 }
		})
		assert.equal(v.ok, false)
		assert.ok(v.failed.includes("G6"))
		// Nothing will change for a while — do not re-ask every minute.
		assert.equal(v.retryAfterMs, 30 * 60 * 1000)
	})

	it("G8: denies while another capture holds the client", () => {
		const v = evaluateGate({ ...allowed(), otherIntrusiveRunning: true })
		assert.ok(v.failed.includes("G8"))
	})

	it("G9: denies when the .rofl is not on disk", () => {
		const v = evaluateGate({ ...allowed(), roflOnDisk: false })
		assert.ok(v.failed.includes("G9"))
	})

	it("denies when the client is unreachable, and says so plainly", () => {
		const v = evaluateGate({ ...allowed(), reachable: false })
		assert.equal(v.ok, false)
		assert.match(v.reason, /League client is not running/)
	})

	it("reports every failing rule at once, so the UI can explain itself fully", () => {
		const v = evaluateGate({
			...allowed(),
			phase: "InProgress",
			isPlayingGame: true,
			liveApiAnswering: true,
			roflOnDisk: false
		})
		assert.equal(v.ok, false)
		for (const rule of ["G1", "G2", "G4", "G9"]) assert.ok(v.failed.includes(rule), rule)
	})

	it("never returns an empty reason when it denies", () => {
		const states: GateState[] = [
			{ ...allowed(), phase: "InProgress" },
			{ ...allowed(), reachable: false },
			{ ...allowed(), roflOnDisk: false },
			{ ...allowed(), settings: { captureEnabled: false, idleGraceMs: 0 } }
		]
		for (const s of states) {
			const v = evaluateGate(s)
			assert.equal(v.ok, false)
			assert.ok(v.reason.length > 0)
			assert.ok(v.retryAfterMs > 0)
		}
	})
})
