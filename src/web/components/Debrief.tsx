/**
 * The debrief: what the last game was, what went well, what to fix, what to try next.
 *
 * ## Why this is a component and not a page
 *
 * It has two homes. The coach window shows it the moment a game ends — that is the whole point,
 * because the thirty seconds between games is when he will actually read something — and it is
 * a self-contained panel anywhere else that has a gameId. So it fetches its own detail, owns its
 * own waiting states, and takes a size rather than assuming a 380px window or a monitor.
 *
 * ## The review is not there yet, and that is normal
 *
 * A review takes roughly twenty seconds after a game lands. That interval is exactly when this
 * panel is on screen, so "no review yet" is the COMMON case, not the edge case — and a panel
 * that renders empty for twenty seconds reads as broken. It is filled instead with the things
 * already measured: the scoreline, the grade against his own form, and the metrics that came
 * out well and badly. All of those are read off the game; none of them is the coach's opinion,
 * so nothing here can contradict the write-up when it lands.
 *
 * ## Pros before cons, always
 *
 * Hard rule 6 in AGENTS.md — a review that is only criticism is a bad review even when every
 * criticism is correct — is a rule for the coach, and it has to be a rule for the layout too. A
 * praise item that the model wrote and the UI buried below three corrections has been deleted
 * in effect.
 */

import { useEffect, useState } from "react"
import type { FeedbackItem, Metric } from "../../shared/schema/domain.ts"
import { effectiveCs } from "../../shared/schema/domain.ts"
import { api } from "../lib/api.ts"
import { href, useAction, useResource } from "../lib/hooks.ts"
import {
	cls,
	fmtClock,
	fmtKda,
	fmtMetricDelta,
	fmtMetricUnit,
	fmtMetricValue
} from "../lib/format.ts"
import { ChampIcon } from "./ChampIcon.tsx"
import { GradeBadge } from "./GradeBadge.tsx"
import "./components.css"

/** How often to look again while the coach is still writing. */
const WAITING_POLL_MS = 6000

export interface DebriefProps {
	gameId: number
	/**
	 * `compact` is the 380px overlay: one thing that went well, two to fix. `wide` is a second
	 * monitor and can carry the reasoning. Same data, different amount of it.
	 */
	size?: "compact" | "wide"
	/** Header text the caller already has, so the panel draws before the detail arrives. */
	championName?: string
	win?: boolean
	/** Rendered as a close control when supplied. */
	onDismiss?: () => void
}

/**
 * Praise is what the coach LABELLED as praise, and nothing else.
 *
 * `severity: "info"` is not a synonym for it. A low-confidence read is demoted to `info` by the
 * ranker, and so is a trade-off the data cannot settle — "drake at 14:12 while you took bot
 * plates" is an open question, not a compliment. Filing those under "worth keeping" would tell
 * him to keep doing the thing the coach was unsure about.
 */
const isPraise = (i: FeedbackItem): boolean => i.category === "praise"

const byPriority = (a: FeedbackItem, b: FeedbackItem): number => (b.priority ?? 0) - (a.priority ?? 0)

/** The measured highlights, for the twenty seconds before there is a write-up to show. */
const banded = (metrics: readonly Metric[], band: "good" | "bad", limit: number): Metric[] =>
	metrics
		.filter(m => m.band === band)
		.sort((a, b) => Math.abs(b.vsBaseline ?? 0) - Math.abs(a.vsBaseline ?? 0))
		.slice(0, limit)

