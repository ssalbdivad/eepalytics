/**
 * THE RESPAWN CLOCK, BEFORE AND AFTER — re-derivable, on the stored runs.
 *
 * The payload used to state a death ONE WAY ROUND: `back in Ns`, the time REMAINING, because that
 * is the only death figure the Live Client Data API carries. The sentence a coach reaches for is
 * the ELAPSED one, so the model converted one into the other. Measured over the two stored runs of
 * 2026-09-12: 153 spoken lines state an elapsed death time and 71 of them contradict the client's
 * own kill log. The error is one-sided — 101 overstate against 4 that understate — and 101 of 115
 * spoke a number within ten seconds of the remaining figure printed beside them. Nothing was
 * fabricated: the payload gave one number and the sentence needed the other.
 *
 * The fix is `coach-memory.ts`'s `deadAt`: the death INSTANT, watched, from the client's own kill
 * log or from the alive->dead edge between two samples. `live-brief.ts` renders both figures at
 * every site that renders one. Nothing subtracts a respawn timer from a respawn length to get
 * there — respawn length grows with game time and is a patch value this app may not hardcode.
 *
 * WHAT THIS CAN AND CANNOT SHOW. Those 153 lines cannot be re-spoken here; they are stored
 * measurements and no model is re-asked. What is measured is the INPUT: replay each of those turns
 * through the memory and the brief as they now stand, and ask whether the payload states the
 * elapsed figure the sentence needed. A turn where it does can no longer be produced by converting
 * a respawn timer. A turn where it does not is the residual, and it renders NOT KNOWN.
 *
 *   node --experimental-strip-types scripts/measure-deadclock.ts [--out data/eval/deadclock.json]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { isSilent, wilson } from "../src/analysis/coach-score.ts"
import { deathsSeen, newMemory, observe } from "../src/analysis/coach-memory.ts"
import type { MemoryState } from "../src/analysis/coach-memory.ts"

/** "dead FOR n seconds" — elapsed. The payload only ever rendered "back in n", which is remaining. */
const ELAPSED =
	/\b(?:dead|down|gone)\s+(?:for|since)\s+(?:over\s+|about\s+|nearly\s+|more than\s+)?([a-z0-9-]+)\s*(?:seconds|secs|s\b)/i

/** The list the original scratchpad measurement used, kept so the before figure is the same 71/153. */
const WORDS: Record<string, number> = { thirty: 30, twenty: 20, forty: 40, sixty: 60 }

const RUNS = [
	["CORPUS", "data/eval/integrate2-corpus-20260912.json", "gemini-http"],
	["SOCKET", "data/eval/integrate2-socket-20260912.json", "gemini-live"]
] as const

interface Sample {
	gameTime: number
	data: Record<string, unknown>
}

const samplesOf = (file: string): Sample[] =>
	readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map(l => JSON.parse(l) as Sample)

const playersOf = (s: Sample) =>
	s.data.allPlayers as { championName: string; isDead: boolean; riotIdGameName?: string }[]

const pct = (a: number, b: number): string => {
	const w = wilson(a, b)
	return `${a}/${b} = ${(100 * w.p).toFixed(0)}% [${(100 * w.lo).toFixed(0)}-${(100 * w.hi).toFixed(0)}]`
}

type Verdict = "exact" | "bound" | "not-known" | "no-subject"

const rows: {
	run: string
	clock: string
	said: string
	killAgeSec: number | null
	inverted: boolean
	subject: string | null
	verdict: Verdict
	statedElapsedSec: number | null
	deadThatTurn: number
	unwatchedThatTurn: string[]
}[] = []

