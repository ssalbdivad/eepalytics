/**
 * Cross-game goals.
 *
 * The hard rule on this screen: a series that says `trendable: false` is rendered as points
 * with a visible "not a trend" marking and its own note, never as a confident line. Twenty
 * solo queue games is a tiny sample and most per-game metrics are dominated by matchup
 * noise; drawing a slope through that would be the most dishonest thing this app could do.
 */

import { useMemo } from "react"
import type { TrendSeries } from "../../shared/schema/domain.ts"
import { SEVERITY_RANK, cls, fmtAgo, fmtNum } from "../lib/format.ts"
import { api } from "../lib/api.ts"
import { href, navigate, useLocalState, useNow, useResource } from "../lib/hooks.ts"
import { FeedbackCard } from "../components/FeedbackCard.tsx"
import { Sparkline } from "../components/Sparkline.tsx"
import { TrendChart } from "../components/TrendChart.tsx"

const WINDOWS = [10, 20, 50] as const

export interface TrendsProps {
	eventTick: number
}

export const Trends = ({ eventTick }: TrendsProps) => {
	const [games, setGames] = useLocalState<number>("trends.window", 20)
	const trends = useResource(signal => api.trends(games, signal), [games, eventTick])
	const now = useNow(30_000)

	const t = trends.data
	const items = useMemo(
		() =>
			[...(t?.review?.items ?? [])].sort(
				(a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
			),
		[t]
	)
	const series = t?.series ?? []
	/**
	 * Trend items cite metric SERIES, and FeedbackCard resolves a key to a label only when it is
	 * handed the metric list. Without it the evidence chip printed the raw identifier —
	 * "p90OverExtension" — under a heading that says "evidence".
	 */
	const metricsForCards = useMemo(
		() =>
			series.map(s => ({
				key: s.key,
				label: s.label,
				value: s.mean,
				unit: "",
				band: "unknown" as const,
				vsBaseline: null,
				confidence: "medium" as const,
				explain: s.note ?? "",
				fix: "",
				impact: "medium" as const,
				actionability: "medium" as const,
				priority: 0
			})),
		[series]
	)
	const trendable = series.filter(s => s.trendable)
	const noisy = series.filter(s => !s.trendable)

	if (trends.loading)
		return (
			<div className="page">
				<div className="page-head">
					<h1>Trends</h1>
				</div>
				<div className="skeleton" style={{ height: 140, marginBottom: 14 }} />
				<div className="skeleton" style={{ height: 300 }} />
			</div>
		)

	if (!t)
		return (
			<div className="page">
				<div className="empty">
					<h2>Couldn't load trends</h2>
					<p>{trends.error ?? "The daemon returned nothing."}</p>
					<div className="actions">
						<button onClick={trends.reload}>Retry</button>
					</div>
				</div>
			</div>
		)

	return (
		<div className="page">
			<div className="page-head">
				<h1>Trends</h1>
				<div className="sub">
					across your last {t.gameCount} game{t.gameCount === 1 ? "" : "s"} · computed{" "}
					{fmtAgo(t.generatedMs, now)}
				</div>
				<div className="spacer" />
				<div className="seg">
					{WINDOWS.map(w => (
						<button key={w} className={cls(games === w && "active")} onClick={() => setGames(w)}>
							last {w}
						</button>
					))}
				</div>
			</div>

			{t.gameCount < 5 ?
				<div className="notice warn" style={{ marginBottom: 14 }}>
					<span className="icon">⚠</span>
					<div>
						<strong>{t.gameCount} games is not enough to see a pattern.</strong> Everything
						below is real, but treat it as a snapshot of these specific games rather than as a
						trend. Play a few more and this page gets sharper.
					</div>
				</div>
			:	null}

			{t.review ?
				<div className="coach" style={{ marginBottom: 14 }}>
					<div className="who">fawnsei · across {t.gameCount} games</div>
					<div className="headline">{t.review.headline}</div>
					{t.review.encouragement ?
						<div className="encouragement">{t.review.encouragement}</div>
					:	null}
					{t.review.goals.length > 0 ?
						<ul className="goals">
							{t.review.goals.map((goal, i) => (
								<li key={i}>
									<span className="n">GOAL {i + 1}</span>
									<span>{goal}</span>
								</li>
							))}
						</ul>
					:	null}
					<div className="foot">
						<span>{t.review.model}</span>
						<span>{fmtAgo(t.review.createdMs, now)}</span>
						<span>analysis v{t.review.analysisVersion}</span>
					</div>
				</div>
			:	<div className="notice info" style={{ marginBottom: 14 }}>
					<span className="icon">◇</span>
					<div>
						<strong>No cross-game write-up yet.</strong> The trend review is queued by the
						daemon once there are enough analyzed games; the numbers below are already live.{" "}
						<a href={href.queue}>Check the queue →</a>
					</div>
				</div>
			}

			{items.length > 0 ?
				<div className="panel panel-pad" style={{ marginBottom: 14 }}>
					<div className="section-title">
						Patterns <span className="rule" />
						<span className="faint" style={{ textTransform: "none", letterSpacing: 0 }}>
							these span games, so they have no single timestamp
						</span>
					</div>
					<div className="feedback-list">
						{items.map(item => (
							<FeedbackCard
										key={item.id}
										item={item}
										moments={[]}
										media={[]}
										// Without this the card falls back to the raw metric key, so a
										// trend item's evidence chip read "p90OverExtension" under a
										// heading that says "evidence". The series already carry labels.
										metrics={metricsForCards}
										onSeek={() => {}}
									/>
						))}
					</div>
				</div>
			:	null}

			{series.length === 0 ?
				<div className="empty">
					<h2>No series yet</h2>
					<p>
						Trend series come from per-game metrics, so at least a few games need to be analyzed
						first.
					</p>
					<div className="actions">
						<a className="btn btn-primary" href={href.games}>
							Go to games
						</a>
					</div>
				</div>
			:	<>
					<div className="panel panel-pad" style={{ marginBottom: 14 }}>
						<div className="section-title">
							At a glance <span className="rule" />
						</div>
						<div className="job-rows">
							{series.map(s => (
								<div className="job-row" key={s.key}>
									<span style={{ width: 120 }}>
										<Sparkline values={s.points.map(p => p.value)} width={110} />
									</span>
									<span className="what">
										<span className="kind">{s.label}</span>
										<span className="sub">
											n = {s.points.length}
											{s.trendable ? "" : " · not a trend"}
										</span>
									</span>
									<span className="mono">
										{fmtNum(s.mean, 2)}
										{s.ci95 !== null ? ` ± ${fmtNum(s.ci95, 2)}` : ""}
									</span>
									<span
										className={cls(
											"chip",
											!s.trendable ? "muted"
											: s.slopeSignificant ? "gold"
											: "muted"
										)}
										title={
											!s.trendable ?
												"The spread swamps the level — points only."
											: s.slopeSignificant ?
												"The level is stable AND the slope's own 95% CI excludes zero."
											:	"The level is stable enough to quote, but the slope's 95% CI contains zero — no direction can be claimed."
										}
									>
										{!s.trendable ? "noise"
										: s.slopeSignificant ? "trend"
										: "level"}
									</span>
								</div>
							))}
						</div>
					</div>

					{trendable.length > 0 ?
						<>
							<div className="section-title">
								Stable enough to read <span className="rule" />
								<span className="faint" style={{ textTransform: "none", letterSpacing: 0 }}>
									the level is quotable — a line is drawn only where the slope's own 95% CI
									excludes zero
								</span>
							</div>
							<div className="trend-grid" style={{ marginBottom: 20 }}>
								{trendable.map(s => (
									<SeriesCard key={s.key} series={s} />
								))}
							</div>
						</>
					:	null}

					{noisy.length > 0 ?
						<>
							<div className="section-title">
								Too noisy to call <span className="rule" />
								<span className="faint" style={{ textTransform: "none", letterSpacing: 0 }}>
									shown as points only — no line, because a line here would be a lie
								</span>
							</div>
							<div className="trend-grid">
								{noisy.map(s => (
									<SeriesCard key={s.key} series={s} />
								))}
							</div>
						</>
					:	null}
				</>
			}
		</div>
	)
}

const SeriesCard = ({ series }: { series: TrendSeries }) => (
	<div className={cls("panel", "trend-card", !series.trendable && "untrendable")}>
		<div className="head">
			<h3>{series.label}</h3>
			{series.trendable ?
				null
			:	<span className="chip warn" title="A slope through this data would not be meaningful">
					not statistically meaningful
				</span>
			}
			<span className="mean">
				{fmtNum(series.mean, 2)}
				{series.ci95 !== null ?
					<span className="faint"> ± {fmtNum(series.ci95, 2)}</span>
				:	<span className="faint" title="Sample too small for a confidence interval">
						{" "}
						± —
					</span>
				}
			</span>
		</div>

		<TrendChart series={series} onSelectGame={gameId => navigate(href.game(gameId))} />

		{series.note ? <div className="note">{series.note}</div> : null}

		<div className="faint" style={{ fontSize: 11 }}>
			{series.points.length} game{series.points.length === 1 ? "" : "s"} · mean over the window,
			not a ladder percentile
		</div>
	</div>
)
