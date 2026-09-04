/**
 * Fights — the shape of an exchange, who was in it, and what it has bought so far.
 *
 * ## Why this module exists
 *
 * The live coach only ever talked about camps, gold and objective timers. Every one of those is
 * true and every one of them is already on his screen, which is how a design optimised for TRUE
 * arrived at USELESS. A jungler's decisions do not cash out in camps, they cash out in fights:
 * whether to commit, whether to walk away, whether he was even there, and what the win bought.
 * None of that was computed anywhere, so none of it could be said.
 *
 * ## The two tests every spoken line here has to pass
 *
 * 1. **NOT VISIBLE** — he could not have got it by looking at his own screen right now.
 * 2. **NOT GENERIC** — the same sentence could not have been said in a different game, or five
 *    minutes ago in this one.
 *
 * The second test is what kills a bare trade summary. "You traded 1-for-3" passes test 1 (the
 * scoreboard shows totals, never the shape of the last exchange) but a trade with no consequence
 * attached is a kill feed with better grammar. So **no line here is ever a bare trade**: every
 * one of them carries either his own absence from it or the fact that a won fight has not been
 * cashed in yet. Both of those are decisions about the next thirty seconds, which is the only
 * thing worth interrupting someone for.
 *
 * A side effect worth naming: **no line in this module contains a champion name.** The failure
 * that produced the ground-truth block in the first place was a coach naming champions who were
 * not in the game, so a family of facts that cannot name anybody cannot regress that way.
 *
 * ## What this module refuses to do
 *
 * Enemy health, x/y positions, ability cooldowns and summoner-spell cooldowns **do not exist** in
 * the live client feed. Nothing here approximates them, and no line here implies the coach can
 * see them. In particular there is no "go fight now" and no "they are low": those need exactly
 * the fields we do not have.
 *
 * There is also **no location**. The feed says who killed whom and when, never where. So a
 * "fight" here is strictly an *exchange*: kills that chain together in time AND share a
 * participant. Two simultaneous kills top and bot look identical to a clock, and the participant
 * overlap is what keeps them apart — see `FIGHT_LINK_SEC`.
 *
 * ## LINES versus INPUTS
 *
 * `FightFacts.lines` are the only strings meant to be **spoken**. They are written in the second
 * person, the way the existing `analysis/live-facts.ts` list is, so a caller can hand them to the
 * model as candidates and the model can say one almost as it stands.
 *
 * Everything else on `FightFacts` is an **INPUT**: structured, true, and available for another
 * track to reason from (champion knowledge crossed with the current state, say). Two fields are
 * marked GATE ONLY and must never become a sentence, because they are readbacks of his own HUD:
 * his health bar, and how many of his own team are dead.
 *
 * PURE. State goes in, facts come out; the caller owns any memory, rate limiting and ranking
 * against the other fact families. Nothing in here mutates anything.
 */

import type { LiveAllGameData } from "../shared/schema/live.ts"

/* ------------------------------------------------------------- constants */

/**
 * Two kills belong to the same exchange only if they are this close together.
 *
 * Ten seconds is not a taste call: it is League's own assist window. A player who did not touch a
 * target within ten seconds of its death gets no assist credit, so ten seconds is the longest gap
 * over which the game itself still treats two events as one engagement. Using the game's rule
 * rather than a number that feels right means the clustering has something to be checked against.
 */
export const FIGHT_LINK_SEC = 10

/**
 * How long after the last kill before an exchange is considered over and safe to summarise.
 *
 * A fight assessment is late by nature, and pretending otherwise is how you report "you traded
 * 1-for-1" into a fight that ends 2-for-4 a second later. Waiting six seconds costs six seconds
 * of freshness and buys a count the next poll will not contradict.
 */
export const FIGHT_SETTLE_SEC = 6

/**
 * ...and how long after that it stops being worth saying.
 *
 * Advice about a fight that ended thirty seconds ago is not advice, it is history. Everything
 * here is phrased about the next thirty seconds, so the window in which it can be said honestly
 * is the same thirty seconds.
 */
