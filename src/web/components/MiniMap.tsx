/**
 * MiniMap — Summoner's Rift with the game's moments plotted at their true world coordinates.
 *
 * ## The axis flip, once, and only here
 *
 * The game's `+y` points NORTH (up the minimap); a screen's `top` points DOWN. `toMinimapPct`
 * in `src/shared/map.ts` is the single place that flip is written, and this component is a
 * consumer of it — including for the backdrop. That is deliberate: the rift drawing below is
 * generated from the SAME turret/pit/lane constants that the moments are plotted against, so
 * the art cannot drift out of register with the data. If the projection ever changes, the map
 * and the dots move together.
 *
 * Sanity anchor: blue nexus is at (1962, 2038) — low x, low y — and must land BOTTOM-LEFT.
 * `toMinimapPct({x:1962,y:2038})` => `{left: 13.9, top: 85.7}`. Bottom-left. Correct.
 */

import { useMemo, useState } from "react"
import { MAP } from "../../shared/constants.ts"
import {
	LANE_POLYLINES,
	NEXUS,
	PITS,
	TURRETS,
	toMinimapPct,
	zoneOf,
	type Pos
} from "../../shared/map.ts"
import type { Moment, MomentKind } from "../../shared/schema/domain.ts"
import { fmtClock } from "../../shared/time.ts"
// One definition, in the lower layer. GameReview reads it straight from lib/format.ts, so a
// second copy here meant the moment list said "Farm gap" while this map's legend said
// "Camp/CS gap" for the very same moment. Re-exported so the components that already import
// it from MiniMap keep working.
import { MOMENT_KIND_LABEL } from "../lib/format.ts"
export { MOMENT_KIND_LABEL }
import "./components.css"

export type MiniMapOverlay = "deaths" | "heat" | "none"

export interface MiniMapProps {
	moments: Moment[]
	selectedId: string | null
	onSelect: (id: string) => void
	overlay?: MiniMapOverlay
	/** Optional: which team the user was on, so zone names read "own"/"enemy" in the tooltip. */
	teamId?: 100 | 200
}

/* ------------------------------------------------------------- projection */

/** The SVG user-space is a 1000x1000 square; percentages from `toMinimapPct` scale into it. */
const VIEW = 1000

const proj = (p: Pos): { x: number; y: number } => {
	const { left, top } = toMinimapPct(p)
	return { x: (left / 100) * VIEW, y: (top / 100) * VIEW }
}

/** World length -> SVG length. The world is 14990 x 15100 units, close enough to square. */
const len = (world: number): number => (world / (MAP.maxX - MAP.minX)) * VIEW

const pts = (list: ReadonlyArray<readonly [number, number]>): string =>
	list
		.map(([x, y]) => {
			const q = proj({ x, y })
			return `${q.x.toFixed(1)},${q.y.toFixed(1)}`
		})
		.join(" ")

/* ------------------------------------------------------------ moment style */

/** One palette, shared with GameTimeline and FeedbackCard so a colour always means one thing. */
export const MOMENT_KIND_COLOR: Record<MomentKind, string> = {
	death: "#e0475b",
	kill: "#c8aa6e",
	objective: "#0ac8b9",
	objective_missed: "#8a6bd6",
	gold_swing: "#e0a010",
	tempo: "#4c8fdc",
	cs_gap: "#7fb069",
	positioning: "#d97fa8",
	vision: "#63d1e8",
	teamfight: "#ff8c42",
	recall: "#6b7f91",
	other: "#8494a3"
}

export const momentColor = (kind: MomentKind): string =>
	MOMENT_KIND_COLOR[kind] ?? MOMENT_KIND_COLOR.other


/* --------------------------------------------------------------- backdrop */

const isBlueStructure = (name: string): boolean => name.startsWith("BLUE_")

/**
 * The rift itself. Every coordinate comes from `map.ts`'s measured constants, so this is a
 * *diagram of the data*, not decoration: if a lane polyline is wrong, the drawing shows it.
 */
