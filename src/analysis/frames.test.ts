import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { FRAME_INTERVAL_MS, USER_PUUID } from "../shared/constants.ts"
import { dist } from "../shared/map.ts"
import { expectedFrameCount } from "../shared/schema/lcu.ts"
import { loadAll, loadFixture, REFERENCE_GAME_ID } from "./__fixtures__/index.ts"
import {
	allEvents,
	bracket,
	framesOf,
	interpPosition,
	interpScalar,
	lastFrameMs,
	mean,
	median,
	participantIdsOf,
	percentile,
	pfOf,
	stdev,
	stepScalar,
	teamGoldAt
} from "./frames.ts"
import { findUser } from "./roles.ts"

const all = loadAll()

describe("timeline shape — the invariants everything else assumes", () => {
	test("every frame has exactly ten participant frames", () => {
		for (const f of all)
			for (const frame of framesOf(f.timeline))
				assert.equal(
					Object.keys(frame.participantFrames).length,
					10,
					`game ${f.gameId} @ ${frame.timestamp}`
				)
	})

	test("participant ids are 1..10 and map to teams 100/200 by the 1-5 / 6-10 rule", () => {
		for (const f of all) {
			assert.deepEqual(
				participantIdsOf(framesOf(f.timeline)),
				[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
			)
			for (const p of f.match.participants)
				assert.equal(
					p.teamId,
					p.participantId <= 5 ? 100 : 200,
					`game ${f.gameId} pid ${p.participantId}`
				)
		}
	})

	test("frames.length === floor(duration / 60) + 2", () => {
		for (const f of all)
			assert.equal(
				framesOf(f.timeline).length,
				expectedFrameCount(f.match.gameDuration),
				`game ${f.gameId}`
			)
	})

	test("frames arrive once per minute, except each game's final partial frame", () => {
		let exact = 0
		let total = 0
		for (const f of all) {
			const frames = framesOf(f.timeline)
			for (let i = 1; i < frames.length; i++) {
				const gap = frames[i]!.timestamp - frames[i - 1]!.timestamp
				total++
				if (Math.abs(gap - FRAME_INTERVAL_MS) < 200) exact++
				else
					assert.equal(
						i,
						frames.length - 1,
						`game ${f.gameId}: off-cadence gap ${gap} at frame ${i}, not the last`
					)
			}
		}
		// The research measured 644 of 665; the ratio is what matters.
		assert.ok(exact / total > 0.95, `${exact}/${total} exact gaps`)
	})

	test("the last frame's timestamp equals gameDuration to within a second", () => {
		for (const f of all) {
			const delta = Math.abs(
				lastFrameMs(framesOf(f.timeline)) / 1000 - f.match.gameDuration
			)
			assert.ok(delta <= 1.1, `game ${f.gameId}: ${delta}s apart`)
		}
	})

	test("only three event types exist, and no event escapes its frame's window", () => {
		const types = new Set<string>()
		for (const f of all) {
			const frames = framesOf(f.timeline)
			for (let i = 0; i < frames.length; i++) {
				const prev = i === 0 ? -1 : frames[i - 1]!.timestamp
				for (const e of frames[i]!.events ?? []) {
					types.add(e.type)
					assert.ok(
						e.timestamp > prev && e.timestamp <= frames[i]!.timestamp,
						`game ${f.gameId}: event at ${e.timestamp} outside (${prev}, ${frames[i]!.timestamp}]`
					)
				}
			}
		}
		assert.deepEqual(
			[...types].sort(),
			["BUILDING_KILL", "CHAMPION_KILL", "ELITE_MONSTER_KILL"]
		)
	})

	test("elite-monster assists really are corrupt, which is why we ignore them", () => {
		let crossTeam = 0
		let listed = 0
		for (const f of all)
			for (const e of allEvents(f.timeline)) {
				if (e.type !== "ELITE_MONSTER_KILL") continue
				const killer = e.killerId ?? 0
				if (killer === 0) continue
				const killerTeam = killer <= 5 ? 100 : 200
				for (const a of e.assistingParticipantIds ?? []) {
					listed++
					if ((a <= 5 ? 100 : 200) !== killerTeam) crossTeam++
				}
			}
		assert.ok(listed > 100, "expected a meaningful number of listed assists")
		assert.ok(
			crossTeam / listed > 0.1,
			`only ${crossTeam}/${listed} cross-team assists — the corruption should be ~19%`
		)
	})

	test("CHAMPION_KILL, by contrast, is internally consistent", () => {
		for (const f of all)
			for (const e of allEvents(f.timeline)) {
				if (e.type !== "CHAMPION_KILL") continue
				const killer = e.killerId ?? 0
				const victim = e.victimId ?? 0
				if (killer === 0) continue
				const killerTeam = killer <= 5 ? 100 : 200
				assert.notEqual(
					killerTeam,
					victim <= 5 ? 100 : 200,
					`game ${f.gameId}: same-team kill at ${e.timestamp}`
				)
				for (const a of e.assistingParticipantIds ?? [])
					assert.equal(a <= 5 ? 100 : 200, killerTeam, "assist crossed teams")
			}
	})
})

describe("bracket / interpolation", () => {
	const f = loadFixture(REFERENCE_GAME_ID)
	const frames = framesOf(f.timeline)

	test("returns null outside the recorded window rather than clamping", () => {
		assert.equal(bracket(frames, -1), null)
		assert.equal(bracket(frames, lastFrameMs(frames) + 1), null)
		assert.equal(bracket([], 0), null)
		assert.equal(interpScalar(frames, 7, lastFrameMs(frames) + 60_000, "totalGold"), null)
		assert.equal(interpPosition(frames, 7, -5), null)
	})

	test("lands exactly on a frame's own values at that frame's timestamp", () => {
		for (const frame of frames) {
			const pf = pfOf(frame, 7)!
			assert.equal(interpScalar(frames, 7, frame.timestamp, "totalGold"), pf.totalGold)
			assert.equal(stepScalar(frames, 7, frame.timestamp, "level"), pf.level)
			assert.deepEqual(interpPosition(frames, 7, frame.timestamp), {
				x: pf.position.x,
				y: pf.position.y
			})
		}
	})

	test("interpolates linearly between frames, and steps for level", () => {
		const a = frames[10]!
		const b = frames[11]!
		const mid = (a.timestamp + b.timestamp) / 2
		const pa = pfOf(a, 7)!
		const pb = pfOf(b, 7)!
		assert.ok(
			Math.abs(
				interpScalar(frames, 7, mid, "totalGold")! -
					(pa.totalGold + pb.totalGold) / 2
			) < 1e-6
		)
		// `level` must never be interpolated into a fractional level.
		assert.equal(stepScalar(frames, 7, mid, "level"), pa.level)
		assert.ok(Number.isInteger(stepScalar(frames, 7, mid, "level")))
	})

	test("interpolation halves the position error — the measurement that forces every hedge", () => {
		/*
		 * `.research/analytics.md` §4.3, reproduced. Ground truth is the exact position on the
		 * user's own CHAMPION_KILL death events; the two candidate reconstructions are the
		 * previous frame and the linear interpolation between the bracketing frames.
		 * Measured medians there: previous frame 2871 units, interpolated 1452.
		 */
		const prevErrors: number[] = []
		const interpErrors: number[] = []
		for (const fx of all) {
			const fr = framesOf(fx.timeline)
			const userId = findUser(fx.match, USER_PUUID)!
			for (const e of allEvents(fx.timeline)) {
				if (e.type !== "CHAMPION_KILL" || e.victimId !== userId || !e.position) continue
				const br = bracket(fr, e.timestamp)
				if (!br) continue
				const prev = pfOf(br.a, userId)
				const interp = interpPosition(fr, userId, e.timestamp)
				if (prev) prevErrors.push(dist(prev.position, e.position))
				if (interp) interpErrors.push(dist(interp, e.position))
			}
		}
		assert.ok(interpErrors.length > 90, `${interpErrors.length} deaths measured`)
		const prevMedian = median(prevErrors)
		const interpMedian = median(interpErrors)
		assert.ok(
			interpMedian < prevMedian * 0.75,
			`interpolation must clearly beat last-known: ${interpMedian} vs ${prevMedian}`
		)
		assert.ok(
			interpMedian > 800 && interpMedian < 2200,
			`interpolated median error ${interpMedian} should be near the measured 1452 units`
		)
		// And it is still worse than a champion's vision radius, which is the whole problem.
		assert.ok(interpMedian > 1350 * 0.7)
	})

	test("median inter-frame displacement is about a quarter of the map", () => {
		const steps: number[] = []
		for (const fx of all) {
			const fr = framesOf(fx.timeline)
			for (let i = 1; i < fr.length; i++)
				for (let pid = 1; pid <= 10; pid++) {
					const a = pfOf(fr[i - 1]!, pid)
					const b = pfOf(fr[i]!, pid)
					if (a && b) steps.push(dist(a.position, b.position))
				}
		}
		// The research measured a median of 4082 units over 6660 samples.
		assert.ok(steps.length > 5000, `${steps.length} samples`)
		assert.ok(
			Math.abs(median(steps) - 4082) < 600,
			`median displacement ${median(steps)}`
		)
	})
})

describe("teamGoldAt", () => {
	test("sums a team's interpolated gold and returns null outside the window", () => {
		const f = loadFixture(REFERENCE_GAME_ID)
		const frames = framesOf(f.timeline)
		const at = frames[15]!.timestamp
		const expected = [1, 2, 3, 4, 5].reduce(
			(a, pid) => a + pfOf(frames[15]!, pid)!.totalGold,
			0
		)
		assert.equal(teamGoldAt(frames, [1, 2, 3, 4, 5], at), expected)
		assert.equal(teamGoldAt(frames, [1, 2, 3], lastFrameMs(frames) + 1), null)
	})
})

describe("summary statistics", () => {
	test("median, mean, stdev and percentile behave", () => {
		assert.equal(median([3, 1, 2]), 2)
		assert.equal(median([4, 1, 3, 2]), 2.5)
		assert.ok(Number.isNaN(median([])))
		assert.equal(mean([1, 2, 3, 4]), 2.5)
		assert.equal(stdev([5]), 0)
		assert.ok(Math.abs(stdev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.13809) < 1e-4)
		assert.equal(percentile([1, 2, 3, 4, 5], 0), 1)
		assert.equal(percentile([1, 2, 3, 4, 5], 1), 5)
		assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3)
		assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5)
		assert.equal(percentile([7], 0.9), 7)
	})
})

describe("degradation", () => {
	test("an absent timeline yields empty frames and empty events, never a throw", () => {
		assert.deepEqual(framesOf(null), [])
		assert.deepEqual(framesOf(undefined), [])
		assert.deepEqual(allEvents(null), [])
		assert.equal(lastFrameMs([]), 0)
		assert.deepEqual(participantIdsOf([]), [])
	})
})
