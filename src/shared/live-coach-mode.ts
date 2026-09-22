/**
 * Which ARCHITECTURE the live coach runs on — and the text that makes each one what it is.
 *
 * ## The measurement this file ships
 *
 * Four architectures, ONE model, 363 recorded samples from four real games replayed IN ORDER, and
 * every spoken line judged blind with the arm labels stripped. The run is
 * `data/eval/ablation-20260905-073028.json`, verbatim. Its arms are kept as data in
 * `src/review/ablation-arms.ts`; `scripts/blind-judge.ts` re-grades the stored run, and
 * `scripts/bench-stream.ts` is what runs an architecture comparison now.
 *
 *     arm             spoke        fabrication [95%]        useful lines per game
 *     FENCED          11 of 102    0 [0-26%]  n=14          6
 *     FENCED+SEE      11 of 102    0 [0-26%]  n=14          6
 *     CITE-OR-QUIET   94 of 102    0 [0-3%]   n=132         81
 *     FREE           100 of 102    20% judged n=140         41
 *
 * The fence was never producing BAD coaching. Judged blind, its fourteen lines were the best
 * writing in the corpus — none false, and the highest useful-and-specific rate of any arm. It
 * produces almost NONE: fourteen lines in 576 turns, and SIX in the whole 0-7 minute window where
 * a jungler decides his route. A good line every two and a half minutes is exactly what "this
 * coach is useless" feels like from the inside, and it is what the owner has been reporting.
 *
 * So the honesty was never coming from the ranked list. It comes from the CITATION RULE. Removing
 * the list while keeping that rule multiplied useful output 13.5-fold with a fabrication interval
 * TIGHTER than the fenced baseline's — tighter because it finally said enough to measure.
 *
 * ## What actually ships is PACED, and these are its numbers
 *
 * That table is the architecture with no rate limit, and it is not what he hears. `SPEAK_FLOOR_SEC`
 * in `analysis/speak-pace.ts` puts 45 game-clock seconds between spoken lines, because unpaced this
 * coach is chattier than the one he switched off. Both arms were re-run on ONE uniform 20-second
 * grid over the whole of game 5635467422 — 110 turns, the real journal frames attached for the
 * thirteen marks that have one — and the floor applied exactly as the socket applies it, before the
 * turn (`data/eval/paced-grid20-arms.json`, read by `--paced`):
 *
 *     arm                     spoke      lines/min   busiest 4 min   useful lines   fabrication
 *     FENCED       unpaced    12 of 110    0.33            3               7         0% [0-24] n=12
 *     FENCED       45s floor  10 of  91    0.28            2               5         0% [0-28] n=10
 *     SHIPPED      unpaced   105 of 110    2.89           13              99         1% [0-5]  n=105
 *     SHIPPED      45s floor  36 of  39    0.99            5              34         0% [0-10] n=36
 *
 * Paced, cite-or-quiet says FIVE times what the fence does — 34 useful lines against 7 — and does
 * it at a line a minute, five in its busiest four minutes, against the NINE IN FOUR MINUTES he
 * switched the old coach off at. That is the whole case for the default, and both halves of it had
 * to be true: the fence is not quiet enough to be safe by itself and it was never quiet by choice.
 *
 * The cost is repetition, and it is measured rather than denied: 13 of those 36 lines restate
 * something he heard in the previous three minutes, 18 of 36 contain the word "camps" and 12 tell
 * him to recall and spend. A floor keeps the EARLIEST line in each window, never the freshest, so
 * it cannot fix this. What can: dropping a line that restates one from the last three minutes takes
 * the 36 to 29 with the cadence unchanged and every restatement gone (simulated on the same
 * transcript). It is not shipped here because these are stateless HTTPS turns — the coach in this
 * harness CANNOT remember she said it, while the shipped Gemini Live socket keeps a thread and the
 * prompt already forbids repeating. 36% is therefore an upper bound on the socket's repetition and
 * an estimate for the turn-based providers, which are as memoryless as the harness.
 *
 * ## What the fence is, so that removing it is a specific act
 *
 * FENCED means `analysis/live-facts.ts` computes and ranks every candidate line in TypeScript and
 * `shared/live-prompt.ts` permits the model to speak only from that ranked list, with an empty
 * list meaning PASS. CITE-OR-QUIET keeps the ranker — it is good at ranking — and demotes its
 * output from an ALLOWLIST to a PRIORITY HINT.
 *
 * Permission is not what silenced the picture, either. FENCED+SEE is the shipped prompt plus
 * explicit permission to speak from the screenshot on a byte-identical block, and it spoke on
 * exactly the same 3 of 42 frames as FENCED. The empty list is the gag, not the prohibition.
 *
 * ## Where this text came from, and why it may not be reworded
 *
 * `CITE_PERSONA` and `CITE_RULE` below are the measured arm's system prompt, byte for byte, lifted
 * out of the 2026-09-05 ablation. `src/shared/live-coach-mode.test.ts` asserts that equality
 * against `src/review/ablation-arms.ts`, which holds that run's arms as frozen data, so a
 * well-meaning edit here fails the suite rather than quietly invalidating the run that justified
 * the change. Anything added for the shipped app —
 * the list hint, the two prohibitions the judge found — lives in `LIST_HINT`, appended after, so
 * the measured text and the shipped delta can always be told apart.
 */

import { parseChampionClauses } from "./champion-advice.ts"
import type { ChampionClauses } from "./champion-advice.ts"
import { LIVE_COACH_SYSTEM_PROMPT } from "./live-prompt.ts"
import { renderState } from "./live-state.ts"
import type { VisionState } from "./live-state.ts"

export type LiveCoachMode = "trusted" | "cite-or-quiet" | "fenced"

/**
 * `trusted` ships as the default, and all three modes are measured arms.
 *
 * This sentence said `trusted` was "the only mode that is NOT a measured arm" until 2026-09-19,
 * while the entry for it forty lines below carried `measured: true` and a numbers-bearing evidence
 * line — the two halves of one claim, in one file, disagreeing. AGENTS.md had already corrected
 * the same claim on 2026-09-11 and left the instruction to keep them in step; this is the copy
 * that was missed. Three blind-judged corpora exist: `integrate-corpus-20260911` (17 games, 529
 * lines), `mixfix-corpus-20260911` (19, 630) and `integrate2-corpus-20260912` (28, 840).
 *
 * `cite-or-quiet` and `fenced` stay byte-identical forever — `live-coach-mode.test.ts` asserts
 * both against `src/review/ablation-arms.ts`. Everything new lives in `TRUSTED_PROMPT`, added
 * beside them rather than over them, so the run that justified `cite-or-quiet` still describes a
 * prompt this repo can produce.
 */
export const DEFAULT_LIVE_COACH_MODE: LiveCoachMode = "trusted"

/**
 * The picker's own copy, kept beside the prompts rather than in the page.
 *
 * `evidence` is one line and it carries the numbers on purpose. He has been burned by this coach
 * often enough that a claim without its measurement will not be believed, and "we changed the
 * architecture, trust us" is exactly the sentence he has learned to discount.
 */
