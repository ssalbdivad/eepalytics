/**
 * judge-corpus — grade every line a `bench-stream --games ...` run spoke, blinded, and report the
 * rates PER GAME as well as pooled.
 *
 * ## Why this is not `frame-value.ts --rejudge`
 *
 * That judge grades a line against its own real SCREENSHOT, so it only runs on a paired window and
 * only on frame-value's own run shape. Thirteen of this corpus's seventeen games have no frames at
 * all — the browser was closed and the daemon's own poll recorded the game anyway — and those are
 * the games that carry thirteen different enemy junglers, which is the only real test the champion
 * knowledge has ever had. Refusing to grade them because there is no picture would be measuring the
 * four games we already over-measured.
 *
 * So this grades against the PAYLOAD alone: the block the coach actually held, stored verbatim in
 * the run file. That is a weaker judge and the report says so — `contradicted-by-picture` is not a
 * verdict it can reach, so its `false` rate is a FLOOR, not the truth.
 *
 * ## Blinding, and why it is not optional here
 *
 * Every percentage this project has produced from a judge that knew what it was grading has later
 * had to be walked back. So: the arm label is stripped, the lines are shuffled with a seeded
 * generator whose seed is written into the output, and the judge is a different model family from
 * the coach that spoke. The key from opaque id back to (arm, game, clock) is rejoined by code after
 * the verdicts come back, never by a reader.
 *
 * ## TWO INSTRUMENTS, not one
 *
 * The judge was measured against the exact record (`scripts/adjudicate.ts`) and found wrong in two
 * opposite directions, which is the worst case because they partly cancel and the total looks
 * accurate. It called real champion mechanics fabrications because it was never given the coach's
 * champion notes, and it waved through an inverted death clock because the ACTION survives the
 * wrong number. Both corrections are documented beside the prompt below.
 *
 * The second of them is only half a prompt change. A figure that can be checked by subtraction is
 * checked by subtraction, in `scripts/lib/payload-claims.ts`, with no model in the loop — and that
 * verdict is printed and stored BESIDE the judge's rather than merged into it. Two instruments
 * that fail differently are worth more than one that fails where nobody can see.
 *
 * ## What the two corrections moved, 2026-09-12
 *
 * Re-judged over the same 840 lines of `integrate2-corpus-20260912.json`, same seed, same shuffle
 * (`-judged.json` against `-judged-fixedjudge.json`). **185 of 840 verdicts moved, 22%** — 99 into
 * `false`, 67 out of it — so this is not a tweak, it is a different instrument.
 *
 *   - THE CHAMPION NOTES. Five `false` verdicts rested on calling a real Lillia mechanic an
 *     invention; four are no longer false (4/5, and the fifth was false for an unrelated reason
 *     the new judge names instead). All five named Prance or the Swirlseed reveal, both of which
 *     are written down in `knowledge/champions/lillia.md`. The notes cut BOTH ways, which is the
 *     sign they are being read rather than deferred to: one line is now false *because* of them —
 *     "ult to take dragon" against a kit note saying the ult only sleeps an enemy already covered
 *     in Dream Dust.
 *   - THE INVERSION. 138 lines state a death clock the code can check. The old judge called 27 of
 *     them false (20% [14-27]); this one calls 67 (49% [40-57]); the judge OR the mechanical check
 *     catches 76 (55% [47-63]). The remaining gap is real and stated rather than closed: on a
 *     payload that carries only the remaining figure, neither instrument can PROVE an elapsed
 *     claim wrong, and the record (`scripts/adjudicate.ts`) is where such a line is settled.
 *
 * The pooled false rate goes 17% [15-20] -> 21% [18-24], and 51 of the 99 newly-false lines have
 * nothing to do with either correction — a gold figure, a mana band, a drake timer read off by
 * five seconds. A judge given one figure to check reads the others more carefully too, and that is
 * exactly the spillover the death-clock rule's last paragraph exists to bound. Whether the new
 * rate is BETTER is not answerable from the rate: it is answered against the exact record, where
 * this judge agrees 42/47 (89% [77-95]) against the old judge's 34/47 (72% [58-83]).
 *
 * ## Per game, not only pooled
 *
 * Pooling hides the game where it fell apart, and a 43-minute game raises about twice the turns of
 * a 24-minute one and would otherwise carry twice the vote silently. The per-game rows are printed
 * without intervals on purpose — on a 25-line game the interval covers almost any claim — and the
 * Wilson interval is on the pooled row, where it means something.
 *
 * Usage:
 *     node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *       scripts/judge-corpus.ts <run.json> --arm gemini-http [--judge anthropic] [--batch 8]
 *
 *     --concurrency N  batches in flight (default 6). The batches are independent; the only
 *                  thing raising it can break is the provider's rate limit
 *     --out <path> where the verdicts go (default: the run's name with `-judged`). It REFUSES to
 *                  overwrite an existing file: re-judging a corpus must not destroy the number it
 *                  is correcting.
 *     --plain      grade with the judge as it stood before the champion notes and the death-clock
 *                  rule, so a before/after over one corpus is one script and two flags. The
 *                  mechanical check still runs: it is code, and the flag varies the JUDGE.
 *     --arm <id[,id...]>  grade only these arms. `bench-stream` always writes a `mock` reference
 *                  arm beside the real one, and pooling its echoes with real lines halves every
 *                  rate. A comma list judges an ABLATION's arms in one shuffled, blinded pool —
 *                  one judge, one standard — and the report breaks out per arm and per game.
 *
 * NODE ONLY. Reads a stored run and never writes to it: the verdicts go to a NEW file beside it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { modelHandleFor, providerById, providerKey } from "../src/review/live-providers.ts"
import { shuffled } from "./lib/stats.ts"
import { isEmpty, isSilent, wilson } from "../src/analysis/coach-score.ts"
import type { Interval } from "../src/analysis/coach-score.ts"
import { fullKnowledge } from "../src/review/live-knowledge-full.ts"
import { clockClaims, deathClockBlock, mechanicalVerdict, readPayload } from "./lib/payload-claims.ts"
import type { ClockClaim } from "./lib/payload-claims.ts"

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : fallback
}
const runPath = argv.find(a => !a.startsWith("--") && a.endsWith(".json"))
if (!runPath) throw new Error("usage: judge-corpus.ts <run.json> [--judge anthropic]")

/*
 * IT WILL NOT CLOBBER A STORED MEASUREMENT, and it says so BEFORE spending anything.
 *
 * The default output name is derived from the run, so re-judging the same corpus — which is exactly
 * what you do after fixing the judge — used to overwrite the earlier verdicts and destroy the only
 * copy of the number being corrected. A run that lands on an existing file stops and asks for
 * `--out`, so the before and the after both survive and a correction can be SHOWN rather than
 * asserted. Checked here, at argument-parse time, rather than beside the write: an hour of judge
 * calls is the wrong moment to learn the file already exists.
 */
