/**
 * ADJUDICATE — settle the two judges against the exact record, with no third model.
 *
 * ## The dispute
 *
 * The same 58 sentences the shipped socket coach spoke in games 5639406342 (Lillia into Kayn) and
 * 5639409343 (Lillia into Fiddlesticks) were graded TWICE by the same judge model, blinded both
 * times, varying exactly one thing — whether the judge was also shown the journal frame for that
 * turn (`data/eval/judge-sees-the-frame-20260911.json`):
 *
 *     without the picture   useful 67% [54-78]   false 22% [14-35]
 *     with the picture      useful 34% [24-47]   false 55% [42-67]
 *     paired, n = 58, McNemar exact p = 2.1e-05 on both axes. EIGHTEEN lines the with-frame judge
 *     called false, the same judge called useful without it. One moved the other way.
 *
 * The with-frame judge's extra verdict is `contradicted-by-picture`, and it reaches that by reading
 * POSITIONS off a downscaled screenshot — the one channel this repo has measured and refuted
 * (`scripts/probe-minimap.ts`: a median 43% of map width from truth, self-consistent 5 times in 60).
 * So the judge that produced the worse number may itself be the unreliable instrument, and no
 * fourth model can break the tie, because every model in this argument is reading the same picture.
 *
 * ## Why this file needs no judge at all
 *
 * The disagreement is almost entirely about POSITION, and the exact positions are on disk.
 * `data/blobs/<gameId>/timeline.json.gz` samples every participant's x,y once per minute and
 * `src/shared/map.ts` turns those into zones. `data/live-samples/<window>.ndjson` carries the raw
 * `allgamedata` every five seconds of game clock — exact HP, mana, gold, items, levels, deaths,
 * respawn timers and the event feed, for a channel the coach cannot lie about.
 *
 * So every claim is checked against the RECORD, and the two judges are then scored against that.
 *
 * ## The three verdicts, and why the third one is the point
 *
 *   VERIFIED      the exact record entails the claim.
 *   CONTRADICTED  the exact record excludes it.
 *   UNDECIDABLE   the record neither entails nor excludes it — most often because the claim falls
 *                 BETWEEN two one-minute position frames.
 *
 * The third bucket is not a failure of this script, it is the measurement this app already made:
 * the median displacement between consecutive frames is 4082 units, 28% of the map, and linear
 * interpolation still lands a median 1452 units from the truth (`src/analysis/frames.ts`). A
 * position claim at 30 seconds past a frame is a claim about a disc, not a point, and saying so is
 * the whole reason this repo hedges. Any number this file reports about the judges therefore
 * carries an irreducible undecidable share, and that share is printed beside every rate.
 *
 * ## How a position claim is decided — the kinematic bound
 *
 * `whereCouldBe(pid, t)` returns the SET of map points the player could possibly have occupied at
 * `t`, as a 250-unit grid. A point survives only if it satisfies EVERY anchor:
 *
 *     dist(point, anchor.pos) <= anchor.radius + FLASH_SLACK + speed * |t - anchor.atSec|
 *
 * An anchor is anything the record pins to a place at a time:
 *
 *   - every one-minute timeline participant frame        radius 0     (exact, all ten players)
 *   - `CHAMPION_KILL.position` for the victim            radius 0     (he died exactly there)
 *   - the same event for the killer                      radius 1400  (in range of the kill)
 *   - the same event for each assister                   radius 2200  (champion-kill assists only;
 *                                                                      the objective ones are 19%
 *                                                                      cross-team corrupt)
 *   - `ELITE_MONSTER_KILL.position` for the killer       radius 1300  (smite range of the pit)
 *   - `BUILDING_KILL.position` for the killer            radius 1600
 *   - his own respawns, from the 5s feed                 own fountain (dead -> he IS the fountain)
 *   - his own SHOP VISITS, from the 5s feed              own fountain (the item list gained an
 *                                                                      entry, so he stood at the
 *                                                                      shop inside that 5s window)
 *
 * The speed is his own instantaneous `championStats.moveSpeed` from the feed — `reachability.ts`
 * establishes that League's move speed is units per second and that straight-line displacement over
 * `gap * moveSpeed` peaked at 1.14 across 39 read-pairs, so the bound is inflated by
 * `SPEED_SLACK = 1.2` and a flat `FLASH_SLACK` of 500 units for a blink. The enemy has no feed
 * speed, so he gets a deliberately generous flat `FOE_SPEED`.
 *
 * A predicate ("he is topside", "he is in the river", "he is within a screen of Syndra") is then
 * evaluated over the whole surviving set. All points agree -> VERIFIED. No point agrees ->
 * CONTRADICTED. Otherwise UNDECIDABLE, and the fraction of the set that agrees is printed so a
 * reader can see how close the call was.
 *
 * ## The one assumption, stated rather than hidden
 *
 * The bound assumes no UNOBSERVED recall. A recall that bought something is anchored at the
 * fountain by the item feed; a recall that bought nothing is invisible and would let him cross the
 * map faster than the bound allows. That can only make a CONTRADICTED verdict too confident, never
 * an UNDECIDABLE one, so every contradicted position claim prints the anchors that produced it.
 *
 * ## What is NOT judged here
 *
 * Imperatives. "Back off", "path topside", "secure the drake" are the model's DECISION and this
 * file has no opinion about them — it extracts only the factual clauses a sentence asserts or
 * presupposes. Lines whose every clause is an instruction come back with no claims, and are
 * reported as their own bucket rather than folded into either side.
 *
 * ## CORRECTED 2026-09-12: this file had the inversion too, and finding 1 below was wrong
 *
 * `other.dead.timer` matched an ELAPSED claim ("Kayn is down for thirty-seven seconds") and checked
 * it against `respawnTimer`, which is what is LEFT. Six claims were certified VERIFIED that way,
 * five of them by a margin the corrected reading convicts outright — at 20:53 Kayn had been down
 * three seconds, not thirty-seven. The elapsed half is knowable and exact: `CHAMPION_KILL` in the
 * post-game timeline states the instant of every death, so elapsed is `now - that instant`.
 *
 * That matters far beyond one check. This is the record every judge in this repo is scored against,
 * so while it was inverted it CERTIFIED the exact error a judge was being blamed for missing, and
 * scored any judge that caught the inversion as wrong for catching it. The two errors — a judge
 * that misses it, a record that blesses it — cancel, which is why the total looked accurate.
 *
 * Re-run on the same inputs, the record moves from **47 VERIFIED / 0 CONTRADICTED** to **42 / 5**,
 * and the no-frame judge's agreement with it moves from 39/47 (83% [70-91]) to 34/47 (72% [58-83]).
 * The stored 2026-09-11 file is untouched; the corrected run is beside it. Findings 1 and 2 below
 * are kept AS THEY WERE WRITTEN, because a corrected measurement means nothing without the number
 * it corrects, and the correction is stated at the top of each.
 *
 * ## What it found, 2026-09-11 (`data/eval/adjudicate-20260911.json`)
 *
 * 100 claims came out of the 58 lines — 92 off the feed and the event log, 8 about position. Two
 * lines assert nothing checkable at all.
 *
 *  1. **WRONG, see the correction above — the record contradicts five of them.** As written:
 *     **THE RECORD CONTRADICTS NOTHING THE COACH SAID.** 47 lines VERIFIED, 0 CONTRADICTED, 9
 *     UNDECIDABLE, 2 NO-CLAIM. Every death timer, respawn count, gold figure, item, level
 *     comparison, objective timer and kill attribution checked out — 87 verified feed and event
 *     claims against none contradicted. Read "low" and "full" against the app's OWN bands instead
 *     of the generous doubled ones and five lines contradict (9% [4-19]), all five of them the same
 *     failure: calling him low at 35%, 41% and 57% HP. So the coach's false rate on this corpus is
 *     somewhere in 0-9%, against the 22% the no-frame judge gave it and the 55% the with-frame
 *     judge gave it. BOTH JUDGES OVERCOUNT; one of them overcounts by a factor of six.
 *
 *  2. **Its 83% is a 72% under the corrected record; the ORDERING it establishes survives.** As
 *     written: **OF THE EIGHTEEN LINES THAT FLIPPED, THE RECORD CALLS NONE OF THEM FALSE.** Fifteen are
 *     fine (83% [61-94]) and three cannot be settled. The one line that flipped the other way is
 *     fine too. Scored on the 47 lines the record can settle, the no-frame judge is right 39 times
 *     (83% [70-91]) and the with-frame judge 24 (51% [37-65]); paired, 16 lines the no-frame judge
 *     alone got right against 1 the other way, McNemar exact p = 0.000275. Under the strict reading
 *     — the one most favourable to the with-frame judge — it is 81% against 56%. THE NO-FRAME JUDGE
 *     IS THE BETTER INSTRUMENT, and the 34%/55% figure should not be propagated.
 *
 *  3. **THE WITH-FRAME JUDGE MOSTLY STOPPED GRADING CLAIMS.** Its reason on 17 of the lines it
 *     called false is "he's mid-fight", i.e. the ADVICE was infeasible, not that anything asserted
 *     was untrue — and `blind-judge.ts` defines `false` as contradicting the block or asserting
 *     something unknown, not as bad advice. Checked against his own HP trace and the kill log, that
 *     assertion is right 10 times, WRONG 4 (24% [10-47]) and unsettleable 3.
 *
 *  4. **ITS POSITION READS ARE A COIN FLIP, ON THE THREE IT STATED OUTRIGHT.** "Minimap shows her
 *     near bottom" at 8:42 agrees with the record (he is bot at both 8:00 and 9:00). "Minimap shows
 *     player far bottom-side" at 14:30 DISAGREES: the exact frames put him in his own topside
 *     jungle at 14:00 and further topside at 15:00, and the line it condemned told him to keep
 *     heading top. The third splits. n = 3, so this is consistent with the 43%-error measurement
 *     rather than a replication of it.
 *
 *  5. **NOT ONE OF THE 58 BLOCKS CARRIED HIS POSITION.** Every payload says WHERE YOU ARE IS NOT IN
 *     THIS PAYLOAD, so every position claim the coach made came from the picture or from nowhere —
 *     and at the guess tier three of them ("you're level 5 in the river", "you're already mid lane",
 *     "Great back") are LIKELY-FALSE. Position is the coach's worst channel and the block gives it
 *     nothing.
 *
 *  6. **THE IRREDUCIBLE SHARE IS 19% [11-31] OF LINES, AND IT IS THE FRAME INTERVAL.** Eleven of 58
 *     lines cannot be settled either way; six of the eight position claims are among them. A
 *     tighter movement bound resolves only ONE of those six, so the uncertainty is the one-minute
 *     sampling interval itself, not this file being cautious. Every rate above should be read with
 *     that width attached.
 *
 * ## What the corrected record says about the JUDGE, 2026-09-12
 *
 * `--noframe <judge-corpus output>` scores any no-frame judge against this record. Run over the
 * same 47 decidable lines, with the elapsed clock read the right way round:
 *
 *     the stored 2026-09-11 judge          34/47  72% [58-83]
 *     + champion notes + death-clock rule  37/47  79% [65-88]   paired +6/-3, McNemar p = 0.51
 *     + the rule scoped to death clocks    42/47  89% [77-95]   paired +10/-2, McNemar p = 0.039
 *
 * Two things have to be said about that last row or it reads as stronger than it is. The scoping
 * sentence was written after watching the middle row move three POSITION lines to "false" on this
 * same corpus, so its 89% is a repair selected on the data it is scored against and is not an
 * independent test. And against the record AS IT STOOD — the inverted one — the same judge scores
 * 79% against the stored judge's 83%, i.e. it looks slightly WORSE. That is the whole shape of this
 * problem: a judge that misses the inversion and a record that blesses it agree with each other,
 * and fixing only one of them makes the pair look further apart.
 *
 * Under the corrected record the fixed judge convicts all five inversions; the stored judge called
 * every one of them USEFUL.
 *
 * ## Usage
 *
 *     node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *       scripts/adjudicate.ts
 *
 *     --lines <path>   the 58 socket records (default data/eval/integrate-socket-both-asrecords.json)
 *     --judges <path>  the paired judge file  (default data/eval/judge-sees-the-frame-20260911.json)
 *     --noframe <path> a `scripts/judge-corpus.ts` output whose verdicts REPLACE the no-frame side
 *                      of that pairing, joined on (windowId, clock). How a changed judge is scored
 *                      against the record without a second copy of this file.
 *     --out <path>     where the adjudication goes (default data/eval/adjudicate-<stamp>.json)
 *     --verbose        print every claim of every line, not just the summary
 *
 * Reads only. No network, no model, no LCU, and the database is opened READ-ONLY.
 * NODE ONLY.
 */

