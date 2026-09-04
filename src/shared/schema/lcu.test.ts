/**
 * The phase gate, pinned.
 *
 * `isCoachingPhase` decides what the browser is allowed to SEND — a wrong answer here uploads
 * someone's desktop, and that failure does not announce itself.
 *
 * There used to be a second predicate beside it, `isIdlePhase`, which decided what the daemon
 * was allowed to DO to the client. It guarded replay capture; capture is gone and so is it. The
 * two were near opposites, one line apart, which is why this file tested both together.
 */

import { strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { isCoachingPhase } from "./lcu.ts"

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
