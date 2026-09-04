/**
 * Live screen coaching: grab a frame every N seconds, ask the coach, optionally speak it.
 *
 * ## The honest shape of this
 *
 * It is NOT continuous analysis. A vision call takes ten to thirty seconds, so this is a glance
 * on an interval — and the interval is the cost, which is why the user sets it and why the
 * running total is on screen rather than discovered later.
 *
 * ## Never overlap
 *
 * If a call is still running when the timer fires, the tick is skipped rather than queued.
 * Queueing would pile up calls behind a slow one, spend money on frames that are already stale,
 * and eventually deliver advice about a fight that ended a minute ago.
 *
 * ## Frames leave the machine
 *
 * A screenshot of the whole screen is sent to Anthropic on every tick. That is the deal this
 * feature makes, the UI states it plainly before it starts, and the daemon deletes each frame
 * immediately after the call rather than accumulating a folder of the user's screen.
 */

import { useCallback, useEffect, useRef, useState } from "react"

export interface Observation {
	text: string
	atMs: number
	costUsd: number | null
}

export interface ScreenCoachState {
	sharing: boolean
	/** Seconds between glances. Higher is cheaper. */
	intervalSec: number
	observations: Observation[]
	spent: number
	calls: number
	error: string | null
	busy: boolean
	speak: boolean
}

/** JPEG at 0.7 rather than PNG: a screenshot of a game compresses to roughly a tenth the bytes,
 *  and the model is reading a scene, not inspecting pixels. Smaller upload, faster call. */
const FRAME_QUALITY = 0.7
/** Downscale before upload. 1280 wide is plenty to read a minimap and health bars. */
const FRAME_WIDTH = 1280

export const useScreenCoach = () => {
	const [state, setState] = useState<ScreenCoachState>({
		sharing: false,
		intervalSec: 30,
		observations: [],
		spent: 0,
		calls: 0,
		error: null,
		busy: false,
		speak: false
	})

	const streamRef = useRef<MediaStream | null>(null)
	const videoRef = useRef<HTMLVideoElement | null>(null)
	const inFlight = useRef(false)
	const speakRef = useRef(false)
	// Read inside the interval without re-arming it on every observation.
	const recentRef = useRef<string[]>([])

	useEffect(() => {
		speakRef.current = state.speak
	}, [state.speak])

	const stop = useCallback(() => {
		streamRef.current?.getTracks().forEach(t => t.stop())
		streamRef.current = null
		videoRef.current = null
		window.speechSynthesis?.cancel()
		setState(s => ({ ...s, sharing: false, busy: false }))
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
			// The user can also stop sharing from the OS; keep our state in step with that.
			stream.getVideoTracks()[0]?.addEventListener("ended", stop)
			setState(s => ({ ...s, sharing: true, error: null }))
		} catch (e) {
			setState(s => ({ ...s, error: e instanceof Error ? e.message : String(e) }))
		}
	}, [stop])

	const grab = useCallback((): string | null => {
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

	useEffect(() => {
		if (!state.sharing) return
		let live = true

		const tick = async () => {
			// Skipped, never queued. See the file header.
			if (inFlight.current || !live) return
			const frame = grab()
			if (frame === null) return

			inFlight.current = true
			setState(s => ({ ...s, busy: true }))
			try {
				const res = await fetch("/api/live/observe", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ frame, recent: recentRef.current })
				})
				const out = (await res.json()) as {
					text?: string
					costUsd?: number | null
					error?: string
				}
				if (!live) return
				setState(s => ({
					...s,
					calls: s.calls + 1,
					spent: s.spent + (out.costUsd ?? 0),
					error: out.error ?? null,
					...(out.text ?
						{
							observations: [
								{ text: out.text, atMs: Date.now(), costUsd: out.costUsd ?? null },
								...s.observations
							].slice(0, 30)
						}
					:	{})
				}))
				if (out.text) {
					recentRef.current = [...recentRef.current, out.text].slice(-4)
					if (speakRef.current && window.speechSynthesis) {
						const u = new SpeechSynthesisUtterance(out.text)
						u.rate = 1.15
						window.speechSynthesis.speak(u)
					}
				}
			} catch (e) {
				if (live) setState(s => ({ ...s, error: e instanceof Error ? e.message : String(e) }))
			} finally {
				inFlight.current = false
				if (live) setState(s => ({ ...s, busy: false }))
			}
		}

		void tick()
		const id = setInterval(() => void tick(), state.intervalSec * 1000)
		return () => {
			live = false
			clearInterval(id)
		}
	}, [state.sharing, state.intervalSec, grab])

	useEffect(() => stop, [stop])

	return {
		...state,
		start,
		stop,
		setInterval: (sec: number) => setState(s => ({ ...s, intervalSec: sec })),
		setSpeak: (on: boolean) => {
			if (!on) window.speechSynthesis?.cancel()
			setState(s => ({ ...s, speak: on }))
		}
	}
}
