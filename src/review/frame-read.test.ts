/**
 * The pure half of the minimap read, pinned.
 *
 * Two things are being defended here and they fail in opposite directions.
 *
 * The FENCE (`parseFrameRead`, `frameReadFaults`) must refuse. Every closed answer in this design is
 * only closed because the parser drops what falls outside the enumeration — a schema is a request,
 * not a guarantee, and a value that got repaired quietly instead of dropped would be a fabricated
 * enemy position wearing a valid zone name.
 *
 * The GEOMETRY (`zoneLabel`, `zoneAtMinimapPct`, the anchors) must agree with `shared/map.ts`. The
 * thirteen labels are not typed out anywhere — they are produced by calling `zoneOf` on a point
 * inside each zone — so an anchor that drifted into a neighbouring zone would silently rename a
 * whole enum entry and every read filed under it. That is exactly the kind of change nothing else
 * would catch, so it is asserted against `classifyZone` here rather than trusted.
 *
 * `scripts/probe-minimap.ts` is tested from this file for the same reason `probe-vision.ts` is:
 * `pnpm test` runs the `src` glob and nothing else, and a probe whose scorer is wrong produces a
 * number that looks measured.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { TEAM_BLUE, TEAM_RED } from "../shared/constants.ts"
import { classifyZone, zoneOf } from "../shared/map.ts"
import type { Zone } from "../shared/map.ts"
import {
	ACTIVITIES,
	NOT_VISIBLE,
	READ_ZONES,
	UNSURE,
	agreementOf,
	anchorZone,
	asFrameRead,
	coarseOf,
	forTeam,
	frameReadFaults,
	frameReadSchema,
	isTrustworthy,
	minimapRect,
	parseFrameRead,
	parseFrameReadXY,
	pctOf,
	truthFromState,
	zoneAtMinimapPct,
	zoneFromLabel,
	zoneLabel,
	zoneLabels
} from "./frame-read.ts"
import type { FrameRead, FrameTruth } from "./frame-read.ts"
import { blockClockSec, handZones, matchIcons, pct, truthFromBlock } from "../../scripts/probe-minimap.ts"

/* ------------------------------------------------------------------ geometry */

describe("the thirteen zones", () => {
	it("puts every anchor inside the zone it is filed under", () => {
		for (const zone of READ_ZONES) strictEqual(anchorZone(zone), zone, `anchor for ${zone}`)
	})

	it("names them with map.ts's own words and never invents one", () => {
		// If this list ever changes, it changed in `map.ts` — which is the point of deriving it.
		deepStrictEqual(zoneLabels(), [
			"blue-side base",
			"red-side base",
			"blue-side jungle (top)",
			"blue-side jungle (bot)",
			"red-side jungle (top)",
			"red-side jungle (bot)",
			"top lane",
			"mid lane",
			"bot lane",
			"river (top)",
			"river (bot)",
			"dragon pit",
			"baron pit"
		])
	})

	it("gives thirteen distinct labels, so a label always names one zone", () => {
		strictEqual(new Set(zoneLabels()).size, READ_ZONES.length)
	})

	it("takes each label straight from zoneOf rather than a second spelling", () => {
		strictEqual(zoneLabel("DRAGON_PIT"), zoneOf({ x: 9973, y: 4578 }))
		strictEqual(zoneLabel("LANE_MID"), zoneOf({ x: 7420, y: 7420 }))
	})

	it("refuses a label it does not know instead of guessing the nearest", () => {
		strictEqual(zoneFromLabel("mid lane"), "LANE_MID")
		strictEqual(zoneFromLabel("the mid lane"), null)
		strictEqual(zoneFromLabel("enemy jungle"), null)
		strictEqual(zoneFromLabel(""), null)
	})
})

describe("forTeam", () => {
	it("leaves a blue player's read alone", () => {
		for (const zone of READ_ZONES) strictEqual(forTeam(zone, TEAM_BLUE), zone)
	})

	it("swaps own and enemy ground for a red player, and only that ground", () => {
		strictEqual(forTeam("OWN_JUNGLE_TOP", TEAM_RED), "ENEMY_JUNGLE_TOP")
		strictEqual(forTeam("ENEMY_JUNGLE_BOT", TEAM_RED), "OWN_JUNGLE_BOT")
		strictEqual(forTeam("OWN_BASE", TEAM_RED), "ENEMY_BASE")
		// Shared ground. A lane is a lane from both sides and flipping it would be a lie.
		for (const shared of ["LANE_TOP", "LANE_MID", "LANE_BOT", "RIVER_TOP", "RIVER_BOT", "DRAGON_PIT", "BARON_PIT"] as Zone[])
			strictEqual(forTeam(shared, TEAM_RED), shared)
	})

	it("round-trips, so a flip is never lossy", () => {
		for (const zone of READ_ZONES) strictEqual(forTeam(forTeam(zone, TEAM_RED), TEAM_RED), zone)
	})
})

