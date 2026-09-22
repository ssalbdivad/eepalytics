/**
 * `GET /api/health` — the status banner's entire data source.
 *
 * Everything here degrades. The League client may be closed, the bridge may have failed over
 * to curl, the daemon may be mid-restart, the database may be empty because this is a fresh
 * install. Each of those is a *state*, not an error: this route answers 200 with a truthful
 * shape in all of them and never 500s.
 *
 * Three fields go beyond the declared `HealthResponse` contract (ArkType passes undeclared
 * keys through, so this is additive and safe for older clients): `uptimeMs`, `pid` and
 * `sseClients`. There was a fourth, `capture`, carrying the intrusive gate's reason; the
 * gate guarded exactly one job kind, that job is gone, and a verdict about nothing is worse
 * than no verdict at all.
 */

import { Hono } from "hono"
import { resolve } from "node:path"
import { countGames, kvGet, queueDepth } from "../../db/queries.ts"
import { dbExists } from "../../db/index.ts"
import {
	ANALYSIS_VERSION,
	DB_PATH,
	REVIEW_VERSION
} from "../../shared/constants.ts"
import { HealthResponse } from "../../shared/schema/api.ts"
import type { VanguardReport } from "../../shared/schema/api.ts"
import { probeVanguard } from "../../lcu/vanguard.ts"
import { APP_VERSION, OFFLINE_STATUS } from "../deps.ts"
import type { DaemonStatus, ServerDeps } from "../deps.ts"
import { subscriberCount } from "../events.ts"
import { bundleFreshnessCached, describeFreshness } from "../bundle-freshness.ts"
import { describeCoverage, readCoverage } from "../../daemon/coach-coverage.ts"
import { faultCounts, recentFaults } from "../../daemon/log.ts"
import type { CoverageSummary } from "../../daemon/coach-coverage.ts"
import type { BundleFreshness } from "../bundle-freshness.ts"
import { send } from "../respond.ts"

/**
 * Vanguard state, cached briefly.
 *
 * The status banner polls health every few seconds, and each probe is two `sc.exe` round trips
 * across WSL interop. Service state does not change second to second, and a stale-by-15s answer
 * is indistinguishable from a fresh one to the person reading it.
 */
const VANGUARD_TTL_MS = 15_000
let vanguardCache: { atMs: number; report: VanguardReport } | null = null

const vanguardReport = async (): Promise<VanguardReport> => {
	const now = Date.now()
	if (vanguardCache && now - vanguardCache.atMs < VANGUARD_TTL_MS) return vanguardCache.report
	const report = await probeVanguard()
	vanguardCache = { atMs: now, report }
	return report
}

/** The extra, undeclared half of the health payload. Declared here so it stays typed. */
interface HealthExtras {
	uptimeMs: number | null
	pid: number
	sseClients: number
	bundle: BundleFreshness
	coachCoverage: CoverageSummary | null
	faults: { windowMs: number; warn: number; error: number; latest: { atMs: number; level: string; scope: string; msg: string }[] }
}

/**
 * How far back the fault counter looks. An hour is long enough to catch the burst that a
 * crash-loop or a schema surprise produces and short enough that yesterday's fixed problem is not
 * still being reported as news.
 */
const FAULT_WINDOW_MS = 60 * 60 * 1000

/**
 * The coverage sentence, at most once a minute.
 *
 * The banner polls health every few seconds and the record only changes when a game ends, so the
 * file read is cached on the same argument the Vanguard probe and the bundle walk are cached on.
 * A failure returns null and the health payload simply does not carry the field: this route
 * answers 200 with a truthful shape in every state and never 500s, and a missing record is a
 * state — it is what a fresh install looks like.
 */
const COVERAGE_TTL_MS = 60_000
let coverageCache: { atMs: number; value: CoverageSummary | null } | null = null

const coverageSummary = (): CoverageSummary | null => {
	const now = Date.now()
	if (coverageCache && now - coverageCache.atMs < COVERAGE_TTL_MS) return coverageCache.value
	let value: CoverageSummary | null = null
	try {
		value = describeCoverage(readCoverage(20))
	} catch {
		value = null
	}
	coverageCache = { atMs: now, value }
	return value
}

/**
 * WHERE THE REPO IS, from where this file is.
 *
 * `src/server/routes/health.ts` -> two levels to `src/`, three to the root. Resolved once because
 * it cannot change while the process runs, and it is only ever used to ask about mtimes.
 */
const REPO_ROOT = resolve(import.meta.dirname, "../../..")
const DIST_DIR = resolve(REPO_ROOT, "dist")

const readStatus = async (deps: ServerDeps): Promise<DaemonStatus> => {
	if (!deps.status) return OFFLINE_STATUS
	try {
		return await deps.status()
	} catch (err) {
		return {
			...OFFLINE_STATUS,
			daemon: "degraded",
			warnings: [`daemon status probe failed: ${(err as Error).message}`]
		}
	}
}

