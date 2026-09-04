/**
 * Electron shell for eepalytics.
 *
 * ## Why this is plain JavaScript, not TypeScript
 *
 * Everything else in this repo runs under `node --experimental-strip-types`. Electron's main
 * process runs Electron's OWN bundled Node, whose version moves with the Electron release rather
 * than with the Node on this machine. Today that is 24.19.0 and it does strip types (measured —
 * the daemon is a `.ts` file forked straight into a utility process). What is not guaranteed is
 * the NEXT Electron bump, and a shell that fails to boot because of a syntax feature takes the
 * whole app with it, including the window that would have said why. The daemon it launches is
 * TypeScript, and type-checked; these few hundred lines of window plumbing are not worth that
 * risk.
 *
 * ## Where the daemon lives
 *
 * In its own process, always — but not always the same kind of one. `electron/daemon.mjs` picks
 * between adopting a daemon that is already listening, forking one into an Electron
 * `utilityProcess` (what ships), and spawning the plain Node child this file used to hard-code
 * (what the WSL checkout keeps). The reasoning for each is there rather than here.
 *
 * What matters at this level is that it is never THIS process. `node:sqlite` is synchronous, the
 * daemon's work sits on top of it, and this process is the one painting the window and answering
 * the live coach's screen-capture requests mid-game.
 *
 * ## Where this runs
 *
 * Two places now, and they differ in one visible way. Under WSLg — a Wayland/X display inside
 * WSL — the window can only see Linux screens, so the live coach hands off to a Windows browser;
 * see `src/web/lib/capture-env.ts` and `electron/preload.cjs`. Installed on Windows it is a
 * Windows process on the same desktop as the game and captures it directly.
 */

import { app, BrowserWindow, dialog, shell } from "electron"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { reportDaemonCrash, startDaemonHost, waitForDaemon } from "./daemon.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..")

/** Must match `SERVER_PORT` in src/shared/constants.ts. */
const PORT = Number((process.env.EEPALYTICS_PORT ?? process.env.CSK_PORT) ?? 7700)
const HOST = "127.0.0.1"
// Must match `server.port` in vite.config.ts.
const DEV_URL = (process.env.EEPALYTICS_DEV_URL ?? process.env.CSK_DEV_URL) ?? "http://127.0.0.1:7701"
const isDev = (process.env.EEPALYTICS_DEV ?? process.env.CSK_DEV) === "1"

/** How long to wait for the daemon's own health endpoint before giving up. */
const DAEMON_BOOT_TIMEOUT_MS = 30_000

/** The daemon we started or adopted — `{ mode, stop }` from `daemon.mjs`. */
let daemon = null
let win = null
/** Set when we are tearing down on purpose, so an expected exit is not reported as a crash. */
let quitting = false

const daemonUrl = `http://${HOST}:${PORT}`

/**
 * Window and taskbar icon. Regenerate with `pnpm icon` after replacing `public/lillia-art.png`.
 *
 * Electron wants a raster path here — a vector file is silently ignored and you get a blank
 * default, which looks like a bug in the app rather than a missing file. The packaged Windows
 * build takes its icon from `public/icon.ico` instead, via `electron-builder.yml`; this one is
 * what an unpackaged run shows.
 */
const ICON_PATH = join(ROOT, "public", "icon.png")
const windowIcon = () => (existsSync(ICON_PATH) ? { icon: ICON_PATH } : {})

/**
 * A splash while the main window loads.
 *
 * The main window is created with `show: false` and only appears on `ready-to-show`, which is
 * correct — showing a half-painted window looks broken — but it means clicking the app produces
 * nothing at all for a second or two, and a launcher that appears to do nothing gets clicked
 * again. This fills that gap and closes itself the moment the real window is ready.
 *
 * Frameless, transparent and not resizable: it is a picture, not a window, and it must never
 * outlive the thing it is covering. `closeSplash` is called from `ready-to-show` AND from the
 * failure paths, because a splash that survives a failed launch is worse than no splash.
 */
let splash = null

const closeSplash = () => {
	if (splash && !splash.isDestroyed()) splash.close()
	splash = null
}

