/**
 * Is a spoken line traceable back to the game that produced it?
 *
 * ## The question this answers, and why the existing scorer cannot
 *
 * `coach-score.ts` asks whether a line is TRUE. It is a good instrument and it has been at
 * ceiling for months. The transcript the owner finally quit on scored perfectly on it:
 *
 *     Nice work clearing, your 40 farm is just behind your average of 42.
 *     Awesome clear, you are farming above your average of 37 right now.
 *     Try to pick up the pace, your 20 farm is not pacing to match your average of 30.
 *
 * Every figure backed, no invented champion, no invented movement — and useless. So this file
 * measures a different property, the third of the six usefulness axes: **could this sentence have
 * come from a different game?**
 *
 * ## The design, and why it is not a matter of taste
 *
 * Genericness is normally argued about. Here it is a forced choice. Take the line, take the
 * ground-truth block the coach was actually holding, hide it among K-1 DECOY blocks, and ask a
 * blind judge which block produced the line. Chance is 1/K. A line the judge cannot trace back to
 * its own game is generic BY DEFINITION — no appeal to tone required. Accuracy comes with n and a
 * Wilson interval, and the interval has to clear 1/K before anything is claimed.
 *
 * ## The asymmetry that decides how the number is read
 *
 * A line quoting an exact figure is trivially traceable: "40 CS" appears in exactly one stretch of
 * exactly one game, so the judge wins without understanding anything. That is a HUD READOUT, and a
 * readout scoring 100% would make this instrument agree with the broken one.
 *
 * So every trial is run twice: once verbatim, once with every number in the line masked
 * (`maskLine`). **The gap between the two is the measurement.** A line identifiable only through
 * its digits is a readout; a line still identifiable with the digits gone said something about
 * this game that a number alone did not carry.
 *
 * ## Two decoy pools, because "a different game" is ambiguous
 *
 * - `cross-game` — decoys from OTHER games at a similar clock. This is the literal reading of the
 *   rule in AGENTS.md. Naming the enemy jungler wins it outright, which is informative but weak:
 *   a line can be pinned to a roster and still be sayable at any minute of that game.
 * - `within-game` — decoys from the SAME game at other checkpoints, so roster is held constant and
 *   only the moment varies. This is the harder and more useful reading, and `within-game` +
 *   masked is the cell that says whether a line was a read or a readout.
 *
 * ## Getting the decoys right, or the metric is worthless
 *
 * Three confounds, each handled here rather than left to the caller:
 *
 * 1. **Clock.** A decoy from 30:00 against a true state at 4:00 is separable by level and gold
 *    alone, so `cross-game` decoys must sit inside `clockToleranceSec` of the true clock.
 * 2. **Shape.** Only ~20 of the ~300 states in a game carry a ranked fact list; the rest render
 *    "Nothing he is missing right now". If the true state has a list and the decoys do not, the
 *    judge learns "pick the one with a list" and every line looks specific. Decoys must MATCH the
 *    true state on `hasFacts`.
 * 3. **Clustering.** `within-game` decoys drawn at random land next to each other and next to the
 *    truth; `minSeparationSec` forces every option in a trial to be a genuinely different moment.
 *
 * When the constraints cannot be met the trial is REFUSED (`buildTrials` returns it in `skipped`)
 * rather than quietly relaxed — a trial with three plausible options and one absurd one is a
 * higher number that means less.
 *
 * ## What it said the first time it was run
 *
 * Nine transcript lines against nine hand-written specific ones, k=5 (chance 20%), judged by
 * `gemini-3.6-flash`, decoys from four whole recorded games:
 *
 *                            within-game/verbatim   within-game/digits masked
 *     the nine transcript          9/9  100%              4/9   44%   [19, 73]
 *     nine written to be specific  9/9  100%              8/9   89%   [56, 98]
 *
 * The transcript is perfectly traceable with its digits and indistinguishable from noise without
 * them — the empirical null, the same option sets with the lines shuffled onto the wrong ones, ran
 * 29/98 = 30%. The control set barely moves. That is the whole finding in two rows: those lines
 * carried a number and nothing else, and an instrument that only checks whether the number is real
 * cannot see it.
 *
 * Pure: no model call, no file, no clock. The judge is injected, so the whole thing is unit
 * testable against a stub judge and the script `scripts/probe-generic.ts` supplies the real one.
 */
