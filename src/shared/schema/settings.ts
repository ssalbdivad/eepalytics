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
	 * 0 = dry and clinical, 1 = full Faker-invoking meme goblin. Scales the persona section
	 * of the prompt only — it must never change what the numbers say.
	 */
	coachIntensity: "0<=number<=1",

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

	/** Never generate more moments than this per game, however bad the game was. */
	maxMomentsPerGame: "number"
})
export type Settings = typeof Settings.infer

export const DEFAULT_SETTINGS: Settings = {
	model: "claude-sonnet-5",
	autoReviewNewGames: true,
	gamesForTrends: 20,
	retentionDays: 14,
	replayFolder: "",
	coachIntensity: 0.8,
	transport: "bridge",
	pollIdleMs: 5_000,
	pollInGameMs: 2_000,
	maxMomentsPerGame: 12
}

/**
 * A partial update from `PUT /api/settings`. Every key optional; unknown keys are dropped.
 *
 * `"+": "delete"` is what makes the stale replay-capture keys still sitting in the `settings`
 * table harmless: a UI round trip cannot write them back, and `getSettings` merges anything
 * unrecognised straight through. They are left in the database on purpose — the owner keeps
 * measurements, and a settings row is a record of what the app was configured to do.
 */
export const SettingsPatch = type({
	"+": "delete",
	"model?": "string",
	"autoReviewNewGames?": "boolean",
	"gamesForTrends?": "number",
	"retentionDays?": "number",
	"replayFolder?": "string",
	"coachIntensity?": "0<=number<=1",
	"transport?": "'bridge'|'curl'",
	"pollIdleMs?": "number",
	"pollInGameMs?": "number",
	"maxMomentsPerGame?": "number"
})
export type SettingsPatch = typeof SettingsPatch.infer

/** Clamp a patch into sane ranges so a fat-fingered PUT cannot wedge the daemon. */
export const clampSettings = (s: Settings): Settings => ({
	...s,
	gamesForTrends: clamp(s.gamesForTrends, 3, 200),
	retentionDays: clamp(s.retentionDays, 0, 365),
	coachIntensity: clamp(s.coachIntensity, 0, 1),
	pollIdleMs: clamp(s.pollIdleMs, 1_000, 60_000),
	pollInGameMs: clamp(s.pollInGameMs, 500, 30_000),
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
