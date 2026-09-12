/**
 * THE DEBRIEF — the screen you read once, standing up, in the minute after a game.
 *
 * ## What it is for
 *
 * The post-game path is the only part of this product a human has ever graded as good: 37 items
 * across five models, blinded, 68% useful. Until now it had almost no interface — a Debrief page
 * nothing linked to, and a ten-panel review screen whose first screenful is a stat header. This
 * is that asset finally getting a screen.
 *
 * It answers three questions in order and NOTHING else appears at top level:
 *
 *   1. How did I play?      — the verdict band: one counted sentence, three tiles, one Kept line
 *   2. What was the shape?  — the spine: the whole game as one object
 *   3. What do I fix?       — three cards, each checkable by eye against the evidence
 *
 * ## The caps are the design
 *
 * **3 tiles · 3 cards · 3 goals · 1 disclosure**, enforced here in code rather than by taste. He
 * has asked three times for the interface to be clean, and the way a screen stays clean is a cap
 * you cannot argue with — every previous attempt at restraint lost to the next good idea, which
 * is how the review page got to ten panels. Everything true but not one of the three lives
 * behind the single `<details>` at the bottom, unsummarised.
 *
 * ## The evidence gate
 *
 * A game is either `watched` — his screen was shared, so frames exist — or `numbers`, where all
 * that exists is a per-minute timeline. **An unwatched game gets facts and no opinions**: no
 * grade, no cards, no fixes. That is not a UI mode, it is the structural version of the lesson
 * this app learned expensively — for most of its life it produced confident coaching from data
 * that could not support it. The ungraded state is written as a consequence of how the game was
 * recorded, never as a punishment: he did nothing wrong by not sharing his screen.
 *
 * ## Every figure on this screen, and where it comes from
 *
 * - scoreline, vision, grade        `GET /api/games/:id` → the `game` row (end-of-game stats)
 * - tiles and their baselines       the same route's `metrics`; the baseline digits are COPIED
 *                                   out of the digest's own sentence, never recomputed
 * - shape line, spine, Kept line    `GET /api/games/:id/spine` → the timeline blob, where all
 *                                   ten players are exact. NOT the live feed, whose enemy CS is
 *                                   a visibility counter that read 70 against a true 183
 * - cards, fixes, goals             the stored review, ranked by the coach's own three ratings
 * - the picture on a card           a real journal frame of his own screen, within 15s
 * - where he was                    the nearest timeline frame, with its gap stated
 *
 * Nothing on this screen is written by a model except the card prose and the goals, and both of
 * those are cited back to a moment or a metric that appears above them.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import type { GameDetailResponse, SpineResponse } from "../../shared/schema/api.ts"
import type { FeedbackItem, Metric, Moment, WatchNote } from "../../shared/schema/domain.ts"
import { api } from "../lib/api.ts"
import { evidenceOf, TIER_EXPLAIN, TIER_LABEL } from "../../shared/evidence.ts"
import {
	baselineLabel,
	directionOf,
	fmtNumber,
	keptLine,
	pickTiles,
	shapeLine,
	TILE_COUNT
} from "../../shared/debrief-view.ts"
import { toMinimapPct } from "../../shared/map.ts"
import { fmtClock } from "../../shared/time.ts"
import { cls, fmtDelta, fmtQty } from "../lib/format.ts"
import { useAction, useResource } from "../lib/hooks.ts"
import { Glossed } from "../components/Term.tsx"
import { MapInset } from "../components/MapInset.tsx"
import { RaceChart } from "../components/RaceChart.tsx"
import { Spine, type SpineMark } from "../components/Spine.tsx"
import { CoachChat } from "../components/CoachChat.tsx"
import "../components/debrief.css"

/** Three. Not four, and never six. */
const CARD_CAP = 3
const GOAL_CAP = 3
/** Beyond this the picture is of a different moment, which is worse than showing none. */
const FRAME_TOL_SEC = 15
/** How often to look again while the coach is still writing. */
const WAITING_POLL_MS = 6000
/** Thumbnails in the disclosure. A game has hundreds of frames; a strip is a sample, and says so. */
const STRIP_N = 16