export const FIGHT_STALE_SEC = 30

/**
 * An upper bound on a League death timer, used ONLY to suppress.
 *
 * The base respawn wait tops out at 52.5s at level 18 and the late-game time increase adds at
 * most about another 30%, so nothing legitimately exceeds ~68s. 80 is deliberately generous
 * because of which way the error runs: too small and the coach tells him he missed a fight he was
 * watching from the respawn screen — the exact class of mistake that produced "2 are down, you
 * have about 14s" said to a corpse with 19s left. Too large and one true line goes unsaid.
 * Silence is the cheap error here.
 */
export const LONGEST_DEATH_SEC = 80

/** Below this fraction of his max health, "go cash the fight in" is advice to walk into a death. */
export const LOW_HP_FRACTION = 0.35

/** A win worth cashing: at least this many enemies down, and at least this much ahead on the trade. */
export const CASHABLE_KILLS = 2
export const CASHABLE_MARGIN = 2

/**
 * How many champions have to die before an exchange is a FIGHT rather than a pick.
 *
 * This is the constant that decides whether this module is coaching or filler, and it was set by
 * measurement rather than taste. Over the 20-game fixture corpus, 1292 kills cluster into 788
 * exchanges, and 526 of those are a single kill — one person dying somewhere on a map the coach
 * cannot see. He is not in most of those and should not be: across ALL exchanges he is absent
 * from 57%, so "you weren't in that one" is the base rate, and a sentence that is true of the
 * median exchange is exactly the kind of true-and-worthless line this work exists to delete.
 *
 * Restricted to exchanges of three or more kills, the picture inverts: 123 such fights across 20
 * games (about 6 a game), and he is absent from only 30% of them. THAT is a fact about this game
 * rather than about solo queue.
 *
 * Every spoken line is gated on it. `Fight.scale` is still reported for picks and skirmishes,
 * because another track reasoning over the state may well want them; they just never become a
 * sentence on their own.
 */
export const FIGHT_MIN_KILLS = 3

/** The absence pattern is measured over this many classifiable fights... */
export const ABSENCE_WINDOW = 4
/** ...and needs at least this many absences inside it to be a pattern rather than one bad fight. */
export const ABSENCE_PATTERN_MIN = 3

/* ------------------------------------------------------------------ input */

export interface FightRosterEntry {
	/** The riotId as the event feed spells it (`Name#TAG`); the join key between events and people. */
	name: string
	champion: string
	/** True for the user himself and his four teammates. */
	ally: boolean
	dead?: boolean
	respawnSec?: number
}

/** One entry of `GET /liveclientdata/eventdata`, reduced to the fields fights care about. */
export interface FightFeedEvent {
	/** `EventID`, monotonic — carried through so a caller can dedupe on it. */
	id: number
	/** `EventName`. */
	name: string
	/** `EventTime`, game-clock seconds. */
	atSec: number
	killer?: string
	victim?: string
	assisters?: string[]
}

export interface FightInput {
	/** Game clock, seconds. */
	nowSec: number
	/** The user's own key into `roster`. */
	me: string
	roster: FightRosterEntry[]
	/** Every event the client has reported this game; order does not matter. */
	events: FightFeedEvent[]
	/**
	 * His own health. GATE ONLY — his health bar is the largest thing on his HUD, so saying it
	 * back to him is a readback. It exists here to stop an aggressive suggestion, never to become
	 * one.
	 */
	hp: { current: number; max: number } | null
}

/* ----------------------------------------------------------------- output */

export interface FightKill {
	atSec: number
	/** Champion name, or "" for an execute — a turret or minion kill has no champion killer. */
	killer: string
	victim: string
	/**
	 * Champion names. Assisters credited on the victim's own team are dropped: that is impossible
	 * in League, so an entry like it is upstream corruption, and the sibling field on
	 * `ELITE_MONSTER_KILL` is documented in `shared/schema/lcu.ts` as 19% cross-team corrupt.
	 */
	assisters: string[]
	/** The victim was on the user's team. */
	victimIsAlly: boolean
}

