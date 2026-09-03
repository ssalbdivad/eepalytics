/**
 * Electron shell for coachskaffur.
 *
 * ## Why this is plain JavaScript, not TypeScript
 *
 * Everything else in this repo runs under `node --experimental-strip-types`. Electron's main
 * process runs Electron's OWN bundled Node, whose version is tied to the Electron release, not
 * to the Node on this machine — so type stripping is not guaranteed to be available there. A
 * shell that fails to boot because of a syntax feature is a bad trade for types in ~200 lines.
 * The daemon it launches is still TypeScript, and still type-checked.
 *
 * ## Why the daemon is a CHILD PROCESS and not part of this file
 *
 * The daemon must run inside WSL. Every League API call crosses Windows interop (WSL2 cannot
 * reach `127.0.0.1:<lcu port>` on the host), and `src/daemon/gate.ts` owns every side effect on
 * the client. Folding that into Electron's main process would either move it out of WSL or
 * duplicate it. Spawning the existing entry point unchanged keeps one implementation of the
 * gate, one transport, and one set of tests — and `pnpm daemon` still works on its own with no
 * Electron involved.
 *
 * ## Where this runs
 *
 * Under WSLg, which provides a Wayland/X display inside WSL (`/mnt/wslg`, `DISPLAY=:0`). That
 * keeps the window and the daemon on the same side of the filesystem boundary, so the app reads
 * `data/` and the replay folder exactly as it does today.
 */

import { app, BrowserWindow, dialog, shell } from "electron"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..")

/** Must match `SERVER_PORT` in src/shared/constants.ts. */
const PORT = Number(process.env.CSK_PORT ?? 7700)
const HOST = "127.0.0.1"
const DEV_URL = process.env.CSK_DEV_URL ?? "http://127.0.0.1:5173"
const isDev = process.env.CSK_DEV === "1"

/** How long to wait for the daemon's own health endpoint before giving up. */
const DAEMON_BOOT_TIMEOUT_MS = 30_000

let daemon = null
let win = null
/** Set when we are tearing down on purpose, so an expected exit is not reported as a crash. */
let quitting = false

const daemonUrl = `http://${HOST}:${PORT}`

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Is something already answering on the port? Then do not start a second daemon. */
const daemonAlive = async () => {
	try {
		const res = await fetch(`${daemonUrl}/api/health`, {
			signal: AbortSignal.timeout(2_000)
		})
		return res.ok
	} catch {
		return false
	}
}

const startDaemon = async () => {
	// A daemon may already be running under systemd, or from `pnpm dev`. Adopting it is both
	// faster and safer than racing it for the port and the SQLite write lock.
	if (await daemonAlive()) {
		console.log("[electron] adopting the daemon already listening on", daemonUrl)
		return null
	}

	const entry = join(ROOT, "src", "daemon", "main.ts")
	if (!existsSync(entry)) throw new Error(`daemon entry point not found at ${entry}`)

	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "--no-warnings=ExperimentalWarning", entry],
		{
			cwd: ROOT,
			// ELECTRON_RUN_AS_NODE makes Electron's binary behave as plain Node, so the daemon
			// runs on the same runtime Electron ships rather than needing a separate install.
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: isDev ? "development" : "production" },
			stdio: ["ignore", "pipe", "pipe"]
		}
	)

	child.stdout.on("data", d => process.stdout.write(`[daemon] ${d}`))
	child.stderr.on("data", d => process.stderr.write(`[daemon] ${d}`))
	child.on("exit", (code, signal) => {
		daemon = null
		if (quitting) return
		// The daemon dying under us is not something to hide behind a blank window.
		dialog.showErrorBox(
			"The coachskaffur daemon stopped",
			`It exited with ${signal ?? `code ${code}`}.\n\n` +
				`Nothing was lost — reviews, metrics and replays are all on disk. ` +
				`Close and reopen the app to restart it, or run "pnpm daemon" in a terminal to see why it stopped.`
		)
	})

	return child
}

/** Poll health until the daemon answers, so the window never opens onto a connection error. */
const waitForDaemon = async () => {
	const deadline = Date.now() + DAEMON_BOOT_TIMEOUT_MS
	while (Date.now() < deadline) {
		if (await daemonAlive()) return true
		await sleep(400)
	}
	return false
}

const createWindow = async () => {
	win = new BrowserWindow({
		width: 1500,
		height: 950,
		minWidth: 900,
		minHeight: 600,
		show: false,
		backgroundColor: "#07090e",
		title: "coachskaffur",
		autoHideMenuBar: true,
		webPreferences: {
			// The renderer is the same React app the browser loads and talks to the daemon over
			// HTTP. It needs no Node access, so it does not get any.
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true
		}
	})

	win.once("ready-to-show", () => win?.show())

	// Anything that is not this app opens in the real browser rather than a chrome-less window
	// the user cannot navigate out of.
	win.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url)
		return { action: "deny" }
	})

	const ok = await waitForDaemon()
	if (!ok) {
		dialog.showErrorBox(
			"The daemon did not start",
			`Nothing answered on ${daemonUrl} within ${DAEMON_BOOT_TIMEOUT_MS / 1000}s.\n\n` +
				`Run "pnpm daemon" in a terminal to see the error.`
		)
		app.quit()
		return
	}

	// In dev the renderer comes from Vite so hot reload works; in production the daemon serves
	// the built assets, which keeps one origin and avoids file:// CORS entirely.
	await win.loadURL(isDev ? DEV_URL : daemonUrl)
	if (isDev) win.webContents.openDevTools({ mode: "detach" })
}

app.whenReady().then(async () => {
	try {
		daemon = await startDaemon()
	} catch (err) {
		dialog.showErrorBox("coachskaffur could not start", String(err))
		app.quit()
		return
	}
	await createWindow()

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) void createWindow()
	})
})

app.on("window-all-closed", () => {
	// Including on macOS: this is a single-window tool, and leaving a headless daemon running
	// behind a closed window is exactly the kind of thing that quietly holds the League client.
	app.quit()
})

/**
 * Stop the daemon we started — and only that one.
 *
 * A daemon we adopted belongs to systemd or to a terminal, and killing it on window close would
 * be a surprising side effect of closing a window. SIGTERM gives the queue a chance to release
 * its leases; `src/daemon/main.ts` already handles it.
 */
app.on("before-quit", () => {
	quitting = true
	if (daemon && !daemon.killed) daemon.kill("SIGTERM")
})
