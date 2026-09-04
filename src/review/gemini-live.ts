/**
 * Gemini Live: minting the short-lived credential the browser connects with.
 *
 * ## Why this exists at all
 *
 * The Claude glance path spawns a CLI process per look, which costs about a second before a
 * single pixel is sent, and it cannot hold a conversation because every call starts from nothing.
 * Measured against the same frame:
 *
 *     claude CLI glance          3.1s   new process every time, browser TTS
 *     gemini live (ephemeral)    0.8s   persistent socket, native audio out
 *
 * A coach talking about a fight three seconds after it ended is a coach describing history. This
 * is the path where that stops being true.
 *
 * ## Why the key does not go to the browser
 *
 * Google's own client-to-server pattern, and the only responsible one: the daemon holds the API
 * key, mints a token that is good for one session, and hands *that* to the page. The key never
 * reaches the renderer, never lands in a devtools network tab, and a leaked token expires in
 * minutes rather than granting an attacker the account.
 *
 * ## Why there is no "sign in with Google" button
 *
 * Asked for, and it cannot be built. The Live API authenticates with an AI Studio API key; a
 * consumer Gemini subscription does not grant API access, and there is no OAuth flow that turns
 * a Google login into a Live API credential. A sign-in button here would be a button that
 * cannot work, so the UI asks for a key and says where to get one.
 *
 * NODE ONLY — holds the key and talks to Google.
 */

import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DATA_DIR } from "../shared/constants.ts"
import { errText, makeLogger } from "../daemon/log.ts"

const log = makeLogger("gemini-live")

/**
 * The only model here that both speaks and sees.
 *
 * Enumerated live: seven models advertise `bidiGenerateContent`, and the rest are audio-only
 * transcribe/translate variants. This one refuses `responseModalities: ["TEXT"]` outright — it
 * is native-audio-out, which is why the browser gets a voice instead of speech synthesis, and
 * why `outputAudioTranscription` is switched on to get the words as well as the sound.
 */
export const GEMINI_LIVE_MODEL = "models/gemini-3.1-flash-live-preview"

const MINT_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens"

/**
 * The WebSocket the *browser* opens. Note `Constrained`: it is the endpoint that accepts an
 * ephemeral token. The unconstrained one rejects tokens with "Method doesn't allow unregistered
 * callers" and wants a raw API key, which is exactly what must not be in the page.
 */
export const GEMINI_LIVE_WS =
	"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained"

export interface GeminiToken {
	/** Opaque `auth_tokens/…` name, passed as `?access_token=`. */
	token: string
	model: string
	wsUrl: string
}

/**
 * Where the key lives — its own 0600 file, deliberately NOT the settings table.
 *
 * Settings round-trip through `GET /api/settings`, which the UI reads on every visit. A key in
 * there would be handed to the renderer, sit in a devtools network tab, and appear in any screen
 * recording of the app — while the code claimed the browser never sees it. Keeping it in a file
 * that only the daemon reads makes that claim true rather than aspirational.
 */
const KEY_PATH = `${DATA_DIR}/gemini.key`

/** File first so the UI can change it without a restart; env as the headless fallback. */
export const geminiKey = (): string => {
	try {
		const fromFile = readFileSync(KEY_PATH, "utf8").trim()
		if (fromFile !== "") return fromFile
	} catch {
		/* not set yet — fall through to the environment */
	}
	return (process.env.GEMINI_API_KEY ?? "").trim()
}

/** Write or clear the key. An empty string removes the file rather than storing a blank one. */
export const setGeminiKey = (key: string): void => {
	const trimmed = key.trim()
	if (trimmed === "") {
		rmSync(KEY_PATH, { force: true })
		log.info("gemini key cleared")
		return
	}
	mkdirSync(dirname(KEY_PATH), { recursive: true })
	writeFileSync(KEY_PATH, `${trimmed}\n`, { mode: 0o600 })
	// Re-assert the mode: an existing file keeps its old permissions through a write.
	chmodSync(KEY_PATH, 0o600)
	log.info("gemini key stored")
}

/**
 * Mint one ephemeral token. Never throws — the live coach is optional and must not take the
 * overlay down with it.
 *
 * The request body is `{uses: 1}` and nothing else. `liveConnectConstraints`, which the docs
 * describe for pinning a token to one model, is rejected by this API version as an unknown
 * field — so the constraint is not sent rather than sent hopefully. Default validity is about a
 * minute to open the session and thirty to hold it, which is the right shape: long enough for a
 * game, short enough that a leaked token is worth little.
 */
export const mintGeminiToken = async (
	signal?: AbortSignal
): Promise<{ ok: true; value: GeminiToken } | { ok: false; error: string }> => {
	const key = geminiKey()
	if (key === "")
		return { ok: false, error: "no Gemini API key — add one in Settings to use the live coach" }

	try {
		const res = await fetch(MINT_URL, {
			method: "POST",
			headers: { "x-goog-api-key": key, "content-type": "application/json" },
			body: JSON.stringify({ uses: 1 }),
			signal
		})
		const body = (await res.json().catch(() => null)) as
			| { name?: string; error?: { message?: string } }
			| null

		if (!res.ok || !body?.name) {
			const detail = body?.error?.message ?? `HTTP ${res.status}`
			log.warn(`mint failed: ${detail}`)
			// The key itself is never echoed back, including into an error the UI will render.
			return { ok: false, error: `Gemini rejected the key: ${detail}` }
		}

		log.info("minted an ephemeral live token")
		return { ok: true, value: { token: body.name, model: GEMINI_LIVE_MODEL, wsUrl: GEMINI_LIVE_WS } }
	} catch (err) {
		return { ok: false, error: errText(err) }
	}
}

