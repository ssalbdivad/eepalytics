# Coaching analytics layer — specification

**Status:** research complete, evidence-backed. Written 2026-09-02.
**Author:** research subagent. **Subject:** Gooskaffur#NA1 (`puuid 188dee22-18d6-5752-ba7f-b69cf3d2506e`).
**Evidence base:** 22 real ranked-solo games (queueId 420, patch 16.17.810.4348) pulled live from the LCU.
688 timeline frames, 6560 participant-frame position samples, 1928 timeline events, 112 of the
user's own deaths. Every number below was computed from that data unless explicitly labelled
`UNVERIFIED`.

Prototype code that produced every figure here: `.research/analytics-proto/`
(`sr.py` = geometry + role inference, `moments.py` = moment ranker, `heat.py` = heatmap renderer).
Rendered proof: `heat_deaths.png`, `heat_presence.png`, `calib.png`.

---

## 0. TL;DR for the build phase

Ten things that will save you a day each:

1. **The user is a jungler in 22/22 games.** Every "lane phase" metric must be specified
   jungler-first: the "lane opponent" is the *enemy jungler*, and CS means jungle camps.
2. **`participants[].timeline.lane` / `.role` from the LCU are garbage.** In game 5633857616,
   4 of 10 players are labelled `JUNGLE`. Do not use them. Infer roles from positions + Smite.
   Recipe in §2 is 100% well-formed across 22/22 games.
3. **`participantId` 1–5 is always team 100, 6–10 always team 200.** Verified 220/220 participants.
   Frame-0 spawn positions are *byte-identical constants* across all 22 games.
4. **Use the rotated basis `u=(x+y)/2, v=(y−x)/2`.** `u` = blue→red progression (river at
   u≈7420), `v` = lane offset (mid v≈0, side lanes v≈±4750). Proven with 26 turret/pit anchors
   in §1. This makes "own half / enemy half / which lane / river" trivial.
5. **Frames are 1/minute. Median player displacement between frames is 4082 units** (~28% of the
   map). Any "who was standing next to me" claim is soft. Linear interpolation halves the error
   (2871 → 1452 median) and is mandatory, but even then presence detection tops out at ~65%
   sensitivity (§4.3). **Never render position-derived presence as a hard fact.**
6. **`ELITE_MONSTER_KILL.assistingParticipantIds` is corrupt** — 19% of listed assists are on the
   *opposing* team (65/338). `killerId` on the same events *is* reliable (matches
   `teams[].dragonKills` exactly). `BUILDING_KILL` assists are clean (0/310 cross-team).
7. **`neutralMinionsKilledEnemyJungle` / `...TeamJungle` are always 0** in the LCU payload.
   Counter-jungling must be derived from `jungleMinionsKilled` deltas + position (§6.2).
8. **No `ITEM_PURCHASED` events**, but `currentGold` only ever decreases on a purchase, so a
   frame-to-frame drop ≥250g is a proven shop visit. This gives back-timing to ±60s (§3.4).
9. **The timeline clock == `gameDuration` == the Live Client Data API's `gameTime`.** Verified:
   last frame timestamp equals `gameDuration` within 0.00–0.82 s in all 22 games. Screenshot
   timestamps can be handed to the replay in raw seconds.
10. **At n≈20 games, gold-diff@10 has a 95% CI of ±285g around a mean of −224g.** It is *not*
    trendable. §7 says exactly which metrics are and are not.

---

## 1. The Summoner's Rift coordinate system, established empirically

### 1.1 Observed bounds

```
participantFrame positions (n=6560): x ∈ [130, 14589]   y ∈ [135, 14673]
event positions        (n=1928):     x ∈ [481, 14282]   y ∈ [606, 14375]
```

### 1.2 Which corner is which team — proven, not guessed

Frame 0 of every game places each participant at a fixed fountain slot. Across all 22 games each
participantId had **exactly one distinct frame-0 coordinate** (`{1:1, 2:1, … 10:1}` distinct values):

```
pid  1 (0603, 0611)   pid  6 (14103, 14195)
pid  2 (0662, 0285)   pid  7 (14426, 14170)
pid  3 (0362, 0135)   pid  8 (14321, 14673)
pid  4 (0130, 0401)   pid  9 (14589, 14454)
pid  5 (0298, 0675)   pid 10 (14055, 14493)
```

→ **participantId 1–5 = teamId 100 = BLUE = the low-x/low-y (south-west) corner.**
→ **participantId 6–10 = teamId 200 = RED = the high-x/high-y (north-east) corner.**

Cross-checked against `participants[].teamId` in the end-of-game payload: **0 mismatches in
220 participants over 22 games.** Independently cross-checked with `CHAMPION_KILL`: of 1416 kills,
**0** had killer and victim on the same side under this mapping, and **0** assists crossed teams.

### 1.3 Building and pit anchors (exact constants)

`BUILDING_KILL.position` is a hard-coded structure coordinate — the spread across 22 games is
**exactly zero** for every turret except nexus turrets (2 per base). `BUILDING_KILL.teamId` is the
team that **owned** the destroyed building.

| structure | x | y | n |
|---|---|---|---|
| BLUE nexus turrets | 1748/2177 | 1807/2270 | 24 |
| BLUE mid base T | 3651 | 3696 | 12 |
| BLUE mid inner T | 5048 | 4812 | 14 |
| BLUE mid outer T | 5846 | 6396 | 15 |
| BLUE mid inhib | 3210 | 3217 | 15 |
| BLUE top base T | 1169 | 4287 | 5 |
| BLUE top inner T | 1512 | 6699 | 13 |
| BLUE top outer T | 981 | 10441 | 18 |
| BLUE top inhib | 1172 | 3583 | 3 |
| BLUE bot base T | 4281 | 1253 | 8 |
| BLUE bot inner T | 6919 | 1483 | 9 |
| BLUE bot outer T | 10504 | 1029 | 15 |
| BLUE bot inhib | 3468 | 1230 | 9 |
| RED nexus turrets | 12611/13052 | 12612/13084 | 19 |
| RED mid base T | 11134 | 11207 | 9 |
| RED mid inner T | 9767 | 10113 | 11 |
| RED mid outer T | 8955 | 8510 | 16 |
| RED mid inhib | 11593 | 11669 | 13 |
| RED top base T | 10481 | 13650 | 3 |
| RED top inner T | 7943 | 13411 | 6 |
| RED top outer T | 4318 | 13875 | 17 |
| RED top inhib | 11275 | 13657 | 3 |
| RED bot base T | 13624 | 10572 | 5 |
| RED bot inner T | 13327 | 8226 | 11 |
| RED bot outer T | 13866 | 4505 | 17 |
| RED bot inhib | 13599 | 11319 | 7 |

Elite monster pits (mean of `ELITE_MONSTER_KILL.position`, which is where the *kill* landed, so it
has spread):

| monster | n | x mean (range) | y mean (range) |
|---|---|---|---|
| `BARON_NASHOR` | 24 | 5012 (5007–5073) | 10470 (10457–10471) |
| `RIFTHERALD` | 18 | 4806 (4465–5364) | 10111 (9651–10648) |
| `HORDE` (voidgrubs) | 60 | 4835 (4364–5210) | 10233 (9537–10638) |
| `DRAGON` | 90 | 9973 (9731–10735) | 4578 (4397–5304) |

**Baron / Herald / grubs all share the north-west (top) river pit; dragon is the south-east (bot)
river pit.** Standard SR, now proven from this account's own data.

### 1.4 The rotated basis — the single most useful derivation in this document

```
u = (x + y) / 2      // progression along the blue→red diagonal
v = (y - x) / 2      // lane offset: v>0 = TOP side, v<0 = BOT side, v≈0 = MID
```

Applying it to the anchors above:

```
BLUE_NEXUS_T   u=  2000  v=   +38     RED_NEXUS_T   u= 12840  v=    -4
BLUE_MID_OUT   u=  6121  v=  +275     RED_MID_OUT   u=  8732  v=  -222
BLUE_TOP_OUT   u=  5711  v= +4730     RED_TOP_OUT   u=  9096  v= +4778
BLUE_BOT_OUT   u=  5766  v= -4738     RED_BOT_OUT   u=  9186  v= -4680
BLUE_TOP_IN    u=  4106  v= +2594     RED_TOP_IN    u= 10677  v= +2734
BLUE_BOT_IN    u=  4201  v= -2718     RED_BOT_IN    u= 10776  v= -2550
BLUE_*_INHIB   u≈  2350  v= 0/±1150   RED_*_INHIB   u≈ 12460  v= 0/±1150
BARON_PIT      u=  7741  v= +2729     DRAGON_PIT    u=  7276  v= -2698
```

The symmetry is exact to within a few hundred units. Constants that fall out:

