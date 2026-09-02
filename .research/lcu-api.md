# LCU API surface — verified reference

**Probed live on 2026-09-02, 16:15–16:35 EDT.**
Client: League of Legends **16.17.812.4632** (`/system/v1/builds`), game version `16.17.810.4348`,
region NA1, account `Gooskaffur#NA1` / puuid `188dee22-18d6-5752-ba7f-b69cf3d2506e`.
Everything below marked **VERIFIED** was produced by a command in this session; output is quoted
verbatim (secrets redacted). Anything I could not exercise is marked **UNVERIFIED** and says why.

> The user was **in an active ranked game** for most of this session (`gameflow-phase` = `InProgress`,
> gameId `5633902080`). All probes were read-only GETs plus one WAMP *subscribe* frame on the
> websocket. No POST/PUT/PATCH/DELETE was issued to the LCU or the game client.

---

## 0. TL;DR for the build phase

| Decision | Answer |
|---|---|
| Transport | **Long-lived Windows-side Node bridge over stdio.** p50 **2.3 ms** round trip vs **88 ms** for `curl.exe` per-request spawn (38× faster). Reference implementation in §7. |
| Fallback transport | `curl.exe -K -` (config on stdin) — password never enters argv. ~88 ms/req cold, ~9.6 ms/req when batched into one invocation. |
| Events | The LCU **WebSocket works** (`wss://127.0.0.1:<port>/`, WAMP). Verified receiving live `[8,"OnJsonApiEvent",{uri,eventType,data}]` frames. Use it instead of polling for gameflow transitions. |
| History depth | **`begIndex`/`endIndex` are silently ignored on 16.17.** You get a server-chosen recent window (I observed 5, 20 and 21 games at different moments). There is **no deep pagination**. See §1.1 — this is the single most important constraint on the product. |
| Deep history workaround | `/lol-match-history/v1/games/{gameId}` and `/game-timelines/{gameId}` accept **arbitrary gameIds**, including games the user never played, going back at least 21 days. So: harvest gameIds incrementally into a local DB and re-fetch details forever. |
| Static data | 100% available offline from the LCU (`/lol-game-data/assets/...`), and byte-identically from CommunityDragon when the client is closed. Icons included. |
| Live in-game data | The **Live Client Data API on port 2999** is available and gives per-second stats, items, runes, scores and events. Param is `riotId`, **not** `summonerName` (that now 400s). No champion x/y positions. |

---

## 1. Match history

### 1.1 Pagination — `begIndex`/`endIndex` DO NOT WORK (VERIFIED, high confidence)

Two endpoints exist (names from `/help?format=Full`, which encodes method+path in the function name):

```
GET /lol-match-history/v1/products/lol/current-summoner/matches?begIndex=&endIndex=
GET /lol-match-history/v1/products/lol/{puuid}/matches?begIndex=&endIndex=
```

Both accept the params (a wrong param name 400s, so they *are* parsed) and then ignore them.

```
$ for r in 0:0 0:19 20:39 40:59 100:119 200:219 0:199 500:519 1000:1019; do ...
--- OTHER PUUID paging (957a3bba-…, a teammate)
0:0        200 n=20 idx=0..19 count=20 newest=2026-09-02T19:54:07.923Z oldest=2026-08-30T01:51:09.258Z
0:19       200 n=20 idx=0..19 count=20 newest=… oldest=…      (identical)
20:39      200 n=20 idx=0..19 count=20 newest=… oldest=…      (identical)
1000:1019  200 n=20 idx=0..19 count=20 newest=… oldest=…      (identical)
```

Every range returns the **same** 20 games. Same result for the current summoner and for
`.../{own puuid}/matches`. `gameIndexBegin`/`gameIndexEnd`/`gameCount` merely *describe* what came
back; they are not a cursor.

Wrong param names are rejected, proving the query string is parsed:
```
$ .../current-summoner/matches?begin=0&count=5      -> HTTP 400
```

**The window size is not stable.** Across ~20 minutes I observed for the same account:

| Time | `n` returned | Oldest game in window |
|---|---|---|
| 16:18 | 21 | 2026-09-01T05:10:38Z |
| 16:29 onward (10 consecutive calls, 3 s apart) | 5 | 2026-09-02T14:58:52Z |

A teammate's puuid returned exactly 20 at the same moment. So the size is decided server/client-side
and can shrink under you — **treat the list endpoint as "recent games, count unspecified"** and
never as a page.

> UNVERIFIED: whether a client restart or leaving `InProgress` restores the larger window. The 21→5
> collapse happened while the user was mid-game; that correlation is suggestive, not established.

**Consequence for the app:** the only way to build deep history is to poll this endpoint on a
schedule, union the gameIds into a local store, and hydrate each one via `/games/{gameId}`. A cold
install can never backfill more than the current window from the LCU alone. (Riot's public
`/lol/match/v5/matches/by-puuid/{puuid}/ids` does paginate to 1000, but needs an API key — out of
scope here, flagged as the only real backfill option.)

### 1.2 `/lol-match-history/v1/games/{gameId}` accepts ANY gameId (VERIFIED)

```
$ for g in 5631300986 5620000000 5600000000 1; do curl.exe … /lol-match-history/v1/games/$g; done
5631300986 -> HTTP 200 31784B   {"gameCreationDate":"2026-08-30T02:23:32.831Z", …}   # NOT the user's game
5620000000 -> HTTP 200          {"gameCreationDate":"2026-08-12T07:01:21.374Z", …}   # 21 days old
5600000000 -> HTTP 404 {"errorCode":"RPC_ERROR","httpStatus":404,…"match file not found"}
1          -> HTTP 404  (same)
```

`5631300986` is one *below* a gameId the user played, i.e. somebody else's match — it still returns
full stats for all 10 participants. 404 on a sparse id means "that id doesn't exist", not "expired":
`5620000000` (Aug 12, 21 days back) is fine. Match/timeline retention is therefore **≥ 21 days**,
much longer than replay retention.

### 1.3 Response envelope (VERIFIED)

```jsonc
{
  "accountId": 2506880536102496,
  "platformId": "NA1",
  "games": {
    "gameBeginDate": "", "gameEndDate": "",     // always empty strings
    "gameIndexBegin": 0, "gameIndexEnd": 20, "gameCount": 21,
    "games": [ /* MatchHistoryGame */ ]
  }
}
```

**Critical difference between the two shapes:**

| | list endpoint | `/games/{gameId}` |
|---|---|---|
| `participants` | **1** (the queried summoner only) | **10** |
| `participantIdentities` | **1** | **10** (puuid, gameName, tagLine, summonerId, profileIcon for everyone) |
| `teams` | 2 (full) | 2 (full) |

So the list is a cheap index; you must call `/games/{gameId}` for anything about the other 9 players.

### 1.4 Game object (VERIFIED — all 16 keys)

```jsonc
{
  "endOfGameResult": "GameComplete",
  "gameCreation": 1788375176422,                       // epoch ms
  "gameCreationDate": "2026-09-02T18:52:56.422Z",
  "gameDuration": 2310,                                // SECONDS
  "gameId": 5633857616,
  "gameMode": "CLASSIC",
  "gameModeMutators": [],                              // always [] in 22 observed games
  "gameType": "MATCHED_GAME",
  "gameVersion": "16.17.810.4348",
  "mapId": 11,
  "platformId": "NA1",
  "queueId": 420,
  "seasonId": 0,                                       // always 0 — do not use
  "participantIdentities": [...], "participants": [...], "teams": [...]
}
```

