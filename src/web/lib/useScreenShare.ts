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
 */

import { useCallback, useEffect, useRef, useState } from "react"

/** See the header — this is the measured floor for reading a League HUD, not a tuned optimum. */
const FRAME_WIDTH = 1536
/** JPEG artefacts eat small HUD text and portraits first, which is exactly what must survive. */
const FRAME_QUALITY = 0.72

export interface ScreenShare {
	sharing: boolean
	error: string | null
	start: () => Promise<void>
	stop: () => void
	/** A JPEG data URL of the current frame, or null when not sharing. */
	grabFrame: () => string | null
}

export const useScreenShare = (): ScreenShare => {
	const [sharing, setSharing] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const streamRef = useRef<MediaStream | null>(null)
	const videoRef = useRef<HTMLVideoElement | null>(null)

	const stop = useCallback(() => {
		streamRef.current?.getTracks().forEach(t => t.stop())
		streamRef.current = null
		videoRef.current = null
		setSharing(false)
	}, [])

	const start = useCallback(async () => {
		try {
			const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
			streamRef.current = stream
			const video = document.createElement("video")
			video.srcObject = stream
			video.muted = true
			await video.play()
			videoRef.current = video
			// The user can also stop sharing from the OS chrome; keep our state in step with that.
			stream.getVideoTracks()[0]?.addEventListener("ended", stop)
			setSharing(true)
			setError(null)
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		}
	}, [stop])

	const grabFrame = useCallback((): string | null => {
		const video = videoRef.current
		if (!video || video.videoWidth === 0) return null
		const scale = Math.min(1, FRAME_WIDTH / video.videoWidth)
		const canvas = document.createElement("canvas")
		canvas.width = Math.round(video.videoWidth * scale)
		canvas.height = Math.round(video.videoHeight * scale)
		const ctx = canvas.getContext("2d")
		if (!ctx) return null
		ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
		return canvas.toDataURL("image/jpeg", FRAME_QUALITY)
	}, [])

	useEffect(() => stop, [stop])

	return { sharing, error, start, stop, grabFrame }
}
