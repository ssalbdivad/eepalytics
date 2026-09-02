/**
 * The daemon's in-process notification bus.
 *
 * Every interesting state change goes through `publish()`, which does two things:
 *   1. appends a durable row to `app_event` (so a browser tab that was closed for an hour can
 *      replay from its `Last-Event-ID`), and
 *   2. emits in-process, so an already-connected SSE stream sees it with no polling.
 *
 * The HTTP server lives in the SAME process (see `main.ts`), so `src/server/events.ts` can
 * simply `bus.on("event", …)` — no IPC, no second SQLite writer, no port coordination.
 *
 * NODE ONLY.
 */

import { EventEmitter } from "node:events"
import type { AppEvent } from "../shared/schema/domain.ts"
import { appendEvent } from "../db/queries.ts"
import { errText, log } from "./log.ts"

/**
 * Emits:
 *   "event" (AppEvent)  — every published app event, in order.
 *   "wake"  ()          — "there may be new work"; workers use it to skip their poll sleep.
 */
export const bus = new EventEmitter({ captureRejections: true })
// Long-lived daemon: an SSE hub, the worker pool and the supervisor all subscribe.
bus.setMaxListeners(64)

bus.on("error", err => log.warn("bus listener threw", { err: errText(err) }))

/**
 * Record + broadcast. Never throws: a failure to log an event must not fail the job that
 * produced it.
 */
export const publish = (
	kind: string,
	payload: Record<string, unknown> = {},
	gameId: number | null = null
): AppEvent | null => {
	try {
		const id = appendEvent(kind, payload, gameId)
		const event: AppEvent = { id, atMs: Date.now(), kind, gameId, payload }
		bus.emit("event", event)
		return event
	} catch (err) {
		log.warn("failed to publish event", { kind, err: errText(err) })
		return null
	}
}

/** Nudge the worker pool. Cheap and idempotent — worst case a worker polls one tick early. */
export const wake = (): void => {
	bus.emit("wake")
}

/**
 * Resolve on the next `wake`, or after `ms`, whichever comes first. This is how a worker
 * idles: no busy loop, and a newly enqueued job starts in milliseconds instead of on the next
 * poll boundary.
 */
export const sleepUntilWake = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise(resolve => {
		if (signal?.aborted) return resolve()
		let done = false
		const finish = () => {
			if (done) return
			done = true
			clearTimeout(timer)
			bus.off("wake", finish)
			signal?.removeEventListener("abort", finish)
			resolve()
		}
		const timer = setTimeout(finish, ms)
		// Do not hold the event loop open just to finish a sleep.
		timer.unref?.()
		bus.once("wake", finish)
		signal?.addEventListener("abort", finish, { once: true })
	})

/** A plain sleep that still respects shutdown. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise(resolve => {
		if (signal?.aborted) return resolve()
		const finish = () => {
			clearTimeout(timer)
			signal?.removeEventListener("abort", finish)
			resolve()
		}
		const timer = setTimeout(finish, ms)
		timer.unref?.()
		signal?.addEventListener("abort", finish, { once: true })
	})
