/**
 * The HTTP contract between `src/server` and `src/web`.
 *
 * Every route the server exposes has its request and response shape here, as an ArkType
 * validator plus its inferred TS type. The server validates what it returns; the web client
 * validates what it receives. When those disagree, one of them is wrong and you find out
 * immediately instead of three components deep.
 *
 * Route table:
 *   GET  /api/health                     -> HealthResponse
 *   GET  /api/games?limit=               -> GameListResponse
 *   GET  /api/games/:gameId              -> GameDetailResponse
 *   GET  /api/trends?games=              -> TrendsResponse
 *   POST /api/games/:gameId/review       -> JobAccepted
 *   POST /api/games/:gameId/capture      -> JobAccepted
 *   GET  /api/jobs                       -> JobListResponse
 *   POST /api/jobs/:id/cancel            -> OkResponse
 *   POST /api/jobs/:id/retry             -> OkResponse
 *   GET  /api/settings                   -> Settings
 *   PUT  /api/settings   (SettingsPatch) -> Settings
 *   POST /api/sync                       -> SyncResponse
 *   GET  /api/events                     -> text/event-stream (see SseEvent)
 *   GET  /api/media/:id                  -> binary, Range-capable
 */

import { type } from "arktype"
import {
	Game,
	Job,
	Media,
	Metric,
	Moment,
	ParticipantSummary,
	Review,
	TrendSeries
} from "./domain.ts"
import { Settings } from "./settings.ts"

export { parseOrThrow, parseOrNull, SchemaError } from "./lcu.ts"

/* ================================================================ health */

/**
 * The status banner's entire data source. Everything degrades: the client may be closed, the
 * bridge may have failed over to curl, the daemon may be mid-restart. Each field has a
 * defined "unavailable" value rather than going missing.
 */
export const HealthResponse = type({
	/** `ok` = workers running. `starting` = booting. `degraded` = running without the LCU. */
	daemon: "'ok'|'starting'|'degraded'|'stopped'",
	lcu: "'connected'|'disconnected'",
	/** Which transport actually carried the last request. `none` = neither is working. */
	bridge: "'bridge'|'curl'|'none'",
	/** Last known gameflow phase, or null when the client is closed. */
	gameflowPhase: "string|null",
	queueDepth: "number",
	version: "string",
	"analysisVersion?": "number",
	"reviewVersion?": "number",
	"dbPath?": "string",
	"gameCount?": "number",
	"lastSyncMs?": "number|null",
	/** Non-fatal problems worth surfacing: "replay dir not found", "ffmpeg missing". */
	"warnings?": "string[]"
})
export type HealthResponse = typeof HealthResponse.infer

/* ================================================================= games */

/** A game row plus the counts the list view needs to render badges without a second call. */
export const GameListItem = Game.and({
	hasReview: "boolean",
	momentCount: "number",
	mediaCount: "number"
})
export type GameListItem = typeof GameListItem.infer

export const GameListResponse = type({
	games: GameListItem.array()
})
export type GameListResponse = typeof GameListResponse.infer

/**
 * Everything the review screen needs, in one request.
 *
 * `timelineAvailable` is false when the timeline blob is missing — the scoreboard and the
 * review still render, but the minimap, the scrubber and every positional metric must be
 * hidden rather than faked.
 */
export const GameDetailResponse = type({
	game: Game,
	participants: ParticipantSummary.array(),
	metrics: Metric.array(),
	moments: Moment.array(),
	review: Review.or("null"),
	media: Media.array(),
	timelineAvailable: "boolean"
})
export type GameDetailResponse = typeof GameDetailResponse.infer

/* ================================================================ trends */

/**
 * `review` is the cross-game coaching output (`Review.kind === "trend"`), or null if it has
 * not been generated yet. `series` carries the raw points so the UI can show the spread —
 * and each series says for itself whether a trend line is defensible.
 */
