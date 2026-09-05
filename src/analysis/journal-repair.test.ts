/**
 * The repair is only worth having if it can be checked against a game we still hold the raw feed
 * for. The last block does exactly that: game 5635467422 has BOTH 42 stored blocks and the
 * verbatim `allgamedata` samples they were rendered from, so every repaired kill can be looked up
 * in the real event feed. If a repaired name is not in that feed, the repair invented it.
 *
 * The rest pins the shapes that actually appear in the stored blocks — including the two that look
 * like bugs and are not: Viego wearing a possessed champion, and an account the client reports
 * with no riot ID at all.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { gameNameOf, repairBlock, repairEventLine, rosterDrift } from "./journal-repair.ts"
import type { RepairRosterEntry } from "./journal-repair.ts"

const p = (
	participantId: number,
	teamId: number,
	championName: string,
	riotId: string,
	isUser = false
): RepairRosterEntry => ({ participantId, teamId, championName, riotId, isUser })

/** The real roster of game 5635104242, riot IDs and all. */
const ROSTER: RepairRosterEntry[] = [
	p(1, 100, "Aatrox", "Love you My#Kmyoi"),
	p(2, 100, "Trundle", "ParisNumberOne#NA1"),
	p(3, 100, "Locke", "Lolking4560#4560"),
	p(4, 100, "Tristana", "Turdle#poodl"),
	p(5, 100, "Lux", "Saint Pablo#9956"),
	p(6, 200, "Nasus", "MambaX#NA2"),
	p(7, 200, "Lillia", "Gooskaffur#NA1", true),
	p(8, 200, "Sion", "IMPLEMENT IP BAN#IPBAN"),
	p(9, 200, "Ezreal", "liverman#NA1"),
	p(10, 200, "Jarvan IV", "dbacks#FEET")
]

describe("gameNameOf", () => {
	it("takes everything before the first hash", () => {
		strictEqual(gameNameOf("Gooskaffur#NA1"), "Gooskaffur")
		strictEqual(gameNameOf("Love you My#Kmyoi"), "Love you My")
	})

	it("survives an id the client reported with no name at all", () => {
		// Measured: the Live Client Data API served `riotId: "#"` for one real account.
		strictEqual(gameNameOf("#"), "")
		strictEqual(gameNameOf(""), "")
	})
})

describe("repairEventLine", () => {
	it("replaces the summoner names the old renderer leaked, verbatim from one real block", () => {
		const r = repairEventLine(
			"Love you My killed MambaX; Saint Pablo killed dbacks; liverman killed Saint Pablo; ParisNumberOne killed liverman; Love you My killed Gooskaffur; Earth dragon taken by ParisNumberOne",
			ROSTER
		)
		strictEqual(
			r.text,
			"Aatrox killed Nasus; Lux killed Jarvan IV; Ezreal killed Lux; Trundle killed Ezreal; Aatrox killed Lillia; Earth dragon taken by Trundle"
		)
		strictEqual(r.byRiotId, 11)
		strictEqual(r.unresolved.length, 0)
	})

	it("leaves a turret line alone — it carries no name", () => {
		const line = "turret down (Turret_TChaos_L1_P4_392430785_0)"
		strictEqual(repairEventLine(line, ROSTER).text, line)
	})

	it("does not rewrite the words of the template when a player is named after one", () => {
		// A substring pass over " taken by " would have turned this into "ta Lux by Trundle".
		const roster = [...ROSTER, p(11, 100, "Zed", "ken#NA1")]
		strictEqual(
			repairEventLine("Baron taken by ParisNumberOne", roster).text,
			"Baron taken by Trundle"
		)
	})

	it("splits on the ' killed ' that leaves two names it recognises", () => {
		const roster = [p(1, 100, "Zed", "he killed me#NA1", false), p(2, 200, "Lux", "Gooskaffur#NA1", true)]
		strictEqual(repairEventLine("he killed me killed Gooskaffur", roster).text, "Zed killed Lux")
	})

	it("counts a name that was already a champion separately, and never as a mapping", () => {
		// The client serves some accounts with the champion name in `summonerName` and no riot id.
		const roster = [...ROSTER.slice(0, 9), p(10, 200, "Smolder", "Lilixovy#NA1")]
		const r = repairEventLine("Smolder killed Gooskaffur", roster)
		strictEqual(r.text, "Smolder killed Lillia")
		strictEqual(r.byChampionName, 1)
		strictEqual(r.byRiotId, 1)
	})

	it("turns a name from no game on record into the sentinel, never into a champion", () => {
		const r = repairEventLine("Nightblue3 killed Gooskaffur", ROSTER)
		strictEqual(r.text, "someone killed Lillia")
		deepStrictEqual(r.unresolved, ["Nightblue3"])
	})

	it("drops a kill in which neither side resolves, exactly as the shipped renderer does", () => {
		const r = repairEventLine("Minion_T200L2S78N0464 killed Nightblue3; Love you My killed MambaX", ROSTER)
		strictEqual(r.text, "Aatrox killed Nasus")
		strictEqual(r.dropped, 1)
	})
})

