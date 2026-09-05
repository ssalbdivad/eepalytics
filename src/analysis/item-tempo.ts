/**
 * The item race — who has finished what, and how long one of them has been an item up.
 *
 * PURE. No I/O, no clock of its own, no model. It takes roster ticks in and produces ranked
 * sentences out, the same shape `live-facts.ts` works in.
 *
 * ## Why this fact and not another
 *
 * AGENTS.md sets two tests for a line worth saying out loud: it must not be VISIBLE (he could not
 * have got it by looking at his screen) and it must not be GENERIC (it could not have been said
 * about a different game, or five minutes ago in this one). The completed-item race passes both
 * more cleanly than anything else the client serves:
 *
 * - not visible — the enemy jungler's item list is behind TAB, and he is not holding TAB mid-clear;
 * - not generic — it names two specific items and a real gap, and the gap moves all game.
 *
 * The 1:1 game (`data/live-samples/split-03.ndjson`) is the case that motivated it. Briar finished
 * Blade of The Ruined King at 9:02 and Stridebreaker at 13:54; Lillia finished Liandry's Torment
 * at 9:38 and Riftmaker at 20:07. From 13:54 to 20:07 — SIX MINUTES AND THIRTEEN SECONDS — the
 * enemy jungler was a full item up, and nothing in this app ever said so.
 *
 * ## Staleness — the one fact that cannot go off
 *
 * Measured over four games (n=66): event-shaped facts were stale by the last syllable in 40% of
 * cases at zero latency, state-shaped ones in 5%. A completed-item count is the most durable
 * state-shaped fact the client has, because an item cannot un-finish. The only way one of these
 * sentences becomes false between the first syllable and the last is a SALE, which is rare and
 * which moves the count by one in a direction the next tick corrects.
 *
 * ## What the client actually gives, and what it does not
 *
 * `allPlayers[].items[]` carries `itemID`, `displayName`, `price`, `slot`, `count` and
 * `consumable`. That is the whole surface. In particular:
 *
 * - **`price` IS THE COMBINE COST, NOT THE TOTAL.** Measured over all 1221 recorded samples: the
 *   dearest item anyone held was B. F. Sword at 1300 — a COMPONENT — while Rabadon's Deathcap
 *   reports 1100 and Stridebreaker 750. No price threshold can separate a finished item from a
 *   component, in either direction. `src/server/routes/live.ts` currently filters the
 *   counterpart's items with `price >= 2000`, which matched ZERO of the 146 distinct items in the
 *   corpus; see the report accompanying this file.
 * - **There is no tier, recipe or "totalGold" field**, so completeness has to come from somewhere
 *   else. It comes from `ITEM_TIERS` below.
 * - **Gold spent is not recoverable.** Summing `price` over held items undercounts by every
 *   component that was absorbed, and summing it over observed ACQUISITIONS misses every component
 *   bought and combined inside one sampling interval. Nothing here reports gold.
 * - **Nothing here says what to buy.** This repo has never had build data and must not start
 *   inventing it. The facts below name what happened and when. The advice half comes from
 *   `knowledge/champions/*.md` through the existing `build` advice kind, which is digit-free by
 *   construction.
 */

/**
 * What an item IS, for the purpose of counting "items".
 *
 * `legendary` is the only tier that counts. Boots are tracked separately and deliberately not
 * counted: "he's an item up" in jungle vocabulary has never included boots, and folding them in
 * would make the gap jump at a boots upgrade and read as a lie to anyone checking.
 */
export type ItemTier =
	| "legendary"
	| "boots"
	| "component"
	| "starter"
	| "trinket"
	| "pet"
	| "support"
	| "consumable"
	| "unknown"

/**
 * Every item observed across the four recorded games, with the tier it counts as.
 *
 * **The ID and the NAME are both here, and both are checked at runtime**, because a table like
 * this is exactly the kind of thing that is right until a patch moves an id underneath it. An
 * entry only classifies an item when the client's own `displayName` matches; a mismatch, or an id
 * that is not here at all, resolves to `unknown` and SILENCES the comparison for that player
 * rather than shifting his count by one. A wrong count sounds precisely like a right one.
 *
 * Provenance, so this can be re-derived rather than trusted:
 *
 * - Every `[id, name]` pair below appears verbatim in `data/live-samples/split-01..04.ndjson`.
 * - 68 of the entries are marked `component` BY PROOF: they were observed vanishing from a
 *   player's inventory on the same tick another item appeared. Two of those absorptions were
 *   sales rather than builds — Sorcerer's Shoes at 01@33:57 and Rylai's Crystal Scepter at
 *   03@34:59, both replaced by an unrelated purchase — and those two are classified by hand as
 *   what they are.
 * - The rest are classified by hand. Where a hand call was not confident it is `unknown`, which
 *   costs silence and never a wrong number: `Hexoptics C44` is the only one, it was held by an
 *   ally in one game, and it never touched a comparison.
 */
