/**
 * The ban list is re-derived from the judged corpus every time this suite runs.
 *
 * `DIRECTIVE_EVIDENCE` is a table in a source file, which is the easiest kind of measurement to
 * quietly falsify: a regex edited six weeks from now moves every family in it and nothing complains.
 * So the numbers in that table are not asserted against themselves. They are recomputed here from
 * `data/eval/offered/`, `data/eval/retired/` and `data/eval/judge-r3/` — the two blind sheets, the
 * two independent hand passes, and the third pass over both — and a classifier change that alters
 * what the ban costs fails the suite rather than shipping.
 *
 * The other half of the file is the TRAP. "Take dragon" is an order he could give himself and
 * "take dragon, Lissandra is down and it has stood free for two minutes" is the best line this app
 * has produced; both are `objective` and neither is banned, because the thing that separates them
 * is the premise and this file only reads the order. Those cases are pinned so a future ban on the
 * objective verb has to break a test to happen.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
	BANNED_DIRECTIVES,
	DIRECTIVE_EVIDENCE,
	classifyDirective,
	imperativeOf,
	isBannedDirective
} from "./directive.ts"
import type { DirectiveFamily } from "./directive.ts"

/* ------------------------------------------------------------------ the corpus */

interface Judged {
	line: string
	/** The pass that graded each round as it was run. */
	a: string
	/** The independent pass that re-graded both rounds under one rubric. */
	b: string
}

/** Every judged line from rounds 2 and 3, with both blind verdicts attached. */
const corpus = (): Judged[] => {
	const r3 = JSON.parse(readFileSync("data/eval/judge-r3/verdicts.json", "utf8"))
	const second = new Map<string, string>()
	for (const [id, verdict] of [...r3.round3, ...r3.round2] as [string, string, string][]) second.set(id, verdict)
	const out: Judged[] = []
	for (const [keyPath, handPath] of [
		["data/eval/offered/blind-key.json", "data/eval/offered/hand-verdicts.json"],
		["data/eval/retired/blind-key.json", "data/eval/retired/hand-verdicts.json"]
	]) {
		const key = new Map<string, { line: string }>(
			(JSON.parse(readFileSync(keyPath!, "utf8")) as { blindId: string; line: string }[]).map(k => [k.blindId, k])
		)
		for (const [id, verdict] of JSON.parse(readFileSync(handPath!, "utf8")).graded as [string, string, string][])
			out.push({ line: key.get(id)!.line, a: verdict, b: second.get(id) ?? "" })
	}
	return out
}

/**
 * Round 1's earlier hand pass, which chose none of these families.
 *
 * Its rubric is not the current one — it carries a `repeat` verdict of its own — so it is used only
 * where a ZERO has to survive a reader who never saw this question.
 */
const heldOut = (): { line: string; verdict: string }[] =>
	JSON.parse(readFileSync("data/eval/briefing-frames/human-verdicts.json", "utf8")).lines

/* ---------------------------------------------------------------- the measurement */

describe("the ban list is what the judged corpus says it is", () => {
	it("recomputes the evidence table from the two blind passes", () => {
		const rows = corpus()
		assert.equal(rows.length, 214, "the judged corpus changed size")
		const counted = new Map<DirectiveFamily, { n: number; clears: number; clearsB: number }>()
		for (const r of rows) {
			const f = classifyDirective(r.line)
			const c = counted.get(f) ?? { n: 0, clears: 0, clearsB: 0 }
			c.n++
			if (r.a === "clears") c.clears++
			if (r.b === "clears") c.clearsB++
			counted.set(f, c)
		}
		for (const row of DIRECTIVE_EVIDENCE) {
			const got = counted.get(row.family)
			assert.deepEqual(
				{ family: row.family, n: got?.n ?? 0, clears: got?.clears ?? 0, clearsB: got?.clearsB ?? 0 },
				{ family: row.family, n: row.n, clears: row.clears, clearsB: row.clearsB },
				`${row.family} no longer measures what the doc comment claims`
			)
		}
		// Nothing classified outside the table — a new family would be an unmeasured ban candidate.
		assert.deepEqual(
			[...counted.keys()].filter(f => !DIRECTIVE_EVIDENCE.some(r => r.family === f)),
			[]
		)
	})

	/*
	 * The claim the whole module rests on, and the only one that would make the ban a mistake.
	 *
	 * A denominator cut is worth having only if the numerator survives it. Two judges, 132 silenced
	 * lines, zero of them cleared: if a regex ever starts eating a good line, this is where it shows.
	 */
	it("silences no line either judge cleared", () => {
		const silenced = corpus().filter(r => isBannedDirective(r.line))
		assert.equal(silenced.length, 132, "the ban's reach moved")
		assert.deepEqual(
			silenced.filter(r => r.a === "clears" || r.b === "clears").map(r => r.line),
			[]
		)
	})

	it("leaves the kept half twice as useful as the whole", () => {
		const rows = corpus()
		const kept = rows.filter(r => !isBannedDirective(r.line))
		const rate = (set: Judged[], k: "a" | "b") => set.filter(r => r[k] === "clears").length / set.length
		// Same useful lines, far fewer sentences: the numerator is untouched by construction above.
		assert.equal(kept.length, 82)
		assert.ok(rate(kept, "a") > 2 * rate(rows, "a") - 0.01, "judge A's kept rate stopped doubling")
		assert.ok(rate(kept, "b") > 2 * rate(rows, "b") - 0.01, "judge B's kept rate stopped doubling")
	})

	/* The biggest family, on lines chosen by nobody in this file. */
	it("holds up on the round nobody picked these families from", () => {
		const camps = heldOut().filter(l => classifyDirective(l.line) === "clear-camps")
		assert.equal(camps.length, 32)
		assert.deepEqual(camps.filter(l => l.verdict === "clears"), [])
	})

	/*
	 * The disagreement, pinned rather than smoothed. Round 1 cleared three gold lines and the
	 * current judge cleared none of thirty-six; if that ever stops being three, the ban on
	 * `spend-gold` is worth re-arguing.
	 */
	it("records what banning gold costs if the earlier reader was right", () => {
		const gold = heldOut().filter(l => classifyDirective(l.line) === "spend-gold")
		assert.equal(gold.length, 21)
		assert.equal(gold.filter(l => l.verdict === "clears").length, 3)
		for (const l of gold.filter(l => l.verdict === "clears"))
			assert.match(l.line, /before .*spawns|before it spawns/, "the cleared gold lines stopped being objective-timed")
	})
})

