# fawnsei — Stack & Background Daemon

Research phase deliverable. Every number below was measured on this machine on 2026-09-02.
Anything I could not run is explicitly labelled **UNVERIFIED**.

Conditions during research: the user was **actively in a ranked game** (`gameflow-phase: "InProgress"`,
playing Lillia). All probing was strictly read-only GETs. No POST/PUT/PATCH/DELETE was ever issued.

---

## 0. Executive summary — the decisions

| Question | Decision |
|---|---|
| Frontend | **Vite 8 + React 19** (not Next.js) |
| Backend | **Hono 4 + `@hono/node-server`**, single Node process |
| Validation | **ArkType 2.2.3** at every I/O boundary — strongly recommended |
| TypeScript | `node --experimental-strip-types`, no build step for server |
| Storage | **SQLite (`node:sqlite`, built into Node 25) on ext4** + gzipped JSON blobs + media files on disk |
| LCU transport | **Persistent Windows-side `node.exe` bridge** over the LCU WAMP WebSocket, NDJSON over stdio |
| Polling | **Effectively none.** Event-driven. Fallbacks: lockfile `watchFile` @2s, phase poll @5s |
| Process model | Daemon is the system of record and also serves the UI. **One `systemd --user` unit** |
| Supervision | `systemd --user` — verified working, lingering already enabled |

The single most important discovery: **polling is largely unnecessary**. The LCU exposes a
WAMP WebSocket that a Windows-side Node process can hold open and stream to WSL over stdio.
The second most important: **`minutesUntilReplayConsideredLost: 30`** — replays expire 30 minutes
after a game ends, which forces a split between an urgent non-intrusive download job and a
deferred intrusive capture job.

---

## 1. Verified environment

```
$ node -v && pnpm -v && bun --version && npm -v
v25.2.1
10.18.2
1.2.10
11.7.0

$ ps -p 1 -o comm=
systemd
$ systemctl is-system-running
degraded          # degraded is fine — 4 unrelated units failed, see below
$ cat /etc/wsl.conf
[boot]
systemd=true
```

`systemctl --failed` shows only `session-3.scope`, `session-5.scope`,
`systemd-networkd-wait-online.service`, `systemd-remount-fs.service` — all standard WSL noise,
none relevant to us. "degraded" does **not** block user units.

```
$ ls -la /var/lib/systemd/linger
-rw-r--r-- 1 root root 0 Mar 24 2025 ssalb        # lingering ALREADY enabled
```

Disk: `/` (ext4) 251G, **62G free**. `/mnt/c` 934G, 86G free.

`node` resolves to **`/home/ssalb/.nvm/versions/node/v25.2.1/bin/node`** — an nvm path.
This matters: a `systemd` unit hardcoding it breaks on the next `nvm install`. See §7.

---

## 2. The networking constraint — re-verified, and the way around it

### 2.1 WSL2 → Windows localhost is genuinely dead

```
$ curl -sk -u "riot:$pass" "https://127.0.0.1:$port/lol-gameflow/v1/gameflow-phase" -w "HTTP=%{http_code}"
HTTP=000 total=0.000180

$ node -e "fetch('https://127.0.0.1:PORT/...')"
ERR ECONNREFUSED
```

`/mnt/c` is `9p` (v9fs), networking is NAT'd (`default via 172.19.144.1`). Confirmed:
**no native WSL TCP client can reach the LCU.** This is not a firewall tweak away; the briefing
was right.

### 2.2 curl.exe interop works — and `--next` is 16x cheaper

```
$ /mnt/c/WINDOWS/system32/curl.exe --version
curl 8.21.0 (Windows) libcurl/8.21.0 Schannel
Protocols: ... http https ... ws wss          # <-- note ws/wss
```

Cost decomposition (10 runs each):

| Measurement | Value |
|---|---|
| Wall clock, one full interop call | **~80 ms** (0.07–0.10) |
| Bare `curl.exe --version` (interop spawn only, no network) | **~42 ms** |
| curl's own `time_total` for the LCU request | **32 ms** |
| ...of which TLS handshake (`time_appconnect`) | **14 ms** |
| Port 2999 (no auth) `time_total` | **23 ms** |

So: ~42 ms is pure WSL→Windows process-spawn overhead, ~32 ms is curl's work.

**Batching with `--next` reuses the TCP/TLS connection:**

```
$ curl.exe -sk -u riot:$pass URL -w "1 t=%{time_total}\n" \
    --next -sk -u riot:$pass URL -w "2 t=%{time_total}\n" ... (5 total)
1 t=0.032843
2 t=0.002038
3 t=0.002107
4 t=0.002231
5 t=0.002343
WALL=0.10
```

First request 33 ms, every subsequent one **2 ms**. Five requests cost 100 ms wall instead of
5 × 80 = 400 ms. **Always batch related LCU reads into one `curl.exe` invocation.**

CPU cost is trivial:
```
$ /usr/bin/time -v bash -c 'for i in $(seq 1 20); do curl.exe ... ; done'
Elapsed (wall clock): 0:01.49
User time (seconds): 0.03
System time (seconds): 0.01
Percent of CPU this job got: 3%
```
**~2 ms CPU per poll.** Even at 1 Hz that is 0.2% of one core — irrelevant while gaming.

### 2.3 The better answer: a Windows-side Node bridge (no polling at all)

`node.exe` exists on the Windows side:

```
$ where.exe node.exe
C:\Program Files\nodejs\node.exe
$ "/mnt/c/Program Files/nodejs/node.exe" -v
v23.5.0
```

It can reach the LCU:
```
STATUS 200 BODY "InProgress" ms 73      # node.exe https.request -> LCU
```

**And it can hold the LCU event WebSocket open.** Undici's global `WebSocket` cannot set an
`Authorization` header (WHATWG API forbids it) and fails with
`Received network error or non-101 status code`. The working approach is a manual upgrade over
`https.request`, which respects `rejectUnauthorized: false`:

```js
const https = require("https"), crypto = require("crypto")
const req = https.request({
  host: "127.0.0.1", port: +port, path: "/", rejectUnauthorized: false,
  headers: {
    authorization: "Basic " + Buffer.from("riot:" + pass).toString("base64"),
    connection: "Upgrade", upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
    "sec-websocket-protocol": "wamp"
  }
})
req.on("upgrade", (res, sock) => { /* send [5,"OnJsonApiEvent"], parse frames */ })
```

Measured result:
```
UPGRADE_OK status= 101 proto= wamp
EVT Update /data-store/v1/install-settings/gameflow-patcher-lock 1788381256321
TOTAL 1
```

HTTP 101, `wamp` subprotocol negotiated, real event received. (Event volume is low *during* a
game because the LeagueClient UI is idle while `League of Legends.exe` has focus — expected.)

**Bidirectional stdio between WSL and `node.exe` is confirmed working**, with sub-millisecond
round-trips:

```
  <- {"ready":true,"pid":31524}
  <- {"echoOf":1,"ts":1788380841589}
  <- {"echoOf":2,"ts":1788380841590}
  <- {"echoOf":3,"ts":1788380841591}
RESULT: bidirectional stdio round-trips = 3
```

This is the architecture: **one long-lived `node.exe` process acts as both the event stream and a
request proxy**, speaking NDJSON over stdin/stdout. The daemon never spawns `curl.exe` in steady
state. `curl.exe` remains only as a cold-start/fallback path.

> Note: WSL cannot connect *to* a port the bridge opens on Windows, so stdio is the only reliable
> channel. Windows→WSL localhost forwarding may exist but is **UNVERIFIED** and unnecessary.

---

## 3. LCU API surface — what is actually there

### 3.1 Auth

```bash
IFS=':' read -r name pid port pass proto < "/mnt/c/Games/Riot Games/League of Legends/lockfile"
# LeagueClient:6456:50924:WOS92Mhi4bplapduLxzxlw:https
```
The `pid` field matches the real `LeagueClient.exe` PID (verified: both 6456), so it doubles as a
staleness check.

### 3.2 Verified 200 endpoints

| Endpoint | Notes |
|---|---|
| `/lol-summoner/v1/current-summoner` | identity |
| `/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=20` | 90 KB, 392 ms |
| `/lol-match-history/v1/games/{gameId}` | 31.8 KB, 30 ms |
| `/lol-match-history/v1/game-timelines/{gameId}` | 112 KB / 74 KB, 45–55 ms |
| `/lol-replays/v1/configuration` | **the idle gate** |
| `/lol-replays/v1/metadata/{gameId}` | 200 when known, 404 otherwise |
| `/lol-replays/v1/rofls/path` | `"C:/Users/ssalb/Documents/League of Legends/Replays"` |
| `/lol-gameflow/v1/gameflow-phase` | |
| `/lol-gameflow/v1/session` | includes `gameClient.running`, `serverIp` |
| `/lol-gameflow/v1/watch` | returned `"None"` |
| `/lol-gameflow/v1/gameflow-metadata/player-status` | |
| `/Help` and `/Help?format=Full` | 268 KB / 3.1 MB RPC catalogue |