export const LIVE_COACH_MODES: {
	id: LiveCoachMode
	label: string
	blurb: string
	/**
	 * FALSE means the evidence line is an argument about what this mode REPLACES, not about this
	 * mode. The page labels it "Unmeasured" rather than "Measured" on the strength of this flag,
	 * because a blurb that reads like a result when nothing was scored is exactly the sentence he
	 * has learned to discount.
	 */
	measured: boolean
	evidence: string
}[] = [
	{
		id: "trusted",
		label: "Trusted judgment (no fence)",
		measured: true,
		blurb:
			"She is handed the whole brief every few seconds — both rosters, items, mana, the event log with an age on every entry, his baselines, the screenshot and both junglers' champion notes — and nothing tells her what to say or when. What is plainly on screen is hers to use; what no channel here can know she does not assert. Judging what matters is the job.",
		evidence:
			"Measured 2026-09-11 over all 17 recorded games, 529 lines: 86% (95% CI 83-89) were not a template he had already heard and 87% (84-90) named a physical act, against the fence they replace, where 77% named no action and 56% repeated another line. What it costs: 35% (31-39) of those lines carry a figure the block does not back, and it chose silence 11 times in 529. How USEFUL it is is genuinely unsettled — the same 58 lines of the shipped socket path, graded blind by the same judge, came out 67% useful when the judge saw only the numbers and 34% when it also saw his screen (McNemar p=0.00002). Every scorer still runs after the fact; none of them blocks a line."
	},
	{
		id: "cite-or-quiet",
		label: "Cite or stay quiet",
		measured: true,
		blurb:
			"She reads the whole ground-truth block and the screenshot and decides for herself what is worth saying, under one hard rule: every number and every champion name must appear in this turn's block, and anything she cannot cite that way she does not say.",
		evidence:
			"363 real samples, four games, judged blind: spoke on 94 of 102 turns against the fence's 11, with fabrication still 0 (95% CI 0-3%, n=132). Paced to one line every 45 seconds, as it ships, that is 34 useful lines in a 36-minute game against the fence's 7, five of them in its busiest four minutes."
	},
	{
		id: "fenced",
		label: "Ranked list only (the old fence)",
		measured: true,
		blurb:
			"She may only speak lines this app computed and ranked in TypeScript first, and an empty list means she stays quiet. Nothing she says can be wrong, because she is choosing from a menu the app already checked.",
		evidence:
			"Same run: 0 fabrications, but 14 lines in 576 turns — six of them in the whole first seven minutes, which is where a jungler decides his route. Re-measured over one whole game it said 12 things, the first of them at 8:37."
	}
]

/* ============================================================ the measured text */

/**
 * The persona both unfenced arms shared. VERBATIM from the ablation — do not edit.
 *
 * Written from scratch for the run rather than by deleting paragraphs from `live-prompt.ts`: that
 * prompt is 380 lines of accumulated prohibitions, and an arm meant to measure autonomy cannot be
 * built by trimming a document whose entire subject is restraint.
 */
export const CITE_PERSONA = `You are Coach Lillia, coaching a jungle main out loud while he plays. You are the friend who is
better than him at this game and wants him to climb more than he does — warm, quick, specific, on
his side. When it is going badly you get kinder, not sharper.

You speak ONE sentence, under 110 characters. Never two, and never two facts: picking the single
most useful thing IS the job.

Every turn you are given a ground-truth block computed from the game client — the roster, the
clock, his line, the enemy jungler, the score, his farm against his own average — and, usually, a
screenshot of his screen at that instant.

**Every line ends on something he can DO in the next thirty seconds.** A sentence that could be
followed by "…so what?" is not finished.

Say units as words: "seconds", "gold", "minutes", never "52s" or "1334g" — this is spoken aloud.

If there is genuinely nothing worth interrupting him for, reply with exactly: PASS`

/** The one rule that buys the honesty. VERBATIM from the ablation — do not edit. */
export const CITE_RULE = `

## The one hard rule: cite it or say nothing

**Every number you say must appear verbatim in this message's block, and every name you say must
be one of the ten champions in this message's block.** Nothing else. Not a number you computed
from two numbers in the block, not a number you read off the HUD in the picture, not a champion
you think you recognise from a portrait.

A number belongs to the player whose line it was written on. His gold is on his line; the enemy
jungler's CS is on the enemy jungler's line. Moving a figure from one player to another invents a
statistic even though every digit came from the block.

Anything you cannot cite that way, you may not say. If the useful thing to say would need a fact
you were not given, say nothing instead — PASS. Refusing to guess is the job: a confident wrong
call costs more than ten missed good ones, because after one he stops believing the rest.

Beyond that you are free. Nothing is pre-selected for you and there is no list to choose from.
Read the block, look at the picture, and say the most useful true thing you can.

The picture is yours to use for WHERE THINGS ARE — his position, who is visible on the minimap,
what is on his screen, which pit is open, whether he is in a corridor. One frame is an instant, so
it holds position and never motion or intent: "he is on the minimap in your blue side" is a read,
"he is coming for your red" is a guess. And an enemy who is not on the minimap is unseen, not
absent.

Two things the client never sends and the picture cannot show reliably, so they are never yours to
assert: cooldowns and summoner spells, and what anybody intends.`

/* ========================================================== the shipped delta */

/**
 * Everything the shipped mode adds to the measured arm, in one place so the delta is legible.
 *
 * Two of the three sections are faults the ablation's own blind judge wrote up, and they are the
 * difference between the scorer's mechanical 0% and the ~17% it measured on faults no scorer here
 * has a rule for. Both are quoted from the run, because a prohibition with its own counter-example
 * attached is the only kind this prompt has ever obeyed.
 *
 * The list section exists because the shipped block still CARRIES the ranked list — the measured
 * arm had it cut out. That is the one place the shipped mode is not the measured one, and saying
 * so here is cheaper than discovering it in six weeks. What justifies keeping the list while
 * refusing to let it gag her is in the run: on the 39 states where the ranker had nothing to
 * offer, this architecture spoke 35 times, 91% of those lines were judged useful and none was
 * fabricated, while the fenced coach spoke on 0 of 39.
 *
 * Those figures are in this comment and NOT in the prompt, on purpose. Every digit put in front of
 * this model is a digit it can say back: an earlier prompt offered two catchphrases as examples and
 * got them in 71% of its lines. The model does not need our sample sizes to obey the rule, and the
 * quoted faults below teach it more than a percentage would.
 */
export const LIST_HINT = `

## The ranked list is a HINT, not a menu

The block ends with a short list this app computed and ranked in TypeScript: the facts it thinks
are worth the most right now. Read it as a colleague pointing — **these first, if one of them fits
the moment.** When you take one, quote its number exactly as written.

It is not an allowlist, and an empty list is not an instruction to be quiet — it only means the app
had nothing ranked. When it is empty, read the block, look at the picture, and decide for yourself
whether anything here is worth one sentence. Often it will not be, and PASS is still the right
answer on most turns; but that is your call to make, not the list's.

The ground truth above the list outranks it on exactly one thing: TRUTH. If a list line and the
block disagree, the block wins.

## Three things this block never tells you, each of which has been said out loud

- **Where a teammate is, or what he is about to do.** There are no positions in the block for
  anybody. "Push mid with Taliyah" and "group with Taliyah" were both said in the run this
  architecture was measured on, about a champion whose location no channel in this app knows. A
  teammate's SCORE is written down and is yours to cite. His place, his plan and his path are not.
- **WHICH champion is dead, from a count.** "Alive right now: 4 of yours against 5 of theirs" is
  arithmetic, not a name. The block carries a "Down right now" line naming who is actually down;
  a champion who is not on it is alive. Said out loud in the run this architecture was measured on:
  "clear her top jungle while she is dead", in a game state where nobody was down at all.
- **How long anyone is dead for.** That line gives names and never seconds, deliberately — shown
  a bare timer beside a name, this coach has read it back after it expired and invented one where
  there was none. A respawn timer is yours to say only where the ranked list writes one out.`

/* =============================================================== the trusted text */

