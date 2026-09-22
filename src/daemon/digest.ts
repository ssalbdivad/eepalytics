/**
 * Building the digest the coach actually reads.
 *
 * WHY THIS FILE EXISTS: `src/review/prompt.ts` renders `src/review/digest-contract.ts`'s
 * `GameDigest`, and something has to build one. It is built here, from the PERSISTED metrics,
 * moments and participants — the same rows the UI shows — so the review and the screen can
 * never disagree about a number. One source of truth, three consumers.
 *
 * There was a second builder in `src/analysis/digest.ts` that produced a richer
 * `csk.game-digest/1` object. Nothing ever read it back, so it is gone; this is the only
 * digest the coach has ever actually been sent.
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
import { championContext as committedContext, contextPatch, contextStaleness } from "../knowledge/champion-context.ts"
import { DIGEST_SCHEMA_VERSION } from "../review/digest-contract.ts"
import type { ChampionContext } from "../review/digest-contract.ts"
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
 * enemy jungler, and "cs" is camps plus lane minions throughout — one quantity, called CS.
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
 * THE LCU FILLS EVERY FIELD OF EVERY TIMELINE EVENT, so an ABSENT field arrives as `""`, not as
 * `undefined`. `??` therefore does not fall through it, and that one detail shipped two defects
 * for as long as this file has existed (both measured below, in `digestObjectives`).
 *
 * Verified on the stored blobs: a real `BUILDING_KILL` carries `monsterType: ""`,
 * `monsterSubType: ""`, `laneType: "BOT_LANE"`, `buildingType: "TOWER_BUILDING"`,
 * `towerType: "OUTER_TURRET"`, and a real `ELITE_MONSTER_KILL` carries `buildingType: ""`,
 * `towerType: ""`, `laneType: ""`, `teamId: 0`.
 */
const present = (s: string | null | undefined): string | null =>
	typeof s === "string" && s !== "" ? s : null

/**
 * Objectives: WHAT fell, WHICH SIDE took it, WHO landed the last hit where the timeline seats a
 * killer, and where the user was.
 *
 * `userZone` is ALWAYS interpolated — objectives happen at an exact millisecond and frames are
 * a minute apart — so every row carries `confidence: "low"` and the prompt is told why.
 *
 * THREE THINGS THIS FUNCTION GOT WRONG UNTIL 2026-09-22, all three measured over the 198 stored
 * games that have a timeline (1,849 elite kills and 2,945 building kills) and pinned by
 * `digest.objectives.test.ts` over the 20 committed fixtures:
 *
 *  1. **Every building row said nothing about what fell.** `e.monsterType ?? e.buildingType` took
 *     the empty string, so all 2,945 stored building rows rendered as `- 21:01 —  taken by your
 *     team`: no building type, and no `towerType` either, since `monsterSubType: ""` swallowed
 *     that the same way. Rebuilding the 20 most recent ranked jungle games, 299 of their 479
 *     objective rows (62.4%) were nameless — and Part 2 tells him to "count the monsters and skip
 *     the towers in that same list", which is not possible when a tower is indistinguishable from
 *     a grub. `present()` above is the fix.
 *
 *     What this did NOT damage, checked rather than assumed: the EARLY ledger. Of the 55 rows at
 *     or before 10:00 in those 20 games, 55 are elite monsters and 0 are buildings — no turret
 *     falls that early in his games — so the first ten minutes were always readable and the
 *     damage was to every row after them.
 *  2. **An objective nobody took was credited to team 100.** `typeof e.teamId === "number"` is
 *     TRUE for an elite kill, whose `teamId` is `0`, so the `=== 100 ? 200 : 100` fallback handed
 *     every killer-less monster to blue side. Measured: 27 of 1,849 elite kills carry
 *     `killerId: 0`, and they are not scattered — 24 are RIFTHERALD at EXACTLY 19:45 in 24
 *     different games and 3 are HORDE at EXACTLY 14:45 in one. Nobody took them; the scoreboard
 *     does not count them either (the fixture test checks the killer-attributed rows against
 *     `match.teams[].dragonKills|baronKills|riftHeraldKills|hordeKills|towerKills|inhibitorKills`
 *     and they agree exactly, 20 of 20 games, with these rows excluded). So 24 of the 198 stored
 *     games (12.1%) carried a `RIFTHERALD ... at 19:45` row credited to a side with nothing
 *     behind it — to HIS team or to the enemy depending only on which side he happened to be on
 *     that game. They now carry `takenBy: "unattributed"`: the row stays, because the event
 *     happened, and it is credited to no one.
 *  3. **The side came from an assumption rather than from the data.** `killerId <= 5 ? 100 : 200`
 *     is an ordinal convention, not a lookup. It happens to be right — checked against the
 *     participant rows on all 4,625 seated kills in the library, 0 mismatches — but seating the
 *     killer is what yields his CHAMPION, which is the fact the digest was missing. The ordinal
 *     survives as the fallback for a killerId with no participant row (0 of 4,625 today), because
 *     losing the NAME is cheaper than losing the SIDE.
 *
 * `takenByChampion` is the LAST HIT and cannot be anything else: `assistingParticipantIds` names
 * players on the opposing team in 23% of assisted takes and is not read here or anywhere. A seat
 * whose `championName` is empty yields a row with its SIDE and no name rather than a row naming
 * the empty string — 0 of the 1,988 stored participant rows are in that state, so it is a guard
 * and not a case.
 *
 * `laneType` is available on a building row (`BOT_LANE`) and is deliberately NOT rendered: Part 2
 * tells him to skip the towers when he counts the ledger, and a lane on a row he is told to skip
 * is tokens. It is one field away if that changes.
 */
