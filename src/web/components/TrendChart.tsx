/**
 * TrendChart — one metric across recent games, with the statistics it can actually support.
 *
 * `analytics.md` §7 is blunt about this: at n≈20 most per-game metrics are too noisy for a
 * slope to mean anything (gold-diff@10 has a 95% CI of ±285g around a mean of −224g). So the
 * series carries TWO switches and this component obeys both:
 *
 *   trendable === true          → the LEVEL is stable enough to quote: mean line + 95% CI band
 *   slopeSignificant === true   → and only then, the least-squares fit line
 *   either one false            → scatter + mean + CI band, NO fit line, card de-emphasised,
 *                                 and `note` printed inline saying why
 *
 * The second switch is the one that used to be missing, and it was the app's biggest overclaim:
 * §7.3 says never claim "improving"/"declining" unless the slope's own 95% CI excludes zero,
 * and a bold green line through the points IS that claim. Measured on the user's real 20-game
 * window: 19 series came back trendable and got a fit line, and exactly 2 of them
 * (`medianCentroidDist`, `p90OverExtension`) have a slope CI that excludes zero. The other 17
 * were confident green directions drawn through noise.
 *
 * A missing/`null` `slopeSignificant` means "not computed", and is treated as "do not draw".
 * There is no prop to override any of this. Drawing a confident line through noise is the
 * specific failure this component exists to prevent.
 */

import type { TrendSeries } from "../../shared/schema/domain.ts"
import "./components.css"

export interface TrendChartProps {
	series: TrendSeries
	/** Optional: called with a gameId when a point is clicked. */
	onSelectGame?: (gameId: number) => void
	height?: number
}

const W = 480
const PAD_L = 40
const PAD_R = 10
const PAD_T = 10
const PAD_B = 18

const fmtNum = (v: number): string => {
	if (!Number.isFinite(v)) return "—"
	const a = Math.abs(v)
	if (a === 0) return "0"
	if (a < 1) return v.toFixed(2)
	if (a < 10) return v.toFixed(1)
	if (a < 10000) return String(Math.round(v))
	return Math.round(v).toLocaleString()
}

/** Ordinary least squares over the point index. Only ever drawn when the slope CI excludes zero. */
const ols = (ys: number[]): { a: number; b: number } => {
	const n = ys.length
	let sx = 0
	let sy = 0
	let sxx = 0
	let sxy = 0
	for (let i = 0; i < n; i++) {
		sx += i
		sy += ys[i]!
		sxx += i * i
		sxy += i * ys[i]!
	}
	const denom = n * sxx - sx * sx
	if (denom === 0) return { a: sy / n, b: 0 }
	const b = (n * sxy - sx * sy) / denom
	const a = (sy - b * sx) / n
	return { a, b }
}

