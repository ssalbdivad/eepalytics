/**
 * check-patch — is the FETCHED champion table stale against the live patch?
 *
 * Riot's Data Dragon publishes the live version list at a stable, unauthenticated URL. That is
 * the only patch signal worth trusting: it is official, it needs no key, and it does not depend
 * on scraping a site that can restyle itself. `16.17.1` there is the `16.17` the client reports
 * and the app stores on every game.
 *
 * ## What it compares, and what changed on 2026-09-18
 *
 * It used to walk `knowledge/champions/*.md` and read each file's `patch:` header. Those files are
 * deleted — model-authored, 8.0% [5.1, 12.3] of their checkable mechanical claims wrong — and
 * champion facts are fetched now, all of them pinned to ONE patch by `pnpm fetch:champions`. So
 * there is one comparison to make rather than twenty-four, and a stale answer has one remedy:
 * re-run the fetch.
 *
 * The `durable` escape hatch went with the prose. It existed because a hand-written note about
 * "clear shape and power spikes" survives tuning, and nothing in the generated table is that kind
 * of sentence: a cooldown array either describes this patch or it does not.
 *
 * Used two ways:
 *   - by a human:  node --experimental-strip-types scripts/check-patch.ts
 *   - by CI:       ... --json     (the workflow reads `stale` to decide whether to do anything)
 *
 * Exits 0 whether or not anything is stale — staleness is a fact to report, not a failure. It
 * exits non-zero only if the version feed could not be read, because then the answer is unknown
 * and a caller must not treat that as "all fresh".
 */

import { CHAMPION_ROWS, CHAMPION_TABLE_PATCH, CHAMPION_TABLE_SOURCES } from "../src/knowledge/champion-table.ts"
import { contextManifest } from "../src/knowledge/champion-context.ts"

const VERSIONS_URL = "https://ddragon.leagueoflegends.com/api/versions.json"

/** `16.17.1` -> `16.17`. The build number moves for hotfixes that change no balance. */
export const minorOf = (version: string): string => version.split(".").slice(0, 2).join(".")

export const livePatch = async (signal?: AbortSignal): Promise<string> => {
	const res = await fetch(VERSIONS_URL, { signal })
	if (!res.ok) throw new Error(`Data Dragon returned HTTP ${res.status}`)
	const versions = (await res.json()) as unknown
	if (!Array.isArray(versions) || typeof versions[0] !== "string")
		throw new Error("Data Dragon returned an unexpected shape")
	return minorOf(versions[0])
}

export interface TableStatus {
	/** The patch `pnpm fetch:champions` pinned the table to. */
	patch: string
	live: string
	champions: number
	/** When each source was last read, for a reader deciding whether to believe a line by age. */
	fetchedAt: Record<string, string>
	stale: boolean
}

export const auditTable = (live: string): TableStatus => ({
	patch: CHAMPION_TABLE_PATCH,
	live,
	champions: CHAMPION_ROWS.length,
	fetchedAt: Object.fromEntries(
		Object.entries(CHAMPION_TABLE_SOURCES).map(([id, src]) => [
			id,
			typeof src === "object" && src !== null && "fetchedAt" in src ? String(src.fetchedAt) : "unknown"
		])
	),
	// `16.18.1` and `16.18` are the same patch; the build number moves for hotfixes that change
	// no balance, and the client reports the two-part form.
	stale: CHAMPION_TABLE_PATCH.split(".").slice(0, 2).join(".") !== live
})

const main = async (): Promise<void> => {
	const json = process.argv.includes("--json")
	let live: string
	try {
		live = await livePatch(AbortSignal.timeout(20_000))
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		if (json) console.log(JSON.stringify({ ok: false, error: message }))
		else console.error(`could not read the live patch: ${message}`)
		process.exit(2)
	}

	const status = auditTable(live)

	if (json) {
		console.log(JSON.stringify({ ok: true, live, stale: status.stale, table: status }, null, 2))
		return
	}

	console.log(`live patch:            ${live}`)
	console.log(`champion table patch:  ${status.patch}  (${status.champions} champions)`)
	/*
	 * The table is not what the app reads — `knowledge/context/` is. A fresh table behind a stale
	 * tree is the one failure this split introduced, and it is silent unless something says it out
	 * loud: the coach would go on quoting last patch's numbers while `check-patch` reported Fresh.
	 */
	const tree = contextManifest()
	console.log(
		tree === null ?
			`context tree:          MISSING — run \`pnpm generate:context\``
		: tree.patch === status.patch ?
			`context tree:          ${tree.patch}  (${tree.files} files, ${(tree.bytes / 1024 / 1024).toFixed(2)} MB)`
		:	`context tree:          ${tree.patch}  — BEHIND THE TABLE. Run \`pnpm generate:context\`; the app reads the tree, not the table.`
	)
	for (const [id, at] of Object.entries(status.fetchedAt)) console.log(`  ${id.padEnd(16)} fetched ${at}`)
	console.log(
		status.stale ?
			`\nSTALE. Re-run \`pnpm fetch:champions\` — every number in the coach's champion block is the ` +
				`${status.patch} number, and the block says so to the model rather than pretending otherwise.`
		:	`\nFresh.`
	)
}

if (import.meta.filename === process.argv[1]) await main()
