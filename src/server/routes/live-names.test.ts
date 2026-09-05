/**
 * The block must never carry a name it cannot tie to a champion.
 *
 * This file exists because there was no test here at all, and the gap cost the coach its single
 * richest signal. Measured on a real capture (`data/live-samples`): the event feed sends the BARE
 * game name ("Gooskaffur") while both fields the lookup consulted carry the tag
 * ("Gooskaffur#NA1"), so 0 of 37 event names resolved and 0 of 131 kills in one game ever reached
 * the model as champions. Every fight arrived as unmappable proper nouns inside a block that also
 * says "these ten champions are the only champions in this game" - so the model fell back on the
 * only clean numbers left, and a real transcript came out six-ninths CS.
 */

import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"

import { buildLiveStateForBench } from "./live.ts"
import { renderState } from "../../shared/live-state.ts"

/** The roster shape the Live Client Data API really returns, taken from a stored capture. */
const player = (championName: string, gameName: string, tag: string, team: string) => ({
	championName,
	riotId: `${gameName}#${tag}`,
	riotIdGameName: gameName,
	summonerName: `${gameName}#${tag}`,
	team,
	level: 9,
	isDead: false,
	respawnTimer: 0,
	scores: { kills: 1, deaths: 1, assists: 1, creepScore: 80, wardScore: 4 }
})

const capture = {
	activePlayer: { riotId: "Gooskaffur#NA1", riotIdGameName: "Gooskaffur", championStats: {} },
	allPlayers: [
		player("Lillia", "Gooskaffur", "NA1", "ORDER"),
		player("Yone", "SlattOats", "NA1", "ORDER"),
		player("Karma", "Pillory Clinton", "feets", "ORDER"),
		player("Jinx", "吉米购购", "4466", "ORDER"),
		player("Nami", "fresh coffee", "NA1", "ORDER"),
		player("Karthus", "crazytornado72", "NA1", "CHAOS"),
		player("Ahri", "Luvsbiee", "Heart", "CHAOS"),
		player("Irelia", "Speakington", "1337", "CHAOS"),
		player("Vayne", "様 Kentoy", "free", "CHAOS"),
		player("Locke", "梦子 Yumeko", "lvurs", "CHAOS")
	],
	gameData: { gameTime: 600 },
	// The event feed names people by BARE game name. That is the whole bug.
	events: {
		Events: [
			{ EventID: 1, EventName: "ChampionKill", KillerName: "Gooskaffur", VictimName: "Luvsbiee" },
			{ EventID: 2, EventName: "ChampionKill", KillerName: "Speakington", VictimName: "SlattOats" },
			{ EventID: 3, EventName: "ChampionKill", KillerName: "様 Kentoy", VictimName: "吉米购购" }
		]
	}
}

const blockFor = (raw: unknown): string => {
	const st = buildLiveStateForBench(raw, 600)
	ok(st, "expected a state from a well-formed capture")
	return renderState(st)
}

describe("the ground-truth block", () => {
	it("resolves event names to champions, including tags that differ from NA1", () => {
		const block = blockFor(capture)
		ok(block.includes("Lillia killed Ahri"), `no resolved kill in block:\n${block}`)
		ok(block.includes("Irelia killed Yone"), `no resolved kill in block:\n${block}`)
		// Non-ASCII game names are ordinary here; they must resolve like any other.
		ok(block.includes("Vayne killed Jinx"), `unicode name did not resolve:\n${block}`)
	})

	it("never leaks a summoner name into a block that claims ten champions", () => {
		const block = blockFor(capture)
		for (const leak of ["Gooskaffur", "SlattOats", "Speakington", "crazytornado72", "様 Kentoy"]) {
			// The roster line legitimately names the player; the EVENT line must not.
			const just = (block.match(/^Just happened: .*$/m) ?? [""])[0] ?? ""
			ok(!just.includes(leak), `summoner name "${leak}" leaked into: ${just}`)
		}
	})

	it("drops an event it cannot resolve rather than saying 'someone killed someone'", () => {
		const orphaned = {
			...capture,
			events: {
				Events: [
					{ EventID: 1, EventName: "ChampionKill", KillerName: "NotInGame", VictimName: "AlsoNot" },
					{ EventID: 2, EventName: "ChampionKill", KillerName: "Gooskaffur", VictimName: "Luvsbiee" }
				]
			}
		}
		const block = blockFor(orphaned)
		ok(!block.includes("someone killed someone"), `filler event survived:\n${block}`)
		ok(block.includes("Lillia killed Ahri"), "the resolvable event should still be there")
	})

	it("keeps a half-resolved event, because one known side is still a fact", () => {
		const half = {
			...capture,
			events: {
				Events: [
					{ EventID: 1, EventName: "ChampionKill", KillerName: "Gooskaffur", VictimName: "NotInGame" }
				]
			}
		}
		const block = blockFor(half)
		ok(block.includes("Lillia killed someone"), `half-resolved event dropped:\n${block}`)
	})

	it("names only champions that are actually in the game", () => {
		const block = blockFor(capture)
		const roster = new Set(capture.allPlayers.map(p => p.championName))
		const just = (block.match(/^Just happened: .*$/m) ?? [""])[0] ?? ""
		for (const m of just.matchAll(/([A-Z][a-zA-Z']+) killed ([A-Za-z][a-zA-Z']+)/g)) {
			for (const n of [m[1], m[2]]) {
				if (n === undefined || n === "someone") continue
				ok(roster.has(n), `block named "${n}", who is not in this game: ${just}`)
			}
		}
		strictEqual(typeof just, "string")
		ok(just.length > 0, "expected a Just happened line")
	})
})
