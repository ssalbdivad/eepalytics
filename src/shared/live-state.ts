/**
 * The one definition of "what is true" during a live game.
 *
 * Pure and browser-safe on purpose. It is rendered into the prompt the live coach is given, it is
 * served to the page by `GET /api/live/ground-truth`, and `scripts/eval-live.ts` reconstructs it
 * from stored timelines to score prompt changes. Three consumers, one shape — a second copy is a
 * copy that drifts, and the whole point of this block is that the model can trust it.
 *
 * It used to live in `review/live-vision.ts` beside the periodic-glance coach. That coach was
 * measured against the realtime one and deleted; this outlived it because it was never really
 * about the glance at all.
 */

/**
 * Ground truth for the frame, read from the Live Client Data API.
 *
 * Named `VisionState` rather than `LiveState`: `analysis/live-coach.ts` already owns that name
 * for a different thing (the overlay's own view of the game).
 *
 * This exists because the coach hallucinated without it. Asked to comment on a downscaled JPEG of
 * a 1080p screen, it named a champion who was not in the game four times in seven minutes, called
 * a TEAMMATE a threat, and contradicted itself about Baron three times. Champion portraits in the
 * HUD are about thirty pixels wide at that scale; the model was guessing, and a guess delivered
 * in a warm voice sounds exactly like a read.
 *
 * The fix is not a better model or a bigger image. The League client already serves every one of
 * those facts locally, in about 30ms — who is in the game, which side they are on, who is dead,
 * what the score is. This is *what is true*, and it is the same rule the rest of the app follows:
 * never derive a fact you can simply be told.
 *
 * It used to say the picture was for *where things are*. That half has now been measured and it was
 * not true: on this app's own frames, asked where the champions were on the 1536x864 screenshot it
 * actually sends, the model answered a median 43% of the map's width from the truth and agreed with
 * its own previous answer about the same picture 5 times in 60 — a randomly chosen point, dressed as
 * a read. So the block no longer invites it to look. Position, where the app has any, is computed
 * from a CROP of the minimap in `review/frame-read.ts`, ranked in `analysis/live-facts.ts` like
 * every other fact, and arrives in the list below already hedged.
 */
import { renderPronunciations } from "./pronounce.ts"
import type { Pronunciation } from "./pronounce.ts"

/* ================================================================ the CS quantum */

/**
 * The client reports every `creepScore` in TENS, and it rounds DOWN.
 *
 * Measured twice, because getting it backwards changes the correction. Grain: 1221 samples of
 * `allgamedata` across four real games, all ten players in each — 12210 readings, and not one of
 * them was a non-multiple of ten. Direction: journal frames read against the block built for the
 * same instant — at 02:42 his HUD reads 16 and the block says 10; at 06:43 the HUD reads 46 and
 * the block says 40 (`js-mtn2jrku-8ae9-{1630,4034}.jpg` against `split-03.ndjson`). Rounding would
 * have given 20 and 50, so it floors.
 *
 * A reported `c` therefore means the true figure is somewhere in `[c, c + 9]`, and every CS number
 * this app has ever put in front of the model has been understated by up to nine — while the one
 * person listening can read the true one off his own HUD. "Your 40 farm" said to a man looking at
 * 46 is not merely useless, it is visibly wrong, which is how a coach loses the benefit of the
 * doubt on the numbers that ARE exact.
 *
 * The correction is never to add anything back. Adding five would be inventing a digit, which is
 * the one thing this repo does not do. It is to say only what the figure supports: a floor, and a
 * gap that has cleared the rounding.
 */
export const CS_QUANTUM = 10

/** The most a reported CS can understate the true one: the last value that still floors to it. */
export const CS_MAX_UNDERSTATEMENT = CS_QUANTUM - 1

/**
 * A floored CS figure, said the only way it is true.
 *
 * Zero gets its own wording because "at least 0 CS" is a sentence with no content, and zero is the
 * value this failed on out loud: *"BRY-er is still at 0 CS"* reached the player about an enemy
 * jungler who had somewhere between nothing and nine. "Under 10 CS" is the same fact with the
 * uncertainty in it, and it is still the thing worth saying about a jungler who has not cleared.
 */
export const csPhrase = (cs: number): string => (cs === 0 ? `under ${CS_QUANTUM} CS` : `at least ${cs} CS`)

/** What two CS figures actually support once the client's rounding is allowed for. */
export interface CsGap {
	/** Bounds on (his true CS) − (the other true CS). Negative means he is behind. */
	low: number
	high: number
	/** The size of the gap that is CERTAIN — 0 whenever the interval straddles zero. */
	certain: number
	direction: "ahead" | "behind" | "level"
}

/**
 * Compare his floored CS with something else, as an INTERVAL rather than a subtraction.
 *
 * Subtracting a floored live figure from an exact historical mean is apples to oranges, biased low
 * by up to nine every single time, and the bias always points the same way — at "you are behind
 * your pace". Measured over the 107 checkpoints of `fixture-5635467422.json` that carry a
 * baseline, 104 read as behind and 21 of those (20%) had a gap of nine or less, i.e. the player
 * may well have been level or ahead in every one of them. That is a large part of the farm nagging
 * he quit over, and no prompt rule can fix it because the arithmetic was already wrong before the
 * model saw it.
 *
 * `otherFloored` widens the interval at both ends for a second client-reported figure — the enemy
 * jungler's CS is floored exactly the same way, so a reported gap between the two junglers is
 * always a multiple of ten and always worth ±9 less than it looks.
 */
export const csGap = (cs: number, other: number, otherFloored: boolean): CsGap => {
	const low = cs - other - (otherFloored ? CS_MAX_UNDERSTATEMENT : 0)
	const high = cs + CS_MAX_UNDERSTATEMENT - other
	return {
		low,
		high,
		certain: low > 0 ? low : high < 0 ? -high : 0,
		direction: low > 0 ? "ahead" : high < 0 ? "behind" : "level"
	}
}

/**
 * Is a gap big enough to be worth a sentence at all?
 *
 * One quantum, because a gap that is certain but tiny is the farm nag with an interval bolted on.
 * A reported ten-CS difference between the two junglers means a true difference of one to
 * nineteen — the certain part of it is ONE — and reading that out is exactly the four-CS-difference
 * noise `RACE_MIN_GAP` exists to suppress. Clearing a whole quantum takes a reported gap of twenty.
 *
 * Measured on all 1221 states of the four recorded games, every one of which carries both
 * junglers' CS: this rule speaks on 1132 of them and `RACE_MIN_GAP >= 14` speaks on the same 1132.
 * Not a similar number — the same states, because both figures are floored and every reported gap
 * in the corpus was a multiple of ten, so a threshold of 14 is a threshold of 20 and one of 10
 * certain is a threshold of 20 too. It therefore costs NO volume, which is the thing this app
 * cannot afford to spend. What it changes is the number in the sentence: across those 1132 states
 * the reported gap overstated the certain one by exactly nine, every single time.
 */
export const csGapWorthSaying = (g: CsGap): boolean => g.certain >= CS_QUANTUM

/* ===================================== when a fact stops being a question */

/**
 * RETIREMENT — a fact that returns the same answer every turn is not information.
 *
 * This is the general form of a fault this app has now committed twice, with two different subjects,
 * and the second time is what forced it into a mechanism rather than a constant.
 *
 * The first was the jungle CS race. Over his four recorded games the block's race verdict read
 * "he is behind you" in 82 states of 88 and "ahead" in none; farm, CS, clearing and routing together
 * produced three useful lines out of eighty-four. A comparison whose answer never changes cannot
 * drive a decision, however exact both numbers are.
 *
 * The second is the schedule directly above, which replaced it and is the one layer measured to
 * help (29% useful to 55%, p = 0.0009). Judged blind by four models afterwards, all four said the
 * same thing in different words: *the subject changed; the metronome did not.* 43 of 72 lines in one
 * run were the dragon, and the soul/baron pair that switched on at 19:42 was still being read out at
 * 36:43, eighteen turns later, with nothing retiring it. Replayed over the four games at the shipped
 * turn, the dragon entry was in the block on 300 turns of 306 — 98% — and 579 of 673 offered context
 * items repeated a subject the previous turn had already carried.
 *
 * So the rule cannot be about drakes, or about CS. It is about ANSWERS:
 *
 *   - a QUESTION is a thing the coach could talk about, named by a stable `key`;
 *   - a VERDICT is the answer right now, discretized so that it only changes when the DECISION
 *     changes — not when the number does;
 *   - each distinct answer is worth a fixed number of sentences (`budget`, one by default), after
 *     which the question is retired;
 *   - it comes back the instant the answer FLIPS, and `Standing.from` says what it flipped from,
 *     because that flip is the only moment the fact was ever news.
 *
 * ## Why the budget, and not "N turns without a change"
 *
 * The brief for this was "a fact whose verdict has not changed in N turns has stopped being
 * information", and that reading was tried and rejected on a case: the coach is silent on most turns
 * because of the floors in `analysis/live-facts.ts`, so a Baron standing untaken from 20:00 would age
 * out on the clock without ever having been mentioned. Baron up at 23:00 that he has not been told
 * about is MORE worth saying than at 20:01, not less. Counting turns retires facts that were never
 * said; counting offers retires facts he has already heard, which is the thing that was actually
 * wrong. Ageing an answer out unsaid is available by widening the verdict instead — see
 * `SCHEDULE_UNCONTESTED_SEC`, where standing for two minutes IS a different answer.
 *
 * An offer is counted rather than a spoken line, for the reason `FactMemory` records: the coach may
 * only speak from what it is handed, and it also passes, so offers are an upper bound on lines and
 * the enforced rate is a ceiling rather than a schedule.
 */
