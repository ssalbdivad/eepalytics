/**
 * Replays — browse the `.rofl` folder and coach a file directly.
 *
 * The rest of the app starts from the LCU's match history, which hands back a server-chosen
 * ~20-game window and ignores any attempt to page past it. A replay that has fallen out of that
 * window is invisible to the Games screen even though it is sitting on disk with a complete
 * end-of-game stat block. This screen makes the folder the source of truth.
 *
 * The distinction the list has to make honestly is TIMELINE, not presence. A file adopted from
 * disk gives 371 stats per player — more end-of-game detail than the LCU has, including final
 * items and ward counts — but no per-minute positions, because the chunk payloads need the game
 * engine to decode. No timeline means no moments, no map zones and no "where were you at 14:12",
 * so those reviews are honest but much thinner. Every row says which kind it will get.
 */

import { useCallback, useState } from "react"
import type { ReplayFileInfo } from "../../shared/schema/api.ts"
import { api, errorMessage } from "../lib/api.ts"
import { href, useResource } from "../lib/hooks.ts"
import { cls, fmtAgo, fmtDuration, fmtKda } from "../lib/format.ts"
import { ChampIcon } from "../components/ChampIcon.tsx"

const mb = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`

/** What this file can actually support, said plainly. */
const coverage = (
	r: ReplayFileInfo
): { label: string; tone: "full" | "stats" | "none"; title: string } =>
	!r.readable ?
		{
			label: "unreadable",
			tone: "none",
			title: "This file could not be decoded. It may be truncated, or from a patch whose format differs."
		}
	: r.playerCount === 0 ?
		{
			label: "remake — no stats",
			tone: "none",
			title: "A game remade this early never gets an end-of-game stat block written, so the file is valid and empty. There is nothing in it to coach."
		}
	: r.hasTimeline ?
		{
			label: "full review",
			tone: "full",
			title: "This game was also harvested from match history, so it has a per-minute timeline: moments, map positions and timestamped coaching."
		}
	:	{
			label: "stats only — no timeline",
			tone: "stats",
			title: "The replay file carries end-of-game stats but no per-minute positions, so this review gets no moments, no map zones and no timestamps. Honest, but much thinner."
		}

export interface ReplaysProps {
	eventTick: number
}

export const Replays = ({ eventTick }: ReplaysProps) => {
	const res = useResource(signal => api.replays(signal), [eventTick])
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [done, setDone] = useState<Record<string, number>>({})

	const coach = useCallback(async (r: ReplayFileInfo) => {
		setBusy(r.fileName)
		setError(null)
		try {
			const out = await api.ingestReplay(r.fileName)
			setDone(d => ({ ...d, [r.fileName]: out.gameId }))
		} catch (e) {
			setError(`${r.fileName}: ${errorMessage(e)}`)
		} finally {
			setBusy(null)
		}
	}, [])

	const d = res.data

	return (
		<div className="page">
			<div className="page-head">
				<h1>Replays</h1>
				{d && (
					<p className="dim">
						{d.replays.length} file{d.replays.length === 1 ? "" : "s"} in{" "}
						<code>{d.folder}</code>
					</p>
				)}
			</div>

			{res.loading && <div className="dim">Reading the replay folder…</div>}

			{res.error !== null && (
				<div className="notice bad">
					<span className="icon">✗</span>
					<div>
						<strong>Could not read the replay folder.</strong> {res.error}
					</div>
				</div>
			)}

			{d && d.replays.length === 0 && (
				<div className="notice warn">
					<span className="icon">⚠</span>
					<div>
						<strong>No .rofl files in {d.folder}</strong>
						<div style={{ marginTop: 6 }}>
							If your replays live somewhere else, set the folder in{" "}
							<a href={href.settings}>Settings</a>. Replays expire on Riot's side about 30
							minutes after a game ends, so anything not downloaded by then is gone for good.
						</div>
					</div>
				</div>
			)}

			{error !== null && <div className="notice bad" style={{ marginBottom: 12 }}>
				<span className="icon">✗</span>
				<div>{error}</div>
			</div>}

			{d && d.replays.length > 0 && (
				<div className="panel">
					<table className="replay-table">
						<thead>
							<tr>
								<th />
								<th>Game</th>
								<th>Result</th>
								<th>KDA</th>
								<th>CS</th>
								<th>Length</th>
								<th>Patch</th>
								<th>Size</th>
								<th>Coverage</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{d.replays.map(r => {
								const cov = coverage(r)
								const coached = done[r.fileName]
								return (
									<tr key={r.fileName} className={cls(!r.readable && "dim")}>
										<td>{r.championName && <ChampIcon championId={0} championName={r.championName} size={26} />}</td>
										<td>
											<div className="mono">{r.gameId ?? r.fileName}</div>
											<div className="faint">{fmtAgo(r.mtimeMs)}</div>
										</td>
										<td>
											{r.win === null ?
												<span className="faint">—</span>
											:	<span className={r.win ? "win" : "loss"}>{r.win ? "Win" : "Loss"}</span>
											}
										</td>
										<td className="mono">
											{r.kills === null ? "—" : fmtKda(r.kills, r.deaths ?? 0, r.assists ?? 0)}
										</td>
										<td className="mono">{r.cs ?? "—"}</td>
										<td className="mono">
											{r.durationSec === null ? "—" : fmtDuration(r.durationSec)}
										</td>
										<td className="mono">{r.patch ?? "—"}</td>
										<td className="mono faint">{mb(r.bytes)}</td>
										<td>
											<span className={`cov cov--${cov.tone}`} title={cov.title}>
												{cov.label}
											</span>
										</td>
										<td>
											{coached ?
												<a className="btn btn-primary" href={href.game(coached)}>
													Open review
												</a>
											: cov.tone === "none" ?
												<span className="faint">—</span>
											: r.inLibrary && r.hasTimeline ?
												<a className="btn" href={href.game(r.gameId!)}>
													Open
												</a>
											:	<button
													className="btn btn-primary"
													disabled={busy !== null}
													onClick={() => void coach(r)}
												>
													{busy === r.fileName ? "Reading…" : "Coach this"}
												</button>
											}
										</td>
									</tr>
								)
							})}
						</tbody>
					</table>
				</div>
			)}
		</div>
	)
}
