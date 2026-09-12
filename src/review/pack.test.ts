/**
 * The pack's job is to be the channel that cannot be the visibility counter.
 *
 * The regression these tests exist for is specific and expensive: on game 5639406342 the live
 * feed reported the counterpart's CS as 70 when it was 183, and the two items he graded FALSE out
 * of 37 were both built on that number. So the tests below check the SOURCE of every counterpart
 * figure, not just that a number came out.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { buildGamePack, counterpartOf, framesForThisGame, renderPack, segmentFrames } from "./pack.ts"
import { chooseFrames } from "./postgame-call.ts"
import type { Game, ParticipantSummary } from "../shared/schema/domain.ts"
import type { LcuTimeline } from "../shared/schema/lcu.ts"

const player = (over: Partial<ParticipantSummary> & { participantId: number }): ParticipantSummary => ({
	gameId: 1,
	teamId: 100,
	puuid: "",
	riotId: `p${over.participantId}#NA1`,
	championId: 1,
	championName: `Champ${over.participantId}`,
	role: "UNKNOWN",
	roleConfidence: "low",
	isUser: false,
	kills: 0,
	deaths: 0,
	assists: 0,
	cs: 0,
	jungleCs: 0,
	gold: 0,
	visionScore: 0,
	champLevel: 1,
	damageToChampions: 0,
	win: false,
	items: [],
	...over
})

const game: Game = {
	gameId: 1,
	platformId: "NA1",
	queueId: 420,
	gameMode: "CLASSIC",
	gameType: "MATCHED_GAME",
	mapId: 11,
	gameVersion: "16.18.1",
	patch: "16.18",
	gameCreationMs: 0,
	gameDurationSec: 1_200,
	endedAtMs: 1_200_000,
	participantId: 1,
	teamId: 100,
	championId: 1,
	championName: "Lillia",
	role: "JGL",
	roleConfidence: "high",
	win: false,
	kills: 1,
	deaths: 2,
	assists: 3,
	cs: 100,
	jungleCs: 50,
	gold: 9_000,
	visionScore: 12,
	champLevel: 13,
	damageToChampions: 15_000,
	matchBlob: null,
	timelineBlob: null,
	liveBlob: null,
	replayPath: null,
	replayState: "absent",
	ingestedAtMs: 0,
	contentHash: null,
	analysisVersion: 5,
	reviewVersion: 0,
	updatedMs: 0,
	gradeScore: null,
	gradeRank: null
} as unknown as Game

/** Two players, one frame a minute, counterpart farming far faster than the user. */
const timeline = (): LcuTimeline =>
	({
		frames: [0, 60_000, 120_000, 600_000].map((timestamp, i) => ({
			timestamp,
			participantFrames: {
				"1": {
					participantId: 1,
					level: 1 + i,
					minionsKilled: 4 * i,
					jungleMinionsKilled: 6 * i,
					totalGold: 500 + 400 * i,
					currentGold: 100 * i,
					xp: 100 * i,
					position: { x: 4_000, y: 4_000 }
				},
				"6": {
					participantId: 6,
					level: 1 + i,
					// 30 a minute — the number the live feed could never have seen.
					minionsKilled: 20 * i,
					jungleMinionsKilled: 10 * i,
					totalGold: 500 + 700 * i,
					currentGold: 50 * i,
					xp: 140 * i,
					position: { x: 11_000, y: 11_000 }
				}
			},
			events:
				i === 3 ?
					[
						{
							type: "ELITE_MONSTER_KILL",
							timestamp: 600_500,
							killerId: 6,
							monsterType: "DRAGON",
							monsterSubType: "EARTH_DRAGON",
							position: { x: 9_800, y: 4_400 }
						},
						{ type: "CHAMPION_KILL", timestamp: 601_000, killerId: 6, victimId: 1, position: { x: 9_000, y: 9_000 } }
					]
				:	[]
		}))
	}) as unknown as LcuTimeline

const participants = (): ParticipantSummary[] => [
	player({ participantId: 1, teamId: 100, isUser: true, role: "JGL", championName: "Lillia", cs: 100, jungleCs: 65 }),
	player({ participantId: 2, teamId: 100 }),
	player({ participantId: 6, teamId: 200, role: "JGL", championName: "Kayn", cs: 120, jungleCs: 63, items: [6696, 0, 3814] })
]

