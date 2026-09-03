/**
 * Build an `LcuGame` from a decoded `.rofl`, so a replay adopted off disk can go through the
 * ordinary analysis pipeline instead of needing a parallel one.
 *
 * WHY. `analysis-run` reads the LCU match blob, not the game row — it needs every participant's
 * end-of-game stats to compute anything comparative. A replay adopted from disk has no match
 * blob, so it deferred forever with "no match blob stored yet" and produced no metrics at all.
 * The `.rofl` holds the same facts (and several the LCU does not), so the honest fix is to
 * translate rather than to weaken the analysis.
 *
 * WHAT IS REAL AND WHAT IS NOT. Every stat below is copied from the file. Three things are
 * fabricated in the sense that the file does not carry them, and each is set to a value that
 * cannot be mistaken for a measurement:
 *
 *   - `championId` is 0. The file names champions by internal string ("LeeSin") and carries no
 *     numeric id. 0 means unknown; guessing an id would put a wrong champion on screen.
 *   - `queueId` is 0 and `mapId` is 11. The file records neither. 0 is not a real queue id, so
 *     `queueName()` renders it as unknown rather than claiming "Ranked Solo/Duo".
 *   - `gameCreation` comes from the file's mtime, because a `.rofl` carries no timestamp. It is
 *     when the file was written, not when the game started.
 *
 * WHAT IS STILL MISSING. The TIMELINE. Chunk payloads need the game engine to decode, so there
 * are no per-minute positions and no events — no moments, no map zones, no timestamps. Analysis
 * already accepts `timeline: null` and the digest says so in its notes. A replay-only review is
 * honest and much thinner, and the UI labels it that way.
 */

import type { LcuGame, LcuParticipant, LcuParticipantIdentity } from "../shared/schema/lcu.ts"
import type { RoflFile, RoflPlayerStats } from "./decode.ts"

/** Riot's own position strings, as `LcuParticipantTimeline` spells them. */
const laneOf = (p: RoflPlayerStats): { lane: string; role: string } =>
	p.position === "TOP" ? { lane: "TOP", role: "SOLO" }
	: p.position === "MIDDLE" ? { lane: "MIDDLE", role: "SOLO" }
	: p.position === "JUNGLE" ? { lane: "JUNGLE", role: "NONE" }
	: p.position === "BOTTOM" ? { lane: "BOTTOM", role: "CARRY" }
	: p.position === "UTILITY" ? { lane: "BOTTOM", role: "SUPPORT" }
	: { lane: "NONE", role: "NONE" }

const participantOf = (p: RoflPlayerStats): LcuParticipant => ({
	participantId: p.index + 1,
	teamId: p.teamId,
	// See the header: the file has no numeric champion id and 0 reads as unknown.
	championId: 0,
	...(p.spell1Id === null ? {} : { spell1Id: p.spell1Id }),
	...(p.spell2Id === null ? {} : { spell2Id: p.spell2Id }),
	// `timeline.lane`/`.role` from the LCU are known-bad (4/10 labelled JUNGLE) and the app
	// infers roles from positions instead. These come from Riot's own end-of-game POSITION
	// field, which is the reliable one, so they are worth carrying.
	timeline: laneOf(p),
	stats: {
		participantId: p.index + 1,
		win: p.win,
		kills: p.kills,
		deaths: p.deaths,
		assists: p.assists,
		champLevel: p.champLevel,
		goldEarned: p.gold,
		goldSpent: p.goldSpent,
		totalMinionsKilled: p.cs,
		neutralMinionsKilled: p.jungleCs,
		neutralMinionsKilledEnemyJungle: p.enemyJungleCs,
		visionScore: p.visionScore,
		totalDamageDealtToChampions: p.damageToChampions,
		totalDamageTaken: p.damageTaken,
		damageDealtToObjectives: p.damageToObjectives,
		damageDealtToTurrets: p.damageToTurrets,
		totalHeal: p.healOnTeammates,
		// Present in the .rofl and ABSENT from the LCU timeline this app normally reads.
		wardsPlaced: p.wardsPlaced,
		wardsKilled: p.wardsKilled,
		visionWardsBoughtInGame: p.controlWardsBought,
		item0: p.items[0] ?? 0,
		item1: p.items[1] ?? 0,
		item2: p.items[2] ?? 0,
		item3: p.items[3] ?? 0,
		item4: p.items[4] ?? 0,
		item5: p.items[5] ?? 0,
		item6: p.items[6] ?? 0,
		...(p.perkPrimaryStyle === null ? {} : { perkPrimaryStyle: p.perkPrimaryStyle }),
		...(p.perkSubStyle === null ? {} : { perkSubStyle: p.perkSubStyle }),
		...Object.fromEntries(p.perks.map((v, i) => [`perk${i}`, v]))
	}
})

const identityOf = (p: RoflPlayerStats): LcuParticipantIdentity => ({
	participantId: p.index + 1,
	player: {
		puuid: p.puuid,
		gameName: p.gameName,
		tagLine: p.tagLine
	}
})

/**
 * `null` when the file has no stat block — a game remade early enough never gets one written,
 * so the file is valid and empty and there is nothing to analyse.
 */
export const roflToMatch = (file: RoflFile): LcuGame | null => {
	if (file.stats.length === 0 || file.gameId === null) return null
	const durationSec = Math.round(file.gameLengthMs / 1000)
	return {
		gameId: file.gameId,
		platformId: file.platformId ?? "NA1",
		// The file carries no timestamp; mtime is the only clock there is. See the header.
		gameCreation: Math.round(file.mtimeMs - durationSec * 1000),
		gameDuration: durationSec,
		gameMode: "CLASSIC",
		gameType: "MATCHED_GAME",
		gameVersion: file.gameVersion,
		// Not recorded in the file. 0 is not a real queue id, so it renders as unknown rather
		// than asserting a queue this game may not have been.
		queueId: 0,
		mapId: 11,
		participants: file.stats.map(participantOf),
		participantIdentities: file.stats.map(identityOf)
	}
}
