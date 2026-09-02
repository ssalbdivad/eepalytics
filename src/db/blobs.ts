/**
 * Gzipped JSON archives on disk, at `DATA_DIR/blobs/<gameId>/<name>.json.gz`.
 *
 * Why not SQLite: a timeline is 112 KB and nobody queries INSIDE one with SQL. Rows carry the
 * relative path; the bytes live here. Measured compression on real payloads:
 *
 *     timeline  112 425 -> 12 414 bytes  (11%)
 *     match      31 844 ->  4 565 bytes  (14%)
 *
 * zstd -19 saves another ~3 points and is not worth the ceremony — `node:zlib` gzip is
 * built in and universal. 1000 games of raw JSON compresses to about 17 MB; `.rofl` replays
 * at 15 MB each are the only storage cost that actually matters.
 *
 * NODE-ONLY. Never import this from `src/web`.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from "node:fs"
import { gunzipSync, gzipSync } from "node:zlib"
import { createHash } from "node:crypto"
import { BLOBS_DIR, DATA_DIR } from "../shared/constants.ts"

/** The canonical blob names. Free-form names work too; these are what the pipeline writes. */
export const BLOB_MATCH = "match"
export const BLOB_TIMELINE = "timeline"
export const BLOB_LIVE = "live"
export const BLOB_DIGEST = "digest"

/** Absolute path of a blob. */
export const blobPath = (gameId: number, name: string): string =>
	`${BLOBS_DIR}/${gameId}/${name}.json.gz`

/** Path relative to DATA_DIR — this is what goes in the `game.*Blob` columns. */
export const blobRelPath = (gameId: number, name: string): string =>
	`blobs/${gameId}/${name}.json.gz`

/** Resolve a stored relative path back to an absolute one. */
export const resolveDataPath = (relPath: string): string => `${DATA_DIR}/${relPath}`

export const blobDir = (gameId: number): string => `${BLOBS_DIR}/${gameId}`

/**
 * Gzip `obj` as JSON and write it. Returns the DATA_DIR-relative path for the DB column.
 * Writes to a temp file and renames, so a crash mid-write cannot leave a truncated archive
 * that later reads as corrupt JSON.
 */
export const writeBlob = (gameId: number, name: string, obj: unknown): string => {
	mkdirSync(blobDir(gameId), { recursive: true })
	const target = blobPath(gameId, name)
	const tmp = `${target}.tmp`
	writeFileSync(tmp, gzipSync(Buffer.from(JSON.stringify(obj), "utf8")))
	// rename() within one directory is atomic on ext4.
	renameSync(tmp, target)
	return blobRelPath(gameId, name)
}

/**
 * Read a blob back. Returns `null` when the file is missing OR unreadable — a corrupt archive
 * is a re-fetch, not a crash. Callers that need to tell the two apart can use `hasBlob`.
 */
export const readBlob = <T = unknown>(gameId: number, name: string): T | null => {
	const path = blobPath(gameId, name)
	if (!existsSync(path)) return null
	try {
		return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as T
	} catch {
		return null
	}
}

export const hasBlob = (gameId: number, name: string): boolean =>
	existsSync(blobPath(gameId, name))

/** On-disk size in bytes, or 0 if absent. */
export const blobSize = (gameId: number, name: string): number => {
	const path = blobPath(gameId, name)
	if (!existsSync(path)) return 0
	try {
		return statSync(path).size
	} catch {
		return 0
	}
}

export const deleteBlob = (gameId: number, name: string): void => {
	rmSync(blobPath(gameId, name), { force: true })
}

/** Remove every blob for a game — part of deleting the game entirely. */
export const deleteGameBlobs = (gameId: number): void => {
	rmSync(blobDir(gameId), { recursive: true, force: true })
}

/** Names of the blobs present for a game, e.g. `["match", "timeline"]`. */
export const listBlobs = (gameId: number): string[] => {
	const dir = blobDir(gameId)
	if (!existsSync(dir)) return []
	try {
		return readdirSync(dir)
			.filter(f => f.endsWith(".json.gz"))
			.map(f => f.slice(0, -".json.gz".length))
	} catch {
		return []
	}
}

/* ------------------------------------------------------------------ NDJSON */

/**
 * Append-only telemetry. The in-game sampler writes one JSON object per line while the game
 * runs; the file is gzipped once at game end by `finalizeNdjson`. Keeping it plain while
 * open means a crash mid-game costs the last line, not the session.
 */
export const ndjsonPath = (gameId: number, name: string): string =>
	`${BLOBS_DIR}/${gameId}/${name}.ndjson`

export const ndjsonGzPath = (gameId: number, name: string): string =>
	`${BLOBS_DIR}/${gameId}/${name}.ndjson.gz`

export const appendNdjson = (gameId: number, name: string, obj: unknown): void => {
	mkdirSync(blobDir(gameId), { recursive: true })
	appendFileSync(ndjsonPath(gameId, name), `${JSON.stringify(obj)}\n`, "utf8")
}

/** Gzip the open NDJSON file and drop the plain one. Returns the relative path, or null. */
export const finalizeNdjson = (gameId: number, name: string): string | null => {
	const plain = ndjsonPath(gameId, name)
	if (!existsSync(plain)) return null
	const gz = ndjsonGzPath(gameId, name)
	writeFileSync(gz, gzipSync(readFileSync(plain)))
	rmSync(plain, { force: true })
	return `blobs/${gameId}/${name}.ndjson.gz`
}

/** Read every line of an NDJSON blob, gzipped or not. Bad lines are skipped, never thrown. */
export const readNdjson = <T = unknown>(gameId: number, name: string): T[] => {
	const gz = ndjsonGzPath(gameId, name)
	const plain = ndjsonPath(gameId, name)
	let text: string
	try {
		if (existsSync(gz)) text = gunzipSync(readFileSync(gz)).toString("utf8")
		else if (existsSync(plain)) text = readFileSync(plain, "utf8")
		else return []
	} catch {
		return []
	}
	const out: T[] = []
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue
		try {
			out.push(JSON.parse(line) as T)
		} catch {
			/* a torn final line from a crash; skip it */
		}
	}
	return out
}

/* -------------------------------------------------------------- integrity */

/**
 * `sha256(match bytes || timeline bytes)` — the content hash stored on `game`.
 *
 * Analysis re-runs when this changes, which is how a re-fetched or repaired blob invalidates
 * exactly the derived layer and nothing else. Missing blobs contribute nothing rather than
 * throwing, so a partially-ingested game still gets a stable (different) hash.
 */
export const contentHash = (gameId: number): string => {
	const hash = createHash("sha256")
	for (const name of [BLOB_MATCH, BLOB_TIMELINE]) {
		const path = blobPath(gameId, name)
		if (existsSync(path)) hash.update(readFileSync(path))
		else hash.update(`missing:${name}`)
	}
	return hash.digest("hex")
}

/** sha256 of an arbitrary string — used for `review.promptHash`. */
export const sha256 = (input: string): string =>
	createHash("sha256").update(input, "utf8").digest("hex")
