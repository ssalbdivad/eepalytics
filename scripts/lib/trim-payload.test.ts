/**
 * What a CUT arm must and must not be.
 *
 * An ablation is only an ablation if the arms differ by exactly one thing. Two ways that quietly
 * stops being true, both pinned here:
 *
 * 1. A cut that changes the payload's STRUCTURE as well as its content. When nothing is recent, an
 *    empty EVENT LOG must still be a section with a header saying so — a section that vanishes is a
 *    second difference and the comparison stops meaning anything.
 * 2. A cut that takes more than it says. Every preset names its sections, and the control path
 *    (`null`) must return the bytes untouched, so the shipped arm and the app go through the same
 *    call.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { TRIMS, eventAgeSec, trimPayload } from "./trim-payload.ts"

const PAYLOAD = [
	"NOW\n3:01. YOU ARE ALIVE.",
	"JOINS — computed here so you do not have to derive them\n- Kill participation: you are in 0 of your team's 2 kills (0%).\n- Last fight 2:50-2:50 (11s ago): 1 for you, 1 for them.",
	"EVENT LOG, newest first. Every line carries the game clock it happened at and how long ago that was.\n- 2:50 (11s ago) Mordekaiser killed Olaf\n- 1:38 (1m23s ago) Olaf killed Mordekaiser\n- 0:30 (9m31s ago) first blood to Olaf",
	"THE GAME SO FAR (accumulated, not a fresh reading)\nYou are Lillia, level 3.",
	"OBJECTIVES\nDrakes YOUR team: none",
	"HIS OWN BASELINES\nCS per minute: his own average is 6.7 over 20 games"
].join("\n\n")

describe("eventAgeSec", () => {
	it("reads both shapes the log writes", () => {
		assert.equal(eventAgeSec("- 2:50 (11s ago) Mordekaiser killed Olaf"), 11)
		assert.equal(eventAgeSec("- 1:38 (1m23s ago) Olaf killed Mordekaiser"), 83)
	})
	it("returns null for anything that is not an event line", () => {
		assert.equal(eventAgeSec("EVENT LOG, newest first."), null)
		assert.equal(eventAgeSec("- nothing has happened yet this game"), null)
	})
})

describe("trimPayload", () => {
	it("returns the bytes untouched with no trim, so control and shipped agree", () => {
		assert.equal(trimPayload(PAYLOAD, null), PAYLOAD)
	})

	it("cut-log keeps the recent half and drops the rest", () => {
		const out = trimPayload(PAYLOAD, TRIMS.log!)
		assert.ok(out.includes("- 2:50 (11s ago)"))
		assert.ok(out.includes("- 1:38 (1m23s ago)"))
		assert.ok(!out.includes("- 0:30 (9m31s ago)"))
		// and nothing else moved
		assert.ok(out.includes("HIS OWN BASELINES"))
		assert.ok(out.includes("Kill participation"))
	})

	it("cut-log leaves a headed section behind when nothing is recent", () => {
		const old = "EVENT LOG, newest first.\n- 0:30 (9m31s ago) first blood to Olaf"
		const out = trimPayload(old, TRIMS.log!)
		assert.ok(out.startsWith("EVENT LOG, newest first."))
		assert.ok(out.includes("nothing in the last 3 minutes"))
	})

	it("cut-dead removes exactly the three things it names", () => {
		const out = trimPayload(PAYLOAD, TRIMS.dead!)
		assert.ok(!out.includes("HIS OWN BASELINES"))
		assert.ok(!out.includes("THE GAME SO FAR"))
		assert.ok(!out.includes("Kill participation"))
		// the OTHER half of JOINS survives, header and all
		assert.ok(out.includes("JOINS — computed here"))
		assert.ok(out.includes("Last fight 2:50-2:50"))
		// and the log is whole
		assert.ok(out.includes("- 0:30 (9m31s ago)"))
	})

	it("cut-both is the two of them and nothing more", () => {
		const out = trimPayload(PAYLOAD, TRIMS.both!)
		assert.ok(!out.includes("HIS OWN BASELINES"))
		assert.ok(!out.includes("- 0:30 (9m31s ago)"))
		assert.ok(out.includes("NOW"))
		assert.ok(out.includes("OBJECTIVES"))
	})

	it("drops JOINS entirely only when nothing is left in it", () => {
		const only = "JOINS — computed here\n- Kill participation: you are in 0 of 2."
		assert.equal(trimPayload(only, TRIMS.dead!), "")
	})
})
