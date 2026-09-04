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
 * ## Why the rate limiting is here too
 *
 * Every quality problem found by judging real sessions turned out to be structural, not tonal,
 * because most of these facts stay true for minutes:
 *
 *   - unspent gold was raised five times in nine turns;
 *   - the farm gap was recited three turns running with a widening number, which is nagging and,
 *     when the news is bad, just grinding someone down;
 *   - the same corpse was re-announced on every poll for its whole respawn — 40 of 55 spoken
 *     lines in one judged session were respawn timers, including one that chose a fourth
 *     Morgana timer over an explicit "1393g sitting unspent" sitting beside it in the list.
 *
 * "Please vary yourself" in a prompt does not survive that. Alternation, cooldowns and a cap do.
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

/** A death with less than this left is spent before the sentence is spoken and heard. */
export const DEATH_WORTH_SAYING_SEC = 12
/** Below this, unspent gold is not worth a sentence. */
export const GOLD_FLOOR = 1200
/** How much more must accumulate before unspent gold is news again. */
export const GOLD_STEP = 800
/**
 * Recognises a death-window fact in a rendered line, for the "never lead twice running" rule.
 *
 * A regex rather than a substring because the wording is deliberately varied — matching on the
 * literal phrase is how the alternation rule silently stopped working the last time it changed.
 */
export const DEATH_FACT = /^\d+ seconds without /

/*
 * UNITS ARE SPELLED OUT, EVERY TIME. These strings are the script — the model reads them almost
 * verbatim and a native-audio voice pronounces what it is given. "52s" came out as "fifty two
 * seds" and "1334g" as a letter, in a real game, out loud. There is no abbreviation here that is
 * worth a syllable of nonsense: write "seconds", "gold", "minutes".
 */

/**
 * How long an enemy objective take is still worth saying. Baron lasts three minutes; a take he
 * heard about four minutes later is history, not coaching.
 */
const ENEMY_OBJECTIVE_WORTH_SAYING_SEC = 45

/**
 * How long after a lost Baron or Herald the small talk stays off.
 *
 * Not a ranking tweak — a blackout. Ranking alone puts farm back on the next turn, twenty seconds
 * after the game may have been decided.
 */
const DISASTER_QUIET_SEC = 90

/** Game-clock seconds between farm-pace mentions. */
export const FARM_COOLDOWN_SEC = 180
/** His CS must have moved at least this much before the farm gap is worth restating. */
export const FARM_CS_MOVED = 15
/** Gold still unspent after this long has earned a second mention on its own. */
export const GOLD_NAG_SEC = 240
/** Both must have at least this long left for a multi-kill window to be worth calling. */
export const WINDOW_MIN_SEC = 10

/** Never offer more than this many facts — the model takes the top one most of the time. */
export const MAX_FACTS = 3

/**
 * Everything the ranker must remember between turns.
 *
 * Explicit rather than module-level so it can be constructed per game and asserted in a test —
 * the previous version kept it in module scope, where the alternation rule was unobservable.
 */
export interface FactMemory {
	announcedDeaths: Set<string>
	/** Enemy objective takes already announced, keyed by name+time. */
	announcedLosses: Set<string>
	announcedEvents: Set<number>
	/** Praise lines already used verbatim, so the same congratulation is never repeated. */
	praiseSaid: Set<string>
	lastGoldMentioned: number
	/** When gold was last raised, so persistent unspent gold can earn a second mention. */
	lastGoldAtSec: number
	/** When it first crossed the threshold — the duration is measured from here, not the mention. */
	goldSinceSec: number
	lastFarmAtSec: number
	/** His CS when farm was last raised; it must actually move before saying it again. */
	lastFarmCs: number
	lastLedWithDeath: boolean
}