const RiftBackdrop = () => {
	// River: the anti-diagonal x + y = 2 * centerU, widened by +/- 900 in each axis, which is
	// a perpendicular half-width of 900 * sqrt(2) ~= 1273 game units (see map.ts / UV_SCALE).
	const c2 = MAP.centerU * 2
	const riverA: Pos = { x: 300, y: c2 - 300 }
	const riverB: Pos = { x: c2 - 300, y: 300 }
	const w = 900
	const river = pts([
		[riverA.x - w, riverA.y - w],
		[riverB.x - w, riverB.y - w],
		[riverB.x + w, riverB.y + w],
		[riverA.x + w, riverA.y + w]
	])

	return (
		<g aria-hidden="true">
			<defs>
				<clipPath id="csk-rift-clip">
					<rect x="0" y="0" width={VIEW} height={VIEW} rx="10" />
				</clipPath>
				<radialGradient id="csk-base-blue" cx="50%" cy="50%">
					<stop offset="0%" stopColor="#2d6ba8" stopOpacity="0.36" />
					<stop offset="100%" stopColor="#2d6ba8" stopOpacity="0.03" />
				</radialGradient>
				<radialGradient id="csk-base-red" cx="50%" cy="50%">
					<stop offset="0%" stopColor="#b4444f" stopOpacity="0.36" />
					<stop offset="100%" stopColor="#b4444f" stopOpacity="0.03" />
				</radialGradient>
			</defs>

			<g clipPath="url(#csk-rift-clip)">
				{/* jungle floor */}
				<rect x="0" y="0" width={VIEW} height={VIEW} fill="#0b1410" />
				<rect x="0" y="0" width={VIEW} height={VIEW} fill="#0a0f14" opacity="0.55" />

				{/* river band */}
				<polygon points={river} fill="#123a4d" opacity="0.7" />
				<polygon points={river} fill="none" stroke="#1d5c73" strokeWidth="1" opacity="0.5" />

				{/* lanes, drawn from the calibrated polylines */}
				{(["TOP", "MID", "BOT"] as const).map(lane => (
					<polyline
						key={`lane-${lane}`}
						points={pts(LANE_POLYLINES[lane])}
						fill="none"
						stroke="#2b3644"
						strokeWidth={len(1050)}
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				))}
				{(["TOP", "MID", "BOT"] as const).map(lane => (
					<polyline
						key={`lane-in-${lane}`}
						points={pts(LANE_POLYLINES[lane])}
						fill="none"
						stroke="#39485a"
						strokeWidth={len(360)}
						strokeLinecap="round"
						strokeLinejoin="round"
						opacity="0.85"
					/>
				))}

				{/* bases */}
				<circle
					cx={proj(NEXUS[100]).x}
					cy={proj(NEXUS[100]).y}
					r={len(MAP.baseRadius)}
					fill="url(#csk-base-blue)"
					stroke="#2d6ba8"
					strokeOpacity="0.5"
					strokeWidth="1.5"
				/>
				<circle
					cx={proj(NEXUS[200]).x}
					cy={proj(NEXUS[200]).y}
					r={len(MAP.baseRadius)}
					fill="url(#csk-base-red)"
					stroke="#b4444f"
					strokeOpacity="0.5"
					strokeWidth="1.5"
				/>

				{/* objective pits — baron/herald/grubs share the top-side pit */}
				{(
					[
						["BARON", PITS.BARON, "#a98bfa", "B"],
						["DRAGON", PITS.DRAGON, "#ff8c42", "D"]
					] as const
				).map(([key, pos, colour, glyph]) => {
					const q = proj(pos)
					return (
						<g key={key}>
							<circle
								cx={q.x}
								cy={q.y}
								r={len(MAP.pitRadius)}
								fill={colour}
								fillOpacity="0.13"
								stroke={colour}
								strokeOpacity="0.55"
								strokeWidth="1.5"
							/>
							<text
								x={q.x}
								y={q.y + 4.5}
								textAnchor="middle"
								fontSize="13"
								fontFamily="ui-monospace, monospace"
								fontWeight="700"
								fill={colour}
								fillOpacity="0.75"
							>
								{glyph}
							</text>
						</g>
					)
				})}

				{/* turrets — exact structure coordinates, spread zero across 22 games */}
				{Object.entries(TURRETS).map(([name, pos]) => {
					const q = proj(pos)
					const blue = isBlueStructure(name)
					return (
						<rect
							key={name}
							x={q.x - 3}
							y={q.y - 3}
							width="6"
							height="6"
							rx="1.4"
							fill={blue ? "#5b9bd5" : "#d97078"}
							fillOpacity="0.62"
						/>
					)
				})}
			</g>

			<rect
				x="0.5"
				y="0.5"
				width={VIEW - 1}
				height={VIEW - 1}
				rx="10"
				fill="none"
				stroke="#23323f"
			/>
		</g>
	)
}

/* -------------------------------------------------------------- heat grid */

const HEAT_N = 28

const HEAT_STOPS: ReadonlyArray<readonly [number, [number, number, number]]> = [
	[0, [26, 54, 122]],
	[0.35, [18, 183, 200]],
	[0.65, [227, 201, 74]],
	[1, [224, 71, 91]]
]

