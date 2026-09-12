/**
 * Reconciliation — the thing that makes "it runs in the background while I play" true.
 *
 * On boot and on a timer, diff what the League client knows against what the database has,
 * and queue whatever is missing. Everything else in the daemon is a latency optimisation on
 * top of this sweep: if the daemon was asleep, the machine was off, or the WebSocket dropped
 * three games ago, reconcile is what notices.
 *
 * TWO FACTS SHAPE IT
 *   * Match-history pagination does NOT work. `begIndex`/`endIndex` are parsed and silently
 *     ignored; every request returns the same server-chosen ~20 recent games, and the window
 *     was observed shrinking from 21 to 5 inside twenty minutes. So: harvest ids into SQLite
 *     and keep them forever. `/games/{id}` and `/game-timelines/{id}` accept arbitrary ids, so
 *     anything we have ever seen stays re-fetchable long after it falls out of the window.
 *   * The replay for a finished game is deleted 30 minutes after it ends. Download is queued
 *     first and with a hard deadline; nothing else in the pipeline is time-critical.
 *
 * NODE ONLY.
 */

import { readdirSync } from "node:fs"
import { ANALYSIS_VERSION, REPLAY_DIR_WSL, REVIEW_VERSION } from "../shared/constants.ts"
import { isListEntry } from "../shared/schema/lcu.ts"
import {
	countMoments,
	existingGameIds,
	gamesNeedingAnalysis,
	gamesNeedingIngest,
	gamesNeedingReview,
	getGame,
	getSettings,
	getTrendReview,
	listGames,
	mediaCounts,
	setGameReplayState
} from "../db/queries.ts"
import { fetchMatchHistory, roflExistsOnDisk, roflPathFor } from "./lcu.ts"
import {
	enqueueAnalysis,
	enqueueGameReview,
	enqueueMatchIngest,
	enqueueMediaGenerate,
	enqueueReplayDownload,
	enqueueTrendReview,
	replayWindowOpen
} from "./queue.ts"
import { errText, makeLogger } from "./log.ts"

/**
 * How far back the automatic review sweep will reach.
 *
 * Long enough to cover a daemon that was off overnight, short enough that switching the
 * feature on can never be a hundred-review bill. See the sweep itself for the argument.
 */
const REVIEW_SWEEP_WINDOW_MS = 24 * 60 * 60_000

const log = makeLogger("reconcile")

export interface ReconcileReport {
	/** How many gameIds the history window actually returned. */
	historyWindow: number
	newGames: number[]
	reIngest: number[]
	analysis: number[]
	reviews: number[]
	media: number[]
	downloads: number[]
	/** Games whose `.rofl` we found sitting on disk without a database row saying so. */
	adopted: number[]
	trendQueued: boolean
	lcuReachable: boolean
	durationMs: number
	note?: string
}

const empty = (note: string): ReconcileReport => ({
	historyWindow: 0,
	newGames: [],
	reIngest: [],
	analysis: [],
	reviews: [],
	media: [],
	downloads: [],
	adopted: [],
	trendQueued: false,
	lcuReachable: false,
	durationMs: 0,
	note
})

/**
 * One full sweep. Safe to call as often as you like — every enqueue is deduped per
 * (kind, gameId) while a job is still live, so a reconcile storm cannot double-run a review.
 */
