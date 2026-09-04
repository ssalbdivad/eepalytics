/**
 * Native transport: this process talks to the League client itself, over the loopback.
 *
 * This is the transport for **native Windows**, where `127.0.0.1` here is `127.0.0.1` there and
 * the two interop transports cannot run at all (no `wslpath`, no `/mnt/c/...curl.exe`). It is
 * the fastest of the three by construction — no Windows process to spawn, no stdio hop, a
 * keep-alive socket per target — and it is the one the app will actually ship on for the 99%
 * of people who have never opened WSL.
 *
 * The WSL path is untouched: `createLcu` only reaches for this transport when the environment
 * says interop is impossible, or when a real request has *proved* the loopback answers. See
 * `select.ts`.
 *
 * ## Why `node:https` and not `fetch`
 * The LCU serves HTTPS with a self-signed Riot certificate, and the in-game API on 2999 does
 * the same. `fetch` in Node has no per-request TLS option — accepting that certificate through
 * `fetch` means `NODE_TLS_REJECT_UNAUTHORIZED=0`, which is process-wide and would also switch
 * off verification for this daemon's calls to Anthropic and Google. `https.request` takes
 * `rejectUnauthorized: false` per connection, so the exemption stops at the loopback socket it
 * was meant for. This is the same reasoning `bridge/bridge.mjs` records for the Windows side.
 *
 * ## Auth is exactly what the other transports send
 * `Authorization: Basic base64("riot:<lockfile password>")` for `target: "lcu"`, and nothing at
 * all for `target: "live"` — port 2999 has no auth. The password never enters argv here (it
 * never leaves the heap), which is the same property `LcuCurl` buys with `-K -`.
 *
 * ## Events: YES — this transport holds the WAMP websocket
 * Unlike `LcuCurl`, `LcuDirect` subscribes to the LCU's websocket and emits `lcu-event` just
 * like `LcuBridge` does, so choosing it does not silently downgrade the daemon to polling. It
 * performs RFC 6455 by hand (`ws-frames.ts`) for the same TLS reason as above. Pass
 * `events: false` to skip it.
 *
 * ## It has no `failed` state
 * There is no process to spawn and nothing to wedge, so the only failure this transport can
 * have is a request that does not answer — which is per-request, and reported as a typed
 * `LcuTransportError`. With the client closed it sits `degraded`, exactly like the others.
 *
 * ## `toFile` writes a NATIVE path
 * There is no `wslpath` step: the path is handed to `fs.createWriteStream` as given. On
 * Windows that means callers must pass a Windows path, which is what they will already be
 * computing from `DATA_DIR`.
 */

import { EventEmitter } from "node:events"
import fs from "node:fs"
import https from "node:https"
import type { Agent } from "node:https"
import type { Socket } from "node:net"
import path from "node:path"
import { LIVE_CLIENT_PORT } from "../shared/constants.ts"
import type { Lockfile } from "./lockfile.ts"
import {
	lockfileCandidates,
	readAnyLockfileSync,
	sameLockfile,
	watchAnyLockfile
} from "./lockfile.ts"
import type {
	HttpMethod,
	LcuEventMessage,
	LcuResponse,
	LcuTarget,
	LcuTransport,
	RequestOptions,
	TransportState
} from "./transport.ts"
import { LcuTransportError, timeoutFor } from "./transport.ts"
import { WS_OPCODE, acceptKeyFor, encodeFrame, newWsKey, readFrame } from "./ws-frames.ts"

/** Same wildcard the bridge subscribes to, and for the same measured reason (see `DEFAULT_LCU_TOPICS`). */
const DEFAULT_TOPICS = ["OnJsonApiEvent"] as const

/** Drop websocket payloads larger than this rather than holding a 10 MB champ-select blob. */
const MAX_EVENT_BYTES = 256 * 1024

const WS_BACKOFF_BASE_MS = 1000
const WS_BACKOFF_MAX_MS = 30_000

/** How long a cached lockfile read is trusted before we look at the file again. */
const LOCK_CACHE_MS = 2000

export interface LcuDirectOptions {
	/** Override the lockfile. Otherwise every candidate for this platform is watched. */
	lockfilePath?: string
	/** Subscribe to the LCU websocket and emit `lcu-event`. Default true. */
	events?: boolean
	topics?: readonly string[]
	/** The loopback host. Only tests move it. */
	host?: string
	/** The in-game API port. Only tests move it. */
	livePort?: number
	onLog?: (line: string) => void
}

