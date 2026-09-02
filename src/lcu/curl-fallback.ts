/**
 * Fallback transport: one `curl.exe -K -` per request.
 *
 * ~88 ms per call versus the bridge's 2.3 ms, because Windows process creation dominates
 * (curl's own `time_total` is only ~26 ms of that). It exists so the app still works when
 * Windows has no `node.exe`, or when the bridge wedges. Same `request()` signature, so it is
 * a drop-in for `LcuBridge` — minus websocket events, which curl cannot give us.
 *
 * ## Why `-K -` and not `-u riot:<pass>`
 * `-u` puts the client's full-privilege password in argv, where any process listing can read
 * it. `--netrc-file` puts it on disk. Feeding curl its configuration on **stdin** keeps the
 * secret in memory only. Verified working against the live client (`lcu-api.md` §7.3).
 *
 * ## Framing the response
 * `write-out` appends a sentinel line after the body, so one invocation returns the body
 * bytes AND the status without a second call and without corrupting binary payloads (we split
 * on the sentinel at the Buffer level, before any UTF-8 decoding).
 */

import { EventEmitter } from "node:events"
import { spawn } from "node:child_process"
import fsp from "node:fs/promises"
import path from "node:path"
import { LIVE_CLIENT_PORT, LOCKFILE_PATH, WIN_CURL } from "../shared/constants.ts"
import type { Lockfile } from "./lockfile.ts"
import { readLockfile, watchLockfile } from "./lockfile.ts"
import type {
	HttpMethod,
	LcuResponse,
	LcuTransport,
	RequestOptions,
	TransportState
} from "./transport.ts"
import { LcuTransportError, timeoutFor, winPath } from "./transport.ts"

/** Unlikely to appear in an LCU payload, and we match on the LAST occurrence regardless. */
const SENTINEL = "\n<<<CSK-CURL|"

/**
 * Emitted verbatim, NOT through `cq()`: the leading `\n` has to reach the config file as the
 * two characters backslash+n so curl un-escapes it into a real newline. Running it through the
 * quoter would either split the config across two lines (a raw newline) or double the
 * backslash (a literal `\n` in the output).
 */
const WRITE_OUT_LINE = 'write-out = "\\n<<<CSK-CURL|%{http_code}|%{size_download}"'

/** How long a cached lockfile read is trusted before we stat the file again. */
const LOCK_CACHE_MS = 2000

export interface LcuCurlOptions {
	curlPath?: string
	lockfilePath?: string
	onLog?: (line: string) => void
}

/**
 * Quote a value for a curl config file.
 *
 * curl un-escapes `\\ \" \t \n \r \v` inside double quotes, so the backslash pass MUST run
 * first — otherwise a JSON body containing `\n` (two characters) would reach the server as a
 * literal newline and the JSON would be invalid.
 */
const cq = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

export class LcuCurl extends EventEmitter implements LcuTransport {
	readonly kind = "curl" as const

	#state: TransportState = "stopped"
	#lock: Lockfile | null = null
	#lockReadMs = 0
	#unwatch: (() => void) | null = null
	#opts: LcuCurlOptions

	constructor(opts: LcuCurlOptions = {}) {
		super()
		this.#opts = opts
		this.on("error", () => {})
	}

	get state(): TransportState {
		return this.#state
	}

	get lcuPort(): number | null {
		return this.#lock?.port ?? null
	}

	/** Is curl.exe reachable? If not, nothing can talk to the client from here. */
	static async available(curlPath = WIN_CURL): Promise<boolean> {
		try {
			await fsp.access(curlPath)
			return true
		} catch {
			return false
		}
	}

