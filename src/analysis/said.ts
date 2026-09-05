/**
 * What the coach has already said out loud this game — the only thing it has never been able to see.
 *
 * ## The failure this exists for
 *
 * Two models, the same 42 states of game 5635467422, the same frames, the same block
 * (`data/eval/model-opus5.json`, `data/eval/model-36flash.json`). Gemini 3.6 Flash was judged 83%
 * useful and Opus 5 53%, both at 0% fabrication — and 18 of Gemini's 35 lines and 17 of Opus's 38
 * restate at least half the content words of an earlier line. Opus said some rewording of *your
 * clear only gets faster while it keeps running* in NINETEEN of its 38 lines, in a row, changing
 * the verb each time. Counted by hand rather than lexically, 29 of its 38 lines were things he had
 * already been told.
 *
 * No instrument in this repo could see it, and the reason is structural: `analysis/coach-score.ts`
 * scores a line for fabrication against the block it was holding, and the blind judge scores a line
 * for usefulness against the same. **Both score one line, alone.** A sentence that is true,
 * grounded and actionable scores full marks on its tenth telling. So the model is not the problem
 * and neither is the prompt — the coach has no memory of its own speech, and a rule in a prompt is
 * a request.
 *
 * This module is both halves of the answer: the transcript the model is SHOWN (`renderSaid`, fed
 * into the block through `VisionState.said`), and the refusal that does not depend on it obeying
 * (`judgeSaid`).
 *
 * ## What counts as a repeat, and how the rule was chosen
 *
 * Verbatim matching is useless here: every one of those nineteen lines is worded differently. Three
 * candidate signals were measured against the two real transcripts above and against the 15
 * hand-written good lines of game 5635467422 in `data/eval/target-lines.md`, which is the set a
 * gate must NOT kill.
 *
 *   1. **Wording** — content-word containment against anything said in the last four minutes. This
 *      is the signal `analysis/insight.ts` scores with offline, at 0.5. It catches paraphrase and
 *      nothing else: on Opus it flags 17 of the 29 real repeats.
 *   2. **The directive, as an INTENT rather than as words.** The decisive one. Those nineteen
 *      "keep clearing" lines carry fourteen distinct head phrasings — "keep route rolling", "start
 *      route don't", "take every camp", "full clear start", "grab leash commit" — so a key built
 *      from words counts fourteen instructions where he heard one. `DIRECTIVE_INTENTS` collapses
 *      them, and that single change took the leak from 3 repeated lines to 0 on Opus.
 *   3. **The subject of the premise**, on a rolling budget. `SaidSubject` is `FactSubject` from
 *      `live-facts.ts` deliberately: the ranker already decided that his own farm and the race
 *      against the enemy jungler are ONE subject with one budget, and that is exactly the
 *      collapse this needs — 30 of Opus's 38 lines are that one subject.
 *
 * Measured, at the constants in `SAID_LIMITS`:
 *
 *     corpus                       spoke   survive   labelled-new kept   repeats leaked
 *     model-opus5   (with frames)     38         7           5 of 6            2 of 27
 *     model-36flash (with frames)     35         9           5 of 5            3 of 25
 *     target-lines.md M02..M24        15        15              n/a                n/a
 *
 * The one labelled-new line the gate kills is *"Race is dead even at least-ten CS each, so just
 * keep the route running"* at 1:06 — and the block itself forbids that claim ("the two of you are
 * inside the client's rounding of each other, so nobody can say who is ahead — do not"), so the
 * kill is right and the label was wrong. The leaked repeats are all of the form "same instruction,
 * ninety-eight seconds later, forty percent shared wording": the gate is not a paraphrase detector
 * and does not pretend to be.
 *
 * ## Showing it the transcript, measured live
 *
 * The gate alone is a refusal, and a refusal turns a repeat into silence. Whether SHOWING the coach
 * its transcript turns a repeat into a different line instead is a question about the model, so it
 * was asked of the model. Gemini 3.6 Flash, the same 42 states of split-03, the same frames, the
 * same system prompt lifted verbatim out of the ablation, temperature 0, run in order twice
 * (`data/eval/said-transcript-ab-20260905.json`, re-runnable with `data/eval/said-transcript-ab.ts`):
 *
 *     arm                      spoke   PASS   gate dropped   he HEARD   subjects   instructions
 *     gate only                   35      7             28          7          4              5
 *     transcript + gate           20     22              7         13          6              8
 *
 * Shown what it had already said, the coach volunteered a line on twenty turns instead of
 * thirty-five — and because those twenty were not the same line, thirteen of them survived the
 * gate against seven. **Adding the memory nearly doubled what he actually hears while nearly
 * halving what the coach tries to say.** The variety moved with it: `gate only` produced five
 * distinct instructions, all of them buy / clear / recall; `transcript + gate` produced eight,
 * reaching ganking, counter-jungling and objectives, and its lines include "path top to gank for
 * Urgot", "push this open mid wave while Lissandra is down" and "start the dragon now" — none of
 * which the coach reached at all when it could not see itself repeating.
 *
 * The honest limits of that: ONE run of ONE model, and the thirteen lines were not judged blind for
 * usefulness or scored for fabrication, so this measures volume and variety and not quality. It is
 * evidence that the transcript changes what the model chooses, not yet that it chooses better.
 *
 * ## THE HONEST COST, because there is one and it is the whole argument
 *
 * **This gate makes the coach quieter, and quiet was already the complaint.** It cuts Opus's seven
 * minutes from 38 lines to 7 and Gemini's from 35 to 9 — 82% and 74% of everything they said. The
 * repo has measured what that end of the dial feels like: the fenced coach spoke 12 times in a
 * whole game, the first at 8:37, and the owner's word for it was that the coach was ABSENT.
 *
 * So of the two failures — *she never shuts up* and *she is not there* — a no-repeat gate ALONE
 * worsens the second, and the A/B above is the reason "alone" is doing work in that sentence: with
 * the transcript in front of it the same model delivered thirteen lines where the bare gate
 * delivered seven, so the pair is not merely quieter than the ungated coach, it is louder than the
 * gate by itself. It still is not a fix on its own. Two things stop it being a mute button, and
 * both are outside this file:
 *
 *   - **the briefing** (`H-series`, `H-event`, `F-schedule`, `X-game` in `target-lines.md`), which
 *     gives the coach facts that are not a value in the current snapshot and therefore are not the
 *     same fact every turn. The 15 hand-written targets all survive this gate precisely because
 *     each one is about something new;
 *   - **`SaidContext.news`**, the door for a caller that can see the world change. Silence has to
 *     be comfortable, but a coach that cannot interrupt itself when the drake it just told him to
 *     take has been taken is worse than one that repeats.
 *
 * Stated the other way round: 7 lines in the 6.7 minutes measured is 1.04 a minute against the
 * fenced coach's 0.28 and the ungated 5.7, and 13 with the transcript is 1.94. This is not the
 * fence. It is the same coach with the duplicates removed, and what it does next depends entirely
 * on being given something new to say.
 *
 * ## Where the gate can actually be enforced
 *
 * Only where the sentence exists as TEXT before it is spoken — the turn-based providers, where
 * `coachTurn` returns a string and the browser speaks it. On the Gemini Live socket the audio is
 * already playing by the time `outputTranscription` arrives (`web/lib/geminiLive.ts`), so there the
 * only lever is `renderSaid` in the next turn's block, and `judgeSaid` is an instrument rather than
 * a refusal. That asymmetry is real and is not papered over: the socket gets the request, the turn
 * path gets the refusal, and both feed the same memory.
 */

