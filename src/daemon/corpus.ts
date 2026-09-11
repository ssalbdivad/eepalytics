/**
 * Loading the user's recent games back out of blob storage.
 *
 * `src/analysis/` is deliberately pure — no database, no files — so somebody has to do the
 * I/O, and that somebody is the daemon. Three things need a corpus rather than a single game:
 *
 *   * the rolling BASELINE that every metric band is measured against (a "bad" cs@10 only
 *     means anything relative to this user's own history),
 *   * the corpus DEATHS that let a moment be scored by how often its signature repeats
 *     ("third time this week you died to the same collapse"), and
 *   * the trend review, which is a corpus by definition.
 *
 * Timelines are ~112 KB of JSON each, so decompressing twenty of them per analysis run is the
 * one genuinely expensive thing the daemon does. They are cached in-process, keyed by gameId,
 * and the cache is bounded.
 *
 * NODE ONLY.
 */

import { USER_PUUID } from "../shared/constants.ts"
import type { LcuGame, LcuTimeline } from "../shared/schema/lcu.ts"
import type { Game } from "../shared/schema/domain.ts"
import { BLOB_MATCH, BLOB_TIMELINE, readBlob } from "../db/blobs.ts"
import { listGames } from "../db/queries.ts"
import { analyzeDeaths, findUser, inferRoles } from "../analysis/index.ts"
import type { DeathAnalysis, TrendGameInput } from "../analysis/index.ts"
import { errText, makeLogger } from "./log.ts"

const log = makeLogger("corpus")

/** Twenty games of match+timeline is roughly 3 MB decoded. Bounded, not clever. */
const CACHE_LIMIT = 32

const matchCache = new Map<number, LcuGame | null>()
const timelineCache = new Map<number, LcuTimeline | null>()

const bound = <T>(cache: Map<number, T>): void => {
	while (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next().value
		if (oldest === undefined) break
		cache.delete(oldest)
	}
}

export const loadMatch = (gameId: number): LcuGame | null => {
	if (matchCache.has(gameId)) return matchCache.get(gameId) ?? null
	let value: LcuGame | null = null
	try {
		value = readBlob<LcuGame>(gameId, BLOB_MATCH)
	} catch (err) {
		log.warn("match blob unreadable", { gameId, err: errText(err) })
	}
	matchCache.set(gameId, value)
	bound(matchCache)
	return value
}

export const loadTimeline = (gameId: number): LcuTimeline | null => {
	if (timelineCache.has(gameId)) return timelineCache.get(gameId) ?? null
	let value: LcuTimeline | null = null
	try {
		value = readBlob<LcuTimeline>(gameId, BLOB_TIMELINE)
	} catch (err) {
		log.warn("timeline blob unreadable", { gameId, err: errText(err) })
	}
	timelineCache.set(gameId, value)
	bound(timelineCache)
	return value
}

/** Drop a game from the cache — call after re-ingesting it. */
export const forgetGame = (gameId: number): void => {
	matchCache.delete(gameId)
	timelineCache.delete(gameId)
}

export const clearCorpusCache = (): void => {
	matchCache.clear()
	timelineCache.clear()
}

export interface CorpusEntry extends TrendGameInput {
	gameId: number
	row: Game
}

/**
 * The most recent `limit` games that actually have a stored match blob, newest first.
 * `excludeGameId` keeps a game out of its own baseline where that matters.
 */
export const loadCorpus = (
	limit: number,
	opts: { excludeGameId?: number; requireTimeline?: boolean } = {}
): CorpusEntry[] => {
	const out: CorpusEntry[] = []
	// Ask for extra rows because some will have no blob yet.
	for (const row of listGames(Math.max(limit * 2, limit + 5))) {
		if (out.length >= limit) break
		if (opts.excludeGameId === row.gameId) continue
		const match = loadMatch(row.gameId)
		if (!match) continue
		const timeline = loadTimeline(row.gameId)
		if (opts.requireTimeline && !timeline) continue
		out.push({ gameId: row.gameId, row, match, timeline })
	}
	return out
}

/**
 * Every death in the corpus, so `analyzeGame` can tell a one-off from a habit.
 *
 * Recurrence is the difference between "you died at 14:30" and "that is the fourth time this
 * week you have died in the enemy blue-side jungle before your jungler showed on the map",
 * and the second one is the review worth reading.
 */
export const corpusDeaths = (entries: readonly CorpusEntry[]): DeathAnalysis[] => {
	const out: DeathAnalysis[] = []
	for (const entry of entries) {
		try {
			const userId = findUser(entry.match, USER_PUUID)
			if (userId === null) continue
			const roles = inferRoles(entry.match, entry.timeline)
			out.push(...analyzeDeaths(entry.match, entry.timeline, roles, userId))
		} catch (err) {
			log.warn("could not analyse deaths", { gameId: entry.gameId, err: errText(err) })
		}
	}
	return out
}
