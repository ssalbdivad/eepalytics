/**
 * The `replay-capture` job handler — the only INTRUSIVE job in the system.
 *
 * It takes over the user's League client to render screenshots and clips of the moments the
 * analysis picked out. Because of that it is the most cautious handler in the app:
 *
 *  - it asks the gate first and **defers** rather than fails when the answer is no, so a
 *    game queued at 2 a.m. is still capturable tomorrow;
 *  - it never throws for a capture that merely went badly. `media-generate` has already put
 *    an SVG map image on every moment, so a failed screenshot degrades the review instead of
 *    breaking it. The reason lands on the job row (`completeJob`'s note becomes `lastError`)
 *    so the UI can say *why* there are no screenshots;
 *  - it owns its own job-state transitions (defer / complete / fail) precisely because
 *    "deferred" is a decision only this handler can make. `ReplayCaptureResult.jobState`
 *    tells the worker what was already done so it does not double-write.
 */

import {
	appendEvent,
	completeJob,
	deferJob,
	failJob,
	getGame,
	getMoments,
	getSettings,
	getUserParticipant,
	insertMedia,
	kvGet,
	setGameReplayState
} from "../../db/queries.ts"
import { CALIBRATION_KV_KEY, DEFAULT_CAMERA_CALIBRATION } from "../../capture/camera.ts"
import type { CameraCalibration } from "../../capture/camera.ts"
import { captureMoments, type CaptureProgress } from "../../capture/pipeline.ts"
import { preflight } from "../../capture/launcher.ts"
import { curlClients } from "../../capture/transport.ts"
import { CaptureError, type CaptureClients } from "../../capture/types.ts"
import type { Job } from "../../shared/schema/domain.ts"
import { PLATFORM_ID } from "../../shared/constants.ts"

/** How long to wait before re-trying a job the gate refused. */
export const GATE_DEFER_MS = 5 * 60 * 1000
/** Longer, when the refusal is a setting rather than a transient state. */
export const DISABLED_DEFER_MS = 60 * 60 * 1000

/**
 * The daemon's `gate.ts` owns rules G1-G9. This is the smallest shape this handler needs
 * from it; the integration pass should pass the real one in. When it is absent we fall back
 * to `preflight()`, which re-reads the same client state directly.
 */
export interface IntrusiveGate {
	allowIntrusive(gameId: number): Promise<{ allowed: boolean; reason: string }>
}

export interface CaptureJobContext {
	clients?: CaptureClients
	gate?: IntrusiveGate
	/** Aborts when the user queues up (daemon abort rules A1-A5). */
	signal?: AbortSignal
	/** Progress relay for the SSE `capture` channel. Defaults to writing an app_event. */
	onProgress?: (p: CaptureProgress) => void
}

export type CaptureJobState = "done" | "deferred" | "failed"

export interface ReplayCaptureResult {
	/** What this handler already wrote to the job row. The worker must not re-write it. */
	jobState: CaptureJobState
	note: string
	mediaIds: string[]
	failures: number
}

const loadCalibration = (): CameraCalibration => {
	const stored = kvGet<Partial<CameraCalibration>>(CALIBRATION_KV_KEY, {})
	return { ...DEFAULT_CAMERA_CALIBRATION, ...stored }
}

/**
 * Run one capture job.
 *
 * `job.gameId` must be set; a capture job without a game is a programming error and fails
 * terminally rather than looping.
 */
