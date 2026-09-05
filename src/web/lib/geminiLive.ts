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
 *   turns  — on a timer, each carrying ONE screen frame plus the ground-truth block. This is what
 *            makes her speak; video alone produces silence, since the model has no reason to take
 *            a turn. A turn with no ground-truth block is not sent at all — see `beat()`.
 *   audio  — the microphone, 16kHz mono PCM, only while push-to-talk is held.
 *
 * Frames deliberately ride inside the turn rather than streaming through `realtimeInput.video` —
 * see `beat()`, where the measurement is. Streamed frames were not reaching the answer, and the
 * model filled the gap with generic advice that fit any game ever played. It also, separately,
 * loses the voice: streaming silences the audio outright. Both measurements are in `beat()`.
 *
 * ## Why the page talks to Google directly
 *
 * The daemon mints a short-lived token and hands it over; the API key never leaves the daemon.
 * Proxying the audio and video through the daemon would hand back the second of latency this
 * whole path exists to remove.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { mayspeak, newPaceMemory, noteSpoken, SPEAK_FLOOR_SEC } from "../../analysis/speak-pace.ts"
import { LIVE_COACH_SYSTEM_PROMPT } from "../../shared/live-prompt.ts"
import { runCoachTurn, SystemVoice } from "./turnCoach.ts"

/**
 * How often the coach is prompted to speak. The interval IS the talkativeness — and, now, the
 * cost, because exactly one frame is sent per turn.
 */
const DEFAULT_TURN_MS = 20_000
/** Gemini emits 24kHz mono PCM; the mic is expected at 16kHz. */
const OUT_RATE = 24_000
const IN_RATE = 16_000

/**
 * The floor between two spoken lines, and the reason the turn timer is no longer the cadence.
 *
 * `analysis/live-facts.ts` used to hold this for free: under the fenced architecture the ranked
 * list was the coach's whole vocabulary, so rate-limiting the LIST rate-limited the speech.
 * `shared/live-coach-mode.ts` demoted the list to a hint — measured at 13.5x the useful output —
 * and in doing so removed every rate limit this coach had. Replayed over game 5635467422 at this
 * same twenty-second turn, the unpaced cite-or-quiet coach spoke on 103 of 110 turns: 2.84 lines a
 * minute, thirteen in its busiest four minutes. **He switched the previous coach off at nine lines
 * in four minutes.** The volume gain is the point of the change and it cannot be given back through
 * the prompt, so it is given back here, on a clock, as one number.
 *
 * `SPEAK_FLOOR_SEC` is 45, swept in `analysis/speak-pace.ts` (`--pace-sweep`): 35 lines in a
 * 36-minute game, five in the busiest four minutes, and the least original material lost of any
 * floor that stays under his own quit rate.
 *
 * ## Why the gate is here, BEFORE the ground-truth fetch, and on the wall clock
 *
 * `speak-pace.ts` reasons in GAME seconds, and the only place this page can read a game clock is
 * inside the block it is about to fetch. Fetching first would cost the thing `beat()` already warns
 * about: `GET /api/live/ground-truth` builds the ranked list, and an announce-once fact consumed to
 * build a turn that is then dropped is a fact he never hears. So the floor runs on the wall clock,
 * which differs from the game clock only across pauses and loading screens — and across those the
 * socket is either closed or sending no turns at all, because a block-less turn is never sent.
 *
 * The suppressed line is DROPPED, never queued, and that was measured rather than assumed: at this
 * floor a queue delivered 34 lines of median age 19 seconds, and 17 of the 34 quoted a figure the
 * block no longer carried by the time it would have been spoken. See `analysis/speak-pace.ts`.
 */
const paceFloorSec = SPEAK_FLOOR_SEC

/** The wall clock, in seconds, for the pace floor. See `paceFloorSec` for why it is not game time. */
const nowSec = (): number => Date.now() / 1000

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

/**
 * Google's own wording, rewritten for the person reading it mid-game.
 *
 * Its strings are accurate and useless here — "Request had invalid authentication credentials.
 * Expected OAuth 2 access token, login cookie or other valid authentication credential" told a
 * player who had just pasted a key nothing he could act on. Anything unrecognised falls through
 * unchanged rather than being flattened, because a wrong specific message is worse than a raw one.
 */