describe("counterpartOf", () => {
	it("picks the enemy sharing his inferred role", () => {
		const cp = counterpartOf(participants())
		strictEqual(cp?.championName, "Kayn")
		ok(cp.how.includes("same inferred role"))
	})

	/** Role inference fails often enough that the Smite fallback is load-bearing, not decorative. */
	it("falls back to the enemy holding Smite, and says so", () => {
		const rows = participants().map(p =>
			p.participantId === 6 ? player({ ...p, role: "UNKNOWN", spell1Id: 11 }) : player({ ...p, role: "UNKNOWN" })
		)
		const cp = counterpartOf(rows)
		strictEqual(cp?.championName, "Kayn")
		ok(cp.how.includes("Smite"))
	})

	it("returns null rather than guessing when neither test answers", () => {
		const rows = participants().map(p => player({ ...p, role: "UNKNOWN" }))
		strictEqual(counterpartOf(rows), null)
	})
})

describe("buildGamePack", () => {
	const pack = buildGamePack({ game, participants: participants(), timeline: timeline(), frames: [] })

	/**
	 * THE REGRESSION. Every counterpart CS in the pack has to be the timeline's figure. The live
	 * feed's is a visibility counter and is not in this module's reach at all — this test fails
	 * the moment somebody joins one in.
	 */
	it("takes the counterpart's CS, gold and level from the timeline", () => {
		const last = pack.minutes[pack.minutes.length - 1]
		strictEqual(last?.cpCs, 30 * 3)
		strictEqual(last?.cpGold, 500 + 700 * 3)
		strictEqual(last?.meCs, 10 * 3)
		// Him minus counterpart, both exact.
		strictEqual((last?.meCs ?? 0) - (last?.cpCs ?? 0), -60)
	})

	it("states the gap between an objective and the frame that answered for his position", () => {
		const drake = pack.objectives.find(o => o.what.includes("drake"))
		ok(drake, "the drake should be in the pack")
		strictEqual(drake.takenBy, "enemy")
		strictEqual(drake.takenByChampion, "Kayn")
		ok(drake.userGapSec !== null && drake.userGapSec < 1, `gap was ${drake.userGapSec}`)
		ok(drake.userZone !== null)
	})

	it("records his death with the gold he was carrying", () => {
		strictEqual(pack.deaths.length, 1)
		strictEqual(pack.deaths[0]?.killer, "Kayn")
		strictEqual(pack.deaths[0]?.goldInHand, 300)
	})

	/** Effective CS is lane minions PLUS camps everywhere in this app; the scoreboard must agree. */
	it("reports effective CS on the scoreboard", () => {
		strictEqual(pack.scoreboard.find(s => s.isUser)?.cs, 165)
		strictEqual(pack.scoreboard.find(s => s.isCounterpart)?.cs, 183)
	})

	it("renders without a counterpart rather than inventing one", () => {
		const anonymous = participants().map(p => player({ ...p, role: "UNKNOWN" }))
		const text = renderPack(
			buildGamePack({ game, participants: anonymous, timeline: timeline(), frames: [] })
		)
		ok(text.includes("Counterpart: UNKNOWN"))
		ok(text.includes("Do not invent one"))
	})

	it("says out loud that it has no item purchase times", () => {
		const text = renderPack(pack)
		ok(text.includes("ITEM PURCHASE TIMES"))
		ok(text.includes("WARD PLACEMENTS"))
	})

	it("survives a game with no timeline at all", () => {
		const bare = buildGamePack({ game, participants: participants(), timeline: null, frames: [] })
		deepStrictEqual(bare.minutes, [])
		deepStrictEqual(bare.objectives, [])
		strictEqual(bare.scoreboard.length, 3)
		ok(renderPack(bare).length > 0)
	})
})