export const Debrief = ({ gameId, eventTick = 0 }: { gameId: number; eventTick?: number }) => {
	const detail = useResource(s => api.game(gameId, s), [gameId, eventTick])
	const spine = useResource(s => api.spine(gameId, s), [gameId])
	const watch = useResource(s => api.watchNotes(gameId, s), [gameId, eventTick])
	const [shot, setShot] = useState<{ frameId: string; caption: string } | null>(null)
	const [watching, setWatching] = useState<string | null>(null)

	/*
	 * The visual pass, which used to live on the deleted review screen and nowhere else.
	 *
	 * It is the one thing on this page that spends money on demand, and it is the only thing in
	 * the app that can say anything about ability usage, kiting or fight entry — none of which is
	 * in the timeline. So it stays, one button per card, on the cards that actually have frames
	 * behind them; a card with no picture cannot be watched and does not offer to be.
	 */
	const notes = useMemo(
		() => new Map((watch.data?.notes ?? []).filter(n => n.status === "ok").map(n => [n.momentId, n])),
		[watch.data]
	)
	const reloadWatch = watch.reload
	const runWatch = useCallback(
		(momentId: string) => {
			setWatching(momentId)
			api
				.watchMoment(gameId, momentId)
				.catch(() => {})
				.finally(() => {
					setWatching(null)
					reloadWatch()
				})
		},
		[gameId, reloadWatch]
	)

	const d = detail.data
	const review = d?.review ?? null
	const reviewFailed = d?.reviewFailed !== undefined

	/*
	 * The review lands about twenty seconds after the game does, and this screen is open for
	 * exactly that interval. Polling stops the moment there is a review or a failure to show —
	 * a page that keeps asking after the answer arrived is a page that flickers.
	 */
	const waiting = d !== null && review === null && !reviewFailed
	const reload = detail.reload
	useEffect(() => {
		if (!waiting) return
		const t = setInterval(reload, WAITING_POLL_MS)
		return () => clearInterval(t)
	}, [waiting, reload])

	const ask = useAction(() => api.requestReview(gameId).then(reload))

	const evidence = useMemo(
		() =>
			d === null ?
				null
			:	evidenceOf({
					frameTimesSec: d.journalFrames.map(f => f.tSec),
					gameDurationSec: d.game.gameDurationSec ?? 0
				}),
		[d]
	)

	if (detail.error !== null)
		return (
			<div className="notice bad">
				Couldn't load that game: {detail.error}
				{detail.errorDetail !== null && <div className="dim">{detail.errorDetail}</div>}
			</div>
		)
	if (d === null || evidence === null) return <div className="empty">Loading…</div>

	const g = d.game
	const watched = evidence.tier === "watched"
	const sp = spine.data
	const minutes = sp?.minutes ?? []
	const counterpart = sp?.counterpart ?? null

	/* ------------------------------------------------------------- band 1 */

	const tiles = pickTiles(d.metrics, TILE_COUNT)
	const shape = shapeLine({
		objectives: sp?.objectives ?? [],
		counterpartName: counterpart?.championName ?? null,
		metrics: d.metrics
	})
	const kept = keptLine({
		metrics: d.metrics,
		counterpartTakedowns:
			counterpart === null ?
				[]
			:	(sp?.takedowns ?? []).filter(t => t.victim === counterpart.championName),
		counterpartName: counterpart?.championName ?? null,
		excludeKeys: tiles.map(t => t.key)
	})

	/* ------------------------------------------------------------- band 3 */

	const items = watched ? rankedItems(review?.items ?? []).slice(0, CARD_CAP) : []
	const marks: SpineMark[] = items.flatMap((it, i) =>
		it.tSec === null ? [] : [{ n: i + 1, tSec: it.tSec }]
	)
	const goals = watched ? (review?.goals ?? []).slice(0, GOAL_CAP) : []

	const frameNear = (tSec: number | null): { id: string; gapSec: number } | null => {
		if (tSec === null || d.journalFrames.length === 0) return null
		let best = d.journalFrames[0]!
		for (const f of d.journalFrames)
			if (Math.abs(f.tSec - tSec) < Math.abs(best.tSec - tSec)) best = f
		const gap = Math.abs(best.tSec - tSec)
		return gap <= FRAME_TOL_SEC ? { id: best.id, gapSec: Math.round(gap * 10) / 10 } : null
	}

	return (
		<div className="dbf">
			{/* ============================================================ band 1 */}
			<header className="dbf__verdict">
				<div className="dbf__head">
					<h1 className={g.win ? "is-for" : "is-against"}>
						{g.win ? "Win" : "Loss"} as {g.championName} {roleWord(g.role)}
					</h1>
					<div className="dbf__chips">
						{/*
						 * The grade exists only where the evidence does. On a `numbers` game there is
						 * no grade to show and saying so is the honest version of hiding it.
						 */}
						{watched && g.gradeRank && (
							<span className="dbf__chip dbf__chip--grade" title={`${g.gradeScore} against your own recent form`}>
								{g.gradeRank}
							</span>
						)}
						<span className={cls("dbf__chip", `is-${evidence.tier}`)} title={TIER_EXPLAIN[evidence.tier]}>
							{TIER_LABEL[evidence.tier]}
							{watched ?
								` · ${d.journalFrames.length} frames`
							:	evidence.shortfall !== null ?
								` · ${evidence.shortfall}`
							:	""}
						</span>
					</div>
				</div>

				<p className="dbf__score">
					{g.kills}/{g.deaths}/{g.assists} · {g.cs + g.jungleCs} CS · {fmtQty(g.gold, "gold")}g ·{" "}
					{fmtClock(g.gameDurationSec)} · vision {g.visionScore}
					{counterpart !== null && (
						<span className="dbf__vs">
							vs {counterpart.championName} {counterpart.kda} · {counterpart.cs} CS ·{" "}
							{fmtQty(counterpart.gold, "gold")}g
						</span>
					)}
				</p>

				{shape !== null && (
					<p className="dbf__shape" title={shape.source}>
						{shape.lead} <span className={`is-${shape.direction}`}>{shape.turn}</span>
					</p>
				)}

				<ul className="dbf__tiles">
					{tiles.map(m => (
						<li key={m.key} className="dbf__tile" title={m.explain}>
							<b className={`is-${directionOf(m)}`}>
								{fmtNumber(m.value)}
								{m.unit === "%" ? "%" : ""}
							</b>
							<span className="dbf__tilelabel">{m.label}</span>
							<span className="dbf__tilebase">{baselineLine(m)}</span>
						</li>
					))}
					{tiles.length === 0 && (
						<li className="dbf__tile dbf__tile--none">
							No metric has enough history behind it to compare yet.
						</li>
					)}
				</ul>

				{kept !== null && (
					<p className="dbf__kept">
						<span className="dbf__keptlab">Kept</span> {kept}
					</p>
				)}
			</header>

			{/* ============================================================ band 2 */}
			{sp?.available && minutes.length > 1 ?
				<Spine
					minutes={minutes}
					objectives={sp.objectives}
					deaths={sp.deaths}
					takedowns={sp.takedowns}
					durationSec={sp.durationSec ?? g.gameDurationSec}
					counterpartName={counterpart?.championName ?? null}
					marks={marks}
					onPick={tSec => {
						const f = frameNear(tSec)
						if (f) setShot({ frameId: f.id, caption: `${fmtClock(tSec)} — your screen, ${f.gapSec}s away` })
					}}
				/>
			: spine.loading ?
				<div className="dbf__spinewait">Reading the timeline…</div>
			:	<p className="dbf__none">
					{spine.error !== null ?
						`The shape of this game couldn't be read: ${spine.error}`
					:	(sp?.reason ?? "There is no timeline for this game, so the shape can't be drawn.")}
				</p>
			}

			{/* ============================================================ band 3 */}
			{!watched ?
				<p className="dbf__none">
					{TIER_EXPLAIN.numbers}
					{review !== null && " The write-up produced from the numbers alone is below."}
				</p>
			: reviewFailed ?
				<div className="dbf__wait dbf__wait--bad">
					<p>
						The coach couldn't write this one up.
						{d.reviewFailed?.error !== undefined && <span className="dim"> {d.reviewFailed.error}</span>}
					</p>
					<button className="btn" onClick={() => ask.run()} disabled={ask.pending}>
						{ask.pending ? "Asking…" : "Try again"}
					</button>
					{ask.error !== null && <p className="dim">{ask.error}</p>}
				</div>
			: items.length === 0 ?
				<div className="dbf__wait">
					<p>
						<b>The review is still being written.</b> It usually takes about twenty seconds, and
						this page updates itself.
					</p>
					<button className="btn" onClick={() => ask.run()} disabled={ask.pending}>
						{ask.pending ? "Asking…" : "Ask for it now"}
					</button>
				</div>
			:	<ol className="dbf__cards">
					{items.map((item, i) => (
						<Card
							key={item.id}
							n={i + 1}
							item={item}
							detail={d}
							spine={sp ?? null}
							frame={frameNear(item.tSec)}
							onShot={setShot}
							note={item.momentIds.map(id => notes.get(id)).find(n => n !== undefined) ?? null}
							onWatch={item.momentIds[0] !== undefined ? () => runWatch(item.momentIds[0]!) : null}
							watching={watching !== null && item.momentIds.includes(watching)}
						/>
					))}
				</ol>
			}

			{/* ============================================================ band 4 */}
			{goals.length > 0 && (
				<section className="dbf__goals">
					<h2>Next game</h2>
					<ol>
						{goals.map((goal, i) => (
							<li key={i}>
								<Glossed>{goal}</Glossed>
							</li>
						))}
					</ol>
				</section>
			)}

			{/* ============================================================ band 5 */}
			<Everything
				gameId={gameId}
				detail={d}
				spine={sp ?? null}
				onShot={setShot}
				onSeek={tSec => {
					const f = frameNear(tSec)
					if (f) setShot({ frameId: f.id, caption: `${fmtClock(tSec)} — your screen, ${f.gapSec}s away` })
				}}
				/*
				 * On a `numbers` game the review is not promoted to cards — it was written without
				 * anything watching, so it may not sit at the top of the screen as a correction. It
				 * is still HERE, in full, because deleting the only human-graded output this app has
				 * ever produced would be a worse failure than showing it with its limits stated.
				 */
				buriedReview={watched ? null : review}
			/>

			{shot !== null && (
				<div className="dbf__lightbox" onClick={() => setShot(null)} role="dialog" aria-label="Frame">
					<figure onClick={e => e.stopPropagation()}>
						<img src={`/api/frames/${shot.frameId}`} alt="" />
						<figcaption>
							{shot.caption}
							<button className="btn btn--ghost" onClick={() => setShot(null)}>
								Close
							</button>
						</figcaption>
					</figure>
				</div>
			)}
		</div>
	)
}

