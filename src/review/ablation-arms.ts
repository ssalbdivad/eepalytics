/**
 * The four architectures of the 2026-09-05 autonomy ablation, kept as DATA because the run is
 * still the reason the coach is shaped the way it is.
 *
 * ## Why this is in `src/` and not in a script
 *
 * `scripts/ablate-autonomy.ts` ran the experiment and wrote
 * `data/eval/ablation-20260905-073028.json` and `data/eval/ablation-shipped-20260905.json`. That
 * run is why `DEFAULT_LIVE_COACH_MODE` is no longer `fenced`: `fenced` spoke on 11 of 102 turns,
 * `cite-or-quiet` on 94 of 102 with a TIGHTER fabrication interval, so the fence came out.
 *
 * The script has since been superseded as an INSTRUMENT — `scripts/bench-stream.ts` replays the
 * raw recorded client samples at every model at once, pairs each state with the journal frame for
 * that same instant rather than one screenshot reused, and `judge-corpus.ts` grades the result
 * blinded and per game. Nothing in the ablation's driver survives that comparison.
 *
 * Its PROMPTS are a different thing entirely. They are not code that was replaced, they are the
 * exact text a stored measurement was taken over, and `src/shared/live-coach-mode.ts` ships a copy
 * of two of them. A copy that nothing pins is a copy that drifts, and a drifted copy still looks
 * exactly like the measured one: the run file goes on saying 94 of 102 about a prompt nobody has
 * run. So the text lives here, in the tree the test glob covers, and
 * `src/shared/live-coach-mode.test.ts` asserts the shipped strings against it byte for byte.
 *
 * **Every string below is VERBATIM from the run. Do not edit, reword, reformat or "fix" one.** If
 * the shipped coach needs different words, change `live-coach-mode.ts` and let the pin fail — that
 * failure is the whole point, and it is where you decide whether the old number still applies.
 *
 * `ablationChampionKnowledge` reads the FROZEN clause corpus in `knowledge/legacy-clauses.ts`.
 */

import { createHash } from "node:crypto"
import { legacyClauseSection } from "../knowledge/legacy-clauses.ts"
import { parseChampionClauses } from "../shared/champion-advice.ts"
import { liveCoachSystemPrompt } from "../shared/live-coach-mode.ts"
import { LIVE_COACH_SYSTEM_PROMPT } from "../shared/live-prompt.ts"
import { liveChampionKnowledge } from "./live-coach-knowledge.ts"

/* ========================================================== the block surgery */

/**
 * Cut the fence's own output out of the block.
 *
 * The ranked list — and its explicit empty-case paragraph, which is just as much a fence
 * instruction — runs from its heading to the "ten champions" paragraph that closes every block.
 * Everything above it is raw ground truth and is left byte-identical.
 *
 * The closing paragraph points at "the list below", which no longer exists once the list is gone.
 * A dangling reference is not neutral: it tells the model something was withheld. So that clause
 * alone is repaired, and the substitution is recorded in the run output.
 */
export const ABLATION_LIST_HEADINGS = ["### What he is NOT looking at", "### Nothing he is missing right now"]

/**
 * The two places `renderState` points at the list from OUTSIDE it.
 *
 * Both were found by a test rather than by reading, and the second one matters more than the
 * first. `Farm baseline (CONTEXT ONLY — never say this unless it also appears in the list below)`
 * sits in the middle of the ground truth and is not ground truth at all: it is the fence, telling
 * the model it may not use the one number in the block that compares him to himself. Leaving it in
 * would have gagged the unfenced arms on farm while the run reported them as unfenced, which is
 * the quiet kind of confound that makes a whole measurement worthless.
 *
 * Both repairs keep the FACT and drop only the instruction, and both are recorded in the run
 * output so the surgery can be checked by eye.
 */
export const ABLATION_REPAIRS: { from: string; to: string; why: string }[] = [
	{
		from: "and take every timer from the list below rather than\ninferring one",
		to: "and never infer a timer you were not given",
		why: "a pointer at a list that is no longer there tells the model something was withheld"
	},
	{
		from: "Farm baseline (CONTEXT ONLY — never say this unless it also appears in the list below):",
		to: "Farm baseline:",
		why: "this is the fence gating the farm comparison, not a fact — the figure itself is untouched"
	}
]

