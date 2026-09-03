/**
 * The picker. One row per game, dense enough to scan a night's worth of solo queue and
 * decide which game actually hurt.
 *
 * Row state comes from three sources and each is labelled as what it is: the stored game
 * row, the live job queue (so "Reviewing…" and "Capture deferred — <reason>" are real,
 * not guessed), and the 30-minute replay clock, which is shown as a countdown because a
 * silently-missed window is the one failure the user can never recover from.
 */

import { useMemo, useState } from "react"
import type { GameListItem, HealthResponse } from "../../shared/schema/api.ts"
import type { Job } from "../../shared/schema/domain.ts"
import { effectiveCs, csPerMin } from "../../shared/schema/domain.ts"
import { queueName } from "../../shared/constants.ts"
import { api } from "../lib/api.ts"
import { href, navigate, useAction, useLocalState, useNow, useResource } from "../lib/hooks.ts"
import {
	cls,
	fmtAgo,
	fmtCompact,
	fmtDuration,
	fmtKda,
	fmtKdaRatio,
	jobKindLabel,
	jobReason,
	replayCountdown,
	roleLabel
} from "../lib/format.ts"
import { ChampIcon } from "../components/ChampIcon.tsx"
import { JobBadge } from "../components/JobBadge.tsx"

/* ------------------------------------------------- review headline hooks */

/**
 * Headlines now arrive on `GameListItem` itself.
 *
 * This used to fetch `/api/games/:id` once per row to pull out a single string — thirty
 * sequential round trips to render one screen, growing with the history rather than with what
 * is on screen, plus a module-level cache that had to be invalidated by hand on every SSE
 * review event. One extra column on the list query replaced all of it.
 */
const headlineOf = (g: GameListItem): string | null => g.headline ?? null

/* ------------------------------------------------------------ filtering */

type ResultFilter = "all" | "win" | "loss"

const matches = (
	g: GameListItem,
	result: ResultFilter,
	queue: number | "all",
	search: string
): boolean => {
	if (result === "win" && !g.win) return false
	if (result === "loss" && g.win) return false
	if (queue !== "all" && g.queueId !== queue) return false
	if (search !== "") {
		const hay = `${g.championName} ${roleLabel(g.role)} ${queueName(g.queueId)}`.toLowerCase()
		if (!hay.includes(search.toLowerCase().trim())) return false
	}
	return true
}

/* ------------------------------------------------------------- the page */

export interface GameListProps {
	health: HealthResponse | null
	eventTick: number
}

