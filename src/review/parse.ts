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
	warnings.filter(w => w.code === "fabricated-citations" || w.code === "unknown-moment-id" || w.code === "unknown-metric-key")

const dedupe = (xs: string[]): string[] => [...new Set(xs)]
