/**
 * The race: one quantity, as the DIFFERENCE, for a card whose claim spans minutes.
 *
 * ## Why the difference and not two lines
 *
 * A card that says "you finished 18 CS behind Kayn" is a claim about a gap, and two absolute
 * CS lines are the wrong picture of it: they climb together, look almost identical, and prove
 * nothing — the reader has to subtract by eye at every x to see the thing the title asserts.
 * Plotting the subtraction makes the claim checkable in one look, and puts zero where it
 * belongs, as the line the shape crosses.
 *
 * A moment gets a picture; a span gets this. That split is the debrief's load-bearing rule for
 * evidence: a frame proves where he was at 14:53 and proves nothing about twenty minutes of
 * farm, and this proves the reverse.
 */

import type { SpineMinute } from "../../shared/schema/api.ts"
import { fmtDelta } from "../../shared/num.ts"
import "./debrief.css"

const W = 560
const H = 120
const PAD = 10

export interface RaceChartProps {
	minutes: readonly SpineMinute[]
	quantity: "cs" | "gold"
	counterpartName: string | null
	/** Marks the minute the card's claim is about, when it has one. */
	atSec?: number | null
}

export const RaceChart = ({ minutes, quantity, counterpartName, atSec = null }: RaceChartProps) => {
	if (minutes.length < 2) return null

	const value = (m: SpineMinute): number => (quantity === "cs" ? m.csMe - m.csThem : m.goldDiff)
	const span = minutes.at(-1)!.atSec || 1
	const peak = Math.max(quantity === "cs" ? 10 : 500, ...minutes.map(m => Math.abs(value(m))))

	const x = (t: number): number => PAD + (t / span) * (W - PAD * 2)
	const y = (v: number): number => H / 2 - (v / peak) * (H / 2 - PAD)
	const zero = y(0)

	const line = minutes.map(m => `${x(m.atSec).toFixed(1)},${y(value(m)).toFixed(1)}`).join(" ")
	const end = value(minutes.at(-1)!)
	const unit = quantity === "cs" ? " CS" : "g"

	return (
		<figure className="race">
			<svg viewBox={`0 0 ${W} ${H}`} className="race__svg" role="img"
				aria-label={`${quantity === "cs" ? "CS" : "Gold"} difference against ${counterpartName ?? "the enemy jungler"} over the game`}>
				<polygon
					className={`race__area ${end < 0 ? "is-against" : "is-for"}`}
					points={`${x(0)},${zero} ${line} ${x(span)},${zero}`}
				/>
				<polyline className="race__line" points={line} />
				<line className="race__zero" x1={PAD} x2={W - PAD} y1={zero} y2={zero} />
				{atSec !== null && atSec > 0 && atSec <= span && (
					<line className="race__at" x1={x(atSec)} x2={x(atSec)} y1={PAD} y2={H - PAD} />
				)}
				{/* Clamped inside the box: at the extremes the label fell outside the viewBox and the
				    one number on the chart was the one thing that did not render. */}
				<text
					className={`race__end ${end < 0 ? "is-against" : "is-for"}`}
					x={W - PAD}
					y={Math.max(PAD + 9, Math.min(H - PAD, y(end) + (end < 0 ? 13 : -5)))}
					textAnchor="end"
				>
					{fmtDelta(end, quantity === "cs" ? "cs" : "gold")}
					{unit}
				</text>
			</svg>
			<figcaption className="race__cap">
				{quantity === "cs" ? "CS" : "Gold"} against {counterpartName ?? "the enemy jungler"}, per
				timeline minute. Zero is level.
			</figcaption>
		</figure>
	)
}
