/**
 * The rules that decide when the coach admits something is wrong.
 *
 * This is worth a test for the reason the file exists: he shut the coach off mid-game because
 * nine lines in a row could all have been written from the ground-truth block alone, and nothing
 * on screen told him the frames were not arriving. Every fault below was a bare `catch` before
 * this, usually with a comment about not interrupting a game — so the two properties that matter
 * are the two a comment cannot enforce: a single blip stays quiet, and a run of failures does not.
 *
 * The prose is checked by id, never by matching sentences. Copy should be free to change; the
 * thresholds should not change by accident.
 */

import { ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { liveFaults, topFault } from "./liveFaults.ts"
import type { LiveFaultInput } from "./liveFaults.ts"

/** A session in which everything is working: sharing, in a game, coach live, nothing failing. */
const healthy: LiveFaultInput = {
	sharing: true,
	shareEnded: false,
	shareError: null,
	framesMissed: 0,
	framesStale: 0,
	blindTurns: 0,
	truthFails: 0,
	throttledTicks: 0,
	journalFails: 0,
	journalReason: null,
	droppedTurns: 0,
	unsaved: 0,
	daemonReachable: true,
	keyProbeFails: 0,
	coachStatus: "live",
	coachError: null,
	voice: "socket",
	spokenLines: 4,
	audioPlayed: 12,
	audioBlocked: false
}

const ids = (over: Partial<LiveFaultInput>): string[] =>
	liveFaults({ ...healthy, ...over }).map(f => f.id)

describe("liveFaults", () => {
	it("says nothing at all when nothing is wrong", () => {
		strictEqual(liveFaults(healthy).length, 0)
	})

	it("stays quiet through a blip and speaks up on a fault", () => {
		// Each pair is [transient, persistent] for one path. The left column must be silent: a
		// single dropped frame, one failed ground-truth read and one refused POST are all normal
		// mid-game events that cost at most one check-in.
		const blips: [string, Partial<LiveFaultInput>, Partial<LiveFaultInput>][] = [
			["frames-missed", { framesMissed: 1 }, { framesMissed: 3 }],
			["frames-stale", { framesStale: 2 }, { framesStale: 3 }],
			["truth-unreachable", { truthFails: 1 }, { truthFails: 2 }],
			["journal-failing", { journalFails: 2 }, { journalFails: 3 }],
			["tab-throttled", { throttledTicks: 2 }, { throttledTicks: 3 }],
			["turns-dropped", { droppedTurns: 1 }, { droppedTurns: 2 }]
		]
		for (const [id, quiet, loud] of blips) {
			ok(!ids(quiet).includes(id), `${id} shouted about a blip`)
			ok(ids(loud).includes(id), `${id} stayed quiet about a real fault`)
		}
	})

	it("reports a blind check-in immediately, because one of them is already a lie told out loud", () => {
		// Unlike a dropped frame, a blind turn has already reached him: she spoke, with confidence,
		// about a game she could not see. There is no such thing as a harmless one.
		ok(ids({ blindTurns: 1 }).includes("blind-turns"))
	})

	it("tells a share that ENDED apart from a share that never started", () => {
		strictEqual(ids({ sharing: false, shareEnded: true }).includes("share-ended"), true)
		strictEqual(ids({ sharing: false, shareEnded: true }).includes("share-error"), false)
		const failedToStart = ids({ sharing: false, shareError: "Screen sharing was cancelled" })
		strictEqual(failedToStart.includes("share-error"), true)
		strictEqual(failedToStart.includes("share-ended"), false)
	})

	it("does not report a dead stream while nothing is being shared", () => {
		// The counters are frozen at whatever they held when the share stopped. Rendering them
		// beside "your share ended" would be two sentences about one event.
		const after = ids({ sharing: false, shareEnded: true, framesMissed: 9, framesStale: 9 })
		ok(!after.includes("frames-missed"))
		ok(!after.includes("frames-stale"))
	})

	it("reports no-picture rather than frozen when both are counting", () => {
		// They are mutually exclusive by construction in the hook, but the fix differs and showing
		// both would ask him to do two contradictory things.
		const both = ids({ framesMissed: 5, framesStale: 5 })
		ok(both.includes("frames-missed"))
		ok(!both.includes("frames-stale"))
	})

	it("only calls silence a fault when the page is the thing making the sound", () => {
		// Gemini Live returns audio this page plays and counts; a turn-based provider is spoken by
		// `speechSynthesis`, which this page never counts. Reporting silence there would be a fault
		// invented from a number that is always zero.
		const socket = { voice: "socket" as const, spokenLines: 3, audioPlayed: 0 }
		ok(ids(socket).includes("audio-silent"))
		ok(!ids({ ...socket, voice: "system" as const }).includes("audio-silent"))
		// Already explained by its own button, with a click that fixes it.
		ok(!ids({ ...socket, audioBlocked: true }).includes("audio-silent"))
	})

	it("does not blame his key when it is our own daemon that could not be reached", () => {
		// And not on the first miss: the probe runs every ten seconds, and a daemon restarting
		// between two of them is not a fault worth a line.
		ok(!ids({ keyProbeFails: 1 }).includes("key-unknown"))
		const said = liveFaults({ ...healthy, keyProbeFails: 2 })
		strictEqual(said.length, 1)
		strictEqual(said[0]!.id, "key-unknown")
	})

	it("carries the daemon's own reason for a refused frame when it gave one", () => {
		const [fault] = liveFaults({
			...healthy,
			journalFails: 4,
			journalReason: "no live game — a frame that cannot be placed on the game clock is not evidence"
		})
		ok(fault!.text.includes("no live game"), fault!.text)
	})

	it("puts a number in every fault it raises, so each one is checkable", () => {
		// The complaint that produced this file was about advice with no evidence in it. A status
		// line that says "something is wrong" is the same failure wearing different clothes.
		const counted = liveFaults({
			...healthy,
			framesMissed: 4,
			blindTurns: 7,
			truthFails: 3,
			journalFails: 5,
			throttledTicks: 4,
			droppedTurns: 2,
			unsaved: 2,
			spokenLines: 3,
			audioPlayed: 0
		})
		for (const f of counted) ok(/\d/.test(f.text), `${f.id} has no number in it: ${f.text}`)
	})

	it("keeps every compact label short enough for the one-line strip", () => {
		const long = liveFaults({
			...healthy,
			sharing: false,
			shareEnded: true,
			blindTurns: 123,
			truthFails: 9,
			journalFails: 9,
			throttledTicks: 9,
			droppedTurns: 9,
			unsaved: 9,
			keyProbeFails: 3,
			coachStatus: "error",
			coachError: "lost the connection to Gemini and could not get it back — press start to retry"
		})
		for (const f of long) ok(f.short.length <= 40, `${f.id}: ${f.short}`)
	})

	it("puts every error above every warning, because the panel renders this list in order", () => {
		/*
		 * The pushes above are grouped by SUBJECT — the share, the frames, the daemon, the socket —
		 * which is the right way to read the source and the wrong order to read the panel in. This
		 * exact input used to render `blind-turns` (a warning) above `truth-unreachable` and
		 * `journal-failing`, putting the mildest thing wrong at the top of a list he is scanning
		 * between fights.
		 */
		const f = liveFaults({
			...healthy,
			blindTurns: 6,
			truthFails: 4,
			journalFails: 5,
			throttledTicks: 4
		})
		strictEqual(
			f.map(x => `${x.level}:${x.id}`).join(" "),
			"error:truth-unreachable error:journal-failing warn:blind-turns warn:tab-throttled"
		)
		// Stable within a level, so the subject grouping survives: the two frame faults stay
		// beside the share fault they explain rather than being scattered by the sort.
		const shared = liveFaults({ ...healthy, framesMissed: 4, droppedTurns: 3, unsaved: 2 })
		strictEqual(shared.map(x => x.id).join(" "), "frames-missed turns-dropped lines-unsaved")
	})
})

describe("topFault", () => {
	it("prefers an error over a warning, whatever the order", () => {
		// The strip has room for one line. A warning shown over a dead share is how a broken
		// feature keeps looking like a working one.
		const said = liveFaults({ ...healthy, unsaved: 3, sharing: false, shareEnded: true })
		strictEqual(topFault(said)?.id, "share-ended")
	})

	it("falls back to the first warning, and to nothing when there is nothing", () => {
		strictEqual(topFault(liveFaults({ ...healthy, unsaved: 1 }))?.id, "lines-unsaved")
		strictEqual(topFault(liveFaults(healthy)), null)
	})
})
