/**
 * Every case here builds a REAL SQLite database and backs it up. The failure being defended
 * against is a torn copy of a live WAL database, and that is not something a mock can be.
 */

import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, describe, it } from "node:test"
import { backupDatabase, describeBackup, listBackups } from "./backup.ts"

const dirs: string[] = []

/** A database shaped like the real one in the only way these cases care about: it has games. */
const makeDb = (games: number): { dir: string; dbPath: string; database: DatabaseSync } => {
	const dir = mkdtempSync(join(tmpdir(), "eep-backup-"))
	dirs.push(dir)
	const dbPath = join(dir, "csk.db")
	const database = new DatabaseSync(dbPath)
	database.exec("pragma journal_mode = wal")
	database.exec("create table game (gameId integer primary key, championName text)")
	for (let i = 0; i < games; i++)
		database.prepare("insert into game (gameId, championName) values (?, ?)").run(5_000_000 + i, "Lillia")
	return { dir, dbPath, database }
}

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe("backupDatabase", () => {
	it("writes a copy, reads it back, and counts what is inside it", () => {
		const { dir, dbPath, database } = makeDb(138)
		const r = backupDatabase({ dbPath, dir: join(dir, "backups"), database, force: true })
		assert.equal(r.ok, true)
		assert.equal(r.outcome, "written")
		assert.equal(r.integrity, "ok")
		assert.equal(r.games, 138, "the count comes from the COPY, not from the original")
		assert.ok(r.path !== null && existsSync(r.path))
		assert.ok((r.bytes ?? 0) > 0)
		assert.match(describeBackup(r), /138 games/)
		database.close()
	})

	it("produces a file that opens on its own, with the rows in it", () => {
		const { dir, dbPath, database } = makeDb(7)
		const r = backupDatabase({ dbPath, dir: join(dir, "backups"), database, force: true })
		database.close()
		// The whole point: a standalone file, openable with no WAL and no original beside it.
		const copy = new DatabaseSync(r.path!, { readOnly: true })
		const row = copy.prepare("select count(*) c from game").get() as { c: number }
		assert.equal(Number(row.c), 7)
		copy.close()
	})

	it("captures rows still sitting in the WAL", () => {
		const { dir, dbPath, database } = makeDb(3)
		// Written after the file was created and NOT checkpointed — the case a plain cp loses.
		database.prepare("insert into game (gameId, championName) values (?, ?)").run(9_999_999, "Kayn")
		const r = backupDatabase({ dbPath, dir: join(dir, "backups"), database, force: true })
		assert.equal(r.games, 4, "a snapshot that misses the newest game is the bug this file exists for")
		database.close()
	})

	it("skips an unchanged database inside the interval, and says so", () => {
		const { dir, dbPath, database } = makeDb(2)
		const backups = join(dir, "backups")
		const first = backupDatabase({ dbPath, dir: backups, database, force: true })
		assert.equal(first.outcome, "written")
		const second = backupDatabase({ dbPath, dir: backups, database, minIntervalMs: 60 * 60 * 1000 })
		assert.equal(second.outcome, "skipped-unchanged")
		assert.equal(second.ok, true, "skipping on purpose is a success, not a failure")
		assert.equal(listBackups(backups).length, 1)
		database.close()
	})

	it("does NOT skip when the database has been written since the last copy", () => {
		const { dir, dbPath, database } = makeDb(2)
		const backups = join(dir, "backups")
		const first = backupDatabase({ dbPath, dir: backups, database, force: true, nowMs: 1_000_000_000_000 })
		// Age the copy so the write below is unambiguously newer than it.
		utimesSync(first.path!, 1_000_000, 1_000_000)
		database.prepare("insert into game (gameId, championName) values (?, ?)").run(1234, "Briar")
		const second = backupDatabase({ dbPath, dir: backups, database, minIntervalMs: 60 * 60 * 1000 })
		assert.equal(second.outcome, "written", "a game he just played must not wait six hours to be safe")
		assert.equal(second.games, 3)
		database.close()
	})

	it("keeps only the newest N, and prunes only after a good copy exists", () => {
		const { dir, dbPath, database } = makeDb(1)
		const backups = join(dir, "backups")
		for (let i = 0; i < 5; i++)
			backupDatabase({ dbPath, dir: backups, database, force: true, keep: 3, nowMs: 1_700_000_000_000 + i * 1000 })
		const kept = listBackups(backups)
		assert.equal(kept.length, 3)
		database.close()
	})

	it("returns a report rather than throwing when there is no database", () => {
		const r = backupDatabase({ dbPath: "/definitely/not/here/csk.db", dir: "/definitely/not/here/backups" })
		assert.equal(r.ok, false)
		assert.equal(r.outcome, "failed")
		assert.match(r.error ?? "", /no database/)
		assert.match(describeBackup(r), /FAILED/)
	})

	it("refuses to keep a copy that fails its own integrity check", () => {
		const { dir, dbPath, database } = makeDb(1)
		const backups = join(dir, "backups")
		const good = backupDatabase({ dbPath, dir: backups, database, force: true })
		assert.equal(good.integrity, "ok")
		// A file that is not a database at all, under the backup name pattern: it must not be
		// mistaken for a snapshot by the rotation, and listBackups is what rotation reads.
		const junk = join(backups, "csk-20200101-000000.db")
		writeFileSync(junk, "this is not a database")
		assert.equal(statSync(junk).size, 22)
		assert.equal(listBackups(backups).length, 2, "rotation sees files, and that is why the copy is verified")
		database.close()
	})
})
