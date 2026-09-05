/**
 * The names below are not invented. Every one was read out of `data/live-samples/*.ndjson`, which
 * is the raw `allgamedata` the daemon recorded during four real games; the counts in
 * `smite.ts` come from the same scan. The base name is the only one the old check in
 * `server/routes/live.ts` matched, and it is the minority case.
 */

import { strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import type { LivePlayer } from "./schema/live.ts"
import { hasSmite } from "./smite.ts"

const withSpells = (
	one: { displayName: string; rawDisplayName: string },
	two?: { displayName: string; rawDisplayName: string }
): LivePlayer =>
	({
		championName: "Lillia",
		summonerSpells: { summonerSpellOne: one, ...(two ? { summonerSpellTwo: two } : {}) }
	}) as unknown as LivePlayer

const FLASH = {
	displayName: "Flash",
	rawDisplayName: "GeneratedTip_SummonerSpell_SummonerFlash_DisplayName"
}

/** All five Smite spellings the client actually emitted, with their observation counts. */
const SMITES = [
	{ n: 904, displayName: "Smite", rawDisplayName: "GeneratedTip_SummonerSpell_SummonerSmite_DisplayName" },
	{
		n: 1582,
		displayName: "Primal Smite",
		rawDisplayName: "GeneratedTip_SummonerSpell_SummonerSmiteAvatarDefensive_DisplayName"
	},
	{
		n: 810,
		displayName: "Primal Smite",
		rawDisplayName: "GeneratedTip_SummonerSpell_SummonerSmiteAvatarOffensive_DisplayName"
	},
	{
		n: 702,
		displayName: "Primal Smite",
		rawDisplayName: "GeneratedTip_SummonerSpell_SummonerSmiteAvatarUtility_DisplayName"
	},
	{
		n: 886,
		displayName: "Unleashed Smite",
		rawDisplayName: "GeneratedTip_SummonerSpell_S5_SummonerSmitePlayerGanker_DisplayName"
	}
]

describe("hasSmite", () => {
	it("recognises every Smite the client emitted across four recorded games", () => {
		for (const s of SMITES)
			strictEqual(hasSmite(withSpells(FLASH, s)), true, `${s.displayName} (${s.rawDisplayName})`)
	})

	it("finds it in either slot", () => {
		strictEqual(hasSmite(withSpells(SMITES[1]!, FLASH)), true)
	})

	it("is not fooled by a laner", () => {
		strictEqual(
			hasSmite(
				withSpells(FLASH, {
					displayName: "Ignite",
					rawDisplayName: "GeneratedTip_SummonerSpell_SummonerDot_DisplayName"
				})
			),
			false
		)
	})

	it("survives a client that sends no raw name, which is the whole reason displayName is still checked", () => {
		strictEqual(hasSmite(withSpells(FLASH, { displayName: "Primal Smite", rawDisplayName: "" })), true)
	})

	it("says no when there are no spells at all", () => {
		strictEqual(hasSmite({} as unknown as LivePlayer), false)
	})

	it("the old exact-equality check matched only the base name — this is the regression it is guarding", () => {
		// Kept as a live statement of what was wrong: four of the five spellings are not "smite".
		const oldCheck = (name: string): boolean => name.toLowerCase() === "smite"
		strictEqual(SMITES.filter(s => oldCheck(s.displayName)).length, 1)
		strictEqual(SMITES.filter(s => hasSmite(withSpells(FLASH, s))).length, 5)
	})
})
