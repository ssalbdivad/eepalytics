/**
 * Digests — the compact JSON the coach model actually sees.
 *
 * The raw timeline is ~112 KB per game. Nothing is gained by shipping it to a model that can
 * only skim it; everything is lost if the model starts inventing numbers because the one it
 * wanted was not in front of it. So the contract is:
 *
 *   **Everything Claude may cite must be IN the digest, and Claude may cite nothing else.**
 *
 * That is why every metric carries its `explain` string, every moment carries its `evidence`
 * line and a stable `id`, and every death carries the hedged `summary` sentence rather than
 * raw coordinates the model would have to interpret for itself. The `caveats` block is not
 * decoration: it is the list of things the model is forbidden to overclaim, written in the
 * same words the UI uses, so the review and the screen agree.
 *
 * Budgets: a game digest targets < 6k tokens, a trend digest < 10k. `trimToBudget` drops the
 * least severe moments and the least interesting deaths — never a caveat, never a metric's
 * confidence, never an id something else cites.
 */

import { ANALYSIS_VERSION, patchOf, queueName } from "../shared/constants.ts"
import type { TeamId } from "../shared/map.ts"
import { fmtClock, fmtDuration } from "../shared/time.ts"
import type { LcuGame } from "../shared/schema/lcu.ts"
import type { FeedbackItem, Metric, Role } from "../shared/schema/domain.ts"
import { round } from "./frames.ts"
import type { DeathAnalysis, DeathPattern } from "./deaths.ts"
import type { MomentDetail } from "./moments.ts"
import type { RoleInference } from "./roles.ts"
import type { Baseline } from "./metrics.ts"
import type { GameMetrics, TrendDetail, WinCorrelation } from "./trends.ts"

/* =============================================================== budgets */

/** ~4 characters per token is close enough to steer a trim loop. */
export const estimateTokens = (value: unknown): number =>
	Math.ceil(JSON.stringify(value).length / 4)

export const GAME_DIGEST_TOKEN_BUDGET = 6000
export const TREND_DIGEST_TOKEN_BUDGET = 10000
/** Tokens held back for the `truncated` note that trimming itself adds. */
export const TRUNCATION_NOTE_RESERVE = 60

/* ================================================================ shared */

/**
 * The rules the coaching prompt enforces. They live here, next to the data, because they are
 * statements ABOUT this data — not prompt decoration.
 */
export const CITATION_RULES: readonly string[] = [
	"Cite only moment ids, metric keys and death timestamps that appear in this digest. If it is not here, you do not know it.",
	"Never invent a number. Every figure you use must be copied from a `value`, `costGold` or `explain` field below.",
	"Respect `confidence`. Anything marked `low` came from positions sampled once per minute and must be phrased as a likelihood ('likely alone', 'looks like'), never as a fact ('you were alone').",
	"Respect `trendable: false`. Do not describe a metric as improving or declining unless the digest explicitly says its slope excludes zero.",
	"`band` is measured against this player's own past games, not against pro play. Never compare them to a pro's statline as if it were a benchmark.",
	"A metric with `band: \"unknown\"` has no history behind it yet. Say so rather than guessing which side of average it is on."
] as const

const CORE_CAVEATS: readonly string[] = [
	"Timeline frames arrive once per minute. The median player moves 4082 units — about 28% of the map — between two samples, so any claim about who was standing near whom is an inference with roughly 65% sensitivity, never proof.",
	"Event-derived facts (kill timestamps, kill positions, killer ids, elite-monster killer ids, building kills) are exact. Position-derived proximity is not.",
	"`ELITE_MONSTER_KILL.assistingParticipantIds` is corrupt in this data source (19% of listed assists name the opposing team) and has been ignored throughout. Objective credit here comes from `killerId`, which is reliable.",
	"There are no item, ward, or skill events in this data. Back timings are inferred from drops in carried gold and resolve to a 60-second window; there is no vision timeline at all.",
	"Death cost is a MODEL: kill gold handed over plus forgone income from an unverified respawn table. The measured figure, averaged over roughly 100 past deaths, is about 418 gold of excess team-gold cost per death, and the per-death spread is far larger than that mean."
] as const

