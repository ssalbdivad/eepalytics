/**
 * eepalytics LCU bridge — THIS FILE RUNS ON WINDOWS `node.exe`, NOT WSL NODE.
 *
 * WSL2 cannot reach Windows' loopback, so a Windows-side process has to perform every League
 * request for us. Spawning `curl.exe` per request costs ~88 ms (Windows process creation
 * dominates); keeping one Node process alive with a keep-alive HTTPS agent costs a measured
 * **p50 of 2.3 ms** round trip through stdio. That 38x is the entire reason this file exists.
 *
 * It is deliberately dependency-free and conservative about syntax so it runs on whatever
 * Node the user happens to have on Windows. If Windows has no Node at all, nothing here is
 * used and `curl-fallback.ts` takes over.
 *
 * ## Protocol — NDJSON, one JSON object per line
 *
 * stdin (requests):
 *   {id, method?, path, body?, target?: "lcu"|"live", headers?, toFile?, binary?, timeoutMs?}
 *   {cmd: "ping"} | {cmd: "stop"} | {cmd: "lockfile"}
 *
 * stdout (responses, correlated by `id`):
 *   {id, status, body}                     text response
 *   {id, status, b64, bytes}               binary response (binary: true)
 *   {id, status, file, bytes}              streamed to disk (toFile)
 *   {id, error, code}                      transport failure, no HTTP happened
 *
 * stdout (unsolicited events):
 *   {event:"ready", node, pid}
 *   {event:"lockfile", port, pid, name} | {event:"lockfile-gone"}
 *   {event:"ws-open", port} | {event:"ws-close"} | {event:"ws-error", message}
 *   {event:"lcu", uri, eventType, data}    an LCU WAMP event
 *   {event:"pong"} | {event:"log", level, message}
 *
 * Nothing but NDJSON may ever reach stdout — a stray `console.log` corrupts the stream.
 * Diagnostics go to stderr, which the client mirrors into its own log.
 */

import fs from "node:fs"
import path from "node:path"
import https from "node:https"
import crypto from "node:crypto"
import readline from "node:readline"

/**
 * Configuration arrives on ARGV, not in the environment.
 *
 * WSL does NOT propagate arbitrary environment variables into a Windows process — verified on
 * this machine: `FOO=bar node.exe -e "console.log(process.env.FOO)"` prints `undefined`. Only
 * variables named in `WSLENV` cross the boundary. Argv always crosses, so that is what we use.
 * The env names are still honoured as a fallback for running this file by hand on Windows.
 * (The lockfile PATH is not a secret; the password never appears in argv or the environment.)
 */
const argv = process.argv.slice(2)
const argOf = name => {
	const i = argv.indexOf("--" + name)
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}

const LOCKFILE =
	argOf("lockfile") || process.env.CSK_LOCKFILE || "C:/Games/Riot Games/League of Legends/lockfile"
const LIVE_PORT = Number(argOf("live-port") || process.env.CSK_LIVE_PORT || 2999)
/**
 * Subscribing to the wildcard `OnJsonApiEvent` works but delivers everything the client does.
 * The client passes the handful of resources this app reacts to via `--topics`.
 */
const TOPICS = (argOf("topics") || process.env.CSK_LCU_TOPICS || "OnJsonApiEvent")
	.split(",")
	.map(s => s.trim())
	.filter(Boolean)

/** Drop websocket payloads larger than this rather than flooding the stdio pipe. */
const MAX_EVENT_BYTES = 256 * 1024
/** Refuse absurd websocket frames outright — a length field we cannot trust is a protocol bug. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

/** `CSK_BRIDGE_DEBUG=1` logs every websocket frame to stderr. Never enabled by default. */
const DEBUG = argv.includes("--debug") || process.env.CSK_BRIDGE_DEBUG === "1"

let lock = null // {name, pid, port, password, auth}
let lcuAgent = null
let stopping = false

const liveAgent = new https.Agent({
	keepAlive: true,
	rejectUnauthorized: false,
	maxSockets: 8
})

const say = obj => {
	try {
		process.stdout.write(JSON.stringify(obj) + "\n")
	} catch {
		/* stdout is gone; we are about to exit anyway */
	}
}

const log = (level, message) => {
	try {
		process.stderr.write(`[bridge:${level}] ${message}\n`)
	} catch {
		/* ignore */
	}
}

/* ------------------------------------------------------------- lockfile */

