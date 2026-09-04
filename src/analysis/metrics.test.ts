import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { USER_PUUID } from "../shared/constants.ts"
import type { Metric } from "../shared/schema/domain.ts"
import {
	loadAll,
	loadFixture,
	REFERENCE_GAME_ID,
	SHORT_GAME_ID
} from "./__fixtures__/index.ts"
import { framesOf, pfOf } from "./frames.ts"
import { computeMetrics, detectBacks, jungleFarmSplit, METRIC_DEFS } from "./metrics.ts"
import { findUser, inferRoles } from "./roles.ts"
import { baselineFromRows, perGameMetrics } from "./trends.ts"

const all = loadAll()

const metricsFor = (gameId: number, baseline = {}): Metric[] => {
	const f = loadFixture(gameId)
	const roles = inferRoles(f.match, f.timeline)
	const userId = findUser(f.match, USER_PUUID)!
	return computeMetrics(f.match, f.timeline, roles, userId, baseline)
}

const value = (ms: Metric[], key: string): number | undefined =>
	ms.find(m => m.key === key)?.value

describe("computeMetrics — reproduces the measured research table", () => {
	/*
	 * `.research/analytics.md` §3.3 lists these rows for the user vs the enemy jungler. If any
	 * of these drift, either the sampling rule or the opponent identification broke.
	 */
	const EXPECTED: Record<number, { cs10: number; csd10: number; gd10: number; gd14: number }> = {
		5633857616: { cs10: 53, csd10: -7, gd10: -183, gd14: 722 },
		5633183082: { cs10: 75, csd10: 27, gd10: -653, gd14: -526 },
		5633326992: { cs10: 53, csd10: -8, gd10: 119, gd14: 242 },
		5633853752: { cs10: 79, csd10: 14, gd10: 738, gd14: 227 },
		5633298307: { cs10: 59, csd10: -18, gd10: -1318, gd14: -1925 }
	}

	for (const [id, exp] of Object.entries(EXPECTED))
		test(`game ${id}`, () => {
			const ms = metricsFor(Number(id))
			assert.equal(value(ms, "cs@10"), exp.cs10)
			assert.equal(value(ms, "csDelta@10"), exp.csd10)
			// Gold deltas are interpolated at the mark, so allow a couple of gold of drift.
			assert.ok(
				Math.abs(value(ms, "goldDelta@10")! - exp.gd10) <= 2,
				`goldDelta@10 ${value(ms, "goldDelta@10")} vs ${exp.gd10}`
			)
			assert.ok(
				Math.abs(value(ms, "goldDelta@14")! - exp.gd14) <= 2,
				`goldDelta@14 ${value(ms, "goldDelta@14")} vs ${exp.gd14}`
			)
		})

	/*
	 * The §6.2 table was measured as CAMPS per minute, and the shipped metric is now CS per minute
	 * — camps PLUS lane minions — because every other farm figure in the app is the total and two
	 * quantities sharing the word "farm" is what put "27 camps behind" into a real coaching line
	 * about a number that included lane minions.
	 *
	 * The research is NOT rewritten to match the new metric. It is still asserted, against the
	 * quantity it actually measured, from the same fixtures. What changed is which of the two the
	 * app ships, and the second test pins that.
	 */
	test("the §6.2 camps-per-minute research still reproduces", () => {
		for (const [id, expected] of [
			[5633326992, 5.42],
			[5633183082, 7.06],
			[5633857616, 6.34],
			[5633851596, 2.52]
		] as const) {
			const f = loadFixture(id)
			const uid = findUser(f.match, USER_PUUID)!
			const me = f.match.participants.find(p => p.participantId === uid)!.stats
			const durMin = f.match.gameDuration / 60
			const campsPerMin = me.neutralMinionsKilled / durMin
			assert.ok(
				Math.abs(campsPerMin - expected) < 0.1,
				`game ${id}: camps/min ${campsPerMin} vs §6.2 ${expected}`
			)
		}
	})

	test("csPerMin counts lane minions too, so it is at or above the camp count", () => {
		for (const id of [5633326992, 5633183082, 5633857616, 5633851596]) {
			const f = loadFixture(id)
			const uid = findUser(f.match, USER_PUUID)!
			const me = f.match.participants.find(p => p.participantId === uid)!.stats
			const durMin = f.match.gameDuration / 60
			const shipped = value(metricsFor(id), "csPerMin")!
			assert.ok(
				Math.abs(shipped - (me.neutralMinionsKilled + me.totalMinionsKilled) / durMin) < 0.01,
				`game ${id}: csPerMin ${shipped} is not camps+lane over duration`
			)
			assert.ok(shipped >= me.neutralMinionsKilled / durMin - 0.01, `game ${id}: below camps alone`)
		}
	})

	test("positional shares match the §5.3 table for the reference game", () => {
		const ms = metricsFor(REFERENCE_GAME_ID)
		assert.ok(Math.abs(value(ms, "ownHalfPct")! - 33) <= 1)
		assert.ok(Math.abs(value(ms, "neutralHalfPct")! - 44) <= 1)
		assert.ok(Math.abs(value(ms, "enemyHalfPct")! - 23) <= 1)
		assert.ok(Math.abs(value(ms, "medianCentroidDist")! - 3672) <= 5)
		assert.ok(Math.abs(value(ms, "medianNearestAlly")! - 2446) <= 5)
	})
})

