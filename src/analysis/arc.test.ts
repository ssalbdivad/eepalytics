/**
 * Tests for `analysis/arc.ts`.
 *
 * ## The corpus lives in `data/`, which is gitignored — so the evidence is INLINE
 *
 * Every fixture below is a condensed reconstruction of something that actually happened in
 * `data/live-samples/split-01..04.ndjson`, with the clocks and figures copied from the recording
 * and the roster trimmed to the players the assertion is about. Copying them in is not padding: a
 * test that reads a file nobody else can clone proves nothing after the file rots, and the two
 * cases that decide the stall veto (`split-03` at 08:50 and `split-02` at 30:41) are the whole
 * argument for the gate's shape.
 *
 * The names are the real ones on purpose. The event feed sends BARE game names ("Gooskaffur")
 * while the roster carries the tagged `riotId` ("Gooskaffur#NA1"), and a one-sided join resolved
 * 0 of 37 events the last time this app got it wrong — so the fixtures keep both fields disagreeing
 * exactly as the client sends them.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { LiveAllGameData, LiveEvent, LivePlayer } from "../shared/schema/live.ts"
import {
	ARC_WINDOW_SEC,
	RACE_MOVE_CERTAIN,
	arcLines,
	buildArc,
	csGainBand,
	renderArc
} from "./arc.ts"
import type { ArcSample } from "./arc.ts"

/* ------------------------------------------------------------------ fixtures */

const ME = "Gooskaffur"

interface Spec {
	name: string
	champion: string
	team: string
	position?: string
	cs?: number
	level?: number
	dead?: boolean
	smite?: boolean
}

const player = (s: Spec): LivePlayer => ({
	/** Tagged here and BARE in the event feed, exactly as the client sends them. */
	riotId: `${s.name}#NA1`,
	riotIdGameName: s.name,
	summonerName: `${s.name}#NA1`,
	championName: s.champion,
	team: s.team,
	position: s.position ?? "",
	level: s.level ?? 1,
	isDead: s.dead ?? false,
	scores: { kills: 0, deaths: 0, assists: 0, creepScore: s.cs ?? 0, wardScore: 0 },
	...(s.smite ?
		{
			summonerSpells: {
				summonerSpellOne: { displayName: "Primal Smite", rawDisplayName: "SummonerSmiteAvatarOffensive" },
				summonerSpellTwo: { displayName: "Flash", rawDisplayName: "SummonerFlash" }
			}
		}
	:	{})
})

let nextEventId = 1
const ev = (name: string, atSec: number, extra: Partial<LiveEvent> = {}): LiveEvent => ({
	EventID: nextEventId++,
	EventName: name,
	EventTime: atSec,
	...extra
})

/** One poll. `gold` is the active player's purse; `events` is the CUMULATIVE feed, as the client sends it. */
const sample = (
	atSec: number,
	specs: Spec[],
	opts: { gold?: number; events?: LiveEvent[] } = {}
): ArcSample => ({
	atSec,
	data: {
		gameData: { gameTime: atSec },
		activePlayer: {
			riotId: `${ME}#NA1`,
			riotIdGameName: ME,
			summonerName: `${ME}#NA1`,
			...(opts.gold === undefined ? {} : { currentGold: opts.gold })
		},
		allPlayers: specs.map(player),
		events: { Events: opts.events ?? [] }
	} satisfies LiveAllGameData
})

/** Him and his counterpart and nobody else — enough for every CS assertion. */
const duel = (atSec: number, myCs: number, cpCs: number, opts: { gold?: number; events?: LiveEvent[]; myLevel?: number; cpLevel?: number } = {}): ArcSample =>
	sample(
		atSec,
		[
			{ name: ME, champion: "Lillia", team: "ORDER", position: "JUNGLE", cs: myCs, level: opts.myLevel ?? 6 },
			{ name: "chogiwa", champion: "Briar", team: "CHAOS", position: "JUNGLE", cs: cpCs, level: opts.cpLevel ?? 6 }
		],
		opts
	)

