/**
 * The turn-based path is the one that runs during a game against a provider that may be slow,
 * rate-limited or misconfigured. Its contract is therefore mostly about FAILING quietly: a coach
 * that throws during a teamfight is worse than one that says nothing.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { respellForSpeech, runCoachTurn, SystemVoice } from "./turnCoach.ts"

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

/**
 * Respelling is the fix for a complaint made months ago and still unfixed: the coach says champion
 * names "insanely wrong", and a name he cannot recognise makes a correct sentence useless.
 *
 * The first attempt put the table in the ground-truth block and the model read the respellings
 * ALOUD — "BRY-er is still at 0 CS". These tests pin the property that makes this attempt a
 * different thing: the substitution happens after the text is recorded, so it can only ever reach
 * the speaker.
 */
describe("respellForSpeech", () => {
	const table = [
		{ name: "Briar", say: "BRY-er" },
		{ name: "Kha'Zix", say: "kah-ZIKS" },
		{ name: "Nunu & Willump", say: "NOO-noo and WILL-umb" },
		{ name: "Nunu", say: "NOO-noo" }
	]

	it("says the name the way he would recognise it", () => {
		strictEqual(respellForSpeech("Briar is 14 CS up on you", table), "BRY-er is 14 CS up on you")
	})

	it("matches however the model spelled it", () => {
		// The client, a hand-edited markdown file and a model will not agree on the apostrophe.
		for (const spelling of ["Kha'Zix", "KhaZix", "Kha Zix", "kha'zix"])
			strictEqual(respellForSpeech(`${spelling} is down`, table), "kah-ZIKS is down")
	})

	it("prefers the longer name, so half a champion is never left behind", () => {
		strictEqual(
			respellForSpeech("Nunu & Willump just died", table),
			"NOO-noo and WILL-umb just died"
		)
	})

	it("keeps a possessive attached", () => {
		strictEqual(respellForSpeech("Briar's camps are free", table), "BRY-er's camps are free")
	})

	it("does not respell a name buried inside another word", () => {
		strictEqual(respellForSpeech("Briarwood is not a champion", table), "Briarwood is not a champion")
	})

	it("does not respell what it has already written", () => {
		/*
		 * One alternation, one pass. Entry-by-entry replacement would let a respelling containing
		 * another champion's letters be rewritten again, which is silent and unbounded.
		 */
		const looping = [
			{ name: "Sion", say: "SY-on" },
			{ name: "SY", say: "ESS-WHY" }
		]
		strictEqual(respellForSpeech("Sion is dead", looping), "SY-on is dead")
	})

	it("expands the abbreviations that were heard as nonsense", () => {
		// "52s" was spoken as "fifty two seds" and "1334g" as a letter, in a real game.
		strictEqual(respellForSpeech("Briar is down 52s", table), "BRY-er is down 52 seconds")
		strictEqual(respellForSpeech("you have 1334g unspent", table), "you have 1334 gold unspent")
		strictEqual(respellForSpeech("unspent for 4m now", table), "unspent for 4 minutes now")
	})

	it("leaves a unit that is already a word alone", () => {
		const line = "you have 52 seconds and 1334 gold"
		strictEqual(respellForSpeech(line, table), line)
	})

	it("changes nothing when there is no table, which is the default", () => {
		strictEqual(respellForSpeech("Briar is 14 CS up on you"), "Briar is 14 CS up on you")
	})
})

describe("SystemVoice", () => {
	it("respells the utterance and never the text it was given", () => {
		/*
		 * THE invariant. `geminiLive.ts` records and renders the line before calling `speak`, so
		 * proving the respelling happens inside `speak` proves it cannot reach the transcript, the
		 * fault scorer, or any prompt — which is the whole difference from the version that put a
		 * phonetic table in the block.
		 */
		const spoken: string[] = []
		class Utterance {
			text: string
			voice: unknown = null
			rate = 1
			constructor(text: string) {
				this.text = text
			}
		}
		const w = {
			speechSynthesis: {
				getVoices: () => [],
				speak: (u: { text: string }) => spoken.push(u.text),
				cancel: () => {},
				speaking: false
			},
			SpeechSynthesisUtterance: Utterance
		}
		const priorWindow = (globalThis as { window?: unknown }).window
		const priorUtterance = (globalThis as { SpeechSynthesisUtterance?: unknown })
			.SpeechSynthesisUtterance
		;(globalThis as { window?: unknown }).window = w
		;(globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance = Utterance
		try {
			const v = new SystemVoice()
			v.available = true
			v.setPronunciations([{ name: "Briar", say: "BRY-er" }])
			const line = "Briar is down 52s"
			v.speak(line)
			deepStrictEqual(spoken, ["BRY-er is down 52 seconds"])
			strictEqual(line, "Briar is down 52s", "the caller's string is untouched")
		} finally {
			;(globalThis as { window?: unknown }).window = priorWindow
			;(globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance =
				priorUtterance
		}
	})
})
