/**
 * Gemini Live: a real conversation over the shared screen.
 *
 * ## Why this replaced the glance coach
 *
 * The previous design photographed the screen every N seconds and asked a fresh CLI process about
 * it. Nothing carried over, so it could not follow a fight, be interrupted, or take a question
 * without starting again, and it answered in ~3.1s against ~0.8s here. Worse than either number:
 * with no memory of the last thirty seconds it had nothing to talk about except what was on
 * screen right now, which the player is already looking at.
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
import { LIVE_COACH_SYSTEM_PROMPT } from "../../shared/live-prompt.ts"

/**
 * How often a frame is streamed, and it is a cost dial as much as a fidelity one.
 *
 * Google documents 1 FPS as the ceiling, but every frame is a billed image: a thirty-minute game
 * at 1 FPS is 1,800 of them. Halving it to one every two seconds is not a halving of what the
 * model can see — the coach speaks on a heartbeat measured in tens of seconds, and between those
 * it needs continuity, not a flipbook.
 *
 * What it must NOT lose is freshness at the moment it decides, so a frame is always pushed
 * immediately before each turn regardless of where the interval lands. Frame SIZE is owned by
 * `useScreenShare`, and is measured there.
 */
const FRAME_MS = 2000
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

export type GeminiStatus = "off" | "connecting" | "live" | "reconnecting" | "error"

export interface GeminiUsage {
	/** Cumulative billed tokens for the session, straight from Gemini's own usageMetadata. */
	totalTokens: number
	turns: number
}

/**
 * An ephemeral token is good for about thirty minutes, and League games are routinely longer.
 *
 * So the socket WILL close mid-game, and the honest handling is to mint a new token and dial
 * again rather than to go quiet and let the player work out that the coach died. Reconnects are
 * backed off so a real outage does not become a spin, and capped so it eventually says so.
 */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000]

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
		/*
		 * A context can be created or restored in the "suspended" state — autoplay policy, or the
		 * tab having been backgrounded. Scheduling into a suspended context succeeds silently and
		 * plays nothing, which presents as a coach that has stopped talking for no reason.
		 */
		if (ctx.state === "suspended") void ctx.resume()
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
	/**
	 * Fetches the current ground-truth block. Called once per turn, and ONLY per turn.
	 *
	 * Async, and that matters. It used to be a synchronous read of a value polled every 5s — but
	 * building the block CONSUMES state: each death is announced once, gold once per step. Polling
	 * it four times per turn meant most "X JUST died" lines were marked spoken and discarded
	 * before the coach ever saw one. Computing it at the moment it is used makes those the same
	 * event.
	 */
	groundTruth: () => Promise<string>
	/** Supplies a JPEG data URL of the shared screen, or null when not sharing. */
	grabFrame: () => string | null
}

