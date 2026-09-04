/**
 * ArkType validators for the Live Client Data API on port 2999.
 *
 * A SEPARATE HTTP service run by the GAME process, not the LCU. No authentication,
 * self-signed cert, and it only answers while `gameflow-phase === "InProgress"` (or while a
 * replay is playing, though nothing in this app plays one).
 *
 * What it gives us that the post-game timeline cannot: live item builds (diff `items` between
 * polls to reconstruct purchases), ability levels, rune shards, live champion stats, and an
 * ACCURATE `position` per player.
 *
 * What it cannot give us: x/y coordinates for anybody. Positions only ever come from the
 * post-game timeline, at one frame per minute.
 *
 * Query parameter gotcha, contrary to every tutorial online: the per-player endpoints take
 * `riotId` (URL-encode the `#`), NOT `summonerName`.
 */

import { type } from "arktype"

/** `ORDER` is team 100 (blue), `CHAOS` is team 200 (red). */
export const LiveTeam = type("'ORDER'|'CHAOS'|'ALL'|'NEUTRAL'|'UNKNOWN'|string")
export type LiveTeam = typeof LiveTeam.infer

/** Unlike the match-history `timeline.lane`, THIS position field is reliable. */
export const LivePosition = type(
	"'TOP'|'JUNGLE'|'MIDDLE'|'BOTTOM'|'UTILITY'|''|string"
)
export type LivePosition = typeof LivePosition.infer

export const teamIdOfLiveTeam = (team: string): 100 | 200 =>
	team === "CHAOS" ? 200 : 100

/** `TOP|JUNGLE|MIDDLE|BOTTOM|UTILITY` -> our five-role vocabulary. */
export const roleOfLivePosition = (
	position: string
): "TOP" | "JGL" | "MID" | "ADC" | "SUP" | "UNKNOWN" =>
	position === "TOP" ? "TOP"
	: position === "JUNGLE" ? "JGL"
	: position === "MIDDLE" ? "MID"
	: position === "BOTTOM" ? "ADC"
	: position === "UTILITY" ? "SUP"
	: "UNKNOWN"

/* ------------------------------------------------------------------ pieces */

export const LiveScores = type({
	"kills?": "number",
	"deaths?": "number",
	"assists?": "number",
	"creepScore?": "number",
	"wardScore?": "number"
})
export type LiveScores = typeof LiveScores.infer

/** Slot 6 is the trinket. `count` matters for stacking consumables. */
export const LiveItem = type({
	"itemID?": "number",
	"slot?": "number",
	"count?": "number",
	"price?": "number",
	"displayName?": "string",
	"rawDisplayName?": "string",
	"consumable?": "boolean",
	"canUse?": "boolean"
})
export type LiveItem = typeof LiveItem.infer

export const LiveRune = type({
	"id?": "number",
	"displayName?": "string",
	"rawDisplayName?": "string",
	"rawDescription?": "string"
})
export type LiveRune = typeof LiveRune.infer

export const LiveRunes = type({
	"keystone?": LiveRune,
	"primaryRuneTree?": LiveRune,
	"secondaryRuneTree?": LiveRune,
	"generalRunes?": LiveRune.array(),
	"statRunes?": LiveRune.array()
})
export type LiveRunes = typeof LiveRunes.infer

export const LiveSummonerSpell = type({
	"displayName?": "string",
	"rawDisplayName?": "string",
	"rawDescription?": "string"
})
export type LiveSummonerSpell = typeof LiveSummonerSpell.infer

export const LiveSummonerSpells = type({
	"summonerSpellOne?": LiveSummonerSpell,
	"summonerSpellTwo?": LiveSummonerSpell
})
export type LiveSummonerSpells = typeof LiveSummonerSpells.infer

/** 31 fields; all optional because none of them is load-bearing for coaching. */
export const LiveChampionStats = type({
	"abilityHaste?": "number",
	"abilityPower?": "number",
	"armor?": "number",
	"attackDamage?": "number",
	"attackRange?": "number",
	"attackSpeed?": "number",
	"critChance?": "number",
	"currentHealth?": "number",
	"maxHealth?": "number",
	"magicResist?": "number",
	"moveSpeed?": "number",
	"resourceValue?": "number",
	"resourceMax?": "number",
	"resourceType?": "string",
	"tenacity?": "number",
	"lifeSteal?": "number",
	"omnivamp?": "number",
	"spellVamp?": "number"
})
export type LiveChampionStats = typeof LiveChampionStats.infer

