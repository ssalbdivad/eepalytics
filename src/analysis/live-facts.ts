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
	5: "PENTAKILL"
}

/** A death with less than this left is spent before the sentence is spoken and heard. */
export const DEATH_WORTH_SAYING_SEC = 12
/** Below this, unspent gold is not worth a sentence. */
export const GOLD_FLOOR = 1200
/** How much more must accumulate before unspent gold is news again. */
export const GOLD_STEP = 800
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
	announcedEvents: Set<number>
	lastGoldMentioned: number
	/** When gold was last raised, so persistent unspent gold can earn a second mention. */
	lastGoldAtSec: number
	lastFarmAtSec: number
	/** His CS when farm was last raised; it must actually move before saying it again. */
	lastFarmCs: number
	lastLedWithDeath: boolean
}

export const newFactMemory = (): FactMemory => ({
	announcedDeaths: new Set(),
	announcedEvents: new Set(),
	lastGoldMentioned: 0,
	lastGoldAtSec: 0,
	lastFarmAtSec: 0,
	lastFarmCs: 0,
	lastLedWithDeath: false
})

export interface FactInput {
	nowSec: number
	/** Enemies only — an ally's death is on his own HUD. */
	deadEnemies: { champion: string; respawnSec: number }[]
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
	/** Seconds since the last objective of each kind, when one has happened. */
	sinceDrakeSec: number | null
	sinceBaronSec: number | null
}

const mmss = (sec: number): string =>
	`${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`

/**
 * The ranked, rate-limited list. Mutates `mem`, which is the point — it is the memory.
 */
export const buildFacts = (input: FactInput, mem: FactMemory): string[] => {
	const praise: string[] = []
	const farm: string[] = []
	const money: string[] = []
	const deaths: string[] = []
	const windows: string[] = []
	const rest: string[] = []

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
			line = e.stolen ? `you STOLE the ${e.dragonType ?? ""} dragon`.trim() : "you secured the dragon"
		else if (e.name === "BaronKill") line = e.stolen ? "you STOLE Baron" : "you secured Baron"
		else if (e.name === "HeraldKill") line = "you secured Herald"
		if (line === "") continue
		mem.announcedEvents.add(e.id)
		praise.push(`PRAISE: ${line} — worth saying so`)
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
		const tail = input.pace.exact ? "" : " — interpolated, approximate"
		farm.push(
			behind > 0 ?
				`FARM: ${behind} camps behind your own pace (${input.pace.cs} vs your usual ${input.pace.expected})${tail}`
			:	`FARM: ${-behind} camps AHEAD of your own pace (${input.pace.cs} vs your usual ${input.pace.expected})${tail}`
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
		} else {
			const stepped =
				mem.lastGoldMentioned === 0 || input.currentGold - mem.lastGoldMentioned >= GOLD_STEP
			const stale = mem.lastGoldAtSec > 0 && input.nowSec - mem.lastGoldAtSec >= GOLD_NAG_SEC
			if (stepped || stale) {
				money.push(
					stale && !stepped ?
						`${Math.round(input.currentGold)}g STILL unspent — ${Math.round((input.nowSec - mem.lastGoldAtSec) / 60)}m since you last had a chance`
					:	`${Math.round(input.currentGold)}g sitting unspent`
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
	const windowOpen = input.deadEnemies.filter(d => d.respawnSec >= WINDOW_MIN_SEC)
	if (windowOpen.length >= 2) {
		const shortest = Math.min(...windowOpen.map(d => d.respawnSec))
		const key = `${windowOpen.length}@${Math.round((input.nowSec + shortest) / 4)}`
		if (!mem.announcedDeaths.has(key)) {
			mem.announcedDeaths.add(key)
			windows.push(
				`${windowOpen.length} of them are dead — you have about ${Math.round(shortest)}s`
			)
		}
	}

	/*
	 * `respawnSec` counts down, so nowSec + it is the death's respawn INSTANT — stable across
	 * polls and unique per death. Rounding to 2s absorbs poll jitter without merging two separate
	 * deaths of the same champion.
	 */
	for (const d of [...input.deadEnemies].sort((a, b) => b.respawnSec - a.respawnSec)) {
		if (d.respawnSec < DEATH_WORTH_SAYING_SEC) continue
		const id = `${d.champion}@${Math.round((input.nowSec + d.respawnSec) / 2)}`
		if (mem.announcedDeaths.has(id)) continue
		mem.announcedDeaths.add(id)
		deaths.push(`${d.champion} just died — down for ${Math.round(d.respawnSec)}s`)
	}

	if (input.sinceDrakeSec !== null) rest.push(`last drake was taken ${mmss(input.sinceDrakeSec)} ago`)
	if (input.sinceBaronSec !== null) rest.push(`last Baron was taken ${mmss(input.sinceBaronSec)} ago`)

	// A window outranks everything but praise: it is the most actionable thing a jungler gets.
	const nonDeath = [...praise, ...windows, ...farm, ...money, ...rest]

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
		praise.length > 0 ?
			[...praise, ...windows, ...farm, ...money, ...deathsAllowed]
		:	[...nonDeath, ...deathsAllowed]

	const out = ranked.slice(0, MAX_FACTS)
	/*
	 * Set unconditionally, including to false on an empty turn.
	 *
	 * An empty turn means the coach had nothing and stayed quiet, so no death was spoken and the
	 * next one is not a repeat. Leaving the flag set through silence was tried and is worse than
	 * the problem: with nothing else ever on offer, deaths would be suppressed for the rest of the
	 * game after the first one.
	 */
	mem.lastLedWithDeath = out.some(f => f.includes("just died"))
	return out
}
