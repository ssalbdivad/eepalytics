/**
 * The capture pipeline: one replay launch, N moments.
 *
 * Launching the client costs 15-30 s and takes over the user's screen, so it happens exactly
 * once per game and every moment is captured inside that one session, in ascending time order
 * (§6.3: a forward scrub is far cheaper than a rewind). We never relaunch per moment.
 *
 * The abort signal is checked between every moment and inside every wait, because the user
 * starting a queue is more important than any screenshot we were about to take.
 */

import type { Media } from "../shared/schema/domain.ts"
import type { Moment } from "../shared/schema/domain.ts"
import {
	DEFAULT_CAMERA_CALIBRATION,
	frameMoment,
	type CameraCalibration
} from "./camera.ts"
import {
	sleep,
	throwIfAborted,
	withReplaySession,
	type LaunchPhase,
	type ReplaySession
} from "./launcher.ts"
import { cleanStage, clip, screenshot } from "./recorder.ts"
import { curlClients } from "./transport.ts"
import {
	CaptureError,
	type CaptureClients,
	type CaptureFailureReason,
	type LaunchFailureReason,
	type ReplayObject
} from "./types.ts"

/** Let the engine finish drawing after a seek before we render a frame. */
export const SETTLE_MS = 900

/* ============================================================= selection */

/**
 * Which moments to spend capture budget on.
 *
 * Severity picks *what*; time orders *how*. Taking the N most severe and then sorting them
 * back into chronological order gives the cheapest seek sequence and a review that reads
 * front-to-back like the game did.
 */
export const selectCaptureMoments = (moments: Moment[], max: number): Moment[] => {
	if (max <= 0) return []
	return [...moments]
		.sort((a, b) => b.severity - a.severity || a.tSec - b.tSec)
		.slice(0, max)
		.sort((a, b) => a.tSec - b.tSec)
}

/**
 * Match a champion to the `characterName` the running replay actually uses, so we can aim
 * with `selectionName` instead of raw coordinates. Case-insensitive per Riot's own doc-string.
 */
export const matchSelectionName = (
	objects: ReplayObject[],
	championName: string | null | undefined
): string | null => {
	if (!championName) return null
	const want = championName.toLowerCase().replace(/[^a-z0-9]/g, "")
	for (const o of objects) {
		const name = o.characterName
		if (!name) continue
		if (name.toLowerCase().replace(/[^a-z0-9]/g, "") === want) return name
	}
	return null
}

/* ================================================================ result */

export interface MomentCaptureFailure {
	momentId: string
	tSec: number
	reason: CaptureFailureReason | LaunchFailureReason | "error"
	message: string
}

export interface CaptureOutcome {
	gameId: number
	/** Media rows produced. NOT yet inserted — the job handler owns the DB write. */
	media: Media[]
	attempted: number
	captured: number
	failures: MomentCaptureFailure[]
	/** Set when the session never came up at all. */
	launchFailure: LaunchFailureReason | null
	/** One sentence the UI can show verbatim. Always populated. */
	note: string
	/** Measured launch cost, for the record. Null when we never launched. */
	launchMs: number | null
	aborted: boolean
}

export interface CaptureProgress {
	gameId: number
	phase: LaunchPhase | "capturing"
	note: string
	done: number
	total: number
}

export interface CaptureMomentsOptions {
	clients?: CaptureClients
	signal?: AbortSignal
	/** Hard cap; comes from `settings.captureMaxPerGame`. */
	maxMoments: number
	/** 0 disables clips entirely; comes from `settings.clipSeconds`. */
	clipSeconds: number
	cal?: CameraCalibration
	/** Champion to lock the camera onto for a given moment, when we know one. */
	championFor?: (moment: Moment) => string | null
	onProgress?: (p: CaptureProgress) => void
	platformId?: string
	width?: number
	height?: number
	fps?: number
	/** Preflight already run by the daemon gate. */
	skipPreflight?: boolean
}

/**
 * Capture every selected moment from one game.
 *
 * NEVER THROWS for a per-moment failure — a missing screenshot degrades the review, it does
 * not break it, and `media-generate` has already produced an SVG map image for every moment.
 * It DOES throw `CaptureError` when the session could not be established at all, so the
 * caller can distinguish "capture is not possible right now" from "capture went badly".
 */