describe("computeMetrics — refuses to invent", () => {
	test("a game that ended before a mark emits no metric for that mark", () => {
		// The 7:33 surrender never reaches 10:00, let alone 14:00 or 20:00.
		const ms = metricsFor(SHORT_GAME_ID)
		assert.equal(value(ms, "cs@10"), undefined)
		assert.equal(value(ms, "cs@14"), undefined)
		assert.equal(value(ms, "cs@20"), undefined)
		assert.equal(value(ms, "goldDelta@10"), undefined)
		// But end-of-game stats still produce metrics — the game did happen.
		assert.ok(value(ms, "csPerMin")! > 0)
		assert.ok(value(ms, "deaths")! >= 0)
	})

	test("no metric is ever NaN or Infinity, in any fixture", () => {
		for (const f of all) {
			const ms = metricsFor(f.gameId)
			for (const m of ms)
				assert.ok(
					Number.isFinite(m.value),
					`game ${f.gameId} metric ${m.key} = ${m.value}`
				)
		}
	})

	test("a null vsBaseline always forces band 'unknown'", () => {
		for (const f of all)
			for (const m of metricsFor(f.gameId))
				if (m.vsBaseline === null)
					assert.equal(m.band, "unknown", `${f.gameId} ${m.key}`)
	})

	test("every metric carries a non-trivial explain and a confidence", () => {
		for (const m of metricsFor(REFERENCE_GAME_ID)) {
			assert.ok(m.explain.length > 20, `${m.key}: "${m.explain}"`)
			assert.ok(["high", "medium", "low"].includes(m.confidence), m.key)
			assert.ok(m.label.length > 0, m.key)
		}
	})

	test("interpolated metrics are never labelled 'high' confidence", () => {
		for (const m of metricsFor(REFERENCE_GAME_ID))
			if (m.key.includes("@") || m.key.startsWith("firstBack"))
				assert.notEqual(m.confidence, "high", m.key)
	})

	test("half shares add up to 100%", () => {
		for (const f of all) {
			const ms = metricsFor(f.gameId)
			const own = value(ms, "ownHalfPct")
			if (own === undefined) continue
			const total =
				own + value(ms, "neutralHalfPct")! + value(ms, "enemyHalfPct")!
			assert.ok(Math.abs(total - 100) < 0.5, `game ${f.gameId}: ${total}`)
		}
	})
})

describe("banding against the user's own baseline", () => {
	test("with no history nothing is banded, and the explain says why", () => {
		const ms = metricsFor(REFERENCE_GAME_ID)
		for (const m of ms) {
			assert.equal(m.band, "unknown")
			assert.equal(m.vsBaseline, null)
			assert.ok(m.explain.includes("No band yet"), m.key)
		}
	})

	test("with history, bands appear and vsBaseline is the signed delta", () => {
		const rows = perGameMetrics(all.map(f => ({ match: f.match, timeline: f.timeline })))
		const baseline = baselineFromRows(rows)
		const ms = metricsFor(REFERENCE_GAME_ID, baseline)
		const cs10 = ms.find(m => m.key === "cs@10")!
		assert.notEqual(cs10.band, "unknown")
		assert.ok(cs10.vsBaseline !== null)
		assert.ok(
			Math.abs(cs10.value - (baseline["cs@10"]!.mean + cs10.vsBaseline!)) < 0.51,
			"vsBaseline should be value - baseline mean"
		)
		// 53 camps against a 19-game average of 64 is a bad game by the user's own standard.
		assert.equal(cs10.band, "bad")
		assert.ok(cs10.explain.includes("19-game average"))
	})

	test("descriptive metrics get a delta but never a good/bad verdict", () => {
		const rows = perGameMetrics(all.map(f => ({ match: f.match, timeline: f.timeline })))
		const ms = metricsFor(REFERENCE_GAME_ID, baselineFromRows(rows))
		for (const m of ms)
			if (METRIC_DEFS[m.key]?.higherIsBetter === null)
				assert.equal(m.band, "unknown", `${m.key} should not be scored`)
	})
})

