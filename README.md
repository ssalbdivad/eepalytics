# eepalytics

A local League of Legends coaching app for one jungler.

It watches your League client, pulls each finished game out of the client's own API,
compresses the match and its timeline into a compact digest, and asks Claude for feedback
that is **bound to real timestamps** — so every point it makes is something you can jump to,
see on the map, and, if you were screen-sharing at the time, look at your own screen from the
second it happened.

The coach is **Coach Lillia**, who has watched every LCK game since 2013, has strong
opinions about your pathing, and will not shut up about Oner. She roasts you constantly and
never makes you feel bad about playing. Her personality lives in [`AGENTS.md`](AGENTS.md) and
you can edit it without touching a line of code.

Everything runs on your machine. No account, no telemetry.

**One exception, and it is opt-in: the live voice coach.** If you turn it on, your shared
screen and — only while you hold the mic — your voice are streamed to Google's Gemini Live
API for as long as it is running. Nothing else in the app uploads anything, the feature is
off until you paste an API key, and the app says so on the screen where you start it. If you
never touch it, the original claim stands unchanged.

---

## Quickstart

```bash
pnpm install
pnpm doctor          # preflight — tells you what is missing and how to fix it
pnpm seed            # pull your recent games out of the running client
pnpm dev             # daemon on :7700, UI on :7701
```

Then open <http://127.0.0.1:7701> — **including from Windows**, in the browser you alt-tab
to while playing. Both the daemon and the dev server bind `0.0.0.0` when they detect WSL,
because a WSL loopback bind is not reachable from the host at all (`curl.exe` to
`127.0.0.1:7700` answers `000`); WSL2 then maps Windows' own localhost into the VM. WSL2's
adapter is host-only NAT, so this means "this PC", not your LAN. Set `CSK_HOST=127.0.0.1`
to force loopback-only.

`pnpm seed` is optional but nice on day one: the client only offers a ~20-game window, and
seeding grabs all of it immediately instead of waiting for the daemon to notice your next
game ending.

---

## The screens

### 1. Live — coach me while I play

Share your screen and she talks to you out loud while you play, about a second behind.

She is not guessing from pixels. The daemon reads your League client and computes a **data
brief** — both rosters, levels, items, who is dead and for how long, the score, your gold, your
farm against your own average, the objective clocks, and how many seconds away each pit is — and
every number she says has to be in it. The screen tells her *where things are*; the brief tells
her *what is true*. Given pixels alone, an earlier version named a champion who was not in the
game four times in seven minutes.

What she says is **her call, not a script**. An earlier version could only read out lines this app
had computed and ranked first, and it was safe and nearly silent: fourteen lines in 576 turns, six
of them in the whole first seven minutes. Removing the menu while keeping the citation rule
multiplied useful output thirteen-fold with the same zero fabrication rate.

**When** she speaks is the part that is computed. She is not on a timer — a turn fires when the
game actually moves and a decision is still open, because a coach asked eighty-five times a game
has to find eighty-five things to say, and it runs out and starts reading your HUD back to you.

Two fields from the League client are quietly wrong and the app refuses to show you either: the
enemy jungler's CS is a count of what *your* team watched him kill (measured at 70 against a true
183), and an item's listed price recovers about a quarter of what anyone actually spent.

Check it works before a game with `pnpm smoke:live` — it walks the whole path (key → token →
League client → socket) and tells you which step broke.

