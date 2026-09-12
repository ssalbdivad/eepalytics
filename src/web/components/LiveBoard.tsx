/**
 * THE BOARD — the quiet half of the live coach.
 *
 * ## What it is for
 *
 * Every useful live line this app has ever produced had the same three parts: a WINDOW (an
 * objective clock or a respawn timer), WHERE the contest will be, and WHETHER HE CAN BE THERE.
 * All three are computed in TypeScript; the model only ever chose one and phrased it.
 *
 * The measurement that produced this component is about the CONTAINER rather than the content. Of
 * 396 judged-useful live lines, 48% carried only a standing state and 37% carried a window whose
 * median named life was 40 seconds — about one line in a hundred was short-lived enough that
 * interrupting him with it was the right call. Meanwhile the shipped coach spoke every 29 seconds
 * and occupied 19.5% of the game clock, and the lines that went stale mid-sentence were the
 * COUNTDOWNS: 5 of 7 "N enemies down" windows and 1 of 2 jungler-down windows had stopped being
 * true by their last syllable, one of them because the man died while the sentence was being said.
 *
 * A countdown is the worst possible payload for a sentence and the cheapest possible payload for a
 * panel. So the standing state comes here, where it is always current and costs nothing until he
 * looks, and speech is left for the rare thing that cannot wait.
 *
 * ## The one rule
 *
 * Nothing on this board is a claim, an instruction or a judgement. It is a set of readings, and a
 * reading this app does not have renders as the word for not having it — never as a zero, never as
 * the last value still sitting on screen looking live. A position ninety seconds old has to LOOK
 * ninety seconds old; a minimap read the client refused has to look like no read at all, because
 * the failure this whole surface is aimed at is a stale number that reads as a fresh one.
 *
 * ## Where the numbers come from
 *
 * One poll of `GET /api/live/board`, which is a stateless projection of the daemon's own
 * computations — the same `projectTick`, the same objective instances, the same carried minimap
 * read and the same travel arithmetic the coach's brief is built from. The page does no arithmetic
 * about the game except subtracting elapsed wall-clock seconds from the clocks it was handed, so
 * there is nothing here that can disagree with what she says.
 */

import { useEffect, useRef, useState } from "react"
import { age, clock, csFloor, freshnessOf, reachText } from "../lib/boardView.ts"
import type { BoardObjective, BoardRead } from "../lib/boardView.ts"
import { fmtQty } from "../../shared/num.ts"
import "./components.css"

/**
 * How often the board is refreshed.
 *
 * Two seconds against a daemon that is already polling the same endpoint on its own five-second
 * beat, over a bridge measured at single-digit milliseconds. It is fast enough that a death or a
 * take never sits wrong on screen for longer than a glance, and the countdowns are interpolated
 * between polls anyway — so this is about how quickly a CHANGE lands, not about smoothness.
 */
const POLL_MS = 2000

/** The interpolation beat. One second, because every clock on this board is quoted in seconds. */
const TICK_MS = 1000

/**
 * How long a failed poll may go unmentioned.
 *
 * One dropped poll during a loading screen or an alt-tab is normal and saying so would be noise;
 * a run of them is the daemon being gone, which is the difference between a quiet board and a dead
 * one. Same shape as the coach's own fault counters, and the same reason: silence that looks like
 * breakage is a failure this app has had before.
 */
const STALE_AFTER_MS = 8000

interface BoardPayload {
	inGame: boolean
	clientUp: boolean
	gameTimeSec?: number
	freshSec: number
	carrySec: number
	me?: {
		champion: string
		level: number
		hp: number
		maxHp: number
		mana: number
		maxMana: number
		manaType: string
		gold: number
		cs: number
		k: number
		d: number
		a: number
		dead: boolean
		respawnSec: number
	}
	counterpart?: {
		champion: string
		level: number | null
		cs: number | null
		dead: boolean
		respawnSec: number
		inferred: boolean
	} | null
	objectives?: BoardObjective[]
	read?: BoardRead | null
	watcher?: { enabled: boolean; offered: number; accepted: number; refused: number; lastReason: string | null }
	down?: { champion: string; mine: boolean; respawnSec: number }[]
}

export interface LiveBoardProps {
	/** The 380px window. Same readings, fewer of them, no prose. */
	compact?: boolean
}

