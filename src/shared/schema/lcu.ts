/**
 * ArkType validators for League Client Update (LCU) payloads.
 *
 * Derived from real captured responses (see `.research/lcu-api.md` §1-§4), not guessed.
 *
 * ## Design rule: validation must protect us, not fight us
 * These types are deliberately PERMISSIVE. Undeclared keys pass through untouched (ArkType's
 * default), and everything that is not load-bearing is optional. A Riot patch that adds a
 * field must never brick ingestion; a patch that REMOVES a field we depend on should fail
 * loudly and name the field. That is the only tradeoff being made here.
 */

import { type } from "arktype"
import type { Type } from "arktype"

/** Thrown by `parseOrThrow`. Carries the ArkType summary and the caller's context string. */
export class SchemaError extends Error {
	readonly context: string
	readonly issues: string

	constructor(context: string, issues: string) {
		super(`${context}: ${issues}`)
		this.name = "SchemaError"
		this.context = context
		this.issues = issues
	}
}

/**
 * Validate `data` against `t`, or throw a `SchemaError` naming `context`.
 *
 *   const tl = parseOrThrow(LcuTimeline, json, `timeline ${gameId}`)
 *
 * Use `t(data) instanceof type.errors` directly when a failure is expected and recoverable
 * (a 404 body, an offline client) — throwing is for "this should have been valid".
 */
export const parseOrThrow = <t>(t: Type<t>, data: unknown, context: string): t => {
	const out = t(data)
	if (out instanceof type.errors) throw new SchemaError(context, out.summary)
	return out as t
}

/** Non-throwing sibling: returns `null` and never explodes. */
export const parseOrNull = <t>(t: Type<t>, data: unknown): t | null => {
	const out = t(data)
	return out instanceof type.errors ? null : (out as t)
}

/* ============================================================== identity */

/** `GET /lol-summoner/v1/current-summoner`. `summonerName` is `""` now — use gameName#tagLine. */
export const CurrentSummoner = type({
	puuid: "string",
	"gameName?": "string",
	"tagLine?": "string",
	"summonerId?": "number",
	"accountId?": "number",
	"displayName?": "string",
	"profileIconId?": "number",
	"summonerLevel?": "number"
})
export type CurrentSummoner = typeof CurrentSummoner.infer

/** The riotId form the Live Client Data API and our UI both use. */
export const riotIdOf = (s: {
	gameName?: string
	tagLine?: string
}): string => (s.gameName && s.tagLine ? `${s.gameName}#${s.tagLine}` : (s.gameName ?? ""))

/* ============================================================== gameflow */

/**
 * `GET /lol-gameflow/v1/gameflow-phase` returns a BARE JSON STRING.
 * The enum is the client's own `LolGameflowGameflowPhase`. Only `InProgress` and `EndOfGame`
 * were observed live; the rest come from the type table. Treat any unrecognised value as
 * "not idle" so the intrusive-job gate fails closed.
 */
export const GameflowPhase = type(
	"'None'|'Lobby'|'Matchmaking'|'CheckedIntoTournament'|'ReadyCheck'|'ChampSelect'|'GameStart'|'FailedToLaunch'|'InProgress'|'Reconnect'|'WaitingForStats'|'PreEndOfGame'|'EndOfGame'|'TerminatedInError'"
)
export type GameflowPhase = typeof GameflowPhase.infer

/** Anything we do not recognise is treated as busy. */
export const isIdlePhase = (phase: string): boolean =>
	phase === "None" || phase === "Lobby"

/** `GET /lol-gameflow/v1/watch` — how you tell a REPLAY apart from a live game. */
export const GameflowWatchPhase = type(
	"'None'|'WatchStarted'|'WatchInProgress'|'WatchFailedToLaunch'"
)
export type GameflowWatchPhase = typeof GameflowWatchPhase.infer

/**
 * `GET /lol-gameflow/v1/session` — the single best "what is happening right now" call.
 * Deliberately shallow: we only need phase, the current gameId and whether the client runs.
 */
