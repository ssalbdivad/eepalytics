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

interface KeyStatus {
	configured: boolean
	ok: boolean
	error?: string | null
	hint?: string
}

export const ScreenCoach = () => {
	const share = useScreenShare()
	const [opening, setOpening] = useState(false)
	const wsl = isWslElectron()

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
	 * The ground-truth block, polled so the socket can forward it synchronously on each turn. It
	 * is computed by the daemon from the League client — the roster, who is dead and for how long,
	 * the score, farm against his own average — and it is the reason the coach stopped inventing
	 * things.
	 */
	const truthRef = useRef("")
	useEffect(() => {
		if (!share.sharing) return
		let alive = true
		const pull = async () => {
			try {
				const r = await fetch("/api/live/ground-truth")
				const j = (await r.json()) as { text?: string }
				if (alive) truthRef.current = j.text ?? ""
			} catch {
				/* the client being closed must not break the page */
			}
		}
		void pull()
		const id = setInterval(() => void pull(), 5000)
		return () => {
			alive = false
			clearInterval(id)
		}
	}, [share.sharing])

	const gem = useGeminiLive({
		groundTruth: () =>
			truthRef.current === "" ?
				"No live game data right now — he is not in a game, or the client is closed. Say nothing (PASS) unless the screen clearly shows something worth saying."
			:	truthRef.current,
		grabFrame: share.grabFrame
	})

	const [question, setQuestion] = useState("")

	// The socket must not outlive the screen share that feeds it.
	useEffect(() => {
		if (!share.sharing && gem.status !== "off") gem.stop()
	}, [share.sharing, gem])

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

	return (
		<div className="csk-screen">
			<div className="csk-screen__head">
				<div>
					<strong>Coach me while I play</strong>
					<p>
						She watches your shared screen and talks to you out loud — about half a second
						behind. She stays quiet unless she has something worth saying.
					</p>
				</div>
				{share.sharing ?
					<button className="btn" onClick={share.stop}>
						Stop sharing
					</button>
				:	<button
						className="btn btn-primary"
						disabled={opening || needsKey}
						// On WSL, sharing here can only ever capture WSL's own windows, so this hands
						// off to the Windows browser rather than opening a picker that cannot show
						// League. One press, no second decision.
						onClick={() => void (wsl ? openInWindows() : share.start())}
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
							and sign in with any Google account.
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
					{keyStatus?.configured && keyStatus.error && (
						<div className="csk-screen__err">That key did not work: {keyStatus.error}</div>
					)}
					<p className="csk-screen__fine">
						The key stays on this machine. The page never sees it — the app swaps it for a
						token that works for one session and then expires.
						<br />
						There is no "sign in with Google" for this: the live API takes a key, and a
						Gemini subscription does not include API access.
					</p>
				</div>
			)}

			{wsl && !share.sharing && (
				<div className="csk-screen__blocked">
					<strong>This will open in your Windows browser.</strong>
					<p>
						This window runs inside WSL, so the only screens it can see are WSL's own — not
						the Windows desktop, and not the game. Your Windows browser is a Windows app, so
						it can see the game, and it still talks to this daemon.
					</p>
				</div>
			)}

			{!wsl && !share.sharing && !needsKey && (
				<div className="csk-screen__warn">
					Your shared screen is sent to Google continuously while this is running, and your
					microphone is off until you turn it on.
				</div>
			)}

			{share.error !== null && <div className="csk-screen__err">{share.error}</div>}
			{gem.error !== null && <div className="csk-screen__err">{gem.error}</div>}

			{share.sharing && (
				<div className="csk-screen__controls">
					{gem.status === "live" ?
						<button className="btn" onClick={gem.stop}>
							Stop coaching
						</button>
					:	<button
							className="btn btn-primary"
							disabled={gem.status === "connecting"}
							onClick={() => void gem.start()}
						>
							{gem.status === "connecting" ? "Connecting…" : "Start coaching"}
						</button>
					}

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

					{gem.status === "live" && (
						<button
							className={`csk-screen__int ${gem.micOn ? "on" : ""}`}
							onClick={() => void gem.setMic(!gem.micOn)}
							title={gem.micOn ? "Microphone is on — she can hear you" : "Turn on the mic to talk to her"}
						>
							{gem.micOn ? "🎙 mic on" : "🎙 mic off"}
						</button>
					)}
					{gem.status === "live" && <span className="csk-screen__meter">listening</span>}
				</div>
			)}

			{gem.status === "live" && (
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
						placeholder="Ask her something — “should I take this drake?”"
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