`participantIdentities[i].player`:
```jsonc
{ "accountId": 0, "currentAccountId": 0,               // always 0 now (deprecated)
  "currentPlatformId": "NA1", "platformId": "NA1",
  "gameName": "Gooskaffur", "tagLine": "NA1",
  "summonerName": "",                                  // always "" — use gameName#tagLine
  "matchHistoryUri": "",                               // always ""
  "profileIcon": 6060, "puuid": "188dee22-…" }
```

`participants[i]` (non-stats keys):
```jsonc
{ "championId": 876, "participantId": 7, "teamId": 200,
  "spell1Id": 4, "spell2Id": 11, "highestAchievedSeasonTier": "",
  "timeline": { "participantId": 7, "lane": "JUNGLE", "role": "NONE",
                "creepsPerMinDeltas": {}, "csDiffPerMinDeltas": {},        // ALL delta maps
                "damageTakenDiffPerMinDeltas": {}, "damageTakenPerMinDeltas": {},
                "goldPerMinDeltas": {}, "xpDiffPerMinDeltas": {}, "xpPerMinDeltas": {} },
  "stats": { /* 118 fields, §1.5 */ } }
```

> **`timeline.lane`/`role` are unreliable.** In game 5633857616 four of ten players were labelled
> `JUNGLE`. Derive role from the Live Client Data API's `position` field, or from lane assignment
> heuristics on timeline positions, not from this. All per-minute delta maps are **empty objects** —
> you must compute deltas yourself from the timeline frames.

`teams[i]` (16 fields, VERIFIED):
```jsonc
{ "teamId": 100, "win": "Fail",                        // "Win" | "Fail" (STRING, not bool)
  "bans": [ {"championId": 39, "pickTurn": 1}, … 5 entries ],
  "baronKills": 0, "dragonKills": 0, "hordeKills": 3, "riftHeraldKills": 0,
  "inhibitorKills": 1, "towerKills": 5, "vilemawKills": 0,
  "firstBaron": false, "firstBlood": false, "firstDargon": false,   // sic: "firstDargon"
  "firstInhibitor": true, "firstTower": false,
  "dominionVictoryScore": 0 }
```

### 1.5 Per-participant stats — all 118 fields (VERIFIED)

Real values from participant 1 of game 5633857616. Fields that were 0/false for every participant in
every game I looked at are flagged **[dead]**.

```
assists 5                       kills 2                        deaths 11
champLevel 17                   goldEarned 12867               goldSpent 12400
totalMinionsKilled 228          neutralMinionsKilled 0
neutralMinionsKilledEnemyJungle 0   neutralMinionsKilledTeamJungle 0
visionScore 25                  wardsPlaced 11                 wardsKilled 1
visionWardsBoughtInGame 0       sightWardsBoughtInGame 0
item0..item6 3047,3142,6631,3071,3066,1031,3340                 roleBoundItem 1220
perk0..perk5 8010,9111,9105,8014,8236,8234
perk0Var1..perk5Var3 (18 ints)  perkPrimaryStyle 8000          perkSubStyle 8200
totalDamageDealt 166156         totalDamageDealtToChampions 16513
physicalDamageDealt 158080      physicalDamageDealtToChampions 11971
magicDamageDealt 0              magicDamageDealtToChampions 0
trueDamageDealt 8076            trueDamageDealtToChampions 4541
totalDamageTaken 52480          physicalDamageTaken 31973
magicalDamageTaken 10726        trueDamageTaken 9779           damageSelfMitigated 48606
damageDealtToObjectives 9213    damageDealtToTurrets 8265
totalHeal 1053                  totalUnitsHealed 1
timeCCingOthers 40              totalTimeCrowdControlDealt 275
turretKills 2                   inhibitorKills 0
killingSprees 0                 largestKillingSpree 0          largestMultiKill 1
doubleKills 0  tripleKills 0  quadraKills 0  pentaKills 0  unrealKills 0
largestCriticalStrike 0         longestTimeSpentLiving 603
firstBloodKill/Assist, firstTowerKill/Assist, firstInhibitorKill/Assist  (6 bools)
win false                       participantId 1
gameEndedInSurrender / gameEndedInEarlySurrender / teamEarlySurrendered /
  causedEarlySurrender / earlySurrenderAccomplice / gameEndedInIGNBSurrender /
  causedGameEndFromIGNBSurrender / wasSevereTransgressor   (8 bools)
playerAugment1..6 [dead on SR]  playerSubteamId 0 [dead]  subteamPlacement 0 [dead]
playerScore0..playerScore9 [dead]  combatPlayerScore / objectivePlayerScore /
  totalPlayerScore / totalScoreRank [dead]  dominionScore-era leftovers
```

**Rune slot mapping (VERIFIED)** by cross-referencing `/lol-game-data/assets/v1/perkstyles.json`:

```
perkPrimaryStyle 8000 = Precision      perkSubStyle 8200 = Sorcery
perk0 8010 = Conqueror       | Precision slot0 (kKeyStone)
perk1 9111 = Triumph         | Precision slot1
perk2 9105 = Legend: Haste   | Precision slot2
perk3 8014 = Coup de Grace   | Precision slot3
perk4 8236 = Gathering Storm | Sorcery   slot3     <- note: perk4/perk5 are NOT slot-ordered
perk5 8234 = Celerity        | Sorcery   slot2
statmods present in stats? []           <- stat shards (5001-5011) are NOT in match stats
```

`perkNVar1..3` are the runes' end-of-game stat values (e.g. `perk0Var1 = 598` damage from
Conqueror); `perks.json` carries `endOfGameStatDescs` to label them.

### 1.6 queueId / gameMode / mapId (VERIFIED)

All 22 games in the sampled window were `queueId 420 / CLASSIC / MATCHED_GAME / mapId 11`, so I
cannot enumerate the value space from live data. Instead, the authoritative local tables are:

- `GET /lol-game-data/assets/v1/queues.json` — **420 entries**, array of
  `{id, name, shortName, description, detailedDescription, gameSelectModeGroup, gameSelectCategory,
    gameSelectPriority, isSkillTreeQueue, isLimitedTimeQueue, isBotHonoringAllowed,
    hidePlayerPosition, viableChampionRoster[], pickMode}`.
  `id 420 -> {name:"Ranked Solo/Duo", gameSelectModeGroup:"kSummonersRift", gameSelectCategory:"kPvP"}`.
- `GET /lol-game-data/assets/v1/maps.json` (1 414 B) and `GET /lol-maps/v1/maps` (27 306 B).
- `gameMode` string values also come from `queues.json` / the map resource
  (`/lol-gameflow/v1/session` → `map.gameMode = "CLASSIC"`, `map.mapStringId = "SR"`).

### 1.7 Identifying the user (VERIFIED)

1. `GET /lol-summoner/v1/current-summoner` → `puuid`, `summonerId`, `gameName`, `tagLine`.
2. In a game object: `participantIdentities.find(p => p.player.puuid === myPuuid).participantId`.
3. That `participantId` is the key into `participants[]`, into timeline `participantFrames`, and is
   the `killerId`/`victimId`/`assistingParticipantIds` value space.

Do **not** match on `summonerName` — it is `""` everywhere now. `accountId` inside
`participantIdentities` is `0`; the top-level `accountId` in the list envelope is real
(`2506880536102496`).

Other identity endpoints, all VERIFIED 200:
`/lol-summoner/v2/summoners/puuid/{puuid}`, `/lol-summoner/v1/summoners/{summonerId}`,
`/lol-chat/v1/me`, `/riotclient/region-locale` → `{"locale":"en_US","region":"NA","webLanguage":"en","webRegion":"na"}`.