export const GameList = ({ health, eventTick }: GameListProps) => {
	const games = useResource(signal => api.games(200, signal), [eventTick])
	const jobs = useResource(signal => api.jobs(signal), [eventTick])
	const now = useNow(15_000)

	const [result, setResult] = useLocalState<ResultFilter>("filter.result", "all")
	const [queue, setQueue] = useLocalState<number | "all">("filter.queue", "all")
	const [search, setSearch] = useState("")

	const sync = useAction(() => api.sync())

	const all = useMemo(
		() => [...(games.data?.games ?? [])].sort((a, b) => b.gameCreationMs - a.gameCreationMs),
		[games.data]
	)

	const queues = useMemo(() => {
		const seen = new Map<number, number>()
		for (const g of all) seen.set(g.queueId, (seen.get(g.queueId) ?? 0) + 1)
		return [...seen.entries()].sort((a, b) => b[1] - a[1])
	}, [all])

	const jobsByGame = useMemo(() => {
		const map = new Map<number, Job[]>()
		for (const j of jobs.data?.jobs ?? []) {
			if (j.gameId === null) continue
			if (j.state === "done") continue
			const list = map.get(j.gameId)
			if (list) list.push(j)
			else map.set(j.gameId, [j])
		}
		return map
	}, [jobs.data])

	const shown = useMemo(
		() => all.filter(g => matches(g, result, queue, search)),
		[all, result, queue, search]
	)

	if (games.loading)
		return (
			<div className="page">
				<div className="page-head">
					<h1>Games</h1>
				</div>
				{[0, 1, 2, 3, 4].map(i => (
					<div className="skeleton skeleton-row" key={i} />
				))}
			</div>
		)

	if (all.length === 0) return <EmptyState health={health} games={games} sync={sync} />

	const wins = shown.filter(g => g.win).length

	return (
		<div className="page">
			<div className="page-head">
				<h1>Games</h1>
				<div className="sub">
					{shown.length} shown · {wins}W {shown.length - wins}L
					{games.refreshing ? " · refreshing…" : ""}
				</div>
				<div className="spacer" />
				<button onClick={sync.run} disabled={sync.pending}>
					{sync.pending ? "Syncing…" : "Sync from client"}
				</button>
			</div>

			{games.error ?
				<div className="notice warn" style={{ marginBottom: 12 }}>
					<span className="icon">⚠</span>
					<div>
						<strong>Showing the last data this tab loaded.</strong> {games.error}
					</div>
				</div>
			:	null}
			{sync.error ?
				<div className="notice bad" style={{ marginBottom: 12 }}>
					<span className="icon">✗</span>
					<div>Sync failed: {sync.error}</div>
				</div>
			:	null}

			<div className="filters">
				<div className="seg">
					{(["all", "win", "loss"] as const).map(r => (
						<button
							key={r}
							className={cls(result === r && "active")}
							onClick={() => setResult(r)}
						>
							{r === "all" ? "All" : r === "win" ? "Wins" : "Losses"}
						</button>
					))}
				</div>

				<select
					value={String(queue)}
					onChange={e => setQueue(e.target.value === "all" ? "all" : Number(e.target.value))}
				>
					<option value="all">All queues</option>
					{queues.map(([id, n]) => (
						<option key={id} value={id}>
							{queueName(id)} ({n})
						</option>
					))}
				</select>

				<input
					type="search"
					placeholder="champion, role, queue…"
					value={search}
					onChange={e => setSearch(e.target.value)}
					style={{ minWidth: 200 }}
				/>
			</div>

			{shown.length === 0 ?
				<div className="empty">
					<h2>Nothing matches</h2>
					<p>
						{all.length} game{all.length === 1 ? "" : "s"} stored, none of them fit these
						filters.
					</p>
				</div>
			:	<div className="game-rows">
					{shown.map(g => (
						<GameRow
							key={g.gameId}
							game={g}
							jobs={jobsByGame.get(g.gameId) ?? []}
							headline={headlineOf(g)}
							now={now}
						/>
					))}
				</div>
			}
		</div>
	)
}

/* --------------------------------------------------------------- a row */

interface GameRowProps {
	game: GameListItem
	jobs: Job[]
	headline: string | null
	now: number
}

