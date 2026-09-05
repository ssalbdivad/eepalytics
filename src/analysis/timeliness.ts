/**
 * Does the advice still apply by the time the sentence has finished being said?
 *
 * ## The axis nobody measured
 *
 * `analysis/coach-score.ts` scores a spoken line for FABRICATION and it has been at ceiling for
 * months. The transcript the owner finally quit on scored perfectly: every figure in all nine
 * lines was real. Correctness was never the defect. A line is useful iff it changes what he does,
 * for the better, at a moment when he can STILL ACT — and the last clause has never been checked
 * even once.
 *
 * It is not a small effect. A line is built from the state at T and arrives later:
 *
 *     t_end = T + provider latency + however long the sentence takes to say
 *
 * The socket is about a second behind; every turn-based provider is several, because the sentence
 * is written and paid for before its first syllable. And the sentence itself is not free — MEASURED
 * on real Gemini TTS renders of the coach's own shipped lines (n = 24, see `speechDurationSec`),
 * a coach line takes 2.1 to 7.5 seconds to say, median 3.9. So a line about a fight can
 * finish landing eight seconds after the fight it describes, and "two of them are dead, you have
 * about 12 seconds" can be false before the word "seconds".
 *
 * ## What this module is, and what it deliberately is not
 *
 * It is ARITHMETIC over the sample stream, so it is a pure function with unit tests and not a
 * judge call. Every fact the coach ships has a PREMISE that can be written down — a champion is
 * dead, a countdown has a value, a gap is N CS — and the sample recorded five seconds later says
 * whether that premise still holds. No model is asked for an opinion anywhere in here.
 *
 * It says nothing about whether a line was worth saying at all. Redundancy, genericness and
 * priority are three other axes with three other measurements. A line can be perfectly fresh and
 * completely useless, which is exactly what the quit transcript was.
 *
 * ## The four verdicts, because they have four different fixes
 *
 * - `number-moved`     the figure he was given is no longer the figure. Say fewer countdowns, or
 *                      say them with the latency already subtracted.
 * - `situation-over`   the premise ended: he respawned, the window closed, the objective was
 *                      taken. Only a faster path can fix this one.
 * - `impossible`       he cannot act on it — he is dead, he is outnumbered, or he already did it.
 *                      Worse than useless: it is an instruction he must ignore.
 * - `fresh`            still true, still actionable. State-shaped facts land here almost always,
 *                      and that is a real product finding rather than a null result: if the
 *                      durable facts survive a five-second pipe and the reactive ones do not, the
 *                      fast socket should carry the reactive lines and the slow providers should
 *                      only ever be given the durable ones.
 *
 * `unknown` is its own verdict and is never counted as fresh. A premise this file cannot parse, or
 * a t_end with no sample near it, is an unmeasured line — flattering it would repeat the mistake
 * that produced this module.
 */

/** What kind of claim a line makes, recovered from its own text. */
export type PremiseKind =
	| "window"
	| "jungler-down"
	| "objective-timer"
	| "objective-lost"
	| "fight"
	| "gold"
	| "race"
	| "farm-pace"
	| "levels"
	| "objective-count"
	| "kill-share"
	| "build"
	| "praise"
	| "my-death"
	| "unknown"

export type StaleKind = "fresh" | "number-moved" | "situation-over" | "impossible" | "unknown"

/**
 * The premise of a line, parsed out of the sentence the coach actually ships.
 *
 * Parsed from TEXT rather than carried as a field, deliberately. The thing that reaches the player
 * is a string — it goes into the prompt as a string, the model rephrases it, and a transcript is a
 * list of strings. A checker that needs the ranker's internal object cannot be pointed at a real
 * transcript, and a real transcript is the only place this failure has ever been seen.
 */
