/**
 * WHEN the coach is asked, pinned.
 *
 * Every case here is either a rule the recorded games forced or a way an earlier version of this
 * file was wrong. The one that matters most is `a kill is not a turn`: firing on each of game
 * 5639406342's champion kills produced 105 turns, MORE than the 85 the fixed timer it replaces
 * produces, which would have shipped the same failure in a new costume.
 *
 * The second cut added a second class of case, and it is the one to read first: **a thing that is
 * merely true does not get to ask a question.** The graded run of 5639406342 spent four of its 23
 * turns on his own health and mana bars and five on a fight that had already finished, and the
 * lines that came back were true, useless, and indistinguishable from lines about any other game.
 * `nothing asks about a bar he is looking at` and `a finished fight is the post-game reviewer's
 * job` are those measurements, pinned so they cannot quietly come back.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import {
	commitTurn,
	describeTurn,
	contestableObjective,
	COUNTERPART_ABSENT_SEC,
	dueTurn,
	HEARTBEAT_SEC,
	newEventWatch,
	objectiveStates,
	observeTick,
	projectTick,
	FIGHT_MIN_DEATHS,
	FIGHT_QUIET_SEC,
	materialDiff,
	OBJECTIVE_LEAD_SEC,
	REACH_FLIP_SEC,
	RESPAWN_HORIZON_SEC,
	SHOP_SPEND_GOLD,
	CONTEXT_CARRY_SEC,
	DRAKE_FIRST_SPAWN_SEC,
	GRUBS_SPAWN_SEC,
	nextOpeningSec,
	STANDING_SILENCE_SEC,
	type EventWatch,
	type LiveEvent,
	type LiveEventKind,
	type LiveTick,
	type ReachFn
} from "./live-events.ts"
import { SETTLE_SEC } from "./live-schedule.ts"

/*
 * THE TWO NAMES THE CLIENT USES, and the reason this fixture carries both.
 *
 * :2999 gives every roster row a TAGGED `riotId`/`summonerName` and a BARE `riotIdGameName`, and it
 * names event participants by the BARE form only — verified on the recorded samples of game
 * 5639406342: `activePlayer.riotId` is "Gooskaffur#NA1" and a real `ChampionKill` reads
 * `{"KillerName":"uglysand","VictimName":"Useless"}`.
 *
 * This fixture used to omit `riotIdGameName` entirely and pass the TAGGED name as an event victim,
 * so it asserted a payload shape :2999 never sends — and it therefore passed while
 * `e.victim === tick.me.name` was structurally false and his own deaths were being classified
 * `death.enemy`. A fixture that cannot reproduce the bug is not testing the join.
 */
const ME = "Gooskaffur#NA1"
const ME_BARE = "Gooskaffur"
const CP = "shieda kayn#NA1"
const CP_BARE = "shieda kayn"
const ALLY = "Ally#NA1"
const ALLY_BARE = "Ally"

/** A raw `allgamedata` payload, shaped exactly as :2999 answers it. */
const raw = (opts: {
	t: number
	hp?: number
	maxHp?: number
	mana?: number
	maxMana?: number
	level?: number
	dead?: boolean
	gold?: number
	/** How many of the enemy's two NON-jungle rows are lying down. See `ENEMIES_DOWN_FREE`. */
	enemiesDead?: number
	items?: Array<{ displayName: string; price: number }>
	enemyJungle?: { level?: number; cs?: number; dead?: boolean; deaths?: number; items?: number }
	events?: Array<Record<string, unknown>>
}) => ({
	gameData: { gameTime: opts.t },
	activePlayer: {
		riotId: ME,
		currentGold: opts.gold ?? 100,
		championStats: {
			currentHealth: opts.hp ?? 1000,
			maxHealth: opts.maxHp ?? 1000,
			resourceValue: opts.mana ?? 400,
			resourceMax: opts.maxMana ?? 400,
			resourceType: "MANA"
		}
	},
	allPlayers: [
		{
			riotId: ME,
			summonerName: ME,
			riotIdGameName: ME_BARE,
			championName: "Lillia",
			team: "ORDER",
			position: "JUNGLE",
			level: opts.level ?? 1,
			isDead: opts.dead === true,
			respawnTimer: opts.dead === true ? 20 : 0,
			scores: { kills: 0, deaths: 0, assists: 0, creepScore: 10 },
			items: opts.items ?? []
		},
		{
			riotId: CP,
			summonerName: CP,
			riotIdGameName: CP_BARE,
			championName: "Kayn",
			team: "CHAOS",
			position: "JUNGLE",
			level: opts.enemyJungle?.level ?? 1,
			isDead: opts.enemyJungle?.dead === true,
			respawnTimer: 0,
			scores: {
				kills: 0,
				// The SCOREBOARD, which is where `WindowMark.cpDeaths` reads. The kill log is a
				// separate statement and the fingerprint deliberately does not read it.
				deaths: opts.enemyJungle?.deaths ?? 0,
				assists: 0,
				creepScore: opts.enemyJungle?.cs ?? 0
			},
			items: Array.from({ length: opts.enemyJungle?.items ?? 0 }, () => ({ displayName: "x", price: 1 }))
		},
		{
			riotId: ALLY,
			summonerName: ALLY,
			riotIdGameName: ALLY_BARE,
			championName: "Ashe",
			team: "ORDER",
			position: "BOTTOM",
			level: 1,
			isDead: false,
			respawnTimer: 0,
			scores: { kills: 0, deaths: 0, assists: 0, creepScore: 0 },
			items: []
		},
		/*
		 * TWO MORE ENEMIES, so `ENEMIES_DOWN_FREE` can be reached without killing the counterpart —
		 * which is a different field of the fingerprint and would confound every test of this one.
		 */
		...["Draven", "Yone"].map((champion, i) => ({
			riotId: `${champion}#NA1`,
			summonerName: `${champion}#NA1`,
			riotIdGameName: champion,
			championName: champion,
			team: "CHAOS",
			position: i === 0 ? "BOTTOM" : "MIDDLE",
			level: 1,
			isDead: i < (opts.enemiesDead ?? 0),
			respawnTimer: 0,
			scores: { kills: 0, deaths: 0, assists: 0, creepScore: 0 },
			items: []
		}))
	],
	events: { Events: opts.events ?? [] }
})

const tickOf = (opts: Parameters<typeof raw>[0]): LiveTick => {
	const t = projectTick(raw(opts) as never)
	ok(t !== null, "projectTick should read this payload")
	return t
}

/** Feed a run of ticks and collect every event kind that fired. */
const run = (ticks: Array<Parameters<typeof raw>[0]>): LiveEventKind[] =>
	runEvents(ticks).map(e => e.kind)

/** The same run, with the flag that decides everything. See `LiveEvent.asks`. */
const runEvents = (
	ticks: Array<Parameters<typeof raw>[0]>,
	opts: { reach?: ReachFn } = {}
): LiveEvent[] => {
	const watch = newEventWatch()
	const out: LiveEvent[] = []
	for (const o of ticks) out.push(...observeTick(watch, tickOf(o), opts))
	return out
}

/**
 * The kinds that CAUSED a turn in this run — the only thing the third cut changed.
 *
 * Assertions about volume are written against this rather than against the kind list, because a
 * detector firing and the coach being asked are now two different statements and most of this file
 * detects far more than it asks.
 */
const asked = (events: LiveEvent[]): LiveEventKind[] =>
	events.filter(e => e.asks).map(e => e.kind)

/**
 * A pending event, spelled out. `asks` is explicit in every call because it is the only field that
 * decides anything — see `dueTurn`.
 */
const ev = (e: {
	kind: LiveEventKind
	atSec: number
	key: string
	asks: boolean
	reactive?: boolean
	note?: string
	/** When the detector SAW it. Defaults to `atSec`, which is the ordinary case for a context note. */
	seenAtSec?: number
	value?: number
}): LiveEvent => ({
	kind: e.kind,
	atSec: e.atSec,
	asks: e.asks,
	windowKey: null,
	reactive: e.reactive === true,
	seenAtSec: e.seenAtSec ?? e.atSec,
	value: e.value ?? 0,
	key: e.key,
	note: e.note ?? ""
})

