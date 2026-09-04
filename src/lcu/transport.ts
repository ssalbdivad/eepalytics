/**
 * The transport contract shared by every way we can reach a League HTTP API.
 *
 * ## Why this layer exists at all
 * WSL2 here runs in NAT networking mode, so WSL's `127.0.0.1` is NOT Windows'
 * `127.0.0.1`. Native `fetch`/`curl` from Linux to the LCU port or to the in-game API on
 * 2999 returns HTTP 000 / ECONNREFUSED — verified, twice, in `.research/lcu-api.md` §7.1 and
 * `.research/replay-capture.md` §1.1. **Every** League request must be performed by a
 * *Windows* process reached through WSL interop.
 *
 * ...on THIS machine. That constraint is a property of WSL2's NAT networking, not of League:
 * on a native Windows install — which is how this ships to anyone who has never opened WSL —
 * this process's `127.0.0.1` IS the client's, and the interop transports cannot run at all
 * (there is no `wslpath` and no `/mnt/c/...curl.exe`).
 *
 * Three implementations satisfy this interface:
 *   - `LcuBridge`  (`bridge-client.ts`) — a long-lived Windows `node.exe` speaking NDJSON over
 *     stdio. Measured p50 **2.3 ms** per round trip. Also holds the LCU WAMP websocket open.
 *   - `LcuCurl`    (`curl-fallback.ts`) — one `curl.exe -K -` per request, ~88 ms. No events.
 *   - `LcuDirect`  (`direct.ts`) — `node:https` straight at the loopback. No process to spawn,
 *     so it is the fastest of the three, and it holds the WAMP websocket too. Only usable
 *     where the loopback actually reaches the client.
 *
 * `createLcu()` in `index.ts` picks between them with evidence rather than a platform string —
 * see `select.ts` and `environment.ts`.
 *
 * ## Status codes are DATA, not errors
 * `request()` resolves for every HTTP status. 404 is a legitimate state all over this API
 * ("no local replay metadata yet", "not in champ select", "that gameId does not exist"), and
 * 401 means the client restarted rather than that we did something wrong. Only genuine
 * transport failures reject, and they reject with a typed `LcuTransportError`.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

/** `lcu` = the lockfile port (basic auth). `live` = the game process on 2999 (no auth). */
export type LcuTarget = "lcu" | "live"

export type TransportKind = "bridge" | "curl" | "direct"

/**
 * `degraded` means "the transport is alive but the League client is not reachable right now"
 * — a normal, expected state whenever the user has the client closed.
 * `failed` means the transport itself could not be established (no node.exe, spawn loop).
 */
export type TransportState = "stopped" | "starting" | "ready" | "degraded" | "failed"

export interface RequestOptions {
	/** Default `"lcu"`. */
	target?: LcuTarget
	/** Default 15 s (60 s when `toFile` is set). */
	timeoutMs?: number
	/**
	 * Stream the response body straight to this **WSL** path instead of buffering it.
	 * The transport translates it with `wslpath -w` and creates the parent directory.
	 * NOTE: writing across the 9p boundary is ~4x slower than writing to a native Windows
	 * path (measured in `lcu-api.md` §7.2) — fine for icons, avoid it in a hot loop.
	 */
	toFile?: string
	/** Return `body` as a Buffer too. Required for icons/PNGs — UTF-8 would mangle them. */
	binary?: boolean
	/** Extra request headers. `Authorization` is supplied by the transport and wins. */
	headers?: Record<string, string>
}

export interface LcuResponse {
	status: number
	/** UTF-8 body. Empty string when `toFile` was used or the response had no body. */
	body: string
	/** Only populated when `binary: true` was requested. */
	buffer: Buffer | null
	bytes: number
	/** The WSL path written, when `toFile` was used. */
	file: string | null
	durationMs: number
	target: LcuTarget
	method: HttpMethod
	path: string
}

/** One LCU websocket event, forwarded from the bridge. Shape: `[8, topic, {uri,eventType,data}]`. */
export interface LcuEventMessage {
	/** The WAMP topic it arrived on — in practice always `OnJsonApiEvent`. Filter on `uri`. */
	topic: string
	/** The resource that changed, e.g. `/lol-gameflow/v1/gameflow-phase`. */
	uri: string
	/** `Create` | `Update` | `Delete`. */
	eventType: string
	/** The new resource body. */
	data: unknown
	/** True when the payload was too large to forward and `data` was dropped. */
	truncated?: boolean
}

export type TransportErrorCode =
	| "NO_LOCKFILE"
	| "CLIENT_CLOSED"
	| "TIMEOUT"
	| "SPAWN_FAILED"
	| "NO_WIN_NODE"
	| "TRANSPORT_STOPPED"
	| "PROTOCOL"
	| "PATH"
	| "CURL_FAILED"
	/** A socket error from `LcuDirect` that is not a refusal or a timeout (TLS, EPIPE, ...). */
	| "DIRECT_FAILED"

/** A transport-level failure: we never reached the API. Distinct from an HTTP status. */
export class LcuTransportError extends Error {
	readonly code: TransportErrorCode
	readonly cause?: unknown

