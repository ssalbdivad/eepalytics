/**
 * The paired test, checked against hand-computed exact binomials.
 *
 * `mcnemar` is the only piece of arithmetic `frame-value.ts` owns that a reader cannot check by
 * eye, and it is the number the recommendation turns on: with 30 turns per arm, two independent
 * Wilson intervals will call almost anything "not separated", so if the paired test is wrong the
 * script will either invent an effect or hide one. Every expectation below is the closed form
 * written out, not a figure copied from a run.
 */
import { deepStrictEqual, ok } from "node:assert/strict"
import { test } from "node:test"
import { mcnemar } from "./frame-value.ts"

const pairs = (a: number, b: number, both: number, neither: number) => [
	...Array.from({ length: a }, () => ({ a: true, b: false })),
	...Array.from({ length: b }, () => ({ a: false, b: true })),
	...Array.from({ length: both }, () => ({ a: true, b: true })),
	...Array.from({ length: neither }, () => ({ a: false, b: false }))
]

test("no discordant turns is no evidence either way", () => {
	const r = mcnemar(pairs(0, 0, 9, 4))
	deepStrictEqual([r.aOnly, r.bOnly, r.both, r.neither], [0, 0, 9, 4])
	deepStrictEqual(r.p, 1)
})

test("a clean sweep of ten discordant turns: p = 2 / 2^10", () => {
	const r = mcnemar(pairs(0, 10, 5, 5))
	deepStrictEqual(r.bOnly, 10)
	// two-sided exact binomial, k = 0 of 10 at one half
	ok(Math.abs(r.p - 2 / 1024) < 1e-12, `${r.p}`)
})

test("six against two: two-sided tail is 2 * (1 + 8 + 28) / 256", () => {
	const r = mcnemar(pairs(2, 6, 3, 3))
	ok(Math.abs(r.p - (2 * 37) / 256) < 1e-12, `${r.p}`)
})

test("an even split is exactly p = 1, never above it", () => {
	const r = mcnemar(pairs(4, 4, 0, 0))
	ok(r.p <= 1 && r.p > 0.99, `${r.p}`)
})

test("the concordant turns do not move the p-value", () => {
	const thin = mcnemar(pairs(1, 7, 0, 0))
	const padded = mcnemar(pairs(1, 7, 40, 40))
	deepStrictEqual(thin.p, padded.p)
	// ...and they DO move what a naive rate comparison would say, which is the whole point of
	// preferring this over two independent intervals on the same data.
	ok(padded.both === 40 && padded.neither === 40)
})
