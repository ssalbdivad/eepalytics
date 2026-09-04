/**
 * WSL-side client for `bridge/bridge.mjs`.
 *
 * Spawns Windows `node.exe` through WSL interop, speaks NDJSON over its stdio, and turns the
 * LCU's WAMP websocket into ordinary `EventEmitter` events. Measured round trip through this
 * path: **p50 2.30 ms, p95 3.09 ms** (n=50) versus ~88 ms for a `curl.exe` spawn per request.
 *
 * ```ts
 * const bridge = new LcuBridge()
 * bridge.on("state", s => console.log("transport", s))
 * bridge.on("lcu-event", e => console.log(e.uri, e.eventType))
 * await bridge.start()
 * const res = await bridge.request("GET", "/lol-gameflow/v1/gameflow-phase")
 * ```
 *
 * The bridge process is treated as disposable: if it dies it is respawned with exponential
 * backoff and in-flight requests reject with `TRANSPORT_STOPPED`. After
 * `MAX_CONSECUTIVE_RESTARTS` fast failures the transport declares itself `failed`, which is
 * `createLcu`'s cue to fall back to curl.
 */

import { EventEmitter } from "node:events"
import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import fsp from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"
import {
	LIVE_CLIENT_PORT,
	LOCKFILE_PATH,
	WIN_NODE_CANDIDATES
} from "../shared/constants.ts"
import type {
	HttpMethod,
	LcuEventMessage,
	LcuResponse,
	LcuTransport,
	RequestOptions,
	TransportState
} from "./transport.ts"
import { LcuTransportError, timeoutFor, winPath } from "./transport.ts"

/**
 * WAMP topics to subscribe to.
 *
 * **Use the wildcard.** The documented per-resource form (`OnJsonApiEvent_` + the resource
 * path with `/` replaced by `_`) is accepted by the client and then delivers NOTHING — measured
 * on 16.17 during champ select: `OnJsonApiEvent` produced 4 events in 25 s while
 * `OnJsonApiEvent_lol-champ-select_v1_session` + `…gameflow-phase` produced 0 over the same
 * window, and 0 again over a separate 110 s window.
 *
 * The wildcard is not a firehose either — the client is mostly idle behind the game (3 events
 * in 60 s while idle, 4 in 25 s during champ select), so filtering on `uri` client-side costs
 * nothing.
 */
export const DEFAULT_LCU_TOPICS = ["OnJsonApiEvent"] as const

/** The `uri` values worth reacting to. Match with `startsWith` — metadata carries a gameId. */
export const LCU_EVENT_URIS = {
	gameflowPhase: "/lol-gameflow/v1/gameflow-phase",
	gameflowSession: "/lol-gameflow/v1/session",
	gameflowWatch: "/lol-gameflow/v1/watch",
	/** `/lol-replays/v1/metadata/<gameId>` — fires repeatedly as a download progresses. */
	replayMetadata: "/lol-replays/v1/metadata/",
	champSelect: "/lol-champ-select/v1/session",
	endOfGame: "/lol-end-of-game/v1/eog-stats-block"
} as const

const RESTART_BASE_MS = 1000
const RESTART_MAX_MS = 30_000
const MAX_CONSECUTIVE_RESTARTS = 5
/** A bridge that survives this long is considered healthy; the restart counter resets. */
const HEALTHY_UPTIME_MS = 30_000
const READY_TIMEOUT_MS = 20_000

interface Pending {
	resolve: (res: LcuResponse) => void
	reject: (err: Error) => void
	timer: NodeJS.Timeout
	startedMs: number
	method: HttpMethod
	path: string
	target: "lcu" | "live"
	toFile: string | null
}

export interface LcuBridgeOptions {
	/** Override the Windows Node binary. Otherwise `CSK_WIN_NODE`, then the known locations. */
	nodeExe?: string
	/** Override the lockfile the bridge watches (a WSL path; translated for Windows). */
	lockfilePath?: string
	/** WAMP topics to subscribe to. Defaults to `DEFAULT_LCU_TOPICS`. */
	topics?: readonly string[]
	/** Where bridge stderr goes. Defaults to `console.error`. */
	onLog?: (line: string) => void
}

/**
 * Locate a Windows `node.exe` reachable through interop.
 *
 * Returns `null` rather than throwing — "Windows has no Node" is a supported configuration
 * that simply means we run on curl.
 */
