/**
 * Two kinds of case, and the split is deliberate.
 *
 * The SHAPE cases read the committed pair in `src/shared/__fixtures__/live-brief-sample.ndjson` —
 * real recorded `allgamedata` from game 5635467422, Lillia vs Briar — because the failure this
 * module is most likely to have is a field that is not where it was thought to be, and that is
 * exactly the failure a hand-written fixture reproduces perfectly and wrongly.
 *
 * The ARITHMETIC cases build their own samples, because the questions they ask ("what does the
 * ledger say when his gold does not move for sixty seconds?") need a state the recording does not
 * happen to contain. Those samples carry only the handful of scalars this module reads. They are
 * obviously synthetic and none of them is a coaching claim about a real game.
 *
 * The long replay against `data/live-samples/split-03.ndjson` is skipped when the file is absent,
 * because `data/` is not committed.
 */

import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { test } from "node:test"
import {
	BACK_GOLD_DROP,
	CAMPS_SPAWN_SEC,
	cpSeenAt,
	deathsSeen,
	QUANTUM_HIDES_SEC,
	RECENT_KEEP,
	WINDOW_SEC,
	actionOf,
	newMemory,
	noteSaid,
	observe,
	renderNarrative,
	renderGameSoFar,
	renderCounterpart,
	renderSaid
} from "./coach-memory.ts"
import type { ActionKind, MemoryState } from "./coach-memory.ts"

/* ================================================================ the real pair */

const samples = readFileSync(new URL("../shared/__fixtures__/live-brief-sample.ndjson", import.meta.url), "utf8")
	.trim()
	.split("\n")
	.map(l => JSON.parse(l) as { gameTime: number; data: unknown })

const real = (): MemoryState => {
	const s = newMemory()
	for (const x of samples) observe(s, x, x.gameTime)
	return s
}

test("reads the player and his counterpart off a real recorded sample", () => {
	const s = real()
	assert.equal(s.me, "Lillia")
	assert.equal(s.counterpart, "Briar")
	const last = s.recent.at(-1)!
	assert.equal(last.cs, 40)
	assert.equal(last.level, 5)
	assert.equal(last.cpCs, 0)
	assert.equal(last.cpLevel, 4)
	assert.deepEqual([...last.cpKda!], [1, 1, 0])
})

test("the real pair's six ChampionKills become six beats, and FirstBlood is not a seventh", () => {
	const s = real()
	const kills = s.beats.filter(b => b.kind === "kill" || b.kind === "my-kill" || b.kind === "my-death" || b.kind === "cp-kill" || b.kind === "cp-death")
	assert.equal(kills.length, 6, "the recording's event array holds six ChampionKill events")
	assert.ok(s.beats.every(b => !/first blood/i.test(b.text)))
})

test("Briar's two new items are SIGHTINGS, because her row only refreshes when she is visible", () => {
	/*
	 * The clock on a counterpart beat is when the app SAW the change, never when it happened —
	 * her row freezes out of vision. Stepping the real file, `Briar finished Vampiric Scepter`
	 * was stamped 5:59 for a purchase minutes older. The fact is worth keeping; the false
	 * precision is not, so the wording carries the difference.
	 */
	const s = real()
	const buys = s.beats.filter(b => b.kind === "cp-buy").map(b => b.text)
	assert.deepEqual(buys, ["Briar was seen holding Vampiric Scepter", "Briar was seen holding Dagger"])
})

test("a consumable is never a buy beat", () => {
	const s = real()
	assert.ok(s.beats.every(b => !/Stealth Ward/.test(b.text)))
})

/* ================================================================ synthetic samples */

interface Bits {
	cs?: number
	level?: number
	gold?: number
	hp?: number
	maxHp?: number
	mana?: number
	maxMana?: number
	k?: number
	d?: number
	a?: number
	dead?: boolean
	ward?: number
	items?: string[]
	cpCs?: number
	cpLevel?: number
	cpItems?: string[]
	cpDead?: boolean
	cpRespawn?: number
	events?: Record<string, unknown>[]
}

/** Only the scalars `coach-memory` reads. Everything absent keeps its previous-turn default. */
const sample = (b: Bits) => ({
	activePlayer: {
		riotIdGameName: "Player",
		currentGold: b.gold ?? 0,
		championStats: {
			currentHealth: b.hp ?? 1000,
			maxHealth: b.maxHp ?? 1000,
			resourceValue: b.mana ?? 500,
			resourceMax: b.maxMana ?? 500
		}
	},
	allPlayers: [
		{
			riotIdGameName: "Player",
			championName: "Lillia",
			team: "ORDER",
			position: "JUNGLE",
			level: b.level ?? 1,
			isDead: b.dead === true,
			respawnTimer: b.dead === true ? 12 : 0,
			scores: { kills: b.k ?? 0, deaths: b.d ?? 0, assists: b.a ?? 0, creepScore: b.cs ?? 0, wardScore: b.ward ?? 0 },
			items: (b.items ?? []).map(displayName => ({ displayName })),
			summonerSpells: { summonerSpellOne: { displayName: "Smite" }, summonerSpellTwo: { displayName: "Flash" } }
		},
		{
			riotIdGameName: "Enemy",
			championName: "Briar",
			team: "CHAOS",
			position: "JUNGLE",
			level: b.cpLevel ?? 1,
			isDead: b.cpDead === true,
			respawnTimer: b.cpDead === true ? (b.cpRespawn ?? 12) : 0,
			scores: { kills: 0, deaths: 0, assists: 0, creepScore: b.cpCs ?? 0, wardScore: 0 },
			items: (b.cpItems ?? []).map(displayName => ({ displayName })),
			summonerSpells: { summonerSpellOne: { displayName: "Smite" }, summonerSpellTwo: { displayName: "Flash" } }
		}
	],
	events: { Events: b.events ?? [] }
})

