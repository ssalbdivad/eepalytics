/**
 * The transport plan. These tests are the guard on the one promise this change makes:
 * **the WSL path does not move.**
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import type { EnvironmentFacts } from "./environment.ts"
import { describePlan, planTransports } from "./select.ts"

const WSL: EnvironmentFacts = {
	kind: "wsl",
	isWsl: true,
	interopPossible: true,
	directPlausible: "unknown",
	signals: ["kernel:microsoft"]
}

const WINDOWS: EnvironmentFacts = {
	kind: "windows",
	isWsl: false,
	interopPossible: false,
	directPlausible: "yes",
	signals: ["platform=win32"]
}

const LINUX: EnvironmentFacts = {
	kind: "linux",
	isWsl: false,
	interopPossible: false,
	directPlausible: "yes",
	signals: ["platform=linux"]
}

const kinds = (facts: EnvironmentFacts, preferred?: "bridge" | "curl" | "direct"): string[] =>
	planTransports(preferred, facts).map(c => c.kind)

describe("planTransports", () => {
	it("keeps WSL on bridge → curl, with the default setting", () => {
		deepStrictEqual(kinds(WSL, "bridge"), ["bridge", "curl", "direct"])
	})

	it("never lets WSL take direct without proof", () => {
		const direct = planTransports("bridge", WSL).find(c => c.kind === "direct")
		ok(direct)
		ok(
			direct!.requireProof,
			"WSL2 NAT cannot reach the Windows loopback; choosing direct on a guess strands the daemon"
		)
	})

	it("puts direct last in WSL even though it is the fastest where it works", () => {
		strictEqual(kinds(WSL, "bridge").indexOf("direct"), 2)
	})

	it("honours an explicit curl preference without dropping the others", () => {
		deepStrictEqual(kinds(WSL, "curl"), ["curl", "bridge", "direct"])
	})

	it("honours an explicit direct preference in WSL, and then stops demanding proof", () => {
		const plan = planTransports("direct", WSL)
		deepStrictEqual(
			plan.map(c => c.kind),
			["direct", "bridge", "curl"]
		)
		strictEqual(plan[0]!.requireProof, false, "asked for by name is its own evidence")
	})

	it("offers only direct on native Windows — the others are impossible, not slow", () => {
		deepStrictEqual(kinds(WINDOWS, "bridge"), ["direct"])
		strictEqual(planTransports("bridge", WINDOWS)[0]!.requireProof, false)
	})

	it("ignores a stale bridge preference on Windows rather than failing to start", () => {
		// Every existing install has `transport: "bridge"` saved. On a fresh Windows machine that
		// default names a transport with no /mnt/c to use; it must not be treated as a command.
		deepStrictEqual(kinds(WINDOWS, "bridge"), ["direct"])
	})

	it("offers only direct on a plain Linux box too", () => {
		deepStrictEqual(kinds(LINUX, "curl"), ["direct"])
	})

	it("never returns an empty plan", () => {
		for (const facts of [WSL, WINDOWS, LINUX])
			for (const preferred of ["bridge", "curl", "direct", undefined] as const)
				ok(planTransports(preferred, facts).length > 0)
	})

	it("describes itself for the log, marking which candidate needs proof", () => {
		strictEqual(describePlan(planTransports("bridge", WSL)), "bridge → curl → direct(if proved)")
		strictEqual(describePlan(planTransports("bridge", WINDOWS)), "direct")
	})
})
