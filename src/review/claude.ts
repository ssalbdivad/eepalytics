/**
 * Driving Claude.
 *
 * There is no `ANTHROPIC_API_KEY` on this machine, but the `claude` CLI at
 * `~/.local/bin/claude` (v2.1.258) is authenticated against the user's own subscription.
 * So the default transport is a **headless CLI subprocess**, and the direct HTTPS path is
 * only taken when an API key happens to be present.
 *
 * The CLI invocation is deliberately stripped down. Measured on this machine:
 *
 * ```
 * $ printf '<digest>' | claude -p --model claude-sonnet-5 --output-format json \
 *     --system-prompt "<persona from AGENTS.md>" --tools "" \
 *     --disable-slash-commands --strict-mcp-config --no-session-persistence \
 *     --safe-mode --effort medium
 * ```
 *
 * | invocation                                   | input tokens | cost      | wall  |
 * |----------------------------------------------|--------------|-----------|-------|
 * | with `--safe-mode`, tools off, tiny prompt   | 294          | $0.0016   | 3.0 s |
 * | without `--safe-mode` (default system prompt)| 2 + 1512 cw  | $0.0062   | 4.8 s |
 *
 * `--safe-mode` is what removes the 1,512-token cache-creation charge: it disables CLAUDE.md
 * discovery, skills, plugins, hooks and MCP, so the only system prompt is ours. That also
 * makes the call deterministic — a coaching run must not be affected by whatever the user
 * happens to have in their global config. `--tools ""` disables every built-in tool; this is
 * a pure text -> JSON call and the model must not be able to touch the filesystem.
 *
 * `--json-schema` works — the CLI validates output against a JSON Schema and hands it back
 * pre-parsed on `structured_output` — but it is **not free**. Measured on the same real
 * 8.7 KB game digest, Sonnet 5, `--effort low`:
 *
 * | schema        | turns | output tokens | wall   | cost    |
 * |---------------|-------|---------------|--------|---------|
 * | `--json-schema`| 2    | 4,622         | 65.3 s | $0.1115 |
 * | none          | 1     | 1,976         | 27.8 s | $0.0676 |
 *
 * The CLI spends a whole extra turn re-emitting the answer into the schema. Since the prompt
 * already describes the shape and `parse.ts` is forgiving, the default `schemaMode` is
 * **`"on-retry"`**: the first attempt is the cheap one, and the schema is only attached to the
 * retry that a malformed first answer triggers. That is the best of both — normal runs cost
 * $0.07, and the pathological run gets server-side validation instead of a coin flip.
 *
 * End to end on the shipped defaults (Sonnet 5, `medium` effort, `on-retry` schema), against a
 * real 33-frame ranked game pulled live from the LCU:
 *
 * | pass  | wall   | cost    | turns | citation violations |
 * |-------|--------|---------|-------|---------------------|
 * | game  | 53.7 s | $0.0913 | 1     | 0                   |
 * | trend | 24.0 s | $0.0578 | 1     | 0                   |
 *
 * At `--effort high` (the CLI's own default) the same game review took 119.8 s and $0.19 for
 * 10.8k output tokens, most of it reasoning the analysis unit had already done. Hence
 * `medium`.
 *
 * NOTHING here throws at the daemon. Every failure comes back as `{ok: false, code, error}`
 * with whatever metadata we did manage to collect.
 */