/** Killer and victim are BARE game names, because that is the only thing :2999 puts here. */
const kill = (id: number, t: number, victim: string, killer = "Someone") => ({
	EventID: id,
	EventName: "ChampionKill",
	EventTime: t,
	KillerName: killer,
	VictimName: victim
})

describe("projectTick", () => {
	it("returns null before the game exists, which is most of the socket's life", () => {
		strictEqual(projectTick(null), null)
		strictEqual(projectTick({} as never), null)
		strictEqual(projectTick({ gameData: {} } as never), null)
	})

	it("finds him by riotId and keeps the counterpart separate", () => {
		const t = tickOf({ t: 60 })
		strictEqual(t.me.champion, "Lillia")
		strictEqual(t.players.length, 5)
	})
})

describe("a kill is not a turn", () => {
	/*
	 * THE regression. 62 kills in the live log of the graded game; firing on each gave 105 turns
	 * against the timer's 85. An ally dying is something he watched happen on his own minimap —
	 * visible by construction, which is the same test the app applies to what may be SAID.
	 */
	it("an ally's death does not fire on its own", () => {
		const kinds = run([
			{ t: 260 },
			{ t: 270, events: [kill(1, 265, ALLY_BARE)] }
		])
		ok(!kinds.includes("death.counterpart"), `expected no death turn, got ${kinds.join(",")}`)
	})

	/*
	 * HIS OWN DEATH ASKS NOTHING, and this is the second cut's least obvious call.
	 *
	 * He is looking at a grey screen for 10-45 seconds and cannot act on an answer, so the question
	 * is asked at the RESPAWN instead — the fork in the road, and the turn that actually scored
	 * useful in the graded run ("that death at dragon was tough but we can't change it, so let's
	 * reset and run straight to those Voidgrubs"). Two turns per death became one, at the end that
	 * can be acted on.
	 */
	it("his own death asks nothing while he is down", () => {
		/*
		 * Written against `asks` rather than against the kind list, because since the third cut the
		 * drake window at 5:00 legitimately opens at t=260 and that is a question about the next
		 * forty seconds rather than about the corpse.
		 */
		const events = runEvents([
			{ t: 100 },
			{ t: 110, events: [kill(1, 105, ME_BARE)], dead: true }
		])
		deepStrictEqual(asked(events), ["game.start"])
		ok(!events.some(e => e.kind === "respawn.self"), "he is still down")
	})

	/*
	 * IT MUST STILL COME FROM THE KILL LOG, and this is how that stays testable now that the death
	 * itself is silent.
	 *
	 * `e.victim === tick.me.name` used to compare a BARE event name against a TAGGED roster id, so
	 * it was false for every death in every game and the log's branch was dead code. The observable
	 * consequence today is the KILLER's champion, which exists nowhere but the log: if the join
	 * breaks, the respawn note falls back to "he is back up" and says nothing about what happened.
	 */
	it("the respawn carries who killed him, off the kill log", () => {
		const watch = newEventWatch()
		observeTick(watch, tickOf({ t: 260 }))
		observeTick(watch, tickOf({ t: 270, events: [kill(1, 265, ME_BARE, CP_BARE)], dead: true }))
		const back = observeTick(watch, tickOf({ t: 290, events: [kill(1, 265, ME_BARE, CP_BARE)] }))
		const respawn = back.find(e => e.kind === "respawn.self")
		ok(respawn !== undefined, `no respawn.self in ${back.map(e => e.kind).join(",")}`)
		ok(/Kayn/.test(respawn.note), `the killer's champion should be named: ${respawn.note}`)
		ok(!/Gooskaffur/.test(respawn.note), respawn.note)
	})

	/*
	 * The same join, the other way round: his row must be findable by the name the event log uses,
	 * or his own kills render under his summoner name instead of his champion.
	 */
	it("names him by champion when he is the killer", () => {
		const watch = newEventWatch()
		observeTick(watch, tickOf({ t: 260 }))
		const fired = observeTick(watch, tickOf({ t: 270, events: [kill(1, 265, CP_BARE, ME_BARE)] }))
		const note = fired.map(e => e.note).join(" | ")
		ok(/Lillia/.test(note), note)
		ok(!/Gooskaffur/.test(note), note)
	})

	/*
	 * THE COUNTERPART'S DEATH IS GATED ON THERE BEING SOMETHING TO TAKE.
	 *
	 * It is the one death he very likely did not see, but on its own it is only a fact about a man
	 * who is not on his screen. What makes it worth a question is the window it opens, and in the
	 * graded game the three sampled counterpart deaths split exactly on that: 20:53 with Baron
	 * standing was useful, 25:39 while HE was also dead was useless, and 28:12 with the next drake
	 * and the next Baron both more than a minute away was false.
	 */
	it("the counterpart's death fires when there is a window it opens", () => {
		const kinds = run([{ t: 260 }, { t: 270, events: [kill(1, 265, CP_BARE)] }])
		ok(kinds.includes("death.counterpart"), kinds.join(","))
	})

	it("the counterpart's death asks nothing with no objective in reach", () => {
		const kinds = run([{ t: 100 }, { t: 110, events: [kill(1, 105, CP_BARE)] }])
		ok(!kinds.includes("death.counterpart"), kinds.join(","))
	})

	it("the counterpart's death asks nothing while he is dead himself", () => {
		const kinds = run([
			{ t: 260, dead: true },
			{ t: 270, dead: true, events: [kill(1, 265, CP_BARE)] }
		])
		ok(!kinds.includes("death.counterpart"), kinds.join(","))
	})

	/*
	 * A FINISHED FIGHT IS THE POST-GAME REVIEWER'S JOB.
	 *
	 * `fight.resolved` asked "what did that trade buy" eight seconds after the killing stopped. It
	 * was the largest single source of turns in the old list (15 of 68) and the worst hit rate in
	 * the graded run — 1 useful in 6, and that one line was about his completed items and the drake
	 * clock rather than about the fight. By the time a fight has been over for eight seconds he has
	 * watched the recap on his own screen, so it fails "not visible" as squarely as a health bar.
	 */
	it("a fight that has finished asks nothing on its own", () => {
		/*
		 * The third cut brings `fight.resolved` BACK as a detector and leaves it silent as a
		 * question. With no objective inside the lead there is no window for it to change, so it
		 * causes nothing — which is the second cut's finding, preserved exactly.
		 */
		const events = runEvents([
			{ t: 100 },
			{ t: 102, events: [kill(1, 101, ALLY_BARE), kill(2, 102, CP_BARE)] },
			{ t: 120, events: [kill(1, 101, ALLY_BARE), kill(2, 102, CP_BARE)] },
			{ t: 160, events: [kill(1, 101, ALLY_BARE), kill(2, 102, CP_BARE)] }
		])
		deepStrictEqual(asked(events), ["game.start"])
		ok(
			events.some(e => e.kind === "fight.resolved"),
			"it is still detected, because a window it could change would want it"
		)
	})
})

