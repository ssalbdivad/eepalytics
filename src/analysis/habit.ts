/**
 * THE HABIT: one behaviour, game over game, with its interval — and no model anywhere in it.
 *
 * ## Why this exists at all
 *
 * Every other instrument in this repo grades a LINE: was it true, was it useful, was it worth
 * its latency. `data/eval/what-wins-20260918.json` asked a different question — does anything
 * the coach pushes him toward actually separate the games he WINS from the games he loses — and
 * the answer reorganised the product. Most of what this app grades hardest is a coin flip on his
 * own 138 ranked games: CS at 10 is AUC 0.56 [0.46-0.66] (q 0.34), the gold and xp race against
 * the enemy jungler at 10:00 is 0.55 and 0.55, vision is flat on every measure that is not
 * length-confounded, and dying in the enemy jungle by 15:00 — which `AGENTS.md` Part 2 still
 * calls "the single most common way a jungler throws a lead" — happens in 11% of his games and
 * carries AUC 0.51 [0.46-0.56], q 0.82.
 *
 * Two things of his do separate, both known early enough to act on, and both survive putting the
 * 10-minute scoreboard in the model. They are the two habits below and there are no others here:
 * a tracker that follows six numbers is a dashboard, and a dashboard is what he already ignores.
 *
 * ## What a habit is allowed to be
 *
 *   1. COMPUTED FROM THE TIMELINE, with no model and no judgment. Both quantities are counted
 *      off stored events — deaths with a timestamp, elite-monster kills with a killer — so the
 *      same game yields the same number forever and this file can never fabricate a stat.
 *   2. BINARY PER GAME. "Did the window stay clean" is a question he can answer while playing.
 *      A continuous average is a thing to look at; a streak is a thing to keep.
 *   3. CARRYING ITS OWN INTERVAL. Every rate here is a Wilson interval, and the card refuses to
 *      claim a CHANGE unless two intervals fail to overlap — a conservative test, chosen because
 *      the alternative is telling him he has improved when he has had four lucky games.
 *
 * ## What it must never become
 *
 * It is a SCOREBOARD, NOT AN EXPERIMENT, and `sentencesFor` says so on the card in his own words.
 * `what-wins` is observational on one player who cannot be randomised into surviving minute 12,
 * and the arithmetic that says "move 20% of his games into the clean bucket and win rate goes up
 * 6.4 points" is a restatement of a correlation. Detecting a real shift in the clean-window rate
 * from 38% to 55% at 80% power takes on the order of 130 games per arm and he plays ten a day, so
 * this will not be conclusively validated on this data rate — which is exactly why the card
 * prints the interval instead of a verdict.
 *
 * PURE and browser-safe: callers supply the timeline. No I/O, no database, no LLM.
 */

import type { LcuEvent, LcuFrame, LcuTimeline } from "../shared/schema/lcu.ts"
import { framesOf } from "./frames.ts"
import { separated, wilson, type Interval } from "./coach-score.ts"

/* ================================================================ the two habits */

/**
 * The stored evidence for one habit, copied VERBATIM out of `data/eval/what-wins-20260918.json`
 * so the card cannot quietly drift from the measurement it claims. Nothing here is recomputed at
 * runtime — recomputing would mean the number on screen depends on which games happen to be in
 * the window, and then it is no longer the measurement that justified tracking this at all.
 */
export interface HabitEvidence {
	/** The file the numbers came from. Printed on the card; it is the whole warrant. */
	source: string
	/** Ranked solo games behind the measurement. */
	nGames: number
	auc: { point: number; lo: number; hi: number }
	/** Benjamini-Hochberg q across the 78 rows tested, with the raw p beside it. */
	q: number
	p: number
	/** The decision form: win rate on each side of the cut, with Wilson intervals. */
	decision: {
		cleanArm: string
		clean: { k: number; n: number; p: number; lo: number; hi: number }
		dirtyArm: string
		dirty: { k: number; n: number; p: number; lo: number; hi: number }
		gapPoints: number
	}
	/**
	 * The two-term logistic against the 10-minute team gold difference. This is the instrument
	 * that separates "do this" from "this happens when you are already winning", and both habits
	 * here are on the list precisely because they survived it.
	 */
	controlled: { or: number; lo: number; hi: number; p: number }
	/** Why this number is not a lever, in the measurement's own words. */
	caveat: string
}

