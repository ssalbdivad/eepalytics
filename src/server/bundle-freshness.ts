/**
 * IS THE PAGE HE IS LOOKING AT BUILT FROM THE CODE THAT IS IN THE TREE?
 *
 * ## The failure this exists for, measured rather than imagined
 *
 * On 2026-09-20 he asked for the app so he could run it on the game he was already in. The daemon
 * was up, `/api/live/phase` said `ChampSelect`, every API answered, and `dist/assets/index-*.js`
 * was dated **09-18 20:14** — four days and three commits old. The schedule the live coach runs on
 * (`observeTick`, reached from `src/web/lib/geminiLive.ts`) lives IN THAT BUNDLE, so the two asks
 * added on the 19th — the 10:00-15:00 floor and the capped standing-objective question — could not
 * have fired for him, and nothing on the machine said so. Every diagnostic was green because every
 * diagnostic was about the SERVER.
 *
 * That is the shape this repo keeps finding and keeps having to fix: a path that fails while
 * everything built to watch it reports success. The journal session stayed open for eight days the
 * same way; the coach recorded nothing for eight days the same way.
 *
 * ## What counts as a source of the bundle
 *
 * Vite's root is `src/web`, and the bundle inlines whatever that imports out of the browser-safe
 * directories — `src/shared` (the schemas, the brief, the speech chunker) and `src/analysis` (the
 * schedule, the ranker, reachability). A change in any of them ships only after a build. Config
 * counts too: `vite.config.ts` and `package.json` decide what the build IS.
 *
 * `*.test.ts` is excluded because no test reaches a bundle, and `src/daemon`, `src/db`, `src/lcu`,
 * `src/review` and `src/server` are excluded because they are NODE ONLY and run in the process
 * doing the asking — they are current by definition.
 *
 * ## It answers a state, never an error
 *
 * Four verdicts and every one of them is a normal thing to be: `fresh`, `stale`, `unbuilt` (no
 * `dist/index.html` — the daemon usually starts before the first build, and `pnpm dev` serves from
 * Vite on another port and never wants a `dist` at all), and `unknown` (the source tree is not
 * beside this process, which is what a packaged install looks like). It never throws: a stat that
 * fails is a file that does not count.
 *
 * NODE ONLY (reads the filesystem).
 */

import { readdirSync, statSync } from "node:fs"
import type { Dirent } from "node:fs"
import { join, resolve } from "node:path"

/** What the bundle is built FROM, relative to the repo root. Ordered for a stable scan. */
const SOURCE_DIRS = ["src/web", "src/shared", "src/analysis"] as const

/** Single files that decide what the build is. */
const SOURCE_FILES = ["vite.config.ts", "package.json"] as const

/** Nothing in here reaches a bundle. */
const isBundled = (name: string): boolean => !name.endsWith(".test.ts") && !name.endsWith(".test.tsx")

export interface NewerSource {
	/** Repo-relative, so the line in the log is the line you would `git diff`. */
	path: string
	atMs: number
}

export interface BundleFreshness {
	verdict: "fresh" | "stale" | "unbuilt" | "unknown"
	builtAtMs: number | null
	newestSourceMs: number | null
	/**
	 * The source files NEWER than the build, newest first, capped. This is the diagnosis rather
	 * than a hint: "your page predates `live-events.ts`" is actionable where "stale" is not.
	 */
	newerThanBuild: NewerSource[]
	/** How many files were considered, so a scan that found nothing can be told from one that ran. */
	scanned: number
	/** The exact command that fixes it, so the answer travels with the complaint. */
	fix: string
}

const MAX_NAMED = 5

/**
 * Walk one directory, newest-first bookkeeping only — no sorting of the whole tree.
 *
 * Depth is unbounded on purpose; these three directories are a few hundred files and the walk is
 * behind a TTL cache. A symlink loop would be a problem and there are none in this repo, so the
 * simple version is the honest one until that stops being true.
 */
