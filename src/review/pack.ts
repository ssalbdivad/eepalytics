/**
 * THE POST-GAME PACK, built from the database alone.
 *
 * ## Why this exists beside `scripts/game-pack.ts`
 *
 * `scripts/game-pack.ts` is the rich offline artefact. It joins four channels — the raw
 * `allgamedata` samples, the journal frames, a Gemini read of the minimap, and the live coach's
 * own transcript — and it cannot run without all of them. That is the right shape for an
 * evaluation and the wrong shape for the shipped path: three of those four channels only exist
 * when he screen-shared, one of them costs a model call per frame, and the script takes a
 * `--session` and a `--game` that a human has to look up.
 *
 * This module is the pack the DAEMON can always build, the moment `match-ingest` lands, with no
 * network, no model and no arguments but a gameId.
 *
 * ## Every figure here comes from the post-game timeline or the post-game match
 *
 * This is the rule the whole file exists to enforce. The live feed's `scores.creepScore` for an
 * ENEMY is a visibility counter — it counts only the last hits your own client witnessed, and it
 * never catches up. Measured on game 5639406342 it read **70 against a true 183**, sign-flipping
 * the comparison the coach spent the game on, and it produced BOTH of the two items he graded
 * false out of 37. `src/analysis/game-truth.ts` is the source instead: thirty frames, one a
 * minute, exact for all ten players. Nothing in this file reads `data/live-samples/`.
 *
 * What each section is made of:
 *
 *   scoreboard   the MATCH blob — end-of-game totals and the final item list, exact
 *   checkpoints  the TIMELINE — level / CS / gold for him and his counterpart at the minute marks
 *   minutes      the TIMELINE — every frame, both of them, with the zone each was standing in
 *   objectives   the TIMELINE's `ELITE_MONSTER_KILL` / `BUILDING_KILL`, joined to WHERE HE WAS
 *   deaths       the TIMELINE's `CHAMPION_KILL`, with the zone and the gold he was carrying
 *   frames       the journal index — his own screen, when he shared it
 *
 * ## The join that the live coach could never make
 *
 * `objectives` is the section worth the whole file: an elite monster has an exact millisecond and
 * the frames are a minute apart, so "where was he when drake fell" is a real question the live
 * path could not answer at all (the live feed has no positions for anyone) and this one answers
 * with the nearest frame AND the gap it cost to get there. A caller that ignores `gapSec` is
 * inventing; the renderer prints it on every row for that reason.
 *
 * ## What it deliberately does not do
 *
 * It decides nothing. No advice, no severity, no judgment, and no number that was not measured.
 * It does not interpolate a position between frames — `truthAt` returns the nearest frame and its
 * gap rather than a plausible point with a 1,452-unit median error nobody can see. And it does
 * not name item TIMINGS: verified over 22 games and 1,928 events, the LCU timeline carries only
 * `CHAMPION_KILL`, `ELITE_MONSTER_KILL` and `BUILDING_KILL`, and no participant frame carries a
 * purchase. The final build is knowable; when he bought any of it is not.
 *
 * NODE ONLY — reads blobs and the database.
 */

import {
	buildTruth,
	checkpoints,
	seatOf,
	seatsOf,
	truthAt,
	truthEvents
} from "../analysis/game-truth.ts"
import type { Checkpoint, TruthEvent, TruthFrame, TruthRow, TruthSeat } from "../analysis/game-truth.ts"
import type { Game, ParticipantSummary } from "../shared/schema/domain.ts"
import type { LcuTimeline } from "../shared/schema/lcu.ts"
import { fmtClock, fmtDuration } from "../shared/time.ts"

/* ==================================================================== types */

/** One journal frame, as the pack indexes it. The bytes stay on disk until a caller wants them. */
export interface PackFrame {
	id: string
	tSec: number
	clock: string
	path: string
	/** True when the frame carries the ground-truth block the live coach was holding. */
	hasBlock: boolean
}

/** An objective, and where he was when it fell. `gapSec` is how far the answer had to reach. */
export interface PackObjective {
	tSec: number
	clock: string
	what: string
	takenBy: "his" | "enemy"
	takenByChampion: string | null
	/** Where the event happened, in his own frame of reference. */
	zone: string | null
	/** Where HE was at the nearest timeline frame, and how far away that frame was. */
	userZone: string | null
	userGapSec: number | null
	userCs: number | null
	userGold: number | null
	counterpartZone: string | null
}

