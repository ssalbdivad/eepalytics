/**
 * coachskaffur daemon — the entry point.
 *
 * One process. It owns SQLite, the job queue, the League-client connection and the HTTP+SSE
 * server, because the daemon has to run whether or not a browser tab is open and a Hono app is
 * just a function you mount. Notifying the UI is therefore an in-process EventEmitter, with no
 * IPC, no second SQLite writer and no port coordination.
 *
 * IT MUST BOOT WITH THE LEAGUE CLIENT CLOSED. That is the normal case, not an error path:
 * `/api/health` answers `lcu: "disconnected"`, every stored game is still browsable, and the
 * supervisor picks the client up the moment the lockfile appears.
 *
 * Run: node --experimental-strip-types --no-warnings=ExperimentalWarning src/daemon/main.ts
 *
 * NODE ONLY.
 */

import {
	DB_PATH,
	REPLAY_DIR_WSL,
	SERVER_HOST,
	SERVER_PORT
} from "../shared/constants.ts"
import { closeDb, ensureDataDirs, getDb } from "../db/index.ts"
import { getSettings, kvGet, kvSet } from "../db/queries.ts"
import { startServer } from "../server/app.ts"
import type { DaemonStatus, ServerDeps, SyncResult } from "../server/deps.ts"
import { bus, publish } from "./bus.ts"
import { refreshChampionNames } from "./champions.ts"
import { ensureBoundToCurrentClient, fetchLcuAsset } from "./lcu.ts"
import runRetentionPrune from "./jobs/retention-prune.ts"
import { log, setLogLevel } from "./log.ts"
import { adoptOrphanedLeases, sweep } from "./queue.ts"
import * as queue from "./queue.ts"
import { reconcile, reconcileFinishedGame } from "./reconcile.ts"
import { startSupervisor } from "./supervisor.ts"
import type { Supervisor } from "./supervisor.ts"
import { startWorkers } from "./workers.ts"
import type { WorkerPool } from "./workers.ts"
import { existsSync, readFileSync } from "node:fs"

export const DAEMON_VERSION = "0.1.0"

/** How often to sweep expired leases and overdue deadlines. */
const SWEEP_MS = 15_000
/** Full reconciliation cadence. The WebSocket/poll is a latency optimisation on top of this. */
const RECONCILE_MS = 5 * 60_000
const RETENTION_MS = 6 * 60 * 60_000
const KV_LAST_SYNC = "lastSyncMs"

/**
 * Which address to listen on.
 *
 * VERIFIED on this machine: a server bound to WSL's 127.0.0.1 is NOT reachable from Windows —
 * `curl.exe http://127.0.0.1:7700/api/health` returns 000. Bound to 0.0.0.0, the same request
 * returns 200, because WSL2 forwards the host's localhost into the VM. League, and therefore
 * the browser the user alt-tabs to while playing, live on Windows. A loopback-only default
 * would mean the app simply does not open on the machine it is for.
 *
 * WSL2's virtual adapter is host-only NAT, so 0.0.0.0 here means "this Windows box", not the
 * LAN. `CSK_HOST` still overrides, and off WSL the default stays loopback.
 *
 * `WSL_DISTRO_NAME` is NOT set under `systemd --user`, which is exactly how this daemon is
 * meant to run, so the kernel release string is the detection that actually works there.
 */
const serverHost = (): string => {
	if (process.env.CSK_HOST) return process.env.CSK_HOST
	let osRelease = ""
	try {
		osRelease = readFileSync("/proc/sys/kernel/osrelease", "utf8")
	} catch {
		/* not Linux, or /proc unavailable — fall through to loopback */
	}
	return /microsoft|wsl/i.test(osRelease) ? "0.0.0.0" : SERVER_HOST
}

/**
 * What the HTTP layer is handed. `src/server/app.ts` receives this from `createApp(ctx)`, so
 * routes never reach into daemon internals — and the daemon still serves a useful
 * `/api/health` when that unit has not landed.
 */
