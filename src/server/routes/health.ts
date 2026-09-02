/**
 * `GET /api/health` — the status banner's entire data source.
 *
 * Everything here degrades. The League client may be closed, the bridge may have failed over
 * to curl, the daemon may be mid-restart, the database may be empty because this is a fresh
 * install. Each of those is a *state*, not an error: this route answers 200 with a truthful
 * shape in all of them and never 500s.
 *
 * Three fields go beyond the declared `HealthResponse` contract (ArkType passes undeclared
 * keys through, so this is additive and safe for older clients): `uptimeMs`, `pid`, and
 * `capture`, which carries the human-readable gate reason from `daemon/gate.ts`. The queue
 * screen renders that verbatim so "why is nothing happening" never needs a log dive.
 */

import { Hono } from "hono"
import { countGames, kvGet, queueDepth } from "../../db/queries.ts"
import { dbExists } from "../../db/index.ts"
import {
	ANALYSIS_VERSION,
	DB_PATH,
	REVIEW_VERSION
} from "../../shared/constants.ts"
import { HealthResponse } from "../../shared/schema/api.ts"
import { APP_VERSION, OFFLINE_STATUS } from "../deps.ts"
import type { CaptureGate, DaemonStatus, ServerDeps } from "../deps.ts"
import { subscriberCount } from "../events.ts"
import { send } from "../respond.ts"

/** The extra, undeclared half of the health payload. Declared here so it stays typed. */
interface HealthExtras {
	uptimeMs: number | null
	pid: number
	capture: CaptureGate
	sseClients: number
}

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

		const capture: CaptureGate = status.captureGate ?? {
			allowed: false,
			reason:
				deps.status ?
					"capture gate not reported by the daemon"
				:	"daemon not running — capture is unavailable"
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
			pid: process.pid,
			capture,
			sseClients: subscriberCount()
		} satisfies HealthResponse & HealthExtras

		return send(c, HealthResponse, body, "GET /api/health")
	})

	return app
}
