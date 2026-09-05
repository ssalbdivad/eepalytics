/**
 * The item race, pinned.
 *
 * Every case below is either a rule that came out of the four recorded games in
 * `data/live-samples/` or a fabrication this module can commit if a guard is removed. The last
 * two matter most: both of them produce a sentence that sounds exactly like a correct one.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import {
	itemTempoFacts,
	itemTier,
	LEAD_LONG_SEC,
	LEAD_MIN_HELD_SEC,
	newItemTempoMemory,
	observeItems,
	TEMPO_GAP_SEC
} from "./item-tempo.ts"
import type { ItemTempoFact, ItemTempoMemory, TempoItem } from "./item-tempo.ts"

/** Item rows in the shape the Live Client Data API actually sends them. */
const LIANDRYS: TempoItem = { itemID: 6653, displayName: "Liandry's Torment", consumable: false }
const RIFTMAKER: TempoItem = { itemID: 4633, displayName: "Riftmaker", consumable: false }
const BOTRK: TempoItem = { itemID: 3153, displayName: "Blade of The Ruined King", consumable: false }
const STRIDEBREAKER: TempoItem = { itemID: 6631, displayName: "Stridebreaker", consumable: false }
const BF_SWORD: TempoItem = { itemID: 1038, displayName: "B. F. Sword", consumable: false }
const STEELCAPS: TempoItem = { itemID: 3047, displayName: "Plated Steelcaps", consumable: false }
const WARD: TempoItem = { itemID: 3340, displayName: "Stealth Ward", consumable: false }
const POTION: TempoItem = { itemID: 2003, displayName: "Health Potion", consumable: true }

/** Walk a memory forward, returning the line offered at each tick (and spending it, as the caller would). */
const replay = (
	ticks: { sec: number; me: TempoItem[]; them: TempoItem[] | null }[],
	mem: ItemTempoMemory = newItemTempoMemory()
): { sec: number; fact: ItemTempoFact }[] => {
	const said: { sec: number; fact: ItemTempoFact }[] = []
	for (const tick of ticks) {
		observeItems(
			{
				nowSec: tick.sec,
				me: { champion: "Lillia", items: tick.me },
				counterpart: tick.them === null ? null : { champion: "Briar", items: tick.them }
			},
			mem
		)
		const [fact] = itemTempoFacts(mem, tick.sec)
		if (fact) {
			fact.commit()
			said.push({ sec: tick.sec, fact })
		}
	}
	return said
}

/** The corpus's own sampling cadence: 6.10s median across all four splits. */
const ticksEvery6 = (fromSec: number, toSec: number, at: (sec: number) => { me: TempoItem[]; them: TempoItem[] | null }) => {
	const out = []
	for (let sec = fromSec; sec <= toSec; sec += 6) out.push({ sec, ...at(sec) })
	return out
}

describe("itemTier", () => {
	it("counts legendaries and nothing else", () => {
		strictEqual(itemTier(6631, "Stridebreaker"), "legendary")
		strictEqual(itemTier(3047, "Plated Steelcaps"), "boots")
		strictEqual(itemTier(1038, "B. F. Sword"), "component")
		strictEqual(itemTier(3340, "Stealth Ward"), "trinket")
		strictEqual(itemTier(1101, "Scorchclaw Pup"), "pet")
		strictEqual(itemTier(3865, "World Atlas"), "support")
		strictEqual(itemTier(1055, "Doran's Blade"), "starter")
	})

	/*
	 * `price` IS THE COMBINE COST. Measured over all 64,941 item rows in the four recorded games:
	 * the dearest thing anyone held was B. F. Sword at 1300, a component, while Rabadon's Deathcap
	 * reports 1100 and Stridebreaker 750. No threshold separates the two sets in either direction,
	 * which is why this module classifies by id and never by gold.
	 */
	it("does not order components below legendaries by price", () => {
		strictEqual(itemTier(1038, "B. F. Sword"), "component") // price 1300
		strictEqual(itemTier(3089, "Rabadon's Deathcap"), "legendary") // price 1100
		strictEqual(itemTier(6631, "Stridebreaker"), "legendary") // price 750
	})

	/*
	 * The name check is what makes the table safe to ship. An id Riot reuses in a later patch has
	 * to answer "unknown" — the alternative is answering wrongly, and a wrong count is spoken in
	 * the same flat voice as a right one.
	 */
	it("refuses an id whose name has moved underneath it", () => {
		strictEqual(itemTier(6631, "Some Item Riot Added In 2027"), "unknown")
		strictEqual(itemTier(999999, "Nothing"), "unknown")
	})

	it("classifies an id with no name, because the client sometimes omits it", () => {
		strictEqual(itemTier(6631), "legendary")
	})
})