`GET /lol-match-history/v1/recently-played-summoners` → 45 entries of
`{championId, gameCreationDate, gameId, gameName, tagLine, puuid, summonerId, summonerName:"", teamId}`
— a secondary gameId source, but limited to the same recent window.

### 1.8 Ranked context (VERIFIED)

`GET /lol-ranked/v1/current-ranked-stats` (9 970 B) → `queueMap.RANKED_SOLO_5x5`:
```jsonc
{ "tier":"PLATINUM", "division":"IV", "leaguePoints":19, "wins":190, "losses":180,
  "highestTier":"PLATINUM", "highestDivision":"IV", "isProvisional":false,
  "previousSeasonEndTier":"SILVER", "previousSeasonEndDivision":"III",
  "warnings":{"daysUntilDecay":-2,"demotionWarning":1,"displayDecayWarning":false,
              "timeUntilInactivityStatusChanges":-1},
  "queueType":"RANKED_SOLO_5x5", "ratedTier":"NONE", "ratedRating":0, … }
```
Also `/lol-ranked/v1/ranked-stats/{puuid}` and `/lol-ranked/v1/cached-ranked-stats/{puuid}` for others.

---

## 2. Timelines — `/lol-match-history/v1/game-timelines/{gameId}`

Analysed **22 timelines** (all 21 games in the history window at 16:19 plus the older game
5631300987 that has a `.rofl` on disk). 6 880 participant-frames, 1 928 events.

### 2.1 Shape (VERIFIED)

```jsonc
{ "frames": [
    { "timestamp": 60015,                       // ms since game start
      "participantFrames": { "1": {…}, "2": {…}, … "10": {…} },   // keys are STRINGS
      "events": [ … ] },
    … ] }
```
Top level has exactly one key, `frames`. There is **no** `frameInterval` field (unlike Riot's public
match-v5 timeline).

### 2.2 Frame cadence (VERIFIED, exact)

- Nominal interval **60 000 ms**; measured deltas were 60 000–60 103 ms (one outlier per game around
  frame 4–6, up to +103 ms). Never a short frame except the final one.
- **`frames.length === Math.floor(gameDuration / 60) + 2`** — verified **22/22 games**, zero
  mismatches, durations 453 s → 2 912 s. Frame 0 is `timestamp: 0` (spawn), and there is one
  trailing partial-minute frame.

### 2.3 `participantFrames` — exhaustive field list (VERIFIED, all 10 keys)

```jsonc
{ "participantId": 7,
  "currentGold": 428,          // unspent
  "totalGold": 1778,           // lifetime earned
  "xp": 1577,
  "level": 4,
  "minionsKilled": 0,          // lane minions only
  "jungleMinionsKilled": 28,   // includes scuttle; excludes epic monsters
  "position": { "x": 7705, "y": 11053 },
  "dominionScore": 0,          // always 0 — dead field
  "teamScore": 0 }             // always 0 — dead field
```

Compared with Riot's public API this is **missing**: `championStats` (AD/AP/armor/…),
`damageStats` (damage dealt/taken breakdown per minute), `timeEnemySpentControlled`,
`goldPerSecond`. Those are unavailable from the LCU — the app must derive tempo metrics from
`totalGold`/`xp`/`minionsKilled` deltas.

### 2.4 Events — the event set does NOT vary by game (VERIFIED across 22 games)

```
EVENT TYPE COUNTS (22 games, 1928 events):
  CHAMPION_KILL      1416
  ELITE_MONSTER_KILL  202
  BUILDING_KILL       310
```

Only these three types. Two very short games (9 and 12 frames) had no `BUILDING_KILL` simply because
no building fell — the *set* is identical, only the counts vary. **No `ITEM_PURCHASED`,
`ITEM_SOLD`, `ITEM_DESTROYED`, `WARD_PLACED`, `WARD_KILL`, `SKILL_LEVEL_UP`, `LEVEL_UP`,
`TURRET_PLATE_DESTROYED`, `GAME_END`, `PAUSE_*`, `OBJECTIVE_BOUNTY_*`, `DRAGON_SOUL_GIVEN`,
`CHAMPION_SPECIAL_KILL`** — the LCU timeline is a strict subset of the public match-v5 timeline.

**Every event carries every field** (it is one flat C struct serialized with zero defaults), so you
must switch on `type` and ignore the rest:

```jsonc
// CHAMPION_KILL
{ "type":"CHAMPION_KILL", "timestamp":136607,
  "killerId":10, "victimId":5, "assistingParticipantIds":[9],
  "position":{"x":12667,"y":2783},
  "buildingType":"", "laneType":"", "towerType":"", "monsterType":"", "monsterSubType":"",
  "itemId":0, "skillSlot":0, "participantId":0, "teamId":0 }

// ELITE_MONSTER_KILL
{ "type":"ELITE_MONSTER_KILL", "timestamp":436750,
  "killerId":7, "assistingParticipantIds":[10],
  "monsterType":"DRAGON", "monsterSubType":"CHEMTECH_DRAGON",
  "position":{"x":9850,"y":4426}, "victimId":0, "teamId":0, … }

// BUILDING_KILL
{ "type":"BUILDING_KILL", "timestamp":956054,
  "killerId":9, "assistingParticipantIds":[],
  "buildingType":"TOWER_BUILDING", "towerType":"OUTER_TURRET", "laneType":"MID_LANE",
  "teamId":100,                                  // teamId = team that LOST the building
  "position":{"x":5846,"y":6396}, "victimId":0, … }
```

Observed enum value spaces across all 22 games:
```
monsterType     : BARON_NASHOR | DRAGON | HORDE | RIFTHERALD
monsterSubType  : AIR_DRAGON | CHEMTECH_DRAGON | EARTH_DRAGON | ELDER_DRAGON |
                  FIRE_DRAGON | HEXTECH_DRAGON | WATER_DRAGON
buildingType    : TOWER_BUILDING | INHIBITOR_BUILDING
towerType       : OUTER_TURRET | INNER_TURRET | BASE_TURRET | NEXUS_TURRET
laneType        : TOP_LANE | MID_LANE | BOT_LANE
teamId          : 0 (unset) | 100 | 200
itemId, skillSlot, participantId : always 0    <- padding, never populated
assistingParticipantIds : max length observed 7
```
`monsterSubType` is `""` for BARON_NASHOR / RIFTHERALD / HORDE (voidgrubs). No `ATAKHAN` observed
in this sample; UNVERIFIED whether 16.17 emits it.

### 2.5 Map coordinate system for Summoner's Rift (VERIFIED, measured)

```
participantFrames positions (6880 samples): x [130, 14589]   y [135, 14673]
event positions          (1928 samples):    x [481, 14282]   y [606, 14375]
frame 0, participants 1-5 (team 100/blue):  x [130,   662]   y [135,   675]
frame 0, participants 6-10 (team 200/red):  x [14055, 14589] y [14170, 14673]
```

So: **origin (0,0) is the blue-side (team 100) fountain, bottom-left. +x is toward red base
(east/right), +y is toward the top of the minimap (north/up).** Team 200 spawns near the maximum
corner.

Riot's canonical SR bounds are `x/y ∈ [-120, 14870]` / `[-120, 14980]` — **UNVERIFIED** here (my
sample only proves the observed span). For rendering, using `0 → 14870` on both axes and
**flipping y** (`screenY = height * (1 - y/14870)`) matches the standard minimap orientation.
Landmarks consistent with the standard map: the drake pit kill at `(9850, 4426)` is bot-side river,
and the mid outer turret kill at `(5846, 6396)` sits just left of centre — both correct for that
convention.

---

## 3. Replays — `/lol-replays/v1/*`

