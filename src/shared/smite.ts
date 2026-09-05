/**
 * Who is holding Smite — the fallback that identifies the enemy jungler when nobody declared a
 * position.
 *
 * ## Why this is a module and not two lines in the route
 *
 * It was two lines in the route, and they were wrong, and nothing could tell because the case they
 * are the fallback for is the case nobody has a recording of.
 *
 * `src/server/routes/live.ts` matched the enemy jungler by `summonerSpell.displayName === "smite"`,
 * lowercased. That is the name of the BASE spell. Smite upgrades, and when it does the client
 * renames it. Counted over the four recorded games in `data/live-samples` — 4,884 observations of
 * a Smite on some player, sampled every five seconds of game clock — the display name was:
 *
 *     904   "Smite"             SummonerSmite
 *     1582  "Primal Smite"      SummonerSmiteAvatarDefensive
 *     810   "Primal Smite"      SummonerSmiteAvatarOffensive
 *     702   "Primal Smite"      SummonerSmiteAvatarUtility
 *     886   "Unleashed Smite"   S5_SummonerSmitePlayerGanker
 *
 * So an equality test on "Smite" recognises **18.5%** of them, and the 81.5% it misses are the
 * ones from the mid and late game — the part of a game a live coach mostly runs in. A jungler with
 * an upgraded Smite was, to that check, not a jungler at all.
 *
 * ## Why nobody noticed
 *
 * `position` comes first, and across those same four games it was populated for all 12,210 player
 * observations — never once empty. The Smite path is reached only in the queues that publish no
 * position (blind and quickplay), so the bug lived entirely in the branch that no recording
 * covers. It would have shown up as the live coach having no counterpart for a whole game, which
 * reads exactly like a quiet coach.
 *
 * ## The rule
 *
 * Match `rawDisplayName`, not `displayName`. The raw name carries the internal spell id, every
 * variant of it contains the substring `SummonerSmite`, and unlike the display name it does not
 * translate — a client in another locale renames "Primal Smite" and leaves
 * `SummonerSmiteAvatarOffensive` alone. `displayName` is kept as a second chance for a client too
 * old to send the raw field, but it is a *substring* test now, so the upgrades match there too.
 *
 * PURE and browser-safe.
 */

import type { LivePlayer } from "./schema/live.ts"

/** Every Smite id observed carries this; no other summoner spell does. */
const RAW_SMITE = /SummonerSmite/i

/** Catches "Smite", "Primal Smite" and "Unleashed Smite" without listing them. */
const NAMED_SMITE = /\bsmite\b/i

/** Does this player have some form of Smite equipped? */
export const hasSmite = (p: LivePlayer): boolean =>
	[p.summonerSpells?.summonerSpellOne, p.summonerSpells?.summonerSpellTwo].some(
		s => s !== undefined && (RAW_SMITE.test(s.rawDisplayName ?? "") || NAMED_SMITE.test(s.displayName ?? ""))
	)
