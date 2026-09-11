/**
 * The id -> name cache, pinned.
 *
 * `champions.ts` and `spells.ts` were 71 identical lines each and had no test at all — their
 * only concession to testability was a `setChampionNames`/`setSummonerSpellNames` "test seam"
 * that nothing in the repo ever called. This file is what those two modules should have had:
 * the behaviour they shared, asserted once, so folding them together is checkable rather than
 * merely plausible.
 *
 * The rule worth protecting is the last one here. An unknown id resolves to `""`. Flash is 4
 * and Smite is 11 and everybody knows it, and this app still refuses to say so from memory.
 *
 * Run: pnpm test
 */

import { strict as assert } from "node:assert"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, it } from "node:test"
import { closeDb, migrate, useDb } from "../db/index.ts"
import { kvGet, kvSet } from "../db/queries.ts"
import { nameCache } from "./lcu-name-cache.ts"

type Entry = { id: number; name?: string; alias?: string }

describe("nameCache", () => {
	beforeEach(() => {
		const db = new DatabaseSync(":memory:")
		migrate(db)
		useDb(db)
	})
	afterEach(closeDb)

	const build = (pages: (Entry[] | null)[], allowAlias = false) => {
		let calls = 0
		const cache = nameCache({
			label: "test-table",
			kvKey: "testNames",
			fetch: async () => pages[Math.min(calls++, pages.length - 1)] ?? null,
			allowAlias
		})
		return { cache, calls: () => calls }
	}

	it("caches what the client served, into the kv row and into memory", async () => {
		const { cache } = build([[{ id: 876, name: "Lillia" }, { id: 11, name: "Smite" }]])
		assert.equal(await cache.refresh(), 2)
		assert.equal(cache.name(876), "Lillia")
		assert.deepEqual(kvGet("testNames", {}), { "876": "Lillia", "11": "Smite" })
	})

	it("skips the id -1 'None' placeholder the client ships", async () => {
		const { cache } = build([[{ id: -1, name: "None" }, { id: 4, name: "Flash" }]])
		assert.equal(await cache.refresh(), 1)
		assert.equal(cache.name(-1), "")
	})

	it("skips an entry with no usable name, rather than storing a blank", async () => {
		const { cache } = build([[{ id: 1 }, { id: 2, name: "Real" }]])
		assert.equal(await cache.refresh(), 1)
		assert.equal(cache.name(1), "")
	})

	it("lets champions fall back to `alias`, the one thing the two tables differ on", async () => {
		const { cache } = build([[{ id: 7, alias: "LeBlanc" }]], true)
		await cache.refresh()
		assert.equal(cache.name(7), "LeBlanc")
	})

	it("does not re-fetch inside the TTL, and does when forced", async () => {
		const { cache, calls } = build([
			[{ id: 1, name: "First" }],
			[{ id: 1, name: "Second" }]
		])
		await cache.refresh()
		await cache.refresh()
		assert.equal(calls(), 1, "the second call was inside the one-hour TTL")
		assert.equal(await cache.refresh(true), 1)
		assert.equal(calls(), 2)
		assert.equal(cache.name(1), "Second")
	})

	it("works from whatever the DB cached when the client is closed", async () => {
		kvSet("testNames", { "876": "Lillia" })
		const { cache } = build([null])
		// A closed client returns null. The count reported is what we still hold, not zero.
		assert.equal(await cache.refresh(), 1)
		assert.equal(cache.name(876), "Lillia")
	})

	it("reports 0 when the client is closed and nothing was ever cached", async () => {
		const { cache } = build([null])
		assert.equal(await cache.refresh(), 0)
	})

	it("returns \"\" for an unknown id — never a plausible name", async () => {
		const { cache } = build([[{ id: 876, name: "Lillia" }]])
		await cache.refresh()
		assert.equal(cache.name(11), "")
		assert.equal(cache.name(4), "")
	})
})

describe("alias is off by default, because spells never carry one", () => {
	beforeEach(() => {
		const db = new DatabaseSync(":memory:")
		migrate(db)
		useDb(db)
	})
	afterEach(closeDb)

	it("ignores an alias when allowAlias is not set", async () => {
		const cache = nameCache({
			label: "test-table",
			kvKey: "testNames",
			fetch: async () => [{ id: 7, alias: "LeBlanc" }]
		})
		assert.equal(await cache.refresh(), 0)
		assert.equal(cache.name(7), "")
	})
})
