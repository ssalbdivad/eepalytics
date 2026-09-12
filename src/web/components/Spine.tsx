/**
 * THE SPINE — one game as a single object, and the index into everything else on the screen.
 *
 * ## Why a chart is the right thing here and a table is not
 *
 * The debrief's job is that he understands the game before he has decided to read anything.
 * Gold against the enemy jungler over 28 minutes is 30 numbers; as a shape it is one fact —
 * flat for twenty minutes, then a cliff — and it costs no reading at all. Everything else is
 * hung off that same time axis so the marks explain each other: the diamonds above show who
 * took the objectives, the bars below show how long he was dead, and the circled numbers at
 * the bottom say where the three cards point.
 *
 * ## Three decisions that are not taste
 *
 * **The death bars are WIDE, not tall.** Their width is the seconds he spent watching a grey
 * screen, so 188 seconds of it reads as area rather than as a figure nobody internalises. That
 * number is the screen's one estimate (a respawn table, not a measurement) and it is labelled
 * as such wherever it is written out.
 *
 * **No `preserveAspectRatio: none`.** Stretching the viewBox turns every diamond into a sliver
 * and every death bar into a hairline the moment the container is narrower than 860px, which is
 * most phones and the Electron window at its default size.
 *
 * **The card markers sit on their OWN baseline.** They collided with the minute labels in the
 * first draft, and two numbers overlapping at 10px is not a chart, it is a smudge.
 */

import { useState } from "react"
import type { SpineDeath, SpineMinute, SpineObjective, SpineTakedown } from "../../shared/schema/api.ts"
import { fmtClock } from "../../shared/time.ts"
import { fmtDelta } from "../../shared/num.ts"
import "./debrief.css"

/* ------------------------------------------------------------------ geometry */

const W = 860
const H = 176
const PAD_L = 10
const PAD_R = 12
/** Bands, top to bottom: objectives, the gold chart, deaths, card markers, the clock. */
const OBJ_Y = 16
const CHART_TOP = 34
const CHART_BOT = 116
const DEATH_Y = 124
const DEATH_H = 12
const MARK_Y = 150
const CLOCK_Y = 170

export interface SpineMark {
	/** 1, 2, 3 — the card this points at. */
	n: number
	tSec: number
}

export interface SpineProps {
	minutes: readonly SpineMinute[]
	objectives: readonly SpineObjective[]
	deaths: readonly SpineDeath[]
	takedowns: readonly SpineTakedown[]
	durationSec: number
	counterpartName: string | null
	marks?: readonly SpineMark[]
	/** Clicking a mark opens the evidence for that second. */
	onPick?: (tSec: number) => void
}

/** What the hover caption says. Held in state so the sentence renders as TEXT, not as a tooltip
 *  the keyboard can never reach. */
interface Hover {
	clock: string
	text: string
	tone: "for" | "against" | "neutral"
}

