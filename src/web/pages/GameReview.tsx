/**
 * The main event.
 *
 * One piece of shared state — `cursorSec` — binds the whole page together. Clicking a
 * feedback card, a map marker or the timeline sets it, and the map, the scrubber, the media
 * panel and the card list all react. That single bidirectional link is what makes this a
 * coaching tool instead of four widgets stacked vertically.
 *
 * Two things this page refuses to do:
 *  - fake positional data when `timelineAvailable` is false (the map is hidden, not empty), and
 *  - show a contentless spinner while a review generates. A review is a background job with a
 *    state, an attempt count and, when it is stuck, a reason — all of which are printed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { GameDetailResponse, HealthResponse } from "../../shared/schema/api.ts"
import type { FeedbackItem, Job, Moment } from "../../shared/schema/domain.ts"
import { csPerMin, effectiveCs } from "../../shared/schema/domain.ts"
import { queueName } from "../../shared/constants.ts"
import { zoneOf } from "../../shared/map.ts"
import { api } from "../lib/api.ts"
import { href, useAction, useNow, useResource } from "../lib/hooks.ts"
import { useSse } from "../lib/sse.ts"
import {
	SEVERITY_RANK,
	cls,
	fmtAgo,
	fmtClock,
	fmtCompact,
	fmtDateTime,
	fmtDuration,
	fmtKda,
	fmtKdaRatio,
	MOMENT_KIND_LABEL,
	replayCountdown,
	roleLabel
} from "../lib/format.ts"
import { ChampIcon } from "../components/ChampIcon.tsx"
import { GradeBadge } from "../components/GradeBadge.tsx"
import { CaptureProgress } from "../components/CaptureProgress.tsx"
import { VisionBadge } from "../components/VisionBadge.tsx"
import { WatchGamePanel } from "../components/WatchGamePanel.tsx"
import { CoachChat } from "../components/CoachChat.tsx"
import { FeedbackCard } from "../components/FeedbackCard.tsx"
import { GameTimeline } from "../components/GameTimeline.tsx"
import { MediaViewer } from "../components/MediaViewer.tsx"
import { MetricGrid } from "../components/MetricGrid.tsx"
import { MiniMap } from "../components/MiniMap.tsx"
import { Scoreboard } from "../components/Scoreboard.tsx"

/** How far from the cursor a moment still counts as "the thing you're looking at". */
const CURSOR_WINDOW_SEC = 30

export interface GameReviewProps {
	gameId: number
	eventTick: number
	/** For the capture gate's own words — see `WatchGamePanel`. */
	health?: HealthResponse | null
}

