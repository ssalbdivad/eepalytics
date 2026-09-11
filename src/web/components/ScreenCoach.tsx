/**
 * The live voice coach — share your screen, and she talks to you while you play.
 *
 * ## Why there is only one mode now
 *
 * There used to be a second: a "glance" coach that photographed the screen every N seconds and
 * asked the Claude CLI about it. It was deleted after being measured side by side against this
 * one. It answered in ~3.1s against ~0.8s, it started a fresh process every look so it could not
 * follow a fight or be interrupted, and its advice was worse for a structural reason — with no
 * memory of the last thirty seconds it had nothing to say except what was on screen right now,
 * which the player is already looking at.
 *
 * Two modes also meant two prompts, two sets of failure modes, and a choice the player had to
 * make before they could start. Keeping the better one is the whole change.
 *
 * ## Three things are stated before it starts, not discovered after
 *
 *   - **Frames leave the machine.** The shared screen goes to Google — but only during a game.
 *   - **The microphone is off until pressed**, and says so.
 *   - **It needs a key**, which is free, and the instructions for getting one are right here
 *     rather than in a doc — a setup step you cannot complete is the same as a broken feature.
 *
 * ## The share persists; what is SENT is what is gated
 *
 * He shares his whole monitor, not the League window, so there is no reason to make him pick a
 * screen again between two games of the same session. The `MediaStream` therefore outlives the
 * game — and the thing that starts and stops is everything downstream of it:
 *
 *   - the journal loop only POSTs while the client is in champion select or later;
 *   - the Gemini socket is opened at champion select and closed when the game ends;
 *   - a turn is only actually sent once there are ground-truth facts to send with the frame.
 *
 * The gate is the client's gameflow phase (`lib/gameflow.ts`). Between games this component sits
 * there sharing and sending nothing, and it says exactly that — an idle coach that looks broken
 * gets switched off, which costs the graded review too.
 */

import { useEffect, useRef, useState } from "react"
import { useGeminiLive } from "../lib/geminiLive.ts"
import type { LiveTick } from "../../analysis/live-events.ts"
import { useGameflow, standbyReason } from "../lib/gameflow.ts"
import { liveFaults, topFault } from "../lib/liveFaults.ts"
import { useScreenShare } from "../lib/useScreenShare.ts"
import "./components.css"

const fmtTime = (ms: number): string =>
	new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })

/**
 * Is this the Electron app running inside WSL?
 *
 * Screen sharing cannot work there. Electron runs under WSLg, whose compositor contains only
 * Linux windows — enumerated live, it sees three WSLg virtual screens and exactly one window, its
 * own. League is a Windows process and is simply not visible to it. This is a boundary of where
 * the renderer is running, not a permission that can be granted.
 *
 * A Windows browser is a Windows process and can see Windows pixels; `localhost` is a secure
 * context so `getDisplayMedia` is allowed there, and WSL2 forwards localhost so the page still
 * talks to the same daemon. So the honest thing is to say so and offer the door.
 */
const isWslElectron = (): boolean => {
	if (typeof navigator === "undefined") return false
	const ua = navigator.userAgent
	return /Electron/i.test(ua) && /Linux/i.test(ua)
}

/**
 * How often she is invited to speak, for the modes that still work on a clock.
 *
 * 6 is here because `trusted` forces the beat to `TRUSTED_TURN_MS` (6,000ms), which matched none of
 * the three older buttons — so the interval row rendered with nothing selected under the shipped
 * default, and any click moved the beat to at least 10s. A default the UI cannot express is a
 * default the user cannot get back to.
 *
 * The row is now HIDDEN under `trusted`, which is asked when the game moves rather than on any
 * interval. It stays for `cite-or-quiet` and `fenced`, which keep the timer they were measured on.
 */
const TURN_CHOICES = [6, 10, 20, 40]

/**
 * How often a frame is written to the journal.
 *
 * 5s is chosen against the evidence gate, not against disk: grading needs a frame in most 30s
 * buckets of the game, so the interval has to be comfortably under a bucket for a few dropped
 * frames not to open a hole. A 30-minute game is ~360 frames, and all but the handful cited by
 * the review are pruned afterwards.
 */
const JOURNAL_MS = 5000

/**
 * How long the socket stays open after the game ends, so a line already being spoken can finish.
 *
 * Turns are gated on ground truth, which is gone the moment the game is, so nothing new can be
 * said in this window and it costs nothing. Eight seconds is longer than any line she is allowed
 * to produce — the prompt asks for one sentence.
 */
const POST_GAME_LINGER_MS = 8000

/**
 * How late a journal tick has to be before the browser is obviously throttling this tab.
 *
 * Three times the interval. Normal jitter on a busy machine running a game is tens of milliseconds
 * and an occasional slow POST costs a fraction of a second; background throttling costs an ORDER
 * of magnitude — a 5s interval becomes roughly a minute — so anything in between is not something
 * this needs to distinguish.
 */
const SLOW_TICK_FACTOR = 3

interface KeyStatus {
	configured: boolean
	ok: boolean
	error?: string | null
	hint?: string
}