import { fmtClock } from "../shared/time.ts"
import { normalizeNumbers } from "./coach-score.ts"
import type { FactSubject } from "./live-facts.ts"

/**
 * WHAT A LINE IS ABOUT, in the ranker's own vocabulary.
 *
 * `FactSubject` rather than a fresh partition, and that is the load-bearing choice. `live-facts.ts`
 * already decided that his own farm, the race against the enemy jungler and the comeback line are
 * ONE subject with one budget — "three generators, one subject" — and that decision is exactly what
 * this needs: 30 of the 38 lines Opus 5 spoke are that single subject wearing different numbers. A
 * separate vocabulary here would have counted them as two topics and let the coach alternate
 * between them forever. It also means a subject this module records as spent names the same thing
 * the ranker would have offered next.
 *
 * `other` is the one addition, and it is a bucket rather than a subject — see `judgeSaid`, which
 * gives it no budget for that reason.
 */
export type SaidSubject = FactSubject | "other"

/**
 * First match wins, so this is a partition and the order is the specificity order.
 *
 * Two of these regexes are narrower than they look, each because a wider one was measured doing
 * damage. `downed` no longer matches a bare "is dead": it read *"Race is dead even"* as a respawn
 * timer, which handed a pure repetition the once-per-game novelty exemption below. `build` no
 * longer matches "item": *"buy your jungle item"* is the first-back instruction, not a completed
 * build, and it took the same exemption.
 */
