/**
 * Fights: what just traded, whether he was in it, and what the enemy took straight after.
 *
 * ## Why this is code and not prompt text
 *
 * The same argument as `live-facts.ts`, re-measured on this feature specifically. A run that
 * changed only the prompt scored **0 of 45 lines** passing all three quality tests (exact,
 * invisible without the scoreboard, impossible to say about another game), and **24% of its lines
 * invented a map destination the ground-truth block never contained** — "start moving bot now",
 * said three separate times about a block that has never carried a position for anybody. Asked to
 * assess a fight from pixels, a vision model does not assess, it narrates and then embellishes.
 *
 * So the fight is detected here, in TypeScript, from the client's own `ChampionKill` feed, and the
 * model is handed a finished sentence it may only rephrase.
 *
 * ## What earns a line
 *
 * Fight assessment was one of only two things that PASSED the same measurement — 3 of 10 lines,
 * specifically the trade: *"That fight was a rough 0 for 3, so back off and catch up."* Every
 * template below is built to that shape on purpose: the count, then the one thing to do next.
 *
 * The count is worth saying because it is genuinely not on his screen. Mid-fight the kill feed
 * scrolls, the death recap covers it, and he is clicking. **Who traded what over the last fifteen
 * seconds is exactly the kind of fact this app exists to hand him** — and when he was not in the
 * fight at all, it is a fact he will otherwise never notice, which is why `absent` is the case
 * this module is really for.
 *
 * ## What it will not say, by construction
 *
 * - **No champion names.** Nothing in the output names a player, so there is no surface on which a
 *   riotId can leak into a sentence that reads like a champion ("You got Baron with Electrician"
 *   reached the player out loud once). Names come in — they are needed to tell the sides apart —
 *   and none goes out.
 * - **No positions, destinations, lanes or sides of the map.** The Live Client Data API has no
 *   coordinates for anyone. A kill count says how many died, never where, and the whole 24% of
 *   invented destinations above came from letting a model fill that gap.
 * - **No cooldowns, no summoners, no enemy health, no claim that a fight was winnable.**
 * - **No number that is not counted from this tick's events.** Every figure emitted here is a
 *   count of `ChampionKill` entries or a difference between two `EventTime`s.
 *
 * ## Timing
 *
 * A fight assessment is inherently seconds late, so it is never phrased as narration of the last
 * ten seconds. It states the trade and then what the **next** thirty seconds are for. It is also
 * only spoken once the fight has stopped producing kills, so the number can never be revised
 * after he has heard it.
 *
 * Pure: state goes in, a line comes out. The caller owns the one mutable memory.
 */

import { dragonPhrase } from "../shared/dragons.ts"

/* ----------------------------------------------------------------- windows */

/**
 * Kills this far apart belong to the same fight.
 *
 * Riot's own multi-kill chain resets at **10 seconds**, so by the game's own definition kills
 * within ten seconds are one engagement. 15 gives headroom for the re-engage that follows a death
 * — the death animation, the pause while whoever died watches, the collapse onto the survivor —
 * while staying well under the twenty-plus seconds it takes to rotate somewhere else and start
 * something new.
 *
 * It is used twice, and that is deliberate: it groups the kills AND it decides when a fight is
 * over. A fight reported as finished therefore cannot gain another kill, so no count spoken to
 * him is ever revised afterwards.
 */
export const FIGHT_CHAIN_SEC = 15

/**
 * How long after a death a fight counts as STILL HAPPENING, for the blackout.
 *
 * A different question from `FIGHT_CHAIN_SEC` and deliberately a different number. That one asks
 * "can this count still change" and has to be generous, because being asked to un-hear a revised
 * trade is worse than hearing it late. This one asks "is he clicking right now", and inside a real
 * fight deaths land within a few seconds of one another — eight seconds with nobody dying means it
 * is resolving.
 *
 * Measured on the reference game: at the chain window this blacked out 99 of 468 ticks, 21% of a
 * 39-minute game, which silences the farm and gold facts through a fifth of the game for fights
 * that were already over. At eight seconds it is roughly half that and still covers the moment
 * that matters.
 */
export const FIGHT_ACTIVE_SEC = 8

/**
 * The longest a single fight may span before a new one is started.
 *
 * Without this, a losing team feeding one death every fourteen seconds chains into a single
 * "fight" that spans two minutes, and "that fight was 0 for 7" is not a fight, it is a stretch of
 * the game. Past forty-five seconds the trade count stops describing one exchange.
 */
export const FIGHT_MAX_SPAN_SEC = 45

