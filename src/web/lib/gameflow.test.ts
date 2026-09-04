/**
 * The copy that keeps a persistent screen share from reading as a broken one.
 *
 * These are strings, and strings are usually not worth a test. This one is, because the whole
 * change it belongs to is "the share stays up between games" — and the state that creates, an
 * idle coach with no green dot and a frame count that has stopped moving, is indistinguishable
 * from a dead feature unless something on screen says otherwise. Every reachable state must
 * produce a line, and the armed state must produce none.
 */

import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { armedHeadline, standbyReason } from "./gameflow.ts"
import type { GameflowGate } from "./gameflow.ts"

const gate = (phase: string | null, armed: boolean, reachable = true): GameflowGate => ({
	phase,
	armed,
	inGame: phase === "InProgress" || phase === "Reconnect",
	reachable
})

describe("standbyReason", () => {
	it("says nothing while armed — silence there means the coach is live, not stuck", () => {
		for (const phase of ["ChampSelect", "GameStart", "InProgress", "Reconnect"])
			strictEqual(standbyReason(gate(phase, true)), null, phase)
	})

	it("explains every state where nothing is being sent", () => {
		for (const phase of [
			"None",
			"Lobby",
			"Matchmaking",
			"ReadyCheck",
			"WaitingForStats",
			"PreEndOfGame",
			"EndOfGame",
			"TerminatedInError"
		]) {
			const said = standbyReason(gate(phase, false))
			ok(said !== null && said.length > 0, phase)
		}
		// The League client being closed is its own state, not a fault.
		ok(standbyReason(gate(null, false)) !== null)
		// So is the daemon being unreachable, and it must not be confused with the above.
		ok(standbyReason(gate(null, false, false)) !== standbyReason(gate(null, false, true)))
	})

	it("tells him the share survived, in every idle state", () => {
		// This is the entire job of this text. He has just finished a game and is looking at a
		// silent panel; the question he has is "do I have to share my screen again?".
		for (const phase of [null, "None", "Lobby", "Matchmaking", "EndOfGame"]) {
			const said = standbyReason(gate(phase, false))
			ok(said !== null && /screen (is )?still shared|screen stays shared/.test(said), String(phase))
		}
	})

	it("never blames the player or reads as an error", () => {
		for (const phase of [null, "None", "Lobby", "Matchmaking", "EndOfGame"]) {
			const said = standbyReason(gate(phase, false)) ?? ""
			ok(!/error|failed|broken/i.test(said), said)
		}
	})
})

describe("armedHeadline", () => {
	it("names the phase :2999 cannot see", () => {
		strictEqual(armedHeadline(gate("ChampSelect", true)), "Champion select")
		strictEqual(armedHeadline(gate("GameStart", true)), "Loading into your game")
	})

	it("defers to the daemon's own reason when disarmed", () => {
		strictEqual(armedHeadline(gate("None", false)), null)
		strictEqual(armedHeadline(gate(null, false)), null)
	})
})
