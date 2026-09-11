/**
 * Stream one real game at every model at once, and time the answer.
 *
 * ## The question, in his words
 *
 * *"Provide a stream of data and screenshots to each available agent and measure the time it takes
 * for a response as well as what that response is, then I will go through and evaluate each so we
 * can figure out whether the bottleneck is the model or our infra."*
 *
 * That is one question with two halves, and this file is deliberately built so the halves cannot
 * contaminate each other:
 *
 *   - **the model's half** is measured here — the real `latencyMs` of a real call, and the words
 *     that came back, arm by arm, on byte-identical inputs;
 *   - **the infrastructure's half** is NOT measured here, and saying so is part of the instrument.
 *     The shipped coach waits `DEFAULT_TURN_MS` (20s, `src/web/lib/geminiLive.ts`) for the next
 *     beat that even LOOKS at the world, and `SPEAK_FLOOR_SEC` (45s, `src/analysis/speak-pace.ts`)
 *     suppresses the beat before the ground-truth fetch happens at all. Recon this session put the
 *     model plus the mouth at roughly 6-15 seconds against 45-65 seconds of waiting, i.e. about ten
 *     to one. Every latency this script prints is the SMALL term. A reader who takes a number from
 *     here and calls it the coach's response time has read half the budget.
 *
 * So this instrument's job is narrow and it should be read narrowly: *given that the coach is
 * finally allowed to speak, how long does each model take and what does it say?* If every arm is
 * fast and correct, the model was never the problem.
 *
 * ## What is held constant, and how
 *
 * ONE `buildStream` call produces the turns, and every arm replays that same array. So:
 *
 *   - **the block is byte-identical** across arms — it is `renderBlockForMode(state, mode)` plus
 *     the focus section, i.e. the shipped block, built by `scripts/lib/stream.ts` and never
 *     rebuilt per arm;
 *   - **the ranked list is the real one.** `state.unseen` comes from `buildFacts`, which keeps
 *     module-scoped memory, so `buildStream` steps the WHOLE sample stream from t=0 even when only
 *     a window is sent. A replay that starts in the middle is a different coach;
 *   - **the frame is the real one for that instant** — a journal frame paired to the sample by
 *     wall clock, not one screenshot reused for every state (which is what
 *     `scripts/bench-providers.ts` does, and why it cannot answer a question about the frame);
 *   - **the system prompt is not a parameter.** Every turn-based arm goes through `coachTurn` in
 *     `src/review/live-providers.ts`, where the prompt is built inside the function. Two arms
 *     therefore cannot have differed in prompt, only in model. The socket arm is handed
 *     `socketSystemPrompt({ mode, championKnowledge })`, which is what `routes/live.ts` hands the
 *     real socket — `liveCoachSystemPrompt` plus the pronunciation guide. It used to be handed the
 *     inner call alone, i.e. the app's prompt minus the respellings, and the coach duly said
 *     "Drave" for Draven on a graded run.
 *
 * ONE THING IS NOT HELD CONSTANT, and pretending otherwise would be the lie this file exists to
 * avoid: **the socket arm has a conversation thread and the turn arms have none.** `runSocketArm`
 * pushes all N turns into ONE WebSocket, because one socket per game is the shipped rule, so by
 * turn 8 Gemini Live has seen the seven previous blocks, the seven previous frames and its own
 * seven answers. `coachTurn` sends `messages: [ one user message ]` — every turn-based arm answers
 * cold. That is a difference other than the model and it lands squarely on `not-generic` and
 * `dup`: an arm that can see what it already said can avoid repeating itself and a stateless one
 * structurally cannot. The claim above is about the prompt's WORDING and nothing more. `printAxes`
 * repeats this warning under the table, next to the two columns it distorts, whenever a run holds
 * both shapes — a caveat only in a header is a caveat nobody reads beside the number.
 *
 * ## The arms
 *
 *   - **`mock`** is always in, and it is the control that decides whether anything else earned its
 *     bill. It calls nothing and speaks the block's first `- ` line verbatim — the ranker's top
 *     fact when there is one — so it is exactly what the coach would say if the model contributed
 *     zero. An arm that does not beat `mock` on the six axes is paying latency for nothing.
 *     Measured on the first run of this script: over the opening 72 seconds of `split-03` the
 *     ranked list is EMPTY on every turn, and the first `- ` line is then the focus section from
 *     his past reviews, so `mock` says a stale goal four times and scores `prioritised` 0/4. That
 *     is the control working, not the control broken.
 *   - **every turn-based provider with a key**, through `coachTurn`.
 *   - **`gemini-live`**, the SHIPPED path: a WebSocket, native audio read back through
 *     `outputAudioTranscription`, ONE socket for the whole window because one socket per game is
 *     the shipped rule (a socket spanning two games carries game one's roster into game two). Its
 *     transport is copied from `runGeminiLive` in `scripts/bench-providers.ts`; that duplication is
 *     sanctioned and explained there. What is NOT duplicated is the state building or the scoring.
 *   - **`<arm>+noframe`**, a blind twin of any arm, in the SAME run on the SAME blocks. The
 *     difference between an arm and its twin is the frame's entire contribution. `--no-frame`
 *     blinds every arm instead, for a whole text-only run.
 *
 * ## Two things this measures that are easy to misread
 *
 * 1. **`latencyMs` means different things on the two shapes.** For a turn-based arm it is the whole
 *    answer, and `speechSynthesis` cannot start until it lands, so it is additive with speech. For
 *    the socket it is send-to-`turnComplete`, which is the end of GENERATION — audio has been
 *    playing for most of it. Production has never timestamped the first PCM chunk, so no honest
 *    first-audio number exists to print, and this file prints none.
 * 2. **The last-syllable figure is model+mouth only.** `speechDurationSec` is a least-squares fit
 *    on 24 real Gemini TTS renders (R2 0.895, MAE 0.30s) and carries about +/-1s per line; the
 *    browser's `speechSynthesis` runs at `u.rate = 1.1` and has never been measured at all. Neither
 *    figure includes the cadence or the pace floor.
 *
 * ## Cost
 *
 * It prints the exact number of paid calls it is about to make and gives you a chance to see it
 * before the first one. `--arms mock` is completely free — no key, no socket, no network — so the
 * whole path (stream, turns, scoring, report, JSON, sheet) can be exercised without a bill.
 * `--concurrency` defaults to **1** and should stay there for any run whose latency you intend to
 * quote: a real game is sequential, and running four arms at once measures this machine's uplink
 * under self-inflicted queueing rather than four models.
 *
 * ## Usage
 *
 *     node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *       scripts/bench-stream.ts --list
 *     ... scripts/bench-stream.ts --window split-03 --arms mock --turns 6 --sheet
 *     ... scripts/bench-stream.ts --window latest --arms mock,gemini-http,anthropic --turns 12
 *
 *     --window <id|all|latest>   which paired frame+sample window to replay (default: latest)
 *     --list                     print the discovered windows and the arm keys, then exit
 *     --arms a,b,c               arm ids; `@mode` picks the architecture (`anthropic@trusted`),
 *                                suffix +noframe for a blind twin of the same arm
 *     --models provider=model,…  free text, as everywhere in this app
 *     --schedule events|timer    WHEN to ask. `events` (default) runs the shipped detector from
 *                                `src/analysis/live-events.ts`; `timer` is the old cadence, kept
 *                                runnable for comparison on one game
 *     --stride N                 under `events`, send every Nth due turn. COST ONLY — the skipped
 *                                turns are questions not asked, and their events ride the next turn
 *     --heartbeat SEC            floor under silence for the event schedule (default 90)
 *     --every SEC                turn cadence in game-clock seconds, `--schedule timer` only
 *     --turns N                  how many checkpoints to send (default 8 — cost discipline)
 *     --from SEC                 game clock to start sending at (the ranker is stepped from 0 regardless)
 *     --no-frame                 blind EVERY arm; the block only
 *     --no-read                  skip the minimap pre-pass, so no turn carries a position. What
 *                                every run before 2026-09-10 did; kept for comparison with those
 *     --require-frame            send ONLY checkpoints that have a paired frame (see below)
 *     --repeats N                replay the whole window N times per arm; each rep is scored as its
 *                                own transcript, so it measures variance, not more of the game
 *     --timeout MS               per-TURN liveness budget for the gemini-live socket (default 120000)
 *     --concurrency N            arms in parallel (default 1; see above before raising it)
 *     --sheet                    also write the blinded HTML grading sheet and its key
 *     --out <path>               where the run JSON goes (default data/eval/stream-<stamp>.json)
 *     --reveal <key> <verdicts>  print per-arm rates from a graded sheet, then exit
 *     --summarize <path>         re-print a stored run without calling anything
 *     --verbose                  print the block and the whole ranked list for every turn
 *
 * DO NOT run this while a game is in progress: it holds a Gemini Live socket, and the live coach
 * wants that socket.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname } from "node:path"
import { DATA_DIR } from "../src/shared/constants.ts"
import { buildStream, discoverWindows } from "./lib/stream.ts"
import { HEARTBEAT_SEC } from "../src/analysis/live-events.ts"
import { execFileSync } from "node:child_process"
import { jpegSize } from "./lib/stream.ts"
import {
	carryable,
	observationFrom,
	pictureFix,
	pictureLine,
	socketSystemPrompt,
	truthFromRaw
} from "../src/server/routes/live.ts"
import { minimapRect, pctOf } from "../src/review/frame-read.ts"
import type { FrameRead, FrameReadXY, FrameTruth } from "../src/review/frame-read.ts"
import { WATCH_EVERY_SEC, admit } from "../src/daemon/minimap-watch.ts"
import { FRAME_FRESH_SEC } from "../src/analysis/live-facts.ts"
import { DEFAULT_MAX_SKEW_MS, nearestSample } from "./lib/stream.ts"
import { readVerbatim } from "./e2e-real-game.ts"
import type { ReachPosition } from "../src/analysis/reach-live.ts"
import { TEAM_BLUE, TEAM_RED } from "../src/shared/constants.ts"
import type { Coarse } from "../src/review/frame-read.ts"
import type { FrameObservation } from "../src/analysis/live-facts.ts"
import type { TeamId, Zone } from "../src/shared/map.ts"
import { readMinimap } from "../src/review/read-minimap.ts"
import type { LiveAllGameData } from "../src/shared/schema/live.ts"
import type { PositionFix } from "../src/shared/live-brief.ts"
import type { BuiltStream, StreamTurn, StreamWindow } from "./lib/stream.ts"
import { renderKey, renderSheet, revealVerdicts } from "./lib/sheet.ts"
import type { SheetLine } from "./lib/sheet.ts"
import { PROVIDERS, coachTurn, providerById, providerKey } from "../src/review/live-providers.ts"
import type { ProviderId } from "../src/review/live-providers.ts"
import { GEMINI_LIVE_MODEL, geminiKey, mintGeminiToken } from "../src/review/gemini-live.ts"
import { DEFAULT_LIVE_COACH_MODE, liveCoachSystemPrompt } from "../src/shared/live-coach-mode.ts"
import { getSettings } from "../src/db/queries.ts"
import type { LiveCoachMode } from "../src/shared/live-coach-mode.ts"
import { liveChampionKnowledge } from "../src/review/live-coach-knowledge.ts"
import { fullKnowledge } from "../src/review/live-knowledge-full.ts"
import { AXES, clockOf, scoreTranscript } from "../src/analysis/useful.ts"
import type { Axis, TranscriptVerdict, UsefulInput } from "../src/analysis/useful.ts"
import { WINDOW_FLOOR_SEC, speechDurationSec, stateAt } from "../src/analysis/timeliness.ts"
import type { CoachState } from "../src/analysis/timeliness.ts"
import { separated, wilson } from "../src/analysis/coach-score.ts"
import type { Interval } from "../src/analysis/coach-score.ts"
import { buildBrief, buildDelta } from "../src/shared/live-brief.ts"
import { reachFromLive } from "../src/analysis/reach-live.ts"
import type { Reach } from "../src/analysis/reachability.ts"
import {
	newMemory,
	cpSeenAt,
	noteSaid,
	observe,
	renderGameSoFar,
	renderSaid
} from "../src/analysis/coach-memory.ts"
import type { MemoryState } from "../src/analysis/coach-memory.ts"

/* ================================================================== arguments */

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : fallback
}
/** The nth word after a flag, for the two-argument `--reveal`. */
const argN = (name: string, n: number): string => {
	const i = argv.indexOf(`--${name}`)
	const v = i >= 0 ? argv[i + 1 + n] : undefined
	return v !== undefined && !v.startsWith("--") ? v : ""
}
const has = (name: string): boolean => argv.includes(`--${name}`)

/**
 * `--no-beat` — read the minimap ONLY in front of a turn, the way this instrument did before the
 * journal-beat watcher existed.
 *
 * Kept, and not deleted, because it is the control for the supply change: every stored run before
 * `data/eval/stream-kayn-reach-20260910.json` was taken under it, and a comparison that cannot
 * reproduce the old supply cannot say what changing it did.
 */
const noBeat = has("no-beat")

/* ================================================================== the arms */

/**
 * An arm is a provider, a model, and whether it may see the picture.
 *
 * `+noframe` is a suffix rather than a separate flag so a blind twin can sit in the SAME run as its
 * sighted original, on the same stream, in the same order. Two runs on two days would differ in the
 * blocks (the ranker's memory), in the model version, and in the network — three variables for a
 * one-variable question.
 */
export interface Arm {
	/** What is printed and what goes in the key file: `anthropic`, or `anthropic+noframe`. */
	id: string
	provider: string
	model: string
	/**
	 * The ARCHITECTURE this arm is run under, from a `@mode` suffix (`anthropic@trusted`).
	 *
	 * Per-arm rather than per-run because the two architectures are the comparison now, and the one
	 * thing a run must not do is compare them across two days: different blocks, different model
	 * versions, different network. Each arm renders its OWN mode's text from the SAME replayed
	 * state, so the state is still held constant and only the architecture varies.
	 */
	mode: LiveCoachMode
	/** `socket` is gemini-live; everything else is a turn through `coachTurn`. */
	shape: "turn" | "socket"
	vision: boolean
	available: boolean
	unavailable: string
}

const GEMINI_LIVE = "gemini-live"

