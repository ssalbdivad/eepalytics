/**
 * Evidence for the parts of the web layer that can run without a DOM: the formatters, the
 * hash router, and — the one that actually matters — that this build's response validators
 * accept a well-formed payload from the daemon and reject a malformed one.
 *
 * Run with `pnpm test`.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { type } from "arktype"
import {
	GameDetailResponse,
	GameListResponse,
	HealthResponse,
	JobListResponse,
	LiveResponse,
	TrendsResponse
} from "../../shared/schema/api.ts"
import { DEFAULT_SETTINGS, Settings } from "../../shared/schema/settings.ts"
import { parseRoute } from "./hooks.ts"
import {
	fmtCompact,
	fmtDelta,
	fmtInterval,
	fmtKdaRatio,
	fmtMetricDelta,
	fmtMetricValue,
	fmtQty,
	jobReason,
	replayCountdown
} from "./format.ts"

/* ------------------------------------------------------------ fixtures */

const game = {
	gameId: 5461234567,
	platformId: "NA1",
	queueId: 420,
	gameMode: "CLASSIC",
	gameCreationMs: 1_756_800_000_000,
	gameDurationSec: 2310,
	endedAtMs: 1_756_802_310_000,
	patch: "16.17",
	gameVersion: "16.17.810.4348",
	win: true,
	participantId: 3,
	teamId: 100,
	championId: 876,
	championName: "Lillia",
	role: "JGL",
	roleConfidence: "high",
	kills: 7,
	deaths: 4,
	assists: 12,
	cs: 12,
	jungleCs: 175,
	gold: 13_400,
	visionScore: 34,
	champLevel: 16,
	damageToChampions: 24_100,
	replayState: "available",
	hasTimeline: true,
	analysisVersion: 1,
	reviewVersion: 1,
	ingestedAtMs: 1_756_802_400_000
} as const

const moment = {
	id: "g5461234567-death-1173",
	gameId: game.gameId,
	tSec: 1173,
	kind: "death",
	title: "Died to a 3-man collapse at raptors",
	severity: 0.8,
	mapX: 9200,
	mapY: 4300,
	cameraTarget: null,
	participantsInvolved: [3, 7, 8, 9],
	costGold: 900,
	confidence: "medium",
	evidence: "CHAMPION_KILL at 1173.4s, victimId 3, killerId 8"
} as const

/* --------------------------------------------------------------- tests */