export const LiveBoard = ({ compact = false }: LiveBoardProps) => {
	const [board, setBoard] = useState<BoardPayload | null>(null)
	/** When the payload on screen was fetched, so every clock on it can be aged honestly. */
	const [atMs, setAtMs] = useState<number | null>(null)
	const [failedSinceMs, setFailedSinceMs] = useState<number | null>(null)
	const [, setBeat] = useState(0)
	const inFlight = useRef(false)

	useEffect(() => {
		let alive = true
		const poll = async () => {
			if (inFlight.current) return
			inFlight.current = true
			try {
				const r = await fetch("/api/live/board", { signal: AbortSignal.timeout(3000) })
				if (!r.ok) throw new Error(`HTTP ${r.status}`)
				const j = (await r.json()) as BoardPayload
				if (!alive) return
				setBoard(j)
				setAtMs(Date.now())
				setFailedSinceMs(null)
			} catch {
				/*
				 * The last good board stays on screen and starts visibly ageing rather than being
				 * replaced by an error — but it is never silently left looking live. See
				 * `STALE_AFTER_MS`: one dropped poll is normal, a run of them is the daemon gone.
				 */
				if (alive) setFailedSinceMs(p => p ?? Date.now())
			} finally {
				inFlight.current = false
			}
		}
		void poll()
		const id = setInterval(() => void poll(), POLL_MS)
		return () => {
			alive = false
			clearInterval(id)
		}
	}, [])

	/*
	 * The interpolation beat.
	 *
	 * Every clock below is quoted as of `atMs` and redrawn each second with the elapsed wall time
	 * subtracted. The game clock and the wall clock advance together while a game is running, and
	 * the one thing that separates them — a PAUSE — makes this read as MORE elapsed than really
	 * happened: a window looks nearer and a read looks older, which are the two directions that
	 * cost silence rather than a wrong confident number.
	 */
	useEffect(() => {
		const id = setInterval(() => setBeat(b => b + 1), TICK_MS)
		return () => clearInterval(id)
	}, [])

	if (board === null)
		return (
			<div className={`csk-board${compact ? " csk-board--compact" : ""}`}>
				<div className="csk-board__none">
					{failedSinceMs === null ? "reading the game…" : "can't reach eepalytics"}
				</div>
			</div>
		)

	const elapsed = atMs === null ? 0 : (Date.now() - atMs) / 1000
	const stale = failedSinceMs !== null && Date.now() - failedSinceMs > STALE_AFTER_MS

	if (!board.inGame)
		return (
			<div className={`csk-board${compact ? " csk-board--compact" : ""}`}>
				<div className="csk-board__none">
					{board.clientUp ? "no game running" : "the League client is closed"}
				</div>
			</div>
		)

	const me = board.me
	const cp = board.counterpart ?? null
	const fresh = freshnessOf(board.read, board.freshSec, board.carrySec)
	/*
	 * THERE IS NO CS GAP ON THIS BOARD, and its absence is the considered part.
	 *
	 * The obvious row to build here is his farm against the counterpart's — it is the one
	 * comparison a jungler cannot make by looking at his screen, and the app has wanted it for
	 * months. It cannot be built from this feed. The enemy's `creepScore` is a VISIBILITY counter:
	 * on the one game with a ground truth beside it, it read 70 against a true 183, exact in 2 of
	 * 29 checkpoints. His own figure is accurate, so the error is one-sided and the difference is
	 * biased in a single direction — it tells him he is ahead when he is behind. Twenty-four of the
	 * sixty-three lines of the game he graded 0/10 leaned on exactly that number.
	 *
	 * So the counterpart row carries what the feed reports exactly — level, alive or dead and for
	 * how long — plus his seen-CS labelled as what it is, and no arithmetic joins the two. A
	 * comparison that is confidently backwards is worse than no comparison, and this one has
	 * already been measured backwards.
	 */

	return (
		<div className={`csk-board${compact ? " csk-board--compact" : ""}${stale ? " csk-board--stale" : ""}`}>
			{stale && (
				<div className="csk-board__stale">
					Not updating — eepalytics hasn't answered for {age((Date.now() - (failedSinceMs ?? 0)) / 1000)}.
					Everything below is that old.
				</div>
			)}

			{/*
			 * NEXT — the window, and whether he can be in it.
			 *
			 * One row per objective instance the coach is asked about, so the board and the coach
			 * can never be counting down to different drakes. The travel time is the part no HUD
			 * shows him and the only part of this row that is ever absent.
			 */}
			<div className="csk-board__sec">
				<div className="csk-board__lab">next</div>
				{(board.objectives ?? []).length === 0 ?
					<div className="csk-board__none">nothing scheduled</div>
				:	<ul className="csk-board__objs">
						{(board.objectives ?? []).map(o => {
							const windowSec = o.windowSec - elapsed
							const up = windowSec <= 0
							return (
								<li key={o.label} className={up ? "up" : ""}>
									<span className="n">{o.label}</span>
									<span className="w">{up ? `up ${clock(-windowSec)}` : clock(windowSec)}</span>
									<span className="e">{reachText(o, elapsed)}</span>
								</li>
							)
						})}
					</ul>
				}
			</div>

			{/*
			 * WHERE — his own last read, with its age worn on the outside.
			 *
			 * This is the reading the whole staleness rule exists for. It is his own icon and
			 * nobody else's: the reader cannot tell one enemy dot from another, and 16 of its
			 * refusals on the graded game were exactly that mistake.
			 */}
			<div className="csk-board__sec">
				<div className="csk-board__lab">you are</div>
				{fresh === "unknown" ?
					<div className="csk-board__none" title={watcherTitle(board)}>
						unknown
						{board.read ? <em> · last read {age(board.read.ageSec + elapsed)} ago</em> : null}
						{board.watcher && !board.watcher.enabled ? <em> · map watcher off</em> : null}
						{board.watcher && board.watcher.enabled && board.watcher.accepted === 0 ?
							<em> · {board.watcher.refused} read{board.watcher.refused === 1 ? "" : "s"} refused, none accepted</em>
						:	null}
					</div>
				:	<div className={`csk-board__where ${fresh}`} title={watcherTitle(board)}>
						<b>{board.read?.label}</b>
						<em>
							{fresh === "now" ?
								`read ${age((board.read?.ageSec ?? 0) + elapsed)} ago`
							:	`where you WERE ${age((board.read?.ageSec ?? 0) + elapsed)} ago`}
						</em>
					</div>
				}
			</div>

			{/*
			 * THE RACE — the enemy jungler, who is the one thing on this board he cannot look up.
			 *
			 * Level and death state are exact off the feed. His CS is a VISIBILITY counter and is
			 * not: it counts what this client has seen him take, and on the one game with a ground
			 * truth it read 70 against a true 183. So it is printed as what it is — a floor on what
			 * has been SEEN — and never as a comparison in prose.
			 */}
			<div className="csk-board__sec">
				<div className="csk-board__lab">counterpart</div>
				{cp === null ?
					<div className="csk-board__none">no enemy jungler identified</div>
				:	<div className="csk-board__cp">
						<b>{cp.champion}</b>
						{cp.inferred && <em title="Identified by Smite rather than a declared position.">?</em>}
						<span className="v">{cp.level === null ? "—" : `lv${cp.level}`}</span>
						<span
							className="v"
							title="What this client has SEEN him farm, floored to a multiple of ten. It is a visibility counter, not his farm: measured on one game it read 70 against a true 183."
						>
							{csFloor(cp.cs)} seen
						</span>
						{cp.dead ?
							<span className="v dead">down {clock(cp.respawnSec - elapsed)}</span>
						:	<span className="v">alive</span>}
					</div>
				}
			</div>

			{/*
			 * DOWN — who is on the respawn screen and for how long.
			 *
			 * Exact, not fog-gated, and the single most perishable fact in the game — which is
			 * precisely why it belongs on a panel and not in a sentence: a "three of them are down"
			 * line takes four seconds to say and two of the three measured ones had stopped being
			 * true before the last syllable.
			 */}
			{!compact && (
				<div className="csk-board__sec">
					<div className="csk-board__lab">down</div>
					{(board.down ?? []).length === 0 ?
						<div className="csk-board__none">everyone is up</div>
					:	<ul className="csk-board__down">
							{(board.down ?? [])
								.slice()
								.sort((a, b) => a.respawnSec - b.respawnSec)
								.map(d => (
									<li key={`${d.champion}-${d.mine}`} className={d.mine ? "mine" : "theirs"}>
										<span className="n">{d.champion}</span>
										<span className="w">{clock(d.respawnSec - elapsed)}</span>
									</li>
								))}
						</ul>
					}
				</div>
			)}

			{/*
			 * YOU — the four readings that are exact for him and nobody else.
			 *
			 * Health, mana and gold exist in this feed for the player alone. They are on his HUD, so
			 * this row earns nothing by being surprising; it earns its place by being in the same
			 * glance as the window and the walk, which is the comparison he would otherwise make by
			 * looking at three corners of the screen in turn.
			 */}
			{me && (
				<div className="csk-board__you">
					<span title="Your own level.">lv{me.level}</span>
					<span title="Your CS, floored to a multiple of ten by the client — your HUD shows the exact one.">
						{csFloor(me.cs)} cs
					</span>
					<span title="Gold in hand.">{fmtQty(me.gold, "gold")}g</span>
					{me.maxMana > 0 && (
						<span title={`${Math.round(me.mana)} of ${Math.round(me.maxMana)} ${me.manaType.toLowerCase() || "mana"}.`}>
							{Math.round((me.mana / me.maxMana) * 100)}% {me.manaType.toLowerCase() || "mana"}
						</span>
					)}
					{me.maxHp > 0 && (
						<span title={`${Math.round(me.hp)} of ${Math.round(me.maxHp)} health.`} className={me.hp / me.maxHp < 0.35 ? "low" : ""}>
							{Math.round((me.hp / me.maxHp) * 100)}% hp
						</span>
					)}
					<span title="Kills / deaths / assists.">
						{me.k}/{me.d}/{me.a}
					</span>
					{me.dead && <span className="dead">respawn {clock(me.respawnSec - elapsed)}</span>}
				</div>
			)}
		</div>
	)
}

/** What the minimap watcher is doing, as the tooltip behind every position reading. */
const watcherTitle = (board: BoardPayload): string => {
	const w = board.watcher
	if (!w) return "The minimap watcher's state is not known."
	if (!w.enabled) return "The minimap watcher is off, so nothing on this machine is reading your position."
	return `Minimap reads this game: ${w.accepted} accepted, ${w.refused} refused by the client's own fence.${
		w.lastReason ? ` Last refusal: ${w.lastReason}.` : ""
	} A refused read is the fence working — it is never shown here as a position.`
}
