/**
 * What the capture is actually doing right now.
 *
 * Capture takes minutes: it opens League, waits for the client, loads the replay, waits for the
 * in-game API, then renders a burst per moment. Previously the UI said only "Waiting — gate G5"
 * and then nothing at all, so a working capture and a stuck one looked identical — and the
 * user reasonably concluded it had hung when it was simply slow.
 *
 * The steps come from the pipeline's own `LaunchPhase`, so this cannot claim progress the
 * capture is not making.
 */

import "./components.css"

/** In the order they happen. `note` from the daemon fills in the detail. */
const STEPS: { phase: string; label: string }[] = [
	{ phase: "preflight", label: "Checking the client is free" },
	{ phase: "ensure-rofl", label: "Finding the replay file" },
	{ phase: "launching", label: "Opening League" },
	{ phase: "api-wait", label: "Loading the replay" },
	{ phase: "up", label: "Replay ready" },
	{ phase: "capturing", label: "Recording frames" },
	{ phase: "teardown", label: "Closing the replay" }
]

export interface CaptureProgressProps {
	/** The daemon's latest phase, or null when nothing is running. */
	phase: string | null
	note?: string | null
	done?: number
	total?: number
}

export const CaptureProgress = ({ phase, note, done = 0, total = 0 }: CaptureProgressProps) => {
	if (phase === null) return null
	const at = STEPS.findIndex(s => s.phase === phase)

	return (
		<div className="csk-capprog">
			<div className="csk-capprog__head">
				<span className="csk-capprog__spin" />
				<strong>Capturing replay frames</strong>
				{total > 0 && (
					<span className="csk-capprog__count">
						{done} / {total} moments
					</span>
				)}
			</div>
			<ol className="csk-capprog__steps">
				{STEPS.map((s, i) => (
					<li
						key={s.phase}
						className={
							at < 0 ? ""
							: i < at ? "done"
							: i === at ? "now"
							: "todo"
						}
					>
						<span className="mark">{i < at ? "✓" : i === at ? "•" : "○"}</span>
						{s.label}
						{i === at && note ? <em>{note}</em> : null}
					</li>
				))}
			</ol>
			<div className="csk-capprog__foot">
				This takes a few minutes and controls your game while it runs. Starting a match stops
				it.
			</div>
		</div>
	)
}