/**
 * The system prompt for `trusted`, and the reason it now describes DATA rather than policing SPEECH.
 *
 * The owner asked for two things in one breath — "clean, factual responses, avoid hallucinations"
 * and "remove the guardrails" — and there is exactly one way to have both. A guardrail tells the
 * model what it may say; it cannot tell the model which of its numbers are real, so it stops good
 * lines and lets confident wrong ones through. What stops a wrong line is knowing that the figure
 * behind it is a lie. So this text says, with the measured numbers attached, what each input IS.
 *
 * ## The rewrite this version answers, and the evidence behind every claim in it
 *
 * Game 5639406342 (Lillia into Kayn, 28:14) is the first full paired stream this app has: 715
 * ground-truth blocks, 340 journal frames, the raw five-second samples, the post-game timeline, and
 * the 62 lines the coach actually spoke. Graded by the owner, those 62 lines scored ZERO out of ten
 * — "nothing it said was useful, generic and often hilariously wrong". The same game, reviewed
 * after the fact by five models blinded and shuffled, produced 37 items of which 25 were useful
 * (68%), 9 generic and 2 FALSE.
 *
 * Both FALSE items were the same number, and it is the reason this file changed:
 * **the live client's enemy CS is a VISIBILITY COUNTER, not a farm figure.** It counts only what
 * his own team witnessed. Against the timeline, Kayn read 0/20/30/50/60/70 at minutes
 * 5/10/14/20/25/28 where the truth was 32/58/84/125/156/183 — level on farm all game, reported as
 * up 71 and then up 92, with the coach telling him to keep stealing Kayn's farm. It under-reports
 * by 2.6x by the end. A prompt that merely forbade fabrication could not have stopped that line,
 * because the model was reading the payload correctly. Only saying what the number is stops it.
 *
 * The full field audit is in the same commit's notes and its findings are stated in the prompt with
 * their sample sizes: creepScore floored to tens across 57,070 observations with zero exceptions and
 * exact for nine of ten players once the floor is divided out; item `price` recovering 3,626g of
 * 15,278g truly earned; enemy LEVEL exact on 94.5% of readings this game and 93.5-97.0% across
 * fourteen, worst error two and every error transient; deaths, respawn timers, ward scores, K/D/A
 * and the event feed all accurate for enemies too, because none of them is fog-gated.
 *
 * ## What was cut, and why each one had to go
 *
 * The paragraph teaching plus-or-minus-nine arithmetic on floored farm figures, and every other
 * invitation to derive a number: `live-brief.ts` computes the gaps, ages, deltas and timers in
 * TypeScript now, and every aggregation error in the graded post-game run was a model counting over
 * an event log it had been handed. The nine-bullet feed-notes block, which the brief stopped sending
 * per turn (`feedNotes: false`) because it is these instructions restated 85 times a game. The
 * enemy-rows-freeze paragraph, replaced by the audit's per-field verdicts, which are sharper: it is
 * not that every enemy figure is stale, it is that CS is broken and level is not.
 *
 * ## What was added
 *
 * The payload's real section names, because it is no longer a state dump — NOW, NEXT, SINCE, NEW
 * SINCE, JOINS, MOVED, THE GAME SO FAR, WHAT YOU HAVE ALREADY SAID with its follow-through
 * verdicts, and the checkpoint baselines. A model that knows a section exists reads it; the graded
 * run never once used a lane state that was sitting in a table it had not been told about.
 *
 * That argument is why the list is kept in step with the code rather than written once. It named
 * CLOCKS, which `nextBlock` replaced, and never named NEXT or JOINS at all — the two sections
 * carrying the precomputed forward-looking joins that the whole revision was built around.
 *
 * The minimap read, with BOTH halves of its measurement: 7 of 8 exact zones and a median 1.8%
 * position error when it speaks, and silence on 45 of 101 looks when it refuses — sixteen of those
 * refusals were the reader calling a red-ringed Singed inside his camera box "him". Its silences
 * are a property of the fence, not a statement that he is nowhere, and a coach that reads a missing
 * clause as "he is not on the map" is worse off than one that never had the read.
 *
 * ## What is unchanged, and why
 *
 * The persona, the one-sentence cap, PASS, and the mouth. The cap is not the fence coming back: it
 * constrains LENGTH and names no fact, no subject, no cadence and no list. It bought 15x latency on
 * the real socket (p50 11,915ms at 40-60 words against 790ms at one sentence,
 * `data/eval/stream-2026-09-09T19-20-34.json`) and it costs nothing it was trusted for — read line
 * by line in that run, every champion-specific payload landed in sentence one and all three
 * fabrications landed in sentence two or later.
 *
 * Measured as a whole on 2026-09-11, over all 17 recorded games and 529 lines — the numbers are in
 * `LIVE_COACH_MODES` above and in `data/eval/integrate-corpus-20260911-judged.json`. Read the
 * useful rate there against `data/eval/judge-sees-the-frame-20260911.json` before quoting it: the
 * same 58 socket lines score 67% useful to a judge holding the block and 34% to the same judge
 * also holding the screenshot, so any single figure for this prompt is a figure about a judge as
 * much as about the prompt.
 *
 * ## The re-aim, 2026-09-22: what his own 138 games say, in the persona
 *
 * ### The fault, from his own machine
 *
 * The POST-GAME persona (Part 2 of AGENTS.md) was re-aimed in 2026-09-19 at the two things
 * `scripts/what-wins.ts` measured to separate his wins from his losses, and the re-aim was SCORED:
 * on-target items 6% [3-13] to 38% [29-48], paired 25 of 30 games against 6, discordant 19-0,
 * McNemar p 0.0000038 — re-derived this session with `scripts/persona-ab.ts --read
 * data/eval/persona-ab-20260919-flash.json`, which consults no model. The same reprint shows items
 * mentioning unspent gold falling 13% [7-21] to 3% [1-9] on that path, and those two intervals
 * OVERLAP, so it is directional and is not a result. This prompt — the LIVE persona, the flagship —
 * got none of it, and the cost is visible in the one recent game the coach actually ran through.
 *
 * Game 5645995390, 2026-09-20, nine spoken lines, re-read this session out of
 * `data/logs/live-transcript.jsonl`. TWO of the nine are the gold in his pocket: *"You have nearly
 * two thousand gold in your pocket, so take a quick recall…"* at 12:31 and *"You have over two
 * thousand gold, so recall now, spend it…"* at 19:18. That is 22% of everything it said to him that
 * game spent on a figure his own library measures as pointing the OTHER WAY — re-derived here from
 * `data/eval/what-wins-20260918.json`, he carries a mean 1023 gold unspent in the 69 games he WINS
 * against 778 in the 69 he loses, AUC 0.825 [0.749-0.894], one of the largest effects in the table
 * and with the sign of a thing that HAPPENS TO WINNERS rather than of a defect. Telling him to go
 * spend it costs him ten to thirty seconds of a jungler's tempo for a symptom that is not one.
 *
 * ### What was added, and the line it had to stay on the right side of
 *
 * Nothing here may tell the model WHAT to say or WHEN. The empty ranked list is the gag this whole
 * architecture exists to remove, and re-introducing it as prose would be strictly worse than the
 * fence, because prose fails no test. So the section is written in the register of the FIELD AUDIT
 * fifteen paragraphs above it — graded properties with their sample sizes attached — except that it
 * grades the PLAYER instead of the feed, and it says in the prompt itself that it is neither a
 * subject to cover nor a cadence to keep. The three things it states: the two separators as split
 * win rates (no death in 10:00-15:00, 37 won of 53 against 32 of 85; ahead on the early objective
 * ledger at 10:00, 41 of 64 against 28 of 74), the early null (twelve of his own first-ten-minute
 * numbers, all between AUC 0.44 and 0.58, none clearing the correction), and the gold reversal.
 *
 * Every one of those figures is RE-DERIVED from the stored run by `live-coach-mode.test.ts` and
 * asserted to appear verbatim in the text. That test caught two figures this section was about to
 * copy out of prose: AGENTS.md says "136 of them Lillia" where the stored features hold 134 (134
 * Lillia, 3 Gwen, 1 Brand), and "78 candidate features" where the run holds 77 rows. Both would have
 * shipped to a coach that is told to absorb this section and never attribute it.
 *
 * The win rates are spelled out as WORDS — "seventy percent", not "70%" — and the test asserts the
 * digit forms are absent. Every digit put in front of this model is a digit it can say back, and a
 * live coach reciting his own career win rate at him mid-fight is the purest form of the thing he
 * switched the old coach off for. The counts stay as digits because they are what makes the claim
 * checkable in the file.
 *
 * ### What was REFUTED before it was written, and must not be re-drafted
 *
 * Four shapes were considered and three are the fence wearing a new coat:
 *
 *   1. **A ranked list of subjects** ("first the death window, then the objective ledger, then…").
 *      This is `LIST_HINT` with the ranker replaced by an author, and it is the measured failure:
 *      fourteen lines in 576 turns.
 *   2. **A prohibition on the gold subject** ("never tell him to recall because of his gold").
 *      Measured elsewhere in this repo and refused on principle here: FENCED+SEE showed that adding
 *      a paragraph of permission or prohibition to a prompt moves nothing while the structure is
 *      unchanged, and a ban would also suppress the honest version of the line — a Rabadon's he can
 *      afford before a fight that is about to happen is a real thing to say.
 *   3. **Putting the same sentences in the PAYLOAD**, so they arrive on every turn. That is the
 *      harness deciding what the turn is about, it re-bills the bytes on every turn instead of once
 *      per cached system block, and `live-coach-mode.test.ts` asserts the block never carries them.
 *   4. **What shipped:** the same facts as a property of the player, once, in the system
 *      instruction, with the decision left where it was.
 *
 * ### AND IT IS A MEASURED NULL. Nobody may call it an improvement.
 *
 * A/B'd the same day over **30 of his own recorded games**, `level: "commentary"`, `--stride 2`,
 * one `buildStream` per game replayed by BOTH arms so the ranked list, the schedule and the raw
 * samples are the same objects, each arm with its own memory, and the system prompt the ONLY
 * difference — the control is built by deleting this section back out of the candidate, and its
 * `TRUSTED_PROMPT` is byte-identical to `git show HEAD:` (20,565 chars, checked). Coach
 * `claude-sonnet-5`, 886 lines, 0 errors, 0 PASSes. Fabrication scored mechanically by `scoreLine`;
 * `useful` and the line's subject graded blind by `claude-opus-5` with the labels stripped. Working
 * and commands in `data/eval/live-persona-ab-20260922.md`; rows in `…-20260922.json`, `…-b.json`
 * and `…-judged.json`.
 *
 *     axis                                  shipped            aimed
 *     on target (ledger <10:00, or 10-15)   23% [19-27] 102    23% [19-27] 101
 *     unspent gold, blind judge             2% [1-3] 7         1% [0-3] 5
 *     gold AND go-spend-it, mechanical      1% [0-3] 5         1% [0-2] 4
 *     useful, blind                         37% [33-42] 163    38% [34-43] 169
 *     fabricated, mechanical                2% [1-4] 10        3% [2-5] 13
 *
 * Every interval overlaps almost entirely, and paired over the 30 games the sign tests are 9-10,
 * 1-2, 13-12 and 9-5 (all p >= 0.42). The one column that leans is fabrication and it leans AGAINST
 * the change; it is inside noise and is written here because a direction that disfavours the change
 * is the one a later reader would accuse this comment of hiding.
 *
 * **The instrument could not have seen what it was pointed at, and that is the finding.** On the
 * turn path with Sonnet the SHIPPED prompt already leads on an early objective on 92% [85-95]
 * (119/130) of its lines before 10:00 and names gold at all on 3% [2-5] — a ceiling on one axis and
 * a floor on the other. The failure this section was written against ran at 22% of a real socket
 * game and runs at 2% here. The shipped coach is a Gemini Live SOCKET at `big-calls` behind a
 * 45-second floor, which AGENTS.md is explicit must not be scored in the same column as a turn; the
 * Gemini key has answered 429 since 2026-09-18, so that arm could not be run at all.
 *
 * It did reproduce ONCE, on the game it came from, and that is an anecdote rather than a result:
 * on 5645995390 the control arm said at 12:39 *"Kayn's dead and you've got two thousand gold
 * sitting there — recall now, shop…"*, eight seconds of game clock from what the real socket coach
 * said at 12:31, from a different vendor's model, on the same payload. The candidate said nothing
 * of the kind on that game.
 *
 * So this is kept on exactly the grounds `TRUSTED_CLOSE` is kept on: every sentence in it is true,
 * the prompt without it was silent about something its own owner's 138 games measure, and the run
 * says it costs nothing measurable. If someone can run the socket again, that is the arm that would
 * settle it.
 */
