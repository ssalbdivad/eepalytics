/**
 * THE SAME MOMENTS, ASKED AGAIN — does the coach speak the clock it was given?
 *
 * `scripts/measure-deadclock.ts` measures the INPUT: it replays stored turns through the memory and
 * the brief as they now stand and asks whether the payload states the elapsed figure the sentence
 * needed. After the payload fix it answers yes for 129 of 129 identifiable subjects, and the OUTPUT
 * did not move at all — the coach still spoke the REMAINING figure as though it were elapsed in 91%
 * [84-95] of the lines that state one, slightly MORE often than before the input was fixed.
 *
 * That is a question about the model, and no instrument in this repo could ask it: a stored
 * measurement cannot be re-spoken. This one re-asks. It takes the turns where the defect actually
 * happened, sends the payload back to the same arm that produced them, and counts the same thing
 * `measure-deadclock.ts` counts — so the control cell here is directly comparable to the 88/93 that
 * selected the turns in the first place.
 *
 * ## The two candidate causes, and why they are run as a 2x2
 *
 *   RENDER  the two clocks are not self-describing. `DEAD, down 4s, back in 24s` is two bare
 *           numbers on one line and the larger, later one reads like the answer to "how long has he
 *           been down". `--render` rewrites that pair to `died 4s ago, respawns in 24s` — the SAME
 *           two figures, each naming its own direction.
 *   PROMPT  nothing in the trusted system prompt names the elapsed clock at all. It names exactly
 *           one of the two ("every respawn timer … with his timer counting down"), which is the
 *           shape that produces a confident wrong number rather than a refusal. That arm is not a
 *           flag here, because the system prompt is not a parameter of `coachTurn` and must not
 *           become one: run this script, change the prompt, run it again, and pass `--label` so the
 *           two output files say which side of the change they are.
 *
 * Both cells are INFORMATION — what a field means — and neither tells the model what to say or when
 * to say it. Nothing here gates, ranks or suppresses a line.
 *
 * ## What it counts
 *
 * Of the answers that state an elapsed death time about a man the payload names as DEAD with both
 * clocks printed for him:
 *
 *   - spoke the REMAINING figure (within 10s of `back in`/`respawns in`, and not within 10s of the
 *     elapsed one) — the defect;
 *   - spoke the ELAPSED figure on the same test — the fix working;
 *   - neither — a third number, which is its own failure and is reported, never folded into either;
 *   - inversion-shaped: the spoken figure is more than twice the watched elapsed one and at least
 *     15s, i.e. the same mechanical check the adjudicator uses.
 *
 * A turn where the answer states no elapsed death time at all is NOT a defect and is counted
 * separately as `no-elapsed-claim`. Staying quiet about the clock is a legitimate answer and
 * scoring it as a pass or a fail would both be wrong.
 *
 * ## WHAT IT FOUND, 2026-09-12, so nobody pays for this twice
 *
 * The 2x2 above, on the 93 turns where the defect actually happened, 75-odd readable lines a cell:
 *
 *   payload `down 4s, back in 24s`      prompt as shipped   72/76 = 95% [87-98] spoke the remaining figure
 *   payload `died 4s ago, respawns in`  prompt as shipped   71/74 = 96% [89-99]
 *   payload `down 4s, back in 24s`      prompt names both   72/75 = 96% [89-99]
 *   payload `died 4s ago, respawns in`  prompt names both   70/75 = 93% [85-97]
 *
 * Four cells on top of each other, and the ELAPSED figure was spoken 0 of 75 times in every one of
 * them. BOTH stated hypotheses are refuted: it is not the rendering and it is not the prompt.
 *
 * The FRAMING measure says why. Of the 93 stored lines the 91% headline was computed from, 0 [0-4]
 * are framed as a claim about the past — not one says "has been dead" or "died N seconds ago". 92%
 * [85-96] are the bare form, "Viego is dead for fourteen seconds, so take this dragon right now":
 * the remaining figure, correct, attached to a correct decision, in a sentence a listener can read
 * backwards. The coach is not inverting a clock. It is describing a WINDOW in ambiguous English,
 * and the instrument that reads "dead for N seconds" as a past-tense claim is reading it wrong too.
 *
 * AND THE THIRD OPTION IS THE DANGEROUS ONE. `elapsed-only` withholds the remaining figure, which
 * is the change that looks safest on paper. Death-duration claims collapse from 82% of turns to 10%
 * [5-17] — and of the nine that survive, 0 speak the elapsed figure it was given and SIX state a
 * number that is in no clock at all, rounded to 20 or 30 ("Briar is dead for thirty seconds" over a
 * payload reading `died 2s ago` and nothing else). Taking the window away does not make the coach
 * say the elapsed figure. It makes it invent a window. Do not ship that.
 *
 *   node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *     scripts/measure-deadclock-replay.ts --label control --out data/eval/deadclock-replay-control.json
 *
 *     --corpus <file>   the run whose turns are replayed (default: the integrate3 gemini-http run)
 *     --arm <id>        which arm's answers select the turns, and which provider is re-asked
 *     --limit <n>       replay only the first n selected turns (they are in corpus order)
 *     --cells a,b,c     which payloads to send, of `payload-as-shipped` (the control),
 *                       `render` (both clocks self-describing) and `elapsed-only` (the remaining
 *                       figure removed entirely). Default is the control alone
 *     --label <text>    stamped into the output, e.g. which prompt was in the tree
 *     --rescore f1,f2   re-print the table from rows already written, paying nothing
 *     --concurrency <n> default 6
 *     --out <file>      write the rows
 */
