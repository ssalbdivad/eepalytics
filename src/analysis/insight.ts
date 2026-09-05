/**
 * Does a spoken line carry INSIGHT, or is it a readout of the instant?
 *
 * ## Why this file exists
 *
 * The owner's verdict on the shipped coach, after six data bugs were fixed, after the fence was
 * replaced with cite-or-quiet, and after a model comparison: *"still garbage, no genuine insight"*.
 * Every instrument in this repo agreed the output was fine. `analysis/coach-score.ts` scores a line
 * for FABRICATION and found none — 0% on both models. The blind judge scored a line for
 * USEFULNESS and gave the winning model 83%. Both were right and both missed it, for the same
 * structural reason: **they score one line, alone, against the block it was holding.** A sentence
 * that is true, actionable and specific gets full marks on its thirtieth telling.
 *
 * So this scorer takes the whole session. It answers four questions, and only the first two are
 * new:
 *
 *   1. **Does the line need anything but this instant?** The ground-truth block is a snapshot — the
 *      clock, the roster, everyone's CS and level, his gold. A line whose whole premise is a value
 *      in that snapshot is a description of the instant, and the instant is what he is already
 *      looking at. This is the discriminator every earlier instrument missed.
 *   2. **Has he heard it already?** Not the same sentence — the same DIRECTIVE. Measured on
 *      `data/eval/model-opus5.json`, 17 of 38 spoken lines repeat at least half the content words
 *      of an earlier line in the same game, and 28 of 38 end on some rewording of *keep the route
 *      running*.
 *   3. **Does it name a decision he can act on in the next thirty seconds?**
 *   4. **Is the ACTION anchored to this game** — a champion, a camp, a pit, a place, a number — or
 *      would the instruction survive being pasted onto any other game he has ever played?
 *
 * ## What it is calibrated against, and where it will be wrong
 *
 * Two corpora, both real and both in the repo's own data directory: the 23 hand-written targets in
 * `data/eval/target-lines.md`, written from the raw samples and the journal frames of four of his
 * games, and the 76 lines Opus 5 produced over split-03 in `data/eval/model-opus5.json`. It is
 * tuned to separate those two and nothing else, so the honest statement of its range is:
 *
 *   - It is a LEXICAL instrument. It asks whether a line's premise is SHAPED like a span, a count,
 *     a schedule or a habit. It cannot check that the span is true — `coach-score.ts` does the
 *     fabrication half, and the two are meant to be read together, never summed.
 *   - `grounded` deliberately does not count the word "camp". 18 of 36 shipped lines contain it
 *     (measured in `shared/live-coach-mode.ts`) and "take your camps" is the generic jungle
 *     instruction that survives transplant into any game. A named camp — blue, gromp, raptors —
 *     does count. That single exclusion is doing a lot of work and it is the first thing to argue
 *     with.
 *   - A good line CAN fail `beyondInstant` honestly. Three of the 23 targets do: two because their
 *     depth comes from a PRIOR rather than from history ("a team that just took an uncontested
 *     objective is standing on it"), and one because it is praise, and praise is not information.
 *     The verdict therefore takes the score rather than gating on any single axis.
 *
 * A scorer that flatters us is worse than none, so the test pins BOTH directions: the targets must
 * mostly pass and the shipped corpus must mostly fail, and the separation is asserted as a number.
 */

import { normalizeNumbers } from "./coach-score.ts"

/* ================================================================= the four axes */

export interface AxisResult {
	pass: boolean
	/** The evidence, so a verdict can be argued with rather than trusted. */
	found: string[]
	why: string
}

export interface InsightScore {
	line: string
	/** PASS and empty lines are not scored — they are the correct answer on most turns. */
	spoke: boolean
	/** Does the premise need a span, a count, a schedule or a habit — something no snapshot holds? */
	beyondInstant: AxisResult
	/** Is it new, as a DIRECTIVE and not merely as a sentence? */
	fresh: AxisResult
	/** Does it end on something he can do in the next thirty seconds? */
	decides: AxisResult
	/** Is the ACTION half anchored to this game? */
	grounded: AxisResult
	/** 0–4. */
	score: number
	verdict: InsightVerdict
	/** Which kinds of non-snapshot context the line needed. The specification, derived per line. */
	needs: ContextNeed[]
	/** The clause the scorer treated as the action, for auditing `grounded` and `decides`. */
	action: string | null
}

