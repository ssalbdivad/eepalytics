/**
 * JobBadge — one queue row, small enough to sit in a header.
 *
 * The queue is the thing that explains why nothing is happening, so this badge tries hard to
 * answer "why did this not run yet":
 *   deferred → shows the gate reason the daemon parked in `lastError`
 *   queued with a future `notBeforeMs` → shows the backoff countdown
 *   failed → shows the error, and the attempt count that got there
 *   replay-download → shows time left against its 30-minute `deadlineMs`, because that one
 *                     genuinely expires and is never retried
 *
 * It does NOT render `job.intrusive`. That flag is vestigial — `replay-capture` was the only job
 * that ever set it and it is gone — but six rows in the database still carry a 1, and the badge
 * used to print "⚠ opens your game" over them. Nothing in this build can open the game, so that
 * was a warning about a thing that cannot happen.
 */

import type { Job, JobKind, JobState } from "../../shared/schema/domain.ts"
import { fmtCountdown } from "../../shared/time.ts"
import "./components.css"

export interface JobBadgeProps {
	job: Job
	/** Show the gameId inline. Default true. */
	showGame?: boolean
	nowMs?: number
}

const KIND_LABEL: Record<JobKind, string> = {
	"match-ingest": "Ingest",
	"replay-download": "Replay",
	"analysis-run": "Analysis",
	"review-game": "Coach",
	"review-trend": "Trends",
	"media-generate": "Media"
}

const STATE_LABEL: Record<JobState, string> = {
	queued: "queued",
	leased: "running",
	done: "done",
	failed: "failed",
	deferred: "waiting",
	expired: "expired"
}

export const JobBadge = ({ job, showGame = true, nowMs = Date.now() }: JobBadgeProps) => {
	const kind = KIND_LABEL[job.kind as JobKind] ?? job.kind
	const state = STATE_LABEL[job.state] ?? job.state

	const meta: string[] = []
	if (showGame && job.gameId !== null) meta.push(`#${job.gameId}`)

	if (job.state === "deferred" && job.lastError) meta.push(job.lastError)
	else if (job.state === "queued" && job.notBeforeMs > nowMs)
		meta.push(`retry in ${fmtCountdown(job.notBeforeMs, nowMs)}`.replace(" left", ""))
	else if (job.state === "failed" && job.lastError) meta.push(job.lastError)
	else if (job.state === "expired") meta.push(job.lastError ?? "window closed")
	else if (
		job.state === "queued" &&
		job.deadlineMs !== null &&
		Number.isFinite(job.deadlineMs)
	)
		meta.push(fmtCountdown(job.deadlineMs, nowMs))

	if (job.attempts > 1 && job.state !== "done")
		meta.push(`try ${job.attempts}/${job.maxAttempts}`)

	const metaText = meta.join(" · ")

	return (
		<span
			className={`csk-job csk-job--${job.state}`}
			title={
				job.lastError ?
					`${kind} job ${job.id} — ${state}: ${job.lastError}`
				:	`${kind} job ${job.id} — ${state}`
			}
		>
			<span className="csk-job__dot" />
			<span className="csk-job__kind">{kind}</span>
			<span>{state}</span>
			{metaText && (
				<span className="csk-job__meta" title={metaText}>
					{metaText.length > 46 ? `${metaText.slice(0, 45)}…` : metaText}
				</span>
			)}
		</span>
	)
}

export default JobBadge
