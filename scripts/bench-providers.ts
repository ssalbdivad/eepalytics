/**
 * The cross-model hallucination benchmark.
 *
 * ## The question this answers
 *
 * *"Gemini seems to have a very high hallucination rate."* That may be true, and it may be that
 * any model given a downscaled screenshot and asked to coach would do the same. The two have
 * completely different fixes — one is "change the model", the other is "change the architecture" —
 * and nothing shipped so far can tell them apart, because only one model has ever been run.
 *
 * So this is a measurement instrument first and a feature second. It replays a **fixed** set of
 * reconstructed game states through every configured provider and model, holding constant:
 *
 *   - the system prompt          `src/shared/live-prompt.ts`, the one the app ships
 *   - the ground-truth block     `renderState`, the one the app ships
 *   - the frame                  one JPEG, byte-identical for every arm
 *   - the turn sequence          same states, same order, same session boundaries
 *
 * and varying only the model. What comes back is scored by `src/analysis/coach-score.ts`, which is
 * pure and unit tested, so the verdict on a line does not depend on which arm produced it.
 *
 * ## What this instrument CANNOT tell you — read before quoting a number
 *
 * 1. **The frame does not match the state.** States are reconstructed from stored post-game
 *    timelines (there is no recording of live-client samples yet), and the frame is one saved
 *    screenshot. So the picture and the block describe different moments. This is identical for
 *    every arm, so *comparisons between arms are valid*; the *absolute* rates are not a forecast
 *    of a real game. `scripts/eval-live.ts` has the same limitation for the same reason.
 * 2. **Gemini Live is not only a different model, it is a different modality.** It is a native-
 *    audio socket read back through `outputAudioTranscription`; every other arm is HTTP text. If
 *    the audio arm looks worse, that is a finding about the shipped path, not yet a finding about
 *    the model — which is exactly why the `gemini` arm exists: same family, text, over HTTP. Run
 *    both and the difference between them is the modality, not the vendor.
 * 3. **Conversation memory differs.** Gemini Live keeps a real session and can see what it already
 *    said; the HTTP arms are handed the prior turns back as messages (block in, line out, no prior
 *    images, to keep the cost sane). The `--stateless` flag turns that off so you can measure how
 *    much of the difference is memory.
 * 4. **n is small unless you make it large.** Every rate is printed with a Wilson 95% interval and
 *    a conservative pairwise separation test, and the summary says outright when two arms are not
 *    distinguishable. Raise `--turns` and `--repeats` before believing a gap.
 *
 * ## Usage
 *
 *     node --env-file-if-exists=.env --experimental-strip-types scripts/bench-providers.ts --list
 *     node --env-file-if-exists=.env --experimental-strip-types scripts/bench-providers.ts \
 *       --turns 24 --only gemini-live,gemini,anthropic --out data/bench/run1.json
 *
 * Useful flags:
 *
 *     --list                    print every provider, its model, and whether it has a key
 *     --list-models <provider>  ask the provider's API what models it actually serves
 *     --states <path>           a frozen fixture, or any `eval-live --out` report (default: newest)
 *     --freeze <path>           write the selected states out so future runs use the same set
 *     --turns N                 how many states (default 12), spread evenly across the fixture
 *     --repeats N               run the whole set N times per arm; multiplies n, not the states
 *     --models "openai=gpt-5,openai=gpt-4.1"   one arm per pair; repeat a provider for two models
 *     --only a,b                restrict to these providers
 *     --stateless               do not feed prior turns back to the HTTP arms
 *     --no-frame                text-only for every arm — isolates how much the picture costs
 *     --max-tokens N            output budget (default 1024; reasoning models spend it silently)
 *     --temperature X           set it on every arm that accepts one; unset means each vendor's default
 *     --with-mock               include the canned self-test arm
 *     --verbose                 print every line with its faults
 *     --out <path>              write the full run as JSON
 *
 * DO NOT run this while a game is in progress. It touches no League API and no LCU endpoint, but
 * it does hold a Gemini Live socket open, and the live coach wants that socket.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { spawn } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { type } from "arktype"
import { DATA_DIR, DB_PATH } from "../src/shared/constants.ts"
import { renderState } from "../src/shared/live-state.ts"
import type { VisionState, VisionStatePlayer } from "../src/shared/live-state.ts"
import { LIVE_COACH_SYSTEM_PROMPT } from "../src/shared/live-prompt.ts"
import { GEMINI_LIVE_MODEL, geminiKey, mintGeminiToken } from "../src/review/gemini-live.ts"
import {
	FABRICATION_FAULTS,
	WEAKNESS_FAULTS,
	scoreLine,
	separated,
	wilson
} from "../src/analysis/coach-score.ts"
import type { CoachFault, Interval, LineScore } from "../src/analysis/coach-score.ts"
import { coachTurn, providerById as sharedProvider } from "../src/review/live-providers.ts"

/* =============================================================== live samples */

/**
 * Build bench states from a real game's recorded `allgamedata`.
 *
 * Deliberately goes through the daemon's own `buildLiveState`, so what is replayed is the block the
 * coach actually held rather than a second reconstruction that could drift from it. A sample that
 * cannot produce a state — the loading screen, a torn line — is skipped rather than faked.
 */
const loadSampledStates = async (gameId: string): Promise<BenchState[]> => {
	const { readSamples, sampledGames } = await import("../src/daemon/live-sampler.ts")
	const id =
		gameId === "latest" ? (sampledGames()[0]?.gameId ?? "") : gameId
	if (id === "") throw new Error("no live samples on disk yet — play a game with the daemon running")
	const rows = readSamples(id)
	if (rows.length === 0) throw new Error(`no samples for ${id}`)

	const { buildLiveStateForBench } = await import("../src/server/routes/live.ts")
	const out: BenchState[] = []
	for (const row of rows) {
		const st = buildLiveStateForBench(row.data, row.gameTime)
		if (!st) continue
		out.push({
			gameId: id,
			atSec: row.gameTime,
			state: st,
			block: renderState(st),
			roster: [st.me.champion, ...st.allies.map(p => p.champion), ...st.enemies.map(p => p.champion)]
		})
	}
	return out
}

/* ================================================================= arguments */

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback
}
const flag = (name: string): boolean => argv.includes(`--${name}`)

/* ================================================================= providers */

type ProviderKind = "gemini-live" | "openai" | "anthropic" | "claude-cli" | "mock"

interface Provider {
	id: string
	kind: ProviderKind
	/** What is used when `--models` does not name one. Check it with `--list-models`. */
	defaultModel: string
	/** Environment variables consulted, in order. */
	env: readonly string[]
	/**
	 * `data/<file>` — read BEFORE the environment, at 0600, exactly as `data/gemini.key` is.
	 *
	 * The pattern is deliberate and is documented in `src/review/gemini-live.ts`: a key in the
	 * settings table would round-trip through `GET /api/settings` into the renderer. Any provider
	 * added here inherits that rule; nothing in this script ever writes a key, and no key is ever
	 * echoed into output, including into an error message.
	 */
	keyFile: string | null
	baseUrl?: string
	baseUrlEnv?: string
	/** Does this arm receive the frame at all? */
	vision: boolean
	/** Printed verbatim when the arm has no credential. This is the owner's to-do list. */
	need: string
}