describe("minimapRect", () => {
	it("cuts the measured square out of the shipped grab size", () => {
		deepStrictEqual(minimapRect(1536, 864), { x: 1246, y: 574, w: 288, h: 288 })
	})

	it("scales with the frame, because the grab size is not a promise", () => {
		const r = minimapRect(3072, 1728)
		deepStrictEqual(r, { x: 2492, y: 1148, w: 576, h: 576 })
	})
})

describe("zoneAtMinimapPct", () => {
	/*
	 * The corners are the calibration: the minimap does not rotate, so blue's base is bottom-left and
	 * red's is top-right in every frame. If this ever inverts, every zone in every read inverts with
	 * it and nothing else in the pipeline would notice.
	 */
	it("puts blue's base bottom-left and red's top-right", () => {
		strictEqual(zoneAtMinimapPct(4, 96), "OWN_BASE")
		strictEqual(zoneAtMinimapPct(96, 4), "ENEMY_BASE")
	})

	it("puts the pits where the map says they are", () => {
		// Baron in the top-left river, dragon in the bottom-right.
		strictEqual(zoneAtMinimapPct(34, 30), "BARON_PIT")
		strictEqual(zoneAtMinimapPct(67, 69), "DRAGON_PIT")
	})

	it("agrees with classifyZone, which is the function that owns this", () => {
		for (const [left, top] of [[50, 50], [20, 20], [80, 80], [10, 60], [90, 30]] as [number, number][])
			strictEqual(
				zoneAtMinimapPct(left, top),
				classifyZone(
					{
						x: -120 + (left / 100) * 14990,
						y: -120 + (1 - top / 100) * 15100
					},
					TEAM_BLUE
				)
			)
	})
})

describe("pctOf", () => {
	it("converts Gemini's 0-1000 pointing units, and nothing downstream sees a thousandth", () => {
		deepStrictEqual(pctOf({ x: 500, y: 250 }), { left: 50, top: 25 })
	})
})

describe("coarseOf", () => {
	it("has an answer for every zone, so a read can always be coarsened", () => {
		for (const zone of READ_ZONES) strictEqual(typeof coarseOf(zone), "string")
	})

	it("files each pit with the half of the map it decides", () => {
		strictEqual(coarseOf("BARON_PIT"), "topside")
		strictEqual(coarseOf("DRAGON_PIT"), "botside")
		strictEqual(coarseOf("LANE_MID"), "mid")
		strictEqual(coarseOf("OWN_BASE"), "base")
	})
})

/* ------------------------------------------------------------------ parsing */

const CTX = { myChampion: "Lillia", enemyChampions: ["Teemo", "Kayn", "Nasus", "Yunara", "Anivia"] }

