/**
 * The question this answers — "can this window see the game?" — used to be a user-agent sniff
 * that returned the same answer for the WSL app and for a native Windows install, and only one
 * of them was right. These cases are the four shells the app is actually opened in.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { captureEnv } from "./capture-env.ts"
import type { CaptureProbe } from "./capture-env.ts"

/** Real strings, taken from the shells they name. */
const UA = {
	electronLinux:
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) eepalytics/0.1.0 Chrome/136.0.0.0 Electron/44.1.1 Safari/537.36",
	electronWindows:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) eepalytics/0.1.0 Chrome/136.0.0.0 Electron/44.1.1 Safari/537.36",
	chromeWindows:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
}

const probe = (over: Partial<CaptureProbe>): CaptureProbe => ({
	shellPlatform: null,
	userAgent: UA.chromeWindows,
	hasDisplayMedia: true,
	...over
})

describe("captureEnv", () => {
	it("refuses the WSL app — its compositor holds three WSLg screens and its own window", () => {
		deepStrictEqual(
			captureEnv(probe({ shellPlatform: "linux", userAgent: UA.electronLinux })),
			{ can: false, blocked: "wrong-desktop", offerWindowsBrowser: true }
		)
	})

	it("allows the same app installed on Windows — this is the case the old sniff got wrong", () => {
		deepStrictEqual(
			captureEnv(probe({ shellPlatform: "win32", userAgent: UA.electronWindows })),
			{ can: true, blocked: null, offerWindowsBrowser: false }
		)
	})

	it("allows a Windows browser, which is where WSL sends people", () => {
		strictEqual(captureEnv(probe({})).can, true)
	})

	it("believes the shell over the user agent, in both directions", () => {
		// A Windows build whose UA still says Linux would be told to go to a browser it is
		// already equivalent to; a Linux build claiming Windows would open a picker with no
		// game in it. The bridge is the process that owns the window, so it wins.
		strictEqual(captureEnv(probe({ shellPlatform: "win32", userAgent: UA.electronLinux })).can, true)
		strictEqual(
			captureEnv(probe({ shellPlatform: "linux", userAgent: UA.electronWindows })).can,
			false
		)
	})

	it("blocks when there is no getDisplayMedia at all, and does not offer a browser for it", () => {
		// An insecure origin, e.g. reaching the daemon over the LAN by IP rather than localhost.
		// Opening a Windows browser at the same URL would fail the same way, so the offer would
		// be a lie.
		deepStrictEqual(captureEnv(probe({ hasDisplayMedia: false })), {
			can: false,
			blocked: "no-display-media",
			offerWindowsBrowser: false
		})
	})

	it("lets an unrecognised platform try rather than blocking on ignorance", () => {
		strictEqual(captureEnv(probe({ userAgent: "something nobody has seen" })).can, true)
	})

	it("does not need the bridge to spot the WSL app, in case the preload never ran", () => {
		strictEqual(captureEnv(probe({ userAgent: UA.electronLinux })).blocked, "wrong-desktop")
	})
})