export const findWindowsNode = async (override?: string): Promise<string | null> => {
	const candidates = [
		override,
		(process.env.EEPALYTICS_WIN_NODE ?? process.env.CSK_WIN_NODE),
		...WIN_NODE_CANDIDATES
	].filter((c): c is string => typeof c === "string" && c.length > 0)
	for (const candidate of candidates) {
		try {
			await fsp.access(candidate)
			return candidate
		} catch {
			/* try the next one */
		}
	}
	return null
}

export class LcuBridge extends EventEmitter implements LcuTransport {
	readonly kind = "bridge" as const

	#state: TransportState = "stopped"
	#child: ChildProcessWithoutNullStreams | null = null
	#pending = new Map<number, Pending>()
	#seq = 0
	#stopping = false
	#restarts = 0
	#restartTimer: NodeJS.Timeout | null = null
	#spawnedMs = 0
	#starting: Promise<void> | null = null
	#opts: LcuBridgeOptions
	#lcuPort: number | null = null

	constructor(opts: LcuBridgeOptions = {}) {
		super()
		this.#opts = opts
		// A transport nobody listens to must not crash the daemon on an error event.
		this.on("error", () => {})
	}

	get state(): TransportState {
		return this.#state
	}

	/** The LCU port the bridge is currently talking to, or `null` if the client is closed. */
	get lcuPort(): number | null {
		return this.#lcuPort
	}

	/** Cheap preflight: is a bridge even possible on this machine? */
	static async available(nodeExe?: string): Promise<boolean> {
		return (await findWindowsNode(nodeExe)) !== null
	}

	async start(): Promise<void> {
		if (this.#state === "ready") return
		this.#stopping = false
		if (this.#starting) return this.#starting
		this.#starting = this.#spawn().finally(() => {
			this.#starting = null
		})
		return this.#starting
	}

