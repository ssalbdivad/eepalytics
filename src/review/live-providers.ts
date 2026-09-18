/**
 * One live-coaching turn, against any model, through the Vercel AI SDK.
 *
 * ## Why a wrapper, and why this one
 *
 * The question this exists to answer is the owner's: *how much of the coach's failure is the
 * model?* Answering it means holding the prompt, the ground-truth block and the frame CONSTANT and
 * varying only the model — so every provider must be reached through one code path, or the
 * comparison measures the adapters instead.
 *
 * The AI SDK gives exactly that: one `generateText`, one image content part, one set of options,
 * and Kimi and GLM ride the OpenAI-compatible provider with a different base URL. Hand-rolled
 * adapters were tried first and the differences between them were immediately the thing under
 * test rather than the models.
 *
 * ## Gemini Live is NOT here, deliberately
 *
 * There are two shapes and flattening them would be a lie. Gemini Live is a WebSocket with native
 * audio, continuous frames, barge-in and a held thread; it is the shipped live coach and it stays
 * where it is. Everything here is TURN-BASED: send a frame and a block over HTTPS, get text back,
 * and the caller speaks it. That is slower and cannot be interrupted mid-sentence, and the UI
 * should say so rather than let him discover it mid-game.
 *
 * `gemini-http` exists for one reason and it is the most valuable row in the table: the same model
 * family over HTTPS instead of the socket. It is the only way to separate "this model hallucinates"
 * from "the live path hallucinates".
 *
 * VERIFIED, and it matters for benchmarking: the Live API and `generateContent` bill against
 * SEPARATE quotas. Exhausting the HTTPS side with a benchmark run does not stop the live voice
 * coach working, which is what makes it safe to measure while he plays.
 *
 * NODE ONLY — it holds API keys, which must never reach the browser.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { DATA_DIR } from "../shared/constants.ts"
import { DEFAULT_LIVE_COACH_MODE, liveCoachSystemPrompt } from "../shared/live-coach-mode.ts"
import { fullKnowledge } from "./live-knowledge-full.ts"
import type { LiveCoachMode } from "../shared/live-coach-mode.ts"
import { liveChampionKnowledge } from "./live-coach-knowledge.ts"
import { SpeechChunker } from "../shared/speech-chunks.ts"

export type ProviderId = "gemini-http" | "anthropic" | "openai" | "kimi" | "glm" | "mock"

export interface ProviderInfo {
	id: ProviderId
	label: string
	/** The file under `data/` holding its key, following `gemini.key`'s 0600 pattern. */
	keyFile: string
	/** A model that is known to accept an image, offered as the default. */
	defaultModel: string
	/** OpenAI-compatible providers differ only by base URL. */
	baseUrl?: string
	note: string
	/**
	 * Whether the settings screen may OFFER this provider. Absent means yes.
	 *
	 * It exists because `available` is computed from "is there a key file", which is not the same
	 * question as "does the key work". `data/openai.key` has been present and INVALID since at
	 * least 2026-09-18 — `GET /v1/models` answers `invalid_api_key` on it — so the screen offered
	 * `gpt-5` as an available choice that fails on the first turn of a real game. A provider is
	 * withdrawn here rather than deleted because the id may already be stored in his settings and
	 * `providerById` still has to resolve it; what changes is that it stops being advertised.
	 */
	offered?: boolean
}

/**
 * The providers this can reach.
 *
 * Model ids are OFFERED, never enforced — they change faster than this app will be updated and a
 * hardcoded list is a bug that looks like a limitation. The settings field is free text.
 */
