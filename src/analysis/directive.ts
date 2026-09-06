/**
 * What a spoken line ORDERS, independent of what it cites — and the three orders measured at zero.
 *
 * ## Why the imperative and not the fact
 *
 * Three rounds have attacked the numerator. Round 1 rebuilt the context as a briefing, round 2
 * retired standing facts, round 3 fed the ranker and put the frames back; every mechanism worked
 * and none moved usefulness, and round 3 falsified the premise it was built on (ranked-fact turns
 * re-measured at 19% against 16%, Fisher p = 0.795, pooled n = 214). The denominator has never been
 * attacked. Best arm, whole game, at the owner's bar: **thirty-six sentences, ten of them useful.**
 * Ten sentences with eight useful is a different product from thirty-six with ten — the same
 * information, and the difference between a coach and a radio.
 *
 * This module is the denominator lever. It reduces a line to the ACTION it demands and refuses the
 * families that have never once cleared the bar, whatever they cited. The split it makes is not the
 * one the app has been making: **the fact may be perfectly good and the order still worthless**,
 * because the order is one he could have given himself off his own HUD. He knows to keep clearing.
 * He knows to spend gold. Telling him is free and worth nothing.
 *
 * ## The measurement, and it chose the ban list rather than being chosen for it
 *
 * 214 spoken lines — every line from rounds 2 and 3, three architectures, one model, one whole game
 * on a uniform grid — each graded blind at the owner's bar ("would he have learned something he did
 * not already know, at a moment he could still act on it") by TWO independent claude-opus-5 passes
 * that did not see the arm labels and did not read each other. They agree on the clears/not split
 * for 192 of 214. Verdicts are `data/eval/offered/hand-verdicts.json`,
 * `data/eval/retired/hand-verdicts.json` and `data/eval/judge-r3/verdicts.json`; the lines are the
 * two blind sheets beside them. `classifyDirective` was then run over all 214:
 *
 *     family              n    judge A clears   [95% CI]     judge B clears
 *     clear-camps        76     0    0%         [0-5]%        0    0%
 *     objective          52    33   63%         [50-75]%     19   37%
 *     spend-gold         36     0    0%         [0-10]%       0    0%
 *     fight-shape        20     0    0%         [0-16]%       0    0%
 *     push               14     5   36%         [16-61]%      0    0%
 *     objective-unnamed   7     0    0%         [0-35]%       0    0%
 *     disengage           6     1   17%          1   17%
 *     path-side           2     2  100%          2  100%
 *     arrive              1     1  100%          0    0%
 *
 * Banning the three at zero removes 132 of the 214 lines and **not one line either judge cleared**.
 * Kept lines run 42/82 (51%) by judge A and 22/82 (27%) by judge B against 20% and 10% before;
 * Fisher exact p = 1.3e-13 and 9.4e-11. Per arm-game that is 35.7 sentences down to 13.7 with the
 * useful count unchanged at 7.0 (A) and 3.7 (B). On the best arm — briefing, round 3 — it is
 * thirty-six sentences with ten useful down to twenty-four with ten.
 *
 * That is the whole claim and it is a DENOMINATOR claim. Nothing here makes a good line more
 * likely; it makes the bad ones not arrive.
 *
 * ## Held out, and the one disagreement, reported rather than smoothed
 *
 * Round 1's earlier hand pass (`data/eval/briefing-frames/human-verdicts.json`, 97 lines, a
 * different rubric with its own `repeat` verdict) was not used to choose the families. Run through
 * the same classifier it gives clear-camps 0 of 32 — the ban's biggest family, confirmed on data it
 * never saw — and fight-shape does not occur in it at all.
 *
 * It disagrees about gold. It cleared 3 of 21 spend-gold lines, and all three are the same shape:
 * *recall and spend before the dragon spawns*, a reset timed against an objective window. The
 * current judge saw that shape too — "Recall to spend your 1768 gold before Baron spawns in 29
 * seconds" — and marked it marginal, twice. Pooled over all three passes spend-gold is 3 of 56
 * (5%) against a base rate near 15%. It is banned, and what that costs if round 1 is the better
 * reader is at most three lines in fifty-six. A carve-out for the compound shape was tried and
 * rejected: it re-admits more of the marginal lines than the three it rescues.
 *
 * ## What this classifier deliberately CANNOT do, said out loud rather than shipped quietly
 *
 * **It cannot split the objective family, and it does not try.** "Take dragon" is an order he could
 * give himself; "take dragon, Lissandra is down and it has stood free for two minutes" is the best
 * line any model here has produced. Both are `objective`. Measured inside that family: the 16 lines
 * that failed are almost all *path to the pit because it spawns in N seconds*, and the imperative
 * does not separate them — "path straight to dragon and start it" clears while "path to the pit and
 * take it" does not, and "head to the pit now while Briar is down" clears while "head down to the
 * pit right now" does not. The discriminator there is the PREMISE, not the order: a spawn countdown
 * inside three minutes is printed on his own minimap, exactly and earlier than this app can
 * (`shared/live-state.ts`, `MINIMAP_COUNTDOWN_SEC`). That lever already exists on the premise side
 * and it belongs there. Banning a verb this classifier cannot read would take the best line in the
 * corpus with it.
 *
 * `push` and `disengage` were considered and kept: push is 5/14 by one judge and 0/14 by the other,
 * which is disagreement rather than a zero, and disengage cleared once in six. `objective-unnamed`
 * ("push AN objective", "take a far objective") is 0 of 7 by both judges and is the obvious next
 * candidate — n is too small to ban on, and it is named here so the next run can settle it.
 * `path-side` ("put your next path through the side of the map he is playing") is carved OUT of
 * clear-camps on n = 2, both judges clearing both, and the carve-out is stated because it is what
 * makes clear-camps a clean zero rather than one-in-seventy-seven.
 *
 * ## Where it is wired, and which half is guaranteed
 *
 * `shared/live-coach-mode.ts` withholds every ranked offer whose imperative is banned before the
 * block is rendered, which on round 3's fifty states withheld 13 of the 22 off-screen offers and
 * turned two more states into the block's own computed PASS. That half is arithmetic and cannot be
 * argued with.
 *
 * The other half is a rule in the prompt, and three rounds say a prompt rule is a request. The
 * refusal that would be mechanical is a SPEAK-TIME gate — drop a line whose directive is banned
 * before it is spoken — and `isBannedDirective` is shaped for exactly that call. It is not wired
 * here because the socket and the pace floor are not this module's to edit.
 */

