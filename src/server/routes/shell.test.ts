/**
 * The open-in-Windows route hands a URL to the Windows shell, so what it can be talked into
 * launching matters. It takes a hash fragment, never a URL — the origin is fixed in code.
 */

import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { createShellRoutes } from "./shell.ts"

/**
 * A spy, never the real launcher.
 *
 * These tests exist to prove the URL cannot be redirected, which means POSTing to the route —
 * and with the launcher hardcoded that opened a real browser tab every run. It went unnoticed
 * until a screenshot of ~15 stacked tabs arrived. A test must never act on the machine it runs
 * on.
 */
const launched: string[] = []

const post = async (body: unknown) => {
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
