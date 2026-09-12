/**
 * THE paired-comparison statistics for `scripts/`. One exact test, one place.
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
