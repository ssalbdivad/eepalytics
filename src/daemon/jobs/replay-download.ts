/**
 * `replay-download` — ask the League client to fetch the `.rofl` for a finished game.
 *
 * THIS IS THE ONLY TIME-CRITICAL JOB IN THE SYSTEM. `/lol-replays/v1/configuration` reports
 * `minutesUntilReplayConsideredLost: 30`: half an hour after a game ends the replay is gone
 * from Riot's side forever. So the job carries a hard `deadlineMs`, runs at high priority, and
 * once the window closes it is marked `expired` and never retried — retrying would only
 * produce noise about something that cannot be recovered.
 *
 * It is NOT intrusive. Nothing launches, no window opens; the client downloads a file in the
 * background while the user is in champ select for their next game. This app no longer has any
 * caller for `/rofls/{id}/watch`, the route that DOES hijack the machine — see `lcu/client.ts`.
 *
 * The `.rofl` is still worth having: `src/rofl/` decodes it for the 371-stat end-of-game block,
 * which is richer than anything the LCU returns and reaches games that have fallen out of match
 * history entirely.
 *
 * HONEST STATUS: the POST bodies here are UNVERIFIED. The research proved the routes exist
 * (a GET against them returns 405 WRONG_METHOD rather than 404) but deliberately never called
 * them, because the user was mid-game. Every failure mode below degrades to a clear message
 * rather than a retry storm.
 *
 * NODE ONLY.
 */

import { PLATFORM_ID } from "../../shared/constants.ts"
import { getGame, setGameReplayState } from "../../db/queries.ts"
import { publish, sleep } from "../bus.ts"
import {
	createReplayMetadata,
	fetchReplayMetadata,
	getCreds,
	roflExistsOnDisk,
	roflPathFor,
	startReplayDownload
} from "../lcu.ts"
import type { JobContext, JobOutcome } from "../context.ts"

export { roflPathFor }

/** The `.rofl` for this game if it is already on disk, else `null`. */
export const roflOnDisk = (platformId: string, gameId: number): string | null => {
	const path = roflPathFor(gameId, platformId)
	return roflExistsOnDisk(path) ? path : null
}

/**
 * `LolReplaysMetadataState`, read from the client's own type table. The two that end the job
 * for good are `missingOrExpired` (Riot no longer has it) and `lost` (the 30 minutes ran out).
 */
const TERMINAL_GONE = new Set(["missingOrExpired", "lost"])
const TERMINAL_INCOMPATIBLE = new Set(["incompatible", "unsupported"])
const TRANSIENT = new Set(["checking", "found"])

const POLL_MS = 2_000

