/**
 * The SSE hub: `GET /api/events`.
 *
 * The daemon's job handlers call `publish(...)`; every open browser tab sees it within a tick.
 * Three properties this module is responsible for, in order of how annoying their absence is:
 *
 * 1. **Nothing is missed across a reconnect.** Every published event is appended to
 *    `app_event` first and broadcast with that row's id as the SSE `id:` field. A reconnecting
 *    client sends `Last-Event-ID` and gets replayed exactly what it missed. Because
 *    `node:sqlite` is synchronous, the replay-then-subscribe pair happens inside one
 *    uninterrupted synchronous block — there is no window in which an event can be appended
 *    after the replay query and before the subscription, so no event can slip between them.
 *
 * 2. **The connection survives idleness.** A heartbeat comment every 15 s keeps proxies and
 *    the Vite dev server from reaping a quiet stream.
 *
 * 3. **A dead client cannot wedge the daemon.** Writes to a closed controller are swallowed and
 *    the subscriber is dropped; `publish` never throws into a job handler.
 */

import { Hono } from "hono"
import { appendEvent, eventsSince, latestEventId, queueDepth } from "../db/queries.ts"
import type { SseEventName } from "../shared/schema/api.ts"

/** How often to write a keep-alive comment. */
export const HEARTBEAT_MS = 15_000
/** Cap on how far back a reconnecting client may be replayed in one go. */
export const REPLAY_LIMIT = 1000
/** Retry hint handed to EventSource, in ms. */
const RETRY_MS = 3000

/** One message as it goes on the wire. `id` is the `app_event` rowid; -1 = not persisted. */
export interface SseOut {
	id: number
	name: SseEventName | string
	data: unknown
}

type Subscriber = (msg: SseOut) => void

const subscribers = new Set<Subscriber>()

/** How many browser tabs are currently listening. Exposed for the health route and tests. */
export const subscriberCount = (): number => subscribers.size

const fanout = (msg: SseOut): void => {
	for (const sub of subscribers) {
		try {
			sub(msg)
		} catch {
			/* the stream is gone; its own cancel handler removes it */
			subscribers.delete(sub)
		}
	}
}

/**
 * Persist an event and push it to every listener. Returns the `app_event` id (the value a
 * client will send back as `Last-Event-ID`), or -1 if the row could not be written.
 *
 * This is the function the daemon's job handlers call. It never throws: a broken UI connection
 * must not fail a review that already succeeded.
 */
export const publish = (
	name: SseEventName | string,
	data: unknown,
	gameId: number | null = null
): number => {
	let id = -1
	try {
		id = appendEvent(name, data, gameId)
	} catch (err) {
		console.warn(`[events] could not persist ${name}: ${(err as Error).message}`)
	}
	fanout({ id, name, data })
	return id
}

/**
 * Push without persisting — for things that are only meaningful right now (a heartbeat-ish
 * progress tick during a capture). These carry no `id:`, so they never move a client's
 * `Last-Event-ID` and cannot create a replay hole.
 */
export const broadcast = (name: SseEventName | string, data: unknown): void => {
	fanout({ id: -1, name, data })
}

/* ------------------------------------------------------------ wire format */

const encoder = new TextEncoder()

const frame = (msg: SseOut): string => {
	const body = JSON.stringify(msg.data ?? null)
	// A payload can never contain a raw newline after JSON.stringify, so one data: line is safe.
	return `${msg.id >= 0 ? `id: ${msg.id}\n` : ""}event: ${msg.name}\ndata: ${body}\n\n`
}

/** `Last-Event-ID` per the SSE spec, with a `?lastEventId=` escape hatch for manual testing. */
const requestedLastId = (header: string | undefined, query: string | undefined): number | null => {
	const raw = header ?? query
	if (raw === undefined || raw.trim() === "") return null
	const n = Number(raw)
	return Number.isSafeInteger(n) && n >= 0 ? n : null
}

/* --------------------------------------------------------------- route */

export const createEventsRoute = (): Hono => {
	const app = new Hono()

	app.get("/events", c => {
		const lastId = requestedLastId(
			c.req.header("Last-Event-ID"),
			c.req.query("lastEventId")
		)

		let closed = false
		let heartbeat: ReturnType<typeof setInterval> | null = null
		let subscriber: Subscriber | null = null

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const write = (text: string): void => {
					if (closed) return
					try {
						controller.enqueue(encoder.encode(text))
					} catch {
						closed = true
					}
				}

				write(`retry: ${RETRY_MS}\n\n`)

				// Replay + subscribe, synchronously and adjacently: node:sqlite is synchronous
				// and Node is single-threaded, so no publish() can interleave between them.
				if (lastId !== null) {
					try {
						const missed = eventsSince(lastId, REPLAY_LIMIT)
						for (const e of missed)
							write(frame({ id: e.id, name: e.kind, data: e.payload }))
						const head = latestEventId()
						if (missed.length === REPLAY_LIMIT && head > lastId + REPLAY_LIMIT)
							write(
								`: replay truncated at ${REPLAY_LIMIT} events; ${head} is current\n\n`
							)
					} catch (err) {
						write(`: replay unavailable (${(err as Error).message})\n\n`)
					}
				}

				subscriber = (msg: SseOut) => {
					write(frame(msg))
				}
				subscribers.add(subscriber)

				// An unpersisted hello, so a fresh tab renders a real banner before anything
				// happens. No id:, so it cannot disturb Last-Event-ID bookkeeping.
				let depth = 0
				try {
					depth = queueDepth()
				} catch {
					/* empty/locked database — the banner just shows zero */
				}
				write(frame({ id: -1, name: "daemon", data: { hello: true, queueDepth: depth } }))

				heartbeat = setInterval(() => {
					write(`: ping ${Date.now()}\n\n`)
				}, HEARTBEAT_MS)
				// Never hold the event loop open on account of a browser tab.
				heartbeat.unref?.()
			},

			cancel() {
				closed = true
				if (subscriber) subscribers.delete(subscriber)
				if (heartbeat) clearInterval(heartbeat)
			}
		})

		// The client going away aborts the request; tear down even if `cancel` does not fire.
		c.req.raw.signal?.addEventListener("abort", () => {
			closed = true
			if (subscriber) subscribers.delete(subscriber)
			if (heartbeat) clearInterval(heartbeat)
		})

		return new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				// Nginx and friends buffer text/event-stream by default, which looks like a hang.
				"X-Accel-Buffering": "no"
			}
		})
	})

	return app
}