const humanise = (reason: string): string => {
	const r = reason.toLowerCase()
	if (r.includes("quota") || r.includes("resource has been exhausted") || r.includes("429"))
		return "Google is rate-limiting the key — this usually clears in a minute"
	if (r.includes("api key not valid") || r.includes("invalid authentication"))
		return "that key isn't being accepted any more — check it in Settings"
	if (r.includes("internal error")) return "Google hiccupped — reconnecting"
	if (r.includes("deadline") || r.includes("timeout")) return "the connection timed out — reconnecting"
	return reason
}

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
 * Which of Google's prebuilt voices she speaks in.
 *
 * Gemini Live has no voice cloning, and building one from Lillia's own game clips would mean
 * copying a named voice actor's performance — so this is a casting decision, not a synthesis
 * problem: pick the prebuilt voice that sounds most like her. The candidates were auditioned on
 * a real coaching line; `scripts/voices.mjs` regenerates the samples.
 */
const VOICE = "Leda"

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
	/**
	 * Every source scheduled and not yet finished.
	 *
	 * Tracked so a barge-in can stop sound that is already queued AHEAD of the cursor. Without
	 * this list the only way to cut her off was to close the whole context, which is what the
	 * previous version did on every `interrupted` — churning a fresh AudioContext per turn, and
	 * throwing away the one thing that is expensive to get back (see `unlock`).
	 */
	#live = new Set<AudioBufferSourceNode>()
	/** Chunks actually handed to the hardware. The number that makes "no sound" diagnosable. */
	played = 0

	/**
	 * Forget last game's chunks, so "she spoke and nothing came out" stays answerable.
	 *
	 * `played` is the whole evidence for the silent-speakers fault, and it is a property of a
	 * SESSION, not of the page: the player object outlives every game (it holds the AudioContext,
	 * which is expensive to get back and may need another click to unlock). Left alone, one chunk
	 * played in game one would suppress the fault for every game after it — the exact shape of the
	 * bug this file's other counters were reset to avoid.
	 */
	forgetPlayed() {
		if (this.played === 0) return
		this.played = 0
		this.#note()
	}
	/**
	 * True when the browser is refusing to start audio until the page is clicked.
	 *
	 * This used to be swallowed by a bare `void ctx.resume()`. A rejected resume is precisely the
	 * "she looks like she is talking and I hear nothing" failure, and it is invisible unless
	 * something reports it — so it is state, and the UI shows it.
	 */
	blocked = false
	onChange: (() => void) | null = null

	#note() {
		this.onChange?.()
	}

	/** The context, created on demand. Kept for the life of the session. */
	#context(): AudioContext {
		this.#ctx ??= new AudioContext({ sampleRate: OUT_RATE })
		return this.#ctx
	}

	/**
	 * Start (or restore) audio output. MUST be reachable from a click.
	 *
	 * Chrome will not run an AudioContext for a page that has never been interacted with, and the
	 * coach starts on its own once the screen is shared — so nothing on the speaking path is ever
	 * a user gesture. Sharing the screen IS a click, which is where this is called from.
	 */
	async unlock(): Promise<boolean> {
		try {
			const ctx = this.#context()
			if (ctx.state === "suspended") await ctx.resume()
			const ok = ctx.state === "running"
			if (this.blocked !== !ok) {
				this.blocked = !ok
				this.#note()
			}
			return ok
		} catch {
			if (!this.blocked) {
				this.blocked = true
				this.#note()
			}
			return false
		}
	}

	play(bytes: Uint8Array) {
		const ctx = this.#context()
		/*
		 * A context can be suspended by autoplay policy or by the tab being backgrounded.
		 * Scheduling into it succeeds silently and plays nothing, so the state is recorded rather
		 * than ignored; `unlock` on the next click is what clears it.
		 */
		if (ctx.state === "suspended") {
			void this.unlock()
			if (!this.blocked) {
				this.blocked = true
				this.#note()
			}
		}
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
		src.onended = () => this.#live.delete(src)
		this.#live.add(src)
		src.start(this.#cursor)
		this.#cursor += buf.duration
		this.played += 1
		if (this.played === 1) this.#note()
	}

	/**
	 * Cut her off — barge-in, and stop.
	 *
	 * Stops what is scheduled and resets the cursor, but KEEPS the context: it is the same output
	 * device either way, and re-creating one costs an unlock the page may no longer be able to
	 * perform.
	 */
	silence() {
		for (const src of this.#live) {
			try {
				src.stop()
			} catch {
				// Already finished between the callback firing and this loop. Nothing to stop.
			}
		}
		this.#live.clear()
		this.#cursor = 0
	}

	/** Give the device back. Only on unmount — `silence` is what a barge-in wants. */
	close() {
		this.silence()
		void this.#ctx?.close()
		this.#ctx = null
	}
}

