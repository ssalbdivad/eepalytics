/**
 * A 124px map beside a coaching card: where he was, and what he was not at.
 *
 * ## Why this is not `<MiniMap>` shrunk
 *
 * The full minimap draws every turret, both jungles and all of a game's moments. At 124px that
 * is a grey smudge. This draws FIVE things — three lanes, the two bases, and at most two
 * marks — because the question it answers is comparative and binary: was he near the thing the
 * card is about, or was he somewhere else? Anything beyond those five marks makes the answer
 * slower to read, not more accurate.
 *
 * It shares `LANE_POLYLINES`, `NEXUS` and `toMinimapPct` with the big map, so the art cannot
 * drift out of register with the dots. An earlier draft drew the river as a second diagonal and
 * it stopped reading as a map at all — two equal-weight diagonals just look like an X.
 */

import { LANE_POLYLINES, NEXUS, toMinimapPct, type Pos } from "../../shared/map.ts"
import "./debrief.css"

const VIEW = 100

const proj = (p: Pos): { x: number; y: number } => {
	const { left, top } = toMinimapPct(p)
	return { x: left, y: top }
}

const path = (list: ReadonlyArray<readonly [number, number]>): string =>
	list
		.map(([x, y], i) => {
			const q = proj({ x, y })
			return `${i === 0 ? "M" : "L"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`
		})
		.join(" ")

export interface MapInsetProps {
	/** Where he was, as percentages of the map box. Null when nothing placed him. */
	him: { left: number; top: number } | null
	/** The contested thing — an objective pit, a death site. Circled and named. */
	spot?: { left: number; top: number; label: string } | null
	/** Shown under the drawing: which channel placed him, and how far from the moment. */
	note?: string | null
	size?: number
}

export const MapInset = ({ him, spot = null, note = null, size = 124 }: MapInsetProps) => (
	<div className="inset" style={{ width: size }}>
		<svg viewBox={`0 0 ${VIEW} ${VIEW}`} className="inset__svg" role="img" aria-label="Where he was on the map">
			<rect className="inset__ground" x="0" y="0" width={VIEW} height={VIEW} rx="3" />
			<path className="inset__lane" d={path(LANE_POLYLINES.TOP)} />
			<path className="inset__lane" d={path(LANE_POLYLINES.BOT)} />
			<path className="inset__lane inset__lane--mid" d={path(LANE_POLYLINES.MID)} />
			{([100, 200] as const).map(team => {
				const q = proj(NEXUS[team])
				return <circle key={team} className="inset__base" cx={q.x} cy={q.y} r="6" />
			})}
			{spot && (
				<g className="inset__spot">
					<circle cx={spot.left} cy={spot.top} r="7" />
					<text x={spot.left} y={spot.top - 9.5} textAnchor="middle">
						{spot.label}
					</text>
				</g>
			)}
			{him && <circle className="inset__him" cx={him.left} cy={him.top} r="3.4" />}
		</svg>
		{note !== null && <p className="inset__note">{note}</p>}
	</div>
)
