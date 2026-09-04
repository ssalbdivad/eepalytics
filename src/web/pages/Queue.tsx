/**
 * The queue exists to make deferral legible.
 *
 * Almost everything this app does happens in the background, and the single most common
 * question is "why is nothing happening". The answer is always a reason recorded on a job, so
 * this screen prints those reasons verbatim rather than paraphrasing them into a spinner.
 */

import { useMemo, useState } from "react"
import type { Game, Job, JobState } from "../../shared/schema/domain.ts"
import { isTerminal } from "../../shared/schema/domain.ts"
import { api } from "../lib/api.ts"
import { href, useAction, useNow, useResource } from "../lib/hooks.ts"
import {
	cls,
	fmtAgo,
	fmtCountdown,
	fmtDuration,
	jobKindLabel,
	jobReason,
	JOB_STATE_LABEL
} from "../lib/format.ts"
import { JobBadge } from "../components/JobBadge.tsx"

const GROUPS: { state: JobState[]; title: string; blurb: string }[] = [
	{ state: ["leased"], title: "Running now", blurb: "" },
	{ state: ["deferred"], title: "Waiting", blurb: "these can't start yet — the reason is on each row" },
	{ state: ["queued"], title: "Up next", blurb: "" },
	{ state: ["done", "failed", "expired"], title: "Finished", blurb: "" }
]

export interface QueueProps {
	eventTick: number
}

export const Queue = ({ eventTick }: QueueProps) => {
	const jobs = useResource(signal => api.jobs(signal), [eventTick])
	const games = useResource(signal => api.games(200, signal), [eventTick])
	const now = useNow(1000)
	const [showDone, setShowDone] = useState(false)

	const sync = useAction(() => api.sync())

	const gameById = useMemo(() => {
		const map = new Map<number, Game>()
		for (const g of games.data?.games ?? []) map.set(g.gameId, g)
		return map
	}, [games.data])

	const all = jobs.data?.jobs ?? []
	const active = all.filter(j => !isTerminal(j.state))

	return (
		<div className="page">
			<div className="page-head">
				<h1>Queue</h1>
				<div className="sub">
					{active.length} active · {all.length} tracked
					{jobs.refreshing ? " · refreshing…" : ""}
				</div>
				<div className="spacer" />
				<label className="dim" style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center" }}>
					<input
						type="checkbox"
						checked={showDone}
						onChange={e => setShowDone(e.target.checked)}
					/>
					show completed
				</label>
				<button onClick={sync.run} disabled={sync.pending}>
					{sync.pending ? "Syncing…" : "Sync from client"}
				</button>
				<button onClick={jobs.reload}>Refresh</button>
			</div>

			{jobs.error ?
				<div className="notice bad" style={{ marginBottom: 12 }}>
					<span className="icon">✗</span>
					<div>
						<strong>Can't read the queue.</strong> {jobs.error}
					</div>
				</div>
			:	null}

			{sync.error ?
				<div className="notice bad" style={{ marginBottom: 12 }}>
					<span className="icon">✗</span>
					<div>{sync.error}</div>
				</div>
			:	null}

			{all.length === 0 && !jobs.loading ?
				<div className="empty">
					<h2>Queue is empty</h2>
					<p>
						Nothing is pending. New games queue their own ingest, download, analysis and review
						jobs the moment they end.
					</p>
					<div className="actions">
						<a className="btn" href={href.games}>
							Back to games
						</a>
					</div>
				</div>
			:	GROUPS.map(group => {
					const rows = all
						.filter(j => group.state.includes(j.state))
						.filter(j => showDone || j.state !== "done")
						.sort((a, b) => b.updatedMs - a.updatedMs)
					if (rows.length === 0) return null
					return (
						<div className="job-group" key={group.title}>
							<div className="section-title">
								{group.title} <span className="chip muted">{rows.length}</span>
								<span className="rule" />
								<span className="faint" style={{ textTransform: "none", letterSpacing: 0 }}>
									{group.blurb}
								</span>
							</div>
							<div className="job-rows">
								{rows.map(j => (
									<JobRow key={j.id} job={j} game={j.gameId === null ? null : gameById.get(j.gameId) ?? null} now={now} />
								))}
							</div>
						</div>
					)
				})
			}
		</div>
	)
}

const JobRow = ({ job, game, now }: { job: Job; game: Game | null; now: number }) => {
	const cancel = useAction(() => api.cancelJob(job.id))
	const retry = useAction(() => api.retryJob(job.id))
	const reason = jobReason(job)
	const canCancel = !isTerminal(job.state)
	const canRetry = job.state === "failed"

	const subject =
		game ?
			`${game.championName} · ${fmtAgo(game.gameCreationMs, now)}`
		: job.gameId !== null ? `game ${job.gameId}`
		: "all games"

	return (
		<div className={cls("job-row", isTerminal(job.state) && "terminal")}>
			<JobBadge job={job} />

			<div className="what">
				<div className="kind">
					{jobKindLabel(job.kind)}{" "}
					<span className="dim" style={{ fontWeight: 500 }}>
						{subject}
					</span>
					{job.intrusive ?
						// Only rows left behind by the retired replay-capture kind carry this. It is
						// shown rather than hidden because the row is history: this app really did
						// once queue jobs that would have opened the game client.
						<span
							className="chip warn"
							style={{ marginLeft: 8 }}
							title="Left over from replay capture, which was removed. Nothing this app queues today can open your game."
						>
							retired
						</span>
					:	null}
				</div>
				<div className={cls("sub", job.state === "deferred" && "reason")}>
					{JOB_STATE_LABEL[job.state]}
					{job.attempts > 0 ? ` · attempt ${job.attempts}/${job.maxAttempts}` : ""}
					{reason ? ` — ${reason}` : ""}
					{job.deadlineMs !== null && !isTerminal(job.state) ?
						` · ${fmtCountdown(job.deadlineMs, now)}`
					:	""}
				</div>
			</div>

			<div className="when">
				{job.state === "leased" && job.updatedMs <= now ?
					fmtDuration((now - job.updatedMs) / 1000)
				:	fmtAgo(job.updatedMs, now)}
			</div>

			<div className="ops">
				{game ?
					<a className="btn btn-sm btn-ghost" href={href.game(game.gameId)}>
						Open
					</a>
				:	null}
				{canCancel ?
					<button className="btn-sm btn-danger" onClick={cancel.run} disabled={cancel.pending}>
						{cancel.pending ? "…" : "Cancel"}
					</button>
				:	null}
				{canRetry ?
					<button className="btn-sm" onClick={retry.run} disabled={retry.pending}>
						{retry.pending ? "…" : "Retry"}
					</button>
				:	null}
			</div>
		</div>
	)
}
