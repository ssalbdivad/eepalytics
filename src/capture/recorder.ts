/**
 * Recording: `POST /replay/recording`, wait for the render, pull the bytes back across the
 * WSL boundary, and hand up a `Media` row.
 *
 * Two things about this API surprise people, both [VERIFIED-BINARY] in
 * `.research/replay-capture.md` §6.4:
 *  1. There is **no jpg codec**. Only `webm`, `png`, `pngAndDepth`.
 *  2. `codec: "png"` writes a **folder of frames**, one file per frame — so a "screenshot"
 *     is a one-frame render into a directory, and we then pick the single PNG out of it.
 *
 * The game is a Windows process, so it must be given a Windows path it can write to, and we
 * read the result back through /mnt/c. Captures are staged under a directory this app owns
 * (never the user's Highlights folder, which does not even exist on this machine) and are
 * deleted after being copied into DATA_DIR/media.
 */

import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises"
import { MEDIA_DIR } from "../shared/constants.ts"
import type { Media, MediaKind } from "../shared/schema/domain.ts"
import { sleep, throwIfAborted } from "./launcher.ts"
import type { ReplaySession } from "./launcher.ts"
import { okJson } from "./transport.ts"
import { CaptureError, type ReplayCodec, type ReplayRecording } from "./types.ts"

/* ================================================================= paths */

/** Staging area on the Windows side. The game writes here; we read and then delete. */
export const STAGE_WIN = "C:\\Users\\ssalb\\coachskaffur-captures"
export const STAGE_WSL = "/mnt/c/Users/ssalb/coachskaffur-captures"

/**
 * `/mnt/c/Users/x` -> `C:\Users\x`. Pure, so it is testable; exact for the `/mnt/<drive>/`
 * shape, which is the only shape this app ever produces. Returns null for anything else
 * (a WSL-native path like /home/... is NOT reachable by the game and must not be silently
 * mangled into one that looks reachable).
 */
