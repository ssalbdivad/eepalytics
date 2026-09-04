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
 * It is also not continuous, and says so: a vision call takes ten to thirty seconds, so this
 * glances periodically. Calling it "live analysis" would set an expectation the thing cannot meet.
 */

import { useScreenCoach } from "../lib/screenCoach.ts"
import "./components.css"

const INTERVALS = [15, 30, 60, 120]

/**
 * Pre-start estimate only; the real measured cost replaces it after the first glance.
 *
 * 0.012 rather than a rounder guess because a real call was measured at $0.0159 on a large PNG.
 * A frame from this hook is downscaled JPEG and cheaper, but quoting an optimistic number for
 * something that spends money every thirty seconds is the wrong direction to be wrong in.
 */
const ESTIMATE_PER_CALL = 0.012

const fmtTime = (ms: number): string =>
	new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })

export const ScreenCoach = () => {
	const coach = useScreenCoach()
	const perCall = coach.calls > 0 ? coach.spent / coach.calls : ESTIMATE_PER_CALL
	const perHour = (3600 / coach.intervalSec) * perCall

	return (
		<div className="csk-screen">
			<div className="csk-screen__head">
				<div>
					<strong>Watch my screen</strong>
					<p>
						The coach glances at your screen every {coach.intervalSec}s and says something only
						when it is worth interrupting you. It is not continuous — a look takes 10–30
						seconds.
					</p>
				</div>
				{coach.sharing ?
					<button className="btn" onClick={coach.stop}>
						Stop
					</button>
				:	<button className="btn btn-primary" onClick={() => void coach.start()}>
						Start
					</button>
				}
			</div>

			{!coach.sharing && (
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

			{coach.sharing && coach.observations.length === 0 && (
				<div className="csk-screen__quiet">
					Nothing worth saying yet. That is the normal state — most of a game does not need a
					coach talking over it.
				</div>
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