export const PROVIDERS: readonly ProviderInfo[] = [
	{
		/*
		 * A provider that needs no key and calls nothing.
		 *
		 * It exists so the whole turn-based path — route, browser loop, system voice, transcript —
		 * can be exercised without an API key, a bill, or a rate limit. Every other provider was
		 * unverifiable end to end the day it was written: the Gemini quota was exhausted by testing
		 * and there were no other keys on the machine.
		 *
		 * It echoes the FIRST ranked fact back, which makes it a useful control in its own right:
		 * it is exactly what the coach would say if the model contributed nothing at all, so any
		 * arm that does not beat it is not earning its latency.
		 */
		id: "mock",
		label: "Mock (no key, says the top fact)",
		keyFile: "mock.key",
		defaultModel: "echo",
		note: "Calls nothing. Speaks the highest-ranked fact verbatim — the control arm."
	},
	{
		id: "gemini-http",
		label: "Gemini (HTTPS)",
		keyFile: "gemini.key",
		/*
		 * MEASURED 2026-09-18, twelve real turns of game 5639409343, same payloads and prompt:
		 * `gemini-3.8-flash` at low thinking reaches its first spoken fragment at p50 1,780ms where
		 * `gemini-3.6-flash` at the vendor default takes 4,996ms — and the newer one is the cheaper
		 * of the two per turn once the thinking tokens are counted. The old default was three
		 * releases behind what this key serves and nobody had noticed.
		 */
		defaultModel: "gemini-3.8-flash",
		note: "Same key as the live voice coach. The control arm: same model family, no socket."
	},
	{
		id: "anthropic",
		label: "Anthropic",
		keyFile: "anthropic.key",
		/*
		 * MEASURED 2026-09-18 over 60 paired turns of two of his own games, one blind judge across
		 * all seven arms in one pool (`data/eval/model-race-20260918*.json`): `claude-sonnet-5` at
		 * `effort: low`, cached and streamed, is 78% useful [66-87] with a first syllable at
		 * 1,754ms. `claude-opus-5` is 84% [73-91] and the two are NOT separated (useful 11-10,
		 * p = 1.00) — but Opus takes 3,718ms to that first syllable and costs 2.6x as much, so the
		 * default is the one that can keep up with a fight. Opus stays one word away in the box.
		 */
		defaultModel: "claude-sonnet-5",
		note: "Needs an API key. Sonnet 5 speaks its first words at about 1.75s, cached and streamed. Type claude-opus-5 for the best-judged arm at 3.7s."
	},
	{
		id: "openai",
		label: "OpenAI",
		keyFile: "openai.key",
		defaultModel: "gpt-5",
		note: "The stored key is rejected (invalid_api_key). Save a working one to bring this back.",
		/*
		 * WITHDRAWN 2026-09-18. The key on this machine answers `invalid_api_key` to
		 * `GET /v1/models`, and it has a key FILE, so `available` said true and the screen offered
		 * `gpt-5` as a working choice. Beside that, the stored latency for gpt-5 on this task is
		 * 20.5s to a full answer, which is not a live coach under any schedule. Offering it again
		 * is a one-line change once a key that works exists.
		 */
		offered: false
	},
	{
		id: "kimi",
		label: "Kimi (Moonshot)",
		keyFile: "kimi.key",
		defaultModel: "moonshot-v1-8k-vision-preview",
		baseUrl: "https://api.moonshot.ai/v1",
		note: "OpenAI-compatible. Pick a VISION model or the frame is silently ignored."
	},
	{
		id: "glm",
		label: "GLM (Zhipu)",
		keyFile: "glm.key",
		defaultModel: "glm-4v-flash",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		note: "OpenAI-compatible. Pick a VISION model or the frame is silently ignored."
	}
]

export const providerById = (id: string): ProviderInfo | undefined =>
	PROVIDERS.find(p => p.id === id)

/**
 * A provider's key, or null.
 *
 * Same storage as the Gemini key and for the same reason: a file at 0600 under `data/`, never the
 * settings table, because settings round-trip through `GET /api/settings` into the renderer.
 */
export const providerKey = (p: ProviderInfo): string | null => {
	// The mock needs nothing and must always be available, or the one path that can be tested
	// without a bill would itself require a key.
	if (p.id === "mock") return "mock"
	const path = `${DATA_DIR}/${p.keyFile}`
	if (!existsSync(path)) return null
	const raw = readFileSync(path, "utf8").trim()
	return raw === "" ? null : raw
}

