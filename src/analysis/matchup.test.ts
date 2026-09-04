/**
 * The pre-game brief.
 *
 * Sessions here are hand-built from the shape the live client returned on the probe this was
 * written against: `gameData.teamOne`/`teamTwo` carrying championId + puuid + selectedPosition,
 * and `gameData.playerChampionSelections` carrying championId + puuid + spell1Id + spell2Id.
 * The ids are real (Lillia 876, Trundle 48, Flash 4, Smite 11) but every NAME comes from the
 * lookups the tests inject, exactly as it comes from the client at runtime — nothing here
 * hardcodes a name table, because the app does not either.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, test } from "node:test"
import { buildMatchupBrief } from "./matchup.ts"
import type { BuildMatchupInput } from "./matchup.ts"
import type { GameflowSession } from "../shared/schema/lcu.ts"

const ME = "188dee22-18d6-5752-ba7f-b69cf3d2506e"

const CHAMPIONS: Record<number, string> = {
	876: "Lillia",
	48: "Trundle",
	64: "Lee Sin",
	200: "Bel'Veth",
	1: "Annie",
	2: "Olaf",
	3: "Galio",
	4: "Twisted Fate",
	5: "Xin Zhao",
	6: "Urgot",
	7: "LeBlanc",
	8: "Vladimir"
}
const SPELLS: Record<number, string> = { 4: "Flash", 11: "Smite", 12: "Teleport", 14: "Ignite" }

const championName = (id: number): string => CHAMPIONS[id] ?? ""
const spellName = (id: number): string => SPELLS[id] ?? ""

interface Seat {
	puuid: string
	championId: number
	position: string
	spells?: [number, number]
}

const session = (
	mine: readonly Seat[],
	theirs: readonly Seat[],
	opts: { phase?: string; withSelections?: boolean; queueId?: number } = {}
): GameflowSession => {
	const all = [...mine, ...theirs]
	return {
		phase: opts.phase ?? "GameStart",
		gameData: {
			gameId: 5633183082,
			...(opts.queueId === undefined ? {} : { queue: { id: opts.queueId } }),
			teamOne: mine.map(s => ({
				puuid: s.puuid,
				championId: s.championId,
				selectedPosition: s.position
			})),
			teamTwo: theirs.map(s => ({
				puuid: s.puuid,
				championId: s.championId,
				selectedPosition: s.position
			})),
			...(opts.withSelections === false ?
				{}
			:	{
					playerChampionSelections: all.map(s => ({
						puuid: s.puuid,
						championId: s.championId,
						spell1Id: s.spells?.[0] ?? 4,
						spell2Id: s.spells?.[1] ?? 11
					}))
				})
		}
	}
}

/** The probe's real pairing: him on Lillia jungle, Trundle jungle opposite. */
const LILLIA_INTO_TRUNDLE = () =>
	session(
		[
			{ puuid: ME, championId: 876, position: "JUNGLE", spells: [4, 11] },
			{ puuid: "ally-1", championId: 1, position: "TOP" },
			{ puuid: "ally-2", championId: 3, position: "MIDDLE" },
			{ puuid: "ally-3", championId: 4, position: "BOTTOM" },
			{ puuid: "ally-4", championId: 7, position: "UTILITY" }
		],
		[
			{ puuid: "enemy-1", championId: 2, position: "TOP" },
			{ puuid: "enemy-2", championId: 48, position: "JUNGLE", spells: [11, 4] },
			{ puuid: "enemy-3", championId: 5, position: "MIDDLE" },
			{ puuid: "enemy-4", championId: 6, position: "BOTTOM" },
			{ puuid: "enemy-5", championId: 8, position: "UTILITY" }
		],
		{ queueId: 420 }
	)

const build = (s: GameflowSession, extra: Partial<BuildMatchupInput> = {}) =>
	buildMatchupBrief({ session: s, puuid: ME, championName, spellName, ...extra })