/** Feed a sample every five seconds from `from` to `to`, holding `bits` constant. */
const hold = (s: MemoryState, from: number, to: number, bits: Bits): MemoryState => {
	for (let t = from; t <= to; t += 5) observe(s, sample(bits), t)
	return s
}

/* ================================================================ the narrative */

test("beats survive the event leaving the client's own event array", () => {
	const s = newMemory()
	const kill = { EventID: 4, EventName: "ChampionKill", EventTime: 100, KillerName: "Enemy", VictimName: "Player" }
	observe(s, sample({ events: [kill] }), 100)
	assert.equal(s.beats.filter(b => b.kind === "my-death").length, 1)

	/* The client's array is a rolling window; the brief re-reads it every turn and so forgets. */
	hold(s, 105, 400, { events: [] })
	assert.equal(s.beats.filter(b => b.kind === "my-death").length, 1, "the death is still remembered")
	assert.match(renderNarrative(s, 400), /1:40 Briar killed you/)
})

test("an event that comes back in the array is not a second beat", () => {
	const s = newMemory()
	const kill = { EventID: 4, EventName: "ChampionKill", EventTime: 100, KillerName: "Player", VictimName: "Enemy" }
	observe(s, sample({ events: [kill] }), 100)
	observe(s, sample({ events: [kill] }), 105)
	observe(s, sample({ events: [kill] }), 110)
	assert.equal(s.beats.filter(b => b.kind === "my-kill").length, 1)
})

test("a repeated or out-of-order sample changes nothing", () => {
	const s = newMemory()
	observe(s, sample({ gold: 500 }), 100)
	const beats = s.beats.length
	const recent = s.recent.length
	observe(s, sample({ gold: 500 }), 100)
	observe(s, sample({ gold: 500 }), 60)
	assert.equal(s.beats.length, beats)
	assert.equal(s.recent.length, recent)
})

test("the snapshot ring is bounded, and the narrative with it", () => {
	const s = newMemory()
	hold(s, 0, 5 * (RECENT_KEEP + 40), { cs: 10 })
	assert.equal(s.recent.length, RECENT_KEEP)
})

test("a level-2 beat has aged out of the narrative by 20:00 and a death has not", () => {
	const s = newMemory()
	observe(s, sample({ level: 1 }), 60)
	observe(s, sample({ level: 2 }), 65)
	observe(s, sample({ level: 2, events: [{ EventID: 9, EventName: "ChampionKill", EventTime: 70, KillerName: "Enemy", VictimName: "Player" }] }), 70)
	assert.match(renderNarrative(s, 80), /you hit level 2/)
	const late = renderNarrative(s, 1200)
	assert.doesNotMatch(late, /you hit level 2/)
	assert.match(late, /Briar killed you/)
})

test("the race is LEVEL against level, and the two figures are printed as a pair", () => {
	const s = newMemory()
	observe(s, sample({ cs: 40, cpCs: 20, level: 4, cpLevel: 3 }), 60)
	observe(s, sample({ cs: 60, cpCs: 20, level: 6, cpLevel: 6 }), 121)
	const text = renderNarrative(s, 121)
	assert.match(text, /LEVEL race/)
	assert.match(text, /1:00 4-3 -> 2:01 6-6/)
})

/**
 * The regression this whole revision exists to prevent, pinned as a string.
 *
 * The counterpart's reported 20 against his reported 40 used to render `you at least +11`, an
 * interval carefully widened for the client's flooring — over a figure that is not his farm at all.
 * Audited on game 5639406342 the same line said `+95` about a man level on CS. No section of this
 * module may put his farm figure and the player's in one sentence again.
 */
test("no farm comparison against the counterpart survives anywhere in the render", () => {
	const s = newMemory()
	observe(s, sample({ cs: 40, cpCs: 20, level: 4, cpLevel: 3 }), 60)
	observe(s, sample({ cs: 120, cpCs: 20, level: 9, cpLevel: 9 }), 300)
	const text = `${renderNarrative(s, 300)}\n${renderCounterpart(s, 300)}`
	assert.doesNotMatch(text, /at least \+\d/)
	assert.doesNotMatch(text, /\bCS race\b(?! here)/)
	/* His own farm is still his own farm, floored, and is still said. */
	assert.match(text, /at least 120 CS/)
	/* The counterpart's is not a number anywhere. */
	assert.doesNotMatch(text, /20 farm/)
})

/* ================================================================ the utterance log */

test("the log records the topic and the advised action", () => {
	const s = newMemory()
	observe(s, sample({}), 0)
	noteSaid(s, "Back now, you're low and need that Fated Ashes power spike for your clear.", 213, 0.8)
	noteSaid(s, "Keep running that clear and do not even think about dueling Briar at the crab.", 139, 0.8)
	noteSaid(s, "They got the drake, so now you can focus on clearing your camps or going for the Voidgrubs.", 365, 0.8)
	assert.deepEqual(
		s.said.map(u => [u.topic, u.action.kind, u.action.target]),
		[
			["farm", "back", null],
			/*
			 * `farm`, not `disengage`. The imperative is "Keep running that clear"; the duel
			 * clause is a caveat trailing it, and classifying by it told the model the coach had
			 * advised a disengage it never advised. `actionOf` now takes the EARLIEST match in the
			 * sentence rather than the highest-priority pattern anywhere in it.
			 */
			["farm", "farm", null],
			["objectives", "farm", "camps"]
		]
	)
})

test("the advice is the opening clause, and a trailing caveat never overrides it", () => {
	const s = newMemory()
	noteSaid(s, "Keep kiting that camp towards blue and finish your clear. Your mana's getting low, so head back after this.", 300, 0.8)
	assert.equal(s.said[0]!.action.kind, "farm", "a `head back` coda is not a recall instruction")
})

