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
import { SEVERITY_RANK, cls, fmtAgo, fmtInterval } from "../lib/format.ts"
import { api } from "../lib/api.ts"
import { href, navigate, useLocalState, useNow, useResource } from "../lib/hooks.ts"
import { FeedbackCard } from "../components/FeedbackCard.tsx"
import { Sparkline } from "../components/Sparkline.tsx"
import { TrendChart } from "../components/TrendChart.tsx"
import { Blank, Broken, Loading } from "../components/States.tsx"

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
				{/* The shape of what is coming: one coach block, then a grid of cards. */}
				<Loading rows={1} height={140} label="Computing trends" />
				<Loading rows={1} height={300} label="Computing trends" />
			</div>
		)

	if (!t)
		return (
			<div className="page">
				<div className="page-head">
					<h1>Trends</h1>
				</div>
				<Broken
					title="Couldn't load trends."
					message={trends.error ?? "The daemon returned nothing."}
					actions={<button onClick={trends.reload}>Retry</button>}
				/>
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
				<div className="notice warn">
					<span className="icon">⚠</span>
					<div>
						<strong>{t.gameCount} games is not enough to see a pattern.</strong> Everything
						below is real, but treat it as a snapshot of these specific games rather than as a
						trend. Play a few more and this page gets sharper.
					</div>
				</div>
			:	null}

			{t.review ?
				<div className="coach">
					<div className="who">Coach Lillia · across {t.gameCount} games</div>
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
			:	<div className="notice info">
					<span className="icon">◇</span>
					<div>
						<strong>No cross-game write-up yet.</strong> The trend review is queued by the
						daemon once there are enough analyzed games; the numbers below are already live.{" "}
						<a href={href.queue}>Check the queue →</a>
					</div>
				</div>
			}

			{items.length > 0 ?
				<div className="panel panel-pad">
					<div className="section-title">
						Patterns <span className="rule" />
						<span className="gloss">these span games, so they have no single timestamp</span>
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
				<Blank
					title="No series yet"
					actions={
						<a className="btn btn-primary" href={href.games}>
							Go to games
						</a>
					}
				>
					Trend series come from per-game metrics, so at least a few games need to be analyzed
					first.
				</Blank>
			:	<>
					{/*
					 * At a glance is a TABLE, and was drawn with the queue's job-row styles — a
					 * sparkline, a label and a mean laid out with `display: grid` and a hand-set
					 * `width: 120`. Nothing lined up down the page, which is the only thing this
					 * summary is for: reading ten means and their spreads in one pass.
					 *
					 * The verdict column is the honesty column. "noise" is not a warning — it is a
					 * statement that the spread swamps the level — so it is dashed and neutral
					 * rather than amber, and only "trend" gets a hue, because only "trend" is a
					 * claim about direction.
					 */}
					<div className="panel panel-pad">
						<div className="section-title">
							At a glance <span className="rule" />
							<span className="gloss">
									mean over the window with its 95% interval — not a ladder percentile
								</span>
						</div>
						<div className="table-wrap">
							<table className="dtable">
								<thead>
									<tr>
										<th>Metric</th>
										<th>Shape</th>
										<th className="num-col">Mean ± 95% CI</th>
										<th className="num-col">Games</th>
										<th>Verdict</th>
									</tr>
								</thead>
								<tbody>
									{series.map(s => (
										<tr key={s.key}>
											<td>{s.label}</td>
											<td>
												<Sparkline values={s.points.map(p => p.value)} width={110} />
											</td>
											{/*
											 * One call for the pair, so the table and the chart
											 * below it cannot quote the same mean at two
											 * precisions — this column read `72.45 ± 2.88` over a
											 * chart header that said `mean 72`.
											 */}
											<td className="num-col">
												{fmtInterval(s.mean, s.ci95)}
												{s.ci95 === null ?
													<span
														className="faint"
														title="Sample too small for a confidence interval"
													>
														{" "}
														± —
													</span>
												:	null}
											</td>
											<td className="num-col faint">{s.points.length}</td>
											<td>
												<span
													className={cls(
														"chip",
														!s.trendable ? "uncertain"
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
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</div>

					{/*
					 * The charts are a DISCLOSURE, and the table above them is the page.
					 *
					 * Thirty-seven series drew thirty-seven full cards, one under the other, and the
					 * page came out around 4,000px on a desktop and 17,000px on a phone. Nothing in
					 * it was wrong and nothing was redundant — every chart is a real series — but a
					 * page you have to scroll for thirty seconds to reach the bottom of is one where
					 * the tenth chart is never seen, so the extra 33 were costing rather than adding.
					 *
					 * Nothing is removed: the table lists all of them with their sparkline, mean,
					 * interval and verdict, which is what "at a glance" is for, and either group
					 * opens to the full charts in one click. The noisy half starts closed because by
					 * its own label no direction can be claimed from it.
					 */}
					{trendable.length > 0 ?
						<details className="trend-group" open>
							<summary>
								<span className="t">Stable enough to read</span>
								<span className="n">{trendable.length}</span>
								<span className="gloss">
									the level is quotable — a line is drawn only where the slope's own 95% CI
									excludes zero
								</span>
							</summary>
							<div className="trend-grid">
								{trendable.map(s => (
									<SeriesCard key={s.key} series={s} />
								))}
							</div>
						</details>
					:	null}

					{noisy.length > 0 ?
						<details className="trend-group">
							<summary>
								<span className="t">Too noisy to call</span>
								<span className="n">{noisy.length}</span>
								<span className="gloss">
									shown as points only — no line, because a line here would be a lie
								</span>
							</summary>
							<div className="trend-grid">
								{noisy.map(s => (
									<SeriesCard key={s.key} series={s} />
								))}
							</div>
						</details>
					:	null}
				</>
			}
		</div>
	)
}

/*
 * A card is a frame around a `<TrendChart>`, not a second copy of it.
 *
 * It used to print the label and the mean in its own header and the series note in its own
 * footer — and `TrendChart` already renders all three, with more context. So every card showed
 * its title twice, its mean twice at two different precisions ("72.45 ± 2.88" over "mean 72
 * ±2.9 (95% CI) n=20"), and the whole "the LEVEL is stable enough to quote…" paragraph twice in
 * a row. What is left here is what the chart cannot know: whether this card sits in the
 * trendable half of the page, and the one line of provenance under it.
 */
const SeriesCard = ({ series }: { series: TrendSeries }) => (
	<div className={cls("panel", "trend-card", !series.trendable && "untrendable")}>
		{series.trendable ?
			null
			/* Dashed, not amber: this is a limit of the sample, not something wrong. */
		:	<div className="head">
				<span
					className="chip uncertain"
					title="A slope through this data would not be meaningful"
				>
					not statistically meaningful
				</span>
			</div>
		}

		{/*
		 * `n=` and "mean over the window" both already appear in the chart's own header, and this
		 * footer repeated them once per card — the same sentence 37 times down one page. The
		 * provenance is stated once, in the section gloss.
		 */}
		<TrendChart series={series} onSelectGame={gameId => navigate(href.game(gameId))} />
	</div>
)