`/swagger/v2/swagger.json` and `/swagger/v3/openapi.json` are **404**. `/Help` documents only
builtin RPC functions — it contains **zero** `/lol-replays/...` or `/lol-gameflow/...` REST paths
(verified by grep). Route discovery for plugin endpoints is therefore not possible via `/Help`.

### 3.3 Route existence proven without mutating anything

A GET against a POST-only route returns `405 WRONG_METHOD`, versus `404 RESOURCE_NOT_FOUND` for a
route that does not exist. This let me confirm the mutating endpoints exist without calling them:

```
405 /lol-replays/v1/rofls/5633857616/download          {"errorCode":"WRONG_METHOD",...}
405 /lol-replays/v1/rofls/5633857616/download/graceful {"errorCode":"WRONG_METHOD",...}
405 /lol-replays/v1/rofls/5633857616/watch             {"errorCode":"WRONG_METHOD",...}
405 /lol-replays/v1/rofls/scan                         {"errorCode":"WRONG_METHOD",...}
404 /lol-replays/v1/metadata/5633857616/create         {"errorCode":"RESOURCE_NOT_FOUND",...}
404 /lol-replays/v2/metadata/5633857616                {"errorCode":"RESOURCE_NOT_FOUND",...}
```

**Confirmed to exist (method is POST):**
- `POST /lol-replays/v1/rofls/{gameId}/download` — downloads the .rofl. **Non-intrusive.**
- `POST /lol-replays/v1/rofls/{gameId}/download/graceful`
- `POST /lol-replays/v1/rofls/{gameId}/watch` — **launches the game client into replay playback. HIJACKS THE MACHINE.**
- `POST /lol-replays/v1/rofls/scan`

**UNVERIFIED:** their request bodies and exact semantics. Community convention is
`{"componentType": "string"}` as the body, but I did not and could not call them. The build phase
must test these when the user is confirmed idle, and must treat the first `watch` call as a
supervised experiment.

### 3.4 `/lol-replays/v1/configuration` — the gate

```json
{"gameVersion":"16.17.810.4348","isInTournament":false,"isLoggedIn":true,
 "isPatching":false,"isPlayingGame":true,"isPlayingReplay":false,
 "isReplaysEnabled":true,"isReplaysForEndOfGameEnabled":true,
 "isReplaysForMatchHistoryEnabled":true,"minServerVersion":"",
 "minutesUntilReplayConsideredLost":30}
```

Two critical fields:
- `isPlayingGame` / `isPlayingReplay` — a **direct, authoritative idle signal**. Far better than
  guessing from `tasklist.exe` (which costs 230 ms) or gameflow phase alone.
- `minutesUntilReplayConsideredLost: 30` — **hard 30-minute deadline** to download a replay after
  a game ends. This is the single most schedule-critical fact in the whole design.

### 3.5 Timeline shape (exact)

`GET /lol-match-history/v1/game-timelines/{gameId}` returns `{ frames: [...] }` — **only that one
key**. There is no `frameInterval` field. 40 frames for a 2310 s game; timestamps
`[0, 60015, 120027, 180043, 240064, ... 2310165]` → **1 frame per minute**.

Frame: `{ events, participantFrames, timestamp }`.

```json
"participantFrames": { "1": {
  "currentGold":556,"dominionScore":0,"jungleMinionsKilled":0,"level":8,
  "minionsKilled":71,"participantId":1,"position":{"x":1915,"y":11618},
  "teamScore":0,"totalGold":2956,"xp":4888 } }
```

**Event types present — this is the complete set observed across a full 38-minute game:**
```json
{ "CHAMPION_KILL": 97, "ELITE_MONSTER_KILL": 12, "BUILDING_KILL": 18 }
```

Every event carries the same flat envelope with unused fields zeroed:
```json
{"assistingParticipantIds":[9],"buildingType":"","itemId":0,"killerId":10,
 "laneType":"","monsterSubType":"","monsterType":"","participantId":0,
 "position":{"x":12667,"y":2783},"skillSlot":0,"teamId":0,
 "timestamp":136607,"towerType":"","type":"CHAMPION_KILL","victimId":5}
{"...":"...","monsterSubType":"CHEMTECH_DRAGON","monsterType":"DRAGON","type":"ELITE_MONSTER_KILL"}
{"...":"...","buildingType":"TOWER_BUILDING","laneType":"MID_LANE","towerType":"OUTER_TURRET","type":"BUILDING_KILL"}
```

**Confirmed limitation:** no `ITEM_PURCHASED`, `WARD_PLACED`, `SKILL_LEVEL_UP`, or
`WARD_KILL`. The LCU timeline is a genuinely reduced event set versus Riot's public
match-v5 API. Coaching that depends on build paths or vision timing **cannot** be derived from
this endpoint. See §3.7 for the fix.

### 3.6 Game shape

`GET /lol-match-history/v1/games/{gameId}` → 31.8 KB:
```
endOfGameResult, gameCreation, gameCreationDate, gameDuration, gameId, gameMode,
gameModeMutators, gameType, gameVersion, mapId, participantIdentities,
participants, platformId, queueId, seasonId, teams
```
`participants[i]` = `{championId, highestAchievedSeasonTier, participantId, spell1Id, spell2Id, stats, teamId, timeline}`.
`stats` has ~120 fields including `visionScore`, `wardsPlaced`, `wardsKilled`,
`totalDamageDealtToChampions`, `item0..item6`, `perk0..perk5` + vars, `neutralMinionsKilled*`,
`longestTimeSpentLiving`, `timeCCingOthers`, `win`.

### 3.7 The Live Client Data API (port 2999) — a major find

**Unauthenticated**, plain self-signed HTTPS, live only while a game or replay is running.
Verified 200 during the in-progress game:

| Endpoint | Content |
|---|---|
| `/liveclientdata/allgamedata` | everything below combined |
| `/liveclientdata/activeplayer` | `abilities, championStats, currentGold, fullRunes, level, riotId...` |
| `/liveclientdata/gamestats` | `{gameMode, gameTime, mapName, mapNumber, mapTerrain}` |
| `/liveclientdata/playerlist` | 10 players, 28.7 KB |
| `/liveclientdata/eventdata` | full named event log |

`playerlist[i]` keys:
```
championName,isBot,isDead,items,level,position,rawChampionName,rawSkinName,
respawnTimer,riotId,riotIdGameName,riotIdTagLine,runes,scores,skinID,skinName,
summonerName,summonerSpells,team
```
`items[]` entries carry `{itemID, displayName, price, slot, count, consumable}`.

`eventdata` sample (real, from the live game):
```json
{"EventID":0,"EventName":"GameStart","EventTime":0.030}
{"EventID":1,"EventName":"MinionsSpawning","EventTime":30.047}
{"EventID":2,"EventName":"ChampionKill","EventTime":194.728,
 "KillerName":"xxXLouvAXxx","VictimName":"AbiDabi","Assisters":["Ghostexe","Diablo0310"]}
{"EventID":3,"EventName":"FirstBlood","EventTime":194.728,"Recipient":"xxXLouvAXxx"}
```

**Why this matters enormously:** sampling `playerlist` every ~10 s during a game reconstructs
**item build order with timestamps** — exactly the data the post-game timeline is missing.
It also gives per-player `scores` (CS, KDA, vision) and `runes` live.

**Design consequence:** the daemon should run an in-game telemetry sampler against port 2999
and persist a `live_samples` track. This is additive data that is *unobtainable after the game
ends*, so it must be captured live or lost forever. Cost at a 10 s interval: 23 ms per call,
~2 ms CPU → **0.02% of one core.** Trivially affordable while gaming.

---

## 4. The `.rofl` file

> **Superseded in part — see `.research/rofl-format.md` and the working decoder
> `.research/rofl2.mjs`.** A parallel research effort fully reverse-engineered the ROFL2
> container while I was working, and it got further than my own probing did. Where this
> section and that document disagree, **trust `rofl-format.md`** — it has a verified
> end-to-end decoder. I am keeping my raw observations below because they were independently
> measured and they agree on the part that matters for this design.

### 4.1 What I measured directly