/**
 * Where the user was, as far as the event feed can establish it.
 *
 * `unclear` is not a failure, it is the honest answer to a question the data cannot settle: he is
 * alive now, he died before this exchange, and nothing proves whether he had respawned in time.
 * Only `absent` is ever spoken.
 */
export type FightPresence = "participated" | "absent" | "dead" | "unclear"

export interface Fight {
	/** Stable across polls — derived from the first kill's own monotonic event id. */
	id: string
	startSec: number
	endSec: number
	kills: FightKill[]
	/** How many of his team died. */
	alliesLost: number
	/** How many of theirs died. */
	enemiesLost: number
	myKills: number
	myAssists: number
	myDeaths: number
	presence: FightPresence
	outcome: "won" | "lost" | "even"
	/**
	 * How big the exchange was, by how many champions died in it. See `FIGHT_MIN_KILLS`: only a
	 * `"fight"` is ever spoken about, because absence from a pick is the base rate and absence
	 * from a fight is a decision.
	 */
	scale: "pick" | "skirmish" | "fight"
	/**
	 * Objectives and turrets his team took from the moment this exchange began until now, in the
	 * order they fell. This is what the fight BOUGHT, and an empty list on a won fight is the
	 * follow-up he missed.
	 */
	bought: string[]
}

export interface FightLine {
	/**
	 * Stable id for announce-once dedupe. The caller owns the memory; ids here are built so that
	 * restating the same fact produces the same id, and the absence pattern only produces a new
	 * one every `ABSENCE_WINDOW` fights.
	 */
	id: string
	kind: "absence" | "uncashed" | "pattern"
	/** Second person, speakable as written. */
	text: string
}

export interface FightFacts {
	/** INPUT. Every settled exchange, oldest first. */
	fights: Fight[]
	/** INPUT + GATE. An exchange whose last kill is too recent to summarise honestly. */
	ongoing: Fight | null
	/** INPUT. The most recent settled exchange, if it is still fresh enough to be about the future. */
	latest: Fight | null
	/** GATE ONLY. His own health bar is on his screen; this stops aggression, it is never said. */
	hpFraction: number | null
	/** GATE ONLY. Ally death state is permanently on his HUD as greyed portraits. */
	alive: { allies: number; enemies: number }
	/** LINES. Speakable candidates, most urgent first. */
	lines: FightLine[]
}

/* ------------------------------------------------------------------ core */

/** A kill resolved against the roster, carrying both champion names (out) and riotIds (joins). */
interface ResolvedKill extends FightKill {
	eventId: number
	killerName: string
	victimName: string
	assisterNames: string[]
	/** Every riotId involved — the overlap test for clustering. */
	names: Set<string>
}

const objectiveBought = (e: FightFeedEvent): string =>
	e.name === "DragonKill" ? "drake"
	: e.name === "BaronKill" ? "Baron"
	: e.name === "HeraldKill" ? "Herald"
	: e.name === "TurretKilled" ? "a turret"
	: ""

/**
 * Cluster the kill feed into exchanges: close in time AND sharing at least one champion.
 *
 * The overlap requirement is the whole defence against merging two fights on opposite sides of a
 * map we cannot see. A 2v2 bot and a 1v1 top that resolve four seconds apart have disjoint
 * participant sets, so they stay two exchanges.
 *
 * The cost is the reverse error — a genuine five-man brawl in which two consecutive kills happen
 * to share nobody gets split in two — and that is the right way round to be wrong. A split fight
 * reports "you traded 1-for-1" twice, which is merely incomplete; a merged one invents a five-man
 * brawl that never happened, which is a fabricated event.
 */