export const captureMoments = async (
	gameId: number,
	moments: Moment[],
	opts: CaptureMomentsOptions
): Promise<CaptureOutcome> => {
	const clients = opts.clients ?? curlClients()
	const cal = opts.cal ?? DEFAULT_CAMERA_CALIBRATION
	const picked = selectCaptureMoments(moments, opts.maxMoments)
	const media: Media[] = []
	const failures: MomentCaptureFailure[] = []
	let launchMs: number | null = null
	let aborted = false

	if (picked.length === 0)
		return {
			gameId,
			media,
			attempted: 0,
			captured: 0,
			failures,
			launchFailure: null,
			note: "no moments were worth capturing",
			launchMs: null,
			aborted: false
		}

	const report = (phase: CaptureProgress["phase"], note: string, done: number) =>
		opts.onProgress?.({ gameId, phase, note, done, total: picked.length })

	try {
		await withReplaySession(
			gameId,
			{
				clients,
				signal: opts.signal,
				platformId: opts.platformId,
				skipPreflight: opts.skipPreflight,
				onPhase: (phase, note) => report(phase, note, media.length)
			},
			async session => {
				launchMs = session.launchMs
				const playback = await session.getPlayback()
				const lengthSec = typeof playback.length === "number" ? playback.length : null

				for (const moment of picked) {
					// The user starting a game outranks every screenshot in the queue.
					throwIfAborted(opts.signal)
					report(
						"capturing",
						`${moment.title} @ ${Math.round(moment.tSec)}s`,
						media.length
					)
					try {
						await captureOne(session, moment, {
							cal,
							clipSeconds: opts.clipSeconds,
							championName: opts.championFor?.(moment) ?? null,
							replayLengthSec: lengthSec,
							signal: opts.signal,
							width: opts.width,
							height: opts.height,
							fps: opts.fps,
							sink: media
						})
					} catch (e) {
						if (e instanceof CaptureError && e.reason === "aborted") throw e
						failures.push({
							momentId: moment.id,
							tSec: moment.tSec,
							reason: e instanceof CaptureError ? e.reason : "error",
							message: e instanceof Error ? e.message : String(e)
						})
					}
				}
			}
		)
	} catch (e) {
		await cleanStage(gameId).catch(() => {})
		if (e instanceof CaptureError && e.reason === "aborted") {
			aborted = true
			return {
				gameId,
				media,
				attempted: picked.length,
				captured: media.length,
				failures,
				launchFailure: null,
				note:
					media.length > 0 ?
						`stopped early — kept the ${media.length} shot(s) already taken`
					:	"stopped before anything was captured",
				launchMs,
				aborted
			}
		}
		if (e instanceof CaptureError) {
			// A launch failure is the caller's problem to explain; re-raise with context kept.
			throw e
		}
		throw e
	}

	await cleanStage(gameId).catch(() => {})

	const note =
		failures.length === 0 ?
			`captured ${media.length} item(s) across ${picked.length} moment(s)`
		:	`captured ${media.length} item(s); ${failures.length} moment(s) failed (${failures[0]?.reason})`

	return {
		gameId,
		media,
		attempted: picked.length,
		captured: media.length,
		failures,
		launchFailure: null,
		note,
		launchMs,
		aborted
	}
}

interface CaptureOneOptions {
	cal: CameraCalibration
	clipSeconds: number
	championName: string | null
	replayLengthSec: number | null
	signal?: AbortSignal
	width?: number
	height?: number
	fps?: number
	sink: Media[]
}

/** seek -> settle -> aim -> shoot. In that order, every time. */
const captureOne = async (
	session: ReplaySession,
	moment: Moment,
	o: CaptureOneOptions
): Promise<void> => {
	await session.seek(moment.tSec, o.signal)
	await sleep(SETTLE_MS, o.signal)

	// `selectionName` is the robust way to aim: it tracks the subject through a clip and
	// needs no coordinate math. Fall back to absolute camera position when we cannot resolve
	// the champion in the running replay.
	let selectionName: string | null = null
	if (o.championName) {
		const objects = await session.objects("hero", true).catch(() => [] as ReplayObject[])
		selectionName = matchSelectionName(objects, o.championName)
	}
	await session.setRender(frameMoment(moment, { cal: o.cal, selectionName }))
	await sleep(250, o.signal)

	o.sink.push(
		await screenshot({
			session,
			tSec: moment.tSec,
			momentId: moment.id,
			signal: o.signal,
			width: o.width,
			height: o.height,
			fps: o.fps
		})
	)

	if (o.clipSeconds > 0) {
		o.sink.push(
			await clip({
				session,
				tSec: moment.tSec,
				momentId: moment.id,
				clipSeconds: o.clipSeconds,
				replayLengthSec: o.replayLengthSec,
				signal: o.signal,
				width: o.width,
				height: o.height,
				fps: o.fps
			})
		)
	}
}
