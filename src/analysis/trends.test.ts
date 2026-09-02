import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { TrendSeries, parseOrThrow } from "../shared/schema/domain.ts"
import { loadAll } from "./__fixtures__/index.ts"
import { METRIC_DEFS } from "./metrics.ts"
import {
	baselineFromRows,
	ci95Half,
	computeTrends,
	gamesForPrecision,
	linearSlope,
	mdd10v10,
	pearson,
	perGameMetrics,
	tCrit975,
	trendDetailsFromRows,
	winCorrelationsFromRows,
	type TrendDetail
} from "./trends.ts"

const games = loadAll().map(f => ({ match: f.match, timeline: f.timeline }))
const rows = perGameMetrics(games)
const details = trendDetailsFromRows(rows)
const byKey = (key: string): TrendDetail =>
	details.find(d => d.key === key) ?? assert.fail(`no series for ${key}`)

describe("statistical helpers", () => {
	test("ci95Half, gamesForPrecision and mdd10v10 agree with the research table", () => {
		// §7.1's "+/- @n=22" column: gd10 sd 681.99 at n = 22 gives a half-width of 284.99.
		assert.ok(Math.abs(ci95Half(681.99, 22)! - 284.99) < 0.5)
		assert.ok(Math.abs(ci95Half(681.99, 10)! - 422.7) < 0.5)
		assert.ok(Math.abs(ci95Half(681.99, 5)! - 597.79) < 0.5)
		// §7.2: n = (1.96 * 682 / 200)^2 ~ 45 games for a +/-200g interval.
		assert.equal(gamesForPrecision(682, 200), 45)
		// §7.1: MDD(10v10) for gd10 is 853.99.
		assert.ok(Math.abs(mdd10v10(681.99) - 853.99) < 0.5)
		assert.equal(ci95Half(100, 2), null)
	})

	test("linearSlope refuses tiny samples and reports a CI that can contain zero", () => {
		assert.equal(linearSlope([1, 2, 3]), null)
		const flat = linearSlope([5, 5, 5, 5, 5, 5])!
		assert.equal(flat.perGame, 0)
		const noisy = linearSlope([1, 9, 2, 8, 3, 7, 4, 6])!
		assert.equal(noisy.significant, false)
		assert.ok(noisy.ci95[0] < 0 && noisy.ci95[1] > 0)
		const rising = linearSlope([1, 2, 3, 4, 5, 6, 7, 8])!
		assert.ok(rising.perGame > 0.9)
		assert.equal(rising.significant, true)
	})

	test("a perfectly flat series is never a claimable direction", () => {
		// Zero residual variance used to short-circuit to `significant: true`, which handed a
		// claimable direction to a line with a slope of exactly zero.
		const flat = linearSlope([5, 5, 5, 5, 5, 5])!
		assert.equal(flat.perGame, 0)
		assert.equal(flat.significant, false)
		assert.deepEqual(flat.ci95, [0, 0])
	})

	test("the slope CI uses Student's t, not z, at the sample sizes this app sees", () => {
		// The SE is estimated from the same residuals it tests, so the sampling distribution is
		// t with n-2 df. At n = 20 that is 2.101 against 1.960 — a z-based interval is 7% too
		// narrow, and this interval is the switch that licenses the words "rising"/"falling".
		assert.ok(Math.abs(tCrit975(18) - 2.1009) < 0.002)
		assert.ok(Math.abs(tCrit975(10) - 2.2281) < 0.002)
		assert.ok(Math.abs(tCrit975(30) - 2.0423) < 0.002)
		assert.ok(tCrit975(18) > 1.96)

		const values = [1, 4, 2, 6, 3, 8, 4, 9, 6, 11, 7, 12, 9, 14, 10, 16, 12, 17, 13, 19]
		const s = linearSlope(values)!
		const se = (s.ci95[1] - s.ci95[0]) / 2 / tCrit975(values.length - 2)
		// The half-width really is t*se, not 1.96*se.
		assert.ok(Math.abs(s.ci95[1] - (s.perGame + tCrit975(18) * se)) < 1e-9)
		assert.ok(s.ci95[1] - s.ci95[0] > 2 * 1.96 * se)
	})

	test("pearson matches hand-computable cases", () => {
		assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-9)
		assert.ok(Math.abs(pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-9)
		assert.ok(Number.isNaN(pearson([1, 1, 1, 1], [1, 2, 3, 4])))
	})
})