export const digestObjectives = (
	timeline: LcuTimeline | null,
	userId: number,
	teamId: TeamId,
	participants: readonly { participantId: number; teamId: number; championName: string }[]
): DigestObjective[] => {
	if (!timeline) return []
	const out: DigestObjective[] = []
	const frames = timeline.frames
	const seats = new Map(participants.map(p => [p.participantId, p]))

	/**
	 * The nearest per-minute position sample, AND HOW FAR IT IS FROM THE OBJECTIVE, signed.
	 *
	 * "you were around the dragon pit" on a row is not a statement about the second the drake
	 * died. Measured over the 463 objective rows of the 20 committed fixtures: the nearest frame
	 * is AFTER the event on 231 of them (49.9%), median distance 13.8s, p90 26.2s, max 29.8s. Half
	 * of these positions are therefore where he walked to NEXT, and a coach reading the bare zone
	 * cannot tell that from where he was standing when it fell — with the median frame-to-frame
	 * displacement at 4,082 units (~28% of the map), half a minute is most of the way anywhere.
	 *
	 * `confidence: "low"` was the whole of the hedge before and it does not carry the direction.
	 * The gap ships, positive for a sample taken after the objective, and the prompt renders it in
	 * the row, so the hedge is proportional to the actual staleness instead of a constant.
	 */
	const nearestSample = (tMs: number): { zone: string; gapSec: number } | null => {
		let best: { d: number; zone: string } | null = null
		for (const frame of frames) {
			const pf = frame.participantFrames[String(userId)]
			if (!pf) continue
			const d = frame.timestamp - tMs
			if (!best || Math.abs(d) < Math.abs(best.d)) best = { d, zone: zoneOf(pf.position, teamId) }
		}
		return best === null ? null : { zone: best.zone, gapSec: Math.round(best.d / 1000) }
	}

	for (const frame of frames)
		for (const event of frame.events ?? []) {
			const e = event as LcuEvent
			if (e.type !== "ELITE_MONSTER_KILL" && e.type !== "BUILDING_KILL") continue

			const sample = nearestSample(e.timestamp)
			const killerId = typeof e.killerId === "number" && e.killerId > 0 ? e.killerId : null
			const seat = killerId === null ? null : (seats.get(killerId) ?? null)
			/*
			 * Side, in order of how much it rests on: the killer's own participant row, then the
			 * ordinal convention for a killer we cannot seat, then — buildings only — the team
			 * that LOST it, since `BUILDING_KILL.teamId` is the loser and a turret can fall to a
			 * minion wave (142 of 2,945 stored building kills carry `killerId: 0`).
			 *
			 * An elite monster with no killer reaches none of those and is credited to NOBODY.
			 */
			const killerTeam =
				seat ? seat.teamId
				: killerId !== null ? (killerId <= 5 ? 100 : 200)
				: e.type === "BUILDING_KILL" && (e.teamId === 100 || e.teamId === 200) ?
					e.teamId === 100 ? 200
					:	100
				:	null

			out.push({
				tSec: Math.round(e.timestamp / 1000),
				kind: present(e.monsterType) ?? present(e.buildingType) ?? e.type,
				subType: present(e.monsterSubType) ?? present(e.towerType),
				takenBy:
					killerTeam === null ? "unattributed"
					: killerTeam === teamId ? "ally"
					: "enemy",
				takenByChampion: seat === null ? null : present(seat.championName),
				userZone: sample?.zone ?? null,
				userZoneGapSec: sample?.gapSec ?? null,
				confidence: "low"
			})
		}
	return out.sort((a, b) => a.tSec - b.tSec)
}

