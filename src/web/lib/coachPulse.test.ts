import assert from "node:assert/strict"
import { test } from "node:test"
import { coachPulse } from "./coachPulse.ts"
import type { CoachPulseInput } from "./coachPulse.ts"

const NOW = 1_700_000_000_000

/** Live, armed, sharing, nothing wrong, never asked. Every test below is a delta from this. */
const base: CoachPulseInput = {
	sharing: true,
	armed: true,
	status: "live",
	fault: null,
	standby: null,
	daemonReachable: true,
	needsKey: false,
	askedAtMs: null,
	spokeAtMs: null,
	turns: 0,
	spokenLines: 0,
	nowMs: NOW
}

const at = (over: Partial<CoachPulseInput>) => coachPulse({ ...base, ...over })

test("not sharing is off, and says so rather than looking broken", () => {
	assert.equal(at({ sharing: false }).state, "off")
	assert.equal(at({ sharing: false }).tone, "off")
	assert.equal(at({ sharing: false, needsKey: true }).short, "Live coach needs a key")
})

test("an error fault outranks everything, and carries its own fix into the strip", () => {
	const p = at({
		fault: {
			level: "error",
			short: "No game data",
			text: "Can't read the game data (4 tries).",
			fix: "Nothing to do if you're mid-game."
		},
		askedAtMs: NOW - 2000
	})
	assert.equal(p.state, "broken")
	assert.equal(p.tone, "error")
	// The 380px popout has no fault list under it, so the fix has to travel in the one line it has.
	assert.match(p.why ?? "", /Nothing to do if you're mid-game/)
})

test("a WARNING does not take the headline — she is still coaching", () => {
	const p = at({
		fault: { level: "warn", short: "2 blind check-ins", text: "…", fix: null },
		askedAtMs: NOW - 5000,
		turns: 4,
		spokenLines: 1
	})
	assert.equal(p.state, "passed")
})

test("standby is the gate's own sentence, and names the daemon when it is gone", () => {
	assert.equal(at({ standby: "Not in a game." }).state, "standby")
	assert.equal(at({ standby: "Not in a game." }).why, "Not in a game.")
	assert.equal(
		at({ standby: "Can't reach eepalytics.", daemonReachable: false }).short,
		"Sharing — can't reach eepalytics"
	)
})

test("no key blocks the voice and says the free half is still running", () => {
	const p = at({ needsKey: true })
	assert.equal(p.state, "nokey")
	assert.match(p.why ?? "", /graded review/)
})

test("a closed socket is broken, not quiet", () => {
	assert.equal(at({ status: "off" }).state, "broken")
	assert.equal(at({ status: "error" }).state, "broken")
	assert.equal(at({ status: "connecting" }).state, "connecting")
	assert.equal(at({ status: "reconnecting" }).state, "connecting")
})

/*
 * THE THREE SILENCES. These four cases are the whole point of the file: each one is a different
 * fact about the machine, and before this they all rendered as the same empty panel.
 */

test("never asked is its own state — the schedule has not fired yet", () => {
	const p = at({})
	assert.equal(p.state, "unasked")
	assert.equal(p.tone, "quiet")
})

test("asked recently and silent is ASKED AND DECLINED, with the count", () => {
	const p = at({ askedAtMs: NOW - 20_000, spokeAtMs: null, turns: 6, spokenLines: 1 })
	assert.equal(p.state, "passed")
	assert.match(p.short, /asked 20s ago/)
	assert.match(p.why ?? "", /nothing worth saying/)
	// 6 asks, 1 line — five passes. The number is what makes "quiet is normal" checkable.
	assert.match(p.why ?? "", /5 of 6 check-ins/)
})

test("an OLD ask is NOTHING HAS CHANGED, because the schedule has not fired since", () => {
	const p = at({ askedAtMs: NOW - 200_000, turns: 6, spokenLines: 1 })
	assert.equal(p.state, "idle")
	assert.match(p.why ?? "", /Nothing has changed since she was last asked, 3m/)
})

test("a line she just said is the answer; the same line four minutes on is not", () => {
	const spoke = at({ askedAtMs: NOW - 12_000, spokeAtMs: NOW - 10_000, turns: 3, spokenLines: 1 })
	assert.equal(spoke.state, "spoke")
	assert.equal(spoke.tone, "live")
	assert.equal(spoke.why, null)

	const stale = at({ askedAtMs: NOW - 240_000, spokeAtMs: NOW - 238_000, turns: 3, spokenLines: 1 })
	assert.equal(stale.state, "idle")
	assert.match(stale.why ?? "", /since she last spoke, 3m/)
})

test("every state's strip line fits the 380px popout", () => {
	const cases: Partial<CoachPulseInput>[] = [
		{ sharing: false },
		{ sharing: false, needsKey: true },
		{ standby: "Not in a game." },
		{ standby: "gone", daemonReachable: false },
		{ needsKey: true },
		{ status: "connecting" },
		{ status: "reconnecting" },
		{ status: "off" },
		{},
		{ askedAtMs: NOW - 20_000, turns: 6, spokenLines: 1 },
		{ askedAtMs: NOW - 200_000, turns: 6, spokenLines: 1 },
		{ askedAtMs: NOW - 12_000, spokeAtMs: NOW - 10_000, turns: 3, spokenLines: 1 }
	]
	for (const c of cases) {
		const p = at(c)
		assert.ok(
			p.short.length <= 34,
			`"${p.short}" is ${p.short.length} characters — the strip truncates past ~34`
		)
	}
})

test("a silence always says why, and a spoken line never needs to", () => {
	for (const c of [
		{},
		{ askedAtMs: NOW - 20_000, turns: 2, spokenLines: 0 },
		{ askedAtMs: NOW - 200_000, turns: 2, spokenLines: 0 },
		{ status: "off" as const }
	])
		assert.notEqual(at(c).why, null)
})
