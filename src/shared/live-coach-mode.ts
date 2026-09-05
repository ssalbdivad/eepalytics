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
import { renderState } from "./live-state.ts"
import type { VisionState } from "./live-state.ts"

export type LiveCoachMode = "cite-or-quiet" | "fenced"

export const DEFAULT_LIVE_COACH_MODE: LiveCoachMode = "cite-or-quiet"

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
		id: "cite-or-quiet",
		label: "Cite or stay quiet",
		blurb:
			"She reads the whole ground-truth block and the screenshot and decides for herself what is worth saying, under one hard rule: every number and every champion name must appear in this turn's block, and anything she cannot cite that way she does not say.",
		evidence:
			"363 real samples, four games, judged blind: spoke on 94 of 102 turns against the fence's 11, with fabrication still 0 (95% CI 0-3%, n=132) — about 81 useful lines a game against 6."
	},
	{
		id: "fenced",
		label: "Ranked list only (the old fence)",
		blurb:
			"She may only speak lines this app computed and ranked in TypeScript first, and an empty list means she stays quiet. Nothing she says can be wrong, because she is choosing from a menu the app already checked.",
		evidence:
			"Same run: 0 fabrications, but 14 lines in 576 turns — six of them in the whole first seven minutes, which is where a jungler decides his route."
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
	mode === "fenced" ? LIVE_COACH_SYSTEM_PROMPT : `${CITE_PERSONA}${CITE_RULE}${LIST_HINT}${championKnowledge}`

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
	let out = block
	for (const r of CITE_BLOCK_REPAIRS) out = out.replace(r.from, r.to)
	return out.replace(ALIVE_LINE, m => `${m}\n${downLine(state)}`)
}