/**
 * A fight is at least two deaths.
 *
 * One death is already covered, and covered better, by the respawn-window facts in
 * `live-facts.ts`: those say how long the corpse is down, which is the actionable half. "That
 * fight was 1 for 0" adds nothing to a solo kill he watched happen.
 */
export const FIGHT_MIN_DEATHS = 2

/**
 * How long after the last death the trade is still worth a sentence.
 *
 * Deaths run roughly thirty to fifty seconds through the middle of a game, so past forty the
 * bodies from that fight are getting back up and the advice attached to the trade inverts.
 * Reporting it then is history, and history is the thing this coach exists to not deliver.
 */
export const FIGHT_WORTH_SAYING_SEC = 40

/**
 * Minimum gap between two spoken fight lines.
 *
 * Fights cluster — a skirmish, a pick, a re-engage, all inside a minute. Each is announced once by
 * id, which bounds repetition but not density, and density is its own measured failure: 40 of 55
 * spoken lines in one judged session were respawn timers, every one of them individually correct.
 * "That fight was 1 for 1" three times in ninety seconds is that same failure with a new subject.
 */
export const FIGHT_COOLDOWN_SEC = 45

/**
 * How long after a fight an enemy objective still counts as bought by it.
 *
 * Thirty seconds is the span in which a take is plainly the fight's consequence rather than a
 * separate decision made later. This is a SEQUENCE claim, never a causal one, and it is phrased
 * that way — "they took Baron 14 seconds later", never "that fight lost you Baron".
 */
export const BOUGHT_WINDOW_SEC = 30

/**
 * Below this fraction of his max health, "go take the free camps" is the wrong instruction.
 *
 * His own health is exact and it is the one input here that changes what he should DO next. The
 * number is never spoken — that would be reading his own health bar back to him — it only decides
 * which tail the line ends on.
 */
export const LOW_HP_FRACTION = 0.35

/* ------------------------------------------------------------------- input */

/**
 * One `ChampionKill` from the live event feed, with every name ALREADY RESOLVED TO A CHAMPION.
 *
 * The feed names people by riotId. Resolving is the caller's job because only the caller holds the
 * roster, and accepting riotIds here would put a namespace this module cannot check one string
 * concatenation away from the player's ears.
 */
export interface FightKill {
	/** Champion name of the killer, or whatever the feed named when it was not a champion. */
	killer: string
	/** Champion name of the victim. */
	victim: string
	/** Champion names of the assisters. Empty is normal. */
	assisters: string[]
	/** `EventTime` — game-clock seconds. */
	atSec: number
}

/** A major objective take, resolved to a side by the caller. */
export interface FightObjective {
	/** The live feed's `EventName`: `DragonKill`, `BaronKill` or `HeraldKill`. */
	name: string
	/** `EventTime` — game-clock seconds. */
	atSec: number
	/**
	 * True only when it is KNOWN to be the enemy team's take.
	 *
	 * "Strictly theirs" means known, so an unresolvable killer must arrive here as `false`. The
	 * live route currently defaults an unknown killer to the enemy, which turns a lookup miss into
	 * an accusation; that default must not be carried into this field.
	 */
	byEnemy: boolean
	/** The live feed's `DragonType`, in element words ("Fire", "Water"). */
	dragonType?: string
}

export interface FightInput {
	/** Game clock, seconds. */
	nowSec: number
	/** His champion. */
	me: string
	/** His four teammates' champions — not including him. */
	allies: string[]
	/** The five enemy champions. */
	enemies: string[]
	/** Every `ChampionKill` the feed has given us, any order. */
	kills: FightKill[]
	/** Every `DragonKill` / `BaronKill` / `HeraldKill`, any order. */
	objectives: FightObjective[]
	/** Seconds until HE is back up; null when he is alive. */
	meDeadForSec: number | null
	/** `championStats.currentHealth`. Null when the client did not send it. */
	hp: number | null
	/** `championStats.maxHealth`. */
	maxHp: number | null
	/**
	 * How many of his team are alive right now, HIM INCLUDED when he is on the map.
	 *
	 * The same definition as `FactInput.alliesAlive` in `live-facts.ts`, so the caller computes it
	 * once and hands the same number to both.
	 */
	alliesAlive: number
	/** How many of theirs are alive right now. */
	enemiesAlive: number
}

/* ------------------------------------------------------------------ output */