const championNameOf = (
	names: Record<number, string> | undefined,
	championId: number
): string => names?.[championId] ?? `Champion ${championId}`

/* ========================================================== game digest */

export interface GameDigestInput {
	match: LcuGame
	roles: RoleInference
	userId: number
	metrics: Metric[]
	moments: MomentDetail[]
	deaths: DeathAnalysis[]
	/** Corpus-wide death patterns, so the coach can say "again". Optional on a cold start. */
	patterns?: DeathPattern[]
	baseline?: Baseline
	championNames?: Record<number, string>
	/** Riot ids by participantId, when the ingest layer resolved them. */
	riotIds?: Record<number, string>
	tokenBudget?: number
}

export interface DigestScoreboardRow {
	participantId: number
	team: TeamId
	champion: string
	role: Role
	roleConfidence: string
	riotId?: string
	isUser: boolean
	isOpponent: boolean
	k: number
	d: number
	a: number
	cs: number
	camps: number
	gold: number
	damage: number
	vision: number
	level: number
	win: boolean
}

export interface GameDigest {
	schema: "csk.game-digest/1"
	analysisVersion: number
	game: {
		gameId: number
		queue: string
		patch: string
		playedAt: string
		durationSec: number
		duration: string
		win: boolean
		side: "blue" | "red"
	}
	you: {
		participantId: number
		champion: string
		role: Role
		roleConfidence: string
		roleNote: string
		opponent: {
			participantId: number
			champion: string
			label: string
		} | null
		kda: string
		camps: number
		laneCs: number
		gold: number
		damageToChampions: number
		visionScore: number
		level: number
	}
	scoreboard: DigestScoreboardRow[]
	objectives: {
		yourTeam: Record<string, number>
		theirTeam: Record<string, number>
	}
	metrics: {
		key: string
		label: string
		value: number
		unit: string
		band: string
		vsBaseline: number | null
		confidence: string
		explain: string
	}[]
	moments: {
		id: string
		tSec: number
		clock: string
		kind: string
		title: string
		zone: string
		severity: number
		costGold: number | null
		confidence: string
		positive: boolean
		recurrenceCount: number
		cameraTarget: { x: number; y: number } | null
		why: string
		evidence: string
	}[]
	deaths: {
		tSec: number
		clock: string
		zone: string
		half: string
		level: number | null
		goldVsOpponent: number | null
		enemiesCredited: number
		isolation: string
		isolationConfidence: string
		provenAlliesPresent: number
		nearestAllyEstimate: number | null
		concededWithin45s: string[]
		summary: string
	}[]
	deathPatterns: {
		label: string
		deaths: number
		gamesSpanned: number
		shareOfDeaths: number
		lift: number
		pValue: number
		pAdjustedBH: number
		hypothesesTested: number
		caveat: string
	}[]
	baselineNote: string
	caveats: string[]
	citationRules: string[]
	/** Set when `trimToBudget` had to drop content, so the coach knows the list is partial. */
	truncated?: string
}

const objectiveCounts = (match: LcuGame, teamId: number): Record<string, number> => {
	const t = match.teams?.find(x => x.teamId === teamId)
	return {
		towers: t?.towerKills ?? 0,
		inhibitors: t?.inhibitorKills ?? 0,
		dragons: t?.dragonKills ?? 0,
		barons: t?.baronKills ?? 0,
		heralds: t?.riftHeraldKills ?? 0,
		voidgrubs: t?.hordeKills ?? 0
	}
}

/**
 * Build the compact game digest.
 *
 * Ordering is deliberate: context, then the user, then the scoreboard, then metrics, then the
 * ranked moments, then the deaths behind them, then the cross-game patterns, and only then the
 * caveats and citation rules — so a model reading top-to-bottom meets the evidence before it
 * meets the constraints on how to use it.
 */