	async start(): Promise<void> {
		this.#setState("starting")
		const curlPath = this.#opts.curlPath ?? WIN_CURL
		try {
			await fsp.access(curlPath)
		} catch (err) {
			this.#setState("failed")
			throw new LcuTransportError("SPAWN_FAILED", `curl.exe not found at ${curlPath}`, err)
		}
		this.#unwatch ??= watchLockfile(
			lf => {
				this.#lock = lf
				this.#lockReadMs = Date.now()
				this.emit("lockfile", lf ? { port: lf.port, pid: lf.pid, name: lf.name } : null)
				this.#setState(lf ? "ready" : "degraded")
			},
			{ path: this.#opts.lockfilePath ?? LOCKFILE_PATH }
		)
		// watchLockfile fires immediately, so state is already correct by here.
		if (this.#state === "starting") this.#setState(this.#lock ? "ready" : "degraded")
	}

	async stop(): Promise<void> {
		this.#unwatch?.()
		this.#unwatch = null
		this.#setState("stopped")
	}

	async request(
		method: HttpMethod,
		requestPath: string,
		body?: unknown,
		opts?: RequestOptions
	): Promise<LcuResponse> {
		const res = await this.#attempt(method, requestPath, body, opts)
		// A 401 means the client restarted and rotated its password: re-read and retry once.
		if (res.status === 401 && (opts?.target ?? "lcu") === "lcu") {
			const before = this.#lock
			await this.#refreshLock(true)
			if (this.#lock && (!before || before.password !== this.#lock.password))
				return this.#attempt(method, requestPath, body, opts)
		}
		return res
	}

	/* ---------------------------------------------------------- internals */

	#setState(next: TransportState): void {
		if (this.#state === next) return
		this.#state = next
		this.emit("state", next)
	}

	#log(line: string): void {
		if (this.#opts.onLog) this.#opts.onLog(line)
		else console.error(line)
	}

	async #refreshLock(force = false): Promise<Lockfile | null> {
		if (!force && this.#lock && Date.now() - this.#lockReadMs < LOCK_CACHE_MS) return this.#lock
		this.#lock = await readLockfile(this.#opts.lockfilePath ?? LOCKFILE_PATH)
		this.#lockReadMs = Date.now()
		return this.#lock
	}

	async #attempt(
		method: HttpMethod,
		requestPath: string,
		body: unknown,
		opts?: RequestOptions
	): Promise<LcuResponse> {
		const target = opts?.target ?? "lcu"
		const timeoutMs = timeoutFor(opts)
		const startedMs = Date.now()

		let origin: string
		let lock: Lockfile | null = null
		if (target === "live") {
			origin = `https://127.0.0.1:${LIVE_CLIENT_PORT}`
		} else {
			lock = await this.#refreshLock()
			if (!lock)
				throw new LcuTransportError("NO_LOCKFILE", "league client is not running (no lockfile)")
			origin = lock.origin
		}

		const lines: string[] = [
			"silent",
			"show-error",
			"insecure",
			`request = ${cq(method)}`,
			`url = ${cq(origin + requestPath)}`,
			`max-time = ${Math.ceil(timeoutMs / 1000)}`,
			`header = ${cq("Accept: application/json")}`
		]
		if (lock) lines.push(`user = ${cq(`riot:${lock.password}`)}`)
		for (const [name, value] of Object.entries(opts?.headers ?? {}))
			lines.push(`header = ${cq(`${name}: ${value}`)}`)
		if (body !== undefined && body !== null) {
			const payload = typeof body === "string" ? body : JSON.stringify(body)
			lines.push(`header = ${cq("Content-Type: application/json")}`)
			lines.push(`data-binary = ${cq(payload)}`)
		}
		if (opts?.toFile) {
			await fsp.mkdir(path.dirname(opts.toFile), { recursive: true })
			lines.push(`output = ${cq(await winPath(opts.toFile))}`)
		}
		lines.push(WRITE_OUT_LINE)

		const { stdout, stderr, code } = await this.#runCurl(lines.join("\n") + "\n", timeoutMs)

		const marker = stdout.lastIndexOf(Buffer.from(SENTINEL, "utf8"))
		if (marker < 0) {
			throw new LcuTransportError(
				curlErrorCode(code),
				`curl failed (exit ${code}) for ${method} ${requestPath}: ${stderr.trim() || "no output"}`
			)
		}
		const buffer = stdout.subarray(0, marker)
		const tail = stdout.subarray(marker + SENTINEL.length).toString("utf8")
		const [statusText = "0", sizeText = "0"] = tail.trim().split("|")
		const status = Number(statusText) || 0
		const bytes = Number(sizeText) || buffer.length

		if (status === 0) {
			throw new LcuTransportError(
				curlErrorCode(code),
				`curl could not reach ${origin}${requestPath} (exit ${code}): ${stderr.trim() || "connection failed"}`
			)
		}

		return {
			status,
			body: opts?.toFile ? "" : buffer.toString("utf8"),
			buffer: opts?.binary ? buffer : null,
			bytes,
			file: opts?.toFile ?? null,
			durationMs: Date.now() - startedMs,
			target,
			method,
			path: requestPath
		}
	}

	#runCurl(
		config: string,
		timeoutMs: number
	): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
		const curlPath = this.#opts.curlPath ?? WIN_CURL
		return new Promise((resolve, reject) => {
			const child = spawn(curlPath, ["-K", "-"], { stdio: ["pipe", "pipe", "pipe"] })
			const out: Buffer[] = []
			let err = ""
			let settled = false

			// Interop process spawn costs ~65 ms on top of curl's own --max-time, so give the
			// wall-clock guard real slack before we conclude the process is wedged.
			const timer = setTimeout(() => {
				if (settled) return
				settled = true
				try {
					child.kill("SIGKILL")
				} catch {
					/* ignore */
				}
				reject(new LcuTransportError("TIMEOUT", `curl.exe did not return within ${timeoutMs + 5000}ms`))
			}, timeoutMs + 5000)
			if (timer.unref) timer.unref()

			child.stdout.on("data", (c: Buffer) => out.push(c))
			child.stderr.on("data", (c: Buffer) => {
				err += c.toString("utf8")
			})
			child.on("error", e => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				reject(new LcuTransportError("SPAWN_FAILED", `could not spawn ${curlPath}: ${e.message}`, e))
			})
			child.on("close", code => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				resolve({ stdout: Buffer.concat(out), stderr: err, code })
			})

			try {
				child.stdin.end(config)
			} catch (e) {
				this.#log(`[lcu-curl] failed to write config: ${String(e)}`)
			}
		})
	}
}

/** curl exit codes we can say something useful about. 7 = connection refused, 28 = timeout. */
const curlErrorCode = (code: number | null): "CLIENT_CLOSED" | "TIMEOUT" | "CURL_FAILED" =>
	code === 7 ? "CLIENT_CLOSED"
	: code === 28 ? "TIMEOUT"
	: "CURL_FAILED"
