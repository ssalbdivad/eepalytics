/**
 * Hindsight: what actually mattered next, and whether the coach could have known.
 *
 * ## Why this file exists
 *
 * Everything measured about the live coach until now scored a line for being TRUE. It is at
 * ceiling there and has been for months: `analysis/coach-score.ts` gives a perfect score to the
 * transcript the owner finally quit on —
 *
 *     Nice work clearing, your 40 farm is just behind your average of 42.
 *     Awesome clear, you are farming above your average of 37 right now.
 *     Try to pick up the pace, your 20 farm is not pacing to match your average of 30.
 *
 * Nine lines in four minutes, six of them about farm, every figure backed. The instrument said it
 * was fine, so months of work optimised the one axis that was already solved.
 *
 * A line is useful iff it CHANGES WHAT HE DOES, FOR THE BETTER, WHILE HE CAN STILL ACT. This file
 * owns the fifth of the six axes that decomposes into: **of everything true at that instant, was
 * this the thing that mattered?** It answers it the only way anybody honestly can — by looking at
 * what happened next, which is exactly the knowledge a live model cannot have and a coach watching
 * the replay does.
 *
 * ## HINDSIGHT IS NOT FAIRNESS, and this is the load-bearing idea in the module
 *
 * "He died at 6:15" does not mean the coach at 6:05 should have said so. The ground-truth block
 * carries NO POSITION FOR ANYBODY — not his, not an ally's, not an enemy's; the Live Client Data
 * API simply has no coordinates. Most deaths in a real game are therefore genuinely unforeseeable
 * from what the coach was handed, and a metric that marks them against it is not measuring
 * coaching. It is rewarding a model for guessing where people are, which is precisely the failure
 * this whole app was built to prevent: a vision model asked to assess a fight from pixels
 * "invented a map destination the ground-truth block never contained in 24% of its lines"
 * (`analysis/fights.ts`). Optimise against a prophecy metric and you get that back, with a
 * confident voice on top.
 *
 * So every consequence is classified as `block`, `frame-only` or `none` (see `Foresight`) and
 * **only `block` is scored**. The other two are counted and reported so the reader can see how
 * much of the game the metric is deliberately silent about, which is most of it. A low coverage
 * number here is a claim about the COACH; a large `none` bucket is a claim about the DATA, and
 * conflating them would make the metric another flattering instrument.
 *
 * ## What is arithmetic and what is judgment
 *
 * Everything in this file is arithmetic over the client's own event feed and its per-poll player
 * rows: counts, differences between two `EventTime`s, and threshold comparisons. It is unit
 * tested and it is checkable by hand against `data/live-samples/*.ndjson`.
 *
 * The last step — "did the line the coach actually spoke point at any of this, or at something
 * that would plausibly have prevented or enabled it?" — is a judgment about meaning and it does
 * NOT live here. `MECHANICAL_LINKS` below is a deliberately crude floor over fact KINDS, good for
 * a number that cannot drift; `scripts/probe-regret.ts` runs a real model as the judge on top of
 * it. Keeping them apart is the point: the arithmetic stays checkable when the judge changes.
 *
 * ## What it measured, the first time it was run
 *
 * Four recorded games, 1221 polls, 218 consequential events, 148 of them foreseeable from the
 * block at a 60-second horizon. The shipped coach had a linked fact on offer BEFORE 35 of those
 * (24%). It mentioned 82 more (55%) only after they had already happened, and never mentioned 31
 * (21%) at either side. A real model asked to grade the choice on the 21 cases where the coach
 * spoke and something foreseeable was coming called it a hit 9 times and a miss 7.
 *
 * The worst category was the one with the highest stakes: of 16 foreseeable objectives conceded,
 * the coach pointed at 2 in advance. Every other mention of a lost objective arrived after the
 * banner. And on the reference game the ranked "list" held exactly one fact 50 times out of 52 —
 * so the ranking is not choosing between candidates, it is deciding whether to speak at all.
 *
 * ## Nothing here is ever spoken
 *
 * `weight` is an ORDERING, not a measurement, and no figure in this module may reach the player.
 * The app's rule against fabricating a stat (AGENTS.md hard rule 2) applies with full force to a
 * number invented for ranking: "this cost you about 900 gold" reads as a measurement and is not
 * one. This module's output is for the bench, the report and the tests.
 */

import { dragonPhrase } from "../shared/dragons.ts"
import { FIGHT_ACTIVE_SEC, FIGHT_CHAIN_SEC, FIGHT_MIN_DEATHS, LOW_HP_FRACTION } from "./fights.ts"
import type { LiveAllGameData, LivePlayer } from "../shared/schema/live.ts"