const armDefaultModel = (provider: string): string =>
	provider === GEMINI_LIVE ? GEMINI_LIVE_MODEL : (providerById(provider)?.defaultModel ?? "")

const armAvailability = (provider: string): { available: boolean; why: string } => {
	if (provider === GEMINI_LIVE)
		return geminiKey() === "" ?
			{ available: false, why: "no key in data/gemini.key" }
		:	{ available: true, why: "" }
	const p = providerById(provider)
	if (!p) return { available: false, why: `no provider called ${provider}` }
	return providerKey(p) === null ?
			{ available: false, why: `no key — put one in data/${p.keyFile}` }
		:	{ available: true, why: "" }
}

/** Every arm this machine could run right now, in the order the report prints them. */
const allArmIds = (): string[] => [
	"mock",
	...PROVIDERS.filter(p => p.id !== "mock" && providerKey(p) !== null).map(p => p.id),
	...(geminiKey() === "" ? [] : [GEMINI_LIVE])
]

const resolveArms = (
	spec: string,
	models: Map<string, string>,
	blindAll: boolean,
	runMode: LiveCoachMode
): Arm[] => {
	const ids = spec === "" ? allArmIds() : spec.split(",").map(s => s.trim()).filter(s => s !== "")
	// The control is not optional. Without it a table of four models has no zero on it, and "arm X
	// is the best" is a statement about a ranking with no floor.
	if (!ids.some(id => id.split("+")[0] === "mock")) ids.unshift("mock")
	return ids.map(id => {
		// `provider@mode+noframe`: the mode binds tighter than the blindfold, so it is split first.
		const [head = "", ...mods] = id.split("+")
		const [provider = "", modeText = ""] = head.split("@")
		const mode: LiveCoachMode =
			modeText === "trusted" || modeText === "cite-or-quiet" || modeText === "fenced" ?
				modeText
			:	runMode
		const blind = blindAll || mods.includes("noframe")
		const { available, why } = armAvailability(provider)
		return {
			id,
			mode,
			provider,
			model: models.get(provider) ?? armDefaultModel(provider),
			shape: provider === GEMINI_LIVE ? "socket" : "turn",
			vision: !blind,
			available,
			unavailable: why
		}
	})
}

/* ================================================================== records */

/**
 * One model call.
 *
 * `block` and `offered` are NOT copied in here. They belong to the turn, they are identical across
 * arms by construction, and duplicating a 1.5KB block once per arm per repeat is how a run file
 * becomes too big to keep. They are stored once per window in the JSON and joined on
 * `(windowId, index)`; `--summarize` does exactly that join, so a re-score still costs nothing.
 *
 * An `error` is DATA. A failed call keeps its row, its latency and its reason, and is counted as an
 * ERROR in every table — never as a silence, because a PASS is a considered decision not to speak
 * and a 429 is not.
 */
interface CallRecord {
	arm: string
	provider: string
	/** Echoed from the transport, so an answer can never be attributed to a model nobody asked for. */
	model: string
	windowId: string
	index: number
	rep: number
	atSec: number
	clock: string
	text: string
	latencyMs: number
	frameSent: boolean
	framePath: string | null
	skewMs: number | null
	error: string | null
	/** The client state when the last syllable would have landed — filled in after the call. */
	stateAtEnd: CoachState | null
	/**
	 * THE TEXT THIS TURN WAS ACTUALLY SENT, and what shape it was.
	 *
	 * Under `trusted` the payload is no longer a function of the turn alone: turn one is the full
	 * brief, every turn after it is a delta that carries what the coach has already SAID, and what
	 * it said depends on the model. So the run file cannot reconstruct the payload from
	 * `windows[].turns[].brief` any more — it has to store the bytes that went out, or a re-score
	 * is scoring a payload nobody sent. Null for arms that were handed the pre-rendered block.
	 */
	payload: string | null
	payloadChars: number | null
	payloadKind: "brief" | "delta" | "block" | null
}

const isSilence = (text: string): boolean => {
	const bare = text.replace(/[^A-Za-z]/g, "").toLowerCase()
	return bare === "" || bare === "pass"
}

/**
 * Strip what the TRANSPORT added, and nothing the model chose.
 *
 * The socket arm's text is an audio transcription, which structurally cannot contain markdown,
 * surrounding quotation marks or a `Coach:` prefix. A text model routinely emits one of them, and
 * the sheet writes the string straight into `textContent` — so a consistent pair of quotes or a
 * stray `**` is an ARM LABEL on a page whose entire purpose is that there is no arm label. A judge
 * does not need to name the model to group the cards; grouping is the thing being prevented.
 *
 * Deliberately narrow: surrounding quotes, markdown emphasis, a leading speaker label, collapsed
 * whitespace. No word is changed, no sentence is shortened, nothing is lowercased. The same
 * normaliser runs before SCORING as well as before the sheet, so the two never disagree about what
 * was said — a line the judge grades and a line `scoreLine` checks must be one line.
 */
const normalizeSpoken = (text: string): string => {
	let t = text.trim()
	t = t.replace(/^(?:coach|lillia|coach lillia|assistant)\s*[:\-–—]\s*/i, "")
	t = t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/(?<![*\w])\*(?!\s)([^*]+?)(?<!\s)\*(?![*\w])/g, "$1")
	t = t.replace(/\s+/g, " ").trim()
	// Only when the quotes wrap the WHOLE line; an internal quotation is the model's own.
	const wrapped = /^"([^"]*)"$/.exec(t) ?? /^'([^']*)'$/.exec(t) ?? /^“([^”]*)”$/.exec(t)
	if (wrapped) t = wrapped[1]!.trim()
	return t
}

/* ================================================================ transports */

/**
 * A live counter, on a terminal only.
 *
 * Piped into a file the `\r` form is a single unreadable line, and this script's output is a thing
 * he will redirect. Nothing measured depends on it.
 */
let progressing = false
const progress = (msg: string): void => {
	if (!process.stderr.isTTY) return
	progressing = true
	process.stderr.write(`\r  ${msg}`.padEnd(78))
}
const progressDone = (): void => {
	if (!progressing) return
	progressing = false
	process.stderr.write("\n")
}

/**
 * Every turn-based arm, through the app's own single path.
 *
 * `coachTurn` takes no system prompt, so this loop cannot have varied the wording between arms even
 * by accident. It also returns the REAL latency of the call it made, which is the number this whole
 * script exists to collect — not a stopwatch wrapped around it out here, which would fold this
 * script's own overhead into the model's figure.
 */
/**
 * The `trusted` PROTOCOL, replayed exactly as `routes/live.ts` serves it.
 *
 * This used to be one line — `arm.mode === "trusted" ? t.brief : t.block` — and that line is now a
 * benchmark of an architecture nobody ships. The route sends the full brief ONCE, at the top of a
 * sequence, and every turn after it is a `buildDelta` against the previous TURN, carrying a
 * `WHAT YOU HAVE ALREADY SAID THIS GAME` section built from the coach's own spoken lines. Sending
 * the full brief twelve times measures the thing that was replaced: 41% of it is byte-identical
 * turn to turn, and none of it remembers a word the model said.
 *
 * So the payload cannot be precomputed. It depends on lines the model has not spoken yet, which
 * makes it per-ARM state rather than per-turn state — two arms on one stream hold two memories,
 * because they said two different things. One of these is created per (arm, stream, rep).
 *
 * Four rules copied from the route rather than re-invented, because a bench that differs from the
 * shipped path in any of them is measuring a fourth architecture:
 *
 *   - `observe` sees EVERY sample, not only the checkpoints, so "since your last look" spans the
 *     gap rather than the last five seconds;
 *   - `previous` is the previous TURN, so the delta's SINCE block covers what he did between looks;
 *   - a gap over `RESYNC_AFTER_SEC` re-sends the full brief, because a thread that old has lost the
 *     roster. This comment used to claim it never fires at `--every 30`; the recorded `--every 30`
 *     run of 2026-09-09T22-02-18 fired it, at atSec 322.8 after a 48.75s hop, and produced two full
 *     briefs against the "1 is the healthy number" this code documents. The threshold has since
 *     been raised well clear of the slowest offered beat. It is counted and printed either way,
 *     because a run that silently sent twelve full briefs while reporting "deltas" is the same lie
 *     in the other direction.
 *
 * And the one thing the bench got WRONG about the shipped path, now fixed here: a TURN-BASED arm's
 * `tick` always calls `groundTruth({resync: true})` (`geminiLive.ts`, deliberately, with a comment),
 * so those providers receive a full brief on every single turn and never a delta. The bench used to
 * give every trusted arm the socket's sequence, which meant a provider comparison measured the
 * socket on one protocol and Anthropic/OpenAI/Kimi/GLM on another — exactly the confound
 * `coachTurn`'s single-path design exists to prevent.
 *
 * `where` AND `at` — the minimap read — are now REAL here, and that changed what this script can
 * answer. They used to be null: the read arrives in the app from the browser by
 * `POST /api/live/frame-read` and is a model call of its own, so the bench passed nothing and NOW
 * simply said less. That was tolerable while the read was decorative. It is not tolerable now that
 * the read is the thing under test — a run with `where: null` grades a coach that structurally
 * cannot use a position, and would have reported "the position work changed nothing" no matter what
 * the position work did.
 *
 * So `readWhere` below does what the DAEMON and the browser do between them: read the minimap off
 * the journal's own beat with `admit`'s cadence, land each accepted read through the SAME
 * `observationFrom` / `carryable` / `pictureLine` / `pictureFix` the route uses, and let a turn
 * fall through to its own read only when the track has nothing fresh — which is exactly what
 * `POST /api/live/frame-read` does now that `daemon/minimap-watch.ts` exists. The fence's refusals
 * are kept as refusals.
 */

/* ============================================================ the minimap read */

/** What one turn ends up knowing about where he is. Built by `readWhere` below. */
interface TurnWhere {
	where: string | null
	at: PositionFix | null
	/**
	 * The travel times, one per objective NEXT will render. Built from the SAME accepted read as
	 * `at`, so a turn whose read was refused carries neither — and a turn where he is DEAD carries
	 * reach anyway, because a fountain origin needs no read at all.
	 */
	reach: Reach[]
	/** For the report: what happened, per turn, whether or not it produced a line. */
	reason: string
	ms: number
}

const CROP_QUALITY = "3"

/**
 * THE JOURNAL BEAT, REPLAYED — the supply the shipped daemon has had since `minimap-watch.ts`,
 * which this instrument did not.
 *
 * `readWhere` used to take exactly one read per NON-REACTIVE turn and carry it forward. That was
 * the app's behaviour when it was written and it is not the app's behaviour now: the daemon reads
 * the minimap off the journal's own beat (`daemon/minimap-watch.ts`, floor `WATCH_EVERY_SEC`),
 * whether or not a turn is being taken, and a turn is served from that track when the freshest
 * accepted read is inside `FRAME_FRESH_SEC` of the crop it would otherwise have paid for.
 *
 * The gap between the two is not cosmetic, it is the whole position axis. Counted out of the
 * payloads stored in `data/eval/stream-kayn-reach-20260910.json`, the graded 28-turn run of game
 * 5639406342 carried a position on 10 turns and said "WHERE YOU ARE IS NOT IN THIS PAYLOAD" on 18.
 * Replaying that game's 340 real frames through the shipped reader and the shipped fence
 * (`scripts/minimap-watch-replay.ts`, stored as `data/eval/minimap-watch-replay-*.json`) and asking
 * those same 28 turn times how old their read would have been:
 *
 *                                     on-turn reads only        on the journal beat
 *     turns with a position             10 of 28  35.7%           27 of 28  96.4%
 *     median age of that read                  0-2s                       4.8s
 *     turns inside FRAME_FRESH_SEC       10 of 28  35.7%           16 of 28  57.1%
 *     turns inside CARRY_MAX_SEC         10 of 28  35.7%           22 of 28  78.6%
 *
 * So a run made without this measured a coach that structurally could not be told where he was on
 * two thirds of its turns — and the reach clause, which is the one join every line graded useful in
 * round 2 was built out of, appeared on 3 of 28 turns instead of nearly all of them. That is the
 * starved-harness failure this repo already named once for `bench-providers --from-samples`:
 * a comparison run on starved states measures improvisation, not coaching.
 *
 * ## What is replayed, and what is not
 *
 * - THE CADENCE IS `admit`, imported from the daemon rather than retyped, so the floor, the
 *   new-game reset and the backwards-clock rule are the shipped ones by construction.
 * - THE READER AND THE FENCE ARE `readMinimap`, on the same 4x lanczos crop of `minimapRect` at the
 *   same JPEG quality every accuracy figure in this repo was measured at. Refusals stay refusals.
 * - THE LANDING IS `observationFrom` -> `carryable`, in tSec order, exactly as `drainMinimapReads`
 *   lands the watcher's queue. Order is load-bearing: `observationFrom` doubts a read that
 *   disagrees with the one before it inside `FRAME_FRESH_SEC`, and at a four-second beat that test
 *   now actually fires, which it never did at one read a minute.
 * - THE TURN STILL FALLS THROUGH TO ITS OWN READ when the track has nothing inside
 *   `FRAME_FRESH_SEC` of this turn's frame, because `POST /api/live/frame-read` does exactly that
 *   rather than refusing. A reactive turn still skips it, as the app does.
 * - SINGLE-FLIGHT IS NOT SIMULATED. The daemon drops a frame that arrives while a read is out; the
 *   replay of this game at the shipped floor dropped none, because the floor is 4s and the reader's
 *   p50 is 1.2s. A machine slow enough to drop frames would have a sparser track than this, never
 *   a denser one.
 *
 * Reads are CACHED to disk by frame id. A re-run of the same window pays nothing, which is what
 * makes it affordable to re-grade a payload change against the same 339 reads rather than against
 * a fresh roll of a non-deterministic reader.
 */
interface BeatRead {
	frameId: string
	/** The FRAME's own game clock — the picture's, never the turn's. */
	tSec: number
	read: FrameRead | null
	xy: FrameReadXY | null
	reason: string
	ms: number
}

/** One accepted, landed read, in the two forms the brief and the arithmetic each need. */
interface Landed {
	atSec: number
	obs: FrameObservation
	zone: { you: Zone; enemies: Zone[] }
	pct: ReachPosition | null
}

