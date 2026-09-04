# Replay capture pipeline — In-game Replay API, Live Client Data API, launch/capture state machine

**Research date:** 2026-09-02
**Patch on this machine:** `16.17.810.4348` (Content `16.17.8104348+branch.releases-16-17.content.release`)
**Install root (Win):** `C:\Games\Riot Games\League of Legends` → (WSL) `/mnt/c/Games/Riot Games/League of Legends`
**Game binary:** `Game/League of Legends.exe`, 34,736,568 bytes.
**Authenticity:** the binary is genuinely Riot-signed, so every string quoted below is shipped Riot code, not a mod.

```
$ powershell.exe -NoProfile -Command "Get-AuthenticodeSignature 'C:\Games\Riot Games\League of Legends\Game\League of Legends.exe' | Format-List Status,SignerCertificate"
Status            : Valid
StatusMessage     : Signature verified.
SignerCertificate : CN="Riot Games, Inc.", O="Riot Games, Inc.", L=Los Angeles, S=California, C=US
                    Issuer: CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1
```

## Evidence labels used throughout

| Label | Meaning |
|---|---|
| **[VERIFIED-LIVE]** | Executed against the running client/game during this research; real output pasted. |
| **[VERIFIED-BINARY]** | Read out of the signed shipped binary (`strings` + `xxd` at a byte offset). Field names/enums are exact; *semantics* are Riot's own doc-strings. |
| **[UNVERIFIED-NEEDS-RUNTIME-TEST]** | Could not be executed — the Replay API only exists while a replay is playing, and the hard rule forbade launching one. |

> **Important context for anyone reading this later:** during this research the user was *in a live ranked game*
> (`gameflow-phase: "InProgress"`, gameId `5633902080`). That was lucky — it let me verify the port-2999 transport
> and the entire Live Client Data API for real. It also means every `/replay/*` probe correctly returned 404,
> because the Replay API is **not** registered outside replay playback (proven below).

---

# 0. The one-paragraph answer

