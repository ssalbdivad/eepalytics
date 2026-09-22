/**
 * The cases are written against a REAL temp tree rather than a mocked fs, because the defect this
 * module exists for was a real mtime on a real disk and a mock cannot be stale.
 */

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import {
	bundleFreshness,
	bundleFreshnessCached,
	describeFreshness,
	resetBundleFreshnessCache
} from "./bundle-freshness.ts"

const roots: string[] = []

const makeRepo = (): string => {
	const root = mkdtempSync(join(tmpdir(), "eep-fresh-"))
	roots.push(root)
	mkdirSync(join(root, "src/web/lib"), { recursive: true })
	mkdirSync(join(root, "src/shared"), { recursive: true })
	mkdirSync(join(root, "src/analysis"), { recursive: true })
	mkdirSync(join(root, "dist/assets"), { recursive: true })
	writeFileSync(join(root, "vite.config.ts"), "export default {}\n")
	writeFileSync(join(root, "package.json"), "{}\n")
	writeFileSync(join(root, "src/web/lib/geminiLive.ts"), "export const a = 1\n")
	writeFileSync(join(root, "src/analysis/live-events.ts"), "export const b = 2\n")
	writeFileSync(join(root, "src/shared/live-brief.ts"), "export const c = 3\n")
	return root
}

/** Seconds, because mtime resolution is not guaranteed finer and the test must not race it. */
const touch = (path: string, secondsFromEpoch: number): void =>
	utimesSync(path, secondsFromEpoch, secondsFromEpoch)

const build = (root: string, secondsFromEpoch: number): void => {
	writeFileSync(join(root, "dist/index.html"), "<!doctype html>\n")
	writeFileSync(join(root, "dist/assets/index-abc123.js"), "//\n")
	touch(join(root, "dist/index.html"), secondsFromEpoch)
}

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("bundleFreshness", () => {
	it("calls a build newer than every source fresh", () => {
		const root = makeRepo()
		for (const f of ["src/web/lib/geminiLive.ts", "src/analysis/live-events.ts", "src/shared/live-brief.ts", "vite.config.ts", "package.json"])
			touch(join(root, f), 1_000_000)
		build(root, 2_000_000)
		const f = bundleFreshness(root, join(root, "dist"))
		assert.equal(f.verdict, "fresh")
		assert.deepEqual(f.newerThanBuild, [])
		assert.ok(f.scanned >= 5, "the scan has to have looked at something to say fresh")
	})

	it("NAMES the file that outran the build, newest first", () => {
		const root = makeRepo()
		for (const f of ["src/web/lib/geminiLive.ts", "src/shared/live-brief.ts", "vite.config.ts", "package.json"])
			touch(join(root, f), 1_000_000)
		build(root, 2_000_000)
		// The real case: the schedule changed after the last build, so the coach ran the old one.
		touch(join(root, "src/analysis/live-events.ts"), 3_000_000)
		const f = bundleFreshness(root, join(root, "dist"))
		assert.equal(f.verdict, "stale")
		assert.equal(f.newerThanBuild[0]?.path, "src/analysis/live-events.ts")
		assert.match(describeFreshness(f), /live-events\.ts/)
		assert.match(describeFreshness(f), /pnpm build/)
	})

	it("ignores tests, which never reach a bundle", () => {
		const root = makeRepo()
		for (const f of ["src/web/lib/geminiLive.ts", "src/analysis/live-events.ts", "src/shared/live-brief.ts", "vite.config.ts", "package.json"])
			touch(join(root, f), 1_000_000)
		build(root, 2_000_000)
		writeFileSync(join(root, "src/analysis/live-events.test.ts"), "// added after the build\n")
		touch(join(root, "src/analysis/live-events.test.ts"), 3_000_000)
		assert.equal(bundleFreshness(root, join(root, "dist")).verdict, "fresh")
	})

	it("ignores the node-only half of the tree, which is the running process", () => {
		const root = makeRepo()
		for (const f of ["src/web/lib/geminiLive.ts", "src/analysis/live-events.ts", "src/shared/live-brief.ts", "vite.config.ts", "package.json"])
			touch(join(root, f), 1_000_000)
		build(root, 2_000_000)
		mkdirSync(join(root, "src/daemon"), { recursive: true })
		writeFileSync(join(root, "src/daemon/main.ts"), "// node only\n")
		touch(join(root, "src/daemon/main.ts"), 3_000_000)
		assert.equal(bundleFreshness(root, join(root, "dist")).verdict, "fresh")
	})

	it("says unbuilt rather than stale when there is no build at all", () => {
		const root = makeRepo()
		const f = bundleFreshness(root, join(root, "dist"))
		assert.equal(f.verdict, "unbuilt")
		assert.equal(f.builtAtMs, null)
		assert.match(describeFreshness(f), /pnpm build/)
	})

	it("says unknown rather than guessing when no source tree is beside the process", () => {
		const root = mkdtempSync(join(tmpdir(), "eep-packaged-"))
		roots.push(root)
		mkdirSync(join(root, "dist/assets"), { recursive: true })
		build(root, 2_000_000)
		const f = bundleFreshness(root, join(root, "dist"))
		assert.equal(f.verdict, "unknown")
		assert.equal(f.scanned, 0)
	})

	it("never throws on a directory it cannot read", () => {
		const f = bundleFreshness("/definitely/not/a/repo", "/definitely/not/a/repo/dist")
		assert.equal(f.verdict, "unknown")
	})

	it("caches for the TTL and lets a test reset it", () => {
		const root = makeRepo()
		for (const f of ["src/web/lib/geminiLive.ts", "src/analysis/live-events.ts", "src/shared/live-brief.ts", "vite.config.ts", "package.json"])
			touch(join(root, f), 1_000_000)
		build(root, 2_000_000)
		resetBundleFreshnessCache()
		const first = bundleFreshnessCached(root, join(root, "dist"), 0)
		assert.equal(first.verdict, "fresh")

		touch(join(root, "src/analysis/live-events.ts"), 3_000_000)
		// Inside the window: the cached answer, deliberately.
		assert.equal(bundleFreshnessCached(root, join(root, "dist"), 10_000).verdict, "fresh")
		// Past it: the truth.
		assert.equal(bundleFreshnessCached(root, join(root, "dist"), 20_000).verdict, "stale")
	})
})

