/**
 * model-race — the head-to-head he asked for: every architecture that survived the census, over the
 * SAME turns of the same games, judged blind in ONE pool.
 *
 * ## The question
 *
 * *"getting really bad feedback and im starting to think more that the model quality is the biggest
 * problem. do more iteration on variants for other models (e.g. opus, fable, astra etc)."*
 *
 * Three instruments already exist and each answers a third of it. `scripts/socket-bake.ts` raced the
 * SOCKET models against each other. `scripts/measure-ttft.ts` proved a cached, streamed, low-effort
 * Anthropic turn can reach a first syllable inside the socket's own 1.15s. `scripts/frame-power.ts`
 * showed the picture is worth nothing measurable. None of them put a socket model and a turn model
 * on the same table, and the table is the whole question: if `claude-opus-5` is not better than
 * `gemini-3.8-live` on his own games, the model is not the constraint and no amount of shopping
 * fixes the coach.
 *
 * ## WHAT THIS RUN COULD NOT DO, said before any number
 *
 * **The Gemini key is out of prepaid credit.** Every call — socket or HTTPS — answers
 * `429 "Your prepayment credits are depleted"`, and it has since 2026-09-18 ~14:40. That has two
 * consequences a reader must carry into every figure below:
 *
 *   1. **No socket arm could be RUN.** The socket columns in this run's report are the lines
 *      `scripts/socket-bake.ts` recorded on 2026-09-18 before the credit went, replayed from
 *      `data/eval/socket-bake-*-20260918.json`. They are real lines said by real models about these
 *      exact payloads; they were not spoken today and their latencies are that run's.
 *   2. **No minimap read could be taken.** The reader is a Gemini call, so a payload BUILT today
 *      would carry no position and no reach clause — which AGENTS.md records as the join every
 *      useful line in the last graded round was made of. A turn arm handed that payload would be
 *      starved, and the comparison would measure the starving.
 *
 * So this file does not build payloads. **It replays the stored ones, byte for byte.**
 *
 * ## How the states are held identical, and the one place they are not
 *
 * Every arm in `socket-bake` held the same payload except for one section. Checked rather than
 * asserted: split each stored payload on blank lines and the sections are byte-identical across all
 * five arms on every turn of both games, EXCEPT `WHAT YOU HAVE ALREADY SAID THIS GAME`, which is
 * per-arm by construction — an arm that said different things has different things not to repeat.
 *
 * This file therefore takes the `mock` arm's payload as the state template, cuts that one section
 * out, and splices each turn arm's OWN said-log back in with `renderSaid` from
 * `src/analysis/coach-memory.ts` — the same renderer the app uses, fed by `noteSaid` with the arm's
 * own lines as it speaks them. So a turn arm is asked exactly the question the socket was asked,
 * about the same instant, with its own memory and nobody else's.
 *
 * Three differences between the shapes remain and none of them can be removed:
 *
 *   - **The socket has a thread and a turn call does not.** Gemini Live has seen every previous
 *     payload, frame and answer; `coachTurn` sends one user message. That advantages the socket on
 *     repetition and disadvantages it nowhere, and it is why the said-log exists at all.
 *   - **The socket's system prompt carries the pronunciation guide** (`socketSystemPrompt`) and the
 *     turn path's does not (`coachSystemPrompt`). Same persona, same knowledge, same mode; the
 *     respellings are the delta.
 *   - **A shipped turn provider would receive a FULL BRIEF every turn**, because `geminiLive.ts`
 *     asks for `{resync: true}` on that path. Here every arm gets the socket's delta sequence. That
 *     is a deliberate choice: it holds the QUESTION constant across shapes. It also makes the turn
 *     arms cheaper per turn than they would be in the app, and the cost column says so.
 *
 * ## The arms
 *
 *   - `mock` — the floor. No model; the payload's first `- ` bullet read aloud. AGENTS.md's standing
 *     rule: an arm that does not beat it is paying latency for nothing. From the stored run.
 *   - `incumbent` — `models/gemini-3.1-flash-live-preview`, the socket this app has shipped since the
 *     day it was built and the only model the live path has ever run. From the stored run.
 *   - `g38` — `models/gemini-3.8-live`, the socket winner of `socket-bake`. From the stored run.
 *   - `haiku` — `claude-haiku-4-5`. The cheap turn floor. Effort is NOT sent: the 4.5 generation
 *     answers an effort request with a 400 (`live-providers.ts` documents the measurement), so on
 *     Haiku the low-effort arm IS the default arm.
 *   - `sonnet` — `claude-sonnet-5` at `effort: low`, cached, streamed. The measured 1,616ms first
 *     syllable, i.e. the one turn model that is live-eligible against the socket's 1,150ms.
 *   - `opus` — `claude-opus-5` at `effort: low`, cached, streamed. THE DIRECT TEST OF HIS HYPOTHESIS.
 *   - `fable` — `claude-fable-5-1` at `effort: low`, cached, streamed. The census says leave it out
 *     of a LIVE race on latency (9-11s to first token) and it is in here anyway, labelled
 *     ineligible, because he named it and because the question "is the best writer on this key
 *     better at this job" is worth answering even when the answer cannot ship live. If it wins big,
 *     the finding is about the POST-GAME path, not the coach.
 *
 * ## Judging
 *
 * The run file is written in the `{windows, records}` shape `scripts/judge-corpus.ts` reads, with
 * the socket arms' records carried in beside the new ones, so ONE judge grades all seven arms in
 * ONE shuffled, blinded pool against the payload each line was holding. That matters more than it
 * sounds: re-using `socket-bake`'s stored verdicts would have compared two judge runs with different
 * batch composition, and this judge disagrees with itself on ~16% of identical lines.
 *
 * Beside the judge, two instruments that need no judgement and fail differently:
 *
 *   - `clockClaims` + `mechanicalVerdict` (`scripts/lib/payload-claims.ts`) — a death clock stated
 *     backwards is caught by subtraction, with no model in the loop;
 *   - `scoreLine` (`src/analysis/coach-score.ts`) — invented champions, unbacked figures,
 *     misattributed numbers, invented movement.
 *
 * ## Power, before anyone reads a winner into this
 *
 * The standing floor in this repo is the frame ablation's self-agreement run: the same arm run twice
 * agrees with itself on 13 of 30 turns, so a ONE-GAME quality race needs about 27 points of useful
 * rate to see anything at all. Two games of 60 paired turns is what `socket-bake` could afford and
 * it is what exists; the report prints McNemar's exact on the paired turns and the per-game split,
 * and a pooled margin that is not homogeneous across the two games is NOT a result about models.
 *
 * ## Usage
 *
 *     node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *       scripts/model-race.ts --arms haiku,sonnet,opus,fable
 *
 *     --from a.json,b.json  the stored socket-bake runs to replay (default: the two 20260918 games)
 *     --arms a,b,c          which TURN arms to run (default haiku,sonnet,opus,fable)
 *     --turns N             cap the checkpoints per game (default: all)
 *     --no-frames           send no JPEG to the turn arms (the socket arms' stored lines saw one)
 *     --dry                 no network and no bill; every turn arm echoes the payload's first bullet
 *     --out <path>          default data/eval/model-race-<stamp>.json
 *     --summarize <path>    re-print a stored run; add --judged <path> to join the verdicts
 *     --sheet <path>        write the BLINDED html sheet + key from a stored run
 *
 * NODE ONLY. Safe to run mid-game: it opens no socket and never touches the LCU.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DATA_DIR } from "../src/shared/constants.ts"
import { buildStream, championVocabulary, discoverBenchable } from "./lib/stream.ts"
import { HEARTBEAT_SEC } from "../src/analysis/live-events.ts"
import type { SpeakLevel } from "../src/analysis/live-events.ts"
import type { StreamWindow } from "./lib/stream.ts"
import { coachTurn } from "../src/review/live-providers.ts"
import type { CoachEffort, TurnUsage } from "../src/review/live-providers.ts"
import { newMemory, noteSaid, renderSaid } from "../src/analysis/coach-memory.ts"
import { FABRICATION_FAULTS, isEmpty, isSilent, wilson } from "../src/analysis/coach-score.ts"
import { scoreLine } from "../src/analysis/coach-score.ts"
import { clockClaims, mechanicalVerdict, readPayload } from "./lib/payload-claims.ts"
import { renderKey, renderSheet } from "./lib/sheet.ts"
import type { SheetLine } from "./lib/sheet.ts"

/* ================================================================== arguments */

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : fallback
}
const has = (name: string): boolean => argv.includes(`--${name}`)