const ITEM_TIERS: Record<number, readonly [name: string, tier: ItemTier]> = {
	// Consumables. The client flags these itself; they are listed so the table is exhaustive.
	2003: ["Health Potion", "consumable"],
	2010: ["Total Biscuit of Everlasting Will", "consumable"],
	2055: ["Control Ward", "consumable"],
	3513: ["Eye of the Herald", "consumable"],

	// Trinkets. Free, one slot, never part of a build.
	3340: ["Stealth Ward", "trinket"],
	3363: ["Farsight Alteration", "trinket"],
	3364: ["Oracle Lens", "trinket"],

	// Jungle pets. They upgrade and then vanish; neither event is an item.
	1101: ["Scorchclaw Pup", "pet"],
	1102: ["Gustwalker Hatchling", "pet"],
	1103: ["Mosstomper Seedling", "pet"],

	// Support quest line. Price 0 — they are earned, not bought, so they are not a tempo signal.
	3865: ["World Atlas", "support"],
	3866: ["Runic Compass", "support"],
	3867: ["Bounty of Worlds", "support"],
	3869: ["Celestial Opposition", "support"],
	3870: ["Dream Maker", "support"],
	3871: ["Zaz'Zak's Realmspike", "support"],
	3876: ["Solstice Sleigh", "support"],
	3877: ["Bloodsong", "support"],

	// Boots, every tier of them. Tracked, never counted. See `ItemTier`.
	1001: ["Boots", "boots"],
	2422: ["Slightly Magical Footwear", "boots"],
	3006: ["Berserker's Greaves", "boots"],
	3008: ["Gluttonous Greaves", "boots"],
	3009: ["Boots of Swiftness", "boots"],
	3020: ["Sorcerer's Shoes", "boots"],
	3047: ["Plated Steelcaps", "boots"],
	3111: ["Mercury's Treads", "boots"],
	3158: ["Ionian Boots of Lucidity", "boots"],
	3171: ["Crimson Lucidity", "boots"],
	3173: ["Chainlaced Crushers", "boots"],
	3175: ["Spellslinger's Shoes", "boots"],

	// Starters. Bought at 0:00, never finished into anything, never an item.
	1054: ["Doran's Shield", "starter"],
	1055: ["Doran's Blade", "starter"],
	1056: ["Doran's Ring", "starter"],
	1082: ["Dark Seal", "starter"],
	1086: ["Doran's Bow", "starter"],
	2031: ["Refillable Potion", "starter"],

	// Legendary — the ONLY tier that is counted.
	2501: ["Overlord's Bloodmail", "legendary"],
	2503: ["Blackfire Torch", "legendary"],
	2504: ["Kaenic Rookern", "legendary"],
	2512: ["Fiendhunter Bolts", "legendary"],
	2517: ["Endless Hunger", "legendary"],
	2520: ["Bastionbreaker", "legendary"],
	3031: ["Infinity Edge", "legendary"],
	3036: ["Lord Dominik's Regards", "legendary"],
	3041: ["Mejai's Soulstealer", "legendary"],
	3046: ["Phantom Dancer", "legendary"],
	3053: ["Sterak's Gage", "legendary"],
	3068: ["Sunfire Aegis", "legendary"],
	3071: ["Black Cleaver", "legendary"],
	3072: ["Bloodthirster", "legendary"],
	3073: ["Experimental Hexplate", "legendary"],
	3075: ["Thornmail", "legendary"],
	3085: ["Runaan's Hurricane", "legendary"],
	3087: ["Statikk Shiv", "legendary"],
	3089: ["Rabadon's Deathcap", "legendary"],
	3091: ["Wit's End", "legendary"],
	3094: ["Rapid Firecannon", "legendary"],
	3095: ["Stormrazor", "legendary"],
	3100: ["Lich Bane", "legendary"],
	3107: ["Redemption", "legendary"],
	3109: ["Knight's Vow", "legendary"],
	3110: ["Frozen Heart", "legendary"],
	3116: ["Rylai's Crystal Scepter", "legendary"],
	3118: ["Malignance", "legendary"],
	3135: ["Void Staff", "legendary"],
	3153: ["Blade of The Ruined King", "legendary"],
	3157: ["Zhonya's Hourglass", "legendary"],
	3161: ["Spear of Shojin", "legendary"],
	3181: ["Hullbreaker", "legendary"],
	3190: ["Locket of the Iron Solari", "legendary"],
	3222: ["Mikael's Blessing", "legendary"],
	3302: ["Terminus", "legendary"],
	3504: ["Ardent Censer", "legendary"],
	3508: ["Essence Reaver", "legendary"],
	4005: ["Imperial Mandate", "legendary"],
	4633: ["Riftmaker", "legendary"],
	4645: ["Shadowflame", "legendary"],
	4646: ["Stormsurge", "legendary"],
	6333: ["Death's Dance", "legendary"],
	6610: ["Sundered Sky", "legendary"],
	6617: ["Moonstone Renewer", "legendary"],
	6620: ["Echoes of Helia", "legendary"],
	6631: ["Stridebreaker", "legendary"],
	6653: ["Liandry's Torment", "legendary"],
	6655: ["Luden's Echo", "legendary"],
	6662: ["Iceborn Gauntlet", "legendary"],
	6672: ["Kraken Slayer", "legendary"],
	6673: ["Immortal Shieldbow", "legendary"],
	6675: ["Navori Flickerblade", "legendary"],
	6694: ["Serylda's Grudge", "legendary"],
	6697: ["Hubris", "legendary"],
	6699: ["Voltaic Cyclosword", "legendary"],

	// Components. 68 of these were proved by absorption; the rest are hand calls of the same kind.
	1004: ["Faerie Charm", "component"],
	1006: ["Rejuvenation Bead", "component"],
	1011: ["Giant's Belt", "component"],
	1018: ["Cloak of Agility", "component"],
	1026: ["Blasting Wand", "component"],
	1027: ["Sapphire Crystal", "component"],
	1028: ["Ruby Crystal", "component"],
	1029: ["Cloth Armor", "component"],
	1031: ["Chain Vest", "component"],
	1033: ["Null-Magic Mantle", "component"],
	1036: ["Long Sword", "component"],
	1037: ["Pickaxe", "component"],
	1038: ["B. F. Sword", "component"],
	1042: ["Dagger", "component"],
	1043: ["Recurve Bow", "component"],
	1052: ["Amplifying Tome", "component"],
	1053: ["Vampiric Scepter", "component"],
	1057: ["Negatron Cloak", "component"],
	1058: ["Needlessly Large Rod", "component"],
	2019: ["Steel Sigil", "component"],
	2020: ["The Brutalizer", "component"],
	2021: ["Tunneler", "component"],
	2022: ["Glowing Mote", "component"],
	2420: ["Seeker's Armguard", "component"],
	2421: ["Shattered Armguard", "component"],
	2508: ["Fated Ashes", "component"],
	3024: ["Glacial Buckler", "component"],
	3035: ["Last Whisper", "component"],
	3044: ["Phage", "component"],
	3051: ["Hearthbound Axe", "component"],
	3057: ["Sheen", "component"],
	3066: ["Winged Moonplate", "component"],
	3067: ["Kindlegem", "component"],
	3076: ["Bramble Vest", "component"],
	3077: ["Tiamat", "component"],
	3082: ["Warden's Mail", "component"],
	3086: ["Zeal", "component"],
	3108: ["Fiendish Codex", "component"],
	3113: ["Aether Wisp", "component"],
	3114: ["Forbidden Idol", "component"],
	3123: ["Executioner's Calling", "component"],
	3133: ["Caulfield's Warhammer", "component"],
	3134: ["Serrated Dirk", "component"],
	3144: ["Scout's Slingshot", "component"],
	3145: ["Hextech Alternator", "component"],
	3147: ["Haunting Guise", "component"],
	3211: ["Spectre's Cowl", "component"],
	3802: ["Lost Chapter", "component"],
	3916: ["Oblivion Orb", "component"],
	4630: ["Blighting Jewel", "component"],
	4642: ["Bandleglass Mirror", "component"],
	6660: ["Bami's Cinder", "component"],
	6670: ["Noonquiver", "component"],

	// Not confident, so not classified. See the provenance note above.
	2523: ["Hexoptics C44", "unknown"]
}