export interface HabitDef {
	key: string
	/** What he is trying to do, imperative. This is the sentence before the game. */
	goal: string
	/** What is counted, as a noun phrase. */
	label: string
	/** The clean side of the cut, and the other side, for the per-game chips. */
	cleanLabel: string
	dirtyLabel: string
	/** Minutes of game clock the window needs before the answer exists at all. */
	needsMinutes: number
	/** The raw count for one game. */
	valueOf: (g: HabitInput) => number
	/** The cut. `true` is the side his wins are on. */
	isClean: (value: number) => boolean
	evidence: HabitEvidence
	/**
	 * Why THIS habit rather than the other one, in one line. Shown when he switches, so the
	 * choice is informed rather than a preference.
	 */
	why: string
}

/**
 * Deaths between 10:00 and 15:00 — the default, and the default is an evidence decision rather
 * than a taste one.
 *
 * It is the only metric he controls at any checkpoint that survives the scoreboard control
 * (OR 0.63 per SD [0.43-0.93], p 0.018), it has the widest decision gap in the early table
 * (32.2 points of win rate), and it is the only one of the two whose behaviour shows any sign of
 * carrying from one game to the next — `shapes-persist-20260918.ts` measured P(clean window |
 * previous game clean) at 56% [40-70] against 28% [19-39], lag-1 r = 0.175 [-0.04, 0.35], while
 * the early-objective version's lag-1 r is 0.036 [-0.14, 0.22], i.e. nothing at all. A tracker
 * whose subject does not persist between games is a scoreboard with no handle on it.
 */
const SURVIVE: HabitDef = {
	key: "survive-10-15",
	goal: "Get through 10:00 to 15:00 without dying.",
	label: "deaths between 10:00 and 15:00",
	cleanLabel: "clean",
	dirtyLabel: "died",
	needsMinutes: 15,
	valueOf: g =>
		g.myDeaths.filter(e => e.timestamp > 10 * 60_000 && e.timestamp <= 15 * 60_000).length,
	isClean: v => v === 0,
	why:
		"The only thing he controls at any early checkpoint that still separates his wins once the " +
		"10-minute scoreboard is in the model — and the only one that shows any sign of carrying " +
		"from one game to the next.",
	evidence: {
		source: "data/eval/what-wins-20260918.json",
		nGames: 138,
		auc: { point: 0.349, lo: 0.262, hi: 0.437 },
		q: 0.0037,
		p: 0.00111,
		decision: {
			cleanArm: "with no death in the window",
			clean: { k: 37, n: 53, p: 0.6981, lo: 0.5646, hi: 0.8048 },
			dirtyArm: "with one or more",
			dirty: { k: 32, n: 85, p: 0.3765, lo: 0.2809, hi: 0.4827 },
			gapPoints: 32.2
		},
		controlled: { or: 0.629, lo: 0.428, hi: 0.925, p: 0.0184 },
		caveat:
			"Confounding starts here: a team behind at 10:00 dies more at 12:00 without anyone " +
			"choosing differently."
	}
}

/**
 * Early objective difference by 10:00 — drakes, grubs and herald taken minus conceded.
 *
 * Kept as the alternative rather than dropped: it is the one thing on the board a jungler owns
 * more than anyone, it is decided before the game is, and it survives the same control
 * (OR 1.54 [1.04-2.26]). It is not the default because it is five players' work credited by
 * KILLER only, and because it does not persist game to game, so naming it between games has
 * nothing measured behind it.
 */
