/**
 * `LcuDirect` against a real HTTPS server holding a real self-signed certificate.
 *
 * A fake that just resolved objects would prove nothing here: every interesting property of
 * this transport is a property of the *socket* — that the self-signed certificate is accepted
 * without touching the process-wide TLS switch, that basic auth from the lockfile reaches the
 * server, that a refused connection rejects while a 404 resolves, and that the websocket
 * handshake is well-formed enough for a peer to accept it. So the tests stand up a server with
 * the same shape as the LCU (self-signed cert, HTTP basic auth, a WAMP-ish websocket on `/`)
 * and drive the shipped code against it.
 *
 * The key and certificate below are a throwaway generated for this file. They are a test
 * fixture, not a credential: they secure nothing, they are checked in on purpose, and they are
 * only ever presented on an ephemeral loopback port by this test.
 */

import { ok, rejects, strictEqual } from "node:assert/strict"
import { once } from "node:events"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import https from "node:https"
import type { Server } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import { authHeader } from "./lockfile.ts"
import { LcuDirect, probeDirect } from "./direct.ts"
import { LcuTransportError } from "./transport.ts"
import { WS_OPCODE, acceptKeyFor, encodeFrame, readFrame } from "./ws-frames.ts"

const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDKcSjc3AASyYzp
KBP4Nj3/xX3sImo0IQMm9GrHPY6gY/1vWdIYHkfnjElN6nagmQg+9GOpSFrFMOBc
D4a2VY7/E8uIEawrRAdGgY7KqanBp8CfSM71SL/BMeopJNLm1vzn1M96yEGmvJXq
zuUt7ARnUVgg7+7B/++F0piwC/BQDS7gUD+rZ3xE/VPZGgv6GNhv35dKErwXa5HX
GQ/WNi0qLP4KVViMCdGI3ldlCKjka0mLa0KWGI9JP/MrmnDUOdYgaLttt9yAlfDl
RzP7FYXDcFJnSgy0EqURHe/ynlHZcFvIS4KGWTcSTZoC2yt0/zKb0QQSD847UxXY
6w9Rz7FzAgMBAAECggEAOD54O+RjoNSecajQ44UudIFKGvD00MbbOVdu0ywnFCiz
oNwzor/G+m3fb+ZUTwo1YEhF6CJSFbcennUx2DatI/E7+vHuA5dC7jPQmD3LDCKv
QZHY7gzoOaTEienRLpFMcpyNiG9azhhXDoWs5rVMA+h1s7D1hLC2u1dnVIH8okCI
4vc6M3TrNB8dhFyh3fdN9qmWxpv3PPFoszKKXd3BTtWo1lCjKg2qfoFIGupzXDIJ
2I0VH4aS7agTz3SJEIzxW51voXbIuDm+tcsNwLY66FhE/OLm1frMrR0NvRR1TNzF
y+hqQTknMrMZ95NiXeffTKmyjblzAOVE30oK0uQpAQKBgQDgflZSMGMPMj6Y6syS
+wpAfw/JgmIOEavB0q15ezSN6UPdRuukXvqWVJbgT/kqdJRb8Ly9dCidy2n1hK+H
uHVidmHJcH0xA/obG03yGZZlht5XIGxwA1osW1I50ZgIWInBGSmqWFwG4BbfMPeX
7i+KVafNb78e8KHfH/xrIDvcnQKBgQDm2o0WuOSAStbHB5R4n1JczkmKg/CY+e4S
/Ungz2tc8IDdjt1sQ8S09ZNoSeOm1eTKXLis/1rDUOo3XB1n6YSJluw+Ci+6kp6p
eqbfonPwkOJUD92PSwR4JiMRF/7Ugf8WSbPBGT7BzRBPJAkBD+PxUi6flYyDR6bI
4TbvX0IBTwKBgBNNaZiphmrxFAbL8YkVwrzm7/GQn2O8SztgJQBUAqHNE8O77Fj2
va8dWNeyqKbo3TTGj0Pu7+sZaWPt47XUu2sa6K+MV4dWYzPfdiVB4/eY0BdHt2su
LpuvwnMsPVlCW53ZzwZRkKAatny8Vh2fIkFPuhzk5dcAM7reojKH0/3VAoGBANZq
Cz0dgW3/FLlLOwVFxTPZjciPfzo2eH8+rg2V2Tw7TRV7igDyeJMyvDTS3BSq+ZNS
x1w22FAsqT292roW1DkO6mE9CNObNq5m8vMnadP4XZ6CFeDvZjlKAqvvw4oRK6HB
1qj1D6rlEc7Pw2UvIyGSmSczuYx9UlWliGaP7ThVAoGBAKzNeRaXHGVINUeca3za
nenECzZOboGoSp4IIY5XBPfaWu8le9Cw1CHq0EV+xUMgr60Sl8/5yngCNXOnMpTM
4mryViwFvOXTFlUHnhPYqS4O+yUtcD+660owS4IGBGTDKHFjdjtWQbc96ToD3ffV
X2GRF6MvBpalvMtwMPQTHRrA
-----END PRIVATE KEY-----
`

const CERT = `-----BEGIN CERTIFICATE-----
MIIDHDCCAgSgAwIBAgIUFqR+FsWQoPP4OjJ5H9N1v564TJYwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MDkwNDE3MjcxOVoYDzIxMjYw
ODExMTcyNzE5WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDKcSjc3AASyYzpKBP4Nj3/xX3sImo0IQMm9GrHPY6g
Y/1vWdIYHkfnjElN6nagmQg+9GOpSFrFMOBcD4a2VY7/E8uIEawrRAdGgY7KqanB
p8CfSM71SL/BMeopJNLm1vzn1M96yEGmvJXqzuUt7ARnUVgg7+7B/++F0piwC/BQ
DS7gUD+rZ3xE/VPZGgv6GNhv35dKErwXa5HXGQ/WNi0qLP4KVViMCdGI3ldlCKjk
a0mLa0KWGI9JP/MrmnDUOdYgaLttt9yAlfDlRzP7FYXDcFJnSgy0EqURHe/ynlHZ
cFvIS4KGWTcSTZoC2yt0/zKb0QQSD847UxXY6w9Rz7FzAgMBAAGjZDBiMB0GA1Ud
DgQWBBTqMYha5C8V9VEoOaZALdOkNKgIKTAfBgNVHSMEGDAWgBTqMYha5C8V9VEo
OaZALdOkNKgIKTAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQIMAaHBH8AAAEwDQYJ
KoZIhvcNAQELBQADggEBAAzUxc6h9UbVtdpYWCSViy3c0lah4m96ZO93bUpUhFEf
CFqO5AA/EZRIKNOWvUbEbyQknsiseT1JxRCThw66zZiPaT6RsxGyGeyzcu3PX2SZ
C9eVMdshEGYz9QzYxuq5U47ySBW6gAmTdS6oelSTQtzrV8TLEoz8A8IYvwwzr7mE
PpG9ybQn6fPNCJ0JDLYNKTmuWBoyoXoPkghhpKhJ+Uog44HhoSnAV0csDU0QrQo/
5DU7EV9/Tl1aLV7bT2ZeV3zdeg/58bL9K9OUOpLsKzL1t4RJ45wpF60bT+VzheHo
HTWGzEysl7ZZH75fe0ErB9rYKHsqZhKGA6EHR30Byf8=
-----END CERTIFICATE-----
`

/** The 512 bytes we use to prove a binary body survives, and that UTF-8 would have mangled it. */
const ICON = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256))

interface Seen {
	method: string
	url: string
	auth: string | undefined
	contentType: string | undefined
	body: string
}

const dir = mkdtempSync(join(tmpdir(), "eepalytics-direct-"))
const lockfilePath = join(dir, "lockfile")
const writeLock = (port: number, password: string): void =>
	writeFileSync(lockfilePath, `LeagueClient:4242:${port}:${password}:https`)

let server: Server
let port = 0
const seen: Seen[] = []
/** The password the fake client currently accepts. Rotated mid-test, like a real restart. */
let password = "first-password"
/** Subscribe frames the fake client received on the websocket. */
const subscribes: string[] = []

before(async () => {
	server = https.createServer({ key: KEY, cert: CERT }, (req, res) => {
		const chunks: Buffer[] = []
		req.on("data", (c: Buffer) => chunks.push(c))
		req.on("end", () => {
			seen.push({
				method: req.method ?? "",
				url: req.url ?? "",
				auth: req.headers.authorization,
				contentType: req.headers["content-type"],
				body: Buffer.concat(chunks).toString("utf8")
			})
			const url = req.url ?? ""

			if (url === "/hang") return // never answers; the caller's timeout has to fire

			// Everything below /lol-* is authenticated, exactly like the client.
			if (url !== "/live-only" && req.headers.authorization !== authHeader(password)) {
				// The real client rotates its password on restart and the new one is in the
				// lockfile by the time the 401 comes back. Reproduce that here.
				password = "second-password"
				writeLock(port, password)
				res.writeHead(401).end('{"errorCode":"RPC_ERROR"}')
				return
			}
			if (url === "/icon.png") {
				res.writeHead(200, { "Content-Type": "image/png" }).end(ICON)
				return
			}
			if (url === "/missing") {
				res.writeHead(404).end('{"errorCode":"RPC_ERROR","message":"no"}')
				return
			}
			if (url === "/live-only") {
				res
					.writeHead(200, { "Content-Type": "application/json" })
					.end(JSON.stringify({ sawAuth: req.headers.authorization ?? null }))
				return
			}
			res
				.writeHead(200, { "Content-Type": "application/json" })
				.end(JSON.stringify({ ok: true, echoed: Buffer.concat(chunks).toString("utf8") }))
		})
	})

	// The LCU's WAMP feed: an HTTP upgrade on the same port, same basic auth.
	server.on("upgrade", (req, socket) => {
		const key = req.headers["sec-websocket-key"]
		if (typeof key !== "string" || req.headers.authorization !== authHeader(password)) {
			socket.destroy()
			return
		}
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${acceptKeyFor(key)}\r\n\r\n`
		)
		socket.on("data", (chunk: Buffer) => {
			const frame = readFrame(chunk)
			if (!frame) return
			subscribes.push(frame.payload.toString("utf8"))
			// Answer the subscribe with a zero-length ack (the real client does), then an event.
			socket.write(encodeFrame(WS_OPCODE.text, Buffer.alloc(0), null))
			socket.write(
				encodeFrame(
					WS_OPCODE.text,
					Buffer.from(
						JSON.stringify([
							8,
							"OnJsonApiEvent",
							{
								uri: "/lol-gameflow/v1/gameflow-phase",
								eventType: "Update",
								data: "ChampSelect"
							}
						])
					),
					null
				)
			)
		})
	})

	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	const address = server.address()
	port = typeof address === "object" && address ? address.port : 0
	writeLock(port, password)
})

