/**
 * THE HABIT CARD — one behaviour, game over game, and nothing else on it.
 *
 * ## Why this screen exists and what it refuses to be
 *
 * Everything else this app shows him is either a line a model wrote or a table of numbers chosen
 * because they were computable. `data/eval/what-wins-20260918.json` asked which of those numbers
 * actually separate the games he WINS from the games he loses, on 138 of his own ranked games,
 * and most of them do not: CS at 10 is AUC 0.56 [0.46-0.66], the race against the enemy jungler
 * at 10:00 is 0.55, vision is flat, and dying in the enemy jungle by 15:00 — the play the shipped
 * review prompt tells the coach to name every single time — is an 11%-prevalence null.
 *
 * So this card shows ONE of the two things that did separate, and it shows it as a record rather
 * than as advice. There is no model in it, no prose generated per game, and no ranking: a streak,
 * a rate with its interval, and a plain sentence about whether the rate is moving. He is the one
 * who decides what to do about it.
 *
 * ## The two rules it is built on
 *
 *   - **It never claims a change it cannot see.** The only direction it will draw is one where
 *     two Wilson intervals fail to overlap, which is a conservative test, and every other case
 *     says "not distinguishable from noise" in those words.
 *   - **It never lets the arithmetic read as a promise.** The win rates beside the habit are
 *     observational on one player who cannot be randomised into surviving minute twelve. That
 *     sentence is on the card, not in a tooltip.
 *
 * ## Two variants, one component
 *
 * `pregame` is what he sees between games and in champion select: the goal, the streak, one line.
 * `full` is the record — every game in the window, the evidence that put this habit on screen,
 * and the switch to the other one. The switch lives behind a disclosure because the default is an
 * evidence decision and should not read as a question he has to answer.
 */

import { Component, useCallback, useEffect, useState } from "react"
import type { ErrorInfo, ReactNode } from "react"
import type { HabitResponse } from "../../shared/schema/api.ts"
import {
	evidenceSentence,
	HABITS,
	HABIT_LIMIT,
	habitDef,
	MIN_GAMES_FOR_RATE
} from "../../analysis/habit.ts"
import { api } from "../lib/api.ts"
import { errorMessage } from "../lib/api.ts"
import "./habit.css"

/**
 * Which habit he is tracking, remembered in the browser.
 *
 * Deliberately NOT a server setting: it is a preference about what he is looking at this week,
 * the settings screen is already too long, and a preference that survives a reload is all this
 * needs to be. The default is the evidence's default, not the last thing he clicked.
 */
const STORE_KEY = "eepalytics.habit"

const readStored = (): string => {
	try {
		return localStorage.getItem(STORE_KEY) ?? HABITS[0]!.key
	} catch {
		return HABITS[0]!.key
	}
}

const pct = (x: number): string => `${Math.round(x * 100)}%`

const dayOf = (ms: number): string =>
	new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })

export interface HabitCardProps {
	variant?: "pregame" | "full"
	size?: "compact" | "wide"
	/** How many games back. The card's own default is two evenings' worth. */
	games?: number
	/** Bumped by the app when the daemon says something changed, so a finished game lands here. */
	eventTick?: number
}

