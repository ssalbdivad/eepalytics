# ROFL2 ("Replay V2") file format — decoder spec

**Status:** reverse-engineered and verified end-to-end against one real file.
**Sample:** `/mnt/c/Users/ssalb/Documents/League of Legends/Replays/NA1-5631300987.rofl`
(14,979,193 bytes, patch `16.17.810.4348`, NA1, game 5631300987, 30:49 SR game).
**Date:** 2026-09-02. **Client at time of analysis:** `16.17.810.4348`.

Working decoder: **`/home/ssalb/coachskaffur/.research/rofl2.mjs`** (Node 25, zero deps —
uses built-in `node:zlib` zstd). Verified output is reproduced in §8.

> **Sample size caveat.** Only ONE `.rofl` existed on this machine. Every offset and field
> below was validated against that file (95/95 segments parse with byte-exact fit, no
> slack), but anything I could only observe once is labelled. A second file from a
> different patch/queue would firm up §1.3, §3.4 and §5.

---

## 0. TL;DR — what you can and cannot get offline

| Want | Offline from `.rofl`? | How |
|---|---|---|
| Patch / game version | **Yes** | Header string at offset 0x0F |
| Game length | **Yes** | Trailing JSON `gameLength` (ms) |
| `gameId` | **No — not in the file** | Parse the *filename* `<platformId>-<gameId>.rofl` |
| Full end-of-game scoreboard, 371 stats × 10 players | **Yes** | Trailing JSON `statsJson` |
| PUUIDs / Riot IDs / summonerIds of all 10 players | **Yes** | Inside `statsJson` |
| Runes, items, summoner spells, pings, mission counters | **Yes** | Inside `statsJson` |
| Per-minute gold/xp/positions, kill events with coordinates | **No** | Use the LCU `/lol-match-history/v1/game-timelines/{gameId}` instead |
| Item-purchase / ward-placed / skill-up *events* | **No** (only game-total counts) | Not available from LCU timeline either |
| Anything from the chunk/keyframe payloads | **Effectively no** — see §4 | Requires the game engine |

**Bottom line for the build phase:** treat a `.rofl` as *(patch + game length + a very rich
end-of-game stat block)* plus *an opaque blob that only `League of Legends.exe` can replay*.
Everything positional/temporal must come from the LCU timeline endpoint, not the file.

---

## 1. File layout

```
+--------------------------------------------------+ 0x00
| FILE HEADER  (15 + gameVersionLen bytes)         |
+--------------------------------------------------+ 0x0F + gameVersionLen   (= 0x1D here)
| SEGMENT 1  = 17-byte descriptor + payload        |
| SEGMENT 2  = 17-byte descriptor + payload        |
| ...                                              |
| SEGMENT N  = 17-byte descriptor + payload        |
+--------------------------------------------------+ (= 14,856,001 here)
| SIGNATURE  (256 bytes observed)                  |
+--------------------------------------------------+ fileSize - 4 - metaLen  (= 14,856,257)
| JSON GAME METADATA (UTF-8, uncompressed)         |
+--------------------------------------------------+ fileSize - 4
| u32 LE  metaLen                                  |
+--------------------------------------------------+ fileSize
```

All integers are **little-endian**. There is no padding anywhere: the segment stream ends
exactly 256 bytes before the JSON blob, and the JSON blob ends exactly 4 bytes before EOF.

### 1.1 File header

First 48 bytes of the sample:

```
$ xxd -l 48 NA1-5631300987.rofl
00000000: 5249 4f54 0200 3714 cb24 5662 63e2 0e31  RIOT..7..$Vbc..1
00000010: 362e 3137 2e38 3130 2e34 3334 3801 0000  6.17.810.4348...
00000020: 0002 0000 0003 ca3c 0000 7e14 0000 28b5  .......<..~...(.
```

| Offset | Size | Type | Field | Value in sample |
|---|---|---|---|---|
| 0x00 | 4 | ASCII | magic `RIOT` | `RIOT` |
| 0x04 | 2 | u16 LE | **format version** (2 ⇒ ROFL2) | `2` |
| 0x06 | 8 | u64 LE | **network protocol digest** | bytes `37 14 cb 24 56 62 63 e2` |
| 0x0E | 1 | u8 | gameVersion string length | `14` |
| 0x0F | *len* | ASCII (not NUL-terminated) | **gameVersion** | `16.17.810.4348` |
| 0x0F+len | — | — | first segment descriptor | starts at 0x1D |

Note ROFL1 used magic `RIOT\x00\x00`; the `\x02\x00` at 0x04 is the discriminator. Do not
assume the header is a fixed size — it is `15 + gameVersionLen`.

**The 8-byte digest is the real compatibility gate.** `League of Legends.exe` contains both
the read step and the failure log for it:

```
$ strings -a "Game/League of Legends.exe" | grep -i "network protocol"
Replay V2 could not read network protocol digest
{:5s}| {#channel!} Client/Replay network protocol digest mismatch. Client: {%s}:0x{:%016llx}. Replay: {%s}:0x{:%016llx}
```