const outPath = ((): string => {
	const i = argv.indexOf("--out")
	const given = i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : ""
	return given === "" ? runPath.replace(/\.json$/, "-judged.json") : given
})()
if (existsSync(outPath))
	throw new Error(
		`${outPath} already exists and holds an earlier measurement. Pass --out <path> — stored runs are ` +
			`never rewritten, so a corrected number can be compared against the one it corrects.`
	)

const judgeProvider = arg("judge", "anthropic")
const judgeModelArg = arg("judge-model", "")
const batchSize = Number(arg("batch", "8"))
const seed = Number(arg("seed", "20260911"))
/*
 * WHICH arm to grade, and the default is not "all of them". `bench-stream` always writes a `mock`
 * arm beside the real one as a reference transcript — 529 template echoes in this corpus — and
 * pooling those with the model's lines would halve every rate for a reason that has nothing to do
 * with the coach. Named explicitly so a run that meant to grade two arms says so.
 *
 * A COMMA LIST grades several arms in ONE shuffled pool, which is the only honest way to judge an
 * ablation: two runs of this script are two different judge conversations, and the arm that went
 * second would be compared against a judge that had already settled into a standard on the first.
 * Blinding is what makes it safe — the arm label is stripped before the shuffle, so a batch holds
 * lines from every arm in an order the judge cannot attribute, and the rejoin happens in code.
 */
const armWanted = new Set(
	arg("arm", "")
		.split(",")
		.map(a => a.trim())
		.filter(a => a !== "")
)
/*
 * Batches in flight at once. The judge is the slow half by a long way — one batch of eight lines,
 * each carrying its own ~6000-character payload, took a measured 96 seconds against Sonnet, so a
 * 529-line corpus is 105 minutes serial and about 18 at six. The batches are independent by
 * construction — each carries its own payloads and returns verdicts keyed by opaque id — so the
 * only thing concurrency can change is the provider's rate limit, which is why it is a knob.
 */
const concurrency = Math.max(1, Number(arg("concurrency", "6")))
/*
 * `--plain` grades with the judge as it stood before the champion notes and the death-clock rule
 * were added to it, so the two can be run over the same corpus and differenced. It also turns off
 * the per-candidate clock block, because that block is half of the same change.
 */
const plain = argv.includes("--plain")

/*
 * UNGRADED is a verdict, not an absence.
 *
 * It is what this instrument says when it could not get an answer about a line: the judge's JSON
 * would not parse even with the line on its own, or it came back with a verdict word that is not
 * one of the four. Earlier versions had no such state, so both of those outcomes left the line out
 * of the output file entirely and every rate was computed over the survivors — which is a
 * denominator that silently excludes its own failures, and is how 50 of 529 corpus lines went
 * missing while the report still printed a confident 74%.
 *
 * An ungraded line stays in `n`. `useful` and `false` are therefore FLOORS whenever any line is
 * ungraded, and the report prints the ceiling beside them rather than leaving the reader to work
 * out which way the uncertainty cuts.
 */
type Verdict = "useful" | "generic" | "unverifiable" | "false" | "ungraded"
const GRADES = ["useful", "generic", "unverifiable", "false"] as const

interface Record_ {
	arm: string
	windowId: string
	index?: number
	rep?: number
	atSec: number
	clock: string
	text: string | null
	error: string | null
	payload: string
}
interface Window_ {
	id: string
	gameId: string
	champion: string
	counterpart?: string | null
	kind?: string
	gameDurationSec?: number
}
interface RunFile {
	windows: Window_[]
	records: Record_[]
}

