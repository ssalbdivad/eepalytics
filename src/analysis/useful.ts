/**
 * Is a spoken coach line USEFUL — not merely true?
 *
 * ## Why this file exists, in one transcript
 *
 * Nine lines, four minutes, after which the owner turned the coach off mid-game:
 *
 * ```
 *   That is a tough one, but they took Hextech drake.
 *   Nice work clearing, your 40 farm is just behind your average of 42.
 *   Awesome clear, you are farming above your average of 37 right now.
 *   You are 30 CS up on BRY-er, so keep the route moving.
 *   BRY-er is still at 0 CS, so farm your camps to keep building this lead.
 *   Try to pick up the pace, your 20 farm is not pacing to match your average of 30.
 *   Try to pick it up, your 20 farm is not pacing to match your 28 CS average.
 *   Look at that farm lead, you have 20 CS to BRY-er 0 CS.
 *   Great job on that clear, you are 20 CS up on BRY-er.
 * ```
 *
 * **Every one of those lines is true, and `analysis/coach-score.ts` scores the set as clean.** That
 * is the whole problem. The app has measured CORRECTNESS for months, correctness was already at
 * ceiling, and so months of tuning moved a number that had nowhere to go. Eight of the nine lines
 * are about farm, seven name no physical act, and the set could be pasted onto a different game
 * with the digits changed.
 *
 * From first principles a line is useful iff it CHANGES WHAT HE DOES, FOR THE BETTER, AT A MOMENT
 * WHEN HE CAN STILL ACT. That decomposes into six axes, and only the last was ever measured:
 *
 *   1. `timely`        — does the advice still apply when the SENTENCE FINISHES?
 *   2. `not-redundant` — is the fact already plainly on his screen?
 *   3. `not-generic`   — could this sentence have come from a different game?
 *   4. `actionable`    — can you name the physical action in five words?  (STRICTER here than in
 *                          `coach-score.ts`, deliberately: that file calls the same signal "not
 *                          automatically a defect", because the prompt sanctions a bare fact. That
 *                          is the right call for a FABRICATION scorer and the wrong one here — a
 *                          bare fact is exactly the thing that is true and changes nothing, and it
 *                          is what this instrument was built to count.)
 *   5. `prioritised`   — of everything true then, was this the thing that mattered?
 *   6. `correct`       — is every figure backed?
 *
 * This module is the ASSEMBLY. It owns nothing that another module already owns:
 *
 *   - axis 1 is `stalenessOf` from `analysis/timeliness.ts`;
 *   - axis 3's forced-choice arm is `analysis/discriminability.ts`, driven by a judge in the
 *     script and handed back here as one boolean per line;
 *   - axes 4 and 6 are `scoreLine` from `analysis/coach-score.ts`.
 *
 * What is genuinely new here is axes 2 and 5, the near-duplicate arm of axis 3, and the
 * TRANSCRIPT-level view — because five of the nine lines above pass every per-line check that
 * exists and the transcript is still the failure.
 *
 * ## The premise comes from the OFFERED FACT, not from the spoken sentence
 *
 * `premiseOf` in `timeliness.ts` parses the RANKER's templates. Measured here: it returns
 * `unknown` for all nine lines above, because a model rephrases. So when the offered list is
 * available, every classification here is taken from the ranked fact the line was matched to, and
 * only the SPEECH DURATION comes from what was actually said. That is strictly better than either
 * source alone — the premise is exact, and the clock is the real one. The text-only classifiers
 * (`topicOfText`, `screenOfText`) are the fallback for a transcript recorded without its lists,
 * they are coarse on purpose, and every rate they produce is labelled as coarse.
 *
 * ## Nothing here is a fabrication check
 *
 * Axis 6 is delegated whole. A second fabrication scorer would be a second opinion on a settled
 * question, and two scorers that disagree is worse than one that is wrong.
 */

import {
	scoreLine,
	wilson,
	separated,
	normalizeNumbers,
	FABRICATION_FAULTS,
	type CoachFault,
	type Interval
} from "./coach-score.ts"
import {
	stalenessOf,
	premiseOf,
	speechDurationSec,
	endOfSec,
	type CoachState,
	type PremiseKind,
	type Staleness,
	type StalenessOptions
} from "./timeliness.ts"
import { maskLine } from "./discriminability.ts"

/* =================================================================== the axes */

export type Axis = "timely" | "not-redundant" | "not-generic" | "actionable" | "prioritised" | "correct"

export const AXES: readonly Axis[] = [
	"timely",
	"not-redundant",
	"not-generic",
	"actionable",
	"prioritised",
	"correct"
]

/**
 * `unmeasured` is a first-class outcome and is NEVER counted as a pass.
 *
 * The same rule `timeliness.ts` states for a missing end-state: an axis that could not be checked
 * is excluded from its denominator. Rolling unmeasured into `pass` is how an instrument run on
 * thin data reports a better coach than one run on rich data.
 */
export type AxisVerdict = "pass" | "fail" | "unmeasured"

/* =========================================================== subject and screen */

