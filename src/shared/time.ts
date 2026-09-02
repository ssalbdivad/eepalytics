/**
 * Time formatting shared by the daemon, the coaching prompt and the UI.
 * Pure — no Node imports, safe in the browser.
 */

/** Timeline event timestamps are ms since game start. Game clock is seconds. */
export const msToGameSec = (ms: number): number => ms / 1000

export const gameSecToMs = (sec: number): number => sec * 1000

/**
 * Game clock: `"12:34"`, or `"1:02:03"` past an hour. Negative values keep their sign
 * (`"-0:05"`), which matters for "5s before the objective spawned".
 */
export const fmtClock = (sec: number): string => {
	if (!Number.isFinite(sec)) return "--:--"
	const sign = sec < 0 ? "-" : ""
	const total = Math.floor(Math.abs(sec))
	const h = Math.floor(total / 3600)
	const m = Math.floor((total % 3600) / 60)
	const s = total % 60
	const ss = String(s).padStart(2, "0")
	return h > 0 ? `${sign}${h}:${String(m).padStart(2, "0")}:${ss}` : `${sign}${m}:${ss}`
}

/** Same, but takes milliseconds — the unit every LCU timeline event uses. */
export const fmtClockMs = (ms: number): string => fmtClock(msToGameSec(ms))

/** Human game length: `"38m 30s"`, `"1h 02m"`, `"45s"`. */
export const fmtDuration = (sec: number): string => {
	if (!Number.isFinite(sec) || sec < 0) return "--"
	const total = Math.floor(sec)
	const h = Math.floor(total / 3600)
	const m = Math.floor((total % 3600) / 60)
	const s = total % 60
	if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`
	if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`
	return `${s}s`
}

/**
 * Relative wall-clock, from an epoch-ms timestamp: `"just now"`, `"12m ago"`, `"3h ago"`,
 * `"yesterday"`, `"5d ago"`, then an absolute date past a fortnight.
 * Future timestamps read `"in 5m"` rather than pretending they are past.
 */
export const fmtAgo = (ms: number, now: number = Date.now()): string => {
	if (!Number.isFinite(ms)) return "unknown"
	const delta = now - ms
	const abs = Math.abs(delta)
	const future = delta < 0
	const wrap = (s: string): string => (future ? `in ${s}` : `${s} ago`)

	if (abs < 45_000) return future ? "in a moment" : "just now"
	if (abs < 3_600_000) return wrap(`${Math.round(abs / 60_000)}m`)
	if (abs < 86_400_000) return wrap(`${Math.round(abs / 3_600_000)}h`)
	if (abs < 172_800_000) return future ? "tomorrow" : "yesterday"
	if (abs < 1_209_600_000) return wrap(`${Math.round(abs / 86_400_000)}d`)
	return new Date(ms).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric"
	})
}

/** `"Sep 2, 6:52 PM"` — for the game-list secondary line. */
export const fmtDateTime = (ms: number): string =>
	new Date(ms).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit"
	})

/** Minutes elapsed at a game-clock second, as a float. Metric keys use `@10`, `@14` etc. */
export const gameMinute = (sec: number): number => sec / 60

/** ms remaining until `deadlineMs`, floored at 0. */
export const msUntil = (deadlineMs: number, now: number = Date.now()): number =>
	Math.max(0, deadlineMs - now)

/** `"4m 12s left"` / `"expired"` — used by the replay-download countdown. */
export const fmtCountdown = (deadlineMs: number, now: number = Date.now()): string => {
	const left = deadlineMs - now
	if (left <= 0) return "expired"
	return `${fmtDuration(left / 1000)} left`
}
