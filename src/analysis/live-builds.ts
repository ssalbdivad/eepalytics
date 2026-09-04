/**
 * Who the enemy jungler is, and what anybody is holding — read off the live client, never guessed.
 *
 * ## Why this exists
 *
 * The ground-truth block was built from the roster, the scoreline and the clock, and it threw the
 * rest of `allgamedata` away. That is most of what a live coach is for: with no items and no
 * positions the coach cannot say one word about a build or a matchup, so given ten champion names
 * and nothing else it produced the SHAPE of coaching with nothing in it — *"Viego is your jungle
 * counterpart so watch for his ganks"*, a sentence that is true in every game he has ever played.
 * A gap does not make a model quiet, it makes it generic.
 *
 * ## The fence still holds
 *
 * Nothing here derives an item, a tier, a cost or a timing. It copies `displayName` as the client
 * wrote it, and where the client gives no name it prints the raw id rather than a guess. The model
 * may REASON from a build ("he has no magic resist yet") and may never claim a possession the
 * client did not report.
 *
 * Pure: state in, state out. The daemon owns the one mutable `BuildMemory`.
 */

import type { LivePlayer } from "../shared/schema/live.ts"
import type { VisionStateItem, VisionStateRole } from "../shared/live-state.ts"

/** The client puts the trinket in slot 6. We are told, so we never infer it from the name. */
const TRINKET_SLOT = 6

/**
 * What each player was holding last time we looked, keyed by riot id.
 *
 * Explicit rather than module-level for the same reason `FactMemory` is: the "just bought" flag is
 * only meaningful against a previous observation, and a rule about a previous observation that
 * lives in module scope cannot be asserted in a test.
 */
export interface BuildMemory {
	seen: Map<string, Set<number>>
}

export const newBuildMemory = (): BuildMemory => ({ seen: new Map() })

const keyOf = (p: LivePlayer): string =>
	p.riotId ?? p.summonerName ?? p.championName ?? ""

/**
 * A player's inventory, in the client's own slot order, with anything new since the last read
 * marked.
 *
 * **Consumables are dropped.** Potions and biscuits churn every clear, they are on his own HUD,
 * and for anyone else they change no decision — three lines of noise in a block whose whole
 * problem is that a model skims a long one. The trinket survives the filter (the client reports it
 * as non-consumable), and it is worth its four words: a Sweeper in the jungler's hands is an
 * objective-setup fact.
 *
 * **The first sight of a player marks nothing.** Otherwise a daemon restarted at minute 20 would
 * announce a full inventory as five simultaneous purchases, which is the failure mode this whole
 * app is built to avoid: a fabrication that is indistinguishable from a read.
 */
export const inventoryOf = (p: LivePlayer, mem: BuildMemory): VisionStateItem[] => {
	const key = keyOf(p)
	const before = mem.seen.get(key)
	const now = new Set<number>()
	const out: VisionStateItem[] = []
	for (const it of p.items ?? []) {
		if (it.itemID !== undefined) now.add(it.itemID)
		if (it.consumable === true) continue
		/*
		 * `displayName` is what the shop calls it. When the client sends an item with no name at
		 * all, the id is printed as an id — an unnamed item is still information ("he has six
		 * things"), and a name we invented for it would be a fabricated possession.
		 */
		const name =
			it.displayName ?? it.rawDisplayName ?? (it.itemID !== undefined ? `item ${it.itemID}` : "")
		if (name === "") continue
		out.push({
			name,
			...(it.slot === TRINKET_SLOT ? { trinket: true } : {}),
			...(before !== undefined && it.itemID !== undefined && !before.has(it.itemID) ?
				{ justBought: true }
			:	{})
		})
	}
	if (key !== "") mem.seen.set(key, now)
	return out
}

/** `TOP|JUNGLE|MIDDLE|BOTTOM|UTILITY` as a word a coach would actually say. */
export const roleWord = (position: string | undefined): VisionStateRole | undefined =>
	position === "TOP" ? "top"
	: position === "JUNGLE" ? "jungle"
	: position === "MIDDLE" ? "mid"
	: position === "BOTTOM" ? "bot"
	: position === "UTILITY" ? "support"
	: undefined

const hasSmite = (p: LivePlayer): boolean => {
	const spells = p.summonerSpells
	const names = [
		spells?.summonerSpellOne?.displayName ?? spells?.summonerSpellOne?.rawDisplayName ?? "",
		spells?.summonerSpellTwo?.displayName ?? spells?.summonerSpellTwo?.rawDisplayName ?? ""
	]
	return names.some(n => /smite/i.test(n))
}

/**
 * The one enemy whose game is a mirror of his — identified, or not at all.
 *
 * `position` from the live client is the reliable one (`shared/schema/live.ts`), unlike the
 * match-history `timeline.lane` that labels 4 of 10 players JUNGLE. But it comes from the lobby's
 * role assignment and is an empty string in queues that do not assign one, so Smite is the
 * fallback — the same inference AGENTS.md prescribes for post-game roles.
 *
 * Both paths demand EXACTLY ONE candidate. Two smites on one team happens (a support taking it
 * for a cheese), and picking the first of two would produce a confident line about the wrong
 * player's build, which is worse than having no line at all.
 */
export const junglerOf = (players: LivePlayer[]): LivePlayer | null => {
	const byPosition = players.filter(p => p.position === "JUNGLE")
	if (byPosition.length === 1) return byPosition[0]!
	const bySmite = players.filter(hasSmite)
	return bySmite.length === 1 ? bySmite[0]! : null
}
