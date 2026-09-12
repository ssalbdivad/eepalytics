/**
 * Presentation-only labels, palettes and metric adapters for the web UI.
 *
 * ## Where the numbers went
 *
 * This file used to decide precision too, and it decided it three ways: `fmtCompact` for gold,
 * `toFixed(unitDigits(unit))` for everything else, and a separate `fmtSigned` for deltas that
 * reached for the same `unitDigits` but through a different path. That is how one card ended up
 * printing `1.9k gold` directly above `+1954 vs your avg` — the same quantity, compacted on one
 * line and not on the next.
 *
 * The policy now lives in `shared/num.ts`, alone, and is shared with `shared/debrief-view.ts` so
 * the prose the debrief assembles and the tiles above it round identically. What is left here is
 * what is genuinely about THIS app's vocabulary: which unit a metric carries, what a job state
 * is called, which colour a moment kind is.
 *
 * Nothing in this file invents a value. Where a number is missing the helpers return a dash
 * or an explicit "unknown" — never a zero standing in for absent data.
 */

import { ROLE_LABELS } from "../../shared/schema/domain.ts"
import type {
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
import { fmtDelta, fmtQty } from "../../shared/num.ts"

export {
	fmtAgo,
	fmtClock,
	fmtClockMs,
	fmtCountdown,
	fmtDateTime,
	fmtDuration,
	msUntil
} from "../../shared/time.ts"

/*
 * The number policy, re-exported so a component has one import for "how things are written"
 * rather than having to know which of two modules a given helper lives in.
 */
export {
	MISSING,
	fmtCompact,
	fmtDelta,
	fmtInterval,
	fmtQty,
	statDigits,
	unitSuffix
} from "../../shared/num.ts"

/** Tiny classnames joiner. Falsy entries drop out. */
export const cls = (...parts: (string | false | null | undefined)[]): string =>
	parts.filter(Boolean).join(" ")

/* ============================================================== metrics */

/**
 * A metric's value, its delta and its unit word — all three from the one policy.
 *
 * These are adapters, not formatters: they pull `unit` off the metric and hand it to
 * `shared/num.ts`. That is the whole reason the pairing can no longer drift, because the value
 * and the delta are now two calls with the same unit rather than two different functions.
 */
export const fmtMetricValue = (m: Metric): string => fmtQty(m.value, m.unit)

export const fmtMetricUnit = (m: Metric): string =>
	m.unit === "" || m.unit === "%" ? "" : m.unit

/**
 * The delta line under a tile.
 *
 * `m.value` is passed as the grain reference so the two lines cannot disagree about decimals:
 * `1,879 gold` over `+1,954 vs your avg`, not `1.9k` over `+1954`.
 */
export const fmtMetricDelta = (m: Metric): string =>
	m.vsBaseline === null ? "no baseline" : `${fmtDelta(m.vsBaseline, m.unit, m.value)} vs your avg`

/* =============================================================== labels */

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
	high: "measured",
	medium: "derived from per-minute frames",
	low: "inferred between 1-minute frames — treat as a guess"
}

/** Short chip text. `high` gets no chip at all: certainty is the default, doubt is the news. */
export const confidenceChip = (c: Confidence): string | null =>
	c === "high" ? null : c === "medium" ? "derived" : "inferred"

export const SEVERITY_RANK: Record<FeedbackSeverity, number> = {
	major: 0,
	minor: 1,
	info: 2
}

export const roleLabel = (role: Role): string => ROLE_LABELS[role] ?? "Unknown"

/**
 * One palette for moment kinds, shared by every component that draws one.
 *
 * It lived in `MiniMap.tsx` and was imported from there by the feedback cards and the chat, which
 * meant deleting the 540-line map would have taken two unrelated screens with it. A colour that
 * means one thing everywhere belongs beside the label that means one thing everywhere.
 */
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

/** A ratio is a unitless quantity, so it rounds by the same rule as every other one. */
export const fmtKdaRatio = (k: number, d: number, a: number): string =>
	d === 0 ? "Perfect" : fmtQty((k + a) / d)


/**
 * Coaching categories, in words rather than as the enum key.
 *
 * These are rendered on the two screens someone sees first — the live coach's "what to work on"
 * and the games list — and they were printed raw: "tempo", "objectives", "pathing". Those are
 * fine for a jungle main and mean nothing to the beginner the app is also built for, who cannot
 * look up a word he does not know is a word.
 *
 * The key is kept alongside for anyone who does know it, rather than replaced.
 */
export const CATEGORY_LABEL: Record<string, string> = {
	pathing: "Where you walk",
	tempo: "Keeping busy",
	objectives: "Dragons & barons",
	vision: "Seeing the map",
	farming: "Farming",
	teamfight: "Team fights",
	deaths: "Staying alive",
	praise: "Doing well"
}

/** The friendly label when there is one, the raw key when there is not. */
export const categoryLabel = (key: string): string => CATEGORY_LABEL[key] ?? key

/**
 * The League client's gameflow phase, in words.
 *
 * The status pill and the settings read-out both printed the client's own enum, so the steady
 * state of this app — sitting in the client, doing nothing — read "LCU connected · None" on
 * every screen. "None" is a Riot identifier meaning idle; as a status it looks like a value
 * that failed to load. Unknown phases fall through unchanged rather than being hidden.
 */
export const PHASE_WORD: Record<string, string> = {
	None: "idle",
	Lobby: "in a lobby",
	Matchmaking: "in queue",
	ReadyCheck: "ready check",
	ChampSelect: "champ select",
	GameStart: "starting",
	InProgress: "in game",
	WaitingForStats: "game over",
	PreEndOfGame: "game over",
	EndOfGame: "game over",
	Reconnect: "reconnecting"
}

export const phaseWord = (phase: string | null | undefined): string | null =>
	phase ? (PHASE_WORD[phase] ?? phase) : null
