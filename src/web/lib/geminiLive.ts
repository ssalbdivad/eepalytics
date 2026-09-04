/**
 * Gemini Live: a real conversation over the shared screen.
 *
 * ## What makes this different from the glance path
 *
 * `screenCoach.ts` takes a photograph every N seconds and asks a fresh process about it. Nothing
 * carries over, so it cannot follow a fight, cannot be interrupted, and cannot be asked a
 * question without starting again. Measured on the same frame it costs about 3.1 seconds.
 *
 * This holds one socket open for the whole game. Frames stream in continuously, the model keeps
 * the thread, it answers in about 0.8 seconds, and it answers in a *voice* — the model is native
 * audio out, so there is no speech synthesis in the loop.
 *
 * ## The three streams
 *
 *   video  — JPEG frames from the shared screen, ~1/s. Google's documented ceiling is 1 FPS.
 *   audio  — the microphone, 16kHz mono PCM, only while push-to-talk is held.
 *   text   — the ground-truth block, sent on a timer, which is what actually triggers a reply.
 *
 * That last one matters. Streaming video alone produces silence: the model has no reason to take
 * a turn. The text turn is the heartbeat that makes it speak, and it carries the facts the
 * picture cannot show — who is dead, for how long, gold unspent.
 *
 * ## Why the page talks to Google directly
 *
 * The daemon mints a short-lived token and hands it over; the API key never leaves the daemon.
 * Proxying the audio and video through the daemon would hand back the second of latency this
 * whole path exists to remove.
 */

import { useCallback, useEffect, useRef, useState } from "react"

/** Google documents 1 FPS as the ceiling for Live video. */
const FRAME_MS = 1000
/** Frames are for motion and position; the facts arrive as text. 800px is plenty and cheap. */
const FRAME_WIDTH = 800
const FRAME_QUALITY = 0.6
/** How often the coach is prompted to speak. The interval IS the talkativeness. */
const DEFAULT_TURN_MS = 20_000
/** Gemini emits 24kHz mono PCM; the mic is expected at 16kHz. */
const OUT_RATE = 24_000
const IN_RATE = 16_000

export interface GeminiLine {
	text: string
	atMs: number
	/** True when this was the player talking, not the coach. */
	fromUser?: boolean
}

export type GeminiStatus = "off" | "connecting" | "live" | "error"

const b64ToBytes = (b64: string): Uint8Array => {
	const bin = atob(b64)
	const out = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
	return out
}

const bytesToB64 = (bytes: Uint8Array): string => {
	let s = ""
	// Chunked: a spread of a whole audio buffer overflows the argument limit.
	for (let i = 0; i < bytes.length; i += 0x8000)
		s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	return btoa(s)
}

/**
 * Play 16-bit PCM as it arrives, gapless.
 *
 * Each chunk is scheduled against a running cursor rather than played on arrival, because
 * `start()` with no argument on every chunk produces audible seams — the coach ends up sounding
 * like a bad phone line, which undermines the one thing this path is for.
 */
class PcmPlayer {
	#ctx: AudioContext | null = null
	#cursor = 0

	play(bytes: Uint8Array) {
		this.#ctx ??= new AudioContext({ sampleRate: OUT_RATE })
		const ctx = this.#ctx
		const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2))
		if (pcm.length === 0) return
		const buf = ctx.createBuffer(1, pcm.length, OUT_RATE)
		const ch = buf.getChannelData(0)
		for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! / 32768
		const src = ctx.createBufferSource()
		src.buffer = buf
		src.connect(ctx.destination)
		const now = ctx.currentTime
		if (this.#cursor < now) this.#cursor = now
		src.start(this.#cursor)
		this.#cursor += buf.duration
	}

	/** Cut the coach off — used when the player starts talking, and on stop. */
	silence() {
		void this.#ctx?.close()
		this.#ctx = null
		this.#cursor = 0
	}
}

export interface GeminiLiveOptions {
	/** Supplies the current ground-truth text. Called on every turn. */
	groundTruth: () => string
	/** Supplies a JPEG data URL of the shared screen, or null when not sharing. */
	grabFrame: () => string | null
}

