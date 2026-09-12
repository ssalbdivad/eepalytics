/**
 * The three pieces of `adjudicate.ts` a reader cannot check by eye.
 *
 * The claim CHECKS are all readable against their evidence strings — "HP 57% against a 30% band"
 * either convinces or it does not. These three do not have that property:
 *
 *   - `mcnemarExact` is the number the whole comparison turns on, and every expectation below is
 *     the closed-form binomial written out rather than a figure copied from a run.
 *   - `vagueBand` is where this file chooses NOT to manufacture a contradiction out of a threshold
 *     somebody picked, and the three-way split is the entire point of it.
 *   - `verdictOfLine`'s precedence decides whether one unsettled clause can be quietly carried by
 *     a settled one. It cannot, and that is what these assert.
 */

import { equal } from "node:assert/strict"
import { test } from "node:test"
import { deathInstant, mcnemarExact, numOf, vagueBand, verdictOfLine } from "./adjudicate.ts"
import type { TruthEvent } from "../src/analysis/game-truth.ts"

const claim = (verdict: "VERIFIED" | "CONTRADICTED" | "UNDECIDABLE") =>
	({ kind: "k", clause: "c", mood: "assert", channel: "feed", verdict, evidence: "" }) as const

test("mcnemarExact is the two-sided exact binomial at p = 0.5", () => {
	equal(mcnemarExact(0, 0), 1)
	/* n = 1: 2 * P(X <= 0) = 2 * 1/2 = 1. One discordant pair can never separate. */
	equal(mcnemarExact(1, 0), 1)
	/* n = 5, k = 0: 2 * 1/32. */
	equal(mcnemarExact(0, 5), 2 / 32)
	/* n = 17, k = 1: 2 * (1 + 17) / 2^17 — the run's own 16-against-1 split. */
	equal(mcnemarExact(1, 16).toPrecision(6), (2 * (18 / 131072)).toPrecision(6))
	equal(mcnemarExact(3, 3) > 0.99, true)
})

test("vagueBand refuses to contradict inside the gray zone", () => {
	/* At or under the app's own band the record agrees. */
	equal(vagueBand(0.12, 0.3), "VERIFIED")
	equal(vagueBand(0.3, 0.3), "VERIFIED")
	/* Between the band and double it, the WORD is what is unclear, not the record. */
	equal(vagueBand(0.41, 0.3), "UNDECIDABLE")
	equal(vagueBand(0.57, 0.3), "UNDECIDABLE")
	/* Past double, nobody would call it that. */
	equal(vagueBand(0.61, 0.3), "CONTRADICTED")
	equal(vagueBand(0.45, 0.2), "CONTRADICTED")
})

test("one unsettled clause stops a line being called verified", () => {
	equal(verdictOfLine([]), "NO-CLAIM")
	equal(verdictOfLine([claim("VERIFIED"), claim("VERIFIED")]), "VERIFIED")
	/* A contradiction sinks the line however much else was right. */
	equal(verdictOfLine([claim("VERIFIED"), claim("CONTRADICTED")]), "CONTRADICTED")
	/* And an undecidable clause is not carried by a verified one. */
	equal(verdictOfLine([claim("VERIFIED"), claim("UNDECIDABLE")]), "UNDECIDABLE")
	/* Contradiction still outranks undecidable — a known-false clause is not "unsettled". */
	equal(verdictOfLine([claim("UNDECIDABLE"), claim("CONTRADICTED")]), "CONTRADICTED")
})

test("numOf reads the spoken forms the coach actually uses", () => {
	equal(numOf("twelve"), 12)
	equal(numOf("thirty-seven"), 37)
	equal(numOf("forty five"), 45)
	equal(numOf("1800"), 1800)
	equal(numOf("two thousand"), 2000)
	equal(numOf("thousand"), 1000)
	equal(numOf("banana"), null)
})

/**
 * The elapsed half of a death clock, which this file used to read off the respawn timer — the
 * figure that runs the other way. Six claims across the two adjudicated games were certified
 * VERIFIED by that inversion, five of them by a margin the corrected reading convicts.
 */
const kill = (atSec: number, champion: string): TruthEvent =>
	({ atSec, kind: "kill", victim: { championName: champion } }) as unknown as TruthEvent

test("deathInstant takes the LAST death before the instant, and nothing after it", () => {
	const g = { events: [kill(100, "Kayn"), kill(300, "Kayn"), kill(400, "Kayn"), kill(250, "Lulu")] } as never
	equal(deathInstant(g, "Kayn", 350), 300)
	equal(deathInstant(g, "Kayn", 99), null)
	equal(deathInstant(g, "Lulu", 350), 250)
})

test("deathInstant matches the champion loosely enough for the feed's spelling", () => {
	const g = { events: [kill(60, "MonkeyKing")] } as never
	equal(deathInstant(g, "Monkey King", 90), 60)
	equal(deathInstant(g, "Lulu", 90), null)
})
