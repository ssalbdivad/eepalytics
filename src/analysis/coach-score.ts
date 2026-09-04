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
	/(?:^|[.;,:!?—–-]\s*|\b(?:so|then|now|and|but)\s+)(?:take|go|back|recall|reset|clear|start|come|stay|hold|rotate|collapse|buy|spend|invade|walk|get|be|keep|leave|punish|trade|fight|contest|path|push|dive|group|check|watch|wait|use|finish|shove|drop|swing|head|track|force|play|move|ask|remember|stop|avoid|skip|ignore|don't|dont|do not)\b/i,
	/\byou\s+(?:can|could|should|want to|need to|have time to|have a window|might want)\b/i,
	/\b(?:worth\s+(?:taking|going|contesting|forcing)|time to|window to|chance to|this is your (?:window|chance))\b/i,
	/\?\s*$/
]

const namesAnAction = (text: string): boolean => ACTION.some(re => re.test(text))

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
 * Who a figure belongs to in the spoken sentence: the nearest entity to its LEFT within 60
 * characters, or the nearest to its right within 25 if nothing precedes it.
 *
 * Left-biased because English attaches a number to the subject that came before it: in *"Kayn is
 * 1180 gold and level 9 to your 8"* the 1180 and the 9 belong to Kayn, and the 8 — which follows
 * "your" — belongs to him. Getting that one sentence right is the whole reason this rule exists.
 */
const ownerOf = (mentions: { owner: string; index: number }[], at: number): string | null => {
	let before: { owner: string; index: number } | null = null
	let after: { owner: string; index: number } | null = null
	for (const m of mentions) {
		if (m.index < at) before = m
		else if (after === null) after = m
	}
	if (before && at - before.index <= 60) return before.owner
	if (after && after.index - at <= 25) return after.owner
	return null
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
		const owner = ownerOf(mentions, m.index)
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
	if (!action) faults.push("no-alternative")

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