/** A flat CS series: one poll every 6s, exactly as the daemon records. */
const series = (
	from: number,
	to: number,
	cs: (t: number) => number,
	cp: (t: number) => number,
	opts: { gold?: (t: number) => number; events?: LiveEvent[] } = {}
): ArcSample[] => {
	const out: ArcSample[] = []
	for (let t = from; t <= to; t += 6)
		out.push(duel(t, cs(t), cp(t), { ...(opts.gold ? { gold: opts.gold(t) } : {}), ...(opts.events ? { events: opts.events } : {}) }))
	return out
}

/* ------------------------------------------------------------------- the bands */

describe("the CS quantum decides what a difference supports", () => {
	it("bounds a gain at ±9 and never lets the floor read as exact", () => {
		assert.deepEqual(csGainBand(40, 60), { atLeast: 11, atMost: 29 })
	})

	it("clamps at zero, because a reported +10 supports 'at least one'", () => {
		assert.deepEqual(csGainBand(40, 50), { atLeast: 1, atMost: 19 })
		assert.deepEqual(csGainBand(40, 40), { atLeast: 0, atMost: 9 })
	})

	it("needs a whole quantum ON TOP of the rounding before a race move is worth a word", () => {
		/*
		 * 28, so in practice a reported move of 30. At 19 — merely clearing the rounding — the
		 * sentence produced was "you have pulled at least 2 CS further ahead of Karthus", which is
		 * the quantisation nag the owner quit over wearing a new subject.
		 */
		assert.equal(RACE_MOVE_CERTAIN, 28)
	})
})

/* -------------------------------------------------------------------- the shape */

describe("buildArc refuses rather than guesses", () => {
	it("returns null with no samples, and null when the active player is not on the roster", () => {
		assert.equal(buildArc([]), null)
		const orphan = sample(60, [{ name: "someone-else", champion: "Briar", team: "CHAOS" }])
		assert.equal(buildArc([orphan]), null)
	})

	it("reports no rate at all from a buffer shorter than a window", () => {
		const arc = buildArc(series(0, 30, () => 20, () => 10))
		assert.ok(arc)
		assert.equal(arc.farm, null, "30 seconds is not a derivative")
		assert.equal(arc.race, null)
	})

	it("finds the enemy jungler by Smite when nobody declared a position", () => {
		const s = sample(120, [
			{ name: ME, champion: "Lillia", team: "ORDER", smite: true },
			{ name: "chogiwa", champion: "Briar", team: "CHAOS", smite: true },
			{ name: "zx6r", champion: "Jhin", team: "CHAOS" }
		])
		assert.equal(buildArc([s])?.counterpart, "Briar")
	})
})

/* --------------------------------------------------------------------- the farm */

describe("the farm rate is an interval, never a subtraction", () => {
	it("bounds both junglers' gain over the window that was actually covered", () => {
		const arc = buildArc(series(0, 180, t => (t < 90 ? 40 : 70), t => (t < 120 ? 10 : 20)))
		assert.ok(arc?.farm)
		assert.equal(arc.farm.windowSec, ARC_WINDOW_SEC)
		// reported 40 -> 70 over the window: at least 21, at most 39.
		assert.deepEqual(arc.farm.mine, { atLeast: 21, atMost: 39 })
		assert.deepEqual(arc.farm.counterpart, { atLeast: 1, atMost: 19 })
	})
})

/* -------------------------------------------------------------------- the stall */

