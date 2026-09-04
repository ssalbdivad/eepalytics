/**
 * The migration list and `SCHEMA_VERSION` must move together, and this test exists because they
 * are easy to move apart.
 *
 * `migrate()` throws when the database's recorded version exceeds `SCHEMA_VERSION`, so adding a
 * migration file without bumping the constant does not fail at review or on the first run — it
 * applies the migration, records v8, and then **bricks the daemon on the next boot**, in an
 * environment where the user has already gone to bed. Two independent adversarial reviews of the
 * rewrite design flagged this same landmine, from two different directions.
 *
 * A file on disk that is not in the list is the other half: it looks applied and never runs.
 */

import { ok, strictEqual } from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { SCHEMA_VERSION } from "../shared/constants.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, "migrations")

/** The literal array in db/index.ts, read as text — importing it would need the module's side effects. */
const listedMigrations = (): string[] => {
	const src = readFileSync(join(HERE, "index.ts"), "utf8")
	const line = /const MIGRATIONS = \[([^\]]*)\]/.exec(src)
	ok(line, "could not find the MIGRATIONS array in db/index.ts")
	return [...line![1]!.matchAll(/"([^"]+)"/g)].map(m => m[1]!)
}

describe("migrations", () => {
	it("has exactly as many migrations as SCHEMA_VERSION claims", () => {
		const listed = listedMigrations()
		strictEqual(
			listed.length,
			SCHEMA_VERSION,
			`SCHEMA_VERSION is ${SCHEMA_VERSION} but ${listed.length} migrations are listed. ` +
				"These must move together or the daemon throws on its SECOND boot."
		)
	})

	it("lists every .sql file on disk, in order", () => {
		const onDisk = readdirSync(MIGRATIONS_DIR)
			.filter(f => f.endsWith(".sql"))
			.sort()
		const listed = listedMigrations()
		strictEqual(
			listed.join(","),
			onDisk.join(","),
			"a migration file exists that db/index.ts does not run, or vice versa"
		)
	})

	it("numbers them contiguously from 001", () => {
		listedMigrations().forEach((name, i) => {
			strictEqual(
				name.slice(0, 3),
				String(i + 1).padStart(3, "0"),
				`migration ${i + 1} is named ${name} — the order is the version`
			)
		})
	})
})