export interface PackDeath {
	tSec: number
	clock: string
	zone: string | null
	killer: string | null
	assists: string[]
	/** Gold in hand at the nearest frame — what the death was carrying, within a minute. */
	goldInHand: number | null
	gapSec: number | null
}

export interface PackPlayer {
	participantId: number
	side: "his" | "enemy"
	role: string
	championName: string
	isUser: boolean
	isCounterpart: boolean
	kills: number
	deaths: number
	assists: number
	cs: number
	gold: number
	visionScore: number
	champLevel: number
	damageToChampions: number
	/** Item IDS, not names, and no purchase times — see the header. */
	itemIds: number[]
}

export interface GamePack {
	gameId: number
	/** Bumped when the RENDERING changes in a way that should re-review a game. */
	packVersion: number
	champion: string
	role: string
	result: "win" | "loss"
	durationSec: number
	durationClock: string
	patch: string
	queueId: number
	source: {
		timelineFrames: number
		matchParticipants: number
		/** Frames this pack is willing to stand behind — after `framesForThisGame` has attributed. */
		journalFrames: number
		/** Frames recorded under this game's id that turned out to be a different game's run. */
		journalFramesDropped: number
		/** How many runs of the game clock the session held. More than one means it spanned games. */
		journalFrameRuns: number
		/**
		 * Why NO picture could be attributed, in plain words, or null when one was. A session that
		 * spanned two games is no longer a reason on its own — see `framesForThisGame`.
		 */
		journalFramesUnattributed: string | null
	}
	counterpart: { participantId: number; championName: string; how: string } | null
	scoreboard: PackPlayer[]
	checkpoints: {
		askedClock: string
		clock: string
		gapSec: number
		me: { level: number; cs: number; gold: number } | null
		counterpart: { level: number; cs: number; gold: number } | null
		csDiff: number | null
		goldDiff: number | null
	}[]
	minutes: {
		clock: string
		atSec: number
		meCs: number | null
		meGold: number | null
		meLevel: number | null
		meZone: string | null
		cpCs: number | null
		cpGold: number | null
		cpLevel: number | null
		cpZone: string | null
	}[]
	objectives: PackObjective[]
	deaths: PackDeath[]
	frames: PackFrame[]
}

export const PACK_VERSION = 2

/* ================================================================== build */

const round1 = (v: number): number => Math.round(v * 10) / 10

/**
 * Who he was racing.
 *
 * `participant.role` is the ANALYSIS unit's inference from frame positions, not the LCU's
 * `timeline.lane`/`.role`, which labelled four of ten players JUNGLE in one game and is never
 * read anywhere in this app. When the inference did not settle, fall back to the enemy holding
 * Smite — exactly one holder per team in 44 of 44 team games — and say which test answered, so a
 * reader can discount the row rather than trust it blindly.
 */
export const counterpartOf = (
	participants: readonly ParticipantSummary[]
): { participantId: number; championName: string; how: string } | null => {
	const me = participants.find(p => p.isUser)
	if (!me) return null
	const enemies = participants.filter(p => p.teamId !== me.teamId)
	const sameRole = enemies.find(p => p.role === me.role && p.role !== "UNKNOWN")
	if (sameRole)
		return {
			participantId: sameRole.participantId,
			championName: sameRole.championName,
			how: `same inferred role (${me.role})`
		}
	const SMITE = 11
	const smiter = enemies.find(p => p.spell1Id === SMITE || p.spell2Id === SMITE)
	if (smiter)
		return {
			participantId: smiter.participantId,
			championName: smiter.championName,
			how: "the enemy holding Smite — role inference did not settle"
		}
	return null
}

const rowAt = (
	frames: readonly TruthFrame[],
	atSec: number,
	participantId: number | null,
	tolSec = 35
): { row: TruthRow | null; gapSec: number | null } => {
	if (participantId === null) return { row: null, gapSec: null }
	const hit = truthAt(frames, atSec, tolSec)
	if (!hit) return { row: null, gapSec: null }
	return { row: hit.frame.seats[participantId] ?? null, gapSec: hit.gapSec }
}

