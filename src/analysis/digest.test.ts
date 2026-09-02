import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { USER_PUUID } from "../shared/constants.ts"
import { loadAll, loadFixture, REFERENCE_GAME_ID, SHORT_GAME_ID } from "./__fixtures__/index.ts"
import { analyzeDeaths, clusterDeaths, signatureCounts, type DeathAnalysis } from "./deaths.ts"
import {
	buildGameDigest,
	buildTrendDigest,
	CITATION_RULES,
	estimateTokens,
	GAME_DIGEST_TOKEN_BUDGET,
	TREND_DIGEST_TOKEN_BUDGET
} from "./digest.ts"
import { analyzeGame } from "./index.ts"
import { computeMetrics } from "./metrics.ts"
import { selectMomentsDetailed } from "./moments.ts"
import { findUser, inferRoles } from "./roles.ts"
import {
	baselineFromRows,
	perGameMetrics,
	trendDetailsFromRows,
	winCorrelationsFromRows
} from "./trends.ts"

const all = loadAll()
const games = all.map(f => ({ match: f.match, timeline: f.timeline }))
const rows = perGameMetrics(games)
const baseline = baselineFromRows(rows)
const corpusDeaths: DeathAnalysis[] = all.flatMap(f => {
	const roles = inferRoles(f.match, f.timeline)
	return analyzeDeaths(f.match, f.timeline, roles, findUser(f.match, USER_PUUID)!)
})
const patterns = clusterDeaths(corpusDeaths)
const recurrence = signatureCounts(corpusDeaths)

const digestFor = (gameId: number) => {
	const f = loadFixture(gameId)
	const roles = inferRoles(f.match, f.timeline)
	const userId = findUser(f.match, USER_PUUID)!
	const metrics = computeMetrics(f.match, f.timeline, roles, userId, baseline)
	const deaths = analyzeDeaths(f.match, f.timeline, roles, userId)
	const moments = selectMomentsDetailed(
		f.match,
		f.timeline,
		roles,
		userId,
		metrics,
		deaths,
		{ recurrence }
	)
	return buildGameDigest({
		match: f.match,
		roles,
		userId,
		metrics,
		moments,
		deaths,
		patterns,
		baseline
	})
}