```
$ xxd -l 64 NA1-5631300987.rofl
00000000: 5249 4f54 0200 3714 cb24 5662 63e2 0e31  RIOT..7..$Vbc..1
00000010: 362e 3137 2e38 3130 2e34 3334 3801 0000  6.17.810.4348...
00000020: 0002 0000 0003 ca3c 0000 7e14 0000 28b5  .......<..~...(.
00000030: 2ffd 60ca 3ba5 a300 da0d 693f 5420 4a51  /.`.;.....i?T JQ
```
Magic `RIOT\x02\x00` = ROFL2. Patch string `16.17.810.4348` in plaintext at 0x0A.
`28 b5 2f fd` at **0x2E** is the zstd magic.

```
$ tail -c +47 NA1-5631300987.rofl > payload.zst && zstd -d -c payload.zst | xxd | head
00000000: 0100 0000 00bb 3c00 0033 0300 0000 00ae  ......<..3......
00000010: 4e91 37a9 94f9 fcd6 ee8a 6ff9 f5f9 f9fa  N.7.......o.....
```
The zstd decode succeeds (exit 0) and yields a proprietary binary packet stream.

### 4.2 The corrected conclusion

My initial read — "not worth parsing" — was **too strong, and I was wrong about the file as a
whole.** The correct split, per the verified decoder:

- **The segment/chunk payloads are opaque.** Both efforts agree: replaying them requires the
  game engine. Per-minute gold/xp/positions and kill coordinates are **not** obtainable from
  the file; they must come from `/lol-match-history/v1/game-timelines/{gameId}`.
- **But the file has an uncompressed trailing JSON metadata block** (last `metaLen` bytes,
  length in the final u32 LE) containing `gameLength` and a `statsJson` with **371 stats ×
  10 players**, including PUUIDs, Riot IDs, runes, items, and summoner spells.
- `gameId` is **not** in the file — parse it from the filename `<platformId>-<gameId>.rofl`.

**Design consequence for the build phase:** the trailing JSON is a genuine *offline* fallback
for end-of-game stats. It matters because it is readable **after the 30-minute LCU replay
window has closed** and even when the League client is not running. Prefer the LCU endpoints
when they are available (richer, already validated by our ArkType schemas), and fall back to
`rofl2.mjs` when ingesting an old `.rofl` the LCU no longer knows about. What the `.rofl`
never gives you is the *timeline*, so §3.5's limitations and §3.7's live-telemetry workaround
stand unchanged.

Tooling confirmed present: `/usr/bin/zstd`, and Node 25's `require("zlib").zstdDecompressSync`.

## 5. Stack decision — **Vite + React + Hono + ArkType**

### 5.1 Measured comparison

| | Vite + React + Hono | Next.js 16 |
|---|---|---|
| `pnpm add` wall time | **3.33 s** | 12.77 s |
| `node_modules` size | **75 MB** | **438 MB** |
| Dev server "ready" | 322 ms | 398 ms |
| **Dev time-to-first-200** | **802 ms** | **8795 ms** |

```
=== vite dev cold start ===
  time-to-first-200: 802ms
  VITE v8.2.2  ready in 322 ms
  page: 200 in 0.009677s

=== next.js dev cold start ===
  next time-to-first-200: 8795ms
  ✓ Ready in 398ms
