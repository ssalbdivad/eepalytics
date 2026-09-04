/**
 * The Hono app.
 *
 * `createApp(deps)` builds it and nothing else: it does not open a database, spawn an LCU
 * transport, start a poll loop or bind a port. The daemon owns all of that and injects what
 * the HTTP layer needs through `ServerDeps` — so mounting the API inside the daemon process
 * (the normal case) and booting it standalone for testing are the same code path with a
 * different `deps` object.
 *
 * Layout:
 *   /api/*        the JSON + SSE contract in `shared/schema/api.ts`
 *   /media/*      the raw media tree (Range-served)
 *   /*            the built SPA from `dist/`, with a catch-all so client-side routing works
 *
 * There is no CORS middleware. In dev the Vite server on :7701 proxies `/api` and `/media` to
 * :7700, so requests are same-origin; in production the SPA is served from this same origin.
 * Adding permissive CORS to a daemon that holds someone's game data would be a downgrade, not
 * a convenience.
 */

import { Hono } from "hono"
import type { Context } from "hono"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { serve } from "@hono/node-server"
import type { ServerType } from "@hono/node-server"
import { useDb } from "../db/index.ts"
import { SERVER_HOST, SERVER_PORT } from "../shared/constants.ts"
import { APP_VERSION } from "./deps.ts"
import type { ServerDeps } from "./deps.ts"
import { createEventsRoute } from "./events.ts"
import { ContractError, fail } from "./respond.ts"
import { createAssetRoutes } from "./routes/assets.ts"
import { createChatRoutes } from "./routes/chat.ts"
import { createFormRoute } from "./routes/form.ts"
import { createWatchRoutes } from "./routes/watch.ts"
import { createLiveRoute } from "./routes/live.ts"
import { createShellRoutes } from "./routes/shell.ts"
import { createReplayRoutes } from "./routes/replays.ts"
import { createGamesRoutes } from "./routes/games.ts"
import { createHealthRoute } from "./routes/health.ts"
import { createJobRoutes } from "./routes/jobs.ts"
import {
	contentTypeFor,
	createMediaRoutes,
	createMediaStatic,
	isInside,
	sendFile
} from "./routes/media.ts"
import { createReviewRoutes } from "./routes/reviews.ts"
import { createSettingsRoutes } from "./routes/settings.ts"
import { createTrendsRoute } from "./routes/trends.ts"

const DEFAULT_DIST = resolve(import.meta.dirname, "../../dist")

export const createApp = (deps: ServerDeps = {}): Hono => {
	// One connection shared with the daemon, rather than two racing over the same file.
	if (deps.db) useDb(deps.db)

	const app = new Hono()

	/* ------------------------------------------------------------------ api */

	const api = new Hono()
	api.route("/", createHealthRoute(deps))
	api.route("/", createGamesRoutes())
	api.route("/", createReviewRoutes(deps))
	api.route("/", createChatRoutes())
	api.route("/", createReplayRoutes())
	api.route("/", createFormRoute())
	api.route("/", createWatchRoutes())
	api.route("/", createLiveRoute())
	api.route("/", createShellRoutes())
	api.route("/", createTrendsRoute())
	api.route("/", createJobRoutes(deps))
	api.route("/", createSettingsRoutes(deps))
	api.route("/", createMediaRoutes())
	api.route("/", createAssetRoutes(deps))
	api.route("/", createEventsRoute())

	// Anything under /api that matched nothing is a JSON 404, never the SPA shell — a fetch
	// that silently receives index.html is one of the worse debugging experiences there is.
	api.all("*", c => fail(c, 404, `no such endpoint: ${c.req.method} ${c.req.path}`, "no-route"))

	app.route("/api", api)

	/* ---------------------------------------------------------------- media */

	app.route("/", createMediaStatic())

	/* ------------------------------------------------------------------ spa */

	const distDir = resolve(deps.distDir ?? DEFAULT_DIST)
	const indexHtml = `${distDir}/index.html`

	const notBuiltYet = (c: Context): Response =>
		c.text(
			`fawnsei ${deps.version ?? APP_VERSION} — the API is up at /api/health.\n` +
				`The UI has not been built yet. Run \`pnpm dev\` for the Vite server on :7701, ` +
				`or \`pnpm build\` to produce dist/.\n`,
			503
		)

	if (deps.serveSpa !== false) {
		app.get("/*", c => {
			// Checked per request, not once at boot: the daemon usually starts BEFORE the first
			// `pnpm build`, and a UI that only appears after a daemon restart is a bad surprise.
			if (!existsSync(indexHtml)) return notBuiltYet(c)

			const rel = decodeURIComponent(c.req.path.replace(/^\/+/, ""))
			if (rel !== "" && !rel.endsWith("/")) {
				const abs = resolve(distDir, rel)
				if (isInside(distDir, abs) && existsSync(abs))
					return sendFile(c, abs, {
						contentType: contentTypeFor(abs),
						// Vite writes content-hashed filenames into dist/assets and nothing
						// else; those are immutable, index.html never is.
						cacheControl:
							rel.startsWith("assets/") ?
								"public, max-age=31536000, immutable"
							:	"no-cache"
					})
				// A missing hashed chunk must not become the HTML shell — the browser would
				// try to parse index.html as JavaScript and the error would name the wrong file.
				if (rel.startsWith("assets/")) return fail(c, 404, `no such asset: ${rel}`, "not-found")
			}
			// Client-side routing: every other unknown path is the shell.
			return sendFile(c, indexHtml, {
				contentType: "text/html; charset=utf-8",
				cacheControl: "no-cache"
			})
		})
	}

	/* --------------------------------------------------------------- errors */

	app.notFound(c => fail(c, 404, `not found: ${c.req.path}`, "not-found"))

	app.onError((err, c) => {
		if (err instanceof ContractError) {
			// A response that violates its own contract is a bug in this repo, not in the
			// request. Make it loud and name the route.
			console.error(`[server] ${err.message}`)
			return fail(c, 500, "response contract violated", "contract-violation", err.issues)
		}
		console.error(`[server] ${c.req.method} ${c.req.path} failed:`, err)
		return fail(c, 500, "internal error", "internal", (err as Error).message)
	})

	return app
}

export interface StartedServer {
	app: Hono
	server: ServerType
	port: number
	host: string
	close: () => Promise<void>
}

/**
 * Bind the app to a port. The daemon calls this; so does the verification harness. Kept here
 * rather than in `daemon/main.ts` so that "the server listens correctly" is testable without
 * booting a supervisor, a bridge and a worker pool.
 */
export const startServer = (
	deps: ServerDeps = {},
	port: number = SERVER_PORT,
	host: string = SERVER_HOST
): StartedServer => {
	const app = createApp(deps)
	const server = serve({ fetch: app.fetch, port, hostname: host })
	return {
		app,
		server,
		port,
		host,
		close: () =>
			new Promise<void>(res => {
				server.close(() => res())
			})
	}
}
