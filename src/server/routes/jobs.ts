/**
 * The queue screen's API.
 *
 *   GET  /api/jobs?states=&kinds=&gameId=&limit=   -> JobListResponse
 *   POST /api/jobs/:id/cancel                      -> OkResponse
 *   POST /api/jobs/:id/retry                       -> OkResponse
 *   POST /api/sync                                 -> SyncResponse
 *
 * The queue screen exists to make deferral legible. A job sitting in `deferred` carries its
 * gate reason in `lastError` ("Waiting: you're in ChampSelect. Needs None/Lobby for 2 min."),
 * and rendering that verbatim answers "why is nothing happening" without a log dive — so this
 * route does no filtering or prettifying of its own.
 *
 * Cancelling lands a job in `failed` with `lastError = "cancelled by user"` rather than in some
 * separate `cancelled` state, so there is exactly one place to look for why a job did not run.
 */

import { Hono } from "hono"
import { type } from "arktype"
import {
	cancelJob,
	getJob,
	kvSet,
	listJobs,
	retryJob
} from "../../db/queries.ts"
import { JobListResponse, OkResponse, SyncResponse } from "../../shared/schema/api.ts"
import { JobKind, JobState } from "../../shared/schema/domain.ts"
import type { JobKind as JobKindT, JobState as JobStateT } from "../../shared/schema/domain.ts"
import type { ServerDeps } from "../deps.ts"
import { publish } from "../events.ts"
import { fail, intParam, intQuery, notFound, send } from "../respond.ts"

/** Split a `?states=queued,deferred` CSV and drop anything that is not a real member. */
const csvOf = <T extends string>(
	raw: string | undefined,
	isMember: (s: string) => s is T
): T[] => {
	if (raw === undefined || raw.trim() === "") return []
	return raw
		.split(",")
		.map(s => s.trim())
		.filter((s): s is T => s !== "" && isMember(s))
}

const isState = (s: string): s is JobStateT => !(JobState(s) instanceof type.errors)
const isKind = (s: string): s is JobKindT => !(JobKind(s) instanceof type.errors)

export const createJobRoutes = (deps: ServerDeps): Hono => {
	const app = new Hono()

	app.get("/jobs", c => {
		const states = csvOf<JobStateT>(c.req.query("states"), isState)
		const kinds = csvOf<JobKindT>(c.req.query("kinds"), isKind)
		const gameIdRaw = c.req.query("gameId")
		const gameId = gameIdRaw === undefined ? undefined : (intParam(gameIdRaw) ?? undefined)
		const limit = intQuery(c.req.query("limit"), 100, 1, 1000)

		const jobs = listJobs({
			...(states.length > 0 ? { states } : {}),
			...(kinds.length > 0 ? { kinds } : {}),
			...(gameId === undefined ? {} : { gameId }),
			limit
		})

		return send(c, JobListResponse, { jobs }, "GET /api/jobs")
	})

	app.post("/jobs/:id/cancel", c => {
		const id = intParam(c.req.param("id"))
		if (id === null) return fail(c, 400, "job id must be an integer", "bad-job-id")

		const job = getJob(id)
		if (!job) return notFound(c, `job ${id}`)

		const changed = cancelJob(id)
		if (changed)
			publish("job", { id, kind: job.kind, gameId: job.gameId, state: "failed", reason: "cancelled by user" }, job.gameId)

		return send(
			c,
			OkResponse,
			{
				ok: changed,
				note:
					changed ?
						"cancelled"
					:	`job ${id} was already ${job.state} — nothing to cancel`
			},
			`POST /api/jobs/${id}/cancel`
		)
	})

	app.post("/jobs/:id/retry", c => {
		const id = intParam(c.req.param("id"))
		if (id === null) return fail(c, 400, "job id must be an integer", "bad-job-id")

		const job = getJob(id)
		if (!job) return notFound(c, `job ${id}`)

		const changed = retryJob(id)
		if (changed)
			publish("job", { id, kind: job.kind, gameId: job.gameId, state: "queued", reason: "retried by user" }, job.gameId)

		return send(
			c,
			OkResponse,
			{
				ok: changed,
				note:
					changed ? "requeued"
					: job.state === "expired" ?
						"that job expired — a replay is only downloadable for about 30 minutes after the game"
					:	`job ${id} is ${job.state}; only terminal jobs can be retried`
			},
			`POST /api/jobs/${id}/retry`
		)
	})

	/**
	 * Reconcile match history now. The daemon owns the LCU, so without an injected `sync` there
	 * is genuinely nothing to run — say so with a 503 rather than returning a cheerful `ok`.
	 */
	app.post("/sync", async c => {
		if (!deps.sync)
			return fail(
				c,
				503,
				"sync is unavailable — the daemon is not running",
				"sync-unavailable",
				"Start the daemon (pnpm daemon) and the League client, then try again."
			)

		try {
			const result = await deps.sync()
			if (result.ok) {
				try {
					kvSet("lastSyncMs", Date.now())
				} catch {
					/* non-fatal */
				}
			}
			return send(
				c,
				SyncResponse,
				{
					ok: result.ok,
					...(result.queued === undefined ? {} : { queued: result.queued }),
					...(result.note === undefined ? {} : { note: result.note })
				},
				"POST /api/sync"
			)
		} catch (err) {
			return fail(
				c,
				502,
				"sync failed",
				"sync-failed",
				(err as Error).message
			)
		}
	})

	return app
}
