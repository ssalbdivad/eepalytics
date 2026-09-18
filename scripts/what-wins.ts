/**
 * WHAT ACTUALLY SEPARATES HIS WINS FROM HIS LOSSES — the first measurement in this campaign that
 * asks whether the product points him at anything that wins HIS games.
 *
 * Every other instrument here grades a LINE: was it true, was it useful, was it worth its latency.
 * None of them can tell you whether the thing the coach keeps pushing him toward is a thing that
 * distinguishes the games he wins from the games he loses. That question is answerable without a
 * model at all, from 141 of his own games with full post-game timelines, and this is that answer.
 *
 *     node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/what-wins.ts
 *       [--out data/eval/what-wins-<date>.json] [--all-queues] [--min-sec 900] [--seed 20260918]
 *
 * ## The design, and the three things it refuses to do
 *
 * ONE PLAYER, ONE ROLE, ONE CHAMPION, mostly: 142 of 153 stored games are Lillia and 152 of 153
 * are jungle. That is the population this generalises to and no further. It is not a claim about
 * junglers; it is a claim about him.
 *
 * NOTHING HERE IS A CAUSAL ESTIMATE. Every row carries a `causalCaveat` and the field is not
 * decoration — it is the difference between a coachable finding and a restatement of the
 * scoreboard. Deaths separate wins from losses in every player's data ever collected, and mostly
 * because a losing game manufactures deaths: you are behind, you contest anyway, you die. Reading
 * that row as "die less and you will win" is the exact error this file is built to prevent.
 *
 * THE CHECKPOINT IS PART OF THE FINDING. A metric that separates at 10:00 can still be acted on
 * at 10:00. A metric that separates only at the whistle is a description of how the game ended.
 * Every row therefore says the minute by which it is KNOWN, and the report ranks the early block
 * on its own, because that block is the only one a live coach can ever use.
 *
 * ## Three instruments, because a table of p-values is not a thesis
 *
 *   1. UNIVARIATE. Mann-Whitney on won against lost, AUC as the effect size with a seeded
 *      bootstrap interval, Cohen's d and the raw means beside it, and Benjamini-Hochberg
 *      q-values across the whole table. AUC because it reads in plain words: 0.70 means that
 *      seven times in ten, a game drawn from the won pile is the higher one.
 *
 *   2. THE SCOREBOARD CONTROL. For every metric known by 15:00, a two-term logistic regression
 *      on the metric AND the team gold difference at 10:00. A metric whose odds ratio collapses
 *      to 1 once the scoreboard is in the model was never telling you anything except that he
 *      was already ahead. This is the instrument that separates "do this" from "this happens
 *      when you are winning".
 *
 *   3. THE EVEN-AT-TEN STRATUM. The same univariate test restricted to games where the team gold
 *      difference at 10:00 is inside +/-800g — games that were still live. Fewer games, wider
 *      intervals, and the only place where a positive is close to a decision rather than an
 *      outcome. Reported with its n so a reader can see how little it can carry.
 *
 * ## What it will not tell you
 *
 * There is no experiment here. He cannot be randomised into taking more camps. Everything below
 * is observational, on one player, and the honest ceiling of the whole exercise is "this is where
 * to look", not "this is what to do". A metric that separates might be a lever, a symptom, or a
 * shadow of a third thing — and for several of them the caveat says exactly which it is.
 */
import { writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import {
	benjaminiHochberg,
	bootstrap2,
	cohensD,
	logisticFit,
	mannWhitney,
	meanOf,
	sdOf,
	type Interval95,
	type MannWhitney
} from "./lib/stats.ts"
import { framesOf, interpScalar, median, pfOf, round, stepScalar } from "../src/analysis/frames.ts"
import { detectBacks, jungleFarmSplit, positioning } from "../src/analysis/metrics.ts"
import { BLOB_MATCH, BLOB_TIMELINE, readBlob } from "../src/db/blobs.ts"
import { DB_PATH } from "../src/shared/constants.ts"
import { classifyZone, dist, half, PITS, type Pos, type TeamId } from "../src/shared/map.ts"
import type { LcuEvent, LcuFrame, LcuGame, LcuTimeline } from "../src/shared/schema/lcu.ts"
import { wilson } from "../src/analysis/coach-score.ts"

/* ==================================================================== inputs */

interface GameRow {
	gameId: number
	win: number
	queueId: number
	gameDurationSec: number
	championName: string
	participantId: number
	teamId: number
}

interface SeatRow {
	participantId: number
	teamId: number
	championName: string
	role: string
	isUser: number
}

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

const SEED = Number(arg("seed", "20260918"))
const MIN_SEC = Number(arg("min-sec", "900"))
const TODAY = "20260918"
const OUT = arg("out", `data/eval/what-wins-${TODAY}.json`)

/* ================================================================== features */

/** One game, reduced to the numbers a jungler's game is supposed to turn on. */
interface Features {
	gameId: number
	win: boolean
	durationSec: number
	championName: string
	counterpartChampion: string | null
	[key: string]: number | boolean | string | null
}

const CHECKPOINTS = [10, 14, 20] as const

/** `null` whenever the frame that would answer does not exist — never the last frame's value. */
const at = (
	frames: LcuFrame[],
	pid: number,
	min: number,
	field: Parameters<typeof interpScalar>[3]
): number | null => interpScalar(frames, pid, min * 60_000, field)

const teamGoldAt = (frames: LcuFrame[], pids: number[], min: number): number | null => {
	let sum = 0
	for (const pid of pids) {
		const g = at(frames, pid, min, "totalGold")
		if (g === null) return null
		sum += g
	}
	return sum
}

/** The position he was at nearest to `ms`, and how far the frame that answered was. */
const nearestFramePos = (
	frames: LcuFrame[],
	pid: number,
	ms: number
): { pos: Pos; gapMs: number } | null => {
	let best: { pos: Pos; gapMs: number } | null = null
	for (const f of frames) {
		const pf = pfOf(f, pid)
		if (!pf) continue
		const gap = Math.abs(f.timestamp - ms)
		if (best === null || gap < best.gapMs) best = { pos: pf.position, gapMs: gap }
	}
	return best
}

/**
 * Modelled seconds spent dead. THIS IS A MODEL, NOT A MEASUREMENT — the LCU match blob has no
 * `totalTimeSpentDead` field (checked on all 141 games) and the timeline has no respawn events,
 * so the only way to get it is the game's own published respawn formula applied to his level at
 * the death and the game clock. Base wait by level plus the time-increase factor that starts at
 * 15:00. It is right to within a couple of seconds per death when the level read is right, and
 * the level read comes from a frame up to 60s away. Quoted as "modelled" everywhere it appears,
 * and never spoken to him.
 */
const BRW = [10, 10, 12, 12, 14, 16, 20, 21, 22, 24, 25, 28, 32.5, 35, 37.5, 40, 42.5, 45]
const modelledDeadSec = (frames: LcuFrame[], pid: number, deaths: LcuEvent[]): number => {
	let total = 0
	for (const d of deaths) {
		const lvl = stepScalar(frames, pid, d.timestamp, "level") ?? 1
		const base = BRW[Math.max(0, Math.min(BRW.length - 1, Math.round(lvl) - 1))]!
		const min = d.timestamp / 60_000
		const tif =
			min < 15 ? 0
			: min < 30 ? (min - 15) * 0.00425
			: min < 45 ? 0.0425 + (min - 30) * 0.003
			: 0.0875 + (min - 45) * 0.0145
		total += base * (1 + Math.min(0.5, tif))
	}
	return total
}

/**
 * A rate inside one window, `(value at `to` − value at `from`) / minutes`. `null` when either end
 * is outside the recorded frames, which DROPS every game that ended before the window closed —
 * so a window-20-to-25 row is computed on long games only and its n says so.
 *
 * Windows are the instrument that answers the question a whole-game rate cannot: not "did his farm
 * rate differ" but "from what minute did it start differing".
 */
const windowRate = (
	frames: LcuFrame[],
	pid: number,
	fromMin: number,
	toMin: number,
	field: Parameters<typeof interpScalar>[3]
): number | null => {
	const a = at(frames, pid, fromMin, field)
	const b = at(frames, pid, toMin, field)
	return a === null || b === null ? null : (b - a) / (toMin - fromMin)
}

/** Share of the frames inside a window that put him in the enemy half. `null` under 3 frames. */
const enemyHalfShareIn = (
	frames: LcuFrame[],
	pid: number,
	teamId: TeamId,
	fromMin: number,
	toMin: number
): number | null => {
	let inWindow = 0
	let enemy = 0
	for (const f of frames) {
		if (f.timestamp <= fromMin * 60_000 || f.timestamp > toMin * 60_000) continue
		const pf = pfOf(f, pid)
		if (!pf) continue
		inWindow++
		if (half(pf.position, teamId) === "enemy") enemy++
	}
	return inWindow < 3 ? null : enemy / inWindow
}

/**
 * Camps he cleared inside a window, split by the half he stood in at the frame the camp finished
 * on — the same attribution `jungleFarmSplit` uses, windowed. A camp cleared at 7:59 is credited
 * to the 8:00 position, which is the resolution one frame a minute buys.
 */
const campsIn = (
	frames: LcuFrame[],
	pid: number,
	teamId: TeamId,
	fromMin: number,
	toMin: number
): { total: number; enemy: number; frames: number } => {
	let total = 0
	let enemy = 0
	let used = 0
	for (let i = 1; i < frames.length; i++) {
		const f = frames[i]!
		if (f.timestamp <= fromMin * 60_000 || f.timestamp > toMin * 60_000) continue
		const a = pfOf(frames[i - 1]!, pid)
		const b = pfOf(f, pid)
		if (!a || !b) continue
		used++
		const d = b.jungleMinionsKilled - a.jungleMinionsKilled
		if (d <= 0) continue
		total += d
		if (half(b.position, teamId) === "enemy") enemy += d
	}
	return { total, enemy, frames: used }
}

const featuresOf = (row: GameRow, seats: SeatRow[]): Features | null => {
	const timeline = readBlob<LcuTimeline>(row.gameId, BLOB_TIMELINE)
	const match = readBlob<LcuGame>(row.gameId, BLOB_MATCH)
	if (!timeline || !match) return null
	const frames = framesOf(timeline)
	if (frames.length < 6) return null

	const me = row.participantId
	const myTeam = row.teamId as TeamId
	const allies = seats.filter(s => s.teamId === row.teamId && s.participantId !== me).map(s => s.participantId)
	const enemies = seats.filter(s => s.teamId !== row.teamId).map(s => s.participantId)
	const myTeamAll = [me, ...allies]
	const counterpart = seats.find(s => s.teamId !== row.teamId && s.role === "JGL") ?? null
	const cp = counterpart?.participantId ?? null

	const stats = match.participants.find(p => p.participantId === me)?.stats
	if (!stats) return null
	const teamDamage = match.participants
		.filter(p => p.teamId === row.teamId)
		.reduce((s, p) => s + (p.stats.totalDamageDealtToChampions ?? 0), 0)

	const events: LcuEvent[] = []
	for (const f of frames) if (f.events) events.push(...f.events)
	events.sort((a, b) => a.timestamp - b.timestamp)

	const kills = events.filter(e => e.type === "CHAMPION_KILL")
	const myDeaths = kills.filter(e => e.victimId === me)
	const teamKills = kills.filter(e => e.killerId !== undefined && myTeamAll.includes(e.killerId))
	const involved = (e: LcuEvent): boolean =>
		e.killerId === me || (e.assistingParticipantIds ?? []).includes(me)
	const durMin = Math.max(1 / 60, row.gameDurationSec / 60)

	const before = (e: LcuEvent, min: number): boolean => e.timestamp < min * 60_000
	const countKills = (min: number): number => teamKills.filter(e => before(e, min)).length
	const countInvolved = (min: number): number =>
		teamKills.filter(e => before(e, min) && involved(e)).length

	/** The first champion kill of the game, whoever made it. `firstBloodKill` in stats agrees. */
	const firstKill = kills[0] ?? null

	const monsters = events.filter(e => e.type === "ELITE_MONSTER_KILL")
	const tookIt = (e: LcuEvent): boolean => e.killerId !== undefined && myTeamAll.includes(e.killerId)
	const dragons = monsters.filter(e => e.monsterType === "DRAGON")
	const grubs = monsters.filter(e => e.monsterType === "HORDE")
	const heralds = monsters.filter(e => e.monsterType === "RIFTHERALD")
	const barons = monsters.filter(e => e.monsterType === "BARON_NASHOR")

	const buildings = events.filter(e => e.type === "BUILDING_KILL")
	// `BUILDING_KILL.teamId` is the team that LOST the building.
	const towersTakenBy = (min: number): number =>
		buildings.filter(e => before(e, min) && e.teamId !== row.teamId).length
	const towersLostBy = (min: number): number =>
		buildings.filter(e => before(e, min) && e.teamId === row.teamId).length

	const backs = detectBacks(frames, me)
	const jungleSplit = jungleFarmSplit(frames, me, myTeam, row.gameDurationSec)
	const pos = positioning(frames, me, myTeam, allies, enemies)

	const currentGolds: number[] = []
	for (const f of frames) {
		if (f.timestamp <= 60_000) continue
		const pf = pfOf(f, me)
		if (pf) currentGolds.push(pf.currentGold)
	}

	/**
	 * How far he was from the pit when his team took an objective, using the NEAREST frame and
	 * dropping any answer more than 40s away. One frame a minute means this is coarse — it is a
	 * "was he in the neighbourhood" reading, not a claim he was in the pit.
	 */
	const objectiveDistances: number[] = []
	for (const e of monsters) {
		if (!tookIt(e)) continue
		const pit =
			e.monsterType === "DRAGON" ? PITS.DRAGON
			: e.monsterType === "BARON_NASHOR" ? PITS.BARON
			: e.monsterType === "RIFTHERALD" ? PITS.HERALD
			: PITS.GRUBS
		const near = nearestFramePos(frames, me, e.timestamp)
		if (near && near.gapMs <= 40_000) objectiveDistances.push(dist(near.pos, pit))
	}

	const deathsBefore = (min: number): number => myDeaths.filter(e => before(e, min)).length
	const deathsInEnemyHalf = (min: number): number =>
		myDeaths.filter(
			e => before(e, min) && e.position !== undefined && half(e.position, myTeam) === "enemy"
		).length

	const f: Features = {
		gameId: row.gameId,
		win: row.win === 1,
		durationSec: row.gameDurationSec,
		championName: row.championName,
		counterpartChampion: counterpart?.championName ?? null,
		frameCount: frames.length
	}

	for (const m of CHECKPOINTS) {
		const lane = at(frames, me, m, "minionsKilled")
		const jgl = at(frames, me, m, "jungleMinionsKilled")
		const gold = at(frames, me, m, "totalGold")
		const xp = at(frames, me, m, "xp")
		const lvl = stepScalar(frames, me, m * 60_000, "level")
		f[`cs@${m}`] = lane === null || jgl === null ? null : round(lane + jgl, 1)
		f[`gold@${m}`] = gold === null ? null : round(gold, 0)
		f[`xp@${m}`] = xp === null ? null : round(xp, 0)
		f[`level@${m}`] = lvl
		const cpLane = cp === null ? null : at(frames, cp, m, "minionsKilled")
		const cpJgl = cp === null ? null : at(frames, cp, m, "jungleMinionsKilled")
		const cpGold = cp === null ? null : at(frames, cp, m, "totalGold")
		const cpXp = cp === null ? null : at(frames, cp, m, "xp")
		const cpLvl = cp === null ? null : stepScalar(frames, cp, m * 60_000, "level")
		f[`csDiffVsJgl@${m}`] =
			lane === null || jgl === null || cpLane === null || cpJgl === null ?
				null
			:	round(lane + jgl - cpLane - cpJgl, 1)
		f[`goldDiffVsJgl@${m}`] = gold === null || cpGold === null ? null : round(gold - cpGold, 0)
		f[`xpDiffVsJgl@${m}`] = xp === null || cpXp === null ? null : round(xp - cpXp, 0)
		f[`levelDiffVsJgl@${m}`] = lvl === null || cpLvl === null ? null : lvl - cpLvl
		const mine = teamGoldAt(frames, myTeamAll, m)
		const theirs = teamGoldAt(frames, enemies, m)
		f[`teamGoldDiff@${m}`] = mine === null || theirs === null ? null : round(mine - theirs, 0)
		f[`deathsBy@${m}`] = deathsBefore(m)
		f[`killsInvolvedBy@${m}`] = countInvolved(m)
		f[`kpBy@${m}`] = countKills(m) === 0 ? null : round(countInvolved(m) / countKills(m), 4)
		f[`towerDiffBy@${m}`] = towersTakenBy(m) - towersLostBy(m)
	}

	/* ---- WHEN does it diverge? The same rates, window by window. */
	const WINDOWS: [number, number][] = [
		[0, 10],
		[10, 15],
		[15, 20],
		[20, 25]
	]
	for (const [from, to] of WINDOWS) {
		const tag = `${from}-${to}`
		const lane = windowRate(frames, me, from, to, "minionsKilled")
		const jgl = windowRate(frames, me, from, to, "jungleMinionsKilled")
		const gold = windowRate(frames, me, from, to, "totalGold")
		const xp = windowRate(frames, me, from, to, "xp")
		f[`csPerMin@${tag}`] = lane === null || jgl === null ? null : round(lane + jgl, 3)
		f[`goldPerMin@${tag}`] = gold === null ? null : round(gold, 1)
		f[`xpPerMin@${tag}`] = xp === null ? null : round(xp, 1)
		const eh = enemyHalfShareIn(frames, me, myTeam, from, to)
		f[`enemyHalfShare@${tag}`] = eh === null ? null : round(eh, 4)
		const camps = campsIn(frames, me, myTeam, from, to)
		f[`enemyCampShare@${tag}`] =
			camps.total < 4 || row.gameDurationSec < to * 60 ? null : round(camps.enemy / camps.total, 4)
		f[`deaths@${tag}`] =
			row.gameDurationSec < to * 60 ?
				null
			:	myDeaths.filter(e => e.timestamp > from * 60_000 && e.timestamp <= to * 60_000).length
	}

	/**
	 * Deaths in an ENEMY JUNGLE zone specifically — not merely the enemy half, which includes
	 * every gank he died on in a lane. This is the exact play the shipped review prompt calls
	 * "the single most common way a jungler throws a lead", so it gets its own row.
	 */
	const enemyJungleDeaths = (min: number): number =>
		myDeaths.filter(
			e =>
				e.timestamp < min * 60_000 &&
				e.position !== undefined &&
				classifyZone(e.position, myTeam).startsWith("ENEMY_JUNGLE")
		).length
	f["deathsInEnemyJungleBy15"] = enemyJungleDeaths(15)
	f["deathsInEnemyJungle"] = enemyJungleDeaths(9999)

	f["csPerMin"] = round((stats.totalMinionsKilled + stats.neutralMinionsKilled) / durMin, 2)
	f["goldPerMin"] = round(stats.goldEarned / durMin, 1)
	f["deaths"] = stats.deaths
	f["deathsPer10Min"] = round((stats.deaths / durMin) * 10, 2)
	f["deathsBy15"] = deathsBefore(15)
	f["deathsInEnemyHalfBy15"] = deathsInEnemyHalf(15)
	f["deathsInEnemyHalf"] = deathsInEnemyHalf(999)
	f["firstDeathMin"] = myDeaths.length === 0 ? null : round(myDeaths[0]!.timestamp / 60_000, 2)
	f["kp"] = teamKills.length === 0 ? null : round(countInvolved(999) / teamKills.length, 4)
	f["firstBloodInvolved"] = firstKill === null ? null : involved(firstKill) ? 1 : 0
	f["firstKillMin"] = firstKill === null ? null : round(firstKill.timestamp / 60_000, 2)
	f["visionScore"] = stats.visionScore
	f["visionPerMin"] = round(stats.visionScore / durMin, 3)
	f["wardsPlaced"] = stats.wardsPlaced ?? null
	f["wardsKilled"] = stats.wardsKilled ?? null
	f["controlWardsBought"] = stats.visionWardsBoughtInGame ?? null
	f["enemyJungleShare"] = round(jungleSplit.enemyShare, 4)
	f["campsPerMinute"] = round(jungleSplit.campsPerMinute, 3)
	f["firstBackMin"] = backs.length === 0 ? null : backs[0]!.windowEndMin
	f["meanGoldInHand"] = currentGolds.length === 0 ? null : round(meanOf(currentGolds), 0)
	f["maxGoldInHand"] = currentGolds.length === 0 ? null : Math.max(...currentGolds)
	f["damageShare"] = teamDamage === 0 ? null : round(stats.totalDamageDealtToChampions / teamDamage, 4)
	f["dragonsTaken"] = dragons.filter(tookIt).length
	f["dragonsConceded"] = dragons.filter(e => !tookIt(e)).length
	f["dragonDiff"] = dragons.filter(tookIt).length - dragons.filter(e => !tookIt(e)).length
	f["firstDragonMine"] = dragons.length === 0 ? null : tookIt(dragons[0]!) ? 1 : 0
	f["grubDiff"] = grubs.filter(tookIt).length - grubs.filter(e => !tookIt(e)).length
	f["heraldDiff"] = heralds.filter(tookIt).length - heralds.filter(e => !tookIt(e)).length
	f["baronDiff"] = barons.filter(tookIt).length - barons.filter(e => !tookIt(e)).length
	f["earlyObjectiveDiffBy10"] =
		[...dragons, ...grubs, ...heralds].filter(e => before(e, 10) && tookIt(e)).length -
		[...dragons, ...grubs, ...heralds].filter(e => before(e, 10) && !tookIt(e)).length
	f["grubDiffBy10"] =
		grubs.filter(e => before(e, 10) && tookIt(e)).length -
		grubs.filter(e => before(e, 10) && !tookIt(e)).length
	f["firstDragonMin"] = dragons.length === 0 ? null : round(dragons[0]!.timestamp / 60_000, 2)
	f["earlyObjectiveDiffBy15"] =
		[...dragons, ...grubs, ...heralds].filter(e => before(e, 15) && tookIt(e)).length -
		[...dragons, ...grubs, ...heralds].filter(e => before(e, 15) && !tookIt(e)).length
	f["medianDistAtOwnObjective"] =
		objectiveDistances.length === 0 ? null : round(median(objectiveDistances), 0)
	f["modelledDeadSec"] = round(modelledDeadSec(frames, me, myDeaths), 0)
	f["modelledDeadShare"] = round(modelledDeadSec(frames, me, myDeaths) / row.gameDurationSec, 4)
	f["enemyHalfFrameShare"] = round(pos.halfShare.enemy, 4)
	f["p90OverExtension"] = round(pos.p90OverExtension, 4)
	f["medianDistFromTeam"] = round(pos.medianCentroidDist, 0)
	f["surrendered"] = stats.gameEndedInSurrender ? 1 : 0
	return f
}

/* =================================================================== metrics */

type Control = "his" | "shared" | "not-his"

interface Spec {
	key: string
	label: string
	/** The minute by which the value is KNOWN. `null` is a whole-game total. */
	knownAtMin: number | null
	control: Control
	/** Why this row may not mean what it looks like. Never optional, never boilerplate. */
	causalCaveat: string
}

const SPECS: Spec[] = [
	/* -------- farm and tempo */
	{
		key: "cs@10",
		label: "CS at 10:00 (camps + lane minions)",
		knownAtMin: 10,
		control: "his",
		causalCaveat:
			"Mostly his: clear speed and route are his decisions. But an invade that kills him at 4:00 costs CS he never chose to give up, so a slice of this is the enemy's doing."
	},
	{ key: "cs@14", label: "CS at 14:00", knownAtMin: 14, control: "his", causalCaveat: "As CS@10, plus fourteen minutes of being pushed off camps by a team that is ahead." },
	{ key: "cs@20", label: "CS at 20:00", knownAtMin: 20, control: "his", causalCaveat: "By 20:00 farm and game state are entangled: a team ahead farms freely. Weaker evidence of a lever than CS@10." },
	{ key: "csPerMin", label: "CS per minute, whole game", knownAtMin: null, control: "his", causalCaveat: "Whole-game rate. A stomp win inflates it and a losing 40-minute game deflates it; this is close to an outcome measure." },
	{ key: "campsPerMinute", label: "Camps cleared per minute", knownAtMin: null, control: "his", causalCaveat: "Same entanglement as CS per minute, and it also falls when he is dead or grouping — so low can mean 'fighting', not 'idle'." },
	{ key: "csDiffVsJgl@10", label: "CS lead over the enemy jungler at 10:00", knownAtMin: 10, control: "shared", causalCaveat: "Half of it is the counterpart's clear, which he does not control. The post-game timeline is exact for both — the LIVE feed's version of this number is the visibility counter and is not usable." },
	{ key: "csDiffVsJgl@14", label: "CS lead over the enemy jungler at 14:00", knownAtMin: 14, control: "shared", causalCaveat: "As at 10:00, with more of the game's result folded in." },
	{ key: "csDiffVsJgl@20", label: "CS lead over the enemy jungler at 20:00", knownAtMin: 20, control: "shared", causalCaveat: "Largely a consequence by this point: the winning jungler takes the loser's camps." },
	/* -------- the scoreboard */
	{ key: "gold@10", label: "His gold at 10:00", knownAtMin: 10, control: "shared", causalCaveat: "Gold is farm plus kills plus assists, so this mixes a decision he owns with an outcome he shares with four other people." },
	{ key: "gold@14", label: "His gold at 14:00", knownAtMin: 14, control: "shared", causalCaveat: "As gold@10." },
	{ key: "gold@20", label: "His gold at 20:00", knownAtMin: 20, control: "shared", causalCaveat: "As gold@10, and by 20:00 it is mostly the scoreboard." },
	{ key: "goldDiffVsJgl@10", label: "Gold lead over the enemy jungler at 10:00", knownAtMin: 10, control: "shared", causalCaveat: "The race he is actually in, but both halves move. A counterpart who got two free ganks moves it without him doing anything wrong." },
	{ key: "goldDiffVsJgl@14", label: "Gold lead over the enemy jungler at 14:00", knownAtMin: 14, control: "shared", causalCaveat: "As at 10:00." },
	{ key: "goldDiffVsJgl@20", label: "Gold lead over the enemy jungler at 20:00", knownAtMin: 20, control: "shared", causalCaveat: "As at 10:00, mostly consequence." },
	{ key: "xpDiffVsJgl@10", label: "XP lead over the enemy jungler at 10:00", knownAtMin: 10, control: "shared", causalCaveat: "Tracks route efficiency more cleanly than gold, because xp is not paid out for kills he did not make. Still half the counterpart's." },
	{ key: "levelDiffVsJgl@10", label: "Level lead over the enemy jungler at 10:00", knownAtMin: 10, control: "shared", causalCaveat: "A coarse version of the xp row. It is the one comparison the LIVE feed can render exactly, which is why it matters whether it separates." },
	{ key: "levelDiffVsJgl@14", label: "Level lead over the enemy jungler at 14:00", knownAtMin: 14, control: "shared", causalCaveat: "As at 10:00." },
	{ key: "levelDiffVsJgl@20", label: "Level lead over the enemy jungler at 20:00", knownAtMin: 20, control: "shared", causalCaveat: "As at 10:00, with the result folded in." },
	{ key: "teamGoldDiff@10", label: "Team gold difference at 10:00", knownAtMin: 10, control: "not-his", causalCaveat: "Four fifths of this is other people. It is in the table as the CONTROL VARIABLE, not as a coaching target — the scoreboard the other rows have to beat." },
	{ key: "teamGoldDiff@14", label: "Team gold difference at 14:00", knownAtMin: 14, control: "not-his", causalCaveat: "As at 10:00." },
	{ key: "teamGoldDiff@20", label: "Team gold difference at 20:00", knownAtMin: 20, control: "not-his", causalCaveat: "By 20:00 this is very nearly the result itself." },
	/* -------- deaths */
	{ key: "deathsBy@10", label: "His deaths by 10:00", knownAtMin: 10, control: "his", causalCaveat: "The LEAST confounded death row in the table — by 10:00 little enough has happened for a death to still be mostly a decision about where he stood. (`deaths@0-10` is the same quantity and is not listed twice.)" },
	{ key: "deathsBy15", label: "His deaths by 15:00", knownAtMin: 15, control: "his", causalCaveat: "As deaths by 10:00." },
	{ key: "deaths", label: "His deaths, whole game", knownAtMin: null, control: "his", causalCaveat: "Losing games manufacture deaths. This row will separate in every player's data and it is mostly an outcome, not a lever. Read the 10-minute row instead." },
	{ key: "deathsPer10Min", label: "His deaths per 10 minutes", knownAtMin: null, control: "his", causalCaveat: "Rate rather than total, so it is not a length artefact — but still an outcome for the same reason as the total." },
	{ key: "deathsInEnemyHalfBy15", label: "Deaths in the enemy half by 15:00", knownAtMin: 15, control: "his", causalCaveat: "The app's signature coaching point. Where he died is his decision far more than whether he died — but the count is bounded by the death count, so it inherits some of its confounding." },
	{ key: "deathsInEnemyHalf", label: "Deaths in the enemy half, whole game", knownAtMin: null, control: "his", causalCaveat: "As the by-15 row, with more outcome in it." },
	{ key: "firstDeathMin", label: "Minute of his first death", knownAtMin: null, control: "his", causalCaveat: "Games where he never dies have no value and are DROPPED, which biases this toward games with a death. Read it as 'among games where he died'." },
	{ key: "modelledDeadSec", label: "Seconds spent dead (MODELLED, not measured)", knownAtMin: null, control: "his", causalCaveat: "MODELLED from the published respawn formula and a level read up to 60s stale — the match blob has no dead-time field. Also an outcome: late deaths in a lost game cost the most seconds." },
	{ key: "modelledDeadShare", label: "Share of the game spent dead (MODELLED)", knownAtMin: null, control: "his", causalCaveat: "As above, normalised by game length so it is not a duration artefact." },
	/* -------- fights */
	{ key: "kpBy@10", label: "Kill participation by 10:00", knownAtMin: 10, control: "shared", causalCaveat: "Undefined when his team has no kills by 10:00, and those games are dropped. It also rises when laners get kills he merely arrived for." },
	{ key: "kpBy@14", label: "Kill participation by 14:00", knownAtMin: 14, control: "shared", causalCaveat: "As by 10:00." },
	{ key: "kp", label: "Kill participation, whole game", knownAtMin: null, control: "shared", causalCaveat: "A ratio whose denominator is his team's kills — so a team that fights badly moves it without him changing anything." },
	{ key: "killsInvolvedBy@10", label: "Kills he took part in by 10:00", knownAtMin: 10, control: "shared", causalCaveat: "A count, not a ratio, so it does not blow up when the team has two kills. But it rewards a snowballing team as much as a good gank." },
	{ key: "firstBloodInvolved", label: "Took part in the game's first kill", knownAtMin: null, control: "shared", causalCaveat: "Binary, and 'involved' includes an assist on a kill his lane made without him. Timing of the first kill varies wildly between games." },
	{ key: "damageShare", label: "His share of his team's damage to champions", knownAtMin: null, control: "shared", causalCaveat: "A share of a team total, so a fed teammate lowers it in games he is winning. Almost pure consequence." },
	/* -------- objectives */
	{ key: "dragonDiff", label: "Dragons taken minus conceded", knownAtMin: null, control: "shared", causalCaveat: "Credited by KILLER only — the timeline's objective assist list names the other team 23% of the time and is not read. So this is his team's dragon count, not his." },
	{ key: "grubDiff", label: "Voidgrubs taken minus conceded", knownAtMin: null, control: "shared", causalCaveat: "As dragons. Grubs are early, which makes this one of the few objective rows that is decided before the game is." },
	{ key: "heraldDiff", label: "Heralds taken minus conceded", knownAtMin: null, control: "shared", causalCaveat: "As dragons, and heralds are rare enough per game that this row is nearly a three-valued flag." },
	{ key: "baronDiff", label: "Barons taken minus conceded", knownAtMin: null, control: "shared", causalCaveat: "Baron is taken by the team that is already winning far more often than it causes the win. Expect a large effect that is almost entirely a consequence." },
	{ key: "earlyObjectiveDiffBy10", label: "Early objective difference by 10:00 (drakes, grubs, herald)", knownAtMin: 10, control: "shared", causalCaveat: "The earliest objective row there is, and the one a jungler owns most of. Still five players' work, and credited by KILLER only — it says his team took it, not that he was there." },
	{ key: "grubDiffBy10", label: "Voidgrub difference by 10:00", knownAtMin: 10, control: "shared", causalCaveat: "Grubs are gone by 14:00 and are the jungler's objective more than anyone else's, which makes this the cleanest early objective row. Killer-only credit, as above." },
	{ key: "firstDragonMine", label: "His team took the first dragon", knownAtMin: null, control: "shared", causalCaveat: "Binary, and 'known at' is not fixed — the first dragon lands at a different minute in every game. Killer-only credit." },
	{ key: "earlyObjectiveDiffBy15", label: "Early objective difference by 15:00 (drakes, grubs, herald)", knownAtMin: 15, control: "shared", causalCaveat: "The earliest objective row in the table, so the least contaminated — but it is still five players' work and the killer-only credit rule means it says nothing about whether he was there." },
	{ key: "medianDistAtOwnObjective", label: "Median distance from the pit when his team took an objective", knownAtMin: null, control: "his", causalCaveat: "Frames are one a minute, so the nearest frame can be 40s from the take: this is 'in the neighbourhood', never 'in the pit'. Confidence low by construction." },
	{ key: "towerDiffBy@14", label: "Tower difference by 14:00", knownAtMin: 14, control: "not-his", causalCaveat: "Almost entirely his lanes' work. In the table to show what a NOT-HIS row looks like when it separates." },
	/* -------- map and economy */
	{ key: "enemyJungleShare", label: "Share of his camps taken in the enemy half", knownAtMin: null, control: "his", causalCaveat: "Attributed by the half he occupied at the frame AFTER the camp died, so a camp cleared at 7:59 is credited to the 8:00 position. Invading also rises when he is ahead and free to." },
	{ key: "enemyHalfFrameShare", label: "Share of frames spent in the enemy half", knownAtMin: null, control: "his", causalCaveat: "One frame a minute. It measures where he was at 25 sampled instants, not where he spent his time." },
	{ key: "p90OverExtension", label: "Over-extension index, 90th percentile", knownAtMin: null, control: "his", causalCaveat: "An index (nearest ally / (nearest enemy + 1500)) computed on once-a-minute positions — it is a construct of this repo, not a game quantity, and its median barely moves between games." },
	{ key: "medianDistFromTeam", label: "Median distance from his team's centroid", knownAtMin: null, control: "his", causalCaveat: "A jungler is SUPPOSED to be away from his team for the first ten minutes, so a low value is not automatically good. Sampled once a minute." },
	{ key: "firstBackMin", label: "Minute of his first back", knownAtMin: null, control: "his", causalCaveat: "Detected from a >=250g drop in gold-in-hand between two frames, so it is resolved to +/-60s and cannot see a back that bought nothing." },
	{ key: "meanGoldInHand", label: "Mean gold sitting unspent in his pocket", knownAtMin: null, control: "his", causalCaveat: "Sampled at frame boundaries, which land at arbitrary points in the buy cycle. High can mean 'saving for a component' as easily as 'forgot to shop'." },
	{ key: "maxGoldInHand", label: "Most gold he ever sat on at once", knownAtMin: null, control: "his", causalCaveat: "A maximum over ~25 samples, so it grows with game length on its own." },
	/* -------- WHEN it diverges: the same rate, window by window */
	{ key: "csPerMin@0-10", label: "CS per minute, 0:00-10:00", knownAtMin: 10, control: "his", causalCaveat: "The cleanest farm window there is — before 10:00 almost nothing about the game's result has happened yet. If this does not separate, his early clear rate is not what decides his games." },
	{ key: "csPerMin@10-15", label: "CS per minute, 10:00-15:00", knownAtMin: 15, control: "his", causalCaveat: "Some game state is now in it, but 15:00 is still early enough that most games are live." },
	{ key: "csPerMin@15-20", label: "CS per minute, 15:00-20:00", knownAtMin: 20, control: "his", causalCaveat: "Strongly entangled: a team that is behind cannot farm safely, and a team ahead takes the enemy's camps too." },
	{ key: "csPerMin@20-25", label: "CS per minute, 20:00-25:00", knownAtMin: 25, control: "his", causalCaveat: "Computed only on games that reached 25:00 — short stomps in both directions are missing, so this row is a different population from the earlier windows." },
	{ key: "goldPerMin@0-10", label: "Gold per minute, 0:00-10:00", knownAtMin: 10, control: "shared", causalCaveat: "Farm plus kill gold, so a laner handing him a kill moves it." },
	{ key: "goldPerMin@10-15", label: "Gold per minute, 10:00-15:00", knownAtMin: 15, control: "shared", causalCaveat: "As the 0-10 window, with more of the result in it." },
	{ key: "goldPerMin@15-20", label: "Gold per minute, 15:00-20:00", knownAtMin: 20, control: "shared", causalCaveat: "Largely a consequence by this point." },
	{ key: "xpPerMin@0-10", label: "XP per minute, 0:00-10:00", knownAtMin: 10, control: "his", causalCaveat: "Purer than gold for route efficiency — xp is not paid out for a kill he did not earn — but it is capped by camps existing to take." },
	{ key: "xpPerMin@10-15", label: "XP per minute, 10:00-15:00", knownAtMin: 15, control: "his", causalCaveat: "As the 0-10 window." },
	{ key: "enemyHalfShare@0-10", label: "Share of frames in the enemy half, 0:00-10:00", knownAtMin: 10, control: "his", causalCaveat: "Ten frames at most, so this is a coarse count of sampled instants. It is the earliest form of the invading question and the least contaminated by the result." },
	{ key: "enemyHalfShare@10-15", label: "Share of frames in the enemy half, 10:00-15:00", knownAtMin: 15, control: "his", causalCaveat: "Five frames at most. Wide by construction." },
	{ key: "enemyHalfShare@15-20", label: "Share of frames in the enemy half, 15:00-20:00", knownAtMin: 20, control: "his", causalCaveat: "Being in the enemy half after 15:00 is largely a privilege of being ahead." },
	{ key: "enemyCampShare@0-10", label: "Share of camps taken in the enemy half, 0:00-10:00", knownAtMin: 10, control: "his", causalCaveat: "Attributed by the half he occupied at the frame after the camp died. Dropped when he cleared under four camps in the window." },
	{ key: "enemyCampShare@10-15", label: "Share of camps taken in the enemy half, 10:00-15:00", knownAtMin: 15, control: "his", causalCaveat: "As the 0-10 window, on fewer camps." },
	{ key: "deaths@10-15", label: "Deaths between 10:00 and 15:00", knownAtMin: 15, control: "his", causalCaveat: "Confounding starts here: a team behind at 10:00 dies more at 12:00 without anyone choosing differently." },
	{ key: "deaths@15-20", label: "Deaths between 15:00 and 20:00", knownAtMin: 20, control: "his", causalCaveat: "Mostly a consequence." },
	{ key: "deaths@20-25", label: "Deaths between 20:00 and 25:00", knownAtMin: 25, control: "his", causalCaveat: "Mostly a consequence, and on the reduced population of games that reached 25:00." },
	{ key: "deathsInEnemyJungleBy15", label: "Deaths in the ENEMY JUNGLE by 15:00", knownAtMin: 15, control: "his", causalCaveat: "The exact play the shipped review prompt calls the most common way a jungler throws a lead. Zoned from the death's own position, which is exact — this row is not an interpolation. It is rare, so its interval is wide." },
	{ key: "deathsInEnemyJungle", label: "Deaths in the ENEMY JUNGLE, whole game", knownAtMin: null, control: "his", causalCaveat: "As the by-15 row, with the result folded in." },
	/* -------- vision */
	{ key: "visionScore", label: "Vision score", knownAtMin: null, control: "his", causalCaveat: "Grows with game length mechanically — a 40-minute loss out-scores a 25-minute win with no behaviour change. The per-minute row is the one to read." },
	{ key: "visionPerMin", label: "Vision score per minute", knownAtMin: null, control: "his", causalCaveat: "Length-corrected, but vision score also rewards being alive and in contested space, which correlates with winning." },
	{ key: "wardsPlaced", label: "Wards placed", knownAtMin: null, control: "his", causalCaveat: "Length-confounded like vision score, and the app cannot see WHERE any of them went." },
	{ key: "wardsKilled", label: "Wards cleared", knownAtMin: null, control: "his", causalCaveat: "Clearing wards requires being in the enemy's half safely, which is much easier when ahead." },
	{ key: "controlWardsBought", label: "Control wards bought", knownAtMin: null, control: "his", causalCaveat: "Purchases scale with backs and with gold, both of which scale with the game going well." }
]

/* ===================================================================== rows */

interface Row {
	key: string
	label: string
	knownAtMin: number | null
	control: Control
	causalCaveat: string
	nWon: number
	nLost: number
	wonMean: number
	lostMean: number
	wonSd: number
	lostSd: number
	diff: Interval95
	auc: Interval95
	d: number
	p: number
	q: number
	separates: boolean
	/** Win rate in the top and bottom third of his own games by this metric. */
	topTercileWinRate: { p: number; lo: number; hi: number; k: number; n: number }
	bottomTercileWinRate: { p: number; lo: number; hi: number; k: number; n: number }
	/** Only for metrics known by 15:00: the metric's odds ratio with team gold@10 in the model. */
	controlled: {
		n: number
		metricOr: number
		metricOrLo: number
		metricOrHi: number
		metricP: number
		scoreboardOr: number
		scoreboardP: number
	} | null
	/** The same univariate test on games that were within +/-800g of even at 10:00. */
	evenAtTen: { n: number; auc: number; p: number } | null
}

const numeric = (fs: readonly Features[], key: string): { xs: number[]; wins: boolean[] } => {
	const xs: number[] = []
	const wins: boolean[] = []
	for (const f of fs) {
		const v = f[key]
		if (typeof v !== "number" || !Number.isFinite(v)) continue
		xs.push(v)
		wins.push(f.win === true)
	}
	return { xs, wins }
}

const tercileRate = (xs: number[], wins: boolean[], top: boolean) => {
	const order = xs.map((v, i) => ({ v, w: wins[i]! })).sort((a, b) => a.v - b.v)
	const size = Math.max(1, Math.floor(order.length / 3))
	const slice = top ? order.slice(order.length - size) : order.slice(0, size)
	const k = slice.filter(s => s.w).length
	const iv = wilson(k, slice.length)
	return { p: round(iv.p, 4), lo: round(iv.lo, 4), hi: round(iv.hi, 4), k, n: slice.length }
}

const analyse = (features: Features[], seed: number): Row[] => {
	const evenSet = new Set(
		features
			.filter(f => {
				const v = f["teamGoldDiff@10"]
				return typeof v === "number" && Math.abs(v) <= 800
			})
			.map(f => f.gameId)
	)

	const raw = SPECS.map(spec => {
		const { xs, wins } = numeric(features, spec.key)
		const won = xs.filter((_, i) => wins[i]!)
		const lost = xs.filter((_, i) => !wins[i]!)
		const mw: MannWhitney = mannWhitney(won, lost)
		const diff = bootstrap2(won, lost, (a, b) => meanOf(a) - meanOf(b), seed, 4000)
		const auc = bootstrap2(won, lost, (a, b) => mannWhitney(a, b).auc, seed + 1, 4000)

		// The scoreboard control, for anything a live coach could still act on.
		let controlled: Row["controlled"] = null
		if (spec.knownAtMin !== null && spec.knownAtMin <= 15 && spec.key !== "teamGoldDiff@10") {
			const rows = features.filter(f => {
				const v = f[spec.key]
				const s = f["teamGoldDiff@10"]
				return typeof v === "number" && Number.isFinite(v) && typeof s === "number"
			})
			if (rows.length >= 40) {
				const fit = logisticFit(
					[
						{ name: spec.key, values: rows.map(r => r[spec.key] as number) },
						{ name: "teamGoldDiff@10", values: rows.map(r => r["teamGoldDiff@10"] as number) }
					],
					rows.map(r => (r.win === true ? 1 : 0))
				)
				const a = fit.terms[0]!
				const b = fit.terms[1]!
				controlled = {
					n: rows.length,
					metricOr: round(a.oddsRatio, 3),
					metricOrLo: round(a.orLo, 3),
					metricOrHi: round(a.orHi, 3),
					metricP: round(a.p, 4),
					scoreboardOr: round(b.oddsRatio, 3),
					scoreboardP: round(b.p, 4)
				}
			}
		}

		let evenAtTen: Row["evenAtTen"] = null
		if (spec.key !== "teamGoldDiff@10") {
			const sub = features.filter(f => evenSet.has(f.gameId))
			const e = numeric(sub, spec.key)
			const eWon = e.xs.filter((_, i) => e.wins[i]!)
			const eLost = e.xs.filter((_, i) => !e.wins[i]!)
			if (eWon.length >= 5 && eLost.length >= 5) {
				const m = mannWhitney(eWon, eLost)
				evenAtTen = { n: eWon.length + eLost.length, auc: round(m.auc, 3), p: round(m.p, 4) }
			}
		}

		return {
			spec,
			won,
			lost,
			mw,
			diff,
			auc,
			controlled,
			evenAtTen,
			terciles: {
				top: tercileRate(xs, wins, true),
				bottom: tercileRate(xs, wins, false)
			}
		}
	})

	const qs = benjaminiHochberg(raw.map(r => r.mw.p))

	return raw.map((r, i) => ({
		key: r.spec.key,
		label: r.spec.label,
		knownAtMin: r.spec.knownAtMin,
		control: r.spec.control,
		causalCaveat: r.spec.causalCaveat,
		nWon: r.won.length,
		nLost: r.lost.length,
		wonMean: round(meanOf(r.won), 3),
		lostMean: round(meanOf(r.lost), 3),
		wonSd: round(sdOf(r.won), 3),
		lostSd: round(sdOf(r.lost), 3),
		diff: { point: round(r.diff.point, 3), lo: round(r.diff.lo, 3), hi: round(r.diff.hi, 3) },
		auc: { point: round(r.auc.point, 3), lo: round(r.auc.lo, 3), hi: round(r.auc.hi, 3) },
		d: round(cohensD(r.won, r.lost), 3),
		p: round(r.mw.p, 5),
		q: round(qs[i]!, 4),
		separates: qs[i]! <= 0.1,
		topTercileWinRate: r.terciles.top,
		bottomTercileWinRate: r.terciles.bottom,
		controlled: r.controlled,
		evenAtTen: r.evenAtTen
	}))
}

/* ====================================================================== main */

const db = new DatabaseSync(DB_PATH, { readOnly: true })

const queueFilter = flag("all-queues") ? "" : "AND queueId = 420"
const games = db
	.prepare(
		`SELECT gameId, win, queueId, gameDurationSec, championName, participantId, teamId
		 FROM game
		 WHERE timelineBlob IS NOT NULL AND matchBlob IS NOT NULL ${queueFilter}
		 ORDER BY gameCreationMs`
	)
	.all() as unknown as GameRow[]

const seatStmt = db.prepare(
	"SELECT participantId, teamId, championName, role, isUser FROM participant WHERE gameId = ?"
)

const features: Features[] = []
const skipped: { gameId: number; why: string }[] = []
for (const g of games) {
	if (g.gameDurationSec < MIN_SEC) {
		skipped.push({ gameId: g.gameId, why: `shorter than ${MIN_SEC}s (${g.gameDurationSec}s)` })
		continue
	}
	const seats = seatStmt.all(g.gameId) as unknown as SeatRow[]
	if (seats.length < 10) {
		skipped.push({ gameId: g.gameId, why: `${seats.length} participant rows` })
		continue
	}
	const f = featuresOf(g, seats)
	if (!f) {
		skipped.push({ gameId: g.gameId, why: "unreadable blob or too few frames" })
		continue
	}
	features.push(f)
}

const rows = analyse(features, SEED)

const withCounterpart = features.filter(f => f.counterpartChampion !== null).length
const nWon = features.filter(f => f.win).length
const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length))
const padL = (s: string, n: number): string => (s.length >= n ? s : " ".repeat(n - s.length) + s)
const fmt = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : "—")

