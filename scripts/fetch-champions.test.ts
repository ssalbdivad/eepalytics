/**
 * The two ways this fetcher can stop being a pure function of (patch, cache), pinned.
 *
 * Both are offline properties, so both are tested offline: `globalThis.fetch` is replaced with a
 * stub that answers from a fixture and counts its calls, which is the only way to assert that a
 * code path DID NOT reach the network.
 *
 * 1. A title the wiki says does not exist has to be REMEMBERED. `Module:ChampionData` names twelve
 *    abilities on 16.18.1 with no `Template:Data` page behind them (Shyvana's dragon forms,
 *    Viktor's Glorious Evolution 2-5, Samira's splash coin and so on). They came back `missing` and
 *    were forgotten, so the fetcher re-asked for them on every run and a fully warm cache still
 *    could not be regenerated with the network off.
 * 2. "The wiki said missing" and "this function got nothing back" are NOT the same fact, and only
 *    the first may be cached. A page that exists but whose latest revision carried no content must
 *    keep being re-asked, because that is a transient shape and caching it would silently drop a
 *    real ability from the corpus until someone passed `--refresh`.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { fetchWikitextBatch } from "./fetch-champions.ts"

type WikiPageJson = {
	title: string
	missing?: boolean
	revisions?: { revid: number; slots?: { main?: { content?: string } } }[]
}

const realFetch = globalThis.fetch

/** Answers one `action=query` with the given pages, and counts how many times it was called. */
const stubWiki = (
	pages: WikiPageJson[],
	extra: { normalized?: { from: string; to: string }[]; redirects?: { from: string; to: string }[] } = {}
): { calls: () => number } => {
	let calls = 0
	globalThis.fetch = (async () => {
		calls++
		return new Response(JSON.stringify({ query: { pages, ...extra } }), { status: 200 })
	}) as typeof fetch
	return { calls: () => calls }
}

afterEach(() => {
	globalThis.fetch = realFetch
})

describe("recording what the wiki says does not exist", () => {
	it("collects a page the wiki answered `missing` for, against the title that was asked", async () => {
		stubWiki([{ title: "Template:Data Shyvana/Emberstrike 2", missing: true }])
		const absent = new Set<string>()
		const pages = await fetchWikitextBatch(["Template:Data Shyvana/Emberstrike 2"], absent)
		strictEqual(pages.size, 0)
		deepStrictEqual([...absent], ["Template:Data Shyvana/Emberstrike 2"])
	})

	it("does NOT collect a page that exists but returned no content", async () => {
		stubWiki([{ title: "Template:Data Lillia/Swirlseed", revisions: [{ revid: 4007662, slots: {} }] }])
		const absent = new Set<string>()
		const pages = await fetchWikitextBatch(["Template:Data Lillia/Swirlseed"], absent)
		strictEqual(pages.size, 0)
		deepStrictEqual([...absent], [])
	})

	it("follows a redirect and records the absence against the asked title, not the target", async () => {
		stubWiki([{ title: "Template:Data Viktor/Arcane Storm 2", missing: true }], {
			redirects: [{ from: "Template:Data Viktor/Death Ray 2", to: "Template:Data Viktor/Arcane Storm 2" }]
		})
		const absent = new Set<string>()
		await fetchWikitextBatch(["Template:Data Viktor/Death Ray 2"], absent)
		deepStrictEqual([...absent], ["Template:Data Viktor/Death Ray 2"])
	})

	it("leaves a page that came back whole out of the absent set", async () => {
		stubWiki([
			{
				title: "Template:Data Lillia/Swirlseed",
				revisions: [{ revid: 4007662, slots: { main: { content: "{{Ability data}}" } } }]
			}
		])
		const absent = new Set<string>()
		const pages = await fetchWikitextBatch(["Template:Data Lillia/Swirlseed"], absent)
		strictEqual(pages.get("Template:Data Lillia/Swirlseed")?.revId, 4007662)
		deepStrictEqual([...absent], [])
	})

	/*
	 * The caller passes no set at all in `verify-fetched.ts` and in `champion-data.test.ts`, and
	 * neither owns a cache to record absence in. The parameter is additive for exactly that reason.
	 */
	it("is optional", async () => {
		stubWiki([{ title: "Template:Data Samira/splash coin", missing: true }])
		strictEqual((await fetchWikitextBatch(["Template:Data Samira/splash coin"])).size, 0)
	})
})