/* ------------------------------------------------------------------ windows */

/**
 * The horizons a consequence is looked for in. 30 / 60 / 90 seconds of game clock.
 *
 * Three rather than one because they answer different questions. Thirty seconds is "was the line
 * still true when the sentence finished" — a turn-based provider takes several seconds to speak
 * and cannot be interrupted. Ninety is "did it set up the next play at all". Reporting one number
 * would hide which of those the coach is failing.
 */
export const HORIZONS = [30, 60, 90] as const

/**
 * How long before a consequence lands its situation was already forming, for `frame-only`.
 *
 * A frame is ONE INSTANT. It cannot show a fight whose first kill is eighty seconds away, so a
 * consequence that far out with no signal in the block was unforeseeable from anything the coach
 * held, and marking it against him would be the prophecy metric this file exists to refuse.
 * Inside this window the picture might genuinely have shown the collapse forming, and we have no
 * way to check — so those are excluded from scoring in BOTH directions rather than guessed at.
 *
 * Twenty seconds is deliberately generous to the coach: it is four polls of the sampler, longer
 * than `FIGHT_ACTIVE_SEC`, and about how long a drake takes to kill. Making it larger moves
 * consequences out of `none` and into `frame-only`, which shrinks the scored set; it never
 * inflates coverage. `scripts/probe-regret.ts` prints the split so the sensitivity is visible.
 */
export const SITUATION_LEAD_SEC = 20

/**
 * A CS gap against the enemy jungler has to move this far inside the horizon to be a consequence.
 *
 * Mirrors `RACE_SWING` in `live-facts.ts`, which is the size of swing the coach itself treats as
 * worth a sentence. Using a different number here would score the coach against a race it was
 * never told to run.
 */
export const RACE_MOVE = 10

/** A level gap against the counterpart that opens or closes by this much inside the horizon. */
export const LEVEL_MOVE = 1

/* -------------------------------------------------------------------- types */

/**
 * What kind of consequential thing happened.
 *
 * Deliberately short. Every entry is read straight off the `ChampionKill` / objective feed or off
 * two numbers the block already carried; there is no kind here that needs a position to detect.
 */
export type ConsequenceKind =
	| "my-death"
	| "my-kill"
	| "objective-won"
	| "objective-lost"
	| "fight-won"
	| "fight-lost"
	| "race-lost"
	| "race-won"

/**
 * Could the coach have known, from what it was actually given at T?
 *
 * - `block` — a precursor was IN the ground-truth block at T, AT THE STRENGTH THE COACH'S OWN
 *   RULES TREAT AS ACTIONABLE. That second half is the whole calibration and it is deliberate:
 *   `live-facts.ts` only calls a window a window at two bodies down, and only calls him
 *   outnumbered at `enemiesAlive > alliesAlive + 1`. Scoring against a one-body difference would
 *   hold the coach to a signal it has decided, with measurement behind it, is not worth speaking
 *   about — which is grading it against a coach that does not exist. So every threshold here is
 *   the shipped one, and when the shipped one changes this must change with it.
 * - `frame-only` — no block precursor, but the situation had already begun within
 *   `SITUATION_LEAD_SEC`, so the screenshot MIGHT have shown it and nothing in this data can
 *   check. Not scored, in either direction.
 * - `none` — no block precursor and the situation had not begun. Nothing the coach held at T
 *   contained it. Not scored.
 */
export type Foresight = "block" | "frame-only" | "none"

export interface Consequence {
	kind: ConsequenceKind
	/** Game clock in seconds, when it landed. */
	atSec: number
	/**
	 * Ranking weight. AN ORDERING, NOT A MEASUREMENT, and never spoken or rendered to the player.
	 *
	 * The scale is arbitrary and only the order matters: Baron above a drake above a turret above
	 * a farm swing, his own death above a kill he made. It is a constant table rather than a
	 * computation so that it can be argued with in review instead of hidden inside arithmetic.
	 */
	weight: number
	/** Verbatim from the event feed, or the two numbers a swing is the difference of. */
	evidence: string
	foresight: Foresight
	/** Why it got that foresight. Printed in the report so a classification can be checked. */
	because: string
}

