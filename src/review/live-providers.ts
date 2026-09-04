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

import { existsSync, readFileSync } from "node:fs"
import { DATA_DIR } from "../shared/constants.ts"
import { LIVE_COACH_SYSTEM_PROMPT } from "../shared/live-prompt.ts"

export type ProviderId = "gemini-http" | "anthropic" | "openai" | "kimi" | "glm"

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
	/** The ground-truth block, exactly as `renderState` produced it. */
	blockText: string
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

/** Build the SDK model handle. Kept separate so the provider list stays declarative. */
const modelFor = async (p: ProviderInfo, key: string, model: string) => {
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
 * The system prompt comes from `shared/live-prompt.ts` and is NOT a parameter, so every provider
 * is asked exactly the same thing by construction. A caller cannot accidentally run a comparison
 * in which the prompt was also a variable.
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

	try {
		const { generateText } = await import("ai")
		const handle = await modelFor(p, key, model)
		const frameSent = typeof req.frameJpegBase64 === "string" && req.frameJpegBase64.length > 0
		const result = await generateText({
			model: handle,
			system: LIVE_COACH_SYSTEM_PROMPT,
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