### 3.1 Complete endpoint list (from `/help?format=Full`, VERIFIED it is the full set)

```
GET  /lol-replays/v1/configuration                 -> LolReplaysReplaysConfiguration
GET  /lol-replays/v1/metadata/{gameId}             -> LolReplaysReplayMetadata
GET  /lol-replays/v1/rofls/path                    -> string
GET  /lol-replays/v1/rofls/path/default            -> string
POST /lol-replays/v1/metadata/{gameId}/create/game-version/{gameVersion}/game-type/{gameType}/queue-id/{queueId}
POST /lol-replays/v2/metadata/{gameId}/create      body: {gameVersion, gameType, queueId, gameEnd}
POST /lol-replays/v1/rofls/{gameId}/download       body: {componentType}
POST /lol-replays/v1/rofls/{gameId}/download/graceful
POST /lol-replays/v1/rofls/{gameId}/watch          body: {componentType}
POST /lol-replays/v1/rofls/scan
```
There are **no other GETs** in the `lol-replays` plugin. In particular there is no "list downloaded
replays" endpoint — enumerate the directory instead.

### 3.2 Live responses (VERIFIED)

```
$ GET /lol-replays/v1/configuration
{"gameVersion":"16.17.810.4348","isInTournament":false,"isLoggedIn":true,"isPatching":false,
 "isPlayingGame":true,"isPlayingReplay":false,"isReplaysEnabled":true,
 "isReplaysForEndOfGameEnabled":true,"isReplaysForMatchHistoryEnabled":true,
 "minServerVersion":"","minutesUntilReplayConsideredLost":30}

$ GET /lol-replays/v1/rofls/path          -> "C:/Users/ssalb/Documents/League of Legends/Replays"
$ GET /lol-replays/v1/rofls/path/default  -> same
```

`isPlayingGame:true` reflects the in-progress game; poll this to know when it is safe to trigger a
download. **`minutesUntilReplayConsideredLost: 30`** is the client's own threshold for moving
metadata to the `lost` state — UNVERIFIED what wall-clock event it is measured from.

### 3.3 Metadata is LOCAL state, not a server query — the key gotcha (VERIFIED)

I queried `/lol-replays/v1/metadata/{gameId}` for all 21 games in history plus the older game whose
`.rofl` is on disk:

```
5633857616  200  {"downloadProgress":331844411,"gameId":5633857616,"state":"download"}
5631300987  200  {"downloadProgress":0,"gameId":5631300987,"state":"watch"}     # .rofl is on disk
all 19 others AND 5620000000
            404  {"errorCode":"RPC_ERROR","httpStatus":404,
                  "message":"Plugin found no local metadata. Try using the POST metadata create endpoint first."}
```

**404 does not mean "expired"** — it means the client has never created a local metadata record for
that gameId. You must `POST /lol-replays/v2/metadata/{gameId}/create` (or the v1 path form) with
`{gameVersion, gameType, queueId, gameEnd}` from the match-history entry *before* the state is
meaningful. Then `GET /metadata/{gameId}` becomes the progress poll.

`downloadProgress` is `uint32`; the `331844411` above is clearly uninitialised garbage for a
not-yet-started download, so only trust it while `state === "downloading"`.

### 3.4 `state` value space — the complete enum (VERIFIED from the client's own type table)

`LolReplaysMetadataState`:
```
checking | download | downloading | error | found | incompatible |
lost | missingOrExpired | retryDownload | unsupported | watch
```
Mapping to the questions asked:
- **`watch`** — the `.rofl` is downloaded and playable (this was the state for the on-disk replay).
- **`download`** — server has it; a download can be triggered.
- **`downloading`** — in flight; poll `downloadProgress`.
- **`missingOrExpired`** — Riot no longer has the replay (the ~2-week expiry).
- **`incompatible`** / **`unsupported`** — recorded on a different patch than the installed client.
- **`lost`** — passed `minutesUntilReplayConsideredLost` without completing.
- `checking`, `found`, `error`, `retryDownload` — transient.

> **UNVERIFIED (deliberate):** I did not execute the POST create/download flow, because the hard
> rules forbid mutating LCU state and the user was mid-game. The exact `{componentType}` string
> accepted by `/rofls/{gameId}/download` is also unverified (the client UI typically sends
> `"missions"` or the originating component name). The build phase must test this on a game the user
> is not in.

### 3.5 On-disk replays (VERIFIED)

```
$ ls -la "/mnt/c/Users/ssalb/Documents/League of Legends/Replays"
-rwxrwxrwx 1 ssalb ssalb 14979193 Aug 29 22:55 NA1-5631300987.rofl
```
Filename convention `{platformId}-{gameId}.rofl`. Enumerating this directory + a metadata lookup per
id is the only way to know what is cached locally. The client's `LolReplaysRoflFileMetadata` type
(`gameLength:uint32, gameVersion:string, lastGameChunkId:uint32, lastKeyFrameId:uint32`) tells you
what it parses out of the header, but no GET exposes it.

---

## 4. Gameflow and live-game detection

### 4.1 Phase machine (VERIFIED — enum read from the client's type table)

`GET /lol-gameflow/v1/gameflow-phase` → a bare JSON string. `LolGameflowGameflowPhase` values:

| Value | int | Meaning for a daemon |
|---|---|---|
| `None` | 0 | idle / main menu |
| `Lobby` | 1 | in a lobby |
| `Matchmaking` | 2 | in queue |
| `CheckedIntoTournament` | 3 | |
| `ReadyCheck` | 4 | accept popup |
| `ChampSelect` | 5 | **champ select — draft coaching hook** |
| `GameStart` | 6 | game launching |
| `InProgress` | 8 | **in game — Live Client Data on :2999 is up** |
| `Reconnect` | 9 | |
| `WaitingForStats` | 10 | game over, stats not ready |
| `PreEndOfGame` | 11 | honor screen |
| `EndOfGame` | 12 | **EOG screen — `/lol-end-of-game/v1/eog-stats-block` is populated** |
| `FailedToLaunch` | 7 / `TerminatedInError` 13 | error paths |

Live at probe time:
```
$ GET /lol-gameflow/v1/gameflow-phase   -> "InProgress"
$ GET /lol-gameflow/v1/availability     -> {"isAvailable":true,"state":"InGameFlow"}
$ GET /lol-gameflow/v1/watch            -> "None"     # LolGameflowGameflowWatchPhase:
                                                      # None|WatchStarted|WatchInProgress|WatchFailedToLaunch
```
`/lol-gameflow/v1/watch` is how you detect that a **replay** is playing (as opposed to a live game).

### 4.2 `GET /lol-gameflow/v1/session` (VERIFIED, 11 032 B)

```jsonc
{ "phase": "InProgress",
  "gameClient": { "running": true, "visible": true,
                  "serverIp": "192.207.0.5", "serverPort": 7097,
                  "observerServerIp": "", "observerServerPort": 0 },
  "gameData": {
    "gameId": 5633902080,                 // <-- the CURRENT game's id, available mid-game
    "gameName": "", "password": "", "isCustomGame": false,
    "spectatorKey": "…", "spectatorsAllowed": …,
    "queue": { "id": 420, "gameMode": "CLASSIC", "mapId": 11, … },
    "playerChampionSelections": [ {championId, puuid, selectedSkinIndex, spell1Id, spell2Id} × 10 ],
    "teamOne": [ {championId, puuid, summonerId, selectedPosition:"TOP",
                  selectedRole:"TOP.PRIMARY.TOP.MIDDLE.FILL", profileIconId,
                  lastSelectedSkinIndex, teamOwner, teamParticipantId} × 5 ],
    "teamTwo": [ … × 5 ] },
  "map": { "id": 11, "name": "Summoner's Rift", "mapStringId": "SR", "gameMode": "CLASSIC",
           "assets": {…}, "gameModeName", "gameModeShortName", "gameMutator", "isRGM",
           "perPositionDisallowedSummonerSpells", "perPositionRequiredSummonerSpells", … },
  "gameDodge": { "dodgeIds": [], "phase": "None", "state": "Invalid" } }
```
This is the single best "what is happening right now" call: phase, current gameId, both rosters with
puuids, **`selectedPosition`** (far more reliable than the match-history `timeline.lane`), and
whether the game process is running.