/** One poll, reduced to the fields the ground-truth block actually carries. */
export interface HindsightTick {
	atSec: number
	me: {
		hp: number | null
		maxHp: number | null
		level: number | null
		cs: number | null
		dead: boolean
	}
	/** The enemy jungler as the block reports him: CS and level, never a position. */
	counterpart: { champion: string; cs: number | null; level: number | null } | null
	alliesAlive: number
	enemiesAlive: number
	/** Enemies on the floor with a respawn clock running — the block's "window" signal. */
	enemiesDown: number
	/**
	 * Seconds until each objective is back, counted ONLY from a take this stream actually saw.
	 *
	 * Null when none was seen, exactly as `live-facts.ts` requires — never assumed from the game
	 * clock. That is why the FIRST drake of a game is never `block`-foreseeable: the coach was
	 * genuinely not told it was coming, and pretending otherwise would score it for a fact it
	 * never had.
	 */
	drakeBackInSec: number | null
	baronBackInSec: number | null
	heraldBackInSec: number | null
}

export interface HindsightEvent {
	atSec: number
	/** `ChampionKill`, `DragonKill`, `BaronKill`, `HeraldKill`, `HordeKill`, `TurretKilled`, `InhibKilled`. */
	name: string
	/** True when his side did it, false when theirs did, null when the killer did not resolve. */
	mine: boolean | null
	killer: string | null
	victim: string | null
	assisters: string[]
	byMe: boolean
	onMe: boolean
	dragonType?: string
}

export interface Timeline {
	ticks: HindsightTick[]
	events: HindsightEvent[]
	/** His champion, for readable evidence strings. */
	me: string
}

/* ------------------------------------------------------------------ weights */

/**
 * The ordering. Argue with these numbers here, in one table, rather than in six branches.
 *
 * They are ordinal. Baron is the largest thing that happens in a game of League; conceding an
 * objective sits slightly above taking one because a coach's job is the one it could have
 * prevented; his own death sits above a kill he made because he was present for the kill and the
 * game gave him a banner for it. A farm swing is real and is the bottom of the list, which is the
 * whole complaint about the transcript at the top of this file.
 */
export const WEIGHT = {
	BaronKill: 100,
	InhibKilled: 60,
	DragonKill: 55,
	HeraldKill: 40,
	HordeKill: 25,
	TurretKilled: 25,
	"my-death": 50,
	"my-kill": 22,
	/** Plus five per body of the deficit, so a 0-for-4 outranks a 1-for-2. */
	"fight-lost": 30,
	"fight-won": 20,
	"race-lost": 18,
	"race-won": 14
} as const

/** Conceding is worth more attention than taking. Applied to the objective weights only. */
const CONCEDED_MULTIPLIER = 1.1

/* ------------------------------------------------------------------ adapter */

const OBJECTIVE_EVENTS = new Set([
	"DragonKill",
	"BaronKill",
	"HeraldKill",
	"HordeKill",
	"TurretKilled",
	"InhibKilled"
])

/**
 * Respawn constants, in seconds, matching the ones the block itself uses in `routes/live.ts`.
 *
 * Only used to reproduce the block's OWN `*BackInSec` fields from a recorded stream, so that a
 * consequence is judged foreseeable on exactly the timer the coach was shown and not on a better
 * one computed with hindsight.
 */
const RESPAWN = { DragonKill: 300, BaronKill: 360, HeraldKill: 360 }

/**
 * Resolve an event name to a player.
 *
 * The event feed sends the BARE game name while the roster carries the tagged `riotId`, so all
 * three fields have to be tried — this is the bug that made `readFight` return null on every real
 * game and left farm as the only clean signal in the block (see `routes/live.ts`). Measured on
 * this stream: 137 of 138 killer names resolve with all three, and the one that does not is a
 * minion taking a turret.
 *
 * An empty roster field must never match an empty query, or every unnamed event would resolve to
 * whichever player has no riotIdGameName.
 */
const resolve = (players: LivePlayer[], who: string | undefined): LivePlayer | null => {
	if (!who) return null
	return (
		players.find(
			p =>
				(p.riotIdGameName !== undefined && p.riotIdGameName !== "" && p.riotIdGameName === who) ||
				(p.riotId !== undefined && p.riotId !== "" && p.riotId === who) ||
				(p.summonerName !== undefined && p.summonerName !== "" && p.summonerName === who)
		) ?? null
	)
}

/** Same rule as `findMe` in `routes/live.ts`; kept to three lines rather than exported from a route. */
const findMe = (data: LiveAllGameData): LivePlayer | null => {
	const id = data.activePlayer?.riotId ?? data.activePlayer?.summonerName ?? ""
	if (id === "") return null
	return data.allPlayers?.find(p => (p.riotId ?? p.summonerName ?? "") === id) ?? null
}

