/**
 * Replay one real game through the REAL live-coach pipeline, one checkpoint at a time, and write
 * down what actually came back.
 *
 * ## Why this exists
 *
 * The owner has tried the live coach about ten times and it is still bad, and every line of the
 * transcript he quit on was derivable from the ground-truth block alone. Nothing he was told
 * needed a picture. That is either because the model ignores the frame, or because the frame it
 * gets is useless — and nothing on disk could tell those apart.
 *
 * `scripts/bench-providers.ts` cannot answer it, by construction. It reads ONE JPEG and pairs it
 * with every state it replays (it prints "THE SAME FRAME FOR EVERY STATE"), so the picture and the
 * block describe different moments. Under that instrument a model that ignores the frame scores
 * the same as one that reads it perfectly, and a model that actually *uses* the frame scores
 * WORSE, because the frame contradicts the block it arrived with. It also scores with a fault
 * detector that asks "did you break a rule", never "was this right".
 *
 * This runs the other experiment. `scripts/build-fixture.ts` froze the only window in the whole
 * database where a REAL FRAME and REAL RAW CLIENT DATA exist for the same instant — 42 of them,
 * 0:02 to 6:43 of game 5635467422 — plus 98 more instants across the rest of the game that have
 * raw data and no pixels. This replays those instants through the shipped path and records the
 * answers.
 *
 * ## The ablation is the point
 *
 * Every frame-bearing checkpoint runs TWICE, back to back, with everything else byte-identical:
 * once with the picture, once without. Same block, same prompt, same model, same options. The only
 * difference is the image content part.
 *
 * That pair is the measurement. If the two answers are indistinguishable, the frame is costing
 * bandwidth and buying nothing, and the whole "the screenshot is for where things are" half of the
 * design is not happening. If they differ, the difference is the frame's entire contribution and
 * can be read line by line. Ten games of "it is still bad" could not separate those; 42 paired
 * turns can.
 *
 * ## What is SHIPPED code here, and what is not
 *
 * Shipped, imported, not reimplemented:
 *
 *   - `buildLiveStateForBench`  `src/server/routes/live.ts` — the daemon's own state builder,
 *                               including `buildFacts`, so `state.unseen` is the ranked,
 *                               rate-limited list the coach was actually handed.
 *   - `renderState`             `src/shared/live-state.ts` — the block, byte for byte.
 *   - `coachTurn`               `src/review/live-providers.ts` — one AI SDK call with
 *                               `LIVE_COACH_SYSTEM_PROMPT` as the system prompt and the frame as an
 *                               image content part. The prompt is NOT a parameter there, so this
 *                               harness cannot accidentally have varied it.
 *   - `scoreLine`               `src/analysis/coach-score.ts` — the mechanical fault detector,
 *                               recorded beside each line. It answers "did you break a rule"; the
 *                               judge below answers "was this right". Both, never one.
 *
 * Duplicated, and named so nobody has to guess:
 *
 *   - the ndjson reader. `readSamples` in `src/daemon/live-sampler.ts` drops blank and torn lines
 *     silently and returns no line numbers, and the fixture's `sampleLine` is a 1-based line
 *     number into the file, so the join needs them. Fifteen lines, identical to the one in
 *     `scripts/build-fixture.ts`.
 *   - the baseline selection (corpus games created strictly before this one). Also from
 *     build-fixture, for the same reason: the block's `Farm baseline:` line has to be the number
 *     that existed at the time.
 *
 * Both duplications are CHECKED rather than trusted: every block this produces is compared against
 * the frozen `block` in the fixture, and a mismatch aborts the run. If the reader or the baseline
 * drifts, the assertion fires instead of the run quietly measuring something else.
 *
 * ## Two things this is not 1:1 with, stated rather than buried
 *
 * 1. **The shipped provider is `gemini-live`, a WebSocket.** Everything reachable through
 *    `live-providers.ts` is TURN-BASED HTTPS. `gemini-http` is the closest twin — same model
 *    family, same key, no socket — and it is the default here for that reason. A socket difference
 *    found later belongs to the socket, not to the model.
 * 2. **No conversation memory.** The shipped `POST /api/live/coach/turn` sends only provider,
 *    model, frame and block — no history — so a stateless turn IS the turn-based path exactly. It
 *    is NOT the socket, which keeps a thread and can see what it already said. A line here that
 *    repeats an earlier one would have been suppressed on the socket.
 *
 * Rate limiting is not lost, though: `buildFacts` carries its own memory across the replay (a
 * death announced once, gold once per 800g, farm once per three minutes), and the whole 363-sample
 * stream is replayed in order so the fact list at each checkpoint is the one a real game would
 * have produced.
 *
 * ## Errors are data
 *
 * A checkpoint that fails appears in the output file as a failure with its reason, and it appears
 * in the printed summary. It is never dropped. A harness that quietly discards failures is how ten
 * bad games looked fine.
 *
 * ## Usage
 *
 *     node --env-file-if-exists=.env --experimental-strip-types scripts/e2e-real-game.ts
 *     node --env-file-if-exists=.env --experimental-strip-types scripts/e2e-real-game.ts \
 *       --checkpoints frames --repeats 2 --verbose
 *     node --env-file-if-exists=.env --experimental-strip-types scripts/e2e-real-game.ts \
 *       --judge latest
 *
 *     --fixture <path>       default data/eval/fixture-5635467422.json
 *     --provider <id>        gemini-http | anthropic | openai | kimi | glm | mock  (default gemini-http)
 *     --model <id>           free text, as everywhere in this app; empty means the provider default
 *     --checkpoints <spec>   `all` (default), `frames` (only the frame-bearing ones), `noframes`,
 *                            or a comma list of ids: `cp-0367,cp-0378`
 *     --repeats N            run the whole selection N times (default 1). Multiplies n, not states.
 *     --no-frame             never send a picture — collapses the ablation to the text-only arm
 *     --concurrency N        turns in flight (default 3). 1 when a provider rate-limits.
 *     --out <path>           default data/eval/run-<stamp>.json
 *     --verbose              print every line as it lands, not only at the end
 *     --allow-block-drift    run even though a block no longer re-renders to what the fixture
 *                            froze. Default is to REFUSE: a drifted block means the app changed
 *                            under the fixture, and a run that quietly used the new one would be
 *                            incomparable with every earlier run. Rebuild the fixture instead
 *                            whenever the change was intentional.
 *
 *     --summarize <path>     re-print the summary of a run already on disk, calling nothing
 *     --judge <path|latest>  score an existing run file against the labels and stop
 *     --labels <path>        default data/eval/labels-<gameId>.json
 *     --judge-provider <id>  default anthropic, falling back to the run's own provider
 *     --judge-model <id>     free text
 *
 * Touches no League API and no LCU endpoint. Reads the database read-only. Safe while a game is in
 * progress — unlike `bench-providers`, it never opens a Gemini Live socket, which the live coach
 * wants for itself.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { type } from "arktype"
import { DATA_DIR, DB_PATH } from "../src/shared/constants.ts"
import { renderState } from "../src/shared/live-state.ts"
import type { VisionState } from "../src/shared/live-state.ts"
import { LIVE_COACH_SYSTEM_PROMPT } from "../src/shared/live-prompt.ts"
import { buildLiveStateForBench } from "../src/server/routes/live.ts"
import { baselineFromRows, perGameMetrics } from "../src/analysis/index.ts"
import { loadCorpus } from "../src/daemon/corpus.ts"
import { isEmpty, MIN_SIGNIFICANT, numbersIn, scoreLine } from "../src/analysis/coach-score.ts"
import type { LineScore } from "../src/analysis/coach-score.ts"
import {
	coachTurn,
	modelHandleFor,
	providerById,
	providerKey
} from "../src/review/live-providers.ts"
import type { ProviderId } from "../src/review/live-providers.ts"

/* ================================================================== arguments */

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

