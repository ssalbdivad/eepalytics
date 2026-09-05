/**
 * The four things this player, specifically, keeps doing — and the eleven he does not.
 *
 * ## Why a file of constants is the right shape
 *
 * Everything else the live coach knows it read off the client one second ago. That is why it is
 * shallow: the client's facts are the ones already on his screen, so a coach restricted to them
 * recites his own HUD. The single thing a coach who has watched you play has, and this app did
 * not, is knowing what YOU keep getting wrong. That cannot be computed from the instant; it is a
 * property of 66 games, and it belongs here as measured numbers rather than as a prompt sentence
 * a model might paraphrase into something untrue.
 *
 * The measurement is in `data/eval/his-habits.md` — corpus, controls, effect sizes, and the
 * rejections. This file is the shipped half of that document, and every figure in it appears
 * there. `HABITS[].figures` is the whole set of numbers a cue may contain, and
 * `habits.test.ts` enforces that mechanically: a digit in a cue that is neither a live reading
 * nor a declared figure fails the suite. A fabricated career statistic sounds exactly like a real
 * one, which is why the check is a test and not a convention.
 *
 * ## The control, and why most candidates died
 *
 * Every claim below is measured against THE ENEMY JUNGLER IN HIS OWN GAMES — same patch, same
 * bracket, same role, same map, picked by matchmaking rather than by us. It is the only available
 * answer to "is this him, or is this what junglers do?", and it killed most of what was tested.
 * He does NOT die in the enemy jungle (10.1 percent of deaths against the counterpart's 12.3), he
 * does NOT tilt after a death (a second death inside ninety seconds 12.8 percent of the time
 * against 21.0), he does NOT lose the CS race (behind by 1.8 to 4.4 at every checkpoint, never
 * significant), he does NOT miss his team's fights (in 76.2 percent of their three-plus-man kills
 * against 69.9), and he does NOT sit on gold once the test is clustered by game properly. Those
 * are in `HABIT_PROHIBITIONS`, because the most valuable thing 66 games bought is *not saying*
 * eleven true-sounding things.
 *
 * ## The quantisation that decided the shape of the first cue
 *
 * `scores.creepScore` from the Live Client Data API is quantised to MULTIPLES OF TEN. Checked
 * across every recorded session in `data/live-samples/` — 363, 213, 292 and 304 samples plus
 * today's capture — there is not one reading that is not a multiple of ten. In game 5635467422
 * the live value sat at 20 from 2:50 to 4:28 while the timeline shows 24 at 4:00.
 *
 * That kills the obvious form of the farm-pace habit: the gap it must detect at 4:00 is 6.4 CS
 * and the instrument's resolution is 10. What is exact is the TIME a decile is crossed, because
 * samples arrive every few seconds and `floor10(cs) >= 30` is true exactly when `cs >= 30` is.
 * So the cue asks "has he reached thirty yet, and what time is it", never "how much CS has he
 * got". Validated against the one game present in both sources, the interpolated timeline
 * crossing and the live decile crossing agree to within 17 seconds at five deciles.
 *
 * ## And why it is a fixed checkpoint rather than a rolling pace
 *
 * A leave-one-out "behind your own median pace" cue was built and measured before this one. It
 * fires at some point in 52 of 66 games, holds for a third of all checked minutes, and the games
 * where it fires by 10:00 win 53 percent against 53 percent for the games where it does not
 * (p = 0.96). Comparing a man to his own median puts half his games below it by construction.
 * That is the "true and useless" failure this app has been losing to, in numbers. The fixed early
 * checkpoint survives; the rolling comparison does not.
 *
 * Pure: no I/O, no clock, no memory. Rate limiting and alternation belong to `live-facts.ts`,
 * which owns the one mutable copy of what has already been said.
 */

/** The corpus every figure here was measured on. Quoted so a claim can be audited to a query. */
export const HABITS_CORPUS = {
	/** Ranked solo queue (`queueId` 420) games holding both a match and a timeline blob. */
	games: 66,
	wins: 35,
	losses: 31,
	/** His deaths, and his counterparts', across those games. */
	deaths: 336,
	controlDeaths: 424,
	firstGameIso: "2026-08-30",
	lastGameIso: "2026-09-05",
	measuredIso: "2026-09-05",
	report: "data/eval/his-habits.md"
} as const

