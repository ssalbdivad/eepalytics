/**
 * SQLite connection, migrations and the data directory.
 *
 * `node:sqlite` is built into Node 25 — no native build, no dependency. It emits
 * `ExperimentalWarning`, which every entry point silences with
 * `--no-warnings=ExperimentalWarning`.
 *
 * All application data lives on ext4 under `DATA_DIR`. Measured: SQLite transactional writes
 * are 26x slower on the `/mnt/c` 9p mount (992 ms vs 38 ms for 2000 inserts). `/mnt/c` is
 * read-only territory — we only read the lockfile and copy `.rofl` files out of it.
 *
 * NODE-ONLY. Never import this from `src/web`.
 */

import { DatabaseSync } from "node:sqlite"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
	BLOBS_DIR,
	DATA_DIR,
	DB_PATH,
	LOGS_DIR,
	MEDIA_DIR,
	REPLAYS_DIR,
	SCHEMA_VERSION
} from "../shared/constants.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, "migrations")

/** Ordered migration filenames. Add to this list; never edit a shipped file. */
const MIGRATIONS = ["001_init.sql", "002_chat.sql", "003_item_warnings.sql", "004_item_fix.sql", "005_item_priority.sql", "006_grade.sql", "007_watch.sql"] as const

/** Create DATA_DIR and its subdirectories. Idempotent, safe to call repeatedly. */
export const ensureDataDirs = (): void => {
	for (const dir of [DATA_DIR, BLOBS_DIR, MEDIA_DIR, REPLAYS_DIR, LOGS_DIR])
		mkdirSync(dir, { recursive: true })
}

/**
 * Open (creating if needed) the database at `path`, apply PRAGMAs, and run migrations.
 *
 * PRAGMAs, and why:
 *   journal_mode = WAL   readers (the HTTP server) never block the daemon's writes
 *   synchronous  = NORMAL safe under WAL, much faster than FULL
 *   foreign_keys = ON    ON DELETE CASCADE is load-bearing for pruning a game
 *   busy_timeout = 5000  the daemon and the HTTP server share the file
 */
export const openDb = (path: string = DB_PATH): DatabaseSync => {
	ensureDataDirs()
	mkdirSync(dirname(path), { recursive: true })

	const database = new DatabaseSync(path)
	// WAL is persistent per-file; the others are per-connection and must be set every time.
	database.exec("PRAGMA journal_mode = WAL")
	database.exec("PRAGMA synchronous = NORMAL")
	database.exec("PRAGMA foreign_keys = ON")
	database.exec("PRAGMA busy_timeout = 5000")

	migrate(database)
	return database
}

/**
 * Apply any migration whose index exceeds the recorded version, in one transaction each.
 * Idempotent: booting twice applies nothing the second time.
 *
 * Refuses to run when the file was written by a NEWER build — silently downgrading a schema
 * is how you lose data.
 */
export const migrate = (database: DatabaseSync): number => {
	database.exec(
		"CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, appliedMs INTEGER NOT NULL) STRICT"
	)
	const row = database
		.prepare("SELECT max(version) AS v FROM schema_version")
		.get() as { v: number | null } | undefined
	const current = row?.v ?? 0

	if (current > SCHEMA_VERSION)
		throw new Error(
			`Database schema is v${current} but this build only knows v${SCHEMA_VERSION}. ` +
				`Refusing to run — check out a newer build or move ${DB_PATH} aside.`
		)

	const now = Date.now()
	for (let i = current; i < MIGRATIONS.length; i++) {
		const name = MIGRATIONS[i]!
		const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8")
		database.exec("BEGIN")
		try {
			database.exec(sql)
			database
				.prepare("INSERT INTO schema_version (version, appliedMs) VALUES (?, ?)")
				.run(i + 1, now)
			database.exec("COMMIT")
		} catch (err) {
			database.exec("ROLLBACK")
			throw new Error(`Migration ${name} failed: ${(err as Error).message}`, {
				cause: err
			})
		}
	}
	return MIGRATIONS.length
}

let singleton: DatabaseSync | null = null

/**
 * The process-wide connection. Opened lazily on first use so that importing a query module
 * does not create a database as a side effect of, say, running `tsc`.
 */
export const getDb = (): DatabaseSync => {
	if (!singleton) singleton = openDb()
	return singleton
}

/**
 * The singleton, as a property. `db.prepare(...)` reads naturally at call sites and still
 * defers the open until the first statement.
 */
export const db: DatabaseSync = new Proxy({} as DatabaseSync, {
	get: (_t, prop, receiver) => {
		const real = getDb() as unknown as Record<PropertyKey, unknown>
		const value = Reflect.get(real, prop, receiver)
		return typeof value === "function" ? value.bind(real) : value
	}
})

/** Point the singleton at an already-open database — used by tests and by `:memory:` runs. */
export const useDb = (database: DatabaseSync): void => {
	singleton = database
}

/** Close the singleton, if one is open. Safe to call twice. */
export const closeDb = (): void => {
	if (singleton) {
		try {
			singleton.close()
		} catch {
			/* already closed */
		}
		singleton = null
	}
}

/**
 * Run `fn` inside a transaction, rolling back if it throws.
 *
 * Not reentrant — SQLite has no nested transactions. Callers that might already be inside
 * one should pass their work down instead of wrapping again.
 */
export const transact = <T>(fn: () => T, database: DatabaseSync = getDb()): T => {
	database.exec("BEGIN IMMEDIATE")
	try {
		const out = fn()
		database.exec("COMMIT")
		return out
	} catch (err) {
		try {
			database.exec("ROLLBACK")
		} catch {
			/* the transaction was already rolled back by SQLite */
		}
		throw err
	}
}

/** Whether the database file exists yet. Used by the doctor script. */
export const dbExists = (path: string = DB_PATH): boolean => existsSync(path)