export const toWindowsPath = (wslPath: string): string | null => {
	const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(wslPath)
	if (!m) return null
	const drive = (m[1] as string).toUpperCase()
	const rest = (m[2] ?? "").replace(/\//g, "\\")
	return `${drive}:${rest === "" ? "\\" : rest}`
}

/** `C:\Users\x` or `C:/Users/x` -> `/mnt/c/Users/x`. Pure. Null if not a drive-letter path. */
export const toWslPath = (winPath: string): string | null => {
	const m = /^([a-zA-Z]):[\\/](.*)$/.exec(winPath)
	if (!m) return null
	const drive = (m[1] as string).toLowerCase()
	const rest = (m[2] as string).replace(/\\/g, "/")
	return `/mnt/${drive}/${rest}`
}

/** Windows and WSL views of the same per-capture staging directory. */
export const stagePaths = (
	gameId: number,
	slug: string
): { win: string; wsl: string } => ({
	win: `${STAGE_WIN}\\g${gameId}\\${slug}`,
	wsl: `${STAGE_WSL}/g${gameId}/${slug}`
})

/** Filesystem-safe slug for a moment id or a bare timestamp. */
export const captureSlug = (momentId: string | null, tSec: number): string =>
	(momentId ?? `t${Math.round(tSec)}`).replace(/[^a-zA-Z0-9_-]/g, "_")

/** Deterministic media id: one screenshot and one clip per moment, re-derivable. */
export const makeMediaId = (
	gameId: number,
	momentId: string | null,
	kind: MediaKind,
	tSec: number
): string => `${momentId ?? `g${gameId}-t${Math.round(tSec)}`}-${kind}`

/* ================================================================ timing */

/**
 * `png` renders one file per frame. `startTime === endTime` may yield zero frames — Riot does
 * not say — so we ask for a hair more than one frame at the target fps and take the first
 * file. UNVERIFIED; tune once at runtime.
 */
export const SCREENSHOT_WINDOW_SEC = 0.05
export const DEFAULT_FPS = 30
export const DEFAULT_WIDTH = 1920
export const DEFAULT_HEIGHT = 1080
/** A screenshot is one frame; a clip renders in roughly real time with enforceFrameRate. */
export const SCREENSHOT_TIMEOUT_MS = 60_000
export const CLIP_TIMEOUT_MS_PER_SEC = 6_000
export const CLIP_TIMEOUT_FLOOR_MS = 90_000

/** Centre a clip on the moment, clamped to the replay's own bounds. */
export const clipWindow = (
	tSec: number,
	clipSeconds: number,
	lengthSec: number | null = null
): { startSec: number; endSec: number } => {
	const half = Math.max(1, clipSeconds) / 2
	let start = Math.max(0, tSec - half)
	let end = start + Math.max(1, clipSeconds)
	if (lengthSec !== null && lengthSec > 0 && end > lengthSec) {
		end = lengthSec
		start = Math.max(0, end - Math.max(1, clipSeconds))
	}
	return { startSec: start, endSec: end }
}

/* ================================================================== PNG */

/** Read width/height straight out of a PNG's IHDR. Real bytes, not the requested size. */
export const pngSize = (buf: Uint8Array): { width: number; height: number } | null => {
	const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
	if (buf.length < 24) return null
	for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return null
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
	return { width: view.getUint32(16), height: view.getUint32(20) }
}

/* ============================================================= recording */

export interface RecordOptions {
	session: ReplaySession
	/** Game clock the media depicts. */
	tSec: number
	momentId: string | null
	width?: number
	height?: number
	fps?: number
	signal?: AbortSignal
	/** Overwrite an existing media file rather than reusing it. */
	force?: boolean
}

export interface ClipOptions extends RecordOptions {
	clipSeconds: number
	/** `Playback.length`, when known, so the window can be clamped to the replay. */
	replayLengthSec?: number | null
}

const recordingStatus = async (
	session: ReplaySession
): Promise<ReplayRecording | null> => {
	try {
		return okJson<ReplayRecording>(
			await session.clients.game.request("GET", "/replay/recording")
		)
	} catch {
		return null
	}
}

/**
 * POST a recording request and poll until it is finished.
 * "Poll this resource for progress on the output" — Riot's own instruction.
 */
const runRecording = async (
	session: ReplaySession,
	body: ReplayRecording & { codec: ReplayCodec; path: string },
	timeoutMs: number,
	signal?: AbortSignal
): Promise<ReplayRecording | null> => {
	const reply = await session.clients.game.request("POST", "/replay/recording", body)
	if (reply.status >= 400)
		throw new CaptureError(
			"record-rejected",
			`the game refused the recording (HTTP ${reply.status})`,
			reply.body.slice(0, 300)
		)

	const deadline = Date.now() + timeoutMs
	let sawRecording = false
	let last: ReplayRecording | null = null
	for (;;) {
		throwIfAborted(signal)
		await sleep(400, signal)
		const s = await recordingStatus(session)
		if (s) {
			last = s
			if (s.recording === true) sawRecording = true
			else if (sawRecording || (typeof s.currentTime === "number" && s.currentTime > 0))
				return s
		}
		if (Date.now() >= deadline)
			throw new CaptureError(
				"record-timeout",
				`recording did not finish within ${Math.round(timeoutMs / 1000)}s`,
				JSON.stringify(last ?? {})
			)
		// Very fast single-frame renders can complete between two polls without us ever
		// observing recording:true; the caller checks for output files and will not spin.
		if (!sawRecording && Date.now() - (deadline - timeoutMs) > 4_000) return s ?? last
	}
}

/** Wait until a file exists and its size stops changing (i.e. the encoder let go of it). */
const waitForStableFile = async (
	path: string,
	timeoutMs: number,
	signal?: AbortSignal
): Promise<number | null> => {
	const deadline = Date.now() + timeoutMs
	let lastSize = -1
	for (;;) {
		throwIfAborted(signal)
		const size = await stat(path)
			.then(s => (s.isFile() ? s.size : -1))
			.catch(() => -1)
		if (size > 0 && size === lastSize) return size
		lastSize = size
		if (Date.now() >= deadline) return null
		await sleep(500, signal)
	}
}

const firstPngIn = async (dir: string): Promise<string | null> => {
	const names = await readdir(dir).catch(() => [] as string[])
	const pngs = names.filter(n => n.toLowerCase().endsWith(".png")).sort()
	const first = pngs[0]
	return first === undefined ? null : `${dir}/${first}`
}

/* ================================================================ public */

/**
 * One frame, as a PNG, at `tSec`.
 *
 * The caller is responsible for having already seeked and aimed the camera — `pipeline.ts`
 * does seek -> settle -> aim -> capture in that order, because the camera must be pointing
 * somewhere before the frame is rendered.
 */
export const screenshot = async (opts: RecordOptions): Promise<Media> => {
	const { session, tSec, momentId, signal } = opts
	const slug = captureSlug(momentId, tSec)
	const stage = stagePaths(session.gameId, `${slug}-png`)
	await mkdir(stage.wsl, { recursive: true })

	await runRecording(
		session,
		{
			codec: "png",
			path: stage.win,
			startTime: tSec,
			endTime: tSec + SCREENSHOT_WINDOW_SEC,
			framesPerSecond: opts.fps ?? DEFAULT_FPS,
			replaySpeed: 1.0,
			enforceFrameRate: true,
			lossless: true,
			width: opts.width ?? DEFAULT_WIDTH,
			height: opts.height ?? DEFAULT_HEIGHT
		},
		SCREENSHOT_TIMEOUT_MS,
		signal
	)

	// The folder may appear a beat after the render reports done.
	let src: string | null = null
	const deadline = Date.now() + 15_000
	for (;;) {
		src = await firstPngIn(stage.wsl)
		if (src) break
		if (Date.now() >= deadline) break
		await sleep(500, signal)
	}
	if (!src)
		throw new CaptureError(
			"no-output",
			`the render produced no PNG in ${stage.wsl}`,
			stage.win
		)
	await waitForStableFile(src, 10_000, signal)

	const id = makeMediaId(session.gameId, momentId, "screenshot", tSec)
	const rel = `media/${session.gameId}/${id}.png`
	const dest = `${MEDIA_DIR}/${session.gameId}/${id}.png`
	await mkdir(`${MEDIA_DIR}/${session.gameId}`, { recursive: true })
	await copyFile(src, dest)
	await rm(stage.wsl, { recursive: true, force: true }).catch(() => {})

	const bytes = await stat(dest).then(s => s.size)
	const head = await readFile(dest).then(b => new Uint8Array(b.subarray(0, 32)))
	const size = pngSize(head)

	return {
		id,
		gameId: session.gameId,
		momentId,
		kind: "screenshot",
		path: rel,
		// Real dimensions read out of the file's IHDR, never the requested ones.
		width: size?.width ?? 0,
		height: size?.height ?? 0,
		tSec,
		createdMs: Date.now(),
		source: "replay",
		durationSec: null,
		bytes,
		mimeType: "image/png"
	}
}

/** A VP8 `.webm` clip centred on `tSec`. */
export const clip = async (opts: ClipOptions): Promise<Media> => {
	const { session, tSec, momentId, signal } = opts
	const { startSec, endSec } = clipWindow(
		tSec,
		opts.clipSeconds,
		opts.replayLengthSec ?? null
	)
	const durationSec = endSec - startSec
	const slug = captureSlug(momentId, tSec)
	const stage = stagePaths(session.gameId, "clips")
	await mkdir(stage.wsl, { recursive: true })
	const winFile = `${stage.win}\\${slug}.webm`
	const wslFile = `${stage.wsl}/${slug}.webm`

	const status = await runRecording(
		session,
		{
			codec: "webm",
			path: winFile,
			startTime: startSec,
			endTime: endSec,
			framesPerSecond: opts.fps ?? DEFAULT_FPS,
			replaySpeed: 1.0,
			enforceFrameRate: true,
			lossless: false,
			width: opts.width ?? DEFAULT_WIDTH,
			height: opts.height ?? DEFAULT_HEIGHT
		},
		Math.max(CLIP_TIMEOUT_FLOOR_MS, durationSec * CLIP_TIMEOUT_MS_PER_SEC),
		signal
	)

	const bytesStaged = await waitForStableFile(wslFile, 30_000, signal)
	if (bytesStaged === null)
		throw new CaptureError("no-output", `the render produced no webm at ${wslFile}`, winFile)

	const id = makeMediaId(session.gameId, momentId, "clip", tSec)
	const rel = `media/${session.gameId}/${id}.webm`
	const dest = `${MEDIA_DIR}/${session.gameId}/${id}.webm`
	await mkdir(`${MEDIA_DIR}/${session.gameId}`, { recursive: true })
	await copyFile(wslFile, dest)
	await rm(wslFile, { force: true }).catch(() => {})

	const bytes = await stat(dest).then(s => s.size)

	return {
		id,
		gameId: session.gameId,
		momentId,
		kind: "clip",
		path: rel,
		// The recording status reports the dimensions actually used; the POST's width/height
		// are documented as "same as the game window size" and may be advisory only.
		width: status?.width ?? opts.width ?? DEFAULT_WIDTH,
		height: status?.height ?? opts.height ?? DEFAULT_HEIGHT,
		tSec,
		createdMs: Date.now(),
		source: "replay",
		durationSec,
		bytes,
		mimeType: "video/webm"
	}
}

/** Remove everything this app staged on the Windows side for one game. */
export const cleanStage = async (gameId: number): Promise<void> => {
	await rm(`${STAGE_WSL}/g${gameId}`, { recursive: true, force: true }).catch(() => {})
}