export interface CoachTurnRequest {
	provider: ProviderId
	/** Empty means the provider's default. */
	model?: string
	/** Base64 JPEG of his screen. Omitted for a text-only control run. */
	frameJpegBase64?: string
	/** The ground-truth block, exactly as `renderBlockForMode` produced it for the same mode. */
	blockText: string
	/**
	 * Which ARCHITECTURE to coach under. A closed set of two, never prompt text.
	 *
	 * This is the whole of the concession made to varying what the model is told, and the shape is
	 * the point: `coachTurn`'s invariant is that a caller cannot vary the WORDING, so a comparison
	 * between two models cannot accidentally have varied the prompt as well. A mode names an arm
	 * that was measured; a string would name nothing.
	 *
	 * Defaults to `DEFAULT_LIVE_COACH_MODE`, so an old caller gets the shipped coach rather than
	 * whichever arm happened to be first in the union.
	 */
	mode?: LiveCoachMode
	/**
	 * Who he is playing, for the champion clauses. A NAME, for the same reason `mode` is a mode.
	 *
	 * The clauses themselves are looked up here from `knowledge/champions/*.md` and are digit-free
	 * by construction (`parseChampionClauses` refuses any clause carrying a number), so nothing
	 * arriving this way can become a statistic. Unknown or empty is normal and means no clauses.
	 */
	champion?: string
	/**
	 * The enemy jungler, for the matchup half of the knowledge pack. `trusted` only.
	 *
	 * Same closed-vocabulary rule as `champion`: a NAME, never prose. Absent means the matchup
	 * section is simply missing, which is what champ select and an unread client both look like.
	 */
	counterpart?: string | null
	/**
	 * Whether the ROLE file rides along with the champion files. `trusted` only, default true.
	 *
	 * A boolean, not a string, so the invariant above survives: a caller may withhold a whole
	 * section of the knowledge pack and may not write one. It exists because the 2026-09-11
	 * knowledge ablation could not reach the role file — the two champion sections are keyed by a
	 * NAME and an absent name is a state the client reaches by itself, while `knowledge/general/
	 * jungle.md` has no name to withhold. Nothing in the app passes it; `scripts/bench-stream.ts`
	 * does, as the `+noknow` arm.
	 */
	role?: boolean
	/**
	 * Cache the static system prefix where the provider supports it. DEFAULT TRUE.
	 *
	 * It changes no byte of the prompt — the same `coachSystemPrompt` text is sent either way — so
	 * unlike `mode` this is not an arm in the editorial sense. It is a flag at all so a measurement
	 * can pay the cold price on purpose; the app never passes it.
	 */
	cache?: boolean
	/** How hard the model may think. Pinned per arm and recorded; see `CoachEffort`. */
	effort?: CoachEffort
	/**
	 * Stream the answer, calling this with each text delta as it arrives.
	 *
	 * The PRESENCE of this callback is what turns streaming on, and that is the only thing that
	 * decides it: an arm cannot be streaming in the harness and buffered in the app, because both
	 * reach the model through this one call. The full text is still returned when the turn ends, so
	 * a caller that only wants the sentence ignores the stream and reassembles nothing.
	 */
	onDelta?: (delta: string) => void
}

export interface CoachTurnResult {
	ok: boolean
	/** What it said. Empty string is a real answer meaning it produced nothing. */
	text: string
	/** Echoed so a caller can never attribute an answer to a model it did not ask for. */
	model: string
	/** Whether the frame was actually sent — a "vision" run without one is a different experiment. */
	frameSent: boolean
	latencyMs: number
	reason?: string
	/* ---- additive: what the latency work needs and the old callers ignore ---- */
	/**
	 * Time to the FIRST text delta. Streaming runs only; undefined when the answer was buffered.
	 *
	 * Not the same thing as time to first syllable — a delta may be half a word, and the browser
	 * cannot speak half a word. `SpeechChunker` decides that; this is the floor beneath it.
	 */
	ttftMs?: number
	/**
	 * Time until the first chunk a voice could SAY, by `src/shared/speech-chunks.ts`.
	 *
	 * This is the number that decides whether a model is eligible for a live coach, because it is
	 * the one he experiences. Undefined when nothing was said — a PASS has no first syllable, and
	 * recording one as zero would flatter every arm that stays quiet.
	 */
	speakableMs?: number
	/** Tokens in and out, and how many of them a cache served. Undefined when the provider said. */
	usage?: TurnUsage
	/** Whether a cache breakpoint was SENT. Says nothing about whether it hit; read `usage`. */
	cacheRequested?: boolean
	/** The effort this turn actually ran at, echoed so a run file can never lose it. */
	effort?: CoachEffort
}