describe("response validators", () => {
	it("accepts a well-formed game list", () => {
		const out = GameListResponse({
			games: [{ ...game, hasReview: true, momentCount: 6, mediaCount: 2 }]
		})
		assert.ok(!(out instanceof type.errors), String(out))
	})

	it("accepts a well-formed game detail, review and all", () => {
		const out = GameDetailResponse({
			game,
			participants: [],
			metrics: [
				{
					key: "camps@8",
					label: "Camps by 8:00",
					value: 18,
					unit: "cs",
					band: "good",
					vsBaseline: 2,
					confidence: "high",
					explain: "18 camps by 8:00, vs your 20-game median of 16"
				}
			],
			moments: [moment],
			review: {
				id: "rev-1",
				gameId: game.gameId,
				kind: "game",
				model: "claude-sonnet-5",
				createdMs: 1_756_802_500_000,
				promptHash: "abc123",
				analysisVersion: 1,
				headline: "Oner would have taken that crab. You took a nap.",
				encouragement: "The 8-minute clear was genuinely clean though.",
				items: [
					{
						id: "fb-1",
						gameId: game.gameId,
						title: "Cross-mapped at 19:33",
						body: "You were at raptors with Baron spawning in 40s.",
						severity: "major",
						fix: "Take your own raptors instead.",
						impact: "high",
						actionability: "high",
						confidence: "high",
						priority: 0.87,
						momentIds: [moment.id],
						mediaIds: [],
						metricKeys: ["camps@8"],
						tSec: 1173
					}
				],
				goals: ["Path toward the next objective 45s before it spawns."]
			},
			media: [],
			journalFrames: [],
			timelineAvailable: true
		})
		assert.ok(!(out instanceof type.errors), String(out))
	})

	it("rejects a game detail that is missing the honesty fields", () => {
		const bad = { ...moment } as Record<string, unknown>
		delete bad.evidence
		delete bad.confidence
		const out = GameDetailResponse({
			game,
			participants: [],
			metrics: [],
			moments: [bad],
			review: null,
			media: [],
			journalFrames: [],
			timelineAvailable: true
		})
		assert.ok(out instanceof type.errors, "a moment without evidence must not validate")
	})

	it("accepts health in every degraded shape the daemon may report", () => {
		for (const daemon of ["ok", "starting", "degraded", "stopped"] as const) {
			const out = HealthResponse({
				daemon,
				lcu: "disconnected",
				bridge: "none",
				gameflowPhase: null,
				queueDepth: 0,
				version: "0.1.0"
			})
			assert.ok(!(out instanceof type.errors), `${daemon}: ${String(out)}`)
		}
	})

	it("accepts a deferred job carrying its reason", () => {
		const out = JobListResponse({
			jobs: [
				{
					id: 12,
					kind: "replay-download",
					gameId: game.gameId,
					state: "deferred",
					intrusive: false,
					attempts: 0,
					maxAttempts: 2,
					priority: 90,
					lastError: "the League client is not running",
					notBeforeMs: 1_756_802_500_000,
					deadlineMs: null,
					createdMs: 1_756_802_400_000,
					updatedMs: 1_756_802_450_000
				}
			]
		})
		assert.ok(!(out instanceof type.errors), String(out))
	})

	it("accepts the idle live payload with and without a game that just ended", () => {
		const idle = { inGame: false, reason: "no game in progress", nudges: [] }
		assert.ok(!(LiveResponse(idle) instanceof type.errors))

		// The debrief the coach window draws the moment a game finishes.
		const ended = LiveResponse({
			...idle,
			justEnded: {
				gameId: game.gameId,
				endedAtMs: 1_756_802_600_000,
				stage: "stored",
				championName: game.championName,
				win: game.win
			}
		})
		assert.ok(!(ended instanceof type.errors), String(ended))

		// And the seconds before the client has handed the match over, when there is no id yet.
		const waiting = LiveResponse({
			...idle,
			justEnded: { gameId: null, endedAtMs: 1_756_802_600_000, stage: "ingesting" }
		})
		assert.ok(!(waiting instanceof type.errors), String(waiting))
	})

	it("rejects a justEnded whose stage this build does not know", () => {
		const out = LiveResponse({
			inGame: false,
			nudges: [],
			justEnded: { gameId: 1, endedAtMs: 1_756_802_600_000, stage: "reviewed" }
		})
		assert.ok(out instanceof type.errors, "an unknown stage must not validate")
	})

	it("accepts a trend series that admits it is noise", () => {
		const out = TrendsResponse({
			review: null,
			series: [
				{
					key: "vs-per-min",
					label: "Vision score / min",
					points: [{ gameId: game.gameId, tMs: game.gameCreationMs, value: 0.88 }],
					mean: 0.88,
					ci95: null,
					trendable: false,
					note: "n=1, spread swamps the slope"
				}
			],
			gameCount: 1,
			generatedMs: 1_756_802_600_000
		})
		assert.ok(!(out instanceof type.errors), String(out))
	})

	it("accepts the settings defaults it ships with", () => {
		const out = Settings(DEFAULT_SETTINGS)
		assert.ok(!(out instanceof type.errors), String(out))
	})
})

describe("hash router", () => {
	it("maps every screen", () => {
		// The coach is the front door; history is somewhere you go from it. `live` is the SAME
		// content rendered chrome-free for the always-on-top overlay window, so both must exist.
		assert.equal(parseRoute("").name, "home")
		assert.equal(parseRoute("#/").name, "home")
		assert.equal(parseRoute("#/live").name, "live")
		assert.equal(parseRoute("#/games").name, "games")
		assert.equal(parseRoute("#/trends").name, "trends")
		assert.equal(parseRoute("#/queue").name, "queue")
		assert.equal(parseRoute("#/settings").name, "settings")
	})

	it("parses a game id and refuses a junk one", () => {
		const r = parseRoute("#/game/5461234567")
		assert.deepEqual(r, { name: "game", gameId: 5461234567 })
		assert.equal(parseRoute("#/game/nope").name, "notfound")
		assert.equal(parseRoute("#/game/0").name, "notfound")
	})

	it("lands #/debrief/:id on the same screen as #/game/:id", () => {
		// There is one review screen now. The old `#/debrief/:id` spelling still parses because the
		// post-game panel emitted it as a link for the whole time it was the only way in, and a
		// bookmark of a game he cared about must not 404.
		assert.deepEqual(parseRoute("#/debrief/5461234567"), { name: "game", gameId: 5461234567 })
		assert.equal(parseRoute("#/debrief/nope").name, "notfound")
	})
})

