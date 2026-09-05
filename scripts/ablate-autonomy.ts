/**
 * How much usefulness is the fence costing?
 *
 * ## The question
 *
 * The shipped live coach is FENCED: `analysis/live-facts.ts` computes and ranks every candidate
 * line in TypeScript, and `shared/live-prompt.ts` permits the model to speak only from that ranked
 * list — an empty list means PASS. That fence is measured safe (0% fabrication, n=20, 95% CI
 * 0–28%; removing the speak-from-list rule took it to 8% unbacked and 8% misattributed).
 *
 * What was never measured is what it COSTS. Two arms on the real socket, n=14 each, identical
 * blocks and prompt, differing only in whether the JPEG was attached, agreed on speak-or-PASS in
 * 13 of 14 turns and produced near-verbatim paraphrases. The picture changes nothing, because no
 * ranked fact is computed from pixels — while the same model reads that same picture perfectly
 * when asked a direct question (6/6 exact on the game clock, against 0/6 blind).
 *
 * So this holds the MODEL constant and varies only the ARCHITECTURE. Four arms, each run with and
 * without the frame, on identical states in identical order:
 *
 *   1. `fenced`        exactly what ships. The baseline.
 *   2. `fenced-see`    the ranked list, plus explicit permission to speak about what is visible.
 *                      The cheapest possible test of whether the fence alone silences the frame.
 *   3. `cite-or-quiet` no ranked list. Block, frame, champion knowledge, persona, and one hard
 *                      rule: cite it or say nothing.
 *   4. `free`          full autonomy. The upper bound on usefulness and on fabrication.
 *
 * ## Why the model is held constant, and why that is not a compromise
 *
 * Only `data/gemini.key` exists on this machine. Anthropic, OpenAI, Kimi and GLM have no keys, and
 * the `claude -p` CLI path cannot attach an image, so the cross-MODEL comparison cannot run. That
 * is stated in the output rather than worked around. Architecture is the more important axis
 * anyway: a model comparison would tell you which vendor phrases the same ranked fact best, and
 * the finding under test is that the ranked fact is the ceiling.
 *
 * ## What varies, exactly
 *
 * Arms 1 and 2 see the block VERBATIM as `renderState` produced it. Arms 3 and 4 see the same
 * block with the fence's own output — the "What he is NOT looking at" list, or its explicit
 * empty-case paragraph — cut out, because that section IS the fence. Every other byte of ground
 * truth is identical. The one clause that pointed at the removed list is repaired rather than left
 * dangling, and both texts are stored in the run so the surgery can be checked by eye.
 *
 * Arm 1 against arm 2 is therefore a pure prompt difference on a byte-identical block, and arm 3
 * against arm 4 is a pure prompt difference on a byte-identical stripped block.
 *
 * ## Two state sets, because the frames only exist for the first 6:43
 *
 * `data/live-samples/split-03.ndjson` holds 363 verbatim `allgamedata` samples from game
 * 5635467422 (a win, Lillia 12/8/17, 220 CS, 36:49). The browser journal holds 43 real frames for
 * it, all between 0:02 and 6:43 — there are no replays left, so that window cannot be widened.
 *
 *   - **PAIRED** — the frame-bearing states. Every arm runs twice, with and without the picture.
 *     Eight cells. This is the frame-sensitivity instrument.
 *   - **LATE** — the rest of the game, text-only, four cells. It exists because the fenced arm is
 *     structurally almost silent in the first 6:43, so PAIRED alone cannot measure what the fence
 *     costs where the fence actually fires.
 *
 * Blocks are built by replaying the WHOLE 363-sample stream in order through the daemon's own
 * `buildLiveStateForBench`, because the fact list is rate-limited through memory — a block built
 * out of sequence is a block nobody would ever have been shown.
 *
 * ## Usage
 *
 *     node --experimental-strip-types scripts/ablate-autonomy.ts
 *       --model <id>          default gemini-3.6-flash
 *       --temperature X       default 0, held on every arm
 *       --concurrency N       default 6
 *       --limit N             cap states per set, for a dry run
 *       --arms a,b            subset of fenced,fenced-see,cite-or-quiet,free
 *       --no-late             skip the LATE set
 *       --out <path>          default data/eval/ablation-<stamp>.json
 *
 * DO NOT run this while a game is in progress. It touches no League API and no LCU endpoint, but
 * it spends the Gemini HTTPS quota, which bills separately from the Live socket the coach uses.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { DATA_DIR, DB_PATH } from "../src/shared/constants.ts"
import { renderState } from "../src/shared/live-state.ts"
import { LIVE_COACH_SYSTEM_PROMPT } from "../src/shared/live-prompt.ts"
import { parseChampionClauses } from "../src/shared/champion-advice.ts"
import { baselineFromRows, perGameMetrics } from "../src/analysis/index.ts"
import { loadCorpus } from "../src/daemon/corpus.ts"
import { buildLiveStateForBench } from "../src/server/routes/live.ts"
import { readSamples } from "../src/daemon/live-sampler.ts"
import { FABRICATION_FAULTS, isEmpty, scoreLine, separated, wilson } from "../src/analysis/coach-score.ts"
import type { CoachFault, Interval, LineScore } from "../src/analysis/coach-score.ts"
import { modelHandleFor, providerById, providerKey } from "../src/review/live-providers.ts"

/* ================================================================= arguments */

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback
}
const flag = (name: string): boolean => argv.includes(`--${name}`)

const MODEL = arg("model", "gemini-3.6-flash")
const TEMPERATURE = Number(arg("temperature", "0"))
const CONCURRENCY = Math.max(1, Number(arg("concurrency", "6")))
const LIMIT = Number(arg("limit", "0"))
const SAMPLE_FILE = arg("samples", "split-03")
const GAME_ID = arg("game", "5635467422")
const RUN_LATE = !flag("no-late")
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")
const OUT = arg("out", `${DATA_DIR}/eval/ablation-${stamp}.json`)

