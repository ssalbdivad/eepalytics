/**
 * WHICH ASK RAISED THE WRONG LINE — the per-ask-kind table, re-derivable on the stored runs.
 *
 * The coach speaks 21% more than it did a day ago, and the count of WRONG lines he hears went up
 * 12% while the rate improved. He hears lines, not rates. So the question this answers is not "is
 * the coach better" but "is there an ask kind that is disproportionately the cause", the way
 * `live-schedule.ts`'s own docblock found that the price of an ask predicts nothing and its KIND
 * predicts a lot.
 *
 * ## How a line is joined back to the ask that raised it
 *
 * A stored run's records carry no ask. So the detector is REPLAYED over each window's raw samples
 * — `observeTick` / `dueTurn` / `commitTurn`, the same three calls the browser makes — and each
 * replayed turn is joined to the run's record at the SAME GAME CLOCK. Over
 * `integrate3-corpus-20260912.json` replayed with `--before`, that matches 879 of 879 turns exactly.
 *
 * The clock, not the ordinal, because the ordinal only works while the schedule is unchanged. A cut
 * moves every later turn's index by one, so an ordinal join would silently pair each line with
 * somebody else's ask and report a table made of nonsense. Joined on the clock, a replay of the
 * CURRENT schedule against a run taken under the old one is honest about what it cannot know: a
 * turn the stored run never took has no line, and is counted as `new instants` rather than guessed
 * at in either direction.
 *
 * ## TWO instruments, because the judge alone cannot see the error that dominates
 *
 * Each line is graded by both, and a line either instrument convicts is WRONG:
 *
 *   - the blind judge stored beside the run (`*-judged.json`), which reads advice; and
 *   - `scripts/lib/payload-claims.ts`, which subtracts the payload's own death clocks out of the
 *     sentence in code and needs no model at all.
 *
 * They barely overlap — 116 judge-false and 120 clock-bad lines share only 24 — and their union is
 * 212 of 837 = 25% [22-28], which lands on the independently adjudicated 28% [26-32] rather than on
 * the judge's flattering 14%. Either instrument alone reports roughly half the wrong lines he hears.
 *
 * USEFUL here means the judge graded it useful AND the clock instrument did not convict it, so a
 * line with the right action and an inverted number counts as wrong rather than as useful. That is
 * the product's own standard: a coach who states a wrong number teaches him to discount the rest.
 *
 * ## What it found, and what it did NOT find
 *
 * Two ask kinds have intervals separated from the pooled rate, and they are the fifth cut. These
 * are `--before` numbers, i.e. the schedule as it stood when the lines were spoken:
 *
 * ```
 *   ask kind            turns   wrong                 clean-useful
 *   game.start             28   7% [2-23]             0% [0-12]      26 of 28 graded generic
 *   death.counterpart      52   60% [46-72]           40% [28-54]    the only kind wrong > useful
 *   ALL                   879   25% [22-28]           69% [66-72]
 * ```
 *
 * (`death.counterpart` is counted here on every turn it appears in. On the 47 where it is the sole
 * ask — no window ask riding with it to carry the sentence — it is 66% [52-78] wrong.)
 *
 * Everything else overlaps the pooled rate, and that is the finding that matters most here:
 * **the volume is not where the wrongness is.** Every cut this script can express that removes
 * lines for being NUMEROUS rather than for being wrong loses useful lines roughly twice as fast as
 * it loses false ones — a cap on re-asks per contest window (ratio 0.42-0.53 whatever the cap), a
 * minimum gap between turns (0.37-0.43 at every gap from 20s to 60s), dropping `window.standing`
 * (0.29), dropping the "two enemies are down" trigger (0.44). Run `--cuts` to re-derive all of
 * them. Chattiness is real — 28% of turn gaps are under thirty seconds, and 21% of lines repeat the
 * action of a line spoken in the previous two minutes — but it is not the same defect as wrongness,
 * and the ratios say plainly that cutting one does not cut the other. The one thing that moves them
 * together would be a judge that could see repetition; this one grades each line alone.
 *
 *   node --experimental-strip-types scripts/measure-asks.ts [--run <file>] [--before] [--cuts]
 *                                                           [--out <file>]
 */
import { readFileSync, writeFileSync } from "node:fs"
import { scoreLine, wilson } from "../src/analysis/coach-score.ts"
import {
	askPolicy,
	commitTurn,
	DEFAULT_SPEAK_LEVEL,
	dueTurn,
	newEventWatch,
	observeTick,
	projectTick,
	type SpeakLevel
} from "../src/analysis/live-events.ts"
import { clockClaims, mechanicalVerdict, readPayload } from "./lib/payload-claims.ts"
import { championVocabulary, readVerbatim } from "./lib/stream.ts"
import type { LiveAllGameData } from "../src/shared/schema/live.ts"

const arg = (flag: string, fallback: string): string => {
	const i = process.argv.indexOf(flag)
	return i < 0 ? fallback : (process.argv[i + 1] ?? fallback)
}

const RUN = arg("--run", "data/eval/integrate3-corpus-20260912.json")
const JUDGED = arg("--judged", RUN.replace(/\.json$/, "-judged.json"))
const ARM = arg("--arm", "gemini-http")
const OUT = arg("--out", "")
const CUTS = process.argv.includes("--cuts")
/** Replay the schedule as it stood BEFORE the fifth cut, so the table that made it is derivable. */
const BEFORE = process.argv.includes("--before")
/**
 * WHICH SPEAK LEVEL to replay — see `SPEAK_LEVELS` in `src/analysis/live-events.ts`.
 *
 * Defaults to whatever ships, so `--out` after a change describes the coach he actually has. Under
 * `--before` it is forced to `commentary`: that flag's entire job is to reproduce the 879-turn
 * table exactly, and replaying the pre-fifth-cut fire sites under a post-selectivity allowlist
 * would reproduce neither schedule.
 */