import { DatabaseSync } from "node:sqlite"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DATA_DIR } from "../src/shared/constants.ts"
import { readBlob, BLOB_TIMELINE } from "../src/db/blobs.ts"
import { buildTruth, seatsOf, truthEvents } from "../src/analysis/game-truth.ts"
import type { TruthEvent, TruthFrame, TruthSeat } from "../src/analysis/game-truth.ts"
import { mcnemarExact } from "./lib/stats.ts"
import { wilson } from "../src/analysis/coach-score.ts"
import type { Interval } from "../src/analysis/coach-score.ts"
import { dist, NEXUS, PITS, TURRETS, classifyZone, quadrantOf, zoneOf } from "../src/shared/map.ts"
import type { Pos, TeamId, Zone } from "../src/shared/map.ts"
import { MAP } from "../src/shared/constants.ts"
import { HP_LOW_BAND, MANA_LOW_BAND } from "../src/shared/live-brief.ts"
import {
	BARON_RESPAWN_SEC,
	BARON_SPAWN_SEC,
	DRAKE_FIRST_SPAWN_SEC,
	DRAKE_RESPAWN_SEC,
	GRUBS_SPAWN_SEC,
	HERALD_SPAWN_SEC
} from "../src/analysis/live-events.ts"
import { fmtClock } from "../src/shared/time.ts"

/* ================================================================== arguments */

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : fallback
}
const has = (name: string): boolean => argv.includes(`--${name}`)

const LINES_PATH = arg("lines", `${DATA_DIR}/eval/integrate-socket-both-asrecords.json`)
const JUDGES_PATH = arg("judges", `${DATA_DIR}/eval/judge-sees-the-frame-20260911.json`)
/*
 * SCORE A DIFFERENT NO-FRAME JUDGE against the same record, without a second copy of this file.
 *
 * `--noframe <judge-corpus output>` swaps the no-frame side of the pairing for the verdicts in a
 * `scripts/judge-corpus.ts` output, joined on (windowId, clock) — the key that file already
 * carries. That is the whole point of the comparison this script exists for: the judge is the
 * instrument every rate in this repo rests on, so "did the change make it agree with the record
 * more often" has to be a command, not an afternoon of joining JSON by hand.
 *
 * The with-frame side is untouched, so the paired McNemar below still compares the same two
 * populations it always did.
 */
const NOFRAME_PATH = arg("noframe", "")
const STAMP = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)
const OUT_PATH = arg("out", `${DATA_DIR}/eval/adjudicate-${STAMP}.json`)
const VERBOSE = has("verbose")

/* ============================================================ the bound's constants */

/** Grid resolution of the reachable set, in game units. The map spans 14,990. */
export const GRID_UNITS = 250
/** `reachability.ts`: displacement over `gap * moveSpeed` peaked at 1.14 across 39 read-pairs. */
export const SPEED_SLACK = 1.2
/** A Flash is instantaneous and about 400 units. Granted free to every anchor. */
export const FLASH_SLACK = 500
/** The enemy has no feed speed. Deliberately generous — it can only widen the undecidable bucket. */
export const FOE_SPEED = 600
/** Floor under his own feed speed, for the frames where the client reports 0 (loading, dead). */
export const MIN_SPEED = 340
/** In range of the champion he killed. */
export const KILLER_RADIUS = 1400
/** In range of a kill he assisted. Champion kills only — objective assist lists are corrupt. */
export const ASSIST_RADIUS = 2200
/** Smite range of the pit. */
export const MONSTER_KILLER_RADIUS = 1300
export const BUILDING_KILLER_RADIUS = 1600
/** Roughly a League camera: what "on screen with" and "near" mean here. */
export const SCREEN_RADIUS = 2400
/** "at the top tower" — how close counts as at a structure. */
export const AT_STRUCTURE_RADIUS = 1800
/**
 * "Low" and "full" are VAGUE, and a vague predicate near its boundary is not a false statement.
 * So each resource predicate gets three bands, not two: at or under the app's own LOW band it is
 * VERIFIED, above DOUBLE that band it is CONTRADICTED, and in between it is UNDECIDABLE and says
 * so. The doubling is deliberately generous — the direction to be wrong in is the one that
 * refuses to manufacture a contradiction out of a threshold somebody picked. The strict verdict
 * against the app's own band is printed in the evidence either way, so a reader can have both.
 */
export const VAGUENESS_MULTIPLE = 2
/** "Full" at 90% is full. Set below any plausible rounding edge for the same reason. */
export const FULL_BAND = 0.85

/* ================================================================ the inputs */

interface LineRecord {
	arm: string
	windowId: string
	atSec: number
	clock: string
	text: string
	payload: string
}

interface JudgeVerdict {
	verdict: "false" | "unverifiable" | "generic" | "useful"
	framePower?: string
	why: string
}

