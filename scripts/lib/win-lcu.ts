/**
 * Minimal, self-contained Windows-interop LCU reader for `scripts/`.
 *
 * WHY THIS EXISTS SEPARATELY FROM `src/lcu/`:
 *   `scripts/doctor.ts` diagnoses the app when the app is broken, so it must not depend on
 *   the code it is diagnosing — a doctor that fails to import is a doctor that tells you
 *   nothing. `scripts/dev-seed.ts` shares it so there is exactly one copy in `scripts/`.
 *   The daemon uses `src/lcu/` (bridge + curl fallback + ArkType validation); this is the
 *   stripped-down GET-only cousin.
 *
 * GET ONLY. This module has no code path that can issue a POST/PUT/PATCH/DELETE to the
 * League client, by construction — the request writer hardcodes the method.
 *
 * The transport constraint (verified, `.research/lcu-api.md` §7.1): WSL2 here is in NAT
 * networking mode, so WSL's 127.0.0.1 is NOT Windows' 127.0.0.1. Native fetch/curl to the
 * LCU returns HTTP 000. Everything goes through a Windows-side process.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"
import {
	DATA_DIR,
	LCU_AUTH_USER,
	LIVE_CLIENT_PORT,
	LOCKFILE_PATH,
	WIN_CURL,
	WIN_NODE_CANDIDATES
} from "../../src/shared/constants.ts"

/* ============================================================ lockfile */

export interface Lockfile {
	/** Always "LeagueClient" in practice. */
	name: string
	/** Windows PID of LeagueClient.exe. Used to detect a stale lockfile. */
	pid: number
	port: number
	password: string
	protocol: string
	path: string
	mtimeMs: number
}

/**
 * `name:pid:PORT:PASSWORD:https`.
 * NOTE: the file has NO trailing newline — a bash `read` returns non-zero at EOF here.
 */
export const readLockfile = (path: string = LOCKFILE_PATH): Lockfile | null => {
	if (!existsSync(path)) return null
	let text: string
	try {
		text = readFileSync(path, "utf8").trim()
	} catch {
		return null
	}
	const parts = text.split(":")
	if (parts.length < 5) return null
	const [name, pid, port, password, protocol] = parts as [
		string,
		string,
		string,
		string,
		string
	]
	const portNum = Number(port)
	if (!Number.isInteger(portNum) || portNum <= 0 || !password) return null
	return {
		name,
		pid: Number(pid) || 0,
		port: portNum,
		password,
		protocol,
		path,
		mtimeMs: statSync(path).mtimeMs
	}
}

/** Is the PID in the lockfile still a live Windows process? Read-only `tasklist.exe` query. */
export const lockfilePidAlive = (lock: Lockfile): boolean | null => {
	const exe = "/mnt/c/WINDOWS/system32/tasklist.exe"
	if (!existsSync(exe)) return null
	const r = spawnSync(exe, ["/FI", `PID eq ${lock.pid}`, "/NH", "/FO", "CSV"], {
		encoding: "utf8",
		timeout: 8000
	})
	if (r.error || r.status !== 0) return null
	return r.stdout.includes(`"${lock.pid}"`)
}

/* ============================================================ paths */

/** `wslpath -w` — the verified way to hand a WSL path to a Windows binary. */
export const toWindowsPath = (linuxPath: string): string | null => {
	const r = spawnSync("wslpath", ["-w", linuxPath], { encoding: "utf8", timeout: 5000 })
	if (r.status !== 0) return null
	return r.stdout.trim() || null
}

/** First existing Windows `node.exe`, or null. Required for the fast bridge transport. */
export const findWindowsNode = (): string | null => {
	for (const c of WIN_NODE_CANDIDATES) if (existsSync(c)) return c
	return null
}

export const findWindowsCurl = (): string | null => (existsSync(WIN_CURL) ? WIN_CURL : null)

/* ============================================================ transport */

export interface LcuResponse {
	status: number
	body: string
	/** Wall-clock round trip measured on the WSL side, in ms. */
	ms: number
}