The `%016llx` confirms it is printed as a 64-bit value. Whether the engine reads it LE or BE
is UNVERIFIED (one sample); both renderings are emitted by the decoder:
`3714cb24566263e2` (raw bytes) / `0xe263625624cb1437` (u64 LE).

### 1.2 The engine's own read order (external corroboration)

Every field above maps 1:1 onto an error string in the game binary, in file order:

```
$ strings -a "Game/League of Legends.exe" | grep -a "Replay V2"
Replay V2 could not read game version size        <- u8 at 0x0E
Replay V2 could not read game version             <- ASCII at 0x0F
Replay V2 could not read network protocol digest  <- u64 at 0x06
Replay V2 could not read chunk header             <- 17-byte segment descriptor (§2)
Replay V2 could not read data chunk               <- segment type 1
Replay V2 could not read keyframe chunk           <- segment type 2
Replay V2 could not skip JSON game metadata       <- trailing JSON, *skipped* via the u32
Replay V2 could not read signature                <- 256-byte block
Replay V2 signature failure: %s
```

Riot's internal name for the format is literally **"Replay V2"**.

### 1.3 Trailing signature (256 bytes)

`fileSize - 4 - metaLen - lastSegmentEnd = 256` in the sample. 256 bytes = 2048 bits,
and the game binary carries:

```
Replay public key couldn't be loaded: %s
Replay signature does not match: %s
Replay V2 could not read signature
-----BEGIN PUBLIC KEY-----
```

⇒ **almost certainly an RSA-2048 signature** over the preceding bytes. UNVERIFIED: the exact
signed range, the padding scheme, and whether 256 is fixed. A parser should compute the
signature length as `metaOffset - endOfLastSegment` rather than hardcoding 256. You do not
need to validate it to read the file.

### 1.4 Trailing JSON metadata

Last bytes of the file:

```
... \"WeeklyMission_S2_SpiritPetals\":\"0\"}]"}  34 e0 01 00
                                                 ^^^^^^^^^^^ u32 LE = 122932
```

`metaLen = readUInt32LE(fileSize-4) = 122932`, so the JSON starts at
`14979193 - 4 - 122932 = 14856257`, where the very first byte is `{`. Confirmed:

```
bytes at start-8..start+80:
b'\x17\xb4\xb1\x02_:\x89\x1c{"gameLength":1849550,"lastGameChunkId":64,"lastKeyFrameId":31,"statsJson":"[{\\"'
```

The 8 bytes before `{` are the tail of the signature. `LeagueClient.exe` calls this field the
"metadata offset": `FileManager: could not read metadata offset from rofl '%s'`.

---

## 2. Segment table

Immediately after the header, the file is a flat sequence of

```
[17-byte descriptor][payload][17-byte descriptor][payload] ...
```

### 2.1 Descriptor (17 bytes, no alignment)

| Offset | Size | Type | Field |
|---|---|---|---|
| +0 | 4 | u32 LE | `id` — chunk id, keyframe id, or 1 for the manifest |
| +4 | 4 | u32 LE | `nextId` — for chunks: `id+1`; for keyframes: the chunk id this keyframe precedes |
| +8 | 1 | u8 | `type` (see below) |
| +9 | 4 | u32 LE | `decompressedLength` |
| +13 | 4 | u32 LE | `compressedLength` — **0 means the payload is stored raw** |

| `type` | Meaning | Count in sample |
|---|---|---|
| 1 | data **chunk**, zstd-compressed | 62 (ids 3…64) |
| 2 | **keyframe**, zstd-compressed | 31 (ids 1…31) |
| 3 | **manifest / startup blob**, zstd-compressed, always `id=1`, first segment | 1 |
| 4 | data **chunk**, stored raw (`compressedLength == 0`) | 1 (id 2, 17 bytes) |

**Validation performed:** for all 94 zstd segments, the descriptor's
`compressedLength` equalled the byte length of the zstd frame that followed *and*
`decompressedLength` equalled the actual decompressed size. Zero mismatches:

```
all comp match: true   all dec match: true
mismatches: []
```

The very first descriptor lives at 0x1D and is decoded from the header hexdump above:
`01 00 00 00 | 02 00 00 00 | 03 | ca 3c 00 00 | 7e 14 00 00`
⇒ `id=1, nextId=2, type=3(manifest), dec=15562, comp=5246`. The zstd magic `28 b5 2f fd`
sits at 0x2E = 0x1D+17, and the frame is exactly 5246 bytes long.

`type=4` was seen exactly once (chunk 2, the near-empty startup chunk). The reading
"`compressedLength==0` ⇒ raw, length = `decompressedLength`" is an inference from a single
sample, but it is self-consistent: consuming exactly 17 raw bytes lands the parser byte-exact
on the next valid descriptor, and its payload is byte-identical to `keyframe#1`'s first 15
bytes except for one byte.

### 2.2 Payload compression

Every compressed payload is a **standard single zstd frame** (RFC 8878), magic `28 B5 2F FD`.
Node 25's built-in `zlib.zstdDecompressSync` decodes them directly — verified:

