/**
 * The spine is the picture he reads first, so the two things it must never get wrong are pinned:
 * WHICH SIDE took an objective, and WHOSE CS it is comparing.
 *
 * The second one is not hypothetical. Every enemy CS figure the live coach ever spoke came from
 * a visibility counter that read 70 against a true 183, and the comparison it produced was
 * sign-flipped for a whole game. This module reads the timeline instead, and this test is the
 * assertion that it stays that way.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { buildSpine, counterpartOf, estimatedDowntime } from "./debrief.ts"
import type { ParticipantSummary } from "../shared/schema/domain.ts"

const player = (over: Partial<ParticipantSummary>): ParticipantSummary => ({
	gameId: 1,
	participantId: 1,
	teamId: 100,
	puuid: "",
	riotId: "Him#NA1",
	championId: 0,
	championName: "Lillia",
	role: "JGL",
	roleConfidence: "high",
	isUser: true,
	kills: 0,
	deaths: 0,
	assists: 0,
	cs: 0,
	jungleCs: 0,
	gold: 0,
	visionScore: 0,
	champLevel: 1,
	damageToChampions: 0,
	win: false,
	...over
})

const him = player({ participantId: 2, cs: 23, jungleCs: 142, gold: 11142 })
const them = player({
	participantId: 7,
	teamId: 200,
	isUser: false,
	championName: "Kayn",
	riotId: "Them#NA1",
	cs: 40,
	jungleCs: 143,
	gold: 15736,
	champLevel: 16,
	kills: 18,
	deaths: 6,
	assists: 7
})
const bystander = player({ participantId: 3, isUser: false, championName: "Yone", role: "MID" })

/** Two frames and three events, enough to exercise every branch. */
const timeline = {
	frames: [
		{
			timestamp: 0,
			participantFrames: {
				"2": pf(2, 0, 500, 1),
				"7": pf(7, 0, 500, 1),
				"3": pf(3, 0, 500, 1)
			},
			events: []
		},
		{
			timestamp: 600_000,
			participantFrames: {
				"2": pf(2, 68, 3760, 7),
				"7": pf(7, 58, 4023, 6),
				"3": pf(3, 90, 4000, 8)
			},
			events: [
				{ type: "ELITE_MONSTER_KILL", timestamp: 439_100, killerId: 7, monsterType: "DRAGON", monsterSubType: "EARTH_DRAGON", position: { x: 9973, y: 4578 } },
				{ type: "ELITE_MONSTER_KILL", timestamp: 500_000, killerId: 2, monsterType: "RIFTHERALD", position: { x: 5012, y: 10470 } },
				{ type: "CHAMPION_KILL", timestamp: 480_300, killerId: 7, victimId: 2, position: { x: 7000, y: 7000 }, assistingParticipantIds: [] },
				{ type: "CHAMPION_KILL", timestamp: 212_000, killerId: 2, victimId: 7, position: { x: 7000, y: 7000 }, assistingParticipantIds: [] }
			]
		}
	]
}

function pf(id: number, cs: number, gold: number, level: number) {
	return {
		participantId: id,
		level,
		minionsKilled: 0,
		jungleMinionsKilled: cs,
		totalGold: gold,
		currentGold: Math.round(gold / 3),
		xp: gold * 2,
		position: { x: 5500, y: 5600 }
	}
}

describe("counterpartOf", () => {
	it("is the enemy in his own inferred role, and null when there isn't one", () => {
		strictEqual(counterpartOf([him, them, bystander])?.championName, "Kayn")
		strictEqual(counterpartOf([him, bystander]), null)
	})
})

describe("buildSpine", () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const s = buildSpine({ timeline: timeline as any, participants: [him, them, bystander], gameDurationSec: 600 })

	it("compares CS against the TIMELINE's counterpart, not a visibility counter", () => {
		strictEqual(s.minutes[1]?.csMe, 68)
		strictEqual(s.minutes[1]?.csThem, 58)
		// The live feed read 70 for an enemy who had 183. Nothing here may come from that channel.
		strictEqual(s.counterpart?.cs, 183)
	})

	it("credits an objective by killerId, on both sides", () => {
		deepStrictEqual(
			s.objectives.map(o => [o.name, o.side, o.takenBy]),
			[
				["Mountain drake", "enemy", "Kayn"],
				["Rift Herald", "his", "Lillia"]
			]
		)
	})

	it("keeps his deaths and his takedowns apart", () => {
		deepStrictEqual(s.deaths.map(d => [d.clock, d.killer]), [["8:00", "Kayn"]])
		deepStrictEqual(s.takedowns.map(t => [t.clock, t.kind, t.victim]), [["3:32", "kill", "Kayn"]])
	})

	it("carries the downtime estimate with the sentence that says it is one", () => {
		// The level comes from the frame at or before the death — never the one after it.
		strictEqual(s.deaths[0]?.downtimeSec, estimatedDowntime(1, 480.3))
		strictEqual(s.downtimeSource.includes("estimated"), true)
	})

	it("answers with a sentence rather than an error when there is no timeline", () => {
		const none = buildSpine({ timeline: null, participants: [him, them], gameDurationSec: 600 })
		strictEqual(none.available, false)
		strictEqual(none.minutes.length, 0)
		strictEqual((none.reason ?? "").length > 10, true)
	})
})
