/**
 * Two kinds of case, for two different failures.
 *
 * The REGRESSION case replays the real timeline of game 5639406342 and asserts Kayn's CS at six
 * clocks. It is the whole reason this module exists: the live feed reported 0/20/30/50/60/70 at
 * 5/10/14/20/25/28 minutes for a man who had 32/58/84/125/156/183, and a coach built on the first
 * row told the player he was ninety CS ahead while he was eighteen behind. If those six numbers
 * ever move, something upstream has started reading the wrong source again. It is skipped when
 * `data/` is absent, because `data/` is not committed.
 *
 * The SHAPE cases build a two-frame timeline by hand. They ask the questions the recording cannot
 * be made to ask — what `truthAt` does past the end of the game, whether a checkpoint mark past
 * the last frame is dropped rather than answered with a stale one, and whether an elite monster's
 * assist list is refused. None of their numbers is a claim about a real game.
 */

import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { test } from "node:test"
import { BLOB_TIMELINE, blobPath, readBlob } from "../db/blobs.ts"
import type { LcuTimeline } from "../shared/schema/lcu.ts"
import { buildTruth, checkpoints, seatsOf, truthAt, truthEvents } from "./game-truth.ts"

const GAME = 5639406342

/* The counterpart's real CS at each minute mark, hand-checked against the timeline blob and
 * against `participant.cs + participant.jungleCs` (22 + 161 = 183) at the end of the game. */
const KAYN_TRUE_CS: ReadonlyArray<readonly [number, number]> = [
	[300, 32],
	[600, 58],
	[840, 84],
	[1200, 125],
	[1500, 156],
	[1680, 183]
]

/** What the live client showed for the same man at the same six clocks. Kept as the counterexample. */
const KAYN_CLIENT_SHOWED = [0, 20, 30, 50, 60, 70]

test("game 5639406342: the counterpart's CS is the timeline's, not the client's", { skip: !existsSync(blobPath(GAME, BLOB_TIMELINE)) }, () => {
	const timeline = readBlob<LcuTimeline>(GAME, BLOB_TIMELINE)
	assert.ok(timeline, "timeline blob is readable")
	/* Seats as the participant table holds them. Written out rather than queried so the test needs
	 * no database — the blob alone decides the answer. */
	const seats = seatsOf([
		{ participantId: 2, teamId: 100, riotId: "Gooskaffur#NA1", championName: "Lillia", role: "JGL", isUser: 1 },
		{ participantId: 7, teamId: 200, riotId: "TeemoLuvuh#6969", championName: "Kayn", role: "JGL", isUser: 0 }
	])
	const frames = buildTruth(timeline, seats)
	assert.equal(frames.length, 30)

	const got = KAYN_TRUE_CS.map(([at]) => truthAt(frames, at, 35)?.frame.seats[7]?.cs ?? null)
	assert.deepEqual(got, KAYN_TRUE_CS.map(([, cs]) => cs))
	/* And the point of the whole exercise: not one of them is what the client said. */
	for (let i = 0; i < got.length; i++) assert.notEqual(got[i], KAYN_CLIENT_SHOWED[i])

	/* He was never meaningfully ahead and ended eighteen behind — the story the feed reversed. */
	const diffs = KAYN_TRUE_CS.map(([at]) => {
		const f = truthAt(frames, at, 35)?.frame
		return (f?.seats[2]?.cs ?? 0) - (f?.seats[7]?.cs ?? 0)
	})
	assert.deepEqual(diffs, [-4, 10, -4, -4, -4, -18])
})

test("game 5639406342: an elite monster's assist list is never read", { skip: !existsSync(blobPath(GAME, BLOB_TIMELINE)) }, () => {
	const timeline = readBlob<LcuTimeline>(GAME, BLOB_TIMELINE)
	const seats = seatsOf([
		{ participantId: 2, teamId: 100, riotId: "Gooskaffur#NA1", championName: "Lillia", role: "JGL", isUser: 1 },
		{ participantId: 7, teamId: 200, riotId: "TeemoLuvuh#6969", championName: "Kayn", role: "JGL", isUser: 0 }
	])
	const evs = truthEvents(timeline, seats)
	const neutrals = evs.filter(e => e.kind === "objective")
	assert.equal(neutrals.length, 9)
	for (const e of neutrals) assert.deepEqual(e.assists, [])
	/* All nine went to the enemy jungler, and the killer IS reliable. */
	assert.equal(neutrals.filter(e => e.killer?.participantId === 7).length, 9)
	/* BUILDING_KILL.teamId is the team that LOST the building. Twelve of his fell; five enemy ones. */
	const buildings = evs.filter(e => e.kind === "building")
	assert.equal(buildings.filter(b => b.belongedTo === "his").length, 12)
	assert.equal(buildings.filter(b => b.belongedTo === "enemy").length, 5)
})

/* ------------------------------------------------------------------- shape */

const twoFrames = (): LcuTimeline =>
	({
		frames: [
			{
				timestamp: 0,
				participantFrames: {
					"1": {
						participantId: 1, currentGold: 500, totalGold: 500, xp: 0, level: 1,
						minionsKilled: 0, jungleMinionsKilled: 0, position: { x: 500, y: 500 }
					}
				},
				events: []
			},
			{
				timestamp: 60_028,
				participantFrames: {
					"1": {
						participantId: 1, currentGold: 300, totalGold: 900, xp: 400, level: 2,
						minionsKilled: 4, jungleMinionsKilled: 8, position: { x: 7420, y: 7420 }
					}
				},
				events: []
			}
		]
	}) as unknown as LcuTimeline

const oneSeat = seatsOf([
	{ participantId: 1, teamId: 100, riotId: "Someone#TAG", championName: "TestChamp", role: "JGL", isUser: 1 }
])

test("a row carries the frame's own timestamp, never the minute it is near", () => {
	const frames = buildTruth(twoFrames(), oneSeat)
	assert.equal(frames[1]!.atSec, 60)
	/* 60.028 rounds to 60.0 at one decimal, which is the honest reading of a 28ms drift — the
	 * failure this guards is a row LABELLED 1:00 that silently holds a 1:00.5 frame with no gap
	 * reported anywhere, and `truthAt` is what reports it. */
	assert.equal(truthAt(frames, 55, 35)?.gapSec, 5)
})

test("cs is lane plus jungle, because that is what every CS figure in this app means", () => {
	const row = buildTruth(twoFrames(), oneSeat)[1]!.seats[1]!
	assert.equal(row.cs, 12)
	assert.equal(row.laneCs, 4)
	assert.equal(row.jungleCs, 8)
})

test("truthAt past the recorded window returns null rather than the last frame", () => {
	const frames = buildTruth(twoFrames(), oneSeat)
	assert.equal(truthAt(frames, 600, 35), null)
})

test("a checkpoint mark past the last frame is dropped, not answered with a stale one", () => {
	const frames = buildTruth(twoFrames(), oneSeat)
	/* A ten-minute remake must not proudly report a CS@20. */
	assert.deepEqual(checkpoints(frames, [0, 60, 1200], 35).map(c => c.askedAtSec), [0, 60])
})
