/**
 * Response helpers. Two jobs, both about the contract in `src/shared/schema/api.ts`.
 *
 * 1. **Every response body is validated on the way out.** `src/web` is coded against the same
 *    validators and parses what it receives; if the two ever disagree, the failure should
 *    surface here — at the boundary, naming the route — rather than three components deep in
 *    a React tree. In dev a mismatch throws (loud); in production it logs and still ships the
 *    payload, because a shape drift is not a reason to break the user's app.
 *
 * 2. **Every non-2xx body is an `ApiError`.** One shape for every failure, so the client has
 *    exactly one thing to render.
 */

import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { type } from "arktype"
import type { Type } from "arktype"
import { ApiError } from "../shared/schema/api.ts"

/** Loud in dev, forgiving in prod. */
export const STRICT_CONTRACT = process.env.NODE_ENV !== "production"

/** Thrown when an outgoing body violates its own contract. Only in dev; caught by `onError`. */
export class ContractError extends Error {
	readonly route: string
	readonly issues: string
	constructor(route: string, issues: string) {
		super(`response contract violated at ${route}: ${issues}`)
		this.name = "ContractError"
		this.route = route
		this.issues = issues
	}
}

/**
 * Validate `data` against its contract and send it as JSON.
 *
 * ArkType passes undeclared keys through untouched (see the design rule in
 * `shared/schema/lcu.ts`), so adding a field to a response is additive and safe; REMOVING one
 * the contract declares is what this catches.
 */
export const send = <t>(
	c: Context,
	validator: Type<t>,
	data: t,
	route: string,
	status: ContentfulStatusCode = 200
): Response => {
	const out = validator(data)
	if (out instanceof type.errors) {
		if (STRICT_CONTRACT) throw new ContractError(route, out.summary)
		console.warn(`[server] ${route} response failed its contract: ${out.summary}`)
		return c.json(data as never, status)
	}
	return c.json(out as never, status)
}

/** Every non-2xx body. `code` is the stable machine-readable half. */
export const fail = (
	c: Context,
	status: ContentfulStatusCode,
	error: string,
	code?: string,
	detail?: string
): Response => {
	const body: ApiError = { error }
	if (code !== undefined) body.code = code
	if (detail !== undefined) body.detail = detail
	return c.json(body as never, status)
}

export const notFound = (c: Context, what: string): Response =>
	fail(c, 404, `${what} not found`, "not-found")

/** Parse a `:gameId`-style path param. Returns null rather than NaN, which SQLite would eat. */
export const intParam = (raw: string | undefined): number | null => {
	if (raw === undefined || raw.trim() === "") return null
	const n = Number(raw)
	return Number.isSafeInteger(n) ? n : null
}

/** Parse a bounded `?limit=` query. */
export const intQuery = (
	raw: string | undefined,
	fallback: number,
	lo: number,
	hi: number
): number => {
	if (raw === undefined || raw.trim() === "") return fallback
	const n = Number(raw)
	if (!Number.isFinite(n)) return fallback
	const i = Math.trunc(n)
	return i < lo ? lo : i > hi ? hi : i
}

/** Read a JSON body without letting a malformed one become a 500. */
export const readJson = async (c: Context): Promise<unknown | undefined> => {
	try {
		const text = await c.req.text()
		if (text.trim() === "") return {}
		return JSON.parse(text) as unknown
	} catch {
		return undefined
	}
}