/**
 * Metrics are PERSISTED with the baseline that was live when the game was analysed, frozen into
 * `explain` and `vsBaseline`. The corpus is a rolling 20-game window, so as new games land the
 * window slides and those figures go stale — measured across five recent games, 56% of them
 * disagreed with a freshly computed baseline, e.g. cs@10 stored `average is 64` against a live
 * mean of 65.42.
 *
 * Shipping both numbers in one prompt is worse than shipping either alone: the coach is told to
 * copy the average verbatim, and there are two different verbatim averages to copy. A review
 * duly reported elite control as "right around your own 45.9% baseline" — 45.9 was real, but it
 * was KILL PARTICIPATION's average, grabbed from a neighbouring line. Elite control's own
 * average was 48.66.
 *
 * So the digest restates every baseline from the live corpus before the prompt sees it, and the
 * prompt prints each average on its own metric's line. One metric, one average, nothing to hunt.
 */
const BASELINE_SENTENCE = /\s*Your \d+-game average is [^;]*; this game is [^.]*\./

const restateBaselines = (
	metrics: readonly Metric[],
	baseline: Baseline | undefined
): Metric[] =>
	metrics.map(metric => {
		const stat = baseline?.[metric.key]
		if (!stat || !Number.isFinite(stat.mean))
			return {
				...metric,
				baselineMean: null,
				baselineSd: null,
				baselineN: null,
				baselineText: undefined
			}
		const vs = metric.value - stat.mean
		const baselineText = `your ${stat.n}-game average ${round(stat.mean)}${metric.unit} (sd ${round(stat.sd)})`
		const fresh = ` Your ${stat.n}-game average is ${round(stat.mean)} (sd ${round(stat.sd)}); this game is ${vs >= 0 ? "+" : ""}${round(vs)}.`
		return {
			...metric,
			vsBaseline: vs,
			baselineMean: stat.mean,
			baselineSd: stat.sd,
			baselineN: stat.n,
			baselineText,
			// Replace the frozen sentence in place; if analysis never wrote one, append.
			explain:
				BASELINE_SENTENCE.test(metric.explain) ?
					metric.explain.replace(BASELINE_SENTENCE, fresh)
				:	`${metric.explain}${fresh}`
		}
	})

