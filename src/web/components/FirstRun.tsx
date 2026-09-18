/**
 * WHAT SOMEONE SEES BEFORE ANY OF THIS HAS EVER WORKED.
 *
 * Before this existed the first launch was: a status bar, the words "Not in a game", and — below
 * a list of things to work on that is empty because there is nothing to work on yet — the coach
 * panel with the button that actually starts everything. Every screen in the app answered "what
 * is in the database", and on a first run the answer to that is an empty table, which looks
 * exactly like a broken one.
 *
 * So this card says the two things a person needs in the first five seconds — what the app IS,
 * and which of three steps is outstanding — and then gets out of the way permanently. It is
 * shown only while `readiness().firstRun` is true, which is a POSITIVE reading (a games list was
 * fetched and no game in it was coached), never an absence of data. A returning user never sees
 * it, including on a cold load with every fetch still in flight.
 *
 * It deliberately carries NO controls. The share button and the key box are fifty pixels below
 * it in `<ScreenCoach>`, which owns the `MediaStream`, the WSL hand-off and the key round trip;
 * a second copy of either here would be a second thing to keep in step and a second thing to get
 * wrong. This card explains and points. The panel does.
 */

import { useEffect, useState } from "react"
import type { GameListItem } from "../../shared/schema/api.ts"
import { api } from "../lib/api.ts"
import { useGameflow } from "../lib/gameflow.ts"
import { useResource } from "../lib/hooks.ts"
import { readiness } from "../lib/readiness.ts"
import type { ReadyStep } from "../lib/readiness.ts"

/** Enough rows to answer "has ANY game been coached" without pulling the whole library. */
const LOOKBACK = 20

const MARK: Record<ReadyStep["state"], string> = {
	done: "✓",
	todo: "•",
	unknown: "…"
}

export interface FirstRunProps {
	/** Compact is the 380px popout: the same steps, no prose around them. */
	compact?: boolean
}

export const FirstRun = ({ compact = false }: FirstRunProps) => {
	const gate = useGameflow()
	/*
	 * Once, not on a poll. This card is about whether a thing has EVER happened, and the answer
	 * changes at most once in the life of the install — at which point the game that changed it
	 * arrives through the same event tick that re-renders everything else on this screen.
	 */
	const games = useResource<GameListItem[]>(
		async signal => (await api.games(LOOKBACK, signal)).games,
		[]
	)
	const [voice, setVoice] = useState<{ configured?: boolean; ok: boolean } | null>(null)

	useEffect(() => {
		let alive = true
		void fetch("/api/live/gemini/status")
			.then(r => r.json() as Promise<{ ok: boolean; configured?: boolean }>)
			.then(j => {
				if (alive) setVoice(j)
			})
			// A failed status read leaves the step UNKNOWN rather than claiming a missing key.
			// Telling someone to set up a key he has already set up is how a working app gets
			// turned off and reinstalled.
			.catch(() => {})
		return () => {
			alive = false
		}
	}, [])

	const ready = readiness({
		/*
		 * `reachable` is about the DAEMON, `phase` about the client, and the step is about the
		 * client — so a daemon that has not answered yet leaves this UNKNOWN rather than reporting
		 * a closed client we have not actually looked at.
		 */
		clientReachable: !gate.reachable ? null : gate.phase !== null,
		games: games.data,
		voice
	})

	if (!ready.firstRun) return null

	return (
		<div className={`firstrun${compact ? " firstrun--compact" : ""}`}>
			{/*
			 * NOT a second hero. The coach panel directly above this already says who she is and
			 * carries the button, so what is left for this card is the half that panel cannot see:
			 * what happens AFTER the game, and which of the three steps is outstanding.
			 */}
			<div className="firstrun__head">
				<strong>Your first game with her</strong>
				{!compact && (
					<p>
						During the game she speaks about eight times. After it, the game is graded against
						your own last twenty — timestamped moments with a drawn map, and your own screen from
						the second it happened. Across games, Trends tracks the two things that actually
						separate your wins.
					</p>
				)}
			</div>

			<ol className="firstrun__steps">
				{ready.steps.map((s, i) => (
					<li key={s.id} className={`firstrun__step is-${s.state}`}>
						<span className="firstrun__mark" aria-hidden="true">
							{MARK[s.state]}
						</span>
						<div>
							<b>
								{i + 1}. {s.title}
							</b>
							<span>{s.detail}</span>
						</div>
					</li>
				))}
			</ol>

			{/*
			 * The sentence that stops this reading as a fault. Two of these three steps are
			 * commonly already done on a first launch, and a checklist with ticks on it and no
			 * closing line reads as "something is wrong here" rather than "you have not played yet".
			 */}
			<div className="firstrun__foot">
				Nothing is broken — you just have not finished a game with her watching yet. The button
				below starts the share; she stays asleep until champion select.
			</div>
		</div>
	)
}