export const TrendChart = ({ series, onSelectGame, height = 160 }: TrendChartProps) => {
	const points = [...series.points].sort((a, b) => a.tMs - b.tMs)
	const H = height

	if (points.length === 0)
		return (
			<div className="csk-trend csk-trend--untrendable">
				<div className="csk-trend__head">
					<span className="csk-trend__label">{series.label}</span>
				</div>
				<div className="csk-empty">
					No games have produced this metric yet.
				</div>
				{series.note && (
					<div className="csk-trend__note">
						<b>note</b>
						<span>{series.note}</span>
					</div>
				)}
			</div>
		)

	const ys = points.map(p => p.value)
	const ci = series.ci95 !== null && Number.isFinite(series.ci95) ? Math.abs(series.ci95) : null

	// include the mean and the whole CI band in the domain so the band is never clipped
	const candidates = [...ys, series.mean]
	if (ci !== null) candidates.push(series.mean - ci, series.mean + ci)
	let lo = Math.min(...candidates)
	let hi = Math.max(...candidates)
	if (hi - lo < 1e-9) {
		lo -= 1
		hi += 1
	}
	const padY = (hi - lo) * 0.12
	lo -= padY
	hi += padY

	const xAt = (i: number): number =>
		points.length === 1 ?
			PAD_L + (W - PAD_L - PAD_R) / 2
		:	PAD_L + (i / (points.length - 1)) * (W - PAD_L - PAD_R)
	const yAt = (v: number): number => PAD_T + (1 - (v - lo) / (hi - lo)) * (H - PAD_T - PAD_B)

	const meanY = yAt(series.mean)
	/*
	 * `trendable` is permission to quote the LEVEL. Drawing the line needs the stricter
	 * `slopeSignificant`, which is true only when the slope's own 95% CI excludes zero.
	 */
	const directionClaimable = series.trendable && series.slopeSignificant === true
	const fit = directionClaimable && points.length >= 3 ? ols(ys) : null

	return (
		<div className={`csk-trend${series.trendable ? "" : " csk-trend--untrendable"}`}>
			<div className="csk-trend__head">
				<span className="csk-trend__label">{series.label}</span>
				<span className="csk-trend__mean">
					mean {fmtNum(series.mean)}
					{ci !== null ?
						<small> ±{fmtNum(ci)} (95% CI)</small>
					:	<small> · CI unavailable</small>}
					<small> · n={points.length}</small>
				</span>
			</div>

			<svg
				className="csk-trend__svg"
				viewBox={`0 0 ${W} ${H}`}
				role="img"
				aria-label={`${series.label}: ${points.length} games, mean ${fmtNum(series.mean)}${
					series.trendable ? "" : ", not trendable"
				}${series.trendable && !directionClaimable ? ", level only — no direction can be claimed" : ""}`}
			>
				{/* y axis ticks: just the domain ends and the mean, no invented gridlines */}
				{[hi - padY, lo + padY].map((v, i) => (
					<g key={`ax-${i}`}>
						<line
							x1={PAD_L}
							x2={W - PAD_R}
							y1={yAt(v)}
							y2={yAt(v)}
							stroke="#1a242e"
							strokeWidth="1"
						/>
						<text
							x={PAD_L - 5}
							y={yAt(v) + 3.5}
							textAnchor="end"
							fontSize="9"
							fontFamily="ui-monospace, monospace"
							fill="#4a5a68"
						>
							{fmtNum(v)}
						</text>
					</g>
				))}

				{/* 95% CI band around the mean */}
				{ci !== null && (
					<rect
						x={PAD_L}
						y={Math.min(yAt(series.mean + ci), yAt(series.mean - ci))}
						width={W - PAD_L - PAD_R}
						height={Math.abs(yAt(series.mean - ci) - yAt(series.mean + ci))}
						fill="#c8aa6e"
						opacity="0.1"
					/>
				)}

				{/* mean */}
				<line
					x1={PAD_L}
					x2={W - PAD_R}
					y1={meanY}
					y2={meanY}
					stroke="#c8aa6e"
					strokeWidth="1.2"
					strokeDasharray="5 4"
					opacity="0.8"
				/>

				{/* the connecting line is scatter-support only, never a claim */}
				{points.length > 1 && (
					<polyline
						points={points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`).join(" ")}
						fill="none"
						stroke="#4c8fdc"
						strokeWidth="1.2"
						opacity={series.trendable ? 0.45 : 0.28}
					/>
				)}

				{/* the actual trend claim — only when the series says it is defensible */}
				{fit && (
					<line
						x1={xAt(0)}
						y1={yAt(fit.a)}
						x2={xAt(points.length - 1)}
						y2={yAt(fit.a + fit.b * (points.length - 1))}
						stroke="#3fbf7f"
						strokeWidth="2"
						opacity="0.9"
					/>
				)}

				{points.map((p, i) => (
					<circle
						key={`${p.gameId}-${i}`}
						cx={xAt(i)}
						cy={yAt(p.value)}
						r={onSelectGame ? 4 : 3}
						fill={series.trendable ? "#e6edf3" : "#7b8b99"}
						stroke="#05090d"
						strokeWidth="1"
						style={onSelectGame ? { cursor: "pointer" } : undefined}
						onClick={onSelectGame ? () => onSelectGame(p.gameId) : undefined}
					>
						<title>{`game ${p.gameId}: ${fmtNum(p.value)}`}</title>
					</circle>
				))}
			</svg>

			{series.note && (
				<div
					className={`csk-trend__note${directionClaimable ? "" : " csk-trend__note--warn"}`}
				>
					<b>
						{!series.trendable ? "not trendable"
						: directionClaimable ? "direction"
						: "level only"}
					</b>
					<span>{series.note}</span>
				</div>
			)}
			{series.trendable && !directionClaimable && !series.note && (
				<div className="csk-trend__note csk-trend__note--warn">
					<b>level only</b>
					<span>
						The mean over these {points.length} games is worth quoting, but the slope's own 95%
						CI contains zero — no direction can be claimed, so no trend line is drawn.
					</span>
				</div>
			)}
			{!series.note && !series.trendable && (
				<div className="csk-trend__note csk-trend__note--warn">
					<b>not trendable</b>
					<span>
						The spread across these {points.length} games swamps any slope — read the mean, not
						the shape.
					</span>
				</div>
			)}
		</div>
	)
}

export default TrendChart