describe("computeTrends — the honesty rules, enforced", () => {
	test("every opponent-delta metric is NOT trendable at this sample size", () => {
		for (const key of [
			"goldDelta@10",
			"goldDelta@14",
			"xpDelta@10",
			"xpDelta@14",
			"csDelta@10",
			"csDelta@14",
			"csDelta@20",
			"levelDelta@14"
		]) {
			const s = byKey(key)
			assert.equal(s.trendable, false, `${key} must never be trendable`)
			assert.equal(s.reliability, "NOT_TRENDABLE_AT_THIS_N")
			assert.equal(s.slope, null, `${key} must not carry a slope`)
			assert.ok(s.note.includes("no trend line"), `${key}: ${s.note}`)
		}
	})

	test("the gold-diff@10 CI reproduces the measured +/-285g", () => {
		const s = byKey("goldDelta@10")
		assert.ok(s.n >= 18, `n=${s.n}`)
		assert.ok(
			Math.abs(s.ci95!) > 240 && Math.abs(s.ci95!) < 340,
			`CI half-width ${s.ci95} should be near the measured 285g`
		)
		// The interval straddles zero, which is the whole point.
		assert.ok(Math.abs(s.mean) < Math.abs(s.ci95!) + 100, `mean ${s.mean} ci ${s.ci95}`)
	})

	test("the stable metrics from the CV table are trendable at n = 20", () => {
		for (const key of [
			"cs@10",
			"campsPerMin",
			"goldPerMin",
			"medianCentroidDist",
			"medOverExtension"
		]) {
			const s = byKey(key)
			assert.equal(s.trendable, true, `${key} should be trendable: cv ${s.cv}, n ${s.n}`)
			assert.ok(s.cv <= 0.3, `${key} cv ${s.cv}`)
		}
	})

	test("confounded metrics are never trendable, however stable they look", () => {
		for (const key of ["ownHalfPct", "enemyHalfPct"]) {
			const s = byKey(key)
			assert.equal(s.confounded, true)
			assert.equal(s.trendable, false, `${key} is an outcome, not a lever`)
			assert.ok(s.note.includes("OUTCOME"), s.note)
		}
		// ownHalfPct is stable enough by CV — it is excluded on causal grounds alone.
		assert.ok(byKey("ownHalfPct").cv <= 0.3)
	})

	test("direction is only ever claimed when the slope's CI excludes zero", () => {
		for (const s of details) {
			if (!s.slope) {
				assert.ok(
					!/\b(rising|falling|improving|declining)\b/i.test(s.note),
					`${s.key} claims a direction without a slope: ${s.note}`
				)
				continue
			}
			if (!s.slope.significant)
				assert.ok(
					s.note.includes("No direction can be claimed"),
					`${s.key}: ${s.note}`
				)
		}
	})

	test("every note states n, the interval, and the independence caveat", () => {
		for (const s of details) {
			assert.ok(s.note.includes(`over ${s.n} game`), `${s.key}: ${s.note}`)
			assert.ok(
				s.note.includes("95% CI") || s.note.includes("too few games"),
				`${s.key}: ${s.note}`
			)
			assert.ok(
				s.note.includes("independent"),
				`${s.key} omits the correlated-games caveat`
			)
		}
	})

	test("a metric can never be promoted above its measured stability prior", () => {
		for (const s of details) {
			const tier = METRIC_DEFS[s.key]?.tier ?? "noisy"
			assert.equal(s.tier, tier)
			if (tier === "not-trendable") assert.equal(s.trendable, false)
			if (tier === "noisy" && s.n < 20) assert.equal(s.trendable, false, s.key)
		}
	})

	test("the API-shaped series validates and carries the same verdicts", () => {
		const series = computeTrends(games)
		assert.ok(series.length > 20)
		for (const s of series) {
			parseOrThrow(TrendSeries, s, `series ${s.key}`)
			const d = byKey(s.key)
			assert.equal(s.trendable, d.trendable)
			assert.equal(s.mean, d.mean)
			assert.equal(s.points.length, d.points.length)
		}
	})

	test("points are chronological and carry their game id", () => {
		for (const s of details) {
			for (let i = 1; i < s.points.length; i++)
				assert.ok(s.points[i]!.tMs >= s.points[i - 1]!.tMs, s.key)
			for (const p of s.points) assert.ok(p.gameId > 0)
		}
	})

	test("a limit takes the most recent games", () => {
		const recent = perGameMetrics(games, { limit: 5 })
		assert.equal(recent.length, 5)
		assert.equal(recent[4]!.tMs, rows[rows.length - 1]!.tMs)
	})

	test("a one-game corpus produces no confidence interval and nothing trendable", () => {
		const single = trendDetailsFromRows(perGameMetrics(games.slice(0, 1)))
		assert.ok(single.length > 0)
		for (const s of single) {
			assert.equal(s.n, 1)
			assert.equal(s.ci95, null)
			assert.equal(s.trendable, false)
			assert.ok(s.note.includes("too few games") || s.note.includes("Needs at least"))
		}
	})
})

