/**
 * GameTimeline — a horizontal scrubber over one game's clock.
 *
 * Moments sit at their true timestamps, coloured by kind (same palette as the MiniMap, so a
 * red tick and a red dot always mean the same thing). The playhead is draggable, clicking
 * anywhere seeks, and the track is keyboard-operable: arrows step 5s, shift-arrows 30s,
 * Home/End jump to the ends, and `,`/`.` hop to the previous/next moment.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { LANING_END_SEC, LANING_START_SEC } from "../../shared/constants.ts"
import type { Moment } from "../../shared/schema/domain.ts"
import { fmtClock } from "../../shared/time.ts"
import { MOMENT_KIND_LABEL, momentColor } from "./MiniMap.tsx"
import "./components.css"

export interface GameTimelineProps {
	durationSec: number
	moments: Moment[]
	tSec: number
	onSeek: (t: number) => void
	/** Optional: highlights one moment's tick. Purely cosmetic. */
	selectedId?: string | null
}

const clamp = (n: number, lo: number, hi: number): number =>
	n < lo ? lo : n > hi ? hi : n

/** 5-minute labels normally; every 10 minutes once a game runs long enough to crowd. */
const tickStep = (durationSec: number): number => (durationSec > 2700 ? 600 : 300)

export const GameTimeline = ({
	durationSec,
	moments,
	tSec,
	onSeek,
	selectedId = null
}: GameTimelineProps) => {
	const trackRef = useRef<HTMLDivElement | null>(null)
	const [dragging, setDragging] = useState(false)

	const total = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
	const pct = (t: number): number => (total <= 0 ? 0 : clamp((t / total) * 100, 0, 100))

	const seekFromClientX = useCallback(
		(clientX: number) => {
			const el = trackRef.current
			if (!el || total <= 0) return
			const rect = el.getBoundingClientRect()
			if (rect.width <= 0) return
			const f = clamp((clientX - rect.left) / rect.width, 0, 1)
			onSeek(Math.round(f * total))
		},
		[onSeek, total]
	)

	useEffect(() => {
		if (!dragging) return
		const move = (e: PointerEvent) => seekFromClientX(e.clientX)
		const up = () => setDragging(false)
		window.addEventListener("pointermove", move)
		window.addEventListener("pointerup", up)
		window.addEventListener("pointercancel", up)
		return () => {
			window.removeEventListener("pointermove", move)
			window.removeEventListener("pointerup", up)
			window.removeEventListener("pointercancel", up)
		}
	}, [dragging, seekFromClientX])

	const step = (delta: number) => onSeek(clamp(Math.round(tSec + delta), 0, total))

	const hop = (dir: 1 | -1) => {
		const sorted = [...moments].sort((a, b) => a.tSec - b.tSec)
		const next =
			dir === 1
				? sorted.find(m => m.tSec > tSec + 0.5)
				: [...sorted].reverse().find(m => m.tSec < tSec - 0.5)
		if (next) onSeek(Math.round(next.tSec))
	}

	if (total <= 0) {
		return (
			<div className="csk-timeline">
				<div className="csk-empty">No game clock available — nothing to scrub.</div>
			</div>
		)
	}

	const stepSec = tickStep(total)
	const ticks: number[] = []
	for (let t = stepSec; t < total; t += stepSec) ticks.push(t)

	// laning phase band, the window analytics.md samples for early-game metrics
	const laneStart = pct(LANING_START_SEC)
	const laneEnd = pct(Math.min(LANING_END_SEC, total))

	return (
		<div className="csk-timeline">
			<div className="csk-timeline__hint">
				{moments.length} moment{moments.length === 1 ? "" : "s"} · drag or click to seek
			</div>
			<div className="csk-timeline__readout">
				{fmtClock(tSec)} / {fmtClock(total)}
			</div>

			<div
				ref={trackRef}
				className="csk-timeline__track"
				role="slider"
				tabIndex={0}
				aria-label="Game clock"
				aria-valuemin={0}
				aria-valuemax={Math.round(total)}
				aria-valuenow={Math.round(tSec)}
				aria-valuetext={fmtClock(tSec)}
				onPointerDown={e => {
					if (e.button !== 0) return
					setDragging(true)
					seekFromClientX(e.clientX)
				}}
				onKeyDown={e => {
					const big = e.shiftKey
					if (e.key === "ArrowRight") {
						e.preventDefault()
						step(big ? 30 : 5)
					} else if (e.key === "ArrowLeft") {
						e.preventDefault()
						step(big ? -30 : -5)
					} else if (e.key === "Home") {
						e.preventDefault()
						onSeek(0)
					} else if (e.key === "End") {
						e.preventDefault()
						onSeek(Math.round(total))
					} else if (e.key === ".") {
						e.preventDefault()
						hop(1)
					} else if (e.key === ",") {
						e.preventDefault()
						hop(-1)
					}
				}}
			>
				{laneEnd > laneStart && (
					<div
						className="csk-timeline__phase"
						style={{ left: `${laneStart}%`, width: `${laneEnd - laneStart}%` }}
						title="Laning phase window (2:00–9:30), the sampling window for early-game metrics"
					/>
				)}

				{ticks.map(t => (
					<div key={`tick-${t}`} className="csk-timeline__tick" style={{ left: `${pct(t)}%` }} />
				))}

				{moments.map(m => {
					const sev = clamp(m.severity, 0, 1)
					return (
						<button
							key={m.id}
							type="button"
							className={`csk-timeline__mark${m.id === selectedId ? " csk-timeline__mark--sel" : ""}`}
							style={{
								left: `${pct(m.tSec)}%`,
								height: `${18 + sev * 22}px`,
								background: momentColor(m.kind),
								opacity: 0.55 + sev * 0.45
							}}
							title={`${fmtClock(m.tSec)} — ${MOMENT_KIND_LABEL[m.kind]}: ${m.title}`}
							aria-label={`Seek to ${fmtClock(m.tSec)}, ${m.title}`}
							onPointerDown={e => e.stopPropagation()}
							onClick={e => {
								e.stopPropagation()
								onSeek(Math.round(m.tSec))
							}}
						/>
					)
				})}

				<div className="csk-timeline__head" style={{ left: `${pct(tSec)}%` }} />
			</div>

			{ticks.map(t => (
				<div key={`lbl-${t}`} className="csk-timeline__tick-label" style={{ left: `${pct(t)}%` }}>
					{fmtClock(t)}
				</div>
			))}
		</div>
	)
}

export default GameTimeline
