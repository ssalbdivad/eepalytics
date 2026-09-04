/**
 * One collapsible layer of detail.
 *
 * ## Why a single component rather than each panel doing its own thing
 *
 * The app has two readers with opposite needs. Someone new is overwhelmed by six panels of
 * numbers and needs one thing to try. Someone experienced finds a summary useless and wants the
 * frame data. A mode switch would serve one of them badly at all times and force a decision
 * before either has seen anything.
 *
 * Layers solve it without a switch: the top of the screen is the summary, everything else is
 * behind a labelled expander, and the reader chooses their own depth as they go. For that to
 * work the expanders have to look and behave identically everywhere — a page where some
 * sections are open, some are `<details>`, and some are custom toggles reads as chaos, which is
 * the exact feeling this is meant to prevent.
 *
 * ## Why the summary line carries a count
 *
 * "Metrics" is a mystery box. "Metrics · 37" tells you whether opening it is worth it. Knowing
 * the size of a thing before you open it is most of what makes an interface feel calm.
 */

import type { ReactNode } from "react"
import "./components.css"

export interface DrillProps {
	title: string
	/** Shown next to the title: how much is inside. */
	count?: number | string
	/** One line explaining what is in here, for someone who does not already know. */
	hint?: string
	/** Open on first render. Use sparingly — the default should be closed. */
	defaultOpen?: boolean
	/** Dimmer, for the deepest layer. */
	quiet?: boolean
	children: ReactNode
}

export const Drill = ({
	title,
	count,
	hint,
	defaultOpen = false,
	quiet = false,
	children
}: DrillProps) => (
	<details className={`csk-drill ${quiet ? "csk-drill--quiet" : ""}`} open={defaultOpen}>
		<summary>
			<span className="csk-drill__title">{title}</span>
			{count !== undefined && count !== 0 && <span className="csk-drill__count">{count}</span>}
			{hint ? <span className="csk-drill__hint">{hint}</span> : null}
		</summary>
		<div className="csk-drill__body">{children}</div>
	</details>
)