const walk = (dir: string, out: NewerSource[], root: string): number => {
	let scanned = 0
	let entries: Dirent[]
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return 0
	}
	for (const entry of entries) {
		const abs = join(dir, entry.name)
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue
			scanned += walk(abs, out, root)
			continue
		}
		if (!entry.isFile() || !isBundled(entry.name)) continue
		scanned++
		try {
			out.push({ path: abs.startsWith(root) ? abs.slice(root.length + 1) : abs, atMs: statSync(abs).mtimeMs })
		} catch {
			/* a file that vanished between readdir and stat does not count */
		}
	}
	return scanned
}

/**
 * Compare the built shell against everything it was built from.
 *
 * `root` is the repo root; `distDir` is what the server is actually serving, which is a parameter
 * rather than a constant because the tests serve a temp directory and because `deps.distDir`
 * already exists for exactly that reason.
 */
export const bundleFreshness = (root: string, distDir: string): BundleFreshness => {
	const fix = "pnpm build"
	let builtAtMs: number | null = null
	try {
		builtAtMs = statSync(resolve(distDir, "index.html")).mtimeMs
	} catch {
		builtAtMs = null
	}

	const all: NewerSource[] = []
	let scanned = 0
	for (const dir of SOURCE_DIRS) scanned += walk(resolve(root, dir), all, resolve(root))
	for (const file of SOURCE_FILES) {
		try {
			const abs = resolve(root, file)
			all.push({ path: file, atMs: statSync(abs).mtimeMs })
			scanned++
		} catch {
			/* a repo without a vite config is not this repo; say nothing */
		}
	}

	if (scanned === 0)
		return { verdict: "unknown", builtAtMs, newestSourceMs: null, newerThanBuild: [], scanned, fix }
	if (builtAtMs === null)
		return {
			verdict: "unbuilt",
			builtAtMs: null,
			newestSourceMs: Math.max(...all.map(s => s.atMs)),
			newerThanBuild: [],
			scanned,
			fix
		}

	const newestSourceMs = Math.max(...all.map(s => s.atMs))
	const newer = all
		.filter(s => s.atMs > builtAtMs!)
		.sort((a, b) => b.atMs - a.atMs)
		.slice(0, MAX_NAMED)

	return {
		verdict: newer.length > 0 ? "stale" : "fresh",
		builtAtMs,
		newestSourceMs,
		newerThanBuild: newer,
		scanned,
		fix
	}
}

/**
 * The same answer, at most once every `ttlMs`.
 *
 * `/api/health` is polled every few seconds by the status banner and the shell is re-read on every
 * client-side navigation, so the uncached walk would run hundreds of times a minute for an answer
 * that changes when someone runs a build. Fifteen seconds is the same TTL the Vanguard probe uses,
 * for the same reason.
 */
const TTL_MS = 15_000
let cache: { atMs: number; key: string; value: BundleFreshness } | null = null

export const bundleFreshnessCached = (
	root: string,
	distDir: string,
	nowMs: number = Date.now()
): BundleFreshness => {
	const key = `${root}\u0000${distDir}`
	if (cache && cache.key === key && nowMs - cache.atMs < TTL_MS) return cache.value
	const value = bundleFreshness(root, distDir)
	cache = { atMs: nowMs, key, value }
	return value
}

/** Test seam: the cache is module state and a test that measures staleness must not inherit one. */
export const resetBundleFreshnessCache = (): void => {
	cache = null
}

/**
 * One line, for the journal and for the banner.
 *
 * It names a FILE, because "stale" is a verdict and "your page predates live-events.ts" is a
 * diagnosis, and the person reading it is the person who changed that file.
 */
export const describeFreshness = (f: BundleFreshness): string => {
	if (f.verdict === "fresh") return "the built page is newer than every file it is built from"
	if (f.verdict === "unbuilt") return `no dist/index.html — run \`${f.fix}\``
	if (f.verdict === "unknown") return "no source tree beside this process; freshness unknown"
	const lead = f.newerThanBuild[0]
	const others = f.newerThanBuild.length - 1
	const ageMin = f.builtAtMs === null ? 0 : Math.round((f.newestSourceMs! - f.builtAtMs) / 60_000)
	return (
		`the built page is ${ageMin} minute(s) older than the code it is built from — ` +
		`${lead ? lead.path : "a source file"}${others > 0 ? ` and ${others} other file(s)` : ""} ` +
		`changed since the last build. Run \`${f.fix}\`.`
	)
}