const cropFrame = (framePath: string, cropPath: string): boolean => {
	try {
		if (existsSync(cropPath)) return true
		const size = jpegSize(readFileSync(framePath))
		if (size === null) return false
		const r = minimapRect(size.width, size.height)
		execFileSync("ffmpeg", [
			"-y", "-loglevel", "error", "-i", framePath,
			"-vf", `crop=${r.w}:${r.h}:${r.x}:${r.y},scale=${r.w * 4}:${r.h * 4}:flags=lanczos`,
			"-q:v", CROP_QUALITY, cropPath
		])
		return existsSync(cropPath)
	} catch {
		return false
	}
}

/**
 * Every frame the daemon would have read, read — in `admit`'s order, in a pool, cached on disk.
 *
 * The pool is safe where the schedule is not: `admit`'s only inputs are the game clock and the
 * session, so which frames get read is decided up front and sequentially, and only the model calls
 * are concurrent. Their results are re-sorted into tSec order before anything lands them, because
 * the landing rules are stateful and the reading is not.
 */
const readJournalBeat = async (
	stream: BuiltStream,
	cropDir: string,
	concurrency = 6
): Promise<BeatRead[]> => {
	const cachePath = `${DATA_DIR}/eval/bench-beat-${stream.window.id}.json`
	const cache = new Map<string, BeatRead>()
	if (existsSync(cachePath))
		for (const e of JSON.parse(readFileSync(cachePath, "utf8")) as BeatRead[]) cache.set(e.frameId, e)

	const samples = readVerbatim(stream.window.sampleFile)
	const frames = [...stream.window.frames].sort((a, b) => a.tSec - b.tSec)
	mkdirSync(cropDir, { recursive: true })

	const chosen: { frame: (typeof frames)[number]; truth: FrameTruth; cropPath: string }[] = []
	let lastReadSec: number | null = null
	let sessionId: string | null = null
	for (const f of frames) {
		const verdict = admit(
			{ enabled: true, inFlight: false, cooldownUntilMs: 0, lastReadSec, sessionId },
			{ tSec: f.tSec, sessionId: stream.window.id },
			Date.now()
		)
		if (verdict !== "read" && verdict !== "new-game") continue
		sessionId = stream.window.id
		/*
		 * NO TRUTH IS NO READ, and the clock still advances. The daemon fences every read against
		 * the poll that stamped the frame and refuses an unfenced one; a frame it could not fence
		 * is a frame it spent nothing on, and pretending it is still "due" would make the next one
		 * arrive early.
		 */
		const near = nearestSample(f.atMs, samples, DEFAULT_MAX_SKEW_MS)
		lastReadSec = f.tSec
		if (near === null) continue
		const cropPath = `${cropDir}/${f.id}-crop4x.jpg`
		if (!cache.has(f.id) && !cropFrame(f.path, cropPath)) continue
		chosen.push({
			frame: f,
			truth: truthFromRaw(near.sample.data as LiveAllGameData),
			cropPath
		})
	}

	const todo = chosen.filter(c => !cache.has(c.frame.id))
	if (todo.length > 0) {
		console.log(
			`  ${stream.window.id}: journal beat — ${chosen.length} frames due at ${WATCH_EVERY_SEC}s, ` +
				`${chosen.length - todo.length} cached, reading ${todo.length}`
		)
		let next = 0
		let done = 0
		await Promise.all(
			Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
				for (;;) {
					const i = next++
					if (i >= todo.length) return
					const c = todo[i]!
					const out = await readMinimap({
						jpegBase64: readFileSync(c.cropPath).toString("base64"),
						truth: c.truth
					})
					cache.set(c.frame.id, {
						frameId: c.frame.id,
						tSec: c.frame.tSec,
						read: out.read ?? null,
						xy: out.read === null ? null : out.xy,
						reason: out.read === null ? out.reason : "read",
						ms: out.ms
					})
					if (++done % 50 === 0) console.log(`    ${done}/${todo.length}`)
				}
			})
		)
		writeFileSync(cachePath, JSON.stringify([...cache.values()].sort((a, b) => a.tSec - b.tSec), null, "\t"))
	}
	return chosen.map(c => cache.get(c.frame.id)!).filter(e => e !== undefined).sort((a, b) => a.tSec - b.tSec)
}

/**
 * The daemon's job and the browser's, done here: the beat, then the turn, then the two things the
 * brief takes — the prose `where` and the structured `at`.
 *
 * Run as a PRE-PASS over the turns rather than inline, for one reason: every arm must be handed
 * byte-identical payloads, and a read done inside an arm's loop would give each arm its own roll of
 * a non-deterministic model. One supply, shared by every arm, so a difference between two arms is
 * still only the model under test.
 *
 * The stamp is always the FRAME's own game clock, which is the strongest form of the thing
 * `frameClockSec` approximates in the app: here the picture's clock is recorded, so there is
 * nothing to extrapolate.
 *
 * Refusals are kept as refusals. The fence threw away 43 of 101 reads on this game and was right to
 * — 16 of those were the model pointing at a red-ringed Singed inside his camera box — so a turn
 * with nothing accepted behind it gets `where: null` and the brief says it has no position, exactly
 * as the app does.
 */
const readWhere = async (
	stream: BuiltStream,
	cropDir: string
): Promise<Map<number, TurnWhere>> => {
	const out = new Map<number, TurnWhere>()
	mkdirSync(cropDir, { recursive: true })
	const beat = noBeat ? [] : await readJournalBeat(stream, cropDir)
	let bi = 0
	let lastSide: { where: Coarse | null; atSec: number } | null = null
	/*
	 * THE ROLLING LAST-KNOWN READ, carried here exactly as `server/routes/live.ts` carries it —
	 * `pictureLine` owns the ageing and the tense and `CARRY_MAX_SEC` owns the far edge, so there is
	 * no second copy of either rule here, only the memory. A REFUSAL does not displace it and does
	 * not clear it: a refusal is not evidence about where he was eleven seconds ago.
	 */
	/*
	 * A HOLDER RATHER THAN A `let`, only so the type survives. `land` below writes it from inside a
	 * closure; a bare `let` read straight afterwards narrows to the initialiser and the whole carry
	 * types as `never`. Nothing about the rule changes.
	 */
	const hold: { read: Landed | null } = { read: null }
	const held = (): Landed | null => hold.read
	/** `landRead`, without the module-scope globals: the doubt test, the fence, then the carry. */
	const land = (read: FrameRead, xy: FrameReadXY | null, atSec: number): void => {
		const obs = observationFrom(read, lastSide, atSec)
		lastSide = { where: obs.where, atSec: obs.atSec }
		const zone = read.you === null ? null : { you: read.you, enemies: [...read.enemiesOnMinimap] }
		if (!carryable(obs, zone) || zone === null) return
		/*
		 * The pct is CLEARED rather than left standing when this acceptance has no point of its own.
		 * A pct from the previous read paired with the new read's age would put a confident travel
		 * time on a position the app has already replaced — `landRead` has the same line.
		 */
		hold.read = { atSec, obs, zone, pct: xy?.you ? { pct: pctOf(xy.you), atSec } : null }
	}
	for (const t of stream.turns) {
		const raw = t.raw as LiveAllGameData
		const truth = truthFromRaw(raw)
		const mine = (raw.allPlayers ?? []).find(p => p.championName === truth.myChampion)
		const teamId: TeamId = mine?.team === "CHAOS" ? TEAM_RED : TEAM_BLUE
		/*
		 * Every beat read taken at or before this turn, landed in order — the drain, done here.
		 * Reads that arrive between two turns are landed at the second of them, which is when
		 * `drainMinimapReads()` runs in the app.
		 */
		while (bi < beat.length && beat[bi]!.tSec <= t.atSec) {
			const b = beat[bi]!
			bi++
			if (b.read !== null) land(b.read, b.xy, b.tSec)
		}
		/*
		 * CLAMPED INTO THE PAST, and only here. Frames arrive on the WALL clock and samples on the
		 * GAME clock, so a frame paired to a sample can sit a few tenths of a second AHEAD of it.
		 * `pictureLine` throws a future stamp away whole, which is right in the app — there a stamp
		 * in the future can only mean a PAUSED game — and impossible in a replay, so leaving it
		 * unclamped would silently delete reads for a reason that does not exist here.
		 */
		const frameSec = t.frame === null ? t.atSec : Math.min(t.frame.tSec, t.atSec)
		const before = held()
		const servedByWatch = before !== null && Math.abs(frameSec - before.atSec) <= FRAME_FRESH_SEC
		let ms = 0
		let took = ""
		/*
		 * THE TURN'S OWN READ, taken only when the track cannot serve it — `POST /live/frame-read`
		 * skips the model call when the watcher's freshest accepted read is inside
		 * `FRAME_FRESH_SEC` of the crop's own stamp, and FALLS THROUGH when it is not. A REACTIVE
		 * turn skips it either way: the app does not pay 1.2s in front of a turn whose premise is
		 * already 40% stale at one second.
		 */
		if (!servedByWatch && t.readMinimap && t.frame !== null) {
			const cropPath = `${cropDir}/${t.frame.id}-crop4x.jpg`
			if (cropFrame(t.frame.path, cropPath)) {
				const res = await readMinimap({
					jpegBase64: readFileSync(cropPath).toString("base64"),
					truth
				})
				ms = res.ms
				if (res.read === null) took = `turn read refused: ${res.reason}`
				else {
					land(res.read, res.xy, frameSec)
					took = "turn read accepted"
				}
			} else took = "turn read skipped: crop failed"
		} else if (servedByWatch) took = "served from the journal beat"
		else if (!t.readMinimap) took = "reactive turn — the app skips the read here"
		else took = "no paired frame"

		const now = held()
		const age = now === null ? null : Math.round(t.atSec - now.atSec)
		const where = now === null ? null : pictureLine(now.obs, t.atSec)
		const reason =
			now === null ? `${took}; nothing accepted yet this game`
			: where === null ?
				`${took}; carried read ${age}s old is ${now.obs.confidence === "low" ? "doubted" : "past CARRY_MAX_SEC"}`
			:	`${took}; ${age}s-old read of ${now.obs.where}`
		out.set(t.index, {
			where,
			at: where === null || now === null ? null : pictureFix(now.obs, now.zone, t.atSec, teamId),
			/*
			 * THE CARRIED READ'S OWN pct AND ITS OWN CLOCK. Not the turn's — the whole point of the
			 * drift rule is that an old read stops bounding the distance, and re-stamping it here
			 * would make a 136-second-old position quote a confident travel time. `buildReach`
			 * decides; this only supplies. A turn with NO position is still a reach question when he
			 * is dead: the origin is his fountain and the respawn clock is exact.
			 */
			reach: reachFromLive({
				raw,
				nowSec: t.atSec,
				read: where === null || now === null ? null : now.pct
			}),
			reason,
			ms
		})
	}
	return out
}


const RESYNC_AFTER_SEC = 90

export interface Protocol {
	/** The bytes for this turn, plus what shape they came out. */
	payload: (t: StreamTurn) => { text: string; kind: "brief" | "delta" | "block" }
	/** Feed back what the arm ACTUALLY said, so the next delta can carry it. */
	heard: (t: StreamTurn, text: string, latencyMs: number) => void
	/** How many turns went out as a full brief. 1 is the healthy number for a whole game. */
	resyncs: () => number
}

export const protocolFor = (
	arm: Arm,
	stream: BuiltStream,
	/**
	 * The minimap read per turn, from `readWhere`. Shared by every arm on purpose — one read per
	 * turn, so a difference between two arms is still only the model under test and never a second
	 * roll of the reader.
	 */
	wheres?: Map<number, TurnWhere>
): Protocol => {
	if (arm.mode !== "trusted")
		return {
			payload: t => ({ text: t.block, kind: "block" }),
			heard: () => {},
			resyncs: () => 0
		}

	/*
	 * A turn-based PROVIDER always resyncs, because the shipped `tick` always asks for one. Anything
	 * else here measures a protocol the app does not run.
	 *
	 * The mock is exempt: it is the harness control that echoes the payload back, so it has to be
	 * handed the same bytes as the socket arm it is a control FOR. A control on a different
	 * protocol is not a control.
	 */
	const alwaysFull = arm.shape === "turn" && arm.provider !== "mock"
	const samples = stream.samples ?? []
	let memory: MemoryState = newMemory()
	let previous: { raw: unknown; gameTimeSec: number } | null = null
	let cursor = 0
	let turnsSent = 0
	let lastAtSec = 0
	let fullBriefs = 0

	return {
		payload: t => {
			// Every sample up to and including this instant, so the memory watched the gap.
			while (cursor < samples.length && samples[cursor]!.gameTimeSec <= t.atSec) {
				const smp = samples[cursor]!
				memory = observe(memory, smp.raw, smp.gameTimeSec)
				cursor += 1
			}
			const full = alwaysFull || turnsSent === 0 || t.atSec - lastAtSec > RESYNC_AFTER_SEC
			const built =
				full ?
					buildBrief({
						raw: t.raw,
						gameTimeSec: t.atSec,
						previous,
						baseline: stream.baseline,
						// The route passes the read on BOTH branches, so this must too. A resync
						// that dropped the position would make the first turn of every arm — and
						// every turn of every turn-based arm, which always resyncs — the one turn
						// with no position, which is precisely the comparison this run is making.
						where: wheres?.get(t.index)?.where ?? null,
						at: wheres?.get(t.index)?.at ?? null,
						reach: wheres?.get(t.index)?.reach ?? null,
						counterpartSeenSec: cpSeenAt(memory),
						/*
						 * And when this memory STARTED watching, because a null age above has two
						 * opposite meanings. Without it `counterpartClause` reported the game clock
						 * as the age of its own ignorance — "his row has NEVER moved in 7m23s" after
						 * 43 seconds of watching, on a replay with the memory started at 400s.
						 */
						counterpartWatchedFromSec: memory.observedFrom,
						// The memory rides on the full path too, exactly as the route now sends it:
						// a resync happens because the thread is EMPTY, which is an argument for
						// more history rather than less. Without this a turn-based arm — which
						// resyncs every turn — would have no memory feature at all.
						said: renderSaid(memory, t.atSec).split("\n").slice(1),
						narrative: renderGameSoFar(memory, t.atSec, 380),
						// Every bullet of the 1,190-character feed-notes block is in TRUSTED_PROMPT,
						// which rides once in the socket's system instruction. The route drops it
						// here; so does this, or the bench pays for it and the app does not.
						feedNotes: false
					})
				:	buildDelta({
						raw: t.raw,
						gameTimeSec: t.atSec,
						previous,
						baseline: stream.baseline,
						where: wheres?.get(t.index)?.where ?? null,
						at: wheres?.get(t.index)?.at ?? null,
						reach: wheres?.get(t.index)?.reach ?? null,
						// How old his row is. Without it every turn asserts the counterpart's level
						// is current, which is how "two whole levels up on Kayn" was said at 2:06
						// about a one-level gap.
						counterpartSeenSec: cpSeenAt(memory),
						/*
						 * And when this memory STARTED watching, because a null age above has two
						 * opposite meanings. Without it `counterpartClause` reported the game clock
						 * as the age of its own ignorance — "his row has NEVER moved in 7m23s" after
						 * 43 seconds of watching, on a replay with the memory started at 400s.
						 */
						counterpartWatchedFromSec: memory.observedFrom,
						// The heading is dropped because `saidBlock` writes its own, exactly as the
						// route drops it. Two headings on one section is a payload difference.
						said: renderSaid(memory, t.atSec).split("\n").slice(1),
						narrative: renderGameSoFar(memory, t.atSec, 380)
					})
			previous = { raw: t.raw, gameTimeSec: t.atSec }
			if (!built) return { text: "", kind: full ? "brief" : "delta" }
			turnsSent += 1
			lastAtSec = t.atSec
			if (full) fullBriefs += 1
			return { text: built.text, kind: full ? "brief" : "delta" }
		},
		heard: (t, text, latencyMs) => {
			// A silence is not advice and the route does not log one: `noteSaid` is the record of
			// what he was TOLD, and an empty turn told him nothing.
			if (isSilence(text)) return
			memory = noteSaid(memory, text, t.atSec, latencyMs / 1000)
		},
		resyncs: () => fullBriefs
	}
}

