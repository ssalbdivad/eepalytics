/**
 * Store what the client actually said, while the game is happening.
 *
 * ## Why this exists
 *
 * `scripts/eval-live.ts` and `scripts/bench-providers.ts` reconstruct game states from the
 * POST-GAME timeline, which is the only record the app kept. That timeline does not contain the
 * enemy jungler's CS, anyone's items, anyone's role, or the live event feed — so every replayed
 * state is missing exactly the facts the coach was rebuilt around.
 *
 * The cost of that is measurable and it misled a benchmark run: over reconstructed states the
 * coach named no action in 50% of its lines, against roughly 11% over states carrying a
 * counterpart. That is not the coach being worse, it is the harness starving it, and a comparison
 * between models run on starved states measures how well each model improvises when given
 * nothing — which is the opposite of what this app wants to know.
 *
 * So: while a game is in progress, append the raw `allgamedata` every few seconds. Then an eval
 * replays a REAL state, with the counterpart, the items and the roles that were actually there.
 *
 * ## Deliberately a file, not the database
 *
 * A sample is ~32 KB of JSON and there are hundreds per game. That is blob-shaped, not row-shaped,
 * and the database is small and precious — it holds every game he has ever played. One
 * newline-delimited file per game keeps SQLite out of the write path of a live game entirely.
 *
 * NODE ONLY.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { DATA_DIR } from "../shared/constants.ts"
import { makeLogger } from "./log.ts"

const log = makeLogger("sampler")

export const SAMPLE_DIR = `${DATA_DIR}/live-samples`

/**
 * How often to keep a sample.
 *
 * The daemon already polls the client faster than this for the coach; sampling every poll would
 * write tens of megabytes per game for data that barely changes between two seconds. Five seconds
 * is fine enough to catch an item completing or a kill, and it is the same cadence the frame
 * journal uses, so a sample and a screenshot line up.
 */
export const SAMPLE_EVERY_SEC = 5

/** Games older than this are pruned. Samples are a debugging and evaluation aid, not history. */
export const SAMPLE_KEEP_DAYS = 7

export interface SamplerState {
	gameId: string
	lastAtSec: number
	count: number
}

let current: SamplerState | null = null

const pathFor = (gameId: string): string => `${SAMPLE_DIR}/${gameId}.ndjson`

/**
 * Record one sample, if enough game time has passed.
 *
 * Never throws: this runs inside the live poll and a full disk must not be able to interrupt a
 * game. It returns whether it wrote, so a caller can report a count without asking again.
 */
export const sampleLive = (input: {
	gameId: string | null
	gameTimeSec: number
	data: unknown
}): boolean => {
	try {
		if (!input.gameId || !Number.isFinite(input.gameTimeSec)) return false
		// A backwards clock is a new game, the same signal the frame journal rolls sessions on.
		if (!current || current.gameId !== input.gameId || input.gameTimeSec < current.lastAtSec - 30)
			current = { gameId: input.gameId, lastAtSec: -Infinity, count: 0 }
		if (input.gameTimeSec - current.lastAtSec < SAMPLE_EVERY_SEC) return false

		mkdirSync(SAMPLE_DIR, { recursive: true })
		appendFileSync(
			pathFor(input.gameId),
			`${JSON.stringify({ atMs: Date.now(), gameTime: input.gameTimeSec, data: input.data })}\n`
		)
		current.lastAtSec = input.gameTimeSec
		current.count += 1
		return true
	} catch (err) {
		log.warn(`sample failed: ${err instanceof Error ? err.message : String(err)}`)
		return false
	}
}

/**
 * Whether a sample is due, WITHOUT reading the client.
 *
 * The supervisor polls every couple of seconds during a game and a sample is wanted every five,
 * so asking first means most ticks cost nothing at all rather than an extra `allgamedata` round
 * trip that is then thrown away.
 *
 * Conservative on purpose: with no game seen yet it says yes, because the first sample of a game
 * is the one worth having and one extra read is cheaper than missing the start.
 */
export const sampleDue = (nowSec?: number): boolean => {
	if (!current) return true
	if (nowSec === undefined) return true
	return nowSec - current.lastAtSec >= SAMPLE_EVERY_SEC
}

/**
 * A key for a game the journal has not opened a session for.
 *
 * Derived from when the game clock read zero, rounded to the minute — stable across the whole
 * game, and different for the next one. Only used when there is no session id, which is the case
 * when he plays with the coach page closed.
 */
export const currentSampleKey = (gameTimeSec: number): string =>
	`g-${Math.round((Date.now() - gameTimeSec * 1000) / 60_000)}`

/** How many samples exist for a game — the number that makes "it is recording" checkable. */
export const sampleCount = (gameId: string): number => {
	const p = pathFor(gameId)
	if (!existsSync(p)) return 0
	return readFileSync(p, "utf8").split("\n").filter(l => l.trim() !== "").length
}

/** Every game with samples on disk, newest first. */
export const sampledGames = (): { gameId: string; samples: number; bytes: number }[] => {
	if (!existsSync(SAMPLE_DIR)) return []
	return readdirSync(SAMPLE_DIR)
		.filter(f => f.endsWith(".ndjson"))
		.map(f => {
			const gameId = f.replace(/\.ndjson$/, "")
			return { gameId, samples: sampleCount(gameId), bytes: statSync(`${SAMPLE_DIR}/${f}`).size }
		})
		.sort((a, b) => b.gameId.localeCompare(a.gameId))
}

/**
 * Read a game's samples back.
 *
 * A torn last line is DROPPED rather than throwing: the daemon can be killed mid-append, and one
 * truncated sample must not cost the whole game's evaluation data.
 */
export const readSamples = (gameId: string): { atMs: number; gameTime: number; data: unknown }[] => {
	const p = pathFor(gameId)
	if (!existsSync(p)) return []
	const out: { atMs: number; gameTime: number; data: unknown }[] = []
	for (const line of readFileSync(p, "utf8").split("\n")) {
		if (line.trim() === "") continue
		try {
			out.push(JSON.parse(line))
		} catch {
			// The tail of a killed process. Everything before it is still good.
		}
	}
	return out
}

/** Drop sample files older than the retention window. Called on daemon start. */
export const pruneSamples = (now = Date.now()): number => {
	if (!existsSync(SAMPLE_DIR)) return 0
	let gone = 0
	for (const f of readdirSync(SAMPLE_DIR)) {
		const p = `${SAMPLE_DIR}/${f}`
		try {
			if (now - statSync(p).mtimeMs > SAMPLE_KEEP_DAYS * 86_400_000) {
				unlinkSync(p)
				gone += 1
			}
		} catch {
			// A file that vanished under us is already what we wanted.
		}
	}
	if (gone > 0) log.info(`pruned ${gone} live-sample file${gone === 1 ? "" : "s"}`)
	return gone
}
