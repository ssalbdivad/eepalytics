/**
 * Turning what the model said into something the app is willing to show.
 *
 * This file is where "never fabricate a stat" stops being an instruction and becomes a
 * property of the pipeline. The prompt tells the coach it may only cite ids that appear in
 * the digest; this file *checks*, and:
 *
 *  - a citation that is not in the digest is **dropped**, with a warning;
 *  - an item whose citations were *all* invented is **deleted whole**, because a made-up
 *    citation is strong evidence the surrounding prose is made up too;
 *  - a `tSec` outside the game's duration is **nulled**, because a timestamp that cannot be
 *    seeked to is worse than no timestamp;
 *  - an item that cites nothing and contains no digit at all is **kept but flagged**
 *    (`no-number-cited`), so the UI can render it as opinion rather than as coaching.
 *
 * Two checks below reach past the ids into the PROSE, because the ids were never where the
 * measured defect lived: across 293 stored A/B items the id fence caught one bad metric key and
 * zero bad moment ids, while three judge models put the share of items whose every FIGURE checks
 * out at ~65%. `baseline-mismatch` catches a real number attributed to the wrong metric;
 * `invented-trigger-clock` catches a fix that hangs off a spawn time nothing here measures. Both
 * WARN and carry their message onto the item rather than dropping it — each one's own comment
 * carries the precision measurement that decided that, and the generalisation to "every prose
 * figure" is refuted with its number at `invented-trigger-clock`.
 *
 * Nothing in here throws. The daemon gets a discriminated result and decides whether to fail
 * the job, and `failedReview()` gives it a persistable row either way — a review that failed
 * should be visible in the UI with its error, not silently missing.
 */

import { type } from "arktype"
import { ANALYSIS_VERSION } from "../shared/constants.ts"
import type { FeedbackItem, FeedbackSeverity, Review, ReviewKind } from "../shared/schema/domain.ts"
import type { CoachMeta } from "./claude.ts"
import { extractJson } from "./claude.ts"
import { baselineToken } from "./digest-contract.ts"
import type { CitationAllowlist } from "./digest-contract.ts"
import { rankItems } from "./rank.ts"

/* ============================================================ results */

export type ParseFailureCode =
	/** Nothing usable came back at all. */
	| "empty"
	/** There was text but no JSON object in it. */
	| "not-json"
	/** JSON, but not an object. */
	| "not-object"
	/** An object, but the wrong shape. `detail` carries ArkType's summary. */
	| "schema"
	/** Every item was dropped by the citation/quality checks. A review with no items is not one. */
	| "no-items"

export type ParseWarningCode =
	| "unknown-moment-id"
	| "unknown-metric-key"
	| "fabricated-citations"
	| "tsec-out-of-range"
	| "tsec-coerced"
	| "empty-item"
	| "no-number-cited"
	| "baseline-mismatch"
	| "invented-trigger-clock"
	| "no-fix"
	| "over-budget"
	| "demoted-low-confidence"
	| "no-citations"
	| "no-praise"
	| "items-truncated"
	| "goals-truncated"
	| "goals-missing"
	| "encouragement-missing"
	| "coerced-field"

export interface ParseWarning {
	code: ParseWarningCode
	message: string
	/** Index into the model's original `items` array, when the warning is about one item. */
	itemIndex?: number
}

export type ParseResult<T> =
	| { ok: true; value: T; warnings: ParseWarning[] }
	| { ok: false; code: ParseFailureCode; error: string; detail?: string; warnings: ParseWarning[] }

/* ============================================================= schema */

/** Exactly what the model is asked for. `id`/`gameId`/`mediaIds` are assigned by us. */
/**
 * Field budgets, enforced as warnings rather than truncation.
 *
 * Cutting a sentence in half mid-word is worse than showing a long one; the signal belongs on
 * the review where it can be seen and the prompt tightened. These are the same numbers the
 * prompt states, in one place so the two cannot drift.
 */
export const TITLE_MAX = 70
export const FIX_MAX = 140
export const BODY_MAX = 500

export const CoachItem = type({
	title: "string",
	/** One imperative sentence. Required in the contract; older reviews predate it. */
	"fix?": "string",
	/** Optional elaboration, collapsed in the UI. */
	"body?": "string",
	severity: "'info'|'minor'|'major'",
	/** Judgments the app ranks by. Optional so an older or sloppier response still parses. */
	"impact?": "'high'|'medium'|'low'",
	"actionability?": "'high'|'medium'|'low'",
	"confidence?": "'high'|'medium'|'low'",
	"category?": "string",
	tSec: "number|null",
	momentIds: "string[]",
	metricKeys: "string[]"
})
export type CoachItem = typeof CoachItem.infer

