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
	ChatMessage,
	WatchNote,
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
/**
 * Vanguard's service state, as Windows reports it.
 *
 * "The League client is not running" is true and useless. On Windows the usual cause is Riot's
 * kernel anti-cheat, which must be up before League will start and whose failures are silent.
 * `problems` is empty when nothing is provably wrong — which is NOT the same as healthy, since
 * a pending post-update reboot leaves both services reporting RUNNING.
 */
export const VanguardReport = type({
	vgk: "'running'|'stopped'|'not-installed'|'unknown'",
	vgc: "'running'|'stopped'|'not-installed'|'unknown'",
	probed: "boolean",
	problems: "string[]",
	advice: "string[]"
})
export type VanguardReport = typeof VanguardReport.infer

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
	"warnings?": "string[]",
	/**
	 * Why the client is unreachable, when it is. Absent while the LCU is connected — there is
	 * nothing to diagnose and probing costs a Windows round trip.
	 */
	"vanguard?": VanguardReport,
	/**
	 * The capture gate's verdict, in its own words. Declared rather than passed through
	 * undeclared so the UI can render "why is nothing happening" without guessing at it.
	 */
	"capture?": type({ allowed: "boolean", reason: "string" })
})
export type HealthResponse = typeof HealthResponse.infer

/* ================================================================= games */

/** A game row plus the counts the list view needs to render badges without a second call. */
export const GameListItem = Game.and({
	hasReview: "boolean",
	momentCount: "number",
	mediaCount: "number",
	/** The review's headline, so the list renders in one request instead of one per row. */
	"headline?": "string|null",
	/** Moments with real captured replay frames — what a visual pass could look at. */
	"frameMoments?": "number",
	/** Moments actually watched. The three states (0 frames / frames / watched) each have a
	 *  different next action, which is why this is two numbers and not a flag. */
	"watchedMoments?": "number"
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

/* =============================================================== watch */

export const WatchListResponse = type({ notes: WatchNote.array() })
export type WatchListResponse = typeof WatchListResponse.infer

/* ================================================================ live */

/**
 * The live overlay's whole payload. Every field after `inGame` is optional because "not in a
 * game" is the normal case and must answer 200 with something truthful rather than erroring.
 */
export const LiveNudge = type({
	kind: "'pace'|'objective'|'praise'",
	text: "string",
	priority: "number",
	/** What the nudge was derived from, so nothing on screen is unattributable. */
	source: "string"
})
export type LiveNudge = typeof LiveNudge.infer

export const LiveResponse = type({
	inGame: "boolean",
	"reason?": "string",
	"gameTimeSec?": "number",
	"championName?": "string",
	"score?": type({
		kills: "number",
		deaths: "number",
		assists: "number",
		cs: "number",
		level: "number"
	}),
	nudges: LiveNudge.array(),
	"focus?": type({ category: "string", games: "number", fix: "string" }).array()
})
export type LiveResponse = typeof LiveResponse.infer

/* ================================================================ form */

/**
 * Standing at a glance: the grade curve, and the three habits worth working on.
 *
 * Both are DERIVED from data already stored — grades computed at analysis time, focus areas
 * aggregated from reviews already paid for. No model call, so this is instant and identical
 * every time it is asked.
 */
export const FocusArea = type({
	category: "string",
	/** Distinct games this appeared in. Shown always: it is what separates a habit from a game. */
	games: "number",
	occurrences: "number",
	weight: "number",
	exemplar: type({ gameId: "number|null", title: "string", fix: "string" }),
	fixes: "string[]"
})
export type FocusArea = typeof FocusArea.infer

export const FormResponse = type({
	/** Newest first. 0-100 against the player's own baseline, never against other players. */
	grades: type({ gameId: "number", score: "number", rank: "string" }).array(),
	/** Mean of the recent window, or null under three graded games. */
	rollingAverage: "number|null",
	/** Same for the window before it, so the UI can show movement rather than a bare number. */
	previousAverage: "number|null",
	focus: FocusArea.array(),
	/** How many games the focus areas were mined from. */
	windowGames: "number"
})
export type FormResponse = typeof FormResponse.infer

/* =============================================================== replays */

/**
 * One `.rofl` on disk. `inLibrary` says the game was also harvested from match history, which
 * is what decides whether a review gets a timeline — the file itself has none.
 */
export const ReplayFileInfo = type({
	fileName: "string",
	path: "string",
	gameId: "number|null",
	platformId: "string|null",
	bytes: "number",
	mtimeMs: "number",
	/** False when the file could not be decoded. It is still listed. */
	readable: "boolean",
	/**
	 * Players in the trailing stat block. Normally 10; **0 on a remake** — a game short enough
	 * to be remade has no end-of-game stats written at all, so the file is valid and empty.
	 * Distinguishing that from a decode failure is the difference between "nothing to coach
	 * here" and "something is wrong".
	 */
	playerCount: "number",
	patch: "string|null",
	durationSec: "number|null",
	championName: "string|null",
	role: "string|null",
	win: "boolean|null",
	kills: "number|null",
	deaths: "number|null",
	assists: "number|null",
	cs: "number|null",
	inLibrary: "boolean",
	hasTimeline: "boolean"
})
export type ReplayFileInfo = typeof ReplayFileInfo.infer

export const ReplayListResponse = type({
	/** The folder actually scanned, so the UI can show it and say when it is empty. */
	folder: "string",
	replays: ReplayFileInfo.array()
})
export type ReplayListResponse = typeof ReplayListResponse.infer

/* ================================================================== chat */

export const ChatHistoryResponse = type({ messages: ChatMessage.array() })
export type ChatHistoryResponse = typeof ChatHistoryResponse.infer

/**
 * One completed exchange. `media` is the images for the moments the answer cited, so the UI can
 * show the pictures beside the reply without a second round trip.
 */
export const ChatTurnResponse = type({
	user: ChatMessage,
	coach: ChatMessage,
	media: Media.array()
})
export type ChatTurnResponse = typeof ChatTurnResponse.infer

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
	"chat",
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
	chat: (gameId: number | string) => `/api/games/${gameId}/chat`,
	trends: "/api/trends",
	jobs: "/api/jobs",
	cancelJob: (id: number | string) => `/api/jobs/${id}/cancel`,
	retryJob: (id: number | string) => `/api/jobs/${id}/retry`,
	settings: "/api/settings",
	events: "/api/events",
	media: (id: string) => `/api/media/${encodeURIComponent(id)}`,
	sync: "/api/sync",
	form: "/api/form",
	live: "/api/live",
	watch: (gameId: number | string) => `/api/games/${gameId}/watch`,
	replays: "/api/replays",
	replayIngest: "/api/replays/ingest"
} as const
