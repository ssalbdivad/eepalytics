/**
 * The one genuinely soft dependency left.
 *
 * `src/analysis/`, `src/review/` and `src/server/` are now imported statically — they exist,
 * they are typechecked, and pretending otherwise would only hide breakage. The capture unit's
 * `jobs/replay-capture.ts` is different: it is the intrusive, hardware-dependent, explicitly
 * unproven part of the product, and the daemon must boot, ingest, analyse, review and draw
 * maps whether or not it is present. So it is resolved lazily, and a capture job DEFERS with
 * the reason on the queue screen while the module is missing.
 *
 * The specifier is a non-literal string on purpose: a module that does not exist yet must not
 * be a compile error.
 *
 * THE CONTRACT — export one of these from `src/daemon/jobs/replay-capture.ts` and the daemon
 * picks it up with no integration work:
 *
 *   runReplayCapture(job: Job, ctx): Promise<ReplayCaptureResult | void>
 *   (aliases probed, in order: runReplayCapture, replayCapture, capture, then a `default`
 *   export's `.run`)
 *
 * `ctx.signal` fires the moment `gate.ts` sees the user come back (A1-A5); honour it, leave
 * the client somewhere sane, and return rather than throw.
 *
 * NODE ONLY.
 */

import type { Job } from "../shared/schema/domain.ts"
import { errText, makeLogger } from "./log.ts"

const log = makeLogger("deps")

type Mod = Record<string, unknown>

const cache = new Map<string, Mod | null>()

const load = async (specifier: string): Promise<Mod | null> => {
	if (cache.has(specifier)) return cache.get(specifier) ?? null
	let mod: Mod | null = null
	try {
		mod = (await import(specifier)) as Mod
	} catch (err) {
		const message = errText(err)
		// ERR_MODULE_NOT_FOUND is the expected "not built yet" case. Anything else is a real
		// bug in the sibling and deserves a loud line in the journal.
		if (message.includes("Cannot find module") || message.includes("ERR_MODULE_NOT_FOUND"))
			log.info(`sibling module not present yet: ${specifier}`)
		else log.error(`sibling module failed to load: ${specifier}`, { err: message })
		mod = null
	}
	cache.set(specifier, mod)
	return mod
}

/** Forget a failed load, so a unit that lands while the daemon runs gets picked up. */
export const forgetDeps = (): void => cache.clear()

/**
 * The capture unit's handler. It takes the raw `Job` and writes its own job row (see
 * `ReplayCaptureResult.jobState`), which is why the return type carries a state rather than
 * a `JobOutcome`.
 */
export interface CaptureResult {
	jobState: "done" | "deferred" | "failed"
	note: string
	mediaIds: string[]
	failures: number
}

export interface CaptureCallContext {
	signal?: AbortSignal
	gate?: { allowIntrusive: (gameId: number) => Promise<{ allowed: boolean; reason: string }> }
	onProgress?: (p: Record<string, unknown>) => void
}

export type CaptureFn = (
	job: Job,
	ctx: CaptureCallContext
) => Promise<CaptureResult | void>

export const loadCapture = async (): Promise<CaptureFn | null> => {
	const mod = await load("./jobs/replay-capture.ts")
	if (!mod) return null
	for (const name of ["runReplayCapture", "replayCapture", "capture"]) {
		const value = mod[name]
		if (typeof value === "function") return value as CaptureFn
	}
	// A registry-object default export (`{ kind, intrusive, run }`).
	const fallback = mod.default as { run?: unknown } | undefined
	if (fallback && typeof fallback.run === "function") return fallback.run as CaptureFn
	log.warn(
		"jobs/replay-capture.ts exists but exports none of runReplayCapture/replayCapture/capture/default"
	)
	return null
}