export interface LcuTransport {
	readonly kind: "bridge" | "curl"
	/** GET an LCU path (e.g. "/lol-summoner/v1/current-summoner"). */
	get(path: string): Promise<LcuResponse>
	/** GET from the in-game Live Client Data API on port 2999 (no auth, only up mid-game). */
	getLive(path: string): Promise<LcuResponse>
	close(): void
}

export class LcuUnavailableError extends Error {
	override name = "LcuUnavailableError"
}

/* ---------------------------------------------------------- bridge */

/**
 * The Windows-side bridge, written to disk at runtime and run by `node.exe`.
 *
 * Kept as a string (not a checked-in .mjs) so `scripts/` owns no Windows-executed source
 * file and so the password is only ever read INSIDE the Windows process — it never appears
 * in argv, in an environment variable, or in anything we write.
 *
 * Measured p50 2.3 ms per request vs ~88 ms for one `curl.exe` process per request.
 */
const BRIDGE_SOURCE = `
import fs from "node:fs"
import https from "node:https"
import readline from "node:readline"

const LOCK = process.argv[2]
let port = 0, auth = "", agent = null
const say = o => process.stdout.write(JSON.stringify(o) + "\\n")

const loadLock = () => {
	const [, , p, pass] = fs.readFileSync(LOCK, "utf8").trim().split(":")
	if (Number(p) === port) return
	port = Number(p)
	auth = "Basic " + Buffer.from("riot:" + pass).toString("base64")
	agent?.destroy()
	agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false, maxSockets: 8 })
	say({ evt: "lockfile", port })
}

try { loadLock() } catch (e) { say({ evt: "fatal", error: String(e) }); process.exit(1) }
setInterval(() => { try { loadLock() } catch {} }, 5000).unref?.()
say({ evt: "ready", port })

readline.createInterface({ input: process.stdin }).on("line", line => {
	if (!line.trim()) return
	let m
	try { m = JSON.parse(line) } catch { return }
	const live = m.live === true
	const headers = { Accept: "application/json" }
	if (!live) headers.Authorization = auth
	const req = https.request(
		{
			host: "127.0.0.1",
			port: live ? ${LIVE_CLIENT_PORT} : port,
			path: m.path,
			method: "GET",
			agent: live ? undefined : agent,
			rejectUnauthorized: false,
			headers,
			timeout: m.timeout ?? 20000
		},
		r => {
			const c = []
			r.on("data", d => c.push(d))
			r.on("end", () => say({ id: m.id, status: r.statusCode, body: Buffer.concat(c).toString("utf8") }))
		}
	)
	req.on("timeout", () => req.destroy(new Error("timeout")))
	req.on("error", e => say({ id: m.id, error: String(e && e.message || e) }))
	req.end()
})
`

const bridgeScriptPath = (): string => {
	const dir = `${DATA_DIR}/run`
	mkdirSync(dir, { recursive: true })
	const file = `${dir}/probe-bridge.mjs`
	// Rewrite every time: cheap, and it guarantees the script matches this build.
	writeFileSync(file, BRIDGE_SOURCE, "utf8")
	return file
}

interface Pending {
	resolve: (r: LcuResponse) => void
	reject: (e: Error) => void
	startedAt: number
	timer: NodeJS.Timeout
}

class BridgeTransport implements LcuTransport {
	readonly kind = "bridge" as const
	private readonly child: ChildProcessWithoutNullStreams
	private readonly pending = new Map<number, Pending>()
	private seq = 0
	private closed = false

	constructor(child: ChildProcessWithoutNullStreams) {
		this.child = child
		createInterface({ input: child.stdout }).on("line", line => this.onLine(line))
		child.on("exit", () => {
			this.closed = true
			for (const [, p] of this.pending) {
				clearTimeout(p.timer)
				p.reject(new LcuUnavailableError("bridge process exited"))
			}
			this.pending.clear()
		})
	}