/*
 * THE JUDGE WAS WRONG IN TWO OPPOSITE DIRECTIONS, which is the worst case because they cancel and
 * the total looks accurate. Both halves of this prompt are a correction to a measured failure.
 *
 * ## It did not know what the coach knew
 *
 * The live coach is handed its champion's own notes — `knowledge/champions/*.md`, loaded by
 * `src/review/live-knowledge-full.ts` — so it can say things about the KIT that no client feed
 * carries. The judge was handed only the payload, and the payload contains no champion knowledge
 * at all. So a judge asked whether a sentence is supported reached "invented mechanic" for
 * mechanics that are real, documented, and in the coach's own notes: five verdicts on the 840-line
 * corpus, including "Lillia has no ability called Prance" (Prance is the movement-speed stack on
 * her Q) and a refusal of the Swirlseed reveal (her E reveals the first champion it hits). It was
 * grading the coach's champion claims without the coach's champion knowledge, and every one of
 * those verdicts was scored as a fabrication by the coach.
 *
 * The same notes therefore go to the judge. They are fenced exactly the way the coach's own prompt
 * fences them: they license a CLAIM ABOUT THE KIT and nothing else. No number, no timer, no state
 * about this game is checkable against prose, and the paragraph below says so twice.
 *
 * ## It let the inverted clock through
 *
 * A death has two clocks — how long he has already been dead, and how long is left — and for most
 * of this app's life the payload stated only the second. The coach reached for the first and
 * converted, wrongly: 132 of 135 elapsed lines spoke the REMAINING figure as if it were elapsed.
 * The judge caught 17% [12-24] of them, because the ACTION survives the inversion: "dead for fifty
 * seconds, so start Baron" is the right call with the wrong number, and a judge reading for
 * usefulness agrees with the sentence and never looks at the digit.
 *
 * The fix is NOT "be stricter" — that inflates every other verdict too, and MEASURABLY did. The
 * first run of this rule over the 58 adjudicated socket lines caught four of the five inversions
 * the exact record convicts, and moved three POSITION lines from "unverifiable" to "false" that
 * the record does not convict: a rule about one figure generalising into a standard about every
 * figure. The rule now says outright that it is about death clocks and raises the bar nowhere
 * else. That scoping sentence was written AFTER seeing those three lines, so it is a repair
 * selected on this corpus and the run that measures it is not an independent test of it — which is
 * why both runs are on disk (`judge-fixed-socket-20260912.json`, `-scoped`).
 *
 * The fix is to make the figures legible: the two clocks are named in the prompt, and `deathClockBlock` prints the payload's own
 * death figures beside each sentence so the comparison is a subtraction rather than a hunt through
 * six thousand characters. `scripts/lib/payload-claims.ts` then does the same subtraction in code,
 * and the report prints both instruments rather than merging them.
 */
const KNOWLEDGE_RULE = `CHAMPION KNOWLEDGE. The coach was given written notes on the champions in this game, and they are
reproduced above. They are the reason it can talk about a kit at all, and they bound what counts as
an invention:

  - a mechanic, ability, item role or habit that appears in those notes is NOT fabricated, even
    though the payload says nothing about it. Do not mark such a sentence "false";
  - a mechanic that appears in NEITHER the notes NOR the payload is fabricated, and is "false";
  - the notes say nothing whatever about THIS GAME. Every number, timer, position, score and state
    claim is still checked against the payload alone. A sentence whose champion talk is right and
    whose figure is wrong is "false" on the figure.`

const CLOCK_RULE = `DEATH CLOCKS. A death carries TWO figures and they run in OPPOSITE directions:

  - how long the player has ALREADY been dead (elapsed), which the payload states as "down Ns" or
    "down at least Ns", and older payloads do not state at all;
  - how long is LEFT before he is back (remaining), which the payload states as "back in Ns" or
    "respawns in Ns".

NEITHER can be derived from the other: respawn length grows with game time and is nowhere in this
data. The figures for everybody who is down are listed beside each sentence below. So:

  - "he has been dead twenty seconds" is checked against the ELAPSED figure;
  - "he is back in twenty seconds" is checked against the REMAINING one;
  - a sentence that states an elapsed time when the payload gives only a remaining one is asserting
    a number the payload does not carry. That is "false", and it is "false" even when the advice
    attached to it is exactly right — the ADVICE surviving a wrong number is not the number being
    right.

This rule is about death clocks and nothing else. It does not raise the standard anywhere else and
it does not make you stricter in general: a claim the payload simply cannot settle — a position, a
cooldown, what his team is doing — stays "unverifiable", exactly as it always was.`

const JUDGE_HEAD = `You are grading single sentences a live League of Legends coach said out loud to a jungle
main, mid-game, while he was playing.

For each candidate you are given the game clock and the ground-truth payload the app computed from
the game client at that instant. You are NOT given a screenshot, so judge only against the payload:
if a sentence depends on something only a picture could settle, that is "unverifiable", not "false".

Return one verdict per candidate:

  "false"        it contradicts the payload, or it asserts something no channel here could know
                 (a champion not in the payload, a number not in it, an enemy's position, a
                 cooldown, a summoner spell timer). This is the only fatal verdict.
  "unverifiable" it may be true and nothing in the payload can check it.
  "generic"      true and checkable, but it would read identically in a different game or five
                 minutes earlier in this one.
  "useful"       true, specific to this instant, and it names something he can DO in the next
                 thirty seconds.`