const objectiveName = (ev: TruthEvent): string => {
	if (ev.kind === "objective") return ev.monsterName ?? ev.type
	const what =
		ev.buildingType === "INHIBITOR_BUILDING" ? "inhibitor"
		: ev.towerType ? String(ev.towerType).replace(/_/g, " ").toLowerCase()
		: "building"
	return `${what}${ev.laneType ? ` (${String(ev.laneType).replace(/_/g, " ").toLowerCase()})` : ""}`
}

export interface BuildPackInput {
	game: Game
	participants: readonly ParticipantSummary[]
	timeline: LcuTimeline | null
	/** Candidates, NOT this game's frames — see `framesForThisGame`. Order does not matter. */
	frames: readonly JournalFrameCandidate[]
}

/* ====================================================== attributing a picture */

/**
 * A frame as it arrives from the journal, before anyone has decided which game it shows.
 *
 * `atMs` is the load-bearing field and it is why `src/db/journal-frames.ts` exists: the game clock
 * restarts at zero every game, so it orders frames WITHIN a run and actively hides the boundary
 * BETWEEN two. Wall clock never restarts.
 */
export interface JournalFrameCandidate {
	id: string
	path: string
	tSec: number
	atMs: number
	truthJson: string | null
}

/** One unbroken run of the game clock inside a session — that is, one game's worth of pictures. */
export interface FrameRun {
	frames: JournalFrameCandidate[]
	/** Wall clock at which this run's game clock read zero. The median over every frame in it. */
	startedMs: number
	/** How far apart those per-frame estimates were. A run holding two games gives a huge number. */
	spreadSec: number
}

/**
 * ONE JOURNAL SESSION CAN HOLD SEVERAL GAMES — so SEGMENT it, do not give up on it.
 *
 * `journal_session` carries one `gameId` and the join goes through it, so every frame of a session
 * that spanned two games comes back under the first game's id. Measured on this install's four
 * screen-shared sessions: `js-mtvxb5f4-f81a` holds 715 frames of TWO games under 5639406342, and
 * `js-mtn2jrku-8ae9` holds 1,470 frames of SEVEN under 5635110604. The other two are clean.
 *
 * The previous rule here declared any such session ambiguous and attached NOTHING, on the premise
 * that two runs put two different pictures on the same game second. That premise was tested and it
 * is an artefact of how the frames were loaded: sorted by the GAME clock, zero of those 715 frames
 * step backwards, because sorting by the game clock is exactly the operation that interleaves two
 * runs into one plausible ascending sequence. Sorted by the WALL clock, precisely one frame steps
 * backwards — 1695.8s to 2.3s, at index 340 — and that step is the boundary between the two games.
 * Six more such steps cut `js-mtn2jrku-8ae9` into seven runs. Across all four sessions that is
 * ELEVEN runs, and every one of them lands within 17 to 95 seconds of a real game's creation time.
 *
 * So the tell is a BACKWARD STEP IN THE GAME CLOCK, read in wall-clock order, and it is not
 * approximate: a game clock that has restarted is a new game, full stop.
 *
 * A run's own consistency is the check that keeps this honest. Every frame implies the wall-clock
 * instant the game clock read zero (`atMs - tSec * 1000`); inside one game those agree to within
 * the clock's own pauses — measured spread across the eleven runs: 0.0, 0.0, 0.0, 0.1, 0.1, 5.2,
 * 5.8, 13.5, 15.5, 75.6, 75.9 seconds — and across two games they would differ by the half-hour
 * between them. A run whose frames cannot agree on when their game started is not one game and is
 * dropped.
 */
const CLOCK_BACKSTEP_SEC = 1

export const segmentFrames = (frames: readonly JournalFrameCandidate[]): FrameRun[] => {
	const ordered = [...frames].sort((a, b) => a.atMs - b.atMs)
	const runs: JournalFrameCandidate[][] = []
	let current: JournalFrameCandidate[] = []
	for (const f of ordered) {
		const previous = current[current.length - 1]
		if (previous !== undefined && f.tSec - previous.tSec < -CLOCK_BACKSTEP_SEC) {
			runs.push(current)
			current = []
		}
		current.push(f)
	}
	if (current.length > 0) runs.push(current)

	return runs.map(run => {
		const zeros = run.map(f => f.atMs - f.tSec * 1_000).sort((a, b) => a - b)
		return {
			frames: run,
			startedMs: zeros[Math.floor(zeros.length / 2)] ?? 0,
			spreadSec: ((zeros[zeros.length - 1] ?? 0) - (zeros[0] ?? 0)) / 1_000
		}
	})
}

