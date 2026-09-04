/**
 * What a job handler is handed. Defined in its own module so `jobs/*.ts` can import the type
 * without importing the registry that imports them.
 *
 * NODE ONLY.
 */

import type { Job } from "../shared/schema/domain.ts"
import type { Settings } from "../shared/schema/settings.ts"
import type { Logger } from "./log.ts"

export interface JobContext {
	job: Job
	/** Settings snapshot taken when the job was claimed. */
	settings: Settings
	log: Logger
	/** Aborted on SIGINT/SIGTERM. */
	signal: AbortSignal
	/** Push a human-readable progress line onto the SSE feed. Never throws. */
	progress: (note: string, extra?: Record<string, unknown>) => void
}

/**
 * A handler either succeeds (optionally with a note for `job.lastError`), or throws.
 * Returning `{ defer }` puts the job back to sleep WITHOUT consuming an attempt — that is how
 * "the League client is closed right now" differs from "this job is broken".
 */
export interface JobOutcome {
	note?: string
	defer?: { reason: string; untilMs?: number }
	/** Terminal, never retried — e.g. the 30-minute replay window closed. */
	expire?: { reason: string }
}

export type JobHandler = (ctx: JobContext) => Promise<JobOutcome | void>
