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
 */

import { useEffect, useState } from "react"
import "./components.css"

interface Line {
	atMs: number
	text: string
	fromUser: boolean
	groundTruth?: string
}

const fmt = (ms: number): string =>
	new Date(ms).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit"
	})

export const LiveTranscript = () => {
	const [lines, setLines] = useState<Line[] | null>(null)
	const [open, setOpen] = useState(false)

	useEffect(() => {
		if (!open || lines !== null) return
		void (async () => {
			try {
				const r = await fetch("/api/live/gemini/transcript?limit=200")
				setLines(((await r.json()) as { lines?: Line[] }).lines ?? [])
			} catch {
				setLines([])
			}
		})()
	}, [open, lines])

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

			{lines === null ?
				<p className="faint" style={{ padding: "0 14px 12px" }}>
					Loading…
				</p>
			: lines.length === 0 ?
				<p className="faint" style={{ padding: "0 14px 12px" }}>
					Nothing recorded yet. Lines land here as soon as the live coach speaks.
				</p>
			:	<ul className="csk-transcript">
					{lines.map(l => (
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
			}
		</details>
	)
}