```
$ node -e "const z=require('node:zlib'); console.log('zstdDecompressSync' in z)"
true
```

⚠️ You cannot `zstd -d` the whole payload region — the CLI errors
`zstd: unsupported format` because the descriptors between frames are not zstd data. Walk
frame-by-frame using the descriptor's `compressedLength` (or the RFC 8878 frame walker in
`rofl2.mjs::zstdFrameEnd`, which is what I used to *derive* the lengths independently).

### 2.3 Segment ordering and cadence

The first twelve segments of the sample, with the float32 game time read from payload byte 1
(see §4.1):

```
manifest#1(next=2,  t=0.00,   dec=15562)
chunk#2   (next=3,  t=0.00,   dec=17)        <- type 4, stored raw
keyframe#1(next=3,  t=0.00,   dec=139916)
chunk#3   (next=4,  t=0.00,   dec=135188)
chunk#4   (next=5,  t=30.07,  dec=146297)
keyframe#2(next=5,  t=60.03,  dec=183063)
chunk#5   (next=6,  t=60.10,  dec=493204)
chunk#6   (next=7,  t=90.06,  dec=544873)
keyframe#3(next=7,  t=120.06, dec=190839)
chunk#7   (next=8,  t=120.09, dec=605605)
chunk#8   (next=9,  t=150.12, dec=507345)
keyframe#4(next=9,  t=180.13, dec=191879)
...
last 3: keyframe#31(t=1800.63), chunk#63(t=1800.67), chunk#64(t=1830.67)
```

* **Chunks are 30 s apart**, ids 2…64, `nextId = id+1`.
* **Keyframes are 60 s apart**, ids 1…31, `nextId = 2*id + 1` (kf1→chunk3, kf2→chunk5, …),
  i.e. a keyframe is emitted immediately before every other chunk.
* Chunk 1 is absent from the file entirely; chunk 2 is present but empty (17 bytes).
* Terminates exactly at `lastGameChunkId` / `lastKeyFrameId` from the JSON metadata — which
  gives a clean stopping rule for a sequential parser (that is what `rofl2.mjs` uses).

Derived timings (useful without decoding payloads at all):
`chunkStartSec ≈ 30 * (id - 3)`, `keyframeStartSec ≈ 60 * (id - 1)`.
Measured chunk 5 = 60.10 s, chunk 64 = 1830.67 s ⇒ (1830.67−60.10)/59 = **30.01 s/chunk**.

---

## 3. JSON game metadata (the useful part)

### 3.1 Shape

Exactly four top-level keys:

```json
{
  "gameLength": 1849550,
  "lastGameChunkId": 64,
  "lastKeyFrameId": 31,
  "statsJson": "[{\"...\":\"...\"}, ...]"
}
```

* `gameLength` — **milliseconds** (1,849,550 ms = 30 m 49.55 s). Cross-checks against
  `TIME_PLAYED = "1849"` (seconds) in every player row.
* `statsJson` — a **JSON *string*** that must be parsed a second time. It yields an array of
  **10 objects** (one per participant, blue team first), each with **371 keys**, and
  **every value is a string** — numbers included. Verified:
  `Counter({'str': 371})`.

The client's own model of this blob (from the LCU `/help` schema) is:

```
LolReplaysRoflFileMetadata { gameLength:uint32, gameVersion:string,
                             lastGameChunkId:uint32, lastKeyFrameId:uint32 }
```

Note `gameVersion` appears in the client's model but **not** in the JSON — it comes from the
binary header (§1.1). That is independent confirmation of the header layout.

### 3.2 What the 371 fields cover