/* ------------------------------------------------------------------- the trap */

describe("the order is read, and the premise is left alone", () => {
	it("keeps both halves of the dragon trap in one unbanned family", () => {
		const bare = "Path to the pit and take dragon."
		const earned = "Lissandra is down and dragon has stood free for 2 minutes, so path to the pit and take it."
		assert.equal(classifyDirective(bare), "objective")
		assert.equal(classifyDirective(earned), "objective")
		assert.equal(isBannedDirective(bare), false)
		assert.equal(isBannedDirective(earned), false)
	})

	/* The judge's own convention: two orders, graded on the first. */
	it("grades a compound line on its first imperative", () => {
		assert.equal(classifyDirective("You have 1923 gold, so spend it and set up for Baron."), "spend-gold")
		assert.equal(classifyDirective("Briar is down, so ping Baron and start it with your team."), "objective")
		assert.equal(classifyDirective("With Urgot down, pull back and clear your jungle camps."), "disengage")
	})

	/* A fact that orders nothing cannot carry a banned order, whatever its subject. */
	it("reads no order out of a bare fact", () => {
		for (const fact of [
			"Drake is back in 10 seconds",
			"1017 gold sitting unspent",
			"they have taken 2 of the objectives and you have taken none",
			"you're roughly 31 CS down on your own pace"
		]) {
			assert.equal(classifyDirective(fact), "none", fact)
			assert.equal(isBannedDirective(fact), false, fact)
		}
	})

	it("resolves an elided object from the line the order came in", () => {
		// "finish the next" is a camp; the clause alone cannot say so and the sentence can.
		assert.equal(classifyDirective("you're roughly 31 CS down on your own pace — that is an interrupted route, so finish the next"), "clear-camps")
		assert.equal(classifyDirective("Baron has been up 7 minutes and nobody has taken it, so bring someone"), "objective")
	})

	/*
	 * The carve-out that makes clear-camps a clean zero. Both judges cleared both of these, and they
	 * are farm orders by vocabulary — the difference is that they name WHERE, off a fact about where
	 * the enemy jungler has been spending his game.
	 */
	it("carves the one routing order out of the camps ban", () => {
		for (const line of [
			"Briar has killed your Taliyah 4 times, so path through that side of the map on this clear.",
			"Briar has killed your Taliyah 4 times — put your next path through her side of the map rather than the empty one."
		]) {
			assert.equal(classifyDirective(line), "path-side", line)
			assert.equal(isBannedDirective(line), false, line)
		}
	})

	it("bans exactly the three families, and says so in one place", () => {
		assert.deepEqual([...BANNED_DIRECTIVES], ["clear-camps", "spend-gold", "fight-shape"])
		assert.deepEqual(
			DIRECTIVE_EVIDENCE.filter(r => r.banned).map(r => r.family),
			[...BANNED_DIRECTIVES]
		)
		// Every banned family measured zero under BOTH readers. Nothing is banned on one opinion.
		for (const row of DIRECTIVE_EVIDENCE.filter(r => r.banned)) {
			assert.equal(row.clears, 0, row.family)
			assert.equal(row.clearsB, 0, row.family)
			assert.ok(row.n >= 20, `${row.family} was banned on too little: n=${row.n}`)
		}
	})

	it("finds the imperative under a lead-in and inside an infinitive", () => {
		assert.equal(imperativeOf("Your damage arrives over time, so when you spawn take long fights with room to kite"), "take long fights with room to kite")
		assert.equal(imperativeOf("3 of them are dead — you have about 11 seconds to take an objective"), "take an objective")
	})
})
