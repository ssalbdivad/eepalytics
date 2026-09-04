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
	campsPerMin: stat(5.3),
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
		strictEqual(at10.filter(n => /roughly/.test(n.text)).length, 0)
	})

	it("fills the gap between checkpoints, and says it is approximate", () => {
		const mid = run({ gameTimeSec: 7 * 60, cs: 20 })
		const rough = mid.find(n => /roughly/.test(n.text))
		ok(rough, "expected a rough pace nudge mid-game")
		ok(/approximate/.test(rough!.source), "the approximation must be declared in the source")
	})

	it("stays silent in the first four minutes, where the estimate means nothing", () => {
		strictEqual(run({ gameTimeSec: 150, cs: 0 }).filter(n => n.kind === "pace").length, 0)
	})
})

describe("early deaths", () => {
	it("names a single early death", () => {
		const n = run({ gameTimeSec: 300, deaths: 1 })
		ok(n.some(x => x.kind === "safety"))
	})

	it("credits the focus area when deaths is the standing problem", () => {
		const n = run({ gameTimeSec: 300, deaths: 1 }, [{ category: "deaths", games: 15, fixes: ["back off"] }])
		ok(n.find(x => x.kind === "safety")!.source.includes("15 games"))
	})

	it("stops once the early game is over", () => {
		strictEqual(run({ gameTimeSec: 20 * 60, deaths: 1 }).filter(n => n.kind === "safety").length, 0)
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
})
