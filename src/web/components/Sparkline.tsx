/**
 * Sparkline — a bare trend squiggle for inline use (a table cell, a metric footer).
 *
 * Deliberately dumb: no axes, no labels, no statistics. It shows SHAPE, not magnitude, and it
 * refuses to imply a shape it does not have — one point renders a dot, a flat series renders a
 * flat line, an empty series renders a dash. Anything that needs a confidence claim attached
 * belongs in `TrendChart`, which carries the CI band and the `trendable` gate.
 */

import "./components.css"

export interface SparklineProps {
	values: number[]
	width?: number
	height?: number
	color?: string
	/** Draw a dot on the most recent value. Default true. */
	showLast?: boolean
}

export const Sparkline = ({
	values,
	width = 68,
	height = 18,
	color = "#c8aa6e",
	showLast = true
}: SparklineProps) => {
	const clean = values.filter(v => Number.isFinite(v))

	if (clean.length === 0)
		return (
			<span className="csk-spark csk-spark__flat" style={{ width, height }}>
				—
			</span>
		)

	const pad = 2
	const w = width - pad * 2
	const h = height - pad * 2
	const min = Math.min(...clean)
	const max = Math.max(...clean)
	const span = max - min

	const xAt = (i: number): number =>
		clean.length === 1 ? pad + w / 2 : pad + (i / (clean.length - 1)) * w
	// a flat series draws down the middle rather than pinned to an arbitrary edge
	const yAt = (v: number): number =>
		span === 0 ? pad + h / 2 : pad + h - ((v - min) / span) * h

	const path = clean.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ")
	const lastX = xAt(clean.length - 1)
	const lastY = yAt(clean[clean.length - 1]!)

	return (
		<span className="csk-spark" title={`${clean.length} values, ${min} … ${max}`}>
			<svg
				className="csk-spark__svg"
				width={width}
				height={height}
				viewBox={`0 0 ${width} ${height}`}
				aria-hidden="true"
			>
				{clean.length > 1 && (
					<polyline
						points={path}
						fill="none"
						stroke={color}
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
						opacity={span === 0 ? 0.4 : 0.95}
					/>
				)}
				{showLast && <circle cx={lastX} cy={lastY} r="2" fill={color} />}
			</svg>
		</span>
	)
}

export default Sparkline