const GameRow = ({ game: g, jobs, headline, now }: GameRowProps) => {
	const go = () => navigate(href.game(g.gameId))
	const cs = effectiveCs(g)
	const perMin = csPerMin(g, g.gameDurationSec)
	const countdown =
		g.replayState === "absent" || g.replayState === "downloading" ?
			replayCountdown(g.endedAtMs, now)
		:	null

	return (
		<div
			className={cls("game-row", g.win ? "win" : "loss")}
			role="link"
			tabIndex={0}
			onClick={go}
			onKeyDown={e => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault()
					go()
				}
			}}
		>
			<div className="champ">
				<ChampIcon championId={g.championId} size={52} />
				<span className="lvl">{g.champLevel}</span>
			</div>

			<div className="main">
				<div className="line1">
					<span className="name">{g.championName}</span>
					<span className="dim">{roleLabel(g.role)}</span>
					{g.roleConfidence !== "high" ?
						<span
							className="chip muted"
							title={`Role was inferred from frame positions and Smite, confidence: ${g.roleConfidence}`}
						>
							role {g.roleConfidence}
						</span>
					:	null}
					<span className="faint">·</span>
					<span className="dim">{queueName(g.queueId)}</span>
					<span className="faint">·</span>
					<span className="dim">{fmtDuration(g.gameDurationSec)}</span>
					<span className="faint">·</span>
					<span className="dim">patch {g.patch}</span>
				</div>

				<div className="line2">
					<span>
						<b>{fmtKda(g.kills, g.deaths, g.assists)}</b>{" "}
						<span className="faint">{fmtKdaRatio(g.kills, g.deaths, g.assists)} KDA</span>
					</span>
					<span>
						CS <b>{cs}</b> <span className="faint">{perMin.toFixed(1)}/m</span>
					</span>
					<span>
						VS <b>{g.visionScore}</b>
					</span>
					<span>
						DMG <b>{fmtCompact(g.damageToChampions)}</b>
					</span>
					<span>
						Gold <b>{fmtCompact(g.gold)}</b>
					</span>
				</div>

				{headline ? <div className="hook">“{headline}”</div> : null}

				<div className="badges">
					{g.hasReview ?
						<span className="chip gold">
							review ready{g.momentCount > 0 ? ` · ${g.momentCount} moments` : ""}
						</span>
					:	<span className="chip muted">no review yet</span>}
					{g.mediaCount > 0 ?
						<span className="chip">
							{g.mediaCount} media
						</span>
					:	null}
					{!g.hasTimeline ?
						<span className="chip warn" title="No timeline blob — no positional analysis">
							no timeline
						</span>
					:	null}
					{g.replayState === "available" ?
						<span className="chip">replay saved</span>
					: g.replayState === "expired" ?
						<span className="chip muted" title="The 30-minute download window closed">
							replay expired
						</span>
					: g.replayState === "pruned" ?
						<span className="chip muted">replay pruned</span>
					: countdown ?
						<span className="chip warn" title="Replays are only downloadable for 30 minutes">
							⧗ {countdown}
						</span>
					:	null}
					{jobs.map(j => (
						<span key={j.id} title={jobReason(j) ?? jobKindLabel(j.kind)}>
							<JobBadge job={j} />
						</span>
					))}
				</div>
			</div>

			<div className="right">
				<span className={cls("result", g.win ? "win" : "loss")}>{g.win ? "WIN" : "LOSS"}</span>
				<span className="when" title={new Date(g.gameCreationMs).toLocaleString()}>
					{fmtAgo(g.gameCreationMs, now)}
				</span>
				<span className="go">Review →</span>
			</div>
		</div>
	)
}

/* ------------------------------------------------------- the blank page */

const EmptyState = ({
	health,
	games,
	sync
}: {
	health: HealthResponse | null
	games: { error: string | null; errorDetail: string | null; reload: () => void }
	sync: ReturnType<typeof useAction>
}) => {
	const unreachable = games.error !== null
	return (
		<div className="page">
			<div className="empty">
				<h2>{unreachable ? "Can't reach the daemon" : "No games yet"}</h2>
				{unreachable ?
					<>
						<p>
							The web UI is running, but nothing is answering on the API. The daemon is the
							system of record — it talks to the League client and owns the database.
						</p>
						<ol>
							<li>
								Start it: <code className="mono">pnpm daemon</code> (or{" "}
								<code className="mono">systemctl --user start coachskaffur</code>)
							</li>
							<li>
								Check it: <code className="mono">pnpm doctor</code>
							</li>
							<li>This page will reconnect on its own once it's up.</li>
						</ol>
						{games.errorDetail ?
							<div className="notice bad" style={{ textAlign: "left", maxWidth: 640, margin: "0 auto" }}>
								<span className="icon">✗</span>
								<div>
									<strong>{games.error}</strong>
									<pre>{games.errorDetail}</pre>
								</div>
							</div>
						:	null}
					</>
				:	<>
						<p>
							The daemon is up but hasn't ingested a game yet. It reads your finished matches
							out of the running League client, so it needs the client open at least once.
						</p>
						<ol>
							<li>
								Open the League client.{" "}
								{health?.lcu === "connected" ?
									<span className="band-good">It's connected right now.</span>
								:	<span className="band-bad">It's not connected right now.</span>}
							</li>
							<li>Hit “Sync from client” — it pulls the recent match history window.</li>
							<li>
								Play a game. New games are ingested automatically the moment they end, and the
								replay is downloaded inside its 30-minute window.
							</li>
						</ol>
					</>
				}
				<div className="actions">
					<button className="btn-primary" onClick={sync.run} disabled={sync.pending}>
						{sync.pending ? "Syncing…" : "Sync from client"}
					</button>
					<button onClick={games.reload}>Retry</button>
				</div>
				{sync.error ?
					<div className="notice bad" style={{ marginTop: 16, textAlign: "left" }}>
						<span className="icon">✗</span>
						<div>{sync.error}</div>
					</div>
				:	null}
			</div>
		</div>
	)
}
