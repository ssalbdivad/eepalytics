/**
 * The item table and the arithmetic over it.
 *
 * Every case here is a REAL inventory, read out of `data/live-samples/*.ndjson` at the game clock
 * of a line a judge marked false. The ids and the gold figures are not made up for the test — they
 * are the payload the coach actually held when it said the thing it should not have said.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { buildTargets, inventoryOf, isBoots, itemOf, nextSpike, roleOf } from "./items.ts"
import { ITEM_ROWS } from "./item-table.ts"

/* The ids in the moments below, named so the cases read as inventories rather than as numbers. */
const MOSSTOMPER = 1103
const FATED_ASHES = 2508
const HAUNTING_GUISE = 3147
const GLOWING_MOTE = 2022
const STEALTH_WARD = 3340
const LIANDRYS = 6653
const PLATED_STEELCAPS = 3047
const AMPLIFYING_TOME = 1052
const FIENDISH_CODEX = 3108
const RUBY_CRYSTAL = 1028
const GLUTTONOUS_GREAVES = 3008
const NEEDLESSLY_LARGE_ROD = 1058
const BF_SWORD = 1038
const DARK_SEAL = 1082
const RIFTMAKER = 4633
const HUBRIS = 6697
const GUNMETAL_GREAVES = 3172

describe("the item table", () => {
	it("carries the recipe total, which is the number the live feed does not have", () => {
		/*
		 * The whole reason this module exists. `price` in the live payload is `gold.base`, which
		 * for Liandry's Torment is 800 on a 3,000g item — measured equal on all 215 items this app
		 * has ever observed, in `scripts/fetch-items.ts`.
		 */
		strictEqual(itemOf(LIANDRYS)?.base, 800)
		strictEqual(itemOf(LIANDRYS)?.total, 3000)
	})

	it("says it has never heard of an id rather than guessing at one", () => {
		strictEqual(itemOf(999_999), null)
		strictEqual(roleOf(999_999), "unknown")
	})

	it("is big enough to be the real table and not a fixture", () => {
		ok(ITEM_ROWS.length > 200, `${ITEM_ROWS.length} rows`)
	})
})

describe("what counts as a finished item", () => {
	it("calls the legendaries finished and the expensive raw components components", () => {
		/*
		 * THE OLD RULE, restated as a test so it cannot come back. `price >= 2000` put Liandry's
		 * Torment (800), Riftmaker (950) and Hubris (750) on the wrong side of the line and
		 * Needlessly Large Rod (1200) and B. F. Sword (1300) on the other wrong side. Every one of
		 * these five assertions fails under it.
		 */
		strictEqual(roleOf(LIANDRYS), "completed")
		strictEqual(roleOf(RIFTMAKER), "completed")
		strictEqual(roleOf(HUBRIS), "completed")
		strictEqual(roleOf(NEEDLESSLY_LARGE_ROD), "component")
		strictEqual(roleOf(BF_SWORD), "component")
	})

	it("counts boots apart, the way a player counts them", () => {
		strictEqual(roleOf(PLATED_STEELCAPS), "boots")
		strictEqual(roleOf(GLUTTONOUS_GREAVES), "boots")
	})

	it("finds boots by the recipe, because the Boots tag is not on all of them", () => {
		/*
		 * Gunmetal Greaves is a boot upgrade tagged `NonbootsMovement` and nothing else in the
		 * current patch. A tag-based classifier calls it a finished item and his item count is one
		 * too high for the rest of the game.
		 */
		ok(isBoots(GUNMETAL_GREAVES))
		strictEqual(roleOf(GUNMETAL_GREAVES), "boots")
	})

	it("keeps a trinket and a component out of the item count", () => {
		strictEqual(roleOf(STEALTH_WARD), "trinket")
		strictEqual(roleOf(FATED_ASHES), "component")
		strictEqual(roleOf(DARK_SEAL), "component")
	})

	it("does not count a jungle pet or a Doran's as an item", () => {
		/*
		 * A starter has no recipe and nothing to build into, so a recipe-only classifier calls it
		 * finished — and then every item count from 0:00 onwards is one too high, which is exactly
		 * what "your second item" was being graded against. `STARTING_GOLD` is the line, and it is
		 * the game's own number rather than one chosen to fit.
		 */
		strictEqual(roleOf(MOSSTOMPER), "starter", "Mosstomper Seedling")
		strictEqual(roleOf(1054), "starter", "Doran's Shield")
		strictEqual(roleOf(1083), "starter", "Cull")
	})

	it("still counts a TRANSFORMED item, which also has no recipe", () => {
		/*
		 * Seraph's Embrace is what a Tear becomes: no recipe, nothing to build into, 2,900g and
		 * unmistakably an item. `purchasable` is what separates it from a starter, and it is the
		 * shop's own answer rather than a gold threshold doing two jobs.
		 */
		strictEqual(itemOf(3040)?.purchasable, false)
		strictEqual(roleOf(3040), "completed", "Seraph's Embrace")
		strictEqual(roleOf(3042), "completed", "Muramana")
	})
})