export const CoachOutput = type({
	headline: "string",
	encouragement: "string",
	items: CoachItem.array(),
	goals: "string[]"
})
export type CoachOutput = typeof CoachOutput.infer

/**
 * The categories the UI knows how to badge. Anything else is kept verbatim but lower-cased.
 *
 * `prompt.ts` puts this exact list in the JSON schema the model is given, so the enum the coach
 * is told about and the set the UI can render cannot disagree.
 */
export const COACH_CATEGORIES = [
	"pathing",
	"tempo",
	"objectives",
	"vision",
	"farming",
	"teamfight",
	"deaths",
	"praise",
	"other"
] as const

/* ========================================================== recovery */

/** Re-exported so callers have one place to look for the forgiving JSON extractor. */
export { extractJson }

const SEVERITIES = new Set(["info", "minor", "major"])

const asString = (v: unknown): string | undefined =>
	typeof v === "string" ? v
	: typeof v === "number" && Number.isFinite(v) ? String(v)
	: undefined

const asStringArray = (v: unknown): string[] =>
	Array.isArray(v) ?
		v.map(asString).filter((s): s is string => typeof s === "string" && s.trim() !== "")
	: typeof v === "string" && v.trim() !== "" ? [v]
	: []

const asTSec = (v: unknown): number | null | "coerced-bad" => {
	if (v === null || v === undefined || v === "") return null
	if (typeof v === "number") return Number.isFinite(v) ? v : "coerced-bad"
	if (typeof v === "string") {
		// "8:12" and "492" are both things a model will hand you.
		const clock = /^(\d{1,2}):([0-5]?\d)$/.exec(v.trim())
		if (clock) return Number(clock[1]) * 60 + Number(clock[2])
		const num = Number(v.trim())
		return Number.isFinite(num) ? num : "coerced-bad"
	}
	return "coerced-bad"
}

/**
 * Best-effort coercion of a model's object into `CoachOutput`'s shape, before ArkType sees
 * it. This is the "forgiving" half; ArkType is the "then be strict" half.
 */
const normalize = (raw: Record<string, unknown>, warnings: ParseWarning[]): unknown => {
	const itemsRaw =
		Array.isArray(raw.items) ? raw.items
		: Array.isArray((raw as { feedback?: unknown }).feedback) ? (raw as { feedback: unknown[] }).feedback
		: []

	const items = itemsRaw.map((it, i) => {
		const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>
		const severity = asString(o.severity)?.toLowerCase().trim() ?? ""
		if (o.severity !== undefined && !SEVERITIES.has(severity))
			warnings.push({
				code: "coerced-field",
				itemIndex: i,
				message: `severity ${JSON.stringify(o.severity)} is not info/minor/major; treated as "minor"`
			})
		// `tsMs` is a shape an earlier draft of the persona asked for; accept it and convert.
		const tSecRaw =
			o.tSec !== undefined ? asTSec(o.tSec)
			: typeof o.tsMs === "number" && Number.isFinite(o.tsMs) ? o.tsMs / 1000
			: null
		if (tSecRaw === "coerced-bad")
			warnings.push({
				code: "tsec-coerced",
				itemIndex: i,
				message: `tSec ${JSON.stringify(o.tSec)} could not be read as a game clock; dropped`
			})
		// `normalize` rebuilds the item field by field rather than spreading, so anything not
		// named here is silently dropped before validation ever sees it. Every new field in
		// `CoachItem` has to be listed, or it vanishes with no error at all.
		const axis = (v: unknown): "high" | "medium" | "low" | undefined => {
			const t = asString(v)?.toLowerCase().trim()
			return t === "high" || t === "medium" || t === "low" ? t : undefined
		}
		return {
			title: (asString(o.title) ?? "").trim(),
			// `action` and `next` are shapes the model reaches for when it forgets the field name.
			fix: (asString(o.fix) ?? asString(o.action) ?? asString(o.next) ?? "").trim(),
			body: (asString(o.body) ?? asString(o.text) ?? "").trim(),
			severity: SEVERITIES.has(severity) ? severity : "minor",
			...(axis(o.impact) ? { impact: axis(o.impact) } : {}),
			...(axis(o.actionability) ? { actionability: axis(o.actionability) } : {}),
			...(axis(o.confidence) ? { confidence: axis(o.confidence) } : {}),
			...(asString(o.category) ? { category: asString(o.category)!.toLowerCase().trim() } : {}),
			tSec: typeof tSecRaw === "number" ? tSecRaw : null,
			momentIds: asStringArray(o.momentIds),
			metricKeys: asStringArray(o.metricKeys)
		}
	})

	return {
		headline: (asString(raw.headline) ?? asString(raw.title) ?? "").trim(),
		encouragement: (asString(raw.encouragement) ?? "").trim(),
		items,
		goals: asStringArray(raw.goals)
	}
}

