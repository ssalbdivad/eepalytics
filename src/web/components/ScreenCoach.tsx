/**
 * Live screen coaching controls and output.
 *
 * Two things are stated before it starts rather than discovered afterwards:
 *
 *   - **Frames leave the machine.** A screenshot of the shared screen goes to Anthropic on every
 *     glance. Someone should decide that knowingly, not find out later.
 *   - **It costs money per glance.** The interval IS the cost, so the interval is a control and
 *     the running total is on screen while it runs.
 *
 * It is also not continuous, and says so: a vision call takes about three to four seconds, so
 * this glances periodically. Calling it "live analysis" would set an expectation it cannot meet.
 */

import { useState } from "react"
import { useScreenCoach } from "../lib/screenCoach.ts"
import "./components.css"

const INTERVALS = [15, 30, 60, 120]


/**
 * Pre-start estimate only; the real measured cost replaces it after the first glance.
 *
 * Measured, not guessed: $0.0090 per glance across four consecutive calls on a real 1024px game
 * frame with this prompt. Rounded up rather than down — quoting an optimistic number for
 * something that spends money every fifteen seconds is the wrong direction to be wrong in.
 */
const ESTIMATE_PER_CALL = 0.009

const fmtTime = (ms: number): string =>
	new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })

/**
 * Is this the Electron app running inside WSL?
 *
 * Screen sharing cannot work there. Electron runs under WSLg, whose compositor contains only
 * Linux windows — enumerated live, it sees three WSLg virtual screens and exactly one window,
 * its own. League is a Windows process and is simply not visible to it. This is a boundary of
 * where the renderer is running, not a permission that can be granted.
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

export const ScreenCoach = () => {
	const coach = useScreenCoach()
	const [opening, setOpening] = useState(false)
	const wsl = isWslElectron()

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
	const perCall = coach.calls > 0 ? coach.spent / coach.calls : ESTIMATE_PER_CALL
	const perHour = (3600 / coach.intervalSec) * perCall

	return (
		<div className="csk-screen">
			<div className="csk-screen__head">
				<div>
					<strong>Watch my screen</strong>
					<p>
						The coach looks at your screen every {coach.intervalSec}s and says something every
						time — a warning if you need one, hype if you earned it, otherwise whatever it
						can actually see. Each look takes about 3 seconds, so the interval is the
						cost.
					</p>
				</div>
				{coach.sharing ?
					<button className="btn" onClick={coach.stop}>
						Stop
					</button>
				:	<button
						className="btn btn-primary"
						disabled={opening}
						// On WSL, sharing here can only ever capture WSL's own windows, so Start
						// hands off to the Windows browser rather than starting something that
						// cannot work. One press, no second decision to make.
						onClick={() => void (wsl ? openInWindows() : coach.start())}
					>
						{opening ? "Opening…" : "Start"}
					</button>
				}
			</div>

			{/*
			 * Stated before the Start button, because pressing it here would open a picker
			 * listing only Linux windows and then quietly coach a screenshot of this app.
			 */}
			{wsl && (
				<div className="csk-screen__blocked">
					<strong>Start will open this in your Windows browser.</strong>
					<p>
						This window runs inside WSL, so the only screens it can see are WSL's own — not
						the Windows desktop, and not the game. Your Windows browser is a Windows app, so
						it can see the game, and it still talks to this daemon. Pressing Start takes you
						there instead of opening a picker that couldn't show League.
					</p>
					{opening && <span className="csk-screen__opening">Opening Windows…</span>}
				</div>
			)}

			{!wsl && !coach.sharing && (
				<div className="csk-screen__warn">
					A screenshot of the screen you share is sent to Anthropic on every glance, and the
					daemon deletes each one straight after. Roughly{" "}
					<b>${perHour.toFixed(2)}/hour</b> at this interval
					{coach.calls === 0 ? " (estimated)" : ""}.
				</div>
			)}

			<div className="csk-screen__controls">
				<span className="csk-screen__label">Every</span>
				{INTERVALS.map(sec => (
					<button
						key={sec}
						className={`csk-screen__int ${coach.intervalSec === sec ? "on" : ""}`}
						onClick={() => coach.setInterval(sec)}
						title={`About $${(((3600 / sec) * perCall)).toFixed(2)} per hour`}
					>
						{sec}s
					</button>
				))}
				<label className="csk-screen__tts">
					<input
						type="checkbox"
						checked={coach.speak}
						onChange={e => coach.setSpeak(e.target.checked)}
					/>
					Read aloud
				</label>
				{coach.sharing && (
					<span className="csk-screen__meter">
						{coach.busy ? "looking…" : "watching"} · {coach.calls} glance
						{coach.calls === 1 ? "" : "s"} · ${coach.spent.toFixed(3)}
					</span>
				)}
			</div>

			{coach.error !== null && <div className="csk-screen__err">{coach.error}</div>}

			{/*
			  * Only ever shown before the first answer lands. The coach speaks on every glance
			  * now, so an empty log past that point means something is wrong rather than quiet —
			  * and `coach.error` is what says so.
			  */}
			{coach.sharing && coach.observations.length === 0 && (
				<div className="csk-screen__quiet">Looking at your screen…</div>
			)}

			{coach.observations.length > 0 && (
				<ul className="csk-screen__log">
					{coach.observations.map(o => (
						<li key={o.atMs}>
							<span className="t">{fmtTime(o.atMs)}</span>
							<span className="s">{o.text}</span>
						</li>
					))}
				</ul>
			)}
		</div>
	)
}