test("the real transcripts parse: no more than a quarter of the coach's own lines are unreadable", () => {
	/*
	 * MEASURED, and re-measured whenever the patterns change. Over the 43 real non-mock spoken
	 * lines in the three stored runs the old parser returned `none` on 21 of them (49%) and each
	 * one rendered as `UNKNOWN — no action was advised` beneath a quoted imperative. These are a
	 * representative handful, kept as fixtures so the parser is tested against what the trusted
	 * coach actually says rather than against the old ranker's templates.
	 */
	const REAL: Array<[string, ActionKind]> = [
		["Buy your jungle item and head blue side — you want that buff more than most.", "buy"],
		["Kite the Blue towards Gromp now that his health is down.", "farm"],
		["Keep clearing towards red, Briar is still level one and likely full clearing too.", "farm"],
		["Briar just killed Taliyah, so take the safe crab away from where she was seen.", "objective"],
		["Briar is dead, so get that crab and clear back to the top side.", "farm"],
		["You are way too low, just recall now and get back on mana.", "back"],
		["Start your route, because you and Briar are both level 1 with under ten farm right now.", "farm"],
		["Clear Briar's camps while she is down, since you are at least 11 farm ahead.", "farm"]
	]
	for (const [text, kind] of REAL) assert.equal(actionOf(text).kind, kind, text)
})

test("endSec is when the last syllable lands, not when the turn was built", () => {
	const s = newMemory()
	noteSaid(s, "Back now.", 100, 2.5)
	assert.ok(s.said[0]!.endSec > 102.5, "latency plus the time it takes to say it")
	assert.ok(s.said[0]!.endSec < 110)
})

test("PASS and empty lines are not logged, because he did not hear them", () => {
	const s = newMemory()
	noteSaid(s, "PASS", 100, 1)
	noteSaid(s, "   ", 105, 1)
	noteSaid(s, "\n", 110, 1)
	assert.equal(s.said.length, 0)
})

test("'they got the drake' is not advice to take the drake", () => {
	assert.equal(actionOf("They got the drake at fourteen twelve.").kind, "none")
	assert.equal(actionOf("Take the drake now, she is dead.").kind, "objective")
})

test("'back off' is a disengage and 'reset your tempo' is not a recall", () => {
	assert.equal(actionOf("Back off, you lose that duel.").kind, "disengage")
	assert.equal(actionOf("Back now, you're low.").kind, "back")
	/* The bare verb is refused: a reset of TEMPO is not a trip to the fountain. */
	assert.notEqual(actionOf("Let's reset your tempo on camps.").kind, "back")
	assert.deepEqual(actionOf("Let's reset your tempo on camps and look towards the Grubs."), {
		kind: "objective",
		target: "grubs"
	})
})

test("'finish' takes an item only when the object is a proper noun", () => {
	assert.deepEqual(actionOf("Finish Liandry's Torment."), { kind: "buy", target: "Liandry's Torment" })
	assert.equal(actionOf("finish this camp before you path.").kind, "farm")
})

test("the premise classifier is stored and is expected to be unknown on trusted-mode lines", () => {
	const s = newMemory()
	noteSaid(s, "Keep an eye on your mana for this next clear, you're getting a bit low to keep fighting.", 322, 0.8)
	assert.equal(s.said[0]!.premise, "unknown")
})

test("the topic tally makes a monoculture visible", () => {
	const s = newMemory()
	observe(s, sample({}), 0)
	for (const t of [60, 120, 180]) noteSaid(s, "Keep clearing your camps.", t, 0.8)
	assert.match(renderSaid(s, 200), /Topics so far: farm x3\. Total lines: 3\./)
})

/* ================================================================ follow-through */

/** Say one line at `atSec`, then hold the world at `bits` long enough for the window to close. */
const ledger = (atSec: number, text: string, bits: Bits, before: Bits = {}): MemoryState => {
	const s = newMemory()
	hold(s, Math.max(0, atSec - 30), atSec, before)
	noteSaid(s, text, atSec, 0.8)
	const window = WINDOW_SEC[s.said[0]!.action.kind]
	hold(s, atSec + 5, s.said[0]!.endSec + window + 20, bits)
	return s
}

const verdict = (s: MemoryState) => s.said[0]!.follow!

test("a back that happened is FOLLOWED, and the observation is the gold movement", () => {
	const s = ledger(300, "Back now, you're low.", { gold: 100, hp: 1000 }, { gold: 900, hp: 300 })
	assert.equal(verdict(s).verdict, "followed")
	assert.match(verdict(s).why, /gold 900 down to 100/)
})

test("a back verdict needs a TRANSITION, so a man already full when it landed is not FOLLOWED", () => {
	/*
	 * `refilled` used to be "HP and mana both above 95% at any sample in the window", with no
	 * requirement that anything moved — so "go back and buy" said to a man standing at full health
	 * who never left the camp closed as FOLLOWED. With nothing to spend either, the feed genuinely
	 * cannot settle where he went, and `unknown` is the honest verdict.
	 */
	const s = ledger(300, "Back now, you're low.", { gold: 50, hp: 1000, maxHp: 1000, mana: 500, maxMana: 500 }, { gold: 50, hp: 1000, maxHp: 1000, mana: 500, maxMana: 500 })
	assert.equal(verdict(s).verdict, "unknown")
})

