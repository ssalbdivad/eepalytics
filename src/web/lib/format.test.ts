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
	fmtKdaRatio,
	fmtMetricValue,
	fmtSigned,
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

	// Deliberately a `replay-capture` row: that kind is retired, but six of them are still in
	// the job table and `JobListResponse` validates what the Queue screen renders. If the member
	// is ever dropped from `JobKind`, this is the test that catches the 500 it would cause.
	it("accepts a deferred job of a retired kind, carrying its reason", () => {
		const out = JobListResponse({
			jobs: [
				{
					id: 12,
					kind: "replay-capture",
					gameId: game.gameId,
					state: "deferred",
					intrusive: true,
					attempts: 0,
					maxAttempts: 2,
					priority: 90,
					lastError: "you're in ChampSelect; needs None/Lobby for 2 min",
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
})

describe("formatters", () => {
	it("never prints a fake zero for a missing number", () => {
		assert.equal(fmtCompact(Number.NaN), "--")
		assert.equal(fmtSigned(Number.NaN), "--")
	})

	it("signs deltas, including exactly zero", () => {
		assert.equal(fmtSigned(340), "+340")
		assert.equal(fmtSigned(-41), "−41")
		assert.equal(fmtSigned(0), "±0")
	})

	it("compacts large gold figures", () => {
		assert.equal(fmtCompact(24_100), "24k")
		assert.equal(fmtCompact(1240), "1.2k")
		assert.equal(fmtCompact(987), "987")
	})

	it("calls a deathless game Perfect rather than dividing by zero", () => {
		assert.equal(fmtKdaRatio(7, 0, 12), "Perfect")
		assert.equal(fmtKdaRatio(7, 4, 12), "4.75")
	})

	it("respects each unit's precision", () => {
		const base = { key: "k", label: "l", band: "ok", vsBaseline: null, confidence: "high", explain: "" } as const
		assert.equal(fmtMetricValue({ ...base, value: 4.876, unit: "/min" }), "4.88")
		assert.equal(fmtMetricValue({ ...base, value: 13_400, unit: "gold" }), "13k")
		assert.equal(fmtMetricValue({ ...base, value: 24.31, unit: "%" }), "24.3%")
	})

	it("stops counting down once the 30-minute replay window has closed", () => {
		const ended = 1_000_000_000_000
		assert.equal(replayCountdown(ended, ended + 10 * 60_000)?.startsWith("replay"), true)
		assert.equal(replayCountdown(ended, ended + 31 * 60_000), null)
	})

	it("surfaces a deferred job's reason verbatim, retired kinds included", () => {
		const job = {
			id: 1,
			kind: "replay-capture",
			gameId: null,
			state: "deferred",
			intrusive: true,
			attempts: 0,
			maxAttempts: 2,
			priority: 90,
			lastError: "you're in ChampSelect",
			notBeforeMs: 0,
			deadlineMs: null,
			createdMs: 0,
			updatedMs: 0
		} as const
		assert.equal(jobReason(job), "you're in ChampSelect")
	})
})
