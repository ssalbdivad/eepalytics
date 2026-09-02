/**
 * `retention-prune` — reclaim disk without losing anything the user still wants.
 *
 * NOT A QUEUED JOB. `JobKind` in `src/shared/schema/domain.ts` has exactly seven members and
 * `retention-prune` is not one of them, so rather than smuggle in an eighth kind the daemon
 * runs this on a plain timer (on boot, then every six hours). It is idempotent and cheap.
 *
 * WHAT GOES, AND WHY
 *   * `.rofl` files: 15 MB each and they dominate the footprint. Deleted past the retention
 *     window; the game row survives with `replayState = 'pruned'`, which is a different fact
 *     from `'expired'` (Riot lost it) and the UI can say so.
 *   * Captured screenshots and clips (`source: 'replay'`): also large, also re-creatable while
 *     the `.rofl` survives.
 *   * GENERATED map SVGs are KEPT regardless of age. They are a few KB each and they are the
 *     only illustration most moments will ever have — pruning them would silently gut old
 *     reviews to save nothing.
 *   * Terminal jobs and app events older than the window, so the queue and activity screens
 *     stay readable.
 *
 * `retentionDays: 0` means NEVER PRUNE, not "delete everything now".
 *
 * NODE ONLY.
 */

import { rmSync, statSync } from "node:fs"
import { resolveDataPath } from "../../db/blobs.ts"
import {
	deleteMedia,
	gamesForRetentionPrune,
	getSettings,
	listGames,
	listMediaForGame,
	pruneEvents,
	pruneJobs,
	setGameReplayState
} from "../../db/queries.ts"
import { errText, makeLogger } from "../log.ts"

const log = makeLogger("retention")

export interface PruneReport {
	roflsDeleted: number
	bytesFreed: number
	mediaDeleted: number
	jobsPruned: number
	eventsPruned: number
	skipped: boolean
}

const removeFile = (absPath: string): number => {
	try {
		const bytes = statSync(absPath).size
		rmSync(absPath, { force: true })
		return bytes
	} catch {
		return 0
	}
}

/**
 * Run one prune pass. Never throws — a permission error on one file must not stop the daemon
 * from tidying the rest.
 */
export const runRetentionPrune = (nowMs = Date.now()): PruneReport => {
	const settings = getSettings()
	const report: PruneReport = {
		roflsDeleted: 0,
		bytesFreed: 0,
		mediaDeleted: 0,
		jobsPruned: 0,
		eventsPruned: 0,
		skipped: false
	}

	if (settings.retentionDays <= 0) {
		report.skipped = true
		return report
	}

	const cutoffMs = nowMs - settings.retentionDays * 24 * 60 * 60 * 1000

	/* ---- .rofl files ---- */
	for (const game of gamesForRetentionPrune(cutoffMs)) {
		if (!game.replayPath) continue
		try {
			report.bytesFreed += removeFile(game.replayPath)
			setGameReplayState(game.gameId, "pruned")
			report.roflsDeleted++
		} catch (err) {
			log.warn("could not delete replay", {
				gameId: game.gameId,
				path: game.replayPath,
				err: errText(err)
			})
		}
	}

	/* ---- captured media (generated maps are deliberately kept) ---- */
	for (const game of listGames(500)) {
		if (game.endedAtMs >= cutoffMs) continue
		for (const media of listMediaForGame(game.gameId)) {
			if (media.source !== "replay") continue
			try {
				report.bytesFreed += removeFile(resolveDataPath(media.path))
				deleteMedia(media.id)
				report.mediaDeleted++
			} catch (err) {
				log.warn("could not delete media", { id: media.id, err: errText(err) })
			}
		}
	}

	/* ---- bookkeeping ---- */
	try {
		report.jobsPruned = pruneJobs(cutoffMs)
		report.eventsPruned = pruneEvents(cutoffMs)
	} catch (err) {
		log.warn("could not prune queue history", { err: errText(err) })
	}

	if (report.roflsDeleted > 0 || report.mediaDeleted > 0 || report.jobsPruned > 0)
		log.info("retention pass complete", {
			rofls: report.roflsDeleted,
			mediaFiles: report.mediaDeleted,
			mb: Math.round(report.bytesFreed / 1e5) / 10,
			jobs: report.jobsPruned,
			events: report.eventsPruned,
			days: settings.retentionDays
		})

	return report
}

export default runRetentionPrune
