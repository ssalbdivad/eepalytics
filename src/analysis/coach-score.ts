/**
 * Mechanical scoring of one line the live coach said, against the block it was holding.
 *
 * ## What this is for
 *
 * The owner's question is *"how much of the hallucination is the model?"* — and the only way to
 * answer it is to hold the prompt, the ground-truth block and the frame constant and vary only
 * the model. That makes the scorer the instrument. `scripts/bench-providers.ts` drives the
 * providers; everything that decides whether a line was a fabrication lives here, pure, so it can
 * be unit tested against lines that SHOULD and should NOT trip each rule.
 *
 * **A scorer that flatters one model is worse than no scorer.** So every rule below is stated
 * precisely enough to be argued with, each one names the measured failure it exists to catch, and
 * the known false positives and false negatives are written down next to the rule rather than
 * discovered later by someone who trusted the number.
 *
 * ## The two tiers, and why they are not added together
 *
 * Four of the six faults are FABRICATIONS: the coach said something untrue that the player cannot
 * check. Two are WEAKNESSES: the line is true but useless. They are reported separately and never
 * summed, because a model that says nothing useful is a different — and much smaller — problem
 * than a model that sends him to dive a champion who is already back up.
 *
 * ## The one thing this file does NOT do
 *
 * It does not judge tone, warmth, variety or repetition. Those need a judge, they are measured
 * that way in `scripts/eval-live.ts`, and folding a subjective score into a mechanical one is how
 * a benchmark stops being arguable.
 */

/* ============================================================== the faults */

export type CoachFault =
	/**
	 * A champion named in the line who is not on the block's roster.
	 *
	 * This is the failure that started the project: given pixels alone the coach talked about a
	 * champion who was not in the game for seven minutes. It is the cleanest signal here — the
	 * block states outright that the ten champions in it are the only champions in the game — so a
	 * model that trips this one is not reading the block at all.
	 */
	| "invented-champion"
	/**
	 * A figure in the line that appears nowhere in the block.
	 *
	 * "over 1000 gold" when the block says 1017 is a number the model made up, and the prompt says
	 * so in as many words. Digits and spoken words both count — see `normalizeNumbers`.
	 */
	| "unbacked-number"
	/**
	 * A figure that IS in the block but is attached to the wrong player.
	 *
	 * Measured, from a real block where 1180 gold was HIS: *"Kayn is 1180 gold and level 9 to your
	 * 8"*. Every digit came off the block and the sentence is still false — an enemy's gold does
	 * not exist in the client's data at all. This is the fault a naive "is the number in the
	 * block?" check scores as clean, which is exactly why it is counted separately.
	 */
	| "misattributed-number"
	/**
	 * Movement or intent asserted about somebody other than the player.
	 *
	 * "they are converging on you", "he is coming for your red". One frame is an instant; it
	 * cannot contain motion, and nothing in the block carries intent. This is the most dangerous
	 * fault in the set, because he will *walk somewhere* on the strength of it.
	 */
	| "invented-movement"
	/**
	 * The line restates something already on his screen and adds nothing.
	 *
	 * True, and worthless: his own level, his own kills, his own health, a champion dying that he
	 * watched die. Not a fabrication — a wasted turn.
	 */
	| "visible-only"
	/**
	 * No action is named, so the line is an observation rather than coaching.
	 *
	 * NOT automatically a defect. The prompt explicitly sanctions a bare fact — *"if you cannot
	 * name what the fact buys, say the fact plainly and stop"* — so this is reported as a rate to
	 * look at, never rolled into the fabrication headline.
	 */
	| "no-alternative"

/** The four faults that mean the coach said something untrue. These make the headline. */
export const FABRICATION_FAULTS: readonly CoachFault[] = [
	"invented-champion",
	"unbacked-number",
	"misattributed-number",
	"invented-movement"
]

/** True but useless. Reported beside the headline, never added to it. */
export const WEAKNESS_FAULTS: readonly CoachFault[] = ["visible-only", "no-alternative"]

export interface ScoreInput {
	/** What the coach said, verbatim. For an audio model this is the output transcription. */
	line: string
	/** The ground-truth block it was holding, exactly as `renderState` produced it. */
	block: string
	/** The ten champions in this game, spelled as the client spells them. */
	roster: readonly string[]
	/**
	 * Every champion that exists — the vocabulary an invented name is drawn from.
	 *
	 * Passed in rather than hardcoded: the app already holds the client's own
	 * `championId -> name` map in `kv.championNames`, which is authoritative for the patch, and a
	 * list baked into source would silently miss every champion released after it was written.
	 */
	champions: readonly string[]
}

export interface Misattribution {
	value: number
	/** Who the line attached it to: a champion name, or `"you"` for the player. */
	claimedOwner: string
}

