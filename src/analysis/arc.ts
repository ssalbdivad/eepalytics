/**
 * The arc: what the SNAPSHOT throws away.
 *
 * PURE. Samples in, typed facts out. No I/O, no clock of its own, no model, no memory —
 * everything here is a function of the sample buffer the daemon already keeps.
 *
 * ## Why this file exists
 *
 * `shared/live-state.ts` is a photograph of one instant: who is alive, everyone's CS and level,
 * the score, his gold. Every sentence derivable from it is a description of that instant — and the
 * instant is exactly what the player is already looking at. That is the whole reason the coach
 * reads out his own HUD no matter which model holds it. Measured on this repo's own two-model run
 * (`data/eval/model-opus5.json`, `model-36flash.json`): 144 spoken lines across two models, and
 * **not one had a premise that left the instant**. Opus 5 said four consecutive versions of
 * *"start the route now"* in twenty-four seconds; gemini-3.6-flash did the same with a different
 * sentence. A model cannot say a thing about time when it has been handed no time.
 *
 * What a challenger one-trick actually says over your shoulder is never about the instant:
 *
 *     "You have crossed river three times in four minutes and died twice doing it."
 *     "You have not farmed since 8:50 — the route has been stopped for five minutes."
 *     "They are one drake from soul."
 *     "Briar has killed you four times; nobody else on their team has killed you once."
 *
 * Every one of those is arithmetic over a SERIES. None is expressible from a snapshot at any
 * temperature. This module computes them.
 *
 * ## What it is not
 *
 * - It does not rank, phrase-limit or remember. `analysis/live-facts.ts` owns what may be said and
 *   how often; a second copy of those rules is a copy that drifts.
 * - It does not touch items. `analysis/item-tempo.ts` owns the completed-item race, including the
 *   finding that `price` is the COMBINE cost and no threshold separates a finished item from a
 *   component.
 * - It does not guess positions. The Live Client Data API has no coordinates and neither does this
 *   file. The one position-shaped thing here is `sinceSpendSec`, and it is a proof, not a guess:
 *   gold only leaves his purse at a shop.
 *
 * ## The rounding, which decides half the design
 *
 * `creepScore` is reported floored to a multiple of ten (`CS_QUANTUM`; 12,210 readings across four
 * games, zero non-multiples). So a reported figure `r` means a true one in `[r, r+9]`, and a
 * DIFFERENCE of two reported figures is worth ±9 — a difference of two differences, ±18. Every CS
 * quantity below is therefore an interval, never a subtraction, and the interesting consequence is
 * counter-intuitive:
 *
 * - a BURST is hard to prove (a reported +10 over two minutes means anywhere from +1 to +19);
 * - a STALL is proved EXACTLY. If the reported figure has not moved from 60 in five minutes, his
 *   true CS was in [60,69] at both ends, so he gained **at most 9**, full stop, no assumption.
 *
 * The one number the client rounds away is the one that made the loudest fact in the corpus
 * possible. In `split-03` his reported CS sat at 60 from 08:50 to 14:01 — at most 9 CS in five
 * minutes and eleven seconds, with three deaths inside it — while the shipped coach, holding the
 * snapshot, said *"keep the route running"* thirty times and never noticed the route had stopped.
 */

import type { LiveAllGameData, LivePlayer } from "../shared/schema/live.ts"
import { CS_MAX_UNDERSTATEMENT, CS_QUANTUM } from "../shared/live-state.ts"
import { hasSmite } from "../shared/smite.ts"
import { BARON_RESPAWN_SEC, DRAGON_RESPAWN_SEC, HERALD_RESPAWN_SEC } from "./live-coach.ts"

/* ================================================================= the window */

/**
 * How far back a derivative looks, in seconds of game clock.
 *
 * Two minutes, and it is a compromise the corpus picked. The client's rounding means a window has
 * to be long enough for a reported CS figure to actually MOVE before any rate is provable: over
 * all four recorded games a 120s window produced a certain positive gain on 31–69% of ticks, and a
 * certain race move (the ±18 bar, below) on 18–39%. A 60s window halves both and buys nothing —
 * his median time to gain ten reported CS is about 100 seconds, so at 60s the modal answer is "no
 * measurable change", which is the snapshot again with extra steps.
 */
export const ARC_WINDOW_SEC = 120

/** A window shorter than this is not a window; the arc reports nothing rate-shaped from it. */
export const ARC_MIN_WINDOW_SEC = 60

/* ================================================================== CS bands */

/** What a difference of two floored CS figures actually supports. */
export interface CsBand {
	/** The gain that is CERTAIN. Never negative: CS does not go down. */
	atLeast: number
	/** The most it can have been. */
	atMost: number
}

/**
 * Bound the true CS gained between two reported figures.
 *
 * `earlier` and `later` are both floors, so the true gain is the reported gain ±9 — biased NEITHER
 * way, which is why nothing here ever adds the rounding back. `atLeast` clamps at zero because a
 * reported gain of ten supports "at least one", not "at least ten", and the app has already been
 * burned once by a CS figure that sounded exact and was not.
 */
export const csGainBand = (earlier: number, later: number): CsBand => {
	const d = later - earlier
	return { atLeast: Math.max(0, d - CS_MAX_UNDERSTATEMENT), atMost: Math.max(0, d + CS_MAX_UNDERSTATEMENT) }
}