const printTable = (title: string, list: Row[]): void => {
	console.log(`\n${title}`)
	console.log(
		pad("metric", 42) +
			padL("won", 9) +
			padL("lost", 9) +
			padL("AUC [95%]", 20) +
			padL("p", 9) +
			padL("q", 8) +
			"  control"
	)
	for (const r of list)
		console.log(
			pad(r.key, 42) +
				padL(fmt(r.wonMean), 9) +
				padL(fmt(r.lostMean), 9) +
				padL(`${fmt(r.auc.point)} [${fmt(r.auc.lo)}-${fmt(r.auc.hi)}]`, 20) +
				padL(r.p < 0.0001 ? "<0.0001" : r.p.toFixed(4), 9) +
				padL(r.q.toFixed(3), 8) +
				"  " +
				r.control
		)
}

console.log(
	`games ${features.length} (${nWon} won / ${features.length - nWon} lost), ` +
		`counterpart identified in ${withCounterpart}, skipped ${skipped.length}, ` +
		`queue ${flag("all-queues") ? "all" : "420 only"}, min ${MIN_SEC}s, seed ${SEED}`
)

const bySize = [...rows].sort((a, b) => Math.abs(b.auc.point - 0.5) - Math.abs(a.auc.point - 0.5))
printTable("ALL METRICS, by |AUC − 0.5|", bySize)

