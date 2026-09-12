/**
 * THE shared measurement primitives for `scripts/`. One implementation each, one place.
 *
 * Two things live here, and they are here for the same reason: both were written more than once,
 * and a second copy of either lets the repo quote two different numbers for one question.
 *
 * Wilson lives in `src/analysis/coach-score.ts` because the scorer ships it; this file is the
 * other half — the test that says whether a DIFFERENCE between two arms survives.
 *
 * ## Why it is here rather than in a harness
 *
 * It was written twice. `frame-value.ts` had `mcnemar(pairs)` and `adjudicate.ts` had
 * `mcnemarExact(a, b)`: the same two-sided exact binomial at p = 0.5 over the discordant pairs,
 * reached by two different summations, each with its own unit test. `compare-arms.ts` then
 * imported one of them FROM a harness, which is the import direction `scripts/README.md` rule 2
 * exists to forbid — a driver that imports a driver drags the whole run with it.
 *
 * Two implementations of one p-value is not a redundancy, it is a place where the repo can quote
 * two different numbers for the same comparison and nobody would know which was run.
 *
 * Both call shapes are kept because both are the natural one at their call site: an ablation has
 * the pairs, an adjudication has already counted the disagreements.
 */

/* ==================================================================== blinding */

/**
 * A seeded shuffle, so "shuffled" means the same thing on a re-run.
 *
 * Every blinded harness here writes its seed into its key file so a second judging pass over the
 * same run sees the lines in the same order and the two passes can be compared line for line. That
 * only holds while there is ONE shuffle: this was written twice, byte-identical in behaviour but
 * not in source, as `blind-judge.ts`'s `shuffled` and `frame-value.ts`'s `shuffledBy`. Checked
 * before they were merged — 549 cases, lengths 0-60 against nine seeds spanning the u32 range,
 * zero disagreements — so every stored run's ordering is re-derivable from this function.
 *
 * mulberry32 over a Fisher-Yates walking down. Do not "improve" either half: the generator and the
 * direction of the loop are both part of the stored orderings, and changing one silently makes
 * every key file in `data/eval/` describe an order this code can no longer reproduce.
 *
 * `bench-stream.ts` deliberately keeps its own: it seeds from a STRING and uses a plain LCG, so its
 * sheets are re-derivable against a different sequence. Merging the two would rewrite that history.
 */
export const shuffled = <T,>(items: readonly T[], seed: number): T[] => {
	let a = seed >>> 0
	const rand = (): number => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
	const out = [...items]
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1))
		;[out[i], out[j]] = [out[j]!, out[i]!]
	}
	return out
}

/* ==================================================================== paired comparison */

/** The 2x2 of a paired comparison, plus the exact p-value on its discordant cells. */
export interface McNemar {
	/** a preferred, b preferred, and how many turns were decided the same way by both. */
	aOnly: number
	bOnly: number
	both: number
	neither: number
	p: number
}

/** log(n choose k), summed rather than via factorials so n in the hundreds does not overflow. */
const logChoose = (n: number, k: number): number => {
	let r = 0
	for (let i = 1; i <= k; i++) r += Math.log(n - k + i) - Math.log(i)
	return r
}

/**
 * Two-sided exact binomial at p = 0.5 on `a` and `b` discordant pairs — McNemar's exact test.
 *
 * Exact rather than the chi-square approximation because the discordant counts here are routinely
 * under ten, which is exactly where the approximation's p-value is optimistic.
 */
export const mcnemarExact = (a: number, b: number): number => {
	const n = a + b
	if (n === 0) return 1
	const lo = Math.min(a, b)
	let tail = 0
	for (let k = 0; k <= lo; k++) tail += Math.exp(logChoose(n, k) - n * Math.LN2)
	return Math.min(1, 2 * tail)
}

/** The same test from the raw pairs, carrying the 2x2 the reader has to see beside the p. */
export const mcnemar = (pairs: readonly { a: boolean; b: boolean }[]): McNemar => {
	const aOnly = pairs.filter(x => x.a && !x.b).length
	const bOnly = pairs.filter(x => !x.a && x.b).length
	const both = pairs.filter(x => x.a && x.b).length
	const neither = pairs.filter(x => !x.a && !x.b).length
	return { aOnly, bOnly, both, neither, p: mcnemarExact(aOnly, bOnly) }
}