export const reconcile = async (): Promise<ReconcileReport> => {
	const startedMs = Date.now()
	const settings = getSettings()
	const report: ReconcileReport = { ...empty(""), note: undefined }

	/* ---- 1. new games from the (unpaginated) history window ---- */
	let history = null
	try {
		history = await fetchMatchHistory()
	} catch (err) {
		log.warn("match history read failed", { err: errText(err) })
	}

	if (history) {
		report.lcuReachable = true
		const entries = history.games.games
		report.historyWindow = entries.length
		const ids = entries.map(g => g.gameId).filter(id => Number.isFinite(id) && id > 0)
		const known = existingGameIds(ids)
		for (const entry of entries) {
			if (known.has(entry.gameId)) continue
			report.newGames.push(entry.gameId)
			enqueueMatchIngest(entry.gameId)
			// The list endpoint carries only ONE participant, so we cannot tell yet whether the
			// replay is worth chasing — but the 30-minute clock is already running, so queue the
			// download now from the list entry's own end time and let the handler sort it out.
			if (isListEntry(entry)) {
				const endedAtMs = entry.gameCreation + entry.gameDuration * 1000
				if (replayWindowOpen(endedAtMs)) {
					const id = enqueueReplayDownload(entry.gameId, endedAtMs)
					if (id !== null) report.downloads.push(entry.gameId)
				}
			}
		}
	} else report.note = "League client unreachable; worked from the local database only"

	/* ---- 2. games we know about but never finished ingesting ---- */
	// Pagination is broken, so a game can be in the DB as a stub (seen in a window that has
	// since shrunk) with no timeline. Those stay re-fetchable by id forever.
	for (const gameId of gamesNeedingIngest(50)) {
		report.reIngest.push(gameId)
		enqueueMatchIngest(gameId)
	}

	/* ---- 3. derived work whose version is stale ---- */
	for (const gameId of gamesNeedingAnalysis(ANALYSIS_VERSION, 50)) {
		report.analysis.push(gameId)
		enqueueAnalysis(gameId)
	}

	/*
	 * THE SWEEP IS A SAFETY NET FOR THE FORWARD PATH, NOT A BACKFILL.
	 *
	 * `analysis-run` chains straight into `review-game`, so a game he just played is already
	 * queued by the time this runs. What this catches is the game whose chain was broken — the
	 * daemon was down when it ended, the analysis version moved, a review failed and the retry
	 * budget reset. All of those are recent by construction.
	 *
	 * Unbounded it is something else entirely. This machine holds 110 games below the current
	 * `REVIEW_VERSION`, and `autoReviewNewGames` is a checkbox labelled "review each game as it
	 * finishes" — ticking it must not commission a hundred and ten model calls. It did before
	 * this window existed: the sweep runs every five minutes and takes twenty games a pass, so
	 * the backlog would have gone out inside half an hour, billed, behind the game he was
	 * actually waiting on.
	 *
	 * Backfilling the archive is a real and separate thing to want, and it belongs behind its
	 * own deliberate action rather than behind the automatic switch.
	 */
	if (settings.autoReviewNewGames) {
		const oldestMs = Date.now() - REVIEW_SWEEP_WINDOW_MS
		for (const gameId of gamesNeedingReview(REVIEW_VERSION, 20)) {
			const game = getGame(gameId)
			if (!game || game.endedAtMs < oldestMs) continue
			report.reviews.push(gameId)
			enqueueGameReview(gameId)
		}
	}

	/* ---- 4. the always-available visual ---- */
	// A generated map image is the fallback that makes the product work with capture off, so a
	// game with moments and no media is a bug the user would actually notice.
	const media = mediaCounts()
	for (const game of listGames(30)) {
		if ((media.get(game.gameId) ?? 0) > 0) continue
		if (countMoments(game.gameId) === 0) continue
		report.media.push(game.gameId)
		enqueueMediaGenerate(game.gameId)
	}

	/* ---- 5. .rofl files already sitting on disk ---- */
	// There is no "list downloaded replays" endpoint in the LCU — enumerating the directory is
	// the only way. The client auto-downloads end-of-game replays on its own, so files appear
	// that no job of ours put there, and without this sweep the UI would say "absent" about a
	// replay the user can actually watch.
	report.adopted.push(...adoptOnDiskReplays())

	/* ---- 6. replay downloads still inside the 30-minute window ---- */
	for (const game of listGames(10)) {
		if (game.replayState !== "absent") continue
		if (!replayWindowOpen(game.endedAtMs)) continue
		const id = enqueueReplayDownload(game.gameId, game.endedAtMs)
		if (id !== null && !report.downloads.includes(game.gameId))
			report.downloads.push(game.gameId)
	}

	/* ---- 7. the cross-game trend review ---- */
	if (settings.autoReviewNewGames && shouldRefreshTrend(settings.gamesForTrends)) {
		enqueueTrendReview()
		report.trendQueued = true
	}

	report.durationMs = Date.now() - startedMs
	log.info("reconcile complete", {
		window: report.historyWindow,
		new: report.newGames.length,
		reIngest: report.reIngest.length,
		analysis: report.analysis.length,
		reviews: report.reviews.length,
		media: report.media.length,
		downloads: report.downloads.length,
		adopted: report.adopted.length,
		trend: report.trendQueued,
		ms: report.durationMs
	})
	return report
}

/**
 * Mark games whose `.rofl` is already on disk as `available`.
 *
 * Filenames are `{platformId}-{gameId}.rofl`. Only games we know about are adopted — a replay
 * for somebody else's match, or one from before this install, is left alone.
 */
const adoptOnDiskReplays = (limit = 200): number[] => {
	const adopted: number[] = []
	let names: string[]
	try {
		names = readdirSync(REPLAY_DIR_WSL)
	} catch {
		// The directory does not exist (fresh install, or the client has never recorded one).
		return adopted
	}
	const onDisk = new Set<number>()
	for (const name of names) {
		const m = /^[A-Z0-9]+-(\d+)\.rofl$/i.exec(name)
		if (m?.[1]) onDisk.add(Number(m[1]))
	}
	if (onDisk.size === 0) return adopted

	for (const game of listGames(limit)) {
		if (!onDisk.has(game.gameId)) continue
		if (game.replayState === "available" && game.replayPath) continue
		const path = roflPathFor(game.gameId, game.platformId)
		if (!roflExistsOnDisk(path)) continue
		setGameReplayState(game.gameId, "available", path)
		adopted.push(game.gameId)
	}
	if (adopted.length > 0) log.info("adopted on-disk replays", { gameIds: adopted })
	return adopted
}

/**
 * Is the trend review stale?
 *
 * Trends need evidence. A single new game is not a pattern, so the cross-game review is only
 * refreshed once at least three reviewed games have landed since the last one — which also
 * stops every ingest from spending a Claude call on the same twenty games.
 */
export const shouldRefreshTrend = (gamesForTrends: number): boolean => {
	const games = listGames(Math.max(3, gamesForTrends))
	const reviewed = games.filter(g => g.reviewVersion >= REVIEW_VERSION)
	if (reviewed.length < 3) return false
	const trend = getTrendReview()
	if (!trend) return true
	const since = reviewed.filter(g => g.ingestedAtMs > trend.createdMs).length
	return since >= 3
}

/**
 * The urgent path, called the moment the client leaves `InProgress`.
 *
 * We may know the gameId before match history does, so this queues ingest directly and lets
 * the handler defer while `/games/{id}` still 404s. It also queues the replay download from
 * the wall clock, because the 30-minute countdown starts NOW and waiting for the next full
 * reconcile could burn several minutes of it.
 */
export const reconcileFinishedGame = async (
	gameId: number | null
): Promise<ReconcileReport> => {
	if (gameId !== null && Number.isFinite(gameId) && gameId > 0) {
		log.info("urgent ingest for finished game", { gameId })
		enqueueMatchIngest(gameId)
		const known = getGame(gameId)
		// Best available end time: the DB if we already have it, otherwise "just now".
		const endedAtMs = known?.endedAtMs ?? Date.now()
		enqueueReplayDownload(gameId, endedAtMs)
	}
	return reconcile()
}