/**
 * How far a frame may sit from the sample it is paired with.
 *
 * Three seconds, matching `scripts/build-fixture.ts`, so the frames used here are exactly the ones
 * that fixture's notes record as having been opened and inspected by eye. A frame paired with a
 * block from a different moment is the defect that made the old benchmark unable to measure any of
 * this, and a loose gate is the quiet version of the same defect.
 */
const FRAME_SKEW_GATE_SEC = 3

/** Game-clock spacing for the LATE set. Samples arrive every ~6s; every one of them is not a turn. */
const LATE_SPACING_SEC = 30

/* ================================================================== the states */

interface AblationState {
	id: string
	tSec: number
	clock: string
	/** Absolute path to the real frame, or null for a text-only state. */
	framePath: string | null
	frameSkewSec: number | null
	/** What arms 1 and 2 see: `renderState` verbatim. */
	block: string
	/** What arms 3 and 4 see: the same block with the fence's ranked list cut out. */
	blockNoList: string
	/** How many ranked facts the fence offered here. Zero means the fenced arm must PASS. */
	rankedFacts: number
	roster: string[]
}

/**
 * Cut the fence's own output out of the block.
 *
 * The ranked list — and its explicit empty-case paragraph, which is just as much a fence
 * instruction — runs from its heading to the "ten champions" paragraph that closes every block.
 * Everything above it is raw ground truth and is left byte-identical.
 *
 * The closing paragraph points at "the list below", which no longer exists once the list is gone.
 * A dangling reference is not neutral: it tells the model something was withheld. So that clause
 * alone is repaired, and the substitution is recorded in the run output.
 */
export const LIST_HEADINGS = ["### What he is NOT looking at", "### Nothing he is missing right now"]

/**
 * The two places `renderState` points at the list from OUTSIDE it.
 *
 * Both were found by a test rather than by reading, and the second one matters more than the
 * first. `Farm baseline (CONTEXT ONLY — never say this unless it also appears in the list below)`
 * sits in the middle of the ground truth and is not ground truth at all: it is the fence, telling
 * the model it may not use the one number in the block that compares him to himself. Leaving it in
 * would have gagged the unfenced arms on farm while the run reported them as unfenced, which is
 * the quiet kind of confound that makes a whole measurement worthless.
 *
 * Both repairs keep the FACT and drop only the instruction, and both are recorded in the run
 * output so the surgery can be checked by eye.
 */
export const REPAIRS: { from: string; to: string; why: string }[] = [
	{
		from: "and take every timer from the list below rather than\ninferring one",
		to: "and never infer a timer you were not given",
		why: "a pointer at a list that is no longer there tells the model something was withheld"
	},
	{
		from: "Farm baseline (CONTEXT ONLY — never say this unless it also appears in the list below):",
		to: "Farm baseline:",
		why: "this is the fence gating the farm comparison, not a fact — the figure itself is untouched"
	}
]

export const stripRankedList = (block: string): string => {
	const tail = block.indexOf("**The ten champions above")
	if (tail < 0) return block
	let head = -1
	for (const h of LIST_HEADINGS) {
		const at = block.indexOf(h)
		if (at >= 0 && (head < 0 || at < head)) head = at
	}
	let out = head < 0 ? block : `${block.slice(0, head)}${block.slice(tail)}`
	for (const r of REPAIRS) out = out.replace(r.from, r.to)
	return out
}

export const countRankedFacts = (block: string): number =>
	block.split("\n").filter(l => l.startsWith("- ")).length

/**
 * Replay the recorded game and join the browser's real frames onto it.
 *
 * The whole sample stream goes through `buildLiveStateForBench` in order, exactly as
 * `scripts/build-fixture.ts` does, because the fact list carries memory. Frames come from the
 * `journal_frame` table and are joined on `atMs` — never on index, never across games.
 */
const buildStates = (): { paired: AblationState[]; late: AblationState[]; note: string } => {
	const samples = readSamples(SAMPLE_FILE)
	if (samples.length === 0) throw new Error(`no samples in data/live-samples/${SAMPLE_FILE}.ndjson`)

	/*
	 * His rolling farm average as the daemon would have had it DURING this game — games created
	 * after it excluded, so the future cannot set the average. Without this the block's farm line
	 * reads NONE, which is honest and is not what a real game looks like.
	 */
	const db = new DatabaseSync(DB_PATH, { readOnly: true })
	const createdMs = Number(
		(db.prepare("SELECT gameCreationMs FROM game WHERE gameId = ?").get(Number(GAME_ID)) as
			| { gameCreationMs: number | bigint }
			| undefined)?.gameCreationMs ?? 0
	)
	const frames = db
		.prepare("SELECT id, path, atMs, tSec FROM journal_frame ORDER BY atMs")
		.all() as unknown as { id: string; path: string; atMs: number; tSec: number }[]
	db.close()

	const corpus = loadCorpus(200)
		.filter(e => createdMs === 0 || Number(e.row.gameCreationMs) < createdMs)
		.slice(0, 20)
	const baseline = corpus.length > 0 ? baselineFromRows(perGameMetrics(corpus)) : null

	interface Built {
		line: number
		atMs: number
		tSec: number
		block: string
		roster: string[]
	}
	const built: Built[] = []
	let line = 0
	for (const s of samples) {
		line++
		const st = buildLiveStateForBench(s.data, s.gameTime, baseline)
		if (!st) continue
		built.push({
			line,
			atMs: s.atMs,
			tSec: s.gameTime,
			block: renderState(st),
			roster: [st.me.champion, ...st.allies.map(p => p.champion), ...st.enemies.map(p => p.champion)]
		})
	}
	if (built.length === 0) throw new Error("no sample produced a state")

	const firstMs = built[0]!.atMs
	const lastMs = built[built.length - 1]!.atMs
	const make = (b: Built, id: string, framePath: string | null, skew: number | null): AblationState => ({
		id,
		tSec: Math.round(b.tSec),
		clock: `${Math.floor(b.tSec / 60)}:${String(Math.floor(b.tSec % 60)).padStart(2, "0")}`,
		framePath,
		frameSkewSec: skew,
		block: b.block,
		blockNoList: stripRankedList(b.block),
		rankedFacts: countRankedFacts(b.block),
		roster: b.roster
	})

	const paired: AblationState[] = []
	const usedLines = new Set<number>()
	let dropped = 0
	for (const f of frames) {
		if (f.atMs < firstMs - 5000 || f.atMs > lastMs + 5000) continue
		if (!existsSync(f.path)) continue
		let best: Built | null = null
		let bestSkew = Infinity
		for (const b of built) {
			const skew = Math.abs(b.atMs - f.atMs) / 1000
			if (skew < bestSkew) {
				bestSkew = skew
				best = b
			}
		}
		if (!best || bestSkew > FRAME_SKEW_GATE_SEC) {
			dropped++
			continue
		}
		paired.push(make(best, f.id, f.path, Math.round(bestSkew * 100) / 100))
		usedLines.add(best.line)
	}

	const lastFrameSec = paired.length > 0 ? paired[paired.length - 1]!.tSec : 0
	const late: AblationState[] = []
	let lastAt = -Infinity
	for (const b of built) {
		if (b.tSec <= lastFrameSec) continue
		if (usedLines.has(b.line)) continue
		if (b.tSec - lastAt < LATE_SPACING_SEC) continue
		lastAt = b.tSec
		late.push(make(b, `late-${String(Math.round(b.tSec)).padStart(4, "0")}`, null, null))
	}

	return {
		paired,
		late,
		note:
			`${built.length} of ${samples.length} samples produced a state; ${paired.length} frames joined within ` +
			`${FRAME_SKEW_GATE_SEC}s and ${dropped} were dropped over that gate; the LATE set is every state after ` +
			`${lastFrameSec}s at ${LATE_SPACING_SEC}s spacing`
	}
}

