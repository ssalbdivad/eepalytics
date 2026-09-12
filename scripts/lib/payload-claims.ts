/**
 * THE PAYLOAD'S OWN FIGURES, PULLED BACK OUT AND CHECKED AGAINST THE SENTENCE — in code, with no
 * model anywhere in the file.
 *
 * ## Why a judge needs this beside it
 *
 * `judge-corpus.ts` asks a model whether a spoken line is true against the block the coach held.
 * Measured on the two stored runs of 2026-09-12, that judge caught **17% [12-24]** of one specific
 * error: 153 lines state how long somebody has ALREADY been dead, 71 of them contradict the
 * client's own kill log, and 132 of 135 spoke the payload's REMAINING figure as if it were the
 * elapsed one. The judge let almost all of them through, and the reason it did is not carelessness
 * — it is that the ACTION survives the inversion. "He's been down fifty seconds, start Baron" is
 * the right call whichever way the clock runs, so a judge grading whether the advice was any good
 * reads the sentence, agrees, and never looks at the digit.
 *
 * Telling it to be stricter is the wrong fix and would inflate every other verdict with it. A
 * figure that can be checked by subtraction should be checked by subtraction. So this file does
 * that, deterministically, and the judge's verdict and this file's verdict are reported side by
 * side rather than merged: two instruments that fail differently are worth more than one that
 * fails in a way nobody can see.
 *
 * ## A death has TWO clocks and they run opposite ways
 *
 * The Live Client Data API carries exactly one death figure, `respawnTimer`, which is what is LEFT.
 * `src/shared/live-brief.ts` now renders the elapsed half beside it — `down Ns` off the watched
 * kill log, `down at least Ns` off an alive->dead sample edge, `elapsed NOT KNOWN` when nobody
 * watched him go down. Neither figure can be turned into the other: respawn length grows with game
 * time and is a patch value this app refuses to hardcode.
 *
 * That gives three cases for an elapsed claim, and this file keeps them apart:
 *
 *   - the payload states an elapsed figure  -> the claim is SUPPORTED or CONTRADICTED, decidably;
 *   - it does not, and the claim matches the REMAINING figure -> UNSUPPORTED, flagged
 *     `matchesOtherClock`. That is the inversion's signature. It is deliberately NOT called
 *     contradicted: without an elapsed figure the record here cannot prove the number wrong, only
 *     show that the one number the payload did state was the opposite clock;
 *   - it does not, and the claim matches nothing -> UNSUPPORTED, and that is all this can say.
 *
 * ## What it does NOT do
 *
 * It has no opinion about advice, about whether a line was worth saying, or about anything a
 * picture would settle. It reads clocks and roster state. Everything else stays the judge's job.
 */

import { championMentions, normalizeNumbers } from "../../src/analysis/coach-score.ts"

/**
 * How far a spoken figure may sit from the payload's before it is called wrong, in seconds.
 *
 * Eight, which is what `scripts/adjudicate.ts` already uses for the same comparison against the
 * exact record. A coach rounds to the nearest ten ("thirty seconds" for 34), so anything under
 * five would convict him of rounding; anything over ten would wave through the inversion itself,
 * which on these runs averages far more than ten seconds of error.
 */
export const CLOCK_TOLERANCE_SEC = 8

/** One dead player as the payload states him, with both clocks and the provenance of the first. */
export interface DeadClock {
	champion: string
	/** Seconds he has ALREADY been dead, when the payload states it. */
	elapsedSec: number | null
	/** How the payload came by that figure: `down Ns` is watched, `down at least Ns` is bounded. */
	elapsedKind: "exact" | "at-least" | "not-stated"
	/** Seconds LEFT on his timer — the only death figure the client itself carries. */
	remainingSec: number | null
}

export interface PayloadFacts {
	/** Game clock of the block, in seconds, or null when the block does not state one. */
	clockSec: number | null
	/** Every champion the payload names as being in this game, spelled as the client spells them. */
	roster: string[]
	/** His own champion, and the enemy jungler, when the payload names them. */
	me: string | null
	counterpart: string | null
	/** Everybody the payload says is DOWN right now, with both clocks. */
	dead: DeadClock[]
}

const num = (s: string | undefined): number | null => {
	if (s === undefined) return null
	const n = Number(s)
	return Number.isFinite(n) ? n : null
}

/**
 * The elapsed half, from whichever of the three forms `live-brief.ts` rendered.
 *
 * A block written before that fix has no elapsed clause at all, and that is a fourth case rather
 * than a missing one: `not-stated` and `elapsed NOT KNOWN` mean the same thing to a checker and
 * are kept apart only so a reader of the output can tell an old run from a new one.
 */
