/**
 * What the item rows in the live feed actually mean, and the arithmetic the feed is missing.
 *
 * ## The failure this exists to end
 *
 * Build claims were the largest cluster of FALSE lines in the graded live corpus. Three shapes,
 * all from the same hole:
 *
 * - *"Hit recall to finish your Liandry's Torment"* — he held Fated Ashes and Haunting Guise, and
 *   the payload named them without saying what they were parts of or what the rest cost.
 * - *"keep farming toward your second item"* — he held five finished items. Nothing in the payload
 *   could count them, because nothing in it could tell a finished item from a component.
 * - *"a two-item Briar"* — same count, applied to an enemy.
 *
 * None of those is a hallucinated NAME. They are real items, correctly read off the roster, put
 * into a sentence about PROGRESS that the payload had no way to support — which is the most
 * dangerous kind of wrong this app produces, because everything checkable in the sentence checks
 * out.
 *
 * ## Why the feed cannot answer it, and what does
 *
 * The client reports `itemID`, `displayName` and `price`. `price` is the item's OWN cost line —
 * `gold.base` in Data Dragon, verified equal on all 215 distinct items this app has ever observed
 * — so Liandry's Torment reads 800 on a 3,000g item and a sum of prices recovers a median 0.3 of
 * gold truly spent (`scripts/audit-live-fields.ts`, ten players of game 5639406342). Any
 * completeness test built on `price` is therefore both a threshold AND the wrong number: at the
 * 2,000g gate this replaces, Liandry's, Riftmaker and Hubris were all "not legendary" while
 * Needlessly Large Rod and B. F. Sword were.
 *
 * The missing numbers are static — they change on a patch, not on a game — and Riot publishes
 * them. `scripts/fetch-items.ts` vendors them into `item-table.ts`; this file is the only reader.
 *
 * ## What it will and will not say
 *
 * It answers: is this thing finished, what do these parts build into, and what does the rest cost.
 * Every one of those is exact.
 *
 * It does NOT answer what he has SPENT, and there is no function here that tries. Gold spent needs
 * a purchase history, the feed has none, and the one number that looks like it — summed `price` —
 * is the measurement above. It also does not answer what he SHOULD build: a recipe is a fact, a
 * build path is an opinion, and opinions about this champion live in `knowledge/champions/`.
 *
 * Pure and browser-safe, like everything else in `shared/`.
 */
import { ITEM_ROWS } from "./item-table.ts"
import type { ItemRow } from "./item-table.ts"

export interface ItemFacts {
	id: number
	name: string
	/** The item's own cost line. Exactly what the live client reports as `price`. */
	base: number
	/** What it costs to OWN, recipe included. The number the live feed does not carry. */
	total: number
	/** Ids consumed to make it, as a multiset — a recipe may name the same component twice. */
	from: readonly number[]
	/** Ids it can still become. Empty means there is nothing left to buy for it. */
	into: readonly number[]
	consumable: boolean
	trinket: boolean
	/** Buyable in the shop. False for a transformed item — Seraph's Embrace, Muramana. */
	purchasable: boolean
}

/**
 * The gold a player starts a game with, and the line that separates a starter from an item.
 *
 * It is a threshold and it is not an arbitrary one: a starter item is exactly the thing you can
 * buy at 0:00 with what you already have and that never becomes anything else. Doran's Ring is
 * 400, the jungle pets and Cull are 450, Doran's Shield and Blade are 450. The nearest thing above
 * the line with no recipe and nothing to build into is a 950g ARAM starter that does not appear on
 * Summoner's Rift.
 *
 * It matters because a jungle pet reads as a finished item to a classifier that only looks at the
 * recipe, and then every item count in the early game is one too high — which is the exact error
 * the ordinal claims were being graded against.
 */
export const STARTING_GOLD = 500

const BY_ID = new Map<number, ItemFacts>()
for (const r of ITEM_ROWS as readonly ItemRow[])
	BY_ID.set(r[0], {
		id: r[0],
		name: r[1],
		base: r[2],
		total: r[3],
		from: r[4],
		into: r[5],
		consumable: r[6] === 1,
		trinket: r[7] === 1,
		purchasable: r[8] === 1
	})

/** Everything known about one item id, or null when the table has never heard of it. */
export const itemOf = (id: number): ItemFacts | null => BY_ID.get(id) ?? null