export const stripRankedList = (block: string): string => {
	const tail = block.indexOf("**The ten champions above")
	if (tail < 0) return block
	let head = -1
	for (const h of ABLATION_LIST_HEADINGS) {
		const at = block.indexOf(h)
		if (at >= 0 && (head < 0 || at < head)) head = at
	}
	let out = head < 0 ? block : `${block.slice(0, head)}${block.slice(tail)}`
	for (const r of ABLATION_REPAIRS) out = out.replace(r.from, r.to)
	return out
}

export const countRankedFacts = (block: string): number =>
	block.split("\n").filter(l => l.startsWith("- ")).length

/* ==================================================================== the arms */

/**
 * The champion's own knowledge, as the fenced coach gets it.
 *
 * Arms 3 and 4 lose the ranked list, and the ranked list is where champion knowledge reaches the
 * shipped coach — `withAdvice` appends a clause to a fact. Handing them the raw markdown instead
 * would be a different experiment: that file carries digits (a patch number, a clear time), and a
 * digit in prose is exactly the fabrication source the parser exists to refuse. So they get the
 * PARSED clauses, which are digit-free by construction. Same knowledge, unfenced delivery.
 */
export const ablationChampionKnowledge = (champion: string): string => {
	/*
	 * FROZEN, not read off disk. The markdown these clauses came from was deleted on 2026-09-18
	 * because it was model-authored and one of its sentences was false; the sections themselves are
	 * reproduced byte for byte in `knowledge/legacy-clauses.ts`. This arm must read the AS-MEASURED
	 * corpus, retractions included, or the stored runs it exists to reproduce stop being
	 * reproducible — `liveChampionKnowledge` is the one that reads the shipped, retracted text.
	 */
	const section = legacyClauseSection(champion.toLowerCase().replace(/[^a-z]/g, ""))
	if (section === "") return ""
	const clauses = parseChampionClauses(section)
	const lines: string[] = []
	for (const [kind, list] of Object.entries(clauses))
		for (const c of list ?? []) lines.push(`- (${kind}) ${c}`)
	if (lines.length === 0) return ""
	return `\n\n## What a one-trick on ${champion} would add\n\nThese are half-sentences to attach to a fact the client has already proved. They contain no numbers, deliberately: every figure you say must come from the block.\n\n${lines.join("\n")}`
}

/** Arm 2: the shipped prompt, plus the one permission the fence withholds. */
export const ABLATION_SEE_SUPPLEMENT = `

## You may also speak about what you can SEE

Everything above still holds, and this is added to it rather than replacing any of it.

The ranked list is not the only thing you may say. **If the picture shows something useful that
the block cannot state, you may say that instead**, in the same one sentence, ending on the same
kind of action.

What the picture can honestly carry: where he is on the map, where an enemy who is visible on the
minimap right now is, what is on his screen, which objective pit is open, whether a wave is
pushing, whether he is in a corridor with no exit behind him.

The number rules do NOT relax. Every digit you say still has to appear in this message's block.
Read no figure off the HUD — the block is exact and the picture is pixels. One frame is an
instant, so it contains position and never motion or intent: "he is on the minimap in your blue
side" is fair, "he is coming for your red" is invented.

And an empty list is no longer automatically a PASS. If the list is empty but the picture shows
something worth one sentence, say it. If neither has anything, PASS is still the right answer.`

/**
 * Arms 3 and 4 share a persona and a shape, so a difference between them is the RULE and nothing
 * else. Both are written from scratch rather than by deleting paragraphs from the shipped prompt:
 * that prompt is 380 lines of accumulated prohibitions, and an arm meant to measure autonomy
 * cannot be built by trimming a document whose whole subject is restraint.
 */
export const ABLATION_PERSONA = `You are Coach Lillia, coaching a jungle main out loud while he plays. You are the friend who is
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

export const ABLATION_CITE_RULE = `

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