/**
 * Turrets name the team they BELONG to (`Turret_TOrder_...` / `Turret_TChaos_...`).
 *
 * That is a better side signal than the killer, because a turret can be taken by a minion wave —
 * one was, in the reference stream, at 35:27. Reading the side off the killer would have dropped
 * that plate entirely.
 */
const turretSide = (name: string | undefined, myTeam: string): boolean | null => {
	if (!name) return null
	if (name.includes("_TOrder_")) return myTeam !== "ORDER"
	if (name.includes("_TChaos_")) return myTeam !== "CHAOS"
	return null
}

/**
 * Reduce a recorded `allgamedata` stream to the timeline the arithmetic runs on.
 *
 * Pure: rows in, timeline out, no file access — reading the ndjson belongs to the script. The
 * event list is taken from the LAST sample, because the feed is cumulative and the last row
 * therefore holds every event of the game with its exact `EventTime`; the per-tick rows supply
 * only the state the block carried at that instant.
 */
export const timelineFromSamples = (
	rows: { gameTime: number; data: unknown }[]
): Timeline => {
	const parsed = rows
		.map(r => ({ atSec: r.gameTime, data: r.data as LiveAllGameData | null }))
		.filter((r): r is { atSec: number; data: LiveAllGameData } => r.data !== null)
	if (parsed.length === 0) return { ticks: [], events: [], me: "" }

	const last = parsed[parsed.length - 1]!.data
	const players = last.allPlayers ?? []
	const meRow = findMe(last)
	const myTeam = meRow?.team ?? ""
	const myName = meRow?.riotId ?? meRow?.summonerName ?? ""
	const myGameName = meRow?.riotIdGameName ?? ""

	const isMe = (who: string | undefined): boolean =>
		who !== undefined &&
		who !== "" &&
		(who === myName || (myGameName !== "" && who === myGameName) || who === meRow?.summonerName)

	const events: HindsightEvent[] = (last.events?.Events ?? [])
		.filter(e => e.EventName === "ChampionKill" || OBJECTIVE_EVENTS.has(e.EventName))
		.map(e => {
			const killer = resolve(players, e.KillerName)
			const victim = resolve(players, e.VictimName)
			const side =
				e.EventName === "TurretKilled" || e.EventName === "InhibKilled" ?
					(turretSide(e.TurretKilled ?? e.InhibKilled, myTeam) ??
						(killer ? killer.team === myTeam : null))
				: killer ? killer.team === myTeam
				: null
			return {
				atSec: e.EventTime ?? 0,
				name: e.EventName,
				mine: side,
				killer: killer?.championName ?? null,
				victim: victim?.championName ?? null,
				assisters: (e.Assisters ?? [])
					.map(a => resolve(players, a)?.championName ?? "")
					.filter(n => n !== ""),
				byMe: isMe(e.KillerName) || (e.Assisters ?? []).some(a => isMe(a)),
				onMe: isMe(e.VictimName),
				...(e.DragonType !== undefined ? { dragonType: e.DragonType } : {})
			}
		})
		.sort((a, b) => a.atSec - b.atSec)

	const ticks: HindsightTick[] = parsed.map(({ atSec, data }) => {
		const all = data.allPlayers ?? []
		const me = findMe(data)
		const team = me?.team ?? myTeam
		const others = all.filter(p => p !== me)
		const enemies = others.filter(p => p.team !== team)
		const cp = enemies.find(p => (p.position ?? "").toUpperCase() === "JUNGLE") ?? null
		/** The block only knows a respawn from a take this stream SAW; `null` before the first. */
		const backIn = (name: keyof typeof RESPAWN): number | null => {
			let latest: number | null = null
			for (const e of data.events?.Events ?? [])
				if (e.EventName === name && e.EventTime !== undefined && e.EventTime <= atSec)
					latest = e.EventTime
			return latest === null ? null : Math.round(latest + RESPAWN[name] - atSec)
		}
		return {
			atSec,
			me: {
				hp: data.activePlayer?.championStats?.currentHealth ?? null,
				maxHp: data.activePlayer?.championStats?.maxHealth ?? null,
				level: me?.level ?? null,
				cs: me?.scores?.creepScore ?? null,
				dead: me?.isDead ?? false
			},
			counterpart:
				cp ?
					{
						champion: cp.championName ?? "the enemy jungler",
						cs: cp.scores?.creepScore ?? null,
						level: cp.level ?? null
					}
				:	null,
			alliesAlive: (me?.isDead ? 0 : 1) + others.filter(p => p.team === team && !p.isDead).length,
			enemiesAlive: enemies.filter(p => !p.isDead).length,
			enemiesDown: enemies.filter(p => p.isDead && (p.respawnTimer ?? 0) > 0).length,
			drakeBackInSec: backIn("DragonKill"),
			baronBackInSec: backIn("BaronKill"),
			heraldBackInSec: backIn("HeraldKill")
		}
	})

	return { ticks, events, me: meRow?.championName ?? "" }
}

