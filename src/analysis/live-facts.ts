/**
 * What the live coach is allowed to say, decided here rather than by the model.
 *
 * ## Why this is code and not prompt text
 *
 * Asked to "be actionable" from a screenshot, a vision model invents. The real session that
 * prompted all of this produced *"clear faster, you need to use more abilities"* said to someone
 * using abilities on cooldown — a claim nothing in the live data could have checked. So the model
 * does not derive facts. It is handed a short ranked list and may choose one and phrase it.
 *
 * ## Why the list is now two lists
 *
 * The fence above works: the coach stopped inventing. It then arrived somewhere else, and the
 * owner's words for it are the specification for this file:
 *
 *   > "analysis is way too shallow and useless stuff i can see in the game"
 *
 * A real transcript from his game: *"Drake is back in 52s"*, *"You have 1334g sitting unspent"*,
 * *"Wukong just died for 32s"*, *"Your farm is 130 against your 135 average"*. Every one of those
 * is TRUE, and every one but the last is on his HUD while it is being read to him. Restricting
 * the coach to client facts is what made it honest; offering only client READOUTS is what made it
 * useless. Optimising for true landed on useless.
 *
 * So every candidate now faces two tests, and both are enforced here rather than asked for in the
 * prompt:
 *
 *   1. **NOT VISIBLE** — could he have got this by looking at his own screen right now?
 *   2. **NOT GENERIC** — could this exact sentence have been said in a different game, or five
 *      minutes ago in this one?
 *
 * A fact that fails either one is not deleted — it is demoted to `context`, where the model may
 * REASON from it and may never read it out. That distinction is the whole design of this file and
 * it is in the type system on purpose: `SpokenFact` is a script, `ContextFact` is an input. Left
 * to the prompt it was a suggestion, and a suggestion loses to whichever line is easiest to say.
 *
 * The grammar carries the distinction too, which is a cheap second lock: spoken facts are written
 * in the SECOND person, because they are the sentence; context is written in the THIRD person, so
 * a model reading one out produces an obviously wrong "he has 1334g unspent" that both a listener
 * and the eval's judge notice immediately.
 *
 * ## Composition is where the value is
 *
 * "Drake is back in 45s" is on his HUD. "1334g unspent" is on his HUD. *"Drake in 45s and you're
 * sitting on 1334g — back now and be there with it spent"* is on neither, because it is two facts
 * multiplied into a decision. The composed lines below are all of that shape: a client fact times
 * another client fact times a piece of jungle reasoning. Neither factor is worth saying alone,
 * which is exactly why the uncomposed halves are now context.
 *
 * ## Fights, which used to be missing entirely
 *
 * Every line in that transcript was a camp, a coin or an objective timer. Nothing about fights —
 * whether to commit, whether it traded, whether he was even there — which is where a jungler's
 * decisions actually cash out. Fight reads arrive as `FightRead[]` (see the type) and outrank
 * every farm and gold fact in the ranking below.
 *
 * ## Why the rate limiting is here too
 *
 * Every quality problem found by judging real sessions turned out to be structural, not tonal,
 * because most of these facts stay true for minutes:
 *
 *   - unspent gold was raised five times in nine turns, and three times in the owner's transcript;
 *   - FOUR drake timers in one session, which is the same sentence with a smaller number;
 *   - the farm gap was recited three turns running with a widening number, which is nagging and,
 *     when the news is bad, just grinding someone down;
 *   - the same corpse was re-announced on every poll for its whole respawn — 40 of 55 spoken
 *     lines in one judged session were respawn timers.
 *
 * "Please vary yourself" in a prompt does not survive that. The per-fact cooldowns were not
 * enough either — they stopped the identical sentence and let the same KIND of fact run the
 * session. So there is now a per-TOPIC cooldown and a hard rule that the topic offered at the top
 * last turn may not be offered at all this turn.
 *
 * Pure: state goes in, state comes out. The daemon owns the one mutable copy.
 */

/** Riot's KillStreak counter, as words. */
const MULTI: Record<number, string> = {
	2: "double kill",
	3: "triple kill",
	4: "quadra kill",
	// Left shouting: it is a word people shout, and the game shouts it too.
	5: "pentakill"
}

/**
 * What kind of thing a fact is. The ranker, the cooldowns and the alternation rule all key on
 * this rather than on string matching, which is what `lastLedWithDeath` used to do for exactly
 * one topic.
 */
