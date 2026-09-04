/**
 * What the League client is doing right now — the gate for everything the coach sends.
 *
 * ## Why this exists at all
 *
 * The screen share used to be torn down and rebuilt around each game, so "a stream is open"
 * doubled as "he is playing". It no longer does: he shares his whole monitor, the share persists
 * across game boundaries, and something else has to decide when frames are allowed to leave the
 * browser. This is that something.
 *
 * ## Why it is a poll and not the event stream
 *
 * The daemon already publishes a `daemon` SSE event on every phase CHANGE, and that is genuinely
 * the lower-latency source — but only for changes. A page opened mid-game would sit disarmed
 * until the next transition, which for a 35-minute game is the whole game. A poll is correct on
 * its first tick, which is the property that matters here.
 *
 * `GET /api/health` also carries `gameflowPhase` and is the wrong source for the usual reason: it
 * is polled every 20 seconds and drags a Vanguard probe and a database read behind it. Twenty
 * seconds of dead coach after the loading screen is exactly the window this gate exists to open.
 * `/api/live/phase` is one gameflow read and nothing else.
 *
 * ## One poller per tab
 *
 * Subscribers are refcounted the way `sse.ts` refcounts the event stream. The coach panel, the
 * compact strip and the overlay page all ask this same question, and they should not each open
 * their own timer against the League client.
 */

import { useEffect, useState } from "react"

export interface GameflowGate {
	/** The client's own phase string, or null when the client is closed or unreadable. */
	phase: string | null
	/** In champion select, loading, or in a game. Nothing is sent unless this is true. */
	armed: boolean
	/** A game is actually running, as opposed to drafting or loading into one. */
	inGame: boolean
	/** False when the DAEMON could not be reached — distinct from "the League client is closed". */
	reachable: boolean
}

const OFF: GameflowGate = { phase: null, armed: false, inGame: false, reachable: false }

/** Same cadence as the live overlay's own poll: fast enough to arm on the loading screen. */
const POLL_MS = 3000

/**
 * How long a previously armed gate survives a failed read.
 *
 * One dropped poll is routine — the bridge reconnects, the client is busy loading a game.
 * Disarming on it would cut the coach off mid-fight and drop the journal frames for those
 * seconds. A game that has genuinely ended stays unreadable for far longer than this, so the
 * ceiling still tells the two apart. It only ever extends a gate that was ALREADY armed: a failed
 * read never invents permission that had not been granted.
 */
const GRACE_MS = 30_000

const subscribers = new Set<(gate: GameflowGate) => void>()
let current: GameflowGate = OFF
let lastArmedMs = 0
let timer: ReturnType<typeof setInterval> | null = null
let inFlight = false

const publish = (next: GameflowGate): void => {
	if (
		next.phase === current.phase &&
		next.armed === current.armed &&
		next.inGame === current.inGame &&
		next.reachable === current.reachable
	)
		return
	current = next
	for (const s of subscribers) s(next)
}

const tick = async (): Promise<void> => {
	if (inFlight) return
	inFlight = true
	try {
		const res = await fetch("/api/live/phase", { signal: AbortSignal.timeout(4000) })
		const json = (await res.json()) as { phase?: string | null; armed?: boolean; inGame?: boolean }
		const next: GameflowGate = {
			phase: json.phase ?? null,
			armed: json.armed === true,
			inGame: json.inGame === true,
			reachable: true
		}
		if (next.armed) lastArmedMs = Date.now()
		publish(next)
	} catch {
		// See GRACE_MS: hold an armed gate briefly, then fall back to disarmed rather than keep
		// pushing frames at a daemon that has stopped answering.
		if (current.armed && Date.now() - lastArmedMs <= GRACE_MS) return
		publish(OFF)
	} finally {
		inFlight = false
	}
}

const start = (): void => {
	if (timer !== null) return
	timer = setInterval(() => void tick(), POLL_MS)
	void tick()
}

const stop = (): void => {
	if (subscribers.size > 0 || timer === null) return
	clearInterval(timer)
	timer = null
}

/** Subscribe to the client's phase. Cheap to call from several components; there is one poller. */
export const useGameflow = (): GameflowGate => {
	const [gate, setGate] = useState<GameflowGate>(current)

	useEffect(() => {
		subscribers.add(setGate)
		setGate(current)
		start()
		return () => {
			subscribers.delete(setGate)
			stop()
		}
	}, [])

	return gate
}

/**
 * What to tell the player in the states where nothing is being sent.
 *
 * Null when the coach is armed and there is nothing to explain. Shared between the full panel and
 * the compact strip so the two cannot disagree about why it is quiet. "Sharing but idle" is the
 * state this window spends most of its life in, and it has to read as deliberate — every one of
 * these lines says the share is still up AND that nothing is leaving, because those are the two
 * things someone looking at a silent coach actually wants to know.
 */
/**
 * The idle screen's headline while a game is starting, or null when there is nothing better to
 * say than whatever `/api/live` reported.
 *
 * `/api/live` reads the in-game API on :2999, which does not answer during champion select or the
 * loading screen — so its honest answer there is "no game in progress", and the overlay rendered
 * "Not in a game" while the coach panel two inches below said it was arming. Both were true and
 * together they read as a bug. The gameflow phase is the thing that knows the difference.
 */
export const armedHeadline = (gate: GameflowGate): string | null =>
	!gate.armed ? null
	: gate.phase === "ChampSelect" ? "Champion select"
	: "Loading into your game"

export const standbyReason = (gate: GameflowGate): string | null => {
	if (!gate.reachable)
		return "Can't reach eepalytics, so nothing is being sent. Your screen is still shared — is the daemon running?"
	if (gate.phase === null)
		return "Waiting for the League client. Your screen stays shared, and nothing leaves this machine until you're in a game."
	if (gate.armed) return null
	if (gate.phase === "Matchmaking" || gate.phase === "ReadyCheck")
		return "In queue. Your screen stays shared — she wakes up at champion select."
	if (gate.phase === "WaitingForStats" || gate.phase === "PreEndOfGame" || gate.phase === "EndOfGame")
		return "Game over. Your screen stays shared for the next one, and nothing is being sent until then."
	return "Not in a game. Your screen stays shared and nothing is being sent — she wakes up at champion select."
}
