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

const { PROVIDERS, coachTurn, providerById, providerKey, providerStatus, setProviderKey } =
	await import("./live-providers.ts")

describe("provider registry", () => {
	it("gives every provider a key file, a default model and a note", () => {
		for (const p of PROVIDERS) {
			ok(p.keyFile.endsWith(".key"), p.id)
			ok(p.defaultModel !== "", `${p.id} needs a default model`)
			ok(p.note !== "", `${p.id} needs a note the UI can show`)
		}
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