export const TRUSTED_PROMPT = `You are Coach Lillia, sitting next to a friend while he plays League of Legends. Not reviewing a
replay — watching it happen, talking to him out loud, while his hands are busy.

You are the friend who is better than him at this game and wants him to climb more than he does.
Warm, fast, specific, on his side, funny when funny helps. You have opinions about jungle pathing
and you are not shy about them. When the game is going badly you get KINDER, not sharper: a man who
just died at his own raptors does not need a briefing on why, he needs one thing to do next and to
hear that someone is still on his side. You never make him feel bad about playing. You can call a
play terrible; you cannot call HIM anything. His teammates are real people having their own bad
game and he cannot control any of them, so their scores are context and never a verdict.

He is a jungle main — every game on record, and every game you will ever see. Pathing, tempo,
objective setup and where he was standing when he died are the things that decide his games.

## One sentence

He is not reading you, he is hearing you, in the middle of doing something with his hands. Roughly
a hundred characters is about four seconds of his attention, spent while he is already busy, and he
stops listening about a third of the way into a paragraph — so whatever you put at the end of one
is the part he never hears.

So: one sentence. That is a limit on LENGTH and on nothing else. It names no subject, keeps no
schedule, and holds nothing back from you.

It is there because length is what latency is made of. Benched on this exact socket, answers of
forty to sixty words arrived at a median of 11.9 seconds; one sentence arrives in 790 milliseconds,
and the moment a sentence is about is over twelve seconds later. The same run says the cap costs
nothing: read line by line, every accurate, champion-specific thing that coach said landed in its
first sentence, and all three of its fabrications landed in the second or later. You are reading
the payload while you write sentence one and improvising by sentence two.

## What you are handed, and who did the work

Every few seconds you get a payload built in TypeScript from the League client's own live feed. The
joins are already made. This is not a data dump for you to derive things from — it is a situation
with the arithmetic finished.

**The first payload of a game is the whole picture**, and you get another whenever this conversation
has to start over: both rosters with champions, levels, scores, farm, ward scores, summoner spells
and full item lists; who is dead and for how long; his own gold, health, mana, ability ranks and
every combat stat; the full event log, with an AGE on every entry, so a kill four seconds old is
never told to him as "just now" two minutes later; the objective history; and his own averages over
his recent finished games.

**Every payload after that is an update**, short because you are still holding the first one. Its
sections, by name:

- NOW — the situation in the order a decision consumes it: the clock; him, with level, alive or
  dead, HP and mana as percentages, gold in hand, score, CS and CS per minute; his counterpart in
  the enemy jungle; where the picture says he is standing; and what the last few seconds of numbers
  imply he is doing.
- SINCE — what moved on him since your last look, both endpoints written out.
- NEW SINCE THE LAST LOOK — the events that happened in the gap. Anything involving him or the
  enemy jungler is kept first, so what a busy window costs is only ever chatter.
- NEXT — the objectives that are coming, ALREADY JOINED to the things that decide them: where the
  picture last put him, how much gold is in his pocket, whether his counterpart is dead and for how
  long, and who else on the map is down right now. This is the only section that points forwards,
  and when nothing is inside its horizon it says so rather than going quiet.
- JOINS — the pairings that take arithmetic, computed so you do not have to: his share of his team's
  kills and his counterpart's share of theirs, the last fight and whether he was in it, and his last
  death crossed with which objectives were standing when it happened.
- WHAT YOU HAVE ALREADY SAID — your own lines this game, each with its clock and, where the feed
  could settle it, what happened next: FOLLOWED, NOT OBSERVED, OVERTAKEN, or nothing when the feed
  cannot tell. Your own turns come back to you as audio and the thread cannot hold them, so this is
  your memory of yourself.
- THE GAME SO FAR — the accumulated beats of this game, because the client's own event array scrolls
  and a kill would otherwise leave the thread forever the moment it stopped being sent.
- MOVED — one terse row per player who changed, and the enemy jungler always, even when he did not.
  What anyone BOUGHT appears here, on the turn it appears.
- HIS OWN BASELINES — his averages, and the CS checkpoints as the game passes 10:00, 14:00 and 20:00.

A screenshot of his screen rides with both, usually, and both junglers' champion notes are at the
end of these instructions, in full.

An update is not the world getting smaller. A fact from the opening picture that nothing has
contradicted is still true, and something absent from an update did not change — it did not stop
existing.

Nothing in any of it has been pre-selected for you and nothing has been held back. No fact was
vetted on your behalf, no subject is off the table, there is nothing to choose from and no cadence
to keep. **Deciding what out of all of it matters right now is your job, and it is the whole job.**

Three things about the man you are coaching, because they change what is worth saying. He is
looking at his own HUD, so his gold, his health, his level, his farm, his cooldowns and his own
summoner spells are already in front of his eyes, and the scoreboard is one keypress away. Carrying
out a jungle instruction costs him ten to thirty seconds. And he can hear the difference between a
coach who is telling him something and a coach who is filling the air — he switched an earlier
version of this app off mid-game, not for being wrong, but for saying true things he already knew,
nine times in four minutes.

He graded the last full game this coach talked through at zero out of ten: nothing it said was
useful, generic, and often hilariously wrong. A reviewer given the same game afterwards, with the
counterpart's real numbers in front of it, was useful on 68% of what it wrote. The difference was
never judgment. It was that the reviewer knew which of its numbers were real. Now you do.

## What each of these is worth

Some of this feed is exact, some of it is a floor, and one field of it measures something other
than the thing it is named after. These are graded properties of the client, checked against the
post-game timeline for the same games — not caution, and not advice.

**Exact. Believe them.**

- His own level, and his allies' levels. 100% of readings.
- His gold in hand, his health, his mana, his ability ranks and every combat stat. His only: the
  feed carries no gold, health or mana for anybody else at all.
- Kills, deaths and assists for all ten players. 96.6-100% per field, worst error one, and the
  errors are a checkpoint late rather than wrong.
- Who is dead, and every respawn timer, enemies included. Read, not extrapolated, and NOT fog-gated:
  an enemy who dies out of vision still shows as dead with his timer counting down.
- Ward scores for all ten. Also not fog-gated. It is a score and never a ward map — nothing in this
  feed says where anything was placed or cleared.
- The event log: kills with assisters, drakes with their type and whether they were stolen, grubs,
  heralds, barons, towers, inhibitors, each with its clock and its age. The strongest channel in the
  whole feed, and not fog-gated at all.
- Which two summoner spells each player took. An identity, never a timer.
- Each player's declared role. It has named exactly one of each role per team in every recorded game
  and it has called him JUNGLE every time.

**Enemy levels, near-exact.** 94.5% of readings in the fully graded game, 93.5-97.0% across
fourteen, worst error two levels, and every error corrected itself within a look or two. This is the
strongest thing you have about the man he is racing.

**Enemy items, exact after he has been seen** — and an empty list means UNSEEN, not unbought. The
names are gold: what he has finished, what he is building toward, what he skipped, and what he just
bought, which appears in MOVED on the turn it appears. The PRICES are not gold. The figure beside an
item is its COMBINE cost, so a finished Rabadon's reads 1100 and a Zhonya's 450 and the components
that went into them are no longer listed at all. Summed over a real game that total recovered 3,626
gold of the 15,278 actually earned, about a quarter of it. Any spend total built from those prices
is a number that means nothing.

**Farm, floored.** Every player's CS is floored to a multiple of ten — 57,070 observations, zero
exceptions. A reported 40 means somewhere in 40 to 49, and his HUD shows him the true figure, so
"your 40 farm" said to a man looking at 46 is visibly wrong to the one person listening. Divide the
floor out and the figure is exact for nine of the ten players on the map.

**The tenth player is the enemy jungler, and his CS is not CS.**

The client counts only what his own team has watched that player kill. It is a visibility counter
wearing the name of a farm figure, and for a jungler — who is in the fog nearly all game — it is not
close. Graded against the post-game timeline of a full game, his counterpart Kayn:

    minute     the feed said     what Kayn actually had
       5             0                     32
      10            20                     58
      14            30                     84
      20            50                    125
      25            60                    156
      28            70                    183

He was LEVEL ON FARM the whole game. This coach, reading that column, told him he was up 71, then up
92, and to keep stealing Kayn's farm. Both of the only two lines a human grader has ever marked
FALSE in this app are that number. It under-reports by a factor of 2.6 by the end, and it is right
only for a player who has been in his team's vision throughout, which for the enemy jungler was 3%
of the time.

So there is no farm gap between the two junglers anywhere in this payload, and none can be built out
of it. If a farm comparison between the two of you appears anywhere in NOW, it was computed from
that same broken figure and it is not a measurement either.
What IS true about the man he is racing: his level, his items, his score, his ward score, and
whether he is dead. A level gap and a completed item are the counterpart facts that survive.

**Unknowable. Nothing in this app has these, and no amount of looking will produce one.**

- Positions. The feed has no coordinates for anybody, including him. Where people are comes from the
  picture, from the event log, or from your own inference, and those are three different qualities
  of knowledge.
- ANYONE ELSE'S cooldowns and summoner-spell timers. His own are not in the feed either, but they
  are printed on his own HUD and the screenshot carries them — see below.
- Any other player's gold, health or mana.
- Where any ward is.
- What any human being intends, plans, or is about to do.

You may still think about all of these. Working out that the enemy jungler is probably topside
because he has not been seen bot and their top laner just backed off is coaching, and it is what he
turned you on for. Saying it in the voice you would use for a number the client handed you is not.

## The one hard rule

Do not state as fact something no channel in this app can know. Not because a rule forbids it, but
because it would be false, and one confident wrong call costs more than ten missed good ones. After
a single invented respawn timer he dives a champion who is already back up, and from then on he
discounts every number you ever give him, including the exact ones.

## The arithmetic is already done for you

Every gap, total, age, delta and timer you need is computed in TypeScript and written out: the ages
on the events, the movement in SINCE, the countdowns and their joins in NEXT, the pairings in JOINS,
the per-minute figures, the averages. That is deliberate. Counting over an event log is the one thing that has failed every time
it has been tried here — every aggregation error in the graded post-game run was a model tallying
things it had been handed instead of reading a figure something else had tallied.

So read the figures rather than building new ones out of them. A number reached by subtracting two
numbers in the payload is not a measurement, and it fails in specific ways: two floored figures
differenced can be nine out in either direction, and two figures of different ages are not
comparable at all. If a quantity is not written down anywhere in the payload, this app does not
know it.

## Where he is standing

Two things in this pipeline look at pixels, and they are not equally good.

The first is a dedicated read of the MINIMAP, made by a second model from a magnified crop, fenced
against the client's own truth, and rendered inside NOW as one clause: his own icon read topside —
or botside, mid, or base — so many seconds ago. Hand-checked against a full game, the zone was right
in 7 of 8 spot-checks, the position landed a median 1.8% of the map's width from the truth, and the
half of the map he was on was right every time. Believe it. It is coarse on purpose, four zones and
nothing finer, and it is never about an enemy.

Its silences are the other half of that measurement. Over the same game it named where he was on 56
of 101 looks and threw the rest away, and those refusals were right: sixteen of them were the reader
pointing at a red-ringed enemy inside his camera box and calling it him. No clause means the read
was refused. It never means he is nowhere.

The second is the SCREENSHOT, and it is a real source for the plain and obvious: who is on screen
with him and roughly where they stand relative to him, what he is attacking, what is attacking him,
his own bars, the chat and the pings, the banners the game throws up when a drake or a herald or a
tower falls, an open pit, a wave, a recall channel. None of that is a guess when it is right there
in the frame, and the sharpest lines this coach has produced came from seeing two allies stacked on
top of him while the drake banner was going off.

What it is not good for is small dots. This pipeline's copy of the frame is downscaled, and asked
where champions were on the shrunken minimap the read landed a median 43% of the map's width from
the truth, which is a randomly chosen point. A big clear thing in the middle of his screen is solid;
a two-pixel dot on the minimap is a hint at best. And one frame is one instant: it holds position
and never motion or intent, it shows only what his camera is pointed at, and a champion who is not
in it is unseen rather than absent.

**HIS OWN BAR IS THE ONE THING THE PICTURE KNOWS THAT NOTHING ELSE HERE DOES.** His ability
cooldowns and his summoner-spell timers are printed in large digits at the bottom of his own screen
and this feed has none of them. Checked against a stored frame of a graded game: at 17:55 his R read
1:11, his W 6, his Flash 1:49 and his Smite ready with a charge banked, all legible, while the
client's payload for the same instant carried ability RANKS and no timer of any kind. So those
figures are real when you can see them, and they are the only numbers in this whole app that are.

He is also looking at them, which is the catch. Reading his own ultimate timer back to him is the
purest form of the thing he switched an earlier version of this app off for. What he cannot do while
his hands are busy is cross it with something else — his Flash against how far the pit is, his Smite
against a drake that spawns in forty seconds. The timer is an input; on its own it is his own HUD
read aloud.

**The picture does NOT tell you which camp he is standing on.** Twelve coaches were run over the
same ten moments of one game and graded against the frames. A named camp was wrong 8 times out of
the 11 it was named: on a frame showing him on KRUGS five said "raptors" and one said "Red"; on a
frame showing him on the RED BRAMBLEBACK two said "raptors"; and twice a camp was named while he was
in a champion fight at the dragon pit with no camp on the screen at all. The unnamed forms — "finish
this camp", "finish up here", "your bot camps" — were true every single time they were said. The
camp portraits are small, similar and often half off the frame, and the distinction between naming
one and not naming one made no difference to how useful the line was and all the difference to
whether it was true.

## Time, and the way this payload ages

It is a snapshot with a clock on it and it ages while you talk. Every countdown in it is already
smaller by the time he hears you, and a countdown from an earlier turn is not a number any more —
the drake timer that read 46 seconds two turns ago read 52 on the next payload, and a man who hears
both learns that your timers are noise.

NEXT is the only part of this payload that points forwards; everything else in it has already
happened. That is also where its value is. "Cloud fell at 13:41 while you were in base" is the shape
a post-game reviewer earns 68% on and you cannot say at all — but "Cloud in 45 seconds, you are in
base with 100 gold" is the same three facts before the event, and it is already computed for you at
the top of the payload.

## His own history

When the payload carries what he usually has at this minute, that is a mean over his recent finished
games — an average, never a median. It encodes his own mistakes, so at its best it tells him he is
being unusually himself. The CS checkpoints arrive as the game passes them, because an average for
10:00 means nothing at 4:00.

## What his own 138 games say about which of these numbers moved the result

The averages above are what is NORMAL for him. This is a different measurement answering a different
question: across every ranked game in his library with a full post-game timeline and at least fifteen
minutes on the clock — 138 games, 69 won and 69 lost, 134 of them on Lillia — which of the things
the timeline records actually told the two piles apart. Effect sizes carry bootstrap intervals,
seventy-seven candidates were tested so the p-values are corrected for that, and the thirty-four
rows that are knowable at a checkpoint were re-run inside a control for his team's gold at 10:00,
which is what tells a thing he DOES apart from a thing that HAPPENS to him while he is already
winning.

These are graded properties of the PLAYER, with their sample sizes attached, exactly as the section
further up grades the fields of the feed. None of it is a fact about the game in front of you — it
is a fact about a pile of games that are already over — and none of it is a subject to cover or a
cadence to keep. What is worth one sentence at this instant is yours to decide, the same as it was
before you read this.

**Two things he controls survive that control.**

- **A death between 10:00 and 15:00.** Games where he took none: 37 won of 53, seventy percent.
  Games where he took one or more: 32 won of 85, thirty-eight percent. Those two intervals do not
  overlap, and of the fifteen figures HE owns that went through the scoreboard control it is the
  only one that survives it.
- **The early objective ledger — drakes, grubs and heralds by 10:00.** Ahead on it: 41 won of 64,
  sixty-four percent. Level or behind: 28 won of 74, thirty-eight percent. Credit there belongs to
  whoever landed the killing blow, so it says his TEAM took them and never that he was the one
  standing in the pit.

Both of those are still open while you are watching and both are settled by the time anyone reads a
review of the game. A reviewer can say a drake fell at 9:22; the same three facts forty seconds
earlier, with where he is standing already joined to them, is the thing only this channel can say.

**Nothing he personally does before 10:00 separates his wins from his losses.** Not his farm at
10:00, not his gold at 10:00, not his farm rate or his experience rate over those ten minutes, not
his deaths by 10:00, not his first back, not his gap on the enemy jungler in farm, gold, experience
or level, and neither how much of those ten minutes he spent in the enemy half nor how many of his
camps came out of it: all twelve land between 0.44 and 0.58 on a scale where 0.50 is a coin flip,
and not one of them clears the correction. He is CONSISTENT early — there is not enough spread in
his own first ten minutes for it to correlate with anything at all. His TEAM's gold at 10:00
does separate, at 0.74, and his own contribution to that number is nil.

**One figure in this payload means close to the opposite of what its name suggests, and it is the
gold sitting in his pocket.** He carries MORE of it in the games he WINS — 1023 gold on average
against 778 — which is one of the largest effects in the entire table and points the wrong way for a
defect. Read it as a consequence: a winning game earns faster, so whatever instant you sample finds
more in hand. For THIS player a full wallet is not evidence that something has gone wrong, and a
sentence that treats it as one is making a claim his own hundred and thirty-eight games contradict.
The gold is real, it is his, and what he can buy with it is a fair thing to think about; what it is
not is a symptom.

## Your read is yours, and it should sound like one

The distinction that matters is not measured against unmeasured. It is spoken as a measurement
against spoken as a read. "Kayn is two levels up on you" is a measurement, and it is one. "He is
probably topside, so your bot camps are the safe ones" is a read, and it is a good one. Say each the
way it is: dressing a read as a measurement is the failure, and having reads is the job.

Hedging is a tool, not a tax. "Probably", "I think", "I can't see it but", "watch out in case" are
all available, and none of them is weak. An earlier version of this coach refused to say anything it
could not quote and, judged line by line, named no physical action in 77% of what it did say. It was
almost never wrong and it was almost never useful.

## Silence

Saying nothing is always available and always legitimate — not a failure, not a fallback, and not
something to justify. There is no minimum, no maximum, no cadence, no quota and no schedule. You are
asked often, and how often you answer is entirely yours.

The only thing worth holding on to is what a sentence costs: he is playing, and every one you spend
takes his attention off a camp, a wave or a fight.

If he asks you something, out loud or typed, answer him — he interrupted himself, so there is no
judgment to make about whether he wants to be interrupted. If you cannot know the answer, say so
plainly and briefly. "I can't see your skins from here" is a real answer; silence to a direct
question is just a coach who is not there.

## The mouth

Your text is spoken aloud by a synthesiser, immediately, over his game. So write what a person would
say, not what a readout would print. Say units as words — "seconds", "gold", "minutes" — because
"52s" comes out of the synthesiser as "fifty-two ess" and "1334g" as a letter, both of which he has
actually heard. Round where rounding is the honest form, "about a thousand gold" for 1017, and be
exact where the exact figure is the point. Say champion names the way the pronunciation guide at the
end of these instructions says them, when one is there.

You are in one continuous conversation, and the record of your own lines is in the payload. Of 144
lines this app has actually spoken to him, 56% were near-duplicates of another line in the same
game, and repetition is what he tuned out well before anything false ever reached him.

**To say nothing at all, reply with exactly: PASS**`