/**
 * How far a run's implied start may sit from the game's creation time and still be that game.
 *
 * `gameCreationMs` is stamped before the loading screen; the journal's clock starts at 0:00 in the
 * fountain. Measured across the eleven runs the gap is +17s to +95s — every time positive, and
 * largest on the two runs whose game clock visibly paused early. The window below is two and a
 * half times the largest of those in the direction it actually leans, and it is still an order of
 * magnitude tighter than the ~30 minutes between consecutive games, which is what makes this a
 * test rather than a guess.
 */
const START_FIT_LO_MS = -60_000
const START_FIT_HI_MS = 240_000

/**
 * A run whose frames disagree this much about when their game began is more than one game.
 *
 * Measured maximum inside a real run is 75.9s, which is the game clock pausing on a reconnect. Two
 * games merged into one run would disagree by the thirty minutes between them, so anything in
 * between is headroom; this is four times the measured worst case and 1/6th of the gap it guards.
 */
const RUN_SPREAD_MAX_SEC = 300

export interface FrameAttribution {
	/** The frames that are pictures OF THIS GAME, oldest first by game clock. */
	kept: JournalFrameCandidate[]
	/** How many runs the session's frames fell into. More than one means it spanned games. */
	runs: number
	dropped: number
	/** Null when a run was attributed; otherwise the reason nothing could be, in plain words. */
	unattributed: string | null
}

/**
 * WHICH of a session's runs is this game — answered against the game's own creation time.
 *
 * Refusing is still a supported answer and it still matters: a review illustrated with screenshots
 * of a different match is worse than one with no screenshots at all. What changed is that refusing
 * is now the exception it was meant to be rather than the only outcome the code could reach.
 */
export const framesForThisGame = (
	frames: readonly JournalFrameCandidate[],
	game: { gameCreationMs: number }
): FrameAttribution => {
	if (frames.length === 0) return { kept: [], runs: 0, dropped: 0, unattributed: null }
	const runs = segmentFrames(frames)
	const fits = runs.filter(r => {
		if (r.spreadSec > RUN_SPREAD_MAX_SEC) return false
		const delta = r.startedMs - game.gameCreationMs
		return delta >= START_FIT_LO_MS && delta <= START_FIT_HI_MS
	})
	const refuse = (why: string): FrameAttribution => ({
		kept: [],
		runs: runs.length,
		dropped: frames.length,
		unattributed: why
	})
	if (fits.length === 0)
		return refuse(
			`the session holds ${runs.length} run(s) of the game clock and none of them starts when this game did`
		)
	if (fits.length > 1)
		return refuse(`${fits.length} runs in the session start when this game did, so no picture can be told apart`)
	const kept = [...(fits[0]?.frames ?? [])].sort((a, b) => a.tSec - b.tSec)
	return { kept, runs: runs.length, dropped: frames.length - kept.length, unattributed: null }
}

/** Marks the checkpoint table asks for. Anything past the last frame is dropped, never faked. */
const MARKS = [300, 600, 840, 1200, 1500, 1800, 2100, 2400]