```
CENTER_U      = 7420      // (BLUE_NEXUS_T.u + RED_NEXUS_T.u) / 2 = (2000+12840)/2
                          // and both objective pits sit at u = 7276 / 7741, i.e. on the river
MID_V         = 0         // ±275
INNER_V       = ±2650     // inner turrets and both objective pits
OUTER_V       = ±4750     // side-lane outer turrets
INHIB_V       = ±1150
```

Because `u` and `v` are a 45°-rotated, √2-scaled basis, **a real-world perpendicular distance `D`
from the river centreline corresponds to `Δu = D/√2`** — remember the √2 when you turn a band width
in `u` into game units.

**Half of the map** (team-relative):
```
u < CENTER_U → blue half;  u > CENTER_U → red half
own/enemy = compare to my_team
```
Because the dragon pit sits at u=7276 and baron at u=7741 — both effectively *on* the boundary —
a naive binary split misclassifies river fights. Use a **neutral band** of `|u − 7420| < 900`
(≈1270 game units perpendicular). At that setting the user's 112 deaths split
`NEUTRAL 54 / OWN 38 / ENEMY 20`. Tighten the band if you want a starker own/enemy story; report
which band you used.

### 1.5 Lane corridors — polylines, calibrated

Side lanes are L-shaped, so `v` alone does not identify them. Use distance to a polyline built
from the turret anchors:

```ts
const LANE_POLYLINES: Record<Lane, ReadonlyArray<readonly [number, number]>> = {
  TOP: [[1500,1800],[1169,4287],[1512,6699],[981,10441],[1600,12900],
        [4318,13875],[7943,13411],[10481,13650],[12800,12900]],
  MID: [[1962,2038],[3651,3696],[5048,4812],[5846,6396],
        [8955,8510],[9767,10113],[11134,11207],[12843,12836]],
  BOT: [[1800,1500],[4281,1253],[6919,1483],[10504,1029],[12900,1600],
        [13866,4505],[13327,8226],[13624,10572],[12900,12800]],
}
```
(The two corner vertices `[1600,12900]` / `[12900,1600]` and the base ends are interpolated, not
turret-derived; everything else is an exact structure coordinate.)

**Calibration of the corridor half-width.** Using 1400 laning-phase (2:00–9:30) position samples
from players whose role was inferred as a laner, vs 350 samples from inferred junglers:

```
laner distance-to-own-lane:   p50=354  p75=668  p90=1722  p95=2158
jungler distance-to-nearest:  p10=471  p25=1118 p50=1555  p75=2115

threshold   laner inside   jungler inside
   800         0.796           0.149
  1000         0.840           0.194
  1200         0.863           0.303
  1400         0.880           0.440
  2000         0.924           0.680
```

→ **`LANE_HALF_WIDTH = 1100`.** (Note the jungler "false positives" are largely *real* — a jungler
in a lane is ganking. That is a feature, not an error.)

### 1.6 Zone taxonomy

Precedence order matters (a point in mid lane at the river must classify as `LANE_MID`, not river):

```ts
type Zone =
  | 'OWN_BASE' | 'ENEMY_BASE'
  | 'DRAGON_PIT' | 'BARON_PIT'
  | 'LANE_TOP' | 'LANE_MID' | 'LANE_BOT'
  | 'RIVER_TOP' | 'RIVER_BOT'
  | 'OWN_JUNGLE_TOP' | 'OWN_JUNGLE_BOT'
  | 'ENEMY_JUNGLE_TOP' | 'ENEMY_JUNGLE_BOT'

function classifyZone(x: number, y: number, myTeam: 100 | 200): Zone
```

Implementation (verified working, `sr.py::zone`):

```
1. dist to either nexus-turret centroid < BASE_RADIUS (2600)   -> OWN_BASE / ENEMY_BASE
2. dist to DRAGON_PIT (9973,4578)  < PIT_RADIUS (1100)         -> DRAGON_PIT
3. dist to BARON_PIT  (5012,10470) < PIT_RADIUS (1100)         -> BARON_PIT
4. min lane-polyline dist < LANE_HALF_WIDTH (1100)             -> LANE_<TOP|MID|BOT>
5. |u - 7420| < RIVER_HALF_U (900) and |v| < 4200              -> RIVER_<TOP|BOT>  (side = sign(v))
6. otherwise                                                   -> <OWN|ENEMY>_JUNGLE_<TOP|BOT>
```

All five tuning constants (`BASE_RADIUS`, `PIT_RADIUS`, `LANE_HALF_WIDTH`, `RIVER_HALF_U`,
`NEUTRAL_U`) must be exported and configurable; they are calibrated, not physical.

Smoke test output (real):
```
DRAGON  (9973,4578)   -> DRAGON_PIT        BARON  (5012,10470) -> BARON_PIT
GRUBS   (4835,10233)  -> BARON_PIT         map centre (7420,7420) -> LANE_MID
blue base (1500,1600) -> ENEMY_BASE for t200 / OWN_BASE for t100
```

### 1.7 Minimap rendering — mapping verified visually

Minimap image: `https://ddragon.leagueoflegends.com/cdn/16.17.1/img/map/map11.png`
(**verified 200 OK**, 512×512 PNG, 71 611 bytes; also present on every older DDragon version
tested — 13.24.1, 12.23.1, 6.8.1). Community Dragon's `2dlevelminimap.png` path is **404**;
`.../maps.json` is 200. The LCU also serves map assets (`/lol-maps/v1/map/11` → 200) if you want
to avoid the network entirely.

World→pixel transform:

```ts
const MAP_MIN = { x: -120, y: -120 }      // UNVERIFIED numerically (see below)
const MAP_MAX = { x: 14870, y: 14980 }    // UNVERIFIED numerically
function toPixel(x: number, y: number, size = 512) {
  return {
    px: ((x - MAP_MIN.x) / (MAP_MAX.x - MAP_MIN.x)) * size,
    py: size - ((y - MAP_MIN.y) / (MAP_MAX.y - MAP_MIN.y)) * size,   // NOTE the y flip
  }
}
```

**What is verified:** I rendered the 14 turret/pit anchors from §1.3 onto `map11.png` with this
transform and read the image back (`analytics-proto/calib.png`). Blue nexus lands on the
bottom-left base, red nexus on the top-right base, `BAR` lands in the upper-left river, `DRG` in
the lower-right river, top-lane anchors trace the left+top edge, bot-lane anchors the bottom+right
edge. **The orientation and the y-flip are correct.** The full-map death heatmap
(`analytics-proto/heat_deaths.png`, 112 deaths) shows hotspots on mid lane and both rivers,
matching the numeric zone histogram in §4.1 — independent confirmation.

**What is NOT verified:** the exact numeric bounds `(-120,-120)–(14870,14980)`. DDragon's
`map.json` carries no bounds and I could not find an authoritative source I could check. Treat them
as accurate to ~±150 units. **Self-calibration recipe:** render the 12 outer/inner turret anchors
over the minimap and least-squares fit a 2-parameter affine (`scale`, `offset`) per axis so they
land on the turret art. Do this once at build time and hard-code the result.

---

## 2. Role inference (the API cannot be trusted)

### 2.1 Proof that the API fields are wrong

Game `5633857616`, from `/lol-match-history/v1/games/{gameId}`:

```
pid team champ  apiLane/apiRole    totalMinions  neutral  smite  -> TRUE role
 1   100   86   JUNGLE/NONE            228          0      no      TOP
 2   100  141   JUNGLE/NONE             53        161      yes     JGL
 3   100  110   MIDDLE/SOLO            181          6      no      MID
 4   100   16   BOTTOM/CARRY           205          0      no      ADC
 5   100   81   BOTTOM/SUPPORT          83          0      no      SUP
 6   200  122   JUNGLE/NONE            273          9      no      TOP
 7   200  876   JUNGLE/NONE             53        244      yes     JGL   <- the user
 8   200  805   MIDDLE/SOLO            156          0      no      MID
 9   200   18   JUNGLE/NONE            194         12      no      ADC
10   200   80   BOTTOM/SOLO             62          0      no      SUP
```

Four players labelled `JUNGLE`, one of whom has 273 lane CS. `role` is `NONE` for four of them.
Also: **every `timeline.*PerMinDeltas` object is empty `{}`** — `csDiffPerMinDeltas`,
`goldPerMinDeltas`, `xpDiffPerMinDeltas` etc. are all `{}`. There is no shortcut; compute
everything from frames.

### 2.2 The inference algorithm

