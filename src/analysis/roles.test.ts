import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { SMITE_SPELL_ID, USER_PUUID } from "../shared/constants.ts"
import {
	loadAll,
	loadFixture,
	REFERENCE_GAME_ID,
	SHORT_GAME_ID
} from "./__fixtures__/index.ts"
import { alliesOf, enemiesOf, findUser, inferRoles, laneOpponent } from "./roles.ts"

const all = loadAll()

describe("inferRoles", () => {
	test("produces a well-formed {TOP,JGL,MID,ADC,SUP} for both teams in every fixture", () => {
		for (const f of all) {
			const r = inferRoles(f.match, f.timeline)
			assert.equal(r.wellFormed, true, `game ${f.gameId} was not well-formed`)
			for (const teamId of [100, 200]) {
				const assigned = f.match.participants
					.filter(p => p.teamId === teamId)
					.map(p => r.roles[p.participantId])
				assert.deepEqual(
					[...assigned].sort(),
					["ADC", "JGL", "MID", "SUP", "TOP"],
					`game ${f.gameId} team ${teamId}`
				)
			}
		}
	})

	test("the user is the jungler in all 20 games, at high confidence", () => {
		for (const f of all) {
			const r = inferRoles(f.match, f.timeline)
			const userId = findUser(f.match, USER_PUUID)
			assert.notEqual(userId, null, `user missing from game ${f.gameId}`)
			assert.equal(r.roles[userId!], "JGL", `game ${f.gameId}`)
			assert.equal(r.confidence[userId!], "high", `game ${f.gameId}`)
		}
	})

	test("every inferred jungler holds Smite", () => {
		for (const f of all) {
			const r = inferRoles(f.match, f.timeline)
			for (const p of f.match.participants)
				if (r.roles[p.participantId] === "JGL")
					assert.ok(
						p.spell1Id === SMITE_SPELL_ID || p.spell2Id === SMITE_SPELL_ID,
						`game ${f.gameId} pid ${p.participantId} was called JGL without Smite`
					)
		}
	})

	test("the LCU's own lane/role labels really are garbage — this is why we infer", () => {
		// Reproduces `.research/analytics.md` §2.1: four of ten labelled JUNGLE, one with 273 CS.
		const f = loadFixture(REFERENCE_GAME_ID)
		const apiJungle = f.match.participants.filter(
			p => p.timeline?.lane === "JUNGLE"
		)
		// The doc counted 4 on its capture; this fixture has 5. Either way the field is unusable:
		// a Summoner's Rift game has exactly two junglers.
		assert.ok(
			apiJungle.length >= 4,
			`expected the API to label 4+ players JUNGLE, got ${apiJungle.length}`
		)
		assert.ok(
			apiJungle.some(p => p.stats.totalMinionsKilled > 200),
			"expected at least one 'JUNGLE'-labelled player with lane-CS well over 200"
		)
		const inferred = inferRoles(f.match, f.timeline)
		const inferredJungle = f.match.participants.filter(
			p => inferred.roles[p.participantId] === "JGL"
		)
		assert.equal(inferredJungle.length, 2, "exactly one jungler per team")
	})

	test("all *PerMinDeltas are empty, so there is no shortcut to per-minute stats", () => {
		const f = loadFixture(REFERENCE_GAME_ID)
		for (const p of f.match.participants) {
			const t = p.timeline
			if (!t) continue
			for (const key of [
				"csDiffPerMinDeltas",
				"goldPerMinDeltas",
				"xpDiffPerMinDeltas"
			] as const) {
				const v: object | undefined = t[key]
				if (v !== undefined) assert.equal(Object.keys(v).length, 0, key)
			}
		}
	})

	test("a 7-minute surrender flags its bot lane as unreliable rather than guessing", () => {
		const f = loadFixture(SHORT_GAME_ID)
		const r = inferRoles(f.match, f.timeline)
		assert.ok(r.notes.length > 0, "expected a diagnostic note")
		assert.ok(
			r.notes.some(n => n.includes("ADC/SUP")),
			`expected an ADC/SUP warning, got ${JSON.stringify(r.notes)}`
		)
		for (const teamId of [100, 200]) {
			const bot = f.match.participants.filter(
				p => p.teamId === teamId && ["ADC", "SUP"].includes(r.roles[p.participantId] ?? "")
			)
			for (const p of bot) assert.equal(r.confidence[p.participantId], "low")
		}
		// The jungler is still identified with confidence: Smite does not need a laning phase.
		const userId = findUser(f.match, USER_PUUID)!
		assert.equal(r.roles[userId], "JGL")
		assert.equal(r.confidence[userId], "high")
	})

	test("degrades to Smite + CS with no timeline at all, never throws", () => {
		const f = loadFixture(REFERENCE_GAME_ID)
		const r = inferRoles(f.match, null)
		const userId = findUser(f.match, USER_PUUID)!
		assert.equal(r.roles[userId], "JGL")
		assert.equal(r.confidence[userId], "high")
		assert.ok(r.notes.some(n => n.includes("No timeline")))
		// Without positions, lane assignment cannot be trusted and says so.
		for (const p of f.match.participants)
			if (r.roles[p.participantId] !== "JGL")
				assert.equal(r.confidence[p.participantId], "low")
	})
})

describe("findUser / laneOpponent", () => {
	test("matches on puuid and returns null for a stranger", () => {
		const f = loadFixture(REFERENCE_GAME_ID)
		assert.equal(findUser(f.match, USER_PUUID), 7)
		assert.equal(findUser(f.match, "00000000-0000-0000-0000-000000000000"), null)
	})

	test("the lane opponent of a jungler is the enemy jungler, on the other team", () => {
		for (const f of all) {
			const r = inferRoles(f.match, f.timeline)
			const userId = findUser(f.match, USER_PUUID)!
			const opp = laneOpponent(r, f.match, userId)
			assert.notEqual(opp, null, `game ${f.gameId}`)
			assert.equal(r.roles[opp!], "JGL")
			const me = f.match.participants.find(p => p.participantId === userId)!
			const them = f.match.participants.find(p => p.participantId === opp)!
			assert.notEqual(me.teamId, them.teamId)
		}
	})

	test("allies and enemies partition the other nine players", () => {
		const f = loadFixture(REFERENCE_GAME_ID)
		const userId = findUser(f.match, USER_PUUID)!
		const a = alliesOf(f.match, userId)
		const e = enemiesOf(f.match, userId)
		assert.equal(a.length, 4)
		assert.equal(e.length, 5)
		assert.equal(new Set([...a, ...e, userId]).size, 10)
		assert.ok(!a.includes(userId))
	})
})