/**
 * How often the browser actually prompts the coach, from `DEFAULT_TURN_MS` in
 * `src/web/lib/geminiLive.ts`.
 *
 * Copied rather than imported because that module is a React hook and pulls the DOM in. It exists
 * here for ONE reason: a rate of "spoke on 40% of turns" is meaningless until it is turned into
 * lines per minute, which is the unit he experiences. Keep it in step by hand if the default moves.
 */
export const SHIPPED_TURN_MS = 20_000

/* ==================================================================== fixture */

export interface FixtureCheckpoint {
	id: string
	tSec: number
	clock: string
	sampleLine: number
	framePath: string | null
	frameSkewSec: number | null
	/** Null when there is no frame; false when the frame was inspected and does not show the game. */
	frameShowsGame?: boolean | null
	block: string
	storedBlock: string | null
}

export interface Fixture {
	gameId: string
	source: { samples: string; frameJoin: string }
	checkpoints: FixtureCheckpoint[]
}

/**
 * Read the fixture and refuse anything that is not shaped like the contract.
 *
 * `data/eval/` already holds a second file called `fixture-expanded.json` with a completely
 * different shape (frames joined to stored `truthJson`, no raw samples at all). Pointing this at
 * it would produce a run that looked fine and replayed nothing, so the fields this depends on are
 * checked by name and the error says which one was missing.
 */
export const readFixture = (path: string): Fixture => {
	const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Fixture>
	const miss = (what: string): never => {
		throw new Error(
			`${path} is not a raw-sample fixture: ${what}. ` +
				`Its builder, scripts/build-fixture.ts, was deleted on 2026-09-11 as superseded by ` +
				`scripts/bench-stream.ts, which replays the raw samples directly and needs no frozen ` +
				`fixture. The stored fixtures still work; there is no longer a way to make a new one.`
		)
	}
	if (typeof raw.gameId !== "string" || raw.gameId === "") miss("no gameId")
	if (typeof raw.source?.samples !== "string") miss("no source.samples pointing at the ndjson")
	if (!Array.isArray(raw.checkpoints) || raw.checkpoints.length === 0) miss("no checkpoints")
	for (const c of raw.checkpoints!)
		if (typeof c.sampleLine !== "number" || typeof c.block !== "string")
			miss(`checkpoint ${String(c.id)} has no sampleLine/block`)
	return raw as Fixture
}

/* ===================================================================== replay */

/**
 * The ndjson reader and the historical farm baseline now live in `scripts/lib/stream.ts`.
 *
 * They were defined here and imported UPWARD by the library, by `game-pack.ts` and by
 * `minimap-track.ts` — a driver that four other files depended on. Same functions, moved down
 * one level; re-exported here so `src/review/e2e-real-game.test.ts` keeps pinning them from the
 * file that owns the fixture format they serve.
 */
import { baselineDuring, championVocabulary, readVerbatim } from "./lib/stream.ts"
import type { RawSample } from "./lib/stream.ts"
export { baselineDuring, readVerbatim }
export type { RawSample }

export interface ReplayedState {
	block: string
	/** `state.unseen` — the ranked, rate-limited fact list. THE output surface of the ranker. */
	facts: string[]
	roster: string[]
}

/**
 * Every sample, in order, through the shipped builder.
 *
 * The WHOLE stream, not only the checkpoints. `buildFacts` carries memory — each death announced
 * once, gold once per 800g and only after it has been held, farm once per three minutes — so a
 * block built out of sequence is a block nobody would ever have been shown.
 */
export const replayStream = (
	samples: readonly RawSample[],
	baseline: ReturnType<typeof baselineFromRows> | null
): Map<number, ReplayedState> => {
	const out = new Map<number, ReplayedState>()
	for (const s of samples) {
		const state: VisionState | null = buildLiveStateForBench(s.data, s.gameTime, baseline)
		if (!state) continue
		out.set(s.line, {
			block: renderState(state),
			facts: state.unseen,
			roster: [
				state.me.champion,
				...state.allies.map(p => p.champion),
				...state.enemies.map(p => p.champion)
			].filter(n => n !== "")
		})
	}
	return out
}

/* ================================================================== selection */

/**
 * Which checkpoints to run. `all`, `frames`, `noframes`, or an explicit comma list of ids.
 *
 * An id that is not in the fixture is an ERROR rather than a silent skip: a typo in a checkpoint
 * id would otherwise produce a run of zero turns that exits 0 and looks like a clean result.
 */