describe("the event log", () => {
	it("adopts a log it joins late without firing it", () => {
		/*
		 * The page can be opened at 14:00. Replaying the whole log would fire nine deaths and four
		 * drakes at once, every one of them minutes old.
		 */
		const kinds = run([
			{
				t: 840,
				events: [kill(1, 100, ME_BARE), kill(2, 200, CP_BARE), { EventID: 3, EventName: "DragonKill", EventTime: 300 }]
			}
		])
		/*
		 * The objective questions are allowed to fire — a drake that has been standing since 10:00 is
		 * a fact about NOW, not about the log. What must not fire is the history: two deaths and a
		 * drake that happened while nobody was watching.
		 */
		ok(!kinds.includes("death.counterpart"), kinds.join(","))
		ok(!kinds.includes("objective.taken"), kinds.join(","))
		ok(kinds.includes("game.start"))
	})

	it("counts drakes, barons, heralds, grubs and inhibitors — and not turrets", () => {
		const base = [{ EventID: 1, EventName: "DragonKill", EventTime: 300, DragonType: "Cloud" }]
		const kinds = run([
			{ t: 290 },
			{
				t: 310,
				events: [
					...base,
					{ EventID: 2, EventName: "TurretKilled", EventTime: 305 },
					{ EventID: 3, EventName: "InhibKilled", EventTime: 308 }
				]
			}
		])
		strictEqual(kinds.filter(k => k === "objective.taken").length, 2)
	})

	/*
	 * GRUBS ARE ONE TURN, not three. `HordeKill` was missing from the list entirely — the one
	 * objective that is most exclusively a jungler's was the one the coach never mentioned — and it
	 * fires three times per spawn, all inside about twenty seconds of map.
	 */
	it("a grub cluster is one objective, not three", () => {
		const horde = (id: number, t: number) => ({ EventID: id, EventName: "HordeKill", EventTime: t })
		const kinds = run([
			{ t: 600 },
			{ t: 650, events: [horde(1, 622), horde(2, 634), horde(3, 645)] }
		])
		strictEqual(kinds.filter(k => k === "objective.taken").length, 1, kinds.join(","))
	})
})

describe("his own state", () => {
	/*
	 * ONLY THE ULTIMATE LEVELS. 2 and 3 cost two turns in the graded game and produced two of its
	 * six false lines, and they were the wrong question independently of the falsehood: a jungler
	 * reaches 3 on his own first clear by construction and nothing about his route changes there.
	 */
	it("an ultimate level fires; a first-clear level does not", () => {
		const kinds = run([{ t: 100, level: 1 }, { t: 110, level: 3 }, { t: 120, level: 5 }])
		ok(!kinds.includes("level.spike"), kinds.join(","))
		strictEqual(run([{ t: 100, level: 5 }, { t: 110, level: 6 }, { t: 200, level: 7 }])
			.filter(k => k === "level.spike").length, 1)
	})

	/*
	 * AN ITEM COMPLETES BY THE COMBINE, not by a price, and this is the measurement that forced it.
	 *
	 * The old rule — "a new name whose `price` is at least 1100" — fired EXACTLY ONCE in the whole
	 * 28-minute recorded game, on a Needlessly Large Rod, and missed both legendaries. `price` on a
	 * live item row is the COMBINE cost: Liandry's Torment reads 800 and Riftmaker 950, while a bare
	 * Rod reads its full 1200. So the rule was biased against exactly the purchases that matter.
	 */
	it("a legendary completing fires even though its own price is small", () => {
		const kinds = run([
			{
				t: 100,
				items: [
					{ displayName: "Fated Ashes", price: 500 },
					{ displayName: "Haunting Guise", price: 500 }
				]
			},
			{ t: 110, items: [{ displayName: "Liandry's Torment", price: 800 }] }
		])
		ok(kinds.includes("item.completed"), kinds.join(","))
	})

	it("a big component bought outright is not a spike", () => {
		const kinds = run([
			{ t: 100, items: [{ displayName: "Boots", price: 300 }] },
			{
				t: 110,
				items: [
					{ displayName: "Boots", price: 300 },
					{ displayName: "Needlessly Large Rod", price: 1200 }
				]
			}
		])
		ok(!kinds.includes("item.completed"), kinds.join(","))
	})

	/*
	 * A 5-second sample can catch a back in which a legendary AND its next components are bought at
	 * once — which is what happened at 22:07 in the recorded game, where the slot count went UP
	 * across the tick that completed Riftmaker. A rule watching the slot count would have missed it.
	 */
	it("a combine bought alongside new components still fires", () => {
		const kinds = run([
			{
				t: 100,
				items: [
					{ displayName: "Fated Ashes", price: 500 },
					{ displayName: "Haunting Guise", price: 500 }
				]
			},
			{
				t: 110,
				items: [
					{ displayName: "Riftmaker", price: 950 },
					{ displayName: "Amplifying Tome", price: 400 },
					{ displayName: "Amplifying Tome", price: 400 }
				]
			}
		])
		ok(kinds.includes("item.completed"), kinds.join(","))
	})

	/*
	 * NOTHING ASKS ABOUT A BAR HE IS LOOKING AT.
	 *
	 * `resource.low` fired when health or mana crossed a band. Four of the twelve true-but-useless
	 * lines in the graded run came from it, all four his own numbers read back to him, and four
	 * separate "you are low, back now" turns in one game is the fixed timer's failure reproduced in
	 * a new costume. The bands survive as constants because the brief PRINTS them; they ask nothing.
	 */
	it("a health bar crossing a band asks nothing", () => {
		const kinds = run([
			{ t: 100, hp: 1000, mana: 400 },
			{ t: 102, hp: 100, mana: 20 },
			{ t: 104, hp: 90, mana: 10 },
			{ t: 106, hp: 80, mana: 5 }
		])
		deepStrictEqual(kinds, ["game.start"])
	})

	it("a respawn fires, and carries nothing about the bars", () => {
		const kinds = run([
			{ t: 100 },
			{ t: 110, dead: true, hp: 0, mana: 0 },
			{ t: 140, hp: 1000, mana: 400 }
		])
		ok(kinds.includes("respawn.self"), kinds.join(","))
	})
})

describe("the counterpart", () => {
	/*
	 * HIS ABSENCE ASKS; HIS PRESENCE DOES NOT. The counter only moves again because somebody on his
	 * team has eyes on the man — very often him — so "he surfaced" is the screen telling him
	 * something it has already told him, and its one graded line was false. The absence is
	 * asymmetric: it is the single thing about the enemy jungler no screen can supply.
	 */
	it("goes missing when nothing about him moves, and says nothing when he returns", () => {
		const kinds = run([
			{ t: 100, enemyJungle: { cs: 10 } },
			{ t: 100 + COUNTERPART_ABSENT_SEC + 5, enemyJungle: { cs: 10 } },
			{ t: 100 + COUNTERPART_ABSENT_SEC + 10, enemyJungle: { cs: 11 } },
			{ t: 100 + COUNTERPART_ABSENT_SEC + 15, enemyJungle: { cs: 12 } }
		])
		strictEqual(kinds.filter(k => k === "counterpart.unseen").length, 1, kinds.join(","))
	})
})

