/**
 * `node --experimental-strip-types scripts/recover-coverage.ts [--write]`
 *
 * RECOVER the coverage record from journald, for the games that ended before the record existed.
 *
 * `coach-coverage.ts` began WRITING on 2026-09-22. It has been COMPUTING since it was added, and
 * `main.ts` logged every verdict — so forty-four games of "did the coach run" sat in journald and
 * nowhere else, one rotation from gone, which is the whole defect that commit was about. This reads
 * those lines back.
 *
 * IT RECOVERS, IT DOES NOT INVENT. Every field written here is read out of a log line this app
 * produced: the gameId, the verdict and the note are quoted from the line, and the timestamp is
 * journald's own. What the line does NOT carry is the frame and transcript COUNTS — the daemon
 * logged the verdict, not the arithmetic behind it — so those are written as `-1`, which
 * `judgeCoverage` never produces and which therefore cannot be mistaken for a measurement. The
 * window is recorded as a single instant for the same reason: the log knows when the game ENDED and
 * nothing else.
 *
 * Rows already in the file win. Journald retention on this machine begins mid-2026-09-19, so this
 * recovers what is left rather than everything that happened.
 */

import { execFileSync } from "node:child_process"
import { appendCoverage, readCoverage } from "../src/daemon/coach-coverage.ts"
import type { CoachCoverage, CoverageVerdict } from "../src/daemon/coach-coverage.ts"

const WRITE = process.argv.includes("--write")

const VERDICTS: CoverageVerdict[] = ["coached", "absent", "heard-nothing", "unwatched"]

const lines = execFileSync(
	"journalctl",
	["--user", "-u", "eepalytics", "--since", "30 days ago", "--no-pager", "-o", "short-iso"],
	{ encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
).split("\n")

const rows: CoachCoverage[] = []
for (const line of lines) {
	const m = /^(\S+)\s.*live coach ([a-z-]+): (.*?) gameId=(\d+)\s*$/.exec(line)
	if (!m) continue
	const verdict = m[2] as CoverageVerdict
	if (!VERDICTS.includes(verdict)) continue
	const endedMs = Date.parse(m[1]!)
	if (!Number.isFinite(endedMs)) continue
	rows.push({
		gameId: Number(m[4]),
		startedMs: endedMs,
		endedMs,
		frames: -1,
		lines: -1,
		verdict,
		note: `${m[3]} [recovered from journald; counts were not logged]`
	})
}

const already = new Set(readCoverage(500).map(r => r.gameId))
const fresh = rows.filter(r => r.gameId !== null && !already.has(r.gameId))
const byVerdict: Record<string, number> = {}
for (const r of fresh) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1

console.log(`${rows.length} verdicts in the journal, ${already.size} already recorded, ${fresh.length} to recover`)
console.log(Object.entries(byVerdict).map(([k, v]) => `  ${k}: ${v}`).join("\n") || "  (nothing)")
if (!WRITE) {
	console.log("\ndry run — pass --write to append them")
	process.exit(0)
}
let wrote = 0
for (const r of fresh) if (appendCoverage(r)) wrote++
console.log(`wrote ${wrote} recovered rows`)