const createSplash = () => {
	splash = new BrowserWindow({
		width: 340,
		height: 400,
		frame: false,
		transparent: true,
		resizable: false,
		movable: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		show: true,
		webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
	})
	const art = join(ROOT, "public", "splash-512.png")
	const src = existsSync(art) ? `file://${art}` : ""
	// A data URL: no server is running yet, and this must not depend on one.
	splash.loadURL(
		`data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;background:transparent;overflow:hidden">
	<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100vh;background:#07090e;border-radius:16px;color:#e7e9ef;font:400 13px/1.5 ui-sans-serif,system-ui,'Segoe UI',sans-serif">
	  ${src ? `<img src="${src}" width="260" height="260" style="border-radius:16px"/>` : ""}
	  <div style="font-size:19px;font-weight:640">eepalytics</div>
	  <div style="color:#737d92;font-size:12px">warming up the whiteboard…</div>
	</div></body></html>`)}`
	)
	splash.on("closed", () => {
		splash = null
	})
}

const createWindow = async () => {
	win = new BrowserWindow({
		width: 1500,
		height: 950,
		minWidth: 900,
		minHeight: 600,
		show: false,
		backgroundColor: "#07090e",
		title: "eepalytics",
		...windowIcon(),
		autoHideMenuBar: true,
		webPreferences: {
			// The renderer is the same React app the browser loads and talks to the daemon over
			// HTTP. It needs no Node access, so it does not get any beyond the two-channel
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			/*
			 * Two read-only strings, no functions — see `preload.cjs`. It exists because the page
			 * cannot otherwise tell a WSLg window (which can never see the game) from a Windows
			 * install (which always can), and it used to guess from the user agent and get the
			 * second one wrong. The sandbox stays on; the preload is CommonJS for that reason.
			 */
			preload: join(HERE, "preload.cjs")
		}
	})

	win.once("ready-to-show", () => {
		closeSplash()
		win?.show()
	})

	win.webContents.setWindowOpenHandler(({ url }) => {
		// `#/live` used to summon a separate always-on-top overlay window. It no longer exists —
		// it rendered the same <Live> component this window already shows, and it could never run
		// the screen share that the coach is FOR, because Electron under WSLg cannot see Windows
		// windows. So an in-app link navigates this window instead of opening anything.
		if (url.startsWith(isDev ? DEV_URL : daemonUrl)) {
			void win?.loadURL(url)
			return { action: "deny" }
		}
		// Anything else opens in the real browser rather than a chrome-less window the user
		// cannot navigate out of.
		void shell.openExternal(url)
		return { action: "deny" }
	})

	const ok = await waitForDaemon(daemonUrl, DAEMON_BOOT_TIMEOUT_MS)
	if (!ok) {
		dialog.showErrorBox(
			"The daemon did not start",
			`Nothing answered on ${daemonUrl} within ${DAEMON_BOOT_TIMEOUT_MS / 1000}s.\n\n` +
				// Whatever went wrong was printed by the daemon itself and piped through this
				// process, so the advice differs by where that output went: a terminal in a
				// checkout, and nowhere a person can see in an installed app.
				(daemon?.logPath ?
					`What it printed on the way down is in:\n${daemon.logPath}`
				:	`Run "pnpm daemon" in a terminal to see the error.`)
		)
		app.quit()
		return
	}

	// In dev the renderer comes from Vite so hot reload works; in production the daemon serves
	// the built assets, which keeps one origin and avoids file:// CORS entirely.
	await win.loadURL(isDev ? DEV_URL : daemonUrl)
	if (isDev) win.webContents.openDevTools({ mode: "detach" })
}

/**
 * Allow the page to capture the screen, for live coaching.
 *
 * `getDisplayMedia` is refused by default in Electron. Granting it needs a handler, and the
 * handler is where the choice of WHAT gets shared lives — this picks the primary screen rather
 * than showing a picker, because the alternative is a modal appearing over a running game.
 *
 * It matches on the display id rather than taking the first source in the list. Under WSLg that
 * distinction is academic (this window cannot see the game either way, and the page says so).
 * On a Windows install with a second monitor it is the difference between coaching the game and
 * narrating a browser: nothing documents the enumeration order, and the game is on the primary
 * display, which the `screen` module can name.
 *
 * This is the one place the app can see outside itself, so it is deliberately narrow: video
 * only, no audio, and only ever one screen.
 */
const allowScreenCapture = async () => {
	const { desktopCapturer, screen, session } = await import("electron")
	session.defaultSession.setDisplayMediaRequestHandler(
		(_request, callback) => {
			void desktopCapturer
				.getSources({ types: ["screen"] })
				.then(sources => {
					const primary = String(screen.getPrimaryDisplay().id)
					// The fallback is the old behaviour: `display_id` is empty on some platforms,
					// and a share of the wrong screen still beats a share of nothing.
					const source = sources.find(s => s.display_id === primary) ?? sources[0]
					callback(source ? { video: source } : undefined)
				})
				.catch(() => callback(undefined))
		},
		// Never the microphone or system audio. The feature needs pixels and nothing else.
		{ useSystemPicker: false }
	)
}

app.whenReady().then(async () => {
	/*
	 * Up before anything slow happens. Starting the daemon and waiting for it to answer is most
	 * of the launch, and that is the whole stretch a person is staring at nothing.
	 */
	createSplash()
	await allowScreenCapture()
	try {
		daemon = await startDaemonHost({
			root: ROOT,
			url: daemonUrl,
			isDev,
			// Only fires for an exit nobody asked for; a daemon dying under us is not something
			// to hide behind a blank window.
			onCrash: (how, logPath) => {
				daemon = null
				if (!quitting) reportDaemonCrash(how, logPath)
			}
		})
	} catch (err) {
		closeSplash()
		dialog.showErrorBox("eepalytics could not start", String(err))
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
 * be a surprising side effect of closing a window; `stop()` knows which it has.
 *
 * The quit is HELD while that happens, which the old SIGTERM-and-exit did not do. Asking a
 * process to shut down and then immediately exiting out from under it is barely different from
 * killing it: the queue gets no chance to release its leases and SQLite none to close. `stop()`
 * carries its own deadline, so this can wait on it without a hung handler being able to make the
 * app unquittable.
 */
app.on("before-quit", event => {
	if (quitting || !daemon) return
	quitting = true
	event.preventDefault()
	void daemon.stop().finally(() => app.quit())
})