export interface DaemonContext {
	version: string
	startedMs: number
	supervisor: Supervisor
	workers: WorkerPool
	queue: typeof queue
	bus: typeof bus
	reconcile: () => Promise<SyncResult>
	status: () => DaemonStatus
	shutdown: () => Promise<void>
}

const warnings = (): string[] => {
	const out: string[] = []
	if (!existsSync(REPLAY_DIR_WSL))
		out.push(`replay directory not found at ${REPLAY_DIR_WSL}`)
	return out
}

export const startDaemon = async (): Promise<DaemonContext> => {
	const startedMs = Date.now()
	setLogLevel((process.env.CSK_LOG_LEVEL as "info") ?? "info")
	log.info("coachskaffur daemon starting", {
		version: DAEMON_VERSION,
		node: process.version,
		db: DB_PATH
	})

	ensureDataDirs()
	getDb() // opens + migrates; throws loudly if the schema is from a newer build
	// A `leased` row at boot is residue from a process that died — this daemon holds nothing
	// yet. Reclaim it now rather than letting it sit out the rest of its 10-minute lease while
	// the Queue screen claims it is running. Skipped when another daemon is alive on this DB.
	adoptOrphanedLeases()
	sweep()

	let ready = false

	const runReconcile = async (why: string): Promise<SyncResult> => {
		try {
			const report = await reconcile()
			// Only a sweep that actually reached the client counts as a sync — otherwise the
			// banner would claim it was up to date while the client was closed.
			if (report.lcuReachable) kvSet(KV_LAST_SYNC, Date.now())
			const queued =
				report.newGames.length +
				report.reIngest.length +
				report.analysis.length +
				report.reviews.length +
				report.media.length +
				report.downloads.length
			publish("daemon", { reconciled: true, why, queued })
			return { ok: true, queued, ...(report.note ? { note: report.note } : {}) }
		} catch (err) {
			log.error("reconcile failed", { why, err: String(err) })
			return { ok: false, queued: 0, note: String(err) }
		}
	}

	const supervisor = startSupervisor({
		onConnected: () => {
			void (async () => {
				await ensureBoundToCurrentClient()
				await refreshChampionNames()
				// Every reconnect reconciles — that is what makes a missed game impossible.
				await runReconcile("client connected")
			})()
		},
		onGameEnded: gameId => {
			// The 30-minute replay clock just started. Do not wait for the next sweep.
			void (async () => {
				const report = await reconcileFinishedGame(gameId)
				log.info("post-game reconcile", {
					gameId,
					queued: report.newGames.length + report.downloads.length
				})
			})()
		}
	})

	const workers = startWorkers({ normal: 2 })

	/**
	 * What the status banner renders. Everything degrades: the client may be closed, the
	 * bridge may have failed over to curl, a capture may be blocked. Each field has a defined
	 * "unavailable" value rather than going missing.
	 */
	const status = (): DaemonStatus => {
		const s = supervisor.status()
		const gateReason = workers.status().lastGateReason
		return {
			daemon:
				!ready ? "starting"
				: s.state === "CONNECTED" ? "ok"
				: "degraded",
			lcu: s.state === "CONNECTED" ? "connected" : "disconnected",
			bridge: s.transport === "none" ? "none" : s.transport,
			gameflowPhase: s.phase,
			startedMs,
			lastSyncMs: kvGet<number | null>(KV_LAST_SYNC, null),
			warnings: [
				...warnings(),
				...(s.staleLockfile ? ["lockfile names a process that is not running"] : []),
				...(s.lastErrorText ? [s.lastErrorText] : [])
			],
			captureGate: {
				// The gate is only evaluated while a capture is actually pending, so "no reason
				// recorded" means "nothing is waiting", not "it would be allowed".
				allowed: gateReason === null && getSettings().captureEnabled,
				reason:
					gateReason ??
					(getSettings().captureEnabled ?
						"nothing waiting to capture"
					:	"replay capture is switched off in Settings")
			}
		}
	}

	/* -------------------------------------------------------------- timers */

	const timers: NodeJS.Timeout[] = []
	const every = (ms: number, fn: () => void): void => {
		const t = setInterval(fn, ms)
		t.unref?.()
		timers.push(t)
	}

	every(SWEEP_MS, () => sweep())
	every(RECONCILE_MS, () => void runReconcile("timer"))
	// Not a queued job: `JobKind` has no `retention-prune` member, and a plain timer is the
	// honest way to say "this is housekeeping, not user-visible work".
	every(RETENTION_MS, () => runRetentionPrune())

	/* ---------------------------------------------------------------- http */

	let shuttingDown = false
	const ctx: DaemonContext = {
		version: DAEMON_VERSION,
		startedMs,
		supervisor,
		workers,
		queue,
		bus,
		reconcile: () => runReconcile("api"),
		status,
		shutdown: async () => {
			if (shuttingDown) return
			shuttingDown = true
			log.info("shutting down")
			for (const t of timers) clearInterval(t)
			await workers.stop(5_000)
			await supervisor.stop()
			publish("daemon", { lcu: "disconnected", state: "stopped" })
			closeDb()
		}
	}

	/**
	 * The HTTP layer is mounted, not spawned. `src/server/` never opens its own database or
	 * transport: it receives one already-open connection (so the daemon and the API do not
	 * race two writers over the same file) plus the few live facts it cannot compute from
	 * SQLite alone.
	 */
	const deps: ServerDeps = {
		db: getDb(),
		version: DAEMON_VERSION,
		status,
		// Already deduplicated by a partial unique index, so double-clicking "review this
		// game" in the UI cannot spawn two Claude runs.
		enqueue: req => {
			const id = queue.enqueueJob(req)
			return id
		},
		sync: () => runReconcile("api"),
		onSettingsChange: next => {
			// Poll intervals and the capture switch apply without a restart.
			log.info("settings changed", {
				model: next.model,
				captureEnabled: next.captureEnabled,
				transport: next.transport
			})
			publish("daemon", { settingsChanged: true })
		},
		fetchLcuAsset
	}

	const started = startServer(deps, SERVER_PORT, serverHost())
	log.info(`listening on http://127.0.0.1:${started.port} (bound ${started.host})`)
	if (started.host === "0.0.0.0")
		log.info(
			`open it from Windows at http://127.0.0.1:${started.port} — a WSL loopback bind is not reachable from the host, which is where League and your browser are`
		)

	const originalShutdown = ctx.shutdown
	ctx.shutdown = async () => {
		await started.close().catch(() => {})
		await originalShutdown()
	}

	ready = true
	publish("daemon", { state: "started", version: DAEMON_VERSION })

	// The first reconcile runs BEHIND the listener so the UI is reachable immediately, even
	// when the client is closed and the LCU calls are going to time out.
	void (async () => {
		runRetentionPrune()
		await refreshChampionNames()
		await runReconcile("boot")
	})()

	return ctx
}

/* ================================================================= main */

const isMain = (): boolean => {
	const entry = process.argv[1] ?? ""
	return entry.endsWith("main.ts") || entry.endsWith("main.js")
}

if (isMain()) {
	const ctx = await startDaemon()

	let stopping = false
	const bye = (signal: string) => {
		if (stopping) {
			log.warn(`${signal} again — exiting immediately`)
			process.exit(1)
		}
		stopping = true
		log.info(`${signal} received`)
		void ctx.shutdown().then(
			() => process.exit(0),
			err => {
				log.error("shutdown failed", { err: String(err) })
				process.exit(1)
			}
		)
		// Never hang forever on a stuck handler.
		setTimeout(() => process.exit(1), 15_000).unref?.()
	}

	process.on("SIGINT", () => bye("SIGINT"))
	process.on("SIGTERM", () => bye("SIGTERM"))
	process.on("unhandledRejection", err =>
		log.error("unhandled rejection", { err: String(err) })
	)
	process.on("uncaughtException", err => {
		log.error("uncaught exception", { err: String(err) })
		// systemd restarts us; SQLite has everything, so a crash costs at most one attempt.
		void ctx.shutdown().finally(() => process.exit(1))
	})
}
