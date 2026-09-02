import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { USER_PUUID } from "../shared/constants.ts"
import { Moment, parseOrThrow } from "../shared/schema/domain.ts"
import {
	loadAll,
	loadFixture,
	LONG_GAME_ID,
	REFERENCE_GAME_ID,
	SHORT_GAME_ID
} from "./__fixtures__/index.ts"
import { analyzeDeaths, signatureCounts, type DeathAnalysis } from "./deaths.ts"
import { allEvents } from "./frames.ts"
import { computeMetrics } from "./metrics.ts"
import {
	captureWindow,
	fixabilityOf,
	selectMoments,
	selectMomentsDetailed,
	severityOf,
	type MomentDetail
} from "./moments.ts"
import { findUser, inferRoles } from "./roles.ts"

const all = loadAll()

const corpusDeaths: DeathAnalysis[] = all.flatMap(f => {
	const roles = inferRoles(f.match, f.timeline)
	const userId = findUser(f.match, USER_PUUID)!
	return analyzeDeaths(f.match, f.timeline, roles, userId)
})
const recurrence = signatureCounts(corpusDeaths)

const detailsFor = (gameId: number, options = {}): MomentDetail[] => {
	const f = loadFixture(gameId)
	const roles = inferRoles(f.match, f.timeline)
	const userId = findUser(f.match, USER_PUUID)!
	const metrics = computeMetrics(f.match, f.timeline, roles, userId)
	const deaths = analyzeDeaths(f.match, f.timeline, roles, userId)
	return selectMomentsDetailed(f.match, f.timeline, roles, userId, metrics, deaths, {
		recurrence,
		...options
	})
}

describe("selectMoments — shape and contract", () => {
	test("every emitted moment validates against the domain schema", () => {
		for (const f of all)
			for (const d of detailsFor(f.gameId))
				parseOrThrow(Moment, d.moment, `game ${f.gameId} moment ${d.moment.id}`)
	})

	test("full games produce 5-8 moments; a 7-minute surrender produces fewer, not fabricated ones", () => {
		for (const f of all) {
			const n = detailsFor(f.gameId).length
			if (f.match.gameDuration > 900) assert.ok(n >= 5 && n <= 8, `game ${f.gameId}: ${n}`)
			else assert.ok(n <= 8, `game ${f.gameId}: ${n}`)
		}
		// The 7:33 surrender simply does not contain eight teachable things, and says so.
		assert.ok(detailsFor(SHORT_GAME_ID).length <= 4)
	})

	test("every moment carries tSec and a camera the capture unit can use", () => {
		for (const f of all) {
			const userId = findUser(f.match, USER_PUUID)!
			for (const d of detailsFor(f.gameId)) {
				const m = d.moment
				assert.ok(m.tSec >= 0 && m.tSec <= f.match.gameDuration, `${m.id} tSec ${m.tSec}`)
				assert.ok(Number.isFinite(m.mapX) && Number.isFinite(m.mapY), m.id)
				const w = captureWindow(m, userId, f.match.gameDuration)
				assert.ok(w.startSec < w.focusSec, m.id)
				assert.ok(w.endSec > w.focusSec || w.endSec === f.match.gameDuration, m.id)
				assert.equal(w.focusSec, m.tSec)
				if (m.cameraTarget) assert.equal(w.camera.mode, "FIXED_WORLD_POSITION")
				else assert.equal(w.camera.mode, "FOLLOW_PARTICIPANT")
			}
		}
	})

	test("a death's camera follows the player; a conceded objective points at the objective", () => {
		const details = all.flatMap(f => detailsFor(f.gameId))
		const deathMoments = details.filter(d => d.kind === "death")
		assert.ok(deathMoments.length > 0)
		for (const d of deathMoments) assert.equal(d.moment.cameraTarget, null)

		const missed = details.filter(d => d.kind === "objective_missed")
		assert.ok(missed.length > 0, "expected at least one conceded objective across 20 games")
		for (const d of missed) {
			assert.notEqual(d.moment.cameraTarget, null)
			// The moment is positioned where the PLAYER was; the camera looks at the objective.
			const dx = d.moment.cameraTarget!.x - d.moment.mapX
			const dy = d.moment.cameraTarget!.y - d.moment.mapY
			assert.ok(Math.hypot(dx, dy) > 0, d.moment.id)
		}
	})

	test("every moment carries an evidence line naming its raw data", () => {
		for (const f of all)
			for (const d of detailsFor(f.gameId)) {
				assert.ok(d.moment.evidence.length > 60, d.moment.id)
				assert.ok(
					/CHAMPION_KILL|ELITE_MONSTER_KILL|Frame at|Metric /.test(d.moment.evidence),
					`${d.moment.id}: "${d.moment.evidence}"`
				)
			}
	})

	test("moment ids are deterministic across runs", () => {
		const a = detailsFor(REFERENCE_GAME_ID).map(d => d.moment.id)
		const b = detailsFor(REFERENCE_GAME_ID).map(d => d.moment.id)
		assert.deepEqual(a, b)
		assert.equal(new Set(a).size, a.length, "ids must be unique within a game")
		for (const id of a) assert.ok(id.startsWith(`g${REFERENCE_GAME_ID}-`), id)
	})
})