const JUDGE_TAIL = `Reply with JSON only: {"grades":[{"id":"A","verdict":"...","why":"under 20 words"}]}`

/**
 * The judge as it stands, and — under `--plain` — the judge as it stood before either correction.
 *
 * Both are kept runnable on purpose. The owner's rule is that a stored measurement stays
 * re-derivable, and "the old judge" is one of those measurements: a before/after that needs a
 * checkout of an earlier commit to reproduce is a comparison nobody will run again.
 */
const judgeSystem = (plain: boolean): string =>
	plain ?
		`${JUDGE_HEAD}\n\n${JUDGE_TAIL}`
	:	`${JUDGE_HEAD}\n\n${KNOWLEDGE_RULE}\n\n${CLOCK_RULE}\n\n${JUDGE_TAIL}`

/*
 * `index` and `rep` ride along because `(windowId, clock)` is NOT a unique key for a line.
 * `bench-stream --repeats N` asks the same turn N times, so a downstream join keyed on the clock
 * silently keeps the last repetition and drops the rest — a Map with no collision check, which is
 * the quietest possible way to lose half a run. The turn index and the repetition number together
 * name exactly one answer.
 */
type Candidate = {
	id: string
	arm: string
	windowId: string
	index: number
	rep: number
	atSec: number
	clock: string
	text: string
	payload: string
	/** The payload's own death figures, surfaced from four scattered sites. Evidence, not a verdict. */
	clocks: string
	/** The same figures checked against the sentence in code. Never shown to the judge. */
	claims: ClockClaim[]
	mechanical: ReturnType<typeof mechanicalVerdict>
}

const judgeBatch = async (
	handle: Awaited<ReturnType<typeof modelHandleFor>>,
	lines: readonly Candidate[],
	knowledge: string
): Promise<Map<string, { verdict: Verdict; why: string }>> => {
	const { generateText } = await import("ai")
	const body = lines
		.map(
			l =>
				`### Candidate ${l.id}\nGame clock ${l.clock}.\n\nGround-truth payload:\n\n${l.payload}\n\n` +
				`${l.clocks === "" ? "" : `${l.clocks}\n\n`}Sentence: ${l.text}`
		)
		.join("\n\n---\n\n")
	/*
	 * The notes go FIRST and once. They are static for a whole game and every candidate in this
	 * batch is from that game, because the slicer below refuses to mix windows — so repeating them
	 * per candidate would multiply the batch's input by eight for no information.
	 */
	const prompt =
		knowledge === "" ? body : (
			`THE COACH'S CHAMPION NOTES FOR THIS GAME — the same text the coach was given. They describe kits,\n` +
			`not this game. Nothing here is evidence about what happened.\n\n${knowledge}\n\n` +
			`===================================================================\n\n${body}`
		)
	const res = await generateText({
		model: handle,
		system: judgeSystem(plain),
		prompt,
		// 8000 for the same reason frame-value.ts uses 8000: a tight cap truncates a reasoning model
		// mid-object and silently drops every line in the batch.
		maxOutputTokens: 8000
	})
	const raw = (res.text ?? "").trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim()
	const parsed = JSON.parse(raw) as { grades?: { id?: string; verdict?: string; why?: string }[] }
	const out = new Map<string, { verdict: Verdict; why: string }>()
	/*
	 * Only ids that were actually IN this slice. The judge has invented ids, and one stray id used
	 * to land in the verdict map, where it inflated the `judged n/N` progress line and then failed
	 * to match any candidate — a count that ran ahead of the work and a line still missing at the
	 * end. An id that was not asked about is discarded here and the line it was meant for falls
	 * into `missing` below, where the splitter asks again.
	 */
	const asked = new Set(lines.map(l => l.id))
	for (const g of parsed.grades ?? []) {
		if (!g.id || !asked.has(g.id)) continue
		/*
		 * An unrecognised verdict word is UNGRADED, not "unverifiable". Coercing it to a real
		 * verdict is the quietest way this instrument can flatter itself: the line stays in the
		 * denominator, leaves both `useful` and `false`, and lowers the false rate for a reason
		 * that is a parse failure rather than anything about the line.
		 */
		const known = GRADES.includes((g.verdict ?? "") as (typeof GRADES)[number])
		out.set(g.id, {
			verdict: known ? (g.verdict as Verdict) : "ungraded",
			why: known ? String(g.why ?? "").slice(0, 160) : `judge returned no known verdict (${String(g.verdict).slice(0, 40)})`
		})
	}
	return out
}