export const Debrief = ({
	gameId,
	size = "compact",
	championName,
	win,
	onDismiss
}: DebriefProps) => {
	const [tick, setTick] = useState(0)
	const detail = useResource(signal => api.game(gameId, signal), [gameId, tick])
	const d = detail.data
	const review = d?.review ?? null
	const written = review !== null && review.status !== "failed"

	/*
	 * Poll only while there is something still to arrive. This is a local SQLite read behind a
	 * loopback request, so the cost is nothing — but a panel that keeps polling after the review
	 * has landed is a panel that will still be polling tomorrow morning.
	 */
	useEffect(() => {
		if (written) return
		const id = setInterval(() => setTick(t => t + 1), WAITING_POLL_MS)
		return () => clearInterval(id)
	}, [written])

	const generate = useAction(() => api.requestReview(gameId))

	const g = d?.game ?? null
	const items = [...(review?.items ?? [])].sort(byPriority)
	const pros = items.filter(isPraise).slice(0, size === "wide" ? 2 : 1)
	const cons = items.filter(i => !isPraise(i)).slice(0, size === "wide" ? 3 : 2)
	const goals = (review?.goals ?? []).slice(0, 3)

	return (
		<div className={`csk-debrief csk-debrief--${size}`}>
			<div className="csk-debrief__head">
				<ChampIcon
					championId={g?.championId ?? 0}
					championName={g?.championName ?? championName}
					size={size === "wide" ? 44 : 32}
				/>
				<div className="csk-debrief__who">
					<strong>{g?.championName ?? championName ?? "Last game"}</strong>
					<span className="csk-debrief__line">
						{g ?
							<>
								<span className={cls("chip", g.win ? "win" : "loss")}>
									{g.win ? "Win" : "Loss"}
								</span>
								<span className="mono">{fmtKda(g.kills, g.deaths, g.assists)}</span>
								<span className="mono">{effectiveCs(g)} cs</span>
								<span className="mono">{fmtClock(g.gameDurationSec)}</span>
							</>
						: win !== undefined ?
							<span className={cls("chip", win ? "win" : "loss")}>{win ? "Win" : "Loss"}</span>
						:	<span className="dim">game over</span>}
					</span>
				</div>
				{g ? <GradeBadge score={g.gradeScore} rank={g.gradeRank} size={size === "wide" ? "lg" : "sm"} /> : null}
				{onDismiss ?
					<button
						className="csk-debrief__close"
						onClick={onDismiss}
						title="Close this debrief. It stays closed — it will not come back on the next reload."
					>
						✕
					</button>
				:	null}
			</div>

			{detail.loading ?
				<div className="csk-debrief__waiting">
					<div className="skeleton" style={{ height: 14, marginBottom: 8 }} />
					<div className="skeleton" style={{ height: 40 }} />
				</div>
			: !d ?
				<div className="csk-debrief__waiting">
					<strong>Couldn't load that game.</strong>
					<span>{detail.error ?? "The daemon returned nothing for it."}</span>
					<button onClick={detail.reload}>Retry</button>
				</div>
			:	<>
					{written ?
						<>
							<div className="csk-debrief__headline">{review.headline}</div>
							{review.encouragement !== "" ?
								<div className="csk-debrief__hype">{review.encouragement}</div>
							:	null}
						</>
					:	<PendingCoach
							failed={review !== null}
							error={review?.error ?? null}
							analyzed={d.metrics.length > 0}
							moments={d.moments.length}
							onGenerate={generate.run}
							pending={generate.pending}
						/>
					}

					{pros.length > 0 ?
						<Section title="Worth keeping" tone="good" items={pros} showBody={size === "wide"} />
					:	null}
					{cons.length > 0 ?
						<Section title="Work on this next game" tone="bad" items={cons} showBody={size === "wide"} />
					:	null}

					{/*
					 * Only while there is no write-up. Once the coach has spoken, repeating the
					 * raw bands underneath it is noise — the items already cite their numbers.
					 */}
					{!written && d.metrics.length > 0 ?
						<MeasuredHighlights metrics={d.metrics} size={size} />
					:	null}

					{goals.length > 0 ?
						<ol className="csk-debrief__goals">
							{goals.map((goal, i) => (
								<li key={i}>
									<span className="n">{i + 1}</span>
									<span>{goal}</span>
								</li>
							))}
						</ol>
					:	null}

					<div className="csk-debrief__foot">
						{/*
						 * A new window, not a navigation: this panel is usually rendered inside the
						 * always-on-top coach window, and turning that 380px window into the full
						 * review screen would be a surprise rather than a feature.
						 */}
						<a href={href.game(gameId)} target="_blank" rel="noreferrer">
							Open the full review →
						</a>
						{d.media.length > 0 ?
							<span className="dim">
								{d.media.length} clip{d.media.length === 1 ? "" : "s"} captured
							</span>
						:	null}
					</div>
				</>
			}
		</div>
	)
}

