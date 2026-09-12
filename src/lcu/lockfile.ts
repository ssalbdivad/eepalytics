/**
 * The LCU lockfile: how we discover the client's port and password.
 *
 * ```
 * /mnt/c/Games/Riot Games/League of Legends/lockfile
 * LeagueClient:6456:50924:<22-char base64url token>:https
 *    name    : pid : port :        password        : protocol
 * ```
 *
 * Three things bite people here, all verified in `.research/lcu-api.md` §5:
 *
 * 1. **There is no trailing newline.** `read` in bash returns non-zero at EOF and drops the
 *    line; Node's `readFileSync` is fine. We trim defensively anyway.
 * 2. **`fs.watch` NEVER FIRES on `/mnt/c`.** DrvFs/9p has no inotify — verified with writes
 *    from both sides producing zero events. `fs.statSync().mtimeMs` works fine, so
 *    `watchLockfile` polls with `fs.watchFile` at 2 s. (The Windows-side bridge does get real
 *    `fs.watch` events and reports them faster; this poller is the WSL-side backstop and the
 *    only mechanism the curl transport has.)
 * 3. **The file outlives the process it describes.** A hard-killed client leaves a stale
 *    lockfile whose port answers nothing. `isPidAlive()` checks the *Windows* pid through
 *    `tasklist.exe`, because a Windows pid means nothing to WSL's `process.kill(pid, 0)`.
 *
 * The password is a full-privilege credential for the running client. It never enters argv,
 * an environment variable, or any file we write.
 */

import fs from "node:fs"
import fsp from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { LCU_AUTH_USER, LOCKFILE_PATH } from "../shared/constants.ts"

const execFileAsync = promisify(execFile)

const TASKLIST = "/mnt/c/WINDOWS/system32/tasklist.exe"

export interface Lockfile {
	/** Always `LeagueClient` in practice, but do not depend on it. */
	name: string
	/** A **Windows** pid. Meaningless to WSL's process table. */
	pid: number
	port: number
	password: string
	/** Always `https`. */
	protocol: string
	/** `Basic base64("riot:<password>")`, ready for an Authorization header. */
	auth: string
	/** `https://127.0.0.1:<port>` — from a Windows process only. */
	origin: string
	/** mtime of the file we read it from, so callers can tell one generation from another. */
	mtimeMs: number
}

/**
 * Parse the five colon-separated fields.
 *
 * The password is base64url and cannot contain `:`, but we still reassemble the middle from
 * `slice(3, -1)` so a future format change degrades into a wrong password rather than a crash.
 */
export const parseLockfile = (text: string, mtimeMs = 0): Lockfile | null => {
	const trimmed = text.trim()
	if (!trimmed) return null
	const parts = trimmed.split(":")
	if (parts.length < 5) return null
	const name = parts[0] ?? ""
	const pid = Number(parts[1])
	const port = Number(parts[2])
	const protocol = parts[parts.length - 1] ?? "https"
	const password = parts.slice(3, -1).join(":")
	if (!Number.isFinite(port) || port <= 0 || !password) return null
	return {
		name,
		pid: Number.isFinite(pid) ? pid : 0,
		port,
		password,
		protocol,
		auth: authHeader(password),
		origin: `${protocol}://127.0.0.1:${port}`,
		mtimeMs
	}
}

const authHeader = (password: string): string =>
	`Basic ${Buffer.from(`${LCU_AUTH_USER}:${password}`).toString("base64")}`

/** `null` when the client is closed (no lockfile) or the file is mid-write / malformed. */
export const readLockfile = async (path = LOCKFILE_PATH): Promise<Lockfile | null> => {
	try {
		const [text, stat] = await Promise.all([
			fsp.readFile(path, "utf8"),
			fsp.stat(path).catch(() => null)
		])
		return parseLockfile(text, stat?.mtimeMs ?? 0)
	} catch {
		return null
	}
}

export const readLockfileSync = (path = LOCKFILE_PATH): Lockfile | null => {
	try {
		const text = fs.readFileSync(path, "utf8")
		let mtimeMs = 0
		try {
			mtimeMs = fs.statSync(path).mtimeMs
		} catch {
			/* mtime is a nicety */
		}
		return parseLockfile(text, mtimeMs)
	} catch {
		return null
	}
}

/** Two lockfiles describe the same client session when port AND password match. */
export const sameLockfile = (a: Lockfile | null, b: Lockfile | null): boolean =>
	a === b || (a !== null && b !== null && a.port === b.port && a.password === b.password)

/** Redacted form, safe for logs and for anything we hand to Claude. */
/* ------------------------------------------------------------ staleness */

/**
 * Is that **Windows** pid still running?
 *
 * `tasklist.exe` exits 0 whether or not it matched, so we parse: a match prints a CSV row
 * whose second column is the pid; a miss prints `INFO: No tasks are running…`. Costs ~300 ms
 * of interop, so call it only when you suspect staleness, never per request.
 */
export const isPidAlive = async (pid: number): Promise<boolean> => {
	if (!Number.isFinite(pid) || pid <= 0) return false
	try {
		const { stdout } = await execFileAsync(
			TASKLIST,
			["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
			{ timeout: 10_000, windowsHide: true }
		)
		for (const line of stdout.split("\n")) {
			const cols = line.trim().split(",")
			const second = cols[1]
			if (second && second.replace(/"/g, "").trim() === String(pid)) return true
		}
		return false
	} catch {
		// tasklist itself is unavailable (no interop?). Don't declare a live client dead on
		// the strength of a broken probe.
		return true
	}
}

/**
 * `{ lockfile, stale }`. `stale: true` means the file exists but its process is gone — treat
 * it exactly like "no client": every request to that port will refuse the connection.
 */
export const readLockfileChecked = async (
	path = LOCKFILE_PATH
): Promise<{ lockfile: Lockfile | null; stale: boolean }> => {
	const lockfile = await readLockfile(path)
	if (!lockfile) return { lockfile: null, stale: false }
	const alive = await isPidAlive(lockfile.pid)
	return { lockfile: alive ? lockfile : null, stale: !alive }
}

/* -------------------------------------------------------------- watching */

export interface WatchLockfileOptions {
	path?: string
	/** Poll interval. 2 s is cheap over 9p and well inside a client restart. */
	intervalMs?: number
	/** Fire the callback once immediately with the current state. Default true. */
	immediate?: boolean
}

/**
 * Watch for the lockfile appearing, changing (client restarted: new pid/port/password) or
 * disappearing (client closed). The callback receives `null` for the last case.
 *
 * Uses `fs.watchFile` (stat polling), NOT `fs.watch` — see the header note.
 *
 * @returns an unsubscribe function.
 */
export const watchLockfile = (
	cb: (lf: Lockfile | null) => void,
	opts: WatchLockfileOptions = {}
): (() => void) => {
	const path = opts.path ?? LOCKFILE_PATH
	const interval = opts.intervalMs ?? 2000
	let last: Lockfile | null = null
	let started = false
	let stopped = false

	const emit = (next: Lockfile | null): void => {
		if (started && sameLockfile(last, next)) return
		started = true
		last = next
		if (!stopped) cb(next)
	}

	const listener = (): void => {
		// Re-read rather than trusting the stat: the interesting change is the CONTENT.
		emit(readLockfileSync(path))
	}

	fs.watchFile(path, { interval, persistent: false }, listener)
	if (opts.immediate !== false) emit(readLockfileSync(path))

	return () => {
		stopped = true
		fs.unwatchFile(path, listener)
	}
}
