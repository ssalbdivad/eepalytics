/**
 * `PUT /api/settings` must persist ONLY the keys the patch carried.
 *
 * It used to write the whole merged object. Because `getSettings()` reads the table over
 * `DEFAULT_SETTINGS`, that turned every save into a permanent freeze of every field: one
 * changed slider wrote seventeen rows, and from then on this install could never follow a code
 * default again. That is not a theory — the author's settings table holds seventeen rows with
 * one identical `updatedMs`, among them the `autoReviewNewGames: false` that switched the
 * post-game review path off for eight days while the schema, the code default and the README
 * all still read `true`.
 *
 * The test is written against the STORED ROWS rather than the response, because the response
 * was always correct. The whole failure lived in what was left behind on disk.
 *
 * Run: pnpm test
 */

import { strict as assert } from "node:assert"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, it } from "node:test"
import { closeDb, migrate, useDb } from "../../db/index.ts"
import { getSettings } from "../../db/queries.ts"
import { DEFAULT_SETTINGS } from "../../shared/schema/settings.ts"
import { createSettingsRoutes } from "./settings.ts"
import type { ServerDeps } from "../deps.ts"

let db: DatabaseSync

const storedKeys = (): string[] =>
	(db.prepare("SELECT key FROM settings ORDER BY key").all() as { key: string }[]).map(r => r.key)

const put = async (body: unknown): Promise<Response> => {
	const app = createSettingsRoutes({} as ServerDeps)
	return app.request("/settings", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	})
}

beforeEach(() => {
	db = new DatabaseSync(":memory:")
	migrate(db)
	useDb(db)
})

afterEach(() => {
	closeDb()
})

describe("PUT /api/settings", () => {
	it("writes one row for a one-field patch, and leaves the rest following the defaults", async () => {
		const res = await put({ coachIntensity: 0.9 })
		assert.equal(res.status, 200)

		assert.deepEqual(storedKeys(), ["coachIntensity"])
		// Everything else still reads through to the code default rather than a frozen copy.
		assert.equal(getSettings().autoReviewNewGames, DEFAULT_SETTINGS.autoReviewNewGames)
		assert.equal(getSettings().coachIntensity, 0.9)
	})

	it("a save of an unrelated field cannot switch the review path off", async () => {
		// The exact 2026-09-04 shape: one deliberate change, sixteen fields dragged along.
		await put({ model: "claude-opus-5" })
		assert.deepEqual(storedKeys(), ["model"])
		assert.equal(getSettings().autoReviewNewGames, true)
	})

	it("still stores a field the user really did turn off", async () => {
		// Only the checkbox writes the checkbox. Turning it off is legitimate and must stick.
		await put({ autoReviewNewGames: false })
		assert.deepEqual(storedKeys(), ["autoReviewNewGames"])
		assert.equal(getSettings().autoReviewNewGames, false)
	})

	it("clamps against the merged view, then persists only the touched key", async () => {
		// `pollInGameMs` clamps to a 500 floor. The clamp needs the whole object to run; the
		// WRITE must not inherit the rest of it.
		await put({ pollInGameMs: 0 })
		assert.deepEqual(storedKeys(), ["pollInGameMs"])
		assert.equal(getSettings().pollInGameMs, 500)
	})
})

describe("migration 009 — the rows that were never a choice", () => {
	it("leaves a fresh database with no settings rows at all", () => {
		// A new install must start entirely on the code defaults, so that shipping a changed
		// default actually changes something.
		assert.deepEqual(storedKeys(), [])
		assert.equal(getSettings().autoReviewNewGames, true)
	})
})