/**
 * Validate a model response into `CoachOutput`. Accepts either the parsed object or the raw
 * text (in which case the fence-stripping extractor runs first).
 */
export const parseCoachOutput = (raw: unknown): ParseResult<CoachOutput> => {
	const warnings: ParseWarning[] = []

	const value = typeof raw === "string" ? extractJson(raw) : raw
	if (value === undefined || value === null)
		return typeof raw === "string" && raw.trim() !== "" ?
				{ ok: false, code: "not-json", error: "no JSON object could be recovered from the response", warnings }
			:	{ ok: false, code: "empty", error: "the model returned nothing", warnings }

	if (typeof value !== "object" || Array.isArray(value))
		return {
			ok: false,
			code: "not-object",
			error: `expected a JSON object, got ${Array.isArray(value) ? "an array" : typeof value}`,
			warnings
		}

	const out = CoachOutput(normalize(value as Record<string, unknown>, warnings))
	if (out instanceof type.errors)
		return { ok: false, code: "schema", error: "the response did not match the coaching schema", detail: out.summary, warnings }

	if (out.headline.trim() === "")
		return { ok: false, code: "schema", error: "the response had no headline", warnings }
	if (out.encouragement.trim() === "")
		warnings.push({ code: "encouragement-missing", message: "the model returned no encouragement" })

	return { ok: true, value: out, warnings }
}

/* ========================================================== assembly */

export interface BuildReviewArgs {
	/** The model's output: parsed object, or raw text. */
	raw: unknown
	kind: ReviewKind
	/** `null` for a trend review. */
	gameId: number | null
	model: string
	promptHash: string
	/** Ids the coach was allowed to cite — from `allowlistOf(digest)`. */
	allowed: CitationAllowlist
	/** Used to reject a `tSec` that cannot be seeked to. Omit to skip the range check. */
	durationSec?: number | null
	analysisVersion?: number
	/** Cost/latency from `runCoach`, recorded on the review row. */
	meta?: CoachMeta
	createdMs?: number
	/** Override the deterministic id (tests, or a forced re-run). */
	reviewId?: string
	maxItems?: number
	maxGoals?: number
}

/** Deterministic, so a re-run upserts the same row instead of piling up duplicates. */
export const makeReviewId = (kind: ReviewKind, gameId: number | null, promptHash: string): string =>
	`rv-${kind === "game" ? `g${gameId ?? 0}` : "trend"}-${promptHash.slice(0, 12)}`

export const makeFeedbackItemId = (reviewId: string, index: number): string => `${reviewId}-i${index}`

/**
 * Phrases that make a number a claim about the user's HISTORY rather than about this game.
 *
 * An earlier version of this looked for a cue word and flagged every number within 48
 * characters. It caught the real defect and also flagged "10:00" (the clock), "+7" (this game's
 * value, sitting just before "when your average there is -7.8") and bare small integers — three
 * false positives per review, which is how a check gets ignored. Matching the whole claim and
 * capturing the figure inside it is far more precise: the number has to be in a grammatical
 * position that makes it a baseline.
 */
const BASELINE_CLAIMS: readonly RegExp[] = [
	// "your own 19-game average at 14:00 is 92.1", "your average there is only -283".
	// Only FILLER may sit between the cue and the figure. An open character gap here matched
	// "your baseline in a game that went nearly 40 minutes" and reported "40" as a baseline.
	/\byour (?:own )?(?:\d+-game )?(?:average|mean|median|baseline|norm|usual|typical)\b(?:\s+(?:is|was|of|at|to|sits?|sitting|stands?|there|only|just|around|about|roughly|nearly|a|an|the|TIME))*\s*(?:is|of|at)?\s*(-?\d[\d,]*(?:\.\d+)?)/gi,
	// "your own 2692g average", "your 5.3 average", "your 132 norm".
	// The `-game` guard keeps "your own 20-game average" from yielding the WINDOW SIZE, 20.
	/\byour (?:own )?(-?\d[\d,]*(?:\.\d+)?)(?!\d|-game)\s*[a-z%/]{0,6}\s*(?:average|baseline|norm|median|mean)\b/gi,
	// "your usual 48.2%", "your normal 3150g"
	/\byour (?:usual|normal|typical|own) (-?\d[\d,]*(?:\.\d+)?)(?!\d|-game)/gi,
	// "averages 5.3", "you normally sit at 63"
	/\byou (?:usually|normally|average)\b[^.\d]{0,24}?(-?\d[\d,]*(?:\.\d+)?)/gi
]