describe("parseFrameRead", () => {
	it("reads a well-formed answer", () => {
		const { read, dropped } = parseFrameRead(
			{
				enemiesOnMinimap: ["mid lane", "river (top)"],
				alliesOnMinimap: 2,
				you: "dragon pit",
				activity: "clearing",
				youChampion: "Lillia"
			},
			CTX
		)
		deepStrictEqual(dropped, [])
		deepStrictEqual(read, {
			enemiesOnMinimap: ["LANE_MID", "RIVER_TOP"],
			alliesOnMinimap: 2,
			you: "DRAGON_PIT",
			activity: "clearing",
			youChampion: "Lillia"
		})
	})

	/*
	 * The whole claim of a closed question is that an answer outside the set never reaches a
	 * sentence. A zone that got fuzzy-matched to its nearest neighbour would break that claim while
	 * looking like it held.
	 */
	it("drops a zone it was not offered rather than repairing it", () => {
		const { read, dropped } = parseFrameRead(
			{
				enemiesOnMinimap: ["mid lane", "the enemy jungle"],
				alliesOnMinimap: 1,
				you: NOT_VISIBLE,
				activity: "moving",
				youChampion: UNSURE
			},
			CTX
		)
		deepStrictEqual(read?.enemiesOnMinimap, ["LANE_MID"])
		deepStrictEqual(dropped, ["zone:the enemy jungle"])
		strictEqual(read?.you, null)
		strictEqual(read?.youChampion, null)
	})

	it("drops a champion who is not in this game — the roster is the fence", () => {
		const { read, dropped } = parseFrameRead(
			{ enemiesOnMinimap: [], alliesOnMinimap: 0, you: "mid lane", activity: "moving", youChampion: "Briar" },
			CTX
		)
		strictEqual(read?.youChampion, null)
		deepStrictEqual(dropped, ["champion:Briar"])
	})

	it("falls back to unclear for an activity outside the six", () => {
		const { read, dropped } = parseFrameRead(
			{ enemiesOnMinimap: [], alliesOnMinimap: 0, you: NOT_VISIBLE, activity: "vibing", youChampion: UNSURE },
			CTX
		)
		strictEqual(read?.activity, "unclear")
		deepStrictEqual(dropped, ["activity:vibing"])
	})

	it("says which kind of nothing came back", () => {
		strictEqual(parseFrameRead(null, CTX).rejected, "empty")
		strictEqual(parseFrameRead({ alliesOnMinimap: 1 }, CTX).rejected, "schema")
		strictEqual(parseFrameRead("PASS", CTX).rejected, "schema")
	})

	it("keeps the ally count inside the four that can exist", () => {
		const { read } = parseFrameRead(
			{ enemiesOnMinimap: [], alliesOnMinimap: 9, you: NOT_VISIBLE, activity: "moving", youChampion: UNSURE },
			CTX
		)
		strictEqual(read?.alliesOnMinimap, 4)
	})
})

describe("parseFrameReadXY", () => {
	it("turns points into zones with map.ts, not with the model", () => {
		const { read } = parseFrameReadXY(
			{
				enemiesOnMinimap: [{ x: 500, y: 500 }, { x: 40, y: 960 }],
				alliesOnMinimap: 1,
				you: { x: 670, y: 690 },
				activity: "fighting",
				youChampion: "Lillia"
			},
			CTX
		)
		deepStrictEqual(read?.enemyZones, ["LANE_MID", "OWN_BASE"])
		strictEqual(read?.youZone, "DRAGON_PIT")
	})

	/*
	 * MEASURED: asked for percentages, the model answered in pixels of the image it was sent — 21 of
	 * 24 sightings came back as things like `427,574`. Out-of-range points are dropped, never scaled
	 * to fit, because a repaired coordinate is a position this file invented.
	 */
	it("drops a point outside the square instead of clamping it onto the edge", () => {
		const { read, dropped } = parseFrameReadXY(
			{
				enemiesOnMinimap: [{ x: 1400, y: 500 }, { x: 500, y: 500 }],
				alliesOnMinimap: 0,
				you: null,
				activity: "moving",
				youChampion: UNSURE
			},
			CTX
		)
		deepStrictEqual(read?.enemyZones, ["LANE_MID"])
		deepStrictEqual(dropped, ["xy:1400,500"])
		strictEqual(read?.youZone, null)
	})

	it("hands the fence the same shape either question was asked", () => {
		const { read } = parseFrameReadXY(
			{
				enemiesOnMinimap: [{ x: 500, y: 500 }],
				alliesOnMinimap: 3,
				you: null,
				activity: "recalling",
				youChampion: "Lillia"
			},
			CTX
		)
		deepStrictEqual(asFrameRead(read!), {
			enemiesOnMinimap: ["LANE_MID"],
			alliesOnMinimap: 3,
			you: null,
			activity: "recalling",
			youChampion: "Lillia"
		})
	})
})

describe("frameReadSchema", () => {
	it("offers the model exactly the values the parser will accept", () => {
		const schema = frameReadSchema({ myChampion: "Lillia", enemyChampions: ["Kayn"] }) as {
			properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }>
		}
		deepStrictEqual(schema.properties.enemiesOnMinimap!.items!.enum, zoneLabels())
		deepStrictEqual(schema.properties.you!.enum, [...zoneLabels(), NOT_VISIBLE])
		deepStrictEqual(schema.properties.activity!.enum, [...ACTIVITIES])
		// Sorted, so the first value is not a hint. See `championChoices` — with his own champion
		// first the canary came back right 56 times out of 60 from a crop with no HUD in it.
		deepStrictEqual(schema.properties.youChampion!.enum, ["Kayn", "Lillia", UNSURE])
	})
})