```ts
type Role = 'TOP' | 'JGL' | 'MID' | 'ADC' | 'SUP'
type Lane = 'TOP' | 'MID' | 'BOT'

interface RoleInference {
  roles: Record<ParticipantId, Role>
  confidence: {
    /** true if exactly one Smite per team (the strong case) */
    jungleBySmite: Record<TeamId, boolean>
    /** median-lane-distance margin between the assigned TOP and the runner-up, in game units */
    topMargin: Record<TeamId, number>
    /** end-of-game lane-CS gap between the assigned ADC and SUP */
    botCsGap: Record<TeamId, number>
    /** number of laning-phase frames the inference used */
    frames: number
  }
}
function inferRoles(game: LcuGame, timeline: LcuTimeline): RoleInference
```

Procedure, per team:
1. **Jungler = the player with Summoner Spell id 11 (Smite).** Verified: exactly one Smite holder
   per team in **44/44 team-games**. Fallback if the count is not 1: highest
   `stats.neutralMinionsKilled`.
2. For the four non-junglers, over frames with `2.0 ≤ minute ≤ 9.5`, compute the **median**
   distance to each of the three lane polylines.
3. Assign `TOP` = argmin median-distance-to-TOP among the four; then `MID` = argmin
   median-distance-to-MID among the remaining three. (Greedy in that order; `TOP` first because
   the top polyline is the most isolated and therefore the least ambiguous.)
4. The remaining two are bot lane. **`ADC` = higher `stats.totalMinionsKilled`, `SUP` = lower.**

**Result: 22/22 games produced a well-formed `{TOP,JGL,MID,ADC,SUP}` set for both teams.**
Diagnostic margins were huge — `topMargin` ranged 3848–5860 units (i.e. the runner-up was
~4–6 k units further from top lane), `botCsGap` ranged 31–324 CS. The single narrow case
(`botCsGap = 31`) was game `5633851596`, a 7.5-minute early-surrender. **Rule: if
`botCsGap < 40` or `frames < 5`, mark ADC/SUP as `LOW_CONFIDENCE` and suppress role-specific
coaching for that game.**

### 2.3 Finding the user and their opponent

```ts
/** the user's participantId — match on puuid, never on summonerName */
function findUser(game: LcuGame, puuid: string): ParticipantId
/** the opposing player in the same role — for a jungler, the enemy jungler */
function findOpponent(roles: RoleInference, me: ParticipantId): ParticipantId
```
`participantIdentities[i].player.puuid` is populated; `summonerName` is `""` and `accountId` is
`0`. Use `puuid` (or `gameName`+`tagLine`).

**For all 22 games the user's role is `JGL`.** The build must not assume a laner.

---

## 3. Lane / role phase metrics

### 3.1 Types

```ts
type Ms = number        // timeline timestamp, milliseconds of game time
type Seconds = number
type GameUnits = number

interface ParticipantFrame {
  participantId: number
  position: { x: number; y: number }
  currentGold: number      // gold in pocket; only ever DECREASES on a purchase
  totalGold: number        // cumulative earned; monotonically non-decreasing
  xp: number
  level: number
  minionsKilled: number        // lane minions, cumulative
  jungleMinionsKilled: number  // neutral camps, cumulative (own + enemy jungle, undifferentiated)
  dominionScore: 0             // always 0 on SR
  teamScore: 0                 // always 0 on SR
}

interface PhaseMetrics {
  /** minionsKilled + jungleMinionsKilled at the mark */
  csAt: Record<10 | 14 | 20, number | null>
  /** csAt − opponent csAt */
  csDeltaAt: Record<10 | 14 | 20, number | null>
  goldDeltaAt: Record<10 | 14, number | null>
  xpDeltaAt: Record<10 | 14, number | null>
  levelDeltaAt: Record<10 | 14, number | null>
  firstBack: FirstBack | null
  /** null when the game ended before the mark */
  gameEndedBeforeMark: Record<10 | 14 | 20, boolean>
}
```

### 3.2 Sampling rule

Frames are emitted at `timestamp ≈ 60000·k`, verified: **644 of 665 inter-frame gaps are exactly
60 s**; the 21 exceptions are each game's final partial frame (0–51 s). So minute-`m` marks land
on real frames, but **you must still interpolate** because the final frame is off-grid and
because you will want marks at arbitrary times for death analysis.

```ts
/** linear interpolation between the bracketing frames; null if t precedes the first frame */
function interpScalar(frames: Frame[], pid: number, t: Ms, field: NumericFrameField): number | null
/** step (last-known) value — use for `level`, which is a step function */
function stepScalar(frames: Frame[], pid: number, t: Ms, field: NumericFrameField): number | null
function interpPosition(frames: Frame[], pid: number, t: Ms): { x: number; y: number } | null
```

Use `interpScalar` for `totalGold`, `xp`, `currentGold`, `minionsKilled`, `jungleMinionsKilled`;
`stepScalar` for `level`. Marks past `frames.at(-1).timestamp` must return `null`, not the last
value — otherwise a 10-minute remake reports a CS@20.

### 3.3 Real output (22 games, user JGL vs enemy JGL)

```
game        dur  CS@10  Δ10  CS@14  Δ14  CS@20  Δ20   Δgold@10 Δgold@14  Δxp@10  Δlvl@14
5631300987 1849     88   +33    125  +38    189  +55      +842    +1323    +902      +2
5632953619 2063     60    +1     85   +2    138  +32      -453     +351     -46       0
5633110115 1416     55    +5     71  -24    105  -36      +655     -196   +1029       0
5633183082 1911     75   +27    114  +49    150  +53      -653     -526    +900      +1
5633229344 1889     68    +3    109  +15    158  +24     -1732    -1094   -1301       0
5633247447 1489     62   -19     93  -13    130  -15      -783    -1025    -565       0
5633279757 2283     60    -1     86   -3    137   -8      -239     -370     +17      -1
5633298307 1982     59   -18     89  -27    130  -49     -1318    -1925    -546      -1
5633326992 2912     53    -8     85   +1    125  +23      +119     +242    +341      +1
5633376663  618     74    +7      -    -      -    -      +438        -    +396       -
5633396837 1718     60   -11     98   -7    130   +3      -446     -911    -447       0
5633418474  974     65   -12    106   -8      -    -       +50     -316    -400      -1
5633491055 1680     63    +1     82  +12    111   +7      +496    +1283     +40      +1
5633513460 2477     50   -16     74  -15    122  +11     -1253    -1753   -1222      -1
5633568872 2250     64    -7     85  -30    103  -74       +64     -633    +156       0
5633603742 2328     74    -2     95   -9    131  -16      -405     -662    -522      -1
5633635973 1972     66   -13     85  -11    115  -33      -373     -747    -426      -1
5633782554 1828     68    -1     83  -19    124  -29      -268     -485    -201      -1
5633838071 1585     54    -7     88  -17    120  -29        -0     -111     +29      -1
5633851596  453      -    -       -    -      -    -         -        -       -       -
5633853752 1267     79   +14    116  +15    179  +44      +738     +227    +286       0
5633857616 2310     53    -7     83   -3    131   +8      -183     +722     -52       0

aggregate                mean      sd      median    95% CI of the mean
CS@10            n=21    64.3      9.6      63.0     [60.1, 68.4]
ΔCS@10           n=21    -1.5     13.5      -2.0     [-7.3, +4.3]
Δgold@10         n=21  -223.9    682.0    -239.2     [-515.6, +67.8]
Δgold@14         n=20  -330.3    859.1    -427.6     [-706.9, +46.2]
Δxp@10           n=21   -77.8    616.5     -46.1     [-341.5, +185.9]
Δlevel@14        n=20    -0.1      0.9      +0.0     [-0.5, +0.2]
```

**Read this carefully before shipping any "you're behind at 10" copy: at n=21, every single
opponent-delta metric's 95% CI contains zero.** The honest statement is "no detectable early-game
deficit against the enemy jungler over 21 games". §7 quantifies how many games you would need.

### 3.4 First back

There are no `ITEM_PURCHASED` events, but `currentGold` is monotonically non-decreasing except at a
purchase, and you can only purchase in the fountain. So:

```ts
interface FirstBack {
  /** the back happened somewhere in (windowStartMin, windowEndMin]; frames are 1/min */
  windowStartMin: number
  windowEndMin: number
  goldSpent: number
  /** opponent's equivalent, and the signed difference */
  opponentWindowEndMin: number | null
  deltaMin: number | null
}
function detectBacks(frames: Frame[], pid: number, thresholdGold = 250): Back[]
```

**Rules:** (a) threshold 250 g; (b) **skip the frame-0→frame-1 transition** — that is the starting
item purchase (drop of 445–450 g in 22/22 games) and is not a back.

Real output — user vs enemy jungler, upper bound of the detection window:

```
user first back      mean 4.59 min   median 4.00   sd 0.73   (range 4.0–6.0)
enemy jgl first back mean 5.55 min   median 5.00
delta (user − enemy) mean −0.96 min  sd 1.89
total backs/game     user 1–12 (median 8), enemy 1–15
```

