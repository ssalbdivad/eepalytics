# scripts/ — one instrument per question

Every file here exists to answer ONE question, and its header says which. This map is the
index, and it is here for a specific failure: on 2026-09-05 two agents measured the same
thing with two different harnesses and got two different answers, and on 2026-09-10 a bench
scored a coach the app does not run. Both were caused by a new file being easier to write
than an old one was to find.

**Before adding a script, find the question below.** If it is already here, extend that file.
If the new question is really a new one, add a row.

---

## The live coach

| file | the question it answers |
|---|---|
| `bench-stream.ts` | **THE live bench.** Replay one real game's recorded client samples and paired frames at every model at once: what did each say, how fast, and how does it score on the six axes? Arms, `@mode` architectures, `+noframe` twins, event or timer schedules, blinded sheet. |
| `frame-value.ts` | What is the screenshot worth, and is it read at all? The only PAIRED test in the repo (McNemar), because two independent Wilson intervals at n=30 call almost anything "not separated". |
| `ablate-autonomy.ts` | What does the FENCE cost? The four-architecture ablation. Also the byte-for-byte pin that `src/shared/live-coach-mode.test.ts` holds the two old coach modes (`fenced`, `cite-or-quiet`) to — **do not delete it without moving that pin.** |
| `eval-useful.ts` | Is the coach USEFUL, not merely true? The 2026-09-05 six-axis driver. Superseded as an instrument by `bench-stream`; its scoring now ships in `src/analysis/useful.ts`. |
| `e2e-coach.ts` | Would the coach say the thing the owner quit on? Audits a transcript against the named defects. |
| `e2e-real-game.ts` | One real game, one checkpoint at a time, through the real pipeline — and owns the fixture format that `data/eval/fixture-*.json` is written in. |
| `probe-vision.ts` | Does the picture reach the model at all, as opposed to being ignored downstream? |
| `bench-events.ts` | How many times would the coach be ASKED? The event detector against the fixed timer, over a whole game. Free — no model. |
| `measure-staleness.ts` | Is a line still TRUE when its last syllable lands? |
| `measure-speech.ts` | Does the coach SAY it right? The only instrument that reads AUDIO rather than text. |
| `smoke-live.ts` | Is the live coach working RIGHT NOW? Key, token, ground truth, socket, one real turn — names the step that failed. |

## Post-game review — one chain, five stages, in order

| file | the question it answers |
|---|---|
| `game-pack.ts` | **Stage 1.** What is TRUE about one game? Assembles the whole-game evidence pack from the DB, the raw samples, the minimap track and the transcript. No model, no judgement. |
| `minimap-track.ts` | **THE minimap tool.** Where was he, for a whole game, read off the minimap offline. Feeds stage 1. |
| `postgame-bundle.ts` | **Stage 2.** FREEZE that pack into `bundle-<gameId>/` with a sha256 manifest, so two arms an hour apart provably read the same bytes. |
| `postgame-arm.ts` | **Stage 3.** One model, one call, over the frozen bundle. |
| `review-incumbent.ts` | **Stage 3, baseline arm.** The SHIPPED reviewer with the latency constraint removed — what the pack has to beat. |
| `postgame-sheet.ts` | **Stage 4.** The arms' items, blinded, as one page he can grade. |
| `probe-minimap.ts` | What can actually be read off a minimap crop, with accuracy numbers? The measurement behind `minimap-track`'s confidence. |

## Grading and reading stored runs

| file | the question it answers |
|---|---|
| `lib/sheet.ts` | **THE sheet builder.** The blinded human grading sheet as one HTML file, plus its key and the reveal. Three callers: `bench-stream`, `frame-value`, `postgame-sheet`. Never write a second one. |
| `blind-judge.ts` | The reader for the 2026-09-05 ablation corpus (`ablation-*.json`, `blind-*.json`), and the seeded shuffle every sheet imports. |
| `rescore-runs.ts` | What did a stored run SAY, and how does it score against today's scorer? The reader for the ~30 `run*/final*/confirm` files from 2026-09-04 whose writer (`eval-live.ts`) was deleted. |
| `audit-citations.ts` | Do the reviews already in the database pass the citation and baseline checks? |
| `audit-live-fields.ts` | Does every field the live brief renders match the exact post-game truth? (This is the one that caught `scores.creepScore` being visibility-limited.) |

## The shared library — put it here, not in a harness

| file | what it owns |
|---|---|
| `lib/stream.ts` | **THE join.** Which frames on disk go with which raw samples, and the rebuild of the block the coach actually held. Also the ONE `readVerbatim` / `baselineDuring` / `coachStateFrom` / `championVocabulary`. Five harnesses each did this join by hand once and each got a different answer. |
| `lib/win-lcu.ts` | The GET-only Windows-interop LCU reader for `scripts/`, kept separate from `src/lcu/` so `doctor.ts` can diagnose an app that will not import. |

## Operations — not measurement

| file | what it does |
|---|---|
| `doctor.ts` | `pnpm doctor`. The preflight you run when something is wrong. Every failing check prints a FIX. |
| `dev-seed.ts` | `pnpm seed`. Populate the DB with real recent games. GET only. |
| `check-patch.ts` | Is the champion knowledge stale against the live patch? |
| `research-champion.sh` | Research one champion's notes into `knowledge/champions/`. |
| `run-daemon.sh` · `install-service.sh` | The `systemd --user` launcher and its installer. |
| `dev-daemon.sh` | Restart the daemon detached from this shell, for development. |
| `make-icon.mjs` · `shoot.mjs` · `voices.mjs` | Artwork, screenshots, and the browser voice list. |

---

## Two rules that are not negotiable

1. **A stored run stays re-scorable.** Deleting a harness is fine; deleting the only thing that
   can READ what it wrote is not. `rescore-runs.ts` exists because that rule was broken once.
2. **The library does not import a harness.** Until 2026-09-11 `lib/stream.ts` imported
   `readVerbatim` from `e2e-real-game.ts` and `coachStateFrom` from `eval-useful.ts` — two
   superseded drivers that four other files therefore depended on. Shared code goes DOWN into
   `lib/`, and the harness re-exports it if a test in `src/` pins it there.
