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

const DEFAULT_RUNS: [string, string, string][] = [
	["CORPUS", "data/eval/integrate2-corpus-20260912.json", "gemini-http"],
	["SOCKET", "data/eval/integrate2-socket-20260912.json", "gemini-live"]
]

/**
 * `--runs LABEL=file=arm,...` replaces the stored pair, so a LATER run is measured by THIS
 * instrument rather than by a second one written beside it. The default is the two runs the
 * comment above is about, so the before figures stay re-derivable with no argument at all.
 */
const runsArg = process.argv.indexOf("--runs")
const RUNS: [string, string, string][] =
	runsArg < 0 ? DEFAULT_RUNS : (
		process.argv[runsArg + 1]!.split(",").map(spec => {
			const [label = "", file = "", arm = ""] = spec.split("=")
			return [label, file, arm] as [string, string, string]
		})
	)

/**
 * Number words, for the SECOND measure only. The kill-log measure above keeps the four-word list
 * the original 71/153 was produced with, because changing what a measurement counts changes the
 * before figure it is being compared against.
 */
const ONES: Record<string, number> = {
	zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
	ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
	seventeen: 17, eighteen: 18, nineteen: 19
}
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }

/** "forty-three", "forty three", "43" — and null for anything this cannot read without guessing. */
const spokenNumber = (text: string): number | null => {
	const t = text.toLowerCase().replace(/\u2013|\u2014/g, "-")
	const digits = t.match(/\b(\d+)\b/)
	if (digits !== null) return Number(digits[1])
	const pair = t.match(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-]+(one|two|three|four|five|six|seven|eight|nine)\b/)
	if (pair !== null) return TENS[pair[1]!]! + ONES[pair[2]!]!
	const ten = t.match(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/)
	if (ten !== null) return TENS[ten[1]!]!
	const one = t.match(new RegExp(`\\b(${Object.keys(ONES).join("|")})\\b`))
	if (one !== null) return ONES[one[1]!]!
	if (/\ba (?:full )?minute\b/.test(t)) return 60
	if (/\bhalf a minute\b/.test(t)) return 30
	return null
}

/** Elapsed phrasing, wider than ELAPSED: the form the READING doc counted 135 of. */
const ELAPSED_WIDE =
	/\b(?:dead|down|gone)\s+(?:for|since)\s+(?:over\s+|about\s+|nearly\s+|almost\s+|more than\s+|a full\s+|roughly\s+|at least\s+)?((?:a full minute|half a minute|a minute|[a-z0-9-]+(?:[\s-][a-z]+)?))\s*(?:seconds|second|secs|s\b|$)/i

/** The legitimate remaining phrasing, which is NOT the defect and must not be counted as it. */
const REMAINING_PHRASE = /\b(?:dead|down|gone)\s+for\s+(?:another|the next)\b/i

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
	/** True when the line matches the NARROW `ELAPSED`, i.e. the phrasing the 71/153 was counted on. */
	narrow: boolean
	inverted: boolean
	subject: string | null
	verdict: Verdict
	statedElapsedSec: number | null
	/** What the line SAID, as a number, read with the wider word list. Null when it cannot be read. */
	spokenSec: number | null
	/** The payload's own `back in Ns` for that man — the REMAINING figure, the one being mistaken. */
	payloadRemainingSec: number | null
	/** The payload's own `down Ns` for that man. Absent before the fix; that absence IS the before. */
	payloadElapsedSec: number | null
	deadThatTurn: number
	unwatchedThatTurn: string[]
}[] = []

/** The payload's figure for one man, from the line that names him. Null when the payload has none. */
const figureFor = (payload: string, subject: string, what: RegExp): number | null => {
	for (const line of payload.split("\n")) {
		if (!new RegExp(`\\b${subject}\\b`, "i").test(line)) continue
		const m = line.match(what)
		if (m !== null) return Number(m[1])
	}
	return null
}

