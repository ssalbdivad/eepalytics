/**
 * The turn-based path is the one that runs during a game against a provider that may be slow,
 * rate-limited or misconfigured. Its contract is therefore mostly about FAILING quietly: a coach
 * that throws during a teamfight is worse than one that says nothing.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { runCoachTurn } from "./turnCoach.ts"

const original = globalThis.fetch
afterEach(() => {
	globalThis.fetch = original
})

const stub = (impl: (url: string, init: RequestInit) => unknown): void => {
	globalThis.fetch = (async (url: string, init: RequestInit) => ({
		json: async () => impl(url, init)
	})) as unknown as typeof fetch
}

describe("runCoachTurn", () => {
	it("posts the provider, model, frame and block", async () => {
		let seen: Record<string, unknown> = {}
		stub((_url, init) => {
			seen = JSON.parse(String(init.body))
			return { ok: true, text: "go", model: "m", frameSent: true, latencyMs: 1 }
		})
		await runCoachTurn({ provider: "openai", model: "gpt-5", frame: "abc", block: "BLOCK" })
		deepStrictEqual(seen, { provider: "openai", model: "gpt-5", frame: "abc", block: "BLOCK" })
	})

	it("omits the frame rather than sending an empty one", async () => {
		// A "vision" run whose picture never arrived is a different experiment, and the daemon
		// reports `frameSent` so a benchmark can tell them apart. Sending "" would defeat that.
		let seen: Record<string, unknown> = {}
		stub((_url, init) => {
			seen = JSON.parse(String(init.body))
			return { ok: true, text: "", model: "m", frameSent: false, latencyMs: 1 }
		})
		await runCoachTurn({ provider: "openai", model: "", frame: null, block: "B" })
		strictEqual("frame" in seen, false)
	})

	it("returns a failed result instead of throwing when the request dies", async () => {
		// This runs on a timer during a live game. An exception here would break the loop for the
		// rest of the match; a failed turn costs one sentence.
		globalThis.fetch = (async () => {
			throw new Error("network down")
		}) as unknown as typeof fetch
		const r = await runCoachTurn({ provider: "openai", model: "", frame: null, block: "B" })
		strictEqual(r.ok, false)
		strictEqual(r.text, "")
		strictEqual(r.reason, "network down")
	})

	it("passes a provider's own failure through, so the UI can say why", async () => {
		stub(() => ({
			ok: false,
			text: "",
			model: "gemini-3.6-flash",
			frameSent: false,
			latencyMs: 6964,
			reason: "You exceeded your current quota"
		}))
		const r = await runCoachTurn({ provider: "gemini-http", model: "", frame: null, block: "B" })
		strictEqual(r.ok, false)
		strictEqual(r.reason, "You exceeded your current quota")
		// The model is echoed so a caller can never attribute an answer to a model it did not ask for.
		strictEqual(r.model, "gemini-3.6-flash")
	})
})