/* ==================================================================== card */

interface CardProps {
	n: number
	item: FeedbackItem
	detail: GameDetailResponse
	spine: SpineResponse | null
	frame: { id: string; gapSec: number } | null
	onShot: (s: { frameId: string; caption: string }) => void
	/** A visual pass the coach already made over this moment's frames, if there is one. */
	note: WatchNote | null
	/** Ask for one. Null when the item cites no moment, which is the only case that cannot be watched. */
	onWatch: (() => void) | null
	watching: boolean
}

/**
 * One thing that cost him the game.
 *
 * Order is fixed and is the argument: EVIDENCE first, then the claim, then the fix. A card that
 * leads with prose asks him to take the claim on trust and then offers proof; this one puts the
 * proof where his eye lands and lets the sentence describe what he is already looking at.
 *
 * Nothing is ever drawn on top of the frame. The client's own minimap, gold and clock are in
 * that picture — covering evidence in order to explain evidence is a bad trade, and the
 * annotations went next to it instead.
 */
const Card = ({ n, item, detail, spine, frame, onShot, note, onWatch, watching }: CardProps) => {
	const moment = detail.moments.find(m => item.momentIds.includes(m.id)) ?? null
	const span = item.tSec === null || frame === null
	const at = item.tSec ?? moment?.tSec ?? null
	const near = at === null ? null : nearestMinute(spine?.minutes ?? [], at)
	const counterpart = spine?.counterpart ?? null

	return (
		<li className={cls("dbf__card", `is-${item.severity}`)}>
			<div className="dbf__cardn">{n}</div>

			{/* --- evidence: a moment gets a picture, a span gets a chart --- */}
			{frame !== null && at !== null ?
				<button
					className="dbf__shot"
					onClick={() => onShot({ frameId: frame.id, caption: `${fmtClock(at)} — your screen, ${frame.gapSec}s from the moment` })}
					title="Open this frame"
				>
					<img src={`/api/frames/${frame.id}`} alt="" loading="lazy" />
					<span className="dbf__shotclock">{fmtClock(at)}</span>
					<span className="dbf__shotgap">{frame.gapSec}s away</span>
				</button>
			: span && spine !== null && spine.minutes.length > 1 ?
				<RaceChart
					minutes={spine.minutes}
					quantity={quantityOf(item)}
					counterpartName={counterpart?.championName ?? null}
					atSec={at}
				/>
			:	<p className="dbf__noshot">
					No frame within {FRAME_TOL_SEC}s of {at === null ? "this point" : fmtClock(at)} — this one
					rests on the numbers alone.
				</p>
			}

			<div className="dbf__cardbody">
				<h3>
					<Glossed>{item.title}</Glossed>
				</h3>
				{item.fix !== "" && (
					<p className="dbf__fix">
						<span className="dbf__fixlab">Do this</span>
						<Glossed>{item.fix}</Glossed>
					</p>
				)}

				{/* --- source strip: the channel, in a clause, always present --- */}
				<p className="dbf__src">
					<span className={cls("dbf__dot", `is-${item.confidence}`)} />
					{sourceStrip({ item, frame, moment, near })}
				</p>

				{/*
				 * The visual pass: what was ON SCREEN, which no amount of timeline can supply.
				 *
				 * It sits under the source strip rather than above the fix, because it is a second
				 * opinion about the same moment — and it is labelled as a read of the pictures so it
				 * never gets mistaken for something computed.
				 */}
				{note !== null ?
					<p className="dbf__watched">
						<span className="dbf__watchlab">👁 Watched</span>
						<Glossed>{note.text}</Glossed>
					</p>
				: onWatch !== null && frame !== null ?
					<p className="dbf__watchask">
						<button className="btn btn--ghost" onClick={onWatch} disabled={watching}>
							{watching ? "Looking…" : "👁 Watch this moment"}
						</button>
						<span className="dim">the coach reads the frames and coaches execution</span>
					</p>
				:	null}

				{item.body !== "" && (
					<details className="dbf__why">
						<summary>why</summary>
						<p>
							<Glossed>{item.body}</Glossed>
						</p>
						{moment !== null && <p className="dim">{moment.evidence}</p>}
						{item.warnings !== undefined && item.warnings.length > 0 && (
							<p className="dbf__warn">
								Figures this app could not tie back to the digest: {item.warnings.join("; ")}
							</p>
						)}
					</details>
				)}
			</div>

			{/*
			 * The inset is the thing no other tool he has can draw: where he was when the thing
			 * happened, against where it happened. It is only drawn when something actually placed
			 * him — an empty map is a claim that he was nowhere.
			 */}
			{(moment !== null || near !== null) && (
				<MapInset
					him={
						moment !== null && isHisOwnEvent(moment) ? toPct(moment)
						: near !== null ? near.m.minimapPct
						: null
					}
					spot={
						moment !== null && !isHisOwnEvent(moment) ?
							{ ...toPct(moment), label: shortZone(moment) }
						:	null
					}
					note={
						moment !== null && isHisOwnEvent(moment) ?
							"exact event position"
						: near !== null ?
							`nearest frame, ${Math.abs(Math.round((at ?? 0) - near.m.atSec))}s away`
						:	null
					}
				/>
			)}
		</li>
	)
}

