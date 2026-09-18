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
| `frame-value.ts` | What is the screenshot worth, and is it read at all? Paired throughout (McNemar, from `lib/stats.ts`), because two independent Wilson intervals at n=30 call almost anything "not separated". |
| `bench-events.ts` | How many times would the coach be ASKED? The event detector against the fixed timer, over a whole game. Free — no model. |
| `measure-staleness.ts` | Is a line still TRUE when its last syllable lands? |
| `measure-speech.ts` | Does the coach SAY it right? The only instrument that reads AUDIO rather than text. |
| `attribute-sections.ts` | **Which part of the PAYLOAD produced the line?** Joins every graded line back to the exact payload the coach held, cuts that payload into channels, and reports each one's presence, character cost, redundancy and the phrase/subject tests over what was actually said. Its own header carries the retraction that matters: exclusive number provenance does NOT work on this payload, and the file says why at length. Free — no model. |
| `smoke-live.ts` | Is the live coach working RIGHT NOW? Key, token, ground truth, socket, one real turn — names the step that failed. |

**Five harnesses were retired here on 2026-09-11** — `ablate-autonomy.ts`, `eval-useful.ts`,
`e2e-coach.ts`, `e2e-real-game.ts` and `probe-vision.ts`. Every one asked a question
`bench-stream.ts` now asks on better inputs, and every one was being kept alive only by a test in
`src/` that imported it as source. What survived them, and where it went:

- the four measured **architectures** are data in `src/review/ablation-arms.ts`, still pinned
  byte-for-byte by `src/shared/live-coach-mode.test.ts` — a reword of a legacy prompt still fails
  the suite;
- `coachStateFrom` was already in `lib/stream.ts`; its tests came with it into `lib/stream.test.ts`;
- the four stored `e2e-real-game-run` files got the reader they were owed,
  `read-frame-ablation.ts`, on the same principle as `rescore-runs.ts`;
- the four stored `ablate-autonomy` runs were already readable by `blind-judge.ts`.

What did NOT survive, said plainly: `e2e-coach.ts`'s transcript audit (`artefactsIn`,
`contextOnlyNumbers`) checked the FENCED block's furniture — a respelling or a `CONTEXT ONLY`
figure read out loud — and the shipped `trusted` mode sends neither the pronunciation table nor
that marker, so those checks had no live subject left. Nothing grades an abbreviated unit
mechanically any more; `judge-corpus.ts` catches it as a judge would.

## Post-game review — the model comparison (stages 1-4), then the shipped path

| file | the question it answers |
|---|---|
| `game-pack.ts` | **Stage 1.** What is TRUE about one game? Assembles the whole-game evidence pack from the DB, the raw samples, the minimap track and the transcript. No model, no judgement. |
| `minimap-track.ts` | **THE minimap tool.** Where was he, for a whole game, read off the minimap offline. Feeds stage 1. |
| `postgame-bundle.ts` | **Stage 2.** FREEZE that pack into `bundle-<gameId>/` with a sha256 manifest, so two arms an hour apart provably read the same bytes. |
| `postgame-arm.ts` | **Stage 3.** One model, one call, over the frozen bundle. |
| `review-incumbent.ts` | **Stage 3, baseline arm.** The SHIPPED reviewer with the latency constraint removed — what the pack has to beat. |
| `postgame-sheet.ts` | **Stage 4.** The arms' items, blinded, as one page he can grade. |
| `probe-minimap.ts` | What can actually be read off a minimap crop, with accuracy numbers? The measurement behind `minimap-track`'s confidence, and the one question `bench-stream` cannot ask — it CONSUMES a minimap read and never grades one. Scorer pinned in `probe-minimap.test.ts`. |

The four stages above are a CONCLUDED comparison: five models over one frozen bundle, indistinguishable
on the blinded grading and separated only on the clock (flash 38-43 s against opus 330 s). That result is
what `src/review/postgame-call.ts` ships. The stages stay because `data/eval/bundle-5639406342/` and the
arms' outputs are on disk and rule 1 below applies to them.

The two below are not stages. They are the shipped path and its clock.