export interface Question {
	/** Names the QUESTION and never the answer, and is stable for the whole game. */
	key: string
	/**
	 * The answer, discretized.
	 *
	 * Coarseness is the entire design of a verdict. "Dragon spawns in 214 seconds" is a different
	 * string every turn and the same information every turn; `later@300` is not. Anything that
	 * changes on its own — a countdown, an elapsed age, a gold total that only grows — must be
	 * bucketed into the answers a jungler would actually act on differently, or the question can
	 * never retire.
	 */
	verdict: string
	/** How many times a line on this answer may be offered. One unless there is a reason. */
	budget?: number
}

/** What the retirement rule remembers about one question. */
export interface AnswerRecord {
	verdict: string
	/** Game clock at which this answer first appeared. */
	sinceSec: number
	/** Offers spent on this answer. */
	offers: number
	/** The answer before this one, or null while this is the first. */
	from: string | null
}

export interface RetirementMemory {
	answers: Record<string, AnswerRecord>
}

export const newRetirementMemory = (): RetirementMemory => ({ answers: {} })

/** In place, because the daemon holds one memory for the process and the identity must survive. */
export const resetRetirementMemory = (mem: RetirementMemory): void => {
	mem.answers = {}
}

export interface Standing {
	/** May a line about this question be offered at all? */
	open: boolean
	/**
	 * The answer has CHANGED and he has not been told the new one yet.
	 *
	 * The only moment the fact was ever news, and the reason a retired question is retired rather
	 * than deleted: a flip is worth saying loudly, and nothing that has been deleted can flip.
	 *
	 * It stays true until the answer is spent, rather than only on the turn of the change, and that
	 * is not a detail. `buildFacts` observes a question on every turn its fact is BUILT, including
	 * the turns where the floor then withholds it — so a flip that expired on the clock would be
	 * consumed by the very turn that refused to say it, which is the same bug as burning a cooldown
	 * on a withheld fact and is recorded three times in `analysis/live-facts.ts`. An unspoken flip is
	 * still news.
	 */
	flipped: boolean
	/** What it flipped from, or null while this is the first answer seen. */
	from: string | null
	/** How long the current answer has stood, in game-clock seconds. */
	heldSec: number
	/** Offers already spent on this answer. */
	offers: number
}

/**
 * Look at a question, and notice if the answer has changed since the last look.
 *
 * WRITES to `mem`, deliberately and idempotently: noticing a change IS the observation, so a caller
 * that had to remember to record it separately would be a second copy of the rule, and this file
 * already carries the cost of that mistake in three other places. Calling it twice in one turn gives
 * the same answer twice — `flippedAtSec` is compared against the clock rather than cleared.
 *
 * A question is only ever observed on a turn where its fact was BUILT, which means a verdict can
 * change while nobody is looking and be recorded as the next flip rather than as two. That is the
 * intended reading: an answer he was never in a position to hear did not change for him.
 */
export const standingOf = (mem: RetirementMemory, q: Question, nowSec: number): Standing => {
	const prior = mem.answers[q.key]
	if (!prior || prior.verdict !== q.verdict) {
		const rec: AnswerRecord = {
			verdict: q.verdict,
			sinceSec: nowSec,
			offers: 0,
			from: prior ? prior.verdict : null
		}
		mem.answers[q.key] = rec
		return { open: true, flipped: rec.from !== null, from: rec.from, heldSec: 0, offers: 0 }
	}
	return {
		open: prior.offers < (q.budget ?? 1),
		flipped: prior.from !== null && prior.offers === 0,
		from: prior.from,
		heldSec: Math.max(0, nowSec - prior.sinceSec),
		offers: prior.offers
	}
}

/**
 * Mark that a line about this question was put in front of him.
 *
 * Called only for what is actually offered, for the reason `buildFacts` writes its memory after
 * ranking rather than while building: a fact that burns its budget while being withheld is a fact
 * that is never said at all, and the rarest and best lines are exactly the ones a floor lands on.
 */
export const spendAnswer = (mem: RetirementMemory, q: Question, nowSec: number): void => {
	standingOf(mem, q, nowSec)
	const rec = mem.answers[q.key]
	if (rec) rec.offers++
}

/* ============================================================ the map's own clock */

/**
 * WHAT IS COMING — the one layer that was measured to change anything.
 *
 * Nine arms of context were replayed through one model over 88 real states of his own games and
 * judged blind (`data/eval/why-shallow.md`). The shipped block scored 29% useful lines. Adding
 * ninety seconds of exactly-computed history: 30%, p = 0.94. Adding his measured career habits on
 * top: no further gain. Adding this — what is up, what is next, and in how many seconds — took it
 * to 55%, p = 0.0009, and it did so at the QUIET moments most of all (53% against the shipped
 * block's 39% at a decision point).
 *
 * The mechanism is not that a schedule "reasons across time". Lines whose premise spanned time
 * scored 45% against 37% for lines about the instant — inside every arm's own interval. It is that
 * a schedule changes the SUBJECT. Classified by what the sentence is about, over 554 judged lines:
 * a neutral objective 61% useful (n=211), an enemy being down 41%, gold 32%, and farm/CS/clearing
 * **4% — three useful lines out of eighty-four**, which is the subject the shipped ranker puts
 * first.
 *
 * And the data is not replaceable by an instruction. An arm given the shipped block and a prompt
 * paragraph telling it to prefer objectives obeyed — 49% of its lines became objective lines — and
 * still lost to the schedule, 37% against 55% (p = 0.020), because a coach told to talk about
 * dragons with no dragon timer talks about dragons that are not there: *"Briar is down right now,
 * so keep your clear running and take dragon"*, fifty-six seconds before the first dragon spawned.
 * Prompting picks the subject; only data makes the sentence true.
 */

/** One neutral objective, as the event feed and the map's fixed spawn times leave it. */
export interface ScheduledObjective {
	/** Spoken name — "Dragon", "Void grubs", "Rift Herald", "Baron", "Elder Dragon". */
	name: string
	/** `up`: available now. `coming`: spawns at `atSec`. */
	state: "up" | "coming"
	/** Game clock of the spawn this refers to. */
	atSec: number
	/** Seconds it has been up, or seconds until it spawns. Always non-negative. */
	sec: number
	/** Who has taken this kind of objective so far, when the count is worth carrying. */
	taken?: { mine: number; theirs: number }
	/**
	 * He has already been told this, and the answer has not changed since. See `retireSchedule`.
	 *
	 * The entry is kept rather than dropped, and the timer inside it is kept exact, because the one
	 * failure worse than repeating a spawn time is inventing one: an arm prompted to prefer
	 * objectives WITHOUT a schedule reached 37% and told him to take a dragon fifty-six seconds
	 * before the first dragon spawned. A retired entry is demoted in the prose, never deleted.
	 */
	retired?: boolean
}

/**
 * Spawn constants for the live patch. THESE ARE THE ONE THING HERE THAT CAN GO STALE.
 *
 * Cross-checked against every objective event in the four recorded games
 * (`data/live-samples/split-01..04.ndjson`), which is where each of them earned its place:
 *
 *   - first `DragonKill` 365, 480, 540, 660 — all after 300, none before.
 *   - `DragonKill` gaps: minimum observed 309 seconds over eleven retakes, so 300 never overstates.
 *   - first `HordeKill` 490, 494, 519, 523 — all after 360.
 *   - `HeraldKill` 934, 1029, 1065, and NEVER TWICE IN A GAME across four games that ran past 29
 *     minutes. Herald is one per game here, which is why taking it removes it from the schedule
 *     rather than starting a respawn clock. The why-shallow harness gave it a 360-second respawn;
 *     the corpus does not support one and a phantom Herald timer is a fabrication with a number on
 *     it.
 *   - `BaronKill` 1341, 1879, 1992, none before 1200; the one retake in the corpus came 574
 *     seconds later, so 360 never overstates either.
 */