export interface LineScore {
	/**
	 * The line was a PASS, or empty: a deliberate silence.
	 *
	 * Silences are counted and then EXCLUDED from every rate. A model that passes on 90% of turns
	 * and fabricates on the rest would otherwise post a flattering per-turn fabrication rate while
	 * being wrong nearly every time it opened its mouth.
	 */
	silent: boolean
	faults: CoachFault[]
	inventedChampions: string[]
	unbackedNumbers: number[]
	misattributed: Misattribution[]
	/** The phrases that tripped `invented-movement`, so the call can be checked by eye. */
	movement: string[]
	/** The text every rule actually ran against, after number normalisation. */
	normalized: string
}

/* ================================================== numbers, spoken and written */

const UNITS: Record<string, number> = {
	zero: 0,
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12,
	thirteen: 13,
	fourteen: 14,
	fifteen: 15,
	sixteen: 16,
	seventeen: 17,
	eighteen: 18,
	nineteen: 19
}

const TENS: Record<string, number> = {
	twenty: 20,
	thirty: 30,
	forty: 40,
	fourty: 40,
	fifty: 50,
	sixty: 60,
	seventy: 70,
	eighty: 80,
	ninety: 90
}

/**
 * Turn spoken numerals into digits before anything else looks at the text.
 *
 * This is not a nicety, it is the difference between a fair benchmark and a rigged one. The Gemini
 * arm is a native-audio model read back through `outputAudioTranscription`, and a transcription
 * writes "seventeen hundred gold" where an HTTP text model writes "1700". A scorer that only
 * matched `\d+` would find *zero* unbacked numbers in the audio arm's word-numbers and report it
 * as the most grounded model in the run — a difference in transcription dressed up as a difference
 * in truthfulness.
 *
 * Two consecutive unit/teen words are SPLIT rather than summed ("fourteen twelve" -> `14 12`, not
 * 26), because no English number is formed that way and a spoken game clock is. "twenty three"
 * still merges, because that one is.
 *
 * Known limitation: "two point five k" is not handled. `2.5k` written in digits is.
 */
export const normalizeNumbers = (text: string): string => {
	// 1,180 -> 1180 first: a comma would otherwise split one figure into two.
	const decommaed = text.replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
	// 2.5k / 17k -> 2500 / 17000. Models write this; blocks never do.
	const dek = decommaed.replace(/\b(\d+(?:\.\d+)?)\s?k\b/gi, (_m, n: string) =>
		String(Math.round(Number(n) * 1000))
	)

	const out: string[] = []
	// Split keeping the separators, so spacing and punctuation survive for the offset-based rules.
	const parts = dek.split(/([A-Za-z]+)/)
	let acc = 0
	let scaleTotal = 0
	let pendingUnit = false
	let open = false
	let gap = ""

	const flush = () => {
		if (!open) return
		out.push(String(scaleTotal + acc))
		acc = 0
		scaleTotal = 0
		pendingUnit = false
		open = false
	}

	for (const part of parts) {
		if (part === "") continue
		if (!/^[A-Za-z]+$/.test(part)) {
			// Whitespace or a hyphen between two number words keeps the run open.
			if (open && /^[\s-]*$/.test(part)) {
				gap += part
				continue
			}
			flush()
			if (gap !== "") {
				out.push(gap)
				gap = ""
			}
			out.push(part)
			continue
		}
		const w = part.toLowerCase()
		if (open && w === "and") {
			gap += part
			continue
		}
		if (w in UNITS) {
			const v = UNITS[w]!
			if (pendingUnit) {
				// "fourteen twelve" is two numbers, not one. Splitting here is what keeps a spoken
				// game clock from being scored as an invented figure.
				const held = gap
				gap = ""
				flush()
				out.push(held)
			} else gap = "" // still inside one number: "twenty three" is 23, not "20 3"
			acc += v
			pendingUnit = true
			open = true
			continue
		}
		if (w in TENS) {
			if (pendingUnit) {
				const held = gap
				gap = ""
				flush()
				out.push(held)
			} else gap = ""
			acc += TENS[w]!
			pendingUnit = false
			open = true
			continue
		}
		if (w === "hundred" && open) {
			acc = (acc === 0 ? 1 : acc) * 100
			pendingUnit = false
			gap = ""
			continue
		}
		if (w === "thousand" && open) {
			scaleTotal += (acc === 0 ? 1 : acc) * 1000
			acc = 0
			pendingUnit = false
			gap = ""
			continue
		}
		flush()
		if (gap !== "") {
			out.push(gap)
			gap = ""
		}
		out.push(part)
	}
	flush()
	if (gap !== "") out.push(gap)
	return out.join("")
}

/** Every integer in `text`, after normalisation. Order preserved, duplicates kept. */
export const numbersIn = (text: string): number[] =>
	[...normalizeNumbers(text).matchAll(/\d+/g)].map(m => Number(m[0]))

/**
 * Every integer in the BLOCK. Digits only — the block is never normalised.
 *
 * `renderState` writes every figure as digits, so word-normalising it can only add numbers that
 * were never facts: the footer sentence "the ten champions above" would enter the backed set as
 * `10`, and 10 is a thoroughly plausible thing for a model to invent. The rule that a figure must
 * appear in the block is only worth anything if the backed set contains nothing but figures.
 */