export type FactTopic = "fight" | "window" | "pick" | "objective" | "tempo" | "economy" | "praise"

/**
 * A line the coach may SPEAK, written the way he would hear it.
 *
 * `weight` orders them. It is a judgement about how much a jungler's next thirty seconds change
 * if he hears this instead of nothing — not a measurement, and never spoken.
 */
export interface SpokenFact {
	line: string
	topic: FactTopic
	weight: number
}

/**
 * A fact the model may REASON from and may NEVER read out.
 *
 * These are the HUD readouts. His gold, his health, an objective timer, a lone corpse: all true,
 * all already in front of him, and all genuinely useful for choosing and phrasing the spoken line
 * — "do not tell a man on 18% health to go invade" needs the health, and must never say it.
 */
export interface ContextFact {
	line: string
	topic: FactTopic | "state"
}

export interface FactSet {
	/** Ranked, best first, already rate-limited. Usually 0 or 1 entries. */
	say: SpokenFact[]
	/** Unranked background. Never a script. */
	context: ContextFact[]
}

/** A death with less than this left is spent before the sentence is spoken and heard. */
export const DEATH_WORTH_SAYING_SEC = 12
/** Below this, unspent gold is not worth reasoning about at all. */
export const GOLD_FLOOR = 1200
/** How much more must accumulate before unspent gold is news again. */
export const GOLD_STEP = 800
/** Game-clock seconds between farm-pace mentions. */
export const FARM_COOLDOWN_SEC = 180
/** His CS must have moved at least this much before the farm gap is worth restating. */
export const FARM_CS_MOVED = 15
/** Gold still unspent after this long has earned a mention on its own. */
export const GOLD_NAG_SEC = 240
/** Both must have at least this long left for a multi-kill window to be worth calling. */
export const WINDOW_MIN_SEC = 10

/**
 * Only worth mentioning an objective this far out — further ahead and it is not actionable yet,
 * and it would be repeated every turn until it arrived.
 */
export const OBJECTIVE_HORIZON_SEC = 60

/**
 * The window in which "back now" is real advice: far enough out to walk back and buy, close
 * enough that the objective is the reason. Outside it the timer is context, not a script.
 */
export const RECALL_WINDOW_SEC = { from: 25, to: 75 }

/** A fight older than this is history; he has already moved on and so has the map. */
export const FIGHT_FRESH_SEC = 45

/** Below this health fraction, every "go take something" line is bad advice. */
export const LOW_HP_FRAC = 0.35

/** Never offer more than this many facts — the model takes the top one most of the time. */
export const MAX_FACTS = 3

/** Never hand over more background than this; a long block invites reading it out. */
export const MAX_CONTEXT = 6

/**
 * Seconds before the same KIND of fact may be offered at the top again.
 *
 * Per-fact limits were already here and were demonstrably not enough: four drake timers and three
 * unspent-gold lines in one session were four and three DIFFERENT facts by the old rules, because
 * each carried a new number. What the listener hears is one sentence over and over.
 */
export const TOPIC_COOLDOWN_SEC: Record<FactTopic, number> = {
	// Short: a fight is the most perishable read here and a second one is genuinely new.
	fight: 40,
	window: 25,
	pick: 60,
	// Long: this is the one the transcript shows running away with the session.
	objective: 100,
	tempo: FARM_COOLDOWN_SEC,
	economy: 200,
	praise: 30
}

/**
 * Everything the ranker must remember between turns.
 *
 * Explicit rather than module-level so it can be constructed per game and asserted in a test —
 * the previous version kept it in module scope, where the alternation rule was unobservable.
 */
export interface FactMemory {
	announcedDeaths: Set<string>
	announcedEvents: Set<number>
	/** Fight ids already offered, so one skirmish is one line however long it stays fresh. */
	announcedFights: Set<string>
	/**
	 * Every line already offered as the top choice, verbatim, plus every praise line generated.
	 *
	 * The last line of defence against repetition, and it is a whole-game one: two of the fight
	 * sentences carry the same words when the numbers repeat, and a judge found "you secured the
	 * dragon" delivered character-for-character identically eight lines apart. A sentence he has
	 * already heard this game is not news, whatever produced it.
	 */
	saidLines: Set<string>
	lastGoldMentioned: number
	/** When gold was last raised, so persistent unspent gold can earn a second mention. */
	lastGoldAtSec: number
	/** When it first crossed the threshold — the duration is measured from here, not the mention. */
	goldSinceSec: number
	lastFarmAtSec: number
	/** His CS when farm was last raised; it must actually move before saying it again. */
	lastFarmCs: number
	/** The topic offered in the top slot last turn, or "" when the turn was silent. */
	lastTopic: FactTopic | ""
	/** Game clock at which each topic was last offered at the top. */
	topicAtSec: Record<string, number>
}

