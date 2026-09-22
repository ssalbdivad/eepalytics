/**
 * Store what the client actually said, while the game is happening.
 *
 * ## Why this exists
 *
 * `scripts/eval-live.ts` and `scripts/bench-providers.ts` (both since deleted) reconstructed game
 * states from the POST-GAME timeline, which was the only record the app kept. That timeline does not contain the
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

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
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

/**
 * THERE IS NO AGE BOUND ANY MORE, and removing it is the whole point of this constant's absence.
 *
 * The premise of an age bound was the sentence that used to sit here: "samples are a debugging and
 * evaluation aid, not history." That stopped being true when `scripts/bench-stream.ts` became the
 * only harness — every game it can bench is a file in this directory and nothing else on the
 * machine holds the raw client JSON. `--games all` reads exactly these, so an aged-out game is a
 * game whose numbers can never be re-derived, and this project's rule is that a stored measurement
 * is never deleted.
 *
 * This is not hypothetical twice over. `isRecorderFile` below records the first loss — four
 * hand-placed corpus games destroyed by a routine restart on 2026-09-12 — and the guard it added
 * covered only files a human had placed. The recorder's OWN files were by then the corpus: measured
 * at 02:28 the same day, six of the twenty-eight benchable games sat between 6.10 and 6.46 days
 * against this seven-day bound, among them the ONLY paired Gwen game (370 samples, 48 journal
 * frames) and the negative control for the `+noown` knowledge ablation. The next daemon start
 * inside thirteen hours would have taken all six, for the second time in one day.
 *
 * `SAMPLE_MAX_BYTES` is kept and is now the only bound, because disk was the only thing age was
 * ever protecting and the ceiling protects it directly. That paragraph used to end "measured, the
 * whole corpus is 275 MB of 600. The failure mode is therefore the directory grows until someone
 * looks at it rather than it silently destroys evidence, which is the right way round."
 *
 * **IT CROSSED THE CEILING AND DESTROYED EVIDENCE.** Measured 2026-09-22: 628 MB of 600, and the
 * two windows that every frame measurement in this repo was taken on —
 * `js-mtvxb5f4-f81a-t29817812` (game 5639406342, Lillia vs Kayn) and `…-t29817845` (5639409343,
 * Lillia vs Fiddlesticks) — were already gone, evicted oldest-first by a routine daemon restart.
 * `discoverBenchable()` no longer returns them in ANY category, not even `rejected`. The stored
 * outputs in `data/eval/` survive, so the numbers stay quotable; the INPUTS do not, so
 * `frame-power`, `frame-value`, `frame-cadence` and `model-race` can never be re-run or extended
 * on the corpus they were measured on. That is the third time this directory has eaten its own
 * evidence and the first two are recorded above.
 *
 * So the ceiling now yields to the evidence rather than the other way round: `citedSampleFiles()`
 * reads `data/eval/` for the window ids stored runs name, and `pruneSamples` will not evict one.
 * If the ceiling cannot be met without taking a cited window, NOTHING IS TAKEN and the daemon says
 * so — a full disk is a problem a person can fix, and a destroyed measurement is not.
 */

/**
 * A ceiling on the whole directory, because age alone does not bound disk.
 *
 * Measured on a real game: 16 samples took 516 KB, so a thirty-minute game is about 11 MB. A
 * heavy day inside the retention window is a gigabyte, on a machine whose SQLite database — the
 * thing that actually matters — is seven. Oldest games go first once the ceiling is crossed.
 */
export const SAMPLE_MAX_BYTES = 600 * 1024 * 1024

export interface SamplerState {
	gameId: string
	/** The file this game is actually appending to — `gameId` plus a per-game stamp. */
	key: string
	lastAtSec: number
	count: number
}

/**
 * A stamp that is constant within one game and different for the next.
 *
 * The wall-clock instant the game clock read zero, to the minute. Two games cannot start in the
 * same minute on one machine, and every sample of one game agrees on it.
 */
const gameStamp = (gameTimeSec: number): string =>
	`t${Math.round((Date.now() - gameTimeSec * 1000) / 60_000)}`

let current: SamplerState | null = null

const pathFor = (gameId: string): string => `${SAMPLE_DIR}/${gameId}.ndjson`