import { normalizeNumbers, wilson } from "./coach-score.ts"
import type { Interval } from "./coach-score.ts"

/* ================================================================ the inputs */

/** One candidate: the ground-truth block for one instant of one game. */
export interface StateCard {
	/** Stable and unique across the whole pool, e.g. `split-03@0605`. */
	id: string
	/** Which game it came from. Never shown to the judge — it decides which pool a decoy is in. */
	game: string
	/** Game clock, seconds. */
	tSec: number
	/** The block exactly as `renderState` produced it. */
	block: string
	/**
	 * Whether the block carries a ranked fact list rather than "Nothing he is missing right now".
	 *
	 * This is the shape confound in confound (2) above, and it is a field rather than something
	 * derived from `block` here so the caller can compute it from the `VisionState` it already has
	 * instead of this file learning to parse its own prompt text.
	 */
	hasFacts: boolean
}

/** A line under test, and the state it was said against. */
export interface LineUnderTest {
	id: string
	/** Verbatim, exactly as it was spoken or transcribed. */
	text: string
	/** `StateCard.id` of the block the coach was holding. */
	stateId: string
	/** Free label for reporting only — e.g. `"transcript"` or `"handwritten-specific"`. */
	tag?: string
}

/**
 * How much of the line the judge gets to see.
 *
 * `digits` masks spoken numbers as well as digits, via `normalizeNumbers` — the same tested
 * conversion `coach-score` uses, so "twenty three" cannot slip past as text.
 */
export type MaskMode = "none" | "digits" | "digits+names"

export type DecoyPool = "within-game" | "cross-game"

/* ================================================================ masking */

/**
 * Blank out the parts of a line the mask hides.
 *
 * Numbers become `#` rather than disappearing, so the sentence still reads as a sentence and the
 * judge is not additionally handicapped by broken grammar — the experiment is about information,
 * not fluency. `normalizeNumbers` runs first, which means "twenty" and "20" mask identically.
 *
 * Known over-masking: `normalizeNumbers` treats the pronoun "one" as the number 1, so
 * *"that is a tough one"* becomes *"that is a tough #"*. That removes information rather than
 * adding it, which is the safe direction for a test looking for evidence of specificity.
 */
