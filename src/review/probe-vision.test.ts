/**
 * The scoring of `scripts/probe-vision.ts`, pinned.
 *
 * The code under test lives in `scripts/`, not here. The test lives here because `pnpm test` runs
 * the `src` test glob and nothing else, and a probe whose scorer is wrong is worse than no probe:
 * it produces a number that looks measured. The probe's whole claim is "the model read the game
 * clock off the picture 22 times out of 23", and that claim is only as good as the parser that
 * turned a spoken sentence into a number.
 *
 * Every string below is a real reply from the live socket, copied out of a run. The model speaks
 * (it is native-audio-out, so the words arrive through `outputAudioTranscription`) and it says the
 * same reading four different ways depending on its mood — "0355", "402", "13:33", "NOTHING
 * VISIBLE". A parser that only accepted one shape would score a correct read as a miss and quietly
 * understate the model's sight, which is the exact conclusion the probe exists to get right.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import {
	clockText,
	emptyUnseen,
	falsifyClock,
	jpegSize,
	parseClockSeconds,
	MAX_BLIND_RATE,
	MIN_ANSWERED,
	MIN_SIGHT_RATE,
	parseFirstInt,
	probeVerdict,
	rateOf,
	sceneVerdict,
	stripClockLine
} from "../../scripts/probe-vision.ts"

describe("parseClockSeconds", () => {
	it("reads the digit runs the socket actually returned", () => {
		// All four are verbatim replies from probe runs on 2026-09-04.
		strictEqual(parseClockSeconds("0355"), 3 * 60 + 55)
		strictEqual(parseClockSeconds("402"), 4 * 60 + 2)
		strictEqual(parseClockSeconds("1333"), 13 * 60 + 33)
		strictEqual(parseClockSeconds("3049"), 30 * 60 + 49)
	})

	it("reads a colon, which is how the HUD writes it", () => {
		strictEqual(parseClockSeconds("The clock says 22:05."), 22 * 60 + 5)
	})

	it("reads the words, because an audio model sometimes spells it out", () => {
		strictEqual(parseClockSeconds("thirteen thirty three"), 13 * 60 + 33)
		strictEqual(parseClockSeconds("four oh two"), 4 * 60 + 2)
		strictEqual(parseClockSeconds("six forty three"), 6 * 60 + 43)
	})

	/*
	 * The honest refusal has to score as "no answer", not as zero.
	 *
	 * This is the reply the model gave to a frame that turned out to be a screenshot of the
	 * player's EDITOR rather than the game — there was no clock in the picture and it said so. If
	 * that parsed as 0 it would count as a wrong reading of a 19:29 clock, and the probe would
	 * report the model as blind on a frame where it was the only thing in the pipeline telling the
	 * truth.
	 */
	it("returns null when the model says it cannot see one", () => {
		strictEqual(parseClockSeconds("NOTHING VISIBLE"), null)
		strictEqual(parseClockSeconds(""), null)
	})
})

describe("parseFirstInt", () => {
	it("reads the FPS counter in every shape it came back in", () => {
		strictEqual(parseFirstInt("86"), 86)
		strictEqual(parseFirstInt("106"), 106)
		strictEqual(parseFirstInt("The FPS is 48."), 48)
		strictEqual(parseFirstInt("eighty six"), 86)
	})

	it("returns null rather than a number when nothing was read", () => {
		strictEqual(parseFirstInt("NOTHING VISIBLE"), null)
	})
})

/*
 * The block surgery is the whole experiment, so it is pinned rather than trusted.
 *
 * A `stripClockLine` that silently failed to match would leave the true clock in the text, and the
 * probe would report "the model read the picture" about a turn where it could simply have read the
 * block — the exact false-positive the conflict condition exists to rule out. This repo has
 * shipped a silent no-match edit before; a regex over a block whose renderer is under active
 * change is the same hazard.
 */
const BLOCK = `## Ground truth (from the game client — these are FACTS, the screenshot is not)

Clock 6:23.

You: Lillia lv5 0/1/1, 40 CS, 869 gold

Your team: Urgot lv6 0/0/0`

describe("block surgery", () => {
	it("strips the clock line and nothing else", () => {
		const out = stripClockLine(BLOCK)
		strictEqual(/Clock/.test(out), false)
		strictEqual(out.includes("You: Lillia lv5 0/1/1, 40 CS, 869 gold"), true)
		strictEqual(out.includes("Your team: Urgot lv6 0/0/0"), true)
	})

	it("falsifies the clock to a reading the picture cannot also support", () => {
		const { block, falseSec } = falsifyClock(BLOCK, 383)
		strictEqual(block.includes("Clock 13:23."), true)
		strictEqual(block.includes("Clock 6:23."), false)
		strictEqual(falseSec, 383 + 420)
		// Seven minutes apart, so the ±3s tolerance can never call one reading the other.
		strictEqual(Math.abs(falseSec - 383) > 3, true)
	})

	it("leaves the block untouched when there is no clock line to replace", () => {
		strictEqual(stripClockLine("no clock here"), "no clock here")
	})
})