export const buildGameDigest = (input: GameDigestInput): GameDigest => {
	const {
		match,
		roles,
		userId,
		metrics,
		moments,
		deaths,
		patterns = [],
		baseline,
		championNames,
		riotIds
	} = input

	const meP = match.participants.find(p => p.participantId === userId)
	if (!meP) throw new Error(`participant ${userId} is not in game ${match.gameId}`)
	const teamId = meP.teamId as TeamId
	const role = roles.roles[userId] ?? "UNKNOWN"
	const opponent =
		match.participants.find(
			p => p.teamId !== teamId && roles.roles[p.participantId] === role
		) ?? null

	const scoreboard: DigestScoreboardRow[] = match.participants
		.map(p => ({
			participantId: p.participantId,
			team: p.teamId as TeamId,
			champion: championNameOf(championNames, p.championId),
			role: roles.roles[p.participantId] ?? ("UNKNOWN" as Role),
			roleConfidence: roles.confidence[p.participantId] ?? "low",
			riotId: riotIds?.[p.participantId],
			isUser: p.participantId === userId,
			isOpponent: p.participantId === opponent?.participantId,
			k: p.stats.kills,
			d: p.stats.deaths,
			a: p.stats.assists,
			cs: p.stats.totalMinionsKilled,
			camps: p.stats.neutralMinionsKilled,
			gold: p.stats.goldEarned,
			damage: p.stats.totalDamageDealtToChampions,
			vision: p.stats.visionScore,
			level: p.stats.champLevel,
			win: p.stats.win
		}))
		.sort((a, b) => a.participantId - b.participantId)

	const baselineGames = baseline?.["csPerMin"]?.n ?? 0

	const digest: GameDigest = {
		schema: "csk.game-digest/1",
		analysisVersion: ANALYSIS_VERSION,
		game: {
			gameId: match.gameId,
			queue: queueName(match.queueId),
			patch: patchOf(match.gameVersion),
			playedAt: new Date(match.gameCreation).toISOString(),
			durationSec: match.gameDuration,
			duration: fmtDuration(match.gameDuration),
			win: meP.stats.win,
			side: teamId === 100 ? "blue" : "red"
		},
		you: {
			participantId: userId,
			champion: championNameOf(championNames, meP.championId),
			role,
			roleConfidence: roles.confidence[userId] ?? "low",
			roleNote:
				roles.notes.length > 0 ?
					roles.notes.join(" ")
				:	"Roles were inferred from laning-phase positions and Smite, not from the API's own lane/role fields, which are wrong in this data source.",
			opponent:
				opponent ?
					{
						participantId: opponent.participantId,
						champion: championNameOf(championNames, opponent.championId),
						label:
							role === "JGL" ?
								"the enemy jungler — for a jungler this is the 'lane opponent' every early-game comparison below uses"
							:	`the enemy ${role}`
					}
				:	null,
			kda: `${meP.stats.kills}/${meP.stats.deaths}/${meP.stats.assists}`,
			camps: meP.stats.neutralMinionsKilled,
			laneCs: meP.stats.totalMinionsKilled,
			gold: meP.stats.goldEarned,
			damageToChampions: meP.stats.totalDamageDealtToChampions,
			visionScore: meP.stats.visionScore,
			level: meP.stats.champLevel
		},
		scoreboard,
		objectives: {
			yourTeam: objectiveCounts(match, teamId),
			theirTeam: objectiveCounts(match, teamId === 100 ? 200 : 100)
		},
		metrics: metrics.map(m => ({
			key: m.key,
			label: m.label,
			value: m.value,
			unit: m.unit,
			band: m.band,
			vsBaseline: m.vsBaseline,
			confidence: m.confidence,
			explain: m.explain
		})),
		moments: moments.map(d => ({
			id: d.moment.id,
			tSec: d.moment.tSec,
			clock: fmtClock(d.moment.tSec),
			kind: d.moment.kind,
			title: d.moment.title,
			zone: d.zoneLabel,
			severity: d.moment.severity,
			costGold: d.moment.costGold,
			confidence: d.moment.confidence,
			positive: d.positive,
			recurrenceCount: d.recurrenceCount,
			cameraTarget: d.moment.cameraTarget,
			why: d.why,
			evidence: d.moment.evidence
		})),
		deaths: deaths.map(d => ({
			tSec: d.tSec,
			clock: d.clock,
			zone: d.zoneLabel,
			half: d.half,
			level: d.level,
			goldVsOpponent: d.goldDeltaVsOpponent,
			enemiesCredited: d.enemiesCredited,
			isolation: d.isolation.verdict,
			isolationConfidence: d.isolation.confidence,
			provenAlliesPresent: d.isolation.provenAlliesPresent.length,
			nearestAllyEstimate: d.isolation.nearestAllyDistance,
			concededWithin45s: d.objectiveContext.objectiveConcededWithin45s,
			summary: d.summary
		})),
		deathPatterns: patterns.map(p => ({
			label: p.label,
			deaths: p.support,
			gamesSpanned: p.gamesSpanned,
			shareOfDeaths: round(p.share, 3),
			lift: round(p.lift, 2),
			pValue: Number(p.pValue.toPrecision(2)),
			pAdjustedBH: Number(p.pAdjusted.toPrecision(2)),
			hypothesesTested: p.hypothesesTested,
			caveat: `${p.hypothesesTested} combinations were tested, so quote the Benjamini-Hochberg adjusted p (${Number(p.pAdjusted.toPrecision(2))}), not the raw one. The pattern spans ${p.gamesSpanned} distinct games, which is what stops it being one bad night.`
		})),
		baselineNote:
			baselineGames >= 5 ?
				`Every band compares this game against this player's own previous ${baselineGames} games: "good" or "bad" means more than half a standard deviation of their OWN spread away from their OWN average. These are not pro benchmarks and must never be presented as one.`
			:	`There is not enough history yet to band anything (${baselineGames} prior games, 5 needed). Every band reads "unknown" and that is correct — do not guess.`,
		caveats: [...CORE_CAVEATS],
		citationRules: [...CITATION_RULES]
	}

	return trimGameDigest(digest, input.tokenBudget ?? GAME_DIGEST_TOKEN_BUDGET)
}