**Resolution caveat:** the window is 60 s wide. Do not print "you backed at 3:47". Print
"first back between 3:00 and 4:00". As a cross-check, only **9.0% of frames (60/666)** put the
user inside `OWN_BASE`, so position-based back detection would miss most backs — the gold-drop
method is strictly better.

---

## 4. Death analysis — the primary output

### 4.1 What the data actually says

112 user deaths across 22 games (5.1/game).

```
zone                 n     %        phase        n
LANE_MID            18   16.1      EARLY (<10m) 24
LANE_BOT            17   15.2      MID  (10-25) 62
LANE_TOP            12   10.7      LATE (>25m)  26
RIVER_TOP           12   10.7
RIVER_BOT           11    9.8      half (NEUTRAL band ±900u)
OWN_JUNGLE_BOT       8    7.1      NEUTRAL 54 / OWN 38 / ENEMY 20
DRAGON_PIT           7    6.2
ENEMY_JUNGLE_TOP     7    6.2      enemies credited with the kill
ENEMY_JUNGLE_BOT     6    5.4      1 -> 27   2 -> 38   3 -> 30   4 -> 14   5 -> 3
BARON_PIT            4    3.6
OWN_JUNGLE_TOP       4    3.6      minute bucket: 0-5:6  5-10:18  10-15:22
OWN_BASE             4    3.6                     15-20:21 20-25:19 25-30:14
ENEMY_BASE           2    1.8                     30-35:8  35-40:2  40-45:2
```

Gold state vs the enemy jungler at the moment of death:
```
p10 −2806   p25 −1667   p50 −618   p75 −100   p90 +497   mean −863
87 of 112 deaths (78%) happened while behind the enemy jungler in gold.
```

### 4.2 The death record

```ts
interface DeathRecord {
  gameId: string
  /** exact, from the event — NOT interpolated */
  t: Seconds
  position: { x: number; y: number }
  zone: Zone
  half: 'OWN' | 'NEUTRAL' | 'ENEMY'
  /** step value from the last frame at or before t */
  level: number
  /** interpolated */
  totalGold: number
  /** totalGold − opponent totalGold, both interpolated at t */
  goldDeltaVsOpponent: number
  levelDeltaVsOpponent: number

  /** EXACT: 1 + assistingParticipantIds.length. Never estimated. */
  enemiesCredited: number
  killerId: ParticipantId
  assistIds: ParticipantId[]

  isolation: IsolationEstimate
  objectiveContext: ObjectiveContext
  cost: DeathCost
}

interface IsolationEstimate {
  /** allies PROVEN present: they scored/took a kill within ±10 s and 2500 units. Hard evidence. */
  provenAlliesPresent: ParticipantId[]
  /** interpolated distance to the nearest ally at t. SOFT — see §4.3 for the error bars. */
  nearestAllyDistance: GameUnits
  alliesWithin2000: number
  /** 3-bucket verdict, deliberately coarse */
  verdict: 'SOLO' | 'PARTIAL' | 'WITH_TEAM'
  /** always report this alongside the verdict */
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
}
```

**Verdict rule** (what I ran):
```
SOLO       provenAlliesPresent.length === 0 && nearestAllyDistance > 2500
WITH_TEAM  provenAlliesPresent.length >= 2
PARTIAL    otherwise
```
Result over 112 deaths: `PARTIAL 45 / WITH_TEAM 44 / SOLO 23`. `provenAlliesPresent` distribution:
`0 → 52, 1 → 16, 2 → 19, 3 → 19, 4 → 6`.
Confidence is `HIGH` when `provenAlliesPresent.length ≥ 1` (evidence-backed) or when
`nearestAllyDistance > 5000` (unambiguous even with the error bars), else `MEDIUM`/`LOW`.

The 23 SOLO deaths (1.0/game) cluster as: `LANE_BOT 5, LANE_TOP 4, RIVER_TOP 3,
ENEMY_JUNGLE_BOT 3, ENEMY_JUNGLE_TOP 2, LANE_MID 2, BARON_PIT 2, DRAGON_PIT 1, OWN_JUNGLE_BOT 1`.

### 4.3 The sampling-error problem — measured, not assumed

This is the most important caveat in the whole document.

```
Displacement of a player between consecutive frames (60 s apart), n=6660:
  p10 716   p25 1722   p50 4082   p75 7254   p90 10081   p99 13314   max 17380
```
The map's playable extent is ~14 800 units. **The median player moves 4082 units — 28% of the
map — between two samples.**

Positional error when reconstructing the user's own position at the moment of their death
(ground truth = the exact `CHAMPION_KILL.position`), n=112:

```
method              p50    p75    p90
previous frame     2871   5196   7190
linear interp      1452   2700   4215
```

**Linear interpolation halves the error and is mandatory.** But a 1452-unit median error is
already larger than a champion's ~1350-unit vision radius, so:

**Objective-presence validation.** I used a hard ground truth: 85 events where the user personally
smited the objective (`ELITE_MONSTER_KILL.killerId === userId`), so they were provably within a few
hundred units. Negatives: 105 enemy-team objectives (an upper bound on the false-positive rate,
since some were genuinely contested).

```
radius   interp: recall / FPR     min-over-{prev,interp,next}: recall / FPR
 1500      0.44 / 0.08                    0.60 / 0.20
 2000      0.55 / 0.16                    0.67 / 0.32
 2500      0.65 / 0.23                    0.74 / 0.41
 3000      0.74 / 0.37                    0.86 / 0.58
 4000      0.86 / 0.57                    0.96 / 0.77
```

**Conclusion: there is no operating point that gives you a trustworthy binary "was he there".**
At a usable false-positive rate you recover only ~55–65% of true presences. Therefore:

> **Rule for the build: presence and isolation derived from positions must be surfaced as
> `LIKELY`/`UNCLEAR` with a stated sensitivity, never as a fact. Event-derived proof
> (`killerId`, `BUILDING_KILL` assists, a kill/assist/death within ±10 s and 2500 units of the
> spot) always wins over the positional estimate.**

Recommended operating point when you must pick one: **`interp` at R = 2400**, ≈65% sensitivity.

### 4.4 Objective context

```ts
interface ObjectiveContext {
  /** enemy elite objective taken in the 45 s AFTER this death */
  objectiveConcededWithin45s: MonsterType[]
  /** seconds until the next scheduled spawn of each objective, from the empirical table below */
  secondsToNextDragonSpawn: number | null
  secondsToNextBaronSpawn: number | null
  /** true if the death fell inside a spawn window (defined as [spawn−45s, spawn+90s]) */
  inSpawnWindow: boolean
}
```

Empirical spawn/respawn evidence, 22 games (kill times are *lower bounds* on spawn):

```
first kill of each type (minutes)        consecutive-kill gaps (minutes)
DRAGON        n=22  min 5.57  med  7.24  DRAGON        n=73  min 5.15  med 5.66  p75 6.04
HORDE         n=21  min 8.19  med  9.50  BARON_NASHOR  n= 8  min 6.43  med 7.18  p75 7.92
RIFTHERALD    n=19  min 15.50 med 17.02
BARON_NASHOR  n=17  min 21.03 med 25.06
```
→ consistent with dragon spawning at 5:00 on a 5:00 respawn, baron at 20:00 on a 6:00 respawn,
herald ~14:00–15:00, voidgrubs ~6:00–8:00. **Do not hard-code first-spawn times from memory** —
they change patch to patch. Either derive them per-patch by taking the observed minimum over a
corpus, or read them from the client's game data. Marked `UNVERIFIED` as exact constants; the
respawn *intervals* (dragon 5:00, baron 6:00) are well supported by the gap data above.

**Measured value of this context, computed:**
```
enemy elite objective taken within 45 s of a user death:  19 / 103 = 18%
base rate in a random 45 s window:                        82 / 863 = 10%
```
A death nearly doubles the chance the enemy takes an objective in the next 45 seconds.

### 4.5 Cost of a death

```ts
interface DeathCost {
  /** enemy shutdown/kill gold. Base 300 + 150 per assist. APPROXIMATION: the LCU timeline
   *  carries no bounty field, so real shutdowns (up to +1000) are invisible. */
  goldToEnemy: number
  /** own GPM × downtime. GPM is measured from this game's goldEarned/duration. */
  goldForgone: number
  /** seconds dead */
  estimatedDowntime: Seconds
  /** 500 per objective conceded in the following 45 s */
  objectivePenalty: number
  totalGold: number
  /** how the downtime was obtained */
  downtimeSource: 'BRW_TABLE_ESTIMATE'
}
```

**`UNVERIFIED`: the base respawn wait (BRW) table and the time-increase factor (TIF).** I used