for (const [label, file, arm] of RUNS) {
	const run = JSON.parse(readFileSync(file, "utf8"))
	const windows = new Map<string, string>(
		(run.windows as { id: string; sampleFile: string }[]).map(w => [w.id, w.sampleFile])
	)
	const cache = new Map<string, Sample[]>()
	for (const rec of run.records) {
		if (rec.arm !== arm) continue
		const text = String(rec.text ?? "")
		if (isSilent(text)) continue
		const m = text.match(ELAPSED)
		if (m === null) continue

		/* The killing blow's age as the payload itself stated it, which is what the line contradicts. */
		const kill = String(rec.payload ?? "").match(/^- [\d:]+ \((\d+)s ago\) \w+ killed /m)
		const word = m[1]!.toLowerCase()
		const spoken = /^\d+$/.test(word) ? Number(word) : (WORDS[word] ?? null)
		const killAgeSec = kill === null ? null : Number(kill[1])
		const inverted = spoken !== null && killAgeSec !== null && spoken > killAgeSec * 2 && spoken >= 15

		const sampleFile = windows.get(rec.windowId)
		if (sampleFile === undefined) continue
		if (!cache.has(sampleFile)) cache.set(sampleFile, samplesOf(sampleFile))

		/* The memory the coach would have held at that instant, fed exactly as the bench feeds it. */
		let mem: MemoryState = newMemory()
		let last: Sample | null = null
		for (const smp of cache.get(sampleFile)!) {
			if (smp.gameTime > rec.atSec) break
			mem = observe(mem, smp, smp.gameTime)
			last = smp
		}
		if (last === null) continue

		/* WHO the sentence is about: a champion it names who is on the floor at that instant. */
		const players = playersOf(last)
		const dead = players.filter(p => p.isDead).map(p => p.championName)
		const meName = (last.data.activePlayer as { riotIdGameName?: string }).riotIdGameName
		const me = players.find(p => p.riotIdGameName === meName)
		const subject =
			dead.find(c => new RegExp(`\\b${c}\\b`, "i").test(text)) ??
			(me !== undefined && me.isDead && /\b(?:you|your|you're|youre)\b/i.test(text) ? me.championName : null)

		const seen = deathsSeen(mem)
		const entry = subject === null ? undefined : seen[subject]
		rows.push({
			run: label,
			clock: rec.clock,
			said: m[0],
			killAgeSec,
			inverted,
			subject,
			verdict:
				subject === null ? "no-subject"
				: entry === undefined ? "not-known"
				: entry.exact ? "exact"
				: "bound",
			statedElapsedSec: entry === undefined ? null : Math.round(rec.atSec - entry.atSec),
			deadThatTurn: dead.length,
			unwatchedThatTurn: dead.filter(c => seen[c] === undefined)
		})
	}
}

const n = rows.length
const count = (p: (r: (typeof rows)[number]) => boolean): number => rows.filter(p).length
const bad = rows.filter(r => r.inverted)

console.log(`BEFORE — lines stating an elapsed death time: ${n}`)
console.log(`  contradicting the client's own kill log: ${pct(bad.length, n)}`)
console.log("")
console.log("AFTER — what the payload states for that man, replayed through memory + brief as they now stand:")
for (const v of ["exact", "bound", "not-known", "no-subject"] as const)
	console.log(`  ${v.padEnd(10)} ${pct(count(r => r.verdict === v), n)}`)
const resolved = rows.filter(r => r.verdict !== "no-subject")
console.log(`  of the ${resolved.length} with an identifiable subject, elapsed STATED: ${pct(resolved.filter(r => r.verdict !== "not-known").length, resolved.length)}`)
console.log("")
console.log(`of the ${bad.length} lines that contradicted the kill log:`)
for (const v of ["exact", "bound", "not-known", "no-subject"] as const)
	console.log(`  ${v.padEnd(10)} ${pct(bad.filter(r => r.verdict === v).length, bad.length)}`)
console.log("")
console.log("THE RESIDUAL, subject-free — a turn where a man is down and his death was never watched:")
console.log(`  turns with an unwatched dead man: ${pct(count(r => r.unwatchedThatTurn.length > 0), n)}`)
console.log(
	`  dead men across those turns: ${rows.reduce((a, r) => a + r.deadThatTurn, 0)}, unwatched ${rows.reduce(
		(a, r) => a + r.unwatchedThatTurn.length,
		0
	)}`
)
console.log("")
for (const r of bad.filter(r => r.verdict !== "no-subject").slice(0, 6))
	console.log(
		`  ${r.run} ${r.clock} ${r.subject}: said "${r.said}", killed ${r.killAgeSec}s ago, payload now "down ${r.statedElapsedSec}s"`
	)

/*
 * AND THE SAME QUESTION OF EVERY RECORDED SAMPLE, not only the turns somebody spoke on — including
 * a memory STARTED MID-GAME, which is the case that produces an unwatched death: a daemon restart,
 * or a page opened at 12:00. The client's event array carries the whole game and the first
 * `observe` ingests all of it, so a mid-game start still dates the deaths it never watched.
 */
const sweep = (startFrac: number) => {
	let dead = 0
	let unwatched = 0
	let games = 0
	for (const f of readdirSync("data/live-samples").filter(x => x.endsWith(".ndjson"))) {
		const samples = samplesOf(`data/live-samples/${f}`)
		if (samples.length < 10) continue
		games += 1
		const from = Math.floor(samples.length * startFrac)
		let mem: MemoryState = newMemory()
		for (const [i, smp] of samples.entries()) {
			if (i < from) continue
			mem = observe(mem, smp, smp.gameTime)
			const seen = deathsSeen(mem)
			for (const p of playersOf(smp)) {
				if (!p.isDead) continue
				dead += 1
				if (seen[p.championName] === undefined) unwatched += 1
			}
		}
	}
	return { games, dead, unwatched }
}

console.log("")
const sweeps = [0, 0.5].map(frac => ({ startFrac: frac, ...sweep(frac) }))
for (const s of sweeps)
	console.log(
		`every dead-player reading, memory started at ${(100 * s.startFrac).toFixed(0)}% of the game: ${
			s.games
		} games, ${s.dead} readings, unwatched ${pct(s.unwatched, s.dead)}`
	)

const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1]! : null
if (out !== null) {
	writeFileSync(
		out,
		`${JSON.stringify(
			{
				ranAt: new Date().toISOString(),
				runs: RUNS.map(([label, file, arm]) => ({ label, file, arm })),
				before: { elapsedClaims: n, contradictingKillLog: bad.length },
				after: {
					exact: count(r => r.verdict === "exact"),
					bound: count(r => r.verdict === "bound"),
					notKnown: count(r => r.verdict === "not-known"),
					subjectNotIdentified: count(r => r.verdict === "no-subject"),
					deadMenOnThoseTurns: rows.reduce((a, r) => a + r.deadThatTurn, 0),
					unwatchedDeadMen: rows.reduce((a, r) => a + r.unwatchedThatTurn.length, 0)
				},
				sweeps,
				rows
			},
			null,
			2
		)}\n`
	)
	console.log(`\nwrote ${out}`)
}