/**
 * What a habit is about, in the same vocabulary `live-facts.ts` uses for `FactSubject`.
 *
 * Deliberately reusing that word: a habit cue and a client fact about the same topic are one
 * topic to the man listening, and the coach's global gap is applied per subject. A habit line
 * about his clear must compete with the farm facts, not stack on top of them.
 */
export type HabitSubject = "farm" | "objectives" | "vision"

/** How urgently a cue wants to be said, matching `live-facts.ts`'s `FactTier`. */
export type HabitTier = "expiring" | "standing"

export interface Habit {
	key: string
	subject: HabitSubject
	/** The claim, in one sentence, as it would be written down rather than spoken. */
	claim: string
	/** Sample size behind the claim. */
	n: number
	/** Effect size and test, verbatim, so a reader can judge the claim's strength beside it. */
	evidence: string
	/**
	 * Every number a cue for this habit is allowed to contain, besides live readings.
	 * `habits.test.ts` fails on any other digit reaching a spoken line.
	 */
	figures: readonly number[]
}

/* ================================================================ H1: the first clear */

/**
 * The CS deciles whose crossing time separates his wins from his losses, and the deadline.
 *
 * Interpolated from 66 timelines, then dichotomised: reaching 30 CS after 270 seconds went 6-15
 * (29 percent won) against 29-15 (66 percent) for reaching it by then, p = 0.0047; 40 CS after
 * 380 seconds went 5-13 (28 percent) against 30-17 (64 percent), p = 0.0091.
 *
 * The dichotomies are threshold-swept and therefore optimistic — the honest continuous strength
 * is d = -0.48, p = 0.058 on time-to-30-CS, and the direction is the same at every decile from
 * 20 to 100 and every cut from 260 to 320 seconds. They are used anyway because a cue needs a
 * moment to fire at, and the sweep is monotone and flat-topped rather than spiky.
 *
 * Deciles only. A non-decile target cannot be checked against a decile-quantised reading.
 */
export const CS_DEADLINE_SEC: ReadonlyArray<{ cs: number; bySec: number }> = [
	{ cs: 30, bySec: 270 },
	{ cs: 40, bySec: 380 }
]

/**
 * How long after a deadline the cue is still worth saying.
 *
 * The whole value of this line is that it lands while the clear can still be rescued, and the
 * gap it predicts widens from 8.6 camps at 5:00 to 15.6 by 20:00 whether or not anyone mentions
 * it. Ninety seconds late it is a post-mortem.
 */
export const CS_DEADLINE_GRACE_SEC = 90

/* ================================================================ H2: the grub window */

/**
 * The instant the two junglers' routes diverge, and it is one minute wide.
 *
 * Within 3000 units of the pit at exactly 8:00: him in 12 of 65 games, his counterpart in 31 of
 * 65 (z = -3.54, p = 0.0004; p about 0.004 Bonferroni-corrected over the ten minutes examined).
 * The shape around it is why this is a habit and not a statistic — he is there MORE than his
 * counterpart at 6:00 (20 against 6 percent), gone at 7:00 and 8:00, and back at 9:00 (42 against
 * 34). He checks topside as grubs spawn, leaves, the enemy commits at eight, and he returns to
 * find it finished: when the enemy takes the first grub he next reaches the pit a median of 54
 * seconds later.
 *
 * The cue therefore fires BEFORE 8:00, in the minute he historically spends walking away.
 */
export const GRUB_WINDOW_OPEN_SEC = 400
export const GRUB_WINDOW_CLOSE_SEC = 480

/* ================================================================ the habits themselves */