/**
 * THE TWO MOMENTS. Both of these are stored payloads that produced a line a judge marked false.
 */
describe("the moments that produced the false build lines", () => {
	it("10:39 — two thirds of a Liandry's, and the exact gold to finish it", () => {
		/*
		 * `js-mtvxb5f4-f81a-t29819114` at 10:39, gold 1,067. The coach said "you have enough gold
		 * to finish your full Liandry's right now"; the judge marked it false, reasoning that
		 * 1,067g could not finish Liandry's from a Haunting Guise. Neither of them could check it,
		 * because the payload named the items and nothing else.
		 *
		 * He held BOTH components. Liandry's was 800g away and he had 1,067. The line was true and
		 * unverifiable, which is the same as false to anybody downstream — this is the arithmetic
		 * that makes it neither.
		 */
		const held = [MOSSTOMPER, FATED_ASHES, HAUNTING_GUISE, GLOWING_MOTE, STEALTH_WARD]
		const inv = inventoryOf(held)
		deepStrictEqual(
			inv.components.map(i => i.name),
			["Fated Ashes", "Haunting Guise", "Glowing Mote"]
		)
		strictEqual(inv.completed.length, 0, "a jungle pet is not a finished item")
		deepStrictEqual(
			inv.starters.map(i => i.name),
			["Mosstomper Seedling"]
		)
		const [top] = buildTargets(held)
		strictEqual(top?.name, "Liandry's Torment")
		strictEqual(top?.remaining, 800)
		strictEqual(top?.covered, 2200)
		deepStrictEqual(top?.missing, [], "every remaining piece is already in his bags")
	})

	it("18:34 — one finished item and boots, which is what 'your second item' meant", () => {
		/*
		 * `js-mtvxb5f4-f81a-t29819114` at 18:34. The coach said "keep farming toward your second
		 * item"; the judge marked it false because "item count already exceeds 'second item'" —
		 * counting the six ROWS. One of those rows is a trinket, one is boots and three are
		 * components. He had exactly one finished item, and the line was right.
		 */
		const held = [
			PLATED_STEELCAPS,
			LIANDRYS,
			AMPLIFYING_TOME,
			FIENDISH_CODEX,
			RUBY_CRYSTAL,
			STEALTH_WARD
		]
		const inv = inventoryOf(held)
		strictEqual(held.length, 6, "six rows")
		strictEqual(inv.completed.length, 1, "one finished item")
		strictEqual(inv.boots?.name, "Plated Steelcaps")
		strictEqual(inv.components.length, 3)
		strictEqual(inv.trinket?.name, "Stealth Ward")
	})
})

