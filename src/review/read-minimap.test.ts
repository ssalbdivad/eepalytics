/**
 * The minimap reader's contract is mostly about what it REFUSES.
 *
 * A read is a model looking at 288 pixels and guessing. The measured accuracy is 94% for his own
 * half of the map and 63% for an enemy's zone — good enough to gate a line, nowhere near good
 * enough to make a claim — so everything here is about the answer being dropped WHOLE the moment it
 * disagrees with something the client already settled for free.
 *
 * The model is stubbed. What is being tested is the fence and the failure paths, both of which are
 * pure once the bytes come back; the model's actual accuracy was measured against hand labels in
 * `scripts/probe-minimap.ts` and cannot be asserted here.
 */

import { ok, strictEqual } from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import { readMinimap } from "./read-minimap.ts"
import type { FrameTruth } from "./frame-read.ts"

const TRUTH: FrameTruth = {
	myChampion: "Lillia",
	enemyChampions: ["Ornn", "Briar", "Lissandra", "Jhin", "Senna"],
	alliesAlive: 4,
	enemiesAlive: 5,
	meDead: false
}

const realFetch = globalThis.fetch

/** Reply with whatever the model would have said, without asking it. */
const stub = (text: string, status = 200): void => {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
			status,
			headers: { "content-type": "application/json" }
		})) as typeof fetch
}

afterEach(() => {
	globalThis.fetch = realFetch
})

/** The coordinate form, which measured best: the model points and `map.ts` names the zone. */
const READ = {
	enemiesOnMinimap: [],
	alliesOnMinimap: 3,
	you: { x: 300, y: 400 },
	activity: "moving",
	youChampion: "Lillia"
}

describe("readMinimap", () => {
	it("returns a read when the model answers and nothing contradicts it", async () => {
		stub(JSON.stringify(READ))
		const out = await readMinimap({ jpegBase64: "x", truth: TRUTH })
		ok(out.read, `expected a read, got ${JSON.stringify(out)}`)
		strictEqual(out.faults, null)
		ok(out.ms >= 0)
	})

	it("drops the read WHOLE when it places him on the map while he is dead", async () => {
		/*
		 * Measured on real frames: every rendering placed his icon somewhere on the map while the
		 * client said he was on the respawn screen, on 6 of the 6 reads where it applied — the crop
		 * has no respawn timer in it and the death camera is still following a fight. The client
		 * settles this for free, so a read that disagrees is not a hard read, it is a wrong one.
		 */
		stub(JSON.stringify(READ))
		const out = await readMinimap({ jpegBase64: "x", truth: { ...TRUTH, meDead: true } })
		strictEqual(out.read, null)
		strictEqual(out.reason, "fenced")
		ok(out.faults && out.faults.length > 0, "expected the fault to be named")
	})

	it("drops a read claiming more allies than are alive", async () => {
		stub(JSON.stringify({ ...READ, alliesOnMinimap: 9 }))
		const out = await readMinimap({ jpegBase64: "x", truth: TRUTH })
		strictEqual(out.read, null)
		strictEqual(out.reason, "fenced")
	})

	it("never throws on a non-200, and says which", async () => {
		globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch
		const out = await readMinimap({ jpegBase64: "x", truth: TRUTH })
		strictEqual(out.read, null)
		strictEqual(out.reason, "http-503")
	})

	it("never throws on a body that is not JSON", async () => {
		stub("this is not json")
		const out = await readMinimap({ jpegBase64: "x", truth: TRUTH })
		strictEqual(out.read, null)
		strictEqual(out.reason, "not-json")
	})

	it("never throws when the call itself fails", async () => {
		globalThis.fetch = (async () => {
			throw new Error("socket hang up")
		}) as typeof fetch
		const out = await readMinimap({ jpegBase64: "x", truth: TRUTH })
		strictEqual(out.read, null)
		strictEqual(out.reason, "error")
	})

	it("gives up rather than sitting in front of a coaching turn", async () => {
		// The read is awaited BEFORE the block is fetched, so a hung reader would hold up the coach.
		globalThis.fetch = ((_u: string, init?: { signal?: AbortSignal }) =>
			new Promise((_res, rej) => {
				init?.signal?.addEventListener("abort", () => {
					const e = new Error("aborted")
					e.name = "AbortError"
					rej(e)
				})
			})) as unknown as typeof fetch
		const started = Date.now()
		const out = await readMinimap({ jpegBase64: "x", truth: TRUTH, timeoutMs: 40 })
		strictEqual(out.read, null)
		strictEqual(out.reason, "timeout")
		ok(Date.now() - started < 2000, "the timeout did not fire")
	})
})