function loadLock() {
	let text
	try {
		text = fs.readFileSync(LOCKFILE, "utf8")
	} catch {
		if (lock) {
			lock = null
			if (lcuAgent) {
				lcuAgent.destroy()
				lcuAgent = null
			}
			closeWs()
			say({ event: "lockfile-gone" })
			return true
		}
		return false
	}
	const parts = String(text).trim().split(":")
	if (parts.length < 5) return false
	const port = Number(parts[2])
	const password = parts.slice(3, -1).join(":")
	if (!port || !password) return false
	if (lock && lock.port === port && lock.password === password) return false

	lock = {
		name: parts[0],
		pid: Number(parts[1]) || 0,
		port,
		password,
		auth: "Basic " + Buffer.from("riot:" + password).toString("base64")
	}
	if (lcuAgent) lcuAgent.destroy()
	lcuAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false, maxSockets: 16 })
	say({ event: "lockfile", port: lock.port, pid: lock.pid, name: lock.name })
	openWs()
	return true
}

/* ------------------------------------------------------------ websocket */

let ws = null
let wsRetry = null
let wsBackoff = 1000

function closeWs() {
	if (wsRetry) {
		clearTimeout(wsRetry)
		wsRetry = null
	}
	if (ws) {
		const sock = ws
		ws = null
		try {
			sock.destroy()
		} catch {
			/* ignore */
		}
	}
}

function scheduleWsRetry() {
	if (stopping || !lock || wsRetry) return
	wsRetry = setTimeout(() => {
		wsRetry = null
		openWs()
	}, wsBackoff)
	if (wsRetry.unref) wsRetry.unref()
	wsBackoff = Math.min(wsBackoff * 2, 30_000)
}

/**
 * The LCU speaks WAMP-ish JSON over a plain websocket at `wss://127.0.0.1:<port>/`, with the
 * same basic auth as the HTTP API. We perform RFC 6455 by hand rather than depending on the
 * global `WebSocket` (which needs a process-wide `NODE_TLS_REJECT_UNAUTHORIZED=0`, and does
 * not exist before Node 22). `https.request` + the `upgrade` event gives us a raw socket with
 * per-connection TLS settings, which is both safer and more portable.
 */
