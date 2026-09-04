/**
 * The frame journal: what the coach actually saw, written while the player screen-shares.
 *
 * This replaces replay capture, which never completed once in the app's entire history — 0 done
 * jobs and not a single screenshot on disk. It cannot inherit that feature's central bug, a camera
 * that would not follow the player, because these frames ARE the player's own screen.
 *
 * ## The session is the key, and the gameId arrives later
 *
 * A frame exists before the gameId does. The id the rest of the app keys on comes from match
 * history AFTER the game ends, and the live client is unreachable in exactly the WSL failure mode
 * this app already lives with. So writing is keyed by session and never blocks on knowing the
 * game; correlation is a separate, observable step (`claim`) that is allowed to say "I don't know"
 * rather than guess. Attaching one game's frames to another game's coaching would be fabrication
 * with pictures.
 *
 * ## The clock is stamped here, not in the browser
 *
 * `tSec` comes from a live-client read at the moment the frame arrives. The renderer never sends a
 * game time: mixing its `Date.now()` with the daemon's crosses a clock boundary this repo already
 * documents as unreliable, and a frame filed at the wrong second is worse than no frame — it would
 * put a picture next to a coaching point it does not belong to.
 *
 * A frame that cannot be placed on the game clock is REJECTED, not stored. An unplaceable
 * screenshot of someone's whole desktop is pure liability with no coaching value.
 *
 * NODE ONLY — owns files and the database.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { DATA_DIR } from "../shared/constants.ts"
import { isCoachable } from "../shared/coachable.ts"
import { lcu } from "./lcu.ts"
import { makeLogger } from "./log.ts"
import {
	closeJournalSession,
	countJournalFrames,
	insertJournalFrame,
	insertJournalSession,
	openJournalSessionFor,
	touchJournalSession
} from "../db/queries.ts"

const log = makeLogger("journal")

export const JOURNAL_DIR = `${DATA_DIR}/journal`

/**
 * How far the game clock may jump BACKWARDS before this is considered a different game.
 *
 * The live client's clock resetting is the earliest and most reliable "new game" signal, and it
 * arrives free with the read already being made — earlier than the gameflow phase, which lags, and
 * available even when the LCU bridge is down.
 */
const NEW_GAME_BACKWARD_SEC = 30

/** An interpolated stamp older than this is not worth trusting; the frame is dropped instead. */
const MAX_INTERPOLATION_SEC = 20

export type ClockSource = "live" | "interpolated"

export interface FrameResult {
	ok: boolean
	sessionId?: string
	tSec?: number
	clock?: ClockSource
	/** Set when the frame was refused, so the UI can say which of the honest reasons applied. */
	code?: "no-clock" | "not-coachable" | "bad-frame" | "error"
	reason?: string
}

/**
 * The last game-clock reading, used only to survive a failed read.
 *
 * Deliberately expires: without a ceiling this memo would keep stamping frames long after the game
 * ended, and the journal would quietly record the desktop. That exact failure — files being
 * written that show nothing — is what let replay capture look alive for its whole life.
 */
let anchor: { atMs: number; gameTimeSec: number; sessionId: string } | null = null

const newSessionId = (startedMs: number): string =>
	`js-${startedMs.toString(36)}-${randomBytes(2).toString("hex")}`

/** Read the game clock and the player's identity in one call. Null when there is no live game. */
const readLive = async (): Promise<{
	gameTimeSec: number
	championName: string | null
	riotId: string | null
	gameMode: string | null
} | null> => {
	const handle = await lcu()
	if (!handle) return null
	const data = await handle.live.allGameData().catch(() => null)
	const t = data?.gameData?.gameTime
	if (typeof t !== "number") return null
	const riotId = data?.activePlayer?.riotId ?? data?.activePlayer?.summonerName ?? null
	const me = riotId ? (data?.allPlayers ?? []).find(p => (p.riotId ?? p.summonerName) === riotId) : null
	return {
		gameTimeSec: t,
		championName: me?.championName ?? null,
		riotId,
		gameMode: data?.gameData?.gameMode ?? null
	}
}

/** The LCU's own id for the game in progress — the fast path for a claim. */
const currentGameId = async (): Promise<number | null> => {
	const handle = await lcu()
	if (!handle) return null
	const s = await handle.client.gameflowSession().catch(() => null)
	const id = s?.gameData?.gameId
	return typeof id === "number" && id > 0 ? id : null
}