/**
 * Build the SDK model handle. Kept separate so the provider list stays declarative.
 *
 * EXPORTED as `modelHandleFor` for the callers that are not the live coach — `scripts/postgame-arm.ts`
 * sends a whole frozen bundle, and the retired `e2e-real-game.ts` judge graded a coach line. Both
 * need their OWN system prompt. It deliberately does not go
 * through `coachTurn` — `coachTurn`'s whole invariant is that the system prompt is not a
 * parameter, and a judge sharing the coach's prompt would be grading the coach against its own
 * opinion of itself. Sharing only the provider plumbing keeps that invariant intact while still
 * meaning one place decides how each vendor is reached.
 */
export const modelHandleFor = async (p: ProviderInfo, key: string, model: string) => {
	if (p.id === "gemini-http") {
		const { createGoogleGenerativeAI } = await import("@ai-sdk/google")
		return createGoogleGenerativeAI({ apiKey: key })(model)
	}
	if (p.id === "anthropic") {
		const { createAnthropic } = await import("@ai-sdk/anthropic")
		return createAnthropic({ apiKey: key })(model)
	}
	const { createOpenAI } = await import("@ai-sdk/openai")
	// OpenAI itself, plus every OpenAI-compatible endpoint, differ only by base URL.
	return createOpenAI({ apiKey: key, ...(p.baseUrl ? { baseURL: p.baseUrl } : {}) })(model)
}

/* ========================================================= the two latency knobs */

/**
 * THE SYSTEM PROMPT, built from the closed set. One function, so caching cannot change the words.
 *
 * This is the invariant the whole file rests on, restated as a function because prompt caching is
 * about to split these bytes into two API fields. The cached arm and the uncached arm call THIS,
 * and `live-providers.test.ts` asserts the two requests carry byte-identical system text — because
 * a cache that quietly reworded the prompt would turn a latency measurement into a prompt
 * measurement, which is the confound this module exists to prevent.
 */
export const coachSystemPrompt = (req: {
	mode?: LiveCoachMode
	champion?: string
	counterpart?: string | null
	role?: boolean
}): string => {
	const mode = req.mode ?? DEFAULT_LIVE_COACH_MODE
	return liveCoachSystemPrompt({
		mode,
		championKnowledge:
			mode === "trusted" ?
				fullKnowledge({
					champion: req.champion ?? "",
					counterpart: req.counterpart ?? null,
					...(req.role === false ? { role: false } : {})
				})
			:	liveChampionKnowledge(req.champion ?? "")
	})
}

/**
 * How hard the model is allowed to think, as a CLOSED SET of two.
 *
 * Every model reachable from here now defaults to thinking, and thinking is the whole latency wall:
 * measured on this machine's own key, Opus goes 6.3s to 3.6s, gemini-3.8-flash 6.4s to 1.2s and
 * Sonnet 1.8s to 1.0s by moving this one knob. An arm run at a different effort from its rivals is
 * measuring effort, not the model — so it is named, recorded in every run file beside the model id,
 * and pinned per arm the way `level: "commentary"` is pinned.
 *
 * A closed set rather than a string for the same reason `mode` is a mode: the knob NAMES have a
 * different spelling per vendor and every wrong spelling is a 400 that looks like a broken model.
 * Anthropic wants `output_config.effort`; Google's turn path wants
 * `generationConfig.thinkingConfig.thinkingLevel`; `thinkingBudget` is refused outright by the live
 * models and, set to 0, was refused by gemini-3.6-flash for twenty minutes of a previous session
 * while looking exactly like a model producing nothing. Nobody should be typing those by hand.
 */
export type CoachEffort = "low" | "default"

/**
 * The vendor spelling of `effort`, and nothing else.
 *
 * `default` sends NOTHING, deliberately: it is the shipped behaviour and must stay byte-identical
 * to the runs already on disk, so the control arm is the absence of this feature rather than an
 * explicit "high".
 */
