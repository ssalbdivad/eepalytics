/**
 * The live coach: your own numbers while a game is running.
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

import { useCallback, useEffect, useState } from "react"
import type { LiveResponse } from "../../shared/schema/api.ts"
import { api } from "../lib/api.ts"
import { armedHeadline, useGameflow } from "../lib/gameflow.ts"
import { categoryLabel } from "../lib/format.ts"
import { ScreenCoach } from "../components/ScreenCoach.tsx"
import { LiveTranscript } from "../components/LiveTranscript.tsx"
import { Debrief } from "../components/Debrief.tsx"

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

export const Live = () => {
	/**
	 * The debrief he has closed, keyed by when the game ended.
	 *
	 * Mirrored to the daemon rather than kept here alone: he closes it, alt-tabs, and a dismissal
	 * that only lived in this component would come back with the next window.
	 */
	const [closed, setClosed] = useState<number | null>(null)
	const [data, setData] = useState<LiveResponse | null>(null)
	const [err, setErr] = useState<string | null>(null)
	const size = useSize()
	/*
	 * Shared with `<ScreenCoach>` through one refcounted poller, so the header and the coach panel
	 * cannot disagree about whether a game is starting. They used to: :2999 says "no game" right
	 * through champion select, so the header read "Not in a game" while the coach below it was
	 * already arming.
	 */
	const gate = useGameflow()
	/** Non-null through champion select and the loading screen — the window :2999 cannot see. */
	const starting = armedHeadline(gate)

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

	/*
	 * ONE tree, always the same shape.
	 *
	 * There used to be three returns whose children differed structurally, so React reconciled by
	 * index and unmounted `<ScreenCoach>` on the idle -> in-game flip. That tore down the screen
	 * share and closed the Gemini socket at the exact moment the game started — the coach died
	 * the instant it became useful, and re-arming it needed a fresh screen-picker.
	 *
	 * The body varies; the coach's position in the tree does not.
	 */
	const dismiss = useCallback((endedAtMs: number) => {
		setClosed(endedAtMs)
		// A failed request costs nothing worse than the panel returning on the next poll, which is
		// honest — not worth an error banner over a running game.
		void api.dismissDebrief(endedAtMs).catch(() => {})
	}, [])

	/*
	 * A game that just finished outranks everything else on the idle screen: the focus list is
	 * about the last twenty games and will still be there in a minute, while the debrief is about
	 * the game whose scoreboard he is looking at right now.
	 */
	const ended =
		(
			data?.justEnded &&
			data.justEnded.endedAtMs !== closed &&
			/*
			 * The next game outranks the last one. `inGame` stays false right through queue and
			 * champion select, and the marker is only replaced when the NEXT game ENDS — so
			 * without this an un-dismissed debrief owned this screen through the whole of the
			 * next draft, hiding the champ-select headline for the game he is about to play.
			 */
			starting === null
		) ?
			data.justEnded
		:	null

	const body =
		!data ?
			<div className="live__content">
				<div className="live__idle">
					<strong>connecting…</strong>
					{/*
					 * The error used to render only after `data` arrived, so a daemon that was down
					 * left this screen saying "connecting…" forever with the reason held in state
					 * and never shown. If the first poll failed, say so here.
					 */}
					{err !== null && (
						<span>
							Can't reach eepalytics: {err}. Is the daemon running?
						</span>
					)}
				</div>
			</div>
		: !data.inGame ?
			<div className="live__content">
				{/*
				 * The idle screen used to render the same tiny block at every size, so a second
				 * monitor showed one paragraph in the top-left corner and 1800px of nothing.
				 * Idle is most of the time this window is open — it has to be worth looking at.
				 */}
				{/*
				 * Window controls on the idle screen too.
				 *
				 * They only existed on the in-game bar, so the screen a new user actually meets
				 * first — "Not in a game" — offered no way to close the window or grow it, in a
				 * frameless shell that provides no chrome of its own.
				 */}
				<div className="live__idlewrap">
					{ended ?
						ended.stage === "stored" && ended.gameId !== null ?
							<Debrief
								gameId={ended.gameId}
								size={size}
								championName={ended.championName}
								win={ended.win}
								onDismiss={() => dismiss(ended.endedAtMs)}
							/>
						:	<Ingesting endedAtMs={ended.endedAtMs} onDismiss={() => dismiss(ended.endedAtMs)} />
					:	<div className="live__idle">
						<img className="live__mark" src="/icons/icon-128.png" alt="" width={size === "wide" ? 44 : 22} height={size === "wide" ? 44 : 22} />
						<strong>{starting ?? "Not in a game"}</strong>
						<span>
							{starting !== null ?
								"Your numbers appear as soon as the game clock starts."
							:	(data.reason ?? "waiting")}
						</span>
						</div>
					}

					{/*
					 * The standing focus list is about the last twenty games and can wait; in the
					 * 380px window it would stack under the debrief and push it off-screen.
					 */}
					{data.focus && data.focus.length > 0 && !(ended && size === "compact") && (
						<div className="live__bigfocus">
							<div className="live__focus-head">What to work on</div>
							<ol>
								{data.focus.map(f => (
									<li key={f.category}>
										<b>{categoryLabel(f.category)}</b>
										<span>{f.fix}</span>
										<em>seen in {f.games} of your recent games</em>
									</li>
								))}
							</ol>
						</div>
					)}
				</div>
			</div>
		:	<div className="live__content">
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
					{/*
					 * Farm against his own history, always on screen rather than only when it is
					 * bad enough to trigger an alert — this is the number he wants to glance at
					 * from another monitor. `exact` is false between the checkpoints where a
					 * baseline was actually measured, and the label says so rather than
					 * presenting an extrapolation as a reading.
					 */}
					{size === "wide" && data.pace && (
						<div className={`live__pace ${data.pace.cs < data.pace.expected * 0.85 ? "behind" : ""}`}>
							<div className="live__pace-nums">
								<span className="now">{data.pace.cs}</span>
								<span className="sep">/</span>
								<span className="exp">{data.pace.expected}</span>
							</div>
							<div className="live__pace-label">
								CS · you vs {data.pace.exact ? "your average here" : "your usual rate"}
								<em title={data.pace.source}>
									{data.pace.exact ? "measured at this minute" : "approximate between checkpoints"}
								</em>
							</div>
						</div>
					)}

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
								<b>{categoryLabel(f.category)}</b>
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

			</div>

	return (
		<div className={`live live--${size}`}>
			{body}
			{/*
			 * HIDDEN in compact, never unmounted.
			 *
			 * The old `size === "wide" && <ScreenCoach />` meant pressing the collapse button —
			 * advertised as "grow onto a second monitor" — ended the coaching session. `display:
			 * none` keeps the socket open and the audio playing, which is what you want from a
			 * voice coach in a 380px window.
			 */}
			{/*
			 * Always mounted, at a fixed position in the tree. Compact renders a one-line strip
			 * rather than nothing: 700px is the width this page is commonly first seen at, and hiding the
			 * flagship feature at the size a new user first meets it is not a layout decision.
			 */}
			<div className="live__coach">
				<ScreenCoach
					compact={size !== "wide"}
				/>
				{size === "wide" && <LiveTranscript />}
			</div>

			{err !== null && <div className="live__err">{err}</div>}
		</div>
	)
}

/**
 * The gap between the game ending and the match existing.
 *
 * The client publishes a finished game to match history on its own schedule, so there is a real
 * window — usually seconds — where the only honest thing to show is that we are fetching. Saying
 * that beats an empty panel: the screen he described was one that looked broken while working.
 */
const Ingesting = ({ endedAtMs, onDismiss }: { endedAtMs: number; onDismiss: () => void }) => (
	<div className="csk-debrief csk-debrief--compact">
		<div className="csk-debrief__head">
			<img className="live__mark" src="/icons/icon-128.png" alt="" width={32} height={32} />
			<div className="csk-debrief__who">
				<strong>Game over</strong>
				<span className="csk-debrief__line">
					<span className="dim">pulling the match out of the client — this fills in on its own</span>
				</span>
			</div>
			<button className="csk-debrief__close" onClick={onDismiss} title="Close this debrief">
				✕
			</button>
		</div>
		<div className="csk-debrief__waiting">
			<div className="skeleton" style={{ height: 14, marginBottom: 8 }} />
			<div className="skeleton" style={{ height: 40 }} />
			<span className="dim">
				ended {new Date(endedAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
			</span>
		</div>
	</div>
)