describe("selectMoments — the selection rules", () => {
	test("no two selected moments are within the 25-second dedupe window", () => {
		for (const f of all) {
			const ts = detailsFor(f.gameId)
				.map(d => d.moment.tSec)
				.sort((a, b) => a - b)
			for (let i = 1; i < ts.length; i++)
				assert.ok(ts[i]! - ts[i - 1]! >= 25, `game ${f.gameId}: ${ts[i - 1]} and ${ts[i]}`)
		}
	})

	test("the game-ending sequence is excluded — the prototype's #1 pick is gone", () => {
		/*
		 * `.research/analytics.md` §8.4: the research prototype's top-scoring moment for this
		 * game was a 38:23 death in the ENEMY BASE during the losing team's last defence, and
		 * §8.3.4 says to fix it. The death is still in the data; it must not be a moment.
		 */
		const f = loadFixture(REFERENCE_GAME_ID)
		const roles = inferRoles(f.match, f.timeline)
		const userId = findUser(f.match, USER_PUUID)!
		const deaths = analyzeDeaths(f.match, f.timeline, roles, userId)
		const endgame = deaths.find(d => d.tSec > f.match.gameDuration - 30)
		assert.ok(endgame, "expected the 38:23 death to exist in the raw analysis")
		assert.equal(endgame!.zone, "ENEMY_BASE")

		const chosen = detailsFor(REFERENCE_GAME_ID)
		assert.ok(
			!chosen.some(d => Math.abs(d.moment.tSec - endgame!.tSec) < 1),
			"the game-ending death must not be selected as a teachable moment"
		)
		for (const d of chosen)
			assert.ok(d.moment.tSec <= f.match.gameDuration - 30, d.moment.id)
	})

	test("an encouraging coach gets a positive moment whenever the game contains one", () => {
		/*
		 * A "positive" is something the player actually did: secured an elite objective, or
		 * killed someone alone or killed their opposite number. If a game contains none of
		 * those, the review is honestly negative — encouragement then has to come from the
		 * prose, not from a fabricated highlight.
		 */
		for (const f of all) {
			const details = detailsFor(f.gameId)
			if (details.length === 0) continue
			const userId = findUser(f.match, USER_PUUID)!
			const positiveTimes = allEvents(f.timeline)
				.filter(e => e.type === "ELITE_MONSTER_KILL" && e.killerId === userId)
				.map(e => e.timestamp / 1000)
				.filter(t => t <= f.match.gameDuration - 30)
			if (positiveTimes.length === 0) continue
			if (details.some(d => d.positive)) continue
			/*
			 * The one legitimate way to have none: every positive collided with the 25-second
			 * dedupe guard against a bigger moment in the same fight. Fixture 5633376663 smites
			 * a dragon at 6:27 and dies in the pit twelve seconds later — one clip, not two.
			 */
			assert.ok(
				positiveTimes.every(t =>
					details.some(d => Math.abs(d.moment.tSec - t) < 25)
				),
				`game ${f.gameId} had positives available but selected none`
			)
		}
	})

	test("positives are capped at two while there are still mistakes to show", () => {
		for (const f of all) {
			const details = detailsFor(f.gameId)
			const positives = details.filter(d => d.positive).length
			const negatives = details.length - positives
			// The cap only binds while negatives are competing for the same slots. A game with
			// nothing to criticise (fixture 5633418474 has zero deaths) is allowed to be a
			// highlight reel rather than a padded list of invented faults.
			if (negatives >= 3) assert.ok(positives <= 2, `game ${f.gameId}: ${positives} positives`)
		}
	})

	test("recurrence is counted over the corpus and boosts repeated signatures", () => {
		const withRecurrence = detailsFor(REFERENCE_GAME_ID)
		const withoutRecurrence = detailsFor(REFERENCE_GAME_ID, {
			recurrence: new Map<string, number>()
		})
		const boosted = withRecurrence.filter(d => d.recurrenceCount > 1)
		assert.ok(boosted.length > 0, "expected at least one repeated signature in the corpus")
		for (const d of boosted) {
			const plain = withoutRecurrence.find(x => x.moment.id === d.moment.id)
			if (plain) assert.ok(d.score > plain.score, `${d.moment.id} was not boosted`)
		}
	})

	test("severity is monotone in score and stays inside 0..1", () => {
		assert.ok(severityOf(0) < severityOf(500))
		assert.ok(severityOf(500) < severityOf(5000))
		assert.ok(severityOf(1e9) <= 1)
		assert.ok(severityOf(-100) >= 0)
		for (const f of all)
			for (const d of detailsFor(f.gameId))
				assert.ok(d.moment.severity >= 0 && d.moment.severity <= 1, d.moment.id)
	})

	test("fixability follows §8.2 exactly", () => {
		const base = {
			isolation: { verdict: "PARTIAL" as const },
			enemiesCredited: 1,
			half: "own" as const,
			economy: "EVEN" as const,
			tSec: 600
		} as unknown as DeathAnalysis
		assert.ok(Math.abs(fixabilityOf(base) - 1.4) < 1e-9)
		const solo = { ...base, isolation: { verdict: "SOLO" } } as DeathAnalysis
		assert.ok(Math.abs(fixabilityOf(solo) - 1.6 * 1.4) < 1e-9)
		const collapsed = { ...base, enemiesCredited: 4 } as DeathAnalysis
		assert.ok(Math.abs(fixabilityOf(collapsed) - 0.8) < 1e-9)
		const deepBehind = {
			...base,
			half: "enemy",
			economy: "BEHIND"
		} as DeathAnalysis
		assert.ok(Math.abs(fixabilityOf(deepBehind) - 1.4 * 1.3) < 1e-9)
		const levelOne = { ...base, tSec: 60 } as DeathAnalysis
		assert.ok(Math.abs(fixabilityOf(levelOne) - 1.4 * 0.6) < 1e-9)
	})

	test("selectMoments is selectMomentsDetailed's moments, in the same order", () => {
		const f = loadFixture(LONG_GAME_ID)
		const roles = inferRoles(f.match, f.timeline)
		const userId = findUser(f.match, USER_PUUID)!
		const metrics = computeMetrics(f.match, f.timeline, roles, userId)
		const deaths = analyzeDeaths(f.match, f.timeline, roles, userId)
		const plain = selectMoments(f.match, f.timeline, roles, userId, metrics, deaths, {
			recurrence
		})
		const detailed = selectMomentsDetailed(
			f.match,
			f.timeline,
			roles,
			userId,
			metrics,
			deaths,
			{ recurrence }
		)
		assert.deepEqual(
			plain.map(m => m.id),
			detailed.map(d => d.moment.id)
		)
		// Chronological, so the review reads as a story.
		for (let i = 1; i < plain.length; i++)
			assert.ok(plain[i]!.tSec >= plain[i - 1]!.tSec)
	})

	test("no timeline means no moments, not invented ones", () => {
		const f = loadFixture(REFERENCE_GAME_ID)
		const roles = inferRoles(f.match, null)
		const userId = findUser(f.match, USER_PUUID)!
		const metrics = computeMetrics(f.match, null, roles, userId)
		assert.deepEqual(
			selectMoments(f.match, null, roles, userId, metrics, []),
			[]
		)
	})
})

describe("captureWindow", () => {
	test("a death gets its approach, not just the death", () => {
		const d = detailsFor(REFERENCE_GAME_ID).find(x => x.kind === "death")!
		const w = captureWindow(d.moment, 7, 2310)
		assert.equal(w.focusSec - w.startSec, 12)
		assert.equal(w.endSec - w.focusSec, 8)
	})

	test("an objective gets a longer run-up", () => {
		const missed = all
			.flatMap(f => detailsFor(f.gameId))
			.find(d => d.kind === "objective_missed")!
		const w = captureWindow(missed.moment, 7)
		assert.equal(w.focusSec - w.startSec, 20)
		assert.equal(w.wantMinimap, true)
	})

	test("clamps to the start of the game", () => {
		const w = captureWindow(
			{
				id: "x",
				gameId: 1,
				tSec: 5,
				kind: "death",
				title: "",
				severity: 0.5,
				mapX: 0,
				mapY: 0,
				cameraTarget: null,
				participantsInvolved: [],
				costGold: null,
				confidence: "high",
				evidence: ""
			},
			7
		)
		assert.equal(w.startSec, 0)
	})
})