export const GameflowSession = type({
	phase: "string",
	"gameClient?": {
		"running?": "boolean",
		"visible?": "boolean",
		"serverIp?": "string",
		"serverPort?": "number"
	},
	"gameData?": {
		"gameId?": "number",
		"isCustomGame?": "boolean",
		"queue?": {
			"id?": "number",
			"gameMode?": "string",
			"mapId?": "number"
		},
		"teamOne?": "unknown[]",
		"teamTwo?": "unknown[]"
	},
	"map?": {
		"id?": "number",
		"gameMode?": "string",
		"mapStringId?": "string"
	}
})
export type GameflowSession = typeof GameflowSession.infer

/* =============================================================== replays */

/**
 * `GET /lol-replays/v1/configuration` — the gate for everything replay-related.
 * `minutesUntilReplayConsideredLost` was 30 when measured; do not hardcode it, read it.
 */
export const ReplayConfiguration = type({
	"gameVersion?": "string",
	"isInTournament?": "boolean",
	"isLoggedIn?": "boolean",
	"isPatching?": "boolean",
	"isPlayingGame?": "boolean",
	"isPlayingReplay?": "boolean",
	"isReplaysEnabled?": "boolean",
	"isReplaysForEndOfGameEnabled?": "boolean",
	"isReplaysForMatchHistoryEnabled?": "boolean",
	"minServerVersion?": "string",
	"minutesUntilReplayConsideredLost?": "number"
})
export type ReplayConfiguration = typeof ReplayConfiguration.infer

/**
 * `LolReplaysMetadataState`, complete, read from the client's own type table.
 * `watch` = the .rofl is on disk and playable. `download` = server has it, go get it.
 * `missingOrExpired` / `lost` = gone forever, never retry.
 */
export const ReplayState = type(
	"'checking'|'download'|'downloading'|'error'|'found'|'incompatible'|'lost'|'missingOrExpired'|'retryDownload'|'unsupported'|'watch'"
)
export type ReplayState = typeof ReplayState.infer

/**
 * `GET /lol-replays/v1/metadata/{gameId}`.
 *
 * A 404 here means "the client has never created LOCAL metadata for this game", NOT that the
 * replay expired. You must POST the create endpoint first. `downloadProgress` is uint32 and
 * is uninitialised garbage until `state === "downloading"`.
 */
export const ReplayMetadata = type({
	gameId: "number",
	state: "string",
	"downloadProgress?": "number"
})
export type ReplayMetadata = typeof ReplayMetadata.infer

/** Standard LCU error body. 404 + "No active delegate" is a STATE, not a failure. */
export const LcuError = type({
	"errorCode?": "string",
	"httpStatus?": "number",
	"message?": "string"
})
export type LcuError = typeof LcuError.infer

/* ========================================================= match history */

/**
 * The ~118-field end-of-game stat block. Required keys are the ones every screen and every
 * metric depends on; the long tail (runes, damage splits, surrender flags, dead Dominion-era
 * fields) is optional so a missing one degrades instead of failing.
 */