describe("buildMatchupBrief", () => {
	test("names his champion, his position and both summoner spells", () => {
		const { brief } = build(LILLIA_INTO_TRUNDLE())
		ok(brief)
		strictEqual(brief.you.champion, "Lillia")
		strictEqual(brief.you.role, "JGL")
		deepStrictEqual(brief.you.spells, ["Flash", "Smite"])
		strictEqual(brief.you.isYou, true)
	})

	test("finds the enemy in his position and says the pairing was declared", () => {
		const { brief } = build(LILLIA_INTO_TRUNDLE())
		strictEqual(brief!.opponent?.champion, "Trundle")
		deepStrictEqual(brief!.opponent?.spells, ["Smite", "Flash"])
		strictEqual(brief!.opponentBasis, "declared")
	})

	test("carries both full comps, with him excluded from his own allies", () => {
		const { brief } = build(LILLIA_INTO_TRUNDLE())
		strictEqual(brief!.allies.length, 4)
		strictEqual(brief!.enemies.length, 5)
		ok(!brief!.allies.some(a => a.isYou))
		ok(brief!.enemies.some(e => e.champion === "Trundle"))
	})

	test("labels the queue from the client's own id", () => {
		const { brief } = build(LILLIA_INTO_TRUNDLE(), { queue: "Ranked Solo/Duo" })
		strictEqual(brief!.queue, "Ranked Solo/Duo")
	})

	/*
	 * Blind and quickplay publish no positions at all. Smite is the one spell that identifies a
	 * role on its own — roles.ts measured exactly one holder per team in 44/44 team-games — so the
	 * jungle counterpart survives, and the brief says it is an inference rather than a fact.
	 */
	test("falls back to the lone enemy Smite when nobody declared a position", () => {
		const s = session(
			[
				{ puuid: ME, championId: 876, position: "", spells: [4, 11] },
				{ puuid: "ally-1", championId: 1, position: "", spells: [4, 12] }
			],
			[
				{ puuid: "enemy-1", championId: 2, position: "", spells: [4, 14] },
				{ puuid: "enemy-2", championId: 48, position: "", spells: [11, 4] }
			]
		)
		const { brief } = build(s)
		strictEqual(brief!.you.role, "UNKNOWN")
		strictEqual(brief!.opponent?.champion, "Trundle")
		strictEqual(brief!.opponentBasis, "smite")
		ok(brief!.unknowns.some(u => u.includes("Smite alone")))
	})

	test("refuses to pick a counterpart when two enemies took Smite", () => {
		const s = session(
			[{ puuid: ME, championId: 876, position: "", spells: [4, 11] }],
			[
				{ puuid: "enemy-1", championId: 2, position: "", spells: [4, 11] },
				{ puuid: "enemy-2", championId: 48, position: "", spells: [11, 4] }
			]
		)
		const { brief } = build(s)
		strictEqual(brief!.opponent, null)
		strictEqual(brief!.opponentBasis, "none")
		ok(brief!.unknowns.some(u => u.includes("no identified counterpart")))
	})

	test("says so rather than guessing when no enemy declared his position", () => {
		const s = session(
			[{ puuid: ME, championId: 876, position: "JUNGLE", spells: [4, 12] }],
			[{ puuid: "enemy-1", championId: 2, position: "TOP", spells: [4, 14] }]
		)
		const { brief } = build(s)
		strictEqual(brief!.opponent, null)
		strictEqual(brief!.opponentBasis, "none")
	})

	/* ------------------------------------------------------------ notes */

	test("attaches champion notes for both sides through the lookup", () => {
		const { brief } = build(LILLIA_INTO_TRUNDLE(), {
			noteFor: champion =>
				champion === "Lillia" || champion === "Trundle" ?
					{ champion, text: `notes for ${champion}`, patch: "durable", source: "test" }
				:	null
		})
		strictEqual(brief!.championNotes?.text, "notes for Lillia")
		strictEqual(brief!.opponentNotes?.text, "notes for Trundle")
		strictEqual(brief!.unknowns.length, 0)
	})

	test("reports a missing notes file as an unknown instead of leaving it silent", () => {
		const { brief } = build(LILLIA_INTO_TRUNDLE(), {
			noteFor: champion =>
				champion === "Lillia" ?
					{ champion, text: "notes for Lillia", patch: "durable", source: "test" }
				:	null
		})
		strictEqual(brief!.opponentNotes, null)
		ok(brief!.unknowns.some(u => u.includes("no champion notes on file for Trundle")))
		ok(brief!.unknowns.some(u => u.includes("Say nothing about their kit")))
	})

	/* ------------------------------------------------ the "not yet" states */

	test("no rosters published yet is a reason, not a brief", () => {
		const { brief, reason } = build({ phase: "ChampSelect" })
		strictEqual(brief, null)
		ok(reason!.includes("rosters"))
	})

	test("no champion locked yet is a reason, not a brief", () => {
		const s = session(
			[{ puuid: ME, championId: 0, position: "JUNGLE" }],
			[{ puuid: "enemy-1", championId: 48, position: "JUNGLE" }],
			{ phase: "ChampSelect", withSelections: false }
		)
		const { brief, reason } = build(s)
		strictEqual(brief, null)
		ok(reason!.includes("locked"))
	})

	test("a game that is not his is refused rather than coached", () => {
		const s = session(
			[{ puuid: "someone-else", championId: 876, position: "JUNGLE" }],
			[{ puuid: "enemy-1", championId: 48, position: "JUNGLE" }]
		)
		const { brief, reason } = build(s)
		strictEqual(brief, null)
		ok(reason!.includes("puuid"))
	})

	/*
	 * The degrade that matters: with no name table we must not print "champion 876". An id is not
	 * something a coach can say out loud, and a bare number in prose reads as a fact.
	 */
	test("an unnameable champion stays empty and is declared as an unknown", () => {
		const { brief } = build(LILLIA_INTO_TRUNDLE(), { championName: () => "" })
		strictEqual(brief!.you.champion, "")
		strictEqual(brief!.you.championId, 876)
		ok(brief!.unknowns.some(u => u.includes("do not name it")))
	})

	test("an unnameable summoner spell is dropped, never rendered as a number", () => {
		const { brief } = build(LILLIA_INTO_TRUNDLE(), { spellName: () => "" })
		deepStrictEqual(brief!.you.spells, [])
		ok(brief!.unknowns.some(u => u.includes("not published yet")))
	})

	test("selections that have not arrived yet leave spells empty rather than invented", () => {
		const s = session(
			[{ puuid: ME, championId: 876, position: "JUNGLE" }],
			[{ puuid: "enemy-1", championId: 48, position: "JUNGLE" }],
			{ phase: "ChampSelect", withSelections: false }
		)
		const { brief } = build(s)
		deepStrictEqual(brief!.you.spells, [])
		strictEqual(brief!.opponent?.champion, "Trundle")
		strictEqual(brief!.opponentBasis, "declared")
	})

	/** A champ-select swap writes the selection but the roster row lags. The later write wins. */
	test("playerChampionSelections beats a stale roster championId", () => {
		const s = LILLIA_INTO_TRUNDLE()
		s.gameData!.teamOne![0]!.championId = 64
		const { brief } = build(s)
		strictEqual(brief!.you.champion, "Lillia")
	})

	/**
	 * The structural half of the guarantee: there is no field on this object that could carry a
	 * rune, an item or a spell cooldown, so no amount of prompt drift can put one there.
	 */
	test("the brief has no rune, item or cooldown field anywhere in it", () => {
		const { brief } = build(LILLIA_INTO_TRUNDLE())
		const json = JSON.stringify(brief).toLowerCase()
		for (const banned of ["rune", "perk", "item", "cooldown", "keystone"])
			ok(!json.includes(banned), `brief must not carry "${banned}"`)
	})
})
