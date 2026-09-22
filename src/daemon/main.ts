/**
 * eepalytics daemon — the entry point.
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

import { pruneSamples } from "./live-sampler.ts"
import {
	DB_PATH,
	REPLAY_DIR_WSL,
	SERVER_HOST,
	SERVER_PORT
} from "../shared/constants.ts"
import { backupDatabase, describeBackup } from "../db/backup.ts"
import { closeDb, ensureDataDirs, getDb } from "../db/index.ts"
import { getSettings, kvGet, kvSet } from "../db/queries.ts"
import { startServer } from "../server/app.ts"
import type { DaemonStatus, ServerDeps, SyncResult } from "../server/deps.ts"
import { bus, publish } from "./bus.ts"
import { refreshChampionNames } from "./champions.ts"
import { ensureBoundToCurrentClient, fetchLcuAsset } from "./lcu.ts"
import runRetentionPrune from "./jobs/retention-prune.ts"
import { log, setLogLevel } from "./log.ts"
import { noteGameEnded } from "./postgame.ts"
import {
	appendCoverage,
	describeCoverage,
	measureCoverage,
	readCoverage,
	recoverGameStartMs
} from "./coach-coverage.ts"
import { endOpenSession } from "./journal.ts"
import { adoptOrphanedLeases, sweep } from "./queue.ts"
import * as queue from "./queue.ts"
import { reconcile, reconcileFinishedGame } from "./reconcile.ts"
import { startSupervisor } from "./supervisor.ts"
import type { Supervisor } from "./supervisor.ts"
import { describeSettingsOverrides } from "../shared/schema/settings.ts"
import { startWorkers } from "./workers.ts"
import type { WorkerPool } from "./workers.ts"
import { existsSync, readFileSync } from "node:fs"

export const DAEMON_VERSION = "0.1.0"

/** How often to sweep expired leases and overdue deadlines. */
const SWEEP_MS = 15_000
/** Full reconciliation cadence. The WebSocket/poll is a latency optimisation on top of this. */
const RECONCILE_MS = 5 * 60_000
const RETENTION_MS = 6 * 60 * 60_000

/**
 * How often to CONSIDER a database snapshot. The snapshot itself decides whether to take one:
 * `backupDatabase` skips when nothing has been written since the last copy, so this is the rate at
 * which the question is asked rather than the rate at which 25 MB is written. Six hours matches the
 * retention sweep, which is the other piece of housekeeping on this clock.
 */