```

Note the gap between Next's advertised "Ready in 398ms" and the 8.8 s until a page actually
renders — that is the first route compile. **11x slower first paint, 5.8x bigger install.**

Resolved versions: `vite@8.2.2`, `react@19.2.8`, `hono@4.13.5`, `@hono/node-server@2.1.1`,
`arktype@2.2.3`, `next@16.3.4`.

### 5.2 Why not Next.js

1. **Every advantage Next offers is irrelevant here.** SSR, RSC, image optimization, edge
   runtime, routing conventions, and SEO are all worthless for a single-user localhost app.
2. **It actively fights the daemon.** The app's centre of gravity is a long-lived stateful
   process holding a WebSocket bridge, a job queue, and SQLite handles. Next's dev server
   recompiles and re-evaluates modules on edit, which would repeatedly tear down that state.
   Route handlers are the wrong shape for "own a child process for 8 hours".
3. **438 MB and a 8.8 s edit-to-see loop** for a local tool is a bad trade.

### 5.3 Why Hono

- **Range requests work out of the box** — mandatory for video scrubbing. Verified:
  ```
  === full GET (15MB) ===
  code=200 size=14979193 t=0.070641 speed=212046729     # 212 MB/s
  === RANGE request (bytes=100-199) ===
  code=206 size=100
  accept-ranges: bytes
  content-length: 100
  content-range: bytes 100-199/14979193
  ```
  A 15 MB file served in 70 ms, and `serveStatic` returns a correct `206` with `Content-Range`.
- **SSE is first-class** via `hono/streaming`. Verified end-to-end:
  ```
  event: progress
  data: {"i":0}
  ...
  event: end
  data: done
  ```
  SSE beats WebSockets here: the traffic is one-directional (server → UI), it reconnects
  automatically, and it survives the Vite dev proxy without extra config.
- Tiny, fast, standard `Request`/`Response`, and it is just a function you mount inside your own
  Node server — so the daemon owns the process, not the framework.

### 5.4 ArkType — yes, strongly recommended

This is a good fit on the merits, not just because the user wrote it.

**The problem it solves is real and specific.** Every byte this app consumes comes from an
undocumented, unversioned, patch-to-patch-unstable API surface (the LCU) reached over a fragile
transport. There is no OpenAPI spec (`/swagger/*` is 404). When Riot changes a field in patch
16.18, the failure without validation is a confusing `undefined` deep inside an analytics
function or, worse, a silently wrong coaching claim shown to the user. With validation it is a
precise error at the boundary naming the exact field.

**It is fast enough to be invisible.** Validating the real 112 KB timeline:
```
100x timeline validate (112KB) = 15ms total      # 0.15 ms each
```
0.15 ms against a 45 ms fetch is 0.3% overhead. There is no performance argument against it.

**It works on the real payloads.** Verified against live LCU responses:
```
phase: "InProgress"
bad phase -> must be "ChampSelect", "EndOfGame", "GameStart", "InProgress", "Lobby",
             "Matchmaking", "None", "PreEndOfGame", "ReadyCheck" or "WaitingForStats"
             (was "Nonsense")
cfg valid? OK
timeline valid? OK 40 frames
```
Note the error message quality — that is exactly what you want when a patch breaks a field.

**One inferred type, three uses.** The same declaration gives the runtime check, the static TS
type via `typeof T.infer`, and the API contract shared between server and web. No duplicate
type/schema definitions.

**Where to apply it (and where not):**
- **Validate:** every LCU response, every port-2999 response, every `/api` request body, the
  Claude review JSON output, and the settings file. These are all untrusted or unstable.
- **Do not validate:** rows read back out of your own SQLite. You wrote them; re-validating on
  every read is wasted work. Validate on write instead.
- Use **loose/permissive object shapes** for LCU payloads — declare the ~15 fields you actually
  consume and let the other 100 pass through. A strict schema over a 120-field `stats` object
  would break on every patch that *adds* a field, which is the opposite of what you want.

Also worth noting: `node --experimental-strip-types` runs ArkType-typed TS directly with no build
step (verified, 0.42 s startup), so the daemon has no compile stage at all.

---

## 6. Storage

### 6.1 The decisive measurement: ext4 vs 9p

```
ext4 ~/      2000 inserts(txn)        ms= 38
ext4 ~/      200 inserts(autocommit)  ms= 245
9p /mnt/c    2000 inserts(txn)        ms= 992
9p /mnt/c    200 inserts(autocommit)  ms= 762

raw dd 200MB: ext4 855 MB/s   |   9p 118 MB/s
```

**SQLite on `/mnt/c` is 26x slower** for transactional writes; raw throughput is 7x worse.

**Rule: all application data lives on ext4 under `~/.local/share/fawnsei/`. `/mnt/c` is
read-only territory** — we only ever read the lockfile and copy `.rofl` files out of it.

### 6.2 SQLite vs plain JSON files — decision: **both, split by role**

`node:sqlite` is **built into Node 25** — no native compilation, no dependency:
```
$ node -e "const {DatabaseSync}=require('node:sqlite'); ..."
node:sqlite OK — 1000 inserts ms= 2
read back: [Object: null prototype] { c: 1000 }
```
(Emits `ExperimentalWarning: SQLite is an experimental feature`. Silence with
`--no-warnings=ExperimentalWarning`.)

`better-sqlite3@13.0.3` also installs cleanly from a prebuilt binary in 3.33 s with no compiler
needed — a drop-in fallback if the experimental API shifts. **Start with `node:sqlite`;** the API
surface used (`DatabaseSync`, `prepare`, `run`, `get`, `all`, `exec`) is identical enough that
swapping is a one-file change.

**Why not plain JSON files for everything:** the queries this app needs — "games since date X
where role = jungle and no review exists", "feedback items across the last 20 games grouped by
tag", "next runnable job ordered by priority" — are joins and filters. Doing those over a
directory of JSON means loading everything into memory on every request and hand-rolling
indexes. The job queue in particular needs atomic claim semantics that a file store cannot give
you safely.

**Why not SQLite for everything:** timelines are 112 KB and clips are megabytes. Large blobs in
SQLite bloat the file, slow the backup story, and gain nothing — nobody queries *inside* a
timeline blob with SQL.

**The split:**

| Data | Where | Rationale |
|---|---|---|
| Game metadata, participants, derived metrics | SQLite rows | queried, filtered, joined |
| Feedback items, reviews, tags | SQLite rows | queried and cross-referenced |
| Job queue | SQLite | atomic claim, survives restart |
| Raw match JSON (32 KB) | `blobs/` gzipped | archival, read whole |
| Raw timeline JSON (112 KB) | `blobs/` gzipped | archival, read whole |
| Live telemetry samples | `blobs/` gzipped NDJSON | append-only, read whole |
| `.rofl` replays (15 MB) | `replays/` | opaque, huge |
| Screenshots / clips | `media/` | served with Range |

Compression is excellent — measured:
```
tl-5633857616.json raw=112425 gzip=12414 (11%) zstd19=9357 (8%)
g-5633857616.json  raw=31844  gzip=4565  (14%) zstd19=3857 (12%)
```
Use gzip (`node:zlib`, universal, 11%); zstd's extra 3% is not worth the ceremony.

**Projected storage for 1000 games:**
```
raw json        : 144 MB
gzipped json    :  17 MB
.rofl replays   : 15.0 GB   <-- dominates
1 clip/game 8MB :  8.0 GB
```
With 62 GB free, JSON is a rounding error and **replays are the only real cost**. Add a retention
policy: keep `.rofl` for N days (default 14) or until a capture job has extracted its clips, then
delete. Track deletion in the DB so the UI can show "replay expired" rather than 404ing.

### 6.3 On-disk layout

```
~/.local/share/fawnsei/
├── csk.db                  # SQLite (WAL mode)
├── csk.db-wal
├── csk.db-shm
├── blobs/
│   └── <gameId>/
│       ├── match.json.gz       # /lol-match-history/v1/games/{id}
│       ├── timeline.json.gz    # /lol-match-history/v1/game-timelines/{id}
│       └── live.ndjson.gz      # port-2999 samples captured during play
├── replays/
│   └── NA1-<gameId>.rofl       # copied off /mnt/c, or a symlink if retention is short
├── media/
│   └── <gameId>/
│       ├── shot-<ms>.png
│       └── clip-<startMs>-<endMs>.mp4
└── logs/
    └── daemon.log              # journald is primary; this is a rotating mirror
```

### 6.4 Schema

```sql
PRAGMA journal_mode = WAL;      -- readers never block the daemon's writes
PRAGMA synchronous = NORMAL;    -- safe with WAL, much faster
PRAGMA foreign_keys = ON;

CREATE TABLE schema_version (version INTEGER NOT NULL);

-- One row per game we know about.
CREATE TABLE game (
  game_id           INTEGER PRIMARY KEY,       -- LCU gameId
  platform_id       TEXT    NOT NULL,          -- "NA1"
  queue_id          INTEGER NOT NULL,
  game_mode         TEXT    NOT NULL,
  game_version      TEXT    NOT NULL,          -- "16.17.810.4348"
  game_creation_ms  INTEGER NOT NULL,
  duration_s        INTEGER NOT NULL,
  ended_at_ms       INTEGER NOT NULL,          -- creation + duration, the retention clock
  -- our player's slice, denormalized for list rendering
  participant_id    INTEGER NOT NULL,
  champion_id       INTEGER NOT NULL,
  team_id           INTEGER NOT NULL,
  role              TEXT,                      -- derived, nullable
  win               INTEGER NOT NULL,          -- 0/1
  kills INTEGER, deaths INTEGER, assists INTEGER,
  cs INTEGER, gold INTEGER, vision_score INTEGER,
  -- content availability
  match_blob        TEXT,                      -- relative path or NULL
  timeline_blob     TEXT,
  live_blob         TEXT,
  replay_path       TEXT,                      -- NULL once pruned
  replay_state      TEXT NOT NULL DEFAULT 'unknown',
                    -- unknown|available|downloading|downloaded|expired|pruned|unavailable
  -- cache invalidation
  ingested_at_ms    INTEGER NOT NULL,
  content_hash      TEXT NOT NULL,             -- sha256 of match+timeline bytes
  analysis_version  INTEGER NOT NULL DEFAULT 0,
  review_version    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX game_by_time ON game(game_creation_ms DESC);
CREATE INDEX game_by_replay_state ON game(replay_state, ended_at_ms);

-- All 10 players, so we can render scoreboards and compare lanes.
CREATE TABLE participant (
  game_id        INTEGER NOT NULL REFERENCES game(game_id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL,
  team_id        INTEGER NOT NULL,
  champion_id    INTEGER NOT NULL,
  summoner_name  TEXT,
  riot_id        TEXT,
  is_self        INTEGER NOT NULL DEFAULT 0,
  stats_json     TEXT NOT NULL,                -- the full ~120-field stats object
  PRIMARY KEY (game_id, participant_id)
);

-- Derived analytics. Recomputed when analysis_version changes.
CREATE TABLE metric (
  game_id  INTEGER NOT NULL REFERENCES game(game_id) ON DELETE CASCADE,
  key      TEXT    NOT NULL,      -- "cs_per_min@14", "gold_diff@15", "deaths_in_river"
  value    REAL    NOT NULL,
  band     TEXT,                  -- "good"|"ok"|"bad" vs the user's own baseline
  detail   TEXT,                  -- optional JSON
  PRIMARY KEY (game_id, key)
);

-- Timestamped moments worth looking at. The spine of the review page.
CREATE TABLE moment (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id    INTEGER NOT NULL REFERENCES game(game_id) ON DELETE CASCADE,
  t_ms       INTEGER NOT NULL,          -- game clock
  kind       TEXT    NOT NULL,          -- death|kill|objective|recall|spike|itemspike
  severity   INTEGER NOT NULL DEFAULT 0,
  x REAL, y REAL,                       -- map coords, nullable
  payload    TEXT NOT NULL              -- JSON: participants, source event
);
CREATE INDEX moment_by_game ON moment(game_id, t_ms);

-- Claude output.
CREATE TABLE review (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id        INTEGER NOT NULL REFERENCES game(game_id) ON DELETE CASCADE,
  created_at_ms  INTEGER NOT NULL,
  model          TEXT NOT NULL,
  prompt_hash    TEXT NOT NULL,         -- digest of the exact input
  input_tokens   INTEGER, output_tokens INTEGER, cost_usd REAL,
  duration_ms    INTEGER,
  summary        TEXT NOT NULL,
  raw_json       TEXT NOT NULL,
  status         TEXT NOT NULL          -- ok|failed
);
CREATE INDEX review_by_game ON review(game_id, created_at_ms DESC);

-- Individual coaching points, each anchored to a time and optionally media.
CREATE TABLE feedback_item (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id    INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  game_id      INTEGER NOT NULL REFERENCES game(game_id) ON DELETE CASCADE,
  t_ms         INTEGER,                 -- links to the timeline scrubber
  moment_id    INTEGER REFERENCES moment(id),
  media_id     INTEGER REFERENCES media(id),
  category     TEXT NOT NULL,           -- laning|vision|macro|teamfight|itemization
  severity     TEXT NOT NULL,           -- info|minor|major
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX feedback_by_game ON feedback_item(game_id);
CREATE INDEX feedback_by_category ON feedback_item(category, severity);

-- Screenshots and clips.
CREATE TABLE media (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     INTEGER NOT NULL REFERENCES game(game_id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,            -- screenshot|clip
  path        TEXT NOT NULL,            -- relative to media root
  t_start_ms  INTEGER NOT NULL,
  t_end_ms    INTEGER,
  width INTEGER, height INTEGER, bytes INTEGER,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX media_by_game ON media(game_id, t_start_ms);

-- Live telemetry index (the bulk lives in live.ndjson.gz).
CREATE TABLE live_session (
  game_id      INTEGER PRIMARY KEY REFERENCES game(game_id) ON DELETE CASCADE,
  started_ms   INTEGER NOT NULL,
  ended_ms     INTEGER,
  sample_count INTEGER NOT NULL DEFAULT 0,
  last_event_id INTEGER NOT NULL DEFAULT -1   -- dedupe against /eventdata EventID
);

-- Durable job queue.
CREATE TABLE job (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,
  game_id        INTEGER REFERENCES game(game_id) ON DELETE CASCADE,
  state          TEXT NOT NULL,     -- see §7.4
  priority       INTEGER NOT NULL DEFAULT 100,   -- lower runs first
  run_after_ms   INTEGER NOT NULL DEFAULT 0,
  deadline_ms    INTEGER,           -- replay download: ended_at + 30min
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 5,
  gate_reason    TEXT,              -- why it is deferred right now
  last_error     TEXT,
  payload        TEXT NOT NULL DEFAULT '{}',
  lease_until_ms INTEGER,           -- crash recovery
  created_at_ms  INTEGER NOT NULL,
  updated_at_ms  INTEGER NOT NULL
);
CREATE INDEX job_runnable ON job(state, priority, run_after_ms);
CREATE UNIQUE INDEX job_dedupe ON job(kind, game_id)
  WHERE state IN ('queued','deferred','running');

CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- UI notification feed, also the SSE replay log.
CREATE TABLE app_event (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms         INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  game_id       INTEGER,
  payload       TEXT NOT NULL DEFAULT '{}',
  seen          INTEGER NOT NULL DEFAULT 0
);
```

### 6.5 Cache invalidation — the rule

Nothing is re-fetched or re-analyzed unless a version or hash actually changes.

```
FETCH match/timeline   iff  game.match_blob IS NULL OR game.timeline_blob IS NULL
                            (immutable once a game ends — never re-fetch on a hit)

content_hash          = sha256(match.json.gz bytes || timeline.json.gz bytes)

RUN analysis          iff  game.analysis_version < ANALYSIS_VERSION   (code constant)
                            OR game.content_hash changed since last analysis
                            OR live_blob appeared after analysis ran

RUN review            iff  game.review_version < REVIEW_VERSION
                            OR prompt_hash != sha256(digest || promptTemplate || model)
                            OR user clicked "re-review"

DOWNLOAD replay       iff  replay_state = 'available'
                            AND now < ended_at_ms + 30min
                            (else -> 'expired', never retried)

CAPTURE media         iff  media rows for the requested moments are missing
                            AND replay file still present
```

`ANALYSIS_VERSION` and `REVIEW_VERSION` are integer constants in the source. Bumping either one
invalidates exactly that layer across all games, and only that layer — changing a metric formula
does not force a re-review, and changing the prompt does not force re-parsing timelines. The
`prompt_hash` means editing the prompt template re-reviews automatically without a manual bump.

---

## 7. The background daemon

### 7.1 Process model — one supervised unit, two runtime processes

```
 systemd --user
   └── fawnsei.service            [WSL, ext4, Node 25]
        │  owns: SQLite, job queue, HTTP+SSE on 127.0.0.1:7700, static UI
        │
        └── spawns: node.exe bridge    [Windows, C:\Program Files\nodejs\node.exe]
             │  NDJSON over stdin/stdout
             │  holds: LCU WAMP WebSocket + HTTP proxy to 127.0.0.1:{lcuPort} and :2999
             └── restarted by the daemon on exit or port rotation
```

**Why the daemon also serves the UI, rather than a separate web server:** the daemon must run
whether or not the UI is open, and a Hono app is a function you mount — it costs ~40 MB and no
architectural complexity to serve `dist/` from the same process. Notifying the UI becomes an
in-process `EventEmitter` → SSE, with no IPC, no second SQLite writer, and no port coordination.

**Why *not* one process during development:** `vite` restarts on every edit. If the daemon lived
inside it, every keystroke would kill an in-flight Claude review or a running replay capture. So:

- **Development:** `vite` on 5173 (HMR, proxies `/api` → 7700) **plus** the daemon on 7700,
  started separately and left running across UI edits.
- **Normal use:** the daemon alone on 7700, serving the built `dist/`. One unit, one port.

Server code runs through `node --experimental-strip-types` (verified working), so there is no
server build step in either mode.

### 7.2 The systemd unit — verified working

I created, started, killed, and observed auto-restart of a real user unit:

```
=== active? ===
active
MainPID=13824
=== journal captures stdout? ===
Sep 02 16:24:39 ssalb-xps node[13824]: tick 1788380679057
Sep 02 16:24:40 ssalb-xps node[13824]: tick 1788380680059
=== kill -9 and verify auto-restart ===
restarts=13 newPID=13886 active=active
```

`Restart=always` works, `journalctl --user -u ...` captures stdout, and **lingering is already
enabled** (`/var/lib/systemd/linger/ssalb` exists), so the unit starts without an interactive
login. Cleaned up afterwards.

**Recommended unit** (`~/.config/systemd/user/fawnsei.service`):

```ini
[Unit]
Description=fawnsei — League coaching daemon
After=default.target

[Service]
Type=simple
WorkingDirectory=%h/fawnsei
# Do NOT hardcode the nvm path — it breaks on the next `nvm install`.
ExecStart=%h/fawnsei/scripts/run-daemon.sh
Restart=always
RestartSec=3
# Do not spin if it is crash-looping on a real bug.
StartLimitIntervalSec=120
StartLimitBurst=6
Environment=NODE_ENV=production
Environment=CSK_DATA_DIR=%h/.local/share/fawnsei
StandardOutput=journal
StandardError=journal
SyslogIdentifier=fawnsei

[Install]
WantedBy=default.target
```

`scripts/run-daemon.sh` resolves Node through nvm so the unit survives a Node upgrade:
```bash
#!/usr/bin/env bash
set -euo pipefail
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
exec node --experimental-strip-types --no-warnings=ExperimentalWarning src/daemon/main.ts
```

Install: `systemctl --user enable --now fawnsei`.
Logs: `journalctl --user -u fawnsei -f`.

**Why systemd over pm2:** pm2 is not installed, would be a new global dependency, and duplicates
what systemd already does correctly here. Verified working beats one more supervisor.

**One honest caveat (UNVERIFIED):** WSL2 only boots the VM when something asks it to — opening a
terminal, or a Windows-side `wsl.exe` invocation. Lingering guarantees the unit starts once the
WSL instance boots, but it cannot make WSL boot on Windows login by itself. If the user wants
the daemon running from Windows startup, add a Windows Task Scheduler entry or a shortcut in
`shell:startup` running `wsl.exe -d Ubuntu -u ssalb --exec /bin/true`. I did not test this
because verifying it requires restarting WSL, which would have interrupted the user's game.

### 7.3 Client lifecycle: detection, port rotation, restart survival

**inotify does not work on `/mnt/c`.** Verified — this is the trap to avoid:
```
$ node -e "fs.watch(lockfile, ...)"   # then write, write, unlink, write
RESULT fs.watch fired 0 times (0 => inotify NOT supported on 9p)
```
`fs.watch` **registers without error and then silently never fires.** Anyone assuming it works
will build a daemon that never notices the client at all.

`fs.watchFile` (stat-based polling) **does** work:
```
  watchFile FIRED mtime changed
RESULT watchFile fired 1 times
```

Stat cost on the 9p lockfile: **2.5 ms** per `statSync`, 4.5 ms per `readFileSync` (100 iterations
→ 249 ms / 448 ms). At a 2000 ms interval that is a 0.125% duty cycle.

**The supervisor state machine:**

```
                    ┌──────────────┐
       lockfile     │              │  lockfile gone / bridge EOF
       appears  ──> │  CONNECTING  │ <──────────────────────────┐
                    └──────┬───────┘                            │
                           │ bridge up + WS 101 + phase read    │
                           v                                    │
                    ┌──────────────┐   lockfile contents change │
                    │  CONNECTED   │ ──(port rotated)──> kill bridge, respawn
                    └──────┬───────┘                            │
                           │ read fails 3x / bridge exits       │
                           └────────────────────────────────────┘
                    ┌──────────────┐
                    │ DISCONNECTED │  no lockfile — client closed
                    └──────────────┘
```

Rules:
1. `fs.watchFile(lockfile, { interval: 2000 })`. On any change, **re-read and compare all five
   fields**. The password rotates on every client restart, so a changed `port` *or* `pass` means
   tear down the bridge and respawn it. Never cache credentials across a rotation.
2. Cross-check `pid` against the running `LeagueClient.exe` to detect a **stale lockfile** left
   behind by a crash (the client does not always clean it up). `tasklist.exe` costs 230 ms so do
   this only on transition, never in a loop.
3. If the bridge process exits for any reason, respawn with exponential backoff
   (1s, 2s, 4s … cap 30s) and re-read the lockfile first — the client may have restarted on a new
   port while we were away.
4. **All job state lives in SQLite**, so a client restart, a bridge crash, or a daemon restart
   loses nothing. On boot the daemon reclaims jobs whose `lease_until_ms` has passed and returns
   them to `queued`.
5. On reconnect, always run a **reconciliation sweep**: fetch match history and diff against the
   `game` table. This catches every game played while the daemon was down, and makes the
   WebSocket a latency optimization rather than a correctness dependency.

### 7.4 Job queue

**States:**

| State | Meaning |
|---|---|
| `queued` | ready to run when a worker is free and `run_after_ms` has passed |
| `deferred` | gate said no; `gate_reason` explains, re-evaluated every tick |
| `running` | leased by a worker until `lease_until_ms` |
| `done` | succeeded |
| `failed` | exhausted `max_attempts`; `last_error` set |
| `aborted` | user became active mid-run; safe to requeue |
| `expired` | missed `deadline_ms` (the 30-minute replay window); never retried |
| `cancelled` | user cancelled from the UI |

Transitions: `queued → running → done | failed | aborted`; `queued ⇄ deferred`;
`queued|deferred → expired` when `deadline_ms` passes; `aborted → queued` on the next tick.

**Job kinds, in dependency order:**

| Kind | Priority | Intrusive? | Deadline | Notes |
|---|---|---|---|---|
| `telemetry.capture` | 5 | no | game end | runs *during* the game, port 2999 |
| `match.ingest` | 10 | no | — | match + timeline JSON |
| `replay.download` | 20 | **no** | `ended_at + 30min` | `POST .../download` — urgent |
| `analysis.run` | 30 | no | — | metrics + moments |
| `review.claude` | 40 | no | — | Claude Agent SDK |
| `replay.capture` | 90 | **YES** | — | `POST .../watch` — hijacks the client |
| `media.encode` | 95 | no | — | ffmpeg trim/encode |
| `retention.prune` | 99 | no | — | delete aged `.rofl` |

**The critical split:** `replay.download` is *not* intrusive — it asks the client to fetch the
`.rofl` in the background — and it has a **hard 30-minute deadline** from
`minutesUntilReplayConsideredLost`. It must run immediately at game end, even while the user is
in champ select for the next game. `replay.capture` — which calls `watch` and takes over the
screen — is the only genuinely intrusive job and is the one that gets deferred.

Claiming a job atomically (single writer, but this is still the correct pattern):
```sql
BEGIN IMMEDIATE;
  SELECT id FROM job
   WHERE state = 'queued' AND run_after_ms <= :now
   ORDER BY priority, id LIMIT 1;
  UPDATE job SET state='running', attempts=attempts+1,
                 lease_until_ms=:now + 600000, updated_at_ms=:now
   WHERE id = :id;
COMMIT;
```

Concurrency: **1 worker for intrusive jobs** (strictly serial), **2 workers for everything else**.
Claude reviews are I/O-bound and can overlap with ingest.

### 7.5 Idle gating — the exact rules

An intrusive job (`replay.capture`) may start **only if every one of these holds:**

```
G1  phase ∈ { "None", "Lobby" }
G2  replayConfig.isPlayingGame  == false
G3  replayConfig.isPlayingReplay == false
G4  port 2999 does not answer (belt-and-braces: no live game)
G5  phase has been continuously in G1's set for >= idleGraceMs   (default 120_000)
G6  settings.captureEnabled == true
G7  now is inside settings.captureWindow  (default: always; user can restrict hours)
G8  no other intrusive job is running
G9  the .rofl file exists on disk
```

G1–G4 are read in **one batched `curl.exe --next` call** (or one bridge round-trip), so evaluating
the whole gate costs ~35 ms, not 4 × 80 ms.

`gameflow-phase` values seen or expected:
`None`, `Lobby`, `Matchmaking`, `ReadyCheck`, `ChampSelect`, `GameStart`, `InProgress`,
`WaitingForStats`, `PreEndOfGame`, `EndOfGame`. **Verified observed: `InProgress`, `EndOfGame`.**
The rest are the standard set and are **UNVERIFIED** here — treat the gate as an allowlist
(`None`/`Lobby` only) so an unrecognized phase fails closed.

**Abort rules — checked every 1000 ms while an intrusive job runs:**
```
A1  phase leaves { "None", "Lobby" }         -> ABORT   (user queued up)
A2  isPlayingGame becomes true               -> ABORT
A3  lockfile port/pass changes               -> ABORT   (client restarted)
A4  user hits "Stop" in the UI               -> ABORT
A5  wall-clock budget exceeded (default 10m) -> ABORT
```
On abort: stop the replay cleanly if possible, mark the job `aborted`, keep any media already
produced, and requeue with `run_after_ms = now + 5min`. **Never** leave the client sitting in a
replay the user did not ask for.

`settings.captureEnabled` should default to **false** on first run. Taking over someone's game
client is a big enough side effect that it deserves explicit opt-in, with a "capture now" button
for a manual, supervised first try.

### 7.6 Notifying the UI

The daemon writes an `app_event` row and emits in-process; the Hono SSE route relays it.

```
GET /api/events            (SSE, hono/streaming — verified working)
  event: job        data: {id, kind, gameId, state, gateReason}
  event: game       data: {gameId, stage:"ingested"|"analyzed"|"reviewed"}
  event: review     data: {gameId, reviewId, summary}
  event: capture    data: {gameId, progress, phase}
  event: daemon     data: {lcu:"connected"|"disconnected", queueDepth}
```
Clients pass `Last-Event-ID`; the daemon replays from `app_event` so a UI that was closed catches
up. SSE reconnects on its own, which is exactly the behaviour you want for a tab left open for
hours.

### 7.7 Driving Claude — verified end to end

**No `ANTHROPIC_API_KEY` is set** (confirmed: `env | grep -i anthropic` returns nothing), and
credentials exist at `~/.claude/.credentials.json`. Headless CLI with the user's subscription auth
works:

```
$ claude -p "Reply with exactly: PONG" --output-format json --model claude-sonnet-4-5-20250929
{"result":"PONG","duration_ms":3072,"total_cost_usd":0.0868,
 "usage":{"input_tokens":10,"cache_creation_input_tokens":14335,"output_tokens":52},
 "is_error":false,"subtype":"success",...}
CLAUDE_WALL=4.56 s
```

`@anthropic-ai/claude-agent-sdk@0.3.258` installs in 7.03 s and matches the CLI version (2.1.258).

**Two things to note.** First, a trivial prompt still cost **14,335 cache-creation tokens** —
that is the default system prompt and tool definitions. For a review job that needs no tools,
pass a minimal system prompt and disable tools; otherwise you pay that overhead on every game.
Second, **do not paste the raw 112 KB timeline into the prompt** (~30k tokens). Run
`analysis.run` first and send a compact derived digest — metrics, moments, build order from live
telemetry — which is both cheaper and produces better-grounded feedback.

Ask for structured output and **validate it with ArkType** before writing `feedback_item` rows;
a malformed review should fail the job, not corrupt the DB.

### 7.8 Media capture — what exists, and what is unproven

Verified available:
- `ffmpeg` and `ffprobe` at `/usr/bin/` (WSL side) — fine for trimming/encoding once a raw
  recording exists.
- **OBS Studio installed on Windows** at `/mnt/c/Program Files/obs-studio/`, and critically
  `obs-plugins/64bit/obs-websocket.dll` is present. OBS was not running (port 4455 closed,
  `obs_ws=000`).
- WSLg is present (`DISPLAY=:0`, `/mnt/wslg` exists) but is irrelevant — the game renders on the
  Windows desktop, not in WSLg.

**The honest state of replay capture — this is the weakest part of the design and the build phase
should treat it as a spike, not a solved problem:**

- `POST /lol-replays/v1/rofls/{gameId}/watch` exists (405 on GET) but its body and behaviour are
  **UNVERIFIED**.
- The in-game **Replay API** (`/replay/playback`, `/replay/render`, `/replay/recording`,
  `/replay/sequence` on port 2999) returned **404 `Invalid URI format`** during the live game.
  This is expected — those routes only mount while a *replay* is playing, not a live game — but it
  means I could **not** verify they exist on this patch. Everything about camera control and
  built-in recording is therefore UNVERIFIED. This is the single biggest open risk.
- If `/replay/recording` does work, it is by far the best path: the client records to disk itself,
  no OBS, no screen capture. **Verify this first.**
- Fallback: drive OBS via obs-websocket (the DLL is installed) from the Windows side.
- Last resort: screenshots only, via `/replay/render` camera positioning plus a Windows-side
  screenshot utility.

Recommended build order: get everything else working, ship the app with `captureEnabled: false`,
then spike the replay API against a real replay while the user is idle and watching.

---

## 8. Polling budget — final numbers

| What | Mechanism | Interval | Cost/tick | Duty cycle |
|---|---|---|---|---|
| LCU events | **WAMP WebSocket via bridge** | push | ~0 | ~0% |
| Lockfile / port rotation | `fs.watchFile` on 9p | 2000 ms | 2.5 ms stat | 0.125% |
| Phase (fallback, bridge down only) | batched `curl.exe` | 5000 ms | 80 ms wall / 2 ms CPU | 1.6% wall, 0.04% CPU |
| In-game telemetry (2999) | bridge or `curl.exe` | 10000 ms | 23 ms | 0.23% |
| Gate check (only when an intrusive job is pending) | one batched call | 5000 ms | ~35 ms | 0.7% |
| Abort check (only while capturing) | one batched call | 1000 ms | ~35 ms | 3.5% |

**Recommendation:** ship the WebSocket bridge as the primary path with a 5 s batched phase poll as
a fallback that engages only when the bridge is down. Even the pessimistic all-polling
configuration costs **~2 ms of CPU per tick** — measured, not estimated — so this was never going
to be a performance problem. The reason to prefer the WebSocket is **latency and correctness**
(you see `EndOfGame` the instant it happens, which matters against a 30-minute replay deadline),
not CPU.

Do **not** poll `tasklist.exe` (230 ms) on any interval; use it only on state transitions.

---

## 9. Repo layout

```
fawnsei/
├── AGENTS.md                          # shared agent guidance (Codex/Cursor/Claude all read this)
├── CLAUDE.md                          # one line: @AGENTS.md
├── README.md                          # setup, systemd install, troubleshooting
├── package.json
├── tsconfig.json                      # strict, moduleResolution bundler, allowImportingTsExtensions
├── vite.config.ts                     # React plugin; dev proxy /api + /media -> 127.0.0.1:7700
├── .gitignore                         # node_modules, dist, .research/tmp
├── .env.example                       # CSK_DATA_DIR, CSK_PORT, CSK_MODEL
│
├── scripts/
│   ├── run-daemon.sh                  # nvm-safe launcher used by the systemd unit
│   ├── install-service.sh             # writes + enables the --user unit, checks lingering
│   ├── uninstall-service.sh           # stops, disables, removes the unit
│   └── doctor.ts                      # preflight: lockfile, bridge, node.exe, ffmpeg, disk, DB
│
├── systemd/
│   └── fawnsei.service           # unit template installed to ~/.config/systemd/user/
│
├── src/
│   ├── shared/                        # imported by BOTH daemon and web — no Node-only imports
│   │   ├── schema/
│   │   │   ├── lcu.ts                 # ArkType: GameflowPhase, ReplayConfig, Match, Timeline
│   │   │   ├── live.ts                # ArkType: allgamedata, playerlist, eventdata (port 2999)
│   │   │   ├── domain.ts              # ArkType: Game, Moment, Review, FeedbackItem, Media, Job
│   │   │   ├── api.ts                 # ArkType: every /api request + response contract
│   │   │   └── settings.ts            # ArkType: user settings incl. capture gating options
│   │   ├── constants.ts               # ANALYSIS_VERSION, REVIEW_VERSION, queue IDs, map bounds
│   │   └── time.ts                    # game-clock <-> wall-clock, ms formatting
│   │
│   ├── lcu/
│   │   ├── lockfile.ts                # parse 5 fields; watchFile poller; stale-PID check
│   │   ├── bridge/
│   │   │   └── bridge.mjs             # RUNS ON WINDOWS node.exe. CommonJS-safe, zero deps.
│   │   │                              #   WAMP ws upgrade + HTTP proxy, NDJSON over stdio
│   │   ├── bridge-client.ts           # spawn node.exe, NDJSON framing, request/response, respawn
│   │   ├── curl-fallback.ts           # batched curl.exe --next transport when bridge is down
│   │   ├── client.ts                  # typed LCU calls, ArkType-validated
│   │   └── live-client.ts             # port 2999 client (no auth)
│   │
│   ├── daemon/
│   │   ├── main.ts                    # entry: open DB, start supervisor, workers, HTTP server
│   │   ├── supervisor.ts              # CONNECTING/CONNECTED/DISCONNECTED state machine
│   │   ├── reconcile.ts               # diff match history vs DB; catches games missed while down
│   │   ├── telemetry.ts               # in-game 2999 sampler -> live.ndjson.gz + live_session
│   │   ├── queue.ts                   # SQLite-backed queue: claim, lease, retry, expire
│   │   ├── workers.ts                 # worker pool; 1 intrusive + 2 normal
│   │   ├── gate.ts                    # G1-G9 idle rules + A1-A5 abort checks
│   │   └── jobs/
│   │       ├── index.ts               # kind -> handler registry
│   │       ├── match-ingest.ts        # fetch match+timeline, gzip to blobs, upsert rows
│   │       ├── replay-download.ts     # POST .../download, poll metadata, 30min deadline
│   │       ├── analysis-run.ts        # compute metrics + moments
│   │       ├── review-claude.ts       # build digest, call Agent SDK, validate, persist
│   │       ├── replay-capture.ts      # INTRUSIVE: watch + camera + record (spike)
│   │       ├── media-encode.ts        # ffmpeg trim/encode into media/
│   │       └── retention-prune.ts     # delete aged .rofl, mark replay_state='pruned'
│   │
│   ├── analysis/
│   │   ├── metrics.ts                 # cs@10/14, gold/xp diff, damage share, vision/min
│   │   ├── moments.ts                 # deaths, objectives, spikes -> moment rows
│   │   ├── phases.ts                  # early/mid/late segmentation
│   │   ├── builds.ts                  # item build order reconstructed from live telemetry
│   │   ├── baseline.ts                # user's own rolling baseline for metric banding
│   │   └── digest.ts                  # compact JSON handed to Claude (NOT the raw timeline)
│   │
│   ├── review/
│   │   ├── claude.ts                  # Agent SDK driver: minimal system prompt, tools off
│   │   ├── prompt.ts                  # template; its hash feeds prompt_hash invalidation
│   │   └── parse.ts                   # ArkType-validate model output -> feedback_item rows
│   │
│   ├── rofl/
│   │   └── decode.ts                  # ROFL2 trailing-JSON reader (port of .research/rofl2.mjs)
│   │                                  #   offline fallback when the LCU no longer knows a game
│   │
│   ├── db/
│   │   ├── index.ts                   # open node:sqlite, PRAGMAs, migrate on boot
│   │   ├── migrations/001_init.sql    # the schema from §6.4
│   │   ├── queries.ts                 # prepared statements, one place
│   │   └── blobs.ts                   # gzip read/write for blobs/<gameId>/*
│   │
│   ├── server/
│   │   ├── app.ts                     # Hono app: routes + static dist/ + media with Range
│   │   ├── events.ts                  # SSE hub, Last-Event-ID replay from app_event
│   │   └── routes/
│   │       ├── games.ts               # GET /api/games, /api/games/:id
│   │       ├── reviews.ts             # GET reviews; POST /api/games/:id/review (re-run)
│   │       ├── media.ts               # GET /api/media/:id (Range-served)
│   │       ├── jobs.ts                # GET queue; POST cancel / retry / capture-now
│   │       ├── settings.ts            # GET/PUT settings
│   │       └── health.ts              # daemon + LCU + bridge status for the UI banner
│   │
│   └── web/
│       ├── main.tsx                   # React root, router
│       ├── App.tsx                    # shell: sidebar, daemon status banner
│       ├── lib/
│       │   ├── api.ts                 # typed fetch against shared/schema/api.ts
│       │   ├── sse.ts                 # EventSource hook w/ reconnect
│       │   └── format.ts
│       ├── pages/
│       │   ├── GameList.tsx           # screen 1
│       │   ├── GameReview.tsx         # screen 2 — the main event
│       │   ├── Queue.tsx              # screen 3
│       │   └── Settings.tsx           # screen 4
│       └── components/
│           ├── MiniMap.tsx            # SVG Summoner's Rift, plots moments at map coords
│           ├── Timeline.tsx           # scrubber; click a time -> seek everything
│           ├── FeedbackCard.tsx       # one coaching item, links to time + media + map
│           ├── MediaViewer.tsx        # <video> w/ Range seeking; screenshot lightbox
│           ├── MetricRow.tsx          # value + band vs personal baseline
│           ├── Scoreboard.tsx
│           └── JobBadge.tsx           # live job state from SSE
│
├── public/
│   └── assets/                        # champion icons, item icons, rift map SVG
│
└── .research/
    └── stack-daemon.md                # this document
```

### 9.1 `package.json`

```jsonc
{
  "name": "fawnsei",
  "private": true,
  "type": "module",
  "engines": { "node": ">=25" },
  "scripts": {
    "dev": "concurrently -n web,daemon -c cyan,magenta \"pnpm dev:web\" \"pnpm dev:daemon\"",
    "dev:web": "vite",
    "dev:daemon": "node --experimental-strip-types --no-warnings=ExperimentalWarning --watch-path=src/daemon --watch-path=src/lcu src/daemon/main.ts",
    "daemon": "node --experimental-strip-types --no-warnings=ExperimentalWarning src/daemon/main.ts",
    "build": "vite build",
    "start": "NODE_ENV=production pnpm daemon",
    "doctor": "node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/doctor.ts",
    "db:migrate": "node --experimental-strip-types --no-warnings=ExperimentalWarning src/db/index.ts --migrate",
    "service:install": "bash scripts/install-service.sh",
    "service:uninstall": "bash scripts/uninstall-service.sh",
    "service:logs": "journalctl --user -u fawnsei -f",
    "service:restart": "systemctl --user restart fawnsei",
    "typecheck": "tsc --noEmit",
    "test": "node --experimental-strip-types --test src/**/*.test.ts"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.3.258",
    "@hono/node-server": "^2.1.1",
    "arktype": "^2.2.3",
    "hono": "^4.13.5",
    "react": "^19.2.8",
    "react-dom": "^19.2.8"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^6.1.1",
    "concurrently": "^9",
    "typescript": "^5.9",
    "vite": "^8.2.2"
  }
}
```

All dependency versions above are the ones pnpm actually resolved on this machine today.
`--watch-path` is scoped to `src/daemon` and `src/lcu` so editing analysis or web code does not
bounce a running capture.

---

## 10. UX — four screens

### 10.1 Game list

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ fawnsei          ● LCU connected   ● 2 jobs running      [Settings] [Queue]│
├────────────────────────────────────────────────────────────────────────────────┤
│  Filter: [All ▾] [Ranked Solo ▾] [Last 30 days ▾]          Search: [________]  │
├────────────────────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────────────────────┐  │
│ │ ◆ Lillia · Jungle          W  38:30   today 18:52   Ranked Solo          │  │
│ │   7/4/12   CS 187 (4.9/m)   VS 34   DMG 24%                              │  │
│ │   ▸ Review ready · 4 items  ⚑2 major                        [Review →]   │  │
│ └──────────────────────────────────────────────────────────────────────────┘  │
│ ┌──────────────────────────────────────────────────────────────────────────┐  │
│ │ ◇ Kindred · Jungle         L  21:07   today 18:32   Ranked Solo          │  │
│ │   2/8/3    CS 96  (4.5/m)   VS 19   DMG 14%                              │  │
│ │   ◷ Reviewing…  ▓▓▓▓▓▓░░░░              ⧗ replay 22m left    [Review →]   │  │
│ └──────────────────────────────────────────────────────────────────────────┘  │
│ ┌──────────────────────────────────────────────────────────────────────────┐  │
│ │ ◇ Lillia · Jungle          W  26:25   today 18:06                        │  │
│ │   5/2/9    CS 142 (5.4/m)   VS 28   DMG 21%                              │  │
│ │   ⏸ Capture deferred — you're in champ select        [Capture now]        │  │
│ └──────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────┘
```
Row states come straight from SSE. The `⧗ replay 22m left` countdown makes the 30-minute
expiry visible instead of mysterious, and `⏸ Capture deferred — <gate_reason>` explains exactly
why nothing is happening, which is the difference between "the app is broken" and "the app is
being polite".