/* ==================================================================== the arms */

/**
 * The champion's own knowledge, as the fenced coach gets it.
 *
 * Arms 3 and 4 lose the ranked list, and the ranked list is where champion knowledge reaches the
 * shipped coach — `withAdvice` appends a clause to a fact. Handing them the raw markdown instead
 * would be a different experiment: that file carries digits (a patch number, a clear time), and a
 * digit in prose is exactly the fabrication source the parser exists to refuse. So they get the
 * PARSED clauses, which are digit-free by construction. Same knowledge, unfenced delivery.
 */
export const championKnowledge = (champion: string): string => {
	const path = `knowledge/champions/${champion.toLowerCase().replace(/[^a-z]/g, "")}.md`
	if (!existsSync(path)) return ""
	const clauses = parseChampionClauses(readFileSync(path, "utf8"))
	const lines: string[] = []
	for (const [kind, list] of Object.entries(clauses))
		for (const c of list ?? []) lines.push(`- (${kind}) ${c}`)
	if (lines.length === 0) return ""
	return `\n\n## What a one-trick on ${champion} would add\n\nThese are half-sentences to attach to a fact the client has already proved. They contain no numbers, deliberately: every figure you say must come from the block.\n\n${lines.join("\n")}`
}

/** Arm 2: the shipped prompt, plus the one permission the fence withholds. */
const SEE_SUPPLEMENT = `

## You may also speak about what you can SEE

Everything above still holds, and this is added to it rather than replacing any of it.

The ranked list is not the only thing you may say. **If the picture shows something useful that
the block cannot state, you may say that instead**, in the same one sentence, ending on the same
kind of action.

What the picture can honestly carry: where he is on the map, where an enemy who is visible on the
minimap right now is, what is on his screen, which objective pit is open, whether a wave is
pushing, whether he is in a corridor with no exit behind him.

The number rules do NOT relax. Every digit you say still has to appear in this message's block.
Read no figure off the HUD — the block is exact and the picture is pixels. One frame is an
instant, so it contains position and never motion or intent: "he is on the minimap in your blue
side" is fair, "he is coming for your red" is invented.

And an empty list is no longer automatically a PASS. If the list is empty but the picture shows
something worth one sentence, say it. If neither has anything, PASS is still the right answer.`

/**
 * Arms 3 and 4 share a persona and a shape, so a difference between them is the RULE and nothing
 * else. Both are written from scratch rather than by deleting paragraphs from the shipped prompt:
 * that prompt is 380 lines of accumulated prohibitions, and an arm meant to measure autonomy
 * cannot be built by trimming a document whose whole subject is restraint.
 */
const PERSONA = `You are Coach Lillia, coaching a jungle main out loud while he plays. You are the friend who is
better than him at this game and wants him to climb more than he does — warm, quick, specific, on
his side. When it is going badly you get kinder, not sharper.

You speak ONE sentence, under 110 characters. Never two, and never two facts: picking the single
most useful thing IS the job.

Every turn you are given a ground-truth block computed from the game client — the roster, the
clock, his line, the enemy jungler, the score, his farm against his own average — and, usually, a
screenshot of his screen at that instant.

**Every line ends on something he can DO in the next thirty seconds.** A sentence that could be
followed by "…so what?" is not finished.

Say units as words: "seconds", "gold", "minutes", never "52s" or "1334g" — this is spoken aloud.

If there is genuinely nothing worth interrupting him for, reply with exactly: PASS`

const CITE_RULE = `

## The one hard rule: cite it or say nothing

**Every number you say must appear verbatim in this message's block, and every name you say must
be one of the ten champions in this message's block.** Nothing else. Not a number you computed
from two numbers in the block, not a number you read off the HUD in the picture, not a champion
you think you recognise from a portrait.

A number belongs to the player whose line it was written on. His gold is on his line; the enemy
jungler's CS is on the enemy jungler's line. Moving a figure from one player to another invents a
statistic even though every digit came from the block.

Anything you cannot cite that way, you may not say. If the useful thing to say would need a fact
you were not given, say nothing instead — PASS. Refusing to guess is the job: a confident wrong
call costs more than ten missed good ones, because after one he stops believing the rest.

Beyond that you are free. Nothing is pre-selected for you and there is no list to choose from.
Read the block, look at the picture, and say the most useful true thing you can.

The picture is yours to use for WHERE THINGS ARE — his position, who is visible on the minimap,
what is on his screen, which pit is open, whether he is in a corridor. One frame is an instant, so
it holds position and never motion or intent: "he is on the minimap in your blue side" is a read,
"he is coming for your red" is a guess. And an enemy who is not on the minimap is unseen, not
absent.

Two things the client never sends and the picture cannot show reliably, so they are never yours to
assert: cooldowns and summoner spells, and what anybody intends.`

