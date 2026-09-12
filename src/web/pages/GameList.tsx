/**
 * The picker. One row per game, dense enough to scan a night's worth of solo queue and
 * decide which game actually hurt.
 *
 * Row state comes from three sources and each is labelled as what it is: the stored game
 * row, the live job queue (so "Reviewing…" and "Download waiting — <reason>" are real, not
 * guessed), and the 30-minute replay clock, which is shown as a countdown because a
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
import { FormHeadline, FormPanel } from "../components/FormPanel.tsx"
import { Glossed } from "../components/Term.tsx"
import { GradeBadge } from "../components/GradeBadge.tsx"
import { JobBadge } from "../components/JobBadge.tsx"
import { Blank, Broken, Loading } from "../components/States.tsx"

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

/* ----------------------------------------------------------- pagination */

/**
 * Rows per page.
 *
 * The list rendered all 123 stored games in one column, and it grows by about ten a night. Nobody
 * scrolls past the second screenful, so everything below it was pure cost: 123 rows x an icon, a
 * grade, a headline and eight chips, re-rendered on every SSE tick the daemon emits while he
 * plays. Twenty-five is roughly a night and a half of solo queue — the span he actually reviews.
 *
 * The paging is CLIENT-side on purpose: the filters, the queue counts and the W/L tally all need
 * the whole history, the route already ships it in one request, and a server page would make
 * "Losses only" mean "losses on page three".
 */