/**
 * Shrink a digest to fit. Drops the least severe moments first, then the least interesting
 * deaths (the ones with neither a conceded objective nor an isolation verdict), then long
 * `explain` strings on metrics that have no baseline to compare against.
 * Caveats, citation rules and ids that other content references are never dropped.
 */
export const trimGameDigest = (digest: GameDigest, budget: number): GameDigest => {
	let dropped = 0
	/**
	 * Keep enough of a string to still be a sentence a human can check. A metric whose whole
	 * first sentence is "8/6/19." has been shortened into uselessness, so keep going until
	 * there is something to read.
	 */
	const shorten = (text: string, min = 45): string => {
		let cut = -1
		while (cut < min) {
			const next = text.indexOf(". ", cut + 1)
			if (next < 0) return text
			cut = next
		}
		return text.slice(0, cut + 1)
	}
	/*
	 * Reserve room for the `truncated` note itself: it is appended AFTER trimming, and without
	 * the reserve a digest could be trimmed to exactly the budget and then pushed back over by
	 * the sentence saying it had been trimmed.
	 */
	const over = (): boolean => estimateTokens(digest) > budget - TRUNCATION_NOTE_RESERVE

	/* 1. The dullest metrics keep their number and lose their essay. */
	if (over())
		for (const m of digest.metrics)
			if (m.band === "ok" && m.confidence !== "low") m.explain = shorten(m.explain)

	/* 2. Then the long tail of patterns. */
	while (over() && digest.deathPatterns.length > 5) {
		digest.deathPatterns.pop()
		dropped++
	}

	/* 3. Then deaths with neither a conceded objective nor an isolation verdict. */
	while (over() && digest.deaths.length > 6) {
		const idx = digest.deaths.findIndex(
			d => d.concededWithin45s.length === 0 && d.isolation !== "SOLO"
		)
		digest.deaths.splice(idx >= 0 ? idx : digest.deaths.length - 1, 1)
		dropped++
	}

	/* 4. Then every metric loses its essay. */
	if (over()) for (const m of digest.metrics) m.explain = shorten(m.explain)

	/* 5. Moments are the point of the review, so they go last and never below five. */
	while (over() && digest.moments.length > 5) {
		const weakest = digest.moments.reduce(
			(worst, m, i, arr) => (m.severity < arr[worst]!.severity ? i : worst),
			0
		)
		digest.moments.splice(weakest, 1)
		dropped++
	}

	/* 6. Then the moments' long provenance lines shrink, keeping the claim and losing the essay. */
	if (over())
		for (const m of digest.moments) {
			m.evidence = shorten(m.evidence, 80)
			m.why = shorten(m.why, 60)
		}

	/* 7. Last resort: unbanded and average metrics leave entirely. */
	if (over()) {
		const keep = digest.metrics.filter(m => m.band === "good" || m.band === "bad")
		if (keep.length >= 6) {
			dropped += digest.metrics.length - keep.length
			digest.metrics = keep
		}
	}

	/* 8. And finally the remaining tail of deaths and patterns. */
	while (over() && digest.deaths.length > 3) {
		digest.deaths.pop()
		dropped++
	}
	while (over() && digest.deathPatterns.length > 1) {
		digest.deathPatterns.pop()
		dropped++
	}

	/*
	 * 9. Absolute last resort, so the budget is always met: hard-cap the prose. Claims and ids
	 * survive intact; only the tail of an explanation is lost, and `truncated` says so.
	 */
	if (over()) {
		const cap = (t: string, n: number): string =>
			t.length <= n ? t : `${t.slice(0, n - 3).trimEnd()}...`
		for (const m of digest.metrics) m.explain = cap(m.explain, 160)
		for (const m of digest.moments) {
			m.evidence = cap(m.evidence, 200)
			m.why = cap(m.why, 140)
		}
		for (const d of digest.deaths) d.summary = cap(d.summary, 200)
		for (const p of digest.deathPatterns) p.caveat = cap(p.caveat, 160)
		dropped++
	}

	if (dropped > 0)
		digest.truncated = `${dropped} lower-ranked item${dropped === 1 ? "" : "s"} were dropped to fit the context budget, and some explanations were shortened. Do not describe these lists as exhaustive.`
	return digest
}