Categories (full list dumped by `rofl2.mjs`; the sample's exact key set is stable per patch):

* **Identity:** `ID`, `PUUID`, `SUMMONER_ID`, `NAME` (empty in this patch),
  `RIOT_ID_GAME_NAME`, `RIOT_ID_TAG_LINE`, `SKIN` (champion internal name, e.g. `LeeSin`),
  `TEAM` (100/200), `WIN` (`Win`/`Fail`).
* **Position:** `TEAM_POSITION`, `INDIVIDUAL_POSITION`, `PLAYER_POSITION`, `PLAYER_ROLE`.
* **Core scoreboard:** `CHAMPIONS_KILLED`, `NUM_DEATHS`, `ASSISTS`, `GOLD_EARNED`,
  `GOLD_SPENT`, `MINIONS_KILLED`, `NEUTRAL_MINIONS_KILLED`(+`_ENEMY_JUNGLE`/`_YOUR_JUNGLE`),
  `LEVEL`, `EXP`, `TIME_PLAYED`, `VISION_SCORE`, `PING`.
* **Damage breakdown:** `TOTAL_DAMAGE_DEALT_TO_CHAMPIONS`, `PHYSICAL_/MAGIC_/TRUE_DAMAGE_*`
  (dealt/taken/to-champions variants), `TOTAL_DAMAGE_DEALT_TO_TURRETS`,
  `..._TO_OBJECTIVES`, `..._TO_EPIC_MONSTERS`, `..._TO_BUILDINGS`,
  `TOTAL_DAMAGE_SELF_MITIGATED`, `TOTAL_DAMAGE_SHIELDED_ON_TEAMMATES`,
  `TOTAL_HEAL`, `TOTAL_HEAL_ON_TEAMMATES`, `LARGEST_CRITICAL_STRIKE`.
* **Objectives:** `TURRETS_KILLED`/`TURRET_TAKEDOWNS`, `BARRACKS_*`, `HQ_*`, `DRAGON_KILLS`,
  `ELDER_DRAGON_KILLS`, `BARON_KILLS`, `RIFT_HERALD_KILLS`, `HORDE_KILLS` (voidgrubs),
  `ATAKHAN_KILLS`, `OBJECTIVES_STOLEN`(+`_ASSISTS`).
* **Vision:** `WARD_PLACED`, `WARD_PLACED_DETECTOR`, `WARD_KILLED`,
  `VISION_WARDS_BOUGHT_IN_GAME`, `SIGHT_WARDS_BOUGHT_IN_GAME`.
* **Build:** `ITEM0`…`ITEM6`, `ITEMS_PURCHASED`, `CONSUMABLES_PURCHASED`,
  `SUMMONER_SPELL_1/2`, `SUMMON_SPELL1_CAST`/`2_CAST`, `SPELL1_CAST`…`SPELL4_CAST`.
* **Runes:** `KEYSTONE_ID`, `PERK0`…`PERK5` with `PERKn_VAR1..3`, `PERK_PRIMARY_STYLE`,
  `PERK_SUB_STYLE`, `STAT_PERK_0..2`. Arena: `PLAYER_AUGMENT_1..6`, `PLAYER_SUBTEAM*`.
* **Tempo / survivability:** `TOTAL_TIME_SPENT_DEAD`, `LONGEST_TIME_SPENT_LIVING`,
  `LAST_TAKEDOWN_TIME`, `KILLING_SPREES`, `LARGEST_KILLING_SPREE`, `LARGEST_MULTI_KILL`,
  `DOUBLE_/TRIPLE_/QUADRA_/PENTA_/UNREAL_KILLS`, `TIME_CCING_OTHERS`,
  `TOTAL_TIME_CROWD_CONTROL_DEALT(_TO_CHAMPIONS)`.
* **Pings (13 kinds):** `ALL_IN_PINGS`, `ASSIST_ME_PINGS`, `BASIC_PINGS`, `COMMAND_PINGS`,
  `DANGER_PINGS`, `ENEMY_MISSING_PINGS`, `ENEMY_VISION_PINGS`, `GET_BACK_PINGS`,
  `HOLD_PINGS`, `NEED_VISION_PINGS`, `ON_MY_WAY_PINGS`, `PUSH_PINGS`, `RETREAT_PINGS`,
  `VISION_CLEARED_PINGS`.
* **Behaviour flags:** `WAS_AFK`, `WAS_LEAVER`, `MUTED_ALL`, `PLAYERS_I_MUTED`,
  `PLAYERS_THAT_MUTED_ME`, `TIME_SPENT_DISCONNECTED`, `GAME_ENDED_IN_SURRENDER`, etc.
* **~200 low-value counters:** `Missions_*`, `2026_S*_*`, `Event_*`, `HoL_*`,
  `WeeklyMission_*`, `DemonsHand_*`, `PLAYER_SCORE_0..11`. Mostly battle-pass telemetry.
  A handful are coaching-relevant: `Missions_CreepScoreBy10Minutes`,
  `Missions_TurretPlatesDestroyed`, `Missions_TakedownsBefore15Min`,
  `Missions_GoldPerMinute`, `Missions_TakedownsUnderTurret`, `Missions_PlaceUsefulWards`
  — but several of these are *milestone flags* (0/1), not raw counts: this player's
  `Missions_CreepScoreBy10Minutes` = `"1"` while `MINIONS_KILLED` = `"117"`. **Do not read
  `Missions_*` as raw stats without checking.**

### 3.3 Real extracted row (the user, verified against known env facts)

```json
{
 "ID": "2506880536102496",
 "PUUID": "188dee22-18d6-5752-ba7f-b69cf3d2506e",
 "SUMMONER_ID": "122474706",
 "SKIN": "Lillia", "TEAM": "200", "WIN": "Win",
 "TEAM_POSITION": "JUNGLE", "INDIVIDUAL_POSITION": "JUNGLE",
 "LEVEL": "18", "EXP": "24098", "TIME_PLAYED": "1849",
 "CHAMPIONS_KILLED": "21", "NUM_DEATHS": "0", "ASSISTS": "4",
 "LARGEST_KILLING_SPREE": "21", "LARGEST_MULTI_KILL": "3",
 "DOUBLE_KILLS": "4", "TRIPLE_KILLS": "3",
 "GOLD_EARNED": "21164", "GOLD_SPENT": "16075",
 "MINIONS_KILLED": "117", "NEUTRAL_MINIONS_KILLED": "203",
 "NEUTRAL_MINIONS_KILLED_ENEMY_JUNGLE": "24",
 "VISION_SCORE": "32", "WARD_PLACED": "9", "WARD_KILLED": "2",
 "VISION_WARDS_BOUGHT_IN_GAME": "1", "ITEMS_PURCHASED": "18",
 "TOTAL_DAMAGE_DEALT_TO_CHAMPIONS": "57023", "TOTAL_DAMAGE_TAKEN": "34683",
 "TOTAL_DAMAGE_DEALT_TO_TURRETS": "5308", "TOTAL_DAMAGE_DEALT_TO_OBJECTIVES": "37462",
 "TOTAL_TIME_SPENT_DEAD": "0", "TIME_CCING_OTHERS": "36",
 "LONGEST_TIME_SPENT_LIVING": "0", "LAST_TAKEDOWN_TIME": "1845",
 "TURRET_TAKEDOWNS": "3", "DRAGON_KILLS": "2", "BARON_KILLS": "1",
 "ATAKHAN_KILLS": "0", "HORDE_KILLS": "2", "RIFT_HERALD_KILLS": "0",
 "OBJECTIVES_STOLEN": "1",
 "KEYSTONE_ID": "8010", "PERK0": "8010",
 "PERK_PRIMARY_STYLE": "8000", "PERK_SUB_STYLE": "8200", "STAT_PERK_0": "5007",
 "SUMMONER_SPELL_1": "4", "SUMMONER_SPELL_2": "11",
 "SPELL1_CAST": "254", "SPELL2_CAST": "97",
 "ITEM0": "3157", "ITEM6": "3340",
 "Missions_CreepScoreBy10Minutes": "1", "Missions_GoldPerMinute": "1",
 "Missions_TurretPlatesDestroyed": "10", "Missions_TakedownsBefore15Min": "4",
 "PLAYERS_I_MUTED": "0", "PING": "27",
 "ALL_IN_PINGS": "0", "ENEMY_MISSING_PINGS": "0"
}
```

`PUUID` matches the known account PUUID `188dee22-18d6-5752-ba7f-b69cf3d2506e` **exactly**,
and `SUMMONER_ID` matches `122474706`. So the file alone is enough to identify which row is
"me" — no LCU call needed.

### 3.4 Gotchas

* `NAME` is an **empty string** on this patch; use `RIOT_ID_GAME_NAME` + `RIOT_ID_TAG_LINE`.
* `ID` ≠ `SUMMONER_ID` for migrated accounts (row 0: `ID=3210559431853568`,
  `SUMMONER_ID=3210559431853568`; row 1: `ID=34033485`, `SUMMONER_ID=20873895`).
  Match players by `PUUID`.
* `WIN` is the string `"Win"` / `"Fail"`, not a boolean.
* `LONGEST_TIME_SPENT_LIVING` was `"0"` for a player who never died — do not assume it is
  meaningful.
* There is **no `championId`** — only `SKIN`, the champion's internal name string. Map it via
  Data Dragon / `rcp-be-lol-game-data` if you need the numeric id.
* The key set is patch-dependent (all the `2026_S*` / `WeeklyMission_*` keys rotate).
  Parse defensively; never index a fixed key list.

---

## 4. The chunk / keyframe payloads — honest assessment

**Verdict: OUT OF SCOPE. Do not budget build time for this.**

Total decompressed payload across the 94 compressed segments: **38,905,708 bytes** from
14.86 MB of file. It decompresses cleanly. It is then *unencrypted but undocumented,
bit-packed netcode.*

### 4.1 What IS decodable

Payload byte 0 is a record tag (only values `1` and `2` observed), and **bytes 1–4 are a
float32 LE game time in seconds**. This is solid — it produced a perfectly monotonic,
regular series across all 95 segments:

```
chunks  (id:seconds): 3:0  4:30.07  5:60.10  6:90.06 ... 63:1800.67  64:1830.67
keyframes:            1:0  2:60.03  3:120.06 ...          31:1800.63
```

30.0 s and 60.0 s cadences respectively, and the last chunk (1830.67 s) sits correctly
inside `gameLength` (1849.55 s). Nothing else in the payload header is stable: the u32 at
offset 9 takes values ranging from `252` to `2767127265` across segments.

### 4.2 What is NOT decodable, with evidence

**No strings at all.** Champion names, summoner names, nothing:

```
$ for pat in Lillia Gooskaffur Tryndamere Mordekaiser Malphite summoner Champion; do
      grep -l "$pat" frame_*.bin; done
(no matches for any pattern)
```

The most frequent ≥8-char printable runs across all 38 MB are `#############`,
`{kkkkkkkkkk`, `(********'` — i.e. byte-run artefacts, not text. Entities are referenced by
numeric net-ids resolved against state the engine already holds.

**Not encrypted.** In `chunk#5` (493,204 B) there are 33 runs of ≥16 identical bytes and
4,926 repeated 8-byte blocks out of 61,650 — a block cipher would destroy both. Shannon
entropy 7.00–7.13 bits/byte (compressed-looking, not uniform-random 8.0). So there is no
key to hunt for; the data is simply dense.

**Not naive structs.** I scanned every 4-byte window for a float32 in Summoner's Rift
coordinate range (100 … 15000):

```
frame_005: windows 493201  plausible-map-float 2158  rate 0.44%
offset%16 distribution: 127,134,159,147,124,137,124,140,140,150,118,136,127,148,123,124
random baseline rate 1.41%
```

The hit rate is **below** the random-bytes baseline and **flat across all 16 alignments**.
If positions were stored as `float32 x,y,z` anywhere you would see a spike at one alignment.
They are not. The stream is delta-encoded / bit-packed against prior state.

### 4.3 Why that is structurally true, not just hard

The game binary shows these are the *same* payloads the spectator server hands out:

```
/observer-mode/rest/consumer/getGameDataChunk/%s/%lli/%u/%s
/observer-mode/rest/consumer/getKeyFrame/%s/%lli/%u/%s
```

A chunk is a delta against the world state established by the preceding keyframe, which is
itself a delta-coded snapshot of engine objects whose layouts come from the compiled game.
Interpreting it means reimplementing Riot's netcode object model — it changes every patch,
and nothing in the file describes it. **This needs the game engine. Full stop.**

### 4.4 What to do instead

`GET /lol-match-history/v1/game-timelines/{gameId}` on the LCU already returns 40 one-minute
frames with `participantFrames[id] = {currentGold, totalGold, xp, level, minionsKilled,
jungleMinionsKilled, position:{x,y}}` plus `CHAMPION_KILL` (with `position`), 
`ELITE_MONSTER_KILL` and `BUILDING_KILL` events. That is the positional/event source.
Its known limitation vs. Riot's public API (no `ITEM_PURCHASED` / `WARD_PLACED` /
`SKILL_LEVEL_UP`) is **not** fixable by reading the `.rofl`.