describe("clockText", () => {
	it("writes seconds the way the HUD does", () => {
		deepStrictEqual([clockText(0), clockText(62), clockText(1850)], ["0:00", "1:02", "30:50"])
	})
})

/*
 * `jpegSize` is what reports "1536x864" in the probe's first section, i.e. the answer to "at what
 * size does the frame arrive". It walks the marker chain by hand rather than decoding, so the
 * segment-skipping is the part that can be wrong: a JFIF APP0 sits in front of the frame header in
 * every file the browser's `canvas.toDataURL` produces.
 */
describe("jpegSize", () => {
	it("finds the frame header past a leading APP0 segment", () => {
		const app0 = Buffer.alloc(16, 0)
		app0.writeUInt16BE(0xffe0, 0)
		app0.writeUInt16BE(14, 2)
		const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x60, 0x06, 0x00])
		const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(8, 0)])
		deepStrictEqual(jpegSize(jpeg), { w: 1536, h: 864 })
	})

	it("returns null rather than a guess for something that is not a JPEG", () => {
		strictEqual(jpegSize(Buffer.alloc(32, 0)), null)
	})
})

/*
 * The block surgery, pinned against a block the DAEMON actually wrote.
 *
 * The `BLOCK` above is hand-typed, so it can only prove the regexes match a shape the author had in
 * mind. `emptyUnseen` is the surgery behind the whole "can the picture ever reach her mouth" number,
 * it depends on two headings in `live-state.ts` that other work is actively editing, and until now
 * nothing pinned it at all. If it stopped matching it would quietly leave the ranked fact list in
 * the block, and the probe would report "she still won't talk about the picture" about turns where
 * she had a perfectly good fact to say instead — a silent no-op producing a confident conclusion,
 * which is the failure this repo keeps hitting.
 *
 * This text is `js-mtn2jrku-8ae9-4034` out of `journal_frame.truthJson`, trimmed to the parts the
 * regexes touch.
 */
const REAL_BLOCK = `## Ground truth (from the game client — these are FACTS, the screenshot is not)

Clock 6:23.

You: Lillia lv5 0/1/1, 40 CS, 0/979 HP, 869 gold, DEAD (respawn in 6 seconds)

Alive right now: 4 of yours against 3 of theirs.

### What he is NOT looking at — prefer these

- they took Hextech drake

**The ten champions above are the only champions in this game.** Never name any other.
`

describe("emptyUnseen", () => {
	it("removes the ranked fact list from a block the daemon really wrote", () => {
		const out = emptyUnseen(REAL_BLOCK)
		strictEqual(out === REAL_BLOCK, false)
		strictEqual(/What he is NOT looking at/.test(out), false)
		strictEqual(out.includes("they took Hextech drake"), false)
		// Everything after the list has to survive, or the condition stops being the shipped block.
		strictEqual(out.includes("**The ten champions above"), true)
		strictEqual(out.includes("Clock 6:23."), true)
		strictEqual(/Nothing he is missing right now/.test(out), true)
	})

	it("leaves a block that already says nothing is missing alone", () => {
		const already = REAL_BLOCK.replace(
			/### What he is NOT looking at[\s\S]*?(?=\*\*The ten champions)/,
			"### Nothing he is missing right now\n\n"
		)
		strictEqual(emptyUnseen(already), already)
	})
})

describe("stripClockLine on a real block", () => {
	it("matches the daemon's own `Clock m:ss.` line", () => {
		strictEqual(/Clock/.test(stripClockLine(REAL_BLOCK)), false)
	})
})

/*
 * A turn that came back EMPTY is not a model that failed the question.
 *
 * Measured, on a 60-frame scene run: `js-mtn2jrku-8ae9-13091` returned an empty transcript and the
 * probe printed it as NOT THE GAME, i.e. as one of the frames where the player's desktop was
 * uploaded to Google instead of his game. Opened by hand it is unmistakably the game — a five-man
 * river fight at 21:48. One dead socket had put a third of that headline finding on the board.
 */