const FREE_RULE = `

## Coach him the way a challenger one-trick would

You have full autonomy. Use everything in front of you — the block, the picture, and everything you
know about League of Legends, this champion, this matchup and this stage of the game.

Nothing is pre-selected for you. There is no list to choose from and no fact that has been vetted
on your behalf. Decide for yourself what the most useful thing to say right now is, and say it.

Read the picture properly: his position, the minimap, the wave states, the objective timers, who is
grouped where, what he is standing next to. That is what a coach sitting beside him would be
looking at, and it is why you are given it.

Be the coach he would pay for.`

export interface Arm {
	id: string
	label: string
	/** Does this arm see the fence's ranked list? */
	seesList: boolean
	system: (champion: string) => string
	why: string
}

export const ARMS: Arm[] = [
	{
		id: "fenced",
		label: "FENCED — exactly what ships",
		seesList: true,
		system: () => LIVE_COACH_SYSTEM_PROMPT,
		why: "The baseline. `shared/live-prompt.ts` verbatim, `renderState` verbatim."
	},
	{
		id: "fenced-see",
		label: "FENCED+SEE — the list, plus permission to speak about the picture",
		seesList: true,
		system: () => `${LIVE_COACH_SYSTEM_PROMPT}${SEE_SUPPLEMENT}`,
		why: "Byte-identical block to `fenced`. The cheapest possible test of whether the fence alone is what silences the frame."
	},
	{
		id: "cite-or-quiet",
		label: "CITE-OR-QUIET — no ranked list, one citation rule",
		seesList: false,
		system: champ => `${PERSONA}${CITE_RULE}${championKnowledge(champ)}`,
		why: "The fence's ranked list is cut from the block. Persona, raw ground truth, the picture, the champion's digit-free clauses, and one rule."
	},
	{
		id: "free",
		label: "FREE — full autonomy",
		seesList: false,
		system: champ => `${PERSONA}${FREE_RULE}${championKnowledge(champ)}`,
		why: "Byte-identical stripped block to `cite-or-quiet`. The upper bound on usefulness and, presumably, on fabrication."
	}
]

/* ================================================================== the subject */

/**
 * What a line is ABOUT, as a partition — first match wins, so the mix sums to the spoken count.
 *
 * Crude on purpose. It is here to show whether an arm's subjects move when the picture is removed,
 * not to grade a line.
 */