export type Premise =
	/** "3 of them are dead — you have about 22 seconds". `usable` is the dead-variant's own figure. */
	| { kind: "window"; count: number; seconds: number }
	/** "Briar is down 28 seconds — their camps are free" */
	| { kind: "jungler-down"; champion: string; seconds: number }
	/** "Drake is back in 40 seconds" / "Baron is up NOW" */
	| { kind: "objective-timer"; label: "Baron" | "Drake" | "Herald"; seconds: number }
	/** "they took Infernal drake" / "they have Baron ..." / "they have Herald ..." */
	| { kind: "objective-lost"; name: "BaronKill" | "HeraldKill" | "DragonKill" }
	/** "that fight was 0 for 3 without you" */
	| { kind: "fight"; won: number; lost: number }
	| { kind: "gold"; amount: number }
	/** Signed the way the coach says it: positive means the counterpart is ahead of him. */
	| { kind: "race"; champion: string; gap: number }
	/** Positive means he is down on his own pace. */
	| { kind: "farm-pace"; behind: number }
	/** `restraint` is the "don't take this" variant, which is only worth saying while an objective is live. */
	| { kind: "levels"; gap: number; restraint: boolean }
	| { kind: "objective-count"; mine: number; theirs: number }
	| { kind: "kill-share"; gapPct: number }
	| { kind: "build"; champion: string; item: string }
	| { kind: "praise" }
	| { kind: "my-death" }
	| { kind: "unknown" }

/** One line the coach said, with everything needed to work out when it finished being said. */
export interface SpokenLine {
	/** The sentence. */
	text: string
	/** The game clock of the state it was built from. */
	atSec: number
	/**
	 * Seconds between that state being read and the first syllable.
	 *
	 * A parameter rather than a constant because the two shapes differ by an order of magnitude —
	 * the Gemini socket is about a second, a turn-based provider is several — and the whole point
	 * of the measurement is to compare them.
	 */
	latencySec: number
	/**
	 * The real audio duration, when the transcript carries one.
	 *
	 * Preferred over the estimate whenever it exists: the socket returns PCM and its length is a
	 * fact, while `speechDurationSec` is a fit with about a third of a second of error.
	 */
	spokenSec?: number
}

/**
 * Everything a premise can be checked against.
 *
 * Structurally a subset of `analysis/live-facts.ts`'s `FactInput`, so a `FactInput` can be passed
 * straight in — but declared here rather than imported, because this file must not break when the
 * ranker's input grows a field, and because a transcript replay may only be able to fill some of
 * it. Everything optional is genuinely optional: a premise that cannot be checked returns
 * `unknown` rather than being assumed fresh.
 */
export interface CoachState {
	nowSec: number
	/** Seconds until HE is back up; null when he is alive. */
	meDeadForSec: number | null
	deadEnemies: { champion: string; respawnSec: number; isJungler?: boolean }[]
	currentGold: number | null
	pace: { cs: number; expected: number } | null
	counterpart: { champion: string; cs?: number; level?: number } | null
	meLevel?: number
	/** His own CS, when the replay has it without a baseline to build `pace` from. */
	myCs?: number
	objectiveCount?: { mine: number; theirs: number }
	enemyObjectives: { name: string; atSec: number }[]
	alliesAlive: number
	enemiesAlive: number
	drakeBackInSec: number | null
	baronBackInSec: number | null
	heraldBackInSec: number | null
	/** Game-clock times of every ChampionKill so far. Used only to notice a trade moving mid-sentence. */
	killSecs?: number[]
	/** Legendary items the counterpart has finished, by name. */
	counterpartItems?: string[]
}

export interface Staleness {
	stale: boolean
	kind: StaleKind
	premise: PremiseKind
	/** Concrete, with the numbers in it. Written to be pasted into a report. */
	why: string
	/** When the last syllable lands, in game-clock seconds. */
	endSec: number
	/** However long the sentence took, measured or estimated. */
	spokenSec: number
}

/**
 * How far a countdown may run down before the figure he heard has misled him.
 *
 * A JUDGEMENT, and flagged as one — unlike `situation-over` and `impossible`, which are binary
 * facts about the state. A quarter is the point at which "about twenty seconds" has become
 * "about fifteen", which is the difference between arriving at a camp and arriving at a respawn.
 * Exposed as an option so a report can show the sensitivity rather than hiding it.
 */
export const COUNTDOWN_DRIFT = 0.25

