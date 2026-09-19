/**
 * The two properties the forced-choice result rests on, pinned so a later edit cannot quietly
 * move them.
 *
 * Neither is about League. They are about the instrument: an exact null at one half, and an
 * interval that is honest about the fact that a turn votes twice.
 */

import { ok, equal } from "node:assert/strict"
import { test } from "node:test"
import { CHOICE_SYSTEM, PICTURE_ARMS, clusterBootstrap, mayPicture, signTest } from "./frame-power.ts"

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

/* =============================================================== the cadence arms */

/*
 * The cadence experiment's arms differ from every other arm in this file in a way that is easy to
 * break by accident: they are identical in WHAT they send and differ only in HOW OFTEN. A run whose
 * `sparse` arm quietly sent a picture every turn would report a saving of zero and read as evidence
 * that the cadence does not matter, which is the same shape of false null this whole file exists to
 * avoid. So the schedule itself is pinned.
 */

test("`full` sends on every round and `none` on none of them", () => {
	const full = PICTURE_ARMS.find(a => a.id === "full")!
	const none = PICTURE_ARMS.find(a => a.id === "none")!
	for (let r = 0; r < 30; r++) {
		ok(mayPicture(full, r, r), `full must send on round ${r}`)
		ok(!mayPicture(none, r, 0), `none must never send`)
	}
})

test("`sparse` sends on rounds 0, 3, 6 … and nowhere else", () => {
	const sparse = PICTURE_ARMS.find(a => a.id === "sparse")!
	const sent = Array.from({ length: 30 }, (_, r) => r).filter(r => mayPicture(sparse, r, 0))
	equal(sent.length, 10)
	equal(sent[0], 0)
	equal(sent[1], 3)
	equal(sent[9], 27)
})

test("`once` sends exactly one picture in a whole game, whenever the first one lands", () => {
	const once = PICTURE_ARMS.find(a => a.id === "once")!
	let sent = 0
	for (let r = 0; r < 30; r++) if (mayPicture(once, r, sent)) sent += 1
	equal(sent, 1)
})

test("the cap counts pictures that WENT, so a lost frame does not blind the arm for the game", () => {
	/*
	 * The failure this pins: if the counter were incremented on every eligible turn rather than on
	 * every picture actually sent, an `once` arm whose round-0 frame could not be read would have
	 * spent its budget on nothing and gone blind for the rest of the game — while the run file
	 * recorded it as an arm that had sent its picture.
	 */
	const once = PICTURE_ARMS.find(a => a.id === "once")!
	let sent = 0
	const lands: number[] = []
	for (let r = 0; r < 10; r++) {
		if (!mayPicture(once, r, sent)) continue
		/* pretend the first two frames failed to read */
		if (r < 2) continue
		sent += 1
		lands.push(r)
	}
	equal(sent, 1)
	equal(lands[0], 2)
})

test("every arm in the table declares its cadence, and only the cadence arms are not every-turn", () => {
	for (const a of PICTURE_ARMS) {
		ok(a.cadence >= 1, `${a.id} has a nonsense cadence`)
		ok(a.maxPictures === null || a.maxPictures >= 1, `${a.id} has a nonsense cap`)
	}
	const notEveryTurn = PICTURE_ARMS.filter(a => a.pic !== "none" && (a.cadence !== 1 || a.maxPictures !== null))
	equal(
		notEveryTurn.map(a => a.id).sort().join(","),
		"once,sparse",
		"a new cadence arm must be added to this list deliberately, not discovered in a run"
	)
})
