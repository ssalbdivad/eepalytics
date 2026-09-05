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
import { useGameflow, standbyReason } from "../lib/gameflow.ts"
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

/** How often she is invited to speak. She stays quiet unless she has something. */
const TURN_CHOICES = [10, 20, 40]

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
	const wsl = isWslElectron()

	/** False once a ground-truth fetch has failed; see `groundTruth` below. */
	const [truthOk, setTruthOk] = useState(true)
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

	useEffect(() => {
		void (async () => {
			try {
				const r = await fetch("/api/live/gemini/status")
				setKeyStatus((await r.json()) as KeyStatus)
			} catch {
				setKeyStatus({ configured: false, ok: false, error: "could not reach the daemon" })
			}
		})()
	}, [])

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
			const frame = share.grabFrame()
			if (frame === null) return
			inFlight = true
			try {
				const r = await fetch("/api/live/journal/frame", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ frame, truth: truthRef.current || undefined })
				})
				const j = (await r.json()) as { ok?: boolean; sessionId?: string | null }
				if (alive && j.ok)
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
				/* a dropped frame is not worth interrupting a game for */
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
		groundTruth: async () => {
			try {
				const r = await fetch("/api/live/ground-truth", { signal: AbortSignal.timeout(4000) })
				const j = (await r.json()) as { inGame?: boolean; text?: string }
				setTruthOk(true)
				if (j.text) {
					truthRef.current = j.text
					return j.text
				}
			} catch {
				/*
				 * Surfaced, not swallowed. Without facts the coach is back to guessing from
				 * pixels, which is the exact failure this whole path was built to end — so the
				 * player is told rather than left with a confident-sounding coach running blind.
				 */
				setTruthOk(false)
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
			return ""
		},
		grabFrame: share.grabFrame
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

	const openInWindows = async () => {
		setOpening(true)
		try {
			await fetch("/api/shell/open-in-windows", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ hash: "#/live" })
			})
		} finally {
			setOpening(false)
		}
	}

	const needsKey = keyStatus !== null && !keyStatus.ok
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
					data-state={standby !== null && gem.status === "off" ? "standby" : gem.status}
				/>
				<span className="csk-screen__compactlabel">
					{gem.status === "live" ?
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

			{!truthOk && (gem.status === "live" || gem.status === "reconnecting") && (
				<div className="csk-screen__warn">
					{/*
					 * She now HOLDS OFF rather than carrying on from the picture, so this line no
					 * longer promises a vaguer coach — it explains a silent one. Saying "she'll be
					 * vaguer" about a coach that has stopped talking is the kind of small lie that
					 * makes someone stop trusting the rest of the panel.
					 */}
					Can't reach the game data right now, so she's holding off rather than guessing from
					the picture. She'll pick straight back up when it returns.
				</div>
			)}
			{/*
			 * The other half of "What she said, earlier" being empty.
			 *
			 * That panel can tell you it failed to READ. Only this side knows whether the lines were
			 * ever WRITTEN, and this list is the only copy of them until they are — so a lost line is
			 * said out loud rather than left to be discovered as a blank transcript after the game.
			 */}
			{gem.unsaved > 0 && (
				<div className="csk-screen__warn">
					<b>{gem.unsaved}</b> line{gem.unsaved === 1 ? "" : "s"} couldn't be saved to eepalytics,
					so {gem.unsaved === 1 ? "it is" : "they are"} only here — they won't appear in "What
					she said, earlier" after the game. Check the daemon is still running.
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
			{share.error !== null && <div className="csk-screen__err">{share.error}</div>}
			{/*
			 * A reconnect is expected — the session credential lasts about half an hour and games
			 * run longer — so it is reported as a status, not in red. Red is for something the
			 * player has to act on.
			 */}
			{gem.error !== null &&
				(gem.status === "reconnecting" ?
					<div className="csk-screen__warn">{gem.error}</div>
				:	<div className="csk-screen__err">{gem.error}</div>)}

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
			 * A coach that cannot see is the failure that looks most like success: it still speaks,
			 * fluently, from the block alone. The player reported exactly that and read it, fairly,
			 * as "it is not looking at the frames at all". It must never be silent again.
			 */}
			{gem.blindTurns > 0 && (
				<div className="csk-screen__warn">
					<b>{gem.blindTurns}</b> check-in{gem.blindTurns === 1 ? " was" : "s were"} sent with{" "}
					<b>no picture</b> — she was coaching from the numbers alone. The screen share is not
					producing frames. Re-share your screen, and pick a display rather than a window.
				</div>
			)}
			{gem.audioBlocked && (
						<button className="csk-screen__unmute" onClick={() => gem.unlockAudio()}>
							🔇 Your browser is holding the sound back — click to let her talk
						</button>
					)}

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
