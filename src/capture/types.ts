/**
 * Local contracts for the capture unit.
 *
 * The LCU transport unit (`src/lcu/`) is being built concurrently and its exported shape is
 * not settled, so capture depends on the smallest structural interface it can: "give me
 * something that can do an HTTP request against the LCU, and something that can do one
 * against the game's port 2999". `src/capture/transport.ts` ships a self-contained
 * `curl.exe` implementation of both so this unit is runnable and manually testable on its
 * own; the integration pass should hand it the bridge-backed clients instead.
 *
 * Nothing in here is browser-safe.
 */

export type HttpMethod = "GET" | "POST"

/** A raw HTTP reply. `body` is the response text, undecoded. */
export interface RawReply {
	status: number
	body: string
}

/**
 * One HTTP endpoint. `path` is absolute-from-root ("/lol-replays/v1/configuration").
 * Implementations must NOT throw on a non-2xx status — a 404 from the Replay API is a
 * state ("not in a replay"), not an error. They may throw on transport failure
 * (process spawn failed, connection refused), which callers treat as "not up yet".
 */
export interface HttpClient {
	request(method: HttpMethod, path: string, body?: unknown): Promise<RawReply>
}

/** Both endpoints the capture pipeline needs. */
export interface CaptureClients {
	/** The League *client* on the lockfile port. Needs basic auth; the impl handles it. */
	lcu: HttpClient
	/** The *game* process on 127.0.0.1:2999. No auth, self-signed cert. */
	game: HttpClient
}

/* ============================================ Replay API response shapes */

/** `GET /replay/game` */
export interface ReplayGameInfo {
	processID?: number
}

/** `GET`/`POST /replay/playback`. All fields optional on POST. */
export interface ReplayPlayback {
	paused?: boolean
	seeking?: boolean
	time?: number
	length?: number
	speed?: number
}

/** `GET`/`POST /replay/recording`. All fields optional on POST. */
export interface ReplayRecording {
	recording?: boolean
	path?: string
	codec?: ReplayCodec
	startTime?: number
	endTime?: number
	currentTime?: number
	width?: number
	height?: number
	framesPerSecond?: number
	enforceFrameRate?: boolean
	lossless?: boolean
	replaySpeed?: number
}

/**
 * `AVContainer`. Exhaustively verified from the signed binary — there is no `jpg`.
 * `png` writes a FOLDER of frames, one file per frame.
 */
export type ReplayCodec = "webm" | "png" | "pngAndDepth"

/** One object from `GET /replay/objects?types=hero&detail=true`. */
export interface ReplayObject {
	netId?: number
	characterName?: string
	nameHash?: number
	position?: { x?: number; y?: number; z?: number }
	direction?: { x?: number; y?: number; z?: number }
	alive?: boolean
	health?: number
	maxHealth?: number
	level?: number
	stealth?: boolean
}

/* =================================================== capture-side errors */

/**
 * Every way the launch path can refuse, as a closed set. The daemon and the UI both switch
 * on these, so adding a member is a breaking change.
 *
 * - `rofl-missing`    the .rofl is not on disk and the client cannot get it back
 * - `patch-mismatch`  the .rofl predates the installed patch; unfixable, never retry
 * - `launch-timeout`  the client never got the game process up
 * - `api-timeout`     the game came up but :2999 /replay/* never answered
 * - `aborted`         the user started doing something; we bailed on purpose
 * - `gated`           preconditions said no (in a game, capture disabled, already watching)
 */
export type LaunchFailureReason =
	| "rofl-missing"
	| "patch-mismatch"
	| "launch-timeout"
	| "api-timeout"
	| "aborted"
	| "gated"

/** Reasons a single moment's capture failed, once a session was already up. */
export type CaptureFailureReason =
	| "seek-timeout"
	| "record-timeout"
	| "record-rejected"
	| "no-output"
	| "read-failed"
	| "aborted"

export class CaptureError extends Error {
	readonly reason: LaunchFailureReason | CaptureFailureReason
	/** Machine-ish extra context (a status code, a metadata state, a path). */
	readonly detail: string | null

	constructor(
		reason: LaunchFailureReason | CaptureFailureReason,
		message: string,
		detail: string | null = null
	) {
		super(message)
		this.name = "CaptureError"
		this.reason = reason
		this.detail = detail
	}
}

/** True when retrying the same game later could plausibly work. */
export const isRetryable = (
	reason: LaunchFailureReason | CaptureFailureReason
): boolean => reason !== "patch-mismatch" && reason !== "rofl-missing"