describe("chooseFrames", () => {
	const frames = (secs: number[]) =>
		secs.map(t => ({ id: `f${t}`, tSec: t, clock: "0:00", path: `/tmp/f${t}.jpg`, hasBlock: true }))

	const packWith = (frameSecs: number[]) => ({
		...buildGamePack({ game, participants: participants(), timeline: timeline(), frames: [] }),
		frames: frames(frameSecs)
	})

	it("puts his death ahead of an objective when only one frame is near both", () => {
		// One frame, 600.5s (the drake) and 601s (his death) both within the window.
		const chosen = chooseFrames(packWith([601]), 1)
		strictEqual(chosen.length, 1)
		ok(chosen[0]?.because.includes("he died"), chosen[0]?.because ?? "no frame chosen")
	})

	it("refuses a frame that is not near any moment", () => {
		strictEqual(chooseFrames(packWith([5]), 4).length, 0)
	})

	it("never uses one frame for two moments", () => {
		const chosen = chooseFrames(packWith([600, 601]), 8)
		strictEqual(new Set(chosen.map(c => c.frame.id)).size, chosen.length)
	})

	it("honours the cap and returns in clock order", () => {
		const chosen = chooseFrames(packWith([600, 601]), 1)
		strictEqual(chosen.length, 1)
		const two = chooseFrames(packWith([600, 601]), 2)
		ok(two.every((c, i) => i === 0 || c.momentSec >= (two[i - 1]?.momentSec ?? 0)))
	})

	it("returns nothing when he did not share his screen", () => {
		strictEqual(chooseFrames(packWith([])).length, 0)
	})

	/**
	 * The frame half a second AFTER a death is a grey respawn screen — the fight, the minimap and
	 * whoever walked at him are all in the frame before it. So a death reaches backwards.
	 */
	it("takes the frame before a death, never the one just after it", () => {
		const chosen = chooseFrames(packWith([596, 604]), 1)
		strictEqual(chosen.length, 1)
		strictEqual(chosen[0]?.frame.tSec, 596)
	})

	it("would rather give a death no picture than a respawn timer", () => {
		// 604s is inside the plain ±6s window and outside a death's, which reaches only backwards.
		const chosen = chooseFrames(packWith([604]), 1)
		ok(!chosen.some(c => c.because.includes("he died")), JSON.stringify(chosen))
	})

	it("refuses a frame that carries no live-client read", () => {
		const blind = packWith([601])
		blind.frames = blind.frames.map(f => ({ ...f, hasBlock: false }))
		strictEqual(chooseFrames(blind, 4).length, 0)
	})

	/** After the nexus falls the screen is the scoreboard; before 0:40 it is the fountain. */
	it("refuses a frame from outside the game itself", () => {
		const after = packWith([601])
		after.durationSec = 300
		strictEqual(chooseFrames(after, 4).length, 0)
		strictEqual(chooseFrames(packWith([20, 25]), 4).length, 0)
	})

	/**
	 * The old code spent the cap in strict rank order, so a game with sixteen deaths sent sixteen
	 * pictures of deaths and not one of an objective — while its own doc string said a quiet
	 * minute beats a sixteenth death.
	 */
	it("shares the cap out rather than letting one tier eat it", () => {
		const many = {
			...packWith(Array.from({ length: 260 }, (_, i) => 590 + i * 5)),
			durationSec: 2_000,
			deaths: Array.from({ length: 20 }, (_, i) => ({
				tSec: 700 + i * 60,
				clock: "10:00",
				zone: "river (bot)",
				killer: "Kayn",
				assists: [],
				goldInHand: 100,
				gapSec: 1
			}))
		}
		const chosen = chooseFrames(many, 16)
		strictEqual(chosen.length, 16)
		const deaths = chosen.filter(c => c.because.includes("he died")).length
		ok(deaths < 16 && deaths >= 6, `${deaths} of 16 went to deaths`)
	})
})

/**
 * THE PICTURE PATH, and the premise that switched it off.
 *
 * Every one of these numbers is from `js-mtvxb5f4-f81a`, the session behind game 5639406342 — 715
 * frames, of which 340 are that game and 375 are game 5639409343, which he queued into 33 minutes
 * later without stopping the screen share. The shape below is that session's shape.
 *
 * The rule this replaced declared the session ambiguous and attached nothing, on the reading that
 * two runs collide on the same game second. The reading was checked and it is an artefact of the
 * LOADER: `framesForGame` orders by `tSec`, which interleaves the two runs into one ascending
 * sequence, and in that order zero of the 715 frames step backwards. In wall-clock order exactly
 * one does, and it is the boundary.
 */