describe("objectives, prospectively", () => {
	it("counts the next drake from a take this game actually logged", () => {
		const t = tickOf({
			t: 700,
			events: [{ EventID: 1, EventName: "DragonKill", EventTime: 600 }]
		})
		const drake = objectiveStates(t).find(o => o.what.startsWith("drake"))
		strictEqual(drake?.spawnSec, 900)
		strictEqual(drake?.upForSec, null)
	})

	it("fires once per spawn no matter how many ticks fall inside the lead", () => {
		/*
		 * The first drake is at 5:00 and the lead is 45s, so its window opens at 4:15 and three ticks
		 * inside it are ONE turn. Voidgrubs are at 8:00 — they used to be at 5:00 here and in the
		 * brief, both a patch behind, so this run used to raise two windows at once and the second
		 * of them was three minutes before the grubs existed.
		 */
		const kinds = run([{ t: 250 }, { t: 270 }, { t: 280 }, { t: 290 }])
		strictEqual(kinds.filter(k => k === "window.open").length, 1, kinds.join(","))
	})

	it("raises the grub window at 8:00 and not at 5:00", () => {
		const early = run([{ t: 250 }, { t: 270 }]).filter(k => k === "window.open")
		strictEqual(early.length, 1, "only the drake window is open before 5:00")
		const states = objectiveStates(tickOf({ t: 400 }))
		strictEqual(states.find(o => o.what.startsWith("voidgrubs"))?.spawnSec, 480)
		strictEqual(states.find(o => o.what.startsWith("rift herald"))?.spawnSec, 900)
	})

	/*
	 * AN OBJECTIVE STANDING UNTAKEN IS STILL ONE WINDOW.
	 *
	 * Baron spawned at 20:00 in the recorded game and fell at 23:29 — 209 seconds standing — and
	 * Herald stood for 182. The second cut answered that with an `objective.contested` event at 60
	 * seconds; the third cut made it ask nothing, which left it inert, and the fourth cut deleted it
	 * and gave the job to `window.standing`, which is gated on the SILENCE rather than on a clock.
	 * What must not come back is a second WINDOW for the same instance.
	 */
	it("a window is one instance, standing or not", () => {
		const kinds = run([{ t: 270 }, { t: 300 }, { t: 355 }, { t: 365 }])
		strictEqual(kinds.filter(k => k === "window.open").length, 1, kinds.join(","))
	})

	it("stops asking about an objective that was taken", () => {
		const kinds = run([
			{ t: 290 },
			{ t: 310, events: [{ EventID: 1, EventName: "DragonKill", EventTime: 305 }] },
			{ t: 400, events: [{ EventID: 1, EventName: "DragonKill", EventTime: 305 }] }
		])
		strictEqual(kinds.filter(k => k === "window.open").length, 1, kinds.join(","))
		ok(kinds.includes("objective.taken"), kinds.join(","))
	})

	/*
	 * A WINDOW HE IS DEAD FOR IS NOT A DECISION HE HAS.
	 *
	 * At 13:16 in the graded run the herald window fired while he was twelve seconds into a
	 * twenty-one-second death, and the model answered "you are dead so that is generic" — a turn
	 * spent, out loud, saying it had nothing. The key is unspent, so it fires on the first tick he
	 * is back up and still inside the window.
	 */
	it("does not ask about a window while he is dead, and asks once he is up", () => {
		const kinds = run([
			{ t: 250 },
			{ t: 270, dead: true },
			{ t: 280, dead: true },
			{ t: 290 }
		])
		strictEqual(kinds.filter(k => k === "window.open").length, 1, kinds.join(","))
	})

	it("the gate on a counterpart death is the nearest thing he could take", () => {
		strictEqual(contestableObjective(tickOf({ t: 100 })), null)
		strictEqual(contestableObjective(tickOf({ t: 270 }))?.what, "drake")
		strictEqual(contestableObjective(tickOf({ t: 400 }))?.upForSec, 100)
	})

	/*
	 * GRUBS AND HERALD LEAVE THE MAP. Without a despawn the grubs would read as up and untaken from
	 * 8:00 until the end of the game and Herald from 15:00 forever, and `window.standing` would
	 * ask about monsters that are not there.
	 */
	it("an objective that has left the map is neither up nor asked about", () => {
		const late = objectiveStates(tickOf({ t: 1000 }))
		strictEqual(late.find(o => o.what.startsWith("voidgrubs")), undefined)
		const gone = objectiveStates(tickOf({ t: 1300 }))
		strictEqual(gone.find(o => o.what.startsWith("rift herald")), undefined)
	})
})

