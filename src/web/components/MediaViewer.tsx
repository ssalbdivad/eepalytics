/**
 * MediaViewer — the lightbox.
 *
 * Signature note: the parent supplies `activeId` and `onClose`, but there is no
 * `onNavigate`, so navigation is held internally and re-seeded whenever `activeId` changes.
 * That keeps the parent's contract to "open this one / it closed" while still letting arrows
 * walk the set.
 *
 * Keyboard: ←/→ (and h/l) move, Esc closes, space toggles a clip.
 *
 * Every item is labelled with what it actually IS. `source: "generated"` means this app drew
 * the picture from timeline data — a map diagram, not a photograph of the user's game — and
 * the footer says so in words, not just a colour. Mistaking a drawing for a replay frame
 * would make the coach's evidence look stronger than it is.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { API } from "../../shared/schema/api.ts"
import type { Media } from "../../shared/schema/domain.ts"
import { fmtClock } from "../../shared/time.ts"
import "./components.css"

export interface MediaViewerProps {
	media: Media[]
	activeId: string | null
	onClose: () => void
}

const KIND_WORD: Record<Media["kind"], string> = {
	screenshot: "Screenshot",
	clip: "Clip",
	map: "Map diagram"
}

const SOURCE_WORD: Record<Media["source"], string> = {
	replay: "A real frame of your game, recorded from the replay. Nothing writes these any more.",
	generated: "Drawn by this app from timeline positions. It is a diagram, NOT a screenshot.",
	journal: "A real frame of your own screen, saved while you played."
}

const isVideo = (m: Media): boolean =>
	m.kind === "clip" || (m.mimeType ?? "").startsWith("video/")

export const MediaViewer = ({ media, activeId, onClose }: MediaViewerProps) => {
	// Which item we are showing. Seeded from `activeId` and moved by the arrows. This is
	// derived DURING RENDER rather than in an effect: an effect would let the first paint show
	// media[0] and then jump, which reads as a glitch and — worse — briefly labels the wrong
	// item as a real frame rather than a drawn diagram.
	const [navId, setNavId] = useState<string | null>(activeId)
	const [seenActive, setSeenActive] = useState<string | null>(activeId)
	const [broken, setBroken] = useState<string | null>(null)
	const closeRef = useRef<HTMLButtonElement | null>(null)

	if (activeId !== seenActive) {
		setSeenActive(activeId)
		setNavId(activeId)
		setBroken(null)
	}

	const open = activeId !== null && media.length > 0
	const found = media.findIndex(m => m.id === navId)
	const index = found >= 0 ? found : 0
	const current = open ? (media[index] ?? null) : null

	const move = useCallback(
		(delta: number) => {
			if (media.length === 0) return
			setNavId(cur => {
				const at = media.findIndex(m => m.id === cur)
				const from = at >= 0 ? at : 0
				return media[(from + delta + media.length) % media.length]?.id ?? cur
			})
			setBroken(null)
		},
		[media]
	)

	useEffect(() => {
		if (!open) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault()
				onClose()
			} else if (e.key === "ArrowRight" || e.key === "l") {
				e.preventDefault()
				move(1)
			} else if (e.key === "ArrowLeft" || e.key === "h") {
				e.preventDefault()
				move(-1)
			}
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [open, move, onClose])

	useEffect(() => {
		if (open) closeRef.current?.focus()
	}, [open])

	if (!open) return null

	if (!current)
		return (
			<div className="csk-lightbox" role="dialog" aria-modal="true" aria-label="Media viewer">
				<div className="csk-lightbox__bar">
					<span className="csk-lightbox__title">Nothing to show</span>
					<button ref={closeRef} type="button" className="csk-lightbox__btn" onClick={onClose}>
						Esc ✕
					</button>
				</div>
				<div className="csk-lightbox__stage">
					<div className="csk-empty">
						Nothing to show for this yet. Every moment gets a drawn map once media
						generation runs for the game.
					</div>
				</div>
			</div>
		)

	const src = API.media(current.id)
	const failed = broken === current.id

	return (
		<div
			className="csk-lightbox"
			role="dialog"
			aria-modal="true"
			aria-label={`${KIND_WORD[current.kind]} at ${fmtClock(current.tSec)}`}
			onClick={e => {
				if (e.target === e.currentTarget) onClose()
			}}
		>
			<div className="csk-lightbox__bar">
				<button
					type="button"
					className="csk-lightbox__btn"
					onClick={() => move(-1)}
					disabled={media.length < 2}
					aria-label="Previous"
				>
					←
				</button>
				<button
					type="button"
					className="csk-lightbox__btn"
					onClick={() => move(1)}
					disabled={media.length < 2}
					aria-label="Next"
				>
					→
				</button>
				<span className="csk-lightbox__title">
					{KIND_WORD[current.kind]} · {fmtClock(current.tSec)}
				</span>
				<span className="csk-lightbox__count">
					{index + 1} / {media.length}
				</span>
				<button ref={closeRef} type="button" className="csk-lightbox__btn" onClick={onClose}>
					Esc ✕
				</button>
			</div>

			<div className="csk-lightbox__stage">
				{failed ?
					<div className="csk-lightbox__err">
						This file could not be loaded.
						<br />
						It may have been pruned by the retention policy, or the daemon is not running.
					</div>
				: isVideo(current) ?
					<video
						key={current.id}
						src={src}
						controls
						autoPlay
						loop
						playsInline
						onError={() => setBroken(current.id)}
					/>
				:	<img
						key={current.id}
						src={src}
						alt={`${KIND_WORD[current.kind]} at ${fmtClock(current.tSec)}`}
						onError={() => setBroken(current.id)}
					/>
				}
			</div>

			<div className="csk-lightbox__foot">
				<span
					className={`csk-src csk-src--${current.source === "replay" ? "replay" : "generated"}`}
				>
					{current.source === "replay" ? "replay frame" : "generated diagram"}
				</span>
				<span>{SOURCE_WORD[current.source]}</span>
				<span style={{ color: "var(--csk-ghost)", fontFamily: "var(--csk-mono)", fontSize: 10.5 }}>
					{current.width}×{current.height}
					{current.durationSec ? ` · ${current.durationSec.toFixed(1)}s` : ""}
					{current.momentId ? ` · ${current.momentId}` : ""}
				</span>
				<span style={{ marginLeft: "auto", color: "var(--csk-ghost)", fontSize: 10.5 }}>
					← → to move · Esc to close
				</span>
			</div>

			{media.length > 1 && (
				<div className="csk-lightbox__strip">
					{media.map((m, i) => (
						<button
							key={m.id}
							type="button"
							className={i === index ? "on" : undefined}
							onClick={() => {
								setNavId(m.id)
								setBroken(null)
							}}
							title={`${KIND_WORD[m.kind]} at ${fmtClock(m.tSec)} (${m.source})`}
							aria-label={`Show ${KIND_WORD[m.kind]} at ${fmtClock(m.tSec)}`}
						>
							{isVideo(m) ?
								<span
									style={{
										display: "block",
										width: "100%",
										height: "100%",
										background:
											"repeating-linear-gradient(135deg,#16212c,#16212c 8px,#1c2836 8px,#1c2836 16px)",
										color: "var(--csk-gold)",
										fontSize: 12,
										lineHeight: "52px",
										textAlign: "center"
									}}
								>
									▶
								</span>
							:	<img src={API.media(m.id)} alt="" loading="lazy" />
							}
						</button>
					))}
				</div>
			)}
		</div>
	)
}

export default MediaViewer