describe("detectBacks", () => {
	test("skips the starting-item purchase on the frame 0 -> 1 transition", () => {
		for (const f of all) {
			const frames = framesOf(f.timeline)
			const userId = findUser(f.match, USER_PUUID)!
			const f0 = pfOf(frames[0]!, userId)
			const f1 = pfOf(frames[1]!, userId)
			assert.ok(f0 && f1)
			const startingPurchase = f0.currentGold - f1.currentGold
			assert.ok(
				startingPurchase >= 400,
				`game ${f.gameId}: expected a 400g+ starting purchase, got ${startingPurchase}`
			)
			const backs = detectBacks(frames, userId)
			assert.ok(
				backs.every(b => b.windowEndMin > 1),
				`game ${f.gameId}: the starting purchase leaked in as a back`
			)
		}
	})

	test("reports a 60-second window, never a timestamp", () => {
		const f = loadFixture(REFERENCE_GAME_ID)
		const userId = findUser(f.match, USER_PUUID)!
		const backs = detectBacks(framesOf(f.timeline), userId)
		assert.ok(backs.length > 0)
		for (const b of backs) {
			assert.ok(b.windowEndMin > b.windowStartMin)
			assert.ok(b.windowEndMin - b.windowStartMin <= 1.1)
			assert.ok(b.goldSpent >= 250)
		}
	})

	test("first back lands in the measured 4-6 minute range across the corpus", () => {
		const firsts: number[] = []
		for (const f of all) {
			const userId = findUser(f.match, USER_PUUID)!
			const b = detectBacks(framesOf(f.timeline), userId)[0]
			if (b) firsts.push(b.windowEndMin)
		}
		assert.equal(firsts.length, all.length)
		assert.ok(Math.min(...firsts) >= 3, `min ${Math.min(...firsts)}`)
		assert.ok(Math.max(...firsts) <= 7, `max ${Math.max(...firsts)}`)
	})
})

describe("jungleFarmSplit", () => {
	test("the three buckets sum to the total and the river band is kept separate", () => {
		for (const f of all) {
			const userId = findUser(f.match, USER_PUUID)!
			const p = f.match.participants.find(x => x.participantId === userId)!
			const split = jungleFarmSplit(
				framesOf(f.timeline),
				userId,
				p.teamId as 100 | 200,
				f.match.gameDuration
			)
			assert.equal(
				split.ownHalfCamps + split.enemyHalfCamps + split.neutralBandCamps,
				split.totalCamps,
				`game ${f.gameId}`
			)
			assert.ok(split.enemyShare >= 0 && split.enemyShare <= 1)
		}
	})

	test("enemy-jungle share is reported, not the dead API fields", () => {
		// `neutralMinionsKilledEnemyJungle` is 0 in every game — that is why we derive it.
		for (const f of all) {
			const userId = findUser(f.match, USER_PUUID)!
			const stats = f.match.participants.find(x => x.participantId === userId)!.stats
			assert.equal(stats.neutralMinionsKilledEnemyJungle ?? 0, 0)
			assert.equal(stats.neutralMinionsKilledTeamJungle ?? 0, 0)
		}
		// And the derived version is not always zero.
		const derived = all.map(f => {
			const userId = findUser(f.match, USER_PUUID)!
			const p = f.match.participants.find(x => x.participantId === userId)!
			return jungleFarmSplit(
				framesOf(f.timeline),
				userId,
				p.teamId as 100 | 200,
				f.match.gameDuration
			).enemyHalfCamps
		})
		assert.ok(derived.some(n => n > 0))
	})
})