**Setup:** it needs a free [Google AI Studio key](https://aistudio.google.com/apikey). Paste it
into the panel on the Live screen — the instructions are right there. The key is stored in
`data/gemini.key` (0600) and never reaches the browser: the daemon swaps it for a token that
works for one session. There is no "sign in with Google" because the Live API takes a key and a
Gemini subscription does not include API access.

**On WSL:** screen sharing cannot work in the Electron window — WSLg's compositor contains only
Linux windows, so it cannot see League at all. Pressing *Share my screen* there opens the page in
your Windows browser instead, which can.

### 2. Games

Your recent games, newest first. One row per game: champion, role, W/L, duration, queue, and
the line that matters — `7/4/12 · 187 CS (4.9/m) · VS 34 · DMG 24%`.

Each row also shows what the app is *doing* about that game, which is the difference between
"this is broken" and "this is being polite":

- `▸ Review ready · 4 items ⚑2 major`
- `◷ Reviewing…` with a progress bar
- `⧗ replay 22m left` — a live countdown to the 30-minute replay expiry

### 3. Game review — the main screen

Four panels sharing **one cursor**: a single timestamp. Click a feedback card, a map marker,
or a point on the timeline and all four react together.

- **Map** — a Summoner's Rift minimap with every moment plotted at its real coordinates.
  Deaths, kills, objectives, and positioning notes, filterable.
- **Feedback** — the coaching itself. Each card is a roast, a real number, and a fix, with
  `[Jump to 08:12]` and `[Show on map]`.
- **Media** — a drawn Rift map for every moment, plus the real frame of your own screen when
  you were sharing it. The map is always there; the screen frame is the bonus.
- **Timeline** — a scrubber with markers and a gold-differential sparkline.

Underneath: your metrics with bands relative to **your own** rolling baseline, not a
stranger's — `CS@14 112 ▲good · GD@15 +340 ▲good · VS/min 0.88 ▼low`.

### 4. Queue

Every job the daemon has run, is running, or is refusing to run *and why*:

```
QUEUED
 ⧗ replay.download  Lillia 18:06
   Expires in 22 min — the client deletes the replay 30 minutes after the game.
```

This screen exists so "why is nothing happening" never requires a log dive.

### 5. Settings

Model choice, auto-review rules, the live coach's model and mode, retention, and a live
daemon/client/bridge status block with a **Doctor** button.

---

## Architecture — and why it looks like this

The app runs in **WSL2**. League runs on **Windows**. That one fact shapes everything.

WSL2 here is in NAT networking mode, so **WSL's `127.0.0.1` is not Windows' `127.0.0.1`**.
A native `fetch` or `curl` from Linux to the League Client API returns HTTP 000 — not a
timeout you can tune away, just nothing. Every byte of League data has to cross through
Windows interop.

```
  ┌─────────────────────── WSL2 (Linux) ────────────────────────┐
  │                                                             │
  │   Vite dev server  :7701 ──proxy──┐                         │
  │                                   ▼                         │
  │   React UI ◀────── SSE ────── Hono HTTP  :7700              │
  │                                   ▲                         │
  │                             ┌─────┴──────┐                  │
  │                             │   daemon   │                  │
  │                             │ jobs·journal│                  │
  │                             └─────┬──────┘                  │
  │                    ┌──────────────┼──────────────┐          │
  │                    ▼              ▼              ▼          │
  │              SQLite + gz     claude CLI     bridge client   │
  │              (node:sqlite)   (Agent SDK)          │         │
  └───────────────────────────────────────────────────┼─────────┘
                                    NDJSON over stdio │
  ┌─────────────────────── Windows ──────────────────▼──────────┐
  │                                                             │
  │   node.exe bridge ──HTTPS keep-alive──▶ LeagueClient  :RANDOM│
  │        │                                (lockfile port)     │
  │        └──────────────────────────────▶ Live game    :2999  │
  │                                          (only mid-match)   │
  │   fallback: curl.exe -K -   (~88 ms/request instead of ~2)  │
  └─────────────────────────────────────────────────────────────┘
```

**Measured on this machine:** the stdio bridge does a round trip in **p50 2.6 ms**. Spawning
`curl.exe` once per request costs **~71 ms**. Both work; the bridge is the default and curl is
the automatic fallback when Windows Node is missing.

The League client's port and password rotate on every restart. Both live in
`…/League of Legends/lockfile` (`name:pid:PORT:PASSWORD:https`, **no trailing newline** — a
bash `read` returns non-zero at EOF on it). The bridge reads that file inside the Windows
process, so the password never appears in an argv, an environment variable, or anything the
app writes to disk.

### What the app writes to the client

Almost nothing. History, timelines, champion data and gameflow state are all `GET`s. There is
exactly one exception — the replay download (`POST /lol-replays/v1/rofls/{gameId}/download`) —
and it opens no window, launches nothing and is safe to run while you are mid-game. **Nothing
the app does can take over your screen**, which used to require a nine-condition idle gate and
now requires nothing, because the one feature that needed it is gone (see Limitations). `pnpm
doctor` and `pnpm seed` are `GET`-only by construction and are safe to run mid-match.

### Where things live

```
src/shared/   types + pure helpers, browser-safe   (schemas, map math, time)
src/db/       SQLite: migrations, queries, blobs   (all SQL lives here)
src/lcu/      Windows-interop transport + clients
src/rofl/     ROFL2 replay-file decoding
src/knowledge/champion notes, loaded into reviews  (editable markdown, no code change)
src/analysis/ metrics, moments, digest             (no LLM, no I/O)
src/review/   the Claude coaching engine + persona loader
src/daemon/   job queue, poller, journal            (owns every side effect)
src/server/   Hono HTTP + SSE
src/web/      React UI
scripts/      doctor, seed, service install
```

Data goes in `data/` by default (`CSK_DATA_DIR`): `csk.db` plus `blobs/<gameId>/*.json.gz`
holding the raw match and timeline verbatim, so re-analysis never needs the client again.

---

## Running it in the background while you play

```bash
pnpm service:install                 # writes ~/.config/systemd/user/eepalytics.service
systemctl --user enable --now eepalytics
pnpm service:logs                    # journalctl -f
```

The unit uses `Restart=always` and logs to the journal. Lingering
(`sudo loginctl enable-linger $USER`) lets it start without an interactive login.

**One honest caveat:** lingering starts the unit once the WSL VM is up, but it cannot make
WSL boot. If you want the daemon running from Windows login, add a Windows startup task:

```
wsl.exe -d Ubuntu -u <you> --exec /bin/true
```

While the daemon is running, ingest is fully automatic — a game ends, it appears in the list,
and its replay is downloaded before the 30-minute window closes. **Nothing interrupts you, and
now nothing can:** the one job that ever took over the machine, replay capture, is gone (see
Limitations), so no job the daemon runs can put a window on your screen.

---

## Editing the coach

The persona is section "Part 2 — Coach Lillia" in [`AGENTS.md`](AGENTS.md), between the
`<!-- COACH:BEGIN -->` and `<!-- COACH:END -->` markers. It is read at runtime and sent as the
system prompt for every coaching call. **Edit the file, get a different coach — no code
change, no rebuild.**

Worth knowing before you rewrite it:

- The rules in there are not decoration. "Never fabricate a stat" is also enforced
  mechanically — a feedback item citing a moment or metric that does not exist is rejected
  before it reaches the UI.
- Every feedback item must carry a timestamp. An item without one cannot be bound to the map,
  the timeline, or a frame of your screen, and the UI has nowhere to put it.
- `coachIntensity` in Settings scales how hard he goes. The floor is still "encouraging".

Keep the markers. Losing them silently degrades every review, which is why `pnpm doctor`
checks for them.

---

## Settings

| Setting | Default | What it does |
|---|---|---|
| `model` | `claude-sonnet-5` | Which model writes the reviews |
| `autoReviewNewGames` | true | Review each game as it finishes |
| `gamesForTrends` | 20 | How many games feed the cross-game goals |
| `retentionDays` | 14 | When `.rofl` files get pruned |
| `coachIntensity` | 0.8 | How hard the roast goes (0–1) |
| `transport` | `bridge` | `bridge` (fast) or `curl` (no Windows Node needed) |
| `pollIdleMs` / `pollInGameMs` | 5000 / 2000 | Gameflow poll cadence |
| `maxMomentsPerGame` | 12 | Cap on selected teachable moments |

Environment overrides live in `.env` — see [`.env.example`](.env.example).

---

## Limitations

These are real, they are measured, and the app is built to tell you about them rather than
paper over them.

**Timeline resolution is one frame per minute.** That is the single biggest constraint in the
product. The median distance a player moves between two consecutive frames is **4082 units —
about 28% of the map**. Anything about *where you were between frames*, or *who was standing
near you*, is interpolation, and interpolation is a guess. Presence detection tops out around
**65% sensitivity** no matter how clever the maths. So the app says "likely alone" and marks
the moment `confidence: low`; it does not say "you were alone." If a claim in a review reads
as hedged, that is the hedge doing its job.

**The client only gives you ~20 games, and there is no pagination.** `begIndex`/`endIndex` on
match history are accepted and then silently ignored — every range returns the same recent
window. The size is chosen server-side and has been observed shrinking from 21 to 5 mid-game.
The workaround is exactly what the daemon does: poll, union the game ids into SQLite, and keep
them forever. **A fresh install can never backfill more than the current window.** Individual
matches and timelines stay fetchable by id for at least 21 days, so nothing already recorded
is lost.

**Replays expire ~30 minutes after a game ends.** The client's own configuration says
`minutesUntilReplayConsideredLost: 30`. Miss the window and the `.rofl` is gone permanently —
there is no re-download. This is why the daemon queues the download immediately and why the UI
shows a countdown. If the daemon was not running when you played, that game has no `.rofl` at
all. Its stats, timeline, map and coaching all still work.

**A `.rofl` from an older patch will not play.** Playback needs a matching game version and a
matching network-protocol digest, so plan for a hard expiry of roughly one patch cycle (~2
weeks). The app keeps the file for the decoder's sake, not to play it back.

**Replay capture was removed, and the number is why.** The app used to launch the replay client,
drive its camera and cut screenshots and clips. Over its entire recorded life it produced **zero
finished jobs — four expired, two failed — and not one screenshot on disk.** The camera would not
reliably follow the player, and because it took over the machine it was only allowed to run while
you were idle, which is exactly when you sit down to play, so it fired hours late or never. What
replaced it is better on both counts: every moment gets a Rift map drawn from the timeline, which
never fails and needs nothing running, and the live coach's screen share writes the real frames of
**your own screen** as you play — which by construction cannot point the camera at the wrong place.

**The timeline is missing data Riot's public API has.** No item purchases, no ward placements,
no skill-ups, no per-minute damage or champion stats — only kills, elite monsters, buildings,
and per-minute gold/xp/cs/position. The `.rofl` does not have them either (its payloads are
opaque engine netcode). So the coach will tell you it cannot grade your itemization rather
than inventing a build path.

**Some upstream fields are simply wrong, and are ignored.** `timeline.lane` / `timeline.role`
labelled four of ten players `JUNGLE` in one checked game, one of them with 273 lane CS —
roles are inferred from frame positions plus Smite instead, which produced a well-formed
five-role set for both teams in every game tested. `ELITE_MONSTER_KILL.assistingParticipantIds`
is ~19% cross-team corrupt; only `killerId` is trusted.

The **live** client feed has its own two. `scores.creepScore` is rounded down to a multiple of
ten for everyone, so it is a floor and never a count; and for the enemy *jungler* it is not his
farm at all but a count of what your own team witnessed — across fifteen paired games it is exact
in 3.3% of checkpoints against 90.6% for enemy laners, and the worst-corrupted row belongs to the
smite holder in fifteen of fifteen. An item's `price` is its own cost line rather than the recipe
total, so summing a player's items recovers about a quarter of what he really spent and the total goes
*down* when he upgrades. Neither figure is shown to you or to the coach.

**Small-sample trends are not significant, and are labelled as such.** Twenty games is not
enough to prove most of what people claim about their own play. Metrics that are stable enough
to trend get trended; the rest are shown with their confidence interval, or with a note saying
one game is not a pattern. You will see "suggestive" more often than "proven". That is
deliberate.

**One user, one account.** Paths, PUUID and platform are configured for a single player.

---

## Troubleshooting

Start here, always:

```bash
pnpm doctor
```

It checks the Node version, `node:sqlite`, zstd, the data directory and free space, database
integrity and schema version, the League install, the lockfile (present? stale?), the replay
folder (and decodes the newest `.rofl` to prove the decoder works), Windows `node.exe` and
`curl.exe`, **both transports with measured latency**, the `claude` CLI and its login, the
coach persona markers, and the systemd unit. Every failure prints a fix. It exits non-zero if
something critical is broken, and `--json` gives you the same thing machine-readable.

Common ones:

| Symptom | Cause | Fix |
|---|---|---|
| `no lockfile — the League client is not running` | Client closed | Not an error. Everything already ingested still works. |
| `Lockfile STALE — PID … is gone` | Client crashed without cleanup | Delete the lockfile or restart League |
| `Bridge transport: no Windows node.exe found` | Windows Node missing | Install from nodejs.org, or accept the ~35× slower curl fallback |
| `HTTP 000` anywhere | Something bypassed the bridge and used Linux `fetch`/`curl` | That path is unfixable by retrying — it must go through interop |
| `client is running but no transport reached it` | `/mnt/c` not mounted, or a stale port | `ls /mnt/c`, then restart the client |
| Reviews never start | No `claude` CLI and no `ANTHROPIC_API_KEY` | Install Claude Code and log in |
| `Cannot find type definition file for 'node'` from `pnpm typecheck` | `@types/node` not installed | `pnpm add -D @types/node` |

### Reading a replay file directly

The `.rofl` decoder works with the client closed and with no network — it is the offline
fallback for a game the client no longer remembers:

```bash
pnpm rofl "/mnt/c/Users/<you>/Documents/League of Legends/Replays/NA1-5631300987.rofl"
```

```
  gameId          5631300987
  gameVersion     16.17.810.4348   patch 16.17
  gameLength      1849550 ms  (30.83 min)
  file            14979193 B, read 123207 B (0.8%)
  players         10, 371 stat fields each

Scoreboard:
  Gooskaffur#NA1     Lillia    team=200 JUNGLE  21/0/4  camps=203  gold=21164 vs=32 Win
  …
```

It reads the header and the trailing metadata only — 0.8% of a 15 MB file — and gets you the
patch, the game length, and the full 371-stat end-of-game scoreboard for all ten players
including everyone's PUUID. Add `--full` to walk and decompress the whole segment table.

Two things it cannot give you, by design of the format rather than of this code: the `gameId`
(it is not in the file — it comes from the `<platform>-<gameId>.rofl` **filename**, so never
rename a replay) and anything positional. Chunk and keyframe payloads are delta-encoded engine
netcode with no strings and no floats at any stable alignment; reading them would mean
reimplementing Riot's object model, and it changes every patch. Positions come from the
client's timeline endpoint instead.

---

## The artwork

`public/lillia-art.png` is the single source. `pnpm icon` crops her face for the app icon and the
avatars you see beside her coaching, and downscales the whole illustration for the splash that
shows while the app starts. Replace that one file and re-run it to change her everywhere.

It writes into two public directories on purpose: Vite serves `src/web/public`, and Electron reads
its window icon from the project's own `public/`. Writing to only one of them looks entirely
successful and changes nothing you can see.

## Development

```bash
pnpm dev            # vite :7701 + daemon :7700, both watching
pnpm daemon         # daemon only
pnpm seed --help    # see the flags: --limit, --games, --force, --dry-run, --curl
pnpm test           # node:test
pnpm typecheck
```

TypeScript runs directly under `node --experimental-strip-types` — there is no server build
step. That means **type-only syntax only**: no enums, no namespaces, no parameter properties,
no decorators, `import type` for types, and relative imports between `src` files carry the
`.ts` extension.

Style is tabs, double quotes, no semicolons. Contributor guidance — including the rules about
never fabricating a stat and always labelling uncertainty — is in [`AGENTS.md`](AGENTS.md),
which Claude Code, Codex and Cursor all read.