export const SAID_SUBJECTS: { id: SaidSubject; re: RegExp }[] = [
	{ id: "your-death", re: /\b(you (?:are |'re )?dead|you die|respawn in|you spawn|back up in)\b/i },
	{ id: "downed", re: /\b(is down|are down|down for|dead for|respawn)\b/i },
	{ id: "objective-lost", re: /\b(they|enemy|he|she) (?:just )?took\b|\b(?:drake|dragon|baron|nashor|herald|grubs?|tower|turret)\b(?:'s)?\s+(?:is |are |has )?(?:gone|taken|down|dead)\b|\blost (?:the |a )?(?:drake|dragon|baron|herald|grubs?|tower)\b/i },
	{ id: "objectives", re: /\b(drake|dragon|baron|nashor|herald|grub|scuttle|tower|turret|inhibitor|plate|pit)\b/i },
	{ id: "fight", re: /\b(fight|trade|skirmish|teamfight|duel|collapse|dive|kill(?:ed|ing|s)?|first blood|die[ds]?)\b/i },
	{ id: "gold", re: /\bgold\b|\b(recall|back and buy|shop|spend)\b/i },
	{ id: "farm", re: /\b(cs|farm|camps?|clear|route|gromp|wolves|raptors|krugs|buff|jungle)\b/i },
	{ id: "levels", re: /\blevel\b/i },
	{ id: "build", re: /\b(legendary|completed|bought|component|mythic|finished (?:his|her|their))\b/i },
	{ id: "kill-share", re: /\b(participation|kill share|involved in)\b/i },
	{ id: "praise", re: /\b(nice|great|lovely|beautiful|well done|love (?:it|that)|proud|there we go)\b/i }
]

/** Words that carry no subject, so two lines sharing them are not sharing anything. */
const STOPWORDS = new Set(
	`a an and are as at be been before but by can cant cannot could did do does doing dont for from
	 get go got had has have he her here him his how i if in into is it its just like me more most
	 my no not now of off on once only or other our out over own re s so some still such t than
	 that the their them then there these they this those through to too up us very was we were
	 what when where which while who why will with would you your youre yours youve ll ve m d`
		.split(/\s+/)
		.filter(Boolean)
)

/**
 * One spelling per figure and one dash, so "eleven" and "11" are the same word.
 *
 * `normalizeNumbers` is borrowed from `coach-score.ts` rather than rewritten because the models
 * genuinely mix the two in one transcript: Opus said "at least 11 CS behind" at 3:57 and "at least
 * eleven CS behind" at 4:03, and a comparison that treats those as different words would have
 * scored the second as a new line.
 */
const clean = (line: string): string =>
	normalizeNumbers(line).toLowerCase().replace(/[’']/g, "'").replace(/[—–]/g, " — ")

const words = (text: string): string[] => text.split(/[^a-z0-9']+/).filter(Boolean)

export const contentWords = (line: string): string[] => [
	...new Set(words(clean(line)).filter(w => !STOPWORDS.has(w.replace(/'s$/, "")) && !/^\d+$/.test(w)))
]

/*
 * Where the CLAIM stops and the INSTRUCTION starts.
 *
 * Every line this coach produces is the same two-part shape the rest of the repo uses — the number
 * and the fix — joined by a dash, a comma or "so". Splitting there is what lets the two halves be
 * remembered separately, which matters because they go stale at different rates: the enemy
 * jungler's CS changes every minute and "keep clearing" does not change all game.
 */
const CLAUSE_BREAK = /\s+—\s+|\s*[,;:.]\s+|\s+so\s+|\s+then\s+|\s+but\s+|\s+while\s+/

const IMPERATIVES = `take start keep go get walk push back recall buy spend clear finish full stop
	don't dont never hold ward path route rotate contest give leave stay come move run drop hit
	smite steal cross farm reset use pick head grab commit answer avenge`
	.split(/\s+/)
	.filter(Boolean)

const LEADING_FILLER = ["so", "then", "and", "but", "or", "instead", "now", "just", "please", "maybe"]

/**
 * The clause he is meant to ACT on: the FIRST that opens on an instruction.
 *
 * First rather than last, because these lines routinely stack two ("recall, buy, and restart the
 * route") and the first is the decision — the rest is elaboration on it.
 */
export const actionClause = (line: string): string | null => {
	for (const c of clean(line).split(CLAUSE_BREAK)) {
		const ws = words(c).filter((w, i) => !(i === 0 && LEADING_FILLER.includes(w)))
		if (ws.length === 0) continue
		for (const head of ws.slice(0, 2)) if (IMPERATIVES.includes(head)) return c.trim()
	}
	return null
}

/** The clause that carries the CLAIM: everything before the action, or the whole line. */
export const premiseClause = (line: string): string => {
	const t = clean(line)
	const action = actionClause(line)
	if (action === null) return t
	const i = t.indexOf(action)
	const head = i > 0 ? t.slice(0, i).trim() : ""
	return head.length > 0 ? head : t
}

export const subjectOfSaid = (text: string): SaidSubject =>
	SAID_SUBJECTS.find(s => s.re.test(text))?.id ?? "other"

/**
 * Subjects whose FIRST appearance in a game is news by itself.
 *
 * An event either happened or it did not, so the first line about one cannot be a restatement. A
 * value in the snapshot — his farm, his level — is present on every single turn, so "the first
 * line about it" is a property of the coach's wording rather than of the game.
 */
export const NOVEL_SUBJECTS: readonly SaidSubject[] = [
	"fight",
	"objectives",
	"objective-lost",
	"downed",
	"your-death",
	"gold",
	"build",
	"kill-share"
]

/** EVERY subject the sentence touches, not just the one its premise is about. */
export const subjectsIn = (text: string): SaidSubject[] =>
	SAID_SUBJECTS.filter(s => s.re.test(text)).map(s => s.id)

/**
 * WHAT HE WAS TOLD TO DO, as an intent rather than as words.
 *
 * Measured, and this is the whole reason the key is not lexical: over the 38 lines Opus 5 spoke in
 * `data/eval/model-opus5.json`, the instruction "keep clearing" was given under 14 distinct head
 * phrasings — "keep route rolling", "keep route running", "start route don't", "take every camp",
 * "full route don't", "full clear start", "go straight next", "keep hitting raptors", "keep
 * unbroken", "so keep route", "so walk full", "get base start", "leave fountain", "grab leash
 * commit". A key built from the words counts fourteen different instructions. He heard one.
 *
 * First match wins, so the order is the specificity order: counter-jungling names a camp and is a
 * different decision from clearing your own, and it says "clear" in the same breath.
 */
export const DIRECTIVE_INTENTS: { id: string; re: RegExp }[] = [
	/*
	 * "back" only where it opens the instruction.
	 *
	 * "You're on 133 HP with 881 gold — back, buy, and restart the route" splits into a clause that
	 * is the single word `back`, and without the anchor it fell through to the word fallback — so
	 * the coach's own recall reminder was not recognised as one, and `followUp` never asked whether
	 * he had spent. A bare \bback\b anywhere would have caught "get right back to clearing", which
	 * is the opposite instruction.
	 */
	{ id: "recall", re: /^back\b|\b(recall|reset|take the back|go back|back and buy|back,|\bback\b(?= and)|head back)/i },
	{ id: "buy", re: /\b(buy|spend|shop|purchase|pick up (?:a|an|your))\b/i },
	{ id: "objective", re: /\b(drake|dragon|herald|grub|baron|nashor|scuttle|pit|plate|tower|turret)\b/i },
	{ id: "ward", re: /\b(ward|vision|sweep|trinket)\b/i },
	{ id: "gank", re: /\b(gank|dive|collapse|rotate|go help|come (?:to|for)|pressure (?:top|mid|bot))\b/i },
	{ id: "counter-jungle", re: /\b(his|her|their|enemy)\b.{0,16}\b(jungle|camps?|blue|red|raptors|gromp|krugs|wolves)\b|\bcounter[- ]?jungle\b/i },
	{ id: "keep-clearing", re: /\b(route|clear|camps?|farm|jungle|raptors|gromp|krugs|wolves|buff|leash)\b/i },
	{ id: "reposition", re: /\b(walk|guard|cover|hover|entrance|river|lane|mid|top|bot|side)\b/i },
	{ id: "fight", re: /\b(fight|trade|group|engage|take the|contest)\b/i },
	/*
	 * LAST, because a negation is a modifier and not a decision.
	 *
	 * Ordered above `keep-clearing` it split the catchphrase family in two: "Full route from here and
	 * don't stop it" filed as `avoid` while "Keep the route rolling" filed as `keep-clearing`, so the
	 * budget that exists to stop one instruction being repeated was spending two. A clause with any
	 * positive intent in it is that intent; `avoid` is what is left when the whole instruction is to
	 * not do something.
	 */
	{ id: "avoid", re: /\b(don'?t|do not|never|stop|avoid|stay (?:out|away|home)|leave (?:him|her|it) alone)\b/i }
]

/**
 * The instruction, stripped of everything that varies turn to turn.
 *
 * Falls back to the literal head words when no intent matches, so an instruction this vocabulary
 * has never seen still gets a memory rather than a blank one that collides with every other blank.
 */
export const directiveKey = (line: string, champions: readonly string[] = []): string => {
	const action = actionClause(line)
	if (action === null) return ""
	const intent = DIRECTIVE_INTENTS.find(d => d.re.test(action))
	if (intent) return intent.id
	const lower = new Set(champions.map(c => c.toLowerCase()))
	const ws = words(action).filter(w => !/^\d+$/.test(w) && !lower.has(w.replace(/'s$/, "")))
	const head = ws[0] ?? ""
	const rest = ws.slice(1).filter(w => !STOPWORDS.has(w.replace(/'s$/, "")))
	return [head, ...rest.slice(0, 2)].join(" ")
}

/**
 * The thresholds, and how they were chosen.
 *
 * Swept over the three corpora together — Opus's 38 lines, Gemini's 35, and the 15 hand-written
 * targets — at every combination of wording overlap 0.35/0.4/0.45/0.5, directive cooldown
 * 60/90/120/150s and subject cooldown 60/90/120s. 48 cells, and the surface is flat: targets kept
 * ranged 14-15 of 15 and leaked repeats 0-3. Two corners are defensible and they trade against
 * each other — (0.4, 150s, 90s) leaks nothing and kills one target; (0.45, 90s, 90s) keeps all
 * fifteen targets and leaks two.
 *
 * The second is shipped, because the two errors are not symmetrical. A leaked repeat is one
 * repeated line. A killed target is a line like *"Briar has not moved off zero CS in four minutes —
 * go take his raptors and his blue"* never being said at all, which is the failure the owner
 * actually reported. When in doubt this gate speaks.
 *
 * Everything is a ROLLING window rather than a per-game total, and that too is a correction: a
 * whole-game budget of three retired the subject `farm` by 3:08 of a 36-minute game, which is the
 * fence with extra steps.
 */
export interface SaidLimits {
	wordingOverlap: number
	wordingLookbackSec: number
	directiveCooldownSec: number
	directiveBudget: number
	directiveWindowSec: number
	subjectBudget: number
	subjectWindowSec: number
	subjectCooldownSec: number
	/** However novel a line's subject, this much shared wording is the same sentence. */
	verbatimOverlap: number
}

export const SAID_LIMITS: SaidLimits = {
	wordingOverlap: 0.45,
	wordingLookbackSec: 240,
	directiveCooldownSec: 90,
	directiveBudget: 3,
	directiveWindowSec: 300,
	subjectBudget: 3,
	subjectWindowSec: 300,
	subjectCooldownSec: 90,
	verbatimOverlap: 0.8
}

/**
 * The client numbers as they stood when a line was spoken, so the loop can be closed later.
 *
 * GOLD ONLY, and the absences are deliberate. Gold is exact, it moves when he does the thing, and
 * it moves one way — see `followUp`. CS is floored to tens, so a delta between two stored floors is
 * worth nine in either direction and needs the interval arithmetic in `live-state.ts`; level and
 * deaths are trajectory questions. All three belong to whoever builds the briefing, not to the
 * transcript, and a field kept here "for later" is a field that goes stale unread.
 */
export interface SaidSnapshot {
	gold?: number
}

/** One thing he heard, with both of its keys already derived. */
export interface SaidLine {
	/** Game clock in seconds, so every window in this file is game time and never wall time. */
	tSec: number
	line: string
	subject: SaidSubject
	/** Every subject the sentence touched, so novelty is asked of the whole line. */
	touched: SaidSubject[]
	directive: string
	content: string[]
	at: SaidSnapshot
}

/**
 * Everything he has heard this game. SPOKEN lines only.
 *
 * A refused line is not in here, and that is the definition rather than an optimisation: the
 * question every rule in this file asks is "has he heard this", and he did not hear the one the
 * gate stopped. It also means the memory grows at the gated rate — about seven lines in seven
 * minutes — rather than at the model's.
 */
export interface SaidMemory {
	lines: SaidLine[]
	/** The ten in this game, used to strip names out of a directive key. */
	champions: string[]
}

export const newSaidMemory = (champions: readonly string[] = []): SaidMemory => ({
	lines: [],
	champions: [...champions]
})

/**
 * Forget everything, IN PLACE, between games.
 *
 * In place because the daemon holds one memory for the process, exactly as `resetFactMemory` does
 * in `live-facts.ts`, and for the same reason the socket is closed at the end of a game rather than
 * kept for the session: a transcript that spans two games tells the coach it has already said
 * things it has not.
 */
export const resetSaidMemory = (mem: SaidMemory, champions: readonly string[] = []): void => {
	Object.assign(mem, newSaidMemory(champions))
}

/**
 * True when the line says nothing — a PASS, or blank.
 *
 * PASS is never remembered and never judged: it is the correct answer on most turns, and a memory
 * that recorded it would count silence as a subject and then refuse to be silent again.
 */
export const isSilent = (line: string): boolean => {
	const t = line.trim()
	return t === "" || /^pass\b/i.test(t)
}

/**
 * CONTAINMENT, not Jaccard: shared words over the SHORTER line.
 *
 * A model that says the same thing twice usually says it shorter the second time — "Your clear only
 * gets faster while it keeps running, so finish the whole route" against "Stand by your buff and
 * start your route because your clear only gets faster while it keeps running". Jaccard divides by
 * the union and scores that pair 0.50; containment asks the question that matters, which is whether
 * the shorter line is inside the longer one, and scores the same pair 0.75. Both of those lines are
 * from the Gemini run, 25 seconds apart.
 */
const overlap = (a: readonly string[], b: readonly string[]): number => {
	if (a.length === 0 || b.length === 0) return 0
	const set = new Set(b)
	let shared = 0
	for (const w of a) if (set.has(w)) shared++
	return shared / Math.min(a.length, b.length)
}

/**
 * Which rule refused the line, so a drop can be argued with rather than trusted.
 *
 * Which rule fires how often, on the two real transcripts replayed through the gate:
 *
 *     corpus     wording   directive   subject-spent   survived
 *     opus5           21           9               1          7
 *     flash36         20           5               1          9
 *     targets          0           0               0         15
 *
 * - `wording` — he has heard this sentence. Does the bulk of the work and cannot do it alone: the
 *   memory only holds what SURVIVED, so as the gate gets better the pool it compares against gets
 *   smaller. Against the full ungated Opus transcript this rule alone flags 32 of 38; inside the
 *   gate it has seven lines to compare with and needs the other two.
 * - `directive` — he has been told to do this. The instruction stays true for minutes while the
 *   numbers around it move, so this is the rule that catches the same advice in a new sentence.
 * - `subject-spent` — this topic has had its share of the last five minutes.
 */
export type SaidRepeat = "wording" | "directive" | "subject-spent" | null

/**
 * What the WORLD has done since the coach last spoke, supplied by the caller.
 *
 * The memory can tell whether a sentence has been said; only the state can tell whether the thing
 * it was about has changed. Measured on the hand-written targets in `data/eval/target-lines.md`:
 * M06 at 5:41 says *go start the drake*, and M07 at 6:05 says *leave the pit, drake's gone*. Those
 * are 24 seconds and one event apart, and every rule in this file reads the second as a
 * restatement of the first. It is the opposite instruction, and it is the one line in the set that
 * a coach must be able to interrupt itself with. A subject named here is news, and news is never a
 * repeat.
 */
export interface SaidContext {
	news?: readonly SaidSubject[]
}

export interface SaidVerdict {
	repeat: boolean
	reason: SaidRepeat
	/** The earlier line it restates, when there is one. */
	of: SaidLine | null
	why: string
}

/** Derive both keys and the content words for one line, without recording it. */
export const analyseSaid = (mem: SaidMemory, line: string, tSec: number): SaidLine => ({
	tSec,
	line: line.trim(),
	subject: subjectOfSaid(premiseClause(line)),
	touched: subjectsIn(clean(line)),
	directive: directiveKey(line, mem.champions),
	content: contentWords(line),
	at: {}
})

/**
 * MAY HE HEAR THIS? The refusal, in rule order.
 *
 * Order is the argument. The two exemptions run FIRST, because a line the world has made new is not
 * a repeat however it is worded — except when it is word for word, which is the `verbatimOverlap`
 * guard on both of them. Then the three refusals, cheapest and most certain first.
 *
 * Enforceable only where the sentence exists as text before it is spoken, i.e. the turn-based
 * providers. On the Gemini Live socket the audio is already playing when the transcription arrives,
 * so there this is an instrument and `renderSaid` is the mechanism. See the header.
 */
export const judgeSaid = (
	mem: SaidMemory,
	line: string,
	tSec: number,
	limits: SaidLimits = SAID_LIMITS,
	context: SaidContext = {}
): SaidVerdict => {
	if (isSilent(line)) return { repeat: false, reason: null, of: null, why: "said nothing" }
	const now = analyseSaid(mem, line, tSec)

	let worst = 0
	let worstOf: SaidLine | null = null
	for (const prev of mem.lines) {
		if (tSec - prev.tSec > limits.wordingLookbackSec) continue
		const sim = overlap(now.content, prev.content)
		if (sim > worst) {
			worst = sim
			worstOf = prev
		}
	}
	const verbatim = worst >= limits.verbatimOverlap && worstOf !== null
	const news = now.touched.filter(t => context.news?.includes(t))
	if (news.length > 0 && !verbatim)
		return { repeat: false, reason: null, of: null, why: `${news.join(", ")} changed since the last line` }

	const heard = new Set(mem.lines.flatMap(p => p.touched))
	const fresh = now.touched.filter(t => !heard.has(t) && NOVEL_SUBJECTS.includes(t))
	if (fresh.length > 0 && !verbatim)
		return { repeat: false, reason: null, of: null, why: `first line of the game about ${fresh.join(", ")}` }

	if (worst >= limits.wordingOverlap && worstOf)
		return {
			repeat: true,
			reason: "wording",
			of: worstOf,
			why: `${Math.round(worst * 100)}% of its content words are in a line said at ${worstOf.tSec} seconds`
		}

	if (now.directive !== "") {
		const same = mem.lines.filter(p => p.directive === now.directive)
		const last = same.at(-1)
		if (last && tSec - last.tSec <= limits.directiveCooldownSec)
			return {
				repeat: true,
				reason: "directive",
				of: last,
				why: `he was told "${now.directive}" ${Math.round(tSec - last.tSec)} seconds ago`
			}
		const recentSame = same.filter(p => tSec - p.tSec <= limits.directiveWindowSec)
		if (recentSame.length >= limits.directiveBudget)
			return {
				repeat: true,
				reason: "directive",
				of: recentSame.at(-1) ?? null,
				why: `he has been told "${now.directive}" ${recentSame.length} times in the last ${Math.round(limits.directiveWindowSec / 60)} minutes`
			}
	}

	/*
	 * "other" is the bucket, not a subject, so it gets no budget and no cooldown.
	 *
	 * Measured on the targets: three of the fifteen classify as `other`, and two of those three are
	 * M11 ("...the grubs are untouched — take all three now, you have thirteen seconds") and M12
	 * ("Briar has been back up for twenty seconds and you're at forty one percent — finish the grub
	 * and get out"). Thirty-one seconds apart and about different things, and giving the bucket a
	 * cooldown silenced the second. Two lines are not about the same subject because neither
	 * matched a regex.
	 */
	if (now.subject === "other") return { repeat: false, reason: null, of: null, why: "new" }

	const sameSubject = mem.lines.filter(p => p.subject === now.subject)
	const recent = sameSubject.filter(p => tSec - p.tSec <= limits.subjectWindowSec)
	if (recent.length >= limits.subjectBudget)
		return {
			repeat: true,
			reason: "subject-spent",
			of: recent.at(-1) ?? null,
			why: `${now.subject} has had ${recent.length} lines in the last ${Math.round(limits.subjectWindowSec / 60)} minutes`
		}
	const lastOnSubject = sameSubject.at(-1)
	if (lastOnSubject && tSec - lastOnSubject.tSec <= limits.subjectCooldownSec)
		return {
			repeat: true,
			reason: "subject-spent",
			of: lastOnSubject,
			why: `${now.subject} was raised ${Math.round(tSec - lastOnSubject.tSec)} seconds ago`
		}

	return { repeat: false, reason: null, of: null, why: "new" }
}

/**
 * Record what he actually heard, with the numbers that were true when he heard it.
 *
 * Called on the line that SPOKE — after `judgeSaid` cleared it on the turn path, and from the
 * socket's `outputTranscription` handler on the socket path, where nothing cleared it and the
 * transcript is all there is.
 */
export const rememberSaid = (
	mem: SaidMemory,
	line: string,
	tSec: number,
	at: SaidSnapshot = {}
): SaidLine | null => {
	if (isSilent(line)) return null
	const entry = { ...analyseSaid(mem, line, tSec), at }
	mem.lines.push(entry)
	return entry
}

/* ============================================================ the transcript he heard */

/**
 * How many spoken lines are quoted back in full before the rest collapses into a tally.
 *
 * The block is already 60 lines and every line in it competes with the picture for attention, so
 * the transcript cannot grow with the game — a 36-minute game at the shipped 45-second floor is
 * about 45 lines and quoting them all would double the prompt by the twenty-minute mark. Five is
 * just under what this gate lets through in the seven minutes it was measured over — 7 lines for
 * Opus, 9 for Gemini — so at the rate the gated coach actually speaks, the quotes cover roughly the
 * last four or five minutes and the tally covers everything before that. It is a number to raise if
 * the briefing makes the coach talkative again, not a constant with a measurement behind it.
 */
export const SAID_SHOWN = 5

/**
 * Did he act on it? Answered for GOLD and nothing else, on purpose.
 *
 * Gold is the only figure in the block that is exact, that moves when he does the thing, and that
 * moves in one direction only — it falls when he spends. CS is floored to tens (`live-state.ts`),
 * so a CS delta between two stored snapshots is worth nine either way and would need the interval
 * arithmetic `csGap` already does; that belongs to whoever builds the trajectory, not here, and
 * importing it would make this module and the block circular.
 *
 * `target-lines.md` names both halves of why this matters: M14 is *"he was told to spend; he
 * spent"* — congratulating him for it is the coach talking about itself — and M23 is the same
 * event seen from the other side. Neither is knowable from a snapshot, and both are one
 * subtraction once the coach remembers the number it was holding when it spoke.
 */
export const followUp = (said: SaidLine, now: SaidSnapshot): string | null => {
	const then = said.at.gold
	const gold = now.gold
	if (then === undefined || gold === undefined) return null
	if (said.directive !== "recall" && said.directive !== "buy") return null
	if (gold < then) return `he has spent since — ${Math.round(then)} gold then, ${Math.round(gold)} now`
	return `he has NOT spent — ${Math.round(then)} gold then, ${Math.round(gold)} now`
}

/**
 * A count of repetitions, in WORDS and never in digits.
 *
 * Everything in this block is a thing the coach may say out loud, and this file's own subject is a
 * model that repeats what it is shown. `keep-clearing x4` invites "keep clearing times four"; the
 * same lesson is already recorded in `live-coach-mode.ts`, where two catchphrases offered as
 * examples came back in 71% of the lines. Above four it stops counting, because the exact number
 * changes nothing about the instruction, which is to stop.
 */
const SPELLED = ["", "", "twice", "three times", "four times"]

const tally = (keys: string[]): string =>
	[...new Set(keys)]
		.map(k => ({ k, n: keys.filter(x => x === k).length }))
		.sort((a, b) => b.n - a.n)
		.map(t => (t.n === 1 ? t.k : `${t.k} (${SPELLED[t.n] ?? "many times"})`))
		.join(", ")

/**
 * The coach's own transcript, as the model should see it.
 *
 * Returns the empty string before the coach has said anything, so the block carries no heading for
 * a game that has not started. Every other absence in this block is stated rather than omitted
 * (see `live-state.ts` on the missing baseline), and this one is the exception for a reason: an
 * empty transcript is not a gap a model can fill with a guess. There is nothing to invent about
 * having said nothing.
 */
export const renderSaid = (mem: SaidMemory, now: SaidSnapshot = {}): string => {
	if (mem.lines.length === 0) return ""
	const recent = mem.lines.slice(-SAID_SHOWN)
	const older = mem.lines.slice(0, -SAID_SHOWN)
	const quoted = recent.map(l => {
		const done = followUp(l, now)
		return `- ${fmtClock(l.tSec)} (${l.subject}) "${l.line}"${done ? ` — ${done}` : ""}`
	})
	return `### What you have already said out loud this game

He heard every one of these. **Say none of them again, in any wording** — not the same fact carrying
a new number, not the same instruction in different words. A true thing said twice does not land
twice; it teaches him to stop listening to the first telling.

${quoted.join("\n")}${
		older.length > 0 ?
			`\n\nEarlier, no longer quoted: ${tally(older.map(l => l.subject))}.`
		:	""
	}

Instructions he has already been given: ${tally(mem.lines.map(l => l.directive).filter(Boolean)) || "none"}.
Repeating one of these is not reinforcement — he heard it, and whether he did it is between him and
the game.

If the only thing worth saying is on this list, say PASS. Silence is the correct answer on most
turns and it costs nothing; a line he has already heard costs the credibility of the next one.`
}