import { spawn } from "node:child_process"
import { appendFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { LOGS_DIR } from "../shared/constants.ts"

/* ============================================================== types */

/** A JSON Schema object, passed straight through to `--json-schema`. */
export type JsonSchema = Record<string, unknown>

export interface CoachRequest {
	/** The persona. Becomes `--system-prompt` (CLI) or `system` (API). */
	system: string
	/** The digest + output instructions. Written to the CLI's stdin, never to argv. */
	user: string
	/** Model id, e.g. `claude-sonnet-5`. Defaults to `CSK_COACH_MODEL` then Sonnet 5. */
	model?: string
	/** The output schema. How it is used depends on `schemaMode`. */
	schema?: JsonSchema
	/**
	 * `"on-retry"` (default) — attempt 1 runs without `--json-schema` (1 turn, ~half the
	 * cost); only a retry after unparseable output attaches it.
	 * `"always"` — pay for server-side validation on every call.
	 * `"never"` — the schema reaches the model through the prompt only.
	 */
	schemaMode?: "always" | "on-retry" | "never"
	/** Hard wall-clock ceiling for one attempt. Default 180 s. */
	timeoutMs?: number
	/** Total attempts including the first. Default 2 = "one retry on malformed output". */
	maxAttempts?: number
	/** Passed to the CLI as `--max-budget-usd`. Belt-and-braces against a runaway loop. */
	maxCostUsd?: number
	/**
	 * Thinking depth. Measured on this machine with a real 8.7 KB game digest on Sonnet 5:
	 * `high` (the CLI default) took 120 s and $0.19 for 10.8k output tokens, most of which
	 * was reasoning. A coaching review is not a hard reasoning problem — the analysis unit
	 * has already done the arithmetic — so the default here is `medium`.
	 */
	effort?: CoachEffort
	/** Force a transport. Otherwise: API when a key is set, CLI when it is not. */
	transport?: CoachTransport
	/** Tag written into the JSONL log line so runs can be traced back to a job. */
	label?: string
	signal?: AbortSignal
}

export type CoachTransport = "cli" | "api"

export type CoachEffort = "low" | "medium" | "high" | "xhigh" | "max"

export type SchemaMode = "always" | "on-retry" | "never"

export type CoachErrorCode =
	/** Neither an authenticated CLI nor an API key could be found. */
	| "no-transport"
	/** The `claude` binary could not be spawned at all. */
	| "spawn-failed"
	| "timeout"
	| "aborted"
	/** The CLI exited non-zero, or reported `is_error`. */
	| "cli-error"
	/** The HTTPS call failed or returned non-2xx. */
	| "api-error"
	/** We got a response but there was no text in it. */
	| "empty-output"
	/** There was text, but no JSON object could be recovered from it. */
	| "malformed-json"

export interface CoachUsage {
	inputTokens: number | null
	outputTokens: number | null
	cacheReadTokens: number | null
	cacheCreationTokens: number | null
	/** `null` when the transport did not report a cost and we cannot compute one honestly. */
	costUsd: number | null
}

export interface CoachMeta {
	transport: CoachTransport | null
	model: string
	/** Wall clock across every attempt. */
	durationMs: number
	attempts: number
	usage: CoachUsage
	sessionId: string | null
	/** How many assistant turns the CLI needed. >1 usually means a schema-validation retry. */
	turns: number | null
	/** Non-fatal things that happened on the way (a retried attempt, a schema fallback). */
	warnings: string[]
}

export type CoachResult =
	| { ok: true; data: unknown; text: string; meta: CoachMeta }
	| { ok: false; code: CoachErrorCode; error: string; text: string | null; meta: CoachMeta }

/* ========================================================== constants */

const DEFAULT_MODEL = process.env.CSK_COACH_MODEL ?? "claude-sonnet-5"
const DEFAULT_TIMEOUT_MS = Number(process.env.CSK_COACH_TIMEOUT_MS ?? 240_000)
const DEFAULT_EFFORT = (process.env.CSK_COACH_EFFORT ?? "medium") as CoachEffort
const DEFAULT_SCHEMA_MODE = (process.env.CSK_COACH_SCHEMA_MODE ?? "on-retry") as SchemaMode
const DEFAULT_MAX_ATTEMPTS = 2
/** Read per call, not at module load, so a test or a setting can redirect it. */
const cliBin = (): string => process.env.CSK_CLAUDE_BIN ?? "claude"
/** `CSK_COACH_LOG=0` silences both the console line and the JSONL file (used by the tests). */
const logEnabled = (): boolean => process.env.CSK_COACH_LOG !== "0"
const LOG_PATH = `${LOGS_DIR}/coach.jsonl`
const ANTHROPIC_VERSION = "2023-06-01"

/**
 * List prices, USD per million tokens, for the models we offer. Used ONLY on the API path —
 * the CLI reports `total_cost_usd` itself and we always prefer the number it gives us.
 * A model that is not in this table reports `costUsd: null` rather than a guess.
 */
const PRICES: Record<string, { in: number; out: number }> = {
	"claude-opus-5": { in: 5, out: 25 },
	"claude-sonnet-5": { in: 2, out: 10 },
	"claude-haiku-4-5": { in: 1, out: 5 }
}

const emptyUsage = (): CoachUsage => ({
	inputTokens: null,
	outputTokens: null,
	cacheReadTokens: null,
	cacheCreationTokens: null,
	costUsd: null
})

/* ======================================================= json recovery */

/**
 * Pull a JSON value out of arbitrary model prose. Handles ```json fences, leading
 * commentary, and trailing chatter by scanning for the outermost balanced object while
 * respecting string literals and escapes. Returns `undefined` when nothing parses.
 *
 * Exported because `parse.ts` needs the identical recovery on the CLI's `result` field.
 */
export const extractJson = (text: string): unknown => {
	const trimmed = text.trim()
	if (trimmed === "") return undefined

	const direct = tryParse(trimmed)
	if (direct !== undefined) return direct

	// ```json … ``` — take the longest fenced block that parses.
	const fences = trimmed.matchAll(/```(?:json5?|jsonc)?\s*\n?([\s\S]*?)```/gi)
	let best: unknown = undefined
	let bestLen = 0
	for (const m of fences) {
		const body = (m[1] ?? "").trim()
		if (body.length <= bestLen) continue
		const parsed = tryParse(body) ?? scanBalanced(body)
		if (parsed !== undefined) {
			best = parsed
			bestLen = body.length
		}
	}
	if (best !== undefined) return best

	return scanBalanced(trimmed)
}

const tryParse = (s: string): unknown => {
	try {
		return JSON.parse(s)
	} catch {
		return undefined
	}
}

/** Scan for the first balanced `{…}` (then `[…]`), ignoring braces inside string literals. */
const scanBalanced = (s: string): unknown => {
	for (const [open, close] of [
		["{", "}"],
		["[", "]"]
	] as const) {
		const start = s.indexOf(open)
		if (start === -1) continue
		let depth = 0
		let inString = false
		let escaped = false
		for (let i = start; i < s.length; i++) {
			const ch = s[i]
			if (escaped) {
				escaped = false
				continue
			}
			if (ch === "\\") {
				if (inString) escaped = true
				continue
			}
			if (ch === '"') {
				inString = !inString
				continue
			}
			if (inString) continue
			if (ch === open) depth++
			else if (ch === close) {
				depth--
				if (depth === 0) {
					const parsed = tryParse(s.slice(start, i + 1))
					if (parsed !== undefined) return parsed
					break
				}
			}
		}
	}
	return undefined
}

/* ============================================================== entry */

/**
 * One coaching call. Retries once by default when the model returns something we cannot
 * parse, appending a short repair instruction rather than resending the identical prompt.
 * Never throws.
 */
export const runCoach = async (req: CoachRequest): Promise<CoachResult> => {
	const started = Date.now()
	const model = req.model ?? DEFAULT_MODEL
	const maxAttempts = Math.max(1, req.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
	const transport = req.transport ?? (hasApiKey() ? "api" : "cli")
	const warnings: string[] = []

	let last: CoachResult | null = null

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (req.signal?.aborted) {
			last = fail("aborted", "aborted before attempt", null, {
				transport,
				model,
				durationMs: Date.now() - started,
				attempts: attempt - 1,
				usage: last?.meta.usage ?? emptyUsage(),
				sessionId: last?.meta.sessionId ?? null,
				turns: last?.meta.turns ?? null,
				warnings
			})
			break
		}

		const user =
			attempt === 1 ? req.user : (
				`${req.user}\n\n---\n\nYour previous response could not be parsed as JSON${
					last && !last.ok ? ` (${last.code}: ${last.error})` : ""
				}. Return ONLY the JSON object — no prose before or after it, no markdown fences, no trailing commentary.`
			)

		const mode = req.schemaMode ?? DEFAULT_SCHEMA_MODE
		const schema =
			!req.schema || mode === "never" ? undefined
			: mode === "always" ? req.schema
			: attempt > 1 ? req.schema
			: undefined
		if (schema && attempt > 1) warnings.push("retrying with server-side schema validation")

		const attemptResult =
			transport === "api" ?
				await callApi({ ...req, user, model, schema })
			:	await callCli({ ...req, user, model, schema })

		last = {
			...attemptResult,
			meta: {
				...attemptResult.meta,
				attempts: attempt,
				durationMs: Date.now() - started,
				warnings: [...warnings, ...attemptResult.meta.warnings]
			}
		} as CoachResult

		if (last.ok) break
		warnings.push(`attempt ${attempt} failed: ${last.code} — ${last.error}`)
		if (!RETRYABLE.has(last.code)) break
	}

	const result =
		last ??
		fail("no-transport", "no attempt was made", null, {
			transport,
			model,
			durationMs: Date.now() - started,
			attempts: 0,
			usage: emptyUsage(),
			sessionId: null,
			turns: null,
			warnings
		})

	logRun(req.label ?? "coach", result)
	return result
}

/** Failures where a second attempt is plausibly different. A timeout is not one of them. */
const RETRYABLE = new Set<CoachErrorCode>(["malformed-json", "empty-output"])

const hasApiKey = (): boolean => {
	const k = process.env.ANTHROPIC_API_KEY
	return typeof k === "string" && k.trim() !== ""
}

/** Is a coaching transport available at all? Cheap enough for a health check. */
export const coachTransport = (): CoachTransport | null => (hasApiKey() ? "api" : cliBin() ? "cli" : null)

/* ================================================================ cli */

interface CliResultJson {
	result?: unknown
	structured_output?: unknown
	is_error?: boolean
	subtype?: string
	session_id?: string
	total_cost_usd?: number
	duration_ms?: number
	stop_reason?: string
	num_turns?: number
	api_error_status?: unknown
	usage?: {
		input_tokens?: number
		output_tokens?: number
		cache_read_input_tokens?: number
		cache_creation_input_tokens?: number
	}
}

const callCli = async (req: CoachRequest & { model: string }): Promise<CoachResult> => {
	const started = Date.now()
	const warnings: string[] = []
	const base = {
		transport: "cli" as const,
		model: req.model,
		attempts: 1,
		sessionId: null as string | null
	}
	let turns: number | null = null

	const args = [
		"-p",
		"--model",
		req.model,
		"--output-format",
		"json",
		"--system-prompt",
		req.system,
		// A pure text -> JSON call. The model gets no filesystem, no bash, no web.
		"--tools",
		"",
		"--disable-slash-commands",
		"--strict-mcp-config",
		"--no-session-persistence",
		// Ignore the user's CLAUDE.md / skills / plugins / hooks: determinism, and it drops
		// ~1,500 cache-creation tokens per call.
		"--safe-mode",
		"--effort",
		req.effort ?? DEFAULT_EFFORT
	]
	if (req.schema) args.push("--json-schema", JSON.stringify(req.schema))
	if (typeof req.maxCostUsd === "number" && req.maxCostUsd > 0)
		args.push("--max-budget-usd", String(req.maxCostUsd))

	const bin = cliBin()
	const proc = await runProcess(bin, args, req.user, req.timeoutMs ?? DEFAULT_TIMEOUT_MS, req.signal)

	const meta = (usage: CoachUsage, sessionId: string | null): CoachMeta => ({
		...base,
		sessionId,
		turns,
		durationMs: Date.now() - started,
		usage,
		warnings
	})

	if (proc.kind === "spawn-error")
		return fail(
			"spawn-failed",
			`could not run \`${bin}\`: ${proc.message}. Install Claude Code or set CSK_CLAUDE_BIN / ANTHROPIC_API_KEY.`,
			null,
			meta(emptyUsage(), null)
		)
	if (proc.kind === "timeout")
		return fail("timeout", `no response after ${proc.timeoutMs} ms`, proc.stdout || null, meta(emptyUsage(), null))
	if (proc.kind === "aborted")
		return fail("aborted", "cancelled", proc.stdout || null, meta(emptyUsage(), null))

	const envelope = extractJson(proc.stdout) as CliResultJson | undefined
	if (envelope === undefined || typeof envelope !== "object")
		return fail(
			"cli-error",
			`exit ${proc.code}; stdout was not JSON. ${firstLine(proc.stderr) || firstLine(proc.stdout) || "(no output)"}`,
			proc.stdout || null,
			meta(emptyUsage(), null)
		)

	const usage: CoachUsage = {
		inputTokens: numOrNull(envelope.usage?.input_tokens),
		outputTokens: numOrNull(envelope.usage?.output_tokens),
		cacheReadTokens: numOrNull(envelope.usage?.cache_read_input_tokens),
		cacheCreationTokens: numOrNull(envelope.usage?.cache_creation_input_tokens),
		costUsd: numOrNull(envelope.total_cost_usd)
	}
	const sessionId = typeof envelope.session_id === "string" ? envelope.session_id : null
	turns = numOrNull(envelope.num_turns)

	if (envelope.is_error === true || proc.code !== 0) {
		const detail =
			typeof envelope.result === "string" ? envelope.result
			: envelope.subtype ? `subtype=${envelope.subtype}`
			: firstLine(proc.stderr)
		return fail(
			"cli-error",
			`claude exited ${proc.code}${envelope.api_error_status ? ` (api ${String(envelope.api_error_status)})` : ""}: ${detail || "unknown error"}`,
			typeof envelope.result === "string" ? envelope.result : null,
			meta(usage, sessionId)
		)
	}

	const text = typeof envelope.result === "string" ? envelope.result : ""

	// `--json-schema` gives us pre-validated, pre-parsed output. Prefer it always.
	if (envelope.structured_output !== undefined && envelope.structured_output !== null)
		return { ok: true, data: envelope.structured_output, text, meta: meta(usage, sessionId) }

	if (req.schema) warnings.push("schema was requested but no structured_output came back; parsing text")
	if (text.trim() === "")
		return fail("empty-output", "the model returned no text", null, meta(usage, sessionId))

	const data = extractJson(text)
	if (data === undefined)
		return fail("malformed-json", "no JSON object could be recovered from the response", text, meta(usage, sessionId))

	return { ok: true, data, text, meta: meta(usage, sessionId) }
}

/* ================================================================ api */

/**
 * Direct Messages API. Only reachable when `ANTHROPIC_API_KEY` is set, which it is not on
 * this machine — so this path is written but UNVERIFIED.
 *
 * Raw `fetch` rather than `@anthropic-ai/sdk` because that package is not a dependency of
 * this repo (it is only present as a transitive dep of the agent SDK and does not resolve
 * under pnpm's strict layout), and installing packages is out of scope for this unit.
 * If the API path ever becomes primary, add `@anthropic-ai/sdk` and swap this out.
 *
 * Note we do NOT send `output_config.format` here: schema-constrained output is verified on
 * the CLI path and unverified here, and a 400 from a guessed request shape would be worse
 * than falling back to the text extractor. The schema still reaches the model — `prompt.ts`
 * renders it into the user prompt.
 */
const callApi = async (req: CoachRequest & { model: string }): Promise<CoachResult> => {
	const started = Date.now()
	const warnings: string[] = []
	if (req.schema) warnings.push("api transport: schema enforced by prompt only, not by output_config")

	const meta = (usage: CoachUsage): CoachMeta => ({
		transport: "api",
		model: req.model,
		attempts: 1,
		sessionId: null,
		turns: null,
		durationMs: Date.now() - started,
		usage,
		warnings
	})

	const key = process.env.ANTHROPIC_API_KEY
	if (!key) return fail("no-transport", "ANTHROPIC_API_KEY is not set", null, meta(emptyUsage()))

	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS)
	const onAbort = () => controller.abort()
	req.signal?.addEventListener("abort", onAbort, { once: true })

	try {
		const res = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			signal: controller.signal,
			headers: {
				"content-type": "application/json",
				"x-api-key": key,
				"anthropic-version": ANTHROPIC_VERSION
			},
			body: JSON.stringify({
				model: req.model,
				max_tokens: 16_000,
				system: req.system,
				messages: [{ role: "user", content: req.user }]
			})
		})

		const bodyText = await res.text()
		const body = extractJson(bodyText) as
			| {
					content?: { type?: string; text?: string }[]
					stop_reason?: string
					error?: { message?: string; type?: string }
					usage?: {
						input_tokens?: number
						output_tokens?: number
						cache_read_input_tokens?: number
						cache_creation_input_tokens?: number
					}
			  }
			| undefined

		if (!res.ok)
			return fail(
				"api-error",
				`HTTP ${res.status}: ${body?.error?.message ?? firstLine(bodyText) ?? "unknown"}`,
				null,
				meta(emptyUsage())
			)

		const usage = usageFromApi(req.model, body?.usage)

		if (body?.stop_reason === "refusal")
			return fail("api-error", "the model declined this request (stop_reason: refusal)", null, meta(usage))

		const text = (body?.content ?? [])
			.filter(b => b?.type === "text" && typeof b.text === "string")
			.map(b => b.text as string)
			.join("")

		if (text.trim() === "") return fail("empty-output", "the model returned no text", null, meta(usage))

		const data = extractJson(text)
		if (data === undefined)
			return fail("malformed-json", "no JSON object could be recovered from the response", text, meta(usage))

		return { ok: true, data, text, meta: meta(usage) }
	} catch (e) {
		const aborted = e instanceof Error && e.name === "AbortError"
		return fail(
			aborted ? (req.signal?.aborted ? "aborted" : "timeout") : "api-error",
			e instanceof Error ? e.message : String(e),
			null,
			meta(emptyUsage())
		)
	} finally {
		clearTimeout(timer)
		req.signal?.removeEventListener("abort", onAbort)
	}
}