export const OBJECTIVE_SPAWN = {
	dragonFirstSec: 300,
	dragonRespawnSec: 300,
	/** Once a side has this many drakes it has soul, and the next spawn is Elder. */
	soulAt: 4,
	elderRespawnSec: 360,
	/*
	 * VOID GRUBS AND HERALD ARE 8:00 AND 15:00, and both were wrong here until the minimap said so.
	 *
	 * The event log alone cannot settle a spawn time — it only ever gives an upper bound, because it
	 * records when somebody got round to taking the thing. The four games' first `HordeKill` at 490,
	 * 494, 519 and 523 are consistent with a 360 spawn and MORE consistent with a 480 one, and the
	 * `HeraldKill`s at 934, 1029 and 1065 say nothing about 840 against 900.
	 *
	 * What settles it is the countdown on his own minimap, read out of the journal frames
	 * (`data/eval/is-the-timer-visible.md`): six games read 31/31/31/32/30/30 seconds remaining at
	 * 7:29–7:30, and the grub icon appears at 8:08; five games read 33/30/32/30/35 at 14:26–14:30.
	 * Both resolve to the minute, and neither is the number that was here.
	 *
	 * The cost of the old figures was not academic. Replayed over all 1,876 real ticks of his four
	 * games, the schedule spent 146 of them — 7.8% — asserting the grubs were UP while the pit was
	 * empty, plus 54 more for Herald. That is the app telling a jungler to walk to a camp that does
	 * not exist yet, in a confident voice, which is the one failure this whole file is built to
	 * refuse. It also breaks retirement specifically: a false "UP" is an answer, and an answer now
	 * gets said once, loudly.
	 *
	 * `HERALD_VISIBLE_FROM_SEC` below is 720, i.e. exactly three minutes before 900 and not before
	 * 840 — the gate was already tuned to the real spawn while the constant beside it was not.
	 */
	grubsSpawnSec: 480,
	/** Grubs leave the map when Herald arrives. */
	grubsDespawnSec: 900,
	heraldSpawnSec: 900,
	/** Herald is gone by the time Baron is up; past this the schedule stops mentioning it. */
	heraldGoneSec: 1200,
	baronFirstSec: 1200,
	baronRespawnSec: 360
} as const

/** The objective events the schedule needs, side-resolved by the caller. */
export interface ObjectiveEvent {
	kind: "dragon" | "grub" | "herald" | "baron"
	tSec: number
	/** `null` when the killer could not be resolved to a player — see `championOf`. */
	side: "mine" | "theirs" | null
}

/**
 * When Herald and Baron enter the schedule at all.
 *
 * These two are the gates the measured layer used, and they are kept rather than re-tuned: an arm
 * that scored 55% against a block's 29% is not a thing to improve by eye. Dragon and the grubs
 * carry NO gate, for the same reason — the ladder showed both on every turn from the first second,
 * and half of that arm's early-game lines were judged useful against a fifth of the shipped
 * block's, precisely because the first clear is decided around a spawn five minutes out.
 *
 * Baron at seven minutes is trivia; Baron at three is a route. Herald arrives as the grubs leave,
 * which is why its window opens two minutes before they despawn.
 */
export const HERALD_VISIBLE_FROM_SEC = 720
export const BARON_VISIBLE_FROM_SEC = 1020

/**
 * What is up and what is next, from the event feed and nothing else.
 *
 * Deliberately silent rather than clever in every case the feed cannot settle. It never says how
 * many grubs REMAIN: six is the number in the patch notes, the corpus has exactly three taken in
 * each of four games and never a second cluster, and a count arrived at by subtracting from a
 * number nobody measured is the same fabrication as a made-up respawn timer.
 */
export const objectiveSchedule = (events: readonly ObjectiveEvent[], tSec: number): ScheduledObjective[] => {
	const of = (kind: ObjectiveEvent["kind"]) => events.filter(e => e.kind === kind)
	const count = (kind: ObjectiveEvent["kind"]) => ({
		mine: of(kind).filter(e => e.side === "mine").length,
		theirs: of(kind).filter(e => e.side === "theirs").length
	})
	const lastOf = (kind: ObjectiveEvent["kind"]): number | null => {
		let out: number | null = null
		for (const e of of(kind)) if (out === null || e.tSec > out) out = e.tSec
		return out
	}
	const out: ScheduledObjective[] = []
	/*
	 * EVERYTHING IN THIS LIST IS UNTAKEN, and that invariant is what makes it safe to speak from.
	 *
	 * Each entry is either a first spawn nobody has killed yet or a respawn computed FROM the last
	 * kill, so by construction the thing it names is still standing there. The schedule is a list
	 * of places to be; an entry that might already be empty does not belong in it. See the grubs
	 * below, which is where that rule was learned.
	 */
	const add = (name: string, atSec: number, taken?: { mine: number; theirs: number }): void => {
		if (atSec <= tSec) out.push({ name, state: "up", atSec, sec: Math.round(tSec - atSec), taken })
		else out.push({ name, state: "coming", atSec, sec: Math.round(atSec - tSec), taken })
	}

	const drakes = count("dragon")
	const lastDrake = lastOf("dragon")
	const soul = Math.max(drakes.mine, drakes.theirs) >= OBJECTIVE_SPAWN.soulAt
	/*
	 * Both the NAME and the TIMER of the next dragon depend on whether soul is decided, and soul is
	 * a per-side count. An unresolved killer therefore does not merely lose a tally entry: with
	 * enough drakes on the board it makes the difference between "Dragon in five minutes" and
	 * "Elder in six", and the wrong one of those sends him to an empty pit early with a confident
	 * voice behind him. So when the counts cannot settle it, the dragon line is withheld.
	 *
	 * It should never fire in practice — `championOf` resolves the event feed's bare game names
	 * against `riotIdGameName`, which matched 37 of 37 in a real capture once that field was
	 * consulted — and it exists because the failure it guards against is silent.
	 */
	const unsided = of("dragon").filter(e => e.side === null).length
	const soulUnknowable = !soul && unsided > 0 && Math.max(drakes.mine, drakes.theirs) + unsided >= OBJECTIVE_SPAWN.soulAt
	if (!soulUnknowable)
		add(
			soul ? "Elder Dragon" : "Dragon",
			lastDrake === null ? OBJECTIVE_SPAWN.dragonFirstSec
			: soul ? lastDrake + OBJECTIVE_SPAWN.elderRespawnSec
			: lastDrake + OBJECTIVE_SPAWN.dragonRespawnSec,
			drakes
		)

	/*
	 * The grubs leave the schedule the moment ANY have been taken, and this was measured on the
	 * coach rather than reasoned about.
	 *
	 * An earlier version kept the pit in the list once it had been worked, phrased so that it only
	 * asserted the spawn time and the tally — no claim about what was left. The model supplied the
	 * claim anyway, because a place in a schedule is a place to go: at 09:08, 11:29 and 12:10 of
	 * game 5635467422, with all three of that game's grubs already dead, it said *"Void grubs have
	 * been open 3 minutes 8 seconds, so go finish the pit"* and two rewordings of it. That is a
	 * jungler walking across the map to an empty camp on the strength of a true sentence.
	 *
	 * The count cannot rescue it: the patch note says six, the four recorded games contain exactly
	 * three `HordeKill` events each and never a second cluster, so nothing here can say whether one
	 * is left. Unknowable and off the list beats unknowable and on it. The topside tally he
	 * actually needs is a career fact and reaches him through `analysis/habits.ts`, not through a
	 * list of places to walk to.
	 */
	if (tSec < OBJECTIVE_SPAWN.grubsDespawnSec && count("grub").mine + count("grub").theirs === 0)
		add("Void grubs", OBJECTIVE_SPAWN.grubsSpawnSec)

	if (lastOf("herald") === null && tSec >= HERALD_VISIBLE_FROM_SEC && tSec < OBJECTIVE_SPAWN.heraldGoneSec)
		add("Rift Herald", OBJECTIVE_SPAWN.heraldSpawnSec)

	if (tSec >= BARON_VISIBLE_FROM_SEC) {
		const lastBaron = lastOf("baron")
		add(
			"Baron",
			lastBaron === null ? OBJECTIVE_SPAWN.baronFirstSec : lastBaron + OBJECTIVE_SPAWN.baronRespawnSec,
			count("baron")
		)
	}

	return out
}

/**
 * When a countdown stops being trivia and becomes a route. See `scheduleQuestion`.
 *
 * A minute is roughly the time it takes a jungler to finish the camp he is on and walk to a pit, so
 * it is the point at which "in four minutes" turns into "start moving". `analysis/live-facts.ts`
 * uses forty-five seconds for the same idea on its own objective calls; this is the coarser of the
 * two on purpose, because a verdict is about when the DECISION changes and a fact is about when the
 * sentence is due.
 */
export const SCHEDULE_SOON_SEC = 60