export const HABITS: readonly Habit[] = [
	{
		key: "slow-first-clear",
		subject: "farm",
		claim:
			"A slow first clear is his commonest repeated mistake and it is never made up: he is under 31 camps at 5:00 in 21 of 66 games, and that gap widens for the rest of the game.",
		n: 66,
		evidence:
			"camps at 4:00 are 27.2 in wins and 24.9 in losses (Welch d = 0.71, p = 0.0045, p about 0.027 corrected over the six checkpoints examined). Split the way the cue splits — late to 30 CS, past 270 seconds — 21 of 65 games qualify and 6 were won, against 29 of 44; the camp gap runs 6.8 at 5:00, 11.2 at 10:00, 15.5 at 15:00, 18.2 at 20:00, and 0 of those 21 games reach the on-time median camp count by 10:00. Not bought with a gank (0.86 early kills against 0.64, p = 0.36) and not an effect of losing (team gold lead -214 against +146, r = 0.185). Replicates in both date halves.",
		figures: [6, 10, 11, 21, 30, 40, 66]
	},
	{
		key: "grub-window",
		subject: "objectives",
		claim:
			"At 8:00 his counterpart is standing on the grub pit and he is not, in more than twice as many games.",
		n: 65,
		evidence:
			"within 3000 units of the pit at 8:00: him 12 of 65, counterpart 31 of 65 (z = -3.54, p = 0.0004). He is there more at 6:00 and back at 9:00; the first grub goes at a median of 9:00 and he arrives a median of 54 seconds after the enemy takes it.",
		figures: [8, 12, 31, 65]
	},
	{
		key: "topside-conceded",
		subject: "objectives",
		claim:
			"He wins the dragon and loses the early topside objective, which is the consequence of the grub window rather than a second habit.",
		n: 66,
		evidence:
			"grubs 84 against 111 (z = -1.93), heralds 21 against 41 (z = -2.54, p = 0.011), the two together 105 of 257 (z = -2.93, p = 0.003) — while dragons run 154 against 137 and barons 40 against 32. He is the agent: he personally kills 81 percent of his team's grubs and 90 percent of its heralds. The win link is correlational and is not claimed.",
		figures: [21, 41, 66, 154, 137]
	},
	{
		key: "over-wards",
		subject: "vision",
		claim:
			"He out-wards his opposite number in 85 percent of games, so a vision correction aimed at him is aimed at his best habit.",
		n: 61,
		evidence:
			"wards placed 10.9 per game against 6.6, more in 52 of the 61 games that were not tied (sign p < 1e-6); vision score 0.96 per minute against 0.84, higher in 47 of 65 (p = 0.0004). Ward CLEARING goes the other way (2.11 against 3.36) but only reaches p = 0.063 paired, so it is not shipped.",
		figures: [52, 61]
	}
]

const habit = (key: string): Habit => {
	const found = HABITS.find(h => h.key === key)
	if (!found) throw new Error(`no habit ${key}`)
	return found
}

/**
 * Things measured to be FALSE of this player, each with the number that killed it.
 *
 * This is not commentary. Every one of these was a live candidate, five of them are things
 * `AGENTS.md` currently instructs the coach to say, and a coach citing a pattern that is not real
 * is the fastest way to lose the man listening. A prompt builder should be able to read this list
 * and refuse the line.
 */