export const useGeminiLive = (opts: GeminiLiveOptions) => {
	const [status, setStatus] = useState<GeminiStatus>("off")
	const [lines, setLines] = useState<GeminiLine[]>([])
	const [error, setError] = useState<string | null>(null)
	const [turnMs, setTurnMs] = useState(DEFAULT_TURN_MS)
	const [micOn, setMicOn] = useState(false)

	const wsRef = useRef<WebSocket | null>(null)
	const playerRef = useRef(new PcmPlayer())
	const optsRef = useRef(opts)
	optsRef.current = opts
	/** Transcript arrives in fragments; they are joined until the turn completes. */
	const partialRef = useRef("")
	const micRef = useRef<{ stream: MediaStream; ctx: AudioContext } | null>(null)

	const send = useCallback((msg: unknown) => {
		const ws = wsRef.current
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
	}, [])

	const stop = useCallback(() => {
		wsRef.current?.close()
		wsRef.current = null
		playerRef.current.silence()
		micRef.current?.stream.getTracks().forEach(t => t.stop())
		void micRef.current?.ctx.close()
		micRef.current = null
		setMicOn(false)
		setStatus("off")
	}, [])

	const start = useCallback(async () => {
		setError(null)
		setStatus("connecting")
		try {
			const res = await fetch("/api/live/gemini/token", { method: "POST" })
			const tok = (await res.json()) as
				| { ok: true; token: string; model: string; wsUrl: string }
				| { ok: false; error: string }
			if (!tok.ok) {
				setError(tok.error)
				setStatus("error")
				return
			}

			const ws = new WebSocket(`${tok.wsUrl}?access_token=${encodeURIComponent(tok.token)}`)
			wsRef.current = ws

			ws.onopen = () =>
				ws.send(
					JSON.stringify({
						setup: {
							model: tok.model,
							generationConfig: { responseModalities: ["AUDIO"] },
							// Native audio out gives a voice but no words; this is how the log gets text.
							outputAudioTranscription: {},
							inputAudioTranscription: {},
							systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }
						}
					})
				)

			ws.onmessage = async ev => {
				const raw = typeof ev.data === "string" ? ev.data : await (ev.data as Blob).text()
				let m: GeminiServerMessage
				try {
					m = JSON.parse(raw) as GeminiServerMessage
				} catch {
					return
				}

				if (m.setupComplete) {
					setStatus("live")
					return
				}

				const sc = m.serverContent
				if (!sc) return

				/*
				 * The player started talking, so stop talking over them. This is the whole reason
				 * a live socket feels different from a glance: it can be interrupted.
				 */
				if (sc.interrupted) playerRef.current.silence()

				if (sc.inputTranscription?.text)
					setLines(l =>
						[{ text: sc.inputTranscription!.text!, atMs: Date.now(), fromUser: true }, ...l].slice(0, 40)
					)

				if (sc.outputTranscription?.text) partialRef.current += sc.outputTranscription.text

				for (const p of sc.modelTurn?.parts ?? []) {
					if (p.text) partialRef.current += p.text
					if (p.inlineData?.data) playerRef.current.play(b64ToBytes(p.inlineData.data))
				}

				if (sc.turnComplete) {
					const text = partialRef.current.trim()
					partialRef.current = ""
					if (text !== "") setLines(l => [{ text, atMs: Date.now() }, ...l].slice(0, 40))
				}
			}

			ws.onerror = () => {
				setError("connection to Gemini failed")
				setStatus("error")
			}
			ws.onclose = e => {
				if (e.code !== 1000 && e.reason) setError(String(e.reason).slice(0, 200))
				setStatus(s => (s === "off" ? s : e.code === 1000 ? "off" : "error"))
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
			setStatus("error")
		}
	}, [])

	/** Stream frames while live. */
	useEffect(() => {
		if (status !== "live") return
		const id = setInterval(() => {
			const frame = optsRef.current.grabFrame()
			if (frame === null) return
			send({
				realtimeInput: { video: { mimeType: "image/jpeg", data: frame.replace(/^data:[^,]+,/, "") } }
			})
		}, FRAME_MS)
		return () => clearInterval(id)
	}, [status, send])

	/**
	 * The heartbeat that makes it speak.
	 *
	 * Video alone produces silence — the model has no reason to take a turn. This sends the
	 * computed ground truth on a timer, which is both the trigger and the facts.
	 */
	useEffect(() => {
		if (status !== "live") return
		const beat = () =>
			send({
				clientContent: {
					turns: [{ role: "user", parts: [{ text: optsRef.current.groundTruth() }] }],
					turnComplete: true
				}
			})
		const id = setInterval(beat, turnMs)
		beat()
		return () => clearInterval(id)
	}, [status, turnMs, send])

	/** Push-to-talk: hold the mic open and let Gemini's own VAD decide when you stopped. */
	const setMic = useCallback(
		async (on: boolean) => {
			if (!on) {
				micRef.current?.stream.getTracks().forEach(t => t.stop())
				void micRef.current?.ctx.close()
				micRef.current = null
				setMicOn(false)
				return
			}
			try {
				const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
				const ctx = new AudioContext({ sampleRate: IN_RATE })
				const src = ctx.createMediaStreamSource(stream)
				// ScriptProcessor is deprecated but universally present, and this is 16kHz mono —
				// an AudioWorklet here would be a separate file for no measurable benefit.
				const node = ctx.createScriptProcessor(4096, 1, 1)
				node.onaudioprocess = e => {
					const input = e.inputBuffer.getChannelData(0)
					const pcm = new Int16Array(input.length)
					for (let i = 0; i < input.length; i++) {
						const s = Math.max(-1, Math.min(1, input[i]!))
						pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
					}
					send({
						realtimeInput: {
							audio: {
								mimeType: `audio/pcm;rate=${IN_RATE}`,
								data: bytesToB64(new Uint8Array(pcm.buffer))
							}
						}
					})
				}
				src.connect(node)
				node.connect(ctx.destination)
				micRef.current = { stream, ctx }
				setMicOn(true)
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			}
		},
		[send]
	)

	/** Type a question instead of speaking it. */
	const ask = useCallback(
		(question: string) => {
			const q = question.trim()
			if (q === "") return
			setLines(l => [{ text: q, atMs: Date.now(), fromUser: true }, ...l].slice(0, 40))
			send({ clientContent: { turns: [{ role: "user", parts: [{ text: q }] }], turnComplete: true } })
		},
		[send]
	)

	useEffect(() => stop, [stop])

	return { status, lines, error, turnMs, setTurnMs, micOn, setMic, start, stop, ask }
}