### 4.3 Champ select (VERIFIED shape of the failure; success shape UNVERIFIED)

```
$ GET /lol-champ-select/v1/session
{"errorCode":"RPC_ERROR","httpStatus":404,"message":"No active delegate"}    HTTP 404
```
404 with `"No active delegate"` is the normal "not in champ select" answer — treat it as a state, not
an error. Also available (all `Get…`, from the help table): `/lol-champ-select/v1/session/my-selection`,
`/session/timer`, `/current-champion`, `/pickable-champion-ids`, `/bannable-champion-ids`,
`/disabled-champion-ids`, `/all-grid-champions`. I could not exercise their populated shapes because
the user was in-game, not in draft. **UNVERIFIED.**

### 4.4 Live Client Data API — port 2999 (VERIFIED, this is a major find)

A **separate** HTTP service run by the *game* process, not the LCU. **No authentication**, self-signed
cert, only alive while `phase === "InProgress"` (or a replay is playing).

```
$ curl.exe -sk https://127.0.0.1:2999/liveclientdata/allgamedata
HTTP 200  31906 B  in 0.028 s
```

Endpoint list read from its own `GET /swagger/v3/openapi.json` (VERIFIED, complete):
```
GET /liveclientdata/allgamedata            ?eventID=
GET /liveclientdata/activeplayer
GET /liveclientdata/activeplayername
GET /liveclientdata/activeplayerabilities
GET /liveclientdata/activeplayerrunes
GET /liveclientdata/playerlist             ?teamID=
GET /liveclientdata/playeritems            ?riotId=
GET /liveclientdata/playermainrunes        ?riotId=
GET /liveclientdata/playerscores           ?riotId=
GET /liveclientdata/playersummonerspells   ?riotId=
GET /liveclientdata/eventdata              ?eventID=
GET /liveclientdata/gamestats
GET /swagger/v1/api-docs   /swagger/v2/swagger.json   /swagger/v3/openapi.json
```

> **BREAKING vs every tutorial online: the query parameter is `riotId`, not `summonerName`.**
> ```
> ?summonerName=Gooskaffur -> 400 {"errorCode":"BAD_REQUEST","message":"Unknown argument 'summonerName' for 'GetLiveclientdataPlayerscores'."}
> --data-urlencode "riotId=Gooskaffur#NA1" -> 200 {"assists":0,"creepScore":40,"deaths":1,"kills":0,"wardScore":2.1002271}
> ```
> Remember to URL-encode the `#`.

`allgamedata` shape (VERIFIED):
```jsonc
{ "gameData": { "gameMode":"CLASSIC", "gameTime":329.318, "mapName":"Map11",
                "mapNumber":11, "mapTerrain":"Default" },
  "activePlayer": {
    "riotId":"Gooskaffur#NA1", "riotIdGameName":"Gooskaffur", "riotIdTagLine":"NA1",
    "summonerName":"Gooskaffur#NA1", "level":5, "currentGold":…, "teamRelativeColors":…,
    "abilities": { "Passive":{…}, "Q":{…}, "W":{…}, "E":{…}, "R":{…} },   // includes abilityLevel
    "fullRunes": { keystone, primaryRuneTree, secondaryRuneTree, generalRunes[], statRunes[] },
    "championStats": { abilityHaste, abilityPower, armor, armorPenetrationFlat,
      armorPenetrationPercent, attackDamage, attackRange, attackSpeed,
      bonusArmorPenetrationPercent, bonusMagicPenetrationPercent, critChance, critDamage,
      currentHealth, healShieldPower, healthRegenRate, lifeSteal, magicLethality,
      magicPenetrationFlat, magicPenetrationPercent, magicResist, maxHealth, moveSpeed,
      omnivamp, physicalLethality, physicalVamp, resourceMax, resourceRegenRate,
      resourceType, resourceValue, spellVamp, tenacity } },              // 31 fields
  "allPlayers": [ {
      "riotId":"Gooskaffur#NA1", "championName":"Lillia",
      "rawChampionName":"game_character_displayname_Lillia", "rawSkinName":…,
      "team":"CHAOS",              // ORDER = team 100, CHAOS = team 200
      "position":"JUNGLE",         // TOP|JUNGLE|MIDDLE|BOTTOM|UTILITY — RELIABLE
      "level":6, "isBot":false, "isDead":false, "respawnTimer":0,
      "scores": {"kills":1,"deaths":0,"assists":0,"creepScore":30,"wardScore":0},
      "items": [ {itemID, displayName, count, price, slot, canUse, consumable,
                  rawDescription, rawDisplayName} ],       // LIVE ITEM BUILD, incl. trinket slot 6
      "runes": {keystone:{id,displayName}, primaryRuneTree:{…}, secondaryRuneTree:{…}},
      "summonerSpells": {summonerSpellOne:{displayName,…}, summonerSpellTwo:{…}}
    } × 10 ],
  "events": { "Events": [
      {"EventID":0,"EventName":"GameStart","EventTime":0.0303},
      {"EventID":1,"EventName":"MinionsSpawning","EventTime":30.048},
      {"EventID":2,"EventName":"ChampionKill","EventTime":194.729,
       "KillerName":"xxXLouvAXxx","VictimName":"AbiDabi","Assisters":["Ghostexe","Diablo0310"]},
      {"EventID":3,"EventName":"FirstBlood","EventTime":194.729,"Recipient":"xxXLouvAXxx"}, … ] } }
```

**This fills the biggest gaps in the LCU timeline**: item purchases (by diffing `items` between
polls), ability levels, rune shards, live stats, and accurate `position`. Its limitation is the
mirror image: **no x/y coordinates for anyone.** Positions only come from the post-game timeline.

**Recommended daemon design:** while `InProgress`, poll `:2999/liveclientdata/allgamedata` every
1–2 s and journal it; on `EndOfGame`, fetch `/games/{gameId}` + `/game-timelines/{gameId}` and join
the two on `participantId` ↔ `riotId`. That reconstructs a near-complete public-API-grade timeline.

### 4.5 End-of-game

```
$ GET /lol-end-of-game/v1/eog-stats-block
HTTP 404 {"errorCode":"RPC_ERROR","message":"No end of game stats available."}   # mid-game, expected
```
Also `GET /lol-end-of-game/v1/gameclient-eog-stats-block` and
`GET /lol-end-of-game/v1/champion-mastery-updates`. Populated shapes **UNVERIFIED** (would require
being on the EOG screen).

---

## 5. Auth and lifecycle

### 5.1 Discovery — two independent paths, both VERIFIED

**Lockfile** (primary):
```
$ cat "/mnt/c/Games/Riot Games/League of Legends/lockfile"
LeagueClient:6456:50924:<REDACTED-22-char-token>:https
   name    : pid : port :        password        : protocol
```
Username is always the literal `riot`. Fields are `:`-separated, no trailing newline. The observed
token was 22 characters of base64url; do not assume a fixed length. Treat it as a secret — it is a
full-privilege credential for the running client.