/**
 * How much CS must move before a gap he was told is a different gap.
 *
 * About one camp. Under that it is the noise of one slow clear, which is the same argument
 * `live-facts.ts` makes for not re-saying the farm gap at all.
 *
 * MEASURED WHILE BUILDING THIS, and it is worth knowing wherever CS is compared: the Live Client
 * Data API reports `creepScore` ROUNDED TO THE NEAREST TEN. Across all four recorded games in
 * `data/live-samples/`, every `creepScore` for every player — his own included — is a multiple of
 * ten, twenty-five distinct values and not one exception. So a gap can only move in steps of ten,
 * every CS figure the coach speaks carries about five CS of quantisation error, and a drift
 * threshold finer than ten cannot distinguish a real change from a rounding step. Five is
 * therefore "one quantum moved", which is the finest question the data can answer.
 */
export const CS_DRIFT = 5

/**
 * Gold below which the "go and spend" instruction has been carried out.
 *
 * `live-facts.ts` will not raise gold below 1200, so a purchase that takes him under it has
 * completed the advice. Between 1200 and the amount he was told, he has shopped but the line
 * still stands, so that is a moved number rather than a finished instruction. Current gold cannot
 * fall for any other reason — passive income only ever adds — so a drop is an exact signal and not
 * a threshold guess.
 */
export const GOLD_SPENT_FLOOR = 1200

/**
 * A window under this is not a window.
 *
 * Mirrors `WINDOW_MIN_SEC` in `live-facts.ts`, which is the rule that built the fact in the first
 * place. Copied rather than imported so that this file keeps measuring the same thing if the
 * ranker's own constant is tuned — a staleness figure that silently moves with a ranker change is
 * not a measurement.
 */
export const WINDOW_FLOOR_SEC = 10

/**
 * How long an enemy objective take is still coaching rather than history.
 *
 * The same two numbers `live-facts.ts` uses to decide whether to say it at all: 45 seconds for a
 * take, and three minutes for Baron because that is exactly how long the buff shapes the game.
 */
export const LOSS_WORTH_SAYING_SEC = 45
export const BARON_CLAIM_SEC = 180

/** How far from `t_end` a sample may be and still stand in for it. */
export const SAMPLE_TOLERANCE_SEC = 6

export interface StalenessOptions {
	countdownDrift?: number
	csDrift?: number
}

const ONES = [
	"zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
	"eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
	"nineteen"
]
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]

/**
 * A number as the words a voice actually says.
 *
 * Needed because syllables are counted from text and a digit is one character and up to a dozen
 * syllables: "1334 gold" is nine characters and "one thousand three hundred thirty four gold" is
 * eleven syllables. Estimating speech length from the raw string underestimates every gold line
 * the coach has.
 */