	private onLine(line: string): void {
		let msg: { id?: number; status?: number; body?: string; error?: string }
		try {
			msg = JSON.parse(line)
		} catch {
			return
		}
		if (msg.id === undefined) return // {evt:...} notice
		const p = this.pending.get(msg.id)
		if (!p) return
		this.pending.delete(msg.id)
		clearTimeout(p.timer)
		if (msg.error) p.reject(new LcuUnavailableError(msg.error))
		else
			p.resolve({
				status: msg.status ?? 0,
				body: msg.body ?? "",
				ms: performance.now() - p.startedAt
			})
	}

	private request(path: string, live: boolean, timeoutMs: number): Promise<LcuResponse> {
		if (this.closed) return Promise.reject(new LcuUnavailableError("bridge is closed"))
		const id = ++this.seq
		return new Promise<LcuResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new LcuUnavailableError(`bridge request timed out after ${timeoutMs} ms`))
			}, timeoutMs + 2000)
			this.pending.set(id, { resolve, reject, startedAt: performance.now(), timer })
			this.child.stdin.write(`${JSON.stringify({ id, path, live, timeout: timeoutMs })}\n`)
		})
	}

	get(path: string): Promise<LcuResponse> {
		return this.request(path, false, 30000)
	}

	getLive(path: string): Promise<LcuResponse> {
		return this.request(path, true, 5000)
	}

	close(): void {
		this.closed = true
		this.child.stdin.end()
		this.child.kill()
	}
}

/** Spawn the Windows bridge. Resolves once it reports `ready`; rejects on any failure. */
export const openBridge = async (
	lock: Lockfile,
	options: { nodeExe?: string; startTimeoutMs?: number } = {}
): Promise<LcuTransport> => {
	const nodeExe = options.nodeExe ?? findWindowsNode()
	if (!nodeExe) throw new LcuUnavailableError("no Windows node.exe found")
	const scriptWin = toWindowsPath(bridgeScriptPath())
	if (!scriptWin) throw new LcuUnavailableError("wslpath -w failed for the bridge script")
	const lockWin = toWindowsPath(lock.path)
	if (!lockWin) throw new LcuUnavailableError("wslpath -w failed for the lockfile")

	// The lockfile path goes in argv, NOT the environment: WSL only forwards env vars that
	// are listed in WSLENV, so `env:` on an interop spawn silently arrives undefined.
	// Only the PATH is passed — the password is still read inside the Windows process.
	const child = spawn(nodeExe, [scriptWin, lockWin.replace(/\\/g, "/")], {
		stdio: ["pipe", "pipe", "pipe"]
	}) as ChildProcessWithoutNullStreams

	let stderr = ""
	child.stderr.on("data", d => {
		stderr += String(d)
	})

	return await new Promise<LcuTransport>((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.kill()
			reject(new LcuUnavailableError("bridge did not become ready in time"))
		}, options.startTimeoutMs ?? 15000)

		const rl = createInterface({ input: child.stdout })
		const onLine = (line: string): void => {
			let msg: { evt?: string; error?: string }
			try {
				msg = JSON.parse(line)
			} catch {
				return
			}
			if (msg.evt === "ready") {
				clearTimeout(timeout)
				rl.off("line", onLine)
				rl.close()
				resolve(new BridgeTransport(child))
			} else if (msg.evt === "fatal") {
				clearTimeout(timeout)
				child.kill()
				reject(new LcuUnavailableError(msg.error ?? "bridge failed to start"))
			}
		}
		rl.on("line", onLine)
		child.on("error", e => {
			clearTimeout(timeout)
			reject(new LcuUnavailableError(`could not spawn node.exe: ${e.message}`))
		})
		child.on("exit", code => {
			clearTimeout(timeout)
			reject(
				new LcuUnavailableError(
					`bridge exited with code ${code}${stderr ? `: ${stderr.trim().split("\n")[0]}` : ""}`
				)
			)
		})
	})
}