/**
 * The user's own rolling history, as sentences the coach can quote verbatim.
 *
 * EACH LINE NAMES ITS METRIC KEY, and that is a fabrication fence rather than a label. The two
 * `baseline-mismatch` warnings on real reviews this month are both the same shape — game
 * 5645783799, `"86.9" is cs@14's baseline, but this item cites csDelta@14, goldDelta@14`, and
 * game 5645454050, `"130.7" is cs@20's baseline, but this item cites csDelta@20, csPerMin` — a
 * REAL average quoted under the wrong metric's citation. Both figures appear in this section as
 * well as on their metric's own line, and until 2026-09-22 this section identified a line only by
 * its human LABEL ("CS @14"), which is one guess away from `csDelta@14`'s label ("CS diff vs
 * opponent @14") and carries no key at all. The key now travels with the figure. Whether that
 * changes the warning rate is NOT measured — it would take an A/B on the model — so this is a
 * mechanical repair to a join the coach was being asked to make by eye, and nothing more.
 *
 * The key goes at the END. `digest.baseline.test.ts` joins a prose line to its metric by
 * `startsWith(label + ":")`, and a check that proves the three renderings of one average agree is
 * worth more than a tidier line.
 */
export const baselineProse = (baseline: Baseline, metrics: readonly Metric[]): string[] => {
	const out: string[] = []
	for (const metric of metrics) {
		const stat = baseline[metric.key]
		if (!stat || stat.n < 3) continue
		out.push(
			`${metric.label}: this game ${round(metric.value)}${metric.unit}, ` +
				`your ${stat.n}-game median ${round(stat.median)}${metric.unit} ` +
				`(mean ${round(stat.mean)}, sd ${round(stat.sd)}). [key: ${metric.key}]`
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
	/** True when real replay frames exist; see `GameDigest.hasFrames`. */
	hasFrames?: boolean
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

	// Restate before anything reads them, so `metrics` and `baseline` below cannot disagree.
	const restated = restateBaselines(metrics, input.baseline)

	/*
	 * Champion context, FETCHED. This is the path the 2026-09-18 cutover was actually for.
	 *
	 * 28.9% of stored post-game items carry champion-kit content against 2.3% of live lines, so the
	 * review is where a wrong mechanic reaches him — 170 of 1,513 pieces of written advice traced to
	 * one false sentence about Swirlseed in a model-authored file. Every line below now comes out of
	 * `champion-table.ts` with its own URL, wiki revision and fetch date attached, and a claim that
	 * cannot be re-derived from its stored evidence never reaches this object.
	 *
	 * Still an enhancement and never a dependency: no row for the champion leaves `championContext`
	 * undefined and the review is unchanged, exactly as a missing markdown file used to.
	 *
	 * The counterpart's section drops the wiki's edge-case notes. Same reason as the live block —
	 * it is 60% of the bytes, it is measured inert, and dropping fetched lines can only make the
	 * coach know less rather than make it wrong.
	 */
	const brief = committedContext(game.championName)
	const oppBrief = opponent ? committedContext(opponent.championName, "core") : null
	const championContext: ChampionContext | undefined =
		brief ?
			{
				champion: game.championName,
				patch: contextPatch(),
				source: "fetched — every line carries its own source, revision and date",
				text: brief,
				staleness: contextStaleness(game.patch),
				// The generated table has no `_default` row: a champion nobody fetched yields no
				// section at all rather than a stand-in that reads like one.
				isDefault: false,
				opponent:
					oppBrief && opponent ?
						{ champion: opponent.championName, text: oppBrief }
					:	null
			}
		:	undefined

	return {
		kind: "game",
		schemaVersion: DIGEST_SCHEMA_VERSION,
		game: digestGame(game, participants),
		players: digestPlayers(game, participants),
		metrics: restated,
		moments: [...moments],
		dataGaps: [...GAME_DATA_GAPS],
		generatedMs: Date.now(),
		analysisVersion: input.analysisVersion,
		baseline:
			input.baseline ? baselineProse(input.baseline, restated)
			:	["No baseline yet — this is one of the first games stored, so nothing is banded."],
		championContext,
		hasFrames: input.hasFrames ?? false,
		objectives: digestObjectives(timeline, game.participantId, teamId, participants),
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
			slopeSignificant: s.slopeSignificant ?? null,
			slopePerGame: s.slopePerGame ?? null,
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
