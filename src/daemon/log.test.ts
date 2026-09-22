/**
 * The ring exists because every defect found on 2026-09-22 was a line the daemon had already
 * written and nobody had read. These cases pin the two properties that make it useful: it survives
 * a quiet log level, and it cannot grow under a loop.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { faultCounts, makeLogger, recentFaults, resetFaults, setLogLevel } from "./log.ts"

describe("the fault ring", () => {
	it("keeps warnings and errors, and ignores info and debug", () => {
		resetFaults()
		const log = makeLogger("test")
		setLogLevel("debug")
		log.info("nothing to see")
		log.debug("nor here")
		log.warn("a warning")
		log.error("an error")
		const faults = recentFaults()
		assert.equal(faults.length, 2)
		assert.equal(faults[0]?.level, "error", "newest first")
		assert.equal(faults[1]?.msg, "a warning")
		resetFaults()
	})

	/*
	 * THE ONE THAT MATTERS. `setLogLevel("error")` is a decision about what a HUMAN wants to read.
	 * A daemon running quiet is exactly the one whose faults nobody will notice, so the machine
	 * must still know about them.
	 */
	it("records a warning the log level would have silenced", () => {
		resetFaults()
		setLogLevel("error")
		makeLogger("quiet").warn("discarded 363 polls")
		assert.equal(recentFaults().length, 1)
		assert.equal(recentFaults()[0]?.msg, "discarded 363 polls")
		setLogLevel("info")
		resetFaults()
	})

	it("cannot grow under a loop", () => {
		resetFaults()
		const log = makeLogger("loop")
		for (let i = 0; i < 500; i++) log.error(`same line ${i}`)
		const faults = recentFaults(1000)
		assert.equal(faults.length, 50, "bounded by count, because a loop logs faster than any age bound trims")
		assert.equal(faults[0]?.msg, "same line 499", "and it keeps the NEWEST, not the first fifty")
		resetFaults()
	})

	it("counts within a window and reports what it still holds", () => {
		resetFaults()
		const log = makeLogger("counts")
		log.warn("one")
		log.error("two")
		const counts = faultCounts(Date.now() - 60_000)
		assert.equal(counts.warn, 1)
		assert.equal(counts.error, 1)
		assert.ok(counts.oldestKeptMs !== null)
		assert.equal(faultCounts(Date.now() + 10_000).warn, 0, "a window in the future holds nothing")
		resetFaults()
	})

	it("hands out a copy, so a caller cannot edit the ring", () => {
		resetFaults()
		makeLogger("copy").error("mine")
		const first = recentFaults()
		first.length = 0
		assert.equal(recentFaults().length, 1)
		resetFaults()
	})
})