export const newFactMemory = (): FactMemory => ({
	announcedDeaths: new Set(),
	announcedEvents: new Set(),
	announcedFights: new Set(),
	saidLines: new Set(),
	lastGoldMentioned: 0,
	lastGoldAtSec: 0,
	goldSinceSec: 0,
	lastFarmAtSec: 0,
	lastFarmCs: 0,
	lastTopic: "",
	topicAtSec: {}
})

/**
 * One resolved skirmish, in HIS team's terms, as produced by `analysis/fights.ts`.
 *
 * Everything here is read straight off the live event feed — `ChampionKill` carries `KillerName`,
 * `VictimName`, `Assisters[]` and `EventTime`, which is enough to cluster kills into a fight and
 * to answer the only question that matters for coaching it: was he in it, and what did it buy.
 * Nothing here is interpolated and nothing here needs a position, which the live API does not have.
 */
export interface FightRead {
	/** Stable id for the cluster. The announce-once memory keys on it. */
	id: string
	/** Game clock of the fight's last kill, in seconds. */
	atSec: number
	/** Enemy champions his team killed in the cluster. */
	won: number
	/** His team's deaths in the cluster. */
	lost: number
	/** Was he killer, victim or assister on any kill in it. */
	involved: boolean
	/** Did he die in it. */
	died: boolean
}

export interface FactInput {
	nowSec: number
	/**
	 * How long until HE is back up, when he is dead. Null when alive.
	 *
	 * Load-bearing, and it was missing. A judge found three lines telling a corpse "two are down,
	 * you have about 14s" while his own respawn was 19s — he came back AFTER they did, so the
	 * window it handed him did not exist. The coach was reading the enemy respawn column and
	 * never its own player's, and the number was in the block the whole time.
	 */
	meDeadForSec: number | null
	/**
	 * His health as a fraction of maximum, or null when unknown.
	 *
	 * An INPUT, never a line: it is the biggest number on his own screen. It is here because
	 * every "go take his camps" fact below is wrong advice at 20% health, and the coach had no
	 * way to know that — the same class of error as telling a dead player to recall.
	 */
	myHpFrac: number | null
	/**
	 * Enemies only — an ally's death is on his own HUD.
	 *
	 * `killedByMe` marks the ones he got himself. A judge caught the coach reading his own kill
	 * back to him as scouting: his score went 5/0/5 to 6/0/5 on the same tick Renekton died, and
	 * it announced "Renekton just died, down for 14s" as though it were news.
	 *
	 * `isJungler` comes from the live client's own `position` field, which — unlike the
	 * match-history `timeline.lane` this repo refuses to trust — is reliable. It is the whole
	 * difference between "Viego is your jungle counterpart so watch for his ganks", which is
	 * sayable in every game ever played, and "Viego is down 34s, take his camps", which is
	 * sayable for the next 34 seconds only.
	 */
	deadEnemies: {
		champion: string
		respawnSec: number
		killedByMe?: boolean
		isJungler?: boolean
	}[]
	currentGold: number | null
	/** Non-null only when it is far enough off his own average to be worth a sentence. */
	pace: { cs: number; expected: number; exact: boolean } | null
	/** Events the player himself caused, already filtered to his name. */
	myEvents: {
		id: number
		name: string
		killStreak?: number
		dragonType?: string
		stolen?: boolean
	}[]
	/**
	 * Resolved skirmishes, oldest first, from `analysis/fights.ts`.
	 *
	 * The owner asked for this in as many words — "update it to give more feedback on fights not
	 * just camps" — and it is not a tuning problem: there was no fight fact of any kind, so the
	 * best possible output was a well-phrased camp count.
	 */
	fights: FightRead[]
	/**
	 * How many of his team, and how many of theirs, are alive right now.
	 *
	 * Used only to suppress tempo facts when he is outnumbered. A judge found the coach saying
	 * "Graves just died — down for 21s" while all four of his teammates were dead and four enemies
	 * were alive: "one of them is down, here's your window" is the exact wrong instinct in a 1v4,
	 * and the fact was true the whole time. A window is only a window if he can take it.
	 */
	alliesAlive: number
	enemiesAlive: number
	/**
	 * Seconds until each objective is back, counted from a take THIS SESSION ACTUALLY SAW.
	 *
	 * Null when no take was observed — never assumed from the clock. This is the same rule and the
	 * same constants the overlay already displays (`analysis/live-coach.ts`), and the coach was
	 * refusing to say what the overlay was already asserting, which is not a defensible split.
	 */
	drakeBackInSec: number | null
	baronBackInSec: number | null
	heraldBackInSec: number | null
}

