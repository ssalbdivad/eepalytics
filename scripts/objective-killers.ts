/**
 * WHO CAN THE DIGEST NAME ON AN OBJECTIVE ROW, AND WHO CAN IT NOT?
 *
 * This is the script behind every figure in `data/eval/digest-objective-killers-20260922.md` and
 * behind the counts written into the comments in `src/daemon/digest.ts` and `src/review/prompt.ts`.
 * It exists so those numbers can be re-derived rather than believed: the change it measures —
 * carrying `ELITE_MONSTER_KILL.killerId` through to the digest's OBJECTIVES rows — is worth
 * exactly the share of rows that can name a champion, and nothing else.
 *
 * `src/daemon/digest.objectives.test.ts` pins the same properties on the 20 COMMITTED fixtures and
 * runs in the suite. This script is the other half: it asks the whole stored library, which is
 * larger, private, and cannot live in a test.
 *
 * Two modes:
 *
 *   --census   every ELITE_MONSTER_KILL and BUILDING_KILL in every game with a stored timeline:
 *              how many seat a killer, how many do not, what the unattributed ones ARE, and
 *              whether the ordinal convention (participant 1-5 is team 100) agrees with the
 *              participant rows. No digest is built; this is the raw feed.
 *
 *   (default)  rebuilds the digest for the N most recent ranked-solo jungle games and counts the
 *              RENDERED rows: named, unattributed, nameless kind, and how much of the early
 *              objective ledger is buildings.
 *
 *   cd /home/ssalb/eepalytics && node --experimental-strip-types --no-warnings=ExperimentalWarning \
 *     scripts/objective-killers.ts [--games 20] [--print 1] [--census]
 *
 * THE DB CONNECTION IS READ ONLY. The daemon may be running; nothing here may disturb it.
 */

import { DatabaseSync } from "node:sqlite"
import { readFileSync } from "node:fs"
import { DB_PATH } from "../src/shared/constants.ts"
import { useDb } from "../src/db/index.ts"

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] !== undefined ? String(process.argv[i + 1]) : fallback
}
const GAMES = Number(arg("games", "20"))
const PRINT = Number(arg("print", "1"))
const CENSUS = process.argv.includes("--census")

// Before anything imports a query module: the singleton must be the read-only handle, or
// `getDb()` would open a writable connection and run migrations under a live daemon.
useDb(new DatabaseSync(DB_PATH, { readOnly: true }))

const { getGame, getParticipants, getMetrics, getMoments } = await import("../src/db/queries.ts")
const { loadTimeline } = await import("../src/daemon/corpus.ts")
const { buildGameDigest } = await import("../src/daemon/digest.ts")
const { extractPersona, gamePrompt } = await import("../src/review/prompt.ts")
const { ANALYSIS_VERSION } = await import("../src/shared/constants.ts")

