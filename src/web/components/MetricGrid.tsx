/**
 * MetricGrid — the measured numbers, rendered with their uncertainty attached.
 *
 * Two rules are enforced here rather than left to whoever calls it:
 *
 *  1. **A `low`-confidence metric must not look like a hard fact.** It gets a dashed border,
 *     a hatched ground, a muted value, a `~` prefix and an explicit "LOW" marker. Frames are
 *     one per minute and the median displacement between them is 4082 units; anything derived
 *     from interpolating between them is a guess and has to read as one.
 *  2. **`vsBaseline === null` means no comparison exists**, and is rendered as "no baseline",
 *     never as 0 and never as a coloured delta. `band` should be `"unknown"` in that case; if
 *     a caller sends a band anyway we still show it, because the metric layer owns that call.
 *
 * The `explain` string is shown on hover and is the same sentence handed to Claude, so what
 * the user reads is what the coach read.
 */

import type { Confidence, Metric } from "../../shared/schema/domain.ts"
import "./components.css"

export interface MetricGridProps {
	metrics: Metric[]
	/** Optional: a metric key to visually pin, e.g. one cited by the feedback item in view. */
	highlightKey?: string | null
}

/** Trim to something readable without inventing precision. */
const fmtValue = (v: number): string => {
	if (!Number.isFinite(v)) return "—"
	const a = Math.abs(v)
	if (a === 0) return "0"
	if (a < 1) return v.toFixed(2)
	if (a < 10) return v.toFixed(1)
	if (a < 1000) return String(Math.round(v))
	return Math.round(v).toLocaleString()
}

const fmtDelta = (d: number, unit: string): string => {
	const sign = d > 0 ? "+" : d < 0 ? "−" : "±"
	const body = fmtValue(Math.abs(d))
	return `${sign}${body}${unit === "%" ? "%" : ""}`
}

const CONF_DOTS: Record<Confidence, number> = { high: 3, medium: 2, low: 1 }

const ConfidenceMark = ({ confidence }: { confidence: Confidence }) => (
	<span className={`csk-conf csk-conf--${confidence}`} title={CONF_EXPLAIN[confidence]}>
		<span className="csk-conf__dots">
			{[0, 1, 2].map(i => (
				<i key={i} className={i < CONF_DOTS[confidence] ? "on" : ""} />
			))}
		</span>
		{confidence === "high" ? "" : confidence}
	</span>
)

const CONF_EXPLAIN: Record<Confidence, string> = {
	high: "High confidence — read straight off an event or an end-of-game stat.",
	medium: "Medium confidence — computed from values at 1-minute frame boundaries.",
	low: "Low confidence — depends on interpolating between 1-minute frames, i.e. on a guess about position. Treat as 'likely', not 'was'."
}

export const MetricGrid = ({ metrics, highlightKey = null }: MetricGridProps) => {
	if (metrics.length === 0)
		return (
			<div className="csk-empty csk-panel">
				No metrics for this game yet — analysis has not run, or there was no timeline to run
				it on.
			</div>
		)

	return (
		<div className="csk-metrics">
			{metrics.map(m => {
				const low = m.confidence === "low"
				const hasBaseline = m.vsBaseline !== null && Number.isFinite(m.vsBaseline)
				const deltaClass =
					!hasBaseline ? "none"
					: m.band === "good" ? "good"
					: m.band === "bad" ? "bad"
					: "flat"

				return (
					<div
						key={m.key}
						className={`csk-metric csk-metric--${m.band}${low ? " csk-metric--low" : ""}`}
						style={
							highlightKey === m.key ?
								{ boxShadow: "0 0 0 1px var(--csk-gold)" }
							:	undefined
						}
						tabIndex={0}
						title={m.explain}
					>
						<div className="csk-metric__label">{m.label}</div>
						<div className="csk-metric__value">
							{low && (
								<span className="csk-metric__approx" title="approximate — low confidence">
									~
								</span>
							)}
							{fmtValue(m.value)}
							{m.unit && m.unit !== "%" && <span className="csk-metric__unit">{m.unit}</span>}
							{m.unit === "%" && <span className="csk-metric__unit">%</span>}
						</div>
						<div className="csk-metric__foot">
							<span className={`csk-metric__delta--${deltaClass}`}>
								{hasBaseline ?
									`${fmtDelta(m.vsBaseline as number, m.unit)} vs base`
								:	"no baseline"}
							</span>
							<ConfidenceMark confidence={m.confidence} />
						</div>
						<div className="csk-metric__tip" role="tooltip">
							{m.explain || "No explanation was recorded for this metric."}
							<em>
								{m.key} · {CONF_EXPLAIN[m.confidence]}
							</em>
						</div>
					</div>
				)
			})}
		</div>
	)
}

export default MetricGrid