/**
 * The nearest objective inside a window, best first: Baron outranks drake outranks Herald.
 *
 * Used only to COMPOSE — an objective timer is never a line of its own any more, because it is
 * printed on his own HUD and the owner's transcript has four of them in it.
 */
const nextObjective = (
	input: FactInput,
	fromSec: number,
	toSec: number
): { label: string; sec: number } | null => {
	const all: { label: string; sec: number | null }[] = [
		{ label: "Baron", sec: input.baronBackInSec },
		{ label: "drake", sec: input.drakeBackInSec },
		{ label: "Herald", sec: input.heraldBackInSec }
	]
	for (const o of all)
		if (o.sec !== null && o.sec >= fromSec && o.sec <= toSec)
			return { label: o.label, sec: o.sec }
	return null
}

/**
 * The ranked, rate-limited list. Mutates `mem`, which is the point — it is the memory.
 */
export const buildFacts = (input: FactInput, mem: FactMemory): FactSet => {
	/** Seconds until he is back on the map; 0 when he is already on it. */
	const dead = input.meDeadForSec ?? 0
	const say: SpokenFact[] = []
	const context: ContextFact[] = []

	/*
	 * Outnumbered: any "go take something" fact is worse than silence. He is not getting a free
	 * objective 1v4, and being told he has a window is how someone walks into four people.
	 */
	const outnumbered = input.enemiesAlive > input.alliesAlive + 1
	/*
	 * Same rule, one input further down. Health is on his screen so it is never a line, but a
	 * coach that says "take his camps" to someone on 18% is a coach he mutes — and this is the
	 * cheapest place to stop it, because it is one field the model never has to reason about.
	 */
	const lowHp = input.myHpFrac !== null && input.myHpFrac < LOW_HP_FRAC
	/** Whether a "leave what you are doing and go take something" line is defensible this tick. */
	const canCommit = !outnumbered && !lowHp && dead === 0

	/* ------------------------------------------------------------------ fights */

	/*
	 * Fights first, because a fight is the only thing here that is both perishable and a decision.
	 *
	 * Note what is NOT claimed: where anyone was, whether he could have got there, whose fault it
	 * was. The feed says who died and who got a takedown; absence is the absence of his name from
	 * every side of the cluster, which is a fact, and "be in the next one" is a decision. A
	 * position claim would be an invention — the live API has no positions at all.
	 */
	for (const f of input.fights) {
		if (mem.announcedFights.has(f.id)) continue
		if (input.nowSec - f.atSec > FIGHT_FRESH_SEC || f.atSec > input.nowSec) continue
		if (f.won + f.lost < 2) continue
		let line = ""
		let weight = 0
		if (!f.involved) {
			// He cannot be blamed for missing a fight he was dead for, and saying so is a scold.
			if (dead > 0) continue
			if (f.lost > f.won) {
				line = `your team just lost that one ${f.won} for ${f.lost} without you — be in the next one or be taking something`
				weight = 100
			} else if (f.won > f.lost) {
				line = `your team won that ${f.won} for ${f.lost} without you — cash it in, take an objective now`
				weight = 92
			}
		} else if (f.died && f.won >= 2) {
			line = `you went down but that one was ${f.won} for ${f.lost} — that is a trade you take every time`
			weight = 62
		} else if (f.died && f.won === 0) {
			line = `that one went ${f.won} for ${f.lost} and cost you — the next even fight, let it go`
			weight = 95
		} else if (!f.died && f.lost > f.won) {
			line = `that went ${f.won} for ${f.lost} — reset and take a camp instead of re-engaging`
			weight = 90
		} else if (!f.died && f.won >= 2) {
			line = `${f.won} for ${f.lost} and you walked out of it — that is the fight to keep picking`
			weight = 40
		}
		if (line === "") continue
		mem.announcedFights.add(f.id)
		say.push({ line, topic: "fight", weight })
	}

	/* ----------------------------------------------------------------- windows */

	/*
	 * Two or more enemies down at once is a different fact from one enemy down, and a much better
	 * one: it is the window in which objectives are actually taken. It is exact, it is invisible
	 * without opening the scoreboard, and it expires in seconds.
	 *
	 * Deliberately not subject to the announce-once rule that single deaths use — the window is
	 * the thing being reported, not the deaths, and it changes as each of them respawns.
	 */
	const windowOpen =
		outnumbered || lowHp ? [] : input.deadEnemies.filter(d => d.respawnSec >= WINDOW_MIN_SEC)
	if (windowOpen.length >= 2) {
		const shortest = Math.min(...windowOpen.map(d => d.respawnSec))
		// What he can actually USE: the window minus however long until he is back on his feet.
		const usable = shortest - dead
		if (usable >= WINDOW_MIN_SEC) {
			const key = `${windowOpen.length}@${Math.round((input.nowSec + shortest) / 4)}`
			if (!mem.announcedDeaths.has(key)) {
				mem.announcedDeaths.add(key)
				/*
				 * Composed with the objective when there is one, because "3 of them are dead" and
				 * "drake in 15s" are two halves of one decision, and the coach was offering them
				 * as two competing sentences and picking one.
				 */
				const obj = dead === 0 ? nextObjective(input, 0, 25) : null
				say.push({
					line:
						obj ?
							`${windowOpen.length} of them are dead and ${obj.label} is in ${Math.round(obj.sec)}s — that is the take`
						: dead > 0 ?
							`${windowOpen.length} of them are dead — you are up in ${Math.round(dead)}s with about ${Math.round(usable)}s of window left`
						:	`${windowOpen.length} of them are dead — you have about ${Math.round(shortest)}s`,
					topic: "window",
					weight: 88
				})
			}
		}
	}

	/* ------------------------------------------------------------------- picks */

	/*
	 * A lone corpse is a HUD readout — a greyed portrait, and a timer one tab away — so it is
	 * context by default. The exception is the enemy jungler, and the exception is the point: his
	 * death is the only one that changes what a jungler may safely do next, and the live client's
	 * own `position` field says which of them he is.
	 *
	 * This is the difference the owner named. "Viego is your jungle counterpart so watch for his
	 * ganks" is true in every game he has ever played. "Viego is down 34s, take his camps" is true
	 * for 34 seconds.
	 *
	 * `respawnSec` counts down, so nowSec + it is the death's respawn INSTANT — stable across
	 * polls and unique per death. Rounding to 2s absorbs poll jitter without merging two separate
	 * deaths of the same champion.
	 */
	const spokenDeaths = new Set<string>()
	for (const d of [...input.deadEnemies].sort((a, b) => b.respawnSec - a.respawnSec)) {
		// He was there. Telling him about a kill he just made is a readback, not scouting.
		if (!d.isJungler || d.killedByMe || !canCommit) continue
		// A death that ends before he can use it is a fact about someone else's game.
		if (d.respawnSec - dead < DEATH_WORTH_SAYING_SEC) continue
		const id = `${d.champion}@${Math.round((input.nowSec + d.respawnSec) / 2)}`
		if (mem.announcedDeaths.has(id)) continue
		mem.announcedDeaths.add(id)
		spokenDeaths.add(id)
		const obj = nextObjective(input, 0, Math.min(d.respawnSec, OBJECTIVE_HORIZON_SEC))
		say.push({
			line:
				obj ?
					`${d.champion} is down ${Math.round(d.respawnSec)}s and ${obj.label} is in ${Math.round(obj.sec)}s — that one is free`
				:	`${d.champion} is down ${Math.round(d.respawnSec)}s — take his camps while he cannot contest`,
			topic: "pick",
			weight: 80
		})
	}

	/* ----------------------------------------------------------- gold, composed */

	/*
	 * Unspent gold is PERSISTENT state, and it is also the single most visible number on his HUD.
	 * The owner's transcript has three unspent-gold lines in it and calls them out by name.
	 *
	 * So the number stops being a sentence on its own and becomes half of one. The half that
	 * makes it a decision is WHEN to go back, and the only trigger this data supports is an
	 * objective he wants to be at with the gold already spent — or a lull, with nobody dead and
	 * no fight on the feed, which is the other moment a jungler should be shopping. Everything
	 * else is context.
	 *
	 * Note that this is exactly the tail the prompt bans as an invention: "be there with your gold
	 * spent" was appended to a message that carried no gold line. It is not an invention when the
	 * two facts are composed here, in one tick, out of one block.
	 */
	let goldSpoken = false
	if (input.currentGold !== null) {
		if (input.currentGold < GOLD_FLOOR) {
			mem.lastGoldMentioned = 0
			mem.lastGoldAtSec = 0
			mem.goldSinceSec = 0
		} else {
			if (mem.goldSinceSec === 0) mem.goldSinceSec = input.nowSec
			/*
			 * He is on the respawn screen with the shop open. Telling him his gold is unspent
			 * there is telling him about the thing he is looking at, and it reads as a scold.
			 */
			if (dead === 0 && !lowHp) {
				const stepped =
					mem.lastGoldMentioned === 0 ||
					input.currentGold - mem.lastGoldMentioned >= GOLD_STEP
				/*
				 * A re-mention needs time AND change. Without the second condition it repeated the
				 * same sentence word for word into a game state that had not moved a point in four
				 * minutes — an unchanged criticism restated because a timer fired, which is
				 * precisely how someone learns to tune the coach out.
				 */
				const stale =
					mem.lastGoldAtSec > 0 &&
					input.nowSec - mem.lastGoldAtSec >= GOLD_NAG_SEC &&
					input.currentGold !== mem.lastGoldMentioned
				const obj = nextObjective(input, RECALL_WINDOW_SEC.from, RECALL_WINDOW_SEC.to)
				/*
				 * The other moment worth interrupting for: gold that has been sitting for a while
				 * with nothing else going on. The duration is the point — the tick where he
				 * crosses 1200g is a number on his screen, whereas an item's worth of gold he has
				 * been carrying for a minute through a quiet map is a habit, and habits are what
				 * this coach is for.
				 */
				const quiet =
					input.deadEnemies.length === 0 &&
					/*
					 * RECENT fights, not any fight. `fights` is the whole game's list, so testing
					 * it for emptiness meant "nothing has ever happened", which after the first
					 * kill of the game is never true — measured on a real timeline, where it
					 * silenced this line for the entire rest of the game.
					 */
					!input.fights.some(f => input.nowSec - f.atSec <= FIGHT_FRESH_SEC && f.atSec <= input.nowSec) &&
					input.nowSec - mem.goldSinceSec >= 60
				/*
				 * Counted from when the gold FIRST crossed the threshold, not from the last
				 * mention — otherwise every re-mention reset the clock and said "4m" forever,
				 * which the player can see is wrong. Below a minute it is left out entirely
				 * rather than rounded to a comical "unspent for 0m".
				 */
				const mins = Math.round((input.nowSec - mem.goldSinceSec) / 60)
				if ((stepped || stale) && (obj || quiet)) {
					say.push({
						line:
							obj ?
								`${obj.label} in ${Math.round(obj.sec)}s and you are sitting on ${Math.round(input.currentGold)}g — back now and be there with it spent`
							: mins >= 1 ?
								`${Math.round(input.currentGold)}g unspent for ${mins}m and nothing is happening — this is the back`
							:	`${Math.round(input.currentGold)}g unspent and nothing is happening — this is the back`,
						topic: "economy",
						weight: obj ? 55 : 45
					})
					mem.lastGoldMentioned = input.currentGold
					mem.lastGoldAtSec = input.nowSec
					goldSpoken = true
				}
			}
		}
	}

	/* ------------------------------------------------------------------- tempo */

	/*
	 * The farm gap survives as a SPOKEN fact and it is the only bare number that does, because it
	 * is the one figure here that is genuinely nowhere on his screen: it is his own history. It
	 * is also the one the owner did not call useless — he called it repetitive and inconsistently
	 * framed.
	 *
	 * So the framing is one sentence, always the same shape, reported again only if the gap itself
	 * has MOVED rather than merely if time passed. A judge found it stated three times in ten
	 * minutes with a bigger number each time, during a stretch where the player's CS had not
	 * changed at all — the "deficit" grew purely because the expected-pace curve keeps rising.
	 * That is scolding someone with a number they cannot affect between mentions.
	 *
	 * The tail is the champion-shaped half: on a jungler whose clear accelerates as it chains, a
	 * low camp count is an ABANDONED route far more often than a slow one, so "finish the route
	 * you are on" is the fix that actually follows from the number.
	 */
	const gap = input.pace ? Math.abs(input.pace.cs - input.pace.expected) : 0
	let farmSpoken = false
	if (
		input.pace &&
		gap >= 12 &&
		(mem.lastFarmAtSec === 0 || input.nowSec - mem.lastFarmAtSec >= FARM_COOLDOWN_SEC) &&
		(mem.lastFarmCs === 0 || Math.abs(input.pace.cs - mem.lastFarmCs) >= FARM_CS_MOVED)
	) {
		mem.lastFarmAtSec = input.nowSec
		mem.lastFarmCs = input.pace.cs
		const behind = input.pace.expected - input.pace.cs
		/*
		 * Written to be SAID, not parsed.
		 *
		 * The old form was `FARM: 14 camps AHEAD of your own pace (193 vs your usual 179) —
		 * interpolated, approximate`, and the coach read it out: label, shouty caps, parenthetical
		 * and all, while silently dropping the hedge at the end. These strings are the script, so
		 * the hedge is a word inside the sentence and there is nothing in them a person would not
		 * say out loud.
		 */
		const hedge = input.pace.exact ? "" : "roughly "
		say.push({
			line:
				behind > 0 ?
					`you are ${hedge}${behind} camps behind your own average, ${input.pace.cs} against your usual ${input.pace.expected} — finish the route you are on`
				:	`you are ${hedge}${-behind} camps ahead of your own average, ${input.pace.cs} against your usual ${input.pace.expected}`,
			topic: "tempo",
			weight: 50
		})
		farmSpoken = true
	}

	/* ------------------------------------------------------------------ praise */

	/*
	 * Praise, straight off the event feed and announced once by the feed's own monotonic id.
	 * Without these the coach had nothing warm that was also grounded, so it either stayed silent
	 * — 48% of turns, measured — or reached for a compliment it could not support.
	 *
	 * It ranks below everything: a dragon, a baron and a multi-kill are all announced by the game
	 * itself, full-screen banner and sound cue, so saying them adds no information at all. Their
	 * value is warmth, and warmth must never cost a fact.
	 */
	for (const e of input.myEvents) {
		if (mem.announcedEvents.has(e.id)) continue
		let line = ""
		if (e.name === "ChampionKill" && (e.killStreak ?? 0) >= 2)
			line = `you just got a ${MULTI[e.killStreak!] ?? `${e.killStreak}-kill`}`
		else if (e.name === "DragonKill")
			line =
				e.stolen ? `you stole the ${e.dragonType ?? ""} dragon`.trim() : "you secured the dragon"
		else if (e.name === "BaronKill") line = e.stolen ? "you stole Baron" : "you secured Baron"
		else if (e.name === "HeraldKill") line = "you secured Herald"
		if (line === "") continue
		/*
		 * Two dragons are two events, but "you secured the dragon" twice is the same sentence —
		 * a judge found it delivered character-for-character identically eight lines apart.
		 */
		/*
		 * Checked against the said set but NOT added to it here: the line is only a repeat once it
		 * has actually been spoken. Adding it at generation time made the ranker filter out the
		 * praise it had just produced, which is a fine illustration of why this set is written in
		 * exactly one place — at the bottom, on the line that was offered.
		 */
		if (mem.saidLines.has(line)) continue
		mem.announcedEvents.add(e.id)
		say.push({ line, topic: "praise", weight: 10 })
	}

	/* ----------------------------------------------------------------- context */

	/*
	 * Everything below failed test 1 — he is looking at it — and is offered anyway, in the third
	 * person, as material for choosing and phrasing. Demoting a fact is not deleting it: the
	 * corpse timer that was 40 of 55 spoken lines is still here, it just cannot BE the sentence.
	 *
	 * Ordered by how much it changes the advice, because only the first `MAX_CONTEXT` survive.
	 * Health leads because it decides whether a "go take something" line is sane at all.
	 *
	 * Respawn timers come next and are never dropped for a farm figure, because this is now the
	 * ONLY place in the whole block where a timer appears — the roster deliberately stopped
	 * printing death markers after the model invented timers to go with them ("Qiyana is down for
	 * 8 seconds", when Qiyana had none). A corpse the model can see on the frame with no timer
	 * anywhere in the message is the exact gap that gets filled with an invention.
	 */
	if (input.myHpFrac !== null && input.myHpFrac < 0.5)
		context.push({ line: `he is on ${Math.round(input.myHpFrac * 100)}% health`, topic: "state" })
	for (const d of [...input.deadEnemies].sort((a, b) => b.respawnSec - a.respawnSec)) {
		const id = `${d.champion}@${Math.round((input.nowSec + d.respawnSec) / 2)}`
		if (spokenDeaths.has(id) || d.respawnSec < 1) continue
		context.push({
			line: `${d.champion}${d.isJungler ? ", their jungler," : ""} is down ${Math.round(d.respawnSec)}s`,
			topic: "window"
		})
	}
	if (input.currentGold !== null && input.currentGold >= GOLD_FLOOR && !goldSpoken)
		context.push({ line: `he has ${Math.round(input.currentGold)}g unspent`, topic: "economy" })
	/*
	 * The farm figure is context ONLY when the gap is big enough to have been worth a sentence and
	 * something suppressed it — a cooldown, or a better fact.
	 *
	 * Measured on a real socket run: offering it on every tick produced "Your farm is 81 and your
	 * average is 79" spoken out loud, which is a readout of a two-camp difference and is worse
	 * than silence. Inside the noise band it is not background either; it is nothing.
	 */
	if (input.pace && gap >= 12 && !farmSpoken)
		context.push({
			line: `his farm is ${input.pace.cs} against his own average of ${input.pace.expected}`,
			topic: "tempo"
		})
	const timers: { label: string; sec: number | null }[] = [
		{ label: "Baron", sec: input.baronBackInSec },
		{ label: "Drake", sec: input.drakeBackInSec },
		{ label: "Herald", sec: input.heraldBackInSec }
	]
	for (const t of timers) {
		if (t.sec === null || t.sec < 0 || t.sec > OBJECTIVE_HORIZON_SEC) continue
		context.push({ line: `${t.label} is back in ${Math.round(t.sec)}s`, topic: "objective" })
	}

	/* ----------------------------------------------------------------- ranking */

	/*
	 * The topic offered at the top last turn is REMOVED this turn, not demoted.
	 *
	 * Demoting was tried and measured on the narrower version of this rule, which applied to
	 * deaths alone. With a death anywhere in the list the model reached for it regardless of
	 * order: 57% of spoken lines were the identical death sentence, including turns where
	 * "1393g sitting unspent" and "12 camps behind your own pace" sat above it. Ordering is a
	 * suggestion to a model; the contents of the list are not.
	 */
	const fresh = say
		.filter(f => !mem.saidLines.has(f.line))
		.filter(f => f.topic !== mem.lastTopic)
		.filter(f => {
			const last = mem.topicAtSec[f.topic]
			return last === undefined || input.nowSec - last >= TOPIC_COOLDOWN_SEC[f.topic]
		})
		.sort((a, b) => b.weight - a.weight)

	/*
	 * A fight and a live window are offered ALONE.
	 *
	 * Ranking first was not enough: a judge found the coach picking a farm stat over "2 of them
	 * are dead — you have about 10s", the single most actionable fact in the transcript, spent on
	 * a number that would be equally true thirty seconds later. When something expires in seconds
	 * and everything else does not, there is no choice worth offering.
	 */
	const top = fresh[0]
	const out =
		top && (top.topic === "fight" || top.topic === "window") ? [top] : fresh.slice(0, MAX_FACTS)

	/*
	 * Set unconditionally, including on an empty turn.
	 *
	 * An empty turn means the coach had nothing and stayed quiet, so nothing was spoken and the
	 * next turn is not a repeat. Leaving the flag set through silence was tried and is worse than
	 * the problem: with nothing else ever on offer, one topic would be suppressed for the rest of
	 * the game after its first appearance.
	 */
	mem.lastTopic = out[0]?.topic ?? ""
	if (out[0]) {
		mem.topicAtSec[out[0].topic] = input.nowSec
		mem.saidLines.add(out[0].line)
	}
	return { say: out, context: context.slice(0, MAX_CONTEXT) }
}