/**
 * THROUGH THE REAL ROUTE, because the point of this feature is the bytes that reach a browser
 * whose JavaScript is too old to know the feature exists. A unit test of the verdict cannot show
 * that; only fetching the shell can.
 */
describe("the shell the server actually returns", () => {
	const shellOf = async (root: string): Promise<{ status: number; body: string }> => {
		resetBundleFreshnessCache()
		const { createApp } = await import("./app.ts")
		const app = createApp({ repoRoot: root, distDir: join(root, "dist"), serveSpa: true })
		const res = await app.request("http://127.0.0.1/")
		return { status: res.status, body: await res.text() }
	}

	it("says nothing at all when the build is current", async () => {
		const root = makeRepo()
		for (const f of ["src/web/lib/geminiLive.ts", "src/analysis/live-events.ts", "src/shared/live-brief.ts", "vite.config.ts", "package.json"])
			touch(join(root, f), 1_000_000)
		writeFileSync(join(root, "dist/index.html"), "<!doctype html><html><body><div id=root></div></body></html>")
		touch(join(root, "dist/index.html"), 2_000_000)
		const { status, body } = await shellOf(root)
		assert.equal(status, 200)
		assert.ok(!body.includes("older than the code"), "a fresh build must be served byte for byte")
	})

	/*
	 * The 2026-09-20 case: the daemon is healthy, the API answers, and the bundle predates the
	 * schedule the live coach runs on. The server is the only party that can know.
	 */
	it("injects the warning when the bundle predates its own sources", async () => {
		const root = makeRepo()
		for (const f of ["src/web/lib/geminiLive.ts", "src/shared/live-brief.ts", "vite.config.ts", "package.json"])
			touch(join(root, f), 1_000_000)
		writeFileSync(join(root, "dist/index.html"), "<!doctype html><html><body><div id=root></div></body></html>")
		touch(join(root, "dist/index.html"), 2_000_000)
		touch(join(root, "src/analysis/live-events.ts"), 3_000_000)
		const { status, body } = await shellOf(root)
		assert.equal(status, 200)
		assert.ok(body.includes("older than the code"), "the stale shell has to carry the sentence")
		assert.ok(body.includes("live-events.ts"), "and name the file that outran the build")
		assert.ok(body.includes("pnpm build"), "and the command that fixes it")
		// It goes INSIDE the document, before the close tag, so it renders with no script at all.
		assert.ok(body.indexOf("older than the code") < body.indexOf("</body>"))
		assert.ok(!body.includes("<script>"), "the banner must not introduce script into the shell")
	})
})