const usageFromApi = (
	model: string,
	u:
		| {
				input_tokens?: number
				output_tokens?: number
				cache_read_input_tokens?: number
				cache_creation_input_tokens?: number
		  }
		| undefined
): CoachUsage => {
	const inputTokens = numOrNull(u?.input_tokens)
	const outputTokens = numOrNull(u?.output_tokens)
	const cacheReadTokens = numOrNull(u?.cache_read_input_tokens)
	const cacheCreationTokens = numOrNull(u?.cache_creation_input_tokens)
	const price = PRICES[model]
	// No price on file => no cost. Never invent a number the user might act on.
	const costUsd =
		price && inputTokens !== null && outputTokens !== null ?
			((inputTokens + (cacheReadTokens ?? 0) * 0.1 + (cacheCreationTokens ?? 0) * 1.25) * price.in +
				outputTokens * price.out) /
			1_000_000
		:	null
	return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd }
}

/* =========================================================== plumbing */

type ProcOutcome =
	| { kind: "exit"; code: number; stdout: string; stderr: string }
	| { kind: "spawn-error"; message: string }
	| { kind: "timeout"; timeoutMs: number; stdout: string }
	| { kind: "aborted"; stdout: string }

/**
 * Spawn, write the prompt to stdin, collect stdout/stderr, honour a timeout and an
 * AbortSignal. The prompt goes on **stdin, never argv** — a digest is tens of kilobytes and
 * argv has both a length limit and a habit of showing up in `ps`.
 */
