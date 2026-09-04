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

/*
 * `habit` and `safety` are gone with the nudges that used them. A kind that nothing can emit is
 * an invitation to emit it again.
 */
export type NudgeKind = "pace" | "objective" | "praise"

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

/*
 * THERE IS NO HABIT NUDGE, AND THAT IS DELIBERATE.
 *
 * There used to be one: it counted deaths against a pro-rated average and appended the top fix
 * from the player's review history. It read like situational awareness and was nothing of the
 * sort — "7 deaths already, and when you're the furthest player from your team, back off" was
 * generic advice from past games pasted onto a live moment the app cannot see. Nothing here
 * knows live positions, cooldowns, lane states or what the team is doing.
 *
 * It was also wrong on its own terms. Deaths are not a defect to be minimised: some are the
 * correct price of an objective, and "ahead of your usual pace" says nothing about whether the
 * ones in THIS game bought anything.
 *
 * The rule this leaves behind: a nudge needs a live measurement AND a measured comparison. CS
 * against a baseline qualifies. An objective timer counted from a take we actually observed
 * qualifies. Coaching about positioning does not, and so is not offered — the death count is
 * shown as a plain number in the stat strip instead, with no lecture attached.
 */

/**
 * A rough farm pace between the checkpoints.
 *
 * `paceNudge` only speaks at 10/14/20 minutes, where a measured baseline exists — which left the
 * first ten minutes of every game silent, and the first ten minutes are where a jungle game is
 * usually decided.
 *
 * This fills the gap from `campsPerMin`, which IS measured, extrapolated across the clock. That
 * extrapolation is a real approximation: early clears do not run at a whole-game average rate.
 * So it is labelled "roughly", it only fires when the gap is large enough that the approximation
 * cannot explain it, and it never appears alongside the exact checkpoint reading.
 */
const ROUGH_PACE_TOLERANCE = 0.75
const EARLIEST_PACE_SEC = 4 * 60

const roughPaceNudge = (input: LiveCoachInput): Nudge | null => {
	const { live, baseline } = input
	if (live.gameTimeSec < EARLIEST_PACE_SEC) return null
	// Silent near a checkpoint: the measured reading is about to speak and is strictly better.
	if (CHECKPOINTS.some(c => Math.abs(live.gameTimeSec - c.sec) <= CHECKPOINT_WINDOW_SEC)) return null

	const stat = baseline?.campsPerMin
	if (!stat || stat.n < 5 || !(stat.mean > 0)) return null

	const expected = (stat.mean * live.gameTimeSec) / 60
	if (expected <= 0 || live.cs >= expected * ROUGH_PACE_TOLERANCE) return null

	return {
		kind: "pace",
		text: `${live.cs} CS at ${fmt(live.gameTimeSec)} — roughly ${Math.round(expected)} would be your usual rate. Get back on camps.`,
		priority: 0.7,
		source: `extrapolated from campsPerMin ${stat.mean.toFixed(1)}/min over ${stat.n} games — approximate between checkpoints`
	}
}

/**
 * What to show right now, best first. Empty is a valid answer and a common one — an overlay
 * that always has something to say trains you to stop reading it.
 */
export const liveNudges = (input: LiveCoachInput, limit = 3): Nudge[] =>
	[
		...objectiveNudges(input.live),
		...(paceNudge(input) ? [paceNudge(input)!] : []),
		...(roughPaceNudge(input) ? [roughPaceNudge(input)!] : [])
	]
		.sort((a, b) => b.priority - a.priority)
		.slice(0, limit)