const PROVIDERS: Provider[] = [
	{
		id: "gemini-live",
		kind: "gemini-live",
		defaultModel: GEMINI_LIVE_MODEL,
		env: ["GEMINI_API_KEY"],
		keyFile: "gemini.key",
		vision: true,
		need: "an AI Studio key in data/gemini.key (Settings writes it) or GEMINI_API_KEY. Already present on this machine."
	},
	{
		/*
		 * The same vendor over plain HTTP, through Google's OpenAI-compatible shim.
		 *
		 * This arm is the whole reason the benchmark can answer the owner's question rather than
		 * restate it: `gemini-live` differs from every other arm in TWO ways at once (the model and
		 * the audio modality), and a two-variable difference explains nothing. This one changes
		 * only the model.
		 */
		id: "gemini",
		kind: "openai",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
		baseUrlEnv: "GEMINI_OPENAI_BASE_URL",
		/*
		 * Verified reachable on this key on 2026-09-04; `gemini-2.5-flash` answers 404 with
		 * "no longer available to new users, use models/gemini-3.6-flash". Model ids move, so this
		 * default is a starting point and `--list-models gemini` is the source of truth.
		 *
		 * For the modality comparison specifically, pick the TEXT model closest to the live one
		 * (`--models gemini=gemini-3-flash-preview` against a `gemini-3.1-flash-live-preview`
		 * socket). A 3.6 against a 3.1 measures two things at once, which is the mistake this arm
		 * exists to avoid.
		 */
		defaultModel: "gemini-3.6-flash",
		env: ["GEMINI_API_KEY"],
		keyFile: "gemini.key",
		vision: true,
		need: "the same key as gemini-live. Confirm the model id with --list-models gemini."
	},
	{
		id: "anthropic",
		kind: "anthropic",
		baseUrl: "https://api.anthropic.com",
		baseUrlEnv: "ANTHROPIC_BASE_URL",
		defaultModel: "claude-sonnet-5",
		env: ["ANTHROPIC_API_KEY"],
		keyFile: "anthropic.key",
		vision: true,
		need: "an API key in data/anthropic.key or ANTHROPIC_API_KEY. The `claude` CLI login does NOT work here — print mode cannot carry an image."
	},
	{
		/*
		 * The subscription CLI, TEXT ONLY — and useful precisely because of that.
		 *
		 * `claude -p` has no way to attach an image, so this arm cannot see the frame. That makes
		 * it the control: same prompt, same block, no picture. The gap between it and a vision arm
		 * on the same family is how much of the fabrication the SCREENSHOT is responsible for,
		 * which is a question nobody has been able to ask so far.
		 */
		id: "claude-cli",
		kind: "claude-cli",
		defaultModel: "claude-sonnet-5",
		env: [],
		keyFile: null,
		vision: false,
		need: "nothing — it uses the existing `claude` CLI login. Set CSK_CLAUDE_BIN if it is not on PATH."
	},
	{
		id: "openai",
		kind: "openai",
		baseUrl: "https://api.openai.com/v1",
		baseUrlEnv: "OPENAI_BASE_URL",
		defaultModel: "gpt-5",
		env: ["OPENAI_API_KEY"],
		keyFile: "openai.key",
		vision: true,
		need: "an API key in data/openai.key or OPENAI_API_KEY. Confirm the model id with --list-models openai."
	},
	{
		id: "kimi",
		kind: "openai",
		baseUrl: "https://api.moonshot.ai/v1",
		baseUrlEnv: "MOONSHOT_BASE_URL",
		defaultModel: "kimi-latest",
		env: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
		keyFile: "kimi.key",
		vision: true,
		need: "a Moonshot key in data/kimi.key or MOONSHOT_API_KEY. Use MOONSHOT_BASE_URL for the .cn endpoint. The model must be a VISION model."
	},
	{
		id: "glm",
		kind: "openai",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		baseUrlEnv: "GLM_BASE_URL",
		defaultModel: "glm-4.5v",
		env: ["ZHIPU_API_KEY", "GLM_API_KEY"],
		keyFile: "glm.key",
		vision: true,
		need: "a Zhipu key in data/glm.key or ZHIPU_API_KEY. Set GLM_BASE_URL=https://api.z.ai/api/paas/v4 for the international endpoint."
	},
	{
		/*
		 * One key, every vendor. The pragmatic answer to "and a few others ideally": rather than
		 * six accounts, one OpenRouter key reaches Kimi, GLM, Qwen, Llama and the rest, and the
		 * model id carries the vendor ("moonshotai/kimi-k2", "z-ai/glm-4.6").
		 */
		id: "openrouter",
		kind: "openai",
		baseUrl: "https://openrouter.ai/api/v1",
		baseUrlEnv: "OPENROUTER_BASE_URL",
		defaultModel: "",
		env: ["OPENROUTER_API_KEY"],
		keyFile: "openrouter.key",
		vision: true,
		need: "a key in data/openrouter.key or OPENROUTER_API_KEY, plus an explicit --models openrouter=<vendor/model>."
	},
	{
		/*
		 * Not a model. A fixed script of lines — some clean, some carrying each fault on purpose —
		 * so the harness, the scorer and the table can be exercised end to end without a key and
		 * without spending anything. If the mock arm's numbers ever come out wrong, the instrument
		 * is broken and no result from it means anything.
		 */
		id: "mock",
		kind: "mock",
		defaultModel: "canned",
		env: [],
		keyFile: null,
		vision: false,
		need: "nothing. This arm is a self-test of the harness, not a model."
	}
]

const providerById = (id: string): Provider | undefined => PROVIDERS.find(p => p.id === id)

/**
 * File first, environment second — the same order and the same 0600 file convention as
 * `geminiKey()`.
 *
 * When the shared provider-key store lands (another track owns it), this function should become a
 * call into it. The contract it must honour is exactly this one: a per-provider file under
 * `DATA_DIR` at 0600, never the settings table, never echoed back to the renderer.
 */
const providerKey = (p: Provider): string => {
	if (p.id === "gemini-live" || p.id === "gemini") return geminiKey()
	if (p.keyFile !== null)
		try {
			const fromFile = readFileSync(`${DATA_DIR}/${p.keyFile}`, "utf8").trim()
			if (fromFile !== "") return fromFile
		} catch {
			/* not set yet — fall through to the environment */
		}
	for (const name of p.env) {
		const v = (process.env[name] ?? "").trim()
		if (v !== "") return v
	}
	return ""
}

const baseUrlOf = (p: Provider): string =>
	(p.baseUrlEnv ? (process.env[p.baseUrlEnv] ?? "").trim() : "") || (p.baseUrl ?? "")

/* ==================================================== the fixed set of states */

/**
 * States are validated at the boundary, not trusted.
 *
 * The files this reads are old `eval-live --out` reports, written before `pace`, `counterpart` and
 * `pronounce` existed on `VisionState`. A missing field must become an explicit default rather
 * than `undefined` reaching `renderState`, because the "NONE" farm-baseline line is itself a
 * measured anti-hallucination device: the block states the absence out loud so the model has no
 * gap to fill.
 */
const StoredPlayer = type({
	champion: "string",
	"level?": "number",
	"k?": "number",
	"d?": "number",
	"a?": "number",
	"dead?": "boolean",
	"respawnSec?": "number"
})

