/**
 * The build reader is the first thing in the live path that turns raw client rows into words the
 * coach may use, so the tests here are all about the fence rather than about formatting: an item
 * is named by the client or not at all, a purchase is only a purchase against a previous
 * observation, and a jungler is identified or the block simply does not claim one.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { inventoryOf, junglerOf, newBuildMemory, roleWord } from "./live-builds.ts"
import type { LivePlayer } from "../shared/schema/live.ts"

const player = (over: Partial<LivePlayer> = {}): LivePlayer => ({
	riotId: "Gooskaffur#NA1",
	championName: "Lillia",
	team: "ORDER",
	...over
})

const item = (itemID: number, displayName: string, over: Record<string, unknown> = {}) => ({
	itemID,
	displayName,
	...over
})

describe("inventoryOf", () => {
	it("names items exactly as the client does, and drops consumables", () => {
		const mem = newBuildMemory()
		const out = inventoryOf(
			player({
				items: [
					item(3152, "Riftmaker", { slot: 0 }),
					item(2003, "Health Potion", { slot: 1, consumable: true, count: 2 }),
					item(3340, "Stealth Ward", { slot: 6 })
				]
			}),
			mem
		)
		deepStrictEqual(out, [{ name: "Riftmaker" }, { name: "Stealth Ward", trinket: true }])
	})

	it("prints an unnamed item as its id rather than guessing a name", () => {
		// An item we cannot name is still information — "he has a sixth thing" — and a name we
		// invented for it would be a possession the client never reported.
		const out = inventoryOf(player({ items: [{ itemID: 3157, slot: 0 }] }), newBuildMemory())
		deepStrictEqual(out, [{ name: "item 3157" }])
	})

	it("marks nothing as bought on the first sight of a player", () => {
		/*
		 * Regression by construction: a daemon restarted at minute 20 would otherwise announce a
		 * whole inventory as five simultaneous purchases — a fabrication indistinguishable from a
		 * read, which is the one failure this app is built to prevent.
		 */
		const mem = newBuildMemory()
		const first = inventoryOf(
			player({ items: [item(3152, "Riftmaker"), item(3020, "Sorcerer's Shoes")] }),
			mem
		)
		strictEqual(
			first.some(i => i.justBought),
			false
		)
	})

	it("marks only what is new since the previous read", () => {
		const mem = newBuildMemory()
		inventoryOf(player({ items: [item(3152, "Riftmaker")] }), mem)
		const after = inventoryOf(
			player({ items: [item(3152, "Riftmaker"), item(3020, "Sorcerer's Shoes")] }),
			mem
		)
		deepStrictEqual(after, [{ name: "Riftmaker" }, { name: "Sorcerer's Shoes", justBought: true }])
	})

	it("keeps players apart, so one man's purchase is not another's", () => {
		const mem = newBuildMemory()
		inventoryOf(player({ items: [item(3152, "Riftmaker")] }), mem)
		const enemy = inventoryOf(
			player({ riotId: "Someone#EUW", championName: "Viego", items: [item(3152, "Riftmaker")] }),
			mem
		)
		strictEqual(enemy[0]!.justBought, undefined, "first sight of the enemy, not a purchase")
	})
})

describe("junglerOf", () => {
	const jg = (over: Partial<LivePlayer>) => player({ riotId: `${over.championName}#NA1`, ...over })
	const smite = {
		summonerSpells: {
			summonerSpellOne: { displayName: "Smite" },
			summonerSpellTwo: { displayName: "Flash" }
		}
	}

	it("takes the client's own position when it gives one", () => {
		const found = junglerOf([
			jg({ championName: "Viego", position: "JUNGLE" }),
			jg({ championName: "Ahri", position: "MIDDLE" })
		])
		strictEqual(found?.championName, "Viego")
	})

	it("falls back to Smite when the queue assigned no positions", () => {
		// Blind pick and several other queues send an empty position for everyone.
		const found = junglerOf([
			jg({ championName: "Viego", position: "", ...smite }),
			jg({ championName: "Ahri", position: "" })
		])
		strictEqual(found?.championName, "Viego")
	})

	it("gives up rather than pick one of two Smites", () => {
		/*
		 * A support taking Smite happens. Picking the first of two would produce a confident line
		 * about the wrong player's build, which is worse than the block carrying no build at all.
		 */
		const found = junglerOf([
			jg({ championName: "Viego", position: "", ...smite }),
			jg({ championName: "Nunu", position: "", ...smite })
		])
		strictEqual(found, null)
	})

	it("gives up when nothing identifies anyone", () => {
		strictEqual(junglerOf([jg({ championName: "Ahri", position: "" })]), null)
	})
})

describe("roleWord", () => {
	it("speaks the five positions the way a coach says them", () => {
		deepStrictEqual(
			["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"].map(roleWord),
			["top", "jungle", "mid", "bot", "support"]
		)
	})

	it("says nothing when the client said nothing", () => {
		strictEqual(roleWord(""), undefined)
		strictEqual(roleWord(undefined), undefined)
	})
})