const OBJECTIVES: HabitDef = {
	key: "early-objectives",
	goal: "Be ahead on drakes, grubs and herald at 10:00.",
	label: "early objectives taken minus conceded by 10:00",
	cleanLabel: "ahead",
	dirtyLabel: "level or behind",
	needsMinutes: 10,
	valueOf: g => {
		const early = g.monsters.filter(
			e =>
				e.timestamp < 10 * 60_000 &&
				(e.monsterType === "DRAGON" ||
					e.monsterType === "HORDE" ||
					e.monsterType === "RIFTHERALD")
		)
		return early.filter(g.tookIt).length - early.filter(e => !g.tookIt(e)).length
	},
	isClean: v => v > 0,
	why:
		"The objective a jungler owns most, decided before the game is — but it is five players' " +
		"work, and it does not carry from one game to the next, so it is the weaker thing to name " +
		"before a game.",
	evidence: {
		source: "data/eval/what-wins-20260918.json",
		nGames: 138,
		auc: { point: 0.653, lo: 0.561, hi: 0.738 },
		q: 0.0054,
		p: 0.00176,
		decision: {
			cleanArm: "where he was ahead on them",
			clean: { k: 41, n: 64, p: 0.6406, lo: 0.5182, hi: 0.7471 },
			dirtyArm: "where he was level or behind",
			dirty: { k: 28, n: 74, p: 0.3784, lo: 0.2765, hi: 0.4923 },
			gapPoints: 26.2
		},
		controlled: { or: 1.536, lo: 1.045, hi: 2.257, p: 0.0289 },
		caveat:
			"The earliest objective row there is, and the one a jungler owns most of. Still five " +
			"players' work, and credited by KILLER only — it says his team took it, not that he " +
			"was there."
	}
}

/** Every habit this app will track, in the order the card offers them. Two, and that is the point. */
export const HABITS: readonly HabitDef[] = [SURVIVE, OBJECTIVES]

export const DEFAULT_HABIT = SURVIVE.key

export const habitDef = (key: string | null | undefined): HabitDef =>
	HABITS.find(h => h.key === key) ?? SURVIVE

/* ============================================================ per-game computation */

/** Everything a habit's `valueOf` is allowed to see. Deliberately tiny. */
export interface HabitInput {
	myDeaths: LcuEvent[]
	monsters: LcuEvent[]
	tookIt: (e: LcuEvent) => boolean
}

/**
 * Pull the two event lists out of a timeline.
 *
 * `killerId` is the ONLY credit field read. `assistingParticipantIds` on a neutral objective
 * names a player on the other team in 23.1% [20.3-26.2] of assisted takes across the stored 112
 * games, which is why `AGENTS.md` bans reading it and why credit on a monster means the killer
 * here too.
 */
export const habitInput = (
	timeline: LcuTimeline | null | undefined,
	participantId: number,
	teamParticipantIds: readonly number[]
): HabitInput | null => {
	const frames: LcuFrame[] = framesOf(timeline)
	if (frames.length < 6) return null
	const events: LcuEvent[] = []
	for (const f of frames) if (f.events) events.push(...f.events)
	events.sort((a, b) => a.timestamp - b.timestamp)
	const team = new Set(teamParticipantIds)
	team.add(participantId)
	return {
		myDeaths: events.filter(e => e.type === "CHAMPION_KILL" && e.victimId === participantId),
		monsters: events.filter(e => e.type === "ELITE_MONSTER_KILL"),
		tookIt: e => e.killerId !== undefined && team.has(e.killerId)
	}
}

/** One game's answer. `value === null` means the game ended before the window closed. */
export interface HabitGame {
	gameId: number
	createdMs: number
	championName: string
	win: boolean
	durationSec: number
	value: number | null
	clean: boolean | null
	/** Why it is not counted, when it is not. Shown on the chip so a gap is never a mystery. */
	excluded: string | null
}

export const gameHabit = (
	def: HabitDef,
	input: HabitInput | null,
	meta: {
		gameId: number
		createdMs: number
		championName: string
		win: boolean
		durationSec: number
	}
): HabitGame => {
	const base = { ...meta, value: null, clean: null }
	if (input === null) return { ...base, excluded: "no timeline stored" }
	/*
	 * A game that ended before the window closed has no answer, and the honest move is to say so
	 * rather than to score it clean. Scoring a 12-minute remake as "survived 10:00-15:00" would
	 * manufacture a streak out of games that were never played.
	 */
	if (meta.durationSec < def.needsMinutes * 60)
		return { ...base, excluded: `game ended before ${def.needsMinutes}:00` }
	const value = def.valueOf(input)
	return { ...meta, value, clean: def.isClean(value), excluded: null }
}

