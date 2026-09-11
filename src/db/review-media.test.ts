/**
 * A feedback item must arrive at the UI carrying the picture that illustrates it.
 *
 * This is the join that makes "show me exactly what to do differently" work. The coach only
 * ever emits `momentIds` — it is never told media ids, because the media may not exist yet
 * when it runs. `media-generate` draws one map SVG per moment, and the frame JOURNAL may add a
 * real frame of the player's own screen much later, or never. So the item-to-picture link CANNOT
 * be frozen at review time; it is resolved on read by `withMomentMedia`.
 *
 * The regression this defends: `FeedbackCard` renders only media whose id appears in
 * `item.mediaIds`. That list is written by the capture pipeline and was empty on every real
 * review, so no feedback item ever showed an illustration even though the SVG for that exact
 * moment was on disk and correctly linked in the `media` table.
 *
 * Run: pnpm test
 */

import { strict as assert } from "node:assert"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, it } from "node:test"
import { closeDb, migrate, useDb } from "./index.ts"
import {
	getReview,
	insertMedia,
	insertReview,
	replaceMoments,
	upsertGame,
	withMomentMedia
} from "./queries.ts"
import type { Media, Moment, Review } from "../shared/schema/domain.ts"

let db: DatabaseSync

const GAME = 5633915410
const MOMENT_IDS = ["g-cs_gap-840", "g-death-492"] as const

const moment = (id: string): Moment => ({
	id,
	gameId: GAME,
	tSec: 840,
	kind: "cs_gap",
	title: "t",
	severity: 0.5,
	mapX: 8593,
	mapY: 7987,
	cameraTarget: null,
	participantsInvolved: [7],
	costGold: 1200,
	confidence: "medium",
	evidence: "e"
})

// media.momentId and review.gameId are real foreign keys, so the rows they point at have to
// exist. The game and moments here are the minimum the schema will accept.
beforeEach(() => {
	db = new DatabaseSync(":memory:")
	migrate(db)
	useDb(db)
	upsertGame({
		gameId: GAME,
		platformId: "NA1",
		queueId: 420,
		gameMode: "CLASSIC",
		gameVersion: "16.17.810.4348",
		patch: "16.17",
		gameCreationMs: 1,
		gameDurationSec: 2035,
		participantId: 7,
		teamId: 200,
		championId: 876,
		win: true
	})
	replaceMoments(GAME, MOMENT_IDS.map(moment))
})

afterEach(() => {
	closeDb()
})

const media = (id: string, momentId: string | null, kind: Media["kind"]): Media => ({
	id,
	gameId: GAME,
	momentId,
	kind,
	path: `media/${GAME}/${id}.svg`,
	width: 640,
	height: 772,
	tSec: 840,
	createdMs: 1,
	source: kind === "map" ? "generated" : "replay"
})

const review = (items: Review["items"]): Review => ({
	id: "rv-test",
	gameId: GAME,
	kind: "game",
	model: "claude-sonnet-5",
	createdMs: 1,
	promptHash: "hash",
	analysisVersion: 1,
	headline: "h",
	encouragement: "e",
	items,
	goals: [],
	status: "ok",
	error: null,
	durationMs: 1,
	inputTokens: 1,
	outputTokens: 1,
	costUsd: 0
})

const item = (
	id: string,
	momentIds: string[],
	mediaIds: string[] = []
): Review["items"][number] => ({
	id,
	gameId: GAME,
	title: "t",
	body: "b",
	severity: "major",
				fix: "do the thing",
				impact: "high" as const,
				actionability: "high" as const,
				confidence: "high" as const,
				priority: 1,
	momentIds,
	mediaIds,
	metricKeys: [],
	tSec: 840
})

describe("withMomentMedia", () => {
	it("gives an item the media drawn for the moments it cites", () => {
		insertMedia(media("g-cs_gap-840-map", "g-cs_gap-840", "map"))
		insertMedia(media("g-death-492-map", "g-death-492", "map"))
		insertReview(review([item("i0", ["g-cs_gap-840", "g-death-492"])]))

		const got = withMomentMedia(getReview(GAME))
		assert.deepEqual(got?.items[0]?.mediaIds, ["g-cs_gap-840-map", "g-death-492-map"])
	})

	it("keeps explicitly attached capture media first and never duplicates it", () => {
		// A real screenshot the capture pipeline attached, plus the generated map for the
		// same moment. Both belong on the card, and the capture must not be reordered away.
		insertMedia(media("shot", "g-death-492", "screenshot"))
		insertMedia(media("g-death-492-map", "g-death-492", "map"))
		insertReview(review([item("i0", ["g-death-492"], ["shot"])]))

		const got = withMomentMedia(getReview(GAME))
		assert.deepEqual(got?.items[0]?.mediaIds, ["shot", "g-death-492-map"])
	})

	it("leaves an item alone when its moments have no media yet", () => {
		// media-generate has not run. The item must survive with an empty list, not throw.
		insertReview(review([item("i0", ["g-death-492"])]))

		const got = withMomentMedia(getReview(GAME))
		assert.deepEqual(got?.items[0]?.mediaIds, [])
	})

	it("does not invent media for an item that cites no moment", () => {
		// An opinion with no citation stays an opinion — it must not borrow another item's map.
		insertMedia(media("g-death-492-map", "g-death-492", "map"))
		insertReview(review([item("i0", [])]))

		const got = withMomentMedia(getReview(GAME))
		assert.deepEqual(got?.items[0]?.mediaIds, [])
	})

	it("passes a null review straight through", () => {
		assert.equal(withMomentMedia(null), null)
	})
})