const BACKUP_MS = 6 * 60 * 60_000
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
	const configured = process.env.EEPALYTICS_HOST ?? process.env.CSK_HOST
	if (configured) return configured
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
	setLogLevel(((process.env.EEPALYTICS_LOG_LEVEL ?? process.env.CSK_LOG_LEVEL) as "info") ?? "info")
	pruneSamples()
	log.info("eepalytics daemon starting", {
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

	/*
	 * Anything the previous process left open is closed here, before a frame can join it.
	 *
	 * `journal.ts`'s `anchor` is module state, so after a restart `sessionFor` cannot see that the
	 * game clock has run backwards and has no reason to roll — and the champion is the same one he
	 * always plays, so the identity check does not fire either. The first frames of a brand new
	 * game therefore joined the last session this daemon ever wrote to and inherited ITS gameId.
	 * A process boundary is the one moment we know for certain that nothing is mid-stream.
	 */
	{
		const stale = endOpenSession("daemon restarted")
		if (stale) log.info("closed a journal session left open by a previous process", { stale })
	}

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

	/**
	 * When the current game started, in wall clock — the window `measureCoverage` searches.
	 *
	 * The supervisor already owns the gameId and the phase; it does not own a start time, and a
	 * game that produced NOTHING has no other timestamp anywhere on the machine to look it up by.
	 *
	 * ## IT IS SET ONLY WHEN WE WATCHED THE GAME BEGIN, and that condition is the fix
	 *
	 * This used to be `if (next === "InProgress") gameStartedMs = Date.now()`, and the comment
	 * above it claimed a daemon that started mid-game would leave it null. It does not.
	 * `setPhase` in `supervisor.ts` fires `onPhase` on EVERY change including the first read, so a
	 * daemon restarted at minute 25 of a game sees `null -> InProgress` and stamps the RESTART as
	 * the game's start. The coverage record was then written over a window that began minutes after
	 * the frames and lines it is counting, so a `coached` game could be filed as `absent` — the
	 * silent lie this whole module exists to prevent, inside the module itself. Verified by reading
	 * `setPhase`; there is no instance of it in the last 14 days of this machine's phase log (every
	 * entry into `InProgress` reads `from=ChampSelect`), which is why nobody had seen it.
	 *
	 * `previous === null` is exactly "we did not watch this game begin": it is the daemon's first
	 * phase read, or the client restarted and `onLockfileChanged` pushed the phase to null. Both
	 * mean the start time is not ours to state, so it stays null and the record is rebuilt at the
	 * end of the game from the live sampler's own filenames, which outlive the process and are
	 * written whether or not a browser tab exists. See `recoverGameStartMs`.
	 */
	let gameStartedMs: number | null = null

	const supervisor = startSupervisor({
		onPhase: (next, previous) => {
			if (next === "InProgress") gameStartedMs = previous === null ? null : Date.now()
		},
		onConnected: () => {
			void (async () => {
				await ensureBoundToCurrentClient()
				await refreshChampionNames()
				// Every reconnect reconciles — that is what makes a missed game impossible.
				await runReconcile("client connected")
			})()
		},
		onGameEnded: gameId => {
			/*
			 * Two things happen here, and they are independent on purpose.
			 *
			 * The marker is written FIRST and synchronously: it is one row, it cannot fail the
			 * way an LCU round trip can, and it is what the coach window reads on its next poll
			 * to stop saying "not in a game" the second a game finishes. The ingest that fills
			 * the debrief in follows behind it.
			 */
			noteGameEnded(gameId)
			/*
			 * THE SESSION ENDS WITH THE GAME, and this is the only place that was ever true.
			 *
			 * `journal.ts` used to close a session only when the NEXT frame arrived with a clock
			 * that had run backwards, so a session that simply stopped receiving frames stayed open
			 * forever — measured on this machine, one had been open for eight days and five games,
			 * and every live sample in that time was keyed on it. See `endOpenSession`.
			 */
			endOpenSession("game ended")
			/*
			 * AND THEN SAY WHETHER THE COACH WAS THERE AT ALL.
			 *
			 * One line per game, so "three games today and not one transcript line" is something
			 * the machine notices rather than something he has to report. It is a measurement of
			 * our plumbing and touches nothing the coach does. See `coach-coverage.ts` for the four
			 * verdicts and why the middle one is the one worth chasing.
			 *
			 * It is now also WRITTEN TO A FILE. For a week it was logged and published and never
			 * stored, so `data/logs/coach-coverage.jsonl` did not exist and forty-four games of
			 * this evidence lived only in journald. `appendCoverage` never throws and reports
			 * whether the row landed, because a coverage record must not be able to take the
			 * replay download — which has thirty minutes to live — down with it.
			 */
			const endedMs = Date.now()
			/*
			 * A start we watched beats one we reconstructed; a reconstructed one beats none.
			 * Nothing is invented: when neither exists there is no record and the log says which
			 * game had none and why, because a game with no record must not be able to read as a
			 * game the coach skipped.
			 */
			const startedMs = gameStartedMs ?? recoverGameStartMs(endedMs)
			if (startedMs !== null) {
				const coverage = measureCoverage({
					gameId,
					startedMs,
					endedMs,
					startSource: gameStartedMs !== null ? "phase" : "samples"
				})
				const from = coverage.startSource === "phase" ? "" : " [start recovered from samples]"
				const line = `live coach ${coverage.verdict}: ${coverage.note}${from}`
				if (coverage.verdict === "coached") log.info(line, { gameId })
				else log.warn(line, { gameId })
				if (!appendCoverage(coverage)) log.warn("coverage record not stored", { gameId })
				/*
				 * The RUN of games goes out beside the one game, because the run is the thing worth
				 * saying. Five of his six most recent games are `absent` and today that fact exists
				 * only as a WARN in a journal he never reads. `describeCoverage` is a pure function
				 * over the stored history and returns one plain sentence; the daemon publishes it
				 * and never acts on it. Nothing here may pop a window, steal focus or fire while he
				 * is playing — see the capture post-mortem in AGENTS.md, where "wait until the user
				 * is idle" resolved to "fire the moment he sits down to play".
				 *
				 * INCOMPLETE ON PURPOSE, and the missing half is a route. An SSE event only reaches
				 * a page that is already open at the moment a game ends, and the whole population
				 * this is about is games he played with no page open. A `GET` that answers
				 * `readCoverage` + `describeCoverage` is what would put it in front of him, and it
				 * belongs in `src/server/routes/`.
				 */
				const history = describeCoverage(readCoverage())
				if (history.quietStreak > 0 && history.sentence) log.warn(history.sentence)
				publish("daemon", { coachCoverage: coverage, coachHistory: history })
			} else
				log.warn(
					"live coach coverage skipped: joined this game already in progress and no live sample file marks its start",
					{ gameId }
				)
			gameStartedMs = null
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
	 * bridge may have failed over to curl. Each field has a defined "unavailable" value rather
	 * than going missing.
	 */
	const status = (): DaemonStatus => {
		const s = supervisor.status()
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
			]
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
	/*
	 * THE LIBRARY, COPIED. `csk.db` is the one file here that cannot be rebuilt — Riot's match
	 * history answers with a server-chosen window of about twenty games, so most of the 223 in it
	 * no longer exist upstream. See `db/backup.ts` for why it is VACUUM INTO rather than a file
	 * copy, and why the copy is opened and read back before it counts as one.
	 *
	 * Once at startup as well as on the clock, because a restart is the moment a machine is most
	 * likely to have just done something frightening, and because a laptop that is only ever up for
	 * four hours at a time would otherwise never reach the six-hour mark.
	 */
	const snapshot = (): void => {
		const report = backupDatabase()
		if (!report.ok) log.warn(describeBackup(report))
		else if (report.outcome === "written") log.info(describeBackup(report))
	}
	snapshot()
	every(BACKUP_MS, snapshot)

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
			// Poll intervals apply without a restart.
			//
			// The overrides go in the SAME line, so a save that switches the review path off is
			// in the log beside the games it stops reviewing rather than only discoverable by
			// reading the settings table eight days later.
			log.info("settings changed", {
				model: next.model,
				transport: next.transport,
				autoReviewNewGames: next.autoReviewNewGames,
				overrides: describeSettingsOverrides(next) || "none"
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

	/*
	 * SAY WHAT THIS INSTALL IS NOT RUNNING ON DEFAULTS.
	 *
	 * A settings row outranks the code default forever, and nothing used to announce that. One
	 * stored `autoReviewNewGames: false` switched the post-game review path off on 2026-09-04;
	 * the code default, the schema and the README all still read `true`, so every place a person
	 * would look agreed with itself and disagreed with the running app. Thirty games later
	 * nobody had noticed. The disagreement is legitimate — he is allowed to turn things off —
	 * but it now has to be visible, here and on the Settings screen.
	 */
	const overrides = describeSettingsOverrides(getSettings())
	if (overrides === "") log.info("settings: every field is on its code default")
	else log.info(`settings overridden: ${overrides}`)

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