const cluster = (kills: ResolvedKill[]): ResolvedKill[][] => {
	const out: ResolvedKill[][] = []
	let seen = new Set<string>()
	for (const k of kills) {
		const last = out[out.length - 1]
		const previous = last?.[last.length - 1]
		const linked =
			last !== undefined &&
			previous !== undefined &&
			k.atSec - previous.atSec <= FIGHT_LINK_SEC &&
			[...k.names].some(n => seen.has(n))
		if (linked && last !== undefined) {
			last.push(k)
			for (const n of k.names) seen.add(n)
		} else {
			out.push([k])
			seen = new Set(k.names)
		}
	}
	return out
}

/**
 * The whole fight picture for this instant.
 *
 * Everything is recomputed from the feed every call. The feed is append-only and a few hundred
 * entries at worst, so there is nothing to gain from incremental state and a great deal to lose:
 * a second copy of the game is a copy that drifts from the client's.
 */
export const analyseFights = (input: FightInput): FightFacts => {
	const byName = new Map(input.roster.map(r => [r.name, r]))
	const me = byName.get(input.me) ?? null
	const championOf = (name: string | undefined): string =>
		name === undefined ? "" : (byName.get(name)?.champion ?? "")

	/*
	 * Sorted, and clipped to the present.
	 *
	 * The live client never reports an event that has not happened, so the clip is a no-op in
	 * production — but it is what makes this function answerable at an arbitrary clock, which is
	 * how it gets tested against whole stored games. Without it a caller replaying a finished game
	 * sees the last fight of the match as "still resolving" at minute four and every line goes
	 * silent, which is exactly what the first corpus run measured.
	 */
	const feed = [...input.events]
		.filter(e => e.atSec <= input.nowSec)
		.sort((a, b) => a.atSec - b.atSec || a.id - b.id)

	/*
	 * A kill whose VICTIM is not on the roster cannot be attributed to a side, so it is dropped
	 * rather than guessed at. A kill with an unknown KILLER is kept with an empty killer name: an
	 * execute under tower is a real death and it still counts against the trade.
	 */
	const kills: ResolvedKill[] = []
	for (const e of feed) {
		if (e.name !== "ChampionKill" || e.victim === undefined) continue
		const victim = byName.get(e.victim)
		if (victim === undefined) continue
		const assisters = (e.assisters ?? [])
			.map(a => byName.get(a))
			.filter((a): a is FightRosterEntry => a !== undefined && a.ally !== victim.ally)
		const killerKnown = e.killer !== undefined && byName.has(e.killer)
		kills.push({
			atSec: e.atSec,
			eventId: e.id,
			killer: killerKnown ? championOf(e.killer) : "",
			victim: victim.champion,
			assisters: assisters.map(a => a.champion),
			victimIsAlly: victim.ally,
			killerName: killerKnown ? e.killer! : "",
			victimName: victim.name,
			assisterNames: assisters.map(a => a.name),
			names: new Set<string>([
				...(killerKnown ? [e.killer!] : []),
				victim.name,
				...assisters.map(a => a.name)
			])
		})
	}

	/*
	 * When was he last provably alive, and when did he last die?
	 *
	 * A takedown is proof of life at that instant, and there is no way to be alive again except by
	 * respawning, so the first takedown after a death pins that respawn at or before it. That is
	 * the one exact answer available; everything else falls back to `LONGEST_DEATH_SEC`.
	 *
	 * Both questions are asked PER FIGHT rather than once for the game. Asking once was the first
	 * version and it was wrong in a way that only showed up against the 20-game corpus: every
	 * fight got measured against his LAST death in the feed, including fights that happened long
	 * before it, so 55% of exchanges came back `unclear` — most of them fights he was provably
	 * standing in. `fights[]` is an input other tracks read and the absence pattern counts over
	 * it, so a presence field that is wrong for old fights corrupts the one line here that is
	 * worth the most.
	 */
	const myDeathTimes = kills.filter(k => k.victimName === input.me).map(k => k.atSec)
	const myTakedownTimes = kills
		.filter(k => k.killerName === input.me || k.assisterNames.includes(input.me))
		.map(k => k.atSec)
	const lastDeathSec = myDeathTimes.length > 0 ? myDeathTimes[myDeathTimes.length - 1]! : null

	/*
	 * His CURRENT death, exactly. He died at `lastDeathSec` and is back at `nowSec + respawnSec`,
	 * so for once the whole interval is known rather than approximated. Only valid while he is
	 * actually dead — a past death's duration is not recoverable from this feed, which is why
	 * `unclear` exists.
	 */
	const deadUntilSec =
		me?.dead === true && lastDeathSec !== null ? input.nowSec + (me.respawnSec ?? 0) : null

	const presenceOf = (f: {
		startSec: number
		endSec: number
		myKills: number
		myAssists: number
		myDeaths: number
	}): FightPresence => {
		if (f.myKills + f.myAssists + f.myDeaths > 0) return "participated"
		// Dead through any part of it: absence was not a decision, and it is on his own HUD anyway.
		if (
			deadUntilSec !== null &&
			lastDeathSec !== null &&
			lastDeathSec <= f.endSec &&
			deadUntilSec >= f.startSec
		)
			return "dead"
		/** The death he would have had to come back from to attend THIS fight. */
		const before = myDeathTimes.filter(t => t < f.startSec)
		if (before.length === 0) return "absent"
		const died = before[before.length - 1]!
		const proven = myTakedownTimes.find(t => t > died)
		if (proven !== undefined && proven <= f.startSec) return "absent"
		if (died + LONGEST_DEATH_SEC <= f.startSec) return "absent"
		return "unclear"
	}

	const fights: Fight[] = cluster(kills).map(group => {
		const startSec = group[0]!.atSec
		const endSec = group[group.length - 1]!.atSec
		const alliesLost = group.filter(k => k.victimIsAlly).length
		const enemiesLost = group.length - alliesLost
		const myKills = group.filter(k => k.killerName === input.me).length
		const myAssists = group.filter(k => k.assisterNames.includes(input.me)).length
		const myDeaths = group.filter(k => k.victimName === input.me).length
		/*
		 * Only objectives an ALLY is named on. A turret that fell to a minion wave has no killer we
		 * can attribute, and crediting it to the fight would turn a passive push into a follow-up
		 * he never made.
		 */
		const bought = feed
			.filter(e => e.atSec >= startSec && e.atSec <= input.nowSec)
			.filter(e => objectiveBought(e) !== "")
			.filter(e => e.killer !== undefined && byName.get(e.killer)?.ally === true)
			.map(objectiveBought)
		return {
			id: `fight@${group[0]!.eventId}`,
			startSec,
			endSec,
			kills: group.map(k => ({
				atSec: k.atSec,
				killer: k.killer,
				victim: k.victim,
				assisters: k.assisters,
				victimIsAlly: k.victimIsAlly
			})),
			alliesLost,
			enemiesLost,
			myKills,
			myAssists,
			myDeaths,
			presence: presenceOf({ startSec, endSec, myKills, myAssists, myDeaths }),
			outcome:
				enemiesLost > alliesLost ? "won"
				: enemiesLost < alliesLost ? "lost"
				: "even",
			scale:
				group.length >= FIGHT_MIN_KILLS ? "fight"
				: group.length >= 2 ? "skirmish"
				: "pick",
			bought
		}
	})

	const settled = fights.filter(f => input.nowSec - f.endSec >= FIGHT_SETTLE_SEC)
	const newestOverall = fights.length > 0 ? fights[fights.length - 1]! : null
	const ongoing =
		newestOverall !== null && input.nowSec - newestOverall.endSec < FIGHT_SETTLE_SEC ?
			newestOverall
		:	null
	const newestSettled = settled.length > 0 ? settled[settled.length - 1]! : null
	const latest =
		newestSettled !== null && input.nowSec - newestSettled.endSec <= FIGHT_STALE_SEC ?
			newestSettled
		:	null

	const hpFraction =
		input.hp !== null && input.hp.max > 0 ?
			Math.max(0, Math.min(1, input.hp.current / input.hp.max))
		:	null
	const alive = {
		allies: input.roster.filter(r => r.ally && r.dead !== true).length,
		enemies: input.roster.filter(r => !r.ally && r.dead !== true).length
	}

	return {
		fights: settled,
		ongoing,
		latest,
		hpFraction,
		alive,
		lines: buildFightLines({ input, me, settled, ongoing, latest, hpFraction, alive })
	}
}