/**
 * How long an objective must stand untaken before that is a DIFFERENT fact.
 *
 * "Herald is up" and "Herald has been standing there for two minutes and nobody on either team has
 * gone near it" are not the same claim, and the second was the best line any model produced in this
 * whole evaluation — there is no channel in this app, screenshot included, through which he could
 * learn it. So a standing objective gets exactly two sentences: one when it goes up, and one when
 * it has been ignored long enough for the ignoring to be the news. The fifth telling is the noise
 * this mechanism exists to stop.
 */
export const SCHEDULE_UNCONTESTED_SEC = 120

/**
 * One schedule entry, as a question with an answer.
 *
 * The KEY is the objective's name, so a dragon stays one question all game. The VERDICT carries the
 * spawn it refers to, so that taking a drake and starting the next timer is a genuine flip rather
 * than a continuation — and it carries a coarse bucket rather than the countdown, because a
 * countdown changes every turn on its own and a question whose answer changes on its own can never
 * retire. That is the whole trick, and it is where the previous attempt went wrong: the fact was
 * ranked, the number moved, and it looked like news for eighteen turns running.
 */
export const scheduleQuestion = (o: ScheduledObjective): Question => ({
	key: `objective:${o.name}`,
	verdict:
		o.state === "up" ?
			o.sec >= SCHEDULE_UNCONTESTED_SEC ? `uncontested@${o.atSec}`
			:	`up@${o.atSec}`
		: o.sec <= SCHEDULE_SOON_SEC ? `soon@${o.atSec}`
		: `later@${o.atSec}`
})

/**
 * Mark every schedule entry he has already been told about, and spend the ones he has not.
 *
 * Mutates `mem`, and spends on being OFFERED rather than on being spoken — which is the right rule
 * for this section specifically, and the reason is the age. A standing objective's verdict does not
 * change while it stands, but the sentence about it does: "up since 14:00, two seconds ago" becomes
 * "up since 14:00, eleven minutes ago", and every one of those reads as fresh. There is nothing in
 * the state to retire on, so the retirement has to be on the telling.
 *
 * The cost of using offers as the proxy for tellings is stated rather than hidden: when two
 * objectives flip on the same turn both are spent and the coach speaks at most one of them, so the
 * other is demoted having never been said. Spending only what was SPOKEN needs the transcript joined
 * back to the state, and that layer was measured to add nothing on top of the schedule (48% against
 * 55%, inside each other's intervals). A demoted entry keeps its exact timer and comes back the
 * moment its answer changes, so the failure mode is one missed sentence rather than a wrong one.
 *
 * Replayed over the four recorded games at the shipped turn, this is the whole of the metronome:
 * before it the dragon entry was in the block on 300 turns of 306 and the four games' longest
 * unbroken runs of one subject were 47, 89, 91 and 73 turns.
 */
export const retireSchedule = (
	list: readonly ScheduledObjective[],
	mem: RetirementMemory,
	tSec: number
): ScheduledObjective[] =>
	list.map(o => {
		const q = scheduleQuestion(o)
		const st = standingOf(mem, q, tSec)
		if (st.open) spendAnswer(mem, q, tSec)
		return st.open ? o : { ...o, retired: true }
	})

/** Seconds, said the way a person says them out loud. */
export const spokenDuration = (sec: number): string => {
	/*
	 * The singular is not pedantry here — it is spoken aloud. `claude-opus-5` read the schedule back
	 * verbatim at 35:42 of game 5635467422: *"Dragon spawns in 1 seconds and they are one drake from
	 * soul"* (`data/eval/opus-briefing/ab-opus-late.json`). The prompt tells it to say the timer as
	 * given, so a grammar mistake in this function is a grammar mistake in his ear.
	 */
	if (sec < 60) return `${sec} second${sec === 1 ? "" : "s"}`
	const m = Math.floor(sec / 60)
	const s = sec % 60
	const mins = `${m} minute${m === 1 ? "" : "s"}`
	return s === 0 ? mins : `${mins} ${s} second${s === 1 ? "" : "s"}`
}