const runTurnArm = async (
	arg: Arm,
	stream: BuiltStream,
	rep: number,
	mode: LiveCoachMode,
	wheres?: Map<number, TurnWhere>
): Promise<CallRecord[]> => {
	const arm = arg
	const out: CallRecord[] = []
	// A turn-based arm has no thread of its own, but it gets the SAME payloads a socket arm gets —
	// otherwise "trusted" would mean two different architectures depending on the transport.
	const proto = protocolFor(arm, stream, wheres)
	for (const t of stream.turns) {
		const sent = proto.payload(t)
		const r = await coachTurn({
			mode: arm.mode,
			provider: arm.provider as ProviderId,
			...(arm.model === "" ? {} : { model: arm.model }),
			...(arm.vision && t.frameB64 !== null ? { frameJpegBase64: t.frameB64 } : {}),
			blockText: sent.text,
			...(t.counterpart === null ? {} : { counterpart: t.counterpart }),
			champion: stream.window.champion
		})
		const text = normalizeSpoken(r.text)
		if (r.ok) proto.heard(t, text, r.latencyMs)
		out.push({
			arm: arm.id,
			provider: arm.provider,
			model: r.model,
			windowId: stream.window.id,
			index: t.index,
			rep,
			atSec: t.atSec,
			clock: t.clock,
			text,
			latencyMs: r.latencyMs,
			frameSent: r.frameSent,
			framePath: t.frame?.path ?? null,
			skewMs: t.skewMs,
			error: r.ok ? null : (r.reason ?? "provider failed"),
			stateAtEnd: null,
			payload: sent.text,
			payloadChars: sent.text.length,
			payloadKind: sent.kind
		})
		progress(`${arm.id} ${t.clock} ${sent.kind} ${sent.text.length}c ${r.ok ? `${r.latencyMs}ms` : "ERROR"}`)
	}
	progressDone()
	return out
}

/**
 * The SHIPPED path: one socket for the whole window, frame INSIDE the turn as `inlineData`.
 *
 * The transport shape is copied from `runGeminiLive` in `scripts/bench-providers.ts` and must not
 * be "tidied" into `realtimeInput.video`: measured over eight turns on one socket, streaming the
 * frame silenced the audio AND made the model name champions who were not on screen, 6/6 wrong. A
 * benchmark on the other shape would be scoring a path nothing runs.
 *
 * `latencyMs` here is send-to-`turnComplete` — the end of GENERATION. Audio has been arriving for
 * most of it, and nothing in production has ever timestamped the first PCM chunk, so this file does
 * not pretend to know when he started hearing the line.
 *
 * A socket that dies mid-window does not silently shorten the run: every turn it never reached is
 * written out as an errored row with the close reason, so the arm shows `err = n` rather than a
 * flattering short n.
 */
const runSocketArm = async (
	arm: Arm,
	stream: BuiltStream,
	rep: number,
	mode: LiveCoachMode,
	timeoutMs: number,
	wheres?: Map<number, TurnWhere>
): Promise<CallRecord[]> => {
	const proto = protocolFor(arm, stream, wheres)
	/** What each turn was actually sent, filled in by `next()` as the turn goes out. */
	const sentFor = new Map<number, { text: string; kind: "brief" | "delta" | "block" }>()
	const rowFor = (t: StreamTurn, text: string, latencyMs: number, frameSent: boolean, error: string | null): CallRecord => {
		const sent = sentFor.get(t.index) ?? null
		return {
			arm: arm.id,
			provider: arm.provider,
			model: arm.model,
			windowId: stream.window.id,
			index: t.index,
			rep,
			atSec: t.atSec,
			clock: t.clock,
			text,
			latencyMs,
			frameSent,
			framePath: t.frame?.path ?? null,
			skewMs: t.skewMs,
			error,
			stateAtEnd: null,
			// Null on a turn that was never sent — a socket that died before reaching it. An empty
			// string there would read as "we sent nothing", which is a different fact.
			payload: sent?.text ?? null,
			payloadChars: sent === null ? null : sent.text.length,
			payloadKind: sent?.kind ?? null
		}
	}

	const minted = await mintGeminiToken()
	if (!minted.ok) return stream.turns.map(t => rowFor(t, "", 0, false, minted.error))

	/*
	 * `trusted` gets the WHOLE champion markdown, and the enemy jungler's too, in the system
	 * instruction that rides ONCE at socket setup. The older modes keep `liveChampionKnowledge`,
	 * whose digit-stripped `(kind)` fragments are what they were measured on — changing that would
	 * break the byte-identical baseline this run exists to compare against. Sending the old
	 * fragments under `trusted` would have benched the new architecture on the old context, which
	 * is the one mistake that makes the whole comparison meaningless.
	 */
	/*
	 * `socketSystemPrompt`, NOT `liveCoachSystemPrompt` — the route wraps the latter with the
	 * pronunciation guide and the bench did not, so the socket arm was benched on a system prompt
	 * the app does not send. Measured: the route's prompt carries "Draven — say DRAY-ven" and the
	 * bench's carried nothing, and on the 23-turn event run the coach said "Drave and Lulu are low".
	 * A prompt difference between the bench and the app is the one confound this file's header
	 * promises does not exist, so it is closed here rather than footnoted.
	 */
	const system = socketSystemPrompt({
		mode,
		championKnowledge:
			mode === "trusted" ?
				fullKnowledge({
					champion: stream.window.champion,
					counterpart: stream.turns.find(t => t.counterpart !== null)?.counterpart ?? null
				})
			:	liveChampionKnowledge(stream.window.champion)
	})

	return await new Promise<CallRecord[]>(resolve => {
		const ws = new WebSocket(
			`${minted.value.wsUrl}?access_token=${encodeURIComponent(minted.value.token)}`
		)
		const out: CallRecord[] = []
		const queue = [...stream.turns]
		let current: { at: number; t: StreamTurn; frameSent: boolean } | null = null
		let partial = ""
		/** Audio parts seen on the CURRENT turn. See the turnComplete handler. */
		let audioParts = 0
		let done = false

		/*
		 * PER-TURN LIVENESS, not a whole-window budget.
		 *
		 * This was one `setTimeout` armed at socket open for all N turns, and `next()` is only ever
		 * called from a `turnComplete` — so a stall on turn 2 of 8 stopped the pump and the timer
		 * then wrote SEVEN error rows, including turns that were never sent. The arm that ate that
		 * inflated count is `gemini-live`, the shipped path this script exists to judge. The
		 * reference transport in `scripts/bench-providers.ts` scales the same timer by turn count;
		 * re-arming it is the same budget expressed as what it actually measures, which is one turn
		 * failing to come back. It is also CLEARED on both resolve paths: an un-cleared timer keeps
		 * the process alive for the balance of `--timeout` after the report, the JSON and the sheet
		 * are all written, which looks exactly like a run still calling models.
		 */
		let timer: ReturnType<typeof setTimeout> | null = null
		const armTimer = () => {
			if (timer !== null) clearTimeout(timer)
			timer = setTimeout(() => finish(`no answer within ${timeoutMs}ms on one turn`), timeoutMs)
		}
		const stopTimer = () => {
			if (timer !== null) clearTimeout(timer)
			timer = null
		}

		/** Fill in whatever never got asked, so a dead socket cannot shrink n unnoticed. */
		const finish = (reason: string | null) => {
			if (done) return
			done = true
			stopTimer()
			const answered = new Set(out.map(r => r.index))
			for (const t of stream.turns)
				if (!answered.has(t.index))
					out.push(rowFor(t, "", 0, false, reason ?? "socket closed before this turn"))
			out.sort((a, b) => a.index - b.index)
			try {
				ws.close()
			} catch {
				/* already closed */
			}
			resolve(out)
		}

		const next = () => {
			const t = queue.shift()
			if (t === undefined) {
				done = true
				stopTimer()
				try {
					ws.close(1000)
				} catch {
					/* already closed */
				}
				resolve(out)
				return
			}
			const frameSent = arm.vision && t.frameB64 !== null
			current = { at: Date.now(), t, frameSent }
			partial = ""
			audioParts = 0
			const sent = proto.payload(t)
			sentFor.set(t.index, sent)
			const parts: unknown[] = []
			if (frameSent) parts.push({ inlineData: { mimeType: "image/jpeg", data: t.frameB64 } })
			parts.push({ text: sent.text })
			ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts }], turnComplete: true } }))
			armTimer()
		}

		ws.onopen = () =>
			ws.send(
				JSON.stringify({
					setup: {
						model: arm.model === "" ? GEMINI_LIVE_MODEL : arm.model,
						generationConfig: { responseModalities: ["AUDIO"] },
						outputAudioTranscription: {},
						systemInstruction: { parts: [{ text: system }] }
					}
				})
			)

		ws.onmessage = async ev => {
			const m = JSON.parse(
				typeof ev.data === "string" ? ev.data : await (ev.data as Blob).text()
			) as {
				setupComplete?: unknown
				serverContent?: {
					turnComplete?: boolean
					outputTranscription?: { text?: string }
					modelTurn?: { parts?: { text?: string; inlineData?: { mimeType?: string } }[] }
				}
			}
			if (m.setupComplete) {
				next()
				return
			}
			const sc = m.serverContent
			if (!sc) return
			if (sc.outputTranscription?.text) partial += sc.outputTranscription.text
			for (const p of sc.modelTurn?.parts ?? []) {
				if (p.text) partial += p.text
				// Audio arriving is the coach SPEAKING. Counted so an empty transcript beside it can
				// be told apart from a considered silence — see the turnComplete branch.
				if (p.inlineData) audioParts += 1
			}
			if (sc.turnComplete && current) {
				const ms = Date.now() - current.at
				/*
				 * SPOKE-BUT-NO-TRANSCRIPT IS AN ERROR, NEVER A PASS.
				 *
				 * `isSilence("")` classifies an empty answer as a considered decision not to speak,
				 * which drops it out of every axis denominator and puts it in the `pass` column. A
				 * dropped `outputAudioTranscription` is not a decision — audio was generated and he
				 * would have HEARD it — and filing it as restraint makes the shipped arm look like
				 * the most disciplined coach in the run. This file's own record doc promises the
				 * opposite ("never as a silence, because a PASS is a considered decision not to
				 * speak and a 429 is not"); the same argument covers this.
				 */
				const dropped = partial.trim() === "" && audioParts > 0
				const spoken = normalizeSpoken(partial)
				/*
				 * THE MEMORY IS FED FROM THE TRANSCRIPT, and only when there is one.
				 *
				 * This is the whole point of the protocol: the next turn's delta carries what he was
				 * just told. A dropped transcript is an error row, and logging a blank as advice
				 * would put an empty bullet in every later payload.
				 */
				if (!dropped) proto.heard(current.t, spoken, ms)
				out.push(
					rowFor(
						current.t,
						spoken,
						ms,
						current.frameSent,
						dropped ? `audio produced (${audioParts} chunks), transcript empty` : null
					)
				)
				const sentKind = sentFor.get(current.t.index)
				progress(
					`${arm.id} ${current.t.clock} ${sentKind ? `${sentKind.kind} ${sentKind.text.length}c` : ""} ` +
						`${dropped ? "NO TRANSCRIPT" : `${ms}ms`}`
				)
				partial = ""
				audioParts = 0
				current = null
				next()
			}
		}
		ws.onerror = () => finish("socket error")
		ws.onclose = e => finish(e.code === 1000 ? null : `closed ${e.code}: ${String(e.reason).slice(0, 160)}`)
		// Until the first turn is sent the budget covers setup; `next()` re-arms it per turn after.
		armTimer()
	}).then(rows => {
		progressDone()
		return rows
	})
}

/* ================================================================== scoring */

/**
 * The six axes, per arm, delegated whole to `src/analysis/useful.ts`.
 *
 * Scored PER WINDOW and then summed, never pooled. `scoreTranscript` looks for near-duplicates
 * across the transcript it is given, and two lines from two different games are not a redundancy he
 * ever heard — pooling them would invent one.
 */
interface ArmScore {
	arm: Arm
	records: CallRecord[]
	perWindow: { windowId: string; verdict: TranscriptVerdict }[]
	axes: Record<Axis, Interval>
	hud: Interval
	nearDuplicate: Interval
	vague: Interval
	spoken: number
	silent: number
	errors: number
	attempted: number
}

