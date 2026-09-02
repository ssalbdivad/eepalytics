/**
 * `GET /api/assets/*` — champion icons, item icons, spell icons, and the static-data JSON.
 *
 * The path after `/api/assets/` is the LCU asset path with its `/lol-game-data/assets/` prefix
 * stripped, exactly as it appears in `iconPath` fields:
 *
 *   /api/assets/v1/champion-icons/876.png
 *   /api/assets/ASSETS/Items/Icons2D/3047_Class_T2_NinjaTabi.png
 *   /api/assets/v1/champion-summary.json
 *
 * **Never construct an item icon path by hand** — the filename encodes an old codename (item
 * 3047 is "Plated Steelcaps" but the file is `3047_Class_T2_NinjaTabi.png`, and a hand-typed
 * variant returns HTTP 400). Read `iconPath` out of `items.json` and pass it through.
 *
 * Resolution order, per `.research/lcu-api.md` §6:
 *   1. the on-disk cache under `DATA_DIR/assets` — so the UI keeps its icons with League closed;
 *   2. the authenticated LCU, when the daemon injected a transport;
 *   3. CommunityDragon, which mirrors byte-identical `rcp-be-lol-game-data` payloads (verified:
 *      champion-summary.json is 54 117 B from both) and is reachable from WSL without interop;
 *   4. a placeholder SVG.
 *
 * Step 4 is the point of the whole route: **a missing icon must never 500 and must never leave
 * a broken-image glyph in a scoreboard.** The placeholder is served `no-store` so the next
 * request tries the network again.
 */

import { Hono } from "hono"
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { Context } from "hono"
import { DATA_DIR } from "../../shared/constants.ts"
import type { AssetBytes, ServerDeps } from "../deps.ts"
import { fail } from "../respond.ts"
import { contentTypeFor, isInside, sendFile } from "./media.ts"

/** Where fetched assets are cached. Mirrors the LCU's own path layout, one file per asset. */
export const ASSETS_DIR = `${DATA_DIR}/assets`

const CDRAGON_BASE =
	"https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default"

/** Assets are immutable per patch; a day is long enough to be useful and short enough to heal. */
const CACHE_CONTROL = "public, max-age=86400"

/** Concurrent requests for the same cold asset share one fetch. */
const inFlight = new Map<string, Promise<AssetBytes | null>>()