export interface ScreenCoachProps {
	/**
	 * Compact renders a one-line strip instead of the full panel — never nothing.
	 *
	 * The panel used to be dropped entirely below 700px, which is the width a narrow window
	 * beside the game opens at, so the app's flagship feature was invisible exactly where a new
	 * user first meets it. The component stays mounted either way: unmounting closes the socket and stops the
	 * screen share, so a session must survive being collapsed.
	 */
	compact?: boolean
}
import { api } from "../lib/api.ts"
import { useResource } from "../lib/hooks.ts"

export const ScreenCoach = ({ compact = false }: ScreenCoachProps) => {
	const share = useScreenShare()
	/*
	 * What the LEAGUE CLIENT is doing, which is no longer the same question as what the browser is
	 * doing. The two came apart the moment the share stopped being torn down around each game, and
	 * this is the half that decides whether anything may be sent.
	 */
	const gate = useGameflow()
	const [opening, setOpening] = useState(false)
	/** Why the hand-off to the Windows browser failed. See `openInWindows`. */
	const [openError, setOpenError] = useState<string | null>(null)
	const wsl = isWslElectron()

	/**
	 * Consecutive failed ground-truth reads; see `groundTruth` below.
	 *
	 * A count rather than a flag, because one failure and eleven failures are different events with
	 * different sentences. One costs a single skipped check-in and is the design working; a run of
	 * them is a coach that has gone quiet for minutes, which is a state he has already read as
	 * "broken" once. `lib/liveFaults.ts` holds the threshold.
	 */
	const [truthFails, setTruthFails] = useState(0)
	/**
	 * Consecutive journal POSTs that did not store a frame, and the daemon's own reason.
	 *
	 * The journal's failure path was a bare `catch` with a comment saying a dropped frame is not
	 * worth interrupting a game for — true of one frame, false of sixty, and sixty is what happens
	 * when the daemon has stopped or the frame is being refused every time. This is the number that
	 * decides whether the game gets graded afterwards, so it is never inferred from silence.
	 */
	const [journalFails, setJournalFails] = useState<{ n: number; reason: string | null }>({
		n: 0,
		reason: null
	})
	/** Consecutive journal ticks that arrived far later than they were scheduled to. */
	const [throttled, setThrottled] = useState(0)
	const lastTickRef = useRef(0)
	/**
	 * What the journal has actually recorded. Shown, not assumed.
	 *
	 * Replay capture — the thing this replaces — ran for the app's entire life without ever
	 * completing once, and nothing on screen ever said so. A count the player can look at is the
	 * difference between "it is working" being a number and being a claim.
	 */
	const [journal, setJournal] = useState<{ frames: number; sessionId: string | null } | null>(null)
	/**
	 * The last ground-truth block the coach fetched, so a journalled frame can be stored beside the
	 * facts that were true when it was taken. Only ever a copy of something already fetched — the
	 * journal never polls on its own, because a second poll would consume the announce-once state
	 * the coach depends on.
	 */
	const truthRef = useRef("")

	/*
	 * Ground truth does not survive a game boundary.
	 *
	 * This component now outlives the game on purpose, so without this the first frames of game N
	 * were filed with game N-1's FINAL roster, score and gold — stored in `journal_frame.truthJson`
	 * and read back later as evidence. Unbounded whenever the voice coach is not running, which is
	 * the free path the panel actively encourages. Wrong facts attached to the right pictures is
	 * the one failure this journal exists to prevent.
	 */
	useEffect(() => {
		if (!gate.inGame) truthRef.current = ""
	}, [gate.inGame])
	const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null)
	const [keyInput, setKeyInput] = useState("")
	const [savingKey, setSavingKey] = useState(false)

	/**
	 * True when the key could not be CHECKED, which is not the same as there being no key.
	 *
	 * With the daemon down the probe failed and the panel rendered the whole "One-time setup: get a
	 * free Google AI Studio key" flow — a thirty-second errand aimed at someone who already had a
	 * key, for a problem that was not his. The two states now say different things.
	 */
	const [keyProbeFails, setKeyProbeFails] = useState(0)

	/*
	 * Re-probed, not asked once at mount.
	 *
	 * The page is routinely open before the daemon is (and survives it restarting), and a single
	 * probe at mount meant one unlucky moment left the voice coach looking permanently unconfigured
	 * for the rest of the session — with a setup form on screen as the explanation. It stops once
	 * the answer is a working key, because that answer cannot go stale on its own.
	 */
	useEffect(() => {
		let alive = true
		const probe = async () => {
			try {
				const r = await fetch("/api/live/gemini/status", { signal: AbortSignal.timeout(4000) })
				if (!r.ok) throw new Error(`HTTP ${r.status}`)
				const j = (await r.json()) as KeyStatus
				if (!alive) return
				setKeyProbeFails(0)
				setKeyStatus(j)
			} catch {
				if (!alive) return
				// Deliberately NOT a KeyStatus of `{configured:false}`: that is a claim about his
				// key, and this is an admission about our own reachability.
				setKeyProbeFails(n => n + 1)
			}
		}
		void probe()
		// A working key cannot go stale on its own, so the retry stops the moment there is one.
		if (keyStatus?.ok === true) return () => void (alive = false)
		const id = setInterval(() => void probe(), 10_000)
		return () => {
			alive = false
			clearInterval(id)
		}
	}, [keyStatus?.ok])

	const saveKey = async () => {
		setSavingKey(true)
		try {
			const r = await fetch("/api/live/gemini/key", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ key: keyInput })
			})
			const j = (await r.json()) as { configured?: boolean; works?: boolean; error?: string | null }
			setKeyInput("")
			setKeyStatus({
				configured: Boolean(j.configured),
				ok: Boolean(j.works),
				error: j.error ?? null
			})
		} catch (e) {
			setKeyStatus({ configured: false, ok: false, error: e instanceof Error ? e.message : String(e) })
		} finally {
			setSavingKey(false)
		}
	}

	/*
	 * The journal: one frame every 5s while the screen is shared AND the client says a game is on.
	 *
	 * Deliberately NOT tied to the Gemini coach. Sharing the screen is what earns a graded review
	 * after the game; the live voice is an optional extra on top. Tying them would mean paying for
	 * an API to get a review that costs nothing.
	 *
	 * `daemon/journal.ts` still refuses every frame it cannot place on a game clock, and that stays
	 * the authority — this gate is an optimisation, never a security boundary. It is here because a
	 * refused frame is not free and, far more to the point, not private: without it a screenshot of
	 * his WHOLE MONITOR — mail, bank, whatever else is open — was JPEG-encoded on the main thread,
	 * base64'd, and pushed through the daemon every five seconds around the clock purely to be
	 * thrown away, each one dragging an `allgamedata` round trip to the League client behind it.
	 * Not taking the picture is strictly better than taking it and deleting it.
	 */
	useEffect(() => {
		/*
		 * `inGame`, NOT `armed`. The daemon refuses any frame it cannot place on the game clock,
		 * and there is no clock during champion select or the loading screen — so arming the
		 * journal there spent 60-180s of every game encoding his whole monitor, POSTing it, and
		 * dragging an `allgamedata` round trip behind each one, purely to be rejected.
		 */
		if (!share.sharing || !gate.inGame) return
		let alive = true
		let inFlight = false
		const tick = async () => {
			if (inFlight || !alive) return
			/*
			 * How late this tick actually is.
			 *
			 * Browsers throttle timers in a background tab hard — a 5s interval becomes about a
			 * minute — and this window spends every game behind the game. Nothing errors: frames
			 * are still saved, just twelve times fewer of them, and the panel goes on saying
			 * "Recording this game" while the evidence needed to grade it quietly stops arriving.
			 * The tick's own lateness is the only honest measurement of that, and it costs a
			 * subtraction.
			 */
			const now = Date.now()
			if (lastTickRef.current > 0)
				setThrottled(n =>
					now - lastTickRef.current > JOURNAL_MS * SLOW_TICK_FACTOR ? n + 1 : 0
				)
			lastTickRef.current = now

			// A null frame is already counted by the share's own health — see `useScreenShare`.
			const frame = share.grabFrame()
			if (frame === null) return
			inFlight = true
			try {
				const r = await fetch("/api/live/journal/frame", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ frame, truth: truthRef.current || undefined })
				})
				if (!r.ok) throw new Error(`HTTP ${r.status}`)
				const j = (await r.json()) as {
					ok?: boolean
					sessionId?: string | null
					reason?: string | null
				}
				if (!alive) return
				/*
				 * A refusal is a 200 with `ok: false` — the daemon is right to answer that way, since
				 * "no game clock yet" is a normal outcome rather than a server error. But the page
				 * used to read only the success branch, so a frame refused every five seconds for a
				 * whole game left the panel saying "Recording — the first frames are on their way"
				 * forever. The reason travels with the count so the sentence can name the cause.
				 */
				if (!j.ok) {
					setJournalFails(p => ({ n: p.n + 1, reason: j.reason ?? null }))
					return
				}
				setJournalFails({ n: 0, reason: null })
				setJournal(p =>
					// Counted PER GAME, not per browser session. The share now spans games, so a
					// running total would tell him "412 frames" about a game that recorded 180 —
					// a number that looks like evidence and is not one. The daemon rolls the
					// session id on a backwards clock jump; that roll resets the count.
					p && p.sessionId === (j.sessionId ?? null) ?
						{ frames: p.frames + 1, sessionId: p.sessionId }
					:	{ frames: 1, sessionId: j.sessionId ?? null }
				)
			} catch {
				/*
				 * ONE dropped frame is not worth interrupting a game for. Sixty of them is the
				 * recording being off, and that is the whole difference this counter exists to
				 * make — the comment that used to sit here, alone, is exactly the pattern he
				 * complained about.
				 */
				if (alive) setJournalFails(p => ({ n: p.n + 1, reason: "eepalytics didn't answer" }))
			} finally {
				inFlight = false
			}
		}
		const id = setInterval(() => void tick(), JOURNAL_MS)
		void tick()
		return () => {
			alive = false
			clearInterval(id)
		}
	}, [share.sharing, gate.inGame, share.grabFrame])

	/*
	 * Which model to speak through. Read here rather than inside the hook so the hook stays a
	 * transport and the CHOICE stays with the screen the player configures.
	 */
	const settings = useResource(signal => api.settings(signal), [])
	const liveProvider = settings.data?.liveProvider ?? "gemini-live"
	const liveModel = settings.data?.liveModel ?? ""
	// The architecture, forwarded so the socket can drop the pace floor under `trusted`.
	const coachMode = settings.data?.liveCoachMode ?? ""

	const gem = useGeminiLive({
		provider: liveProvider,
		model: liveModel,
		/*
		 * Fetched per turn rather than polled.
		 *
		 * Building this block consumes state in the daemon — each death is announced once — so
		 * polling it every few seconds threw most of those announcements away unheard. One fetch,
		 * one turn.
		 */
		/*
		 * The minimap, cropped in the page and read by the daemon.
		 *
		 * The daemon makes the model call because the page has no credential that can: its
		 * ephemeral token is `uses: 1` and accepted only by the Constrained WebSocket endpoint,
		 * and a raw key in the browser is the one thing this app will not do. The crop is 17 KB
		 * against the whole frame's 153 KB, to a daemon this page already uploads the whole frame
		 * to every five seconds, so the extra hop is not the cost — the model call is, and that is
		 * paid either way.
		 *
		 * Swallowing is correct HERE and almost nowhere else in this file: a failed read costs a
		 * GATE, not a line. `buildFacts` ranks exactly what it ranks today without an observation,
		 * so there is no silence for the player to misread as the coach being broken, and nothing
		 * for him to act on. The daemon logs the reason.
		 */
		/**
		 * One cheap look at the live feed, so the coach can be asked when the GAME moves.
		 *
		 * Deliberately NOT `groundTruth`. That call consumes state on the daemon — it advances the
		 * delta's baseline and the turn sequence — so it may only be made when a turn is actually
		 * going out; polling it to look for a death would mean the next real turn's delta covered
		 * two seconds instead of the ninety since she last spoke. `GET /api/live/tick` touches
		 * nothing and is a projection of the same `allgamedata` poll the daemon makes anyway.
		 *
		 * Swallowed, like the minimap read and for the same reason: a failed look costs a
		 * DECISION, not a line. `analysis/live-events.ts` simply sees no movement this tick, the
		 * 90-second floor under silence still applies, and the next look picks it up.
		 */
		liveTick: async () => {
			try {
				const r = await fetch("/api/live/tick", { signal: AbortSignal.timeout(3000) })
				if (!r.ok) return null
				const j = (await r.json()) as { tick?: LiveTick | null }
				return j.tick ?? null
			} catch {
				return null
			}
		},
		readMinimap: async () => {
			const crop = share.grabMinimap()
			if (crop === null) return
			try {
				await fetch("/api/live/frame-read", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ crop }),
					signal: AbortSignal.timeout(4000)
				})
			} catch {
				/* a gate, not a line */
			}
		},
		groundTruth: async req => {
			try {
				/*
				 * `?resync=1` is the page telling the daemon that the model's thread holds nothing.
				 *
				 * The daemon owns the turn sequence — it is the only side that knows what it has
				 * already sent — but it cannot see a socket being replaced, and a reconnect gives
				 * Gemini a completely fresh thread. So the one bit only this side knows travels in
				 * the query string, and the daemon answers it with the full brief instead of a
				 * delta. Absent, this is a normal turn.
				 */
				const r = await fetch(
					`/api/live/ground-truth${req?.resync === true ? "?resync=1" : ""}`,
					{ signal: AbortSignal.timeout(4000) }
				)
				/*
				 * A 500 RESOLVES. It does not throw, so the old code fell through to `j.text` being
				 * undefined and returned "" with the failure flag still reading OK — a daemon that
				 * was erroring on every read was indistinguishable, on screen, from not being in a
				 * game. Status first, then the body.
				 */
				if (!r.ok) throw new Error(`HTTP ${r.status}`)
				const j = (await r.json()) as {
					inGame?: boolean
					text?: string
					gameTimeSec?: number | null
					turn?: number
				}
				setTruthFails(0)
				if (j.text) {
					truthRef.current = j.text
					/*
					 * The clock rides back with the block because the page has no other source for
					 * one. It is what finally lets a transcript row say when it was said — every
					 * stored row until now has a null `gameTimeSec`, which is what made the coach's
					 * own history unusable as memory.
					 */
					return {
						text: j.text,
						gameTimeSec: typeof j.gameTimeSec === "number" ? j.gameTimeSec : null,
						/*
						 * Carried back out on the transcript POST, so the daemon can date a line
						 * against the block it answered rather than against whatever it served
						 * most recently. It matters most for the slow turn-based providers, where
						 * a reply routinely lands after the next turn has gone out.
						 */
						...(typeof j.turn === "number" ? { turn: j.turn } : {})
					}
				}
			} catch {
				/*
				 * Surfaced, not swallowed. Without facts the coach is back to guessing from
				 * pixels, which is the exact failure this whole path was built to end — so the
				 * player is told rather than left with a confident-sounding coach running blind.
				 *
				 * Counted rather than flagged: the first failure costs one check-in and says
				 * nothing, a run of them says so out loud. See `lib/liveFaults.ts`.
				 */
				setTruthFails(n => n + 1)
			}
			/*
			 * Empty means the turn is NOT SENT — see `beat()` in `lib/geminiLive.ts`.
			 *
			 * This used to return a sentence telling the model it had no data and should probably
			 * PASS, and then sent it a screenshot anyway. That is the pixels-only path wearing a
			 * disclaimer: it still handed her a picture and invited her to find something in it,
			 * which is how a coach ends up naming a champion who is not in the game. It also fired
			 * on every beat of champion select and the loading screen, where there is no :2999 data
			 * by definition. Going quiet costs one turn and cannot be wrong.
			 */
			return { text: "", gameTimeSec: null }
		},
		grabFrame: share.grabFrame,
		coachMode
	})

	const [question, setQuestion] = useState("")
	/**
	 * Set when HE stops the coach, so auto-start does not immediately turn it back on.
	 *
	 * Without this the stop button is a no-op that flickers, which is worse than not having one.
	 */
	const [stoppedByHand, setStoppedByHand] = useState(false)

	/**
	 * One socket per GAME — opened at champion select, closed when the game ends.
	 *
	 * The share persists across games; the socket deliberately does not. Three reasons, in the
	 * order they mattered:
	 *
	 *  1. **The model keeps the thread.** That is the whole point of a live session, and it is
	 *     exactly why one socket must not span two games: an hour-old conversation carries game
	 *     one's roster into game three, and the coach starts referencing a champion who is not in
	 *     this game. Every other rule in this app exists to stop that happening; keeping a socket
	 *     open between games would reintroduce it through the back door.
	 *  2. **An ephemeral token lasts about thirty minutes.** An idle socket held between games does
	 *     not sit there for free — it expires, closes clean, and the reconnect ladder mints another
	 *     one, forever, for a coach nobody is listening to. Reconnects exist to survive a token
	 *     expiring MID-GAME, which is a real and unavoidable case; manufacturing that case while
	 *     idle is not what the ladder is for.
	 *  3. **Setup is cheap and it is paid for early.** Minting a token and completing setup is
	 *     ~0.5s, and arming at champion select spends it during the draft — so she is live before
	 *     the loading screen finishes, and nothing about the reconnection is on the critical path
	 *     of his first clear.
	 *
	 * Being live is still not permission to talk: `beat()` sends nothing until there is a
	 * ground-truth block, so the draft and the loading screen warm the socket in silence.
	 *
	 * Starting is automatic because sharing is already the deliberate act, and it waits for a key
	 * that actually works so it can never spend money on a connection that was going to fail.
	 */
	useEffect(() => {
		if (!share.sharing || !gate.armed || stoppedByHand) return
		if (keyStatus === null || !keyStatus.ok) return
		if (gem.status !== "off") return
		void gem.start()
	}, [share.sharing, gate.armed, stoppedByHand, keyStatus, gem])

	/**
	 * Closing the socket, which is not quite the same instant as disarming.
	 *
	 * The gate flips the moment the nexus falls, and closing on that edge cuts her off mid-word —
	 * a jarring artifact this change would otherwise have introduced all by itself, at the exact
	 * moment of the game he most wants a sentence finished. So a game ending gets a few seconds of
	 * grace to land the line she is already speaking. It costs nothing: `beat()` needs a
	 * ground-truth block and there is none once the game is over, so no new turn can start.
	 *
	 * Pulling the share is different and immediate — that is him asking for it to stop.
	 *
	 * The deadline is absolute rather than a timer re-armed on each render. `gem` is a fresh object
	 * every render, so a relative timeout would be cleared and restarted by her own transcript
	 * arriving and might never fire at all.
	 */
	const disarmedAtRef = useRef<number | null>(null)
	useEffect(() => {
		const wanted = share.sharing && gate.armed
		if (wanted) {
			disarmedAtRef.current = null
			return
		}
		// A new game is a new intention: last game's "stop coaching" does not carry into it, the
		// same way a fresh share never inherited the previous one's.
		if (stoppedByHand) setStoppedByHand(false)
		if (gem.status === "off") return
		if (!share.sharing) {
			gem.stop()
			return
		}
		disarmedAtRef.current ??= Date.now()
		const dueInMs = disarmedAtRef.current + POST_GAME_LINGER_MS - Date.now()
		if (dueInMs <= 0) {
			gem.stop()
			return
		}
		const id = setTimeout(() => gem.stop(), dueInMs)
		return () => clearTimeout(id)
	}, [share.sharing, gate.armed, gem, stoppedByHand])

	/**
	 * Hand off to the Windows browser — the only path that can share a screen from WSL.
	 *
	 * The failure here was total and silent: with the daemon unreachable the POST rejected, the
	 * caller's `.catch` discarded it on the grounds that "both set their own error state", and this
	 * function set none. Pressing the app's primary button did nothing at all, forever, with no
	 * message. It is the first button a new user presses.
	 */
	const openInWindows = async () => {
		setOpening(true)
		try {
			const r = await fetch("/api/shell/open-in-windows", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ hash: "#/live" })
			})
			if (!r.ok) throw new Error(`HTTP ${r.status}`)
			setOpenError(null)
		} catch {
			// The origin comes from the page, not from a constant: this app's port is configurable,
			// and an address that is wrong is worse than no address at all when it is the one
			// instruction he has left.
			setOpenError(
				`Couldn't ask eepalytics to open your Windows browser. Check the daemon is running, or open ${location.origin}/#/live over there yourself.`
			)
		} finally {
			setOpening(false)
		}
	}

	const needsKey = keyStatus !== null && !keyStatus.ok
	/**
	 * Everything currently wrong, in one list, most severe first.
	 *
	 * Assembled here rather than rendered from a dozen scattered conditions so that the panel and
	 * the one-line strip cannot disagree about whether the feature is working — the strip is what
	 * he sees while the game has the screen, and it used to say "In a game — coach arming" over a
	 * coach that had given up entirely.
	 */
	const faults = liveFaults({
		sharing: share.sharing,
		shareEnded: share.ended,
		shareError: share.error ?? openError,
		framesMissed: share.health.missed,
		framesStale: share.health.stale,
		blindTurns: gem.blindTurns,
		truthFails,
		throttledTicks: throttled,
		journalFails: journalFails.n,
		journalReason: journalFails.reason,
		droppedTurns: gem.droppedTurns,
		unsaved: gem.unsaved,
		daemonReachable: gate.reachable,
		keyProbeFails,
		coachStatus: gem.status,
		coachError: gem.error,
		voice: gem.voice,
		// Hers, not his: a question he typed is not evidence that her audio is reaching the speakers.
		spokenLines: gem.lines.filter(l => l.fromUser !== true).length,
		audioPlayed: gem.audioPlayed,
		audioBlocked: gem.audioBlocked
	})
	const worst = topFault(faults)
	/**
	 * Why nothing is being sent, or null when the gate is open.
	 *
	 * This is the sentence that keeps a persistent share from reading as a hung feature. Between
	 * games the coach is silent, the frame count has stopped moving and no dot is green — which is
	 * indistinguishable from broken unless something says otherwise, and a coach that looks broken
	 * gets switched off, taking the free graded review down with it.
	 */
	const standby = share.sharing ? standbyReason(gate) : null

	if (compact)
		return (
			<div className="csk-screen csk-screen--compact">
				<span
					className="csk-screen__dot"
					// Sharing-but-idle is its own state, not an off one. Without this the dot is the
					// same grey in "waiting for your next game" as in "you never pressed share".
					// A live fault outranks both: a green dot over a broken coach is the single most
					// misleading thing this strip can show, and it showed exactly that.
					data-state={
						worst?.level === "error" ? "error"
						: standby !== null && gem.status === "off" ? "standby"
						: gem.status
					}
				/>
				<span className="csk-screen__compactlabel" title={worst?.text ?? undefined}>
					{/*
					 * The strip is what he can see while the game owns the screen, so a fault has to
					 * reach it. It said "In a game — coach arming" over a coach that had given up
					 * and over a share that had ended — both indistinguishable from working.
					 */}
					{worst?.level === "error" ?
						worst.short
					: gem.status === "live" ?
						`Coaching · ${gem.usage.turns} check-in${gem.usage.turns === 1 ? "" : "s"}`
					: gem.status === "reconnecting" ?
						"Coach reconnecting…"
					: gem.status === "connecting" ?
						"Coach connecting…"
					: share.sharing && gate.armed && needsKey ?
						// The journal half is running and free; only the voice is blocked. Saying
						// only "needs a key" would hide the half that is actually working.
						"Recording — the voice needs a key"
					: share.sharing && gate.armed ?
						"In a game — coach arming"
					: share.sharing && !gate.reachable ?
						"Sharing — can't reach eepalytics"
					: share.sharing ?
						// Says the share survived, which is the thing he is checking for.
						"Sharing — waiting for your next game"
					: needsKey ?
						"Live coach needs a key"
					:	"Live coach"}
				</span>
			</div>
		)

	return (
		<div className="csk-screen">
			<div className="csk-screen__head">
				<div>
					{/*
					 * She had no name anywhere on screen — she was only ever "she", which is a
					 * strange way to meet someone who is about to start talking to you.
					 */}
					<strong>Coach Lillia will coach you out loud</strong>
					<p>
						Share your screen and she watches it while you play, talking to you about a
						second behind. She stays quiet unless she has something worth saying — most of
						the time she says nothing, and that is on purpose.
					</p>
					{/*
					 * Said BEFORE he shares, because it is the reason he can share once and forget
					 * about it. Someone who thinks the share is live on his desktop all evening will
					 * turn it off between games, which is the behaviour this change exists to remove.
					 */}
					<p>
						Share once and leave it. Nothing is sent between games — she wakes up when you
						hit champion select and goes quiet again when the game ends.
					</p>
				</div>
				{share.sharing ?
					<button className="btn" onClick={share.stop}>
						Stop sharing
					</button>
				:	<button
						className="btn btn-primary"
						/*
						 * NOT gated on the key. Sharing the screen is the FREE half — it records the
						 * frames that earn a graded review after the game, and costs nothing. Only
						 * the live voice needs Google. Disabling this behind the key put the free
						 * path behind a paid setup step, which is the first thing a new user hits.
						 */
						disabled={opening}
						// On WSL, sharing here can only ever capture WSL's own windows, so this hands
						// off to the Windows browser rather than opening a picker that cannot show
						// League. One press, no second decision.
						onClick={() => {
							// A real click, which is the only thing that can start audio output.
							gem.unlockAudio()
							void (wsl ? openInWindows() : share.start()).catch(() => {
								/* both set their own error state; this only stops an unhandled rejection */
							})
						}}
					>
						{opening ? "Opening…" : "Share my screen"}
					</button>
				}
			</div>

			{/*
			 * Everything that is currently wrong, in one place and in his words.
			 *
			 * This used to be four conditions scattered down the panel — ground truth, unsaved
			 * lines, blind check-ins, the socket error — with the other eight failure paths saying
			 * nothing at all. One list means a new failure has an obvious home, and it means the
			 * player has ONE place to look when the coach starts sounding thin.
			 *
			 * Persistent, not a toast. Every line here describes something true right now and
			 * disappears when it stops being true; the failures worth reporting last for minutes,
			 * and he is looking at the game, not at this panel, at the instant one starts.
			 */}
			{faults.map(f => (
				<div key={f.id} className={f.level === "error" ? "csk-screen__err" : "csk-screen__warn"}>
					{f.text}
					{f.fix !== null && <> {f.fix}</>}
				</div>
			))}

			{/*
			 * The setup step, inline. A free key is a thirty-second errand, but only if you are
			 * told exactly where to go — otherwise it is indistinguishable from the feature being
			 * broken.
			 */}
			{needsKey && (
				<div className="csk-screen__setup">
					<strong>One-time setup: a free Google AI Studio key</strong>
					<ol>
						<li>
							Open{" "}
							<a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
								aistudio.google.com/apikey
							</a>{" "}
							and sign in with any Google account. This is Google's page, not ours — it gives
							you a password that lets eepalytics talk to their voice model.
						</li>
						<li>
							Press <b>Create API key</b>. The free tier is enough to try this.
						</li>
						<li>Copy it and paste it below.</li>
					</ol>
					<div className="csk-screen__keyrow">
						<input
							type="password"
							autoComplete="off"
							spellCheck={false}
							placeholder="paste your key here"
							value={keyInput}
							onChange={e => setKeyInput(e.target.value)}
						/>
						<button
							className="btn btn-primary"
							disabled={keyInput.trim() === "" || savingKey}
							onClick={() => void saveKey()}
						>
							{savingKey ? "Checking…" : "Save"}
						</button>
					</div>
					{/*
					 * Google's own message here is "Request had invalid authentication credentials.
					 * Expected OAuth 2 access token, login cookie or other valid authentication
					 * credential. See https://developers.google.com/identity/sign-in/web/..." —
					 * accurate, and useless to someone who has just pasted a key. The real cause is
					 * almost always a partial copy, so say that; the raw text stays available on
					 * hover for anyone who wants it.
					 */}
					{keyStatus?.configured && keyStatus.error && (
						<div className="csk-screen__err" title={keyStatus.error}>
							That key wasn't accepted. Check you copied the whole thing from AI Studio — they
							are long, and it's easy to miss the end.
						</div>
					)}
					<p className="csk-screen__fine">
						Your key stays on this computer — this page never sees it. eepalytics swaps it for a
						pass that works for one session and then stops working.
						<br />
						There is no "sign in with Google" button because Google does not offer one for
						this; a paid Gemini subscription does not include it either.
					</p>
				</div>
			)}

			{wsl && !share.sharing && (
				<div className="csk-screen__blocked">
					<strong>This will open in your Windows browser.</strong>
					<p>
						This window can only see its own Linux screens, not the Windows desktop and not
						the game. Your Windows browser can see the game, and it still talks to the same
						eepalytics running here — so nothing is lost by moving over.
					</p>
				</div>
			)}

			{!wsl && !share.sharing && !needsKey && (
				<div className="csk-screen__warn">
					During a game your shared screen is sent to Google once per check-in, and it is
					billed per frame — the running total shows while it's on. Between games nothing
					leaves this machine. Your microphone stays off until you turn it on.
				</div>
			)}

			{/*
			  * The journal's own line, shown whenever the screen is shared.
			  * ONE line for what is happening right now, shown whenever the screen is shared.
			  *
			  * It carries the frame count, because that is the whole difference from the feature this
			  * replaced: replay capture ran for the app's entire life without ever completing once and
			  * nothing on screen ever said so. A number is checkable; "it's working" is not.			  *
			  * It also carries the standby reason, in the same place, for the same reason — with the
			  * share persisting, "no number is moving" is now the normal state between games and has
			  * to be visibly deliberate rather than merely quiet.
			  */}
			{share.sharing && (
				<div className={journal && journal.frames > 0 && standby === null ? "csk-screen__journal on" : "csk-screen__journal"}>
					{standby !== null ?
						standby
					: journal && journal.frames > 0 ?
						<>
							<b>Recording this game.</b> {journal.frames} frame
							{journal.frames === 1 ? "" : "s"} saved — enough of them and this game gets graded
							afterwards.
						</>
					: gate.inGame ?
						<>Recording — the first frames are on their way.</>
					:	<>
							{/* Armed but pre-game: champ select or the loading screen. */}
							Getting ready. Frames are only saved once the game clock starts, so nothing is
							stored during the draft.
						</>
					}
				</div>
			)}
			{/*
			 * A reconnect is expected — the session credential lasts about half an hour and games
			 * run longer — so it is reported as a status, not in red. Red is for something the
			 * player has to act on.
			 *
			 * `error` status is excluded because the fault list above already renders that message
			 * with the thing to do about it; printing it twice reads as two problems.
			 */}
			{gem.error !== null && gem.status !== "error" && (
				<div className={gem.status === "reconnecting" ? "csk-screen__warn" : "csk-screen__err"}>
					{gem.error}
				</div>
			)}

			{share.sharing && (
				<div className="csk-screen__controls">
					{gem.status === "live" || gem.status === "reconnecting" ?
						<button
							className="btn"
							onClick={() => {
								setStoppedByHand(true)
								gem.stop()
							}}
						>
							Stop coaching
						</button>
					:	<button
							className="btn btn-primary"
							/*
							 * Disabled off a game, because pressing it would connect and then be shut
							 * straight back down by the gate — a button that visibly undoes itself is
							 * worse than one that plainly cannot be pressed yet. The title says when it
							 * comes back, so "disabled" never has to be guessed at.
							 */
							disabled={gem.status === "connecting" || !gate.armed}
							title={
								gate.armed ? undefined : (
									"She starts herself at champion select — there's nothing to coach yet."
								)
							}
							onClick={() => {
								gem.unlockAudio()
								setStoppedByHand(false)
								void gem.start()
							}}
						>
							{gem.status === "connecting" ?
								"Connecting…"
							: gate.armed ?
								"Start coaching"
							:	"Starts at champ select"}
						</button>
					}

					{/*
					 * The blind-check-in count moved UP into the fault list, beside the frozen-stream
					 * and dead-stream counts it belongs with — it was the only one of the three that
					 * had a message, and reading it alone made a stopped share look like a coach
					 * that had merely lost sight of the game for a moment.
					 */}
					{gem.audioBlocked && (
						<button className="csk-screen__unmute" onClick={() => gem.unlockAudio()}>
							🔇 Your browser is holding the sound back — click to let her talk
						</button>
					)}

					{/*
					 * The interval picker is only shown for the modes that HAVE an interval.
					 *
					 * Under `trusted` the coach is asked when the game moves — a death, an
					 * objective, a fight resolving, a level that unlocks something — with a
					 * 90-second floor under silence. Leaving a "checks in every 6s" control on
					 * screen there would be a lie about how the shipped coach works, and one the
					 * player would reasonably act on when she seemed too quiet.
					 */}
					{coachMode !== "trusted" && (
						<>
							<span className="csk-screen__label">Checks in every</span>
							{TURN_CHOICES.map(sec => (
								<button
									key={sec}
									className={`csk-screen__int ${gem.turnMs === sec * 1000 ? "on" : ""}`}
									onClick={() => gem.setTurnMs(sec * 1000)}
								>
									{sec}s
								</button>
							))}
						</>
					)}

					{(gem.status === "live" || gem.status === "reconnecting") && (
						<button
							className={`csk-screen__int ${gem.micOn ? "on" : ""}`}
							onClick={() => void gem.setMic(!gem.micOn)}
							title={gem.micOn ? "Microphone is on — she can hear you" : "Turn on the mic to talk to her"}
						>
							{gem.micOn ? "🎙 mic on" : "🎙 mic off"}
						</button>
					)}
					{/*
					 * The running total, while it runs. This streams video continuously and bills
					 * per image, so finding out afterwards is the wrong time. Tokens rather than
					 * dollars: the rate is Google's to change, and a price quoted from memory is
					 * exactly the kind of confident-sounding number this app exists not to make.
					 */}
					{gem.status === "live" && (
						<span className="csk-screen__meter">
							{/*
							 * Not "listening": that sat directly beside "🎙 mic off" and flatly
							 * contradicted it. She is watching the screen; the mic is a separate
							 * thing the player controls and can see the state of.
							 */}
							watching · {gem.usage.turns} check-in{gem.usage.turns === 1 ? "" : "s"}
							{gem.usage.totalTokens > 0 ?
								` · ${Math.round(gem.usage.totalTokens / 1000)}k tokens`
							:	""}
							{/*
							 * WHY she was last asked, when there is an event schedule to explain.
							 *
							 * An event-driven coach that has said nothing for a minute is
							 * indistinguishable on screen from one that has broken, and that
							 * ambiguity is what gets a working feature switched off. This is the
							 * one line that tells them apart. It is panel copy and never reaches
							 * the model.
							 */}
							{coachMode === "trusted" && gem.lastAsk !== null ?
								` · asked on ${gem.lastAsk.slice(0, 60)}`
							:	""}
						</span>
					)}
					{/*
					 * Said plainly, because it is routine: the session credential lasts about
					 * half an hour and games run longer, so a reconnect mid-game is expected
					 * rather than a fault.
					 */}
					{gem.status === "reconnecting" && (
						<span className="csk-screen__meter">reconnecting…</span>
					)}
				</div>
			)}

			{(gem.status === "live" || gem.status === "reconnecting") && (
				<form
					className="csk-screen__ask"
					onSubmit={e => {
						e.preventDefault()
						gem.ask(question)
						setQuestion("")
					}}
				>
					<input
						value={question}
						onChange={e => setQuestion(e.target.value)}
						placeholder="Ask her anything — “what should I be doing right now?”"
					/>
					<button className="btn" type="submit">
						Ask
					</button>
				</form>
			)}

			{gem.status === "live" && gem.lines.length === 0 && (
				<div className="csk-screen__quiet">
					Listening. She'll speak up when something's worth saying — quiet is normal.
				</div>
			)}

			{gem.lines.length > 0 && (
				<ul className="csk-screen__log">
					{gem.lines.map(l => (
						<li key={`${l.atMs}-${l.text.slice(0, 12)}`}>
							<span className="t">{fmtTime(l.atMs)}</span>
							<span className="s">
								{l.fromUser ? <b>you: </b> : <b className="who">Coach Lillia: </b>}
								{l.text}
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	)
}
