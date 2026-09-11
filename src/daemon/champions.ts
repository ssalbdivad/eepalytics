/**
 * championId -> name, cached for the process.
 *
 * `GET /lol-game-data/assets/v1/champion-summary.json`, served locally by the client under
 * the same auth as everything else. Without it every scoreboard row reads "champion 876".
 *
 * The mechanism — the one-hour TTL, the DB fallback, and the refusal to invent a name for an
 * unknown id — is `lcu-name-cache.ts`, shared with `spells.ts`. The only thing particular to
 * champions is the `alias` fallback: a handful of entries ship an alias and no name.
 *
 * NODE ONLY.
 */

import { fetchChampionSummary } from "./lcu.ts"
import { nameCache } from "./lcu-name-cache.ts"

const cache = nameCache({
	label: "champions",
	kvKey: "championNames",
	fetch: fetchChampionSummary,
	allowAlias: true
})

export const refreshChampionNames = cache.refresh

/** `""` when unknown — never a fabricated or guessed name. */
export const championName = cache.name