/**
 * The smallest reported move in the GAP between two junglers that survives the rounding.
 *
 * Each gap is worth ±9, so a change in the gap is worth ±18 and 19 would merely clear it — which is
 * the trap, not the rule. A reported move of 20 survives the rounding by TWO, and *"you have pulled
 * at least 2 CS further ahead"* is the quantisation nag with a new subject; it is the same sentence
 * shape as the *"your 40 farm is just behind your average of 42"* line the owner quit over. So the
 * bar is a full quantum ON TOP of the rounding: a move only counts when at least ten CS of it are
 * certain. Both figures are floored to tens, so in practice this is a reported move of 30.
 */
export const RACE_MOVE_CERTAIN = 2 * CS_MAX_UNDERSTATEMENT + CS_QUANTUM

/* ==================================================================== inputs */

/** One recorded poll: the game clock it was taken at, and the client's verbatim answer. */
export interface ArcSample {
	atSec: number
	data: LiveAllGameData
}

/* =================================================================== the arc */

export interface ArcFarm {
	/** The span actually covered, which is <= `ARC_WINDOW_SEC` early in a game. */
	windowSec: number
	/** What HE gained in the window. */
	mine: CsBand
	/** What the enemy jungler gained in it, when there is one. */
	counterpart: CsBand | null
}

/**
 * A stretch in which his reported CS did not move — the one exact quantity the rounding gives.
 *
 * Judged against HIS OWN completed runs earlier in the same game, never against a constant. A
 * jungler farming at six CS a minute takes about a hundred seconds to move a figure reported in
 * tens, so a flat ninety-second run is not a stall, it is the quantum. Measured: a fixed
 * ">= 90 seconds" rule fires 4, 10, 12 and 10 times across the four games — i.e. constantly, which
 * is how a fact becomes noise. Requiring twice his own median run leaves 0, 4, 1 and 1.
 */
export interface ArcStall {
	/** Clock the reported figure last moved. */
	sinceSec: number
	/** How long it has been flat, so far. The run is ongoing, so this is a lower bound. */
	forSec: number
	/** The reported figure it is stuck on. */
	cs: number
	/** What he can have gained in that time. Exactly `CS_MAX_UNDERSTATEMENT`, by construction. */
	atMostGained: number
	/** Median length of his completed runs earlier in this game, excluding the pre-minion one. */
	medianRunSec: number
	/** `forSec / medianRunSec`. */
	ratio: number
	/** Roughly how much of the run he spent dead. Tick-counted, so it inherits the poll spacing. */
	deadSecApprox: number
	/**
	 * What he was DOING instead, from the event feed.
	 *
	 * Load-bearing veto, and it was found by looking rather than by reasoning: in `split-03` his CS
	 * sits flat for 171 seconds from 30:24 while he solos a drake, aces them and takes Baron. A
	 * stall line there is not a hard truth, it is wrong coaching.
	 *
	 * The first version of the veto was "an objective OR two kills", and it was too generous by
	 * exactly the case that matters: it swallowed the loudest stall in the corpus — 08:50 to 14:01
	 * of `split-03`, at most 9 CS in five minutes — because he picked up kills inside it. He also
	 * DIED THREE TIMES inside it. Kills only excuse a stopped route when they were not paid for, so
	 * the veto is an objective he took, or a fight he came out of clean.
	 */
	during: { kills: number; deaths: number; objectives: number }
	explained: boolean
}

/** The jungle race as a TRAJECTORY rather than a standing. */
export interface ArcRace {
	champion: string
	/** Certain part of the gap now; positive means he is ahead. See `csGap` in live-state. */
	certainNow: number
	/** Certain part of it a window ago. */
	certainThen: number
	/** Only set when the reported move cleared `RACE_MOVE_CERTAIN`. */
	moved: "opening" | "closing" | null
	/** How much of the move survives the rounding, when `moved` is set. */
	byAtLeast: number
}

/**
 * Gold, as a duration rather than a figure.
 *
 * The figure is on his screen; how long it has been there is not. Gold leaves his purse only at a
 * shop, so a net DECREASE proves he stood in a fountain — the only position-shaped fact in an API
 * with no coordinates. The spend is a lower bound: he earns while he shops, so an observed drop of
 * 388 was a purchase of 400 with twelve gold of income netted off (measured; 63 is the recurring
 * one, a 75g control ward minus income).
 */
export interface ArcGold {
	gold: number
	/** Seconds since his gold last went DOWN, i.e. since he was provably at a shop. Null: never. */
	sinceSpendSec: number | null
	/** The observed drop at that spend — a LOWER bound on what he paid. */
	lastSpendAtLeast: number | null
	/** The most he has been holding since then. */
	peakSinceSpend: number
}

export interface ArcLevels {
	mine: number | null
	counterpart: number | null
	/** His level minus the counterpart's. Exact — the client does not round levels. */
	gap: number | null
	/** How that gap moved over the window. Exact. */
	gapDelta: number | null
	/** Seconds since he last levelled. Null when no level-up was observed. */
	sinceLevelSec: number | null
	/** Levels short of his ultimate, or null once he has it. */
	toUlt: number | null
}

/** How long since each kind of thing last happened. Null means "not once this game". */
export interface ArcSince {
	myDeathSec: number | null
	myKillParticipationSec: number | null
	anyKillSec: number | null
	myObjectiveSec: number | null
	enemyObjectiveSec: number | null
	myLevelSec: number | null
	mySpendSec: number | null
}