const StoredState = type({
	clock: "string",
	me: {
		champion: "string",
		"level?": "number",
		"hp?": "number",
		"maxHp?": "number",
		"gold?": "number",
		"k?": "number",
		"d?": "number",
		"a?": "number",
		"cs?": "number",
		"dead?": "boolean",
		"respawnSec?": "number"
	},
	allies: StoredPlayer.array(),
	enemies: StoredPlayer.array(),
	"recentEvents?": "string[]",
	"unseen?": "string[]"
})

const Pace = type({ cs: "number", expected: "number", exact: "boolean", source: "string" })
const Counterpart = type({ champion: "string", "cs?": "number", "level?": "number", "inferred?": "boolean" })
const Pronunciation = type({ name: "string", say: "string" })

interface BenchState {
	gameId: string
	atSec: number
	state: VisionState
	/** `renderState(state)`, computed ONCE and reused by every arm. */
	block: string
	roster: string[]
}

const toVisionState = (raw: unknown): VisionState | null => {
	const base = StoredState(raw)
	if (base instanceof type.errors) return null
	const loose = raw as Record<string, unknown>
	const pace = Pace(loose.pace)
	const counterpart = Counterpart(loose.counterpart)
	const pronounce = Pronunciation.array()(loose.pronounce)
	return {
		clock: base.clock,
		me: base.me,
		pace: pace instanceof type.errors ? null : pace,
		counterpart: counterpart instanceof type.errors ? null : counterpart,
		pronounce: pronounce instanceof type.errors ? [] : pronounce,
		allies: base.allies as VisionStatePlayer[],
		enemies: base.enemies as VisionStatePlayer[],
		recentEvents: base.recentEvents ?? [],
		unseen: base.unseen ?? []
	}
}

/**
 * Accepts three shapes, because the states worth benchmarking already exist in two of them:
 *
 *   - a frozen fixture written by `--freeze` (the reproducible one — prefer this)
 *   - an `eval-live --out` report, whose `scored[].said.state` is a real reconstructed block
 *   - a bare array of `VisionState`
 */
const loadStates = (path: string): BenchState[] => {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
	const rows: { gameId: string; atSec: number; raw: unknown }[] = []
	const obj = parsed as Record<string, unknown>
	if (Array.isArray(obj.states))
		for (const s of obj.states as Record<string, unknown>[])
			rows.push({ gameId: String(s.gameId ?? "?"), atSec: Number(s.atSec ?? 0), raw: s.state })
	else if (Array.isArray(obj.scored))
		for (const s of obj.scored as { said?: Record<string, unknown> }[])
			rows.push({
				gameId: String(s.said?.gameId ?? "?"),
				atSec: Number(s.said?.atSec ?? 0),
				raw: s.said?.state
			})
	else if (Array.isArray(parsed))
		for (const [i, s] of (parsed as unknown[]).entries())
			rows.push({ gameId: "?", atSec: i, raw: s })

	const out: BenchState[] = []
	const seen = new Set<string>()
	for (const r of rows) {
		const key = `${r.gameId}@${r.atSec}`
		if (seen.has(key)) continue
		const state = toVisionState(r.raw)
		if (!state) continue
		seen.add(key)
		out.push({
			gameId: r.gameId,
			atSec: r.atSec,
			state,
			block: renderState(state),
			roster: [state.me.champion, ...state.allies.map(p => p.champion), ...state.enemies.map(p => p.champion)]
		})
	}
	return out
}

/**
 * Evenly spaced, deterministic. No sampling randomness: two runs must select the same states.
 *
 * The half-step offset is not cosmetic. Fixtures are laid out game by game, so an aligned stride
 * lands on the first state of each game and `--turns 3` over three games returned the 4:00 mark
 * three times — a sample with no late game in it at all, which is where most of the coach's
 * fabrications live.
 */
const spread = <T>(items: T[], want: number): T[] => {
	if (want >= items.length || want <= 0) return items
	const out: T[] = []
	for (let i = 0; i < want; i++) out.push(items[Math.floor(((i + 0.5) * items.length) / want)]!)
	return out
}

/* ============================================================ the vocabulary */

/**
 * Every champion that exists, from the client's own `championId -> name` map.
 *
 * Without it `invented-champion` cannot fire at all — a name the scorer has never heard of is a
 * name it cannot classify, and the ten in the block are by definition not invented. So a missing
 * vocabulary is reported loudly and the column is marked `n/a` rather than printed as a zero. A
 * zero here would be the single most misleading number this tool could produce.
 */
const championVocabulary = (): { names: string[]; source: string } => {
	const override = arg("champions", "")
	if (override !== "")
		return { names: JSON.parse(readFileSync(override, "utf8")) as string[], source: override }
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
		/* the daemon may be mid-write, or the DB may not exist in this checkout */
	}
	return { names: [], source: "" }
}

/* ================================================================= transport */

interface Turn {
	index: number
	gameId: string
	atSec: number
	clock: string
	/** Empty string means the model chose to say nothing at all. */
	text: string
	ms: number
	inputTokens: number | null
	outputTokens: number | null
	/** Only when the transport reports one (the `claude` CLI does). */
	costUsd: number | null
	error: string | null
}

interface Arm {
	provider: Provider
	model: string
	/** How prior turns reach the model. Printed, because it is a confound. */
	history: "session" | "messages" | "preamble" | "none"
	vision: boolean
}