	constructor(code: TransportErrorCode, message: string, cause?: unknown) {
		super(message)
		this.name = "LcuTransportError"
		this.code = code
		this.cause = cause
	}
}

/** An unexpected HTTP status from a call that required success. Thrown by `expectOk`. */
export class LcuHttpError extends Error {
	readonly status: number
	readonly method: HttpMethod
	readonly path: string
	readonly target: LcuTarget
	readonly bodyText: string
	readonly errorCode: string | null

	constructor(res: LcuResponse, context: string) {
		const snippet = res.body.length > 400 ? `${res.body.slice(0, 400)}…` : res.body
		super(`${context}: HTTP ${res.status} ${res.method} ${res.path}${snippet ? ` — ${snippet}` : ""}`)
		this.name = "LcuHttpError"
		this.status = res.status
		this.method = res.method
		this.path = res.path
		this.target = res.target
		this.bodyText = res.body
		this.errorCode = readErrorCode(res.body)
	}
}

const readErrorCode = (body: string): string | null => {
	if (!body.startsWith("{")) return null
	try {
		const parsed: unknown = JSON.parse(body)
		if (parsed && typeof parsed === "object" && "errorCode" in parsed) {
			const code = (parsed as { errorCode?: unknown }).errorCode
			return typeof code === "string" ? code : null
		}
	} catch {
		/* not JSON — no code to report */
	}
	return null
}

export const isOk = (res: LcuResponse): boolean => res.status >= 200 && res.status < 300

/** Throw an `LcuHttpError` unless the status is 2xx. Returns the response for chaining. */
export const expectOk = (res: LcuResponse, context: string): LcuResponse => {
	if (!isOk(res)) throw new LcuHttpError(res, context)
	return res
}

/** Parse a JSON body, or throw with the context and a body snippet. */
export const jsonOf = (res: LcuResponse, context: string): unknown => {
	if (res.body === "") return null
	try {
		return JSON.parse(res.body) as unknown
	} catch (err) {
		const snippet = res.body.length > 200 ? `${res.body.slice(0, 200)}…` : res.body
		throw new LcuTransportError(
			"PROTOCOL",
			`${context}: response was not JSON (HTTP ${res.status}) — ${snippet}`,
			err
		)
	}
}

/** True when the failure means "the League client is not running", not "we are broken". */
export const isClientClosed = (err: unknown): boolean =>
	err instanceof LcuTransportError &&
	(err.code === "NO_LOCKFILE" || err.code === "CLIENT_CLOSED")

/**
 * Every transport implements this. Both concrete classes also extend `EventEmitter`, so the
 * listener methods below are satisfied structurally.
 */
export interface LcuTransport {
	readonly kind: TransportKind
	readonly state: TransportState
	start(): Promise<void>
	stop(): Promise<void>
	request(
		method: HttpMethod,
		path: string,
		body?: unknown,
		opts?: RequestOptions
	): Promise<LcuResponse>
	on(event: "lcu-event", cb: (e: LcuEventMessage) => void): this
	on(event: "state", cb: (s: TransportState) => void): this
	on(event: "error", cb: (err: Error) => void): this
	/**
	 * Catch-all for the transport-specific events (`lockfile`, `ws`, `pong`, `bridge-ready`).
	 * It has to be `any[]` rather than `never[]`: `EventEmitter.on` is declared with
	 * `(...args: any[])`, and a `never[]` catch-all here makes the concrete classes fail to
	 * satisfy the interface.
	 */
	on(event: string, cb: (...args: any[]) => void): this
	off(event: string, cb: (...args: any[]) => void): this
}

/* ------------------------------------------------------------------ paths */

const winPathCache = new Map<string, string>()

/**
 * `/home/ssalb/x` -> `\\wsl.localhost\...\home\ssalb\x`; `/mnt/c/y` -> `C:\y`.
 *
 * Every path handed to a Windows process must go through this. `wslpath` is pure string
 * translation, so it works for files that do not exist yet.
 */
export const winPath = async (wslPath: string): Promise<string> => {
	const cached = winPathCache.get(wslPath)
	if (cached !== undefined) return cached
	try {
		const { stdout } = await execFileAsync("wslpath", ["-w", wslPath])
		const out = stdout.trim()
		if (!out) throw new Error("wslpath returned nothing")
		winPathCache.set(wslPath, out)
		return out
	} catch (err) {
		throw new LcuTransportError("PATH", `cannot translate ${wslPath} to a Windows path`, err)
	}
}

/** The inverse, for reading back files a Windows process wrote. */
export const wslPathOf = async (windowsPath: string): Promise<string> => {
	try {
		const { stdout } = await execFileAsync("wslpath", ["-u", windowsPath])
		return stdout.trim()
	} catch (err) {
		throw new LcuTransportError("PATH", `cannot translate ${windowsPath} to a WSL path`, err)
	}
}

/** Default per-request timeouts. A `toFile` download gets a longer leash. */
export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_FILE_TIMEOUT_MS = 60_000

export const timeoutFor = (opts?: RequestOptions): number =>
	opts?.timeoutMs ?? (opts?.toFile ? DEFAULT_FILE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)
