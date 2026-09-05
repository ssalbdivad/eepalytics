/**
 * One reading of the minimap, made by the DAEMON from a crop the browser sends.
 *
 * ## Why the daemon makes this call, when the route next door says the browser should
 *
 * `POST /api/live/frame-read` was written to accept a read the browser had already made, on the
 * reasoning that the picture is in the browser and a second upload per turn is latency this
 * feature exists to avoid. The reasoning is sound and the credential does not exist: the ephemeral
 * token the page holds is `uses: 1` and is accepted only by the **Constrained** WebSocket endpoint
 * — `generateContent` refuses it — and a raw key in the page is the one thing this app will not do.
 * So the browser cannot make this call at all, and the seam sat built and unreachable.
 *
 * The latency argument also does not survive its own number. Measured on a real journal frame:
 *
 *     whole frame, 1536x864      152,742 bytes
 *     minimap crop, 288x288       17,122 bytes
 *
 * Seventeen kilobytes to `127.0.0.1`, from a page that already uploads the whole 153 KB frame to
 * this same daemon every five seconds for the journal. The upload is not the cost; the model call
 * is, and that happens off the coach's thread either way.
 *
 * ## Why a crop, and not the frame the coach already gets
 *
 * Measured over 20 frames from five real games, three reads each, against hand labels:
 *
 *                                  whole frame     minimap crop, 4x
 *     median position error          43%                3%
 *     agrees with itself             5 of 60           48%
 *     his own HALF of the map        44%               94%
 *     image tokens                  1,100             1,089
 *
 * A 43% median error is a randomly chosen point — on the whole frame the model is confabulating a
 * League game, the same thing it does with no image attached at all. And the crop is FREE: a small
 * image is padded to the same tile budget, so there is no accuracy-against-cost trade to weigh.
 * Upscaling is done by the caller because the model reads a bigger picture of the same pixels
 * better, and it costs nothing either.
 *
 * ## What comes back is never believed on its own
 *
 * The answer is a constrained schema, so the model chooses from an enumeration and cannot invent a
 * champion. It is then fenced by `frameReadFaults` against the client's own truth, and a read that
 * trips any of it is thrown away WHOLE rather than repaired. The fast model was measured at 63% for
 * an enemy's zone, which is not good enough to say out loud, so nothing here becomes a claim about
 * where an enemy is — `buildFacts` uses only the coarse half of the map he is on, as a gate.
 */

import { geminiKey } from "./gemini-live.ts"
import {
	FRAME_READ_QUESTION_XY,
	FRAME_READ_SYSTEM,
	asFrameRead,
	frameReadFaults,
	frameReadSchemaXY,
	parseFrameReadXY
} from "./frame-read.ts"
import type { FrameRead, FrameTruth } from "./frame-read.ts"

/**
 * The fast model, and the reason it is the fast one.
 *
 * Measured on the same frames: `gemini-3.6-flash` localises better (own zone 92%, median error 2%)
 * and counts WORSE (exact count 33% against 44%), at **12.3 seconds a read against 1.1**. A
 * pre-pass that takes twelve seconds is not a pre-pass, it is the turn it was supposed to precede.
 */
export const MINIMAP_MODEL = "gemini-3.1-flash-lite"

/** Long enough for a slow read, short enough that it cannot outlive the turn it belongs to. */
export const MINIMAP_TIMEOUT_MS = 6000

export type MinimapOutcome =
	| { read: FrameRead; faults: null; ms: number }
	| { read: null; faults: string[] | null; reason: string; ms: number }

/**
 * Read one minimap crop.
 *
 * NEVER throws and never rejects: a failed read must cost the coach a clause, never a line. Every
 * outcome carries a reason so the caller can report it rather than fall quiet — the thing he asked
 * for explicitly after a whole session of silent suppression.
 */
export const readMinimap = async (input: {
	jpegBase64: string
	truth: FrameTruth
	model?: string
	timeoutMs?: number
	signal?: AbortSignal
}): Promise<MinimapOutcome> => {
	const started = Date.now()
	const ms = (): number => Date.now() - started

	let key = ""
	try {
		key = geminiKey()
	} catch {
		return { read: null, faults: null, reason: "no-key", ms: ms() }
	}
	if (key === "") return { read: null, faults: null, reason: "no-key", ms: ms() }

	const ctl = new AbortController()
	const timer = setTimeout(() => ctl.abort(), input.timeoutMs ?? MINIMAP_TIMEOUT_MS)
	if (input.signal) input.signal.addEventListener("abort", () => ctl.abort(), { once: true })

	try {
		const body = {
			systemInstruction: { parts: [{ text: FRAME_READ_SYSTEM }] },
			contents: [
				{
					role: "user",
					parts: [
						{ inlineData: { mimeType: "image/jpeg", data: input.jpegBase64 } },
						{ text: FRAME_READ_QUESTION_XY }
					]
				}
			],
			generationConfig: {
				responseMimeType: "application/json",
				responseSchema: frameReadSchemaXY({
					enemyChampions: input.truth.enemyChampions,
					myChampion: input.truth.myChampion
				})
			}
		}
		const res = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${input.model ?? MINIMAP_MODEL}:generateContent?key=${key}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: ctl.signal
			}
		)
		if (!res.ok) return { read: null, faults: null, reason: `http-${res.status}`, ms: ms() }

		const j = (await res.json()) as {
			candidates?: { content?: { parts?: { text?: string }[] } }[]
		}
		const text = j.candidates?.[0]?.content?.parts?.[0]?.text
		if (text === undefined || text === "")
			return { read: null, faults: null, reason: "empty", ms: ms() }

		let raw: unknown
		try {
			raw = JSON.parse(text)
		} catch {
			return { read: null, faults: null, reason: "not-json", ms: ms() }
		}

		const parsed = parseFrameReadXY(raw, {
			myChampion: input.truth.myChampion,
			enemyChampions: input.truth.enemyChampions
		})
		if (!parsed.read)
			return { read: null, faults: null, reason: parsed.rejected ?? "schema", ms: ms() }

		const read = asFrameRead(parsed.read)
		/*
		 * The fence, and it is absolute. More icons than there are living players, his own icon on
		 * the map while the client says he is on the respawn screen, his champion read as somebody
		 * else — all five are facts the client settles for free without anyone having looked at the
		 * picture. A read that contradicts them is not a hard read, it is a wrong one, and it is
		 * dropped WHOLE rather than repaired.
		 */
		const faults = frameReadFaults(read, input.truth)
		if (faults.length > 0) return { read: null, faults, reason: "fenced", ms: ms() }

		return { read, faults: null, ms: ms() }
	} catch (err) {
		const aborted = err instanceof Error && err.name === "AbortError"
		return { read: null, faults: null, reason: aborted ? "timeout" : "error", ms: ms() }
	} finally {
		clearTimeout(timer)
	}
}