```
BRW by level 1..18 = 10,10,12,12,14,16,20,21,22,24,25,28,32.5,35,37.5,40,42.5,45   // UNVERIFIED
TIF(t) = 0 below 15:00, then rising ~0.425%/30s to 15:00-30:00, etc.               // UNVERIFIED
```

I could not verify these from the LCU or from the frame data (1-minute sampling is far too coarse
to measure a 20–50 second respawn). **The build phase must source this from the game client's data
files or a maintained reference, and pin it per patch.** Do not ship the numbers above as fact.

**A fully measured alternative you can ship today.** I computed the team gold-difference swing over
the 90 s following each user death, against a baseline of all 90 s windows:

```
90 s after a user death (n=103):  mean −368   median −289   sd 1158
random 90 s window     (n=632):   mean  +51   median  −19   sd 1233
--> excess team-gold cost attributable to a death: ≈ −418 gold over 90 s
```

Report both: the model-based `DeathCost.totalGold` for ranking, and this measured −418 g/death
figure as the honest headline. (Note the sd is ~1150 — the *per-death* swing is dominated by
noise; only the mean over ~100 deaths is meaningful.)

### 4.6 Clustering — finding the repeating pattern

Do **not** run k-means on raw `(x, y, t)`. The coaching value is in *categorical* signatures, which
are directly explainable to a player. Signature dimensions:

```ts
type DeathSignature = readonly [Zone, Phase, Economy, Isolation, Outnumbering]
type Phase = 'EARLY' | 'MID' | 'LATE'                        // t < 600s / < 1500s / else
type Economy = 'BEHIND' | 'EVEN' | 'AHEAD'                   // goldDeltaVsOpponent < -400 / ±400 / > +400
type Isolation = 'SOLO' | 'PARTIAL' | 'WITH_TEAM'
type Outnumbering = '1v1' | '2v' | 'OUTNUMBERED'             // enemiesCredited 1 / 2 / >=3

interface Pattern {
  dims: (keyof DeathRecordFlat)[]
  values: string[]
  support: number          // deaths matching
  gamesSpanned: number     // distinct games — the anti-overfit guard
  lift: number             // observed / product of marginals
  pValue: number           // binomial vs the marginal-product null
}
function minePatterns(deaths: DeathRecord[], minSupport = 6, maxDims = 3): Pattern[]
```

**Guard rails, all mandatory:**
- `minSupport ≥ 6` and `gamesSpanned ≥ 4`. A pattern concentrated in one game is one bad game.
- Skip logically redundant dimension pairs. `zone` implies `half`, so the pair `(zone, half)`
  produced a spurious top-lift result in my first run.
- You are testing hundreds of itemsets. Apply Benjamini–Hochberg or, minimally, report the number
  of hypotheses tested next to every p-value.

Real output over the 112 deaths (top itemsets by lift, support ≥ 6):

```
 n   %      games  lift   pattern
13  11.6%   12/22  2.25   phase=EARLY & outnumbering=1v1
12  10.7%    8/22  2.80   phase=LATE & isolation=WITH_TEAM & outnumbering=OUTNUMBERED
 8   7.1%    8/22  4.84   phase=EARLY & economy=EVEN & outnumbering=1v1
 8   7.1%    7/22  2.72   zone=RIVER_BOT & phase=MID
 8   7.1%    6/22  2.77   zone=LANE_TOP & outnumbering=1v1
 7   6.2%    6/22  3.15   zone=RIVER_BOT & outnumbering=OUTNUMBERED
 7   6.2%    4/22  2.58   zone=OWN_JUNGLE_BOT
 6   5.4%    6/22  5.05   phase=EARLY & isolation=SOLO & outnumbering=1v1
 6   5.4%    6/22  4.80   zone=ENEMY_JUNGLE_TOP
 6   5.4%    5/22  3.29   phase=LATE & isolation=WITH_TEAM & half=ENEMY
```

**The headline finding, with its statistics stated honestly:**

> Of the 24 deaths before 10:00, **13 (54%) were straight 1v1 losses** — a single enemy credited,
> no assists. The baseline 1v1 share across all 112 deaths is 24%.
> One-sided binomial p(X ≥ 13 | n = 24, p = 0.241) = **0.0015**. The pattern spans **12 of 22
> games**, so it is not one bad night.
> Caveat: the "EARLY" cut was selected post hoc from 3 phases × 3 outnumbering levels = 9
> comparisons; Bonferroni-adjusted p ≈ 0.013. Still significant.

That is a real, defensible coaching claim: *the user loses early-game solo duels*.

---

## 5. Map / positioning

### 5.1 Metrics

```ts
interface PositioningMetrics {
  /** share of post-t=0 frames in each half, using the ±900u NEUTRAL band */
  halfShare: { own: number; neutral: number; enemy: number }
  /** median distance to the centroid of the four living allies */
  medianDistanceToTeamCentroid: GameUnits
  medianNearestAllyDistance: GameUnits
  /** see §5.2 */
  medianOverExtension: number
  p90OverExtension: number
  framesUsed: number
}
```

### 5.2 Over-extension score

```
overExtension(frame) = nearestAllyDistance / (nearestEnemyDistance + 1500)
```
Far from allies *and* close to enemies → large. The `+1500` floor keeps the score finite when an
enemy is on top of you and damps the noise from the interpolation error. It is unitless and
roughly 0–1.5 in practice. **Report the median and the p90** — the p90 is what actually
distinguishes games (see the table: p90 ranges 0.64–1.28 while the median only ranges 0.31–0.72).

### 5.3 Real values, 22 games

```
game        frames  own   neutral enemy | centroidDist nearestAlly medOX p90OX
5631300987     31   0.55   0.26   0.19  |    2895        1354      0.45  0.84
5632953619     35   0.60   0.37   0.03  |    3099        1285      0.40  0.79
5633110115     24   0.71   0.21   0.08  |    2897        1756      0.37  0.72
5633183082     32   0.44   0.31   0.25  |    3791        2536      0.51  0.92
5633229344     32   0.44   0.34   0.22  |    2995        2108      0.49  0.77
5633247447     25   0.76   0.24   0.00  |    2429        1521      0.50  0.68
5633279757     39   0.51   0.41   0.08  |    2963        2281      0.46  0.75
5633298307     34   0.74   0.18   0.09  |    4110        1717      0.51  0.72
5633326992     49   0.33   0.37   0.31  |    3150         945      0.31  0.71
5633376663     11   0.73   0.18   0.09  |    3973        3563      0.63  0.79
5633396837     29   0.41   0.41   0.17  |    3415        1864      0.58  0.85
5633418474     17   0.59   0.18   0.24  |    3355        3374      0.56  0.77
5633491055     29   0.59   0.38   0.03  |    3516        2324      0.55  0.79
5633513460     42   0.52   0.40   0.07  |    3222        1136      0.34  0.79
5633568872     38   0.68   0.21   0.11  |    3781        1618      0.43  0.78
5633603742     39   0.36   0.49   0.15  |    3598        2782      0.55  1.28
5633635973     33   0.52   0.45   0.03  |    2816        1446      0.36  0.64
5633782554     31   0.65   0.32   0.03  |    3439        3040      0.54  1.14
5633838071     27   0.63   0.33   0.04  |    3223        2144      0.47  0.82
5633851596      8   0.75   0.25   0.00  |    5638        3897      0.72  0.95
5633853752     22   0.59   0.32   0.09  |    4273        2974      0.60  0.84
5633857616     39   0.33   0.44   0.23  |    3672        2446      0.52  1.16

mean ± 95% CI:  own 0.564 [0.507,0.621]   neutral 0.321 [0.281,0.361]
                enemy 0.115 [0.077,0.153]
                centroidDist 3466 [3188,3744]   nearestAlly 2187 [1844,2530]
                medOX 0.494 [0.452,0.536]       p90OX 0.842 [0.774,0.910]
```

**Sample-size caveat:** a 25-minute game contributes ~25 frames. `framesUsed` must be exported and
any per-game positioning stat with `framesUsed < 15` should be flagged (game `5633851596`, 8 frames,
is the visible outlier in every column).

### 5.4 Heatmap rendering

Working implementation in `.research/analytics-proto/heat.py`, output
`heat_deaths.png` / `heat_presence.png`.

```ts
interface HeatmapSpec {
  points: { x: number; y: number; weight?: number }[]
  size: 512                      // matches map11.png natively
  /** Gaussian sigma in PIXELS. 13 px ≈ 380 game units — chosen so a single death
   *  blurs to roughly a champion's threat radius rather than a dot. */
  sigma: 13
  background: 'ddragon:map11'
  /** dim the minimap so the overlay reads. 0.45 works. */
  backgroundDim: 0.45
}
```
Algorithm: accumulate into a 512×512 float array at `toPixel(x,y)`; separable Gaussian blur;
normalise by the max; map `t ∈ [0,1]` through a blue→cyan→yellow→red ramp; alpha `= t^0.75`;
alpha-composite over the dimmed minimap.