export const selectCheckpoints = (
	all: readonly FixtureCheckpoint[],
	spec: string
): FixtureCheckpoint[] => {
	const s = spec.trim().toLowerCase()
	if (s === "" || s === "all") return [...all]
	if (s === "frames") return all.filter(c => c.framePath !== null)
	if (s === "noframes") return all.filter(c => c.framePath === null)
	const want = spec
		.split(",")
		.map(x => x.trim())
		.filter(x => x !== "")
	const byId = new Map(all.map(c => [c.id, c]))
	const missing = want.filter(w => !byId.has(w))
	if (missing.length > 0)
		throw new Error(
			`no such checkpoint: ${missing.join(", ")} — ids look like ${all[0]!.id}, ${all[1]?.id ?? ""}`
		)
	return want.map(w => byId.get(w)!)
}

/**
 * Whether this checkpoint can carry a picture at all.
 *
 * `frameShowsGame === false` means the frame was opened and it is his desktop, a browser, or the
 * post-game screen. Such a frame is WORSE than no frame — it asks a coach to react to a picture of
 * nothing — so it is treated as no frame here, and the reason is recorded.
 */
export const frameUsable = (c: FixtureCheckpoint): boolean =>
	c.framePath !== null && c.frameShowsGame !== false && existsSync(c.framePath)

/* ===================================================================== topics */

/**
 * What the line was ABOUT, as a coarse subject label.
 *
 * A heuristic over the spoken sentence, not a measurement of the ranker — the facts in
 * `state.unseen` carry no kind tag, and inventing one here would mean reimplementing
 * `buildFacts`. It exists because "spoke on 38% of turns" hid the actual defect for weeks: the
 * defect was never the RATE, it was that every line was about the same two things. A mix that is
 * 80% `gold` is a finding a rate cannot show.
 *
 * Ordered most specific first, because a sentence about the enemy jungler's CS mentions CS.
 */
export const subjectOf = (line: string): string => {
	const t = line.toLowerCase()
	if (t.replace(/[^a-z]/g, "") === "pass") return "silence"
	if (t.trim() === "") return "empty"
	if (/\b(drake|dragon|baron|herald|grub|rift|void)\b/.test(t)) return "objective"
	if (/\b(respawn|is down|seconds?|dead|died|death|killed)\b/.test(t)) return "death"
	if (/\b(counterpart|enemy jungler|jungler|briar|is up on you|out.?farm)\b/.test(t)) return "counterpart"
	if (/\b(cs|farm|camps?|clear)\b/.test(t)) return "farm"
	if (/\b(gold|back|recall|shop|buy|bought|item)\b/.test(t)) return "gold"
	if (/\b(level|xp|experience)\b/.test(t)) return "level"
	if (/\b(fight|trade|skirmish|teamfight|kill participation)\b/.test(t)) return "fight"
	return "other"
}

/* ================================================================= comparison */

export interface PairComparison {
	pairs: number
	/** Neither said anything — PASS, or nothing at all. */
	bothQuiet: number
	oneSpoke: number
	/** Of those, how many were the FIRST-listed arm speaking alone. */
	onlyFirstSpoke: number
	bothSpoke: number
	identical: number
	sameSubject: number
	/** The same set of significant figures, so a paraphrase does not read as a new claim. */
	sameNumbers: number
	contentDiffered: number
}

/**
 * How two arms differ, over the checkpoints they share.
 *
 * Word-for-word equality is the wrong measure on its own and the first real run of this harness
 * showed why: 2 of 3 frame/no-frame pairs differed, and both differences were pure paraphrase off
 * the SAME single ranked fact — "be where they are before the next one starts" against "group up
 * before the next one starts". A model at its default temperature does that to itself.
 *
 * So content is compared as well: the coarse subject, and the set of significant figures cited
 * (`numbersIn` normalises "two for zero" to `2 0`, which matters here because the frame arm
 * happened to spell its numbers out). Two lines that cite the same figures about the same subject
 * are the same coaching, however differently worded.
 *
 * A pair where either turn FAILED is dropped from the comparison entirely and does not reach
 * `pairs` — a provider error is not a difference between the arms. The failures are still in the
 * file and still in the summary above.
 */
export const comparePairs = (pairs: readonly (readonly [TurnResult, TurnResult])[]): PairComparison => {
	const out: PairComparison = {
		pairs: 0,
		bothQuiet: 0,
		oneSpoke: 0,
		onlyFirstSpoke: 0,
		bothSpoke: 0,
		identical: 0,
		sameSubject: 0,
		sameNumbers: 0,
		contentDiffered: 0
	}
	const sig = (t: string): string =>
		[...new Set(numbersIn(t).filter(n => n >= MIN_SIGNIFICANT))].sort((a, b) => a - b).join(",")
	for (const [a, b] of pairs) {
		if (!a.ok || !b.ok) continue
		out.pairs++
		const aq = a.silent || a.empty
		const bq = b.silent || b.empty
		if (aq && bq) {
			out.bothQuiet++
			continue
		}
		if (aq !== bq) {
			out.oneSpoke++
			if (bq) out.onlyFirstSpoke++
			continue
		}
		out.bothSpoke++
		const same = a.text.trim() === b.text.trim()
		if (same) out.identical++
		if (a.subject === b.subject) out.sameSubject++
		if (sig(a.text) === sig(b.text)) out.sameNumbers++
		if (!same && (a.subject !== b.subject || sig(a.text) !== sig(b.text))) out.contentDiffered++
	}
	return out
}

/* ====================================================================== turns */

export interface TurnResult {
	id: string
	tSec: number
	clock: string
	sampleLine: number
	/** `frame` or `no-frame`. The two arms of the ablation. */
	arm: "frame" | "no-frame"
	/** 1-based, so repeats of the same arm at the same checkpoint stay distinguishable. */
	attempt: number
	frameSent: boolean
	framePath: string | null
	frameSkewSec: number | null
	frameBytes: number | null
	/** The block that went to the model, re-rendered by the shipped path this run. */
	block: string
	/** False when the re-render differs from the frozen fixture — see `--allow-block-drift`. */
	blockMatchesFixture: boolean
	facts: string[]
	roster: string[]
	provider: string
	model: string
	ok: boolean
	text: string
	latencyMs: number
	reason: string | null
	/** PASS. Not the same as empty — see `coach-score.ts`. */
	silent: boolean
	empty: boolean
	subject: string
	score: LineScore | null
}

const clockText = (sec: number): string =>
	`${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`


/* ====================================================================== judge */

/**
 * One graded turn.
 *
 * `verdict` is the headline and the three components under it are what it is made of, so a
 * disagreement can be located rather than argued about.
 */