const HabitCardBody = ({
	variant = "full",
	size = "wide",
	games = 20,
	eventTick = 0
}: HabitCardProps) => {
	const [key, setKey] = useState<string>(readStored)
	const [data, setData] = useState<HabitResponse | null>(null)
	/**
	 * Set once the load has failed with nothing to show. The card then renders NOTHING.
	 *
	 * This is the honest unavailable state for this particular surface. It sits on the screen the
	 * coach lives on, and the most likely reason it cannot load is that the daemon predates the
	 * route — a card about last week's games has no business putting an error banner over a game
	 * that is about to start. The Live page already says when the daemon is unreachable; this
	 * does not need to say it a second time.
	 */
	const [gone, setGone] = useState(false)

	useEffect(() => {
		const ac = new AbortController()
		let live = true
		api.habit(key, games, ac.signal).then(
			next => {
				if (!live) return
				setData(next)
				setGone(false)
			},
			e => {
				if (!live || ac.signal.aborted) return
				// Keep the last good record on screen if there is one: a card that blanks on a
				// dropped poll is worse than a card that is a few seconds stale.
				console.warn("eepalytics: habit card could not load —", errorMessage(e))
				setGone(true)
			}
		)
		return () => {
			live = false
			ac.abort()
		}
	}, [key, games, eventTick])

	const choose = useCallback((next: string) => {
		setKey(next)
		try {
			localStorage.setItem(STORE_KEY, next)
		} catch {
			/* private window, or storage disabled — the choice just does not survive a reload */
		}
	}, [])

	const def = habitDef(data?.key ?? key)

	if (!data && gone) return null

	if (!data)
		return (
			<div className={`habit habit--${variant}`}>
				<div className="habit__eyebrow">What we're tracking</div>
				<div className="habit__goal">{def.goal}</div>
				<div className="habit__note">counting your games…</div>
			</div>
		)

	/*
	 * Oldest LEFT, newest RIGHT. A record is read as a timeline, and the newest game is the one
	 * he just played — so it is the one the eye should land on last and the one that is marked.
	 */
	const strip = [...data.games].reverse()
	const enough = data.counted >= MIN_GAMES_FOR_RATE

	return (
		<div className={`habit habit--${variant} habit--${size}`}>
			<div className="habit__eyebrow">What we're tracking</div>
			<div className="habit__goal">{def.goal}</div>

			<div className="habit__strip" role="list">
				{strip.map((g, i) => (
					<span
						key={g.gameId}
						role="listitem"
						className={
							"habit__chip" +
							(g.clean === null ? " habit__chip--none"
							: g.clean ? " habit__chip--clean"
							: " habit__chip--dirty") +
							(i === strip.length - 1 ? " habit__chip--newest" : "")
						}
						title={
							`${dayOf(g.createdMs)} · ${g.championName} · ${g.win ? "win" : "loss"}` +
							(g.clean === null ?
								` · not counted: ${g.excluded ?? "no answer"}`
							:	` · ${g.value} ${def.label}`)
						}
					>
						{g.clean === null ? "·" : g.clean ? "✓" : "✕"}
					</span>
				))}
			</div>

			<div className="habit__headline">
				{data.streak > 0 ?
					<strong>
						{data.streak} {def.cleanLabel} in a row
					</strong>
				:	<strong>
						{data.rate.k} {def.cleanLabel} in {data.rate.n}
					</strong>
				}
				{enough && (
					<span className="habit__rate">
						{pct(data.rate.p)} <em>[{pct(data.rate.lo)}–{pct(data.rate.hi)}]</em>
					</span>
				)}
			</div>

			<div className="habit__note">{data.verdict}</div>

			{variant === "full" && (
				<>
					<div className="habit__base">
						His own rate across the {data.baseRate.n} measured games is{" "}
						{pct(data.baseRate.p)} [{pct(data.baseRate.lo)}–{pct(data.baseRate.hi)}]. The
						window above is part of that history, so the two are not compared — it is a
						line to read against, not a test.
					</div>

					<details className="habit__more">
						<summary>Why this one, and what it is worth</summary>
						<p className="habit__why">{def.why}</p>
						<p className="habit__evidence">{evidenceSentence(def)}</p>
						<p className="habit__caveat">{def.evidence.caveat}</p>
						<p className="habit__limit">{HABIT_LIMIT}</p>
						<p className="habit__source">
							Counted off your stored timelines. Measurement:{" "}
							<code>{def.evidence.source}</code>. No model is involved on this card.
						</p>

						<div className="habit__switch">
							<span>Track instead:</span>
							{HABITS.map(h => (
								<button
									key={h.key}
									className={h.key === def.key ? "active" : ""}
									onClick={() => choose(h.key)}
									title={h.why}
								>
									{h.goal}
								</button>
							))}
						</div>
					</details>
				</>
			)}
		</div>
	)
}

/* ================================================================== the guard */

/**
 * Its own error boundary, and this is not belt-and-braces.
 *
 * This card renders INSIDE `<Live>`, which owns `<ScreenCoach>`, which owns the `MediaStream` and
 * the Gemini socket. React unmounts the whole subtree a thrown render belongs to, so a crash here
 * — a shape this build does not expect, a browser without `color-mix`, anything — would take the
 * screen share and the coach down with it, mid-game, for a card about last week's games. The
 * app-level boundary in `App.tsx` catches it, and catching it THERE is exactly the failure: the
 * coach is already gone by then.
 *
 * So the habit card is allowed to fail alone, and when it does it says so where it was.
 */
interface GuardState {
	failed: boolean
}

class HabitGuard extends Component<HabitCardProps, GuardState> {
	state: GuardState = { failed: false }

	static getDerivedStateFromError(): GuardState {
		return { failed: true }
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("eepalytics: the habit card failed", error, info.componentStack)
	}

	render(): ReactNode {
		if (this.state.failed)
			return (
				<div className="habit habit--failed">
					<div className="habit__eyebrow">What we're tracking</div>
					<div className="habit__note">
						This card failed to render — everything else on this screen is unaffected.
					</div>
				</div>
			)
		return <HabitCardBody {...this.props} />
	}
}

export const HabitCard = (props: HabitCardProps) => <HabitGuard {...props} />
