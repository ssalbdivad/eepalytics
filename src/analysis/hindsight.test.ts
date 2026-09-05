/**
 * The hindsight arithmetic, and — more importantly — the honesty rules around it.
 *
 * Two kinds of test here and they are not equally important. The first block walks the REAL
 * recorded stream (`data/live-samples/split-03.ndjson`, one 36:49 win, 363 polls) because a
 * reducer over the client's event feed is only worth anything if it agrees with a game a human
 * can check by hand: he finished 12/8/17, so eight deaths and twenty-nine kill-participations are
 * numbers the scoreboard itself asserts.
 *
 * The second block pins the FORESIGHT classification, which is the part that decides whether this
 * metric is honest or is a prophecy test. If a death eighty seconds away, at full health, at even
 * numbers, ever starts scoring as `block`, the metric has begun rewarding the coach for guessing
 * where people are — the single failure mode this app was built to prevent — and these tests are
 * the thing that catches it.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { describe, it } from "node:test"
import {
	consequencesAfter,
	factKind,
	links,
	linksKind,
	MECHANICAL_LINKS,
	regretAt,
	SITUATION_LEAD_SEC,
	tickAt,
	timelineFromSamples,
	WEIGHT
} from "./hindsight.ts"
import type { HindsightEvent, HindsightTick, Timeline } from "./hindsight.ts"

/* ------------------------------------------------------------ the real game */

const SAMPLES = "data/live-samples/split-03.ndjson"

const realTimeline = (): Timeline | null => {
	if (!existsSync(SAMPLES)) return null
	const rows = readFileSync(SAMPLES, "utf8")
		.trim()
		.split("\n")
		.map(l => JSON.parse(l) as { gameTime: number; data: unknown })
	return timelineFromSamples(rows)
}

describe("the recorded game", () => {
	/*
	 * Skipped rather than failed when the capture is absent, so a fresh clone still runs green.
	 * The capture is 363 polls of one real win and is the only place several of these numbers can
	 * come from — a synthetic fixture asserting them would be asserting itself.
	 */
	const tl = realTimeline()
	const has = tl !== null && tl.ticks.length > 0

	it("reduces every poll and every event", { skip: !has }, () => {
		strictEqual(tl!.me, "Lillia")
		strictEqual(tl!.ticks.length, 363)
		// 100 champion kills + 26 objective events in the feed; nothing else is kept.
		strictEqual(tl!.events.length, 126)
	})

	it("agrees with the scoreboard he finished on", { skip: !has }, () => {
		// He went 12/8/17. Eight deaths, and twenty-nine kills he was credited in.
		strictEqual(tl!.events.filter(e => e.onMe).length, 8)
		strictEqual(tl!.events.filter(e => e.name === "ChampionKill" && e.byMe).length, 12 + 17)
	})

	it("splits the five dragons three to two", { skip: !has }, () => {
		const drakes = tl!.events.filter(e => e.name === "DragonKill")
		strictEqual(drakes.length, 5)
		strictEqual(drakes.filter(d => d.mine === false).length, 3)
		strictEqual(drakes.filter(d => d.mine === true).length, 2)
	})

	it("reads a turret's side off the turret, not off whoever killed it", { skip: !has }, () => {
		const turrets = tl!.events.filter(e => e.name === "TurretKilled")
		strictEqual(turrets.length, 15)
		/*
		 * Every one has a side. One of them was taken by a minion wave at 35:27, whose name
		 * resolves to no player at all — reading the side off the killer would have dropped it.
		 */
		strictEqual(turrets.filter(t => t.mine === null).length, 0)
		strictEqual(turrets.filter(t => t.killer === null).length, 1)
	})

	it("never resolves an event name to the wrong side", { skip: !has }, () => {
		// The counterpart's riotId is sixteen identical CJK characters with a tag of five more,
		// while the event feed sends the bare game name. All three fields have to be tried.
		const briarKills = tl!.events.filter(e => e.name === "ChampionKill" && e.killer === "Briar")
		ok(briarKills.length > 0, "Briar's kills must resolve, or the whole feed is noise")
		ok(briarKills.every(e => e.mine === false))
	})
})

/* ------------------------------------------------------------- the synthetic */