const DEFAULT_FROM = [
	`${DATA_DIR}/eval/socket-bake-kayn-20260918.json`,
	`${DATA_DIR}/eval/socket-bake-fiddle-20260918.json`
].join(",")

const fromArg = arg("from", DEFAULT_FROM)
const turnsWanted = Number(arg("turns", "999"))
const noFrames = has("no-frames")
const dry = has("dry")
const summarizePath = arg("summarize", "")
const judgedPath = arg("judged", "")
const sheetPath = arg("sheet", "")
const momentsArg = arg("moments", "")
const vsArg = arg("vs", "incumbent,g38")

/* ==================================================================== the arms */

interface TurnArm {
	id: string
	provider: string
	model: string
	effort: CoachEffort
	/** Whether a first syllable inside the socket's 1.15s has been measured for this model. */
	liveEligible: boolean
	what: string
}

const TURN_ARMS: readonly TurnArm[] = [
	{
		id: "haiku",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		// `effort: low` is REQUESTED and `effortOptions` deliberately sends nothing for the 4.5
		// generation, which 400s on the parameter. Recorded as low so the run file cannot lose which
		// knob was asked for; the provider column is where the truth about what was sent lives.
		effort: "low",
		liveEligible: true,
		what: "the cheap turn floor — 465-610ms to first token in the census"
	},
	{
		id: "sonnet",
		provider: "anthropic",
		model: "claude-sonnet-5",
		effort: "low",
		liveEligible: true,
		what: "cached + streamed + low effort: 1,616ms to first syllable, inside the socket's 1,150ms"
	},
	{
		id: "opus",
		provider: "anthropic",
		model: "claude-opus-5",
		effort: "low",
		liveEligible: true,
		what: "THE HYPOTHESIS. 3,248ms to first syllable at low effort — slow but shippable"
	},
	{
		id: "fable",
		provider: "anthropic",
		model: "claude-fable-5-1",
		effort: "low",
		liveEligible: false,
		what: "the best writer on this key; 9-11s to first token, so a POST-GAME answer, not a live one"
	}
]