const elapsedOf = (clause: string | undefined): { sec: number | null; kind: DeadClock["elapsedKind"] } => {
	if (clause === undefined || clause === "") return { sec: null, kind: "not-stated" }
	const atLeast = /(?:down at least (\d+)s|died at least (\d+)s ago)/.exec(clause)
	if (atLeast) return { sec: num(atLeast[1] ?? atLeast[2]), kind: "at-least" }
	const exact = /(?:down (\d+)s|died (\d+)s ago)/.exec(clause)
	if (exact) return { sec: num(exact[1] ?? exact[2]), kind: "exact" }
	return { sec: null, kind: "not-stated" }
}

/**
 * Every site in the payload that renders a death, and there are four shapes of them.
 *
 * They are listed rather than generalised because a regex loose enough to catch all four would
 * also catch the payload's own FOOTNOTES about death clocks, which name no player and state no
 * time about this game. The optional group is the elapsed clause: present on a block rendered
 * after the both-clocks fix, absent on every stored run before it.
 */
const DEAD_SITES: readonly RegExp[] = [
	// "Counterpart Kayn: DEAD, down 9s, back in 14s, lvl 6 — ..." and the NEXT block's bare "Kayn: DEAD, ..."
	/(?:^|\n|Counterpart )([A-Z][A-Za-z0-9'&.]*(?: [A-Z][A-Za-z0-9'&.]*)?): DEAD, (?:(down(?: at least)? \d+s|died(?: at least)? \d+s ago|elapsed NOT KNOWN|time since death NOT KNOWN), )?(?:back in|respawns in) (\d+)s/g,
	// "- Olaf (TOP, lvl 3) 2/1/0, 0 CS, ward score 0.0 DEAD, down 5s, respawns in 1s."
	/- ([A-Z][A-Za-z0-9'&.]*(?: [A-Z][A-Za-z0-9'&.]*)?) \([A-Z]+, lvl \d+\)[^\n]*? DEAD, (?:(down(?: at least)? \d+s|died(?: at least)? \d+s ago|elapsed NOT KNOWN|time since death NOT KNOWN), )?respawns in (\d+)s/g,
	// "- Viego — the enemy jungler — is DEAD, down 5s, back in 14s."
	/- ([A-Z][A-Za-z0-9'&.]*(?: [A-Z][A-Za-z0-9'&.]*)?) — the enemy jungler — is DEAD, (?:(down(?: at least)? \d+s|died(?: at least)? \d+s ago|elapsed NOT KNOWN|time since death NOT KNOWN), )?(?:back in|respawns in) (\d+)s/g,
	// "- Down right now (NOT you — you are ALIVE): Mordekaiser (ENEMY) down 5s, back in 1s, ..."
	/([A-Z][A-Za-z0-9'&.]*(?: [A-Z][A-Za-z0-9'&.]*)?) \((?:ENEMY|YOUR team)\) (?:(down(?: at least)? \d+s|died(?: at least)? \d+s ago|elapsed NOT KNOWN|time since death NOT KNOWN), )?(?:back in|respawns in) (\d+)s/g
]

const ROSTER_ROW = /- ([A-Z][A-Za-z0-9'&.]*(?: [A-Z][A-Za-z0-9'&.]*)?) \([A-Z]+, lvl \d+\)/g

