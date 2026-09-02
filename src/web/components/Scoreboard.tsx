/**
 * Scoreboard — the ten players, split by team, with the user's row lit up.
 *
 * Two honesty details:
 *  - Roles here are INFERRED (the LCU's own `lane`/`role` fields are garbage — 4 of 10 players
 *    labelled JUNGLE in one real game). A role whose `roleConfidence` is not `high` is rendered
 *    muted with a trailing `?`, so a mislabelled lane opponent is visible rather than silent.
 *  - "CS" is role-aware. For the jungler it is camps (`jungleCs`); for everyone else it is lane
 *    minions plus whatever camps they took. `effectiveCs` in the domain module owns that rule.
 */

import {
	ROLE_LABELS,
	effectiveCs,
	type ParticipantSummary,
	type Role
} from "../../shared/schema/domain.ts"
import { ChampIcon } from "./ChampIcon.tsx"
import "./components.css"

export interface ScoreboardProps {
	participants: ParticipantSummary[]
	/** The USER's `participantId` (1–10), not a puuid. */
	userId: number
	/** Optional: game length, so the CS column can show a per-minute figure. */
	durationSec?: number
}

const ROLE_ORDER: Record<Role, number> = {
	TOP: 0,
	JGL: 1,
	MID: 2,
	ADC: 3,
	SUP: 4,
	UNKNOWN: 5
}

const nameOf = (p: ParticipantSummary): string => {
	const id = p.riotId?.trim()
	if (id) return id.split("#")[0] || id
	return `Player ${p.participantId}`
}

const fmtGold = (g: number): string =>
	g >= 1000 ? `${(g / 1000).toFixed(1)}k` : String(Math.round(g))

const TeamBlock = ({
	teamId,
	rows,
	userId,
	durationSec
}: {
	teamId: number
	rows: ParticipantSummary[]
	userId: number
	durationSec?: number
}) => {
	const won = rows.some(r => r.win)
	const kills = rows.reduce((a, r) => a + r.kills, 0)
	const gold = rows.reduce((a, r) => a + r.gold, 0)

	return (
		<div className={`csk-score__team csk-score__team--${teamId === 200 ? 200 : 100}`}>
			<div className="csk-score__head">
				<span>{teamId === 200 ? "Red team" : "Blue team"}</span>
				<span className={`csk-score__result ${won ? "csk-score__result--win" : "csk-score__result--loss"}`}>
					{won ? "VICTORY" : "DEFEAT"} · {kills} kills · {fmtGold(gold)}g
				</span>
			</div>
			<table className="csk-score__table">
				<thead>
					<tr>
						<th className="csk-score__cell-champ" />
						<th>Player</th>
						<th>K / D / A</th>
						<th>CS</th>
						<th>Gold</th>
						<th>Vis</th>
						<th>Dmg</th>
					</tr>
				</thead>
				<tbody>
					{rows.map(p => {
						const cs = effectiveCs(p)
						const perMin =
							durationSec && durationSec > 0 ?
								(cs / (durationSec / 60)).toFixed(1)
							:	null
						const soft = p.roleConfidence !== "high" || p.role === "UNKNOWN"
						return (
							<tr
								key={p.participantId}
								className={p.participantId === userId ? "csk-score__row--user" : undefined}
							>
								<td className="csk-score__cell-champ">
									<ChampIcon
										championId={p.championId}
										championName={p.championName}
										size={26}
									/>
								</td>
								<td>
									<div className="csk-score__player">
										<span className="csk-score__name" title={p.riotId}>
											{nameOf(p)}
										</span>
										<span
											className={`csk-score__role${soft ? " csk-score__role--soft" : ""}`}
											title={
												soft ?
													`Role inferred with ${p.roleConfidence} confidence — the client's own lane/role fields are unreliable.`
												:	"Role inferred from frame positions + Smite."
											}
										>
											{ROLE_LABELS[p.role]}
											{soft ? "?" : ""}
										</span>
									</div>
								</td>
								<td className="csk-score__kda">
									<b>{p.kills}</b> / <span className="d">{p.deaths}</span> / <b>{p.assists}</b>
								</td>
								<td title={perMin ? `${cs} (${perMin}/min)` : `${cs}`}>
									{cs}
									{perMin && <span style={{ color: "var(--csk-ghost)" }}> ({perMin})</span>}
								</td>
								<td>{fmtGold(p.gold)}</td>
								<td>{p.visionScore}</td>
								<td>{fmtGold(p.damageToChampions)}</td>
							</tr>
						)
					})}
				</tbody>
			</table>
		</div>
	)
}

export const Scoreboard = ({ participants, userId, durationSec }: ScoreboardProps) => {
	if (participants.length === 0)
		return <div className="csk-empty csk-panel">No scoreboard — participants were not ingested.</div>

	const sortRows = (rows: ParticipantSummary[]): ParticipantSummary[] =>
		[...rows].sort(
			(a, b) =>
				(ROLE_ORDER[a.role] ?? 5) - (ROLE_ORDER[b.role] ?? 5) ||
				a.participantId - b.participantId
		)

	const blue = sortRows(participants.filter(p => p.teamId === 100))
	const red = sortRows(participants.filter(p => p.teamId === 200))
	const orphans = sortRows(participants.filter(p => p.teamId !== 100 && p.teamId !== 200))

	return (
		<div className="csk-score">
			{blue.length > 0 && (
				<TeamBlock teamId={100} rows={blue} userId={userId} durationSec={durationSec} />
			)}
			{red.length > 0 && (
				<TeamBlock teamId={200} rows={red} userId={userId} durationSec={durationSec} />
			)}
			{orphans.length > 0 && (
				<TeamBlock teamId={0} rows={orphans} userId={userId} durationSec={durationSec} />
			)}
		</div>
	)
}

export default Scoreboard
