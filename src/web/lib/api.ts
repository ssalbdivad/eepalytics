/**
 * The typed HTTP client. Every response is validated against the ArkType schema the server
 * promised in `shared/schema/api.ts` before any component sees it.
 *
 * That validation is deliberately loud. If the daemon starts returning a shape the UI does
 * not expect, the page shows "the daemon sent something this build does not understand"
 * rather than rendering `undefined` three components deep and blaming the data.
 */

import { type } from "arktype"
import type { Type } from "arktype"
import {
	API,
	GameDetailResponse,
	GameListResponse,
	HealthResponse,
	JobAccepted,
	JobListResponse,
	OkResponse,
	SettingsResponse,
	SyncResponse,
	TrendsResponse
} from "../../shared/schema/api.ts"
import type { SettingsPatch } from "../../shared/schema/settings.ts"

/** Everything the client can fail with, in one shape the pages know how to render. */
export class ApiError extends Error {
	readonly kind: "network" | "http" | "schema"
	readonly status: number
	readonly detail: string | null

	constructor(
		kind: "network" | "http" | "schema",
		message: string,
		status = 0,
		detail: string | null = null
	) {
		super(message)
		this.name = "ApiError"
		this.kind = kind
		this.status = status
		this.detail = detail
	}
}

/** Message for a caught unknown, without ever printing "[object Object]". */
export const errorMessage = (e: unknown): string =>
	e instanceof ApiError ? e.message
	: e instanceof Error ? e.message
	: typeof e === "string" ? e
	: "unknown error"

export const errorDetail = (e: unknown): string | null =>
	e instanceof ApiError ? e.detail : null

const parseBody = async (res: Response): Promise<unknown> => {
	const text = await res.text()
	if (text.trim() === "") return null
	try {
		return JSON.parse(text)
	} catch {
		throw new ApiError("schema", `${res.url} returned non-JSON`, res.status, text.slice(0, 400))
	}
}

const httpError = (res: Response, body: unknown): ApiError => {
	const rec = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
	const msg = typeof rec.error === "string" ? rec.error : `HTTP ${res.status} ${res.statusText}`
	const detail = typeof rec.detail === "string" ? rec.detail : null
	return new ApiError("http", msg, res.status, detail)
}

interface RequestOptions {
	signal?: AbortSignal
	method?: "GET" | "POST" | "PUT"
	body?: unknown
	query?: Record<string, string | number | undefined>
}

const withQuery = (path: string, query?: RequestOptions["query"]): string => {
	if (!query) return path
	const params = new URLSearchParams()
	for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v))
	const qs = params.toString()
	return qs === "" ? path : `${path}?${qs}`
}

const request = async <t>(
	path: string,
	validator: Type<t>,
	options: RequestOptions = {}
): Promise<t> => {
	const url = withQuery(path, options.query)
	let res: Response
	try {
		res = await fetch(url, {
			method: options.method ?? "GET",
			signal: options.signal,
			headers:
				options.body === undefined ?
					{ accept: "application/json" }
				:	{ accept: "application/json", "content-type": "application/json" },
			body: options.body === undefined ? undefined : JSON.stringify(options.body)
		})
	} catch (e) {
		if (options.signal?.aborted) throw e
		throw new ApiError(
			"network",
			"can't reach the coachskaffur daemon",
			0,
			`${options.method ?? "GET"} ${url} — ${errorMessage(e)}`
		)
	}

	const body = await parseBody(res)
	if (!res.ok) throw httpError(res, body)

	const out = validator(body)
	if (out instanceof type.errors)
		throw new ApiError(
			"schema",
			`the daemon's response to ${path} did not match this build's schema`,
			res.status,
			out.summary
		)
	return out as t
}

/* ================================================================ routes */

export const api = {
	health: (signal?: AbortSignal) => request(API.health, HealthResponse, { signal }),

	games: (limit?: number, signal?: AbortSignal) =>
		request(API.games, GameListResponse, { signal, query: { limit } }),

	game: (gameId: number, signal?: AbortSignal) =>
		request(API.game(gameId), GameDetailResponse, { signal }),

	trends: (games?: number, signal?: AbortSignal) =>
		request(API.trends, TrendsResponse, { signal, query: { games } }),

	jobs: (signal?: AbortSignal) => request(API.jobs, JobListResponse, { signal }),

	settings: (signal?: AbortSignal) => request(API.settings, SettingsResponse, { signal }),

	/* --- mutations. Every one is a deliberate user action; none run on render. --- */

	requestReview: (gameId: number) =>
		request(API.review(gameId), JobAccepted, { method: "POST" }),

	requestCapture: (gameId: number) =>
		request(API.capture(gameId), JobAccepted, { method: "POST" }),

	cancelJob: (id: number) => request(API.cancelJob(id), OkResponse, { method: "POST" }),

	retryJob: (id: number) => request(API.retryJob(id), OkResponse, { method: "POST" }),

	saveSettings: (patch: SettingsPatch) =>
		request(API.settings, SettingsResponse, { method: "PUT", body: patch }),

	sync: () => request(API.sync, SyncResponse, { method: "POST" }),

	/** Media is binary and Range-served; it is referenced by URL, never fetched as JSON. */
	mediaUrl: (id: string) => API.media(id)
}
