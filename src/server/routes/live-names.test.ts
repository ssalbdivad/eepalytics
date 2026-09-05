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

describe("objectives he took himself", () => {
	/*
	 * The same namespace bug as `championOf`, in five more sites, and this one is worse because
	 * it does not merely garble a name — it hands the credit to the enemy.
	 *
	 * Measured on a real recorded game, one paragraph apart in the SAME block: the prose read
	 * "Baron taken by Lillia" while the ranked list — the only surface the model may speak from —
	 * read "they have Baron, do not take a fight in the open". Four seconds after he soloed it.
	 * `myEvents` filtered on `me.riotId` ("Gooskaffur#NA1") against the event feed's bare
	 * `KillerName` ("Gooskaffur"), so it was empty in every block of every game and "you secured
	 * Baron" could never fire. `enemyObjectives` used the same broken lookup with a fallback of
	 * `true` — unresolvable means theirs — so all three drakes, the herald and the baron in a
	 * 36-minute game were attributed to the enemy.
	 */
	const withObjectives = {
		...capture,
		gameData: { gameTime: 1200 },
		events: {
			Events: [
				{ EventID: 1, EventName: "BaronKill", KillerName: "Gooskaffur", EventTime: 1195 },
				{
					EventID: 2,
					EventName: "DragonKill",
					KillerName: "Gooskaffur",
					DragonType: "Water",
					EventTime: 1190
				}
			]
		}
	}

	const ranked = (raw: unknown): string => {
		const st = buildLiveStateForBench(raw, 1200)
		ok(st, "expected a state")
		const block = renderState(st)
		const from = block.indexOf("### ")
		return from === -1 ? "" : block.slice(from)
	}

	it("credits him, and never tells him the enemy has what he just took", () => {
		const list = ranked(withObjectives)
		ok(!/they have Baron/i.test(list), `his own baron was given to the enemy:\n${list}`)
		ok(!/they took .*drake/i.test(list), `his own drake was given to the enemy:\n${list}`)
		ok(/you secured Baron/i.test(list), `no credit for his baron:\n${list}`)
	})

	it("still calls an enemy take an enemy take", () => {
		const theirs = {
			...withObjectives,
			events: {
				Events: [
					{ EventID: 1, EventName: "BaronKill", KillerName: "cQuachy", EventTime: 1195 }
				]
			}
		}
		const list = ranked(theirs)
		ok(/they have Baron/i.test(list), `an enemy baron was not reported:\n${list}`)
		ok(!/you secured/i.test(list), `credited him for an enemy take:\n${list}`)
	})

	it("credits an ALLY take to his team, not to the enemy", () => {
		const ally = {
			...withObjectives,
			events: {
				Events: [
					{ EventID: 1, EventName: "BaronKill", KillerName: "zx6r", EventTime: 1195 }
				]
			}
		}
		const list = ranked(ally)
		ok(!/they have Baron/i.test(list), `an ally take was blamed on the enemy:\n${list}`)
	})
})