export const ABLATION_FREE_RULE = `

## Coach him the way a challenger one-trick would

You have full autonomy. Use everything in front of you — the block, the picture, and everything you
know about League of Legends, this champion, this matchup and this stage of the game.

Nothing is pre-selected for you. There is no list to choose from and no fact that has been vetted
on your behalf. Decide for yourself what the most useful thing to say right now is, and say it.

Read the picture properly: his position, the minimap, the wave states, the objective timers, who is
grouped where, what he is standing next to. That is what a coach sitting beside him would be
looking at, and it is why you are given it.

Be the coach he would pay for.`

export interface AblationArm {
	id: string
	label: string
	/** Does this arm see the fence's ranked list? */
	seesList: boolean
	/**
	 * Which of the three blocks this arm is handed.
	 *
	 * `full` is `renderState` verbatim, `stripped` is the measured surgery, and `shipped` is
	 * `renderBlockForMode(state, "cite-or-quiet")` — the real function the app would call. A
	 * separate field rather than a second boolean because the shipped block both KEEPS the list and
	 * is not the fenced block, which no boolean can say.
	 */
	blockKind: "full" | "stripped" | "shipped"
	system: (champion: string) => string
	why: string
}

export const ABLATION_ARMS: AblationArm[] = [
	{
		id: "fenced",
		label: "FENCED — the old fence",
		seesList: true,
		blockKind: "full",
		system: () => LIVE_COACH_SYSTEM_PROMPT,
		why: "The baseline. `shared/live-prompt.ts` verbatim, `renderState` verbatim."
	},
	{
		id: "fenced-see",
		label: "FENCED+SEE — the list, plus permission to speak about the picture",
		seesList: true,
		blockKind: "full",
		system: () => `${LIVE_COACH_SYSTEM_PROMPT}${ABLATION_SEE_SUPPLEMENT}`,
		why: "Byte-identical block to `fenced`. The cheapest possible test of whether the fence alone is what silences the frame."
	},
	{
		id: "cite-or-quiet",
		label: "CITE-OR-QUIET — no ranked list, one citation rule",
		seesList: false,
		blockKind: "stripped",
		system: champ => `${ABLATION_PERSONA}${ABLATION_CITE_RULE}${ablationChampionKnowledge(champ)}`,
		why: "The fence's ranked list is cut from the block. Persona, raw ground truth, the picture, the champion's digit-free clauses, and one rule."
	},
	{
		id: "free",
		label: "FREE — full autonomy",
		seesList: false,
		blockKind: "stripped",
		system: champ => `${ABLATION_PERSONA}${ABLATION_FREE_RULE}${ablationChampionKnowledge(champ)}`,
		why: "Byte-identical stripped block to `cite-or-quiet`. The upper bound on usefulness and, presumably, on fabrication."
	},
	{
		id: "shipped",
		label: "SHIPPED — what `liveCoachMode: cite-or-quiet` actually sends",
		seesList: true,
		blockKind: "shipped",
		/*
		 * Not a paraphrase of the winning arm — the functions themselves.
		 *
		 * `liveCoachSystemPrompt` and `renderBlockForMode` are what the app calls once the three
		 * wiring patches land, and `liveChampionKnowledge` is the door the champion clauses come
		 * through. Reimplementing any of them here would measure a copy, and the copy is exactly
		 * where a shipped regression hides.
		 *
		 * It differs from `cite-or-quiet` in three ways, all of them additions made AFTER the run
		 * that justified the architecture, and none of them measured until now: the `LIST_HINT`
		 * section (the ranked list demoted from allowlist to hint, plus two prohibitions the blind
		 * judge wrote up), the ranked list left IN the block rather than cut out, and the
		 * `Down right now` line naming who is dead. Two of those exist to close judge-found faults
		 * and one exists to keep the ranker's work; all three add text, and added text is how a
		 * coach gets quiet again.
		 */
		system: champ =>
			liveCoachSystemPrompt({ mode: "cite-or-quiet", championKnowledge: liveChampionKnowledge(champ) }),
		why: "The real shipped functions, on the real shipped block. The only arm here that is not a reconstruction."
	}
]


/* ================================================== the run's own record of the text */

/**
 * How the run recorded its own prompts, so an arm can be checked against the MEASUREMENT rather
 * than against a copy somebody typed.
 *
 * Every cell writes `systemPromptSha` and `systemPromptChars` beside the arm's full text into the
 * run file. This is the first sixteen hex digits of the sha256, which is what
 * `ablate-autonomy.ts` wrote and therefore what the stored files carry.
 */
