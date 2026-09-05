import { describe, it } from "node:test"
import { strictEqual, ok } from "node:assert"
import {
	sayNumber,
	sayDuration,
	sayMinutes,
	sayGold,
	sayCs,
	sayLevel,
	sayClock,
	sayDigitsIn
} from "./say-numbers.ts"
import { normalizeNumbers, numbersIn } from "../analysis/coach-score.ts"

describe("sayNumber", () => {
	it("says the small numbers a jungler actually hears", () => {
		strictEqual(sayNumber(0), "zero")
		strictEqual(sayNumber(9), "nine")
		strictEqual(sayNumber(18), "eighteen")
		strictEqual(sayNumber(20), "twenty")
		strictEqual(sayNumber(52), "fifty-two")
		strictEqual(sayNumber(100), "one hundred")
		strictEqual(sayNumber(220), "two hundred twenty")
	})

	it("says gold-sized numbers", () => {
		strictEqual(sayNumber(1000), "one thousand")
		strictEqual(sayNumber(1334), "one thousand three hundred thirty-four")
		strictEqual(sayNumber(17000), "seventeen thousand")
	})

	it("rounds and drops a sign rather than emitting a word the normaliser cannot read", () => {
		strictEqual(sayNumber(-4), "four")
		strictEqual(sayNumber(4.6), "five")
	})
})

describe("units", () => {
	it("spells the unit that was heard as nonsense out loud", () => {
		// "52s" was spoken as "fifty two seds" and "1334g" as a letter, in a real game.
		strictEqual(sayDuration(52), "fifty-two seconds")
		strictEqual(sayGold(1334), "one thousand three hundred thirty-four gold")
	})

	it("keeps the unit singular when there is one of it", () => {
		strictEqual(sayDuration(1), "one second")
		strictEqual(sayMinutes(1), "one minute")
		strictEqual(sayMinutes(4), "four minutes")
	})

	it("stays in seconds under two minutes, because that is how a respawn is counted", () => {
		strictEqual(sayDuration(119), "one hundred nineteen seconds")
		strictEqual(sayDuration(120), "two minutes")
		strictEqual(sayDuration(150), "two minutes thirty seconds")
	})

	it("leaves CS as two letters, which is how every League player says it", () => {
		strictEqual(sayCs(52), "fifty-two CS")
		strictEqual(sayLevel(11), "level eleven")
	})
})

describe("sayClock", () => {
	it("says a clock the way a caster does", () => {
		strictEqual(sayClock(14 * 60 + 32), "fourteen thirty-two")
		strictEqual(sayClock(14 * 60 + 5), "fourteen oh five")
		strictEqual(sayClock(14 * 60), "fourteen minutes even")
	})

	it("keeps a spoken clock from summing into one invented figure", () => {
		// The scorer splits two adjacent unit/teen words for exactly this reason.
		const parsed = numbersIn(sayClock(14 * 60 + 12))
		ok(parsed.includes(14) && parsed.includes(12), `got ${JSON.stringify(parsed)}`)
		ok(!parsed.includes(26), "fourteen twelve must not become 26")
	})
})

describe("sayDigitsIn", () => {
	it("rewrites bare figures in text this app did not compose", () => {
		strictEqual(sayDigitsIn("Briar is 14 CS up on you"), "Briar is fourteen CS up on you")
	})

	it("leaves a decimal and a digit glued to a letter alone", () => {
		// "Jarvan IV" is fine; "2.5" read digit-run by digit-run gets worse, not better.
		strictEqual(sayDigitsIn("that is 2.5k gold"), "that is 2.5k gold")
		strictEqual(sayDigitsIn("lv11 is not a word"), "lv11 is not a word")
	})
})

describe("round-trip through the scorer's normaliser", () => {
	/*
	 * THE load-bearing property. `analysis/coach-score.ts` decides whether the coach fabricated a
	 * figure by word-normalising the line and comparing integers. If a number this module writes
	 * does not read back as itself, every fact carrying it scores as an invention and the
	 * instrument silently starts lying about the model.
	 */
	it("reads every plausible figure back as itself", () => {
		const bad: string[] = []
		for (let n = 0; n <= 400; n++) if (numbersIn(sayNumber(n)).join() !== String(n)) bad.push(`${n} -> ${sayNumber(n)}`)
		for (const n of [500, 999, 1000, 1017, 1180, 1334, 1966, 2874, 3150, 12_500, 19_999])
			if (numbersIn(sayNumber(n)).join() !== String(n)) bad.push(`${n} -> ${sayNumber(n)}`)
		strictEqual(bad.join(" | "), "")
	})

	it("reads a whole fact-shaped sentence back to the same integers", () => {
		const line = `Briar is down ${sayDuration(52)} and you have ${sayGold(1334)} unspent`
		strictEqual(numbersIn(line).join(), "52,1334")
		ok(normalizeNumbers(line).includes("52 seconds"))
	})
})