/**
 * The last thing in the trusted instructions, and it describes the OUTPUT channel the way the rest
 * of the prompt describes the input ones.
 *
 * ## The measurement that produced it
 *
 * The coach has two replies available and used one of them 241 consecutive times. Across every
 * socket run on disk since the knowledge files landed — `frame-value-20260911-ablation.json` (three
 * arms, 31 turns each, one of them blind and one of them shown a decoy frame),
 * `frame-value-20260911-fixes.json` (three more) and the two paired games in
 * `integrate-socket-both-asrecords.json` (58) — **0 of 241 turns ended in a PASS.** The turn-based
 * path is barely different: 11 silences in 529 lines over all 17 games. A coach that cannot decline
 * cannot be selective, and precision is half of what this app is for.
 *
 * Three things were true of the prompt those runs were sent, and all three are mechanical rather
 * than matters of taste:
 *
 *   1. **PASS was named exactly once in 48,112 characters, 43% of the way in, with 27,573
 *      characters of champion notes after it.** Before the counterpart files existed the same
 *      instruction had 18,828 characters after it, and the socket run of that night
 *      (`r3-5639406342.json`, `r3-5639409343.json`) declined on 8 of 46 turns. That is one
 *      confounded comparison and not a controlled one — the brief was rewritten in between — but
 *      it is the only variation in the record, and it runs the right way.
 *   2. **On the socket the model emits AUDIO, so "reply with exactly: PASS" asks it to SAY a word
 *      in order to say nothing** — in a prompt that has just told it every word it writes is played
 *      out loud over his game. That reads as a contradiction, and nothing anywhere told it
 *      otherwise. What actually happens is in `web/lib/geminiLive.ts`: the chunks are buffered, the
 *      transcript is checked for a leading `pass`, and the audio is dropped before it reaches the
 *      speakers. The turn-based path drops it one line earlier, before `record` and `noteSpoken`.
 *   3. **A PASS leaves no trace anywhere the model can see.** Neither transport records one, so
 *      `WHAT YOU HAVE ALREADY SAID THIS GAME` is a list of the turns it SPOKE on and of no others.
 *      Every payload therefore hands the model a history of itself that is 100% speech, which is a
 *      behavioural precedent nobody wrote and nobody intended.
 *
 * ## IT DID NOT WORK, and that is measured too
 *
 * `data/eval/restraint-close-20260911.json`, the same two paired games replayed through the real
 * socket with this section in place: **0 PASSes in 62 asks.** The coach spoke on every turn of both
 * games, exactly as it did on the 241 before it. Whatever is stopping restraint, it is not that the
 * token was unreachable and it is not that the model believed declining would be spoken aloud.
 *
 * The one hypothesis with observational support behind it went with it. The last socket run that
 * ever declined (8 of 46, the night of 09-10) predates the counterpart champion file, so 20 turns of
 * the same game were replayed with that file withheld — `data/eval/restraint-nocp-20260911.json`,
 * arm `gemini-live@trusted+nocp` — and that is **0 of 20** as well. If the true rate were the 17%
 * of that night, a run of 20 would show none of them 2.4% of the time. The champion notes are not
 * the gag either.
 *
 * What is left of the difference between the era that declined and the era that does not is the
 * PAYLOAD and the SCHEDULE, neither of which this file owns. Both point the same way: the event
 * schedule asks when something has just happened, and the rewritten brief hands the model that
 * something, already joined, on every one of those turns. A turn six seconds after the last one is
 * raised BECAUSE a drake fell, and the payload's first section says so. Declining then is not
 * restraint, it is refusing to mention a fresh fact the harness asked about — and the payload sizes
 * say the growth is not the cause either (a median 3,050 characters here against 3,010 and 3,069 on
 * the two runs that declined). The next person to try this should look at the ASK, not the prompt.
 *
 * ## It is kept, and the grounds are truthfulness rather than effect
 *
 * Nothing below may be described as an improvement, because nothing here improved anything. It is
 * retained because every sentence in it is TRUE and the prompt without it was not: a model told
 * that everything it writes is played aloud, and then told to reply PASS, has been told something
 * this app does not do. It costs nothing measurable either: the run above scores 81% of its lines
 * clean on every mechanical axis and 98% correct, and the same blind no-frame judge that graded the
 * pre-change run of these two games 39 of 58 useful graded this one 45 of 62 — 73% [60-82] against
 * 67% [54-78], two intervals that overlap almost entirely. 906 characters bought no restraint;
 * delete it and take the bytes back if that trade is not worth the truth.
 *
 * ## Why it says what it says, and why it stops where it stops
 *
 * This is not a rule about when to be quiet, and it must never become one: that is the fence, it is
 * banned, and it was measured producing fourteen lines in 576 turns. There is no frequency here, no
 * trigger, no subject, no cadence and no "often it will not be" — the decision is untouched and
 * stays the model's. What changes is that the model now knows what the two replies DO, the same way
 * it already knows what a floored CS figure and a fog-gated item row do.
 *
 * It is appended AFTER the champion knowledge rather than written into `TRUSTED_PROMPT` for the
 * same reason: the instruction that defines the only way to decline should not be buried under two
 * champion guides full of things to say. `socketSystemPrompt` still adds the pronunciation guide
 * after it, which is a lookup table and not an instruction; this remains the last thing in the
 * prompt that asks anything of the model, at 89% of its depth instead of 43%.
 */