export const LiveAbility = type({
	"abilityLevel?": "number",
	"displayName?": "string",
	"id?": "string",
	"rawDescription?": "string"
})
export type LiveAbility = typeof LiveAbility.infer

export const LiveAbilities = type({
	"Passive?": LiveAbility,
	"Q?": LiveAbility,
	"W?": LiveAbility,
	"E?": LiveAbility,
	"R?": LiveAbility
})
export type LiveAbilities = typeof LiveAbilities.infer

/* ------------------------------------------------------------- endpoints */

/** `GET /liveclientdata/activeplayer` — only the local player has this level of detail. */
export const LiveActivePlayer = type({
	"riotId?": "string",
	"riotIdGameName?": "string",
	"riotIdTagLine?": "string",
	"summonerName?": "string",
	"level?": "number",
	"currentGold?": "number",
	"teamRelativeColors?": "boolean",
	"abilities?": LiveAbilities,
	"fullRunes?": LiveRunes,
	"championStats?": LiveChampionStats
})
export type LiveActivePlayer = typeof LiveActivePlayer.infer

/** One entry of `GET /liveclientdata/playerlist`. */
export const LivePlayer = type({
	"riotId?": "string",
	"riotIdGameName?": "string",
	"riotIdTagLine?": "string",
	"summonerName?": "string",
	"championName?": "string",
	"rawChampionName?": "string",
	"rawSkinName?": "string",
	"skinID?": "number",
	"team?": "string",
	"position?": "string",
	"level?": "number",
	"isBot?": "boolean",
	"isDead?": "boolean",
	"respawnTimer?": "number",
	"scores?": LiveScores,
	"items?": LiveItem.array(),
	"runes?": LiveRunes,
	"summonerSpells?": LiveSummonerSpells
})
export type LivePlayer = typeof LivePlayer.infer

export const LivePlayerList = LivePlayer.array()
export type LivePlayerList = typeof LivePlayerList.infer

/** `GET /liveclientdata/gamestats`. `gameTime` is SECONDS as a float. */
export const LiveGameStats = type({
	"gameMode?": "string",
	"gameTime?": "number",
	"mapName?": "string",
	"mapNumber?": "number",
	"mapTerrain?": "string"
})
export type LiveGameStats = typeof LiveGameStats.infer

/**
 * One entry of `GET /liveclientdata/eventdata`. Names are riotIds, not participantIds —
 * join to the post-game timeline on riotId.
 *
 * `EventID` increases monotonically; poll with `?eventID=N` and dedupe on it.
 */
export const LiveEvent = type({
	EventID: "number",
	EventName: "string",
	"EventTime?": "number",
	"KillerName?": "string",
	"VictimName?": "string",
	"Assisters?": "string[]",
	"Recipient?": "string",
	"TurretKilled?": "string",
	"InhibKilled?": "string",
	"DragonType?": "string",
	"Stolen?": "string",
	"KillStreak?": "number",
	"Acer?": "string",
	"AcingTeam?": "string"
})
export type LiveEvent = typeof LiveEvent.infer

export const LiveEventData = type({ "Events?": LiveEvent.array() })
export type LiveEventData = typeof LiveEventData.infer

/** `GET /liveclientdata/allgamedata` — one call, everything. ~32 KB, ~28 ms. */
export const LiveAllGameData = type({
	"gameData?": LiveGameStats,
	"activePlayer?": LiveActivePlayer,
	"allPlayers?": LivePlayer.array(),
	"events?": LiveEventData
})
export type LiveAllGameData = typeof LiveAllGameData.infer

/**
 * One line of `blobs/<gameId>/live.ndjson.gz` — a timestamped sample of `allgamedata`.
 * `atMs` is our wall clock (so we can align to the LCU), `gameTime` is the game's own.
 */
export const LiveSample = type({
	atMs: "number",
	"gameTime?": "number",
	data: LiveAllGameData
})
export type LiveSample = typeof LiveSample.infer

/** Names of the live events we act on. Anything else is journalled and ignored. */
export const LIVE_EVENT_NAMES = [
	"GameStart",
	"MinionsSpawning",
	"FirstBrick",
	"FirstBlood",
	"ChampionKill",
	"Multikill",
	"Ace",
	"TurretKilled",
	"InhibKilled",
	"InhibRespawningSoon",
	"InhibRespawned",
	"DragonKill",
	"HeraldKill",
	"BaronKill",
	"GameEnd"
] as const
