/**
 * The two readings that tell a live capture from a dead one.
 *
 * He shares his whole monitor and leaves it up for a session, so this stream has hours in which to
 * die without anyone pressing anything — a display sleeping, a driver reset, the browser reclaiming
 * the capture. The failure that followed was silent and, worse, plausible: the coach kept talking,
 * fluently, about a game she could no longer see, and every line she said was something the
 * ground-truth block already knew. That is the session he quit on.
 *
 * `grabVerdict` is pure precisely so this can be checked rather than argued about. The hook around
 * it needs React, a `<video>`, a canvas and a live `MediaStream`, which is exactly the shape of
 * code that gets read and believed.
 */

import { strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { grabVerdict, shareFailure } from "./useScreenShare.ts"

const grab = (over: Partial<Parameters<typeof grabVerdict>[0]> = {}) =>
	grabVerdict({
		trackState: "live",
		videoWidth: 2560,
		// A healthy 5-second gap: the media clock keeps up with the wall clock, near enough.
		mediaTime: 16.4,
		lastMediaTime: 11.5,
		sinceLastMs: 5000,
		...over
	})

describe("grabVerdict", () => {
	it("passes a healthy grab", () => {
		strictEqual(grab(), "ok")
	})

	it("calls an ended track ended, even though the element still reports a size", () => {
		/*
		 * THE failure this file exists for. A track can end without its `ended` event arriving, and
		 * a stalled `<video>` keeps its last decoded frame — so `videoWidth` stays 2560 and every
		 * later grab succeeds, returning a photograph of the instant the share died. Nothing
		 * downstream can tell that from a working capture.
		 */
		strictEqual(grab({ trackState: "ended", videoWidth: 2560 }), "ended")
		// No track at all is the same event observed slightly later.
		strictEqual(grab({ trackState: null }), "ended")
	})

	it("calls a stream with no pixels blind rather than frozen", () => {
		strictEqual(grab({ videoWidth: 0 }), "no-picture")
	})

	it("calls an unadvancing media clock frozen", () => {
		strictEqual(grab({ mediaTime: 11.5, lastMediaTime: 11.5 }), "frozen")
	})

	it("catches the grab where the freeze BEGINS, which creeps rather than stopping dead", () => {
		/*
		 * Measured in Electron against a real `canvas.captureStream(25)` track: starved for 1.5s,
		 * the media clock still advanced 0.040s — one last frame in flight — before stopping. An
		 * equality test therefore misses the first grab across a freeze, which is the one that
		 * matters, and only catches it on the second. The comparison is a ratio for that reason.
		 */
		strictEqual(grab({ lastMediaTime: 11.5, mediaTime: 11.54, sinceLastMs: 1500 }), "frozen")
		// A healthy stream measured 1.171s of media clock per 1.2s of wall clock, so a real
		// capture is nowhere near this line — the gap between 0.98x and 0.03x is the whole test.
		strictEqual(grab({ lastMediaTime: 11.5, mediaTime: 12.671, sinceLastMs: 1200 }), "ok")
	})

	it("does not call two grabs in the same instant frozen", () => {
		/*
		 * The journal grabs every 5s and the coach every 10-40s, so their timers land together
		 * regularly. On a perfectly healthy stream two grabs milliseconds apart see the same media
		 * clock — treating that as evidence would put a red line on screen during a good game.
		 */
		strictEqual(grab({ mediaTime: 11.5, lastMediaTime: 11.5, sinceLastMs: 3 }), "ok")
		strictEqual(grab({ mediaTime: 11.5, lastMediaTime: 11.5, sinceLastMs: 899 }), "ok")
		strictEqual(grab({ mediaTime: 11.5, lastMediaTime: 11.5, sinceLastMs: 900 }), "frozen")
	})

	it("never calls the first grab frozen", () => {
		// There is nothing to compare against, and a share that has just started has a media clock
		// of 0 — which would otherwise match the sentinel and report a fault on the first frame.
		strictEqual(grab({ mediaTime: 0, lastMediaTime: -1, sinceLastMs: 60_000 }), "ok")
	})

	it("checks the track before the picture, because a dead track explains the picture", () => {
		strictEqual(grab({ trackState: "ended", videoWidth: 0 }), "ended")
	})
})

describe("shareFailure", () => {
	it("turns an empty DOMException into a sentence", () => {
		// `getDisplayMedia` rejects with a DOMException whose message is frequently "" and whose
		// name carries all of the meaning, so the raw string used to render as an empty red box.
		const cancelled = shareFailure(new DOMException("", "NotAllowedError"))
		strictEqual(cancelled.includes("cancelled"), true)
		strictEqual(cancelled.length > 20, true)
	})

	it("names the case where the answer is to move to another browser", () => {
		// WSL Electron: `getDisplayMedia` is simply absent, and "undefined is not a function" is
		// not an instruction anyone can follow.
		const missing = shareFailure(new TypeError("getDisplayMedia is not available in this window"))
		strictEqual(missing.includes("Windows browser"), true)
	})

	it("passes an unrecognised message through rather than inventing a better one", () => {
		strictEqual(shareFailure(new Error("something specific and new")), "something specific and new")
	})

	it("never returns an empty string", () => {
		for (const e of [
			new DOMException("", "NotFoundError"),
			new DOMException("", "NotReadableError"),
			new DOMException("", "SomeFutureError"),
			"a bare string",
			null
		])
			strictEqual(shareFailure(e).trim() === "", false, String(e))
	})
})