/* ============================================================== disclosure */

/**
 * Everything else, behind one deliberate click.
 *
 * Nothing in here is new information — it is the same data unsummarised, which is exactly why it
 * must not be on the page by default. A screen that shows everything has failed the brief; a
 * screen that hides what he asked for has failed him differently, so it is all here, and it is
 * one click.
 */
const Everything = ({
	gameId,
	detail,
	spine,
	onShot,
	onSeek,
	buriedReview = null
}: {
	gameId: number
	detail: GameDetailResponse
	spine: SpineResponse | null
	onShot: (s: { frameId: string; caption: string }) => void
	/** Move the reader to a game clock — here, to the frame nearest it. */
	onSeek: (tSec: number) => void
	buriedReview?: GameDetailResponse["review"]
}) => {
	const strip = sample(detail.journalFrames, STRIP_N)
	/*
	 * Open on arrival when the buried write-up is the ONLY coaching this game has.
	 *
	 * The cap is still the cap: a numbers game gets no cards, no grade and no promoted fixes, and
	 * the write-up keeps the label saying nothing watched it. What changes is that the click is
	 * gone. 121 of the 123 stored games have no frames, so on nearly every game in the library a
	 * closed disclosure meant the debrief's entire coaching content was one interaction away with
	 * nothing above it to suggest there was anything down here at all.
	 */
	const openOnArrival = buriedReview !== null && buriedReview.items.length > 0
	return (
		<details className="dbf__more" open={openOnArrival}>
			<summary>
				<span>Everything else</span>
				<span className="dim">
					{spine?.objectives.length ?? 0} objectives · {spine?.deaths.length ?? 0} deaths ·{" "}
					{detail.metrics.length} metrics · {detail.journalFrames.length} frames
				</span>
			</summary>

			<div className="dbf__morebody">
				{/*
				 * Asking, which is the natural move after reading a coaching point you disagree with.
				 *
				 * It is in here rather than on the page because the three cards are the argument and a
				 * text box under them invites him to keep going instead of closing the laptop and
				 * playing. Its answers carry the same citation guarantee the cards do — the server
				 * drops any moment or metric id the coach invented — so a reply cannot claim more than
				 * the page above it.
				 */}
				{detail.metrics.length > 0 && (
					<section>
						<h3>
							Ask the coach <span className="dim">about this game</span>
						</h3>
						<CoachChat
							gameId={gameId}
							moments={detail.moments}
							metrics={detail.metrics}
							media={detail.media}
							onSeek={onSeek}
							onSelectMoment={id => {
								const m = detail.moments.find(x => x.id === id)
								if (m) onSeek(m.tSec)
							}}
						/>
					</section>
				)}

				{buriedReview !== null && buriedReview.items.length > 0 && (
					<section>
						<h3>
							The coach's write-up{" "}
							<span className="dim">written from the numbers alone — nothing watched this game</span>
						</h3>
						<ul className="dbf__buried">
							{rankedItems(buriedReview.items).map(it => (
								<li key={it.id}>
									<b>
										{it.tSec !== null && <span className="num">{fmtClock(it.tSec)} </span>}
										<Glossed>{it.title}</Glossed>
									</b>
									{it.fix !== "" && (
										<p>
											<Glossed>{it.fix}</Glossed>
										</p>
									)}
									<span className="dim">
										{it.severity} · rated {it.impact} impact · {it.confidence} confidence
									</span>
								</li>
							))}
						</ul>
					</section>
				)}

				{spine?.available && spine.objectives.length > 0 && (
					<section>
						<h3>Neutral objectives</h3>
						<table className="dbf__table">
							<tbody>
								{spine.objectives.map(o => (
									<tr key={`${o.atSec}-${o.name}`} className={o.side === "enemy" ? "is-against" : "is-for"}>
										<td className="num">{o.clock}</td>
										<td>{o.name}</td>
										<td>{o.takenBy || (o.side === "enemy" ? "the enemy team" : "your team")}</td>
										<td className="dim">{o.zone ?? ""}</td>
									</tr>
								))}
							</tbody>
						</table>
					</section>
				)}

				{spine?.available && spine.deaths.length > 0 && (
					<section>
						<h3>Deaths</h3>
						<table className="dbf__table">
							<tbody>
								{spine.deaths.map(x => (
									<tr key={x.atSec}>
										<td className="num">{x.clock}</td>
										<td>{x.killer || "the map"}</td>
										<td className="dim">{x.zone}</td>
										<td className="num">~{x.downtimeSec}s dead</td>
										<td className="num dim">{x.goldHeld === null ? "" : `${fmtQty(x.goldHeld, "gold")}g in hand`}</td>
									</tr>
								))}
							</tbody>
						</table>
						{/* The one estimate on this screen, named where it is shown. */}
						<p className="dim">{spine.downtimeSource}.</p>
					</section>
				)}

				<section>
					<h3>Every metric, against your own average</h3>
					<table className="dbf__table">
						<tbody>
							{detail.metrics.map(m => (
								<tr key={m.key} title={m.explain}>
									<td>{m.label}</td>
									<td className="num">
										{fmtNumber(m.value)}
										{m.unit === "%" ? "%" : ""}
									</td>
									{/* Signed by the policy, so this column's `-3` is the same glyph as
									    the `−3` every other delta on the screen uses. */}
									<td className={cls("num", `is-${directionOf(m)}`)}>
										{m.vsBaseline === null ? "" : fmtDelta(m.vsBaseline, m.unit, m.value)}
									</td>
									<td className="dim">{baselineLine(m)}</td>
									<td className="dim">{m.confidence}</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>

				{strip.length > 0 && (
					<section>
						<h3>
							Frames <span className="dim">a {strip.length}-frame sample of {detail.journalFrames.length}</span>
						</h3>
						<div className="dbf__strip">
							{strip.map(f => (
								<button key={f.id} onClick={() => onShot({ frameId: f.id, caption: `${fmtClock(f.tSec)} — your screen` })}>
									<img src={`/api/frames/${f.id}`} alt="" loading="lazy" />
									<span>{fmtClock(f.tSec)}</span>
								</button>
							))}
						</div>
					</section>
				)}
			</div>
		</details>
	)
}

/* ==================================================================== bits */

/**
 * Rank by the coach's OWN three ratings, the way `rankItems` does at write time.
 *
 * `priority` is already on the row, so this only breaks ties and tolerates old rows written
 * before the field existed. The ordering is the coach's judgement about his own items and the
 * app's job is to respect it, not to re-derive it from severity.
 */
const rankedItems = (items: readonly FeedbackItem[]): FeedbackItem[] =>
	[...items].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

/** Which quantity a span-shaped card is claiming, from what it cited. Gold is the default
 *  because every checkpoint metric has a gold version and not every one has a CS version. */
const quantityOf = (item: FeedbackItem): "cs" | "gold" =>
	item.metricKeys.some(k => k.toLowerCase().includes("cs")) ? "cs" : "gold"

/**
 * The baseline, printed as the digest wrote it or not at all. Never `value - vsBaseline`.
 *
 * The unit comes along now: a tile reading `30%` over `your average 13.2` asked the reader to
 * assume the second figure was a percentage too. `baselineLabel` still copies the digits and
 * only appends the sign.
 */
const baselineLine = (m: Metric): string => baselineLabel(m)

const roleWord = (role: string): string =>
	role === "JGL" ? "jungle"
	: role === "UNKNOWN" ? ""
	: role.toLowerCase()

/** A death, a kill, a fight: the event position IS where he was. An objective he conceded is
 *  somewhere he was not, and conflating the two is how a map lies. */
const isHisOwnEvent = (m: Moment): boolean =>
	m.kind === "death" || m.kind === "kill" || m.kind === "teamfight" || m.kind === "positioning"

const toPct = (m: Moment): { left: number; top: number } => toMinimapPct({ x: m.mapX, y: m.mapY })

/** "dragon pit" out of "Enemy took hextech dragon at 19:35" is not derivable, so the inset's
 *  label comes from the moment's kind instead of guessing at its prose. */
const shortZone = (m: Moment): string =>
	m.kind === "objective" || m.kind === "objective_missed" ? "the pit" : "here"

const nearestMinute = (
	minutes: readonly SpineResponse["minutes"][number][],
	tSec: number
): { m: SpineResponse["minutes"][number]; gapSec: number } | null => {
	let best: SpineResponse["minutes"][number] | null = null
	let gap = Infinity
	for (const m of minutes) {
		const g = Math.abs(m.atSec - tSec)
		if (g < gap) {
			gap = g
			best = m
		}
	}
	return best === null ? null : { m: best, gapSec: Math.round(gap) }
}

/**
 * The source strip: which channel carried this, and what was true around it.
 *
 * Always present, quiet, and never dressed up. An item whose picture is 6 seconds from the claim
 * says so, because the reader checking the frame against the sentence needs to know how far
 * apart they are before he decides the app is wrong.
 */
const sourceStrip = ({
	item,
	frame,
	moment,
	near
}: {
	item: FeedbackItem
	frame: { id: string; gapSec: number } | null
	moment: Moment | null
	near: { m: SpineResponse["minutes"][number]; gapSec: number } | null
}): string => {
	const channel =
		frame !== null ? `your own screen, ${frame.gapSec}s from the moment`
		: moment !== null ? `${moment.confidence} confidence, ${moment.kind.replace("_", " ")} event`
		: item.tSec === null ? "whole-game figures"
		: "timeline only"

	const state =
		near === null ?
			null
		:	`level ${near.m.levelMe}, ${near.m.csMe} CS, ${fmtQty(near.m.goldMe, "gold")}g` +
			(near.gapSec > 0 ? ` at ${near.m.clock}` : "")

	const rated = `rated ${item.impact} impact · ${item.actionability} actionability`
	return [channel, state, rated].filter(x => x !== null).join(" · ")
}

/** An evenly spaced sample, so a strip of 16 spans the game instead of its first two minutes. */
const sample = <T,>(list: readonly T[], n: number): T[] => {
	if (list.length <= n) return [...list]
	const step = (list.length - 1) / (n - 1)
	return Array.from({ length: n }, (_, i) => list[Math.round(i * step)]!)
}