/* -------------------------------------------------------------- consequences */

/** The tick at or immediately before T — what the coach actually held. */
export const tickAt = (tl: Timeline, atSec: number): HindsightTick | null => {
	let best: HindsightTick | null = null
	for (const t of tl.ticks) {
		if (t.atSec > atSec) break
		best = t
	}
	return best
}

/** One kill cluster. `FIGHT_CHAIN_SEC` is imported so the clustering matches the coach's own. */
interface Cluster {
	firstSec: number
	lastSec: number
	won: number
	lost: number
	meIn: boolean
}

const clusters = (events: HindsightEvent[]): Cluster[] => {
	const out: Cluster[] = []
	for (const e of events) {
		if (e.name !== "ChampionKill") continue
		const open = out[out.length - 1]
		if (open && e.atSec - open.lastSec <= FIGHT_CHAIN_SEC) {
			open.lastSec = e.atSec
			if (e.mine === true) open.won += 1
			else if (e.mine === false) open.lost += 1
			open.meIn = open.meIn || e.byMe || e.onMe
		} else {
			out.push({
				firstSec: e.atSec,
				lastSec: e.atSec,
				won: e.mine === true ? 1 : 0,
				lost: e.mine === false ? 1 : 0,
				meIn: e.byMe || e.onMe
			})
		}
	}
	return out
}

/*
 * Drakes are named the way the coach names them, via `shared/dragons.ts`.
 *
 * The client says "Water" and "Air"; every human, caster and player says Ocean and Cloud. The
 * report has to be readable straight against a transcript of what was actually said, and a table
 * whose rows say "Water drake" beside a spoken line that says "Ocean drake" is a table someone has
 * to translate before they can check it.
 */
const objectiveLabel = (e: HindsightEvent): string =>
	e.name === "DragonKill" ? dragonPhrase(e.dragonType)
	: e.name === "BaronKill" ? "Baron"
	: e.name === "HeraldKill" ? "Herald"
	: e.name === "HordeKill" ? "a void grub"
	: e.name === "InhibKilled" ? "an inhibitor"
	: "a turret"

/**
 * Was the coach's block, at T, carrying anything that pointed at this objective?
 *
 * Two signals and only two, both of which the block genuinely contains: a respawn timer it had
 * SEEN start, landing inside the horizon; and enemies on the floor, which is the window in which
 * objectives are actually taken.
 */
const objectiveForesight = (
	tick: HindsightTick,
	e: HindsightEvent,
	horizonSec: number
): { level: Foresight; because: string } | null => {
	const timer =
		e.name === "DragonKill" ? tick.drakeBackInSec
		: e.name === "BaronKill" ? tick.baronBackInSec
		: e.name === "HeraldKill" ? tick.heraldBackInSec
		: null
	/*
	 * A NEGATIVE timer means it is already up and has been for a while, which is a stronger signal
	 * than one about to spawn, not a weaker one — the daemon computed both from the same field and
	 * handed both to the ranker. It is `buildFacts` that drops the negative case (`soon()` only
	 * speaks inside a sixty-second window), and that choice is the coach's, so it belongs on the
	 * coach's side of the ledger rather than being written out of the denominator here.
	 */
	if (timer !== null && timer <= 0)
		return {
			level: "block",
			because: `it had been up for ${-timer} seconds and the daemon knew the respawn`
		}
	if (timer !== null && timer <= horizonSec)
		return { level: "block", because: `the block's own timer had it back in ${timer} seconds` }
	if (tick.enemiesDown >= 2)
		return { level: "block", because: `${tick.enemiesDown} enemies were down — the block carried the window` }
	return null
}

/**
 * What actually mattered in `(atSec, atSec + horizonSec]`, ranked by consequence.
 *
 * Pure arithmetic over the event feed and two per-tick numbers. Nothing here needs a position,
 * because nothing in this app has one.
 */
