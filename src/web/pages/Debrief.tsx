/**
 * The debrief: the screen you see in the fifteen seconds after a game.
 *
 * ## What it is for
 *
 * Not the full review — that still exists and this links to it. This is the thing you actually
 * read, once, while the post-game lobby is still up: three moments, a picture each, one line of
 * what to do differently. Everything else is behind one disclosure.
 *
 * ## The gate is the whole design
 *
 * A game is either `watched` — your screen was shared, so there are frames and the coach could
 * see what happened — or `numbers`, where all that exists is a per-minute timeline that knows
 * where you stood and nothing about how you played.
 *
 * An unwatched game gets FACTS AND NO OPINIONS. No grade, no coaching, no "you should have".
 * That is not a UI mode, it is the structural version of the lesson this app learned the
 * expensive way: for most of its life it produced confident coaching from data that could not
 * support it, and no amount of prompt work fixes a claim that was never checkable.
 *
 * The ungraded state is written to read as a consequence of how the game was recorded, never as
 * a punishment or a broken screen. He did nothing wrong by not sharing his screen.
 */

import { useEffect, useMemo, useState } from "react"
import type { GameDetailResponse } from "../../shared/schema/api.ts"
import { api } from "../lib/api.ts"
import { evidenceOf, TIER_EXPLAIN, TIER_LABEL } from "../../shared/evidence.ts"
import { fmtClock } from "../../shared/time.ts"
import { href } from "../lib/hooks.ts"
import { Glossed } from "../components/Term.tsx"
import "../components/components.css"

/** Three. Not four, and never six — this is read once, standing up. */
const TOP_N = 3

export const Debrief = ({ gameId }: { gameId: number }) => {
	const [d, setD] = useState<GameDetailResponse | null>(null)
	const [err, setErr] = useState<string | null>(null)
	const [open, setOpen] = useState(false)

	useEffect(() => {
		let alive = true
		void api
			.game(gameId)
			.then(r => alive && setD(r))
			.catch(e => alive && setErr(e instanceof Error ? e.message : String(e)))
		return () => {
			alive = false
		}
	}, [gameId])

	/*
	 * The tier is computed from the frames that exist, at read time, never stored on the row. That
	 * way the threshold can move without a migration and without rewriting history.
	 */
	const evidence = useMemo(() => {
		if (!d) return null
		const frames = d.media.filter(m => m.source === "journal").map(m => m.tSec ?? -1)
		return evidenceOf({ frameTimesSec: frames, gameDurationSec: d.game.gameDurationSec ?? 0 })
	}, [d])

	if (err !== null) return <div className="notice bad">Couldn't load that game: {err}</div>
	if (!d || !evidence) return <div className="empty">Loading…</div>

	const g = d.game
	const watched = evidence.tier === "watched"

	/*
	 * Ranked items when the game was watched; the biggest swings against his own baseline when it
	 * was not. Two different questions, so two different lists — an unwatched game is not a
	 * watched one with the opinions greyed out.
	 */
	const items = watched ? (d.review?.items ?? []).slice(0, TOP_N) : []
	const facts = !watched ? topFacts(d, TOP_N) : []

	const frameFor = (tSec: number | null): string | null => {
		if (tSec === null) return null
		const near = d.media
			.filter(m => m.source === "journal" && m.tSec !== null)
			.sort((a, b) => Math.abs((a.tSec ?? 0) - tSec) - Math.abs((b.tSec ?? 0) - tSec))[0]
		return near && Math.abs((near.tSec ?? 0) - tSec) <= 15 ? `/api/media/${near.id}` : null
	}

	return (
		<div className="debrief">
			<header className="debrief__head">
				<div>
					<h1>
						{g.win ? "Win" : "Loss"} as {g.championName}
						<span className="debrief__score">
							{g.kills}/{g.deaths}/{g.assists}
						</span>
					</h1>
					<p className="debrief__sub">
						{Math.round((g.gameDurationSec ?? 0) / 60)} minutes · {g.cs + (g.jungleCs ?? 0)} CS
					</p>
				</div>

				{/*
				 * The tier badge, stated plainly rather than implied by an absence. A screen with no
				 * grade and no explanation reads as broken; a screen that says why reads as honest.
				 */}
				<div className={`debrief__tier debrief__tier--${evidence.tier}`}>
					<b>{TIER_LABEL[evidence.tier]}</b>
					{watched ?
						<span>{Math.round(evidence.coverage * 100)}% of the game on screen</span>
					:	<span>{evidence.shortfall}</span>}
				</div>
			</header>

			<p className="debrief__explain">{TIER_EXPLAIN[evidence.tier]}</p>

			{watched ?
				items.length === 0 ?
					<div className="empty">
						<h2>The review is still being written</h2>
						<p>It usually takes about twenty seconds. This page updates itself.</p>
					</div>
				:	<ol className="debrief__cards">
						{items.map(item => {
							const src = frameFor(item.tSec)
							return (
								<li key={item.id} className="debrief__card">
									{src ?
										<img className="debrief__shot" src={src} alt="" loading="lazy" />
									:	<div className="debrief__shot debrief__shot--none">
											no frame at {item.tSec === null ? "this moment" : fmtClock(item.tSec)}
										</div>
									}
									<div className="debrief__body">
										{item.tSec !== null && (
											<span className="debrief__when">{fmtClock(item.tSec)}</span>
										)}
										<h3>
											<Glossed>{item.title}</Glossed>
										</h3>
										{item.fix ?
											<p className="debrief__fix">
												<Glossed>{item.fix}</Glossed>
											</p>
										:	null}
									</div>
								</li>
							)
						})}
					</ol>

			:	<ol className="debrief__cards debrief__cards--facts">
					{facts.map(f => (
						<li key={f.key} className="debrief__card debrief__card--fact">
							<div className="debrief__body">
								<h3>{f.title}</h3>
								<p className="debrief__factsub">{f.sub}</p>
							</div>
						</li>
					))}
				</ol>
			}

			{/*
			 * One disclosure, and everything that is not one of the three lives behind it. The wall
			 * of text this app already had to delete once got there by being additive.
			 */}
			<details className="csk-drill" open={open} onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
				<summary>
					<span>Everything else</span>
					<span className="faint" style={{ fontSize: 11.5 }}>
						the full review, every metric, the map
					</span>
				</summary>
				<p style={{ padding: "0 14px 12px" }}>
					<a className="btn" href={href.game(gameId)}>
						Open the full review →
					</a>
				</p>
			</details>
		</div>
	)
}

/**
 * The biggest moves against his own baseline, for a game nobody watched.
 *
 * Facts, in the strict sense: a measured value and the average it is being compared with. No
 * severity, no fix, no ranking by "impact" — impact is a judgement and judgement needs evidence.
 */
const topFacts = (
	d: GameDetailResponse,
	n: number
): { key: string; title: string; sub: string }[] =>
	[...d.metrics]
		.filter(m => m.vsBaseline !== null && Number.isFinite(m.vsBaseline) && m.confidence !== "low")
		.sort((a, b) => Math.abs(b.vsBaseline ?? 0) / (Math.abs(b.value) || 1) - Math.abs(a.vsBaseline ?? 0) / (Math.abs(a.value) || 1))
		.slice(0, n)
		.map(m => ({
			key: m.key,
			title: `${m.label}: ${m.value}${m.unit === "%" ? "%" : ""}`,
			sub: `${(m.vsBaseline ?? 0) > 0 ? "+" : ""}${Math.round(m.vsBaseline ?? 0)} against your own recent average`
		}))
