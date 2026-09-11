/**
 * id -> name, read from the client and cached for the process.
 *
 * Two tables need exactly this: champion names and summoner-spell names. They were two files
 * of 71 lines that differed in four words — the KV key, the fetcher, the logger's name, and
 * whether a missing `name` may fall back to `alias`. Everything else, including the one-hour
 * TTL and the degrade rule, was written out twice and tested neither time.
 *
 * **The degrade rule is why this is not a hardcoded table.** Everyone knows Flash is 4 and
 * Smite is 11 and Lillia is 876, and that is exactly the kind of confidence this app does not
 * spend: a table typed from memory is a fabrication that happens to be usually right. So an
 * unknown id resolves to `""` — never to a plausible name — and a closed client means working
 * from whatever the DB last cached rather than from a guess.
 *
 * The LCU serves both tables locally under the usual auth. They are small and they change only
 * on a patch, which is what the TTL is sized for.
 *
 * NODE ONLY.
 */

import { kvGet, kvSet } from "../db/queries.ts"
import { makeLogger } from "./log.ts"

/** Re-fetch at most once an hour; a patch is the only thing that changes these. */
const TTL_MS = 60 * 60 * 1000

/**
 * As much of an entry as naming needs. Both LCU tables are wider than this and both are
 * assignable to it; everything is optional because a patch that renames a field must not be
 * able to break the read.
 */
export interface LcuNameEntry {
	id: number
	name?: string
	alias?: string
}

export interface NameCache {
	/**
	 * Refresh from the client if possible. Returns how many entries we now hold, so 0 means
	 * the client was closed AND nothing had ever been cached.
	 */
	refresh: (force?: boolean) => Promise<number>
	/** `""` when unknown — never a fabricated or guessed name. */
	name: (id: number) => string
}

export const nameCache = (spec: {
	/** Logger channel, e.g. "champions" — it prefixes every line this cache writes. */
	label: string
	/** The `kv` row the table is cached in. */
	kvKey: string
	/** `null` when the client is closed; the caller then keeps whatever the DB had. */
	fetch: () => Promise<LcuNameEntry[] | null>
	/** Champions may ship an alias and no name. Spells never do. */
	allowAlias?: boolean
}): NameCache => {
	const log = makeLogger(spec.label)
	let names: Record<string, string> | null = null
	let lastFetchMs = 0

	const loadFromDb = (): Record<string, string> => {
		if (names) return names
		names = kvGet<Record<string, string>>(spec.kvKey, {})
		return names
	}

	return {
		refresh: async (force = false): Promise<number> => {
			const cached = loadFromDb()
			if (!force && Date.now() - lastFetchMs < TTL_MS && Object.keys(cached).length > 0)
				return Object.keys(cached).length

			const summary = await spec.fetch()
			lastFetchMs = Date.now()
			if (!summary) {
				log.debug("summary unavailable (client closed?)")
				return Object.keys(cached).length
			}

			const next: Record<string, string> = {}
			for (const entry of summary) {
				// id -1 is the "None" placeholder the client ships in both of these files.
				if (entry.id < 0) continue
				const label = entry.name ?? (spec.allowAlias ? entry.alias : undefined)
				if (label) next[String(entry.id)] = label
			}
			names = next
			kvSet(spec.kvKey, next)
			log.info("names cached", { count: Object.keys(next).length })
			return Object.keys(next).length
		},
		name: (id: number): string => loadFromDb()[String(id)] ?? ""
	}
}