const BLOCK = `## Ground truth (from the game client — these are FACTS, the screenshot is not)

Clock 15:01.

You: Lillia lv9 1/3/0, 100 CS, 1703/1703 HP, 29g

Your team: Nasus lv9 1/4/0 · Sion lv11 2/4/1 · Ezreal lv8 1/3/2 · Jarvan IV lv8 2/3/1

Enemy team: Aatrox lv13 5/1/0 · Trundle lv10 5/0/2 · Locke lv11 3/2/3 · Tristana lv9 3/1/2 · Lux lv8 1/3/5

Alive right now: 5 of yours against 5 of theirs.

Just happened: Love you My killed MambaX; Earth dragon taken by ParisNumberOne

### Nothing he is missing right now
`

describe("repairBlock", () => {
	it("rewrites the event line and touches nothing else", () => {
		const r = repairBlock(BLOCK, ROSTER)
		strictEqual(
			r.block,
			BLOCK.replace(
				"Just happened: Love you My killed MambaX; Earth dragon taken by ParisNumberOne",
				"Just happened: Aatrox killed Nasus; Earth dragon taken by Trundle"
			)
		)
		ok(r.changed)
		// Every other line is byte-identical: the repair may not invent a figure either.
		strictEqual(r.block.includes("You: Lillia lv9 1/3/0, 100 CS, 1703/1703 HP, 29g"), true)
	})

	it("reports no change on a block that had no events yet", () => {
		const early = BLOCK.replace(/\nJust happened: .*\n/, "\n")
		strictEqual(repairBlock(early, ROSTER).changed, false)
	})
})

describe("rosterDrift", () => {
	it("is silent when the stored roster matches the post-game participants in order", () => {
		deepStrictEqual(rosterDrift(BLOCK, ROSTER), [])
	})

	it("reports a possessed champion rather than quietly correcting it", () => {
		/*
		 * The real case: 22 stored blocks in game 5635166661 put `Varus` and then `Lillia` — the
		 * player's OWN champion — in the enemy jungler's slot, seconds after `Viego killed
		 * Gooskaffur`. Viego wears whoever he possesses and the client reports what is on screen,
		 * so this is a faithful record and a rewrite would be the fabrication.
		 */
		const drifted = BLOCK.replace("Trundle lv10 5/0/2", "Lillia lv10 5/0/2")
		deepStrictEqual(rosterDrift(drifted, ROSTER), [
			{ side: "enemies", slot: 1, shown: "Lillia", expected: "Trundle" }
		])
		// And the block itself comes back untouched.
		strictEqual(repairBlock(drifted, ROSTER).block.includes("Lillia lv10 5/0/2"), true)
	})
})