The `manifest` segment (type 3, id 1, 15,562 B) is the only unexplored candidate — it is the
startup blob and would be where champion/skin/spell assignments live. Its payload is the same
opaque bit-packed encoding (entropy 6.10, zero strings). I did not crack it. **UNVERIFIED**
whether it contains anything you cannot already get from `statsJson`; my expectation is that
it does not, since `statsJson` already carries champion, runes, spells and items for all 10.

---

## 5. `gameId`, patch and game length without the LCU

### 5.1 `gameId` — **not in the file**

I searched the raw file *and* all 95 decompressed segment payloads for the value
5631300987 in every plausible encoding:

```
gameId u64 LE                7bd5a64f01000000   -> NOT FOUND
gameId u32 LE(low)           7bd5a64f           -> NOT FOUND
gameId u64 BE                000000014fa6d57b   -> NOT FOUND
gameId ascii                 35363331333030393837 -> NOT FOUND
```

This is a **behaviour change from ROFL1**, where the payload header carried `gameId` as a
u64. The client gets it from the path instead — `LeagueClient.exe` contains the format
string that builds it:

```
%s/%s-%llu.rofl
FileManager: caching metadata for Replay gameId '%llu', gameVersion '%s', roflPath '%s'
```

⇒ **filename convention `<platformId>-<gameId>.rofl`**, e.g. `NA1-5631300987.rofl`.
Parse it from the basename. If a user renames a file you lose the gameId permanently — the
app should treat the filename as load-bearing and never rewrite it.