export interface DirectProbeResult {
	/**
	 * `reachable` — something answered on the loopback, whatever the status: proof.
	 * `unreachable` — the connection was refused or timed out: proof of the opposite.
	 * `unknown` — nothing to aim at (no lockfile, so the client is closed): no evidence.
	 */
	verdict: "reachable" | "unreachable" | "unknown"
	detail: string
	durationMs: number
}

/**
 * Can this process reach the League client directly, right now?
 *
 * A status code — *any* status code, 401 and 404 included — is proof that the socket answered.
 * `ECONNREFUSED` is proof it did not, and is exactly what WSL2's NAT loopback returns. With the
 * client closed there is nothing to aim at and the honest answer is `unknown`; the caller then
 * has to fall back to an argument about the environment.
 *
 * Deliberately short-timeout and read-only: it issues one GET against a path that exists on
 * every client build.
 */
export const probeDirect = async (
	opts: { lockfilePath?: string; host?: string; timeoutMs?: number } = {}
): Promise<DirectProbeResult> => {
	const startedMs = Date.now()
	const paths = opts.lockfilePath ? [opts.lockfilePath] : lockfileCandidates()
	const lock = readAnyLockfileSync(paths)
	if (!lock)
		return {
			verdict: "unknown",
			detail: `no lockfile at ${paths.join(", ")} — the client is closed, so nothing can answer`,
			durationMs: Date.now() - startedMs
		}

	const transport = new LcuDirect({
		lockfilePath: opts.lockfilePath,
		events: false,
		host: opts.host
	})
	try {
		const res = await transport.request("GET", "/riotclient/auth-token", undefined, {
			timeoutMs: opts.timeoutMs ?? 2000
		})
		return {
			verdict: "reachable",
			detail: `HTTP ${res.status} from 127.0.0.1:${lock.port}`,
			durationMs: Date.now() - startedMs
		}
	} catch (err) {
		const code = err instanceof LcuTransportError ? err.code : "DIRECT_FAILED"
		return {
			verdict: code === "PROTOCOL" ? "unknown" : "unreachable",
			detail: `${code}: ${err instanceof Error ? err.message : String(err)}`,
			durationMs: Date.now() - startedMs
		}
	} finally {
		await transport.stop().catch(() => {})
	}
}

export class LcuDirect extends EventEmitter implements LcuTransport {
	readonly kind = "direct" as const

	#state: TransportState = "stopped"
	#opts: LcuDirectOptions
	#paths: string[]
	#lock: Lockfile | null = null
	#lockReadMs = 0
	#unwatch: (() => void) | null = null
	#lcuAgent: Agent | null = null
	#liveAgent: Agent
	#ws: Socket | null = null
	#wsRetry: NodeJS.Timeout | null = null
	#wsBackoffMs = WS_BACKOFF_BASE_MS
	#stopping = false

