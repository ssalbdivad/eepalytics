/**
 * The three states every surface in this app has, drawn one way each.
 *
 * A screen that reads from the daemon is always in one of exactly three non-happy states, and
 * before this they were drawn about eight ways between them: a bare `<div className="dim">no
 * screenshots yet</div>` on one panel, a centred `.empty` block on another, a red `.notice bad`
 * for a thing that was merely absent, and four different skeleton heights typed inline. The
 * shape should say which state it is before a word of it is read, so:
 *
 *   <Loading>  a shimmer the SIZE AND SHAPE of what is coming. Never a spinner — a spinner says
 *              "wait" without saying what for, and every wait in this app has a name.
 *   <Blank>    quiet and centred. It always says WHY there is nothing and what would put
 *              something there; "no data" on its own is indistinguishable from a bug.
 *   <Broken>   left-aligned and red-edged, and it prints what actually failed. The daemon being
 *              unreachable is the single most common failure here and it is recoverable, so the
 *              retry lives in the block rather than somewhere else on the page.
 *
 * These are presentation only. Nothing here fetches, retries on its own, or decides which state
 * a page is in — the page owns that, because the page is the thing that knows.
 */

import type { ReactNode } from "react"

export interface LoadingProps {
	/** How many shimmer rows. Match the shape of the real content. */
	rows?: number
	/** Height of each row in px. */
	height?: number
	/** Announced to screen readers; sighted users get the shape. */
	label?: string
}

export const Loading = ({ rows = 3, height = 78, label = "Loading" }: LoadingProps) => (
	<div className="skeleton-stack" role="status" aria-busy="true" aria-label={label}>
		{Array.from({ length: rows }, (_, i) => (
			<div className="skeleton" key={i} style={{ height }} />
		))}
	</div>
)

export interface BlankProps {
	/** What is not here. A noun phrase, not an apology. */
	title: string
	/** Why it is not here, and what would make it appear. */
	children?: ReactNode
	/** The way out. Usually one button or link. */
	actions?: ReactNode
	/** Inside a panel that already has a heading, so left-aligned and less padded. */
	inline?: boolean
}

export const Blank = ({ title, children, actions, inline = false }: BlankProps) => (
	<div className={`state state--empty${inline ? " state--inline" : ""}`}>
		<div className="state__title">{title}</div>
		{children ? <div className="state__why">{children}</div> : null}
		{actions ? <div className="state__do">{actions}</div> : null}
	</div>
)

export interface BrokenProps {
	/** What failed, in the user's terms — "Can't read the queue", not "500".  */
	title: string
	/** The message from the API. Shown inline; it is usually one sentence. */
	message?: string | null
	/** The stack or body, if there is one. Shown in a scrollable `pre`. */
	detail?: string | null
	actions?: ReactNode
}

export const Broken = ({ title, message, detail, actions }: BrokenProps) => (
	<div className="notice bad" role="alert">
		<span className="icon">✗</span>
		<div>
			<strong>{title}</strong>
			{message ? ` ${message}` : ""}
			{detail ? <pre>{detail}</pre> : null}
			{actions ? <div className="state__do">{actions}</div> : null}
		</div>
	</div>
)
