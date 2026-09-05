/**
 * The parts of `scripts/e2e-real-game.ts` that decide what a run MEANS.
 *
 * The code under test lives in `scripts/`; the test lives here because `pnpm test` runs the `src`
 * glob and nothing else, and this harness's whole job is to produce numbers the owner will act on.
 * A summary that is wrong is worse than no summary — it looks measured.
 *
 * Every case below is a defect that actually happened while building it, not a hypothetical:
 *
 *   - the control table joined on the attempt number and matched NOTHING, printing a clean table
 *     of zeroes that read as "the frame changes nothing";
 *   - a mistyped checkpoint id would have produced a run of zero turns that exits 0;
 *   - the frame arm spelled its numbers out ("two for zero") where the text arm wrote digits, so
 *     string comparison called a paraphrase a difference in content.
 */

import { deepStrictEqual, strictEqual, throws } from "node:assert/strict"
import { rmSync, writeFileSync } from "node:fs"
import { describe, it } from "node:test"
import {
	comparePairs,
	frameUsable,
	readFixture,
	selectCheckpoints,
	stripFence,
	subjectOf
} from "../../scripts/e2e-real-game.ts"
import type { FixtureCheckpoint, TurnResult } from "../../scripts/e2e-real-game.ts"

const cp = (id: string, tSec: number, framePath: string | null): FixtureCheckpoint => ({
	id,
	tSec,
	clock: "00:00",
	sampleLine: tSec,
	framePath,
	frameSkewSec: framePath === null ? null : 1,
	frameShowsGame: framePath === null ? null : true,
	block: "B",
	storedBlock: null
})

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

describe("selectCheckpoints", () => {
	const all = [cp("cp-0001", 1, "/a.jpg"), cp("cp-0002", 2, null), cp("cp-0003", 3, "/b.jpg")]

	it("defaults to everything", () => {
		strictEqual(selectCheckpoints(all, "all").length, 3)
		strictEqual(selectCheckpoints(all, "").length, 3)
	})

	it("splits the corpus by whether a picture exists", () => {
		deepStrictEqual(
			selectCheckpoints(all, "frames").map(c => c.id),
			["cp-0001", "cp-0003"]
		)
		deepStrictEqual(
			selectCheckpoints(all, "noframes").map(c => c.id),
			["cp-0002"]
		)
	})

	it("keeps an explicit list in the order it was asked for", () => {
		deepStrictEqual(
			selectCheckpoints(all, "cp-0003, cp-0001").map(c => c.id),
			["cp-0003", "cp-0001"]
		)
	})

	// A typo would otherwise run zero turns, write an empty file and exit 0 — a clean-looking
	// result from a harness that did nothing.
	it("throws on an id that is not in the fixture rather than quietly running nothing", () => {
		throws(() => selectCheckpoints(all, "cp-0001,cp-9999"), /cp-9999/)
	})
})

describe("frameUsable", () => {
	it("is false without a picture", () => {
		strictEqual(frameUsable(cp("cp-0002", 2, null)), false)
	})

	// A frame that was inspected and shows his desktop, a browser or the post-game screen is WORSE
	// than no frame: it asks a coach to react to a picture of nothing.
	it("is false for a frame that was checked and does not show the game", () => {
		strictEqual(frameUsable({ ...cp("cp-0001", 1, "/a.jpg"), frameShowsGame: false }), false)
	})

	it("is false when the jpeg is not on disk", () => {
		strictEqual(frameUsable(cp("cp-0001", 1, "/no/such/frame.jpg")), false)
	})
})

describe("readFixture", () => {
	// data/eval also holds `fixture-expanded.json`, which has a completely different shape and no
	// raw samples at all. Pointing this at it must fail loudly rather than replay nothing.
	it("names the missing field instead of failing later", () => {
		const tmp = `${process.env.TMPDIR ?? "/tmp"}/e2e-fixture-${process.pid}.json`
		writeFileSync(tmp, JSON.stringify({ gameId: "1", checkpoints: [{ id: "a" }] }))
		try {
			throws(() => readFixture(tmp), /source\.samples/)
		} finally {
			rmSync(tmp)
		}
	})
})

describe("subjectOf", () => {
	it("calls a deliberate pass a silence, not a subject", () => {
		strictEqual(subjectOf("PASS"), "silence")
		strictEqual(subjectOf("pass."), "silence")
	})

	it("prefers the objective over the farm word when both appear", () => {
		strictEqual(subjectOf("Drake is up in 40 seconds, clear toward it"), "objective")
	})

	it("separates the counterpart from his own farm", () => {
		strictEqual(subjectOf("Briar is 14 CS up on you"), "counterpart")
		strictEqual(subjectOf("You are on 42 CS at ten minutes"), "farm")
	})
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

describe("stripFence", () => {
	// Several models fence their JSON however firmly the prompt says not to; an unstripped fence
	// makes every judgement a parse failure, which looks exactly like a judge that refused to grade.
	it("unwraps a fenced object and leaves a bare one alone", () => {
		strictEqual(stripFence('```json\n{"a":1}\n```'), '{"a":1}')
		strictEqual(stripFence('```\n{"a":1}```'), '{"a":1}')
		strictEqual(stripFence('  {"a":1}  '), '{"a":1}')
	})
})