Corollary: the file also has **no `queueId`, no `mapId`, no `gameCreation` timestamp**, and
no ban list. Use the file's mtime as a weak creation proxy, or join to the LCU by gameId.

### 5.2 Patch version — header, offset 0x0F

`readUInt8(0x0E)` = length, then that many ASCII bytes ⇒ `"16.17.810.4348"`.
The `A.B.C.D` shape is `<season>.<patch>.<build>.<revision>`; the LCU's
`/lol-replays/v1/configuration` reports the client's own in the identical format
(`"gameVersion":"16.17.810.4348"`), so they are directly comparable.

### 5.3 Game length — trailing JSON

`gameLength` in **milliseconds**. Also derivable to ±30 s from the last chunk's float32
timestamp (§4.1) if you ever have a truncated file with unreadable JSON.

---

## 6. Cross-patch playback (⇒ can you screenshot old games?)

**Answer: no. A `.rofl` from a different patch cannot be played by the current client.**
Plan for a hard expiry of roughly one patch cycle (~2 weeks).

I could not test this directly — this machine has exactly one `.rofl` and it is on the
*current* patch (`16.17.810.4348` in the header, `16.17.810.4348` from the LCU), and the user
was mid-game so launching anything was off-limits. The evidence is therefore indirect but
convergent and, I think, conclusive:

1. **The client models it explicitly.** From LCU `GET /help?format=Full`:

   ```
   LolReplaysMetadataState = { checking:0, found:1, watch:2, download:3, downloading:4,
                               incompatible:5, missingOrExpired:6, retryDownload:7,
                               lost:8, unsupported:9, error:10 }
   ```
   `incompatible` is a first-class state alongside `missingOrExpired`.

2. **The game has a user-facing modal for exactly this**, in `League of Legends.exe`:

   ```
   game_messagebox_caption_replay_version_mismatch
   game_messagebox_text_replay_version_mismatch
   ```

