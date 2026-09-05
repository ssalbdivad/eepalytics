/**
 * The two pieces of `scripts/eval-useful.ts` that are not delegated.
 *
 * Everything else in that script is the shipped path — `buildLiveStateForBench`, `renderState`,
 * `buildFacts` through `state.unseen`, `coachTurn` — and testing those here would be testing a
 * copy. What is left is the harness's own: turning a recorded `allgamedata` sample into the
 * `CoachState` the staleness check needs, and stepping the ranker over a game.
 *
 * The samples below are SYNTHETIC and minimal. They are shaped like the Live Client Data API's
 * payload because that is what the code under test parses; no figure in them is a measurement of
 * anything, and none is meant to look like one.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { coachStateFrom, replay } from "../../scripts/eval-useful.ts"

const player = (over: Record<string, unknown> = {}) => ({
	riotId: "Someone#NA1",
	summonerName: "Someone",
	championName: "Ornn",
	team: "CHAOS",
	level: 9,
	isDead: false,
	respawnTimer: 0,
	position: "TOP",
	scores: { kills: 0, deaths: 0, assists: 0, creepScore: 0 },
	items: [],
	summonerSpells: {
		summonerSpellOne: { displayName: "Flash" },
		summonerSpellTwo: { displayName: "Teleport" }
	},
	...over
})

const sample = (over: Record<string, unknown> = {}) => ({
	atMs: 0,
	gameTime: 600,
	data: {
		activePlayer: { riotId: "Me#NA1", summonerName: "Me", currentGold: 700 },
		allPlayers: [
			player({ riotId: "Me#NA1", summonerName: "Me", championName: "Lillia", team: "ORDER", position: "JUNGLE" }),
			player({ riotId: "Ally#NA1", summonerName: "Ally", championName: "Urgot", team: "ORDER" }),
			player({
				riotId: "Jungler#NA1",
				summonerName: "Jungler",
				championName: "Briar",
				team: "CHAOS",
				position: "JUNGLE"
			}),
			player({ riotId: "Enemy#NA1", summonerName: "Enemy", championName: "Jhin", team: "CHAOS", position: "BOTTOM" })
		],
		events: { Events: [] },
		...over
	}
})

describe("coachStateFrom", () => {
	it("finds the enemy jungler by declared position", () => {
		const s = coachStateFrom(sample())!
		assert.equal(s.counterpart!.champion, "Briar")
		assert.equal(s.enemiesAlive, 2)
		assert.equal(s.alliesAlive, 2)
		assert.equal(s.meDeadForSec, null)
		assert.equal(s.currentGold, 700)
	})

	it("falls back to Smite when no position is declared, the same order live.ts uses", () => {
		const raw = sample()
		raw.data.allPlayers[2]!.position = ""
		raw.data.allPlayers[2]!.summonerSpells = {
			summonerSpellOne: { displayName: "Smite" },
			summonerSpellTwo: { displayName: "Flash" }
		}
		assert.equal(coachStateFrom(raw)!.counterpart!.champion, "Briar")
	})

	it("reports his own respawn, which is what makes a window reachable", () => {
		const raw = sample()
		raw.data.allPlayers[0]!.isDead = true
		raw.data.allPlayers[0]!.respawnTimer = 19
		const s = coachStateFrom(raw)!
		assert.equal(s.meDeadForSec, 19)
		// He does not count himself among the living while he is on the grey screen.
		assert.equal(s.alliesAlive, 1)
	})

	it("lists only dead ENEMIES, with the jungler flagged", () => {
		const raw = sample()
		raw.data.allPlayers[2]!.isDead = true
		raw.data.allPlayers[2]!.respawnTimer = 25
		raw.data.allPlayers[1]!.isDead = true
		raw.data.allPlayers[1]!.respawnTimer = 30
		const s = coachStateFrom(raw)!
		assert.deepEqual(s.deadEnemies, [{ champion: "Briar", respawnSec: 25, isJungler: true }])
	})

	it("counts an objective for the side that took it, and an unresolvable killer for nobody", () => {
		const raw = sample({
			events: {
				Events: [
					{ EventName: "DragonKill", EventTime: 480, KillerName: "Jungler#NA1" },
					{ EventName: "HeraldKill", EventTime: 540, KillerName: "Me#NA1" },
					// A minion, a turret, or a name the feed spells differently. Never an accusation.
					{ EventName: "BaronKill", EventTime: 560, KillerName: "Nobody#NA1" }
				]
			}
		})
		const s = coachStateFrom(raw)!
		assert.deepEqual(s.objectiveCount, { mine: 1, theirs: 1 })
		assert.deepEqual(
			s.enemyObjectives.map(o => o.name),
			["DragonKill"]
		)
		// Respawn countdowns are derived from the take this replay actually saw.
		assert.equal(s.drakeBackInSec, 480 + 300 - 600)
		assert.equal(s.baronBackInSec, 560 + 360 - 600)
	})

	it("returns null for a sample with no active player, rather than inventing one", () => {
		const raw = sample()
		raw.data.activePlayer = { riotId: "Ghost#NA1", summonerName: "Ghost", currentGold: 0 }
		assert.equal(coachStateFrom(raw), null)
	})
})

describe("replay", () => {
	const rows = Array.from({ length: 40 }, (_, i) => {
		const r = sample()
		r.gameTime = i * 6
		return r
	})

	it("steps a turn at the cadence, not at every sample", () => {
		/*
		 * 40 samples 6s apart over 234s. A 20s cadence lands on the next sample at or past the
		 * deadline, so the real spacing is 24s and there are 10 turns — the same quantisation the
		 * daemon has in a real game, where the sampler asks for 5s and lands 6.10s apart.
		 */
		const turns = replay(rows, 20, 0, 999)
		assert.equal(turns.length, 10)
		for (let i = 1; i < turns.length; i++)
			assert.ok(turns[i]!.atSec - turns[i - 1]!.atSec >= 20, `${turns[i - 1]!.atSec} -> ${turns[i]!.atSec}`)
	})

	it("steps EVERY turn from the start of the game but only sends the window", () => {
		/*
		 * `buildFacts` mutates a module-scoped memory: what may be said now depends on what was said
		 * forty seconds ago and on how many gold lines this game has already spent. A replay that
		 * started at --from would be a different coach, so the whole game is stepped and `sent`
		 * marks the window.
		 */
		const turns = replay(rows, 20, 120, 3)
		assert.ok(turns.length > 3)
		const sent = turns.filter(t => t.sent)
		assert.equal(sent.length, 3)
		assert.ok(sent[0]!.atSec >= 120, String(sent[0]!.atSec))
		assert.ok(turns.some(t => !t.sent && t.atSec < 120))
	})

	it("carries the roster and the spoken respellings for every turn it produces", () => {
		const t = replay(rows, 20, 0, 1)[0]!
		assert.ok(t.roster.includes("Lillia"))
		assert.ok(t.roster.includes("Briar"))
		assert.equal(t.roster.length, 4)
		assert.equal(t.block, t.block.trim() === "" ? "" : t.block)
		assert.ok(t.block.includes("Lillia"))
		assert.ok(Array.isArray(t.offered))
	})

	it("skips a sample that cannot make a state rather than faking one", () => {
		const broken = sample()
		broken.gameTime = 300
		broken.data.activePlayer = { riotId: "Ghost#NA1", summonerName: "Ghost", currentGold: 0 }
		const turns = replay([rows[0]!, broken], 1, 0, 999)
		assert.equal(turns.length, 1)
		assert.equal(turns[0]!.atSec, 0)
	})
})