**Two rendering rules learned the hard way:**
- Do the accumulation and blur in **float**, not 8-bit. An `L`-mode PIL image saturates and the
  peak collapses to 1–5 counts, producing a flat blob.
- Always `size`-normalise by the per-image max and print `n` on the image. A heatmap of 112 points
  and a heatmap of 666 points look identical otherwise, and the reader will over-read the sparse one.

I verified the render visually: the death heatmap's hotspots sit on mid lane and both river
diagonals, exactly matching the zone histogram in §4.1.

For an interactive web version, emit the same grid as JSON (`{cell: [gx,gy], count}` at a 40×40
grid = 370 game units/cell) and let the front end render — do not ship 190 KB PNGs per game.

---

## 6. Macro

### 6.1 Objective participation

```ts
interface ObjectiveParticipation {
  monster: MonsterType
  subType: string        // e.g. 'CHEMTECH_DRAGON'; '' for baron/herald/horde
  t: Seconds
  takenBy: 'US' | 'THEM'
  /** hard proof, in decreasing strength */
  proof:
    | { kind: 'SMITED_BY_USER' }                                  // killerId === userId
    | { kind: 'KILL_NEARBY'; killEventT: Seconds }                // kill/assist/death within ±20s & 2500u
    | { kind: 'POSITION_ONLY'; distance: GameUnits }              // soft
    | { kind: 'ABSENT'; distance: GameUnits }
  /** ALWAYS populated when proof.kind === 'POSITION_ONLY' */
  sensitivity: 0.65
}
```

Real output for the user (position radius 2200, before applying the proof hierarchy):

```
              ours  present  %      smitedByUser | theirs  contested  %
DRAGON          47      32   68%          39     |   48         8    17%
BARON_NASHOR    14       6   43%          14     |   11         2    18%
RIFTHERALD       7       4   57%           6     |   12         1     8%
HORDE           29      16   55%          26     |   34        10    29%
```

Note the contradiction that proves §4.3's point: the user **smited all 14 barons** their team took,
yet position-interpolation only "found" them at 6 of them. **`killerId` beats position every time.**

The `assistingParticipantIds` on these events cannot be used to fix this: **42 of 202
`ELITE_MONSTER_KILL` events list at least one assist from the opposing team** (65 of 338 listed
assists, 19%). `BUILDING_KILL` assists are clean (0 cross-team in 310 events) and *can* be used
for turret-participation.

### 6.2 Counter-jungling / farm-side discipline

`stats.neutralMinionsKilledEnemyJungle` and `...TeamJungle` are **0 in all 22 games** — dead
fields. Derive instead:

```ts
/** For each consecutive frame pair, attribute Δ jungleMinionsKilled to the half the player
 *  occupied at the LATER frame (the camp finished there). */
interface JungleFarmSplit {
  ownHalfCamps: number
  enemyHalfCamps: number
  neutralBandCamps: number
  totalCamps: number
  enemyShare: number          // enemyHalfCamps / totalCamps
  campsPerMinute: number
}
```

