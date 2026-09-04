/**
 * Finding the lockfile when there is more than one place it could be.
 *
 * The multi-candidate search exists for native Windows, where the app has no `/mnt/c` and no
 * idea which drive the installer was pointed at. The property that matters most here is the
 * negative one: **under WSL there must still be exactly one path**, because the interop
 * transports read that path directly and this change must not move them.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { LOCKFILE_PATH, WIN_LOCKFILE_CANDIDATES } from "../shared/constants.ts"
import { lockfileCandidates, readAnyLockfileSync, watchAnyLockfile } from "./lockfile.ts"

const dir = mkdtempSync(join(tmpdir(), "eepalytics-lockfile-"))
const first = join(dir, "a-lockfile")
const second = join(dir, "b-lockfile")

after(() => rmSync(dir, { recursive: true, force: true }))

describe("lockfileCandidates", () => {
	it("is exactly the one WSL path on linux — the interop transports depend on it", () => {
		deepStrictEqual(lockfileCandidates("linux"), [LOCKFILE_PATH])
	})

	it("offers the standard Windows install locations on win32", () => {
		deepStrictEqual(lockfileCandidates("win32"), [...WIN_LOCKFILE_CANDIDATES])
	})
})

describe("readAnyLockfileSync", () => {
	it("returns null when none of the candidates exists", () => {
		strictEqual(readAnyLockfileSync([first, second]), null)
	})

	it("takes the first candidate that holds a lockfile, in order", () => {
		writeFileSync(second, "LeagueClient:100:50001:second-password:https")
		strictEqual(readAnyLockfileSync([first, second])?.port, 50001)
		writeFileSync(first, "LeagueClient:200:50002:first-password:https")
		strictEqual(readAnyLockfileSync([first, second])?.port, 50002, "order is priority")
		unlinkSync(first)
		unlinkSync(second)
	})
})

describe("watchAnyLockfile", () => {
	it("reports the client appearing in ANY candidate, then disappearing", async () => {
		const seen: (number | null)[] = []
		const stop = watchAnyLockfile(lf => seen.push(lf?.port ?? null), {
			paths: [first, second],
			intervalMs: 20
		})
		try {
			// Fires once immediately with "no client", which is what the daemon boots into.
			deepStrictEqual(seen, [null])
			// `fs.watchFile` takes its baseline stat *asynchronously*, so a file created in the
			// same tick as the watcher is already there when the baseline is sampled and never
			// registers as a change. Let the baseline land first — this is a property of the
			// polling watcher itself (and of `watchLockfile`, unchanged), not of the search.
			await sleep(100)
			writeFileSync(second, "LeagueClient:100:50003:pw:https")
			await waitFor(() => seen.length === 2)
			strictEqual(seen[1], 50003, "a lockfile in the second candidate must still be found")
			unlinkSync(second)
			await waitFor(() => seen.length === 3)
			strictEqual(seen[2], null, "the client closing has to reach the daemon too")
		} finally {
			stop()
		}
	})
})

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Poll until `check` passes. Cheaper and less flaky than sleeping for a fixed interval. */
const waitFor = async (check: () => boolean, timeoutMs = 4000): Promise<void> => {
	const deadline = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the watcher")
		await sleep(10)
	}
}
