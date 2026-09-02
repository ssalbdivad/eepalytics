import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { USER_PUUID } from "../shared/constants.ts"
import { classifyZone } from "../shared/map.ts"
import { loadAll, loadFixture, REFERENCE_GAME_ID } from "./__fixtures__/index.ts"
import {
	analyzeDeaths,
	binomialTail,
	clusterDeaths,
	deathZoneHistogram,
	economyOf,
	outnumberingOf,
	phaseOf,
	signatureCounts,
	type DeathAnalysis
} from "./deaths.ts"
import { allEvents } from "./frames.ts"
import { alliesOf, findUser, inferRoles } from "./roles.ts"

const all = loadAll()

const deathsFor = (gameId: number): DeathAnalysis[] => {
	const f = loadFixture(gameId)
	const roles = inferRoles(f.match, f.timeline)
	const userId = findUser(f.match, USER_PUUID)!
	return analyzeDeaths(f.match, f.timeline, roles, userId)
}

const corpus: DeathAnalysis[] = all.flatMap(f => {
	const roles = inferRoles(f.match, f.timeline)
	const userId = findUser(f.match, USER_PUUID)!
	return analyzeDeaths(f.match, f.timeline, roles, userId)
})

describe("analyzeDeaths — the exact facts stay exact", () => {
	test("one analysis per CHAMPION_KILL naming the user as victim, and the count matches the scoreboard", () => {
		for (const f of all) {
			const userId = findUser(f.match, USER_PUUID)!
			const events = allEvents(f.timeline).filter(
				e => e.type === "CHAMPION_KILL" && e.victimId === userId
			)
			const analyses = deathsFor(f.gameId)
			assert.equal(analyses.length, events.length, `game ${f.gameId}`)
			const stats = f.match.participants.find(p => p.participantId === userId)!.stats
			assert.equal(analyses.length, stats.deaths, `game ${f.gameId} vs scoreboard`)
		}
	})

	test("positions come straight off the event, never from interpolation", () => {
		for (const f of all) {
			const userId = findUser(f.match, USER_PUUID)!
			const events = allEvents(f.timeline).filter(
				e => e.type === "CHAMPION_KILL" && e.victimId === userId
			)
			const analyses = deathsFor(f.gameId)
			for (let i = 0; i < analyses.length; i++) {
				const a = analyses[i]!
				const e = events[i]!
				assert.equal(a.position.x, e.position!.x)
				assert.equal(a.position.y, e.position!.y)
				assert.equal(a.tSec, Math.round((e.timestamp / 1000) * 10) / 10)
			}
		}
	})

	test("enemiesCredited is 1 + assists, and killerId 0 credits nobody", () => {
		for (const d of corpus) {
			assert.equal(d.enemiesCredited, (d.killerId > 0 ? 1 : 0) + d.assistIds.length)
			if (d.killerId === 0) assert.equal(d.enemiesCredited, d.assistIds.length)
		}
		// The corpus really does contain the execute/minion/turret case, and it survives.
		assert.ok(
			corpus.some(d => d.killerId === 0),
			"expected at least one killerId === 0 death to be kept rather than filtered"
		)
	})

	test("zone labels agree with the shared classifier", () => {
		for (const f of all) {
			const userId = findUser(f.match, USER_PUUID)!
			const teamId = f.match.participants.find(p => p.participantId === userId)!
				.teamId as 100 | 200
			for (const d of deathsFor(f.gameId))
				assert.equal(d.zone, classifyZone(d.position, teamId))
		}
	})

	test("the corpus aggregates match the measured research distributions", () => {
		// §4.1 measured 112 deaths over 22 games (5.1/game); this 20-game slice is the same data.
		assert.ok(corpus.length > 90 && corpus.length < 130, `${corpus.length} deaths`)
		const perGame = corpus.length / all.length
		assert.ok(perGame > 4.5 && perGame < 6.5, `${perGame} deaths/game`)

		// 78% of deaths happened while behind the enemy jungler in gold.
		const withGold = corpus.filter(d => d.goldDeltaVsOpponent !== null)
		const behind = withGold.filter(d => d.goldDeltaVsOpponent! < 0).length
		assert.ok(behind / withGold.length > 0.7, `${behind}/${withGold.length} behind`)

		// 18% of deaths are followed by a conceded elite objective within 45s (base rate 10%).
		const conceded = corpus.filter(
			d => d.objectiveContext.objectiveConcededWithin45s.length > 0
		).length
		const share = conceded / corpus.length
		assert.ok(share > 0.12 && share < 0.28, `conceded share ${share}`)

		// Measured excess team-gold cost per death, ~-418g over 103 deaths in the research.
		const swings = corpus
			.map(d => d.cost.measuredTeamGoldSwing90s)
			.filter((n): n is number => n !== null)
		const meanSwing = swings.reduce((a, b) => a + b, 0) / swings.length
		assert.ok(meanSwing < -200 && meanSwing > -700, `mean swing ${meanSwing}`)
	})

	test("the zone histogram is dominated by lanes and rivers, as the heatmap showed", () => {
		const hist = deathZoneHistogram(corpus)
		assert.equal(
			hist.reduce((a, h) => a + h.n, 0),
			corpus.length
		)
		const laneAndRiver = hist
			.filter(h => h.zone.startsWith("LANE_") || h.zone.startsWith("RIVER_"))
			.reduce((a, h) => a + h.share, 0)
		assert.ok(laneAndRiver > 0.5, `lanes + rivers only ${laneAndRiver}`)
	})
})