/**
 * One batch, then its HALVES, then its halves' halves — rather than one batch and a shrug.
 *
 * The first version of this tried a slice twice and dropped it on the second failure, and that
 * dropped 50 of 529 lines on the corpus run: a batch dies when ONE answer trips the parse, and it
 * takes seven innocent lines with it. On a single-arm report that reads as a smaller n. On an
 * ABLATION it is worse than that — the lost lines are not spread evenly over the arms, so a
 * difference between two arms can be a difference in which batches happened to parse.
 *
 * Halving costs at most 2n-1 calls in the pathological case and, measured against the alternative,
 * it recovers every line whose own answer was fine. A line that fails ALONE is genuinely
 * unjudgeable and is the only thing this can still lose; it is counted and printed rather than
 * quietly missing.
 */
const judgeSlice = async (
	handle: Awaited<ReturnType<typeof modelHandleFor>>,
	slice: readonly Candidate[],
	label: string,
	knowledge: string
): Promise<Map<string, { verdict: Verdict; why: string }>> => {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const got = await judgeBatch(handle, slice, knowledge)
			// A batch that parses but answers about only some of its lines is a partial failure and
			// is treated as one: the missing lines go back through the splitter rather than vanish.
			const missing = slice.filter(c => !got.has(c.id))
			if (missing.length === 0 || slice.length === 1) return got
			for (const [id, v] of await judgeSlice(handle, missing, `${label}/missing`, knowledge)) got.set(id, v)
			return got
		} catch (e) {
			if (attempt === 1) {
				if (slice.length === 1) {
					/*
					 * The end of the line, and it is RECORDED rather than dropped. A line whose own
					 * answer will not parse twice in a row is genuinely unjudgeable by this judge,
					 * and that is a fact about the run — it belongs in the output file and in every
					 * denominator, not in a log line nobody reads.
					 */
					const c = slice[0]!
					console.log(`\n  ${label}: line ${c.id} failed alone twice, recorded UNGRADED: ${e}`)
					return new Map([[c.id, { verdict: "ungraded" as Verdict, why: `judge failed twice on this line alone: ${String(e).slice(0, 100)}` }]])
				}
				const mid = Math.ceil(slice.length / 2)
				const out = await judgeSlice(handle, slice.slice(0, mid), `${label}a`, knowledge)
				for (const [id, v] of await judgeSlice(handle, slice.slice(mid), `${label}b`, knowledge)) out.set(id, v)
				return out
			}
		}
	}
	/*
	 * Unreachable — the loop either returns a map or recurses — but if it ever becomes reachable it
	 * must lose nothing, so it marks the whole slice ungraded rather than returning an empty map.
	 */
	return new Map(slice.map(c => [c.id, { verdict: "ungraded" as Verdict, why: "judgeSlice fell through" }]))
}

const pct = (k: number, n: number): string => (n === 0 ? "  —  " : `${Math.round((100 * k) / n)}%`)
const band = (i: Interval): string => `[${Math.round(i.lo * 100)}-${Math.round(i.hi * 100)}]`