describe("the window is the unit", () => {
	/*
	 * THE REGRESSION THE THIRD CUT IS FOR.
	 *
	 * Round 2 asked 38 times over game 5639406342 and produced three separate drake lines inside
	 * nineteen seconds — 18:02 off a Herald take, 18:08 off the counterpart going dark, 18:21 off
	 * level 11 — all three about the same drake spawning at 18:41. Three event kinds, one decision.
	 * Twenty of the 37 lines were true and useless, and this was the shape of most of them.
	 */
	it("many events about one window are ONE ask", () => {
		const events = runEvents([
			{ t: 250 },
			{ t: 262 },
			{ t: 275, level: 6 },
			{ t: 288, level: 6 }
		])
		deepStrictEqual(asked(events), ["game.start", "window.open"])
		ok(
			events.some(e => e.kind === "level.spike"),
			"the level is still detected — it rides the turn, it just does not cause one"
		)
	})

	it("the opening ask names the window it is about", () => {
		const open = runEvents([{ t: 250 }, { t: 262 }]).find(e => e.kind === "window.open")
		ok(open !== undefined)
		strictEqual(open.windowKey, "drake:300")
		ok(/drake in 3\ds \(lead\)/.test(open.note), open.note)
	})

	/*
	 * A SECOND ASK HAS TO BE PAID FOR, and `materialDiff` is the price. Every field it compares is
	 * declared on `WindowMark` with the threshold that moves it.
	 */
	it("the counterpart dying re-asks the window his death opened", () => {
		const events = runEvents([
			{ t: 250 },
			{ t: 262 },
			{ t: 275, events: [kill(1, 270, CP_BARE)], enemyJungle: { deaths: 1 } }
		])
		deepStrictEqual(asked(events), ["game.start", "window.open", "window.changed"])
		const chg = events.find(e => e.kind === "window.changed")!
		strictEqual(chg.windowKey, "drake:300")
		ok(/counterpart died/.test(chg.note), chg.note)
	})

	it("another objective falling re-asks the windows still open", () => {
		/*
		 * Both of round 2's useful `objective.taken` lines are this and nothing else — 7:23 "Kayn
		 * just took that drake bot side, so he's there, making those grubs free" and 18:02 "Kayn
		 * just got Herald topside, so path bot to secure this drake". Neither is about the thing
		 * that fell; both are about the thing that has not.
		 */
		const events = runEvents([
			{ t: 440 },
			{ t: 460 },
			{ t: 470, events: [{ EventID: 9, EventName: "DragonKill", EventTime: 465 }] }
		])
		const chg = events.filter(e => e.kind === "window.changed")
		strictEqual(chg.length, 1, events.map(e => e.kind).join(","))
		strictEqual(chg[0]!.windowKey, "grubs:480")
		ok(/another objective fell/.test(chg[0]!.note), chg[0]!.note)
	})

	it("an inhibitor is context, not a take — it re-prices no jungle contest", () => {
		const events = runEvents([
			{ t: 440 },
			{ t: 460 },
			{ t: 470, events: [{ EventID: 9, EventName: "InhibKilled", EventTime: 465 }] }
		])
		ok(!events.some(e => e.kind === "window.changed"), events.map(e => e.kind).join(","))
		ok(events.some(e => e.kind === "objective.taken"), "still detected, still carried")
	})

	/*
	 * THE RATCHET. A boolean "two of them are down right now" flapped three asks in thirteen seconds
	 * over the graded game — 11:57 down, 12:04 up, 12:10 down — which is the fault this cut removes
	 * wearing a new hat. A spell opens on the second body and does not close until they are ALL back.
	 */
	it("the enemy team opening up asks once, and trading bodies back does not ask again", () => {
		const events = runEvents([
			{ t: 250 },
			{ t: 262 },
			{ t: 270, enemiesDead: 2 },
			{ t: 280, enemiesDead: 1 },
			{ t: 290, enemiesDead: 2 },
			{ t: 300, enemiesDead: 1 }
		])
		const chg = events.filter(e => e.kind === "window.changed")
		strictEqual(chg.length, 1, chg.map(e => e.note).join(" | "))
		ok(/two enemies are down/.test(chg[0]!.note), chg[0]!.note)
	})

	it("a fresh spell asks again once they are all back up first", () => {
		const events = runEvents([
			{ t: 250 },
			{ t: 262 },
			{ t: 270, enemiesDead: 2 },
			{ t: 280, enemiesDead: 0 },
			{ t: 290, enemiesDead: 2 }
		])
		strictEqual(events.filter(e => e.kind === "window.changed").length, 2)
	})

	it("backing re-asks, and one visit to the shop is one trip", () => {
		const events = runEvents([
			{ t: 250, gold: 1400 },
			{ t: 262, gold: 1400 },
			{ t: 268, gold: 700 },
			{ t: 274, gold: 100 }
		])
		const chg = events.filter(e => e.kind === "window.changed")
		strictEqual(chg.length, 1, chg.map(e => e.note).join(" | "))
		ok(/he backed/.test(chg[0]!.note), chg[0]!.note)
		strictEqual(events.filter(e => e.kind === "shop.trip").length, 1)
	})

	it("a ward on the way past the shop is not a trip", () => {
		const events = runEvents([
			{ t: 250, gold: 1400 },
			{ t: 262, gold: 1400 },
			{ t: 268, gold: 1325 }
		])
		ok(!events.some(e => e.kind === "shop.trip"), events.map(e => e.note).join(" | "))
		ok(!events.some(e => e.kind === "window.changed"))
	})

	/*
	 * A WINDOW THAT CLOSES WITHOUT AN ASK IS FINE, and so is a quiet stretch. The grubs spawn, stand
	 * and are taken while he is on a grey screen; nothing about that was ever his decision.
	 */
	it("a window he was dead for the whole of asks nothing and then closes", () => {
		const taken = [{ EventID: 4, EventName: "HordeKill", EventTime: 495 }]
		const events = runEvents([
			{ t: 430, dead: true },
			{ t: 450, dead: true },
			{ t: 490, dead: true },
			{ t: 500, dead: true, events: taken },
			{ t: 520, events: taken }
		])
		ok(
			!events.some(e => e.asks && e.windowKey === "grubs:480"),
			events.filter(e => e.asks).map(e => `${e.kind}:${e.windowKey}`).join(",")
		)
	})

	it("a window is never re-opened once it has closed", () => {
		const taken = [{ EventID: 4, EventName: "HordeKill", EventTime: 490 }]
		const events = runEvents([
			{ t: 440 },
			{ t: 460 },
			{ t: 500, events: taken },
			{ t: 560, events: taken }
		])
		strictEqual(events.filter(e => e.kind === "window.open" && e.windowKey === "grubs:480").length, 1)
	})

	/*
	 * THE RESPAWN HORIZON — the one opening that looks past the flat lead, and the measurement that
	 * narrowed it. Round 2's useful 10:44 line plans for a drake 99 seconds out, from the fountain.
	 * Letting a respawn open EVERY window inside the horizon opened Herald 92 seconds early off an
	 * unrelated death and destroyed round 2's useful 14:17 line, so it opens the soonest one only.
	 */
	it("leaving the fountain opens the soonest objective even past the lead", () => {
		const log = [
			{ EventID: 1, EventName: "DragonKill", EventTime: 300 },
			{ EventID: 2, EventName: "HordeKill", EventTime: 450 }
		]
		const events = runEvents([
			{ t: 470, dead: true, events: log },
			{ t: 490, events: log }
		])
		const open = events.find(e => e.kind === "window.open")
		ok(open !== undefined, events.map(e => e.kind).join(","))
		strictEqual(open.windowKey, "drake:600")
		ok(/\(respawn\)/.test(open.note), open.note)
		ok(open.reactive, "a window opened by him walking out of base decays in seconds")
	})

	it("and only the soonest — a respawn does not open the whole map", () => {
		const log = [{ EventID: 1, EventName: "DragonKill", EventTime: 300 }]
		const events = runEvents([
			{ t: 470, dead: true, events: log },
			{ t: 490, events: log }
		])
		const opened = events.filter(e => e.kind === "window.open").map(e => e.windowKey)
		// Grubs are standing since 8:00 and are the nearest thing; the 10:00 drake is not his problem yet.
		deepStrictEqual(opened, ["grubs:480"])
	})

	it("a respawn with nothing inside the horizon asks nothing at all", () => {
		const log = [
			{ EventID: 1, EventName: "DragonKill", EventTime: 300 },
			{ EventID: 2, EventName: "HordeKill", EventTime: 450 }
		]
		const events = runEvents([
			{ t: 380, dead: true, events: log },
			{ t: 400, events: log }
		])
		deepStrictEqual(asked(events), ["game.start"], events.map(e => e.kind).join(","))
		ok(events.some(e => e.kind === "respawn.self"), "still detected, still carried")
	})

	/*
	 * THE REACHABILITY PORT. Not built here — see `ReachFn`. What is tested is that the default is
	 * honest and that a real module changes the opening rather than the wording.
	 */
	it("with no reachability module the flat lead decides and nothing flaps", () => {
		const events = runEvents([{ t: 180 }, { t: 190 }])
		ok(!events.some(e => e.kind === "window.open"), "110s out is not a decision at 45s of lead")
	})

	it("an ETA opens the window when he could still get there", () => {
		const reach: ReachFn = () => ({ verdict: "can", etaSec: 100 })
		strictEqual(
			runEvents([{ t: 170 }, { t: 178 }], { reach }).some(e => e.kind === "window.open"),
			false,
			"122s out is past an eta of 100 plus the margin"
		)
		const open = runEvents([{ t: 180 }, { t: 190 }], { reach }).find(e => e.kind === "window.open")
		ok(open !== undefined, "110s out is inside an eta of 100 plus the margin")
		strictEqual(open.windowKey, "drake:300")
	})

	it("a reach verdict has to hold before it counts as a change", () => {
		let verdict: "can" | "cannot" | "unknown" = "can"
		const reach: ReachFn = () => ({ verdict, etaSec: null })
		const watch = newEventWatch()
		observeTick(watch, tickOf({ t: 250 }), { reach })
		observeTick(watch, tickOf({ t: 262 }), { reach })
		verdict = "cannot"
		const tooSoon = observeTick(watch, tickOf({ t: 268 }), { reach })
		ok(!tooSoon.some(e => e.kind === "window.changed"), "a flicker is not a flip")
		const stillTooSoon = observeTick(watch, tickOf({ t: 268 + REACH_FLIP_SEC - 2 }), { reach })
		ok(!stillTooSoon.some(e => e.kind === "window.changed"), "held, but not long enough")
		const held = observeTick(watch, tickOf({ t: 268 + REACH_FLIP_SEC + 2 }), { reach })
		const chg = held.find(e => e.kind === "window.changed")
		ok(chg !== undefined, held.map(e => e.kind).join(","))
		ok(/reach can -> cannot/.test(chg.note), chg.note)
	})

	it("materialDiff on an unchanged fingerprint is empty, which is the normal case", () => {
		const mark = {
			myDeaths: 2,
			cpDeaths: 1,
			cpReappearances: 0,
			enemiesOpened: 1,
			shopTrips: 3,
			takes: 4,
			reach: "unknown" as const
		}
		deepStrictEqual(materialDiff(mark, { ...mark }), [])
		deepStrictEqual(materialDiff(mark, { ...mark, takes: 5 }), ["another objective fell"])
	})

	/*
	 * CONTEXT GOES STALE. The window trigger can leave minutes between turns — Riftmaker completed
	 * at 22:06 in the graded game and the next window ask is at 23:50 — and "you just finished
	 * Riftmaker" is a lie by 104 seconds at that point. Nothing that ASKS is ever dropped.
	 */
	it("stale context is dropped from the queue and asks are not", () => {
		const watch = newEventWatch()
		observeTick(watch, tickOf({ t: 250 }))
		watch.pending.push(...observeTick(watch, tickOf({ t: 262, level: 6 })))
		ok(watch.pending.some(e => e.kind === "level.spike"))
		ok(watch.pending.some(e => e.asks))
		observeTick(watch, tickOf({ t: 262 + CONTEXT_CARRY_SEC + 10, level: 6 }))
		ok(!watch.pending.some(e => e.kind === "level.spike"), "the spike is no longer news")
		ok(watch.pending.some(e => e.asks), "the window ask is still waiting for a turn")
	})

	it("a quiet stretch is only broken by the floor", () => {
		const watch = newEventWatch()
		watch.pending.push(...observeTick(watch, tickOf({ t: 100 })))
		commitTurn(watch, dueTurn(watch, 100)!, 100)
		for (const t of [120, 140, 160, 180, 200, 220])
			watch.pending.push(...observeTick(watch, tickOf({ t })))
		// The opening look is spent; the drake window is still 80 seconds from being a decision.
		strictEqual(dueTurn(watch, 220), null, "nothing has happened since the first look")
		const beat = dueTurn(watch, 100 + HEARTBEAT_SEC + 1)
		ok(beat !== null && beat.heartbeat)
	})

	/*
	 * THE STANDING RULE, as a test. This file changes the GRANULARITY of when the model is asked and
	 * never touches what it may say — so an ask it declines to raise is a question that was not put,
	 * and there is nothing anywhere in here that reads, shortens or suppresses a line.
	 */
	it("everything that is detected still rides the turn, asking or not", () => {
		const watch = newEventWatch()
		observeTick(watch, tickOf({ t: 250, gold: 1400 }))
		watch.pending.push(
			...observeTick(watch, tickOf({ t: 262, gold: 700, level: 6, events: [kill(1, 258, CP_BARE)] }))
		)
		const reason = dueTurn(watch, 262)!
		const kinds = reason.events.map(e => e.kind)
		ok(kinds.includes("level.spike"), kinds.join(","))
		ok(kinds.includes("shop.trip"), kinds.join(","))
		ok(kinds.includes("death.counterpart"), kinds.join(","))
		strictEqual(reason.events.filter(e => e.asks).length, 1, kinds.join(","))
	})
})