const effortOptions = (p: ProviderInfo, effort: CoachEffort, model: string): Record<string, unknown> => {
	if (effort === "default") return {}
	if (p.id === "anthropic") {
		/*
		 * MEASURED on this key, 2026-09-18: `claude-haiku-4-5` answers an effort request with a 400,
		 * "This model does not support the effort parameter", and the SDK surfaces that as an empty
		 * stream — i.e. as a model that produced nothing, which is exactly the failure this file's
		 * previous note warned about. Effort is a property of the 4.6-and-later thinking models; the
		 * 4.5 generation does not think unless asked with `budget_tokens`, so on Haiku the low-effort
		 * arm IS the default arm and sending nothing is the honest way to run it.
		 */
		if (/haiku-4-5|sonnet-4-5|opus-4-5/.test(model)) return {}
		return { anthropic: { effort: "low" } }
	}
	if (p.id === "gemini-http") return { google: { thinkingConfig: { thinkingLevel: "low" } } }
	// OpenAI-compatible endpoints spell it differently again and none of them is measured here;
	// sending an option a provider may refuse is how a working model gets scored as broken.
	return {}
}

/**
 * Whether this provider can be told to cache a prefix, and how.
 *
 * ANTHROPIC is explicit: one `cache_control` breakpoint on the system block. That block is the
 * persona, the prompt, his champion's prose, the counterpart's and the role file — about 33,000
 * characters, static for a whole game, and re-sent on every single turn until now.
 *
 * GOOGLE is implicit and already on: repeat calls come back with `cachedContentTokenCount` set
 * without anyone asking for it, so there is nothing to send and a `cache: false` arm CANNOT turn it
 * off. Any Gemini cache figure in a run file is therefore an observation, never an intervention,
 * and the reports say so rather than crediting this code for it.
 *
 * The OpenAI-compatible endpoints cache automatically too where they cache at all; same story.
 */
const cacheBreakpoint = (p: ProviderInfo): Record<string, unknown> | null =>
	p.id === "anthropic" ? { anthropic: { cacheControl: { type: "ephemeral" } } } : null

/** What a turn cost, in the four numbers that decide whether caching paid for itself. */
export interface TurnUsage {
	inputTokens: number
	outputTokens: number
	/** Tokens served from a cache — Anthropic's `cache_read_input_tokens`, Google's implicit hit. */
	cacheReadTokens: number
	/** Tokens WRITTEN to the cache, billed at ~1.25x. Anthropic only; zero everywhere else. */
	cacheWriteTokens: number
}

/**
 * The SDK's usage object, flattened — and it is read DEFENSIVELY on purpose.
 *
 * `inputTokens` is a structured value on this SDK version (`{total, noCache, cacheRead, cacheWrite}`)
 * and was a plain number on the previous one, and a provider that reports neither is a normal
 * outcome rather than an error. Every cost figure in this repo is derived from these four numbers,
 * so a shape change that silently produced zeros would not look like a bug — it would look like
 * caching having no effect, which is precisely the claim under test.
 */
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

const usageOf = (usage: unknown): TurnUsage | null => {
	if (!usage || typeof usage !== "object") return null
	const u = usage as Record<string, unknown>
	/*
	 * MEASURED, and it cost a whole run to find: on this SDK version the cache figures are NOT on
	 * `inputTokens`. They live in `inputTokenDetails: {noCacheTokens, cacheReadTokens,
	 * cacheWriteTokens}`, while `inputTokens` is the grand total. A reader that looked only at the
	 * obvious field returned zero for every cache number and the run below it said, quite
	 * convincingly, that prompt caching does nothing — with `cache_control` provably on the wire.
	 * The older shape (`cachedInputTokens`, or a structured `inputTokens`) is still read, because a
	 * stored run must stay re-derivable across an SDK bump.
	 */
	const details =
		u.inputTokenDetails && typeof u.inputTokenDetails === "object" ?
			(u.inputTokenDetails as Record<string, unknown>)
		:	null
	const inp = u.inputTokens
	const out = u.outputTokens
	const inputObj = inp && typeof inp === "object" ? (inp as Record<string, unknown>) : null
	const outObj = out && typeof out === "object" ? (out as Record<string, unknown>) : null
	const cacheRead =
		details ? num(details.cacheReadTokens)
		: inputObj ? num(inputObj.cacheRead)
		: num(u.cachedInputTokens)
	const cacheWrite =
		details ? num(details.cacheWriteTokens)
		: inputObj ? num(inputObj.cacheWrite)
		: 0
	const total = inputObj ? num(inputObj.total) : num(inp)
	const totalOut = outObj ? num(outObj.total) : num(out)
	if (total === 0 && totalOut === 0 && cacheRead === 0) return null
	return {
		inputTokens: total,
		outputTokens: totalOut,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite
	}
}

