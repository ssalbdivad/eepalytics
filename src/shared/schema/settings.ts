/**
 * User settings. Persisted one key per row in the `settings` table as JSON, read back merged
 * over `DEFAULT_SETTINGS` — so adding a field here is backward compatible with an existing DB
 * and never needs a migration.
 */

import { type } from "arktype"
import { DEFAULT_LIVE_COACH_MODE } from "../live-coach-mode.ts"

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
	 * Which ARCHITECTURE the live coach runs on. See `shared/live-coach-mode.ts` for the run.
	 *
	 * `trusted` is the default and the only unmeasured one: the whole brief every few seconds, both
	 * champions' notes as prose, and nothing telling her what to say or when. `cite-or-quiet` gives
	 * her the ground-truth block, the frame and the persona under one rule — cite it or say nothing.
	 * `fenced` is the old shape, where `analysis/live-facts.ts` ranks every candidate line in
	 * TypeScript and she may only pick from that list.
	 *
	 * Measured across 363 real samples from four games, judged blind: the fence spoke on 11 of 102
	 * turns and cite-or-quiet on 94, with fabrication 0 in both — 81 useful lines a game against 6.
	 * The fence was never buying the honesty; the citation rule was. Both stay selectable because
	 * they are measured arms — a stored run has to keep describing a prompt this repo can still
	 * produce, or the evidence is gone — and because a coach that says almost nothing is the right
	 * coach for someone who wants almost nothing said.
	 */
	liveCoachMode: "'trusted'|'cite-or-quiet'|'fenced'",

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
	liveProvider: "gemini-live",
	liveModel: "",
	liveCoachMode: DEFAULT_LIVE_COACH_MODE,
	transport: "bridge",
	pollIdleMs: 5_000,
	pollInGameMs: 2_000,
	maxMomentsPerGame: 12
}

/** A partial update from `PUT /api/settings`. Every key optional; unknown keys are dropped. */
export const SettingsPatch = type({
	"+": "delete",
	"model?": "string",
	"autoReviewNewGames?": "boolean",
	"gamesForTrends?": "number",
	"retentionDays?": "number",
	"replayFolder?": "string",
	"coachIntensity?": "0<=number<=1",
	"liveProvider?": "string",
	"liveModel?": "string",
	"liveCoachMode?": "'trusted'|'cite-or-quiet'|'fenced'",
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

/**
 * Which settings this install has OVERRIDDEN, and what the code would have used instead.
 *
 * A stored row outranks the code default forever — that is the price of the migration-free
 * merge in `getSettings()`, and it is the mechanism that switched the post-game review path off
 * for eight days without anything saying so. So the override set is computed and SHOWN: the
 * daemon logs it at boot and the Settings screen prints the default beside every field that no
 * longer follows it. The disagreement is allowed; being unable to see it is not.
 *
 * Pure and browser-safe, so the log line and the UI cannot drift apart.
 */
export const settingsOverrides = (
	s: Settings
): { key: keyof Settings; value: unknown; default: unknown }[] => {
	const out: { key: keyof Settings; value: unknown; default: unknown }[] = []
	for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
		const mine = s[key]
		const theirs = DEFAULT_SETTINGS[key]
		if (mine !== theirs) out.push({ key, value: mine, default: theirs })
	}
	return out
}

/** One line naming every override, for a log. Empty string when there are none. */
export const describeSettingsOverrides = (s: Settings): string =>
	settingsOverrides(s)
		.map(o => `${o.key}=${JSON.stringify(o.value)} (default ${JSON.stringify(o.default)})`)
		.join(", ")

const clamp = (n: number, lo: number, hi: number): number =>
	!Number.isFinite(n) ? lo : n < lo ? lo : n > hi ? hi : n

/** Models we offer in the picker. The field is free text — this is a convenience list. */
export const MODEL_CHOICES = [
	{ id: "claude-opus-5", label: "Opus 5 — deepest reads, slowest" },
	{ id: "claude-sonnet-5", label: "Sonnet 5 — the default" },
	{ id: "claude-haiku-4-5", label: "Haiku 4.5 — fast and cheap" }
] as const