const JudgeVerdict = type({
	/**
	 * Did the coach's CHOICE between speaking and passing match the label's `shouldSpeak`?
	 *
	 * Named `decisionCorrect` after a measured misread: as `silenceCorrect` the judge answered
	 * "was silence correct here", so a line that correctly SPOKE at a labelled shouldSpeak:true
	 * instant came back `false`, and the summary reported the right call as wrong half the time.
	 * The prompt now spells the rule out as well — a field name is not a specification.
	 */
	decisionCorrect: "boolean",
	/** Which labelled expectations the line actually met, by topic. */
	met: type({ topic: "string", met: "boolean", why: "string" }).array(),
	/** Forbidden things the line did, copied from the label's `forbid` list. */
	broke: "string[]",
	/**
	 * Whether the line used something only the PICTURE could supply. This is the ablation's
	 * verdict, one turn at a time.
	 */
	usedFrame: "'yes' | 'no' | 'unclear'",
	verdict: "'good' | 'weak' | 'wrong'",
	why: "string"
})

export interface JudgeRow {
	id: string
	arm: string
	attempt: number
	text: string
	label: { shouldSpeak: boolean; why: string } | null
	verdict: typeof JudgeVerdict.infer | null
	/** Recorded whenever the model's JSON did not parse — a judge failure is data too. */
	rawOnFailure: string | null
	error: string | null
}

/**
 * The judge's own system prompt.
 *
 * Deliberately NOT `LIVE_COACH_SYSTEM_PROMPT` and deliberately not routed through `coachTurn`,
 * whose whole invariant is that the system prompt is not a parameter. A judge that shared the
 * coach's prompt would be grading against the coach's own opinion of itself.
 */
const JUDGE_SYSTEM = `You grade one sentence a live League of Legends coach said out loud, mid-game.

You are given: the ground-truth block the coach held, the ranked facts it was allowed to speak
from, a human label saying what a good answer looks like at this instant, and the sentence.
Sometimes you are also given the screenshot the coach was looking at.

The coach's rules, which you grade against:
- It may only speak facts from the ranked list. An empty list means the correct answer is PASS.
- A line must be worth saying: NOT VISIBLE (he could not get it by looking at his own screen) and
  NOT GENERIC (it could not have been said in a different game, or five minutes ago in this one).
- PASS is a correct, complete answer whenever nothing passes both tests. Silence is never a
  failure by itself.
- It may never name a champion outside the roster, never state a number that is not in the block,
  and never assert where anyone is or where anyone is going.

Grade honestly and cheaply. "weak" is for a true but useless line — the failure this coach
actually has. "wrong" is for a false one or a badly missed call. "good" means it did the thing the
label asked for.

For usedFrame, answer "yes" ONLY if the sentence contains something that could not have come from
the block — a position, what is on screen, what he is doing right now. A line built entirely from
the block is "no", even when a screenshot was sent.

decisionCorrect is about the CHOICE, not about silence: it is true when the coach SPOKE and the
label says shouldSpeak, and true when the coach said PASS and the label says shouldSpeak is false.
It is false whenever the coach spoke at an instant the label wanted silence, or stayed silent at
an instant the label wanted a line. Do not answer "was silence correct here" — answer "was the
coach's choice correct here".

Reply with JSON only. No prose, no markdown fences.`

const judgePrompt = (row: {
	block: string
	facts: string[]
	label: Record<string, unknown>
	text: string
	frameSent: boolean
}): string =>
	[
		"## The ground-truth block the coach held",
		row.block,
		"",
		"## The ranked facts it was allowed to speak from",
		row.facts.length === 0 ?
			"(empty — the correct answer here is PASS unless the player asked something)"
		:	row.facts.map(f => `- ${f}`).join("\n"),
		"",
		"## The human label for this instant",
		JSON.stringify(row.label, null, 1),
		"",
		`## What the coach said${row.frameSent ? " (a screenshot WAS sent with this turn)" : " (NO screenshot was sent with this turn)"}`,
		row.text === "" ? "(nothing at all came back)" : row.text,
		"",
		"## Reply with this JSON",
		'{"decisionCorrect":bool,"met":[{"topic":str,"met":bool,"why":str}],"broke":[str],"usedFrame":"yes|no|unclear","verdict":"good|weak|wrong","why":str}'
	].join("\n")

/** Strip a ```json fence, which several models add however firmly the prompt says not to. */
export const stripFence = (raw: string): string => {
	const t = raw.trim()
	if (!t.startsWith("```")) return t
	return t
		.replace(/^```[a-zA-Z]*\n?/, "")
		.replace(/```\s*$/, "")
		.trim()
}

/* ======================================================================= main */

interface RunFile {
	kind: "e2e-real-game-run"
	stamp: string
	fixture: string
	gameId: string
	provider: string
	model: string
	/** So a later run can prove whether the prompt moved between them. */
	promptSha256: string
	shippedProvider: string
	turnCadenceMs: number
	baselineGames: number
	repeats: number
	notes: string[]
	results: TurnResult[]
	judge?: { provider: string; model: string; labels: string; rows: JudgeRow[] }
}