describe("dueTurn", () => {
	it("says no when nothing happened — which is the whole point", () => {
		const watch = newEventWatch()
		watch.lastTurnAtSec = 100
		strictEqual(dueTurn(watch, 120), null)
	})

	it("the heartbeat is a floor, and it is reset by any turn that actually went out", () => {
		const watch = newEventWatch()
		watch.lastTurnAtSec = 100
		strictEqual(dueTurn(watch, 100 + HEARTBEAT_SEC - 1), null)
		const beat = dueTurn(watch, 100 + HEARTBEAT_SEC)
		ok(beat !== null && beat.heartbeat)
		/*
		 * `dueTurn` PEEKS. Asking twice without committing answers the same thing twice, which is
		 * the property the split exists for — the caller's very next line is `await sendTurn()` and
		 * that returns false on an empty block, a ground-truth timeout, or a refused socket send.
		 */
		ok(dueTurn(watch, 100 + HEARTBEAT_SEC + 1) !== null, "an uncommitted turn is still due")
		commitTurn(watch, beat, 100 + HEARTBEAT_SEC)
		// Committed: the next heartbeat is a full floor away from the turn taken, not from the event.
		strictEqual(dueTurn(watch, 100 + HEARTBEAT_SEC + 1), null)
	})

	/*
	 * THE FLOOR HAD TO MOVE WITH THE CUT. Removing three quarters of the event volume stretches the
	 * gaps between what remains, and a floor left at 90s would have refilled the silence the cut
	 * had just created — 4-14 heartbeats per recorded game, a third of the schedule asked about
	 * nothing in particular. Measured across `data/live-samples/`, event-turn gaps are median 43s
	 * and p95 141s, so the floor sits above p95 rather than inside the ordinary lull.
	 */
	it("the floor sits above the ordinary lull, not inside it", () => {
		ok(HEARTBEAT_SEC >= 150, `a floor at ${HEARTBEAT_SEC}s is a slower timer, not a floor`)
	})

	/*
	 * THE FAILURE THE SPLIT IS FOR. `dueTurn` used to empty `pending` and stamp `lastTurnAtSec`
	 * before the caller knew whether the payload left the page, so a death detected while the
	 * daemon hiccuped was thrown away AND bought ninety seconds of silence — in a file whose stated
	 * premise is that "a death nobody was asked about is the failure this file is replacing".
	 */
	it("a turn that never went out leaves its events queued and the floor untouched", () => {
		const watch = newEventWatch()
		watch.lastTurnAtSec = 100
		watch.pending.push(ev({ kind: "window.open", atSec: 120, reactive: true, key: "k", asks: true }))
		const reason = dueTurn(watch, 121)
		strictEqual(reason?.events.length, 1)
		// The send failed, so nothing is committed.
		strictEqual(watch.pending.length, 1, "the window ask is still queued")
		strictEqual(watch.lastTurnAtSec, 100, "the silence floor did not move")
		const retry = dueTurn(watch, 123)
		strictEqual(retry?.events[0]?.key, "k")
	})

	/*
	 * And it spends what the turn CARRIED, not the queue. `observeTick` runs on a 2-second poll and
	 * a send takes seconds, so an event detected in between has not been asked about.
	 */
	it("commit drops only the events the turn carried", () => {
		const watch = newEventWatch()
		watch.pending.push(ev({ kind: "window.open", atSec: 120, reactive: true, key: "old", asks: true }))
		const reason = dueTurn(watch, 121)!
		watch.pending.push(ev({ kind: "window.changed", atSec: 122, reactive: true, key: "new", asks: true }))
		commitTurn(watch, reason, 123)
		deepStrictEqual(
			watch.pending.map(e => e.key),
			["new"],
			"an event detected during the send must survive the commit"
		)
	})

	it("defers on an in-flight turn and never drops the events", () => {
		const watch = newEventWatch()
		watch.pending.push(ev({ kind: "window.open", atSec: 100, reactive: true, key: "k", asks: true }))
		strictEqual(dueTurn(watch, 101, { inFlight: true }), null)
		strictEqual(watch.pending.length, 1)
		const later = dueTurn(watch, 105)
		strictEqual(later?.events.length, 1)
		strictEqual(later?.events[0]?.atSec, 100)
	})

	it("skips the minimap read as soon as anything reactive is pending", () => {
		const watch = newEventWatch()
		watch.pending.push(
			ev({ kind: "window.open", atSec: 100, reactive: false, key: "a", asks: true }),
			ev({ kind: "respawn.self", atSec: 101, reactive: true, key: "b", asks: false })
		)
		strictEqual(dueTurn(watch, 102)?.readMinimap, false)
	})

	it("pays for the read when every pending event is a standing one", () => {
		const watch = newEventWatch()
		watch.pending.push(ev({ kind: "window.open", atSec: 100, reactive: false, key: "a", asks: true }))
		strictEqual(dueTurn(watch, 102)?.readMinimap, true)
	})
})

/*
 * THE TRADE, REPLAYED — the measurement the third cut was made on, kept runnable.
 *
 * This is the only test here that reads the recorded game rather than a fixture, and it is here
 * rather than in a script because it is the claim the cut is justified by: the window trigger asks
 * fewer times and STILL asks at every moment that produced a useful line. A refactor that quietly
 * loses one of the ten is the failure worth a red test.
 *
 * The ten clocks are his own blinded grading of `data/eval/stream-kayn-events2-20260910.json`, 38
 * asks sent through the real Gemini Live socket over game 5639406342. They are transcribed here and
 * MUST NOT be edited: the run file is the evidence and it is never rewritten. The false/useless
 * partition of the other 27 lines was never recorded, so nothing here claims one.
 *
 * Skips rather than fails when the samples are not on this machine.
 */