export const numberWords = (n: number): string => {
	if (n < 0) return `minus ${numberWords(-n)}`
	if (n < 20) return ONES[n]!
	if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? ` ${ONES[n % 10]!}` : "")
	if (n < 1000)
		return `${ONES[Math.floor(n / 100)]!} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ""}`
	if (n < 1_000_000)
		return `${numberWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberWords(n % 1000)}` : ""}`
	return `${numberWords(Math.floor(n / 1_000_000))} million${
		n % 1_000_000 ? ` ${numberWords(n % 1_000_000)}` : ""
	}`
}

/**
 * The text as it is spoken: digits become words, and an unpronounceable acronym becomes its letters.
 *
 * "CS" has no vowel, so a vowel-group syllable count scores it 1 when a voice says "see ess" — and
 * CS appears in most of the lines this coach ships. A run of capitals with no vowel in it is not a
 * word, and every acronym in the fact set (CS, HP) is exactly that shape, while "NOW" — which the
 * coach shouts in one line — keeps its vowel and stays a word.
 */
const spokenForm = (text: string): string =>
	text
		.replace(/\b[A-Z]{2,5}\b/g, m =>
			/[AEIOUY]/.test(m) ? m
			:	` ${[...m].map(c => (c === "W" ? "double you" : `${c.toLowerCase()}ee`)).join(" ")} `
		)
		.replace(/\d+/g, m => ` ${numberWords(Number(m))} `)

const syllablesInWord = (w: string): number => {
	const cleaned = w.replace(/'/g, "").replace(/e$/, "")
	const groups = cleaned.match(/[aeiouy]+/g)
	return Math.max(1, groups ? groups.length : 1)
}

/** Vowel-group syllable count over the spoken form. Exported because the fit below depends on it. */
export const syllablesOf = (text: string): number =>
	(spokenForm(text).toLowerCase().match(/[a-z']+/g) ?? []).reduce(
		(n, w) => n + syllablesInWord(w),
		0
	)

/**
 * Seconds of onset and offset around a spoken line, and seconds per syllable.
 *
 * MEASURED, not assumed, and the measurement is exact rather than a stopwatch: twenty-four of the
 * coach's own shipped sentences — twenty of the ranker's templates and four lines lifted from
 * the transcript he quit on — were rendered
 * through Gemini's `gemini-2.5-flash-preview-tts` at its default rate, and the returned PCM is
 * 16-bit mono at 24kHz, so `bytes / 2 / 24000` is the duration to the sample. Least squares of
 * duration against `syllablesOf`:
 *
 *     seconds = 1.18 + 0.189 x syllables       R2 0.895, mean absolute error 0.30s, n = 24
 *
 * which is 5.3 syllables per second plus about 1.2 seconds of lead-in and tail. The intercept is
 * real and it matters, because the shortest coach lines are only six syllables — a pure rate model
 * would say "they took Infernal drake" takes 1.1s when it measurably takes 2.2s. The measured
 * lines ran 2.09s ("Baron is up NOW") to 7.49s (the kill-participation line), median 3.93s.
 *
 * Three caveats worth carrying. This is Gemini's voice at its default rate, so a turn-based
 * provider spoken by the browser's `speechSynthesis` may differ and should be measured separately
 * before its number is quoted. TTS renders include their own leading and trailing silence, which
 * is wall-clock the player waits through and so belongs in the figure. And the worst residual is
 * a full second, so a single line's estimate is worth about +/- 1s — which is fine for a rate over
 * hundreds of lines and is not fine for adjudicating one of them.
 */
export const SPEECH_ONSET_SEC = 1.18
export const SPEECH_SEC_PER_SYLLABLE = 0.189

/** How long this sentence takes to say, in seconds. */
export const speechDurationSec = (text: string): number =>
	SPEECH_ONSET_SEC + SPEECH_SEC_PER_SYLLABLE * syllablesOf(text)

/** When the last syllable of a line lands, in game-clock seconds. */
export const endOfSec = (line: SpokenLine): number =>
	line.atSec + line.latencySec + (line.spokenSec ?? speechDurationSec(line.text))

/**
 * The premise of a coach line, recovered from the sentence.
 *
 * Every pattern is anchored at the start and tolerates a tail, because `withAdvice` appends a
 * champion clause after an em dash to most of these and the model rephrases the rest. A line that
 * matches nothing returns `unknown` and is reported as unmeasured.
 */
export const premiseOf = (text: string): Premise => {
	const t = text.trim()

	const window = /^(\d+) of them are dead\b[^.]*?you (?:have about (\d+) seconds|are up in \d+ seconds with about (\d+) seconds of window left)/.exec(t)
	if (window)
		return {
			kind: "window",
			count: Number(window[1]),
			seconds: Number(window[2] ?? window[3])
		}

	const down = /^(.+?) is down (\d+) seconds/.exec(t)
	if (down) return { kind: "jungler-down", champion: down[1]!, seconds: Number(down[2]) }

	const timer = /^(Baron|Drake|Herald) is (?:back in (\d+) seconds|up NOW)/.exec(t)
	if (timer)
		return {
			kind: "objective-timer",
			label: timer[1] as "Baron" | "Drake" | "Herald",
			seconds: timer[2] === undefined ? 0 : Number(timer[2])
		}

	/*
	 * The objective COUNT is tested before the dragon loss, because "they have taken 3 of the
	 * objectives" would otherwise be swallowed by a loose "they have/they took" pattern. Ordering
	 * a regex table is exactly the kind of silent breakage this repo has been bitten by, so the
	 * two are kept adjacent with this note between them.
	 */
	const countA = /^they have taken (\d+) of the objectives and you have taken none/.exec(t)
	if (countA) return { kind: "objective-count", mine: 0, theirs: Number(countA[1]) }
	const countB = /^objectives are (\d+) to (\d+) against you/.exec(t)
	if (countB) return { kind: "objective-count", mine: Number(countB[2]), theirs: Number(countB[1]) }

	if (/^they have Baron\b/.test(t)) return { kind: "objective-lost", name: "BaronKill" }
	if (/^they have Herald\b/.test(t)) return { kind: "objective-lost", name: "HeraldKill" }
	if (/^they took .+/.test(t)) return { kind: "objective-lost", name: "DragonKill" }

	const fight = /^that fight was (\d+) for (\d+)/.exec(t)
	if (fight) return { kind: "fight", won: Number(fight[1]), lost: Number(fight[2]) }

	const gold = /^(\d+) gold (?:sitting unspent|unspent for \d+ minutes now)/.exec(t)
	if (gold) return { kind: "gold", amount: Number(gold[1]) }

	// Before the race patterns: both end "... CS up on X", and "your own pace" is not a champion.
	const farm = /^you're (?:roughly )?(\d+) CS (down|up) on your own pace/.exec(t)
	if (farm) return { kind: "farm-pace", behind: farm[2] === "down" ? Number(farm[1]) : -Number(farm[1]) }

	const behind = /^(.+?) is (\d+) CS up on you/.exec(t)
	if (behind) return { kind: "race", champion: behind[1]!, gap: Number(behind[2]) }
	const ahead = /^you're (\d+) CS up on (.+?)(?:$|[,.—])/.exec(t)
	if (ahead) return { kind: "race", champion: ahead[2]!.trim(), gap: -Number(ahead[1]) }
	/*
	 * The two comeback lines are races too, and their premise is the gap RIGHT NOW rather than the
	 * swing — "you've pulled 12 CS back" is worthless the moment he is behind again by more than he
	 * clawed back. `gap` is what the line asserts the current gap to be, which for the crossed-over
	 * variant is at most zero.
	 */
	const pulled = /^you've pulled (\d+) CS back on (.+?)(?:$|[,.—])/.exec(t)
	if (pulled) return { kind: "race", champion: pulled[2]!.trim(), gap: 0 }
	const crossed = /^you were (\d+) CS down on (.+?) and you're ahead now/.exec(t)
	if (crossed) return { kind: "race", champion: crossed[2]!.trim(), gap: 0 }

	const levelsUp = /^(.+?) is (\d+) levels up on you/.exec(t)
	if (levelsUp) return { kind: "levels", gap: Number(levelsUp[2]), restraint: false }
	const levelsDown = /^you're (\d+) levels down on (.+?)(?:$|[,.—])/.exec(t)
	if (levelsDown) return { kind: "levels", gap: Number(levelsDown[1]), restraint: true }

	const kp = /^(.+?) is in (\d+) percent more of his team's kills/.exec(t)
	if (kp) return { kind: "kill-share", gapPct: Number(kp[2]) }

	const build = /^(.+?) just finished (.+?)(?:$|[.—])/.exec(t)
	if (build) return { kind: "build", champion: build[1]!, item: build[2]!.trim() }

	if (/^you (?:just got a |secured |stole )/.test(t)) return { kind: "praise" }

	return { kind: "unknown" }
}

const fresh = (premise: PremiseKind, why: string, endSec: number, spokenSec: number): Staleness => ({
	stale: false,
	kind: "fresh",
	premise,
	why,
	endSec,
	spokenSec
})

/**
 * Does the line's premise still hold when its last syllable lands?
 *
 * `stateAtT` is the state the line was built from and `stateAtEnd` is the real state nearest
 * `t_end` — from the sample stream, never reconstructed. Pass `null` for `stateAtEnd` when no
 * sample is close enough; the result is `unknown`, which is the honest answer and is never
 * counted as fresh.
 */
export const stalenessOf = (
	line: SpokenLine,
	stateAtT: CoachState,
	stateAtEnd: CoachState | null,
	opts: StalenessOptions = {}
): Staleness => {
	const spokenSec = line.spokenSec ?? speechDurationSec(line.text)
	const endSec = endOfSec(line)
	const drift = opts.countdownDrift ?? COUNTDOWN_DRIFT
	const csDrift = opts.csDrift ?? CS_DRIFT
	const elapsed = endSec - line.atSec

	/*
	 * A line whose text matches nothing, said while he is on the respawn screen, is the champion
	 * death note — the one fact whose text comes from `knowledge/champions/*.md` and therefore has
	 * no template to match. Recognised by the state rather than by the string, which is the only
	 * signal available and is the reason `stateAtT` is a parameter at all.
	 */
	const parsed = premiseOf(line.text)
	const p: Premise =
		parsed.kind === "unknown" && stateAtT.meDeadForSec !== null ? { kind: "my-death" } : parsed

	if (stateAtEnd === null)
		return {
			stale: false,
			kind: "unknown",
			premise: p.kind,
			why: `no sample within ${SAMPLE_TOLERANCE_SEC}s of t_end ${endSec.toFixed(1)}`,
			endSec,
			spokenSec
		}

	const gone = (why: string): Staleness => ({
		stale: true, kind: "situation-over", premise: p.kind, why, endSec, spokenSec
	})
	const moved = (why: string): Staleness => ({
		stale: true, kind: "number-moved", premise: p.kind, why, endSec, spokenSec
	})
	const blocked = (why: string): Staleness => ({
		stale: true, kind: "impossible", premise: p.kind, why, endSec, spokenSec
	})
	const unknown = (why: string): Staleness => ({
		stale: false, kind: "unknown", premise: p.kind, why, endSec, spokenSec
	})

	/**
	 * He was on the map when the line was built and on the respawn screen when it finished.
	 *
	 * Only applied to the lines whose entire content is "go and do this now". A farm gap heard
	 * while dead is merely badly timed; "their camps are free" heard while dead is an instruction
	 * he is physically unable to follow, which is the failure this verdict names.
	 */
	const diedMidSentence =
		stateAtT.meDeadForSec === null && stateAtEnd.meDeadForSec !== null

	switch (p.kind) {
		case "window": {
			if (stateAtEnd.enemiesAlive > stateAtEnd.alliesAlive + 1)
				return blocked(
					`he is outnumbered ${stateAtEnd.alliesAlive} to ${stateAtEnd.enemiesAlive} by the time it lands`
				)
			if (diedMidSentence) return blocked("he died while the sentence was being said")
			const open = stateAtEnd.deadEnemies.filter(d => d.respawnSec >= WINDOW_FLOOR_SEC)
			if (open.length < p.count)
				return gone(
					`told ${p.count} were down; ${open.length} still ${open.length === 1 ? "is" : "are"} at ${endSec.toFixed(0)}s`
				)
			const shortest = Math.min(...open.map(d => d.respawnSec))
			const usable = shortest - (stateAtEnd.meDeadForSec ?? 0)
			if (usable < WINDOW_FLOOR_SEC)
				return gone(`window is ${usable.toFixed(0)}s by the time he hears it, under the ${WINDOW_FLOOR_SEC}s floor`)
			if (p.seconds > 0 && (p.seconds - usable) / p.seconds > drift)
				return moved(`told about ${p.seconds}s of window, ${usable.toFixed(0)}s left when it lands`)
			return fresh(p.kind, `${open.length} still down with ${usable.toFixed(0)}s`, endSec, spokenSec)
		}

		case "jungler-down": {
			const still = stateAtEnd.deadEnemies.find(d => d.champion === p.champion)
			if (!still || still.respawnSec <= 0)
				return gone(`${p.champion} is back up at ${endSec.toFixed(0)}s`)
			if (diedMidSentence) return blocked("he died while the sentence was being said")
			if (still.respawnSec < WINDOW_FLOOR_SEC)
				return gone(`${p.champion} has ${still.respawnSec.toFixed(0)}s left, under the ${WINDOW_FLOOR_SEC}s floor`)
			if ((p.seconds - still.respawnSec) / p.seconds > drift)
				return moved(`told ${p.seconds}s, ${still.respawnSec.toFixed(0)}s left when it lands`)
			return fresh(p.kind, `${p.champion} still down ${still.respawnSec.toFixed(0)}s`, endSec, spokenSec)
		}

		case "objective-timer": {
			const now =
				p.label === "Baron" ? stateAtEnd.baronBackInSec
				: p.label === "Drake" ? stateAtEnd.drakeBackInSec
				: stateAtEnd.heraldBackInSec
			const takenMidSentence = stateAtEnd.enemyObjectives.some(
				e => e.atSec > line.atSec && e.atSec <= endSec && e.name.startsWith(p.label === "Drake" ? "Dragon" : p.label)
			)
			if (takenMidSentence)
				return gone(`${p.label} was taken between ${line.atSec.toFixed(0)}s and ${endSec.toFixed(0)}s`)
			if (now === null) return unknown(`no ${p.label} timer at t_end`)
			if (diedMidSentence) return blocked("he died while the sentence was being said")
			if (p.seconds === 0)
				return now <= 5 ?
						fresh(p.kind, `${p.label} still up`, endSec, spokenSec)
					:	moved(`told ${p.label} was up now; it is ${now.toFixed(0)}s away`)
			if ((p.seconds - now) / p.seconds > drift)
				return moved(`told ${p.seconds}s, ${now.toFixed(0)}s when it lands`)
			return fresh(p.kind, `${p.label} in ${now.toFixed(0)}s`, endSec, spokenSec)
		}

		case "objective-lost": {
			/*
			 * The take the line is about is the newest one of that kind at or before the state it
			 * was built from. Newest, because that is the one the ranker would have picked.
			 */
			const take = stateAtEnd.enemyObjectives
				.filter(e => e.name === p.name && e.atSec <= line.atSec)
				.sort((a, b) => b.atSec - a.atSec)[0]
			if (!take) return unknown(`no ${p.name} in the enemy takes at t_end`)
			const limit = p.name === "BaronKill" ? BARON_CLAIM_SEC : LOSS_WORTH_SAYING_SEC
			const age = endSec - take.atSec
			if (age > limit)
				return gone(`the take is ${age.toFixed(0)}s old when it lands, past the ${limit}s it is worth saying`)
			return fresh(p.kind, `${age.toFixed(0)}s old`, endSec, spokenSec)
		}

		case "fight": {
			if (diedMidSentence) return blocked("he died while the sentence was being said")
			const during = (stateAtEnd.killSecs ?? []).filter(s => s > line.atSec && s <= endSec)
			if (during.length > 0)
				return moved(
					`${during.length} more ${during.length === 1 ? "kill" : "kills"} landed while it was being said, so ${p.won} for ${p.lost} is out of date`
				)
			return fresh(p.kind, `no kill landed in the ${elapsed.toFixed(1)}s it took to say`, endSec, spokenSec)
		}

		case "gold": {
			if (stateAtEnd.currentGold === null) return unknown("no gold at t_end")
			const now = stateAtEnd.currentGold
			/*
			 * Current gold only ever falls on a purchase, so a drop is exact evidence he shopped —
			 * no threshold, no guess. Under the floor the ranker itself will not speak at, the
			 * instruction has been carried out.
			 */
			if (now < GOLD_SPENT_FLOOR)
				return blocked(`he spent it: ${Math.round(now)} gold when it lands, was told ${p.amount}`)
			if (now < p.amount) return moved(`spent some: ${Math.round(now)} gold against the ${p.amount} he was told`)
			return fresh(p.kind, `${Math.round(now)} gold still unspent`, endSec, spokenSec)
		}

		case "race": {
			const mine = stateAtEnd.myCs ?? stateAtEnd.pace?.cs
			const theirs = stateAtEnd.counterpart?.cs
			if (mine === undefined || theirs === undefined) return unknown("no CS on both sides at t_end")
			const gap = theirs - mine
			if (Math.abs(gap - p.gap) >= csDrift)
				return moved(`told a gap of ${p.gap} CS, it is ${gap} when it lands`)
			return fresh(p.kind, `gap ${gap} CS against the ${p.gap} he was told`, endSec, spokenSec)
		}

		case "farm-pace": {
			if (!stateAtEnd.pace) return unknown("no pace at t_end")
			const behind = stateAtEnd.pace.expected - stateAtEnd.pace.cs
			if (Math.abs(behind - p.behind) >= csDrift)
				return moved(`told ${p.behind} CS off his pace, it is ${Math.round(behind)} when it lands`)
			return fresh(p.kind, `${Math.round(behind)} CS off pace`, endSec, spokenSec)
		}

		case "levels": {
			const mine = stateAtEnd.meLevel
			const theirs = stateAtEnd.counterpart?.level
			if (mine === undefined || theirs === undefined) return unknown("no levels at t_end")
			const gap = theirs - mine
			if (gap !== p.gap) return moved(`told ${p.gap} levels, it is ${gap} when it lands`)
			/*
			 * The restraint variant is the one line in the set whose whole point is an objective
			 * being live. If the objective is taken or has drifted out of the window it was said
			 * for, "don't take this fight" is advice about a fight that is no longer on offer.
			 */
			if (p.restraint) {
				const live =
					(stateAtEnd.drakeBackInSec !== null && stateAtEnd.drakeBackInSec <= 45) ||
					(stateAtEnd.baronBackInSec !== null && stateAtEnd.baronBackInSec <= 45)
				if (!live) return gone("no objective is live when it lands, so the restraint is about nothing")
			}
			return fresh(p.kind, `${gap} levels`, endSec, spokenSec)
		}

		case "objective-count": {
			const c = stateAtEnd.objectiveCount
			if (!c) return unknown("no objective count at t_end")
			if (c.theirs !== p.theirs || c.mine !== p.mine)
				return moved(`told ${p.theirs} to ${p.mine}, it is ${c.theirs} to ${c.mine} when it lands`)
			return fresh(p.kind, `${c.theirs} to ${c.mine}`, endSec, spokenSec)
		}

		case "kill-share":
			/*
			 * Kill participation is a game-scale ratio over every kill so far. A single kill inside
			 * a five-second pipe cannot move it by the 25 points that earned the sentence, so it is
			 * fresh by construction — stated rather than computed, because pretending to check it
			 * would need shares this state does not carry.
			 */
			return fresh(p.kind, "a share over the whole game cannot move inside one sentence", endSec, spokenSec)

		case "build": {
			const items = stateAtEnd.counterpartItems
			if (!items) return unknown("no counterpart items at t_end")
			if (!items.includes(p.item)) return gone(`${p.item} is not in his items at t_end`)
			return fresh(p.kind, `${p.champion} still has ${p.item}`, endSec, spokenSec)
		}

		case "praise":
			// It happened. Nothing that arrives later can make it not have happened.
			return fresh(p.kind, "a thing he did stays done", endSec, spokenSec)

		case "my-death": {
			if (stateAtEnd.meDeadForSec === null)
				return gone(
					`he was back on the map ${(endSec - line.atSec).toFixed(1)}s later, and the note is for the respawn screen`
				)
			return fresh(p.kind, `still down ${stateAtEnd.meDeadForSec.toFixed(0)}s`, endSec, spokenSec)
		}

		case "unknown":
			return unknown("no premise could be parsed from the sentence")
	}
}