export const runReplayDownload = async (ctx: JobContext): Promise<JobOutcome> => {
	const gameId = ctx.job.gameId
	if (gameId === null) throw new Error("replay-download requires a gameId")

	const deadlineMs = ctx.job.deadlineMs
	if (deadlineMs !== null && deadlineMs <= Date.now())
		return { expire: { reason: "the 30-minute replay window closed" } }

	const game = getGame(gameId)
	const platformId = game?.platformId ?? PLATFORM_ID

	/*
	 * Already on disk?
	 *
	 * A file existing is NOT proof it is complete — the client writes the `.rofl` as it
	 * downloads, and a 1 MB fragment of a 16 MB replay looks exactly like a finished file to
	 * `statSync`. So the client's own `state === "watch"` is the authority whenever it can be
	 * asked, and the bare file is trusted only when it cannot.
	 */
	const existing = roflOnDisk(platformId, gameId)
	if (!getCreds()) {
		if (existing) {
			setGameReplayState(gameId, "available", existing)
			return { note: "on disk (client closed, so completeness is unconfirmed)" }
		}
		return {
			defer: {
				reason: "League client is closed; cannot request a replay download",
				untilMs: Date.now() + 30_000
			}
		}
	}
	if (existing) {
		const known = await fetchReplayMetadata(gameId)
		// `watch` = downloaded and playable. No local metadata at all means the client has
		// never touched this game, so the file on disk is whatever was there before us.
		if (!known || known.state === "watch") {
			setGameReplayState(gameId, "available", existing)
			publish("game", { gameId, stage: "replay-available", path: existing }, gameId)
			return { note: "already on disk" }
		}
	}

	/* ---- local metadata must exist before state means anything ---- */
	let metadata = await fetchReplayMetadata(gameId)
	if (!metadata) {
		// 404 does NOT mean expired — it means the client has never created a local metadata
		// record for this gameId. Create it from the match-history fields, then re-read.
		if (!game)
			return {
				defer: {
					reason: "waiting for match-ingest to supply the game version and queue",
					untilMs: Date.now() + 20_000
				}
			}
		ctx.progress("creating local replay metadata")
		const created = await createReplayMetadata({
			gameId,
			gameVersion: game.gameVersion,
			gameType: "MATCHED_GAME",
			queueId: game.queueId,
			gameEndMs: game.endedAtMs
		})
		if (!created.ok) throw new Error(`metadata create failed: ${created.error}`)
		await sleep(500, ctx.signal)
		metadata = await fetchReplayMetadata(gameId)
	}

	if (!metadata)
		throw new Error("client still has no local metadata for this replay after creating it")

	if (TERMINAL_GONE.has(metadata.state)) {
		setGameReplayState(gameId, "expired")
		return { expire: { reason: `client reports replay state "${metadata.state}"` } }
	}
	if (TERMINAL_INCOMPATIBLE.has(metadata.state)) {
		setGameReplayState(gameId, "expired")
		return {
			expire: {
				reason: `replay was recorded on a different patch (state "${metadata.state}")`
			}
		}
	}

	/* ---- start it if it has not started ---- */
	if (metadata.state === "download" || metadata.state === "retryDownload") {
		ctx.progress("requesting replay download")
		const started = await startReplayDownload(gameId)
		if (!started.ok) throw new Error(`download request failed: ${started.error}`)
		setGameReplayState(gameId, "downloading")
		publish("game", { gameId, stage: "replay-downloading" }, gameId)
	} else if (TRANSIENT.has(metadata.state))
		return {
			defer: {
				reason: `client is still ${metadata.state}`,
				untilMs: Date.now() + 10_000
			}
		}
	else if (metadata.state === "error")
		throw new Error("client reported an error preparing this replay")

	/* ---- poll to completion, inside the window ---- */
	let lastProgress = -1
	while (!ctx.signal.aborted) {
		if (deadlineMs !== null && Date.now() >= deadlineMs) {
			setGameReplayState(gameId, "expired")
			return { expire: { reason: "the 30-minute replay window closed mid-download" } }
		}

		// Ask the CLIENT, not the filesystem: a partially written .rofl is already on disk.
		const poll = await fetchReplayMetadata(gameId)
		const state = poll?.state
		if (!poll) {
			// The client forgot the record mid-download. Fall back to the file, and say so.
			const onDisk = roflOnDisk(platformId, gameId)
			if (onDisk) {
				setGameReplayState(gameId, "available", onDisk)
				publish("game", { gameId, stage: "replay-available", path: onDisk }, gameId)
				return { note: `on disk at ${onDisk} (client lost its metadata record)` }
			}
		}
		if (state === "watch") {
			// `watch` means the file is on disk and playable, even if our path guess missed.
			const path = roflOnDisk(platformId, gameId)
			setGameReplayState(gameId, "available", path)
			publish("game", { gameId, stage: "replay-available", path }, gameId)
			return { note: path ? `downloaded to ${path}` : "client reports the replay is ready" }
		}
		if (state && TERMINAL_GONE.has(state)) {
			setGameReplayState(gameId, "expired")
			return { expire: { reason: `client reports replay state "${state}"` } }
		}
		if (state === "error") throw new Error("client reported an error while downloading")

		if (state === "downloading") {
			// `downloadProgress` is uint32 and is uninitialised garbage until the state is
			// actually `downloading`, so it is only ever reported from inside this branch.
			const p = poll?.downloadProgress ?? 0
			if (p !== lastProgress) {
				lastProgress = p
				ctx.progress(`downloading (${p} bytes)`, { gameId, bytes: p })
			}
		}

		await sleep(POLL_MS, ctx.signal)
	}

	return {
		defer: {
			reason: "daemon is shutting down mid-download",
			untilMs: Date.now() + 5_000
		}
	}
}

export default runReplayDownload