describe("a stall is the one CS fact that is EXACT", () => {
	/*
	 * `split-03`, the shipped coach's worst stretch: his reported CS sat at 60 from 08:50 to 14:01
	 * while it said "keep the route running" thirty times. Two kills and two deaths inside it.
	 */
	const stallRuns = (): ArcSample[] => {
		const out: ArcSample[] = []
		// four completed runs of about 100s each, then the flat stretch
		const steps = [
			{ from: 0, to: 100, cs: 20 },
			{ from: 106, to: 200, cs: 30 },
			{ from: 206, to: 300, cs: 40 },
			{ from: 306, to: 400, cs: 50 }
		]
		for (const s of steps) for (let t = s.from; t <= s.to; t += 6) out.push(duel(t, s.cs, 10))
		for (let t = 406; t <= 700; t += 6) out.push(duel(t, 60, 10))
		return out
	}

	it("names the clock the figure last moved and caps the gain at nine", () => {
		const arc = buildArc(stallRuns())
		assert.ok(arc?.stall)
		assert.equal(arc.stall.cs, 60)
		assert.equal(arc.stall.sinceSec, 406)
		assert.equal(arc.stall.atMostGained, 9)
		assert.ok(arc.stall.forSec >= 290)
		assert.ok(arc.stall.ratio >= 2)
	})

	it("says nothing about a flat run that is merely the quantum", () => {
		/*
		 * At six CS a minute a reported figure only moves every hundred seconds, so a fixed
		 * ">= 90 seconds" rule fires 4, 10, 12 and 10 times across the four recorded games. Judged
		 * against his own median run, a 100-second flat stretch is not a stall at all.
		 */
		const out: ArcSample[] = []
		for (let i = 0; i < 6; i++) for (let t = i * 106; t <= i * 106 + 100; t += 6) out.push(duel(t, 20 + i * 10, 10))
		assert.equal(buildArc(out)?.stall, null)
	})

	it("is VETOED when he stopped farming to take an objective", () => {
		/*
		 * `split-02` at 30:41, and the reason the veto exists. Four kills and two objectives inside a
		 * flat stretch is not a stopped route, it is a jungler doing his job — a stall line there is
		 * wrong coaching, not a hard truth.
		 */
		const events = [
			ev("ChampionKill", 420, { KillerName: ME, VictimName: "chogiwa" }),
			ev("ChampionKill", 440, { KillerName: ME, VictimName: "chogiwa" }),
			ev("DragonKill", 500, { KillerName: ME, DragonType: "Water" })
		]
		const base = buildArc(stallRuns())
		assert.ok(base?.stall && !base.stall.explained)
		const withEvents = buildArc(stallRuns().map(s => ({ ...s, data: { ...s.data, events: { Events: events } } })))
		assert.ok(withEvents?.stall)
		assert.equal(withEvents.stall.during.objectives, 1)
		assert.equal(withEvents.stall.explained, true)
		assert.equal(arcLines(withEvents).some(l => l.kind === "stall"), false)
	})

	it("is NOT vetoed by kills he paid for with deaths", () => {
		/*
		 * The first version of this gate was "an objective OR two kills", and it swallowed the
		 * loudest stall in the corpus: `split-03` 08:50–14:01, two kills and THREE deaths, five
		 * minutes without farming. Kills only excuse a stopped route when they were not paid for.
		 */
		const events = [
			ev("ChampionKill", 420, { KillerName: ME, VictimName: "chogiwa" }),
			ev("ChampionKill", 460, { KillerName: ME, VictimName: "chogiwa" }),
			ev("ChampionKill", 500, { KillerName: "chogiwa", VictimName: ME }),
			ev("ChampionKill", 560, { KillerName: "chogiwa", VictimName: ME })
		]
		const arc = buildArc(stallRuns().map(s => ({ ...s, data: { ...s.data, events: { Events: events } } })))
		assert.ok(arc?.stall)
		assert.deepEqual(arc.stall.during, { kills: 2, deaths: 2, objectives: 0 })
		assert.equal(arc.stall.explained, false)
		assert.ok(arcLines(arc).some(l => l.kind === "stall"))
	})
})

/* --------------------------------------------------------------------- the race */

describe("the race is reported as a move, in the direction he is living in", () => {
	it("stays silent on a reported move of twenty, which survives the rounding by two", () => {
		const arc = buildArc(series(0, 180, t => (t < 90 ? 40 : 60), () => 10))
		assert.equal(arc?.race?.moved, null)
	})

	it("calls a thirty-CS move opening, with only the part that survives the rounding", () => {
		const arc = buildArc(series(0, 180, t => (t < 90 ? 40 : 70), () => 10))
		assert.equal(arc?.race?.moved, "opening")
		assert.equal(arc?.race?.byAtLeast, 12)
		assert.ok(arcLines(arc!).some(l => l.text.includes("at least 12 CS further ahead of Briar")))
	})

	it("calls it closing when the counterpart is the one gaining", () => {
		/*
		 * Tested synthetically because THE CORPUS NEVER PRODUCES IT: across all four recorded games
		 * the certain race gap moved 54 times and every single one was in his favour. He wins this
		 * race about 2:1 in every game on record, which is exactly why a coach built on it can only
		 * ever congratulate him.
		 */
		const arc = buildArc(series(0, 180, () => 60, t => (t < 90 ? 10 : 40)))
		assert.equal(arc?.race?.moved, "closing")
		assert.ok(arcLines(arc!).some(l => l.text.includes("Briar has taken at least 12 CS out of the gap")))
	})
})

