/**
 * HOW LONG AFTER A GAME ENDS CAN HE READ ANYTHING? Measured, from the rows the daemon already
 * writes, so the number can be re-derived at any time rather than quoted from a session.
 *
 * ## Why this exists as a script rather than a paragraph
 *
 * The post-game path is the only part of this product a human has graded good — 37 items, 68%
 * useful, blinded, his own verdicts — and the thing standing between him and it was never quality.
 * It was that a debrief he has to ask for is a debrief he does not read. So the number that
 * matters is a WALL CLOCK from the last second of the game to the moment the review row exists,
 * and it has to be checkable after every change to the chain.
 *
 * ## The four stages, and where each timestamp comes from
 *
 *   game over  -> ingest    `game.endedAtMs` to `game.ingestedAtMs` — dominated by the League
 *                           client, which does not have the match for a minute or so. The app's
 *                           only lever is how often it asks (see `ingestRetryMs`).
 *   ingest     -> analysis  a queue hop plus `analyzeGame`, measured in tens of milliseconds.
 *   analysis   -> review    the model call. `review.durationMs` is the call itself.
 *   review row               `review.createdMs` — the instant the debrief can render.
 *
 * A game with no review row is reported as such rather than dropped: "the review never ran" is
 * the most important thing this can say, and averaging over the games where it did run would
 * hide exactly that.
 *
 * Run: node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/measure-postgame.ts [--games 30]
 */

import { DatabaseSync } from "node:sqlite"
import { DB_PATH } from "../src/shared/constants.ts"

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}

const limit = Number(arg("games", "30"))
const db = new DatabaseSync(DB_PATH, { readOnly: true })

interface Row {
	gameId: number
	endedAtMs: number
	ingestedAtMs: number | null
	durationSec: number
	champion: string
	reviewCreatedMs: number | null
	reviewDurationMs: number | null
	model: string | null
	status: string | null
	costUsd: number | null
	frames: number
}

const rows = (
	db
		.prepare(
			`SELECT g.gameId, g.endedAtMs, g.ingestedAtMs, g.gameDurationSec AS durationSec,
			        g.championName AS champion,
			        r.createdMs AS reviewCreatedMs, r.durationMs AS reviewDurationMs,
			        r.model AS model, r.status AS status, r.costUsd AS costUsd,
			        (SELECT count(*) FROM journal_frame f
			           JOIN journal_session s ON s.id = f.sessionId
			          WHERE s.gameId = g.gameId) AS frames
			   FROM game g
			   LEFT JOIN review r ON r.gameId = g.gameId AND r.kind = 'game'
			  ORDER BY g.endedAtMs DESC
			  LIMIT ?`
		)
		.all(limit) as unknown as Record<string, number | string | null>[]
).map(r => {
	const n = (v: unknown): number | null =>
		typeof v === "bigint" ? Number(v)
		: typeof v === "number" ? v
		: null
	return {
		gameId: n(r.gameId) ?? 0,
		endedAtMs: n(r.endedAtMs) ?? 0,
		ingestedAtMs: n(r.ingestedAtMs),
		durationSec: n(r.durationSec) ?? 0,
		champion: String(r.champion ?? "?"),
		reviewCreatedMs: n(r.reviewCreatedMs),
		reviewDurationMs: n(r.reviewDurationMs),
		model: r.model === null ? null : String(r.model),
		status: r.status === null ? null : String(r.status),
		costUsd: n(r.costUsd),
		frames: n(r.frames) ?? 0
	} satisfies Row
})

const pct = (a: readonly number[], p: number): number | null => {
	if (a.length === 0) return null
	const s = [...a].sort((x, y) => x - y)
	return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] ?? null
}

const secs = (ms: number | null): string => (ms === null ? "—" : `${(ms / 1000).toFixed(0)}s`)

const ingestLag: number[] = []
const reviewLag: number[] = []
const callMs: number[] = []
let reviewed = 0

console.log(
	`game          ended             dur  champion   frames  ->ingest  ->review  call    model                 cost`
)
for (const r of rows) {
	const ing = r.ingestedAtMs === null ? null : r.ingestedAtMs - r.endedAtMs
	const rev = r.reviewCreatedMs === null ? null : r.reviewCreatedMs - r.endedAtMs
	if (ing !== null && ing > 0 && ing < 3_600_000) ingestLag.push(ing)
	if (rev !== null && rev > 0 && rev < 3_600_000) reviewLag.push(rev)
	if (r.reviewDurationMs !== null) callMs.push(r.reviewDurationMs)
	if (r.status === "ok") reviewed++
	console.log(
		`${String(r.gameId).padEnd(13)} ${new Date(r.endedAtMs).toISOString().slice(0, 16)} ` +
			`${String(Math.round(r.durationSec / 60)).padStart(3)}m ${r.champion.padEnd(10)} ` +
			`${String(r.frames).padStart(6)}  ${secs(ing).padStart(8)}  ${secs(rev).padStart(8)}  ` +
			`${secs(r.reviewDurationMs).padStart(6)}  ${(r.model ?? "—").padEnd(21)} ` +
			`${r.costUsd === null ? "—" : `$${r.costUsd.toFixed(4)}`}`
	)
}

console.log(`\n${rows.length} games · ${reviewed} with a stored review (${((reviewed / Math.max(1, rows.length)) * 100).toFixed(0)}%)`)
console.log(
	`game over -> ingested:  n=${ingestLag.length}  p50 ${secs(pct(ingestLag, 0.5))}  p90 ${secs(pct(ingestLag, 0.9))}`
)
console.log(
	`game over -> review:    n=${reviewLag.length}  p50 ${secs(pct(reviewLag, 0.5))}  p90 ${secs(pct(reviewLag, 0.9))}`
)
console.log(
	`the model call itself:  n=${callMs.length}  p50 ${secs(pct(callMs, 0.5))}  p90 ${secs(pct(callMs, 0.9))}`
)
if (reviewed === 0)
	console.log(
		`\nNO GAME IN THIS WINDOW HAS A REVIEW. Check \`autoReviewNewGames\` in Settings — with it off, nothing downstream of analysis ever runs.`
	)
