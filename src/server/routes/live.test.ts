/**
 * The seam where the PICTURE becomes something the coach may say.
 *
 * `analysis/live-facts.ts` decides what a frame read is worth; this route decides what survives to
 * be offered one at all. Two rules live here and both are measured, so both are pinned:
 *
 *   - the read is COARSENED to a half of the map at the door, because that is the only granularity
 *     that measured well enough to act on (his own half right on 17 of 18 hand-scored reads, his own
 *     zone on 15 of 18) and precision that is never stored cannot later be reached for;
 *   - two consecutive reads that disagree about the half mark the observation `low`, because two
 *     reads of ONE picture agreed on only 56 of 60 pairs and a disagreement is that 7% arriving.
 *
 * The fence itself (`frameReadFaults`) is tested in `review/frame-read.test.ts`; what is tested here
 * is the step after it.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { describe, it } from "node:test"
import {
	CARRY_MAX_SEC,
	carryable,
	frameClockSec,
	observationFrom,
	pictureFix,
	pictureLine,
	socketSystemPrompt,
	truthFromRaw
} from "./live.ts"
import { pronunciationTable } from "../../knowledge/index.ts"
import { buildBrief } from "../../shared/live-brief.ts"
import { pronunciationsFor } from "../../shared/pronounce.ts"
import { buildFacts, FRAME_FRESH_SEC, newFactMemory } from "../../analysis/live-facts.ts"
import type { FrameObservation } from "../../analysis/live-facts.ts"
import type { FrameRead } from "../../review/frame-read.ts"
import { TEAM_BLUE, TEAM_RED } from "../../shared/constants.ts"
import type { Zone } from "../../shared/map.ts"

const read = (you: FrameRead["you"]): FrameRead => ({
	enemiesOnMinimap: [],
	alliesOnMinimap: 0,
	you,
	activity: "moving",
	youChampion: null
})

describe("observationFrom", () => {
	it("keeps the half and throws the zone away", () => {
		/*
		 * `OWN_JUNGLE_TOP` and `BARON_PIT` are different places and the same decision. Storing the
		 * zone would leave a 83%-accurate answer sitting in a field that a later sentence could
		 * name a camp from, which is exactly the class of claim the enemy-sighting measurement
		 * ruled out.
		 */
		deepStrictEqual(observationFrom(read("OWN_JUNGLE_TOP"), null, 600), {
			where: "topside",
			atSec: 600,
			confidence: "medium"
		})
		strictEqual(observationFrom(read("DRAGON_PIT"), null, 600).where, "botside")
		strictEqual(observationFrom(read("LANE_MID"), null, 600).where, "mid")
		strictEqual(observationFrom(read("OWN_BASE"), null, 600).where, "base")
	})

	it("passes a refusal through as a refusal, not as a place", () => {
		// The reader is offered "not visible" precisely so that guessing is never its only move.
		// Turning that into a half here would undo the whole point of offering it.
		strictEqual(observationFrom(read(null), null, 600).where, null)
	})

	it("doubts a read that disagrees with the one before it", () => {
		const previous = { where: "topside" as const, atSec: 595 }
		strictEqual(observationFrom(read("DRAGON_PIT"), previous, 600).confidence, "low")
		strictEqual(observationFrom(read("BARON_PIT"), previous, 600).confidence, "medium")
	})

	it("does not doubt a read that simply came much later", () => {
		/*
		 * He crosses the map. Two reads a minute apart disagreeing is a man walking, not a reader
		 * contradicting itself, and treating it as doubt would make the coach quietest in exactly
		 * the games where he is moving most.
		 */
		const previous = { where: "topside" as const, atSec: 500 }
		strictEqual(
			observationFrom(read("DRAGON_PIT"), previous, 500 + FRAME_FRESH_SEC + 1).confidence,
			"medium"
		)
	})

	it("counts a lost icon as a disagreement when it follows a sighting", () => {
		// One read placed him and the next could not find him at all. That is the reader being
		// unstable on the same picture, and it is the case a "compare two halves" test would miss
		// if null were quietly excused.
		const previous = { where: "botside" as const, atSec: 598 }
		strictEqual(observationFrom(read(null), previous, 600).confidence, "low")
	})
})