export const consequencesAfter = (
	tl: Timeline,
	atSec: number,
	horizonSec: number
): Consequence[] => {
	const tick = tickAt(tl, atSec)
	if (!tick) return []
	const until = atSec + horizonSec
	const inWindow = tl.events.filter(e => e.atSec > atSec && e.atSec <= until)
	const out: Consequence[] = []

	/**
	 * Decide `frame-only` vs `none` for anything with no block precursor.
	 *
	 * `onsetSec` is when the situation BEGAN, not when it landed — the first kill of a cluster,
	 * not its last. A frame at T cannot contain a fight that has not started.
	 */
	const unforeseeable = (onsetSec: number, what: string): { level: Foresight; because: string } =>
		onsetSec - atSec <= SITUATION_LEAD_SEC ?
			{
				level: "frame-only",
				because: `${what} was already forming ${Math.round(onsetSec - atSec)} seconds out — the frame might have shown it, and nothing here can check`
			}
		:	{
				level: "none",
				because: `${what} had not begun ${Math.round(onsetSec - atSec)} seconds out and the block carries no positions`
			}

	/* --- his own deaths and kills ------------------------------------------ */

	for (const e of inWindow) {
		if (e.name !== "ChampionKill") continue
		if (e.onMe) {
			const hpFrac =
				tick.me.hp !== null && tick.me.maxHp !== null && tick.me.maxHp > 0 ?
					tick.me.hp / tick.me.maxHp
				:	null
			const fightLive = tl.events.some(
				k => k.name === "ChampionKill" && k.atSec <= atSec && atSec - k.atSec < FIGHT_ACTIVE_SEC
			)
			const verdict =
				hpFrac !== null && hpFrac <= LOW_HP_FRACTION ?
					{
						level: "block" as Foresight,
						because: `he was on ${Math.round(hpFrac * 100)} percent health, which the block states`
					}
				: // The coach's own definition of outnumbered (`live-facts.ts`), not a one-body edge.
				tick.enemiesAlive > tick.alliesAlive + 1 ?
					{
						level: "block" as Foresight,
						because: `the block had him outnumbered ${tick.enemiesAlive} to ${tick.alliesAlive}`
					}
				: fightLive ?
					{ level: "block" as Foresight, because: "kills were already landing at that instant" }
				:	unforeseeable(e.atSec, "the death")
			out.push({
				kind: "my-death",
				atSec: e.atSec,
				weight: WEIGHT["my-death"],
				evidence: `${e.killer ?? "someone"} killed ${tl.me}`,
				foresight: verdict.level,
				because: verdict.because
			})
		} else if (e.byMe) {
			const verdict =
				// Two, because `buildFacts` only calls it a window at two: one body down is a fact
				// it has decided is not worth a sentence, so it cannot be a miss.
				tick.enemiesDown >= 2 ?
					{
						level: "block" as Foresight,
						because: `${tick.enemiesDown} of them were already down — the block carried the window`
					}
				:	unforeseeable(e.atSec, "the kill")
			out.push({
				kind: "my-kill",
				atSec: e.atSec,
				weight: WEIGHT["my-kill"],
				evidence: `${tl.me} killed ${e.victim ?? "someone"}`,
				foresight: verdict.level,
				because: verdict.because
			})
		}
	}

	/* --- objectives -------------------------------------------------------- */

	for (const e of inWindow) {
		if (!OBJECTIVE_EVENTS.has(e.name)) continue
		if (e.mine === null) continue
		const w = WEIGHT[e.name as keyof typeof WEIGHT] ?? 20
		const verdict =
			objectiveForesight(tick, e, horizonSec) ?? unforeseeable(e.atSec, objectiveLabel(e))
		out.push({
			kind: e.mine ? "objective-won" : "objective-lost",
			atSec: e.atSec,
			weight: Math.round(e.mine ? w : w * CONCEDED_MULTIPLIER),
			evidence: `${e.mine ? "his team" : "the enemy"} took ${objectiveLabel(e)}`,
			foresight: verdict.level,
			because: verdict.because
		})
	}

	/* --- fights ------------------------------------------------------------ */

	for (const c of clusters(tl.events)) {
		if (c.lastSec <= atSec || c.firstSec > until) continue
		if (c.won + c.lost < FIGHT_MIN_DEATHS) continue
		if (c.won === c.lost) continue
		const lostFight = c.lost > c.won
		const margin = Math.abs(c.won - c.lost)
		const fightLive = tl.events.some(
			k => k.name === "ChampionKill" && k.atSec <= atSec && atSec - k.atSec < FIGHT_ACTIVE_SEC
		)
		const verdict =
			fightLive ?
				{ level: "block" as Foresight, because: "kills were already landing at that instant" }
			: // Two bodies, not one. A 5v4 is the normal state of a game after any trade at all, and
			// treating it as a warning would mark the coach for nearly every fight ever fought.
			Math.abs(tick.alliesAlive - tick.enemiesAlive) >= 2 ?
				{
					level: "block" as Foresight,
					because: `the block had the alive counts at ${tick.alliesAlive} to ${tick.enemiesAlive}`
				}
			:	unforeseeable(c.firstSec, "the fight")
		out.push({
			kind: lostFight ? "fight-lost" : "fight-won",
			atSec: c.lastSec,
			weight:
				(lostFight ? WEIGHT["fight-lost"] : WEIGHT["fight-won"]) +
				margin * (lostFight ? 5 : 3),
			evidence: `a fight went ${c.won} for ${c.lost}${c.meIn ? "" : " without him"}`,
			foresight: verdict.level,
			because: verdict.because
		})
	}

	/* --- the race against the counterpart ---------------------------------- */

	/*
	 * ALWAYS `block`-foreseeable, and this is the point of the whole axis.
	 *
	 * Both numbers — his CS and the enemy jungler's — are literally printed in the block at T. A
	 * gap that opens ten CS over the next minute is the one consequence in this file the coach was
	 * unambiguously equipped to speak to before it happened, so it is the fairest thing to score.
	 */
	const later = tickAt(tl, until)
	if (
		later &&
		tick.counterpart?.cs !== null &&
		tick.counterpart !== null &&
		later.counterpart?.cs != null &&
		tick.me.cs !== null &&
		later.me.cs !== null &&
		tick.counterpart.cs !== null
	) {
		const was = tick.counterpart.cs - tick.me.cs
		const now = later.counterpart.cs - later.me.cs
		const moved = now - was
		if (Math.abs(moved) >= RACE_MOVE)
			out.push({
				kind: moved > 0 ? "race-lost" : "race-won",
				atSec: later.atSec,
				weight: moved > 0 ? WEIGHT["race-lost"] : WEIGHT["race-won"],
				evidence: `the CS gap to ${tick.counterpart.champion} went from ${was} to ${now}`,
				foresight: "block",
				because: "both CS figures were in the block at that instant"
			})
	}
	if (
		later &&
		tick.counterpart?.level != null &&
		later.counterpart?.level != null &&
		tick.me.level !== null &&
		later.me.level !== null
	) {
		const was = tick.counterpart.level - tick.me.level
		const now = later.counterpart.level - later.me.level
		if (Math.abs(now - was) >= LEVEL_MOVE && Math.abs(now) >= LEVEL_MOVE)
			out.push({
				kind: now > was ? "race-lost" : "race-won",
				atSec: later.atSec,
				weight: (now > was ? WEIGHT["race-lost"] : WEIGHT["race-won"]) - 2,
				evidence: `the level gap to ${tick.counterpart.champion} went from ${was} to ${now}`,
				foresight: "block",
				because: "both levels were in the block at that instant"
			})
	}

	return out.sort((a, b) => b.weight - a.weight || a.atSec - b.atSec)
}

