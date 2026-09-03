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
export const CoachItem = type({
	title: "string",
	body: "string",
	severity: "'info'|'minor'|'major'",
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

/** Categories the UI knows how to badge. Anything else is kept verbatim but lower-cased. */
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
		return {
			title: (asString(o.title) ?? "").trim(),
			body: (asString(o.body) ?? asString(o.text) ?? "").trim(),
			severity: SEVERITIES.has(severity) ? severity : "minor",
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
 * rounding `actual` to however many decimals the coach chose to print.
 */
const quotes = (raw: string, actual: number): boolean => {
	const quoted = Number(raw.replace(/,/g, ""))
	if (!Number.isFinite(quoted) || !Number.isFinite(actual)) return false
	const dp = (raw.split(".")[1] ?? "").length
	const f = 10 ** dp
	return Math.round(actual * f) / f === quoted
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

	const text = stripClocks(item.body)
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
		if (item.title.trim() === "" || item.body.trim() === "") {
			warnings.push({ code: "empty-item", itemIndex: i, message: "item had no title or no body; dropped" })
			return
		}

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

		for (const w of baselineWarnings(item, metricKeys, args.allowed, i)) warnings.push(w)

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

		if (!/\d/.test(item.body))
			warnings.push({
				code: "no-number-cited",
				itemIndex: i,
				message: `item "${item.title}" contains no number — the persona requires citing the figure being roasted`
			})

		kept.push({
			id: makeFeedbackItemId(reviewId, kept.length),
			gameId: args.gameId,
			title: item.title.trim(),
			body: item.body.trim(),
			severity: item.severity as FeedbackSeverity,
			...(item.category ? { category: item.category } : {}),
			momentIds,
			mediaIds: [],
			metricKeys,
			tSec
		})
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
			w.code === "baseline-mismatch"
	)

const dedupe = (xs: string[]): string[] => [...new Set(xs)]
