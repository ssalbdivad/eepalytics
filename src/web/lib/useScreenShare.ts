/**
 * One shared screen, and a way to take a still of it.
 *
 * This was extracted from `screenCoach.ts` when the periodic-glance coach was deleted. The glance
 * loop and the screen share had grown together in one hook, and the live coach needs the second
 * without the first — deleting the file wholesale would have taken the app's only screen capture
 * with it.
 *
 * ## Frame size is a correctness setting, not a performance one
 *
 * 1536px wide, measured. At 1024 a model asked whether the player was alive answered "alive,
 * shopping back at base" about a frame with a "BACK IN 7" respawn timer across the middle of it;
 * at 1536 the same model got it right. Ally and enemy portraits are ~25px at 1024 and ~38px at
 * 1536, which is the difference between "unsure" and a name. The extra pixels cost a couple of
 * hundred milliseconds and no accuracy is worth that trade in the other direction.
 *
 * ## The stream is meant to outlive the game — and it is only as durable as its mount point
 *
 * He shares his whole MONITOR, not the League window, so one share covers a whole session and
 * there is no honest reason to make him pick a screen again between two games. Nothing in this
 * hook ends a share on its own: it ends when he presses stop, when he ends it from the OS chrome
 * (the `ended` listener below), or when the component unmounts.
 *
 * That last one is the fragile one, and it is not fixable from in here — a `MediaStream` held in
 * a ref dies with its component, so persistence is a property of WHERE `<ScreenCoach>` is
 * mounted. Two places have already had to be fixed for it and both are commented on site:
 * `pages/Live.tsx` renders the coach at a fixed position in one tree rather than in three
 * structurally different returns, and `App.tsx` keeps `<Live>` mounted on every route rather than
 * only on `home`. Before adding a third conditional above this component, check that it cannot
 * unmount, because the symptom is not a crash — it is the OS screen picker reappearing at the
 * start of the next game.
 *
 * The unmount teardown stays regardless. Leaking a live capture of someone's monitor because a
 * component went away is the worse failure of the two.
 *
 * ## A share that dies quietly is the failure this file now reports
 *
 * The stream persisting for a whole session is the feature, and it is also the risk: the longer a
 * capture is meant to live, the more ways it has to stop without anyone pressing anything. A
 * display sleeps, a driver resets, the browser reclaims the capture, the shared surface is
 * minimised. Two symptoms follow, and until they were counted BOTH of them looked from the outside
 * like a coach with less to say:
 *
 *   - **no picture** — `grabFrame` returns null, the turn goes out with the block and no image, and
 *     she coaches fluently from the numbers alone. That is what the player saw and reported.
 *   - **the same picture, forever** — worse, because a stalled `<video>` keeps its last decoded
 *     frame and `videoWidth` stays non-zero. Every grab succeeds and every one of them is a
 *     photograph of the moment the share died. Nothing downstream can tell that from a working
 *     capture, so it has to be caught here.
 *
 * `health` counts both, consecutively, and `lib/liveFaults.ts` decides when a run of them is worth
 * saying out loud. Counting is deliberately done in the grab rather than on a timer of its own:
 * the only thing that proves a capture is alive is asking it for a picture, which the journal and
 * the coach already do every few seconds.
 */

import { minimapRect } from "../../review/frame-read.ts"
import { useCallback, useEffect, useRef, useState } from "react"

/** See the header — this is the measured floor for reading a League HUD, not a tuned optimum. */
const FRAME_WIDTH = 1536

/**
 * The crop is sent at 1152px, four times the 288px the minimap occupies in a 1536px frame.
 *
 * Upscaling the same pixels measurably helps — the model reads a bigger picture of them better —
 * and costs nothing, because the tile budget is already padded. Asking it to POINT at a spot rather
 * than name a zone was worth more still: 39% to 83% on his own zone, same crop, same model.
 */
const MINIMAP_READ_PX = 1152
/** JPEG artefacts eat small HUD text and portraits first, which is exactly what must survive. */
const FRAME_QUALITY = 0.72

/**
 * How far apart two grabs must be before an unchanged clock counts as a frozen stream.
 *
 * The journal and the coach both call `grabFrame`, and their timers can land in the same instant —
 * two grabs 3ms apart legitimately see the same `currentTime` on a perfectly healthy stream.
 * Anything under a second is therefore not evidence of anything, and calling it evidence would put
 * a red line on screen during a game that is going fine.
 */