const tick = (over: Partial<HindsightTick> = {}): HindsightTick => ({
	atSec: 600,
	me: { hp: 1800, maxHp: 1800, level: 9, cs: 100, dead: false },
	counterpart: { champion: "Briar", cs: 100, level: 9 },
	alliesAlive: 5,
	enemiesAlive: 5,
	enemiesDown: 0,
	drakeBackInSec: null,
	baronBackInSec: null,
	heraldBackInSec: null,
	...over
})

const kill = (atSec: number, over: Partial<HindsightEvent> = {}): HindsightEvent => ({
	atSec,
	name: "ChampionKill",
	mine: true,
	killer: "Lillia",
	victim: "Briar",
	assisters: [],
	byMe: false,
	onMe: false,
	...over
})

const timeline = (over: Partial<Timeline> = {}): Timeline => ({
	me: "Lillia",
	// Two ticks at the ends of a ninety-second horizon, which is all the race arithmetic needs.
	ticks: [tick({ atSec: 600 }), tick({ atSec: 690 })],
	events: [],
	...over
})

describe("consequences", () => {
	it("takes only what lands strictly after T and by T plus the horizon", () => {
		const tl = timeline({
			events: [
				kill(600, { onMe: true, mine: false }),
				kill(630, { onMe: true, mine: false }),
				kill(660, { onMe: true, mine: false })
			]
		})
		const got = consequencesAfter(tl, 600, 30)
		strictEqual(got.length, 1)
		strictEqual(got[0]!.atSec, 630)
	})

	it("keeps a fight that BEGAN inside the horizon even when its last kill lands outside", () => {
		/*
		 * Deliberate, and the one place a consequence may carry a clock past the horizon. The
		 * question the metric asks is whether the coach spoke to something while it was still
		 * open; a fight whose first kill is inside the window was open, and dropping it because
		 * the fourth body fell two seconds late would hide the biggest events in the game.
		 */
		const tl = timeline({
			events: [kill(629, { mine: false }), kill(631, { mine: false }), kill(634, { mine: false })]
		})
		const fight = consequencesAfter(tl, 600, 30).find(c => c.kind === "fight-lost")
		ok(fight, "a fight beginning at 629 is in a window that ends at 630")
		strictEqual(fight!.atSec, 634)
	})

	it("ranks by consequence, not by clock", () => {
		const tl = timeline({
			events: [
				// "Water" is what the client sends; `dragonPhrase` is what a person calls it.
				kill(610, { name: "DragonKill", mine: false, dragonType: "Water" }),
				kill(605, { name: "TurretKilled", mine: false })
			]
		})
		const got = consequencesAfter(tl, 600, 60)
		strictEqual(got[0]!.kind, "objective-lost")
		ok(got[0]!.evidence.includes("Ocean drake"))
		ok(got[0]!.weight > got[1]!.weight)
	})

	it("counts a lopsided kill cluster as one fight and an even one as none", () => {
		const lopsided = timeline({
			events: [kill(610, { mine: false }), kill(615, { mine: false }), kill(618, { mine: false })]
		})
		const fights = consequencesAfter(lopsided, 600, 60).filter(c => c.kind.startsWith("fight"))
		strictEqual(fights.length, 1)
		strictEqual(fights[0]!.kind, "fight-lost")
		ok(fights[0]!.evidence.includes("0 for 3"))
		// Without him in it, which is the fact this whole module is really for.
		ok(fights[0]!.evidence.includes("without him"))

		const even = timeline({ events: [kill(610, { mine: true }), kill(615, { mine: false })] })
		strictEqual(
			consequencesAfter(even, 600, 60).filter(c => c.kind.startsWith("fight")).length,
			0
		)
	})

	it("calls the race off the two CS figures the block already carried", () => {
		const tl = timeline({
			ticks: [
				tick({ atSec: 600, me: { hp: 1, maxHp: 1, level: 9, cs: 100, dead: false } }),
				tick({
					atSec: 690,
					me: { hp: 1, maxHp: 1, level: 9, cs: 100, dead: false },
					counterpart: { champion: "Briar", cs: 115, level: 9 }
				})
			]
		})
		const race = consequencesAfter(tl, 600, 90).find(c => c.kind === "race-lost")
		ok(race, "a fifteen-CS swing is a consequence")
		strictEqual(race!.foresight, "block")
		ok(race!.evidence.includes("from 0 to 15"))
	})
})