const main = async (): Promise<void> => {
	const run = JSON.parse(readFileSync(runPath, "utf8")) as RunFile

	/*
	 * THE CENSUS, before anything is judged.
	 *
	 * Three things can keep a stored turn out of this judge's denominator, and only one of them is
	 * the coach declining to speak. A call that ERRORED never produced a line and cannot be graded;
	 * a call that returned nothing is a PASS. Both are excluded here — correctly, because the
	 * question this instrument answers is "of the lines he heard, how many were useful" — but a
	 * report that does not print them lets an arm that failed half its calls look identical to one
	 * that answered them all, and lets a coach that went quiet look like a coach that was right.
	 *
	 * So every exclusion is counted, attributed to an arm, and printed above the table.
	 */
	const mineAll = run.records.filter(r => armWanted.size === 0 || armWanted.has(r.arm))
	/*
	 * A PASS is not a line, and this judge used to think it was.
	 *
	 * The test was `text.trim() !== ""`, which is not the rule the rest of the harness uses. The
	 * coach declines by SAYING the word "pass" — `bench-stream` and `coach-score` both read that as
	 * silence — so on the 17-game corpus 11 declinations went to the judge as candidate sentences
	 * and sat in the denominator of the headline useful rate, where a judge with nothing to grade
	 * can only mark them down. One corpus, two instruments, two different ideas of what a line is.
	 * `isSilent` is now exported from `coach-score.ts` and all three read it from there.
	 */
	const spokeIt = (r: Record_): boolean => r.error === null && !isEmpty(r.text ?? "") && !isSilent(r.text ?? "")
	const census = [...new Set(mineAll.map(r => r.arm))].map(armId => {
		const mine = mineAll.filter(r => r.arm === armId)
		return {
			arm: armId,
			turns: mine.length,
			errored: mine.filter(r => r.error !== null).length,
			empty: mine.filter(r => r.error === null && isEmpty(r.text ?? "")).length,
			passed: mine.filter(r => r.error === null && !isEmpty(r.text ?? "") && isSilent(r.text ?? "")).length,
			spoken: mine.filter(spokeIt).length
		}
	})

	const spoken = mineAll.filter(spokeIt)
	if (spoken.length === 0)
		throw new Error(
			`no spoken lines${armWanted.size === 0 ? "" : ` for arm(s) ${[...armWanted].join(", ")}`} in ${runPath} — ` +
				`arms present: ${[...new Set(run.records.map(r => r.arm))].join(", ")}`
		)
	const candidates: Candidate[] = shuffled(spoken, seed).map((r, i) => {
		const facts = readPayload(r.payload)
		const claims = clockClaims(r.text!, facts)
		return {
			id: `L${i}`,
			arm: r.arm,
			windowId: r.windowId,
			index: r.index ?? i,
			rep: r.rep ?? 1,
			atSec: r.atSec,
			clock: r.clock,
			text: r.text!.trim(),
			payload: r.payload,
			clocks: plain ? "" : deathClockBlock(facts),
			claims,
			mechanical: mechanicalVerdict(claims)
		}
	})

	/*
	 * THE NOTES ARE PER GAME, SO THE BATCHES ARE PER GAME.
	 *
	 * `fullKnowledge` is the same loader the coach itself reads, keyed on the two champions the run
	 * file records for the window. Nothing else about the batching changes: the shuffle still runs
	 * over the whole corpus first, so the ORDER within a window is unattributable and every arm is
	 * still mixed inside every batch. The window was never blinded anyway — the payload names both
	 * junglers in its first line — so grouping by it costs no blinding at all, and the alternative
	 * (seven thousand characters of notes repeated per candidate) costs eight times the input for
	 * the same text.
	 */
	const windowById = new Map(run.windows.map(w => [w.id, w]))
	const knowledgeFor = new Map<string, string>()
	for (const c of candidates) {
		if (knowledgeFor.has(c.windowId)) continue
		const w = windowById.get(c.windowId)
		knowledgeFor.set(
			c.windowId,
			plain || !w ? "" : fullKnowledge({ champion: w.champion, counterpart: w.counterpart ?? null })
		)
	}

	const p = providerById(judgeProvider)
	if (!p) throw new Error(`no provider called ${judgeProvider}`)
	const key = providerKey(p)
	if (!key) throw new Error(`no key for ${judgeProvider} — put one in data/${p.keyFile}`)
	const handle = await modelHandleFor(p, key, judgeModelArg || p.defaultModel)

	console.log("\nWHAT IS IN THE DENOMINATOR, AND WHAT IS NOT\n")
	console.log(
		`  ${"arm".padEnd(20)} ${"turns".padStart(6)} ${"spoken".padStart(7)} ${"passed".padStart(7)} ` +
			`${"empty".padStart(6)} ${"errored".padStart(8)}`
	)
	for (const c of census)
		console.log(
			`  ${c.arm.padEnd(20)} ${String(c.turns).padStart(6)} ${String(c.spoken).padStart(7)} ` +
				`${String(c.passed).padStart(7)} ${String(c.empty).padStart(6)} ${String(c.errored).padStart(8)}`
		)
	console.log(
		`  Only SPOKEN lines are graded below. A "pass" is the coach saying so and declining; "empty" is\n` +
			`  nothing coming back at all, which is the model failing rather than choosing; "errored" is the call\n` +
			`  failing. None of the three is a sentence, so none can be useful or false — but all three change\n` +
			`  what a rate over spoken lines MEANS, which is why they are on the page and not in a comment.`
	)

	const batches = [...new Set(candidates.map(c => c.windowId))].reduce(
		(a, w) => a + Math.ceil(candidates.filter(c => c.windowId === w).length / batchSize),
		0
	)
	const withNotes = [...knowledgeFor.values()].filter(k => k !== "").length
	console.log(
		`\n${spoken.length} spoken line(s) across ${run.windows.length} game(s), ` +
			`shuffled with seed ${seed} and stripped of their arm label.\n` +
			`about to spend ${batches} judge call(s) on ${judgeProvider}/${judgeModelArg || p.defaultModel}\n` +
			(plain ?
				`--plain: the judge as it stood BEFORE the champion notes and the death-clock rule. The\n` +
				`mechanical clock check below still runs — it is code, not a prompt, and the point of this\n` +
				`flag is to vary the JUDGE while holding the check fixed.\n`
			:	`the judge holds the coach's own champion notes for ${withNotes} of ${knowledgeFor.size} game(s) and the\n` +
				`payload's two death clocks beside every sentence.\n`)
	)

	const verdicts = new Map<string, { verdict: Verdict; why: string }>()
	const slices: Candidate[][] = []
	for (const w of new Set(candidates.map(c => c.windowId))) {
		const mine = candidates.filter(c => c.windowId === w)
		for (let i = 0; i < mine.length; i += batchSize) slices.push(mine.slice(i, i + batchSize))
	}

	let next = 0
	const worker = async (): Promise<void> => {
		for (;;) {
			const n = next++
			const slice = slices[n]
			if (!slice) return
			/*
			 * A slice may not be able to take the run down with it. `Promise.all` rejects on the
			 * first rejection, which would abandon every other worker's verdicts and write no file
			 * at all — an hour of judging lost to one unexpected throw. The slice is marked
			 * ungraded and the run continues.
			 */
			let got: Map<string, { verdict: Verdict; why: string }>
			try {
				got = await judgeSlice(handle, slice, `batch ${n + 1}`, knowledgeFor.get(slice[0]!.windowId) ?? "")
			} catch (e) {
				console.log(`\n  batch ${n + 1} threw outside the splitter, whole slice UNGRADED: ${e}`)
				got = new Map(slice.map(c => [c.id, { verdict: "ungraded" as Verdict, why: `slice threw: ${String(e).slice(0, 100)}` }]))
			}
			for (const [id, v] of got) verdicts.set(id, v)
			process.stdout.write(`\r  judged ${verdicts.size}/${candidates.length}`)
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, slices.length) }, worker))
	console.log("")

	/*
	 * THE BACKFILL. Every candidate now has a verdict, by construction rather than by hope: if any
	 * path above still managed to lose one, it becomes `ungraded` here instead of disappearing from
	 * the denominator. `verdicts.size === candidates.length` after this line is an invariant the
	 * rest of the report is allowed to rely on.
	 */
	for (const c of candidates)
		if (!verdicts.has(c.id)) verdicts.set(c.id, { verdict: "ungraded", why: "no verdict returned for this line" })

	/* ------------------------------------------------------------ the report */
	/*
	 * PER ARM AND PER GAME. One row per (arm, game) even on a single-arm run, because a table whose
	 * rows pool two arms is the one shape this report must never print: on an ablation it averages
	 * the thing under test away and still looks like a result.
	 */
	const armIds = [...new Set(candidates.map(c => c.arm))]
	const rows: {
		arm: string
		gameId: string
		label: string
		n: number
		useful: number
		false_: number
		generic: number
		unverifiable: number
		ungraded: number
		/** Lines the code can prove wrong off the payload's own death figures. */
		mechFalse: number
		/** Elapsed claims that match the REMAINING figure on a payload that states no elapsed one. */
		inverted: number
		/** `false` OR mechanically contradicted — the two instruments together. */
		either: number
	}[] = []
	for (const armId of armIds)
		for (const w of run.windows) {
			/*
			 * NO `verdicts.has` FILTER. That filter is exactly the bug: it made the denominator the
			 * set of lines the judge happened to answer about, so a batch that failed to parse
			 * shrank `n` and left every rate computed over the survivors. Every candidate has a
			 * verdict after the backfill, `ungraded` included, and every candidate is counted.
			 */
			const mine = candidates.filter(c => c.arm === armId && c.windowId === w.id)
			if (mine.length === 0) continue
			const v = (k: Verdict) => mine.filter(c => verdicts.get(c.id)!.verdict === k).length
			rows.push({
				arm: armId,
				gameId: w.gameId,
				label: `${w.champion} vs ${w.counterpart ?? "?"}${w.kind === "paired" ? "" : " (text)"}`,
				n: mine.length,
				useful: v("useful"),
				false_: v("false"),
				generic: v("generic"),
				unverifiable: v("unverifiable"),
				ungraded: v("ungraded"),
				mechFalse: mine.filter(c => c.mechanical === "contradicted").length,
				inverted: mine.filter(c => c.mechanical === "inversion-shaped").length,
				either: mine.filter(c => verdicts.get(c.id)!.verdict === "false" || c.mechanical === "contradicted").length
			})
		}

	console.log("\nPER GAME — no interval on purpose; these rows are a SPREAD, the interval is pooled below")
	console.log("`lines` is every line the coach spoke in that game; `ungraded` is the subset this judge could")
	console.log("not answer about, and it is inside `lines`, never subtracted from it.\n")
	console.log(
		"  arm                  gameId       matchup                          lines  useful   false  generic  ungraded"
	)
	for (const r of rows)
		console.log(
			`  ${r.arm.padEnd(20)} ${r.gameId}  ${r.label.padEnd(32)} ${String(r.n).padStart(5)}  ` +
				`${pct(r.useful, r.n).padStart(5)}  ${pct(r.false_, r.n).padStart(6)}  ${pct(r.generic, r.n).padStart(6)}  ` +
				`${(r.ungraded === 0 ? "0" : `${r.ungraded} (${pct(r.ungraded, r.n).trim()})`).padStart(8)}`
		)

	const pooled = armIds.map(armId => {
		const mine = rows.filter(r => r.arm === armId)
		const sum = (f: (r: (typeof mine)[number]) => number) => mine.reduce((a, r) => a + f(r), 0)
		return {
			arm: armId,
			n: sum(r => r.n),
			useful: sum(r => r.useful),
			false_: sum(r => r.false_),
			generic: sum(r => r.generic),
			unverifiable: sum(r => r.unverifiable),
			ungraded: sum(r => r.ungraded),
			mechFalse: sum(r => r.mechFalse),
			inverted: sum(r => r.inverted),
			either: sum(r => r.either)
		}
	})
	console.log("")
	for (const pl of pooled) {
		console.log(
			`POOLED  ${pl.arm.padEnd(20)} ${String(pl.n).padStart(4)} lines   ` +
				`useful ${String(pl.useful).padStart(3)}/${pl.n} ${pct(pl.useful, pl.n)} ${band(wilson(pl.useful, pl.n))}   ` +
				`false ${String(pl.false_).padStart(3)}/${pl.n} ${pct(pl.false_, pl.n)} ${band(wilson(pl.false_, pl.n))}   ` +
				`generic ${String(pl.generic).padStart(3)}/${pl.n} ${pct(pl.generic, pl.n)} ${band(wilson(pl.generic, pl.n))}`
		)
		/*
		 * THE BOUNDS, whenever anything is ungraded. An ungraded line could have been anything, so
		 * every rate above is a floor and `(k + ungraded) / n` is its ceiling. Printing the width
		 * is what stops a reader treating a 9%-ungraded run as if it were a clean one — the Wilson
		 * interval says nothing about this, because it is sampling error and this is missing data.
		 */
		if (pl.ungraded > 0)
			console.log(
				`        ${" ".repeat(20)} ${String(pl.ungraded).padStart(4)} of those were UNGRADED ` +
					`${pct(pl.ungraded, pl.n)} — so useful is ${pct(pl.useful, pl.n)}–${pct(pl.useful + pl.ungraded, pl.n)} ` +
					`and false is ${pct(pl.false_, pl.n)}–${pct(pl.false_ + pl.ungraded, pl.n)} depending on what they were`
			)
		else console.log(`        ${" ".repeat(20)} 0 ungraded — every line the coach spoke got a verdict`)
	}
	/*
	 * THE SECOND INSTRUMENT, PRINTED BESIDE THE FIRST AND NEVER FOLDED INTO IT.
	 *
	 * `payload-claims.ts` subtracts the payload's own death figures from the sentence's, in code.
	 * It and the judge fail in different ways — the judge grades whether the advice was any good
	 * and lets a wrong digit through; the check grades one digit and has no opinion about anything
	 * else — so the union is a better false rate than either, and each half is printed so a reader
	 * can see which one is carrying the number.
	 *
	 * `inversion-shaped` is deliberately NOT counted as false. It is an elapsed claim on a payload
	 * that states no elapsed figure, whose number matches the REMAINING one: the signature of the
	 * conversion the coach was doing, but not a contradiction, because a payload with only one
	 * clock cannot prove the other wrong. It is the size of the hole, not the size of the error.
	 */
	console.log("\nTHE MECHANICAL CHECK — the same payloads, checked by subtraction rather than by judgement")
	for (const pl of pooled) {
		console.log(
			`  ${pl.arm.padEnd(20)} ${String(pl.n).padStart(4)} lines   ` +
				`judge false ${String(pl.false_).padStart(3)} ${pct(pl.false_, pl.n)}   ` +
				`clock-contradicted ${String(pl.mechFalse).padStart(3)} ${pct(pl.mechFalse, pl.n)}   ` +
				`EITHER ${String(pl.either).padStart(3)}/${pl.n} ${pct(pl.either, pl.n)} ${band(wilson(pl.either, pl.n))}`
		)
		console.log(
			`  ${" ".repeat(20)} ${String(pl.inverted).padStart(4)} more are INVERSION-SHAPED ${pct(pl.inverted, pl.n)} — an elapsed ` +
				`death time on a payload\n  ${" ".repeat(20)}      that states only the remaining one, matching that remaining figure. ` +
				`Not counted false:\n  ${" ".repeat(20)}      one clock cannot contradict the other. It is the size of the hole.`
		)
	}
	console.log(
		`\nThe judge saw NO screenshot, so "contradicted-by-picture" is not a verdict it could reach.\n` +
			`Read this false rate as a FLOOR.`
	)

	writeFileSync(
		outPath,
		JSON.stringify(
			{
				of: runPath,
				ranAt: new Date().toISOString(),
				judge: `${judgeProvider}/${judgeModelArg || p.defaultModel}`,
				judgePrompt: plain ? "plain (pre-2026-09-12: no champion notes, no death-clock rule)" : "notes + death clocks",
				seed,
				note:
					"Graded against the stored payload only — no screenshot. The false rate is a floor. " +
					"`lines` holds EVERY spoken line including `verdict: \"ungraded\"`; `n` in `pooled` and `perGame` " +
					"counts those, so a rate over a run with ungraded lines is a floor in both directions.",
				census,
				perGame: rows,
				pooled: pooled.map(pl => ({
					arm: pl.arm,
					n: pl.n,
					useful: pl.useful,
					false: pl.false_,
					generic: pl.generic,
					unverifiable: pl.unverifiable,
					ungraded: pl.ungraded,
					clockContradicted: pl.mechFalse,
					inversionShaped: pl.inverted,
					falseByEither: pl.either
				})),
				// EVERY candidate, ungraded included. A reader who wants the old survivors-only
				// number can filter this list; a reader handed a pre-filtered list cannot get back
				// the number of lines that went missing.
				lines: candidates
					.map(c => ({
						id: c.id,
						arm: c.arm,
						windowId: c.windowId,
						index: c.index,
						rep: c.rep,
						atSec: c.atSec,
						clock: c.clock,
						text: c.text,
						...verdicts.get(c.id)!,
						// The code's reading of the same line, kept beside the judge's rather than merged
						// into it: two instruments, both re-derivable, neither hidden behind the other.
						mechanical: c.mechanical,
						claims: c.claims
					}))
			},
			null,
			2
		)
	)
	console.log(`\nwrote ${outPath}  (${runPath} is unchanged)`)
}

await main()