describe("observeItems", () => {
	it("records the clock an item was watched appearing at", () => {
		const mem = newItemTempoMemory()
		replay(
			[
				{ sec: 500, me: [BF_SWORD], them: [BF_SWORD] },
				{ sec: 542, me: [LIANDRYS], them: [BOTRK] },
				{ sec: 834, me: [LIANDRYS], them: [BOTRK, STRIDEBREAKER] }
			],
			mem
		)
		deepStrictEqual(
			mem.counterpart.completed.map(c => [c.name, c.atSec]),
			[
				["Blade of The Ruined King", 542],
				["Stridebreaker", 834]
			]
		)
	})

	/*
	 * `split-01.ndjson` opens at 14:04 with four legendaries already on the map. A completion time
	 * invented for those would be the exact shape of fabrication this app exists to prevent, so
	 * anything held on a player's first tick carries a null clock and is never announced. The
	 * COUNT is still exact, because it is read off the current inventory.
	 */
	it("gives no completion time to an item already held when watching began", () => {
		const mem = newItemTempoMemory()
		const said = replay([{ sec: 844, me: [LIANDRYS], them: [BOTRK, STRIDEBREAKER] }], mem)
		deepStrictEqual(mem.counterpart.completed.map(c => c.atSec), [null, null])
		strictEqual(mem.counterpart.completed.length, 2)
		// The COUNT is exact and may be compared. The completion is not, so it is never named.
		deepStrictEqual(said.map(s => s.fact.kind), ["items-behind"])
	})

	/*
	 * THE ONE THAT WOULD LIE. The counterpart is resolved by declared position falling back to
	 * Smite, so his row can arrive a tick or two after the player's own. With a single per-memory
	 * "first tick" flag, everything he was already holding got stamped with the tick he appeared
	 * on and announced as though he had just finished all of it.
	 */
	it("does not announce a whole inventory when the counterpart shows up late", () => {
		const said = replay([
			{ sec: 600, me: [LIANDRYS], them: null },
			{ sec: 606, me: [LIANDRYS], them: [BOTRK, STRIDEBREAKER] },
			{ sec: 612, me: [LIANDRYS], them: [BOTRK, STRIDEBREAKER] }
		])
		deepStrictEqual(said.filter(s => s.fact.kind === "counterpart-finished"), [])
	})

	it("drops an item that was sold, because the line claims what he HOLDS", () => {
		const mem = newItemTempoMemory()
		replay(
			[
				{ sec: 500, me: [BF_SWORD], them: [BF_SWORD] },
				{ sec: 542, me: [LIANDRYS], them: [BOTRK, STRIDEBREAKER] },
				{ sec: 900, me: [LIANDRYS], them: [STRIDEBREAKER] }
			],
			mem
		)
		deepStrictEqual(mem.counterpart.completed.map(c => c.name), ["Stridebreaker"])
	})

	it("treats a clock that goes backwards as a new game", () => {
		const mem = newItemTempoMemory()
		replay(
			[
				{ sec: 2000, me: [LIANDRYS], them: [BOTRK, STRIDEBREAKER] },
				{ sec: 30, me: [], them: [] }
			],
			mem
		)
		strictEqual(mem.counterpart.completed.length, 0)
		strictEqual(mem.fromSec, 30)
	})
})

