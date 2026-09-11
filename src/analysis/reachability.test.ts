/**
 * Reachability, pinned against the one game we have both halves of.
 *
 * Everything below the unit block runs on `__fixtures__/reachability-5639406342.json`, which is the
 * real game: the accepted minimap reads the live coach actually held, the post-game timeline's
 * exact positions, and the move speed the client actually reported. The point of a real-data test
 * here is not coverage. It is that the ONLY way to know whether `distance / moveSpeed` is a
 * defensible statement about a League map is to check it against a game, and a fixture written from
 * memory would have reproduced whatever the author already believed.
 *
 * Two of these assertions are load-bearing evidence rather than regression guards, and the numbers
 * in them are reported verbatim in the work that added this file:
 *
 *   - THE FLOOR HOLDS. Across all 435 ordered pairs of timeline frames, the predicted straight-line
 *     travel time never exceeded the time that actually elapsed. Worst ratio 0.934. If the unit
 *     scale or the units-per-second reading were wrong by any material factor this would fail, and
 *     it is also the check that says a detour multiplier is NOT warranted.
 *   - THE READ'S AGE IS THE BINDING CONSTRAINT. At the 15s read cadence of the recorded game, a
 *     read bounds the distance to the drake pit on 27% of turns. At the browser's existing 5s
 *     journal beat it would bound it on 88%. That is the same finding the position-supply work
 *     measured, restated in the currency of this fact.
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, test } from "node:test"
import { dist, fromMinimapPct, NEXUS, PITS } from "../shared/map.ts"
import { buildBrief } from "../shared/live-brief.ts"
import type { ReachLine } from "../shared/live-brief.ts"
import { buildReach, MIN_USABLE_MOVE_SPEED, OBJECTIVE_PITS, pitFor } from "./reachability.ts"

/* ================================================================ the fixture */

interface Fixture {
	note: string
	team: 100
	reads: Array<{ t: number; left: number; top: number; label: string }>
	frames: Array<{ t: number; x: number; y: number }>
	speeds: Array<{ t: number; ms: number; dead: boolean; respawn: number }>
}

const fx: Fixture = JSON.parse(
	readFileSync(new URL("./__fixtures__/reachability-5639406342.json", import.meta.url), "utf8")
)

const speedAt = (t: number) => fx.speeds.filter(s => s.t <= t).at(-1) ?? fx.speeds[0]!
const readAt = (t: number) => fx.reads.filter(r => r.t <= t).at(-1) ?? null
const frameNearest = (t: number) =>
	fx.frames.reduce((b, f) => (Math.abs(f.t - t) < Math.abs(b.t - t) ? f : b))

/* ================================================================ arithmetic */