const sumIntervals = (parts: readonly Interval[]): Interval =>
	wilson(
		parts.reduce((a, i) => a + i.k, 0),
		parts.reduce((a, i) => a + i.n, 0)
	)

/**
 * Records to scorer inputs, with the state attached IN THE LOOP where the record is in hand.
 *
 * The join used to be positional — `inputsFor(...).map((i, n) => ({ ...i, stateAtT: stateAt(states,
 * mine[n]!.atSec) }))` — while this function is allowed to drop a record whose `index` is not in
 * the turn map. One drop shifted every later line's `stateAtT`/`stateAtEnd` by one turn, silently,
 * and timeliness is the axis that most looks correct when it is wrong. It could not be triggered on
 * today's inputs; the failure mode is why it is not left to chance.
 *
 * `offered` is withheld on an empty ranked list under any non-`fenced` mode, and that is a fix
 * rather than a convenience. `scoreUsefulLine` scores `prioritised: "fail"` when nothing matched,
 * noting "the ranked list was EMPTY and it spoke anyway" — which is a violation under `fenced`,
 * where the block does say the correct answer is PASS, and is the OPPOSITE of the truth under
 * `cite-or-quiet`, where the block says in as many words that an empty list is a statement about
 * the app and not an instruction to be silent. On the default window every one of the 8 turns has
 * an empty list, so the headline read `prioritised 0/8 0%` for an arm that broke no rule. With no
 * ranking to obey the honest verdict is `unmeasured`, and `unmeasured` is never a pass, so nothing
 * is being flattered here — the axis simply leaves the denominator. Nothing else in
 * `scoreUsefulLine` reads `offered` when it is empty: `rankTakenOf` returns -1, `offer` is null,
 * and the premise falls through to the line's own text either way.
 */
const inputsFor = (
	records: readonly CallRecord[],
	turns: readonly StreamTurn[],
	me: string,
	mode: LiveCoachMode,
	states: readonly CoachState[]
): UsefulInput[] => {
	const byIndex = new Map(turns.map(t => [t.index, t]))
	const out: UsefulInput[] = []
	for (const r of records) {
		const t = byIndex.get(r.index)
		if (!t) continue
		/*
		 * `trusted` has NO ranked list at all — the whole architecture is that nothing tells the
		 * model what to say — so `prioritised` is structurally unmeasurable there, not failed.
		 * Withholding `offered` drops the axis out of the denominator and it reports `unmeasured`.
		 */
		const rankable = mode !== "trusted" && (t.offered.length > 0 || mode === "fenced")
		out.push({
			text: r.text,
			atSec: r.atSec,
			latencySec: r.latencyMs / 1000,
			...(rankable ? { offered: t.offered } : {}),
			/*
			 * WHAT THE MODEL WAS ALLOWED TO KNOW, which under `trusted` is no longer one string.
			 *
			 * The socket keeps a thread: turn one's full brief is still in it when turn nine's
			 * delta arrives, so a number from the brief is BACKED at turn nine even though the
			 * delta never restates it. Scoring a delta alone would fail an arm for citing something
			 * it was correctly told; scoring the full brief alone would ignore the sections only the
			 * delta has (what he did since the last look, what the coach already said). Both, then
			 * — `t.brief` is this same instant rendered whole, so it adds no fact from another time.
			 */
			block:
				mode !== "trusted" ? t.block
				: r.payload === null || r.payload === t.brief ? t.brief
				: `${t.brief}\n\n${r.payload}`,
			roster: t.roster,
			me,
			champions: t.roster,
			aliases: t.aliases,
			stateAtT: stateAt(states as CoachState[], r.atSec),
			stateAtEnd: r.stateAtEnd
		})
	}
	return out
}

/**
 * One transcript per (window, REPETITION), pooled through `sumIntervals` exactly as windows are.
 *
 * Pooling the repeats into one transcript destroyed the two axes this run exists to move.
 * `scoreTranscript` searches every OTHER line in the list it is given for a near-duplicate, and
 * `not-generic` fails on one — so at `--repeats 2` every line has an exact twin it never had inside
 * a game. Measured on two distinct, specific lines: one rep scores `not-generic 2/2, dup 0/2`; the
 * identical pair replayed as two reps scores `not-generic 0/4, dup 4/4`. A model that changed
 * nothing goes from 100% to 0%, and the floor is structural — at R reps no arm can score below
 * (R-1)/R on `dup`. A repetition is a separate sitting of the same game; he never heard rep 1 and
 * rep 2 in one transcript, so they are not each other's redundancy.
 */
const scoreArm = (
	arm: Arm,
	records: CallRecord[],
	streams: readonly BuiltStream[],
	statesByWindow: Map<string, CoachState[]>,
	mode: LiveCoachMode
): ArmScore => {
	const perWindow: { windowId: string; verdict: TranscriptVerdict }[] = []
	const reps = [...new Set(records.map(r => r.rep))].sort((a, b) => a - b)
	for (const s of streams)
		for (const rep of reps) {
			const mine = records.filter(
				r => r.windowId === s.window.id && r.rep === rep && r.error === null
			)
			if (mine.length === 0) continue
			const states = statesByWindow.get(s.window.id) ?? []
			perWindow.push({
				windowId: reps.length > 1 ? `${s.window.id}#r${rep + 1}` : s.window.id,
				verdict: scoreTranscript(inputsFor(mine, s.turns, s.window.champion, arm.mode, states))
			})
		}
	const axes = Object.fromEntries(
		AXES.map(a => [a, sumIntervals(perWindow.map(w => w.verdict.rates[a].interval))])
	) as Record<Axis, Interval>
	const ok = records.filter(r => r.error === null)
	return {
		arm,
		records,
		perWindow,
		axes,
		hud: sumIntervals(perWindow.map(w => w.verdict.hud.interval)),
		nearDuplicate: sumIntervals(perWindow.map(w => w.verdict.nearDuplicate.interval)),
		vague: sumIntervals(perWindow.map(w => w.verdict.vague.interval)),
		spoken: ok.filter(r => !isSilence(r.text)).length,
		silent: ok.filter(r => isSilence(r.text)).length,
		errors: records.length - ok.length,
		attempted: records.length
	}
}

/* =============================================================== formatting */

const pad = (s: string, w: number): string => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length))
const padL = (s: string, w: number): string => (s.length >= w ? s : " ".repeat(w - s.length) + s)
const pct = (i: Interval): string => (i.n === 0 ? "--" : `${(100 * i.p).toFixed(0)}%`)
const ci = (i: Interval): string => (i.n === 0 ? "" : `[${(100 * i.lo).toFixed(0)},${(100 * i.hi).toFixed(0)}]`)
const quantile = (xs: readonly number[], q: number): number =>
	xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]!

const wrap = (text: string, width: number, indent: string): string => {
	const rows: string[] = []
	let row = ""
	for (const w of text.split(/\s+/)) {
		if (row === "") row = w
		else if (`${row} ${w}`.length <= width) row = `${row} ${w}`
		else {
			rows.push(row)
			row = w
		}
	}
	if (row !== "") rows.push(row)
	return rows.map((r, i) => (i === 0 ? r : indent + r)).join("\n")
}

const RULE = "─".repeat(98)

/* ================================================================== report */

interface RunFile {
	ranAt: string
	argv: string[]
	/** The mode the block was rendered FOR. Not free text: it changes what an empty list means. */
	mode: LiveCoachMode
	/** "events" (the shipped detector) or "timer" (the old cadence). Absent on runs before 2026-09-10. */
	schedule?: "timer" | "events"
	stride?: number
	heartbeatSec?: number
	everySec: number
	fromSec: number
	turnsWanted: number
	repeats: number
	concurrency: number
	blindAll: boolean
	windows: {
		id: string
		gameId: string
		champion: string
		sampleFile: string
		medianSkewMs: number
		tSecFrom: number
		tSecTo: number
		baselineGames: number
		stepped: number
		/**
		 * Everything `buildStream` could not fix and therefore SAID. Kept in the file as well as
		 * printed: a caveat that lives only in a terminal buffer is a caveat that is gone by the
		 * time anyone reads the run back.
		 */
		warnings: string[]
		turns: {
			index: number
			atSec: number
			clock: string
			clockSource: string
			block: string
			offered: string[]
			roster: string[]
			aliases: string[]
			me: string
			framePath: string | null
			frameBytes: number | null
			skewMs: number | null
			/**
			 * Did THIS turn's block carry a farm baseline? Stored per turn because the corpus
			 * having one and the block using one are different facts, and reading the first as
			 * the second printed a false reassurance over a run where 8 of 8 blocks said
			 * "Farm baseline: NONE". Optional only for runs written before the field existed;
			 * `summarize` recovers it from the block text for those.
			 */
			paceInBlock?: boolean
			/** The same instant under `trusted`. Absent on runs written before briefs existed. */
			brief?: string
			/** Absent on a pre-brief run file; a re-score then loads no counterpart knowledge. */
			counterpart?: string | null
			sampleLine: number
			/** Why she was asked. Absent on a timer run and on any run file written before 2026-09-10. */
			why?: string | null
			readMinimap?: boolean
			kinds?: string[]
		}[]
		stateAtT: (CoachState | null)[]
	}[]
	arms: { id: string; provider: string; model: string; vision: boolean; shape: string; available: boolean; unavailable: string }[]
	records: CallRecord[]
}

/**
 * Did this turn's block carry a farm baseline?
 *
 * The stored flag when the run has one; otherwise read off the block, because the string
 * `live-state.ts` writes when `state.pace` is null is fixed and a run from before the field
 * existed is still checkable. Never assumed true.
 */
const paceInBlockOf = (t: RunFile["windows"][number]["turns"][number]): boolean =>
	typeof t.paceInBlock === "boolean" ? t.paceInBlock : !t.block.includes("Farm baseline: NONE")

/** 1. What was replayed. Printed first because every number below is conditional on it. */
const printWhat = (run: RunFile, arms: readonly Arm[], calls: number): void => {
	console.log(`\n${RULE}`)
	// A run's schedule is printed rather than assumed: "every 20s" over an event-driven run would
	// name a cadence that was never used.
	const how =
		run.schedule === "events" ?
			`events (hb ${run.heartbeatSec ?? HEARTBEAT_SEC}s${(run.stride ?? 1) > 1 ? `, stride ${run.stride}` : ""})`
		:	`every ${run.everySec}s`
	console.log(`bench-stream · ${run.windows.map(w => w.id).join(", ")} · mode ${run.mode} · ${how}`)
	console.log(RULE)
	for (const w of run.windows) {
		console.log(
			`\n  ${w.id}  game ${w.gameId}  ${w.champion}` +
				`\n    ${w.turns.length} turns ${clockOf(w.turns[0]?.atSec ?? 0)}–${clockOf(w.turns[w.turns.length - 1]?.atSec ?? 0)}` +
				` of a window covering ${clockOf(w.tSecFrom)}–${clockOf(w.tSecTo)}` +
				`\n    ${w.stepped} samples stepped through the ranker (its rate limiting is memory — a replay that skips turns is a different coach)` +
				`\n    frames: ${w.turns.filter(t => t.framePath !== null).length}/${w.turns.length} turns carry a real paired frame, median skew ${w.medianSkewMs}ms` +
				`\n    source: ${w.sampleFile}`
		)
		/*
		 * TWO SEPARATE FACTS, and printing the first as if it were the second is how this report
		 * once told a reader the farm axis had been exercised when it could not fire at all.
		 *
		 * `baselineGames` counts what `baselineDuring` found in the CORPUS. `paceInBlock` says
		 * whether the rendered BLOCK carried an average to compare against: `paceReading` returns
		 * null before `EARLIEST_PACE_SEC` (240s) outside a 10/14/20-minute checkpoint window, and
		 * `live-state.ts` then writes the literal string "Farm baseline: NONE". Both paired windows
		 * on disk end at 4:04 and 6:43, so nearly every turn this harness can produce is inside
		 * that dead zone — measured on the first real run, 20 corpus games and 8 of 8 blocks
		 * saying NONE, under a report that read "farm baseline from 20 earlier games".
		 */
		if (w.baselineGames === 0)
			console.log(
				`    !! NO FARM BASELINE (0 games of corpus). The two CS-versus-his-own-average rules` +
					`\n       CANNOT FIRE at all in this window, and they were most of the transcript he quit on.` +
					`\n       Nothing below says anything about them.`
			)
		const withPace = w.turns.filter(paceInBlockOf).length
		console.log(
			`    farm baseline present in ${withPace} of ${w.turns.length} turn blocks (corpus: ${w.baselineGames} earlier game${w.baselineGames === 1 ? "" : "s"})`
		)
		if (withPace < w.turns.length)
			console.log(
				`    !! the two CS-versus-his-own-average rules COULD NOT FIRE on ${w.turns.length - withPace} of those turns.` +
					`\n       Nothing below is evidence about them; a quiet arm there did not decline the baseline.` +
					// The long form lives in `RunFile.warnings` for runs written since `buildStream`
					// started emitting it, and is printed by the loop below. An older run has only
					// this line, so the reason goes here rather than pointing at a warning that
					// is not in the file.
					(w.warnings.some(x => x.includes("Farm baseline: NONE")) ?
						`\n       (Why, in full, in the stored warning below.)`
					:	`\n       \`paceReading\` returns null before 4:00 outside a 10/14/20-minute checkpoint` +
						`\n       window, so the block carried no average regardless of the corpus.`)
			)
		/*
		 * `buildStream` warns about what it could not repair, and the loudest one only fires on the
		 * SECOND window of a `--window all` run: `fights.ts` keys its announce-once set on
		 * `fight@<gameClockSecond>` at module scope, and nothing outside `routes/live.ts` can reset
		 * it, so a fight at 6:12 of window two is silently suppressed by a fight at 6:12 of window
		 * one. Swallowing that would make an arm look quiet when the harness was the quiet one.
		 */
		for (const warning of w.warnings)
			console.log(
				`    !! ${warning
					.split("\n")
					.join(" ")
					.replace(/(.{1,92})(\s|$)/g, "$1\n       ")
					.trimEnd()}`
			)
	}
	console.log(`\n  arms (${arms.length}):`)
	for (const a of arms)
		console.log(
			`    ${pad(a.id, 22)}${pad(a.model || "(provider default)", 34)}${pad(a.shape, 8)}${pad(a.vision ? "frame" : "BLIND", 7)}` +
				(a.available ? "" : `SKIPPED — ${a.unavailable}`)
		)
	if (arms.some(a => !a.vision) && arms.some(a => a.vision)) {
		const framed = run.windows.reduce((a, w) => a + w.turns.filter(t => t.framePath !== null).length, 0)
		const all = run.windows.reduce((a, w) => a + w.turns.length, 0)
		console.log(
			`\n  sighted/blind twins are in this run: the frame's contribution can only show on the ${framed} of ${all}` +
				`\n  turns that carry one. On the other ${all - framed} the sighted arm sends no image either, so its request` +
				`\n  is byte-identical to the twin's and the difference there is zero by construction.` +
				(framed === all ? "" : `\n  Pass --require-frame to send only turns that have a frame.`)
		)
	}
	console.log(
		`\n  ${calls} paid model calls (mock and unavailable arms excluded), concurrency ${run.concurrency}` +
			(run.concurrency > 1 ?
				`\n  !! concurrency > 1: latencies below are measured under self-inflicted queueing and are NOT quotable.`
			:	"")
	)
}

