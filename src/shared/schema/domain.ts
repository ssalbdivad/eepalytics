/**
 * The application's own vocabulary. Everything the DB stores, the API returns and the UI
 * renders is one of these shapes.
 *
 * Two structural commitments worth calling out, because they encode product requirements
 * rather than mere data:
 *
 *  1. **Every `Metric` and every `Moment` carries its own `confidence`.** Timeline frames
 *     arrive once per minute and the median displacement between them is 4082 units — about
 *     28% of the map. We frequently cannot prove who was standing next to whom. A metric
 *     that is inferred from interpolation MUST say so, so the UI can hedge ("likely alone")
 *     and the coaching prompt can be told not to overclaim.
 *  2. **Every `Moment` carries `evidence`.** A one-line, human-checkable statement of what
 *     raw data produced it (which event, which frames, which ids). Never fabricate a stat:
 *     if you cannot write the evidence line, you do not have the moment.
 */

import { type } from "arktype"

export { parseOrThrow, parseOrNull, SchemaError } from "./lcu.ts"

/* ================================================================ scalars */

/** Roles as this app names them. The LCU's own `lane`/`role` fields are garbage — infer. */
export const Role = type("'TOP'|'JGL'|'MID'|'ADC'|'SUP'|'UNKNOWN'")
export type Role = typeof Role.infer

export const ROLES = ["TOP", "JGL", "MID", "ADC", "SUP"] as const

export const ROLE_LABELS: Record<Role, string> = {
	TOP: "Top",
	JGL: "Jungle",
	MID: "Mid",
	ADC: "Bot",
	SUP: "Support",
	UNKNOWN: "Unknown"
}

/**
 * How much we actually trust a number.
 *  - `high`   — read straight off an event or an end-of-game stat.
 *  - `medium` — computed from frame values at the frame boundaries (gold, xp, cs deltas).
 *  - `low`    — depends on interpolating BETWEEN frames, i.e. on a guess about position.
 */
export const Confidence = type("'high'|'medium'|'low'")
export type Confidence = typeof Confidence.infer

/** Colour band for a metric, always relative to the USER'S OWN rolling baseline. */
export const Band = type("'good'|'ok'|'bad'|'unknown'")
export type Band = typeof Band.infer

export const TeamId = type("100|200")
export type TeamId = typeof TeamId.infer

/**
 * Replay availability, as this app tracks it.
 *  - `absent`      — we have never asked the client about it.
 *  - `downloading` — a download job is in flight.
 *  - `available`   — the .rofl is on disk and playable.
 *  - `expired`     — the 30-minute window closed, or Riot no longer serves it. Never retried.
 *  - `pruned`      — we had it and deleted it under the retention policy.
 */
export const ReplayStateDomain = type(
	"'absent'|'downloading'|'available'|'expired'|'pruned'"
)
export type ReplayStateDomain = typeof ReplayStateDomain.infer

/* =================================================================== game */

/**
 * One game, from the user's point of view. The stat block is the USER's slice, denormalised
 * so the game list renders from a single row.
 *
 * `gameDurationSec` is seconds (the LCU's own unit); `gameCreationMs` is epoch ms.
 * `patch` is the two-part form ("16.17"); `gameVersion` keeps the full string because
 * `/lol-replays/v2/metadata/{id}/create` needs it verbatim.
 */
export const Game = type({
	gameId: "number",
	platformId: "string",
	queueId: "number",
	gameMode: "string",
	gameCreationMs: "number",
	gameDurationSec: "number",
	endedAtMs: "number",
	patch: "string",
	gameVersion: "string",
	win: "boolean",
	participantId: "number",
	teamId: "number",
	championId: "number",
	championName: "string",
	role: Role,
	roleConfidence: Confidence,
	kills: "number",
	deaths: "number",
	assists: "number",
	/** Lane minions. Junglers score near zero here — see `jungleCs`. */
	cs: "number",
	/** Jungle camps + scuttle. For a jungler this is "CS". */
	jungleCs: "number",
	gold: "number",
	visionScore: "number",
	champLevel: "number",
	damageToChampions: "number",
	replayState: ReplayStateDomain,
	"replayPath?": "string|null",
	/** Whether the raw timeline blob is on disk. Without it there is no positional analysis. */
	hasTimeline: "boolean",
	/**
	 * 0-100 against the player's OWN recent form, or null when the corpus is too thin to grade.
	 * Not a skill rating and not a comparison to other players — this app has no data about
	 * anyone else. 50 is an ordinary game for them.
	 */
	"gradeScore?": "number|null",
	"gradeRank?": "string|null",
	analysisVersion: "number",
	reviewVersion: "number",
	ingestedAtMs: "number"
})
export type Game = typeof Game.infer

