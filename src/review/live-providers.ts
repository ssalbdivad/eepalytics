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
		defaultModel: "gemini-3.6-flash",
		note: "Same key as the live voice coach. The control arm: same model family, no socket."
	},
	{
		id: "anthropic",
		label: "Anthropic",
		keyFile: "anthropic.key",
		defaultModel: "claude-sonnet-5",
		note: "Needs an API key; the `claude` CLI login used by the reviewer cannot take an image."
	},
	{
		id: "openai",
		label: "OpenAI",
		keyFile: "openai.key",
		defaultModel: "gpt-5",
		note: "platform.openai.com/api-keys"
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
		const { generateText } = await import("ai")
		const handle = await modelHandleFor(p, key, model)
		const frameSent = typeof req.frameJpegBase64 === "string" && req.frameJpegBase64.length > 0
		const result = await generateText({
			model: handle,
			/*
			 * `trusted` gets the FULL knowledge — his champion's file, the counterpart's, and the
			 * role's, with their numbers intact — so a turn-based arm is asked the same question the
			 * socket is asked and the bench can compare the two. The older modes keep the digit-free
			 * clause list they were measured against, byte for byte.
			 */
			system: liveCoachSystemPrompt({
				mode: req.mode ?? DEFAULT_LIVE_COACH_MODE,
				championKnowledge:
					(req.mode ?? DEFAULT_LIVE_COACH_MODE) === "trusted" ?
						fullKnowledge({
							champion: req.champion ?? "",
							counterpart: req.counterpart ?? null,
							...(req.role === false ? { role: false } : {})
						})
					:	liveChampionKnowledge(req.champion ?? "")
			}),
			messages: [
				{
					role: "user",
					content: [
						...(frameSent ?
							[{ type: "image" as const, image: req.frameJpegBase64! }]
						:	[]),
						{ type: "text" as const, text: req.blockText }
					]
				}
			],
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
			maxOutputTokens: 2000,
			/*
			 * NO provider-specific thinking options, and that is a correction.
			 *
			 * I set `thinkingConfig: { thinkingBudget: 0 }` for Google, `thinking: disabled` for
			 * Anthropic and `reasoningEffort: minimal` for OpenAI, on the reasoning that an unknown
			 * key would simply be ignored. It is NOT ignored: gemini-3.6-flash rejects that budget
			 * with "Request contains an invalid argument", so every turn failed and returned empty
			 * text. For twenty minutes that looked like a model producing nothing.
			 *
			 * Thinking is a real problem for a coach that has about a second — measured at 15.2s
			 * for a first answer — but the fix is choosing a non-reasoning model in the settings,
			 * not sending options a provider may refuse. Model choice is his, and this stays out
			 * of it.
			 */
		})
		return {
			ok: true,
			text: (result.text ?? "").trim(),
			model,
			frameSent,
			latencyMs: Date.now() - started
		}
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err))
	}
}

/** Which providers are usable right now, for a UI that must not offer a dead option. */
export const providerStatus = (): { id: ProviderId; label: string; available: boolean; note: string; defaultModel: string }[] =>
	PROVIDERS.map(p => ({
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
