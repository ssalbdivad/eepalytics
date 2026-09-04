/**
 * Getting a daemon running, from inside the Electron app.
 *
 * This file exists because the app has to be able to BE the product on a machine that has never
 * heard of this repo — no checkout, no pnpm, no systemd, no Node on PATH — while the WSL
 * development loop it grew up in keeps working exactly as it did.
 *
 * ## Three ways it can go, chosen on what can be observed
 *
 *   1. **adopt** — something already answers on the port. A daemon under `systemd --user`, or
 *      the one `pnpm dev` started. Racing it for the port and the SQLite write lock is strictly
 *      worse than using it, and this check is what makes `pnpm app` safe to run at any time.
 *   2. **utility** — fork the daemon into an Electron `utilityProcess`. This is what ships.
 *   3. **spawn** — the historical path: a plain child process running `src/daemon/main.ts`,
 *      byte for byte what `pnpm daemon` runs.
 *
 * Only the first is a live probe; the other two are decided from `app.isPackaged` and the kernel
 * string, both facts about the machine rather than a flag someone has to remember to set.
 * `EEPALYTICS_DAEMON_MODE` overrides, for when you want to reproduce the shipped path in a
 * checkout (or the reverse) without editing code.
 *
 * ## Why a utilityProcess and not Electron's own main process
 *
 * Electron 44.1.1 bundles Node 24.19.0, which has `node:sqlite` and strips TypeScript types with
 * no flag and no build step (both measured on this machine), so the daemon COULD simply be
 * imported into the main process. It must not be. `node:sqlite` is synchronous by design, and
 * the daemon's real work — migrations, digest building, ROFL decode, corpus queries — is
 * synchronous CPU work on top of it. Every millisecond of that inside the main process is a
 * millisecond the window does not paint, and the main process is also the one answering the
 * screen-capture request handler for the live coach *while a game is running*. A background job
 * that stutters the coach is a worse bug than any it could fix.
 *
 * A `utilityProcess` gets its own event loop and its own Node, forked from Electron's own binary,
 * so nothing has to be installed on the target machine. Electron owns its lifetime: it cannot
 * outlive a crashed app and sit on the database, which a `spawn`ed child can and has.
 *
 * ## Why the spawn path stays, and stays the default in a WSL checkout
 *
 * Under WSL the daemon is a plain Node process in every other context it runs in — `pnpm daemon`,
 * `pnpm dev:daemon --watch`, the systemd unit. Keeping the app's copy identical means a bug seen
 * in the window reproduces in the terminal, and it keeps `ELECTRON_RUN_AS_NODE` out of the
 * shipped path, where it would be inherited by every Windows-interop child the daemon spawns.
 * There is no evidence either way about the utilityProcess under WSLg beyond "it forks and it
 * talks", so the well-worn path keeps the environment it is worn into.
 */

import { app, dialog, utilityProcess } from "electron"
import { spawn } from "node:child_process"
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/** How long a graceful stop may take before the process is killed outright. */
const STOP_TIMEOUT_MS = 4_000

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Is something already answering on the port?
 *
 * The one probe the adopt decision rests on, and the building block of `waitForDaemon`. Exported
 * so a one-shot check does not have to go through the polling loop.
 */
export const daemonAlive = async url => {
	try {
		const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2_000) })
		return res.ok
	} catch {
		return false
	}
}

/** Poll health until the daemon answers, so the window never opens onto a connection error. */
export const waitForDaemon = async (url, timeoutMs) => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await daemonAlive(url)) return true
		await sleep(400)
	}
	return false
}

/**
 * Is this Linux kernel a WSL one?
 *
 * The same test `src/daemon/main.ts` uses to choose its bind address, and for the same reason:
 * `WSL_DISTRO_NAME` is not set under `systemd --user`, so the environment cannot be trusted to
 * say. Reading a 30-byte file once at startup is not worth caching.
 */