/* --------------------------------------------------------------------- the gold */

describe("gold is reported as a duration, because the figure is already on his screen", () => {
	it("dates the last spend and treats any net drop as proof he stood in a shop", () => {
		const rows = series(0, 300, () => 40, () => 10, { gold: t => (t < 120 ? 1400 : t < 180 ? 250 : 1800) })
		const arc = buildArc(rows)
		assert.ok(arc?.gold)
		assert.equal(arc.gold.sinceSpendSec, 180)
		/*
		 * A LOWER bound, always. He earns while he shops, so an observed drop of 1150 was a purchase
		 * of a little more — the recurring 63 in the corpus is a 75g control ward with six seconds of
		 * income netted off.
		 */
		assert.equal(arc.gold.lastSpendAtLeast, 1150)
		assert.equal(arc.gold.peakSinceSpend, 1800)
	})

	it("reports no spend at all rather than inventing one when gold only ever rose", () => {
		const arc = buildArc(series(0, 300, () => 40, () => 10, { gold: t => 100 + t }))
		assert.equal(arc?.gold?.sinceSpendSec, null)
		assert.equal(arc?.gold?.lastSpendAtLeast, null)
	})
})

/* ------------------------------------------------------------------- the levels */

describe("levels are exact, so the gap and its move are exact", () => {
	it("moves the gap and counts the levels short of an ultimate", () => {
		const rows = [
			...series(0, 60, () => 40, () => 10),
			...series(66, 180, () => 40, () => 10)
		].map((s, i) => (i < 11 ? s : s))
		const arc = buildArc(rows)
		assert.ok(arc)
		assert.equal(arc.levels.gap, 0)
		assert.equal(arc.levels.toUlt, null, "level 6 has the ultimate")
	})

	it("counts a level-up and dates it", () => {
		const rows = [
			...Array.from({ length: 20 }, (_, i) => duel(i * 6, 40, 10, { myLevel: 4, cpLevel: 4 })),
			...Array.from({ length: 20 }, (_, i) => duel(120 + i * 6, 40, 10, { myLevel: 6, cpLevel: 4 }))
		]
		const arc = buildArc(rows)
		assert.equal(arc?.levels.gap, 2)
		assert.equal(arc?.levels.gapDelta, 2)
		assert.equal(arc?.levels.sinceLevelSec, 114)
		assert.ok(arcLines(arc!).some(l => l.kind === "level-move"))
	})

	it("says nothing about a one-level move, which is churn", () => {
		const rows = [
			...Array.from({ length: 20 }, (_, i) => duel(i * 6, 40, 10, { myLevel: 4, cpLevel: 4 })),
			...Array.from({ length: 20 }, (_, i) => duel(120 + i * 6, 40, 10, { myLevel: 5, cpLevel: 4 }))
		]
		assert.equal(arcLines(buildArc(rows)!).some(l => l.kind === "level-move"), false)
	})
})

/* --------------------------------------------------------------- the objectives */