export const TrendsResponse = type({
	review: Review.or("null"),
	series: TrendSeries.array(),
	gameCount: "number",
	generatedMs: "number"
})
export type TrendsResponse = typeof TrendsResponse.infer

/* ================================================================== jobs */

export const JobAccepted = type({ jobId: "number" })
export type JobAccepted = typeof JobAccepted.infer

export const JobListResponse = type({ jobs: Job.array() })
export type JobListResponse = typeof JobListResponse.infer

export const OkResponse = type({ ok: "boolean", "note?": "string" })
export type OkResponse = typeof OkResponse.infer

export const SyncResponse = type({
	ok: "boolean",
	"queued?": "number",
	"note?": "string"
})
export type SyncResponse = typeof SyncResponse.infer

/* ================================================================ errors */

/** Every non-2xx response body. `code` is stable, `message` is for humans. */
export const ApiError = type({
	error: "string",
	"code?": "string",
	"detail?": "string"
})
export type ApiError = typeof ApiError.infer

/* =================================================================== SSE */

/**
 * `GET /api/events` is a text/event-stream. Each message has an `event:` name from
 * `SSE_EVENT_NAMES` and a JSON `data:` payload matching the union below. Clients send
 * `Last-Event-ID` and the daemon replays missed rows out of `app_event`, so a tab left open
 * for hours survives a daemon restart.
 */
export const SseJobEvent = type({
	id: "number",
	kind: "string",
	gameId: "number|null",
	state: "string",
	"reason?": "string|null"
})
export type SseJobEvent = typeof SseJobEvent.infer

export const SseGameEvent = type({
	gameId: "number",
	stage: "'ingested'|'analyzed'|'reviewed'|'replay'|'media'"
})
export type SseGameEvent = typeof SseGameEvent.infer

export const SseReviewEvent = type({
	gameId: "number|null",
	reviewId: "string",
	headline: "string"
})
export type SseReviewEvent = typeof SseReviewEvent.infer

export const SseCaptureEvent = type({
	gameId: "number",
	"progress?": "number",
	phase: "string"
})
export type SseCaptureEvent = typeof SseCaptureEvent.infer

export const SseDaemonEvent = type({
	lcu: "'connected'|'disconnected'",
	queueDepth: "number",
	"phase?": "string|null"
})
export type SseDaemonEvent = typeof SseDaemonEvent.infer

export const SseErrorEvent = type({ message: "string", "gameId?": "number|null" })
export type SseErrorEvent = typeof SseErrorEvent.infer

export const SSE_EVENT_NAMES = [
	"job",
	"game",
	"review",
	"capture",
	"daemon",
	"error"
] as const
export type SseEventName = (typeof SSE_EVENT_NAMES)[number]

/** The envelope as the client sees it after parsing one SSE message. */
export interface SseMessage {
	id: number
	name: SseEventName | string
	data: unknown
}

/* ============================================================== settings */

export { Settings, SettingsPatch, DEFAULT_SETTINGS } from "./settings.ts"
export type { Settings as SettingsType } from "./settings.ts"

export const SettingsResponse = Settings
export type SettingsResponse = typeof Settings.infer

/* =============================================================== routes */

/** Canonical route strings, so the client never hand-builds a URL that drifts. */
export const API = {
	health: "/api/health",
	games: "/api/games",
	game: (gameId: number | string) => `/api/games/${gameId}`,
	review: (gameId: number | string) => `/api/games/${gameId}/review`,
	capture: (gameId: number | string) => `/api/games/${gameId}/capture`,
	trends: "/api/trends",
	jobs: "/api/jobs",
	cancelJob: (id: number | string) => `/api/jobs/${id}/cancel`,
	retryJob: (id: number | string) => `/api/jobs/${id}/retry`,
	settings: "/api/settings",
	events: "/api/events",
	media: (id: string) => `/api/media/${encodeURIComponent(id)}`,
	sync: "/api/sync"
} as const