after(async () => {
	server.close()
	rmSync(dir, { recursive: true, force: true })
})

const transport = (over: Record<string, unknown> = {}): LcuDirect =>
	new LcuDirect({ lockfilePath, events: false, ...over })

describe("LcuDirect requests", () => {
	it("accepts the self-signed certificate WITHOUT the process-wide TLS switch", async () => {
		// If this passes while NODE_TLS_REJECT_UNAUTHORIZED is unset, the exemption really is
		// scoped to the connection — which is the entire reason this uses https.request.
		strictEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined)
		const res = await transport().request("GET", "/lol-summoner/v1/current-summoner")
		strictEqual(res.status, 200)
		strictEqual(JSON.parse(res.body).ok, true)
		strictEqual(res.target, "lcu")
	})

	it("sends the lockfile's basic auth, and never puts the password in a URL", async () => {
		seen.length = 0
		await transport().request("GET", "/authed")
		strictEqual(seen[0]!.auth, authHeader(password))
		ok(!seen[0]!.url.includes(password), "the password must not travel in the path")
	})

	it("treats a 404 as data, not as an error", async () => {
		const res = await transport().request("GET", "/missing")
		strictEqual(res.status, 404)
		ok(res.body.includes("RPC_ERROR"))
	})

	it("returns bytes intact when binary is asked for", async () => {
		const res = await transport().request("GET", "/icon.png", undefined, { binary: true })
		ok(res.buffer)
		strictEqual(res.buffer!.length, ICON.length)
		strictEqual(Buffer.compare(res.buffer!, ICON), 0)
	})

	it("streams a body to a file and reports the byte count", async () => {
		const target = join(dir, "nested", "icon.png")
		const res = await transport().request("GET", "/icon.png", undefined, { toFile: target })
		strictEqual(res.status, 200)
		strictEqual(res.body, "", "a toFile response is not buffered")
		strictEqual(res.file, target)
		strictEqual(res.bytes, ICON.length)
		strictEqual(Buffer.compare(readFileSync(target), ICON), 0)
	})

	it("posts a JSON body with a Content-Type", async () => {
		seen.length = 0
		const res = await transport().request("POST", "/echo", { gameId: 5432 })
		strictEqual(seen[0]!.method, "POST")
		strictEqual(seen[0]!.contentType, "application/json")
		strictEqual(JSON.parse(res.body).echoed, '{"gameId":5432}')
	})

	it("lets a caller add headers but never override Authorization", async () => {
		seen.length = 0
		await transport().request("GET", "/headers", undefined, {
			headers: { "X-Trace": "yes", Authorization: "Basic bogus" }
		})
		strictEqual(seen[0]!.auth, authHeader(password), "a caller's stale password must not win")
		strictEqual(seen[0]!.auth === "Basic bogus", false)
	})

	it("sends no Authorization at all to the in-game API on the live target", async () => {
		// Port 2999 has no auth; sending the client's password there would leak it to the game.
		const res = await transport({ livePort: port }).request("GET", "/live-only", undefined, {
			target: "live"
		})
		strictEqual(res.target, "live")
		strictEqual(JSON.parse(res.body).sawAuth, null)
	})

	it("re-reads the lockfile and retries once on a 401, the way a client restart looks", async () => {
		password = "first-password"
		writeLock(port, password)
		const t = transport()
		// Prime the cached lockfile, then make the server reject it — it rotates the password
		// and rewrites the lockfile, exactly like a client that restarted mid-session.
		await t.request("GET", "/warmup")
		password = "rotated-password"
		seen.length = 0
		const res = await t.request("GET", "/after-restart")
		strictEqual(seen.length, 2, "one rejected attempt and one retry")
		strictEqual(seen[0]!.auth === seen[1]!.auth, false, "the retry must carry the new password")
		strictEqual(res.status, 200)
	})

	it("rejects with a typed transport error when nothing is listening", async () => {
		const deadPort = port + 1
		const deadLock = join(dir, "dead-lockfile")
		writeFileSync(deadLock, `LeagueClient:1:${deadPort}:whatever:https`)
		await rejects(
			() => transport({ lockfilePath: deadLock }).request("GET", "/anything"),
			(err: unknown) =>
				err instanceof LcuTransportError && err.code === "CLIENT_CLOSED" ? true : false
		)
	})

	it("rejects with NO_LOCKFILE when the client is closed", async () => {
		await rejects(
			() => transport({ lockfilePath: join(dir, "absent") }).request("GET", "/anything"),
			(err: unknown) =>
				err instanceof LcuTransportError && err.code === "NO_LOCKFILE" ? true : false
		)
	})

	it("times out rather than hanging forever", async () => {
		await rejects(
			() => transport().request("GET", "/hang", undefined, { timeoutMs: 150 }),
			(err: unknown) => (err instanceof LcuTransportError && err.code === "TIMEOUT" ? true : false)
		)
	})
})