/** Boots, the root of every pair of boots in the game. */
const BOOTS_ROOT = 1001

/**
 * Is this a pair of boots?
 *
 * By RECIPE, not by tag. Data Dragon's `Boots` tag is missing from at least one boot upgrade in
 * the current patch — Gunmetal Greaves is tagged `NonbootsMovement` — and a classifier that gets
 * boots wrong miscounts his items, which is the exact thing this module exists to get right.
 * Walking `from` back to 1001 has no exceptions.
 */
export const isBoots = (id: number): boolean => {
	let cursor = id
	for (let depth = 0; depth < 8; depth += 1) {
		if (cursor === BOOTS_ROOT) return true
		const it = BY_ID.get(cursor)
		const next = it?.from[0]
		if (next === undefined) return false
		cursor = next
	}
	return false
}

/**
 * What KIND of thing he is holding.
 *
 * - `completed` — nothing further can be bought for it. This is what a player means by "an item".
 * - `boots` — counted separately, because a player says "two items and boots" and never "three".
 * - `component` — something still builds out of it. Fated Ashes is one; so is Dark Seal.
 * - `starter` — a jungle pet, a Doran's, a Cull. No recipe, nothing to build into, and buyable
 *   with the gold he starts the game holding. Nobody counts these as items, and a classifier that
 *   does runs the early-game count one high for the whole game.
 * - `trinket` / `consumable` — not a build slot at all.
 * - `unknown` — the table has never heard of this id. Says so rather than guessing a category,
 *   because the table is a patch behind the moment a patch ships and silence is the safe answer.
 */
export type ItemRole =
	| "completed"
	| "boots"
	| "component"
	| "starter"
	| "trinket"
	| "consumable"
	| "unknown"

export const roleOf = (id: number): ItemRole => {
	const it = BY_ID.get(id)
	if (!it) return "unknown"
	if (it.trinket) return "trinket"
	if (it.consumable) return "consumable"
	if (isBoots(id)) return "boots"
	if (it.into.length > 0) return "component"
	/*
	 * No recipe AND nothing to build into: either a starter, or a TRANSFORMED item. Seraph's
	 * Embrace and Muramana have no recipe either — they are what a Tear becomes — and they are
	 * finished items worth 2,900g. `purchasable` is what tells them apart, and it is the shop's
	 * own answer rather than a guess of ours.
	 */
	if (it.from.length === 0 && it.purchasable && it.total <= STARTING_GOLD) return "starter"
	return "completed"
}

export interface Inventory {
	completed: ItemFacts[]
	boots: ItemFacts | null
	components: ItemFacts[]
	/** The jungle pet, the Doran's — held, named, and never counted as an item. */
	starters: ItemFacts[]
	trinket: ItemFacts | null
	consumables: ItemFacts[]
	/** Ids the table does not know. Never counted as anything. */
	unknown: number[]
}

/** Sort one player's item ids into the categories a coach can talk about. */
export const inventoryOf = (ids: readonly number[]): Inventory => {
	const inv: Inventory = {
		completed: [],
		boots: null,
		components: [],
		starters: [],
		trinket: null,
		consumables: [],
		unknown: []
	}
	for (const id of ids) {
		const it = BY_ID.get(id)
		if (!it) {
			inv.unknown.push(id)
			continue
		}
		switch (roleOf(id)) {
			case "completed":
				inv.completed.push(it)
				break
			case "boots":
				inv.boots = it
				break
			case "component":
				inv.components.push(it)
				break
			case "starter":
				inv.starters.push(it)
				break
			case "trinket":
				inv.trinket = it
				break
			default:
				inv.consumables.push(it)
		}
	}
	return inv
}

export interface BuildTarget {
	id: number
	name: string
	/** What the whole item costs from nothing. */
	total: number
	/** What is LEFT to pay, given what he is already holding. Exact. */
	remaining: number
	/**
	 * What he has already sunk into this particular recipe — `total` minus `remaining`.
	 *
	 * This is the field that orders the list, and it is the one that matters. Sorting by what is
	 * LEFT puts Kindlegem (550g left, 250g of Glowing Mote in it) above Liandry's Torment (800g
	 * left, 2,200g of Fated Ashes and Haunting Guise in it) — which is arithmetically true and
	 * exactly backwards as coaching. What he is building is the thing he has already paid for.
	 */
	covered: number
	/** The held items this target would consume, by name. */
	have: string[]
	/** What is still to be bought, by name — the leaves, not the sub-recipes. */
	missing: string[]
}