/* ================================================================== the record */

/** Below this, a rate is arithmetic rather than evidence and the card says so instead. */
export const MIN_GAMES_FOR_RATE = 5

/**
 * Below this PER SIDE, "is it moving" is not a question this data can be asked. Six and six is
 * already generous: two proportions of six cannot separate at 95% unless they are 0/6 and 6/6.
 */
export const MIN_GAMES_PER_SIDE = 6

export interface HabitChange {
	recent: Interval
	prior: Interval
	/** Non-overlapping Wilson intervals. Conservative on purpose. */
	separated: boolean
	note: string
}

export interface HabitRecord {
	key: string
	goal: string
	label: string
	cleanLabel: string
	dirtyLabel: string
	why: string
	/** Newest first. Includes the games that could not be counted, marked. */
	games: HabitGame[]
	/** Games with an answer. The denominator of everything below. */
	counted: number
	rate: Interval
	/** Consecutive counted games from the newest that were clean. Games with no answer are skipped. */
	streak: number
	change: HabitChange | null
	/**
	 * His own rate over the whole measured history, from the stored file — the line the window
	 * above is read against. NOT tested against the window: the 138 games include these ones, so
	 * a comparison between a subset and its own superset is not a test and is never drawn as one.
	 */
	baseRate: Interval
	evidence: HabitEvidence
	/** The count and its interval, as one sentence. */
	head: string
	/** Whether it is moving, or why that cannot be asked. The card prints THIS under the numbers. */
	verdict: string
	/** `head` and `verdict` joined — one standalone sentence, for the CLI and for any other reader. */
	note: string
}

/**
 * The clean rate across the whole measured history, rebuilt from the stored decision block so it
 * cannot drift from the file it quotes. For `survive-10-15` this is 53 of 138 (38%).
 */
export const baseRateOf = (def: HabitDef): Interval => {
	const d = def.evidence.decision
	return wilson(d.clean.n, d.clean.n + d.dirty.n)
}

const pct = (x: number): string => `${Math.round(x * 100)}%`

/**
 * The two halves of what the card says, and the only place in this file where small samples are
 * negotiated. The rules are the repo's own: one game is not a pattern, and a trend that has not
 * cleared its interval is not a trend.
 *
 * `head` is the count and the interval; `verdict` is the honesty clause — whether the thing is
 * moving, or why that question cannot be asked yet. They are separate because the card already
 * draws the count in large type and does not need it repeated underneath, while the CLI and any
 * other reader wants one standalone sentence. `note` is the two joined, and it is what a caller
 * gets if it only wants one string.
 */
const sentencesFor = (
	def: HabitDef,
	rate: Interval,
	change: HabitChange | null
): { head: string; verdict: string } => {
	const n = rate.n
	if (n === 0)
		return {
			head: "Nothing counted yet.",
			verdict: "No game in this window is long enough to answer the question."
		}
	if (n === 1)
		return {
			head: `${rate.k} of 1 ${def.cleanLabel}.`,
			verdict: "One game is a data point, not a pattern. Come back after five."
		}
	if (n < MIN_GAMES_FOR_RATE)
		return {
			head: `${rate.k} of ${n} games ${def.cleanLabel}.`,
			verdict: `Under ${MIN_GAMES_FOR_RATE} games this is arithmetic, not a rate — no interval is worth drawing yet.`
		}
	const head = `${def.cleanLabel} in ${rate.k} of the last ${n} counted games — ${pct(rate.p)} [${pct(rate.lo)}-${pct(rate.hi)}].`
	if (change === null)
		return {
			head,
			verdict: `Not enough games on each side to ask whether it is moving; that needs ${MIN_GAMES_PER_SIDE} either side.`
		}
	return { head, verdict: change.note }
}

/**
 * Recent half against the half before it.
 *
 * Two Wilson intervals and an overlap test, rather than a slope: the quantity is binary per game,
 * the samples are tens rather than hundreds, and a line fitted through ten coin flips is the
 * exact failure the Trends screen already refuses to commit. Overlap is CONSERVATIVE — stricter
 * than a two-proportion z-test — which is the direction to be wrong in when the output is a
 * number he will screenshot.
 */