/**
 * The blocker: the minimap read was structurally dead in the shipped mode.
 *
 * `POST /api/live/frame-read` refuses everything unless the route has cached a `FrameTruth` to
 * fence against, and that cache was written in exactly one place — inside `buildLiveState`, which
 * the `trusted` branch returns above. So under the default mode no read was ever accepted,
 * `frameRead` stayed null forever, and the `Picture:` clause was absent from every turn — while
 * `ScreenCoach` went on uploading a 17 KB crop every beat to be refused. That is the one mechanism
 * in the app aimed at the failure that was actually reported: at 1:37 the coach said "Center your W
 * on the red buff" about a man standing on a topside camp.
 *
 * This pins the narrowing the trusted branch now uses instead. It is the same five fields
 * `truthFromState` produces, and it has to be, or a read is fenced differently depending on which
 * mode is selected.
 */
describe("truthFromRaw", () => {
	const payload = {
		activePlayer: { riotId: "Gooskaffur#NA1", summonerName: "Gooskaffur" },
		allPlayers: [
			{ riotId: "Gooskaffur#NA1", championName: "Lillia", team: "ORDER", isDead: false },
			{ riotId: "mate#NA1", championName: "Braum", team: "ORDER", isDead: true },
			{ riotId: "foe1#NA1", championName: "Briar", team: "CHAOS", isDead: false },
			{ riotId: "foe2#NA1", championName: "Ornn", team: "CHAOS", isDead: true }
		]
	}

	it("narrows the same five facts the fence takes from a VisionState", () => {
		deepStrictEqual(truthFromRaw(payload as never), {
			myChampion: "Lillia",
			meDead: false,
			enemiesAlive: 1,
			alliesAlive: 0,
			enemyChampions: ["Briar", "Ornn"]
		})
	})

	it("counts him out of his own allies, so a fence cannot be off by one", () => {
		// `alliesAlive` fences the count of blue rings on the minimap, and his own icon is not one
		// of them. Including himself would let an invented ally through on every read.
		const alive = truthFromRaw({
			...payload,
			allPlayers: payload.allPlayers.map(p => ({ ...p, isDead: false }))
		} as never)
		strictEqual(alive.alliesAlive, 1)
		strictEqual(alive.enemiesAlive, 2)
	})
})

/**
 * THE PRONUNCIATION GUIDE, ASSERTED ON THE PAYLOAD RATHER THAN ON THE RENDERER.
 *
 * `shared/pronounce.ts` was written, documented and unit-tested, and every one of those tests
 * passed for weeks while the feature was switched off: the block had deliberately stopped
 * rendering the guide ("BRY-er is still at 0 CS", out loud, in a real game) and the system
 * instruction never started. Measured on game 5639406342 — Lillia into Kayn, 28 minutes, the first
 * full paired stream this app has — **zero of 715 ground-truth blocks carried a pronunciation
 * section**, and the player's verdict on that game's coaching was "a total disaster".
 *
 * A unit test on the renderer cannot catch a renderer with no caller. So these assert on
 * `socketSystemPrompt`, the function the token route actually mints with, for rosters read off
 * REAL recorded games rather than invented here: a roster the brief itself names, and the roster of
 * the game he graded.
 */
