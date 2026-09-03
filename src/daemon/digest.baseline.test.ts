/**
 * The digest must speak with one voice about baselines.
 *
 * Metrics are persisted with the baseline that was live when the game was ANALYSED. The corpus is
 * a rolling window, so those figures drift; measured across five real games, 56% of them
 * disagreed with a freshly computed baseline. Shipping both numbers in one prompt is what let a
 * review report elite control as "right around your own 45.9% baseline" when 45.9 was kill
 * participation's average and elite control's was 48.66.
 *
 * These tests pin the two properties that prevent it: the digest restates every baseline from the
 * live corpus, and every place it prints one prints the identical string.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { buildGameDigest } from "./digest.ts"
import type { Baseline } from "../analysis/index.ts"
import type { Game, Metric, ParticipantSummary } from "../shared/schema/domain.ts"

const game = {
	gameId: 1,
	platformId: "NA1",
	queueId: 420,
	gameMode: "CLASSIC",
	gameCreationMs: 0,
	gameDurationSec: 1800,
	patch: "16.17",
	gameVersion: "16.17.1",
	win: true,
	participantId: 1,
	teamId: 100,
	championId: 876,
	championName: "Lillia",
	role: "JGL",
	roleConfidence: "high",
	kills: 1,
	deaths: 1,
	assists: 1,
	cs: 10,
	jungleCs: 100,
	gold: 1,
	visionScore: 1,
	champLevel: 1,
	damageToChampions: 1,
	replayState: "absent",
	replayPath: null,
	analysisVersion: 1,
	reviewVersion: 0,
	ingestedAtMs: 0
} as unknown as Game

/** `explain` carries a STALE baseline, exactly as a persisted row would. */
const metric = (key: string, value: number, staleMean: number): Metric =>
	({
		key,
		label: key,
		value,
		unit: "%",
		band: "ok",
		vsBaseline: value - staleMean,
		confidence: "high",
		explain: `Blah blah. Your 20-game average is ${staleMean} (sd 9); this game is ${value - staleMean}.`
	}) as Metric

const stat = (mean: number, sd: number, n = 20) => ({ mean, sd, n, median: mean, min: 0, max: 0 })

const build = (metrics: Metric[], baseline: Baseline) =>
	buildGameDigest({
		game,
		participants: [] as ParticipantSummary[],
		metrics,
		moments: [],
		timeline: null,
		baseline,
		analysisVersion: 1
	})

describe("digest baselines", () => {
	it("replaces the stale persisted baseline with the live one", () => {
		const d = build([metric("eliteControlPct", 44.4, 52)], {
			eliteControlPct: stat(48.66, 33.55)
		} as unknown as Baseline)
		const m = d.metrics[0]!
		strictEqual(m.baselineMean, 48.66)
		ok(!m.explain.includes("52"), `stale 52 survived into explain: ${m.explain}`)
		ok(m.explain.includes("48.7"), `live mean missing from explain: ${m.explain}`)
	})

	it("recomputes vsBaseline against the live mean, not the stored delta", () => {
		const d = build([metric("eliteControlPct", 44.4, 52)], {
			eliteControlPct: stat(48.66, 33.55)
		} as unknown as Baseline)
		// stored delta was 44.4 - 52 = -7.6; the live one is 44.4 - 48.66
		strictEqual(Math.round(d.metrics[0]!.vsBaseline! * 100) / 100, -4.26)
	})

	it("prints one identical figure in baselineText, explain and the prose section", () => {
		const d = build(
			[metric("visionPerMin", 0.8, 1.2), metric("ownHalfPct", 54.8, 60)],
			{
				visionPerMin: stat(0.8347, 0.21),
				ownHalfPct: stat(54.83, 6.1)
			} as unknown as Baseline
		)
		for (const m of d.metrics) {
			const inline = /average ([\d.-]+)/.exec(m.baselineText!)![1]
			const inExplain = /Your \d+-game average is ([\d.-]+)/.exec(m.explain)![1]
			strictEqual(inline, inExplain, `${m.key}: inline ${inline} vs explain ${inExplain}`)
			const prose = d.baseline!.find(l => l.startsWith(`${m.label}:`))!
			strictEqual(/mean ([\d.-]+)/.exec(prose)![1], inline, `${m.key}: prose disagrees`)
		}
	})

	it("nulls the baseline fields when the corpus has nothing for that metric", () => {
		const d = build([metric("orphan", 5, 4)], {} as unknown as Baseline)
		deepStrictEqual(
			[d.metrics[0]!.baselineMean, d.metrics[0]!.baselineN, d.metrics[0]!.baselineText],
			[null, null, undefined]
		)
	})
})