export const buildGamePack = (input: BuildPackInput): GamePack => {
	const { game, participants, timeline } = input
	const seats = seatsOf(
		participants.map(p => ({
			participantId: p.participantId,
			teamId: p.teamId,
			riotId: p.riotId,
			championName: p.championName,
			role: p.role,
			isUser: p.isUser
		}))
	)
	const me = seats.find(s => s.isUser) ?? null
	const cp = counterpartOf(participants)
	const cpSeat = cp === null ? null : seatOf(seats, cp.participantId)

	const truth = buildTruth(timeline, seats)
	const events = truthEvents(timeline, seats)

	const scoreboard: PackPlayer[] = participants
		.map(p => ({
			participantId: p.participantId,
			side: (me && p.teamId === me.teamId ? "his" : "enemy") as "his" | "enemy",
			role: p.role,
			championName: p.championName,
			isUser: p.isUser,
			isCounterpart: cp !== null && p.participantId === cp.participantId,
			kills: p.kills,
			deaths: p.deaths,
			assists: p.assists,
			// Effective CS: lane minions PLUS camps. Every farm figure in this app means this.
			cs: p.cs + p.jungleCs,
			gold: p.gold,
			visionScore: p.visionScore,
			champLevel: p.champLevel,
			damageToChampions: p.damageToChampions,
			itemIds: (p.items ?? []).filter(i => i > 0)
		}))
		.sort((a, b) => (a.side === b.side ? a.participantId - b.participantId : a.side === "his" ? -1 : 1))

	const marks = checkpoints(truth, MARKS)
	const packCheckpoints = marks.map((c: Checkpoint) => {
		const mine = me === null ? null : (c.rows[me.participantId] ?? null)
		const theirs = cpSeat === null ? null : (c.rows[cpSeat.participantId] ?? null)
		return {
			askedClock: c.askedClock,
			clock: c.clock,
			gapSec: c.gapSec,
			me: mine === null ? null : { level: mine.level, cs: mine.cs, gold: mine.totalGold },
			counterpart:
				theirs === null ? null : { level: theirs.level, cs: theirs.cs, gold: theirs.totalGold },
			csDiff: mine && theirs ? mine.cs - theirs.cs : null,
			goldDiff: mine && theirs ? mine.totalGold - theirs.totalGold : null
		}
	})

	const minutes = truth.map(f => {
		const mine = me === null ? null : (f.seats[me.participantId] ?? null)
		const theirs = cpSeat === null ? null : (f.seats[cpSeat.participantId] ?? null)
		return {
			clock: f.clock,
			atSec: f.atSec,
			meCs: mine?.cs ?? null,
			meGold: mine?.totalGold ?? null,
			meLevel: mine?.level ?? null,
			meZone: mine?.zone ?? null,
			cpCs: theirs?.cs ?? null,
			cpGold: theirs?.totalGold ?? null,
			cpLevel: theirs?.level ?? null,
			cpZone: theirs?.zone ?? null
		}
	})

	const objectives: PackObjective[] = events
		.filter(ev => ev.kind === "objective" || ev.kind === "building")
		.map(ev => {
			const mine = rowAt(truth, ev.atSec, me?.participantId ?? null)
			const theirs = rowAt(truth, ev.atSec, cpSeat?.participantId ?? null)
			return {
				tSec: ev.atSec,
				clock: ev.clock,
				what: objectiveName(ev),
				/*
				 * The killer's own side is the primary answer, including for buildings. The
				 * fallback matters: a turret taken by a minion wave has `killerId: 0`, which
				 * seats no player, and `BUILDING_KILL.teamId` is the team that LOST it — so the
				 * side that took it is the other one.
				 */
				takenBy: ev.killerSide ?? (ev.belongedTo === "his" ? "enemy" : "his"),
				takenByChampion: ev.killer?.championName ?? null,
				zone: ev.zone,
				userZone: mine.row?.zone ?? null,
				userGapSec: mine.gapSec,
				userCs: mine.row?.cs ?? null,
				userGold: mine.row?.totalGold ?? null,
				counterpartZone: theirs.row?.zone ?? null
			}
		})

	const deaths: PackDeath[] = events
		.filter(ev => ev.kind === "kill" && ev.victim?.isUser === true)
		.map(ev => {
			const mine = rowAt(truth, ev.atSec, me?.participantId ?? null)
			return {
				tSec: ev.atSec,
				clock: ev.clock,
				zone: ev.zone,
				killer: ev.killer?.championName ?? null,
				assists: ev.assists.map(a => a.championName),
				goldInHand: mine.row?.goldInHand ?? null,
				gapSec: mine.gapSec
			}
		})

	const usable = framesForThisGame(input.frames, game)
	const frames: PackFrame[] = usable.kept.map(f => ({
		id: f.id,
		tSec: round1(f.tSec),
		clock: fmtClock(f.tSec),
		path: f.path,
		hasBlock: f.truthJson !== null
	}))

	return {
		gameId: game.gameId,
		packVersion: PACK_VERSION,
		champion: game.championName,
		role: game.role,
		result: game.win ? "win" : "loss",
		durationSec: game.gameDurationSec,
		durationClock: fmtDuration(game.gameDurationSec),
		patch: game.patch,
		queueId: game.queueId,
		source: {
			timelineFrames: truth.length,
			matchParticipants: participants.length,
			journalFrames: frames.length,
			journalFramesDropped: usable.dropped,
			journalFrameRuns: usable.runs,
			journalFramesUnattributed: usable.unattributed
		},
		counterpart: cp,
		scoreboard,
		checkpoints: packCheckpoints,
		minutes,
		objectives,
		deaths,
		frames
	}
}

