/**
 * The trend verdict served to the browser must be the SAME verdict the coach is shown.
 *
 * This route used to carry a second, regex-based opinion about which metrics could bear a
 * trend line (`/^(gd|csd|xpd|dpd)\d*$|diff|delta/i` plus its own CV cutoffs). Measured against
 * the user's real 20-game window it disagreed with `METRIC_DEFS` on two metrics, in the
 * direction that overclaims:
 *
 *   - `ownHalfPct` (CV 0.237) came back trendable and got a green fit line, even though the
 *     registry marks it `confounded` — it moves because you were winning. `.research/
 *     analytics.md` §7.4 names this the one metric that must never be shown as a lever.
 *   - `firstBackMin` (CV 0.151) came back trendable, though it is quantised to whole minutes;
 *     a line through it is reading noise off the quantiser.
 *
 * Run: pnpm test
 */

import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { METRIC_DEFS } from "../../analysis/metrics.ts"
import { TIER_RULES } from "../../analysis/trends.ts"
import { verdict } from "./trends.ts"

describe("GET /api/trends — the trendable verdict", () => {
	it("refuses a trend line on a confounded metric however stable it looks", () => {
		// The real numbers from the user's 20-game window: mean 0.564, sd 0.134 => CV 0.237,
		// comfortably inside the `stable` tier's ceiling. Stability is not the point.
		const v = verdict("ownHalfPct", 20, 0.564, 0.134)
		assert.equal(v.trendable, false)
		assert.match(v.note, /OUTCOME, not a lever/)
	})

	it("refuses a trend line on a metric the registry measured as not trendable", () => {
		// firstBackMin: CV 0.15 over 20 games, and still not trendable — it only takes whole
		// minute values, so a slope on it is a property of the quantiser.
		const v = verdict("firstBackMin", 20, 7.1, 1.07)
		assert.equal(v.trendable, false)
		assert.match(v.note, /not trendable/i)

		for (const key of ["goldDelta@10", "csDelta@10", "xpDelta@14", "kills", "assists"])
			assert.equal(verdict(key, 20, 100, 5).trendable, false, key)
	})

	it("agrees with the analysis layer on every metric in the registry", () => {
		// One gate, not two. Anything else and the screen and the coach can contradict.
		for (const [key, d] of Object.entries(METRIC_DEFS)) {
			const rule = TIER_RULES[d.tier]
			// A sample that comfortably clears this metric's own tier requirement.
			const n = Number.isFinite(rule.minN) ? rule.minN : 20
			const mu = 100
			const sd = Number.isFinite(rule.maxCv) ? mu * rule.maxCv * 0.5 : 1
			const expected = d.tier !== "not-trendable" && !d.confounded
			assert.equal(verdict(key, n, mu, sd).trendable, expected, key)
		}
	})

	it("holds a metric under its tier's sample requirement", () => {
		const stable = verdict("cs@10", 4, 64, 9.6)
		assert.equal(stable.trendable, false)
		assert.match(stable.note, /needs 10 games/)

		const noisy = verdict("deathsPerMin", 12, 0.166, 0.083)
		assert.equal(noisy.trendable, false)
		assert.match(noisy.note, /needs 20 games/)
	})

	it("calls one game a data point, not a pattern", () => {
		assert.equal(verdict("cs@10", 1, 64, 0).trendable, false)
		assert.match(verdict("cs@10", 1, 64, 0).note, /one game is a data point/)
	})
})