const isWsl = () => {
	try {
		return /microsoft|wsl/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8"))
	} catch {
		return false
	}
}

/**
 * Which of the two self-hosted modes to use. See the header for why each is where it is.
 *
 * `adopt` is not chosen here — it is decided by the live probe in `startDaemonHost`, because
 * "somebody else is already running one" outranks any preference this could express.
 */
const chooseMode = packaged => {
	const forced = process.env.EEPALYTICS_DAEMON_MODE ?? process.env.CSK_DAEMON_MODE
	if (forced === "utility" || forced === "spawn" || forced === "adopt") return forced
	// A packaged app has no terminal to fall back to and no service manager to clean up after
	// it, so it takes the mode Electron can supervise.
	if (packaged) return "utility"
	return isWsl() ? "spawn" : "utility"
}

/**
 * Where the daemon writes.
 *
 * `DATA_DIR` defaults to `<cwd>/data`, which is right for a checkout and wrong for an installed
 * app: the working directory of a process launched from a Start-menu shortcut is not somewhere
 * anyone wants a database, and on a per-machine install it is not even writable. Electron's
 * `userData` is the platform's own answer to that question, it survives an upgrade, and it is
 * where an uninstaller knows to leave things alone.
 */
const dataDirFor = packaged => (packaged ? join(app.getPath("userData"), "data") : null)

const childEnv = (packaged, isDev) => {
	const dataDir = dataDirFor(packaged)
	return {
		...process.env,
		NODE_ENV: isDev ? "development" : "production",
		...(dataDir ? { EEPALYTICS_DATA_DIR: dataDir } : {})
	}
}

/**
 * A file for the daemon's output, in a packaged app only.
 *
 * The daemon logs to stdout, because under `systemd --user` stdout IS the log and `journalctl`
 * reads it. An installed Windows app has neither: the pipe below goes to a process with no
 * console attached, so every line the daemon writes about why it will not start would go
 * nowhere, and the only symptom would be a dialog saying nothing answered. One file in
 * `userData` is the difference between a bug that can be reported and one that cannot.
 *
 * Truncated rather than rotated once it passes the cap. This is a diagnostic for the run you are
 * in, not an archive — everything that matters is in SQLite.
 */
const LOG_CAP_BYTES = 5 * 1024 * 1024

const openLog = packaged => {
	if (!packaged) return null
	try {
		const dir = join(app.getPath("userData"), "logs")
		mkdirSync(dir, { recursive: true })
		const path = join(dir, "daemon.log")
		const size = existsSync(path) ? statSync(path).size : 0
		const stream = createWriteStream(path, { flags: size > LOG_CAP_BYTES ? "w" : "a" })
		stream.write(`\n=== ${new Date().toISOString()} — app started ===\n`)
		return { path, stream }
	} catch (err) {
		// A log we cannot open is not a reason to refuse to run.
		console.warn("[electron] could not open the daemon log:", String(err))
		return null
	}
}

/** Pipe a child's output through this process's, tagged, exactly as the spawn path always has. */
const pipeOutput = (child, log) => {
	const forward = (chunk, to) => {
		to.write(`[daemon] ${chunk}`)
		log?.stream.write(chunk)
	}
	child.stdout?.on("data", d => forward(d, process.stdout))
	child.stderr?.on("data", d => forward(d, process.stderr))
}

/**
 * Start a daemon, or adopt one.
 *
 * `onCrash(how, logPath)` is called only for an exit we did not ask for — the caller decides how
 * loudly to say so, and gets the log path because in a packaged app that is the only place the
 * reason exists. Returns `{ mode, stop }`; `stop()` resolves once the daemon we own has actually gone, and
 * is a no-op for an adopted one, which belongs to systemd or to a terminal and would be a
 * surprising casualty of closing a window.
 */