/* ------------------------------------------------------------------ the fence */

const TRUTH: FrameTruth = {
	myChampion: "Lillia",
	meDead: false,
	enemiesAlive: 3,
	alliesAlive: 4,
	enemyChampions: ["Teemo", "Kayn", "Nasus", "Yunara", "Anivia"]
}

const READ: FrameRead = {
	enemiesOnMinimap: ["LANE_MID"],
	alliesOnMinimap: 2,
	you: "DRAGON_PIT",
	activity: "clearing",
	youChampion: "Lillia"
}

describe("frameReadFaults", () => {
	it("passes a read the client has not contradicted", () => {
		deepStrictEqual(frameReadFaults(READ, TRUTH), [])
		strictEqual(isTrustworthy(READ, TRUTH), true)
	})

	it("catches more enemies on the map than are alive", () => {
		const read = { ...READ, enemiesOnMinimap: ["LANE_MID", "LANE_BOT", "LANE_TOP", "RIVER_BOT"] as Zone[] }
		deepStrictEqual(frameReadFaults(read, TRUTH), [
			{ code: "more-enemies-than-alive", detail: "4 seen, 3 alive" }
		])
	})

	it("catches more allies than are alive", () => {
		deepStrictEqual(frameReadFaults({ ...READ, alliesOnMinimap: 4 }, { ...TRUTH, alliesAlive: 2 }), [
			{ code: "more-allies-than-alive", detail: "4 seen, 2 alive" }
		])
	})

	it("catches his icon being on the map while he is on the respawn screen", () => {
		deepStrictEqual(frameReadFaults(READ, { ...TRUTH, meDead: true }), [
			{ code: "you-visible-while-dead", detail: "placed in DRAGON_PIT" }
		])
	})

	/*
	 * The canary. His own champion is the easiest identification on the minimap and the only one
	 * whose answer is known for free, so getting it wrong condemns the identifications that are not
	 * checkable rather than just itself.
	 */
	it("catches reading his own champion as somebody else", () => {
		deepStrictEqual(frameReadFaults({ ...READ, youChampion: "Kayn" }, TRUTH), [
			{ code: "wrong-self-champion", detail: "Kayn for Lillia" }
		])
		strictEqual(isTrustworthy({ ...READ, youChampion: "Kayn" }, TRUTH), false)
	})

	it("does not punish an honest refusal to name him", () => {
		deepStrictEqual(frameReadFaults({ ...READ, youChampion: null }, TRUTH), [])
	})
})

describe("truthFromState", () => {
	it("narrows the live state the daemon already holds", () => {
		deepStrictEqual(
			truthFromState({
				clock: "11:06",
				me: { champion: "Lillia", dead: true },
				pace: null,
				pronounce: [],
				counterpart: null,
				allies: [{ champion: "Qiyana" }, { champion: "Vel'Koz", dead: true }],
				enemies: [{ champion: "Kayn" }, { champion: "Nasus", dead: true }],
				recentEvents: [],
				unseen: []
			}),
			{
				myChampion: "Lillia",
				meDead: true,
				enemiesAlive: 1,
				alliesAlive: 1,
				enemyChampions: ["Kayn", "Nasus"]
			}
		)
	})
})

describe("agreementOf", () => {
	it("compares each question separately, because they fail differently", () => {
		const other: FrameRead = { ...READ, you: "LANE_TOP", enemiesOnMinimap: ["LANE_BOT"] }
		deepStrictEqual(agreementOf(READ, other), {
			enemyCount: true,
			enemyZones: false,
			you: false,
			activity: true,
			youChampion: true
		})
	})

	it("does not care what order the enemies were listed in", () => {
		const a: FrameRead = { ...READ, enemiesOnMinimap: ["LANE_MID", "RIVER_TOP"] }
		const b: FrameRead = { ...READ, enemiesOnMinimap: ["RIVER_TOP", "LANE_MID"] }
		strictEqual(agreementOf(a, b).enemyZones, true)
	})
})

/* ------------------------------------------------------------------ the probe's scorer */

