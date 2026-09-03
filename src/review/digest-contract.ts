/**
 * The shape `src/analysis/digest.ts` must hand the coach.
 *
 * The analysis unit owns the *producer*; this file is the *consumer's* contract, written
 * here so the review unit can be built and tested without waiting on it. The integration
 * pass should reconcile the two — if `src/analysis/digest.ts` exports equivalent types,
 * delete these and import from there instead.
 *
 * Three deliberate design decisions live in this file:
 *
 *  1. **Validators are permissive.** Everything the prompt renders is required; everything
 *     else is optional and unrecognised keys pass through untouched. A sibling unit adding
 *     a field must never break the coach.
 *  2. **No teammate identities.** `DigestPlayer` carries a champion and a role and nothing
 *     that names a human. Hard rule 6 of the persona ("never roast a named teammate") is
 *     therefore enforced by the *data*, not only by the prompt: the model cannot name
 *     someone it was never told about. Do not add `riotId`/`summonerName` here.
 *  3. **`dataGaps` is required.** The single most important thing the coach can be told is
 *     what it must refuse to talk about. An empty array is a claim that nothing is missing,
 *     which for an LCU timeline is never true — populate it.
 */

import { type } from "arktype"
import { Confidence, Metric, Moment, Role, TrendSeries } from "../shared/schema/domain.ts"

/** Bumped when the digest's shape changes in a way the prompt renders differently. */
export const DIGEST_SCHEMA_VERSION = 2

/**
 * One player in the game, stripped of identity. `team` is relative to the user, so the
 * prompt never has to reason about 100/200.
 */
export const DigestPlayer = type({
	participantId: "number",
	team: "'ally'|'enemy'",
	role: Role,
	championName: "string",
	isUser: "boolean",
	kills: "number",
	deaths: "number",
	assists: "number",
	/** Effective CS — camps for a jungler, minions+camps otherwise. See `effectiveCs`. */
	cs: "number",
	gold: "number",
	visionScore: "number",
	champLevel: "number",
	damageToChampions: "number"
})
export type DigestPlayer = typeof DigestPlayer.infer

/** One per-minute row of the timeline, already differenced against the role opponent. */
export const DigestTimelineRow = type({
	minute: "number",
	"goldDiff?": "number|null",
	"csDiff?": "number|null",
	"xpDiff?": "number|null",
	/** Prose zone name from `zoneOf()`, e.g. "enemy red-side jungle (bot)". */
	"zone?": "string|null"
})
export type DigestTimelineRow = typeof DigestTimelineRow.infer

/** An objective the game recorded, with who took it and where the user was. */
export const DigestObjective = type({
	tSec: "number",
	kind: "string",
	"subType?": "string|null",
	takenBy: "'ally'|'enemy'",
	/** Prose zone the user occupied at the nearest frame. Interpolated — hedge it. */
	"userZone?": "string|null",
	"confidence?": Confidence
})
export type DigestObjective = typeof DigestObjective.infer

export const DigestGame = type({
	gameId: "number",
	teamId: "100|200",
	queue: "string",
	patch: "string",
	durationSec: "number",
	win: "boolean",
	championName: "string",
	role: Role,
	roleConfidence: Confidence,
	kills: "number",
	deaths: "number",
	assists: "number",
	cs: "number",
	jungleCs: "number",
	gold: "number",
	visionScore: "number",
	champLevel: "number",
	damageToChampions: "number",
	"gameCreationMs?": "number",
	"teamKills?": "number",
	"enemyKills?": "number"
})
export type DigestGame = typeof DigestGame.infer

/**
 * Everything the coach gets for ONE game. Deliberately compact: the raw timeline is ~112 KB
 * (~30k tokens) and sending it produces worse feedback than sending derived facts, on top of
 * costing 20x more.
 */
/** Champion notes as the prompt receives them. See `src/knowledge/`. */
export const ChampionContext = type({
	champion: "string",
	/** The note's own patch, or "durable" for champion identity that survives tuning. */
	patch: "string",
	source: "string",
	text: "string",
	/** Set when the note's patch differs from the game's; the prompt tells the coach to hedge. */
	"staleness?": "string|null",
	/** True when `_default.md` stood in because no file matched — i.e. we know nothing. */
	isDefault: "boolean",
	/** The enemy jungler's note, when one exists. Same fence applies. */
	"opponent?": type({ champion: "string", text: "string" }).or("null")
})
export type ChampionContext = typeof ChampionContext.infer

