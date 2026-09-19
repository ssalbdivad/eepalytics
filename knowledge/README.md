# knowledge/ — what is on disk, and what is fetched

This directory used to hold `champions/`: twenty-four markdown files, 184,104 bytes, one per
champion, each with a four-line provenance header and several thousand characters of prose under
it. **All of it was deleted on 2026-09-18, and none of it is coming back through this door.**
Champion knowledge is fetched now. What is left here is the role file, his own notes, and the
pronunciation table.

## Why the champion files went

They were written by a model — `src/knowledge/research.ts` spawned an agent with web access and
had it compose champion knowledge straight into the file that the next review would paste into its
prompt. That script is deleted too.

Audited on 2026-09-18 against the wiki's rendered ability pages and Data Dragon 16.18.1, the
corpus carried **18 wrong sentences in 225 adjudicated mechanical claims — 8.0% [5.1, 12.3]**, and
one of them mattered out of all proportion. `lillia.md` said Swirlseed *"rolls over terrain, and
grants vision of what it rolls past"*. It does neither: the seed detonates on the first terrain it
meets, and the only reveal is two seconds on the enemies caught in the detonation cone. That single
clause traces to **170 of the 1,513 stored pieces of post-game advice** and **38% of the
champion-specific lines the live coach has ever spoken**.

The sentences were not the failure. The failure was structural: **a file-level citation cannot be
wrong about a sentence, because it does not describe sentences.** Nothing in the repo — and no
grader, since the judge was handed the same file — could tell a sourced line from an invented one
by looking at it.

## What replaced it

`pnpm fetch:champions` (`scripts/fetch-champions.ts`) fetches five sources, caches them under
`data/champions/<patch>/`, and generates `src/knowledge/champion-table.ts`. Every record carries a
URL, a revision and a fetch time. `src/knowledge/claims-from-row.ts` turns that table into claims,
`src/knowledge/provenance.ts` re-derives each claim's text from the bytes it came from and refuses
any it cannot reproduce, and `src/knowledge/champion-brief.ts` renders the section with the source,
revision and date **in every line**.

Then it stops. **The rendering happens at generation time, not at request time**, and
`scripts/generate-context.ts` writes the result to `context/` as committed text — one file per
champion, one per role, one general. `pnpm fetch:champions` runs it; `pnpm generate:context`
re-runs it on its own with no network. Today that is 353 files and 4,691,665 bytes on patch
16.18.1, and `context/MANIFEST.json` records those counts beside the sha256 of the tree.

What the cross-check does and does not cover is in `SOURCES.md`, and the short version belongs
here too: Data Dragon publishes one spell per slot, so 692 of the table's 937 abilities are checked
against a second source and **245 — the passives and the second-form abilities — are transcribed
from the wiki alone.** Their lines cite that one wiki revision and are honest; the claim ledger
behind them marks them `agreesWith: ["ddragon"]` anyway, which is the weakness `SOURCES.md` names.

### `context/` — the committed artefact, and what the app actually reads

**This is the thing.** At runtime `src/knowledge/champion-context.ts` picks the right combination —
his champion, the enemy jungler's, his role — reads those files and concatenates them. It has no
renderer, no template, no claim checker and no branch that can produce a word about League. If the
runtime path can generate a sentence, the design is wrong.

Why a file and not the renderer it replaced: a rendered block is a block nobody read. The renderer
was already checking every claim and putting a URL on every line, and it was doing all of it inside
the process where the only reader was the model. A committed file is greppable by a human who wants
to know what his coach was told about Lillia, a new patch is a pull request, and a hand edit fails
the suite — `src/knowledge/champion-context.test.ts` regenerates the whole tree into a temp
directory and diffs it against what is committed, in both directions.

`<key>.core.md` is the same block without the wiki's per-ability interaction notes: a BUDGET
variant for the counterpart's section, the champ-select brief and the watch-a-moment call. It is a
second file rather than a runtime filter, because a filter is a branch, and a test asserts every
line of a core file appears in its full file — so the worst it can do is leave the coach knowing
less.