const stampNow = (): string => {
	const d = new Date()
	const p = (n: number): string => String(n).padStart(2, "0")
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const pct = (k: number, n: number): string => (n === 0 ? "  -  " : `${((100 * k) / n).toFixed(0).padStart(3)}%`)

const newestRun = (): string => {
	const dir = `${DATA_DIR}/eval`
	const files = readdirSync(dir)
		.filter(f => f.startsWith("run-") && f.endsWith(".json"))
		.sort()
	if (files.length === 0) throw new Error(`no run-*.json in ${dir} — run without --judge first`)
	return `${dir}/${files[files.length - 1]!}`
}

/* ------------------------------------------------------------------ the judge */

const runJudge = async (): Promise<void> => {
	const spec = arg("judge", "latest")
	const runPath = spec === "latest" ? newestRun() : spec
	const run = JSON.parse(readFileSync(runPath, "utf8")) as RunFile
	const labelsPath = arg("labels", `${DATA_DIR}/eval/labels-${run.gameId}.json`)
	if (!existsSync(labelsPath))
		throw new Error(
			`no labels at ${labelsPath}. The judge scores against a human label file; without one ` +
				`it would only be a second model's opinion of a first model, which is what this ` +
				`whole harness exists to replace.`
		)
	const labels = (
		JSON.parse(readFileSync(labelsPath, "utf8")) as { labels: Record<string, unknown>[] }
	).labels
	const byId = new Map(labels.map(l => [String(l.id), l]))

	/*
	 * A DIFFERENT vendor from the one under test by default, because a judge that is the same model
	 * as the coach is grading its own homework. Anthropic is the default; if there is no key for it
	 * the run's own provider is used and the summary says so loudly rather than pretending the
	 * grade is independent.
	 */
	const asked = arg("judge-provider", "")
	const fellBack = asked === "" && providerKey(providerById("anthropic")!) === null
	const provId = (asked !== "" ? asked : fellBack ? run.provider : "anthropic") as ProviderId
	const p = providerById(provId)
	if (!p) throw new Error(`no provider called ${provId}`)
	const key = providerKey(p)
	if (!key) throw new Error(`no key for ${provId} — put one in data/${p.keyFile}`)
	const model = arg("judge-model", "") || p.defaultModel
	const handle = await modelHandleFor(p, key, model)
	const { generateText } = await import("ai")

	console.log(`judging ${runPath}`)
	console.log(`  labels   ${labelsPath}  (${labels.length} labelled instants)`)
	console.log(`  judge    ${provId} ${model}`)
	if (provId === run.provider)
		console.log(
			`  WARNING  the judge is the same provider as the coach under test (${run.provider}).\n` +
				`           It is grading its own homework. Put a key in data/anthropic.key, or pass\n` +
				`           --judge-provider, before quoting any of these numbers.`
		)

	const rows: JudgeRow[] = []
	for (const r of run.results) {
		const label = byId.get(r.id)
		if (!label) continue
		const base: JudgeRow = {
			id: r.id,
			arm: r.arm,
			attempt: r.attempt,
			text: r.text,
			label: { shouldSpeak: label.shouldSpeak === true, why: String(label.why ?? "") },
			verdict: null,
			rawOnFailure: null,
			error: null
		}
		if (!r.ok) {
			// A turn that never produced a line is not a coaching failure and must not be graded as
			// one. It is carried through so the judge's own denominator is honest.
			rows.push({ ...base, error: `turn failed: ${r.reason ?? "unknown"}` })
			continue
		}
		try {
			const out = await generateText({
				model: handle,
				system: JUDGE_SYSTEM,
				messages: [
					{
						role: "user",
						content: [
							...(r.frameSent && r.framePath && existsSync(r.framePath) ?
								[
									{
										type: "image" as const,
										image: readFileSync(r.framePath).toString("base64")
									}
								]
							:	[]),
							{
								type: "text" as const,
								text: judgePrompt({
									block: r.block,
									facts: r.facts,
									label,
									text: r.text,
									frameSent: r.frameSent
								})
							}
						]
					}
				],
				maxOutputTokens: 2000
			})
			const parsed = JudgeVerdict(JSON.parse(stripFence(out.text ?? "")))
			if (parsed instanceof type.errors)
				rows.push({ ...base, rawOnFailure: out.text ?? "", error: parsed.summary })
			else rows.push({ ...base, verdict: parsed })
		} catch (err) {
			rows.push({ ...base, error: err instanceof Error ? err.message : String(err) })
		}
	}

	run.judge = { provider: provId, model, labels: labelsPath, rows }
	writeFileSync(runPath, `${JSON.stringify(run, null, "\t")}\n`)

	/* ---- what the grades say, per arm, because the arms are the experiment ---- */
	console.log(`\n${"=".repeat(96)}\nJUDGED  ${rows.length} of ${run.results.length} turns had a label\n`)
	const arms = [...new Set(rows.map(r => r.arm))].sort()
	console.log("arm        n   good   weak  wrong  right-call     used-the-frame  broke-a-rule  ungraded")
	for (const arm of arms) {
		const a = rows.filter(r => r.arm === arm)
		const g = a.filter(r => r.verdict !== null)
		const n = g.length
		console.log(
			`${arm.padEnd(9)} ${String(n).padStart(3)}  ` +
				`${pct(g.filter(r => r.verdict!.verdict === "good").length, n)}  ` +
				`${pct(g.filter(r => r.verdict!.verdict === "weak").length, n)}  ` +
				`${pct(g.filter(r => r.verdict!.verdict === "wrong").length, n)}  ` +
				`${pct(g.filter(r => r.verdict!.decisionCorrect).length, n).padStart(13)}  ` +
				`${pct(g.filter(r => r.verdict!.usedFrame === "yes").length, n).padStart(14)}  ` +
				`${pct(g.filter(r => r.verdict!.broke.length > 0).length, n).padStart(12)}  ` +
				`${String(a.length - n).padStart(8)}`
		)
	}
	const failed = rows.filter(r => r.error !== null)
	if (failed.length > 0) {
		console.log(`\n${failed.length} turns could not be graded:`)
		for (const f of failed.slice(0, 10)) console.log(`  ${f.id} ${f.arm}: ${f.error}`)
	}
	console.log(`\nwrote ${runPath}`)
}

/* ------------------------------------------------------------------- the run */

const main = async (): Promise<void> => {
	if (flag("judge")) return runJudge()
	/*
	 * Re-print the summary of a run already on disk, calling nothing.
	 *
	 * Not a convenience. The summary is the part of this harness most likely to be wrong — its
	 * control table silently joined on the wrong key once — and re-deriving it from a stored run
	 * is how a fix to it gets checked without paying for another 180 turns, and without the
	 * temptation to check it by reading the code instead.
	 */
	if (flag("summarize")) {
		const path = arg("summarize", "latest")
		const at = path === "latest" ? newestRun() : path
		summarize(JSON.parse(readFileSync(at, "utf8")) as RunFile)
		console.log(`\n(from ${at}; nothing was called)`)
		return
	}

	const fixturePath = arg("fixture", `${DATA_DIR}/eval/fixture-5635467422.json`)
	const fixture = readFixture(fixturePath)
	const samplesPath = fixture.source.samples.startsWith("data/") ?
		fixture.source.samples.replace(/^data\//, `${DATA_DIR}/`)
	:	fixture.source.samples

	const provId = (arg("provider", "gemini-http") || "gemini-http") as ProviderId
	const p = providerById(provId)
	if (!p) throw new Error(`no provider called ${provId}`)
	if (providerKey(p) === null)
		throw new Error(`no key for ${provId} — put one in data/${p.keyFile}, or use --provider mock`)
	const model = arg("model", "") || p.defaultModel
	const repeats = Math.max(1, Number(arg("repeats", "1")))
	const noFrame = flag("no-frame")
	const concurrency = Math.max(1, Number(arg("concurrency", "3")))
	const verbose = flag("verbose")
	const stamp = stampNow()
	const out = arg("out", `${DATA_DIR}/eval/run-${stamp}.json`)

	/* -- rebuild the blocks through the shipped path, then check them ---------- */
	const samples = readVerbatim(samplesPath)
	if (samples.length === 0) throw new Error(`no samples in ${samplesPath}`)
	const { baseline, games: baselineGames } = baselineDuring(fixture.gameId)
	const replayed = replayStream(samples, baseline)

	const selected = selectCheckpoints(fixture.checkpoints, arg("checkpoints", "all"))
	const drift: string[] = []
	for (const c of selected) {
		const r = replayed.get(c.sampleLine)
		if (!r) throw new Error(`${c.id}: sample line ${c.sampleLine} produced no state on replay`)
		if (r.block !== c.block) drift.push(c.id)
	}
	if (drift.length > 0 && !flag("allow-block-drift")) {
		console.error(
			`\n${drift.length} of ${selected.length} checkpoints re-render to a DIFFERENT block than ` +
				`the frozen fixture:\n  ${drift.slice(0, 8).join(", ")}${drift.length > 8 ? " ..." : ""}\n\n` +
				`This run would not be replaying the game the fixture froze. The usual cause is that ` +
				`the corpus grew a game created BEFORE ${fixture.gameId}, moving the farm baseline, or ` +
				`that renderState/buildFacts changed. The fixture CANNOT be rebuilt — ` +
				`scripts/build-fixture.ts was deleted on 2026-09-11 as superseded by ` +
				`scripts/bench-stream.ts, which replays the raw samples with no frozen middle step. ` +
				`Either bench this game there instead, or pass --allow-block-drift to run anyway and ` +
				`record both blocks.\n`
		)
		process.exit(1)
	}

	/* -- the work list: every frame-bearing checkpoint TWICE ------------------- */
	interface Job {
		c: FixtureCheckpoint
		arm: "frame" | "no-frame"
		attempt: number
	}
	const jobs: Job[] = []
	for (let attempt = 1; attempt <= repeats; attempt++)
		for (const c of selected) {
			// Adjacent, so the two halves of a pair are never separated by a rate-limit backoff or a
			// model version rolling forward underneath the run.
			if (!noFrame && frameUsable(c)) jobs.push({ c, arm: "frame", attempt })
			jobs.push({ c, arm: "no-frame", attempt })
		}

	const vocab = championVocabulary()
	/** One read per JPEG however many arms and repeats use it, and the true byte count with it. */
	const frameCache = new Map<string, { b64: string; bytes: number }>()
	const frame = (path: string): { b64: string; bytes: number } => {
		const hit = frameCache.get(path)
		if (hit !== undefined) return hit
		const buf = readFileSync(path)
		const enc = { b64: buf.toString("base64"), bytes: buf.byteLength }
		frameCache.set(path, enc)
		return enc
	}

	console.log(`\nfixture   ${fixturePath}`)
	console.log(`  game      ${fixture.gameId}, ${samples.length} raw samples from ${samplesPath}`)
	console.log(`  baseline  ${baselineGames} games, all created before this one`)
	console.log(
		`  selected  ${selected.length} checkpoints ` +
			`(${selected.filter(frameUsable).length} with a usable frame)`
	)
	console.log(`  blocks    ${drift.length === 0 ? "all match the frozen fixture" : `${drift.length} DRIFTED (running anyway)`}`)
	console.log(`  arms      ${noFrame ? "no-frame only (--no-frame)" : "frame + no-frame on every frame-bearing checkpoint"}`)
	console.log(`  provider  ${provId} ${model}`)
	console.log(`  turns     ${jobs.length}  (repeats ${repeats}, concurrency ${concurrency})\n`)

	const results: TurnResult[] = []
	let done = 0
	const runJob = async (j: Job): Promise<void> => {
		const rep = replayed.get(j.c.sampleLine)!
		const sendFrame = j.arm === "frame"
		const r = await coachTurn({
			// Pinned, not inherited: a harness that takes the PRODUCT default silently re-points
			// itself the day that default moves. It did — five harnesses swapped baseline from
			// fenced to cite-or-quiet with nothing failing. Every number this script has ever
			// printed was measured against the fenced block, so that is what it keeps measuring.
			mode: "fenced" as const,
			provider: provId,
			model,
			...(sendFrame ? { frameJpegBase64: frame(j.c.framePath!).b64 } : {}),
			blockText: rep.block
		})
		const text = r.text ?? ""
		const score =
			r.ok ?
				scoreLine({ line: text, block: rep.block, roster: rep.roster, champions: vocab.names })
			:	null
		results.push({
			id: j.c.id,
			tSec: j.c.tSec,
			clock: j.c.clock,
			sampleLine: j.c.sampleLine,
			arm: j.arm,
			attempt: j.attempt,
			frameSent: r.frameSent,
			framePath: sendFrame ? j.c.framePath : null,
			frameSkewSec: sendFrame ? j.c.frameSkewSec : null,
			frameBytes: sendFrame ? frame(j.c.framePath!).bytes : null,
			block: rep.block,
			blockMatchesFixture: rep.block === j.c.block,
			facts: rep.facts,
			roster: rep.roster,
			provider: provId,
			model: r.model,
			ok: r.ok,
			text,
			latencyMs: r.latencyMs,
			reason: r.reason ?? null,
			silent: score?.silent ?? false,
			empty: r.ok && isEmpty(text),
			subject: r.ok ? subjectOf(text) : "error",
			score
		})
		done++
		if (verbose)
			console.log(
				`[${String(done).padStart(3)}/${jobs.length}] ${j.c.id} ${j.c.clock} ${j.arm.padEnd(8)} ` +
					`${r.ok ? "" : `FAILED ${r.reason} `}${text.replace(/\s+/g, " ").slice(0, 120)}`
			)
		else if (done % 10 === 0) console.log(`  ${done}/${jobs.length}`)
	}

	/*
	 * A small pool rather than `Promise.all` over everything: providers rate-limit, and a burst of
	 * 180 image turns comes back as 180 errors that look exactly like a model producing nothing.
	 * Failures are still recorded rather than retried — a retry would hide the rate limit.
	 */
	const queue = [...jobs]
	await Promise.all(
		Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
			for (;;) {
				const j = queue.shift()
				if (!j) return
				await runJob(j)
			}
		})
	)
	results.sort(
		(a, b) => a.tSec - b.tSec || a.attempt - b.attempt || (a.arm === b.arm ? 0 : a.arm === "frame" ? -1 : 1)
	)

	const file: RunFile = {
		kind: "e2e-real-game-run",
		stamp,
		fixture: fixturePath,
		gameId: fixture.gameId,
		provider: provId,
		model,
		promptSha256: createHash("sha256").update(LIVE_COACH_SYSTEM_PROMPT).digest("hex").slice(0, 16),
		shippedProvider: "gemini-live",
		turnCadenceMs: SHIPPED_TURN_MS,
		baselineGames,
		repeats,
		notes: [
			"Every frame-bearing checkpoint was run twice, back to back, with everything but the image content part byte-identical. `arm` says which half a row is.",
			"The shipped live coach is the `gemini-live` WebSocket. This is the turn-based HTTPS path through `coachTurn`, which is the closest twin and the only one that can hold the prompt constant across models. A socket-only difference will not appear here.",
			"Turns are stateless, which matches `POST /api/live/coach/turn` exactly and does NOT match the socket: the socket keeps a thread and can see what it already said. A repeat here might have been suppressed there.",
			"`facts` is `state.unseen` — the ranked, rate-limited list from `buildFacts`, produced by replaying the whole 363-sample stream in order. A fact that is not in that list does not exist to the coach.",
			"Failed turns are rows with `ok: false` and a `reason`. They are never dropped.",
			"`score` is the mechanical fault detector from `src/analysis/coach-score.ts`. It answers 'did you break a rule', never 'was this right' — for the second question, run --judge against the labels."
		],
		results
	}
	mkdirSync(dirname(out), { recursive: true })
	writeFileSync(out, `${JSON.stringify(file, null, "\t")}\n`)

	summarize(file)
	console.log(`\nwrote ${out}`)
	if (!existsSync(`${DATA_DIR}/eval/labels-${fixture.gameId}.json`))
		console.log(
			`\nno labels at data/eval/labels-${fixture.gameId}.json yet — once there are, grade this run with:\n` +
				`  node --env-file-if-exists=.env --experimental-strip-types scripts/e2e-real-game.ts --judge ${out}`
		)
}