export const startDaemonHost = async ({ root, url, isDev, onCrash }) => {
	if (await daemonAlive(url)) {
		console.log("[electron] adopting the daemon already listening on", url)
		return { mode: "adopt", logPath: null, stop: async () => {} }
	}

	const packaged = app.isPackaged
	const mode = chooseMode(packaged)
	if (mode === "adopt")
		throw new Error(
			`EEPALYTICS_DAEMON_MODE=adopt, but nothing is answering on ${url} — start one with \`pnpm daemon\``
		)

	const env = childEnv(packaged, isDev)
	const log = openLog(packaged)
	let stopping = false
	let gone = false
	let child = null

	const entry = join(
		root,
		"src",
		"daemon",
		mode === "utility" ? "utility-entry.ts" : "main.ts"
	)
	if (!existsSync(entry)) throw new Error(`daemon entry point not found at ${entry}`)

	const exited = new Promise(resolve => {
		if (mode === "utility") {
			/*
			 * No `--experimental-strip-types`: type stripping is on by default in Node 24, which
			 * is what Electron 44 bundles (verified — a `.ts` module forked here runs as is).
			 * The warning suppression is the same one every `pnpm` script in this repo passes.
			 */
			child = utilityProcess.fork(entry, [], {
				cwd: root,
				env,
				stdio: "pipe",
				execArgv: ["--no-warnings=ExperimentalWarning"],
				// Names it in Electron's process metrics and in Task Manager's child list, so a
				// busy daemon is attributable rather than an anonymous "eepalytics Helper".
				serviceName: "eepalytics-daemon"
			})
			pipeOutput(child, log)
			child.on("exit", code => {
				gone = true
				resolve()
				if (!stopping) onCrash(`code ${code}`, log?.path ?? null)
			})
		} else {
			child = spawn(
				process.execPath,
				["--experimental-strip-types", "--no-warnings=ExperimentalWarning", entry],
				{
					cwd: root,
					// ELECTRON_RUN_AS_NODE makes Electron's binary behave as plain Node, so the
					// daemon runs on the same runtime Electron ships rather than needing a
					// separate install.
					env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
					stdio: ["ignore", "pipe", "pipe"]
				}
			)
			pipeOutput(child, log)
			child.on("exit", (code, signal) => {
				gone = true
				resolve()
				if (!stopping) onCrash(signal ?? `code ${code}`, log?.path ?? null)
			})
		}
	})

	const stop = async () => {
		// `gone` covers the daemon that already crashed: posting to a destroyed utility process
		// throws, and the dialog about it has been shown already.
		if (stopping || gone || !child) return
		stopping = true
		/*
		 * Ask first, kill second.
		 *
		 * Windows has no SIGTERM, so `utilityProcess.kill()` there is a TerminateProcess — the
		 * daemon gets no chance to release its job leases or close SQLite cleanly. A message down
		 * the parent port is the only graceful stop that exists on the platform this ships to,
		 * and `src/daemon/utility-entry.ts` answers it. The kill below is the deadline, not the
		 * plan; a lease lost to it is reclaimed at the next boot by `adoptOrphanedLeases`.
		 */
		if (mode === "utility") child.postMessage({ type: "shutdown" })
		else child.kill("SIGTERM")

		await Promise.race([exited, sleep(STOP_TIMEOUT_MS)])
		if (!gone) child.kill()
	}

	console.log(`[electron] daemon started in ${mode} mode from ${entry}`)
	return { mode, logPath: log?.path ?? null, stop }
}

/** The dialog shown when a daemon we started stops on its own. */
export const reportDaemonCrash = (how, logPath) =>
	dialog.showErrorBox(
		"The eepalytics daemon stopped",
		`It exited with ${how}.\n\n` +
			`Nothing was lost — reviews, metrics and replays are all on disk. ` +
			`Close and reopen the app to restart it.\n\n` +
			(logPath ?
				`Why it stopped is in:\n${logPath}`
			:	`Run "pnpm daemon" in a terminal to see why it stopped.`)
	)
