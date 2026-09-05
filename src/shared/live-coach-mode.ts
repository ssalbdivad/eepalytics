/**
 * Which ARCHITECTURE the live coach runs on — and the text that makes each one what it is.
 *
 * ## The measurement this file ships
 *
 * Four architectures, ONE model, 363 recorded samples from four real games replayed IN ORDER, and
 * every spoken line judged blind with the arm labels stripped. The run is
 * `data/eval/ablation-20260905-073028.json`, verbatim, and `scripts/ablate-autonomy.ts` re-runs it.
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
 * out of `scripts/ablate-autonomy.ts`. `src/shared/live-coach-mode.test.ts` asserts that equality
 * against the script's own `ARMS` export, so a well-meaning edit here fails the suite rather than
 * quietly invalidating the run that justified the change. Anything added for the shipped app —
 * the list hint, the two prohibitions the judge found — lives in `LIST_HINT`, appended after, so
 * the measured text and the shipped delta can always be told apart.
 */

import { parseChampionClauses } from "./champion-advice.ts"
import type { ChampionClauses } from "./champion-advice.ts"
import { LIVE_COACH_SYSTEM_PROMPT } from "./live-prompt.ts"
import { downLine, renderBriefing, renderState } from "./live-state.ts"
import type { VisionState } from "./live-state.ts"

export type LiveCoachMode = "briefing" | "cite-or-quiet" | "fenced"

/**
 * The briefing, because it is the only thing measured to move the number he complained about.
 *
 * `cite-or-quiet` and `fenced` are both still here and both still exactly what they were — a
 * default change that quietly deletes the comparison it beat is a default change nobody can check.
 */