/* --------------------------------------------------------------- pieces */

/**
 * The gap between the game ending and the review landing — about twenty seconds, and it is
 * where this panel spends most of its life. It says which step is outstanding rather than
 * spinning, because "analysis hasn't run" and "the coach is writing" have different answers if
 * it stalls.
 */
const PendingCoach = ({
	failed,
	error,
	analyzed,
	moments,
	onGenerate,
	pending
}: {
	failed: boolean
	error: string | null
	analyzed: boolean
	moments: number
	onGenerate: () => void
	pending: boolean
}) => {
	if (failed)
		return (
			<div className="csk-debrief__waiting bad">
				<strong>The review didn't come through.</strong>
				<span>{error ?? "No reason was recorded."}</span>
				<button onClick={onGenerate} disabled={pending}>
					{pending ? "Queuing…" : "Try again"}
				</button>
			</div>
		)

	return (
		<div className="csk-debrief__waiting">
			<strong>
				{analyzed ? "fawnsei is writing this one up…" : "Crunching the match…"}
			</strong>
			<span>
				{analyzed ?
					`${moments} moment${moments === 1 ? "" : "s"} found. The numbers below are already measured — the write-up lands in a few seconds and this fills itself in.`
				:	"Pulling the timeline out of the client. Nothing to do; this updates itself."}
			</span>
			{analyzed ?
				<button onClick={onGenerate} disabled={pending}>
					{pending ? "Queuing…" : "Write it now"}
				</button>
			:	null}
		</div>
	)
}

const Section = ({
	title,
	tone,
	items,
	showBody
}: {
	title: string
	tone: "good" | "bad"
	items: readonly FeedbackItem[]
	showBody: boolean
}) => (
	<div className={`csk-debrief__section csk-debrief__section--${tone}`}>
		<div className="csk-debrief__label">{title}</div>
		{items.map(item => (
			<div key={item.id} className="csk-debrief__item">
				<div className="t">{item.title}</div>
				{item.fix !== "" ? <div className="f">{item.fix}</div> : null}
				{showBody && item.body !== "" ? <div className="b">{item.body}</div> : null}
			</div>
		))}
	</div>
)

/**
 * What is already known while the coach writes: measured figures against his own baseline, with
 * no interpretation attached. Nothing here is a judgement, so nothing here can be contradicted
 * by the review that follows it.
 */
const MeasuredHighlights = ({
	metrics,
	size
}: {
	metrics: readonly Metric[]
	size: "compact" | "wide"
}) => {
	const limit = size === "wide" ? 3 : 2
	const good = banded(metrics, "good", limit)
	const bad = banded(metrics, "bad", limit)
	if (good.length === 0 && bad.length === 0) return null

	return (
		<div className="csk-debrief__measured">
			<div className="csk-debrief__label">Measured, before anyone has an opinion</div>
			<div className="csk-debrief__bands">
				{[...good, ...bad].map(m => (
					<div key={m.key} className={cls("csk-debrief__band", `band-${m.band}`)} title={m.explain}>
						<span className="v">
							{fmtMetricValue(m)}
							<em>{fmtMetricUnit(m)}</em>
						</span>
						<span className="k">{m.label}</span>
						{m.vsBaseline !== null ? <span className="d">{fmtMetricDelta(m)}</span> : null}
					</div>
				))}
			</div>
		</div>
	)
}