test("the back observation never describes a gold RISE as a back", () => {
	/*
	 * At 3:33 of the verified replay this printed `he backed: gold 19 to 189` — income, about a
	 * man who had already spent 906g before the line landed. The `why` is now written from the
	 * transition that was actually seen.
	 */
	const s = ledger(300, "Back now, you're low.", { gold: 189, hp: 1000, maxHp: 1000, mana: 500, maxMana: 500 }, { gold: 19, hp: 400, maxHp: 1000, mana: 100, maxMana: 500 })
	assert.ok(!/backed: gold 19 to 189/.test(verdict(s).why), verdict(s).why)
})

test("a back that did not happen is NOT OBSERVED, and says what it looked at", () => {
	const s = ledger(300, "Back now, you're low.", { gold: 900, hp: 300 }, { gold: 900, hp: 300 })
	assert.equal(verdict(s).verdict, "not-observed")
	assert.match(verdict(s).why, /no back inside 45s/)
})

test("farm advice the feed barely watched is UNKNOWN, never NOT OBSERVED", () => {
	/*
	 * Reported CS is floored to tens, so an unmoved figure means he gained somewhere between zero
	 * and nine — about two camps. Over a few seconds that is no evidence at all. This is the case
	 * where the samples thin out (he alt-tabbed, the page was closed, the game ended) and the
	 * window closes on almost nothing.
	 */
	const s = newMemory()
	hold(s, 200, 260, { cs: 40 })
	noteSaid(s, "Clear your raptors.", 260, 0.8)
	observe(s, sample({ cs: 40 }), 265)
	assert.equal(s.said[0]!.follow, null, "still open — nothing has been watched yet")
	/* The next sample the feed ever produces is well past the window. */
	observe(s, sample({ cs: 40 }), 260 + WINDOW_SEC.farm + 60)
	assert.equal(s.said[0]!.follow!.verdict, "unknown")
	assert.match(s.said[0]!.follow!.why, /floored to tens/)
})

test("the farm window is longer than the quantum guard, or the did-not verdict is unreachable", () => {
	/* A 60s window against a 60s guard measures nothing and then reports it as disobedience. */
	assert.ok(WINDOW_SEC.farm > QUANTUM_HIDES_SEC)
})

test("farm advice that no movement can explain over a longer span is NOT OBSERVED", () => {
	const s = newMemory()
	hold(s, 200, 260, { cs: 40 })
	noteSaid(s, "Clear your raptors.", 260, 0.8)
	hold(s, 265, 400, { cs: 40 })
	assert.equal(s.said[0]!.follow!.verdict, "not-observed")
	assert.match(s.said[0]!.follow!.why, new RegExp(`has not moved off 40 in \\d+s`))
})

test("farm advice given before the camps spawn is UNKNOWN", () => {
	const s = ledger(36, "Head straight to your first camp.", { cs: 0 }, { cs: 0 })
	assert.ok(s.said[0]!.atSec < CAMPS_SPAWN_SEC)
	assert.equal(verdict(s).verdict, "unknown")
	assert.match(verdict(s).why, /had not spawned/)
})

test("a gank is never NOT OBSERVED, because there are no positions in this feed", () => {
	const s = ledger(300, "Go gank mid, she is pushed up.", { cs: 40 })
	assert.equal(verdict(s).verdict, "unknown")
	assert.match(verdict(s).why, /no positions/)
})

test("a gank that produced a kill is FOLLOWED", () => {
	const s = newMemory()
	hold(s, 270, 300, {})
	noteSaid(s, "Go gank mid.", 300, 0.8)
	const kill = { EventID: 12, EventName: "ChampionKill", EventTime: 320, KillerName: "Player", VictimName: "Enemy" }
	observe(s, sample({ events: [kill] }), 320)
	hold(s, 325, 420, { events: [kill] })
	assert.equal(s.said[0]!.follow!.verdict, "followed")
	assert.match(s.said[0]!.follow!.why, /you killed Briar/)
})

test("an objective nobody took is UNKNOWN, not a failure to take it", () => {
	const s = ledger(300, "Take the grubs now.", {})
	assert.equal(verdict(s).verdict, "unknown")
	assert.match(verdict(s).why, /no objective fell/)
})

test("an objective the enemy took is NOT OBSERVED and names who took it", () => {
	const s = newMemory()
	hold(s, 270, 300, {})
	noteSaid(s, "Take the drake now.", 300, 0.8)
	const drake = { EventID: 20, EventName: "DragonKill", EventTime: 330, KillerName: "Enemy", DragonType: "Fire" }
	observe(s, sample({ events: [drake] }), 330)
	hold(s, 335, 420, { events: [drake] })
	assert.equal(s.said[0]!.follow!.verdict, "not-observed")
	assert.match(s.said[0]!.follow!.why, /Briar took Infernal drake/)
})

test("a death inside the window OVERTAKES the advice rather than failing it", () => {
	const s = newMemory()
	hold(s, 270, 300, { d: 0, gold: 900, hp: 300 })
	noteSaid(s, "Back now, you're low.", 300, 0.8)
	hold(s, 305, 400, { d: 1, gold: 900, hp: 0, dead: true })
	assert.equal(s.said[0]!.follow!.verdict, "overtaken")
})

test("only a DEATH settles a disengage; surviving it is UNKNOWN, and the percentage never goes negative", () => {
	/*
	 * There are no positions and no combat flag in this feed, so an HP drop with no death is
	 * ordinary camp damage — 31 of 362 25-second windows over split-03 show more than 35% max-HP
	 * loss with nobody dying. `followed` was being asserted from a state that did not establish
	 * it, and when his health only ROSE across the window the arithmetic went negative:
	 * `he survived and lost only -6% of his bar` is in the real replay of the recorded transcript.
	 */
	const lived = ledger(300, "Back off, don't duel her.", { hp: 1000, maxHp: 1000 }, { hp: 900, maxHp: 1000 })
	assert.equal(verdict(lived).verdict, "unknown")
	assert.ok(!/-\d+%/.test(verdict(lived).why), verdict(lived).why)
	const died = newMemory()
	hold(died, 270, 300, { hp: 1000, maxHp: 1000, d: 0 })
	noteSaid(died, "Back off, don't duel her.", 300, 0.8)
	hold(died, 305, 380, { hp: 0, maxHp: 1000, d: 1, dead: true })
	assert.equal(died.said[0]!.follow!.verdict, "not-observed")
})