describe("the trade, replayed over game 5639406342", () => {
	/** Game clocks, in seconds, of round 2's ten useful lines. His grading, not a derivation. */
	const USEFUL_AT = [260.7, 443.4, 522.5, 644.3, 857.5, 1076.8, 1082.9, 1156.1, 1265.8, 1430.3]
	const SAMPLES = "data/live-samples/js-mtvxb5f4-f81a-t29817812.ndjson"

	const replay = (): Array<{
		atSec: number
		why: string
		heartbeat: boolean
		/** Every contest window this turn carried an ask about, and when each was detected. */
		asked: Array<{ windowKey: string | null; seenAtSec: number }>
	}> | null => {
		let raw: string
		try {
			raw = readFileSync(SAMPLES, "utf8")
		} catch {
			return null
		}
		const watch = newEventWatch()
		const out: Array<{
			atSec: number
			why: string
			heartbeat: boolean
			asked: Array<{ windowKey: string | null; seenAtSec: number }>
		}> = []
		for (const line of raw.split("\n")) {
			if (line.trim() === "") continue
			let parsed: { data?: unknown }
			try {
				parsed = JSON.parse(line) as { data?: unknown }
			} catch {
				continue
			}
			const tick = projectTick(parsed.data as never)
			if (tick === null) continue
			watch.pending.push(...observeTick(watch, tick))
			const reason = dueTurn(watch, tick.gameTimeSec)
			if (reason === null) continue
			commitTurn(watch, reason, tick.gameTimeSec)
			out.push({
				atSec: tick.gameTimeSec,
				why: describeTurn(reason),
				heartbeat: reason.heartbeat,
				asked: reason.events
					.filter(e => e.asks)
					.map(e => ({ windowKey: e.windowKey, seenAtSec: e.seenAtSec }))
			})
		}
		return out
	}

	it("asks at all ten moments that produced a useful line", t => {
		const turns = replay()
		if (turns === null) return t.skip(`${SAMPLES} is not on this machine`)
		/*
		 * 1.5s, not "the nearest turn". The trigger raises asks tens of seconds apart and a loose
		 * match would score a NEIGHBOURING question as the same one, which it is not: it is asked
		 * about a different window at a different moment and the line that comes back is different.
		 */
		const lost = USEFUL_AT.filter(at => !turns.some(x => Math.abs(x.atSec - at) <= 1.5))
		/*
		 * ONE EXCEPTION, and it is the fourth cut's entire purpose rather than a leak in it.
		 *
		 * 17:57 no longer has a turn of its own. It was the drake window opening, and the settle in
		 * `live-schedule.ts` holds it for six seconds so that it goes out at 18:03 together with the
		 * Herald that Kayn had just taken — the join that makes the drake free and the best moment in
		 * the corpus. Round 2 asked at 17:51, 17:57 and 18:03, three questions about one decision
		 * inside twelve seconds, and the coach answered PASS at 18:03 with the whole payload in hand.
		 *
		 * So the claim being kept alive here is not "a turn fires at this second" — it is "this ask
		 * still reaches the model, on a turn of its own or riding one that arrived within the
		 * settle". Checked against the WINDOW KEY, so an ask about a different objective can never
		 * launder itself into a survivor, and against `seenAtSec`, so the turn that carries it is the
		 * one it actually waited for.
		 */
		const carried = lost.filter(at =>
			turns.some(
				x =>
					x.asked.some(a => Math.abs(a.seenAtSec - at) <= 1.5) &&
					x.atSec - at > 0 &&
					x.atSec - at <= SETTLE_SEC
			)
		)
		deepStrictEqual(
			carried.map(Math.round),
			[1077],
			`the settle may only absorb the 17:57 drake window: ${carried.map(Math.round).join(", ")}`
		)
		const gone = lost.filter(at => !carried.includes(at))
		deepStrictEqual(
			gone,
			[],
			`useful moments no longer asked about: ${gone.map(x => Math.round(x)).join(", ")}s`
		)
	})

	it("asks far less often than the schedule that produced them", t => {
		const turns = replay()
		if (turns === null) return t.skip(`${SAMPLES} is not on this machine`)
		/*
		 * 28 at the time of writing, against round 2's 38 and the fixed 20-second timer's 85 over
		 * the same 28 minutes. The band is wide because the point is the direction and the ten
		 * survivors above, not this exact integer — but a trigger that drifts back over 38 has
		 * stopped being a window trigger.
		 */
		ok(turns.length >= 20 && turns.length <= 38, `${turns.length} asks over the graded game`)
		ok(
			turns.filter(x => x.heartbeat).length <= 4,
			`${turns.filter(x => x.heartbeat).length} heartbeats — the floor is becoming the cadence`
		)
	})
})

/*
 * THE FOURTH CUT's own pieces, on the fixture. The measurement that justifies them is the replay
 * below; these are the mechanics.
 */
describe("the schedule's lookahead and its floor over a standing objective", () => {
	/**
	 * The fixture's drake spawns at `DRAKE_FIRST_SPAWN_SEC` (300) and its window opens 45s before,
	 * so 255 is the tick that asks and 300 is the tick it starts standing.
	 */
	const OPENS = DRAKE_FIRST_SPAWN_SEC - OBJECTIVE_LEAD_SEC

	/** Open the drake window and spend it, leaving the watch in a genuine post-turn lull. */
	const afterTheDrakeWindow = (): EventWatch => {
		const watch = newEventWatch()
		observeTick(watch, tickOf({ t: 100 }))
		watch.pending.push(...observeTick(watch, tickOf({ t: OPENS })))
		commitTurn(watch, dueTurn(watch, OPENS)!, OPENS)
		return watch
	}

	/*
	 * `atSec` is the SUBJECT's clock and `seenAtSec` is the DETECTOR's, and the settle is entirely a
	 * statement about the second one. A window's `atSec` is its spawn, which is 45 seconds in the
	 * future at the moment it is detected — measuring "how long has this been waiting" from that
	 * would have every window ask arrive already overdue.
	 */
	it("stamps a window ask with when it was seen, not with when the thing happens", () => {
		const watch = newEventWatch()
		observeTick(watch, tickOf({ t: 100 }))
		const fired = observeTick(watch, tickOf({ t: OPENS }))
		const open = fired.find(e => e.kind === "window.open")!
		strictEqual(open.atSec, DRAKE_FIRST_SPAWN_SEC)
		strictEqual(open.seenAtSec, OPENS)
		ok(open.value > 0, "an ask carries what it is worth, computed where the tick is")
	})

	it("knows when the next window is due to open, and stops claiming one that is open", () => {
		const watch = newEventWatch()
		observeTick(watch, tickOf({ t: 100 }))
		const objectives = objectiveStates(tickOf({ t: 100 }))
		strictEqual(nextOpeningSec(watch, objectives, 100), OPENS)
		// Once the record exists the window has already asked; it is not about to arrive.
		observeTick(watch, tickOf({ t: OPENS }))
		strictEqual(
			nextOpeningSec(watch, objectiveStates(tickOf({ t: OPENS })), OPENS),
			GRUBS_SPAWN_SEC - OBJECTIVE_LEAD_SEC
		)
	})

	/*
	 * THE SILENCE, NOT THE CLOCK. This is the one addition that could turn back into the 20-second
	 * timer this file replaced, so the gate is written to be unreachable in ordinary play: it needs
	 * `STANDING_SILENCE_SEC` of having been asked NOTHING, and an empty queue.
	 */
	it("asks about an objective that has simply been standing, once the lull is real", () => {
		const watch = afterTheDrakeWindow()
		const kinds: LiveEventKind[] = []
		for (const t of [300, 320, OPENS + STANDING_SILENCE_SEC - 6])
			kinds.push(...observeTick(watch, tickOf({ t })).map(e => e.kind))
		ok(!kinds.includes("window.standing"), `fired early: ${kinds.join(",")}`)
		const late = observeTick(watch, tickOf({ t: OPENS + STANDING_SILENCE_SEC }))
		const stand = late.find(e => e.kind === "window.standing")!
		ok(stand !== undefined, late.map(e => e.kind).join(","))
		ok(stand.asks, "it is one of the five kinds that ask")
		strictEqual(stand.reactive, false, "a thing that has stood for a minute is worth the read")
		ok(stand.note.includes("drake"), stand.note)
	})

	it("stays quiet when a question is already queued, however long the silence", () => {
		const watch = afterTheDrakeWindow()
		observeTick(watch, tickOf({ t: 300 }))
		watch.pending.push(ev({ kind: "window.open", atSec: 999, key: "queued", asks: true }))
		const late = observeTick(watch, tickOf({ t: OPENS + STANDING_SILENCE_SEC + 30 }))
		ok(
			!late.some(e => e.kind === "window.standing"),
			"the silence is about to end on its own — adding to it is the cluster this cut removes"
		)
	})

	it("asks once per lull rather than once per tick", () => {
		const watch = afterTheDrakeWindow()
		let fired = 0
		for (let t = 300; t <= OPENS + STANDING_SILENCE_SEC + 60; t += 5)
			fired += observeTick(watch, tickOf({ t })).filter(e => e.kind === "window.standing").length
		strictEqual(fired, 1, "a second ask has to wait out another whole silence")
	})
})