export const HABIT_PROHIBITIONS: readonly { claim: string; refutation: string }[] = [
	{
		claim: "He dies in the enemy jungle with no vision.",
		refutation:
			"34 of 336 deaths (10.1 percent) are in enemy territory against his counterpart's 12.3 (p = 0.35). Of 57 deaths before 10:00, three are. He dies in lanes (40 percent) and river (25 percent)."
	},
	{
		claim: "He is losing the CS race to the enemy jungler.",
		refutation:
			"paired at every checkpoint: -1.8 at 5:00, -2.4 at 10:00, -3.5 at 14:00, -4.4 at 20:00, -3.3 at 25:00. Best sign-test p = 0.077. This is what the shipped coach talks about most."
	},
	{
		claim: "He tilts after a death.",
		refutation:
			"a second death inside ninety seconds happens in 12.8 percent of his deaths and 21.0 percent of his counterpart's (z = -2.68, p = 0.007). CS per minute afterwards is 5.37 against 5.42."
	},
	{
		claim: "He dies too much.",
		refutation: "5.09 deaths per game against the counterpart's 6.42; fewer in 35 of 59 decided games."
	},
	{
		claim: "He gets collapsed on.",
		refutation: "three or more enemies credited in 48.5 percent of his deaths and 51.4 percent of his counterpart's."
	},
	{
		claim: "He sits on unspent gold.",
		refutation:
			"frame-level it looks certain (24.7 against 19.1 percent of frames over 1400 gold, p = 4e-5) and that test is pseudo-replicated. Clustered by game his mean unspent is higher in 37 of 66, sign p = 0.39."
	},
	{
		claim: "He backs late or holds too much before his first back.",
		refutation: "first gold drop over 400 after 3:00: median 300 seconds for both junglers, median 1040 gold held."
	},
	{
		claim: "He lives bot side and avoids topside.",
		refutation:
			"frames spent topside from 5:00 to 12:00: 46.8 percent him, 45.9 percent his counterpart (p = 0.73). The grub habit is a timing difference, not a geographic one."
	},
	{
		claim: "He misses his team's fights.",
		refutation:
			"credited in 76.2 percent of his team's three-plus-man kills after 8:00 against his counterpart's 69.9 (z = 2.90, p = 0.004). Kill participation 48.0 against 49.2 percent."
	},
	{
		claim: "He is absent from objective pits.",
		refutation:
			"present at some point in the grub window 41 of 66 against 47 of 66 (p = 0.27); herald window 39 against 37; dragon window 52 against 55. Only the 8:00 instant separates them."
	},
	{
		claim: "Clearing faster is what wins his games.",
		refutation:
			"whole-game camps per minute is 6.00 in wins and 4.69 in losses (d = 1.60) and is mostly reverse-causal — 5.02 when behind at 10:00, 6.16 when ahead. Inside the games even at 10:00 it falls to d = 0.92, p = 0.11."
	},
	{
		claim: "He takes lane waves instead of camps.",
		refutation:
			"true (19.1 against 15.0 percent of his farm, p = 0.0019) and not shipped: the same conditioning that killed the camps claim applies, and telling a jungler to take fewer waves mid-game is not a fix."
	}
]

/* ================================================================ the live surface */

/**
 * What a caller can supply from one Live Client Data poll. Every field is optional except the
 * clock, and every cue that needs a field is silent without it — a habit spoken from a missing
 * reading is the failure this whole app is built against.
 */
export interface HabitInput {
	/** Game clock, seconds. */
	tSec: number
	/**
	 * His total CS as the live client reports it — `allPlayers[me].scores.creepScore`, which is
	 * QUANTISED TO TENS. Pass it raw; the decile checks are exact under that flooring and nothing
	 * here divides it.
	 */
	cs?: number | null
	/** Void grubs taken so far, counted from `HordeKill` events by side. */
	grubs?: { mine: number; theirs: number } | null
	/** Rift heralds taken so far, from `HeraldKill` events by side. */
	heralds?: { mine: number; theirs: number } | null
	/** Habit keys already spoken this game. A habit is a career fact; it does not improve on repetition. */
	spoken?: readonly string[]
}

export interface HabitCue {
	/** The habit this came from — also the rate-limit key, one per game. */
	key: string
	subject: HabitSubject
	tier: HabitTier
	/** The line, written to be read aloud: units spelled out, no abbreviations, no percent signs. */
	text: string
	/** The measurement behind it, for logs and for the eval. Never spoken. */
	because: string
}

/**
 * The deadline that has just passed without him reaching its decile, if any.
 *
 * Returns the LATEST such deadline, so a man who is behind at both 30 and 40 hears the more
 * recent number rather than the older one.
 */
const missedDeadline = (
	tSec: number,
	cs: number
): { cs: number; bySec: number } | null => {
	let worst: { cs: number; bySec: number } | null = null
	for (const d of CS_DEADLINE_SEC) {
		if (cs >= d.cs) continue
		if (tSec < d.bySec || tSec > d.bySec + CS_DEADLINE_GRACE_SEC) continue
		if (!worst || d.bySec > worst.bySec) worst = d
	}
	return worst
}

