/**
 * The champ-select / loading-screen brief: who he is about to play, against whom, with what.
 *
 * ## Why this exists as its own thing
 *
 * Every other coaching surface in this app looks backwards at a game that is over, or sideways
 * at one in progress. This one runs in the ninety seconds where advice is still free: nothing
 * has happened yet, so nothing can be graded, and the only honest output is *the plan*.
 *
 * ## What it is allowed to know
 *
 * `GET /lol-gameflow/v1/session` publishes, before the loading screen finishes:
 * `gameData.playerChampionSelections` (championId, puuid, spell1Id, spell2Id) and
 * `gameData.teamOne` / `teamTwo` (championId, puuid, selectedPosition). That is both full comps,
 * every declared position, and every summoner spell — verified against the live client.
 *
 * It does **not** publish enemy runes. Nothing pre-game does. It does not publish items, because
 * nobody has bought one. It does not publish cooldowns, because the game has not started. The
 * shape this returns has no field for any of them, which is the cheapest possible enforcement.
 *
 * ## Finding "the guy he is racing"
 *
 * Two ways, and they are not equally strong, so the brief says which one it used:
 *
 * - `declared` — the enemy who declared the same position. Draft queues publish this and it is
 *   trustworthy. (Unlike `participants[].timeline.lane` in match history, which is corrupt — this
 *   is a different field from a different endpoint and it is simply *absent*, never wrong, in the
 *   queues that never asked.)
 * - `smite` — in blind and quickplay nobody declares anything, so for the jungle specifically we
 *   fall back to the lone enemy Smite holder. `roles.ts` measured exactly one Smite per team in
 *   44/44 team-games, which is why this is a fallback and not a guess. If two enemies took Smite,
 *   we give up rather than pick one.
 *
 * When neither lands, `opponent` is `null` and `unknowns` says so out loud. A brief that quietly
 * matched the wrong player would be worse than a brief that admits it has no counterpart.
 *
 * PURE. Callers supply the session and the two id -> name lookups.
 */

import type { MatchupBasis, MatchupBrief, MatchupPlayer } from "../shared/schema/api.ts"
import type { GameflowPlayer, GameflowSession, PlayerChampionSelection } from "../shared/schema/lcu.ts"
import type { Role } from "../shared/schema/domain.ts"
import { roleOfLivePosition } from "../shared/schema/live.ts"
import { SMITE_SPELL_ID } from "../shared/constants.ts"

export interface MatchupNote {
	champion: string
	text: string
	patch: string
	source: string
}

export interface BuildMatchupInput {
	session: GameflowSession
	/** Whose brief this is. Matched on puuid, never on a name. */
	puuid: string
	/** `championName` from `daemon/champions.ts`. Returns `""` for unknown — never a guess. */
	championName: (championId: number) => string
	/** `summonerSpellName` from `daemon/spells.ts`. Same contract. */
	spellName: (spellId: number) => string
	/**
	 * Champion notes by name, or `null` when there are none.
	 *
	 * A lookup rather than two values, because neither champion is known until this function has
	 * worked out which row is his and which enemy is his counterpart. `_default.md` counts as
	 * `null`: it says nothing *about* a champion, it says to stop talking about the champion.
	 */
	noteFor?: (championName: string) => MatchupNote | null
	/** Human queue label, when the caller could resolve one. */
	queue?: string | null
}

/** A row as it comes off the session, with the two sources already joined on puuid. */
interface Joined {
	player: GameflowPlayer
	selection: PlayerChampionSelection | null
}

const joinTeam = (
	team: readonly GameflowPlayer[],
	selections: readonly PlayerChampionSelection[]
): Joined[] =>
	team.map(player => ({
		player,
		selection:
			(player.puuid ?
				(selections.find(s => s.puuid && s.puuid === player.puuid) ?? null)
			:	null)
	}))

/**
 * A champion id, from either source.
 *
 * `teamOne`/`teamTwo` and `playerChampionSelections` both carry one, and during champ select they
 * disagree in a specific way: the roster rows lag behind a swap. The selection is the later
 * write, so it wins where it exists.
 */
const championIdOf = (row: Joined): number =>
	row.selection?.championId && row.selection.championId > 0 ? row.selection.championId
	: row.player.championId && row.player.championId > 0 ? row.player.championId
	: 0

const spellIdsOf = (row: Joined): number[] =>
	[row.selection?.spell1Id, row.selection?.spell2Id].filter(
		(id): id is number => typeof id === "number" && id > 0
	)

const hasSmite = (row: Joined): boolean => spellIdsOf(row).includes(SMITE_SPELL_ID)