/** Reads a rendered block back into the handful of facts a clock claim can be checked against. */
export const readPayload = (payload: string): PayloadFacts => {
	const roster = new Set<string>()
	for (const m of payload.matchAll(ROSTER_ROW)) roster.add(m[1]!)

	/*
	 * Two sources for each of the two junglers, because the SOCKET arm sends a short payload.
	 * `bench-stream`'s socket turns carry the NOW and NEXT sections only — 2.7KB against 8.5 — with
	 * the full roster sent once at setup instead. 47 of 59 socket turns in the stored run have no
	 * `YOU —` block at all, so a reader that only knew the long form would find a one-man roster
	 * and silently attribute nothing.
	 */
	const me =
		/\nYOU — ([A-Z][A-Za-z0-9'&.]*(?: [A-Z][A-Za-z0-9'&.]*)?),/.exec(payload)?.[1] ??
		/([A-Z][A-Za-z0-9'&.]*(?: [A-Z][A-Za-z0-9'&.]*)?) \((?:JUNGLE|TOP|MIDDLE|BOTTOM|UTILITY)\) lvl \d+/.exec(payload)?.[1] ??
		null
	const counterpart =
		/\nENEMY JUNGLER — ([A-Z][A-Za-z0-9'&.]*(?: [A-Z][A-Za-z0-9'&.]*)?),/.exec(payload)?.[1] ??
		/Counterpart ([A-Z][A-Za-z0-9'&.]*(?: [A-Z][A-Za-z0-9'&.]*)?): /.exec(payload)?.[1] ??
		null
	if (me) roster.add(me)
	if (counterpart) roster.add(counterpart)

	/*
	 * One entry per champion, and the FIRST site wins. The same death is rendered at up to four
	 * sites in one block and they agree by construction; taking the first keeps the map stable
	 * rather than letting site order decide, and a later site that disagreed would be a bug in the
	 * brief rather than something a checker should average away.
	 */
	const dead = new Map<string, DeadClock>()
	for (const re of DEAD_SITES)
		for (const m of payload.matchAll(re)) {
			const champion = m[1]!
			if (dead.has(champion)) continue
			const el = elapsedOf(m[2])
			dead.set(champion, {
				champion,
				elapsedSec: el.sec,
				elapsedKind: el.kind,
				remainingSec: num(m[3])
			})
			roster.add(champion)
		}

	const clock = /GAME CLOCK (\d+):(\d\d)/.exec(payload)
	return {
		clockSec: clock ? Number(clock[1]) * 60 + Number(clock[2]) : null,
		roster: [...roster],
		me,
		counterpart,
		dead: [...dead.values()]
	}
}

/**
 * The block of death clocks as the judge is shown them: verbatim figures, no verdict.
 *
 * The payload already carries every one of these, spread over four sites in six thousand
 * characters. Surfacing them next to the sentence is not new information and is deliberately not a
 * conclusion about the line — it is the same evidence at a distance the reader can actually use.
 */
export const deathClockBlock = (facts: PayloadFacts): string => {
	if (facts.dead.length === 0) return "DEATH CLOCKS: nobody in this payload is down right now."
	const rows = facts.dead.map(d => {
		const elapsed =
			d.elapsedSec === null ? "how long he has ALREADY been dead is NOT STATED in this payload"
			: d.elapsedKind === "at-least" ? `already dead AT LEAST ${d.elapsedSec}s`
			: `already dead ${d.elapsedSec}s`
		const left = d.remainingSec === null ? "time left not stated" : `${d.remainingSec}s LEFT before he is back`
		return `  ${d.champion}: ${elapsed}; ${left}.`
	})
	return [
		"DEATH CLOCKS IN THIS PAYLOAD. A death carries TWO figures and they run OPPOSITE ways:",
		"how long he has already been dead, and how long is left before he is back. Neither can be",
		"derived from the other. A sentence that states one of them is checkable against this list.",
		...rows
	].join("\n")
}

/**
 * HOW A DURATION IS FRAMED, which is a different question from which figure it carries.
 *
 * A number can be checked by subtraction; what the sentence MEANT by it cannot. "Viego is dead for
 * fourteen seconds" is a claim about the past to one listener and a fourteen-second window to
 * another, and `scripts/measure-deadclock-replay.ts` established on 93 stored lines that the coach
 * means the second: it pairs the figure with something to do NOW, every time, and 0 [0-4] of those
 * lines say "has been dead" or "died N seconds ago".
 *
 *   `past`   an unambiguous time-since-death — "has been dead for", "died N seconds ago";
 *   `window` an unambiguous remaining figure — "for another N", "N more seconds";
 *   `bare`   "dead for N seconds", which is neither, and is what the coach almost always says.
 *
 * A `bare` line carrying the REMAINING figure is not a wrong number. It is a right number in a
 * sentence a listener can read backwards, and that is a different defect with a different fix. It
 * lives here rather than in either instrument because BOTH of them convict a bare line, and two
 * copies of this regex would drift into two different headline rates.
 */
export type Framing = "past" | "window" | "bare"