Screenshot/clip capture works like this: the LCU (`:<lockfile port>`) launches `League of Legends.exe` with a
`.rofl` path on its command line. That game process opens an HTTPS server on `127.0.0.1:2999` which, **only during
replay playback**, exposes `/replay/playback` (seek), `/replay/render` (camera + HUD), and `/replay/recording`
(codec `webm` | `png` | `pngAndDepth`). A screenshot is `POST /replay/recording` with `codec: "png"` and
`startTime == endTime + tiny epsilon`; a clip is the same with `codec: "webm"` over a few seconds. Timeline
coordinates from `/lol-match-history/v1/game-timelines/{gameId}` are raw engine world coordinates on the ground
plane (verified range `x ∈ [130, 14589]`, `y ∈ [135, 14673]` for Summoner's Rift), and map onto the render API's
`cameraPosition` (a `Vector3f` `{x,y,z}` where the middle component is height). WSL2 cannot reach `:2999` natively
— every request must go through `curl.exe` Windows interop. And it cannot run while the user is in a game: one
client, one game process, exclusive.

---

# 1. Transport: the WSL2 problem (SOLVED, verified)

## 1.1 Why native WSL2 fails

`League of Legends.exe` binds `2999` to the **Windows loopback only**:

```
$ /mnt/c/WINDOWS/system32/netstat.exe -ano | grep 2999
  TCP    127.0.0.1:2999         0.0.0.0:0              LISTENING       16536

$ /mnt/c/WINDOWS/system32/tasklist.exe /FI "IMAGENAME eq League of Legends.exe"
League of Legends.exe        16536 Console                    1  1,037,084 K
```
**[VERIFIED-LIVE]** — same PID owns the socket and the game.

WSL2 is a separate network namespace, so its `127.0.0.1` is not Windows' `127.0.0.1`:

```
$ curl -sk -m 5 -o /dev/null -w "HTTP=%{http_code} err=%{errormsg}\n" https://127.0.0.1:2999/liveclientdata/gamestats
HTTP=000 err=Failed to connect to 127.0.0.1 port 2999 after 0 ms: Connection refused

$ node -e "fetch('https://127.0.0.1:2999/liveclientdata/gamestats').then(...).catch(e=>console.log('ERR',e.cause?.code))"
ERR ECONNREFUSED
```
**[VERIFIED-LIVE]**

## 1.2 The working transport

`curl.exe` runs as a *Windows* process via WSL interop, so it sees Windows loopback:

```bash
/mnt/c/WINDOWS/system32/curl.exe -sk "https://127.0.0.1:2999/liveclientdata/allgamedata"
# HTTP 200, 28,936 bytes
```
**[VERIFIED-LIVE]** — note `-k`: the game serves a self-signed cert. **No auth is needed on 2999** (unlike the LCU
on the lockfile port, which needs `-u riot:<password>`).

## 1.3 Interop cost, and how to make it cheap

```
$ time (for i in $(seq 10); do curl.exe -sk -o /dev/null https://127.0.0.1:2999/liveclientdata/gamestats; done)
real 0m0.875s                      # ≈ 87 ms per invocation

$ curl.exe -sk -o /dev/null -w "connect=%{time_connect} total=%{time_total}\n" .../gamestats
connect=0.001092 total=0.020424    # the HTTP part is only ~20 ms
```
So ~67 ms of that is Windows process-spawn overhead. **Batch multiple URLs into one `curl.exe` invocation** —
verified to work and roughly 2× cheaper:

```
$ curl.exe -sk -w '%{url}\t%{http_code}\t%{time_total}\n' -o /dev/null URL1 \
           -w '...' -o /dev/null URL2  -o /dev/null URL3
https://127.0.0.1:2999/liveclientdata/gamestats   200  0.032773
https://127.0.0.1:2999/liveclientdata/eventdata   200  0.010267
https://127.0.0.1:2999/liveclientdata/playerlist  200  0.012478
real 0m0.127s
```
**[VERIFIED-LIVE]**

**Recommendation for the build phase.** Do *not* poll at 10 Hz through one-shot `curl.exe`. Either
(a) batch, as above, or (b) run a tiny persistent Windows-side helper (`node.exe` invoked through interop, or
`curl.exe -K -` reading a stream of request configs from stdin) that stays alive for the length of one capture
session. `curl.exe` POST bodies work the same way (`-X POST -H "Content-Type: application/json" -d @file`) —
**[UNVERIFIED-NEEDS-RUNTIME-TEST]** only because the hard rule forbade any POST, not because there is any doubt.

**Do not** try `netsh interface portproxy` / binding `0.0.0.0`: the ground truth already established that the
Windows host IP `172.19.144.1` times out from WSL (firewall), so exposing the port more widely doesn't help
without a firewall rule change we should not make.

## 1.4 Path translation

```
$ wslpath -u 'C:/Users/ssalb/Documents/League of Legends/Replays'
/mnt/c/Users/ssalb/Documents/League of Legends/Replays
$ wslpath -w '/mnt/c/Users/ssalb/Documents'
C:\Users\ssalb\Documents
```
**[VERIFIED-LIVE]** — every path *sent to* the game/LCU must be a Windows path; every path *read by* the Node app
must be `/mnt/c/...`. Use `wslpath -w` / `wslpath -u` rather than hand-rolled string munging.

---

# 2. The in-game HTTP API on `127.0.0.1:2999`

## 2.1 It is self-describing — fetch the OpenAPI doc

This is the single most valuable finding for the build phase: the game client ships a live Swagger/OpenAPI
generator. **[VERIFIED-LIVE]**

| Path | Status (live game) | Bytes |
|---|---|---|
| `/swagger/v3/openapi.json` | 200 | 26,883 |
| `/swagger/v2/swagger.json` | 200 | 24,636 |
| `/swagger/v1/api-docs` | 200 | small (group index) |
| `/help` and `/Help` | 200 | 3,613 |
| `/swagger/v1/swagger.json`, `/swagger` | 404 | — |

```json
// GET /swagger/v1/api-docs   (during a LIVE GAME)
{"apis":[{"path":"/async"},{"path":"/swagger"},{"path":"/base"},{"path":"/liveclientdata"}],
 "info":{"description":"League of Legends Game Client","title":"LoLClient"},"swaggerVersion":"1.2"}
```

Note there is **no `/replay` group**. Confirmed by direct probe during the live game:

```
GET /replay/playback   -> 404 {"errorCode":"RESOURCE_NOT_FOUND","httpStatus":404,"message":"Invalid URI format"}
GET /replay/render     -> 404  (same)
GET /replay/recording  -> 404  (same)
GET /replay/sequence   -> 404  (same)
GET /replay/game       -> 404  (same)
GET /replay/particles  -> 404  (same)
```
**[VERIFIED-LIVE].** The Replay API handlers are registered only in replay mode.

> **ACTION FOR THE RUNTIME-VERIFICATION PHASE:** the very first thing to do once a replay is playing is
> `curl.exe -sk https://127.0.0.1:2999/swagger/v3/openapi.json > replay-openapi.json`. That document will contain
> the **complete, authoritative** `/replay/*` paths, request bodies, response schemas, types, defaults and
> min/max constraints — everything marked UNVERIFIED in this document, resolved in one request. Also grab
> `/swagger/v1/api-docs` to confirm the `/replay` group appears.

The OpenAPI doc already exposes the shared value types, which the Replay API reuses:

```json
"Vector3f": {"description":"3D vector","type":"object",
             "properties":{"x":{"type":"number","format":"float"},
                           "y":{"type":"number","format":"float"},
                           "z":{"type":"number","format":"float"}}}
"Vector2f": {"x","y"}          "Vector4f": {"w","x","y","z"}
"Color":    {"a","b","g","r"}  (integers)
"TeamID":   enum ["UNKNOWN","ORDER","CHAOS","NEUTRAL"]
```
**[VERIFIED-LIVE]** — so `cameraPosition`, `cameraRotation`, `sunDirection`, `selectionOffset` are `{x,y,z}` floats
and `depthFogColor`/`heightFogColor` are `{r,g,b,a}` 0–255 ints.

## 2.2 The Replay API surface, recovered from the signed binary

All endpoint paths and every field name below are **[VERIFIED-BINARY]** — extracted from
`Game/League of Legends.exe` around file offset `28,077,000–28,079,500`. Descriptions are Riot's own doc-strings,
copied verbatim.

### Endpoints

| Path | Methods | Riot's description |
|---|---|---|
| `/replay/game` | GET | "Information about the game client process." |
| `/replay/playback` | GET, POST | GET: "Returns the current replay playback state such as pause and current time." POST: "Allows modifying the playback state such as play / pause and the game time to seek to. **All values are optional.**" |
| `/replay/render` | GET, POST | GET: "Returns the current render properties." POST: "Allows modifying the current render properties. **All values are optional.**" |
| `/replay/sequence` | GET, POST | GET: "Returns the sequence currently being applied." POST: "Post to apply a sequence of keyframes that the replay should play. **Post an empty object to remove the sequence.**" |
| `/replay/recording` | GET, POST | GET: "Returns the current status of video recording. **Poll this resource for progress on the output.**" POST: "Post to begin a recording specifying the codec and output filepath. Subsequent GET requests to this resource will update the status." |
| `/replay/particles` | GET, POST | "Returns map of particle name to current visibility status." / "Takes a map of particle name to visibility and applies it to the currently rendering particles." |
| `/replay/banners` | GET, POST | Esports Banners — **marked DEPRECATED in the binary**. Ignore. |
| `/replay/objects` | GET | **Not in Riot's public docs.** "Returns the live game objects currently in the replay." |
| `/replay/objects/visibility` | GET, POST | **Not in Riot's public docs.** "Returns the map of object netId to visibility for objects hidden via the Replay API." / "Takes a map of object netId to visibility (false hides the object). Hidden objects are re-applied every frame so the replay stream cannot turn them back on." |
| `/replay/events` | GET | **Not in Riot's public docs.** "Returns the replay's pre-indexed look-ahead moment events (kills, objectives, multikills, etc)." |

The last three are new in this build and are **highly relevant to this app** — see §5.

### `Game` — `GET /replay/game`
| Field | Type | Riot description |
|---|---|---|
| `processID` | int | "Process identifier for this game" |

### `Playback` — `GET`/`POST /replay/playback`
| Field | Type | Riot description |
|---|---|---|
| `paused` | bool | "True if the replay is paused" |
| `seeking` | bool | "True if the replay is fast forwarding or rewinding" |
| `time` | float | "Current time of the replay in seconds since the beginning of the game." |
| `length` | float | "Total length of the replay in seconds" |
| `speed` | float | "Replay playback speed (0.5 is half speed, 2.0 is double speed etc)" |

> Byte-level note: `time` and `length` are string-pooled elsewhere in the binary (they are common words), so the
> hexdump shows the description immediately followed by the next description. The names are Riot's documented
> ones and the ordering is unambiguous. Confirm against the runtime OpenAPI doc.

Raw evidence:
```
$ off=$(grep -abo "True if the replay is paused" "Game/League of Legends.exe" | head -1 | cut -d: -f1)
$ dd if=... bs=1 skip=$off count=400 | xxd
00000000: 5472 7565 2069 6620 7468 6520 7265 706c  True if the repl
00000010: 6179 2069 7320 7061 7573 6564 0000 0000  ay is paused....
00000020: 7061 7573 6564 0000 5472 7565 2069 6620  paused..True if
...
00000060: 7365 656b 696e 6700 ...                  seeking.
00000070: 4375 7272 656e 7420 7469 6d65 206f 6620  Current time of
...
000000b0: 546f 7461 6c20 6c65 ...                  Total le[ngth]
000000e0: 5265 706c 6179 2070 6c61 7962 6163 6b20  Replay playback
00000120: ...  7370 6565 6400                      speed
```

### `Render` — `GET`/`POST /replay/render`

Camera:
| Field | Type | Riot description |
|---|---|---|
| `cameraMode` | `HudCameraMode` enum | "Camera movement mode such as first person or third person" |
| `cameraPosition` | `Vector3f` | "Position of the camera in world coordinates" |
| `cameraRotation` | `Vector3f` | "Rotation of the camera in Euler degrees (yaw, pitch, roll)" |
| `cameraAttached` | bool | "True if the camera is attached to an object in the game" |
| `cameraLockX` / `cameraLockY` / `cameraLockZ` | bool | "Lock FPS Camera at x/y/z axis" |
| `cameraMoveSpeed` | float | "Movement speed of the camera (higher is faster)" |
| `cameraLookSpeed` | float | "Mouse look speed of the camera when in FPS mode (higher is faster)" |
| `fieldOfView` | float | "Camera field of view in degrees (**default 45**)" |
| `nearClip` / `farClip` | float | "Near/Far camera clipping distance" |

Selection (this is the "look at this champion" mechanism — see §5):
| Field | Type | Riot description |
|---|---|---|
| `selectionName` | string | "Sets the selection to the given name, **case insensitive**" |
| `selectionOffset` | `Vector3f` | "Sets the camera location to the selection's location adding the given offset" |

Scene toggles:
| Field | Type | Riot description |
|---|---|---|
| `outlineSelect` | bool | "Display outlines on champions when selected" |
| `outlineHover` | bool | "Display outlines on champions when the mouse is hovered over" |
| `floatingText` | bool | "Display text notifications over the top of champions" |
| `fogOfWar` | bool | "Display fog of war" |
| `navGridOffset` | float | "Adjusts the height that champions and minions walk over the environment" |
| `simulateAllParticlesWhileOffScreen` | bool | "Simulates all particles while they off screen. Enabling this will impact performance." |
| `environment` | bool | "Display the level environment" |
| `characters` | bool | "Display characters" |
| `champions` | bool | "Display champions" |
| `minions` | bool | "Display minions" |
| `particles` | bool | "Display particles" |
| `banners` | bool | "Display banners on the map" |
| `healthBarChampions` / `healthBarStructures` / `healthBarWards` / `healthBarPets` / `healthBarMinions` | bool | "Display health bars on champions / structure and towers / wards / champion pets / minions" |

Interface toggles (all bool):
`interfaceAll` ("Display all of the user interface"), `interfaceReplay` ("the replay HUD with camera options"),
`interfaceScore` ("the replay score interface (top of the window)"), `interfaceScoreboard` ("(bottom of the
window)"), `interfaceFrames` ("the champion frames (sides of the window)"), `interfaceMinimap` ("(bottom right
corner)"), `interfaceTimeline` ("(bottom of the window)"), `interfaceChat`, `interfaceTarget` ("the target
selection window"), `interfaceQuests`, `interfaceAnnounce` ("game announcements (center of the window)"),
`interfaceKillCallouts`, `interfaceNeutralTimers` ("neutral objective timers").

Skybox / sun:
`skyboxPath` (string — "Filepath for a cube mapped skybox in **DDS** format"; a placeholder string
`<path to cubemap on local file system>` sits next to it in the binary), `skyboxRotation` (float, degrees Y),
`skyboxRadius`, `skyboxOffset`, `sunDirection` (`Vector3f`, "Vector indicating the direction of the sun for shadows").

Fog:
`depthFogEnabled` (bool), `depthFogStart`, `depthFogEnd`, `depthFogIntensity` ("opacity from 0.0 to 1.0"),
`depthFogColor` (`Color` RGBA 0–255); `heightFogEnabled`, `heightFogStart` ("Vertical height at the start of the
fog"), `heightFogEnd`, `heightFogIntensity`, `heightFogColor`.

Depth of field:
`depthOfFieldEnabled`, `depthOfFieldDebug` ("Render a debug display to visualize depth of field distances"),
`depthOfFieldCircle` ("Adjusts the shape and strength of the blur effect"), `depthOfFieldWidth` ("Distance around
the middle point that should be in focus"), `depthOfFieldNear` ("Closest distance from the camera in full blur"),
`depthOfFieldMid` ("Distance to the center of the depth of field effect, the point that will be the most in
focus"), `depthOfFieldFar` ("Furthest distance from the camera in full blur").

### `HudCameraMode` enum — **[VERIFIED-BINARY], partially**

```
00000030: 4875 6443 616d 6572 614d 6f64 6500 0000  HudCameraMode...
00000040: 546f 7020 646f 776e 2063 616d 6572 6100  Top down camera.
00000050: 4669 7273 7420 7065 7273 6f6e 2063 616d  First person cam
00000060: 6572 6100 6670 7300 5468 6972 6420 7065  era.fps.Third pe
00000070: 7273 6f6e 2063 616d 6572 6100 7470 7300  rson camera.tps.
00000080: 466f 6375 7320 6361 6d65 7261 0000 0000  Focus camera....
00000090: 666f 6375 7300 0000 5061 7468 2066 6f6c  focus...Path fol
000000a0: 6c6f 7769 6e67 2063 616d 6572 6100 0000  lowing camera...
```
Exactly verified values: **`fps`** (First person), **`tps`** (Third person), **`focus`** (Focus).
The values for "Top down camera" and "Path following camera" are pooled elsewhere (short common words) —
they are almost certainly `top` and `path` but that is **[UNVERIFIED-NEEDS-RUNTIME-TEST]**; read them off the
runtime OpenAPI enum.

### `Recording` — `GET`/`POST /replay/recording` — **this is the capture mechanism**

| Field | Type | Riot description |
|---|---|---|
| `recording` | bool | "True if we are currently recording a replay" |
| `path` | string | "File path or directory where the recording should be saved" |
| `codec` | `AVContainer` enum | "Indicates the output format of the recording (for example webm or png)" |
| `startTime` | float | "Game time in seconds where the recording starts" |
| `endTime` | float | "Game time in seconds where the recording ends" |
| `currentTime` | float | "Current time of the recording, indicating progress of the render" |
| `width` | int | "Width of the output video in pixels (**same as the game window size**)" |
| `height` | int | "Height of the output video in pixels (**same as the game window size**)" |
| `framesPerSecond` | int | "Target number of frames per second to record in the video" |
| `enforceFrameRate` | bool | "True if the recording should match the target frames per second exactly by **slowing down the recording if required**" |
| `lossless` | bool | "True if the recording is being output in a lossless codec (no compression)" |
| `replaySpeed` | float | "Playback speed used when recording" |

### `AVContainer` (codec) enum — **[VERIFIED-BINARY], exact**

```
000000b0: 4156 436f 6e74 6169 6e65 7200 ...        AVContainer.
000000c0: 5650 3820 656e 636f 6465 6420 7669 6465  VP8 encoded vide
000000d0: 6f20 696e 202e 7765 626d 2066 6f72 6d61  o in .webm forma
000000e0: 7400 0000 7765 626d 0000 0000 0000 0000  t...webm........
000000f0: 466f 6c64 6572 206f 6620 7261 7720 504e  Folder of raw PN
00000100: 4720 6669 6c65 732c 206f 6e65 2066 696c  G files, one fil
00000110: 6520 7065 7220 6672 616d 6500 706e 6700  e per frame.png.
00000120: 466f 6c64 6572 206f 6620 7261 7720 504e  Folder of raw PN
00000130: 4720 6669 6c65 732c 206f 6e65 2066 696c  G files, one fil
          ...  "one file for color and one file for depth per frame" -> pngAndDepth
```

| Value | Meaning |
|---|---|
| `webm` | "VP8 encoded video in .webm format" |
| `png` | "Folder of raw PNG files, **one file per frame**" |
| `pngAndDepth` | "Folder of raw PNG files, one file for color and one file for depth per frame" |

> ⚠️ **Correction to the assignment premise: there is no `jpg` codec in patch 16.17.** Only `webm`, `png`,
> `pngAndDepth`. Also note `png` writes a **folder** of frames, not a single file — so a "screenshot" is
> a one-frame render into a directory, and the app must then pick the single PNG out of that directory.
> **[VERIFIED-BINARY]** (the hexdump above is exhaustive for that enum block — there is no fourth value).

### `Sequence` — `GET`/`POST /replay/sequence`

A keyframe-animation system. Keyframe value types: `KeyFrameBool`, `KeyFrameFloat`, `KeyFrameColor`,
`KeyFrameVector3`, `KeyFrameAString`. Blending is an `EasingType`:

`linear, snap, smoothStep, smootherStep, quadraticEaseIn/Out/InOut, cubicEaseIn/Out/InOut,
quarticEaseIn/Out/InOut, quinticEaseIn/Out/InOut, sineEaseIn/Out/InOut, circularEaseIn/Out/InOut,
exponentialEaseIn/Out/InOut, elasticEaseIn/Out/InOut, backEaseIn/Out/InOut, bounceEaseIn/Out/InOut`
("Blending options for interpolating time between keyframes"). **[VERIFIED-BINARY], exhaustive.**

Available tracks (each described as "Keyframe track for X"):
`playbackSpeed` (→ `Playback.speed`), and for `Render`: `cameraPosition`, `cameraRotation`, `fieldOfView`,
`nearClip`, `farClip`, `navGridOffset`, `skyboxRotation`, `skyboxRadius`, `skyboxOffset`, `sunDirection`,
`depthFogEnabled`, `depthFogStart`, `depthFogEnd`, `depthFogIntensity`, `depthFogColor`, `heightFogEnabled`,
`heightFogStart`, `heightFogEnd`, `heightFogIntensity`, `heightFogColor`, `depthOfFieldEnabled`,
`depthOfFieldCircle`, `depthOfFieldWidth`, `depthOfFieldNear`, `depthOfFieldMid`, `depthOfFieldFar`,
`selectionName`, `selectionOffset`.

**Note what is *not* animatable:** `cameraMode`, `cameraAttached`, `fogOfWar`, and every `interface*` /
`healthBar*` toggle. Those must be set with a plain `POST /replay/render` before recording starts.

The exact JSON envelope of a sequence (probably `{"cameraPosition":[{"time":..,"blend":"linear","value":{...}},...]}`)
is **[UNVERIFIED-NEEDS-RUNTIME-TEST]**.

### `/replay/objects` — undocumented, and the best camera-targeting source

Query params **[VERIFIED-BINARY]**:
- `types` — "Optional comma-separated types to include (**hero,minion,monster,turret,ward,generic**). Omit for all."
- `detail` — "Optional; when true include **health, maxHealth, level, skinID and stealth**."

Response field names, from the hexdump at `28,077,896 − 700`:
```
00000230: 6d6f 6e73 7465 7200 7761 7264 0000 0000  monster.ward....
00000240: 6e65 7449 6400 0000 6368 6172 6163 7465  netId...characte
00000250: 724e 616d 6500 0000 6e61 6d65 4861 7368  rName...nameHash
00000270: 6469 7265 6374 696f 6e00 ...             direction
00000280: 626f 756e 6469 6e67 426f 7800            boundingBox
00000280: 616c 6976 6500 0000 6865 616c 7468 0000  alive...health
00000290: 7374 6561 6c74 6800 6f62 6a65 6374 7300  stealth.objects
```
→ objects carry `netId`, `characterName`, `nameHash`, `position`, `direction`, `boundingBox`, `alive`, `health`,
`stealth` (+ `maxHealth`, `level`, `skinID` under `detail=true`), wrapped in `objects`.
**This gives live world coordinates for every champion at the current replay time — far better than guessing from
the 60-second-granularity match timeline.**

### `/replay/events` — undocumented, pre-indexed moments

"Returns the replay's pre-indexed look-ahead moment events (kills, objectives, multikills, etc)."
Field names in the same block: `kind`, `moment`, `teamId`, `fromNameHash`, `toNameHash`, `fromCharacterName`,
`toCharacterName`, `displayable`, `spawn`. **[VERIFIED-BINARY]** — shapes/semantics
**[UNVERIFIED-NEEDS-RUNTIME-TEST]**. If this works as it reads, it is the cheapest possible "find the interesting
moments" source and should be sampled first thing in the runtime-verification phase.

### `/replay/objects/visibility`

`POST` a map of `netId → bool`. "Hidden objects are **re-applied every frame so the replay stream cannot turn
them back on**." Useful for decluttering a coaching screenshot (hide minions, hide the enemy you're not
discussing). GET returns the current `visibility` map.

---

# 3. Live Client Data API on `:2999` — fully verified

Unlike `/replay/*`, this is registered in **both** live games and replays. Everything in this section was
executed against the running game. **[VERIFIED-LIVE]**

## 3.1 Endpoints (from `GET /swagger/v3/openapi.json`, live)

```
GET /liveclientdata/activeplayer            "Get all data about the active player"
GET /liveclientdata/activeplayerabilities    "Get Abilities for the active player"
GET /liveclientdata/activeplayername         "Returns the player name"
GET /liveclientdata/activeplayerrunes        "Retrieve the full list of runes for the active player"
GET /liveclientdata/allgamedata              "Get all available data"                 [?eventID=<int32>]
GET /liveclientdata/eventdata                "Get a list of events that have occurred in the game"
                                             query: eventID (int32) = "ID of the next event you expect to see"
GET /liveclientdata/gamestats                "Basic data about the game"
GET /liveclientdata/playeritems              "Retrieve the list of items for the player"
GET /liveclientdata/playerlist               "Retrieve the list of heroes in the game and their stats"
                                             query: teamID ("Optional, returns all players on all teams if null")
GET /liveclientdata/playermainrunes          "Retrieve the basic runes of any player"
GET /liveclientdata/playerscores             "Retrieve the list of the current scores for the player"
GET /liveclientdata/playersummonerspells     "Retrieve the list of the summoner spells for the player"
```
Per-player endpoints take `riotId` = "RiotID GameName (with tag) of the player in the format `Name#TAG`".

## 3.2 Real payloads

`GET /liveclientdata/gamestats`:
```json
{"gameMode":"CLASSIC","gameTime":421.5574951171875,"mapName":"Map11","mapNumber":11,"mapTerrain":"Default"}
```

`GET /liveclientdata/allgamedata` top-level keys: `["activePlayer","allPlayers","events","gameData"]`.

`allPlayers[i]` keys (10 entries):
```
championName, isBot, isDead, items[], level, position, rawChampionName, rawSkinName, respawnTimer,
riotId, riotIdGameName, riotIdTagLine, runes{keystone,primaryRuneTree,secondaryRuneTree},
scores{kills,deaths,assists,creepScore,wardScore}, skinID, skinName, summonerName,
summonerSpells{summonerSpellOne,summonerSpellTwo}, team
```
Real example (trimmed):
```json
{"championName":"Mordekaiser","isBot":false,"isDead":false,
 "items":[{"canUse":false,"consumable":false,"count":1,"displayName":"Doran's Helm","itemID":1120,
           "price":450,"rawDescription":"GeneratedTip_Item_1120_Description",
           "rawDisplayName":"Item_1120_Name","slot":0}, ...],
 "level":7,"position":"TOP","respawnTimer":0.0,
 "riotId":"GALACTIC TOP GAP#1996","riotIdGameName":"GALACTIC TOP GAP","riotIdTagLine":"1996",
 "scores":{"assists":0,"creepScore":40,"deaths":0,"kills":1,"wardScore":0.75},
 "skinID":6,"skinName":"Dark Star Mordekaiser","team":"ORDER"}
```

> 🚨 **`position` here is the LANE ROLE (`"TOP"`), not a world coordinate.** The Live Client Data API returns
> **no x/y positions at all** — verified by dumping every key of `playerlist` and `activeplayer`. Anyone who
> assumes otherwise will waste a day. World coordinates come from `/replay/objects` (during replay) or the LCU
> match timeline (60 s granularity).

`activePlayer` keys: `abilities`, `championStats`, `currentGold`, `fullRunes`, `level`, `riotId`,
`riotIdGameName`, `riotIdTagLine`, `summonerName`, `teamRelativeColors`.
`championStats` has 31 fields: `abilityHaste, abilityPower, armor, armorPenetrationFlat,
armorPenetrationPercent, attackDamage, attackRange, attackSpeed, bonusArmorPenetrationPercent,
bonusMagicPenetrationPercent, critChance, critDamage, currentHealth, healShieldPower, healthRegenRate,
lifeSteal, magicLethality, magicPenetrationFlat, magicPenetrationPercent, magicResist, maxHealth, moveSpeed,
omnivamp, physicalLethality, physicalVamp, resourceMax, resourceRegenRate, resourceType, resourceValue,
spellVamp, tenacity`.
`abilities` is keyed `Passive, Q, W, E, R` with `{abilityLevel, displayName, id, rawDescription, rawDisplayName}`.

## 3.3 `eventdata` — the second source of truth for timestamps

```json
{"Events":[
 {"EventID":0,"EventName":"GameStart","EventTime":0.0302887000143528},
 {"EventID":1,"EventName":"MinionsSpawning","EventTime":30.04764175415039},
 {"EventID":2,"EventName":"ChampionKill","EventTime":194.72872924804688,
  "KillerName":"xxXLouvAXxx","VictimName":"AbiDabi","Assisters":["Ghostexe","Diablo0310"]},
 {"EventID":3,"EventName":"FirstBlood","EventTime":194.72872924804688,"Recipient":"xxXLouvAXxx"},
 {"EventID":8,"EventName":"DragonKill","EventTime":3..,"DragonType":"Air","Assisters":[...]}
]}
```
**[VERIFIED-LIVE].** `EventTime` is **seconds, float**, on the same clock as `Playback.time` — this is what makes
it the calibration source for seeking (§6.4).

Complete `EventName` set, **[VERIFIED-BINARY]** — this is a contiguous string block, dumped in full so you can
trust it is exhaustive:

```
$ off=$(grep -abo "MinionsSpawning" "Game/League of Legends.exe" | head -1 | cut -d: -f1)
$ dd if=... bs=1 skip=$((off-120)) count=560 | xxd
00000020: 4576 656e 7454 696d 65 ..    EventTime
00000030: 4576 656e 744e 616d 65 ..    EventName
00000040: 4761 6d65 456e 6400 5769 6e00 4c6f 7365  GameEnd.Win.Lose
00000050: ..  4e65 6974 6865 7200                  Neither
00000060: 4576 656e 7473 0000 4761 6d65 5374 6172  Events..GameStar
00000070: 7400 ..  4d69 6e69 6f6e 7353             t..MinionsS
00000080: 7061 776e 696e 6700 4368 616d 7069 6f6e  pawning.Champion
00000090: 4b69 6c6c 0000 0000 5669 6374 696d 4e61  Kill....VictimNa
000000a0: 6d65 ..  4b69 6c6c 6572 4e61             me..KillerNa
000000b0: 6d65 ..  4d75 6c74 696b 696c             me..Multikil
000000c0: 6c00 ..  4b69 6c6c 5374 7265             l..KillStre
000000d0: 616b ..  4472 6167 6f6e 4b69             ak..DragonKi
000000e0: 6c6c 0000 5374 6f6c 656e 0000 4661 6c73  ll..Stolen..Fals
000000f0: 6500 ..  4472 6167 6f6e 5479             e..DragonTy
00000100: 7065 ..  486f 7264 654b 696c             pe..HordeKil
00000110: 6c00 ..  4865 7261 6c64 4b69             l..HeraldKi
00000120: 6c6c ..  4261 726f 6e4b 696c             ll..BaronKil
00000130: 6c00 ..  5265 6369 7069 656e             l..Recipien
00000140: 7400 0000 4163 6500 4163 6572 0000 0000  t...Ace.Acer....
00000150: 4163 696e 6754 6561 6d00                 AcingTeam
00000160: 496e 6869 624b 696c 6c65 6400             InhibKilled
00000170: 496e 6869 6252 6573 7061 776e 696e 6753  InhibRespawningS
00000180: 6f6f 6e00 ..  496e 6869 6252 6573        oon.....InhibRes
00000190: 7061 776e 6564 0000 5475 7272 6574 4b69  pawned..TurretKi
000001a0: 6c6c 6564 0000 0000 4669 7273 7442 7269  lled....FirstBri
000001b0: 636b ..  4173 7369 7374 6572             ck......Assister
000001c0: 7300                                      s.
```

`EventName` values: `GameStart, MinionsSpawning, ChampionKill, Multikill, KillStreak, DragonKill, HordeKill,
HeraldKill, BaronKill, Ace, TurretKilled, InhibKilled, InhibRespawningSoon, InhibRespawned, FirstBrick, GameEnd`.
`FirstBlood` was observed live but is pooled elsewhere in the binary (offsets 27,619,539 / 27,619,554 /
27,835,842), so treat this list as near-exhaustive rather than exhaustive.

Associated fields: `EventID, EventName, EventTime, KillerName, VictimName, Assisters, Recipient, Stolen
("False"/…), DragonType, Acer, AcingTeam, Result (Win | Lose | Neither, on GameEnd)`.

## 3.4 Known limitation during replays

The binary contains two explicit refusal strings **[VERIFIED-BINARY]**:
- `"Spectator mode and replay mode don't currently support this feature"`
- `"Spectator mode doesn't currently support this feature"`

They sit in the Live Client Data handler block next to `activePlayer`/`championStats`. Expect
`/liveclientdata/activeplayer*` to be **degraded or unavailable during replay playback** (there is no single
"active player" in a replay). `playerlist`, `gamestats` and `eventdata` should still work.
**[UNVERIFIED-NEEDS-RUNTIME-TEST]** — verify which endpoints degrade, first thing.

---

# 4. Launching a replay programmatically (the LCU side)

## 4.1 Verified LCU state, right now

```
$ IFS=':' read -r name pid port pass proto < ".../League of Legends/lockfile"
name=LeagueClient pid=6456 port=50924 proto=https

GET /lol-replays/v1/configuration            -> 200
{"gameVersion":"16.17.810.4348","isInTournament":false,"isLoggedIn":true,"isPatching":false,
 "isPlayingGame":true,"isPlayingReplay":false,"isReplaysEnabled":true,
 "isReplaysForEndOfGameEnabled":true,"isReplaysForMatchHistoryEnabled":true,
 "minServerVersion":"","minutesUntilReplayConsideredLost":30}

GET /lol-replays/v1/rofls/path                -> 200  "C:/Users/ssalb/Documents/League of Legends/Replays"
GET /lol-replays/v1/rofls/path/default        -> 200  "C:/Users/ssalb/Documents/League of Legends/Replays"
GET /lol-replays/v1/metadata/5631300987       -> 200  {"downloadProgress":0,"gameId":5631300987,"state":"watch"}
GET /lol-gameflow/v1/watch                    -> 200  "None"
GET /lol-gameflow/v1/gameflow-phase           -> 200  "InProgress"
GET /lol-gameflow/v1/extra-game-client-args   -> 200  []
GET /data-store/v1/install-settings/gameflow-process-info -> 200
{"pid":16536,"rawArgs":["192.207.0.5 7097 MxBklUCfMslHhIVsRenRzg== 122474706","-Product=LoL",
 "-PlayerID=122474706","-GameID=5633902080","-PlayerNameMode=ALIAS","-LNPBlob=gcidDpxIU3s="],
 "standalone":false}
GET /lol-highlights/v1/highlights-folder-path -> 200  "C:/Users/ssalb/Documents/League of Legends/Highlights"
GET /lol-highlights/v1/config                 -> 200
{"invalidHighlightNameCharacters":"<>:\"/\\|?*","isHighlightsEnabled":true}
```
All **[VERIFIED-LIVE]**. Note `isPlayingGame: true` — that single boolean is the gate you must respect (§8).

## 4.2 The POST endpoints (existence verified, bodies from the client's own type registry)

A `GET` on a POST-only LCU path returns `405 WRONG_METHOD` rather than `404`, which proves the route exists
without side effects:

```
GET /lol-replays/v1/rofls/5631300987/watch -> 405 {"errorCode":"WRONG_METHOD","httpStatus":405,...}
GET /lol-replays/v1/rofls/scan             -> 405 (same)
GET /lol-gameflow/v1/watch/launch          -> 405 (same)
```
**[VERIFIED-LIVE].**

The request/response types come from `GET /help?format=Full` on the LCU (3,087,751 bytes; 1,468 functions,
3,614 types) — the client's own binding registry. **[VERIFIED-LIVE]**

| HTTP | Function name in `/help` | Body | Returns |
|---|---|---|---|
| `GET /lol-replays/v1/configuration` | `GetLolReplaysV1Configuration` | — | `LolReplaysReplaysConfiguration` |
| `GET /lol-replays/v1/metadata/{gameId}` | `GetLolReplaysV1MetadataByGameId` | — | `LolReplaysReplayMetadata` |
| `GET /lol-replays/v1/rofls/path` | `GetLolReplaysV1RoflsPath` | — | `string` |
| `GET /lol-replays/v1/rofls/path/default` | `GetLolReplaysV1RoflsPathDefault` | — | `string` |
| `POST /lol-replays/v2/metadata/{gameId}/create` | `PostLolReplaysV2MetadataByGameIdCreate` | `LolReplaysReplayCreateMetadata` | — |
| `POST /lol-replays/v1/rofls/{gameId}/download` | `PostLolReplaysV1RoflsByGameIdDownload` | `LolReplaysReplayContextData` | — |
| `POST /lol-replays/v1/rofls/{gameId}/download/graceful` | `...DownloadGraceful` | `LolReplaysReplayContextData` | — |
| `POST /lol-replays/v1/rofls/{gameId}/watch` | `PostLolReplaysV1RoflsByGameIdWatch` | `LolReplaysReplayContextData` | — |
| `POST /lol-replays/v1/rofls/scan` | `PostLolReplaysV1RoflsScan` | — | — |
| `GET /lol-gameflow/v1/watch` | `GetLolGameflowV1Watch` | — | `LolGameflowGameflowWatchPhase` |
| `POST /lol-gameflow/v1/watch/launch` | `PostLolGameflowV1WatchLaunch` | `vector<string>` (`args`) | `object` |
| `GET/POST /lol-gameflow/v1/extra-game-client-args` | `Get/PostLolGameflowV1ExtraGameClientArgs` | `vector<string>` | — |

Types:
```
LolReplaysReplaysConfiguration {
  isReplaysEnabled: bool; isReplaysForEndOfGameEnabled: bool; isReplaysForMatchHistoryEnabled: bool;
  isPatching: bool; isInTournament: bool; isPlayingGame: bool; isPlayingReplay: bool; isLoggedIn: bool;
  gameVersion: string; minServerVersion: string; minutesUntilReplayConsideredLost: int32 }

LolReplaysReplayMetadata      { state: LolReplaysMetadataState; gameId: uint64; downloadProgress: uint32 }
LolReplaysReplayContextData   { componentType: string }
LolReplaysReplayCreateMetadata{ gameVersion: string; gameType: string; queueId: int32; gameEnd: uint64 }
LolReplaysRoflFileMetadata    { gameLength: uint32; gameVersion: string; lastGameChunkId: uint32; lastKeyFrameId: uint32 }
LolReplaysInstallPaths        { gameInstallRoot: string; gameExecutablePath: string }
LolReplaysReplaysSettingsData { "replays-folder-path": string; "highlights-folder-path": string }

LolReplaysMetadataState  ENUM: checking, download, downloading, error, found, incompatible, lost,
                               missingOrExpired, retryDownload, unsupported, watch
LolGameflowGameflowWatchPhase ENUM: None, WatchStarted, WatchInProgress, WatchFailedToLaunch
LolGameflowGameflowPhase ENUM: None, Lobby, Matchmaking, ReadyCheck, ChampSelect, GameStart, InProgress,
                               Reconnect, WaitingForStats, PreEndOfGame, EndOfGame, FailedToLaunch,
                               TerminatedInError, CheckedIntoTournament
```
**[VERIFIED-LIVE]** (all read out of the running client's `/help` registry).

`componentType` is **telemetry only** — the client logs `"Plugin handling Replay '%llu' player action, WATCH,
componentType=%s"` and never branches on it. Any non-empty string works. **[VERIFIED-BINARY]** (from
`LeagueClient.exe` strings). Suggested value: `"fawnsei"`.

## 4.3 How the game itself is told it's a replay

From `Game/League of Legends.exe` **[VERIFIED-BINARY]**, in the command-line-parsing string pool
(`strings` lines 954,160–954,190):
```
{:5s}| {#channel!} Command Line: {CommandLine}
.rofl
%s:%s
Failed to extract information from command line string for spectator mode
Failed to extract information from command line string for normal game mode
-GameID   -PlayerID   -PlatformID   -RemotingPort   -LNPBlob   -PlayerNameMode
-ReplayReplicaHostname   -ReplayReplicaPort   -LeagueDirectorSkyboxPath   -SpectatorKey   -TargetPuuid
EnableReplayApi
ReplayApiPreserveParticleZSetting
Command line does not have correct number of parameters
```
and elsewhere:
```
{:5s}| {#channel!} Replay overriding current working directory: {:%s}
{:5s}| {#channel!} Replay filepath: {ReplayFilePath:%s}
```

**Conclusion:** the game enters replay mode when an argument ending in `.rofl` is present on its command line.
It also changes its working directory for a replay. `POST /lol-gameflow/v1/watch/launch` takes exactly a
`vector<string>` of such args, so it is the low-level lever.

**Two launch paths, in order of preference:**

1. **`POST /lol-replays/v1/rofls/{gameId}/watch`** with body `{"componentType":"fawnsei"}`.
   Let the client build the args. Safest, matches what the UI does, gets you the client's own guard rails and
   error reporting. **Use this by default.**
2. **`POST /lol-gameflow/v1/watch/launch`** with a hand-built `["<abs windows path>.rofl", "-GameBaseDir=...",
   "-Region=NA", "-PlatformID=NA1", "-Locale=en_US", "-SkipBuild", ...]`. Total control over args (window mode,
   remoting port), but you must reproduce the arg list correctly. **[UNVERIFIED-NEEDS-RUNTIME-TEST]** — in
   particular the exact positional form and whether the rofl path is arg[0].

For reference, the real arg vector for a *normal* game on this machine (from the r3dlog, **[VERIFIED-LIVE]**):
```
"192.207.0.5 7097 MxBklUCfMslHhIVsRenRzg== 122474706" "-Product=LoL" "-PlayerID=122474706"
"-GameID=5633902080" "-PlayerNameMode=ALIAS" "-LNPBlob=gcidDpxIU3s="
"-GameBaseDir=C:\Games\Riot Games\League of Legends" "-Region=NA" "-PlatformID=NA1" "-Locale=en_US"
"-SkipBuild" "-EnableCrashpad=true" "-RiotClientPort=50924" "-RiotClientAuthToken=Lwkz5_5xJDE3PdwOVN-2VQ"
```
The first positional slot carries connection info for a live game; for a replay it carries the `.rofl` path.

## 4.4 `EnableReplayApi` — the one real unknown in the launch path

`EnableReplayApi` and `ReplayApiPreserveParticleZSetting` sit in the *command-line* string pool
(file offset `28,005,544`), immediately after `-TargetPuuid`, **without a leading dash**:
```
000000f0: 2d54 6172 6765 7450 7575 6964 0000 0000  -TargetPuuid....
00000100: 456e 6162 6c65 5265 706c 6179 4170 6900  EnableReplayApi.
00000110: 5265 706c 6179 4170 6950 7265 7365 7276  ReplayApiPreserv
00000120: 6550 6172 7469 636c 655a 5365 7474 696e  eParticleZSettin
00000130: 6700 ...                                 g.
```
They are **not** in the `Game.cfg` key pool (which lives around offset 28.41 M — verified: `EnableAudio` at
28,415,640; `EnableDirectedCamera` at 28,419,048; `ShowReplayScoreboard` at 28,419,072). They are also absent
from `Config/PersistedSettings.json` (whose `Game.cfg` sections are only
`Accessibility, Chat, ColorPalette, FloatingText, General, HUD, ItemShop, LossOfControl, Performance, Replay,
TFTChat, TFTHUD, Voice, Volume`) and absent from `LeagueClient.exe` entirely (`grep -c EnableReplayApi` → 0).

So: **it is a game-side toggle read in the bootstrap/command-line path, and I could not determine its source.**
**[UNVERIFIED-NEEDS-RUNTIME-TEST].** Test plan, in order:
1. Launch a replay normally. `GET /replay/playback`. If 200 → nothing to do, the API is on by default. **Most likely outcome.**
2. If 404 → `POST /lol-gameflow/v1/extra-game-client-args ["-EnableReplayApi=true"]`, relaunch.
3. If still 404 → add `EnableReplayApi=1` under `[General]` in `Config/Game.cfg` (back up first), relaunch.

Related: the client also reads `/lol-platform-config/v1/namespaces/GameClientCmdLineToggles`
(**[VERIFIED-BINARY]** string in `LeagueClient.exe`), a *server-driven* extra-args mechanism. It is currently
absent:
```
GET /lol-platform-config/v1/namespaces/GameClientCmdLineToggles
-> 404 {"errorCode":"RPC_ERROR","message":"Could not find the namespace \"GameClientCmdLineToggles\""}
GET /lol-platform-config/v1/namespaces/Replays
-> 200 {"MinutesUntilReplayConsideredLost":30}
```
**[VERIFIED-LIVE].** Worth re-checking at build time — if Riot ever populates it, it can flip flags out from
under you.

Two more flags worth knowing, both **[VERIFIED-BINARY]** in the game binary's flag table:
- `-LeagueDirectorSkyboxPath` — Riot ships first-class support for the League Director tool. Strong evidence the
  Replay API is intended to be driven by external tooling on retail clients.
- `-RemotingPort` — the game's HTTP API port (default 2999) is settable. Only usable via path (2) above.
- `-GameCfgName` — overrides which config file is read (default `Game.cfg`; also `Input.ini`, and
  `/Config/` + `/Logs/` + `/Screenshots/` are sibling dirs of the base dir). This is the lever for §7.

---

# 5. Camera control: pointing at the right thing

## 5.1 The coordinate space, measured

`GET /lol-match-history/v1/game-timelines/5631300987` (86,794 bytes, 32 frames). **[VERIFIED-LIVE]**

```
frames: 32
frame timestamps: [0, 60026, 120058, 180132, 240162, ...] last = 1849761   (ms, ~1/min)
event types: {CHAMPION_KILL: 68, ELITE_MONSTER_KILL: 10, BUILDING_KILL: 13}
position x range: 130 .. 14589        position y range: 135 .. 14673      (n = 411 samples)
frame 0, participant 1: {"position":{"x":603,"y":611}, "currentGold":500, "level":1, "xp":0, ...}
sample CHAMPION_KILL: {"type":"CHAMPION_KILL","timestamp":104058,"killerId":1,"victimId":6,
                       "assistingParticipantIds":[],"position":{"x":3680,"y":13435}, ...}
```

Cross-check that the timeline clock is the game clock:
```
GET /lol-match-history/v1/games/5631300987
-> {"gameId":5631300987,"gameDuration":1849,"gameVersion":"16.17.810.4348","gameMode":"CLASSIC",
    "gameType":"MATCHED_GAME","queueId":400,"mapId":11,"gameCreation":1788056544103}
last timeline frame timestamp = 1849761 ms = 1849.76 s ≈ gameDuration 1849 s   ✓
```
**[VERIFIED-LIVE].** So:

- Timeline `position.{x,y}` are **raw engine world coordinates on the ground plane**, spanning ~0–14,800 for
  Summoner's Rift (blue-side fountain at `(603, 611)`, red-side kills up at `y≈13435`).
- Timeline `timestamp` is **milliseconds since game start**, the same clock as `gameDuration`,
  Live Client Data `EventTime` (seconds), and Replay `Playback.time` (seconds).
  → **`Playback.time = timeline.timestamp / 1000`.**

## 5.2 Mapping to `Render.cameraPosition`

`cameraPosition` is a `Vector3f` `{x, y, z}` (**[VERIFIED-LIVE]** from the OpenAPI `Vector3f` schema). League's
engine uses **Y-up**: the binary's own descriptions separate ground-plane movement from height
(`heightFogStart` = "Vertical height at the start of the fog"; `navGridOffset` = "Adjusts the **height** that
champions and minions walk over the environment").

Therefore the expected mapping is:

```
timeline (x, y)  ->  cameraPosition { x: timeline.x,  y: <camera height>,  z: timeline.y }
```

with `cameraRotation = {x: pitch, y: yaw, z: roll}` in Euler **degrees** ("Rotation of the camera in Euler
degrees (yaw, pitch, roll)" — note Riot's prose order is yaw,pitch,roll but the struct is x,y,z; the binding of
prose-order to component-order is **[UNVERIFIED-NEEDS-RUNTIME-TEST]**).

**The whole axis mapping is [UNVERIFIED-NEEDS-RUNTIME-TEST]** and is the single highest-value thing to calibrate
first. It is also *trivially* calibratable at runtime, and the calibration procedure needs no guesswork:

> **Calibration recipe.** Start a replay, let it play in the default directed camera, then
> `GET /replay/render` repeatedly and `GET /replay/objects?types=hero&detail=true` at the same instant. The
> camera is following a champion; compare `cameraPosition` against that champion's `position`. Two or three
> samples settle the axis order, the sign conventions, and the default camera height/pitch that the game's own
> in-replay camera uses. **Store those measured numbers in the repo** — they are the thing you tune against,
> and they should be re-derivable.

## 5.3 Two ways to aim, and which to use

**(a) `selectionName` — the robust one.** `Render.selectionName` "Sets the selection to the given name, case
insensitive" and `Render.selectionOffset` "Sets the camera location to the selection's location adding the given
offset". Set `selectionName` to a champion and the camera follows them; `selectionOffset` becomes your framing
(e.g. `{x:0, y:1400, z:-900}` for a raised, tilted-back view). **This is the right primitive for "show me what
Gooskaffur was doing at 14:32"** because it survives the target moving during a clip, needs no coordinate math,
and is animatable via `/replay/sequence` (`selectionName` and `selectionOffset` are both keyframe tracks).

What string does it want? `/replay/objects` returns `characterName` and `nameHash` per object
(**[VERIFIED-BINARY]**), so the reliable flow is: `GET /replay/objects?types=hero` → find the object whose
`characterName` matches your target's champion → feed that value to `selectionName`. Whether `selectionName`
matches on champion name, summoner name, or object name is **[UNVERIFIED-NEEDS-RUNTIME-TEST]**; the `/replay/objects`
round-trip removes the guesswork.

**(b) Absolute `cameraPosition` + `cameraRotation`** with `cameraMode: "fps"` (or top-down) — needed when the
moment of interest is a *place*, not a person (a warded bush, an objective pit, a ward you should have placed).
Feed it `timeline` coordinates through the §5.2 mapping.

**Practical rule for the coaching app:** for "what happened in this fight", use `selectionName` on the champion
plus a wide `fieldOfView` and a high `selectionOffset` so the whole fight is in frame. For "you should have been
here", use absolute position on the map coordinate.

## 5.4 Turning the picture into a *coaching* picture

The render API is unusually good at this, and these are all just booleans in one `POST /replay/render`:
- `fogOfWar: false` — show what the enemy was doing that you couldn't see. **This is the killer feature for
  coaching** and is the one thing a normal replay watcher cannot get.
- `interfaceAll: false`, then re-enable only what matters (`interfaceMinimap`, `interfaceScore`) for a clean shot.
- `healthBarChampions: true`, `healthBarMinions: false` — declutter.
- `outlineSelect: true` with `selectionName` — puts a visible outline on the champion being discussed.
- `POST /replay/objects/visibility {netId: false}` — hide minions/irrelevant champions entirely.
- `depthOfFieldEnabled: true` with `depthOfFieldMid` at the subject — draws the eye.

---

# 6. The capture state machine

## 6.1 Preconditions (all checkable, all verified reachable)

| Check | Endpoint | Required value |
|---|---|---|
| Client running | `lockfile` exists & parses | `LeagueClient:PID:PORT:PASSWORD:https` |
| Not in a game | `GET /lol-replays/v1/configuration` | `isPlayingGame: false` |
| Not already in a replay | same | `isPlayingReplay: false` |
| Replays enabled | same | `isReplaysEnabled && isReplaysForMatchHistoryEnabled` |
| Not patching | same | `isPatching: false` |
| Logged in | same | `isLoggedIn: true` |
| Not in a tournament | same | `isInTournament: false` |
| Gameflow idle | `GET /lol-gameflow/v1/gameflow-phase` | `"None"` (or `"Lobby"`) — **never** `InProgress`, `ChampSelect`, `Matchmaking`, `ReadyCheck`, `GameStart`, `Reconnect` |
| No watch running | `GET /lol-gameflow/v1/watch` | `"None"` |
| Rofl available | `GET /lol-replays/v1/metadata/{gameId}` | `state: "watch"` |
| Patch match | compare `configuration.gameVersion` major.minor vs the rofl's | equal |

## 6.2 States

```
IDLE
 └─ preconditions pass ──> ENSURE_ROFL
        GET /lol-replays/v1/metadata/{gameId}
          state == "watch"                        -> READY
          state in (download, retryDownload)      -> POST /lol-replays/v1/rofls/{gameId}/download/graceful
                                                     then poll metadata; state -> downloading (downloadProgress 0..100)
                                                     -> found/watch -> READY
          state == "checking"                     -> poll
          state == "found"                        -> POST .../v2/metadata/{gameId}/create if needed, then READY
          state in (missingOrExpired, lost,
                    incompatible, unsupported,
                    error)                        -> FAIL (see 6.5)
 READY
 └─ POST /lol-replays/v1/rofls/{gameId}/watch  {"componentType":"fawnsei"}
        -> LAUNCHING
 LAUNCHING
 └─ poll GET /lol-gameflow/v1/watch  every 500 ms
        "WatchStarted"       -> process spawning
        "WatchInProgress"    -> game process is up
        "WatchFailedToLaunch"-> FAIL
        stuck at "None" > 20 s -> FAIL (request never took)
 └─ in parallel poll GET https://127.0.0.1:2999/replay/game
        connection refused / 404 -> keep waiting
        200 {"processID":N}      -> API_UP
 API_UP
 └─ (once) GET /swagger/v3/openapi.json  -> cache the real schema
 └─ POST /replay/render {interfaceAll:false, fogOfWar:false, outlineSelect:true, ...}
 └─ POST /replay/playback {"paused":true, "speed":1.0, "time": <target-2.0>}
 └─ poll GET /replay/playback until  seeking == false  &&  |time - target| < 0.2
        -> POSITIONED
 POSITIONED
 └─ aim camera (POST /replay/render {selectionName / cameraPosition / cameraRotation / fieldOfView})
 └─ POST /replay/recording {codec, path, startTime, endTime, framesPerSecond, ...}
 └─ poll GET /replay/recording until recording == false  (currentTime tracks progress toward endTime)
        -> CAPTURED   (files now exist on the Windows filesystem)
 CAPTURED
 └─ more captures for this same gameId?  -> back to API_UP (reuse the process; do NOT relaunch)
 └─ done -> TEARDOWN
 TEARDOWN
 └─ POST /Exit   on :2999                     (see 6.6)
 └─ poll GET /lol-gameflow/v1/watch until "None"  and  GET /lol-replays/v1/configuration isPlayingReplay:false
 └─ IDLE
```

**Batch aggressively.** Launching the client is by far the most expensive step, so the app should collect *all*
the moments it wants from one game, launch once, and seek+capture N times inside a single replay session.

## 6.3 Timing budget

From the r3dlog of a real game launch on this exact machine (GTX 1660 SUPER, DX11, 1920×1080),
**[VERIFIED-LIVE]**:

```
000000.198  Command Line: ...
000000.369  Initializing Renderer
000001.451  DX11 feature level: 11.1
000002.554  Pushing GameSession
000003.597  Pushing LoadingScreen
000004.095  Loading Started
000009.893  Loading Ended
000009.903  Start Main Loop        <-- ~10 s from process start
000010.565  Spawning completed
000064.713  GAMESTATE_SPAWN -> GAMESTATE_GAMELOOP   (the 60 s pregame; a replay skips this)
```
So **~10 s** from game process start to a running main loop. Add the LCU's own work (locating the exe, spawning)
and replay-specific asset/keyframe seeking. **Budget 15–30 s from `POST .../watch` to the Replay API answering**,
and give the wait a 90 s timeout. **[UNVERIFIED-NEEDS-RUNTIME-TEST]** for the replay-specific part — measure it
and record the number.

Seeking cost is separate and probably dominates repeated captures: the engine has to replay chunks forward from
the nearest keyframe. `Playback.seeking` is exactly the flag that tells you when it's done. **Order your capture
list by ascending timestamp** so every seek is a short forward scrub instead of a rewind.

## 6.4 Screenshot vs clip

**Screenshot** — `codec: "png"`, a window just long enough to emit one frame:
```json
POST /replay/recording
{ "codec": "png",
  "path": "C:\\Users\\ssalb\\fawnsei-captures\\g5631300987\\t104058",
  "startTime": 104.058, "endTime": 104.09,
  "framesPerSecond": 30, "replaySpeed": 1.0,
  "enforceFrameRate": true, "lossless": true,
  "width": 1920, "height": 1080 }
```
Remember `png` writes **a folder of frames**, so `path` should be a directory you own, and you then pick the
single (or first) `.png` out of it. Whether `startTime == endTime` produces zero frames or one is
**[UNVERIFIED-NEEDS-RUNTIME-TEST]** — hence the small epsilon above; tune it once at runtime.

**Clip** — `codec: "webm"` (VP8) over the moment:
```json
POST /replay/recording
{ "codec": "webm",
  "path": "C:\\Users\\ssalb\\fawnsei-captures\\g5631300987\\fight-1732.webm",
  "startTime": 98.0, "endTime": 110.0,
  "framesPerSecond": 30, "replaySpeed": 1.0,
  "enforceFrameRate": true, "lossless": false }
```
`enforceFrameRate: true` is important for deterministic output — it "match[es] the target frames per second
exactly by **slowing down the recording if required**", i.e. it trades wall-clock time for a correct file.

Then poll `GET /replay/recording` — "Poll this resource for progress on the output" — watching `currentTime`
climb toward `endTime` and `recording` flip to `false`.

**Time alignment**, restated because it is the thing most likely to silently produce a picture of the wrong
moment:
```
LCU timeline event.timestamp (ms)  /1000  ->  Replay Playback.time (s)  ==  LiveClientData EventTime (s)
```
Verify this once at runtime rather than trusting it: seek to a known `CHAMPION_KILL` timestamp, then read
`/liveclientdata/eventdata` and check that the corresponding `ChampionKill` `EventTime` matches
`Playback.time` within a second. If there is a constant offset (e.g. the ~60 s pregame), you will see it
immediately and can store the correction.

## 6.5 Failure modes

| Symptom | Detection | Meaning / handling |
|---|---|---|
| Replay expired | `metadata.state == "missingOrExpired"` or `"lost"` | Client log: `MetadataStore: update Replay '%llu', state->Lost`; `minutesUntilReplayConsideredLost: 30`. Riot only serves rofls for a limited window. **Handle by downloading rofls eagerly right after every game** — that is the single most important design consequence in this document. |
| Patch mismatch | `metadata.state == "incompatible"` | Client log: `Replay is incompatible due to major-minor version mismatch: rofl=%s game=%s`. **Unfixable.** Old rofls die on patch day. Reinforces "capture early". |
| Server too old | `state == "incompatible"` | `Replay is incompatible due to not meeting min server version. rofl=%s minServerVersion=%s` |
| Client patching | `configuration.isPatching == true` | `No game version found while checking replay compatibility. Client may be patching.` Wait. |
| Rofl not downloadable | `state == "error"` / `"retryDownload"` | `DownloaderSubmodule: server response ERROR, WEB rofl download failed with HTTP status %u` |
| Already watching a replay | — | `Plugin attempted to play replay (%llu) while already playing replay (%llu)` and gameflow `A watch is already running.` Guard with `isPlayingReplay` + `/lol-gameflow/v1/watch`. |
| User in a real game | `isPlayingGame: true` / phase `InProgress` | **Refuse. Queue the work.** (§8) |
| Generic launch refusal | — | `Plugin could not launch Replay '%llu', reason: %s`, `Failed to launch the watch client: %s` |
| Rofl file corrupt | — | Game-side: `Failed to load replay file`, `Replay file empty`, `Replay signature does not match: %s`, `Replay V2 signature failure: %s`, `Error decompressing replay data: %s` |
| Bad launch args | — | Game shows a modal: *"You are trying to open the League of Legends game client in an invalid way…"* and `Command line does not have correct number of parameters`. |
| Game crashed | `/replay/game` stops answering; `Logs/GameCrashes/` gets a new `.run` dir | Treat as FAIL, tear down, retry once. |

All failure strings above are **[VERIFIED-BINARY]** (from `LeagueClient.exe` / `League of Legends.exe`).

## 6.6 Clean exit

`POST /Exit` is a documented endpoint on `:2999` — it appears in the live OpenAPI doc alongside `/Cancel`,
`/Subscribe`, `/Unsubscribe`, `/Help`, `/AsyncDelete`, `/AsyncResult`, `/AsyncStatus`
(**[VERIFIED-LIVE]**, from `paths` in `/swagger/v3/openapi.json`). Whether it cleanly quits a *replay* (as opposed
to being a no-op or being refused) is **[UNVERIFIED-NEEDS-RUNTIME-TEST]**.

Fallbacks, in order:
1. `POST https://127.0.0.1:2999/Exit`
2. LCU: there is no `/lol-gameflow/v1/watch/quit` in the registry (only `/lol-gameflow/v1/spectate/quit`, which is
   for spectating, not replays). **[VERIFIED-LIVE]** from `/help`.
3. `taskkill.exe /PID <processID from /replay/game>` via interop. Blunt but reliable, and the PID comes straight
   from `/replay/game`. Never kill by image name — that would kill a live game.

Whichever you use, **confirm teardown** by polling `GET /lol-gameflow/v1/watch` until `"None"` and
`/lol-replays/v1/configuration` until `isPlayingReplay: false`. A leaked replay process will block the user's
next game and is the worst possible bug for this app.

---

# 7. Where files land, and reading them back

## 7.1 Verified paths

```
replays  : C:/Users/ssalb/Documents/League of Legends/Replays      (GET /lol-replays/v1/rofls/path)
           == default (GET /lol-replays/v1/rofls/path/default)
           WSL: /mnt/c/Users/ssalb/Documents/League of Legends/Replays
           contents: NA1-5631300987.rofl  (14,979,193 bytes)

highlights: C:/Users/ssalb/Documents/League of Legends/Highlights  (GET /lol-highlights/v1/highlights-folder-path)
           ⚠ THIS DIRECTORY DOES NOT EXIST YET on this machine — `ls Documents/League of Legends/` shows only
             `Replays`. The game logs `Failed to create highlights dir '%s'` if it can't make it.

screenshots: <install>/Screenshots/   (F12 in-game; has Screen01.png, Screen02.png) — NOT the Replay API's output
game logs  : <install>/Logs/GameLogs/<ISO timestamp>/{*_r3dlog.txt, *_netlog.txt, *_netstats.csv}
config     : <install>/Config/Game.cfg, Input.ini, PersistedSettings.json
```
**[VERIFIED-LIVE]**

## 7.2 Where a Replay-API recording goes

`Recording.path` is "File path or directory where the recording should be saved" — **you supply it**, so the
default location is mostly irrelevant. **Recommendation: always pass an explicit absolute Windows path** under a
directory the app owns (e.g. `C:\Users\ssalb\fawnsei\captures\<gameId>\<timestamp>`), created from WSL first
via the `/mnt/c` mount, then converted with `wslpath -w`. Then read the results back at `/mnt/c/...`. This
sidesteps the missing `Highlights` dir entirely and keeps captures out of the user's personal folders.

If `path` is omitted, the fallback is presumably the `-HighlightsPath` value (that flag exists in the game binary
at offset 28,032,465, and the client passes `-HighlightsPath=%1` **[VERIFIED-BINARY]**), i.e. the Highlights
folder. **[UNVERIFIED-NEEDS-RUNTIME-TEST]** — don't rely on it.

The separate `[Highlights]` block in `Game.cfg` (`VideoQuality=0, VideoFrameRate=60, ScaleVideo=720,
AudioQuality=1`) governs the in-game **Highlights** feature (the R-key clip recorder), **not** the Replay API —
the Replay API takes `width`/`height`/`framesPerSecond`/`lossless` in the POST body instead. Don't confuse them.

## 7.3 The `.rofl` file itself (ROFL2)

```
$ xxd -l 64 NA1-5631300987.rofl
52 49 4f 54 02 00 | 37 14 cb 24 56 62 63 e2 | 0e | "16.17.810.4348"
| 01 00 00 00 | 02 00 00 00 | 03 | ca 3c 00 00 | 7e 14 00 00 | 28 b5 2f fd ...
  ^^^^^^^^^^^   ^^^^^^^^^^^   ^^   ^^^^^^^^^^^   ^^^^^^^^^^^   ^^^^^^^^^^^ zstd magic @ 0x2E
filesize: 14,979,193
```
**[VERIFIED-LIVE]** (parsed locally). Confirmed: magic `RIOT\x02\x00` = ROFL2; byte at `0x0E` is `0x0E` = 14 =
the length of the `gameVersion` string that follows; the 8 bytes at `0x06` are most likely the "network protocol
digest" the game reads (`Replay V2 could not read network protocol digest`). Everything from `0x2E` is a
**zstd** stream. The exact meaning of the four small integers between the version string and the zstd magic is
**[UNVERIFIED]** — the game's own error strings name the fields it reads in order:
```
Replay V2 could not skip JSON game metadata
Replay V2 could not read network protocol digest
Replay V2 could not read game version size / game version
Replay V2 could not read chunk header / keyframe chunk / data chunk
Replay V2 could not read signature
```
plus an embedded RSA-2048 public key (`-----BEGIN PUBLIC KEY-----MIIBIjANBgkq…`) used for
`Replay V2 signature failure: %s`. **[VERIFIED-BINARY]**

> ⚠️ **Do not try to parse game data out of a ROFL2.** The client itself says so:
> `FileManager: reading metadata from rofl for game '%llu' at path '%s' failed. **ReplayV2s are not expected to
> have this metadata.**` **[VERIFIED-BINARY]**. The JSON stats blob that ROFL1 carried is gone. Get match data
> from `/lol-match-history/v1/games/{gameId}` and `/lol-match-history/v1/game-timelines/{gameId}` instead — both
> already proven working.
>
> Also note the file is **signature-verified against a hardcoded RSA key**. Any thought of editing a rofl,
> stitching one, or synthesizing one is a dead end.

Filename convention: the client parses `^([^-]+)-(\d+)\.rofl$` → `<platformId>-<gameId>.rofl`, and writes
`%s/%s-%llu.rofl`. **[VERIFIED-BINARY]** — so you can enumerate available replays straight off the filesystem
via `/mnt/c/...` without touching the LCU, and `POST /lol-replays/v1/rofls/scan` makes the client re-index them.

---

# 8. Headless / background capture: the honest answer

## 8.1 Can it run while the user plays? **No.**

There is one game client and one game process. `League of Legends.exe` is spawned by the LCU, and the LCU tracks
a single `gameflow-process-info` (`{"pid":16536,...}`). The replay plugin's own guard is
`Plugin attempted to play replay (%llu) while already playing replay (%llu)`, and gameflow's is
`A watch is already running.` / `Game process is running already.` The configuration resource literally exposes
the two booleans you need: `isPlayingGame` and `isPlayingReplay`, and **right now, while the user is in a ranked
game, `isPlayingGame: true`**. **[VERIFIED-LIVE]**

Beyond the client's own locking, a replay is a full 3D render of Summoner's Rift. On this machine that's a
GTX 1660 SUPER at 1920×1080 with `[Performance] ShadowQuality=4 EnvironmentQuality=4 EffectsQuality=4
CharacterQuality=4` — max settings. Running a second instance would visibly cost the user frames in their live
game even if it were technically possible.

**Say this plainly to the user in the product. Do not pretend otherwise.**

## 8.2 Can it at least not steal the screen?

Current state: `Config/Game.cfg` has `[General] WindowMode=2  Width=1920  Height=1080`, and the resulting
r3dlog line is:
```
rr3dRenderLayer::InitDevice(XRes = 1920, YRes = 1080, BPP = 32) PresentMode: Borderless enter
```
**[VERIFIED-LIVE]** — and every one of the 44 game-log sessions on this machine says `PresentMode: Borderless`,
so `WindowMode=2` → Borderless is solid. The values for `0` and `1` are **[UNVERIFIED]**; the binary has a
telemetry enum listing `Fullscreen, Windowed, Borderless` in that order for `settings.windowMode`
(**[VERIFIED-BINARY]**), which does *not* obviously match `0/1/2`. Determine it empirically before relying on it.

Borderless fullscreen is the worst case for the user: it takes the whole screen and steals focus.

**The windowed-replay plan** (**[UNVERIFIED-NEEDS-RUNTIME-TEST]**, but concrete and cheap to test):
1. Copy `Config/Game.cfg` → `Config/CoachSkaffur.cfg`, editing only `[General] WindowMode` (to the windowed
   value) and `Width`/`Height` (e.g. 1280×720, or whatever the capture wants — remember
   `Recording.width/height` is documented as "same as the game window size").
2. `POST /lol-gameflow/v1/extra-game-client-args ["-GameCfgName=CoachSkaffur.cfg"]` before the watch launch, then
   `POST /lol-gameflow/v1/extra-game-client-args []` after, to restore.
3. Or, if extra args are not honoured on the watch path, build the whole arg vector yourself and use
   `POST /lol-gameflow/v1/watch/launch`.

Two open questions for the runtime phase, in priority order:
- **Are `extraGameClientArgs` appended to the *watch* launch, or only to normal game launches?** The registry
  puts `extra-game-client-args` under `lol-gameflow`, and the watch launch also goes through `lol-gameflow`
  (`PostLolGameflowV1WatchLaunch`), so it is plausible — but unproven. **[UNVERIFIED-NEEDS-RUNTIME-TEST]**
- **Does the game render correctly when its window is minimized or occluded?** The binary contains
  `X3D: Focus Gained` and `lol-gameflow.check-window-visibility` and `/riotclient/ux-minimize` /
  `/riotclient/ux-allow-foreground`, which suggests the client actively manages foreground state. Most DX11 games
  throttle or stop presenting when minimized. **Assume minimized rendering does not work until proven.**

**Never touch the user's `Game.cfg` in place.** It is live-edited by the client (it changed under me mid-session:
`[ItemShop] CurrentTab` flipped 1→0 while the user was in game). Use `-GameCfgName` with a separate file, or if
you must edit, back up and restore, and never while the game is running.

## 8.3 The right UX: a queue

```
User finishes a game
  -> app immediately POSTs /lol-replays/v1/rofls/{gameId}/download/graceful   (rofls expire in ~30 min of
     "considered lost" bookkeeping and die outright on patch day — download NOW, always)
  -> app computes the moments worth capturing from the LCU timeline + match data (cheap, no game process)
  -> app enqueues a CaptureJob{gameId, [moments]}
Worker loop:
  every N seconds, check GET /lol-replays/v1/configuration
    isPlayingGame || isPlayingReplay || phase != None  -> sleep, do nothing, surface "queued: 3 games"
    idle                                               -> drain ONE job: launch, seek+capture every moment,
                                                          tear down, verify teardown, then re-check idleness
                                                          before the next job
User starts queueing for a game while a capture is running:
    the app must notice (phase -> Lobby/Matchmaking/ReadyCheck) and ABORT the capture immediately —
    POST /Exit, verify /lol-gameflow/v1/watch == "None". Never make the user wait on us to accept a ready check.
```

Present it honestly in the UI: *"Analysis runs between games. 3 games queued — I'll have them ready next time
you're in the lobby."* That framing is true, and it turns the constraint into a feature.

---

# 9. Runtime-verification checklist (do these in order, with the user watching)

The whole point of this document is that the next phase should not re-derive any of the above. Here is what it
*must* do, and roughly nothing else:

1. Confirm idle: `isPlayingGame:false`, `isPlayingReplay:false`, `gameflow-phase == "None"`, `watch == "None"`.
2. `POST /lol-replays/v1/rofls/5631300987/watch {"componentType":"fawnsei"}`. **Start a stopwatch.**
3. Poll `/lol-gameflow/v1/watch` and `https://127.0.0.1:2999/replay/game`. **Record the time to first 200.**
4. `curl.exe -sk https://127.0.0.1:2999/swagger/v3/openapi.json > .research/replay-openapi.json` and
   `.../swagger/v1/api-docs`. **Commit both.** This resolves every UNVERIFIED schema question at once.
5. `GET /replay/playback`, `/replay/render`, `/replay/recording`, `/replay/sequence`, `/replay/game`,
   `/replay/objects?types=hero&detail=true`, `/replay/events`. **Save every raw response.**
6. Which `/liveclientdata/*` endpoints still work in replay? (Expect `activeplayer*` to fail.)
7. Camera calibration (§5.2): sample `/replay/render.cameraPosition` against `/replay/objects` hero positions
   while the directed camera follows someone. **Store the derived axis mapping and default height/pitch.**
8. Time calibration (§6.4): seek to `timestamp/1000` of a known `CHAMPION_KILL` and check
   `/liveclientdata/eventdata` agrees. **Store any offset.**
9. One `codec:"png"` capture. Confirm: it's a folder; how many files a tiny window yields; the naming scheme.
10. One `codec:"webm"` capture. Confirm duration, fps, file size, and whether `width`/`height` in the POST
    actually override the window size or are read-only.
11. `POST /Exit`. Confirm the process dies and `watch` returns to `"None"`.
12. Only then: try `-GameCfgName` + windowed mode via `extra-game-client-args` (§8.2).

Steps 1–11 are one replay session and should take under ten minutes.

---

# 10. Appendix: reproducible commands

```bash
CURL=/mnt/c/WINDOWS/system32/curl.exe
LOL="/mnt/c/Games/Riot Games/League of Legends"

# --- LCU (needs auth) ---
IFS=':' read -r _ pid port pass _ < "$LOL/lockfile"
$CURL -sk -u "riot:$pass" "https://127.0.0.1:$port/lol-replays/v1/configuration"
$CURL -sk -u "riot:$pass" "https://127.0.0.1:$port/help?format=Full" -o lcu-help.json   # 3.0 MB type registry

# --- Game client on 2999 (NO auth) ---
$CURL -sk "https://127.0.0.1:2999/swagger/v3/openapi.json"
$CURL -sk "https://127.0.0.1:2999/liveclientdata/allgamedata"

# --- static inspection of the signed binary ---
strings -n 3 "$LOL/Game/League of Legends.exe" > s3.txt      # 1,037,517 lines, ~14 s
grep -n "/replay/" s3.txt                                     # the endpoint list
off=$(grep -abo "Top down camera" "$LOL/Game/League of Legends.exe" | head -1 | cut -d: -f1)
dd if="$LOL/Game/League of Legends.exe" bs=1 skip=$((off-64)) count=320 2>/dev/null | xxd
```

> **Use `strings -n 3`, not the default `-n 4`.** With `-n 4` the codec value `png` and the camera mode `fps`/`tps`
> are silently dropped and you will conclude the enums are different than they are. This cost me a pass.