const REMAINING_FIGURE = /(?:back in|respawns in) (\d+)s/
const ELAPSED_FIGURE = /down (?:at least )?(\d+)s/

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
		const m = text.match(ELAPSED_WIDE)
		if (m === null) continue
		if (REMAINING_PHRASE.test(text)) continue
		const narrowMatch = text.match(ELAPSED)

		/* The killing blow's age as the payload itself stated it, which is what the line contradicts. */
		const kill = String(rec.payload ?? "").match(/^- [\d:]+ \((\d+)s ago\) \w+ killed /m)
		const word = (narrowMatch?.[1] ?? "").toLowerCase()
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
		const payload = String(rec.payload ?? "")
		rows.push({
			run: label,
			clock: rec.clock,
			said: m[0],
			killAgeSec,
			narrow: narrowMatch !== null,
			inverted: narrowMatch !== null && inverted,
			subject,
			verdict:
				subject === null ? "no-subject"
				: entry === undefined ? "not-known"
				: entry.exact ? "exact"
				: "bound",
			statedElapsedSec: entry === undefined ? null : Math.round(rec.atSec - entry.atSec),
			spokenSec: spokenNumber(m[1]!),
			payloadRemainingSec: subject === null ? null : figureFor(payload, subject, REMAINING_FIGURE),
			payloadElapsedSec: subject === null ? null : figureFor(payload, subject, ELAPSED_FIGURE),
			deadThatTurn: dead.length,
			unwatchedThatTurn: dead.filter(c => seen[c] === undefined)
		})
	}
}

type Row = (typeof rows)[number]
const narrowRows = rows.filter(r => r.narrow)
const n = narrowRows.length
const count = (p: (r: Row) => boolean): number => narrowRows.filter(p).length
const bad = narrowRows.filter(r => r.inverted)

/*
 * THE MECHANICAL MEASURE, run by run. Two questions of the same lines, and the second is the one
 * the judge cannot reach: does the number spoken contradict the kill log, and — deeper — is it the
 * payload's REMAINING figure being read out as an elapsed one?
 */
const near = (a: number | null, b: number | null): boolean => a !== null && b !== null && Math.abs(a - b) <= 10
console.log("PER RUN — of the lines that state an elapsed death time:")
for (const [label] of RUNS) {
	const mine = rows.filter(r => r.run === label)
	const narrow = mine.filter(r => r.narrow)
	const readable = mine.filter(r => r.spokenSec !== null && r.payloadRemainingSec !== null)
	const asRemaining = readable.filter(r => near(r.spokenSec, r.payloadRemainingSec))
	const withElapsed = mine.filter(r => r.spokenSec !== null && r.statedElapsedSec !== null)
	const asElapsed = withElapsed.filter(r => near(r.spokenSec, r.statedElapsedSec))
	console.log(`  ${label}`)
	console.log(`    elapsed-phrasing lines: ${mine.length} (narrow phrasing, the 71/153 instrument: ${narrow.length})`)
	console.log(`    contradicting the client's own kill log: ${pct(narrow.filter(r => r.inverted).length, narrow.length)}`)
	console.log(`    speaking the payload's REMAINING figure: ${pct(asRemaining.length, readable.length)}`)
	console.log(`    speaking the watched ELAPSED figure:     ${pct(asElapsed.length, withElapsed.length)}`)
	console.log(
		`    payload carried an elapsed figure for that man on ${pct(
			mine.filter(r => r.payloadElapsedSec !== null).length,
			mine.length
		)}`
	)
}
console.log("")

console.log(`BEFORE — lines stating an elapsed death time: ${n}`)
console.log(`  contradicting the client's own kill log: ${pct(bad.length, n)}`)
console.log("")
console.log("AFTER — what the payload states for that man, replayed through memory + brief as they now stand:")
for (const v of ["exact", "bound", "not-known", "no-subject"] as const)
	console.log(`  ${v.padEnd(10)} ${pct(count(r => r.verdict === v), n)}`)
const resolved = narrowRows.filter(r => r.verdict !== "no-subject")
console.log(`  of the ${resolved.length} with an identifiable subject, elapsed STATED: ${pct(resolved.filter(r => r.verdict !== "not-known").length, resolved.length)}`)
console.log("")
console.log(`of the ${bad.length} lines that contradicted the kill log:`)
for (const v of ["exact", "bound", "not-known", "no-subject"] as const)
	console.log(`  ${v.padEnd(10)} ${pct(bad.filter(r => r.verdict === v).length, bad.length)}`)
console.log("")
console.log("THE RESIDUAL, subject-free — a turn where a man is down and his death was never watched:")
console.log(`  turns with an unwatched dead man: ${pct(count(r => r.unwatchedThatTurn.length > 0), n)}`)
console.log(
	`  dead men across those turns: ${narrowRows.reduce((a, r) => a + r.deadThatTurn, 0)}, unwatched ${narrowRows.reduce(
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
					deadMenOnThoseTurns: narrowRows.reduce((a, r) => a + r.deadThatTurn, 0),
					unwatchedDeadMen: narrowRows.reduce((a, r) => a + r.unwatchedThatTurn.length, 0)
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