/**
 * Does the key work at all?
 *
 * Used by the settings UI to say "connected" or the actual reason, rather than leaving someone
 * to discover a bad key mid-game. Listing models is the cheapest authenticated call there is.
 */
export const checkGeminiKey = async (
	key: string
): Promise<{ ok: true; models: number } | { ok: false; error: string }> => {
	const trimmed = key.trim()
	if (trimmed === "") return { ok: false, error: "no key" }
	try {
		const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
			headers: { "x-goog-api-key": trimmed }
		})
		const body = (await res.json().catch(() => null)) as
			| { models?: unknown[]; error?: { message?: string } }
			| null
		if (!res.ok) return { ok: false, error: body?.error?.message ?? `HTTP ${res.status}` }
		return { ok: true, models: body?.models?.length ?? 0 }
	} catch (err) {
		return { ok: false, error: errText(err) }
	}
}

/* ------------------------------------------------------------- transcript */

/**
 * What the live coach actually said, one JSON object per line.
 *
 * A flat file rather than a table on purpose: this exists to be read by a person and by the next
 * round of prompt work, both of which want `grep` and neither of which wants a migration. It is
 * also the only record that exists — the Gemini socket runs in the browser, so nothing else in
 * the daemon ever sees a word of it.
 */
const TRANSCRIPT_PATH = `${DATA_DIR}/logs/live-transcript.jsonl`

export interface TranscriptLine {
	atMs: number
	text: string
	fromUser: boolean
	gameTimeSec: number | null
	/**
	 * The ground-truth block the coach was holding when it said this.
	 *
	 * Kept because a line on its own cannot be judged. "Graves is down 22s" is either excellent
	 * or invented, and the only thing that separates those is what she was told — so the question
	 * is stored next to the answer.
	 */
	groundTruth?: string
}

/**
 * How many lines a read returns when it is not told, and the most it will ever return.
 *
 * Both are named because a bad `limit` used to be indistinguishable from an empty transcript:
 * `?limit=` parses to 0, `out.length < 0` is false on the first pass, and the endpoint answered
 * `{lines: []}` — which the panel renders as "nothing recorded yet" over a file with a game in
 * it. A limit that cannot be read is a limit that was not given.
 */
export const TRANSCRIPT_DEFAULT_LIMIT = 200
const TRANSCRIPT_MAX_LIMIT = 5000

/** Clamp a `?limit=` — anything unreadable falls back to the default rather than to zero. */
export const transcriptLimit = (raw: string | undefined | null): number => {
	if (raw === undefined || raw === null || raw.trim() === "") return TRANSCRIPT_DEFAULT_LIMIT
	const n = Number(raw)
	if (!Number.isFinite(n) || n < 1) return TRANSCRIPT_DEFAULT_LIMIT
	return Math.min(Math.floor(n), TRANSCRIPT_MAX_LIMIT)
}

/**
 * Whether the line reached the disk.
 *
 * Reported rather than swallowed. The route used to answer `{ok: true}` unconditionally, so a
 * full disk or a bad permission looked exactly like a successful write to the only code that
 * could have complained about it — the browser, which is where the only copy of the line was.
 */
export const appendTranscript = (line: TranscriptLine): boolean => {
	try {
		mkdirSync(dirname(TRANSCRIPT_PATH), { recursive: true })
		appendFileSync(TRANSCRIPT_PATH, `${JSON.stringify(line)}\n`)
		return true
	} catch (err) {
		// Losing a transcript line must never interrupt a game — but it must not be silent either.
		log.warn(`transcript append failed: ${errText(err)}`)
		return false
	}
}

/**
 * Parse a transcript file's contents, newest first.
 *
 * Split out from the file read so it can be tested without a disk, a socket or a daemon: the
 * ordering, the limit and a torn last line are the whole of the logic, and all three are pure.
 */
export const parseTranscript = (
	text: string,
	limit: number = TRANSCRIPT_DEFAULT_LIMIT
): TranscriptLine[] => {
	const capped = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : TRANSCRIPT_DEFAULT_LIMIT
	// Whitespace is trimmed PER LINE, never off the whole file: a groundTruth block is full of
	// newlines, but `JSON.stringify` escaped every one of them, so the only real \n is a separator.
	const lines = text.split("\n")
	const out: TranscriptLine[] = []
	for (let i = lines.length - 1; i >= 0 && out.length < capped; i--) {
		const raw = lines[i]!.trim()
		if (raw === "") continue
		try {
			const parsed = JSON.parse(raw) as TranscriptLine
			// A line that parses but is not a record would render as an empty row.
			if (typeof parsed?.text !== "string") continue
			out.push(parsed)
		} catch {
			/* a torn final line during a crash is not worth failing the read for */
		}
	}
	return out
}

/** Newest first. Reads the whole file: it is a few hundred KB after months of play. */
export const readTranscript = (limit: number = TRANSCRIPT_DEFAULT_LIMIT): TranscriptLine[] => {
	try {
		return parseTranscript(readFileSync(TRANSCRIPT_PATH, "utf8"), limit)
	} catch {
		// The file not existing yet is the normal state before the first line, not a fault.
		return []
	}
}