describe("formatters", () => {
	const base = {
		key: "k",
		label: "l",
		band: "ok",
		vsBaseline: null,
		confidence: "high",
		explain: ""
	} as const

	it("never prints a fake zero for a missing number", () => {
		assert.equal(fmtCompact(Number.NaN), "--")
		assert.equal(fmtDelta(Number.NaN), "--")
		assert.equal(fmtQty(Number.NaN, "gold"), "--")
	})

	it("signs deltas, including exactly zero", () => {
		assert.equal(fmtDelta(340), "+340")
		assert.equal(fmtDelta(-41), "−41")
		assert.equal(fmtDelta(0), "±0")
	})

	it("compacts large gold figures — for a column with nothing beside them", () => {
		assert.equal(fmtCompact(24_100), "24k")
		assert.equal(fmtCompact(1240), "1.2k")
		assert.equal(fmtCompact(987), "987")
	})

	it("calls a deathless game Perfect rather than dividing by zero", () => {
		assert.equal(fmtKdaRatio(7, 0, 12), "Perfect")
		assert.equal(fmtKdaRatio(7, 4, 12), "4.75")
	})

	it("respects each unit's precision", () => {
		assert.equal(fmtMetricValue({ ...base, value: 4.876, unit: "/min" }), "4.88")
		assert.equal(fmtMetricValue({ ...base, value: 24.31, unit: "%" }), "24.3%")
		assert.equal(fmtMetricValue({ ...base, value: 79, unit: "cs" }), "79")
	})

	/*
	 * The three defects the policy was written for, as assertions. Each of these shipped: the
	 * pairing, the phantom decimal, and the interval quoted finer than the number it brackets.
	 */
	it("never compacts a figure that has a delta printed under it", () => {
		// `1.9k gold` sat directly above `+1954 vs your avg` on the post-game panel.
		const m = { ...base, key: "goldDelta@14", value: 1879, unit: "gold", vsBaseline: 1954 }
		assert.equal(fmtMetricValue(m), "1,879")
		assert.equal(fmtMetricDelta(m), "+1,954 vs your avg")
	})

	it("gives a counting unit no decimals at all", () => {
		// `1545.0 xp` — a tenth of an experience point is not a thing that was measured.
		assert.equal(fmtQty(1545, "xp"), "1,545")
		assert.equal(fmtQty(775, "xp"), "775")
		assert.equal(fmtQty(4351, "units"), "4,351")
	})

	it("trims a trailing zero off every standalone figure", () => {
		assert.equal(fmtQty(21, ""), "21")
		assert.equal(fmtQty(8.1, "/min"), "8.1")
		assert.equal(fmtQty(100, "%"), "100%")
		assert.equal(fmtQty(0, ""), "0")
	})

	it("keeps a delta at least as fine as its value, so a small move is not rounded away", () => {
		// 8 assists against an average of 7.85: `+0` would say the opposite of what happened.
		assert.equal(fmtDelta(0.15, "", 8), "+0.15")
		// ...and does not invent precision in the other direction.
		assert.equal(fmtDelta(1954, "gold", 1879), "+1,954")
	})

	it("prints an interval at the grain of the number it brackets", () => {
		// The trends table said `72.45 ± 2.88` above a chart header reading `mean 72`.
		assert.equal(fmtInterval(72.45, 2.88), "72.5 ± 2.9")
		assert.equal(fmtInterval(150.1, 8.94), "150 ± 9")
		// One grain wins over trimming inside a pair: `7.59 ± 0.4` is two precisions.
		assert.equal(fmtInterval(7.59, 0.4), "7.59 ± 0.40")
		assert.equal(fmtInterval(8.1, null), "8.1")
	})

	it("carries the percent sign onto the delta as well as the value", () => {
		const m = { ...base, key: "enemyHalfPct", value: 30, unit: "%", vsBaseline: 16.8 }
		assert.equal(fmtMetricValue(m), "30%")
		assert.equal(fmtMetricDelta(m), "+16.8% vs your avg")
	})

	it("stops counting down once the 30-minute replay window has closed", () => {
		const ended = 1_000_000_000_000
		assert.equal(replayCountdown(ended, ended + 10 * 60_000)?.startsWith("replay"), true)
		assert.equal(replayCountdown(ended, ended + 31 * 60_000), null)
	})

	it("surfaces a deferred job's reason verbatim", () => {
		const job = {
			id: 1,
			kind: "replay-download",
			gameId: null,
			state: "deferred",
			intrusive: false,
			attempts: 0,
			maxAttempts: 2,
			priority: 90,
			lastError: "the League client is not running",
			notBeforeMs: 0,
			deadlineMs: null,
			createdMs: 0,
			updatedMs: 0
		} as const
		assert.equal(jobReason(job), "the League client is not running")
	})
})