/**
 * What an item counts as, refusing rather than guessing.
 *
 * The name check is the whole point of passing `displayName`: an id that has been reused by a
 * later patch answers `unknown` instead of answering wrongly.
 */
export const itemTier = (itemID: number, displayName?: string): ItemTier => {
	const entry = ITEM_TIERS[itemID]
	if (!entry) return "unknown"
	if (displayName !== undefined && displayName !== entry[0]) return "unknown"
	return entry[1]
}

/** One row of `allPlayers[].items[]`, narrowed to the fields this module reads. */
export interface TempoItem {
	itemID: number
	displayName?: string
	consumable?: boolean
}

/** One player's inventory at one instant. */
export interface TempoPlayer {
	champion: string
	items: readonly TempoItem[]
}

/**
 * What one player has finished, accumulated across ticks.
 *
 * `atSec` is null for anything he was ALREADY HOLDING on the first tick this memory saw. That
 * distinction is load-bearing: `data/live-samples/split-01.ndjson` opens at 14:04 with four
 * legendaries already on the map, and a completion time invented for those would be the exact
 * shape of fabrication this app exists to prevent. The COUNT is still exact — it is read off the
 * current inventory — so the comparison survives a mid-game start and only the durations do not.
 */
export interface BuildLog {
	champion: string
	/** Finished items currently held, oldest first. `atSec` null when it predates observation. */
	completed: { itemID: number; name: string; atSec: number | null }[]
	/** Boots currently held, tracked and never counted. */
	boots: string | null
	/**
	 * Game clock of the first tick this PLAYER was seen on, or null before it.
	 *
	 * Per player rather than per memory, and that is not fussiness. The counterpart is resolved by
	 * declared position falling back to Smite, and either can arrive a tick or two after the
	 * player's own row does. With one shared flag, a counterpart who showed up on tick two had
	 * every item he was already holding stamped with tick two's clock and announced as though he
	 * had just finished all of them — a fabricated completion, in the one sentence whose whole
	 * value is that the completion is real.
	 */
	seenSec: number | null
	/** Names of held items this table could not classify. Non-empty means the count is refused. */
	unclassified: string[]
}