export const LcuParticipantStats = type({
	participantId: "number",
	win: "boolean",
	kills: "number",
	deaths: "number",
	assists: "number",
	champLevel: "number",
	goldEarned: "number",
	totalMinionsKilled: "number",
	neutralMinionsKilled: "number",
	visionScore: "number",
	totalDamageDealtToChampions: "number",

	"goldSpent?": "number",
	"neutralMinionsKilledEnemyJungle?": "number",
	"neutralMinionsKilledTeamJungle?": "number",
	"wardsPlaced?": "number",
	"wardsKilled?": "number",
	"visionWardsBoughtInGame?": "number",
	"sightWardsBoughtInGame?": "number",

	"item0?": "number",
	"item1?": "number",
	"item2?": "number",
	"item3?": "number",
	"item4?": "number",
	"item5?": "number",
	"item6?": "number",

	"perk0?": "number",
	"perk1?": "number",
	"perk2?": "number",
	"perk3?": "number",
	"perk4?": "number",
	"perk5?": "number",
	"perkPrimaryStyle?": "number",
	"perkSubStyle?": "number",

	"totalDamageDealt?": "number",
	"physicalDamageDealtToChampions?": "number",
	"magicDamageDealtToChampions?": "number",
	"trueDamageDealtToChampions?": "number",
	"totalDamageTaken?": "number",
	"damageSelfMitigated?": "number",
	"damageDealtToObjectives?": "number",
	"damageDealtToTurrets?": "number",
	"totalHeal?": "number",
	"totalUnitsHealed?": "number",
	"timeCCingOthers?": "number",
	"totalTimeCrowdControlDealt?": "number",
	"turretKills?": "number",
	"inhibitorKills?": "number",
	"largestKillingSpree?": "number",
	"largestMultiKill?": "number",
	"doubleKills?": "number",
	"tripleKills?": "number",
	"quadraKills?": "number",
	"pentaKills?": "number",
	"longestTimeSpentLiving?": "number",

	"firstBloodKill?": "boolean",
	"firstBloodAssist?": "boolean",
	"firstTowerKill?": "boolean",
	"firstTowerAssist?": "boolean",
	"firstInhibitorKill?": "boolean",
	"firstInhibitorAssist?": "boolean",
	"gameEndedInSurrender?": "boolean",
	"gameEndedInEarlySurrender?": "boolean",
	"teamEarlySurrendered?": "boolean"
})
export type LcuParticipantStats = typeof LcuParticipantStats.infer

/**
 * `participants[i].timeline`.
 *
 * DO NOT TRUST `lane` OR `role`. In game 5633857616 four of ten players were labelled
 * `JUNGLE`, one of them with 273 lane CS. Every `*PerMinDeltas` map is `{}`. Infer roles
 * from frame positions + Smite instead (`.research/analytics.md` §2).
 */
export const LcuParticipantTimeline = type({
	"participantId?": "number",
	"lane?": "string",
	"role?": "string",
	"creepsPerMinDeltas?": "object",
	"csDiffPerMinDeltas?": "object",
	"damageTakenDiffPerMinDeltas?": "object",
	"damageTakenPerMinDeltas?": "object",
	"goldPerMinDeltas?": "object",
	"xpDiffPerMinDeltas?": "object",
	"xpPerMinDeltas?": "object"
})
export type LcuParticipantTimeline = typeof LcuParticipantTimeline.infer

/** `spell1Id`/`spell2Id` matter: id 11 is Smite, which is how junglers are identified. */
export const LcuParticipant = type({
	participantId: "number",
	teamId: "number",
	championId: "number",
	stats: LcuParticipantStats,
	"spell1Id?": "number",
	"spell2Id?": "number",
	"highestAchievedSeasonTier?": "string",
	"timeline?": LcuParticipantTimeline
})
export type LcuParticipant = typeof LcuParticipant.infer

/** `accountId` is 0 and `summonerName` is "" — match on `puuid`, always. */
export const LcuPlayer = type({
	"puuid?": "string",
	"gameName?": "string",
	"tagLine?": "string",
	"summonerId?": "number",
	"summonerName?": "string",
	"profileIcon?": "number",
	"platformId?": "string",
	"currentPlatformId?": "string"
})
export type LcuPlayer = typeof LcuPlayer.infer

export const LcuParticipantIdentity = type({
	participantId: "number",
	"player?": LcuPlayer
})
export type LcuParticipantIdentity = typeof LcuParticipantIdentity.infer

/** `win` is the STRING "Win"|"Fail", not a boolean. `firstDargon` is spelled that way. */
export const LcuTeam = type({
	teamId: "number",
	"win?": "string",
	"bans?": type({ "championId?": "number", "pickTurn?": "number" }).array(),
	"baronKills?": "number",
	"dragonKills?": "number",
	"hordeKills?": "number",
	"riftHeraldKills?": "number",
	"inhibitorKills?": "number",
	"towerKills?": "number",
	"firstBaron?": "boolean",
	"firstBlood?": "boolean",
	"firstDargon?": "boolean",
	"firstInhibitor?": "boolean",
	"firstTower?": "boolean"
})
export type LcuTeam = typeof LcuTeam.infer

