/**
 * One `EventSource` for the whole tab, with reconnect and `Last-Event-ID` replay.
 *
 * Every screen in this app is a live view of a background daemon, so the stream is a
 * singleton: components subscribe and unsubscribe, the connection stays up across
 * navigation, and a daemon restart is a reconnect rather than a blank page.
 *
 * The daemon persists events in `app_event` with monotonic ids. Native `EventSource` sends
 * the `Last-Event-ID` header on its own reconnects, but we also carry the id in the query
 * string because we manage reconnection ourselves — after an error the browser's own retry
 * is not guaranteed to have fired, and a missed `review` event means a stale screen.
 */

import { useEffect, useRef, useState } from "react"
import { API, SSE_EVENT_NAMES } from "../../shared/schema/api.ts"
import type { SseMessage } from "../../shared/schema/api.ts"

export type SseStatus = "connecting" | "open" | "reconnecting" | "closed"

type MessageHandler = (message: SseMessage) => void
type StatusHandler = (status: SseStatus) => void

const messageHandlers = new Set<MessageHandler>()
const statusHandlers = new Set<StatusHandler>()

let source: EventSource | null = null
let status: SseStatus = "closed"
let lastEventId = 0
let attempt = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null

const setStatus = (next: SseStatus): void => {
	if (status === next) return
	status = next
	for (const h of statusHandlers) h(next)
}

const emit = (message: SseMessage): void => {
	for (const h of messageHandlers) h(message)
}

const handleEvent = (name: string, ev: MessageEvent): void => {
	const id = Number(ev.lastEventId)
	if (Number.isFinite(id) && id > lastEventId) lastEventId = id
	let data: unknown = null
	if (typeof ev.data === "string" && ev.data !== "") {
		try {
			data = JSON.parse(ev.data)
		} catch {
			// A malformed frame is the daemon's bug, not a reason to tear down the stream.
			data = { raw: ev.data }
		}
	}
	emit({ id: Number.isFinite(id) ? id : lastEventId, name, data })
}

/** 1s, 2s, 4s, 8s, capped at 15s — fast enough for `--watch` restarts, calm enough to idle. */
const backoffMs = (n: number): number => Math.min(15_000, 1000 * 2 ** Math.min(n, 4))

const connect = (): void => {
	if (source) return
	setStatus(attempt === 0 ? "connecting" : "reconnecting")

	const url = lastEventId > 0 ? `${API.events}?lastEventId=${lastEventId}` : API.events
	const es = new EventSource(url)
	source = es

	es.onopen = () => {
		attempt = 0
		setStatus("open")
	}

	es.onerror = () => {
		// EventSource reports both "server went away" and "still connecting" here.
		if (es.readyState === EventSource.CONNECTING && status === "open") setStatus("reconnecting")
		if (es.readyState !== EventSource.CLOSED) return
		teardown()
		scheduleReconnect()
	}

	// Unnamed frames (`data:` with no `event:`) plus every name the contract declares.
	es.onmessage = ev => handleEvent("message", ev)
	for (const name of SSE_EVENT_NAMES)
		es.addEventListener(name, ev => handleEvent(name, ev as MessageEvent))
}

const teardown = (): void => {
	if (!source) return
	source.onopen = null
	source.onerror = null
	source.onmessage = null
	source.close()
	source = null
}

const scheduleReconnect = (): void => {
	if (retryTimer !== null) return
	if (messageHandlers.size === 0 && statusHandlers.size === 0) {
		setStatus("closed")
		return
	}
	setStatus("reconnecting")
	const wait = backoffMs(attempt++)
	retryTimer = setTimeout(() => {
		retryTimer = null
		connect()
	}, wait)
}

const release = (): void => {
	if (messageHandlers.size > 0 || statusHandlers.size > 0) return
	if (retryTimer !== null) {
		clearTimeout(retryTimer)
		retryTimer = null
	}
	teardown()
	setStatus("closed")
}

/** Force an immediate reconnect — used by the "reconnect now" affordance in the header. */
export const reconnectSse = (): void => {
	if (retryTimer !== null) {
		clearTimeout(retryTimer)
		retryTimer = null
	}
	teardown()
	attempt = 0
	connect()
}

export const sseLastEventId = (): number => lastEventId

/**
 * Subscribe to the daemon's event stream.
 *
 * `onMessage` is kept in a ref, so passing an inline arrow does NOT churn the connection —
 * the stream survives every re-render of every page.
 */
export const useSse = (onMessage?: MessageHandler): SseStatus => {
	const [current, setCurrent] = useState<SseStatus>(status)
	const handlerRef = useRef<MessageHandler | undefined>(onMessage)
	handlerRef.current = onMessage

	useEffect(() => {
		const message: MessageHandler = m => handlerRef.current?.(m)
		const onStatus: StatusHandler = s => setCurrent(s)
		messageHandlers.add(message)
		statusHandlers.add(onStatus)
		setCurrent(status)
		connect()
		return () => {
			messageHandlers.delete(message)
			statusHandlers.delete(onStatus)
			release()
		}
	}, [])

	return current
}