describe("buildTargets", () => {
	it("orders by what he has already sunk in, not by what is left", () => {
		/*
		 * At 10:39 the cheapest thing to finish was a 550g Kindlegem off a Glowing Mote. The thing
		 * he was BUILDING was an 800g Liandry's with 2,200g of his gold already inside it. Sorted
		 * by what is left, the coach names the Kindlegem — true, and useless.
		 */
		const targets = buildTargets([MOSSTOMPER, FATED_ASHES, HAUNTING_GUISE, GLOWING_MOTE])
		strictEqual(targets[0]?.name, "Liandry's Torment")
		ok(
			targets.some(t => t.remaining < targets[0]!.remaining),
			"there is a cheaper target, and it is not first"
		)
	})

	it("never names something he already owns", () => {
		const targets = buildTargets([LIANDRYS, FATED_ASHES, HAUNTING_GUISE])
		strictEqual(
			targets.some(t => t.name === "Liandry's Torment"),
			false
		)
	})

	it("says what is still to be BOUGHT, separately from what is left to pay", () => {
		// A lone Fiendish Codex: Horizon Focus still needs raw components, so a back does not
		// finish it however much gold he is carrying.
		const targets = buildTargets([FIENDISH_CODEX])
		const horizon = targets.find(t => t.name === "Horizon Focus")
		ok(horizon !== undefined, targets.map(t => t.name).join(", "))
		ok(horizon!.missing.length > 0, "pieces still have to be bought")
		strictEqual(horizon!.covered, 850)
	})

	it("returns nothing at all when he holds no components", () => {
		deepStrictEqual(buildTargets([LIANDRYS, RIFTMAKER, STEALTH_WARD]), [])
	})

	it("pays for a repeated component twice unless he holds two", () => {
		/*
		 * Shattered Armguard's recipe names Amplifying Tome TWICE. A pool that is a set rather
		 * than a multiset spends one tome against both slots and reports the item 400g cheaper
		 * than it is — an understatement, which is the direction that gets a man sent to base for
		 * something he cannot buy.
		 */
		const CLOTH_ARMOR = 1029
		deepStrictEqual([...itemOf(2421)!.from], [AMPLIFYING_TOME, CLOTH_ARMOR, AMPLIFYING_TOME])
		const one = buildTargets([AMPLIFYING_TOME, CLOTH_ARMOR]).find(t => t.name === "Shattered Armguard")
		const two = buildTargets([AMPLIFYING_TOME, AMPLIFYING_TOME, CLOTH_ARMOR]).find(
			t => t.name === "Shattered Armguard"
		)
		ok(one !== undefined && two !== undefined)
		strictEqual(one.remaining - two.remaining, itemOf(AMPLIFYING_TOME)!.total)
	})
})

describe("nextSpike", () => {
	it("skips the sub-recipes and names the item a back is actually for", () => {
		/*
		 * Replayed over the recorded games, the unfiltered top row produced "Fiendish Codex is 200
		 * gold away" and "Hextech Alternator is 300 gold away" — true, cheap, and not a reason to
		 * walk to the fountain.
		 */
		const held = [LIANDRYS, PLATED_STEELCAPS, AMPLIFYING_TOME, FIENDISH_CODEX, RUBY_CRYSTAL]
		const cheapest = buildTargets(held).reduce((a, b) => (a.remaining <= b.remaining ? a : b))
		strictEqual(roleOf(cheapest.id), "component", `${cheapest.name} is the cheapest and is a part`)
		const spike = nextSpike(held)
		ok(spike !== null)
		ok(
			roleOf(spike.id) === "completed" || roleOf(spike.id) === "boots",
			`${spike.name} is ${roleOf(spike.id)}`
		)
	})

	it("is null when nothing he holds feeds a finished item", () => {
		strictEqual(nextSpike([LIANDRYS, STEALTH_WARD]), null)
	})
})

/**
 * There is no `goldSpent` and there must not be one.
 *
 * Summing `price` recovers a median 0.3 of gold truly spent; summing `total` over held items is a
 * different quantity — the worth of his current bags — and neither is the number. A module that
 * exports one invites a sentence that cannot be true.
 */
describe("the number that is deliberately absent", () => {
	it("exports nothing that looks like gold spent", async () => {
		const mod = (await import("./items.ts")) as Record<string, unknown>
		deepStrictEqual(
			Object.keys(mod).filter(k => /spent|spend/i.test(k)),
			[]
		)
	})
})