describe("the arithmetic", () => {
	/* A read placed exactly on the drake pit's own coordinates, so the distance is zero by
	 * construction and any transform error shows up as a non-zero number. */
	const pitPct = (() => {
		const { x, y } = PITS.DRAGON
		/* toMinimapPct's inverse is fromMinimapPct; go through map.ts rather than re-deriving. */
		const left = ((x - -120) / (14870 - -120)) * 100
		const top = (1 - (y - -120) / (14980 - -120)) * 100
		return { left, top }
	})()

	test("a read on the pit is zero units from the pit", () => {
		const [r] = buildReach({
			now: 100,
			read: { pct: pitPct, atSec: 100 },
			moveSpeed: 350,
			dead: false,
			respawnSec: 0,
			team: 100,
			targets: [{ label: "Drake", pos: PITS.DRAGON, atSec: 140 }]
		})
		assert.ok(r!.units !== null && r!.units < 5)
	})

	test("seconds are units over move speed, and the margin is the window minus that", () => {
		/* Blue fountain to the drake pit is a fixed distance; assert against it directly so the test
		 * fails if either constant moves. */
		const d = dist(NEXUS[100], PITS.DRAGON)
		const [r] = buildReach({
			now: 100,
			read: null,
			moveSpeed: 400,
			dead: true,
			respawnSec: 20,
			team: 100,
			targets: [{ label: "Drake", pos: PITS.DRAGON, atSec: 200 }]
		})
		assert.equal(r!.origin, "fountain")
		assert.equal(r!.driftUnits, 0)
		assert.equal(r!.ageSec, null)
		assert.ok(Math.abs(r!.units! - d) < 1)
		assert.ok(Math.abs(r!.etaMinSec! - (20 + d / 400)) < 0.01)
		/* No drift, so the two etas and the two margins collapse to one number each. */
		assert.equal(r!.etaMinSec, r!.etaMaxSec)
		assert.ok(Math.abs(r!.marginMinSec! - (100 - r!.etaMinSec!)) < 0.01)
	})

	test("death beats a fresh read, because the corpse is about to leave", () => {
		/* A read placed in the enemy base: if the corpse's position were used the distance would be
		 * enormous, and the fountain distance is what a respawn actually costs. */
		const [r] = buildReach({
			now: 500,
			read: { pct: { left: 90, top: 10 }, atSec: 499 },
			moveSpeed: 350,
			dead: true,
			respawnSec: 25,
			team: 100,
			targets: [{ label: "Baron", pos: PITS.BARON, atSec: 600 }]
		})
		assert.equal(r!.origin, "fountain")
		assert.ok(Math.abs(r!.units! - dist(NEXUS[100], PITS.BARON)) < 1)
		assert.equal(r!.delaySec, 25)
	})

	test("a dead red-side player starts from the RED fountain", () => {
		const [r] = buildReach({
			now: 500,
			read: null,
			moveSpeed: 350,
			dead: true,
			respawnSec: 10,
			team: 200,
			targets: [{ label: "Drake", pos: PITS.DRAGON, atSec: 600 }]
		})
		assert.ok(Math.abs(r!.units! - dist(NEXUS[200], PITS.DRAGON)) < 1)
	})

	test("no position and no speed both produce nulls rather than a number", () => {
		const targets = [{ label: "Drake", pos: PITS.DRAGON, atSec: 600 }]
		const [noRead] = buildReach({ now: 500, read: null, moveSpeed: 350, dead: false, respawnSec: 0, team: 100, targets })
		assert.equal(noRead!.units, null)
		assert.equal(noRead!.origin, null)
		assert.equal(noRead!.constrained, false)
		const [noSpeed] = buildReach({
			now: 500,
			read: { pct: { left: 20, top: 80 }, atSec: 500 },
			moveSpeed: MIN_USABLE_MOVE_SPEED - 1,
			dead: false,
			respawnSec: 0,
			team: 100,
			targets
		})
		assert.equal(noSpeed!.etaMinSec, null)
		assert.equal(noSpeed!.speed, null)
	})

	test("a row comes back for every target, including the ones it cannot answer", () => {
		const rs = buildReach({
			now: 500,
			read: null,
			moveSpeed: null,
			dead: false,
			respawnSec: 0,
			team: 100,
			targets: [
				{ label: "Drake", pos: PITS.DRAGON, atSec: 600 },
				{ label: "Baron", pos: PITS.BARON, atSec: 1200 }
			]
		})
		assert.deepEqual(rs.map(r => r.label), ["Drake", "Baron"])
	})

	test("pitFor knows NEXT's four labels and nothing else", () => {
		assert.deepEqual(pitFor("Drake"), PITS.DRAGON)
		assert.deepEqual(pitFor("Rift Herald"), PITS.HERALD)
		assert.deepEqual(pitFor("Voidgrubs"), PITS.GRUBS)
		assert.deepEqual(pitFor("Baron"), PITS.BARON)
		assert.equal(pitFor("Scuttle"), null)
		/* Baron, Herald and the grubs share the north-west pit; drake is alone in the south-east. */
		assert.ok(dist(OBJECTIVE_PITS.Baron, OBJECTIVE_PITS["Rift Herald"]) < 600)
		assert.ok(dist(OBJECTIVE_PITS.Baron, OBJECTIVE_PITS.Drake) > 7000)
	})
})

