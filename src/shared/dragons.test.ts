/**
 * "they took the fire dragon" reached the player out loud. The API's element words are not the
 * names of the drakes, and shipping them made the coach sound like it had never played the game.
 */

import { strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { dragonName, dragonPhrase } from "./dragons.ts"

describe("dragon names", () => {
	it("translates every element the API actually sends", () => {
		strictEqual(dragonName("Fire"), "Infernal")
		strictEqual(dragonName("Water"), "Ocean")
		strictEqual(dragonName("Earth"), "Mountain")
		strictEqual(dragonName("Air"), "Cloud")
		strictEqual(dragonName("Hextech"), "Hextech")
		strictEqual(dragonName("Chemtech"), "Chemtech")
		strictEqual(dragonName("Elder"), "Elder")
	})

	it("is not fooled by casing or stray whitespace from the feed", () => {
		strictEqual(dragonName(" fire "), "Infernal")
		strictEqual(dragonName("AIR"), "Cloud")
	})

	it("refuses to guess at an unknown type", () => {
		// A new elemental would otherwise be announced by Riot's internal word.
		strictEqual(dragonName("Quantum"), null)
		strictEqual(dragonPhrase("Quantum"), "the dragon")
		strictEqual(dragonPhrase(undefined), "the dragon")
	})

	it("says it the way a player says it", () => {
		strictEqual(dragonPhrase("Fire"), "Infernal drake")
		strictEqual(dragonPhrase("Elder"), "Elder dragon")
	})
})
