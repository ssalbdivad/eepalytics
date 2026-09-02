/**
 * Presentation-only formatting. Everything numeric the UI prints goes through here so that
 * "how a number looks" is decided in exactly one place.
 *
 * Nothing in this file invents a value. Where a number is missing the helpers return a dash
 * or an explicit "unknown" — never a zero standing in for absent data.
 */

import { ROLE_LABELS } from "../../shared/schema/domain.ts"
import type {
	Band,
	Confidence,
	FeedbackSeverity,
	Job,
	JobKind,
	JobState,
	Metric,
	MomentKind,
	Role
} from "../../shared/schema/domain.ts"
import { REPLAY_EXPIRY_MS } from "../../shared/constants.ts"
import { fmtCountdown } from "../../shared/time.ts"

export {
	fmtAgo,
	fmtClock,
	fmtClockMs,
	fmtCountdown,
	fmtDateTime,
	fmtDuration,
	msUntil
} from "../../shared/time.ts"

/** Tiny classnames joiner. Falsy entries drop out. */
export const cls = (...parts: (string | false | null | undefined)[]): string =>
	parts.filter(Boolean).join(" ")

/* ============================================================== numbers */

export const fmtNum = (n: number, digits = 0): string =>
	Number.isFinite(n) ? n.toFixed(digits) : "--"

/** Always signed — for deltas against a baseline, where the sign IS the information. */
export const fmtSigned = (n: number, digits = 0): string =>
	!Number.isFinite(n) ? "--" : `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n).toFixed(digits)}`

export const fmtCompact = (n: number): string => {
	if (!Number.isFinite(n)) return "--"
	const abs = Math.abs(n)
	if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
	if (abs >= 10_000) return `${Math.round(n / 1000)}k`
	if (abs >= 1000) return `${(n / 1000).toFixed(1)}k`
	return String(Math.round(n))
}

export const fmtPct = (fraction: number, digits = 0): string =>
	Number.isFinite(fraction) ? `${(fraction * 100).toFixed(digits)}%` : "--"

/** How many decimals a metric's unit deserves. Gold is never shown to a tenth. */
const unitDigits = (unit: string): number => {
	switch (unit) {
		case "/min":
			return 2
		case "%":
			return 1
		case "s":
			return 1
		case "gold":
		case "cs":
			return 0
		default:
			return 1
	}
}

export const fmtMetricValue = (m: Metric): string => {
	if (!Number.isFinite(m.value)) return "--"
	if (m.unit === "%") return `${m.value.toFixed(1)}%`
	if (m.unit === "gold") return fmtCompact(m.value)
	return m.value.toFixed(unitDigits(m.unit))
}

export const fmtMetricUnit = (m: Metric): string =>
	m.unit === "" || m.unit === "%" ? "" : m.unit

export const fmtMetricDelta = (m: Metric): string =>
	m.vsBaseline === null ? "no baseline" : `${fmtSigned(m.vsBaseline, unitDigits(m.unit))} vs your avg`

/* =============================================================== labels */

export const bandClass = (band: Band): string => `band-${band}`

export const BAND_LABEL: Record<Band, string> = {
	good: "above your average",
	ok: "around your average",
	bad: "below your average",
	unknown: "not enough history to rank"
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
	high: "measured",
	medium: "derived from per-minute frames",
	low: "inferred between 1-minute frames — treat as a guess"
}

/** Short chip text. `high` gets no chip at all: certainty is the default, doubt is the news. */
export const confidenceChip = (c: Confidence): string | null =>
	c === "high" ? null : c === "medium" ? "derived" : "inferred"

export const SEVERITY_LABEL: Record<FeedbackSeverity, string> = {
	info: "note",
	minor: "minor",
	major: "major"
}

export const SEVERITY_RANK: Record<FeedbackSeverity, number> = {
	major: 0,
	minor: 1,
	info: 2
}

export const roleLabel = (role: Role): string => ROLE_LABELS[role] ?? "Unknown"

export const MOMENT_KIND_LABEL: Record<MomentKind, string> = {
	death: "Death",
	kill: "Kill",
	objective: "Objective",
	objective_missed: "Objective missed",
	gold_swing: "Gold swing",
	tempo: "Tempo",
	cs_gap: "Camp/CS gap",
	positioning: "Positioning",
	vision: "Vision",
	teamfight: "Teamfight",
	recall: "Recall",
	other: "Moment"
}

export const JOB_KIND_LABEL: Record<JobKind, string> = {
	"match-ingest": "Ingest match",
	"replay-download": "Download replay",
	"analysis-run": "Analyze",
	"review-game": "Coach review",
	"review-trend": "Trend review",
	"replay-capture": "Capture clips",
	"media-generate": "Render media"
}

export const JOB_STATE_LABEL: Record<JobState, string> = {
	queued: "Queued",
	leased: "Running",
	done: "Done",
	failed: "Failed",
	deferred: "Waiting",
	expired: "Expired"
}

export const jobKindLabel = (kind: string): string =>
	JOB_KIND_LABEL[kind as JobKind] ?? kind

/** What the Queue screen prints under a job that is not moving. Verbatim, never paraphrased. */
export const jobReason = (job: Job): string | null => {
	if (job.state === "deferred") return job.lastError ?? "waiting on a gate"
	if (job.state === "failed" || job.state === "expired") return job.lastError
	if (job.state === "queued" && job.notBeforeMs > Date.now())
		return `retrying ${fmtCountdown(job.notBeforeMs).replace(" left", "")} from now`
	return job.lastError
}

/* =============================================================== replay */

/** When the 30-minute replay window closes for a game, or null once it already has. */
export const replayDeadlineMs = (endedAtMs: number): number => endedAtMs + REPLAY_EXPIRY_MS

export const replayCountdown = (endedAtMs: number, now = Date.now()): string | null => {
	const deadline = replayDeadlineMs(endedAtMs)
	if (deadline <= now) return null
	return `replay ${fmtCountdown(deadline, now)}`
}

/* ============================================================== scoring */

export const fmtKda = (k: number, d: number, a: number): string => `${k}/${d}/${a}`

export const fmtKdaRatio = (k: number, d: number, a: number): string =>
	d === 0 ? "Perfect" : ((k + a) / d).toFixed(2)