/* ================================================================ the age rule */

describe("the read's age", () => {
	/*
	 * THE RULE IS DERIVED, NOT PICKED: a read constrains a trip exactly when it is younger than the
	 * trip is long. Nobody chose 30 seconds or 10; the crossover is `units / speed`, and these two
	 * cases sit either side of it on the same read.
	 */
	const at = { pct: { left: 10, top: 90 }, atSec: 0 }
	const target = { label: "Drake", pos: PITS.DRAGON, atSec: 999 }
	const d = dist(fromMinimapPct(10, 90), PITS.DRAGON)
	const speed = 400
	const crossover = d / speed

	test("younger than the trip: the distance is bounded and a number is available", () => {
		const [r] = buildReach({ now: crossover - 2, read: at, moveSpeed: speed, dead: false, respawnSec: 0, team: 100, targets: [target] })
		assert.equal(r!.constrained, true)
		assert.ok(r!.etaMinSec! > 0)
	})

	test("older than the trip: the read no longer bounds anything", () => {
		const [r] = buildReach({ now: crossover + 2, read: at, moveSpeed: speed, dead: false, respawnSec: 0, team: 100, targets: [target] })
		assert.equal(r!.constrained, false)
		/* The near edge of the drift circle is the pit itself, so the floor is zero — which is true,
		 * and is precisely why the renderer prints nothing instead of printing it. */
		assert.equal(r!.etaMinSec, 0)
	})

	test("a 136-second-old read yields no usable bound at any real speed", () => {
		/* 136s is the measured median staleness of a reactive turn's last accepted read. */
		const [r] = buildReach({ now: 136, read: at, moveSpeed: 333.3, dead: false, respawnSec: 0, team: 100, targets: [target] })
		assert.equal(r!.constrained, false)
		assert.ok(r!.driftUnits > 45000)
	})
})

/* ================================================================ the real game */