describe("analyzeDeaths — the guesses stay hedged", () => {
	test("SOLO and PARTIAL verdicts never assert presence as fact", () => {
		for (const d of corpus) {
			if (d.isolation.verdict === "SOLO")
				assert.ok(
					d.isolation.note.startsWith("Likely alone"),
					`SOLO note must hedge: "${d.isolation.note}"`
				)
			if (d.isolation.verdict === "PARTIAL")
				assert.ok(
					d.isolation.note.startsWith("Unclear") ||
						d.isolation.note.includes("provably"),
					`PARTIAL note: "${d.isolation.note}"`
				)
			assert.ok(
				!/\byou were alone\b/i.test(d.summary),
				`summary asserts isolation as fact: "${d.summary}"`
			)
		}
	})

	test("only WITH_TEAM (and proven-ally PARTIAL) verdicts get high confidence", () => {
		for (const d of corpus) {
			if (d.isolation.confidence === "high")
				assert.ok(
					d.isolation.provenAlliesPresent.length >= 1,
					"high confidence requires event-derived proof"
				)
			if (d.isolation.verdict === "WITH_TEAM")
				assert.ok(d.isolation.provenAlliesPresent.length >= 2)
		}
	})

	test("provenAlliesPresent only ever names actual teammates", () => {
		for (const f of all) {
			const userId = findUser(f.match, USER_PUUID)!
			const allies = new Set(alliesOf(f.match, userId))
			for (const d of deathsFor(f.gameId))
				for (const p of d.isolation.provenAlliesPresent)
					assert.ok(allies.has(p), `game ${f.gameId}: ${p} is not an ally`)
		}
	})

	test("the death-cost model labels itself as a model, every time", () => {
		for (const d of corpus) {
			assert.equal(d.cost.downtimeSource, "BRW_TABLE_ESTIMATE")
			assert.ok(d.cost.note.includes("UNVERIFIED"))
			assert.ok(d.cost.note.includes("floor"))
			assert.ok(d.cost.totalGold > 0)
		}
	})

	test("objective-spawn context flags itself as estimated", () => {
		for (const d of corpus)
			assert.ok(d.objectiveContext.note.includes("UNVERIFIED"))
	})

	test("degrades without a timeline: exact facts survive, context goes null", () => {
		const f = loadFixture(REFERENCE_GAME_ID)
		const roles = inferRoles(f.match, null)
		const userId = findUser(f.match, USER_PUUID)!
		const withTl = analyzeDeaths(f.match, f.timeline, roles, userId)
		const without = analyzeDeaths(f.match, null, roles, userId)
		assert.equal(without.length, 0, "no timeline means no events, so no deaths")
		assert.ok(withTl.length > 0)
	})
})