export const GameDigest = type({
	kind: "'game'",
	schemaVersion: "number",
	game: DigestGame,
	players: DigestPlayer.array(),
	metrics: Metric.array(),
	moments: Moment.array(),
	/** Statements of what the source data cannot answer. Required — see the file header. */
	dataGaps: "string[]",
	"generatedMs?": "number",
	"analysisVersion?": "number",
	/** The user's own rolling baseline, in prose: "20-game median: 18 camps at 8:00". */
	"baseline?": "string[]",
	"objectives?": DigestObjective.array(),
	"timeline?": DigestTimelineRow.array(),
	/** Free-form caveats from analysis ("only 6 frames — game ended at 5:41"). */
	"notes?": "string[]",
	/**
	 * Editable champion context from `knowledge/`. NOT measured from this game — it is general
	 * knowledge about how the champion works, and nothing in it can be checked against the
	 * data. The prompt fences it accordingly: it may justify a fix, it may never become a
	 * number, and the digest wins any disagreement.
	 */
	"championContext?": ChampionContext
})
export type GameDigest = typeof GameDigest.infer

/** One row of the trend window. Same identity rule: champions, never names. */
export const TrendGameRow = type({
	gameId: "number",
	gameCreationMs: "number",
	championName: "string",
	role: Role,
	win: "boolean",
	durationSec: "number",
	kills: "number",
	deaths: "number",
	assists: "number",
	cs: "number",
	gold: "number",
	visionScore: "number",
	"queue?": "string"
})
export type TrendGameRow = typeof TrendGameRow.infer

/** A coaching point from an earlier per-game review, so the trend pass can spot repeats. */
export const PriorFeedback = type({
	gameId: "number|null",
	title: "string",
	severity: "'info'|'minor'|'major'",
	"category?": "string"
})
export type PriorFeedback = typeof PriorFeedback.infer

/** Everything the coach gets for the cross-game pass. */
export const TrendDigest = type({
	kind: "'trend'",
	schemaVersion: "number",
	gameCount: "number",
	games: TrendGameRow.array(),
	series: TrendSeries.array(),
	dataGaps: "string[]",
	"generatedMs?": "number",
	"analysisVersion?": "number",
	"windowFromMs?": "number",
	"windowToMs?": "number",
	/** Window-level aggregates (means, medians) as `Metric`s so bands/confidence come along. */
	"aggregates?": Metric.array(),
	"priorFeedback?": PriorFeedback.array(),
	"notes?": "string[]"
})
export type TrendDigest = typeof TrendDigest.infer

export const Digest = GameDigest.or(TrendDigest)
export type Digest = typeof Digest.infer

/** The ids a feedback item is allowed to cite. Anything else is a fabrication. */
export interface CitationAllowlist {
	momentIds: Set<string>
	metricKeys: Set<string>
	/**
	 * Every baseline figure the digest printed, keyed by the metric it belongs to, plus the union.
	 * A baseline is the easiest number to get wrong invisibly: a review once reported elite
	 * control as "right around your own 45.9% baseline" when 45.9 was KILL PARTICIPATION's
	 * average and elite control's was 48.66. Both numbers were real and only one was relevant, so
	 * a presence check passes and the coaching conclusion is still wrong. Keeping the figures
	 * per-metric is what lets the parser tell those two cases apart.
	 */
	baselineByMetric: Map<string, Set<string>>
	baselineFigures: Set<string>
}

/** How a figure is compared: digits only, so "2,874" and "2874.0" collapse to one token. */
export const baselineToken = (raw: string): string => {
	const n = Number(raw.replace(/,/g, ""))
	return Number.isFinite(n) ? String(n) : raw
}

const figuresOf = (text: string | undefined): string[] =>
	text ? [...text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].map(m => baselineToken(m[0])) : []

export const allowlistOf = (digest: Digest): CitationAllowlist => {
	const baselineByMetric = new Map<string, Set<string>>()
	const baselineFigures = new Set<string>()
	if (digest.kind === "game")
		for (const m of digest.metrics) {
			// `baselineText` is the one authored rendering; `explain` restates it. Accept both
			// spellings of the same measurement so a faithful quote is never flagged.
			const figures = new Set([...figuresOf(m.baselineText), ...figuresOf(m.explain)])
			for (const f of figures) baselineFigures.add(f)
			baselineByMetric.set(m.key, figures)
		}
	return digest.kind === "game" ?
			{
				momentIds: new Set(digest.moments.map(m => m.id)),
				metricKeys: new Set(digest.metrics.map(m => m.key)),
				baselineByMetric,
				baselineFigures
			}
		:	{
				momentIds: new Set<string>(),
				metricKeys: new Set([
					...digest.series.map(s => s.key),
					...(digest.aggregates ?? []).map(m => m.key)
				]),
				baselineByMetric,
				baselineFigures
			}
}