const heatColor = (t: number): string => {
	const c = Math.min(1, Math.max(0, t))
	for (let i = 1; i < HEAT_STOPS.length; i++) {
		const lo = HEAT_STOPS[i - 1]!
		const hi = HEAT_STOPS[i]!
		if (c <= hi[0]) {
			const span = hi[0] - lo[0] || 1
			const f = (c - lo[0]) / span
			const r = Math.round(lo[1][0] + (hi[1][0] - lo[1][0]) * f)
			const g = Math.round(lo[1][1] + (hi[1][1] - lo[1][1]) * f)
			const b = Math.round(lo[1][2] + (hi[1][2] - lo[1][2]) * f)
			return `rgb(${r},${g},${b})`
		}
	}
	return "rgb(224,71,91)"
}

interface HeatCell {
	x: number
	y: number
	t: number
}

/**
 * Bin the moments into a 28x28 grid (~535 game units per cell) and blur, following the
 * accumulate-in-float / normalise-by-max recipe in `analytics.md` §5.4. Weight is
 * `0.35 + severity` so a game-losing moment reads hotter than a trivia one, and the caller
 * is always told `n` — a 4-point heatmap and a 40-point heatmap must not look alike.
 */
const buildHeat = (moments: Moment[]): HeatCell[] => {
	if (moments.length === 0) return []
	const n = HEAT_N
	const grid = new Float64Array(n * n)
	for (const m of moments) {
		const q = proj({ x: m.mapX, y: m.mapY })
		const gx = Math.min(n - 1, Math.max(0, Math.floor((q.x / VIEW) * n)))
		const gy = Math.min(n - 1, Math.max(0, Math.floor((q.y / VIEW) * n)))
		grid[gy * n + gx] = grid[gy * n + gx]! + 0.35 + m.severity
	}

	// separable [1,3,6,3,1] blur, in float — an 8-bit accumulator flattens the peak
	const k = [1, 3, 6, 3, 1]
	const kSum = 14
	const tmp = new Float64Array(n * n)
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			let acc = 0
			for (let d = -2; d <= 2; d++) {
				const xx = x + d
				if (xx < 0 || xx >= n) continue
				acc += grid[y * n + xx]! * k[d + 2]!
			}
			tmp[y * n + x] = acc / kSum
		}
	}
	const out = new Float64Array(n * n)
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			let acc = 0
			for (let d = -2; d <= 2; d++) {
				const yy = y + d
				if (yy < 0 || yy >= n) continue
				acc += tmp[yy * n + x]! * k[d + 2]!
			}
			out[y * n + x] = acc / kSum
		}
	}

	let max = 0
	for (let i = 0; i < out.length; i++) if (out[i]! > max) max = out[i]!
	if (max <= 0) return []

	const cells: HeatCell[] = []
	const step = VIEW / n
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			const t = out[y * n + x]! / max
			if (t < 0.05) continue
			cells.push({ x: x * step, y: y * step, t })
		}
	}
	return cells
}

/* ------------------------------------------------------------------ marks */

const markRadius = (severity: number): number => 9 + Math.min(1, Math.max(0, severity)) * 13

/** Shape carries kind as well as colour, so the map survives a colour-blind reader. */
const MarkShape = ({ kind, r }: { kind: MomentKind; r: number }) => {
	const c = momentColor(kind)
	const common = { fill: c, fillOpacity: 0.82, stroke: "#05090d", strokeWidth: 1.5 }
	switch (kind) {
		case "objective":
		case "objective_missed":
			return (
				<path
					d={`M0 ${-r} L ${r} 0 L 0 ${r} L ${-r} 0 Z`}
					{...common}
					fillOpacity={kind === "objective_missed" ? 0.14 : 0.82}
					stroke={c}
					strokeWidth={kind === "objective_missed" ? 2.4 : 1.5}
					strokeDasharray={kind === "objective_missed" ? "5 3" : undefined}
				/>
			)
		case "vision":
			return <rect x={-r * 0.8} y={-r * 0.8} width={r * 1.6} height={r * 1.6} rx="2" {...common} />
		case "tempo":
		case "recall":
			return <path d={`M0 ${-r} L ${r * 0.92} ${r * 0.7} L ${-r * 0.92} ${r * 0.7} Z`} {...common} />
		case "death":
			return (
				<>
					<circle r={r} {...common} />
					<path
						d={`M${-r * 0.42} ${-r * 0.42} L ${r * 0.42} ${r * 0.42} M${r * 0.42} ${-r * 0.42} L ${-r * 0.42} ${r * 0.42}`}
						stroke="#1b0409"
						strokeWidth={r * 0.24}
						strokeLinecap="round"
						fill="none"
					/>
				</>
			)
		default:
			return <circle r={r} {...common} />
	}
}

/* ------------------------------------------------------------- component */