interface RunContext {
	states: BenchState[]
	frameB64: string | null
	stateless: boolean
	temperature: number | null
	timeoutMs: number
	/**
	 * The output budget, and it is not a formality.
	 *
	 * Measured on this key: `gemini-3.6-flash` given 20 output tokens returned
	 * `finish_reason: "length"` with **zero** completion tokens — the whole budget went on internal
	 * reasoning. That comes back as an empty string, and an empty string looks exactly like the
	 * PASS the prompt asks for. A truncated reasoning model would therefore have scored as the
	 * quietest, most disciplined coach in the run. Hence a generous default AND the
	 * `finish_reason` check below, which files an empty non-`stop` answer as an ERROR rather than
	 * a silence.
	 */
	maxTokens: number
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** One place decides what a transient failure is, so every arm gets the same number of chances. */
const RETRIES = 2
const transient = (msg: string): boolean =>
	/\b(429|500|502|503|504|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket|overloaded|rate.?limit)\b/i.test(
		msg
	)

/* ------------------------------------------------------------ gemini live */

/**
 * One socket per run, frame INSIDE the turn as `inlineData`.
 *
 * That shape is copied deliberately from `scripts/eval-live.ts` and from the app, and it must not
 * be "tidied" into `realtimeInput.video`: measured over eight turns on one socket, streaming the
 * frame silenced the audio AND made the model name champions who were not on screen, 6/6 wrong. A
 * benchmark that used the other shape would be scoring a path nothing runs.
 *
 * The transport is duplicated here rather than imported because `eval-live.ts` is a script with a
 * top-level `await main()`. What must NOT be duplicated — the state reconstruction and the scoring
 * — is imported, and is the same code in both.
 */
const runGeminiLive = async (arm: Arm, ctx: RunContext): Promise<Turn[]> => {
	const minted = await mintGeminiToken()
	if (!minted.ok) throw new Error(minted.error)

	return await new Promise<Turn[]>((resolve, reject) => {
		const ws = new WebSocket(`${minted.value.wsUrl}?access_token=${encodeURIComponent(minted.value.token)}`)
		const out: Turn[] = []
		const queue = ctx.states.map((s, i) => ({ s, i }))
		let current: { at: number; s: BenchState; i: number } | null = null
		let partial = ""
		let usage: { input: number | null; output: number | null } = { input: null, output: null }

		const next = () => {
			const item = queue.shift()
			if (item === undefined) {
				ws.close(1000)
				resolve(out)
				return
			}
			current = { at: Date.now(), s: item.s, i: item.i }
			const parts: unknown[] = []
			if (ctx.frameB64 !== null)
				parts.push({ inlineData: { mimeType: "image/jpeg", data: ctx.frameB64 } })
			parts.push({ text: item.s.block })
			ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts }], turnComplete: true } }))
		}

		ws.onopen = () =>
			ws.send(
				JSON.stringify({
					setup: {
						model: arm.model,
						generationConfig: {
							responseModalities: ["AUDIO"],
							...(ctx.temperature === null ? {} : { temperature: ctx.temperature })
						},
						outputAudioTranscription: {},
						systemInstruction: { parts: [{ text: LIVE_COACH_SYSTEM_PROMPT }] }
					}
				})
			)

		ws.onmessage = async ev => {
			const m = JSON.parse(
				typeof ev.data === "string" ? ev.data : await (ev.data as Blob).text()
			) as {
				setupComplete?: unknown
				usageMetadata?: { promptTokenCount?: number; totalTokenCount?: number }
				serverContent?: {
					turnComplete?: boolean
					outputTranscription?: { text?: string }
					modelTurn?: { parts?: { text?: string }[] }
				}
			}
			if (m.setupComplete) {
				next()
				return
			}
			if (m.usageMetadata)
				usage = {
					input: m.usageMetadata.promptTokenCount ?? null,
					output:
						m.usageMetadata.totalTokenCount !== undefined &&
						m.usageMetadata.promptTokenCount !== undefined ?
							m.usageMetadata.totalTokenCount - m.usageMetadata.promptTokenCount
						:	null
				}
			const sc = m.serverContent
			if (!sc) return
			if (sc.outputTranscription?.text) partial += sc.outputTranscription.text
			for (const p of sc.modelTurn?.parts ?? []) if (p.text) partial += p.text
			if (sc.turnComplete && current) {
				out.push({
					index: current.i,
					gameId: current.s.gameId,
					atSec: current.s.atSec,
					clock: current.s.state.clock,
					text: partial.trim(),
					ms: Date.now() - current.at,
					// Gemini reports a CUMULATIVE session count, so this is not a per-turn figure.
					// It is recorded as-is and labelled; converting it to a delta here would be a
					// guess about what Google is billing.
					inputTokens: usage.input,
					outputTokens: usage.output,
					costUsd: null,
					error: null
				})
				partial = ""
				next()
			}
		}
		ws.onerror = () => reject(new Error("socket error"))
		ws.onclose = e => {
			if (e.code !== 1000 && out.length === 0)
				reject(new Error(`closed ${e.code}: ${String(e.reason).slice(0, 160)}`))
			else resolve(out)
		}
		setTimeout(() => {
			ws.close()
			resolve(out)
		}, ctx.timeoutMs * ctx.states.length + 60_000)
	})
}

/* ------------------------------------------------------ openai-compatible */

interface ChatMessage {
	role: "system" | "user" | "assistant"
	content: unknown
}

const openAiUserContent = (block: string, frameB64: string | null): unknown =>
	frameB64 === null ?
		block
		// Image first, then the block — the same order the Gemini turn uses, so the arms differ in
		// model and not in layout.
	:	[
			{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${frameB64}` } },
			{ type: "text", text: block }
		]

const runOpenAiCompatible = async (arm: Arm, ctx: RunContext): Promise<Turn[]> => {
	const key = providerKey(arm.provider)
	const base = baseUrlOf(arm.provider)
	const history: ChatMessage[] = []
	const out: Turn[] = []
	let tokenParam: "max_tokens" | "max_completion_tokens" = "max_tokens"

	for (const [i, s] of ctx.states.entries()) {
		const messages: ChatMessage[] = [
			{ role: "system", content: LIVE_COACH_SYSTEM_PROMPT },
			...history,
			{ role: "user", content: openAiUserContent(s.block, arm.vision ? ctx.frameB64 : null) }
		]
		const started = Date.now()
		let text = ""
		let error: string | null = null
		let input: number | null = null
		let output: number | null = null

		for (let attempt = 0; attempt <= RETRIES; attempt++) {
			try {
				const body: Record<string, unknown> = { model: arm.model, messages }
				body[tokenParam] = ctx.maxTokens
				if (ctx.temperature !== null) body.temperature = ctx.temperature
				const res = await fetch(`${base}/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(ctx.timeoutMs)
				})
				const raw = await res.text()
				if (!res.ok) {
					// Some endpoints reject `max_tokens` outright and name the parameter they want
					// instead. Swap once and retry rather than reporting the whole arm as dead.
					if (res.status === 400 && raw.includes("max_completion_tokens") && tokenParam === "max_tokens") {
						tokenParam = "max_completion_tokens"
						continue
					}
					throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`)
				}
				const parsed = JSON.parse(raw) as {
					choices?: { message?: { content?: unknown }; finish_reason?: string }[]
					usage?: { prompt_tokens?: number; completion_tokens?: number }
				}
				const choice = parsed.choices?.[0]
				const content = choice?.message?.content
				text =
					typeof content === "string" ? content
					: Array.isArray(content) ?
						(content as { text?: string }[]).map(c => c.text ?? "").join("")
					:	""
				input = parsed.usage?.prompt_tokens ?? null
				output = parsed.usage?.completion_tokens ?? null
				// An empty answer that did NOT stop cleanly is a truncation, not a silence. Filing
				// it as a PASS would make a reasoning model that overran its budget look like the
				// most disciplined coach in the run.
				error =
					text.trim() === "" && (choice?.finish_reason ?? "stop") !== "stop" ?
						`empty answer, finish_reason=${choice?.finish_reason} — raise --max-tokens`
					:	null
				break
			} catch (e) {
				error = e instanceof Error ? e.message : String(e)
				if (attempt === RETRIES || !transient(error)) break
				await sleep(2000 * (attempt + 1) ** 2)
			}
		}

		out.push({
			index: i,
			gameId: s.gameId,
			atSec: s.atSec,
			clock: s.state.clock,
			text: text.trim(),
			ms: Date.now() - started,
			inputTokens: input,
			outputTokens: output,
			costUsd: null,
			error
		})
		if (!ctx.stateless && error === null) {
			// The block goes back in as text only. Replaying the image every turn would multiply
			// the cost of a long run by an order of magnitude and change nothing about the state
			// the model is being asked to reason from.
			history.push({ role: "user", content: s.block }, { role: "assistant", content: text.trim() })
		}
	}
	return out
}

/* ------------------------------------------------------------- anthropic */

const runAnthropic = async (arm: Arm, ctx: RunContext): Promise<Turn[]> => {
	const key = providerKey(arm.provider)
	const base = baseUrlOf(arm.provider)
	const history: ChatMessage[] = []
	const out: Turn[] = []

	for (const [i, s] of ctx.states.entries()) {
		const content: unknown =
			arm.vision && ctx.frameB64 !== null ?
				[
					{
						type: "image",
						source: { type: "base64", media_type: "image/jpeg", data: ctx.frameB64 }
					},
					{ type: "text", text: s.block }
				]
			:	s.block
		const started = Date.now()
		let text = ""
		let error: string | null = null
		let input: number | null = null
		let output: number | null = null

		for (let attempt = 0; attempt <= RETRIES; attempt++) {
			try {
				const res = await fetch(`${base}/v1/messages`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-api-key": key,
						"anthropic-version": "2023-06-01"
					},
					body: JSON.stringify({
						model: arm.model,
						max_tokens: ctx.maxTokens,
						system: LIVE_COACH_SYSTEM_PROMPT,
						...(ctx.temperature === null ? {} : { temperature: ctx.temperature }),
						messages: [...history, { role: "user", content }]
					}),
					signal: AbortSignal.timeout(ctx.timeoutMs)
				})
				const raw = await res.text()
				if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`)
				const parsed = JSON.parse(raw) as {
					content?: { type?: string; text?: string }[]
					stop_reason?: string
					usage?: { input_tokens?: number; output_tokens?: number }
				}
				text = (parsed.content ?? [])
					.filter(b => b?.type === "text" && typeof b.text === "string")
					.map(b => b.text as string)
					.join("")
				input = parsed.usage?.input_tokens ?? null
				output = parsed.usage?.output_tokens ?? null
				// Same rule as the OpenAI arm: a truncated answer is an error, never a silence.
				error =
					text.trim() === "" && (parsed.stop_reason ?? "end_turn") === "max_tokens" ?
						"empty answer, stop_reason=max_tokens — raise --max-tokens"
					:	null
				break
			} catch (e) {
				error = e instanceof Error ? e.message : String(e)
				if (attempt === RETRIES || !transient(error)) break
				await sleep(2000 * (attempt + 1) ** 2)
			}
		}

		out.push({
			index: i,
			gameId: s.gameId,
			atSec: s.atSec,
			clock: s.state.clock,
			text: text.trim(),
			ms: Date.now() - started,
			inputTokens: input,
			outputTokens: output,
			costUsd: null,
			error
		})
		if (!ctx.stateless && error === null)
			history.push({ role: "user", content: s.block }, { role: "assistant", content: text.trim() })
	}
	return out
}

