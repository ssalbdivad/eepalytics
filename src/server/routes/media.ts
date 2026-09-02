/**
 * `GET /api/media/:id` — screenshots, clips and generated map images.
 *
 * Two things this route has to get right:
 *
 * 1. **Range requests.** A `<video>` element seeks by asking for byte ranges. A naive
 *    200-with-the-whole-body response makes the clip play but makes the scrubber dead, which
 *    is exactly the interaction the whole capture pipeline exists to serve. So: `Accept-Ranges`
 *    on every response, 206 + `Content-Range` for a satisfiable range, 416 for a nonsense one.
 *
 * 2. **Paths never leave the data directory.** `Media.path` is stored relative to `DATA_DIR`
 *    and is only ever resolved here. Anything that escapes after resolution is refused, so a
 *    poisoned row cannot turn this into a file-read primitive over the whole disk.
 *
 * Generated SVG map images are served inline as `image/svg+xml` — they are the always-available
 * fallback when real capture was impossible, so they must render in an `<img>` like any other.
 */

import { Hono } from "hono"
import { createReadStream, statSync } from "node:fs"
import { Readable } from "node:stream"
import { extname, resolve, sep } from "node:path"
import { resolveDataPath } from "../../db/blobs.ts"
import { getMedia } from "../../db/queries.ts"
import { DATA_DIR, MEDIA_DIR } from "../../shared/constants.ts"
import { fail, notFound } from "../respond.ts"
import type { Context } from "hono"

const TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mkv": "video/x-matroska",
	".m4v": "video/mp4",
	".json": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".ico": "image/x-icon",
	".woff2": "font/woff2"
}

export const contentTypeFor = (path: string): string =>
	TYPES[extname(path).toLowerCase()] ?? "application/octet-stream"

/** True when `abs` really is inside `root` — the check that keeps `../../` out. */
export const isInside = (root: string, abs: string): boolean => {
	const r = resolve(root)
	return abs === r || abs.startsWith(r.endsWith(sep) ? r : r + sep)
}

/** `bytes=0-1023`, `bytes=1024-`, `bytes=-500`. Anything else is a miss, not an error. */
export const parseRange = (
	header: string | undefined,
	size: number
): { start: number; end: number } | "invalid" | null => {
	if (!header) return null
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
	if (!m) return null
	const [, rawStart = "", rawEnd = ""] = m
	if (rawStart === "" && rawEnd === "") return "invalid"

	let start: number
	let end: number
	if (rawStart === "") {
		// Suffix form: the LAST n bytes.
		const n = Number(rawEnd)
		if (!Number.isFinite(n) || n <= 0) return "invalid"
		start = Math.max(0, size - n)
		end = size - 1
	} else {
		start = Number(rawStart)
		end = rawEnd === "" ? size - 1 : Number(rawEnd)
	}
	if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid"
	if (start < 0 || start > end || start >= size) return "invalid"
	return { start, end: Math.min(end, size - 1) }
}

export interface SendFileOptions {
	contentType?: string
	/** `Cache-Control`. Media is content-addressed by row id and never rewritten in place. */
	cacheControl?: string
	/** Suggest a download filename instead of rendering inline. */
	downloadAs?: string
}

/**
 * Stream a file with Range support. Shared with the SPA/static handlers in `app.ts` so there
 * is exactly one implementation of "read a file off disk and send it".
 */
export const sendFile = (
	c: Context,
	abs: string,
	opts: SendFileOptions = {}
): Response => {
	let size: number
	try {
		const st = statSync(abs)
		if (!st.isFile()) return notFound(c, "file")
		size = st.size
	} catch {
		return notFound(c, "file")
	}

	const type = opts.contentType ?? contentTypeFor(abs)
	const headers = new Headers({
		"Content-Type": type,
		"Accept-Ranges": "bytes",
		"Cache-Control": opts.cacheControl ?? "public, max-age=31536000, immutable"
	})
	if (opts.downloadAs)
		headers.set("Content-Disposition", `attachment; filename="${opts.downloadAs}"`)

	const isHead = c.req.method === "HEAD"
	const range = parseRange(c.req.header("Range"), size)

	if (range === "invalid") {
		headers.set("Content-Range", `bytes */${size}`)
		return new Response(null, { status: 416, headers })
	}

	const start = range ? range.start : 0
	const end = range ? range.end : size - 1
	const length = size === 0 ? 0 : end - start + 1

	headers.set("Content-Length", String(length))
	if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`)

	if (isHead || length === 0)
		return new Response(null, { status: range ? 206 : 200, headers })

	const node = createReadStream(abs, { start, end })
	c.req.raw.signal?.addEventListener("abort", () => node.destroy())
	const web = Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>

	return new Response(web, { status: range ? 206 : 200, headers })
}

export const createMediaRoutes = (): Hono => {
	const app = new Hono()

	const byId = (c: Context): Response => {
		const id = c.req.param("id")
		if (!id) return fail(c, 400, "media id is required", "bad-media-id")

		const media = getMedia(id)
		if (!media) return notFound(c, `media ${id}`)

		const abs = resolve(resolveDataPath(media.path))
		if (!isInside(DATA_DIR, abs))
			return fail(
				c,
				403,
				"that media row points outside the data directory",
				"media-path-escape",
				media.path
			)

		return sendFile(c, abs, {
			contentType: media.mimeType ?? contentTypeFor(abs)
		})
	}

	app.get("/media/:id", byId)
	app.on("HEAD", "/media/:id", byId)

	return app
}

/**
 * `GET /media/*` — the raw media tree, mounted outside `/api` because the Vite dev server
 * proxies that prefix and because generated HTML/SVG can reference a sibling file by path.
 * Ids are still the supported way in; this is a convenience, with the same escape check.
 */
export const createMediaStatic = (): Hono => {
	const app = new Hono()

	const serve = (c: Context): Response => {
		const rel = c.req.path.replace(/^.*?\/media\/?/, "")
		if (rel === "") return notFound(c, "media")
		const abs = resolve(MEDIA_DIR, decodeURIComponent(rel))
		if (!isInside(MEDIA_DIR, abs)) return fail(c, 403, "path escapes the media directory", "path-escape")
		return sendFile(c, abs)
	}

	app.get("/media/*", serve)
	app.on("HEAD", "/media/*", serve)

	return app
}
