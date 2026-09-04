/**
 * Dependency injection for the HTTP layer.
 *
 * `createApp(deps)` is mounted BY the daemon, so the server must never open its own database,
 * spawn its own LCU transport, or start its own poll loop. Everything it cannot compute from
 * `src/db/queries.ts` alone arrives through this interface, and every field is optional:
 * booted standalone with `createApp({})` the API still answers on an empty database with the
 * League client closed, which is exactly the "unavailable" state the UI has to render anyway.
 *
 * NODE-ONLY. Never import this from `src/web`.
 */

import type { DatabaseSync } from "node:sqlite"
import type { JobRequest } from "../shared/schema/domain.ts"
import type { Settings } from "../shared/schema/settings.ts"

/** Shown in `GET /api/health`. Bumped by hand; there is no `version` in package.json. */
export const APP_VERSION = "0.1.0"

/** The live daemon state the status banner needs. Sampled fresh on every `/api/health`. */
export interface DaemonStatus {
	daemon: "ok" | "starting" | "degraded" | "stopped"
	lcu: "connected" | "disconnected"
	/** Which transport actually carried the last LCU request. `none` = neither works. */
	bridge: "bridge" | "curl" | "none"
	gameflowPhase: string | null
	/** Epoch ms the daemon process came up, for the uptime readout. */
	startedMs?: number
	/** Non-fatal problems worth surfacing: "replay dir not found", a stale lockfile. */
	warnings?: string[]
	/** Epoch ms of the last successful match-history reconcile. */
	lastSyncMs?: number | null
}

/** Result of a manual `POST /api/sync`. */
export interface SyncResult {
	ok: boolean
	/** How many jobs the reconcile enqueued. */
	queued?: number
	note?: string
}

/** Raw bytes for one static asset (champion icon, item icon, ...) plus its content type. */
export interface AssetBytes {
	body: Uint8Array
	contentType: string
}

export interface ServerDeps {
	/**
	 * An already-open database. When given, `createApp` points the process-wide singleton at
	 * it via `useDb`, so the daemon and the HTTP layer share one connection rather than
	 * racing two.
	 */
	db?: DatabaseSync

	/** Live daemon status. Absent => the API reports `daemon: "stopped"`, `lcu: "disconnected"`. */
	status?: () => DaemonStatus | Promise<DaemonStatus>

	/**
	 * Enqueue a job. Defaults to `queries.enqueue`, which is already deduplicated by a partial
	 * unique index — double-clicking "review this game" cannot spawn two Claude runs.
	 */
	enqueue?: (req: JobRequest) => number

	/** Run a match-history reconcile now. Absent => `POST /api/sync` answers 503, not a lie. */
	sync?: () => SyncResult | Promise<SyncResult>

	/** Told after every accepted `PUT /api/settings`, so poll intervals apply without a restart. */
	onSettingsChange?: (next: Settings) => void

	/**
	 * Fetch one asset through the authenticated LCU transport. `assetPath` is rooted
	 * (`/lol-game-data/assets/v1/champion-icons/876.png`). Absent, or returning null, falls
	 * back to CommunityDragon, which serves byte-identical payloads (verified: 54 117 B for
	 * champion-summary.json from both).
	 */
	fetchLcuAsset?: (assetPath: string) => Promise<AssetBytes | null>

	/** Serve the built SPA from `distDir`. Defaults to on whenever `dist/index.html` exists. */
	serveSpa?: boolean
	distDir?: string

	version?: string
}

/** Everything unavailable — what the API reports when the daemon injected no status hook. */
export const OFFLINE_STATUS: DaemonStatus = {
	daemon: "stopped",
	lcu: "disconnected",
	bridge: "none",
	gameflowPhase: null,
	warnings: ["daemon status unavailable — the HTTP layer is running without a supervisor"]
}