/**
 * What an empty ranked list MEANS depends on the mode, and getting this line wrong would libel
 * every arm in the run.
 *
 * Under `fenced` the block itself says "the correct answer is PASS", so a spoken line on an empty
 * turn is the coach ignoring its instructions. Under `cite-or-quiet` — the shipped default — the
 * block says the OPPOSITE in as many words ("that is a statement about the app, not an instruction
 * to be silent"), because on the 39 states where the list was empty the fenced coach spoke 0 times
 * and cite-or-quiet spoke 35, 91% useful and 0 fabricated. Printing "the answer is PASS" over a
 * cite-or-quiet run reads every one of those 35 as a violation.
 */
const emptyListMeans = (mode: LiveCoachMode): string =>
	mode === "fenced" ?
		" — the fenced block says the correct answer is PASS"
	: mode === "trusted" ?
		" — trusted HAS no ranked list by design, so `prioritised` is unmeasured, never failed"
	:	" — cite-or-quiet does NOT make this a PASS: the block invites a line from the block itself"

/** 2. THE LINES. First, and in full, because every bug this catches survived a green percentage. */
const printLines = (run: RunFile, scores: readonly ArmScore[], verbose: boolean): void => {
	console.log(`\n${RULE}\nTHE LINES — the same instant, every arm, side by side\n${RULE}`)
	const width = Math.max(...scores.map(s => s.arm.id.length), 8)
	for (const w of run.windows) {
		if (run.windows.length > 1) console.log(`\n### ${w.id}`)
		for (const t of w.turns) {
			console.log(
				`\n  ${t.clock}  ${t.framePath === null ? "no frame" : `frame ${t.skewMs}ms off`}` +
					`  ·  ${t.offered.length} ranked fact${t.offered.length === 1 ? "" : "s"}` +
					(t.offered.length === 0 ? emptyListMeans(run.mode)
					:	`, top: ${t.offered[0]!.slice(0, 72)}`)
			)
			if (verbose) {
				for (const [n, f] of t.offered.entries()) console.log(`      ${n + 1}. ${f}`)
				console.log(t.block.split("\n").map(l => `      | ${l}`).join("\n"))
			}
			for (const s of scores)
				for (const r of s.records.filter(x => x.windowId === w.id && x.index === t.index)) {
					const tag =
						r.error !== null ? `ERROR ${r.error.slice(0, 60)}`
						: isSilence(r.text) ? "(pass)"
						: `"${wrap(r.text, 84, " ".repeat(width + 16))}"`
					console.log(`    ${pad(s.arm.id, width)} ${padL(`${r.latencyMs}ms`, 8)}${r.rep > 0 ? ` r${r.rep + 1}` : "   "} ${tag}`)
				}
		}
	}
}

/**
 * 3. Latency, and the number that actually matters.
 *
 * `lag` is when the LAST SYLLABLE lands, relative to the state the line describes: the real measured
 * latency plus `speechDurationSec`. It is the model's half of the delay and nothing else — it does
 * not include the 20s turn cadence or the 45s pace floor, both of which sit in front of it in the
 * shipped app and together dwarf it. The two thresholds are the repo's own: `WINDOW_FLOOR_SEC` is
 * the shortest window this codebase thinks is worth naming, and the cadence is how long the coach
 * waits before it looks again.
 */
const printLatency = (scores: readonly ArmScore[], everySec: number): void => {
	console.log(`\n${RULE}\nLATENCY — the model's half of the delay, and only that\n${RULE}\n`)
	/*
	 * TWO DENOMINATORS, BOTH PRINTED.
	 *
	 * `calls` is every non-errored call; `spoke` is the subset that produced a line. The three lag
	 * figures are over `spoke` — a pass has no last syllable — and printing them beside a bare
	 * `n` of calls made an arm that answered 8 times and passed on 5 read as ">10s on 33% of 8"
	 * when the rate was over 3. This is the one table in the file that used to print a percentage
	 * with neither an n nor an interval beside it.
	 */
	console.log(
		`  ${pad("arm", 22)}${padL("calls", 6)}${padL("spoke", 6)}${padL("p50", 8)}${padL("p90", 8)}${padL("p95", 8)}${padL("max", 8)}` +
			`${padL("lag p50", 9)}${padL(`>${WINDOW_FLOOR_SEC}s`, 8)}${padL(`>${everySec}s`, 8)}`
	)
	for (const s of scores) {
		const ok = s.records.filter(r => r.error === null)
		const ms = ok.map(r => r.latencyMs)
		const lags = ok
			.filter(r => !isSilence(r.text))
			.map(r => r.latencyMs / 1000 + speechDurationSec(r.text))
		const over = (n: number): string =>
			lags.length === 0 ? "--" : `${Math.round((100 * lags.filter(l => l > n).length) / lags.length)}%`
		console.log(
			`  ${pad(s.arm.id, 22)}${padL(String(ms.length), 6)}${padL(String(lags.length), 6)}${padL(String(quantile(ms, 0.5)), 8)}${padL(String(quantile(ms, 0.9)), 8)}` +
				`${padL(String(quantile(ms, 0.95)), 8)}${padL(String(ms.length === 0 ? 0 : Math.max(...ms)), 8)}` +
				`${padL(lags.length === 0 ? "--" : `${quantile(lags, 0.5).toFixed(1)}s`, 9)}${padL(over(WINDOW_FLOOR_SEC), 8)}${padL(over(everySec), 8)}`
		)
	}
	console.log(
		`\n  "calls" is every call that did not error; "spoke" is the subset that produced a line, and the` +
			`\n  three lag columns are rates over SPOKE, not over calls.` +
			`\n  p50/p90/p95/max are milliseconds of REAL measured call latency. "lag" adds the time to say the` +
			`\n  line (speechDurationSec: a fit on 24 Gemini TTS renders, R2 0.895, MAE 0.30s, so ±1s a line —` +
			`\n  and the browser's speechSynthesis rate of 1.1 has never been measured at all).` +
			`\n  For a turn-based arm latency is the WHOLE answer and speech cannot start until it lands, so the` +
			`\n  two are additive. For the socket it is send-to-turnComplete, the end of GENERATION: audio has` +
			`\n  been playing for most of it, and production has never timestamped the first PCM chunk.` +
			`\n  NONE of this includes the shipped 20s turn cadence or the 45s pace floor in front of it.`
	)
}

/**
 * 3b. THE PAYLOAD — what each turn actually cost, in bytes.
 *
 * Printed because the delta protocol's entire claim is a smaller per-turn payload with more in it,
 * and a run that quietly sent twelve full briefs (a `--every` above `RESYNC_AFTER_SEC`, or an arm
 * that is not `trusted`) would otherwise print tables identical to one that did the new thing. A
 * number nobody can see is a number nobody can check.
 */
const printPayload = (scores: readonly ArmScore[]): void => {
	const rows = scores.filter(s => s.records.some(r => r.payloadChars !== null))
	if (rows.length === 0) return
	console.log(`\n${RULE}\nPAYLOAD — what went out per turn\n${RULE}\n`)
	console.log(
		`  ${pad("arm", 22)}${padL("turns", 7)}${padL("brief", 7)}${padL("delta", 7)}${padL("min", 8)}${padL("p50", 8)}${padL("max", 8)}${padL("total", 9)}`
	)
	for (const s of rows) {
		const sent = s.records.filter(r => r.payloadChars !== null)
		const chars = sent.map(r => r.payloadChars!)
		const briefs = sent.filter(r => r.payloadKind === "brief").length
		const deltas = sent.filter(r => r.payloadKind === "delta").length
		console.log(
			`  ${pad(s.arm.id, 22)}${padL(String(sent.length), 7)}${padL(String(briefs), 7)}${padL(String(deltas), 7)}` +
				`${padL(String(Math.min(...chars)), 8)}${padL(String(quantile(chars, 0.5)), 8)}${padL(String(Math.max(...chars)), 8)}` +
				`${padL(String(chars.reduce((a, b) => a + b, 0)), 9)}`
		)
	}
	console.log(
		`\n  One "brief" per arm is the healthy count: the full brief opens the sequence and every turn` +
			`\n  after it is a delta. More than one means a resync fired — a gap over ${RESYNC_AFTER_SEC}s of game` +
			`\n  clock, which at --every ${RESYNC_AFTER_SEC + 1} or above happens on EVERY turn and quietly restores` +
			`\n  the architecture this protocol replaced.`
	)
}

/**
 * 4. The six axes, with n, Wilson intervals, and an explicit refusal to call a tie.
 *
 * Two things a reader will otherwise mis-attribute to the model, both printed under the table:
 *
 *   - **the socket arm has MEMORY and the turn arms do not.** `runSocketArm` opens one WebSocket
 *     and pushes every turn into it, because one socket per game is the shipped rule — so by turn
 *     8 Gemini Live has seen the seven previous blocks, the seven previous frames and its own
 *     seven answers. `coachTurn` sends `messages: [ one user message ]` with no history at all.
 *     The header's claim that two arms "cannot have differed in prompt, only in model" is true of
 *     the prompt WORDING and of nothing else: an arm that can see what it already said can avoid
 *     repeating itself, and a stateless arm structurally cannot. `dup` and `not-generic` are the
 *     two columns that lands on, and they are exactly the columns this run exists to move.
 *   - **`prioritised` is not measurable on an empty ranked list under `cite-or-quiet`.** The block
 *     says in as many words that an empty list is a statement about the app rather than an
 *     instruction to be silent, so there is no ranking to obey and `inputsFor` withholds the list;
 *     the axis reports `unmeasured`, which is never a pass. The count of such turns is printed so
 *     nobody reads the shrunken n as arms declining to answer.
 */
const printAxes = (scores: readonly ArmScore[], run: RunFile): void => {
	console.log(`\n${RULE}\nTHE SIX AXES — is the line useful, not merely true\n${RULE}\n`)
	console.log(
		`  ${pad("arm", 22)}${AXES.map(a => pad(a, 15)).join("")}${pad("hud", 11)}${pad("dup", 11)}${pad("vague", 11)}`
	)
	for (const s of scores)
		console.log(
			`  ${pad(s.arm.id, 22)}` +
				AXES.map(a => pad(`${s.axes[a].k}/${s.axes[a].n} ${pct(s.axes[a])}`, 15)).join("") +
				pad(`${s.hud.k}/${s.hud.n} ${pct(s.hud)}`, 11) +
				pad(`${s.nearDuplicate.k}/${s.nearDuplicate.n} ${pct(s.nearDuplicate)}`, 11) +
				pad(`${s.vague.k}/${s.vague.n} ${pct(s.vague)}`, 11)
		)
	console.log(
		`\n  A PASS is a considered silence and is not in any denominator. hud/dup/vague are FAULT rates` +
			`\n  (lower is better); the six axes are PASS rates (higher is better).`
	)
	const emptyTurns = run.windows.reduce((a, w) => a + w.turns.filter(t => t.offered.length === 0).length, 0)
	const allTurns = run.windows.reduce((a, w) => a + w.turns.length, 0)
	if (emptyTurns > 0)
		console.log(
			`\n  !! ${emptyTurns} of ${allTurns} turns offered an EMPTY ranked list${emptyListMeans(run.mode)}.` +
				(run.mode === "fenced" ?
					`\n     Under \`fenced\` a line spoken there IS a violation, so those turns count on \`prioritised\`.`
				:	`\n     There is no ranking to obey on those turns, so \`prioritised\` reports \`unmeasured\` for` +
					`\n     them and they leave its denominator. \`unmeasured\` is never scored as a pass.`)
		)
	if (scores.some(s => s.arm.shape === "socket") && scores.some(s => s.arm.shape === "turn"))
		console.log(
			`\n  !! THE ARMS DO NOT ALL HAVE THE SAME MEMORY, and it lands on \`not-generic\` and \`dup\`.` +
				`\n     The socket arm (gemini-live) answers turn N with all N-1 earlier blocks, frames and its own` +
				`\n     answers still in the thread — one socket per game is the shipped rule. Every turn-based arm` +
				`\n     answers each turn COLD: \`coachTurn\` sends one user message and no history. An arm that can` +
				`\n     see what it already said can avoid repeating itself; a stateless one cannot. Read a gap on` +
				`\n     those two columns as memory before reading it as model.`
		)
	if (scores.length > 0 && scores[0]!.perWindow.length > 0)
		for (const a of AXES)
			console.log(`  ${pad(a, 15)}${scores[0]!.perWindow[0]!.verdict.rates[a].meaning}`)

	console.log(`\n  95% Wilson intervals, and what separates:\n`)
	for (const a of AXES) {
		const usable = scores.filter(s => s.axes[a].n > 0)
		const pairs: string[] = []
		for (let i = 0; i < usable.length; i++)
			for (let j = i + 1; j < usable.length; j++) {
				const x = usable[i]!
				const y = usable[j]!
				if (!separated(x.axes[a], y.axes[a])) continue
				const [hi, lo] = x.axes[a].p > y.axes[a].p ? [x, y] : [y, x]
				pairs.push(`${hi.arm.id} (${pct(hi.axes[a])}) > ${lo.arm.id} (${pct(lo.axes[a])})`)
			}
		console.log(
			`  ${pad(a, 15)}${usable.map(s => `${s.arm.id} ${pct(s.axes[a])}${ci(s.axes[a])}`).join("  ")}`
		)
		/*
		 * THREE DIFFERENT NEGATIVE RESULTS, AND THEY ARE NOT THE SAME SENTENCE.
		 *
		 * "not distinguishable" is a finding about the ARMS; "nothing could be checked" is a
		 * finding about the INSTRUMENT; "one arm" is a finding about the RUN. This branch used to
		 * print the first for all three, so a `timely 0/0 --` axis on a one-arm mock run read
		 * `NOT DISTINGUISHABLE: every interval overlaps at n = .` — asserting that intervals
		 * overlap when there were no intervals, with an empty n list as the only clue. The rule
		 * `useful.ts` states for `unmeasured` is that it is never a pass; the same rule says an
		 * unmeasurable axis is never a tie.
		 */
		console.log(
			usable.length === 0 ?
				`  ${" ".repeat(15)}→ NOT MEASURED: no line on any arm could be checked on this axis (n = 0). This says nothing about the arms.`
			: usable.length === 1 ?
				`  ${" ".repeat(15)}→ ONLY ONE ARM has a measurable line here (${usable[0]!.arm.id}, n = ${usable[0]!.axes[a].n}) — nothing to compare it with.`
			: pairs.length === 0 ?
				`  ${" ".repeat(15)}→ NOT DISTINGUISHABLE: every interval overlaps at n = ${usable.map(s => s.axes[a].n).join("/")}. Do not report a winner.`
			:	`  ${" ".repeat(15)}→ ${pairs.join(" · ")}`
		)
	}
}