const LEVEL = (BEFORE ? "commentary" : (arg("--level", DEFAULT_SPEAK_LEVEL) as SpeakLevel))

interface Run {
	heartbeatSec: number
	windows: { id: string; sampleFile: string }[]
	records: {
		arm: string
		windowId: string
		index: number
		atSec: number
		clock: string
		text: string
		payload: string
	}[]
}

interface Judged {
	lines: { windowId: string; index: number; verdict: string }[]
}

const run = JSON.parse(readFileSync(RUN, "utf8")) as Run
const judged = JSON.parse(readFileSync(JUDGED, "utf8")) as Judged
const verdictOf = new Map(judged.lines.map(l => [`${l.windowId}#${l.index}`, l.verdict]))

/* ------------------------------------------------------- replay the detector */

interface Ask {
	kind: string
	note: string
	windowKey: string | null
}
interface Turn {
	atSec: number
	asks: Ask[]
	heartbeat: boolean
}

/**
 * The detector, stepped over EVERY sample and joined to the run's turns by ordinal.
 *
 * Stepping only the turns would diff across the holes between them and invent transitions that
 * never happened — the same rule `scripts/lib/stream.ts` states for `pickEventCheckpoints`, which
 * this deliberately does not reuse: that one returns `describeTurn`'s prose, and what is wanted
 * here is the asks themselves, with their notes, so a cause can be read out of them.
 */
const replay = (sampleFile: string): Turn[] => {
	const watch = newEventWatch()
	const turns: Turn[] = []
	for (const row of readVerbatim(sampleFile)) {
		const tick = projectTick(row.data as LiveAllGameData)
		if (!tick) continue
		watch.pending.push(...observeTick(watch, tick, { asksBeforeFifthCut: BEFORE, level: LEVEL }))
		/*
		 * THE LEVEL OWNS THE FLOOR, and the stored run's `heartbeatSec` is only the authority under
		 * `--before`, where reproducing that run is the entire point.
		 *
		 * Passing the run's 180s under a quiet level puts a floor back underneath a level that has
		 * none, and it is not a small error: `key-moments` gates a standing objective on 210s of
		 * silence, so a 180s heartbeat reaches every lull first and `window.standing` becomes
		 * unreachable. The first run of this script did exactly that and reported the kind missing
		 * from a level that has it.
		 */
		const reason = dueTurn(watch, tick.gameTimeSec, {
			level: LEVEL,
			heartbeatSec: BEFORE ? run.heartbeatSec : askPolicy(LEVEL).heartbeatSec
		})
		if (!reason) continue
		commitTurn(watch, reason, tick.gameTimeSec)
		turns.push({
			atSec: tick.gameTimeSec,
			heartbeat: reason.heartbeat,
			asks: reason.events
				.filter(e => e.asks)
				.map(e => ({ kind: e.kind, note: e.note, windowKey: e.windowKey }))
		})
	}
	return turns
}

/* ---------------------------------------------------------------- the grades */

type Grade = "wrong" | "useful" | "other" | "pass"

const champions = championVocabulary().names

/**
 * The roster is parsed back OUT of the payload rather than rebuilt from the sample.
 *
 * `scoreLine` needs the ten champions the block stated, and the block is the only place that says
 * which ten the model was told about. Rebuilding it from the sample would let a roster the coach
 * never saw decide whether it invented a name.
 */