const runProcess = (
	bin: string,
	args: string[],
	stdin: string,
	timeoutMs: number,
	signal: AbortSignal | undefined
): Promise<ProcOutcome> =>
	new Promise(resolve => {
		let settled = false
		const done = (o: ProcOutcome) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener("abort", onAbort)
			resolve(o)
		}

		let child: ReturnType<typeof spawn>
		try {
			child = spawn(bin, args, {
				// A neutral cwd: nothing in this repo should influence a coaching call.
				cwd: tmpdir(),
				stdio: ["pipe", "pipe", "pipe"],
				env: process.env
			})
		} catch (e) {
			resolve({ kind: "spawn-error", message: e instanceof Error ? e.message : String(e) })
			return
		}

		let out = ""
		let err = ""
		child.stdout?.on("data", (d: Buffer) => {
			out += d.toString()
		})
		child.stderr?.on("data", (d: Buffer) => {
			err += d.toString()
		})

		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			done({ kind: "timeout", timeoutMs, stdout: out })
		}, timeoutMs)

		const onAbort = () => {
			child.kill("SIGKILL")
			done({ kind: "aborted", stdout: out })
		}
		signal?.addEventListener("abort", onAbort, { once: true })

		child.on("error", e => done({ kind: "spawn-error", message: e.message }))
		child.on("close", code => done({ kind: "exit", code: code ?? -1, stdout: out, stderr: err }))

		child.stdin?.on("error", () => {
			/* EPIPE when the child dies early; the close handler reports the real failure. */
		})
		child.stdin?.end(stdin)
	})

