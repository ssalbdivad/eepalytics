/**
 * Building the digest the coach actually reads.
 *
 * WHY THIS FILE EXISTS: the two sibling units met in the middle and did not quite touch.
 * `src/analysis/digest.ts` produces a rich `csk.game-digest/1` object; `src/review/prompt.ts`
 * renders `src/review/digest-contract.ts`'s `GameDigest`, which is a different shape (its own
 * header asks for exactly this reconciliation). The daemon is the integration point, so the
 * conversion lives here — built from the PERSISTED metrics, moments and participants, which
 * are the same numbers the UI shows. One source of truth, three consumers.
 *
 * THE RULE THIS FILE ENFORCES: `dataGaps` is mandatory and is populated with what the LCU
 * genuinely cannot tell us. The coach is forbidden from inventing a ward count; the only way
 * to make that instruction meaningful is to state, in the prompt, that ward counts are not in
 * the data. Every hedge here is a measured limitation, not politeness.
 *
 * NEVER send the raw timeline: 112 KB (~30k tokens), 20x the cost, and worse feedback than
 * derived facts.
 *
 * NODE ONLY.
 */

import { FRAME_INTERVAL_MS, queueName } from "../shared/constants.ts"
import { effectiveCs } from "../shared/schema/domain.ts"
import type {
	Confidence,
	Game,
	Metric,
	Moment,
	ParticipantSummary,
	Role,
	TrendSeries
} from "../shared/schema/domain.ts"
import type { LcuEvent, LcuTimeline } from "../shared/schema/lcu.ts"
import { zoneOf } from "../shared/map.ts"
import type { TeamId } from "../shared/map.ts"
import type { Baseline } from "../analysis/index.ts"
import { DIGEST_SCHEMA_VERSION } from "../review/digest-contract.ts"
import type {
	DigestGame,
	DigestObjective,
	DigestPlayer,
	DigestTimelineRow,
	GameDigest,
	PriorFeedback,
	TrendDigest,
	TrendGameRow
} from "../review/digest-contract.ts"

/**
 * What the LCU match + timeline genuinely do not contain. Verified across 22 games and 1928
 * events, and repeated into every prompt so "do not fabricate" has something to bite on.
 */
export const GAME_DATA_GAPS: readonly string[] = [
	"The LCU timeline has NO item purchases, NO ward placements and NO skill levels — only kills, elite monsters, buildings, and per-minute gold/xp/cs/position. Do not comment on builds, wards or skill order.",
	"Timeline frames arrive once per MINUTE. Any position between frames is interpolated; the median frame-to-frame movement is 4082 units (~28% of the map). Say 'likely' about who was near whom, never 'you were'.",
	"ELITE_MONSTER_KILL.assistingParticipantIds is corrupt in this data (19% name players on the opposing team). Only the killer is reliable — do not claim who did or did not show up for an objective.",
	"There is no damage-over-time or per-fight breakdown; only end-of-game totals."
] as const

export const TREND_DATA_GAPS: readonly string[] = [
	...GAME_DATA_GAPS,
	"This window is the games stored locally, not a ranked sample. Match-history pagination does not work, so it is 'recent games', not 'the last N games' in any statistical sense.",
	"A metric with fewer than 10 games behind it cannot support a trend claim. Say 'too early to tell' rather than naming a direction."
] as const

/* ============================================================ per game */

const digestGame = (game: Game, participants: readonly ParticipantSummary[]): DigestGame => {
	const allies = participants.filter(p => p.teamId === game.teamId)
	const enemies = participants.filter(p => p.teamId !== game.teamId)
	return {
		gameId: game.gameId,
		teamId: (game.teamId === 200 ? 200 : 100) as 100 | 200,
		queue: queueName(game.queueId),
		patch: game.patch,
		durationSec: game.gameDurationSec,
		win: game.win,
		championName: game.championName,
		role: game.role as Role,
		roleConfidence: game.roleConfidence as Confidence,
		kills: game.kills,
		deaths: game.deaths,
		assists: game.assists,
		cs: game.cs,
		jungleCs: game.jungleCs,
		gold: game.gold,
		visionScore: game.visionScore,
		champLevel: game.champLevel,
		damageToChampions: game.damageToChampions,
		gameCreationMs: game.gameCreationMs,
		teamKills: allies.reduce((n, p) => n + p.kills, 0),
		enemyKills: enemies.reduce((n, p) => n + p.kills, 0)
	}
}