describe("the objective ledger, which VisionState has no counter of any kind for", () => {
	const drakes = [
		ev("DragonKill", 364, { KillerName: "chogiwa", DragonType: "Hextech" }),
		ev("DragonKill", 841, { KillerName: "chogiwa", DragonType: "Air" }),
		ev("DragonKill", 1169, { KillerName: "chogiwa", DragonType: "Water" })
	]

	it("counts both sides, spots soul point and names the run", () => {
		/** `split-03`: their third drake lands at 19:29 and nothing this app could say knew it. */
		const arc = buildArc([duel(1180, 110, 60, { events: drakes })])
		assert.ok(arc)
		assert.equal(arc.objectives.dragonsTheirs, 3)
		assert.equal(arc.objectives.dragonsMine, 0)
		assert.equal(arc.objectives.soulFor, "theirs")
		assert.deepEqual(arc.objectives.dragonRun, { count: 3, mine: false })
		const lines = arcLines(arc)
		assert.ok(lines.some(l => l.text === "They are one drake from soul."))
		assert.ok(lines.some(l => l.text === "The last 3 drakes have all gone to them."))
	})

	it("counts a respawn only from a take it SAW, never from the clock", () => {
		const none = buildArc([duel(600, 60, 30)])
		assert.equal(none?.objectives.drakeBackInSec, null)
		assert.equal(none?.objectives.baronBackInSec, null)
		const seen = buildArc([duel(1180, 110, 60, { events: drakes })])
		assert.equal(seen?.objectives.drakeBackInSec, 1169 + 300 - 1180)
	})

	it("counts the drought against THEM rather than against the clock", () => {
		/*
		 * The first version was "no objective in six minutes" and it fired at 06:05 in three of four
		 * games — seconds after the first objectives of a game exist at all. A drought is only a fact
		 * when somebody else is drinking.
		 */
		/** The herald lands between their first and second drake, so only the two after it count. */
		const mineFirst = [drakes[0]!, ev("HeraldKill", 500, { KillerName: ME }), drakes[1]!, drakes[2]!]
		const arc = buildArc([duel(1180, 110, 60, { events: mineFirst })])
		assert.equal(arc?.objectives.theirsSinceMine, 2)
		assert.ok(
			arcLines(arc!).some(l => l.text === "They have taken 2 major objectives since your last one at 8:20.")
		)
		const quiet = buildArc([duel(600, 60, 30, { events: [ev("HeraldKill", 500, { KillerName: ME })] })])
		assert.equal(arcLines(quiet!).some(l => l.kind === "objective-drought"), false)
	})
})

/* ----------------------------------------------------------------- the kill map */

describe("who has been killing whom — the ledger the score line cannot hold", () => {
	/** `split-03`: the block sees 0/5/4 and cannot know that four of them are the same champion. */
	const feed = [
		ev("ChampionKill", 400, { KillerName: "chogiwa", VictimName: ME }),
		ev("ChampionKill", 500, { KillerName: "chogiwa", VictimName: ME }),
		ev("ChampionKill", 600, { KillerName: "chogiwa", VictimName: "qhqy" }),
		ev("ChampionKill", 700, { KillerName: "zx6r", VictimName: ME }),
		ev("ChampionKill", 800, { KillerName: ME, VictimName: "chogiwa", Assisters: ["qhqy"] })
	]
	const roster: Spec[] = [
		{ name: ME, champion: "Lillia", team: "ORDER", position: "JUNGLE", cs: 110 },
		{ name: "qhqy", champion: "Urgot", team: "ORDER", position: "TOP", cs: 130 },
		{ name: "chogiwa", champion: "Briar", team: "CHAOS", position: "JUNGLE", cs: 60 },
		{ name: "zx6r", champion: "Jhin", team: "CHAOS", position: "BOTTOM", cs: 150 }
	]

	it("joins the BARE event name to the tagged roster row", () => {
		/** 0 of 37 resolved when this app matched only `riotId`. The two feeds disagree by design. */
		const arc = buildArc([sample(900, roster, { events: feed })])
		assert.deepEqual(arc?.killMap.onMe, [
			{ champion: "Briar", count: 2 },
			{ champion: "Jhin", count: 1 }
		])
		assert.deepEqual(arc?.killMap.myVictims, [{ champion: "Briar", count: 1 }])
	})

	it("keeps the per-teammate breakdown as DATA and never as a line", () => {
		/** AGENTS.md hard rule 7: a teammate is a real person he cannot control. */
		const arc = buildArc([sample(900, roster, { events: feed })])
		const briar = arc?.killMap.byEnemy.find(e => e.champion === "Briar")
		assert.equal(briar?.total, 3)
		assert.deepEqual(briar?.victims, [
			{ champion: "Lillia", count: 2 },
			{ champion: "Urgot", count: 1 }
		])
		assert.equal(
			arcLines(arc!).some(l => l.text.includes("Urgot")),
			false,
			"a teammate's name never reaches a spoken line"
		)
	})

	it("names a nemesis at three and not at two", () => {
		const two = buildArc([sample(900, roster, { events: feed })])
		assert.equal(arcLines(two!).some(l => l.kind === "nemesis"), false)
		const three = buildArc([
			sample(900, roster, { events: [...feed, ev("ChampionKill", 850, { KillerName: "chogiwa", VictimName: ME })] })
		])
		assert.ok(arcLines(three!).some(l => l.text === "Briar has killed you 3 times."))
	})
})