/* ----------------------------------------------------------------- lines */

const buildFightLines = (ctx: {
	input: FightInput
	me: FightRosterEntry | null
	settled: Fight[]
	ongoing: Fight | null
	latest: Fight | null
	hpFraction: number | null
	alive: { allies: number; enemies: number }
}): FightLine[] => {
	const { input, me, settled, ongoing, latest, hpFraction, alive } = ctx
	const lines: FightLine[] = []
	// A pick is not a fight. See `FIGHT_MIN_KILLS` for the measurement that decided this.
	if (latest === null || latest.scale !== "fight") return lines
	/*
	 * While a NEW exchange is still resolving, the previous one's summary is the wrong thing to
	 * say and the new one's is not knowable yet. Both answers are "wait", which is what silence
	 * is for.
	 */
	if (ongoing !== null && ongoing.id !== latest.id) return lines

	const outnumbered = alive.enemies > alive.allies
	const enemiesDown = input.roster.filter(r => !r.ally && r.dead === true).length

	/*
	 * ORDER: the expiring fact first.
	 *
	 * An unspent win is a window measured in respawn timers and it is gone in seconds. The absence
	 * facts are about a habit and survive to the next turn intact, so they lose the tie. Same
	 * reasoning `analysis/live-facts.ts` uses to put a multi-kill window above everything.
	 */

	/*
	 * A won fight that has bought nothing yet.
	 *
	 * This is the follow-up a solo-queue jungler misses more than any other, and every clause of
	 * it is a hard fact from the feed: the trade came from the kill events, "nothing has been
	 * taken" from the absence of an objective event since the fight began. There is no claim about
	 * what is actually available on the map, because we do not know — the sentence names the gap
	 * and stops, rather than inventing a drake to point at.
	 */
	const decisive =
		latest.enemiesLost >= CASHABLE_KILLS &&
		latest.enemiesLost - latest.alliesLost >= CASHABLE_MARGIN
	if (
		decisive &&
		latest.bought.length === 0 &&
		// The window has to still be OPEN: with everyone respawned this is a scold about the past.
		enemiesDown >= CASHABLE_KILLS &&
		!outnumbered &&
		// GATES, never spoken: on the respawn screen or at a third health, "go take it" is a death.
		me?.dead !== true &&
		(hpFraction === null || hpFraction >= LOW_HP_FRACTION)
	)
		lines.push({
			id: `${latest.id}:uncashed`,
			kind: "uncashed",
			/*
			 * Leads with the trade and lands on the gap, and that order was measured rather than
			 * chosen. The first phrasing was "you won that 3-for-0 and nothing has been taken with
			 * it yet"; run through the real Gemini Live socket with the shipped system prompt it
			 * came back as *"Oh, you won that 3-for-0 and nothing has been taken with it yet!"* and
			 * *"Wow, you won that 4-for-1..."* — the model heard a compliment because the sentence
			 * opens on a win. This is a nudge, not praise, and praise is explicitly the lowest
			 * priority thing the live coach can spend a turn on.
			 */
			text: `that ${latest.enemiesLost}-for-${latest.alliesLost} hasn't bought anything yet`
		})

	/*
	 * The absence pattern, and it is the single most valuable thing in this module.
	 *
	 * One missed fight is noise — he was clearing the other side of the map, which is often right.
	 * Three of the last four is a habit, it is invisible in every part of the client, and it
	 * cannot be said about a different game or about this game five minutes ago. Counted only over
	 * fights whose presence could be ESTABLISHED, so an unknown respawn is never counted as him
	 * choosing not to show up.
	 */
	const classifiable = settled.filter(
		f => f.scale === "fight" && (f.presence === "participated" || f.presence === "absent")
	)
	const window = classifiable.slice(-ABSENCE_WINDOW)
	const absences = window.filter(f => f.presence === "absent").length
	const patternFires =
		latest.presence === "absent" &&
		window.length === ABSENCE_WINDOW &&
		absences >= ABSENCE_PATTERN_MIN
	if (patternFires)
		lines.push({
			/*
			 * Bucketed so it fires at most once per `ABSENCE_WINDOW` fights. Keying it on the
			 * fight would re-fire on every subsequent absence, which is how a true observation
			 * turns into nagging — the failure that already cost this app five gold reminders in
			 * nine turns.
			 */
			id: `absence-pattern@${Math.floor(classifiable.length / ABSENCE_WINDOW)}`,
			kind: "pattern",
			text: `that's ${absences} of the last ${window.length} fights you weren't in`
		})

	/*
	 * A single fight that went badly without him.
	 *
	 * Restricted to fights his team did NOT win, for two reasons. A win he missed is already
	 * covered by the uncashed line above, which is the useful half of it; and "your team won that
	 * without you" is a sentence with no fix in it that still manages to sound like a complaint.
	 *
	 * Suppressed when the pattern line is present — they are the same observation, and the pattern
	 * is the stronger one.
	 */
	if (latest.presence === "absent" && latest.outcome !== "won" && !patternFires)
		lines.push({
			id: `${latest.id}:absence`,
			kind: "absence",
			text:
				latest.enemiesLost === 0 ?
					`your team just lost ${latest.alliesLost} for nothing and you weren't in it`
				:	`your team just traded ${latest.enemiesLost}-for-${latest.alliesLost} without you`
		})

	return lines
}