const mmss = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`

/* ================================================ what is already on his screen */

/**
 * HIS HUD IS A CHANNEL, and this section is the app's model of what it already carries.
 *
 * The failure this exists to stop is one sentence long: *"Dragon spawns in 44 seconds, path to the
 * pit."* Every digit in it is exact, it is grounded, it names an action, and it is worthless,
 * because the number was printed on his minimap before this app polled for it and the directive
 * that follows from it follows for anybody. Fifteen of one judge's forty-six lines were that shape.
 *
 * ## Visible is NOT disqualifying, and getting this backwards is the expensive mistake
 *
 * Measured over 554 blind-judged lines (`data/eval/why-shallow.md`): lines about something plainly
 * on his screen were judged useful 45% of the time against 27% for lines about something invisible,
 * and the BEST quadrant in the whole corpus is visible AND specific, at 67% over 205 lines. What
 * kills a line is genericness alone — 14% against 55%. So nothing here forbids talking about a
 * thing he can see. Naming which of the things in front of him the next thirty seconds are for is
 * the best sentence this coach can write.
 *
 * What this refuses is narrower and it is the other quadrant: a turn on which the block's ENTIRE
 * news is HUD-derived, so the only line available is a figure he is looking at plus the directive
 * that figure implies. On such a turn the block states the answer — PASS — rather than hoping the
 * model declines. A prompt rule is a plea; a block that says there is nothing here is a mechanism.
 *
 * ## Where the classification comes from
 *
 * `data/eval/is-the-timer-visible.md`, which read 1,876 real journal frames — his own nine games,
 * three sessions, two days — and established what his minimap prints, with the game clock stamped
 * by the daemon on the other side of the process from the picture. Its verdict, and the whole
 * basis of `scheduleScreen` below:
 *
 * - the spawn countdown IS on his minimap, in 9 of 9 games and 257 of 260 frames sampled in the
 *   three minutes before the first dragon. It appears at exactly T-3:00, reads `2m+` until T-2:00,
 *   then exact `m:ss`, then yellow under ten seconds. Our copy of that number is a poll and a
 *   render late;
 * - once the thing is STANDING the map prints its icon and no number at all. **How long it has
 *   stood untaken is not on his screen in any state, for any objective** — the one genuinely
 *   off-screen fact in the whole schedule, and the premise of the best line any model produced;
 * - the drake tally and the soul point are not on the top bar. Game 4 at 25:29 with the drakes 3-1
 *   prints the count nowhere; it needs TAB, which is not a thing he does in a fight.
 *
 * Replayed over those 1,876 ticks, 27.5% of the shipped schedule's entries were a number already on
 * his map and 36.6% named something whose icon was already there. That is what this splits.
 *
 * ## The one thing this deliberately does NOT classify
 *
 * The block's standing background — his own line, the two rosters, the jungle race, the farm
 * baseline — is not weighed here at all, and that is a decision rather than an oversight. It is
 * printed on every turn of every game, and the retirement work above measured what its answers do:
 * the race verdict read "he is behind you" in 82 states of 88 and "ahead" in none. A section whose
 * answer never changes cannot make this turn different from the last one, so it cannot be the
 * reason to speak now. When one of those facts genuinely becomes news — a swing, a gap that moved,
 * a level deficit — `analysis/live-facts.ts` ranks it and it arrives in `unseen`, where it IS
 * weighed. The background is excluded by construction and re-enters through the list.
 */

/**
 * How far out his minimap starts printing a spawn.
 *
 * Bounded on game 4 of the corpus: absent at 1:48 with 3:13 to go, present at 2:03 with 2:58 to go.
 * Games 7, 8 and 9 give first-continuous-presence at 178, 157 and 175 seconds remaining.
 *
 * Between 3:00 and 2:00 the map prints the literal string `2m+` and no digits, so the exact second
 * in that band is genuinely ours. It is still classed as his, because the DECISION does not change
 * across it — "not yet" either way — and a coach that speaks on the strength of a second he cannot
 * act on differently is the readback this whole section is about.
 */
export const MINIMAP_COUNTDOWN_SEC = 180

/** Could he have got this by looking at his own screen this instant? */
export type Screen = "hud" | "off-screen"

/**
 * One schedule entry, by whether his own minimap already carries it.
 *
 * Order matters and each branch is a measured line from `is-the-timer-visible.md`. A standing
 * objective is off-screen on its DURATION, which the map never prints. A tally is off-screen
 * because the top bar does not carry it. A countdown inside three minutes is his, exactly, and
 * earlier than ours.
 */
export const scheduleScreen = (o: ScheduledObjective): Screen =>
	o.state === "up" ? "off-screen"
	: o.taken && o.taken.mine + o.taken.theirs > 0 ? "off-screen"
	: o.sec > MINIMAP_COUNTDOWN_SEC ? "off-screen"
	: "hud"

/**
 * The ranked list's HUD templates, and NOTHING ELSE IS ONE.
 *
 * `analysis/live-facts.ts` writes every line in this list from a fixed template, so the templates
 * can be recognised — `premiseOf` in `analysis/timeliness.ts` has parsed them for months and
 * `analysis/useful.ts` already keeps a premise-to-screen table. Neither is importable from
 * `shared/`, so the patterns are restated here for the four that matter, and the two files are
 * checked against each other in the test rather than left to drift silently.
 *
 * **An unrecognised line is off-screen**, which is the conservative direction: a template added
 * tomorrow makes the coach speak on a turn it might have passed, rather than silently gagging it.
 * The same posture `analysis/useful.ts` takes with `unmeasured`, for the same reason.
 *
 * Two entries diverge from `screenOfPremise`, both deliberately and both toward speaking less:
 *
 * - **the objective COUNT is off-screen here.** That table calls it `hud` on the reasoning that the
 *   top bar carries drake icons. Measured on real frames afterwards, it does not: the top bar
 *   carries kills, his KDA, his CS and the clock, and game 3 at 18:40 with the enemy one drake from
 *   soul prints the tally nowhere. So the count is not listed below and falls through to
 *   off-screen.
 * - **gold splits on the DURATION.** `live-facts.ts` says it itself — "he can read 1280 gold, he
 *   cannot feel that it has been sitting there for three minutes" — and the hand-written target set
 *   makes the same call at M13. So `N gold sitting unspent` is his HUD and
 *   `N gold unspent for M minutes now` is not.
 */
export const HUD_FACT_PATTERNS: readonly RegExp[] = [
	// "Drake is back in 41 seconds", "Baron is up NOW", and the rotation variant that adds a side.
	/^(?:Baron|Herald|Drake) is (?:back in \d+ seconds|up NOW)/,
	// The amount, with no hold behind it. Bottom right of his screen, permanently.
	/^\d+ gold sitting unspent/,
	// His own CS against his own average: the half he acts on is the half he is looking at.
	/^you're (?:roughly )?\d+ CS (?:down|up) on your own pace/,
	/*
	 * Announced on his screen with a banner and a sound when it happened.
	 *
	 * Narrow on purpose. A looser `^they (took|have) ` swallowed "they have taken 2 of the
	 * objectives and you have taken none", which is the TALLY and is measurably not on his screen —
	 * caught by replaying split-03, where that exact line was reclassified as a readout at 15:26.
	 */
	/^they took /,
	/^they have (?:Baron|Herald)\b/,
	// The game already told him, loudly. Praise is not information and does not have to be.
	/^you (?:just got a |secured |stole )/
]

/** Whether a ranked line's whole premise is something he is already looking at. */
export const factScreen = (text: string): Screen =>
	HUD_FACT_PATTERNS.some(re => re.test(text.trim())) ? "hud" : "off-screen"

/** One schedule entry, written the way it should be said. */
const scheduleLine = (o: ScheduledObjective): string => {
	const took =
		o.taken && o.taken.mine + o.taken.theirs > 0 ?
			` Taken so far this game: ${o.taken.mine} by you, ${o.taken.theirs} by them.`
		:	""
	return o.state === "up" ?
			`- ${o.name}: UP and untaken since ${mmss(o.atSec)}, ${spokenDuration(o.sec)} ago.${took}`
		:	`- ${o.name} spawns at ${mmss(o.atSec)} — in ${spokenDuration(o.sec)}.${took}`
}

/** What this turn's block carries, split by whether he could have read it himself. */
export interface ScreenSplit {
	/** News in this block that no channel he has supplies. Empty means there is nothing to say. */
	offScreen: string[]
	/** News in this block that is already rendered on his screen this instant. */
	hud: string[]
}

/**
 * Split this turn's NEWS by channel — the mechanism the PASS offer is computed from.
 *
 * News is the schedule's live entries, the ranked list, an enemy who is down, and what just
 * happened. Retired schedule entries are excluded because he has already been told them; the
 * standing background is excluded for the reason in this section's header.
 *
 * `recentEvents` is HUD, and that is checked rather than assumed: frame `js-mtn2jrku-8ae9-3683.jpg`
 * carries the banner "Enemy team has slain the Hextech Drake!" across his screen at the instant the
 * block would have reported it. A take he watched is not a fact he was missing.
 *
 * An enemy being down is off-screen and one of his own side being down is not, and the asymmetry is
 * the point: he is looking at his own grey screen, and the kill feed for an ally scrolls past, but
 * an enemy corpse across the map is a state he can only reach through TAB. Judged blind, an enemy
 * being down is the second-best subject in the corpus at 41% useful.
 */
export const screenSplit = (s: VisionState): ScreenSplit => {
	const offScreen: string[] = []
	const hud: string[] = []
	for (const o of s.schedule ?? []) {
		if (o.retired) continue
		;(scheduleScreen(o) === "hud" ? hud : offScreen).push(scheduleLine(o).replace(/^- /, ""))
	}
	for (const u of s.unseen) (factScreen(u) === "hud" ? hud : offScreen).push(u)
	const theirs = s.enemies.filter(p => p.dead).map(p => p.champion)
	if (theirs.length > 0) offScreen.push(`down right now on their side: ${theirs.join(", ")}`)
	const mine = [...(s.me.dead ? [s.me.champion] : []), ...s.allies.filter(p => p.dead).map(p => p.champion)]
	if (mine.length > 0) hud.push(`down right now on his side: ${mine.join(", ")}`)
	for (const e of s.recentEvents) hud.push(e)
	return { offScreen, hud }
}

/**
 * Is every scrap of news in this block one he is already reading?
 *
 * True is the PASS offer. It is true both when the block's news is entirely HUD-derived and when
 * there is no news at all — the second is the commoner case and it is the same answer.
 */
export const hudOnlyTurn = (s: VisionState): boolean => screenSplit(s).offScreen.length === 0

/**
 * The schedule as prose, with the timers written the way they should be said.
 *
 * How long something has been UP is the sharpest fact in here and the reason the section is not
 * just a list of spawn times: a drake that has stood open for two minutes is a statement that
 * nobody on either team is contesting it, and there is no channel in this app — screenshot
 * included — through which he could learn that.
 */
export const renderSchedule = (list: readonly ScheduledObjective[]): string => {
	if (list.length === 0) return ""
	const render = scheduleLine
	const live = list.filter(o => !o.retired)
	const old = list.filter(o => o.retired)
	/*
	 * THE LIVE HALF IS SPLIT BY CHANNEL, and the split is a heading rather than a suffix on each
	 * line, deliberately.
	 *
	 * A marker attached to a fact gets spoken in this app. `Briar = BRY-er` was introduced as a
	 * pronunciation hint and was read out to the player verbatim, mid-game, because everything else
	 * in the block is a fact to be said and a line shaped like data is treated as data. The
	 * "Already covered" group below is the pattern that has worked: the fence is a heading and a
	 * paragraph of prose, and the entries under it are untouched.
	 */
	const mine = live.filter(o => scheduleScreen(o) === "off-screen")
	const his = live.filter(o => scheduleScreen(o) === "hud")
	const parts: string[] = []
	if (mine.length > 0)
		parts.push(
			`### What is coming — and this is the part his own map does not print\n\n${mine
				.map(render)
				.join("\n")}`
		)
	/*
	 * The countdown he is already looking at, kept with its digits exact and fenced in prose.
	 *
	 * Deleting it is the cheaper change and it is the wrong one, for the same reason the retired
	 * group is kept: a coach that wants to talk about a dragon and has no dragon timer invents one,
	 * measured at 37% useful against the schedule's 55%, telling him to take a dragon fifty-six
	 * seconds before the first dragon spawned. The number stays where he can reach it; what is
	 * withdrawn is the sentence that consists of nothing else.
	 */
	if (his.length > 0)
		parts.push(
			`### Also on the map's clock — his own minimap is already printing these\n\n${his
				.map(render)
				.join(
					"\n"
				)}\n\nHis map prints these from three minutes out, exactly, and this block is a poll behind it. A sentence whose only content is one of them is a number he is already looking at.`
		)
	/*
	 * The retired half is kept, with its timers exact, and it is fenced in PROSE.
	 *
	 * Deleting it would be the cheaper change and it is the wrong one: the map's clock exists
	 * nowhere else, and a coach that wants to talk about a dragon and has no dragon timer invents
	 * one — measured, at 37% useful against the schedule's 55%, telling him to take a dragon
	 * fifty-six seconds before the first dragon spawned. So the number stays where he can reach it
	 * and the sentence is what is withdrawn.
	 *
	 * Prose rather than a label, because a line SHAPED like data gets read out in this app: a
	 * pronunciation table written as `Briar = BRY-er` was spoken to the player verbatim, mid-game.
	 */
	if (old.length > 0)
		parts.push(
			`### Already covered — he has been told each of these and nothing about them has changed since\n\n${old
				.map(render)
				.join(
					"\n"
				)}\n\nThese are here so that you never have to guess a timer, not to be said again. Raise one only when its answer changes — it spawns, it gets taken, someone finally contests it.`
		)
	return parts.join("\n\n")
}

export interface VisionState {
	/** `mm:ss`. */
	clock: string
	me: {
		champion: string
		level?: number
		hp?: number
		maxHp?: number
		gold?: number
		k?: number
		d?: number
		a?: number
		/** As the client reports it: floored to a multiple of ten. See `CS_QUANTUM`. */
		cs?: number
		dead?: boolean
		respawnSec?: number
	}
	/**
	 * His farm against his own average at this point in the game, or null when there is no
	 * baseline for it — and NULL IS RENDERED, deliberately, as a stated absence.
	 *
	 * Measured: asked "how am I doing" of a block whose CS carried no baseline, the coach invented
	 * one in 2 of 5 answers ("ahead of your usual pace of 85") and asserted an unbacked comparison
	 * in words in a third ("which is what you usually get for this time"). Prompt rules cut it down
	 * and never to zero, which is the wrong tool: the model was policing a GAP. A gap is an
	 * invitation, so the block no longer leaves one. Telling it plainly that no baseline exists is
	 * a fact it can repeat, and repeating a fact is the one thing it does reliably.
	 */
	/*
	 * `cs` is the client's floored figure; `expected` is an exact mean over finished games, where
	 * the match API reports CS to the unit. The two are not the same kind of number, so the block
	 * never subtracts them — see `csGap`.
	 */
	pace: { cs: number; expected: number; exact: boolean; source: string } | null
	/**
	 * Say-it-like-this entries for the champions in THIS game, and only the ones said wrongly.
	 *
	 * The audio model pronounces what it produces, and champion names are invented words it gets
	 * badly wrong — badly enough that the player cannot tell who a sentence is about. Empty is the
	 * normal case for a roster it already handles.
	 */
	pronounce: Pronunciation[]
	/**
	 * The enemy jungler, RIGHT NOW — the man he is actually racing.
	 *
	 * This is the single most valuable line in the block and it was sitting unused in
	 * `allPlayers[].scores`. Every other farm figure compares him to HIS OWN AVERAGE, which encodes
	 * his own mistakes, so the best it can ever say is that he is being unusually himself. A
	 * Challenger one-trick compares you to your counterpart, in THIS game, at THIS minute.
	 *
	 * Measured on the real socket: "Trundle is 23 CS up on you" was one of only two lines in ten
	 * that passed all three tests — not visible without holding TAB, not sayable about any other
	 * game, and a decision follows from it. Both numbers come off the client, so it carries no
	 * fabrication risk at all.
	 *
	 * It says how much he has cleared. It NEVER says where he is; the API has no positions.
	 */
	counterpart: {
		champion: string
		/** Floored to a multiple of ten, exactly as his own is — so the gap between them is too. */
		cs?: number
		level?: number
		/*
		 * Item COUNT is deliberately absent. The only signal the client gives is `price`, so
		 * "completed items" would be a threshold guess dressed as a fact, and a guess spoken in a
		 * confident voice is the exact failure this app exists to avoid. CS and level are exact.
		 */
		/** True when the role came from Smite rather than a declared position. */
		inferred?: boolean
	} | null
	allies: VisionStatePlayer[]
	enemies: VisionStatePlayer[]
	/** Most recent objective/kill events, already phrased. Newest last. */
	recentEvents: string[]
	/**
	 * The part that is actually worth saying out loud.
	 *
	 * A screenshot shows the player what they are already looking at. These are the facts they
	 * are NOT looking at: who on the enemy team is dead right now and for how long, gold sitting
	 * unspent, how their farm compares to their own average at this minute. All of it comes from
	 * the client or their own history, none of it is legible in a frame, and every line of it is
	 * checkable.
	 */
	unseen: string[]
	/**
	 * THE COACH'S OWN TRANSCRIPT — what it has already said out loud this game.
	 *
	 * The one fact about the conversation that no client and no screenshot can supply, and the
	 * only one that was missing. Measured on two models over the same 42 states of game
	 * 5635467422 (`data/eval/model-opus5.json`, `model-36flash.json`): Opus said some rewording of
	 * *your clear only gets faster while it keeps running* in 19 of its 38 lines, and Gemini
	 * reached 83% "useful" while repeating itself in 18 of 35. Both instruments that scored those
	 * runs scored one line at a time against the block it was holding, so neither could see it. A
	 * sentence that is true, grounded and actionable gets full marks on its tenth telling.
	 *
	 * Already RENDERED rather than structured, exactly as `championKnowledge` is in
	 * `live-coach-mode.ts`: the memory and its no-repeat gate live in `analysis/said.ts`, and
	 * `shared/` may not import `analysis/`. `renderSaid` produces this string; the daemon feeds it
	 * back in on the next turn.
	 *
	 * Optional because a game that has not been spoken into has no transcript, and because every
	 * `VisionState` in this repo's fixtures predates it. Absent means the coach has said nothing —
	 * which, unlike a missing baseline, is not a gap a model can fill with a guess.
	 */
	said?: string
	/**
	 * WHAT IS COMING — the map's own clock, and the only layer measured to change anything.
	 *
	 * See `objectiveSchedule` above for the run. Optional because it is computed from the event
	 * feed by the caller and because every fixture in this repo predates it; absent means the
	 * briefing simply has no schedule section, never that nothing is due.
	 */
	schedule?: ScheduledObjective[]
	/**
	 * THE ARC — what has changed over this game, already rendered by `analysis/arc.ts`.
	 *
	 * Pre-rendered for the same reason `said` is: `shared/` may not import `analysis/`. Carried
	 * with its measurement stated plainly — ninety seconds of exactly-computed history moved judged
	 * usefulness from 29% to 30% (p = 0.94) in the ladder run, so this section is here because it
	 * is cheap and occasionally carries a fact nothing else can (a five-minute farm stall with
	 * three deaths inside it), NOT because it was measured to help.
	 */
	arc?: string
	/**
	 * His measured career habits, one short spoken-ready line each, from `analysis/habits.ts`.
	 *
	 * Sentences rather than statistics, and that is a safety property. Handed the measurement
	 * behind a cue, this coach recompressed it and produced a false claim about his own record:
	 * given *"He is there at 8 minutes 31 games to your 12"* — a fact about PRESENCE at the grub
	 * pit — it said *"Enemies take them at 8 minutes in 31 games to your 12"*, which is a different
	 * and untrue statement, arrived at by faithful quotation. So the block carries only the finished
	 * sentence and the prompt forbids rewording it.
	 */
	habits?: string[]
}

export interface VisionStatePlayer {
	champion: string
	level?: number
	k?: number
	d?: number
	a?: number
	dead?: boolean
	respawnSec?: number
}

/*
 * The roster carries WHO and their score. Nothing else — no timers, and no death state.
 *
 * It went in two steps, both forced. It first printed `DEAD (14s)`, and the model read timers
 * straight off it, bypassing the vetted list: it announced two respawn timers to a player who was
 * himself dead for longer than both, a case the list had already correctly suppressed. Dropping
 * the seconds was not enough — with a bare `DEAD` it invented a timer to go with it ("Qiyana is
 * down for 8 seconds", when Qiyana had none), and announced "Graves is DEAD" to the last man
 * alive in a 1v4, which the fact list had also already suppressed.
 *
 * Anything the coach may say about who is down now comes from the vetted list, where the rules
 * about respawn length, alternation and being outnumbered all apply. The count is still available
 * as "Alive right now", which is the part that is useful without being a hook to invent from.
 */
const line = (p: VisionStatePlayer): string =>
	`${p.champion}${p.level ? ` lv${p.level}` : ""} ${p.k ?? 0}/${p.d ?? 0}/${p.a ?? 0}`

/** The authoritative block. Everything in it came from the client, not from the picture. */
export const renderState = (s: VisionState): string => {
	const me = s.me
	const hp = me.hp !== undefined && me.maxHp !== undefined ? `${Math.round(me.hp)}/${Math.round(me.maxHp)} HP` : ""
	/*
	 * The jungle race, worked out HERE rather than left as a subtraction for the model.
	 *
	 * Both figures are floored, so the difference the model would compute by eye is always a
	 * multiple of ten and always up to nine wrong in either direction. On 612 real blocks from four
	 * games every single reported gap was a multiple of ten — there is no state in which subtracting
	 * these two numbers gives a true one.
	 */
	const race =
		me.cs !== undefined && s.counterpart && s.counterpart.cs !== undefined ?
			csGap(me.cs, s.counterpart.cs, true)
		:	null
	const pace = s.pace ? csGap(s.pace.cs, s.pace.expected, false) : null
	return `## Ground truth (from the game client — these are FACTS, the screenshot is not)

