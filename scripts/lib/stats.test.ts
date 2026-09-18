/**
 * The seeded shuffle, pinned — because it is now load-bearing for history, not just for a run.
 *
 * `shuffled` decides the order a blinded judge saw the lines in, and every blinded harness writes
 * its seed into its key file instead of the order itself. So the key files in `data/eval/` are only
 * re-readable while this function returns what it returned when they were written: change the
 * generator, or the direction of the Fisher-Yates walk, and every stored run silently starts
 * describing an order nothing can reproduce. Nothing else in the repo would fail.
 *
 * The orderings below were taken from the implementation this file merged — `blind-judge.ts`'s
 * `shuffled`, which wrote the stored runs — not from the merged copy, so they check the merge
 * rather than merely restating it. Seeds cover both ends of the u32 range because the harnesses
 * seed from `turn.index * 7919 + 13` and from FNV hashes, which reach the top of it.
 *
 * If one of these fails, the answer is NOT to update the expectation.
 */
import { deepStrictEqual, ok } from "node:assert/strict"
import { test } from "node:test"
import {
	benjaminiHochberg,
	bootstrap2,
	cohensD,
	logisticFit,
	mannWhitney,
	meanOf,
	mulberry32,
	normalCdf,
	sdOf,
	shuffled
} from "./stats.ts"

const upTo = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

test("shuffled reproduces the orderings the stored key files were written against", () => {
	deepStrictEqual(shuffled(upTo(8), 13), [1, 6, 3, 7, 5, 0, 2, 4])
	deepStrictEqual(shuffled(upTo(8), 7932), [3, 1, 2, 0, 5, 6, 7, 4])
	deepStrictEqual(shuffled(upTo(12), 42), [2, 0, 5, 10, 9, 11, 3, 1, 6, 8, 4, 7])
	deepStrictEqual(shuffled(upTo(5), 4294967295), [3, 1, 2, 0, 4])
	deepStrictEqual(shuffled(upTo(3), 0), [1, 2, 0])
})

test("shuffled is a permutation, and does not touch its input", () => {
	for (let n = 0; n <= 40; n++) {
		const items = upTo(n)
		const out = shuffled(items, n * 7919 + 13)
		deepStrictEqual(items, upTo(n))
		deepStrictEqual([...out].sort((a, b) => a - b), items)
	}
})

test("the same seed gives the same order twice, and different seeds generally do not", () => {
	const items = upTo(24)
	deepStrictEqual(shuffled(items, 99), shuffled(items, 99))
	const distinct = new Set(
		Array.from({ length: 40 }, (_, s) => shuffled(items, s).join(","))
	)
	// A collision here would mean the seed is not reaching the generator.
	deepStrictEqual(distinct.size, 40)
})

/* ============================================ the unpaired primitives, pinned against hand values */

test("normalCdf hits the textbook points", () => {
	// The erfc rational approximation is good to about 1.2e-7, so nothing here is checked tighter.
	ok(Math.abs(normalCdf(0) - 0.5) < 1e-7)
	ok(Math.abs(normalCdf(1.959964) - 0.975) < 1e-6)
	ok(Math.abs(normalCdf(-1.959964) - 0.025) < 1e-6)
	ok(Math.abs(normalCdf(1) - 0.8413447) < 1e-6)
	// Symmetry, which the erfc branch is the only thing that could break.
	for (const z of [0.3, 1.1, 2.7, 4.2]) ok(Math.abs(normalCdf(z) + normalCdf(-z) - 1) < 1e-7)
})

test("mannWhitney reproduces U and the AUC computed by hand, ties included", () => {
	// Ranks 1..6 interleaved: R1 = 1 + 3 + 5 = 9, U = 9 - 6 = 3, AUC = 3 / 9.
	const interleaved = mannWhitney([1, 3, 5], [2, 4, 6])
	ok(Math.abs(interleaved.u - 3) < 1e-9)
	ok(Math.abs(interleaved.auc - 1 / 3) < 1e-9)
	// Midranks: the three 1s share rank 2, the three 2s share rank 5. R1 = 2 + 2 + 5 = 9.
	const tied = mannWhitney([1, 1, 2], [1, 2, 2])
	ok(Math.abs(tied.u - 3) < 1e-9)
	ok(Math.abs(tied.auc - 1 / 3) < 1e-9)
	// Complete separation one way and the other, and the sign of the effect size with it.
	deepStrictEqual(mannWhitney([5, 6, 7, 8], [1, 2, 3, 4]).auc, 1)
	deepStrictEqual(mannWhitney([1, 2, 3, 4], [5, 6, 7, 8]).auc, 0)
	deepStrictEqual(mannWhitney([5, 6, 7, 8], [1, 2, 3, 4]).rankBiserial, 1)
	// Two identical samples separate nowhere and must never report a significant p.
	const same = mannWhitney([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])
	ok(Math.abs(same.auc - 0.5) < 1e-9)
	deepStrictEqual(same.p, 1)
	// An empty arm is a missing measurement, not a finding.
	deepStrictEqual(mannWhitney([], [1, 2, 3]).p, 1)
})

