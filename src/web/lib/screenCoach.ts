/**
 * Live screen coaching: grab a frame every N seconds, ask the coach, optionally speak it.
 *
 * ## The honest shape of this
 *
 * It is NOT continuous analysis. A vision call takes about three to four seconds, so this is a
 * glance on an interval — and the interval is the cost, which is why the user sets it and why the
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
	/** Set when the user asked; kept so the log does not read as a string of non sequiturs. */
	question?: string
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
	/** True while the microphone is open for a question. */
	listening: boolean
}

/** JPEG at 0.7 rather than PNG: a screenshot of a game compresses to roughly a tenth the bytes,
 *  and the model is reading a scene, not inspecting pixels. Smaller upload, faster call. */
const FRAME_QUALITY = 0.65
/**
 * Downscale before upload. 1024 is still plenty to read a minimap and health bars, and it is a
 * third fewer bytes than 1280 — which matters on a path whose whole value is being fast.
 * Measured across 800/1024/1280 the model's own latency varies more than the size does, so this
 * is the cheap end of a range where quality is unaffected rather than a tuned optimum.
 */
const FRAME_WIDTH = 1024

export const useScreenCoach = () => {
	const [state, setState] = useState<ScreenCoachState>({
		sharing: false,
		intervalSec: 30,
		observations: [],
		spent: 0,
		calls: 0,
		error: null,
		busy: false,
		speak: false,
		listening: false
	})

	const streamRef = useRef<MediaStream | null>(null)
	const videoRef = useRef<HTMLVideoElement | null>(null)
	const inFlight = useRef(false)
	// `ask` is defined before `grab`, so it reaches the current one through a ref.
	const grabRef = useRef<(() => string | null) | null>(null)
	const speakRef = useRef(false)
	// Read inside the interval without re-arming it on every observation.
	const recentRef = useRef<string[]>([])
	/** Champion + clock from the caller's own poll, to keep the observe path off the LCU. */
	const contextRef = useRef<{ championName?: string; gameTimeSec?: number } | null>(null)

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

	/**
	 * Ask a question out loud about what is on screen right now.
	 *
	 * Voice in is the browser's own SpeechRecognition — local, free, no API — and voice out is
	 * `speechSynthesis`. Together they make a conversation, but it is turn-based by necessity:
	 * Anthropic has no realtime bidirectional session API, so this is speak -> look -> answer
	 * at a few seconds a turn, not the continuous back-and-forth of a live voice assistant.
	 * Saying otherwise would set an expectation the thing cannot meet.
	 */
	const ask = useCallback(
		async (question: string) => {
			const q = question.trim()
			if (q === "" || inFlight.current) return
			const frame = grabRef.current?.() ?? null
			if (frame === null) {
				setState(s => ({ ...s, error: "not sharing a screen yet" }))
				return
			}
			inFlight.current = true
			setState(s => ({ ...s, busy: true, error: null }))
			try {
				const res = await fetch("/api/live/observe", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ frame, question: q })
				})
				const out = (await res.json()) as { text?: string; costUsd?: number | null; error?: string }
				setState(s => ({
					...s,
					calls: s.calls + 1,
					spent: s.spent + (out.costUsd ?? 0),
					error: out.error ?? null,
					observations: [
						// The question is kept beside the answer; an answer alone reads as a non sequitur
						// when you scroll back through the log.
						{ text: `${out.text || "(no answer)"}`, question: q, atMs: Date.now(), costUsd: out.costUsd ?? null },
						...s.observations
					].slice(0, 30)
				}))
				if (out.text && window.speechSynthesis) {
					const u = new SpeechSynthesisUtterance(out.text)
					u.rate = 1.15
					window.speechSynthesis.speak(u)
				}
			} catch (e) {
				setState(s => ({ ...s, error: e instanceof Error ? e.message : String(e) }))
			} finally {
				inFlight.current = false
				setState(s => ({ ...s, busy: false }))
			}
		},
		[]
	)

	/** Push-to-talk. Resolves when the browser has a final transcript. */
	const listen = useCallback((): void => {
		const Ctor =
			(window as { SpeechRecognition?: new () => never; webkitSpeechRecognition?: new () => never })
				.SpeechRecognition ??
			(window as { webkitSpeechRecognition?: new () => never }).webkitSpeechRecognition
		if (!Ctor) {
			setState(s => ({ ...s, error: "this build has no speech recognition" }))
			return
		}
		const rec = new Ctor() as unknown as {
			lang: string
			interimResults: boolean
			continuous: boolean
			start: () => void
			stop: () => void
			onresult: ((e: { results: { 0: { transcript: string } }[] }) => void) | null
			onerror: ((e: { error: string }) => void) | null
			onend: (() => void) | null
		}
		rec.lang = "en-US"
		rec.interimResults = false
		rec.continuous = false
		setState(s => ({ ...s, listening: true }))
		rec.onresult = e => {
			const said = e.results[0]?.[0]?.transcript ?? ""
			if (said) void ask(said)
		}
		rec.onerror = e => setState(s => ({ ...s, error: `mic: ${e.error}`, listening: false }))
		rec.onend = () => setState(s => ({ ...s, listening: false }))
		rec.start()
	}, [ask])

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
		grabRef.current = grab
	}, [grab])

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
					// The overlay already polls /api/live, so it tells the server what it knows
					// rather than making it re-read the client. See the route.
					body: JSON.stringify({
						frame,
						recent: recentRef.current,
							...(contextRef.current ?? {})
					})
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
		ask,
		listen,
		setInterval: (sec: number) => setState(s => ({ ...s, intervalSec: sec })),
		/** Called by the page each poll so a glance costs no extra client round trip. */
		setContext: (ctx: { championName?: string; gameTimeSec?: number } | null) => {
			contextRef.current = ctx
		},
		setSpeak: (on: boolean) => {
			if (!on) window.speechSynthesis?.cancel()
			setState(s => ({ ...s, speak: on }))
		}
	}
}