/**
 * Whether the RECORDER wrote this file, and therefore whether the prune may delete it.
 *
 * `pruneSamples` used to delete anything in the directory old enough or big enough to qualify,
 * and that is not safe, because this directory holds two different kinds of file. The recorder
 * writes `<sessionId>-t<stamp>.ndjson` and owns those completely — they are a debugging aid and
 * are meant to age out. But the measurement work also PLACES files here by hand: `split-01..04`
 * were one multi-game capture cut into its four games, and they were the paired corpus that
 * `scripts/lib/stream.ts`, `scripts/measure-staleness.ts` and six tests in `coach-memory.test.ts`
 * and `stream.test.ts` all read by name.
 *
 * On 2026-09-12 a routine daemon restart deleted all five of them — the four splits and the
 * multi-game source they were cut from — because they were more than seven days old. Nothing
 * else on the machine held a copy. The stored RESULTS in `data/eval/` survive, but the raw
 * client JSON behind them does not, so those four games' numbers can never be re-derived. Six
 * tests went from passing to skipped in the same restart, which is the only reason it was
 * noticed at all.
 *
 * So the prune is now allowed to delete only files matching the recorder's own naming. Anything
 * a human put here is left alone at any age and counts against no ceiling. The bounds still do
 * their job — every file the recorder has ever written matches — and the failure mode changes
 * from "silently destroys evidence" to "the directory grows until someone looks at it", which is
 * the right way round for a directory whose whole purpose is keeping measurements re-derivable.
 */
const isRecorderFile = (name: string): boolean => /-t\d+\.ndjson$/.test(name)

/** Where the cited-window index is cached, so a 1 GB scan does not run on every daemon start. */
const CITED_INDEX = `${SAMPLE_DIR}/.cited.json`

/**
 * Window ids look like `js-<session>-t<stamp>` or `g-<stamp>-t<stamp>`, and a stored run names them
 * verbatim — in `windows`, in an arm's `window` field, in a prose note. One pattern finds all of
 * them wherever they sit in the JSON, which is the point: the index does not have to know the
 * shape of every run file ever written, only what a window id looks like.
 */
const WINDOW_ID = /\b(?:js-[a-z0-9]+-[a-z0-9]+|g-\d+)-t\d+\b/g

/**
 * Every sample file that a stored measurement in `data/eval/` names.
 *
 * ## Why it is cached, and what the cache key is
 *
 * `data/eval/` is 989 MB across 441 files, so scanning it is a real cost to pay on a daemon start
 * that usually has nothing to do. The cache is keyed on the directory's file COUNT and its newest
 * mtime: a new run lands as a new file with a new mtime, so the scan re-runs exactly when a
 * measurement is added and never otherwise. 441 stats is microseconds.
 *
 * ## Why it fails OPEN
 *
 * If the scan cannot be done — unreadable directory, malformed cache, anything — this returns a
 * set that protects EVERYTHING it managed to read, and `pruneSamples` treats a failed scan as "do
 * not evict". The asymmetry is deliberate and it is the whole lesson of this file: an unpruned
 * directory costs disk, and a wrongly pruned one costs a measurement that cannot be taken again.
 */