/* ------------------------------------------------------- classifying a fact */

/**
 * What KIND of fact a ranked line from `buildFacts` is.
 *
 * By shape, not by a tag, because `buildFacts` returns plain strings — they are the script the
 * model rephrases, and adding a machine-readable prefix to them is exactly the mistake that once
 * had the coach reading `FARM:` out loud (see `live-facts.ts`). So the classifier matches the
 * sentence, and the test pins one real example of every template in that file. A template that
 * changes shape breaks the test rather than silently falling into `other`.
 */
export type FactKind =
	| "fight"
	| "window"
	| "objective-timer"
	| "objective-lost"
	| "objective-count"
	| "enemy-jungler-death"
	| "race"
	| "level-gap"
	| "participation"
	| "build"
	| "farm"
	| "gold"
	| "praise"
	| "other"

const PATTERNS: [FactKind, RegExp][] = [
	["fight", /that fight was \d+ for \d+/],
	["window", /\d+ of them are dead/],
	["enemy-jungler-death", / is down \d+ seconds/],
	["objective-timer", /^(Baron|Drake|Herald) is (up NOW|back in \d+ seconds)/],
	/*
	 * BEFORE `objective-lost`, and the order is load-bearing: "they have taken 3 of the
	 * objectives" starts with the same two words as "they have Baron". First match wins, so the
	 * more specific pattern has to be tried first — reversing these two silently reclassifies the
	 * running objective count as a Baron loss.
	 */
	["objective-count", /^(they have taken \d+ of the objectives|objectives are \d+ to \d+)/],
	["objective-lost", /^they (took|have) /],
	["participation", /percent more of his team's kills/],
	["build", / just finished /],
	["level-gap", /levels (down on|up on)/],
	["race", /CS (up on|down on) (?!your own pace)/],
	["race", /(pulled \d+ CS back on|CS down on .+ and you're ahead now)/],
	["farm", /your own pace/],
	["gold", /gold (sitting unspent|unspent for)/],
	["praise", /^you (just got a|secured|stole) /]
]

export const factKind = (fact: string): FactKind => {
	for (const [kind, re] of PATTERNS) if (re.test(fact)) return kind
	return "other"
}

/**
 * The CRUDE FLOOR: which consequence kinds a fact kind is even about.
 *
 * Deliberately generous on kind and completely blind to whether the line was the RIGHT one at
 * that instant — a farm line "links" to a farm swing however tedious it was. It exists so the
 * report carries one number that cannot drift when the judge model changes, and so a regression
 * in linkage is catchable in a unit test.
 *
 * The real question — "would this have prevented or enabled it?" — is judgment and belongs to
 * `scripts/probe-regret.ts`. Where the two disagree, the judge is the interesting one and this
 * table is the one that is reproducible. Report both or neither.
 *
 * `gold` and `praise` link to nothing on purpose. Unspent gold is a shop reminder and a
 * congratulation is warmth; neither is about anything that is about to happen on the map, which
 * is the honest reading and also the complaint that started this file.
 */
export const MECHANICAL_LINKS: Record<FactKind, ConsequenceKind[]> = {
	fight: ["fight-won", "fight-lost", "my-death"],
	window: ["objective-won", "my-kill", "fight-won"],
	"objective-timer": ["objective-won", "objective-lost"],
	"objective-lost": ["objective-lost", "objective-won"],
	"objective-count": ["objective-won", "objective-lost"],
	"enemy-jungler-death": ["objective-won", "my-kill", "race-won"],
	race: ["race-lost", "race-won"],
	"level-gap": ["my-death", "fight-lost", "objective-lost"],
	participation: ["fight-won", "fight-lost"],
	build: ["my-death", "fight-lost"],
	farm: ["race-lost", "race-won"],
	gold: [],
	praise: [],
	other: []
}

/** Does this ranked line mechanically link to a consequence of this kind? */
export const linksKind = (fact: string, kind: ConsequenceKind): boolean =>
	MECHANICAL_LINKS[factKind(fact)].includes(kind)

/** Does this ranked line mechanically link to this consequence? */
export const links = (fact: string, c: Consequence): boolean => linksKind(fact, c.kind)

/* -------------------------------------------------------------- the measure */

export interface Regret {
	atSec: number
	horizonSec: number
	/** What the coach was holding — the ranked list from `buildFacts`, in order. */
	facts: string[]
	/** Everything consequential in the window, ranked. */
	all: Consequence[]
	/** The subset that is scored: precursor was in the block. */
	foreseeable: Consequence[]
	/** The single heaviest foreseeable one — what a coach with hindsight would have led with. */
	target: Consequence | null
	/** Foreseeable consequences any ranked fact links to. */
	linked: Consequence[]
	/** Did the TOP-ranked fact — the one the model is most likely to speak — link to the target? */
	topHitTarget: boolean
}

/**
 * The measure at one instant, mechanically. No model, no judgment, no I/O.
 *
 * `facts` is what `buildFacts` produced at T; the caller supplies it because building it needs the
 * daemon's own `buildLiveState`, which is a route module and is not importable from `analysis/`.
 */
export const regretAt = (
	tl: Timeline,
	atSec: number,
	facts: string[],
	horizonSec: number
): Regret => {
	const all = consequencesAfter(tl, atSec, horizonSec)
	const foreseeable = all.filter(c => c.foresight === "block")
	const target = foreseeable[0] ?? null
	const linked = foreseeable.filter(c => facts.some(f => links(f, c)))
	return {
		atSec,
		horizonSec,
		facts,
		all,
		foreseeable,
		target,
		linked,
		topHitTarget: target !== null && facts.length > 0 && links(facts[0]!, target)
	}
}
