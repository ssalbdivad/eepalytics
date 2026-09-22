/**
 * THE OBJECTIVE ROWS, CHECKED AGAINST THE SCOREBOARD THAT DID NOT WRITE THEM.
 *
 * `digestObjectives` reads the TIMELINE's `ELITE_MONSTER_KILL` / `BUILDING_KILL` events. The
 * end-of-game MATCH blob independently counts the same objectives per team
 * (`teams[].dragonKills`, `.baronKills`, `.riftHeraldKills`, `.hordeKills`, `.towerKills`,
 * `.inhibitorKills`). Those two are different sections of different payloads, so joining them is
 * an OPEN loop: a test that only compared the function against its own idea of an event would
 * have passed happily while the function credited a monster nobody took to blue side, which is
 * exactly what it did until 2026-09-22.
 *
 * The corpus is the 20 real ranked games frozen in `src/analysis/__fixtures__` — 182 elite kills
 * and 281 building kills of recorded data, not a hand-written event.
 *
 * Champion names come from the test rather than from Riot: the fixture's participants carry a
 * `championId` and no name, and what is under test is WHICH SEAT a row names, so seats are named
 * `C<participantId>` and an assertion can say exactly which participant the row resolved to.
 *
 *   node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/daemon/digest.objectives.test.ts
 */

import { strictEqual, ok, deepStrictEqual } from "node:assert/strict"
import { describe, test } from "node:test"
import { loadAll } from "../analysis/__fixtures__/index.ts"
import { USER_PUUID } from "../shared/constants.ts"
import type { TeamId } from "../shared/map.ts"
import { digestObjectives } from "./digest.ts"

const all = loadAll()

/** The fixture's own participant rows, named per seat so a row's `takenByChampion` is decidable. */
const seatsOf = (match: (typeof all)[number]["match"]) =>
	match.participants.map(p => ({
		participantId: p.participantId,
		teamId: p.teamId,
		championName: `C${p.participantId}`
	}))

const userOf = (match: (typeof all)[number]["match"]) => {
	const id = match.participantIdentities.find(i => i.player?.puuid === USER_PUUID)
	ok(id, "the user is in every fixture")
	const p = match.participants.find(q => q.participantId === id.participantId)
	ok(p, "and has a participant row")
	return { participantId: p.participantId, teamId: p.teamId as TeamId }
}

const rowsFor = (f: (typeof all)[number]) => {
	const me = userOf(f.match)
	return digestObjectives(f.timeline, me.participantId, me.teamId, seatsOf(f.match))
}

const isBuilding = (kind: string): boolean => kind.endsWith("_BUILDING")