const PAST_FRAMING = /\b(?:has|have|had|'s|s)\s+been\s+(?:dead|down|gone)\b|\bdied\b[^.]{0,24}\bago\b|\bfor the last\b|\balready been\b/i
const WINDOW_FRAMING = /\bfor\s+(?:another|the next)\b|\b(?:more|another)\s+seconds?\b|\bseconds?\s+(?:more|left|remaining)\b/i

export const framingOf = (answer: string): Framing =>
	PAST_FRAMING.test(answer) ? "past"
	: WINDOW_FRAMING.test(answer) ? "window"
	: "bare"

export type ClaimVerdict = "SUPPORTED" | "CONTRADICTED" | "UNSUPPORTED"

export interface ClockClaim {
	/** `dead.elapsed` or `dead.remaining` — which of the two clocks the figure was said about. */
	kind: "dead.elapsed" | "dead.remaining"
	/** The champion the clause attaches the figure to. */
	subject: string
	/** The clause the figure was read out of, verbatim from the normalised sentence. */
	clause: string
	saidSec: number | null
	verdict: ClaimVerdict
	/**
	 * The figure stated is within tolerance of the OTHER clock, and of nothing else. On an
	 * UNSUPPORTED elapsed claim this is the inversion's signature; it is reported rather than
	 * convicted on, because a payload that states no elapsed figure cannot prove one wrong.
	 */
	matchesOtherClock: boolean
	evidence: string
}

/**
 * A spoken figure and which clock it belongs to.
 *
 * "dead for another twenty seconds" is REMAINING, not elapsed, and the word that decides it is
 * `another`. Getting that one backwards would manufacture an inversion out of a correct sentence,
 * so the remaining forms are matched first and the elapsed form explicitly refuses `another`.
 */
const REMAINING_FORMS: readonly RegExp[] = [
	/\b(?:dead|down|gone)\s+for\s+another\s+(\d+)\s*(?:seconds?|secs?|s)\b/gi,
	/\b(?:back|up|respawns?|respawning|returns?)\s+(?:up\s+)?in\s+(?:about\s+|roughly\s+|over\s+|under\s+|another\s+)?(\d+)\s*(?:seconds?|secs?|s)\b/gi,
	/\b(\d+)\s*(?:seconds?|secs?|s)\s+(?:left|remaining|to go|until (?:he|she|they) (?:is|are) back)\b/gi,
	/\bfor\s+(?:the\s+next\s+)?(\d+)\s*(?:seconds?|secs?|s)\s+(?:more|longer)\b/gi
]

const ELAPSED_FORMS: readonly RegExp[] = [
	/\b(?:dead|down|gone)\s+(?:for|since)\s+(?!another\b)(?:over\s+|about\s+|nearly\s+|more than\s+|roughly\s+)?(\d+)\s*(?:seconds?|secs?|s)\b/gi,
	/\b(?:dead|down)\s+(\d+)\s*(?:seconds?|secs?|s)\s+(?:ago|already)\b/gi,
	/\b(\d+)\s*(?:seconds?|secs?|s)\s+(?:into|since)\s+(?:his|her|their)\s+death\b/gi,
	/\bhas been (?:dead|down)\s+(?:for\s+)?(\d+)\s*(?:seconds?|secs?|s)\b/gi
]

/** Clause boundaries, so a figure is attributed to the champion it was said next to. */
const CLAUSE_SPLIT = /[.;]|,\s|\s—\s|\s-\s|\bso\b|\bthen\b|\bwhile\b|\band\s+(?=[A-Z])/g

/** The clause of `text` containing offset `at`, as [start, end). */
const clauseAround = (text: string, at: number): [number, number] => {
	let start = 0
	let end = text.length
	for (const m of text.matchAll(CLAUSE_SPLIT)) {
		if (m.index === undefined) continue
		const cut = m.index + m[0].length
		if (m.index <= at) start = Math.max(start, cut)
		else {
			end = Math.min(end, m.index)
			break
		}
	}
	return [start, Math.max(start, end)]
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= CLOCK_TOLERANCE_SEC

/**
 * Check one spoken line's death-clock figures against the payload it was spoken beside.
 *
 * Returns one claim per (figure, subject) pair. A figure nobody can be attached to returns nothing
 * at all rather than a guessed subject — a mechanical check that guesses is worse than no check,
 * because its errors are invisible and look like arithmetic.
 */
export const clockClaims = (text: string, facts: PayloadFacts): ClockClaim[] => {
	const norm = normalizeNumbers(text)
	const mentions = championMentions(norm, facts.roster)
	if (mentions.length === 0) return []
	const deadBy = new Map(facts.dead.map(d => [d.champion, d]))

	const subjectsFor = (at: number): string[] => {
		const [s, e] = clauseAround(norm, at)
		const inClause = mentions.filter(m => m.index >= s && m.index < e).map(m => m.name)
		if (inClause.length > 0) return [...new Set(inClause)]
		// One champion in the whole sentence and no clause boundary between them: he is the subject.
		const all = [...new Set(mentions.map(m => m.name))]
		return all.length === 1 ? all : []
	}

	const claims: ClockClaim[] = []
	const seen = new Set<string>()

	const add = (which: "elapsed" | "remaining", at: number, said: number, matched: string): void => {
		for (const subject of subjectsFor(at)) {
			/*
			 * Keyed on WHERE THE DIGIT IS, not on where the phrase started. The two vocabularies
			 * below overlap on purpose — "has been dead for 12 seconds" satisfies two of the
			 * elapsed forms at two different offsets — and a key built from the phrase start would
			 * report one figure as two claims and double every rate it appears in.
			 */
			const key = `${which}:${subject}:${at}`
			if (seen.has(key)) continue
			seen.add(key)
			const [s, e] = clauseAround(norm, at)
			const clause = norm.slice(s, e).trim()
			const d = deadBy.get(subject)
			if (!d) {
				/*
				 * A death clock about somebody the payload does not have down. The roster check is
				 * what makes this decidable: every player's DEAD/alive state is in the block for
				 * all ten, so "he is dead" about a living player is contradicted outright.
				 */
				claims.push({
					kind: `dead.${which}` as ClockClaim["kind"],
					subject,
					clause,
					saidSec: said,
					verdict: "CONTRADICTED",
					matchesOtherClock: false,
					evidence: `the payload does not have ${subject} down at this instant — it states a death clock for ${facts.dead.length === 0 ? "nobody" : facts.dead.map(x => x.champion).join(", ")}`
				})
				continue
			}
			const own = which === "elapsed" ? d.elapsedSec : d.remainingSec
			const other = which === "elapsed" ? d.remainingSec : d.elapsedSec
			const fitsOwn = own !== null && (d.elapsedKind === "at-least" && which === "elapsed" ? said >= own - CLOCK_TOLERANCE_SEC : near(said, own))
			const fitsOther = other !== null && near(said, other)
			const both = `payload: ${subject} ${d.elapsedSec === null ? "elapsed NOT STATED" : `${d.elapsedKind === "at-least" ? "already dead at least " : "already dead "}${d.elapsedSec}s`}, ${d.remainingSec === null ? "time left not stated" : `${d.remainingSec}s left`}; said ${said}s ${which}`
			claims.push({
				kind: `dead.${which}` as ClockClaim["kind"],
				subject,
				clause,
				saidSec: said,
				verdict: fitsOwn ? "SUPPORTED" : own === null ? "UNSUPPORTED" : "CONTRADICTED",
				matchesOtherClock: !fitsOwn && fitsOther,
				evidence: `${both}${!fitsOwn && fitsOther ? " — which is the OTHER clock" : ""} (matched "${matched.trim()}")`
			})
		}
	}

	/** Where the figure itself sits, which is the only stable identity a matched phrase has. */
	const digitAt = (m: RegExpExecArray | RegExpMatchArray): number => m.index! + m[0].indexOf(m[1]!)

	const remainingAt = new Set<number>()
	for (const re of REMAINING_FORMS)
		for (const m of norm.matchAll(re)) {
			if (m.index === undefined || !m[1]) continue
			remainingAt.add(digitAt(m))
		}
	for (const re of REMAINING_FORMS)
		for (const m of norm.matchAll(re))
			if (m.index !== undefined && m[1]) add("remaining", digitAt(m), Number(m[1]), m[0])
	/*
	 * Remaining forms win the figures they claim. The two vocabularies genuinely overlap — "dead
	 * for another 20 seconds" satisfies both shapes — and scoring one figure on both clocks would
	 * report a correct sentence as its own contradiction.
	 */
	for (const re of ELAPSED_FORMS)
		for (const m of norm.matchAll(re)) {
			if (m.index === undefined || !m[1]) continue
			const at = digitAt(m)
			if (remainingAt.has(at)) continue
			add("elapsed", at, Number(m[1]), m[0])
		}

	return claims
}

/** The line-level reading of this file's claims: what it can prove, and what it can only flag. */
export const mechanicalVerdict = (
	claims: readonly ClockClaim[]
): "contradicted" | "inversion-shaped" | "supported" | "no-claim" => {
	if (claims.length === 0) return "no-claim"
	if (claims.some(c => c.verdict === "CONTRADICTED")) return "contradicted"
	if (claims.some(c => c.verdict === "UNSUPPORTED" && c.matchesOtherClock)) return "inversion-shaped"
	if (claims.some(c => c.verdict === "SUPPORTED")) return "supported"
	return "no-claim"
}