const early = bySize.filter(r => r.knownAtMin !== null && r.knownAtMin <= 15)
printTable("KNOWN BY 15:00 — the only block a live coach can use", early)

console.log("\nSCOREBOARD CONTROL — the metric's odds ratio per SD with team gold@10 in the model")
console.log(
	pad("metric", 42) + padL("OR [95%]", 24) + padL("p", 10) + padL("scoreboard OR", 16) + padL("p", 10)
)
for (const r of early) {
	if (!r.controlled) continue
	const c = r.controlled
	console.log(
		pad(r.key, 42) +
			padL(`${fmt(c.metricOr)} [${fmt(c.metricOrLo)}-${fmt(c.metricOrHi)}]`, 24) +
			padL(c.metricP < 0.0001 ? "<0.0001" : c.metricP.toFixed(4), 10) +
			padL(fmt(c.scoreboardOr), 16) +
			padL(c.scoreboardP < 0.0001 ? "<0.0001" : c.scoreboardP.toFixed(4), 10)
	)
}

const evenN = features.filter(f => {
	const v = f["teamGoldDiff@10"]
	return typeof v === "number" && Math.abs(v) <= 800
}).length
console.log(`\nEVEN AT TEN — ${evenN} games inside +/-800g of even at 10:00`)
for (const r of [...early, ...bySize.filter(x => x.knownAtMin === null).slice(0, 12)])
	if (r.evenAtTen)
		console.log(
			pad(r.key, 42) +
				padL(`AUC ${fmt(r.evenAtTen.auc)}`, 12) +
				padL(`p ${r.evenAtTen.p.toFixed(3)}`, 12) +
				padL(`n ${r.evenAtTen.n}`, 8)
		)

