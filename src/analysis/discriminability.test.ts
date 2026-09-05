/**
 * Tests for the genericness instrument.
 *
 * The thing under test is a MEASUREMENT, so the tests that matter are the ones asserting it
 * cannot flatter: that decoys are plausible, that the shuffle is not a constant, that a judge
 * which always says "A" is visible as bias rather than as a result, and that a scrambled arm
 * really does destroy the pairing. A metric whose failure modes are untested is a number, not
 * evidence.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, test } from "node:test"
import {
	buildTrials,
	maskLine,
	parseChoice,
	positionBias,
	renderJudgePrompt,
	runTrials,
	scrambleTrials,
	shuffle,
	summarize
} from "./discriminability.ts"
import type { Judge, StateCard } from "./discriminability.ts"

const card = (game: string, tSec: number, block: string, hasFacts = true): StateCard => ({
	id: `${game}@${tSec}`,
	game,
	tSec,
	block,
	hasFacts
})

/** Four games × ticks every 60s, blocks that carry their own identity so a stub judge can cheat. */
const corpus = (): StateCard[] => {
	const out: StateCard[] = []
	for (const g of ["g1", "g2", "g3", "g4"])
		for (let t = 60; t <= 1800; t += 60)
			out.push(card(g, t, `game ${g} clock ${t}`, t % 120 === 0))
	return out
}

describe("maskLine", () => {
	test("none is the identity", () => {
		strictEqual(maskLine("40 CS on Briar", "none", ["Briar"]), "40 CS on Briar")
	})

	test("digits masks figures written as digits", () => {
		strictEqual(maskLine("you have 40 CS to Briar 0 CS", "digits", []), "you have # CS to Briar # CS")
	})

	test("digits masks figures written as words — a spoken coach says 'twenty three'", () => {
		strictEqual(maskLine("you are twenty three CS up", "digits", []), "you are # CS up")
	})

	test("digits+names also removes the roster, which is what pins a line to a game", () => {
		strictEqual(
			maskLine("Briar is still at 0 CS", "digits+names", ["Briar", "Lillia"]),
			"«champion» is still at # CS"
		)
	})

	test("a longer name is not eaten by a shorter one it contains", () => {
		strictEqual(maskLine("Senna and Sen", "digits+names", ["Sen", "Senna"]), "«champion» and «champion»")
	})

	/*
	 * The respelling is a name too, and forgetting it silently broke the mask.
	 *
	 * The transcript under test says "BRY-er" — `knowledge/pronunciations.md`'s respelling of Briar,
	 * leaked out of a prompt it should never have been in. A vocabulary built only from the client's
	 * spellings left the enemy jungler standing in eight of nine masked lines, and the cross-game
	 * arm read 88% while claiming the roster was hidden.
	 */
	test("a hyphenated respelling masks like any other name", () => {
		strictEqual(
			maskLine("BRY-er is still at 0 CS", "digits+names", ["Briar", "BRY-er"]),
			"«champion» is still at # CS"
		)
	})

	test("champion masking is case-insensitive but respects word boundaries", () => {
		strictEqual(maskLine("briarwood is not briar", "digits+names", ["Briar"]), "briarwood is not «champion»")
	})
})