export interface GeminiLiveOptions {
	/**
	 * Which model to speak through. `gemini-live` is the socket; anything else is an HTTPS turn.
	 *
	 * Deliberately part of the SAME hook rather than a parallel one. Everything above the
	 * transport — the phase gate, the frame, the ground-truth block, the "no facts, no turn" rule,
	 * the transcript — must be identical across providers or a comparison between them measures
	 * the plumbing instead of the models.
	 */
	provider?: string
	model?: string
	/**
	 * Fetches the current ground-truth block. Called once per turn, and ONLY per turn.
	 *
	 * Async, and that matters. It used to be a synchronous read of a value polled every 5s — but
	 * building the block CONSUMES state: each death is announced once, gold once per step. Polling
	 * it four times per turn meant most "X JUST died" lines were marked spoken and discarded
	 * before the coach ever saw one. Computing it at the moment it is used makes those the same
	 * event.
	 *
	 * **An empty string means "do not take this turn at all"** — see `beat()`.
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
	/**
	 * Turns sent WITHOUT a picture, and the reason.
	 *
	 * `grabFrame()` returns null whenever the video element is not producing pixels — the share was
	 * granted but the track has not started, the tab was backgrounded, the stream ended. The turn
	 * then went text-only and NOTHING said so. The coach still spoke, from the block alone, and
	 * every line was something derivable from the logs — which is exactly what the player reported
	 * and reasonably read as "it is not looking at the frames at all".
	 *
	 * A blind turn is now counted and shown. Silent degradation is the worst failure this app can
	 * have, because the output looks identical to the working case.
	 */
	const [blindTurns, setBlindTurns] = useState(0)
	/**
	 * Turns the socket threw away because it was not open when the timer fired.
	 *
	 * `send` used to drop a message on a closed socket without a word, which is the same shape of
	 * failure as the blind turn above: from the outside a coach whose heartbeat is firing into a
	 * dead socket is indistinguishable from a coach who has nothing to say. One of these is a
	 * reconnect landing badly and is not worth a sentence; a run of them is the feature being off.
	 */
	const [droppedTurns, setDroppedTurns] = useState(0)
	/**
	 * Lines the daemon refused or never received.
	 *
	 * Surfaced, not swallowed. "What she said, earlier" reading empty is ambiguous on its own —
	 * she may simply have had nothing to say — and this is the half of that question only the
	 * page can answer.
	 */
	const [unsaved, setUnsaved] = useState(0)

