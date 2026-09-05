/**
 * Numbers written the way they are meant to be HEARD.
 *
 * ## Why this exists
 *
 * The live coach speaks. The facts `buildFacts` produces are the script — the model reads them
 * close to verbatim and a native-audio voice pronounces exactly what it is handed. So the shape of
 * a figure in a fact is not a formatting choice, it is a pronunciation choice, and it has been
 * wrong out loud in a real game: "52s" was spoken as "fifty two seds" and "1334g" as a letter.
 *
 * The first repair for that was a phonetic table rendered INTO the ground-truth block. The model
 * read the table aloud — "BRY-er is still at 0 CS", to the player, repeatedly — because the block
 * is content and everything in it is a fact that may be spoken. The lesson generalises, and this
 * module is the half of it that applies to numbers:
 *
 *   **an instruction about how to say something cannot live in the content. So do not instruct —
 *   write the content already said correctly.**
 *
 * A fact that reads `you have fifty-two seconds` cannot be mispronounced, because there is nothing
 * left to pronounce. This is the same fence `shared/champion-advice.ts` uses when it refuses any
 * clause containing a digit: a mechanism that cannot express the broken form cannot emit it.
 *
 * ## The failure that is invisible to every other instrument here
 *
 * Measured with `scripts/measure-speech.ts`, which keeps the AUDIO rather than the transcript. The
 * block said `1334 gold`. `models/gemini-3.1-flash-live-preview` spoke it as **"one hundred
 * thirty-four gold"** — a digit dropped out loud, a figure wrong by a factor of ten, from a block
 * that was exactly right. Two independent transcriptions of the same recording agree on it.
 * Google's own `outputAudioTranscription` wrote the line back as "You have 1334 gold to spend", so
 * `coach-score.ts` scored that turn as perfectly grounded.
 *
 * That is a FABRICATION the player hears and no text instrument in this repo can see. A figure
 * already written as words has no digits left to drop.
 *
 * ## And the honest size of it, because it is smaller than that paragraph sounds
 *
 * One utterance in two four-digit-gold utterances on that model. On
 * `gemini-2.5-flash-native-audio-preview-12-2025`, eleven audible utterances across both arms said
 * every figure correctly, in both digit and word form — spelling out changed nothing there. So the
 * defect is real, reproduced and model-specific, and n is small.
 *
 * ## The model will not keep your words if the number is big
 *
 * Also measured, same script: given `one thousand three hundred thirty-four gold` in the list, the
 * live model rewrote it back to "1334 gold" in its own sentence in three of four gold turns, while
 * keeping "fifty-two seconds", "twenty-three CS" and "four minutes" verbatim in four of four. A
 * spelled-out four-digit figure is therefore mostly a token cost; a spelled-out small one survives.
 * `sayGold` exists for completeness and is the one helper here NOT recommended for `buildFacts`.
 *
 * ## What this module deliberately does NOT decide
 *
 * It does not decide WHICH figures should be spelled out. That is a measurement, not a taste
 * question, and the measured answer is narrower than "all of them" — see `scripts/measure-speech.ts`
 * and the notes on each helper. Spelling out a figure has a real cost:
 *
 *   - `coach-score.ts` builds its backed-number set with `digitsIn`, which does NOT word-normalise
 *     the block ("the block is never normalised", and deliberately so). A block whose figures are
 *     words therefore backs NOTHING, and every number the coach correctly quotes scores as
 *     `unbacked-number`. Any call site switched to this module must be paired with a change there.
 *   - words are longer, and the prompt's central rule is "quote the number exactly as written".
 *     A long spelled-out figure is a figure with more places to drift.
 *
 * So: use it where the audio is measurably broken, not everywhere it would apply.
 *
 * ## Round-tripping is a hard requirement
 *
 * Every string this module produces must survive `normalizeNumbers` in `analysis/coach-score.ts`
 * back to the integer it started from. Otherwise the instrument that decides whether the coach
 * fabricated a number stops being able to read the coach's own script. That property is asserted
 * over every integer this app can plausibly say, not spot-checked.
 *
 * Browser-safe: pure functions over numbers.
 */

const ONES = [
	"zero",
	"one",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
	"nine",
	"ten",
	"eleven",
	"twelve",
	"thirteen",
	"fourteen",
	"fifteen",
	"sixteen",
	"seventeen",
	"eighteen",
	"nineteen"
] as const

const TENS = [
	"",
	"",
	"twenty",
	"thirty",
	"forty",
	"fifty",
	"sixty",
	"seventy",
	"eighty",
	"ninety"
] as const

const underThousand = (n: number): string => {
	if (n < 20) return ONES[n]!
	if (n < 100) {
		const t = TENS[Math.floor(n / 10)]!
		const r = n % 10
		// Hyphenated, as English writes it and as the scorer's normaliser expects: a hyphen between
		// two number words keeps one figure open instead of splitting it into two.
		return r === 0 ? t : `${t}-${ONES[r]!}`
	}
	const h = `${ONES[Math.floor(n / 100)]!} hundred`
	const r = n % 100
	return r === 0 ? h : `${h} ${underThousand(r)}`
}

/**
 * A whole number, in words.
 *
 * No "and" before the tens ("one thousand three hundred thirty-four", not "…and thirty-four").
 * Both are read aloud identically; only one of them is a single unbroken number to a parser, and
 * the parser is the thing that has to keep working.
 *
 * Negative and fractional inputs are rounded and their sign dropped — a fact never says "minus
 * four CS", it says who is up on whom, and silently swallowing a sign is safer here than emitting
 * a word the normaliser cannot read back.
 */