/* ========================================================== participants */

/** One of the ten players. `riotId` is `"Name#TAG"`; `summonerName` is always "" now. */
export const ParticipantSummary = type({
	gameId: "number",
	participantId: "number",
	teamId: "number",
	puuid: "string",
	riotId: "string",
	championId: "number",
	championName: "string",
	role: Role,
	roleConfidence: Confidence,
	isUser: "boolean",
	kills: "number",
	deaths: "number",
	assists: "number",
	cs: "number",
	jungleCs: "number",
	gold: "number",
	visionScore: "number",
	champLevel: "number",
	damageToChampions: "number",
	win: "boolean",
	"spell1Id?": "number",
	"spell2Id?": "number",
	"items?": "number[]"
})
export type ParticipantSummary = typeof ParticipantSummary.infer

/* ================================================================ metric */

/**
 * A single measured number, ready to render.
 *
 * `vsBaseline` is the delta against the user's own rolling baseline over recent games, in the
 * metric's own unit — `null` when there is not enough history to compare honestly. `band`
 * must be `"unknown"` whenever `vsBaseline` is null: do not colour a number you cannot rank.
 *
 * `explain` is shown on hover AND handed to Claude. Write it as a sentence a human can check
 * against the game ("14 camps by 8:00, vs your 20-game median of 18").
 */
export const Metric = type({
	key: "string",
	label: "string",
	value: "number",
	/** "", "cs", "gold", "/min", "%", "s" — free text, rendered next to the value. */
	unit: "string",
	band: Band,
	vsBaseline: "number|null",
	confidence: Confidence,
	explain: "string",
	/**
	 * The rolling baseline this metric is judged against, restated at DIGEST time from the live
	 * corpus. Persisted rows do not carry these — `explain` froze a baseline at analysis time and
	 * the 20-game window has moved on since. `buildGameDigest` fills them so the prompt can print
	 * the average on the metric's OWN line, which is what stops the coach attributing one
	 * metric's average to another. Optional so DB reads stay valid.
	 */
	"baselineMean?": "number|null",
	"baselineSd?": "number|null",
	"baselineN?": "number|null",
	/**
	 * The baseline rendered ONCE, as the exact words every consumer prints. Two call sites
	 * formatting the same mean at different precision ("0.9" and "0.94") reintroduces the
	 * ambiguity these fields exist to remove, so the string is authored in one place.
	 */
	"baselineText?": "string"
})
export type Metric = typeof Metric.infer

/* =========================================================== watch note */

/**
 * What the coach saw in the replay frames for one moment.
 *
 * Separate from `FeedbackItem` on purpose. A feedback item's figures came from the digest and
 * are mechanically checkable; a visual read's evidence is a picture, and nothing can check it.
 * Keeping them apart keeps that difference visible rather than trusting everyone to remember it.
 */
export const WatchNote = type({
	id: "string",
	gameId: "number",
	momentId: "string",
	text: "string",
	model: "string|null",
	costUsd: "number|null",
	/** How many frames the read was based on. Fewer frames, weaker read. */
	frameCount: "number",
	status: "'ok'|'failed'",
	error: "string|null",
	createdMs: "number"
})
export type WatchNote = typeof WatchNote.infer

/* ============================================================ chat */

/**
 * One turn of a conversation about a game.
 *
 * The coach's replies carry citations for the same reason feedback items do: an answer that
 * names a moment can show the map image beside it, and an answer that names a metric can show
 * the number. An uncited reply renders as opinion, which is what the whole app exists to avoid.
 */
export const ChatRole = type("'user'|'coach'")
export type ChatRole = typeof ChatRole.infer

export const ChatMessage = type({
	id: "string",
	gameId: "number",
	role: ChatRole,
	content: "string",
	/** Null on a user turn. */
	model: "string|null",
	costUsd: "number|null",
	citedMomentIds: "string[]",
	citedMetricKeys: "string[]",
	status: "'ok'|'failed'",
	error: "string|null",
	createdMs: "number"
})
export type ChatMessage = typeof ChatMessage.infer

