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

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { DATA_DIR } from "../shared/constants.ts"
import type { LiveAllGameData } from "../shared/schema/live.ts"
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
 * Resolve a STORED frame path against the journal this install actually has.
 *
 * `journal_frame.path` holds an ABSOLUTE path, unlike `media.path` and the blob columns, which
 * hold a DATA_DIR-relative one and survive a move for free. That asymmetry went unnoticed until
 * the app was renamed: 503 of 2591 stored frames still point at `/home/ssalb/coachskaffur/...`,
 * a directory that no longer exists. The JPEGs are all present under the new name — only the
 * pointer rotted — and `GET /api/frames/:id` answered 403 for every one of them, because a path
 * outside the data directory is exactly what the containment check is there to refuse.
 *
 * So the stored row is left alone (rewriting stored rows is not a thing this app does) and the
 * READ is made tolerant: anything from the `journal/` segment onward is rebased onto this
 * install's `JOURNAL_DIR`. The caller still runs its containment check on what comes back, so a
 * genuinely hostile stored path is refused exactly as before — this only forgives the app having
 * moved on disk, which is the one case where the absolute path is wrong and the file is fine.
 */
export const resolveJournalPath = (stored: string): string => {
	if (existsSync(stored)) return stored
	const cut = stored.lastIndexOf("/journal/")
	if (cut === -1) return stored
	const rebased = `${JOURNAL_DIR}${stored.slice(cut + "/journal".length)}`
	return existsSync(rebased) ? rebased : stored
}

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
	/**
	 * The whole poll, carried out so that a caller who needs more of it than the four fields above
	 * does not have to make a SECOND one inside the same beat.
	 *
	 * The one caller is the minimap watcher, and what it needs is the fence's five facts — who is
	 * dead, how many are alive — AT THE SHUTTER. Those change inside a five-second beat, so fencing
	 * a frame against the coaching turn's cached poll would be a looser fence than the POST path's,
	 * and the fence is the one thing about this read that is not allowed to move.
	 */
	raw: LiveAllGameData
} | null> => {
	const handle = await lcu()
	if (!handle) return null
	const data = await handle.live.allGameData().catch(() => null)
	if (!data) return null
	const t = data.gameData?.gameTime
	if (typeof t !== "number") return null
	const riotId = data?.activePlayer?.riotId ?? data?.activePlayer?.summonerName ?? null
	const me = riotId ? (data?.allPlayers ?? []).find(p => (p.riotId ?? p.summonerName) === riotId) : null
	return {
		gameTimeSec: t,
		championName: me?.championName ?? null,
		riotId,
		gameMode: data?.gameData?.gameMode ?? null,
		raw: data
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
	/**
	 * A frame that LANDED, handed on to whoever wants to look at it.
	 *
	 * The minimap watcher is the caller, and this seam exists so that the watcher never has to make
	 * a poll of its own. Everything it needs — the file, the game clock the journal stamped it with,
	 * and the raw `allgamedata` those came from — is already in hand here, and a second LCU read per
	 * five-second beat is traffic this repo explicitly refuses to add.
	 *
	 * CALLED SYNCHRONOUSLY AND EXPECTED TO RETURN THAT WAY. Its exceptions are swallowed and its
	 * return value ignored: nothing downstream of a stored frame may cost the journal a write, and a
	 * nice-to-have throwing inside a live game must not reach the caller as a failed upload.
	 *
	 * Only fired when the clock came from a LIVE read. An interpolated stamp means the poll failed,
	 * which means there is no truth to fence a reading against — and an unfenced read is exactly
	 * what this app refuses to hold.
	 */
	onStored?: (stored: {
		framePath: string
		tSec: number
		sessionId: string
		raw: LiveAllGameData
	}) => void
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

		if (live && input.onStored) {
			try {
				input.onStored({ framePath: path, tSec: gameTimeSec, sessionId: session, raw: live.raw })
			} catch (err) {
				// The frame is already on disk and in the table. Whatever this was, it is not worth
				// telling the browser its upload failed.
				log.warn(`onStored failed: ${err instanceof Error ? err.message : String(err)}`)
			}
		}

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

/**
 * Close whatever session is open, and say why.
 *
 * ## The bug this exists to end
 *
 * Until 2026-09-18 a session was closed in exactly one place: `sessionFor`, when the NEXT frame
 * arrived and its clock had run backwards. So a session that stopped receiving frames — he closed
 * the app, he stopped sharing, the game ended — was never closed at all. Measured on this machine
 * the same day: `js-mtvxb5f4-f81a` had `endedMs` null since 2026-09-10, eight days and five games
 * later, and `openJournalSessionFor()` was still returning it as the session in progress.
 *
 * Two things were reading that answer and both were wrong because of it.
 *
 *   1. `supervisor.ts` keys every live sample on `openSessionStatus().sessionId`, so every game
 *      recorded in those eight days was filed under a session id belonging to a game from the 10th.
 *   2. Worse, and the reason this is a recording defect rather than a labelling one: `anchor` is
 *      module state, so it is null after any daemon restart, so `wentBackwards` CANNOT fire on the
 *      first frame of the next game. `identityChanged` only fires when the champion differs, and he
 *      plays Lillia. The first frames of a brand new game therefore joined the eight-day-old
 *      session and inherited its `gameId` — which is a picture attached to a different game, the
 *      one thing `journal.ts`'s own header says this module exists to prevent.
 *
 * So the lifetime of a session now has a real end: the supervisor calls this when the client leaves
 * `InProgress`, and `main.ts` calls it at startup for anything left open by a previous process.
 */
export const endOpenSession = (reason: string, nowMs: number = Date.now()): string | null => {
	const open = openJournalSessionFor()
	if (!open) return null
	closeJournalSession(open.id, nowMs)
	/*
	 * The in-process anchor goes with it. It holds `sessionId`, and a stale anchor pointing at a
	 * closed session is how the next frame gets interpolated onto the previous game's clock.
	 */
	anchor = null
	log.info(`session ${open.id} closed — ${reason}`, {
		frames: countJournalFrames(open.id),
		gameId: open.gameId
	})
	return open.id
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