describe("framesForThisGame", () => {
	/** 19:31:50.332Z — the wall-clock instant game 5639406342's clock read zero, measured. */
	const RUN_A_ZERO = Date.parse("2026-09-10T19:31:50.332Z")
	/** 20:05:03.178Z — the same for 5639409343, 1,992.8s later. */
	const RUN_B_ZERO = Date.parse("2026-09-10T20:05:03.178Z")
	/** The match blob stamps creation before the loading screen; measured gaps run +17s to +53s. */
	const GAME_A_CREATED = RUN_A_ZERO - 36_480
	const GAME_B_CREATED = RUN_B_ZERO - 52_560

	const run = (zeroMs: number, tag: string, from: number, to: number) => {
		const out = []
		for (let t = from, i = 0; t <= to; t += 5.01, i++)
			out.push({
				id: `${tag}-${i}`,
				path: `/tmp/${tag}-${i}.jpg`,
				tSec: Math.round(t * 100) / 100,
				atMs: Math.round(zeroMs + t * 1_000),
				truthJson: "{}"
			})
		return out
	}
	/** 340 frames of game A and 375 of game B, handed over in GAME-CLOCK order as the loader did. */
	const bothGames = [...run(RUN_A_ZERO, "a", 0, 1_695.8), ...run(RUN_B_ZERO, "b", 2.3, 1_875)]
	const byGameClock = [...bothGames].sort((x, y) => x.tSec - y.tSec)

	it("the premise does not hold: sorted by game clock, no frame steps backwards", () => {
		strictEqual(
			byGameClock.filter((f, i) => i > 0 && f.tSec < (byGameClock[i - 1]?.tSec ?? 0)).length,
			0
		)
		// Sorted by the wall clock, exactly one does — and that one step is the whole boundary.
		const byWall = [...bothGames].sort((x, y) => x.atMs - y.atMs)
		strictEqual(byWall.filter((f, i) => i > 0 && f.tSec < (byWall[i - 1]?.tSec ?? 0) - 1).length, 1)
	})

	it("cuts the session into one run per game", () => {
		const runs = segmentFrames(byGameClock)
		strictEqual(runs.length, 2)
		strictEqual(runs[0]?.frames.length, 339)
		strictEqual(runs[1]?.frames.length, 374)
		// A run's frames agree to the second about when their game started; two games would not.
		ok((runs[0]?.spreadSec ?? 99) < 1, `run A spread ${runs[0]?.spreadSec}`)
	})

	it("keeps the run that started when THIS game did, and no other", () => {
		const a = framesForThisGame(byGameClock, { gameCreationMs: GAME_A_CREATED })
		strictEqual(a.unattributed, null)
		strictEqual(a.kept.length, 339)
		ok(a.kept.every(f => f.id.startsWith("a-")))
		strictEqual(a.runs, 2)
		strictEqual(a.dropped, 374)

		const b = framesForThisGame(byGameClock, { gameCreationMs: GAME_B_CREATED })
		strictEqual(b.kept.length, 374)
		ok(b.kept.every(f => f.id.startsWith("b-")))
	})

	it("hands back frames in game-clock order whatever order they arrived in", () => {
		const kept = framesForThisGame(
			[...byGameClock].reverse(),
			{ gameCreationMs: GAME_A_CREATED }
		).kept
		ok(kept.every((f, i) => i === 0 || f.tSec >= (kept[i - 1]?.tSec ?? 0)))
	})

	it("leaves a clean single-game session alone", () => {
		const one = run(RUN_A_ZERO, "a", 0, 1_695.8)
		const r = framesForThisGame(one, { gameCreationMs: GAME_A_CREATED })
		strictEqual(r.runs, 1)
		strictEqual(r.dropped, 0)
		strictEqual(r.kept.length, one.length)
	})

	/**
	 * Refusing is still an answer — it is just no longer the only one the code can reach. A game
	 * whose id a session carries but whose clock never started in it gets no pictures and says so.
	 */
	it("refuses, in words, when no run started when this game did", () => {
		const r = framesForThisGame(byGameClock, { gameCreationMs: RUN_A_ZERO - 3_600_000 })
		deepStrictEqual(r.kept, [])
		strictEqual(r.runs, 2)
		ok(r.unattributed?.includes("none of them starts when this game did"), r.unattributed ?? "")
	})

	it("says so in the rendered pack rather than going quiet", () => {
		const built = buildGamePack({
			game,
			participants: participants(),
			timeline: timeline(),
			frames: run(Date.parse("2020-01-01T00:00:00Z"), "x", 0, 100)
		})
		strictEqual(built.frames.length, 0)
		ok(built.source.journalFramesUnattributed !== null)
		ok(renderPack(built).includes("NONE ATTACHED"))
	})

	it("carries the attributed frames into the pack and its rendering", () => {
		const built = buildGamePack({
			game: { ...game, gameCreationMs: GAME_A_CREATED } as typeof game,
			participants: participants(),
			timeline: timeline(),
			frames: byGameClock
		})
		strictEqual(built.source.journalFrames, 339)
		strictEqual(built.source.journalFrameRuns, 2)
		strictEqual(built.source.journalFramesUnattributed, null)
		const text = renderPack(built)
		ok(text.includes("### FRAMES — his own screen"))
		ok(text.includes("recorded 2 games"))
	})
})