describe("rollingBaseline", () => {
	test("aggregates the user's own history, and matches the measured cs@10", () => {
		const baseline = baselineFromRows(rows)
		const cs10 = baseline["cs@10"]!
		// §3.3 measured mean 64.26 over 21 games; this 20-game slice is the same population.
		assert.ok(Math.abs(cs10.mean - 64.26) < 2, `mean ${cs10.mean}`)
		assert.ok(cs10.n >= 18 && cs10.n <= 20)
		assert.ok(cs10.sd > 5 && cs10.sd < 12)
		// §6.2 measured camps/min mean 5.344.
		assert.ok(Math.abs(baseline["campsPerMin"]!.mean - 5.344) < 0.1)
	})

	test("n is per metric, so a short game does not poison marks it never reached", () => {
		const baseline = baselineFromRows(rows)
		assert.ok(baseline["cs@20"]!.n < baseline["campsPerMin"]!.n)
		assert.equal(baseline["campsPerMin"]!.n, rows.length)
	})
})

describe("metricWinCorrelations — the multiple-comparison trap, encoded", () => {
	const correlations = winCorrelationsFromRows(rows)

	test("every correlation ships its corrected threshold", () => {
		assert.ok(correlations.length > 20)
		for (const c of correlations) {
			assert.ok(Math.abs(c.threshold - 0.05 / correlations.length) < 1e-6 || c.threshold < 0.05)
			assert.ok(c.note.includes("correction"), c.key)
			assert.ok(c.r >= -1 && c.r <= 1)
		}
	})

	test("half-of-the-map metrics correlate strongly with winning and are still flagged useless", () => {
		// §7.4: enemy_half_pct r = +0.69 — the strongest correlate, and pure reverse causality.
		const enemyHalf = correlations.find(c => c.key === "enemyHalfPct")!
		assert.ok(enemyHalf.r > 0.5, `r = ${enemyHalf.r}`)
		assert.equal(enemyHalf.confounded, true)
		assert.ok(enemyHalf.note.includes("CONSEQUENCE"))
		const ownHalf = correlations.find(c => c.key === "ownHalfPct")!
		assert.ok(ownHalf.r < -0.4, `r = ${ownHalf.r}`)
	})

	test("a p-value near 0.03 does not survive correction, and says so", () => {
		const borderline = correlations.filter(c => c.pValue > 0.01 && c.pValue < 0.05)
		assert.ok(borderline.length > 0, "expected at least one borderline correlate")
		for (const c of borderline) {
			assert.equal(c.survivesCorrection, false)
			assert.ok(
				c.note.includes("Does NOT survive"),
				`${c.key} (p=${c.pValue}): ${c.note}`
			)
		}
	})
})