const digitsIn = (text: string): number[] => [...text.matchAll(/\d+/g)].map(m => Number(m[0]))

/**
 * Below this, a figure is a count and not a claim.
 *
 * Levels, kill counts, "3 of them are dead" and the number of players alive are all single digits
 * that collide with each other constantly, and flagging them would bury the real fabrications in
 * noise. The cost is real and is stated rather than hidden: **this scorer under-counts
 * single-digit invention.** A level is the one exception — see `LEVEL_PREFIX`.
 */
export const MIN_SIGNIFICANT = 10

/** `level 9`, `lv9`, `lvl 9` — a single digit that IS a claim, so it escapes MIN_SIGNIFICANT. */
const LEVEL_PREFIX = /(?:\blevels?|\blvls?|\blv)[^A-Za-z0-9]{0,3}$/i

const isSignificant = (text: string, at: number, value: number): boolean =>
	value >= MIN_SIGNIFICANT || LEVEL_PREFIX.test(text.slice(Math.max(0, at - 12), at))

/* ========================================================== champion matching */

/**
 * Champion names that are also ordinary English words.
 *
 * These match ONLY when capitalised exactly as the champion is spelled, because "you got singed",
 * "keep your karma up" and "he'll trundle back" are English, not roster claims. The cost: a
 * transcript that lower-cases everything would hide an invented Trundle. That is the safe
 * direction to be wrong in — a false *accusation* of hallucination against the model the owner
 * already suspects is the one error this benchmark cannot afford.
 */
export const AMBIGUOUS_CHAMPIONS: readonly string[] = [
	"Aurora",
	"Bard",
	"Brand",
	"Briar",
	"Fizz",
	"Graves",
	"Jinx",
	"Karma",
	"Kindred",
	"Nautilus",
	"Nocturne",
	"Pantheon",
	"Poppy",
	"Quinn",
	"Riven",
	"Rumble",
	"Singed",
	"Smolder",
	"Swain",
	"Talon",
	"Thresh",
	"Trundle",
	"Twitch",
	"Vex",
	"Vi"
]

const ambiguous = new Set(AMBIGUOUS_CHAMPIONS.map(c => c.toLowerCase()))

/** Multi-word names whose first word is too generic to stand alone as a mention. */
const WEAK_FIRST_WORDS = new Set(["dr", "miss", "master", "twisted", "the", "lee", "xin"])

/**
 * The forms of a champion's name that count as naming him.
 *
 * "Kai'Sa" has to match "Kaisa" and "Kai Sa" because a transcription produces all three, and a
 * benchmark that misses an invented Kai'Sa because of an apostrophe is measuring punctuation.
 * "Nunu & Willump" also matches "Nunu", which is what anybody actually says.
 */
const aliasesOf = (name: string): string[] => {
	const words = name.split(/[^A-Za-z0-9]+/).filter(w => w !== "")
	if (words.length === 0) return []
	const out = [name]
	const first = words[0]!
	if (words.length > 1 && first.length >= 4 && !WEAK_FIRST_WORDS.has(first.toLowerCase()))
		out.push(first)
	return out
}

const patternFor = (alias: string): RegExp => {
	const runs = alias.split(/[^A-Za-z0-9]+/).filter(w => w !== "")
	const body = runs.map(r => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^A-Za-z0-9]{0,3}")
	// A two-letter name (Vi) or an English word (Trundle) must be capitalised to count.
	const strict = ambiguous.has(alias.toLowerCase()) || alias.length <= 2
	return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, strict ? "g" : "gi")
}

/** Where each named champion is mentioned in `text`. Sorted by position, one entry per hit. */
export const championMentions = (
	text: string,
	names: readonly string[]
): { name: string; index: number }[] => {
	const out: { name: string; index: number }[] = []
	for (const name of names)
		for (const alias of aliasesOf(name))
			for (const m of text.matchAll(patternFor(alias)))
				if (m.index !== undefined) out.push({ name, index: m.index })
	return out.sort((a, b) => a.index - b.index)
}

/** Champion names in `text` drawn from `vocabulary`. Used for both roster and invention checks. */
export const championsNamed = (text: string, vocabulary: readonly string[]): string[] => {
	const seen = new Set<string>()
	for (const { name } of championMentions(text, vocabulary)) seen.add(name)
	return [...seen]
}

/* ============================================================ block attribution */

export interface Segment {
	/** Canonical champion names on this segment, plus `"you"` when it is written about him. */
	owners: string[]
	values: Set<number>
}