test("mannWhitney's p-value lands where a two-sided rank test should", () => {
	// Ten against ten, fully separated: z is large and p is tiny but never negative or above 1.
	const wide = mannWhitney(
		Array.from({ length: 10 }, (_, i) => 100 + i),
		Array.from({ length: 10 }, (_, i) => i)
	)
	ok(wide.p < 0.001)
	ok(wide.p > 0)
	// Shifting BOTH arms by the same constant is a rank-invariant operation.
	const a = [3, 9, 1, 7, 5]
	const b = [4, 2, 8, 6, 10]
	const base = mannWhitney(a, b)
	const shifted = mannWhitney(a.map(x => x * 3 + 11), b.map(x => x * 3 + 11))
	deepStrictEqual(base.p, shifted.p)
	deepStrictEqual(base.auc, shifted.auc)
})

test("benjaminiHochberg returns q-values in input order, monotone in the sorted p", () => {
	// Five p-values on the BH line: every q comes out at 0.05.
	const line = benjaminiHochberg([0.01, 0.02, 0.03, 0.04, 0.05])
	for (const q of line) ok(Math.abs(q - 0.05) < 1e-12)
	// Input order is preserved: the smallest p keeps the smallest q wherever it sits.
	const q = benjaminiHochberg([0.5, 0.0001, 0.9])
	ok(q[1]! < q[0]!)
	ok(q[0]! <= q[2]!)
	// A q never exceeds 1, and an empty table is empty rather than a crash.
	for (const v of benjaminiHochberg([0.9, 0.95, 0.99])) ok(v <= 1)
	deepStrictEqual(benjaminiHochberg([]), [])
})

test("bootstrap2 is seeded, brackets its own point estimate, and never moves the group sizes", () => {
	const a = [5, 6, 7, 8, 9, 10, 11, 12]
	const b = [1, 2, 3, 4, 5, 6, 7, 8]
	const stat = (x: readonly number[], y: readonly number[]): number => meanOf(x) - meanOf(y)
	const first = bootstrap2(a, b, stat, 7, 800)
	const again = bootstrap2(a, b, stat, 7, 800)
	deepStrictEqual(first, again)
	ok(first.lo <= first.point && first.point <= first.hi)
	// A different seed moves the interval a little and the point estimate not at all.
	deepStrictEqual(bootstrap2(a, b, stat, 8, 800).point, first.point)
	// Too few observations to resample: a point estimate with no interval, rather than a fake one.
	ok(Number.isNaN(bootstrap2([1], [2], stat, 7, 800).lo))
})

test("logisticFit recovers a coefficient it was given, and calls a noise column null", () => {
	// One informative predictor and one pure-noise predictor, both standardised by the fit.
	const rand = mulberry32(4242)
	const n = 600
	const signal: number[] = []
	const noise: number[] = []
	const y: number[] = []
	for (let i = 0; i < n; i++) {
		const s = rand() * 4 - 2
		const z = rand() * 4 - 2
		signal.push(s)
		noise.push(z)
		const p = 1 / (1 + Math.exp(-(0.9 * s)))
		y.push(rand() < p ? 1 : 0)
	}
	const fit = logisticFit(
		[
			{ name: "signal", values: signal },
			{ name: "noise", values: noise }
		],
		y
	)
	ok(fit.converged)
	const [sig, noi] = fit.terms
	// beta is per SD; a uniform(-2,2) has sd ~1.155, so 0.9 per unit is ~1.04 per SD.
	ok(sig!.beta > 0.7 && sig!.beta < 1.4)
	ok(sig!.p < 0.001)
	ok(sig!.orLo > 1)
	// The noise column must not be called: its interval has to straddle an odds ratio of 1.
	ok(noi!.orLo < 1 && noi!.orHi > 1)
	ok(noi!.p > 0.05)
})

test("cohensD and sdOf agree with the hand calculation", () => {
	// Sample SD (n-1) of the textbook eight-point set: sqrt(32 / 7).
	ok(Math.abs(sdOf([2, 4, 4, 4, 5, 5, 7, 9]) - Math.sqrt(32 / 7)) < 1e-12)
	deepStrictEqual(cohensD([1, 2, 3], [1, 2, 3]), 0)
	ok(cohensD([10, 11, 12], [1, 2, 3]) > 3)
	ok(Number.isNaN(cohensD([1], [1, 2])))
})