/* ================================================================= render */

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length))
const padL = (s: string, n: number): string => (s.length >= n ? s : " ".repeat(n - s.length) + s)
const g = (v: number | null): string => (v === null ? "?" : Math.round(v).toLocaleString("en-US"))
const signed = (v: number | null): string => (v === null ? "?" : v > 0 ? `+${g(v)}` : g(v))

/**
 * The pack as text, for a prompt.
 *
 * Every table states its own source in its heading, because a reader that cannot tell the
 * timeline from the client is exactly how the 70-against-183 review got written. The counterpart
 * columns are labelled with the word EXACT for the same reason: hedging a number that is exact
 * teaches him to discount the figures that are solid.
 */
export const renderPack = (p: GamePack): string => {
	const L: string[] = []
	const w = (s = ""): void => {
		L.push(s)
	}

	w(`## THE POST-GAME PACK — game ${p.gameId}`)
	w()
	w(
		`Everything below is the INGESTED POST-GAME RECORD: the match (end-of-game totals, exact) and the timeline (${p.source.timelineFrames} frames, one a minute, EXACT FOR ALL TEN PLAYERS including levels, CS, gold and position).`
	)
	w(
		`It is NOT the live client feed. The feed's enemy CS is a visibility counter that read 70 where the truth was 183 in one measured game; nothing in this section comes from it. Cite these figures straight, with no hedge about staleness.`
	)
	w()
	w(`${p.champion} ${p.role} · ${p.result.toUpperCase()} in ${p.durationClock} · patch ${p.patch}`)
	if (p.counterpart)
		w(`Counterpart: ${p.counterpart.championName} — ${p.counterpart.how}. This is the man he is racing.`)
	else w(`Counterpart: UNKNOWN — no enemy matched his role and none held Smite. Do not invent one.`)
	w()

	w(`### END OF GAME — from the match. Exact.`)
	w()
	w(
		`${pad("", 4)}${pad("champion", 14)} ${pad("role", 8)} ${pad("K/D/A", 9)} ${padL("CS", 4)} ${padL("gold", 7)} ${padL("dmg", 7)} ${padL("vis", 4)} ${padL("lvl", 4)}  items (IDS — the timeline has no purchase times)`
	)
	for (const s of p.scoreboard)
		w(
			`${pad(s.isUser ? "HIM" : s.isCounterpart ? "CP" : s.side === "his" ? "" : "e", 4)}${pad(s.championName, 14)} ${pad(s.role, 8)} ${pad(`${s.kills}/${s.deaths}/${s.assists}`, 9)} ${padL(String(s.cs), 4)} ${padL(g(s.gold), 7)} ${padL(g(s.damageToChampions), 7)} ${padL(String(s.visionScore), 4)} ${padL(String(s.champLevel), 4)}  ${s.itemIds.join(" ")}`
		)
	w()

	if (p.counterpart && p.checkpoints.length > 0) {
		w(`### CHECKPOINTS — him against ${p.counterpart.championName}. Both columns EXACT.`)
		w(`A row's "frame" is the timeline frame that answered; frames drift off the minute, so the gap is stated.`)
		w()
		w(
			`${pad("asked", 7)} ${pad("frame", 7)} ${pad("gap", 5)} ${pad("him: lvl/CS/gold", 24)} ${pad(`${p.counterpart.championName}: lvl/CS/gold`, 26)} ${pad("CS diff", 9)} gold diff`
		)
		const cell = (r: { level: number; cs: number; gold: number } | null): string =>
			r === null ? "—" : `lvl ${padL(String(r.level), 2)}  ${padL(String(r.cs), 3)} CS  ${padL(g(r.gold), 6)}g`
		for (const c of p.checkpoints)
			w(
				`${pad(c.askedClock, 7)} ${pad(c.clock, 7)} ${pad(`${c.gapSec}s`, 5)} ${pad(cell(c.me), 24)} ${pad(cell(c.counterpart), 26)} ${pad(signed(c.csDiff), 9)} ${signed(c.goldDiff)}`
			)
		w()
	}

	if (p.objectives.length > 0) {
		w(`### OBJECTIVES — and WHERE HE WAS when each one fell.`)
		w(
			`The event has an exact millisecond; the frames are a minute apart. "he was" is the NEAREST frame and "gap" is how far it had to reach. A gap over about 20s is a fact about a different moment — say so or say nothing.`
		)
		w()
		w(`${pad("clock", 7)} ${pad("what", 24)} ${pad("taken by", 16)} ${pad("gap", 5)} he was`)
		for (const o of p.objectives)
			w(
				`${pad(o.clock, 7)} ${pad(o.what, 24)} ${pad(`${o.takenBy === "his" ? "HIS TEAM" : "ENEMY"}${o.takenByChampion ? ` (${o.takenByChampion})` : ""}`, 16)} ${pad(o.userGapSec === null ? "—" : `${o.userGapSec}s`, 5)} ${o.userZone ?? "unknown"}${o.userCs === null ? "" : ` · ${o.userCs} CS · ${g(o.userGold)}g`}`
			)
		w()
	}

	if (p.deaths.length > 0) {
		w(`### HIS DEATHS — position is the KILL's own position, exact.`)
		w()
		w(`${pad("clock", 7)} ${pad("zone", 34)} ${pad("killer", 14)} gold in hand (nearest frame)`)
		for (const d of p.deaths)
			w(
				`${pad(d.clock, 7)} ${pad(d.zone ?? "unknown", 34)} ${pad(d.killer ?? "?", 14)} ${d.goldInHand === null ? "—" : `${g(d.goldInHand)}g (${d.gapSec}s away)`}${d.assists.length > 0 ? `  assists: ${d.assists.join(", ")}` : ""}`
			)
		w()
	}

	if (p.counterpart && p.minutes.length > 0) {
		w(`### EVERY FRAME — him and ${p.counterpart.championName}, with the zone each was standing in.`)
		w()
		w(
			`${pad("clock", 7)} ${pad("him", 46)} ${pad(p.counterpart.championName, 46)} ${pad("CS", 8)} gold`
		)
		const cell = (
			lvl: number | null,
			cs: number | null,
			gold: number | null,
			zone: string | null
		): string =>
			lvl === null ? "—" : `lvl ${padL(String(lvl), 2)} ${padL(String(cs), 3)}CS ${padL(g(gold), 6)}g ${zone ?? "?"}`
		for (const m of p.minutes)
			w(
				`${pad(m.clock, 7)} ${pad(cell(m.meLevel, m.meCs, m.meGold, m.meZone), 46)} ${pad(cell(m.cpLevel, m.cpCs, m.cpGold, m.cpZone), 46)} ${pad(signed(m.meCs !== null && m.cpCs !== null ? m.meCs - m.cpCs : null), 8)} ${signed(m.meGold !== null && m.cpGold !== null ? m.meGold - m.cpGold : null)}`
			)
		w()
	}

	if (p.source.journalFramesUnattributed !== null)
		w(
			`### FRAMES — NONE ATTACHED. ${p.source.journalFramesDropped} were recorded under this game's id, but ${p.source.journalFramesUnattributed}. Do not refer to anything you would only know from a screenshot.\n`
		)
	if (p.frames.length > 0) {
		w(`### FRAMES — his own screen, recorded while he played.`)
		w(
			`${p.frames.length} frames from ${p.frames[0]?.clock} to ${p.frames[p.frames.length - 1]?.clock}. The ones attached to this message are listed in the FRAMES ATTACHED section; the rest exist and are not being shown.`
		)
		if (p.source.journalFrameRuns > 1)
			w(
				`The session they came from recorded ${p.source.journalFrameRuns} games; these are the run whose game clock started when THIS game did, and the other ${p.source.journalFramesDropped} frames were left out.`
			)
		w()
	}

	w(`### WHAT THIS PACK DOES NOT CONTAIN — refuse to guess at any of it`)
	w(
		`- ITEM PURCHASE TIMES. Verified over 22 games and 1,928 events: the LCU timeline carries only champion kills, elite monsters and buildings, and no participant frame carries a purchase. The final build above is exact; WHEN he bought any of it is unknowable.`
	)
	w(`- WARD PLACEMENTS. There is a vision SCORE and no ward map.`)
	w(`- SKILL ORDER, summoner spell timers, and who was in vision of whom.`)
	w(
		`- POSITIONS BETWEEN FRAMES. Frames are a minute apart and the median movement between two is about 28% of the map. Every position above is AT a frame and carries its gap.`
	)
	w()
	return L.join("\n")
}
