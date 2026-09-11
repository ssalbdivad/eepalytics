/**
 * summonerSpellId -> name, cached for the process. The sibling of `champions.ts`, and the
 * same machinery: see `lcu-name-cache.ts`.
 *
 * `GET /lol-game-data/assets/v1/summoner-spells.json`. It is small, it changes about once a
 * season, and without it the matchup brief has to say "spell 11" — or, worse, guess.
 *
 * In practice the degrade to `""` is nearly unreachable here: the only caller is the pre-game
 * brief, which by definition runs while the client is open.
 *
 * NODE ONLY.
 */

import { fetchSummonerSpells } from "./lcu.ts"
import { nameCache } from "./lcu-name-cache.ts"

const cache = nameCache({
	label: "spells",
	kvKey: "summonerSpellNames",
	fetch: fetchSummonerSpells
})

export const refreshSummonerSpellNames = cache.refresh

/** `""` when unknown — never a fabricated or guessed name. */
export const summonerSpellName = cache.name
