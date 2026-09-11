/**
 * `comparePairs`, the arithmetic that decides what the frame/no-frame ablation MEANS.
 *
 * The code under test is in `read-frame-ablation.ts`, the reader kept for the four stored runs
 * `scripts/e2e-real-game.ts` wrote before it was retired. This test came with it out of
 * `src/review/e2e-real-game.test.ts`, minus the cases that covered the run side — the fixture
 * loader, the checkpoint selector, the fence stripper — which went with the driver.
 *
 * Every case below is a defect that actually happened while the harness was built, not a
 * hypothetical: the control table joined on the attempt number and matched NOTHING, printing a
 * clean table of zeroes that read as "the frame changes nothing"; and the frame arm spelled its
 * numbers out ("two for zero") where the text arm wrote digits, so string comparison called a
 * paraphrase a difference in content.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { comparePairs } from "./read-frame-ablation.ts"
import type { TurnResult } from "./read-frame-ablation.ts"

const turn = (o: Partial<TurnResult> & { id: string }): TurnResult => ({
	tSec: 0,
	clock: "00:00",
	sampleLine: 1,
	arm: "no-frame",
	attempt: 1,
	frameSent: false,
	framePath: null,
	frameSkewSec: null,
	frameBytes: null,
	block: "B",
	blockMatchesFixture: true,
	facts: [],
	roster: [],
	provider: "mock",
	model: "echo",
	ok: true,
	text: "",
	latencyMs: 0,
	reason: null,
	silent: false,
	empty: false,
	subject: "other",
	score: null,
	...o
})

describe("comparePairs", () => {
	it("counts a pair where both stayed quiet, and does not call it agreement about a line", () => {
		const c = comparePairs([
			[turn({ id: "cp-1", silent: true }), turn({ id: "cp-1", silent: true, arm: "frame" })]
		])
		strictEqual(c.pairs, 1)
		strictEqual(c.bothQuiet, 1)
		strictEqual(c.bothSpoke, 0)
	})

	it("drops a pair where either turn FAILED — a provider error is not a difference between arms", () => {
		const c = comparePairs([
			[turn({ id: "cp-1", ok: false, reason: "429" }), turn({ id: "cp-1", text: "hi" })]
		])
		strictEqual(c.pairs, 0)
	})

	/*
	 * The measurement that motivates the whole helper. On the first real run the frame arm said
	 * "That fight was two for zero without you" and the text arm "Your team won that fight 2 for 0
	 * without you" — the same fact, the same figures, off the same single ranked fact. Word-for-word
	 * comparison called that a difference; `numbersIn` normalises the spoken numerals, so it does
	 * not.
	 */
	it("does not call a paraphrase of the same figures a difference in content", () => {
		const c = comparePairs([
			[
				turn({ id: "cp-1", arm: "frame", subject: "fight", text: "Kayn is twenty three CS up on you" }),
				turn({ id: "cp-1", subject: "fight", text: "Kayn is 23 CS up on you." })
			]
		])
		strictEqual(c.bothSpoke, 1)
		strictEqual(c.identical, 0)
		strictEqual(c.sameNumbers, 1)
		strictEqual(c.contentDiffered, 0)
	})

	it("counts a genuinely different claim as a difference in content", () => {
		const c = comparePairs([
			[
				turn({ id: "cp-1", arm: "frame", subject: "gold", text: "You are sitting on 1400 gold" }),
				turn({ id: "cp-1", subject: "farm", text: "You are on 62 CS" })
			]
		])
		strictEqual(c.contentDiffered, 1)
		strictEqual(c.sameNumbers, 0)
		strictEqual(c.sameSubject, 0)
	})

	it("attributes a lone line to the arm that spoke it", () => {
		const c = comparePairs([
			[turn({ id: "cp-1", arm: "frame", text: "look out" }), turn({ id: "cp-1", silent: true })]
		])
		strictEqual(c.oneSpoke, 1)
		strictEqual(c.onlyFirstSpoke, 1)
	})
})
