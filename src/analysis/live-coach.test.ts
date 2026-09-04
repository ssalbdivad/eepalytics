/**
 * The live coach speaks while a game is running, which makes being wrong far more costly than
 * being quiet: he acts on it immediately and cannot check it. These pin the places where it is
 * allowed to speak at all.
 */

import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { liveNudges } from "./live-coach.ts"
import type { LiveCoachInput, LiveState } from "./live-coach.ts"
import type { Baseline } from "./index.ts"

const stat = (mean: number, n = 20) => ({ mean, sd: mean / 4, n, median: mean, min: 0, max: 0 })

const baseline = {
	"cs@10": stat(66),
	csPerMin: stat(5.3),
	deaths: stat(5.6)
} as unknown as Baseline

const live = (over: Partial<LiveState> = {}): LiveState => ({
	gameTimeSec: 600,
	championName: "Lillia",
	cs: 66,
	deaths: 0,
	kills: 0,
	assists: 0,
	level: 6,
	observed: { dragonSec: null, baronSec: null, heraldSec: null },
	...over
})

const run = (over: Partial<LiveState> = {}, focus: LiveCoachInput["focus"] = []) =>
	liveNudges({ live: live(over), baseline, focus })

describe("objective timers", () => {
	it("only fires for a take actually observed", () => {
		const none = run({ gameTimeSec: 700 })
		ok(!none.some(n => n.kind === "objective"), "must not invent a timer from the clock alone")

		const seen = run({ gameTimeSec: 5 * 60 + 260, observed: { dragonSec: 300, baronSec: null, heraldSec: null } })
		ok(seen.some(n => n.kind === "objective" && /Drake up in/.test(n.text)))
	})

	it("stays quiet outside the 90-second window", () => {
		// Taken at 5:00, so due at 10:00. At 6:00 that is four minutes out — too far to be useful.
		const early = run({ gameTimeSec: 360, observed: { dragonSec: 300, baronSec: null, heraldSec: null } })
		ok(!early.some(n => n.kind === "objective"))
	})
})

describe("farm pace", () => {
	it("uses the exact baseline at a checkpoint", () => {
		const n = run({ gameTimeSec: 600, cs: 40 })
		const pace = n.find(x => x.kind === "pace")
		ok(pace, "expected a pace nudge at 10:00")
		ok(pace!.text.includes("66"), `should quote the measured average: ${pace!.text}`)
	})

	it("says nothing when the player is on pace", () => {
		strictEqual(run({ gameTimeSec: 600, cs: 66 }).filter(n => n.kind === "pace").length, 0)
	})

	/** The approximation must not shout over the measurement it is standing in for. */
	it("does not run the rough estimate next to a checkpoint", () => {
		const at10 = run({ gameTimeSec: 600, cs: 10 })
		strictEqual(at10.filter(n => /interpolated/.test(n.source)).length, 0)
	})

	it("fills the gap between checkpoints, and says it is approximate", () => {
		const mid = run({ gameTimeSec: 7 * 60, cs: 20 })
		// Matched on the SOURCE, not on a word in the prose — the wording is copy and moves.
		const rough = mid.find(n => /interpolated/.test(n.source))
		ok(rough, "expected a rough pace nudge mid-game")
		ok(/approximate/.test(rough!.source), "the approximation must be declared in the source")
	})

	/**
	 * The comparison must measure the same quantity the scoreboard reports.
	 *
	 * `live.cs` is creepScore — lane minions AND camps. The baseline used to be `campsPerMin`,
	 * which counts camps only, so `expected` came out ~20% low (53 against a measured 66 at
	 * 10:00) and the overlay went quiet exactly when he was behind.
	 */
	it("expects camps AND lane minions, not camps alone", () => {
		const at10 = run({ gameTimeSec: 600, cs: 40 })
		const pace = at10.find(n => n.kind === "pace")
		ok(pace, "expected a pace nudge")
		ok(pace!.text.includes("66"), `must use the measured cs@10 mean: ${pace!.text}`)
		ok(!pace!.text.includes("53"), "must not use a camps-only rate")
	})

	it("stays silent in the first four minutes, where the estimate means nothing", () => {
		strictEqual(run({ gameTimeSec: 150, cs: 0 }).filter(n => n.kind === "pace").length, 0)
	})
})

/**
 * The nudges that were removed, pinned so they do not come back.
 *
 * Both read as situational awareness and were nothing of the sort: they attached a generic fix
 * mined from past reviews to a live moment the app cannot see. Nothing here knows positions,
 * cooldowns or what the team is doing.
 */
describe("no ungrounded coaching", () => {
	it("says nothing about deaths, however many there are", () => {
		const many = run({ gameTimeSec: 20 * 60, deaths: 7, cs: 200 }, [
			{ category: "deaths", games: 15, fixes: ["back off instead of pushing one more camp"] }
		])
		strictEqual(many.length, 0, `expected silence, got: ${many.map(n => n.text).join(" | ")}`)
	})

	it("never repeats a fix mined from past games as if it were about this one", () => {
		const n = run({ gameTimeSec: 7 * 60, cs: 5, deaths: 4 }, [
			{ category: "deaths", games: 15, fixes: ["back off instead of pushing one more camp"] }
		])
		ok(
			!n.some(x => x.text.includes("back off instead of pushing one more camp")),
			"a history fix must not be presented as live advice"
		)
	})

	it("still reports the farm gap, which is a real measurement", () => {
		const n = run({ gameTimeSec: 7 * 60, cs: 5, deaths: 4 })
		ok(n.some(x => x.kind === "pace"))
	})
})

describe("quiet is a valid answer", () => {
	it("returns nothing when a game is going normally", () => {
		strictEqual(run({ gameTimeSec: 8 * 60, cs: 45, deaths: 0 }).length, 0)
	})

	it("never returns more than three", () => {
		const busy = run(
			{ gameTimeSec: 5 * 60 + 250, cs: 0, deaths: 3, observed: { dragonSec: 300, baronSec: null, heraldSec: null } },
			[{ category: "deaths", games: 15, fixes: ["back off"] }]
		)
		ok(busy.length <= 3, `overlay must stay glanceable, got ${busy.length}`)
	})

	it("is silent through a normal game rather than filling the space", () => {
		strictEqual(run({ gameTimeSec: 12 * 60, cs: 106, deaths: 2 }).length, 0)
	})
})