/* -------------------------------------------------------------- the summary */

/**
 * What came back, in the units he experiences.
 *
 * The rates are here because they are the cheap part, and the SENTENCES are here because for weeks
 * the rates were the only thing anyone looked at and they said the coach was fine. A talkativeness
 * figure cannot show that every line was about gold; only reading the lines can.
 */
export const summarize = (file: RunFile): void => {
	const arms = [...new Set(file.results.map(r => r.arm))].sort()
	const perMin = (spoke: number, turns: number): string =>
		turns === 0 ? "-" : ((spoke / turns) * (60_000 / file.turnCadenceMs)).toFixed(1)

	const armTable = (rows: TurnResult[]): void => {
		console.log("arm        turns  failed  silent  empty   spoke   lines/min   median ms   faults")
		for (const arm of arms) {
			const a = rows.filter(r => r.arm === arm)
			if (a.length === 0) continue
			const okRows = a.filter(r => r.ok)
			const spoke = okRows.filter(r => !r.silent && !r.empty)
			const lat = a.map(r => r.latencyMs).sort((x, y) => x - y)
			const faults = okRows.filter(r => (r.score?.faults.length ?? 0) > 0).length
			console.log(
				`${arm.padEnd(9)} ${String(a.length).padStart(6)}  ` +
					`${String(a.length - okRows.length).padStart(6)}  ` +
					`${pct(okRows.filter(r => r.silent).length, okRows.length)}   ` +
					`${pct(okRows.filter(r => r.empty).length, okRows.length)}  ` +
					`${pct(spoke.length, okRows.length)}   ` +
					`${perMin(spoke.length, okRows.length).padStart(9)}   ` +
					`${String(lat[Math.floor(lat.length / 2)] ?? 0).padStart(9)}   ` +
					`${String(faults).padStart(6)}`
			)
		}
	}
	const mixLine = (rows: TurnResult[]): void => {
		const subjects = [...new Set(rows.filter(r => r.ok && !r.silent && !r.empty).map(r => r.subject))]
		for (const arm of arms) {
			const spoke = rows.filter(r => r.arm === arm && r.ok && !r.silent && !r.empty)
			const mix = subjects
				.map(s => ({ s, n: spoke.filter(r => r.subject === s).length }))
				.filter(x => x.n > 0)
				.sort((a, b) => b.n - a.n)
			console.log(`  ${arm.padEnd(9)} ${mix.map(x => `${x.s} ${x.n}`).join("  ") || "(said nothing)"}`)
		}
	}

	console.log(`\n${"=".repeat(96)}\nWHAT CAME BACK  ${file.provider} ${file.model}\n`)
	console.log("EVERY TURN — the whole game, as the coach would have experienced it")
	armTable(file.results)
	console.log(
		`\n(lines/min assumes the shipped ${file.turnCadenceMs / 1000}s turn cadence from ` +
			`DEFAULT_TURN_MS in src/web/lib/geminiLive.ts)`
	)
	console.log("\nWHAT IT TALKED ABOUT")
	mixLine(file.results)

	/*
	 * The two arms again, restricted to the checkpoints they SHARE — and this table is the one to
	 * read, not the one above.
	 *
	 * Frames exist only from 0:02 to 6:43 of a 36:49 game, so the frame arm runs on 42 early-game
	 * instants and the no-frame arm on all 140. Measured on the first full run, the top table read
	 * "frame 93% silent, no-frame 84% silent", which looks like the picture making the coach
	 * quieter and is nothing of the kind: it is laning phase against the whole game. On the shared
	 * 42 both arms were 93%. A rate compared across different halves of a game is not a comparison.
	 */
	const pairedIds = new Set(file.results.filter(r => r.arm === "frame").map(r => r.id))
	if (pairedIds.size > 0 && pairedIds.size < new Set(file.results.map(r => r.id)).size) {
		const shared = file.results.filter(r => pairedIds.has(r.id))
		console.log(
			`\nTHE SAME ${pairedIds.size} CHECKPOINTS, BOTH ARMS — the only fair arm-vs-arm comparison\n` +
				`(frames exist only from ${file.results.find(r => r.arm === "frame")?.clock ?? "?"} to ` +
				`${[...file.results].reverse().find(r => r.arm === "frame")?.clock ?? "?"}; the rows above ` +
				`compare laning phase against a whole game)`
		)
		armTable(shared)
		mixLine(shared)
	}

	/* -- the ablation, pair by pair ------------------------------------------- */
	const frameRows = file.results.filter(r => r.arm === "frame")
	if (frameRows.length > 0) {
		/*
		 * Pair two sets of turns by checkpoint.
		 *
		 * `sameAttempt` is the difference between the experiment and its control. The two ARMS are
		 * paired within one attempt, because they were sent back to back and share everything but
		 * the picture. The control pairs one arm against ITSELF across two attempts, so it must
		 * ignore the attempt number or it would match nothing — which it silently did on the first
		 * version of this code, printing a control of zero pairs that looked like a real result.
		 */
		const pairsFor = (
			a: TurnResult[],
			b: TurnResult[],
			sameAttempt: boolean
		): [TurnResult, TurnResult][] => {
			const key = (r: TurnResult): string => (sameAttempt ? `${r.id}#${r.attempt}` : r.id)
			const bi = new Map(b.map(r => [key(r), r]))
			const out: [TurnResult, TurnResult][] = []
			for (const x of a) {
				const y = bi.get(key(x))
				if (y && x !== y) out.push([x, y])
			}
			return out
		}
		const noFrameRows = file.results.filter(r => r.arm === "no-frame")
		const table = (label: string, pairs: [TurnResult, TurnResult][]): void => {
			const cmp = comparePairs(pairs)
			console.log(`  ${label}`)
			console.log(`    pairs compared             ${cmp.pairs}`)
			console.log(`    both stayed quiet          ${cmp.bothQuiet}`)
			console.log(`    one spoke, one did not     ${cmp.oneSpoke}  (first-listed arm only: ${cmp.onlyFirstSpoke})`)
			console.log(`    both spoke                 ${cmp.bothSpoke}`)
			console.log(`      word for word identical  ${cmp.identical}`)
			console.log(`      same subject             ${cmp.sameSubject}`)
			console.log(`      same numbers cited       ${cmp.sameNumbers}`)
			console.log(`      differed in CONTENT      ${cmp.contentDiffered}`)
			// A zero here is not a result, it is a broken join. The first version of the control
			// keyed on the attempt number and matched nothing, and printed a clean table of zeroes.
			if (cmp.pairs === 0) console.log("    ^ NO COMPARABLE PAIRS — this table is not a result")
		}
		console.log("\nTHE ABLATION  (same block, same prompt, same model; only the picture differs)")
		table("frame vs no-frame", pairsFor(frameRows, noFrameRows, true))

		/*
		 * The control, and without it the ablation is unreadable.
		 *
		 * Measured on the first real run of this harness: 2 of 3 frame/no-frame pairs "differed",
		 * and both differences were paraphrase — "be where they are" against "group up", off the
		 * same single ranked fact. A model at its default temperature differs from ITSELF that
		 * much. So the honest question is not whether the frame arm differs from the text arm, it
		 * is whether it differs MORE than the text arm differs from a second sample of itself.
		 *
		 * Needs --repeats 2 or more, because that is where a second sample of the same arm comes
		 * from. Said plainly rather than skipped silently.
		 */
		if (file.repeats > 1) {
			const byAttempt = (rows: TurnResult[], n: number): TurnResult[] =>
				rows.filter(r => r.attempt === n)
			table(
				"\n  CONTROL: no-frame vs no-frame, two samples of the SAME arm",
				pairsFor(byAttempt(noFrameRows, 1), byAttempt(noFrameRows, 2), false)
			)
		} else {
			console.log(
				"\n  NO CONTROL RUN. A model at its default temperature paraphrases itself, so a" +
					"\n  difference above is not yet evidence the picture was read. Re-run with --repeats 2" +
					"\n  to get the no-frame-vs-no-frame control this needs."
			)
		}
		console.log(
			"\n  A frame arm that differs from the text arm no more than the text arm differs from" +
				"\n  ITSELF is a frame that is not being read. Whether a difference is an IMPROVEMENT is" +
				"\n  not a question this can answer — run --judge against the labels."
		)
	}

	/* -- the sentences -------------------------------------------------------- */
	console.log(`\n${"=".repeat(96)}\nTHE ACTUAL SENTENCES\n`)
	const byCp = new Map<string, TurnResult[]>()
	for (const r of file.results) byCp.set(r.id, [...(byCp.get(r.id) ?? []), r])
	for (const [id, rows] of [...byCp].sort((a, b) => a[1][0]!.tSec - b[1][0]!.tSec)) {
		console.log(`${id}  ${rows[0]!.clock}   facts: ${rows[0]!.facts.length === 0 ? "(none — PASS is correct)" : rows[0]!.facts.map(f => `"${f}"`).join(" | ")}`)
		for (const r of rows) {
			const faults = r.score?.faults ?? []
			const said =
				!r.ok ? `FAILED ${r.reason ?? "unknown"}`
				: r.silent ? "PASS"
				: r.empty ? "(nothing came back at all)"
				: r.text.replace(/\s+/g, " ")
			console.log(
				`   ${r.arm.padEnd(8)} ${said}${faults.length > 0 ? `   [${faults.join(", ")}]` : ""}`
			)
		}
	}

	const failed = file.results.filter(r => !r.ok)
	if (failed.length > 0) {
		console.log(`\n${failed.length} TURNS FAILED — these are in the file too, never dropped:`)
		const why = new Map<string, number>()
		for (const f of failed) why.set(f.reason ?? "unknown", (why.get(f.reason ?? "unknown") ?? 0) + 1)
		for (const [reason, n] of [...why].sort((a, b) => b[1] - a[1]))
			console.log(`  ${String(n).padStart(4)}x  ${reason}`)
	}
	const drifted = file.results.filter(r => !r.blockMatchesFixture)
	if (drifted.length > 0)
		console.log(
			`\nWARNING: ${drifted.length} turns ran on a block that does NOT match the frozen fixture ` +
				`(--allow-block-drift). Do not compare this run against one that did.`
		)
}

if (import.meta.main) await main()