/**
 * Run one turn. Never throws: this is called from a live game and a provider outage must not be
 * able to interrupt one.
 *
 * The system prompt is BUILT here, from a mode out of a closed set and a champion name, and is
 * still not a parameter — the invariant survives the mode picker. Every provider asked with the
 * same mode and champion is asked exactly the same words by construction, so a model comparison
 * cannot accidentally have varied the prompt; and the one axis a caller can move is an arm that
 * the 2026-09-05 ablation measured rather than a sentence somebody typed. Those arms are kept as
 * data in `src/review/ablation-arms.ts`; the script that ran them is retired.
 */
export const coachTurn = async (req: CoachTurnRequest): Promise<CoachTurnResult> => {
	const started = Date.now()
	const p = providerById(req.provider)
	const model = req.model && req.model.trim() !== "" ? req.model.trim() : (p?.defaultModel ?? "")
	const fail = (reason: string): CoachTurnResult => ({
		ok: false,
		text: "",
		model,
		frameSent: false,
		latencyMs: Date.now() - started,
		reason
	})
	if (!p) return fail(`no provider called ${req.provider}`)
	const key = providerKey(p)
	if (!key) return fail(`no key — put one in data/${p.keyFile}`)

	/*
	 * The mock answers from the block alone. It reads the first line of the "not looking at" list,
	 * which is the fact the ranker chose — so it speaks exactly what a model contributing nothing
	 * would say, and any real arm has to beat that to be worth its latency.
	 */
	if (p.id === "mock") {
		const facts = req.blockText
			.split("\n")
			.filter(l => l.startsWith("- "))
			.map(l => l.slice(2).trim())
		return {
			ok: true,
			text: facts[0] ?? "PASS",
			model,
			frameSent: typeof req.frameJpegBase64 === "string" && req.frameJpegBase64.length > 0,
			latencyMs: Date.now() - started
		}
	}

	try {
		const { generateText, streamText } = await import("ai")
		const handle = await modelHandleFor(p, key, model)
		const frameSent = typeof req.frameJpegBase64 === "string" && req.frameJpegBase64.length > 0
		const effort: CoachEffort = req.effort ?? "default"
		const wantsCache = req.cache !== false
		const breakpoint = wantsCache ? cacheBreakpoint(p) : null

		/*
		 * The prompt, and WHERE IT SITS, which is the whole of the caching change.
		 *
		 * It used to go in the SDK's `system` field. It now goes in `messages` as a system message,
		 * which is the only place a provider option can be attached to it — the `system` field has
		 * no slot for one. Every provider here folds a leading system message straight back into its
		 * own system channel (Anthropic's `system` blocks, Google's `systemInstruction`, OpenAI's
		 * first message), so this moves a cache breakpoint and not a single byte of prompt.
		 * `live-providers.test.ts` pins that equality.
		 *
		 * `trusted` gets the FULL knowledge — his champion's file, the counterpart's, and the role's,
		 * with their numbers intact — so a turn-based arm is asked the same question the socket is
		 * asked and the bench can compare the two. The older modes keep the digit-free clause list
		 * they were measured against, byte for byte.
		 */
		const system = coachSystemPrompt(req)
		const messages = [
			{
				role: "system" as const,
				content: system,
				...(breakpoint ? { providerOptions: breakpoint as never } : {})
			},
			{
				role: "user" as const,
				content: [
					...(frameSent ? [{ type: "image" as const, image: req.frameJpegBase64! }] : []),
					{ type: "text" as const, text: req.blockText }
				]
			}
		]
		const common = {
			model: handle,
			messages,
			// A system message inside `messages` is refused by default; this is the switch that
			// allows it, and it is the only reason the breakpoint above can be attached at all.
			allowSystemInMessages: true,
			providerOptions: effortOptions(p, effort, model) as never,
			/*
			 * Generous, and that is deliberate even though the coach speaks ONE sentence.
			 *
			 * Reasoning models spend this budget THINKING before they answer, so a tight cap does
			 * not produce a short line — it produces a truncated one. Measured: at 200 tokens
			 * gemini-3.6-flash returned "Kayn is 2" and stopped mid-number. A benchmark run under
			 * that cap would have scored a good model as broken, which is the exact confound this
			 * whole comparison exists to avoid.
			 *
			 * Length is controlled by the PROMPT, which asks for one sentence, not by starving the
			 * model of tokens.
			 */
			maxOutputTokens: 2000
			/*
			 * The thinking knob is now `effort`, and it is STILL not free text — see `CoachEffort`.
			 *
			 * The previous note here said to send no thinking options at all, after
			 * `thinkingBudget: 0` was refused by gemini-3.6-flash and looked for twenty minutes like
			 * a model producing nothing. That reasoning was right about the spelling and wrong about
			 * the conclusion: thinking IS the latency wall, every model reachable from here now
			 * defaults to it, and refusing to touch it disqualifies every strong model by a setting
			 * rather than by its answers. So the knob exists, its vendor spelling lives in one
			 * function, and `default` sends nothing — the shipped behaviour, byte-identical to the
			 * runs already on disk.
			 */
		}

		/* ---- buffered: the shipped shape. One round trip, and no first-token number to report ---- */
		if (!req.onDelta) {
			const result = await generateText(common)
			const usage = usageOf(result.usage)
			return {
				ok: true,
				text: (result.text ?? "").trim(),
				model,
				frameSent,
				latencyMs: Date.now() - started,
				cacheRequested: breakpoint !== null,
				effort,
				...(usage ? { usage } : {})
			}
		}

		/*
		 * ---- streamed ----
		 *
		 * Two clocks come out of here and they are not the same number. `ttftMs` is the first delta,
		 * which is what a provider comparison usually quotes; `speakableMs` is the first chunk a
		 * voice could actually say, decided by `SpeechChunker`, and it is the one he experiences.
		 * The gap between them is a property of the model's writing rather than of the network, so
		 * reporting only the first would flatter a model that opens on a token nobody can pronounce.
		 */
		const chunker = new SpeechChunker()
		let ttftMs: number | undefined
		let speakableMs: number | undefined
		let text = ""
		const result = streamText(common)
		for await (const delta of result.textStream) {
			if (ttftMs === undefined) ttftMs = Date.now() - started
			text += delta
			for (const chunk of chunker.push(delta)) {
				if (speakableMs === undefined) speakableMs = Date.now() - started
				req.onDelta(chunk)
			}
		}
		for (const chunk of chunker.flush()) {
			if (speakableMs === undefined) speakableMs = Date.now() - started
			req.onDelta(chunk)
		}
		const usage = usageOf(await result.usage)
		return {
			ok: true,
			text: text.trim(),
			model,
			frameSent,
			latencyMs: Date.now() - started,
			cacheRequested: breakpoint !== null,
			effort,
			...(ttftMs === undefined ? {} : { ttftMs }),
			...(speakableMs === undefined ? {} : { speakableMs }),
			...(usage ? { usage } : {})
		}
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err))
	}
}

/** Which providers are usable right now, for a UI that must not offer a dead option. */
export const providerStatus = (): { id: ProviderId; label: string; available: boolean; note: string; defaultModel: string }[] =>
	PROVIDERS.filter(p => p.offered !== false).map(p => ({
		id: p.id,
		label: p.label,
		available: providerKey(p) !== null,
		note: p.note,
		defaultModel: p.defaultModel
	}))

/**
 * Store or clear a provider's key.
 *
 * Write-only from the browser's point of view: there is no endpoint that reads one back, and the
 * key never enters the settings table, because settings round-trip through `GET /api/settings`
 * into the renderer. Same rule as `data/gemini.key`, for the same reason.
 */
export const setProviderKey = (p: ProviderInfo, key: string): void => {
	const path = `${DATA_DIR}/${p.keyFile}`
	const trimmed = key.trim()
	if (trimmed === "") {
		if (existsSync(path)) rmSync(path)
		return
	}
	mkdirSync(DATA_DIR, { recursive: true })
	writeFileSync(path, `${trimmed}\n`, { mode: 0o600 })
	// Explicit, because an existing file keeps its old mode through writeFileSync.
	chmodSync(path, 0o600)
}