`roles/` has a file for all five roles and four of them say, in so many words, that no source
publishes anything about a role and nothing was written to stand in for one. That is the
instruction working, not a gap in the build.

`pnpm audit:knowledge [champion]` assembles the prompts a player actually gets and checks, line for
line, that nothing in the champion half arrived without a claim behind it.

Same precedent as `src/shared/item-table.ts`, which `scripts/fetch-items.ts` has generated from
Riot's own data for exactly the same reason.

## What is still on disk here, and what it is

### `general/jungle.md` — role prose, unsourced, labelled

**It is a generator INPUT, not a runtime read**, and this page said otherwise until 2026-09-19.
`scripts/generate-context.ts` strips its provenance header, demotes its headings a level, puts
`ROLE_CAVEAT` above it and writes the result to `context/roles/jungle.md` — and THAT file is what
`src/review/live-knowledge-full.ts` reads for the live coach's system instruction. Editing this one
changes nothing until `pnpm generate:context` runs, and the diff of the generated file is the
review. It is still model-authored and no site publishes it, so the caveat above it says so and
tells the model the fetched lines win where the two disagree.

It survives the deletion for one reason: **it makes no claim about any champion's kit**, which is
the class of error that was actually measured. It is about tempo, camps, crabs and objectives —
things true of the role whoever he locked in. Deleting it is a live option and nothing measured
argues against it.

### `owner/<champion>.md` — his own judgment, and the only unsourced champion channel

**The directory does not exist today.** `ownerDirDigest` treats a missing directory as an empty one
and `champion-brief.test.ts` pins the digest of nothing, so the channel is open, wired and unused —
and the first file to appear in it fails the suite until someone updates that pin deliberately.

Routes, clear order, gank conditions, spike timing, what an item purchase implies — roughly half of
what the deleted files said — have **no source**. This was probed: op.gg's payload contains no key
matching path/route/camp, `lillia.md`'s own citation of "op.gg jungle-paths" points at an endpoint
that does not exist (three shapes tried, two 404, one ignored the parameter), and the three
aggregate sites that might publish clear routes are 403, Cloudflare-gated and DNS-dead.

So that material ships from exactly one author: him. A file here needs `author: owner` in its
header and renders under a heading that says it has no source. **An agent may not write one** —
`champion-brief.test.ts` pins the digest of this directory, so a file appearing here fails the
suite and whoever added it has to say so out loud, in a diff.

Marking is not a substitute for accuracy and must not be used as one. This repo already measured
that hedging cannot repair a wrong quantity: *"a farm lead of at least 81 CS"* was correctly hedged
and still false, because the field behind it was a visibility counter. So this channel carries
JUDGMENT — where there is no quantity to be wrong about — and never a number dressed as one.

### `pronunciations.md`

The say-it-like-this table, read by `src/shared/pronounce.ts` and sent with the system instruction.

## The clauses the two legacy coach modes still speak

`fenced` and `cite-or-quiet` speak short tagged clauses keyed by fact kind — `death: the W hop is a
step and not an escape…`. Five of the deleted files carried a `## Live coaching` section; the other
nineteen never had one. Those five sections are frozen **byte for byte** in
`src/knowledge/legacy-clauses.ts`, because both modes are measured arms and an arm whose input
moved is not the arm that was measured.

Two texts live there and the difference is two lines. `legacyClauseSection` is the corpus AS
MEASURED and nothing may edit it. `shippedClauseSection` is what a player hears: the same text minus
the clauses in `RETRACTIONS`, each of which records the fetched sentence that refutes it. Two Lillia
clauses are currently withdrawn, both of which taught the Swirlseed as a corridor scout.

Nothing may be ADDED to that module. A new clause there would be unsourced model prose wearing a
frozen-data label, which is the thing this whole deletion was for.

`src/knowledge/champion-claims.test.ts` remains the bet register over those clauses: every one cites
a mechanic written down with where it was checked. It records what a clause bets on and it cannot
verify truth — it never saw the prose the clause sat beside, which is precisely how the Swirlseed
error survived next to a register entry that had it right.