import { readFileSync, writeFileSync } from "node:fs"
import { wilson } from "../src/analysis/coach-score.ts"
import { framingOf } from "./lib/payload-claims.ts"
import type { Framing } from "./lib/payload-claims.ts"
import { coachTurn } from "../src/review/live-providers.ts"
import type { ProviderId } from "../src/review/live-providers.ts"

const arg = (name: string): string | null => {
	const i = process.argv.indexOf(`--${name}`)
	return i < 0 ? null : (process.argv[i + 1] ?? null)
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

const CORPUS = arg("corpus") ?? "data/eval/integrate3-corpus-20260912.json"
const ARM = (arg("arm") ?? "gemini-http") as ProviderId
const LABEL = arg("label") ?? "unlabelled"
const LIMIT = arg("limit") === null ? null : Number(arg("limit"))
const CONCURRENCY = Number(arg("concurrency") ?? "6")

const pctOf = (a: number, b: number): string => {
	if (b === 0) return `${a}/${b} = n/a`
	const w = wilson(a, b)
	return `${a}/${b} = ${(100 * w.p).toFixed(0)}% [${(100 * w.lo).toFixed(0)}-${(100 * w.hi).toFixed(0)}]`
}

/* ---------------------------------------------------------------- reading a spoken number */

const ONES: Record<string, number> = {
	zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
	ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
	seventeen: 17, eighteen: 18, nineteen: 19
}
const TENS: Record<string, number> = {
	twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
}

/**
 * The phrasing and the number-reading are COPIED from `scripts/measure-deadclock.ts` rather than
 * imported, and that is deliberate: they are the definition of the before figure this run is
 * compared against, and an import would let a later edit there silently move the comparison.
 */
export const ELAPSED_WIDE =
	/\b(?:dead|down|gone)\s+(?:for|since)\s+(?:over\s+|about\s+|nearly\s+|almost\s+|more than\s+|a full\s+|roughly\s+|at least\s+)?((?:a full minute|half a minute|a minute|[a-z0-9-]+(?:[\s-][a-z]+)?))\s*(?:seconds|second|secs|s\b|$)/i

/** "dead for another 20 seconds" is the REMAINING figure spoken correctly. Not the defect. */
export const REMAINING_PHRASE = /\b(?:dead|down|gone)\s+for\s+(?:another|the next)\b/i

export const spokenNumber = (text: string): number | null => {
	const t = text.toLowerCase().replace(/–|—/g, "-")
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

/* ---------------------------------------------------------------- the payload's own two clocks */

const REMAINING_FIGURE = /(?:back in|respawns in) (\d+)s/
const ELAPSED_FIGURE = /(?:down (?:at least )?(\d+)s|died (?:at least )?(\d+)s ago)/

/** The figure the payload prints for one man, read off the line that names him. */
export const figureFor = (payload: string, subject: string, what: RegExp): number | null => {
	for (const line of payload.split("\n")) {
		if (!new RegExp(`\\b${subject}\\b`, "i").test(line)) continue
		const m = line.match(what)
		if (m !== null) return Number(m[1] ?? m[2])
	}
	return null
}

/** Every champion the payload states is DEAD right now, by the forms the brief renders. */
export const deadSubjects = (payload: string): string[] => {
	const out = new Set<string>()
	for (const m of payload.matchAll(/^(?:Counterpart )?([A-Z][A-Za-z' ]+?): DEAD/gm)) out.add(m[1]!)
	for (const m of payload.matchAll(/^- ([A-Za-z' ]+) — the enemy jungler — is DEAD/gm)) out.add(m[1]!)
	return [...out]
}

/* ---------------------------------------------------------------- the RENDER cell */

/**
 * The self-describing pair, applied to a stored payload.
 *
 * This is a transform of TEXT rather than a second rendering path, and the honest reason is that
 * re-rendering these turns would step the whole sample stream through the brief again and produce
 * blocks that differ from the stored ones in more than the clocks — which is the one thing a cell
 * comparison may not do. `live-brief.test.ts` pins that `downClock` emits exactly the phrasing on
 * the right-hand side here, so this stays the same experiment as the shipped renderer.
 */
export const selfDescribing = (payload: string): string =>
	payload
		.replace(/\bdown at least (\d+)s\b/g, "died at least $1s ago")
		.replace(/\bdown (\d+)s\b/g, "died $1s ago")
		.replace(/\belapsed NOT KNOWN\b/g, "time since death NOT KNOWN")
		.replace(/\bback in (\d+)s\b/g, "respawns in $1s")

/**
 * THE THIRD OPTION, which is the one that can do harm: the elapsed clock ALONE.
 *
 * If the coach speaks the remaining figure because it is the only one it can see a use for, then
 * taking it away should produce the elapsed figure. If it speaks the remaining figure because it
 * wants a WINDOW, then taking it away should produce either silence or a window built out of the
 * wrong number — and that second outcome is worse than anything measured so far, because the
 * remaining figure is the one that says how long he has to act.
 */
export const elapsedOnly = (payload: string): string =>
	selfDescribing(payload)
		.replace(/,? ?respawns in \d+s/g, "")
		.replace(/, \d+s until you are up/g, "")
		.replace(/, \d+s more/g, "")
		.replace(/DEAD for \d+s more/g, "DEAD")

/* ---------------------------------------------------------------- selecting the moments */

interface Window {
	id: string
	champion: string
	counterpart: string | null
}

interface Turn {
	windowId: string
	index: number
	clock: string
	champion: string
	counterpart: string | null
	payload: string
	/** What the stored run said at this turn, kept so a row shows the defect it was selected for. */
	storedText: string
	subject: string
	remainingSec: number
	elapsedSec: number
}

const corpus = JSON.parse(readFileSync(CORPUS, "utf8")) as {
	windows: Window[]
	records: { arm: string; windowId: string; index: number; clock: string; text?: string; payload?: string }[]
}
const windows = new Map(corpus.windows.map(w => [w.id, w]))

/**
 * THE OFFENDING MOMENTS, and the selection is deliberately narrow.
 *
 * A turn qualifies only when the stored answer stated an elapsed death time about a man the payload
 * printed BOTH clocks for. That is the population the 91% is a percentage of, so re-asking exactly
 * it makes the control cell comparable to the stored figure rather than to a different denominator.
 * It also means this run cannot show the fix working on turns where there was never a defect.
 */
const selected: Turn[] = []
for (const rec of corpus.records) {
	if (rec.arm !== ARM) continue
	const text = String(rec.text ?? "").trim()
	const payload = String(rec.payload ?? "")
	if (text === "" || payload === "") continue
	const m = text.match(ELAPSED_WIDE)
	if (m === null || REMAINING_PHRASE.test(text)) continue
	const subject = deadSubjects(payload).find(c => new RegExp(`\\b${c}\\b`, "i").test(text))
	if (subject === undefined) continue
	const remainingSec = figureFor(payload, subject, REMAINING_FIGURE)
	const elapsedSec = figureFor(payload, subject, ELAPSED_FIGURE)
	if (remainingSec === null || elapsedSec === null) continue
	const w = windows.get(rec.windowId)
	if (w === undefined) continue
	selected.push({
		windowId: rec.windowId,
		index: rec.index,
		clock: rec.clock,
		champion: w.champion,
		counterpart: w.counterpart ?? null,
		payload,
		storedText: text,
		subject,
		remainingSec,
		elapsedSec
	})
}

const turns = LIMIT === null ? selected : selected.slice(0, LIMIT)

/* ---------------------------------------------------------------- scoring one answer */

type Verdict = "spoke-remaining" | "spoke-elapsed" | "spoke-other" | "unreadable" | "no-elapsed-claim"

/**
 * HOW THE SENTENCE FRAMES ITS NUMBER, which turns out to matter more than which number it is.
 *
 * `ELAPSED_WIDE` was written to catch "dead for N seconds" and it catches it whatever the sentence
 * MEANS by it. English does not settle that: "Viego is dead for fourteen seconds" is a claim about
 * the past to one listener and a fourteen-second window to another, and the coach turns out to mean
 * the second — it pairs the figure with something to do now, every time.
 *
 * So the phrasing is classified separately from the figure:
 *
 *   `past`   an unambiguous time-since-death — "has been dead for", "died N seconds ago";
 *   `window` an unambiguous remaining figure — "for another N", "N more seconds";
 *   `bare`   "dead for N seconds", which is neither, and is what the coach almost always says.
 *
 * A `bare` line carrying the REMAINING figure is not a wrong number. It is a right number in a
 * sentence a listener can read backwards, and that is a different defect with a different fix.
 */
/* `framingOf` and its two regexes moved to `scripts/lib/payload-claims.ts` so that
 * `measure-deadclock.ts` classifies a stored line by the same rule this file classifies a
 * re-asked one. Imported above. */

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 10

export const verdictFor = (answer: string, t: Turn): { verdict: Verdict; framing: Framing; said: string | null; spokenSec: number | null } => {
	const framing = framingOf(answer)
	const m = answer.match(ELAPSED_WIDE)
	if (m === null || REMAINING_PHRASE.test(answer)) return { verdict: "no-elapsed-claim", framing, said: null, spokenSec: null }
	const spokenSec = spokenNumber(m[1]!)
	if (spokenSec === null) return { verdict: "unreadable", framing, said: m[0], spokenSec: null }
	const asRemaining = near(spokenSec, t.remainingSec)
	const asElapsed = near(spokenSec, t.elapsedSec)
	/*
	 * The two windows can overlap when a man has been down about as long as he has left — roughly
	 * half a respawn. A line that fits both is evidence for neither, so it is `spoke-other` rather
	 * than a free pass for whichever cell is being argued for.
	 */
	if (asRemaining && !asElapsed) return { verdict: "spoke-remaining", framing, said: m[0], spokenSec }
	if (asElapsed && !asRemaining) return { verdict: "spoke-elapsed", framing, said: m[0], spokenSec }
	return { verdict: "spoke-other", framing, said: m[0], spokenSec }
}

/* ---------------------------------------------------------------- re-scoring, with no calls */

/**
 * `--rescore a.json,b.json` reads rows this script already wrote and prints the table again.
 *
 * It exists because the FRAMING measure was added after the calls were paid for, and a stored
 * measurement is never re-asked and never rewritten. The answers are on disk; the classification is
 * a function of them, so the figure below is re-derivable from the same rows the first table came
 * from and nobody has to take the second reading on trust.
 */
const rescore = arg("rescore")
if (rescore !== null) {
	for (const file of rescore.split(",")) {
		const run = JSON.parse(readFileSync(file, "utf8")) as { label: string; rows: Row[] }
		for (const cell of [...new Set(run.rows.map(r => r.cell))]) {
			const readable = run.rows.filter(
				r => r.cell === cell && r.ok && r.verdict !== "no-elapsed-claim" && r.verdict !== "unreadable"
			)
			const f = (x: Framing) => readable.filter(r => framingOf(r.answer) === x).length
			console.log(`${file} ${cell} (${run.label})`)
			console.log(`  lines stating a death duration: ${readable.length}`)
			console.log(`  past-framed   (unambiguously time-since-death): ${pctOf(f("past"), readable.length)}`)
			console.log(`  window-framed (unambiguously time-remaining):   ${pctOf(f("window"), readable.length)}`)
			console.log(`  bare          ("dead for N seconds", neither):  ${pctOf(f("bare"), readable.length)}`)
			const bareRemaining = readable.filter(r => framingOf(r.answer) === "bare" && r.verdict === "spoke-remaining")
			console.log(`  of the bare ones, carrying the REMAINING figure: ${pctOf(bareRemaining.length, f("bare"))}`)
			/*
			 * AND THE SAME QUESTION OF THE LINES THE HEADLINE WAS COMPUTED FROM. Every row carries
			 * the stored answer it was selected for, so the 91% [84-95] of the 2026-09-12 corpus can
			 * be classified without re-asking anything and without touching the stored file.
			 */
			const stored = [...new Set(run.rows.filter(r => r.cell === cell).map(r => r.storedText))]
			const sf = (x: Framing) => stored.filter(t => framingOf(t) === x).length
			console.log(
				`  the STORED lines the 91% came from: ${stored.length} — past ${pctOf(sf("past"), stored.length)}, window ${pctOf(sf("window"), stored.length)}, bare ${pctOf(sf("bare"), stored.length)}`
			)
		}
	}
	process.exit(0)
}

/* ---------------------------------------------------------------- the run */

interface Row extends Omit<Turn, "payload"> {
	cell: string
	answer: string
	ok: boolean
	reason: string | null
	latencyMs: number
	verdict: Verdict
	framing: Framing
	said: string | null
	spokenSec: number | null
	/** The adjudicator's own mechanical inversion test, on the watched elapsed figure. */
	inversionShaped: boolean
}

const ALL_CELLS: Record<string, (p: string) => string> = {
	"payload-as-shipped": p => p,
	render: selfDescribing,
	"elapsed-only": elapsedOnly
}

/** `--cells a,b,c`. Default is the shipped payload alone, so a bare run is the control. */
const cells: { id: string; render: (p: string) => string }[] = (arg("cells") ?? "payload-as-shipped")
	.split(",")
	.map(id => {
		const render = ALL_CELLS[id]
		if (render === undefined) throw new Error(`no cell called ${id} — have ${Object.keys(ALL_CELLS).join(", ")}`)
		return { id, render }
	})

const jobs: { cell: string; t: Turn; block: string }[] = []
for (const c of cells) for (const t of turns) jobs.push({ cell: c.id, t, block: c.render(t.payload) })

console.log(`${turns.length} offending turns x ${cells.length} cell(s) = ${jobs.length} paid calls to ${ARM}`)
console.log(`label "${LABEL}" — stamp the prompt that is in the tree, because it is not a parameter here\n`)

const rows: Row[] = []
let done = 0
const worker = async () => {
	for (;;) {
		const job = jobs.shift()
		if (job === undefined) return
		const r = await coachTurn({
			provider: ARM,
			blockText: job.block,
			champion: job.t.champion,
			counterpart: job.t.counterpart
		})
		const answer = (r.text ?? "").trim()
		const v = verdictFor(answer, job.t)
		const { payload: _payload, ...rest } = job.t
		rows.push({
			...rest,
			cell: job.cell,
			answer,
			ok: r.ok,
			reason: r.reason ?? null,
			latencyMs: r.latencyMs,
			...v,
			inversionShaped: v.spokenSec !== null && v.spokenSec > job.t.elapsedSec * 2 && v.spokenSec >= 15
		})
		done += 1
		if (done % 20 === 0) console.log(`  ${done}/${jobs.length}`)
	}
}
await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker))

/* ---------------------------------------------------------------- the report */

const pct = pctOf

console.log("")
for (const c of cells) {
	const mine = rows.filter(r => r.cell === c.id && r.ok)
	const claims = mine.filter(r => r.verdict !== "no-elapsed-claim")
	const readable = claims.filter(r => r.verdict !== "unreadable")
	console.log(`CELL ${c.id}  (label ${LABEL})`)
	console.log(`  turns re-asked: ${mine.length}, errors: ${rows.filter(r => r.cell === c.id && !r.ok).length}`)
	console.log(`  stated an elapsed death time at all: ${pct(claims.length, mine.length)}`)
	console.log(`  of those, spoke the REMAINING figure: ${pct(readable.filter(r => r.verdict === "spoke-remaining").length, readable.length)}`)
	console.log(`  of those, spoke the ELAPSED figure:   ${pct(readable.filter(r => r.verdict === "spoke-elapsed").length, readable.length)}`)
	console.log(`  of those, a third number:             ${pct(readable.filter(r => r.verdict === "spoke-other").length, readable.length)}`)
	console.log(`  inversion-shaped (>2x watched elapsed, >=15s): ${pct(readable.filter(r => r.inversionShaped).length, readable.length)}`)
	console.log("  HOW IT FRAMED THE NUMBER — a bare duration is neither a past claim nor a window:")
	for (const f of ["past", "window", "bare"] as const)
		console.log(`    ${f.padEnd(7)} ${pct(readable.filter(r => r.framing === f).length, readable.length)}`)
	for (const r of mine.filter(r => r.verdict === "spoke-remaining").slice(0, 3))
		console.log(`    ${r.clock} ${r.subject}: payload down ${r.elapsedSec}s / back in ${r.remainingSec}s -> "${r.said}"`)
	for (const r of mine.filter(r => r.verdict === "spoke-elapsed").slice(0, 3))
		console.log(`    OK ${r.clock} ${r.subject}: payload down ${r.elapsedSec}s / back in ${r.remainingSec}s -> "${r.said}"`)
	console.log("")
}

const out = arg("out")
if (out !== null) {
	writeFileSync(
		out,
		`${JSON.stringify({ ranAt: new Date().toISOString(), argv: process.argv.slice(2), label: LABEL, corpus: CORPUS, arm: ARM, cells: cells.map(c => c.id), turns: turns.length, rows }, null, 2)}\n`
	)
	console.log(`wrote ${out}`)
}
