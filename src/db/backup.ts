/**
 * THE ONE FILE IN THIS APP THAT CANNOT BE REBUILT.
 *
 * ## Why a backup is not optional here
 *
 * Everything else under `data/` can be produced again: `.rofl` files expire anyway, media is drawn
 * from the timeline, the champion corpus is a pure function of (patch, cache), live samples are a
 * recording of a game that is over. `csk.db` is not like them. Riot's match history endpoint
 * silently ignores `begIndex`/`endIndex` and answers with a server-chosen window of about twenty
 * games — AGENTS.md records that as measured — so the library in this file was harvested
 * incrementally over months and **the games that have fallen out of that window cannot be fetched
 * again by anyone**. `scripts/what-wins.ts` reads 138 ranked games out of it; roughly a hundred of
 * those no longer exist upstream. Every review, every graded moment and every baseline he is
 * coached against is derived from it.
 *
 * On 2026-09-22 that file was 27 MB with a 4 MB WAL beside it, on a WSL2 ext4 volume, with no copy
 * anywhere. A single bad shutdown mid-checkpoint is not the likely failure — SQLite is good at
 * that — but "unlikely" is not a backup, and the cost of being wrong is the entire history this
 * app exists to measure.
 *
 * ## VACUUM INTO, not a file copy
 *
 * The database runs in WAL mode with a live writer, so `cp csk.db backup.db` copies a file whose
 * newest committed rows live in `csk.db-wal` and may tear mid-write. `VACUUM INTO` is SQLite's own
 * answer: it takes a read transaction, writes a fresh, fully checkpointed, defragmented database
 * to a new path, and never touches the original. It is also the only form that produces a single
 * self-contained file — which matters, because a backup nobody can open with `sqlite3 file.db` is
 * a backup nobody will use at three in the morning.
 *
 * The copy is then OPENED AND CHECKED. A backup that was never read back is a hope, not a
 * measurement: `PRAGMA integrity_check` plus a row count off the `game` table proves the bytes are
 * a database and that the thing worth keeping is inside it.
 *
 * ## It is cheap, and it declines to run when it would be pointless
 *
 * A 27 MB vacuum is well under a second on this disk, but it is pure waste when nothing has
 * changed. So a backup is skipped when the newest one is younger than `minIntervalMs` AND the
 * database has not been written since that backup was taken. He plays in bursts; most hours have
 * nothing new in them.
 *
 * ## It never throws
 *
 * Every path returns a report. A daemon that dies because a backup failed has turned a redundancy
 * feature into an outage, which is the exact inversion this file is written to avoid.
 *
 * NODE ONLY.
 */

import { DatabaseSync } from "node:sqlite"
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { DATA_DIR, DB_PATH } from "../shared/constants.ts"
import { getDb } from "./index.ts"

/** Where snapshots live. Beside the data it protects, because a backup on another disk is a lie. */
export const BACKUP_DIR = `${DATA_DIR}/backups`

/** `csk-20260922-193000.db` — sortable, obvious, and safe on every filesystem this runs on. */
const BACKUP_PREFIX = "csk-"
const BACKUP_SUFFIX = ".db"

/**
 * How many to keep.
 *
 * Seven is chosen against the failure it defends: silent corruption noticed late. One snapshot
 * only protects against a crash; a week of them protects against "the reviews have looked wrong
 * since Tuesday". At 27 MB a copy that is about 190 MB, on a volume with 51 GB free.
 */
export const KEEP_BACKUPS = 7

/** Do not re-snapshot an unchanged database more often than this. */
export const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * A FLOOR THAT HOLDS EVEN WHEN THE DATABASE HAS CHANGED, and it exists because of what running
 * this feature looked like.
 *
 * The daemon snapshots at startup. The WAL is touched by almost anything, so the "nothing has
 * changed" test is nearly always false on a machine that is up — which meant three restarts inside
 * two minutes on 2026-09-22 wrote three 25 MB copies (192833, 193008, 193019). Rotation bounds the
 * disk at seven, so this was never dangerous; it was pointless, and a crash-looping daemon under
 * `Restart=always` would have spent 150 MB of writes saying the same thing six times.
 *
 * Ten minutes is chosen against what a snapshot is FOR: it protects a library that changes when a
 * game ends, and no two games end ten minutes apart. Nothing a person could lose in that window
 * exists yet. `force` still overrides it, which is what `pnpm db:backup` passes.
 */
export const MIN_AGE_MS = 10 * 60 * 1000

export interface BackupReport {
	ok: boolean
	/** `written` | `skipped-unchanged` | `failed` — a state, never an exception. */
	outcome: "written" | "skipped-unchanged" | "failed"
	path: string | null
	bytes: number | null
	/** Rows in `game` inside the COPY, read back after writing it. */
	games: number | null
	integrity: string | null
	prunedOlder: number
	ms: number
	error: string | null
}

const stamp = (nowMs: number): string => {
	const d = new Date(nowMs)
	const p = (n: number, w = 2): string => String(n).padStart(w, "0")
	return (
		`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
		`-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
	)
}

/** Existing snapshots, newest first. Anything not matching the pattern is somebody else's file. */
export const listBackups = (dir: string = BACKUP_DIR): { path: string; atMs: number; bytes: number }[] => {
	try {
		return readdirSync(dir)
			.filter(n => n.startsWith(BACKUP_PREFIX) && n.endsWith(BACKUP_SUFFIX))
			.map(n => {
				const path = join(dir, n)
				const st = statSync(path)
				return { path, atMs: st.mtimeMs, bytes: st.size }
			})
			.sort((a, b) => b.atMs - a.atMs)
	} catch {
		return []
	}
}

