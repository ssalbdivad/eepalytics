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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { gunzipSync, gzipSync } from "node:zlib"
import { createHash } from "node:crypto"
import { BLOBS_DIR, DATA_DIR } from "../shared/constants.ts"

/** The canonical blob names. Free-form names work too; these are what the pipeline writes. */
export const BLOB_MATCH = "match"
export const BLOB_TIMELINE = "timeline"
/**
 * The digest as it was actually SENT to the coach, written by `review-game`.
 *
 * This is the only digest archived, and it is archived at SEND time on purpose. Baselines are a
 * rolling window over recent games, so a digest rebuilt later is not the one the review was
 * written against — auditing a stored review against a fresh build reports correct quotes as
 * violations. Keeping the sent bytes is what makes that audit sound.
 *
 * Games analysed before 2026-09 also have a `digest.json.gz` beside this one, from a second
 * digest builder that nothing ever read back. It is not written any more; old copies are inert.
 */
export const BLOB_REVIEW_DIGEST = "review-digest"

/**
 * The post-game pack as it was SENT, written by `review-game` beside the digest.
 *
 * Same reasoning as the digest: the pack is rebuildable from the timeline, which does not move,
 * but the JOURNAL does — frames are pruned by retention, and `journal_frame.path` rows already
 * point at a directory this install renamed away from. Archiving the sent bytes is what lets the
 * debrief screen render the exact evidence the coach was holding, months later, without a rebuild
 * that might quietly differ. Cheap: 10 KB of text, gzipped, per game.
 */
export const BLOB_GAME_PACK = "game-pack"

/** Absolute path of a blob. */
export const blobPath = (gameId: number, name: string): string =>
	`${BLOBS_DIR}/${gameId}/${name}.json.gz`

/** Path relative to DATA_DIR — this is what goes in the `game.*Blob` columns. */
const blobRelPath = (gameId: number, name: string): string =>
	`blobs/${gameId}/${name}.json.gz`

/** Resolve a stored relative path back to an absolute one. */
export const resolveDataPath = (relPath: string): string => `${DATA_DIR}/${relPath}`

const blobDir = (gameId: number): string => `${BLOBS_DIR}/${gameId}`

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
