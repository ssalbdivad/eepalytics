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
	 * HOW OFTEN the live coach is asked to say anything — see `SPEAK_LEVELS` in
	 * `src/analysis/live-events.ts`, which owns the mechanism, the three ask sets and the numbers.
	 *
	 * It moves WHICH ASKS FIRE and nothing else. No prompt changes, no subject is forbidden and no
	 * sentence is suppressed — a question not asked is a moment she was left alone, which is the
	 * only lever this repo will pull on volume.
	 *
	 * `big-calls` is the default and it is a deliberate change of default: replayed over 28 real
	 * games it speaks 7.8 times in a 28-minute game against `commentary`'s 26.2, for 6.4 clean-useful
	 * lines against 18.8. That is a third of the good lines and a third of the talking, and the bet
	 * — his, stated in his own words — is that the good lines already exist and are buried.
	 *
	 * The union is spelled out rather than imported so this file keeps its one-way dependency on
	 * `shared/`; `live-events.test.ts` asserts the two lists and the two defaults agree.
	 */
	liveSpeakLevel: "'commentary'|'key-moments'|'big-calls'",

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
	liveSpeakLevel: "big-calls",
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
	"liveSpeakLevel?": "'commentary'|'key-moments'|'big-calls'",
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

/* ======================================================= the 2026-09-18 audit */

/**
 * WHICH SETTINGS A PERSON MAY ACTUALLY SEE, and where.
 *
 * Every field above is read by the daemon, so none of them could be deleted from the schema
 * without editing code this audit did not own. What WAS decided is narrower and more useful:
 * which of them a human is ever shown, and how deep. A setting that exists because we were
 * unsure is a decision we failed to make, and the fix for that is to make the decision here
 * rather than to hand it to him three screens deep.
 *
 * The three lists PARTITION `DEFAULT_SETTINGS` and `settings.test.ts` asserts it, so adding a
 * field to the schema without filing it under one of these fails the suite. That is the whole
 * point: the Settings screen grew all campaign because every new knob had somewhere obvious to
 * go and nowhere obvious to be refused.
 *
 *   SIMPLE      — on the first screen, no disclosure. Two of them.
 *   ADVANCED    — behind one `<details>`, with its measurement printed beside it.
 *   UNEXPOSED   — no control anywhere. The stored value still wins, the daemon still reads it,
 *                 and the override banner still names it with a one-click reset — being unable
 *                 to SET it is not the same as being unable to SEE it, and the eight-day review
 *                 outage came from the second thing, not the first.
 */

/**
 * The first screen. Nothing else earns that place.
 *
 * `liveSpeakLevel` is the one knob he has asked for in every session, and it is the only lever
 * in the app on how much the coach talks. `coachIntensity` is the personality dial: it changes
 * the jokes and never a number, which is exactly the kind of thing a person legitimately wants
 * to move and nobody can pick for him.
 */
export const SIMPLE_SETTING_KEYS = ["liveSpeakLevel", "coachIntensity"] as const

/**
 * Behind one disclosure, each with the measurement that says why the default is the default.
 *
 * - `liveCoachMode` — three architectures, all measured, `trusted` shipped. Kept selectable
 *   because the stored runs are only meaningful while the prompts that produced them exist.
 * - `liveProvider` / `liveModel` — five models were indistinguishable on both paths, and only
 *   the Gemini socket speaks natively at ~1.2s. Free text on purpose: a model id died inside a
 *   minute of being typed as a default.
 * - `model` — the reviewer's. Same indistinguishability result; same escape hatch.
 * - `gamesForTrends` — the Trends screen has its own per-view window picker, so this is really
 *   the daemon's baseline corpus size, which is not a thing to tune between games.
 * - `retentionDays` / `replayFolder` — disk and where the client writes. Real, rare.
 */
export const ADVANCED_SETTING_KEYS = [
	"liveCoachMode",
	"liveProvider",
	"liveModel",
	"model",
	"gamesForTrends",
	"retentionDays",
	"replayFolder"
] as const

/**
 * No control, anywhere. Each one is a decision, and each one is written down.
 *
 * - `autoReviewNewGames` — has exactly one correct value. Its wrong value switched the only
 *   human-graded tier of this product off for eight days while the checkbox rendered `false`
 *   and looked like a field nobody had touched. A checkbox whose other position is "silently
 *   break the product" is not a setting.
 * - `transport` — the daemon falls back from bridge to curl on its own, and the diagnostics
 *   panel prints which one actually carried the last request. There is nothing for a person
 *   to decide that the code does not already decide better and report afterwards.
 * - `pollIdleMs` / `pollInGameMs` — milliseconds between LCU polls. No user-facing meaning,
 *   clamped at both ends, and nothing downstream of them is a coaching decision.
 * - `maxMomentsPerGame` — 12 is the number the review prompt is written against ("three that
 *   matter beats six that pad"). Moving it does not get more coaching, it gets more rows.
 */
export const UNEXPOSED_SETTING_KEYS = [
	"autoReviewNewGames",
	"transport",
	"pollIdleMs",
	"pollInGameMs",
	"maxMomentsPerGame"
] as const

/**
 * The persona dial, as three stops instead of twenty-one.
 *
 * It was a `step={0.05}` slider printing two decimals beside it, which is false precision about
 * a quantity nobody has ever measured: there is no run anywhere in this repo comparing 0.75 to
 * 0.80. Three stops is what the prompt itself actually describes (`Part 2 — Intensity` names
 * three bands), and 0.8 is one of them, so the shipped default still lands exactly on a stop.
 *
 * 1.0 is deliberately unreachable. The band above 0.8 is the same band.
 */
export const INTENSITY_STOPS = [
	{
		value: 0,
		label: "Dry",
		blurb: "Numbers, zones and fixes. One aside in a whole review."
	},
	{
		value: 0.5,
		label: "Warm",
		blurb: "A bit per item. The T1 references land without taking the item over."
	},
	{
		value: 0.8,
		label: "Full Lillia",
		blurb: "Every item opens on the joke — and still cites the number, still ends on the fix."
	}
] as const

/** Which stop a stored value reads as. Display only: nothing writes until he clicks one. */
export const nearestIntensityStop = (value: number): number => {
	let best: number = INTENSITY_STOPS[0]!.value
	let bestGap = Infinity
	for (const stop of INTENSITY_STOPS) {
		const gap = Math.abs(stop.value - value)
		if (gap < bestGap) {
			bestGap = gap
			best = stop.value
		}
	}
	return best
}