describe("buildGameDigest", () => {
	test("fits the token budget for every fixture, and says when it had to trim", () => {
		for (const f of all) {
			const d = digestFor(f.gameId)
			const tokens = estimateTokens(d)
			assert.ok(
				tokens <= GAME_DIGEST_TOKEN_BUDGET,
				`game ${f.gameId}: ${tokens} tokens`
			)
			if (d.truncated) assert.ok(d.truncated.includes("not describe"))
		}
	})

	test("never trims the review below five moments or the honesty blocks to nothing", () => {
		for (const f of all) {
			const d = digestFor(f.gameId)
			if (f.match.gameDuration > 900) assert.ok(d.moments.length >= 5, `game ${f.gameId}`)
			assert.equal(d.caveats.length, 5)
			assert.deepEqual(d.citationRules.slice(0, CITATION_RULES.length), [...CITATION_RULES])
			assert.ok(d.baselineNote.length > 40)
		}
	})

	test("carries the context a coach needs and nothing it cannot check", () => {
		const d = digestFor(REFERENCE_GAME_ID)
		assert.equal(d.schema, "csk.game-digest/1")
		assert.equal(d.game.gameId, REFERENCE_GAME_ID)
		assert.equal(d.game.queue, "Ranked Solo/Duo")
		assert.equal(d.game.patch, "16.17")
		assert.equal(d.you.role, "JGL")
		assert.equal(d.you.participantId, 7)
		assert.ok(d.you.opponent, "the jungler's opponent must be named")
		assert.ok(d.you.opponent!.label.includes("enemy jungler"))
		assert.equal(d.scoreboard.length, 10)
		assert.equal(d.scoreboard.filter(r => r.isUser).length, 1)
		assert.equal(d.scoreboard.filter(r => r.isOpponent).length, 1)
		assert.ok(d.objectives.yourTeam["dragons"]! >= 0)
	})

	test("every metric arrives with its band, confidence and explanation", () => {
		const d = digestFor(REFERENCE_GAME_ID)
		assert.ok(d.metrics.length > 20)
		for (const m of d.metrics) {
			assert.ok(["good", "ok", "bad", "unknown"].includes(m.band), m.key)
			assert.ok(["high", "medium", "low"].includes(m.confidence), m.key)
			assert.ok(m.explain.length > 10, m.key)
			assert.ok(Number.isFinite(m.value), m.key)
		}
	})

	test("every moment id is unique and every death is anchored to a clock time", () => {
		for (const f of all) {
			const d = digestFor(f.gameId)
			const ids = d.moments.map(m => m.id)
			assert.equal(new Set(ids).size, ids.length, `game ${f.gameId}`)
			for (const m of d.moments) {
				assert.ok(m.clock.includes(":"), m.id)
				assert.ok(m.evidence.length > 40, m.id)
				assert.ok(m.why.length > 20, m.id)
			}
			for (const x of d.deaths) {
				assert.ok(x.clock.includes(":"))
				assert.ok(x.summary.length > 30)
			}
		}
	})

	test("death patterns always ship their multiple-comparison caveat", () => {
		const d = digestFor(REFERENCE_GAME_ID)
		assert.ok(d.deathPatterns.length > 0)
		for (const p of d.deathPatterns) {
			assert.ok(p.hypothesesTested > 50)
			assert.ok(p.pAdjustedBH >= p.pValue)
			assert.ok(p.caveat.includes("Benjamini-Hochberg"))
			assert.ok(p.gamesSpanned >= 4)
		}
	})

	test("with no baseline the digest says so instead of pretending to grade", () => {
		const f = loadFixture(REFERENCE_GAME_ID)
		const roles = inferRoles(f.match, f.timeline)
		const userId = findUser(f.match, USER_PUUID)!
		const d = buildGameDigest({
			match: f.match,
			roles,
			userId,
			metrics: computeMetrics(f.match, f.timeline, roles, userId),
			moments: [],
			deaths: []
		})
		assert.ok(d.baselineNote.includes("not enough history"))
		for (const m of d.metrics) assert.equal(m.band, "unknown")
	})

	test("champion names fall back visibly rather than inventing a name", () => {
		const d = digestFor(REFERENCE_GAME_ID)
		assert.ok(d.you.champion.startsWith("Champion "))
		const named = digestFor(REFERENCE_GAME_ID)
		assert.equal(named.you.champion, d.you.champion)
		const f = loadFixture(REFERENCE_GAME_ID)
		const roles = inferRoles(f.match, f.timeline)
		const userId = findUser(f.match, USER_PUUID)!
		const withNames = buildGameDigest({
			match: f.match,
			roles,
			userId,
			metrics: [],
			moments: [],
			deaths: [],
			championNames: { 876: "Lillia" }
		})
		assert.equal(withNames.you.champion, "Lillia")
	})

	test("a 7-minute surrender degrades instead of failing", () => {
		const d = digestFor(SHORT_GAME_ID)
		assert.ok(d.metrics.length > 5)
		assert.ok(!d.metrics.some(m => m.key === "cs@20"))
		assert.ok(d.you.roleNote.length > 20)
	})

	test("an unknown participant is an error, not a silently empty digest", () => {
		const f = loadFixture(REFERENCE_GAME_ID)
		const roles = inferRoles(f.match, f.timeline)
		assert.throws(
			() =>
				buildGameDigest({
					match: f.match,
					roles,
					userId: 99,
					metrics: [],
					moments: [],
					deaths: []
				}),
			/participant 99/
		)
	})
})