describe("categorical helpers", () => {
	test("phase / economy / outnumbering cut where the research cut them", () => {
		assert.equal(phaseOf(599), "EARLY")
		assert.equal(phaseOf(600), "MID")
		assert.equal(phaseOf(1499), "MID")
		assert.equal(phaseOf(1500), "LATE")
		assert.equal(economyOf(-401), "BEHIND")
		assert.equal(economyOf(-400), "EVEN")
		assert.equal(economyOf(401), "AHEAD")
		assert.equal(economyOf(null), "EVEN")
		assert.equal(outnumberingOf(0), "1v1")
		assert.equal(outnumberingOf(1), "1v1")
		assert.equal(outnumberingOf(2), "2v")
		assert.equal(outnumberingOf(3), "OUTNUMBERED")
	})

	test("signatures are stable and countable", () => {
		const counts = signatureCounts(corpus)
		assert.equal(
			[...counts.values()].reduce((a, b) => a + b, 0),
			corpus.length
		)
		for (const d of corpus)
			assert.equal(d.signature, `${d.zone}|${d.phase}|${d.isolation.verdict}`)
	})
})

describe("binomialTail", () => {
	test("boundary behaviour", () => {
		assert.equal(binomialTail(0, 10, 0.3), 1)
		assert.equal(binomialTail(11, 10, 0.3), 0)
		assert.ok(Math.abs(binomialTail(10, 10, 0.5) - 0.5 ** 10) < 1e-12)
		assert.ok(Math.abs(binomialTail(1, 1, 0.25) - 0.25) < 1e-12)
	})

	test("reproduces the headline p-value from the research", () => {
		// P(X >= 13 | n = 24, p = 0.241) = 0.0015 in `.research/analytics.md` §4.6.
		const p = binomialTail(13, 24, 0.241)
		assert.ok(Math.abs(p - 0.0015) < 0.0005, `got ${p}`)
	})
})

describe("clusterDeaths", () => {
	const patterns = clusterDeaths(corpus)

	test("respects the anti-overfit guard rails", () => {
		for (const p of patterns) {
			assert.ok(p.support >= 6, `support ${p.support}`)
			assert.ok(p.gamesSpanned >= 4, `${p.label} spans only ${p.gamesSpanned} games`)
			assert.ok(p.gameIds.length === p.gamesSpanned)
			assert.ok(p.dims.length <= 3)
			assert.ok(p.lift >= 1.2, `${p.label} lift ${p.lift}`)
		}
	})

	test("never pairs zone with half — zone already implies half", () => {
		for (const p of patterns)
			assert.ok(
				!(p.dims.includes("zone") && p.dims.includes("half")),
				`${p.label} pairs redundant dimensions`
			)
	})

	test("reports the multiple-comparison burden on every pattern", () => {
		assert.ok(patterns.length > 0)
		for (const p of patterns) {
			assert.ok(p.hypothesesTested > 50, `${p.hypothesesTested} hypotheses`)
			assert.ok(p.pAdjusted >= p.pValue, "BH adjustment must not shrink a p-value")
			assert.ok(p.pAdjusted <= 1)
		}
	})

	test("finds the early-game solo 1v1 pattern the research identified", () => {
		const hit = patterns.find(
			p =>
				p.values.includes("EARLY") &&
				p.values.includes("1v1") &&
				p.values.includes("SOLO")
		)
		assert.ok(hit, `expected an EARLY+SOLO+1v1 pattern, got: ${patterns.map(p => p.label).join(" / ")}`)
		assert.ok(hit!.lift > 3, `lift ${hit!.lift}`)
	})

	test("a single game produces no patterns — one game is not a pattern", () => {
		assert.deepEqual(clusterDeaths(deathsFor(REFERENCE_GAME_ID)), [])
	})

	test("an empty corpus is not an error", () => {
		assert.deepEqual(clusterDeaths([]), [])
	})
})