export const SUBJECTS: { id: string; re: RegExp }[] = [
	{ id: "respawn-window", re: /\b(is down|down for|respawn|dead for|seconds? (?:until|before) (?:he|she|they))\b/i },
	{ id: "objective", re: /\b(drake|dragon|baron|nashor|herald|grub|scuttle|tower|turret|inhibitor|plate)\b/i },
	{ id: "counterpart-race", re: /\b(CS (?:up|down|ahead|behind)|up on|ahead of|behind on|out ?farm)/i },
	{ id: "farm", re: /\b(CS|farm|camps?|clear|route|gromp|wolves|raptors|krugs|blue buff|red buff)\b/i },
	{ id: "gold", re: /\bgold\b/i },
	{ id: "fight", re: /\b(fight|trade|skirmish|teamfight|duel|collapse|dive)\b/i },
	{ id: "position", re: /\b(minimap|screen|river|lane|top ?side|bot ?side|mid|brush|bush|corridor|pit|base|fountain|wall|jungle)\b/i },
	{ id: "praise", re: /\b(nice|great|lovely|beautiful|well done|love (?:it|that)|proud|there we go|that'?s it)\b/i }
]

export const subjectOf = (line: string): string => SUBJECTS.find(s => s.re.test(line))?.id ?? "other"

/**
 * Does the line reference something ONLY the picture could show?
 *
 * The block states no positions at all — it says so in as many words ("It says how much has been
 * cleared and NEVER where anyone is") — so any spatial claim is either read off the frame or
 * invented. Which of the two it is cannot be decided from one cell, and that is the point of
 * running every arm blind as well: an arm that makes spatial claims at the same rate WITHOUT the
 * picture is improvising, whatever it claims.
 */
export const PICTURE_ONLY = [
	/\bminimap\b/i,
	/\bon (?:your|the) screen\b/i,
	/\b(?:top|bot|mid)(?:\s?lane|side)?\b(?!\s*(?:cs|gold))/i,
	/\briver\b/i,
	/\b(?:brush|bush|tri-?brush)\b/i,
	/\b(?:corridor|pit|wall|choke)\b/i,
	/\b(?:blue|red) ?side\b/i,
	/\b(?:their|your|his|her|the enemy) (?:jungle|base|fountain)\b/i,
	/\bwave\b/i,
	/\bpush(?:ing|ed)?\b/i,
	/\b(?:grouped|grouping|stacked up|standing)\b/i,
	/\bnext to you\b/i,
	/\bbehind you\b/i,
	/\bin front of you\b/i,
	/\bhealth bar\b/i,
	/\blow (?:hp|health)\b/i,
	/\brecall(?:ing)?\b/i,
	/\bback(?:ing)? (?:now|home)\b/i
]

export const picturePhrases = (line: string): string[] => {
	const out: string[] = []
	for (const re of PICTURE_ONLY) {
		const m = line.match(re)
		if (m) out.push(m[0])
	}
	return out
}

/* =================================================================== transport */

/*
 * The SDK handle and the `generateText` import are opened by `main`, never at module load.
 *
 * Everything above this line is pure, and `src/analysis/ablate-autonomy.test.ts` imports this file
 * to exercise it. A module that mints a provider handle on import cannot be imported by a test
 * without a key, and a helper that cannot be tested is a helper whose regression nobody notices.
 */
type GenerateText = typeof import("ai").generateText
let generateText: GenerateText | null = null
let handle: Awaited<ReturnType<typeof modelHandleFor>> | null = null

const openTransport = async (): Promise<void> => {
	const provider = providerById("gemini-http")
	if (!provider) throw new Error("gemini-http provider missing")
	const key = providerKey(provider)
	if (!key) {
		console.error("No key in data/gemini.key. This ablation cannot run without it, and it is the")
		console.error("ONLY key on this machine — anthropic.key, openai.key, kimi.key and glm.key are")
		console.error("all absent, which is why this varies the architecture and not the model.")
		process.exit(1)
	}
	generateText = (await import("ai")).generateText
	handle = await modelHandleFor(provider, key, MODEL)
}

const frameCache = new Map<string, string>()
const frameBase64 = (path: string): string => {
	const hit = frameCache.get(path)
	if (hit !== undefined) return hit
	const b = readFileSync(path).toString("base64")
	frameCache.set(path, b)
	return b
}

interface TurnResult {
	ok: boolean
	text: string
	ms: number
	reason?: string
}

/**
 * One turn, shaped exactly like `review/live-providers.ts#coachTurn`.
 *
 * It does NOT go through `coachTurn`, and that is deliberate rather than duplication: `coachTurn`'s
 * whole invariant is that the system prompt is not a parameter, so a comparison run through it
 * cannot vary the prompt — which is the only thing this script varies. It shares the provider
 * plumbing (`modelHandleFor`) so the transport is still decided in one place, and it copies
 * `maxOutputTokens: 2000` for the measured reason recorded there: a tight cap does not shorten a
 * reasoning model, it truncates it mid-number.
 */
const runTurn = async (system: string, block: string, frame: string | null): Promise<TurnResult> => {
	const started = Date.now()
	try {
		const result = await generateText!({
			model: handle!,
			system,
			messages: [
				{
					role: "user",
					content: [
						...(frame ? [{ type: "image" as const, image: frame }] : []),
						{ type: "text" as const, text: block }
					]
				}
			],
			maxOutputTokens: 2000,
			...(Number.isFinite(TEMPERATURE) ? { temperature: TEMPERATURE } : {})
		})
		return { ok: true, text: (result.text ?? "").trim(), ms: Date.now() - started }
	} catch (err) {
		return { ok: false, text: "", ms: Date.now() - started, reason: err instanceof Error ? err.message : String(err) }
	}
}

/* ==================================================================== the cells */

const championVocabulary = (): { names: string[]; source: string } => {
	try {
		const db = new DatabaseSync(DB_PATH, { readOnly: true })
		const row = db.prepare("SELECT value FROM kv WHERE key = 'championNames'").get() as
			| { value: string }
			| undefined
		db.close()
		if (row) {
			const names = Object.values(JSON.parse(row.value) as Record<string, string>).filter(
				n => typeof n === "string" && n !== ""
			)
			if (names.length > 0) return { names, source: `${DB_PATH} kv.championNames` }
		}
	} catch {
		/* the daemon may be mid-write */
	}
	return { names: [], source: "" }
}

export interface CellTurn {
	stateId: string
	tSec: number
	clock: string
	rankedFacts: number
	framePath: string | null
	line: string
	ok: boolean
	reason?: string
	ms: number
	silent: boolean
	faults: CoachFault[]
	fabricated: boolean
	inventedChampions: string[]
	unbackedNumbers: number[]
	misattributed: { value: number; claimedOwner: string }[]
	movement: string[]
	subject: string
	picturePhrases: string[]
	specific: boolean
	useful: boolean
}

export interface Cell {
	set: string
	arm: string
	withFrame: boolean
	turns: CellTurn[]
}

const pool = async <T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> => {
	const out: R[] = new Array(items.length)
	let next = 0
	const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
		for (;;) {
			const i = next++
			if (i >= items.length) return
			out[i] = await fn(items[i]!, i)
		}
	})
	await Promise.all(workers)
	return out
}

/**
 * A line is SPECIFIC when it could not have been said about a different game or a different minute:
 * it carries a figure, or it names somebody in this game other than him.
 *
 * This is the mechanical half of the second test in AGENTS.md ("could this sentence have been said
 * in a different game, or five minutes ago in this one?"). It is a floor, not a verdict — a line
 * can be specific and still worthless.
 */
export const isSpecific = (line: string, roster: readonly string[], me: string): boolean => {
	if (/\d/.test(line)) return true
	const lower = line.toLowerCase()
	return roster.some(c => c !== me && lower.includes(c.toLowerCase()))
}

const runCell = async (
	setName: string,
	arm: Arm,
	withFrame: boolean,
	states: AblationState[],
	vocabulary: readonly string[]
): Promise<Cell> => {
	const turns = await pool(states, CONCURRENCY, async state => {
		const block = arm.seesList ? state.block : state.blockNoList
		const frame = withFrame && state.framePath ? frameBase64(state.framePath) : null
		const r = await runTurn(arm.system(state.roster[0] ?? ""), block, frame)
		const line = r.text
		const score: LineScore =
			r.ok && !isEmpty(line) ?
				scoreLine({ line, block, roster: state.roster, champions: vocabulary })
			:	{
					silent: true,
					faults: [],
					inventedChampions: [],
					unbackedNumbers: [],
					misattributed: [],
					movement: [],
					normalized: ""
				}
		const fabricated = score.faults.some(f => (FABRICATION_FAULTS as readonly string[]).includes(f))
		const specific = !score.silent && isSpecific(line, state.roster, state.roster[0] ?? "")
		const turn: CellTurn = {
			stateId: state.id,
			tSec: state.tSec,
			clock: state.clock,
			rankedFacts: state.rankedFacts,
			framePath: frame ? state.framePath : null,
			line,
			ok: r.ok,
			...(r.reason ? { reason: r.reason } : {}),
			ms: r.ms,
			silent: score.silent,
			faults: score.faults,
			fabricated,
			inventedChampions: score.inventedChampions,
			unbackedNumbers: score.unbackedNumbers,
			misattributed: score.misattributed,
			movement: score.movement,
			subject: score.silent ? "-" : subjectOf(line),
			picturePhrases: score.silent ? [] : picturePhrases(line),
			specific,
			useful:
				!score.silent &&
				!fabricated &&
				specific &&
				!score.faults.includes("no-alternative") &&
				!score.faults.includes("visible-only")
		}
		return turn
	})
	return { set: setName, arm: arm.id, withFrame, turns }
}

