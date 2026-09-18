/**
 * THE BUG THIS FILE EXISTS FOR: a stored settings row outranks the code default forever.
 *
 * `getSettings()` merges the settings table over `DEFAULT_SETTINGS`, which is what makes adding
 * a field migration-free. The cost is that a row, once written, can never be reached by a
 * changed default again. `PUT /api/settings` used to persist the WHOLE merged object on every
 * save, so ONE save of ONE field wrote all seventeen keys — and the `autoReviewNewGames: false`
 * frozen in that single write on 2026-09-04 switched the post-game review path off while the
 * schema, the code default and the README all still said `true`. Thirty games later, the only
 * tier of this product a human has graded had produced nothing for eight days and every place a
 * person would look agreed with itself.
 *
 * So two things are tested here, and neither is cosmetic:
 *   1. a patch persists ONLY the keys it carried (`settings.test.ts` in routes covers the wire);
 *   2. any field that is off its default can be NAMED, so the disagreement is never silent.
 *
 * Run: pnpm test
 */

import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import {
	ADVANCED_SETTING_KEYS,
	DEFAULT_SETTINGS,
	INTENSITY_STOPS,
	SIMPLE_SETTING_KEYS,
	UNEXPOSED_SETTING_KEYS,
	describeSettingsOverrides,
	nearestIntensityStop,
	settingsOverrides
} from "./settings.ts"

describe("settings overrides are visible", () => {
	it("says nothing when every field is on its default", () => {
		assert.deepEqual(settingsOverrides({ ...DEFAULT_SETTINGS }), [])
		assert.equal(describeSettingsOverrides({ ...DEFAULT_SETTINGS }), "")
	})

	it("names the field, its value AND the default it is no longer following", () => {
		// The exact shape of the outage: the flag reads false, and nothing else does.
		const s = { ...DEFAULT_SETTINGS, autoReviewNewGames: false }
		const over = settingsOverrides(s)
		assert.equal(over.length, 1)
		assert.deepEqual(over[0], { key: "autoReviewNewGames", value: false, default: true })
		// The default has to be IN the line. "autoReviewNewGames=false" on its own reads like a
		// fact about the app rather than a deviation from it, which is how it went unread.
		assert.match(describeSettingsOverrides(s), /autoReviewNewGames=false \(default true\)/)
	})

	it("reports every override, not just the first", () => {
		const s = { ...DEFAULT_SETTINGS, autoReviewNewGames: false, coachIntensity: 0.9 }
		assert.equal(settingsOverrides(s).length, 2)
	})

	it("keeps the post-game path on by default", () => {
		// The whole task. If this ever flips in code, it flips deliberately and in a diff.
		assert.equal(DEFAULT_SETTINGS.autoReviewNewGames, true)
	})
})

/**
 * THE AUDIT, kept honest by the suite rather than by whoever reads the file next.
 *
 * The Settings screen grew every week of this campaign because a new knob always had an obvious
 * place to go and never an obvious place to be refused. These three lists are that refusal, and
 * they only work if adding a field to the schema without filing it FAILS — otherwise the next
 * field lands on the first screen by default, which is exactly how the screen got here.
 */
describe("every setting is filed under exactly one exposure", () => {
	const filed = [...SIMPLE_SETTING_KEYS, ...ADVANCED_SETTING_KEYS, ...UNEXPOSED_SETTING_KEYS]

	it("covers every field in the schema", () => {
		assert.deepEqual([...filed].sort(), Object.keys(DEFAULT_SETTINGS).sort())
	})

	it("files each field once", () => {
		assert.equal(new Set(filed).size, filed.length)
	})

	it("keeps the first screen to the two knobs a person actually moves", () => {
		// Not a style rule. Two is what fits above the fold beside the key row, and every
		// addition past that has to displace one of these on the merits.
		assert.deepEqual([...SIMPLE_SETTING_KEYS], ["liveSpeakLevel", "coachIntensity"])
	})

	it("never exposes the flag that switched the review path off", () => {
		assert.ok(UNEXPOSED_SETTING_KEYS.includes("autoReviewNewGames"))
	})
})

describe("intensity reads as three stops", () => {
	it("lands the shipped default exactly on a stop", () => {
		// If the default ever moves off a stop, the screen shows a selected band that is not the
		// stored value — survivable, but it should be a deliberate diff rather than a surprise.
		assert.equal(nearestIntensityStop(DEFAULT_SETTINGS.coachIntensity), 0.8)
		assert.ok(INTENSITY_STOPS.some(s => s.value === DEFAULT_SETTINGS.coachIntensity))
	})

	it("reads an old slider value as the nearest band", () => {
		assert.equal(nearestIntensityStop(0), 0)
		assert.equal(nearestIntensityStop(0.35), 0.5)
		assert.equal(nearestIntensityStop(1), 0.8)
	})
})