/**
 * Store one frame.
 *
 * Never throws: this runs on every tick of a live game and must not be able to interrupt one.
 */
export const writeFrame = async (input: {
	jpeg: Buffer
	/** The ground-truth block the coach was holding, when there was one. */
	truth?: string | null
}): Promise<FrameResult> => {
	try {
		if (input.jpeg.length === 0) return { ok: false, code: "bad-frame", reason: "empty frame" }

		const live = await readLive()
		const now = Date.now()

		let gameTimeSec: number
		let clock: ClockSource
		if (live) {
			gameTimeSec = live.gameTimeSec
			clock = "live"
		} else if (anchor && now - anchor.atMs <= MAX_INTERPOLATION_SEC * 1000) {
			// One dropped read is normal; a game that has ended is not. The ceiling tells them apart.
			gameTimeSec = anchor.gameTimeSec + (now - anchor.atMs) / 1000
			clock = "interpolated"
		} else {
			anchor = null
			return {
				ok: false,
				code: "no-clock",
				reason: "no live game — a frame that cannot be placed on the game clock is not evidence"
			}
		}

		/*
		 * Practice tool and customs are never reviewed, so journalling them would spend disk on
		 * screenshots that can never be used. The same rule the harvester already applies.
		 */
		if (live?.gameMode && !isCoachable({ gameMode: live.gameMode }))
			return { ok: false, code: "not-coachable", reason: `${live.gameMode} is never reviewed` }

		const session = await sessionFor(gameTimeSec, now, live)
		anchor = { atMs: now, gameTimeSec, sessionId: session }

		const dir = `${JOURNAL_DIR}/${session}`
		mkdirSync(dir, { recursive: true })
		const id = `${session}-${Math.round(gameTimeSec * 10)}`
		const path = `${dir}/${id}.jpg`
		writeFileSync(path, input.jpeg)

		insertJournalFrame({
			id,
			sessionId: session,
			tSec: gameTimeSec,
			path,
			atMs: now,
			clock,
			truthJson: input.truth ?? null,
			bytes: input.jpeg.length
		})
		touchJournalSession(session)

		return { ok: true, sessionId: session, tSec: gameTimeSec, clock }
	} catch (err) {
		log.warn(`frame write failed: ${err instanceof Error ? err.message : String(err)}`)
		return { ok: false, code: "error", reason: "could not store the frame" }
	}
}

/**
 * The session this frame belongs to, opening or rolling one as needed.
 *
 * Rolling on a backwards clock jump is what makes "two games in a row without stopping the share"
 * correct with no user action: the browser holds no state about which game it is in and simply
 * posts frames.
 */
const sessionFor = async (
	gameTimeSec: number,
	nowMs: number,
	live: Awaited<ReturnType<typeof readLive>>
): Promise<string> => {
	const open = openJournalSessionFor()

	if (open) {
		const wentBackwards = anchor && gameTimeSec < anchor.gameTimeSec - NEW_GAME_BACKWARD_SEC
		const identityChanged =
			live?.championName && open.championName && live.championName !== open.championName
		if (!wentBackwards && !identityChanged) return open.id
		closeJournalSession(open.id, nowMs)
		log.info(`session ${open.id} closed — ${wentBackwards ? "clock reset" : "champion changed"}`)
	}

	const id = newSessionId(nowMs)
	insertJournalSession({
		id,
		startedMs: nowMs,
		gameId: await currentGameId(),
		championName: live?.championName ?? null,
		riotId: live?.riotId ?? null,
		// When the game clock read zero. The matcher's anchor when the LCU could not tell us.
		estimatedStartMs: Math.round(nowMs - gameTimeSec * 1000),
		createdMs: nowMs
	})
	log.info(`session ${id} opened at ${Math.round(gameTimeSec)}s`)
	return id
}

/** Frames stored for the currently open session — the number that makes "it is working" checkable. */
export const openSessionStatus = (): {
	sessionId: string | null
	frames: number
	gameId: number | null
	claim: string | null
} => {
	const open = openJournalSessionFor()
	if (!open) return { sessionId: null, frames: 0, gameId: null, claim: null }
	return {
		sessionId: open.id,
		frames: countJournalFrames(open.id),
		gameId: open.gameId,
		claim: open.claim
	}
}