/* ---------------------------------------------------------- curl fallback */

/**
 * One `curl.exe` process per call. ~88 ms each — 38x slower than the bridge — but it needs
 * nothing but curl.exe, so it is the fallback when node.exe is missing.
 *
 * The config goes in on STDIN (`-K -`) so the password never appears in argv or on disk.
 */
class CurlTransport implements LcuTransport {
	readonly kind = "curl" as const
	private readonly lock: Lockfile

	constructor(lock: Lockfile) {
		this.lock = lock
	}

	private run(config: string, timeoutMs: number): LcuResponse {
		const startedAt = performance.now()
		const r = spawnSync(WIN_CURL, ["-K", "-"], {
			input: config,
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer: 128 * 1024 * 1024
		})
		const ms = performance.now() - startedAt
		if (r.error) throw new LcuUnavailableError(`curl.exe: ${r.error.message}`)
		const out = r.stdout ?? ""
		// `-w "\n%{http_code}"` puts the status on the final line.
		const cut = out.lastIndexOf("\n")
		const status = Number(cut >= 0 ? out.slice(cut + 1) : out) || 0
		return { status, body: cut >= 0 ? out.slice(0, cut) : "", ms }
	}

	get(path: string): Promise<LcuResponse> {
		const config =
			`user = "${LCU_AUTH_USER}:${this.lock.password}"\n` +
			`url = "https://127.0.0.1:${this.lock.port}${path}"\n` +
			`insecure\nsilent\nshow-error\nwrite-out = "\\n%{http_code}"\n`
		return Promise.resolve(this.run(config, 30000))
	}

	getLive(path: string): Promise<LcuResponse> {
		const config =
			`url = "https://127.0.0.1:${LIVE_CLIENT_PORT}${path}"\n` +
			`insecure\nsilent\nshow-error\nwrite-out = "\\n%{http_code}"\n`
		return Promise.resolve(this.run(config, 8000))
	}

	close(): void {}
}

export const openCurl = (lock: Lockfile): LcuTransport => {
	if (!findWindowsCurl()) throw new LcuUnavailableError(`${WIN_CURL} not found`)
	return new CurlTransport(lock)
}

/* ---------------------------------------------------------- front door */

export interface OpenLcuResult {
	transport: LcuTransport
	lock: Lockfile
	/** Why the bridge was not used, when we fell back to curl. */
	bridgeError: string | null
}

/** Bridge first, curl second. Throws `LcuUnavailableError` if the client is not running. */
export const openLcu = async (
	options: { preferCurl?: boolean } = {}
): Promise<OpenLcuResult> => {
	const lock = readLockfile()
	if (!lock)
		throw new LcuUnavailableError(
			`no lockfile at ${LOCKFILE_PATH} — the League client is not running`
		)
	if (!options.preferCurl) {
		try {
			return { transport: await openBridge(lock), lock, bridgeError: null }
		} catch (e) {
			return { transport: openCurl(lock), lock, bridgeError: (e as Error).message }
		}
	}
	return { transport: openCurl(lock), lock, bridgeError: "preferCurl was set" }
}

/* ---------------------------------------------------------- typed GET */

export class LcuHttpError extends Error {
	override name = "LcuHttpError"
	readonly path: string
	readonly status: number
	readonly body: string

	constructor(path: string, status: number, body: string) {
		super(`GET ${path} -> HTTP ${status}`)
		this.path = path
		this.status = status
		this.body = body
	}
}

/** GET + JSON.parse, throwing `LcuHttpError` on a non-2xx. */
export const getJson = async <T = unknown>(
	transport: LcuTransport,
	path: string
): Promise<T> => {
	const res = await transport.get(path)
	if (res.status < 200 || res.status >= 300)
		throw new LcuHttpError(path, res.status, res.body.slice(0, 400))
	try {
		return JSON.parse(res.body) as T
	} catch (e) {
		throw new LcuHttpError(path, res.status, `invalid JSON: ${(e as Error).message}`)
	}
}