/* ------------------------------------------------------------ claude cli */

/**
 * The text-only control arm, over the existing subscription login.
 *
 * Flags copied from `src/review/claude.ts`: `--safe-mode` removes CLAUDE.md discovery, skills,
 * plugins, hooks and MCP, which makes the call deterministic — a benchmark must not be affected by
 * whatever the user has in their global config — and `--tools ""` means the model cannot reach the
 * filesystem. History arrives as a short preamble because print mode is stateless.
 */
const runClaudeCli = async (arm: Arm, ctx: RunContext): Promise<Turn[]> => {
	const bin = process.env.EEPALYTICS_CLAUDE_BIN ?? process.env.CSK_CLAUDE_BIN ?? "claude"
	const spoken: string[] = []
	const out: Turn[] = []

	for (const [i, s] of ctx.states.entries()) {
		const preamble =
			ctx.stateless || spoken.length === 0 ?
				""
			:	`Earlier this game you said, in order:\n${spoken.slice(-8).map(t => `- ${t}`).join("\n")}\n\n`
		const started = Date.now()
		const result = await new Promise<{ text: string; cost: number | null; input: number | null; output: number | null; error: string | null }>(
			resolve => {
				const child = spawn(
					bin,
					[
						"-p",
						"--model",
						arm.model,
						"--output-format",
						"json",
						"--system-prompt",
						LIVE_COACH_SYSTEM_PROMPT,
						"--tools",
						"",
						"--disable-slash-commands",
						"--strict-mcp-config",
						"--no-session-persistence",
						"--safe-mode",
						"--effort",
						"low"
					],
					{ stdio: ["pipe", "pipe", "pipe"] }
				)
				let stdout = ""
				let stderr = ""
				const timer = setTimeout(() => child.kill("SIGKILL"), ctx.timeoutMs)
				child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()))
				child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()))
				child.on("error", e =>
					resolve({ text: "", cost: null, input: null, output: null, error: e.message })
				)
				child.on("close", () => {
					clearTimeout(timer)
					try {
						const env = JSON.parse(stdout) as {
							result?: string
							total_cost_usd?: number
							usage?: { input_tokens?: number; output_tokens?: number }
						}
						resolve({
							text: typeof env.result === "string" ? env.result : "",
							cost: env.total_cost_usd ?? null,
							input: env.usage?.input_tokens ?? null,
							output: env.usage?.output_tokens ?? null,
							error: null
						})
					} catch {
						resolve({
							text: "",
							cost: null,
							input: null,
							output: null,
							error: stderr.trim().split("\n")[0]?.slice(0, 200) ?? "no JSON from the CLI"
						})
					}
				})
				child.stdin?.on("error", () => {})
				child.stdin?.end(`${preamble}${s.block}`)
			}
		)
		out.push({
			index: i,
			gameId: s.gameId,
			atSec: s.atSec,
			clock: s.state.clock,
			text: result.text.trim(),
			ms: Date.now() - started,
			inputTokens: result.input,
			outputTokens: result.output,
			costUsd: result.cost,
			error: result.error
		})
		if (result.error === null && result.text.trim() !== "") spoken.push(result.text.trim())
	}
	return out
}

/* ----------------------------------------------------------------- mock */

/**
 * A fixed script, one fault per line, so the whole pipeline can be checked without a key.
 *
 * These lines are written against the FIXTURE's roster-independent shapes: the champion names are
 * deliberately absent so the mock does not accidentally depend on which states were loaded. What
 * it does prove is that a turn round-trips, that the scorer runs, and that the table adds up.
 */
const MOCK_LINES = [
	"PASS",
	"You have 999999 gold sitting unspent — go back and spend it.",
	"They are converging on you through the river, back off.",
	"you are level 4 right now",
	"PASS"
]

const runMock = async (_arm: Arm, ctx: RunContext): Promise<Turn[]> =>
	ctx.states.map((s, i) => ({
		index: i,
		gameId: s.gameId,
		atSec: s.atSec,
		clock: s.state.clock,
		text: MOCK_LINES[i % MOCK_LINES.length]!,
		ms: 1,
		inputTokens: null,
		outputTokens: null,
		costUsd: null,
		error: null
	}))

/**
 * Every turn-based arm goes through `coachTurn`, the SAME path the live coach uses.
 *
 * This benchmark was written with its own per-vendor HTTP calls. That is the one thing it must not
 * have: if the adapters differ, the differences between the adapters are what gets measured, and
 * the whole question is about the models. `src/review/live-providers.ts` is the single path — one
 * SDK, one image content part, one set of options, and the system prompt is not even a parameter
 * there, so it cannot drift between arms.
 *
 * `gemini-live` keeps its own runner because it genuinely is a different thing: a socket with
 * native audio. That is the arm the comparison exists to test against, not a variation of it.
 */
