/**
 * championId -> name, cached for the process.
 *
 * The LCU serves this locally and needs the same auth as everything else:
 * `GET /lol-game-data/assets/v1/champion-summary.json`. It is small, it never changes inside
 * a patch, and without it every scoreboard row reads "champion 876".
 *
 * INTERIM: this really belongs to the static-data unit, which should also cache the icons and
 * override `queueName()` from `/lol-game-data/assets/v1/queues.json`. When that lands, this
 * module should become a thin re-export. It lives here so ingest is not blocked on it — and
 * it degrades to `""` (never to a made-up name) when the client is closed.
 *
 * NODE ONLY.
 */

import { kvGet, kvSet } from "../db/queries.ts"
import { fetchChampionSummary } from "./lcu.ts"
import { makeLogger } from "./log.ts"

const log = makeLogger("champions")

const KV_KEY = "championNames"

let names: Record<string, string> | null = null
let lastFetchMs = 0
/** Re-fetch at most once an hour; a patch is the only thing that changes this. */
const TTL_MS = 60 * 60 * 1000

const loadFromDb = (): Record<string, string> => {
	if (names) return names
	names = kvGet<Record<string, string>>(KV_KEY, {})
	return names
}

/**
 * Refresh from the client if possible. Returns how many entries we now hold; 0 means the
 * client was closed and we are working from whatever was cached in the DB.
 */
export const refreshChampionNames = async (force = false): Promise<number> => {
	const cached = loadFromDb()
	if (!force && Date.now() - lastFetchMs < TTL_MS && Object.keys(cached).length > 0)
		return Object.keys(cached).length

	const summary = await fetchChampionSummary()
	lastFetchMs = Date.now()
	if (!summary) {
		log.debug("champion summary unavailable (client closed?)")
		return Object.keys(cached).length
	}

	const next: Record<string, string> = {}
	for (const entry of summary) {
		// id -1 is the "None" placeholder the client ships in this file.
		if (entry.id < 0) continue
		const label = entry.name ?? entry.alias
		if (label) next[String(entry.id)] = label
	}
	names = next
	kvSet(KV_KEY, next)
	log.info("champion names cached", { count: Object.keys(next).length })
	return Object.keys(next).length
}

/** `""` when unknown — never a fabricated or guessed name. */
export const championName = (championId: number): string =>
	loadFromDb()[String(championId)] ?? ""

/** Test seam. */
export const setChampionNames = (map: Record<string, string>): void => {
	names = map
}
