/**
 * One place to answer "has this game been watched?"
 *
 * The visual pass (`review/watch.ts`) reads real frames of a moment and coaches EXECUTION —
 * ability usage, kiting, fight entry — which exists in no data stream this app can read. It is
 * the one piece of coaching the timeline cannot support.
 *
 * ITS ONLY SOURCE OF FRAMES WAS REPLAY CAPTURE, WHICH HAS BEEN REMOVED. Capture never completed
 * a single job in the app's history, so `frameMoments` is zero on every game and stays zero: in
 * practice this panel now always renders the "nothing to watch" state. It is kept, and kept
 * honest, because the pass itself still works — it needs pointing at the screen-share journal
 * (`daemon/journal.ts`), which already stores real frames of his own screen stamped with the
 * game clock. Until that wiring exists, saying so plainly beats offering a button that queues
 * something nothing will run.
 */

import type { Game } from "../../shared/schema/domain.ts"

export interface WatchGamePanelProps {
	game: Game
	/** Moments with real frames, and moments already watched. */
	frameMoments: number
	watchedMoments: number
	/** Moments worth watching at all. */
	momentCount: number
}

export const WatchGamePanel = ({
	frameMoments,
	watchedMoments,
	momentCount
}: WatchGamePanelProps) => {
	/* ---- state 3: watched ---- */
	if (watchedMoments > 0)
		return (
			<div className="csk-watchpanel csk-watchpanel--done">
				<div>
					<strong>👁 Watched — {watchedMoments} moment{watchedMoments === 1 ? "" : "s"}</strong>
					<p>
						The coach read real frames for {watchedMoments} of this game's {momentCount}{" "}
						moments and commented on execution. Those notes are marked in teal on the items
						below. Anything unmarked is from the game's data only.
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

	/* ---- state 2: frames on disk, nothing watched ---- */
	if (frameMoments > 0)
		return (
			<div className="csk-watchpanel csk-watchpanel--ready">
				<div>
					<strong>Frames ready — nothing watched yet</strong>
					<p>
						{frameMoments} moment{frameMoments === 1 ? " has" : "s have"} real frames on disk.
						Use <b>👁 Watch this moment</b> on any item below to have the coach look at them
						and coach your ability usage, kiting and fight entry — none of which is in the
						game's data.
					</p>
				</div>
			</div>
		)

	/* ---- state 1: no frames, and none are coming ---- */
	return (
		<div className="csk-watchpanel">
			<div>
				<strong>This game hasn't been watched</strong>
				<p>
					Everything below came from the timeline: positions once a minute, kills, objectives,
					end-of-game totals. Nothing here is about <b>how you used abilities</b>, how you
					kited or how you entered fights — that information exists nowhere in the data the
					client hands over.
				</p>
			</div>
			<div className="csk-watchpanel__blocked">
				There is no way to get it for a past game right now. The old route was replay capture,
				which took over your League client to record the replay; it never once finished a job
				and it has been removed. The live coach watching your screen share is what sees your
				actual play today.
			</div>
		</div>
	)
}
