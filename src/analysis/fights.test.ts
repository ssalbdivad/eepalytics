/**
 * Fight awareness is arithmetic over an event feed, so it is pinned as arithmetic.
 *
 * Two halves. The first is hand-built states, one per rule, because every rule here is a decision
 * that can be silently reversed by a refactor — "a pick is not a fight", "an unknown respawn is
 * not an accusation", "do not summarise a fight that is still going".
 *
 * The second half runs the real 20-game fixture corpus through it. That half is what set
 * `FIGHT_MIN_KILLS` in the first place (across all 788 exchanges he is absent from 57% of them,
 * which makes "you weren't in that one" the base rate and therefore worthless; restricted to
 * exchanges of three or more kills he is absent from 30%), and it is what caught the first
 * version measuring every fight against his LAST death in the feed instead of the death before
 * that fight. Both of those are one careless edit away from coming back, and neither is visible
 * in a hand-built fixture.
 */

import { ok, strictEqual, deepStrictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import {
	analyseFights,
	fightInputFromLive,
	ABSENCE_WINDOW,
	FIGHT_LINK_SEC,
	FIGHT_MIN_KILLS,
	FIGHT_SETTLE_SEC,
	FIGHT_STALE_SEC,
	LONGEST_DEATH_SEC,
	LOW_HP_FRACTION
} from "./fights.ts"
import type { FightFeedEvent, FightInput, FightRosterEntry } from "./fights.ts"
import { loadAll } from "./__fixtures__/index.ts"
import { findParticipantIdByPuuid } from "../shared/schema/lcu.ts"
import { USER_PUUID } from "../shared/constants.ts"

/* ------------------------------------------------------------- scaffolding */

/** `a1` is the user. Champion names are distinct from riotIds so a bad join shows up loudly. */
const ROSTER: FightRosterEntry[] = [
	{ name: "a1", champion: "Lillia", ally: true },
	{ name: "a2", champion: "Garen", ally: true },
	{ name: "a3", champion: "Ahri", ally: true },
	{ name: "a4", champion: "Jinx", ally: true },
	{ name: "a5", champion: "Thresh", ally: true },
	{ name: "e1", champion: "Viego", ally: false },
	{ name: "e2", champion: "Renekton", ally: false },
	{ name: "e3", champion: "Syndra", ally: false },
	{ name: "e4", champion: "Ashe", ally: false },
	{ name: "e5", champion: "Nautilus", ally: false }
]

let nextId = 1
const kill = (
	atSec: number,
	killer: string | undefined,
	victim: string,
	assisters: string[] = []
): FightFeedEvent => ({ id: nextId++, name: "ChampionKill", atSec, killer, victim, assisters })

const took = (atSec: number, name: string, killer: string): FightFeedEvent => ({
	id: nextId++,
	name,
	atSec,
	killer
})

const input = (over: Partial<FightInput> = {}): FightInput => ({
	nowSec: 600,
	me: "a1",
	roster: ROSTER,
	events: [],
	hp: null,
	...over
})

/** Roster with a named subset marked dead, which is how the "window still open" gate is fed. */
const withDead = (names: string[], respawnSec = 25): FightRosterEntry[] =>
	ROSTER.map(r => (names.includes(r.name) ? { ...r, dead: true, respawnSec } : r))

/*
 * The smallest things that count as fights, i.e. three kills that CHAIN. The assisters are not
 * decoration: without a shared champion the clustering rule correctly refuses to call three
 * unrelated kills one fight, which is the behaviour the "two lanes at once" test pins.
 */

/** 3-for-0 his way. */
const wonFight = (at: number): FightFeedEvent[] => [
	kill(at, "a2", "e2", ["a3"]),
	kill(at + 2, "a3", "e3", ["a2"]),
	kill(at + 4, "a4", "e4", ["a3"])
]

/** 0-for-3 his way. */
const lostFight = (at: number): FightFeedEvent[] => [
	kill(at, "e2", "a3", ["e3"]),
	kill(at + 2, "e3", "a4", ["e2"]),
	kill(at + 4, "e4", "a5", ["e3"])
]

/** 1-for-2 his way. */
const tradedFight = (at: number): FightFeedEvent[] => [
	kill(at, "e2", "a3", ["e3"]),
	kill(at + 2, "e3", "a4", ["e2"]),
	kill(at + 4, "a5", "e5", ["a4"])
]

/** A fight he was in the middle of. */
const myFight = (at: number): FightFeedEvent[] => [
	kill(at, "a1", "e2", ["a3"]),
	kill(at + 2, "a3", "e3", ["a1"]),
	kill(at + 4, "e4", "a5", ["e3"])
]

/** The clock at which a fight starting at `at` has just settled. */
const settledAt = (at: number): number => at + 4 + FIGHT_SETTLE_SEC

/* ------------------------------------------------------------- clustering */

describe("analyseFights — clustering", () => {
	it("chains kills that are close in time and share a champion", () => {
		const f = analyseFights(
			input({ nowSec: 200, events: [kill(100, "a2", "e2"), kill(104, "e3", "a2")] })
		)
		strictEqual(f.fights.length, 1)
		strictEqual(f.fights[0]!.kills.length, 2)
	})

	it("keeps two simultaneous exchanges apart when they share nobody", () => {
		/*
		 * The whole point of the overlap rule. The feed carries no positions, so a 1v1 top and a
		 * 1v1 bot four seconds apart are indistinguishable from a brawl by clock alone. Merging
		 * them would invent a four-man fight that never happened.
		 */
		const f = analyseFights(
			input({ nowSec: 200, events: [kill(100, "a2", "e2"), kill(104, "e4", "a4")] })
		)
		strictEqual(f.fights.length, 2)
	})

	it("does not chain across the assist window even when the champions match", () => {
		const f = analyseFights(
			input({
				nowSec: 300,
				events: [kill(100, "a2", "e2"), kill(100 + FIGHT_LINK_SEC + 1, "a2", "e3")]
			})
		)
		strictEqual(f.fights.length, 2)
	})

	it("chains through an assister rather than only through killer and victim", () => {
		const f = analyseFights(
			input({
				nowSec: 300,
				events: [kill(100, "a2", "e2", ["a5"]), kill(105, "a5", "e3")]
			})
		)
		strictEqual(f.fights.length, 1)
	})
})

/* ------------------------------------------------------------- the trade */

describe("analyseFights — the trade", () => {
	it("counts each side's losses and calls the outcome", () => {
		const f = analyseFights(
			input({
				nowSec: 300,
				events: [kill(100, "a2", "e2"), kill(103, "a2", "e3"), kill(105, "e4", "a2")]
			})
		)
		const only = f.fights[0]!
		strictEqual(only.enemiesLost, 2)
		strictEqual(only.alliesLost, 1)
		strictEqual(only.outcome, "won")
		strictEqual(only.scale, "fight")
	})

	it("keeps an execute — a death with no champion killer still costs the trade", () => {
		const f = analyseFights(input({ nowSec: 300, events: [kill(100, undefined, "a2")] }))
		strictEqual(f.fights[0]!.alliesLost, 1)
		strictEqual(f.fights[0]!.kills[0]!.killer, "")
	})

	it("drops an assister credited on the victim's own team", () => {
		// Impossible in League, so an entry like it is upstream corruption, not a teammate.
		const f = analyseFights(
			input({ nowSec: 300, events: [kill(100, "a2", "e2", ["a3", "e5"])] })
		)
		deepStrictEqual(f.fights[0]!.kills[0]!.assisters, ["Ahri"])
	})

	it("reports champion names, never the riotIds it joined on", () => {
		const f = analyseFights(input({ nowSec: 300, events: [kill(100, "a2", "e2", ["a3"])] }))
		deepStrictEqual(
			{ ...f.fights[0]!.kills[0]! },
			{ atSec: 100, killer: "Garen", victim: "Renekton", assisters: ["Ahri"], victimIsAlly: false }
		)
	})

	it("ignores an event for somebody who is not on the roster", () => {
		const f = analyseFights(input({ nowSec: 300, events: [kill(100, "a2", "stranger")] }))
		strictEqual(f.fights.length, 0)
	})
})

/* -------------------------------------------------------------- presence */

describe("analyseFights — where he was", () => {
	it("counts a kill, an assist and a death as being in it", () => {
		for (const events of [
			[kill(100, "a1", "e2")],
			[kill(100, "a2", "e2", ["a1"])],
			[kill(100, "e2", "a1")]
		])
			strictEqual(analyseFights(input({ nowSec: 200, events })).fights[0]!.presence, "participated")
	})

	it("calls it absent when he has never died and was in none of it", () => {
		const f = analyseFights(input({ nowSec: 200, events: wonFight(100) }))
		strictEqual(f.fights[0]!.presence, "absent")
	})

	it("calls it dead when his current death provably covers the fight", () => {
		const f = analyseFights(
			input({
				nowSec: 100,
				roster: withDead(["a1"], 10),
				events: [kill(60, "e5", "a1"), ...wonFight(85)]
			})
		)
		strictEqual(f.fights.at(-1)!.presence, "dead")
		strictEqual(f.lines.length, 0)
	})

	it("calls it unclear rather than absent when his respawn cannot be established", () => {
		/*
		 * He died 20s before it, he is alive now, and nothing in the feed says when he got back
		 * up. Accusing him of skipping a fight he may have watched from the respawn screen is the
		 * exact mistake that produced "2 are down, you have about 14s" to a corpse.
		 */
		const f = analyseFights(
			input({ nowSec: settledAt(100), events: [kill(80, "e5", "a1"), ...lostFight(100)] })
		)
		strictEqual(f.fights.at(-1)!.presence, "unclear")
		strictEqual(f.lines.length, 0)
	})

	it("a takedown after a death proves he was back up, so a later fight is absent", () => {
		const f = analyseFights(
			input({
				nowSec: 300,
				events: [kill(80, "e2", "a1"), kill(120, "a1", "e5"), ...wonFight(200)]
			})
		)
		strictEqual(f.fights.at(-1)!.presence, "absent")
	})

	it("falls back to the longest possible death timer when nothing else proves it", () => {
		const f = analyseFights(
			input({ nowSec: 400, events: [kill(80, "e2", "a1"), ...wonFight(80 + LONGEST_DEATH_SEC)] })
		)
		strictEqual(f.fights.at(-1)!.presence, "absent")
	})

	it("measures each fight against the death BEFORE it, not his last death in the feed", () => {
		/*
		 * Regression. The first version computed one `lastDeathSec` for the whole feed, so a fight
		 * at 2:00 was judged against a death at 20:00 that had not happened yet and came back
		 * `unclear`. Over the fixture corpus that mislabelled 55% of exchanges — and `fights[]` is
		 * an input other tracks read, so the damage was not limited to the lines.
		 */
		const f = analyseFights(
			input({ nowSec: 2000, events: [...wonFight(100), kill(1900, "e2", "a1")] })
		)
		strictEqual(f.fights[0]!.presence, "absent")
	})
})

/* ------------------------------------------------------------- lateness */

describe("analyseFights — a fight assessment is late by nature", () => {
	it("says nothing while the exchange is still resolving", () => {
		const events = wonFight(100)
		const f = analyseFights(input({ nowSec: 104 + FIGHT_SETTLE_SEC - 1, events }))
		strictEqual(f.ongoing?.kills.length, 3)
		strictEqual(f.latest, null)
		strictEqual(f.lines.length, 0)
	})

	it("summarises once it has settled", () => {
		const events = wonFight(100)
		const f = analyseFights(input({ nowSec: 104 + FIGHT_SETTLE_SEC, roster: withDead(["e2", "e3", "e4"]), events }))
		strictEqual(f.ongoing, null)
		ok(f.latest !== null)
		ok(f.lines.some(l => l.kind === "uncashed"))
	})

	it("stops talking about it once it is history", () => {
		const events = wonFight(100)
		const f = analyseFights(
			input({ nowSec: 104 + FIGHT_STALE_SEC + 1, roster: withDead(["e2", "e3", "e4"]), events })
		)
		strictEqual(f.latest, null)
		strictEqual(f.lines.length, 0)
	})

	it("stays quiet about the last fight while a new one is underway", () => {
		// The old summary is the wrong answer and the new one is not knowable yet. Both are "wait".
		const events = [...wonFight(100), kill(200, "e2", "a3"), kill(202, "e3", "a4")]
		const f = analyseFights(input({ nowSec: 204, roster: withDead(["e2", "e3", "e4"]), events }))
		ok(f.ongoing !== null)
		strictEqual(f.lines.length, 0)
	})
})

/* ------------------------------------------------------------ the lines */

describe("analyseFights — a pick is not a fight", () => {
	it("says nothing about one or two people dying", () => {
		for (const events of [[kill(100, "e2", "a3")], [kill(100, "e2", "a3"), kill(103, "e2", "a4")]]) {
			const f = analyseFights(input({ nowSec: 120, roster: withDead(["e2", "e3", "e4"]), events }))
			strictEqual(f.lines.length, 0)
			ok(f.fights[0]!.scale !== "fight")
		}
	})

	it("needs exactly FIGHT_MIN_KILLS to start talking", () => {
		const events = lostFight(100)
		strictEqual(events.length, FIGHT_MIN_KILLS)
		const f = analyseFights(input({ nowSec: settledAt(100), events }))
		strictEqual(f.fights[0]!.scale, "fight")
		ok(f.lines.some(l => l.kind === "absence"))
	})
})

describe("analyseFights — the fight he was not in", () => {
	it("names the trade and his absence, and nothing else", () => {
		const f = analyseFights(input({ nowSec: settledAt(100), events: tradedFight(100) }))
		deepStrictEqual(
			f.lines.map(l => l.text),
			["your team just traded 1-for-2 without you"]
		)
	})

	it("says it plainly when they got nothing back", () => {
		const f = analyseFights(input({ nowSec: settledAt(100), events: lostFight(100) }))
		strictEqual(f.lines[0]!.text, "your team just lost 3 for nothing and you weren't in it")
	})

	it("does not complain about a fight his team won without him", () => {
		// There is no fix in "your team won that without you"; the uncashed line is the useful half.
		const f = analyseFights(input({ nowSec: settledAt(100), events: wonFight(100) }))
		ok(!f.lines.some(l => l.kind === "absence"))
	})
})

describe("analyseFights — a win nobody cashed in", () => {
	const events = wonFight(100)
	const at = (over: Partial<FightInput>) =>
		analyseFights(input({ nowSec: 120, roster: withDead(["e2", "e3", "e4"]), events, ...over }))

	it("fires while the window is open", () => {
		strictEqual(
			at({}).lines.find(l => l.kind === "uncashed")?.text,
			"that 3-for-0 hasn't bought anything yet"
		)
	})

	it("goes quiet once something has actually been taken", () => {
		strictEqual(
			at({ events: [...events, took(110, "DragonKill", "a2")] }).lines.length,
			0
		)
		deepStrictEqual(
			analyseFights(
				input({ nowSec: 120, roster: withDead(["e2", "e3", "e4"]), events: [...events, took(110, "DragonKill", "a2")] })
			).fights[0]!.bought,
			["drake"]
		)
	})

	it("does not credit an objective the enemy took", () => {
		const f = at({ events: [...events, took(110, "DragonKill", "e5")] })
		deepStrictEqual(f.fights[0]!.bought, [])
		ok(f.lines.some(l => l.kind === "uncashed"))
	})

	it("goes quiet once they have respawned — the window is the point, not the win", () => {
		strictEqual(at({ roster: withDead(["e2"]) }).lines.length, 0)
	})

	it("never suggests cashing in at low health", () => {
		// GATE, never spoken: his health bar is on his own screen.
		strictEqual(at({ hp: { current: 30, max: 100 } }).lines.length, 0)
		ok(at({ hp: { current: 100 * LOW_HP_FRACTION, max: 100 } }).lines.length > 0)
	})

	it("never suggests cashing in from the respawn screen", () => {
		const roster = withDead(["e2", "e3", "e4"]).map(r =>
			r.name === "a1" ? { ...r, dead: true, respawnSec: 15 } : r
		)
		strictEqual(at({ roster }).lines.length, 0)
	})

	it("never suggests cashing in while outnumbered", () => {
		const roster = withDead(["e2", "a2", "a3", "a4"])
		strictEqual(at({ roster }).lines.length, 0)
	})
})

describe("analyseFights — the absence pattern", () => {
	/** `n` real fights he was in none of, spaced far enough apart to stay separate exchanges. */
	const at = (i: number) => 100 + i * 100
	const missedFights = (n: number): FightFeedEvent[] =>
		Array.from({ length: n }, (_, i) => wonFight(at(i))).flat()

	it("fires only once there are enough fights to call it a pattern", () => {
		const three = analyseFights(input({ nowSec: settledAt(at(2)), events: missedFights(3) }))
		ok(!three.lines.some(l => l.kind === "pattern"))
		const four = analyseFights(input({ nowSec: settledAt(at(3)), events: missedFights(4) }))
		strictEqual(
			four.lines.find(l => l.kind === "pattern")?.text,
			`that's ${ABSENCE_WINDOW} of the last ${ABSENCE_WINDOW} fights you weren't in`
		)
	})

	it("does not count fights he was in", () => {
		const events = [...missedFights(2), ...myFight(at(2)), ...myFight(at(3))]
		const f = analyseFights(input({ nowSec: settledAt(at(3)), events }))
		ok(!f.lines.some(l => l.kind === "pattern"))
	})

	it("replaces the single-fight line rather than stacking on it", () => {
		const events = [...missedFights(3), ...lostFight(at(3))]
		const f = analyseFights(input({ nowSec: settledAt(at(3)), events }))
		deepStrictEqual(
			f.lines.map(l => l.kind),
			["pattern"]
		)
	})

	it("keeps the same id across the next few fights so it cannot become a nag", () => {
		const four = analyseFights(input({ nowSec: settledAt(at(3)), events: missedFights(4) }))
		const five = analyseFights(input({ nowSec: settledAt(at(4)), events: missedFights(5) }))
		strictEqual(
			four.lines.find(l => l.kind === "pattern")!.id,
			five.lines.find(l => l.kind === "pattern")!.id
		)
	})
})

/* --------------------------------------------------------------- adapter */

describe("fightInputFromLive", () => {
	it("joins the event feed to the player list on riotId", () => {
		const built = fightInputFromLive(
			{
				activePlayer: {
					riotId: "Gooskaffur#NA1",
					championStats: { currentHealth: 900, maxHealth: 1800 }
				},
				allPlayers: [
					{ riotId: "Gooskaffur#NA1", championName: "Lillia", team: "ORDER" },
					{ riotId: "Mate#NA1", championName: "Garen", team: "ORDER" },
					{ riotId: "Foe#NA1", championName: "Viego", team: "CHAOS", isDead: true, respawnTimer: 14 }
				],
				events: {
					Events: [
						{
							EventID: 7,
							EventName: "ChampionKill",
							EventTime: 610.5,
							KillerName: "Gooskaffur#NA1",
							VictimName: "Foe#NA1",
							Assisters: ["Mate#NA1"]
						}
					]
				}
			},
			620
		)
		ok(built !== null)
		strictEqual(built.me, "Gooskaffur#NA1")
		deepStrictEqual(built.hp, { current: 900, max: 1800 })
		strictEqual(built.roster.filter(r => r.ally).length, 2)
		strictEqual(built.roster.find(r => r.name === "Foe#NA1")?.dead, true)
		const f = analyseFights(built)
		strictEqual(f.fights[0]!.myKills, 1)
		strictEqual(f.fights[0]!.kills[0]!.victim, "Viego")
	})

	it("coaches nobody rather than a stranger when the active player is not in the list", () => {
		strictEqual(
			fightInputFromLive({ activePlayer: { riotId: "Someone#NA1" }, allPlayers: [] }, 100),
			null
		)
	})
})

/* --------------------------------------------------- the real 20 games */

/**
 * The fixture corpus, reshaped into the live feed's vocabulary.
 *
 * The stored timeline is not the live client — it names people by participantId and its events
 * arrive in per-minute frames — so this is a translation, and it is a fair one for the only thing
 * being measured here: which kills belong together and where he was. Champion names are
 * synthesised from championId because the LCU match blob does not carry them, which is fine,
 * because no spoken line in this module contains a champion name.
 */
const corpus = () =>
	loadAll().flatMap(g => {
		const mePid = findParticipantIdByPuuid(g.match, USER_PUUID)
		if (mePid === null) return []
		const teamOf = new Map(g.match.participants.map(p => [p.participantId, p.teamId]))
		const roster: FightRosterEntry[] = g.match.participants.map(p => ({
			name: `p${p.participantId}`,
			champion: `C${p.championId}`,
			ally: teamOf.get(p.participantId) === teamOf.get(mePid)
		}))
		let id = 0
		const events: FightFeedEvent[] = []
		for (const fr of g.timeline.frames)
			for (const e of fr.events ?? []) {
				if (e.type === "CHAMPION_KILL")
					events.push({
						id: id++,
						name: "ChampionKill",
						atSec: e.timestamp / 1000,
						killer: e.killerId ? `p${e.killerId}` : undefined,
						victim: e.victimId ? `p${e.victimId}` : undefined,
						assisters: (e.assistingParticipantIds ?? []).map(a => `p${a}`)
					})
				else if (e.type === "ELITE_MONSTER_KILL")
					events.push({
						id: id++,
						name:
							e.monsterType === "DRAGON" ? "DragonKill"
							: e.monsterType === "BARON_NASHOR" ? "BaronKill"
							: e.monsterType === "RIFTHERALD" ? "HeraldKill"
							: "Other",
						atSec: e.timestamp / 1000,
						killer: e.killerId ? `p${e.killerId}` : undefined
					})
			}
		const endSec = Math.max(...events.map(e => e.atSec), 0) + 120
		return [{ gameId: g.gameId, me: `p${mePid}`, roster, events, endSec }]
	})

describe("analyseFights — the 20-game fixture corpus", () => {
	const games = corpus()

	it("accounts for every champion kill exactly once", () => {
		for (const g of games) {
			const facts = analyseFights({ nowSec: g.endSec, me: g.me, roster: g.roster, events: g.events, hp: null })
			const clustered = facts.fights.reduce((n, f) => n + f.kills.length, 0)
			const expected = g.events.filter(e => e.name === "ChampionKill" && e.victim !== undefined).length
			strictEqual(clustered, expected, `game ${g.gameId}`)
			for (const f of facts.fights) {
				strictEqual(f.alliesLost + f.enemiesLost, f.kills.length)
				ok(f.kills.every((k, i) => i === 0 || k.atSec >= f.kills[i - 1]!.atSec))
				ok(f.endSec - f.startSec <= FIGHT_LINK_SEC * (f.kills.length - 1) + 0.001)
			}
		}
	})

	it("is why a pick is not a fight: absence is the base rate below FIGHT_MIN_KILLS", () => {
		/*
		 * The measurement `FIGHT_MIN_KILLS` was set from. If this ever stops holding, the gate is
		 * no longer buying anything and the whole module is back to saying things that are true of
		 * every game ever played.
		 */
		const rate = (want: (n: number) => boolean) => {
			let absent = 0
			let classifiable = 0
			for (const g of games)
				for (const f of analyseFights({
					nowSec: g.endSec,
					me: g.me,
					roster: g.roster,
					events: g.events,
					hp: null
				}).fights) {
					if (!want(f.kills.length)) continue
					if (f.presence === "absent") absent++
					if (f.presence === "absent" || f.presence === "participated") classifiable++
				}
			return absent / classifiable
		}
		const picks = rate(n => n < FIGHT_MIN_KILLS)
		const fights = rate(n => n >= FIGHT_MIN_KILLS)
		ok(picks > 0.5, `absent from ${(picks * 100).toFixed(0)}% of picks and skirmishes`)
		ok(fights < 0.4, `absent from ${(fights * 100).toFixed(0)}% of real fights`)
		ok(picks - fights > 0.2, "the gate has to separate the two or it is not buying anything")
	})

	it("leaves few fights unclear, and never guesses to avoid one", () => {
		let unclear = 0
		let total = 0
		for (const g of games)
			for (const f of analyseFights({
				nowSec: g.endSec,
				me: g.me,
				roster: g.roster,
				events: g.events,
				hp: null
			}).fights) {
				if (f.kills.length < FIGHT_MIN_KILLS) continue
				total++
				if (f.presence === "unclear") unclear++
			}
		ok(unclear / total < 0.15, `${unclear}/${total} real fights unclear`)
	})

	it("speaks a handful of times a game, not every thirty seconds", () => {
		/*
		 * The first cut of this fired about ten times a game, including "that's 3 of the last 4
		 * fights you weren't in" seven times in one 32-minute game. A coach who says the same true
		 * thing seven times is one the player stops hearing, which is the failure `live-facts.ts`
		 * was rebuilt around.
		 */
		let distinct = 0
		for (const g of games) {
			const fired = new Set<string>()
			for (let t = 0; t <= g.endSec; t += 2)
				for (const l of analyseFights({
					nowSec: t,
					me: g.me,
					roster: g.roster,
					events: g.events,
					hp: null
				}).lines)
					fired.add(l.id)
			distinct += fired.size
		}
		const perGame = distinct / games.length
		ok(perGame > 0.5, `only ${perGame.toFixed(1)} lines a game — the module has gone silent`)
		ok(perGame < 6, `${perGame.toFixed(1)} lines a game is a nag`)
	})

	it("never names a champion, so it cannot name one who is not in the game", () => {
		/*
		 * The hallucination that produced the ground-truth block in the first place was a coach
		 * naming champions who were not in the match. A fact family with no champion names in it
		 * is structurally incapable of that regression, and this test is what keeps it that way.
		 */
		const champions = new Set(games.flatMap(g => g.roster.map(r => r.champion)))
		for (const g of games)
			for (let t = 0; t <= g.endSec; t += 5)
				for (const l of analyseFights({
					nowSec: t,
					me: g.me,
					roster: g.roster,
					events: g.events,
					hp: null
				}).lines)
					for (const c of champions) ok(!l.text.includes(c), `${l.text} names ${c}`)
	})
})