export const maskLine = (line: string, mode: MaskMode, championNames: readonly string[]): string => {
	if (mode === "none") return line
	let out = normalizeNumbers(line).replace(/\d+/g, "#")
	if (mode === "digits+names") {
		// Longest first: "Lissandra" must not be half-eaten by a shorter name that is a prefix.
		const names = [...championNames].sort((a, b) => b.length - a.length)
		for (const n of names) {
			if (n === "") continue
			out = out.replace(new RegExp(`\\b${escapeRegExp(n)}\\b`, "gi"), "«champion»")
		}
	}
	return out
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/* ================================================================ trials */

export interface Trial {
	lineId: string
	tag: string
	pool: DecoyPool
	mask: MaskMode
	/** What the judge is shown — masked. */
	prompt: string
	/** Kept for the report so a wrong answer can be read back. */
	rawLine: string
	/** Shuffled. `options[answerIndex]` is the true state. */
	options: StateCard[]
	answerIndex: number
}

export interface SkippedTrial {
	lineId: string
	pool: DecoyPool
	reason: string
}

export interface BuildTrialsOptions {
	lines: readonly LineUnderTest[]
	cards: readonly StateCard[]
	pool: DecoyPool
	masks: readonly MaskMode[]
	/** Options per trial, truth included. Chance is 1/k. */
	k?: number
	/** Champion vocabulary for `digits+names`. */
	championNames?: readonly string[]
	/** `cross-game`: how far a decoy's clock may sit from the truth's. */
	clockToleranceSec?: number
	/** `within-game`: minimum clock gap between any two options. */
	minSeparationSec?: number
	/** Anything stable. The shuffle and the decoy draw are a pure function of it. */
	seed?: string
}

/**
 * `k = 5` is the default because it puts chance at 20% — low enough that a real effect clears a
 * Wilson interval at n in the dozens, high enough that five blocks still fit in a prompt without
 * the judge losing track of which one it is reading.
 */
const DEFAULT_K = 5
/**
 * Two and a half minutes. Below that the block barely moves — CS from this client arrives rounded
 * to the nearest ten, so two states 60s apart in the early game are frequently IDENTICAL on the
 * lines a farm remark would use, and an "impossible" trial is not evidence about the line.
 */
const DEFAULT_MIN_SEPARATION_SEC = 150
/** Ninety seconds. Wide enough to find a decoy in three other games, tight enough that the clock
 * line at the top of the block is not itself the answer. */
const DEFAULT_CLOCK_TOLERANCE_SEC = 90

export const buildTrials = (
	opts: BuildTrialsOptions
): { trials: Trial[]; skipped: SkippedTrial[] } => {
	const k = opts.k ?? DEFAULT_K
	const tol = opts.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC
	const sep = opts.minSeparationSec ?? DEFAULT_MIN_SEPARATION_SEC
	const seed = opts.seed ?? "discriminability"
	const names = opts.championNames ?? []
	const byId = new Map(opts.cards.map(c => [c.id, c]))

	const trials: Trial[] = []
	const skipped: SkippedTrial[] = []

	for (const line of opts.lines) {
		const truth = byId.get(line.stateId)
		if (!truth) {
			skipped.push({ lineId: line.id, pool: opts.pool, reason: `no card ${line.stateId}` })
			continue
		}
		const decoys = pickDecoys(truth, opts.cards, opts.pool, k - 1, { tol, sep }, `${seed}:${line.id}`)
		if (decoys.length < k - 1) {
			skipped.push({
				lineId: line.id,
				pool: opts.pool,
				reason: `only ${decoys.length} of ${k - 1} plausible decoys (hasFacts=${truth.hasFacts}, t=${truth.tSec}s)`
			})
			continue
		}
		/*
		 * ONE option set per line, reused across masks. Varying the decoys between the masked and
		 * unmasked arms would mean the gap between them mixed "the digits were removed" with "the
		 * decoys got easier", and the gap is the whole finding.
		 */
		const options = shuffle([truth, ...decoys], `${seed}:${line.id}:shuffle`)
		const answerIndex = options.indexOf(truth)
		for (const mask of opts.masks)
			trials.push({
				lineId: line.id,
				tag: line.tag ?? "",
				pool: opts.pool,
				mask,
				prompt: maskLine(line.text, mask, names),
				rawLine: line.text,
				options,
				answerIndex
			})
	}
	return { trials, skipped }
}

/**
 * Decoys that are plausible on their face, so the judge has to read the game and not the frame.
 *
 * `hasFacts` is matched exactly in both pools — see confound (2) in the header. `cross-game`
 * additionally takes at most one card per game before allowing a second from any of them, so a
 * four-option trial spans the games available rather than stacking three near-identical ticks of
 * whichever game happens to be longest.
 */
const pickDecoys = (
	truth: StateCard,
	cards: readonly StateCard[],
	pool: DecoyPool,
	want: number,
	limits: { tol: number; sep: number },
	seed: string
): StateCard[] => {
	const eligible = cards.filter(c => {
		if (c.id === truth.id) return false
		if (c.hasFacts !== truth.hasFacts) return false
		if (pool === "within-game")
			return c.game === truth.game && Math.abs(c.tSec - truth.tSec) >= limits.sep
		return c.game !== truth.game && Math.abs(c.tSec - truth.tSec) <= limits.tol
	})

	const order = shuffle(eligible, seed)
	const chosen: StateCard[] = []
	const gamesUsed = new Set<string>()
	// Two passes for cross-game (one per game, then fill); one pass is enough within a game.
	const passes = pool === "cross-game" ? 2 : 1
	for (let pass = 0; pass < passes && chosen.length < want; pass++)
		for (const c of order) {
			if (chosen.length >= want) break
			if (chosen.includes(c)) continue
			if (pass === 0 && pool === "cross-game" && gamesUsed.has(c.game)) continue
			// Every option must be a different moment from every other, not just from the truth.
			if (pool === "within-game" && chosen.some(o => Math.abs(o.tSec - c.tSec) < limits.sep))
				continue
			chosen.push(c)
			gamesUsed.add(c.game)
		}
	return chosen
}

/* ================================================================ the judge's prompt */

export const LETTERS = "ABCDEFGH"

/**
 * The question, worded to keep the floor at chance.
 *
 * It says outright to guess when unsure. An abstaining judge would push accuracy below 1/K and
 * make a generic line look WORSE than random, which is not a number anyone can interpret; a forced
 * choice keeps the null exactly 1/K and the interval honest.
 *
 * It also says nothing about coaching, quality or usefulness. A judge told the line might be
 * "generic" would start rating it, and this measurement only works while the judge is doing an
 * identification task it can succeed or fail at.
 */
export const renderJudgePrompt = (t: Trial): string => {
	const blocks = t.options
		.map((o, i) => `### STATE ${LETTERS[i]}\n\n${o.block}`)
		.join("\n\n---\n\n")
	return `Below are ${t.options.length} snapshots of a League of Legends game, each taken at one instant. They are labelled ${t.options
		.map((_, i) => LETTERS[i])
		.join(", ")}.

Exactly ONE of them is the snapshot a coach was looking at when he said this sentence out loud:

"${t.prompt}"

Some sentences will match one snapshot obviously. Others will fit several, or none. Pick the single most likely one anyway — you must answer, and if you have no basis at all, guess.

${blocks}

Answer with one letter (${t.options.map((_, i) => LETTERS[i]).join(", ")}) and nothing else.`
}

/**
 * The letter a judge chose, or null when it produced nothing usable.
 *
 * Deliberately strict: the FIRST standalone in-range letter wins, so a model that reasons before
 * answering is not scored on the letter it mentioned while thinking it through. A null is reported
 * as a judge failure, never as a wrong answer — silently counting a parse failure as an error
 * would make an unreliable judge look like a generic line.
 */
export const parseChoice = (text: string, k: number): number | null => {
	const allowed = LETTERS.slice(0, k)
	const m = text.match(new RegExp(`\\b([${allowed}])\\b`))
	if (!m) return null
	return allowed.indexOf(m[1]!)
}

/* ================================================================ running */

export interface Judgement {
	trial: Trial
	/** What the judge picked, or null when it could not be parsed. */
	choice: number | null
	correct: boolean
}

/** Anything that can answer a rendered prompt with a letter. Injected so this file stays pure. */
export type Judge = (prompt: string) => Promise<string>

export const runTrials = async (
	trials: readonly Trial[],
	judge: Judge,
	onEach?: (j: Judgement) => void
): Promise<Judgement[]> => {
	const out: Judgement[] = []
	for (const t of trials) {
		let text = ""
		try {
			text = await judge(renderJudgePrompt(t))
		} catch (e) {
			text = ""
			void e
		}
		const choice = parseChoice(text, t.options.length)
		const j: Judgement = { trial: t, choice, correct: choice === t.answerIndex }
		out.push(j)
		onEach?.(j)
	}
	return out
}

/* ================================================================ reporting */

export interface Cell {
	pool: DecoyPool
	mask: MaskMode
	tag: string
	k: number
	n: number
	hits: number
	accuracy: number
	interval: Interval
	chance: number
	/** True only when the whole interval sits above chance. The only claim worth making. */
	aboveChance: boolean
	/** Judge failures, excluded from n. A cell with many of these is not a measurement. */
	unparsed: number
}

/**
 * Accuracy per (pool, mask, tag), with the interval and the null side by side.
 *
 * `aboveChance` is the Wilson LOWER bound clearing 1/K, not the point estimate clearing it. With
 * nine lines in one cell the point estimate moves by 11 points per line, so a bare "56%" against a
 * 20% null is not yet evidence of anything.
 */
export const summarize = (judgements: readonly Judgement[]): Cell[] => {
	const groups = new Map<string, Judgement[]>()
	for (const j of judgements) {
		const key = `${j.trial.pool}|${j.trial.mask}|${j.trial.tag}`
		const g = groups.get(key)
		if (g) g.push(j)
		else groups.set(key, [j])
	}
	const cells: Cell[] = []
	for (const [key, g] of groups) {
		const [pool, mask, tag] = key.split("|") as [DecoyPool, MaskMode, string]
		const scored = g.filter(j => j.choice !== null)
		const hits = scored.filter(j => j.correct).length
		const k = g[0]!.trial.options.length
		const interval = wilson(hits, scored.length)
		const chance = 1 / k
		cells.push({
			pool,
			mask,
			tag,
			k,
			n: scored.length,
			hits,
			accuracy: scored.length === 0 ? 0 : hits / scored.length,
			interval,
			chance,
			aboveChance: scored.length > 0 && interval.lo > chance,
			unparsed: g.length - scored.length
		})
	}
	return cells.sort((a, b) => `${a.tag}${a.pool}${a.mask}`.localeCompare(`${b.tag}${b.pool}${b.mask}`))
}

/**
 * How often each position was chosen.
 *
 * A judge that always answers "A" scores 1/K and looks exactly like a room full of generic lines.
 * This is the check that tells those two apart, and it is cheap enough that there is no excuse for
 * publishing an accuracy without it.
 */
export const positionBias = (judgements: readonly Judgement[]): number[] => {
	const counts: number[] = []
	for (const j of judgements) {
		if (j.choice === null) continue
		counts[j.choice] = (counts[j.choice] ?? 0) + 1
	}
	for (let i = 0; i < counts.length; i++) counts[i] = counts[i] ?? 0
	return counts
}

/**
 * The same option sets with the lines shuffled onto the wrong ones.
 *
 * The empirical null, and the number every accuracy here should be read against rather than 1/K.
 *
 * If it does not land near 1/K then something about the option sets — not the lines — is doing the
 * work. Measured on the first run it came out at 29/98 = 30% against a 20% theoretical chance, and
 * that gap is real rather than a defect: a donor line is drawn from the same cell, and when a
 * fixture holds near-duplicate lines said seconds apart, a "wrong" line genuinely does fit the
 * block it lands on. Which is itself the property being measured. Quote the empirical figure.
 *
 * It reuses the exact prompts and option sets, so the only difference from the real arm is which
 * line goes with which set.
 */
export const scrambleTrials = (trials: readonly Trial[], seed = "scramble"): Trial[] => {
	/*
	 * Donors come from the SAME (pool, mask) cell, and the cell's own permutation is rotated so no
	 * trial can donate to itself.
	 *
	 * Scrambling across the whole set would put an unmasked line onto a masked trial and a
	 * cross-game line onto a within-game option set, which makes the null a mixture of conditions
	 * rather than the null for the condition it is being compared against.
	 */
	const cells = new Map<string, number[]>()
	trials.forEach((t, i) => {
		const key = `${t.pool}|${t.mask}`
		const g = cells.get(key)
		if (g) g.push(i)
		else cells.set(key, [i])
	})
	const donorOf = new Map<number, number>()
	for (const [key, idx] of cells) {
		const order = shuffle(idx, `${seed}:${key}`)
		// A rotation of a permutation is a derangement of it: position j takes position j+1's line.
		order.forEach((i, j) => donorOf.set(i, order[(j + 1) % order.length]!))
	}
	return trials.map((t, i) => {
		const donor = trials[donorOf.get(i) ?? i]!
		return { ...t, lineId: `${donor.lineId}~scrambled`, prompt: donor.prompt, rawLine: donor.rawLine }
	})
}

/* ================================================================ determinism */

/**
 * A seeded shuffle, so a run is reproducible from its seed alone.
 *
 * `Math.random` here would mean two runs of the same script could not be compared, and the first
 * thing anyone does with a number like this is run it again.
 */
export const shuffle = <T>(items: readonly T[], seed: string): T[] => {
	const rng = mulberry32(hash(seed))
	const out = [...items]
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1))
		const a = out[i]!
		out[i] = out[j]!
		out[j] = a
	}
	return out
}

const hash = (s: string): number => {
	let h = 2166136261
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 16777619)
	}
	return h >>> 0
}

const mulberry32 = (a: number) => () => {
	a = (a + 0x6d2b79f5) >>> 0
	let t = a
	t = Math.imul(t ^ (t >>> 15), t | 1)
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
