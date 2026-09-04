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
import { fail } from "../respond.ts"

const EXPLORER = "/mnt/c/Windows/explorer.exe"

export const createShellRoutes = (): Hono => {
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

		/*
		 * `explorer.exe <url>` is the reliable way to reach the Windows default browser from WSL.
		 * It exits non-zero even on success, which is long-standing and harmless, so the exit
		 * code is deliberately not treated as failure.
		 */
		execFile(EXPLORER, [url], { timeout: 8_000 }, () => {})
		return c.json({ ok: true, url })
	})

	return app
}