/**
 * What he did in the fight, from the events alone.
 *
 * A takedown or a death is PROOF of presence — you cannot assist from across the map and you
 * cannot die somewhere you are not — so `absent` is a real finding and not an inference. It is
 * also the most valuable one: a jungler almost never notices the fight he was not in.
 *
 * `killer` outranks `assist` outranks `victim`: he can trade a kill for his own death, and the
 * label exists only to decide whether the line says "without you".
 */
export type FightParticipation = "killer" | "assist" | "victim" | "absent"

export interface Fight {
	/** Stable across polls — the first death's game clock. Announce-once is keyed on it. */
	id: string
	firstSec: number
	lastSec: number
	/** Seconds since the last death in it. */
	ageSec: number
	/** Enemy champions killed. */
	won: number
	/** His side's champions killed, him included. */
	lost: number
	participation: FightParticipation
	/** No further kill can join it, so `won`/`lost` are final. */
	settled: boolean
	/**
	 * An objective the enemy took STRICTLY AFTER the fight's last death.
	 *
	 * Both halves of that are bug fixes, and both were measured. A previous attempt allowed an
	 * objective taken DURING the kill cluster and said *"they took Baron -8 seconds later"* — a
	 * negative interval, out loud. It also took the FIRST objective in the window rather than the
	 * ENEMY one, so an ally Herald at 870 followed by an enemy Baron at 880 suppressed the line
	 * entirely: the biggest event in the game, silenced by a smaller one his own team had won.
	 */
	bought: { phrase: string; gapSec: number } | null
}

export interface FightRead {
	/**
	 * Kills are still landing: the caller must say NOTHING this turn, about anything.
	 *
	 * This is the ongoing-fight case, and silence is its only correct use. He is clicking; a
	 * sentence arriving 0.8 seconds behind a teamfight is noise at the exact moment noise costs
	 * the most, and any count spoken now would be revised three seconds later. It is the same
	 * lesson as the disaster blackout in `live-facts.ts`: ranking is not enough when the right
	 * answer is nothing at all.
	 */
	quiet: boolean
	/** The line to speak, already phrased, or null. */
	line: string | null
	/** The most recent fight found, spoken or not. Null when there has not been one. */
	fight: Fight | null
}

/* ---------------------------------------------------------------- internals */

/** `DragonKill` and friends -> the noun to say out loud, or "" when we cannot name it. */
const objectivePhrase = (o: FightObjective): string =>
	o.name === "BaronKill" ? "Baron"
	: o.name === "HeraldKill" ? "Herald"
	: o.name === "DragonKill" ? dragonPhrase(o.dragonType)
	: ""

/**
 * Which side a champion is on, or null when it cannot be told.
 *
 * Null covers two real cases. A kill credited to a turret or an execution names something that is
 * on neither roster — the DEATH still counts for the victim's side, so only the killer lookup
 * misses. And blind pick allows the same champion on both teams, where a name genuinely does not
 * identify a side; those deaths are dropped from the trade rather than guessed at, because a trade
 * count that is wrong by one is worse than a trade count that is missing.
 */
const sideOf = (
	champion: string,
	mine: Set<string>,
	theirs: Set<string>
): "mine" | "theirs" | null =>
	mine.has(champion) && theirs.has(champion) ? null
	: mine.has(champion) ? "mine"
	: theirs.has(champion) ? "theirs"
	: null

/** Kills grouped into fights, oldest first. Each group is sorted by time. */
const groupKills = (kills: FightKill[]): FightKill[][] => {
	const sorted = [...kills].sort((a, b) => a.atSec - b.atSec)
	const groups: FightKill[][] = []
	for (const k of sorted) {
		const current = groups[groups.length - 1]
		const previous = current?.[current.length - 1]
		const start = current?.[0]
		if (
			current === undefined ||
			previous === undefined ||
			start === undefined ||
			k.atSec - previous.atSec > FIGHT_CHAIN_SEC ||
			k.atSec - start.atSec > FIGHT_MAX_SPAN_SEC
		)
			groups.push([k])
		else current.push(k)
	}
	return groups
}

/* ------------------------------------------------------------------ memory */

/**
 * What the caller has to remember between turns.
 *
 * Explicit rather than module-level for the same reason `FactMemory` is: memory kept in module
 * scope is memory no test can observe, and the announce-once rule is the whole thing standing
 * between "that fight was 0 for 3" and hearing it on every poll for forty seconds.
 */
export interface FightMemory {
	/** Fight ids already spoken. */
	announced: Set<string>
	/** Game clock of the last spoken fight line; 0 when none. */
	lastSpokeAtSec: number
}

