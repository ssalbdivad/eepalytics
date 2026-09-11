import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { USER_PUUID } from "../shared/constants.ts"
import { loadAll, loadFixture, REFERENCE_GAME_ID } from "./__fixtures__/index.ts"
import { analyzeDeaths, type DeathAnalysis } from "./deaths.ts"
import { analyzeGame } from "./index.ts"
import { findUser, inferRoles } from "./roles.ts"
import { baselineFromRows, perGameMetrics } from "./trends.ts"

const all = loadAll()
const baseline = baselineFromRows(perGameMetrics(all.map(f => ({ match: f.match, timeline: f.timeline }))))
const corpusDeaths: DeathAnalysis[] = all.flatMap(f => {
	const roles = inferRoles(f.match, f.timeline)
	return analyzeDeaths(f.match, f.timeline, roles, findUser(f.match, USER_PUUID)!)
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
	})
})
