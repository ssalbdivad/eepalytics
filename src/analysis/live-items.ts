/**
 * Inventories, and the one thing about an inventory that is worth interrupting someone for:
 * that it CHANGED.
 *
 * ## Why a module and not four lines in the route
 *
 * A list of items is state the player can mostly see (his own bar) or look up (Tab). "Viego
 * finished Black Cleaver eleven seconds ago" is neither, and it is the difference between
 * *"Viego resets on takedowns, be careful"* — true in every game he has ever played — and a
 * sentence that could only be said in this one, at this minute. The delta is the product; the
 * list underneath it is there so the coach cannot recommend an item he already owns.
 *
 * The live client is the only source that has any of this: the post-game timeline this app
 * otherwise runs on carries `CHAMPION_KILL`, `ELITE_MONSTER_KILL` and `BUILDING_KILL` and no
 * purchases at all (verified against the stored blobs — those three event types are the whole
 * set). So this is live-only by construction, and everything here degrades to "no items known"
 * rather than guessing.
 *
 * Pure, browser-safe, and memory is passed in — same contract as `live-facts.ts`, for the same
 * reason: a rate limit kept in module scope is a rate limit no test can watch.
 */

import type { VisionStateItem } from "../shared/live-state.ts"

/**
 * How long an item stays marked NEW.
 *
 * The block is rebuilt per coaching turn and the app's turn heartbeat is ~20s, so this is about
 * two turns' worth: long enough that a purchase is not missed by a turn that was busy with a
 * death, short enough that "just picked up" is still true when it is said out loud.
 */
export const ITEM_NEW_SEC = 45

export interface ItemMemory {
	/**
	 * `${player}|${itemId}` -> the game-clock second we FIRST saw it, or `-Infinity` for items
	 * that were already there the first time we looked at that player.
	 */
	firstSeen: Map<string, number>
	/** Players whose inventory has been read at least once. */
	seen: Set<string>
}

export const newItemMemory = (): ItemMemory => ({ firstSeen: new Map(), seen: new Set() })

export const resetItemMemory = (mem: ItemMemory) => {
	mem.firstSeen.clear()
	mem.seen.clear()
}

/** The shape we need out of `LivePlayer.items`, kept structural so `analysis/` owns no schema. */
export interface RawItem {
	id?: number
	name?: string
	slot?: number
	count?: number
}

/**
 * The player's inventory, in slot order, with anything bought since the last look marked.
 *
 * Three deliberate refusals:
 *
 *   - **An item with no name from the client is dropped, never rendered as an id.** A number in
 *     an item list is an invitation to translate it, and a model translating item ids from memory
 *     is a fabricated item with a real number attached to it.
 *   - **Nothing is NEW on the first look at a player.** The coach can connect at 14:00 — every
 *     item in the game is "new" to it then, and "you just finished Liandry's" about an item
 *     bought nine minutes ago is exactly the confident-wrong call this app spends its whole
 *     design budget avoiding.
 *   - **No claim about what an item builds into, or costs.** The client says what is owned. It
 *     does not say what it is worth or what it is halfway to.
 *
 * Known limitation, stated rather than hidden: duplicates of one id (two Long Swords) collapse to
 * one entry with a count, and a second copy bought later is not marked NEW. Completed items are
 * never duplicated, so the case this exists for is unaffected.
 */
export const inventoryOf = (
	player: string,
	items: RawItem[],
	nowSec: number,
	mem: ItemMemory
): VisionStateItem[] => {
	const first = !mem.seen.has(player)
	mem.seen.add(player)

	const out: VisionStateItem[] = []
	const byId = new Map<number, VisionStateItem>()
	for (const raw of [...items].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))) {
		const name = (raw.name ?? "").trim()
		if (name === "") continue
		const id = raw.id ?? -1
		const key = `${player}|${id}`
		if (!mem.firstSeen.has(key)) mem.firstSeen.set(key, first ? -Infinity : nowSec)
		const existing = id >= 0 ? byId.get(id) : undefined
		if (existing) {
			existing.count = (existing.count ?? 1) + (raw.count ?? 1)
			continue
		}
		const entry: VisionStateItem = { name }
		const count = raw.count ?? 1
		if (count > 1) entry.count = count
		if (mem.firstSeen.get(key)! >= nowSec - ITEM_NEW_SEC) entry.isNew = true
		if (id >= 0) byId.set(id, entry)
		out.push(entry)
	}
	return out
}