const rosterOf = (payload: string): string[] => {
	const roster = new Set<string>()
	for (const m of payload.matchAll(/^- ([A-Z][A-Za-z' .]+?) \((?:TOP|JUNGLE|MIDDLE|BOTTOM|UTILITY)/gm))
		roster.add(m[1]!.trim())
	const me = /^YOU — ([A-Za-z' .]+),/m.exec(payload)
	if (me) roster.add(me[1]!.trim())
	const cp = /^ENEMY JUNGLER — ([A-Za-z' .]+),/m.exec(payload)
	if (cp) roster.add(cp[1]!.trim())
	return [...roster]
}

/**
 * The grade, AND which instrument produced it, because the two convict different lines.
 *
 * Keeping them apart is what separates "this ask is bad" from "this ask talks about a death".
 * A line the clock convicts while the judge calls the advice useful is wrong in its NUMBER and
 * right in everything else — `rescuable` counts exactly those, and they are what a working death
 * clock would hand back. A line the judge calls false is wrong as coaching and no clock fix
 * touches it.
 */
const gradeOf = (
	text: string,
	payload: string,
	verdict: string | undefined
): { grade: Grade; clockBad: boolean; judgeFalse: boolean; rescuable: boolean } => {
	const score = scoreLine({ line: text, block: payload, roster: rosterOf(payload), champions })
	const clock = mechanicalVerdict(clockClaims(text, readPayload(payload)))
	const clockBad = clock === "contradicted" || clock === "inversion-shaped"
	const judgeFalse = verdict === "false"
	const grade: Grade =
		score.silent ? "pass"
		: clockBad || judgeFalse ? "wrong"
		: verdict === "useful" ? "useful"
		: "other"
	return {
		grade,
		clockBad: !score.silent && clockBad,
		judgeFalse: !score.silent && judgeFalse,
		rescuable: !score.silent && clockBad && !judgeFalse && verdict === "useful"
	}
}

/* ------------------------------------------------------------------- the join */

interface Row {
	game: string
	atSec: number
	grade: Grade
	kinds: string[]
	/** One entry per ask, `window.changed` split by each field `materialDiff` says moved. */
	causes: string[]
	/** How many times this contest window has been asked about already, 1-based. Null off-window. */
	ordinal: number | null
	/** The payload's own death clocks, subtracted out of the sentence in code, convicted it. */
	clockBad: boolean
	/** The blind judge called the advice false. Independent of the clock, and barely overlapping. */
	judgeFalse: boolean
	/** Wrong ONLY in its number, and graded useful otherwise: what a working clock hands back. */
	rescuable: boolean
}

const rows: Row[] = []
/** Replayed turns the stored run never took, so no line exists to grade. Reported, never guessed. */
let newInstants = 0
const seenWindow = new Map<string, number>()
for (const w of run.windows) {
	const turns = replay(w.sampleFile)
	const byClock = new Map(
		run.records.filter(r => r.arm === ARM && r.windowId === w.id).map(r => [r.atSec.toFixed(2), r])
	)
	for (const turn of turns) {
		const r = byClock.get(turn.atSec.toFixed(2))
		if (!r) {
			newInstants += 1
			continue
		}
		const causes: string[] = []
		for (const a of turn.asks) {
			if (a.kind !== "window.changed" || !a.note.includes("—")) {
				causes.push(a.kind)
				continue
			}
			for (const moved of a.note.split("—")[1]!.split(",")) causes.push(`changed:${moved.trim()}`)
		}
		const key = turn.asks.find(a => a.windowKey !== null)?.windowKey ?? null
		let ordinal: number | null = null
		if (key !== null) {
			const k = `${w.id}#${key}`
			ordinal = (seenWindow.get(k) ?? 0) + 1
			seenWindow.set(k, ordinal)
		}
		const graded = gradeOf(r.text, r.payload, verdictOf.get(`${r.windowId}#${r.index}`))
		rows.push({
			game: w.id,
			atSec: turn.atSec,
			kinds: turn.heartbeat ? ["heartbeat"] : turn.asks.map(a => a.kind),
			causes: turn.heartbeat ? ["heartbeat"] : causes,
			ordinal,
			...graded
		})
	}
}

/* ------------------------------------------------------------------ the table */

const pct = (k: number, n: number): string => {
	if (n === 0) return "     —"
	const ci = wilson(k, n)
	return `${((100 * k) / n).toFixed(0)}% [${(100 * ci.lo).toFixed(0)}-${(100 * ci.hi).toFixed(0)}]`
}

const tally = (label: string, of: (r: Row) => string[]): void => {
	const by = new Map<string, Record<Grade | "turns", number>>()
	for (const r of rows)
		for (const k of new Set(of(r))) {
			const c = by.get(k) ?? { turns: 0, wrong: 0, useful: 0, other: 0, pass: 0 }
			c.turns += 1
			c[r.grade] += 1
			by.set(k, c)
		}
	console.log(`\n${label}`)
	console.log(
		`${"".padEnd(38)}${"turns".padStart(6)}${"spoke".padStart(6)}${"wrong".padStart(16)}${"clean-useful".padStart(16)}`
	)
	for (const [k, c] of [...by].sort((a, b) => b[1].turns - a[1].turns)) {
		const spoke = c.turns - c.pass
		console.log(
			`${k.padEnd(38)}${String(c.turns).padStart(6)}${String(spoke).padStart(6)}${pct(c.wrong, spoke).padStart(16)}${pct(c.useful, spoke).padStart(16)}`
		)
	}
	const all = rows.filter(r => r.grade !== "pass")
	console.log(
		`${"ALL".padEnd(38)}${String(rows.length).padStart(6)}${String(all.length).padStart(6)}${pct(
			all.filter(r => r.grade === "wrong").length,
			all.length
		).padStart(16)}${pct(all.filter(r => r.grade === "useful").length, all.length).padStart(16)}`
	)
}

/**
 * THE SAME ROWS, SPLIT BY WHICH INSTRUMENT CONVICTED THEM — and the table that reads an ask right.
 *
 * `BY ASK KIND` answers "how often is this ask wrong". It cannot answer "is this ask a bad
 * question", because a line can be wrong in its number while its advice is the best in the app,
 * and over this corpus that distinction is the whole story of the two indicted kinds:
 *
 * ```
 *   cause                          spoke   wrong        clock ONLY    judge ONLY   rescuable
 *   changed:counterpart died         118   55% [46-64]  44% [35-53]    3% [1-8]       52
 *   death.counterpart                 52   60% [46-72]  40% [28-54]   10% [4-21]      21
 *   changed:two enemies are down     128   40% [32-49]  20% [14-27]   13% [8-19]      25
 *   game.start                        28    7% [2-23]    0% [0-12]     7% [2-23]       0
 *   ALL                              837   25% [22-28]  11% [9-14]    11% [9-13]      96
 * ```
 *
 * `judge ONLY` is the column that says whether the QUESTION was worth asking, and on the
 * counterpart's death it is 3% [1-8] — the lowest of any cause in the corpus, under `window.open`'s
 * 13%. As coaching, "the enemy jungler is off the map" is the best ask this app makes. It is
 * wrecked by one number read backwards, and by nothing else.
 *
 * That refutes the structural reading the fifth cut was written on, twice over. It also says the
 * cut reached the smaller half: the identical premise rides `window.changed` 118 times to
 * `death.counterpart`'s 52, at 44% clock-only against 40%, and cutting one and keeping the other
 * cannot be justified by anything in this table.
 *
 * 96 lines of 837 — 3.4 per game, 46% of every wrong line he hears — are wrong ONLY in a death
 * clock. That is the largest single defect in the corpus and it is not an ask's fault.
 */
const why = (): void => {
	const spoke = rows.filter(r => r.grade !== "pass")
	const by = new Map<string, Row[]>()
	for (const r of spoke) for (const k of new Set(r.causes)) by.set(k, [...(by.get(k) ?? []), r])
	console.log("\nWHICH INSTRUMENT CONVICTED IT (a line either one convicts is wrong)")
	console.log(
		`${"".padEnd(34)}${"spoke".padStart(6)}${"wrong".padStart(14)}${"clock ONLY".padStart(14)}${"judge ONLY".padStart(14)}${"both".padStart(6)}${"rescuable".padStart(11)}`
	)
	const line = (k: string, rs: readonly Row[]): void => {
		const n = rs.length
		console.log(
			`${k.padEnd(34)}${String(n).padStart(6)}` +
				`${pct(rs.filter(r => r.grade === "wrong").length, n).padStart(14)}` +
				`${pct(rs.filter(r => r.clockBad && !r.judgeFalse).length, n).padStart(14)}` +
				`${pct(rs.filter(r => !r.clockBad && r.judgeFalse).length, n).padStart(14)}` +
				`${String(rs.filter(r => r.clockBad && r.judgeFalse).length).padStart(6)}` +
				`${String(rs.filter(r => r.rescuable).length).padStart(11)}`
		)
	}
	for (const [k, rs] of [...by].sort((a, b) => b[1].length - a[1].length)) line(k, rs)
	line("ALL", spoke)
}

/* --------------------------------------------------------------- the cut trade */

const games = [...new Set(rows.map(r => r.game))]

/**
 * What a cut costs and what it buys, PER GAME, because that is what he hears.
 *
 * The ratio is wrong-lines-removed over useful-lines-removed. Under 1 means the cut takes more
 * coaching away than error, and the owner's rule is that such a cut is wrong and must be said so
 * rather than shipped.
 *
 * This deletes the turn outright, which is PESSIMISTIC about the real mechanism in one direction
 * and optimistic in another, and neither is repairable from a stored run. Pessimistic: a suppressed
 * ask stays in `watch.pending` and rides the next turn, so its material is delayed rather than
 * lost. Optimistic: the line the model would have said on that later turn is not the line stored
 * here. Only a re-run can settle it; this is the bound, not the measurement.
 *
 * `resc` IS PART OF THE TRADE AND THE RATIO CANNOT SEE IT. The ratio counts a line wrong in its
 * number the same as a line wrong in its advice, so on any death-premised ask it recommends
 * deleting the question that `why()` shows is the best one in the app: cutting
 * `changed:counterpart died` scores a healthy 1.41 while throwing away 52 lines whose only fault
 * is a clock this repo is separately fixing. Read the two columns together or the ratio will talk
 * you into a cut that the clock was about to undo for free.
 */
const trade = (label: string, keep: (r: Row) => boolean): void => {
	const per = (filter: (r: Row) => boolean, g: Grade): number =>
		games.map(gm => rows.filter(r => r.game === gm && filter(r) && r.grade === g).length)
			.reduce((a, b) => a + b, 0) / games.length
	const w0 = per(() => true, "wrong")
	const w1 = per(keep, "wrong")
	const u0 = per(() => true, "useful")
	const u1 = per(keep, "useful")
	const ratio = u0 - u1 === 0 ? Infinity : (w0 - w1) / (u0 - u1)
	const resc =
		games
			.map(gm => rows.filter(r => r.game === gm && !keep(r) && r.rescuable).length)
			.reduce((a, b) => a + b, 0) / games.length
	console.log(
		`${label.padEnd(40)}turns ${String(rows.filter(keep).length).padStart(4)}  wrong/game ${w0.toFixed(2)}->${w1.toFixed(2)}  useful/game ${u0.toFixed(2)}->${u1.toFixed(2)}  ratio ${(ratio === Infinity ? "inf" : ratio.toFixed(2)).padStart(4)}  resc/game ${resc.toFixed(2)}`
	)
}

console.log(
	`${RUN}  (speak level: ${LEVEL})${BEFORE ? "  (schedule replayed as it stood BEFORE the fifth cut)" : ""}\n${rows.length} turns joined to the ask that raised them; ${newInstants} replayed turn(s) the stored run never took, ungraded`
)
tally("BY ASK KIND", r => r.kinds)
tally("BY CAUSE (a window ask is split by every field that moved)", r => r.causes)
tally("BY HOW MANY TIMES THIS CONTEST WINDOW HAS BEEN ASKED", r => [
	r.ordinal === null ? "off-window" : r.ordinal <= 4 ? `ask #${r.ordinal}` : "ask #5+"
])
why()

if (CUTS) {
	console.log(
		"\nCUTS — wrong lines removed per useful line removed. Under 1.00 is a bad trade." +
			"\n`resc` is how many of the removed wrong lines were wrong ONLY in a death clock, which" +
			"\nthe ratio counts as a win and a working clock would have handed back as coaching."
	)
	trade("- game.start", r => !r.kinds.includes("game.start"))
	trade("- death.counterpart", r => !r.kinds.includes("death.counterpart"))
	trade("- window.standing", r => !r.kinds.includes("window.standing"))
	trade(
		"- changed:counterpart died (sole cause)",
		r => !(r.causes.length === 1 && r.causes[0] === "changed:counterpart died")
	)
	trade(
		"- changed:two enemies are down (sole)",
		r => !(r.causes.length === 1 && r.causes[0] === "changed:two enemies are down")
	)
	for (const cap of [3, 4, 5, 6, 8])
		trade(`- contest-window ask #>${cap}`, r => r.ordinal === null || r.ordinal <= cap)
	for (const gap of [20, 30, 45, 60]) {
		const last = new Map<string, number>()
		const kept = new Set<string>()
		for (const r of rows) {
			const prev = last.get(r.game)
			if (prev !== undefined && r.atSec - prev < gap) continue
			last.set(r.game, r.atSec)
			kept.add(`${r.game}@${r.atSec}`)
		}
		trade(`- min gap ${gap}s between turns`, r => kept.has(`${r.game}@${r.atSec}`))
	}
}

/* ------------------------------------------------ the same corpus, two schedules */

/**
 * `--vs <rows.json>` — the trade, per game, against a previously written table.
 *
 * The only figure the owner asked for: he hears LINES, so the comparison is counts per game and
 * not rates. Paired over the games both tables share, with the interval and the sign test beside
 * the mean, because 28 games is few enough that a mean alone reads stronger than it is.
 */
const VS = arg("--vs", "")
if (VS !== "") {
	const prev = JSON.parse(readFileSync(VS, "utf8")) as { rows: Row[] }
	const shared = games.filter(g => prev.rows.some(r => r.game === g))
	const count = (rs: readonly Row[], g: string, grade: Grade): number =>
		rs.filter(r => r.game === g && r.grade === grade).length
	console.log(`\nVS ${VS} — ${shared.length} shared games, counts per game`)
	for (const grade of ["wrong", "useful", "other"] as const) {
		const d = shared.map(g => count(rows, g, grade) - count(prev.rows, g, grade))
		const mean = d.reduce((a, b) => a + b, 0) / d.length
		const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (d.length - 1))
		const se = sd / Math.sqrt(d.length)
		const before = shared.map(g => count(prev.rows, g, grade)).reduce((a, b) => a + b, 0) / shared.length
		console.log(
			`${grade.padEnd(8)} ${before.toFixed(2)} -> ${(before + mean).toFixed(2)}  ` +
				`${mean >= 0 ? "+" : ""}${mean.toFixed(2)} [${(mean - 1.96 * se).toFixed(2)},${(mean + 1.96 * se).toFixed(2)}]  ` +
				`t=${se === 0 ? "—" : (mean / se).toFixed(2)}  ` +
				`down in ${d.filter(x => x < 0).length}/${shared.length} games, up in ${d.filter(x => x > 0).length}`
		)
	}
	console.log(
		`turns    ${(prev.rows.length / shared.length).toFixed(2)} -> ${(rows.length / shared.length).toFixed(2)} per game, ` +
			`plus ${(newInstants / shared.length).toFixed(2)} ungraded`
	)
}

if (OUT !== "") {
	writeFileSync(
		OUT,
		`${JSON.stringify(
			{
				what: "Every turn of a stored run joined to the ask that raised it, graded by the blind judge and by the payload's own death clocks. No model is consulted; re-derive with scripts/measure-asks.ts.",
				ranAt: new Date().toISOString(),
				run: RUN,
				judged: JUDGED,
				arm: ARM,
				turns: rows.length,
				newInstants,
				rows
			},
			null,
			"\t"
		)}\n`
	)
	console.log(`\nwrote ${OUT}`)
}

/* ========================================================== the standing-objective ask */

/**
 * `--standing` — SHOULD `big-calls` GET A STANDING-OBJECTIVE ASK, AND UNDER WHAT GATE?
 *
 * This is the other half of the question `--cuts` asks. Everything above prices REMOVING an ask
 * against the lines it takes away; this prices ADDING one, on the same 28 games, with no model in
 * the loop and nothing anywhere in it that tells the model what to say.
 *
 * ## The hole it is aimed at
 *
 * `window.standing` is the only ask in this app that covers an objective nobody has taken. It is a
 * `key-moments` kind and it does not fire at `big-calls`, which is the default and the schedule he
 * uses. `observeTick`'s own comment names what that costs: on game 5639406342 the drake window
 * opens at 4:21, the drake spawns at 5:00 and stands untaken until roughly 7:20, and in all that
 * time no field of `materialDiff`'s fingerprint moves, so the detector raises nothing between 4:21
 * and 7:17. Two minutes fifty-seven seconds of silence over a free drake — AGENTS.md calls it the
 * biggest missed counterfactual in the corpus. That game is `js-mtvxb5f4-f81a-t29817812` in this
 * corpus (Lillia into Kayn, 28.2 minutes, the only game of that length with Kayn on the other
 * team), and the sweep reports its hole by name in the `hole` column.
 *
 * ## How the two arms are built, and why OFF is not "the level as it ships"
 *
 * OFF is the level with `standingSilenceSec: Infinity` — the standing ask gone entirely, at every
 * level. ON is the same level with `alsoAsk: ["window.standing"]` and `standingSilenceSec` /
 * `standingAskCap` set to the row under test — the fourth and fifth instrument knobs in
 * `observeTick`, which exist because the only other way to price this was to ship it and measure
 * afterwards. Nothing else moves: the fire site, the notes, the prompt and the payload are
 * untouched.
 *
 * Making OFF the SHIPPED level would have been the obvious choice and it rots the table the moment
 * anything ships. It did: the first run of this sweep priced the standing ask at `big-calls` against
 * a `big-calls` that did not have one, the ask shipped on the strength of it, and the same command
 * then printed a per-kind delta of `{}` for the row that had just been chosen — because OFF now
 * contained the thing under test. A baseline that moves when the answer ships cannot re-derive the
 * answer. `standingSilenceSec: Infinity` is fixed forever, which is what the knob is for, and it is
 * why the shipped configuration appears as a ROW in this table rather than as the zero of it.
 *
 * A turn is GAINED when the ON arm takes a turn at a clock the OFF arm did not, LOST the other way
 * round, and CHANGED when both took a turn at the same clock carrying different kinds. A count
 * hides that distinction and it is the one that matters: a standing ask merging into a turn some
 * other kind was raising anyway costs nothing and buys nothing.
 *
 * ## What a gained turn can and cannot be graded on
 *
 * Mostly it cannot. A turn the stored runs never took has no line, and this script never guesses
 * one. But the corpus was recorded at `commentary`, which takes ~30 turns a game, so SOME gained
 * clocks coincide with a clock a stored line sits at, and those are graded by the same two
 * instruments as everything else. The count travels beside the rate, because a rate over three
 * lines is not a rate — and `graded` is NOT a column to choose a gate on: the corpus's own standing
 * gate is 90s, so a 90s replay lands on the stored clocks far more often than any other value, and
 * that is an alignment artefact rather than a property of the gate.
 *
 *   node --experimental-strip-types scripts/measure-asks.ts --standing [--standing-out <file>]
 */
const STANDING = process.argv.includes("--standing")

/** The game whose 4:21-7:17 hole this exists to close. See the docblock. */
const HOLE_GAME = "js-mtvxb5f4-f81a-t29817812"
const HOLE_FROM_SEC = 261
const HOLE_TO_SEC = 437

const clockOf = (sec: number): string =>
	`${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`

if (STANDING) {
	/*
	 * Every sample file is projected ONCE and the ticks are reused for the whole sweep. 28 games
	 * times three levels times six gates times up to three caps is hundreds of passes over 433MB of
	 * ndjson if each one re-reads; projecting first makes the sweep about ten seconds instead of
	 * twenty minutes, and `projectTick` is pure, so the ticks cannot differ between passes.
	 */
	const ticksOf = new Map<string, NonNullable<ReturnType<typeof projectTick>>[]>()
	for (const w of run.windows)
		ticksOf.set(
			w.id,
			readVerbatim(w.sampleFile)
				.map(row => projectTick(row.data as LiveAllGameData))
				.filter(t => t !== null)
		)

	interface SweepTurn {
		atSec: number
		kinds: string[]
	}
	const sweep = (
		windowId: string,
		level: SpeakLevel,
		on: boolean,
		gate: number,
		cap: number
	): { turns: SweepTurn[]; lastSampleSec: number } => {
		const watch = newEventWatch()
		const turns: SweepTurn[] = []
		let lastSampleSec = 0
		for (const tick of ticksOf.get(windowId)!) {
			lastSampleSec = tick.gameTimeSec
			watch.pending.push(
				...observeTick(watch, tick, {
					level,
					/* ON moves the gate and the cap together; OFF has no standing ask at all. */
					...(on ?
						{
							alsoAsk: ["window.standing" as const],
							standingSilenceSec: gate,
							standingAskCap: cap
						}
					:	{ standingSilenceSec: Infinity })
				})
			)
			const reason = dueTurn(watch, tick.gameTimeSec, { level })
			if (!reason) continue
			commitTurn(watch, reason, tick.gameTimeSec)
			turns.push({
				atSec: tick.gameTimeSec,
				kinds:
					reason.heartbeat ? ["heartbeat"] : reason.events.filter(e => e.asks).map(e => e.kind)
			})
		}
		return { turns, lastSampleSec }
	}

	/**
	 * The longest stretch with no turn in it, over a bounded slice of the clock.
	 *
	 * The slice's own edges count as marks, so a game asked nothing at all between 0:00 and 10:00
	 * reports a 600-second hole rather than no hole — which is the case this whole measurement is
	 * about, and the shape a gap-between-consecutive-turns statistic cannot see.
	 */
	const longestHole = (turns: SweepTurn[], from: number, to: number, end: number): number => {
		const hi = Math.min(to, end)
		if (hi <= from) return 0
		const marks = [from, ...turns.filter(t => t.atSec >= from && t.atSec < hi).map(t => t.atSec), hi]
		let worst = 0
		for (let i = 1; i < marks.length; i += 1) worst = Math.max(worst, marks[i]! - marks[i - 1]!)
		return worst
	}
	const median = (xs: number[]): number =>
		xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

	/** A stored line at this exact clock, if the corpus happens to have taken a turn there. */
	const storedAt = new Map<
		string,
		{ text: string; payload: string; windowId: string; index: number }
	>()
	for (const r of run.records)
		if (r.arm === ARM) storedAt.set(`${r.windowId}@${r.atSec.toFixed(2)}`, r)
	const gradeStored = (
		windowId: string,
		atSec: number
	): ReturnType<typeof gradeOf> | null => {
		const stored = storedAt.get(`${windowId}@${atSec.toFixed(2)}`)
		return stored ?
				gradeOf(stored.text, stored.payload, verdictOf.get(`${stored.windowId}#${stored.index}`))
			:	null
	}

	/* ---------------------------------------- is the FIRST standing ask the good one? */

	/**
	 * THE CAP'S OWN EVIDENCE, and it needs no new run at all.
	 *
	 * `commentary` asks about standing objectives with no cap, and 56 of its turns in this corpus
	 * are `window.standing` at 21% [13-34] wrong and 73% [60-83] clean-useful. If the first standing
	 * ask of a game is the one worth having and the repeats are the noise, that shows up as a split
	 * by ordinal WITHIN the game — on lines that are already graded, with no model consulted and
	 * nothing re-run.
	 *
	 * It is a small n and it is reported with its n. It is also the only part of this measurement
	 * that says anything about line QUALITY rather than about volume, so it is the part to distrust
	 * first.
	 */
	const ordinalSplit = (): void => {
		const buckets = new Map<string, { spoke: number; wrong: number; useful: number }>()
		for (const w of run.windows) {
			/*
			 * ON at `commentary`'s OWN gate and cap, which is that level exactly as it ships — the
			 * `false` arm has no standing ask at all since this sweep's baseline was rebased, and
			 * asking it for standing turns returned an empty table with no error. Nothing said so
			 * until the JSON was read back.
			 */
			const { turns } = sweep(
				w.id,
				"commentary",
				true,
				askPolicy("commentary").standingSilenceSec,
				askPolicy("commentary").standingAskCap
			)
			let n = 0
			for (const t of turns) {
				if (!t.kinds.includes("window.standing")) continue
				n += 1
				const g = gradeStored(w.id, t.atSec)
				if (!g || g.grade === "pass") continue
				const k = n === 1 ? "1st of the game" : n === 2 ? "2nd" : "3rd or later"
				const c = buckets.get(k) ?? { spoke: 0, wrong: 0, useful: 0 }
				c.spoke += 1
				if (g.grade === "wrong") c.wrong += 1
				if (g.grade === "useful") c.useful += 1
				buckets.set(k, c)
			}
		}
		console.log(
			"\nIS THE FIRST STANDING ASK THE GOOD ONE? — `commentary`'s own graded lines, split by how" +
				"\nmany standing asks that game had already had. No model consulted, nothing re-run."
		)
		console.log(`  ${"".padEnd(18)}${"spoke".padStart(6)}${"wrong".padStart(16)}${"clean-useful".padStart(16)}`)
		for (const k of ["1st of the game", "2nd", "3rd or later"]) {
			const c = buckets.get(k)
			if (!c) continue
			console.log(
				`  ${k.padEnd(18)}${String(c.spoke).padStart(6)}${pct(c.wrong, c.spoke).padStart(16)}${pct(
					c.useful,
					c.spoke
				).padStart(16)}`
			)
		}
		standingReport.ordinalSplit = Object.fromEntries(buckets)
	}

	/* ------------------------------------------------------------------- the sweep */

	const GATES = [60, 90, 120, 150, 180, 210]
	/**
	 * THE CAP IS SWEPT ONLY AT `big-calls`, and that is the shape of the whole answer.
	 *
	 * A flat silence gate is a rate limit with no memory: satisfy it once and it can be satisfied
	 * again a minute later, which is the "timer walking back in through the silence door" that
	 * `STANDING_SILENCE_SEC` warns about — measured in the uncapped rows below at 7.46 standing asks
	 * a game at a 90s gate. A cap is the memory.
	 *
	 * `key-moments` is swept capped too, because the same question is open there: it has the kind
	 * already and a 210s gate, and 210 is longer than the 176-second hole, so it cannot reach inside
	 * it either. `commentary` is swept uncapped ONLY — it is the schedule every stored measurement
	 * in `data/eval/` was taken on, a capped row would be a schedule nobody can re-derive, and the
	 * uncapped rows are there to show what moving its gate would have cost.
	 */
	const CAPS: Record<string, number[]> = {
		"big-calls": [1, 2, Infinity],
		"key-moments": [1, Infinity],
		commentary: [Infinity]
	}
	const LEVELS: SpeakLevel[] = ["big-calls", "key-moments", "commentary"]
	const sweepRows: Record<string, unknown>[] = []
	const standingReport: Record<string, unknown> = {}

	console.log(
		`\nTHE STANDING-OBJECTIVE ASK — ${run.windows.length} games, no model in the loop.` +
			"\nOFF is the level with NO standing ask at all (`standingSilenceSec: Infinity`), which is a baseline" +
			"\nthat cannot move when something ships. ON allows the kind at the gate and cap shown." +
			"\nasks/28m is whole-game asks normalised by each game's own last SAMPLE, never its last turn."
	)
	for (const level of LEVELS) {
		const base = new Map<string, SweepTurn[]>()
		let baseAsks = 0
		let minutes = 0
		const baseEarly: number[] = []
		const baseWhole: number[] = []
		for (const w of run.windows) {
			const { turns, lastSampleSec } = sweep(w.id, level, false, 0, Infinity)
			base.set(w.id, turns)
			baseAsks += turns.length
			minutes += lastSampleSec / 60
			baseEarly.push(longestHole(turns, 0, 600, lastSampleSec))
			baseWhole.push(longestHole(turns, 0, Infinity, lastSampleSec))
		}
		const per28 = (n: number): string => ((28 * n) / (minutes / run.windows.length)).toFixed(2)
		const holeBase = base
			.get(HOLE_GAME)!
			.filter(t => t.atSec > HOLE_FROM_SEC && t.atSec < HOLE_TO_SEC)
		console.log(
			`\n  ${level} — WITH NO STANDING ASK AT ALL: ${per28(baseAsks / run.windows.length)} asks/28min, ` +
				`median longest silence ${(median(baseWhole) / 60).toFixed(1)}m, ` +
				`median longest pre-10:00 silence ${(median(baseEarly) / 60).toFixed(1)}m, ` +
				`${HOLE_GAME.slice(-9)} 4:21-7:17 has ${holeBase.length} turn(s)`
		)
		console.log(
			`  ${"gate".padStart(5)}${"cap".padStart(5)}${"asks/28m".padStart(10)}${"stand/gm".padStart(10)}${"gained".padStart(8)}${"LOST".padStart(6)}${"changed".padStart(9)}` +
				`${"med silence".padStart(13)}${"med pre-10".padStart(12)}${"hole".padStart(6)}${"graded".padStart(18)}`
		)
		for (const gate of GATES)
			for (const cap of CAPS[level]!) {
				let asks = 0
				let standAsks = 0
				let gained = 0
				let lost = 0
				let changed = 0
				const early: number[] = []
				const whole: number[] = []
				const lostDetail: string[] = []
				const gainedDetail: string[] = []
				const standingAt: number[] = []
				const kindDelta = new Map<string, number>()
				let holeTurns = 0
				const gradedRows: ReturnType<typeof gradeOf>[] = []
				for (const w of run.windows) {
					const { turns, lastSampleSec } = sweep(w.id, level, true, gate, cap)
					const off = base.get(w.id)!
					asks += turns.length
					early.push(longestHole(turns, 0, 600, lastSampleSec))
					whole.push(longestHole(turns, 0, Infinity, lastSampleSec))
					for (const t of off)
						for (const k of new Set(t.kinds)) kindDelta.set(k, (kindDelta.get(k) ?? 0) - 1)
					for (const t of turns)
						for (const k of new Set(t.kinds)) kindDelta.set(k, (kindDelta.get(k) ?? 0) + 1)
					const offAt = new Map(off.map(t => [t.atSec.toFixed(2), t.kinds.join("+")]))
					const onAt = new Set(turns.map(t => t.atSec.toFixed(2)))
					for (const t of turns) {
						if (t.kinds.includes("window.standing")) {
							standAsks += 1
							standingAt.push(t.atSec)
						}
						const was = offAt.get(t.atSec.toFixed(2))
						if (was === undefined) {
							gained += 1
							gainedDetail.push(`${w.id}@${clockOf(t.atSec)} ${t.kinds.join("+")}`)
							const g = gradeStored(w.id, t.atSec)
							if (g) gradedRows.push(g)
						} else if (was !== t.kinds.join("+")) changed += 1
					}
					for (const t of off)
						if (!onAt.has(t.atSec.toFixed(2))) {
							lost += 1
							lostDetail.push(`${w.id}@${clockOf(t.atSec)} ${t.kinds.join("+")}`)
						}
					if (w.id === HOLE_GAME)
						holeTurns += turns.filter(
							t => t.atSec > HOLE_FROM_SEC && t.atSec < HOLE_TO_SEC
						).length
				}
				const spoke = gradedRows.filter(r => r.grade !== "pass")
				const graded =
					spoke.length === 0 ?
						`0 of ${gained}`
					:	`${spoke.filter(r => r.grade === "useful").length}u/${spoke.filter(r => r.grade === "wrong").length}w of ${spoke.length}`
				standingAt.sort((a, b) => a - b)
				const shipped =
					gate === askPolicy(level).standingSilenceSec &&
					cap === askPolicy(level).standingAskCap &&
					askPolicy(level).kinds.includes("window.standing")
				console.log(
					`${shipped ? " *" : "  "}${String(gate).padStart(5)}${(cap === Infinity ? "—" : String(cap)).padStart(5)}${per28(asks / run.windows.length).padStart(10)}${(standAsks / run.windows.length).toFixed(2).padStart(10)}` +
						`${String(gained).padStart(8)}${String(lost).padStart(6)}${String(changed).padStart(9)}` +
						`${`${(median(whole) / 60).toFixed(1)}m`.padStart(13)}${`${(median(early) / 60).toFixed(1)}m`.padStart(12)}` +
						`${String(holeTurns).padStart(6)}${graded.padStart(18)}`
				)
				sweepRows.push({
					level,
					gate,
					cap: cap === Infinity ? null : cap,
					/** True on the row this level actually ships, so the table says which one is live. */
					shipped,
					asksPer28Min: Number(per28(asks / run.windows.length)),
					standingAsksPerGame: standAsks / run.windows.length,
					/* Where it lands, which is how a silence gate is caught being a clock. */
					standingAtSec: standingAt,
					standingBandSec:
						standingAt.length === 0 ?
							null
						:	{
								first: standingAt[0]!,
								median: median(standingAt),
								last: standingAt.at(-1)!,
								before10Min: standingAt.filter(s => s < 600).length
							},
					turnsGained: gained,
					turnsLost: lost,
					turnsChanged: changed,
					medianLongestSilenceSec: median(whole),
					medianLongestPre10SilenceSec: median(early),
					holeGameTurnsInHole: holeTurns,
					perKindChange: Object.fromEntries([...kindDelta].filter(([, n]) => n !== 0)),
					lostDetail,
					gainedDetail
				})
			}
	}
	console.log(
		"\n  `hole` is how many turns land inside 4:21-7:17 of the drake game; 0 is the hole as it is today." +
			"\n  `graded` counts only gained turns whose clock a stored commentary line happens to sit on, and" +
			"\n  a 90s row lands on those clocks because the corpus's own gate is 90s. Do not pick a gate on it." +
			"\n  A row marked * is the configuration that level ships today."
	)
	ordinalSplit()

	const STANDING_OUT = arg("--standing-out", "")
	if (STANDING_OUT !== "")
		writeFileSync(
			STANDING_OUT,
			`${JSON.stringify(
				{
					what: "Should `big-calls` get a standing-objective ask, and under what gate and cap? The real detector replayed over the 28-game corpus at every level, gate and cap, ON against OFF. No model is consulted and no line is generated; re-derive with `node --experimental-strip-types scripts/measure-asks.ts --standing`.",
					ranAt: new Date().toISOString(),
					corpus: RUN,
					judged: JUDGED,
					holeGame: { id: HOLE_GAME, fromSec: HOLE_FROM_SEC, toSec: HOLE_TO_SEC },
					...standingReport,
					sweep: sweepRows
				},
				null,
				"\t"
			)}\n`
		)
}