const runViaSdk = async (arm: Arm, ctx: RunContext): Promise<Turn[]> => {
	const out: Turn[] = []
	let index = 0
	for (const state of ctx.states) {
		const r = await coachTurn({
			// Pinned, not inherited: a harness that takes the PRODUCT default silently re-points
			// itself the day that default moves. It did — five harnesses swapped baseline from
			// fenced to cite-or-quiet with nothing failing. Every number this script has ever
			// printed was measured against the fenced block, so that is what it keeps measuring.
			mode: "fenced" as const,
			provider: arm.provider.id as never,
			model: arm.model,
			blockText: state.block,
			...(ctx.frameB64 ? { frameJpegBase64: ctx.frameB64 } : {})
		})
		out.push({
			index: index++,
			gameId: state.gameId,
			atSec: state.atSec,
			clock: state.state.clock,
			text: r.text,
			ms: r.latencyMs,
			inputTokens: null,
			outputTokens: null,
			costUsd: null,
			error: r.ok ? null : (r.reason ?? "failed")
		})
	}
	return out
}

const runArm = async (arm: Arm, ctx: RunContext): Promise<Turn[]> => {
	if (arm.provider.kind === "gemini-live") return await runGeminiLive(arm, ctx)
	if (arm.provider.kind === "mock") return await runMock(arm, ctx)
	// Anything the shared provider layer knows about goes through it.
	/*
	 * The bench and the shared layer name the same vendors differently — the bench grew its own
	 * ids before the layer existed. Mapped rather than renamed on either side, because the bench's
	 * ids are what he types on the command line and the layer's are what the settings screen
	 * stores; changing either would break something he already uses.
	 */
	const SHARED_ID: Record<string, string> = {
		gemini: "gemini-http",
		"gemini-http": "gemini-http",
		openai: "openai",
		anthropic: "anthropic",
		kimi: "kimi",
		glm: "glm"
	}
	const mapped = SHARED_ID[arm.provider.id]
	if (mapped && sharedProvider(mapped))
		return await runViaSdk({ ...arm, provider: { ...arm.provider, id: mapped } }, ctx)
	/*
	 * `claude-cli` has no runner ON PURPOSE. Print mode cannot carry an image, so an arm using it
	 * would be a text-only run sitting in a table of vision runs — a clean-looking number about a
	 * different experiment. Anthropic needs an API key.
	 */
	throw new Error(
		arm.provider.id === "claude-cli" ?
			"the claude CLI cannot take an image — use the anthropic arm with an API key"
		:	`no runner for ${arm.provider.id}`
	)
}

/* ================================================================== pricing */

/**
 * USD per million tokens, keyed `provider:model`.
 *
 * Deliberately almost empty. The rate is the vendor's to change and quoting a price from memory is
 * exactly the kind of confident-sounding number this whole app exists to stamp out — so an arm
 * with no entry reports tokens and a blank cost, never an estimate. The three Anthropic rows are
 * copied verbatim from `src/review/claude.ts`, which is where this repo already keeps them. Add
 * yours here, or hand a JSON file to `--prices`.
 */
const PRICES: Record<string, { in: number; out: number }> = {
	"anthropic:claude-opus-5": { in: 5, out: 25 },
	"anthropic:claude-sonnet-5": { in: 2, out: 10 },
	"anthropic:claude-haiku-4-5": { in: 1, out: 5 }
}

const loadPrices = () => {
	const path = arg("prices", "")
	if (path === "") return
	const extra = JSON.parse(readFileSync(path, "utf8")) as Record<string, { in: number; out: number }>
	for (const [k, v] of Object.entries(extra)) PRICES[k] = v
}

/* ================================================================= scoring */

interface ArmResult {
	arm: Arm
	turns: Turn[]
	scores: (LineScore | null)[]
	available: boolean
	unavailable: string
}

const pct = (i: Interval): string => `${(100 * i.p).toFixed(0)}%`
const ci = (i: Interval): string => `${(100 * i.lo).toFixed(0)}-${(100 * i.hi).toFixed(0)}%`
const quantile = (xs: number[], q: number): number =>
	xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]!

interface ArmSummary {
	id: string
	model: string
	vision: boolean
	history: string
	attempted: number
	errors: number
	silent: number
	spoke: number
	faultCounts: Record<string, number>
	fabrication: Interval
	weak: Interval
	p50: number
	p90: number
	inTok: number | null
	outTok: number | null
	usdPerTurn: number | null
}

const summarise = (r: ArmResult): ArmSummary => {
	const ok = r.turns.filter(t => t.error === null)
	const scored: LineScore[] = []
	for (const [i, t] of r.turns.entries()) {
		const s = r.scores[i]
		if (t.error === null && s) scored.push(s)
	}
	const spoke = scored.filter(s => !s.silent)
	const faultCounts: Record<string, number> = {}
	for (const f of [...FABRICATION_FAULTS, ...WEAKNESS_FAULTS]) faultCounts[f] = 0
	let fab = 0
	let weak = 0
	for (const s of spoke) {
		for (const f of s.faults) faultCounts[f] = (faultCounts[f] ?? 0) + 1
		if (s.faults.some(f => FABRICATION_FAULTS.includes(f))) fab++
		if (s.faults.some(f => WEAKNESS_FAULTS.includes(f))) weak++
	}
	const latencies = ok.map(t => t.ms)
	const inTok = ok.map(t => t.inputTokens).filter((n): n is number => n !== null)
	const outTok = ok.map(t => t.outputTokens).filter((n): n is number => n !== null)
	const price = PRICES[`${r.arm.provider.id}:${r.arm.model}`]
	const reported = ok.map(t => t.costUsd).filter((n): n is number => n !== null)
	const usdPerTurn =
		reported.length > 0 ? reported.reduce((a, b) => a + b, 0) / reported.length
		: price && inTok.length > 0 && outTok.length > 0 ?
			(mean(inTok) * price.in + mean(outTok) * price.out) / 1_000_000
		:	null

	return {
		id: r.arm.provider.id,
		model: r.arm.model,
		vision: r.arm.vision,
		history: r.arm.history,
		attempted: r.turns.length,
		errors: r.turns.length - ok.length,
		silent: scored.length - spoke.length,
		spoke: spoke.length,
		faultCounts,
		fabrication: wilson(fab, spoke.length),
		weak: wilson(weak, spoke.length),
		p50: quantile(latencies, 0.5),
		p90: quantile(latencies, 0.9),
		inTok: inTok.length > 0 ? Math.round(mean(inTok)) : null,
		outTok: outTok.length > 0 ? Math.round(mean(outTok)) : null,
		usdPerTurn
	}
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

const pad = (s: string, w: number): string => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length))
const padL = (s: string, w: number): string => (s.length >= w ? s : " ".repeat(w - s.length) + s)

const FAULT_HEADS: [CoachFault, string][] = [
	["invented-champion", "champ"],
	["unbacked-number", "num?"],
	["misattributed-number", "num@"],
	["invented-movement", "move"],
	["visible-only", "seen"],
	["no-alternative", "noact"]
]