/**
 * Clock times are the single biggest source of spurious digits ("10:00" contributes "00"), and
 * they are never baselines. Blank them before scanning rather than trying to exclude them after.
 */
const stripClocks = (text: string): string => text.replace(/\b\d{1,3}:\d{2}\b/g, "TIME")

/**
 * Does `raw` quote `actual`?
 *
 * The coach is allowed to drop precision — the digest prints "2692.1gold" and writing "2692g" in
 * prose is a faithful quote, not the rounding hard rule 4 bans. What the rule is aimed at is
 * changing the VALUE ("2874" becoming "about 2900"), so the test is whether the figure survives
 * re-deriving `actual` at however many decimals the coach chose to print.
 *
 * TRUNCATION counts as dropping precision, and until 2026-09-22 only ROUNDING did — which meant
 * the comment above was true of half the decimals and the check disagreed with its own stated
 * intent on the other half. Replaying the existing fence over the 293 recorded items of
 * `persona-ab-20260919-{flash,sonnet}.json` (see `data/eval/parse-prose-fence-20260922.json`) it
 * fired 5 times, 4 of them on items a majority of the three judges also called unsupported and
 * ONCE on this: the digest printed a 3441.7g baseline and the coach wrote "way under your 3,441g
 * average", which all three judges passed. `Math.round` turns 3441.7 into 3442, so a faithful
 * quote with the decimal chopped off was reported to him as a figure matching no baseline in the
 * digest. Accepting the truncation as well takes the fence to 4 flags, 4 true, ZERO false
 * positives on that corpus, and it cannot launder a wrong baseline: a quote at d decimals is now
 * accepted only for an actual inside [quoted, quoted + 10^-d), so "2874" still refuses 2900 and
 * "8.2" still refuses 9.4 — the two shipped defects hard rule 4 was written for.
 */
const quotes = (raw: string, actual: number): boolean => {
	const quoted = Number(raw.replace(/,/g, ""))
	if (!Number.isFinite(quoted) || !Number.isFinite(actual)) return false
	const dp = (raw.split(".")[1] ?? "").length
	const f = 10 ** dp
	return Math.round(actual * f) / f === quoted || Math.trunc(actual * f) / f === quoted
}

const quotesAny = (raw: string, actuals: readonly number[]): boolean =>
	actuals.some(a => quotes(raw, a))

/** Which metric's baseline a figure belongs to, if any. */
const ownerOf = (raw: string, allowed: CitationAllowlist): string | null => {
	for (const [key, figures] of allowed.baselineByMetric)
		if (quotesAny(raw, [...figures].map(Number))) return key
	return null
}

/**
 * Flag baseline figures that do not belong to the metrics the item cites.
 *
 * The failure this catches is specific and was observed in a shipped review: elite control was
 * reported as "right around your own 45.9% baseline" when 45.9 was kill participation's average.
 * The number was real, so a presence-only check passed; it was simply the wrong metric's, and
 * the coaching conclusion drawn from it was wrong too.
 *
 * Deliberately a WARNING, not a drop. Prose is not a parser, and eating a good coaching item
 * over a regex is worse than surfacing a figure for a human to glance at.
 */
const baselineWarnings = (
	item: CoachItem,
	citedMetrics: readonly string[],
	allowed: CitationAllowlist,
	itemIndex: number
): ParseWarning[] => {
	if (allowed.baselineByMetric.size === 0) return []
	const allowedHere: number[] = []
	for (const key of citedMetrics)
		for (const f of allowed.baselineByMetric.get(key) ?? []) allowedHere.push(Number(f))

	// The fix carries a number as often as the body does now, so both are in scope.
	const text = stripClocks(`${item.title}\n${item.fix ?? ""}\n${item.body ?? ""}`)
	const out: ParseWarning[] = []
	const seen = new Set<string>()

	for (const pattern of BASELINE_CLAIMS)
		for (const m of text.matchAll(pattern)) {
			const raw = m[1]
			if (raw === undefined) continue
			const token = baselineToken(raw)
			if (seen.has(token)) continue
			if (quotesAny(raw, allowedHere)) continue
			seen.add(token)
			// Naming the metric the figure actually belongs to turns "this number is suspect"
			// into "add this citation" — and a missing citation is not cosmetic: the review
			// screen attaches the chart and the media to an item by its citations, so an
			// uncited number renders with no evidence beside it.
			const owner = ownerOf(raw, allowed)
			out.push({
				code: "baseline-mismatch",
				itemIndex,
				message:
					owner ?
						`"${raw}" is ${owner}'s baseline, but this item cites ${
							citedMetrics.join(", ") || "no metrics"
						} — cite ${owner} or use the baseline of a metric it does cite`
					:	`"${raw}" is presented as a baseline but matches no metric's baseline in this digest`
			})
		}
	return out
}

