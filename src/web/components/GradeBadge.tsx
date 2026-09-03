/**
 * The rank badge: S+ down to E, with the score behind it.
 *
 * ## The label matters more than the badge
 *
 * A bare 0-100 next to a game reads like a leaderboard score — something comparing him to other
 * players. It is not, and cannot be: this app has no data about anyone else. It compares the
 * game to HIS OWN recent form, so 50 means "an ordinary game for you" and the tooltip says so
 * every time. Getting that wrong would make the most eye-catching number on the screen the most
 * misleading one.
 *
 * Ungraded is a real state, not an error: under five games of history a grade is noise wearing a
 * number, so it renders as a quiet dash rather than a zero.
 */

import "./components.css"

export interface GradeBadgeProps {
	score: number | null | undefined
	rank: string | null | undefined
	size?: "sm" | "md" | "lg"
	/** Extra context for the tooltip, e.g. how many games the baseline covers. */
	baselineGames?: number
}

const TIER: Record<string, string> = {
	"S+": "sp",
	S: "s",
	A: "a",
	B: "b",
	C: "c",
	D: "d",
	E: "e"
}

export const GradeBadge = ({ score, rank, size = "md", baselineGames }: GradeBadgeProps) => {
	if (score === null || score === undefined || !rank)
		return (
			<span
				className={`csk-grade csk-grade--none csk-grade--${size}`}
				title="Not graded yet — grading needs at least 5 earlier games to compare against, and a grade built on less than that is noise."
			>
				—
			</span>
		)

	const against =
		baselineGames === undefined ? "your recent form" : `your last ${baselineGames} games`

	return (
		<span
			className={`csk-grade csk-grade--${TIER[rank] ?? "c"} csk-grade--${size}`}
			title={`${score}/100 against ${against}. This compares you to YOURSELF, not to other players — 50 is an ordinary game for you. Confounded stats (the ones that mostly just reflect winning) are excluded.`}
		>
			<span className="csk-grade__rank">{rank}</span>
			<span className="csk-grade__score">{score}</span>
		</span>
	)
}