/* ========================================================= trend digest */

export interface TrendDigestInput {
	rows: GameMetrics[]
	series: TrendDetail[]
	patterns: DeathPattern[]
	deaths: DeathAnalysis[]
	winCorrelations?: WinCorrelation[]
	/** Recent coaching points, so the coach can follow up rather than repeat itself. */
	recentFeedback?: FeedbackItem[]
	championNames?: Record<number, string>
	/** Champion + role per game, when the caller has the matches to hand. */
	gameContext?: Record<number, { champion: string; role: Role }>
	tokenBudget?: number
	/** How many metric series to include. Trendable ones are kept first. */
	maxSeries?: number
}

export interface TrendDigest {
	schema: "csk.trend-digest/1"
	analysisVersion: number
	window: {
		games: number
		wins: number
		losses: number
		from: string
		to: string
		note: string
	}
	games: {
		gameId: number
		playedAt: string
		champion?: string
		role?: Role
		win: boolean
		durationMin: number
		headline: Record<string, number>
	}[]
	trendable: {
		key: string
		label: string
		unit: string
		n: number
		mean: number
		ci95: number | null
		direction: string
		note: string
	}[]
	notTrendable: {
		key: string
		label: string
		unit: string
		n: number
		mean: number
		ci95: number | null
		why: string
	}[]
	deathPatterns: GameDigest["deathPatterns"]
	deathSummary: {
		total: number
		perGame: number
		byZone: { zone: string; n: number; share: number }[]
		byPhase: Record<string, number>
		byIsolation: Record<string, number>
		soloShare: number
		note: string
	}
	winCorrelations: {
		key: string
		label: string
		r: number
		pValue: number
		survivesCorrection: boolean
		confounded: boolean
		note: string
	}[]
	previousGoals: string[]
	caveats: string[]
	citationRules: string[]
	truncated?: string
}