/** Identity is stripped: the coach talks about champions, never about the user's teammates. */
const digestPlayers = (
	game: Game,
	participants: readonly ParticipantSummary[]
): DigestPlayer[] =>
	participants.map(p => ({
		participantId: p.participantId,
		team: p.teamId === game.teamId ? ("ally" as const) : ("enemy" as const),
		role: p.role as Role,
		championName: p.championName || `champion ${p.championId}`,
		isUser: p.isUser,
		kills: p.kills,
		deaths: p.deaths,
		assists: p.assists,
		cs: effectiveCs(p),
		gold: p.gold,
		visionScore: p.visionScore,
		champLevel: p.champLevel,
		damageToChampions: p.damageToChampions
	}))

/**
 * Per-minute rows, already differenced against the ROLE opponent — for this user that is the
 * enemy jungler, so "cs" means camps and "lane opponent" means the other jungler.
 *
 * Returns `null` diffs rather than 0 when there is no opponent to difference against: a
 * missing number and a zero difference are not the same claim.
 */
const digestTimeline = (
	timeline: LcuTimeline | null,
	userId: number,
	opponentId: number | null,
	teamId: TeamId
): DigestTimelineRow[] => {
	if (!timeline) return []
	const rows: DigestTimelineRow[] = []
	for (const frame of timeline.frames) {
		const me = frame.participantFrames[String(userId)]
		if (!me) continue
		const opp = opponentId === null ? null : frame.participantFrames[String(opponentId)]
		rows.push({
			minute: Math.round(frame.timestamp / FRAME_INTERVAL_MS),
			goldDiff: opp ? me.totalGold - opp.totalGold : null,
			csDiff:
				opp ?
					me.minionsKilled +
					me.jungleMinionsKilled -
					(opp.minionsKilled + opp.jungleMinionsKilled)
				:	null,
			xpDiff: opp ? me.xp - opp.xp : null,
			zone: zoneOf(me.position, teamId)
		})
	}
	return rows
}

/**
 * Objectives, with where the user was when each fell.
 *
 * `userZone` is ALWAYS interpolated — objectives happen at an exact millisecond and frames are
 * a minute apart — so every row carries `confidence: "low"` and the prompt is told why.
 */
const digestObjectives = (
	timeline: LcuTimeline | null,
	userId: number,
	teamId: TeamId
): DigestObjective[] => {
	if (!timeline) return []
	const out: DigestObjective[] = []
	const frames = timeline.frames

	const nearestZone = (tMs: number): string | null => {
		let best: { d: number; zone: string } | null = null
		for (const frame of frames) {
			const pf = frame.participantFrames[String(userId)]
			if (!pf) continue
			const d = Math.abs(frame.timestamp - tMs)
			if (!best || d < best.d) best = { d, zone: zoneOf(pf.position, teamId) }
		}
		return best?.zone ?? null
	}

	for (const frame of frames)
		for (const event of frame.events ?? []) {
			const e = event as LcuEvent
			if (e.type !== "ELITE_MONSTER_KILL" && e.type !== "BUILDING_KILL") continue
			// `killerId` is reliable; the assist list is not. Ownership comes from the killer,
			// except BUILDING_KILL where `teamId` is the team that LOST the building.
			const killerTeam =
				typeof e.killerId === "number" && e.killerId > 0 ?
					e.killerId <= 5 ? 100
					:	200
				: typeof e.teamId === "number" ?
					e.teamId === 100 ? 200
					:	100
				:	null
			if (killerTeam === null) continue
			out.push({
				tSec: Math.round(e.timestamp / 1000),
				kind: e.monsterType ?? e.buildingType ?? e.type,
				subType: e.monsterSubType ?? e.towerType ?? null,
				takenBy: killerTeam === teamId ? "ally" : "enemy",
				userZone: nearestZone(e.timestamp),
				confidence: "low"
			})
		}
	return out.sort((a, b) => a.tSec - b.tSec)
}

/** The user's own rolling history, as sentences the coach can quote verbatim. */
export const baselineProse = (baseline: Baseline, metrics: readonly Metric[]): string[] => {
	const out: string[] = []
	for (const metric of metrics) {
		const stat = baseline[metric.key]
		if (!stat || stat.n < 3) continue
		out.push(
			`${metric.label}: this game ${round(metric.value)}${metric.unit}, ` +
				`your ${stat.n}-game median ${round(stat.median)}${metric.unit} ` +
				`(mean ${round(stat.mean)}, sd ${round(stat.sd)}).`
		)
	}
	return out
}