/**
 * What the line tells him to DO. One line, one family — the first imperative wins.
 *
 * "A line with two imperatives is graded on the first one" is the blind judge's own rule, so
 * "spend your gold and set up for Baron" is a gold line, not an objective line. Matching the
 * judge's convention is what makes the table above mean anything.
 */
export type DirectiveFamily =
	| "clear-camps"
	| "spend-gold"
	| "fight-shape"
	| "objective"
	| "objective-unnamed"
	| "push"
	| "disengage"
	| "path-side"
	| "arrive"
	| "other"
	| "none"

/**
 * Verbs a jungle coach gives an order with. An imperative clause starts with one of these.
 *
 * A list rather than a parser because the corpus is 300 sentences of one register, and every
 * addition here is a word that actually appeared in it. An unrecognised clause falls through to
 * `none`, which is the SAFE direction: a line whose order this file cannot read is never banned.
 */
const VERB =
	"keep|take|clear|farm|path|head|go|start|walk|move|run|push|recall|back|buy|spend|ping|secure|get|grab|stay|hold|pull|group|ward|contest|deny|finish|cross|defend|do|don't|dont|never|avoid|skip|join|use|hit|land|make|set|cover|catch|extend|reset|look|find|kite|fight|arrive|leave|stop|turn|plan|guard|bring|trade|gather|stick|sit|wait|put"

const STARTS_IMPERATIVE = new RegExp(`^(?:${VERB})\\b`)

/** "when you respawn take the long fights" — a temporal lead-in does not stop it being an order. */
const LEAD_IN = new RegExp(`^(?:when|once|after|before|while|if|as soon as|now|next time|first)\\b[^,]*?\\s(?=(?:${VERB})\\b)`)

/** "you have about eleven seconds TO TAKE an objective" — the order arrives as an infinitive. */
const INFINITIVE = new RegExp(`\\bto ((?:${VERB})\\b.*)$`)

/** Clause boundaries. "so", "and" and "then" join two orders as often as punctuation does. */
const CLAUSE = /\s*(?:—|–|;|,\s*|\bso\b|\bthen\b|\band\b|\bbut\b)\s*/

/**
 * A bare verb with no object is not yet an order — "reset and take your jungle camps" is a camps
 * line, and reading "reset" as a recall would file it under the wrong ban.
 */
const BARE = /^(?:reset|go|back|push|move|start)$/

const OBJECTIVE = /\bbaron\b|\bdragon\b|\bdrake\b|\bherald\b|\bgrubs?\b|\bsoul\b|\bscuttle\b/

const normalize = (line: string): string => line.toLowerCase().replace(/[.!?]+$/, "").trim()

/** The clauses of one spoken line, in order. */
export const clausesOf = (line: string): string[] =>
	normalize(line)
		.split(CLAUSE)
		.map(c => c.trim())
		.filter(c => c !== "")

/**
 * The PRIMARY imperative clause — the first thing the line actually tells him to do.
 *
 * Empty when the line orders nothing, which is a real answer: a ranked fact like "Drake is back in
 * ten seconds" states a situation and leaves the order to the model, and a fact with no order in it
 * cannot carry a banned one.
 */
export const imperativeOf = (line: string): string => {
	const clauses = clausesOf(line)
	for (const c of clauses) {
		const stripped = c.replace(LEAD_IN, "")
		if (STARTS_IMPERATIVE.test(stripped) && !BARE.test(stripped)) return stripped
	}
	for (const c of clauses) {
		const m = INFINITIVE.exec(c)
		if (m) return m[1]!
	}
	return ""
}