export const newFightMemory = (): FightMemory => ({
	announced: new Set(),
	lastSpokeAtSec: 0
})

/**
 * Forget everything, for the gap between two games.
 *
 * A function rather than a list of assignments at the call site, because the equivalent inline
 * reset for `FactMemory` in `routes/live.ts` has silently missed a field more than once — a set
 * added later stays populated into the next game, and the coach goes quiet about something it
 * "already said" in a game that had not started yet.
 */
export const resetFightMemory = (mem: FightMemory): void => {
	mem.announced.clear()
	mem.lastSpokeAtSec = 0
}

/* -------------------------------------------------------------------- read */

/**
 * The one entry point. Mutates `mem` when it emits a line — that is the announce-once record.
 */
export const readFight = (input: FightInput, mem: FightMemory): FightRead => {
	const mine = new Set([input.me, ...input.allies])
	const theirs = new Set(input.enemies)

	const groups = groupKills(input.kills)
	const group = groups[groups.length - 1]
	if (group === undefined || group[0] === undefined)
		return { quiet: false, line: null, fight: null }

	const firstSec = group[0].atSec
	const lastSec = group[group.length - 1]!.atSec

	let won = 0
	let lost = 0
	let myTakedowns = 0
	let myAssists = 0
	let myDeaths = 0
	for (const k of group) {
		const side = sideOf(k.victim, mine, theirs)
		if (side === "mine") lost++
		else if (side === "theirs") won++
		if (k.killer === input.me) myTakedowns++
		else if (k.assisters.includes(input.me)) myAssists++
		if (k.victim === input.me) myDeaths++
	}

	/*
	 * Attributed deaths, not raw events. A kill we could not put on a side is not evidence of a
	 * fight either, and counting it would let two unattributable deaths conjure one.
	 */
	if (won + lost < FIGHT_MIN_DEATHS) return { quiet: false, line: null, fight: null }

	const ageSec = input.nowSec - lastSec
	const settled = ageSec >= FIGHT_CHAIN_SEC

	const participation: FightParticipation =
		myTakedowns > 0 ? "killer"
		: myAssists > 0 ? "assist"
		: myDeaths > 0 ? "victim"
		: "absent"

	/*
	 * The enemy objective that followed. Filtered to THEIRS first and only then to the earliest,
	 * which is the fix for the measured bug where an ally Herald shadowed an enemy Baron.
	 */
	const after = input.objectives
		.filter(o => o.byEnemy)
		// Strictly after the last death, so the interval can never come out zero or negative.
		.filter(o => o.atSec > lastSec)
		.filter(o => o.atSec - lastSec <= BOUGHT_WINDOW_SEC)
		// Never one the feed has handed us ahead of the clock we were given.
		.filter(o => o.atSec <= input.nowSec)
		.sort((a, b) => a.atSec - b.atSec)[0]
	const afterPhrase = after ? objectivePhrase(after) : ""
	const bought =
		after && afterPhrase !== "" ?
			{ phrase: afterPhrase, gapSec: Math.round(after.atSec - lastSec) }
		:	null

	const fight: Fight = {
		id: `fight@${Math.round(firstSec)}`,
		firstSec,
		lastSec,
		ageSec,
		won,
		lost,
		participation,
		settled,
		bought
	}

	/*
	 * Kills are still landing. Nothing is said, by anyone, about anything.
	 *
	 * Guarded on a non-negative age so that clock skew between `gameTime` and `EventTime` — they
	 * are read at slightly different instants — cannot silence the coach on an event from the
	 * future.
	 */
	const quiet = ageSec >= 0 && ageSec < FIGHT_ACTIVE_SEC
	if (!settled) return { quiet, line: null, fight }

	if (ageSec > FIGHT_WORTH_SAYING_SEC) return { quiet: false, line: null, fight }

	/*
	 * An even trade he was IN is not news, and it was the single biggest source of noise here.
	 *
	 * Replaying the reference game produced "that fight was 1 for 1, so take your camps and reset"
	 * three separate times, plus four more even trades — 7 of 23 lines that would read identically
	 * pasted onto any game he has ever played, which is the exact test this project cuts an item
	 * for failing. He was standing there; he knows it went even. The absent case survives, because
	 * a four-man skirmish that traded evenly WITHOUT him is a fact he has no way of noticing.
	 */
	if (won === lost && participation !== "absent" && bought === null)
		return { quiet: false, line: null, fight }

	/*
	 * The line has to carry something he could not simply have watched happen.
	 *
	 * Three things qualify, and they are the three this module exists for: he was NOT in it, it
	 * bought them an objective, or there is an exact instruction attached to it. A fight he won,
	 * standing in it, with nothing exact to do next reduces to "that fight was 2 for 0" — the
	 * game gave him a banner and a sound for each of those kills, and the live prompt already
	 * ranks that kind of warmth below every fact. Eight of the reference game's nineteen lines
	 * were this, so it is not a corner.
	 */
	const next = tail(fight, input)
	if (bought === null && participation !== "absent" && next === "")
		return { quiet: false, line: null, fight }
	if (mem.announced.has(fight.id)) return { quiet: false, line: null, fight }
	/*
	 * Suppressed by the cooldown, and deliberately NOT marked announced: it stays eligible for the
	 * rest of its forty-second window, so a fight is delayed rather than lost.
	 */
	if (mem.lastSpokeAtSec > 0 && input.nowSec - mem.lastSpokeAtSec < FIGHT_COOLDOWN_SEC)
		return { quiet: false, line: null, fight }

	mem.announced.add(fight.id)
	mem.lastSpokeAtSec = input.nowSec

	return { quiet: false, line: phrase(fight, next), fight }
}