export const MiniMap = ({
	moments,
	selectedId,
	onSelect,
	overlay = "none",
	teamId
}: MiniMapProps) => {
	const [hoverId, setHoverId] = useState<string | null>(null)

	const shown = useMemo(
		() => (overlay === "deaths" ? moments.filter(m => m.kind === "death") : moments),
		[moments, overlay]
	)

	const heat = useMemo(
		() => (overlay === "heat" ? buildHeat(moments) : []),
		[moments, overlay]
	)

	// draw the biggest last so severe moments sit on top and stay clickable
	const ordered = useMemo(
		() => [...shown].sort((a, b) => a.severity - b.severity),
		[shown]
	)

	const hovered = hoverId ? (moments.find(m => m.id === hoverId) ?? null) : null
	const hoveredPct = hovered ? toMinimapPct({ x: hovered.mapX, y: hovered.mapY }) : null

	const kindsPresent = useMemo(() => {
		const seen = new Set<MomentKind>()
		for (const m of shown) seen.add(m.kind)
		return [...seen].slice(0, 6)
	}, [shown])

	return (
		<div className="csk-minimap">
			<svg
				className="csk-minimap__svg"
				viewBox={`0 0 ${VIEW} ${VIEW}`}
				role="img"
				aria-label={`Summoner's Rift with ${shown.length} plotted moments`}
			>
				<RiftBackdrop />

				{overlay === "heat" && (
					<g>
						{heat.map(cell => (
							<rect
								key={`h-${cell.x}-${cell.y}`}
								x={cell.x}
								y={cell.y}
								width={VIEW / HEAT_N + 0.6}
								height={VIEW / HEAT_N + 0.6}
								fill={heatColor(cell.t)}
								opacity={Math.pow(cell.t, 0.75) * 0.72}
							/>
						))}
					</g>
				)}

				<g>
					{ordered.map(m => {
						const q = proj({ x: m.mapX, y: m.mapY })
						const selected = m.id === selectedId
						const dim =
							overlay === "heat" ||
							(selectedId !== null && !selected && hoverId !== m.id)
						const r = markRadius(m.severity)
						return (
							<g
								key={m.id}
								className={`csk-minimap__mark${dim ? " csk-minimap__mark--dim" : ""}`}
								transform={`translate(${q.x.toFixed(1)} ${q.y.toFixed(1)})`}
								role="button"
								tabIndex={0}
								aria-label={`${MOMENT_KIND_LABEL[m.kind]} at ${fmtClock(m.tSec)}: ${m.title}`}
								onClick={() => onSelect(m.id)}
								onKeyDown={e => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault()
										onSelect(m.id)
									}
								}}
								onMouseEnter={() => setHoverId(m.id)}
								onMouseLeave={() => setHoverId(cur => (cur === m.id ? null : cur))}
								onFocus={() => setHoverId(m.id)}
								onBlur={() => setHoverId(cur => (cur === m.id ? null : cur))}
							>
								{selected && (
									<circle
										r={r + 7}
										fill="none"
										stroke="#f0e6d2"
										strokeWidth="2.5"
										opacity="0.9"
									/>
								)}
								<MarkShape kind={m.kind} r={r} />
								{/* generous invisible hit target — the shapes are small at 300px wide */}
								<circle r={Math.max(r + 6, 16)} fill="transparent" />
							</g>
						)
					})}
				</g>
			</svg>

			{hovered && hoveredPct && (
				<div
					className="csk-minimap__tip"
					style={{ left: `${hoveredPct.left}%`, top: `${hoveredPct.top}%` }}
				>
					<b>{hovered.title}</b>
					<span>
						{fmtClock(hovered.tSec)} · {zoneOf({ x: hovered.mapX, y: hovered.mapY }, teamId)}
					</span>
				</div>
			)}

			{shown.length === 0 && (
				<div className="csk-empty" style={{ position: "absolute", inset: 0 }}>
					{overlay === "deaths"
						? "No deaths recorded for this game."
						: "No moments yet — analysis has not produced anything to plot."}
				</div>
			)}

			{overlay === "heat" && (
				<div className="csk-minimap__note">
					heat: {moments.length} moment{moments.length === 1 ? "" : "s"}, {HEAT_N}×{HEAT_N} bins
					<br />
					not a full position track
				</div>
			)}

			{kindsPresent.length > 0 && overlay !== "heat" && (
				<div className="csk-minimap__legend">
					{kindsPresent.map(k => (
						<span key={k}>
							<i style={{ background: momentColor(k) }} />
							{MOMENT_KIND_LABEL[k].toLowerCase()}
						</span>
					))}
				</div>
			)}
		</div>
	)
}

export default MiniMap