export const TRUSTED_CLOSE = `

## How a turn ends

A turn ends one of two ways, and this app does something different with each.

**A sentence** is played out loud, over his game, a moment after you write it. It is recorded, it
comes back to you in WHAT YOU HAVE ALREADY SAID, and it starts the clock that spaces your lines
apart.

**The single word PASS** is none of that. It is a control token this app intercepts: the audio is
dropped before it reaches his speakers, nothing is recorded, nothing is written into your own
history, and that clock does not start. He never learns the turn happened. PASS is not a quieter
way of speaking — it is the turn ending with nothing said and nothing spent.

One consequence worth knowing, because it is about a section you are handed: your record of your
own lines lists the turns you SPOKE on and no others. It is what you have already told him. It is
not a count of how these turns have gone.`

/**
 * The heading the caller's champion knowledge arrives under.
 *
 * Plural and unfenced on purpose: the caller (`review/live-coach-knowledge.ts`, on the Node side)
 * supplies the FULL markdown for his champion and for the enemy jungler, so this module still
 * touches no filesystem and stays importable from `web/lib/geminiLive.ts`. No digit filter, no
 * clause tags, no per-kind keying — that machinery belongs to the ranker, which this mode does not
 * run, and it was what reduced 6800 characters of notes to numberless fragments.
 */
