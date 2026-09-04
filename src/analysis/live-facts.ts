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
	lastFarmAtSec: number
	lastLedWithDeath: boolean
}

export const newFactMemory = (): FactMemory => ({
	announcedDeaths: new Set(),
	announcedEvents: new Set(),
	lastGoldMentioned: 0,
	lastFarmAtSec: 0,
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
			line = `HE just got a ${MULTI[e.killStreak!] ?? `${e.killStreak}-kill`}`
		else if (e.name === "DragonKill")
			line = e.stolen ? `HE STOLE the ${e.dragonType ?? ""} dragon`.trim() : "HE secured the dragon"
		else if (e.name === "BaronKill") line = e.stolen ? "HE STOLE Baron" : "HE secured Baron"
		else if (e.name === "HeraldKill") line = "HE secured Herald"
		if (line === "") continue
		mem.announcedEvents.add(e.id)
		praise.push(`${line} — worth saying so`)
	}

	if (
		input.pace &&
		Math.abs(input.pace.cs - input.pace.expected) >= 12 &&
		(mem.lastFarmAtSec === 0 || input.nowSec - mem.lastFarmAtSec >= FARM_COOLDOWN_SEC)
	) {
		mem.lastFarmAtSec = input.nowSec
		const behind = input.pace.expected - input.pace.cs
		const tail = input.pace.exact ? "" : " — interpolated, approximate"
		farm.push(
			behind > 0 ?
				`FARM: ${behind} camps behind his own pace (${input.pace.cs} vs his usual ${input.pace.expected})${tail}`
			:	`FARM: ${-behind} camps AHEAD of his own pace (${input.pace.cs} vs his usual ${input.pace.expected})${tail}`
		)
	}

	if (input.currentGold !== null) {
		if (input.currentGold < GOLD_FLOOR) mem.lastGoldMentioned = 0
		else if (
			mem.lastGoldMentioned === 0 ||
			input.currentGold - mem.lastGoldMentioned >= GOLD_STEP
		) {
			money.push(`${Math.round(input.currentGold)}g sitting unspent`)
			mem.lastGoldMentioned = input.currentGold
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
		deaths.push(`${d.champion} JUST died — down for ${Math.round(d.respawnSec)}s`)
	}

	if (input.sinceDrakeSec !== null) rest.push(`last drake was taken ${mmss(input.sinceDrakeSec)} ago`)
	if (input.sinceBaronSec !== null) rest.push(`last Baron was taken ${mmss(input.sinceBaronSec)} ago`)

	const nonDeath = [...praise, ...farm, ...money, ...rest]
	const ranked =
		praise.length > 0 ? [...praise, ...farm, ...money, ...deaths.slice(0, 1)]
			// Alternate: a death may not lead two turns running.
		: !mem.lastLedWithDeath && deaths.length > 0 ? [...deaths.slice(0, 1), ...nonDeath]
		: [...nonDeath, ...deaths.slice(0, 1)]

	const out = ranked.slice(0, MAX_FACTS)
	if (out.length > 0) mem.lastLedWithDeath = out[0]!.includes("JUST died")
	return out
}