/**
 * The coarse subject of a line — coarser than a premise, deliberately.
 *
 * The complaint was "six of nine are about farm". Grouped by PREMISE that transcript is four
 * `farm-pace` and four `race`, neither over half, and the monoculture disappears into the bucketing.
 * The player does not hear two subjects there; he hears farm nine times. So the mix is reported at
 * this level, and `PremiseKind` is kept alongside for anyone who wants the finer cut.
 */
export type Topic =
	| "farm"
	| "tempo"
	| "objectives"
	| "economy"
	| "fighting"
	| "levels"
	| "praise"
	| "other"

/**
 * Could he have got this fact by looking at his screen?
 *
 * `hud` means the figure is permanently rendered while he plays: his own CS, gold, level, KDA and
 * HP, the objective respawn timers beside the minimap, the objective icons on the top bar, and the
 * announcement when a drake dies. `unseen` means he would have had to hold TAB and do arithmetic:
 * the enemy jungler's CS, level and finished items, the enemy respawn timers, kill participation.
 *
 * This is the split `AGENTS.md` already draws in prose — *"the lines that pass both tests compare
 * him to something he cannot see"* — written down as a table so it can produce a rate.
 *
 * It is a JUDGEMENT about the League HUD at this patch, not a measurement, and it is the one
 * classification here that a client change could invalidate.
 */
export type Screen = "hud" | "unseen" | "unknown"

export const topicOfPremise: Record<PremiseKind, Topic> = {
	window: "tempo",
	"jungler-down": "tempo",
	"objective-timer": "objectives",
	"objective-lost": "objectives",
	"objective-count": "objectives",
	uncontested: "objectives",
	matchup: "fighting",
	fight: "fighting",
	"kill-share": "fighting",
	"my-death": "fighting",
	gold: "economy",
	build: "economy",
	race: "farm",
	"farm-pace": "farm",
	levels: "levels",
	praise: "praise",
	unknown: "other"
}

export const screenOfPremise: Record<PremiseKind, Screen> = {
	// Multiple enemy respawn timers, added up. Nothing on the HUD carries this.
	window: "unseen",
	// A death timer for one specific enemy, minutes after the kill feed scrolled away.
	"jungler-down": "unseen",
	// League renders Baron and Dragon respawn timers next to the minimap, permanently.
	"objective-timer": "hud",
	// Announced on screen, in the kill feed, and on the top bar's drake icons.
	"objective-lost": "hud",
	"objective-count": "hud",
	/*
	 * HOW LONG IT HAS STOOD IS ON NO CHANNEL HE HAS, and this is the one row in this table that was
	 * settled by looking rather than judged. `data/eval/is-the-timer-visible.md` read 1,876 real
	 * journal frames of nine of his own games: the spawn COUNTDOWN is printed on his minimap from
	 * three minutes out, exact, in 9 of 9 — but once the thing is standing the display prints no
	 * digits at all, in any state, for any objective. The icon says it is there; nothing says since
	 * when.
	 */
	uncontested: "unseen",
	// A `GROUP BY` over the kill feed. The scoreboard shows 0/5/4 and never who the five were.
	matchup: "unseen",
	// The trade's arithmetic, and whether he was even in it — displayed nowhere.
	fight: "unseen",
	"kill-share": "unseen",
	// He is looking at a grey screen with a number on it.
	"my-death": "hud",
	// Current gold is bottom-right, always.
	gold: "hud",
	// The counterpart's finished items need TAB.
	build: "unseen",
	// The counterpart's CS needs TAB. This is the fact AGENTS.md calls the best one available.
	race: "unseen",
	// His own CS is on the HUD; the baseline is his own history, which "at best says he is being
	// unusually himself". Classed `hud` because the half he acts on is the half he can already see.
	"farm-pace": "hud",
	// His own level is on the HUD; the counterpart's is not, and the gap is the point.
	levels: "unseen",
	praise: "hud",
	unknown: "unknown"
}

/**
 * Topic from the spoken sentence alone, for a transcript recorded without its ranked lists.
 *
 * Ordered, and the order is the whole design: an objective line that also says "clear" is about
 * the objective. Coarse by construction — it is a fallback, and every rate built on it is
 * reported as coarse.
 */