Clock ${s.clock}.

You: ${me.champion}${me.level ? ` lv${me.level}` : ""} ${me.k ?? 0}/${me.d ?? 0}/${me.a ?? 0}${
		me.cs !== undefined ? `, ${csPhrase(me.cs)}` : ""
	}${hp ? `, ${hp}` : ""}${me.gold !== undefined ? `, ${Math.round(me.gold)} gold` : ""}${
		me.dead ? `, DEAD${me.respawnSec ? ` (respawn in ${Math.round(me.respawnSec)} seconds)` : ""}` : ""
	}

${
		/*
		 * THE PRONUNCIATION GUIDE IS NO LONGER IN THE BLOCK, and this is why.
		 *
		 * It was a line reading `Briar = BRY-er`, introduced as "write them normally, just
		 * pronounce them this way". The model read the RESPELLING out loud instead: "BRY-er is
		 * still at 0 CS", to the player, in a real game, repeatedly. A name he cannot recognise is
		 * worse than one said slightly wrong.
		 *
		 * The mistake was putting an INSTRUCTION inside the CONTENT. Everything else in this block
		 * is a fact to be spoken, so a line shaped like data was treated as data. Pronunciation
		 * belongs in the system prompt where instructions live. Parked, not deleted:
		 * `knowledge/pronunciations.md` and `shared/pronounce.ts` are untouched and still tested.
		 */
		""
	}${
		s.counterpart ?
			`Enemy jungler right now: ${s.counterpart.champion}${
				s.counterpart.inferred ? " (identified by Smite, so treat the role as a strong guess)" : ""
			}${s.counterpart.cs !== undefined ? `, ${csPhrase(s.counterpart.cs)}` : ""}${
				s.counterpart.level !== undefined ? `, level ${s.counterpart.level}` : ""
			}. This is the man he is racing, and comparing him to it is the most useful thing you can do. It says how much has been cleared and NEVER where anyone is. His GOLD is not listed and is not knowable — the client does not report an enemy's gold, so any gold figure you have belongs to the player.${
				race ?
					csGapWorthSaying(race) ?
						race.direction === "ahead" ?
							` The race, worked out from those two floors: he is at least ${race.certain} CS BEHIND you.`
						:	` The race, worked out from those two floors: he is at least ${race.certain} CS AHEAD of you.`
					:	" The race, worked out from those two floors: the two of you are inside the client's rounding of each other, so nobody can say who is ahead — do not."
				:	""
			}

`
		:	""
	}Farm baseline (CONTEXT ONLY — never say this unless it also appears in the list below): ${
		s.pace && pace ?
			`${csPhrase(s.pace.cs)} against ${s.pace.expected}, ${s.pace.source}${
				s.pace.exact ? "" : " (approximate)"
			} — ${
				csGapWorthSaying(pace) ?
					pace.direction === "ahead" ?
						`at least ${pace.certain} CS AHEAD of his own average.`
					:	`at least ${pace.certain} CS BEHIND his own average.`
				:	"his CS is rounded down by more than the difference between those two numbers, so he is neither measurably ahead nor behind. Do not say he is either."
			}`
		:	"NONE — you have no average to compare his farm against right now, so do not say whether it is ahead, behind, on pace, or what he usually gets. Say the CS and say you cannot compare it."
	}