/**
 * THE DECISION TABLE — the same early rows as a coach would have to use them: a threshold, and
 * the win rate on each side of it with a Wilson interval. A rate a human can act on, rather than
 * an AUC. Every row here is already in the table above; this is a rendering, not a new test.
 */
const splits: { key: string; label: string; cut: (v: number) => boolean; hi: string; lo: string }[] = [
	{ key: "earlyObjectiveDiffBy10", label: "early objectives by 10:00", cut: v => v > 0, hi: "ahead", lo: "level or behind" },
	{ key: "grubDiffBy10", label: "grubs by 10:00", cut: v => v > 0, hi: "ahead", lo: "level or behind" },
	{ key: "earlyObjectiveDiffBy15", label: "early objectives by 15:00", cut: v => v > 0, hi: "ahead", lo: "level or behind" },
	{ key: "deaths@10-15", label: "deaths 10:00-15:00", cut: v => v === 0, hi: "none", lo: "one or more" },
	{ key: "deathsBy@10", label: "deaths by 10:00", cut: v => v === 0, hi: "none", lo: "one or more" },
	{ key: "deathsInEnemyJungleBy15", label: "died in the enemy jungle by 15:00", cut: v => v === 0, hi: "never", lo: "at least once" },
	{ key: "cs@10", label: "CS at 10:00 above his own median", cut: v => v >= 68, hi: "at or above 68", lo: "below 68" },
	{ key: "teamGoldDiff@10", label: "team gold at 10:00", cut: v => v > 0, hi: "ahead", lo: "behind" }
]
const decisions = splits.map(sp => {
	const { xs, wins } = numeric(features, sp.key)
	const hiWins = xs.filter((v, i) => sp.cut(v) && wins[i]!).length
	const hiN = xs.filter(v => sp.cut(v)).length
	const loWins = xs.filter((v, i) => !sp.cut(v) && wins[i]!).length
	const loN = xs.filter(v => !sp.cut(v)).length
	const a = wilson(hiWins, hiN)
	const b = wilson(loWins, loN)
	return {
		key: sp.key,
		label: sp.label,
		high: { arm: sp.hi, k: hiWins, n: hiN, p: round(a.p, 4), lo: round(a.lo, 4), hi: round(a.hi, 4) },
		low: { arm: sp.lo, k: loWins, n: loN, p: round(b.p, 4), lo: round(b.lo, 4), hi: round(b.hi, 4) },
		gapPoints: round((a.p - b.p) * 100, 1)
	}
})
console.log("\nDECISION TABLE — win rate on each side of a threshold he could actually use")
for (const d of decisions)
	console.log(
		pad(d.label, 38) +
			padL(`${d.high.arm}: ${(d.high.p * 100).toFixed(0)}% [${(d.high.lo * 100).toFixed(0)}-${(d.high.hi * 100).toFixed(0)}] n=${d.high.n}`, 32) +
			padL(`${d.low.arm}: ${(d.low.p * 100).toFixed(0)}% [${(d.low.lo * 100).toFixed(0)}-${(d.low.hi * 100).toFixed(0)}] n=${d.low.n}`, 36) +
			padL(`${d.gapPoints > 0 ? "+" : ""}${d.gapPoints}pt`, 10)
	)