export const newFactMemory = (): FactMemory => ({
	announcedDeaths: new Set(),
	announcedLosses: new Set(),
	announcedEvents: new Set(),
	praiseSaid: new Set(),
	lastGoldMentioned: 0,
	lastGoldAtSec: 0,
	goldSinceSec: 0,
	lastFarmAtSec: 0,
	lastFarmCs: 0,
	lastLedWithDeath: false
})

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
	 * Enemies only — an ally's death is on his own HUD.
	 *
	 * `killedByMe` marks the ones he got himself. A judge caught the coach reading his own kill
	 * back to him as scouting: his score went 5/0/5 to 6/0/5 on the same tick Renekton died, and
	 * it announced "Renekton just died, down for 14s" as though it were news.
	 */
	deadEnemies: { champion: string; respawnSec: number; killedByMe?: boolean }[]
	currentGold: number | null
	/** Non-null only when it is far enough off his own average to be worth a sentence. */
	pace: { cs: number; expected: number; exact: boolean } | null
	/** Events the player himself caused, already filtered to his name. */
	/**
	 * Major objectives the ENEMY just took, newest first.
	 *
	 * This did not exist, and its absence produced the worst line of the project: seconds after
	 * losing Baron the coach said "oh deer, your farm is slightly behind". Losing Baron was not a
	 * candidate fact at all — only HIM taking one was — so the ranker offered farm and gold and
	 * the model picked the best of a worthless list. Ranking by fact TYPE and never by STAKES is
	 * what makes a coach sound like it is not watching the same game.
	 */
	enemyObjectives: { name: string; atSec: number; dragonType?: string }[]
	myEvents: {
		id: number
		name: string
		killStreak?: number
		dragonType?: string
		stolen?: boolean
	}[]
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
 * Only worth mentioning an objective this far out — further ahead and it is not actionable yet,
 * and it would be repeated every turn until it arrived.
 */
export const OBJECTIVE_HORIZON_SEC = 60

/** `announcedEvents` is keyed by number; objective windows need a stable numeric id too. */
const hash = (s: string): number => {
	let h = 0
	for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
	return h
}

/**
 * The ranked, rate-limited list. Mutates `mem`, which is the point — it is the memory.
 */