Real output:
```
                 total  ownHalf  enemyHalf  %enemy  camps/min
5633326992         263       74         79   30.0%     5.42
5633183082         225      112         45   20.0%     7.06
5633857616         244       74         44   18.0%     6.34
5633229344         214      102         38   17.8%     6.80
...
5633635973         151       52          0    0.0%     4.59
5633851596          19        8          0    0.0%     2.52

enemyShare  mean 0.094  sd 0.077  sem 0.017
camps/min   mean 5.344  sd 1.337  sem 0.285
```
(The residual `total − own − enemy` falls in the ±900u neutral band — scuttle and river camps.
Report it as its own bucket; don't silently fold it into one side.)

Camps/min is a clean, low-variance efficiency metric (CV 0.25). Enemy share is a genuine
counter-jungle proxy but is noisy (CV 0.82).

### 6.3 Wave / side-lane proxies

The reduced timeline has **no ward, no item, no skill and no lane-minion-wave events**, so true
wave management is not observable. Available proxies, in decreasing quality:

1. **`minionsKilled` deltas per frame with position** — tells you which lane the jungler was
   soaking waves in, and when. This is the only real wave signal available.
2. `stats.damageDealtToTurrets` and `damageDealtToObjectives` (end of game only).
3. `BUILDING_KILL` events with `laneType` + `towerType` + owning `teamId` — a full, exact turret
   timeline. Reliable.
4. `stats.visionScore`, `wardsPlaced`, `wardsKilled`, `visionWardsBoughtInGame` — end-of-game only,
   no timing, no position. **Do not attempt a vision-timeline; the data is not there.**

### 6.4 Death timing vs objective spawns

Covered by `ObjectiveContext` (§4.4). The measured headline: 18% of the user's deaths are followed
by a conceded elite objective within 45 s, against a 10% base rate.

---

## 7. Trend metrics across N games, and how to not lie about them

### 7.1 The stability table (real, n = 22 games)

`CV` = sd/|mean|. `MDD` = minimum detectable difference between two 10-game blocks at 80% power
(`2.8·sd·√(2/10)`). The last three columns are the 95% CI half-width at n = 5, 10, 22.

```
metric               n     mean       sd      CV     MDD(10v10)   ±@n=5    ±@n=10   ±@n=22
cs10                21     64.26     9.62   0.15       12.05       8.44     5.96     4.02
med_centroid        22   3465.96   665.47   0.19      833.30     583.31   412.46   278.08
med_overextension   22      0.494    0.100  0.20        0.126      0.088    0.062    0.042
gpm                 22    416.86    87.13   0.21      109.10      76.37    54.00    36.41
own_half_pct        22      0.564    0.137  0.24        0.171      0.120    0.085    0.057
med_nearest_ally    22   2186.94   820.40   0.38     1027.30     719.11   508.49   342.82
vision              22     26.23    11.53   0.44       14.43      10.10     7.14     4.82
deaths_per_min      22      0.166    0.083  0.50        0.104      0.073    0.052    0.035
dpm                 22    715.56   436.03   0.61      545.99     382.19   270.25   182.20
deaths              22      5.09     3.15   0.62        3.94       2.76     1.95     1.32
assists             22     10.27     7.09   0.69        8.88       6.22     4.40     2.96
enemy_half_pct      22      0.115    0.090  0.78        0.113      0.079    0.056     0.038
kills               22      5.95     4.81   0.81        6.02       4.21     2.98     2.01
csd10               21     -1.48    13.49   9.10       16.90      11.83     8.36     5.64
gd10                21   -223.86   681.99   3.05      853.99     597.79   422.70   284.99
gd14                20   -330.34   859.09   2.60     1075.75     753.02   532.47   358.99
xpd10               21    -77.77   616.52   7.93      772.01     540.40   382.12   257.63
```

### 7.2 Verdict per metric

**TRENDABLE at n ≥ 10** (CV ≤ 0.25 — the game-to-game noise is small relative to the level):
`cs10`, `campsPerMinute`, `gpm`, `medianDistanceToTeamCentroid`, `medianOverExtension`,
`own_half_pct`. A 10-game block mean of these is meaningful; a 10-vs-10 comparison detects a
change of about one MDD.

**TRENDABLE at n ≥ 20, with the CI always shown:** `deaths_per_min`, `visionScore`, `deaths`.

**NOT TRENDABLE on this sample size — do not put a trendline on them:**
`kills`, `assists`, `dpm`, `enemy_half_pct`, and **every opponent-delta metric**
(`csd10`, `gd10`, `gd14`, `xpd10`).

The delta metrics deserve a specific warning. `gd10` has sd = 682 around a mean of −224.
To get a 95% CI half-width of ±200 g you need **n = (1.96·682/200)² ≈ 45 games**. To distinguish
"even" from "300 g behind" with 80% power in a 10-vs-10 block comparison you need an effect of
854 g. **A "gold diff @10 is trending down" claim built on 10 games is noise, essentially always.**

### 7.3 Presenting a trend honestly

```ts
interface TrendedMetric<T = number> {
  key: string
  perGame: { gameId: string; value: T | null }[]
  n: number
  mean: number
  sd: number
  ci95: [number, number]
  /** the CV-based verdict from §7.2 */
  reliability: 'TRENDABLE' | 'NOISY' | 'NOT_TRENDABLE_AT_THIS_N'
  /** games required for a ±(halfWidth) CI, so the UI can say "check back in N games" */
  gamesForPrecision(halfWidth: number): number
  /** Present only when reliability !== 'NOT_TRENDABLE_AT_THIS_N' */
  slope: { perGame: number; ci95: [number, number]; pValue: number } | null
}
```

**Copy rules for the coach output:**
- Every trend statement carries `n` and the CI. "CS@10: 64.3 ± 4.0 over 21 games" — not "your CS@10
  is 64".
- If `reliability === 'NOT_TRENDABLE_AT_THIS_N'`, render the per-game values as a scatter with **no
  trendline** and the label "too few games to call a trend".
- Never say "improving"/"declining" unless the slope CI excludes zero.
- Report the number of metrics tested next to any p-value.

### 7.4 A worked example of the multiple-comparison trap

I correlated 18 per-game metrics against win/loss (12 wins, 22 games):

```
metric              r(win)   p (normal approx)
enemy_half_pct      +0.693   0.0004     <-- survives Bonferroni (0.05/18 = 0.0028)
own_half_pct        -0.671   0.0007     <-- same metric, mirrored
deaths_per_min      -0.510   0.008      <-- does NOT survive Bonferroni
cs10                +0.446   0.030      <-- does NOT survive
csd10               +0.348   0.105
gpm                 +0.357   0.087
deaths              -0.359   0.085
gd10                +0.122   0.592
kills               +0.049   0.825
vision              +0.075   0.736
med_overextension   +0.094   0.673
```

Two lessons the build must encode:
1. **Only one metric survives correction, and it is the least actionable one.**
   `enemy_half_pct` correlating +0.69 with winning is almost entirely **reverse causality** —
   teams that are winning push into the enemy half. Telling the user "spend more time in the enemy
   half to win" is exactly backwards. **Flag reverse-causal metrics explicitly in the schema**
   (`causality: 'CONFOUNDED_BY_OUTCOME'`) and never surface them as levers.
2. `cs10` at p = 0.03 looks publishable and is not. Show the corrected threshold next to it.

---

## 8. Teachable-moment selection

### 8.1 Types

```ts
type MomentKind = 'DEATH' | 'OBJECTIVE_CONCEDED' | 'OBJECTIVE_TAKEN' | 'TURRET_LOST'

interface TeachableMoment {
  kind: MomentKind
  gameId: string
  /** game-clock seconds. Same clock as gameDuration and the Live Client Data API's gameTime. */
  t: Seconds
  position: { x: number; y: number }
  zone: Zone
  half: 'OWN' | 'NEUTRAL' | 'ENEMY'

  /** ranking inputs, all exported for debuggability */
  costGold: number          // §4.5
  fixability: number        // §8.2 multiplier
  recurrenceCount: number   // how many moments across the whole corpus share this signature
  score: number             // costGold * fixability * (1 + 0.35*ln(recurrenceCount))

  signature: DeathSignature
  /** one-line explanation the coach LLM expands */
  why: string

  capture: CaptureRequest
}

interface CaptureRequest {
  gameId: string
  /** where to seek the replay */
  startTime: Seconds        // t - leadIn
  endTime: Seconds          // t + leadOut
  focusTime: Seconds        // == t, the frame worth screenshotting
  camera:
    | { mode: 'FOLLOW_PARTICIPANT'; participantId: number }
    | { mode: 'FIXED_WORLD_POSITION'; x: number; y: number }
  /** always request the minimap-visible framing for positioning moments */
  wantMinimap: boolean
}
```

**Lead-in / lead-out defaults:** `leadIn = 12 s`, `leadOut = 8 s` for a DEATH (you need to see the
approach, which is where the mistake was made, not the death itself); `leadIn = 20 s`,
`leadOut = 10 s` for an OBJECTIVE moment.

### 8.2 Scoring

```
score = costGold × fixability × (1 + 0.35·ln(max(recurrenceCount, 1)))

fixability = 1.0
           × (isolation === 'SOLO'        ? 1.6 : 1.0)   // a solo death is a choice
           × (enemiesCredited <= 2        ? 1.4 : 0.8)   // losing a 1v1 is coachable; a 5v1 collapse is not
           × (half === 'ENEMY' && behind  ? 1.3 : 1.0)   // deep while behind = the classic tilt pattern
           × (t < 90                      ? 0.6 : 1.0)   // level-1 invades are mostly team decisions
```

`recurrenceCount` is computed over the **whole corpus, not the single game** — that is what makes a
moment worth a screenshot rather than a footnote. The `signature` used for recurrence is the
coarser triple `(zone, phase, isolation)` for deaths and `(monsterType, phase, 'ABSENT')` for
conceded objectives.

### 8.3 Selection

```ts
function selectMoments(corpus: TeachableMoment[], gameId: string, topN = 8): TeachableMoment[]
```
1. Score every candidate in the target game.
2. Sort descending.
3. **Temporal de-duplication: reject a moment within 25 s of an already-selected one.** Otherwise
   a lost teamfight yields five near-identical clips.
4. **Exclude the game-ending sequence.** Drop `DEATH` moments in the final 30 s of the game or
   inside `ENEMY_BASE` after the last inhibitor fell — the death that ends a game is not teachable.
   *(My prototype does not yet do this and its #1 pick for game 5633857616 is a 38:23 death in the
   enemy base during the losing team's final defence. Fix this in the build.)*
5. Take the first `topN`.

### 8.4 Real output

`python3 moments.py 5633857616` — 178 candidate moments mined across the corpus:

```
 #  time     score  kind  zone              half     lvl  Δgold  killers solo  nearestAlly  recur
 1  38:23     1958  DEATH ENEMY_BASE        ENEMY     18   -532     2    no        584        2   <-- should be excluded (§8.3.4)
 2  03:23     1425  DEATH ENEMY_JUNGLE_BOT  ENEMY      3   -175     1    YES      7989        2
 3  21:49     1185  DEATH ENEMY_JUNGLE_TOP  ENEMY     13  +1689     1    no       1783        4
 4  15:49     1008  DEATH RIVER_TOP         NEUTRAL    9  +1104     3    no       1767        6
 5  10:18      886  DEATH ENEMY_JUNGLE_TOP  NEUTRAL    6   -215     1    no       1646        4
 6  28:29      760  DEATH RIVER_TOP         NEUTRAL   16   -114     3    no        883        1
 7  11:22      354  OBJ   BARON_PIT         — conceded HORDE, user 7444 units away         9
```

Moment #2 is exactly the target: 3:23, alone in the enemy jungle at level 3, nearest ally 7989
units away, killed 1v1. It is an instance of the corpus-wide pattern from §4.6 (early 1v1 deaths,
p = 0.0015, 12/22 games). That is a screenshot worth taking.

### 8.5 Handoff to the capture pipeline — what is and is not verified

**Verified:** the timeline clock, `gameDuration`, and the Live Client Data API's `gameTime` are the
same clock. Last-frame timestamp equals `gameDuration` within 0.00–0.82 s in all 22 games, and the
live API's `GameStart` event fires at `EventTime = 0.030`. **So `TeachableMoment.t` can be handed to
a replay seek in raw seconds with no offset.**

**Verified:** during a *live* game, `https://127.0.0.1:2999` serves the Live Client Data API
(`/liveclientdata/allgamedata`, `/gamestats`, `/eventdata`, …) and
`/swagger/v3/openapi.json` lists exactly 26 paths. `/liveclientdata/eventdata` gives
`{EventID, EventName, EventTime(seconds), KillerName, VictimName, Assisters}` for
`GameStart, MinionsSpawning, ChampionKill, FirstBlood, DragonKill, HordeKill, HeraldKill,
TurretKilled, FirstBrick, Multikill` — **but no coordinates**. It is a clock/sync source, not a
positional one.

**UNVERIFIED:** the replay control surface. `/replay/playback` and `/replay/render` return
`404 RESOURCE_NOT_FOUND "Invalid URI format"` and do **not** appear in the openapi listing during a
live game — the replay endpoints only materialise when the process is playing a replay, which I was
forbidden to start. **The build phase must enumerate `https://127.0.0.1:2999/swagger/v3/openapi.json`
while a replay is running** and read the real `/replay/*` schema from there rather than trusting any
recalled shape. In particular, whether the camera can be driven to a world `(x, y)` versus only
attached to a participant is **unknown**; `CaptureRequest.camera` is specified as a union so both
paths are available, but only the `FOLLOW_PARTICIPANT` variant is safe to assume.

**UNVERIFIED:** whether the Live Client Data API is served at all during replay playback (it is
designed to be, but I did not test it).

---

## 9. Data-source reference

### 9.1 Endpoints used (all verified 200 this session)

```bash
IFS=':' read -r name pid port pass proto < "/mnt/c/Games/Riot Games/League of Legends/lockfile" || true
# NOTE: the lockfile has NO trailing newline, so `read` exits non-zero at EOF.
# Without the `|| true` an `&&` chain silently dies. This cost me a debugging cycle.
CURL=/mnt/c/WINDOWS/system32/curl.exe   # Windows-side curl; WSL2 cannot reach these ports

$CURL -sk -u "riot:$pass" "https://127.0.0.1:$port/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=20"
$CURL -sk -u "riot:$pass" "https://127.0.0.1:$port/lol-match-history/v1/games/{gameId}"
$CURL -sk -u "riot:$pass" "https://127.0.0.1:$port/lol-match-history/v1/game-timelines/{gameId}"
$CURL -sk "https://127.0.0.1:2999/liveclientdata/allgamedata"     # live game only, no auth
$CURL -sk "https://127.0.0.1:2999/swagger/v3/openapi.json"
```

Payload sizes: match-history list of 21 games = 90 KB; per-game detail ≈ 31.8 KB; per-game
timeline ≈ 86 KB. **All 22 games + timelines = 2.5 MB and took under 30 seconds** to fetch
sequentially. Cache them on disk keyed by gameId; they are immutable.

**Two important asymmetries:**
- **The history list returns `participants.length === 1`** (the current summoner only).
  `/games/{gameId}` returns all 10. Always fetch the detail.
- **Games age out of the 20-game history window but remain fetchable by id.** Game
  `5631300987` (2026-08-30) is absent from the list but
  `/lol-match-history/v1/games/5631300987` and `/game-timelines/5631300987` both return the full
  payload, byte-identical on repeat fetch. **So: persist gameIds as you see them; you can build a
  corpus far larger than 20 games over time.**

### 9.2 Exact timeline shapes

```jsonc
// GET /lol-match-history/v1/game-timelines/{gameId}
{ "frames": [ { "timestamp": 1260027, "participantFrames": { "1": {...}, ... "10": {...} },
               "events": [ ... ] } ] }

// participantFrame — union of keys across 688 frames, all always present
{ "currentGold": 226, "dominionScore": 0, "jungleMinionsKilled": 121, "level": 13,
  "minionsKilled": 10, "participantId": 7, "position": { "x": 7230, "y": 7307 },
  "teamScore": 0, "totalGold": 8696, "xp": 10092 }

// event — a FLAT UNION: every key is present on every event, with "" / 0 for the
// fields that do not apply. Discriminate on `type`, and do not trust a non-empty-looking default.
{ "assistingParticipantIds": [9], "buildingType": "", "itemId": 0, "killerId": 10,
  "laneType": "", "monsterSubType": "", "monsterType": "", "participantId": 0,
  "position": { "x": 12667, "y": 2783 }, "skillSlot": 0, "teamId": 0,
  "timestamp": 136607, "towerType": "", "type": "CHAMPION_KILL", "victimId": 5 }
```

Event-type census over 22 games: `CHAMPION_KILL 1416`, `BUILDING_KILL 310`,
`ELITE_MONSTER_KILL 202`. **Those three types are the entire universe.** Absent versus Riot's
public match-v5 timeline: `ITEM_PURCHASED`, `ITEM_SOLD`, `ITEM_DESTROYED`, `WARD_PLACED`,
`WARD_KILL`, `SKILL_LEVEL_UP`, `LEVEL_UP`, `CHAMPION_SPECIAL_KILL`, `TURRET_PLATE_DESTROYED`,
`GAME_END`, and the `victimDamageDealt`/`victimDamageReceived` arrays. Design around their absence.

Per-type field usage:
- `CHAMPION_KILL`: `killerId`, `victimId`, `assistingParticipantIds`, `position`, `timestamp`.
  **All verified consistent** (0 same-team kills, 0 cross-team assists in 1416 events).
  **`killerId === 0` occurs in 4 of 1416 events** — an execution / minion / turret kill with no
  champion credited. Handle it: it is a *free* death for the enemy and often the most teachable
  kind ("you died to the wave under tower"), so do not filter it out, but every consumer that
  indexes participants by `killerId` must guard against 0.
- `ELITE_MONSTER_KILL`: `killerId` **reliable**, `position` reliable.
  **`assistingParticipantIds` is CORRUPT — do not use.** Exact observed
  `(monsterType, monsterSubType)` census over 202 events:
  ```
  DRAGON/CHEMTECH_DRAGON 20   DRAGON/WATER_DRAGON 20   DRAGON/FIRE_DRAGON 14
  DRAGON/HEXTECH_DRAGON  13   DRAGON/EARTH_DRAGON 13   DRAGON/AIR_DRAGON   10
  DRAGON/ELDER_DRAGON     5   HORDE/'' 63   BARON_NASHOR/'' 25   RIFTHERALD/'' 19
  ```
  `monsterSubType` is `''` for everything that is not a dragon. There is no `ATAKHAN` in this
  corpus; treat the subType set as open.
- `BUILDING_KILL`: `teamId` = the team that **owned** the destroyed building; `buildingType` ∈
  `{TOWER_BUILDING, INHIBITOR_BUILDING}`; `laneType` ∈ `{TOP_LANE, MID_LANE, BOT_LANE}`;
  `towerType` ∈ `{OUTER_TURRET 104, INNER_TURRET 67, NEXUS_TURRET 45, BASE_TURRET 43, '' 51}`
  (the 51 empty ones are exactly the 51 `INHIBITOR_BUILDING` events); `laneType` counts
  `MID_LANE 156, BOT_LANE 83, TOP_LANE 71`; `position` is an exact structure constant.
  Assists are clean.

Frame invariants verified across all 22 games:
- 0 frames have anything other than exactly 10 `participantFrames` (688/688).
- 0 events fall outside their containing frame's `(prevTimestamp, timestamp]` window.
- Dead players still receive a frame (position = fountain).

### 9.3 End-of-game `stats` fields worth using, and the dead ones

**Useful:** `kills, deaths, assists, goldEarned, goldSpent, totalMinionsKilled,
neutralMinionsKilled, champLevel, visionScore, wardsPlaced, wardsKilled,
visionWardsBoughtInGame, totalDamageDealtToChampions, totalDamageTaken,
damageDealtToObjectives, damageDealtToTurrets, timeCCingOthers, longestTimeSpentLiving,
largestKillingSpree, firstBloodKill, firstTowerAssist, win, item0..item6, perk0..perk5`.

**Verified dead / useless in the LCU payload:**
`neutralMinionsKilledEnemyJungle` (always 0), `neutralMinionsKilledTeamJungle` (always 0),
`sightWardsBoughtInGame` (deprecated), `combatPlayerScore` / `objectivePlayerScore` /
`playerScore0..9` / `totalPlayerScore` / `totalScoreRank` (Dominion leftovers, 0),
`dominionScore` / `teamScore` on frames (0), all `timeline.*PerMinDeltas` (empty `{}`),
`participantIdentities[].player.summonerName` (`""`) and `.accountId` (`0`).

**Note the typo in the API:** `teams[].firstDargon`, not `firstDragon`. It is spelled that way in
the payload.

---

## 10. Honest list of what I could not verify

| Item | Status | What the build must do |
|---|---|---|
| Minimap world bounds `(-120,-120)–(14870,14980)` | Orientation & y-flip **verified visually**; exact numbers **UNVERIFIED** | Least-squares fit the 12 turret anchors onto `map11.png` once; hard-code the result |
| Base respawn wait (BRW) table, TIF curve | **UNVERIFIED** — 1-min frames cannot measure a 20–50 s timer | Source from client data files or a maintained reference; pin per patch. Meanwhile ship the measured −418 g/90 s figure instead |
| First-spawn times (dragon 5:00, herald, grubs, baron 20:00) | Consistent with observed minima but **not proven**; respawn *intervals* (dragon 5:00, baron 6:00) are well supported | Derive per-patch minima from a growing corpus |
| Replay control API (`/replay/playback`, `/replay/render`, camera schema) | **UNVERIFIED** — returns 404 and is absent from the openapi listing during a live game | Enumerate `:2999/swagger/v3/openapi.json` *while a replay is playing* |
| Live Client Data API availability during replay playback | **UNVERIFIED** | Test once a replay can be started |
| Whether `killerId === 0` means execute/minion/turret | **UNVERIFIED** (observed but not attributed) | Handle `killerId === 0` explicitly rather than crashing |
| Champion-id → name mapping | not needed for this doc | DDragon `champion.json`, verified reachable |
| Generalisation beyond jungle | **The user is JGL in 22/22 games.** Every lane-phase number here is jungle-vs-jungle | Role inference is role-agnostic and 22/22 well-formed; the *thresholds* (CS@10 ≈ 64, camps/min ≈ 5.3) are jungle-specific and must not be applied to a laner |
| Sample independence | 22 games over 3 days, likely on tilt streaks | Treat consecutive games as correlated; do not compute a CI as if they were i.i.d. draws from "the user's true skill" |

Also worth flagging: **there is a live game in progress right now** (verified via
`:2999/liveclientdata/gamestats`, `gameTime = 1093.7 s`). All my LCU calls were read-only GETs;
nothing was launched, started, or modified.