/**
 * `GET /lol-match-history/v1/games/{gameId}` — 10 participants and 10 identities.
 *
 * The same shape comes back inside match history, but with only ONE participant (the queried
 * summoner). Check `participants.length` before assuming you have the other nine.
 * `gameDuration` is SECONDS; `gameCreation` is epoch ms. `seasonId` is always 0 — do not use it.
 */
export const LcuGame = type({
	gameId: "number",
	platformId: "string",
	gameCreation: "number",
	gameDuration: "number",
	gameMode: "string",
	gameType: "string",
	gameVersion: "string",
	queueId: "number",
	mapId: "number",
	participants: LcuParticipant.array(),
	participantIdentities: LcuParticipantIdentity.array(),
	"teams?": LcuTeam.array(),
	"endOfGameResult?": "string",
	"gameCreationDate?": "string",
	"gameModeMutators?": "unknown[]",
	"seasonId?": "number"
})
export type LcuGame = typeof LcuGame.infer

/**
 * `GET /lol-match-history/v1/products/lol/{puuid}/matches`.
 *
 * WARNING: `begIndex`/`endIndex` are SILENTLY IGNORED. You always get a server-chosen recent
 * window of about 20 games. There is no pagination — harvest incrementally into SQLite and
 * keep games forever; `/games/{id}` accepts arbitrary ids afterwards.
 */
export const LcuMatchHistory = type({
	"accountId?": "number",
	"platformId?": "string",
	games: {
		games: LcuGame.array(),
		"gameCount?": "number",
		"gameIndexBegin?": "number",
		"gameIndexEnd?": "number",
		"gameBeginDate?": "string",
		"gameEndDate?": "string"
	}
})
export type LcuMatchHistory = typeof LcuMatchHistory.infer

/* ============================================================== timeline */

/**
 * One player's state at a frame boundary. All ten keys are verified; `dominionScore` and
 * `teamScore` are always 0 (dead fields).
 *
 * Compared to Riot's public API this is MISSING `championStats`, `damageStats`,
 * `timeEnemySpentControlled` and `goldPerSecond`. Tempo metrics must be derived from
 * `totalGold` / `xp` / `minionsKilled` deltas instead.
 */
export const LcuParticipantFrame = type({
	participantId: "number",
	currentGold: "number",
	totalGold: "number",
	xp: "number",
	level: "number",
	minionsKilled: "number",
	jungleMinionsKilled: "number",
	position: { x: "number", y: "number" },
	"dominionScore?": "number",
	"teamScore?": "number"
})
export type LcuParticipantFrame = typeof LcuParticipantFrame.infer

/**
 * Every event is one flat C struct serialized with zero defaults, so EVERY event carries
 * EVERY field. Switch on `type` and ignore the rest.
 *
 * Only three types exist in the LCU timeline (verified over 22 games / 1928 events):
 * `CHAMPION_KILL`, `ELITE_MONSTER_KILL`, `BUILDING_KILL`. No item purchases, no wards,
 * no level-ups, no GAME_END. `type` is kept as a plain string so a new event kind added by
 * a patch flows through instead of failing validation.
 *
 * KNOWN CORRUPTION: `ELITE_MONSTER_KILL.assistingParticipantIds` is unreliable — 19% of
 * entries name players on the opposing team. `killerId` IS reliable. Do not compute
 * objective participation from those assists.
 */
export const LcuEvent = type({
	type: "string",
	timestamp: "number",
	"killerId?": "number",
	"victimId?": "number",
	"assistingParticipantIds?": "number[]",
	"position?": { x: "number", y: "number" },
	"buildingType?": "string",
	"towerType?": "string",
	"laneType?": "string",
	"monsterType?": "string",
	"monsterSubType?": "string",
	"teamId?": "number",
	"itemId?": "number",
	"skillSlot?": "number",
	"participantId?": "number"
})
export type LcuEvent = typeof LcuEvent.infer

