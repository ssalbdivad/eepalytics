# `src/capture` — replay capture

Screenshots and clips from the user's own games, rendered by the real League client driven
through its in-game Replay API on `127.0.0.1:2999`.

This is the riskiest code in the app: it takes over the user's game client. Everything here is
built to be **non-destructive** — it never edits `Game.cfg`, never kills by image name, never
starts without checking that the user is idle, and always tears the replay down in a `finally`.

> ## STATUS: the live path has NEVER been run
>
> The build phase was forbidden from launching a replay (the user might have been playing).
> Everything up to and including `preflight()` is verified against the live client; everything
> from `POST /lol-replays/v1/rofls/{id}/watch` onward is **written but unexecuted**. See
> [What is verified](#what-is-verified) and run [the first test](#running-the-first-test-safely)
> deliberately, with the user watching.

---

## Files

| File | What it owns |
|---|---|
| `types.ts` | Transport interfaces, Replay API response shapes, `CaptureError` + the closed failure-reason sets |
| `transport.ts` | Self-contained `curl.exe` transport (LCU + port 2999). Replaceable by `src/lcu/`'s bridge |
| `camera.ts` | **Pure.** World→camera math, the calibration object, render presets, `frameMoment()` |
| `launcher.ts` | Preflight, the launch state machine, `ReplaySession`, seek, teardown |
| `recorder.ts` | `screenshot()` / `clip()`, WSL↔Windows path bridge, PNG sizing, staging cleanup |
| `pipeline.ts` | `captureMoments()` — one launch, N moments, abortable |
| `manual-test.ts` | Guarded CLI that runs the §9 runtime-verification checklist |
| `capture.test.ts` | 50 tests. All pure or transport-mocked; **nothing here launches anything** |
| `../daemon/jobs/replay-capture.ts` | The intrusive job handler: gate → capture → job row |

---

## The state machine

`launchTransition()` in `launcher.ts` is a pure reducer, exported so it can be tested
exhaustively without a client. `launchReplay()` drives it with real I/O.

```
idle ──start──▶ preflight ──ok──▶ ensure-rofl ──file present──▶ ready
                    │                   │                          │
             refused│         unavailable│              POST …/watch│
                    ▼                   ▼                          ▼
                 failed              failed                    launching
                                                                   │
                                        watch left "None" ─────────┤
                                                                   ▼
                                                               api-wait
                                            GET :2999/replay/game 200
                                                                   ▼
                                                                  up ──teardown──▶ teardown ──▶ closed
```

`abort` is legal from every phase. From `launching` / `api-wait` / `up` it routes through
**teardown** — a process may exist and must be closed — and only then to `failed`. From
`preflight` / `ensure-rofl` it goes straight to `failed`, because nothing was spawned.
`closed` and `failed` are terminal: a poll result arriving late cannot resurrect the machine.

### Preflight (`preflight()`)

Re-reads every precondition from `.research/replay-capture.md` §6.1 immediately before acting,
even when the daemon's gate already said yes — the client's state can change in the gap between
the gate reading it and the worker acting on it. It refuses on: client unreachable,
`isPlayingGame`, `isPlayingReplay`, `isPatching`, not logged in, tournament, replays disabled,
gameflow phase outside the `None`/`Lobby` **allowlist** (unknown phases fail closed), a watch
already running, no `.rofl` on disk, or a patch mismatch against the `.rofl` header.

### Teardown

Three escalating levers, then **verification** — the app never assumes a POST worked:

1. `POST :2999/Exit`
2. *(nothing)* — there is no `/lol-gameflow/v1/watch/quit` in the LCU registry; only
   `/lol-gameflow/v1/spectate/quit`, which is for spectating.
3. `taskkill.exe /PID <processID from /replay/game> /F` — **never by image name**, which would
   kill a live game.

Then poll until `GET /lol-gameflow/v1/watch == "None"` **and**
`configuration.isPlayingReplay == false`. `session.close()` returns `false` if it could not
confirm, and `manual-test.ts` shouts about it. A leaked replay process blocks the user's next
game and is the worst bug this app could have.

Teardown deliberately ignores the abort signal: when the user starts queueing, closing the
replay is exactly the thing that must still happen.

---

## Failure modes

### Launch failures (`LaunchFailureReason`) — the session never came up

| Reason | Cause | Handling |
|---|---|---|
| `rofl-missing` | No `.rofl` on disk. Riot serves replays for ~30 min after a game | **Never retryable.** Game marked `replayState='expired'`; job completed with the reason on the row |
| `patch-mismatch` | `.rofl` patch ≠ client patch. Old replays die on patch day | **Never retryable.** Same treatment |
| `launch-timeout` | The client refused the watch, reported `WatchFailedToLaunch`, or the watch never left `"None"` | Retryable; `failJob` → backoff → terminal after 2 attempts |
| `api-timeout` | The game booted but `:2999/replay/*` never answered | Retryable. If it *persists*, see [EnableReplayApi](#if-replay-never-answers) |
| `aborted` | The user queued up, or Ctrl-C | Not a failure. `deferJob` + retry in 5 min; media already taken is kept |
| `gated` | Preconditions said no | `deferJob` + retry in 5 min (1 h when `captureEnabled` is off) |

### Per-moment failures (`CaptureFailureReason`) — the session was fine, one moment was not

`seek-timeout`, `record-timeout`, `record-rejected`, `no-output`, `read-failed`.
**These never throw out of `captureMoments()`.** A missing screenshot degrades the review; it
does not break it, because `media-generate` has already produced an SVG map image for every
moment. Failures are collected, counted, and written to the job row so the UI can explain why
there are no screenshots instead of showing an empty box.

---

## What is verified

Run read-only against the live client during the build (no launch):

- `curl.exe` interop transport, lockfile parsing, LCU basic auth — **working**
- `GET /lol-replays/v1/configuration`, `/lol-gameflow/v1/gameflow-phase`, `/lol-gameflow/v1/watch`,
  `/lol-replays/v1/metadata/{id}` → `{"state":"watch"}` — **working**
- ROFL2 header parse against the real 14,979,193-byte `NA1-5631300987.rofl` →
  `{gameVersion:"16.17.810.4348", patch:"16.17"}` — **working**
- `preflight(5631300987)` → `ok: true` — **working**
- 50 unit tests over the state machine, camera math, path bridge, PNG sizing, clip windowing,
  moment selection

### NOT verified — every one of these needs the first live run

1. **`POST /lol-replays/v1/rofls/{id}/watch`** and the whole launch path. Never executed.
2. **Time to first `/replay/game` 200.** Budgeted 15–30 s from a live-game boot log; the
   replay-specific part is a guess. `session.launchMs` records the real number.
3. **The camera axis mapping.** `camera.ts` assumes `{x: world.x, y: height, z: world.y}`
   (engine is Y-up), pitch on `cameraRotation.x`, pitch positive = looking down. All four are
   guesses, collected in one `CameraCalibration` object so a single measurement fixes them.
   Heights per moment kind and FOV 45 are reasoned defaults, not measurements.
4. **`selectionName`'s matching rule** — champion name, summoner name, or object name?
   `pipeline.ts` sidesteps it by resolving through `/replay/objects.characterName` first, but
   that round trip is itself unrun.
5. **Whether `startTime == endTime` yields 0 or 1 PNG frames.** We ask for a 0.05 s window and
   take the first file; the folder naming scheme is unknown.
6. **Whether `width`/`height` in the recording POST override the window size** or are read-only
   ("same as the game window size"). Screenshot dimensions are therefore read back out of the
   PNG's IHDR — real bytes, never the requested numbers. Clip dimensions fall back to what
   `GET /replay/recording` reports.
7. **Whether `POST /Exit` actually quits a replay.** Hence the taskkill fallback and the
   verification poll.
8. **Clock alignment.** `timeline.timestamp/1000 == Playback.time` is cross-checked against
   `gameDuration` in the research but never against a live replay. `manual-test.ts` step 8
   re-checks it against a known `ChampionKill`; if there is a constant offset you will see it
   immediately.
9. **Precedence of `interfaceAll` vs the individual `interface*` flags** in one POST. We send
   the master switch in its own request first, so the result is defined either way.
10. **Windowed / background capture.** Not attempted. See [below](#it-cannot-run-while-you-play).

---

## Running the first test safely

`manual-test.ts` is the supervised first run. It refuses without an explicit flag, refuses if
the client is not idle, saves every raw response, and tears down in a `finally`.

**Before you start**

- Be at the client's home screen or in a lobby. **Not** in champ select, not queued.
- The replay will take the whole screen (`WindowMode=2` → Borderless on this machine). Expect
  to lose focus for a minute.
- Have the client visible on a second monitor if you have one.

**Dry run first — read-only, launches nothing:**

```bash
node --experimental-strip-types --no-warnings=ExperimentalWarning \
  -e 'const {preflight}=await import("./src/capture/launcher.ts");
      const {curlClients}=await import("./src/capture/transport.ts");
      console.log(await preflight(5631300987, curlClients()))'
```

Expect `ok: true`, `phase: "None"` or `"Lobby"`, `watch: "None"`, `roflPatch === clientPatch`.
If it says anything else, fix that first — the launch will refuse for the same reason.

**Then the real thing:**

```bash
node --experimental-strip-types --no-warnings=ExperimentalWarning \
  src/capture/manual-test.ts --game 5631300987 --at 1042 --yes-launch-a-replay
```

Add `--capture` once the first pass looks right, to also record one PNG and one 10 s webm.

**What to watch for, in order**

1. `[preflight] idle, replay on disk, patch matches` — then the game window appears.
2. `Replay API up after N ms` — **write N down**; it is the only real measurement of the launch
   budget. If this never prints, see below.
3. `saved replay-openapi.json` — this is the prize. It contains the authoritative `/replay/*`
   schemas and resolves items 3–6 above in one file. Copy it into `.research/`.
4. `camera-calibration-samples.json` — three paired samples of `cameraPosition` against the
   followed champion's `position`. Two or three settle the axis order, the sign of pitch, and
   the height/pitch the game's own directed camera uses. Put the measured values into
   `DEFAULT_CAMERA_CALIBRATION` (or the `capture.cameraCalibration` kv row) and set
   `verified: true`.
5. `clock-alignment.json` — `requested` vs `landed` vs the `eventdata` timestamps.
6. `11. teardown` → `client is out of the replay`. **If it says `COULD NOT CONFIRM TEARDOWN`,
   close the replay by hand before doing anything else.**

Everything lands in `data/logs/replay-probe-<gameId>/`.

**How to abort**

- **Ctrl-C** in the terminal. SIGINT is trapped, the abort propagates through every wait, and
  teardown still runs. It is safe.
- **Just start queueing.** The daemon's abort rules (A1–A5) fire the same signal within a
  second, `captureMoments` bails between moments, and whatever was already captured is kept.
- **Worst case:** close the replay from the client's own UI, or
  `/mnt/c/WINDOWS/system32/taskkill.exe /PID <pid> /F` with the PID from `/replay/game`.
  Never `taskkill /IM "League of Legends.exe"` — that is also the name of a live game.

### If `/replay/*` never answers

The game reads a flag called `EnableReplayApi` out of its command line pool. It is not in
`Game.cfg`'s key pool and not in `LeagueClient.exe` at all, so its source could not be
determined statically. In order:

1. Most likely the API is simply on by default and something else is wrong (check
   `data/logs/replay-probe-*/replay-game.json` for the raw status).
2. `POST /lol-gameflow/v1/extra-game-client-args ["-EnableReplayApi=true"]`, relaunch, and
   **`POST … []` afterwards to restore.**
3. Add `EnableReplayApi=1` under `[General]` in `Config/Game.cfg` — **back it up first**, and
   never while the game is running. The client live-edits that file.

---

## It cannot run while you play

There is one client and one game process. `isPlayingGame` and `isPlayingReplay` are the
client's own locks, and a replay is a full 3D render of Summoner's Rift that would cost real
frames in a live game even if the locks did not exist.

So capture is **deferred, not background**: the daemon queues it and drains it while the user
is in the lobby. `settings.captureEnabled` defaults to **false**; the honest UI copy is
*"Analysis runs between games — I'll have them ready next time you're in the lobby."*

`replay-download`, by contrast, is **not** intrusive and is **urgent**: replays expire ~30 min
after a game ends. That job is a different unit and runs immediately, even mid-champ-select.

---

## A note on `fogOfWar: false`

`COACHING_SCENE` disables fog of war, which is the one thing a normal replay watcher cannot
do — it shows what the enemy was actually doing while the user could not see them. That makes
every screenshot a **God's-eye view, not what was on screen at the time**. The UI must label
captures accordingly, and the coaching prompt must not say "you saw" about anything only the
fogless render reveals.