describe("LcuDirect lifecycle", () => {
	it("is ready with a lockfile and degraded without one — never failed", async () => {
		password = "first-password"
		writeLock(port, password)
		const live = transport()
		await live.start()
		strictEqual(live.state, "ready")
		strictEqual(live.lcuPort, port)
		await live.stop()

		const closed = transport({ lockfilePath: join(dir, "absent") })
		await closed.start()
		strictEqual(closed.state, "degraded", "a closed client is a state, not a failure")
		await closed.stop()
	})
})

describe("LcuDirect events", () => {
	it("subscribes to the WAMP feed and emits lcu-event, so choosing it keeps push", async () => {
		password = "first-password"
		writeLock(port, password)
		subscribes.length = 0
		const t = new LcuDirect({ lockfilePath })
		const event = once(t, "lcu-event")
		await t.start()
		const [received] = (await event) as [{ uri: string; eventType: string; data: unknown }]
		strictEqual(received.uri, "/lol-gameflow/v1/gameflow-phase")
		strictEqual(received.eventType, "Update")
		strictEqual(received.data, "ChampSelect")
		strictEqual(subscribes[0], '[5,"OnJsonApiEvent"]')
		await t.stop()
	})
})

describe("probeDirect", () => {
	it("calls a loopback that answers 'reachable', whatever the status", async () => {
		password = "first-password"
		writeLock(port, password)
		const result = await probeDirect({ lockfilePath })
		strictEqual(result.verdict, "reachable")
	})

	it("calls a refused connection 'unreachable' — this is the WSL2 NAT signature", async () => {
		const deadLock = join(dir, "dead-probe-lockfile")
		writeFileSync(deadLock, `LeagueClient:1:${port + 1}:whatever:https`)
		const result = await probeDirect({ lockfilePath: deadLock, timeoutMs: 500 })
		strictEqual(result.verdict, "unreachable")
	})

	it("refuses to conclude anything with the client closed", async () => {
		const result = await probeDirect({ lockfilePath: join(dir, "absent") })
		strictEqual(result.verdict, "unknown", "no lockfile is no evidence, in either direction")
	})
})
