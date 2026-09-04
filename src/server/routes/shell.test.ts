/**
 * The open-in-Windows route hands a URL to the Windows shell, so what it can be talked into
 * launching matters. It takes a hash fragment, never a URL — the origin is fixed in code.
 */

import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { createShellRoutes } from "./shell.ts"

const post = async (body: unknown) => {
	const app = createShellRoutes()
	const res = await app.request("/shell/open-in-windows", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	})
	return { status: res.status, json: (await res.json().catch(() => null)) as { url?: string } | null }
}

describe("open-in-windows", () => {
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