const fail = (
	code: CoachErrorCode,
	error: string,
	text: string | null,
	meta: CoachMeta
): CoachResult => ({ ok: false, code, error, text, meta })

const numOrNull = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null)

const firstLine = (s: string | undefined): string => (s ?? "").trim().split("\n")[0]?.slice(0, 400) ?? ""

/**
 * Cost/latency log. One JSON object per line at `data/logs/coach.jsonl`, so a week of
 * "why did my coaching bill look like that" is answerable without instrumenting anything.
 * Best effort: a broken log must never fail a review.
 */
const logRun = (label: string, r: CoachResult): void => {
	const line = {
		atMs: Date.now(),
		label,
		ok: r.ok,
		code: r.ok ? null : r.code,
		error: r.ok ? null : r.error.slice(0, 300),
		transport: r.meta.transport,
		model: r.meta.model,
		durationMs: r.meta.durationMs,
		attempts: r.meta.attempts,
		turns: r.meta.turns,
		inputTokens: r.meta.usage.inputTokens,
		outputTokens: r.meta.usage.outputTokens,
		costUsd: r.meta.usage.costUsd,
		warnings: r.meta.warnings
	}
	if (!logEnabled()) return
	console.log(
		`[coach] ${label} ${r.ok ? "ok" : `FAIL(${r.code})`} ${r.meta.model} via ${r.meta.transport} ` +
			`${r.meta.durationMs}ms attempts=${r.meta.attempts}${r.meta.turns === null ? "" : ` turns=${r.meta.turns}`} ` +
			`cost=${r.meta.usage.costUsd === null ? "?" : `$${r.meta.usage.costUsd.toFixed(4)}`}`
	)
	try {
		mkdirSync(LOGS_DIR, { recursive: true })
		appendFileSync(LOG_PATH, `${JSON.stringify(line)}\n`)
	} catch {
		/* logging is never load-bearing */
	}
}