const TOPIC_PATTERNS: [Topic, RegExp][] = [
	/*
	 * Praise is tested FIRST and it is the reason this table is ordered rather than scanned.
	 * "You secured the Herald" names an objective and is not an objective note — it is the line the
	 * persona requires after something he actually did, and the actionability axis exempts it. A
	 * table that read the noun would class it as coaching and demand an instruction for a Herald
	 * that is already dead.
	 */
	["praise", /\b(you (secured|stole|just got)|nice (take|steal|catch))\b/i],
	["objectives", /\b(baron|nashor|drake|dragon|herald|grubs?|soul|objectives?|elder)\b/i],
	["tempo", /\b(down \d+ seconds?|respawn|is dead|are dead|of them are dead|window|back up in)\b/i],
	["economy", /\b(gold|unspent|recall|shop|spend|just finished|legendary|item)\b/i],
	["fighting", /\b(fight|trade|teamfight|kill participation|team's kills|you died|got caught)\b/i],
	["levels", /\b(levels? (up|down|behind|ahead)|\blv\d|level \d)\b/i],
	["farm", /\b(cs\b|farm|creep|camps?\b|clear(ing)?\b|pace)\b/i]
]

export const topicOfText = (text: string): Topic => {
	for (const [topic, re] of TOPIC_PATTERNS) if (re.test(text)) return topic
	return "other"
}

/** Names the coach may use for somebody other than the player — roster plus spoken respellings. */
export interface Speakers {
	/** Every champion in this game, as the client spells them. */
	roster?: readonly string[]
	/** The player's own champion, which is NOT somebody else. */
	me?: string
	/** Say-it-like-this respellings from the block, e.g. `Briar` -> `BRY-er`. */
	aliases?: readonly string[]
}

/**
 * Anything only the scoreboard knows, said about somebody other than him.
 *
 * The respellings matter and are not cosmetic: in the transcript that started this the enemy
 * jungler is called `BRY-er` in all four of the lines that are genuinely worth saying. Matching
 * only on `Briar` classes all four as HUD readouts and turns the one good half of that transcript
 * into evidence against itself.
 */
const OTHERS_MARKERS = /\b(of them are dead|seconds of window|is down \d+|team's kills|just finished)\b/i

/** A figure that is rendered on his screen for the whole game. */
const HUD_MARKERS =
	/\b(your (own )?(\d+ )?(cs |farm )?(average|pace|baseline)|you'?re? (roughly )?\d+ cs (up|down) on your own|unspent|they (took|have) |objectives are \d|you just (got|died)|is (back in \d+ seconds|up NOW)|your (level|health|hp|gold|kda))\b/i

export const screenOfText = (text: string, who: Speakers = {}): Screen => {
	const me = (who.me ?? "").toLowerCase()
	const others = [
		...(who.roster ?? []).filter(c => c.toLowerCase() !== me),
		...(who.aliases ?? [])
	].filter(n => n !== "")
	for (const n of others)
		if (new RegExp(`(?<![A-Za-z])${escapeRe(n)}(?![A-Za-z])`, "i").test(text)) return "unseen"
	if (OTHERS_MARKERS.test(text)) return "unseen"
	if (HUD_MARKERS.test(text)) return "hud"
	return "unknown"
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/* ===================================================== axis 4: the vague imperative */

/**
 * Instruction-shaped English that names no physical act.
 *
 * `coach-score.ts` asks a softer question — *does the line name an action at all* — and it is
 * deliberately generous, because under-crediting a soft fault misleads. That generosity is exactly
 * why it passes *"try to pick up the pace"*, which is grammatically an instruction and physically
 * nothing: there is no camp, no lane, no objective and no route in it. Three of the nine lines in
 * the transcript he quit on are this shape, and all three score clean today.
 *
 * The test is the owner's own, from the brief: **can you name the physical action in five words?**
 * "Take your raptors" passes. "Pick up the pace" does not.
 *
 * The list is short and stays short. Each entry is a phrase that has actually been said by this
 * coach or is the direct paraphrase of one, and a phrase is only here if adding a noun to it would
 * make it concrete — which is the evidence that the noun is what is missing.
 */
const LEAD = "(?:(?:try(?:ing)?|remember|make sure|look|aim|focus|want)?\\s*(?:and |to |on )?|just |simply |maybe )?"

export const VAGUE_IMPERATIVES: readonly { label: string; re: RegExp }[] = [
	{ label: "pick up the pace", re: new RegExp(`\\b${LEAD}pick (?:it |up )?(?:it|the pace|up)\\b`, "i") },
	{ label: "keep it moving", re: new RegExp(`\\b${LEAD}keep (?:the |your |this |that )?(?:route |pace |tempo |it )?(?:moving|going|up)\\b`, "i") },
	{ label: "keep building", re: new RegExp(`\\b${LEAD}keep building\\b`, "i") },
	{ label: "keep the lead", re: new RegExp(`\\b${LEAD}keep (?:this|that|your) (?:lead|advantage|pressure)\\b`, "i") },
	{ label: "lock in", re: new RegExp(`\\b${LEAD}lock in\\b`, "i") },
	{ label: "play better", re: new RegExp(`\\b${LEAD}play (?:better|smarter|cleaner|well)\\b`, "i") },
	{ label: "stay focused", re: new RegExp(`\\b${LEAD}stay (?:focused|sharp|on it)\\b`, "i") },
	{ label: "be careful", re: new RegExp(`\\b${LEAD}be (?:careful|safe|smart)\\b(?! (?:near|around|about|in|at))`, "i") },
	{ label: "keep doing that", re: new RegExp(`\\b${LEAD}keep (?:doing|that up|it up)\\b`, "i") },
	{ label: "do better", re: new RegExp(`\\b${LEAD}(?:do|try) better\\b`, "i") }
]

export const vagueImperative = (text: string): string | null => {
	for (const v of VAGUE_IMPERATIVES) if (v.re.test(text)) return v.label
	return null
}

/**
 * The line with its empty instructions cut out.
 *
 * This is how the vague list stays a filter rather than a second scorer: strip the phrase — and
 * the *"try to"* / *"just"* lead-in that carries its verb, which is what made `coach-score.ts`
 * credit "try to pick up the pace" with an action — then ask `coach-score.ts` the same question it
 * always asks. A line that still names something to do keeps its pass, which is the whole point:
 * *"BRY-er is still at 0 CS, so farm your camps to keep building this lead"* names a camp, and the
 * trailing exhortation does not take that away.
 */
export const strippedOfVague = (text: string): string => {
	let out = text
	for (const v of VAGUE_IMPERATIVES) out = out.replace(new RegExp(v.re.source, "gi"), " ")
	return out
}

/* ============================================ axis 3: the near-duplicate arm */

/**
 * Tokens of a line with its game-specific content removed.
 *
 * The mask is `discriminability.ts`'s own, at `digits+names`, so the two arms of axis 3 hide
 * exactly the same things. What is left is the TEMPLATE, and two lines with the same template said
 * four minutes apart are the same line as far as the player is concerned.
 */
export const maskedTokens = (text: string, names: readonly string[]): string[] => {
	const masked = maskLine(normalizeNumbers(text), "digits+names", names)
		.toLowerCase()
		.replace(/[^a-z#« »]/g, " ")
	return [...new Set(masked.split(/\s+/).filter(t => t !== ""))]
}

/** Jaccard overlap of two token sets. 1 is identical, 0 is disjoint. */
export const similarity = (a: readonly string[], b: readonly string[]): number => {
	if (a.length === 0 || b.length === 0) return 0
	const setB = new Set(b)
	let shared = 0
	for (const t of a) if (setB.has(t)) shared += 1
	return shared / (new Set([...a, ...b]).size)
}

/**
 * How much template overlap makes two lines the same line.
 *
 * A JUDGEMENT, exposed as an option. Half the vocabulary shared after the numbers and names are
 * gone is where "he said that already" starts, and it is above the level at which two sentences
 * merely share English function words. Calibrated on the transcript below: it pairs
 * *"try to pick up the pace, your # farm is not pacing to match your average of #"* with
 * *"try to pick it up, your # farm is not pacing to match your # CS average"*, which are the same
 * sentence, and leaves apart the two race lines, which are not.
 */
export const NEAR_DUPLICATE_SIM = 0.5

/* ================================================= axis 5: which fact was taken */

/**
 * Which of the ranked facts the coach actually spoke, or -1 for none of them.
 *
 * The ranker hands the model an ordered list and the prompt allows only that list, so the rank
 * taken IS the priority decision, recoverable without a judge. Matching is on masked token overlap
 * because the model rephrases: the fact reads *"you're 30 CS up on Briar"* and the line reads
 * *"You are 30 CS up on BRY-er, so keep the route moving."*
 *
 * This measures AGREEMENT WITH THE RANKER and nothing more. Whether the ranker itself picked the
 * thing that mattered is a different question with a different instrument (a hindsight/regret
 * probe over the whole game), and conflating the two would let a coach that faithfully speaks a
 * badly ordered list score full marks on this axis. It scores full marks on this axis. That is
 * correct, and the report says so.
 */
/**
 * How much of the ranked fact has to survive into the spoken line for it to be that fact.
 *
 * CONTAINMENT, not overlap, and the difference decides whether this axis works at all. The ranker
 * writes *"Briar is down 34 seconds"* and the coach says *"Briar is down for thirty four seconds,
 * so this is your window to walk into her red buff, take it, and get back out before she
 * respawns."* Symmetric Jaccard scores that pair at 0.2 — below any threshold that is not also
 * matching unrelated sentences — because the model's own clause dominates the union. Asking
 * instead what fraction of the FACT is present scores it 1.0, and a line about something else
 * still scores near zero.
 */
export const MATCH_CONTAINMENT = 0.6

/** Fraction of `fact`'s tokens that appear in `spoken`. Asymmetric on purpose. */
export const containment = (fact: readonly string[], spoken: readonly string[]): number => {
	if (fact.length === 0) return 0
	const said = new Set(spoken)
	let shared = 0
	for (const t of fact) if (said.has(t)) shared += 1
	return shared / fact.length
}

/**
 * The fact without its champion clause.
 *
 * `withAdvice` in `live-facts.ts` appends the champion note after an em dash, and the model drops
 * it far more often than it keeps it. Measured on a real Gemini run: the ranker offered *"you're 2
 * levels down on Briar — declining that is correct play rather than timidity, take your own camps
 * and be full for the objective"* and the coach said *"You're 2 levels down on Briar — focus on
 * clearing your camps when you respawn."* Containment against the whole fact is 0.5 and the line
 * was scored as speaking off-list; against the lead clause it is 1.0. `premiseOf` already parses
 * these anchored at the start for the same reason.
 */
export const leadClause = (fact: string): string => fact.split(/\s—\s/)[0]!

export const rankTakenOf = (
	spoken: string,
	offered: readonly string[],
	names: readonly string[] = [],
	minContainment = MATCH_CONTAINMENT
): number => {
	const s = maskedTokens(spoken, names)
	let best = -1
	let bestScore = minContainment
	let bestTie = -1
	offered.forEach((fact, i) => {
		const f = maskedTokens(fact, names)
		const lead = maskedTokens(leadClause(fact), names)
		const score = Math.max(containment(f, s), containment(lead, s))
		const tie = Math.max(similarity(f, s), similarity(lead, s))
		if (score > bestScore || (score === bestScore && best >= 0 && tie > bestTie)) {
			bestScore = score
			bestTie = tie
			best = i
		}
	})
	return best
}

/* ====================================================================== input */

/** One line the coach spoke, with everything known about the moment it spoke it. */
export interface UsefulInput {
	text: string
	/** Game clock of the state the line was built from. */
	atSec: number
	/** Seconds from that state being read to the first syllable. Socket ~1s, turn-based several. */
	latencySec: number
	/** Real audio length when the transcript carries one; otherwise the measured fit is used. */
	spokenSec?: number
	/** The ranked list the coach was offered — `VisionState.unseen`. Enables axis 5. */
	offered?: readonly string[]
	/** The ground-truth block, exactly as `renderState` produced it. Enables axis 6. */
	block?: string
	roster?: readonly string[]
	/** HIS champion. Naming it is not naming somebody else, so it is not a scoreboard fact. */
	me?: string
	/** Every champion that exists, for the invented-name rule. */
	champions?: readonly string[]
	/** Spoken respellings in force for this game, e.g. `BRY-er`. */
	aliases?: readonly string[]
	/** The state that produced the line, and the real state nearest its last syllable. */
	stateAtT?: CoachState | null
	stateAtEnd?: CoachState | null
	/**
	 * The forced-choice judge's verdict for this line, from `discriminability.ts`.
	 *
	 * `true` = a judge picked the state this line was said about out of k options; `false` = it
	 * could not. Absent means the judge was not run, which is unmeasured, not a pass.
	 */
	identified?: boolean
}

/* ===================================================================== output */

export interface LineVerdict {
	text: string
	atSec: number
	clock: string
	axes: Record<Axis, AxisVerdict>
	/** One short sentence per axis, with the numbers in it. Written to be pasted into a report. */
	notes: Partial<Record<Axis, string>>
	/** Axes actually checked, and how many of those passed. */
	measured: number
	passed: number
	/** `passed / measured`, or null when nothing could be checked. */
	score: number | null
	premise: PremiseKind
	topic: Topic
	screen: Screen
	/** True when premise/topic/screen came from the ranked fact rather than the sentence. */
	fromOffer: boolean
	rankTaken: number | null
	vague: string | null
	faults: CoachFault[]
	staleness: Staleness | null
	spokenSec: number
	/** Nearest other line in the same transcript, by template overlap. */
	nearest: { atSec: number; sim: number; text: string } | null
}

export const clockOf = (sec: number): string =>
	`${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`

/* ============================================================== the line scorer */

export interface ScoreOptions extends StalenessOptions {
	nearDuplicateSim?: number
}

/**
 * Score one line on all six axes. Pure.
 *
 * `nearest` is supplied by the transcript scorer, because "could this have come from a different
 * game" cannot be answered by a line on its own.
 */
export const scoreUsefulLine = (
	input: UsefulInput,
	nearest: { atSec: number; sim: number; text: string } | null = null,
	opts: ScoreOptions = {}
): LineVerdict => {
	const names = [...(input.roster ?? []), ...(input.aliases ?? [])]
	const spokenSec = input.spokenSec ?? speechDurationSec(input.text)

	/* -- which ranked fact was this, if any ---------------------------------- */
	const rankTaken =
		input.offered === undefined ? null : rankTakenOf(input.text, input.offered, names)
	const offer =
		input.offered !== undefined && rankTaken !== null && rankTaken >= 0 ?
			input.offered[rankTaken]!
		:	null
	const premise = offer !== null ? premiseOf(offer).kind : premiseOf(input.text).kind
	const fromOffer = offer !== null
	const topic =
		premise === "unknown" ? topicOfText(input.text) : topicOfPremise[premise]
	const screenFromPremise = premise === "unknown" ? "unknown" : screenOfPremise[premise]
	const screen =
		screenFromPremise === "unknown" ?
			screenOfText(input.text, { roster: input.roster, me: input.me, aliases: input.aliases })
		:	screenFromPremise

	const axes: Record<Axis, AxisVerdict> = {
		timely: "unmeasured",
		"not-redundant": "unmeasured",
		"not-generic": "unmeasured",
		actionable: "unmeasured",
		prioritised: "unmeasured",
		correct: "unmeasured"
	}
	const notes: Partial<Record<Axis, string>> = {}

	/* -- 1. timely ----------------------------------------------------------- */
	/*
	 * The premise is checked on the RANKER's sentence when one matched, because that is the text
	 * `premiseOf` was built to parse — but the clock is the real one: `spokenSec` is how long what
	 * he actually heard took to say. Using the ranker's own wording for the duration would measure
	 * a sentence nobody spoke.
	 */
	let staleness: Staleness | null = null
	if (input.stateAtT) {
		const probe = { text: offer ?? input.text, atSec: input.atSec, latencySec: input.latencySec, spokenSec }
		staleness = stalenessOf(probe, input.stateAtT, input.stateAtEnd ?? null, opts)
		if (staleness.kind === "unknown") {
			notes.timely = staleness.why
		} else {
			axes.timely = staleness.stale ? "fail" : "pass"
			notes.timely = `${staleness.kind}: ${staleness.why} (last syllable at ${clockOf(staleness.endSec)}, ${spokenSec.toFixed(1)}s of speech)`
		}
	}

	/* -- 2. not redundant ----------------------------------------------------- */
	if (screen !== "unknown") {
		axes["not-redundant"] = screen === "hud" ? "fail" : "pass"
		notes["not-redundant"] =
			screen === "hud" ?
				`${premise === "unknown" ? topic : premise} is rendered on his HUD all game`
			:	`${premise === "unknown" ? topic : premise} needs the scoreboard, not the screen`
	}

	/* -- 3. not generic -------------------------------------------------------- */
	const dupSim = opts.nearDuplicateSim ?? NEAR_DUPLICATE_SIM
	const isDup = nearest !== null && nearest.sim >= dupSim
	if (nearest !== null || input.identified !== undefined) {
		const judgedGeneric = input.identified === false
		axes["not-generic"] = isDup || judgedGeneric ? "fail" : "pass"
		const bits: string[] = []
		if (isDup)
			bits.push(
				`same template as ${clockOf(nearest!.atSec)} (${(100 * nearest!.sim).toFixed(0)}% overlap): "${nearest!.text}"`
			)
		if (judgedGeneric) bits.push("a judge could not tell which moment it was said about")
		if (bits.length === 0)
			bits.push(
				nearest === null ?
					"no other line to compare"
				:	`nearest template is ${(100 * nearest.sim).toFixed(0)}% overlap`
			)
		notes["not-generic"] = bits.join("; ")
	}

	/* -- 4 and 6. the delegated scorer ------------------------------------------ */
	const scored = scoreLine({
		line: input.text,
		block: input.block ?? "",
		roster: input.roster ?? [],
		champions: input.champions ?? input.roster ?? []
	})
	const vague = vagueImperative(input.text)
	if (!scored.silent) {
		/*
		 * Asked of the line with its empty instructions removed, so an exhortation cannot stand in
		 * for an act — and so an act is not lost because an exhortation was bolted on after it.
		 */
		const noAction =
			vague === null ? scored.faults.includes("no-alternative")
			:	scoreLine({
					line: strippedOfVague(input.text),
					block: input.block ?? "",
					roster: input.roster ?? [],
					champions: input.champions ?? input.roster ?? []
				}).faults.includes("no-alternative")
		/*
		 * Praise is exempt, and it has to be checked from the PREMISE rather than the prose.
		 * `coach-score`'s own praise exemption requires a past-tense achievement phrase and misses
		 * "Great job on that clear, you are 20 CS up on BRY-er" on the difference between "you are"
		 * and "you're" — a line that is warm, correct and rightly names nothing to do.
		 */
		if (premise === "praise" || topic === "praise") {
			axes.actionable = "unmeasured"
			notes.actionable = "praise — exempt from naming an action"
		} else {
			axes.actionable = noAction ? "fail" : "pass"
			notes.actionable =
				!noAction ? `names an action${vague === null ? "" : ` despite the "${vague}"`}`
				: vague !== null ? `"${vague}" is the only instruction in it, and it names no physical act`
				: "names nothing to do"
		}

		const fabrications = scored.faults.filter(f => FABRICATION_FAULTS.includes(f))
		if (input.block !== undefined && input.block !== "") {
			axes.correct = fabrications.length === 0 ? "pass" : "fail"
			notes.correct =
				fabrications.length === 0 ?
					"every figure is in the block"
				:	`${fabrications.join(", ")}${scored.unbackedNumbers.length > 0 ? ` (${scored.unbackedNumbers.join(", ")})` : ""}`
		} else notes.correct = "no block supplied — nothing to check the figures against"
	}

	/* -- 5. prioritised ---------------------------------------------------------- */
	if (rankTaken !== null) {
		axes.prioritised = rankTaken === 0 ? "pass" : "fail"
		notes.prioritised =
			rankTaken === 0 ? "spoke the ranker's top fact"
			: rankTaken > 0 ? `spoke rank ${rankTaken + 1} of ${input.offered!.length}, passing over "${input.offered![0]}"`
			: input.offered!.length === 0 ? "the ranked list was EMPTY and it spoke anyway"
			: `matched none of the ${input.offered!.length} ranked facts`
	}

	const measured = AXES.filter(a => axes[a] !== "unmeasured").length
	const passed = AXES.filter(a => axes[a] === "pass").length

	return {
		text: input.text,
		atSec: input.atSec,
		clock: clockOf(input.atSec),
		axes,
		notes,
		measured,
		passed,
		score: measured === 0 ? null : passed / measured,
		premise,
		topic,
		screen,
		fromOffer,
		rankTaken,
		vague,
		faults: scored.faults,
		staleness,
		spokenSec,
		nearest
	}
}

/* ========================================================== the transcript view */

export interface Rate {
	label: string
	interval: Interval
	/** What a failure on this rate means, one clause, for the report. */
	meaning: string
}

export const rate = (label: string, k: number, n: number, meaning: string): Rate => ({
	label,
	interval: wilson(k, n),
	meaning
})

export interface TopicShare {
	topic: Topic
	n: number
	share: number
}

/**
 * The thresholds that turn rates into a verdict.
 *
 * Every one is a JUDGEMENT with its evidence written beside it, and every one is an option, so a
 * report can show the sensitivity instead of hiding it behind a green tick.
 */
export interface Thresholds {
	/**
	 * Lines per minute above which the coach is talking too much.
	 *
	 * `AGENTS.md` records the shipped design point: the three readout gates moved the coach from a
	 * line every 62 seconds to one every 150, i.e. 0.40/min. Twice that — one line every 75
	 * seconds — is the point at which the gates have effectively been undone. The transcript he
	 * quit on ran at 2.25/min, five and a half times the design point.
	 */
	chattyPerMin: number
	/**
	 * Share of one topic above which the coach has a monoculture.
	 *
	 * Half. Below half no single subject dominates a four-minute stretch; above it he is hearing
	 * one thing. The quit transcript is 8 of 9 on farm, which is 0.89.
	 */
	monocultureShare: number
	/** Below this many lines, a topic mix is noise and is not judged. */
	monocultureMinLines: number
	/** Share of lines whose fact is already on his HUD. */
	hudShare: number
	/** Share of lines that name no physical act. */
	noActionShare: number
	/** Share of lines whose premise no longer held when the sentence finished. */
	staleShare: number
	nearDuplicateSim: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
	chattyPerMin: 0.8,
	monocultureShare: 0.5,
	monocultureMinLines: 5,
	hudShare: 0.5,
	noActionShare: 0.5,
	staleShare: 0.33,
	nearDuplicateSim: NEAR_DUPLICATE_SIM
}

export interface TranscriptVerdict {
	lines: LineVerdict[]
	/** Silences are counted and excluded from every rate — `coach-score.ts`'s rule, kept. */
	spoken: number
	spanSec: number
	linesPerMin: number
	topics: TopicShare[]
	/** Per-axis pass rates with Wilson intervals, over the lines where that axis was measured. */
	rates: Record<Axis, Rate>
	hud: Rate
	nearDuplicate: Rate
	vague: Rate
	/** The indictment: every threshold that was crossed, in a sentence with its number. */
	problems: string[]
	verdict: "useful" | "poor"
	thresholds: Thresholds
}

/**
 * Score a whole transcript.
 *
 * The transcript level is not a summary of the line level, it is a separate measurement. Five of
 * the nine lines in the quit transcript pass every per-line check that existed before this file,
 * and the transcript is still what made him turn the coach off: nine lines in four minutes, eight
 * of them about farm, two of them the same sentence.
 */
export const scoreTranscript = (
	inputs: readonly UsefulInput[],
	opts: ScoreOptions & { thresholds?: Partial<Thresholds> } = {}
): TranscriptVerdict => {
	const th = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) }
	const dupSim = opts.nearDuplicateSim ?? th.nearDuplicateSim

	/*
	 * A PASS is a considered silence and must not be scored as a line. `scoreLine` already draws
	 * that distinction; it is applied here so silences never enter a denominator.
	 */
	const said = inputs.filter(i => {
		const bare = i.text.replace(/[^A-Za-z]/g, "").toLowerCase()
		return bare !== "" && bare !== "pass"
	})

	const names = [
		...new Set(said.flatMap(i => [...(i.roster ?? []), ...(i.aliases ?? [])]))
	]
	const tokens = said.map(i => maskedTokens(i.text, names))

	const lines = said.map((input, i) => {
		let nearest: { atSec: number; sim: number; text: string } | null = null
		for (let j = 0; j < said.length; j++) {
			if (j === i) continue
			const sim = similarity(tokens[i]!, tokens[j]!)
			if (nearest === null || sim > nearest.sim)
				nearest = { atSec: said[j]!.atSec, sim, text: said[j]!.text }
		}
		return scoreUsefulLine(input, nearest, { ...opts, nearDuplicateSim: dupSim })
	})

	const secs = said.map(i => i.atSec)
	const spanSec = secs.length === 0 ? 0 : Math.max(...secs) - Math.min(...secs)
	/*
	 * The span is measured first-line to last-line, so one line is 0 seconds and has no rate. A
	 * denominator of "the whole game" would flatter a coach that said nine things in one minute
	 * and nothing for thirty.
	 */
	const linesPerMin = spanSec <= 0 ? 0 : (lines.length / spanSec) * 60

	const byTopic = new Map<Topic, number>()
	for (const l of lines) byTopic.set(l.topic, (byTopic.get(l.topic) ?? 0) + 1)
	const topics: TopicShare[] = [...byTopic.entries()]
		.map(([topic, n]) => ({ topic, n, share: n / lines.length }))
		.sort((a, b) => b.n - a.n)

	const axisRate = (a: Axis, meaning: string): Rate => {
		const measured = lines.filter(l => l.axes[a] !== "unmeasured")
		return rate(a, measured.filter(l => l.axes[a] === "pass").length, measured.length, meaning)
	}
	const rates: Record<Axis, Rate> = {
		timely: axisRate("timely", "the premise still held when the last syllable landed"),
		"not-redundant": axisRate("not-redundant", "he could not have read it off his own screen"),
		"not-generic": axisRate("not-generic", "not a template he had already heard"),
		actionable: axisRate("actionable", "names a physical act, not an exhortation"),
		prioritised: axisRate("prioritised", "spoke the ranker's top fact rather than a lower one"),
		correct: axisRate("correct", "every figure is backed by the block")
	}

	const screened = lines.filter(l => l.screen !== "unknown")
	const hud = rate(
		"on his HUD",
		screened.filter(l => l.screen === "hud").length,
		screened.length,
		"the fact was already rendered on his screen"
	)
	const nearDuplicate = rate(
		"near-duplicate",
		lines.filter(l => l.nearest !== null && l.nearest.sim >= dupSim).length,
		lines.length,
		"the same template as another line in this run"
	)
	const vague = rate(
		"vague imperative",
		lines.filter(l => l.vague !== null).length,
		lines.length,
		"instruction-shaped with no physical act in it"
	)

	/* -- the indictment ------------------------------------------------------- */
	const problems: string[] = []
	if (linesPerMin > th.chattyPerMin && lines.length >= 3)
		problems.push(
			`CHATTY: ${lines.length} lines in ${(spanSec / 60).toFixed(1)} minutes is ${linesPerMin.toFixed(2)}/min, against a shipped design point of 0.40/min`
		)
	const top = topics[0]
	if (top && lines.length >= th.monocultureMinLines && top.share > th.monocultureShare)
		problems.push(
			`MONOCULTURE: ${top.n} of ${lines.length} lines are about ${top.topic} (${(100 * top.share).toFixed(0)}%)`
		)
	if (hud.interval.n > 0 && hud.interval.p > th.hudShare)
		problems.push(
			`REDUNDANT: ${hud.interval.k} of ${hud.interval.n} lines state something already on his HUD (${(100 * hud.interval.p).toFixed(0)}%)`
		)
	const act = rates.actionable.interval
	if (act.n > 0 && 1 - act.p > th.noActionShare)
		problems.push(
			`NOT ACTIONABLE: ${act.n - act.k} of ${act.n} lines name no physical act (${(100 * (1 - act.p)).toFixed(0)}%)`
		)
	const timely = rates.timely.interval
	if (timely.n > 0 && 1 - timely.p > th.staleShare)
		problems.push(
			`LATE: ${timely.n - timely.k} of ${timely.n} lines had stopped being true by the last syllable (${(100 * (1 - timely.p)).toFixed(0)}%)`
		)
	if (nearDuplicate.interval.k > 0)
		problems.push(
			`REPEATED: ${nearDuplicate.interval.k} of ${lines.length} lines reuse a template already spoken in this run`
		)
	const correct = rates.correct.interval
	if (correct.n > 0 && correct.k < correct.n)
		problems.push(`FABRICATED: ${correct.n - correct.k} of ${correct.n} lines carry a figure the block does not`)

	return {
		lines,
		spoken: lines.length,
		spanSec,
		linesPerMin,
		topics,
		rates,
		hud,
		nearDuplicate,
		vague,
		problems,
		verdict: problems.length === 0 ? "useful" : "poor",
		thresholds: th
	}
}

/* ================================================================== ordering */

/**
 * Worst first: fewest axes passed, then most axes failed, then latest — so a tie is broken toward
 * the line he heard most recently, which is the one he remembers.
 *
 * A line with NOTHING measured sorts last rather than first. An instrument that leads its report
 * with the lines it could not check would spend the reader's attention on its own blind spots.
 */
export const worstFirst = (lines: readonly LineVerdict[]): LineVerdict[] =>
	[...lines].sort((a, b) => {
		// Both unmeasured is a tie, not a contradiction — a comparator that says a<b and b<a for the
		// same pair sorts differently depending on the engine's algorithm.
		if (a.measured === 0 && b.measured === 0) return 0
		if (a.measured === 0 || b.measured === 0) return a.measured === 0 ? 1 : -1
		const fa = a.measured - a.passed
		const fb = b.measured - b.passed
		if ((a.score ?? 1) !== (b.score ?? 1)) return (a.score ?? 1) - (b.score ?? 1)
		if (fa !== fb) return fb - fa
		return b.atSec - a.atSec
	})

export const bestFirst = (lines: readonly LineVerdict[]): LineVerdict[] =>
	worstFirst(lines).reverse().filter(l => l.measured > 0)

/* ============================================================== run comparison */

export interface Comparison {
	axis: Axis
	a: Interval
	b: Interval
	separated: boolean
	verdict: string
}

/**
 * Two runs, axis by axis, with the honest answer when they are not distinguishable.
 *
 * Non-overlapping Wilson intervals is the conservative test `coach-score.ts` already uses, and the
 * wording is deliberate: "not distinguishable at n=9 and n=11" is what a reader needs to hear, not
 * a percentage difference that sounds like a result.
 */
export const compareRuns = (a: TranscriptVerdict, b: TranscriptVerdict): Comparison[] =>
	AXES.map(axis => {
		const ia = a.rates[axis].interval
		const ib = b.rates[axis].interval
		const sep = ia.n > 0 && ib.n > 0 && separated(ia, ib)
		return {
			axis,
			a: ia,
			b: ib,
			separated: sep,
			verdict:
				ia.n === 0 || ib.n === 0 ? `not measured in ${ia.n === 0 ? "A" : "B"}`
				: sep ? `${ia.p > ib.p ? "A" : "B"} is better, and the intervals do not overlap`
				: `NOT DISTINGUISHABLE at n=${ia.n} and n=${ib.n}`
		}
	})

export { endOfSec, speechDurationSec }