	constructor(opts: LcuDirectOptions = {}) {
		super()
		this.#opts = opts
		this.#paths = opts.lockfilePath ? [opts.lockfilePath] : lockfileCandidates()
		this.#liveAgent = new https.Agent({
			keepAlive: true,
			rejectUnauthorized: false,
			maxSockets: 8
		})
		// A transport nobody listens to must not crash the daemon on an error event.
		this.on("error", () => {})
	}

	get state(): TransportState {
		return this.#state
	}

	/** The LCU port we are currently talking to, or `null` if the client is closed. */
	get lcuPort(): number | null {
		return this.#lock?.port ?? null
	}

	/** The lockfile paths this transport is watching. Useful in a log line, and in tests. */
	get lockfilePaths(): readonly string[] {
		return this.#paths
	}

	async start(): Promise<void> {
		this.#stopping = false
		this.#setState("starting")
		// Every candidate is watched, not just the one that exists today: on a native Windows
		// install we do not know which standard install location is real until a lockfile shows
		// up in one of them, and the client may not have been started yet. Under WSL there is
		// exactly one candidate, so this is the same single `fs.watchFile` poll the curl
		// transport uses. `watchAnyLockfile` fires immediately, so `#lock` is already current.
		this.#unwatch ??= watchAnyLockfile(lf => this.#adopt(lf), { paths: this.#paths })
		if (this.#state === "starting") this.#setState(this.#lock ? "ready" : "degraded")
	}

	async stop(): Promise<void> {
		this.#stopping = true
		this.#unwatch?.()
		this.#unwatch = null
		this.#closeWs()
		this.#lcuAgent?.destroy()
		this.#lcuAgent = null
		this.#liveAgent.destroy()
		this.#setState("stopped")
	}

	async request(
		method: HttpMethod,
		requestPath: string,
		body?: unknown,
		opts?: RequestOptions
	): Promise<LcuResponse> {
		const res = await this.#attempt(method, requestPath, body, opts)
		// A 401 means the client restarted and rotated its password: re-read and retry once,
		// so a restart costs one wasted request instead of an outage.
		if (res.status === 401 && (opts?.target ?? "lcu") === "lcu") {
			const before = this.#lock
			this.#refreshLock(true)
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

	/** Take on a new lockfile generation (or its absence). Idempotent; safe to spam. */
	#adopt(found: Lockfile | null): void {
		this.#lockReadMs = Date.now()
		if (sameLockfile(this.#lock, found)) return
		this.#lock = found
		// The agent pools sockets to a port with a password baked into every request; a new
		// generation of the lockfile invalidates both, so the pool goes with it.
		this.#lcuAgent?.destroy()
		this.#lcuAgent =
			found ? new https.Agent({ keepAlive: true, rejectUnauthorized: false, maxSockets: 16 })
			: null
		this.emit("lockfile", found ? { port: found.port, pid: found.pid, name: found.name } : null)
		if (this.#state !== "stopped" && this.#state !== "starting")
			this.#setState(found ? "ready" : "degraded")
		if (this.#opts.events === false) return
		if (found) this.#openWs()
		else this.#closeWs()
	}

	#refreshLock(force = false): Lockfile | null {
		if (!force && this.#lock && Date.now() - this.#lockReadMs < LOCK_CACHE_MS) return this.#lock
		this.#adopt(readAnyLockfileSync(this.#paths))
		return this.#lock
	}

	#target(target: LcuTarget): { port: number; auth: string | null } {
		if (target === "live")
			return { port: this.#opts.livePort ?? LIVE_CLIENT_PORT, auth: null }
		const lock = this.#refreshLock()
		if (!lock)
			throw new LcuTransportError("NO_LOCKFILE", "league client is not running (no lockfile)")
		return { port: lock.port, auth: lock.auth }
	}

	#attempt(
		method: HttpMethod,
		requestPath: string,
		body: unknown,
		opts?: RequestOptions
	): Promise<LcuResponse> {
		const target = opts?.target ?? "lcu"
		const timeoutMs = timeoutFor(opts)
		const startedMs = Date.now()
		const host = this.#opts.host ?? "127.0.0.1"
		const { port, auth } = this.#target(target)

		const headers: Record<string, string> = {
			Accept: "application/json",
			...(opts?.headers ?? {})
		}
		// The transport owns Authorization — a caller's copy would be a stale password.
		if (auth) headers.Authorization = auth
		let payload: Buffer | null = null
		if (body !== undefined && body !== null) {
			payload = Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8")
			headers["Content-Type"] ??= "application/json"
			headers["Content-Length"] = String(payload.length)
		}

		return new Promise<LcuResponse>((resolve, reject) => {
			let settled = false
			const fail = (err: LcuTransportError): void => {
				if (settled) return
				settled = true
				reject(err)
			}

			const req = https.request({
				host,
				port,
				path: requestPath,
				method,
				headers,
				agent: target === "live" ? this.#liveAgent : (this.#lcuAgent ?? undefined),
				// Scoped to this connection. See the header: the process-wide switch would
				// also disable verification for the model APIs this daemon calls.
				rejectUnauthorized: false
			})

			req.setTimeout(timeoutMs, () => {
				req.destroy(
					new LcuTransportError(
						"TIMEOUT",
						`${method} ${requestPath} timed out after ${timeoutMs}ms (direct)`
					)
				)
			})

			req.on("error", (err: NodeJS.ErrnoException) => {
				fail(
					err instanceof LcuTransportError ? err : (
						new LcuTransportError(
							directErrorCode(err.code),
							`${method} ${requestPath} to ${host}:${port} failed (${err.code ?? "unknown"}): ${err.message}`,
							err
						)
					)
				)
			})

			req.on("response", res => {
				const status = res.statusCode ?? 0

				if (opts?.toFile) {
					const file = opts.toFile
					let bytes = 0
					let out: fs.WriteStream
					try {
						fs.mkdirSync(path.dirname(file), { recursive: true })
						out = fs.createWriteStream(file)
					} catch (err) {
						res.resume()
						fail(new LcuTransportError("PATH", `cannot write ${file}`, err))
						return
					}
					res.on("data", (c: Buffer) => {
						bytes += c.length
					})
					res.on("error", err =>
						fail(new LcuTransportError("DIRECT_FAILED", `${requestPath}: ${err.message}`, err))
					)
					out.on("error", err =>
						fail(new LcuTransportError("PATH", `cannot write ${file}: ${err.message}`, err))
					)
					out.on("close", () => {
						if (settled) return
						settled = true
						resolve({
							status,
							body: "",
							buffer: null,
							bytes,
							file,
							durationMs: Date.now() - startedMs,
							target,
							method,
							path: requestPath
						})
					})
					res.pipe(out)
					return
				}

				const chunks: Buffer[] = []
				res.on("data", (c: Buffer) => chunks.push(c))
				res.on("error", err =>
					fail(new LcuTransportError("DIRECT_FAILED", `${requestPath}: ${err.message}`, err))
				)
				res.on("end", () => {
					if (settled) return
					settled = true
					const buffer = Buffer.concat(chunks)
					resolve({
						status,
						body: buffer.toString("utf8"),
						buffer: opts?.binary ? buffer : null,
						bytes: buffer.length,
						file: null,
						durationMs: Date.now() - startedMs,
						target,
						method,
						path: requestPath
					})
				})
			})

			if (payload) req.end(payload)
			else req.end()
		})
	}

	/* -------------------------------------------------------- websocket */

	#closeWs(): void {
		if (this.#wsRetry) {
			clearTimeout(this.#wsRetry)
			this.#wsRetry = null
		}
		const sock = this.#ws
		this.#ws = null
		if (sock)
			try {
				sock.destroy()
			} catch {
				/* already gone */
			}
	}

	#scheduleWsRetry(): void {
		if (this.#stopping || !this.#lock || this.#wsRetry) return
		this.#wsRetry = setTimeout(() => {
			this.#wsRetry = null
			this.#openWs()
		}, this.#wsBackoffMs)
		if (this.#wsRetry.unref) this.#wsRetry.unref()
		this.#wsBackoffMs = Math.min(this.#wsBackoffMs * 2, WS_BACKOFF_MAX_MS)
	}

	/**
	 * Open the LCU's WAMP feed: an HTTP upgrade on the same port, with the same basic auth.
	 *
	 * `https.request` + the `upgrade` event rather than `new WebSocket(...)`, because only this
	 * form lets the self-signed-certificate exemption stay scoped to this one socket.
	 */
	#openWs(): void {
		this.#closeWs()
		if (this.#stopping || this.#opts.events === false) return
		const active = this.#lock
		if (!active) return
		const host = this.#opts.host ?? "127.0.0.1"
		const key = newWsKey()

		const req = https.request({
			host,
			port: active.port,
			path: "/",
			method: "GET",
			rejectUnauthorized: false,
			headers: {
				Authorization: active.auth,
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Key": key,
				"Sec-WebSocket-Version": "13"
			}
		})

		req.on("upgrade", (res, socket, head) => {
			if (res.headers["sec-websocket-accept"] !== acceptKeyFor(key)) {
				// Wrong peer, or a proxy in the way. Never speak frames at it.
				this.emit("ws", "error")
				socket.destroy()
				this.#scheduleWsRetry()
				return
			}
			if (this.#lock !== active || this.#stopping) {
				socket.destroy()
				return
			}
			this.#ws = socket
			this.#wsBackoffMs = WS_BACKOFF_BASE_MS
			try {
				socket.setNoDelay(true)
			} catch {
				/* not fatal — it is a latency nicety */
			}
			this.#attachFrames(socket, head)
			for (const topic of this.#opts.topics ?? DEFAULT_TOPICS)
				socket.write(encodeFrame(WS_OPCODE.text, Buffer.from(JSON.stringify([5, topic]))))
			this.emit("ws", "open")
		})

		req.on("response", res => {
			res.resume()
			this.#log(`[lcu-direct] websocket upgrade refused, HTTP ${res.statusCode}`)
			this.emit("ws", "error")
			this.#scheduleWsRetry()
		})
		req.on("error", err => {
			this.#log(`[lcu-direct] websocket error: ${err.message}`)
			this.emit("ws", "error")
			this.#scheduleWsRetry()
		})
		req.end()
	}

	#attachFrames(socket: Socket, head: Buffer): void {
		// Annotated: `Buffer.concat` widens to `Buffer<ArrayBufferLike>` and the inferred type
		// from `Buffer.from` is narrower, so the reassignment below will not typecheck without it.
		let buf: Buffer = head.length ? Buffer.from(head) : Buffer.alloc(0)
		let fragOpcode = 0
		let frags: Buffer[] = []

		const onClosed = (): void => {
			if (this.#ws !== socket) return
			this.#ws = null
			this.emit("ws", "close")
			this.#scheduleWsRetry()
		}

		socket.on("data", (chunk: Buffer) => {
			buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
			for (;;) {
				let frame
				try {
					frame = readFrame(buf)
				} catch (err) {
					this.#log(`[lcu-direct] ${String(err)}`)
					socket.destroy()
					return
				}
				if (!frame) return
				buf = buf.subarray(frame.consumed)

				if (frame.opcode === WS_OPCODE.close) {
					socket.write(encodeFrame(WS_OPCODE.close, Buffer.alloc(0)))
					socket.destroy()
					return
				}
				if (frame.opcode === WS_OPCODE.ping) {
					socket.write(encodeFrame(WS_OPCODE.pong, frame.payload))
					continue
				}
				if (frame.opcode === WS_OPCODE.pong) continue

				if (frame.opcode === WS_OPCODE.continuation) frags.push(frame.payload)
				else {
					fragOpcode = frame.opcode
					frags = [frame.payload]
				}
				if (!frame.fin) continue

				const payload = frags.length === 1 ? (frags[0] as Buffer) : Buffer.concat(frags)
				frags = []
				if (fragOpcode === WS_OPCODE.text || fragOpcode === WS_OPCODE.binary)
					this.#onWsMessage(payload)
			}
		})
		socket.on("close", onClosed)
		socket.on("end", onClosed)
		socket.on("error", () => {
			try {
				socket.destroy()
			} catch {
				/* ignore */
			}
			onClosed()
		})
	}

	/** A subscribe ack is a ZERO-LENGTH frame — skip it, do not try to parse it. */
	#onWsMessage(payload: Buffer): void {
		if (payload.length === 0) return
		let parsed: unknown
		try {
			parsed = JSON.parse(payload.toString("utf8"))
		} catch {
			return
		}
		// [8, "<topic>", {uri, eventType, data}]
		if (!Array.isArray(parsed) || parsed.length < 3) return
		const topic = typeof parsed[1] === "string" ? parsed[1] : "OnJsonApiEvent"
		const body = parsed[2] as { uri?: unknown; eventType?: unknown; data?: unknown } | null
		if (!body || typeof body !== "object") return
		const event: LcuEventMessage = {
			topic,
			uri: typeof body.uri === "string" ? body.uri : "",
			eventType: typeof body.eventType === "string" ? body.eventType : "",
			data: payload.length > MAX_EVENT_BYTES ? null : body.data,
			truncated: payload.length > MAX_EVENT_BYTES
		}
		this.emit("lcu-event", event)
	}
}

/**
 * Map a socket error to the shared vocabulary.
 *
 * `ECONNREFUSED` is the one that matters: on a native machine it means the client is closed
 * (or the lockfile is stale), and it is *also* precisely what WSL2's NAT loopback returns for
 * a port that only exists on the Windows side. Both are "we did not reach the API", which is
 * what `CLIENT_CLOSED` says; `select.ts` is what tells the two apart, by asking whether we are
 * in WSL at all.
 */
const directErrorCode = (
	code: string | undefined
): "CLIENT_CLOSED" | "TIMEOUT" | "DIRECT_FAILED" =>
	code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH" ? "CLIENT_CLOSED"
	: code === "ETIMEDOUT" ? "TIMEOUT"
	: "DIRECT_FAILED"