const printTable = (rows: ArmSummary[], vocabOk: boolean) => {
	console.log(
		`\n${pad("provider", 13)}${pad("model", 34)}${pad("mode", 6)}${padL("turns", 6)}${padL("err", 5)}${padL("pass", 6)}${padL("said", 6)}` +
			FAULT_HEADS.map(([, h]) => padL(h, 7)).join("")
	)
	console.log("-".repeat(13 + 30 + 6 + 6 + 5 + 6 + 6 + 7 * FAULT_HEADS.length))
	for (const r of rows)
		console.log(
			pad(r.id, 13) +
				pad(r.model, 34) +
				pad(r.vision ? "img" : "text", 6) +
				padL(String(r.attempted), 6) +
				padL(String(r.errors), 5) +
				padL(String(r.silent), 6) +
				padL(String(r.spoke), 6) +
				FAULT_HEADS.map(([f]) =>
					padL(
						f === "invented-champion" && !vocabOk ? "n/a"
						: r.spoke === 0 ? "-"
						: `${Math.round((100 * (r.faultCounts[f] ?? 0)) / r.spoke)}%`,
						7
					)
				).join("")
		)
	console.log(
		`\nRates are over SAID lines (n in the "said" column), not over turns: a model that passes on` +
			`\neverything and fabricates the rest would otherwise post a flattering per-turn rate.`
	)
	console.log(
		`champ = named a champion not on the roster · num? = a figure not in the block ·` +
			`\nnum@ = a real figure attached to the wrong player · move = asserted motion or intent ·` +
			`\nseen = restated his own HUD · noact = named no action (the prompt sometimes sanctions this)`
	)

	console.log(`\n${pad("provider", 13)}${pad("model", 34)}${padL("n", 5)}  fabricated any   95% Wilson`)
	console.log("-".repeat(85))
	for (const r of rows)
		console.log(
			pad(r.id, 13) +
				pad(r.model, 34) +
				padL(String(r.fabrication.n), 5) +
				padL(`${r.fabrication.k}  ${pct(r.fabrication)}`, 17) +
				padL(ci(r.fabrication), 14)
		)

	console.log(`\n${pad("provider", 13)}${pad("model", 34)}${padL("p50 ms", 8)}${padL("p90 ms", 8)}${padL("in tok", 8)}${padL("out tok", 9)}${padL("$/turn", 10)}`)
	console.log("-".repeat(86))
	for (const r of rows)
		console.log(
			pad(r.id, 13) +
				pad(r.model, 34) +
				padL(String(r.p50), 8) +
				padL(String(r.p90), 8) +
				padL(r.inTok === null ? "-" : String(r.inTok), 8) +
				padL(r.outTok === null ? "-" : String(r.outTok), 9) +
				padL(r.usdPerTurn === null ? "-" : `$${r.usdPerTurn.toFixed(4)}`, 10)
		)
	console.log(
		`\nA blank cost means no price is on file for that model — see PRICES in this script, or pass` +
			`\n--prices. Gemini Live's token counts are CUMULATIVE per session, not per turn.`
	)
}

/**
 * The part that stops a table from being over-read.
 *
 * Two arms are only called apart when their Wilson intervals do not overlap, which is stricter
 * than a two-proportion test and will miss some real differences. That is the right way round: the
 * cost of under-claiming here is another run with a bigger `--turns`, and the cost of over-claiming
 * is a model swap made on noise.
 */
const printSeparation = (rows: ArmSummary[]) => {
	const usable = rows.filter(r => r.fabrication.n > 0)
	if (usable.length < 2) return
	console.log(`\n--- is any difference in fabrication real at 95%? ---`)
	let any = false
	for (let i = 0; i < usable.length; i++)
		for (let j = i + 1; j < usable.length; j++) {
			const a = usable[i]!
			const b = usable[j]!
			if (!separated(a.fabrication, b.fabrication)) continue
			any = true
			const [lo, hi] = a.fabrication.p < b.fabrication.p ? [a, b] : [b, a]
			console.log(
				`  ${lo.id}/${lo.model} (${pct(lo.fabrication)}) < ${hi.id}/${hi.model} (${pct(hi.fabrication)}) — separated`
			)
		}
	if (!any)
		console.log(
			`  none. Every pair's interval overlaps at n = ${usable.map(r => r.fabrication.n).join("/")}.` +
				`\n  Do not report a winner from this run; raise --turns or --repeats.`
		)
}

/* ==================================================================== main */

const listModels = async (id: string) => {
	const p = providerById(id)
	if (!p) throw new Error(`unknown provider ${id}`)
	const key = providerKey(p)
	if (key === "") throw new Error(`${id}: no key. ${p.need}`)
	if (p.id === "gemini-live" || p.id === "gemini") {
		const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
			headers: { "x-goog-api-key": key }
		})
		const body = (await res.json()) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] }
		for (const m of body.models ?? [])
			console.log(`${m.name}  [${(m.supportedGenerationMethods ?? []).join(",")}]`)
		return
	}
	if (p.kind === "anthropic") {
		const res = await fetch(`${baseUrlOf(p)}/v1/models?limit=100`, {
			headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }
		})
		const body = (await res.json()) as { data?: { id?: string }[] }
		for (const m of body.data ?? []) console.log(m.id)
		return
	}
	const res = await fetch(`${baseUrlOf(p)}/models`, { headers: { authorization: `Bearer ${key}` } })
	const body = (await res.json()) as { data?: { id?: string }[] }
	for (const m of body.data ?? []) console.log(m.id)
}