3. **The engine compares a per-patch protocol digest before playback**, and logs it as a
   pair of (version, digest) tuples (§1.1):

   ```
   Client/Replay network protocol digest mismatch. Client: {%s}:0x{...}. Replay: {%s}:0x{...}
   ```
   The digest is stored at header offset 0x06, which is why it is read so early.

4. **There is a server-side floor too**: `/lol-replays/v1/configuration` exposes
   `minServerVersion` (currently `""`), backed by
   `LolReplaysReplaysDynamicConfig.MinSupportedGameServerVersion`, plus
   `minutesUntilReplayConsideredLost: 30`.

Live LCU checks I did run (read-only GETs), which are consistent with all of the above:

```
GET /lol-replays/v1/metadata/5631300987  -> {"downloadProgress":0,"gameId":5631300987,"state":"watch"}
GET /lol-replays/v1/metadata/5633857616  -> {"downloadProgress":331844411,"gameId":5633857616,"state":"download"}
GET /lol-replays/v1/configuration        -> {"gameVersion":"16.17.810.4348","isInTournament":false,
                                             "isLoggedIn":true,"isPatching":false,"isPlayingGame":true,
                                             "isPlayingReplay":false,"isReplaysEnabled":true,
                                             "isReplaysForEndOfGameEnabled":true,
                                             "isReplaysForMatchHistoryEnabled":true,
                                             "minServerVersion":"","minutesUntilReplayConsideredLost":30}
```

Both of those replays are same-patch, so neither exercises the `incompatible` branch.

**UNVERIFIED (needs a real cross-patch file to confirm):**
* whether `/lol-replays/v1/metadata/{gameId}` returns `state:"incompatible"` purely from the
  header, or only after the game process rejects it;
* whether Riot's CDN even still serves a `.rofl` for a previous-patch game (the
  `missingOrExpired` state suggests server-side expiry independent of playback).

**Design implication for screenshot capture:** any pipeline that drives the client to replay
a game and grab frames only works on **games from the current patch**. Capture must happen
promptly — treat a replay as perishable. Anything historical must be rendered from
LCU-derived data (timeline positions on a map image), not from engine screenshots.

Also note `isPlayingGame: true` was live during this research: a replay-launch pipeline must
gate on `/lol-replays/v1/configuration` (`isPlayingGame`, `isPlayingReplay`, `isPatching`)
and `/lol-gameflow/v1/gameflow-phase` before doing anything, or it will interfere with a
game in progress.

---

## 7. Reference implementation

Full working decoder, run and verified: **`/home/ssalb/coachskaffur/.research/rofl2.mjs`**
(Node ≥ 23 for `node:zlib` zstd; no npm dependencies).

```bash
node /home/ssalb/coachskaffur/.research/rofl2.mjs \
  "/mnt/c/Users/ssalb/Documents/League of Legends/Replays/NA1-5631300987.rofl"

# optional: write every decompressed segment payload out for inspection
node .../rofl2.mjs <file> --dump-segments /tmp/segments
```

It exports `parseRofl(path)` returning
`{ platformId, gameId, formatVersion, gameVersion, networkProtocolDigestHex,
   gameLengthMs, lastGameChunkId, lastKeyFrameId, stats, segments, signature,
   metaOffset, metaLength }`, where `segments[i] = { kind, type, id, nextId, decLen,
   compLen, descOffset, dataOffset, gameTimeSec, data }`.

If you only need the metadata (the 99% case), it is ~6 lines and does **not** require zstd:

```js
import fs from "node:fs"; import path from "node:path";
export function roflMetadata(file) {
  const b = fs.readFileSync(file);                       // or read head + tail only
  if (b.subarray(0,4).toString("latin1") !== "RIOT") throw new Error("not a replay");
  const gameVersion = b.subarray(15, 15 + b[14]).toString("latin1");
  const len = b.readUInt32LE(b.length - 4);
  const meta = JSON.parse(b.subarray(b.length - 4 - len, b.length - 4).toString("utf8"));
  return { gameId: Number(path.basename(file, ".rofl").split("-")[1]),
           platformId: path.basename(file).split("-")[0],
           gameVersion, gameLengthMs: meta.gameLength,
           lastGameChunkId: meta.lastGameChunkId, lastKeyFrameId: meta.lastKeyFrameId,
           players: JSON.parse(meta.statsJson) };
}
```

Both of the above were run and produce the §8 values.

For a 15 MB file you can avoid loading it all — verified, reads **123,000 bytes instead of
14,979,193** (0.8%). Worth doing if the app ever scans a whole replay folder:

```js
const fd = fs.openSync(file, "r");
const size = fs.fstatSync(fd).size;
const head = Buffer.alloc(64);  fs.readSync(fd, head, 0, 64, 0);
const t    = Buffer.alloc(4);   fs.readSync(fd, t, 0, 4, size - 4);
const len  = t.readUInt32LE(0);
const j    = Buffer.alloc(len); fs.readSync(fd, j, 0, len, size - 4 - len);
fs.closeSync(fd);
const gameVersion = head.subarray(15, 15 + head[14]).toString("latin1");
const meta = JSON.parse(j.toString("utf8"));
// -> { gameVersion: '16.17.810.4348', gameLengthMs: 1849550, bytesRead: 123000 }
```