/** 5. Errors and silences. An error is not a silence and must never be scored as one. */
const printFailures = (scores: readonly ArmScore[]): void => {
	console.log(`\n${RULE}\nERRORS AND SILENCES\n${RULE}\n`)
	console.log(`  ${pad("arm", 22)}${padL("calls", 7)}${padL("spoke", 7)}${padL("pass", 7)}${padL("error", 7)}`)
	for (const s of scores)
		console.log(
			`  ${pad(s.arm.id, 22)}${padL(String(s.attempted), 7)}${padL(String(s.spoken), 7)}${padL(String(s.silent), 7)}${padL(String(s.errors), 7)}`
		)
	for (const s of scores) {
		const errs = s.records.filter(r => r.error !== null)
		if (errs.length === 0) continue
		console.log(`\n  ${s.arm.id}:`)
		const seen = new Map<string, number>()
		for (const e of errs) seen.set(e.error!, (seen.get(e.error!) ?? 0) + 1)
		for (const [msg, n] of seen) console.log(`    ${padL(`${n}x`, 5)} ${msg.slice(0, 120)}`)
	}
	console.log(
		`\n  "pass" is the coach declining to speak. Under \`fenced\` an empty ranked list makes that the` +
		`\n  prescribed answer; under \`cite-or-quiet\` it does not, so a pass there is the model's own call.` +
			`\n  "error" is a call that failed. They are counted apart on purpose: filing a 429 as a silence would` +
			`\n  make a broken arm look like the most disciplined coach in the run.`
	)
	if (scores.every(s => s.spoken < 10))
		console.log(
			`\n  NOTE: no arm has 10 spoken lines. Every interval above is wide enough to cover almost any claim.` +
				`\n  Read the sentences, not the percentages, and raise --turns before comparing arms. --repeats also` +
				`\n  raises n — each repetition is now scored as its own transcript, so it no longer collapses` +
				`\n  not-generic and dup — but it re-asks the SAME turns, so it measures the model's variance and` +
				`\n  not more of the game. --turns is the one that buys new evidence.`
		)
}

/* =================================================================== sheet */

/**
 * A deterministic shuffle, so the sheet a run produces is the same sheet every time it is rebuilt
 * from the same run — and so lines are not grouped by arm, which would un-blind it at a glance.
 */
const shuffled = <T>(items: readonly T[], seed: string): T[] => {
	let h = 2166136261
	for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
	const out = [...items]
	for (let i = out.length - 1; i > 0; i--) {
		h = (Math.imul(h, 1664525) + 1013904223) >>> 0
		const j = h % (i + 1)
		;[out[i], out[j]] = [out[j]!, out[i]!]
	}
	return out
}

/**
 * Read a paired frame back off disk as base64, once per path.
 *
 * The run JSON stores `framePath` and deliberately NOT the bytes — a window of 48 frames at ~150KB
 * would put 10MB of base64 into a file that is otherwise diffable and greppable — so the sheet
 * re-reads them off disk at render time. The path is stored rather than a boolean saying a frame
 * existed precisely so a sheet can be rebuilt from a stored run later; `--summarize` itself does
 * not write one, because the run that produced it already did and measurements are never
 * overwritten here.
 *
 * `stream.ts` has already rebased the pre-rename `/home/ssalb/coachskaffur` paths and confirmed
 * every one of them opens as a JPEG, so a miss here means the file moved AFTER the run. That is
 * reported as a missing picture, never as a line without a frame: a card silently losing its
 * screenshot is exactly the failure that makes a judge grade `unverifiable` on the lines the frame
 * was added to settle.
 */
const frameReader = (): ((path: string | null) => string | null) => {
	const cache = new Map<string, string | null>()
	return path => {
		if (path === null) return null
		const hit = cache.get(path)
		if (hit !== undefined) return hit
		const b64 = existsSync(path) ? readFileSync(path).toString("base64") : null
		cache.set(path, b64)
		return b64
	}
}

/** Did the turn this line came from have a paired frame at RUN time? Distinguishes "no frame for
 * that instant" (normal: the two recorders' cadences beat) from "the file has since gone". */
const turnHadFrame = (run: RunFile, l: SheetLine): boolean =>
	run.windows.some(w => w.id === l.windowId && w.turns.some(t => t.atSec === l.atSec && t.framePath !== null))

const sheetLines = (run: RunFile, records: readonly CallRecord[]): SheetLine[] => {
	const turnOf = new Map<string, RunFile["windows"][number]["turns"][number]>()
	for (const w of run.windows) for (const t of w.turns) turnOf.set(`${w.id}@${t.index}`, t)
	const frameB64Of = frameReader()
	// Only spoken lines are gradeable. A page of blanks teaches him nothing, and the counts of what
	// was excluded live in the report and the JSON where they cannot un-blind a row.
	const spoken = records.filter(r => r.error === null && !isSilence(r.text))
	return shuffled(spoken, run.ranAt).map((r, n) => {
		const t = turnOf.get(`${r.windowId}@${r.index}`)
		return {
			id: `L${String(n + 1).padStart(2, "0")}`,
			armKey: r.arm,
			clock: r.clock,
			atSec: r.atSec,
			text: r.text,
			latencyMs: r.latencyMs,
			block: t?.block ?? "",
			offered: t?.offered ?? [],
			// The frame the arm was actually shown for this turn. A blinded (`+noframe`) arm spoke
			// without it, but the JUDGE still needs it: he is checking whether the sentence was true
			// of that instant, not reproducing what the model could see.
			frameB64: frameB64Of(t?.framePath ?? null),
			windowId: r.windowId,
			// The card asserts one clock and shows a frame paired up to DEFAULT_MAX_SKEW_MS away
			// from it. Shown on the card: skew is a property of the TURN, identical for every arm
			// that spoke at it, so it groups nothing — and `false` is the fatal verdict, which must
			// never be cast because the picture was of a different second.
			skewMs: r.skewMs
		}
	})
}

/* ==================================================================== main */

/**
 * Every arm that was actually LIVE stays in the tables, including one that produced nothing.
 *
 * The filter used to be `attempted > 0`, and an arm whose job threw — a `gemini-live` arm dying on
 * `new WebSocket(...)`, say — left one `job N threw:` line on stderr and then disappeared from THE
 * LINES, LATENCY, THE SIX AXES and ERRORS AND SILENCES alike. That is precisely the failure the
 * errors table's own footnote warns about: a broken arm reading as the most disciplined coach in
 * the run, except worse, because it is not even on the page to be doubted. An arm requested and
 * available but silent is a RESULT and is printed as `calls 0`.
 */
const scoreAll = (
	run: RunFile,
	arms: readonly Arm[],
	streams: readonly BuiltStream[],
	mode: LiveCoachMode
): ArmScore[] => {
	const statesByWindow = new Map<string, CoachState[]>()
	for (const s of streams) statesByWindow.set(s.window.id, s.states as CoachState[])
	return arms
		.filter(a => a.available)
		.map(a => scoreArm(a, run.records.filter(r => r.arm === a.id), streams, statesByWindow, mode))
}

/**
 * Re-print a stored run. Nothing is called, nothing is paid, and the scoring is the same code — so
 * a threshold change can be applied to a run from weeks ago for free.
 *
 * The stream is rebuilt from the stored turns rather than replayed: `buildStream` would touch the
 * ranker's memory again and could differ from what the run actually sent, which is the one thing a
 * re-score must not do.
 */
const summarize = (path: string, verbose: boolean): void => {
	const run = JSON.parse(readFileSync(path, "utf8")) as RunFile
	const arms: Arm[] = run.arms.map(a => ({
		id: a.id,
		// Recovered from the id's own suffix; a pre-mode run file has none and falls back to the
		// run-level mode it was actually rendered for.
		mode: ((): LiveCoachMode => {
			const m = a.id.split("+")[0]!.split("@")[1]
			return m === "trusted" || m === "cite-or-quiet" || m === "fenced" ? m : run.mode
		})(),
		provider: a.provider,
		model: a.model,
		shape: a.shape === "socket" ? "socket" : "turn",
		vision: a.vision,
		available: a.available,
		unavailable: a.unavailable
	}))
	const streams: BuiltStream[] = run.windows.map(w => ({
		window: {
			id: w.id,
			sampleFile: w.sampleFile,
			gameId: w.gameId,
			champion: w.champion,
			frames: [],
			medianSkewMs: w.medianSkewMs,
			tSecFrom: w.tSecFrom,
			tSecTo: w.tSecTo
		} as StreamWindow,
		// A run file written before the event schedule existed has no `schedule` field, and the
		// honest reconstruction of one of those is "timer" — that is what it was.
		schedule: run.schedule ?? "timer",
		scheduled: [],
		stride: run.stride ?? 1,
		mode: run.mode,
		baselineGames: w.baselineGames,
		warnings: w.warnings,
		turns: w.turns.map(t => ({
			index: t.index,
			atSec: t.atSec,
			clock: t.clock,
			block: t.block,
			// Empty on a pre-brief run file. A re-score of one of those simply has no trusted arm.
			brief: t.brief ?? "",
			counterpart: t.counterpart ?? null,
			offered: t.offered,
			roster: t.roster,
			aliases: t.aliases,
			me: t.me,
			frame: null,
			frameB64: null,
			skewMs: t.skewMs,
			paceInBlock: paceInBlockOf(t),
			sampleLine: t.sampleLine,
			why: t.why ?? null,
			readMinimap: t.readMinimap ?? true,
			kinds: t.kinds ?? [],
			// A re-score never rebuilds a payload — `records[].payload` holds the bytes that went
			// out — so the raw sample is not carried into the run file just to be replayed here.
			raw: null
		})),
		// Only the states at the turns survive into the file; that is exactly what `stateAt` needs
		// for `stateAtT`, and `stateAtEnd` was already resolved at run time and stored per record.
		states: w.stateAtT.filter((s): s is CoachState => s !== null),
		stateAtSec: w.turns.map(t => t.atSec),
		stepped: w.stepped
	}))
	const scores = scoreAll(run, arms, streams, run.mode)
	printWhat(run, arms, 0)
	printLines(run, scores, verbose)
	printLatency(scores, run.everySec)
	printPayload(scores)
	printAxes(scores, run)
	printFailures(scores)
	console.log(`\nre-printed ${path} — no model was called.`)
}