/* ================================================================ moment */

/**
 * Something worth looking at, anchored to a game-clock second and a map position.
 * Moments are the spine of the review screen: the timeline scrubber, the minimap dots, the
 * media generation and Claude's citations all key off them.
 */
export const MomentKind = type(
	"'death'|'kill'|'objective'|'objective_missed'|'gold_swing'|'tempo'|'cs_gap'|'positioning'|'vision'|'teamfight'|'recall'|'other'"
)
export type MomentKind = typeof MomentKind.infer

/** Where the replay camera should point. `null` means "use the moment's own position". */
export const CameraTarget = type({ x: "number", y: "number" }).or("null")
export type CameraTarget = typeof CameraTarget.infer

export const Moment = type({
	/** Deterministic — see `makeMomentId`. Re-running analysis must not churn ids. */
	id: "string",
	gameId: "number",
	/** Game clock, seconds. */
	tSec: "number",
	kind: MomentKind,
	title: "string",
	/** 0 = trivia, 1 = the thing that lost the game. Drives ordering. */
	severity: "0<=number<=1",
	mapX: "number",
	mapY: "number",
	/**
	 * Where the replay camera should be pointed, when that differs from the event position
	 * (e.g. look at the objective the user was NOT at). `null` means "use mapX/mapY".
	 */
	cameraTarget: CameraTarget,
	participantsInvolved: "number[]",
	/** Gold swing attributable to the moment, or `null` when it cannot be computed honestly. */
	costGold: "number|null",
	confidence: Confidence,
	/** One line naming the raw data behind this. If you cannot write it, drop the moment. */
	evidence: "string"
})
export type Moment = typeof Moment.infer

/**
 * Stable id for a moment: `g<gameId>-<kind>-<tSec rounded>-<suffix>`. Deterministic so that
 * re-running analysis replaces moments in place and existing media/feedback keep pointing
 * at the right thing.
 */
export const makeMomentId = (
	gameId: number,
	kind: string,
	tSec: number,
	suffix: string | number = ""
): string =>
	`g${gameId}-${kind}-${Math.round(tSec)}${suffix === "" ? "" : `-${suffix}`}`

/* ============================================================== feedback */

/** How loud a coaching point is. Not the same scale as `Moment.severity` (which is 0..1). */
export const FeedbackSeverity = type("'info'|'minor'|'major'")
export type FeedbackSeverity = typeof FeedbackSeverity.infer

/**
 * One coaching point. `momentIds` / `mediaIds` / `metricKeys` are the citations — the UI
 * turns each into a clickable jump, and an item that cites nothing is rendered as opinion.
 */
export const FeedbackItem = type({
	id: "string",
	gameId: "number|null",
	title: "string",
	/**
	 * Elaboration: the reasoning, the evidence, the joke. Collapsed by default — the reader
	 * opens it when the headline made them want the detail, not before.
	 */
	body: "string",
	severity: FeedbackSeverity,
	/**
	 * THE ACTIONABLE HALF. One imperative sentence naming what to do differently next game.
	 *
	 * Split out of `body` because it was the only part that changes behaviour and it was buried
	 * mid-paragraph. Always rendered; never collapsed. Empty only on reviews written before the
	 * split.
	 */
	fix: "string",
	/**
	 * How much this plausibly cost, as a JUDGMENT grounded in a figure from the digest — a gold
	 * swing, objectives conceded, the cost of a death.
	 *
	 * Deliberately not a win-rate delta. Nothing in this data supports computing one, and a
	 * percentage that looks derived but is guessed is the exact fabrication the rest of the app
	 * is built to prevent. Ordinal, comparable, honest.
	 */
	impact: Confidence,
	/** Whether the fix is a rule he can follow mid-game, or a vibe. */
	actionability: Confidence,
	/** Whether the read is solid enough to change behaviour over. */
	confidence: Confidence,
	/** Derived from the three above by `rankItems()`. Higher sorts first. */
	priority: "number",
	/** Optional coaching bucket: "pathing", "vision", "objectives", "teamfight", "farming". */
	"category?": "string",
	momentIds: "string[]",
	mediaIds: "string[]",
	metricKeys: "string[]",
	/** Game clock the item points at, or `null` for a whole-game / cross-game point. */
	tSec: "number|null",
	/**
	 * Figures in this item's prose the parser could not tie back to the digest — currently only
	 * baseline claims ("your own average of X" where X is no cited metric's average).
	 *
	 * The item still renders. Dropping good coaching over a regex is the worse trade, but so is
	 * logging the problem to the daemon and showing the reader an unmarked number: an
	 * unverifiable figure must not look like a measured one.
	 */
	"warnings?": "string[]"
})
export type FeedbackItem = typeof FeedbackItem.infer