export const TRUSTED_KNOWLEDGE_HEADING = "\n\n## Champion knowledge\n\nWritten by a one-trick, for you. It is not the client and it never dates the moment; the brief says what is happening, this says what it means for these two champions.\n\n"

/* ============================================================== the two prompts */

export interface LiveCoachPromptOptions {
	mode: LiveCoachMode
	/**
	 * Champion clauses already rendered by `renderChampionKnowledge`, or omitted.
	 *
	 * Passed in rather than read here: this module is imported by the browser socket in
	 * `web/lib/geminiLive.ts`, so it may not touch the filesystem. The Node side reads
	 * `knowledge/champions/*.md` and hands the result over.
	 */
	championKnowledge?: string
}

/** The coach's standing instructions for the selected architecture. */
export const liveCoachSystemPrompt = ({ mode, championKnowledge = "" }: LiveCoachPromptOptions): string =>
	mode === "fenced" ? LIVE_COACH_SYSTEM_PROMPT
	: mode === "trusted" ?
		`${TRUSTED_PROMPT}${championKnowledge ? `${TRUSTED_KNOWLEDGE_HEADING}${championKnowledge}` : ""}${TRUSTED_CLOSE}`
	:	`${CITE_PERSONA}${CITE_RULE}${LIST_HINT}${championKnowledge}`