### 10.2 Game review — the main screen

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ ← Games   Lillia · Jungle · Win · 38:30 · Ranked Solo · 16.17     [Re-review ↻]│
├──────────────────────────────────┬─────────────────────────────────────────────┤
│  MAP                             │  FEEDBACK                      4 items      │
│  ┌────────────────────────────┐  │  ┌───────────────────────────────────────┐ │
│  │        ╱‾‾‾‾‾‾‾‾‾‾╲        │  │  │ ⚑ MAJOR · Vision        08:12  ▶ clip │ │
│  │      ╱   ✕14:02    ╲       │  │  │ Warded into a fogged raptor camp      │ │
│  │    ╱  ●08:12        ╲      │  │  │ with no team nearby. Enemy jungler    │ │
│  │   │      ◆21:40      │     │  │  │ was last seen top 20s earlier.        │ │
│  │   │   ✕19:33         │     │  │  │ [Jump to 08:12] [Show on map]         │ │
│  │    ╲        ●27:15  ╱      │  │  └───────────────────────────────────────┘ │
│  │      ╲            ╱        │  │  ┌───────────────────────────────────────┐ │
│  │        ╲________╱          │  │  │ ⚑ MAJOR · Macro        19:33  ▶ clip  │ │
│  └────────────────────────────┘  │  │ Cross-mapped to a 900g raptor camp    │ │
│  ✕ death  ● ward  ◆ objective    │  │  while Baron spawned in 40s.          │ │
│  [x] deaths [x] objectives       │  │  [Jump to 19:33] [Show on map]        │ │
│                                  │  └───────────────────────────────────────┘ │
├──────────────────────────────────┤  ┌───────────────────────────────────────┐ │
│  MEDIA                           │  │ ○ minor · Laning       04:20          │ │
│  ┌────────────────────────────┐  │  │ First clear ended 18s later than your │ │
│  │  ▶  clip-1173000-1191000   │  │  │ 20-game average.                      │ │
│  │     19:33 gank attempt     │  │  │ [Jump to 04:20]                       │ │
│  │  ├──────●───────────────┤  │  │  └───────────────────────────────────────┘ │
│  └────────────────────────────┘  │                                            │
├──────────────────────────────────┴─────────────────────────────────────────────┤
│ TIMELINE                                                                        │
│ 0    5    10   15   20   25   30   35  38:30                                   │
│ ├────┼────┼────┼────┼────┼────┼────┼───┤                                       │
│ │    ✕    ⚑●   ✕    ⚑◆   ✕      ●    ◆ │   ← click anywhere to seek            │
│ │  ▁▂▃▃▄▅▅▄▃▄▅▆▆▇▇▆▅▆▇███  gold diff   │                                       │
├────────────────────────────────────────────────────────────────────────────────┤
│ METRICS      CS@14 112 ▲good   GD@15 +340 ▲good   VS/min 0.88 ▼low             │
│              Deaths 4 ●avg     DMG share 24% ●avg  KP 61% ▲good                │
└────────────────────────────────────────────────────────────────────────────────┘
```

**The linking model — one shared cursor.** A `t_ms` value is the single piece of shared state on
this page. Clicking a feedback card, a map marker, or a point on the timeline sets the cursor,
and all four panels react: the map highlights markers within ±30 s, the timeline scrubs, the
media panel loads the clip whose `[t_start_ms, t_end_ms]` contains the cursor (seeking via HTTP
Range, which is verified working), and the matching feedback card scrolls into view and
highlights. That single bidirectional binding is what makes the page feel like a coaching tool
rather than four widgets stacked vertically.

Feedback cards with no media still work — `[Jump to 08:12]` moves the cursor and the map/timeline
respond. This matters because **media capture is the least certain part of the build** (§7.8);
the review page must be fully useful with zero clips.

### 10.3 Queue / activity

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Queue                                          [Pause all] [Capture now]       │
├────────────────────────────────────────────────────────────────────────────────┤
│ RUNNING                                                                        │
│  ◷ review.claude      Kindred 18:32    ▓▓▓▓▓▓░░░░  42s    [Cancel]            │
│                                                                                │
│ DEFERRED                                                                       │
│  ⏸ replay.capture     Lillia 18:06                                            │
│    Waiting: you're in ChampSelect. Needs None/Lobby for 2 min.  [Capture now]  │
│                                                                                │
│ QUEUED                                                                         │
│  ○ analysis.run       Lillia 18:52                                            │
│  ○ replay.download    Kindred 18:32     ⧗ expires in 22m                      │
│                                                                                │
│ RECENT                                                                         │
│  ✓ match.ingest       Lillia 18:52      1.2s                                  │
│  ✗ replay.download    Ashe   14:58      expired — replay older than 30 min    │
└────────────────────────────────────────────────────────────────────────────────┘
```
This screen exists mainly to make deferral legible. `gate_reason` rendered verbatim answers
"why is nothing happening" without a log dive.