/* ================================================================ review */

export const ReviewKind = type("'game'|'trend'")
export type ReviewKind = typeof ReviewKind.infer

/**
 * One run of the coach. `gameId` is null for a `"trend"` review, which spans recent games.
 *
 * `promptHash` is sha256(digest || prompt template || model). Changing the template
 * re-reviews automatically without anyone bumping a constant; `analysisVersion` records the
 * metric code that produced the input, so a formula change does not silently invalidate a
 * review that was correct for the data it saw.
 */
export const Review = type({
	id: "string",
	gameId: "number|null",
	kind: ReviewKind,
	model: "string",
	createdMs: "number",
	promptHash: "string",
	analysisVersion: "number",
	/** The one-liner. Meme-y, but it has to be true. */
	headline: "string",
	/** The obligatory bit of hype. Kept separate so the UI can style it apart from critique. */
	encouragement: "string",
	items: FeedbackItem.array(),
	/** 1-3 concrete things to do in the next games. */
	goals: "string[]",
	"status?": "'ok'|'failed'",
	"error?": "string|null",
	"durationMs?": "number|null",
	"inputTokens?": "number|null",
	"outputTokens?": "number|null",
	"costUsd?": "number|null"
})
export type Review = typeof Review.infer

/* ================================================================= media */

/**
 * A picture or clip attached to a moment.
 *
 * `kind: "map"` with `source: "generated"` is what every moment actually gets: an SVG the app
 * renders from timeline positions. It needs no client, no replay and no network, which is why
 * it is the floor rather than a fallback. `screenshot` and `clip` are kinds the retired replay
 * capture wrote; no code writes them any more.
 */
export const MediaKind = type("'screenshot'|'clip'|'map'")
export type MediaKind = typeof MediaKind.infer

/**
 * Where a picture came from, and it is an evidential claim rather than a filing detail.
 *
 * `generated` is a diagram this app drew from the timeline — a map with dots on it. `journal` is a
 * real frame of his own screen, captured while he played, and is the ONLY source that can support
 * a statement about how a fight actually went. `replay` is the retired capture path: it never
 * wrote a row and nothing writes one now, but it stays in the union so that if a row ever turns
 * up in a backup it parses instead of taking a review down with it.
 */
export const MediaSource = type("'replay'|'generated'|'journal'")
export type MediaSource = typeof MediaSource.infer

export const Media = type({
	id: "string",
	gameId: "number",
	momentId: "string|null",
	kind: MediaKind,
	/** Path relative to DATA_DIR. Served through `GET /api/media/:id`, never as a raw path. */
	path: "string",
	width: "number",
	height: "number",
	/** Game clock the media depicts. */
	tSec: "number",
	createdMs: "number",
	source: MediaSource,
	"durationSec?": "number|null",
	"bytes?": "number|null",
	"mimeType?": "string|null"
})
export type Media = typeof Media.infer

/* =================================================================== job */

/**
 * Job kinds, in dependency order.
 *
 * WIDER THAN `JOB_KINDS` in ../constants.ts, deliberately: `replay-capture` is retired — no
 * handler, no enqueue path, nothing that can start one — but the `job` table still holds rows
 * of that kind from before it was removed, and `JobListResponse` validates what it returns. Drop
 * the member and the Queue screen 500s on the user's own history.
 */
export const JobKind = type(
	"'match-ingest'|'replay-download'|'analysis-run'|'review-game'|'review-trend'|'replay-capture'|'media-generate'"
)
export type JobKind = typeof JobKind.infer

/**
 * Queue states.
 *  - `queued`   — runnable once `notBeforeMs` passes.
 *  - `leased`   — a worker holds it; the lease expires so a crash cannot strand it.
 *  - `deferred` — a gate said no right now (`lastError` carries the reason); re-evaluated each tick.
 *  - `done` / `failed` — terminal. Cancelling from the UI lands in `failed` with
 *    `lastError = "cancelled"`, so "why did this not run" always has one place to look.
 *  - `expired`  — missed `deadlineMs`, or gave up after a day of deferrals. A replay download
 *    that expires is never retried; the .rofl is gone.
 */