/* ------------------------------------------------- the fix's own trigger */

/**
 * `invented-trigger-clock` — a clock in the FIX that the digest cannot source.
 *
 * ## The defect
 *
 * The citation fence above this one only ever policed IDS, and it is very good at that: over the
 * 293 stored items of the persona A/B it caught one unknown metric key and zero fabricated moment
 * ids. But three judge models from two vendors agree the share of items whose every FIGURE checks
 * out against the digest fell from ~82% to ~65% when Part 2 was re-aimed onto the objective
 * ledger, and the figures they name are in PROSE. AGENTS.md carries "policing prose figures the
 * way ids are policed" as NOT DONE. This is the part of it the numbers support.
 *
 * The class caught here is the one AGENTS.md names by example: *"a fix that invents its own
 * trigger ('position around grubs by 5:30' where 5:30 is in no file)"*. The item's title and body
 * are usually fine — the judges say so in as many words ("grubs and 0% elite control check out,
 * but the 5:30 move-out timestamp is not in the digest") — and then the one sentence he is
 * actually supposed to ACT on hangs off a spawn timer nothing in this app has ever measured. The
 * LCU timeline has no spawn table; `dataGaps` says so; the coach wrote one anyway.
 *
 * ## Why only the `fix`, and why only a clock
 *
 * Both restrictions are measured, not tasteful. Scanning the whole item against the moment clocks
 * flags 33 items at 52% precision, because `body` legitimately narrates objective times out of the
 * `## OBJECTIVES` block, and those are not moments. The `fix` is an instruction for the NEXT game,
 * so a clock in it cannot be a citation of THIS one — with exactly one exception, "keep doing what
 * you did at 17:57", which the ±5s match below absorbs.
 *
 * Generalising from clocks to all prose figures is REFUTED, with its number: "every number in the
 * item that does not appear anywhere in the rendered digest" flags 57 of the 293 items at 26%
 * precision (15 true, 42 false), and tightening it to figures over 100 makes it worse, 16%. It
 * would delete three correct coaching items for every defect it caught. Do not re-draft it; the
 * arithmetic the coach does legitimately (gold summed across deaths, a share restated as a
 * percentage, a count of anything) produces figures the digest never printed.
 *
 * ## What it costs to get zero false positives
 *
 * Whole minutes are EXEMPT and that is the whole difference between a fence and a nuisance. 45 of
 * the 293 fixes carry a whole-minute clock and almost every one is the persona's own constant —
 * "from 10:00 to 15:00, don't cross the river" is quoting the window Part 2 defines, not inventing
 * a timestamp. Dropping the exemption takes the flag count from 6 to 45 at 47% precision (21 true,
 * 24 false).
 *
 * The exemption is not free and the price is stated rather than hidden: it lets through the two
 * fixes in the corpus that invent a whole-minute spawn ("anchor to top river before 8:00", "the
 * first Voidgrub spawn ~6:00"). Recall is bought back only by a source for real spawn times, which
 * no file here has.
 *
 * ±5s, not exact. At tolerance 0 the check fires twice more and both are the coach quoting a real
 * moment one second off — "Herald at 17:57" against moment `…-1078`, "like at 18:56" against
 * `…-1137` — because the digest prints a moment's clock beside an id that carries its second.
 * Punishing a one-second rounding is how a check gets ignored.
 *
 * ## Measured, on recorded data, before choosing the enforcement
 *
 * `data/eval/parse-prose-fence-20260922.json`, which is this rule replayed over all 293 stored
 * items of `persona-ab-20260919-{flash,sonnet}.json` joined to the three judged files beside them
 * (claude-opus-5, claude-sonnet-5, gemini-3.6-flash), no model consulted:
 *
 * | | |
 * |---|---|
 * | items | 293 (152 old arm, 141 new arm), 44 game/arm prompts |
 * | items a MAJORITY of judges called unsupported | 54 |
 * | flagged by this rule | **6** |
 * | of those, majority-unsupported | **6 — precision 100%, Wilson 95% [61%, 100%]** |
 * | of those, UNANIMOUSLY unsupported | 5 |
 * | flagged where a judge quotes the clock back as its reason | 5 of 6 |
 * | flagged in the OLD arm | **0 of 152** |
 * | recall of majority-unsupported | 6 of 54 (11%) |
 *
 * Every flag is in the new arm, so the rule fires exactly on the regression the re-aim introduced
 * and never once on the 152 items that predate it.
 *
 * ## Why this WARNS and does not drop
 *
 * Because n is 6. 6-for-6 is a Wilson lower bound of 61%, so up to two in five future flags could
 * be a correct item, and a false positive here deletes coaching that the judges liked apart from
 * one clause. The rest of the drop is not reachable from this file anyway: of the 48 unsupported
 * items this rule does NOT flag, 13 misattribute an objective to the wrong champion (the digest
 * names ally/enemy, never a player — not decidable from a `CitationAllowlist`) and 12 recite the
 * persona's OWN population statistics (the 70%/38% window split, "138 games"), which are true
 * measurements from `what-wins.ts` that the judge simply could not see. Those 12 are a PROMPT
 * problem, not a parser one, and flagging them here would be the parser calling a true sentence a
 * fabrication.
 *
 * Raise this to a drop when a later corpus puts 20+ flags behind it without a false positive.
 */
