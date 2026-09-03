/**
 * Browse the replay folder and coach a file directly, without waiting for match history.
 *
 *   GET  /api/replays              -> ReplayListResponse
 *   POST /api/replays/ingest       -> { gameId }   (adopt a .rofl and queue analysis + review)
 *
 * WHY THIS EXISTS. Everything else in the app starts from the LCU's match history, which
 * silently hands back a server-chosen ~20-game window (`begIndex`/`endIndex` are ignored). A
 * `.rofl` on disk that has fallen out of that window is unreachable, even though it holds a
 * complete end-of-game stat block. Reading the folder makes the archive the source of truth
 * instead of the client's memory.
 *
 * WHAT A .rofl CAN AND CANNOT SUPPORT. The trailing JSON carries 371 stats per player, which is
 * MORE end-of-game detail than the LCU gives — final items, runes, wards placed and killed,
 * control wards bought. What it does not carry is the TIMELINE: the chunk payloads need the game
 * engine to decode, so there are no per-minute positions, no events, and therefore no moments,
 * no map zones, and no "where were you at 14:12". A replay-only review is honest but thinner,
 * and `buildGameDigest` already says so in its notes when `timeline` is null.
 *
 * Reading a file is not a side effect on the League client, so this does not go through the
 * gate. It never launches anything.
 */

import { Hono } from "hono"
import { existsSync } from "node:fs"
import { basename, resolve } from "node:path"
import {
	enqueue,
	existingGameIds,
	getGame,
	getSettings,
	setGameBlobs,
	upsertParticipants,
	upsertGame
} from "../../db/queries.ts"
import {
	decodeRofl,
	findPlayerByPuuid,
	listReplays,
	tryDecodeRofl
} from "../../rofl/decode.ts"
import type { RoflFile, RoflPlayerStats } from "../../rofl/decode.ts"
import { roflToMatch } from "../../rofl/to-match.ts"
import { BLOB_MATCH, writeBlob } from "../../db/blobs.ts"
import { REPLAY_DIR_WSL, USER_PUUID, patchOf } from "../../shared/constants.ts"
import { ReplayListResponse } from "../../shared/schema/api.ts"
import type { ParticipantSummary } from "../../shared/schema/domain.ts"
import { fail, notFound, send } from "../respond.ts"

/** The configured folder, or the built-in default when the setting is blank. */
export const replayFolder = (): string => {
	const configured = getSettings().replayFolder.trim()
	return configured === "" ? REPLAY_DIR_WSL : configured
}

/**
 * Decoding reads ~0.8% of a 15 MB file, but a folder can hold hundreds. Cache by path+mtime so
 * re-opening the browser does not re-read the archive; an edited file changes mtime and re-reads.
 */
const cache = new Map<string, { mtimeMs: number; file: RoflFile }>()

const decodeCached = (path: string, mtimeMs: number): RoflFile | null => {
	const hit = cache.get(path)
	if (hit && hit.mtimeMs === mtimeMs) return hit.file
	const file = tryDecodeRofl(path)
	if (file) cache.set(path, { mtimeMs, file })
	return file
}

const teamOf = (file: RoflFile, teamId: number): RoflPlayerStats[] =>
	file.stats.filter(p => p.teamId === teamId)