const changeOf = (counted: HabitGame[]): HabitChange | null => {
	const half = Math.floor(counted.length / 2)
	if (half < MIN_GAMES_PER_SIDE) return null
	// `counted` is newest-first, so the recent half is the head.
	const recentGames = counted.slice(0, half)
	const priorGames = counted.slice(half, half * 2)
	const recent = wilson(recentGames.filter(g => g.clean === true).length, recentGames.length)
	const prior = wilson(priorGames.filter(g => g.clean === true).length, priorGames.length)
	const sep = separated(recent, prior)
	const dir = recent.p > prior.p ? "better" : recent.p < prior.p ? "worse" : "level"
	const note =
		sep ?
			`The last ${recent.n} (${pct(recent.p)}) and the ${prior.n} before them (${pct(prior.p)}) do not overlap, so this is a real change and it is ${dir}.`
		:	`The last ${recent.n} (${pct(recent.p)}) against the ${prior.n} before them (${pct(prior.p)}) is NOT distinguishable from noise — the intervals overlap, so read the level, not the direction.`
	return { recent, prior, separated: sep, note }
}

/** Consecutive clean games from the newest. Games with no answer are stepped over, not broken on. */
const streakOf = (counted: HabitGame[]): number => {
	let n = 0
	for (const g of counted) {
		if (g.clean !== true) break
		n++
	}
	return n
}

export const habitRecord = (def: HabitDef, games: readonly HabitGame[]): HabitRecord => {
	const counted = games.filter(g => g.clean !== null)
	const rate = wilson(counted.filter(g => g.clean === true).length, counted.length)
	const change = changeOf(counted)
	const said = sentencesFor(def, rate, change)
	return {
		key: def.key,
		goal: def.goal,
		label: def.label,
		cleanLabel: def.cleanLabel,
		dirtyLabel: def.dirtyLabel,
		why: def.why,
		games: [...games],
		counted: counted.length,
		rate,
		streak: streakOf(counted),
		change,
		baseRate: baseRateOf(def),
		evidence: def.evidence,
		head: said.head,
		verdict: said.verdict,
		note: `${said.head} ${said.verdict}`
	}
}

/**
 * The line that states what is being claimed, from the stored measurement and never from the
 * window on screen. The distinction matters: the rate above is HIS LAST N GAMES and moves; this
 * is the 138-game measurement that justified tracking the thing at all, and it does not.
 */
export const evidenceSentence = (def: HabitDef): string => {
	const d = def.evidence.decision
	return (
		`Over ${def.evidence.nGames} ranked games he won ${pct(d.clean.p)} [${pct(d.clean.lo)}-${pct(d.clean.hi)}] ` +
		`of the ${d.clean.n} ${d.cleanArm}, against ${pct(d.dirty.p)} [${pct(d.dirty.lo)}-${pct(d.dirty.hi)}] ` +
		`of the ${d.dirty.n} ${d.dirtyArm}. AUC ${def.evidence.auc.point.toFixed(2)} ` +
		`[${def.evidence.auc.lo.toFixed(2)}-${def.evidence.auc.hi.toFixed(2)}], q ${def.evidence.q.toFixed(3)}, ` +
		`and it survives controlling for the 10-minute scoreboard (odds ratio ${def.evidence.controlled.or.toFixed(2)} ` +
		`[${def.evidence.controlled.lo.toFixed(2)}-${def.evidence.controlled.hi.toFixed(2)}], p ${def.evidence.controlled.p.toFixed(3)}).`
	)
}

/**
 * The standing disclaimer. It ships on the card, not in a tooltip, because the single most
 * likely misreading of this screen is that the number causes the win rate.
 */
export const HABIT_LIMIT =
	"Observational, one player, no randomisation — this is where to look, not a lever. " +
	"He cannot be randomised into surviving minute twelve, and a losing game manufactures deaths " +
	"on its own. Tracking it is a bet that attention moves it; the interval is here so the bet " +
	"stays honest."
