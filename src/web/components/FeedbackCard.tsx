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
import { CONFIDENCE_LABEL, confidenceChip, MOMENT_KIND_LABEL, momentColor } from "../lib/format.ts"
import { Glossed } from "./Term.tsx"
import "./components.css"

export interface FeedbackCardProps {
	/** The visual read for this item's moment, when one exists. */
	watchedNote?: { text: string; frameCount: number } | null
	/** Frames available to watch for this item's moment; 0 hides the action. */
	watchableFrames?: number
	/** Kick off the visual pass. Absent when the page cannot run one. */
	onWatch?: () => void
	watching?: boolean
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

/*
 * Tested on "generated", not on "replay".
 *
 * The distinction that matters is drawn-versus-real, and there are two real sources: `replay`
 * from the deleted capture pipeline (no row in this database has ever carried it) and `journal`,
 * a frame of his own screen. Asking `=== "replay"` put journal frames in the `else`, so a real
 * screenshot was labelled "drawn" with a tooltip insisting it was NOT a screenshot of his game.
 */
const sourceBadge = (m: Media) =>
	m.source === "generated" ?
		<span
			className="csk-src csk-src--generated"
			title="Drawn by this app from timeline data — NOT a screenshot of your game."
		>
			drawn
		</span>
	:	<span className="csk-src csk-src--real" title="A real frame of your own game.">
			real frame
		</span>

export const FeedbackCard = ({
	item,
	moments,
	media,
	watchedNote,
	watchableFrames = 0,
	onWatch,
	watching = false,
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
				<h3 className="csk-fb__title">
					<Glossed>{item.title}</Glossed>
				</h3>
				{item.category && <span className="csk-fb__cat">{item.category}</span>}
			</header>

			{/*
			 * The fix is the only part that changes what he does next game, so it is the only
			 * prose that is always visible. Everything else — the joke, the reasoning, the T1
			 * reference — sits behind a disclosure, because five paragraphs of it is a wall
			 * nobody reads between games, and coaching that is not read changes nothing.
			 */}
			{/*
			 * The three axes the ranking is built from. Shown so the order is legible rather
			 * than mysterious — and so an item that reads mild but ranks high (or the reverse)
			 * can be understood instead of just distrusted.
			 */}
			{item.impact ?
				<div className="csk-fb__axes">
					{/*
					 * Labelled "coach's call" out loud, because these are JUDGMENTS and the rest
					 * of this screen is measurements. Every figure in the title and fix came from
					 * the digest and is checkable; these three did not and are not. An unlabelled
					 * "impact: high" sitting next to "down 41 CS at 16:00" would read as equally
					 * computed, which is the one impression this app must never give.
					 */}
					<span className="csk-axis-label" title="The coach's own estimates, not computed from your game data. They set the order these items appear in.">
						coach's call
					</span>
					<span className={`csk-axis csk-axis--${item.impact}`} title="How much the coach reckons this cost — a judgment, not a measurement. This data cannot produce a win-rate estimate, so it does not claim one.">
						impact {item.impact}
					</span>
					<span className={`csk-axis csk-axis--${item.actionability}`} title="How directly you can act on the fix mid-game. High means a rule with a trigger. A judgment.">
						actionable {item.actionability}
					</span>
					<span className={`csk-axis csk-axis--${item.confidence}`} title="How sure the coach is that this read is right. Low-confidence items are demoted to notes and never phrased as corrections.">
						confidence {item.confidence}
					</span>
				</div>
			:	null}

			{item.fix ?
				<p className="csk-fb__fix">
					{/* The tag stays outside so the glossary never scans its own label. */}
					<span className="csk-fb__fix-tag">Do this</span>
					{/*
					 * Wrapped in ONE span on purpose: this row is `display: flex; gap: 9px`, and
					 * `Glossed` splits its text into a fragment per glossary hit. Without the
					 * wrapper flex applies the gap between every fragment, so each defined term
					 * ended up floating in nine pixels of whitespace on both sides.
					 */}
					<span>
						<Glossed>{item.fix}</Glossed>
					</span>
				</p>
			:	null}

			{/*
			 * The visual read, kept visually distinct from everything above it. The prose above
			 * is built from figures the parser can check; this came from looking at a picture and
			 * nothing can check it, so it is marked rather than blended in.
			 */}
			{watchedNote ?
				<div className="csk-fb__watched">
					<div
						className="csk-fb__watched-tag"
						title={`The coach read ${watchedNote.frameCount} real replay frames around this moment. This is the only kind of feedback that can cover ability usage, kiting and fight entry — none of that exists in the game's data. It also cannot be machine-checked the way the numbers above can, so treat it as an informed read of a picture.`}
					>
						👁 watched · {watchedNote.frameCount} frames
					</div>
					<Glossed>{watchedNote.text}</Glossed>
				</div>
			: watchableFrames > 0 && onWatch ?
				<button
					className="csk-fb__watch-cta"
					onClick={onWatch}
					disabled={watching}
					title={`Have the coach look at the ${watchableFrames} recorded frames around this moment and comment on execution — abilities, kiting, fight entry. Takes about a minute.`}
				>
					{watching ? "Watching…" : `👁 Watch this moment (${watchableFrames} frames)`}
				</button>
			:	null}

			{item.body ?
				<details className="csk-fb__more">
					<summary>Why</summary>
					<p className="csk-fb__body">
						<Glossed>{item.body}</Glossed>
					</p>
				</details>
			:	null}

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
								m.source === "generated" ? "drawn from timeline data" : "a real frame of your own game"
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

			{/*
			 * A figure the parser could not tie back to the digest. The item still shows — the
			 * rest of it is usually fine, and dropping real coaching over one number is the worse
			 * trade — but an unverifiable number must not sit on the page looking measured. This
			 * catches the failure that is otherwise invisible: a wrong baseline reads exactly
			 * like a right one.
			 */}
			{(item.warnings?.length ?? 0) > 0 && (
				<div className="csk-fb__unverified">
					<strong>Check this number.</strong>{" "}
					{item.warnings!.length === 1 ?
						"One figure in this item could not be matched to the data behind it:"
					:	`${item.warnings!.length} figures in this item could not be matched to the data behind them:`}
					<ul>
						{item.warnings!.map(w => (
							<li key={w}>{w}</li>
						))}
					</ul>
					The rest of the item still stands on its citations.
				</div>
			)}
		</article>
	)
}

export default FeedbackCard