/* ==================================================================== reporting */

const pct = (i: Interval): string => `${(i.p * 100).toFixed(0)}% [${(i.lo * 100).toFixed(0)}–${(i.hi * 100).toFixed(0)}]`

export interface CellStats {
	set: string
	arm: string
	withFrame: boolean
	turns: number
	errors: number
	spoke: number
	spokeRate: Interval
	/** Of SPOKEN lines. Silences are excluded from every rate, as `coach-score` requires. */
	fabrication: Interval
	unbacked: Interval
	misattributed: Interval
	inventedChampion: Interval
	inventedMovement: Interval
	visibleOnly: Interval
	noAlternative: Interval
	specific: Interval
	useful: Interval
	/** Useful lines per minute of game clock covered by the set. */
	usefulPerMin: number
	linesPerMin: number
	distinctLines: number
	pictureRefLines: Interval
	medianMs: number
	p90Ms: number
	subjects: Record<string, number>
}

export const median = (xs: number[]): number => {
	if (xs.length === 0) return 0
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.floor(s.length / 2)]!
}
export const quantile = (xs: number[], q: number): number => {
	if (xs.length === 0) return 0
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.min(s.length - 1, Math.floor(q * s.length))]!
}

export const statsFor = (cell: Cell, minutes: number): CellStats => {
	const ok = cell.turns.filter(t => t.ok)
	const spoken = ok.filter(t => !t.silent)
	const n = spoken.length
	const has = (f: CoachFault) => spoken.filter(t => t.faults.includes(f)).length
	const subjects: Record<string, number> = {}
	for (const t of spoken) subjects[t.subject] = (subjects[t.subject] ?? 0) + 1
	const usefulCount = spoken.filter(t => t.useful).length
	return {
		set: cell.set,
		arm: cell.arm,
		withFrame: cell.withFrame,
		turns: cell.turns.length,
		errors: cell.turns.length - ok.length,
		spoke: n,
		spokeRate: wilson(n, ok.length),
		fabrication: wilson(spoken.filter(t => t.fabricated).length, n),
		unbacked: wilson(has("unbacked-number"), n),
		misattributed: wilson(has("misattributed-number"), n),
		inventedChampion: wilson(has("invented-champion"), n),
		inventedMovement: wilson(has("invented-movement"), n),
		visibleOnly: wilson(has("visible-only"), n),
		noAlternative: wilson(has("no-alternative"), n),
		specific: wilson(spoken.filter(t => t.specific).length, n),
		useful: wilson(usefulCount, n),
		usefulPerMin: minutes > 0 ? usefulCount / minutes : 0,
		linesPerMin: minutes > 0 ? n / minutes : 0,
		distinctLines: new Set(spoken.map(t => t.line.toLowerCase().replace(/[^a-z0-9 ]/g, ""))).size,
		pictureRefLines: wilson(spoken.filter(t => t.picturePhrases.length > 0).length, n),
		medianMs: median(ok.map(t => t.ms)),
		p90Ms: quantile(ok.map(t => t.ms), 0.9),
		subjects
	}
}

/* ======================================================================== run */

/**
 * Everything with a side effect lives here, so importing this file costs nothing.
 *
 * `import.meta.main` is false when a test imports it, which is what lets
 * `src/analysis/ablate-autonomy.test.ts` exercise the block surgery, the arm prompts and the
 * scoring helpers without a key, a bill, or a game.
 */