export const createHealthRoute = (deps: ServerDeps): Hono => {
	const app = new Hono()

	app.get("/health", async c => {
		const status = await readStatus(deps)
		const warnings = [...(status.warnings ?? [])]

		let depth = 0
		let games = 0
		let dbReachable = true
		try {
			depth = queueDepth()
			games = countGames()
		} catch (err) {
			dbReachable = false
			warnings.push(`database unavailable: ${(err as Error).message}`)
		}
		if (dbReachable && !dbExists()) warnings.push("database file has not been created yet")

		/*
		 * IS THE PAGE ASKING THIS QUESTION BUILT FROM THE CODE IN THE TREE?
		 *
		 * It rides in `warnings` rather than only in its own field on purpose: the status banner
		 * has rendered `warnings` for as long as there has been a status banner, so this reaches a
		 * client built BEFORE this line existed — which is exactly the client it is about. A new
		 * field would only be read by a bundle new enough not to need it. See `bundle-freshness.ts`
		 * for the September 20th case that produced it.
		 */
		const bundle = bundleFreshnessCached(deps.repoRoot ?? REPO_ROOT, deps.distDir ?? DIST_DIR)
		if (bundle.verdict === "stale") warnings.push(describeFreshness(bundle))

		/*
		 * DID THE COACH RUN IN THE GAMES HE ACTUALLY PLAYED?
		 *
		 * 43 of his last 44 were `absent` — no frames, no lines, the page closed — and the machine
		 * has never been able to say so anywhere he looks. It rides in `warnings` for the same
		 * reason the staleness sentence does: that field is rendered by every version of the
		 * status banner, including one built before this line existed.
		 *
		 * TWO GAMES, not one. A single quiet game is him closing the tab, and a warning about it
		 * would be noise on the first poll after any ordinary evening. A streak is a habit or a
		 * fault, and both are worth a sentence.
		 */
		const coachCoverage = coverageSummary()
		if (coachCoverage?.sentence && coachCoverage.quietStreak >= 2) warnings.push(coachCoverage.sentence)

		/*
		 * WHAT THE DAEMON HAS BEEN SAYING TO ITSELF.
		 *
		 * Every defect found on 2026-09-22 was a line the daemon had already written and nobody had
		 * read: 363 discarded polls, a corpus eviction, a crash on shutdown. The counts come from
		 * an in-memory ring in `daemon/log.ts` — journald is still the log, and this is only enough
		 * for a page to say that something is wrong.
		 *
		 * ONLY ERRORS ARE PROMOTED TO A WARNING, and the reason is the same 363 polls: warnings are
		 * routinely dozens deep on a machine talking to a game client that comes and goes, so a
		 * banner driven by them would be permanently lit and therefore ignored. The warn count is
		 * still in the payload for anything that wants to show it.
		 */
		const faults = { windowMs: FAULT_WINDOW_MS, ...faultCounts(Date.now() - FAULT_WINDOW_MS), latest: recentFaults(5) }
		if (faults.error > 0)
			warnings.push(
				`the daemon logged ${faults.error} error${faults.error === 1 ? "" : "s"} in the last hour ` +
					`(latest: ${faults.latest.find(f => f.level === "error")?.msg ?? "see journalctl --user -u eepalytics"})`
			)

		// The daemon records this after each reconcile; falling back to kv means a standalone
		// server still reports the real last sync instead of null.
		let lastSyncMs: number | null = status.lastSyncMs ?? null
		if (lastSyncMs === null && dbReachable) {
			try {
				lastSyncMs = kvGet<number | null>("lastSyncMs", null)
			} catch {
				/* leave null */
			}
		}

		const body = {
			daemon: status.daemon,
			lcu: status.lcu,
			bridge: status.bridge,
			gameflowPhase: status.gameflowPhase,
			queueDepth: depth,
			version: deps.version ?? APP_VERSION,
			analysisVersion: ANALYSIS_VERSION,
			reviewVersion: REVIEW_VERSION,
			dbPath: DB_PATH,
			gameCount: games,
			lastSyncMs,
			warnings,
			uptimeMs: status.startedMs === undefined ? null : Date.now() - status.startedMs,
			bundle,
			coachCoverage,
			faults,
			pid: process.pid,
			sseClients: subscriberCount(),
			// Only when the client is unreachable. "The League client is not running" is true
			// and useless; on Windows the usual cause is Vanguard, and asking Windows is cheap
			// exactly when it matters. Probing on every healthy poll would be a Windows round
			// trip several times a minute for nothing.
			...(status.lcu === "connected" ? {} : { vanguard: await vanguardReport() })
		} satisfies HealthResponse & HealthExtras

		return send(c, HealthResponse, body, "GET /api/health")
	})

	return app
}