/* --------------------------------------------------------------- internals */

interface GeminiServerMessage {
	setupComplete?: unknown
	serverContent?: {
		interrupted?: boolean
		turnComplete?: boolean
		outputTranscription?: { text?: string }
		inputTranscription?: { text?: string }
		modelTurn?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] }
	}
}

/**
 * The coach's standing instructions.
 *
 * Deliberately shaped by what went wrong on the glance path: it narrated the screen back at the
 * player (76% of lines carried no number at all) and leaned on two Lillia catchphrases until
 * they were noise (71% of lines carried a motif, "bough" in 29%). Both failures are named here
 * rather than left to be rediscovered.
 */
const SYSTEM_PROMPT = `You are fawnsei, a League of Legends coach watching a jungle main play, live.

You speak out loud, mid-game. One or two short sentences, ever. He is playing while you talk.

**Never narrate his screen.** He is looking at it. "You're clearing gromp", "you're at full
health", "nobody is near you" — he can see all of that, and saying it back is the difference
between a coach and a monitor.

Say what he is NOT tracking, in this order:

1. An enemy who is dead right now and for how long. This is the most valuable thing a jungler is
   not watching.
2. A timer or window that changes what he should do in the next thirty seconds.
3. A number that is off — unspent gold, farm against his own average, a level gap.
4. A real warning: someone converging on him, a fight he is out of position for.
5. Genuine praise, sparingly. A multi-kill or a steal. Never for clearing a camp.

The messages you are sent carry a ground-truth block computed from the game client. Those facts
are exact — take your line from them. The video shows you where things are; the block tells you
what is true. Never name a champion that is not in the block, and never state a number that is
not in it. If you have nothing worth saying, say nothing at all rather than filling the air.

You are Lillia, but the coaching is the point and the character is seasoning. At most one line in
five gets a flourish; the rest is plain speech. No catchphrases, no signature sign-off, and never
reuse a joke you have already made this game.`
