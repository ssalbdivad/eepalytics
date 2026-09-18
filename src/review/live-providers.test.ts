/**
 * The provider layer holds API keys and is the single path every model is reached through, so the
 * things worth pinning are the ones that would corrupt a comparison or leak a secret.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"

const dir = mkdtempSync(join(tmpdir(), "eepalytics-providers-"))
process.env.EEPALYTICS_DATA_DIR = dir

const { PROVIDERS, coachSystemPrompt, coachTurn, providerById, providerKey, providerStatus, setProviderKey } =
	await import("./live-providers.ts")
const { liveCoachSystemPrompt } = await import("../shared/live-coach-mode.ts")
const { liveChampionKnowledge } = await import("./live-coach-knowledge.ts")
const { fullKnowledge } = await import("./live-knowledge-full.ts")

describe("provider registry", () => {
	it("gives every provider a key file, a default model and a note", () => {
		for (const p of PROVIDERS) {
			ok(p.keyFile.endsWith(".key"), p.id)
			ok(p.defaultModel !== "", `${p.id} needs a default model`)
			ok(p.note !== "", `${p.id} needs a note the UI can show`)
		}
	})

	it("does not OFFER a provider that is withdrawn, while still resolving it", () => {
		/*
		 * `available` is computed from "is there a key file", which is not the same question as
		 * "does the key work". `data/openai.key` has existed and been rejected with
		 * `invalid_api_key` since at least 2026-09-18, so the settings screen advertised gpt-5 as
		 * an available live coach that fails on the first turn of a real game. The row stays in
		 * PROVIDERS because his settings may already name it and `providerById` still has to
		 * answer; what stops is the advertising.
		 */
		const openai = providerById("openai")!
		strictEqual(openai.offered, false)
		strictEqual(
			providerStatus().some(p => p.id === "openai"),
			false,
			"a provider whose stored key is rejected must not be offered as available"
		)
		ok(
			providerStatus().some(p => p.id === "anthropic"),
			"withdrawing one provider must not withdraw the others"
		)
	})

	it("does not include Gemini Live — it is a different shape, not a provider", () => {
		// A socket with native audio and barge-in is not an HTTPS turn. Listing it here would
		// invite code that treats them the same, which is the lie this split exists to avoid.
		strictEqual(providerById("gemini-live"), undefined)
	})
})

describe("keys", () => {
	it("writes 0600 and reads back only through the daemon", () => {
		const p = providerById("openai")!
		setProviderKey(p, "sk-test")
		const path = join(dir, p.keyFile)
		ok(existsSync(path))
		// The mode matters: this file is a credential on a machine he shares with a game client.
		strictEqual(statSync(path).mode & 0o777, 0o600)
		strictEqual(providerKey(p), "sk-test")
	})

	it("clears on an empty write rather than storing an empty key", () => {
		const p = providerById("openai")!
		setProviderKey(p, "sk-test")
		setProviderKey(p, "   ")
		strictEqual(existsSync(join(dir, p.keyFile)), false)
		strictEqual(providerKey(p), null)
	})

	it("treats a whitespace-only file as no key", () => {
		const p = providerById("kimi")!
		writeFileSync(join(dir, p.keyFile), "\n\n")
		strictEqual(providerKey(p), null)
	})

	it("never reports a key through the status list", () => {
		const p = providerById("glm")!
		setProviderKey(p, "super-secret-value")
		const row = providerStatus().find(r => r.id === "glm")!
		strictEqual(row.available, true)
		// The whole row is what the browser receives.
		strictEqual(JSON.stringify(row).includes("super-secret"), false)
	})
})

describe("coachTurn", () => {
	it("fails with a usable sentence when there is no key, and never throws", async () => {
		const p = providerById("anthropic")!
		if (existsSync(join(dir, p.keyFile))) rmSync(join(dir, p.keyFile))
		const r = await coachTurn({ provider: "anthropic", blockText: "B" })
		strictEqual(r.ok, false)
		ok(r.reason?.includes(p.keyFile), `reason should name the key file: ${r.reason}`)
		strictEqual(r.text, "")
	})

	it("rejects an unknown provider by name", async () => {
		const r = await coachTurn({ provider: "nope" as never, blockText: "B" })
		strictEqual(r.ok, false)
		ok(r.reason?.includes("nope"))
	})

	it("echoes the model it used, so an answer cannot be attributed to the wrong one", async () => {
		const r = await coachTurn({ provider: "openai", model: "gpt-x", blockText: "B" })
		strictEqual(r.model, "gpt-x")
	})

	it("falls back to the provider's default model when none is given", async () => {
		const r = await coachTurn({ provider: "openai", model: "   ", blockText: "B" })
		strictEqual(r.model, providerById("openai")!.defaultModel)
	})
})

describe("the prompt survived being made cacheable", () => {
	/*
	 * Prompt caching moved the system prompt out of the SDK's `system` field and into a system
	 * MESSAGE, because that is the only place a `cache_control` breakpoint can be attached. That is
	 * a move of one string between two request fields, and this is the test that keeps it one: if
	 * `coachSystemPrompt` ever stops being exactly what `liveCoachSystemPrompt` produces, then a
	 * cached arm and an uncached arm are no longer asking the same question, and every latency and
	 * cost number measured against the pair becomes a prompt comparison wearing a cache label.
	 */
	it("builds byte-identical text to the prompt builder, in every mode", () => {
		for (const mode of ["trusted", "cite-or-quiet", "fenced"] as const) {
			const expected = liveCoachSystemPrompt({
				mode,
				championKnowledge:
					mode === "trusted" ?
						fullKnowledge({ champion: "Lillia", counterpart: "Fiddlesticks" })
					:	liveChampionKnowledge("Lillia")
			})
			strictEqual(
				coachSystemPrompt({ mode, champion: "Lillia", counterpart: "Fiddlesticks" }),
				expected,
				mode
			)
		}
	})

	it("is not changed by the cache or effort knobs — they are request options, not words", () => {
		// Both knobs are absent from the signature on purpose: neither may reach the text. This
		// test exists so that a later "just add a line telling a low-effort model to be brief"
		// fails here rather than silently invalidating a stored run.
		const plain = coachSystemPrompt({ champion: "Lillia", counterpart: "Fiddlesticks" })
		ok(!/effort|cache/i.test(plain.slice(0, 2000)), "the prompt head must not mention the knobs")
	})
})
