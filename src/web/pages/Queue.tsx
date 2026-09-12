/**
 * The queue exists to make deferral legible.
 *
 * Almost everything this app does happens in the background, and the single most common
 * question is "why is nothing happening". The answer is always a reason the handler recorded on
 * the job, so this screen prints those reasons VERBATIM rather than paraphrasing them into a
 * spinner.
 *
 * It used to paraphrase them, through a `humanReason` translator that matched on the intrusive
 * gate's phrasings — "you're in a game", "a replay is already playing". That gate is gone with
 * replay capture, none of those strings can be written any more, and the one reason that IS
 * still written ("League client is closed") was the one its patterns missed. It was also dead
 * code: the rows render `jobReason` from `lib/format.ts` and never called it.
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
import { Blank, Broken, Loading } from "../components/States.tsx"

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
	/*
	 * What the page will actually PAINT, which is not the same as what it tracks.
	 *
	 * The empty state used to key off `all.length === 0`. That is almost never true — the job
	 * table keeps its history, so the steady state of this app is a hundred `done` rows and
	 * nothing pending. With "show completed" off (the default) every group then filtered itself
	 * down to zero, each returned null, and the page rendered a header reading "0 active · 100
	 * tracked" above a completely blank screen with no explanation. Count what survives the
	 * filter instead.
	 */
	const visible = all.filter(j => showDone || j.state !== "done")

	return (
		<div className="page">
			<div className="page-head">
				<h1>Queue</h1>
				<div className="sub">
					{active.length} active · {all.length} tracked
					{jobs.refreshing ? " · refreshing…" : ""}
				</div>
				<div className="spacer" />
				<label className="dim" style={{ fontSize: "var(--fs-2)", display: "flex", gap: 6, alignItems: "center" }}>
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

			{jobs.error ? <Broken title="Can't read the queue." message={jobs.error} /> : null}

			{sync.error ? <Broken title="Sync failed." message={sync.error} /> : null}

			{/*
			 * This page had the empty state and the broken state and no loading state, so a first
			 * paint against a slow daemon was a header reading "0 active · 0 tracked" over nothing
			 * at all — which is the same picture as a queue that is genuinely empty, and the
			 * opposite claim about what the daemon is doing. Job rows are a fixed height, so the
			 * shimmer is the shape of what is coming.
			 */}
			{jobs.loading ? <Loading rows={5} height={52} label="Reading the queue" /> : null}

			{visible.length === 0 && !jobs.loading ?
				<Blank
					title="Queue is empty"
					actions={
						<a className="btn" href={href.games}>
							Back to games
						</a>
					}
				>
					Nothing is pending. New games queue their own ingest, download, analysis and review
					jobs the moment they end.
					{all.length > 0 ?
						<div className="faint" style={{ marginTop: "var(--sp-2)" }}>
							{all.length} finished job{all.length === 1 ? "" : "s"}{" "}
							{all.length === 1 ? "is" : "are"} hidden — tick <strong>show completed</strong> to
							read them.
						</div>
					:	null}
				</Blank>
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
								<span className="gloss">{group.blurb}</span>
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