/** Everything the item race must remember between ticks. Mirrors `FactMemory`'s explicit shape. */
export interface ItemTempoMemory {
	me: BuildLog
	counterpart: BuildLog
	/** Game clock of the first tick seen. Null until the first tick. */
	fromSec: number | null
	lastSeenSec: number
	/** The current lead in finished items, signed: positive means the counterpart is up. */
	lead: number
	/** When the current lead first stood, or null when it predates observation. */
	leadSinceSec: number | null
	/** Item names already announced for the counterpart. */
	announcedItems: Set<string>
	/** Leads already announced, by signed size, so "an item up" is not said twice. */
	announcedLeads: Set<number>
	/** Leads whose DURATION has been announced, separately, because it is a different sentence. */
	announcedLongLeads: Set<number>
	/** When this module last offered anything, for its own floor. */
	lastOfferedAtSec: number
}

const emptyLog = (): BuildLog => ({
	champion: "",
	completed: [],
	boots: null,
	seenSec: null,
	unclassified: []
})

export const newItemTempoMemory = (): ItemTempoMemory => ({
	me: emptyLog(),
	counterpart: emptyLog(),
	fromSec: null,
	lastSeenSec: 0,
	lead: 0,
	leadSinceSec: null,
	announcedItems: new Set(),
	announcedLeads: new Set(),
	announcedLongLeads: new Set(),
	lastOfferedAtSec: 0
})

/** Forget everything, in place, between games. Same contract as `resetFactMemory`. */
export const resetItemTempoMemory = (mem: ItemTempoMemory): void => {
	Object.assign(mem, newItemTempoMemory())
}

/**
 * A clock that goes backwards is a new game.
 *
 * The same signal and the same jitter tolerance `live-facts.ts` and `daemon/live-sampler.ts` roll
 * their sessions on. Every rule below is a comparison against the game clock, so carrying one
 * game's timestamps into the next makes a lead that opened at 20:00 look like it has stood for
 * minus fourteen.
 */
export const CLOCK_BACK_SEC = 30