/** The window's fighting, from his side of it. */
export interface ArcFights {
	windowSec: number
	teamKills: number
	enemyKills: number
	/** Kills his team got that he had no hand in — neither killer nor assister. */
	killsWithoutMe: number
	myDeaths: number
	/** Clocks of his deaths in the window, oldest first. */
	myDeathsAt: number[]
}

export interface ArcObjectives {
	dragonsMine: number
	dragonsTheirs: number
	/** Drake types taken, in order, with the side that took each. */
	dragonLog: { atSec: number; type: string | null; mine: boolean }[]
	/**
	 * Whose next drake is soul, when either side has three.
	 *
	 * There is no objective counter of ANY kind in `VisionState`, so at 19:29 of `split-03` — the
	 * enemy's third drake — nothing this app could say knew the next one ended the game's dragon
	 * contest. Reached in all four recorded games.
	 */
	soulFor: "mine" | "theirs" | null
	heraldsMine: number
	heraldsTheirs: number
	grubsMine: number
	grubsTheirs: number
	baronsMine: number
	baronsTheirs: number
	towersMine: number
	towersTheirs: number
	/** How many of the last drakes went the same way, and to whom. */
	dragonRun: { count: number; mine: boolean } | null
	/** Major objectives the enemy has taken since his team last took one. */
	theirsSinceMine: number
	/** Seconds until each is back, from a take THIS BUFFER SAW. Null when none was seen. */
	drakeBackInSec: number | null
	baronBackInSec: number | null
	heraldBackInSec: number | null
}

/**
 * Who has been killing whom — the whole-game ledger the score line cannot hold.
 *
 * The block shows him `0/5/4` and cannot know that three of those five were the same champion. In
 * `split-03` Briar's list is Urgot x6, Taliyah x4, Lillia x4 on under 100 CS; in `split-04`
 * Tryndamere's is Mel x4, Morgana x4. That is a different game from the one the score line
 * describes, and it is invisible without holding TAB and doing arithmetic.
 *
 * `byEnemy` is deliberately kept as data and not phrased here. Naming which TEAMMATE an enemy is
 * farming is a fact about a real person he cannot control (AGENTS.md hard rule 7), so the line
 * this module emits is `onMe` only; a consumer that wants the rest owns that decision.
 */
export interface ArcKillMap {
	/** Enemy champions who have killed HIM, most first. */
	onMe: { champion: string; count: number }[]
	/** Every enemy killer, with their victims. Context, not a line. */
	byEnemy: { champion: string; victims: { champion: string; count: number }[]; total: number }[]
	/** Enemies he has killed himself, most first. */
	myVictims: { champion: string; count: number }[]
}

export interface Arc {
	nowSec: number
	me: string
	counterpart: string | null
	/** Null when the buffer is too short to support a rate. */
	farm: ArcFarm | null
	stall: ArcStall | null
	race: ArcRace | null
	gold: ArcGold | null
	levels: ArcLevels
	since: ArcSince
	fights: ArcFights
	objectives: ArcObjectives
	killMap: ArcKillMap
}

/* ================================================================== plumbing */

const nameOf = (p: LivePlayer | undefined): string =>
	p?.riotIdGameName ?? p?.riotId ?? p?.summonerName ?? ""

/**
 * Join an event-feed name to a roster row.
 *
 * The two feeds disagree and this cost the app 37 of 37 resolutions once already: events send the
 * BARE game name ("Gooskaffur") while `riotId` carries the tag ("Gooskaffur#NA1"). All three
 * fields are tried, and a miss returns undefined rather than the raw string — a summoner name
 * spoken where a champion belongs reads exactly like a hallucination.
 */
const resolve = (players: LivePlayer[], who: string | undefined): LivePlayer | undefined =>
	who === undefined || who === "" ? undefined : (
		players.find(p => p.riotIdGameName === who || p.riotId === who || p.summonerName === who)
	)

const findMe = (d: LiveAllGameData): LivePlayer | undefined => {
	const players = d.allPlayers ?? []
	const active = d.activePlayer
	const byGameName = players.find(
		p => active?.riotIdGameName !== undefined && p.riotIdGameName === active.riotIdGameName
	)
	if (byGameName) return byGameName
	return players.find(
		p =>
			(active?.riotId !== undefined && p.riotId === active.riotId) ||
			(active?.summonerName !== undefined && p.summonerName === active.summonerName)
	)
}

/**
 * The enemy jungler: declared position first, Smite second.
 *
 * `position` was populated for all 12,210 player observations in the corpus, so the Smite path is
 * the one no recording covers — see `shared/smite.ts` for why it must match `rawDisplayName`.
 */
const findCounterpart = (players: LivePlayer[], myTeam: string): LivePlayer | undefined => {
	const enemies = players.filter(p => p.team !== myTeam)
	return enemies.find(p => (p.position ?? "").toUpperCase() === "JUNGLE") ?? enemies.find(hasSmite)
}

const csOf = (p: LivePlayer | undefined): number | null => p?.scores?.creepScore ?? null

const median = (xs: number[]): number => {
	if (xs.length === 0) return 0
	const s = xs.slice().sort((a, b) => a - b)
	return s[Math.floor(s.length / 2)]!
}