const chosen: TurnArm[] = arg("arms", "haiku,sonnet,opus,fable")
	.split(",")
	.map(s => s.trim())
	.filter(s => s !== "")
	.map(id => {
		const a = TURN_ARMS.find(x => x.id === id)
		if (!a) throw new Error(`no turn arm called ${id}; have ${TURN_ARMS.map(x => x.id).join(",")}`)
		return a
	})

/**
 * Anthropic list price per MILLION tokens, 2026-09-18, from the vendor's own model table.
 *
 * Cache reads bill at 0.1x input and cache writes at 1.25x. These are the only prices in this file
 * and they are first-party rates; a run on Bedrock or Vertex would cost something else entirely.
 */
const PRICE: Record<string, { in: number; out: number }> = {
	"claude-opus-5": { in: 5, out: 25 },
	"claude-sonnet-5": { in: 2, out: 10 },
	"claude-haiku-4-5": { in: 1, out: 5 },
	"claude-fable-5-1": { in: 10, out: 50 }
}

/**
 * `TurnUsage.inputTokens` is the GRAND TOTAL — `live-providers.ts` sets it from the SDK's
 * `inputTokens`, which already contains the cached and written halves. Billing the whole of it at
 * the uncached rate AND the cache halves again on top is a 2x overstatement, and the first test run
 * of this file did exactly that.
 */
const costOf = (model: string, u: TurnUsage | undefined): number | null => {
	const p = PRICE[model]
	if (!p || !u) return null
	const fresh = Math.max(0, u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens)
	return (
		(fresh * p.in + u.cacheReadTokens * p.in * 0.1 + u.cacheWriteTokens * p.in * 1.25) / 1e6 +
		(u.outputTokens * p.out) / 1e6
	)
}

/* ============================================================= the stored runs */

interface StoredCall {
	arm: string
	model: string
	windowId: string
	index: number
	rep: number
	atSec: number
	clock: string
	text: string
	spoke: boolean
	firstAudioMs: number | null
	completeMs: number
	frameSent: boolean
	payload: string
	promptTokens: number | null
	responseTokens: number | null
	error: string | null
}
interface StoredWindow {
	id: string
	gameId: string
	champion: string
	counterpart?: string | null
	kind?: string
	gameDurationSec?: number
}
interface StoredRun {
	level: string
	windows: StoredWindow[]
	calls: StoredCall[]
	records: { arm: string; windowId: string; index: number; atSec: number; clock: string; text: string; error: string | null; payload: string }[]
}

const SAID_HEAD = "WHAT YOU HAVE ALREADY SAID THIS GAME"

/**
 * Cut the one per-arm section out of a stored payload, leaving a template with a marker.
 *
 * A payload with NO said section is not an error and must not be repaired: `buildDelta` ranks the
 * said log above `THE GAME SO FAR` but below the state blocks, and on a long late-game turn the byte
 * budget evicts it entirely — 4 of the 31 turns of the Fiddlesticks game. On exactly those turns the
 * socket arms were given no memory either, so the template goes out with no marker and the splice
 * below is a no-op. Inserting one would hand the turn arms a section the socket never held.
 */
const templateOf = (payload: string): string => {
	const parts = payload.split("\n\n")
	const i = parts.findIndex(p => p.startsWith(SAID_HEAD))
	if (i < 0) return payload
	parts[i] = "{{SAID}}"
	return parts.join("\n\n")
}

/** Everything except the said section, for the identity check across arms. */
const stateOnly = (payload: string): string =>
	payload
		.split("\n\n")
		.filter(p => !p.startsWith(SAID_HEAD))
		.join("\n\n")