**`tl-pack.ts` and `tl-review.ts` were deleted on 2026-09-12.** They were an untracked prototype of
"the pack the timeline alone can back, and one review call over it" for the 31 of 32 recent games with
no journal session. That is exactly what `src/review/pack.ts` (`buildGamePack` / `renderPack`,
`PACK_VERSION 2`, pinned by `src/review/pack.test.ts`) and `src/review/postgame-call.ts` now do, inside
`runGameReviewJob` rather than beside it — so the prototypes were a second answer to a question the
shipped path had already taken over. Neither had ever written an artefact: `data/eval/tl-packs/` and
`data/eval/tl-reviews/` do not exist, so rule 1 had nothing to protect. **If you want a timeline-only
pack, call `buildGamePack`.**

| file | the question it answers |
|---|---|
| `backfill-reviews.ts` | NOT an arm — the SHIPPED reviewer (`runGameReviewJob`, unmodified) run over the games that never got one, resumable off the database rather than a state file. |
| `measure-postgame.ts` | How long after a game ends can he read anything? The four-stage wall clock from `game.endedAtMs` to `review.createdMs`, from rows the daemon already writes. |

## Does it make him CLIMB? — the only instruments that ask about the GAME, not about a line

Everything above grades what the coach SAID. These two ask whether the thing it points him at
distinguishes the games he wins, which is a different question and had never been asked until
2026-09-18.

| file | the question it answers |
|---|---|
| `what-wins.ts` | **WHICH of his numbers separate his wins from his losses?** 78 features over 138 ranked games, Mann-Whitney with bootstrapped AUC, BH q-values, a logistic control on the 10-minute team gold difference, and an even-at-ten stratum. The measurement that retired CS@10 as a coaching priority and nominated the two habits below. `data/eval/what-wins-20260918.json`. |
| `habit-record.ts` | **How is he doing at the one behaviour that separates them?** The habit tracker's own record from the CLI, no server and no model — streak, Wilson interval, and whether the rate is distinguishable from noise. Same pure module the card renders (`src/analysis/habit.ts`), so the screen and the CLI cannot disagree. `--out` freezes a baseline; `data/eval/habit-baseline-20260918.json` is ship day. Reproduces `what-wins`' counts exactly: 53 clean 10:00-15:00 windows of 138, 64 of 138 ahead on early objectives. |

## Grading and reading stored runs

| file | the question it answers |
|---|---|
| `lib/sheet.ts` | **THE sheet builder.** The blinded human grading sheet as one HTML file, plus its key and the reveal. Three callers: `bench-stream`, `frame-value`, `postgame-sheet`. Never write a second one. |
| `judge-corpus.ts` | Grades every line a `bench-stream --games ...` run spoke, blinded and shuffled, and reports useful/false/generic PER GAME as well as pooled. Judges against the stored PAYLOAD only, because 13 of the 17 games have no frames — so its false rate is a floor, not the truth. |
| `adjudicate.ts` | Settles a judge dispute against the EXACT record, with no model in the loop — every claim in a spoken line checked against the stored timeline and the raw 5s samples, and the two judges then scored against that. The instrument behind `data/eval/adjudicate-20260911.json`. |
| `compare-arms.ts` | The PAIRED comparison between two arms of one `judge-corpus` run. Calls nothing; reads a `*-judged.json` and does the pairing that file's per-arm table stops short of. |
| `blind-judge.ts` | The reader for the 2026-09-05 ablation corpus (`ablation-*.json`, `blind-*.json`), and the four verdicts every judge here scores against. The seeded shuffle moved to `lib/stats.ts` on 2026-09-12. |
| `diagnose-unbacked.ts` | WHY does the scorer say a figure is unbacked? Puts every charged figure in a stored run into one class — rounded, a map clock, a goal level, arithmetic, or invented — names the payload figure it stands for, reports the before/after against `scoreLine(_, { literal: true })`, and (`--inject`) injects known errors to prove the instrument still has teeth. |
| `rescore-runs.ts` | What did a stored run SAY, and how does it score against today's scorer? The reader for the ~30 `run*/final*/confirm` files from 2026-09-04 whose writer (`eval-live.ts`) was deleted. |
| `read-frame-ablation.ts` | What did the frame/no-frame ablation say, and does the picture change the coaching? The reader for the four `kind: "e2e-real-game-run"` files whose writer (`e2e-real-game.ts`) was deleted. |
| `compare-corpora.ts` | The PAIRED comparison between two `judge-corpus` runs of DIFFERENT nights over the same games — *did the coach get better?* Weaker than `compare-arms.ts` and says so: two runs are two judge conversations, so it prints the replicate-noise floor (~±6pp useful, ±9pp false) beside every rate. |
| `audit-build-claims.ts` | Adjudicates the BUILD claims in a graded corpus against the real recipes, with no model in it. Exists because `price` is the item's own cost line, so neither coach nor judge could tell a finished item from a component. |
| `measure-deadclock.ts` | Does a spoken death time match the client's own kill log? The elapsed/remaining inversion, re-derivable on the stored runs. |
| `audit-citations.ts` | Do the reviews already in the database pass the citation and baseline checks? |
| `audit-live-fields.ts` | Does every field the live brief renders match the exact post-game truth? (This is the one that caught `scores.creepScore` being visibility-limited.) |