### 10.4 Settings

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Settings                                                                       │
├────────────────────────────────────────────────────────────────────────────────┤
│ REPLAY CAPTURE                                                                 │
│  [ ] Enable automatic replay capture          ⚠ takes over your game client    │
│      Only when idle for   [2] minutes                                          │
│      Only between         [never ▾] and [never ▾]                              │
│      Max capture time     [10] minutes                                         │
│                                            [Test capture now (supervised)]     │
│                                                                                │
│ REVIEW                                                                         │
│  Model            [claude-sonnet-4-5 ▾]                                        │
│  Auto-review      [x] every ranked game   [ ] normals   [ ] ARAM               │
│  Focus areas      [x] laning [x] vision [x] macro [ ] mechanics                │
│                                                                                │
│ DATA                                                                           │
│  Data directory   ~/.local/share/fawnsei          17 MB json · 1 replay   │
│  Keep replays for [14] days                            [Prune now]             │
│  Telemetry        [x] sample live game data (adds item build timings)          │
│                                                                                │
│ DAEMON                                                                         │
│  Status           ● running · pid 13886 · up 2h14m                             │
│  League client    ● connected · port 50924                                     │
│  Bridge           ● node.exe · ws open · 1,204 events                          │
│                                       [Restart daemon] [View logs] [Doctor]    │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## 11. What I could not verify