/** How often the plays the shipped prompt treats as THE jungle failure actually happen to him. */
const prevalence = [
	"deathsInEnemyJungleBy15",
	"deathsInEnemyJungle",
	"deathsInEnemyHalfBy15",
	"firstBloodInvolved"
].map(key => {
	const { xs } = numeric(features, key)
	const hit = xs.filter(v => v >= 1).length
	const iv = wilson(hit, xs.length)
	return { key, games: xs.length, gamesWithAtLeastOne: hit, rate: round(iv.p, 4), lo: round(iv.lo, 4), hi: round(iv.hi, 4) }
})
console.log("\nPREVALENCE — how often the play happens at all, which bounds how much it can decide")
for (const pv of prevalence)
	console.log(
		pad(pv.key, 38) +
			padL(`${pv.gamesWithAtLeastOne}/${pv.games} games = ${(pv.rate * 100).toFixed(0)}% [${(pv.lo * 100).toFixed(0)}-${(pv.hi * 100).toFixed(0)}]`, 34)
	)

const nonSeparators = rows.filter(r => !r.separates && Math.abs(r.auc.point - 0.5) < 0.06)
console.log(`\nNON-SEPARATORS — |AUC − 0.5| < 0.06 and BH q > 0.10 (${nonSeparators.length})`)
for (const r of nonSeparators)
	console.log(pad(r.key, 42) + padL(fmt(r.auc.point), 8) + padL(`q ${r.q.toFixed(3)}`, 12))

writeFileSync(
	OUT,
	JSON.stringify(
		{
			generatedAt: new Date().toISOString(),
			script: "scripts/what-wins.ts",
			seed: SEED,
			minSec: MIN_SEC,
			queue: flag("all-queues") ? "all" : 420,
			nGames: features.length,
			nWon,
			nLost: features.length - nWon,
			counterpartIdentified: withCounterpart,
			evenAtTenGames: evenN,
			skipped,
			multipleComparisons: "Benjamini-Hochberg across all rows; `separates` is q <= 0.10",
			decisions,
			prevalence,
			rows,
			features
		},
		null,
		"\t"
	) + "\n"
)
console.log(`\nwrote ${OUT}`)
