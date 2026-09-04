/**
 * The queue exists to make deferral legible.
 *
 * Almost everything this app does happens in the background, and the single most common
 * question is "why is nothing happening". The answer is always a gate reason recorded on a
 * job, so this screen prints those reasons verbatim rather than paraphrasing them into a
 * spinner.
 */

import { useMemo, useState } from "react"
import type { HealthResponse } from "../../shared/schema/api.ts"
import type { Game, Job, JobState } from "../../shared/schema/domain.ts"
import { isTerminal } from "../../shared/schema/domain.ts"
import { IDLE_PHASES } from "../../shared/constants.ts"
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

/**
 * Turn the daemon's gate verdict into something a person can act on.
 *
 * The raw string is `gate G1+G2+G4: client is in InProgress, not None/Lobby; a game is in
 * progress; the in-game API on port 2999 is answering` — three restatements of one fact, led by
 * codes that mean nothing outside this repo. The codes stay in the logs where they are useful.
 */
const humanReason = (reason: string | null): string | null => {
	if (!reason) return null
	const body = reason.replace(/^gate\s+G[\d+G]*:\s*/i, "")

	if (/a game is in progress|client is in (InProgress|ChampSelect|Matchmaking|ReadyCheck)/i.test(body))
		return "You're in a game — this will start once you're back at the lobby."
	if (/a replay is already playing/i.test(body))
		return "A replay is already open in League. Close it and this will start."
	if (/not running|client is not running/i.test(body))
		return "League isn't open. Start it and this will begin on its own."
	if (/switched off in Settings/i.test(body))
		return "Replay capture is switched off in Settings."
	if (/\.rofl file is not on disk/i.test(body))
		return "The replay file for this game isn't on disk, so it can't be captured."
	if (/another capture already holds/i.test(body))
		return "Another capture is using League right now. This one is next."
	if (/only idle for/i.test(body))
		return "Waiting for League to sit idle for a moment first."
	if (/deadline passed/i.test(body))
		return "Timed out waiting for a chance to run. Ask for it again when you're at the lobby."
	// Unknown reasons pass through rather than being swallowed — a mystery is better than a lie.
	return body
}

export interface QueueProps {
	health: HealthResponse | null
	eventTick: number
}

export const Queue = ({ health, eventTick }: QueueProps) => {
	const jobs = useResource(signal => api.jobs(signal), [eventTick])
	const games = useResource(signal => api.games(200, signal), [eventTick])
	const settings = useResource(signal => api.settings(signal), [eventTick])
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
	const phase = health?.gameflowPhase ?? null
	const idle = phase !== null && (IDLE_PHASES as readonly string[]).includes(phase)
	const captureEnabled = settings.data?.captureEnabled ?? false
	const graceMin = Math.round((settings.data?.idleGraceMs ?? 120_000) / 60_000)

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

			{/* Capture is the only intrusive thing this app does, so it gets its own explainer. */}
			<div className={cls("notice", captureEnabled && !idle ? "warn" : "info")} style={{ marginBottom: 14 }}>
				<span className="icon">{captureEnabled ? (idle ? "●" : "⏸") : "○"}</span>
				<div>
					{!captureEnabled ?
						<>
							<strong>Automatic clip capture is off.</strong> Nothing will ever take over your
							League client unless you turn it on in <a href={href.settings}>Settings</a> or
							press “Capture clips” on a game yourself. Every moment still gets a rendered map
							image, so reviews are complete without it.
						</>
					: idle ?
						<>
							<strong>Capture is allowed right now.</strong> The client is in{" "}
							<code className="mono">{phase}</code>, which is an idle phase — a replay
							capture job may start at any time.
						</>
					:	<>
							<strong>Capture is held.</strong>{" "}
							{phase === null ?
								"The League client isn't connected, so a replay can't be launched."
							:	<>
									The client is in <code className="mono">{phase}</code>. Capture only runs
									from {IDLE_PHASES.join(" or ")}, after {graceMin} minute
									{graceMin === 1 ? "" : "s"} of quiet — it takes over your client, and doing
									that mid-queue would be rude.
								</>
							}
						</>
					}
				</div>
			</div>

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
						// "intrusive" is this codebase's word for it, not the user's. Say what
						// actually happens: it opens their game and drives it.
						<span
							className="chip warn"
							style={{ marginLeft: 8 }}
							title="This job opens League and controls it for a few minutes to record your replay. It waits until you are out of a game, and it stops if you start one."
						>
							opens your game
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