/*
 * THE FOURTH CUT, replayed over BOTH paired games — the two failures it was built for, kept
 * runnable.
 *
 * Game 5639406342 (Lillia vs Kayn, 28:14) and 5639409343 (Lillia vs Fiddlesticks, 31:15), the two
 * games the live coach was graded on. The samples are the SUPERVISOR's own five-second poll, so the
 * block under test is the one the coach actually held. Skips rather than fails when they are not on
 * this machine.
 *
 * `--base` in `scripts/bench-events.ts` replays the same files with the cut turned off
 * (`settleSec: 0`, `standingSilenceSec: Infinity`), which is how these numbers stay derivable from
 * the evidence rather than from a note.
 */
describe("the fourth cut, replayed over both paired games", () => {
	const GAMES = {
		kayn: "data/live-samples/js-mtvxb5f4-f81a-t29817812.ndjson",
		fiddle: "data/live-samples/js-mtvxb5f4-f81a-t29817845.ndjson"
	}

	const replay = (
		file: string,
		opts: { base?: boolean } = {}
	): Array<{ atSec: number; why: string; kinds: LiveEventKind[] }> | null => {
		let rawText: string
		try {
			rawText = readFileSync(file, "utf8")
		} catch {
			return null
		}
		const watch = newEventWatch()
		const out: Array<{ atSec: number; why: string; kinds: LiveEventKind[] }> = []
		for (const line of rawText.split("\n")) {
			if (line.trim() === "") continue
			let parsed: { data?: unknown }
			try {
				parsed = JSON.parse(line) as { data?: unknown }
			} catch {
				continue
			}
			const tick = projectTick(parsed.data as never)
			if (tick === null) continue
			watch.pending.push(
				...observeTick(
					watch,
					tick,
					opts.base === true ? { standingSilenceSec: Infinity } : {}
				)
			)
			const reason = dueTurn(
				watch,
				tick.gameTimeSec,
				opts.base === true ? { settleSec: 0 } : {}
			)
			if (reason === null) continue
			commitTurn(watch, reason, tick.gameTimeSec)
			out.push({
				atSec: tick.gameTimeSec,
				why: describeTurn(reason),
				kinds: reason.events.filter(e => e.asks).map(e => e.kind)
			})
		}
		return out
	}

	/*
	 * THE NAMED BOTTLENECK. Round 2 asked at 17:51, 17:57 and 18:03 — a Herald that had been
	 * standing nearly three minutes, the drake window opening, and then Kayn TAKING that Herald top
	 * side while the drake was 39 seconds out. The third is the best moment in the corpus: it both
	 * locates the enemy jungler and makes the drake free, and the block at 18:02 carried all of it,
	 * one second old. The coach said PASS, having spent its sentence twice in the previous twelve
	 * seconds.
	 *
	 * One turn now, at 18:03, carrying all three asks — and the 67 seconds of quiet in front of it
	 * are the part that matters, because that is the sentence being available.
	 */
	it("asks once at 18:03 instead of three times in twelve seconds", t => {
		const turns = replay(GAMES.kayn)
		if (turns === null) return t.skip(`${GAMES.kayn} is not on this machine`)
		const cluster = turns.filter(x => x.atSec >= 1065 && x.atSec <= 1090)
		strictEqual(cluster.length, 1, cluster.map(x => `${Math.round(x.atSec)}s ${x.why}`).join(" | "))
		const merged = cluster[0]!
		ok(Math.abs(merged.atSec - 1083) <= 2, `${Math.round(merged.atSec)}s`)
		strictEqual(merged.kinds.length, 3, merged.why)
		const before = turns.filter(x => x.atSec < merged.atSec).at(-1)!
		ok(
			merged.atSec - before.atSec >= 60,
			`only ${Math.round(merged.atSec - before.atSec)}s of quiet before the best moment in the game`
		)
	})

	/*
	 * THE OPPOSITE FAILURE, and the bigger one. The drake spawned at 5:00 and stood untaken until
	 * roughly 7:20; the fingerprint moved not once in that time, so the detector's log for the whole
	 * stretch read "4:21, then 7:17" — two minutes fifty-six seconds of silence over a free drake,
	 * the largest missed counterfactual in the corpus.
	 */
	it("breaks the 4:21-7:17 silence with the drake that was standing in it", t => {
		const turns = replay(GAMES.kayn)
		if (turns === null) return t.skip(`${GAMES.kayn} is not on this machine`)
		const inHole = turns.filter(x => x.atSec > 262 && x.atSec < 435)
		strictEqual(inHole.length, 1, inHole.map(x => `${Math.round(x.atSec)}s ${x.why}`).join(" | "))
		deepStrictEqual(inHole[0]!.kinds, ["window.standing"])
		ok(inHole[0]!.why.includes("drake"), inHole[0]!.why)
		const base = replay(GAMES.kayn, { base: true })!
		strictEqual(
			base.filter(x => x.atSec > 262 && x.atSec < 435).length,
			0,
			"the schedule this replaces asked nothing in that stretch — if it did, the claim is stale"
		)
	})

	/*
	 * THE WHOLE TRADE, both games, against the schedule this replaces. Written as the exact turn
	 * clocks that differ rather than as a count, because a count hides a swap: two turns gained and
	 * two lost reads as no change.
	 */
	it("changes five turns in an hour of play and leaves every other one where it was", t => {
		const rows: Array<{ name: string; gained: number[]; lost: number[] }> = []
		for (const [name, file] of Object.entries(GAMES)) {
			const now = replay(file)
			const base = replay(file, { base: true })
			if (now === null || base === null) return t.skip(`${file} is not on this machine`)
			const at = (xs: typeof now): number[] => xs.map(x => Math.round(x.atSec))
			const a = at(base)
			const b = at(now)
			rows.push({
				name,
				gained: b.filter(x => !a.includes(x)),
				lost: a.filter(x => !b.includes(x))
			})
		}
		deepStrictEqual(rows, [
			/*
			 * Kayn: two standing-opportunity asks into the two real lulls (5:52 over the free drake,
			 * 10:14 over grubs that had stood 134s), and the 17:51/17:57 pair absorbed into 18:03.
			 */
			{ name: "kayn", gained: [352, 614], lost: [1071, 1077] },
			/*
			 * Fiddlesticks: one standing ask at 5:47 over the same drake shape and one at 21:07 over
			 * a Baron that had been up 67s, and the 10:21 heartbeat — worth 8, asked about nothing —
			 * yielding to the drake window that opened six seconds later.
			 */
			{ name: "fiddle", gained: [347, 1267], lost: [621] }
		])
	})

	/*
	 * VOLUME, which is the thing a scheduler is most likely to quietly lose. The cut is meant to
	 * spend the same attention better, not to spend more of it.
	 */
	it("does not buy the fix with more questions", t => {
		for (const file of Object.values(GAMES)) {
			const now = replay(file)
			const base = replay(file, { base: true })
			if (now === null || base === null) return t.skip(`${file} is not on this machine`)
			ok(
				now.length <= base.length + 2,
				`${file}: ${base.length} -> ${now.length} turns`
			)
		}
	})
})

describe("two games, one session", () => {
	/*
	 * One recorded journal session held 715 frames across TWO games and the second restarted the
	 * clock at tSec 2. Carrying the first game's fired keys into the second would swallow its first
	 * objective — the same class of bug as a socket spanning two games.
	 */
	it("a backwards clock resets everything", () => {
		const watch = newEventWatch()
		observeTick(watch, tickOf({ t: 260 }))
		observeTick(watch, tickOf({ t: 270, events: [kill(1, 265, ME_BARE)], dead: true }))
		ok(watch.fired.size > 0)
		const fresh = observeTick(watch, tickOf({ t: 2 }))
		strictEqual(watch.pending.length, 0)
		deepStrictEqual(fresh.map(e => e.kind), ["game.start"])
		strictEqual(watch.lastDeathNote, null, "game one's death must not follow him into game two")
		const again = observeTick(watch, tickOf({ t: 270 }))
		ok(again.some(e => e.kind === "window.open"), "game two's first window must still fire")
	})
})