/* ---------------------------------------------------------------- adapter */

/**
 * Build the input from one `allgamedata` read.
 *
 * Lives here rather than in the route so the tracks that need fights — the ground-truth builder
 * and `scripts/eval-live.ts` — cannot each write a slightly different version of the join. The
 * event feed names people by riotId and the player list is the only place those map to champions
 * and teams, so getting this join wrong is how a coach ends up talking about the wrong team.
 *
 * Returns null when the active player is not in the player list, which is the same rule
 * `findMe` in `server/routes/live.ts` follows: coach nobody rather than coach a stranger.
 */
export const fightInputFromLive = (
	data: LiveAllGameData,
	nowSec: number
): FightInput | null => {
	const meName = data.activePlayer?.riotId ?? data.activePlayer?.summonerName ?? ""
	const players = data.allPlayers ?? []
	const meRow = players.find(p => (p.riotId ?? p.summonerName ?? "") === meName)
	if (meName === "" || meRow === undefined) return null
	const myTeam = meRow.team
	const stats = data.activePlayer?.championStats
	return {
		nowSec,
		me: meName,
		roster: players.map(p => ({
			name: p.riotId ?? p.summonerName ?? "",
			champion: p.championName ?? "unknown",
			ally: p.team === myTeam,
			dead: p.isDead,
			respawnSec: p.respawnTimer
		})),
		events: (data.events?.Events ?? []).map(e => ({
			id: e.EventID,
			name: e.EventName,
			atSec: e.EventTime ?? 0,
			killer: e.KillerName,
			victim: e.VictimName,
			assisters: e.Assisters
		})),
		hp:
			stats?.currentHealth !== undefined && stats.maxHealth !== undefined ?
				{ current: stats.currentHealth, max: stats.maxHealth }
			:	null
	}
}