interface JudgeLine {
	gameId: string
	clock: string
	text: string
	withFrame: JudgeVerdict
	noFrame: JudgeVerdict
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T

/* ============================================================== ground truth */

/** One 5-second `allgamedata` sample, reduced to the fields a claim can be checked against. */
interface Sample {
	atSec: number
	hp: number
	maxHp: number
	mana: number
	maxMana: number
	gold: number
	moveSpeed: number
	/** Every player in the lobby, by champion name. */
	players: Record<
		string,
		{
			champion: string
			team: "his" | "enemy"
			level: number
			dead: boolean
			respawn: number
			items: string[]
			kills: number
			deaths: number
			assists: number
			cs: number
		}
	>
}

interface Anchor {
	atSec: number
	pos: Pos
	radius: number
	why: string
}

interface GameTruth {
	gameId: number
	windowId: string
	seats: TruthSeat[]
	frames: TruthFrame[]
	events: TruthEvent[]
	samples: Sample[]
	me: TruthSeat
	foe: TruthSeat
	myTeam: TeamId
	anchors: Record<number, Anchor[]>
	champToPid: Record<string, number>
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "")

const loadSamples = (windowId: string): Sample[] => {
	const path = `${DATA_DIR}/live-samples/${windowId}.ndjson`
	const out: Sample[] = []
	for (const raw of readFileSync(path, "utf8").split("\n")) {
		if (!raw.trim()) continue
		const rec = JSON.parse(raw) as {
			gameTime: number
			data: {
				activePlayer?: {
					championStats?: Record<string, number>
					currentGold?: number
					summonerName?: string
				}
				allPlayers?: {
					championName: string
					level: number
					isDead: boolean
					respawnTimer: number
					items?: { displayName?: string }[]
					summonerName?: string
					team?: string
					scores?: { kills: number; deaths: number; assists: number; creepScore: number }
				}[]
			}
		}
		const ap = rec.data.activePlayer
		const stats = ap?.championStats ?? {}
		const meName = ap?.summonerName ?? ""
		const players: Sample["players"] = {}
		const mine = (rec.data.allPlayers ?? []).find(p => p.summonerName === meName)
		const myTeamStr = mine?.team
		for (const p of rec.data.allPlayers ?? [])
			players[p.championName] = {
				champion: p.championName,
				team: p.team === myTeamStr ? "his" : "enemy",
				level: p.level,
				dead: p.isDead,
				respawn: p.respawnTimer,
				items: (p.items ?? []).map(i => i.displayName ?? ""),
				kills: p.scores?.kills ?? 0,
				deaths: p.scores?.deaths ?? 0,
				assists: p.scores?.assists ?? 0,
				cs: p.scores?.creepScore ?? 0
			}
		out.push({
			atSec: rec.gameTime,
			hp: stats.currentHealth ?? 0,
			maxHp: stats.maxHealth ?? 0,
			mana: stats.resourceValue ?? 0,
			maxMana: stats.resourceMax ?? 0,
			gold: ap?.currentGold ?? 0,
			moveSpeed: stats.moveSpeed ?? 0,
			players
		})
	}
	return out.sort((a, b) => a.atSec - b.atSec)
}

/** The sample nearest `atSec`, and how far it was. The feed lands every ~5s of game clock. */
const sampleAt = (g: GameTruth, atSec: number): { s: Sample; gapSec: number } | null => {
	let best: Sample | null = null
	let gap = Infinity
	for (const s of g.samples) {
		const d = Math.abs(s.atSec - atSec)
		if (d < gap) {
			gap = d
			best = s
		}
	}
	return best && gap <= 8 ? { s: best, gapSec: Math.round(gap * 10) / 10 } : null
}

const buildAnchors = (
	seats: readonly TruthSeat[],
	frames: readonly TruthFrame[],
	events: readonly TruthEvent[],
	samples: readonly Sample[],
	me: TruthSeat
): Record<number, Anchor[]> => {
	const out: Record<number, Anchor[]> = {}
	const push = (pid: number, a: Anchor): void => {
		;(out[pid] ??= []).push(a)
	}
	for (const seat of seats) out[seat.participantId] = []

	for (const f of frames)
		for (const seat of seats) {
			const row = f.seats[seat.participantId]
			if (row) push(seat.participantId, { atSec: f.atSec, pos: row.pos, radius: 0, why: `timeline frame ${f.clock}` })
		}

	for (const e of events) {
		if (!e.pos) continue
		if (e.kind === "kill") {
			if (e.victim) push(e.victim.participantId, { atSec: e.atSec, pos: e.pos, radius: 0, why: `died at ${e.clock}` })
			if (e.killer)
				push(e.killer.participantId, {
					atSec: e.atSec,
					pos: e.pos,
					radius: KILLER_RADIUS,
					why: `killed ${e.victim?.championName ?? "someone"} at ${e.clock}`
				})
			for (const a of e.assists)
				push(a.participantId, {
					atSec: e.atSec,
					pos: e.pos,
					radius: ASSIST_RADIUS,
					why: `assisted a kill at ${e.clock}`
				})
		} else if (e.kind === "objective" && e.killer)
			push(e.killer.participantId, {
				atSec: e.atSec,
				pos: e.pos,
				radius: MONSTER_KILLER_RADIUS,
				why: `took ${e.monsterName ?? e.monsterType} at ${e.clock}`
			})
		else if (e.kind === "building" && e.killer)
			push(e.killer.participantId, {
				atSec: e.atSec,
				pos: e.pos,
				radius: BUILDING_KILLER_RADIUS,
				why: `took a ${e.towerType ?? e.buildingType} at ${e.clock}`
			})
	}

	/* His own fountain: every respawn, and every visit to the shop the item feed betrays. */
	const fountain = NEXUS[me.teamId as TeamId]
	let prevDead = false
	let prevItems = ""
	for (const s of samples) {
		const mine = s.players[me.championName]
		if (!mine) continue
		if (mine.dead) {
			push(me.participantId, { atSec: s.atSec, pos: fountain, radius: MAP.baseRadius, why: `dead at ${fmtClock(s.atSec)}` })
			prevDead = true
		} else {
			if (prevDead)
				push(me.participantId, {
					atSec: s.atSec,
					pos: fountain,
					radius: MAP.baseRadius,
					why: `respawned by ${fmtClock(s.atSec)}`
				})
			prevDead = false
		}
		const items = mine.items.join("|")
		if (prevItems !== "" && items !== prevItems && mine.items.length >= prevItems.split("|").length)
			push(me.participantId, {
				atSec: s.atSec,
				pos: fountain,
				radius: MAP.baseRadius + 5 * MIN_SPEED,
				why: `bought something by ${fmtClock(s.atSec)}`
			})
		prevItems = items
	}

	for (const pid of Object.keys(out)) out[Number(pid)]!.sort((a, b) => a.atSec - b.atSec)
	return out
}

const loadGame = (windowId: string, gameId: number, db: DatabaseSync): GameTruth => {
	const rows = db
		.prepare(
			"SELECT participantId, teamId, riotId, championName, role, isUser FROM participant WHERE gameId = ? ORDER BY participantId"
		)
		.all(gameId) as {
		participantId: number
		teamId: number
		riotId: string
		championName: string
		role: string
		isUser: number
	}[]
	const seats = seatsOf(rows)
	const timeline = readBlob(gameId, BLOB_TIMELINE)
	const frames = buildTruth(timeline as never, seats)
	const events = truthEvents(timeline as never, seats)
	const samples = loadSamples(windowId)
	const me = seats.find(s => s.isUser)!
	const foe = seats.find(s => s.side === "enemy" && s.role === "JGL") ?? seats.find(s => s.side === "enemy")!
	const champToPid: Record<string, number> = {}
	for (const s of seats) champToPid[norm(s.championName)] = s.participantId
	const g: GameTruth = {
		gameId,
		windowId,
		seats,
		frames,
		events,
		samples,
		me,
		foe,
		myTeam: me.teamId as TeamId,
		anchors: buildAnchors(seats, frames, events, samples, me),
		champToPid
	}
	return g
}

/* ========================================================== the reachable set */

interface Region {
	pts: Pos[]
	/** The anchors that actually bound it, nearest in time first. */
	bounds: { why: string; allowedUnits: number }[]
	/** Bounding-box diagonal as a fraction of map width — how tight the record is at this instant. */
	spanFrac: number
	dead: boolean
}

const speedFor = (g: GameTruth, pid: number, atSec: number): number => {
	if (pid !== g.me.participantId) return FOE_SPEED * SPEED_SLACK
	/* The fastest he was observed moving anywhere near this instant, so the bound never understates. */
	let top = MIN_SPEED
	for (const s of g.samples)
		if (Math.abs(s.atSec - atSec) <= 90 && s.moveSpeed > top) top = s.moveSpeed
	return top * SPEED_SLACK
}

const gridPoints = ((): Pos[] => {
	const pts: Pos[] = []
	for (let x = MAP.minX; x <= MAP.maxX; x += GRID_UNITS)
		for (let y = MAP.minY; y <= MAP.maxY; y += GRID_UNITS) pts.push({ x, y })
	return pts
})()

/** Every map point the record still allows this player to occupy at `atSec`. */
export const whereCouldBe = (
	g: GameTruth,
	pid: number,
	atSec: number,
	bound: { speedMul: number; slack: number } = { speedMul: 1, slack: FLASH_SLACK }
): Region => {
	const anchors = g.anchors[pid] ?? []
	const v = speedFor(g, pid, atSec) * bound.speedMul
	const dead =
		pid === g.me.participantId ?
			(sampleAt(g, atSec)?.s.players[g.me.championName]?.dead ?? false)
		:	(sampleAt(g, atSec)?.s.players[g.seats.find(s => s.participantId === pid)?.championName ?? ""]?.dead ?? false)

	const constraints = anchors.map(a => ({
		a,
		allowed: a.radius + bound.slack + v * Math.abs(atSec - a.atSec)
	}))
	const pts = gridPoints.filter(p => constraints.every(c => dist(p, c.a.pos) <= c.allowed))
	let minX = Infinity
	let maxX = -Infinity
	let minY = Infinity
	let maxY = -Infinity
	for (const p of pts) {
		if (p.x < minX) minX = p.x
		if (p.x > maxX) maxX = p.x
		if (p.y < minY) minY = p.y
		if (p.y > maxY) maxY = p.y
	}
	const span = pts.length === 0 ? 0 : Math.hypot(maxX - minX, maxY - minY) / (MAP.maxX - MAP.minX)
	return {
		pts,
		bounds: constraints
			.slice()
			.sort((x, y) => x.allowed - y.allowed)
			.slice(0, 3)
			.map(c => ({ why: c.a.why, allowedUnits: Math.round(c.allowed) })),
		spanFrac: Math.round(span * 100) / 100,
		dead
	}
}

/* ===================================================================== claims */

type Verdict = "VERIFIED" | "CONTRADICTED" | "UNDECIDABLE"

interface Claim {
	kind: string
	/** The clause of the sentence this came from, quoted. */
	clause: string
	/** `assert` = the sentence states it. `presuppose` = the sentence only works if it is true. */
	mood: "assert" | "presuppose"
	channel: "position" | "feed" | "event" | "schedule"
	verdict: Verdict
	/**
	 * For the VAGUE predicates only ("you are low", "you are full"): the verdict against the app's
	 * OWN band rather than the generous doubled one. Printed so a reader can have the strict
	 * reading without this file having to pick one.
	 */
	strictVerdict?: Verdict
	/** Position claims only: the same claim under a tighter, non-worst-case movement bound. */
	tightVerdict?: Verdict
	/**
	 * Position claims only, and A GUESS: what the two exact frames either side of the instant say.
	 * `src/analysis/frames.ts` measures interpolation at a median 1452 units of error, so this is
	 * `confidence: "low"` by the app's own rule and is never folded into the proven verdict.
	 */
	likelyVerdict?: "LIKELY-TRUE" | "LIKELY-FALSE" | "SPLIT" | "NO-BRACKET"
	evidence: string
}

/**
 * A vague predicate ("you are low") against a band. At or under it, the record agrees. Above a
 * generous multiple of it, the record disagrees. In between the word itself does not decide.
 */
export const vagueBand = (value: number, band: number): Verdict =>
	value <= band ? "VERIFIED"
	: value > band * VAGUENESS_MULTIPLE ? "CONTRADICTED"
	: "UNDECIDABLE"

const verdictOfFraction = (frac: number): Verdict =>
	frac >= 1 ? "VERIFIED"
	: frac <= 0 ? "CONTRADICTED"
	: "UNDECIDABLE"

/** Evaluate a point predicate over a whole reachable set. */
const decideRegion = (r: Region, pred: (p: Pos) => boolean): { verdict: Verdict; frac: number } => {
	if (r.pts.length === 0) return { verdict: "UNDECIDABLE", frac: 0.5 }
	const n = r.pts.filter(pred).length
	const frac = n / r.pts.length
	return { verdict: verdictOfFraction(frac), frac: Math.round(frac * 100) / 100 }
}

const zonesOfRegion = (g: GameTruth, r: Region): string => {
	const counts = new Map<string, number>()
	for (const p of r.pts) {
		const z = zoneOf(p, g.myTeam)
		counts.set(z, (counts.get(z) ?? 0) + 1)
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([z, n]) => `${z} ${Math.round((100 * n) / r.pts.length)}%`)
		.join(", ")
}

/* --------------------------------------------------------------- predicates */

const inZones = (g: GameTruth, zs: readonly Zone[]) => (p: Pos) => zs.includes(classifyZone(p, g.myTeam))
const isTopside = (p: Pos): boolean => quadrantOf(p) === "top"
const isBotside = (p: Pos): boolean => quadrantOf(p) === "bot"
const nearPos = (target: Pos, radius: number) => (p: Pos) => dist(p, target) <= radius
const nearAnyTopTurret = (p: Pos): boolean =>
	[TURRETS.BLUE_TOP_OUTER, TURRETS.BLUE_TOP_INNER, TURRETS.BLUE_TOP_BASE, TURRETS.RED_TOP_OUTER].some(
		t => dist(p, t) <= AT_STRUCTURE_RADIUS
	)

/** Could two players have been within `radius` of each other? All/none/some, over both sets. */
const proximity = (a: Region, b: Region, radius: number): { verdict: Verdict; frac: number } => {
	if (a.pts.length === 0 || b.pts.length === 0) return { verdict: "UNDECIDABLE", frac: 0.5 }
	let min = Infinity
	let max = 0
	for (const p of a.pts)
		for (const q of b.pts) {
			const d = dist(p, q)
			if (d < min) min = d
			if (d > max) max = d
		}
	return {
		verdict:
			max <= radius ? "VERIFIED"
			: min > radius ? "CONTRADICTED"
			: "UNDECIDABLE",
		frac: Math.round((min / radius) * 100) / 100
	}
}

/* ----------------------------------------------------------- feed accessors */

const meAt = (g: GameTruth, atSec: number) => {
	const hit = sampleAt(g, atSec)
	if (!hit) return null
	return { ...hit, mine: hit.s.players[g.me.championName] ?? null }
}

const playerAt = (g: GameTruth, champion: string, atSec: number) => {
	const hit = sampleAt(g, atSec)
	const key = Object.keys(hit?.s.players ?? {}).find(k => norm(k) === norm(champion))
	return hit && key ? { ...hit, p: hit.s.players[key]! } : null
}

/**
 * WHEN he actually died, from the post-game kill log — the elapsed half of a death clock.
 *
 * ## This file had the inversion too, and it blessed six of the coach's
 *
 * `other.dead.timer` matched "X is down for N seconds" — an ELAPSED claim — and checked N against
 * `respawnTimer`, which is what is LEFT. Those are opposite figures. Six claims across the two
 * games were marked VERIFIED that way, including "Kayn is down for thirty-seven seconds" at 20:53
 * against a payload whose only death figure was thirty-seven seconds REMAINING. The record that
 * every judge in this repo is scored against therefore certified the exact error the judge was
 * being blamed for missing, and a judge that caught it was scored WRONG for catching it.
 *
 * The elapsed figure is knowable and it is exact: `CHAMPION_KILL` in the post-game timeline states
 * the instant of every death. So elapsed is `now - that instant`, subject to the player still
 * being down and to no later death having intervened. Nothing here derives one clock from the
 * other — respawn length grows with game time and is a patch value this app may not hardcode.
 */
export const deathInstant = (g: GameTruth, champion: string, atSec: number): number | null => {
	const deaths = g.events.filter(
		e => e.kind === "kill" && e.victim !== null && norm(e.victim.championName) === norm(champion) && e.atSec <= atSec
	)
	return deaths.at(-1)?.atSec ?? null
}

const eventsBetween = (g: GameTruth, fromSec: number, toSec: number): TruthEvent[] =>
	g.events.filter(e => e.atSec >= fromSec && e.atSec <= toSec)

/** Next time the named objective is standing, from the real kill log and this app's own schedule. */
const nextUpSec = (g: GameTruth, kind: "drake" | "baron" | "herald" | "grubs", atSec: number): number | null => {
	const kills = g.events.filter(
		e =>
			e.kind === "objective" &&
			((kind === "drake" && e.monsterType === "DRAGON") ||
				(kind === "baron" && e.monsterType === "BARON_NASHOR") ||
				(kind === "herald" && e.monsterType === "RIFTHERALD") ||
				(kind === "grubs" && e.monsterType === "HORDE"))
	)
	const last = kills.filter(e => e.atSec <= atSec).at(-1)
	if (kind === "drake") return last ? last.atSec + DRAKE_RESPAWN_SEC : DRAKE_FIRST_SPAWN_SEC
	if (kind === "baron") return last ? last.atSec + BARON_RESPAWN_SEC : BARON_SPAWN_SEC
	if (kind === "herald") return last ? null : HERALD_SPAWN_SEC
	/* Grubs come as a wave; once any are taken the rest are standing, not on a timer. */
	return last ? null : GRUBS_SPAWN_SEC
}

/* ================================================= the claim extraction table */

const NUM_WORDS: Record<string, number> = {
	zero: 0,
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12,
	thirteen: 13,
	fourteen: 14,
	fifteen: 15,
	twenty: 20,
	thirty: 30,
	forty: 40,
	fifty: 50,
	sixty: 60
}

/** "forty-five" -> 45, "twelve" -> 12, "1800" -> 1800, "two thousand" -> 2000. */
export const numOf = (raw: string): number | null => {
	const t = raw.trim().toLowerCase()
	if (/^\d+$/.test(t)) return Number(t)
	const thousand = t.match(/^([a-z-]+)\s+thousand$/)
	if (thousand) {
		const n = numOf(thousand[1]!)
		return n === null ? null : n * 1000
	}
	if (t === "thousand") return 1000
	let total = 0
	let seen = false
	for (const part of t.split(/[\s-]+/)) {
		const n = NUM_WORDS[part]
		if (n === undefined) continue
		total += n
		seen = true
	}
	return seen ? total : null
}

interface Ctx {
	g: GameTruth
	atSec: number
	text: string
}

interface Rule {
	kind: string
	channel: Claim["channel"]
	mood: Claim["mood"]
	re: RegExp
	check: (
		m: RegExpMatchArray,
		c: Ctx
	) => { verdict: Verdict; evidence: string; strictVerdict?: Verdict; likelyVerdict?: Claim["likelyVerdict"] } | null
}

const pct = (n: number, d: number): string => (d > 0 ? `${Math.round((100 * n) / d)}%` : "n/a")

/**
 * The bound every position claim is evaluated under. The headline pass uses the WORST case — the
 * fastest he was seen moving anywhere near the instant, inflated 20%, plus a free Flash. The
 * sensitivity pass re-runs the identical extraction under a bound near his typical speed, which is
 * what `reachability.ts` actually validated, so a reader can see how much of the undecidable
 * bucket is irreducible and how much is the worst case being paid for twice.
 */
let BOUND: { speedMul: number; slack: number } = { speedMul: 1, slack: FLASH_SLACK }
export const TIGHT_BOUND = { speedMul: 0.55, slack: 0 }

/**
 * THE SECOND TIER, and it is a GUESS, labelled as one.
 *
 * The kinematic bound above proves things, and over a one-minute frame interval it often proves
 * nothing: a champion at Lillia's peak speed can cross the map and come back inside sixty seconds,
 * so "he could have been anywhere" is frequently the honest proof. That is true and useless on its
 * own, so each position claim also carries what the two BRACKETING frames say — the exact,
 * once-a-minute samples either side of the instant. Both satisfy the claim, both refute it, or they
 * split.
 *
 * This is the app's own interpolation rule (`src/analysis/frames.ts`), and the app's own rule for
 * it applies: median reconstruction error 1452 units, presence detection topping out near 65%
 * sensitivity, `confidence: "low"`. It is reported BESIDE the proof and never instead of it, and
 * every number derived from it is named LIKELY, never VERIFIED.
 */
export const bracketVerdict = (
	g: GameTruth,
	pid: number,
	atSec: number,
	pred: (p: Pos) => boolean
): { likely: "LIKELY-TRUE" | "LIKELY-FALSE" | "SPLIT" | "NO-BRACKET"; evidence: string } => {
	const before = [...g.frames].reverse().find(f => f.atSec <= atSec && f.seats[pid])
	const after = g.frames.find(f => f.atSec >= atSec && f.seats[pid])
	if (!before || !after) return { likely: "NO-BRACKET", evidence: "no frame on one side of this instant" }
	const a = before.seats[pid]!
	const b = after.seats[pid]!
	const oka = pred(a.pos)
	const okb = pred(b.pos)
	const evidence = `the exact frames either side: ${before.clock} in ${a.zone} (${oka ? "satisfies" : "does not satisfy"}), ${after.clock} in ${b.zone} (${okb ? "satisfies" : "does not satisfy"})`
	return {
		likely:
			oka && okb ? "LIKELY-TRUE"
			: !oka && !okb ? "LIKELY-FALSE"
			: "SPLIT",
		evidence
	}
}

const regionVerdict = (
	c: Ctx,
	pid: number,
	pred: (p: Pos) => boolean,
	label: string
): { verdict: Verdict; evidence: string; likelyVerdict?: Claim["likelyVerdict"] } => {
	const r = whereCouldBe(c.g, pid, c.atSec, BOUND)
	if (r.dead) {
		return {
			verdict: pred(NEXUS[c.g.myTeam]) ? "VERIFIED" : "CONTRADICTED",
			evidence: `he was DEAD at ${fmtClock(c.atSec)} — the feed says so exactly; a corpse is at the fountain, not ${label}`
		}
	}
	const d = decideRegion(r, pred)
	const where = zonesOfRegion(c.g, r)
	const bound = r.bounds.map(b => `${b.why} (<=${b.allowedUnits}u)`).join("; ")
	const guess = bracketVerdict(c.g, pid, c.atSec, pred)
	return {
		verdict: d.verdict,
		likelyVerdict: guess.likely,
		evidence: `${label}: ${Math.round(d.frac * 100)}% of the reachable set qualifies. Set spans ${Math.round(r.spanFrac * 100)}% of map width and sits in ${where}. Bound by ${bound}. GUESS TIER (low confidence, median 1452u error): ${guess.likely} — ${guess.evidence}`
	}
}

const RULES: Rule[] = [
	/* ------------------------------------------------------- where HE was */
	{
		kind: "self.position.zone",
		channel: "position",
		mood: "assert",
		/* A copula, not a motion verb: "you're already mid lane" is a claim, "path mid" is an order. */
		re: /\byou(?:'re|\s+are|\s+were)\b(?![^.;]*\b(?:path|head|go|run|get|return|walk|rotate)\b)[^.;]*?\b(?:in|at|on)?\s*(?:the\s+)?(mid lane|top lane|bot lane|river|dragon pit|drake pit|baron pit|top tower|base|fountain|spawn)\b/i,
		check: (m, c) => {
			const what = m[1]!.toLowerCase()
			const preds: Record<string, [(p: Pos) => boolean, string]> = {
				"mid lane": [inZones(c.g, ["LANE_MID"]), "in mid lane"],
				"top lane": [inZones(c.g, ["LANE_TOP"]), "in top lane"],
				"bot lane": [inZones(c.g, ["LANE_BOT"]), "in bot lane"],
				river: [inZones(c.g, ["RIVER_TOP", "RIVER_BOT"]), "in the river"],
				"dragon pit": [nearPos(PITS.DRAGON, MAP.pitRadius), "at the dragon pit"],
				"drake pit": [nearPos(PITS.DRAGON, MAP.pitRadius), "at the dragon pit"],
				"baron pit": [nearPos(PITS.BARON, MAP.pitRadius), "at the baron pit"],
				"top tower": [nearAnyTopTurret, "at a top-lane turret"],
				base: [inZones(c.g, ["OWN_BASE"]), "in his base"],
				fountain: [inZones(c.g, ["OWN_BASE"]), "at his fountain"],
				spawn: [inZones(c.g, ["OWN_BASE"]), "at his spawn"]
			}
			const hit = preds[what]
			return hit ? regionVerdict(c, c.g.me.participantId, hit[0], hit[1]) : null
		}
	},
	{
		kind: "self.position.side",
		channel: "position",
		mood: "presuppose",
		/* "greed for those grubs", "contest this objective", "get out of there" all presuppose he is THERE. */
		re: /\b(?:greed for (?:those|the) (grubs|drake|dragon|baron)|staying here|get out of there|still on screen)\b/i,
		check: (m, c) => {
			const what = (m[1] ?? "").toLowerCase()
			if (what === "grubs") return regionVerdict(c, c.g.me.participantId, nearPos(PITS.GRUBS, 2600), "within a screen of the voidgrub pit")
			if (what === "drake" || what === "dragon")
				return regionVerdict(c, c.g.me.participantId, nearPos(PITS.DRAGON, 2600), "within a screen of the drake pit")
			if (what === "baron") return regionVerdict(c, c.g.me.participantId, nearPos(PITS.BARON, 2600), "within a screen of the baron pit")
			return null
		}
	},
	{
		kind: "foe.position.side",
		channel: "position",
		mood: "assert",
		re: /\b([A-Z][a-zA-Z']+)\s+is\s+(bot|top|botside|topside|bot side|top side|mid)\b/,
		check: (m, c) => {
			const pid = c.g.champToPid[norm(m[1]!)]
			if (pid === undefined) return null
			const side = m[2]!.toLowerCase()
			if (side === "mid") return regionVerdict(c, pid, inZones(c.g, ["LANE_MID"]), `${m[1]} in mid lane`)
			const pred = side.startsWith("bot") ? isBotside : isTopside
			return regionVerdict(c, pid, pred, `${m[1]} on the ${side.startsWith("bot") ? "bot" : "top"} half of the map`)
		}
	},
	{
		kind: "proximity",
		channel: "position",
		mood: "assert",
		re: /\bon screen with ([A-Z][a-zA-Z']+)/,
		check: (m, c) => {
			const pid = c.g.champToPid[norm(m[1]!)]
			if (pid === undefined) return null
			const a = whereCouldBe(c.g, c.g.me.participantId, c.atSec, BOUND)
			const b = whereCouldBe(c.g, pid, c.atSec, BOUND)
			const d = proximity(a, b, SCREEN_RADIUS)
			const bf = [...c.g.frames].reverse().find(f => f.atSec <= c.atSec)
			const af = c.g.frames.find(f => f.atSec >= c.atSec)
			const gap = (f: TruthFrame | undefined): number | null =>
				f && f.seats[c.g.me.participantId] && f.seats[pid] ?
					Math.round(dist(f.seats[c.g.me.participantId]!.pos, f.seats[pid]!.pos))
				:	null
			const gb = gap(bf)
			const ga = gap(af)
			return {
				verdict: d.verdict,
				likelyVerdict:
					gb === null || ga === null ? "NO-BRACKET"
					: gb <= SCREEN_RADIUS && ga <= SCREEN_RADIUS ? "LIKELY-TRUE"
					: gb > SCREEN_RADIUS && ga > SCREEN_RADIUS ? "LIKELY-FALSE"
					: "SPLIT",
				evidence: `could he have been within ${SCREEN_RADIUS}u of ${m[1]} at ${fmtClock(c.atSec)}? his set spans ${Math.round(a.spanFrac * 100)}% of map width, ${m[1]}'s ${Math.round(b.spanFrac * 100)}%; closest possible ${Math.round(d.frac * SCREEN_RADIUS)}u. GUESS TIER: exact frames either side put them ${gb}u apart at ${bf?.clock} and ${ga}u apart at ${af?.clock}`
			}
		}
	},

	/* -------------------------------------------------------- his own bars */
	{
		kind: "self.hp.low",
		channel: "feed",
		mood: "assert",
		re: /\byou(?:'re|\s+are)\s+(?:still\s+|very\s+|extremely\s+|super\s+)?low\b|\b(?:very|extremely|super)\s+low\b|\byou(?:'re|\s+are)\s+(?:extremely\s+|very\s+)?low on health\b|\blow (?:on )?health\b|\byou(?:'re|\s+are)\s+low again\b/i,
		check: (_m, c) => {
			const hit = meAt(c.g, c.atSec)
			if (!hit) return null
			const frac = hit.s.maxHp > 0 ? hit.s.hp / hit.s.maxHp : 0
			return {
				verdict: vagueBand(frac, HP_LOW_BAND),
				strictVerdict: frac <= HP_LOW_BAND ? "VERIFIED" : "CONTRADICTED",
				evidence: `HP ${pct(hit.s.hp, hit.s.maxHp)} at ${fmtClock(hit.s.atSec)} (feed, ${hit.gapSec}s from the line). The app's own LOW band is ${Math.round(HP_LOW_BAND * 100)}%, so strictly this is ${frac <= HP_LOW_BAND ? "LOW" : "NOT low"}; contradicted only above ${Math.round(HP_LOW_BAND * VAGUENESS_MULTIPLE * 100)}%`
			}
		}
	},
	{
		kind: "self.mana.low",
		channel: "feed",
		mood: "assert",
		re: /\bmana is (?:critically )?low\b|\blow on (?:health and )?mana\b|\byour mana is gone\b|\bout of mana\b/i,
		check: (_m, c) => {
			const hit = meAt(c.g, c.atSec)
			if (!hit) return null
			const frac = hit.s.maxMana > 0 ? hit.s.mana / hit.s.maxMana : 0
			return {
				verdict: vagueBand(frac, MANA_LOW_BAND),
				strictVerdict: frac <= MANA_LOW_BAND ? "VERIFIED" : "CONTRADICTED",
				evidence: `mana ${pct(hit.s.mana, hit.s.maxMana)} at ${fmtClock(hit.s.atSec)} (feed, ${hit.gapSec}s from the line). The app's own LOW band is ${Math.round(MANA_LOW_BAND * 100)}%, so strictly this is ${frac <= MANA_LOW_BAND ? "LOW" : "NOT low"}; contradicted only above ${Math.round(MANA_LOW_BAND * VAGUENESS_MULTIPLE * 100)}%`
			}
		}
	},
	{
		kind: "self.full",
		channel: "feed",
		mood: "assert",
		re: /\byou(?:'re|\s+are)\s+(?:back with\s+)?(?:full|fully reset|at full)\b|\byou are full health\b|\byou(?:'re|\s+are) full\b|\bfull health and mana\b|\byou(?:'re|\s+are) fully reset\b|\bnow that you(?:'re|\s+are) full\b/i,
		check: (_m, c) => {
			const hit = meAt(c.g, c.atSec)
			if (!hit) return null
			const hp = hit.s.maxHp > 0 ? hit.s.hp / hit.s.maxHp : 0
			const mana = hit.s.maxMana > 0 ? hit.s.mana / hit.s.maxMana : 0
			return {
				verdict: hp >= FULL_BAND ? "VERIFIED" : hp >= FULL_BAND - 0.1 ? "UNDECIDABLE" : "CONTRADICTED",
				strictVerdict: hp >= 0.95 ? "VERIFIED" : "CONTRADICTED",
				evidence: `HP ${pct(hit.s.hp, hit.s.maxHp)}, mana ${pct(hit.s.mana, hit.s.maxMana)} at ${fmtClock(hit.s.atSec)} (feed, ${hit.gapSec}s from the line)${mana < FULL_BAND && hp >= FULL_BAND ? " — full on health, not on mana" : ""}`
			}
		}
	},
	{
		kind: "self.gold",
		channel: "feed",
		mood: "assert",
		re: /\b(over |about |that |all that )?((?:\d{3,5})|(?:(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+thousand)|thousand)\s+gold\b/i,
		check: (m, c) => {
			const n = numOf(m[2]!)
			const hit = meAt(c.g, c.atSec)
			if (n === null || !hit) return null
			const over = /over/i.test(m[1] ?? "")
			const ok = over ? hit.s.gold >= n : Math.abs(hit.s.gold - n) <= Math.max(200, 0.25 * n)
			return {
				verdict: ok ? "VERIFIED" : "CONTRADICTED",
				evidence: `gold in hand ${Math.round(hit.s.gold)} at ${fmtClock(hit.s.atSec)} (feed, ${hit.gapSec}s from the line) against a claimed ${over ? ">= " : "~"}${n}`
			}
		}
	},
	{
		kind: "self.item",
		channel: "feed",
		mood: "assert",
		re: /\b(?:you have|have|got|with)\s+(?:your\s+)?(liandry'?s?|riftmaker|zhonya'?s?|mejai'?s?|haunting guise|boots|codex|hubris)\b/i,
		check: (m, c) => {
			const want = norm(m[1]!).replace(/s$/, "")
			const hit = meAt(c.g, c.atSec)
			if (!hit?.mine) return null
			const held = hit.mine.items.map(norm)
			const aliases: Record<string, string[]> = {
				boot: ["boot", "treads", "greaves", "footwear", "sorcerershoes", "shoes"],
				codex: ["codex"],
				liandry: ["liandry"],
				riftmaker: ["riftmaker"],
				zhonya: ["zhonya"],
				mejai: ["mejai"],
				hauntingguise: ["hauntingguise"],
				hubri: ["hubris"]
			}
			const keys = aliases[want] ?? [want]
			const found = held.find(h => keys.some(k => h.includes(k)))
			return {
				verdict: found ? "VERIFIED" : "CONTRADICTED",
				evidence: `his item list at ${fmtClock(hit.s.atSec)} (feed, ${hit.gapSec}s from the line): ${hit.mine.items.join(", ") || "empty"}`
			}
		}
	},
	{
		kind: "self.level",
		channel: "feed",
		mood: "assert",
		re: /\byou(?:'re|\s+are)\s+level (\d+)\b/i,
		check: (m, c) => {
			const hit = meAt(c.g, c.atSec)
			if (!hit?.mine) return null
			return {
				verdict: hit.mine.level === Number(m[1]) ? "VERIFIED" : "CONTRADICTED",
				evidence: `he was level ${hit.mine.level} at ${fmtClock(hit.s.atSec)} (feed, ${hit.gapSec}s from the line)`
			}
		}
	},
	{
		kind: "level.compare",
		channel: "feed",
		mood: "assert",
		re: /\b(?:you(?:'re|\s+are) (?:a level up on|ahead of)\s+([A-Z][a-zA-Z']+)|([A-Z][a-zA-Z']+) is (?:a level up on|fed and a level up)|your level is even with ([A-Z][a-zA-Z']+)|level lead on ([A-Z][a-zA-Z']+))/,
		check: (m, c) => {
			const name = m[1] ?? m[2] ?? m[3] ?? m[4]!
			const other = playerAt(c.g, name, c.atSec)
			const hit = meAt(c.g, c.atSec)
			if (!other || !hit?.mine) return null
			const mine = hit.mine.level
			const his = other.p.level
			const evidence = `levels at ${fmtClock(hit.s.atSec)} (feed, ${hit.gapSec}s from the line): him ${mine}, ${name} ${his}`
			if (m[1] || m[4]) return { verdict: mine > his ? "VERIFIED" : "CONTRADICTED", evidence }
			if (m[2]) return { verdict: his > mine ? "VERIFIED" : "CONTRADICTED", evidence }
			return { verdict: mine === his ? "VERIFIED" : "CONTRADICTED", evidence }
		}
	},

	/* ------------------------------------------------------ who is dead now */
	{
		kind: "other.dead.timer",
		channel: "feed",
		mood: "assert",
		re: /\b([A-Z][a-zA-Z']+) is (?:down|dead) for ([a-z-]+|\d+) seconds\b/i,
		/*
		 * ELAPSED against ELAPSED. See `deathInstant`: this check used to compare the claim against
		 * the respawn timer, which runs the other way, and certified six inversions as VERIFIED.
		 *
		 * The kill log is the only source for the elapsed half. When it has no death for this
		 * champion — a champion who died before the timeline this app stored, or a name the seats
		 * do not carry — the claim is UNDECIDABLE rather than verified against the wrong figure.
		 * The old reading is printed in the evidence either way, so the correction can be SEEN in
		 * the file rather than asserted in a commit message.
		 */
		check: (m, c) => {
			const other = playerAt(c.g, m[1]!, c.atSec)
			const want = numOf(m[2]!)
			if (!other || want === null) return null
			if (!other.p.dead)
				return {
					verdict: "CONTRADICTED",
					evidence: `${m[1]} at ${fmtClock(other.s.atSec)} (feed, ${other.gapSec}s from the line): ALIVE, against a claimed ${want}s dead`
				}
			const died = deathInstant(c.g, m[1]!, c.atSec)
			const elapsed = died === null ? null : Math.round(c.atSec - died)
			const remaining = Math.round(other.p.respawn)
			const oldReading = `the pre-2026-09-12 reading of this check compared it against the ${remaining}s REMAINING and would have said ${Math.abs(remaining - want) <= 8 ? "VERIFIED" : "CONTRADICTED"}`
			if (elapsed === null)
				return {
					verdict: "UNDECIDABLE",
					evidence: `${m[1]} is DEAD at ${fmtClock(other.s.atSec)} with ${remaining}s left, but the kill log carries no death for him before this instant, so how long he had ALREADY been dead is not knowable — against a claimed ${want}s elapsed. ${oldReading}`
				}
			return {
				verdict: Math.abs(elapsed - want) <= 8 ? "VERIFIED" : "CONTRADICTED",
				evidence: `${m[1]} died at ${fmtClock(died!)} (kill log, exact), so at ${fmtClock(c.atSec)} he had been down ${elapsed}s with ${remaining}s left — against a claimed ${want}s ELAPSED. ${oldReading}`
			}
		}
	},
	{
		kind: "other.dead",
		channel: "feed",
		mood: "assert",
		re: /\b([A-Z][a-zA-Z']+) (?:and ([A-Z][a-zA-Z']+) )?(?:are both dead|is also dead|is dead|are dead)\b(?! for)/,
		check: (m, c) => {
			const names = [m[1]!, m[2]].filter((n): n is string => Boolean(n))
			const rows = names.map(n => playerAt(c.g, n, c.atSec))
			if (rows.some(r => !r)) return null
			const allDead = rows.every(r => r!.p.dead)
			return {
				verdict: allDead ? "VERIFIED" : "CONTRADICTED",
				evidence: rows
					.map(r => `${r!.p.champion} ${r!.p.dead ? `DEAD (${Math.round(r!.p.respawn)}s)` : "ALIVE"} at ${fmtClock(r!.s.atSec)}`)
					.join("; ")
			}
		}
	},
	{
		kind: "team.dead.count",
		channel: "feed",
		mood: "assert",
		re: /\b(one|two|three|four|five|\d+) (?:of your team(?:mates)? are (?:down|dead)|teammates? (?:are|is) dead)\b/i,
		check: (m, c) => {
			const want = numOf(m[1]!)
			const hit = sampleAt(c.g, c.atSec)
			if (want === null || !hit) return null
			const dead = Object.values(hit.s.players).filter(
				p => p.team === "his" && p.dead && p.champion !== c.g.me.championName
			)
			const withHim = dead.length + (hit.s.players[c.g.me.championName]?.dead ? 1 : 0)
			return {
				verdict: dead.length === want || withHim === want ? "VERIFIED" : "CONTRADICTED",
				evidence: `at ${fmtClock(hit.s.atSec)} (feed, ${hit.gapSec}s from the line) his dead teammates were ${dead.map(p => p.champion).join(", ") || "none"} (${dead.length}), against a claimed ${want}`
			}
		}
	},
	{
		kind: "team.all.up",
		channel: "feed",
		mood: "assert",
		re: /\beveryone is back up\b/i,
		check: (_m, c) => {
			const hit = sampleAt(c.g, c.atSec)
			if (!hit) return null
			const dead = Object.values(hit.s.players).filter(p => p.team === "his" && p.dead)
			return {
				verdict: dead.length === 0 ? "VERIFIED" : "CONTRADICTED",
				evidence: `dead on his team at ${fmtClock(hit.s.atSec)}: ${dead.map(p => p.champion).join(", ") || "none"}`
			}
		}
	},

	/* --------------------------------------------------------- what just happened */
	{
		kind: "event.self.kill",
		channel: "event",
		mood: "assert",
		re: /\byou just killed ([A-Z][a-zA-Z']+)|\b(?:great|nice|good) (?:job on that |)(?:shutdown|kill)(?: on ([A-Z][a-zA-Z']+))?|\bafter that (double) kill|\bsecuring that drake and the kill\b/i,
		check: (m, c) => {
			const victim = m[1] ?? m[2] ?? null
			const wantDouble = Boolean(m[3])
			const mine = eventsBetween(c.g, c.atSec - 60, c.atSec).filter(
				e => e.kind === "kill" && e.killer?.participantId === c.g.me.participantId
			)
			const hits =
				victim ? mine.filter(e => norm(e.victim?.championName ?? "") === norm(victim)) : mine
			const ok = wantDouble ? mine.length >= 2 : hits.length >= 1
			return {
				verdict: ok ? "VERIFIED" : "CONTRADICTED",
				evidence: `his kills in the 60s before ${fmtClock(c.atSec)}: ${mine.map(e => `${e.victim?.championName} at ${e.clock}`).join(", ") || "none"}${victim ? ` (claimed ${victim})` : ""}`
			}
		}
	},
	{
		kind: "event.enemy.kills",
		channel: "event",
		mood: "assert",
		re: /\bthey got (one|two|three|four|five|\d+) kills?(, including you)?\b/i,
		check: (m, c) => {
			const want = numOf(m[1]!)
			const inclMe = Boolean(m[2])
			if (want === null) return null
			const theirs = eventsBetween(c.g, c.atSec - 60, c.atSec).filter(
				e => e.kind === "kill" && e.killer?.side === "enemy"
			)
			const gotHim = theirs.some(e => e.victim?.participantId === c.g.me.participantId)
			return {
				verdict: theirs.length === want && (!inclMe || gotHim) ? "VERIFIED" : "CONTRADICTED",
				evidence: `enemy kills in the 60s before ${fmtClock(c.atSec)}: ${theirs.map(e => `${e.victim?.championName} at ${e.clock}`).join(", ") || "none"} (${theirs.length}), against a claimed ${want}${inclMe ? ` including him (he ${gotHim ? "did" : "did NOT"} die)` : ""}`
			}
		}
	},
	{
		kind: "event.objective.taken",
		channel: "event",
		mood: "assert",
		re: /\b(?:they (?:got|took)|([A-Z][a-zA-Z']+) took) (?:the )?(drake|dragon|herald|rift herald|baron)\b|\b(?:nice job|great job) (?:taking|securing) that (drake|dragon)\b|\byou just got (baron)\b|\bhuge steal on the (soul drake|drake)\b/i,
		check: (m, c) => {
			const byName = m[1] ?? null
			const what = (m[2] ?? m[3] ?? m[4] ?? m[5] ?? "").toLowerCase()
			const type =
				what.includes("baron") ? "BARON_NASHOR"
				: what.includes("herald") ? "RIFTHERALD"
				: "DRAGON"
			const mineSide = Boolean(m[3] || m[4] || m[5])
			const recent = eventsBetween(c.g, c.atSec - 120, c.atSec).filter(
				e => e.kind === "objective" && e.monsterType === type
			)
			const all = `${type} kills in the 120s before ${fmtClock(c.atSec)}: ${recent.map(e => `${e.monsterName} by ${e.killer?.championName ?? "?"} (${e.killerSide}) at ${e.clock}`).join(", ") || "none"}`
			if (byName) {
				const ok = recent.some(e => norm(e.killer?.championName ?? "") === norm(byName))
				return { verdict: ok ? "VERIFIED" : "CONTRADICTED", evidence: `${all}; claimed taker ${byName}` }
			}
			const ok = recent.some(e => (mineSide ? e.killerSide === "his" : e.killerSide === "enemy"))
			return { verdict: ok ? "VERIFIED" : "CONTRADICTED", evidence: `${all}; claimed side ${mineSide ? "his" : "enemy"}` }
		}
	},
	{
		kind: "objective.soul",
		channel: "event",
		mood: "assert",
		re: /\byou'?ve got soul\b|\byou have soul\b/i,
		check: (_m, c) => {
			const his = c.g.events.filter(
				e => e.kind === "objective" && e.monsterType === "DRAGON" && e.killerSide === "his" && e.atSec <= c.atSec
			)
			return {
				verdict: his.length >= 4 ? "VERIFIED" : "CONTRADICTED",
				evidence: `his team's drakes by ${fmtClock(c.atSec)}: ${his.length} (${his.map(e => e.clock).join(", ") || "none"})`
			}
		}
	},

	/* ------------------------------------------------------------- the clock */
	{
		kind: "objective.timer",
		channel: "schedule",
		mood: "assert",
		/* The objective must be the LAST one named before the clock, or "skip the drake and take the
		   grubs spawning in forty seconds" gets checked against the drake's timer. */
		re: /\b(drake|dragon|baron|rift herald|herald|grubs|soul drake)\b(?:(?!\b(?:drake|dragon|baron|herald|grubs)\b)[^.;]){0,40}?\b(?:is |are )?(?:up |spawn(?:s|ing)? |coming up |starting )?in (\d+|[a-z-]+) seconds\b/i,
		check: (m, c) => {
			const what = m[1]!.toLowerCase()
			const kind =
				what.includes("baron") ? "baron"
				: what.includes("herald") ? "herald"
				: what.includes("grub") ? "grubs"
				: "drake"
			const want = numOf(m[2]!)
			const up = nextUpSec(c.g, kind as "drake" | "baron" | "herald" | "grubs", c.atSec)
			if (want === null || up === null) return null
			const actual = up - c.atSec
			return {
				verdict: Math.abs(actual - want) <= 12 ? "VERIFIED" : "CONTRADICTED",
				evidence: `${kind} was next standing at ${fmtClock(up)}, i.e. ${Math.round(actual)}s after ${fmtClock(c.atSec)}, against a claimed ${want}s (schedule from this app's own constants and the real kill log)`
			}
		}
	},
	{
		kind: "objective.standing",
		channel: "schedule",
		mood: "assert",
		re: /\b(drake|dragon|baron|rift herald|herald|grubs|soul drake)\b(?:(?!\b(?:drake|dragon|baron|herald|grubs)\b)[^.;]){0,30}?\b(?:is|are)\s+(?:still\s+)?(up|live|open|spawning (?:right )?now)\b(?!\s+in\s+\S+\s+seconds)/i,
		check: (m, c) => {
			const what = m[1]!.toLowerCase()
			const kind =
				what.includes("baron") ? "baron"
				: what.includes("herald") ? "herald"
				: what.includes("grub") ? "grubs"
				: "drake"
			const up = nextUpSec(c.g, kind as "drake" | "baron" | "herald" | "grubs", c.atSec)
			const takenSince = c.g.events.some(
				e =>
					e.kind === "objective" &&
					e.atSec <= c.atSec &&
					e.atSec >= (up ?? 0) &&
					((kind === "drake" && e.monsterType === "DRAGON") ||
						(kind === "baron" && e.monsterType === "BARON_NASHOR") ||
						(kind === "herald" && e.monsterType === "RIFTHERALD") ||
						(kind === "grubs" && e.monsterType === "HORDE"))
			)
			if (up === null) return null
			const standing = up <= c.atSec + 6 && !takenSince
			return {
				verdict: standing ? "VERIFIED" : "CONTRADICTED",
				evidence: `${kind} was next standing at ${fmtClock(up)} and ${takenSince ? "had already been taken" : "had not been taken"} by ${fmtClock(c.atSec)}`
			}
		}
	},
	{
		kind: "matchup",
		channel: "feed",
		mood: "assert",
		re: /\b(?:you(?:'re| are) (?:up )?against|looks like you(?:'re| are) against) ([A-Z][a-zA-Z']+)/,
		check: (m, c) => ({
			verdict: norm(m[1]!) === norm(c.g.foe.championName) ? "VERIFIED" : "CONTRADICTED",
			evidence: `the enemy jungler in this game was ${c.g.foe.championName}`
		})
	},
	{
		kind: "other.alive",
		channel: "feed",
		mood: "assert",
		re: /\b([A-Z][a-zA-Z']+) is back on the map\b/,
		check: (m, c) => {
			const other = playerAt(c.g, m[1]!, c.atSec)
			if (!other) return null
			return {
				verdict: other.p.dead ? "CONTRADICTED" : "VERIFIED",
				evidence: `${m[1]} at ${fmtClock(other.s.atSec)} (feed, ${other.gapSec}s from the line): ${other.p.dead ? `DEAD, ${Math.round(other.p.respawn)}s to respawn` : "ALIVE"}`
			}
		}
	},
	{
		kind: "enemy.dead.count",
		channel: "feed",
		mood: "assert",
		re: /\b(one|two|three|four|five|\d+) of them are (?:down|dead)\b/i,
		check: (m, c) => {
			const want = numOf(m[1]!)
			const hit = sampleAt(c.g, c.atSec)
			if (want === null || !hit) return null
			const dead = Object.values(hit.s.players).filter(p => p.team === "enemy" && p.dead)
			return {
				verdict: dead.length === want ? "VERIFIED" : "CONTRADICTED",
				evidence: `dead on the enemy team at ${fmtClock(hit.s.atSec)} (feed, ${hit.gapSec}s from the line): ${dead.map(p => `${p.champion} (${Math.round(p.respawn)}s)`).join(", ") || "none"} (${dead.length}), against a claimed ${want}`
			}
		}
	},
	{
		kind: "self.mana.healthy",
		channel: "feed",
		mood: "assert",
		re: /\bhealthy mana bar\b/i,
		check: (_m, c) => {
			const hit = meAt(c.g, c.atSec)
			if (!hit) return null
			const frac = hit.s.maxMana > 0 ? hit.s.mana / hit.s.maxMana : 0
			return {
				verdict:
					frac > MANA_LOW_BAND * VAGUENESS_MULTIPLE ? "VERIFIED"
					: frac <= MANA_LOW_BAND ? "CONTRADICTED"
					: "UNDECIDABLE",
				evidence: `mana ${pct(hit.s.mana, hit.s.maxMana)} at ${fmtClock(hit.s.atSec)} (feed, ${hit.gapSec}s from the line)`
			}
		}
	},
	{
		kind: "event.self.back",
		channel: "position",
		mood: "presuppose",
		/* "Good back" only makes sense if he just stood in the shop. The item feed sees that exactly. */
		re: /\b(?:good|great|nice) back\b/i,
		check: (_m, c) => {
			const recent = (c.g.anchors[c.g.me.participantId] ?? []).filter(
				a => a.why.startsWith("bought something") && a.atSec >= c.atSec - 45 && a.atSec <= c.atSec + 10
			)
			if (recent.length > 0)
				return {
					verdict: "VERIFIED",
					evidence: `his item list gained an entry at ${fmtClock(recent[0]!.atSec)}, so he stood at the shop inside the 45s before ${fmtClock(c.atSec)}`
				}
			return regionVerdict(c, c.g.me.participantId, inZones(c.g, ["OWN_BASE"]), "in his own base")
		}
	},
	{
		kind: "buff.baron",
		channel: "event",
		mood: "assert",
		re: /\bwith (?:that|the|your) baron buff\b/i,
		check: (_m, c) => {
			const his = c.g.events.filter(
				e =>
					e.kind === "objective" &&
					e.monsterType === "BARON_NASHOR" &&
					e.killerSide === "his" &&
					e.atSec <= c.atSec &&
					e.atSec >= c.atSec - 210
			)
			return {
				verdict: his.length > 0 ? "VERIFIED" : "CONTRADICTED",
				evidence: `his team's barons in the 210s before ${fmtClock(c.atSec)}: ${his.map(e => e.clock).join(", ") || "none"}`
			}
		}
	},
	{
		kind: "self.item.ready",
		channel: "feed",
		mood: "assert",
		re: /\b(zhonya'?s?|mejai'?s?|liandry'?s?|riftmaker)(?:\s+and\s+(zhonya'?s?|mejai'?s?|liandry'?s?|riftmaker))?\s+(?:is|are) ready\b/i,
		check: (m, c) => {
			const hit = meAt(c.g, c.atSec)
			if (!hit?.mine) return null
			const wants = [m[1]!, m[2]].filter((x): x is string => Boolean(x)).map(x => norm(x).replace(/s$/, ""))
			const held = hit.mine.items.map(norm)
			const missing = wants.filter(w => !held.some(h => h.includes(w)))
			return {
				verdict: missing.length === 0 ? "VERIFIED" : "CONTRADICTED",
				evidence: `his item list at ${fmtClock(hit.s.atSec)} (feed, ${hit.gapSec}s from the line): ${hit.mine.items.join(", ") || "empty"}`
			}
		}
	}
]

/** Pull every checkable claim out of one sentence. Instructions produce none, by design. */
export const claimsOf = (text: string, g: GameTruth, atSec: number, bound = BOUND): Claim[] => {
	BOUND = bound
	const out: Claim[] = []
	const ctx: Ctx = { g, atSec, text }
	for (const rule of RULES) {
		const m = text.match(rule.re)
		if (!m) continue
		const got = rule.check(m, ctx)
		if (!got) continue
		out.push({
			kind: rule.kind,
			clause: m[0].trim(),
			mood: rule.mood,
			channel: rule.channel,
			verdict: got.verdict,
			strictVerdict: got.strictVerdict,
			likelyVerdict: got.likelyVerdict,
			evidence: got.evidence
		})
	}
	return out
}

/* ==================================== adjudicating the JUDGE'S OWN stated reason */

/**
 * The with-frame judge did not merely disagree — it gave a REASON, and the reason is nearly always
 * one of two assertions about the picture: "he is mid-fight" and "he is in the shop". Both are
 * checkable without looking at any picture, so the judge's instrument can be scored directly.
 *
 * A fight is read off his own HP, which the feed reports exactly every five seconds, plus the kill
 * log. Nothing here is a model's opinion about a screenshot.
 */
export const fightContext = (
	g: GameTruth,
	atSec: number
): { verdict: "IN A FIGHT" | "NOT IN A FIGHT" | "UNCLEAR"; evidence: string } => {
	const near = g.samples.filter(s => Math.abs(s.atSec - atSec) <= 12)
	let drop = 0
	for (let i = 0; i < near.length - 1; i++)
		for (let j = i + 1; j < near.length; j++) {
			const a = near[i]!
			const b = near[j]!
			const d = (a.maxHp > 0 ? a.hp / a.maxHp : 0) - (b.maxHp > 0 ? b.hp / b.maxHp : 0)
			if (d > drop) drop = d
		}
	const kills = g.events.filter(e => e.kind === "kill" && Math.abs(e.atSec - atSec) <= 15)
	const his = kills.filter(
		e =>
			e.killer?.participantId === g.me.participantId ||
			e.victim?.participantId === g.me.participantId ||
			e.assists.some(a => a.participantId === g.me.participantId)
	)
	const evidence =
		`his HP fell at most ${Math.round(drop * 100)} points inside +/-12s of ${fmtClock(atSec)} (feed, exact); ` +
		`champion kills within 15s: ${kills.length} (${his.length} with him in them${his.length ? `: ${his.map(e => `${e.killer?.championName} killed ${e.victim?.championName} at ${e.clock}`).join(", ")}` : ""})`
	if (his.length > 0 || drop >= 0.12) return { verdict: "IN A FIGHT", evidence }
	if (drop < 0.03 && kills.length === 0) return { verdict: "NOT IN A FIGHT", evidence }
	return { verdict: "UNCLEAR", evidence }
}

/** Was he standing in the shop? The item list gaining an entry is exact, at 5s resolution. */
export const shopContext = (
	g: GameTruth,
	atSec: number
): { verdict: "IN BASE" | "NOT IN BASE" | "UNCLEAR"; evidence: string } => {
	const bought = (g.anchors[g.me.participantId] ?? []).filter(
		a => a.why.startsWith("bought something") && Math.abs(a.atSec - atSec) <= 20
	)
	if (bought.length > 0)
		return { verdict: "IN BASE", evidence: `${bought.map(b => b.why).join("; ")} — the item feed puts him at the shop` }
	const r = whereCouldBe(g, g.me.participantId, atSec, { speedMul: 1, slack: FLASH_SLACK })
	const d = decideRegion(r, p => classifyZone(p, g.myTeam) === "OWN_BASE")
	return {
		verdict:
			d.verdict === "VERIFIED" ? "IN BASE"
			: d.verdict === "CONTRADICTED" ? "NOT IN BASE"
			: "UNCLEAR",
		evidence: `no purchase within 20s; ${Math.round(d.frac * 100)}% of his reachable set is inside his own base`
	}
}

/* ============================================================ line adjudication */

type LineVerdict = Verdict | "NO-CLAIM"

interface Adjudicated {
	gameId: string
	clock: string
	atSec: number
	text: string
	claims: Claim[]
	verdict: LineVerdict
	/** The same line read against the app's OWN low/full bands instead of the generous ones. */
	strictVerdict: LineVerdict
	/** What the record says about the two things the with-frame judge kept asserting. */
	fight: { verdict: string; evidence: string }
	shop: { verdict: string; evidence: string }
	judgeReason: { asserted: string; record: string; evidence: string } | null
	/** Where the exact record still allows him to have been, at this instant. */
	where: string
	/** Whether the ground-truth block the coach was actually given carried a position at all. */
	payloadHadPosition: boolean
	withFrame: JudgeVerdict | null
	noFrame: JudgeVerdict | null
}

/**
 * One contradicted claim sinks the line — a sentence that asserts a false thing is false however
 * much else it got right. But one UNDECIDABLE claim also stops the line from being called verified,
 * because a sentence is only as settled as its least settled clause. A line that asserts nothing
 * checkable is its own bucket rather than a silent pass.
 */
export const verdictOfLine = (claims: readonly Claim[]): LineVerdict =>
	claims.length === 0 ? "NO-CLAIM"
	: claims.some(c => c.verdict === "CONTRADICTED") ? "CONTRADICTED"
	: claims.some(c => c.verdict === "UNDECIDABLE") ? "UNDECIDABLE"
	: "VERIFIED"

/* ------------------------------------------------------------------ statistics */

/**
 * McNemar's exact test — the two-sided exact binomial at p = 0.5 over the discordant pairs.
 *
 * This file had its own summation (via log-factorials) and `frame-value.ts` had another (via
 * log-choose) for the identical test, each with its own unit test. Consolidated into
 * `lib/stats.ts` on 2026-09-12: two implementations of one p-value means the repo can quote two
 * numbers for one comparison. Re-exported so this file's test and the stored adjudication both
 * stay attached to the file that produced them.
 */
export { mcnemarExact } from "./lib/stats.ts"

const fmtInterval = (i: Interval): string =>
	`${i.k}/${i.n} = ${Math.round(i.p * 100)}% [${Math.round(i.lo * 100)}-${Math.round(i.hi * 100)}]`

/* ===================================================================== the run */

const main = (): void => {

const db = new DatabaseSync(`${DATA_DIR}/csk.db`, { readOnly: true })

const lines = readJson<{ windows: { id: string; gameId: string; counterpart: string }[]; records: LineRecord[] }>(LINES_PATH)
const judges = readJson<{ result: unknown; crossTab: Record<string, number>; lines: JudgeLine[] }>(JUDGES_PATH)

const games = new Map<string, GameTruth>()
for (const w of lines.windows) games.set(w.id, loadGame(w.id, Number(w.gameId), db))

const gameIdOf = (windowId: string): string => lines.windows.find(w => w.id === windowId)?.gameId ?? ""

const swapped =
	NOFRAME_PATH === "" ? null : (
		readJson<{ judge?: string; judgePrompt?: string; lines: { windowId: string; clock: string; verdict: string; why: string }[] }>(
			NOFRAME_PATH
		)
	)
/*
 * An UNGRADED line has no no-frame verdict at all and must not silently keep the old file's. It
 * becomes `unverifiable`, which is the one verdict that is neither "false" nor a claim of
 * usefulness, and the count is printed so a reader knows how many lines it happened to.
 */
const swapMisses: string[] = []
const noFrameFor = (r: LineRecord, fallback: JudgeVerdict | undefined): JudgeVerdict | undefined => {
	if (!swapped) return fallback
	const hit = swapped.lines.find(l => l.windowId === r.windowId && l.clock === r.clock)
	if (!hit) {
		swapMisses.push(`${r.windowId} ${r.clock}`)
		return fallback
	}
	const v = hit.verdict === "ungraded" ? "unverifiable" : hit.verdict
	return { verdict: v as JudgeVerdict["verdict"], why: hit.why }
}

const judgeOf = (gameId: string, clock: string): JudgeLine | null =>
	judges.lines.find(l => l.gameId === gameId && l.clock === clock) ?? null

const JUDGE_SAYS_FIGHT = /mid-?fight|in a (?:fight|skirmish)|active combat|fighting|in combat|team ?fight/i
const JUDGE_SAYS_SHOP = /\b(?:in (?:the )?shop|shop menu|shop is open|recalling|in base|at base|fountain)\b/i
/** The judge's own position read, which is the exact channel this whole dispute is about. */
const JUDGE_READS_MINIMAP = /minimap shows[^.;]*?\b(bottom|bot-?side|bot|top-?side|top)\b/i

const adjudicated: Adjudicated[] = lines.records.map(r => {
	const r0 = r
	const g = games.get(r.windowId)!
	const claims = claimsOf(r.text, g, r.atSec, { speedMul: 1, slack: FLASH_SLACK })
	const tight = claimsOf(r.text, g, r.atSec, TIGHT_BOUND)
	for (const c of claims) {
		if (c.channel !== "position") continue
		c.tightVerdict = tight.find(t => t.kind === c.kind && t.clause === c.clause)?.verdict
	}
	const j = judgeOf(gameIdOf(r.windowId), r.clock)
	const why = j?.withFrame.why ?? ""
	const fight = fightContext(g, r.atSec)
	const shop = shopContext(g, r.atSec)
	return {
		gameId: gameIdOf(r.windowId),
		clock: r.clock,
		atSec: r.atSec,
		text: r.text,
		claims,
		verdict: verdictOfLine(claims),
		strictVerdict: verdictOfLine(claims.map(c => ({ ...c, verdict: c.strictVerdict ?? c.verdict }))),
		payloadHadPosition: !r.payload.includes("WHERE YOU ARE IS NOT IN THIS PAYLOAD"),
		withFrame: j?.withFrame ?? null,
		noFrame: noFrameFor(r, j?.noFrame) ?? null,
		fight,
		shop,
		where: (() => {
			const r = whereCouldBe(g, g.me.participantId, r0.atSec, { speedMul: 1, slack: FLASH_SLACK })
			return `${zonesOfRegion(g, r)} (set spans ${Math.round(r.spanFrac * 100)}% of map width)`
		})(),
		judgeReason:
			JUDGE_READS_MINIMAP.test(why) ?
				(() => {
					const side = why.match(JUDGE_READS_MINIMAP)![1]!.toLowerCase()
					const wantsTop = side.startsWith("top")
					const b = bracketVerdict(g, g.me.participantId, r0.atSec, wantsTop ? isTopside : isBotside)
					return {
						asserted: `the minimap shows him ${wantsTop ? "top" : "bot"}side`,
						record:
							b.likely === "LIKELY-TRUE" ? "AGREES"
							: b.likely === "LIKELY-FALSE" ? "DISAGREES"
							: "CANNOT SAY",
						evidence: b.evidence
					}
				})()
			: JUDGE_SAYS_FIGHT.test(why) ?
				{ asserted: "he is mid-fight", record: fight.verdict, evidence: fight.evidence }
			: JUDGE_SAYS_SHOP.test(why) ?
				{ asserted: "he is in base / the shop", record: shop.verdict, evidence: shop.evidence }
			:	null
	}
})

/* --------------------------------------------------------------- the report */

const count = (pred: (a: Adjudicated) => boolean): number => adjudicated.filter(pred).length
const decidable = adjudicated.filter(a => a.verdict === "VERIFIED" || a.verdict === "CONTRADICTED")
const flipped = adjudicated.filter(a => a.withFrame?.verdict === "false" && a.noFrame?.verdict === "useful")
const flippedBack = adjudicated.filter(a => a.noFrame?.verdict === "false" && a.withFrame?.verdict === "useful")

/** A judge is right on a decidable line when its "false" call matches the record's CONTRADICTED. */
const judgeRight = (
	a: Adjudicated,
	which: "withFrame" | "noFrame",
	reading: "verdict" | "strictVerdict" = "verdict"
): boolean | null => {
	const v = a[which]?.verdict
	const truth = a[reading]
	if (!v || (truth !== "VERIFIED" && truth !== "CONTRADICTED")) return null
	return (v === "false") === (truth === "CONTRADICTED")
}

const strictDecidable = adjudicated.filter(a => a.strictVerdict === "VERIFIED" || a.strictVerdict === "CONTRADICTED")

const withRight = decidable.filter(a => judgeRight(a, "withFrame") === true).length
const noRight = decidable.filter(a => judgeRight(a, "noFrame") === true).length
const onlyWith = decidable.filter(a => judgeRight(a, "withFrame") === true && judgeRight(a, "noFrame") === false).length
const onlyNo = decidable.filter(a => judgeRight(a, "noFrame") === true && judgeRight(a, "withFrame") === false).length

const positionClaims = adjudicated.flatMap(a => a.claims.filter(c => c.channel === "position"))
const feedClaims = adjudicated.flatMap(a => a.claims.filter(c => c.channel !== "position"))

const tally = (cs: readonly Claim[]): Record<Verdict, number> => ({
	VERIFIED: cs.filter(c => c.verdict === "VERIFIED").length,
	CONTRADICTED: cs.filter(c => c.verdict === "CONTRADICTED").length,
	UNDECIDABLE: cs.filter(c => c.verdict === "UNDECIDABLE").length
})

const out = {
	what:
		"GROUND-TRUTH ADJUDICATION of the 58 socket lines the two judges disagreed about. No model is " +
		"consulted anywhere in this file: every claim is checked against data/blobs/<gameId>/timeline.json.gz " +
		"(exact per-minute positions for all ten players, interpolated only under a kinematic bound that " +
		"reports when it cannot decide) and data/live-samples/<window>.ndjson (the raw allgamedata every 5s).",
	ranAt: new Date().toISOString(),
	inputs: {
		lines: LINES_PATH,
		judges: JUDGES_PATH,
		...(swapped ?
			{
				noFrameSwappedFor: NOFRAME_PATH,
				noFrameJudge: swapped.judge ?? "unknown",
				noFramePrompt: swapped.judgePrompt ?? "unknown",
				noFrameLinesNotFound: swapMisses
			}
		:	{})
	},
	method: {
		positions:
			`every map point satisfying dist(p, anchor) <= anchor.radius + ${FLASH_SLACK} + speed * |t - anchor.t| for EVERY ` +
			`anchor (one-minute timeline frames at radius 0, kill positions, objective and building kills, his respawns and ` +
			`shop visits), on a ${GRID_UNITS}-unit grid. All points agree -> VERIFIED, none -> CONTRADICTED, else UNDECIDABLE.`,
		speed: `his own feed moveSpeed x ${SPEED_SLACK} (reachability.ts measured the ratio peaking at 1.14), the enemy a flat ${FOE_SPEED} x ${SPEED_SLACK}`,
		feed: `HP/mana called low against the app's own bands (${HP_LOW_BAND}, ${MANA_LOW_BAND}); gold, items, levels, deaths and respawn timers read straight off the 5s samples`,
		notJudged: "imperatives. A sentence that only tells him what to do produces no claims and lands in NO-CLAIM."
	},
	lineVerdicts: {
		VERIFIED: count(a => a.verdict === "VERIFIED"),
		CONTRADICTED: count(a => a.verdict === "CONTRADICTED"),
		UNDECIDABLE: count(a => a.verdict === "UNDECIDABLE"),
		"NO-CLAIM": count(a => a.verdict === "NO-CLAIM"),
		n: adjudicated.length
	},
	claimCounts: { position: tally(positionClaims), feedAndEvent: tally(feedClaims), total: positionClaims.length + feedClaims.length },
	guessTier: {
		what:
			"Position claims re-read at the app's own interpolation tier — the two exact frames either side " +
			"of the instant. A GUESS by this repo's own measurement (median 1452 units of error, presence " +
			"detection ~65% sensitive, confidence: low), reported beside the proof and never instead of it.",
		claims: positionClaims.map(c => ({ clause: c.clause, proven: c.verdict, likely: c.likelyVerdict, evidence: c.evidence }))
	},
	sensitivity: {
		strictBands: {
			what:
				"The same 58 lines with 'low' and 'full' read against the app's OWN bands (30% HP, 20% mana, " +
				"95% for full) instead of the deliberately generous doubled ones. This is the only place the " +
				"headline moves, and it moves because the word is vague, not because the record is unclear.",
			CONTRADICTED: count(a => a.strictVerdict === "CONTRADICTED"),
			VERIFIED: count(a => a.strictVerdict === "VERIFIED"),
			UNDECIDABLE: count(a => a.strictVerdict === "UNDECIDABLE"),
			lines: adjudicated
				.filter(a => a.strictVerdict === "CONTRADICTED" && a.verdict !== "CONTRADICTED")
				.map(a => ({ clock: a.clock, text: a.text, claims: a.claims.filter(c => c.strictVerdict === "CONTRADICTED") }))
		},
		tighterMovementBound: {
			what:
				`Position claims re-decided with speed x ${TIGHT_BOUND.speedMul} of the worst case and no Flash slack — ` +
				"roughly his typical rather than his peak speed. How much of the undecidable bucket is the " +
				"worst case being paid for, and how much is the one-minute frame interval itself.",
			resolved: positionClaims.filter(c => c.verdict === "UNDECIDABLE" && c.tightVerdict && c.tightVerdict !== "UNDECIDABLE").length,
			stillUndecidable: positionClaims.filter(c => c.verdict === "UNDECIDABLE" && c.tightVerdict === "UNDECIDABLE").length,
			byClaim: positionClaims.map(c => ({ clause: c.clause, worstCase: c.verdict, tighter: c.tightVerdict }))
		}
	},
	judgeReasons: {
		what:
			"The with-frame judge did not only disagree, it said WHY, and its reason is almost always one of " +
			"two assertions about the picture. Both are checkable off the feed without any picture at all.",
		checked: adjudicated.filter(a => a.judgeReason).length,
		tally: {
			assertedFight: adjudicated.filter(a => a.judgeReason?.asserted === "he is mid-fight").length,
			assertedFightAndRecordAgrees: adjudicated.filter(
				a => a.judgeReason?.asserted === "he is mid-fight" && a.judgeReason.record === "IN A FIGHT"
			).length,
			assertedFightAndRecordDisagrees: adjudicated.filter(
				a => a.judgeReason?.asserted === "he is mid-fight" && a.judgeReason.record === "NOT IN A FIGHT"
			).length,
			assertedFightUnclear: adjudicated.filter(
				a => a.judgeReason?.asserted === "he is mid-fight" && a.judgeReason.record === "UNCLEAR"
			).length,
			readTheMinimap: adjudicated.filter(a => a.judgeReason?.asserted.startsWith("the minimap")).length,
			minimapAgrees: adjudicated.filter(a => a.judgeReason?.asserted.startsWith("the minimap") && a.judgeReason.record === "AGREES").length,
			minimapDisagrees: adjudicated.filter(
				a => a.judgeReason?.asserted.startsWith("the minimap") && a.judgeReason.record === "DISAGREES"
			).length
		},
		lines: adjudicated
			.filter(a => a.judgeReason)
			.map(a => ({
				clock: a.clock,
				gameId: a.gameId,
				text: a.text,
				judgeSaid: a.withFrame?.why,
				asserted: a.judgeReason!.asserted,
				record: a.judgeReason!.record,
				evidence: a.judgeReason!.evidence
			}))
	},
	payload: {
		turnsCarryingHisPosition: count(a => a.payloadHadPosition),
		n: adjudicated.length,
		note:
			"Not one of the 58 ground-truth blocks carried his position. Every position claim in these lines came " +
			"from the picture or from nowhere — the block cannot be what the coach was reading off."
	},
	judges: {
		onDecidableLines: {
			n: decidable.length,
			withFrameCorrect: wilson(withRight, decidable.length),
			noFrameCorrect: wilson(noRight, decidable.length),
			discordant: { withFrameOnly: onlyWith, noFrameOnly: onlyNo, exactP: mcnemarExact(onlyWith, onlyNo) }
		},
		underStrictBands: {
			what: "the same scoring with 'low' and 'full' read against the app's own bands — the reading most favourable to the with-frame judge",
			n: strictDecidable.length,
			withFrameCorrect: wilson(strictDecidable.filter(a => judgeRight(a, "withFrame", "strictVerdict") === true).length, strictDecidable.length),
			noFrameCorrect: wilson(strictDecidable.filter(a => judgeRight(a, "noFrame", "strictVerdict") === true).length, strictDecidable.length)
		},
		theEighteenThatFlipped: {
			n: flipped.length,
			groundTruthSaysFalse: flipped.filter(a => a.verdict === "CONTRADICTED").length,
			groundTruthSaysFine: flipped.filter(a => a.verdict === "VERIFIED").length,
			cannotBeSettled: flipped.filter(a => a.verdict === "UNDECIDABLE" || a.verdict === "NO-CLAIM").length,
			lines: flipped.map(a => ({
				clock: a.clock,
				gameId: a.gameId,
				text: a.text,
				verdict: a.verdict,
				strictVerdict: a.strictVerdict,
				where: a.where,
				fight: a.fight,
				withFrameWhy: a.withFrame?.why,
				noFrameWhy: a.noFrame?.why,
				claims: a.claims
			}))
		},
		theOneThatFlippedBack: flippedBack.map(a => ({ clock: a.clock, text: a.text, verdict: a.verdict, claims: a.claims }))
	},
	lines: adjudicated
}

mkdirSync(dirname(OUT_PATH), { recursive: true })
writeFileSync(OUT_PATH, JSON.stringify(out, null, 1))

/* ------------------------------------------------------------------ printing */

const P = (s = ""): void => console.log(s)
P("ADJUDICATION — the exact record, no judge")
P("=".repeat(78))
P(`lines            ${adjudicated.length} (2 games, the shipped socket coach)`)
P(
	`line verdicts    VERIFIED ${out.lineVerdicts.VERIFIED}  CONTRADICTED ${out.lineVerdicts.CONTRADICTED}  ` +
		`UNDECIDABLE ${out.lineVerdicts.UNDECIDABLE}  NO-CLAIM ${out.lineVerdicts["NO-CLAIM"]}`
)
P(
	`claims           position ${positionClaims.length} (V ${tally(positionClaims).VERIFIED} / C ${tally(positionClaims).CONTRADICTED} / U ${tally(positionClaims).UNDECIDABLE})` +
		`, feed+event ${feedClaims.length} (V ${tally(feedClaims).VERIFIED} / C ${tally(feedClaims).CONTRADICTED} / U ${tally(feedClaims).UNDECIDABLE})`
)
P(`payload position ${out.payload.turnsCarryingHisPosition} of ${adjudicated.length} turns carried where he was`)
P(
	`strict bands     ${out.sensitivity.strictBands.CONTRADICTED} lines contradicted if "low"/"full" are read against the app's own bands ` +
		`instead of the generous ones`
)
P(
	`tighter bound    ${out.sensitivity.tighterMovementBound.resolved} of ${out.sensitivity.tighterMovementBound.resolved + out.sensitivity.tighterMovementBound.stillUndecidable} ` +
		`undecidable position claims would resolve at typical rather than peak speed`
)
P()
P("THE WITH-FRAME JUDGE'S OWN STATED REASON, checked against the feed")
P("-".repeat(78))
P(`  said "mid-fight"             ${out.judgeReasons.tally.assertedFight}`)
P(`    record agrees              ${out.judgeReasons.tally.assertedFightAndRecordAgrees}`)
P(`    record DISAGREES           ${out.judgeReasons.tally.assertedFightAndRecordDisagrees}`)
P(`    record cannot say          ${out.judgeReasons.tally.assertedFightUnclear}`)
P(
	`  read the minimap             ${out.judgeReasons.tally.readTheMinimap} ` +
		`(exact frames either side agree ${out.judgeReasons.tally.minimapAgrees}, disagree ${out.judgeReasons.tally.minimapDisagrees})`
)
P()
P("THE JUDGES, scored against the record on the lines the record can settle")
P("-".repeat(78))
P(`decidable lines  ${decidable.length} of ${adjudicated.length}`)
P(`with the frame   ${fmtInterval(wilson(withRight, decidable.length))}`)
P(`without it       ${fmtInterval(wilson(noRight, decidable.length))}`)
P(`paired           with-only ${onlyWith}, no-only ${onlyNo}, McNemar exact p = ${mcnemarExact(onlyWith, onlyNo).toPrecision(3)}`)
P(
	`strict reading   with the frame ${fmtInterval(out.judges.underStrictBands.withFrameCorrect)}, ` +
		`without it ${fmtInterval(out.judges.underStrictBands.noFrameCorrect)}`
)
P()
P(`THE ${flipped.length} LINES THAT FLIPPED (with-frame called false, no-frame called useful)`)
P("-".repeat(78))
P(`  the record says FALSE        ${out.judges.theEighteenThatFlipped.groundTruthSaysFalse}`)
P(`  the record says FINE         ${out.judges.theEighteenThatFlipped.groundTruthSaysFine}`)
P(`  the record CANNOT SETTLE     ${out.judges.theEighteenThatFlipped.cannotBeSettled}`)
P()
for (const a of flipped) {
	P(`${a.clock}  [${a.verdict}]  ${a.text}`)
	for (const c of a.claims) P(`        ${c.verdict.padEnd(13)} ${c.kind} "${c.clause}" — ${c.evidence}`)
	P(`        with-frame: ${a.withFrame?.why}`)
	P()
}
P("EVERY LINE WHERE THE WITH-FRAME JUDGE ASSERTED SOMETHING ABOUT THE PICTURE")
P("-".repeat(78))
for (const a of adjudicated.filter(x => x.judgeReason)) {
	P(`${a.clock}  judge: "${a.withFrame?.why}"`)
	P(`        asserted ${a.judgeReason!.asserted} -> record says ${a.judgeReason!.record}`)
	P(`        ${a.judgeReason!.evidence}`)
}
P()
if (VERBOSE) {
	P("EVERY LINE")
	P("=".repeat(78))
	for (const a of adjudicated) {
		P(`${a.gameId} ${a.clock} [${a.verdict}] ${a.text}`)
		for (const c of a.claims) P(`        ${c.verdict.padEnd(13)} ${c.kind} "${c.clause}" — ${c.evidence}`)
	}
}
P(`written ${OUT_PATH}`)
}

if (import.meta.main) main()