export const createReplayRoutes = (): Hono => {
	const app = new Hono()

	app.get("/replays", c => {
		const dir = replayFolder()
		const entries = listReplays(dir)
		const known = existingGameIds(
			entries.map(e => e.gameId).filter((n): n is number => n !== null)
		)

		const replays = entries.map(entry => {
			const file = decodeCached(entry.path, entry.mtimeMs)
			const me = file ? findPlayerByPuuid(file, USER_PUUID) : null
			return {
				fileName: entry.fileName,
				path: entry.path,
				gameId: entry.gameId,
				platformId: entry.platformId,
				bytes: entry.bytes,
				mtimeMs: entry.mtimeMs,
				// A file that will not decode is listed anyway, with `readable: false`. Hiding it
				// would make a corrupt or renamed replay look like it was never there.
				readable: file !== null,
				playerCount: file?.stats.length ?? 0,
				patch: file?.patch ?? null,
				durationSec: file ? Math.round(file.gameLengthMs / 1000) : null,
				championName: me?.championName ?? null,
				role: me?.role ?? null,
				win: me?.win ?? null,
				kills: me?.kills ?? null,
				deaths: me?.deaths ?? null,
				assists: me?.assists ?? null,
				cs: me === null ? null : me.cs + me.jungleCs,
				// `inLibrary` is the useful distinction in the UI: a game already harvested from
				// match history has a timeline and gets the full review; one only on disk does not.
				inLibrary: entry.gameId !== null && known.has(entry.gameId),
				hasTimeline:
					entry.gameId !== null && known.has(entry.gameId) ?
						getGame(entry.gameId)?.hasTimeline === true
					:	false
			}
		})

		return send(c, ReplayListResponse, { folder: dir, replays }, "GET /api/replays")
	})

	app.post("/replays/ingest", async c => {
		const body = (await c.req.json().catch(() => null)) as { fileName?: unknown } | null
		const fileName = typeof body?.fileName === "string" ? basename(body.fileName) : ""
		if (fileName === "" || !fileName.toLowerCase().endsWith(".rofl"))
			return fail(c, 400, "fileName must name a .rofl file", "bad-file")

		// `basename` above is the containment check: the caller names a file IN the configured
		// folder, never a path. Without it this route would read any file on disk.
		const path = resolve(replayFolder(), fileName)
		if (!existsSync(path)) return notFound(c, fileName)

		let file: RoflFile
		try {
			file = decodeRofl(path)
		} catch (err) {
			return fail(
				c,
				422,
				`that replay could not be read: ${err instanceof Error ? err.message : String(err)}`,
				"undecodable"
			)
		}

		if (file.gameId === null)
			return fail(
				c,
				422,
				"this replay's filename no longer carries its game id, and the id is not stored " +
					"inside the file — rename it back to <platform>-<gameId>.rofl to use it",
				"no-game-id"
			)

		const me = findPlayerByPuuid(file, USER_PUUID)
		if (file.stats.length === 0)
			return fail(
				c,
				422,
				"this replay has no end-of-game stats — a game remade this early never gets any " +
					"written, so there is nothing in the file to coach",
				"remake"
			)
		if (!me)
			return fail(
				c,
				422,
				"you are not one of the ten players in this replay, so there is nothing to coach",
				"not-your-game"
			)

		const gameId = file.gameId
		const existing = getGame(gameId)
		const durationSec = Math.round(file.gameLengthMs / 1000)

		// Do NOT clobber a game harvested from match history: that row has a timeline, and this
		// one does not. Adopt the replay path and leave the richer record alone.
		upsertGame({
			gameId,
			platformId: file.platformId ?? "NA1",
			queueId: existing?.queueId ?? 0,
			gameMode: existing?.gameMode ?? "CLASSIC",
			gameVersion: file.gameVersion,
			patch: file.patch || patchOf(file.gameVersion),
			// The file carries no timestamp; mtime is the only clock available. Keep a harvested
			// creation time when we have one, because it is real.
			gameCreationMs: existing?.gameCreationMs ?? Math.round(file.mtimeMs - durationSec * 1000),
			gameDurationSec: durationSec,
			endedAtMs: existing?.endedAtMs ?? Math.round(file.mtimeMs),
			participantId: existing?.participantId ?? me.index + 1,
			teamId: me.teamId,
			championId: existing?.championId ?? 0,
			championName: me.championName,
			role: me.role,
			roleConfidence: me.role === "UNKNOWN" ? "low" : "high",
			win: me.win,
			kills: me.kills,
			deaths: me.deaths,
			assists: me.assists,
			cs: me.cs,
			jungleCs: me.jungleCs,
			gold: me.gold,
			visionScore: me.visionScore,
			champLevel: me.champLevel,
			damageToChampions: me.damageToChampions,
			replayPath: path,
			replayState: "available",
			contentHash: `rofl:${file.networkProtocolDigestHex}:${file.fileBytes}`,
			// Force re-analysis: the row's stats may have changed and the metrics are derived.
			analysisVersion: 0,
			reviewVersion: 0
		})

		upsertParticipants(
			gameId,
			file.stats.map(
				(p): ParticipantSummary => ({
					gameId,
					participantId: p.index + 1,
					teamId: p.teamId,
					puuid: p.puuid,
					riotId: p.riotId,
					// The file names champions by internal string ("LeeSin") and carries no
					// numeric id. 0 means "unknown" rather than a wrong id.
					championId: 0,
					championName: p.championName,
					role: p.role,
					roleConfidence: p.role === "UNKNOWN" ? "low" : "high",
					isUser: p.puuid === USER_PUUID,
					kills: p.kills,
					deaths: p.deaths,
					assists: p.assists,
					cs: p.cs,
					jungleCs: p.jungleCs,
					gold: p.gold,
					visionScore: p.visionScore,
					champLevel: p.champLevel,
					damageToChampions: p.damageToChampions,
					win: p.win,
					// Present in the .rofl and absent from the LCU timeline. Carried through
					// because the file has them, not because anything grades them yet.
					...(p.spell1Id === null ? {} : { spell1Id: p.spell1Id }),
					...(p.spell2Id === null ? {} : { spell2Id: p.spell2Id }),
					items: p.items
				})
			)
		)

		// Analysis reads the MATCH BLOB, not the game row — without one it defers forever with
		// "no match blob stored yet" and the adopted replay produces no metrics at all. The file
		// holds the same end-of-game facts, so translate rather than weaken the analysis. Never
		// overwrite a blob harvested from the LCU: that one has a matching timeline.
		if (!existing?.hasTimeline) {
			const match = roflToMatch(file)
			// The column carries the path; writing the file alone leaves `loadMatch` blind.
			if (match) setGameBlobs(gameId, { matchBlob: writeBlob(gameId, BLOB_MATCH, match) })
		}

		enqueue({ kind: "analysis-run", gameId })
		enqueue({ kind: "review-game", gameId })

		return c.json({
			gameId,
			championName: me.championName,
			adopted: existing === null,
			hasTimeline: existing?.hasTimeline === true,
			teams: { blue: teamOf(file, 100).length, red: teamOf(file, 200).length }
		})
	})

	return app
}
