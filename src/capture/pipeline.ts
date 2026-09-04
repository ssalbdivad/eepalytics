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

/** After re-aiming. Shorter than a seek: the camera move is cheap, the scrub is not. */
export const CAMERA_SETTLE_MS = 260

/**
 * Frames grabbed around each moment, in seconds relative to it.
 *
 * Weighted BEFORE the moment because the decision that caused an outcome happens before the
 * outcome. A death at 8:12 is explained by where he was and what he had up at 8:06, not by the
 * grey screen afterwards. The trailing frame exists to show the immediate consequence.
 *
 * Five frames costs four extra seeks per moment (~1.5s each). That is the price of being able to
 * say anything about execution at all.
 */
export const DEFAULT_BURST_SEC: readonly number[] = [-6, -3, -1, 0, 2]

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
	/** The champion the user played. The camera falls back to him — this is his review. */
	userChampionName?: string | null
	onProgress?: (p: CaptureProgress) => void
	platformId?: string
	width?: number
	height?: number
	fps?: number
	/**
	 * Frames per moment, in seconds relative to it. Defaults to `DEFAULT_BURST_SEC`; pass `[0]`
	 * for a single frame when only a thumbnail is wanted.
	 */
	burstOffsetsSec?: readonly number[]
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
							burstOffsetsSec: opts.burstOffsetsSec ?? DEFAULT_BURST_SEC,
							userChampionName: opts.userChampionName ?? null,
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
	/** Seconds relative to the moment to grab frames at. `[0]` reproduces the old single shot. */
	burstOffsetsSec: readonly number[]
	/**
	 * The champion whose game this is. Used when a moment names no champion of its own, and as
	 * the fallback when the named one cannot be resolved — a review of his game should stay on
	 * him rather than drifting to whoever else was in the fight.
	 */
	userChampionName?: string | null
	sink: Media[]
}

/**
 * seek -> settle -> AIM -> settle -> shoot. In that order, for EVERY frame.
 *
 * The aim step used to run once before the burst. A seek moves the engine's camera, so frames
 * two through five pointed wherever the scrub left them — the capture visibly hopped around the
 * map instead of following the player, which makes the frames useless for reviewing what he did.
 * Re-locking after each seek costs one request per frame and is the whole point of the burst.
 */
const captureOne = async (
	session: ReplaySession,
	moment: Moment,
	o: CaptureOneOptions
): Promise<void> => {
	await session.seek(moment.tSec, o.signal)
	await sleep(SETTLE_MS, o.signal)

	/*
	 * `selectionName` is the robust way to aim: the engine tracks the champion for us, so the
	 * camera follows him as he moves and no coordinate math is involved. The fallback is
	 * absolute camera position, whose calibration is still unverified — so resolving a name
	 * matters, and resolving the RIGHT name matters more.
	 *
	 * `championFor` gives the champion a moment is *about*, which for a death or a fight can be
	 * someone else. Falling back to the user's own champion is deliberate: this is a review of
	 * HIS game, and a frame centred on the enemy who killed him answers a question nobody asked.
	 */
	let selectionName: string | null = null
	const target = o.championName ?? o.userChampionName
	if (target) {
		const objects = await session.objects("hero", true).catch(() => [] as ReplayObject[])
		selectionName =
			matchSelectionName(objects, target) ??
			(o.userChampionName ? matchSelectionName(objects, o.userChampionName) : null)
	}

	/** Re-applied after every seek, because a seek moves the camera. */
	const aim = async (): Promise<void> => {
		await session.setRender(frameMoment(moment, { cal: o.cal, selectionName }))
		await sleep(CAMERA_SETTLE_MS, o.signal)
	}

	await aim()

	/*
	 * A BURST, not a single frame.
	 *
	 * One screenshot shows where everyone stood; it cannot show what happened. Whether an
	 * ability was used well, whether a camp was kited or tanked, whether a fight was entered
	 * from the right angle — all of that is a sequence, and no data stream this app reads
	 * contains it. The timeline has positions and kills; ability casts are only in the replay
	 * chunk payloads, which need the game engine to decode. Frames either side of the moment
	 * are the ONLY evidence of execution available, which is what makes the extra seeks worth
	 * their cost.
	 *
	 * Offsets are seconds relative to the moment. Weighted before it, because the decision that
	 * produced the outcome happened before the outcome did.
	 */
	for (const offset of o.burstOffsetsSec) {
		const at = moment.tSec + offset
		if (at < 0 || (o.replayLengthSec !== null && at > o.replayLengthSec)) continue
		if (offset !== 0) {
			await session.seek(at, o.signal)
			await sleep(SETTLE_MS, o.signal)
			// The seek moved the camera. Put it back on him before the shutter.
			await aim()
		}
		o.sink.push(
			await screenshot({
				session,
				tSec: at,
				momentId: moment.id,
				signal: o.signal,
				width: o.width,
				height: o.height,
				fps: o.fps
			})
		)
	}
	// No seek back to the moment. A rewind costs a full keyframe re-scrub (§6.3), the burst
	// already ends after the moment, and the next moment is later still — so every seek in a
	// capture run moves forward. Clips re-seek themselves anyway.

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