Your team: ${s.allies.map(line).join(" · ") || "unknown"}

Enemy team: ${s.enemies.map(line).join(" · ") || "unknown"}

Alive right now: ${1 + s.allies.filter(p => !p.dead).length - (s.me.dead ? 1 : 0)} of yours against ${s.enemies.filter(p => !p.dead).length} of theirs.
${s.recentEvents.length > 0 ? `
Just happened: ${s.recentEvents.join("; ")}` : ""}${
		s.unseen.length > 0 ?
			`

### What he is NOT looking at — prefer these

${s.unseen.map(u => `- ${u}`).join("\n")}`
		:	/*
			 * Say "nothing" explicitly rather than omitting the section.
			 *
			 * An absent heading is ambiguous, and a model asked to coach from an ambiguous block
			 * fills the gap. Measured: at a tick where nobody was dead and the list was empty, the
			 * coach announced a death that had not happened — right roster, invented event. Naming
			 * the empty case removes the gap to fill.
			 */
			`

### Nothing he is missing right now

There is no fact worth interrupting him for at this instant. Unless the video shows something
plain and urgent, the correct answer is PASS.`
	}

${s.said ? `${s.said}\n\n` : ""}**The ten champions above are the only champions in this game.** Never name any other. Never
give a number that is not in this block, and take every timer from the list below rather than
inferring one — you cannot read health bars, gold or scores off a
downscaled screenshot accurately, and you do not need to, because they are right here.

**Every CS figure above is a FLOOR, and he can see the real one.** The client reports farm in tens
and rounds down, so a block that says 40 is a HUD that says anything from 40 to 49. Say it the way
it is written — "at least 40 CS" — and never a bare CS count, a rounder-sounding one, or a
difference you worked out yourself. Any comparison worth making has already been made above, as the
part of the gap that survives the rounding.

**The video is context, not a source — and that includes positions.** Measured on this app's own
frames: asked where the champions were on the screenshot it sends you, the answer was a median 43%
of the map's width from the truth and matched its own previous answer about the same picture 5 times
in 60. That is not reading a minimap, it is imagining a game of League. Where anybody is has either
been worked out for you and put in the list above, hedged, or is not known at all. If a position is
not in the list, you do not know it, and there is nothing on screen you may fill the gap with.`
}

/**
 * WHO is dead, by name — the fault the ablation's judge caught this architecture committing.
 *
 * The block gives an alive COUNT and no names, and a count is an invitation: "clear her top jungle
 * while she is dead" was said at 22:03 of a real game in which nobody was down at all. The names
 * are sitting in `allPlayers` and always were, so the guess becomes a fact for the price of one
 * line.
 *
 * NO SECONDS, and that is not an oversight. The block printed `DEAD (14s)` once; the model read
 * timers straight off the roster, bypassing every rate-limit the ranker applies, and announced two
 * respawn timers to a player who was himself dead for longer than both. Dropping the seconds and
 * keeping the bare `DEAD` was not enough either — it invented a timer to go with the word. Names
 * answer "who", which is what was actually missing; the ranked list still owns "for how long".
 */
export const downLine = (s: VisionState): string => {
	const mine = [
		...(s.me.dead ? [`you (${s.me.champion})`] : []),
		...s.allies.filter(p => p.dead).map(p => p.champion)
	]
	const theirs = s.enemies.filter(p => p.dead).map(p => p.champion)
	if (mine.length === 0 && theirs.length === 0)
		return "Down right now: nobody — every champion named above is alive this instant."
	return (
		`Down right now (WHO is dead; this line never says for how long). ` +
		`Theirs: ${theirs.length > 0 ? theirs.join(", ") : "nobody"}. ` +
		`Yours: ${mine.length > 0 ? mine.join(", ") : "nobody"}. ` +
		`Anyone not named here is alive.`
	)
}

/* ================================================================== the briefing */

/**
 * THE BRIEFING — the block rebuilt around what was measured, and the shipped default.
 *
 * `renderState` above is a SNAPSHOT: who is alive, everyone's CS, the score, the clock, his gold.
 * Every line derivable from it describes the instant, and the instant is what the man is already
 * looking at. That was the diagnosis. It is half right, and the half that is wrong matters more
 * than the half that is right, so both are written down here rather than in a commit message.
 *
 * ## What the ladder actually measured (`data/eval/why-shallow.md`)
 *
 * Nine arms, one model at temperature zero, 88 real states from three of his own recorded games
 * replayed in order, every line judged blind with the arm labels stripped and all arms' candidates
 * shuffled into one anonymous list. Each arm is the one before it plus one layer:
 *
 *     block only (what shipped)                29% useful
 *     + ninety seconds of exact history        30%   p = 0.94    NOTHING
 *     + the objective schedule                 55%   p = 0.0009  the whole effect
 *     + his measured career habits             51%   no gain on the schedule
 *     + everything she has already said        48%   no gain, and no repetition gain either
 *     block only, PROMPTED to prefer objectives 37%  p = 0.30 against the block; loses to the schedule
 *
 * So a briefing beats a snapshot by a lot, and almost none of it is the time dimension. Lines whose
 * premise spanned time scored 45% against 37% for lines about the instant — inside every arm's own
 * interval. What separates the arms is the SUBJECT: a neutral objective 61% useful over 211 judged
 * lines, an enemy being down 41%, gold 32%, and farm, CS, clearing and routing **4%, three useful
 * lines out of eighty-four** — the subject `live-facts.ts` ranks first and the shipped coach spends
 * a fifth of its lines on.
 *
 * ## Which is why the ORDER of this document is the design
 *
 * A block is read top-down and the top is what gets used. The schedule is first because it is the
 * only measured effect. The board — who is down, what just happened — is second at 41%. The jungle
 * race and the farm baseline are near the BOTTOM, unchanged in their arithmetic and demoted in
 * their position, because they are the 4%. Nothing is gagged: the numbers are all still here, and
 * the fence's instruction-shaped labels ("CONTEXT ONLY — never say this") are gone, because
 * instructions inside content get read out loud in this app. That is not a theory: a pronunciation
 * table shaped like data was spoken verbatim to the player mid-game, and the prompt is where the
 * ranking rule now lives.
 *
 * ## Where the layers with no measured gain sit, and why they are here at all
 *
 * `arc`, `habits` and `said` are carried LAST, after the material that pays. Each was measured to
 * add nothing on top of the schedule, and each occasionally carries a fact nothing else in the app
 * can reach — a five-minute farm stall with three deaths inside it, a career count, the fact that
 * she already said this. They cost a few hundred characters and they are the cheapest thing here to
 * remove if latency ever needs them gone.
 */
export const renderBriefing = (s: VisionState): string => {
	const me = s.me
	const hp = me.hp !== undefined && me.maxHp !== undefined ? `${Math.round(me.hp)}/${Math.round(me.maxHp)} HP` : ""
	const race =
		me.cs !== undefined && s.counterpart && s.counterpart.cs !== undefined ?
			csGap(me.cs, s.counterpart.cs, true)
		:	null
	const pace = s.pace ? csGap(s.pace.cs, s.pace.expected, false) : null
	const schedule = renderSchedule(s.schedule ?? [])
	const sections: string[] = []

	sections.push(`## Ground truth — from the game client. These are FACTS; the screenshot is not.