/**
 * Every habit cue the state supports, ranked, most specific first.
 *
 * THE LINES ARE SHORT ON PURPOSE, and the length was measured rather than guessed. The first
 * drafts of these three ran 12.9, 9.3 and 11.4 seconds through `speechDurationSec` — a fit over
 * twenty-four of this coach's own lines rendered through real TTS — against a median of 3.9 for
 * everything the app already says. A twelve-second sentence is not a coaching line, it is a
 * monologue delivered over the fight it was about.
 *
 * Two things went, and the same reasoning cut both. The clock went: "it is 4 minutes 40 seconds"
 * is built at T and lands at T plus the pipe, so it is wrong on arrival, and he can read a clock.
 * The 11-camps-by-10-minutes clause went: it is the *reason* the habit matters and it belongs in
 * `because`, not in a sentence someone is trying to path through. What is left is the number he
 * cannot know and the thing to do about it.
 *
 * Both window cues are `expiring` for a reason beyond urgency. `live-facts.ts` withholds every
 * expiring fact from a turn-based provider, which is several seconds behind by construction —
 * and "you are not at 30 CS yet" spoken five seconds after he hit 32 is a fabrication, not a
 * late line.
 *
 * Ranked here rather than in the prompt for the reason recorded all over `live-facts.ts`:
 * ordering is a suggestion to a model and the contents of a list are not. A caller may take the
 * first and ignore the rest.
 */
export const habitCues = (input: HabitInput): HabitCue[] => {
	const said = new Set(input.spoken ?? [])
	const out: HabitCue[] = []
	const { tSec } = input

	/* --- H1: the clear, and only inside the window where it can still be rescued --- */
	const cs = input.cs
	if (cs != null && !said.has("slow-first-clear")) {
		const missed = missedDeadline(tSec, cs)
		if (missed) {
			const h = habit("slow-first-clear")
			out.push({
				key: h.key,
				subject: h.subject,
				tier: "expiring",
				text: `Not at ${missed.cs} CS yet. You started this slow 21 times and won 6.`,
				because: h.evidence
			})
		}
	}

	/* --- H2: the minute before the enemy jungler commits to grubs --- */
	const grubs = input.grubs
	if (
		grubs &&
		grubs.mine + grubs.theirs === 0 &&
		tSec >= GRUB_WINDOW_OPEN_SEC &&
		tSec <= GRUB_WINDOW_CLOSE_SEC &&
		!said.has("grub-window")
	) {
		const h = habit("grub-window")
		out.push({
			key: h.key,
			subject: h.subject,
			tier: "expiring",
			/*
			 * Every figure is from this cue's own `evidence` — "him 12 of 65, counterpart 31 of 65".
			 * The wording is not, and it had to change: the block tells the coach to say a career
			 * line AS WRITTEN, and claude-opus-5 obeyed exactly, reading *"He is there at 8 minutes
			 * 31 games to your 12"* out loud at 6:42 of game 5635467422
			 * (`data/eval/opus-briefing/ab-opus-frames.json`). Spoken, "8 minutes 31" is a clock and
			 * the sentence means nothing. The denominator is here for the same reason: "31 games to
			 * your 12" invites the listener to supply a total. The denominator both figures share
			 * (65) is left out only because the cue has a six-second speech budget its own test
			 * enforces, and the sentence went to 6.8 with it in.
			 */
			text: `Grubs still up. At eight minutes he is on that pit in 31 games and you in 12 — go.`,
			because: h.evidence
		})
	}

	/* --- H3: the consequence, said only once it has actually happened --- */
	const heraldLost = (input.heralds?.theirs ?? 0) > (input.heralds?.mine ?? 0)
	const grubsLost = grubs != null && grubs.theirs - grubs.mine >= 2
	if ((heraldLost || grubsLost) && !said.has("topside-conceded")) {
		const h = habit("topside-conceded")
		out.push({
			key: h.key,
			subject: h.subject,
			tier: "standing",
			text: heraldLost
				? `Herald gone. 21 to their 41, and you still win the dragon.`
				: `Topside again: 21 heralds to their 41, while you win the dragon.`,
			because: h.evidence
		})
	}

	return out
}