describe("answered vs ok", () => {
	it("keeps a turn that said nothing out of the rate entirely", () => {
		strictEqual(
			rateOf([
				{ ok: true, answered: true },
				{ ok: false, answered: true },
				{ ok: false, answered: false }
			]),
			"1/2 (1 no answer)"
		)
	})

	it("says nothing about no-answers when every turn answered", () => {
		strictEqual(rateOf([{ ok: true, answered: true }, { ok: true, answered: true }]), "2/2")
	})
})

describe("sceneVerdict", () => {
	it("reads the one-word answers the classifier gives", () => {
		strictEqual(sceneVerdict("YES"), "yes")
		strictEqual(sceneVerdict("NO"), "no")
		strictEqual(sceneVerdict("No."), "no")
	})

	it("calls an empty reply unknown rather than NO", () => {
		strictEqual(sceneVerdict(""), "unknown")
		strictEqual(sceneVerdict("   "), "unknown")
	})
})

/**
 * The verdict, which is the only thing that decides whether a regression is LOUD.
 *
 * This probe printed its rates and exited 0 whatever they said, had no `pnpm` script and no
 * threshold — so the "the model reads the frame 22 times in 23" number that every comment in
 * `analysis/live-facts.ts` and `review/frame-read.ts` leans on could have collapsed to zero in
 * silence. These pin the three decisions that a threshold has to get right, and the third one is
 * the one nobody would have written unprompted.
 */
const row = (check: string, ok: boolean, answered = true) => ({ check, ok, answered })
const many = (check: string, ok: number, total: number, answered = total) =>
	Array.from({ length: total }, (_, i) => row(check, i < ok, i < answered))

describe("probeVerdict", () => {
	it("passes the measured result — 6/6 seeing, 0/6 blind", () => {
		const v = probeVerdict([...many("bare", 6, 6), ...many("blind", 0, 6)])
		strictEqual(v.verdict, "pass")
		strictEqual(v.code, 0)
	})

	it("fails when the model stops reading the picture", () => {
		const v = probeVerdict([...many("bare", 0, 6), ...many("blind", 0, 6)])
		strictEqual(v.verdict, "fail")
		strictEqual(v.code, 1)
		strictEqual(
			v.reasons.some(r => r.startsWith("bare:") && /below/.test(r)),
			true
		)
	})

	it("tolerates one unlucky frame rather than crying wolf", () => {
		// 5/6 is 83%, above the threshold: a probe that fails on one miss gets an `|| true`.
		strictEqual(probeVerdict([...many("bare", 5, 6), ...many("blind", 0, 6)]).verdict, "pass")
	})

	it("fails a blind arm that starts scoring, because that is a LEAK and not good news", () => {
		// The instrument, not the model: the clock is reaching it without the pixels, and every
		// "the model can see" figure in this repo would then be measuring the leak.
		const v = probeVerdict([...many("bare", 6, 6), ...many("blind", 6, 6)])
		strictEqual(v.verdict, "fail")
		strictEqual(v.code, 1)
		strictEqual(
			v.reasons.some(r => /without the pixels/.test(r)),
			true
		)
	})

	it("calls a dead socket inconclusive rather than a regression", () => {
		// Six turns, none answered. `rateOf` renders this 0/0, and 0/0 against a threshold is how a
		// run whose socket never connected exits green — or, worse, red for the wrong reason.
		const v = probeVerdict([...many("bare", 0, 6, 0), ...many("blind", 0, 6, 0)])
		strictEqual(v.verdict, "inconclusive")
		strictEqual(v.code, 2)
	})

	it("never lets a thin arm hide a real regression in the other one", () => {
		const v = probeVerdict([...many("bare", 0, 6), ...many("blind", 0, 6, 0)])
		strictEqual(v.verdict, "fail")
		strictEqual(v.code, 1)
	})

	it("does not fail an arm that was never requested", () => {
		// `--check bare` runs one arm; a missing arm is not run, and not run is not broken.
		const v = probeVerdict(many("bare", 6, 6))
		strictEqual(v.verdict, "pass")
		strictEqual(
			v.reasons.some(r => r === "blind: not run"),
			true
		)
	})

	it("passes an empty run as nothing to say, not as a regression", () => {
		strictEqual(probeVerdict([]).verdict, "pass")
	})

	it("keeps the thresholds where the measurements put them", () => {
		// Below the measured 6/6 and 22/23 on purpose, and above the measured 0/6 blind.
		strictEqual(MIN_SIGHT_RATE < 6 / 6, true)
		strictEqual(MIN_SIGHT_RATE > MAX_BLIND_RATE, true)
		strictEqual(MIN_ANSWERED >= 4, true)
	})
})