Clock ${s.clock}. You: ${me.champion}${me.level ? ` lv${me.level}` : ""} ${me.k ?? 0}/${me.d ?? 0}/${
		me.a ?? 0
	}${me.cs !== undefined ? `, ${csPhrase(me.cs)}` : ""}${hp ? `, ${hp}` : ""}${
		me.gold !== undefined ? `, ${Math.round(me.gold)} gold` : ""
	}${me.dead ? `, DEAD${me.respawnSec ? ` (respawn in ${Math.round(me.respawnSec)} seconds)` : ""}` : ""}`)

	/*
	 * THE PASS OFFER, and it is FIRST because a block is read top-down and the top is what gets used.
	 *
	 * Gemini's blind judge asked for this in the other direction: if the only thing a line would
	 * carry is a countdown, a gold total, an HP bar or a death state, the block should offer PASS
	 * rather than hope the model declines — fifteen of that judge's forty-six lines were a countdown
	 * plus the obvious action. A prompt rule asking for restraint is a plea; this is the app doing
	 * the arithmetic and stating the answer.
	 *
	 * It fires only when EVERY scrap of news in this block is on his screen already — see
	 * `screenSplit`. It is not a rule against visible facts, which would be the expensive mistake:
	 * visible AND specific is the best quadrant in the corpus at 67% over 205 judged lines, and the
	 * lines it kills are the other quadrant, visible and generic at 14%.
	 *
	 * The picture keeps an escape, and it is cheap. FENCED+SEE — the shipped prompt plus explicit
	 * permission to speak from the screenshot, on a byte-identical block — spoke on exactly the same
	 * 3 of 42 frames as FENCED, so permission has never been what makes this coach talk. Leaving the
	 * door open costs nothing measurable and keeps the one channel that can carry a fact the block
	 * cannot.
	 */
	if (hudOnlyTurn(s))
		sections.push(`### Nothing in this block is off his screen — the answer this turn is PASS

Everything below he is reading right now: his own bar and his gold, the clock, the kill feed, and a
spawn countdown his minimap prints exactly and earlier than this block can. There is no fact here he
could not have got by looking, so the only sentence available is a number in front of him followed
by the instruction that number implies for anybody — and that is the one shape measured to be worth
nothing.

Answer PASS, unless the picture shows something plain and urgent that nothing below carries.`)

	/*
	 * The schedule leads. When there is none — no event feed, a fixture built before this existed —
	 * the absence is STATED. Measured on the empty ranked list: a heading that simply vanishes is a
	 * gap, and at a tick where nobody was dead and the list was empty this coach announced a death
	 * that had not happened. Naming the empty case removes the gap to fill.
	 */
	sections.push(
		schedule !== "" ? schedule : (
			`### What is coming\n\nNo objective clock is available this turn, so you do not know when anything spawns.`
		)
	)

	sections.push(`### The board

${downLine(s)}
Alive right now: ${1 + s.allies.filter(p => !p.dead).length - (s.me.dead ? 1 : 0)} of yours against ${
		s.enemies.filter(p => !p.dead).length
	} of theirs.
Your team: ${s.allies.map(line).join(" · ") || "unknown"}
Enemy team: ${s.enemies.map(line).join(" · ") || "unknown"}${
		s.recentEvents.length > 0 ? `\nJust happened: ${s.recentEvents.join("; ")}` : ""
	}`)

	/*
	 * The ranked list is split by the same rule as the schedule, and for the same measured reason.
	 *
	 * The ranker's own comment on the objective timer says it plainly — "a timer he can read is the
	 * definition of a readout" — and it rate-limits that fact hard rather than dropping it, because
	 * a coach with no timer invents one. Same treatment here: both halves are printed, and only the
	 * heading says which is which.
	 */
	const rankedOff = s.unseen.filter(u => factScreen(u) === "off-screen")
	const rankedHud = s.unseen.filter(u => factScreen(u) === "hud")
	if (rankedOff.length > 0)
		sections.push(
			`### Ranked highest by the app right now — a hint, not a menu\n\n${rankedOff
				.map(u => `- ${u}`)
				.join("\n")}`
		)
	else if (s.unseen.length === 0)
		sections.push(`### Nothing is ranked right now\n\nThe app has no ranked fact to offer at this instant.`)
	if (rankedHud.length > 0)
		sections.push(
			`### Also ranked, and every one of these is on his screen this instant\n\n${rankedHud
				.map(u => `- ${u}`)
				.join(
					"\n"
				)}\n\nRanked, then checked against his HUD — his gold, his own CS, the kill feed, the map's own countdown. Each on its own is a figure he can see plus the instruction it implies for anybody.`
		)

	if (s.arc && s.arc !== "") sections.push(s.arc)

	if (s.habits && s.habits.length > 0)
		sections.push(
			`### From his own finished games — say one of these as written or not at all\n\n${s.habits
				.map(h => `- ${h}`)
				.join("\n")}`
		)

	if (s.said && s.said !== "") sections.push(s.said)

	sections.push(`### The jungle race and his own pace

${
		s.counterpart ?
			`Enemy jungler: ${s.counterpart.champion}${
				s.counterpart.inferred ? " (identified by Smite, so treat the role as a strong guess)" : ""
			}${s.counterpart.cs !== undefined ? `, ${csPhrase(s.counterpart.cs)}` : ""}${
				s.counterpart.level !== undefined ? `, level ${s.counterpart.level}` : ""
			}. His gold is not knowable — the client never reports an enemy's gold, so any gold figure you have belongs to the player.${
				race ?
					csGapWorthSaying(race) ?
						race.direction === "ahead" ?
							` The race, worked out from those two floors: he is at least ${race.certain} CS BEHIND you.`
						:	` The race, worked out from those two floors: he is at least ${race.certain} CS AHEAD of you.`
					:	" The race, worked out from those two floors: the two of you are inside the client's rounding of each other, so nobody can say who is ahead — do not."
				:	""
			}`
		:	"Enemy jungler: not identified this game."
	}
Farm baseline: ${
		s.pace && pace ?
			`${csPhrase(s.pace.cs)} against ${s.pace.expected}, ${s.pace.source}${s.pace.exact ? "" : " (approximate)"} — ${
				csGapWorthSaying(pace) ?
					pace.direction === "ahead" ?
						`at least ${pace.certain} CS AHEAD of his own average.`
					:	`at least ${pace.certain} CS BEHIND his own average.`
				:	"his CS is rounded down by more than the difference between those two numbers, so he is neither measurably ahead nor behind. Do not say he is either."
			}`
		:	"NONE — there is no average to compare his farm against right now. Say the CS and say you cannot compare it."
	}`)

	sections.push(`**The ten champions above are the only champions in this game.** Never name any other, and never
give a number that is not written above.

**Every timer you say must be one written above.** Not a spawn time, a respawn, a camp or a count
you completed from what you know about League — the map's clock is in the schedule and nowhere else.

**Every CS figure above is a FLOOR, and he can see the real one.** The client reports farm in tens
and rounds down, so a block that says 40 is a HUD that says anything from 40 to 49. Say it the way
it is written and never a bare count, a rounder one, or a difference you worked out yourself.

**The video is context, not a source — and that includes positions.** Measured on this app's own
frames: asked where the champions were on the screenshot it sends you, the answer was a median 43%
of the map's width from the truth and matched its own previous answer about the same picture 5 times
in 60. Where anybody is has either been worked out for you above, hedged, or is not known at all.`)

	return sections.join("\n\n")
}