const SELF = /(?<![A-Za-z])(you|your|yours|you're|youre)(?![A-Za-z])/i

/**
 * Cut the block into segments that each belong to somebody.
 *
 * The roster prints as `Champion lv7 2/1/4 · Champion lv6 …`, so a segment is a line, and a roster
 * line is split again on the interpunct — otherwise every champion would "own" every number on the
 * team line and `misattributed-number` could never fire.
 */
export const blockSegments = (block: string, roster: readonly string[]): Segment[] => {
	const segments: Segment[] = []
	for (const rawLine of block.split("\n"))
		for (const piece of rawLine.split(" · ")) {
			if (piece.trim() === "") continue
			const owners = championsNamed(piece, roster)
			if (SELF.test(piece)) owners.push("you")
			segments.push({ owners, values: new Set(digitsIn(piece)) })
		}
	return segments
}

/** Every integer anywhere in the block. A figure not in here was invented outright. */
export const blockNumbers = (block: string): Set<number> => new Set(digitsIn(block))

/**
 * The numbers in the "What he is NOT looking at" bullets, which are the facts the coach is told to
 * prefer.
 *
 * Pulled out separately because `visible-only` needs to know whether a line was carrying one:
 * "Renekton just died, gone for 19 seconds" is a screen readback if he watched it and real
 * coaching if the 19 came off the vetted list, and the only thing separating the two is whether
 * the number is in this section.
 */
export const unseenNumbers = (block: string): Set<number> => {
	const start = block.indexOf("### What he is NOT looking at")
	if (start === -1) return new Set()
	const rest = block.slice(start)
	const end = rest.indexOf("**The ten champions")
	return new Set(digitsIn(end === -1 ? rest : rest.slice(0, end)))
}

/* ============================================== movement and intent about others */

/**
 * Phrases that assert motion or intent. Each fires only when its SUBJECT is somebody other than
 * the player — see `subjectIsThirdParty`. "you're about to walk into them" is a warning built from
 * the frame; "he's about to invade" is a claim about a mind the model cannot read.
 */
const MOTION_INTENT: { label: string; re: RegExp }[] = [
	{
		label: "converging",
		re: /\b(converging|collapsing|closing in|rotating|regrouping|grouping up|grouping)\b/gi
	},
	{
		label: "coming",
		re: /\b(coming (?:for|to|at|toward|towards|through)|on (?:his|her|their|the) way)\b/gi
	},
	{
		label: "heading",
		re: /\b(head(?:ing|ed) (?:for|to|toward|towards|top|mid|bot|bottom|over)|pathing (?:to|toward|towards|into)|walking (?:to|toward|towards|into|up|down))\b/gi
	},
	{
		label: "about to",
		re: /\babout to (?:invade|gank|take|collapse|dive|jump|show|come|fight|contest|start|force|flank|rotate|group)\b/gi
	},
	{
		label: "going to",
		re: /\b(?:going to|gonna) (?:take|gank|invade|collapse|come|show|rotate|group|dive|fight|contest|push|start|force|flank|walk|move|catch|kill)\b/gi
	},
	{
		label: "intent",
		re: /\b(wants? (?:to|the|that|your|his|her|their)|looking to|trying to|planning to|setting up (?:for|to)|will (?:take|invade|gank|collapse|come|show|contest|force))\b/gi
	},
	{
		label: "invading",
		re: /\b(invading|counter-?jungling you|coming (?:into|in for) your)\b/gi
	}
]

const SELF_TOKEN = /(?<![A-Za-z])(you|your|yours|you're|youre|u)(?![A-Za-z])/gi
const THIRD_TOKEN =
	/(?<![A-Za-z])(he|she|they|him|her|them|his|their|they're|theyre|enemy|enemies|jungler|jgl)(?![A-Za-z])/gi

/**
 * Whose motion is being asserted, decided by the nearest subject to the LEFT of the phrase.
 *
 * Left only, and within 45 characters: "he is coming for your red" has "your" in it and is still a
 * claim about him, while "you're about to walk into them" has "them" in it and is still advice. An
 * imperative with no subject at all ("go take raptors") is not a claim about anybody and does not
 * fire.
 */
const subjectIsThirdParty = (text: string, at: number, roster: readonly string[]): boolean => {
	const window = text.slice(Math.max(0, at - 45), at)
	let self = -1
	for (const m of window.matchAll(SELF_TOKEN)) if (m.index !== undefined) self = m.index
	let third = -1
	for (const m of window.matchAll(THIRD_TOKEN)) if (m.index !== undefined) third = m.index
	for (const m of championMentions(window, roster)) third = Math.max(third, m.index)
	return third > self
}

/* ================================================= readback and named alternative */

/** On his HUD permanently, or something he watched happen two seconds before you said it. */
const READBACK: RegExp[] = [
	/\byou(?:'re| are)?\s+(?:at\s+)?\d+\s*(?:hp|health|mana)\b/i,
	/\byour\s+(?:level|health|hp|mana|kda|score|kills?|assists?)\b/i,
	/\byou(?:'re| are)\s+(?:level|lvl|lv)\s*\d+/i,
	/\byou(?:'re| are)\s+(?:clearing|farming|recalling|backing|full|at full|low|healthy|fine|safe)\b/i,
	/\byou\s+just\s+(?:killed|got|secured|took|hit|died|leveled|levelled)\b/i,
	/\b(?:nice|great|lovely|beautiful|good)\s+(?:kill|double|triple|quadra|penta|steal|catch|play|take|secure)\b/i,
	/\b(?:just\s+died|just\s+got\s+(?:killed|taken|caught)|went\s+down|just\s+fell|is\s+dead|are\s+dead|just\s+dropped)\b/i,
	/\b(?:tower|turret|inhibitor|inhib)\s+(?:just\s+)?(?:fell|went\s+down|is\s+down)\b/i
]

/**
 * Does the line name something to DO?
 *
 * Imperatives at a clause boundary, second-person modals, and a question back to him. Deliberately
 * generous: over-crediting a line with an action makes `no-alternative` look better than it is,
 * and `no-alternative` is the softest of the six rules — better to under-report a soft fault than
 * to over-report one.
 */
const ACTION: RegExp[] = [
	/(?:^|[.;,:!?—–-]\s*|\b(?:so|then|now|and|but)\s+)(?:take|go|back|recall|reset|clear|start|come|stay|hold|rotate|collapse|buy|spend|invade|walk|get|be|keep|leave|punish|trade|fight|contest|path|push|dive|group|check|watch|wait|use|finish|shove|drop|swing|head|track|force|play|move|ask|remember|stop|avoid|skip|ignore|retreat|disengage|kite|peel|poke|farm|gank|chase|shop|base|ward|commit|answer|match|mirror|itemi[sz]e|build|don't|dont|do not)\b/i,
	/\byou\s+(?:can|could|should|want to|need to|have time to|have a window|might want)\b/i,
	/\b(?:worth\s+(?:taking|going|contesting|forcing)|time to|window to|chance to|this is your (?:window|chance))\b/i,
	/*
	 * A softener in front of an imperative does not stop it being one. "just keep pathing", "maybe
	 * think about spending it", "simply take the camps" are all instructions, and were all scored
	 * as observations.
	 */
	/\b(?:just|maybe|simply|perhaps|really|honestly)\s+(?:\w+\s+)?(?:take|keep|clear|go|get|finish|farm|reset|back|stop|think about|look)\b/i,
	/*
	 * A verb wrapped in a coaching idiom is still an instruction, and the bare-imperative patterns
	 * above miss all of these. Measured against real socket output: "focus on finishing your full
	 * clears", "try kiting them next time", "let's get you clearing camps before the next one" —
	 * three of four flagged lines were false negatives, which would have sent me tuning the prompt
	 * against a fault it did not have. A scorer that UNDER-counts misleads exactly as badly as one
	 * that flatters.
	 */
	/\b(?:focus on|try|start|stick to|commit to|look to|aim to|let'?s (?:get|go|have)|prioriti[sz]e)\b/i,
	/\b\w+ing\s+(?:your|the|those|these|his|their)\b/i,
	/\?\s*$/
]

const namesAnAction = (text: string): boolean => ACTION.some(re => re.test(text))

/**
 * Praise, which is allowed to name no action.
 *
 * Measured: "You secured the Herald, great work!" was scored `no-alternative`, and it is not a
 * fault — the owner asked for "insights or encouragement", the prompt sanctions a warm line after
 * something he actually did, and telling him what to do next about a Herald he has already taken
 * would be worse writing, not better coaching.
 *
 * Deliberately NARROW so it cannot become a loophole. It requires a congratulatory phrase AND a
 * past-tense achievement, so "you should take Herald" is not praise and still needs an action. The
 * facts that produce praise are all anchored to a real event — a multikill, an objective he took,
 * a deficit he closed — so a model cannot reach this exemption by inventing something nice.
 */
const PRAISE = /\b(great|nice|lovely|beautiful|well done|good (work|job|stuff)|love (it|that)|excellent|perfect|brilliant|there we go|that'?s it|proud)\b/i
const DID_SOMETHING = /\b(you (secured|stole|took|got|caught|closed|pulled|landed|won)|just (got|secured|stole|took)|you'?re (ahead|up)\b)/i

const isPraise = (text: string): boolean => PRAISE.test(text) && DID_SOMETHING.test(text)

/* ============================================================== the entry point */

/**
 * A deliberate PASS and an empty reply are NOT the same thing, and conflating them corrupts the
 * one number this instrument exists to produce.
 *
 * A model that says "PASS" has judged the moment and declined. A model that returns nothing — or
 * returns only a reasoning block that upstream cleaning strips to nothing — has FAILED to answer,
 * and scoring that as a deliberate silence flatters exactly the models that leak their scratchpad.
 * Measured on the shipped cleaner: `<thinking>nothing urgent</thinking>` cleans to "" and was
 * counted as a considered pass.
 *
 * So they are separate outcomes. `silent` means he chose not to speak; `empty` means nothing came
 * back and it is a fault of the model, not a virtue.
 */
export const isEmpty = (line: string): boolean => line.replace(/[^A-Za-z]/g, "") === ""

const isSilent = (line: string): boolean =>
	line.replace(/[^A-Za-z]/g, "").toLowerCase() === "pass"

/**
 * A clause boundary, which the RIGHTWARD reach below may not cross.
 *
 * Measured on a real baseline run over split-03: *"Drake is back in 55 seconds — clear your camps
 * and prepare for it"* is the ranked fact said verbatim, and it was charged with fabrication,
 * because 55 has no owner to its left and the reach to its right found the "your" of a completely
 * different clause nineteen characters later. English does not attach a figure to a possessive in
 * the next clause, and a false fabrication flag is the most expensive kind this project can emit —
 * correctness was already at ceiling, so every point it loses is noise in the one column that had
 * none.
 *
 * LEFT reach is deliberately not restricted this way: *"Kayn is 1180 gold and level 9 to your 8"*
 * is one clause, and the sentence that established this rule must keep working.
 */
const CLAUSE_BREAK = /[—–,;:.!?]|\bso\b|\bthen\b/

/**
 * Who a figure belongs to in the spoken sentence: the nearest entity to its LEFT within 60
 * characters, or the nearest to its right within 25 if nothing precedes it and no clause boundary
 * sits between them.
 *
 * Left-biased because English attaches a number to the subject that came before it: in *"Kayn is
 * 1180 gold and level 9 to your 8"* the 1180 and the 9 belong to Kayn, and the 8 — which follows
 * "your" — belongs to him. Getting that one sentence right is the whole reason this rule exists.
 */
const ownerOf = (
	mentions: { owner: string; index: number }[],
	at: number,
	text = ""
): string | null => {
	let before: { owner: string; index: number } | null = null
	let after: { owner: string; index: number } | null = null
	for (const m of mentions) {
		if (m.index < at) before = m
		else if (after === null) after = m
	}
	if (before && at - before.index <= 60) return before.owner
	if (after && after.index - at <= 25 && !CLAUSE_BREAK.test(text.slice(at, after.index)))
		return after.owner
	return null
}

/**
 * The comparative shape, where the left-bias is exactly backwards.
 *
 * "You lead Briar 140 CS to 50" puts BOTH numbers to the right of both names, so the plain rule
 * gives 140 to Briar — the nearest name on its left — and the sentence is scored as a
 * misattribution when it is perfectly correct. Measured on a real ablation run: 5 of 94 lines
 * flagged, and all five were this, so the arm's true fabrication rate was 0 and the instrument
 * said otherwise. An instrument that cries wolf on the shape this coach uses most is worse than
 * no instrument, because the whole product decision rests on that rate.
 *
 * English orders a score pair to match the order the entities were named: the first figure belongs
 * to whoever was mentioned first. So when two figures are joined by "to" (or "against", or a dash)
 * and two different entities were named before them, split them in order.
 *
 * Deliberately narrow. It fires only with exactly two entities and a joined pair, because a rule
 * that guesses at three names is a rule that invents attributions of its own.
 */
const COMPARATIVE_PAIR = /(\d+)\s*(?:[A-Za-z]+\s+)?(?:to|against|[-–])\s*(\d+)/g

const comparativeOwners = (
	line: string,
	mentions: { owner: string; index: number }[]
): Map<number, string> => {
	const out = new Map<number, string>()
	for (const m of line.matchAll(COMPARATIVE_PAIR)) {
		const at = m.index
		const a = m[1]
		const b = m[2]
		if (at === undefined || a === undefined || b === undefined) continue
		const named = mentions.filter(x => x.index < at)
		const distinct: string[] = []
		for (const x of named) if (!distinct.includes(x.owner)) distinct.push(x.owner)
		if (distinct.length === 0) {
			// "With 190 CS to Briar's 70 CS" — nobody is named before the pair, so the first
			// figure is his and the possessive names the second.
			const owner = mentions.find(x => x.index > at && x.index < at + m[0].length + 4)
			if (owner === undefined) continue
			out.set(at + m[0].indexOf(a), "you")
			out.set(at + m[0].lastIndexOf(b), owner.owner)
			continue
		}
		if (distinct.length !== 2) continue
		const first = distinct[0]
		const second = distinct[1]
		if (first === undefined || second === undefined) continue
		out.set(at + m[0].indexOf(a), first)
		out.set(at + m[0].lastIndexOf(b), second)
	}
	return out
}

/**
 * Attribution that follows the CLAUSE, because the nearest noun is not the subject.
 *
 * The plain left-biased rule is right for "Kayn is 1180 gold" and wrong for every shape where the
 * figure belongs to the sentence subject rather than to the last noun before it. All three of
 * these are correctly-written lines from a real ablation run that the old rule called
 * misattributions:
 *
 *   "You killed Briar and have 1020 gold"      1020 is HIS; Briar is merely the nearer noun
 *   "With 190 CS to Briar's 70 CS, push mid"   190 has no owner before it at all
 *   "You lead Briar 140 CS to 50"              handled by `comparativeOwners`
 *
 * Together with the pair rule these were the entire misattribution count of the arm the product
 * decision rests on — reported 5, actually 0. So the order below matters more than it looks:
 *
 *   1. an explicit possessive binds ("Briar's 70");
 *   2. nothing named before it at all means it is HIS — the coach is talking to one person, and
 *      an unattributed figure in a sentence addressed to him is his;
 *   3. otherwise the nearest mention INSIDE the same clause;
 *   4. otherwise the sentence subject, which is the first thing the sentence named.
 *
 * Rule 4 is what fixes the compound predicate: "and have 1020 gold" is a clause with no noun in
 * it, so the subject carries over, exactly as it does in English.
 */
const CLAUSE_SPLIT = /,|;|—|–|\bso\b|\band\b|\bbut\b|\bwhile\b|\bthen\b/g

/**
 * Units that make a figure SOMEBODY'S. A timer belongs to the map and to nobody on it.
 *
 * This is the difference between "With 190 CS to Briar's 70" — where 190 is unmistakably his, and
 * saying so is the point — and "Drake is back in fifty-five seconds", where charging the 55 to
 * anyone at all is the instrument inventing an owner in order to find a fault. That exact line is
 * the shipped ranked fact, said verbatim, and it was being scored as a fabrication.
 */
const PLAYER_UNIT = /^\s*(?:cs|gold|kills?|deaths?|assists?|hp|health|level)\b/i

/**
 * The same doctrine as `PLAYER_UNIT`, from the other side: units that make a figure the MAP'S.
 *
 * `PLAYER_UNIT` is only consulted on the one branch where nothing was named before the figure, so
 * a timer in a sentence that happens to mention somebody got an owner anyway and was charged as a
 * misattribution. That was invisible while the block was a snapshot, because a snapshot states
 * almost no timers. The briefing states nothing else at the top — its whole first section is the
 * map's clock — and it made the instrument cry wolf on the arm under test.
 *
 * Measured on `data/eval/opus-briefing/ab-opus-frames.json`, claude-opus-5 over the 42 frame-bearing
 * states of game 5635467422: the briefing arm was scored at 13% fabrication and FOUR of its five
 * flags were this, every figure written verbatim in the block's own schedule —
 *
 *   "…dragon is 1 minute 39 seconds out"     block: "Dragon spawns at 5:00 — in 1 minute 39 seconds."
 *   "Briar is down and dragon spawns in 56 seconds"          block: "— in 56 seconds."
 *
 * Deliberately narrow: it fires only on an explicit time unit or a clock, so the sentences this
 * rule was built on are untouched. "Kayn is 1180 gold and level 9 to your 8" carries no time unit
 * and is still a misattribution; "You lead Briar 140 CS to 50" still goes through the comparative
 * rule.
 */
const MAP_UNIT = /^\s*(?:seconds?|secs?|s\b|minutes?|mins?)\b/i

/** `2:34`, `5:00` — a clock, whichever half of it the figure is. */
const CLOCK_BEFORE = /:$/
const CLOCK_AFTER = /^:\d/

/**
 * Does this figure belong to the map rather than to anybody standing on it?
 *
 * A timer, a spawn time or a clock. Nothing on the map's clock can be misattributed, because there
 * is no player to have taken it from.
 */
export const isMapFigure = (text: string, at: number, length: number): boolean => {
	const after = text.slice(at + length)
	const before = text.slice(Math.max(0, at - 2), at)
	return MAP_UNIT.test(after) || CLOCK_AFTER.test(after) || CLOCK_BEFORE.test(before)
}

const clauseOwner = (
	line: string,
	mentions: { owner: string; index: number }[],
	at: number
): string | null => {
	const before = mentions.filter(m => m.index < at)
	// 1. A possessive binds the figure that follows it.
	const possessive = before.at(-1)
	if (possessive !== undefined) {
		const between = line.slice(possessive.index, at)
		if (/^\S*['\u2019]s\s+\S{0,4}$/.test(between)) return possessive.owner
	}
	// Clause bounds: the figure may only look for an owner inside its own clause.
	let clauseStart = 0
	for (const m of line.matchAll(CLAUSE_SPLIT)) {
		if (m.index !== undefined && m.index < at) clauseStart = m.index + m[0].length
	}
	let clauseEnd = line.length
	for (const m of line.matchAll(CLAUSE_SPLIT)) {
		if (m.index !== undefined && m.index > at) {
			clauseEnd = m.index
			break
		}
	}
	// 2. A name AFTER the figure but inside the same clause still owns it: "88 CS for Kayn" hands
	//    88 to Kayn, and getting that wrong would make the rule a blanket amnesty.
	const forward = mentions.find(m => m.index > at && m.index < clauseEnd)
	if (before.length === 0 && forward !== undefined) return forward.owner
	// 3. Nobody named anywhere before it. If the figure carries a player's unit it is his, because
	//    the coach addresses one person; if it carries no unit it belongs to the map, and the
	//    honest answer is that it has no owner to be wrong about.
	if (before.length === 0)
		return PLAYER_UNIT.test(line.slice(at + String(line.slice(at).match(/^\d+/)?.[0] ?? "").length)) ?
				"you"
			:	null
	// 4. The nearest mention inside the same clause.
	const nearest = before.filter(m => m.index >= clauseStart).at(-1)
	if (nearest !== undefined) return nearest.owner
	// 5. No noun in this clause, so the subject carries over from the start of the sentence.
	return before[0]?.owner ?? null
}

/**
 * Score one line. Pure: same inputs, same verdict, forever.
 *
 * Order matters in one place only — a champion who is not on the roster is reported as
 * `invented-champion` and then IGNORED by the attribution rules, because "Gnar is 1180 gold" is
 * one fault (there is no Gnar), not two.
 */
export const scoreLine = (input: ScoreInput): LineScore => {
	const norm = normalizeNumbers(input.line)
	if (isSilent(input.line))
		return {
			silent: true,
			faults: [],
			inventedChampions: [],
			unbackedNumbers: [],
			misattributed: [],
			movement: [],
			normalized: norm
		}

	const rosterSet = new Set(input.roster.map(c => c.toLowerCase()))
	const faults: CoachFault[] = []

	/* -- invented champion -------------------------------------------------- */
	const invented = championsNamed(norm, input.champions).filter(c => !rosterSet.has(c.toLowerCase()))
	if (invented.length > 0) faults.push("invented-champion")

	/* -- numbers ------------------------------------------------------------ */
	const known = blockNumbers(input.block)
	const segments = blockSegments(input.block, input.roster)
	const mentions = championMentions(norm, input.roster).map(m => ({ owner: m.name, index: m.index }))
	for (const m of norm.matchAll(SELF_TOKEN))
		if (m.index !== undefined) mentions.push({ owner: "you", index: m.index })
	mentions.sort((a, b) => a.index - b.index)

	const comparative = comparativeOwners(norm, mentions)
	const unbacked: number[] = []
	const misattributed: Misattribution[] = []
	for (const m of norm.matchAll(/\d+/g)) {
		if (m.index === undefined) continue
		const value = Number(m[0])
		if (!isSignificant(norm, m.index, value)) continue
		if (!known.has(value)) {
			unbacked.push(value)
			continue
		}
		// The number is real. Did it end up on the right player?
		// A figure on the map's clock has no player to be taken from — see `isMapFigure`.
		if (isMapFigure(norm, m.index, m[0].length)) continue
		const owner = comparative.get(m.index) ?? clauseOwner(norm, mentions, m.index)
		if (owner === null) continue
		if (!segments.some(s => s.owners.includes(owner) && s.values.has(value)))
			misattributed.push({ value, claimedOwner: owner })
	}
	if (unbacked.length > 0) faults.push("unbacked-number")
	if (misattributed.length > 0) faults.push("misattributed-number")

	/* -- movement and intent ------------------------------------------------ */
	const movement: string[] = []
	for (const { re } of MOTION_INTENT)
		for (const m of norm.matchAll(re))
			if (m.index !== undefined && subjectIsThirdParty(norm, m.index, input.roster))
				movement.push(m[0])
	if (movement.length > 0) faults.push("invented-movement")

	/* -- the two weaknesses ------------------------------------------------- */
	const action = namesAnAction(norm)
	// Praise is exempt: a warm line about something he already did needs no instruction.
	if (!action && !isPraise(norm)) faults.push("no-alternative")

	const unseen = unseenNumbers(input.block)
	const carriesUnseenFact = numbersIn(norm).some(n => unseen.has(n))
	if (READBACK.some(re => re.test(norm)) && !carriesUnseenFact && !action) faults.push("visible-only")

	return {
		silent: false,
		faults,
		inventedChampions: invented,
		unbackedNumbers: unbacked,
		misattributed,
		movement,
		normalized: norm
	}
}

/* ==================================================================== statistics */

export interface Interval {
	/** k / n, or 0 when n is 0. */
	p: number
	lo: number
	hi: number
	k: number
	n: number
}

/**
 * Wilson score interval — the honest way to put an error bar on 3 failures out of 40.
 *
 * The normal approximation is useless at these rates: it produces negative lower bounds and a
 * zero-width interval at k=0. A benchmark whose whole purpose is "do not overstate a difference
 * between two small samples" cannot ship an interval that lies at exactly the sample sizes it will
 * be run at.
 */
export const wilson = (k: number, n: number, z = 1.96): Interval => {
	if (n <= 0) return { p: 0, lo: 0, hi: 1, k, n }
	const p = k / n
	const z2 = z * z
	const denom = 1 + z2 / n
	const centre = (p + z2 / (2 * n)) / denom
	const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
	return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), k, n }
}

/**
 * Do two rates separate at 95%?
 *
 * Non-overlapping Wilson intervals is a CONSERVATIVE test — stricter than a two-proportion z-test,
 * so it will call some real differences "not separated". That is the direction to be wrong in when
 * the output is a table somebody will screenshot.
 */
export const separated = (a: Interval, b: Interval): boolean => a.hi < b.lo || b.hi < a.lo