const main = async (): Promise<void> => {
	if (has("reveal")) {
		const keyPath = argN("reveal", 0)
		const verdictPath = argN("reveal", 1)
		if (keyPath === "" || verdictPath === "")
			throw new Error("--reveal takes two paths: the key file this run wrote, and your graded verdicts")
		console.log(revealVerdicts(readFileSync(keyPath, "utf8"), readFileSync(verdictPath, "utf8")))
		return
	}

	if (has("summarize")) {
		summarize(arg("summarize", ""), has("verbose"))
		return
	}

	const windows = discoverWindows()

	if (has("list")) {
		console.log(`\n${windows.length} window(s) where a REAL frame and REAL raw client data exist for the same instant:\n`)
		console.log(`  ${pad("id", 30)}${pad("game", 14)}${pad("champion", 12)}${padL("frames", 7)}${padL("from", 8)}${padL("to", 8)}${padL("skew", 9)}`)
		for (const w of windows)
			console.log(
				`  ${pad(w.id, 30)}${pad(w.gameId, 14)}${pad(w.champion, 12)}${padL(String(w.frames.length), 7)}` +
					`${padL(clockOf(w.tSecFrom), 8)}${padL(clockOf(w.tSecTo), 8)}${padL(`${w.medianSkewMs}ms`, 9)}`
			)
		console.log(`\n  arms available on this machine:\n`)
		for (const id of ["mock", ...PROVIDERS.filter(p => p.id !== "mock").map(p => p.id), GEMINI_LIVE]) {
			const { available, why } = armAvailability(id)
			console.log(`  ${pad(id, 16)}${pad(armDefaultModel(id) || "(pass --models)", 40)}${available ? "yes" : `MISSING — ${why}`}`)
		}
		console.log(
			`\n  Everything else on disk is unpaired: the sampler started recording after most journal frames` +
				`\n  were written, so the big frame runs have no raw client data and most sample files have no pixels.`
		)
		return
	}

	if (windows.length === 0)
		throw new Error(
			"no paired windows on disk. A window needs a journal frame and a raw allgamedata sample for the " +
				"same instant; run --list to see what stream.ts found."
		)

	/* ----------------------------------------------------------- selection */
	/*
	 * `latest` means the most recently PLAYED game, and it is resolved from the frames' own wall
	 * clock rather than from the order `discoverWindows` returns. That order is by frame count
	 * descending — the right order for a menu, and silently the wrong one here: taking the last
	 * element handed back the window with the FEWEST frames, which on this corpus is the OLDER of
	 * the two games. A default that quietly replays the wrong game is worse than no default,
	 * because every number it prints is about a game the reader did not ask for.
	 */
	const want = arg("window", "latest")
	const lastFrameMs = (w: StreamWindow): number =>
		w.frames.reduce((m, f) => (f.atMs > m ? f.atMs : m), 0)
	const chosen =
		want === "all" ? windows
		: want === "latest" ?
			[[...windows].sort((a, b) => lastFrameMs(a) - lastFrameMs(b))[windows.length - 1]!]
		: windows.filter(w => w.id === want)
	if (chosen.length === 0)
		throw new Error(`no window called "${want}". Run --list; ids are ${windows.map(w => w.id).join(", ")}`)

	const everySec = Number(arg("every", "20"))
	/*
	 * The SHIPPED schedule under `trusted` is the event detector, not a cadence. `--schedule timer`
	 * keeps the old instrument runnable so the two can be compared on one game; it is not the
	 * default any more, because defaulting to it benches a coach nobody runs.
	 */
	const schedule = (arg("schedule", "events") === "timer" ? "timer" : "events") as "timer" | "events"
	const stride = Number(arg("stride", "1"))
	const heartbeatSec = Number(arg("heartbeat", String(HEARTBEAT_SEC)))
	const turnsWanted = Number(arg("turns", "8"))
	const fromSec = Number(arg("from", "0"))
	const repeats = Math.max(1, Number(arg("repeats", "1")))
	const concurrency = Math.max(1, Number(arg("concurrency", "1")))
	const blindAll = has("no-frame")
	const timeoutMs = Number(arg("timeout", "120000"))

	const models = new Map<string, string>()
	for (const pair of arg("models", "").split(",")) {
		const [id, model] = pair.split("=").map(s => s.trim())
		if (id && model) models.set(id, model)
	}
	/* The run's default architecture, and what a bare arm id means. Read from Settings, the same
	 * source `buildStream` renders its block for, so `mock` and `mock@<that mode>` are one arm. */
	const runMode = getSettings().liveCoachMode as LiveCoachMode
	const arms = resolveArms(arg("arms", ""), models, blindAll, runMode)
	const live = arms.filter(a => a.available)
	if (live.length === 0) throw new Error("every requested arm is unavailable — run --list to see the keys")

	/*
	 * WHERE THE OUTPUT GOES IS SETTLED BEFORE ANYTHING IS PAID FOR.
	 *
	 * This check used to sit at the end of main(), after the jobs ran and after all five report
	 * sections printed — so a second run with the same `--out` executed the whole stream, printed
	 * the whole report, then threw and wrote nothing. With `mock` that costs four seconds. With
	 * `--arms anthropic,openai,gemini-live --turns 12` it discards a paid run whose records exist
	 * only in terminal scrollback. Nothing is ever overwritten, including a run that came out
	 * badly, but the refusal has to arrive before the bill.
	 */
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
	const out = arg("out", `${DATA_DIR}/eval/stream-${stamp}.json`)
	mkdirSync(dirname(out), { recursive: true })
	if (existsSync(out)) throw new Error(`${out} already exists — measurements are kept, never overwritten`)

	/* ------------------------------------------------------- build the stream */
	/*
	 * `--require-frame` exists because of what dilutes a `+noframe` twin.
	 *
	 * Checkpoints are picked on cadence, and a turn with no paired frame sends no image — so on
	 * such a turn the sighted arm's request is BYTE-IDENTICAL to its blind twin's and the two
	 * cannot differ. Measured on `--window split-03 --every 60`: 1 of 3 turns carried a frame, so
	 * two thirds of "the frame's entire contribution" was zero by construction. Off by default,
	 * because the honest default is the real cadence; on when the run's question is the frame.
	 */
	const requireFrame = has("require-frame")
	/*
	 * `--no-read` restores the old behaviour where the position was never read. Kept runnable
	 * because the two stored runs on disk were graded that way, and a re-run meant to be compared
	 * with one of them has to be able to match it.
	 */
	const noRead = has("no-read")
	const streams: BuiltStream[] = chosen.map(w =>
		buildStream(w, {
			everySec,
			fromSec,
			turns: turnsWanted,
			requireFrame,
			schedule,
			stride,
			heartbeatSec
		})
	)
	const totalTurns = streams.reduce((a, s) => a + s.turns.length, 0)
	if (totalTurns === 0)
		throw new Error(
			schedule === "events" ?
				`no turns to send: the detector raised ${streams.reduce((a, s) => a + s.scheduled.length, 0)} ` +
					`turn(s) and --turns ${turnsWanted} --stride ${stride} --from ${fromSec} kept none`
			:	`no turns to send (--every ${everySec} --from ${fromSec} --turns ${turnsWanted})`
		)
	if (schedule === "events")
		for (const s of streams) {
			const raised = s.scheduled.length
			const sent = s.turns.length
			console.log(
				`  ${s.window.id}: detector raised ${raised} turn(s), stride ${s.stride} → sending ${sent}` +
					(raised > sent ?
						`  (${raised - sent} question(s) not asked — a COST subsample, not a policy)`
					:	"")
			)
		}

	const mode = (streams[0]!.mode || DEFAULT_LIVE_COACH_MODE) as LiveCoachMode
	const paidCalls = live.filter(a => a.provider !== "mock").length * totalTurns * repeats

	const run: RunFile = {
		ranAt: new Date().toISOString(),
		argv,
		mode,
		schedule,
		stride,
		heartbeatSec,
		everySec,
		fromSec,
		turnsWanted,
		repeats,
		concurrency,
		blindAll,
		windows: streams.map(s => ({
			id: s.window.id,
			gameId: s.window.gameId,
			champion: s.window.champion,
			sampleFile: s.window.sampleFile,
			medianSkewMs: s.window.medianSkewMs,
			tSecFrom: s.window.tSecFrom,
			tSecTo: s.window.tSecTo,
			baselineGames: s.baselineGames,
			stepped: s.stepped,
			// Optional on `BuiltStream` for consumers that predate it; never absent from a run file,
			// where an empty array and a missing key would read very differently.
			warnings: s.warnings ?? [],
			turns: s.turns.map(t => ({
				index: t.index,
				atSec: t.atSec,
				clock: t.clock,
				clockSource: t.frame?.clock ?? "sample",
				block: t.block,
				brief: t.brief,
				counterpart: t.counterpart,
				offered: [...t.offered],
				roster: [...t.roster],
				aliases: [...t.aliases],
				me: t.me,
				framePath: t.frame?.path ?? null,
				frameBytes: t.frame?.bytes ?? null,
				skewMs: t.skewMs,
				paceInBlock: t.paceInBlock,
				sampleLine: t.sampleLine,
				why: t.why,
				readMinimap: t.readMinimap,
				kinds: t.kinds
			})),
			stateAtT: s.turns.map(t => stateAt(s.states as CoachState[], t.atSec))
		})),
		arms: arms.map(a => ({
			id: a.id,
			provider: a.provider,
			model: a.model,
			vision: a.vision,
			shape: a.shape,
			available: a.available,
			unavailable: a.unavailable
		})),
		records: []
	}

	printWhat(run, arms, paidCalls)
	if (paidCalls > 0) {
		console.log(`\n  starting in 3s — Ctrl-C now if that call count is not what you meant.`)
		await new Promise(r => setTimeout(r, 3000))
	}

	/* ------------------------------------------------------------- run it */
	/*
	 * Arms run in parallel only when explicitly asked, and turns within an arm are ALWAYS
	 * sequential. A real game sends one turn at a time, the socket keeps a thread that depends on
	 * turn order, and a latency measured while three other calls share the uplink is a measurement
	 * of this machine rather than of a model.
	 */
	interface Job {
		arm: Arm
		stream: BuiltStream
		rep: number
		run: () => Promise<CallRecord[]>
	}
	/*
	 * THE MINIMAP READ, ONCE PER TURN, BEFORE ANY ARM RUNS.
	 *
	 * Shared across arms deliberately — see `readWhere`. Done up front rather than lazily so the
	 * run prints what the reader actually managed before spending anything on the coach: a run
	 * where the fence refused most turns is a run whose position axis is mostly untested, and a
	 * reader who learns that from the summary table has already paid for the coach.
	 */
	const wheresByWindow = new Map<string, Map<number, TurnWhere>>()
	if (!noRead)
		for (const st of streams) {
			const w = await readWhere(st, `${DATA_DIR}/eval/bench-crops/${st.window.id}`)
			wheresByWindow.set(st.window.id, w)
			const placed = [...w.values()].filter(x => x.where !== null).length
			const msList = [...w.values()].map(x => x.ms).filter(m => m > 0)
			console.log(
				`  ${st.window.id}: minimap read placed him on ${placed}/${st.turns.length} turn(s)` +
					(msList.length > 0 ?
						`, p50 ${Math.round(quantile(msList, 0.5))}ms`
					:	"") +
					` — ${[...new Set([...w.values()].map(x => x.reason.replace(/\(\d+s\)/, "(Ns)")))].join(", ")}`
			)
		}

	const jobs: Job[] = []
	for (const a of live)
		for (const s of streams)
			for (let rep = 0; rep < repeats; rep++)
				jobs.push({
					arm: a,
					stream: s,
					rep,
					run: () =>
						a.shape === "socket" ?
							runSocketArm(a, s, rep, a.mode, timeoutMs, wheresByWindow.get(s.window.id))
						:	runTurnArm(a, s, rep, mode, wheresByWindow.get(s.window.id))
				})

	const results: CallRecord[][] = []
	let cursor = 0
	const worker = async (): Promise<void> => {
		while (cursor < jobs.length) {
			const i = cursor++
			const job = jobs[i]!
			try {
				results.push(await job.run())
			} catch (e) {
				/*
				 * A THROW IS A RESULT AND IT GETS ROWS.
				 *
				 * This used to log one line to stderr and drop the arm's records, which then left
				 * the arm out of every table — a `gemini-live` arm dying on `new WebSocket(...)`
				 * produced one message buried above two hundred lines of report and no row anywhere
				 * saying it had failed. `runSocketArm.finish()` already does this for a socket that
				 * dies mid-window; this is the same discipline for the throw that never got that far.
				 */
				const why = e instanceof Error ? e.message : String(e)
				console.error(`  ${job.arm.id} threw: ${why}`)
				results.push(
					job.stream.turns.map(t => ({
						arm: job.arm.id,
						provider: job.arm.provider,
						model: job.arm.model,
						windowId: job.stream.window.id,
						index: t.index,
						rep: job.rep,
						atSec: t.atSec,
						clock: t.clock,
						text: "",
						latencyMs: 0,
						frameSent: false,
						framePath: t.frame?.path ?? null,
						skewMs: t.skewMs,
						error: `arm threw before answering: ${why.slice(0, 160)}`,
						stateAtEnd: null,
						payload: null,
						payloadChars: null,
						payloadKind: null
					}))
				)
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()))
	run.records = results.flat()

	/*
	 * The end-state is resolved only now, because it depends on how long the sentence took to say,
	 * which depends on the sentence. `stateAt` returns null past its tolerance and the timeliness
	 * axis then reports `unknown` and is EXCLUDED from the denominator rather than counted fresh.
	 */
	const statesOf = new Map<string, CoachState[]>()
	for (const s of streams) statesOf.set(s.window.id, s.states as CoachState[])
	for (const r of run.records) {
		if (r.error !== null || isSilence(r.text)) continue
		const endSec = r.atSec + r.latencyMs / 1000 + speechDurationSec(r.text)
		r.stateAtEnd = stateAt(statesOf.get(r.windowId) ?? [], endSec)
	}

	/* ------------------------------------------------------------- report */
	const scores = scoreAll(run, arms, streams, mode)
	printLines(run, scores, has("verbose"))
	printLatency(scores, everySec)
	printPayload(scores)
	printAxes(scores, run)
	printFailures(scores)

	/* --------------------------------------------------------------- keep */
	// `out` was resolved and refused-if-present before the first call; see the argument block.
	writeFileSync(out, JSON.stringify(run, null, "\t"))
	console.log(`\nwrote ${out}`)

	if (has("sheet")) {
		const lines = sheetLines(run, run.records)
		const sheetPath = out.replace(/\.json$/, "-sheet.html")
		const keyPath = out.replace(/\.json$/, "-key.json")
		const excluded = run.records.length - lines.length
		/*
		 * THE STORE KEY IS PER RUN, and the title is not enough to make one.
		 *
		 * `bench-stream · <window ids> · <N> lines` carries no run identity: five sheets already on
		 * disk collapse to two distinct keys, and every sheet numbers its lines L01…LNN. On Chrome
		 * all `file://` documents share one storage origin, so opening the second sheet loaded the
		 * first run's verdicts, pre-painted onto different sentences from a different model — and
		 * `--reveal` could not detect it, because it only flags ids ABSENT from the key. The
		 * output file's own basename is unique by construction (the run refuses to overwrite one),
		 * so it is the identity, and it is written into the key file and every exported payload.
		 */
		const storeKey = basename(out).replace(/\.json$/, "")
		writeFileSync(
			sheetPath,
			renderSheet(lines, {
				storeKey,
				title: `bench-stream · ${run.windows.map(w => w.id).join(", ")} · ${lines.length} lines`,
				note:
					`Every line below was said at the clock shown, about the block shown, by one of ${live.length} arms — ` +
					`which one is NOT on this page. ${excluded} turns are not here because the arm passed or the call failed; ` +
					`the counts are in ${out}. Grade what the line is worth to a jungler at that instant, then run ` +
					`--reveal with the key.`
			})
		)
		writeFileSync(keyPath, renderKey(lines, storeKey))
		// Said out loud rather than left for him to notice on card 40. A line whose turn HAD a frame
		// but whose JPEG could not be re-read is a card that cannot be graded on what it claims about
		// the map, and the sheet has no way to show that it is missing one.
		const withFrame = lines.filter(l => l.frameB64 !== null).length
		const lost = lines.filter(l => l.frameB64 === null && turnHadFrame(run, l)).length
		console.log(`wrote ${sheetPath}  (${withFrame}/${lines.length} cards carry the real journal frame)`)
		if (lost > 0) console.log(`  WARNING: ${lost} line(s) had a paired frame at run time whose file could not be read now`)
		console.log(`wrote ${keyPath}  (the key — do not open it before grading)`)
	}
}

if (import.meta.main) await main()