interface Checkpoint {
	windowId: string
	index: number
	atSec: number
	clock: string
	template: string
	frameB64: string | null
	/**
	 * Did EVERY arm in the stored run hold byte-identical state on this turn, outside the said log?
	 *
	 * Usually yes, and where it is no the cause is the delta's BYTE BUDGET rather than anything
	 * about the model: the said log is ranked above `THE GAME SO FAR`, so an arm that has said more
	 * has less room left and the narrative tail is what gets evicted. On the two stored games that
	 * happens on 12 of 60 turns, and on one of them the incumbent lost the section entirely.
	 *
	 * It matters because this file splices a FRESH said log into the template, which is shorter than
	 * the chatty socket arms' — so on exactly those turns a turn arm is handed a slightly RICHER
	 * payload than the socket held. That is an advantage pointing towards the hypothesis under test,
	 * which is the worst direction for a bias to point, so the report prints the whole table and
	 * then prints it again over the identical-state turns alone.
	 */
	identical: boolean
}

/* ==================================================================== the record */

interface RaceCall {
	arm: string
	provider: string
	model: string
	shape: "turn" | "socket" | "mock"
	effort: CoachEffort | null
	windowId: string
	index: number
	rep: number
	atSec: number
	clock: string
	text: string
	/** Time to the FIRST thing he could hear. Streamed turn arms: `speakableMs`. Socket: first PCM. */
	firstSyllableMs: number | null
	/** Time to the first token/transcript fragment, whatever the shape produced one. */
	firstTokenMs: number | null
	/** Whole answer: the last syllable finished generating. */
	completeMs: number
	frameSent: boolean
	payload: string
	payloadChars: number
	usage: TurnUsage | null
	costUsd: number | null
	/** Whether every arm held byte-identical state on this turn. See `Checkpoint.identical`. */
	identical: boolean
	error: string | null
}

interface RaceRun {
	ranAt: string
	argv: string[]
	level: string
	note: string
	arms: { id: string; provider: string; model: string; shape: string; effort: string | null; what: string; liveEligible: boolean }[]
	windows: StoredWindow[]
	calls: RaceCall[]
	records: { arm: string; windowId: string; index: number; rep: number; atSec: number; clock: string; text: string; error: string | null; payload: string }[]
}

/* ======================================================================= the run */

const loadStored = (paths: readonly string[]): { runs: StoredRun[]; level: string } => {
	const runs = paths.map(p => JSON.parse(readFileSync(p, "utf8")) as StoredRun)
	const levels = [...new Set(runs.map(r => r.level))]
	if (levels.length !== 1)
		throw new Error(`the source runs replay different schedules (${levels.join(", ")}); a race across two schedules is not a race`)
	return { runs, level: levels[0]! }
}

/** The state stream for one stored game, plus the real frame for each checkpoint. */
const checkpointsFor = (run: StoredRun, window: StreamWindow | undefined): Checkpoint[] => {
	const ref = run.calls.filter(c => c.arm === "mock").sort((a, b) => a.index - b.index)
	if (ref.length === 0) throw new Error(`${run.windows[0]?.id}: the stored run has no mock arm to take a state template from`)

	/*
	 * THE IDENTITY CHECK, run rather than assumed. If any other arm's payload differs from the
	 * reference outside the said section, the "one template for every arm" premise is false for
	 * that turn and the run says so loudly instead of quietly comparing two states.
	 */
	const byIndex = new Map(ref.map(c => [c.index, c]))
	const differs = new Set<number>()
	for (const c of run.calls) {
		const r = byIndex.get(c.index)
		if (!r || c.payload === "") continue
		if (stateOnly(c.payload) !== stateOnly(r.payload)) differs.add(c.index)
	}
	if (differs.size > 0)
		console.log(
			`  ${differs.size} of ${ref.length} turns carry a budget-evicted state difference between arms ` +
				`(turns ${[...differs].join(",")}) — those turns are flagged and re-reported alone`
		)

	const frames = new Map<number, { atSec: number; b64: string | null }>()
	if (window && !noFrames) {
		const stream = buildStream(window, {
			everySec: 20,
			fromSec: 0,
			turns: 999,
			requireFrame: false,
			schedule: "events",
			heartbeatSec: HEARTBEAT_SEC,
			level: run.level as SpeakLevel
		})
		for (const t of stream.turns) frames.set(t.index, { atSec: t.atSec, b64: t.frameB64 })
	}

	return ref.slice(0, turnsWanted).map(c => {
		const f = frames.get(c.index)
		/*
		 * A frame is attached only when the rebuilt stream lands on the SAME instant. The stored
		 * payloads are the authority on the state; a frame from a turn the replay numbered
		 * differently would be a picture of another moment, which `frame-power.ts` measured as the
		 * thing that actively misleads.
		 */
		const aligned = f !== undefined && Math.abs(f.atSec - c.atSec) < 0.5
		if (f !== undefined && !aligned)
			console.log(`WARNING  turn ${c.index}: rebuilt stream is at ${f.atSec.toFixed(1)}s, stored run at ${c.atSec.toFixed(1)}s — no frame sent`)
		return {
			windowId: c.windowId,
			index: c.index,
			atSec: c.atSec,
			clock: c.clock,
			template: templateOf(c.payload),
			frameB64: aligned ? (f!.b64 ?? null) : null,
			identical: !differs.has(c.index)
		}
	})
}