const FIX_CLOCK_TOLERANCE_SEC = 5

const CLOCK_IN_TEXT = /\b(\d{1,3}):([0-5]\d)\b/g

/**
 * Seconds carried by the digest's own moment ids.
 *
 * `makeMomentId` is `g<gameId>-<kind>-<tSec>[-<suffix>]`, so the clock is the third segment — but
 * every numeric segment after the leading `g<gameId>` is accepted rather than only the third. A
 * suffix is a small ordinal (0, 1, 2), which as a "clock" is 0:00–0:02 and can never match
 * anything a coach writes, so reading one by mistake WIDENS the allowlist instead of narrowing it.
 * That is the safe direction for a fence whose failure mode is deleting a true sentence, and it
 * means a change to the id format degrades this check to quiet rather than to wrong.
 */
const momentClocksOf = (ids: Iterable<string>): number[] => {
	const out: number[] = []
	for (const id of ids)
		for (const seg of id.split("-").slice(1)) {
			const n = Number(seg)
			if (Number.isInteger(n) && n >= 0) out.push(n)
		}
	return out
}

const fixClockWarnings = (item: CoachItem, allowed: CitationAllowlist, itemIndex: number): ParseWarning[] => {
	const fix = (item.fix ?? "").trim()
	if (fix === "") return []
	// A trend review has no moments at all, and a game digest can legitimately have none. With an
	// empty allowlist every clock is "unsourced", which would fire on every item in the review —
	// the failure mode of a fence that cannot tell "no evidence" from "contradicted".
	if (allowed.momentIds.size === 0) return []

	const clocks = momentClocksOf(allowed.momentIds)
	const out: ParseWarning[] = []
	const seen = new Set<string>()
	for (const m of fix.matchAll(CLOCK_IN_TEXT)) {
		const sec = Number(m[1]) * 60 + Number(m[2])
		// The persona's own checkpoints — 10:00, 15:00, 20:00 — are quoted, not invented.
		if (sec % 60 === 0) continue
		if (clocks.some(c => Math.abs(c - sec) <= FIX_CLOCK_TOLERANCE_SEC)) continue
		if (seen.has(m[0])) continue
		seen.add(m[0])
		out.push({
			code: "invented-trigger-clock",
			itemIndex,
			message: `the fix triggers on ${m[0]}, which is not within ${FIX_CLOCK_TOLERANCE_SEC}s of any moment in this digest — this app has no spawn table, so that clock has no source`
		})
	}
	return out
}

/**
 * The same baseline check, for a free-form chat reply.
 *
 * A chat answer is prose the user reads and believes exactly like a feedback item, and it is the
 * EASIER place to get a baseline wrong — a question invites a confident number. It returns
 * messages rather than `ParseWarning`s because a chat turn has no item index to hang them on.
 */
export const chatBaselineWarnings = (
	reply: string,
	citedMetrics: readonly string[],
	allowed: CitationAllowlist
): string[] =>
	baselineWarnings(
		{ title: "", body: reply, severity: "info", category: "", tSec: null, momentIds: [], metricKeys: [] } as unknown as CoachItem,
		citedMetrics,
		allowed,
		0
	).map(w => w.message)

/**
 * The whole job: parse, enforce citations, assemble a `Review`. On success the returned
 * review is ready for `insertReview()` as-is.
 */
