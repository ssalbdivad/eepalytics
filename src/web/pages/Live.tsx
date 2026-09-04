/**
 * The live overlay: your own numbers while a game is running.
 *
 * ## What it is, after being cut back
 *
 * A stats display with two exceptions. It shows what you have — CS, deaths, level, K/A, the
 * clock — and it speaks only for two things it can actually stand behind:
 *
 *   - your CS against your OWN measured baseline;
 *   - an objective respawn counted from a take we watched happen.
 *
 * ## What it deliberately does not do
 *
 * It used to say things like "7 deaths already — ahead of your usual pace" with a fix appended
 * from past reviews. That read as situational awareness and was nothing of the sort: nothing
 * here can see positions, cooldowns, lane states or what the team is doing, so the advice was
 * generic history pasted onto a live moment. It was also wrong on its own terms — deaths are not
 * a defect to minimise, some are the correct price of an objective, and a count says nothing
 * about whether these ones bought anything.
 *
 * The rule that replaced it: a live measurement AND a measured comparison, or it is a number on
 * screen with no commentary attached.
 *
 * ## Two sizes, one page
 *
 * Compact (<700px) is glanced at over a running game: clock, stats, at most a couple of lines.
 * Wide is a second monitor and can be read properly — bigger numbers, sources shown rather than
 * hidden in tooltips. Same data, different layout, because those are genuinely different jobs.
 */

import { useEffect, useState } from "react"
import type { LiveResponse } from "../../shared/schema/api.ts"
import { api } from "../lib/api.ts"
import { ScreenCoach } from "../components/ScreenCoach.tsx"

/** Fast enough to catch an objective window, slow enough to be free. */
const POLL_MS = 3000

const KIND_ICON: Record<string, string> = {
	objective: "◈",
	pace: "▲",
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
					<img className="live__mark" src="/icons/icon-128.png" alt="" width={22} height={22} />
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
				<img className="live__mark" src="/icons/icon-128.png" alt="" width={20} height={20} />
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
					{data.score && (
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

			{/*
			 * Wide mode only. The controls need room to state what they cost and what they send,
			 * and burying that in a 380px window would be the wrong place to make that decision.
			 */}
			{size === "wide" && <ScreenCoach />}

			{err !== null && <div className="live__err">{err}</div>}
		</div>
	)
}