/** Only ever `a/b/c.png`. No absolute paths, no traversal, no query strings. */
const cleanRelPath = (raw: string): string | null => {
	let rel: string
	try {
		rel = decodeURIComponent(raw)
	} catch {
		return null
	}
	rel = rel.replace(/^\/+/, "").replace(/\\/g, "/").split("?")[0] ?? ""
	if (rel === "" || rel.length > 512) return null
	if (rel.split("/").some(seg => seg === "." || seg === ".." || seg === "")) return null
	if (!/^[A-Za-z0-9._/\-+]+$/.test(rel)) return null
	// Callers sometimes paste the full LCU path; accept it and normalise.
	return rel.replace(/^lol-game-data\/assets\//, "")
}

const writeCache = (abs: string, body: Uint8Array): void => {
	try {
		mkdirSync(dirname(abs), { recursive: true })
		const tmp = `${abs}.tmp-${process.pid}`
		writeFileSync(tmp, body)
		renameSync(tmp, abs)
	} catch (err) {
		console.warn(`[assets] could not cache ${abs}: ${(err as Error).message}`)
	}
}

const fromCdragon = async (rel: string): Promise<AssetBytes | null> => {
	// CDragon serves lowercased paths; that is VERIFIED for the `v1/` JSON and UNVERIFIED for
	// the `ASSETS/` icons, so try lowercase first and fall back to the original spelling.
	const candidates =
		rel === rel.toLowerCase() ? [rel] : [rel.toLowerCase(), rel]
	for (const candidate of candidates) {
		try {
			const res = await fetch(`${CDRAGON_BASE}/${candidate}`, {
				signal: AbortSignal.timeout(8000)
			})
			if (!res.ok) continue
			return {
				body: new Uint8Array(await res.arrayBuffer()),
				contentType: res.headers.get("content-type") ?? contentTypeFor(candidate)
			}
		} catch {
			/* offline, or CDragon is down — fall through to the next candidate */
		}
	}
	return null
}

const acquire = async (
	deps: ServerDeps,
	rel: string
): Promise<AssetBytes | null> => {
	const pending = inFlight.get(rel)
	if (pending) return pending

	const job = (async (): Promise<AssetBytes | null> => {
		if (deps.fetchLcuAsset) {
			try {
				const got = await deps.fetchLcuAsset(`/lol-game-data/assets/${rel}`)
				if (got && got.body.byteLength > 0) return got
			} catch {
				/* client closed or the bridge is down — CDragon is the whole reason it is here */
			}
		}
		return fromCdragon(rel)
	})().finally(() => inFlight.delete(rel))

	inFlight.set(rel, job)
	return job
}

/** A neutral, theme-agnostic "no icon" tile. Renders in an `<img>` whatever extension was asked for. */
const placeholderSvg = (label: string): string =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="icon unavailable">` +
	`<rect width="64" height="64" rx="8" fill="#2a2d34"/>` +
	`<rect x="0.5" y="0.5" width="63" height="63" rx="7.5" fill="none" stroke="#4a4f59"/>` +
	`<text x="32" y="39" text-anchor="middle" font-family="system-ui,sans-serif" font-size="26" fill="#7b828f">?</text>` +
	`<title>${label.replace(/[<>&]/g, "")}</title></svg>`

const placeholder = (c: Context, rel: string): Response =>
	new Response(placeholderSvg(rel), {
		status: 200,
		headers: {
			"Content-Type": "image/svg+xml; charset=utf-8",
			// Never cache a failure: the client may open in ten seconds and the icon appear.
			"Cache-Control": "no-store",
			"X-Asset-Status": "placeholder"
		}
	})

export const createAssetRoutes = (deps: ServerDeps): Hono => {
	const app = new Hono()

	const serveAsset = async (c: Context, rawRel: string): Promise<Response> => {
		const rel = cleanRelPath(rawRel)
		if (rel === null) return fail(c, 400, "invalid asset path", "bad-asset-path")

		const abs = resolve(ASSETS_DIR, rel)
		if (!isInside(ASSETS_DIR, abs))
			return fail(c, 403, "path escapes the asset cache", "path-escape")

		if (existsSync(abs))
			return sendFile(c, abs, { cacheControl: CACHE_CONTROL })

		const got = await acquire(deps, rel)
		if (!got) return placeholder(c, rel)

		writeCache(abs, got.body)

		return new Response(got.body as unknown as BodyInit, {
			status: 200,
			headers: {
				"Content-Type": got.contentType || contentTypeFor(rel),
				"Cache-Control": CACHE_CONTROL,
				"Content-Length": String(got.body.byteLength)
			}
		})
	}

	/** Convenience: the one icon the UI asks for constantly, keyed by championId. */
	app.get("/assets/champion/:championId", c => {
		const id = c.req.param("championId").replace(/\.png$/i, "")
		if (!/^\d+$/.test(id)) return fail(c, 400, "championId must be numeric", "bad-champion-id")
		return serveAsset(c, `v1/champion-icons/${id}.png`)
	})

	/** Convenience: profile icons are `.jpg`, which is easy to get wrong by hand. */
	app.get("/assets/profile-icon/:iconId", c => {
		const id = c.req.param("iconId").replace(/\.(jpg|png)$/i, "")
		if (!/^\d+$/.test(id)) return fail(c, 400, "iconId must be numeric", "bad-icon-id")
		return serveAsset(c, `v1/profile-icons/${id}.jpg`)
	})

	app.get("/assets/*", c => serveAsset(c, c.req.path.replace(/^.*?\/assets\/?/, "")))

	return app
}