const HEADLINE_KEYS = [
	"cs@10",
	"csPerMin",
	"kda",
	"deaths",
	"goldPerMin",
	"visionPerMin"
] as const

/**
 * Build the cross-game digest. Trendable and not-trendable series are kept in SEPARATE arrays
 * on purpose: it is much harder for a model to accidentally draw a trend line through the
 * second list when the second list is literally called `notTrendable` and every entry carries
 * a `why`.
 */
export const buildTrendDigest = (input: TrendDigestInput): TrendDigest => {
	const {
		rows,
		series,
		patterns,
		deaths,
		winCorrelations = [],
		recentFeedback = [],
		gameContext,
		maxSeries = 14
	} = input

	const wins = rows.filter(r => r.win).length
	const from = rows.length > 0 ? new Date(rows[0]!.tMs).toISOString() : ""
	const to = rows.length > 0 ? new Date(rows[rows.length - 1]!.tMs).toISOString() : ""

	const byZoneCounts = new Map<string, number>()
	const byPhase: Record<string, number> = {}
	const byIsolation: Record<string, number> = {}
	for (const d of deaths) {
		byZoneCounts.set(d.zoneLabel, (byZoneCounts.get(d.zoneLabel) ?? 0) + 1)
		byPhase[d.phase] = (byPhase[d.phase] ?? 0) + 1
		byIsolation[d.isolation.verdict] = (byIsolation[d.isolation.verdict] ?? 0) + 1
	}
	const totalDeaths = deaths.length || 0

	const trendable = series.filter(s => s.trendable).slice(0, maxSeries)
	const notTrendable = series
		.filter(s => !s.trendable)
		.slice(0, Math.max(0, maxSeries - trendable.length) + 8)

	const digest: TrendDigest = {
		schema: "csk.trend-digest/1",
		analysisVersion: ANALYSIS_VERSION,
		window: {
			games: rows.length,
			wins,
			losses: rows.length - wins,
			from,
			to,
			note: "These games were played close together, often in one sitting, so they are NOT independent samples. Every confidence interval below assumes independence and is therefore narrower than the truth."
		},
		games: rows.map(r => ({
			gameId: r.gameId,
			playedAt: new Date(r.tMs).toISOString(),
			champion: gameContext?.[r.gameId]?.champion,
			role: gameContext?.[r.gameId]?.role,
			win: r.win,
			durationMin: round(r.durationSec / 60, 1),
			headline: Object.fromEntries(
				HEADLINE_KEYS.flatMap(k => {
					const m = r.metrics.find(x => x.key === k)
					return m ? [[k, m.value] as const] : []
				})
			)
		})),
		trendable: trendable.map(s => ({
			key: s.key,
			label: s.label,
			unit: s.unit,
			n: s.n,
			mean: s.mean,
			ci95: s.ci95,
			direction:
				s.slope?.significant ?
					s.slope.perGame > 0 ? "rising (slope CI excludes zero)"
					:	"falling (slope CI excludes zero)"
				:	"flat — no direction may be claimed, the slope's CI contains zero",
			note: s.note
		})),
		notTrendable: notTrendable.map(s => ({
			key: s.key,
			label: s.label,
			unit: s.unit,
			n: s.n,
			mean: s.mean,
			ci95: s.ci95,
			why: s.note
		})),
		deathPatterns: patterns.map(p => ({
			label: p.label,
			deaths: p.support,
			gamesSpanned: p.gamesSpanned,
			shareOfDeaths: round(p.share, 3),
			lift: round(p.lift, 2),
			pValue: Number(p.pValue.toPrecision(2)),
			pAdjustedBH: Number(p.pAdjusted.toPrecision(2)),
			hypothesesTested: p.hypothesesTested,
			caveat: `${p.hypothesesTested} combinations were tested; quote the Benjamini-Hochberg adjusted p (${Number(p.pAdjusted.toPrecision(2))}), not the raw one. Spans ${p.gamesSpanned} distinct games.`
		})),
		deathSummary: {
			total: totalDeaths,
			perGame: rows.length > 0 ? round(totalDeaths / rows.length, 2) : 0,
			byZone: [...byZoneCounts]
				.map(([zone, n]) => ({
					zone,
					n,
					share: round(n / Math.max(1, totalDeaths), 3)
				}))
				.sort((a, b) => b.n - a.n)
				.slice(0, 10),
			byPhase,
			byIsolation,
			soloShare: round((byIsolation["SOLO"] ?? 0) / Math.max(1, totalDeaths), 3),
			note: "Isolation verdicts mix hard evidence with interpolation. A verdict of WITH_TEAM is backed by an ally scoring or taking a kill within 10 seconds and 2500 units; SOLO and PARTIAL lean on positions sampled once a minute and should always be phrased as a likelihood."
		},
		winCorrelations: winCorrelations.slice(0, 8).map(w => ({
			key: w.key,
			label: w.label,
			r: w.r,
			pValue: Number(w.pValue.toPrecision(2)),
			survivesCorrection: w.survivesCorrection,
			confounded: w.confounded,
			note: w.note
		})),
		previousGoals: recentFeedback.slice(0, 8).map(f => f.title),
		caveats: [
			...CORE_CAVEATS,
			"A metric appearing in `notTrendable` must never be described as going up or down. Report its mean and its interval, and say plainly that the sample cannot support a direction.",
			"Correlation with winning is not a lever. Metrics flagged `confounded` move because the player was already winning; recommending them is advice to win in order to win."
		],
		citationRules: [
			...CITATION_RULES,
			"Cite metric keys exactly as they appear (for example `cs@10`), and game ids exactly as they appear."
		]
	}

	return trimTrendDigest(digest, input.tokenBudget ?? TREND_DIGEST_TOKEN_BUDGET)
}

export const trimTrendDigest = (digest: TrendDigest, budget: number): TrendDigest => {
	let dropped = 0
	const over = (): boolean => estimateTokens(digest) > budget - TRUNCATION_NOTE_RESERVE
	while (over() && digest.notTrendable.length > 4) {
		digest.notTrendable.pop()
		dropped++
	}
	while (over() && digest.deathPatterns.length > 3) {
		digest.deathPatterns.pop()
		dropped++
	}
	while (over() && digest.trendable.length > 5) {
		digest.trendable.pop()
		dropped++
	}
	while (over() && digest.games.length > 10) {
		digest.games.shift()
		dropped++
	}
	if (over()) {
		const cap = (t: string, n: number): string =>
			t.length <= n ? t : `${t.slice(0, n - 3).trimEnd()}...`
		for (const s of [...digest.trendable]) s.note = cap(s.note, 240)
		for (const s of [...digest.notTrendable]) s.why = cap(s.why, 240)
		for (const p of digest.deathPatterns) p.caveat = cap(p.caveat, 160)
		dropped++
	}
	if (dropped > 0)
		digest.truncated = `${dropped} lower-ranked item${dropped === 1 ? "" : "s"} were dropped to fit the context budget. Do not describe this list as exhaustive.`
	return digest
}