(Head read of 64 bytes is safe: the header is `15 + gameVersionLen` and gameVersionLen is a
u8, but 64 covers every realistic `A.B.C.D` string; bump it to 271 to be exhaustive.)

---

## 8. Verified end-to-end output

```
$ node /home/ssalb/coachskaffur/.research/rofl2.mjs "…/Replays/NA1-5631300987.rofl"
{
  platformId: 'NA1',
  gameId: 5631300987,
  gameVersion: '16.17.810.4348',
  formatVersion: 2,
  networkProtocolDigest: '3714cb24566263e2 (u64 LE 0xe263625624cb1437)',
  gameLengthMs: 1849550,
  gameLengthMin: 30.83,
  lastGameChunkId: 64,
  lastKeyFrameId: 31,
  segments: 95,
  chunks: 63,
  keyframes: 31,
  signatureBytes: 256,
  metaOffset: 14856257,
  metaLength: 122932,
  players: 10,
  statFieldsPerPlayer: 371
}

Scoreboard:
Drib Redrum#420          Tryndamere     team=100 TOP      5/6/2 cs=215 gold=12346 vs=6 Fail
sillykitty#m3ow          LeeSin         team=100 JUNGLE   7/7/5 cs=10 gold=11145 vs=27 Fail
Matemangerlbout#NA1      Malphite       team=100 MIDDLE   11/5/7 cs=168 gold=12017 vs=24 Fail
AOB420#420               Draven         team=100 BOTTOM   4/9/6 cs=114 gold=10135 vs=27 Fail
dwightshrutes#NA1        Syndra         team=100 UTILITY  5/9/7 cs=71 gold=10657 vs=80 Fail
MistahFistah#3333        Mordekaiser    team=200 TOP      0/8/2 cs=165 gold=9432 vs=14 Win
Gooskaffur#NA1           Lillia         team=200 JUNGLE   21/0/4 cs=117 gold=21164 vs=32 Win
Kurstag#NA1              Pyke           team=200 MIDDLE   8/13/7 cs=57 gold=10178 vs=15 Win
MalcolmY#BLM             KogMaw         team=200 BOTTOM   5/7/10 cs=184 gold=13269 vs=19 Win
tamasaurs#666            Senna          team=200 UTILITY  2/4/16 cs=53 gold=10628 vs=64 Win
```

Self-consistency checks that all passed: 95 segments cover the byte range
`0x1D … 14,856,001` with **no gaps and no overlap**; every descriptor's `compressedLength`
matches the zstd frame length and every `decompressedLength` matches the actual output;
the residual `14,856,257 − 14,856,001 = 256` bytes is the signature; `lastGameChunkId=64`
and `lastKeyFrameId=31` from the JSON exactly match the highest ids in the segment table.

---

## 9. Open questions / what a second file would settle

| Question | Why it matters |
|---|---|
| Is the signature always 256 bytes? | Parser should compute, not hardcode (already does). |
| Is the protocol digest LE or BE, and does it change every patch or every netcode change? | Lets you predict "is this replay playable" from the file alone, without launching the client. |
| Does `type=4` mean "stored raw" generally, or is it a distinct chunk kind? | Only one instance (a 17-byte chunk) observed. |
| Is `compressedLength == 0` the raw-payload signal? | Same single-instance caveat. |
| Does the manifest (type 3) hold anything not in `statsJson`? | Would be the only remaining offline win. I judge it unlikely. |
| Does Riot's CDN still serve `.rofl` for previous-patch games? | Determines whether backfilling a replay archive is even possible. |
| Is the `statsJson` key set stable within a patch across queues (ARAM/Arena)? | Arena adds `PLAYER_AUGMENT_*` / `PLAYER_SUBTEAM*`; parse defensively. |

---

## Appendix — commands used

```bash
xxd -l 512 NA1-5631300987.rofl                       # header
xxd -s -512 NA1-5631300987.rofl                      # trailer (JSON + u32 len)
node -e "console.log('zstdDecompressSync' in require('node:zlib'))"   # -> true
node rofl2.mjs <file> --dump-segments /tmp/segments   # full parse + payload dump
strings -a "Game/League of Legends.exe" | grep -a "Replay V2"
strings -a "Game/League of Legends.exe" | grep -ai "network protocol"
strings -a "LeagueClient.exe" | grep -ai rofl
# LCU (Windows-side curl.exe — WSL2 cannot reach 127.0.0.1 on the Windows host)
IFS=':' read -r n pid port pass proto < "/mnt/c/Games/Riot Games/League of Legends/lockfile"
/mnt/c/WINDOWS/system32/curl.exe -sk -u "riot:$pass" "https://127.0.0.1:$port/help?format=Full"
```

All LCU access during this research was **read-only GET**. No replay was launched, no game
state was modified — the user was in an active game (`isPlayingGame: true`) throughout.