const main = async () => {
	loadPrices()

	const wantList = arg("list-models", "")
	if (wantList !== "") {
		await listModels(wantList)
		return
	}

	/* --------------------------------------------------------- which arms */
	const only = arg("only", "")
		.split(",")
		.map(s => s.trim())
		.filter(s => s !== "")
	const modelSpec = arg("models", "")
	const arms: Arm[] = []
	if (modelSpec !== "")
		for (const pair of modelSpec.split(",")) {
			const [id, model] = pair.split("=").map(s => s.trim())
			const p = id === undefined ? undefined : providerById(id)
			if (!p) throw new Error(`--models: unknown provider in "${pair}"`)
			arms.push({
				provider: p,
				model: model && model !== "" ? model : p.defaultModel,
				history: p.kind === "gemini-live" ? "session" : p.kind === "claude-cli" ? "preamble" : "messages",
				vision: p.vision
			})
		}
	else
		for (const p of PROVIDERS) {
			if (only.length > 0 && !only.includes(p.id)) continue
			// The self-test arm is opt-in: it is not a model, and a row of canned lines sitting in
			// the same table as real ones is exactly the kind of thing that gets screenshotted.
			if (p.id === "mock" && !flag("with-mock") && !only.includes("mock")) continue
			arms.push({
				provider: p,
				model: p.defaultModel,
				history: p.kind === "gemini-live" ? "session" : p.kind === "claude-cli" ? "preamble" : "messages",
				vision: p.vision
			})
		}

	if (flag("list")) {
		console.log(`${pad("provider", 13)}${pad("default model", 34)}${pad("mode", 6)}key?`)
		for (const p of PROVIDERS) {
			const key = providerKey(p)
			const has = p.kind === "claude-cli" || p.kind === "mock" ? "n/a" : key === "" ? "MISSING" : "yes"
			console.log(`${pad(p.id, 13)}${pad(p.defaultModel || "(pass --models)", 34)}${pad(p.vision ? "img" : "text", 6)}${has}`)
			if (has === "MISSING") console.log(`             need: ${p.need}`)
		}
		return
	}

	/* -------------------------------------------------------- the fixture */
	/*
	 * `--from-samples` replays what the client ACTUALLY said during a real game.
	 *
	 * The default fixture reconstructs states from the post-game timeline, which has no enemy CS,
	 * no items and no roles — so it starves the coach of exactly the facts it was rebuilt around,
	 * and measured 40% "named no action" against roughly 11% on states carrying a counterpart.
	 * A model comparison run on starved states measures improvisation, not coaching.
	 *
	 * `src/daemon/live-sampler.ts` records the raw allgamedata every few seconds of a live game.
	 * This turns those samples into the same `BenchState` shape through the SAME `buildLiveState`
	 * and `renderState` the daemon uses, so a replayed block is byte-identical to the one the coach
	 * was actually holding.
	 */
	const fromSamples = arg("from-samples", "")
	const all =
		fromSamples !== "" ? await loadSampledStates(fromSamples) : loadStates(arg("states", `${DATA_DIR}/eval/confirm.json`))
	const statesPath = fromSamples !== "" ? `live samples ${fromSamples}` : arg("states", `${DATA_DIR}/eval/confirm.json`)
	if (all.length === 0) throw new Error(`no usable states in ${statesPath}`)
	const states = spread(all, Number(arg("turns", "12")))

	const freeze = arg("freeze", "")
	if (freeze !== "") {
		mkdirSync(dirname(freeze), { recursive: true })
		writeFileSync(
			freeze,
			JSON.stringify(
				{
					frozenAt: Date.now(),
					source: statesPath,
					note: "The fixed set of game states this benchmark replays. Keep it; a rate is only comparable to a rate measured on the same states.",
					states: states.map(s => ({ gameId: s.gameId, atSec: s.atSec, state: s.state }))
				},
				null,
				2
			)
		)
		console.log(`froze ${states.length} states to ${freeze}`)
	}

	const framePath = arg("frame", `${DATA_DIR}/eval/frame.jpg`)
	const frameB64 = flag("no-frame") ? null : readFileSync(framePath).toString("base64")

	const vocab = championVocabulary()
	if (vocab.names.length === 0)
		console.log(
			`!! no champion vocabulary — the invented-champion column will read n/a.\n` +
				`   It normally comes from kv.championNames in ${DB_PATH}; pass --champions <json array> instead.`
		)

	const repeats = Math.max(1, Number(arg("repeats", "1")))
	const ctx: RunContext = {
		states,
		frameB64,
		stateless: flag("stateless"),
		temperature: arg("temperature", "") === "" ? null : Number(arg("temperature", "")),
		timeoutMs: Number(arg("timeout", "60000")),
		maxTokens: Number(arg("max-tokens", "1024"))
	}

	console.log(
		`\nstates ${states.length} of ${all.length} from ${statesPath}` +
			`\nframe  ${frameB64 === null ? "(none — text only)" : `${framePath} (${Math.round(frameB64.length * 0.75 / 1024)} KB, THE SAME FRAME FOR EVERY STATE)`}` +
			`\nvocab  ${vocab.names.length} champions${vocab.source === "" ? "" : ` from ${vocab.source}`}` +
			`\nprompt LIVE_COACH_SYSTEM_PROMPT (${LIVE_COACH_SYSTEM_PROMPT.length} chars), identical for every arm` +
			`\nrepeat ${repeats}x per arm · history ${ctx.stateless ? "off" : "on"}\n`
	)

	/* ------------------------------------------------------------- run it */
	const results: ArmResult[] = []
	for (const arm of arms) {
		const needsKey = arm.provider.kind !== "claude-cli" && arm.provider.kind !== "mock"
		if (needsKey && providerKey(arm.provider) === "") {
			console.log(`${arm.provider.id}/${arm.model}: SKIPPED — ${arm.provider.need}`)
			results.push({ arm, turns: [], scores: [], available: false, unavailable: arm.provider.need })
			continue
		}
		if (arm.model === "") {
			console.log(`${arm.provider.id}: SKIPPED — no model. ${arm.provider.need}`)
			results.push({ arm, turns: [], scores: [], available: false, unavailable: "no model given" })
			continue
		}

		const turns: Turn[] = []
		for (let rep = 0; rep < repeats; rep++) {
			process.stderr.write(`${arm.provider.id}/${arm.model} rep ${rep + 1}/${repeats} … `)
			try {
				turns.push(...(await runArm(arm, ctx)))
				process.stderr.write(`${turns.length} turns\n`)
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e)
				process.stderr.write(`FAILED: ${msg}\n`)
				// A dead arm is recorded as errored turns rather than dropped, so the table shows a
				// row with `err = n` instead of quietly omitting the model that could not run.
				for (const [i, s] of ctx.states.entries())
					turns.push({
						index: i,
						gameId: s.gameId,
						atSec: s.atSec,
						clock: s.state.clock,
						text: "",
						ms: 0,
						inputTokens: null,
						outputTokens: null,
						costUsd: null,
						error: msg
					})
			}
			// Space repeats out; back-to-back sessions are what provoke Gemini's 1011s.
			if (rep + 1 < repeats) await sleep(5000)
		}

		const scores = turns.map(t =>
			t.error !== null ? null : (
				scoreLine({
					line: t.text,
					block: ctx.states[t.index]!.block,
					roster: ctx.states[t.index]!.roster,
					champions: vocab.names
				})
			)
		)
		results.push({ arm, turns, scores, available: true, unavailable: "" })
	}

	/* ------------------------------------------------------------ report */
	const rows = results.filter(r => r.turns.length > 0).map(summarise)
	if (rows.length === 0) {
		console.log("\nno arm produced a turn. Run with --list to see which keys are missing.")
		return
	}
	printTable(rows, vocab.names.length > 0)
	printSeparation(rows)

	if (flag("verbose"))
		for (const r of results) {
			if (r.turns.length === 0) continue
			console.log(`\n=== ${r.arm.provider.id}/${r.arm.model} ===`)
			for (const [i, t] of r.turns.entries()) {
				const s = r.scores[i]
				const tag =
					t.error !== null ? `ERROR ${t.error.slice(0, 80)}`
					: !s || s.silent ? "pass"
					: s.faults.length === 0 ? "ok"
					: s.faults.join(",")
				console.log(`  ${padL(t.clock, 6)} ${padL(`${t.ms}ms`, 8)} [${tag}]`)
				if (t.text !== "") console.log(`         ${t.text}`)
			}
		}

	const out = arg("out", "")
	if (out !== "") {
		mkdirSync(dirname(out), { recursive: true })
		writeFileSync(
			out,
			JSON.stringify(
				{
					at: Date.now(),
					statesPath,
					framePath: frameB64 === null ? null : framePath,
					stateless: ctx.stateless,
					repeats,
					promptChars: LIVE_COACH_SYSTEM_PROMPT.length,
					vocabulary: { count: vocab.names.length, source: vocab.source },
					states: states.map(s => ({ gameId: s.gameId, atSec: s.atSec, block: s.block })),
					arms: results.map(r => ({
						provider: r.arm.provider.id,
						model: r.arm.model,
						vision: r.arm.vision,
						history: r.arm.history,
						available: r.available,
						unavailable: r.unavailable,
						turns: r.turns.map((t, i) => ({ ...t, score: r.scores[i] }))
					})),
					summary: rows
				},
				null,
				2
			)
		)
		console.log(`\nwrote ${out}`)
	}
}

await main()
