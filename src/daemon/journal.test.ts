/**
 * `resolveJournalPath` — the read-side forgiveness for stored frame paths.
 *
 * `journal_frame.path` is absolute, unlike every other stored path in this app, so renaming the
 * install directory orphaned 503 of 2591 real frames: the JPEGs were all still on disk and
 * `GET /api/frames/:id` answered 403 for every one, because the stored path pointed outside the
 * data directory and that is precisely what the containment check refuses.
 */

import assert from "node:assert/strict"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { describe, it } from "node:test"
import { JOURNAL_DIR, resolveJournalPath } from "./journal.ts"

const realFrame = (session: string, name: string): string => {
	mkdirSync(`${JOURNAL_DIR}/${session}`, { recursive: true })
	const p = `${JOURNAL_DIR}/${session}/${name}`
	writeFileSync(p, "jpeg")
	return p
}

describe("resolveJournalPath", () => {
	it("returns a path that still exists untouched", () => {
		const p = realFrame("js-test-live", "a.jpg")
		assert.equal(resolveJournalPath(p), p)
		rmSync(`${JOURNAL_DIR}/js-test-live`, { recursive: true, force: true })
	})

	it("rebases a path written under a previous install directory", () => {
		const p = realFrame("js-test-moved", "b.jpg")
		// exactly the shape left behind by the rename: same session and filename, old root.
		const stored = "/home/ssalb/coachskaffur/data/journal/js-test-moved/b.jpg"
		assert.equal(resolveJournalPath(stored), p)
		rmSync(`${JOURNAL_DIR}/js-test-moved`, { recursive: true, force: true })
	})

	it("returns the stored path unchanged when the file is genuinely gone", () => {
		const stored = "/home/ssalb/coachskaffur/data/journal/js-test-absent/c.jpg"
		// Not invented into something that exists — a deleted frame must stay a miss, so the
		// route 404s honestly rather than serving some other session's picture.
		assert.equal(resolveJournalPath(stored), stored)
	})

	it("leaves a path with no journal segment alone, so the caller still refuses it", () => {
		assert.equal(resolveJournalPath("/etc/passwd"), "/etc/passwd")
	})

	it("does not rebase a traversal that would escape the journal directory", () => {
		const stored = "/tmp/journal/../../etc/shadow"
		const out = resolveJournalPath(stored)
		// Whatever it returns must not resolve to a readable file outside the journal; the
		// containment check in the route is the real guard, this only must not help it along.
		assert.ok(!out.startsWith("/etc/"))
	})
})