export const DEFAULT_LIVE_COACH_MODE: LiveCoachMode = "briefing"

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
	evidence: string
}[] = [
	{
		id: "briefing",
		label: "Briefing (what is coming)",
		blurb:
			"The same one hard rule, but the block is rebuilt as a briefing rather than a snapshot: what neutral objective is up and for how long, what spawns next and in how many seconds, and what she has already said this game. The jungle race and the farm comparison are still there, at the bottom, because they were measured to be the least useful thing she says. What is NOT in it any more: the last ninety seconds of change, and his career habits — both were measured to add nothing on top of the schedule, so they only cost latency and dilute the rest.",
		evidence:
			"Nine layers of context replayed through one model over 88 real states of his own games, every line judged blind: the shipped block scored 29% useful, the same block plus the objective schedule scored 55% (p = 0.0009). Ninety seconds of exact history bought nothing (p = 0.94), and telling the model to prefer objectives WITHOUT giving it the timers reached 37% and invented dragons that had not spawned. Judged blind again by four models against the shipped block, three of four scored the briefing better and all four said the objective schedule is now being read out every turn the way the CS race used to be — which is what the prompt's retirement rule is for."
	},
	{
		id: "cite-or-quiet",
		label: "Cite or stay quiet",
		blurb:
			"She reads the whole ground-truth block and the screenshot and decides for herself what is worth saying, under one hard rule: every number and every champion name must appear in this turn's block, and anything she cannot cite that way she does not say.",
		evidence:
			"363 real samples, four games, judged blind: spoke on 94 of 102 turns against the fence's 11, with fabrication still 0 (95% CI 0-3%, n=132). Paced to one line every 45 seconds, as it ships, that is 34 useful lines in a 36-minute game against the fence's 7, five of them in its busiest four minutes."
	},
	{
		id: "fenced",
		label: "Ranked list only (the old fence)",
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

/**
 * What the BRIEFING mode adds to the measured arm, in place of `LIST_HINT`.
 *
 * Three rules here reverse things this app has instructed the coach to do since it was written,
 * and all three reversals are measurements rather than taste (`data/eval/why-shallow.md`, 554
 * lines judged blind by a model that could not see which arm wrote them).
 *
 * **The subject order.** Classified by what the sentence is about: a neutral objective 61% useful
 * over 211 lines, an enemy being down 41%, gold 32%, and farm, CS, clearing and routing 4% — three
 * useful lines out of eighty-four. That last is the subject `live-facts.ts` ranks first, the
 * subject the enemy-jungler comparison was built to serve, and the subject a fifth of the shipped
 * coach's lines are about. It is not demoted because it is false; every figure in it is exact. It
 * is demoted because it is the same true thing every turn of every game: across 88 states the
 * block's race verdict read "he is behind you" in 82 and "ahead of you" in none.
 *
 * **The test for whether a line earns a sentence.** `AGENTS.md` used to name two — not visible,
 * and not generic — and the first of them is inverted in the data. Lines about something plainly
 * on his screen were judged useful 45% of the time against 27% for lines about something
 * invisible, and the best quadrant in the corpus is visible AND specific, at 67% over 205 lines.
 * What kills a line is genericness alone: 14% against 55%. So the move this text now asks for is
 * a DECISION about something in front of him — naming which of the things he can already see the
 * next thirty seconds are for — and the old rule forbade exactly that.
 *
 * **A standing fact is news once.** This is the new one, and it is here because the first two
 * shipped and the disease came back wearing different clothes. Four models judged the briefing
 * blind against the shipped block; three of four scored it better (opus-5 13% against 3%, gemini
 * 8/49 against 2/48 at p = 0.09, gpt-5 not better at all) and ALL FOUR said the same thing about
 * why it still is not worth talking to: the monotone fact used to be *you are ahead of him on CS*,
 * true on every turn of four games, and it is now *an objective is up or coming*, true on almost
 * every turn of any game. The soul-and-baron pair switched on at 19:42 was still being read out at
 * 36:43, eighteen turns later. The subject changed; the metronome did not. Genericness is not only
 * a property of a sentence against other games — it is a property of a sentence against the last
 * one this coach said, and only the second half of that was written down.
 *
 * Nothing here tells it to talk about a thing the block cannot supply, which is the other half of
 * the same run: told to prefer objectives and given no timers, the model invented dragons that had
 * not spawned (37%, and worse than the schedule's 55%). Prompting picks the subject; only data
 * makes the sentence true. Every rule below points at a section that is really in the block.
 *
 * The rule about quoting career lines verbatim went out with the lines themselves — `arc` and
 * `habits` no longer reach this block at all (see `withoutUnmeasuredLayers`), so a prohibition on
 * rewording them would now be an instruction about a section the model never sees.
 *
 * NO FIGURES APPEAR BELOW, and that is deliberate for the reason recorded all over this file:
 * every digit put in front of this model is a digit it can say back. An earlier prompt offered two
 * catchphrases as examples and got them in 71% of its lines. The sample sizes belong in this
 * comment; the model only needs the order.
 */
export const BRIEFING_HINT = `

## Your one sentence is a DECISION about what is in front of him

He is looking at the same map you are. The useful thing is never to read him something off it, and
never to recite a fact he could not have reached — it is to say **which of the things in front of
him the next thirty seconds are for.** That is the whole job: he has five places he could be and
one clock, and you have the clock.

So talking about what is on his screen is not the failure. Being TRUE OF ANY MINUTE is.

## What is worth a sentence, in the order that was measured

The block is a BRIEFING, not a snapshot. It opens with the map's own clock — what neutral objective
is standing there untaken and for how long, and what spawns next and in how many seconds. Read that
first, every turn.

Prefer, in this order:

- **The next neutral objective** — dragon, grubs, herald, baron. Where he should BE in the next
  thirty seconds is the jungler's whole job, and it is the only subject he cannot work out from
  his own screen without doing the arithmetic mid-clear. An objective that has stood untaken for
  minutes is a statement that nobody is contesting it; say so.
- **An enemy who is down**, and what that opens up while it lasts.
- **Gold he is carrying**, when it has been sitting long enough to be a decision.
- **His farm, the jungle race, his clear and his route** — LAST, and only when something about it
  has actually changed. Those numbers are exact and they are near the bottom of the block for a
  reason: they say the same true thing every turn of every game, and a coach who reaches for them
  by default says one sentence over and over for a whole game. If a farm line would be as true
  five minutes ago as it is now, it is not a line.

## The test is GENERIC, not invisible

Say the thing that is true of THIS minute of THIS game. **A sentence that would have been equally
true five minutes ago, or in a different game entirely, is the failure** — however correct it is.

You are NOT forbidden from talking about what is on his screen. Naming which of the things he can
see the next thirty seconds are for is the most useful thing you can do: he is looking at the same
map you are and the question is which part of it matters now.

**The test bites hardest on the subject you are most RIGHT about.** A standing fact hands you the
same true sentence on every turn it stays true for, and the schedule prints how long each one has
been standing there. An objective that was already up when you last spoke is not news now — it is
the sentence you already said with a later clock on it. Say a standing fact ONCE, when it starts
or when it is about to end, and let the turns in between go. Where the block records what you have
already said this game, read it as the list of subjects that are used up.

That leaves PASS as the answer on most turns, and PASS is a real answer. A coach who says one
thing that changes his route beats a coach who is correct every twenty seconds.

## Every timer you say is one you were given

The schedule section is the only place the map's clock exists. Never complete a spawn time, a
respawn, a camp timer or a count of what is left from what you know about League — a number that
sounds right and was not measured is the one kind of mistake he cannot catch, and it sends him to a
pit that is empty.

## Three things this block never tells you, each of which has been said out loud

- **Where a teammate is, or what he is about to do.** There are no positions in the block for
  anybody. "Push mid with Taliyah" and "group with Taliyah" were both said in the run this
  architecture was measured on, about a champion whose location no channel in this app knows. A
  teammate's SCORE is written down and is yours to cite. His place, his plan and his path are not.
- **WHICH champion is dead, from a count.** "Alive right now: 4 of yours against 5 of theirs" is
  arithmetic, not a name. The board carries a "Down right now" line naming who is actually down; a
  champion who is not on it is alive. Said out loud in a real game: "clear her top jungle while she
  is dead", in a state where nobody was down at all.
- **How long anyone is dead for.** That line gives names and never seconds, deliberately — shown a
  bare timer beside a name, this coach has read it back after it expired and invented one where
  there was none. A respawn timer is yours to say only where the ranked list writes one out.`

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
	: mode === "briefing" ? `${CITE_PERSONA}${CITE_RULE}${BRIEFING_HINT}${championKnowledge}`
	: `${CITE_PERSONA}${CITE_RULE}${LIST_HINT}${championKnowledge}`

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
 * Lives in `live-state.ts` now, because the briefing block needs the same line and that file may
 * not import this one. Re-exported here so the two modes that were measured with it keep importing
 * it from where they always did.
 */
export { downLine }

/**
 * The two layers the ladder measured at nothing, taken out of the block the shipped mode sends.
 *
 * Both were carried at the BOTTOM of the briefing on the argument that they cost a few hundred
 * characters and occasionally reach a fact nothing else can. The ladder is not ambiguous about
 * what they bought: ninety seconds of exactly-computed change moved judged usefulness from 29% to
 * 30% (p = 0.94) and his measured career habits moved 55% to 51% on top of the schedule (p = 0.58).
 * Neither is a fact the block cannot express; both are context the model has to read past to reach
 * the schedule, and the habits layer is the sharpest fabrication surface in the whole briefing — a
 * cue about his PRESENCE at the grub pit was requoted as a claim about who TAKES the grubs, out
 * loud, from faithful quotation.
 *
 * Cut here rather than upstream, deliberately. `buildLiveState` still computes `arc` and `habits`,
 * `renderBriefing` still renders them, and `data/eval` still replays them, so restoring the layers
 * is deleting one call and re-running `scripts/ablate-autonomy.ts` — not rebuilding two analysers.
 * `said` stays: it is the only section that tells the coach which subjects are used up, and the
 * new metronome is exactly the failure it exists to catch.
 */
export const withoutUnmeasuredLayers = (state: VisionState): VisionState => {
	const out = { ...state }
	delete out.arc
	delete out.habits
	return out
}

/**
 * The ground-truth block as the selected architecture should see it.
 *
 * `fenced` is `renderState` byte for byte — it is a measured arm and it stays one. `cite-or-quiet`
 * is the same block with the fence's own instructions rewritten and the dead named.
 */
export const renderBlockForMode = (state: VisionState, mode: LiveCoachMode): string => {
	if (mode === "briefing") return renderBriefing(withoutUnmeasuredLayers(state))
	const block = renderState(state)
	if (mode === "fenced") return block
	let out = block
	for (const r of CITE_BLOCK_REPAIRS) out = out.replace(r.from, r.to)
	return out.replace(ALIVE_LINE, m => `${m}\n${downLine(state)}`)
}
