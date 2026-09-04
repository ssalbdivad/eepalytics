/**
 * `retention-prune` — reclaim disk without losing anything the user still wants.
 *
 * NOT A QUEUED JOB. `JobKind` in `src/shared/schema/domain.ts` has exactly seven members and
 * `retention-prune` is not one of them, so rather than smuggle in an eighth kind the daemon
 * runs this on a plain timer (on boot, then every six hours). It is idempotent and cheap.
 *
 * WHAT GOES, AND WHY
 *   * `.rofl` files THIS APP DOWNLOADED, i.e. the ones under `DATA_DIR`: 15 MB each and they
 *     dominate the footprint. Deleted past the retention window; the game row survives with
 *     `replayState = 'pruned'`, which is a different fact from `'expired'` (Riot lost it) and
 *     the UI can say so.
 *   * A `.rofl` OUTSIDE `DATA_DIR` is never touched. `replayPath` frequently points into the
 *     user's own `Documents/League of Legends/Replays` folder, because the League client
 *     downloads there and this app adopts what it finds. Those files predate us, the user may
 *     be keeping them deliberately, and a coaching tool has no business deleting a game
 *     recording it did not create. They keep `replayState = 'available'`, which is the truth:
 *     the replay is still on disk and still playable.
 *   * Media with `source: 'replay'`: large, and re-creatable while the `.rofl` survives. There
 *     are none — replay capture never wrote a row and has since been removed — so this pass is
 *     a no-op today. It is kept because it is also the thing that PROTECTS the generated maps:
 *     delete it and the next person writing a prune has to rediscover that distinction.
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
import { resolve, sep } from "node:path"
import { DATA_DIR } from "../../shared/constants.ts"
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
	/** Old enough to prune, but outside `DATA_DIR`, so left alone. See the file header. */
	roflsKept: number
	bytesFreed: number
	mediaDeleted: number
	jobsPruned: number
	eventsPruned: number
	skipped: boolean
}

/**
 * Is this a file we put there?
 *
 * Only paths under `DATA_DIR` are ours to delete. The comparison is on the resolved path with a
 * trailing separator, so a sibling directory whose name merely starts with the same characters
 * (`/data-backup` next to `/data`) is not mistaken for a child.
 */
const isOurs = (absPath: string): boolean => {
	const root = resolve(DATA_DIR)
	const target = resolve(absPath)
	return target === root || target.startsWith(root + sep)
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
		roflsKept: 0,
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

	/* ---- .rofl files we downloaded ourselves ---- */
	for (const game of gamesForRetentionPrune(cutoffMs)) {
		if (!game.replayPath) continue
		if (!isOurs(game.replayPath)) {
			report.roflsKept++
			continue
		}
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

	/* ---- replay-sourced media (generated maps and journal frames are deliberately kept) ---- */
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
			roflsKept: report.roflsKept,
			mediaFiles: report.mediaDeleted,
			mb: Math.round(report.bytesFreed / 1e5) / 10,
			jobs: report.jobsPruned,
			events: report.eventsPruned,
			days: settings.retentionDays
		})

	return report
}

export default runRetentionPrune
