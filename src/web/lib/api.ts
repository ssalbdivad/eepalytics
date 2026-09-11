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
	ChatHistoryResponse,
	FormResponse,
	LiveResponse,
	MatchupResponse,
	WatchListResponse,
	ReplayListResponse,
	ChatTurnResponse,
	GameListResponse,
	HealthResponse,
	JobAccepted,
	JobListResponse,
	OkResponse,
	SettingsResponse,
	SyncResponse,
	TrendsResponse
} from "../../shared/schema/api.ts"
import { WatchNote } from "../../shared/schema/domain.ts"
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
	method?: "GET" | "POST" | "PUT" | "DELETE"
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
			"can't reach the eepalytics daemon",
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

	watchNotes: (gameId: number, signal?: AbortSignal) =>
		request(API.watch(gameId), WatchListResponse, { signal }),

	/**
	 * Look at the journal frames for one moment. Requires REAL frames to already exist —
	 * this never goes and gets them.
	 */
	watchMoment: (gameId: number, momentId: string, signal?: AbortSignal) =>
		request(API.watch(gameId), type({ note: WatchNote }), {
			method: "POST",
			body: { momentId },
			signal
		}),

	/**
	 * The live coach's poll. Answers 200 in every state including "not in a game" — a coach that
	 * errors is a coach that gets closed.
	 */
	live: (signal?: AbortSignal) => request(API.live, LiveResponse, { signal }),

	/**
	 * The champ-select / loading-screen brief: who he is playing, against whom, with what.
	 *
	 * Answers 200 in every state, same as `live`. Poll it during champ select — `available` goes
	 * true the moment the client publishes selections, which is partway through, not at the start.
	 */
	matchup: (signal?: AbortSignal) => request(API.matchup, MatchupResponse, { signal }),

	/**
	 * Close the post-game debrief for good. Stored by the daemon, not by this page: he closes it
	 * and alt-tabs into a fresh window, and a dismissal that only lived here would come back.
	 */
	dismissDebrief: (endedAtMs: number) =>
		request(API.liveDismiss, OkResponse, { method: "POST", body: { endedAtMs } }),
	/** Grades and focus areas. Derived from stored data — no model call, so it is instant. */
	form: (games?: number, signal?: AbortSignal) =>
		request(API.form, FormResponse, { signal, query: { games } }),

	replays: (signal?: AbortSignal) => request(API.replays, ReplayListResponse, { signal }),

	chatHistory: (gameId: number, signal?: AbortSignal) =>
		request(API.chat(gameId), ChatHistoryResponse, { signal }),

	settings: (signal?: AbortSignal) => request(API.settings, SettingsResponse, { signal }),

	/* --- mutations. Every one is a deliberate user action; none run on render. --- */

	requestReview: (gameId: number) =>
		request(API.review(gameId), JobAccepted, { method: "POST" }),

	cancelJob: (id: number) => request(API.cancelJob(id), OkResponse, { method: "POST" }),

	retryJob: (id: number) => request(API.retryJob(id), OkResponse, { method: "POST" }),

	saveSettings: (patch: SettingsPatch) =>
		request(API.settings, SettingsResponse, { method: "PUT", body: patch }),

	sync: () => request(API.sync, SyncResponse, { method: "POST" }),

	/**
	 * Ask the coach a question. Unlike every other mutation here this one WAITS for Claude —
	 * see `src/server/routes/chat.ts` for why chat is not a queued job. There is no client-side
	 * timeout: an answer legitimately takes 30-90 s, and the caller passes an AbortSignal so the
	 * user can cancel rather than having the request pulled out from under a live call.
	 */
	askCoach: (gameId: number, message: string, model?: string, signal?: AbortSignal) =>
		request(API.chat(gameId), ChatTurnResponse, {
			method: "POST",
			body: model === undefined || model === "" ? { message } : { message, model },
			signal
		}),

	/** Adopt a `.rofl` from the replay folder and queue analysis + review for it. */
	ingestReplay: (fileName: string) =>
		request(API.replayIngest, type({ gameId: "number", "championName?": "string", "adopted?": "boolean", "hasTimeline?": "boolean" }), {
			method: "POST",
			body: { fileName }
		}),

	clearChat: (gameId: number) =>
		request(API.chat(gameId), type({ cleared: "number" }), { method: "DELETE" }),

	/** Media is binary and Range-served; it is referenced by URL, never fetched as JSON. */
	mediaUrl: (id: string) => API.media(id)
}
