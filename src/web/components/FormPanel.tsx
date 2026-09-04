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
import { CoachBubble, kickerFor } from "./CoachBubble.tsx"
import type { BubbleTone } from "./CoachBubble.tsx"
import { Drill } from "./Drill.tsx"
import { Glossed } from "./Term.tsx"
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

/**
 * The one thing to work on, said once, by Lillia.
 *
 * This is layer 0 of the Games screen. It deliberately does NOT lead with the grade or the
 * trend: the reader most in need of this already knows he is losing, and opening on a graded
 * curve is how an app becomes something you avoid. Every number here is one the API already
 * returned — nothing new is computed to fill the bubble.
 */
export const FormHeadline = ({ form }: FormPanelProps) => {
	if (!form) return null
	const top = form.focus[0]
	const tone: BubbleTone =
		top && top.games >= 2 ? "nudge"
		: top ? "note"
		: form.rollingAverage === null ? "warm"
		: "cheer"

	const body =
		top && top.games >= 2 ?
			`The thing that keeps coming up is ${CATEGORY_LABEL[top.category] ?? top.category} — it showed up in ${top.games} of your last ${form.windowGames} reviewed games. Next game: ${top.fixes[0] ?? ""}`
		: top ?
			`One game had a ${CATEGORY_LABEL[top.category] ?? top.category} note in it. One game, so not a pattern yet. ${top.fixes[0] ?? ""}`
		: form.rollingAverage === null ?
			`${form.grades.length} games in. I need a few more before I can tell what's a habit and what was just a Tuesday. Pick one and let's look at it.`
		:	`Nothing's repeating across your last ${form.windowGames} reviewed games. Pick the one that felt worst and we'll go through it.`

	return (
		<CoachBubble tone={tone} size="lg" kicker={kickerFor(tone, "gamelist")}>
			<Glossed>{body}</Glossed>
		</CoachBubble>
	)
}

/**
 * The numbers, one deliberate click down.
 *
 * Nothing is deleted or softened — "Trending down" still says trending down. It simply is not
 * the first thing on the screen.
 */
export const FormPanel = ({ form }: FormPanelProps) => {
	if (!form) return null

	const { rollingAverage: avg, previousAverage: prev, grades, focus } = form
	const deltaPct =
		avg !== null && prev !== null && prev > 0 ? Math.round(((avg - prev) / prev) * 100) : null
	const verdict =
		avg === null ? "Not enough games yet"
		: deltaPct === null ? "Your baseline for these games"
		: deltaPct >= 5 ? "Trending up"
		: deltaPct <= -5 ? "Trending down"
		:	"About the same as before"
	const recent = grades.slice(0, 5)

	return (
		<>
			<Drill title="Your form" count={grades.length} hint="scored against your own average">
				<div className="csk-form__standing">
					<div className="csk-form__avg">
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
			</Drill>

			{focus.length > 0 && (
				<Drill
					title="Work on this"
					count={focus.length}
					hint={`from your last ${form.windowGames} reviewed games`}
				>
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
										<li key={fix}>
											<Glossed>{fix}</Glossed>
										</li>
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
				</Drill>
			)}
		</>
	)
}