const PAGE_SIZE = 25

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
	const form = useResource(signal => api.form(undefined, signal), [eventTick])
	const jobs = useResource(signal => api.jobs(signal), [eventTick])
	const now = useNow(15_000)

	const [result, setResult] = useLocalState<ResultFilter>("filter.result", "all")
	const [queue, setQueue] = useLocalState<number | "all">("filter.queue", "all")
	const [search, setSearch] = useState("")
	/*
	 * Deliberately NOT persisted, unlike the filters beside it. A filter is a standing preference
	 * ("I only care about losses"); a page number is where you happened to be, and coming back
	 * tomorrow to page 4 of a list whose first page is now last night's games is a bug.
	 */
	const [page, setPage] = useState(0)

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

	const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
	// Clamp rather than reset: a filter that shrinks the list should leave you on its last page,
	// not silently back at the top with no explanation for where the rows went.
	const current = Math.min(page, pageCount - 1)
	const first = current * PAGE_SIZE
	const rows = shown.slice(first, first + PAGE_SIZE)
	const show = (n: number) => {
		setPage(n)
		window.scrollTo({ top: 0 })
	}

	if (games.loading)
		return (
			<div className="page">
				<div className="page-head">
					<h1>Games</h1>
				</div>
				<Loading rows={5} height={96} label="Loading your games" />
			</div>
		)

	if (all.length === 0) return <EmptyState health={health} games={games} sync={sync} />

	const wins = shown.filter(g => g.win).length
	const reviewed = shown.filter(g => g.hasReview).length

	return (
		<div className="page">
			<div className="page-head">
				<h1>Games</h1>
				<div className="sub">
					{/* The tally is over the FILTER, not the page: "12W 9L" that changed when you
					    clicked next would be meaningless. */}
					{shown.length === 0 ?
						"nothing shown"
					:	`${first + 1}–${Math.min(first + PAGE_SIZE, shown.length)} of ${shown.length}`}{" "}
					· {wins}W {shown.length - wins}L · {reviewed} reviewed
					{games.refreshing ? " · refreshing…" : ""}
				</div>
				<div className="spacer" />
				<button
					onClick={sync.run}
					disabled={sync.pending}
					title="Ask the League client for your recent match history and ingest any finished games not already stored. The daemon does this automatically every few minutes; this is the manual version. It does not capture or watch anything."
				>
					{sync.pending ? "Syncing…" : "Sync from client"}
				</button>
			</div>

			{/*
			 * Form sits above the list: the standing and the three habits are what he came to
			 * check, and the individual games are the evidence behind them.
			 */}
			{/*
			 * Layer 0 is one sentence from the coach. The grade, the trend and the full focus
			 * list are one deliberate click down — see FormPanel. Opening on a graded curve is
			 * how an app becomes something you avoid, and the reader who most needs this already
			 * knows he is losing.
			 */}
			{form.data && (form.data.rollingAverage !== null || form.data.focus.length > 0) ?
				<div className="stack stack--tight">
					<FormHeadline form={form.data} />
					<FormPanel form={form.data} />
				</div>
			:	null}

			{games.error ?
				<div className="notice warn">
					<span className="icon">⚠</span>
					<div>
						<strong>Showing the last data this tab loaded.</strong> {games.error}
					</div>
				</div>
			:	null}
			{sync.error ? <Broken title="Sync failed." message={sync.error} /> : null}

			<div className="filters">
				<div className="seg">
					{(["all", "win", "loss"] as const).map(r => (
						<button
							key={r}
							className={cls(result === r && "active")}
							onClick={() => {
								setResult(r)
								setPage(0)
							}}
						>
							{r === "all" ? "All" : r === "win" ? "Wins" : "Losses"}
						</button>
					))}
				</div>

				<select
					value={String(queue)}
					onChange={e => {
						setQueue(e.target.value === "all" ? "all" : Number(e.target.value))
						setPage(0)
					}}
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
					onChange={e => {
						setSearch(e.target.value)
						setPage(0)
					}}
					style={{ minWidth: 200 }}
				/>
			</div>

			{shown.length === 0 ?
				/*
				 * A way out, in the place where you need it.
				 *
				 * A dead end that only says what is wrong reads as "this is broken" — especially
				 * when the filters that caused it are persisted, so they survive a reload and the
				 * obvious escape does nothing.
				 */
				<Blank
					title="Nothing matches"
					actions={
						<button
							className="btn"
							onClick={() => {
								setResult("all")
								setQueue("all")
								setSearch("")
								setPage(0)
							}}
						>
							Clear the filters
						</button>
					}
				>
					{all.length} game{all.length === 1 ? "" : "s"} stored, none of them fit these filters.
				</Blank>
			:	<>
					<div className="game-rows">
						{rows.map(g => (
							<GameRow
								key={g.gameId}
								game={g}
								jobs={jobsByGame.get(g.gameId) ?? []}
								headline={headlineOf(g)}
								now={now}
							/>
						))}
					</div>
					<Pager page={current} pageCount={pageCount} onGo={show} />
				</>
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

				{/*
				 * Five fixed tracks, label above figure. Every one of these is a MEASUREMENT read
				 * off the end-of-game block, so every one is tabular mono and the units live in
				 * the label rather than being repeated inside each value.
				 */}
				<div className="stat-row">
					<div className="stat-cell">
						<span className="k">KDA</span>
						<span className="v">
							{fmtKda(g.kills, g.deaths, g.assists)}
							<em>{fmtKdaRatio(g.kills, g.deaths, g.assists)}</em>
						</span>
					</div>
					<div className="stat-cell">
						<span className="k">CS</span>
						<span className="v">
							{cs}
							<em>{perMin.toFixed(1)}/m</em>
						</span>
					</div>
					<div className="stat-cell">
						<span className="k">Vision</span>
						<span className="v">{g.visionScore}</span>
					</div>
					<div className="stat-cell">
						<span className="k">Damage</span>
						<span className="v">{fmtCompact(g.damageToChampions)}</span>
					</div>
					<div className="stat-cell">
						<span className="k">Gold</span>
						<span className="v">{fmtCompact(g.gold)}</span>
					</div>
				</div>

				{/* The coach's own sentence, with its jargon hoverable — this is the line a
				    beginner actually reads to decide which game to open. */}
				{headline ?
					<div className="hook">
						“<Glossed>{headline}</Glossed>”
					</div>
				:	null}

				<div className="badges">
					{/*
					 * Three states, one glyph. Solid = the coach actually looked at frames of his
					 * screen; dim = frames exist but nothing has been watched; faint = data only.
					 * It sits with the other badges rather than in the figure grid: it reports what
					 * EXISTS for this game, which is what every other chip on this line does.
					 */}
					<span
						className={cls(
							"csk-eye",
							(g.watchedMoments ?? 0) > 0 ? "csk-eye--watched"
							: (g.frameMoments ?? 0) > 0 ? "csk-eye--ready"
							: "csk-eye--none"
						)}
						title={
							(g.watchedMoments ?? 0) > 0 ?
								`Watched: the coach read frames of your screen for ${g.watchedMoments} moment(s) and coached execution — abilities, kiting, fight entry.`
							: (g.frameMoments ?? 0) > 0 ?
								`The live coach recorded frames covering ${g.frameMoments} moment(s), but none watched yet. Open the game and hit Watch.`
							:	"Data only — this game has no journal frames, so nothing about ability usage or kiting. Screen-share with the live coach open while you play and the next one will."
						}
					>
						{/*
						 * A word beside the glyph on the two states that mean something happened. An
						 * eye at three opacities is a legend you have to learn; "👁 watched · 4" is a
						 * row you can read. The empty state stays wordless — 121 of 123 games are in
						 * it, and labelling the default on every row is how a list turns into noise.
						 */}
						👁
						{(g.watchedMoments ?? 0) > 0 ?
							` watched · ${g.watchedMoments}`
						: (g.frameMoments ?? 0) > 0 ?
							" frames"
						:	""}
					</span>
					{/*
					 * The review is the first thing on this line, because it is the only one of these
					 * chips that decides whether the row is worth opening. "no review yet" is not a
					 * warning — 110 of 123 games were in that state while the post-game path was
					 * switched off — so it stays muted and says what to do about it.
					 */}
					{g.hasReview ?
						<span className="chip gold">
							coached{g.momentCount > 0 ? ` · ${g.momentCount} moments` : ""}
						</span>
					:	<span
							className="chip muted"
							title="No coach write-up for this game yet. `pnpm backfill` reviews the ones that never got one."
						>
							not coached
						</span>
					}
					{g.mediaCount > 0 ?
						<span className="chip">
							{g.mediaCount} media
						</span>
					:	null}
					{/*
					 * Dashed, not amber. A missing timeline is a LIMIT on what this review can say,
					 * not something that needs attention — amber here sat next to a real replay
					 * countdown and read as the same kind of thing.
					 */}
					{!g.hasTimeline ?
						<span className="chip uncertain" title="No timeline blob — no positional analysis">
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
				{/* The grade sits with the result: both answer "how did it go", and neither is a
				    measurement of what happened inside the game. */}
				<GradeBadge score={g.gradeScore} rank={g.gradeRank} size="sm" />
				<span className="when" title={new Date(g.gameCreationMs).toLocaleString()}>
					{fmtAgo(g.gameCreationMs, now)}
				</span>
				<span className="go">Debrief →</span>
			</div>
		</div>
	)
}

/* -------------------------------------------------------------- the pager */

/**
 * Prev / next and a page count. No page-number strip: with five pages it is noise, and with
 * fifty it is a second navigation problem — the filters above are how you find an old game, and
 * the search box beats counting pages every time.
 */
const Pager = ({
	page,
	pageCount,
	onGo
}: {
	page: number
	pageCount: number
	onGo: (n: number) => void
}) => {
	if (pageCount <= 1) return null
	return (
		<div className="pager">
			<button className="btn" onClick={() => onGo(page - 1)} disabled={page === 0}>
				← Newer
			</button>
			<span className="dim">
				Page {page + 1} of {pageCount}
			</span>
			<button className="btn" onClick={() => onGo(page + 1)} disabled={page >= pageCount - 1}>
				Older →
			</button>
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
								<code className="mono">systemctl --user start eepalytics</code>)
							</li>
							<li>
								Check it: <code className="mono">pnpm doctor</code>
							</li>
							<li>This page will reconnect on its own once it's up.</li>
						</ol>
						{games.errorDetail ?
							<div style={{ textAlign: "left", maxWidth: 640, margin: "0 auto" }}>
								<Broken title={games.error ?? "Unreachable."} detail={games.errorDetail} />
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
					<div style={{ marginTop: "var(--sp-4)", textAlign: "left" }}>
						<Broken title="Sync failed." message={sync.error} />
					</div>
				:	null}
			</div>
		</div>
	)
}