/*
 * UNITS ARE SPELLED OUT, EVERY TIME. These strings are the script — the model reads them close to
 * verbatim and a native-audio voice pronounces exactly what it is handed. "52s" came out as "fifty
 * two seds" and "1334g" as a letter, in a real game, out loud. Digits themselves are fine; the
 * abbreviated unit is what breaks. Write "seconds".
 */
const phrase = (fight: Fight, next: string): string => {
	/*
	 * "N for M" — his team's kills first, then his team's deaths, which is how the trade is said in
	 * every League conversation there has ever been. This is the shape of the line that actually
	 * passed measurement: "That fight was a rough 0 for 3, so back off and catch up."
	 */
	const head = `that fight was ${fight.won} for ${fight.lost}${
		fight.participation === "absent" ? " without you" : ""
	}`

	/*
	 * When the fight bought them something, that IS the coaching and it takes the whole sentence.
	 * No instruction is appended: the prompt bans padding a true fact with a clause the block did
	 * not supply, and there is no honest instruction available here that is not about where to be
	 * — which this module refuses to say.
	 */
	if (fight.bought)
		return `${head}, and they took ${fight.bought.phrase} ${
			/*
			 * Under three seconds, "N seconds later" is false precision on a rounded float and
			 * "1 seconds later" is not a thing a person says. The ordering is still exact; only
			 * the interval is dropped.
			 */
			fight.bought.gapSec < 3 ? "straight after" : `${fight.bought.gapSec} seconds later`
		}`

	return next === "" ? head : `${head}, so ${next}`
}

/**
 * What the next thirty seconds are for, or "" when nothing exact says.
 *
 * Every branch is decided by something exact — his own respawn timer, the live alive counts, his
 * own health fraction, the trade he has just been told. None of them names a place, because
 * nothing in this app knows where anybody is.
 *
 * There used to be a catch-all "take your camps and reset", and it ended 15 of the 23 lines the
 * reference game produced. That is the banned padding clause with a jungle noun in it: the prompt
 * lists "so you have a window" and "you can play around that" by name and says that if you cannot
 * name what the fact buys, you say the fact plainly and stop. So when nothing exact decides what
 * to do next, nothing is appended.
 */
const tail = (fight: Fight, input: FightInput): string => {
	// He is on the respawn screen. "Back off" is not an instruction he can follow from there.
	if (input.meDeadForSec !== null) return "come back and take camps, not fights"

	/*
	 * Outnumbered RIGHT NOW, which is not the same question as who won the fight — the bodies from
	 * a fight he won fifteen seconds ago may already be back up. Any deficit at all is enough to
	 * refuse the forward tail; that is deliberately stricter than the `enemiesAlive > alliesAlive
	 * + 1` in `live-facts.ts`, because that one gates offering a free objective and this one gates
	 * telling a man to walk forward.
	 */
	const outnumbered = input.enemiesAlive > input.alliesAlive
	if (outnumbered || fight.won < fight.lost) return "back off and catch up"

	const lowHp =
		input.hp !== null &&
		input.maxHp !== null &&
		input.maxHp > 0 &&
		input.hp / input.maxHp < LOW_HP_FRACTION
	if (lowHp) return "reset before you take anything else"

	if (input.alliesAlive > input.enemiesAlive && fight.won > fight.lost)
		return "take the free camps while you are up bodies"

	return ""
}
