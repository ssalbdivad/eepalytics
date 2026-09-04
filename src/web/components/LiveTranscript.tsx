/**
 * What the live coach actually said, after the fact.
 *
 * ## Why this is a screen and not a log file
 *
 * The first real session produced advice worth fixing — a champion who was not in the game, a
 * claim about ability usage that nothing in the data could support — and not one line of it
 * survived, because the coach runs in the browser and talks to Google directly. The daemon never
 * saw a word.
 *
 * So every line is now mirrored to the daemon *with the ground-truth block that produced it*, and
 * this is where you read them back. A line alone cannot be judged: "Graves is down 22s" is either
 * the best thing she said all game or something she invented, and the only thing that separates
 * those is what she was holding at the time. That is behind the disclosure on each row.
 *
 * ## Why it polls, and why a failed read is not an empty one
 *
 * This panel used to fetch exactly once — the first time it was expanded — and never again, because
 * the effect was guarded on `lines !== null`. The coach page is opened before the game and stays
 * open for the whole of it (unmounting it closes the socket), so the one fetch it ever made was
 * the one made before she had said anything. It cached that empty answer and went on reporting
 * "nothing recorded yet" over a file with a whole game in it. Collapsing and re-expanding did not
 * help; nothing invalidated the cache.
 *
 * Two changes, and they are the same lesson twice: read again while the panel is open, and never
 * render a read that FAILED as a transcript that is EMPTY. Those were the same sentence on screen,
 * which is precisely why this looked like a quiet coach rather than a broken panel. The choice
 * between the four states lives in `lib/transcriptView.ts` so it can be tested.
 */

import { useCallback, useEffect, useState } from "react"
import { transcriptView } from "../lib/transcriptView.ts"
import "./components.css"

interface Line {
	atMs: number
	text: string
	fromUser: boolean
	groundTruth?: string
}

/**
 * How often an open panel asks again.
 *
 * She speaks every 10-40s, so this is roughly "by the time you look back at it". Only while the
 * panel is expanded — collapsed, it costs nothing.
 */
const REFRESH_MS = 8000

const fmt = (ms: number): string =>
	new Date(ms).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit"
	})

export const LiveTranscript = () => {
	/** The last read that SUCCEEDED. Null until one has. */
	const [lines, setLines] = useState<Line[] | null>(null)
	/** Why the last read failed, or null. Deliberately not folded into `lines`. */
	const [readError, setReadError] = useState<string | null>(null)
	const [open, setOpen] = useState(false)

	const load = useCallback(async () => {
		try {
			const r = await fetch("/api/live/gemini/transcript?limit=200", {
				signal: AbortSignal.timeout(8000)
			})
			if (!r.ok) throw new Error(`the daemon answered HTTP ${r.status}`)
			const body = (await r.json()) as { lines?: unknown }
			// An error body has no `lines`. The old `?? []` turned that into "nothing recorded".
			if (!Array.isArray(body.lines)) throw new Error("the daemon sent no transcript")
			setLines(body.lines as Line[])
			setReadError(null)
		} catch (e) {
			setReadError(e instanceof Error ? e.message : String(e))
		}
	}, [])

	/*
	 * While open, keep asking. She is still talking as this is read — during a game the whole
	 * point is that lines appear — and the one-shot fetch this replaces is the bug.
	 */
	useEffect(() => {
		if (!open) return
		void load()
		const id = setInterval(() => void load(), REFRESH_MS)
		return () => clearInterval(id)
	}, [open, load])

	const view = transcriptView({ lines, readError })

	return (
		<details
			className="csk-drill"
			open={open}
			onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}
		>
			<summary>
				<span>What she said, earlier</span>
				<span className="faint" style={{ fontSize: 11.5 }}>
					every line, with the facts she had
				</span>
			</summary>

			{view.kind === "loading" ?
				<p className="faint" style={{ padding: "0 14px 12px" }}>
					Loading…
				</p>
			: view.kind === "unreadable" ?
				<p className="csk-transcript__broken">
					Couldn't read the transcript — {view.reason}. She may well still be talking; this
					panel just can't see it. This is not the same as her having said nothing. Check the
					daemon is running.
				</p>
			: view.kind === "empty" ?
				<p className="faint" style={{ padding: "0 14px 12px" }}>
					Nothing recorded yet — fawnsei answered, and the transcript is empty. Lines land here
					as soon as the live coach speaks.
				</p>
			:	<>
					{/*
					 * A later read failed while an earlier one worked. The lines stay on screen — losing
					 * them would be a second, larger loss — with the staleness said out loud.
					 */}
					{view.staleReason !== null && (
						<p className="csk-transcript__broken">
							This list may be behind — the last refresh failed ({view.staleReason}).
						</p>
					)}
					<ul className="csk-transcript">
						{(lines ?? []).map(l => (
							<li key={`${l.atMs}-${l.text.slice(0, 10)}`} className={l.fromUser ? "me" : ""}>
								<div className="row">
									<span className="t">{fmt(l.atMs)}</span>
									<span className="s">
										{l.fromUser ? <b>you: </b> : null}
										{l.text}
									</span>
								</div>
								{/*
								 * The evidence, one click away rather than on the page. It is the thing that
								 * makes a line checkable, and it is also 20 lines of it — inline it would
								 * bury the transcript it exists to explain.
								 */}
								{l.groundTruth ?
									<details className="csk-transcript__truth">
										<summary>what she knew</summary>
										<pre>{l.groundTruth}</pre>
									</details>
								:	null}
							</li>
						))}
					</ul>
				</>
			}
		</details>
	)
}