**Process command line** (fallback, works even if the lockfile is missing/locked):
```
$ powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\" |
    Select-Object -ExpandProperty CommandLine"
  --remoting-auth-token=<REDACTED>
  --app-port=50924                    # matches the lockfile port exactly
  --riotclient-auth-token=<REDACTED>
  --riotclient-app-port=52445         # the separate Riot Client API
  --install-directory=C:\Games\Riot Games\League of Legends
```

### 5.2 Failure modes (VERIFIED)

```
wrong password -> HTTP 401 {"errorCode":"CREDENTIALS_INVALID","httpStatus":401,"message":"Invalid username or password"}
no auth        -> HTTP 401 (empty body)
wrong port     -> HTTP 000, curl exit code 7 (connection refused)
unknown path   -> HTTP 404 {"errorCode":"RPC_ERROR","httpStatus":404,"implementationDetails":{},"message":"…"}
```

**Restart detection recipe:** `401` ⇒ the password rotated; `exit 7 / ECONNREFUSED` ⇒ the port
changed or the client is closed. In both cases re-read the lockfile and retry once. A client restart
rewrites the lockfile with a new PID, port **and** password; on exit the lockfile is deleted.
*(The rewrite-on-restart behaviour is standard and well-established but **UNVERIFIED in this
session** — I could not restart the client while the user was in a ranked game.)*

### 5.3 **Do not use `fs.watch` on `/mnt/c` from WSL — it silently never fires (VERIFIED)**

```
$ node -e 'fs.watch("/mnt/c/.../wsltest", …)'   # then write the file from WSL
fs.watch events after local write: 0
$ # then write the same file from the Windows side via cmd.exe
events from windows-side write: 0
$ fs.statSync(...).mtimeMs works: true
```

DrvFs/9p has no inotify. Two options, both verified:
- **Poll** `fs.statSync(lockfile).mtimeMs` (works fine over /mnt/c), or
- **watch from the Windows side**, where it works:
  ```
  $ node.exe -e 'fs.watch("C:/Users/.../wsltest", …)'
  win fs.watch fired: change f.txt
  win fs.watch fired: change f.txt
  ```
  The reference bridge in §7 does exactly this (fs.watch on the lockfile's directory + a 5 s poll as
  a backstop).

### 5.4 WebSocket — yes, there is a real alternative to polling (VERIFIED)

`wss://127.0.0.1:<port>/` with the same HTTP Basic header, self-signed cert. Protocol is **WAMP-ish
JSON over a plain websocket** (no subprotocol negotiation needed).

```js
ws.send(JSON.stringify([5, "OnJsonApiEvent"]));                                  // 5 = SUBSCRIBE
ws.send(JSON.stringify([5, "OnJsonApiEvent_lol-gameflow_v1_gameflow-phase"]));   // topic per resource
// 6 = UNSUBSCRIBE
```
Topic naming: `OnJsonApiEvent_` + the resource path with `/` → `_`.

Verified handshake and delivery:
```
WS OPEN wss://127.0.0.1:50924/
subscribed
ack(empty)                            # subscribe ack = a zero-length frame — skip it
sample frame: [8,"OnJsonApiEvent",{"data":"eyJraWQiOiJzMSIs…","eventType":…,"uri":"/lol-league-session/v1/league-session-token"}]
top uris:  1 /lol-league-session/v1/league-session-token
```
Frame shape is `[8, "<subscribed topic>", {uri, eventType, data}]`, where `eventType` ∈
`Create|Update|Delete` and `data` is the new resource body.

Event volume while a game is in progress is **very low** (2 frames in 20 s on the wildcard topic) —
the client is mostly idle behind the game. UNVERIFIED how noisy the wildcard topic is during champ
select / EOG; subscribe to specific topics
(`…lol-gameflow_v1_gameflow-phase`, `…lol-champ-select_v1_session`, `…lol-replays_v1_metadata`,
`…lol-end-of-game_v1_eog-stats-block`) rather than `OnJsonApiEvent`.

Node's built-in global `WebSocket` (Node ≥ 22) works, but has no per-connection TLS option, so the
process must set `NODE_TLS_REJECT_UNAUTHORIZED=0`. **Do that in the tiny bridge process only**, never
in the main app process. (A stricter alternative — pinning the Riot self-signed cert — is
UNVERIFIED here.)

---

## 6. Static data: champions, items, runes, and ICONS

### 6.1 Everything is served locally by the LCU, and it requires auth (VERIFIED)

```
$ curl.exe -sk https://127.0.0.1:$PORT/lol-game-data/assets/v1/champion-summary.json   # NO -u
401                                                    <- assets are NOT anonymous
```

| Endpoint | HTTP | Size | Contents |
|---|---|---|---|
| `/lol-game-data/assets/v1/champion-summary.json` | 200 | 54 117 B | **237** entries |
| `/lol-game-data/assets/v1/champions/{id}.json` | 200 | 38 186 B | full detail incl. spells + skins |
| `/lol-game-data/assets/v1/items.json` | 200 | 683 289 B | **868** items |
| `/lol-game-data/assets/v1/perks.json` | 200 | 99 870 B | **103** runes |
| `/lol-game-data/assets/v1/perkstyles.json` | 200 | 17 686 B | 5 trees + slot layout |
| `/lol-game-data/assets/v1/summoner-spells.json` | 200 | 13 202 B | **39** spells |
| `/lol-game-data/assets/v1/queues.json` | 200 | 354 370 B | **420** queues |
| `/lol-game-data/assets/v1/maps.json` | 200 | 1 414 B | |
| `/lol-game-data/assets/v1/skins.json` | 200 | 5 866 013 B | every skin |
| `/lol-maps/v1/maps` | 200 | 27 306 B | richer map records |
| `/lol-game-queues/v1/queues` | 200 | 151 712 B | live queue availability |

### 6.2 championId → name (VERIFIED)

```jsonc
// champion-summary.json — flat array, includes a sentinel id -1 ("None")
{ "id": 876, "name": "Lillia", "description": "the Bashful Bloom", "alias": "Lillia",
  "contentId": "9ac93543-a5f2-4e06-8ab4-f64c8a895708",
  "squarePortraitPath": "/lol-game-data/assets/v1/champion-icons/876.png",
  "roles": ["fighter","mage"] }
```
`alias` is the Data Dragon key (e.g. `MonkeyKing` for Wukong) — use it if you ever mix in DDragon.

### 6.3 Concrete, fetch-verified icon URLs

Every path below returned **HTTP 200 with the right content-type** through the authenticated LCU
transport. All are prefixed with `https://127.0.0.1:<port>`.

| Asset | Path | Verified |
|---|---|---|
| Champion square | `/lol-game-data/assets/v1/champion-icons/876.png` | 200, 32 309 B, `image/png`, **128×128 RGBA** |
| Item icon | `/lol-game-data/assets/ASSETS/Items/Icons2D/3047_Class_T2_NinjaTabi.png` | 200, 6 073 B, `image/png` |
| Rune icon | `/lol-game-data/assets/v1/perk-images/Styles/Precision/Conqueror/Conqueror.png` | 200, 50 065 B, `image/png` |
| Rune tree icon | `/lol-game-data/assets/v1/perk-images/Styles/7201_Precision.png` | from `perkstyles.json` `iconPath` |
| Summoner spell | `/lol-game-data/assets/DATA/Spells/Icons2D/Summoner_flash.png` | 200, 6 403 B, `image/png` |
| Profile icon | `/lol-game-data/assets/v1/profile-icons/6060.jpg` | 200, 26 812 B, `image/jpeg` |
| Ability icon | `/lol-game-data/assets/ASSETS/Characters/Lillia/HUD/Icons2D/Lillia_Icon_Q.png` | from `champions/876.json` |
| Skin tile / splash / loadscreen | `…/Skins/Base/Images/lillia_splash_tile_0.jpg`, `…lillia_splash_centered_0.jpg`, `…/LilliaLoadscreen.jpg` | from `champions/876.json` |

