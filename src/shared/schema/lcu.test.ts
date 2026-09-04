/**
 * The two phase gates, pinned.
 *
 * `isIdlePhase` guards the intrusive-job gate — what the daemon is allowed to DO to the client.
 * `isCoachingPhase` guards the live coach — what the browser is allowed to SEND. They are near
 * opposites and they are one line apart in the file, which is exactly why both are tested here:
 * getting them the wrong way round would either take over the client mid-game or upload someone's
 * desktop, and neither failure announces itself.
 */

import { strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { isCoachingPhase, isIdlePhase } from "./lcu.ts"

describe("isCoachingPhase", () => {
	it("arms from champion select through the game", () => {
		for (const phase of ["ChampSelect", "GameStart", "InProgress", "Reconnect"])
			strictEqual(isCoachingPhase(phase), true, phase)
	})

	it("stays disarmed before champion select", () => {
		// Queueing is not playing. Frames sent here are of his desktop, not of a game.
		for (const phase of ["None", "Lobby", "Matchmaking", "ReadyCheck", "CheckedIntoTournament"])
			strictEqual(isCoachingPhase(phase), false, phase)
	})

	it("disarms the moment the game ends, before the end-of-game screen", () => {
		// This is what closes the socket between two games in one session.
		for (const phase of ["WaitingForStats", "PreEndOfGame", "EndOfGame", "TerminatedInError"])
			strictEqual(isCoachingPhase(phase), false, phase)
	})

	it("fails closed on a closed client and on anything Riot adds later", () => {
		strictEqual(isCoachingPhase(null), false)
		strictEqual(isCoachingPhase(""), false)
		strictEqual(isCoachingPhase("SomePhaseFromAFuturePatch"), false)
		// Not a case-insensitive match: the client's own casing is the contract.
		strictEqual(isCoachingPhase("inprogress"), false)
	})
})

describe("isIdlePhase", () => {
	it("is not the inverse of isCoachingPhase", () => {
		// Both false in queue and at the end-of-game screen: the daemon may not take the client
		// over there, and the coach may not send there either.
		strictEqual(isIdlePhase("Matchmaking"), false)
		strictEqual(isCoachingPhase("Matchmaking"), false)
		strictEqual(isIdlePhase("EndOfGame"), false)
		strictEqual(isCoachingPhase("EndOfGame"), false)
	})

	it("still treats only None and Lobby as idle", () => {
		strictEqual(isIdlePhase("None"), true)
		strictEqual(isIdlePhase("Lobby"), true)
		strictEqual(isIdlePhase("ChampSelect"), false)
	})
})