/**
 * How long a lead must have STOOD before it is worth a sentence.
 *
 * The instant it opens is already covered by `counterpart-finished`, which names the item. Saying
 * "he's a full item up" ten seconds later is the same news in worse words. Two minutes is the
 * point at which it has stopped being an event and become a state of the game — the same
 * reasoning, and the same order of magnitude, as the 150s gold hold in `live-facts.ts`.
 */
export const LEAD_MIN_HELD_SEC = 120

/**
 * How long between two item-race lines, whoever is ahead.
 *
 * Matches `ROUTINE_GAP_SEC` in `live-facts.ts`. The race is a `standing` fact: there is no such
 * thing as needing to hear one within two minutes of the last one.
 */
export const TEMPO_GAP_SEC = 120

/**
 * How long a lead must have stood before its DURATION is worth a sentence of its own.
 *
 * Measured, and this constant exists because the first attempt got it wrong. Folding "for the
 * last N minutes" into the standing line made every one of the 18 lines the four recorded games
 * produced read "for the last 2 minutes" — the clause fires the instant the hold threshold passes,
 * so it always reports the threshold back. Nearly a second of speech, at the 0.189s per syllable
 * this app measured, spent on a number that could be predicted from the rule.
 *
 * A duration is only news once it is a LOT longer than that, so it gets its own line and its own
 * once-per-lead budget. Against the corpus it fires three times in four games, and all three are
 * the strongest sentences the module makes — including 13:54 to 20:07 of `split-03.ndjson`, where
 * the enemy jungler held a full-item lead for six minutes and thirteen seconds.
 */
export const LEAD_LONG_SEC = 300

/**
 * Take one tick.
 *
 * Idempotent per clock: replaying the same instant twice changes nothing, so a caller that polls
 * faster than the game clock moves cannot invent completions.
 */
export const observeItems = (
	input: { nowSec: number; me: TempoPlayer; counterpart: TempoPlayer | null },
	mem: ItemTempoMemory
): void => {
	if (input.nowSec < mem.lastSeenSec - CLOCK_BACK_SEC) resetItemTempoMemory(mem)

	if (mem.fromSec === null) mem.fromSec = input.nowSec

	const firstForEither = mem.me.seenSec === null || (input.counterpart !== null && mem.counterpart.seenSec === null)
	readInto(mem.me, input.me, input.nowSec)
	if (input.counterpart) readInto(mem.counterpart, input.counterpart, input.nowSec)

	const lead = countable(mem.counterpart) - countable(mem.me)
	if (lead !== mem.lead) {
		mem.lead = lead
		/*
		 * A lead that first appears on the tick either player was first seen did not OPEN there,
		 * it was already standing — so it gets no duration rather than a duration of zero.
		 */
		mem.leadSinceSec = firstForEither ? null : input.nowSec
	}
	mem.lastSeenSec = input.nowSec
}

/**
 * How many finished items a log counts for, or -1 when it may not be counted at all.
 *
 * Refusing outright on an unclassifiable item is the safe direction and it is the only safe
 * direction: treating one as a component understates the count and treating it as legendary
 * overstates it, and both come out of the coach's mouth as a flat number.
 */
const countable = (log: BuildLog): number => (log.unclassified.length > 0 ? -1 : log.completed.length)

const readInto = (log: BuildLog, p: TempoPlayer, nowSec: number): void => {
	const first = log.seenSec === null
	if (first) log.seenSec = nowSec
	log.champion = p.champion
	const held = new Set<number>()
	const unclassified: string[] = []
	let boots: string | null = null
	for (const item of p.items) {
		if (item.consumable) continue
		const tier = itemTier(item.itemID, item.displayName)
		if (tier === "boots") boots = item.displayName ?? boots
		if (tier === "unknown") unclassified.push(item.displayName ?? `item ${item.itemID}`)
		if (tier !== "legendary") continue
		held.add(item.itemID)
		if (log.completed.some(c => c.itemID === item.itemID)) continue
		log.completed.push({
			itemID: item.itemID,
			name: item.displayName ?? ITEM_TIERS[item.itemID]?.[0] ?? `item ${item.itemID}`,
			atSec: first ? null : nowSec
		})
	}
	// A sold item stops counting. The list is what he HOLDS, which is what the sentence claims.
	log.completed = log.completed.filter(c => held.has(c.itemID))
	log.boots = boots
	log.unclassified = unclassified
}

/** What a line is about, for the caller's alternation rule. Reuses the existing `build` subject. */
export type ItemTempoKind = "counterpart-finished" | "items-behind" | "items-ahead"

