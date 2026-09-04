/**
 * Says whether a review has actually LOOKED at the game, or only read its numbers.
 *
 * ## Why this needs to be loud
 *
 * The two kinds of review are not close substitutes and they are easy to confuse. A data review
 * knows where he was every 60 seconds, what died and what he ended with. It cannot know whether
 * an ability was wasted, whether a camp was kited or tanked, or what he had up in a fight —
 * none of that exists in any stream this app reads, because ability casts live only in the
 * replay's chunk payloads, which need the game engine to decode.
 *
 * So a review with no frames is genuinely partial, and presenting it as a finished verdict would
 * be the most misleading thing on the screen. The badge states which kind you are reading and the
 * tooltip explains the difference.
 *
 * EVERY REVIEW IS "data only" TODAY. Replay capture was the only thing that ever produced frames
 * and it has been removed, so the "no vision" state names that instead of offering an action that
 * no longer exists. The other two states are kept for when the visual pass is pointed at the
 * screen-share journal, which stores real frames already.
 */

import "./components.css"

export interface VisionBadgeProps {
	/** How many moments have a visual read. */
	watched: number
	/** How many moments have real frames available to watch. Zero on every game today. */
	watchable: number
	size?: "sm" | "md"
}

export const VisionBadge = ({ watched, watchable, size = "md" }: VisionBadgeProps) => {
	const state = watched > 0 ? "seen" : watchable > 0 ? "ready" : "none"

	const title =
		state === "seen" ?
			`This review includes a visual pass: the coach read real replay frames for ${watched} moment${watched === 1 ? "" : "s"} and commented on execution — ability use, kiting, fight entry. Those notes are marked "watched". Everything else came from the game's data.`
		: state === "ready" ?
			"Frames exist for this game but nothing has been watched yet. The visual pass is the only way to get feedback on ability usage and kiting — none of that is in the game's data."
		:	"DATA ONLY. This review is built from the timeline: positions once a minute, kills, objectives, end-of-game stats. It contains nothing about how you used abilities, how you kited, or how you entered fights — that information does not exist in any data the client exposes, and nothing produces frames for a past game right now."

	return (
		<span className={`csk-vision csk-vision--${state} csk-vision--${size}`} title={title}>
			{state === "seen" ?
				<>
					<span className="csk-vision__dot" /> watched · {watched}
				</>
			: state === "ready" ?
				<>
					<span className="csk-vision__dot" /> frames ready
				</>
			:	<>
					<span className="csk-vision__dot" /> data only — not watched
				</>
			}
		</span>
	)
}