describe("socketSystemPrompt", () => {
	const prompt = socketSystemPrompt({ mode: "trusted", championKnowledge: "" })
	const says = (champion: string): boolean =>
		prompt.split("\n").some(l => l.startsWith(`${champion} — say `))

	/*
	 * The roster of game 5639406342, copied from the raw samples the daemon recorded during it
	 * (`data/live-samples/js-mtvxb5f4-f81a-t29817812.ndjson`, 279 samples, `allPlayers[].
	 * championName`). Written out rather than read, because `data/` is not committed; the test
	 * below re-checks it against the file whenever the file is present, so the constant cannot
	 * quietly drift from the game it claims to describe.
	 */
	const GRADED_GAME_ROSTER = [
		"Urgot",
		"Lillia",
		"Yone",
		"Xayah",
		"Morgana",
		"Ornn",
		"Kayn",
		"Singed",
		"Draven",
		"Lulu"
	]

	it("covers every champion in the game he graded 0/10", () => {
		/*
		 * Four of these ten had no row at all when he played it — Morgana, Ornn, Draven and Lulu —
		 * so even a wired-up guide would have left the model free-styling nearly half the roster.
		 * A missing name is as silent a failure as a missing caller.
		 */
		const missing = GRADED_GAME_ROSTER.filter(c => !says(c))
		deepStrictEqual(missing, [], `no say-it-like-this line for: ${missing.join(", ")}`)
	})

	it("carries a guide for the roster the brief itself names", () => {
		/*
		 * The wiring test. `buildBrief` reads a real recorded `allgamedata` pair and names the ten
		 * champions of that game; every one of them must have a line in what the socket is told at
		 * setup. This fails outright — no guide in the prompt at all — on the code that shipped
		 * into game 5639406342.
		 */
		const samples = readFileSync(
			new URL("../../shared/__fixtures__/live-brief-sample.ndjson", import.meta.url),
			"utf8"
		)
			.trim()
			.split("\n")
			.map(l => JSON.parse(l) as { gameTime: number; data: unknown })
		const brief = buildBrief({ raw: samples[1]!, gameTimeSec: samples[1]!.gameTime })
		ok(brief, "the fixture must still build a brief")
		strictEqual(brief.roster.length, 10)
		const missing = brief.roster.filter(c => !says(c))
		deepStrictEqual(missing, [], `no say-it-like-this line for: ${missing.join(", ")}`)
	})

	it("puts the guide in the instructions and never in the turn's facts", () => {
		/*
		 * The other half of the rule, and the one that was paid for in a real game: a respelling
		 * inside CONTENT gets spoken. The guide must be in the once-per-socket instruction, and no
		 * respelling of a champion in this game may appear anywhere in the per-turn brief.
		 */
		ok(prompt.includes("this is about your VOICE, not about the game"))
		const samples = readFileSync(
			new URL("../../shared/__fixtures__/live-brief-sample.ndjson", import.meta.url),
			"utf8"
		)
			.trim()
			.split("\n")
			.map(l => JSON.parse(l) as { gameTime: number; data: unknown })
		const brief = buildBrief({ raw: samples[1]!, gameTimeSec: samples[1]!.gameTime })!
		for (const p of pronunciationsFor(brief.roster, pronunciationTable()))
			ok(!brief.text.includes(p.say), `the brief must not contain the respelling ${p.say}`)
	})

	it("stays out of the way when the table is empty", () => {
		// A guide is due only when there is something to say; an empty one must not leave a heading
		// hanging in the instructions promising a list that is not there.
		strictEqual(
			socketSystemPrompt({ mode: "trusted", championKnowledge: "", pronunciations: [] }),
			socketSystemPrompt({ mode: "trusted", championKnowledge: "", pronunciations: [] })
		)
		ok(
			!socketSystemPrompt({ mode: "trusted", championKnowledge: "", pronunciations: [] }).includes(
				"about your VOICE"
			)
		)
	})

	it("matches the roster actually recorded, when the recording is on this machine", () => {
		// Evidence, not decoration: the constant above is a claim about a real game, and this is
		// how it stays one. Skipped where `data/` is absent, which is every machine but his.
		const path = new URL(
			"../../../data/live-samples/js-mtvxb5f4-f81a-t29817812.ndjson",
			import.meta.url
		)
		if (!existsSync(path)) return
		const lines = readFileSync(path, "utf8").trim().split("\n")
		const last = JSON.parse(lines[lines.length - 1]!) as {
			data: { allPlayers: { championName: string }[] }
		}
		deepStrictEqual(
			last.data.allPlayers.map(p => p.championName),
			GRADED_GAME_ROSTER
		)
	})
})

