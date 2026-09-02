/**
 * FeedbackCard — one coaching point, with its receipts.
 *
 * This is where the coach's personality lands visually, but the layout is built around
 * CITATIONS rather than vibes. An item carries `momentIds`, `mediaIds` and `metricKeys`; each
 * one becomes something the user can click through to. An item that cites nothing is labelled
 * as opinion, out loud, because a memey one-liner with no evidence behind it should not look
 * the same as one anchored to a death at 14:20.
 *
 * Media thumbnails are labelled `REPLAY` or `DRAWN` — a generated map diagram must never be
 * mistaken for a real screenshot of the user's game.
 */

import type { FeedbackItem, Media, Metric, Moment } from "../../shared/schema/domain.ts"
import { API } from "../../shared/schema/api.ts"
import { fmtClock } from "../../shared/time.ts"
import { CONFIDENCE_LABEL, confidenceChip } from "../lib/format.ts"
import { MOMENT_KIND_LABEL, momentColor } from "./MiniMap.tsx"
import "./components.css"

export interface FeedbackCardProps {
	item: FeedbackItem
	moments: Moment[]
	media: Media[]
	onSeek: (t: number) => void
	/** Optional: open the lightbox on a media id. Falls back to seeking to its timestamp. */
	onOpenMedia?: (mediaId: string) => void
	/** Optional: resolve `metricKeys` to human labels instead of showing raw keys. */
	metrics?: Metric[]
	/** Optional: highlight this card (e.g. the item whose moment is selected). */
	active?: boolean
}

const SEV_GLYPH = { major: "🚨", minor: "👀", info: "💡" } as const
const SEV_WORD = { major: "big one", minor: "worth fixing", info: "note" } as const

/** Kind → the picture we can actually show. Clips get a play affordance. */
const MEDIA_LABEL: Record<Media["kind"], string> = {
	screenshot: "screenshot",
	clip: "clip",
	map: "map diagram"
}

const sourceBadge = (m: Media) =>
	m.source === "replay" ?
		<span className="csk-src csk-src--replay" title="A real frame captured from your replay.">
			replay
		</span>
	:	<span
			className="csk-src csk-src--generated"
			title="Drawn by this app from timeline data — NOT a screenshot of your game."
		>
			drawn
		</span>

export const FeedbackCard = ({
	item,
	moments,
	media,
	onSeek,
	onOpenMedia,
	metrics,
	active = false
}: FeedbackCardProps) => {
	const momentSet = new Set(item.momentIds)
	const cited = moments.filter(m => momentSet.has(m.id)).sort((a, b) => a.tSec - b.tSec)

	const mediaSet = new Set(item.mediaIds)
	const shots = media.filter(m => mediaSet.has(m.id)).sort((a, b) => a.tSec - b.tSec)

	const metricLabels = item.metricKeys.map(k => {
		const found = metrics?.find(m => m.key === k)
		return { key: k, label: found?.label ?? k, explain: found?.explain ?? "" }
	})

	const hasCitations =
		cited.length > 0 || shots.length > 0 || metricLabels.length > 0 || item.tSec !== null

	return (
		<article
			className={`csk-fb csk-fb--${item.severity}`}
			style={active ? { boxShadow: "0 0 0 1px var(--csk-gold)" } : undefined}
			aria-label={`${SEV_WORD[item.severity]}: ${item.title}`}
		>
			<header className="csk-fb__head">
				<span className="csk-fb__sev" aria-hidden="true" title={SEV_WORD[item.severity]}>
					{SEV_GLYPH[item.severity]}
				</span>
				<h3 className="csk-fb__title">{item.title}</h3>
				{item.category && <span className="csk-fb__cat">{item.category}</span>}
			</header>

			<p className="csk-fb__body">{item.body}</p>

			{(item.tSec !== null || cited.length > 0 || metricLabels.length > 0) && (
				<div className="csk-fb__cites">
					<span className="csk-fb__cites-label">evidence</span>

					{item.tSec !== null && (
						<button
							type="button"
							className="csk-chip csk-chip--time"
							onClick={() => onSeek(Math.round(item.tSec as number))}
							title="Jump the timeline here"
						>
							▶ {fmtClock(item.tSec)}
						</button>
					)}

					{cited.map(m => (
						<button
							key={m.id}
							type="button"
							className="csk-chip"
							style={{ borderColor: momentColor(m.kind) }}
							onClick={() => onSeek(Math.round(m.tSec))}
							title={`${MOMENT_KIND_LABEL[m.kind]} — ${m.title}\n${CONFIDENCE_LABEL[m.confidence]}\n\n${m.evidence}`}
						>
							<i
								style={{
									width: 6,
									height: 6,
									borderRadius: "50%",
									background: momentColor(m.kind),
									display: "inline-block"
								}}
							/>
							{fmtClock(m.tSec)} {MOMENT_KIND_LABEL[m.kind].toLowerCase()}
							{/*
							 * A chip for a moment the app only INFERRED between one-minute frames must
							 * not look identical to one read straight off an event. The hedge was
							 * previously buried in a hover tooltip; `confidenceChip` exists for exactly
							 * this and was going unused.
							 */}
							{confidenceChip(m.confidence) && (
								<em className={`csk-chip__conf csk-chip__conf--${m.confidence}`}>
									{confidenceChip(m.confidence)}
								</em>
							)}
						</button>
					))}

					{metricLabels.map(m => (
						<span key={m.key} className="csk-chip" title={m.explain || m.key}>
							{m.label}
						</span>
					))}
				</div>
			)}

			{shots.length > 0 && (
				<div className="csk-fb__thumbs">
					{shots.map(m => (
						<button
							key={m.id}
							type="button"
							className="csk-fb__thumb"
							onClick={() =>
								onOpenMedia ? onOpenMedia(m.id) : onSeek(Math.round(m.tSec))
							}
							title={`${MEDIA_LABEL[m.kind]} at ${fmtClock(m.tSec)} — ${
								m.source === "replay" ? "captured from the replay" : "drawn from timeline data"
							}`}
						>
							{m.kind === "clip" ?
								<span
									style={{
										display: "block",
										height: 74,
										background:
											"repeating-linear-gradient(135deg,#16212c,#16212c 8px,#1c2836 8px,#1c2836 16px)"
									}}
								/>
							:	<img
									src={API.media(m.id)}
									alt={`${MEDIA_LABEL[m.kind]} at ${fmtClock(m.tSec)}`}
									loading="lazy"
									onError={e => {
										e.currentTarget.style.visibility = "hidden"
									}}
								/>
							}
							{m.kind === "clip" && <span className="csk-fb__play">▶</span>}
							<span className="csk-fb__thumb-cap">
								<span>{fmtClock(m.tSec)}</span>
								{sourceBadge(m)}
							</span>
						</button>
					))}
				</div>
			)}

			{!hasCitations && (
				<div className="csk-fb__opinion">
					No moment, clip or metric attached — treat this one as the coach's opinion, not a
					measurement.
				</div>
			)}
		</article>
	)
}

export default FeedbackCard
