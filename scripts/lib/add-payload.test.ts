/**
 * What the three candidate additions may and may not say.
 *
 * The additions are the risky half of the context-feed ablation, because an addition can invent
 * where a cut can only remove. Two rules are pinned here and both are the repo's own:
 *
 * 1. **No unverifiable clock.** `buffBlock` may state WHEN Baron or Elder was taken, because that
 *    is an event in the feed's own log, and it may not state how long the buff lasts, because
 *    nothing in this app can check that value — the same reason `objectiveBlock` refuses the grub
 *    respawn cadence.
 * 2. **No total for gold SPENT**, at any resolution, in a block whose whole subject is gold.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ADDS, SPELL_NOTE, addToPayload, buffBlock, spendBlock } from "./add-payload.ts"
import type { LiveAllGameData } from "../../src/shared/schema/live.ts"

/** Fated Ashes (1200) + Haunting Guise (1300) both feed Liandry's Torment (3200). */
const FATED_ASHES = 2508
const LIANDRYS = 6653

const data = (over: Partial<LiveAllGameData> = {}): LiveAllGameData =>
	({
		activePlayer: { riotId: "Gooskaffur#NA1", currentGold: 900 },
		allPlayers: [
			{
				riotId: "Gooskaffur#NA1",
				championName: "Lillia",
				team: "ORDER",
				items: [{ itemID: FATED_ASHES }]
			},
			{ riotId: "Enemy#NA1", championName: "Kayn", team: "CHAOS", items: [] }
		],
		events: { Events: [] },
		...over
	}) as unknown as LiveAllGameData

describe("spendBlock", () => {
	it("names the recipe, what is left, and how short he is", () => {
		const out = spendBlock(data())!
		assert.ok(out.includes("Gold in hand 900"))
		assert.ok(/left to pay/.test(out))
		assert.ok(/short\./.test(out))
	})

	it("says he can afford it when he can", () => {
		const out = spendBlock(data({ activePlayer: { riotId: "Gooskaffur#NA1", currentGold: 9000 } as never }))!
		assert.ok(out.includes("HE CAN AFFORD IT NOW."))
		assert.ok(!/short/.test(out))
	})

	it("states the absence rather than a number when nothing feeds a spike", () => {
		const out = spendBlock(
			data({
				allPlayers: [
					{ riotId: "Gooskaffur#NA1", championName: "Lillia", team: "ORDER", items: [{ itemID: LIANDRYS }] }
				] as never
			})
		)!
		assert.ok(out.includes("no part-paid recipe"))
	})

	it("never states a total for gold SPENT — the one number this feed cannot give", () => {
		const out = spendBlock(data())!
		assert.ok(/not knowable from this feed/.test(out))
		assert.ok(!/spent [0-9]/i.test(out))
	})
})

describe("buffBlock", () => {
	const withBaron = data({
		events: { Events: [{ EventName: "BaronKill", EventTime: 1500, KillerName: "Gooskaffur#NA1" }] } as never
	})

	it("is null before anything has been taken", () => {
		assert.equal(buffBlock(data(), 600), null)
	})

	it("names the take, the side and the age", () => {
		const out = buffBlock(withBaron, 1560)!
		assert.ok(out.includes("Baron was taken by YOUR team at 25:00"))
		assert.ok(out.includes("(1m00s ago)"))
	})

	it("REFUSES a duration, and says why", () => {
		const out = buffBlock(withBaron, 1560)!
		assert.ok(out.includes("NOT in this payload"))
		assert.ok(out.includes("patch value this app cannot check"))
		// no minutes-or-seconds figure that could be read as a buff clock
		assert.ok(!/(?:lasts|runs|expires|for)\s+\d/i.test(out))
	})

	it("reads an ELDER take off DragonType, not off the event name", () => {
		const elder = data({
			events: {
				Events: [{ EventName: "DragonKill", DragonType: "Elder", EventTime: 2000, KillerName: "Enemy#NA1" }]
			} as never
		})
		const out = buffBlock(elder, 2030)!
		assert.ok(out.includes("Elder was taken by THEIR team at 33:20"))
	})

	it("ignores an elemental drake", () => {
		const chem = data({
			events: {
				Events: [{ EventName: "DragonKill", DragonType: "Chemtech", EventTime: 400, KillerName: "Enemy#NA1" }]
			} as never
		})
		assert.equal(buffBlock(chem, 500), null)
	})
})

describe("addToPayload", () => {
	const payload = [
		"YOU — Lillia, JUNGLE, level 3, side ORDER\nGold in hand 900.",
		"ENEMY JUNGLER — Kayn, level 3, 0/0/0\nSummoners: Flash, Primal Smite.",
		"OBJECTIVES\nDrakes YOUR team: none"
	].join("\n\n")

	it("returns the bytes untouched with no addition", () => {
		assert.equal(addToPayload(payload, null, data(), 600), payload)
	})

	it("puts the gold join directly under the section carrying the gold figure", () => {
		const out = addToPayload(payload, ADDS.spend!, data(), 600).split("\n\n")
		assert.ok(out[0]!.startsWith("YOU —"))
		assert.ok(out[1]!.startsWith("WHAT YOUR GOLD BUYS"))
	})

	it("hangs the cooldown clause off the spells it is about, not off a section of its own", () => {
		const out = addToPayload(payload, ADDS.spells!, data(), 600)
		assert.ok(out.includes(`Summoners: Flash, Primal Smite.\n${SPELL_NOTE}`))
		assert.ok(!out.includes("\n\n" + SPELL_NOTE))
	})

	it("places an unanchored block at the end rather than dropping it", () => {
		const delta = "SINCE THE LAST LOOK\ngold 200 -> 900"
		const out = addToPayload(delta, ADDS.spend!, data(), 600)
		assert.ok(out.startsWith("SINCE THE LAST LOOK"))
		assert.ok(out.includes("WHAT YOUR GOLD BUYS"))
	})
})