## The shared library — put it here, not in a harness

| file | what it owns |
|---|---|
| `lib/stream.ts` | **THE join.** Which frames on disk go with which raw samples, and the rebuild of the block the coach actually held. Also the ONE `readVerbatim` / `baselineDuring` / `coachStateFrom` / `championVocabulary`. Five harnesses each did this join by hand once and each got a different answer. |
| `lib/stats.ts` | **THE paired test, and THE seeded shuffle.** McNemar's exact in both call shapes — written twice, `frame-value.ts` from the pairs and `adjudicate.ts` from the counts, with `compare-arms.ts` importing one of them out of a harness. `shuffled` joined it on 2026-09-12 for the same reason: it too was written twice (`blind-judge.ts`, `frame-value.ts`), and `lib/sheet.ts` was importing it out of a harness in breach of rule 2. The two copies were checked identical over 549 cases before the merge, so every stored key file's ordering still re-derives. Wilson stays in `src/analysis/coach-score.ts`, because the scorer ships it. |
| `lib/trim-payload.ts` | **The CUT half of the context-feed ablation.** Removes a named section from a payload AFTER `buildBrief` rendered it, so a `bench-stream --arms <p>+cut-<preset>` arm is provably the shipped bytes minus one section. `live-brief.ts` is untouched on purpose: it is what every stored measurement was taken on, and a `drop` parameter there would be a fifth way to change the payload by accident. Each preset carries the measurement that nominated it. |
| `lib/add-payload.ts` | **The ADD half.** The three candidate sections `data/eval/context-feed-20260918.md` nominated — the gold-to-next-spike join, the Baron/Elder take with a refusal to put a clock on the buff, and one clause saying summoner-spell cooldowns are in this feed for nobody — as `+add-<preset>` arms. None of them tells the model what to say; two are arithmetic and one is a statement about what the feed lacks. |
| `lib/win-lcu.ts` | The GET-only Windows-interop LCU reader for `scripts/`, kept separate from `src/lcu/` so `doctor.ts` can diagnose an app that will not import. |

## Operations — not measurement

| file | what it does |
|---|---|
| `doctor.ts` | `pnpm doctor`. The preflight you run when something is wrong. Every failing check prints a FIX. |
| `dev-seed.ts` | `pnpm seed`. Populate the DB with real recent games. GET only. |
| `check-patch.ts` | Is the generated champion table stale against the live patch? Reads Riot's version list; `--json` for CI. |
| `fetch-items.ts` | Vendor the item table from Riot's static data, because the live feed's `price` is a cost line and not what the item cost. |
| `fetch-champions.ts` | `pnpm fetch:champions`. Vendor EVERY champion's mechanics from Data Dragon and the League wiki, and what wins from op.gg, into the generated `src/knowledge/champion-table.ts` — because a model-authored knowledge base has an unbounded error rate and `lillia.md` said Swirlseed rolls over terrain when both sources say terrain stops it. Refuses to write a number the two Tier 1 sources disagree about. |
| `audit-knowledge.ts` | `pnpm audit:knowledge [champion]`. Assembles the live and post-game prompts and audits the delivered bytes line for line: what is untraced, what refuted sentence is back, what the table refused. The command that makes "every sentence was copied off a URL" checkable rather than claimed. |
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
   `lib/`, and the harness imports it.
3. **`src/` does not import a harness either, and a test lives beside its subject.** The same day,
   eight tests in `src/` imported six scripts as source, on the reasoning that `pnpm test` ran the
   `src` glob alone. It has not for a while — the glob is `"src/**/*.test.ts" "scripts/**/*.test.ts"`
   — and the cost of the stale reasoning was that six retired harnesses could not be deleted. A
   test for a script goes in `scripts/`. What a test in `src/` may pin is DATA in `src/`:
   `src/review/ablation-arms.ts` holds the measured prompts precisely so
   `src/shared/live-coach-mode.test.ts` has something in its own tree to assert against.