describe("foresight — hindsight is not fairness", () => {
	/*
	 * The rule this whole file turns on. The ground-truth block carries no position for anybody,
	 * so a death out of nowhere is not something the coach failed to warn about; scoring it as one
	 * would reward exactly the confident guessing the app exists to prevent.
	 */
	it("refuses to call an out-of-nowhere death foreseeable", () => {
		const tl = timeline({ events: [kill(690, { onMe: true, mine: false })] })
		const death = consequencesAfter(tl, 600, 90).find(c => c.kind === "my-death")!
		strictEqual(death.foresight, "none")
		ok(death.because.includes("no positions"))
	})

	it("calls a death already forming frame-only, and does not score it either way", () => {
		const tl = timeline({ events: [kill(600 + SITUATION_LEAD_SEC, { onMe: true, mine: false })] })
		const death = consequencesAfter(tl, 600, 90).find(c => c.kind === "my-death")!
		strictEqual(death.foresight, "frame-only")
		strictEqual(regretAt(tl, 600, ["anything at all"], 90).foreseeable.length, 0)
	})

	it("scores a death he was warned about by his own health bar", () => {
		const tl = timeline({
			ticks: [tick({ me: { hp: 300, maxHp: 1800, level: 9, cs: 100, dead: false } })],
			events: [kill(690, { onMe: true, mine: false })]
		})
		const death = consequencesAfter(tl, 600, 90).find(c => c.kind === "my-death")!
		strictEqual(death.foresight, "block")
		ok(death.because.includes("percent health"))
	})

	it("scores a death he was warned about by the alive counts", () => {
		const tl = timeline({
			ticks: [tick({ alliesAlive: 2, enemiesAlive: 5 })],
			events: [kill(690, { onMe: true, mine: false })]
		})
		strictEqual(consequencesAfter(tl, 600, 90).find(c => c.kind === "my-death")!.foresight, "block")
	})

	it("never credits a timer for an objective this stream has not seen taken", () => {
		/*
		 * The first drake of a game. `live-facts.ts` counts a respawn only from a take it actually
		 * observed and never assumes one from the clock, so the coach genuinely was not told this
		 * one was coming — and the metric must not pretend it was.
		 */
		const tl = timeline({ events: [kill(690, { name: "DragonKill", mine: false })] })
		const drake = consequencesAfter(tl, 600, 90).find(c => c.kind === "objective-lost")!
		strictEqual(drake.foresight, "none")
	})

	it("credits a timer it was actually handed", () => {
		const tl = timeline({
			ticks: [tick({ drakeBackInSec: 40 })],
			events: [kill(650, { name: "DragonKill", mine: false })]
		})
		const drake = consequencesAfter(tl, 600, 60).find(c => c.kind === "objective-lost")!
		strictEqual(drake.foresight, "block")
		ok(drake.because.includes("back in 40 seconds"))
	})

	it("credits an objective that has been standing up, which is the stronger signal", () => {
		const tl = timeline({
			ticks: [tick({ drakeBackInSec: -130 })],
			events: [kill(650, { name: "DragonKill", mine: false })]
		})
		const drake = consequencesAfter(tl, 600, 60).find(c => c.kind === "objective-lost")!
		strictEqual(drake.foresight, "block")
		ok(drake.because.includes("up for 130 seconds"))
	})
})

describe("classifying a ranked fact", () => {
	/*
	 * One real example of every template `buildFacts` can emit, copied from `live-facts.ts`. These
	 * strings are the script the model rephrases and deliberately carry no machine-readable tag —
	 * a `FARM:` prefix was tried and the coach read it out loud — so the classifier matches the
	 * sentence, and this test is what notices when a template is reworded into `other`.
	 */
	const CASES: [string, string][] = [
		["that fight was 0 for 3 without you, so back off and catch up", "fight"],
		["2 of them are dead — you have about 18 seconds", "window"],
		["Briar is down 28 seconds — their camps are free", "enemy-jungler-death"],
		["Drake is back in 40 seconds", "objective-timer"],
		["Baron is up NOW", "objective-timer"],
		["they took the Hextech drake", "objective-lost"],
		["they have Baron — for the next three minutes their minions push on their own", "objective-lost"],
		["they have taken 3 of the objectives and you have taken none", "objective-count"],
		["objectives are 3 to 1 against you", "objective-count"],
		["Briar is in 30 percent more of his team's kills than you are", "participation"],
		["Briar just finished Youmuu's Ghostblade", "build"],
		["you're 2 levels down on Briar", "level-gap"],
		["Briar is 2 levels up on you", "level-gap"],
		["Briar is 23 CS up on you", "race"],
		["you're 12 CS up on Briar", "race"],
		["you've pulled 14 CS back on Briar", "race"],
		["you were 21 CS down on Briar and you're ahead now", "race"],
		["you're 20 CS down on your own pace", "farm"],
		["you're roughly 14 CS up on your own pace, 193 against 179 — keep taking the free camps", "farm"],
		["1393 gold sitting unspent", "gold"],
		["2100 gold unspent for 4 minutes now", "gold"],
		["you just got a double kill", "praise"],
		["you secured the Hextech drake", "praise"],
		["you stole Baron", "praise"]
	]
	for (const [fact, kind] of CASES)
		it(`reads "${fact.slice(0, 44)}" as ${kind}`, () => strictEqual(factKind(fact), kind))

	it("distinguishes the race from the farm baseline, which share the words CS and down on", () => {
		strictEqual(factKind("Briar is 23 CS up on you"), "race")
		strictEqual(factKind("you're 20 CS down on your own pace"), "farm")
	})

	it("links gold and praise to nothing, on purpose", () => {
		deepStrictEqual(MECHANICAL_LINKS.gold, [])
		deepStrictEqual(MECHANICAL_LINKS.praise, [])
	})
})