export const useGeminiLive = (opts: GeminiLiveOptions) => {
	const [status, setStatus] = useState<GeminiStatus>("off")
	const [lines, setLines] = useState<GeminiLine[]>([])
	const [error, setError] = useState<string | null>(null)
	const [turnMs, setTurnMs] = useState(DEFAULT_TURN_MS)
	const [micOn, setMicOn] = useState(false)
	/**
	 * Reported rather than estimated. This streams video continuously and bills per image, so the
	 * running total belongs on screen while it runs — the same reason the old glance coach showed
	 * its spend. A number quoted in dollars would be a guess at Google's rate; tokens are what the
	 * API actually reports.
	 */
	const [usage, setUsage] = useState<GeminiUsage>({ totalTokens: 0, turns: 0 })

	const wsRef = useRef<WebSocket | null>(null)
	const playerRef = useRef(new PcmPlayer())
	const optsRef = useRef(opts)
	optsRef.current = opts
	/** Transcript arrives in fragments; they are joined until the turn completes. */
	const partialRef = useRef("")
	/**
	 * Audio held until we know the turn is not a PASS.
	 *
	 * The coach is allowed — encouraged — to decline to speak, which it signals with the literal
	 * token PASS. In an audio-out model that token is also *spoken*, so a silent turn would come
	 * out as the word "pass" in her voice every twenty seconds. Chunks are buffered until enough
	 * transcript has arrived to decide, then either flushed or dropped. The cost is a fraction of
	 * a second at the very start of a turn, and only there.
	 */
	const pendingAudio = useRef<Uint8Array[]>([])
	const turnDecided = useRef<"unknown" | "speak" | "pass">("unknown")
	const micRef = useRef<{ stream: MediaStream; ctx: AudioContext } | null>(null)
	/**
	 * The exact facts that produced the turn now in flight.
	 *
	 * Stored at send time rather than read at completion time: by the time she finishes speaking
	 * the game has moved on, so pairing the line with the *current* ground truth would file the
	 * answer against the wrong question. This is what makes a transcript reviewable — "she said
	 * this, and here is precisely what she knew when she said it".
	 */
	const truthInFlight = useRef("")
	/** Non-null while a reconnect is pending, so `stop` can cancel it. */
	const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const attemptRef = useRef(0)
	/** False once the user has deliberately stopped; suppresses reconnects. */
	const wantLiveRef = useRef(false)

	/**
	 * Mirror every line to the daemon.
	 *
	 * Fire and forget: a failed log must never interrupt the coach, and the socket is the thing
	 * that matters. Without this there is no record of the session at all — the first real game
	 * produced advice worth fixing and not one line of it survived.
	 */
	const record = useCallback((text: string, fromUser: boolean, groundTruth?: string) => {
		void fetch("/api/live/gemini/transcript", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text, fromUser, groundTruth })
		}).catch(() => {})
	}, [])

	const send = useCallback((msg: unknown) => {
		const ws = wsRef.current
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
	}, [])

	const stop = useCallback(() => {
		wantLiveRef.current = false
		if (reconnectRef.current) clearTimeout(reconnectRef.current)
		reconnectRef.current = null
		attemptRef.current = 0
		wsRef.current?.close()
		wsRef.current = null
		playerRef.current.silence()
		micRef.current?.stream.getTracks().forEach(t => t.stop())
		void micRef.current?.ctx.close()
		micRef.current = null
		setMicOn(false)
		setStatus("off")
	}, [])

	const connect = useCallback(async (isRetry: boolean) => {
		if (!isRetry) {
			wantLiveRef.current = true
			attemptRef.current = 0
		}
		setError(null)
		setStatus(isRetry ? "reconnecting" : "connecting")
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
							systemInstruction: { parts: [{ text: LIVE_COACH_SYSTEM_PROMPT }] }
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

				if (m.usageMetadata?.totalTokenCount !== undefined)
					setUsage(u => ({ totalTokens: m.usageMetadata!.totalTokenCount!, turns: u.turns }))

				if (m.setupComplete) {
					attemptRef.current = 0
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

				if (sc.inputTranscription?.text) {
					const said = sc.inputTranscription.text
					record(said, true)
					setLines(l => [{ text: said, atMs: Date.now(), fromUser: true }, ...l].slice(0, 40))
				}

				if (sc.outputTranscription?.text) partialRef.current += sc.outputTranscription.text
				for (const p of sc.modelTurn?.parts ?? []) if (p.text) partialRef.current += p.text

				/*
				 * Decide, once per turn, whether this turn is spoken at all.
				 *
				 * The coach is told to decline with the literal token PASS, and told to use it
				 * often — but this is an audio-out model, so that token is also SPOKEN. Without
				 * this gate she says the word "pass" in her own voice every quiet turn, which is
				 * both absurd and the most common case by design.
				 *
				 * Transcription lags the audio, so `partial` is usually empty when the first
				 * chunk arrives. Deciding "speak" on an empty string would flush immediately and
				 * the gate would never fire, so it waits for actual evidence: a leading "pass",
				 * a first character that cannot begin "pass", or enough text that a leading
				 * "pass" would already be visible.
				 */
				const decide = () => {
					if (turnDecided.current !== "unknown") return
					const t = partialRef.current.trimStart()
					if (t === "") return
					if (/^pass\b/i.test(t)) {
						turnDecided.current = "pass"
						pendingAudio.current = []
						return
					}
					if (t.length >= 5 || /^[^p]/i.test(t)) {
						turnDecided.current = "speak"
						for (const chunk of pendingAudio.current) playerRef.current.play(chunk)
						pendingAudio.current = []
					}
				}
				decide()

				for (const p of sc.modelTurn?.parts ?? []) {
					if (!p.inlineData?.data) continue
					const bytes = b64ToBytes(p.inlineData.data)
					if (turnDecided.current === "speak") playerRef.current.play(bytes)
					else if (turnDecided.current === "unknown") {
						pendingAudio.current.push(bytes)
						decide()
					}
					// "pass" — dropped on the floor, which is the entire point.
				}

				if (sc.turnComplete) {
					const text = partialRef.current.trim()
					/*
					 * A turn that ended while still undecided produced audio but no usable
					 * transcript. Flush it rather than swallowing it: a malformed reply the player
					 * can hear is recoverable, silence with no explanation is not.
					 */
					if (turnDecided.current === "unknown" && !/^pass\b/i.test(text))
						for (const chunk of pendingAudio.current) playerRef.current.play(chunk)
					const declined = turnDecided.current === "pass" || /^pass\b/i.test(text)
					partialRef.current = ""
					pendingAudio.current = []
					turnDecided.current = "unknown"
					setUsage(u => ({ ...u, turns: u.turns + 1 }))
					if (text !== "" && !declined) {
						record(text, false, truthInFlight.current)
						setLines(l => [{ text, atMs: Date.now() }, ...l].slice(0, 40))
					}
				}
			}

			ws.onerror = () => {
				// `onclose` always follows, and it carries the reason; retrying is decided there.
			}
			ws.onclose = e => {
				wsRef.current = null
				if (!wantLiveRef.current) {
					setStatus("off")
					return
				}
				/*
				 * A clean 1000 mid-game is what token expiry looks like, so it is retried too —
				 * treating it as "the user is done" is what would leave someone thirty minutes
				 * into a game wondering why she stopped.
				 */
				const delay = RECONNECT_DELAYS_MS[attemptRef.current]
				if (delay === undefined) {
					setError("lost the connection to Gemini and could not get it back — press start to retry")
					setStatus("error")
					return
				}
				attemptRef.current += 1
				if (e.reason) setError(`reconnecting — ${String(e.reason).slice(0, 160)}`)
				setStatus("reconnecting")
				reconnectRef.current = setTimeout(() => void connect(true), delay)
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
			setStatus("error")
		}
	}, [])

	const start = useCallback(() => connect(false), [connect])

	const pushFrame = useCallback(() => {
		const frame = optsRef.current.grabFrame()
		if (frame === null) return
		send({
			realtimeInput: { video: { mimeType: "image/jpeg", data: frame.replace(/^data:[^,]+,/, "") } }
		})
	}, [send])

	/** Stream frames while live, for continuity between turns. */
	useEffect(() => {
		if (status !== "live") return
		const id = setInterval(pushFrame, FRAME_MS)
		return () => clearInterval(id)
	}, [status, pushFrame])

	/**
	 * The heartbeat that makes it speak.
	 *
	 * Video alone produces silence — the model has no reason to take a turn. This sends the
	 * computed ground truth on a timer, which is both the trigger and the facts.
	 */
	useEffect(() => {
		if (status !== "live") return
		const beat = async () => {
			// The freshest possible frame at the moment it decides, whatever the interval is doing.
			pushFrame()
			const truth = await optsRef.current.groundTruth()
			truthInFlight.current = truth
			send({
				clientContent: { turns: [{ role: "user", parts: [{ text: truth }] }], turnComplete: true }
			})
		}
		const id = setInterval(() => void beat(), turnMs)
		void beat()
		return () => clearInterval(id)
	}, [status, turnMs, send, pushFrame])

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
			record(q, true)
			setLines(l => [{ text: q, atMs: Date.now(), fromUser: true }, ...l].slice(0, 40))
			send({ clientContent: { turns: [{ role: "user", parts: [{ text: q }] }], turnComplete: true } })
		},
		[send, record]
	)

	useEffect(() => stop, [stop])

	return { status, lines, error, turnMs, setTurnMs, micOn, setMic, start, stop, ask, usage }
}

/* --------------------------------------------------------------- internals */

interface GeminiServerMessage {
	setupComplete?: unknown
	usageMetadata?: { totalTokenCount?: number }
	serverContent?: {
		interrupted?: boolean
		turnComplete?: boolean
		outputTranscription?: { text?: string }
		inputTranscription?: { text?: string }
		modelTurn?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] }
	}
}