const toPlayer = (row: Joined, input: BuildMatchupInput, isYou: boolean): MatchupPlayer => {
	const championId = championIdOf(row)
	return {
		champion: championId > 0 ? input.championName(championId) : "",
		championId,
		role: roleOfLivePosition(row.player.selectedPosition ?? "") as Role,
		// An id we cannot name is dropped rather than printed. "Spell 11" is not something a
		// coach can say, and a number in prose reads as a fact about the game.
		spells: spellIdsOf(row)
			.map(id => input.spellName(id))
			.filter(name => name !== ""),
		isYou
	}
}

export interface MatchupResult {
	brief: MatchupBrief | null
	/** Why there is no brief. `null` when there is one. */
	reason: string | null
}

/**
 * Build the brief, or explain why there isn't one.
 *
 * Never throws and never half-builds: every "not yet" is a `reason` string the UI can show
 * verbatim, because during champ select this endpoint is polled and most of those polls land
 * before the client has published anything.
 */
export const buildMatchupBrief = (input: BuildMatchupInput): MatchupResult => {
	const { session, puuid } = input
	const data = session.gameData
	const teamOne = data?.teamOne ?? []
	const teamTwo = data?.teamTwo ?? []
	const selections = data?.playerChampionSelections ?? []

	if (teamOne.length === 0 && teamTwo.length === 0)
		return { brief: null, reason: "the client has not published the rosters yet" }

	const mine =
		teamOne.some(p => p.puuid === puuid) ? teamOne
		: teamTwo.some(p => p.puuid === puuid) ? teamTwo
		: null
	if (!mine)
		return {
			brief: null,
			reason: "this game's rosters do not contain your puuid — nothing here is yours to coach"
		}
	const theirs = mine === teamOne ? teamTwo : teamOne

	const ours = joinTeam(mine, selections)
	const them = joinTeam(theirs, selections)

	const meRow = ours.find(r => r.player.puuid === puuid)!
	const you = toPlayer(meRow, input, true)
	if (you.championId === 0)
		return { brief: null, reason: "you have not locked a champion yet" }

	const unknowns: string[] = []
	if (you.champion === "")
		unknowns.push(
			"The champion-name table could not be read, so your champion has no name here — do not name it."
		)
	if (you.spells.length < 2)
		unknowns.push("Summoner spells are not published yet — say nothing about anyone's spells.")

	/*
	 * The counterpart. Declared position first; the lone enemy Smite second, and ONLY for the
	 * jungle, because Smite is the one spell that identifies a role on its own.
	 */
	let basis: MatchupBasis = "none"
	let oppRow: Joined | null = null
	if (you.role !== "UNKNOWN") {
		const declared = them.filter(
			r => (roleOfLivePosition(r.player.selectedPosition ?? "") as Role) === you.role
		)
		if (declared.length === 1) {
			oppRow = declared[0]!
			basis = "declared"
		}
	}
	if (!oppRow && (you.role === "JGL" || (you.role === "UNKNOWN" && hasSmite(meRow)))) {
		const smiters = them.filter(hasSmite)
		if (smiters.length === 1) {
			oppRow = smiters[0]!
			basis = "smite"
		}
	}

	const opponent = oppRow ? toPlayer(oppRow, input, false) : null
	if (!opponent)
		unknowns.push(
			you.role === "UNKNOWN" ?
				"Nobody declared a position in this queue and the enemy Smite holder is ambiguous, so there is no identified counterpart — coach the comp, not a matchup."
			:	"No enemy declared your position and their Smite is ambiguous, so there is no identified counterpart — coach the comp, not a matchup."
		)
	else if (basis === "smite")
		unknowns.push(
			"Nobody declared a position in this queue. The enemy jungler was identified by Smite alone, which has been exactly right in every game measured but is still an inference — say 'looks like' rather than asserting it."
		)

	const oppNote =
		opponent && opponent.champion !== "" && input.noteFor ?
			input.noteFor(opponent.champion)
		:	null
	const opponentNotes = oppNote ? { champion: oppNote.champion, text: oppNote.text } : null
	if (opponent && opponent.champion !== "" && !opponentNotes)
		unknowns.push(
			`There are no champion notes on file for ${opponent.champion}. Say nothing about their kit, their clear or their spikes — coach the role and the plan instead.`
		)

	const championNotes =
		you.champion !== "" && input.noteFor ? input.noteFor(you.champion) : null
	if (!championNotes && you.champion !== "")
		unknowns.push(
			`There are no champion notes on file for ${you.champion} either. Coach the role and the plan, and improvise nothing about the kit.`
		)

	const brief: MatchupBrief = {
		phase: session.phase,
		queue: input.queue ?? null,
		you,
		opponent,
		opponentBasis: basis,
		allies: ours.filter(r => r.player.puuid !== puuid).map(r => toPlayer(r, input, false)),
		enemies: them.map(r => toPlayer(r, input, false)),
		championNotes,
		opponentNotes,
		unknowns
	}
	return { brief, reason: null }
}
