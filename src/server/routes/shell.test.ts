/**
 * The open-in-Windows route hands a URL to the Windows shell, so what it can be talked into
 * launching matters. It takes a hash fragment, never a URL — the origin is fixed in code.
 */

import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { createShellRoutes, resetLaunchLimits } from "./shell.ts"

/**
 * A spy, never the real launcher.
 *
 * These tests exist to prove the URL cannot be redirected, which means POSTing to the route —
 * and with the launcher hardcoded that opened a real browser tab every run. It went unnoticed
 * until a screenshot of ~15 stacked tabs arrived. A test must never act on the machine it runs
 * on.
 */
const launched: string[] = []

const post = async (body: unknown, keepLimits = false) => {
	// The route is rate-limited so a runaway cannot produce a wall of tabs; these tests fire many
	// requests back to back and are asserting the URL, not the limiter.
	if (!keepLimits) resetLaunchLimits()
	const app = createShellRoutes(url => {
		launched.push(url)
	})
	const res = await app.request("/shell/open-in-windows", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	})
	return { status: res.status, json: (await res.json().catch(() => null)) as { url?: string } | null }
}

describe("open-in-windows", () => {
	it("launches nothing beyond the URL it reports", async () => {
		const before = launched.length
		const r = await post({ hash: "#/live" })
		if (r.status === 501) return
		strictEqual(launched.length, before + 1, "exactly one launch per request")
		strictEqual(launched[launched.length - 1], r.json?.url)
	})

	it("always targets this app's own origin", async () => {
		const r = await post({ hash: "#/live" })
		if (r.status === 501) return // not under WSL; nothing to assert
		ok(r.json?.url?.startsWith("http://localhost:"), `origin must be fixed: ${r.json?.url}`)
		ok(r.json?.url?.endsWith("#/live"))
	})

	it("cannot be pointed at another host", async () => {
		for (const hostile of [
			"#/live@evil.example.com",
			"http://evil.example.com",
			"#/live?x=https://evil.example.com",
			"#/../../etc/passwd"
		]) {
			const r = await post({ hash: hostile })
			if (r.status === 501) return
			ok(
				r.json?.url?.startsWith("http://localhost:"),
				`must stay on localhost for ${JSON.stringify(hostile)}, got ${r.json?.url}`
			)
			ok(!r.json!.url!.includes("evil.example.com"), `leaked a host: ${r.json?.url}`)
		}
	})

	it("ignores a non-hash body rather than launching something odd", async () => {
		const r = await post({ hash: 42 })
		if (r.status === 501) return
		strictEqual(r.json?.url, "http://localhost:7700/")
	})
})

/**
 * The limiter is the reason a future runaway is survivable, so it is tested like a safety
 * interlock rather than like a nicety: the exact thing that went wrong twice is a caller asking
 * for a launch over and over, and the assertion is that the WORLD only sees one.
 */
describe("browser launches are capped", () => {
	it("refuses a second launch inside the cooldown", async () => {
		resetLaunchLimits()
		const before = launched.length
		const first = await post({ hash: "#/live" }, true)
		if (first.status === 501) return
		const second = await post({ hash: "#/live" }, true)
		strictEqual(second.status, 429, "a launch inside the cooldown must be refused")
		strictEqual(launched.length, before + 1, "exactly one window reached the world")
	})

	it("stops launching entirely once the ceiling is reached", async () => {
		resetLaunchLimits()
		const before = launched.length
		// Thirty presses is what the outbreak looked like from the daemon's side.
		for (let i = 0; i < 30; i++) await post({ hash: "#/live" }, true)
		if (launched.length === before) return // not under WSL; the route 501s and never launches
		ok(
			launched.length - before <= 6,
			`at most the ceiling may ever launch, got ${launched.length - before}`
		)
	})
})