describe("the measure", () => {
	const tl = timeline({
		ticks: [tick({ drakeBackInSec: 40 }), tick({ atSec: 690, drakeBackInSec: -50 })],
		events: [kill(650, { name: "DragonKill", mine: false })]
	})

	it("scores only the foreseeable, and names what it should have led with", () => {
		const r = regretAt(tl, 600, ["1393 gold sitting unspent"], 60)
		strictEqual(r.foreseeable.length, 1)
		strictEqual(r.target!.kind, "objective-lost")
		strictEqual(r.linked.length, 0)
		strictEqual(r.topHitTarget, false)
	})

	it("counts a line that pointed at the thing", () => {
		const r = regretAt(tl, 600, ["Drake is back in 40 seconds"], 60)
		strictEqual(r.linked.length, 1)
		strictEqual(r.topHitTarget, true)
	})

	it("does not credit a lower-ranked hit as a top hit", () => {
		const r = regretAt(tl, 600, ["1393 gold sitting unspent", "Drake is back in 40 seconds"], 60)
		strictEqual(r.linked.length, 1)
		strictEqual(r.topHitTarget, false)
	})

	it("stays quiet when nothing consequential happened", () => {
		const r = regretAt(timeline(), 600, ["1393 gold sitting unspent"], 60)
		strictEqual(r.all.length, 0)
		strictEqual(r.target, null)
	})
})

describe("housekeeping", () => {
	it("weights Baron above everything and a farm swing below it", () => {
		ok(WEIGHT.BaronKill > WEIGHT.DragonKill)
		ok(WEIGHT.DragonKill > WEIGHT["my-death"] - 1)
		ok(WEIGHT["race-lost"] < WEIGHT["my-kill"])
	})

	it("finds the tick at or before an instant, never after it", () => {
		const tl = timeline()
		strictEqual(tickAt(tl, 650)!.atSec, 600)
		strictEqual(tickAt(tl, 690)!.atSec, 690)
		strictEqual(tickAt(tl, 599), null)
	})

	it("links every fact kind to consequence kinds that exist", () => {
		const kinds = new Set([
			"my-death",
			"my-kill",
			"objective-won",
			"objective-lost",
			"fight-won",
			"fight-lost",
			"race-lost",
			"race-won"
		])
		for (const [k, v] of Object.entries(MECHANICAL_LINKS))
			for (const c of v) ok(kinds.has(c), `${k} links to unknown ${c}`)
	})

	it("links by kind alone, so a line can be checked against a consequence that already landed", () => {
		// The readout case: `probe-regret.ts` scans BACKWARD to tell "never mentioned it" apart
		// from "mentioned it once it was already gone", and needs the kind without a Consequence.
		strictEqual(linksKind("Drake is back in 40 seconds", "objective-lost"), true)
		strictEqual(linksKind("1393 gold sitting unspent", "objective-lost"), false)
	})

	it("agrees that a fact linking to nothing can never be a hit", () => {
		const c = consequencesAfter(
			timeline({ events: [kill(650, { name: "BaronKill", mine: false })] }),
			600,
			60
		)[0]!
		strictEqual(links("1393 gold sitting unspent", c), false)
	})
})
