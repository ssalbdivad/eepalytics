/**
 * One place to answer "has this game been watched, and how do I watch it?"
 *
 * The visual pass needs frames, and frames come from the FRAME JOURNAL — the screenshots the
 * browser posts while the player screen-shares. There is no button here any more, and that is
 * the whole point of the change: this panel used to offer "Capture replay frames", which queued
 * an intrusive job that took over the League client and, across the app's entire recorded
 * history, produced zero frames. The journal produces them as a side effect of playing with the
 * live coach open, so the only honest thing this panel can say in the empty state is *why* it is
 * empty.
 *
 * It is always present on a review and always states which of the three states the game is in.
 */

export interface WatchGamePanelProps {
	/** Moments with real frames, and moments already watched. */
	frameMoments: number
	watchedMoments: number
	/** Moments worth watching at all. */
	momentCount: number
}

export const WatchGamePanel = ({ frameMoments, watchedMoments, momentCount }: WatchGamePanelProps) => {
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

	/* ---- state 2: frames journalled, nothing watched ---- */
	if (frameMoments > 0)
		return (
			<div className="csk-watchpanel csk-watchpanel--ready">
				<div>
					<strong>Frames ready — nothing watched yet</strong>
					<p>
						{frameMoments} moment{frameMoments === 1 ? " has" : "s have"} real frames from
						your screen share. Use <b>👁 Watch this moment</b> on any item below to have the
						coach look at them and coach your ability usage, kiting and fight entry — none of
						which is in the game's data.
					</p>
				</div>
			</div>
		)

	/* ---- state 1: no frames ---- */
	return (
		<div className="csk-watchpanel">
			<div>
				<strong>This game hasn't been watched</strong>
				<p>
					Everything below came from the timeline: positions once a minute, kills, objectives,
					end-of-game totals. Feedback on <b>how you used abilities</b>, how you kited and how
					you entered fights needs pictures, and the only source of those is the frame journal
					— the screenshots the live coach saves while you share your screen. Play the next
					game with the coach open and this game's successor will have them.
				</p>
			</div>
		</div>
	)
}
