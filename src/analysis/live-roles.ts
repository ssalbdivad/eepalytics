/**
 * Who the enemy jungler is, during a live game.
 *
 * ## Why this is worth its own module
 *
 * "The guy he is racing" is the single most useful identity in a jungle game, and until now the
 * live coach did not have it: `buildLiveState` printed ten champions with no idea which of them
 * was the counterpart. Without it every champion note is background colour — "Viego resets on
 * takedowns" is true in every game ever played — and with it the same note becomes a decision:
 * *that* champion is down for 32s, so *this* camp is free.
 *
 * ## Two ways to know, and they are not equally strong
 *
 * - `position` — the Live Client Data API publishes a per-player position, and unlike match
 *   history's `participants[].timeline.lane` (4/10 mislabelled JUNGLE, see `AGENTS.md`) this
 *   field is reliable. Its one weakness is that blind and quickplay queues leave it empty for
 *   everyone, so it is present or absent rather than present and wrong.
 * - `smite` — the lone enemy Smite holder. `analysis/roles.ts` measured exactly one Smite per
 *   team in 44/44 team games, which is why this is a fallback and not a guess. Two Smites on one
 *   team and we give up rather than pick one.
 *
 * The basis rides along with the answer because the coach has to say "looks like" for one of them
 * and may assert the other. This mirrors `analysis/matchup.ts`, which makes the same call from
 * the champ-select endpoint; the two cannot share code because they read different shapes from
 * different services, but they must not disagree about the RULE, so both are stated here.
 *
 * PURE.
 */

import type { LivePlayer } from "../shared/schema/live.ts"

export type JunglerBasis = "position" | "smite"

export interface LiveJungler {
	champion: string
	basis: JunglerBasis
	player: LivePlayer
}

/**
 * Smite by name, from either field the client offers.
 *
 * `displayName` is localised, so it is checked first and then `rawDisplayName`, which carries the
 * internal id (`GeneratedTip_SummonerSpell_SummonerSmite_DisplayName`) and does not translate. A
 * miss costs the `smite` fallback and nothing else — `position` is the primary path.
 */
const hasSmite = (p: LivePlayer): boolean => {
	const spells = [p.summonerSpells?.summonerSpellOne, p.summonerSpells?.summonerSpellTwo]
	return spells.some(
		s => s?.displayName === "Smite" || /SummonerSmite/i.test(s?.rawDisplayName ?? "")
	)
}

/**
 * The enemy jungler, or null when nothing identifies one.
 *
 * `enemies` is already filtered to the other team by the caller, which is the only thing that
 * could make this pick a teammate.
 */
export const enemyJungler = (enemies: readonly LivePlayer[]): LiveJungler | null => {
	const declared = enemies.filter(p => p.position === "JUNGLE" && (p.championName ?? "") !== "")
	if (declared.length === 1)
		return { champion: declared[0]!.championName!, basis: "position", player: declared[0]! }

	const smiters = enemies.filter(p => hasSmite(p) && (p.championName ?? "") !== "")
	if (smiters.length === 1)
		return { champion: smiters[0]!.championName!, basis: "smite", player: smiters[0]! }

	return null
}