export const JobState = type(
	"'queued'|'leased'|'done'|'failed'|'deferred'|'expired'"
)
export type JobState = typeof JobState.infer

export const Job = type({
	id: "number",
	kind: JobKind,
	gameId: "number|null",
	state: JobState,
	/** Always false now. Rows from the retired `replay-capture` kind still carry true. */
	intrusive: "boolean",
	attempts: "number",
	maxAttempts: "number",
	priority: "number",
	lastError: "string|null",
	/** Earliest wall-clock ms at which this may run (backoff, or "wait for the client"). */
	notBeforeMs: "number",
	/** Hard wall-clock deadline. Replay downloads get `endedAtMs + 30min`. */
	deadlineMs: "number|null",
	"leaseUntilMs?": "number|null",
	/** Job-specific JSON. Kept opaque here so job handlers own their own payload shapes. */
	"payload?": "object",
	createdMs: "number",
	updatedMs: "number"
})
export type Job = typeof Job.infer

/** A job the daemon wants to create. Everything not given gets a sensible default. */
export const JobRequest = type({
	kind: JobKind,
	"gameId?": "number|null",
	"priority?": "number",
	"intrusive?": "boolean",
	"notBeforeMs?": "number",
	"deadlineMs?": "number|null",
	"maxAttempts?": "number",
	"payload?": "object"
})
export type JobRequest = typeof JobRequest.infer

export const isTerminal = (state: JobState): boolean =>
	state === "done" || state === "failed" || state === "expired"

/* =============================================================== events */

/** A row of the SSE feed. `id` is monotonic so a reconnecting client can replay from it. */
export const AppEvent = type({
	id: "number",
	atMs: "number",
	kind: "string",
	gameId: "number|null",
	payload: "object"
})
export type AppEvent = typeof AppEvent.infer

/**
 * Event kinds the daemon emits. The UI switches on these; unknown kinds are ignored.
 *
 * `capture` is retired along with the subsystem that published it. It stays listed because the
 * `app_event` table still holds rows of that kind and the feed replays from an id.
 */
export const APP_EVENT_KINDS = [
	"job",
	"game",
	"review",
	"capture",
	"daemon",
	"error"
] as const

/* ============================================================== trends */

/**
 * One metric tracked across games.
 *
 * `trendable` is the honesty switch. Most per-game metrics are too noisy over 20 games for a
 * slope to mean anything; when `trendable` is false the UI must render the points WITHOUT a
 * trend line and `note` explains why ("n=8, spread swamps the slope"). `ci95` is null when
 * the sample is too small to compute one.
 *
 * `trendable` alone is NOT permission to draw a direction. It says the LEVEL is stable enough
 * to quote. `slopeSignificant` is the separate, stricter switch: it is true only when the
 * least-squares slope's own 95% CI excludes zero, which `.research/analytics.md` §7.3 makes
 * the precondition for ever saying "improving" or "declining" — and a drawn trend line is
 * exactly that claim in picture form. `null`/absent means "not computed", which the UI must
 * treat as "do not draw a line".
 */
export const TrendSeries = type({
	key: "string",
	label: "string",
	points: type({ gameId: "number", tMs: "number", value: "number" }).array(),
	mean: "number",
	ci95: "number|null",
	trendable: "boolean",
	"slopeSignificant?": "boolean|null",
	"slopePerGame?": "number|null",
	note: "string"
})
export type TrendSeries = typeof TrendSeries.infer

/* ============================================================== helpers */

export const kda = (g: { kills: number; deaths: number; assists: number }): number =>
	g.deaths === 0 ? g.kills + g.assists : (g.kills + g.assists) / g.deaths

/** For a jungler "CS" means camps. Use this everywhere rather than picking `cs` blindly. */
export const effectiveCs = (p: {
	role: Role
	cs: number
	jungleCs: number
}): number => (p.role === "JGL" ? p.jungleCs : p.cs + p.jungleCs)

export const csPerMin = (
	p: { role: Role; cs: number; jungleCs: number },
	durationSec: number
): number => (durationSec <= 0 ? 0 : effectiveCs(p) / (durationSec / 60))

/** A replay we could still act on. */
export const replayIsActionable = (state: ReplayStateDomain): boolean =>
	state === "available" || state === "downloading"