const STALE_MIN_GAP_MS = 900

/**
 * How slowly the media clock has to run before the picture counts as frozen.
 *
 * Measured, in Electron, against a real `MediaStreamTrack` from `canvas.captureStream(25)`:
 *
 *   fed for 1.2s      the media clock advanced 1.171s   (0.98x wall clock)
 *   starved for 1.5s  the media clock advanced 0.040s   (0.03x — one last frame, then nothing)
 *
 * So this is not a close call, and it is also why the test is a RATIO rather than the equality
 * check it started as: a starved stream delivers one more frame after the source stops, so the
 * first comparison across a freeze is "very slightly more" rather than "exactly the same", and an
 * equality test misses precisely the grab where the freeze begins.
 *
 * The same run settled the rest of the design: after `track.stop()` the track read `ended` while
 * the element still reported `videoWidth: 640`, no `ended` event was delivered, and `drawImage`
 * happily produced a 2,875-byte JPEG of the last live frame. A grab after the share dies does not
 * fail — it silently succeeds, forever, with a photograph of the past.
 */
const STALE_ADVANCE_RATIO = 0.25

/**
 * What one grab found, before any pixels are copied.
 *
 * A separate pure function because it is the whole diagnosis and it is otherwise unreachable: the
 * hook needs React, a `<video>`, a canvas and a live `MediaStream` to run at all, so the logic that
 * decides "blind", "frozen" or "gone" could only ever be read and believed. It has been wrong in
 * exactly the way reading does not catch — a stalled stream keeps reporting a size, so the obvious
 * check passes while every frame is a photograph of the past.
 */
export type GrabVerdict = "ok" | "frozen" | "no-picture" | "ended"

export const grabVerdict = (g: {
	/** The video track's own `readyState`, or null when there is no track at all. */
	trackState: MediaStreamTrackState | null
	videoWidth: number
	/** The element's media clock, which advances only while frames arrive. */
	mediaTime: number
	/** The media clock at the previous grab, or a negative number when there was none. */
	lastMediaTime: number
	/** Wall-clock milliseconds since the previous grab. */
	sinceLastMs: number
}): GrabVerdict => {
	if (g.trackState === null || g.trackState === "ended") return "ended"
	if (g.videoWidth === 0) return "no-picture"
	/*
	 * Both conditions are required. The journal and the coach both call `grabFrame` and their
	 * timers can fire in the same millisecond, where an unchanged media clock is what a HEALTHY
	 * stream looks like — treating that as evidence would put a red line on screen mid-game for
	 * nothing. And a first grab has nothing to compare against.
	 */
	if (g.lastMediaTime < 0 || g.sinceLastMs < STALE_MIN_GAP_MS) return "ok"
	return g.mediaTime - g.lastMediaTime < (g.sinceLastMs / 1000) * STALE_ADVANCE_RATIO ?
			"frozen"
		:	"ok"
}

export interface ScreenShareHealth {
	/** Consecutive grabs that produced no picture at all. */
	missed: number
	/**
	 * Consecutive grabs whose picture had not advanced since the previous one.
	 *
	 * A `<video>` fed by a stalled MediaStream holds its last frame and keeps reporting a size, so
	 * "did I get pixels" cannot detect this. The media clock can: it advances in real time while
	 * frames are arriving and stops dead when they are not.
	 */
	stale: number
	/** Why the last grab produced nothing, in the player's words, or null. */
	reason: string | null
}

const HEALTHY: ScreenShareHealth = { missed: 0, stale: 0, reason: null }

export interface ScreenShare {
	sharing: boolean
	error: string | null
	/**
	 * True when the share stopped WITHOUT him asking it to.
	 *
	 * Distinct from `error`, which is a share that never started. This is the one that used to be
	 * invisible: the OS chrome's stop button, a display going away, or the browser reclaiming a
	 * whole-monitor capture all end the track, and the page's only reaction was to quietly stop
	 * being able to see anything.
	 */
	ended: boolean
	start: () => Promise<void>
	stop: () => void
	/** A JPEG data URL of the current frame, or null when not sharing. */
	grabFrame: () => string | null
	/** The minimap alone, cropped and upscaled for a reader. Null whenever `grabFrame` would be. */
	grabMinimap: () => string | null
	/** What the last few grabs actually produced. See {@link ScreenShareHealth}. */
	health: ScreenShareHealth
}

