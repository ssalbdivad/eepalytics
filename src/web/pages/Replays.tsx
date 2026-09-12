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
import { cls, fmtAgo, fmtDuration, fmtKda, fmtQty } from "../lib/format.ts"
import { ChampIcon } from "../components/ChampIcon.tsx"
import { Blank, Broken, Loading } from "../components/States.tsx"

/** Megabytes, at the policy's grain — `14.3 MB`, `1,024 MB`. */
const mb = (bytes: number): string => `${fmtQty(bytes / 1_048_576)} MB`

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
					<div className="sub">
						{d.replays.length} file{d.replays.length === 1 ? "" : "s"} in{" "}
						<code className="mono">{d.folder}</code>
					</div>
				)}
			</div>

			{res.loading && <Loading rows={4} height={44} label="Reading the replay folder" />}

			{res.error !== null && (
				<Broken title="Could not read the replay folder." message={res.error} />
			)}

			{d && d.replays.length === 0 && (
				<Blank
					title={`No .rofl files in ${d.folder}`}
					actions={
						<a className="btn" href={href.settings}>
							Set the replay folder
						</a>
					}
				>
					If your replays live somewhere else, set the folder in Settings. Replays expire on
					Riot's side about 30 minutes after a game ends, so anything not downloaded by then is
					gone for good.
				</Blank>
			)}

			{error !== null && <Broken title="Couldn't coach that file." message={error} />}

			{d && d.replays.length > 0 && (
				<div className="panel table-wrap">
					<table className="dtable">
						<thead>
							<tr>
								<th />
								<th>Game</th>
								<th>Result</th>
								{/*
								 * Every figure column is right-aligned and monospaced, so KDA, CS, length
								 * and size each read as a column down the page rather than as five ragged
								 * left edges. Units live in the header, never repeated in every cell.
								 */}
								<th className="num-col">KDA</th>
								<th className="num-col">CS</th>
								<th className="num-col">Length</th>
								<th className="num-col">Patch</th>
								<th className="num-col">Size</th>
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
										<td className="num-col">
											{r.kills === null ? "—" : fmtKda(r.kills, r.deaths ?? 0, r.assists ?? 0)}
										</td>
										<td className="num-col">{r.cs ?? "—"}</td>
										<td className="num-col">
											{r.durationSec === null ? "—" : fmtDuration(r.durationSec)}
										</td>
										<td className="num-col">{r.patch ?? "—"}</td>
										<td className="num-col faint">{mb(r.bytes)}</td>
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