/**
 * The recorded state nearest a game-clock instant, or null when nothing is near enough.
 *
 * NEAREST rather than the last one at or before, because `t_end` falls between two samples roughly
 * always; taking the earlier one would bias every verdict towards fresh by up to a full sample.
 * Returning null past the tolerance is what keeps a gap in the recording from being scored as
 * "still true".
 *
 * THIS IS THE RESOLUTION LIMIT OF THE WHOLE MEASUREMENT, so it is worth stating plainly.
 * `daemon/live-sampler.ts` asks for a sample every five seconds and the recorded games actually
 * land 6.10s apart (median over all four splits, p95 6.14s), so a verdict is only accurate to
 * about +/- 3s of game clock. Two latencies that differ by less than that will often resolve to
 * the same sample and produce the same answer — measured, 0s and 1s of latency give an identical
 * verdict on all 66 lines. A latency comparison is only trustworthy across a gap bigger than the
 * sample spacing.
 */
export const stateAt = (
	states: CoachState[],
	sec: number,
	toleranceSec: number = SAMPLE_TOLERANCE_SEC
): CoachState | null => {
	let best: CoachState | null = null
	let bestGap = Number.POSITIVE_INFINITY
	for (const s of states) {
		const gap = Math.abs(s.nowSec - sec)
		if (gap < bestGap) {
			bestGap = gap
			best = s
		}
	}
	return bestGap <= toleranceSec ? best : null
}