/**
 * The family of one imperative clause, or "" when none of them fit.
 *
 * Order is the whole logic. `fight-shape` is tested before everything because "take the long fights
 * with room to kite" is a `take` and is not about a camp; `spend-gold` before `objective` because
 * "recall and spend before Baron" is graded on the recall; `path-side` before `clear-camps` because
 * "put your next path through the side of the map he is playing" contains the word "clear" in the
 * corpus and is the one routing order that measured well.
 */
const familyOf = (imperative: string): DirectiveFamily | "" => {
	if (/open ground|room to kite|long fights?|\bkite\b|\bdust\b|before you cast|\bult\b|corridor|sleep|with a spell/.test(imperative))
		return "fight-shape"
	if (/\brecall\b|\bbuy\b|\bspend\b|\bto base\b|\bshop\b|\b(?:pet|jungle item|starting item)\b/.test(imperative))
		return "spend-gold"
	if (OBJECTIVE.test(imperative)) return "objective"
	if (/\ban? (?:far )?objective\b|\bnext timer\b/.test(imperative)) return "objective-unnamed"
	if (/\bpush\b|\bend (?:the|this) game\b|\bnexus\b|\btower\b|\bturret\b|\bgroup\b|\bbase\b|\blane\b/.test(imperative))
		return "push"
	if (/pull back|path away|don'?t\b|\bavoid\b|\bskip\b|back off|walk away|\bstay\b|\bleave\b/.test(imperative))
		return "disengage"
	if (/through (?:that|her|his|their|the enemy) side|side of the map/.test(imperative)) return "path-side"
	if (/\bcamps?\b|\bclear\b|\bfarm\b|\broute\b|\bjungle\b|\btempo\b|\bwave\b|\bpace\b/.test(imperative))
		return "clear-camps"
	if (/next fight|get to the|with somebody|\bearly\b/.test(imperative)) return "arrive"
	return ""
}

/**
 * What this line ORDERS.
 *
 * Two passes on purpose. The imperative clause is read first, because that is the judge's rule and
 * because it is where the order lives. When the clause is too elided to place on its own — "so
 * finish the next", "so bring someone", "so take it now" — the whole line is used to resolve the
 * missing object, which is what a listener does. The fallback can only fire on a line that already
 * HAS an imperative: a bare fact stays "none" and is never banned by association with its premise.
 */
export const classifyDirective = (line: string): DirectiveFamily => {
	const imperative = imperativeOf(line)
	if (imperative === "") return "none"
	return familyOf(imperative) || familyOf(normalize(line)) || "other"
}

/**
 * The three orders measured at zero across 132 lines and two blind judges.
 *
 * - **clear-camps** — keep the clear running, take your camps, take his camps, get your route
 *   moving, full clear to catch your pace. 0 of 76 here and 0 of 32 on the held-out round. It is
 *   the app's own top-ranked subject and the enemy-jungler comparison was built to serve it.
 * - **spend-gold** — recall, buy, spend it, reset. 0 of 36. His gold total is the bottom right of
 *   his screen, permanently.
 * - **fight-shape** — take long fights with room to kite, pull them into open ground, land dust
 *   before the ult. 0 of 20, and it is 12 of the 26 ranked facts in one whole game: 46% of the
 *   supply, producing nothing.
 *
 * None of them is banned for being FALSE. Every figure in them is exact. They are banned because
 * the action is his already.
 */
export const BANNED_DIRECTIVES: readonly DirectiveFamily[] = ["clear-camps", "spend-gold", "fight-shape"]

/**
 * Would this sentence tell him only something he would have told himself?
 *
 * Shaped as a predicate over the raw line so it can be used three ways: to withhold a ranked offer
 * before the block is built (`shared/live-coach-mode.ts` does this), to gate a line at speak time,
 * and to score a transcript after the fact.
 */
export const isBannedDirective = (line: string): boolean =>
	(BANNED_DIRECTIVES as readonly string[]).includes(classifyDirective(line))

/**
 * The measurement, as data, so the test pins the claim and not just the code.
 *
 * `clears` is judge A (`data/eval/offered/hand-verdicts.json` and its round-2 twin); `clearsB` is
 * the independent second pass (`data/eval/judge-r3/verdicts.json`). Both read the same 214 lines
 * blind. Re-derive with the two blind sheets beside those files.
 */
export const DIRECTIVE_EVIDENCE: readonly {
	family: DirectiveFamily
	n: number
	clears: number
	clearsB: number
	banned: boolean
}[] = [
	{ family: "clear-camps", n: 76, clears: 0, clearsB: 0, banned: true },
	{ family: "objective", n: 52, clears: 33, clearsB: 19, banned: false },
	{ family: "spend-gold", n: 36, clears: 0, clearsB: 0, banned: true },
	{ family: "fight-shape", n: 20, clears: 0, clearsB: 0, banned: true },
	{ family: "push", n: 14, clears: 5, clearsB: 0, banned: false },
	{ family: "objective-unnamed", n: 7, clears: 0, clearsB: 0, banned: false },
	{ family: "disengage", n: 6, clears: 1, clearsB: 1, banned: false },
	{ family: "path-side", n: 2, clears: 2, clearsB: 2, banned: false },
	{ family: "arrive", n: 1, clears: 1, clearsB: 0, banned: false }
]
