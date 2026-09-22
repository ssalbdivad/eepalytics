/**
 * Tiny structured logger.
 *
 * The daemon runs under `systemd --user` with `StandardOutput=journal`, so stdout IS the log
 * file. One line per event, prefixed with a wall clock and a scope, so `journalctl --user -u
 * eepalytics -f` is readable without any extra tooling.
 *
 * NODE ONLY.
 */

export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const envLevel = (): LogLevel => {
	const raw = ((process.env.EEPALYTICS_LOG_LEVEL ?? process.env.CSK_LOG_LEVEL) ?? "info").toLowerCase()
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

/**
 * THE LAST FEW THINGS THAT WENT WRONG, KEPT WHERE SOMETHING OTHER THAN A HUMAN CAN READ THEM.
 *
 * Every real defect found on 2026-09-22 had the same shape: a path failed, the daemon said so, and
 * the sentence went to journald where nobody was looking. The feed threw away 363 polls of a game;
 * the sampler evicted the two windows every frame measurement rests on; the bridge crashed the
 * process on shutdown once in seven days. Each was a WARN or an ERROR that existed and was not
 * watched, and each was found by hand, late, by someone grepping for it.
 *
 * So warnings and errors are also kept in memory: a bounded ring the status route can count. This
 * is not a log — journald is the log, and it holds the detail, the stack and the history. This
 * holds enough for a page to say "the daemon has logged four errors in the last hour" to a person
 * who would otherwise never know to look.
 *
 * Bounded by COUNT rather than by age, because the failure mode worth surviving is a loop that
 * logs the same line thirty times a second, and a ring cannot grow under one. Fifty is enough to
 * show a burst and small enough to be free.
 */
export interface LoggedFault {
	atMs: number
	level: "warn" | "error"
	scope: string
	msg: string
}

const FAULT_RING = 50
const faults: LoggedFault[] = []

/** The recent warnings and errors, newest first. A copy, so a caller cannot mutate the ring. */
export const recentFaults = (limit = FAULT_RING): LoggedFault[] => faults.slice(-limit).reverse()

/** How many of each kind since `sinceMs`, for a status line that does not need the messages. */
export const faultCounts = (sinceMs: number): { warn: number; error: number; oldestKeptMs: number | null } => {
	const kept = faults.filter(f => f.atMs >= sinceMs)
	return {
		warn: kept.filter(f => f.level === "warn").length,
		error: kept.filter(f => f.level === "error").length,
		oldestKeptMs: faults[0]?.atMs ?? null
	}
}

/** Test seam: the ring is module state and a case measuring it must not inherit one. */
export const resetFaults = (): void => {
	faults.length = 0
}

const write = (
	level: LogLevel,
	scope: string,
	msg: string,
	extra?: Record<string, unknown>
): void => {
	/*
	 * RECORDED BEFORE THE LEVEL TEST, deliberately. `setLogLevel("error")` is a decision about what
	 * a human wants to READ; it must not decide what the machine is allowed to know about itself.
	 * A daemon running quiet is exactly the one whose faults nobody will notice.
	 */
	if (level === "warn" || level === "error") {
		faults.push({ atMs: Date.now(), level, scope, msg })
		if (faults.length > FAULT_RING) faults.shift()
	}
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