const run = async (): Promise<void> => {
	const paths = fromArg.split(",").map(s => s.trim()).filter(s => s !== "")
	const { runs, level } = loadStored(paths)

	const bench = noFrames ? { paired: [], textOnly: [] } : discoverBenchable()
	const benchable: StreamWindow[] = [...bench.paired, ...bench.textOnly]

	const windows: StoredWindow[] = []
	const calls: RaceCall[] = []

	for (const stored of runs) {
		const w = stored.windows[0]!
		windows.push(w)
		const window = benchable.find(x => x.id === w.id)
		if (!window && !noFrames) console.log(`WARNING  ${w.id} is no longer benchable; its turn arms run text-only`)
		const points = checkpointsFor(stored, window)
		console.log(`\n${w.gameId} ${w.champion} vs ${w.counterpart ?? "?"} — ${points.length} checkpoints, ${points.filter(p => p.frameB64 !== null).length} with a frame`)

		/* -- the socket arms and the mock, carried in from the stored run ------------ */
		for (const c of stored.calls) {
			if (!points.some(p => p.index === c.index)) continue
			calls.push({
				arm: c.arm,
				provider: c.model === "" ? "mock" : "gemini-live",
				model: c.model,
				shape: c.model === "" ? "mock" : "socket",
				effort: null,
				windowId: c.windowId,
				index: c.index,
				rep: c.rep,
				atSec: c.atSec,
				clock: c.clock,
				text: c.text,
				firstSyllableMs: c.firstAudioMs,
				firstTokenMs: c.firstAudioMs,
				completeMs: c.completeMs,
				frameSent: c.frameSent,
				payload: c.payload,
				payloadChars: c.payload.length,
				usage:
					c.promptTokens === null ? null : (
						{ inputTokens: c.promptTokens, outputTokens: c.responseTokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
					),
				costUsd: null,
				identical: points.find(p => p.index === c.index)?.identical ?? false,
				error: c.error
			})
		}

		/* -- the turn arms, live -------------------------------------------------- */
		const memories = new Map(chosen.map(a => [a.id, newMemory()]))
		for (const p of points) {
			// The arms are stateless, so they are asked in parallel: one wall clock per turn, and the
			// order within a turn cannot matter because no arm can see another's answer.
			const results = await Promise.all(
				chosen.map(async a => {
					const mem = memories.get(a.id)!
					const payload = p.template.replace("{{SAID}}", renderSaid(mem, p.atSec))
					if (dry)
						return {
							a,
							payload,
							text: (payload.split("\n").find(l => l.startsWith("- ")) ?? "- PASS").slice(2),
							ok: true,
							latencyMs: 0,
							ttftMs: undefined as number | undefined,
							speakableMs: undefined as number | undefined,
							usage: undefined as TurnUsage | undefined,
							reason: undefined as string | undefined,
							frameSent: false
						}
					const r = await coachTurn({
						provider: a.provider as never,
						model: a.model,
						blockText: payload,
						...(p.frameB64 !== null ? { frameJpegBase64: p.frameB64 } : {}),
						mode: "trusted",
						champion: w.champion,
						counterpart: w.counterpart ?? null,
						role: true,
						cache: true,
						effort: a.effort,
						onDelta: () => {}
					})
					return {
						a,
						payload,
						text: r.text,
						ok: r.ok,
						latencyMs: r.latencyMs,
						ttftMs: r.ttftMs,
						speakableMs: r.speakableMs,
						usage: r.usage,
						reason: r.reason,
						frameSent: r.frameSent
					}
				})
			)
			for (const res of results) {
				const text = (res.text ?? "").trim()
				if (res.ok && !isEmpty(text) && !isSilent(text))
					noteSaid(memories.get(res.a.id)!, text, p.atSec, (res.speakableMs ?? res.latencyMs) / 1000)
				calls.push({
					arm: res.a.id,
					provider: res.a.provider,
					model: res.a.model,
					shape: "turn",
					effort: res.a.effort,
					windowId: p.windowId,
					index: p.index,
					rep: 0,
					atSec: p.atSec,
					clock: p.clock,
					text,
					firstSyllableMs: res.speakableMs ?? null,
					firstTokenMs: res.ttftMs ?? null,
					completeMs: res.latencyMs,
					frameSent: res.frameSent,
					payload: res.payload,
					payloadChars: res.payload.length,
					usage: res.usage ?? null,
					costUsd: costOf(res.a.model, res.usage),
					identical: p.identical,
					error: res.ok ? null : (res.reason ?? "failed")
				})
			}
			const spoke = results.filter(r => r.ok && !isSilent((r.text ?? "").trim()) && !isEmpty((r.text ?? "").trim())).length
			process.stdout.write(`  ${p.clock} ${spoke}/${chosen.length} spoke\n`)
		}
	}

	const out: RaceRun = {
		ranAt: new Date().toISOString(),
		argv,
		level,
		note:
			"Socket and mock rows are REPLAYED from the socket-bake runs of 2026-09-18; the Gemini key " +
			"is out of prepaid credit and no socket could be opened today. Turn rows were spoken today " +
			"about the byte-identical payload, with each arm's own said-log spliced in.",
		arms: [
			{ id: "mock", provider: "mock", model: "", shape: "mock", effort: null, what: "the floor: the payload's first bullet", liveEligible: true },
			{ id: "incumbent", provider: "gemini-live", model: "models/gemini-3.1-flash-live-preview", shape: "socket", effort: null, what: "the shipped socket", liveEligible: true },
			{ id: "g38", provider: "gemini-live", model: "models/gemini-3.8-live", shape: "socket", effort: null, what: "socket-bake's winner", liveEligible: true },
			...chosen.map(a => ({ id: a.id, provider: a.provider, model: a.model, shape: "turn", effort: a.effort, what: a.what, liveEligible: a.liveEligible }))
		],
		windows,
		calls,
		records: calls.map(c => ({
			arm: c.arm,
			windowId: c.windowId,
			index: c.index,
			rep: c.rep,
			atSec: c.atSec,
			clock: c.clock,
			text: c.text,
			error: c.error,
			payload: c.payload
		}))
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
	const path = arg("out", `${DATA_DIR}/eval/model-race-${stamp}.json`)
	if (existsSync(path)) throw new Error(`${path} exists; stored runs are never overwritten`)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify(out, null, 1))
	console.log(`\nwrote ${path} — ${calls.length} lines across ${out.arms.length} arms and ${windows.length} games`)
	report(out, null)
}

/* ======================================================================= report */

const champions = championVocabulary().names

const rosterOf = (payload: string): string[] => {
	const roster = new Set<string>()
	for (const m of payload.matchAll(/^- ([A-Za-z' .]+) \((?:TOP|JUNGLE|MIDDLE|BOTTOM|UTILITY)/gm)) roster.add(m[1]!.trim())
	const me = /^YOU — ([A-Za-z' .]+),/m.exec(payload)
	if (me) roster.add(me[1]!.trim())
	const cp = /^ENEMY JUNGLER — ([A-Za-z' .]+),/m.exec(payload)
	if (cp) roster.add(cp[1]!.trim())
	return [...roster]
}

const pct = (k: number, n: number): string => {
	if (n === 0) return "    —      "
	const w = wilson(k, n)
	return `${String(Math.round((100 * k) / n)).padStart(3)}% [${String(Math.round(100 * w.lo)).padStart(2)}-${String(Math.round(100 * w.hi)).padStart(2)}]`
}

const med = (xs: readonly number[]): number | null => {
	const s = [...xs].sort((a, b) => a - b)
	return s.length === 0 ? null : s[Math.floor((s.length - 1) / 2)]!
}

/** McNemar's exact on the discordant pairs, two-sided. */
const mcnemar = (b: number, c: number): number => {
	const n = b + c
	if (n === 0) return 1
	const lc = (k: number): number => {
		let s = 0
		for (let i = 1; i <= k; i++) s += Math.log(i)
		return s
	}
	const p = (k: number): number => Math.exp(lc(n) - lc(k) - lc(n - k) - n * Math.log(2))
	const lo = Math.min(b, c)
	let tail = 0
	for (let k = 0; k <= lo; k++) tail += p(k)
	return Math.min(1, 2 * tail)
}

interface Verdicts {
	byId: Map<string, string>
}

const loadVerdicts = (path: string): Verdicts => {
	const j = JSON.parse(readFileSync(path, "utf8")) as {
		lines?: { arm: string; windowId: string; index: number; verdict: string }[]
	}
	const rows = j.lines ?? []
	const byId = new Map<string, string>()
	for (const r of rows) byId.set(`${r.arm}|${r.windowId}|${r.index}`, r.verdict)
	return { byId }
}

const report = (r: RaceRun, verdicts: Verdicts | null, identicalOnly = false): void => {
	const arms = r.arms.map(a => a.id).filter(id => r.calls.some(c => c.arm === id))
	const spokenOf = (c: RaceCall): boolean => c.error === null && !isEmpty(c.text) && !isSilent(c.text)
	const inScope = (c: RaceCall): boolean => !identicalOnly || c.identical

	console.log(
		`\n${"=".repeat(96)}\nTHE TABLE${identicalOnly ? " — BYTE-IDENTICAL-STATE TURNS ONLY" : ""} — ${r.windows.length} games, ` +
			`level ${r.level}, ${r.calls.filter(c => c.arm === arms[0] && inScope(c)).length} turns per arm\n`
	)
	console.log(
		"arm        shape   turns  spoke   useful          false           clock-bad  fab   1st syll  cost/game"
	)
	for (const id of arms) {
		const mine = r.calls.filter(c => c.arm === id && inScope(c))
		const spoke = mine.filter(spokenOf)
		const meta = r.arms.find(a => a.id === id)!
		let useful = 0
		let wrong = 0
		let judged = 0
		let clockBad = 0
		let fab = 0
		for (const c of spoke) {
			const v = verdicts?.byId.get(`${id}|${c.windowId}|${c.index}`)
			if (v !== undefined) {
				judged += 1
				if (v === "useful") useful += 1
				if (v === "false") wrong += 1
			}
			const m = mechanicalVerdict(clockClaims(c.text, readPayload(c.payload)))
			if (m === "contradicted" || m === "inversion-shaped") clockBad += 1
			/*
			 * FABRICATION faults only. `LineScore.faults` also carries the two WEAKNESS faults
			 * (`visible-only`, `no-alternative`), which are judgements about whether a true sentence
			 * was worth saying — counting them here would put the mock at 100% "fabrication" for
			 * reading the payload's own bullet aloud, which it did on the first test run.
			 */
			const s = scoreLine({ line: c.text, block: c.payload, roster: rosterOf(c.payload), champions })
			if (!s.silent && s.faults.some(f => FABRICATION_FAULTS.includes(f))) fab += 1
		}
		const games = r.windows.length
		const costs = mine.map(c => c.costUsd).filter((x): x is number => x !== null)
		const costGame = costs.length === 0 ? null : (costs.reduce((a, b) => a + b, 0) / games)
		const syll = med(spoke.map(c => c.firstSyllableMs).filter((x): x is number => x !== null))
		console.log(
			`${id.padEnd(10)} ${meta.shape.padEnd(7)} ${String(mine.length).padStart(5)}  ${String(spoke.length).padStart(4)}   ` +
				`${pct(useful, judged)}  ${pct(wrong, judged)}  ${pct(clockBad, spoke.length).slice(0, 5)}      ${pct(fab, spoke.length).slice(0, 5)} ` +
				`${syll === null ? "     —" : `${String(syll).padStart(5)}ms`}  ${costGame === null ? "     —" : `$${costGame.toFixed(4)}`}`
		)
	}

	if (verdicts === null) {
		console.log(`\nno verdicts joined — run scripts/judge-corpus.ts over this file and re-summarize with --judged`)
		return
	}

	/* -- paired, against each named baseline ---------------------------------- */
	const key = (c: RaceCall): string => `${c.windowId}|${c.index}`
	const usefulAt = (id: string): Map<string, boolean> => {
		const m = new Map<string, boolean>()
		for (const c of r.calls.filter(x => x.arm === id && inScope(x))) {
			const v = verdicts.byId.get(`${id}|${c.windowId}|${c.index}`)
			m.set(key(c), v === "useful")
		}
		return m
	}
	const falseAt = (id: string): Map<string, boolean> => {
		const m = new Map<string, boolean>()
		for (const c of r.calls.filter(x => x.arm === id && inScope(x))) {
			const v = verdicts.byId.get(`${id}|${c.windowId}|${c.index}`)
			m.set(key(c), v === "false")
		}
		return m
	}
	for (const base of vsArg.split(",").map(x => x.trim()).filter(x => x !== "" && arms.includes(x))) {
		console.log(
			`\nPAIRED AGAINST ${base.toUpperCase()} — McNemar's exact on the turns where exactly one of the two was\n` +
				`useful (or false). The counts are "arm ahead - ${base} ahead"; a pooled margin that is not\n` +
				`homogeneous across the two games is not a result about models.\n`
		)
		const baseU = usefulAt(base)
		const baseF = falseAt(base)
		for (const id of arms) {
			if (id === base) continue
			const u = usefulAt(id)
			const f = falseAt(id)
			let ub = 0
			let uc = 0
			let fb = 0
			let fc = 0
			for (const k of baseU.keys()) {
				if (u.get(k) === true && baseU.get(k) === false) ub += 1
				if (u.get(k) === false && baseU.get(k) === true) uc += 1
				if (f.get(k) === true && baseF.get(k) === false) fb += 1
				if (f.get(k) === false && baseF.get(k) === true) fc += 1
			}
			console.log(
				`${id.padEnd(10)} useful ${String(ub).padStart(3)}-${String(uc).padEnd(3)} p=${mcnemar(ub, uc).toFixed(4)}   ` +
					`false ${String(fb).padStart(3)}-${String(fc).padEnd(3)} p=${mcnemar(fb, fc).toFixed(4)}`
			)
		}
	}

	/* -- per game, because pooling hides a split ------------------------------ */
	console.log(`\nPER GAME (useful / false, of judged lines)\n`)
	for (const w of r.windows) {
		const row = arms.map(id => {
			const mine = r.calls.filter(c => c.arm === id && c.windowId === w.id && inScope(c) && spokenOf(c))
			let u = 0
			let f = 0
			let n = 0
			for (const c of mine) {
				const v = verdicts.byId.get(`${id}|${c.windowId}|${c.index}`)
				if (v === undefined) continue
				n += 1
				if (v === "useful") u += 1
				if (v === "false") f += 1
			}
			return `${id} ${u}/${f} of ${n}`
		})
		console.log(`  ${w.gameId} ${w.counterpart}: ${row.join(" · ")}`)
	}
}

/* ====================================================================== moments */

/**
 * The same instant, every arm, side by side — the comparison a rate cannot carry.
 *
 * A useful-rate says how often an arm was worth listening to and says nothing about WHAT it was
 * worth listening to, and the difference between two coaches at 18:02 of the Kayn game is a
 * paragraph, not a percentage point. Ordered by arm so the reading order is the same at every
 * moment, and the payload's own headline is printed above them so a reader can check every line
 * against the state rather than against the other lines.
 */
const printMoments = (r: RaceRun, clocks: readonly string[]): void => {
	for (const clock of clocks) {
		const here = r.calls.filter(c => c.clock === clock)
		if (here.length === 0) {
			console.log(`\n(no turn at ${clock})`)
			continue
		}
		const w = r.windows.find(x => x.id === here[0]!.windowId)
		console.log(`\n${"=".repeat(96)}\n${clock} — ${w?.gameId} Lillia vs ${w?.counterpart}${here[0]!.identical ? "" : "  [state differs between arms on this turn]"}`)
		const now = here[0]!.payload.split("\n").slice(1, 3).join(" ")
		console.log(`STATE: ${now.slice(0, 460)}`)
		for (const meta of r.arms) {
			const c = here.find(x => x.arm === meta.id)
			if (!c) continue
			const said = c.error !== null ? `ERROR ${c.error}` : isEmpty(c.text) || isSilent(c.text) ? "(PASS — said nothing)" : c.text
			console.log(`  ${meta.id.padEnd(10)} ${said}`)
		}
	}
}

/* ======================================================================== sheet */

const writeSheet = (path: string): void => {
	const r = JSON.parse(readFileSync(path, "utf8")) as RaceRun
	const lines: SheetLine[] = []
	const racing = new Set(r.arms.map(a => a.id))
	let n = 0
	for (const c of r.calls) {
		// The stored socket run carried two arms that are not in this race — `g38think`, disqualified
		// for speaking its own scratchpad, and `silent`, the incumbent benched without `speechConfig`.
		// They stay in the run file as data and they do not go on a sheet that asks him to choose.
		if (!racing.has(c.arm)) continue
		if (c.error !== null || isEmpty(c.text) || isSilent(c.text)) continue
		n += 1
		lines.push({
			id: `L${String(n).padStart(3, "0")}`,
			armKey: c.arm,
			clock: c.clock,
			atSec: c.atSec,
			text: c.text,
			latencyMs: c.completeMs,
			block: c.payload,
			offered: [],
			frameB64: null,
			windowId: c.windowId,
			skewMs: null
		})
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
	const storeKey = `model-race-${stamp}`
	const out = arg("out", `${DATA_DIR}/eval/model-race-sheet-${stamp}.html`)
	writeFileSync(
		out,
		renderSheet(lines, {
			title: "Seven coaches, the same two games. Which one do you want in your ear?",
			storeKey,
			note:
				"Every line below was said at the clock shown, about the payload shown. Seven different " +
				"architectures answered the SAME turns of the same two games — three of them are live " +
				"audio sockets, three are text models, one is no model at all. Which is which is not on " +
				"this page and is not recoverable from it. Grade what the line is worth to a jungler at " +
				"that instant."
		})
	)
	writeFileSync(out.replace(/\.html$/, "-key.json"), renderKey(lines, storeKey))
	console.log(`wrote ${out} (${lines.length} lines) and its key beside it`)
}

/* ========================================================================= main */

const main = async (): Promise<void> => {
	if (sheetPath !== "") {
		writeSheet(sheetPath)
		return
	}
	if (summarizePath !== "") {
		const r = JSON.parse(readFileSync(summarizePath, "utf8")) as RaceRun
		if (momentsArg !== "") {
			printMoments(r, momentsArg.split(",").map(x => x.trim()).filter(x => x !== ""))
			return
		}
		const v = judgedPath === "" ? null : loadVerdicts(judgedPath)
		report(r, v)
		if (v !== null && r.calls.some(c => !c.identical)) report(r, v, true)
		return
	}
	await run()
}

await main()
