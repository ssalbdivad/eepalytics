/**
 * Professor Lillia says a thing.
 *
 * ## Why the coach needs a face
 *
 * A grade and a list of failures presented as a dashboard reads as a verdict. The same content
 * coming from a character reads as someone helping. That difference matters most for the reader
 * who already knows they are playing badly and is braced to be told so — the app's job there is
 * to be the least frightening way to find out what to do next.
 *
 * ## Tone is a prop because it is a decision, not a style
 *
 * `warm` opens a review. `nudge` carries the one thing to work on. `cheer` is for something that
 * genuinely went well. `note` is quiet and factual for the places a face would be noise. Passing
 * the tone explicitly keeps callers from reaching for the loudest one by default.
 *
 * The puns are Lillia's own vocabulary — sleep, dreams, pollen, prancing, the Bough. They are
 * chosen per tone rather than at random so a serious note never opens on a joke.
 */

import type { ReactNode } from "react"
import "./components.css"

export type BubbleTone = "warm" | "nudge" | "cheer" | "note"

export interface CoachBubbleProps {
	tone?: BubbleTone
	/** Small line above the message — usually the pun. Omit for `note`. */
	kicker?: string
	children: ReactNode
	/** Bigger, for the top of a page. */
	size?: "sm" | "md" | "lg"
}

/**
 * Openers, by tone. Deterministic per call site rather than random: an app that greets you
 * differently every refresh feels unstable, and the joke stops landing on the third reload.
 */
export const LILLIA_KICKERS: Record<BubbleTone, string[]> = {
	warm: [
		"Bough down, let's have a look",
		"Sweet dreams — now let's talk about that game",
		"Don't sleep on this one"
	],
	nudge: ["One thing to try", "Here's your seedling", "Eep! Just one thing"],
	cheer: ["Blooming lovely", "Now that's worth prancing about", "Dream come true"],
	note: []
}

/** Stable choice from a string, so the same context always gets the same opener. */
export const kickerFor = (tone: BubbleTone, seed: string): string => {
	const options = LILLIA_KICKERS[tone]
	if (options.length === 0) return ""
	let hash = 0
	for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
	return options[hash % options.length]!
}

export const CoachBubble = ({ tone = "warm", kicker, children, size = "md" }: CoachBubbleProps) => (
	<div className={`csk-bubble csk-bubble--${tone} csk-bubble--${size}`}>
		<img
			className="csk-bubble__face"
			src="/icon.svg"
			alt="Professor Lillia"
			width={size === "lg" ? 56 : size === "sm" ? 30 : 42}
			height={size === "lg" ? 56 : size === "sm" ? 30 : 42}
		/>
		<div className="csk-bubble__speech">
			{kicker ? <div className="csk-bubble__kicker">{kicker}</div> : null}
			<div className="csk-bubble__body">{children}</div>
		</div>
	</div>
)