export const Spine = ({
	minutes,
	objectives,
	deaths,
	takedowns,
	durationSec,
	counterpartName,
	marks = [],
	onPick
}: SpineProps) => {
	const [hover, setHover] = useState<Hover | null>(null)

	const span = Math.max(durationSec, minutes.at(-1)?.atSec ?? 0, 1)
	const x = (t: number): number => PAD_L + (Math.max(0, Math.min(t, span)) / span) * (W - PAD_L - PAD_R)

	const diffs = minutes.map(m => m.goldDiff)
	const peak = Math.max(1000, ...diffs.map(Math.abs))
	const y = (g: number): number => {
		const mid = (CHART_TOP + CHART_BOT) / 2
		return mid - (g / peak) * ((CHART_BOT - CHART_TOP) / 2)
	}
	const zeroY = y(0)

	const line = minutes.map(m => `${x(m.atSec).toFixed(1)},${y(m.goldDiff).toFixed(1)}`).join(" ")
	const area =
		minutes.length === 0 ?
			""
		:	`${x(minutes[0]!.atSec).toFixed(1)},${zeroY.toFixed(1)} ${line} ${x(minutes.at(-1)!.atSec).toFixed(1)},${zeroY.toFixed(1)}`

	const last = minutes.at(-1)
	const endDiff = last?.goldDiff ?? 0

	/* Minute ticks every five minutes, plus the final clock. More than that is a ruler. */
	const ticks: number[] = []
	for (let t = 300; t < span - 120; t += 300) ticks.push(t)

	return (
		<figure className="spine">
			<svg
				viewBox={`0 0 ${W} ${H}`}
				className="spine__svg"
				role="img"
				aria-label={`Gold against ${counterpartName ?? "the enemy jungler"} over ${fmtClock(span)}, with objectives, deaths and the three cards marked`}
				onMouseLeave={() => setHover(null)}
			>
				{/* zero, and the two words that say which way is up */}
				<line className="spine__zero" x1={PAD_L} x2={W - PAD_R} y1={zeroY} y2={zeroY} />
				<text className="spine__axis" x={PAD_L} y={CHART_TOP - 4}>
					ahead
				</text>
				<text className="spine__axis" x={PAD_L} y={CHART_BOT + 9}>
					behind
				</text>

				{area !== "" && (
					<polygon className={`spine__area ${endDiff < 0 ? "is-against" : "is-for"}`} points={area} />
				)}
				{line !== "" && <polyline className="spine__line" points={line} />}

				{/* his takedowns, on the line — small, because they are context and not the story */}
				{takedowns.map(t => {
					const m = nearest(minutes, t.atSec)
					if (!m) return null
					return (
						<circle
							key={`t-${t.atSec}-${t.victim}`}
							className="spine__td"
							cx={x(t.atSec)}
							cy={y(m.goldDiff)}
							r={t.kind === "kill" ? 3 : 2}
							onMouseEnter={() =>
								setHover({
									clock: t.clock,
									text: `${t.kind === "kill" ? "You killed" : "You assisted on"} ${t.victim}`,
									tone: "for"
								})
							}
						/>
					)
				})}

				{/* objectives: diamond above, stem down to the line */}
				{objectives.map(o => {
					const m = nearest(minutes, o.atSec)
					const cx = x(o.atSec)
					return (
						<g
							key={`o-${o.atSec}-${o.name}`}
							className={`spine__obj ${o.side === "enemy" ? "is-against" : "is-for"}`}
							onMouseEnter={() =>
								setHover({
									clock: o.clock,
									text: `${o.name} — ${o.side === "enemy" ? "taken by" : "yours, taken by"} ${o.takenBy || (o.side === "enemy" ? "the enemy team" : "your team")}`,
									tone: o.side === "enemy" ? "against" : "for"
								})
							}
						>
							{m && <line className="spine__stem" x1={cx} x2={cx} y1={OBJ_Y + 5} y2={y(m.goldDiff)} />}
							<rect
								className="spine__diamond"
								x={cx - 4}
								y={OBJ_Y - 4}
								width={8}
								height={8}
								transform={`rotate(45 ${cx} ${OBJ_Y})`}
							/>
						</g>
					)
				})}

				{/* deaths: width = seconds dead (estimated), so the total reads as area */}
				{deaths.map(d => {
					const w = Math.max(3, (d.downtimeSec / span) * (W - PAD_L - PAD_R))
					return (
						<rect
							key={`d-${d.atSec}`}
							className="spine__death"
							x={x(d.atSec)}
							y={DEATH_Y}
							width={w}
							height={DEATH_H}
							onMouseEnter={() =>
								setHover({
									clock: d.clock,
									text: `Died to ${d.killer || "the map"} in the ${d.zone} — about ${d.downtimeSec}s dead (estimated)`,
									tone: "against"
								})
							}
						/>
					)
				})}

				{/* where the three cards point. Ranked, so they arrive out of order. */}
				{marks.map(mk => (
					<g
						key={`m-${mk.n}`}
						className="spine__mark"
						onMouseEnter={() => setHover({ clock: fmtClock(mk.tSec), text: `Card ${mk.n}`, tone: "neutral" })}
						onClick={() => onPick?.(mk.tSec)}
					>
						<line className="spine__markline" x1={x(mk.tSec)} x2={x(mk.tSec)} y1={CHART_TOP} y2={MARK_Y - 8} />
						<circle cx={x(mk.tSec)} cy={MARK_Y} r={8} />
						<text x={x(mk.tSec)} y={MARK_Y + 3.5} textAnchor="middle">
							{mk.n}
						</text>
					</g>
				))}

				{ticks.map(t => (
					<text key={`c-${t}`} className="spine__clock" x={x(t)} y={CLOCK_Y} textAnchor="middle">
						{fmtClock(t)}
					</text>
				))}
				<text className="spine__clock" x={W - PAD_R} y={CLOCK_Y} textAnchor="end">
					{fmtClock(span)}
				</text>

				{/*
				 * The one number on the chart, parked in the top-right corner rather than on the
				 * line. Anchored to the line it collided with the area fill and the final clock
				 * label at exactly the games where the gap was biggest — which is every game where
				 * the number mattered.
				 */}
				{last && (
					<text
						className={`spine__end ${endDiff < 0 ? "is-against" : "is-for"}`}
						x={W - PAD_R}
						y={CHART_TOP + 2}
						textAnchor="end"
					>
						{fmtDelta(endDiff, "gold")}g
					</text>
				)}
			</svg>

			<figcaption className="spine__cap">
				{hover ?
					<span className={`spine__hover is-${hover.tone}`}>
						<b>{hover.clock}</b> {hover.text}
					</span>
				:	<span className="spine__legend">
						Gold against {counterpartName ?? "the enemy jungler"} · ◆ objectives · ▬ time dead
						(estimated) · ①②③ ranked by impact, not in order
					</span>
				}
			</figcaption>
		</figure>
	)
}

/** The frame nearest a second, for hanging a mark on the line. Never interpolated — a mark
 *  between two frames would be a position nobody measured. */
const nearest = (minutes: readonly SpineMinute[], tSec: number): SpineMinute | null => {
	let best: SpineMinute | null = null
	let gap = Infinity
	for (const m of minutes) {
		const d = Math.abs(m.atSec - tSec)
		if (d < gap) {
			gap = d
			best = m
		}
	}
	return best
}