export const runReplayCapture = async (
	job: Job,
	ctx: CaptureJobContext = {}
): Promise<ReplayCaptureResult> => {
	const gameId = job.gameId
	if (gameId === null) {
		failJob(job.id, "replay-capture job has no gameId")
		return {
			jobState: "failed",
			note: "no gameId",
			mediaIds: [],
			failures: 0
		}
	}

	const settings = getSettings()
	const clients = ctx.clients ?? curlClients()

	const emit = (p: CaptureProgress) => {
		if (ctx.onProgress) ctx.onProgress(p)
		else
			appendEvent(
				"capture",
				{ gameId, phase: p.phase, note: p.note, done: p.done, total: p.total },
				gameId
			)
	}

	/* ---------------------------------------------------------- gate first */

	if (!settings.captureEnabled) {
		const note =
			"replay capture is off — turn it on in Settings if you want real screenshots"
		deferJob(job.id, note, Date.now() + DISABLED_DEFER_MS)
		appendEvent("capture", { gameId, phase: "gated", note }, gameId)
		return { jobState: "deferred", note, mediaIds: [], failures: 0 }
	}

	if (ctx.gate) {
		const verdict = await ctx.gate.allowIntrusive(gameId).catch(e => ({
			allowed: false,
			reason: `gate error: ${e instanceof Error ? e.message : String(e)}`
		}))
		if (!verdict.allowed) {
			deferJob(job.id, verdict.reason, Date.now() + GATE_DEFER_MS)
			appendEvent("capture", { gameId, phase: "gated", note: verdict.reason }, gameId)
			return { jobState: "deferred", note: verdict.reason, mediaIds: [], failures: 0 }
		}
	}

	// Belt and braces even when the gate said yes: the client's state can change between the
	// gate reading it and us acting on it, and this is the check that also proves the .rofl
	// is on disk and on the right patch.
	const verdict = await preflight(gameId, clients, { signal: ctx.signal }).catch(e => ({
		ok: false as const,
		reason: "gated" as const,
		note: e instanceof Error ? e.message : String(e)
	}))
	if (!verdict.ok) {
		const reason = verdict.reason ?? "gated"
		if (reason === "patch-mismatch" || reason === "rofl-missing") {
			// Neither is retryable. Record the truth on the game so the UI stops promising
			// screenshots for it, and close the job out cleanly.
			setGameReplayState(gameId, reason === "rofl-missing" ? "expired" : "pruned")
			completeJob(job.id, verdict.note)
			appendEvent("capture", { gameId, phase: "unavailable", note: verdict.note }, gameId)
			return { jobState: "done", note: verdict.note, mediaIds: [], failures: 0 }
		}
		deferJob(job.id, verdict.note, Date.now() + GATE_DEFER_MS)
		appendEvent("capture", { gameId, phase: "gated", note: verdict.note }, gameId)
		return { jobState: "deferred", note: verdict.note, mediaIds: [], failures: 0 }
	}

	/* ------------------------------------------------------------- capture */

	const moments = getMoments(gameId)
	if (moments.length === 0) {
		const note = "no moments to capture yet — run analysis first"
		completeJob(job.id, note)
		return { jobState: "done", note, mediaIds: [], failures: 0 }
	}

	const user = getUserParticipant(gameId)
	const game = getGame(gameId)
	const cal = loadCalibration()

	try {
		const outcome = await captureMoments(gameId, moments, {
			clients,
			signal: ctx.signal,
			maxMoments: settings.captureMaxPerGame,
			clipSeconds: settings.clipSeconds,
			cal,
			platformId: game?.platformId ?? PLATFORM_ID,
			skipPreflight: true,
			onProgress: emit,
			// Lock onto the user's champion whenever they are in the moment; otherwise the
			// moment is about a place (an objective they were not at) and absolute camera
			// coordinates are the honest choice.
			championFor: moment =>
				user && moment.participantsInvolved.includes(user.participantId) ?
					user.championName
				:	null
		})

		const mediaIds: string[] = []
		for (const m of outcome.media) {
			try {
				insertMedia(m)
				mediaIds.push(m.id)
			} catch {
				// A duplicate id means this moment was already captured in an earlier run;
				// the file on disk is the same deterministic path, so this is benign.
				mediaIds.push(m.id)
			}
		}

		const note = outcome.aborted ? `${outcome.note} (stopped for your game)` : outcome.note

		if (outcome.aborted && outcome.captured < outcome.attempted) {
			// Not a failure — the user did nothing wrong and neither did we. Come back later.
			deferJob(job.id, note, Date.now() + GATE_DEFER_MS)
			appendEvent(
				"capture",
				{ gameId, phase: "aborted", note, mediaIds },
				gameId
			)
			return {
				jobState: "deferred",
				note,
				mediaIds,
				failures: outcome.failures.length
			}
		}

		completeJob(job.id, note)
		appendEvent(
			"capture",
			{
				gameId,
				phase: "done",
				note,
				mediaIds,
				captured: outcome.captured,
				attempted: outcome.attempted,
				launchMs: outcome.launchMs,
				failures: outcome.failures
			},
			gameId
		)
		return { jobState: "done", note, mediaIds, failures: outcome.failures.length }
	} catch (e) {
		const reason = e instanceof CaptureError ? e.reason : "error"
		const message = e instanceof Error ? e.message : String(e)
		const note = `capture unavailable (${reason}): ${message}`

		if (reason === "patch-mismatch" || reason === "rofl-missing") {
			setGameReplayState(gameId, reason === "rofl-missing" ? "expired" : "pruned")
			completeJob(job.id, note)
			appendEvent("capture", { gameId, phase: "unavailable", note }, gameId)
			return { jobState: "done", note, mediaIds: [], failures: 0 }
		}
		if (reason === "aborted" || reason === "gated") {
			deferJob(job.id, note, Date.now() + GATE_DEFER_MS)
			appendEvent("capture", { gameId, phase: "gated", note }, gameId)
			return { jobState: "deferred", note, mediaIds: [], failures: 0 }
		}

		// launch-timeout / api-timeout: worth one retry, then it becomes terminal on its own.
		failJob(job.id, note)
		appendEvent("error", { gameId, kind: "replay-capture", note }, gameId)
		return { jobState: "failed", note, mediaIds: [], failures: 1 }
	}
}

/** Registry entry for `src/daemon/jobs/index.ts`. */
export const replayCaptureHandler = {
	kind: "replay-capture" as const,
	intrusive: true,
	/** This handler writes the job row itself; see `ReplayCaptureResult.jobState`. */
	managesJobState: true,
	run: runReplayCapture
}

export default replayCaptureHandler