export const promptSha = (text: string): string =>
	createHash("sha256").update(text).digest("hex").slice(0, 16)

export interface PromptFingerprint {
	/** sha16 and length of the text the 2026-09-05 run actually sent for this arm, champion Lillia. */
	measured: { sha: string; chars: number }
	/** sha16 and length of what `ABLATION_ARMS` emits TODAY for the same champion. */
	today: { sha: string; chars: number }
	/** Why they differ, when they do. Empty string means they do not. */
	drift: string
}

/**
 * The pin, and the one place this file admits a legacy prompt has already moved.
 *
 * `data/` is gitignored, so a test cannot read `data/eval/ablation-20260905-073028.json` on a
 * fresh checkout — these figures were read out of it on 2026-09-11 and copied here so the check is
 * self-contained. `src/review/ablation-arms.test.ts` recomputes both columns from the text in this
 * tree, so a reword of ANY of the five arms fails the suite whichever column it moves.
 *
 * **Three arms are byte-identical to the run and two are not.** `cite-or-quiet`, `free` and
 * `shipped` reproduce the measured text exactly — those arms own their words, right here.
 * `fenced` and `fenced-see` do not, and cannot: they are defined as `LIVE_COACH_SYSTEM_PROMPT`
 * plus, for the second, a supplement, and that module is the LIVE fenced prompt rather than a
 * frozen copy of it. It has grown 3,692 characters since the run. Nothing caught that for six
 * days, because a reference cannot drift from itself.
 *
 * So the fence's own row in every table — 11 of 102 turns spoken, 0 fabrications [0-26%] — was
 * measured over 21,687 characters this repo can no longer emit. Quote it as a fact about the
 * fenced ARCHITECTURE, never as a fact about the text in `live-prompt.ts` today. Re-freezing the
 * old text here would be the wrong fix: it would silently change what `--arms fenced` means in the
 * NEXT run, to make an old number look current.
 */
export const ABLATION_PROMPT_FINGERPRINTS: Record<string, PromptFingerprint> = {
	fenced: {
		measured: { sha: "8a8df59750da5fff", chars: 21687 },
		today: { sha: "bcf14b1af6de0b6a", chars: 25379 },
		drift: "`shared/live-prompt.ts` is the live fenced prompt, not a frozen copy, and has grown since the run"
	},
	"fenced-see": {
		measured: { sha: "edc226f5561d6ed6", chars: 22816 },
		today: { sha: "8a3d74238ed36c83", chars: 26508 },
		drift: "carries `fenced` whole, so it inherits exactly that drift"
	},
	"cite-or-quiet": {
		measured: { sha: "1fff3e2d6387a7f9", chars: 5152 },
		today: { sha: "1fff3e2d6387a7f9", chars: 5152 },
		drift: ""
	},
	free: {
		measured: { sha: "8de1e3aa0cf030a2", chars: 4207 },
		today: { sha: "8de1e3aa0cf030a2", chars: 4207 },
		drift: ""
	},
	/*
	 * Only in `data/eval/ablation-shipped-20260905.json`; the first run had no shipped arm.
	 *
	 * DRIFTED on 2026-09-18, by exactly two clauses and 173 characters. `shipped` is the only arm
	 * that reads `liveChampionKnowledge`, i.e. the text a player actually hears, and two Lillia
	 * clauses were retracted there because they rest on a sentence no source supports — see
	 * `RETRACTIONS` in `knowledge/legacy-clauses.ts`. The four measured arms are unchanged, which is
	 * the whole reason the clause corpus was frozen rather than regenerated.
	 */
	shipped: {
		measured: { sha: "0f4dab533a8a6f96", chars: 7089 },
		today: { sha: "6342ea4a0961beb1", chars: 6916 },
		drift: "two Lillia clauses retracted on 2026-09-18 — both taught the Swirlseed as a scouting tool, which the wiki and Data Dragon both refute"
	}
}

/** The champion every fingerprint above was taken with — the arm's text embeds its clauses. */
export const FINGERPRINT_CHAMPION = "Lillia"
