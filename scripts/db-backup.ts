/**
 * `pnpm db:backup` — take a verified snapshot of the library right now.
 *
 * The daemon does this on a timer; this is the form you run before doing something frightening,
 * like a migration or a schema change. It always writes (no interval test) and it prints what it
 * verified, because a backup you did not read back is a hope. See `src/db/backup.ts`.
 */

import { backupDatabase, describeBackup, listBackups } from "../src/db/backup.ts"

const report = backupDatabase({ force: true })
console.log(describeBackup(report))
if (report.ok) {
	console.log("\nkept:")
	for (const b of listBackups())
		console.log(`  ${new Date(b.atMs).toISOString().slice(0, 19).replace("T", " ")}  ${(b.bytes / 1024 / 1024).toFixed(1)} MB  ${b.path}`)
}
process.exit(report.ok ? 0 : 1)
