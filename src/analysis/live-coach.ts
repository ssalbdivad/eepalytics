/**
 * The live coach: what to tell him while the game is running.
 *
 * ## Deliberately not a model call
 *
 * An overlay refreshes every few seconds. A model call per tick would be slow, expensive and
 * non-deterministic — and the useful things to say mid-game are arithmetic, not judgment:
 * whether he is behind his own farm pace, when the next objective is up, whether the habit he
 * is trying to fix is happening again right now. All of that is computable from the live game
 * state plus his own history, so it is instant, free and identical every tick.
 *
 * ## Everything here is grounded or it is not said
 *
 * Mid-game is the worst possible place to be confidently wrong: he will act on it immediately
 * and cannot check it. So every nudge traces to either a live figure the client reported or a
 * baseline from his own games. Nothing is inferred about intent, and nothing is predicted.
 *
 * ## Objective timers are the one derived thing, and they are honest about it
 *
 * Respawn windows are fixed and public: a drake taken at T is back at T + 5:00. That is a rule,
 * not a guess. But it depends on having SEEN the take, so a timer is only shown when the event
 * was actually observed this session — never assumed from the clock.
 *
 * PURE. Callers supply live state and history.
 */

import type { Baseline } from "./index.ts"

/** Seconds. Public, fixed respawn windows. */
export const DRAGON_RESPAWN_SEC = 5 * 60
export const BARON_RESPAWN_SEC = 6 * 60
export const HERALD_RESPAWN_SEC = 6 * 60

export type NudgeKind = "pace" | "objective" | "habit" | "safety" | "praise"

export interface Nudge {
	kind: NudgeKind
	/** One short line. This is an overlay; it is read at a glance or not at all. */
	text: string
	/** Higher shows first. */
	priority: number
	/** What this came from, so nothing on screen is unattributable. */
	source: string
}

export interface LiveState {
	/** Game clock in seconds. */
	gameTimeSec: number
	championName: string
	/** Camps + lane minions so far. */
	cs: number
	deaths: number
	kills: number
	assists: number
	level: number
	/** Seconds at which each observed objective was taken, this session only. */
	observed: { dragonSec: number | null; baronSec: number | null; heraldSec: number | null }
}

export interface LiveCoachInput {
	live: LiveState
	/** The player's own rolling baseline, from `baselineFromRows`. */
	baseline: Baseline | undefined
	/** Top focus categories from recent reviews, highest first. */
	focus: readonly { category: string; games: number; fixes: readonly string[] }[]
}

/** cs@N metrics exist at these marks; between them a comparison would be interpolation. */
const CHECKPOINTS = [
	{ sec: 10 * 60, key: "cs@10", label: "10:00" },
	{ sec: 14 * 60, key: "cs@14", label: "14:00" },
	{ sec: 20 * 60, key: "cs@20", label: "20:00" }
] as const

/** How close to a checkpoint counts as "at" it. */
const CHECKPOINT_WINDOW_SEC = 45

const fmt = (sec: number): string =>
	`${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`

/**
 * Farm pace, but ONLY at the marks where a baseline actually exists.
 *
 * The digest has cs@10, cs@14 and cs@20. Comparing at 12:30 would mean interpolating a baseline
 * that was never measured, which is the kind of number that looks authoritative and is invented.
 * Between checkpoints this says nothing, on purpose.
 */
const paceNudge = (input: LiveCoachInput): Nudge | null => {
	const { live, baseline } = input
	if (!baseline) return null

	const mark = CHECKPOINTS.find(c => Math.abs(live.gameTimeSec - c.sec) <= CHECKPOINT_WINDOW_SEC)
	if (!mark) return null

	const stat = baseline[mark.key]
	if (!stat || stat.n < 5) return null

	const delta = Math.round(live.cs - stat.mean)
	if (Math.abs(delta) < 5)
		return {
			kind: "praise",
			text: `${mark.label}: ${live.cs} CS, right on your average of ${Math.round(stat.mean)}.`,
			priority: 0.3,
			source: `${mark.key} baseline over ${stat.n} games`
		}

	return delta < 0 ?
			{
				kind: "pace",
				text: `${mark.label}: ${live.cs} CS — ${Math.abs(delta)} behind your average of ${Math.round(stat.mean)}. Get back on the clear.`,
				priority: 0.8,
				source: `${mark.key} baseline over ${stat.n} games`
			}
		:	{
				kind: "praise",
				text: `${mark.label}: ${live.cs} CS, ${delta} ahead of your average. Keep the route going.`,
				priority: 0.4,
				source: `${mark.key} baseline over ${stat.n} games`
			}
}

/** Only for objectives whose take was actually observed this session. */
const objectiveNudges = (live: LiveState): Nudge[] => {
	const out: Nudge[] = []
	const add = (takenAt: number | null, respawn: number, name: string): void => {
		if (takenAt === null) return
		const due = takenAt + respawn
		const inSec = Math.round(due - live.gameTimeSec)
		// A 90-second horizon: long enough to path toward it, short enough to still be true.
		if (inSec > 0 && inSec <= 90)
			out.push({
				kind: "objective",
				text: `${name} up in ${inSec}s (${fmt(due)}). Be there before it spawns, not after.`,
				priority: 0.95,
				source: `taken at ${fmt(takenAt)} + ${respawn / 60}:00 respawn`
			})
	}
	add(live.observed.dragonSec, DRAGON_RESPAWN_SEC, "Drake")
	add(live.observed.baronSec, BARON_RESPAWN_SEC, "Baron")
	add(live.observed.heraldSec, HERALD_RESPAWN_SEC, "Herald")
	return out
}

/**
 * The habit he is already working on, surfaced when this game starts repeating it.
 *
 * Only fires on evidence from THIS game — a reminder that triggers regardless of what is
 * happening is wallpaper, and wallpaper gets ignored.
 */
const habitNudges = (input: LiveCoachInput): Nudge[] => {
	const { live, baseline, focus } = input
	const out: Nudge[] = []
	const deathStat = baseline?.deaths

	for (const area of focus.slice(0, 2)) {
		if (area.category === "deaths" && deathStat && deathStat.n >= 5) {
			// Pro-rate his own average across the game so far: three deaths by 12:00 is a
			// different fact from three deaths by 32:00.
			const expected = (deathStat.mean * live.gameTimeSec) / (30 * 60)
			if (live.deaths >= 2 && live.deaths > expected + 1)
				out.push({
					kind: "safety",
					text: `${live.deaths} deaths already — ahead of your usual pace. ${area.fixes[0] ?? "Take the safe camp instead."}`,
					priority: 0.9,
					source: `deaths baseline over ${deathStat.n} games`
				})
		}
	}
	return out
}

/**
 * What to show right now, best first. Empty is a valid answer and a common one — an overlay
 * that always has something to say trains you to stop reading it.
 */
export const liveNudges = (input: LiveCoachInput, limit = 3): Nudge[] =>
	[
		...objectiveNudges(input.live),
		...(paceNudge(input) ? [paceNudge(input)!] : []),
		...habitNudges(input)
	]
		.sort((a, b) => b.priority - a.priority)
		.slice(0, limit)
