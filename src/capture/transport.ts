/**
 * Self-contained `curl.exe` transport for the capture unit.
 *
 * WSL2 cannot reach Windows' 127.0.0.1, so every League request has to be made by a
 * *Windows* process. This is the slow-but-always-works path (~88 ms per call, measured);
 * the bridge in `src/lcu/` is ~2.3 ms and should be preferred once it exists. Capture is
 * not latency-sensitive — a replay launch costs 15-30 s — so curl is a perfectly good
 * default here, and having it means the capture unit can be exercised standalone.
 *
 * Bodies go over stdin (`-d @-`) so no JSON ever passes through argv quoting.
 */

import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import {
	LCU_AUTH_USER,
	LIVE_CLIENT_ORIGIN,
	LOCKFILE_PATH,
	WIN_CURL
} from "../shared/constants.ts"
import type { CaptureClients, HttpClient, HttpMethod, RawReply } from "./types.ts"

/** `name:pid:PORT:PASSWORD:https`. The file has NO trailing newline. */
export interface Lockfile {
	name: string
	pid: number
	port: number
	password: string
	protocol: string
}

export const parseLockfile = (raw: string): Lockfile | null => {
	const parts = raw.trim().split(":")
	if (parts.length < 5) return null
	const [name, pid, port, password, protocol] = parts as [
		string,
		string,
		string,
		string,
		string
	]
	const portNum = Number(port)
	if (!Number.isFinite(portNum) || portNum <= 0) return null
	return {
		name,
		pid: Number(pid),
		port: portNum,
		password,
		protocol: protocol || "https"
	}
}

export const readLockfile = async (
	path: string = LOCKFILE_PATH
): Promise<Lockfile | null> => {
	try {
		return parseLockfile(await readFile(path, "utf8"))
	} catch {
		return null
	}
}

/** Marker appended by `-w` so we can recover the status code from stdout. */
const STATUS_MARKER = "\n__CSK_STATUS__"

export interface CurlOptions {
	timeoutMs?: number
	/** `riot:<password>`; omitted for the port-2999 client, which has no auth. */
	basicAuth?: string
}

/**
 * One `curl.exe` round trip. Resolves with whatever status came back (including 4xx/5xx);
 * rejects only when curl itself could not run or could not connect.
 */
export const curlRequest = async (
	url: string,
	method: HttpMethod,
	body: unknown,
	opts: CurlOptions = {}
): Promise<RawReply> => {
	const timeoutMs = opts.timeoutMs ?? 10_000
	const args = [
		"-s",
		"-k",
		"-m",
		String(Math.ceil(timeoutMs / 1000)),
		"-w",
		`${STATUS_MARKER}%{http_code}`,
		"-X",
		method
	]
	if (opts.basicAuth) args.push("-u", opts.basicAuth)
	const payload = body === undefined ? null : JSON.stringify(body)
	if (payload !== null) {
		args.push("-H", "Content-Type: application/json", "--data-binary", "@-")
	}
	args.push(url)

	return await new Promise<RawReply>((resolve, reject) => {
		const child = spawn(WIN_CURL, args, { stdio: ["pipe", "pipe", "pipe"] })
		let out = ""
		let err = ""
		const killTimer = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 2_000)
		child.stdout.setEncoding("utf8")
		child.stderr.setEncoding("utf8")
		child.stdout.on("data", (c: string) => {
			out += c
		})
		child.stderr.on("data", (c: string) => {
			err += c
		})
		child.on("error", e => {
			clearTimeout(killTimer)
			reject(new Error(`curl.exe could not run: ${(e as Error).message}`))
		})
		child.on("close", code => {
			clearTimeout(killTimer)
			const idx = out.lastIndexOf(STATUS_MARKER)
			if (idx === -1) {
				reject(
					new Error(
						`curl.exe exited ${code} without a status (${err.trim() || "no stderr"})`
					)
				)
				return
			}
			const status = Number(out.slice(idx + STATUS_MARKER.length).trim())
			resolve({ status: Number.isFinite(status) ? status : 0, body: out.slice(0, idx) })
		})
		if (payload !== null) child.stdin.end(payload)
		else child.stdin.end()
	})
}

/** An `HttpClient` for the game process on :2999 (no auth). */
export const gameClient = (
	origin: string = LIVE_CLIENT_ORIGIN,
	timeoutMs = 10_000
): HttpClient => ({
	request: (method, path, body) =>
		curlRequest(`${origin}${path}`, method, body, { timeoutMs })
})

/**
 * An `HttpClient` for the LCU. The lockfile is re-read on every request on purpose: the
 * port and password change when the client restarts, and a capture session outlives that.
 */
export const lcuClient = (
	lockfilePath: string = LOCKFILE_PATH,
	timeoutMs = 10_000
): HttpClient => ({
	request: async (method, path, body) => {
		const lock = await readLockfile(lockfilePath)
		if (!lock) throw new Error(`lockfile unreadable at ${lockfilePath} (client closed?)`)
		return await curlRequest(
			`${lock.protocol}://127.0.0.1:${lock.port}${path}`,
			method,
			body,
			{ timeoutMs, basicAuth: `${LCU_AUTH_USER}:${lock.password}` }
		)
	}
})

export const curlClients = (): CaptureClients => ({
	lcu: lcuClient(),
	game: gameClient()
})

/* ================================================================ helpers */

/** Parse a JSON body, or null. Replay API bodies are small and always JSON. */
export const jsonOf = <T>(reply: RawReply): T | null => {
	if (!reply.body) return null
	try {
		return JSON.parse(reply.body) as T
	} catch {
		return null
	}
}

export const okJson = <T>(reply: RawReply): T | null =>
	reply.status >= 200 && reply.status < 300 ? jsonOf<T>(reply) : null