describe("decoy selection", () => {
	test("within-game decoys share the game and are separated in time from truth AND each other", () => {
		const cards = corpus()
		const { trials, skipped } = buildTrials({
			lines: [{ id: "L", text: "x", stateId: "g1@600" }],
			cards,
			pool: "within-game",
			masks: ["none"],
			k: 5,
			minSeparationSec: 150
		})
		deepStrictEqual(skipped, [])
		const opts = trials[0]!.options
		strictEqual(opts.length, 5)
		ok(opts.every(o => o.game === "g1"))
		for (let i = 0; i < opts.length; i++)
			for (let j = i + 1; j < opts.length; j++)
				ok(
					Math.abs(opts[i]!.tSec - opts[j]!.tSec) >= 150,
					`options ${opts[i]!.tSec} and ${opts[j]!.tSec} are less than 150s apart`
				)
	})

	test("cross-game decoys come from other games at a comparable clock", () => {
		const cards = corpus()
		const { trials } = buildTrials({
			lines: [{ id: "L", text: "x", stateId: "g1@600" }],
			cards,
			pool: "cross-game",
			masks: ["none"],
			k: 4,
			clockToleranceSec: 90
		})
		const opts = trials[0]!.options
		const decoys = opts.filter(o => o.id !== "g1@600")
		strictEqual(decoys.length, 3)
		ok(decoys.every(o => o.game !== "g1"))
		ok(decoys.every(o => Math.abs(o.tSec - 600) <= 90))
	})

	test("cross-game prefers one decoy per game before taking a second from any", () => {
		const cards = corpus()
		const { trials } = buildTrials({
			lines: [{ id: "L", text: "x", stateId: "g1@600" }],
			cards,
			pool: "cross-game",
			masks: ["none"],
			k: 4,
			clockToleranceSec: 90
		})
		const games = new Set(trials[0]!.options.filter(o => o.id !== "g1@600").map(o => o.game))
		strictEqual(games.size, 3)
	})

	test("decoys match the truth on hasFacts — otherwise the judge picks the block with a list", () => {
		const cards = corpus()
		for (const stateId of ["g1@600", "g1@660"]) {
			const truth = cards.find(c => c.id === stateId)!
			const { trials } = buildTrials({
				lines: [{ id: "L", text: "x", stateId }],
				cards,
				pool: "within-game",
				masks: ["none"],
				k: 5
			})
			ok(trials[0]!.options.every(o => o.hasFacts === truth.hasFacts))
		}
	})

	test("a trial with too few plausible decoys is refused, not padded with implausible ones", () => {
		// One game only, and a truth near the end: nothing else is far enough away.
		const cards = [card("g1", 100, "a"), card("g1", 160, "b"), card("g1", 200, "c")]
		const { trials, skipped } = buildTrials({
			lines: [{ id: "L", text: "x", stateId: "g1@100" }],
			cards,
			pool: "within-game",
			masks: ["none"],
			k: 5,
			minSeparationSec: 150
		})
		strictEqual(trials.length, 0)
		strictEqual(skipped.length, 1)
		ok(skipped[0]!.reason.includes("plausible decoys"))
	})

	test("a line pointing at a state that is not in the corpus is refused", () => {
		const { trials, skipped } = buildTrials({
			lines: [{ id: "L", text: "x", stateId: "nope" }],
			cards: corpus(),
			pool: "within-game",
			masks: ["none"]
		})
		strictEqual(trials.length, 0)
		strictEqual(skipped[0]!.reason, "no card nope")
	})

	test("every mask of one line shares one option set, so the masked/unmasked gap is only the mask", () => {
		const { trials } = buildTrials({
			lines: [{ id: "L", text: "40 CS", stateId: "g1@600" }],
			cards: corpus(),
			pool: "within-game",
			masks: ["none", "digits"]
		})
		strictEqual(trials.length, 2)
		deepStrictEqual(
			trials[0]!.options.map(o => o.id),
			trials[1]!.options.map(o => o.id)
		)
		strictEqual(trials[0]!.answerIndex, trials[1]!.answerIndex)
		strictEqual(trials[1]!.prompt, "# CS")
	})
})

describe("determinism", () => {
	test("the same seed gives the same order and a different seed generally does not", () => {
		const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
		deepStrictEqual(shuffle(items, "a"), shuffle(items, "a"))
		ok(JSON.stringify(shuffle(items, "a")) !== JSON.stringify(shuffle(items, "b")))
	})

	test("the answer is not parked at one index across lines", () => {
		const lines = Array.from({ length: 24 }, (_, i) => ({
			id: `L${i}`,
			text: "x",
			stateId: "g1@600"
		}))
		const { trials } = buildTrials({ lines, cards: corpus(), pool: "within-game", masks: ["none"] })
		strictEqual(new Set(trials.map(t => t.answerIndex)).size > 1, true)
	})
})

