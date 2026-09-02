/**
 * Test fixtures: 20 real ranked-solo games of the user's, pulled from the live LCU on
 * 2026-09-02 and frozen here so every assertion in `src/analysis/*.test.ts` is re-runnable
 * evidence rather than a one-off measurement.
 *
 * Games age out of the LCU's 20-game history window but stay fetchable by id forever, so
 * these files are the only copy of some of them that will not disappear. They are gzipped
 * (380 KB for 20 matches + 20 timelines; ~2.4 MB raw) and are byte-identical to what
 * `/lol-match-history/v1/games/{id}` and `/game-timelines/{id}` returned.
 *
 * Node only — uses `node:fs`.
 */

import { readdirSync, readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { LcuGame, LcuTimeline } from "../../shared/schema/lcu.ts"

const DIR = dirname(fileURLToPath(import.meta.url))

/** The reference game used throughout `.research/analytics.md` (38:30, user is participant 7). */
export const REFERENCE_GAME_ID = 5633857616
/** A 7:33 early surrender — the degraded case: 8 position samples, ADC/SUP split unreliable. */
export const SHORT_GAME_ID = 5633851596
/** The longest game in the corpus (48:32). */
export const LONG_GAME_ID = 5633326992

export const fixtureGameIds = (): number[] =>
	readdirSync(DIR)
		.filter(f => f.endsWith(".game.json.gz"))
		.map(f => Number(f.split(".")[0]))
		.sort((a, b) => a - b)

const read = <T,>(file: string): T =>
	JSON.parse(gunzipSync(readFileSync(`${DIR}/${file}`)).toString("utf8")) as T

export const loadMatch = (gameId: number): LcuGame =>
	read<LcuGame>(`${gameId}.game.json.gz`)

export const loadTimeline = (gameId: number): LcuTimeline =>
	read<LcuTimeline>(`${gameId}.timeline.json.gz`)

export interface Fixture {
	gameId: number
	match: LcuGame
	timeline: LcuTimeline
}

export const loadFixture = (gameId: number): Fixture => ({
	gameId,
	match: loadMatch(gameId),
	timeline: loadTimeline(gameId)
})

/** All 20, oldest first. */
export const loadAll = (): Fixture[] =>
	fixtureGameIds()
		.map(loadFixture)
		.sort((a, b) => a.match.gameCreation - b.match.gameCreation)