describe("game 5639406342", () => {
	test("the straight-line floor is never beaten: 435 timeline pairs, 0 violations", () => {
		let pairs = 0
		let violations = 0
		let worst = 0
		for (let i = 0; i < fx.frames.length; i++)
			for (let j = i + 1; j < fx.frames.length; j++) {
				const gap = fx.frames[j]!.t - fx.frames[i]!.t
				const v = speedAt(fx.frames[j]!.t).ms
				if (v < MIN_USABLE_MOVE_SPEED) continue
				pairs++
				const ratio = dist(fx.frames[i]!, fx.frames[j]!) / v / gap
				if (ratio > worst) worst = ratio
				if (ratio > 1) violations++
			}
		assert.equal(pairs, 435)
		assert.equal(violations, 0)
		/*
		 * 0.934 is the tightest the game ever came to the floor. It is close enough to 1 to say the
		 * floor is ATTAINABLE — which is the measurement that argues against multiplying it by a
		 * detour factor, because a factor would rule out pits he demonstrably reaches.
		 */
		assert.ok(worst > 0.9 && worst < 1, `worst ratio ${worst}`)
	})

	test("read cadence, not carry, decides whether a number exists", () => {
		const share = (cadence: number, pit: { x: number; y: number }): number => {
			let n = 0
			let bounded = 0
			for (const r of fx.reads) {
				const v = speedAt(r.t).ms
				if (v < MIN_USABLE_MOVE_SPEED) continue
				n++
				if (dist(fromMinimapPct(r.left, r.top), pit) > cadence * v) bounded++
			}
			return bounded / n
		}
		/* The cadence the recorded game actually ran at. */
		assert.ok(Math.abs(share(15, PITS.DRAGON) - 0.27) < 0.02, String(share(15, PITS.DRAGON)))
		/* The beat the browser already posts journal frames on. Same reads, same speeds. */
		assert.ok(Math.abs(share(5, PITS.DRAGON) - 0.88) < 0.02, String(share(5, PITS.DRAGON)))
		assert.ok(share(5, PITS.BARON) > share(15, PITS.BARON))
	})

	/*
	 * SIX REAL SPAWNS, at the clock a coach would have spoken: 45s of lead. The spawn times are the
	 * schedule crossed with the game's own `ELITE_MONSTER_KILL` log — drake 1 at 5:00, grubs at
	 * 8:00, herald at 15:00 and baron at 20:00 are the map's schedule; the two drake respawns are
	 * the kills at 7:19 and 15:41 plus the standard 5:00.
	 */
	const MOMENTS = [
		{ name: "Drake 1", pit: PITS.DRAGON, spawn: 300 },
		{ name: "Voidgrubs", pit: PITS.GRUBS, spawn: 480 },
		{ name: "Drake 2", pit: PITS.DRAGON, spawn: 739 },
		{ name: "Rift Herald", pit: PITS.HERALD, spawn: 900 },
		{ name: "Drake 3", pit: PITS.DRAGON, spawn: 1121 },
		{ name: "Baron", pit: PITS.BARON, spawn: 1200 }
	] as const

	const atMoment = (m: (typeof MOMENTS)[number], lead = 45) => {
		const now = m.spawn - lead
		const read = readAt(now)
		const s = speedAt(now)
		return buildReach({
			now,
			read: read === null ? null : { pct: { left: read.left, top: read.top }, atSec: read.t },
			moveSpeed: s.ms,
			dead: s.dead,
			respawnSec: s.respawn,
			team: 100,
			targets: [{ label: m.name, pos: m.pit, atSec: m.spawn }]
		})[0]!
	}

	test("the six moments: two carried a bounded number, four did not, and the four say why", () => {
		const bounded = MOMENTS.filter(m => atMoment(m).constrained).map(m => m.name)
		/*
		 * Drake 1 (a 3s-old read) and Drake 3 (a 1s-old read) are the two turns in the whole set
		 * where the read was fresher than the walk. Every other turn's read was 8-30s old against a
		 * trip of 4-21s, and the arithmetic refuses rather than guessing. This is the finding, not a
		 * shortfall of the module.
		 */
		assert.deepEqual(bounded, ["Drake 1", "Drake 3"])
	})

	test("Drake 3 at 17:56: a 1s-old read, 7231 units, 9-12s against a 45s clock", () => {
		const r = atMoment(MOMENTS[4]!)
		assert.equal(r.origin, "minimap")
		assert.ok(Math.abs(r.units! - 7231) < 5, String(r.units))
		assert.ok(Math.abs(r.speed! - 694) < 1, String(r.speed))
		assert.ok(r.etaMinSec! > 8 && r.etaMaxSec! < 13)
		/* Both margins positive: he beats the spawn however the drift falls. */
		assert.ok(r.marginMinSec! > 30)
	})

	test("Baron at 19:15: a 30s-old read is 15,719 units of drift and no number", () => {
		const r = atMoment(MOMENTS[5]!)
		assert.equal(r.constrained, false)
		assert.ok(r.driftUnits > 15000)
		/* And the truth: he was 1,567 units from the baron pit when it spawned. The read could not
		 * have told anyone that, which is the honest report, not a failure of the arithmetic. */
		assert.ok(dist(frameNearest(1200), PITS.BARON) < 1800)
	})
})

/* ================================================================ rendering */