/** Turret and inhib events name a structure, not always a killer — the structure says whose it was. */
const structureSide = (id: string | undefined, myTeam: string): boolean | null => {
	if (id === undefined) return null
	if (id.includes("_TOrder")) return myTeam !== "ORDER"
	if (id.includes("_TChaos")) return myTeam !== "CHAOS"
	return null
}

const OBJECTIVE_EVENTS = new Set(["DragonKill", "BaronKill", "HeraldKill", "HordeKill"])

/* ================================================================== the build */

export interface ArcOptions {
	windowSec?: number
	/** Minimum completed runs before a stall may be judged against his own median. */
	stallMinPriorRuns?: number
	/** A stall must be at least this long AND `stallRatio` times his own median. */
	stallMinSec?: number
	stallRatio?: number
}

/** A stall shorter than this is never worth a sentence however unusual it is for him. */
export const STALL_MIN_SEC = 120

/** …and it must be this many times his own median run this game. */
export const STALL_RATIO = 2

/** Fewer completed runs than this and there is no median worth comparing to. */
export const STALL_MIN_PRIOR_RUNS = 3

/**
 * Build the arc from a buffer of polls, oldest first.
 *
 * Stateless on purpose. The event feed each poll carries is CUMULATIVE from game start, so every
 * event-shaped fact below needs only the newest sample; the buffer is required for the numeric
 * series alone (CS, gold, level), which the client reports as a standing value and never as a
 * history. A 37-minute game is 363 polls, so re-deriving the whole arc every tick costs nothing
 * and removes an entire class of bug — a memory that drifts out of step with the buffer.
 */