/**
 * A line is only worth interrupting him for once.
 *
 * `repeat` is placed above everything because a repeated line is worthless however true and however
 * actionable it is — that is the whole finding this file was built on.
 */
export type InsightVerdict = "insight" | "readout" | "repeat" | "filler" | "silent"

/**
 * The kinds of context a line needed, named the same way `data/eval/target-lines.md` names them.
 *
 * This is the point of the instrument. A score says whether a line was shallow; the needs say what
 * would have to exist for the coach to be able to say it at all, and they add up across a session
 * into a specification for the briefing.
 */
export type ContextNeed =
	/** A trajectory of a client number over this game: a stall run, a hold duration, a rate. */
	| "H-series"
	/** A named event earlier in this game, beyond the rolling tail — or the ABSENCE of one. */
	| "H-event"
	/** When a neutral objective is next available: the last event of its kind plus a constant. */
	| "F-schedule"
	/** A state that is about to exist — a soul point, a fourth drake. */
	| "F-consequence"
	/** A comparison to his own previous games. */
	| "X-game"

/* ============================================================ the marker vocabulary */

/**
 * Markers that a claim spans TIME, grouped so the result can name what it needed.
 *
 * Deliberately NOT here: a bare past-tense verb. "Briar got first blood on Taliyah" refers to the
 * past and is still instant-derivable, because `renderState` prints a "Just happened" tail. Only a
 * span, a count, a stall, a schedule or a habit needs something the block does not have.
 *
 * Also deliberately not here: the progressive prose the shipped coach leans on — "while it keeps
 * running", "the longer it goes", "only gets faster". Those are time-flavoured and carry no claim
 * about this game at all, which is exactly why the same sentence fitted 28 different states.
 */