describe("digestObjectives, over the 20 recorded fixtures", () => {
	test("every row says WHAT fell — no empty kind, and a turret says which turret", () => {
		/*
		 * The regression: the LCU fills absent event fields with "", so `monsterType ?? buildingType`
		 * resolved to "" on every building and the digest shipped `- 21:01 —  taken by your team`.
		 * All 281 building rows in this corpus were in that state.
		 */
		let towers = 0
		let inhibitors = 0
		for (const f of all)
			for (const o of rowsFor(f)) {
				ok(o.kind.length > 0, `game ${f.gameId}: a row at ${o.tSec}s has no kind`)
				ok(o.subType !== "", `game ${f.gameId}: a row at ${o.tSec}s has an empty subType`)
				if (!isBuilding(o.kind)) continue
				if (o.kind === "TOWER_BUILDING") {
					towers++
					// Every turret in the corpus carries its tier, so a missing one is a defect
					// rather than the data being thin: 93 OUTER, 61 INNER, 39 BASE, 41 NEXUS.
					ok(
						typeof o.subType === "string" && o.subType.endsWith("_TURRET"),
						`game ${f.gameId}: a turret at ${o.tSec}s does not say which turret (${o.subType})`
					)
				} else {
					inhibitors++
					strictEqual(o.kind, "INHIBITOR_BUILDING")
				}
			}
		strictEqual(towers, 234)
		strictEqual(inhibitors, 47)
	})

	test("the side on every row agrees with the end-of-game scoreboard, game by game", () => {
		/*
		 * THE OPEN LOOP. `match.teams[]` counts the same objectives from a different payload, and
		 * it does not count the killer-less ones — which is the evidence that dropping them out of
		 * both sides' credit is right rather than merely cautious.
		 */
		const fields = [
			["DRAGON", "dragonKills"],
			["BARON_NASHOR", "baronKills"],
			["RIFTHERALD", "riftHeraldKills"],
			["HORDE", "hordeKills"],
			["TOWER_BUILDING", "towerKills"],
			["INHIBITOR_BUILDING", "inhibitorKills"]
		] as const

		let compared = 0
		for (const f of all) {
			const me = userOf(f.match)
			const rows = rowsFor(f)
			for (const team of f.match.teams ?? []) {
				// Rows are credited relative to the user, so read them back the same way.
				const side = team.teamId === me.teamId ? "ally" : "enemy"
				for (const [kind, field] of fields) {
					const mine = rows.filter(o => o.kind === kind && o.takenBy === side).length
					const theirs = Number((team as unknown as Record<string, number>)[field] ?? 0)
					strictEqual(
						mine,
						theirs,
						`game ${f.gameId} team ${team.teamId} ${kind}: timeline rows ${mine} vs scoreboard ${theirs}`
					)
					compared++
				}
			}
		}
		strictEqual(compared, 20 * 2 * fields.length)
	})

	test("a named champion is on the side the row credits, and is the killer's own seat", () => {
		let named = 0
		for (const f of all) {
			const me = userOf(f.match)
			const seats = new Map(seatsOf(f.match).map(s => [s.championName, s]))
			for (const o of rowsFor(f)) {
				if (o.takenByChampion === null || o.takenByChampion === undefined) continue
				named++
				const seat = seats.get(o.takenByChampion)
				ok(seat, `game ${f.gameId}: ${o.takenByChampion} is not a seat in this game`)
				strictEqual(
					o.takenBy,
					seat.teamId === me.teamId ? "ally" : "enemy",
					`game ${f.gameId}: row at ${o.tSec}s credits a side the named champion is not on`
				)
			}
		}
		// 180 of 182 elite kills and 266 of 281 buildings. The value of the whole change is this
		// ratio: before it, zero rows could name anybody.
		strictEqual(named, 446)
	})

	test("a killer-less objective is credited to NOBODY, and they are not scattered", () => {
		/*
		 * 2 of 182 elite kills in this corpus, both RIFTHERALD at exactly 19:45. Library-wide it is
		 * 27 of 1,849: 24 RIFTHERALD at 19:45 in 24 different games and 3 HORDE at 14:45 in one —
		 * zero variance in the clock, which is what says these are not takes at all. Until
		 * 2026-09-22 each of them was credited to team 100, so ~12% of his reviews were told his
		 * own team (or the enemy, depending which side he was on) had taken a Herald.
		 */
		const clocks: number[] = []
		for (const f of all)
			for (const o of rowsFor(f)) {
				if (o.takenBy !== "unattributed") continue
				clocks.push(o.tSec)
				strictEqual(o.takenByChampion, null, `game ${f.gameId}: unattributed row names a champion`)
				strictEqual(o.kind, "RIFTHERALD")
			}
		deepStrictEqual(clocks, [19 * 60 + 45, 19 * 60 + 45])
	})

	test("a building with no killer keeps its side — the losing team's own row says who lost it", () => {
		/*
		 * A turret can fall to a minion wave: 15 of 281 here, 142 of 2,945 library-wide. The event
		 * still carries `teamId`, which is the team that LOST the building, so the SIDE survives
		 * and only the NAME is missing. Degrading to less, not to nothing.
		 */
		let minionTaken = 0
		for (const f of all)
			for (const o of rowsFor(f)) {
				if (!isBuilding(o.kind) || o.takenByChampion) continue
				minionTaken++
				ok(o.takenBy === "ally" || o.takenBy === "enemy", `game ${f.gameId}: lost the side of a building`)
			}
		strictEqual(minionTaken, 15)
	})

	test("the position sample carries its distance from the objective, signed", () => {
		/*
		 * Half of these positions are where he went NEXT. Of the 463 rows here, 228 take their
		 * nearest frame from AFTER the objective, 226 from before and 9 land inside half a second
		 * of it and round to 0 — median distance 14s, p90 26s, max 30s. `confidence: "low"` can
		 * carry neither the size nor the direction, which is why the gap ships and the prompt
		 * prints it. A frame interval is 60s, so nothing may exceed 30.
		 */
		let after = 0
		let rows = 0
		const gaps: number[] = []
		for (const f of all)
			for (const o of rowsFor(f)) {
				if (o.userZone === null || o.userZone === undefined) continue
				rows++
				strictEqual(typeof o.userZoneGapSec, "number", `game ${f.gameId}: a zone with no gap beside it`)
				const gap = o.userZoneGapSec as number
				ok(Math.abs(gap) <= 30, `game ${f.gameId}: a position sample ${gap}s away, further than one frame interval`)
				gaps.push(Math.abs(gap))
				if (gap > 0) after++
			}
		strictEqual(rows, 463)
		strictEqual(after, 228)
		gaps.sort((a, b) => a - b)
		strictEqual(gaps[Math.floor(0.5 * (gaps.length - 1))], 14)
		strictEqual(gaps.at(-1), 30)
	})

	test("no timeline means no rows, and never a throw", () => {
		deepStrictEqual(digestObjectives(null, 1, 100, []), [])
	})

	test("an unknown killer seat costs the NAME and keeps the SIDE", () => {
		/*
		 * Measured 0 of 4,625 seated kills in the library, so this branch is unreachable on today's
		 * data and exists for the day a participant row is missing — a remake, a pruned blob, a
		 * scoreboard that arrived short. The ordinal convention (1-5 is team 100) is what is left,
		 * and it agreed with the participant rows on all 4,625.
		 */
		const f = all[0]
		ok(f)
		const me = userOf(f.match)
		const rows = digestObjectives(f.timeline, me.participantId, me.teamId, [])
		ok(rows.length > 0)
		const withSide = rows.filter(o => o.takenBy !== "unattributed").length
		const withName = rows.filter(o => o.takenByChampion).length
		strictEqual(withName, 0)
		strictEqual(withSide, rowsFor(f).filter(o => o.takenBy !== "unattributed").length)
	})
})
