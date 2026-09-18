/**
 * The two properties the forced-choice result rests on, pinned so a later edit cannot quietly
 * move them.
 *
 * Neither is about League. They are about the instrument: an exact null at one half, and an
 * interval that is honest about the fact that a turn votes twice.
 */

import { ok, equal } from "node:assert/strict"
import { test } from "node:test"
import { CHOICE_SYSTEM, clusterBootstrap, signTest } from "./frame-power.ts"

test("the null is exactly one half: an even split can never be evidence", () => {
	equal(signTest(5, 10), 1)
	equal(signTest(31, 62), 1)
	equal(signTest(0, 0), 1)
})

test("a clean sweep of ten is 2 / 2^10, the same arithmetic frame-value's McNemar uses", () => {
	ok(Math.abs(signTest(10, 10) - 2 / 1024) < 1e-12)
	ok(Math.abs(signTest(0, 10) - 2 / 1024) < 1e-12)
})

test("63 of 100 is suggestive and 65 of 100 separates — the power claim, checkable", () => {
	ok(signTest(63, 100) > 0.01 && signTest(63, 100) < 0.02)
	ok(signTest(65, 100) < 0.005)
	// and the size this file was designed to see on its own n
	ok(signTest(39, 62) > 0.05, "63% on 62 trials must NOT read as significant")
	ok(signTest(150, 240) < 0.001, "65% on 240 trials must")
})

test("the cluster bootstrap is WIDER than the binomial, because a turn votes twice", () => {
	/*
	 * Sixty turns, each answered twice, each turn either right twice or wrong twice — the worst
	 * case for treating trials as independent. The binomial would see 120 draws; there are 60.
	 */
	const clusters = Array.from({ length: 60 }, (_, i) => (i < 39 ? { k: 2, n: 2 } : { k: 0, n: 2 }))
	const boot = clusterBootstrap(clusters)
	const halfWidth = (boot.hi - boot.lo) / 2
	// A 120-draw binomial at 65% has a 95% half-width near 8.5 points; the clustered truth is wider.
	ok(halfWidth > 0.1, `expected a wide interval, got ${(100 * halfWidth).toFixed(1)} points`)
	ok(boot.lo > 0.4 && boot.hi < 0.9)
})

test("a judge with a fixed style preference is scored at chance, by construction", () => {
	/*
	 * The mirror is the whole reason the null is exact, so it is asserted on the prompt rather than
	 * left as a claim in a comment: the judge is never told which picture it holds, and it is told
	 * to ignore which line is better advice or better written.
	 */
	ok(CHOICE_SYSTEM.includes("better advice and ignore which is better written"))
	ok(!CHOICE_SYSTEM.toLowerCase().includes("decoy"))
	ok(!CHOICE_SYSTEM.toLowerCase().includes("real frame"))
})