/** Observed enum spaces. Anything outside them is possible — treat these as hints, not gates. */
export const MONSTER_TYPES = ["BARON_NASHOR", "DRAGON", "HORDE", "RIFTHERALD"] as const
export const DRAGON_SUBTYPES = [
	"AIR_DRAGON",
	"CHEMTECH_DRAGON",
	"EARTH_DRAGON",
	"ELDER_DRAGON",
	"FIRE_DRAGON",
	"HEXTECH_DRAGON",
	"WATER_DRAGON"
] as const
export const BUILDING_TYPES = ["TOWER_BUILDING", "INHIBITOR_BUILDING"] as const
export const TOWER_TYPES = [
	"OUTER_TURRET",
	"INNER_TURRET",
	"BASE_TURRET",
	"NEXUS_TURRET"
] as const
export const LANE_TYPES = ["TOP_LANE", "MID_LANE", "BOT_LANE"] as const

/**
 * A single timeline frame. `participantFrames` keys are STRINGS ("1".."10"), not numbers.
 * Frame 0 has `timestamp: 0` and sits everyone in their fountain slot.
 */
export const LcuFrame = type({
	timestamp: "number",
	participantFrames: { "[string]": LcuParticipantFrame },
	"events?": LcuEvent.array()
})
export type LcuFrame = typeof LcuFrame.infer

/**
 * `GET /lol-match-history/v1/game-timelines/{gameId}`. Top level has exactly one key.
 *
 * Cadence is 60 000 ms nominal (measured 60 000-60 103), and
 * `frames.length === Math.floor(gameDuration / 60) + 2` held for 22/22 games. There is no
 * `frameInterval` field, unlike Riot's public match-v5 timeline.
 *
 * ONE FRAME PER MINUTE is the central limitation of this whole product: the median
 * inter-frame displacement is 4082 units, ~28% of the map. Anything about who was standing
 * next to whom is an inference, and must be presented as one.
 */
export const LcuTimeline = type({
	frames: LcuFrame.array()
})
export type LcuTimeline = typeof LcuTimeline.infer

/** `frames.length === floor(durationSec / 60) + 2`, verified 22/22. Cheap sanity check. */
export const expectedFrameCount = (durationSec: number): number =>
	Math.floor(durationSec / 60) + 2

/* ========================================================== static data */

/** `GET /lol-game-data/assets/v1/champion-summary.json`. */
export const ChampionSummaryEntry = type({
	id: "number",
	"name?": "string",
	"alias?": "string",
	"squarePortraitPath?": "string"
})
export type ChampionSummaryEntry = typeof ChampionSummaryEntry.infer

export const ChampionSummary = ChampionSummaryEntry.array()
export type ChampionSummary = typeof ChampionSummary.infer

/* ============================================================= helpers */

/** `teams[i].win` is `"Win"` / `"Fail"`. */
export const teamWon = (t: { win?: string }): boolean => t.win === "Win"

/** The user's participantId in a game, or `null`. Match on puuid — never on summonerName. */
export const findParticipantIdByPuuid = (
	game: LcuGame,
	puuid: string
): number | null => {
	const hit = game.participantIdentities.find(pi => pi.player?.puuid === puuid)
	return hit ? hit.participantId : null
}

/** `participantIdentities` indexed by participantId. */
export const identityMap = (game: LcuGame): Map<number, LcuPlayer> =>
	new Map(
		game.participantIdentities.flatMap(pi =>
			pi.player ? [[pi.participantId, pi.player] as const] : []
		)
	)

/** `participants` indexed by participantId. */
export const participantMap = (game: LcuGame): Map<number, LcuParticipant> =>
	new Map(game.participants.map(p => [p.participantId, p] as const))

/** A match-history list entry carries only the queried summoner. */
export const isListEntry = (game: LcuGame): boolean => game.participants.length < 10
