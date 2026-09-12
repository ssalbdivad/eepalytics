/**
 * THE ASSIST LIST ON A NEUTRAL OBJECTIVE IS NOT READ — the regression, on a real recorded game.
 *
 * `__fixtures__/neutral-assists-sample.ndjson` is two consecutive `allgamedata` samples lifted
 * verbatim from `data/live-samples/js-mtvxb5f4-f81a-t29817812.ndjson`, straddling the 23:29 Baron.
 * The feed's own payload for that take is:
 *
 *     BaronKill  KillerName "TeemoLuvuh" (CHAOS)
 *                Assisters  ["CoffeePott", "FIRE BLAZE 533", "uglysand", "WestCoastAlchemy",
 *                            "MikePochita"]
 *
 * Five names for a five-man team that already spent one of them on the killer, and the first of
 * them — CoffeePott — is on ORDER, which is HIS team. Rendered, that line told him a teammate
 * helped the enemy take Baron. It is committed because a fixture written by hand would have had
 * four plausible names on one team and proved nothing.
 *
 * Measured over the whole store this is 22.9% [18.0-28.6] of assisted neutral takes in the live
 * feed and 23.1% [20.3-26.2] in the post-game timeline — see `assistersAreReadable`.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { projectTick } from "../analysis/live-events.ts"
import { buildBrief, buildDelta } from "./live-brief.ts"
import { assistersAreReadable, NEUTRAL_OBJECTIVE_EVENTS } from "./schema/live.ts"

const samples = readFileSync(
	new URL("./__fixtures__/neutral-assists-sample.ndjson", import.meta.url),
	"utf8"
)
	.trim()
	.split("\n")
	.map(l => JSON.parse(l) as { gameTime: number; data: any })

const prev = samples[0]!
const cur = samples[1]!

/** The event this whole file is about, read straight off the fixture. */
const baron = (cur.data.events?.Events ?? []).find(
	(e: any) => e.EventName === "BaronKill" && e.EventTime > 1409 && e.EventTime < 1410
)
const handle = (n: string): string => String(n).split("#")[0]!
const teamOf = new Map<string, string>(
	(cur.data.allPlayers ?? []).map((p: any) => [handle(p.summonerName ?? p.riotId), p.team])
)

test("the fixture really carries the defect — otherwise the rest of this file proves nothing", () => {
	assert.ok(baron, "expected the 23:29 Baron in the fixture")
	assert.equal(baron.KillerName, "TeemoLuvuh")
	assert.equal(teamOf.get("TeemoLuvuh"), "CHAOS")
	assert.equal(baron.Assisters.length, 5)
	/* A player on the team that LOST the Baron, named as having assisted it. */
	assert.equal(teamOf.get("CoffeePott"), "ORDER")
	assert.ok(baron.Assisters.includes("CoffeePott"))
})

test("a neutral objective's assist list may not be read; everything else's may", () => {
	for (const name of ["DragonKill", "BaronKill", "HeraldKill", "HordeKill"]) {
		assert.equal(assistersAreReadable(name), false, name)
		assert.ok(NEUTRAL_OBJECTIVE_EVENTS.has(name))
	}
	for (const name of ["ChampionKill", "TurretKilled", "InhibKilled", "FirstBlood", "Ace"])
		assert.equal(assistersAreReadable(name), true, name)
})

test("the brief names the Baron and nobody who assisted it", () => {
	const brief = buildBrief({ raw: cur, gameTimeSec: cur.gameTime })
	assert.ok(brief)
	const line = brief.text.split("\n").find(l => l.includes("took Baron"))
	assert.ok(line, "expected the Baron take in the brief")
	assert.ok(!line.includes("assists"), line)
	for (const a of baron.Assisters) assert.ok(!line.includes(a), `${a} survived into: ${line}`)
})

test("the delta's NEW SINCE block carries the same take without its assist list", () => {
	const delta = buildDelta({
		raw: cur,
		gameTimeSec: cur.gameTime,
		previous: { raw: prev, gameTimeSec: prev.gameTime }
	})
	assert.ok(delta)
	const line = delta.text.split("\n").find(l => l.includes("took Baron"))
	assert.ok(line, "expected the Baron in NEW SINCE THE LAST LOOK")
	assert.ok(!line.includes("assists"), line)
	/* His own teammate is the name that made this a lie rather than a rounding error. */
	assert.ok(!delta.text.includes("CoffeePott"), "a teammate was credited with the enemy's Baron")
})

test("champion kills keep their assists — the defect is confined to the neutrals", () => {
	/* 0 of 2,289 recorded live champion kills name the other team, so nothing is dropped there. */
	const tick = projectTick(cur.data)
	assert.ok(tick)
	const kills = tick.events.filter(e => e.name === "ChampionKill")
	assert.ok(kills.length > 0, "expected kills in the fixture")
	assert.ok(kills.some(k => k.assisters.length > 0), "expected at least one assisted kill")
	for (const e of tick.events.filter(e => NEUTRAL_OBJECTIVE_EVENTS.has(e.name)))
		assert.deepEqual(e.assisters, [], `${e.name} at ${e.atSec} kept an assist list`)
})