describe("itemTempoFacts", () => {
	/*
	 * The case the whole module was built for, from `split-03.ndjson`. Briar finished Blade of The
	 * Ruined King at 9:02 and Stridebreaker at 13:54; Lillia finished Liandry's Torment at 9:38
	 * and Riftmaker at 20:07. For the six minutes and thirteen seconds in between, the enemy
	 * jungler was a full item up and nothing in this app said so.
	 */
	it("names the item he just finished, once", () => {
		const said = replay([
			{ sec: 500, me: [BF_SWORD], them: [BF_SWORD] },
			{ sec: 542, me: [BF_SWORD], them: [BOTRK] },
			{ sec: 548, me: [BF_SWORD], them: [BOTRK] },
			{ sec: 834, me: [LIANDRYS], them: [BOTRK, STRIDEBREAKER] }
		])
		deepStrictEqual(said.map(s => [s.sec, s.fact.text]), [
			[542, "Briar just finished Blade of The Ruined King"],
			[834, "Briar just finished Stridebreaker"]
		])
	})

	/*
	 * A lead is only news once it has STOPPED being the event that opened it. Saying "he's a full
	 * item up" ten seconds after naming the item he finished is the same news in worse words —
	 * the same reasoning as the 150-second hold on the unspent-gold fact in `live-facts.ts`.
	 */
	it("waits for a lead to stand before calling it a lead", () => {
		const opened = 834
		const said = replay(
			ticksEvery6(500, opened + LEAD_MIN_HELD_SEC + 60, sec => ({
				me: [LIANDRYS],
				them: sec < opened ? [BOTRK] : [BOTRK, STRIDEBREAKER]
			}))
		)
		const lead = said.find(s => s.fact.kind === "items-behind")
		ok(lead, "the standing lead is eventually said")
		ok(lead.sec >= opened + LEAD_MIN_HELD_SEC, `said at ${lead.sec}, lead opened at ${opened}`)
		strictEqual(lead.fact.text, "Briar is a full item up on you, 2 to 1")
	})

	/*
	 * The line the module exists for. In `split-03.ndjson` the enemy jungler was a full item up
	 * from 13:54 to 20:07 — six minutes and thirteen seconds of game clock — and this
	 * is the only sentence in the app that can say so.
	 *
	 * It is a SEPARATE line from the plain one, with its own budget, because folding the duration
	 * into the plain line made all 18 lines the four games produced say "for the last 2 minutes":
	 * the clause fired the instant the hold threshold passed, so it only ever reported the
	 * threshold back at him.
	 */
	it("says how long a lead has stood, once it has stood a long time", () => {
		const opened = 834
		const said = replay(
			ticksEvery6(500, opened + LEAD_LONG_SEC + 120, sec => ({
				me: [LIANDRYS],
				them: sec < opened ? [BOTRK] : [BOTRK, STRIDEBREAKER]
			}))
		)
		const texts = said.filter(s => s.fact.kind === "items-behind").map(s => s.fact.text)
		deepStrictEqual(texts, [
			"Briar is a full item up on you, 2 to 1",
			"Briar has been a full item up on you for 5 minutes, 2 to 1"
		])
	})

	it("says the same lead at most twice, however long it stands", () => {
		const said = replay(
			ticksEvery6(500, 3000, sec => ({
				me: [LIANDRYS],
				them: sec < 834 ? [BOTRK] : [BOTRK, STRIDEBREAKER]
			}))
		)
		strictEqual(said.filter(s => s.fact.kind === "items-behind").length, 2)
	})

	/* Rule 6 of the persona: credit the good stuff, unprompted. The race runs both ways. */
	it("says it when HE is the one ahead", () => {
		const said = replay(
			ticksEvery6(500, 900, sec => ({
				me: sec < 542 ? [BF_SWORD] : [LIANDRYS, RIFTMAKER],
				them: [BOTRK]
			}))
		)
		const praise = said.find(s => s.fact.kind === "items-ahead")
		ok(praise)
		strictEqual(praise.fact.text, "you're a full item up on Briar, 2 to 1")
	})

	/*
	 * A lead already standing when watching began has no duration and is still worth saying.
	 * Suppressing it would silence the fact for exactly the games this app records from mid-game.
	 */
	it("states a lead it did not watch open, without claiming how long", () => {
		const said = replay(ticksEvery6(844, 1100, () => ({ me: [LIANDRYS], them: [BOTRK, STRIDEBREAKER] })))
		const lead = said.find(s => s.fact.kind === "items-behind")
		ok(lead)
		strictEqual(lead.fact.text, "Briar is a full item up on you, 2 to 1")
	})

	/*
	 * An item this table cannot classify moves the count by one in a direction that is invisible
	 * to the listener. Silence is the only safe answer — but the item he was WATCHED finishing is
	 * still safe to name, because that sentence does not depend on the rest of the inventory.
	 */
	it("refuses to compare counts when an item cannot be classified", () => {
		const mystery: TempoItem = { itemID: 424242, displayName: "Patchday Special", consumable: false }
		const said = replay(
			ticksEvery6(500, 1400, sec => ({
				me: [LIANDRYS],
				them: sec < 542 ? [BF_SWORD, mystery] : [BOTRK, STRIDEBREAKER, mystery]
			}))
		)
		deepStrictEqual(said.map(s => s.fact.kind), ["counterpart-finished", "counterpart-finished"])
	})

	it("keeps its own floor between two race lines", () => {
		const mem = newItemTempoMemory()
		const said = replay(
			ticksEvery6(500, 2000, sec => ({
				me: [LIANDRYS],
				them:
					sec < 700 ? [BOTRK]
					: sec < 1400 ? [BOTRK, STRIDEBREAKER]
					: [BOTRK, STRIDEBREAKER, RIFTMAKER]
			})),
			mem
		)
		const races = said.filter(s => s.fact.kind !== "counterpart-finished")
		ok(races.length >= 2, "a lead that grows earns a second line")
		for (let i = 1; i < races.length; i++)
			ok(races[i]!.sec - races[i - 1]!.sec >= TEMPO_GAP_SEC, `${races[i]!.sec} came too soon after ${races[i - 1]!.sec}`)
	})

	it("counts neither boots, nor wards, nor potions as items", () => {
		const mem = newItemTempoMemory()
		replay(
			[
				{ sec: 500, me: [BF_SWORD], them: [BF_SWORD] },
				{ sec: 900, me: [LIANDRYS, STEELCAPS, WARD, POTION], them: [BOTRK, STEELCAPS, WARD] }
			],
			mem
		)
		strictEqual(mem.me.completed.length, 1)
		strictEqual(mem.counterpart.completed.length, 1)
		strictEqual(mem.me.boots, "Plated Steelcaps")
	})

	it("says nothing at all before there is a counterpart", () => {
		deepStrictEqual(replay([{ sec: 600, me: [LIANDRYS], them: null }]), [])
	})

	/* Every line carries the subject the caller alternates on, and the tier it is paced by. */
	it("tags every line as a standing build fact", () => {
		const said = replay(
			ticksEvery6(500, 1200, sec => ({ me: [LIANDRYS], them: sec < 542 ? [BF_SWORD] : [BOTRK, STRIDEBREAKER] }))
		)
		ok(said.length > 0)
		for (const { fact } of said) {
			strictEqual(fact.subject, "build")
			strictEqual(fact.tier, "standing")
		}
	})

	/* Nothing here may ever become a gold figure or a shopping instruction. */
	it("never speaks a gold number and never says what to buy", () => {
		const said = replay(
			ticksEvery6(500, 2000, sec => ({
				me: [LIANDRYS],
				them: sec < 542 ? [BF_SWORD] : [BOTRK, STRIDEBREAKER]
			}))
		)
		ok(said.length > 0)
		for (const { fact } of said) {
			ok(!/gold|\bg\b/i.test(fact.text), fact.text)
			ok(!/\bbuy|build|rush|back and\b/i.test(fact.text), fact.text)
		}
	})
})