/**
 * One sentence the coach may say, plus the memory write that spends it.
 *
 * Structurally what `live-facts.ts` calls a `Fact`, deliberately not importing that type: it is
 * not exported, and this module is meant to be wired in without editing the file that owns it.
 * `commit` runs ONLY if the line is actually offered — a fact that burns its cooldown while being
 * withheld is a fact that is never said.
 */
export interface ItemTempoFact {
	kind: ItemTempoKind
	text: string
	subject: "build"
	tier: "standing"
	commit: () => void
}

const minutes = (sec: number): number => Math.floor(sec / 60)

/**
 * The ranked list, most useful first. Empty is the normal case and means PASS.
 *
 * Order is deliberate. A newly finished item is the punchiest form of the same news — it is an
 * event, it names the item, and it can only be said once — so it leads. The standing gap is the
 * fallback for the minutes in between, and praise sits under both because a lead he holds is
 * pleasant rather than actionable.
 */
export const itemTempoFacts = (mem: ItemTempoMemory, nowSec: number): ItemTempoFact[] => {
	const out: ItemTempoFact[] = []
	const them = mem.counterpart
	const me = mem.me
	if (them.champion === "") return out

	/*
	 * What he just FINISHED, by name.
	 *
	 * The first tick is not news — everything is "new" then — so nothing observed at `fromSec`
	 * can be announced. That is what `atSec === null` marks.
	 */
	for (const item of them.completed) {
		if (item.atSec === null) continue
		if (mem.announcedItems.has(item.name)) continue
		out.push({
			kind: "counterpart-finished",
			text: `${them.champion} just finished ${item.name}`,
			subject: "build",
			tier: "standing",
			commit: () => {
				mem.announcedItems.add(item.name)
				mem.lastOfferedAtSec = nowSec
			}
		})
	}

	const mine = countable(me)
	const theirs = countable(them)
	/*
	 * -1 is the refusal from `countable`. A count that cannot be trusted is not COMPARED — but the
	 * finishes above still stand, because naming an item that was watched appearing does not
	 * depend on being able to classify everything else in the inventory.
	 */
	if (mine < 0 || theirs < 0) return out
	if (nowSec - mem.lastOfferedAtSec < TEMPO_GAP_SEC) return out

	const lead = theirs - mine
	if (lead === 0) return out

	const size = Math.abs(lead)
	const gap = size === 1 ? "a full item" : `${size} items`
	const heldSec = mem.leadSinceSec === null ? null : nowSec - mem.leadSinceSec

	/*
	 * The long-standing form outranks the plain one. "He's been a full item up for six minutes" is
	 * a different claim from "he's a full item up": the first is about the shape of the game and
	 * cannot be got from any single glance at the scoreboard, and it is the sentence this whole
	 * module exists to make possible.
	 */
	if (heldSec !== null && heldSec >= LEAD_LONG_SEC && !mem.announcedLongLeads.has(lead)) {
		const held = minutes(heldSec)
		out.push({
			kind: lead > 0 ? "items-behind" : "items-ahead",
			text:
				lead > 0 ?
					`${them.champion} has been ${gap} up on you for ${held} minutes, ${theirs} to ${mine}`
				:	`you've been ${gap} up on ${them.champion} for ${held} minutes, ${mine} to ${theirs}`,
			subject: "build",
			tier: "standing",
			commit: () => {
				mem.announcedLongLeads.add(lead)
				mem.announcedLeads.add(lead)
				mem.lastOfferedAtSec = nowSec
			}
		})
		return out
	}

	if (mem.announcedLeads.has(lead)) return out
	/*
	 * A lead already standing when watching began has NO duration and is still worth saying.
	 * Suppressing it would silence the whole fact for the games this app records from mid-game —
	 * `split-01.ndjson` opens at 14:04 — which is the one case where the race is already decided.
	 */
	if (heldSec !== null && heldSec < LEAD_MIN_HELD_SEC) return out

	out.push({
		kind: lead > 0 ? "items-behind" : "items-ahead",
		text:
			lead > 0 ?
				`${them.champion} is ${gap} up on you, ${theirs} to ${mine}`
			:	`you're ${gap} up on ${them.champion}, ${mine} to ${theirs}`,
		subject: "build",
		tier: "standing",
		commit: () => {
			mem.announcedLeads.add(lead)
			mem.lastOfferedAtSec = nowSec
		}
	})
	return out
}
