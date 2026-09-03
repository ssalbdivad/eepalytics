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
import { Sparkline } from "./Sparkline.tsx"
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
	const delta = avg !== null && prev !== null ? avg - prev : null
	// Newest-first from the API; the chart reads left-to-right in time.
	const series = [...grades].reverse().map(g => g.score)

	return (
		<div className="csk-form">
			<div className="csk-form__standing">
				<div className="csk-form__avg">
					<span className="csk-form__avg-label">Recent form</span>
					<span className="csk-form__avg-value">
						{avg === null ? "—" : avg}
						{delta !== null && delta !== 0 && (
							<em className={delta > 0 ? "up" : "down"}>
								{delta > 0 ? "▲" : "▼"} {Math.abs(delta)}
							</em>
						)}
					</span>
					<span className="csk-form__avg-note">
						{avg === null ?
							"needs at least 3 graded games"
						:	`mean of your last ${grades.length} games, scored against your own baseline`}
					</span>
				</div>
				{series.length >= 3 && (
					<div className="csk-form__spark">
						<Sparkline values={series} width={210} height={44} />
						<span className="faint">oldest → newest</span>
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