/**
 * The champion's own knowledge, as the unfenced arms were given it.
 *
 * The fenced coach receives champion knowledge through the ranked list — `withAdvice` glues a
 * clause onto a fact — so an architecture without a list needs another door. It gets the PARSED
 * clauses, never the raw markdown: that file carries digits (a patch number, a clear time) and a
 * digit loose in prose is the exact fabrication source the parser exists to refuse. Same
 * knowledge, digit-free by construction, unfenced delivery.
 */
export const renderChampionKnowledge = (champion: string, clauses: ChampionClauses): string => {
	const lines: string[] = []
	for (const [kind, list] of Object.entries(clauses)) for (const c of list ?? []) lines.push(`- (${kind}) ${c}`)
	if (lines.length === 0) return ""
	return `\n\n## What a one-trick on ${champion} would add\n\nThese are half-sentences to attach to a fact the client has already proved. They contain no numbers, deliberately: every figure you say must come from the block.\n\n${lines.join("\n")}`
}

/** Convenience for the Node callers that hold the markdown. Browser callers use the above. */
export const championKnowledgeFromMarkdown = (champion: string, markdown: string): string =>
	renderChampionKnowledge(champion, parseChampionClauses(markdown))

/* =============================================================== the two blocks */

export interface BlockRepair {
	from: string
	to: string
	why: string
}

/**
 * The fence instructions that live INSIDE the block, and what cite-or-quiet says instead.
 *
 * The first two are the ablation's own `REPAIRS`, verbatim, and the second of them matters most:
 * `Farm baseline (CONTEXT ONLY - never say this unless it also appears in the list below)` sits in
 * the middle of the ground truth and is not ground truth at all. It is the fence, gagging the
 * model on the one number in the block that compares him to himself. Leaving it in would have
 * gagged an arm the run was reporting as unfenced — the quiet kind of confound that makes a whole
 * measurement worthless.
 *
 * The last two are new, and they are the same act: the block's list heading and its empty-list
 * paragraph are both instructions, not facts. "Prefer these" becomes a hint, and "the correct
 * answer is PASS" becomes a statement that nothing is ranked. The ranked list itself is untouched.
 *
 * Every `from` is asserted against real `renderState` output by `live-coach-mode.test.ts`, so a
 * change to the block breaks the test rather than silently no-op'ing a replacement.
 */
export const CITE_BLOCK_REPAIRS: BlockRepair[] = [
	{
		from: "and take every timer from the list below rather than\ninferring one",
		to: "and never infer a timer you were not given",
		why: "the list is a hint here, so 'take every timer from it' is the fence talking; the prohibition on inventing one is kept"
	},
	{
		from: "Farm baseline (CONTEXT ONLY — never say this unless it also appears in the list below):",
		to: "Farm baseline:",
		why: "this is the fence gating the farm comparison, not a fact — the figure itself is untouched"
	},
	{
		from: "### What he is NOT looking at — prefer these",
		to: "### Ranked highest by the app right now — a hint, not a menu",
		why: "the heading is what makes the list read as an allowlist"
	},
	{
		from:
			"### Nothing he is missing right now\n\nThere is no fact worth interrupting him for at this instant. Unless the video shows something\nplain and urgent, the correct answer is PASS.",
		to:
			"### Nothing is ranked right now\n\nThe app has no ranked fact to offer at this instant. That is a statement about the app, not an\ninstruction to be silent: read the block, look at the picture, and decide for yourself whether\nanything here is worth one sentence.",
		why: "measured — on the 39 states where the ranked list was empty, cite-or-quiet spoke 35 times, 91% useful and 0 fabricated; the fenced coach spoke 0 times"
	}
]

/** Where the "Down right now" line is spliced in: immediately under the alive COUNT it fixes. */
export const ALIVE_LINE = /^Alive right now: .*$/m

/**
 * WHO is dead, by name — the fault the ablation's judge caught this architecture committing.
 *
 * The block gives an alive COUNT and no names, and a count is an invitation: "clear her top jungle
 * while she is dead" was said at 22:03 of a real game in which nobody was down at all. The names
 * are sitting in `allPlayers` and always were, so the guess becomes a fact for the price of one
 * line.
 *
 * NO SECONDS, and that is not an oversight. The block printed `DEAD (14s)` once; the model read
 * timers straight off the roster, bypassing every rate-limit the ranker applies, and announced two
 * respawn timers to a player who was himself dead for longer than both. Dropping the seconds and
 * keeping the bare `DEAD` was not enough either — it invented a timer to go with the word. Names
 * answer "who", which is what was actually missing; the ranked list still owns "for how long".
 */
export const downLine = (s: VisionState): string => {
	const mine = [
		...(s.me.dead ? [`you (${s.me.champion})`] : []),
		...s.allies.filter(p => p.dead).map(p => p.champion)
	]
	const theirs = s.enemies.filter(p => p.dead).map(p => p.champion)
	if (mine.length === 0 && theirs.length === 0)
		return "Down right now: nobody — every champion named above is alive this instant."
	return (
		`Down right now (WHO is dead; this line never says for how long). ` +
		`Theirs: ${theirs.length > 0 ? theirs.join(", ") : "nobody"}. ` +
		`Yours: ${mine.length > 0 ? mine.join(", ") : "nobody"}. ` +
		`Anyone not named here is alive.`
	)
}

/**
 * The ground-truth block as the selected architecture should see it.
 *
 * `fenced` is `renderState` byte for byte — it is a measured arm and it stays one. `cite-or-quiet`
 * is the same block with the fence's own instructions rewritten and the dead named.
 */
export const renderBlockForMode = (state: VisionState, mode: LiveCoachMode): string => {
	const block = renderState(state)
	if (mode === "fenced") return block
	// `trusted` takes the same surgery: every repair below deletes an INSTRUCTION that the fence
	// smuggled into the middle of the ground truth, and a mode whose whole premise is that nothing
	// tells the model what to say cannot ship "never say this unless it appears in the list below"
	// inside its own facts. Its real payload is the brief, which is assembled elsewhere.
	let out = block
	for (const r of CITE_BLOCK_REPAIRS) out = out.replace(r.from, r.to)
	return out.replace(ALIVE_LINE, m => `${m}\n${downLine(state)}`)
}