	async stop(): Promise<void> {
		this.#stopping = true
		if (this.#restartTimer) {
			clearTimeout(this.#restartTimer)
			this.#restartTimer = null
		}
		const child = this.#child
		this.#child = null
		this.#rejectAllPending(new LcuTransportError("TRANSPORT_STOPPED", "bridge stopped"))
		if (child) {
			try {
				child.stdin.write(JSON.stringify({ cmd: "stop" }) + "\n")
			} catch {
				/* already gone */
			}
			await new Promise<void>(resolve => {
				const timer = setTimeout(() => {
					try {
						child.kill("SIGKILL")
					} catch {
						/* ignore */
					}
					resolve()
				}, 1000)
				child.once("exit", () => {
					clearTimeout(timer)
					resolve()
				})
			})
		}
		this.#setState("stopped")
	}

	async request(
		method: HttpMethod,
		requestPath: string,
		body?: unknown,
		opts?: RequestOptions
	): Promise<LcuResponse> {
		if (this.#stopping) throw new LcuTransportError("TRANSPORT_STOPPED", "bridge is stopping")
		if (!this.#child) {
			if (this.#state === "failed")
				throw new LcuTransportError("SPAWN_FAILED", "bridge failed to start; use the curl transport")
			await this.start()
		}
		const child = this.#child
		if (!child) throw new LcuTransportError("SPAWN_FAILED", "bridge is not running")

		const target = opts?.target ?? "lcu"
		const timeoutMs = timeoutFor(opts)
		let toFileWin: string | null = null
		if (opts?.toFile) {
			await fsp.mkdir(path.dirname(opts.toFile), { recursive: true })
			toFileWin = await winPath(opts.toFile)
		}

		const id = ++this.#seq
		const line =
			JSON.stringify({
				id,
				method,
				path: requestPath,
				target,
				body,
				headers: opts?.headers,
				binary: opts?.binary === true,
				toFile: toFileWin,
				// Let the Windows side give up slightly first so its error is the one we report.
				timeoutMs: Math.max(1000, timeoutMs - 500)
			}) + "\n"

		return new Promise<LcuResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id)
				reject(
					new LcuTransportError(
						"TIMEOUT",
						`${method} ${requestPath} timed out after ${timeoutMs}ms (bridge)`
					)
				)
			}, timeoutMs)
			if (timer.unref) timer.unref()
			this.#pending.set(id, {
				resolve,
				reject,
				timer,
				startedMs: Date.now(),
				method,
				path: requestPath,
				target,
				toFile: opts?.toFile ?? null
			})
			try {
				child.stdin.write(line)
			} catch (err) {
				clearTimeout(timer)
				this.#pending.delete(id)
				reject(new LcuTransportError("TRANSPORT_STOPPED", "bridge stdin is closed", err))
			}
		})
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

	async #spawn(): Promise<void> {
		this.#setState("starting")
		const nodeExe = await findWindowsNode(this.#opts.nodeExe)
		if (!nodeExe) {
			this.#setState("failed")
			throw new LcuTransportError(
				"NO_WIN_NODE",
				`no Windows node.exe found (looked at ${WIN_NODE_CANDIDATES.join(", ")}); set CSK_WIN_NODE or use the curl transport`
			)
		}

		const scriptWsl = fileURLToPath(new URL("./bridge/bridge.mjs", import.meta.url))
		const scriptWin = await winPath(scriptWsl)
		const lockWin = await winPath(this.#opts.lockfilePath ?? LOCKFILE_PATH)
		const topics = (this.#opts.topics ?? DEFAULT_LCU_TOPICS).join(",")

		// Configuration goes on ARGV, not in `env`: WSL does not propagate environment
		// variables into a Windows process unless they are named in WSLENV (verified —
		// `FOO=bar node.exe -e "process.env.FOO"` is `undefined`). Argv always crosses.
		const args = [
			scriptWin,
			"--lockfile",
			lockWin,
			"--topics",
			topics,
			"--live-port",
			String(LIVE_CLIENT_PORT)
		]
		if (process.env.EEPALYTICS_BRIDGE_DEBUG === "1") args.push("--debug")

		let child: ChildProcessWithoutNullStreams
		try {
			child = spawn(nodeExe, args, {
				stdio: ["pipe", "pipe", "pipe"]
			}) as ChildProcessWithoutNullStreams
		} catch (err) {
			this.#setState("failed")
			throw new LcuTransportError("SPAWN_FAILED", `could not spawn ${nodeExe}`, err)
		}

		this.#child = child
		this.#spawnedMs = Date.now()

		child.stdout.setEncoding("utf8")
		const rl = readline.createInterface({ input: child.stdout })
		rl.on("line", line => this.#onLine(line))

		child.stderr.setEncoding("utf8")
		let stderrTail = ""
		child.stderr.on("data", (chunk: string) => {
			stderrTail = (stderrTail + chunk).slice(-2000)
			for (const line of chunk.split("\n")) if (line.trim()) this.#log(`[lcu-bridge] ${line}`)
		})

		const ready = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup()
				reject(
					new LcuTransportError(
						"SPAWN_FAILED",
						`bridge did not report ready within ${READY_TIMEOUT_MS}ms${stderrTail ? `: ${stderrTail.trim()}` : ""}`
					)
				)
			}, READY_TIMEOUT_MS)
			const onReady = (): void => {
				cleanup()
				resolve()
			}
			const onExit = (code: number | null): void => {
				cleanup()
				reject(
					new LcuTransportError(
						"SPAWN_FAILED",
						`bridge exited with code ${code}${stderrTail ? `: ${stderrTail.trim()}` : ""}`
					)
				)
			}
			const onSpawnError = (err: Error): void => {
				cleanup()
				reject(new LcuTransportError("SPAWN_FAILED", `bridge spawn error: ${err.message}`, err))
			}
			const cleanup = (): void => {
				clearTimeout(timer)
				this.off("bridge-ready", onReady)
				child.off("exit", onExit)
				child.off("error", onSpawnError)
			}
			this.once("bridge-ready", onReady)
			child.once("exit", onExit)
			child.once("error", onSpawnError)
		})

		child.on("error", err => this.#log(`[lcu-bridge] spawn error: ${err.message}`))
		child.on("exit", (code, signal) => this.#onExit(child, code, signal))

		await ready
		this.#setState("ready")
	}

	#onExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: string | null): void {
		if (this.#child !== child) return
		this.#child = null
		this.#lcuPort = null
		this.#rejectAllPending(
			new LcuTransportError("TRANSPORT_STOPPED", `bridge exited (code ${code}, signal ${signal})`)
		)
		if (this.#stopping) {
			this.#setState("stopped")
			return
		}
		if (Date.now() - this.#spawnedMs > HEALTHY_UPTIME_MS) this.#restarts = 0
		this.#restarts += 1
		if (this.#restarts > MAX_CONSECUTIVE_RESTARTS) {
			this.#setState("failed")
			this.emit(
				"error",
				new LcuTransportError(
					"SPAWN_FAILED",
					`bridge died ${this.#restarts} times in a row; giving up (fall back to curl)`
				)
			)
			return
		}
		this.#setState("degraded")
		const delay = Math.min(RESTART_BASE_MS * 2 ** (this.#restarts - 1), RESTART_MAX_MS)
		this.#log(`[lcu-bridge] respawning in ${delay}ms (attempt ${this.#restarts})`)
		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = null
			if (this.#stopping) return
			void this.#spawn().catch(err => {
				this.#log(`[lcu-bridge] respawn failed: ${String(err)}`)
			})
		}, delay)
		if (this.#restartTimer.unref) this.#restartTimer.unref()
	}

	#rejectAllPending(err: Error): void {
		for (const [, p] of this.#pending) {
			clearTimeout(p.timer)
			p.reject(err)
		}
		this.#pending.clear()
	}

	#onLine(line: string): void {
		if (!line.trim()) return
		let msg: Record<string, unknown>
		try {
			msg = JSON.parse(line) as Record<string, unknown>
		} catch {
			this.#log(`[lcu-bridge] unparseable line: ${line.slice(0, 200)}`)
			return
		}

		if (typeof msg.event === "string") {
			this.#onEvent(msg)
			return
		}
		if (typeof msg.id !== "number") return

		const pending = this.#pending.get(msg.id)
		if (!pending) return
		this.#pending.delete(msg.id)
		clearTimeout(pending.timer)
		const durationMs = Date.now() - pending.startedMs

		if (typeof msg.error === "string") {
			const code = msg.code === "NO_LOCKFILE" || msg.code === "CLIENT_CLOSED" ? msg.code : "PROTOCOL"
			pending.reject(
				new LcuTransportError(code, `${pending.method} ${pending.path}: ${msg.error}`)
			)
			return
		}

		const status = typeof msg.status === "number" ? msg.status : 0
		const bytes = typeof msg.bytes === "number" ? msg.bytes : 0
		let body = ""
		let buffer: Buffer | null = null
		if (typeof msg.body === "string") body = msg.body
		else if (typeof msg.b64 === "string") {
			buffer = Buffer.from(msg.b64, "base64")
			body = buffer.toString("utf8")
		}

		pending.resolve({
			status,
			body,
			buffer,
			bytes: bytes || Buffer.byteLength(body),
			file: typeof msg.file === "string" ? pending.toFile : null,
			durationMs,
			target: pending.target,
			method: pending.method,
			path: pending.path
		})
	}

	#onEvent(msg: Record<string, unknown>): void {
		switch (msg.event) {
			case "ready":
				this.#restarts = 0
				this.emit("bridge-ready", msg)
				return
			case "lockfile":
				this.#lcuPort = typeof msg.port === "number" ? msg.port : null
				this.emit("lockfile", { port: msg.port, pid: msg.pid, name: msg.name })
				if (this.#state !== "ready" && this.#child) this.#setState("ready")
				return
			case "lockfile-gone":
				this.#lcuPort = null
				this.emit("lockfile", null)
				return
			case "ws-open":
				this.emit("ws", "open")
				return
			case "ws-close":
				this.emit("ws", "close")
				return
			case "ws-error":
				this.emit("ws", "error")
				return
			case "lcu": {
				const event: LcuEventMessage = {
					topic: typeof msg.topic === "string" ? msg.topic : "OnJsonApiEvent",
					uri: typeof msg.uri === "string" ? msg.uri : "",
					eventType: typeof msg.eventType === "string" ? msg.eventType : "",
					data: msg.data,
					truncated: msg.truncated === true
				}
				this.emit("lcu-event", event)
				return
			}
			case "pong":
				this.emit("pong")
				return
			case "log":
				this.#log(`[lcu-bridge] ${String(msg.level)}: ${String(msg.message)}`)
				return
			default:
				return
		}
	}
}