/**
 * THE STAMP, and the reason the reader was paid for 340 frames of a real game and never heard.
 *
 * `POST /api/live/frame-read` stamped every accepted read with `lastTruth.atSec` — the game clock
 * of the PREVIOUS ground-truth poll, because that is the only clock the route had cached. The
 * browser's turn does the read FIRST and fetches the block after it (`geminiLive.ts`: "READ THE
 * MINIMAP FIRST, because the block is built from it"), so the poll being quoted is a whole turn
 * old. Turns are twenty seconds apart and `FRAME_FRESH_SEC` is ten, which makes
 * `nowSec - frame.atSec` about 21-23 on every single turn and the read is discarded by
 * `buildFacts` before anything can be built from it.
 *
 * The cost was paid in full and thrown away: the crop is uploaded, the model call runs 1.3-3.0s in
 * front of the turn, the fence passes it, `frameRead` is stored — and the one field in this app
 * that knows where he is standing was never once inside the freshness window that would let it
 * gate a line or modify one. Hand-checked on game 5639406342 the reader is 7/8 exact on the zone
 * with 1.8% median position error; none of that reached the coach.
 *
 * These two cases are the bug and the fix on one timeline, and the first one stays in the suite
 * for the same reason the app keeps its measurements: a stamp taken from the wrong clock still
 * looks exactly like a stamp.
 */
describe("the clock a frame read is stamped with", () => {
	/** The route's cached poll: the client said 10:00, and the daemon read it at this wall instant. */
	const poll = { atSec: 600, atMs: 1_700_000_000_000 }
	/** The browser grabs the minimap and posts it 19.4s later — the next turn, at the shipped cadence. */
	const postMs = poll.atMs + 19_400
	/** The read costs ~2.1s, then the turn's own poll builds the facts at the clock it reads. */
	const turnSec = 621.5

	/** One turn of the ranker, with a drake window open and his icon read topside. */
	const factsWith = (stampSec: number): string[] =>
		buildFacts(
			{
				nowSec: turnSec,
				meDeadForSec: null,
				alliesAlive: 5,
				enemiesAlive: 5,
				deadEnemies: [],
				currentGold: null,
				pace: null,
				enemyObjectives: [],
				counterpart: null,
				myEvents: [],
				drakeBackInSec: 40,
				baronBackInSec: null,
				heraldBackInSec: null,
				frame: observationFrom(read("OWN_JUNGLE_TOP"), null, stampSec)
			},
			newFactMemory()
		)

	it("was the previous poll's clock, and every read died of it", () => {
		const out = factsWith(poll.atSec)
		strictEqual(turnSec - poll.atSec > FRAME_FRESH_SEC, true, "a turn is older than the window")
		ok(
			out.every(f => !f.includes("looks like you're")),
			`the read should be discarded on the old stamp, got: ${out.join(" | ")}`
		)
	})

	it("is the clock the PICTURE was taken at, and the read reaches the coach", () => {
		strictEqual(Math.round(frameClockSec(poll, postMs)), 619)
		const out = factsWith(frameClockSec(poll, postMs))
		ok(
			out.some(f => f.includes("looks like you're topside")),
			`the read should modify the drake call, got: ${out.join(" | ")}`
		)
	})
})

/**
 * What the shipped mode is actually handed, and the four ways it is handed nothing.
 *
 * `trusted` does not run the ranker, so the frame read reaches the model as this one sentence or
 * not at all. Silence is the correct output for a refusal and it is most of them: on the graded
 * game the fence refused 44% of reads, and it was right to — 16 of those refusals were the model
 * pointing at a red-ringed Singed inside his own camera box and calling it him.
 */