describe("the rendered clause", () => {
	const samples = readFileSync(new URL("../shared/__fixtures__/live-brief-sample.ndjson", import.meta.url), "utf8")
		.trim()
		.split("\n")
		.map(l => JSON.parse(l) as { gameTime: number; data: unknown })

	const briefWith = (reach: ReachLine[] | null): string =>
		buildBrief({ raw: samples[1]!, gameTimeSec: 280, reach })!.text

	const line = (over: Partial<ReachLine>): ReachLine => ({
		label: "Drake",
		origin: "minimap",
		ageSec: 4,
		units: 4100,
		driftUnits: 1400,
		constrained: true,
		speed: 358,
		delaySec: 0,
		etaMinSec: 7.5,
		etaMaxSec: 15.4,
		marginMinSec: 24.6,
		marginMaxSec: 32.5,
		windowSec: 40,
		...over
	})

	test("it lands on the objective's own line, not in a section of its own", () => {
		const text = briefWith([line({})])
		const drake = text.split("\n").find(l => l.startsWith("- Drake ("))
		assert.ok(drake, "no drake line")
		assert.match(drake!, /4100 units/)
		assert.match(drake!, /358 move speed right now/)
		assert.match(drake!, /before it spawns/)
		assert.match(drake!, /Floor: the line ignores walls and the speed is this instant's\./)
		/* The timer and the travel time are one sentence. That is the join. */
		assert.match(drake!, /in \d+s\./)
	})

	test("it says nothing at all when the read cannot bound the distance", () => {
		const text = briefWith([line({ constrained: false })])
		const drake = text.split("\n").find(l => l.startsWith("- Drake ("))!
		assert.ok(!drake.includes("units"), `quoted a distance from an unbounded read: ${drake}`)
		assert.match(text, /NOT COMPUTABLE/)
		assert.match(text, /you could have covered/)
	})

	test("an unmatched label changes nothing", () => {
		const text = briefWith([line({ label: "Scuttle" })])
		assert.equal(text, briefWith(null))
	})

	test("the dead form has no range and no age, because it has neither", () => {
		const text = briefWith([
			line({ origin: "fountain", ageSec: null, delaySec: 22, driftUnits: 0, etaMinSec: 39, etaMaxSec: 39, marginMinSec: 1, marginMaxSec: 1, units: 6300 })
		])
		const drake = text.split("\n").find(l => l.startsWith("- Drake ("))!
		assert.match(drake, /DEAD for 22s/)
		assert.match(drake, /from your fountain/)
		assert.ok(!drake.includes("old"), "quoted an age on a fountain origin")
	})

	test("arriving late is said as arriving late", () => {
		const text = briefWith([line({ etaMinSec: 60, etaMaxSec: 70, marginMinSec: -30, marginMaxSec: -20 })])
		assert.match(text, /after it spawns/)
	})

	test("a straddle is written as a straddle", () => {
		const text = briefWith([line({ etaMinSec: 30, etaMaxSec: 50, marginMinSec: -10, marginMaxSec: 10 })])
		assert.match(text, /somewhere between .* early and .* late/)
	})

	test("the silence note is not evicted by the corpse list below it", () => {
		/*
		 * `fit` drops from the END, and this note used to be appended after `- Down right now (...)`.
		 * At 19:10 of game 5639406342 the budget ate it, and a turn that had an account of its own
		 * silence rendered as a turn with nothing to say.
		 */
		const text = briefWith([line({ constrained: false })])
		const ls = text.split("\n")
		const note = ls.findIndex(l => l.startsWith("Distance to "))
		const down = ls.findIndex(l => l.startsWith("- Down right now"))
		assert.ok(note !== -1, "the note was evicted")
		if (down !== -1) assert.ok(note < down, "the note sits behind the corpse list")
	})

	test("no clause exceeds the budget it is charged", () => {
		/* The dead form with a margin is the longest shape the renderer emits. */
		const longest = briefWith([
			line({ origin: "fountain", ageSec: null, delaySec: 22, driftUnits: 0, etaMinSec: 39.4, etaMaxSec: 39.4, marginMinSec: 1.2, marginMaxSec: 1.2, units: 6300 })
		])
			.split("\n")
			.find(l => l.startsWith("- Drake ("))!
		const clause = longest.slice(longest.indexOf(" You: "))
		assert.ok(clause.length <= 230, `${clause.length} chars: ${clause}`)
	})

	test("no reach at all leaves the brief byte-identical", () => {
		assert.equal(briefWith(null), buildBrief({ raw: samples[1]!, gameTimeSec: 280 })!.text)
	})
})
