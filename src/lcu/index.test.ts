/**
 * `createLcu`'s selection, for the hosts that cannot use interop.
 *
 * Only the no-interop environments are exercised here on purpose: a WSL case would have to
 * either spawn the real Windows bridge — which watches the lockfile, opens a websocket to the
 * live client and is emphatically not something a test suite should do to the machine it runs
 * on — or stub so much of the factory that it would stop testing the factory. The WSL ordering
 * is pinned by `select.test.ts` instead, where it is a pure function.
 */

import { ok, strictEqual } from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import type { EnvironmentFacts } from "./environment.ts"
import { createLcu } from "./index.ts"

const WINDOWS: EnvironmentFacts = {
	kind: "windows",
	isWsl: false,
	interopPossible: false,
	directPlausible: "yes",
	signals: ["platform=win32"]
}

const dir = mkdtempSync(join(tmpdir(), "eepalytics-createlcu-"))
/** Deliberately absent: "the client is not running" is the state we can produce here. */
const lockfilePath = join(dir, "lockfile")

after(() => rmSync(dir, { recursive: true, force: true }))

describe("createLcu", () => {
	it("uses the direct transport where interop is impossible", async () => {
		const logs: string[] = []
		const lcu = await createLcu(
			{ transport: "direct" },
			{ environment: WINDOWS, direct: { lockfilePath }, onLog: line => logs.push(line) }
		)
		try {
			strictEqual(lcu.kind, "direct")
			strictEqual(lcu.state, "degraded", "no client running is degraded, not failed")
			ok(
				logs.some(line => line.includes("transport plan: direct")),
				`the log must say what it chose and why: ${logs.join(" | ")}`
			)
		} finally {
			await lcu.stop()
		}
	})

	it("ignores a saved bridge preference on a host with no /mnt/c, instead of failing", async () => {
		// Every existing install has `transport: "bridge"` in its settings row. On a native
		// Windows machine that must not be read as a command to spawn something that is not there.
		const lcu = await createLcu(
			{ transport: "bridge" },
			{ environment: WINDOWS, direct: { lockfilePath }, onLog: () => {} }
		)
		try {
			strictEqual(lcu.kind, "direct")
		} finally {
			await lcu.stop()
		}
	})

	it("does not report a fallback reason when the first candidate was taken", async () => {
		const lcu = await createLcu(
			{},
			{ environment: WINDOWS, direct: { lockfilePath }, onLog: () => {} }
		)
		try {
			strictEqual(lcu.fallbackReason, null)
		} finally {
			await lcu.stop()
		}
	})
})