const main = async (): Promise<void> => {
	await openTransport()

	const { paired, late, note } = buildStates()
	const vocab = championVocabulary()
	const armIds = arg("arms", ARMS.map(a => a.id).join(",")).split(",").map(s => s.trim()).filter(s => s !== "")
	const arms = ARMS.filter(a => armIds.includes(a.id))
	if (arms.length === 0) throw new Error(`no arms matched ${armIds.join(",")}`)

	const pairedStates = LIMIT > 0 ? paired.slice(0, LIMIT) : paired
	const lateStates = RUN_LATE ? (LIMIT > 0 ? late.slice(0, LIMIT) : late) : []

	const span = (s: AblationState[]): number =>
		s.length === 0 ? 0 : (s[s.length - 1]!.tSec - s[0]!.tSec) / 60

	console.log(`ablate-autonomy — architecture held against itself, model held constant`)
	console.log(`  model        ${MODEL} (gemini-http, the only key on this machine)`)
	console.log(`  temperature  ${TEMPERATURE}`)
	console.log(`  samples      data/live-samples/${SAMPLE_FILE}.ndjson, game ${GAME_ID}`)
	console.log(`  ${note}`)
	console.log(`  PAIRED       ${pairedStates.length} states, ${pairedStates[0]?.clock ?? "-"}–${pairedStates[pairedStates.length - 1]?.clock ?? "-"}, every arm twice`)
	console.log(`  LATE         ${lateStates.length} states, ${lateStates[0]?.clock ?? "-"}–${lateStates[lateStates.length - 1]?.clock ?? "-"}, text only`)
	console.log(`  arms         ${arms.map(a => a.id).join(", ")}`)
	const totalCalls = pairedStates.length * arms.length * 2 + lateStates.length * arms.length
	console.log(`  calls        ${totalCalls}`)
	console.log(`  ranked facts ${pairedStates.filter(s => s.rankedFacts > 0).length}/${pairedStates.length} PAIRED, ${lateStates.filter(s => s.rankedFacts > 0).length}/${lateStates.length} LATE states carry one`)
	console.log("")

	const cells: Cell[] = []
	for (const arm of arms) {
		for (const withFrame of [true, false]) {
			if (pairedStates.length === 0) continue
			const t0 = Date.now()
			const cell = await runCell("paired", arm, withFrame, pairedStates, vocab.names)
			cells.push(cell)
			const st = statsFor(cell, span(pairedStates))
			console.log(
				`paired ${arm.id.padEnd(14)} ${withFrame ? "with-frame" : "no-frame  "}  spoke ${String(st.spoke).padStart(2)}/${st.turns}  fabrication ${pct(st.fabrication)}  useful ${pct(st.useful)}  ${((Date.now() - t0) / 1000).toFixed(0)}s`
			)
		}
		if (lateStates.length > 0) {
			const cell = await runCell("late", arm, false, lateStates, vocab.names)
			cells.push(cell)
			const st = statsFor(cell, span(lateStates))
			console.log(
				`late   ${arm.id.padEnd(14)} no-frame    spoke ${String(st.spoke).padStart(2)}/${st.turns}  fabrication ${pct(st.fabrication)}  useful ${pct(st.useful)}`
			)
		}
	}

	/* ------------------------------------------------------------ frame sensitivity */

	/**
	 * The test the whole run exists for.
	 *
	 * An arm whose speak/PASS decision and whose subject matter do not move when the picture is taken
	 * away is not using the picture, whatever its prompt says it may do. The fenced baseline on the
	 * real socket was 13 of 14 identical; anything near that is an arm coaching from text.
	 */
	interface FrameSensitivity {
		arm: string
		states: number
		/** Turns where with-frame and no-frame made the same speak-or-PASS call. */
		decisionAgreement: Interval
		/** Of turns where BOTH spoke, how often the two lines were textually identical. */
		bothSpoke: number
		identicalLines: Interval
		pictureRefWithFrame: Interval
		pictureRefNoFrame: Interval
		pictureRefSeparated: boolean
		spokeWithFrame: Interval
		spokeNoFrame: Interval
	}

	const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "")

	const sensitivity: FrameSensitivity[] = []
	for (const arm of arms) {
		const withC = cells.find(c => c.set === "paired" && c.arm === arm.id && c.withFrame)
		const noC = cells.find(c => c.set === "paired" && c.arm === arm.id && !c.withFrame)
		if (!withC || !noC) continue
		let agree = 0
		let both = 0
		let identical = 0
		let n = 0
		for (let i = 0; i < withC.turns.length; i++) {
			const a = withC.turns[i]!
			const b = noC.turns[i]!
			if (!a.ok || !b.ok) continue
			n++
			if (a.silent === b.silent) agree++
			if (!a.silent && !b.silent) {
				both++
				if (norm(a.line) === norm(b.line)) identical++
			}
		}
		const wf = statsFor(withC, span(pairedStates))
		const nf = statsFor(noC, span(pairedStates))
		sensitivity.push({
			arm: arm.id,
			states: n,
			decisionAgreement: wilson(agree, n),
			bothSpoke: both,
			identicalLines: wilson(identical, both),
			pictureRefWithFrame: wf.pictureRefLines,
			pictureRefNoFrame: nf.pictureRefLines,
			pictureRefSeparated: separated(wf.pictureRefLines, nf.pictureRefLines),
			spokeWithFrame: wf.spokeRate,
			spokeNoFrame: nf.spokeRate
		})
	}

	/* ------------------------------------------------------------------- the trade */

	/**
	 * What each arm says in the states where the fenced coach is structurally silent.
	 *
	 * This is the cost of the fence stated directly: a state whose ranked list is empty is a state the
	 * shipped coach CANNOT speak in, however much is on the screen.
	 */
	interface Rescue {
		arm: string
		set: string
		emptyListStates: number
		spokeThere: Interval
		fabricatedThere: Interval
		usefulThere: Interval
		examples: { clock: string; line: string; faults: CoachFault[] }[]
	}

	const rescues: Rescue[] = []
	for (const cell of cells) {
		if (cell.withFrame === false && cell.set === "paired") continue
		const empty = cell.turns.filter(t => t.ok && t.rankedFacts === 0)
		const spoken = empty.filter(t => !t.silent)
		rescues.push({
			arm: cell.arm,
			set: cell.set,
			emptyListStates: empty.length,
			spokeThere: wilson(spoken.length, empty.length),
			fabricatedThere: wilson(spoken.filter(t => t.fabricated).length, spoken.length),
			usefulThere: wilson(spoken.filter(t => t.useful).length, spoken.length),
			examples: spoken.slice(0, 8).map(t => ({ clock: t.clock, line: t.line, faults: t.faults }))
		})
	}

	/* --------------------------------------------------------------------- output */

	const allStats = cells.map(c => statsFor(c, span(c.set === "paired" ? pairedStates : lateStates)))

	const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16)

	const run = {
		kind: "ablate-autonomy",
		built: Date.now(),
		stamp,
		question:
			"The fence is measured safe. What does it COST? Model held constant, architecture varied: how much usefulness does speak-only-from-the-ranked-list give up, and is there a middle setting that keeps fabrication at zero while letting the picture matter?",
		limits: [
			"ONE MODEL. data/gemini.key is the only key on this machine — anthropic.key, openai.key, kimi.key and glm.key are all absent, and the `claude -p` CLI path cannot attach an image. The cross-MODEL comparison could not run. This varies only the ARCHITECTURE.",
			"`analysis/coach-score.ts` validates FORM, not TRUTH. It catches a champion who is not in the game, a figure that is not in the block, a figure attached to the wrong player, and asserted motion or intent. It CANNOT catch a false statement about League that contains no digit and no roster name — a wrong claim about what an item does, a wrong claim about a champion's kit, a wrong claim about what a jungler should do at this minute. A false champion claim passed straight through the digit fence earlier tonight. The FREE arm is exactly where that failure would live, so its fabrication rate is a FLOOR and not a measurement.",
			"Frames exist only for 0:02–6:43 of this game. There are no replays left for it, so the PAIRED set cannot be widened, and every frame-sensitivity number here is an EARLY-GAME number.",
			"These are turn-based HTTPS calls with no conversation thread, so no arm can obey the prompt's 'do not say the same thing twice' rules. All four arms are equally memoryless, so the comparison is fair, but the repetition figures are worse than the shipped socket's would be.",
			"A few frames pair with the same sample, so a handful of PAIRED states carry the same block with a picture taken about five seconds apart. Treat those as one state seen twice.",
			"`useful` is a mechanical composite (spoke AND no fabrication fault AND carries a figure or a roster name AND names an action AND is not a screen readback). It is a floor on quality, never a verdict — read the lines."
		],
		config: {
			model: MODEL,
			provider: "gemini-http",
			temperature: TEMPERATURE,
			maxOutputTokens: 2000,
			concurrency: CONCURRENCY,
			samples: `data/live-samples/${SAMPLE_FILE}.ndjson`,
			gameId: GAME_ID,
			frameSkewGateSec: FRAME_SKEW_GATE_SEC,
			lateSpacingSec: LATE_SPACING_SEC,
			championVocabulary: { count: vocab.names.length, source: vocab.source },
			stateNote: note
		},
		blockSurgery: {
			what: "Arms 3 and 4 see the block with the fence's own output removed — the 'What he is NOT looking at' list, or the explicit empty-case paragraph that stands in for it. Every other byte of ground truth is identical.",
			removedFrom: LIST_HEADINGS,
			removedTo: "**The ten champions above",
			repaired: REPAIRS,
			why: "A dangling pointer at a list that is no longer there is not neutral: it tells the model something was withheld. The farm-baseline parenthetical is worse than dangling — it is the fence gating a fact, sitting inside the ground truth, so removing the list without it would have gagged the unfenced arms on farm."
		},
		arms: arms.map(a => ({
			id: a.id,
			label: a.label,
			seesRankedList: a.seesList,
			why: a.why,
			systemPromptSha: sha(a.system("Lillia")),
			systemPromptChars: a.system("Lillia").length,
			systemPrompt: a.system("Lillia")
		})),
		states: {
			paired: pairedStates.map(s => ({
				id: s.id,
				tSec: s.tSec,
				clock: s.clock,
				framePath: s.framePath,
				frameSkewSec: s.frameSkewSec,
				rankedFacts: s.rankedFacts,
				roster: s.roster,
				block: s.block,
				blockNoList: s.blockNoList
			})),
			late: lateStates.map(s => ({
				id: s.id,
				tSec: s.tSec,
				clock: s.clock,
				rankedFacts: s.rankedFacts,
				roster: s.roster,
				block: s.block,
				blockNoList: s.blockNoList
			}))
		},
		cells,
		stats: allStats,
		frameSensitivity: sensitivity,
		rescue: rescues
	}

	mkdirSync(`${DATA_DIR}/eval`, { recursive: true })
	if (existsSync(OUT)) throw new Error(`${OUT} exists — every measurement is kept, nothing is overwritten`)
	writeFileSync(OUT, `${JSON.stringify(run, null, 1)}\n`)

	/* --------------------------------------------------------------------- print */

	const line = (s: string) => console.log(s)
	line("")
	line("=== SPOKE / FABRICATION / USEFULNESS ===================================")
	line("set     arm             frame  spoke        fabricate    useful       specific     readback     no-action    med ms")
	for (const s of allStats)
		line(
			`${s.set.padEnd(7)} ${s.arm.padEnd(15)} ${(s.withFrame ? "yes" : "no").padEnd(6)} ` +
				`${pct(s.spokeRate).padEnd(12)} ${pct(s.fabrication).padEnd(12)} ${pct(s.useful).padEnd(12)} ` +
				`${pct(s.specific).padEnd(12)} ${pct(s.visibleOnly).padEnd(12)} ${pct(s.noAlternative).padEnd(12)} ${s.medianMs}`
		)

	line("")
	line("=== FRAME SENSITIVITY (PAIRED, with-picture against blind) =============")
	line("arm             states  same speak/PASS   both spoke  identical text   picture-ref with   picture-ref blind  separated")
	for (const f of sensitivity)
		line(
			`${f.arm.padEnd(15)} ${String(f.states).padStart(6)}  ${pct(f.decisionAgreement).padEnd(16)}  ` +
				`${String(f.bothSpoke).padStart(10)}  ${pct(f.identicalLines).padEnd(15)}  ${pct(f.pictureRefWithFrame).padEnd(17)}  ` +
				`${pct(f.pictureRefNoFrame).padEnd(17)}  ${f.pictureRefSeparated ? "YES" : "no"}`
		)

	line("")
	line("=== WHAT THE FENCE SILENCES (states whose ranked list is empty) ========")
	line("set     arm             empty states  spoke there   fabricated    useful")
	for (const r of rescues)
		line(
			`${r.set.padEnd(7)} ${r.arm.padEnd(15)} ${String(r.emptyListStates).padStart(12)}  ${pct(r.spokeThere).padEnd(12)}  ` +
				`${pct(r.fabricatedThere).padEnd(12)}  ${pct(r.usefulThere)}`
		)

	line("")
	line("=== SUBJECT MIX (spoken lines) =========================================")
	for (const s of allStats)
		line(
			`${s.set.padEnd(7)} ${s.arm.padEnd(15)} ${(s.withFrame ? "frame" : "blind").padEnd(6)} ` +
				`${Object.entries(s.subjects).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ")}`
		)

	line("")
	line(`written ${OUT}`)

}

if (import.meta.main) await main()