export const citedSampleFiles = (evalDir = `${DATA_DIR}/eval`): { ids: Set<string>; scanned: number; cached: boolean } => {
	let names: string[] = []
	try {
		names = readdirSync(evalDir).filter(n => n.endsWith(".json") || n.endsWith(".md") || n.endsWith(".txt"))
	} catch {
		return { ids: new Set(), scanned: 0, cached: false }
	}

	let newest = 0
	for (const n of names) {
		try {
			newest = Math.max(newest, statSync(`${evalDir}/${n}`).mtimeMs)
		} catch {
			/* a file that vanished cannot be cited */
		}
	}
	const key = `${names.length}:${newest}`

	try {
		const cached = JSON.parse(readFileSync(CITED_INDEX, "utf8")) as { key?: string; ids?: string[] }
		if (cached.key === key && Array.isArray(cached.ids))
			return { ids: new Set(cached.ids), scanned: names.length, cached: true }
	} catch {
		/* no usable cache; scan */
	}

	const ids = new Set<string>()
	for (const n of names) {
		try {
			for (const m of readFileSync(`${evalDir}/${n}`, "utf8").matchAll(WINDOW_ID)) ids.add(m[0])
		} catch {
			/* unreadable evidence protects nothing, and must not stop the rest */
		}
	}
	try {
		mkdirSync(SAMPLE_DIR, { recursive: true })
		writeFileSync(CITED_INDEX, `${JSON.stringify({ key, ids: [...ids] })}\n`)
	} catch {
		/* a cache we cannot write is a scan we repeat, which is only slow */
	}
	return { ids, scanned: names.length, cached: false }
}

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
		/*
		 * The FILE must roll with the game, not with the caller's id.
		 *
		 * The caller passes the journal session id, and a journal session outlives a game — he
		 * leaves the coach page open all evening. So four consecutive games appended to one
		 * file: measured, 1221 lines under a single key holding four distinct rosters. Anything
		 * scored from that file was scored against a roster from a different game, which is the
		 * exact confusion this app exists to prevent. Rolling the key on the backwards clock
		 * (the same signal the frame journal uses) keeps one file per game.
		 */
		if (!current || current.gameId !== input.gameId || input.gameTimeSec < current.lastAtSec - 30)
			current = {
				gameId: input.gameId,
				key: `${input.gameId}-${gameStamp(input.gameTimeSec)}`,
				lastAtSec: -Infinity,
				count: 0
			}
		if (input.gameTimeSec - current.lastAtSec < SAMPLE_EVERY_SEC) return false

		mkdirSync(SAMPLE_DIR, { recursive: true })
		appendFileSync(
			pathFor(current.key),
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

/**
 * Every file belonging to a key: the key itself, plus every per-game roll of it.
 *
 * A caller holds a JOURNAL SESSION id, which can span an evening of games, while a file now holds
 * exactly one game. Resolution lives here so callers keep saying "this session" and still get one
 * game's data rather than four games concatenated.
 */
const filesFor = (gameId: string): string[] => {
	if (!existsSync(SAMPLE_DIR)) return []
	const exact = `${gameId}.ndjson`
	return readdirSync(SAMPLE_DIR)
		.filter(f => f.endsWith(".ndjson") && (f === exact || f.startsWith(`${gameId}-`)))
		.sort()
}

/** How many samples exist for a game — the number that makes "it is recording" checkable. */
export const sampleCount = (gameId: string): number =>
	filesFor(gameId)
		.map(f => readFileSync(`${SAMPLE_DIR}/${f}`, "utf8").split("\n").filter(l => l.trim() !== "").length)
		.reduce((a, b) => a + b, 0)

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
	/*
	 * The NEWEST single game, never a concatenation.
	 *
	 * A session id can name several games. Returning all of them looks like more data and is
	 * worse than none: it was measured once, 1221 samples under one key carrying four different
	 * rosters, and anything scored against it compared a screenshot to another game's team. Use
	 * `sampledGames()` and pass a per-game key to choose a specific one.
	 */
	const files = filesFor(gameId)
	if (files.length === 0) return []
	const p = `${SAMPLE_DIR}/${files[files.length - 1]}`
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

/**
 * Drop sample files once the directory outgrows its ceiling. Called on daemon start.
 *
 * SIZE IS THE ONLY BOUND — see the note where `SAMPLE_KEEP_DAYS` used to be. A month-old game is
 * kept forever on purpose now: if he stopped playing, that game is the whole corpus. Oldest first
 * once the ceiling is crossed, so the game he just played is the last thing to go.
 *
 * The ceiling is a PARAMETER rather than a read of the constant so that the eviction it performs
 * can be tested at all. It defaults to `SAMPLE_MAX_BYTES` and the daemon never passes anything, so
 * the shipped behaviour is the constant; a test can hand it a ceiling of a few bytes instead of
 * writing 600 MB to prove the ordering. The parameter it replaces was `now`, which existed only
 * for the age bound that is gone.
 */
export const pruneSamples = (maxBytes = SAMPLE_MAX_BYTES, citedIds?: Set<string>): number => {
	if (!existsSync(SAMPLE_DIR)) return 0
	let gone = 0
	const drop = (p: string): void => {
		try {
			unlinkSync(p)
			gone += 1
		} catch {
			// A file that vanished under us is already what we wanted.
		}
	}

	const live: { path: string; mtime: number; size: number }[] = []
	for (const f of readdirSync(SAMPLE_DIR)) {
		// Not ours, not ours to delete — see `isRecorderFile`.
		if (!isRecorderFile(f)) continue
		const p = `${SAMPLE_DIR}/${f}`
		try {
			const st = statSync(p)
			live.push({ path: p, mtime: st.mtimeMs, size: st.size })
		} catch {
			// Raced with something else; nothing to do.
		}
	}

	let total = live.reduce((n, f) => n + f.size, 0)
	/*
	 * WHAT A STORED MEASUREMENT NAMES IS NOT EVICTABLE. See `citedSampleFiles` for why this is the
	 * bound that yields last, and the header for the three corpora this directory has already eaten.
	 */
	const cited = citedIds ?? citedSampleFiles().ids
	const isCited = (path: string): boolean =>
		cited.has(path.slice(path.lastIndexOf("/") + 1).replace(/\.ndjson$/, ""))

	// Oldest first, so the game he just played is the last thing to go.
	live.sort((a, b) => a.mtime - b.mtime)
	let protectedBytes = 0
	for (const f of live) {
		if (total <= maxBytes) break
		if (isCited(f.path)) {
			protectedBytes += f.size
			continue
		}
		drop(f.path)
		total -= f.size
	}

	if (gone > 0) log.info(`pruned ${gone} live-sample file${gone === 1 ? "" : "s"}`)
	if (total > maxBytes)
		log.warn(
			`live-samples is ${(total / 1024 / 1024).toFixed(0)} MB over a ${(maxBytes / 1024 / 1024).toFixed(0)} MB ceiling ` +
				`and ${(protectedBytes / 1024 / 1024).toFixed(0)} MB of it is cited by a stored measurement in data/eval/. ` +
				`Nothing cited was deleted. Raise SAMPLE_MAX_BYTES or archive the corpus by hand.`
		)
	return gone
}