export const buildReview = (args: BuildReviewArgs): ParseResult<Review> => {
	const parsed = parseCoachOutput(args.raw)
	if (!parsed.ok) return parsed

	const warnings = [...parsed.warnings]
	const out = parsed.value
	const maxItems = args.maxItems ?? 10
	const maxGoals = args.maxGoals ?? 3
	const reviewId = args.reviewId ?? makeReviewId(args.kind, args.gameId, args.promptHash)
	const createdMs = args.createdMs ?? Date.now()

	const kept: FeedbackItem[] = []

	out.items.forEach((item, i) => {
		const fix = (item.fix ?? "").trim()
		const body = (item.body ?? "").trim()
		if (item.title.trim() === "" || (fix === "" && body === "")) {
			warnings.push({
				code: "empty-item",
				itemIndex: i,
				message: "item had no title, and no fix or body; dropped"
			})
			return
		}
		// An item with nothing to do is a joke. Hard rule 1 says it gets cut, but cutting it
		// silently loses a real observation, so it is surfaced instead and rendered without the
		// action line.
		if (fix === "")
			warnings.push({
				code: "no-fix",
				itemIndex: i,
				message: `item "${item.title}" names no concrete change to make next game`
			})

		// Budgets are the point of the split, so a breach is worth seeing rather than silently
		// tolerating: the model drifting back to paragraphs is exactly the regression to catch.
		for (const [field, text, limit] of [
			["title", item.title.trim(), TITLE_MAX],
			["fix", fix, FIX_MAX],
			["body", body, BODY_MAX]
		] as const)
			if (text.length > limit)
				warnings.push({
					code: "over-budget",
					itemIndex: i,
					message: `${field} is ${text.length} chars, over its ${limit} budget — it will be hard to scan`
				})

		const momentIds = item.momentIds.filter(id => args.allowed.momentIds.has(id))
		const metricKeys = item.metricKeys.filter(k => args.allowed.metricKeys.has(k))
		const badMoments = item.momentIds.filter(id => !args.allowed.momentIds.has(id))
		const badMetrics = item.metricKeys.filter(k => !args.allowed.metricKeys.has(k))

		for (const id of badMoments)
			warnings.push({
				code: "unknown-moment-id",
				itemIndex: i,
				message: `"${id}" is not a moment in this digest; citation dropped`
			})
		for (const k of badMetrics)
			warnings.push({
				code: "unknown-metric-key",
				itemIndex: i,
				message: `"${k}" is not a metric in this digest; citation dropped`
			})

		// Both prose checks produce the same kind of thing — a figure the reader will believe and
		// the app cannot source — so they ride onto the item together and are surfaced together.
		const proseIssues = [...baselineWarnings(item, metricKeys, args.allowed, i), ...fixClockWarnings(item, args.allowed, i)]
		for (const w of proseIssues) warnings.push(w)

		const citedSomething = item.momentIds.length + item.metricKeys.length > 0
		if (citedSomething && momentIds.length + metricKeys.length === 0) {
			// Every id it offered was invented. Do not show the prose either.
			warnings.push({
				code: "fabricated-citations",
				itemIndex: i,
				message: `item "${item.title}" cited only ids that do not exist; item dropped`
			})
			return
		}
		if (!citedSomething)
			warnings.push({ code: "no-citations", itemIndex: i, message: `item "${item.title}" cites nothing` })

		let tSec = item.tSec
		if (tSec !== null) {
			const max = typeof args.durationSec === "number" ? args.durationSec : null
			if (tSec < 0 || (max !== null && tSec > max + 60)) {
				warnings.push({
					code: "tsec-out-of-range",
					itemIndex: i,
					message: `tSec ${tSec} is outside a ${max ?? "?"}s game; nulled`
				})
				tSec = null
			} else tSec = Math.round(tSec)
		}

		// The number is now required in the title or the fix, where it is actually read.
		if (!/\d/.test(`${item.title}${fix}${body}`))
			warnings.push({
				code: "no-number-cited",
				itemIndex: i,
				message: `item "${item.title}" contains no number — the persona requires citing the figure being roasted`
			})

		kept.push({
			id: makeFeedbackItemId(reviewId, kept.length),
			gameId: args.gameId,
			title: item.title.trim(),
			fix,
			body,
			// Absent axes default to medium rather than to the best case: an item that did not
			// state its own confidence has not earned a high one.
			impact: item.impact ?? "medium",
			actionability: item.actionability ?? "medium",
			confidence: item.confidence ?? "medium",
			// Replaced by `rankItems` below; present so the shape is complete.
			priority: 0,
			severity: item.severity as FeedbackSeverity,
			...(item.category ? { category: item.category } : {}),
			momentIds,
			mediaIds: [],
			metricKeys,
			tSec,
			// Carried onto the item, not just into the parse log: the reader is the one who
			// needs to know which figure could not be checked.
			...(proseIssues.length > 0 ?
				{ warnings: proseIssues.map(w => w.message) }
			:	{})
		})
	})

	/*
	 * Rank, demote and sort before truncation — otherwise `maxItems` would cut whichever items
	 * the model happened to emit last rather than the ones that matter least.
	 */
	const ranked = rankItems(kept)
	kept.length = 0
	kept.push(...ranked)
	for (const [i, item] of ranked.entries())
		if (item.severity === "info" && item.confidence === "low" && item.category !== "praise")
			warnings.push({
				code: "demoted-low-confidence",
				itemIndex: i,
				message: `"${item.title}" was demoted to info: the read is not solid enough to state as a correction`
			})

	if (kept.length > maxItems) {
		warnings.push({
			code: "items-truncated",
			message: `${kept.length} items returned; kept the first ${maxItems}`
		})
		kept.length = maxItems
	}

	if (kept.length === 0)
		return {
			ok: false,
			code: "no-items",
			error: "no feedback item survived validation (every item was empty or cited only invented ids)",
			warnings
		}

	if (!kept.some(it => it.severity === "info" || it.category === "praise"))
		warnings.push({
			code: "no-praise",
			message: "no positive item — hard rule 5 asks for one whenever the data supports it"
		})

	const goals = dedupe(out.goals.map(g => g.trim()).filter(g => g !== ""))
	if (goals.length === 0) warnings.push({ code: "goals-missing", message: "the model returned no goals" })
	if (goals.length > maxGoals) {
		warnings.push({ code: "goals-truncated", message: `${goals.length} goals returned; kept the first ${maxGoals}` })
		goals.length = maxGoals
	}

	const review: Review = {
		id: reviewId,
		gameId: args.gameId,
		kind: args.kind,
		model: args.model,
		createdMs,
		promptHash: args.promptHash,
		analysisVersion: args.analysisVersion ?? ANALYSIS_VERSION,
		headline: out.headline.trim(),
		encouragement: out.encouragement.trim(),
		items: kept,
		goals,
		status: "ok",
		error: null,
		durationMs: args.meta?.durationMs ?? null,
		inputTokens: args.meta?.usage.inputTokens ?? null,
		outputTokens: args.meta?.usage.outputTokens ?? null,
		costUsd: args.meta?.usage.costUsd ?? null
	}

	return { ok: true, value: review, warnings }
}