function openWs() {
	closeWs()
	if (stopping || !lock) return
	const active = lock
	const key = crypto.randomBytes(16).toString("base64")
	let req
	try {
		req = https.request({
			host: "127.0.0.1",
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
	} catch (err) {
		say({ event: "ws-error", message: String(err && err.message) })
		scheduleWsRetry()
		return
	}

	req.on("upgrade", (res, socket, head) => {
		const expected = crypto
			.createHash("sha1")
			.update(key + WS_GUID)
			.digest("base64")
		if (res.headers["sec-websocket-accept"] !== expected) {
			say({ event: "ws-error", message: "bad Sec-WebSocket-Accept" })
			try {
				socket.destroy()
			} catch {
				/* ignore */
			}
			scheduleWsRetry()
			return
		}
		if (lock !== active) {
			try {
				socket.destroy()
			} catch {
				/* ignore */
			}
			return
		}
		ws = socket
		wsBackoff = 1000
		try {
			socket.setNoDelay(true)
		} catch {
			/* ignore */
		}
		attachFrames(socket, head)
		for (const topic of TOPICS) sendFrame(socket, 0x1, Buffer.from(JSON.stringify([5, topic])))
		say({ event: "ws-open", port: active.port })
	})

	req.on("response", res => {
		res.resume()
		say({ event: "ws-error", message: "upgrade refused, HTTP " + res.statusCode })
		scheduleWsRetry()
	})
	req.on("error", err => {
		say({ event: "ws-error", message: String(err && err.message) })
		scheduleWsRetry()
	})
	req.end()
}

function attachFrames(socket, head) {
	let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0)
	let fragOpcode = 0
	let frags = []

	const onClosed = () => {
		if (ws === socket) {
			ws = null
			say({ event: "ws-close" })
			scheduleWsRetry()
		}
	}

	socket.on("data", chunk => {
		buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
		for (;;) {
			let frame
			try {
				frame = readFrame(buf)
			} catch (err) {
				say({ event: "ws-error", message: String(err && err.message) })
				socket.destroy()
				return
			}
			if (!frame) return
			buf = buf.subarray(frame.consumed)

			const op = frame.opcode
			if (op === 0x8) {
				sendFrame(socket, 0x8, Buffer.alloc(0))
				socket.destroy()
				return
			}
			if (op === 0x9) {
				sendFrame(socket, 0xa, frame.payload)
				continue
			}
			if (op === 0xa) continue

			if (op === 0x0) {
				frags.push(frame.payload)
			} else {
				fragOpcode = op
				frags = [frame.payload]
			}
			if (!frame.fin) continue

			const payload = frags.length === 1 ? frags[0] : Buffer.concat(frags)
			frags = []
			if (fragOpcode === 0x1 || fragOpcode === 0x2) onWsMessage(payload)
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
function onWsMessage(payload) {
	if (DEBUG) log("debug", "ws frame, " + (payload ? payload.length : 0) + " bytes")
	if (!payload || payload.length === 0) return
	let parsed
	try {
		parsed = JSON.parse(payload.toString("utf8"))
	} catch {
		return
	}
	// [8, "<topic>", {uri, eventType, data}]
	if (!Array.isArray(parsed) || parsed.length < 3) return
	const topic = parsed[1]
	const body = parsed[2]
	if (!body || typeof body !== "object") return
	if (payload.length > MAX_EVENT_BYTES) {
		say({ event: "lcu", topic, uri: body.uri, eventType: body.eventType, data: null, truncated: true })
		return
	}
	say({ event: "lcu", topic, uri: body.uri, eventType: body.eventType, data: body.data })
}

function readFrame(b) {
	if (b.length < 2) return null
	const fin = (b[0] & 0x80) !== 0
	const opcode = b[0] & 0x0f
	const masked = (b[1] & 0x80) !== 0
	let len = b[1] & 0x7f
	let off = 2
	if (len === 126) {
		if (b.length < 4) return null
		len = b.readUInt16BE(2)
		off = 4
	} else if (len === 127) {
		if (b.length < 10) return null
		const big = b.readBigUInt64BE(2)
		if (big > BigInt(MAX_FRAME_BYTES)) throw new Error("websocket frame too large: " + big)
		len = Number(big)
		off = 10
	}
	let mask = null
	if (masked) {
		if (b.length < off + 4) return null
		mask = b.subarray(off, off + 4)
		off += 4
	}
	if (b.length < off + len) return null
	let payload = b.subarray(off, off + len)
	if (mask) {
		const copy = Buffer.from(payload)
		for (let i = 0; i < copy.length; i++) copy[i] ^= mask[i % 4]
		payload = copy
	}
	return { fin, opcode, payload, consumed: off + len }
}

/** Client-to-server frames MUST be masked (RFC 6455 §5.3). */
function sendFrame(socket, opcode, payload) {
	const len = payload.length
	let header
	if (len < 126) {
		header = Buffer.alloc(2)
		header[1] = 0x80 | len
	} else if (len < 65536) {
		header = Buffer.alloc(4)
		header[1] = 0x80 | 126
		header.writeUInt16BE(len, 2)
	} else {
		header = Buffer.alloc(10)
		header[1] = 0x80 | 127
		header.writeBigUInt64BE(BigInt(len), 2)
	}
	header[0] = 0x80 | opcode
	const mask = crypto.randomBytes(4)
	const masked = Buffer.from(payload)
	for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
	try {
		socket.write(Buffer.concat([header, mask, masked]))
	} catch {
		/* socket died mid-write; the close handler will retry */
	}
}

/* ----------------------------------------------------------------- HTTP */

function handleRequest(msg, isRetry) {
	const id = msg.id
	const target = msg.target === "live" ? "live" : "lcu"
	const method = msg.method || "GET"
	const headers = Object.assign({ Accept: "application/json" }, msg.headers || {})

	let port
	let agent
	if (target === "live") {
		port = LIVE_PORT
		agent = liveAgent
	} else {
		if (!lock) {
			try {
				loadLock()
			} catch {
				/* reported below */
			}
		}
		if (!lock) {
			say({ id, error: "league client is not running (no lockfile)", code: "NO_LOCKFILE" })
			return
		}
		port = lock.port
		agent = lcuAgent
		headers.Authorization = lock.auth
	}

	let payload = null
	if (msg.body !== undefined && msg.body !== null) {
		payload = Buffer.from(typeof msg.body === "string" ? msg.body : JSON.stringify(msg.body), "utf8")
		headers["Content-Type"] = headers["Content-Type"] || "application/json"
		headers["Content-Length"] = String(payload.length)
	}

	let settled = false
	const fail = (message, code) => {
		if (settled) return
		settled = true
		say({ id, error: message, code: code || "REQUEST_FAILED" })
	}

	let req
	try {
		req = https.request({
			host: "127.0.0.1",
			port,
			path: msg.path,
			method,
			agent,
			rejectUnauthorized: false,
			headers
		})
	} catch (err) {
		fail(String(err && err.message), "REQUEST_FAILED")
		return
	}

	req.setTimeout(msg.timeoutMs || 15000, () => {
		req.destroy(new Error("timed out after " + (msg.timeoutMs || 15000) + "ms"))
	})

	req.on("error", err => {
		const code = err && err.code === "ECONNREFUSED" ? "CLIENT_CLOSED" : "REQUEST_FAILED"
		fail(String(err && err.message), code)
	})

	req.on("response", res => {
		// A 401 means the client restarted and rotated its password. Re-read the lockfile and
		// retry exactly once, so a restart costs one wasted request instead of an outage.
		if (res.statusCode === 401 && target === "lcu" && !isRetry) {
			let changed = false
			try {
				changed = loadLock()
			} catch {
				/* fall through and report the 401 as-is */
			}
			if (changed && lock) {
				settled = true
				res.resume()
				handleRequest(msg, true)
				return
			}
		}

		if (msg.toFile) {
			let bytes = 0
			let out
			try {
				fs.mkdirSync(path.dirname(msg.toFile), { recursive: true })
				out = fs.createWriteStream(msg.toFile)
			} catch (err) {
				res.resume()
				fail(String(err && err.message), "FILE_FAILED")
				return
			}
			res.on("data", c => {
				bytes += c.length
			})
			res.pipe(out)
			out.on("error", err => fail(String(err && err.message), "FILE_FAILED"))
			out.on("close", () => {
				if (settled) return
				settled = true
				say({ id, status: res.statusCode, file: msg.toFile, bytes })
			})
			return
		}

		const chunks = []
		res.on("data", c => chunks.push(c))
		res.on("error", err => fail(String(err && err.message), "REQUEST_FAILED"))
		res.on("end", () => {
			if (settled) return
			settled = true
			const buf = Buffer.concat(chunks)
			if (msg.binary) say({ id, status: res.statusCode, b64: buf.toString("base64"), bytes: buf.length })
			else say({ id, status: res.statusCode, body: buf.toString("utf8") })
		})
	})

	if (payload) req.write(payload)
	req.end()
}

/* ------------------------------------------------------------ lifecycle */

function shutdown(code) {
	stopping = true
	closeWs()
	try {
		if (lcuAgent) lcuAgent.destroy()
		liveAgent.destroy()
	} catch {
		/* ignore */
	}
	process.exit(code || 0)
}

process.on("uncaughtException", err => {
	log("fatal", String((err && err.stack) || err))
	say({ event: "log", level: "fatal", message: String(err && err.message) })
	shutdown(1)
})
process.on("unhandledRejection", err => {
	log("error", "unhandled rejection: " + String(err))
})

try {
	loadLock()
} catch (err) {
	log("warn", "initial lockfile read failed: " + String(err && err.message))
}

// `fs.watch` works here because this process is native Windows on NTFS. It emphatically does
// NOT work from WSL over /mnt/c (verified: zero events from either side of the boundary).
// Watch the DIRECTORY, because the client deletes and recreates the file rather than editing it.
try {
	fs.watch(path.dirname(LOCKFILE), (_evt, name) => {
		if (!name || String(name).toLowerCase() === path.basename(LOCKFILE).toLowerCase()) {
			try {
				loadLock()
			} catch {
				/* the 5 s poll below is the backstop */
			}
		}
	})
} catch (err) {
	log("warn", "fs.watch on the lockfile directory failed: " + String(err && err.message))
}

const poll = setInterval(() => {
	try {
		loadLock()
	} catch {
		/* ignore */
	}
}, 5000)
if (poll.unref) poll.unref()

// Keep the websocket honest: a dead TLS socket can look open for minutes otherwise.
const ping = setInterval(() => {
	if (ws) sendFrame(ws, 0x9, Buffer.alloc(0))
}, 45_000)
if (ping.unref) ping.unref()

const rl = readline.createInterface({ input: process.stdin })
rl.on("line", line => {
	const text = line.trim()
	if (!text) return
	let msg
	try {
		msg = JSON.parse(text)
	} catch (err) {
		log("warn", "unparseable stdin line: " + String(err && err.message))
		return
	}
	if (msg.cmd === "stop") return shutdown(0)
	if (msg.cmd === "ping") return say({ event: "pong" })
	if (msg.cmd === "lockfile") {
		return say(
			lock ?
				{ event: "lockfile", port: lock.port, pid: lock.pid, name: lock.name }
			:	{ event: "lockfile-gone" }
		)
	}
	if (typeof msg.id !== "number" || typeof msg.path !== "string") {
		log("warn", "ignoring malformed request")
		return
	}
	try {
		handleRequest(msg, false)
	} catch (err) {
		say({ id: msg.id, error: String(err && err.message), code: "REQUEST_FAILED" })
	}
})
rl.on("close", () => shutdown(0))

say({ event: "ready", node: process.version, pid: process.pid })
