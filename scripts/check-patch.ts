/**
 * check-patch — is the champion knowledge stale against the live patch?
 *
 * Riot's Data Dragon publishes the live version list at a stable, unauthenticated URL. That is
 * the only patch signal worth trusting: it is official, it needs no key, and it does not depend
 * on scraping a site that can restyle itself. `16.17.1` there is the `16.17` the client reports
 * and the app stores on every game.
 *
 * Notes marked `patch: durable` are never stale. That is the point of the marker — champion
 * identity (clear shape, ability roles, power spikes) survives tuning, and only material that
 * could actually be balanced away needs re-checking.
 *
 * Used two ways:
 *   - by a human:  node --experimental-strip-types scripts/check-patch.ts
 *   - by CI:       ... --json     (the workflow reads `stale` to decide whether to do anything)
 *
 * Exits 0 whether or not anything is stale — staleness is a fact to report, not a failure. It
 * exits non-zero only if the version feed could not be read, because then the answer is unknown
 * and a caller must not treat that as "all fresh".
 */

import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const CHAMPIONS_DIR = resolve(HERE, "../knowledge/champions")
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

export interface NoteStatus {
	champion: string
	file: string
	patch: string
	sourcedAt: string
	stale: boolean
}

const headerValue = (raw: string, key: string): string => {
	const head = raw.split("\n---")[0] ?? ""
	for (const line of head.split("\n")) {
		const m = new RegExp(`^${key}:\\s*(.*)$`).exec(line.trim())
		if (m) return m[1]!.trim()
	}
	return ""
}

export const auditNotes = (live: string, dir = CHAMPIONS_DIR): NoteStatus[] => {
	let files: string[]
	try {
		files = readdirSync(dir).filter(f => f.endsWith(".md"))
	} catch {
		return []
	}
	return files
		.map(file => {
			const raw = readFileSync(join(dir, file), "utf8")
			const patch = headerValue(raw, "patch") || "durable"
			return {
				champion: file.replace(/\.md$/, ""),
				file: `knowledge/champions/${file}`,
				patch,
				sourcedAt: headerValue(raw, "sourcedAt") || "unknown",
				// `durable` is identity, not tuning: it does not go stale when a patch lands.
				stale: patch !== "durable" && patch !== "" && patch !== live
			}
		})
		.sort((a, b) => a.champion.localeCompare(b.champion))
}

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

	const notes = auditNotes(live)
	const stale = notes.filter(n => n.stale)

	if (json) {
		console.log(JSON.stringify({ ok: true, live, stale: stale.length > 0, notes }, null, 2))
		return
	}

	console.log(`live patch: ${live}\n`)
	for (const n of notes)
		console.log(
			`  ${n.stale ? "STALE" : " ok  "}  ${n.champion.padEnd(12)} patch ${n.patch.padEnd(9)} sourced ${n.sourcedAt}`
		)
	console.log(
		stale.length === 0 ?
			`\nNothing to refresh.`
		:	`\n${stale.length} note(s) written for an older patch: ${stale.map(n => n.champion).join(", ")}`
	)
}

if (import.meta.filename === process.argv[1]) await main()
