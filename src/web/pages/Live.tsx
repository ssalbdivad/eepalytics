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

/**
 * Which layout to draw.
 *
 * The small window and a second-monitor window want opposite things: one is glanced at for a
 * second over a running game, the other is looked at properly and has room to breathe. Same
 * data, genuinely different presentation — so this is a layout decision, not a font-size tweak.
 */
const useSize = (): "compact" | "wide" => {
	const [size, setSize] = useState<"compact" | "wide">(() =>
		typeof window === "undefined" || window.innerWidth < 700 ? "compact" : "wide"
	)
	useEffect(() => {
		const onResize = () => setSize(window.innerWidth < 700 ? "compact" : "wide")
		window.addEventListener("resize", onResize)
		return () => window.removeEventListener("resize", onResize)
	}, [])
	return size
}

/** Frameless window, so the page provides its own controls. */
const sendToShell = (channel: string): void => {
	const ipc = (window as { electron?: { ipcRenderer?: { send: (c: string) => void } } }).electron
	if (ipc?.ipcRenderer) ipc.ipcRenderer.send(channel)
	// In a browser tab there is no shell to talk to; the buttons simply do nothing rather than
	// throwing, because the same page is served to both.
}

export const Live = () => {
	const [data, setData] = useState<LiveResponse | null>(null)
	const [err, setErr] = useState<string | null>(null)
	const size = useSize()

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
			<div className={`live live--${size}`}>
				<div className="live__idle">connecting…</div>
			</div>
		)

	if (!data.inGame)
		return (
			<div className={`live live--${size}`}>
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
		<div className={`live live--${size}`}>
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
				<span className="live__controls">
					<button
						onClick={() => sendToShell("overlay:toggle-size")}
						title="Grow onto a second monitor, or shrink back to a corner window (Ctrl+Shift+F)"
					>
						{size === "wide" ? "▾" : "▴"}
					</button>
					<button onClick={() => sendToShell("overlay:close")} title="Close (Ctrl+Shift+L)">
						✕
					</button>
				</span>
			</div>

			<div className="live__cols">
				<div className="live__main">
					{data.nudges.length > 0 ?
						<ul className="live__nudges">
							{data.nudges.map(n => (
								<li
									key={n.text}
									className={`live__nudge live__nudge--${n.kind}`}
									title={n.source}
								>
									<span className="live__icon">{KIND_ICON[n.kind] ?? "•"}</span>
									<span className="live__nudge-text">{n.text}</span>
									{/* Where it came from, shown rather than hidden in a tooltip once
									    there is room for it — nothing on screen unattributable. */}
									{size === "wide" && <span className="live__nudge-src">{n.source}</span>}
								</li>
							))}
						</ul>
					:	<div className="live__quiet">
							{/* Silence is a real answer. See the file header. */}
							{size === "wide" ?
								"Nothing worth saying right now — that's a good sign. Keep clearing."
							:	"Nothing worth saying right now."}
						</div>
					}

					{/*
					 * Big numbers, wide mode only.
					 *
					 * Most of a game has nothing urgent to say, which on a monitor left three
					 * quarters of the screen empty. These are the figures worth having glanceable
					 * from across a desk, and they are plain readings — no derived pace estimate
					 * between the checkpoints where a baseline actually exists.
					 */}
					{size === "wide" && data.score && (
						<div className="live__stats">
							<div className="live__stat">
								<span className="v">{data.score.cs}</span>
								<span className="k">CS</span>
							</div>
							<div className="live__stat">
								<span className={`v ${data.score.deaths >= 3 ? "warn" : ""}`}>
									{data.score.deaths}
								</span>
								<span className="k">deaths</span>
							</div>
							<div className="live__stat">
								<span className="v">{data.score.level}</span>
								<span className="k">level</span>
							</div>
							<div className="live__stat">
								<span className="v">
									{data.score.kills}/{data.score.assists}
								</span>
								<span className="k">kills / assists</span>
							</div>
						</div>
					)}
				</div>

				{data.focus && data.focus.length > 0 && (
					<div
						className={`live__focus ${size === "wide" ? "" : "live__focus--compact"}`}
					>
						{size === "wide" && <div className="live__focus-head">Your focus this week</div>}
						{(size === "wide" ? data.focus : data.focus.slice(0, 2)).map(f => (
							<div key={f.category} className="live__focus-row">
								<b>{f.category}</b>
								<span>{f.fix}</span>
								{size === "wide" && (
									<em>
										{f.games} game{f.games === 1 ? "" : "s"}
									</em>
								)}
							</div>
						))}
					</div>
				)}
			</div>

			{err !== null && <div className="live__err">{err}</div>}
		</div>
	)
}
