/**
 * Tiny structured logger.
 *
 * The daemon runs under `systemd --user` with `StandardOutput=journal`, so stdout IS the log
 * file. One line per event, prefixed with a wall clock and a scope, so `journalctl --user -u
 * coachskaffur -f` is readable without any extra tooling.
 *
 * NODE ONLY.
 */

export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const envLevel = (): LogLevel => {
	const raw = (process.env.CSK_LOG_LEVEL ?? "info").toLowerCase()
	return raw in LEVELS ? (raw as LogLevel) : "info"
}

let threshold = LEVELS[envLevel()]

export const setLogLevel = (level: LogLevel): void => {
	threshold = LEVELS[level]
}

const hhmmss = (): string => {
	const d = new Date()
	const p = (n: number, w = 2) => String(n).padStart(w, "0")
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/**
 * Extra fields are rendered as `k=v` rather than JSON: a daemon log is read by a human far
 * more often than it is parsed, and `job=41 kind=match-ingest` beats a nested object.
 */
const fmtExtra = (extra?: Record<string, unknown>): string => {
	if (!extra) return ""
	const parts: string[] = []
	for (const [k, v] of Object.entries(extra)) {
		if (v === undefined) continue
		const s =
			v === null ? "null"
			: typeof v === "string" ? v
			: typeof v === "number" || typeof v === "boolean" ? String(v)
			: v instanceof Error ? v.message
			: JSON.stringify(v)
		parts.push(`${k}=${s.length > 300 ? `${s.slice(0, 300)}…` : s}`)
	}
	return parts.length > 0 ? ` ${parts.join(" ")}` : ""
}

export interface Logger {
	debug: (msg: string, extra?: Record<string, unknown>) => void
	info: (msg: string, extra?: Record<string, unknown>) => void
	warn: (msg: string, extra?: Record<string, unknown>) => void
	error: (msg: string, extra?: Record<string, unknown>) => void
	child: (sub: string) => Logger
}

const write = (
	level: LogLevel,
	scope: string,
	msg: string,
	extra?: Record<string, unknown>
): void => {
	if (LEVELS[level] < threshold) return
	const line = `${hhmmss()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${fmtExtra(extra)}`
	if (level === "error" || level === "warn") process.stderr.write(`${line}\n`)
	else process.stdout.write(`${line}\n`)
}

export const makeLogger = (scope: string): Logger => ({
	debug: (m, e) => write("debug", scope, m, e),
	info: (m, e) => write("info", scope, m, e),
	warn: (m, e) => write("warn", scope, m, e),
	error: (m, e) => write("error", scope, m, e),
	child: sub => makeLogger(`${scope}:${sub}`)
})

export const log = makeLogger("daemon")

/** `Error` → a short string that is safe to put in `job.lastError`. */
export const errText = (err: unknown): string =>
	err instanceof Error ?
		err.message || err.name
	: typeof err === "string" ? err
	: (() => {
			try {
				return JSON.stringify(err)
			} catch {
				return String(err)
			}
		})()
