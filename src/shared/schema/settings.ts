/**
 * User settings. Persisted one key per row in the `settings` table as JSON, read back merged
 * over `DEFAULT_SETTINGS` — so adding a field here is backward compatible with an existing DB
 * and never needs a migration.
 */

import { type } from "arktype"

export const Settings = type({
	/**
	 * Which model the coach runs on. Passed to the Claude Agent SDK, which uses the user's
	 * existing `claude` CLI auth — there is no ANTHROPIC_API_KEY on this machine.
	 */
	model: "string",

	/**
	 * Master switch for INTRUSIVE replay capture, which takes over the League client to
	 * record screenshots and clips. Defaults to FALSE: hijacking someone's game client is a
	 * big enough side effect to deserve an explicit opt-in, with a "capture now" button for a
	 * supervised first try. With it off, every moment still gets a generated SVG map image.
	 */
	captureEnabled: "boolean",

	/** Upper bound on screenshots+clips per game, so one bad game cannot eat the disk. */
	captureMaxPerGame: "number",

	/** Length of each recorded clip, centred on the moment. */
	clipSeconds: "number",

	/** Queue a review automatically as soon as a new game finishes ingesting. */
	autoReviewNewGames: "boolean",

	/** How many recent games the trend review looks at. */
	gamesForTrends: "number",

	/** Delete `.rofl` files older than this. They dominate disk (15 MB each). */
	retentionDays: "number",
	/**
	 * Where the League client writes `.rofl` files. Pointing this somewhere else lets the app
	 * coach replays it never harvested — an archive folder, or games older than the ~20-game
	 * window match history will admit to. Empty means "use the built-in default".
	 */
	replayFolder: "string",
	/**
	 * Minutes a requested capture stays valid. Capture takes over the League client, so a
	 * request has to be tied to the moment it was made: one asked for at 3pm must not fire at
	 * 9pm because that is when the client next went idle. 0 disables the expiry.
	 */
	captureRequestTtlMin: "number",

	/**
	 * 0 = dry and clinical, 1 = full Faker-invoking meme goblin. Scales the persona section
	 * of the prompt only — it must never change what the numbers say.
	 */
	coachIntensity: "0<=number<=1",

	/**
	 * Which model the LIVE coach speaks through.
	 *
	 * `gemini-live` is the socket: native audio, barge-in, about a second. Everything else is an
	 * HTTPS turn the browser speaks with the system voice — slower, and it cannot be cut off
	 * mid-sentence. The trade is real and the settings screen says so.
	 */
	liveProvider: "string",
	/**
	 * The model id within that provider. FREE TEXT on purpose.
	 *
	 * Model ids change faster than this app will be updated — a default written today was already
	 * refused as "no longer available to new users" within a minute of being typed. Empty means the
	 * provider's own default.
	 */
	liveModel: "string",

	/**
	 * How we reach the League client across the WSL2 boundary. `bridge` is a long-lived
	 * Windows-side node.exe over stdio (p50 2.3 ms); `curl` shells out to curl.exe (~88 ms).
	 * The daemon falls back to curl on its own if the bridge will not start.
	 */
	transport: "'bridge'|'curl'",

	/** Poll the LCU this often while idle. Cheap — one request. */
	pollIdleMs: "number",

	/** Poll the Live Client Data API this often while a game is in progress. */
	pollInGameMs: "number",

	/**
	 * Minimum continuous idle time before an intrusive capture may start. Guards against
	 * grabbing the client in the gap between two queue dodges.
	 */
	idleGraceMs: "number",

	/** Never generate more moments than this per game, however bad the game was. */
	maxMomentsPerGame: "number"
})
export type Settings = typeof Settings.infer

export const DEFAULT_SETTINGS: Settings = {
	model: "claude-sonnet-5",
	captureEnabled: false,
	captureMaxPerGame: 6,
	clipSeconds: 20,
	autoReviewNewGames: true,
	gamesForTrends: 20,
	retentionDays: 14,
	replayFolder: "",
	captureRequestTtlMin: 15,
	coachIntensity: 0.8,
	liveProvider: "gemini-live",
	liveModel: "",
	transport: "bridge",
	pollIdleMs: 5_000,
	pollInGameMs: 2_000,
	idleGraceMs: 120_000,
	maxMomentsPerGame: 12
}

/** A partial update from `PUT /api/settings`. Every key optional; unknown keys are dropped. */
export const SettingsPatch = type({
	"+": "delete",
	"model?": "string",
	"captureEnabled?": "boolean",
	"captureMaxPerGame?": "number",
	"clipSeconds?": "number",
	"autoReviewNewGames?": "boolean",
	"gamesForTrends?": "number",
	"retentionDays?": "number",
	"replayFolder?": "string",
	"captureRequestTtlMin?": "number",
	"coachIntensity?": "0<=number<=1",
	"liveProvider?": "string",
	"liveModel?": "string",
	"transport?": "'bridge'|'curl'",
	"pollIdleMs?": "number",
	"pollInGameMs?": "number",
	"idleGraceMs?": "number",
	"maxMomentsPerGame?": "number"
})
export type SettingsPatch = typeof SettingsPatch.infer

/** Clamp a patch into sane ranges so a fat-fingered PUT cannot wedge the daemon. */
export const clampSettings = (s: Settings): Settings => ({
	...s,
	captureMaxPerGame: clamp(s.captureMaxPerGame, 0, 30),
	clipSeconds: clamp(s.clipSeconds, 5, 120),
	gamesForTrends: clamp(s.gamesForTrends, 3, 200),
	retentionDays: clamp(s.retentionDays, 0, 365),
	captureRequestTtlMin: clamp(s.captureRequestTtlMin, 0, 240),
	coachIntensity: clamp(s.coachIntensity, 0, 1),
	pollIdleMs: clamp(s.pollIdleMs, 1_000, 60_000),
	pollInGameMs: clamp(s.pollInGameMs, 500, 30_000),
	idleGraceMs: clamp(s.idleGraceMs, 0, 3_600_000),
	maxMomentsPerGame: clamp(s.maxMomentsPerGame, 1, 50)
})

const clamp = (n: number, lo: number, hi: number): number =>
	!Number.isFinite(n) ? lo : n < lo ? lo : n > hi ? hi : n

/** Models we offer in the picker. The field is free text — this is a convenience list. */
export const MODEL_CHOICES = [
	{ id: "claude-opus-5", label: "Opus 5 — deepest reads, slowest" },
	{ id: "claude-sonnet-5", label: "Sonnet 5 — the default" },
	{ id: "claude-haiku-4-5", label: "Haiku 4.5 — fast and cheap" }
] as const
