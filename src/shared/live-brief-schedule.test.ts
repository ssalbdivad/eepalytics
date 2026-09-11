/**
 * The objective spawn clocks, RE-DERIVED from every timeline on disk instead of remembered.
 *
 * ## Why this file exists
 *
 * `live-brief.ts` states the schedule as fact, in NEXT, which is rank 0 and is never dropped. It
 * does that deliberately — "a schedule the brief does not state is a schedule the model will
 * invent", after a graded run had the coach say "Voidgrubs are spawning in a minute" at 6:05 with
 * no grub line in its payload. The cost of that decision is that a stale constant is not a missing
 * fact any more, it is a confident wrong one that the model has no way to doubt.
 *
 * Two of the four checkable constants were exactly that. `GRUBS_SPAWN_SEC` was 300 and
 * `HERALD_SPAWN_SEC` was 840, from an older patch. Replayed through `buildDelta` on the recorded
 * samples of game 5639406342, NEXT read verbatim `- Voidgrubs (top side): UP since 5:00 and
 * untouched by anyone for 2m30s.` at 7:29 — the grubs did not exist, and the first one died at
 * 10:22 — and `- Rift Herald (top side): UP since 14:00 and untaken for 30s.` at 14:30, about a
 * Herald that was killed at 18:02. Every game carried a false grub claim from 2:30 to 8:00.
 *
 * ## What it derives, and why a MINIMUM is the right statistic
 *
 * The timelines carry kills, never spawns. A monster cannot be killed before it spawns, so the
 * earliest kill in a large corpus is an upper bound on the spawn time that converges from above —
 * and it converges fast, because someone is always waiting in the pit. Across the corpus the
 * earliest kills sit within 33-40 seconds of a whole minute and nothing lands below it, which is
 * what a spawn clock looks like from this side. The assertion is therefore two-sided: no kill may
 * precede the stated spawn, and the earliest one may not be so far after it that the constant is a
 * minute behind.
 *
 * ## What it cannot do
 *
 * It reads `data/blobs`, which is not in the repository, and SKIPS when the corpus is absent — so
 * on a fresh checkout this proves nothing. That is the honest trade: the alternative is a fixture,
 * and a fixture of the spawn schedule is the remembered constant again with a second copy.
 */

import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { test } from "node:test"
import { DATA_DIR } from "./constants.ts"
import { buildBrief, clock } from "./live-brief.ts"

const BLOBS = `${DATA_DIR}/blobs`

/** Every ELITE_MONSTER_KILL clock in the corpus, in seconds, grouped by `monsterType`. */
const killsByMonster = (): Map<string, number[]> => {
	const out = new Map<string, number[]>()
	for (const dir of readdirSync(BLOBS)) {
		let timeline: unknown
		try {
			timeline = JSON.parse(gunzipSync(readFileSync(`${BLOBS}/${dir}/timeline.json.gz`)).toString())
		} catch {
			continue
		}
		const t = timeline as { frames?: Array<{ events?: Array<Record<string, unknown>> }> }
		for (const frame of t.frames ?? [])
			for (const e of frame.events ?? []) {
				if (e.type !== "ELITE_MONSTER_KILL") continue
				const kind = typeof e.monsterType === "string" ? e.monsterType : ""
				const at = typeof e.timestamp === "number" ? e.timestamp / 1000 : null
				if (kind === "" || at === null) continue
				const list = out.get(kind) ?? []
				list.push(at)
				out.set(kind, list)
			}
	}
	return out
}

/**
 * The schedule as the payload states it, read back off a real brief rather than off the constants.
 *
 * Against the module's exports would test the numbers; against the rendered text tests the numbers
 * AND that they reached the one section the model is told to trust.
 */
const SCHEDULE: Array<{ monster: string; spawnSec: number; line: RegExp }> = [
	{ monster: "HORDE", spawnSec: 480, line: /^Voidgrubs: first spawn 8:00/m },
	{ monster: "RIFTHERALD", spawnSec: 900, line: /^Rift Herald: spawn 15:00/m },
	{ monster: "BARON_NASHOR", spawnSec: 1200, line: /^Baron Nashor: spawn 20:00/m },
	// The first drake has no line of its own in OBJECTIVES; `nextBlock` gates on it. See below.
	{ monster: "DRAGON", spawnSec: 300, line: /^Drakes YOUR team:/m }
]

/** A kill this soon after the stated spawn is somebody standing in the pit; more means a stale constant. */
const CONVERGENCE_SEC = 60

test("the stated spawn schedule is not contradicted by any stored timeline", () => {
	if (!existsSync(BLOBS)) return
	const kills = killsByMonster()
	if (kills.size === 0) return
	for (const { monster, spawnSec } of SCHEDULE) {
		const list = kills.get(monster)
		if (list === undefined || list.length === 0) continue
		const earliest = Math.min(...list)
		assert.ok(
			earliest >= spawnSec,
			`${monster} was killed at ${clock(earliest)} in the corpus (${list.length} kills) but the brief says it spawns at ${clock(spawnSec)} — the constant is ahead of the patch`
		)
		assert.ok(
			earliest - spawnSec <= CONVERGENCE_SEC,
			`${monster}'s earliest kill across ${list.length} is ${clock(earliest)}, ${Math.round(earliest - spawnSec)}s after the stated ${clock(spawnSec)} — the constant is behind the patch`
		)
	}
})

test("the schedule the corpus was checked against is the one the payload prints", () => {
	const samples = readFileSync(new URL("./__fixtures__/live-brief-sample.ndjson", import.meta.url), "utf8")
		.trim()
		.split("\n")
		.map(l => JSON.parse(l) as { gameTime: number; data: unknown })
	const brief = buildBrief({ raw: samples[1]!, gameTimeSec: samples[1]!.gameTime })
	assert.ok(brief !== null)
	for (const { monster, line } of SCHEDULE)
		assert.match(brief.text, line, `${monster}'s line is not in the payload in the expected shape`)
})

/*
 * The first drake is the one with no line in OBJECTIVES — it is stated by `nextBlock`, which used
 * to push "none taken, the first is still standing" from 0:00 with no gate at all. Earliest first
 * drake in the corpus is 5:33, so before 5:00 that sentence was false in every game.
 */
test("the first drake is not called standing before it spawns", () => {
	const samples = readFileSync(new URL("./__fixtures__/live-brief-sample.ndjson", import.meta.url), "utf8")
		.trim()
		.split("\n")
		.map(l => JSON.parse(l) as { gameTime: number; data: unknown })
	const early = buildBrief({ raw: samples[1]!, gameTimeSec: 120 })!
	const next = early.text.split("\n\n").find(x => x.startsWith("NEXT")) ?? ""
	assert.ok(!/Drake .*still standing/.test(next), next)
	assert.ok(!/Drake .*UP since/.test(next), next)
	// The OBJECTIVES section had the same ungated sentence and needs the same gate.
	assert.ok(!/first one is still standing/.test(early.text), early.text)
	assert.match(early.text, /the first drake spawns at 5:00, in \d+s/)
})
