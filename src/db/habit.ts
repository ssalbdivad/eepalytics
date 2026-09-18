/**
 * Loading the habit tracker's rows: the one place the pure counter in `analysis/habit.ts` meets
 * the stored timelines.
 *
 * NODE ONLY — it reads blobs off disk. The arithmetic lives in `analysis/habit.ts` and is
 * browser-safe; this file exists so that module never has to know where a game is kept.
 *
 * ## Why there is a cache and no table
 *
 * A habit answer is a pure function of a timeline, and a timeline never changes after ingest, so
 * the answer for a given game is the same forever. That makes a stored column an optimisation
 * rather than a source of truth — and a stored column is also a thing that can go stale, be
 * back-filled wrongly, or be rewritten when the definition moves, which is the one thing this
 * repo will not do to a measurement. So: recomputed from the blob, memoised in process, and the
 * memo is keyed by habit as well as by game because the two habits read different events.
 *
 * Cost, measured on this machine: a timeline is 112 KB raw / 12 KB gzipped and the whole twenty-
 * game window parses in well under a second cold, and is free warm. If that ever stops being
 * true the fix is a table, and the table is still not allowed to be the truth.
 */

import { BLOB_TIMELINE, readBlob } from "./blobs.ts"
import { recentHabitGames, teamParticipantIds, type HabitGameRow } from "./queries.ts"
import {
	gameHabit,
	habitInput,
	habitRecord,
	type HabitDef,
	type HabitGame,
	type HabitRecord
} from "../analysis/habit.ts"
import type { LcuTimeline } from "../shared/schema/lcu.ts"

const memo = new Map<string, HabitGame>()

/** Exposed for tests; nothing in the running app needs to forget an answer. */
export const clearHabitCache = (): void => memo.clear()

const answerFor = (def: HabitDef, row: HabitGameRow): HabitGame => {
	const key = `${row.gameId}:${def.key}`
	const hit = memo.get(key)
	if (hit) return hit
	const timeline = readBlob<LcuTimeline>(row.gameId, BLOB_TIMELINE)
	const input = habitInput(timeline, row.participantId, teamParticipantIds(row.gameId, row.teamId))
	const answer = gameHabit(def, input, {
		gameId: row.gameId,
		createdMs: row.gameCreationMs,
		championName: row.championName,
		win: row.win,
		durationSec: row.gameDurationSec
	})
	memo.set(key, answer)
	return answer
}

/** The record for one habit over his last `limit` ranked games. Newest first. */
export const loadHabitRecord = (def: HabitDef, limit = 20): HabitRecord =>
	habitRecord(
		def,
		recentHabitGames(limit).map(row => answerFor(def, row))
	)
