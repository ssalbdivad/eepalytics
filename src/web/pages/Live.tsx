/**
 * The live overlay: a small always-on-top window for while you are playing.
 *
 * ## Different rules from every other screen
 *
 * This is read in one-second glances with a game running behind it. So: big type, at most three
 * lines that matter, and nothing that needs a click. Everything else in the app can afford to be
 * browsed; this cannot.
 *
 * ## An empty overlay is a correct overlay
 *
 * The strong temptation is to always have something on screen. That is exactly how an overlay
 * becomes wallpaper — if it always says something, none of it gets read. When nothing is
 * genuinely worth saying, this shows the standing focus reminders and stays quiet.
 *
 * ## Nothing here is predicted
 *
 * Objective timers come from takes actually observed in this game's event feed; pace comes from
 * checkpoints where a baseline really exists. Mid-game is the worst place to be confidently
 * wrong — he will act on it immediately and cannot check it.
 */

import { useEffect, useState } from "react"
import type { LiveResponse } from "../../shared/schema/api.ts"
import { api } from "../lib/api.ts"

/** Fast enough to catch an objective window, slow enough to be free. */
const POLL_MS = 3000

const KIND_ICON: Record<string, string> = {
	objective: "◈",
	pace: "▲",
	safety: "⚠",
	habit: "◆",
	praise: "✓"
}

const fmtClock = (sec: number): string =>
	`${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`

export const Live = () => {
	const [data, setData] = useState<LiveResponse | null>(null)
	const [err, setErr] = useState<string | null>(null)

	useEffect(() => {
		let live = true
		const ac = new AbortController()
		const tick = async () => {
			try {
				const next = await api.live(ac.signal)
				if (live) {
					setData(next)
					setErr(null)
				}
			} catch (e) {
				// A dropped poll is normal while the client starts or a game loads. Keep the last
				// good state on screen rather than flashing an error over the game.
				if (live && !ac.signal.aborted) setErr(e instanceof Error ? e.message : String(e))
			}
		}
		void tick()
		const id = setInterval(() => void tick(), POLL_MS)
		return () => {
			live = false
			ac.abort()
			clearInterval(id)
		}
	}, [])

	if (!data)
		return (
			<div className="live">
				<div className="live__idle">connecting…</div>
			</div>
		)

	if (!data.inGame)
		return (
			<div className="live">
				<div className="live__idle">
					<img className="live__mark" src="/icon.svg" alt="" width={22} height={22} />
					<strong>Not in a game</strong>
					<span>{data.reason ?? "waiting"}</span>
				</div>
				{data.focus && data.focus.length > 0 && (
					<div className="live__focus">
						<div className="live__focus-head">This week's focus</div>
						<ol>
							{data.focus.map(f => (
								<li key={f.category}>
									<b>{f.category}</b> {f.fix}
								</li>
							))}
						</ol>
					</div>
				)}
			</div>
		)

	return (
		<div className="live">
			<div className="live__bar">
				<img className="live__mark" src="/icon.svg" alt="" width={20} height={20} />
				<span className="live__clock">{fmtClock(data.gameTimeSec ?? 0)}</span>
				<span className="live__champ">{data.championName}</span>
				{data.score && (
					<span className="live__score">
						{data.score.kills}/{data.score.deaths}/{data.score.assists}
						<em>{data.score.cs} cs</em>
					</span>
				)}
			</div>

			{data.nudges.length > 0 ?
				<ul className="live__nudges">
					{data.nudges.map(n => (
						<li key={n.text} className={`live__nudge live__nudge--${n.kind}`} title={n.source}>
							<span className="live__icon">{KIND_ICON[n.kind] ?? "•"}</span>
							{n.text}
						</li>
					))}
				</ul>
			:	<div className="live__quiet">
					{/* Silence is a real answer. See the file header. */}
					Nothing worth saying right now.
				</div>
			}

			{data.focus && data.focus.length > 0 && (
				<div className="live__focus live__focus--compact">
					{data.focus.slice(0, 2).map(f => (
						<div key={f.category}>
							<b>{f.category}</b> {f.fix}
						</div>
					))}
				</div>
			)}

			{err !== null && <div className="live__err">{err}</div>}
		</div>
	)
}