/**
 * A persistable row for a run that did not produce a review. The UI shows the error next to
 * the game rather than an empty space, and `reviewExistsForPrompt()` ignores it (it filters
 * on `status = 'ok'`), so a fixed prompt retries cleanly.
 */
export const failedReview = (args: {
	kind: ReviewKind
	gameId: number | null
	model: string
	promptHash: string
	error: string
	analysisVersion?: number
	meta?: CoachMeta
	createdMs?: number
	reviewId?: string
}): Review => ({
	id: args.reviewId ?? makeReviewId(args.kind, args.gameId, args.promptHash),
	gameId: args.gameId,
	kind: args.kind,
	model: args.model,
	createdMs: args.createdMs ?? Date.now(),
	promptHash: args.promptHash,
	analysisVersion: args.analysisVersion ?? ANALYSIS_VERSION,
	headline: "Coaching failed for this game",
	encouragement: "Not your fault — this one is on the app. The game is still here, so hit retry.",
	items: [],
	goals: [],
	status: "failed",
	error: args.error.slice(0, 2000),
	durationMs: args.meta?.durationMs ?? null,
	inputTokens: args.meta?.usage.inputTokens ?? null,
	outputTokens: args.meta?.usage.outputTokens ?? null,
	costUsd: args.meta?.usage.costUsd ?? null
})

/** Warnings the user should actually see, as opposed to bookkeeping. */
export const seriousWarnings = (warnings: ParseWarning[]): ParseWarning[] =>
	warnings.filter(
		w =>
			w.code === "fabricated-citations" ||
			w.code === "unknown-moment-id" ||
			w.code === "unknown-metric-key" ||
			// A misattributed baseline is not a dropped citation, it is a wrong number in prose
			// the user will read and believe. It belongs in the same tier.
			w.code === "baseline-mismatch" ||
			// Same tier for the same reason, and for one more: this one sits in the single
			// sentence he is meant to act on. It is also how the defect becomes VISIBLE — the
			// daemon logs `seriousWarnings` per review, which is the only reason anyone knew
			// `baseline-mismatch` was still happening on real games (5645454050, 5645783799).
			w.code === "invented-trigger-clock"
	)

const dedupe = (xs: string[]): string[] => [...new Set(xs)]