/**
 * The browser's own words, rewritten for someone who is about to start a game.
 *
 * `getDisplayMedia` rejects with a `DOMException` whose `message` is often empty and whose `name`
 * carries all of the meaning, so the raw string was frequently rendered as an empty red box. The
 * name is the thing worth branching on; anything unrecognised falls through with its message
 * intact, because a wrong specific sentence is worse than a raw one.
 */
export const shareFailure = (e: unknown): string => {
	const name = e instanceof DOMException ? e.name : e instanceof Error ? e.name : ""
	const raw = e instanceof Error ? e.message : String(e)
	if (name === "NotAllowedError" || name === "AbortError")
		return "Screen sharing was cancelled or blocked — press “Share my screen” and choose your whole display."
	if (name === "NotFoundError")
		return "The browser couldn't find a screen to share."
	if (name === "NotReadableError")
		return "The browser couldn't read that screen — another app may be holding it. Try again, or pick a different display."
	if (name === "TypeError" || raw.includes("getDisplayMedia"))
		return "This window can't capture a screen. Open eepalytics in your Windows browser and share from there."
	return raw === "" ? `Screen sharing failed (${name || "unknown error"}).` : raw
}

export const useScreenShare = (): ScreenShare => {
	const [sharing, setSharing] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [ended, setEnded] = useState(false)
	const [health, setHealth] = useState<ScreenShareHealth>(HEALTHY)
	const streamRef = useRef<MediaStream | null>(null)
	const videoRef = useRef<HTMLVideoElement | null>(null)
	/**
	 * The last grab's wall clock and media clock.
	 *
	 * Held in a ref rather than state because it is written on every grab — several times a
	 * heartbeat — and nothing renders from it. Only `health` renders, and only when it changes.
	 */
	const lastGrabRef = useRef({ atMs: 0, mediaTime: -1 })
	const healthRef = useRef<ScreenShareHealth>(HEALTHY)

	/**
	 * Publish health only when it actually changed.
	 *
	 * A grab happens every few seconds from two loops, and a healthy one must not re-render the
	 * whole coach panel — including its transcript — for no reason. A failing one must, because the
	 * count IS the message.
	 */
	const noteHealth = useCallback((next: ScreenShareHealth) => {
		const prev = healthRef.current
		if (prev.missed === next.missed && prev.stale === next.stale && prev.reason === next.reason)
			return
		healthRef.current = next
		setHealth(next)
	}, [])

	const teardown = useCallback(() => {
		streamRef.current?.getTracks().forEach(t => t.stop())
		streamRef.current = null
		videoRef.current = null
		lastGrabRef.current = { atMs: 0, mediaTime: -1 }
		noteHealth(HEALTHY)
		setSharing(false)
	}, [noteHealth])

	/** His stop: no fault, and it clears whatever the last failure said. */
	const stop = useCallback(() => {
		setEnded(false)
		setError(null)
		teardown()
	}, [teardown])

	/**
	 * The share stopping on its own, which is a different event and needs a different sentence.
	 *
	 * Fires from the track's own `ended` event and from `grabFrame` noticing a track that has ended
	 * without one — the second path exists because the event is not guaranteed to arrive, and a
	 * capture that has ended silently is precisely the failure that leaves every later grab
	 * returning either nothing or a photograph of the past.
	 */
	const endedByItself = useCallback(() => {
		setEnded(true)
		teardown()
	}, [teardown])

	const start = useCallback(async () => {
		try {
			if (typeof navigator === "undefined" || navigator.mediaDevices?.getDisplayMedia === undefined)
				throw new TypeError("getDisplayMedia is not available in this window")
			const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
			streamRef.current = stream
			const video = document.createElement("video")
			video.srcObject = stream
			video.muted = true
			await video.play()
			videoRef.current = video
			lastGrabRef.current = { atMs: 0, mediaTime: -1 }
			noteHealth(HEALTHY)
			// The user can also stop sharing from the OS chrome; keep our state in step with that,
			// and say so rather than simply going dark.
			stream.getVideoTracks()[0]?.addEventListener("ended", endedByItself)
			setSharing(true)
			setEnded(false)
			setError(null)
		} catch (e) {
			setError(shareFailure(e))
		}
	}, [endedByItself, noteHealth])

	const grabFrame = useCallback((): string | null => {
		const video = videoRef.current
		const track = streamRef.current?.getVideoTracks()[0]
		const bad = (reason: string): null => {
			noteHealth({ missed: healthRef.current.missed + 1, stale: 0, reason })
			return null
		}
		if (!video) return null

		const now = Date.now()
		const last = lastGrabRef.current
		const verdict = grabVerdict({
			trackState: track?.readyState ?? null,
			videoWidth: video.videoWidth,
			mediaTime: video.currentTime,
			lastMediaTime: last.mediaTime,
			sinceLastMs: now - last.atMs
		})
		/*
		 * A track can end without its `ended` event ever being delivered — the case that matters
		 * here, because the `<video>` then keeps its last frame and every later grab silently
		 * returns a photograph of the instant the capture died. Checking the track on each grab is
		 * the only reading that cannot be faked by a stalled element.
		 */
		if (verdict === "ended") {
			endedByItself()
			return null
		}
		if (verdict === "no-picture") return bad("the shared screen is producing no picture yet")
		lastGrabRef.current = { atMs: now, mediaTime: video.currentTime }

		const scale = Math.min(1, FRAME_WIDTH / video.videoWidth)
		const canvas = document.createElement("canvas")
		canvas.width = Math.round(video.videoWidth * scale)
		canvas.height = Math.round(video.videoHeight * scale)
		const ctx = canvas.getContext("2d")
		if (!ctx) return bad("this browser would not give the page a canvas to draw on")
		ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

		/*
		 * A frozen frame is still RETURNED, deliberately. It is what she is looking at, it is what
		 * belongs in the journal beside the block, and dropping it would trade one visible fault
		 * (a stale picture, reported) for an invisible one (no picture, reported as something else).
		 * The count is what tells the player which of the two is happening.
		 */
		noteHealth(
			verdict === "frozen" ?
				{
					missed: 0,
					stale: healthRef.current.stale + 1,
					reason: "the shared screen has stopped changing"
				}
			:	HEALTHY
		)
		return canvas.toDataURL("image/jpeg", FRAME_QUALITY)
	}, [endedByItself, noteHealth])

	/**
	 * The MINIMAP alone, cropped from the same video and upscaled.
	 *
	 * Measured over 20 frames from five real games, three reads each: from the whole 1536px frame a
	 * model asked where he is lands 43% of the map width away — a randomly chosen point — and agrees
	 * with its own previous answer on 5 of 60 pairs of the SAME picture. From this crop at 4x the
	 * median error is 3% and his own half of the map is right 94% of the time.
	 *
	 * And it is free: 1,089 image tokens against the whole frame's 1,100, because a small image is
	 * padded to the same tile budget. There is no accuracy-against-cost trade to weigh, which is why
	 * this is a second picture rather than a bigger first one. Raising `FRAME_WIDTH` would spend more
	 * tokens and still leave the minimap a tiny fraction of the tile grid.
	 *
	 * Health is deliberately NOT counted here. The coach calls `grabFrame` in the same turn and that
	 * call owns the counters; counting twice would report two faults for one dead share.
	 */
	const grabMinimap = useCallback((): string | null => {
		const video = videoRef.current
		const track = streamRef.current?.getVideoTracks()[0]
		if (!video || video.videoWidth === 0) return null
		if ((track?.readyState ?? null) === "ended") return null

		const r = minimapRect(video.videoWidth, video.videoHeight)
		const canvas = document.createElement("canvas")
		canvas.width = MINIMAP_READ_PX
		canvas.height = MINIMAP_READ_PX
		const ctx = canvas.getContext("2d")
		if (!ctx) return null
		ctx.imageSmoothingQuality = "high"
		ctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height)
		return canvas.toDataURL("image/jpeg", FRAME_QUALITY)
	}, [])

	useEffect(() => teardown, [teardown])

	return { sharing, error, ended, start, stop, grabFrame, grabMinimap, health }
}