/* ------------------------------------------------------------------ the recency */

describe("recency — how long ago is a different fact from what happened", () => {
	it("dates his last death, his last participation and the last kill of any kind", () => {
		const feed = [
			ev("ChampionKill", 400, { KillerName: "chogiwa", VictimName: ME }),
			ev("ChampionKill", 600, { KillerName: "qhqy", VictimName: "zx6r", Assisters: [ME] }),
			ev("ChampionKill", 800, { KillerName: "zx6r", VictimName: "qhqy" })
		]
		const arc = buildArc([
			sample(900, [
				{ name: ME, champion: "Lillia", team: "ORDER", position: "JUNGLE" },
				{ name: "qhqy", champion: "Urgot", team: "ORDER" },
				{ name: "chogiwa", champion: "Briar", team: "CHAOS", position: "JUNGLE" },
				{ name: "zx6r", champion: "Jhin", team: "CHAOS" }
			], { events: feed })
		])
		assert.equal(arc?.since.myDeathSec, 500)
		assert.equal(arc?.since.myKillParticipationSec, 300, "an assist counts as being there")
		assert.equal(arc?.since.anyKillSec, 100)
		assert.equal(arc?.since.myObjectiveSec, null)
	})

	it("counts the kills his team took while he was somewhere else", () => {
		const feed = [
			ev("ChampionKill", 820, { KillerName: "qhqy", VictimName: "zx6r" }),
			ev("ChampionKill", 840, { KillerName: "qhqy", VictimName: "chogiwa" }),
			ev("ChampionKill", 860, { KillerName: "qhqy", VictimName: "zx6r" })
		]
		const arc = buildArc([
			sample(900, [
				{ name: ME, champion: "Lillia", team: "ORDER", position: "JUNGLE" },
				{ name: "qhqy", champion: "Urgot", team: "ORDER" },
				{ name: "chogiwa", champion: "Briar", team: "CHAOS", position: "JUNGLE" },
				{ name: "zx6r", champion: "Jhin", team: "CHAOS" }
			], { events: feed })
		])
		assert.equal(arc?.fights.killsWithoutMe, 3)
		assert.ok(arcLines(arc!).some(l => l.kind === "absent"))
	})

	it("names a run of deaths with the clock the run started at", () => {
		const feed = [
			ev("ChampionKill", 550, { KillerName: "chogiwa", VictimName: ME }),
			ev("ChampionKill", 610, { KillerName: "zx6r", VictimName: ME })
		]
		const arc = buildArc([
			sample(640, [
				{ name: ME, champion: "Lillia", team: "ORDER", position: "JUNGLE" },
				{ name: "chogiwa", champion: "Briar", team: "CHAOS", position: "JUNGLE" },
				{ name: "zx6r", champion: "Jhin", team: "CHAOS" }
			], { events: feed })
		])
		assert.equal(arc?.fights.myDeaths, 2)
		assert.ok(arcLines(arc!).some(l => l.text === "You have died 2 times since 9:10."))
	})
})

/* ------------------------------------------------------------------- rendering */

describe("rendering", () => {
	it("renders nothing at all rather than a heading with no facts under it", () => {
		const arc = buildArc([duel(60, 20, 10)])
		assert.ok(arc)
		assert.deepEqual(arcLines(arc), [])
		assert.equal(renderArc(arc), "")
	})

	it("puts the arc under its own heading, separate from the snapshot", () => {
		const arc = buildArc([duel(1180, 110, 60, { events: [ev("DragonKill", 1169, { KillerName: "chogiwa" })] })])
		const drakes = buildArc([
			duel(1180, 110, 60, {
				events: [
					ev("DragonKill", 364, { KillerName: "chogiwa" }),
					ev("DragonKill", 841, { KillerName: "chogiwa" }),
					ev("DragonKill", 1169, { KillerName: "chogiwa" })
				]
			})
		])
		assert.equal(renderArc(arc!), "")
		assert.ok(renderArc(drakes!).startsWith("### The arc"))
		assert.ok(renderArc(drakes!).includes("- They are one drake from soul."))
	})
})
