/**
 * One place to answer "has this game been watched, and how do I watch it?"
 *
 * The visual pass needs replay frames, frames need a capture, and a capture takes over the
 * League client. That is three steps with three different failure modes, and previously none of
 * them were visible — the only way to discover the feature was to already know it existed.
 *
 * So this panel is always present on a review and always states which of the three states the
 * game is in, what the next action is, and what is currently blocking it. The blocking reason
 * comes from the daemon's own gate, verbatim, rather than being guessed at here.
 */

import { useState } from "react"
import type { HealthResponse } from "../../shared/schema/api.ts"
import type { Game } from "../../shared/schema/domain.ts"
import { api, errorMessage } from "../lib/api.ts"

export interface WatchGamePanelProps {
	game: Game
	health: HealthResponse | null
	/** Moments with real frames, and moments already watched. */
	frameMoments: number
	watchedMoments: number
	/** Moments worth watching at all. */
	momentCount: number
	onChanged: () => void
}

export const WatchGamePanel = ({
	game,
	health,
	frameMoments,
	watchedMoments,
	momentCount,
	onChanged
}: WatchGamePanelProps) => {
	const [busy, setBusy] = useState(false)
	const [msg, setMsg] = useState<string | null>(null)
	const [err, setErr] = useState<string | null>(null)

	const gate = health?.capture
	const replayGone = game.replayState === "expired" || game.replayState === "pruned"

	const capture = async () => {
		setBusy(true)
		setErr(null)
		setMsg(null)
		try {
			await api.requestCapture(game.gameId)
			setMsg(
				"Capture queued. It waits for the League client to be idle for 2 minutes, then takes it over for a few minutes. It expires in 15 minutes if the client never goes idle."
			)
			onChanged()
		} catch (e) {
			setErr(errorMessage(e))
		} finally {
			setBusy(false)
		}
	}

	/* ---- state 3: watched ---- */
	if (watchedMoments > 0)
		return (
			<div className="csk-watchpanel csk-watchpanel--done">
				<div>
					<strong>👁 Watched — {watchedMoments} moment{watchedMoments === 1 ? "" : "s"}</strong>
					<p>
						The coach read real replay frames for {watchedMoments} of this game's{" "}
						{momentCount} moments and commented on execution. Those notes are marked in teal
						on the items below. Anything unmarked is from the game's data only.
					</p>
				</div>
				{frameMoments > watchedMoments && (
					<p className="csk-watchpanel__more">
						{frameMoments - watchedMoments} more moment
						{frameMoments - watchedMoments === 1 ? " has" : "s have"} frames ready — hit Watch
						on any of them.
					</p>
				)}
			</div>
		)

	/* ---- state 2: frames captured, nothing watched ---- */
	if (frameMoments > 0)
		return (
			<div className="csk-watchpanel csk-watchpanel--ready">
				<div>
					<strong>Frames ready — nothing watched yet</strong>
					<p>
						{frameMoments} moment{frameMoments === 1 ? " has" : "s have"} real replay frames
						captured. Use <b>👁 Watch this moment</b> on any item below to have the coach
						look at them and coach your ability usage, kiting and fight entry — none of
						which is in the game's data.
					</p>
				</div>
			</div>
		)

	/* ---- state 1: nothing captured ---- */
	return (
		<div className="csk-watchpanel">
			<div>
				<strong>This game hasn't been watched</strong>
				<p>
					Everything below came from the timeline: positions once a minute, kills, objectives,
					end-of-game totals. To get feedback on <b>how you used abilities</b>, how you kited
					and how you entered fights, the coach has to look at the replay — that information
					exists nowhere else.
				</p>
			</div>

			{replayGone ?
				<div className="csk-watchpanel__blocked">
					The replay for this game is {game.replayState}. Riot stops serving a{" "}
					<code>.rofl</code> about 30 minutes after a game ends, so this one can never be
					watched. Newer games still can.
				</div>
			:	<>
					<button className="btn btn-primary" onClick={() => void capture()} disabled={busy}>
						{busy ? "Queueing…" : "Capture replay frames"}
					</button>
					<div className="csk-watchpanel__note">
						{/* The gate's own words, not a guess made here. */}
						{gate?.allowed ?
							"The client is idle — this will start shortly and take it over for a few minutes."
						:	`Currently blocked: ${gate?.reason ?? "checking…"}`}
					</div>
				</>
			}

			{msg !== null && <div className="csk-watchpanel__ok">{msg}</div>}
			{err !== null && <div className="csk-watchpanel__err">{err}</div>}
		</div>
	)
}