export const buildArc = (samples: ArcSample[], opts: ArcOptions = {}): Arc | null => {
	const rows = samples.filter(s => s.data.allPlayers !== undefined).sort((a, b) => a.atSec - b.atSec)
	const last = rows[rows.length - 1]
	if (!last) return null
	const players = last.data.allPlayers ?? []
	const meRow = findMe(last.data)
	if (!meRow) return null
	const myTeam = meRow.team ?? ""
	const myName = nameOf(meRow)
	const cpRow = findCounterpart(players, myTeam)
	const cpName = nameOf(cpRow)
	const nowSec = last.atSec
	const windowSec = opts.windowSec ?? ARC_WINDOW_SEC

	/* ---- the numeric series, one pass */

	interface Point {
		t: number
		cs: number | null
		cpCs: number | null
		level: number | null
		cpLevel: number | null
		gold: number | null
		dead: boolean
	}
	const series: Point[] = rows.map(r => {
		const d = r.data
		const all = d.allPlayers ?? []
		const m = resolve(all, myName) ?? findMe(d)
		const c = cpName === "" ? undefined : resolve(all, cpName)
		return {
			t: r.atSec,
			cs: csOf(m),
			cpCs: csOf(c),
			level: m?.level ?? null,
			cpLevel: c?.level ?? null,
			gold: d.activePlayer?.currentGold ?? null,
			dead: m?.isDead ?? false
		}
	})

	/* ---- events, from the newest sample only: the feed is cumulative */

	interface Ev {
		atSec: number
		name: string
		killer: LivePlayer | undefined
		victim: LivePlayer | undefined
		assisters: LivePlayer[]
		/** True when his side did it. Null when nothing resolved. */
		mine: boolean | null
		byMe: boolean
		onMe: boolean
		dragonType: string | null
	}
	const events: Ev[] = (last.data.events?.Events ?? [])
		.filter(e => e.EventName === "ChampionKill" || OBJECTIVE_EVENTS.has(e.EventName) || e.EventName === "TurretKilled" || e.EventName === "InhibKilled")
		.map(e => {
			const killer = resolve(players, e.KillerName)
			const victim = resolve(players, e.VictimName)
			const assisters = (e.Assisters ?? []).map(a => resolve(players, a)).filter((p): p is LivePlayer => p !== undefined)
			const mine =
				e.EventName === "TurretKilled" || e.EventName === "InhibKilled" ?
					(structureSide(e.TurretKilled ?? e.InhibKilled, myTeam) ??
						(killer ? killer.team === myTeam : null))
				: killer ? killer.team === myTeam
				: null
			return {
				atSec: e.EventTime ?? 0,
				name: e.EventName,
				killer,
				victim,
				assisters,
				mine,
				byMe: nameOf(killer) === myName || assisters.some(a => nameOf(a) === myName),
				onMe: nameOf(victim) === myName,
				dragonType: e.DragonType ?? null
			}
		})
		.filter(e => e.atSec <= nowSec)
		.sort((a, b) => a.atSec - b.atSec)

	const kills = events.filter(e => e.name === "ChampionKill")

	/* ---- farm rate */

	const atOrAfter = (t: number): Point | undefined => series.find(p => p.t >= t)
	const back = atOrAfter(nowSec - windowSec) ?? series[0]
	const span = back ? nowSec - back.t : 0
	const nowP = series[series.length - 1]!
	const farm: ArcFarm | null =
		back && span >= ARC_MIN_WINDOW_SEC && nowP.cs !== null && back.cs !== null ?
			{
				windowSec: Math.round(span),
				mine: csGainBand(back.cs, nowP.cs),
				counterpart: nowP.cpCs !== null && back.cpCs !== null ? csGainBand(back.cpCs, nowP.cpCs) : null
			}
		:	null

	/* ---- the race, as a move */

	let race: ArcRace | null = null
	if (cpRow && nowP.cs !== null && nowP.cpCs !== null && back && span >= ARC_MIN_WINDOW_SEC && back.cs !== null && back.cpCs !== null) {
		const certain = (mine: number, theirs: number): number => {
			const low = mine - theirs - CS_MAX_UNDERSTATEMENT
			const high = mine + CS_MAX_UNDERSTATEMENT - theirs
			return low > 0 ? low : high < 0 ? -high : 0
		}
		const signed = (mine: number, theirs: number): number => {
			const low = mine - theirs - CS_MAX_UNDERSTATEMENT
			const high = mine + CS_MAX_UNDERSTATEMENT - theirs
			return low > 0 ? low : high < 0 ? high : 0
		}
		const movedBy = nowP.cs - back.cs - (nowP.cpCs - back.cpCs)
		race = {
			champion: cpRow.championName ?? "the enemy jungler",
			certainNow: certain(nowP.cs, nowP.cpCs),
			certainThen: certain(back.cs, back.cpCs),
			moved:
				Math.abs(movedBy) >= RACE_MOVE_CERTAIN ?
					/*
					 * "Opening" and "closing" are said from HIS side of the gap, using the signed
					 * certain gap rather than its magnitude — otherwise a lead that shrinks and a
					 * deficit that shrinks read as the same word.
					 */
					signed(nowP.cs, nowP.cpCs) > signed(back.cs, back.cpCs) ? "opening"
					:	"closing"
				:	null,
			byAtLeast: Math.max(0, Math.abs(movedBy) - 2 * CS_MAX_UNDERSTATEMENT)
		}
	}

	/* ---- the stall */

	const runs: { cs: number; from: number; to: number; len: number; deadTicks: number; ticks: number }[] = []
	let runVal: number | null = null
	let runFrom = series[0]?.t ?? nowSec
	let deadTicks = 0
	let ticks = 0
	for (const p of series) {
		if (p.cs === null) continue
		if (runVal === null || p.cs !== runVal) {
			if (runVal !== null)
				runs.push({ cs: runVal, from: runFrom, to: p.t, len: p.t - runFrom, deadTicks, ticks })
			runVal = p.cs
			runFrom = p.t
			deadTicks = 0
			ticks = 0
		}
		ticks++
		if (p.dead) deadTicks++
	}
	if (runVal !== null) runs.push({ cs: runVal, from: runFrom, to: nowSec, len: nowSec - runFrom, deadTicks, ticks })

	const current = runs[runs.length - 1]
	/*
	 * The pre-minion run is excluded from the median and can never itself be a stall. Its length is
	 * set by the game's own minion timer, not by him, and including it drags the median up by
	 * roughly two minutes in every game — which is precisely the direction that hides a real stall.
	 */
	const priorRuns = runs.slice(0, -1).filter(r => r.cs > 0)
	const minPrior = opts.stallMinPriorRuns ?? STALL_MIN_PRIOR_RUNS
	const minSec = opts.stallMinSec ?? STALL_MIN_SEC
	const ratioBar = opts.stallRatio ?? STALL_RATIO
	let stall: ArcStall | null = null
	if (current && current.cs > 0 && priorRuns.length >= minPrior) {
		const med = median(priorRuns.map(r => r.len))
		if (med > 0 && current.len >= minSec && current.len >= ratioBar * med) {
			const inRun = (t: number): boolean => t >= current.from && t <= nowSec
			const during = {
				kills: kills.filter(e => e.byMe && inRun(e.atSec)).length,
				deaths: kills.filter(e => e.onMe && inRun(e.atSec)).length,
				objectives: events.filter(e => OBJECTIVE_EVENTS.has(e.name) && e.byMe && inRun(e.atSec)).length
			}
			const spacing = series.length > 1 ? median(series.slice(1).map((p, i) => p.t - series[i]!.t)) : 0
			stall = {
				sinceSec: Math.round(current.from),
				forSec: Math.round(current.len),
				cs: current.cs,
				atMostGained: CS_MAX_UNDERSTATEMENT,
				medianRunSec: Math.round(med),
				ratio: current.len / med,
				deadSecApprox: Math.round(current.deadTicks * spacing),
				during,
				explained: during.objectives > 0 || (during.kills >= 2 && during.deaths === 0)
			}
		}
	}

	/* ---- gold as a duration */

	let gold: ArcGold | null = null
	if (nowP.gold !== null) {
		let spendAt: number | null = null
		let spendAmount: number | null = null
		let prev: number | null = null
		for (const p of series) {
			if (p.gold === null) continue
			/*
			 * Any net decrease is a purchase and a purchase happens only at a shop. The threshold is
			 * one gold, not a round number: the smallest real drop in the corpus is 63, a 75g control
			 * ward with six seconds of income netted off, and every drop below that would be float
			 * noise in a field the client reports as a float.
			 */
			if (prev !== null && p.gold < prev - 1) {
				spendAt = p.t
				spendAmount = Math.round(prev - p.gold)
			}
			prev = p.gold
		}
		const since = spendAt === null ? null : Math.round(nowSec - spendAt)
		gold = {
			gold: Math.round(nowP.gold),
			sinceSpendSec: since,
			lastSpendAtLeast: spendAmount,
			peakSinceSpend: Math.round(
				Math.max(...series.filter(p => p.gold !== null && (spendAt === null || p.t >= spendAt)).map(p => p.gold!))
			)
		}
	}

	/* ---- levels */

	let sinceLevelSec: number | null = null
	for (let i = 1; i < series.length; i++) {
		const a = series[i - 1]!.level
		const b = series[i]!.level
		if (a !== null && b !== null && b > a) sinceLevelSec = Math.round(nowSec - series[i]!.t)
	}
	const levels: ArcLevels = {
		mine: nowP.level,
		counterpart: nowP.cpLevel,
		gap: nowP.level !== null && nowP.cpLevel !== null ? nowP.level - nowP.cpLevel : null,
		gapDelta:
			nowP.level !== null && nowP.cpLevel !== null && back?.level != null && back.cpLevel != null ?
				nowP.level - nowP.cpLevel - (back.level - back.cpLevel)
			:	null,
		sinceLevelSec,
		toUlt: nowP.level !== null && nowP.level < 6 ? 6 - nowP.level : null
	}

	/* ---- recency */

	const lastAt = (pick: (e: Ev) => boolean): number | null => {
		for (let i = events.length - 1; i >= 0; i--) if (pick(events[i]!)) return Math.round(nowSec - events[i]!.atSec)
		return null
	}
	const since: ArcSince = {
		myDeathSec: lastAt(e => e.name === "ChampionKill" && e.onMe),
		myKillParticipationSec: lastAt(e => e.name === "ChampionKill" && e.byMe),
		anyKillSec: lastAt(e => e.name === "ChampionKill"),
		myObjectiveSec: lastAt(e => OBJECTIVE_EVENTS.has(e.name) && e.mine === true),
		enemyObjectiveSec: lastAt(e => OBJECTIVE_EVENTS.has(e.name) && e.mine === false),
		myLevelSec: sinceLevelSec,
		mySpendSec: gold?.sinceSpendSec ?? null
	}

	/* ---- the window's fighting */

	const from = nowSec - windowSec
	const inWindow = kills.filter(e => e.atSec >= from)
	const myKills = inWindow.filter(e => e.mine === true)
	const fights: ArcFights = {
		windowSec: Math.round(Math.min(windowSec, nowSec)),
		teamKills: myKills.length,
		enemyKills: inWindow.filter(e => e.mine === false).length,
		killsWithoutMe: myKills.filter(e => !e.byMe).length,
		myDeaths: inWindow.filter(e => e.onMe).length,
		myDeathsAt: inWindow.filter(e => e.onMe).map(e => Math.round(e.atSec))
	}

	/* ---- the objective ledger */

	const countBy = (name: string, mine: boolean): number =>
		events.filter(e => e.name === name && e.mine === mine).length
	const dragonLog = events
		.filter(e => e.name === "DragonKill")
		.map(e => ({ atSec: Math.round(e.atSec), type: e.dragonType, mine: e.mine === true }))
	const dragonsMine = dragonLog.filter(d => d.mine).length
	const dragonsTheirs = dragonLog.length - dragonsMine
	let dragonRun: { count: number; mine: boolean } | null = null
	if (dragonLog.length > 0) {
		const side = dragonLog[dragonLog.length - 1]!.mine
		let n = 0
		for (let i = dragonLog.length - 1; i >= 0 && dragonLog[i]!.mine === side; i--) n++
		dragonRun = { count: n, mine: side }
	}
	/*
	 * A respawn window is a public rule, not a guess — but only once the take has been SEEN. Never
	 * assumed from the game clock, exactly as `analysis/live-coach.ts` and `live-facts.ts` require:
	 * the first drake of a game is genuinely not something the coach was told about.
	 */
	const backIn = (name: string, respawn: number): number | null => {
		const hits = events.filter(e => e.name === name)
		const latest = hits[hits.length - 1]
		if (!latest) return null
		const left = Math.round(latest.atSec + respawn - nowSec)
		return left > 0 ? left : 0
	}
	const objectives: ArcObjectives = {
		dragonsMine,
		dragonsTheirs,
		dragonLog,
		soulFor: dragonsMine >= 3 ? "mine" : dragonsTheirs >= 3 ? "theirs" : null,
		heraldsMine: countBy("HeraldKill", true),
		heraldsTheirs: countBy("HeraldKill", false),
		grubsMine: countBy("HordeKill", true),
		grubsTheirs: countBy("HordeKill", false),
		baronsMine: countBy("BaronKill", true),
		baronsTheirs: countBy("BaronKill", false),
		towersMine: countBy("TurretKilled", true),
		towersTheirs: countBy("TurretKilled", false),
		dragonRun,
		theirsSinceMine: (() => {
			let n = 0
			for (let i = events.length - 1; i >= 0; i--) {
				const e = events[i]!
				if (!OBJECTIVE_EVENTS.has(e.name)) continue
				if (e.mine === true) break
				if (e.mine === false) n++
			}
			return n
		})(),
		drakeBackInSec: backIn("DragonKill", DRAGON_RESPAWN_SEC),
		baronBackInSec: backIn("BaronKill", BARON_RESPAWN_SEC),
		heraldBackInSec: backIn("HeraldKill", HERALD_RESPAWN_SEC)
	}

	/* ---- who has been killing whom */

	const tally = new Map<string, Map<string, number>>()
	const onMe = new Map<string, number>()
	const myVictims = new Map<string, number>()
	for (const e of kills) {
		const k = e.killer
		const v = e.victim
		if (!k || !v) continue
		const kc = k.championName ?? ""
		const vc = v.championName ?? ""
		if (kc === "" || vc === "") continue
		if (k.team !== myTeam) {
			const row = tally.get(kc) ?? new Map<string, number>()
			row.set(vc, (row.get(vc) ?? 0) + 1)
			tally.set(kc, row)
			if (e.onMe) onMe.set(kc, (onMe.get(kc) ?? 0) + 1)
		} else if (nameOf(k) === myName) myVictims.set(vc, (myVictims.get(vc) ?? 0) + 1)
	}
	const sortCount = (m: Map<string, number>): { champion: string; count: number }[] =>
		[...m].map(([champion, count]) => ({ champion, count })).sort((a, b) => b.count - a.count)
	const killMap: ArcKillMap = {
		onMe: sortCount(onMe),
		byEnemy: [...tally]
			.map(([champion, row]) => ({
				champion,
				victims: sortCount(row),
				total: [...row.values()].reduce((a, b) => a + b, 0)
			}))
			.sort((a, b) => b.total - a.total),
		myVictims: sortCount(myVictims)
	}

	return {
		nowSec,
		me: meRow.championName ?? "",
		counterpart: cpRow?.championName ?? null,
		farm,
		stall,
		race,
		gold,
		levels,
		since,
		fights,
		objectives,
		killMap
	}
}

