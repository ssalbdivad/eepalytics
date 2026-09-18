/**
 * Which socket the live coach opens, and the two ways that choice used to be impossible to get
 * wrong because it was impossible to make.
 *
 * ## Why these tests exist
 *
 * `GEMINI_LIVE_MODEL` was a constant for the whole life of this app, so the shipped path ran one
 * model — `gemini-3.1-flash-live-preview` — and it was never chosen, only inherited. On 2026-09-18
 * it was raced against the two newer sockets the same key serves and lost on both instruments that
 * matter: it is silent on 34 of 60 turns where `gemini-3.8-live` is silent on none, and blind-judged
 * it is 57% useful [44-68] against 77% [65-86]. The default moved and the box that chooses it was
 * unhidden, which turns one constant into a value that arrives from settings and can be malformed.
 *
 * So the two things pinned here are the two ways that goes wrong quietly:
 *
 *   - a blank box must mean the MEASURED default and never an empty model id, which the endpoint
 *     answers with a socket close rather than a readable error;
 *   - `gemini-3.8-live` and `models/gemini-3.8-live` are the same model and only the second one
 *     connects, so a person typing the name he reads in a changelog must not get silence.
 *
 * Run: pnpm test
 */

import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

/* DATA_DIR is read at module-eval time; the key path must not be this machine's real one. */
const dir = mkdtempSync(join(tmpdir(), "eepalytics-socket-model-"))
process.env.EEPALYTICS_DATA_DIR = dir
after(() => rmSync(dir, { recursive: true, force: true }))

const { GEMINI_LIVE_MODEL, GEMINI_LIVE_MODELS, resolveSocketModel } = await import("./gemini-live.ts")

describe("resolveSocketModel", () => {
	it("a blank box is the measured default, not an empty model id", () => {
		assert.equal(resolveSocketModel(""), GEMINI_LIVE_MODEL)
		assert.equal(resolveSocketModel("   "), GEMINI_LIVE_MODEL)
		assert.equal(resolveSocketModel(null), GEMINI_LIVE_MODEL)
		assert.equal(resolveSocketModel(undefined), GEMINI_LIVE_MODEL)
	})

	it("prefixes a bare name, because only the prefixed form connects", () => {
		assert.equal(resolveSocketModel("gemini-3.8-live"), "models/gemini-3.8-live")
		assert.equal(resolveSocketModel("  gemini-3.8-live  "), "models/gemini-3.8-live")
	})

	it("leaves a fully qualified id alone, including one nobody here has heard of", () => {
		assert.equal(resolveSocketModel("models/gemini-9-live"), "models/gemini-9-live")
	})
})

describe("the offered socket ids", () => {
	it("the default is one of them, and it is the one at the top", () => {
		assert.equal(GEMINI_LIVE_MODELS[0]?.id, GEMINI_LIVE_MODEL)
	})

	it("the model that shipped for a year is still offered, because a default is not a deletion", () => {
		/*
		 * It is worse on both measurements and it stays selectable anyway. Every stored socket run
		 * in `data/eval/` was taken on it, and a measurement is only re-derivable while the thing
		 * it measured can still be pointed at.
		 */
		assert.ok(
			GEMINI_LIVE_MODELS.some(m => m.id === "models/gemini-3.1-flash-live-preview"),
			"the incumbent must stay reachable or its stored runs stop being reproducible"
		)
	})

	it("every suggestion is fully qualified, so picking one from the list cannot fail", () => {
		for (const m of GEMINI_LIVE_MODELS) assert.equal(resolveSocketModel(m.id), m.id)
	})
})
