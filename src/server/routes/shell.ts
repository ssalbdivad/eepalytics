/**
 * `POST /api/shell/open-in-windows` — hand a URL to the Windows default browser.
 *
 * WHY THIS EXISTS. Screen sharing cannot work from the Electron app: it runs inside WSL under
 * WSLg, whose compositor only contains Linux windows. Enumerated live, Electron sees three WSLg
 * virtual screens and exactly one window — its own. The League client is a Windows process and
 * is not among them, and no amount of permission handling changes that; the renderer would have
 * to be a Windows process to see Windows pixels.
 *
 * A Windows browser IS a Windows process, `localhost` is a secure context so `getDisplayMedia`
 * is permitted there, and WSL2 forwards localhost into the distro so the page still reaches this
 * daemon. So the fix is to open the same page over there, and this is the one line of plumbing
 * that needs.
 *
 * Only ever this app's own origin. The route takes a path, not a URL, so it cannot be talked
 * into launching a browser at somewhere else.
 */

import { Hono } from "hono"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { SERVER_PORT } from "../../shared/constants.ts"
import { makeLogger } from "../../daemon/log.ts"
import { fail } from "../respond.ts"

const log = makeLogger("shell")

/**
 * A launch is a window appearing on top of whatever he is doing, and he plays League on this
 * machine. So this route is rate-limited HARD, and the limits are about blast radius rather than
 * about load: opening a browser is not expensive, it is *intrusive*.
 *
 * Twice now a runaway has produced a wall of tabs — once from a test with a hardcoded launcher,
 * and once mid-game from a trigger that was never pinned down. The second time is why these
 * exist: the first fix removed one cause, and a cause that cannot be reproduced cannot be
 * removed at all. A cap converts any future runaway, whatever its source, into one tab.
 */
const LAUNCH_COOLDOWN_MS = 10_000
/** Per process lifetime. Legitimate use is one press, occasionally two. Thirty is never real. */
const LAUNCH_CEILING = 6

let lastLaunchMs = 0
let launchCount = 0

/** Only for tests — a fresh process is the only thing that resets these in real use. */
export const resetLaunchLimits = (): void => {
	lastLaunchMs = 0
	launchCount = 0
}

const EXPLORER = "/mnt/c/Windows/explorer.exe"

/**
 * How the URL actually gets launched. Injectable, and that is not a nicety.
 *
 * This route spawns a real Windows process, and its tests POST to it to check the URL cannot be
 * redirected — so with the launcher hardcoded, every `pnpm test` opened half a dozen browser
 * tabs on the developer's machine. It did, repeatedly, until someone noticed a wall of them.
 *
 * A route with a side effect on the world outside the process has to let a caller substitute
 * that effect, or its tests cannot be run.
 */
export type Launcher = (url: string) => void

const launchViaExplorer: Launcher = url => {
	/*
	 * `explorer.exe <url>` is the reliable way to reach the Windows default browser from WSL.
	 * It exits non-zero even on success, which is long-standing and harmless, so the exit code
	 * is deliberately not treated as failure.
	 */
	execFile(EXPLORER, [url], { timeout: 8_000 }, () => {})
}

export const createShellRoutes = (launch: Launcher = launchViaExplorer): Hono => {
	const app = new Hono()

	app.post("/shell/open-in-windows", async c => {
		if (!existsSync(EXPLORER))
			return fail(
				c,
				501,
				"no Windows shell reachable from here — this only works under WSL",
				"not-wsl"
			)

		const body = (await c.req.json().catch(() => null)) as { hash?: unknown } | null
		// A hash fragment, never a URL: the origin is fixed here so this cannot be pointed
		// anywhere but at this app.
		const hash = typeof body?.hash === "string" ? body.hash.replace(/[^#/a-zA-Z0-9_-]/g, "") : ""
		const url = `http://localhost:${SERVER_PORT}/${hash.startsWith("#") ? hash : ""}`

		const now = Date.now()
		if (now - lastLaunchMs < LAUNCH_COOLDOWN_MS) {
			const waitMs = LAUNCH_COOLDOWN_MS - (now - lastLaunchMs)
			log.warn(`refusing a second browser launch ${now - lastLaunchMs}ms after the last one`)
			return fail(
				c,
				429,
				`a window was just opened — wait ${Math.ceil(waitMs / 1000)}s before asking again`,
				"too-soon"
			)
		}
		if (launchCount >= LAUNCH_CEILING) {
			log.warn(`refusing browser launch ${launchCount + 1} — ceiling is ${LAUNCH_CEILING}`)
			return fail(
				c,
				429,
				"this app has opened as many windows as it is ever going to in one run — restart the daemon if you genuinely need another",
				"launch-ceiling"
			)
		}

		lastLaunchMs = now
		launchCount += 1
		// Logged EVERY time, with the running count. The last outbreak could not be traced because
		// nothing recorded that a launch had happened at all.
		log.info(`opening a Windows browser at ${url} (launch ${launchCount}/${LAUNCH_CEILING})`)
		launch(url)
		return c.json({ ok: true, url })
	})

	return app
}