/* =================================================================== the lines */

/**
 * The kinds of thing the arc can say. One kind per structure, so a consumer can rate-limit and
 * rank them the way `live-facts.ts` already ranks everything else.
 */
export type ArcLineKind =
	| "stall"
	| "race-move"
	| "absent"
	| "dying"
	| "soul"
	| "dragon-run"
	| "nemesis"
	| "level-move"
	| "gold-rot"
	| "objective-drought"

export interface ArcLine {
	kind: ArcLineKind
	text: string
	/** The clock the line's premise STARTS at, when it has one. Lets a consumer say "since 8:50". */
	sinceSec?: number
}

const mmss = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`

/** A minutes-and-seconds duration, said the way a person says it. */
const forDur = (sec: number): string => {
	const m = Math.floor(sec / 60)
	const s = Math.round(sec % 60)
	if (m === 0) return `${s} seconds`
	if (s === 0) return m === 1 ? "a minute" : `${m} minutes`
	return `${m}:${String(s).padStart(2, "0")}`
}

/** Kills without him in the window before it is worth saying he was not there. */
export const ABSENT_MIN_KILLS = 3

/** Deaths in the window before the pattern is worth naming. */
export const DYING_MIN_DEATHS = 2

/** Gold he must be sitting on, and for how long, before "unspent" beats "spend it". */
export const ROT_MIN_GOLD = 1500
export const ROT_MIN_SEC = 180

/**
 * How many objectives the ENEMY may take since his team's last one before it is worth a sentence.
 *
 * This started as a clock — "no objective in six minutes" — and the clock was a tautology dressed
 * as a fact: it fired at 06:05 in three of the four games, seconds after the first objectives of a
 * game are even available, and would have done so in a game where nothing had gone wrong yet. A
 * DROUGHT is only a fact when somebody else is drinking, so it is counted against them rather than
 * against the clock, which also removes the last spawn-schedule constant from this file.
 */
export const DROUGHT_MIN_THEIRS = 2

/**
 * Times the same enemy must have killed him before it is a pattern and not a death.
 *
 * Three, not two. At two it fired 52 of 73 ticks of `split-03` — a standing fact that is true from
 * the moment it becomes true until the game ends, which is the shape of every line the coach
 * already over-says. At three it names a genuine matchup problem: Briar had killed him four times
 * by the end of that game and nobody else on their side had killed him more than twice.
 */
export const NEMESIS_MIN = 3

/** Levels the gap must move inside one window before the move is news rather than churn. */
export const LEVEL_MOVE_MIN = 2

/**
 * Phrase the arc, gated.
 *
 * Every line here is arithmetic; the gates are the judgment, and they are set from the corpus
 * rather than from taste — see `scripts/probe-arc.ts`, which replays all four recorded games and
 * prints what each of these would have said and when. A line that fires on most ticks of most
 * games is the CS nag with a new subject, and this list is short for that reason.
 *
 * Nothing here decides whether the line is SAID. That is `live-facts.ts`'s job, and it holds the
 * rate limits, the alternation rule and the pass rule.
 *
 * These are TEMPLATES and they must be re-phrased before they are spoken. Scored on
 * `analysis/insight.ts` — the other track's instrument, thresholded without seeing this file — 287
 * of 289 distinct arc lines pass its `beyondInstant` axis, against 0 of the 144 lines two real
 * models produced from the block. But a second firing of the same KIND scores as a `repeat`,
 * because the wording is fixed, and none reaches `insight` on its own: two of that instrument's
 * four axes ask for an ACTION, and an arc line is a premise by design. Appending one flips the
 * verdict — "…at most 9 CS in 3:21" scores 2/4 filler, and the same sentence ending "take your own
 * raptors and finish the route before you cross river again" scores 4/4 insight.
 */
export const arcLines = (a: Arc): ArcLine[] => {
	const out: ArcLine[] = []

	if (a.stall && !a.stall.explained)
		out.push({
			kind: "stall",
			/*
			 * "At most nine" rather than a rate. The figure is exact and it is the only CS number in
			 * this file that needs no hedge — see the header on why a stall is provable and a burst
			 * is not.
			 */
			text: `Your farm has not moved since ${mmss(a.stall.sinceSec)} — at most ${a.stall.atMostGained} CS in ${forDur(a.stall.forSec)}, against your own ${forDur(a.stall.medianRunSec)} for the same ten this game.`,
			sinceSec: a.stall.sinceSec
		})

	/*
	 * RANK THIS LOW, and the corpus is why. Across all four recorded games the certain race gap moved
	 * 54 times and every single one of them was in his favour — he out-farms his counterpart about
	 * 2:1 in every game on record. So this line can only ever congratulate him, and a coach built on
	 * the CS race spends the game reinforcing the one thing he is already best at in the lobby. The
	 * "closing" branch is real, tested and has never once fired on his own games.
	 */
	if (a.race?.moved && a.farm)
		out.push({
			kind: "race-move",
			text:
				a.race.moved === "opening" ?
					`Over the last ${forDur(a.farm.windowSec)} you have pulled at least ${a.race.byAtLeast} CS further ahead of ${a.race.champion}.`
				:	`Over the last ${forDur(a.farm.windowSec)} ${a.race.champion} has taken at least ${a.race.byAtLeast} CS out of the gap.`
		})

	if (a.fights.killsWithoutMe >= ABSENT_MIN_KILLS && !a.fights.myDeathsAt.length)
		out.push({
			kind: "absent",
			text: `Your team has taken ${a.fights.killsWithoutMe} kills in the last ${forDur(a.fights.windowSec)} without you in any of them.`
		})

	if (a.fights.myDeaths >= DYING_MIN_DEATHS)
		out.push({
			kind: "dying",
			text: `You have died ${a.fights.myDeaths} times since ${mmss(a.fights.myDeathsAt[0]!)}.`,
			sinceSec: a.fights.myDeathsAt[0]
		})

	if (a.objectives.soulFor === "theirs")
		out.push({ kind: "soul", text: "They are one drake from soul." })
	else if (a.objectives.soulFor === "mine") out.push({ kind: "soul", text: "The next drake is your soul." })

	if (a.objectives.dragonRun && a.objectives.dragonRun.count >= 3 && !a.objectives.dragonRun.mine)
		out.push({
			kind: "dragon-run",
			text: `The last ${a.objectives.dragonRun.count} drakes have all gone to them.`
		})

	const worst = a.killMap.onMe[0]
	if (worst && worst.count >= NEMESIS_MIN)
		out.push({ kind: "nemesis", text: `${worst.champion} has killed you ${worst.count} times.` })

	/*
	 * TWO levels, not one. A level gap moves by one all game as the two of them trade camps, so at a
	 * threshold of one this fired 21–44 ticks per game in 8–14 separate episodes — churn, reported as
	 * news. Two levels inside two minutes is a real event: it means one of them lost a clear.
	 */
	if (a.levels.gapDelta !== null && Math.abs(a.levels.gapDelta) >= LEVEL_MOVE_MIN && a.race && a.farm)
		out.push({
			kind: "level-move",
			text:
				a.levels.gapDelta < 0 ?
					`${a.race.champion} has taken ${-a.levels.gapDelta} level${a.levels.gapDelta === -1 ? "" : "s"} out of you in the last ${forDur(a.farm.windowSec)}.`
				:	`You have gained ${a.levels.gapDelta} level${a.levels.gapDelta === 1 ? "" : "s"} on ${a.race.champion} in the last ${forDur(a.farm.windowSec)}.`
		})

	if (a.gold && a.gold.gold >= ROT_MIN_GOLD && (a.gold.sinceSpendSec ?? Infinity) >= ROT_MIN_SEC)
		out.push({
			kind: "gold-rot",
			text: `You have been holding ${a.gold.gold} gold and have not been to a shop in ${forDur(a.gold.sinceSpendSec!)}.`
		})

	if (a.objectives.theirsSinceMine >= DROUGHT_MIN_THEIRS)
		out.push({
			kind: "objective-drought",
			text:
				a.since.myObjectiveSec === null ?
					`They have taken ${a.objectives.theirsSinceMine} major objectives and you have not taken one.`
				:	`They have taken ${a.objectives.theirsSinceMine} major objectives since your last one at ${mmss(a.nowSec - a.since.myObjectiveSec)}.`,
			...(a.since.myObjectiveSec === null ? {} : { sinceSec: a.nowSec - a.since.myObjectiveSec })
		})

	return out
}

/**
 * The arc as a block, for a prompt that is being handed a briefing instead of a photograph.
 *
 * Deliberately separate from `renderState`. The snapshot answers "what is true now"; this answers
 * "what changed, what is coming, and what he has been doing" — and mixing them was how the coach
 * came to treat a standing fact and a fresh one as equally urgent.
 */
export const renderArc = (a: Arc): string => {
	const lines = arcLines(a)
	if (lines.length === 0) return ""
	return `### The arc — what changed, which the screenshot cannot show\n\n${lines.map(l => `- ${l.text}`).join("\n")}`
}
