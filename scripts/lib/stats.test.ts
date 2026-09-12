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
import { deepStrictEqual } from "node:assert/strict"
import { test } from "node:test"
import { shuffled } from "./stats.ts"

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