describe("buildTrendDigest", () => {
	const digest = buildTrendDigest({
		rows,
		series: trendDetailsFromRows(rows),
		patterns,
		deaths: corpusDeaths,
		winCorrelations: winCorrelationsFromRows(rows)
	})

	test("fits the token budget", () => {
		assert.ok(
			estimateTokens(digest) <= TREND_DIGEST_TOKEN_BUDGET,
			`${estimateTokens(digest)} tokens`
		)
	})

	test("keeps trendable and not-trendable series in separate, disjoint lists", () => {
		assert.ok(digest.trendable.length > 0)
		assert.ok(digest.notTrendable.length > 0)
		const trendableKeys = new Set(digest.trendable.map(s => s.key))
		for (const s of digest.notTrendable)
			assert.ok(!trendableKeys.has(s.key), `${s.key} appears in both lists`)
	})

	test("no not-trendable series is described with a direction", () => {
		for (const s of digest.notTrendable)
			assert.ok(
				!/\b(rising|falling|improving|declining)\b/i.test(
					s.why.replace(/no trend line/gi, "")
				) || s.why.includes("No direction"),
				`${s.key}: ${s.why}`
			)
	})

	test("every trendable series states its direction verdict explicitly", () => {
		for (const s of digest.trendable) {
			assert.ok(
				s.direction.includes("flat") || s.direction.includes("slope CI excludes zero"),
				`${s.key}: ${s.direction}`
			)
			assert.ok(s.n >= 10, `${s.key} n=${s.n}`)
		}
	})

	test("the window flags that consecutive games are not independent samples", () => {
		assert.equal(digest.window.games, rows.length)
		assert.equal(digest.window.wins + digest.window.losses, rows.length)
		assert.ok(digest.window.note.includes("NOT independent"))
	})

	test("the death summary reports the corpus, not a single game", () => {
		assert.equal(digest.deathSummary.total, corpusDeaths.length)
		assert.ok(digest.deathSummary.perGame > 4)
		assert.ok(digest.deathSummary.byZone.length > 3)
		assert.ok(digest.deathSummary.note.includes("likelihood"))
	})

	test("win correlations carry the reverse-causality warning", () => {
		const confounded = digest.winCorrelations.filter(c => c.confounded)
		assert.ok(confounded.length > 0)
		for (const c of confounded) assert.ok(c.note.includes("CONSEQUENCE"))
	})

	test("caveats extend the shared set rather than replacing it", () => {
		assert.ok(digest.caveats.length > 5)
		assert.ok(digest.caveats.some(c => c.includes("notTrendable")))
		assert.ok(digest.citationRules.length > CITATION_RULES.length)
	})
})

describe("analyzeGame — the whole pipeline in one call", () => {
	test("produces a consistent result for the reference game", () => {
		const f = loadFixture(REFERENCE_GAME_ID)
		const result = analyzeGame({
			match: f.match,
			timeline: f.timeline,
			baseline,
			corpusDeaths
		})
		assert.ok(result)
		assert.equal(result!.userId, 7)
		assert.equal(result!.roles.roles[7], "JGL")
		assert.ok(result!.metrics.length > 20)
		assert.equal(result!.deaths.length, 6)
		assert.ok(result!.moments.length >= 5 && result!.moments.length <= 8)
		assert.deepEqual(
			result!.moments.map(m => m.id),
			result!.momentDetails.map(d => d.moment.id)
		)
		assert.ok(estimateTokens(result!.digest) <= GAME_DIGEST_TOKEN_BUDGET)
	})

	test("returns null rather than throwing when the user is not in the game", () => {
		const f = loadFixture(REFERENCE_GAME_ID)
		assert.equal(
			analyzeGame({
				match: f.match,
				timeline: f.timeline,
				puuid: "00000000-0000-0000-0000-000000000000"
			}),
			null
		)
	})

	test("works with no timeline and no history at all", () => {
		const f = loadFixture(REFERENCE_GAME_ID)
		const result = analyzeGame({ match: f.match, timeline: null })
		assert.ok(result)
		assert.equal(result!.deaths.length, 0)
		assert.deepEqual(result!.moments, [])
		assert.ok(result!.metrics.length > 5)
		assert.ok(result!.digest.baselineNote.includes("not enough history"))
	})
})