export const sayNumber = (value: number): string => {
	const n = Math.abs(Math.round(value))
	if (!Number.isFinite(n)) return "zero"
	if (n < 1000) return underThousand(n)
	if (n < 1_000_000) {
		const thousands = Math.floor(n / 1000)
		const rest = n % 1000
		const head = `${underThousand(thousands)} thousand`
		return rest === 0 ? head : `${head} ${underThousand(rest)}`
	}
	// Nothing in League reaches a million. Say it rather than throw: a coach that crashes on a
	// weird figure is worse than one that says a long number.
	const millions = Math.floor(n / 1_000_000)
	const rest = n % 1_000_000
	const head = `${underThousand(millions)} million`
	return rest === 0 ? head : `${head} ${sayNumber(rest)}`
}

/** `n` with the right singular or plural unit, e.g. `1 second` / `52 seconds`. */
const withUnit = (n: number, one: string, many: string): string =>
	`${sayNumber(n)} ${Math.abs(Math.round(n)) === 1 ? one : many}`

/**
 * A respawn or objective timer.
 *
 * THE measured failure. "52s" is spoken as "fifty two seds"; even written out as "52 seconds" the
 * digits are the part a coach reads back fastest and gets least wrong, so the win here is the
 * unit, and this helper exists so the unit can never be dropped by a future edit.
 *
 * Under two minutes it stays in seconds, because that is how a jungler counts a respawn — "a
 * minute and a half" is not a number he can subtract from.
 */
export const sayDuration = (seconds: number): string => {
	const s = Math.max(0, Math.round(seconds))
	if (s < 120) return withUnit(s, "second", "seconds")
	const mins = Math.floor(s / 60)
	const rest = s % 60
	return rest === 0 ?
			withUnit(mins, "minute", "minutes")
		:	`${withUnit(mins, "minute", "minutes")} ${withUnit(rest, "second", "seconds")}`
}

/**
 * Whole minutes, for "unspent for four minutes now".
 *
 * Separate from `sayDuration` because the call site has already decided the figure is coarse; a
 * duration that arrives as minutes must not be re-expanded into seconds it never measured.
 */
export const sayMinutes = (minutes: number): string => withUnit(minutes, "minute", "minutes")

/**
 * Gold.
 *
 * `1334g` was heard as a letter, which is what the unit word fixes. The DIGITS are a separate
 * question and this is the helper most likely to cost more than it buys: "one thousand three
 * hundred thirty-four gold" is nine syllables longer than the same fact in digits, inside a
 * sentence capped at 110 characters.
 *
 * **Measured, and it does not work.** Handed a spelled-out gold figure the live model rewrote it
 * back into digits in three of four turns, and the one audio capture of a spelled four-digit gold
 * figure came back "two thousand eight hundred seventy-four guilders". Do not wire this into
 * `buildFacts`; it is here because a caller with a small gold figure may still want it, and
 * because deleting it would lose the measurement that says not to.
 */
export const sayGold = (gold: number): string => `${sayNumber(gold)} gold`

/**
 * Creep score.
 *
 * "CS" is said as two letters by every League player alive, so the abbreviation is CORRECT here
 * and expanding it to "creep score" would be the mistake. Only the figure is spelled.
 */
export const sayCs = (cs: number): string => `${sayNumber(cs)} CS`

/** A champion level. `level eleven`, never `lv11`. */
export const sayLevel = (level: number): string => `level ${sayNumber(level)}`

/**
 * A game clock, as a caster says it.
 *
 * "14:32" is the one shape here that is genuinely ambiguous to read aloud — "fourteen thirty-two",
 * "fourteen colon thirty two", "fourteen thirty-second". The spoken form is the first one, and the
 * seconds are said as a pair rather than as a number: "fourteen oh five", not "fourteen five".
 *
 * `normalizeNumbers` splits two adjacent unit/teen words into two figures precisely so a spoken
 * clock does not sum into an invented one, so "fourteen thirty-two" reads back as `14 32` — the
 * same two integers the digits carry.
 */
export const sayClock = (seconds: number): string => {
	const s = Math.max(0, Math.round(seconds))
	const mins = Math.floor(s / 60)
	const rest = s % 60
	if (rest === 0) return `${sayNumber(mins)} minutes even`
	// "oh five" is how a single-digit seconds field is said out loud, and "zero five" is not.
	const tail = rest < 10 ? `oh ${sayNumber(rest)}` : sayNumber(rest)
	return `${sayNumber(mins)} ${tail}`
}

/**
 * Rewrite every bare digit run in a sentence into words.
 *
 * A blunt fallback for text this app did NOT compose — a model's own reply on the turn-based path,
 * where the number is already written before we see it. It is deliberately not used on facts:
 * facts should be built correct rather than repaired, because a repair pass cannot tell a gold
 * figure from a champion level and so cannot choose the right unit.
 *
 * Decimals and anything already attached to a letter are left alone: "2.5" and "Jarvan IV" are
 * both cases where a digit-by-digit rewrite makes the audio worse, not better.
 */
export const sayDigitsIn = (text: string): string =>
	text.replace(/\d+/g, (m, at: number) => {
		const before = text[at - 1] ?? ""
		const after = text[at + m.length] ?? ""
		if (before === "." || after === ".") return m
		if (/[A-Za-z]/.test(before) || /[A-Za-z]/.test(after)) return m
		return sayNumber(Number(m))
	})
