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
 *   - **Frames leave the machine.** The shared screen goes to Google, continuously.
 *   - **The microphone is off until pressed**, and says so.
 *   - **It needs a key**, which is free, and the instructions for getting one are right here
 *     rather than in a doc — a setup step you cannot complete is the same as a broken feature.
 */

import { useEffect, useRef, useState } from "react"
import { useGeminiLive } from "../lib/geminiLive.ts"
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
	 * The panel used to be dropped entirely below 700px, which is the width the overlay window
	 * opens at, so the app's flagship feature was invisible exactly where a new user first meets
	 * it. The component stays mounted either way: unmounting closes the socket and stops the
	 * screen share, so a session must survive being collapsed.
	 */
	compact?: boolean
	/** Ask the shell to grow the overlay. Only meaningful in the Electron window. */
	onExpand?: () => void
}

export const ScreenCoach = ({ compact = false, onExpand }: ScreenCoachProps) => {
	const share = useScreenShare()
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
	 * The journal: one frame every 5s while the screen is shared.
	 *
	 * Deliberately NOT tied to the Gemini coach. Sharing the screen is what earns a graded review
	 * after the game; the live voice is an optional extra on top. Tying them would mean paying for
	 * an API to get a review that costs nothing.
	 *
	 * The daemon stamps the game clock and refuses anything it cannot place, so this loop needs to
	 * know nothing about whether a game is running.
	 */
	useEffect(() => {
		if (!share.sharing) return
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
				if (alive && j.ok) setJournal(p => ({ frames: (p?.frames ?? 0) + 1, sessionId: j.sessionId ?? null }))
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
	}, [share.sharing, share.grabFrame])

	const gem = useGeminiLive({
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
			return "No live game data right now — he is not in a game, or the client is closed. Say nothing (PASS) unless the screen clearly shows something worth saying."
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

	/*
	 * Coaching starts on its own once the screen is shared.
	 *
	 * Sharing is already the deliberate act — a second button to press before anything happens is
	 * a step that exists only because the two things were built separately. It waits on a key that
	 * actually works, so it can never spend money on a connection that was going to fail.
	 */
	useEffect(() => {
		if (!share.sharing || stoppedByHand) return
		if (keyStatus === null || !keyStatus.ok) return
		if (gem.status !== "off") return
		void gem.start()
	}, [share.sharing, stoppedByHand, keyStatus, gem])

	// The socket must not outlive the screen share that feeds it.
	useEffect(() => {
		if (!share.sharing && gem.status !== "off") gem.stop()
		// A fresh share is a fresh intention: the last session's stop should not linger.
		if (!share.sharing && stoppedByHand) setStoppedByHand(false)
	}, [share.sharing, gem, stoppedByHand])

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

	if (compact)
		return (
			<div className="csk-screen csk-screen--compact">
				<span className="csk-screen__dot" data-state={gem.status} />
				<span className="csk-screen__compactlabel">
					{gem.status === "live" ?
						`Coaching · ${gem.usage.turns} check-in${gem.usage.turns === 1 ? "" : "s"}`
					: gem.status === "reconnecting" ?
						"Coach reconnecting…"
					: share.sharing ?
						"Screen shared — not coaching yet"
					: needsKey ?
						"Live coach needs a key"
					:	"Live coach"}
				</span>
				{onExpand && (
					<button className="btn" onClick={onExpand}>
						Open
					</button>
				)}
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
					<strong>fawnsei will coach you out loud</strong>
					<p>
						Share your screen and she watches it while you play, talking to you about a
						second behind. She stays quiet unless she has something worth saying — most of
						the time she says nothing, and that is on purpose.
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
							you a password that lets fawnsei talk to their voice model.
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
						Your key stays on this computer — this page never sees it. fawnsei swaps it for a
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
						fawnsei running here — so nothing is lost by moving over.
					</p>
				</div>
			)}

			{!wsl && !share.sharing && !needsKey && (
				<div className="csk-screen__warn">
					Your shared screen is sent to Google about twice a second while this is running,
					and it is billed per frame — the running total shows while it's on. Your
					microphone stays off until you turn it on.
				</div>
			)}

			{!truthOk && gem.status === "live" && (
				<div className="csk-screen__warn">
					Can't reach the game data right now, so she's going on the picture alone — she'll be
					vaguer until it comes back.
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
					<b>{gem.unsaved}</b> line{gem.unsaved === 1 ? "" : "s"} couldn't be saved to fawnsei,
					so {gem.unsaved === 1 ? "it is" : "they are"} only here — they won't appear in "What
					she said, earlier" after the game. Check the daemon is still running.
				</div>
			)}
			{/*
			  * The journal's own line, shown whenever the screen is shared.
			  *
			  * This is the whole difference from the feature it replaces: replay capture ran for
			  * the app's entire life without ever completing once, and nothing on screen ever said
			  * so. A frame count is checkable; "it's working" is not.
			  */}
			{share.sharing && (
				<div className={journal && journal.frames > 0 ? "csk-screen__journal on" : "csk-screen__journal"}>
					{journal && journal.frames > 0 ?
						<>
							<b>Recording this game.</b> {journal.frames} frame
							{journal.frames === 1 ? "" : "s"} saved — enough of them and this game gets graded
							afterwards.
						</>
					:	<>
							Not recording yet. Frames are only saved during a real game, so nothing is stored
							in champ select, in a custom, or on your desktop.
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
							disabled={gem.status === "connecting"}
							onClick={() => {
								gem.unlockAudio()
								setStoppedByHand(false)
								void gem.start()
							}}
						>
							{gem.status === "connecting" ? "Connecting…" : "Start coaching"}
						</button>
					}

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
								{l.fromUser ? <b>you: </b> : null}
								{l.text}
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	)
}