const db = new DatabaseSync(DB_PATH, { readOnly: true })
const pct = (a: number, b: number): string => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(1)}%`)
const clock = (sec: number): string =>
	`${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`

if (CENSUS) {
	const ids = db
		.prepare(`SELECT gameId FROM game WHERE timelineBlob IS NOT NULL ORDER BY endedAtMs DESC`)
		.all() as unknown as { gameId: number | bigint }[]

	const c = { games: 0, elite: 0, eliteSeated: 0, bld: 0, bldSeated: 0, ordinalMismatch: 0, seatMissing: 0 }
	const unattributed = new Map<string, number>()
	for (const row of ids) {
		const gameId = Number(row.gameId)
		const timeline = loadTimeline(gameId)
		if (!timeline) continue
		c.games++
		const seats = new Map(getParticipants(gameId).map(p => [p.participantId, p]))
		for (const frame of timeline.frames)
			for (const event of frame.events ?? []) {
				const e = event as { type?: string; killerId?: number; timestamp?: number; monsterType?: string }
				if (e.type !== "ELITE_MONSTER_KILL" && e.type !== "BUILDING_KILL") continue
				const killerId = typeof e.killerId === "number" && e.killerId > 0 ? e.killerId : null
				const seat = killerId === null ? null : (seats.get(killerId) ?? null)
				if (killerId !== null && seat === null) c.seatMissing++
				if (seat && (killerId! <= 5 ? 100 : 200) !== seat.teamId) c.ordinalMismatch++
				if (e.type === "ELITE_MONSTER_KILL") {
					c.elite++
					if (killerId !== null) c.eliteSeated++
					else {
						const key = `${e.monsterType} at ${clock(Math.round((e.timestamp ?? 0) / 1000))}`
						unattributed.set(key, (unattributed.get(key) ?? 0) + 1)
					}
				} else {
					c.bld++
					if (killerId !== null) c.bldSeated++
				}
			}
	}
	console.log(
		`games with a timeline ${c.games}\n` +
			`elite kills    ${c.elite}\tseated killer ${c.eliteSeated} (${pct(c.eliteSeated, c.elite)})\tkillerId 0: ${c.elite - c.eliteSeated}\n` +
			`building kills ${c.bld}\tseated killer ${c.bldSeated} (${pct(c.bldSeated, c.bld)})\tkillerId 0: ${c.bld - c.bldSeated}\n` +
			`ordinal rule (id<=5 is team 100) disagreeing with the participant row: ${c.ordinalMismatch}\n` +
			`killerId with no participant row: ${c.seatMissing}\n` +
			`the killer-less elite kills, by what and when:\n${[...unattributed]
				.sort((a, b) => b[1] - a[1])
				.map(([k, n]) => `  ${k}  x${n}`)
				.join("\n")}`
	)
} else {
	const rows = db
		.prepare(
			`SELECT g.gameId FROM game g
			  WHERE g.queueId = 420 AND g.role = 'JGL' AND g.gameDurationSec >= 900
			    AND g.timelineBlob IS NOT NULL
			    AND (SELECT count(*) FROM metric m WHERE m.gameId = g.gameId) > 0
			  ORDER BY g.endedAtMs DESC LIMIT ?`
		)
		.all(GAMES) as unknown as { gameId: number | bigint }[]

	const persona = extractPersona(readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8"), "AGENTS.md")
	const c = { elite: 0, eliteNamed: 0, unattributed: 0, bld: 0, bldNamed: 0, noKind: 0, early: 0, earlyBld: 0 }
	let printed = 0

	for (const r of rows) {
		const gameId = Number(r.gameId)
		const game = getGame(gameId)
		if (!game) continue
		const digest = buildGameDigest({
			game,
			participants: getParticipants(gameId),
			metrics: getMetrics(gameId),
			moments: getMoments(gameId),
			timeline: loadTimeline(gameId),
			hasFrames: false,
			analysisVersion: ANALYSIS_VERSION
		})
		for (const o of digest.objectives ?? []) {
			const building = o.kind.endsWith("_BUILDING")
			const named = typeof o.takenByChampion === "string" && o.takenByChampion !== ""
			if (o.kind === "") c.noKind++
			if (o.tSec <= 600) {
				c.early++
				if (building) c.earlyBld++
			}
			if (building) {
				c.bld++
				if (named) c.bldNamed++
			} else {
				c.elite++
				if (named) c.eliteNamed++
				if (o.takenBy === "unattributed") c.unattributed++
			}
		}
		if (printed < PRINT) {
			printed++
			const user = gamePrompt(digest, { intensity: 0.6, model: "(none)", persona }).user
			const block = user.split("\n## ").find(s => s.startsWith("OBJECTIVES"))
			console.log(`\n===== game ${gameId} =====\n## ${block?.trim()}\n`)
		}
	}

	console.log(
		`games ${rows.length}\n` +
			`elite rows    ${c.elite}\tchampion named ${c.eliteNamed} (${pct(c.eliteNamed, c.elite)})\tunattributed ${c.unattributed}\n` +
			`building rows ${c.bld}\tchampion named ${c.bldNamed} (${pct(c.bldNamed, c.bld)})\n` +
			`rows with no kind at all: ${c.noKind}\n` +
			`rows at or before 10:00: ${c.early} — ${c.earlyBld} of them buildings (${pct(c.earlyBld, c.early)})`
	)
}