describe("pictureLine", () => {
	const at = (over: Partial<FrameObservation>): FrameObservation => ({
		where: "topside",
		atSec: 597,
		confidence: "medium",
		...over
	})

	it("carries the half, its age, and the reader's measured accuracy", () => {
		const line = pictureLine(at({}), 600)
		ok(line !== null)
		ok(line.includes("topside"), line)
		ok(line.includes("3s ago"), line)
		// The confidence travels as the MEASUREMENT, not as the word "medium". A model can price a
		// sentence against 17 of 18; it cannot price one against an adjective this app invented.
		ok(line.includes("17 of 18"), line)
		ok(line.includes("not something this feed knows"), line)
	})

	it("says whose icon it is, because the coach got that wrong three times in one game", () => {
		const line = pictureLine(at({}), 600)
		ok(line !== null)
		/*
		 * The payload addresses the player as "you" everywhere else and the only other person in it
		 * is the enemy jungler, so a third-person "his own icon" was ambiguous — and on the graded
		 * run the coach resolved it to the counterpart on three of the seven turns that carried it,
		 * once telling him to take Baron while Kayn was standing in the pit. The pronoun is the
		 * whole sentence; this pins it.
		 */
		ok(line.includes("YOUR own icon"), line)
		ok(line.includes("where YOU are, not where anyone else is"), line)
		ok(!/\bhis own icon\b/.test(line), line)
	})

	it("says nothing at all when there is nothing to say", () => {
		strictEqual(pictureLine(null, 600), null, "no read at all")
		strictEqual(pictureLine(at({ where: null }), 600), null, "the reader refused to place him")
		strictEqual(pictureLine(at({ confidence: "low" }), 600), null, "two looks disagreed")
		strictEqual(
			pictureLine(at({ atSec: 600 - CARRY_MAX_SEC - 1 }), 600),
			null,
			"a picture old enough to say nothing about which half he is on"
		)
	})

	it("refuses a stamp from the future instead of clamping it to fresh", () => {
		/*
		 * The regression this replaces printed `Math.max(0, …)`, so a stamp ahead of the clock read
		 * as "0s ago" — the freshest thing in the brief. A PAUSED game produces exactly that stamp:
		 * `frameClockSec` carries the game clock forward on the WALL clock, which keeps running
		 * while the game's does not. Too large is the direction that fails safe only if something
		 * actually drops it.
		 */
		strictEqual(pictureLine(at({ atSec: 620 }), 600), null)
	})

	/**
	 * TWO WINDOWS, and the boundary between them is the ranker's own — not a second copy of it.
	 *
	 * `FRAME_FRESH_SEC` still decides what may be said in the PRESENT tense, so the two live paths
	 * cannot disagree about when a picture stopped being about where he is. What changed is what
	 * happens on the far side of it: the line used to vanish, and now it changes tense.
	 */
	it("switches tense at the ranker's freshness rule instead of going silent", () => {
		const fresh = pictureLine(at({ atSec: 600 - FRAME_FRESH_SEC }), 600)
		ok(fresh !== null)
		ok(fresh.includes("this is where YOU are"), fresh)

		const carried = pictureLine(at({ atSec: 600 - FRAME_FRESH_SEC - 0.001 }), 600)
		ok(carried !== null, "a read one millisecond past fresh is still worth a past-tense line")
		ok(carried.includes("where YOU WERE"), carried)
		ok(carried.includes("you may have moved"), carried)
		ok(!carried.includes("this is where YOU are"), carried)
	})

	/**
	 * The far edge, which is a MEASUREMENT and not a preference — see `CARRY_MAX_SEC`.
	 *
	 * 2,602 frame-to-event pairs across the 94 stored games: the coarse half holds on 69.0% of the
	 * 20-30s pairs and on 47.6% of the 30-45s ones, against 31.8% chance agreement. Thirty seconds
	 * is where a carried read stops being a better-than-even bet, and a line that is true but
	 * uninformative is paid for out of a fixed character budget by whatever falls off the bottom.
	 */
	it("stops carrying at the measured cliff, to the second", () => {
		ok(pictureLine(at({ atSec: 600 - CARRY_MAX_SEC }), 600) !== null)
		strictEqual(pictureLine(at({ atSec: 600 - CARRY_MAX_SEC - 0.001 }), 600), null)
	})

	/**
	 * NO THIRD PERSON, IN EITHER TENSE — the defect that produced three false lines in one game.
	 *
	 * The payload addresses him as "you" throughout and names exactly one other person, the enemy
	 * jungler, so a third-person referent here is ambiguous BY CONSTRUCTION and the coach resolved
	 * it the wrong way: at 6:46 "Kayn's been spotted topside" when Kayn was at the dragon pit, at
	 * 15:54 the same inversion, and at 23:01 "take this Baron now while they cannot contest it"
	 * while Kayn was standing in the Baron pit. All three were HIS OWN position, handed to the man
	 * he was racing.
	 *
	 * A word list rather than a phrase check, because the phrase that broke was replaced and the
	 * next one will be different. The accuracy clause was the last survivor — "right about the
	 * player's own half" is not a pronoun and is still a second party in a one-party sentence.
	 */
	it("contains no third-person word in either tense", () => {
		const third = /\b(he|him|his|she|her|hers|they|them|their|theirs|its|the player'?s?)\b/i
		for (const [why, ageSec] of [
			["fresh", 3],
			["carried", CARRY_MAX_SEC - 1]
		] as const) {
			const line = pictureLine(at({ atSec: 600 - ageSec }), 600)
			ok(line !== null, why)
			const hit = third.exec(line)
			strictEqual(hit, null, `${why}: "${hit?.[0]}" in ${line}`)
		}
	})
})

/**
 * THE ROLLING LAST-KNOWN READ — structural problem A, and the two halves of the fix.
 *
 * 42% of the event-driven turns on the graded run of game 5639406342 were REACTIVE — a death, a
 * respawn, `resource.low` — and a reactive turn skips the 1.3-3.0s minimap call on purpose, because
 * a death's premise is 40% stale at one second. The consequence was that the position reached the
 * model on 7 of 23 turns and was absent on precisely the turns where where-he-is decides the
 * sentence. The fix is not a read on every turn; it is the last accepted read, carried, with its
 * age, in the past tense.
 */
describe("carrying the last read forward", () => {
	const obs = (over: Partial<FrameObservation>): FrameObservation => ({
		where: "topside",
		atSec: 597,
		confidence: "medium",
		...over
	})
	const zone: { you: Zone; enemies: Zone[] } = { you: "OWN_JUNGLE_TOP", enemies: [] }

	it("remembers a read that placed him and doubts nothing", () => {
		ok(carryable(obs({}), zone))
	})

	it("refuses to remember a doubt", () => {
		// Neither of these is a position, and a doubt carried forward is a doubt laundered into a
		// fact on the next turn, when the reason to doubt it has aged out of view.
		ok(!carryable(obs({ where: null }), zone), "the reader declined to place him")
		ok(!carryable(obs({ confidence: "low" }), zone), "two consecutive looks disagreed")
		ok(!carryable(obs({}), null), "placed, but the zone was lost at the door")
	})

	/**
	 * A REFUSED READ MUST NOT CLEAR WHAT IS CARRIED, and that is asserted against the SOURCE.
	 *
	 * The behaviour lives in module-level state behind a handler that calls `lcu()`, and nothing in
	 * this suite may talk to the running client — the same reason `forgetting a game` below is a
	 * structural test. The invariant is narrow enough to state exactly: `carriedRead` is assigned in
	 * `landRead` (an acceptance) and in `resetFrameState` (a new game), and nowhere else. Every
	 * refusal branch sets `frameRead = null` beside it and must leave the carried read alone —
	 * 44% of reads on the graded game were refused, and a refusal is not evidence about where he was
	 * eleven seconds ago.
	 */
	it("is written only by an acceptance and by the end of a game", () => {
		const source = readFileSync(new URL("./live.ts", import.meta.url), "utf8")
		const lines = source.split("\n")
		const writes = lines
			.map((l, i) => ({ l, i }))
			.filter(x => /^\s*carried(Read|Zone)\s*=/.test(x.l))
		ok(writes.length === 4, `expected two writes each in landRead and resetFrameState, got ${writes.length}`)
		for (const w of writes) {
			const before = lines.slice(Math.max(0, w.i - 12), w.i).join("\n")
			ok(
				/const landRead = |const resetFrameState = /.test(before),
				`the write at line ${w.i + 1} is outside landRead/resetFrameState — see the comment on carriedRead`
			)
		}
		// And the refusal branches: every one of them nulls the ranker's read and none of them
		// touches the brief's.
		const refusals = lines
			.map((l, i) => ({ l, i }))
			.filter(x => /^\s*frameRead = null$/.test(x.l))
			// `resetFrameState` nulls it too, and there it is correct: a new game forgets everything.
			.filter(x => !/const resetFrameState = /.test(lines.slice(Math.max(0, x.i - 4), x.i).join("\n")))
		ok(refusals.length >= 3, `expected the handler's refusal branches, found ${refusals.length}`)
		for (const m of refusals) {
			const window = lines.slice(m.i, m.i + 3).join("\n")
			ok(!/carried(Read|Zone) = null/.test(window), `the refusal at line ${m.i + 1} clears the carried read`)
		}
	})
})

describe("pictureFix — the read as DATA, for the prospective joins", () => {
	const obs = (over: Partial<FrameObservation>): FrameObservation => ({
		where: "topside",
		atSec: 597,
		confidence: "medium",
		...over
	})
	/*
	 * The read's own zones, blue-relative as the reader answers them. `pictureFix` is what turns
	 * them into a sentence, and that is where the team flip happens — see `zoneLabelForTeam`.
	 */
	const zone: { you: Zone; enemies: Zone[] } = { you: "OWN_JUNGLE_TOP", enemies: ["RIVER_BOT"] }

	it("hands NEXT the position as a value, not as prose", () => {
		const fix = pictureFix(obs({}), zone, 600, TEAM_BLUE)
		ok(fix !== null)
		strictEqual(fix.coarse, "topside")
		strictEqual(fix.label, "own blue-side jungle (top)")
		// The clock of the PICTURE, so `prospectHead` can age it. Passing `now` here would render
		// every read as 0s old, which is the exact lie `FRAME_FRESH_SEC` exists to prevent.
		strictEqual(fix.atSec, 597)
		deepStrictEqual(fix.enemies, ["river (bot)"])
	})

	/*
	 * THE INVERSION. `zoneLabel` is blue-absolute by design, and the route minted the label with no
	 * team id at all — so on a red-side game `You: blue-side jungle (top)` described a man standing
	 * in the ENEMY jungle, and nothing in the payload resolved it: the delta carries no team side and
	 * the full brief says only `side ORDER`/`side CHAOS` with no ORDER-is-blue mapping anywhere.
	 * `forTeam`'s own docstring says the flip "happens exactly once, here, where his team id is known
	 * from the client"; it never happened.
	 */
	it("flips ownership for a red-side game, keeping the absolute side", () => {
		const fix = pictureFix(obs({}), zone, 600, TEAM_RED)
		ok(fix !== null)
		strictEqual(fix.label, "enemy blue-side jungle (top)")
		deepStrictEqual(fix.enemies, ["river (bot)"])
	})

	it("is absent whenever the prose is absent, on every one of the prose's own rules", () => {
		/*
		 * The failure this pins is the worst shape available here: NOW declining to say where he is
		 * while NEXT confidently joins an objective to a position. Two gates over one read is two
		 * places to drift, so `pictureFix` asks `pictureLine` rather than re-deciding.
		 */
		for (const [why, o] of [
			["no read", null],
			["unplaced", obs({ where: null })],
			["two looks disagreed", obs({ confidence: "low" })],
			["past the carry window", obs({ atSec: 600 - CARRY_MAX_SEC - 1 })],
			["stamped in the future", obs({ atSec: 620 })]
		] as const) {
			strictEqual(pictureLine(o, 600), null, `${why}: prose`)
			strictEqual(pictureFix(o, zone, 600, TEAM_BLUE), null, `${why}: fix`)
		}
	})

	it("says nothing when the read placed him but the zone was lost", () => {
		// A label that survived a refused read would put last minute's position in this minute's
		// brief, which is worse than silence because it is specific.
		strictEqual(pictureFix(obs({}), null, 600, TEAM_BLUE), null)
	})
})

describe("the brief actually receives the position", () => {
	it("prints the position clause in NEXT instead of declaring it absent", () => {
		/*
		 * The integration this pins is the one that was missing: `buildBrief` has supported `at`
		 * since it was written and the route passed only `where`, so `prospectHead` rendered
		 * "no position read this turn" on every turn of every game while the read sat one field
		 * away. A unit test of either side alone passes with the wire cut.
		 */
		const path = "data/live-samples/js-mtvxb5f4-f81a-t29817812.ndjson"
		if (!existsSync(path)) return
		const line = readFileSync(path, "utf8").split("\n").find(l => l.trim() !== "")
		if (line === undefined) return
		const row = JSON.parse(line) as { gameTime: number; data: unknown }
		const withFix = buildBrief({
			raw: row.data,
			gameTimeSec: row.gameTime,
			at: {
				label: "blue-side jungle (top)",
				coarse: "topside",
				atSec: row.gameTime - 2,
				enemies: []
			}
		})
		const without = buildBrief({ raw: row.data, gameTimeSec: row.gameTime })
		ok(withFix !== null && without !== null)
		ok(without.text.includes("no usable position"), "the unwired payload should say so")
		ok(!withFix.text.includes("no usable position"), withFix.text.slice(0, 400))
		ok(withFix.text.includes("blue-side jungle (top)"), withFix.text.slice(0, 400))
	})
})

/**
 * EVERY branch that ends a game must forget the picture too — checked against the SOURCE.
 *
 * This is a structural assertion rather than a behavioural one, and the reason is that the bug it
 * pins was a reachability bug, not a logic one. The frame-state reset lived inline in
 * `buildLiveState`'s out-of-game branch and was correct there. Then `trusted` — the shipped default
 * — was given its own out-of-game branch in `GET /live/ground-truth` that returns ABOVE
 * `buildLiveState`, so in the shipped app the reset became unreachable: nothing cleared `frameRead`,
 * `lastFrameSide` or `lastTruth` between two games, and `frameZone` was in no reset list at all
 * despite its own doc claiming it is "cleared in lockstep with frameRead".
 *
 * The consequence is a paid model call checked against the wrong game: the first minimap read of
 * game N+1 is fenced by `frameReadFaults` against game N's roster and the response schema offered
 * to the reader enumerates game N's champions. Only `pictureLine`'s `ageSec < 0` guard stops it
 * becoming a spoken claim.
 *
 * Driving the real route would mean calling `lcu()`, which talks to the running League client, and
 * nothing in this suite may do that. So the invariant is asserted where it actually lives: the two
 * kinds of "this game is over" reset are written next to each other, and a third branch that
 * forgets one of them fails here.
 */
describe("forgetting a game", () => {
	const source = readFileSync(new URL("./live.ts", import.meta.url), "utf8")

	it("clears every piece of frame state in one place", () => {
		const body = /const resetFrameState = \(\): void => \{([^}]*)\}/.exec(source)?.[1] ?? ""
		for (const field of [
			"frameRead",
			"frameZone",
			"carriedRead",
			"carriedZone",
			"lastFrameSide",
			"lastTruth"
		])
			ok(new RegExp(`\\b${field}\\s*=\\s*null`).test(body), `${field} is not cleared by resetFrameState`)
	})

	it("calls it from every branch that resets the coach's other memories", () => {
		/*
		 * The two markers are the two ways a game ends in this file: `buildLiveState`'s torn/absent
		 * payload branch, and the `trusted` branch's own. Each is asserted to reset the picture
		 * within a few lines of resetting the facts — close enough that a new branch copying one of
		 * them copies both.
		 */
		const lines = source.split("\n")
		const markers = lines
			.map((l, i) => ({ l, i }))
			.filter(x => /resetFactMemory\(factMemory\)|coachMemory = newMemory\(\)/.test(x.l))
		ok(markers.length >= 2, `expected both end-of-game resets, found ${markers.length}`)
		for (const m of markers) {
			const window = lines.slice(m.i, m.i + 20).join("\n")
			ok(
				/resetFrameState\(\)/.test(window),
				`the reset at line ${m.i + 1} forgets the picture — see the comment on resetFrameState`
			)
		}
	})
})