/**
 * The newest write to the database itself, WAL included.
 *
 * The WAL is where a recent commit lives until a checkpoint moves it, so a change test that looks
 * only at `csk.db` reports "unchanged" through an entire evening of play.
 */
const dbTouchedMs = (dbPath: string): number => {
	let newest = 0
	for (const suffix of ["", "-wal"]) {
		try {
			newest = Math.max(newest, statSync(`${dbPath}${suffix}`).mtimeMs)
		} catch {
			/* no WAL is a normal state */
		}
	}
	return newest
}

export interface BackupOptions {
	dbPath?: string
	dir?: string
	keep?: number
	minIntervalMs?: number
	/** Never re-snapshot below this age, changed or not. See `MIN_AGE_MS`. */
	minAgeMs?: number
	/** Skip the "has anything changed" test. The CLI passes this; the timer never does. */
	force?: boolean
	nowMs?: number
	/** Test seam: the live handle, so a test can back up a database it made itself. */
	database?: DatabaseSync
}

/**
 * Take one snapshot, verify it, and drop the oldest beyond `keep`.
 *
 * Pruning happens AFTER the new copy has been written and read back, so a failure can never leave
 * fewer backups than it started with.
 */
export const backupDatabase = (opts: BackupOptions = {}): BackupReport => {
	const started = Date.now()
	const dbPath = resolve(opts.dbPath ?? DB_PATH)
	const dir = resolve(opts.dir ?? BACKUP_DIR)
	const keep = opts.keep ?? KEEP_BACKUPS
	const nowMs = opts.nowMs ?? started
	const base: BackupReport = {
		ok: false,
		outcome: "failed",
		path: null,
		bytes: null,
		games: null,
		integrity: null,
		prunedOlder: 0,
		ms: 0,
		error: null
	}

	try {
		if (!existsSync(dbPath))
			return { ...base, error: `no database at ${dbPath}`, ms: Date.now() - started }

		mkdirSync(dir, { recursive: true })
		const existing = listBackups(dir)
		const newest = existing[0]
		const age = newest ? nowMs - newest.atMs : Number.POSITIVE_INFINITY
		if (
			!opts.force &&
			newest &&
			(age < (opts.minAgeMs ?? MIN_AGE_MS) ||
				(age < (opts.minIntervalMs ?? MIN_INTERVAL_MS) && dbTouchedMs(dbPath) <= newest.atMs))
		)
			return {
				...base,
				ok: true,
				outcome: "skipped-unchanged",
				path: newest.path,
				bytes: newest.bytes,
				ms: Date.now() - started
			}

		const out = join(dir, `${BACKUP_PREFIX}${stamp(nowMs)}${BACKUP_SUFFIX}`)
		if (existsSync(out)) rmSync(out, { force: true })

		/*
		 * The parameter is a PATH, and SQLite takes it as a string literal rather than a binding,
		 * so it is quoted here. The name is generated from a clock and a fixed prefix and contains
		 * no quote characters by construction; the replace is belt and braces against a future
		 * caller passing a directory with one in it.
		 */
		const database = opts.database ?? getDb()
		database.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`)

		/* ---- read the copy back; a backup nobody opened is not a backup ---- */
		const copy = new DatabaseSync(out, { readOnly: true })
		let integrity = "unknown"
		let games: number | null = null
		try {
			const row = copy.prepare("PRAGMA integrity_check").get() as Record<string, string> | undefined
			integrity = row ? String(Object.values(row)[0] ?? "unknown") : "unknown"
			const count = copy.prepare("select count(*) c from game").get() as { c: number } | undefined
			games = count ? Number(count.c) : null
		} finally {
			copy.close()
		}

		if (integrity !== "ok") {
			rmSync(out, { force: true })
			return {
				...base,
				error: `the copy failed its own integrity check (${integrity}); it was deleted rather than kept`,
				ms: Date.now() - started
			}
		}

		/* ---- rotate, only now that a good copy exists ---- */
		let prunedOlder = 0
		for (const old of listBackups(dir).slice(keep)) {
			try {
				rmSync(old.path, { force: true })
				prunedOlder++
			} catch {
				/* a file we cannot delete is not a reason to fail a backup that succeeded */
			}
		}

		return {
			ok: true,
			outcome: "written",
			path: out,
			bytes: statSync(out).size,
			games,
			integrity,
			prunedOlder,
			ms: Date.now() - started,
			error: null
		}
	} catch (err) {
		return { ...base, error: (err as Error).message, ms: Date.now() - started }
	}
}

/** One line for the journal. Says what happened and what is now protected. */
export const describeBackup = (r: BackupReport): string => {
	if (r.outcome === "skipped-unchanged") return `database backup skipped: nothing written since ${r.path}`
	if (r.outcome === "failed") return `database backup FAILED: ${r.error}`
	const mb = r.bytes === null ? "?" : (r.bytes / 1024 / 1024).toFixed(1)
	return (
		`database backed up to ${r.path} — ${mb} MB, ${r.games} games, integrity ${r.integrity}, ` +
		`${r.prunedOlder} older copies pruned, ${r.ms}ms`
	)
}