export const GameReview = ({ gameId, eventTick, health = null }: GameReviewProps) => {
	const detail = useResource(signal => api.game(gameId, signal), [gameId, eventTick])
	const jobsRes = useResource(signal => api.jobs(signal), [eventTick])
	const watchRes = useResource(signal => api.watchNotes(gameId, signal), [gameId, eventTick])
	const [watching, setWatching] = useState<string | null>(null)
	/**
	 * Live capture progress from the daemon's SSE stream.
	 *
	 * Without this the screen showed a gate reason and then nothing for several minutes, so a
	 * working capture and a hung one were indistinguishable — which is exactly how it read.
	 */
	const [captureProgress, setCaptureProgress] = useState<{
		phase: string
		note: string | null
		done: number
		total: number
	} | null>(null)

	useSse(m => {
		if (m.name !== "capture") return
		const d = m.data as { gameId?: number; phase?: string; note?: string; done?: number; total?: number }
		if (d.gameId !== gameId || typeof d.phase !== "string") return
		setCaptureProgress(
			d.phase === "closed" || d.phase === "failed" ?
				null
			:	{ phase: d.phase, note: d.note ?? null, done: d.done ?? 0, total: d.total ?? 0 }
		)
	})
	const now = useNow(15_000)

	const [cursorSec, setCursorSec] = useState(0)
	const [selectedMomentId, setSelectedMomentId] = useState<string | null>(null)
	const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
	const [activeMediaId, setActiveMediaId] = useState<string | null>(null)
	const [overlay, setOverlay] = useState<"deaths" | "heat" | "none">("deaths")
	const cardRefs = useRef(new Map<string, HTMLDivElement>())

	const d = detail.data
	const moments = useMemo(() => [...(d?.moments ?? [])].sort((a, b) => a.tSec - b.tSec), [d])
	const media = d?.media ?? []
	const items = useMemo(
		() =>
			/*
			 * Sort by the priority the daemon computed, not by severity.
			 *
			 * `priority` folds impact, actionability and confidence together in one place
			 * (`src/review/rank.ts`), so the API, this list and anything downstream agree on the
			 * order. Severity is now a CONSEQUENCE of that ranking — a low-confidence read is
			 * demoted to info — so sorting by it again here would fight the ranker.
			 *
			 * Older reviews have priority 0 across the board; they fall back to the previous
			 * severity ordering rather than collapsing into arbitrary order.
			 */
			[...(d?.review?.items ?? [])].sort(
				(a, b) =>
					(b.priority ?? 0) - (a.priority ?? 0) ||
					SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
					(a.tSec ?? 0) - (b.tSec ?? 0)
			),
		[d]
	)

	const momentById = useMemo(() => new Map(moments.map(m => [m.id, m])), [moments])
	const watchNotes = watchRes.data?.notes ?? []
	const noteByMoment = useMemo(
		() => new Map(watchNotes.filter(n => n.status === "ok").map(n => [n.momentId, n])),
		[watchNotes]
	)
	/** Moments with REAL captured frames — a generated map diagram is not something to watch. */
	const framesByMoment = useMemo(() => {
		const out = new Map<string, number>()
		for (const m of media)
			if (m.momentId && m.source === "replay" && m.kind === "screenshot")
				out.set(m.momentId, (out.get(m.momentId) ?? 0) + 1)
		return out
	}, [media])

	const watchMoment = useCallback(
		async (momentId: string) => {
			setWatching(momentId)
			try {
				await api.watchMoment(gameId, momentId)
				watchRes.reload()
			} finally {
				setWatching(null)
			}
		},
		[gameId, watchRes]
	)
	const mediaById = useMemo(() => new Map(media.map(m => [m.id, m])), [media])

	const gameJobs = useMemo(
		() => (jobsRes.data?.jobs ?? []).filter(j => j.gameId === gameId),
		[jobsRes.data, gameId]
	)
	const reviewJob = useMemo(() => liveJob(gameJobs, "review-game"), [gameJobs])
	const captureJob = useMemo(() => liveJob(gameJobs, "replay-capture"), [gameJobs])

	/* ------------------------------------------------------- the cursor */

	const seek = useCallback(
		(t: number) => {
			setCursorSec(t)
			let best: Moment | null = null
			for (const m of moments) {
				const dist = Math.abs(m.tSec - t)
				if (dist > CURSOR_WINDOW_SEC) continue
				if (!best || dist < Math.abs(best.tSec - t)) best = m
			}
			if (best) setSelectedMomentId(best.id)
		},
		[moments]
	)

	const selectMoment = useCallback(
		(id: string) => {
			const m = momentById.get(id)
			setSelectedMomentId(id)
			if (m) setCursorSec(m.tSec)
			const owner = items.find(it => it.momentIds.includes(id))
			if (owner) {
				setSelectedItemId(owner.id)
				cardRefs.current.get(owner.id)?.scrollIntoView({ block: "nearest", behavior: "smooth" })
			}
			const shot = media.find(x => x.momentId === id)
			if (shot) setActiveMediaId(shot.id)
		},
		[momentById, items, media]
	)

	const selectItem = useCallback(
		(item: FeedbackItem) => {
			setSelectedItemId(item.id)
			const firstMoment = item.momentIds.map(id => momentById.get(id)).find(Boolean)
			if (firstMoment) setSelectedMomentId(firstMoment.id)
			const t = item.tSec ?? firstMoment?.tSec ?? null
			if (t !== null) setCursorSec(t)
			const firstMedia = item.mediaIds.map(id => mediaById.get(id)).find(Boolean)
			if (firstMedia) setActiveMediaId(firstMedia.id)
		},
		[momentById, mediaById]
	)

	// Open on the loudest thing in the game rather than at 0:00.
	useEffect(() => {
		if (!d) return
		const first = items[0]
		if (first) {
			selectItem(first)
			return
		}
		const worst = [...moments].sort((a, b) => b.severity - a.severity)[0]
		if (worst) selectMoment(worst.id)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [gameId, d !== null])

	/* ------------------------------------------------------- mutations */

	const review = useAction(() => api.requestReview(gameId))
	const capture = useAction(() => api.requestCapture(gameId))

	/* ---------------------------------------------------------- render */

	if (detail.loading)
		return (
			<div className="page">
				<div className="skeleton" style={{ height: 88, marginBottom: 14 }} />
				<div className="skeleton" style={{ height: 120, marginBottom: 14 }} />
				<div className="skeleton" style={{ height: 420 }} />
			</div>
		)

	if (!d)
		return (
			<div className="page">
				<div className="empty">
					<h2>Couldn't load game {gameId}</h2>
					<p>{detail.error ?? "The daemon returned nothing for this game."}</p>
					{detail.errorDetail ?
						<div className="notice bad" style={{ textAlign: "left", maxWidth: 700, margin: "0 auto" }}>
							<span className="icon">✗</span>
							<div>
								<pre>{detail.errorDetail}</pre>
							</div>
						</div>
					:	null}
					<div className="actions">
						<button onClick={detail.reload}>Retry</button>
						<a className="btn" href={href.games}>
							Back to games
						</a>
					</div>
				</div>
			</div>
		)

	const g = d.game
	const cs = effectiveCs(g)
	const countdown =
		g.replayState === "absent" || g.replayState === "downloading" ?
			replayCountdown(g.endedAtMs, now)
		:	null

	return (
		<div className="page">
			<a href={href.games} className="dim" style={{ fontSize: 12.5 }}>
				← All games
			</a>

			<div className="panel review-head" style={{ marginTop: 8 }}>
				<ChampIcon championId={g.championId} size={56} />
				<div className="title">
					<h1>
						{g.championName}
						<span className="dim" style={{ fontSize: 14, fontWeight: 500 }}>
							{roleLabel(g.role)}
						</span>
						<span className={cls("chip", g.win ? "win" : "loss")}>{g.win ? "Win" : "Loss"}</span>
					</h1>
					<div className="meta">
						<span>{queueName(g.queueId)}</span>
						<span>{fmtDuration(g.gameDurationSec)}</span>
						<span>patch {g.patch}</span>
						<span title={new Date(g.gameCreationMs).toLocaleString()}>
							{fmtDateTime(g.gameCreationMs)} · {fmtAgo(g.gameCreationMs, now)}
						</span>
					</div>
				</div>

				<div className="score">
					{/* First in the row: how the game WENT, before the stats saying what happened. */}
					<div className="stat">
						<div className="v">
							<GradeBadge score={g.gradeScore} rank={g.gradeRank} size="lg" />
						</div>
						<div className="k">vs your own form</div>
					</div>
					<div className="stat">
						<div className="v">{fmtKda(g.kills, g.deaths, g.assists)}</div>
						<div className="k">{fmtKdaRatio(g.kills, g.deaths, g.assists)} kda</div>
					</div>
					<div className="stat">
						<div className="v">{cs}</div>
						<div className="k">cs · {csPerMin(g, g.gameDurationSec).toFixed(1)}/m</div>
					</div>
					<div className="stat">
						<div className="v">{g.visionScore}</div>
						<div className="k">vision</div>
					</div>
					<div className="stat">
						<div className="v">{fmtCompact(g.damageToChampions)}</div>
						<div className="k">damage</div>
					</div>
				</div>

				<div className="actions">
					{countdown ? <span className="chip warn">⧗ {countdown}</span> : null}
					<button onClick={capture.run} disabled={capture.pending || captureJob !== null}>
						{captureJob ? `Capture ${captureJob.state}` : capture.pending ? "Queuing…" : "Capture clips"}
					</button>
					<button
						className="btn-primary"
						onClick={review.run}
						disabled={review.pending || reviewJob !== null}
					>
						{reviewJob ? "Review queued" : review.pending ? "Queuing…" : d.review ? "Re-review ↻" : "Generate review"}
					</button>
				</div>
			</div>

			{review.error ?
				<div className="notice bad" style={{ marginBottom: 12 }}>
					<span className="icon">✗</span>
					<div>Couldn't queue a review: {review.error}</div>
				</div>
			:	null}
			{capture.error ?
				<div className="notice bad" style={{ marginBottom: 12 }}>
					<span className="icon">✗</span>
					<div>Couldn't queue capture: {capture.error}</div>
				</div>
			:	null}
			{captureJob ? <CaptureBanner job={captureJob} /> : null}

			<CoachBlock detail={d} job={reviewJob} onGenerate={review.run} pending={review.pending} />

			{d.metrics.length > 0 ?
				<div className="panel panel-pad" style={{ marginBottom: 14 }}>
					<div className="section-title">
						Metrics <span className="rule" />
						<span className="faint" style={{ textTransform: "none", letterSpacing: 0 }}>
							compared with your own recent games, never with a ladder average
						</span>
					</div>
					<MetricGrid metrics={d.metrics} />
				</div>
			:	null}

			<div className="review-body">
				<div className="left-col">
					{d.timelineAvailable ?
						<div className="panel panel-pad">
							<div className="section-title">
								Map <span className="rule" />
								<div className="seg">
									{(["deaths", "heat", "none"] as const).map(o => (
										<button
											key={o}
											className={cls("btn-sm", overlay === o && "active")}
											onClick={() => setOverlay(o)}
										>
											{o}
										</button>
									))}
								</div>
							</div>
							<MiniMap
								moments={moments}
								selectedId={selectedMomentId}
								onSelect={selectMoment}
								overlay={overlay}
								teamId={g.teamId === 100 || g.teamId === 200 ? g.teamId : undefined}
							/>
							<div className="cursor-bar" style={{ marginTop: 10 }}>
								<span className="t">{fmtClock(cursorSec)}</span>
								<span>{describeCursor(selectedMomentId, momentById, g.teamId)}</span>
							</div>
						</div>
					:	<div className="notice warn">
							<span className="icon">⚠</span>
							<div>
								<strong>No timeline stored for this game.</strong> Positions, pathing and the
								minimap need the per-minute timeline blob, which isn't on disk — so it is
								hidden rather than guessed. End-of-game stats below are still exact.
							</div>
						</div>
					}

					<div className="panel panel-pad">
						<div className="section-title">
							Timeline <span className="rule" />
							<span className="faint" style={{ textTransform: "none", letterSpacing: 0 }}>
								{moments.length} moments
							</span>
						</div>
						<GameTimeline
							durationSec={g.gameDurationSec}
							moments={moments}
							tSec={cursorSec}
							onSeek={seek}
						/>
					</div>

					<div className="panel panel-pad">
						<div className="section-title">
							Media <span className="rule" />
						</div>
						{media.length === 0 ?
							<div className="dim" style={{ fontSize: 12.5 }}>
								No screenshots or clips for this game yet. Capture takes over the League
								client, so it only runs when you're out of a game — and every coaching point
								below works without it.
							</div>
						:	<div className="media-strip">
								{media.map(m => (
									<button
										key={m.id}
										className={cls("media-thumb", activeMediaId === m.id && "selected")}
										onClick={() => {
											setActiveMediaId(m.id)
											if (m.momentId) selectMoment(m.momentId)
											else setCursorSec(m.tSec)
										}}
									>
										<span className="t">{fmtClock(m.tSec)}</span>
										<span className="k">
											{m.kind}
											{m.source === "generated" ? " · rendered" : ""}
										</span>
									</button>
								))}
							</div>
						}
					</div>
				</div>

				<div className="right-col">
					<div className="panel panel-pad">
						<div className="section-title">
							Feedback <span className="rule" />
							<span className="faint" style={{ textTransform: "none", letterSpacing: 0 }}>
								{items.length} item{items.length === 1 ? "" : "s"}
							</span>
							<VisionBadge
								watched={watchNotes.filter(n => n.status === "ok").length}
								watchable={framesByMoment.size}
								size="sm"
							/>
						</div>

						{/*
						 * Always present, in all three states. The visual pass needs frames, frames
						 * need a capture, and a capture takes over the client — three steps with
						 * three failure modes, none of which used to be visible anywhere.
						 */}
						{captureProgress !== null && (
							<CaptureProgress
								phase={captureProgress.phase}
								note={captureProgress.note}
								done={captureProgress.done}
								total={captureProgress.total}
							/>
						)}

						<WatchGamePanel
							game={g}
							health={health}
							frameMoments={framesByMoment.size}
							watchedMoments={watchNotes.filter(n => n.status === "ok").length}
							momentCount={moments.length}
							onChanged={() => watchRes.reload()}
						/>

						{items.length > 0 ?
							<div className="feedback-list">
								{items.map(item => (
									<div
										key={item.id}
										ref={el => {
											if (el) cardRefs.current.set(item.id, el)
											else cardRefs.current.delete(item.id)
										}}
										className={cls("feedback-slot", selectedItemId === item.id && "selected")}
										onClick={() => selectItem(item)}
									>
										<FeedbackCard
											item={item}
											moments={moments}
											media={media}
											watchedNote={
												item.momentIds
													.map(id => noteByMoment.get(id))
													.find(n => n !== undefined) ?? null
											}
											watchableFrames={item.momentIds.reduce(
												(n, id) => n + (framesByMoment.get(id) ?? 0),
												0
											)}
											onWatch={
												item.momentIds[0] ?
													() => void watchMoment(item.momentIds[0]!)
												:	undefined
											}
											watching={watching !== null && item.momentIds.includes(watching)}
											metrics={d.metrics}
											active={selectedItemId === item.id}
											onSeek={seek}
											onOpenMedia={id => {
												setActiveMediaId(id)
												setSelectedItemId(item.id)
											}}
										/>
									</div>
								))}
							</div>
						: moments.length > 0 ?
							<>
								<div className="notice info" style={{ marginBottom: 10 }}>
									<span className="icon">◷</span>
									<div>
										No coach write-up yet, but analysis already found{" "}
										<strong>{moments.length} moments</strong> worth looking at. They're listed
										below and every one is clickable.
									</div>
								</div>
								<MomentList
									moments={moments}
									selectedId={selectedMomentId}
									onSelect={selectMoment}
									teamId={g.teamId}
								/>
							</>
						:	<div className="dim" style={{ fontSize: 13 }}>
								Nothing to show yet — this game hasn't been analyzed.
							</div>
						}
					</div>

					{/*
					  * Chat sits directly under the feedback, above the moment list: the natural
					  * move after reading a coaching point is to argue with it.
					  */}
					{d.metrics.length > 0 ?
						<div className="panel panel-pad">
							<div className="section-title">
								Ask the coach <span className="rule" />
								<span className="faint" style={{ textTransform: "none", letterSpacing: 0 }}>
									about this game
								</span>
							</div>
							<CoachChat
								gameId={gameId}
								moments={moments}
								metrics={d.metrics}
								media={media}
								onSeek={seek}
								onSelectMoment={selectMoment}
							/>
						</div>
					:	null}

					{items.length > 0 && moments.length > 0 ?
						<div className="panel panel-pad">
							<div className="section-title">
								All moments <span className="rule" />
							</div>
							<MomentList
								moments={moments}
								selectedId={selectedMomentId}
								onSelect={selectMoment}
								teamId={g.teamId}
							/>
						</div>
					:	null}
				</div>
			</div>

			<div className="panel panel-pad scoreboard" style={{ marginTop: 14 }}>
				<div className="section-title">
					Scoreboard <span className="rule" />
				</div>
				<Scoreboard
					participants={d.participants}
					userId={g.participantId}
					durationSec={g.gameDurationSec}
				/>
			</div>

			{activeMediaId !== null ?
				<MediaViewer media={media} activeId={activeMediaId} onClose={() => setActiveMediaId(null)} />
			:	null}
		</div>
	)
}

/* ------------------------------------------------------------ helpers */

const liveJob = (jobs: readonly Job[], kind: string): Job | null =>
	jobs.find(j => j.kind === kind && (j.state === "queued" || j.state === "leased" || j.state === "deferred")) ??
	null

const describeCursor = (
	selectedId: string | null,
	byId: Map<string, Moment>,
	teamId: number
): string => {
	if (!selectedId) return "click the map, the timeline or a feedback card"
	const m = byId.get(selectedId)
	if (!m) return "—"
	const team = teamId === 100 || teamId === 200 ? teamId : undefined
	return `${MOMENT_KIND_LABEL[m.kind]} · ${m.title} · ${zoneOf({ x: m.mapX, y: m.mapY }, team)}`
}

/* ------------------------------------------------------- coach header */

const CoachBlock = ({
	detail,
	job,
	onGenerate,
	pending
}: {
	detail: GameDetailResponse
	job: Job | null
	onGenerate: () => void
	pending: boolean
}) => {
	const r = detail.review
	const now = useNow(1000)

	if (r && r.status !== "failed")
		return (
			<div className="coach">
				<div className="who">fawnsei</div>
				<div className="headline">{r.headline}</div>
				{r.encouragement ? <div className="encouragement">{r.encouragement}</div> : null}
				{r.goals.length > 0 ?
					<ul className="goals">
						{r.goals.map((goal, i) => (
							<li key={i}>
								<span className="n">{i + 1}</span>
								<span>{goal}</span>
							</li>
						))}
					</ul>
				:	null}
				<div className="foot">
					<span>{r.model}</span>
					<span>{fmtAgo(r.createdMs, now)}</span>
					{typeof r.durationMs === "number" && r.durationMs !== null ?
						<span>{(r.durationMs / 1000).toFixed(1)}s</span>
					:	null}
					<span>analysis v{r.analysisVersion}</span>
					{job ? <span className="band-ok">a newer review is {job.state}</span> : null}
				</div>
			</div>
		)

	if (r && r.status === "failed")
		return (
			<div className="notice bad" style={{ marginBottom: 14 }}>
				<span className="icon">✗</span>
				<div>
					<strong>The last review attempt failed.</strong> {r.error ?? "No reason recorded."}
					<div style={{ marginTop: 8 }}>
						<button onClick={onGenerate} disabled={pending || job !== null}>
							Try again
						</button>
					</div>
				</div>
			</div>
		)

	if (job) return <ReviewProgress job={job} now={now} />

	return (
		<div className="notice info" style={{ marginBottom: 14 }}>
			<span className="icon">◇</span>
			<div>
				<strong>No review for this game yet.</strong> The coach reads the match digest and writes
				timestamped feedback; it takes a few seconds and runs on your existing{" "}
				<code className="mono">claude</code> login.
				<div style={{ marginTop: 8 }}>
					<button className="btn-primary" onClick={onGenerate} disabled={pending}>
						{pending ? "Queuing…" : "Generate review"}
					</button>
				</div>
			</div>
		</div>
	)
}

/**
 * A review in flight is a job, and a job has a state, an attempt count and — when it is
 * stuck — a reason. Printing those is strictly more useful than a spinner.
 */
const ReviewProgress = ({ job, now }: { job: Job; now: number }) => {
	const started = job.state === "leased" ? job.updatedMs : null
	return (
		<div className="notice info" style={{ marginBottom: 14 }}>
			<span className="icon">◷</span>
			<div>
				<strong>
					{job.state === "leased" ?
						"fawnsei is writing…"
					: job.state === "deferred" ?
						"Review is waiting."
					:	"Review is queued."}
				</strong>{" "}
				{job.state === "leased" && started ?
					<>running for {Math.max(0, Math.round((now - started) / 1000))}s</>
				: job.state === "deferred" ?
					<>{job.lastError ?? "a gate is holding it"}</>
				: job.notBeforeMs > now ?
					<>starts in {Math.ceil((job.notBeforeMs - now) / 1000)}s</>
				:	<>waiting for a worker</>}
				{job.attempts > 1 ? ` · attempt ${job.attempts} of ${job.maxAttempts}` : ""}
				<div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>
					job #{job.id} · this page updates itself when it lands
				</div>
			</div>
		</div>
	)
}

const CaptureBanner = ({ job }: { job: Job }) => (
	<div className={cls("notice", job.state === "deferred" ? "warn" : "info")} style={{ marginBottom: 12 }}>
		<span className="icon">{job.state === "deferred" ? "⏸" : "◷"}</span>
		<div>
			<strong>
				{job.state === "deferred" ? "Clip capture is waiting." : "Clip capture is queued."}
			</strong>{" "}
			{job.lastError ??
				"It takes over your League client, so it only runs while you're out of a game."}{" "}
			<a href={href.queue}>See the queue →</a>
		</div>
	</div>
)

/* -------------------------------------------------------- moment list */

const MomentList = ({
	moments,
	selectedId,
	onSelect,
	teamId
}: {
	moments: readonly Moment[]
	selectedId: string | null
	onSelect: (id: string) => void
	teamId: number
}) => {
	const team = teamId === 100 || teamId === 200 ? teamId : undefined
	return (
		<div className="job-rows">
			{[...moments]
				.sort((a, b) => b.severity - a.severity || a.tSec - b.tSec)
				.map(m => (
					<button
						key={m.id}
						className={cls("job-row", selectedId === m.id && "selected")}
						style={{ textAlign: "left", cursor: "pointer" }}
						onClick={() => onSelect(m.id)}
						title={m.evidence}
					>
						<span className="mono band-ok">{fmtClock(m.tSec)}</span>
						<span className="what">
							<span className="kind">{m.title}</span>
							<span className="sub">
								{MOMENT_KIND_LABEL[m.kind]} · {zoneOf({ x: m.mapX, y: m.mapY }, team)}
								{m.costGold !== null ? ` · ${fmtCompact(m.costGold)}g swing` : ""}
								{m.confidence !== "high" ? ` · ${m.confidence} confidence` : ""}
							</span>
						</span>
						<span className="when">{Math.round(m.severity * 100)}</span>
						<span />
					</button>
				))}
		</div>
	)
}