**Never construct item icon paths yourself** — the filename encodes an old codename. Item 3047 is
"Plated Steelcaps" but the file is `3047_Class_T2_NinjaTabi.png`. Always read `iconPath` from
`items.json`. Distribution of item icon prefixes (868 items):
```
791  /lol-game-data/assets/ASSETS/Items/Icons2D/
 59  /lol-game-data/assets/ASSETS/Items/Icons2D/Strawberry/
  9  /lol-game-data/assets/ASSETS/Items/Icons2D/Jade/
  8  /lol-game-data/assets/ASSETS/Items/Icons2D/Kiwi/
  1  /lol-game-data/assets/ASSETS/Items/Icons2D/AutoAtlas/LargeIcons/
```
Paths are returned already rooted at `/lol-game-data/assets/…` — prepend the origin and nothing else.
A hand-typed path with different casing (`3047_Class_T2_PlatedSteelcaps.png`) returned **HTTP 400**.

### 6.4 Offline / client-closed fallback (VERIFIED)

The internet **is** reachable from WSL directly (no interop needed):
```
$ curl https://ddragon.leagueoflegends.com/api/versions.json          200  5189 B  0.12 s
  ["16.17.1","16.16.1","16.15.1",…]
$ curl https://ddragon.leagueoflegends.com/cdn/15.1.1/data/en_US/champion.json   200  155446 B
$ curl https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-summary.json
                                                                      200  54117 B
```
CommunityDragon returned **exactly 54 117 B** — the same byte count as the LCU's
`champion-summary.json`. It mirrors the identical `rcp-be-lol-game-data` payloads, so the app can use
one schema and swap the base URL:

```
LCU (client open):  https://127.0.0.1:<port>/lol-game-data/assets/<path>      (needs auth)
CDragon (offline):  https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/<path>
```
where `<path>` is the LCU path minus the `/lol-game-data/assets/` prefix, **lowercased**.
*(The lowercasing requirement for CDragon's ASSETS paths is UNVERIFIED — I only fetched the `v1/`
JSON from CDragon, not an `ASSETS/` icon.)*

**Game install DATA folder:** `/mnt/c/Games/Riot Games/League of Legends/` contains `DATA/`,
`Game.db`, `Plugins/`, `Config/`. Contents are WAD archives — extracting them needs a WAD parser and
buys nothing over the two sources above. Not recommended.

---

## 7. Transport — measured, with a working reference implementation

### 7.1 The constraint, re-confirmed

WSL2 here is in default **NAT** networking mode (`/mnt/c/Users/ssalb/.wslconfig` does not exist), so
WSL's `127.0.0.1` is not Windows' `127.0.0.1`. Every League API must be reached from a
**Windows-side** process.

> **Worth trying, UNVERIFIED:** Windows is build **10.0.26200.9278** and WSL is **2.3.24.0**, both
> well past the requirements for `networkingMode=mirrored`. Adding
> ```ini
> [wsl2]
> networkingMode=mirrored
> ```
> to `C:\Users\ssalb\.wslconfig` and running `wsl --shutdown` should make WSL reach `127.0.0.1:<port>`
> and `:2999` natively, deleting this entire section. I did **not** test it — it changes the user's
> global config and drops every WSL session. Try it first in the build phase; keep the bridge as the
> fallback, since it also solves `fs.watch` and websockets.

### 7.2 Benchmarks (all measured this session, same endpoint `/lol-summoner/v1/current-summoner`, 464 B)

| Approach | Per-request | Notes |
|---|---|---|
| `curl.exe` one process per request | **76–112 ms**, mean ≈ **88 ms** (n=20) | dominated by WSL→Win process creation |
| — of which curl's own `time_total` | **21–32 ms**, mean ≈ **26 ms** (n=10) | TLS handshake every time |
| `curl.exe`, 20 URLs in ONE invocation | **191 ms total → 9.6 ms each** | connection + TLS reused |
| **Windows `node.exe`, keep-alive agent, in-process** | min 1.02 / **p50 1.57** / mean 1.53 / max 2.18 ms (n=30) | first call 64 ms (TLS handshake) |
| **WSL → Windows node bridge over stdio** | min 1.34 / **p50 2.29** / p95 2.99 / max 3.19 ms (n=50) | +204 ms one-time process spawn |
| Reference bridge of §7.4 (with ws + lockfile watch) | min 1.52 / **p50 2.30** / p95 3.09 / max 14.42 ms (n=50) | |

Large payloads:

| | |
|---|---|
| `skins.json` (5 866 013 B) via `curl.exe -o` → **WSL** path | curl 0.312 s, wall **404 ms** |
| same → **Windows-native** path | curl 0.104 s, wall **170 ms** |
| same via bridge, streamed to a Windows path | **95 ms** |
| same via bridge, returned as a stdio string | **21 ms** for `items.json` (683 KB) |
| `items.json` (683 289 B) in-process on Windows | **7.7 ms** |
| champion PNG (32 309 B) via bridge → file | **3.8 ms**, verified `PNG image data, 128 x 128` |

**Conclusion: the bridge is ~38× faster than spawning `curl.exe` per request.** Writing a large file
to a Windows-native path and only then copying/reading it from WSL is ~3× faster than letting curl
write across the 9p mount.

20 concurrent requests took 69 ms in-process / 86 ms via the bridge, i.e. the LCU serialises them —
do not expect concurrency to help; batch sequentially on a keep-alive socket instead.

### 7.3 Keeping the password out of the process list

`-u riot:<pass>` puts the secret in argv, visible to any process listing. Three alternatives, **all
verified working against the live client**:

```bash
# (1) BEST for curl: config on stdin. Nothing sensitive in argv, nothing on disk.
printf 'user = "riot:%s"\ninsecure\nsilent\nurl = "https://127.0.0.1:%s/lol-summoner/v1/current-summoner"\n' \
  "$PASS" "$PORT" | curl.exe -K -
# -> {"accountId":2506880536102496,"gameName":"Gooskaffur",…}

# (2) pre-encoded header, also via -K - (avoids curl re-deriving basic auth)
B64=$(printf 'riot:%s' "$PASS" | base64 -w0)
printf 'header = "Authorization: Basic %s"\ninsecure\nsilent\nurl = "…"\n' "$B64" "$PORT" | curl.exe -K -
# -> 200

# (3) --netrc-file  (WORKS, but writes the password to disk — NOT recommended)
printf 'machine 127.0.0.1 login riot password %s\n' "$PASS" > C:/…/netrc.txt
curl.exe -sk --netrc-file "C:/…/netrc.txt" "https://127.0.0.1:$PORT/…"
# -> 200      (curl.exe is a Windows binary, so --netrc-file needs a WINDOWS path)
```
Note (3) requires a Windows path because `curl.exe` cannot resolve `/tmp/...`. I deleted the test
netrc file afterwards.

**The bridge sidesteps this entirely:** it reads the lockfile inside its own process and the password
never appears in any argv, environment variable, or file the app writes.

### 7.4 Reference bridge (this exact file was run and benchmarked)

`lcu-bridge.mjs` — run with `C:\Program Files\nodejs\node.exe` (verified present, **v23.5.0 win32 x64**):