export const buildFacts = (input: FactInput, mem: FactMemory): string[] => {
	/** Seconds until he is back on the map; 0 when he is already on it. */
	const dead = input.meDeadForSec ?? 0
	const praise: string[] = []
	const farm: string[] = []
	const money: string[] = []
	const deaths: string[] = []
	const windows: string[] = []
	const rest: string[] = []

	/*
	 * What the enemy just took, and what it means for the next few minutes. Highest stakes on the
	 * map, so it outranks everything and it SILENCES the trivia below — see `disaster`.
	 */
	const lost: string[] = []
	for (const e of input.enemyObjectives) {
		const age = input.nowSec - e.atSec
		if (age < 0 || age > ENEMY_OBJECTIVE_WORTH_SAYING_SEC) continue
		const id = `enemy-${e.name}@${Math.round(e.atSec)}`
		if (mem.announcedLosses.has(id)) continue
		mem.announcedLosses.add(id)
		if (e.name === "BaronKill")
			lost.push(
				`they have Baron — for the next three minutes their minions push on their own, so do not take a fight in the open`
			)
		else if (e.name === "HeraldKill") lost.push(`they have Herald and a free tower charge`)
		else if (e.name === "DragonKill")
			lost.push(`they took the ${e.dragonType ? `${e.dragonType.toLowerCase()} ` : ""}dragon`.replace(/\s+/g, " "))
	}

	/*
	 * A disaster silences the small talk.
	 *
	 * Even correctly RANKED, farm and gold would come back on the very next turn — twenty seconds
	 * after losing Baron, which is still absurd. For a while after something this size, the only
	 * things worth saying are about the thing that happened. Being quiet is a legitimate answer
	 * here and a farm reminder is not.
	 */
	const disaster = input.enemyObjectives.some(
		e => (e.name === "BaronKill" || e.name === "HeraldKill") &&
			input.nowSec - e.atSec >= 0 &&
			input.nowSec - e.atSec <= DISASTER_QUIET_SEC
	)

	/*
	 * Praise, straight off the event feed and announced once by the feed's own monotonic id.
	 * Without these the coach had nothing warm that was also grounded, so it either stayed silent
	 * — 48% of turns, measured — or reached for a compliment it could not support.
	 */
	for (const e of input.myEvents) {
		if (mem.announcedEvents.has(e.id)) continue
		let line = ""
		if (e.name === "ChampionKill" && (e.killStreak ?? 0) >= 2)
			line = `you just got a ${MULTI[e.killStreak!] ?? `${e.killStreak}-kill`}`
		else if (e.name === "DragonKill")
			line = e.stolen ? `you stole the ${e.dragonType ?? ""} dragon`.trim() : "you secured the dragon"
		else if (e.name === "BaronKill") line = e.stolen ? "you stole Baron" : "you secured Baron"
		else if (e.name === "HeraldKill") line = "you secured Herald"
		if (line === "") continue
		/*
		 * Two dragons are two events, but "you secured the dragon" twice is the same sentence —
		 * a judge found it delivered character-for-character identically eight lines apart.
		 */
		if (mem.praiseSaid.has(line)) continue
		mem.praiseSaid.add(line)
		mem.announcedEvents.add(e.id)
		praise.push(line)
	}

	/*
	 * The farm gap is reported again only if the gap itself has MOVED, not merely if time passed.
	 *
	 * A judge found it stated three times in ten minutes with a bigger number each time, during a
	 * stretch where the player's CS had not changed at all — the "deficit" was growing purely
	 * because the expected-pace curve keeps rising. That is scolding someone with a number they
	 * cannot affect between mentions, and it is exactly the pile-on that made the player stop
	 * listening.
	 */
	const gap = input.pace ? Math.abs(input.pace.cs - input.pace.expected) : 0
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
		/*
		 * "CS", never "camps". The figure is the live client's `creepScore` and the baseline is the
		 * metric defined as "Camps + CS @10" — BOTH are camps plus lane minions, so the comparison
		 * is sound and the old wording was not. A jungler who soaked two waves is not "27 camps
		 * behind"; saying so is a false statement about what was measured, which is the one kind of
		 * error this app exists to not make.
		 */
		const hedge = input.pace.exact ? "" : "roughly "
		farm.push(
			behind > 0 ?
				`you're ${hedge}${behind} CS behind your usual pace, ${input.pace.cs} against your usual ${input.pace.expected}`
			:	`you're ${hedge}${-behind} CS ahead of your usual pace, ${input.pace.cs} against your usual ${input.pace.expected}`
		)
	}

	/*
	 * Unspent gold is PERSISTENT state, and persistence is what makes it worth interrupting for.
	 *
	 * The first version raised it once and then suppressed it until another 800g arrived, so a
	 * judge found the coach silent through six minutes of an unspent item — a whole component
	 * sitting unbought — while spending eight lines on enemy death timers the player could read
	 * off his own HUD. Novel events were treated as valuable and durable state as one-shot,
	 * which is backwards.
	 *
	 * So: a step up is news, and so is the same gold still sitting there several minutes later.
	 */
	if (input.currentGold !== null) {
		if (input.currentGold < GOLD_FLOOR) {
			mem.lastGoldMentioned = 0
			mem.lastGoldAtSec = 0
			mem.goldSinceSec = 0
		} else if (dead > 0) {
			/*
			 * He is on the respawn screen with the shop open. Telling him his gold is unspent
			 * there is telling him about the thing he is looking at, and it reads as a scold.
			 */
			if (mem.goldSinceSec === 0) mem.goldSinceSec = input.nowSec
		} else {
			if (mem.goldSinceSec === 0) mem.goldSinceSec = input.nowSec
			const stepped =
				mem.lastGoldMentioned === 0 || input.currentGold - mem.lastGoldMentioned >= GOLD_STEP
			/*
			 * A re-mention needs time AND change. Without the second condition it repeated the
			 * same sentence word for word into a game state that had not moved a point in four
			 * minutes — an unchanged criticism restated because a timer fired, which is precisely
			 * how someone learns to tune the coach out.
			 */
			const stale =
				mem.lastGoldAtSec > 0 &&
				input.nowSec - mem.lastGoldAtSec >= GOLD_NAG_SEC &&
				input.currentGold !== mem.lastGoldMentioned
			if (stepped || stale) {
				money.push(
					stale && !stepped ?
						/*
					 * "since you last had a chance" was read as "since you last died" and turned
					 * into a fabricated twelve-minutes-ago anchor. It states the duration and
					 * nothing about its cause.
					 */
					/*
					 * Counted from when the gold FIRST crossed the threshold, not from the last
					 * time it was mentioned — otherwise every re-mention reset the clock and said
					 * "4m" forever, which the player can see is wrong.
					 */
					`${Math.round(input.currentGold)} gold unspent for ${Math.round((input.nowSec - mem.goldSinceSec) / 60)} minutes now`
					:	`${Math.round(input.currentGold)} gold sitting unspent`
				)
				mem.lastGoldMentioned = input.currentGold
				mem.lastGoldAtSec = input.nowSec
			}
		}
	}

	/*
	 * Two or more enemies down at once is a different fact from one enemy down, and a much better
	 * one: it is the window in which objectives are actually taken. It is exact, it is invisible
	 * without opening the scoreboard, and it expires in seconds.
	 *
	 * Deliberately not subject to the announce-once rule that single deaths use — the window is
	 * the thing being reported, not the deaths, and it changes as each of them respawns.
	 */
	/*
	 * Outnumbered: any "go take something" fact is worse than silence. He is not getting a free
	 * objective 1v4, and being told he has a window is how someone walks into four people.
	 */
	const outnumbered = input.enemiesAlive > input.alliesAlive + 1
	const windowOpen =
		outnumbered ? [] : input.deadEnemies.filter(d => d.respawnSec >= WINDOW_MIN_SEC)
	if (windowOpen.length >= 2) {
		const shortest = Math.min(...windowOpen.map(d => d.respawnSec))
		// What he can actually USE: the window minus however long until he is back on his feet.
		const usable = shortest - dead
		if (usable >= WINDOW_MIN_SEC) {
			const key = `${windowOpen.length}@${Math.round((input.nowSec + shortest) / 4)}`
			if (!mem.announcedDeaths.has(key)) {
				mem.announcedDeaths.add(key)
				windows.push(
					dead > 0 ?
						`${windowOpen.length} of them are dead — you are up in ${Math.round(dead)} seconds with about ${Math.round(usable)} seconds of window left`
					:	`${windowOpen.length} of them are dead — you have about ${Math.round(shortest)} seconds`
				)
			}
		}
	}

	/*
	 * `respawnSec` counts down, so nowSec + it is the death's respawn INSTANT — stable across
	 * polls and unique per death. Rounding to 2s absorbs poll jitter without merging two separate
	 * deaths of the same champion.
	 */
	for (const d of outnumbered ? [] : [...input.deadEnemies].sort((a, b) => b.respawnSec - a.respawnSec)) {
		// He was there. Telling him about a kill he just made is a readback, not scouting.
		if (d.killedByMe) continue
		// Same rule as the window: a death that ends before he is off the respawn screen is not
		// a tempo opportunity, it is a fact about someone else's game.
		if (d.respawnSec - dead < DEATH_WORTH_SAYING_SEC) continue
		const id = `${d.champion}@${Math.round((input.nowSec + d.respawnSec) / 2)}`
		if (mem.announcedDeaths.has(id)) continue
		mem.announcedDeaths.add(id)
		/*
		 * Phrased as the WINDOW, never as the news.
		 *
		 * "Renekton just died" narrates something he watched happen two seconds ago on his own
		 * screen — it spends the one sentence she gets per turn telling him what he already knows.
		 * The part he cannot see without holding TAB is how long it lasts, and the part worth
		 * saying is what it buys. So the death is the premise of the sentence, not its point.
		 */
		deaths.push(
			`${Math.round(d.respawnSec)} seconds without ${d.champion} — their side of the map is short one`
		)
	}

	/*
	 * An objective coming back is the most schedulable thing a jungler gets — it is the one fact
	 * that says where to be in thirty seconds rather than what just happened. Only inside a window
	 * where saying it changes anything: an objective back in four minutes is not news.
	 */
	const soon = (label: string, sec: number | null) => {
		if (sec === null || sec > OBJECTIVE_HORIZON_SEC || sec < 0) return
		const key = `${label}@${Math.round((input.nowSec + sec) / 30)}`
		if (mem.announcedEvents.has(hash(key))) return
		mem.announcedEvents.add(hash(key))
		rest.push(sec <= 5 ? `${label} is up NOW` : `${label} is back in ${Math.round(sec)} seconds`)
	}
	soon("Baron", input.baronBackInSec)
	soon("Drake", input.drakeBackInSec)
	soon("Herald", input.heraldBackInSec)

	// A window outranks everything but praise: it is the most actionable thing a jungler gets.
	/*
	 * Praise goes LAST, below everything, including single deaths.
	 *
	 * A dragon, a baron and a multi-kill are all announced by the game itself — full-screen banner
	 * and a sound cue — so saying them adds no information at all. Their value is warmth, not
	 * news, and warmth must never cost a fact: a judge found the coach spending its one
	 * interruption congratulating him on a banner he was watching, on a tick that also carried
	 * "12 camps behind your own pace", the only thing on screen he could not see.
	 *
	 * So praise still happens, but only when nothing else is on offer. That is most of the time
	 * it matters anyway — the moment after a fight is usually quiet.
	 */
	const nonDeath = [...windows, ...rest, ...money, ...farm]

	/*
	 * After a death has been offered, deaths are REMOVED from the next turn, not merely demoted.
	 *
	 * Demoting was tried and measured. With a death anywhere in the list the model reached for it
	 * regardless of order: 57% of spoken lines were the identical death sentence, including turns
	 * where "1393g sitting unspent" and "12 camps behind your own pace" sat above it. Ordering is
	 * a suggestion to a model; the contents of the list are not.
	 *
	 * The cost is a missed death every other turn, and that is the right trade — deaths are the
	 * most frequent fact by a wide margin, another is along shortly, and a coach that says the
	 * same sentence twenty times is one nobody listens to at all.
	 */
	const deathsAllowed = mem.lastLedWithDeath ? [] : deaths.slice(0, 1)
	const ranked =
		windows.length > 0 || rest.length > 0 ?
			[...windows, ...rest, ...money, ...farm, ...deathsAllowed, ...praise]
		:	[...nonDeath, ...deathsAllowed, ...praise]

	/*
	 * A live window is offered ALONE.
	 *
	 * Ranking it first was not enough: a judge found the coach picking a farm stat over "2 of them
	 * are dead — you have about 10s", the single most actionable fact in the transcript, spent on
	 * a number that would be equally true thirty seconds later. When something expires in seconds
	 * and everything else does not, there is no choice worth offering.
	 */
	/*
	 * A lost Baron or Herald is offered ALONE, and it silences everything else while it is fresh.
	 *
	 * The same argument as the window above, in the other direction. Losing Baron is the largest
	 * thing that happens in a game of League; offering it alongside a farm number invites the model
	 * to pick the farm number, and it did — "oh deer, your farm is slightly behind", seconds after
	 * the enemy took Baron. During the quiet window the ONLY things that may be said are the loss
	 * itself and anything that expires in seconds; if neither exists, saying nothing is correct.
	 */
	const out =
		lost.length > 0 ? lost.slice(0, 1)
		: windows.length > 0 ? windows.slice(0, 1)
		: disaster ? []
		: ranked.slice(0, MAX_FACTS)
	/*
	 * Set unconditionally, including to false on an empty turn.
	 *
	 * An empty turn means the coach had nothing and stayed quiet, so no death was spoken and the
	 * next one is not a repeat. Leaving the flag set through silence was tried and is worse than
	 * the problem: with nothing else ever on offer, deaths would be suppressed for the rest of the
	 * game after the first one.
	 */
	mem.lastLedWithDeath = out.some(f => DEATH_FACT.test(f))
	return out
}