describe("the judge's prompt", () => {
	test("labels every option and quotes the MASKED line, never the raw one", () => {
		const { trials } = buildTrials({
			lines: [{ id: "L", text: "you have 40 CS", stateId: "g1@600" }],
			cards: corpus(),
			pool: "within-game",
			masks: ["digits"],
			k: 5
		})
		const p = renderJudgePrompt(trials[0]!)
		for (const l of ["A", "B", "C", "D", "E"]) ok(p.includes(`### STATE ${l}`))
		ok(p.includes('"you have # CS"'))
		ok(!p.includes("40 CS"))
	})

	test("tells the judge to guess, so the floor stays at chance rather than abstention", () => {
		const { trials } = buildTrials({
			lines: [{ id: "L", text: "x", stateId: "g1@600" }],
			cards: corpus(),
			pool: "within-game",
			masks: ["none"]
		})
		ok(renderJudgePrompt(trials[0]!).includes("guess"))
	})

	test("never leaks which game or clock an option came from outside its own block", () => {
		const { trials } = buildTrials({
			lines: [{ id: "L", text: "x", stateId: "g1@600" }],
			cards: corpus(),
			pool: "cross-game",
			masks: ["none"],
			k: 4
		})
		const p = renderJudgePrompt(trials[0]!)
		for (const o of trials[0]!.options) ok(!p.includes(o.id), `${o.id} leaked into the prompt`)
	})
})

describe("parseChoice", () => {
	test("reads a bare letter", () => {
		strictEqual(parseChoice("C", 5), 2)
	})

	test("takes the first in-range letter, so thinking-out-loud does not pick the answer", () => {
		strictEqual(parseChoice("B", 5), 1)
		strictEqual(parseChoice("Answer: D", 5), 3)
	})

	test("a letter outside the range is not an answer", () => {
		strictEqual(parseChoice("G", 5), null)
	})

	test("nothing usable is null, never a wrong answer", () => {
		strictEqual(parseChoice("", 5), null)
		strictEqual(parseChoice("I cannot tell.", 3), null)
	})
})

describe("running and summarising", () => {
	/** The degenerate judge: never reads anything, always says A. */
	const alwaysA: Judge = async () => "A"

	test("a judge that always answers A scores at chance and shows up in positionBias", async () => {
		const lines = Array.from({ length: 20 }, (_, i) => ({
			id: `L${i}`,
			text: `line ${i}`,
			stateId: "g1@600"
		}))
		const { trials } = buildTrials({ lines, cards: corpus(), pool: "within-game", masks: ["none"] })
		const js = await runTrials(trials, alwaysA)
		const bias = positionBias(js)
		strictEqual(bias[0], 20)
		strictEqual(bias.slice(1).reduce((a, b) => a + b, 0), 0)
		const cell = summarize(js)[0]!
		ok(cell.accuracy < 0.5)
		strictEqual(cell.aboveChance, false)
	})

	test("a judge that reads the block scores 100% and clears the null", async () => {
		const cards = corpus()
		const truthful: Judge = async prompt => {
			// The stub line IS the block text, so the right answer is the state whose block matches.
			const line = prompt.match(/he said this sentence out loud:\n\n"([^"]+)"/)![1]!
			const sections = prompt.split("### STATE ").slice(1)
			for (const s of sections) if (s.includes(line)) return s.slice(0, 1)
			return "A"
		}
		const lines = cards
			.filter(c => c.game === "g1" && c.hasFacts && c.tSec >= 600 && c.tSec <= 1500)
			.map((c, i) => ({ id: `L${i}`, text: c.block, stateId: c.id }))
		const { trials } = buildTrials({ lines, cards, pool: "within-game", masks: ["none"] })
		ok(trials.length >= 8)
		const js = await runTrials(trials, truthful)
		const cell = summarize(js)[0]!
		strictEqual(cell.accuracy, 1)
		strictEqual(cell.aboveChance, true)
		strictEqual(cell.chance, 0.2)
	})

	test("unparsed answers are excluded from n rather than counted as wrong", async () => {
		const lines = [{ id: "L", text: "x", stateId: "g1@600" }]
		const { trials } = buildTrials({ lines, cards: corpus(), pool: "within-game", masks: ["none"] })
		const js = await runTrials(trials, async () => "no idea")
		const cell = summarize(js)[0]!
		strictEqual(cell.n, 0)
		strictEqual(cell.unparsed, 1)
	})

	test("a judge that throws is a judge failure, not a wrong answer", async () => {
		const lines = [{ id: "L", text: "x", stateId: "g1@600" }]
		const { trials } = buildTrials({ lines, cards: corpus(), pool: "within-game", masks: ["none"] })
		const js = await runTrials(trials, async () => {
			throw new Error("rate limited")
		})
		strictEqual(js[0]!.choice, null)
		strictEqual(js[0]!.correct, false)
	})

	test("cells are split by pool, mask and tag so arms are never pooled by accident", async () => {
		const lines = [
			{ id: "A", text: "40 CS", stateId: "g1@600", tag: "transcript" },
			{ id: "B", text: "50 CS", stateId: "g1@840", tag: "specific" }
		]
		const { trials } = buildTrials({
			lines,
			cards: corpus(),
			pool: "within-game",
			masks: ["none", "digits"]
		})
		const js = await runTrials(trials, async () => "A")
		strictEqual(summarize(js).length, 4)
	})
})