/**
 * A block the DAEMON wrote, copied out of `journal_frame.truthJson` and trimmed to the lines the
 * regexes touch. Hand-typed text can only prove a regex matches a shape its author had in mind.
 */
const REAL_BLOCK = `## Ground truth (from the game client — these are FACTS, the screenshot is not)

Clock 11:06.

You: Lillia lv8 2/2/1, 70 CS, 1641/1641 HP, 101 gold

Your team: Qiyana lv10 3/1/1 · Vel'Koz lv9 2/0/0 · Caitlyn lv7 1/3/0 · Leona lv7 0/2/2

Enemy team: Teemo lv8 2/4/0 · Kayn lv8 0/1/3 · Nasus lv9 1/2/0 · Yunara lv7 3/1/2 · Anivia lv7 2/0/3

Alive right now: 5 of yours against 4 of theirs.
`

describe("truthFromBlock", () => {
	it("reads the fence's facts off a block the daemon really wrote", () => {
		deepStrictEqual(truthFromBlock(REAL_BLOCK), {
			myChampion: "Lillia",
			meDead: false,
			enemiesAlive: 4,
			// "5 of yours" counts HIM, so four teammates are left to draw beside him.
			alliesAlive: 4,
			enemyChampions: ["Teemo", "Kayn", "Nasus", "Yunara", "Anivia"]
		})
	})

	it("keeps a two-word champion whole", () => {
		const block = REAL_BLOCK.replace("You: Lillia lv8", "You: Dr. Mundo lv8")
		strictEqual(truthFromBlock(block)?.myChampion, "Dr. Mundo")
	})

	it("does not subtract him from his own team when he is dead", () => {
		const block = REAL_BLOCK.replace(
			"101 gold",
			"101 gold, DEAD (respawn in 6 seconds)"
		).replace("5 of yours", "4 of yours")
		const truth = truthFromBlock(block)
		strictEqual(truth?.meDead, true)
		strictEqual(truth?.alliesAlive, 4)
	})

	/*
	 * Null, never a default. A silent no-match would score every read against a truth of zeroes and
	 * report a fabrication rate of zero — a measurement that looks clean because it measured nothing.
	 */
	it("returns null rather than zeroes when a line it needs is missing", () => {
		strictEqual(truthFromBlock("Clock 11:06."), null)
		strictEqual(truthFromBlock(REAL_BLOCK.replace(/^Alive right now.*$/m, "")), null)
	})

	it("reads the clock line the daemon writes", () => {
		strictEqual(blockClockSec(REAL_BLOCK), 11 * 60 + 6)
		strictEqual(blockClockSec("no clock here"), null)
	})
})

describe("handZones", () => {
	it("turns a click into a zone with map.ts rather than a typed-in name", () => {
		const hand = handZones("js-mtn2jrku-8ae9-13792")
		deepStrictEqual(hand?.enemies, ["RIVER_TOP", "LANE_MID"])
		strictEqual(hand?.you, "ENEMY_JUNGLE_TOP")
	})

	it("has nothing to say about a frame nobody labelled", () => {
		strictEqual(handZones("js-nope-1"), null)
	})
})

describe("matchIcons", () => {
	it("pairs each sighting with the nearest label, once", () => {
		const got = [{ x: 500, y: 500 }, { x: 200, y: 200 }]
		const matched = matchIcons(got, [[20, 20], [50, 50]])
		deepStrictEqual(matched.map(m => Math.round(m.error)), [0, 0])
		deepStrictEqual(matched.map(m => m.zone), ["LANE_MID", "OWN_JUNGLE_TOP"])
	})

	/*
	 * A sighting with nothing left to match is NOT scored as a huge distance. It is already counted
	 * as a wrong count, and charging it twice would move the median by how many icons happened to be
	 * on the map rather than by how well they were placed.
	 */
	it("stops when the labels run out rather than inventing a distance", () => {
		strictEqual(matchIcons([{ x: 500, y: 500 }, { x: 100, y: 100 }], [[50, 50]]).length, 1)
		strictEqual(matchIcons([{ x: 500, y: 500 }], []).length, 0)
	})
})

describe("pct", () => {
	it("says n/a rather than dividing by nothing", () => {
		strictEqual(pct(0, 0), "n/a")
		strictEqual(pct(3, 4), "3/4 (75%)")
	})
})
