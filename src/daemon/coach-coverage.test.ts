/**
 * The four things "the coach said nothing" can mean.
 *
 * ## Why this test exists
 *
 * On 2026-09-18 the transcript file had not been appended to since the 10th, over five games and
 * eight days, and nothing on the machine could say which of four situations that was. The whole
 * value of `judgeCoverage` is that it refuses to collapse them, so the test is the four cases and
 * the one distinction that actually decides what a person does next: frames WITHOUT lines is the
 * only outcome where the product was demonstrably in front of him and produced nothing.
 *
 * It is a pure function of two integers on purpose. A coverage check that needed a game, a socket
 * and a disk to exercise would be tested the day it was written and never again.
 *
 * Run: pnpm test
 */

import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { judgeCoverage } from "./coach-coverage.ts"

describe("judgeCoverage", () => {
	it("frames and lines is the coach working", () => {
		assert.equal(judgeCoverage({ frames: 300, lines: 9 }).verdict, "coached")
	})

	it("FRAMES WITH NO LINES is the one that is our fault", () => {
		const got = judgeCoverage({ frames: 300, lines: 0 })
		assert.equal(got.verdict, "heard-nothing")
		/*
		 * The share was up, so the page was open, the gate was armed and every frame reached the
		 * daemon — and he still heard nothing all game. A socket that cannot be opened (an expired
		 * key, a depleted prepaid balance, a model id the endpoint refuses) looks exactly like
		 * this, and so does a coach that PASSed every turn. Both are worth a person's attention;
		 * neither is "he did not use it".
		 */
		assert.match(got.note, /NOT ONE LINE/)
	})

	it("lines with no frames is a coach running without a picture, which is not fatal", () => {
		assert.equal(judgeCoverage({ frames: 0, lines: 12 }).verdict, "unwatched")
	})

	it("neither is the coach never having started, and it must not read as a failure of the coach", () => {
		const got = judgeCoverage({ frames: 0, lines: 0 })
		assert.equal(got.verdict, "absent")
		assert.match(got.note, /not open, not sharing, or could not start/)
	})

	it("every verdict carries its own counts, so a log line is readable without the record", () => {
		assert.match(judgeCoverage({ frames: 300, lines: 9 }).note, /9/)
		assert.match(judgeCoverage({ frames: 300, lines: 0 }).note, /300/)
	})
})
