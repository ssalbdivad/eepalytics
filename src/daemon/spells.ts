/**
 * summonerSpellId -> name, cached for the process. The sibling of `champions.ts`.
 *
 * `GET /lol-game-data/assets/v1/summoner-spells.json`, served locally by the client with the
 * same auth as everything else. It is small, it changes about once a season, and without it the
 * matchup brief has to say "spell 11" — or, worse, guess.
 *
 * **It is deliberately NOT a hardcoded table.** Everyone knows Flash is 4 and Smite is 11, and
 * that is exactly the kind of confidence this app does not spend: a table typed from memory is
 * a fabrication that happens to be usually right. `championName()` degrades to `""` rather than
 * to a plausible name, and so does this. In practice the degrade is nearly unreachable — the
 * only caller is the pre-game brief, which by definition runs while the client is open.
 *
 * NODE ONLY.
 */

import { kvGet, kvSet } from "../db/queries.ts"
import { fetchSummonerSpells } from "./lcu.ts"
import { makeLogger } from "./log.ts"

const log = makeLogger("spells")

const KV_KEY = "summonerSpellNames"

let names: Record<string, string> | null = null
let lastFetchMs = 0
/** Re-fetch at most once an hour; only a patch changes this. */
const TTL_MS = 60 * 60 * 1000

const loadFromDb = (): Record<string, string> => {
	if (names) return names
	names = kvGet<Record<string, string>>(KV_KEY, {})
	return names
}

/**
 * Refresh from the client if possible. Returns how many entries we now hold; 0 means the client
 * was closed and we are working from whatever the DB had cached.
 */
export const refreshSummonerSpellNames = async (force = false): Promise<number> => {
	const cached = loadFromDb()
	if (!force && Date.now() - lastFetchMs < TTL_MS && Object.keys(cached).length > 0)
		return Object.keys(cached).length

	const summary = await fetchSummonerSpells()
	lastFetchMs = Date.now()
	if (!summary) {
		log.debug("summoner spell summary unavailable (client closed?)")
		return Object.keys(cached).length
	}

	const next: Record<string, string> = {}
	for (const entry of summary) {
		// id -1 is the "None" placeholder the client ships in these files.
		if (entry.id < 0) continue
		if (entry.name) next[String(entry.id)] = entry.name
	}
	names = next
	kvSet(KV_KEY, next)
	log.info("summoner spell names cached", { count: Object.keys(next).length })
	return Object.keys(next).length
}

/** `""` when unknown — never a fabricated or guessed name. */
export const summonerSpellName = (spellId: number): string =>
	loadFromDb()[String(spellId)] ?? ""

/** Test seam. */
export const setSummonerSpellNames = (map: Record<string, string>): void => {
	names = map
}