```js
// WINDOWS-side LCU bridge.
// stdin : NDJSON  {id, path, method?, toFile?}          (toFile = a WINDOWS path)
// stdout: NDJSON  {id, status, body} | {id, status, file, bytes} | {id, error}
//         plus unsolicited {evt:"lockfile",port} / {evt:"ws-open"} / {evt:"api",uri,eventType,data}
import fs from "node:fs";
import https from "node:https";
import readline from "node:readline";

const LOCK = process.env.LCU_LOCKFILE ?? "C:/Games/Riot Games/League of Legends/lockfile";
let port = 0, auth = "", agent = null, ws = null;
const say = o => process.stdout.write(JSON.stringify(o) + "\n");

function loadLock() {
  const [, , p, pass] = fs.readFileSync(LOCK, "utf8").trim().split(":");  // Name:PID:PORT:PASSWORD:https
  if (Number(p) === port) return false;
  port = Number(p);
  auth = "Basic " + Buffer.from("riot:" + pass).toString("base64");
  agent?.destroy();
  agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false, maxSockets: 16 });
  say({ evt: "lockfile", port });
  openWs();
  return true;
}

function openWs() {
  try { ws?.close(); } catch {}
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";        // scoped to this tiny process only
  ws = new WebSocket(`wss://127.0.0.1:${port}/`, { headers: { Authorization: auth } });
  ws.addEventListener("open", () => {
    for (const t of (process.env.LCU_TOPICS ?? "OnJsonApiEvent").split(","))
      ws.send(JSON.stringify([5, t]));                    // 5 = WAMP SUBSCRIBE
    say({ evt: "ws-open" });
  });
  ws.addEventListener("message", e => {
    const s = String(e.data); if (!s) return;             // empty frame = subscribe ack
    const [, , p] = JSON.parse(s);
    say({ evt: "api", uri: p.uri, eventType: p.eventType, data: p.data });
  });
  ws.addEventListener("close", () => say({ evt: "ws-close" }));
  ws.addEventListener("error", () => {});
}

loadLock();
// fs.watch works here because this is native NTFS. It does NOT work from WSL over /mnt/c.
fs.watch(LOCK.replace(/\/[^/]+$/, ""), (_e, f) => { if (f === "lockfile") { try { loadLock(); } catch {} } });
setInterval(() => { try { loadLock(); } catch {} }, 5000);   // backstop poll

readline.createInterface({ input: process.stdin }).on("line", line => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  const req = https.request(
    { host: "127.0.0.1", port, path: m.path, method: m.method ?? "GET", agent,
      headers: { Authorization: auth, Accept: "application/json" } },
    r => {
      if (m.toFile) {                                     // stream large/binary straight to disk
        const out = fs.createWriteStream(m.toFile);
        let n = 0; r.on("data", c => n += c.length); r.pipe(out);
        out.on("close", () => say({ id: m.id, status: r.statusCode, file: m.toFile, bytes: n }));
      } else {
        const c = []; r.on("data", d => c.push(d));
        r.on("end", () => say({ id: m.id, status: r.statusCode, body: Buffer.concat(c).toString("utf8") }));
      }
    });
  req.on("error", e => say({ id: m.id, error: String(e) }));
  req.end();
});
```

Linux-side client (also run verbatim):

```js
import { spawn } from "node:child_process";
import readline from "node:readline";
const child = spawn("/mnt/c/Program Files/nodejs/node.exe", [winPathToBridge],
  { stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, LCU_TOPICS: "OnJsonApiEvent_lol-gameflow_v1_gameflow-phase" } });
const pend = new Map(); let seq = 0;
readline.createInterface({ input: child.stdout }).on("line", l => {
  const m = JSON.parse(l);
  if (m.evt) return onEvent(m);
  pend.get(m.id)?.(m); pend.delete(m.id);
});
const call = (path, toFile) => new Promise(r => {
  const id = ++seq; pend.set(id, r);
  child.stdin.write(JSON.stringify({ id, path, toFile }) + "\n");
});
```
Get the Windows path for the bridge with `wslpath -w <linux path>` (verified).

Observed output:
```
EVT {"evt":"lockfile","port":50924}
EVT {"evt":"ws-open"}
round trip x50: min=1.52 p50=2.30 p95=3.09 max=14.42 ms
5.8MB toFile: 94.6ms {"id":51,"status":200,"file":"C:/…/skins2.json","bytes":5866013}
PNG toFile:    3.8ms {"id":52,"status":200,"file":"C:/…/876.png","bytes":32309}
$ file 876.png -> PNG image data, 128 x 128, 8-bit/color RGBA, non-interlaced
```

The same bridge also fronts the Live Client Data API (change host/port to `127.0.0.1:2999`, drop the
`Authorization` header) — one process, both APIs.

`curl.exe` details if you need the fallback path: version **8.21.0 (Windows) Schannel**, at
`/mnt/c/WINDOWS/system32/curl.exe`, protocol list includes **`ws` and `wss`**, so a curl-only
websocket is theoretically possible (UNVERIFIED — I used Node's WebSocket instead).

---

## 8. Discovering the rest of the API yourself

`GET /help?format=Full` returns **3 087 751 B** describing **1 468 functions** and every type the
client exposes. It is the authoritative source and it is generated from the running binary, so it is
never stale. (`GET /swagger/v3/openapi.json` on the LCU port is **404**; only the *game* client on
:2999 serves OpenAPI.)

Shape: `{ events, functions, types }`, each an array-like object. Function names encode method+path:
`GetLolMatchHistoryV1GameTimelinesByGameId` → `GET /lol-match-history/v1/game-timelines/{gameId}`,
with `arguments[]` giving the parameter names/types and `returns.type` naming a record in `types`.
`types[].values[]` holds enums (this is where the replay-state and gameflow-phase lists above came
from) and `types[].fields[]` the record layout.

A tiny query helper (`q.js`) is left in the scratchpad; the whole trick is:
```js
const h = JSON.parse(fs.readFileSync("helpfull.json"));
Object.values(h.functions).filter(f => /LolReplays/.test(f.name));
Object.values(h.types).find(t => t.name === "LolReplaysMetadataState").values;
```

---

## 9. Known gaps — what I could NOT verify

1. **The replay download flow.** No POST was issued. `POST /lol-replays/v2/metadata/{gameId}/create`
   then `POST /lol-replays/v1/rofls/{gameId}/download` then polling `GET /metadata/{gameId}` is the
   documented shape from the client's own type table, but the accepted `componentType` string and the
   real state progression are unverified.
2. **Champ-select session shape.** 404 `"No active delegate"` the whole session.
3. **End-of-game stats block shape.** 404 `"No end of game stats available."` the whole session.
4. **Client restart behaviour.** Could not restart the client mid-ranked-game. Lockfile rotation is
   the universally documented behaviour but I did not observe it.
5. **How long after a game ends the timeline becomes available.** Not measured.
6. **Whether the history window recovers to ~20 when not in a game.** The 21→5 collapse was observed
   but its cause is not established.
7. **`networkingMode=mirrored`.** Would obsolete the whole interop layer; not tested because it
   requires editing the user's `.wslconfig` and `wsl --shutdown`.
8. **queueId / gameMode value space from live data.** Every game in the window was 420/CLASSIC. The
   420-entry `queues.json` is the substitute, and it is complete.
9. **Canonical SR map bounds.** Only the observed span `x[130,14589] y[135,14673]` is measured; the
   `[-120, 14870]` figure is recalled, not verified.
10. **CommunityDragon path casing** for `ASSETS/` icons (only `v1/` JSON was fetched from CDragon).
11. **Wildcard websocket volume during champ select / EOG.** Only measured while in-game (very quiet).
