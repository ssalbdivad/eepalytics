/**
 * What the ground-truth boundary does with a payload the client got wrong.
 *
 * `src/shared/schema/live.test.ts` owns the question "does the schema match what the client sends"
 * and answers it against every recorded game. This file owns the half that only exists here: what
 * the CLIENT does with the answer — what it returns, what it logs, and how loud it is about it.
 *
 * Both halves matter because the one real failure was diagnosed from the log and nothing else. On
 * 2026-09-19 this class returned `null` for 363 consecutive polls and wrote 6,415 journal lines
 * saying so, and the only reason anyone could tell which field was at fault was that ArkType's
 * summary happened to name it. The lines did not name the player, did not carry the value, and
 * repeated identically thirty times a minute for eighteen minutes.
 *
 * The payloads under test are REAL: `aRecordedPayload` reads a sample out of `data/live-samples/`
 * and the faults are injected onto it exactly as the journal describes them. A hand-written lobby
 * is what let this boundary ship in a shape the client disagreed with.
 */

import { ok, strictEqual } from "node:assert/strict"
import { createReadStream, readdirSync } from "node:fs"
import { createInterface } from "node:readline"
import { before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { LiveClient, WARN_REPEAT_EVERY_MS } from "./live-client.ts"
import type { HttpMethod, LcuResponse, LcuTransport } from "./transport.ts"
import { LcuTransportError } from "./transport.ts"

const SAMPLE_DIR = fileURLToPath(new URL("../../data/live-samples", import.meta.url))

/** The newest recorded payload with a full roster on it. Never a fixture. */
const aRecordedPayload = async (): Promise<Record<string, unknown>> => {
	for (const file of readdirSync(SAMPLE_DIR).filter(f => f.endsWith(".ndjson")).sort().reverse()) {
		const rl = createInterface({
			input: createReadStream(`${SAMPLE_DIR}/${file}`),
			crlfDelay: Infinity
		})
		for await (const line of rl) {
			if (line.trim() === "") continue
			const sample = JSON.parse(line) as { data: Record<string, unknown> }
			rl.close()
			if (Array.isArray(sample.data.allPlayers) && sample.data.allPlayers.length >= 2)
				return sample.data
		}
	}
	throw new Error(`no recorded payload with a roster in ${SAMPLE_DIR}`)
}

interface Rig {
	client: LiveClient
	warnings: string[]
	/** What the next request answers with. Replaced per case. */
	answer: (path: string) => LcuResponse | Error
	setNow: (ms: number) => void
}

const rig = (): Rig => {
	const warnings: string[] = []
	let now = 1_000_000
	const state: { answer: (path: string) => LcuResponse | Error } = {
		answer: () => body(200, "{}")
	}
	const transport = {
		kind: "bridge",
		state: "ready",
		start: async () => {},
		stop: async () => {},
		request: async (_m: HttpMethod, path: string): Promise<LcuResponse> => {
			const a = state.answer(path)
			if (a instanceof Error) throw a
			return a
		},
		on() {
			return this
		},
		off() {
			return this
		}
	} as unknown as LcuTransport
	const client = new LiveClient(transport, {
		onWarn: m => warnings.push(m),
		now: () => now
	})
	return {
		client,
		warnings,
		get answer() {
			return state.answer
		},
		set answer(fn: (path: string) => LcuResponse | Error) {
			state.answer = fn
		},
		setNow: ms => {
			now = ms
		}
	} as Rig
}

const body = (status: number, text: string): LcuResponse => ({
	status,
	body: text,
	buffer: null,
	bytes: text.length,
	file: null,
	durationMs: 1,
	target: "live",
	method: "GET",
	path: "/liveclientdata/allgamedata"
})

let recorded: Record<string, unknown>

before(async () => {
	recorded = await aRecordedPayload()
})

describe("allGameData degrades to less, not to nothing", () => {
	it("returns the whole lobby when a field nothing reads is null", async () => {
		/*
		 * The Arena shape: 356 polls of game 5645348275 sent `runes: null` on all eighteen rows,
		 * and this class answered `null` to every one of them. `runes` is `unknown` in the schema
		 * now, so there is not even a field to drop.
		 */
		const r = rig()
		const payload = structuredClone(recorded)
		for (const p of payload.allPlayers as Record<string, unknown>[]) p.runes = null
		r.answer = () => body(200, JSON.stringify(payload))
		const got = await r.client.allGameData()
		ok(got !== null)
		strictEqual(got.allPlayers?.length, (recorded.allPlayers as unknown[]).length)
		strictEqual(r.warnings.length, 0, JSON.stringify(r.warnings))
	})

	it("drops one bad field, keeps the payload, and names the player and the value", async () => {
		const r = rig()
		const payload = structuredClone(recorded)
		const rows = payload.allPlayers as Record<string, unknown>[]
		rows[1]!.items = {}
		r.answer = () => body(200, JSON.stringify(payload))
		const got = await r.client.allGameData()
		ok(got !== null)
		strictEqual(got.allPlayers?.length, rows.length)
		strictEqual(got.allPlayers?.[1]?.items, undefined)
		// Everything else on that row is still there — the point of per-field tolerance.
		strictEqual(got.allPlayers?.[1]?.championName, rows[1]!.championName)
		strictEqual(r.warnings.length, 1, JSON.stringify(r.warnings))
		const w = r.warnings[0]!
		ok(w.includes("allPlayers[1].items"), w)
		ok(w.includes(String(rows[1]!.championName)), w)
		// The VALUE, because the sampler records the repaired object and the log is the only place
		// the evidence can survive.
		ok(w.includes("{}"), w)
		ok(w.includes("The rest of the payload is being used."), w)
	})

	it("names both the key it dropped and the deeper thing that was wrong", async () => {
		// A fault inside an array costs the array's key, so the line has to carry both paths —
		// "we do not have his items" and "one of his item rows was a string" are different facts.
		const r = rig()
		const payload = structuredClone(recorded)
		const rows = payload.allPlayers as Record<string, unknown>[]
		const target = rows.findIndex(p => Array.isArray(p.items) && (p.items as unknown[]).length > 2)
		ok(target >= 0, "no recorded row with three items")
		;(rows[target]!.items as unknown[])[2] = "a string, somehow"
		r.answer = () => body(200, JSON.stringify(payload))
		const got = await r.client.allGameData()
		ok(got !== null)
		strictEqual(got.allPlayers?.[target]?.items, undefined)
		strictEqual(r.warnings.length, 1, JSON.stringify(r.warnings))
		const w = r.warnings[0]!
		ok(w.includes(`dropped allPlayers[${target}].items`), w)
		ok(w.includes(`because allPlayers[${target}].items[2]`), w)
		ok(w.includes("a string, somehow"), w)
	})

	it("still returns null, loudly, when the payload cannot be repaired", async () => {
		const r = rig()
		r.answer = () => body(200, JSON.stringify({ ...recorded, allPlayers: "ten of them" }))
		strictEqual(await r.client.allGameData(), null)
		strictEqual(r.warnings.length, 1)
		ok(r.warnings[0]!.includes("could not be repaired"), r.warnings[0]!)
		ok(r.warnings[0]!.includes("allPlayers"), r.warnings[0]!)
	})

	it("says nothing about a client that is simply closed", async () => {
		const r = rig()
		r.answer = () => new LcuTransportError("CLIENT_CLOSED", "no game")
		strictEqual(await r.client.allGameData(), null)
		strictEqual(r.warnings.length, 0)
		r.answer = () => body(404, "")
		strictEqual(await r.client.allGameData(), null)
		strictEqual(r.warnings.length, 0)
	})
})

describe("the log does not flood", () => {
	it("speaks once for a repeating fault and then carries the count", async () => {
		/*
		 * The measured failure: 363 rejected polls produced 6,415 journal lines, at about thirty a
		 * minute, all saying the same two things. Thirty identical lines are not thirty times as
		 * informative as one; the COUNT is, which is why the repeat carries it.
		 */
		const r = rig()
		const payload = structuredClone(recorded)
		;(payload.allPlayers as Record<string, unknown>[])[1]!.items = {}
		r.answer = () => body(200, JSON.stringify(payload))
		const start = 5_000_000
		r.setNow(start)
		for (let i = 0; i < 30; i++) {
			r.setNow(start + i * 2_000)
			ok((await r.client.allGameData()) !== null)
		}
		strictEqual(r.warnings.length, 1, JSON.stringify(r.warnings))
		// Past the window the next poll speaks again, and says how many it swallowed.
		r.setNow(start + WARN_REPEAT_EVERY_MS + 1)
		await r.client.allGameData()
		strictEqual(r.warnings.length, 2)
		ok(r.warnings[1]!.includes("x30"), r.warnings[1]!)
		ok(r.warnings[1]!.includes("allPlayers[1].items"), r.warnings[1]!)
	})

	it("never delays a fault nobody has seen before", async () => {
		// The throttle is per fault signature, so a SECOND field going wrong is not silenced by the
		// first one's window. A schema surprise that arrives during an existing one has to speak.
		const r = rig()
		const one = structuredClone(recorded)
		;(one.allPlayers as Record<string, unknown>[])[1]!.items = {}
		r.answer = () => body(200, JSON.stringify(one))
		await r.client.allGameData()
		await r.client.allGameData()
		strictEqual(r.warnings.length, 1)

		const two = structuredClone(one)
		;(two.allPlayers as Record<string, unknown>[])[3]!.scores = 7
		r.answer = () => body(200, JSON.stringify(two))
		await r.client.allGameData()
		strictEqual(r.warnings.length, 2, JSON.stringify(r.warnings))
		ok(r.warnings[1]!.includes("allPlayers[3].scores"), r.warnings[1]!)
	})
})