| Claim | Status |
|---|---|
| Request bodies for `POST .../download` and `.../watch` | **UNVERIFIED** — routes proven to exist (405), never called |
| In-game Replay API (`/replay/playback`, `/render`, `/recording`, `/sequence`) | **UNVERIFIED** — 404 during a live game, only mounts during replay playback |
| Whether the client can record video itself | **UNVERIFIED** — depends on the above; verify first, it would remove the OBS dependency |
| OBS websocket control | **UNVERIFIED** — DLL installed, OBS not running, port 4455 closed |
| Gameflow phases other than `InProgress` / `EndOfGame` | **UNVERIFIED** — the rest is the conventional set; gate fails closed on unknowns |
| systemd user unit starting on Windows login | **UNVERIFIED** — needs a WSL restart to test; would have interrupted the user's game |
| Whether Windows can reach a WSL-listening port | **UNVERIFIED** — not needed; stdio is proven |
| `.rofl` chunk/keyframe payloads | Opaque binary; require the game engine. **Confirmed by the independent decoder in `rofl-format.md`** |
| `.rofl` trailing JSON stat block | **VERIFIED by `rofl-format.md` / `rofl2.mjs`** — usable offline fallback for end-of-game stats |
| Behaviour across a League patch | Untestable today; this is why ArkType at the boundary matters |

