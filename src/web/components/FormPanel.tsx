/**
 * Standing at a glance: the grade curve, and the three habits worth working on.
 *
 * Both halves are derived from data already stored — no model call — so this is instant and the
 * same every time it is opened.
 *
 * The framing is load-bearing. "Form" is explicitly relative to his own recent games, and the
 * focus areas always show HOW MANY GAMES they came from, because that number is the whole
 * difference between "you did this twice" and "this is a habit". A focus list without its sample
 * size is just the loudest recent complaint wearing authority it has not earned.
 */

import type { FormResponse } from "../../shared/schema/api.ts"
import { href } from "../lib/hooks.ts"
import { GradeBadge } from "./GradeBadge.tsx"
import "./components.css"

const CATEGORY_LABEL: Record<string, string> = {
	pathing: "Pathing",
	tempo: "Tempo",
	objectives: "Objectives",
	vision: "Vision",
	farming: "Farming",
	teamfight: "Teamfighting",
	deaths: "Deaths",
	other: "Other"
}

export interface FormPanelProps {
	form: FormResponse | null
}

export const FormPanel = ({ form }: FormPanelProps) => {
	if (!form) return null

	const { rollingAverage: avg, previousAverage: prev, grades, focus } = form

	/*
	 * A percentage change and a sentence, not a chart.
	 *
	 * This was a sparkline of the last 20 grades. It looked informative and said nothing: a
	 * jagged line around a flat mean is what every player's form looks like, so the only
	 * readable message was "you fluctuate" — true of everyone, actionable for no one, and one
	 * more thing on a screen that already has too many. The number, the direction and a plain
	 * sentence carry the entire content of that chart in a form nobody has to decode.
	 */
	const deltaPct =
		avg !== null && prev !== null && prev > 0 ? Math.round(((avg - prev) / prev) * 100) : null

	// A few points of movement in a 20-game mean is noise, and calling it a trend would be
	// inventing a story. The threshold is what stops this from reporting weather as climate.
	const verdict =
		avg === null ? "Not enough games yet"
		: deltaPct === null ? "Your baseline for these games"
		: deltaPct >= 5 ? "Trending up"
		: deltaPct <= -5 ? "Trending down"
		:	"About the same as before"

	const recent = grades.slice(0, 5)

	return (
		<div className="csk-form">
			<div className="csk-form__standing">
				<div className="csk-form__avg">
					<span className="csk-form__avg-label">Recent form</span>
					<span className="csk-form__avg-value">
						{avg === null ? "—" : avg}
						{deltaPct !== null && deltaPct !== 0 && (
							<em className={deltaPct > 0 ? "up" : "down"}>
								{deltaPct > 0 ? "+" : ""}
								{deltaPct}%
							</em>
						)}
					</span>
					<span className="csk-form__verdict">{verdict}</span>
					<span
						className="csk-form__avg-note"
						title="Each game is scored 0-100 against your OWN recent games, not against other players — this app has no data about anyone else. 50 is an ordinary game for you."
					>
						{avg === null ?
							"needs at least 3 graded games"
						:	`average of your last ${grades.length} games, scored against yourself`}
					</span>
				</div>

				{recent.length > 0 && (
					<div className="csk-form__recent">
						<span className="csk-form__recent-label">Last {recent.length}</span>
						<div className="csk-form__chips">
							{/*
							 * Five rank letters, newest first. This replaced a sparkline of the last
							 * twenty grades: the line looked informative and said only "you
							 * fluctuate", which is true of everyone and actionable for no one.
							 */}
							{recent.map(g => (
								<span
									key={g.gameId}
									className={`csk-form__chip r-${g.rank.replace("+", "p").toLowerCase()}`}
									title={`${g.rank} · ${g.score}/100`}
								>
									{g.rank}
								</span>
							))}
						</div>
					</div>
				)}
			</div>

			{focus.length > 0 && (
				<div className="csk-form__focus">
					<div className="section-title">
						Work on this <span className="rule" />
						<span className="faint" style={{ textTransform: "none", letterSpacing: 0 }}>
							from your last {form.windowGames} reviewed games
						</span>
					</div>
					<ol className="csk-focus-list">
						{focus.map((f, i) => (
							<li key={f.category}>
								<div className="csk-focus__head">
									<span className="csk-focus__n">{i + 1}</span>
									<strong>{CATEGORY_LABEL[f.category] ?? f.category}</strong>
									{/* The sample size is the claim's evidence, so it is never hidden. */}
									<span className="csk-focus__count">
										{f.games} game{f.games === 1 ? "" : "s"}
										{f.occurrences > f.games ? ` · ${f.occurrences} items` : ""}
									</span>
								</div>
								<ul className="csk-focus__fixes">
									{f.fixes.slice(0, 2).map(fix => (
										<li key={fix}>{fix}</li>
									))}
								</ul>
								{f.exemplar.gameId !== null && (
									<a className="csk-focus__link" href={href.game(f.exemplar.gameId)}>
										{f.exemplar.title}
									</a>
								)}
							</li>
						))}
					</ol>
				</div>
			)}
		</div>
	)
}