	const wsRef = useRef<WebSocket | null>(null)
	/** The system voice, for turn-based providers. Gemini Live speaks for itself. */
	const voiceRef = useRef<SystemVoice | null>(null)
	voiceRef.current ??= new SystemVoice()
	const playerRef = useRef<PcmPlayer | null>(null)
	playerRef.current ??= new PcmPlayer()
	const player = playerRef.current
	/** Re-renders when the player starts being blocked, or plays its first chunk. */
	const [audio, setAudio] = useState({ blocked: false, played: 0 })
	player.onChange = () => setAudio({ blocked: player.blocked, played: player.played })
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
	/**
	 * Set while an answer to a TYPED QUESTION is in flight, which exempts that turn from PASS.
	 *
	 * A question goes to the model down the same socket as the heartbeat, so it reads as one more
	 * "is anything worth saying?" decision — and the system prompt is emphatic that the answer is
	 * usually no. Measured on a real session: of four questions typed in twenty seconds, one was
	 * answered and three were PASSed and silently dropped, transcript line and all. He was asking
	 * a coach questions and getting nothing back.
	 *
	 * A heartbeat may go unanswered; that is the whole design. A question may not.
	 */
	const answering = useRef(false)
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
	/**
	 * When she last actually SPOKE, so `paceFloorSec` can be applied.
	 *
	 * A ref rather than state: nothing renders it, and a re-render between the decision and the
	 * send would be a way for two turns to pass the same floor.
	 */
	const paceRef = useRef(newPaceMemory())
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
	 *
	 * Fire and forget is not the same as fire and never look. The failures are COUNTED, because
	 * the browser holds the only copy of a line until the daemon has it: a rejected POST means
	 * that line exists nowhere else, and silence about it is what let a whole session go missing
	 * while the log on screen looked healthy. `keepalive` so the last lines of a game survive the
	 * tab being closed on the victory screen.
	 */
	const record = useCallback((text: string, fromUser: boolean, groundTruth?: string) => {
		void (async () => {
			try {
				const res = await fetch("/api/live/gemini/transcript", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text, fromUser, groundTruth }),
					keepalive: true
				})
				// A 4xx/5xx resolves rather than throws, and used to count as saved.
				if (!res.ok) throw new Error(`HTTP ${res.status}`)
			} catch {
				setUnsaved(n => n + 1)
			}
		})()
	}, [])

	/**
	 * Put something on the socket, and say so when it could not go.
	 *
	 * Returns whether it was actually sent. The caller has to know: a heartbeat that never leaves
	 * the page produces exactly the same silence as a heartbeat the model declined to answer, and
	 * only one of those is the design working.
	 */
	const send = useCallback((msg: unknown): boolean => {
		const ws = wsRef.current
		if (ws?.readyState !== WebSocket.OPEN) return false
		ws.send(JSON.stringify(msg))
		return true
	}, [])

	/**
	 * Turn the speakers on. Safe to call repeatedly; only a click makes it succeed.
	 *
	 * Exposed because the caller knows which of its handlers are real user gestures and this file
	 * does not. Sharing the screen is the reliable one.
	 */
	const unlockAudio = useCallback(() => void player.unlock(), [player])

	/*
	 * The fallback: the FIRST click anywhere on the page also tries.
	 *
	 * Belt and braces on purpose. The failure this guards against is silent by nature — she is
	 * talking, the transcript scrolls, and nothing comes out of the speakers — so it is worth
	 * catching from more than one direction.
	 */
	useEffect(() => {
		const onGesture = () => void player.unlock()
		window.addEventListener("pointerdown", onGesture)
		window.addEventListener("keydown", onGesture)
		return () => {
			window.removeEventListener("pointerdown", onGesture)
			window.removeEventListener("keydown", onGesture)
		}
	}, [player])

	// The output device is given back when the coach leaves the page, and only then.
	useEffect(() => () => player.close(), [player])

	const stop = useCallback(() => {
		wantLiveRef.current = false
		if (reconnectRef.current) clearTimeout(reconnectRef.current)
		reconnectRef.current = null
		attemptRef.current = 0
		wsRef.current?.close()
		wsRef.current = null
		player.silence()
		voiceRef.current?.silence()
		micRef.current?.stream.getTracks().forEach(t => t.stop())
		void micRef.current?.ctx.close()
		micRef.current = null
		setMicOn(false)
		setStatus("off")
	}, [player])

	const connect = useCallback(async (isRetry: boolean) => {
		if (!isRetry) {
			wantLiveRef.current = true
			attemptRef.current = 0
			/*
			 * A deliberate connect is a NEW SESSION, and now that the screen share persists across
			 * games that is a distinction the screen has to make. Carrying the last game's lines and
			 * check-in count into this one would show a running total against a game that has not
			 * started — a number that reads as a measurement of this game and is not one, and a
			 * transcript that mixes two games' advice into one list.
			 *
			 * A RETRY is the same session — the ephemeral token expiring mid-game — so it keeps both.
			 * The durable record is the daemon's transcript either way; this is only the panel.
			 */
			setLines([])
			setUsage({ totalTokens: 0, turns: 0 })
			/*
			 * The fault counters belong to the session too. Carrying "11 blind check-ins" into a
			 * game that has not started yet is the same lie as carrying the check-in count: a
			 * number about the last game, rendered as a statement about this one.
			 */
			setBlindTurns(0)
			setDroppedTurns(0)
			setUnsaved(0)
			// The player outlives the game; its chunk count must not. See `forgetPlayed`.
			player.forgetPlayed()
			/*
			 * One socket, one game, so one pace memory per game. Carried over, a line spoken in the
			 * last thirty seconds of the previous game would gag the first line of this one — and
			 * the opening minutes are where a jungler decides his route.
			 */
			paceRef.current = newPaceMemory()
		}
		setError(null)
		setStatus(isRetry ? "reconnecting" : "connecting")
		try {
			const res = await fetch("/api/live/gemini/token", {
				method: "POST",
				signal: AbortSignal.timeout(10_000)
			})
			if (!res.ok) {
				setError(`the daemon could not mint a session token (HTTP ${res.status})`)
				setStatus("error")
				return
			}
			const tok = (await res.json()) as
				| { ok: true; token: string; model: string; wsUrl: string; systemPrompt?: string }
				| { ok: false; error: string }
			if (!tok.ok) {
				setError(tok.error)
				setStatus("error")
				return
			}

			const ws = new WebSocket(`${tok.wsUrl}?access_token=${encodeURIComponent(tok.token)}`)
			wsRef.current = ws

			/*
			 * A socket that opens and never completes setup is indistinguishable from one that is
			 * about to work, so it would sit on "connecting…" indefinitely with no way out. Setup
			 * takes ~250ms in practice; fifteen seconds is generous and still finite.
			 */
			/*
			 * Recorded, because `onclose` runs straight afterwards and used to OVERWRITE this
			 * message with the generic "reconnecting — ..." line. A socket that opens and never
			 * completes setup is a specific, actionable failure (usually a rejected token) and it
			 * was the one message that could not survive to be read.
			 */
			let guardTripped = false
			const setupGuard = setTimeout(() => {
				if (wsRef.current === ws && ws.readyState !== WebSocket.CLOSED) {
					guardTripped = true
					setError("Gemini accepted the connection but never started the session — try again")
					ws.close()
				}
			}, 15_000)
			const clearGuard = () => clearTimeout(setupGuard)

			ws.onopen = () =>
				ws.send(
					JSON.stringify({
						setup: {
							model: tok.model,
							generationConfig: {
								responseModalities: ["AUDIO"],
								speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } }
							},
							// Native audio out gives a voice but no words; this is how the log gets text.
							outputAudioTranscription: {},
							inputAudioTranscription: {},
							/*
							 * The prompt comes from the DAEMON, because only the daemon can build it.
							 *
							 * It carries the coach mode (a setting) and the champion clauses (from
							 * `knowledge/champions/*.md`, a filesystem this page cannot read). While
							 * this line was a hardcoded constant the mode picker in Settings moved
							 * the block and not the standing instructions — under `cite-or-quiet`
							 * that is a coach told to speak only from a ranked list, reading a block
							 * that no longer presents one as a menu.
							 *
							 * The fallback is the fenced prompt on purpose: a daemon too old to send
							 * `systemPrompt` gets the coach it has always had, which is wrong for the
							 * setting and still safe. Connecting with NO system prompt is the one
							 * outcome that must not happen — that is the pixels-only coach that named
							 * champions who were not in the game.
							 */
							systemInstruction: {
								parts: [{ text: tok.systemPrompt ?? LIVE_COACH_SYSTEM_PROMPT }]
							}
						}
					})
				)

			/*
			 * The fallback above is safe and WRONG, so it must not be silent.
			 *
			 * A daemon that predates the coach-mode work mints a token with no `systemPrompt`, and
			 * the page then connects with the fenced prompt while the settings screen says
			 * cite-or-quiet. That is the coach running a different architecture from the one he
			 * chose, with nothing on screen saying so — the exact shape of silence he asked to be
			 * rid of. `pnpm dev` now watches `src/server` too, so the stale-daemon case should be
			 * rare; when it happens he is told which coach he actually got.
			 */
			if (tok.systemPrompt === undefined || tok.systemPrompt === "")
				setError(
					"The daemon did not send a coach prompt, so she is running the older fenced coach " +
						"rather than the mode in Settings. Restart the daemon to pick it up."
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
					clearGuard()
					attemptRef.current = 0
					setError(null)
					setStatus("live")
					return
				}

				const sc = m.serverContent
				if (!sc) return

				/*
				 * The player started talking, so stop talking over them. This is the whole reason
				 * a live socket feels different from a glance: it can be interrupted.
				 */
				if (sc.interrupted) player.silence()

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
					// He asked; he gets an answer. PASS is not available on this turn.
					if (answering.current) {
						turnDecided.current = "speak"
						for (const chunk of pendingAudio.current) player.play(chunk)
						pendingAudio.current = []
						return
					}
					const t = partialRef.current.trimStart()
					if (t === "") return
					if (/^pass\b/i.test(t)) {
						turnDecided.current = "pass"
						pendingAudio.current = []
						return
					}
					if (t.length >= 5 || /^[^p]/i.test(t)) {
						turnDecided.current = "speak"
						for (const chunk of pendingAudio.current) player.play(chunk)
						pendingAudio.current = []
					}
				}
				decide()

				for (const p of sc.modelTurn?.parts ?? []) {
					if (!p.inlineData?.data) continue
					const bytes = b64ToBytes(p.inlineData.data)
					if (turnDecided.current === "speak") player.play(bytes)
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
						for (const chunk of pendingAudio.current) player.play(chunk)
					const wasAnswer = answering.current
					answering.current = false
					const declined =
						!wasAnswer && (turnDecided.current === "pass" || /^pass\b/i.test(text))
					partialRef.current = ""
					pendingAudio.current = []
					turnDecided.current = "unknown"
					setUsage(u => ({ ...u, turns: u.turns + 1 }))
					if (text !== "" && !declined) {
						/*
						 * The floor starts running from the line he HEARD, not from the turn that
						 * was sent. A PASS costs him nothing and must not buy twenty seconds of
						 * silence, and a turn that is still in flight has not been heard yet.
						 *
						 * An answer to a typed question counts too: he asked, she replied out loud,
						 * and the next thing he hears should still be a floor away.
						 */
						noteSpoken(paceRef.current, nowSec())
						record(text, false, truthInFlight.current)
						setLines(l => [{ text, atMs: Date.now() }, ...l].slice(0, 40))
					}
				}
			}

			ws.onerror = () => {
				// `onclose` always follows, and it carries the reason; retrying is decided there.
			}
			ws.onclose = e => {
				clearGuard()
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
				if (guardTripped)
					setError("Gemini never started the session — retrying, but if this repeats the key is the usual cause")
				else if (e.reason) setError(`reconnecting — ${humanise(String(e.reason)).slice(0, 160)}`)
				/*
				 * A close with NO reason is the common shape of a rejected token, and it used to
				 * leave `error` at null for the whole ladder — up to 38 seconds of "reconnecting…"
				 * with nothing said about why. Saying the attempt number is not a diagnosis, but it
				 * is the difference between a feature working on itself and a feature that has hung.
				 */
				else setError(`reconnecting to Gemini (attempt ${attemptRef.current} of ${RECONNECT_DELAYS_MS.length})`)
				setStatus("reconnecting")
				reconnectRef.current = setTimeout(() => void connect(true), delay)
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
			setStatus("error")
		}
	}, [])

	const turnBased = (opts.provider ?? "gemini-live") !== "gemini-live"

	/**
	 * The turn-based loop, for every provider that is not Gemini Live.
	 *
	 * Same cadence, same gate, same block — it just posts to the daemon and speaks the answer with
	 * the system voice instead of holding a socket open. It runs in place of `connect`, so the two
	 * can never both be live at once.
	 */
	useEffect(() => {
		if (!turnBased || !wantLiveRef.current) return
		let alive = true
		let inFlight = false
		const tick = async () => {
			if (!alive || inFlight) return
			// The same floor the socket applies, for the same reason and before the same fetch.
			if (!mayspeak(paceRef.current, nowSec(), "standing", { floorSec: paceFloorSec }).speak) return
			const truth = await optsRef.current.groundTruth()
			// The same rule the socket path follows: no facts, no turn. Without it the coach is
			// back to reading pixels, which is the failure the block exists to prevent.
			if (truth.trim() === "") return
			inFlight = true
			try {
				const shot = optsRef.current.grabFrame()
				if (shot === null) setBlindTurns(n => n + 1)
				const r = await runCoachTurn({
					provider: opts.provider ?? "",
					model: opts.model ?? "",
					frame: shot,
					block: truth
				})
				if (!alive) return
				if (!r.ok) {
					setError(r.reason ? humanise(r.reason).slice(0, 160) : "that model did not answer")
					return
				}
				setError(null)
				const text = r.text.trim()
				setUsage(u => ({ ...u, turns: u.turns + 1 }))
				// PASS means it judged the moment and declined, exactly as on the socket.
				if (text === "" || /^pass\b/i.test(text)) return
				noteSpoken(paceRef.current, nowSec())
				record(text, false, truth)
				setLines(l => [{ text, atMs: Date.now() }, ...l].slice(0, 40))
				voiceRef.current?.silence()
				voiceRef.current?.speak(text)
			} finally {
				inFlight = false
			}
		}
		const id = setInterval(() => void tick(), turnMs)
		void tick()
		return () => {
			alive = false
			clearInterval(id)
			voiceRef.current?.silence()
		}
	}, [turnBased, opts.provider, opts.model, turnMs, record, status])

	const start = useCallback(() => {
		if (!turnBased) return connect(false)
		// No socket to open: mark it live and let the loop above start on the next render.
		wantLiveRef.current = true
		// Same reset the socket path does in `connect`: last game's fault counts are not this
		// game's, and a stale "9 blind check-ins" reads as a measurement of the game on screen.
		setBlindTurns(0)
		setDroppedTurns(0)
		setUnsaved(0)
		player.forgetPlayed()
		// One game, one pace memory — the same reset `connect` does for the socket path.
		paceRef.current = newPaceMemory()
		setStatus("live")
		return undefined
	}, [turnBased, connect])

	/**
	 * The heartbeat that makes it speak.
	 *
	 * Video alone produces silence — the model has no reason to take a turn. This sends the
	 * computed ground truth on a timer, which is both the trigger and the facts.
	 */
	useEffect(() => {
		if (status !== "live") return
		/*
		 * The frame rides INSIDE the turn, rather than being streamed by `realtimeInput.video`.
		 *
		 * This is measured, and the difference is not subtle. Eight turns on one socket, same
		 * image, same model:
		 *
		 *   realtimeInput.video + a text turn   3.5-5.4s   "Focus on securing that vision
		 *                                                   control", "Complete your next item"
		 *   inlineData inside the turn          0.6-1.7s   "You're dead for seven more seconds"
		 *
		 * The streamed frames were not reaching the answer. Told to comment with nothing it could
		 * actually see, the model produced generic League filler that would fit any game ever
		 * played — which is exactly what the player reported as "dumb stuff", and exactly the
		 * failure the ground-truth block was built to stop. It was still happening for the half
		 * of the input that comes from pixels.
		 *
		 * Inline is also ~10x cheaper: one billed image per turn instead of one every two seconds.
		 * The only thing given up is continuous video the model was demonstrably not using.
		 *
		 * Re-measured when the coach went silent, because a single probe had suggested the inline
		 * image was what suppressed the audio. It is not, and the probe was wrong. Six turns on
		 * one socket, one Kindred screenshot, asking only what the pixels could answer:
		 *
		 *                                 audio turns   named the champion   first audio
		 *   inlineData inside the turn        6/6              5/6              855ms
		 *   stream + ask 700ms later          6/6              0/6              825ms
		 *   stream + ask 1200ms later         0/6              0/6                 —
		 *   stream 1s continuous + 700ms      0/6              0/6                 —
		 *
		 * The streamed rows are the worse failure, and not by a little: every one of them named a
		 * champion that was not on the screen — "Jinx", then "Jhin", confidently, six times each.
		 * That is the hallucination this app was rebuilt to stop, and it comes back the moment the
		 * picture stops riding inside the turn. Do not switch this to streaming to fix a silence;
		 * the silence was never here (it was the output path — see `PcmPlayer.unlock`).
		 */
		const beat = async () => {
			/*
			 * THE FLOOR, before anything is fetched or sent. See `paceFloorSec`.
			 *
			 * The tier argument is left at its default: the loudest ranked fact's tier is a property
			 * of the block, which has not been fetched yet — and the exemption it would feed is
			 * measured inert (one extra line in a 36-minute game) and refused in
			 * `analysis/speak-pace.ts` anyway.
			 */
			if (!mayspeak(paceRef.current, nowSec(), "standing", { floorSec: paceFloorSec }).speak) return
			const truth = await optsRef.current.groundTruth()
			/*
			 * NO FACTS, NO TURN.
			 *
			 * The socket is opened at champion select so that setup and the token mint are paid for
			 * before the clock starts, which means it is live through the draft and the loading
			 * screen — minutes in which the in-game API on :2999 answers nothing and the only input
			 * would be pixels. This is the guard that stops those turns being sent.
			 *
			 * It also covers the case that matters more: the ground-truth fetch FAILING mid-game.
			 * The old handling substituted a "you have no data, probably say PASS" sentence and
			 * sent the frame anyway, which is precisely the pixels-only mode that had her naming
			 * champions who were not in the game. Going quiet is the honest failure, the panel says
			 * so, and she picks straight back up on the next beat that has a block.
			 */
			if (truth.trim() === "") return
			truthInFlight.current = truth
			const frame = optsRef.current.grabFrame()
			const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = []
			if (frame !== null)
				parts.push({
					inlineData: { mimeType: "image/jpeg", data: frame.replace(/^data:[^,]+,/, "") }
				})
			// Counted, not swallowed. A turn with no picture is a coach reading the block aloud.
			else setBlindTurns(n => n + 1)
			parts.push({ text: truth })
			/*
			 * And counted when it never leaves the page at all. `send` returns false on a socket
			 * that is not open — which happens between a close and the reconnect landing — and the
			 * turn simply vanished, taking with it the announce-once facts the block had already
			 * consumed to build it. A skipped turn is not a crisis; a run of them is the coach
			 * being off while the panel says "live".
			 */
			if (!send({ clientContent: { turns: [{ role: "user", parts }], turnComplete: true } }))
				setDroppedTurns(n => n + 1)
		}
		const id = setInterval(() => void beat(), turnMs)
		void beat()
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
			record(q, true)
			setLines(l => [{ text: q, atMs: Date.now(), fromUser: true }, ...l].slice(0, 40))
			/*
			 * Marked BEFORE the send so the flag is already set when the first fragment arrives —
			 * the answer can begin streaming in well under the time a state update would take.
			 */
			answering.current = true
			player.silence()
			/*
			 * A question that never left the page must say so. A heartbeat may go unanswered — that
			 * is the design — but he typed this one and watched it appear in the log, so silence
			 * reads as "she ignored me" rather than "the socket was closed". Same reasoning as the
			 * `answering` exemption from PASS directly above.
			 */
			if (!send({ clientContent: { turns: [{ role: "user", parts: [{ text: q }] }], turnComplete: true } })) {
				answering.current = false
				setError("that question didn't send — the connection isn't open right now")
			}
		},
		[send, record, player]
	)

	useEffect(() => stop, [stop])

	return {
		status,
		lines,
		error,
		turnMs,
		setTurnMs,
		micOn,
		setMic,
		start,
		stop,
		ask,
		usage,
		/** Lines the daemon has not acknowledged storing. */
		unsaved,
		/** Turns sent with no picture attached. Non-zero means she is coaching from text alone. */
		blindTurns,
		/** Turns that never left the page because the socket was not open. */
		droppedTurns,
		/** How her voice is produced, which decides whether "no sound played" is diagnosable. */
		voice: turnBased ? ("system" as const) : ("socket" as const),
		unlockAudio,
		/** True when the browser is holding the sound back until the page is clicked. */
		audioBlocked: audio.blocked,
		/** Chunks actually played. Zero while she is talking means the sound is going nowhere. */
		audioPlayed: audio.played
	}}

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

