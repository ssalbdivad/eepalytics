/**
 * The small amount of app plumbing that is not networking: a hash router, an async-resource
 * hook, and a ticking clock for the countdowns.
 *
 * A hash router keeps the dependency count at zero and means the built `dist/` opens
 * correctly from `file://` or from any path the daemon decides to serve it under.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { errorDetail, errorMessage } from "./api.ts"

/* =============================================================== router */

export type Route =
	| { name: "games" }
	| { name: "game"; gameId: number }
	| { name: "trends" }
	| { name: "queue" }
	| { name: "settings" }
	| { name: "notfound"; path: string }

export const parseRoute = (hash: string): Route => {
	const path = hash.replace(/^#/, "").replace(/^\/+/, "")
	const [head = "", tail = ""] = path.split("/")
	if (head === "" || head === "games") return { name: "games" }
	if (head === "trends") return { name: "trends" }
	if (head === "queue") return { name: "queue" }
	if (head === "settings") return { name: "settings" }
	if (head === "game") {
		const gameId = Number(tail)
		if (Number.isFinite(gameId) && gameId > 0) return { name: "game", gameId }
	}
	return { name: "notfound", path }
}

export const href = {
	games: "#/games",
	trends: "#/trends",
	queue: "#/queue",
	settings: "#/settings",
	game: (gameId: number) => `#/game/${gameId}`
}

export const navigate = (to: string): void => {
	window.location.hash = to.startsWith("#") ? to.slice(1) : to
}

export const useRoute = (): Route => {
	const [hash, setHash] = useState(() => window.location.hash)
	useEffect(() => {
		const onHash = () => setHash(window.location.hash)
		window.addEventListener("hashchange", onHash)
		return () => window.removeEventListener("hashchange", onHash)
	}, [])
	return useMemo(() => parseRoute(hash), [hash])
}

/** Scroll to the top whenever the route identity changes, like a real page load would. */
export const useScrollReset = (key: string): void => {
	useEffect(() => {
		window.scrollTo({ top: 0 })
	}, [key])
}

/* ============================================================ resources */

export interface Resource<T> {
	data: T | null
	error: string | null
	errorDetail: string | null
	/** True only on the FIRST load. A refetch keeps the old data on screen. */
	loading: boolean
	refreshing: boolean
	reload: () => void
}

/**
 * Load something cancellable, keeping the last good value visible while it refetches.
 *
 * The daemon restarts often during development and briefly while `systemd` cycles it; a
 * screen that blanks on every transient failure is unusable, so a failed refetch keeps the
 * stale data AND surfaces the error.
 */
export const useResource = <T,>(
	load: (signal: AbortSignal) => Promise<T>,
	deps: readonly unknown[]
): Resource<T> => {
	const [data, setData] = useState<T | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [detail, setDetail] = useState<string | null>(null)
	const [loading, setLoading] = useState(true)
	const [refreshing, setRefreshing] = useState(false)
	const [nonce, setNonce] = useState(0)
	const loadRef = useRef(load)
	loadRef.current = load
	const hasData = useRef(false)

	useEffect(() => {
		const ac = new AbortController()
		let live = true
		if (hasData.current) setRefreshing(true)
		else setLoading(true)

		loadRef.current(ac.signal).then(
			value => {
				if (!live) return
				hasData.current = true
				setData(value)
				setError(null)
				setDetail(null)
				setLoading(false)
				setRefreshing(false)
			},
			e => {
				if (!live || ac.signal.aborted) return
				setError(errorMessage(e))
				setDetail(errorDetail(e))
				setLoading(false)
				setRefreshing(false)
			}
		)

		return () => {
			live = false
			ac.abort()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [...deps, nonce])

	const reload = useCallback(() => setNonce(n => n + 1), [])
	return { data, error, errorDetail: detail, loading, refreshing, reload }
}

/* ================================================================ misc */

/** A re-render every `ms`, for countdowns and "3m ago". Pass 0 to freeze. */
export const useNow = (ms: number): number => {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (ms <= 0) return
		const t = setInterval(() => setNow(Date.now()), ms)
		return () => clearInterval(t)
	}, [ms])
	return now
}

/** Fire-and-report an action button: tracks pending state and the error it produced. */
export const useAction = <A extends unknown[]>(
	fn: (...args: A) => Promise<unknown>
): {
	run: (...args: A) => void
	pending: boolean
	error: string | null
	done: boolean
	clear: () => void
} => {
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [done, setDone] = useState(false)
	const fnRef = useRef(fn)
	fnRef.current = fn

	const run = useCallback((...args: A) => {
		setPending(true)
		setError(null)
		setDone(false)
		fnRef.current(...args).then(
			() => {
				setPending(false)
				setDone(true)
			},
			e => {
				setPending(false)
				setError(errorMessage(e))
			}
		)
	}, [])

	const clear = useCallback(() => {
		setError(null)
		setDone(false)
	}, [])

	return { run, pending, error, done, clear }
}

/** Persist a small UI preference (a filter, a toggle) across reloads. Never app data. */
export const useLocalState = <T,>(key: string, initial: T): [T, (next: T) => void] => {
	const [value, setValue] = useState<T>(() => {
		try {
			const raw = window.localStorage.getItem(`csk.${key}`)
			return raw === null ? initial : (JSON.parse(raw) as T)
		} catch {
			return initial
		}
	})
	const set = useCallback(
		(next: T) => {
			setValue(next)
			try {
				window.localStorage.setItem(`csk.${key}`, JSON.stringify(next))
			} catch {
				/* private mode — the preference just doesn't persist */
			}
		},
		[key]
	)
	return [value, set]
}