---

## 12. Recommended build order

1. `db/` + migrations + `shared/schema/` (ArkType) — the foundation everything asserts against.
2. `lcu/lockfile.ts` + `lcu/bridge/bridge.mjs` + `bridge-client.ts` — prove the transport, with
   `curl-fallback.ts` behind it.
3. `daemon/supervisor.ts` + `reconcile.ts` — connect, survive restarts, backfill history.
4. `jobs/match-ingest.ts` — get real data on disk. **First useful milestone.**
5. `server/app.ts` + `web/pages/GameList.tsx` — see the data. Second milestone.
6. `analysis/` + `jobs/analysis-run.ts` — metrics and moments.
7. `review/` + `jobs/review-claude.ts` — reviews land. **Third milestone: the app is useful here.**
8. `web/pages/GameReview.tsx` with map + timeline, media-free.
9. `daemon/telemetry.ts` — start capturing live data early; it is the only unrecoverable source.
10. `jobs/replay-download.ts` — with the 30-minute deadline.
11. **Spike** the replay/capture path (§7.8) supervised, then `replay-capture.ts` + `media-encode.ts`.
12. `Settings.tsx`, `Queue.tsx`, `doctor.ts`, systemd install scripts.

Steps 1–9 have no unverified dependencies. All of the genuine risk is concentrated in step 11,
which is deliberately last and which the app is useful without.
