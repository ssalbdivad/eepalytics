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
	commitTurn,
	dueTurn,
	newEventWatch,
	observeTick,
	projectTick
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
		watch.pending.push(...observeTick(watch, tick, { asksBeforeFifthCut: BEFORE }))
		const reason = dueTurn(watch, tick.gameTimeSec, { heartbeatSec: run.heartbeatSec })
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

const gradeOf = (text: string, payload: string, verdict: string | undefined): Grade => {
	const score = scoreLine({ line: text, block: payload, roster: rosterOf(payload), champions })
	if (score.silent) return "pass"
	const clock = mechanicalVerdict(clockClaims(text, readPayload(payload)))
	if (clock === "contradicted" || clock === "inversion-shaped") return "wrong"
	if (verdict === "false") return "wrong"
	return verdict === "useful" ? "useful" : "other"
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
		rows.push({
			game: w.id,
			atSec: turn.atSec,
			grade: gradeOf(r.text, r.payload, verdictOf.get(`${r.windowId}#${r.index}`)),
			kinds: turn.heartbeat ? ["heartbeat"] : turn.asks.map(a => a.kind),
			causes: turn.heartbeat ? ["heartbeat"] : causes,
			ordinal
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
	console.log(
		`${label.padEnd(40)}turns ${String(rows.filter(keep).length).padStart(4)}  wrong/game ${w0.toFixed(2)}->${w1.toFixed(2)}  useful/game ${u0.toFixed(2)}->${u1.toFixed(2)}  ratio ${ratio === Infinity ? "inf" : ratio.toFixed(2)}`
	)
}

console.log(
	`${RUN}${BEFORE ? "  (schedule replayed as it stood BEFORE the fifth cut)" : ""}\n${rows.length} turns joined to the ask that raised them; ${newInstants} replayed turn(s) the stored run never took, ungraded`
)
tally("BY ASK KIND", r => r.kinds)
tally("BY CAUSE (a window ask is split by every field that moved)", r => r.causes)
tally("BY HOW MANY TIMES THIS CONTEST WINDOW HAS BEEN ASKED", r => [
	r.ordinal === null ? "off-window" : r.ordinal <= 4 ? `ask #${r.ordinal}` : "ask #5+"
])

if (CUTS) {
	console.log("\nCUTS — wrong lines removed per useful line removed. Under 1.00 is a bad trade.")
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
