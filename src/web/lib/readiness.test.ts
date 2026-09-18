/**
 * The one behaviour worth pinning: UNKNOWN never renders as TODO.
 *
 * A cold load has no health, no games and no key status for a few hundred milliseconds. If
 * `firstRun` were computed as "no coached game found" rather than "a games list was read and had
 * none in it", every launch would open on a card telling a man with 153 stored games how to get
 * started — the exact "silence looks like breakage" failure this campaign keeps finding, pointed
 * at the returning user instead of the new one.
 */

import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import type { GameListItem } from "../../shared/schema/api.ts"
import { readiness } from "./readiness.ts"

const game = (frameMoments: number): GameListItem =>
	({ gameId: 1, frameMoments, hasReview: true, momentCount: 4, mediaCount: 0 }) as GameListItem

describe("readiness", () => {
	it("does not claim a first run before anything has been read", () => {
		const r = readiness({ clientReachable: null, games: null, voice: null })
		assert.equal(r.firstRun, false)
		assert.deepEqual(
			r.steps.map(s => s.state),
			["unknown", "unknown", "unknown"]
		)
		assert.equal(r.allDone, false)
	})

	it("calls it a first run only once a games list has been read and was empty", () => {
		assert.equal(readiness({ clientReachable: null, games: [], voice: null }).firstRun, true)
		// A library with games in it is NOT a first run, even when none of them was coached — that
		// version of the rule put the getting-started card on a 153-game install.
		assert.equal(readiness({ clientReachable: null, games: [game(0)], voice: null }).firstRun, false)
		assert.equal(readiness({ clientReachable: null, games: [game(3)], voice: null }).firstRun, false)
	})

	it("still reports the screen-share step honestly inside a library that has games", () => {
		const uncoached = readiness({ clientReachable: null, games: [game(0)], voice: null })
		assert.equal(uncoached.steps[2]!.state, "todo")
		assert.equal(uncoached.allDone, false)
	})

	it("separates a key that is missing from one Google refused", () => {
		const missing = readiness({ clientReachable: null, games: null, voice: { ok: false } })
		const refused = readiness({ clientReachable: null, games: null, voice: { ok: false, configured: true } })
		assert.equal(missing.steps[1]!.state, "todo")
		assert.equal(refused.steps[1]!.state, "todo")
		assert.match(refused.steps[1]!.detail, /refused/)
		assert.notEqual(missing.steps[1]!.detail, refused.steps[1]!.detail)
	})

	it("is done when the client is up, the key works and a game has been coached", () => {
		const r = readiness({
			clientReachable: true,
			games: [game(2)],
			voice: { ok: true, configured: true }
		})
		assert.equal(r.allDone, true)
		assert.equal(r.firstRun, false)
	})
})