const MARKERS: { need: ContextNeed; label: string; re: RegExp }[] = [
	{ need: "H-series", label: "span", re: /\bsince\b/ },
	{ need: "H-series", label: "span", re: /\b(?:has|have|had|hasn't|haven't|hadn't) been\b/ },
	/*
	 * A bare "in 12 seconds" is a COUNTDOWN and the block prints his own on his own line, so `in`
	 * only counts with an explicit backward look. "for twenty seconds" and "inside three minutes"
	 * are elapsed and stay.
	 */
	{ need: "H-series", label: "span", re: /\b(?:for|over|inside|within) (?:the )?(?:last |past )?\d+ (?:second|minute)s?\b/ },
	{ need: "H-series", label: "span", re: /\bin the (?:last|past) \d+ (?:second|minute)s?\b/ },
	{ need: "H-series", label: "span", re: /\b\d+ (?:second|minute)s? ago\b/ },
	{ need: "H-series", label: "span", re: /\b(?:in|over|for|inside) the (?:last|past)\b/ },
	{ need: "H-series", label: "span", re: /\b\d+ (?:second|minute)s of\b/ },
	{ need: "H-series", label: "span", re: /\b(?:all game|the whole game|so far)\b/ },
	{ need: "H-series", label: "stall", re: /\b(?:has|have|had) not\b|\b(?:hasn't|haven't|hadn't)\b/ },
	// "still" only counts when it continues a MEASURED state. "the route's still hot" is a mood.
	{ need: "H-series", label: "stall", re: /\bstill (?:has|have|had|is|are|on|at|under|over|below|above|only|no|not|hasn't|haven't)\b/ },
	{ need: "H-series", label: "stall", re: /\b(?:not moved|unchanged|untouched|standing)\b/ },
	{ need: "H-event", label: "count", re: /\b(?:twice|again)\b/ },
	{ need: "H-event", label: "count", re: /\b\d+ times\b/ },
	/*
	 * "of them" is excluded and that exclusion is measured: "all five of them are alive" and "four
	 * of them are down thirty seconds" are ROSTER counts, straight off the instant. Only a tally
	 * against a possessed noun — "three of your five deaths" — needs a history.
	 */
	{ need: "H-event", label: "count", re: /\b\d+ of (?:your|his|her|their)\b/ },
	/* An objective's assisters are a roll-call of where the enemy team was. The block drops them. */
	{ need: "H-event", label: "roll-call", re: /\b(?:showed up for|were on|was on|were all on|all over)\b/ },
	{ need: "H-event", label: "count", re: /\b(?:every|both|each) time\b/ },
	{ need: "H-event", label: "count", re: /\b(?:second|third|fourth|fifth) (?:time|drake|dragon|one|kill|death)\b/ },
	/*
	 * Third person only. "You spawn in 12 seconds" is HIS respawn timer, which the block prints on
	 * his own line; "before it spawns" is a forecast about a camp the client never mentions. The
	 * bare verb caught both, and on the held-out gemini-3.6-flash corpus it was 2 of 5 false
	 * positives.
	 */
	{ need: "F-schedule", label: "schedule", re: /\b(?:spawns|respawns)\b/ },
	// "up at" needs a clock after it: "set up at your starting buff" is not a schedule.
	{ need: "F-schedule", label: "schedule", re: /\b(?:been up|up since|is due|comes? back|(?:up|back) at \d)\b/ },
	{ need: "F-schedule", label: "schedule", re: /\bnext (?:one|drake|dragon|baron|herald|grub|grubs|objective|pit)\b/ },
	{ need: "F-consequence", label: "forecast", re: /\bsoul\b/ },
	{ need: "X-game", label: "habit", re: /\b(?:your|the) last \d+ games?\b/ },
	{ need: "X-game", label: "habit", re: /\b\d+ games? running\b/ },
	{ need: "X-game", label: "habit", re: /\bgames? running\b/ },
	{ need: "X-game", label: "habit", re: /\b(?:you usually|every game|you always|of your last)\b/ }
]

/**
 * Nouns that could only have come from THIS game's state.
 *
 * "camp" and "camps" are not on this list and their absence is the load-bearing decision in the
 * whole file. A named camp is a place on the map he can click; "your camps" is the generic jungle
 * instruction, it fits every game ever played, and it is in half of the shipped lines.
 */
const PLACE_ANCHORS = [
	"drake",
	"dragon",
	"baron",
	"herald",
	"grub",
	"grubs",
	"scuttle",
	"gromp",
	"raptors",
	"krugs",
	"wolves",
	"blue",
	"red",
	"pit",
	"river",
	"topside",
	"botside",
	"top",
	"mid",
	"bot",
	"bottom",
	"tower",
	"turret",
	"inhibitor",
	"inhib",
	"base",
	"fountain",
	"recall",
	"soul"
]

/**
 * Verbs that open an instruction.
 *
 * The list is short on purpose: a clause that does not start with one of these is not something he
 * can execute, and "your speed only pays in transit" is an observation however true it is.
 */
const IMPERATIVES = [
	"take",
	"go",
	"walk",
	"back",
	"recall",
	"start",
	"leave",
	"stop",
	"finish",
	"buy",
	"spend",
	"clear",
	"ward",
	"path",
	"cross",
	"group",
	"get",
	"be",
	"wait",
	"hold",
	"push",
	"reset",
	"contest",
	"skip",
	"keep",
	"use",
	"follow",
	"turn",
	"stay",
	"sit",
	"run",
	"drop",
	"pick",
	"put",
	"save",
	"force",
	"look",
	"come",
	"give",
	"end"
]

/**
 * Words a clause may open on before the instruction starts.
 *
 * `split` leaves "so" and "then" at the head of the clause after a comma, and "full clear" is a
 * jungle verb whose first word is an adjective. Neither should hide an instruction from the axis.
 */
const CONNECTIVES = ["so", "then", "and", "but", "or", "instead"]
const LEADING_FILLER = [...CONNECTIVES, "now", "just", "full", "please", "maybe"]

/** Openings that negate rather than command, and are still a decision. */
const NEGATIVE_IMPERATIVES = ["don't", "dont", "do not", "never", "no"]

/** Words that carry no subject and so cannot make one line differ from another. */
const STOPWORDS = new Set(
	`a an and are as at be been before but by can cant cannot could did do does doing dont for from
	 get go got had has have he her here him his how i if in into is it its just like me more most
	 my no not now of off on once only or other our out over own re s so some still such t than
	 that the their them then there these they this those through to too up us very was we were
	 what when where which while who why will with would you your youre yours`
		.split(/\s+/)
		.filter(Boolean)
)

/* ================================================================== the thresholds */

/**
 * Content-word overlap above which two lines are the same line.
 *
 * Half. Measured on the shipped corpus: at 0.5, 17 of 38 lines in one arm are flagged as restating
 * an earlier one, which matches the count the ablation's own judge arrived at by reading them.
 * Lower and paraphrases of different facts collide; higher and "keep the route running to the next
 * camp" stops matching "keep the route rolling straight into the next camp", which is the failure
 * this axis exists for.
 */
export const REPEAT_SIMILARITY = 0.5

/**
 * How many spoken lines must pass before the same DIRECTIVE may be given again.
 *
 * A jungle instruction takes ten to thirty seconds to carry out (`shared/live-coach-mode.ts`), so
 * repeating one before he has finished the first does not reinforce it, it cancels it. Three lines
 * at the shipped 45-second floor is a little over two minutes.
 */
export const DIRECTIVE_WINDOW = 3

/** However far apart they are, a directive said this many times in one game is a nag. */
export const DIRECTIVE_BUDGET = 3

/* ======================================================================= the scorer */

export interface InsightInput {
	line: string
	/** The ten champions in this game, so a name counts as an anchor only when it is real. */
	champions: readonly string[]
	/** Everything already SPOKEN this game, oldest first. PASSes are not included. */
	earlier: readonly string[]
}

const clean = (line: string): string =>
	normalizeNumbers(line)
		.toLowerCase()
		.replace(/[’']/g, "'")
		.replace(/[—–]/g, " — ")

const words = (text: string): string[] => text.split(/[^a-z0-9']+/).filter(Boolean)

const contentWords = (text: string): Set<string> =>
	new Set(words(text).filter(w => !STOPWORDS.has(w.replace(/'s$/, "")) && !/^\d+$/.test(w)))

const jaccard = (a: Set<string>, b: Set<string>): number => {
	if (a.size === 0 || b.size === 0) return 0
	let shared = 0
	for (const w of a) if (b.has(w)) shared++
	return shared / (a.size + b.size - shared)
}

/** True when the line says nothing — a PASS, or blank. */
export const isSilent = (line: string): boolean => {
	const t = line.trim()
	return t === "" || /^pass\b/i.test(t)
}

/*
 * Where one clause ends and the next begins.
 *
 * Splitting on the dash and the comma is what stops `grounded` from being satisfied by an anchor
 * that lives in the PREMISE. "Briar's at least 21 CS behind you — keep the route running" has a
 * champion and a number in it, and the instruction still fits any game; the whole point of the axis
 * is that the anchor has to be in the half he is meant to act on.
 */
const CLAUSE_BREAK = /\s+—\s+|\s*[,;:.]\s+|\s+so\s+|\s+then\s+|\s+but\s+|\s+while\s+/

const clauses = (text: string): string[] =>
	text
		.split(CLAUSE_BREAK)
		.map(c => c.trim())
		.filter(Boolean)

/**
 * The clause he is meant to act on: the first one that opens on an instruction.
 *
 * FIRST rather than last, because a line often stacks two instructions ("recall, buy, and be at
 * that pit") and the first is the one that has to be anchored — an unanchored opener followed by an
 * anchored afterthought is exactly the padding this axis exists to catch.
 */
const actionClause = (text: string): string | null => {
	for (const c of clauses(text)) {
		const ws = words(c).filter((w, i) => !(i === 0 && LEADING_FILLER.includes(w)))
		if (ws.length === 0) continue
		// The first TWO tokens, because "full clear your blue" and "so go take his raptors" are both
		// instructions and neither opens on the verb.
		for (const head of ws.slice(0, 2)) {
			if (IMPERATIVES.includes(head) || NEGATIVE_IMPERATIVES.includes(head)) return tidy(c)
		}
		if (ws[0] === "do" && ws[1] === "not") return tidy(c)
	}
	return null
}

/** The clause as it should be quoted back: connective and terminal punctuation trimmed. */
const tidy = (clause: string): string =>
	clause.replace(new RegExp(`^(?:${CONNECTIVES.join("|")})\\s+`), "").replace(/[.!?]+$/, "").trim()

/**
 * The DIRECTIVE, stripped of everything that varies between turns.
 *
 * Numbers and champion names come out because they are what makes thirty identical instructions
 * look like thirty different lines. What is left — "keep route running", "take blue" — is what he
 * actually hears twice.
 */
const directiveKey = (action: string, champions: readonly string[]): string => {
	const lowerChamps = new Set(champions.map(c => c.toLowerCase()))
	const ws = words(action).filter(w => !/^\d+$/.test(w) && !lowerChamps.has(w.replace(/'s$/, "")))
	const head = ws[0] ?? ""
	const rest = ws.slice(1).filter(w => !STOPWORDS.has(w.replace(/'s$/, "")))
	return [head, ...rest.slice(0, 2)].join(" ")
}

const anchorsIn = (text: string, champions: readonly string[]): string[] => {
	const found: string[] = []
	const lowerChamps = champions.map(c => c.toLowerCase())
	for (const w of words(text)) {
		const bare = w.replace(/'s$/, "")
		if (/^\d+$/.test(bare)) found.push(bare)
		else if (lowerChamps.includes(bare)) found.push(bare)
		else if (PLACE_ANCHORS.includes(bare)) found.push(bare)
	}
	return [...new Set(found)]
}

/** Score ONE line against what was already said. Prefer `scoreSession` — it folds `earlier` for you. */
export const scoreInsight = (input: InsightInput): InsightScore => {
	const { line, champions, earlier } = input
	if (isSilent(line)) {
		const none: AxisResult = { pass: false, found: [], why: "said nothing" }
		return {
			line,
			spoke: false,
			beyondInstant: none,
			fresh: none,
			decides: none,
			grounded: none,
			score: 0,
			verdict: "silent",
			needs: [],
			action: null
		}
	}

	const text = clean(line)

	/* --- 1. beyond the instant ------------------------------------------------------------- */
	const hits = MARKERS.filter(m => m.re.test(text))
	const needs = [...new Set(hits.map(h => h.need))]
	const anchors = anchorsIn(text, champions)
	const beyondInstant: AxisResult = {
		// A marker with nothing attached to it is the shipped coach's own trick: "while it keeps
		// running" is time-shaped prose about the champion, not a claim about this game.
		pass: hits.length > 0 && anchors.length > 0,
		found: hits.map(h => h.label),
		why:
			hits.length === 0 ?
				"every claim in it is a value in the current block — a readout of the instant"
			: anchors.length === 0 ? "time-shaped, but attached to no fact in this game"
			: `premise needs ${needs.join(", ")}`
	}

	/* --- 2. fresh -------------------------------------------------------------------------- */
	const mine = contentWords(text)
	let worst = 0
	let repeatOf = -1
	earlier.forEach((prev, i) => {
		const sim = jaccard(mine, contentWords(clean(prev)))
		if (sim > worst) {
			worst = sim
			repeatOf = i
		}
	})
	const action = actionClause(text)
	const key = action ? directiveKey(action, champions) : ""
	const earlierKeys = earlier
		.map(p => {
			const a = actionClause(clean(p))
			return a ? directiveKey(a, champions) : ""
		})
		.filter(Boolean)
	const usedTotal = key === "" ? 0 : earlierKeys.filter(k => k === key).length
	const usedRecently = key === "" ? 0 : earlierKeys.slice(-DIRECTIVE_WINDOW).filter(k => k === key).length
	const sentenceRepeat = worst >= REPEAT_SIMILARITY
	const directiveRepeat = usedRecently > 0 || usedTotal >= DIRECTIVE_BUDGET
	const fresh: AxisResult = {
		pass: !sentenceRepeat && !directiveRepeat,
		found: [
			...(sentenceRepeat ? [`restates line ${repeatOf + 1} (${worst.toFixed(2)} overlap)`] : []),
			...(directiveRepeat ? [`directive "${key}" already given ${usedTotal} times`] : [])
		],
		why:
			sentenceRepeat ? `he has heard this sentence: ${worst.toFixed(2)} content overlap with an earlier line`
			: directiveRepeat ? `he has been told "${key}" ${usedTotal} times already`
			: "new"
	}

	/* --- 3. decides ------------------------------------------------------------------------ */
	const decides: AxisResult = {
		pass: action !== null,
		found: action ? [action] : [],
		why: action ? "names an action" : 'no clause opens on an instruction — it could be followed by "…so what?"'
	}

	/* --- 4. grounded ----------------------------------------------------------------------- */
	const actionAnchors = action ? anchorsIn(action, champions) : []
	const grounded: AxisResult = {
		pass: actionAnchors.length > 0,
		found: actionAnchors,
		why:
			action === null ? "no action to anchor"
			: actionAnchors.length === 0 ?
				"the instruction names nothing from this game — it would read identically in any other"
			:	`instruction anchored to ${actionAnchors.join(", ")}`
	}

	const score = [beyondInstant, fresh, decides, grounded].filter(a => a.pass).length
	/*
	 * `insight` requires ALL FOUR, and three of the 23 hand-written targets fall short of it on
	 * purpose. Two of them are good lines whose depth comes from a PRIOR rather than from history
	 * ("a team that just took an uncontested objective is standing on it") and one is praise, which
	 * is not information and does not need to be. Relaxing the rule to three-of-four to admit them
	 * also admits "the Prance stacks decay the moment the route stops" and "go straight into the
	 * next camp", which are the exact lines this instrument exists to reject — so the boundary is
	 * drawn here and the three targets are reported honestly as readouts.
	 */
	const verdict: InsightVerdict =
		!fresh.pass ? "repeat"
		: score === 4 ? "insight"
		: !decides.pass ? "filler"
		: "readout"

	return { line, spoke: true, beyondInstant, fresh, decides, grounded, score, verdict, needs, action }
}

/**
 * Score a whole session in order, which is the only way axis 2 means anything.
 *
 * `earlier` is folded here rather than left to the caller because every judge this repo has built
 * so far scored lines independently and was therefore structurally unable to see the repetition
 * that is 45–51% of the shipped output.
 */
export const scoreSession = (
	lines: readonly string[],
	champions: readonly string[]
): InsightScore[] => {
	const spoken: string[] = []
	const out: InsightScore[] = []
	for (const line of lines) {
		const s = scoreInsight({ line, champions, earlier: spoken })
		out.push(s)
		if (s.spoke) spoken.push(line)
	}
	return out
}

export interface SessionSummary {
	turns: number
	spoke: number
	insight: number
	readout: number
	repeat: number
	filler: number
	/** Mean score over SPOKEN lines only — a silence is not a bad line. */
	meanScore: number
	/** Share of spoken lines that reached `insight`. */
	insightRate: number
	/** Every kind of context the session's good lines needed, most-wanted first. */
	needs: { need: ContextNeed; lines: number }[]
}

export const summarise = (scores: readonly InsightScore[]): SessionSummary => {
	const spoken = scores.filter(s => s.spoke)
	const count = (v: InsightVerdict) => scores.filter(s => s.verdict === v).length
	const needCounts = new Map<ContextNeed, number>()
	for (const s of spoken) for (const n of s.needs) needCounts.set(n, (needCounts.get(n) ?? 0) + 1)
	return {
		turns: scores.length,
		spoke: spoken.length,
		insight: count("insight"),
		readout: count("readout"),
		repeat: count("repeat"),
		filler: count("filler"),
		meanScore: spoken.length === 0 ? 0 : spoken.reduce((a, s) => a + s.score, 0) / spoken.length,
		insightRate: spoken.length === 0 ? 0 : count("insight") / spoken.length,
		needs: [...needCounts.entries()]
			.map(([need, lines]) => ({ need, lines }))
			.sort((a, b) => b.lines - a.lines)
	}
}