describe("scrambleTrials — the empirical null", () => {
	test("keeps the option sets and moves the lines off them", () => {
		const lines = Array.from({ length: 10 }, (_, i) => ({
			id: `L${i}`,
			text: `line ${i}`,
			stateId: `g1@${600 + i * 180}`
		}))
		const { trials } = buildTrials({ lines, cards: corpus(), pool: "within-game", masks: ["none"] })
		const scrambled = scrambleTrials(trials)
		strictEqual(scrambled.length, trials.length)
		for (let i = 0; i < trials.length; i++) {
			deepStrictEqual(
				scrambled[i]!.options.map(o => o.id),
				trials[i]!.options.map(o => o.id)
			)
			strictEqual(scrambled[i]!.answerIndex, trials[i]!.answerIndex)
			// The whole point: this trial is now asking about somebody else's line.
			ok(scrambled[i]!.prompt !== trials[i]!.prompt)
		}
	})

	test("a donor is always from the same pool and mask, and never the trial itself", () => {
		const lines = Array.from({ length: 6 }, (_, i) => ({
			id: `L${i}`,
			text: `line ${i} says forty`,
			stateId: `g1@${600 + i * 180}`
		}))
		const { trials } = buildTrials({
			lines,
			cards: corpus(),
			pool: "within-game",
			masks: ["none", "digits"]
		})
		const scrambled = scrambleTrials(trials)
		for (let i = 0; i < trials.length; i++) {
			strictEqual(scrambled[i]!.mask, trials[i]!.mask)
			strictEqual(scrambled[i]!.pool, trials[i]!.pool)
			ok(!scrambled[i]!.lineId.startsWith(`${trials[i]!.lineId}~`), "a trial donated to itself")
			// The donor's line was masked the same way, so a masked cell stays masked.
			if (trials[i]!.mask === "digits") ok(!/\d/.test(scrambled[i]!.prompt))
		}
	})

	test("an oracle judge is destroyed by scrambling — proof the pairing is what it reads", async () => {
		const cards = corpus()
		const truthful: Judge = async prompt => {
			const line = prompt.match(/he said this sentence out loud:\n\n"([^"]+)"/)![1]!
			const sections = prompt.split("### STATE ").slice(1)
			for (const s of sections) if (s.includes(line)) return s.slice(0, 1)
			return "A"
		}
		const lines = cards
			.filter(c => c.game === "g1" && c.hasFacts && c.tSec >= 600 && c.tSec <= 1500)
			.map((c, i) => ({ id: `L${i}`, text: c.block, stateId: c.id }))
		const { trials } = buildTrials({ lines, cards, pool: "within-game", masks: ["none"] })
		const real = summarize(await runTrials(trials, truthful))[0]!
		const null_ = summarize(await runTrials(scrambleTrials(trials), truthful))[0]!
		strictEqual(real.accuracy, 1)
		ok(null_.accuracy < 0.5, `scrambled arm scored ${null_.accuracy}`)
	})
})