const round = (n: number): string =>
	Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toFixed(1)

export interface BuildDigestInput {
	game: Game
	participants: readonly ParticipantSummary[]
	metrics: readonly Metric[]
	moments: readonly Moment[]
	timeline: LcuTimeline | null
	baseline?: Baseline
	/** Anything analysis wanted to flag: "only 6 frames — game ended at 5:41". */
	notes?: readonly string[]
	analysisVersion: number
}

export const buildGameDigest = (input: BuildDigestInput): GameDigest => {
	const { game, participants, metrics, moments, timeline } = input
	const teamId = (game.teamId === 200 ? 200 : 100) as TeamId
	// "Lane opponent" for this user means the ENEMY JUNGLER — he is a jungler in every game
	// we have. Matching on role rather than lane is what makes that true.
	const opponent =
		participants.find(
			p => p.teamId !== game.teamId && p.role === game.role && game.role !== "UNKNOWN"
		) ?? null

	const notes = [...(input.notes ?? [])]
	if (!timeline)
		notes.push("No timeline was available for this game — only end-of-game totals.")
	if (game.role === "UNKNOWN")
		notes.push("Role inference did not settle; treat role-relative comparisons as unsafe.")
	if (!opponent && game.role !== "UNKNOWN")
		notes.push(
			`No enemy ${game.role} was identified, so per-minute diffs are absent rather than zero.`
		)

	return {
		kind: "game",
		schemaVersion: DIGEST_SCHEMA_VERSION,
		game: digestGame(game, participants),
		players: digestPlayers(game, participants),
		metrics: [...metrics],
		moments: [...moments],
		dataGaps: [...GAME_DATA_GAPS],
		generatedMs: Date.now(),
		analysisVersion: input.analysisVersion,
		baseline:
			input.baseline ? baselineProse(input.baseline, metrics)
			:	["No baseline yet — this is one of the first games stored, so nothing is banded."],
		objectives: digestObjectives(timeline, game.participantId, teamId),
		timeline: digestTimeline(timeline, game.participantId, opponent?.participantId ?? null, teamId),
		notes
	}
}

/* ============================================================== trends */

export interface BuildTrendDigestInput {
	games: readonly Game[]
	series: readonly TrendSeries[]
	priorFeedback: readonly { gameId: number | null; title: string; severity: PriorFeedback["severity"]; category?: string }[]
	analysisVersion: number
	notes?: readonly string[]
}

export const buildTrendDigest = (input: BuildTrendDigestInput): TrendDigest => {
	const rows: TrendGameRow[] = input.games.map(g => ({
		gameId: g.gameId,
		gameCreationMs: g.gameCreationMs,
		championName: g.championName,
		role: g.role as Role,
		win: g.win,
		durationSec: g.gameDurationSec,
		kills: g.kills,
		deaths: g.deaths,
		assists: g.assists,
		cs: g.cs + g.jungleCs,
		gold: g.gold,
		visionScore: g.visionScore,
		queue: queueName(g.queueId)
	}))
	const times = rows.map(r => r.gameCreationMs).filter(n => n > 0)

	return {
		kind: "trend",
		schemaVersion: DIGEST_SCHEMA_VERSION,
		gameCount: rows.length,
		games: rows,
		// Strip the analysis unit's extra diagnostic fields: the prompt renders TrendSeries.
		series: input.series.map(s => ({
			key: s.key,
			label: s.label,
			points: s.points,
			mean: s.mean,
			ci95: s.ci95,
			trendable: s.trendable,
			note: s.note
		})),
		dataGaps: [...TREND_DATA_GAPS],
		generatedMs: Date.now(),
		analysisVersion: input.analysisVersion,
		windowFromMs: times.length > 0 ? Math.min(...times) : undefined,
		windowToMs: times.length > 0 ? Math.max(...times) : undefined,
		priorFeedback: input.priorFeedback.map(f => ({
			gameId: f.gameId,
			title: f.title,
			severity: f.severity,
			...(f.category ? { category: f.category } : {})
		})),
		notes: [...(input.notes ?? [])]
	}
}

/** The ids a feedback item may cite. Anything else the model writes is a fabrication. */
export const allowlistFor = (
	metrics: readonly Metric[],
	moments: readonly Moment[]
): { momentIds: Set<string>; metricKeys: Set<string> } => ({
	momentIds: new Set(moments.map(m => m.id)),
	metricKeys: new Set(metrics.map(m => m.key))
})