test("a line with no parsed advice gets NO verdict at all, and renders as the quoted line alone", () => {
	/*
	 * The old `UNKNOWN — no action was advised` was a statement about the COACH'S OWN SENTENCE,
	 * and it was false on 21 of the 43 real spoken lines, printed directly beneath a quoted
	 * imperative. A parser miss is not a fact about the player or about the coach.
	 */
	const s = newMemory()
	observe(s, sample({}), 100)
	noteSaid(s, "Briar just got a kill in mid lane, so she's not farming right now.", 182, 0.8)
	observe(s, sample({}), 105)
	assert.equal(s.said[0]!.action.kind, "none")
	assert.equal(s.said[0]!.follow, null)
	const text = renderSaid(s, 200)
	assert.match(text, /so she's not farming right now\."$/m)
	assert.ok(!/no action was advised/.test(text), text)
})

test("no verdict in a whole real-shaped run is a did-not that the feed could not settle", () => {
	/* The property, stated once: every `not-observed` must carry an observation about a figure
	 * that actually moved (or provably did not). `unknown` is the only verdict allowed to say
	 * "the feed cannot tell". */
	const s = ledger(300, "Go gank bot.", {})
	assert.notEqual(verdict(s).verdict, "not-observed")
})

test("a buy that landed is FOLLOWED and one that did not names what he bought instead", () => {
	const got = ledger(300, "Finish Liandry's Torment.", { items: ["Liandry's Torment"] }, { items: [] })
	assert.equal(verdict(got).verdict, "followed")
	const missed = ledger(300, "Finish Liandry's Torment.", { items: ["Zhonya's Hourglass"] }, { items: [] })
	assert.equal(verdict(missed).verdict, "not-observed")
	assert.match(verdict(missed).why, /Zhonya's Hourglass instead of Liandry's Torment/)
})

/* ================================================================ the delta */

test("the narrative carries a back, a death and an item purchase across the gap between looks", () => {
	/*
	 * This used to test `renderSinceLastLook`, which was never wired to anything and has been
	 * deleted. The property it was written for is real and now belongs to `renderGameSoFar`, which
	 * IS the payload: the client's own event array scrolls, and without a kept beat log a death
	 * leaves the thread forever the moment the client stops sending it.
	 */
	const s = newMemory()
	hold(s, 0, 300, { cs: 40, level: 5, gold: 900, hp: 300, mana: 200, items: ["Mosstomper Seedling"] })

	/* He backs and buys. */
	observe(s, sample({ cs: 40, level: 5, gold: 120, hp: 1000, mana: 500, items: ["Mosstomper Seedling", "Fated Ashes"] }), 320)
	/* Then he dies. */
	const death = { EventID: 30, EventName: "ChampionKill", EventTime: 350, KillerName: "Enemy", VictimName: "Player" }
	observe(s, sample({ cs: 50, level: 6, gold: 300, hp: 0, mana: 100, d: 1, dead: true, items: ["Mosstomper Seedling", "Fated Ashes"], events: [death] }), 350)

	const text = renderGameSoFar(s, 350, 900)
	assert.match(text, /THE GAME SO FAR/)
	assert.match(text, /5:20 you backed and spent 780 gold/)
	assert.match(text, /5:20 you finished Fated Ashes/)
	assert.match(text, /5:50 Briar killed you/)
	assert.match(text, /level 6/)
})

test("a gold drop while he is dead is a respawn buy, not a back", () => {
	const s = newMemory()
	observe(s, sample({ gold: 900, hp: 0, dead: true, d: 1 }), 300)
	observe(s, sample({ gold: 100, hp: 1000, dead: false, d: 1, items: ["Fated Ashes"] }), 310)
	const beat = s.beats.find(b => b.kind === "respawn-buy" || b.kind === "back")!
	assert.equal(beat.kind, "respawn-buy")
	assert.match(beat.text, /you respawned and spent 800 gold/)
})

test("fountain shopping in several drops is one back", () => {
	const s = newMemory()
	observe(s, sample({ gold: 1400 }), 300)
	observe(s, sample({ gold: 1000, items: ["Fated Ashes"] }), 305)
	observe(s, sample({ gold: 600, items: ["Fated Ashes", "Boots"] }), 310)
	observe(s, sample({ gold: 100, items: ["Fated Ashes", "Boots", "Amplifying Tome"] }), 315)
	assert.equal(s.beats.filter(b => b.kind === "back").length, 1)
	assert.equal(s.beats.filter(b => b.kind === "buy").length, 3)
})

test("a gold drop under the floor is not a back", () => {
	const s = newMemory()
	observe(s, sample({ gold: 500 }), 300)
	observe(s, sample({ gold: 500 - (BACK_GOLD_DROP - 1) }), 305)
	assert.equal(s.beats.filter(b => b.kind === "back").length, 0)
})

test("the first turn of a game says so rather than printing an empty section", () => {
	const s = newMemory()
	observe(s, sample({}), 100)
	assert.match(renderSaid(s, 100), /Nothing yet/)
	// The narrative has the header and the standing line and no beats, which is the honest shape.
	assert.match(renderGameSoFar(s, 100, 900), /THE GAME SO FAR/)
})

/* ================================================================ the whole thing */

test("nothing prose-shaped is stored, so a re-render at the same clock is identical", () => {
	const s = real()
	const now = samples.at(-1)!.gameTime
	assert.equal(renderGameSoFar(s, now, 900), renderGameSoFar(s, now, 900))
	assert.equal(renderSaid(s, now), renderSaid(s, now))
})

test("torn and half-written payloads are ignored rather than crashing", () => {
	const s = newMemory()
	for (const junk of [null, undefined, 3, "x", [], {}, { data: {} }, { data: { allPlayers: [] } }])
		observe(s, junk, 100)
	assert.equal(s.recent.length, 0)
	assert.equal(s.beats.length, 0)
	assert.equal(renderNarrative(s, 100), "THE GAME SO FAR (accumulated, not a fresh reading)")
})

/* ================================================================ the long replay */

const LONG = new URL("../../data/live-samples/split-03.ndjson", import.meta.url)

test("the whole recorded game accumulates without growing without bound", { skip: !existsSync(LONG) && "data/ is not committed" }, () => {
	const rows = readFileSync(LONG, "utf8")
		.split("\n")
		.filter(l => l.trim() !== "")
		.map(l => JSON.parse(l) as { gameTime: number })
	const s = newMemory()
	for (const row of rows) observe(s, row, row.gameTime)
	const end = rows.at(-1)!.gameTime

	assert.equal(s.me, "Lillia")
	assert.equal(s.counterpart, "Briar")
	assert.equal(s.recent.length, RECENT_KEEP)
	assert.ok(s.beats.length > 100, "a 36-minute game leaves a lot of beats")

	/* The bound that matters: the RENDER does not grow with the game, because compaction drops
	 * weight-0 and weight-1 beats by age. Measured at 703 chars on this game's final sample. */
	const narrative = renderNarrative(s, end)
	assert.ok(narrative.length < 1200, `narrative was ${narrative.length} chars`)
	assert.ok(narrative.split("\n").length <= 3 + 14, "head, race, and at most fourteen beats")
})

/**
 * The capped run's own twelve turns of game 5635467422, verbatim from
 * `data/eval/stream-2026-09-09T19-30-19.json`, with the latencies that were actually measured.
 * These are recorded utterances, not invented coaching.
 */
const CAPPED_RUN: readonly [number, number, string][] = [
	[5.76, 0.7, "Grab your jungle pet and get to Blue buff — you want a healthy clear to stay ahead of this Briar."],
	[36.37, 0.8, "Good back for the seedling, now head straight to your first camp."],
	[66.86, 0.7, "Keep orbiting with Q, you want to clear this camp while moving towards the next one."],
	[97.35, 0.7, "Center your W on the red buff for maximum damage, and keep that clear speed up."],
	[140.0, 0.7, "Keep running that clear and do not even think about dueling Briar at the crab."],
	[182.63, 0.9, "Briar just got a kill in mid lane, so she's not farming right now."],
	[213.07, 0.8, "Back now, you're low and need that Fated Ashes power spike for your clear."],
	[243.62, 0.9, "Fated Ashes is huge, head to your next camp and keep powerfarming while Briar is dead for the next few seconds."],
	[274.08, 0.8, "PASS"],
	[322.83, 1.0, "Keep an eye on your mana for this next clear, you're getting a bit low to keep fighting."],
	[365.48, 1.0, "They got the drake, so now you can focus on clearing your camps or going for the Voidgrubs."],
	[402.17, 1.1, "Tough fight bot but you're back up with items, let's reset your tempo on camps and look towards the Grubs."]
]

/** Step the whole recorded game, speaking the capped run's lines at their own clocks. */
const replayCappedRun = (): MemoryState => {
	const rows = readFileSync(LONG, "utf8")
		.split("\n")
		.filter(l => l.trim() !== "")
		.map(l => JSON.parse(l) as { gameTime: number })
	const s = newMemory()
	let i = 0
	for (const row of rows) {
		observe(s, row, row.gameTime)
		while (i < CAPPED_RUN.length && CAPPED_RUN[i]![0] <= row.gameTime) {
			noteSaid(s, CAPPED_RUN[i]![2], CAPPED_RUN[i]![0], CAPPED_RUN[i]![1])
			i++
		}
	}
	return s
}

test("the capped run's PASS turn is not a line he heard", { skip: !existsSync(LONG) && "data/ is not committed" }, () => {
	const s = replayCappedRun()
	assert.equal(s.said.length, 11, "twelve turns, one of them a PASS")
	assert.ok(s.said.every(u => u.text !== "PASS"))
})

test("every did-not verdict over the real run cites a figure that moved", { skip: !existsSync(LONG) && "data/ is not committed" }, () => {
	const s = replayCappedRun()
	for (const u of s.said) {
		const f = u.follow
		/* An unparsed line gets no verdict at all now; there is nothing here to be wrong about. */
		if (u.action.kind === "none") {
			assert.equal(f, null, `${u.text} was scored despite parsing to no action`)
			continue
		}
		assert.ok(f !== null, `${u.text} never closed`)
		if (f.verdict !== "not-observed") continue
		assert.match(f.why, /\d/, `a did-not with no number in it: "${u.text}" -> ${f.why}`)
	}
})

test("an objective HE took resolves FOLLOWED, not NOT OBSERVED", { skip: !existsSync(LONG) && "data/ is not committed" }, () => {
	/*
	 * The case the suite had no test for, and it was structurally unreachable: `namer()` gives him
	 * his CHAMPION name, so an objective beat reads "Lillia took Ocean drake" and the old check
	 * (`text.startsWith("you")`) was false for every objective ever recorded. Replayed against the
	 * real feed — Gooskaffur takes Ocean drake at 30:43 — the line rendered as
	 * `NOT OBSERVED — Lillia took Ocean drake`, a verdict contradicting its own evidence, on its
	 * way into the model's context as a false accusation about the player.
	 */
	const rows = readFileSync(LONG, "utf8")
		.split("\n")
		.filter(l => l.trim() !== "")
		.map(l => JSON.parse(l) as { gameTime: number })
	const s = newMemory()
	let said = false
	for (const row of rows) {
		observe(s, row, row.gameTime)
		if (!said && row.gameTime >= 1800) {
			noteSaid(s, "Take drake.", 1800, 1.0)
			said = true
		}
		if (row.gameTime > 1950) break
	}
	const u = s.said[0]!
	assert.equal(u.action.kind, "objective")
	assert.equal(u.follow!.verdict, "followed", u.follow!.why)
	assert.match(u.follow!.why, /took Ocean drake/)
})

test("the two lines the feed cannot settle are UNKNOWN, and the one the game overtook says so", { skip: !existsSync(LONG) && "data/ is not committed" }, () => {
	const s = replayCappedRun()
	const at = (sec: number) => s.said.find(u => Math.abs(u.atSec - sec) < 1)!

	/*
	 * 3:02 and 5:22 are readouts with no action in them. A readout cannot be disobeyed — and it no
	 * longer gets a verdict at all, because a verdict on an unparsed line was a statement about the
	 * coach's own sentence rather than about the player.
	 */
	assert.equal(at(182.63).action.kind, "none")
	assert.equal(at(182.63).follow, null)
	/*
	 * 5:22 — "Keep an eye on your mana for this next clear, you're getting a bit low to keep
	 * fighting" — is one of the 16% the parser still cannot read (it was 49% before). That is not
	 * a defect it can paper over: an unreadable line now prints as the quoted line alone, which is
	 * honest, rather than as `UNKNOWN — no action was advised` under an imperative.
	 */
	assert.equal(at(322.83).action.kind, "none")
	assert.equal(at(322.83).follow, null)

	/*
	 * 6:05 — "focus on clearing your camps OR going for the Voidgrubs" — classifies on the camps,
	 * because that is the imperative that comes first; the grubs are the alternative offered after
	 * it. Briar killed him inside the window either way, and a death is not a did-not.
	 */
	assert.equal(at(365.48).action.kind, "farm")
	assert.equal(at(365.48).follow!.verdict, "overtaken")

	/* 6:42 named the grubs and nobody took anything. Also not a did-not. */
	assert.equal(at(402.17).follow!.verdict, "unknown")
	assert.match(at(402.17).follow!.why, /no objective fell/)
})

test("the memory the coach would have held at 5:22 names what it had already said", { skip: !existsSync(LONG) && "data/ is not committed" }, () => {
	const rows = readFileSync(LONG, "utf8")
		.split("\n")
		.filter(l => l.trim() !== "")
		.map(l => JSON.parse(l) as { gameTime: number })
	const s = newMemory()
	let i = 0
	let text = ""
	for (const row of rows) {
		if (row.gameTime > 330) break
		observe(s, row, row.gameTime)
		while (i < CAPPED_RUN.length && CAPPED_RUN[i]![0] <= row.gameTime) {
			if (Math.abs(CAPPED_RUN[i]![0] - 322.83) < 1)
				text = `${renderGameSoFar(s, row.gameTime, 900)}\n\n${renderSaid(s, row.gameTime)}`
			noteSaid(s, CAPPED_RUN[i]![2], CAPPED_RUN[i]![0], CAPPED_RUN[i]![1])
			i++
		}
	}
	/* The three things the capped run had no way of knowing when it spoke at 5:22. */
	assert.match(text, /THE GAME SO FAR/)
	assert.match(text, /3:39 you finished Fated Ashes/, "the item it advised at 3:33 and never mentioned again")
	assert.match(
		text,
		/2:44 Briar was seen holding Scorchclaw Pup/,
		"the counterpart's build, which he cannot see — and worded as the sighting it is"
	)
	assert.match(text, /Topics so far: farm x6/, "six of its eight lines had been about farm")
	assert.ok(text.length < 2500, `the whole memory block was ${text.length} chars`)
})


/*
 * ---------------------------------------------------------------- the counterpart, without a farm figure
 */

test("the counterpart's last-seen line names his build and never his farm", () => {
	const s = newMemory()
	observe(s, sample({ level: 6, cpLevel: 6, cpCs: 20, cpItems: ["Scorchclaw Pup", "Hubris"] }), 60)
	observe(s, sample({ level: 8, cpLevel: 7, cpCs: 30, cpItems: ["Scorchclaw Pup", "Hubris", "Ionian Boots of Lucidity"] }), 300)
	const t = renderCounterpart(s, 360)
	assert.match(t, /BRIAR, LAST SEEN/)
	assert.match(t, /lvl 7 \(1m00s ago\)/)
	assert.match(t, /3 items \(1m00s ago\): Scorchclaw Pup, Hubris, Ionian Boots of Lucidity/)
	assert.ok(!/farm \(/.test(t), t)
	assert.ok(!/\b30 farm\b/.test(t), t)
})

/**
 * The one honest use of the field that lies.
 *
 * The counterpart's `creepScore` counts only the farm this client witnessed, so it is useless as
 * farm and its DERIVATIVE is the feed's only sighting signal: a tick can only have happened while
 * his team could see him. The asymmetry has to be stated, because the sentence a reader would build
 * from a bare age — "he has not been seen in four minutes" — is a fabrication. It is floored to
 * tens, so nine witnessed kills leave it exactly where it was.
 */
test("a farm-counter tick is rendered as a confirmed sighting, and a stale one proves nothing", () => {
	const s = newMemory()
	observe(s, sample({ cpCs: 20 }), 60)
	observe(s, sample({ cpCs: 30 }), 120)
	const t = renderCounterpart(s, 200)
	assert.match(t, /farm counter last ticked 1m20s ago/)
	assert.match(t, /he was certainly seen then/)
	assert.match(t, /A stale one is NOT evidence he is unseen/)
})

test("a counterpart never seen is stated as unseen, not as a man who has bought nothing", () => {
	const s = newMemory()
	observe(s, sample({ cpCs: 0, cpItems: [] }), 60)
	const t = renderCounterpart(s, 60)
	assert.match(t, /an empty list means he has not been seen, not that he has bought nothing/)
	assert.match(t, /never moved/)
})

test("cpSeenAt is the age the brief needs, and null before anything on his row has moved", () => {
	/*
	 * The regression: `cpSeen` was computed on every observe and no caller ever read it, so
	 * `buildBrief` got `counterpartSeenSec: undefined` and rendered "his row carries no age this
	 * turn" — an assertion of freshness — on every turn of every game. At 2:06 of game 5639406342
	 * that turned a frozen "Kayn lvl 1" into "you are two whole levels up on Kayn" when the
	 * timeline has the gap at one.
	 */
	const fresh = newMemory()
	assert.equal(cpSeenAt(fresh), null, "nothing has moved yet, so there is no age to state")

	// The MAX of the three, not the level's own clock: any of them moving refreshed the row.
	const moved: MemoryState = { ...fresh, cpSeen: { level: 120, cs: 200, items: 0 } }
	assert.equal(cpSeenAt(moved), 200)

	// `items` uses 0 as its own "never", so it must not win a max against real clocks.
	const onlyLevel: MemoryState = { ...fresh, cpSeen: { level: 90, cs: null, items: 0 } }
	assert.equal(cpSeenAt(onlyLevel), 90)

	const itemsLatest: MemoryState = { ...fresh, cpSeen: { level: 90, cs: null, items: 300 } }
	assert.equal(cpSeenAt(itemsLatest), 300)
})

/* ================================================================ the dead clock
 *
 * The feed states a death ONE WAY ROUND — `respawnTimer`, the time remaining — and the sentence a
 * coach reaches for is the other one. Across the 28 stored games 153 spoken lines state an elapsed
 * death time and 71 contradict the client's own kill log, one-sided: 101 overstate, 4 understate,
 * and 101 of 115 spoke a number within ten seconds of the `back in N` figure printed beside them.
 * The elapsed instant has to be WATCHED, because the only other way to it is a respawn schedule and
 * respawn length is a patch value that grows with game time.
 */

test("the kill log dates a death exactly, and it dates everyone's", () => {
	const s = real()
	/*
	 * The recording's own `ChampionKill` at 346s: Taliyah kills Lissandra, who is still down at the
	 * second sample with 2.8s left on her timer. Elapsed 13s against remaining 3s — the two figures
	 * the model was converting between, and neither is derivable from the other.
	 */
	const liss = deathsSeen(s).Lissandra!
	assert.ok(liss, "Lissandra's death is in the client's event log")
	assert.equal(Math.round(liss.atSec), 346)
	assert.equal(liss.exact, true)
	/* Not just the counterpart: half of the contradicted lines named somebody else. */
	assert.ok(Object.keys(deathsSeen(s)).length > 1, Object.keys(deathsSeen(s)).join(", "))
})

test("with no kill line the alive->dead edge bounds it, and says so", () => {
	const s = newMemory()
	observe(s, sample({ cpDead: false }), 100)
	observe(s, sample({ cpDead: true }), 105)
	const d = deathsSeen(s).Briar!
	assert.ok(d)
	/*
	 * The edge only proves she died somewhere in the poll gap, so the instant is the moment the app
	 * SAW the body and the elapsed time it yields is a lower bound. `live-brief.ts` renders it as
	 * "down at least Ns" — the honest form of a figure that cannot be tighter than the sampler.
	 */
	assert.equal(d.atSec, 105)
	assert.equal(d.exact, false)
})

test("the kill line wins over the edge that saw the same death", () => {
	const s = newMemory()
	observe(s, sample({ cpDead: false }), 100)
	observe(
		s,
		sample({
			cpDead: true,
			events: [{ EventID: 1, EventName: "ChampionKill", EventTime: 102, KillerName: "Player", VictimName: "Enemy" }]
		}),
		105
	)
	assert.deepEqual(deathsSeen(s).Briar, { atSec: 102, exact: true })
})

/*
 * THE ONE WAY THIS RECORD COULD STATE A CONFIDENT WRONG NUMBER, closed.
 *
 * A death dated at 3:00 and left standing survives the respawn and is then sitting there when the
 * man dies again — and if nothing watched the second death, the brief would render the first one's
 * age as this one's. So a respawn drops the entry and the next death has to be watched on its own.
 */
test("a respawn ends the clock, and an unwatched second death is NOT KNOWN rather than the first one's age", () => {
	const s = newMemory()
	observe(s, sample({ cpDead: false }), 100)
	observe(s, sample({ cpDead: true }), 105)
	observe(s, sample({ cpDead: false }), 130)
	assert.equal(deathsSeen(s).Briar, undefined)
	/* She dies again with no sample and no kill line in between: still unknown, not 30s stale. */
	const later = newMemory()
	observe(later, sample({ cpDead: true }), 200)
	assert.equal(deathsSeen(later).Briar, undefined)
})

test("a death from before this memory started is still dated, because the first observe reads the whole log", () => {
	const s = newMemory()
	observe(
		s,
		sample({
			cpDead: true,
			events: [{ EventID: 1, EventName: "ChampionKill", EventTime: 240, KillerName: "Player", VictimName: "Enemy" }]
		}),
		260
	)
	assert.deepEqual(deathsSeen(s).Briar, { atSec: 240, exact: true })
})