/**
 * Spend what he holds against one recipe, and return what is left to pay.
 *
 * Recursive because a recipe is a tree and a held item can sit at any level of it: Shattered
 * Armguard is one purchase that covers three leaves of Zhonya's. `pool` is consumed as it goes, so
 * a recipe naming the same component twice (Shattered Armguard takes two Cloth Armours) is paid
 * for twice unless he holds two.
 */
const spend = (
	id: number,
	pool: Map<number, number>,
	have: string[],
	missing: string[]
): number => {
	const held = pool.get(id) ?? 0
	const it = BY_ID.get(id)
	if (held > 0) {
		pool.set(id, held - 1)
		if (it) have.push(it.name)
		return 0
	}
	if (!it) return 0
	if (it.from.length === 0) {
		missing.push(it.name)
		return it.total
	}
	let cost = it.base
	for (const child of it.from) cost += spend(child, pool, have, missing)
	return cost
}

/**
 * What the parts in his hands could become, and what each one still costs.
 *
 * EVERY candidate is returned rather than one guess at his intent, cheapest first. Picking a
 * single "what he is building toward" would need a tie-break, and a tie-break is a judgement
 * dressed as a fact — which is how "finish your Liandry's" got said to a man who had not bought a
 * Fiendish Codex. A list of exact options cannot be wrong about his plan, because it does not
 * claim to know it.
 *
 * A target is a candidate when at least one COMPONENT he holds feeds it. An item he already owns
 * is never a candidate, and neither is one whose recipe his parts do not touch.
 */
export const buildTargets = (ids: readonly number[]): BuildTarget[] => {
	const owned = new Set(ids)
	const pool = new Map<number, number>()
	for (const id of ids) if (BY_ID.has(id)) pool.set(id, (pool.get(id) ?? 0) + 1)

	const candidates = new Set<number>()
	for (const id of ids) {
		if (roleOf(id) !== "component") continue
		for (const up of BY_ID.get(id)?.into ?? []) if (!owned.has(up)) candidates.add(up)
	}

	const out: BuildTarget[] = []
	for (const id of candidates) {
		const it = BY_ID.get(id)
		if (!it) continue
		const have: string[] = []
		const missing: string[] = []
		// A fresh copy per candidate: the same Fated Ashes may be spent against several recipes.
		const remaining = spend(id, new Map(pool), have, missing)
		out.push({ id, name: it.name, total: it.total, remaining, covered: it.total - remaining, have, missing })
	}
	return out.sort((a, b) => b.covered - a.covered || a.remaining - b.remaining || a.name.localeCompare(b.name))
}

/**
 * The best candidate that is actually a SPIKE, or null.
 *
 * `buildTargets` returns every recipe his parts feed, which includes the sub-recipes: a Glowing
 * Mote makes a Fiendish Codex a candidate, and a Fiendish Codex makes an Oblivion Orb one.
 * Replayed over this app's twelve recorded games, taking the top row unfiltered produced
 * *"Fiendish Codex is 200 gold away"* and *"Hextech Alternator is 300 gold away"* — true, cheap,
 * and not a reason to walk to the fountain. What earns a back is a finished item or boots.
 *
 * `roleOf` decides it, so a component can never be called a spike and the threshold that used to
 * do this job (`price >= 2000`) does not come back in a new place.
 */
export const nextSpike = (ids: readonly number[]): BuildTarget | null => {
	for (const t of buildTargets(ids)) {
		const role = roleOf(t.id)
		if (role === "completed" || role === "boots") return t
	}
	return null
}

/**
 * THERE IS NO `goldSpent` HERE, and its absence is the finding.
 *
 * It is the obvious next function and it cannot be written from this feed. Summing `price` over
 * the item rows recovers a median 0.3 of true gold spent and collapses to 0.21 the moment
 * components combine, because a component consumed into a legendary contributes only its own cost
 * line and then disappears from the row entirely. Summing `total` over held items is closer but is
 * a different quantity — it is what his CURRENT inventory is worth, not what he has spent, and the
 * difference is every component he has already consumed and every item he sold. The feed carries
 * no purchase history, so neither number is knowable and this module offers neither.
 */
