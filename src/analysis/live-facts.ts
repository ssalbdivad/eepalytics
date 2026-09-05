/**
 * What the live coach is allowed to say, decided here rather than by the model.
 *
 * ## Why this is code and not prompt text
 *
 * Asked to "be actionable" from a screenshot, a vision model invents. The real session that
 * prompted all of this produced *"clear faster, you need to use more abilities"* said to someone
 * using abilities on cooldown — a claim nothing in the live data could have checked. So the model
 * does not derive facts. It is handed a short ranked list and may choose one and phrase it.
 *
 * ## Why the rate limiting is here too
 *
 * Every quality problem found by judging real sessions turned out to be structural, not tonal,
 * because most of these facts stay true for minutes:
 *
 *   - unspent gold was raised five times in nine turns;
 *   - the farm gap was recited three turns running with a widening number, which is nagging and,
 *     when the news is bad, just grinding someone down;
 *   - the same corpse was re-announced on every poll for its whole respawn — 40 of 55 spoken
 *     lines in one judged session were respawn timers, including one that chose a fourth
 *     Morgana timer over an explicit "1393g sitting unspent" sitting beside it in the list.
 *
 * "Please vary yourself" in a prompt does not survive that. Alternation, cooldowns and a cap do.
 *
 * ## And why a cooldown PER FACT was not enough either
 *
 * He shut the coach off mid-game at nine lines in four minutes, six of them about how much he had
 * cleared, two of those six quoting different averages for the same CS. Every cooldown above was
 * in force and not one of them had fired twice. A rate limit on each RULE does not bound the rate
 * of SPEECH: eleven rules that each speak once a game still talk over each other when they land
 * together, and three rules about farm are one topic to the man listening.
 *
 * So there are now two limits that belong to the coach rather than to any rule — `MIN_GAP_SEC` and
 * `ROUTINE_GAP_SEC`, applied to `Fact.subject` and `Fact.tier` — and facts are withheld rather than
 * consumed when they hit one. Measured by replaying a recorded 36-minute game against Briar — the
 * game he quit — from `daemon/live-sampler.ts`, through this file, at the shipped twenty-second
 * turn, with his real rolling baseline supplied:
 *
 *                            before    after
 *   lines per game           29        13
 *   lines per minute          0.79      0.35
 *   lines about his CS       12 (41%)   3 (23%)
 *   shortest gap               24s       49s
 *   gaps under a minute      16 of 28   1 of 12
 *
 * "You're N CS up on Briar" was eight of those twenty-nine, reciting a lead that grew on its own;
 * it is one line now. "You're ~27 CS down on your own pace" was said at 14:13, 24:23, 30:54 and
 * 35:23 with the number barely moving; it is said when the news gets worse.
 *
 * ## The contradiction, which was not a hallucination
 *
 * Two lines twenty-five seconds apart — "your 20 farm is not pacing to match your average of 30",
 * then "your 20 farm is not pacing to match your 28 CS average". Both figures were real: replaying
 * that game's own samples through `paceReading`, the block said `20 CS against 28` at 4:03 and
 * `20 CS against 30` at 4:21. The expected figure is interpolated from the game clock, so it climbs
 * about one CS every eight seconds — measured across that game it rose from 28 to 254 in the
 * 1957 seconds between those samples, roughly seven a minute — while his own CS sits still
 * between camps. Nothing was
 * invented; the coach read a moving number aloud twice and called it an average both times.
 *
 * Every farm sentence in this file therefore says "your own pace" and never "your average", the
 * two CS rules can no longer appear in one list (they share a subject), and neither may restate
 * itself unless the news has got worse. The block's own line is fenced as context in
 * `shared/live-prompt.ts` — it is `shared/live-state.ts` that decides whether it is printed at all
 * between the measured 10/14/20-minute checkpoints, and that is the durable fix.
 *
 * Note for anyone re-running this: `buildLiveStateForBench` passes NO baseline, so `pace` is null
 * in every state the shipped `scripts/bench-providers.ts --from-samples` replay produces — which
 * makes both CS rules structurally dead there, the farm one and the race one that needs his CS to
 * subtract from. The benchmark cannot see the subject this player quit over.
 *
 * ## Why the SCREENSHOT is now an input here, of all places
 *
 * Because it could not reach a sentence anywhere else. Two arms of 14 coaching turns, identical
 * blocks and prompt, differing only in whether the JPEG was attached, agreed on speak-or-PASS 13
 * times out of 14 and paraphrased each other where both spoke — while the same model read the game
 * clock off the same pictures 6 times out of 6. The model was looking. The list it is allowed to
 * speak from was computed entirely from the client, so what it saw had nowhere to go.
 *
 * `FactInput.frame` is that somewhere, and it is one field wide: which HALF of the map his own icon
 * was on. Enemy positions are the prize and they are measurably not shippable yet — see
 * `FrameObservation` for the numbers and for why 63% is a decision-sender rather than a dull line.
 * What the half does is turn client facts he can already read into instructions he cannot: an
 * objective timer becomes a rotation when he is on the wrong side of the map, and is withheld when
 * he is standing on the pit. It never speaks alone, it carries no subject of its own, and every path
 * that reads it falls back to today's sentence when it is missing, stale or doubted.
 *
 * ## The sentence is part of the arithmetic, and the pipe decides who may hear what
 *
 * Every rule above is about whether a fact is worth saying. Two more are about whether it is still
 * TRUE when the saying finishes, which nothing here checked for the app's whole life.
 *
 * A line is built at T and lands at T + provider latency + however long the sentence takes to say.
 * The second term is not small: rendered through real TTS, the coach's own lines run 2.1 to 7.5
 * seconds, median 3.9 (`analysis/timeliness.ts`). Replaying four recorded games through this
 * function and checking each offered line's premise against the sample nearest its last syllable —
 * 66 lines, 46 of them with a sample close enough to score:
 *
 *                     stale at 0s   at 5s   at 9s
 *   expiring facts       31%          34%     77%
 *   standing facts        9%          18%     18%
 *
 * At ZERO provider latency 8 of 18 window lines were already stale, purely because the sentence
 * takes 3.6 seconds to say and the countdown in it was computed before it started talking. Going
 * from 0s to 5s of latency does not move that figure at all. So there are two separate fixes and
 * they are not interchangeable:
 *
 *   1. THE PIPE. Every countdown is spoken as the figure it will BE — `heardBy` — and every floor
 *      is applied to that figure. Every sentence that expires is also shorter: the window line no
 *      longer reads his own respawn timer back to him (23 syllables to 14) and the rotation lost
 *      "it", "and", "start" and "now" (21 to 17). On the same replay that took expiring facts from
 *      31% stale to 9% at the socket's own latency, and window lines from 8 of 18 to 2 of 16.
 *   2. THE TIER GATE. A turn-based provider is several seconds behind by construction, so it is not
 *      offered a fact that expires at all — see `CoachPath`. Ordering is a suggestion to a model
 *      and the contents of the list are not, which is the lesson this file records four times.
 *
 * What arithmetic cannot reach is stated rather than papered over. Of the stale verdicts left at
 * the socket's latency, one is a man who died six seconds after the line was built while sitting at
 * 77% health, and two are gold lines said while he was in the fountain spending it — the first is
 * not a function of any state, and the second is only visible in the frame (`stranded`), which the
 * frameless replay cannot exercise.
 *
 * Pure: state goes in, state comes out. The daemon owns the one mutable copy.
 */

/** Riot's KillStreak counter, as words. */
const MULTI: Record<number, string> = {
	2: "double kill",
	3: "triple kill",
	4: "quadra kill",
	// Left shouting: it is a word people shout, and the game shouts it too.
	5: "pentakill"
}

/**
 * A death with less than this left WHEN HE HEARS IT is not worth a sentence.
 *
 * The floor used to be applied to the number on the scoreboard now, with the pipe hand-waved into
 * the constant. It is applied to the number he will actually hear now — `heardBy` — so the twelve
 * seconds are twelve real seconds of window rather than twelve minus however long the sentence
 * took. Measured over four recorded games, that alone drops the line "Zed is down 13 seconds",
 * which had 7 seconds left by the time its last syllable landed.
 */
export const DEATH_WORTH_SAYING_SEC = 12
/** Below this, unspent gold is not worth a sentence. */
export const GOLD_FLOOR = 1200
/** How much more must accumulate before unspent gold is news again. */
export const GOLD_STEP = 800
import { dragonPhrase } from "../shared/dragons.ts"
/*
 * MEASURED SPEECH, and it belongs here because the length of the sentence is part of whether the
 * sentence is true. `speechDurationSec` is a least-squares fit over twenty-four of these very
 * lines rendered through real TTS (n = 24, R2 0.895) — see `analysis/timeliness.ts`. Nothing else
 * in that module is imported: this file must not depend on the staleness CHECKER, or the ranker
 * would be graded against its own opinion of the world.
 */
import { speechDurationSec } from "./timeliness.ts"
import { withAdvice } from "../shared/champion-advice.ts"
import type { ChampionAdvice } from "../shared/champion-advice.ts"
/*
 * TYPE ONLY, which is what makes it legal from here.
 *
 * `analysis/` is the pure layer and `review/` sits above it, so a VALUE import would be a layering
 * inversion. A type is erased entirely under `--experimental-strip-types`, so this costs nothing at
 * runtime and buys the one thing that matters: the frame reader and the coach use ONE word for a
 * half of the map. A second copy of that union is a copy that drifts, and the drift would show up
 * as a gate that silently stopped firing.
 */
import type { Coarse } from "../review/frame-read.ts"

/**
 * Recognises a death-window fact in a rendered line.
 *
 * NO LONGER LOAD-BEARING, and that is the point. The "never lead with a death twice running" rule
 * used to be enforced by running this regex over the rendered sentence, which is how it silently
 * stopped working the last time the wording changed. Alternation is now decided on `Fact.subject`,
 * a field, before any string exists. This is kept because the tests read better asserting against
 * the shape of a line than against an internal tag.
 */
export const DEATH_FACT = / is down \d+ seconds/

/**
 * What a line is ABOUT, as far as the man hearing it is concerned.
 *
 * The alternation rule used to be per-fact — one flag for deaths, a cooldown for farm, a cooldown
 * for gold. That is the wrong unit, and a real transcript proved it: nine lines in four minutes,
 * six of them about how much had been cleared, produced by three different rules none of which had
 * fired twice. He does not hear "the farm-pace fact" and "the counterpart-CS fact", he hears
 * someone talking about his farm again.
 *
 * So `farm` covers his own pace, the race against the enemy jungler, and the comeback line: three
 * generators, one subject, one budget. `downed` covers both a single respawn timer and a
 * two-are-dead window for the same reason.
 */
export type FactSubject =
	| "fight"
	| "objective-lost"
	| "downed"
	| "objectives"
	| "farm"
	| "gold"
	| "levels"
	| "build"
	| "kill-share"
	| "praise"
	| "your-death"

/**
 * How badly this line needs to be said NOW, which is the only thing that can buy it a short gap.
 *
 * - `interrupt` — the enemy just took Baron, or a fight just happened without him. Worth cutting
 *   in on anything; both are rare and both are already announce-once.
 * - `expiring` — a respawn window, an objective timer, a level gap with drake up. True for
 *   seconds, so it is worth the shorter floor and worthless after it.
 * - `standing` — farm, gold, the objective count. True for minutes. There is no such thing as
 *   needing to hear one of these within two minutes of the last thing that was said.
 */
export type FactTier = "interrupt" | "expiring" | "standing"

/**
 * WHO IS GOING TO SPEAK THIS, and it decides what may be in the list at all.
 *
 * The two shapes of this app differ by an order of magnitude in how long a line takes to arrive.
 * The Gemini socket is about a second; every turn-based provider is several, because the sentence
 * is written and paid for before its first syllable. That is not a quality difference to apologise
 * for in the settings screen, it is a difference in WHICH FACTS ARE STILL TRUE on arrival, and it
 * is measured.
 *
 * Over four recorded games replayed through this function at the shipped twenty-second turn — 66
 * offered lines, 46 of them with a real sample within six seconds of the last syllable to check
 * against:
 *
 *                     stale at 0s   at 5s   at 9s
 *   expiring facts       31%          34%     77%
 *   standing facts        9%          18%     18%
 *
 * A turn provider cannot be trusted not to pick the reactive line, because ordering is a
 * suggestion to a model and the contents of the list are not — that lesson is recorded four times
 * in this file. So it is not offered one. `path: "turn"` removes every reactive fact from the list
 * before ranking, which makes the socket the only path that can carry one.
 */
export type CoachPath = "socket" | "turn"

/**
 * How long after the state is read the first syllable lands, by shape.
 *
 * The socket figure is the one this app has always quoted for Gemini Live. Five for a turn is the
 * middle of what `web/lib/turnCoach.ts` measured on the HTTPS path — about two and a half seconds
 * for a fast model and fifteen for a reasoning model's first answer — and a caller that has
 * measured its own provider should pass `pipeSec` instead of accepting it.
 */
export const SOCKET_PIPE_SEC = 1
export const TURN_PIPE_SEC = 5

export interface FactOptions {
	/** Which shape will speak it. Defaults to `socket`, which is what every caller was before. */
	path?: CoachPath
	/** Seconds between this state being read and the first syllable. Defaults from `path`. */
	pipeSec?: number
}

/**
 * One thing the coach may say, with everything needed to decide whether it should be said.
 *
 * `commit` is the memory write that marks the fact as spent, and it runs ONLY if the fact makes it
 * into the offered list. That split matters: with a global floor in place, facts are now routinely
 * built and then withheld, and a fact that burns its own cooldown while being withheld is a fact
 * that is never said at all. The old code wrote memory as it built, which was harmless when almost
 * everything built was offered and is not harmless now.
 */
interface Fact {
	text: string
	subject: FactSubject
	tier: FactTier
	commit?: () => void
}

/*
 * UNITS ARE SPELLED OUT, EVERY TIME. These strings are the script — the model reads them almost
 * verbatim and a native-audio voice pronounces what it is given. "52s" came out as "fifty two
 * seds" and "1334g" as a letter, in a real game, out loud. There is no abbreviation here that is
 * worth a syllable of nonsense: write "seconds", "gold", "minutes".
 */

/**
 * How long an enemy objective take is still worth saying. Baron lasts three minutes; a take he
 * heard about four minutes later is history, not coaching.
 */
const ENEMY_OBJECTIVE_WORTH_SAYING_SEC = 45

/**
 * How long after a lost Baron or Herald the small talk stays off.
 *
 * Not a ranking tweak — a blackout. Ranking alone puts farm back on the next turn, twenty seconds
 * after the game may have been decided.
 */
const DISASTER_QUIET_SEC = 90

/**
 * How far apart the two junglers must be before it is worth saying. Under this it is one camp of
 * timing noise, and a coach that reads out a four-CS difference is the farm nag with a new subject.
 */
const RACE_MIN_GAP = 14

/**
 * When the jungle CS race stops being a QUESTION, and is therefore retired for the game.
 *
 * Measured over all four of his recorded games, and it is the mechanism behind the repetition:
 *
 *     game       him            his CS/min   counterpart      theirs
 *     split-01   Lillia 300        8.5       Karthus 160       4.5
 *     split-02   Lillia 300        8.4       Zed 100           2.8
 *     split-03   Lillia 220        6.0       Briar 90          2.4
 *     split-04   Lillia 180        6.1       Tryndamere 110    3.7
 *
 * **He wins it four games out of four, by about a factor of two, and is ahead by minute five in
 * every one.** So the block's only cross-player comparison returns the same verdict on every turn
 * of every game, and the advice that follows ("keep clearing") is the same on every turn too. In a
 * real Opus run, 30 of 38 lines in the first seven minutes were this race and 28 of them ended on
 * some rewording of *keep the route running*.
 *
 * That is worse than repetition: the coach spends its whole life praising THE ONE THING HE IS
 * ALREADY BEST AT IN THE LOBBY. A fact that has stopped being a question is not information, and
 * refining it — tighter thresholds, better phrasing — only polishes the most useless thing it says.
 *
 * So: once he has led by a decisive margin for long enough, the race is settled and stays retired
 * until it FLIPS. Un-retiring on a flip is the point — a settled race becoming a question again is
 * genuinely worth hearing, and it is the only time this fact ever was.
 */
const RACE_SETTLED_GAP = 30
const RACE_SETTLED_HOLD_SEC = 99999

/** Before this the clear has barely started and the gap is whoever pathed to the bigger camp. */
const RACE_MIN_SEC = 5 * 60

/**
 * A level gap this size is a real power difference rather than one camp of timing, and it is the
 * gate on saying "don't". Two levels is the classic solo-queue coinflip a jungler should decline.
 */
const RESTRAINT_LEVEL_GAP = 2

/**
 * Between objective calls.
 *
 * The timer is on his HUD, so this is a readout with one redeeming feature: it says where to BE
 * rather than what just happened. Simulated over a full game at a shorter cooldown it was still
 * half of everything the coach said, which is far too much weight for a number he can read. Seven
 * minutes puts it at three or four calls a game and leaves room for the facts he cannot see.
 */
const OBJECTIVE_CALL_COOLDOWN_SEC = 420

/** An objective is "live" for restraint purposes when it is this close. */
const OBJECTIVE_SOON_SEC = 45

/**
 * Kill-participation gap worth a sentence, in percentage points.
 *
 * Below this it is one skirmish of variance. At this size he is genuinely being left out of his
 * team's fights, which is a different failure from being behind on CS and has a different fix.
 */
const KP_MIN_GAP_PCT = 25

/** Before this there are too few kills for a share to mean anything. */
const KP_MIN_SEC = 10 * 60

/**
 * How far behind on objectives before it is worth a sentence, and how early.
 *
 * Two is the point at which it stops being one contested pit and starts being a pattern — and for
 * a jungler an objective deficit is the job description rather than a statistic.
 */
const OBJECTIVES_MIN_GAP = 2

/** Before this there have not been enough objectives for a count to mean anything. */
const OBJECTIVES_MIN_SEC = 8 * 60

/** Game-clock seconds between counterpart mentions. */
const RACE_COOLDOWN_SEC = 150

/**
 * How much of a deficit he must claw back before it is worth celebrating.
 *
 * Smaller than the gap that earns a criticism, deliberately: a recovery is harder than a decline
 * and he should hear about it sooner. Said once, because the point is the turnaround rather than
 * a running commentary on the same race.
 */
const RACE_SWING = 10

/**
 * How much the race must have turned AGAINST him before it is worth raising a second time.
 *
 * Against him, not merely different. Replayed over a real game, an unsigned "the gap moved" test
 * produced "you're 20 CS up on Karthus", then 40, 50, 60, 100 and 130 — six lines reciting a lead
 * that was growing on its own, which is the same widening-number nag this file already refuses to
 * do with his farm pace, wearing the counterpart's name. A lead getting bigger is not news and
 * carries no decision; the race getting worse is both. The good-news case has its own rule and its
 * own sentence: the swing, above, which fires when he claws a real deficit back.
 */
const RACE_GAP_MOVED = 8

/** Game-clock seconds between farm-pace mentions. */
export const FARM_COOLDOWN_SEC = 180
/**
 * How big the gap must be before it is worth a sentence.
 *
 * Was 12, which fired at "20 against your usual 32" — four minutes in, a two-camp difference, and
 * he heard about it five times in eleven minutes. Early gaps are noise: the expected curve is
 * steep, one slow camp swings it, and there is nothing to DO about being two camps down at four
 * minutes. Raised, and floored by an absolute CS count so the early game stays quiet.
 */
const FARM_MIN_GAP = 20

/** Below this much farm the comparison is arithmetic on a small number, not a coaching point. */
const FARM_MIN_CS = 70

/** His CS must have moved at least this much before the farm gap is worth restating. */
export const FARM_CS_MOVED = 15

/**
 * How much WORSE the deficit must have got before it is worth restating.
 *
 * The cooldown and the CS-moved test are both about whether time has passed, and neither is about
 * whether anything has changed. Measured over a real 36-minute game they let through "you're 27 CS
 * down on your own pace", then 29, then 29, then 26, then 40 — five lines, five minutes apart,
 * saying the same thing. His CS had moved every time, because it always does; the news had not.
 *
 * So a re-mention needs the gap to have moved AGAINST him, measured against the figure last SAID
 * rather than last computed. Ten CS is about a camp and a half — under that it is the noise of one
 * slow clear, and it is not a second thing to tell him. A deficit that is shrinking, or a lead that
 * is growing, never re-fires at all: the first is his own doing and the second is not a problem.
 */
export const FARM_GAP_WORSE = 10
/** Gold still unspent after this long has earned a second mention on its own. */
/**
 * Gold must have been unspent this long before it is worth a sentence at all.
 *
 * He can read the number; what he cannot feel is that it has been sitting there while recalls went
 * by. Measured over a simulated game, without this gate gold was two thirds of everything the
 * coach said.
 */
export const GOLD_MIN_HELD_SEC = 150

/** A reminder repeated is a nag. Three in a game is already generous. */
export const GOLD_MAX_PER_GAME = 3

export const GOLD_NAG_SEC = 240
/** Both must have at least this long left for a multi-kill window to be worth calling. */
export const WINDOW_MIN_SEC = 10

/** Never offer more than this many facts — the model takes the top one most of the time. */
export const MAX_FACTS = 3

/**
 * The floor between ANY two lines, in game-clock seconds. The single most important number here.
 *
 * He quit a session that ran at nine lines in four minutes — one every twenty-five seconds. Every
 * per-fact cooldown in this file was already in force at the time and not one of them had fired
 * twice, because a rate limit per FACT does not bound the rate of SPEECH: eleven different rules
 * each speaking once a game still talk over each other if they happen to land together.
 *
 * Forty-five seconds is not a taste call. A line takes about three seconds to say, and every
 * useful thing this coach says is an instruction — reroute, take the camp that is up, decline the
 * fight, go and spend. Acting on one of those takes a jungler somewhere between ten and thirty
 * seconds. A second instruction arriving before the first has been carried out does not add to it,
 * it REPLACES it, so a gap shorter than the time to act spends a turn cancelling the previous
 * turn. Forty-five seconds is the shortest gap at which the previous line has plausibly been
 * acted on.
 *
 * Measured on a replay of a real 36-minute game at the shipped 20-second turn: before this,
 * 11 of 22 gaps between offers were under a minute and five window lines landed inside 93
 * seconds. See the module comment for the after.
 */
export const MIN_GAP_SEC = 45

/**
 * The floor before a fact that is NOT expiring may follow anything else.
 *
 * Farm, gold, the objective count and the enemy jungler's build are all true for minutes. None of
 * them is more useful said at 60 seconds than at 120, and all of them are the ones that turn into
 * nagging, because the state that produced them is still there next turn and the turn after.
 *
 * Two minutes off the LAST LINE OF ANY KIND, deliberately, not off the last line of the same kind.
 * That is the whole difference between this and the per-fact cooldowns that failed: it is a budget
 * on the coach, not on the rule.
 */
export const ROUTINE_GAP_SEC = 120

/**
 * How old a frame read may be before it is about somewhere else.
 *
 * A jungler crosses from his topside jungle to the drake pit in the high teens of seconds, so a
 * read older than that can be exactly INVERTED — topside when the picture was taken, standing on
 * drake when the sentence is spoken. An inverted half is worse than no half at all, because the
 * sentence it produces is specific and confident and sends him back the way he came. Ten seconds
 * sits inside a crossing and outside the five-second frame cadence, so the previous frame still
 * counts and the one before it does not.
 */
export const FRAME_FRESH_SEC = 10

/**
 * Which half of the map each objective is on. Absolute, and that is exactly why it is safe.
 *
 * The minimap does not rotate: blue's base is bottom-left and red's is top-right in every frame,
 * so the dragon pit is bottom-right and Baron's is top-left whoever is playing. `coarseOf` maps
 * both teams' top-half zones to `topside` for the same reason. So nothing in this file ever has to
 * work out which side he is on from ring colours — the one inference in a minimap read that has no
 * ground truth attached and that would invert every answer if it went wrong.
 *
 * Herald shares Baron's pit, so it shares Baron's side.
 */
const OBJECTIVE_SIDE: Record<string, Coarse> = {
	Baron: "topside",
	Herald: "topside",
	Drake: "botside"
}

/**
 * How far the game clock may jump backwards before it means a new game rather than poll jitter.
 *
 * The same figure `daemon/live-sampler.ts` uses to roll a sample session, and for the same reason:
 * two reads a second apart can disagree by a little, a game restarting disagrees by minutes.
 */
export const CLOCK_BACK_SEC = 30

/**
 * Everything the ranker must remember between turns.
 *
 * Explicit rather than module-level so it can be constructed per game and asserted in a test —
 * the previous version kept it in module scope, where the alternation rule was unobservable.
 */
export interface FactMemory {
	announcedDeaths: Set<string>
	/** Enemy objective takes already announced, keyed by name+time. */
	announcedLosses: Set<string>
	announcedEvents: Set<number>
	/** Praise lines already used verbatim, so the same congratulation is never repeated. */
	praiseSaid: Set<string>
	lastGoldMentioned: number
	/** When gold was last raised, so persistent unspent gold can earn a second mention. */
	lastGoldAtSec: number
	/** When it first crossed the threshold — the duration is measured from here, not the mention. */
	goldSinceSec: number
	lastFarmAtSec: number
	/** When the counterpart gap was last raised, and how big it was then. */
	lastRaceAtSec: number
	lastRaceGap: number
	/**
	 * The clock at which he first held a decisive jungle-CS lead, or 0 when he does not hold one.
	 *
	 * Not a boolean, because the race must be able to become a QUESTION again: he wins this race in
	 * four recorded games out of four, so a one-way latch would retire the fact in every game and
	 * never bring it back, and a settled race flipping is the only time it was ever worth hearing.
	 */
	raceSettledSince: number
	/** Said once each per game — a level gap is a state, not an event, and restating it is nagging. */
	saidRestraint: boolean
	saidLevelGap: boolean
	/** Legendary items already announced for the counterpart, and whether a baseline exists yet. */
	seenCounterpartItems: Set<string>
	sawCounterpartBuild: boolean
	/** Said once per game — a participation gap is a pattern, not an event. */
	saidKillShare: boolean
	/** The champion's death note is a property of the champion, so it is said once. */
	saidOwnDeath: boolean
	/** The comeback is celebrated once — the point is the turnaround, not a commentary. */
	saidSwing: boolean
	/** The objective deficit is a state, said once. */
	saidObjectives: boolean
	/** How many gold reminders this game — hard-capped, because it is the least valuable fact. */
	goldMentions: number
	/** When an objective timer was last called out. */
	lastObjectiveAtSec: number
	/** His CS when farm was last raised; it must actually move before saying it again. */
	lastFarmCs: number
	/** The deficit last SAID, so a restatement can require the news to have got worse. */
	lastFarmBehind: number
	/**
	 * When the coach last had anything to say, and what it was about.
	 *
	 * These two are the global budget, and they are approximate in one direction that is worth
	 * stating: the coach can only speak from what this function offers, but it may also PASS on a
	 * turn where something was offered. So this counts OFFERS, which is an upper bound on lines,
	 * and the enforced rate is a ceiling rather than a schedule. Feeding the actually-spoken time
	 * back in would be exact and would need a route change; the ceiling is what stops nine lines
	 * in four minutes, and a ceiling is the part that was missing.
	 */
	lastOfferedAtSec: number
	/**
	 * The game clock on the previous turn, so a clock that goes BACKWARDS can be recognised.
	 *
	 * Separate from `lastOfferedAtSec`, which stays at zero through a game the coach had nothing to
	 * say about — the backwards-clock check has to work on the first turn of the next game either
	 * way.
	 */
	lastSeenSec: number
	/**
	 * EVERY subject the last non-empty list carried, not just the one at the top.
	 *
	 * The predecessor of this rule set a flag from the line that happened to rank first, and the
	 * lesson recorded three times in this file is that ordering is a suggestion to a model while
	 * the contents of the list are not. If a subject was on the list, it may have been the thing he
	 * heard, so it is the thing that may not come round again straight away.
	 */
	lastSubjects: FactSubject[]
	/**
	 * DEAD. Kept only so the daemon's hand-written between-games reset still compiles.
	 *
	 * Alternation moved to `lastSubjects`, which is set from a field rather than by running a regex
	 * over a rendered sentence. `src/server/routes/live.ts` clears this by name when a game ends,
	 * and its hand-written block clears 22 of this interface's 26 fields while it is at it —
	 * counted, not estimated: `lastFarmBehind`, `lastOfferedAtSec`, `lastSeenSec` and
	 * `lastSubjects` are the four it does not name, and all four of them were added here. That is
	 * the failure mode of a hand-written list: it is right until the next field. `resetFactMemory`
	 * below exists to replace that whole block with one call.
	 */
	lastLedWithDeath: boolean
}

/**
 * Forget everything, in place, between games.
 *
 * In place because the daemon holds one module-level memory for the process — one local user, one
 * game at a time — so the object identity has to survive. Every field, because a reset that lists
 * fields by hand goes stale the moment a field is added, which is exactly what happened: counted
 * against this interface, the daemon's own version names 22 of 26, and the four it misses are the
 * four this work added.
 */
export const resetFactMemory = (mem: FactMemory): void => {
	Object.assign(mem, newFactMemory())
}

export const newFactMemory = (): FactMemory => ({
	announcedDeaths: new Set(),
	announcedLosses: new Set(),
	announcedEvents: new Set(),
	praiseSaid: new Set(),
	lastGoldMentioned: 0,
	lastGoldAtSec: 0,
	goldSinceSec: 0,
	lastFarmAtSec: 0,
	lastRaceAtSec: 0,
	lastRaceGap: 0,
	raceSettledSince: 0,
	saidRestraint: false,
	saidLevelGap: false,
	seenCounterpartItems: new Set(),
	sawCounterpartBuild: false,
	saidKillShare: false,
	saidOwnDeath: false,
	saidSwing: false,
	saidObjectives: false,
	goldMentions: 0,
	lastObjectiveAtSec: 0,
	lastFarmCs: 0,
	lastFarmBehind: 0,
	lastOfferedAtSec: 0,
	lastSeenSec: 0,
	lastSubjects: [],
	lastLedWithDeath: false
})

/**
 * What the PICTURE contributes, and the reason it is only ever this much.
 *
 * ## Why the frame had to enter here and nowhere else
 *
 * MEASURED on the real socket with real stored frames, two results that only make sense together:
 * asked to read the game clock off the image the model was exact 6 times in 6 (and, with no image
 * attached, invented a plausible number 6 times in 6) — and yet two coaching arms of 14 turns each,
 * identical blocks and prompt, differing only in whether the JPEG was attached, made the same
 * speak-or-PASS decision on 13 of 14 turns and paraphrased each other where both spoke. Every line
 * either arm said was derivable from the ground-truth block alone.
 *
 * That is not the model failing to look. It is this file working as written: the coach may speak
 * only from the list `buildFacts` returns, an empty list means PASS, and until now NOT ONE ranked
 * fact was computed from pixels. The picture could not reach a sentence by construction. Ten games
 * were spent concluding the coach was not looking at the screen; it was looking, and it had nowhere
 * to put what it saw. This field is the somewhere.
 *
 * ## What the read can actually do, and what it cannot
 *
 * `scripts/probe-minimap.ts` — 20 frames from five real games, three reads each, `gemini-3.1-flash-lite`
 * on a 4x upscale of the minimap crop, answering in coordinates that `zoneAtMinimapPct` then names.
 * The rows scored against a human are 18 reads of 6 hand-labelled frames, which is a small n and is
 * said so wherever it is quoted:
 *
 *   his own HALF of the map, right              17/18  (94%)
 *   his own ZONE, right                         15/18  (83%)
 *   two reads of one picture agree on the half  56/60  (93%)
 *   an ENEMY icon in the right zone             22/35  (63%)
 *   the enemy COUNT exactly right                8/18  (44%)
 *   two reads agree about the enemy zones       29/60  (48%)
 *
 * **So enemy positions are NOT in this interface, and their absence is the finding rather than an
 * oversight.** They are the highest-value live fact a jungler can be handed and they exist in no
 * other channel this app has — the Live Client Data API has no positions at all — which is exactly
 * why the temptation to ship them at 63% has to be refused in writing. A wrong farm number is dull;
 * "there is an enemy in your topside jungle" is wrong about a third of the times it is said and each
 * wrong one SENDS HIM SOMEWHERE. Champion identity closed the same door from the other end: with the
 * answer set sorted so the first entry carried no hint, the reader named HIS OWN champion — the
 * easiest portrait on the map, the one the camera box is centred on — wrong 12 times in 60.
 *
 * What survives is one field, deliberately coarse. `topside` / `botside` / `mid` / `base` is the
 * granularity a jungler's decision actually turns on: it changes whether to walk to drake, and it is
 * invariant under which side he is playing.
 *
 * ## "Not visible" means NOT IN HIS ATTENTION
 *
 * `AGENTS.md` gates every spoken line on two tests, and the first is whether he could have got it by
 * looking at his screen. The minimap is, strictly, on his screen, so a literal reading bans this
 * whole field. That reading is wrong and it is written down here rather than left to be
 * rediscovered: his eyes are on his champion, the minimap is 6% of the monitor in the far corner,
 * and reading it out is the oldest job a coach sitting beside a player has. The bar stays high, and
 * it is enforced below rather than asserted — this observation never becomes a sentence on its own.
 * It only turns a client fact he can read into a decision he cannot ("Drake is back in 40 seconds"
 * is a HUD readout; "…and you look like you're topside" is a rotation), or withholds one.
 */
export interface FrameObservation {
	/** Which half of the map his own icon was on. Null when the read could not place him. */
	where: Coarse | null
	/**
	 * The game clock the PICTURE was taken at — not when it was read, and not now.
	 *
	 * Staleness is decided in `buildFacts` rather than by the caller, for the same reason the rate
	 * limits are: a producer that decides for itself whether it is still fresh is a second copy of a
	 * rule, and this file is where the rules about what may be said live.
	 */
	atSec: number
	/**
	 * How far to trust it. THERE IS NO `high`, by construction.
	 *
	 * The best figure this read has ever produced is 94% over eighteen reads. Every other input to
	 * this function comes off the client and is exact, so calling a frame read a fact in the same
	 * breath would be a lie about where the number came from. The ladder therefore stops one rung
	 * short, and the phrasing hedges on the rung it does reach — the same way the review pipeline
	 * hedges an interpolated position instead of laundering it into a claim.
	 *
	 * `low` is what a caller passes when it has reason to doubt this particular read; the daemon
	 * sets it when two consecutive reads disagree about which half he is on, which is the measured
	 * 7% showing itself. A `low` read does NOTHING: no sentence, and no gate either. Suppressing a
	 * line on a read that may be wrong is still acting on it.
	 */
	confidence: "medium" | "low"
}

export interface FactInput {
	nowSec: number
	/**
	 * How long until HE is back up, when he is dead. Null when alive.
	 *
	 * Load-bearing, and it was missing. A judge found three lines telling a corpse "two are down,
	 * you have about 14s" while his own respawn was 19s — he came back AFTER they did, so the
	 * window it handed him did not exist. The coach was reading the enemy respawn column and
	 * never its own player's, and the number was in the block the whole time.
	 */
	meDeadForSec: number | null
	/**
	 * Enemies only — an ally's death is on his own HUD.
	 *
	 * `killedByMe` marks the ones he got himself. A judge caught the coach reading his own kill
	 * back to him as scouting: his score went 5/0/5 to 6/0/5 on the same tick Renekton died, and
	 * it announced "Renekton just died, down for 14s" as though it were news.
	 */
	deadEnemies: { champion: string; respawnSec: number; killedByMe?: boolean; isJungler?: boolean }[]
	currentGold: number | null
	/** Non-null only when it is far enough off his own average to be worth a sentence. */
	pace: { cs: number; expected: number; exact: boolean } | null
	/** Events the player himself caused, already filtered to his name. */
	/**
	 * Major objectives the ENEMY just took, newest first.
	 *
	 * This did not exist, and its absence produced the worst line of the project: seconds after
	 * losing Baron the coach said "oh deer, your farm is slightly behind". Losing Baron was not a
	 * candidate fact at all — only HIM taking one was — so the ranker offered farm and gold and
	 * the model picked the best of a worthless list. Ranking by fact TYPE and never by STAKES is
	 * what makes a coach sound like it is not watching the same game.
	 */
	/**
	 * The enemy jungler as of this tick — the man he is racing.
	 *
	 * MEASURED, and this is why it lives here rather than in the block prose: with the counterpart
	 * only in the block body, the coach said nothing in 12 of 12 turns. The prompt's rule is that
	 * an empty "not looking at" list means PASS, and the model may only speak from that list. A
	 * fact that is not ranked is a fact that does not exist, however true it is and however
	 * prominently the block states it.
	 */
	/** Major objectives taken by each side so far. */
	objectiveCount?: { mine: number; theirs: number }
	counterpart: {
		champion: string
		cs?: number
		level?: number
		inferred?: boolean
		/** Legendary items he has finished, by NAME, newest last. */
		items?: string[]
		/** His share of his team's kills, 0-1. Exact: every K/D/A is in the block. */
		killShare?: number
	} | null
	/** His own level, for the gap against the counterpart. */
	meLevel?: number
	/** His own share of his team's kills, 0-1. */
	myKillShare?: number
	/**
	 * What a one-trick on HIS champion would add to each kind of fact.
	 *
	 * Loaded from `knowledge/champions/<champion>.md` and guaranteed digit-free by the parser, so
	 * it can shape the fix and can never become a claim. Absent for a champion with no note, and
	 * the facts simply stand alone — which is what they have always done.
	 */
	advice?: ChampionAdvice
	/**
	 * The read from `analysis/fights.ts`, already phrased by the module that owns the arithmetic.
	 *
	 * `quiet` means kills are still landing and NOTHING may be said this turn, about anything — a
	 * sentence arriving behind a live teamfight is noise at the moment noise costs most, and any
	 * count spoken now is revised three seconds later.
	 */
	fight?: {
		quiet: boolean
		line: string | null
		/** Which champion clause fits: he was not in it, or he was and it went badly. */
		kind?: "fight-lost" | "fight-absent"
	}
	enemyObjectives: { name: string; atSec: number; dragonType?: string }[]
	myEvents: {
		id: number
		name: string
		killStreak?: number
		dragonType?: string
		stolen?: boolean
	}[]
	/**
	 * How many of his team, and how many of theirs, are alive right now.
	 *
	 * Used only to suppress tempo facts when he is outnumbered. A judge found the coach saying
	 * "Graves just died — down for 21s" while all four of his teammates were dead and four enemies
	 * were alive: "one of them is down, here's your window" is the exact wrong instinct in a 1v4,
	 * and the fact was true the whole time. A window is only a window if he can take it.
	 */
	alliesAlive: number
	enemiesAlive: number
	/**
	 * Seconds until each objective is back, counted from a take THIS SESSION ACTUALLY SAW.
	 *
	 * Null when no take was observed — never assumed from the clock. This is the same rule and the
	 * same constants the overlay already displays (`analysis/live-coach.ts`), and the coach was
	 * refusing to say what the overlay was already asserting, which is not a defensible split.
	 */
	drakeBackInSec: number | null
	baronBackInSec: number | null
	heraldBackInSec: number | null
	/**
	 * The one thing the picture knows that the client does not: where HE is. See `FrameObservation`.
	 *
	 * OPTIONAL, and everything that reads it degrades to exactly today's behaviour when it is
	 * absent. A pre-pass that is switched off, that failed, that was thrown away by the client's
	 * fence, or that could not find his icon must cost a CLAUSE and never a LINE — the coach going
	 * quiet because vision went quiet is the same failure as the coach going quiet because the
	 * ground-truth fetch failed, which this app already refuses to do.
	 */
	frame?: FrameObservation
}

/**
 * Only worth mentioning an objective this far out — further ahead and it is not actionable yet,
 * and it would be repeated every turn until it arrived.
 */
export const OBJECTIVE_HORIZON_SEC = 60

/** `announcedEvents` is keyed by number; objective windows need a stable numeric id too. */
const hash = (s: string): number => {
	let h = 0
	for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
	return h
}

/**
 * The ranked, rate-limited list. Mutates `mem`, which is the point — it is the memory.
 */
export const buildFacts = (
	input: FactInput,
	mem: FactMemory,
	opts: FactOptions = {}
): string[] => {
	/*
	 * THE PIPE: how long between this state being read and the last syllable landing.
	 *
	 * It is here, in the ranker, because it changes what is TRUE and not merely when it is heard.
	 * Measured on the four recorded games: at ZERO provider latency, 8 of 18 window lines were
	 * already stale by their own last syllable — the sentence alone takes a measured median of
	 * 3.6 seconds to say, and the coach was handing him a countdown computed before it started
	 * talking. Provider latency does not move that number at all (0s and 5s give the same 8 of 18);
	 * only the sentence does.
	 *
	 * So every countdown in this file is spoken as the figure it will BE, and every floor is
	 * applied to that figure rather than to the one on the scoreboard now.
	 */
	const path = opts.path ?? "socket"
	const pipeSec = opts.pipeSec ?? (path === "turn" ? TURN_PIPE_SEC : SOCKET_PIPE_SEC)
	/** Seconds from now until the last syllable of this sentence lands. */
	const heardBy = (text: string): number => pipeSec + speechDurationSec(text)
	/*
	 * A BACKWARDS CLOCK IS A NEW GAME, and everything remembered belongs to the old one.
	 *
	 * This is the same signal `daemon/live-sampler.ts` rolls its session on, with the same jitter
	 * tolerance, and it has to be here because every rate limit in this file is a comparison
	 * against `nowSec`. Carry a 35-minute game's timestamps into the next game's first minute and
	 * every one of them reads as "said seconds ago": measured, the coach passed on 19 of 20 turns
	 * of a replay for exactly this reason, because the harness walks the samples in an order the
	 * game clock does not follow.
	 *
	 * The daemon does clear most of this between games (`server/routes/live.ts`), naming 22 of the
	 * 26 fields by hand — but `lastOfferedAtSec`, `lastSubjects`, `lastSeenSec` and `lastFarmBehind`
	 * are not among them, and those four are the global budget itself. Left to that list, game two
	 * would open believing the coach had just spoken. Doing it here covers them, and it cannot go
	 * stale the way a hand-written list does.
	 */
	if (input.nowSec < mem.lastSeenSec - CLOCK_BACK_SEC) resetFactMemory(mem)
	mem.lastSeenSec = input.nowSec

	/*
	 * THE FRAME, RESOLVED ONCE, OR NOTHING.
	 *
	 * Four ways to be nothing and every one of them ends in exactly today's behaviour: no read at
	 * all (no pre-pass, a failed call, or the client's fence threw the read away whole), a read that
	 * could not find his icon, a read the producer already doubts, and a read of a picture that is
	 * now old enough to be about somewhere else. Nothing below branches on WHICH — a `Coarse | null`
	 * is the only thing the rest of this function ever sees, so there is no path where a missing
	 * read can produce a different sentence rather than the same sentence without a clause.
	 */
	const frame: Coarse | null =
		(
			input.frame !== undefined &&
			input.frame.where !== null &&
			input.frame.confidence === "medium" &&
			input.nowSec - input.frame.atSec >= 0 &&
			input.nowSec - input.frame.atSec <= FRAME_FRESH_SEC
		) ?
			input.frame.where
		:	null

	/*
	 * IN BASE, so nothing he is told to go and take is his to take, and nothing about his gold is
	 * news — the shop is open in front of him. The frame's other job, and it is a GATE.
	 *
	 * A wrong gate costs a line; a wrong claim costs a decision, and this app's whole design is the
	 * observation that those two are nowhere near the same price. So the coarse read is allowed to
	 * WITHHOLD a sentence on 94%-accurate evidence long before it would be allowed to assert one.
	 *
	 * The case is real and the client cannot see it: he is alive, so nothing in the block suggests
	 * otherwise, and he is standing in the fountain having just recalled. "Two of them are dead, you
	 * have about twenty seconds" is then an instruction to sprint at something he cannot reach, and
	 * it spends the turn. Note he cannot be in base BECAUSE he is dead — a read that places his icon
	 * while the client says he is on the respawn screen is thrown away whole by `frameReadFaults`,
	 * which caught exactly that on 6 of the 6 reads where it applied.
	 */
	const stranded = frame === "base"

	/** Seconds until he is back on the map; 0 when he is already on it. */
	const dead = input.meDeadForSec ?? 0

	/**
	 * How the teams will stand in `sec` seconds, counting only the respawns already on the clock.
	 *
	 * `outnumbered` was checked at the instant the fact was BUILT, which is not the instant it is
	 * acted on. An enemy with eight seconds left is alive again before a four-second sentence has
	 * finished landing, so "you have a window" could be said into a fight he was about to be losing
	 * one man deeper. That is the `impossible` verdict — an instruction he must actively ignore —
	 * and unlike a death he did not see coming, it is arithmetic on numbers already in the block.
	 */
	const outnumberedIn = (sec: number): boolean => {
		const enemiesBack = input.deadEnemies.filter(d => d.respawnSec <= sec).length
		const meBack = input.meDeadForSec !== null && input.meDeadForSec <= sec ? 1 : 0
		return input.enemiesAlive + enemiesBack > input.alliesAlive + meBack + 1
	}
	const praise: Fact[] = []
	const farm: Fact[] = []
	const money: Fact[] = []
	const deaths: Fact[] = []
	const windows: Fact[] = []
	/** Objective calls the frame turned into a rotation. See `soon`. */
	const rotate: Fact[] = []
	const rest: Fact[] = []

	/*
	 * What the enemy just took, and what it means for the next few minutes. Highest stakes on the
	 * map, so it outranks everything and it SILENCES the trivia below — see `disaster`.
	 */
	/*
	 * The counterpart gap. Ranked HIGH on purpose.
	 *
	 * His own average encodes his own mistakes, so a farm line can only ever say he is being
	 * unusually himself. This says he is losing a race to a specific person, with both numbers off
	 * the client and neither of them visible without holding TAB.
	 */
	/*
	 * HIS OWN death, once per game, explained rather than narrated.
	 *
	 * The rule against reading his screen back rightly stopped the coach announcing that he died —
	 * he was there. But an OTP always has something to say about it, and the useful part was never
	 * the event: it is WHY this champion in particular cannot get out of that situation. That comes
	 * from the champion note, is not on his HUD, and is not something he can work out mid-death.
	 *
	 * Once per game. A death clause is a property of the champion, so a second telling is a lecture,
	 * and a coach that says the same sentence on every death is one he stops hearing. It also waits
	 * until he is actually on the respawn screen with nothing else to do.
	 */
	const ownDeath: Fact[] = []
	if (
		input.meDeadForSec !== null &&
		input.meDeadForSec > 0 &&
		!mem.saidOwnDeath &&
		input.advice?.death &&
		/*
		 * AND he is still on the respawn screen when it finishes.
		 *
		 * MEASURED: this note was twice delivered to a man who was already walking out of the
		 * fountain — "he was back on the map 12.0s later, and the note is for the respawn screen".
		 * It is the longest thing this file can say, because it comes from the champion markdown
		 * rather than from a template, so it is the line most likely to outlive its own premise.
		 * The check is his own respawn timer against the length of the sentence, both known.
		 */
		input.meDeadForSec > pipeSec + speechDurationSec(input.advice.death)
	) {
		const text = input.advice.death
		ownDeath.push({
			text,
			subject: "your-death",
			tier: "standing",
			commit: () => {
				mem.saidOwnDeath = true
			}
		})
	}

	/*
	 * Objective control, both sides, as a running count.
	 *
	 * Exact from the event feed and genuinely hard to hold in your head mid-game: he knows the last
	 * drake went, he does not reliably know the score is three to none. For a jungler that count is
	 * the job description, which is why it earns a sentence the individual takes do not.
	 */
	const objectives: Fact[] = []
	if (input.objectiveCount && input.nowSec >= OBJECTIVES_MIN_SEC) {
		const { mine: mineCount, theirs } = input.objectiveCount
		const gap = theirs - mineCount
		if (gap >= OBJECTIVES_MIN_GAP && !mem.saidObjectives) {
			objectives.push({
				text:
					mineCount === 0 ?
						`they have taken ${theirs} of the objectives and you have taken none`
					:	`objectives are ${theirs} to ${mineCount} against you`,
				subject: "objectives",
				tier: "standing",
				commit: () => {
					mem.saidObjectives = true
				}
			})
		}
	}

	const race: Fact[] = []
	if (
		input.counterpart &&
		input.counterpart.cs !== undefined &&
		input.pace !== null &&
		input.nowSec >= RACE_MIN_SEC
	) {
		const gap = input.counterpart.cs - input.pace.cs
		const worsened = gap - mem.lastRaceGap
		/*
		 * A SWING is the best encouragement available, and it is exact.
		 *
		 * Praise today only fires on a multikill or an objective — things he already knows he did.
		 * Clawing back a deficit against the man he is racing is invisible: it happens across
		 * minutes, neither number is on screen, and it is the one moment encouragement actually
		 * lands, because it is evidence that what he changed worked.
		 *
		 * Only counts as a swing if he was genuinely behind before, so the first mention of a game
		 * can never be one.
		 */
		const swung =
			mem.lastRaceAtSec > 0 &&
			mem.lastRaceGap >= RACE_MIN_GAP &&
			mem.lastRaceGap - gap >= RACE_SWING &&
			!mem.saidSwing
		if (swung) {
			/*
			 * Into `race`, NOT into `praise`.
			 *
			 * Praise ranks last because the game already announced it — a dragon and a multikill
			 * both come with a banner and a sound, so the line adds warmth and no information. A CS
			 * comeback has no banner and no sound; it is the same invisible race fact as the
			 * deficit, with the sign the other way round. Ranked as praise it lost to "you're 20 CS
			 * down on your own pace" on the same turn, which is the coach reporting a recovery as a
			 * shortfall.
			 */
			// Read the old gap BEFORE overwriting it — the whole line is the difference between them.
			const was = mem.lastRaceGap
			race.push({
				text:
					gap <= 0 ?
						`you were ${was} CS down on ${input.counterpart.champion} and you're ahead now`
					:	`you've pulled ${was - gap} CS back on ${input.counterpart.champion}`,
				subject: "farm",
				tier: "standing",
				commit: () => {
					mem.saidSwing = true
					mem.lastRaceGap = gap
					mem.lastRaceAtSec = input.nowSec
				}
			})
		}
		/*
		 * NOT alongside the swing. Both sentences are the same two CS numbers with opposite spins —
		 * "you've pulled 12 CS back on Karthus" next to "Karthus is 14 CS up on you" is a coach
		 * arguing with itself, and the subject filter would silently drop one of them anyway. The
		 * comeback is the better line, so it wins outright rather than by ordering.
		 */
		/*
		 * Settle it, or un-settle it. `raceSettledSince` is the clock at which he first held a
		 * decisive lead; the race retires once that has stood for `RACE_SETTLED_HOLD_SEC`, and the
		 * moment the lead is no longer decisive the clock resets and the fact is live again.
		 */
		if (gap <= -RACE_SETTLED_GAP) {
			if (mem.raceSettledSince === 0) mem.raceSettledSince = input.nowSec
		} else mem.raceSettledSince = 0
		const raceSettled =
			mem.raceSettledSince !== 0 && input.nowSec - mem.raceSettledSince >= RACE_SETTLED_HOLD_SEC

		if (
			!swung &&
			!raceSettled &&
			Math.abs(gap) >= RACE_MIN_GAP &&
			(mem.lastRaceAtSec === 0 || input.nowSec - mem.lastRaceAtSec >= RACE_COOLDOWN_SEC) &&
			(mem.lastRaceAtSec === 0 || worsened >= RACE_GAP_MOVED)
		) {
			const who = input.counterpart.champion
			race.push({
				text:
					gap > 0 ?
						withAdvice(`${who} is ${gap} CS up on you`, input.advice?.["race-behind"])
					:	withAdvice(`you're ${-gap} CS up on ${who}`, input.advice?.["race-ahead"]),
				subject: "farm",
				tier: "standing",
				commit: () => {
					mem.lastRaceAtSec = input.nowSec
					mem.lastRaceGap = gap
				}
			})
		}
	}

	/*
	 * RESTRAINT — the thing an OTP says most and this coach could not say at all.
	 *
	 * A level gap against the counterpart, with an objective live, is the one moment where "don't"
	 * is the whole coaching point. Both numbers are exact and come off the client; what makes it a
	 * decision rather than a stat is that it names what to do instead.
	 *
	 * Offered ALONE and ranked at the very top with the other things that expire, because measured
	 * repeatedly in this file: put beside a farm number, the model takes the farm number.
	 */
	/*
	 * A fight outranks everything that is not expiring in seconds. It is the moment a jungler's
	 * decisions actually cash out, and "that fight happened without you" is the single thing a
	 * player is least able to notice for himself.
	 */
	const fight: Fact[] =
		input.fight?.line ?
			[
				{
					text: withAdvice(
						input.fight.line,
						input.fight.kind ? input.advice?.[input.fight.kind] : undefined
					),
					subject: "fight",
					tier: "interrupt"
				}
			]
		:	[]

	/*
	 * What the counterpart just FINISHED, by name.
	 *
	 * This is the build advice he asked for twice, and it is safe in a way a threshold never is:
	 * the item NAME is a client fact, and what the item MEANS is something the model already knows
	 * about League. Client supplies the fact, model supplies the judgement — the same split that
	 * makes the screenshot safe for "where" and the block authoritative for "what".
	 *
	 * Only newly completed items, because a static list is a second HUD and he can see his own.
	 * An item appearing IS an event, which is what makes it punchy rather than a readout.
	 */
	const build: Fact[] = []
	if (input.counterpart?.items) {
		const hadBaseline = mem.sawCounterpartBuild
		for (const item of input.counterpart.items) {
			if (mem.seenCounterpartItems.has(item)) continue
			// The first poll of a game is not news: everything is "new" then. Only announce once a
			// baseline exists, which is what the flag records.
			if (!hadBaseline) {
				mem.seenCounterpartItems.add(item)
				continue
			}
			build.push({
				text: withAdvice(`${input.counterpart.champion} just finished ${item}`, input.advice?.build),
				subject: "build",
				tier: "standing",
				commit: () => mem.seenCounterpartItems.add(item)
			})
		}
		mem.sawCounterpartBuild = true
	}

	const restraint: Fact[] = []
	if (input.counterpart && input.counterpart.level !== undefined && input.meLevel !== undefined) {
		const down = input.counterpart.level - input.meLevel
		const objectiveUp =
			(input.drakeBackInSec !== null && input.drakeBackInSec <= OBJECTIVE_SOON_SEC) ||
			(input.baronBackInSec !== null && input.baronBackInSec <= OBJECTIVE_SOON_SEC)
		if (down >= RESTRAINT_LEVEL_GAP && objectiveUp && !mem.saidRestraint) {
			restraint.push({
				text: withAdvice(
					// The champion clause supplies the reason not to take it, so the fact stays short.
					// Both the champion note and the role default carry a restraint clause, so the
					// "don't" is never lost.
					`you're ${down} levels down on ${input.counterpart.champion}`,
					input.advice?.restraint
				),
				subject: "levels",
				// The objective is up NOW; in a minute this is a stat about a fight already taken.
				tier: "expiring",
				commit: () => {
					mem.saidRestraint = true
				}
			})
		} else if (down >= RESTRAINT_LEVEL_GAP && !mem.saidLevelGap) {
			restraint.push({
				text: withAdvice(
					`${input.counterpart.champion} is ${down} levels up on you`,
					input.advice?.restraint
				),
				subject: "levels",
				// No objective in the window: a level gap is a state that will still be true later.
				tier: "standing",
				commit: () => {
					mem.saidLevelGap = true
				}
			})
		}
	}

	/*
	 * Kill participation against the counterpart.
	 *
	 * The game-scale version of "that fight happened without you": both shares are exact, neither
	 * is visible without doing arithmetic on the scoreboard, and a jungler who is 30 points behind
	 * on participation is being left out of his team's fights — which is a different problem from
	 * being behind on farm and has a different fix.
	 */
	const participation: Fact[] = []
	if (
		input.counterpart?.killShare !== undefined &&
		input.myKillShare !== undefined &&
		input.nowSec >= KP_MIN_SEC &&
		!mem.saidKillShare
	) {
		const gap = Math.round((input.counterpart.killShare - input.myKillShare) * 100)
		if (gap >= KP_MIN_GAP_PCT) {
			participation.push({
				text: `${input.counterpart.champion} is in ${gap} percent more of his team's kills than you are — get to the next fight before it starts, not after`,
				subject: "kill-share",
				tier: "standing",
				commit: () => {
					mem.saidKillShare = true
				}
			})
		}
	}

	const lost: Fact[] = []
	for (const e of input.enemyObjectives) {
		const age = input.nowSec - e.atSec
		if (age < 0 || age > ENEMY_OBJECTIVE_WORTH_SAYING_SEC) continue
		const id = `enemy-${e.name}@${Math.round(e.atSec)}`
		if (mem.announcedLosses.has(id)) continue
		const text =
			e.name === "BaronKill" ?
				`they have Baron — for the next three minutes their minions push on their own, so do not take a fight in the open`
			: e.name === "HeraldKill" ? `they have Herald and a free tower charge`
			: e.name === "DragonKill" ? `they took ${dragonPhrase(e.dragonType)}`
			: ""
		if (text === "") continue
		lost.push({
			text,
			subject: "objective-lost",
			/*
			 * BARON AND HERALD INTERRUPT. A DRAGON DOES NOT.
			 *
			 * Baron is a three-minute clock on how he may play, and Herald is a tower — both are
			 * worth cutting into a line said twenty seconds ago. A dragon take is real news and it
			 * is not that: replayed over a real game, treating all three alike put "they have Baron"
			 * and "they took Chemtech drake" twenty-five seconds apart, twice, which is the chatter
			 * this budget exists to stop. It is the same split the `disaster` blackout below already
			 * makes, so making it here as well is consistency rather than a new judgement.
			 */
			tier: e.name === "DragonKill" ? "expiring" : "interrupt",
			commit: () => mem.announcedLosses.add(id)
		})
	}

	/*
	 * A disaster silences the small talk.
	 *
	 * Even correctly RANKED, farm and gold would come back on the very next turn — twenty seconds
	 * after losing Baron, which is still absurd. For a while after something this size, the only
	 * things worth saying are about the thing that happened. Being quiet is a legitimate answer
	 * here and a farm reminder is not.
	 */
	const disaster = input.enemyObjectives.some(
		e => (e.name === "BaronKill" || e.name === "HeraldKill") &&
			input.nowSec - e.atSec >= 0 &&
			input.nowSec - e.atSec <= DISASTER_QUIET_SEC
	)

	/*
	 * Praise, straight off the event feed and announced once by the feed's own monotonic id.
	 * Without these the coach had nothing warm that was also grounded, so it either stayed silent
	 * — 48% of turns, measured — or reached for a compliment it could not support.
	 */
	for (const e of input.myEvents) {
		if (mem.announcedEvents.has(e.id)) continue
		let line = ""
		if (e.name === "ChampionKill" && (e.killStreak ?? 0) >= 2)
			line = `you just got a ${MULTI[e.killStreak!] ?? `${e.killStreak}-kill`}`
		else if (e.name === "DragonKill")
			line = e.stolen ? `you stole ${dragonPhrase(e.dragonType)}` : `you secured ${dragonPhrase(e.dragonType)}`
		else if (e.name === "BaronKill") line = e.stolen ? "you stole Baron" : "you secured Baron"
		else if (e.name === "HeraldKill") line = "you secured Herald"
		if (line === "") continue
		/*
		 * Two dragons are two events, but "you secured the dragon" twice is the same sentence —
		 * a judge found it delivered character-for-character identically eight lines apart.
		 */
		// `mem.praiseSaid` is only written when the line is actually offered, so the within-turn
		// duplicate — two dragon events on one poll — has to be caught here as well.
		if (mem.praiseSaid.has(line) || praise.some(p => p.text === line)) continue
		const said = line
		praise.push({
			text: said,
			subject: "praise",
			tier: "standing",
			commit: () => {
				mem.praiseSaid.add(said)
				mem.announcedEvents.add(e.id)
			}
		})
	}

	/*
	 * The farm gap is reported again only if the gap itself has MOVED, not merely if time passed.
	 *
	 * A judge found it stated three times in ten minutes with a bigger number each time, during a
	 * stretch where the player's CS had not changed at all — the "deficit" was growing purely
	 * because the expected-pace curve keeps rising. That is scolding someone with a number they
	 * cannot affect between mentions, and it is exactly the pile-on that made the player stop
	 * listening.
	 */
	const gap = input.pace ? Math.abs(input.pace.cs - input.pace.expected) : 0
	if (
		input.pace &&
		gap >= FARM_MIN_GAP &&
		input.pace.cs >= FARM_MIN_CS &&
		(mem.lastFarmAtSec === 0 || input.nowSec - mem.lastFarmAtSec >= FARM_COOLDOWN_SEC) &&
		(mem.lastFarmCs === 0 || Math.abs(input.pace.cs - mem.lastFarmCs) >= FARM_CS_MOVED) &&
		(mem.lastFarmAtSec === 0 ||
			input.pace.expected - input.pace.cs - mem.lastFarmBehind >= FARM_GAP_WORSE)
	) {
		const atCs = input.pace.cs
		const behind = input.pace.expected - input.pace.cs
		/*
		 * Written to be SAID, not parsed.
		 *
		 * The old form was `FARM: 14 camps AHEAD of your own pace (193 vs your usual 179) —
		 * interpolated, approximate`, and the coach read it out: label, shouty caps, parenthetical
		 * and all, while silently dropping the hedge at the end. These strings are the script, so
		 * the hedge is a word inside the sentence and there is nothing in them a person would not
		 * say out loud.
		 */
		/*
		 * "CS", never "camps". The figure is the live client's `creepScore` and the baseline is the
		 * metric defined as "Camps + CS @10" — BOTH are camps plus lane minions, so the comparison
		 * is sound and the old wording was not. A jungler who soaked two waves is not "27 camps
		 * behind"; saying so is a false statement about what was measured, which is the one kind of
		 * error this app exists to not make.
		 */
		const hedge = input.pace.exact ? "" : "roughly "
		/*
		 * A gap with no instruction is a scold. He knows he is behind; the question a coach answers
		 * is what to do in the next thirty seconds, and for a jungler that is nearly always "take
		 * the camps that are up instead of walking to a lane".
		 */
		farm.push({
			text:
				behind > 0 ?
					withAdvice(`you're ${hedge}${behind} CS down on your own pace`, input.advice?.["farm-behind"])
				:	`you're ${hedge}${-behind} CS up on your own pace, ${input.pace.cs} against ${input.pace.expected} — keep taking the free camps`,
			subject: "farm",
			tier: "standing",
			commit: () => {
				mem.lastFarmAtSec = input.nowSec
				mem.lastFarmCs = atCs
				mem.lastFarmBehind = behind
			}
		})
	}

	/*
	 * Unspent gold is PERSISTENT state, and persistence is what makes it worth interrupting for.
	 *
	 * The first version raised it once and then suppressed it until another 800g arrived, so a
	 * judge found the coach silent through six minutes of an unspent item — a whole component
	 * sitting unbought — while spending eight lines on enemy death timers the player could read
	 * off his own HUD. Novel events were treated as valuable and durable state as one-shot,
	 * which is backwards.
	 *
	 * So: a step up is news, and so is the same gold still sitting there several minutes later.
	 */
	if (input.currentGold !== null) {
		if (input.currentGold < GOLD_FLOOR) {
			mem.lastGoldMentioned = 0
			mem.lastGoldAtSec = 0
			mem.goldSinceSec = 0
		} else if (dead > 0 || stranded) {
			/*
			 * He is standing at the shop — on the respawn screen, or in base on the frame read.
			 * Telling him his gold is unspent there is telling him about the thing he is looking
			 * at, and it reads as a scold.
			 *
			 * MEASURED, and this is why `stranded` was added to a rule about money: the one
			 * `impossible` gold verdict in four games is "he spent it: 373 gold when it lands, was
			 * told 2511" — the line was built while he was in the fountain buying. Nothing in the
			 * client says so; the frame does. The clock still runs, so the reminder is delayed and
			 * not deleted, which is the rule everywhere else in this file.
			 */
			if (mem.goldSinceSec === 0) mem.goldSinceSec = input.nowSec
		} else {
			if (mem.goldSinceSec === 0) mem.goldSinceSec = input.nowSec
			/*
			 * HELD LONG ENOUGH TO BE NEWS, before anything else is considered.
			 *
			 * Simulated across a thirty-minute game, gold was 8 of the coach's 12 lines — the most
			 * frequent thing it said and the least valuable, because the number is on his HUD. The
			 * non-obvious part was never the amount, it is the DURATION: he can read "1280 gold",
			 * he cannot feel that it has been sitting there for three minutes while he walked past
			 * two recalls.
			 *
			 * So a gold line requires time held, always, and there is a hard cap per game. It is a
			 * reminder, and a reminder repeated is a nag.
			 */
			const heldLongEnough = input.nowSec - mem.goldSinceSec >= GOLD_MIN_HELD_SEC
			const underCap = mem.goldMentions < GOLD_MAX_PER_GAME
			const stepped =
				heldLongEnough &&
				underCap &&
				(mem.lastGoldMentioned === 0 || input.currentGold - mem.lastGoldMentioned >= GOLD_STEP)
			/*
			 * A re-mention needs time AND change. Without the second condition it repeated the
			 * same sentence word for word into a game state that had not moved a point in four
			 * minutes — an unchanged criticism restated because a timer fired, which is precisely
			 * how someone learns to tune the coach out.
			 */
			const stale =
				heldLongEnough &&
				underCap &&
				mem.lastGoldAtSec > 0 &&
				input.nowSec - mem.lastGoldAtSec >= GOLD_NAG_SEC &&
				input.currentGold !== mem.lastGoldMentioned
			if (stepped || stale) {
				const amount = input.currentGold
				money.push({
					text:
						stale && !stepped ?
						/*
					 * "since you last had a chance" was read as "since you last died" and turned
					 * into a fabricated twelve-minutes-ago anchor. It states the duration and
					 * nothing about its cause.
					 */
					/*
					 * Counted from when the gold FIRST crossed the threshold, not from the last
					 * time it was mentioned — otherwise every re-mention reset the clock and said
					 * "4m" forever, which the player can see is wrong.
					 */
					`${Math.round(input.currentGold)} gold unspent for ${Math.round((input.nowSec - mem.goldSinceSec) / 60)} minutes now`
						:	`${Math.round(input.currentGold)} gold sitting unspent`,
					subject: "gold",
					tier: "standing",
					commit: () => {
						mem.lastGoldMentioned = amount
						mem.lastGoldAtSec = input.nowSec
						mem.goldMentions += 1
					}
				})
			}
		}
	}

	/*
	 * Two or more enemies down at once is a different fact from one enemy down, and a much better
	 * one: it is the window in which objectives are actually taken. It is exact, it is invisible
	 * without opening the scoreboard, and it expires in seconds.
	 *
	 * Deliberately not subject to the announce-once rule that single deaths use — the window is
	 * the thing being reported, not the deaths, and it changes as each of them respawns.
	 */
	/*
	 * Outnumbered: any "go take something" fact is worse than silence. He is not getting a free
	 * objective 1v4, and being told he has a window is how someone walks into four people.
	 */
	const outnumbered = outnumberedIn(0)
	/**
	 * ONE sentence, and it no longer names his own respawn.
	 *
	 * The variant this replaces was `N of them are dead — you are up in 8 seconds with about 20
	 * seconds of window left`: 23 syllables, a measured 5.53 seconds to say, against 14 and 3.83
	 * for the plain form. On a line whose entire subject is a countdown, every syllable is
	 * subtracted from the countdown, so those nine words cost 1.7 seconds of the window they were
	 * describing — and they cost it exactly when he is dead and the window is at its shortest.
	 *
	 * What they bought was his own respawn timer, which is the largest number on his screen while
	 * he is on the respawn screen. That is the "not visible" test in AGENTS.md failing about as
	 * hard as it can fail. The regression this variant was added for was never the NAMING: it was
	 * a corpse being told about a window that ended before he could stand up, and that is fixed by
	 * subtracting his respawn from the figure, which is what `left` does.
	 *
	 * Rendered at any count and any figure, so a draft can be priced before it is spoken.
	 */
	const windowText = (count: number, left: number): string =>
		`${count} of them are dead — you have about ${left} seconds`
	const windowOpen =
		outnumbered || stranded ?
			[]
		:	input.deadEnemies.filter(d => d.respawnSec >= WINDOW_MIN_SEC)
	if (windowOpen.length >= 2) {
		const shortest = Math.min(...windowOpen.map(d => d.respawnSec))
		/*
		 * A DRAFT, said out loud only in order to price it.
		 *
		 * The number depends on how long the sentence takes to say and the sentence takes longer to
		 * say when the number has more syllables, so this is a fixed point. One pass reaches it:
		 * the difference between "seventeen" and "eleven" is a syllable, which is 0.19s, which is
		 * inside the fit's own 0.30s mean error.
		 */
		const pipe = heardBy(windowText(windowOpen.length, Math.round(shortest - dead)))
		/*
		 * Who is still down WHEN HE HEARS IT, and how much window is left then.
		 *
		 * MEASURED: 2 of the 18 window lines were "told 2 were down; 1 still is" — one of the two
		 * respawned inside the sentence, so the count he was given had never been true at the
		 * moment he could act on it. That is not a rounding error, it is the difference between a
		 * dive and a 2v2, and it is predictable from the respawn timers already in the block.
		 */
		const open = windowOpen.filter(d => d.respawnSec - pipe >= WINDOW_MIN_SEC)
		/*
		 * He can start using the window at whichever comes later: his own respawn, or the end of
		 * the sentence. Both are known, so neither is a guess.
		 */
		const left = open.length === 0 ? 0 : Math.round(Math.min(...open.map(d => d.respawnSec)) - Math.max(dead, pipe))
		if (open.length >= 2 && left >= WINDOW_MIN_SEC && !outnumberedIn(pipe)) {
			const key = `${open.length}@${Math.round((input.nowSec + shortest) / 4)}`
			if (!mem.announcedDeaths.has(key)) {
				windows.push({
					text: windowText(open.length, left),
					subject: "downed",
					tier: "expiring",
					commit: () => mem.announcedDeaths.add(key)
				})
			}
		}
	}

	/*
	 * `respawnSec` counts down, so nowSec + it is the death's respawn INSTANT — stable across
	 * polls and unique per death. Rounding to 2s absorbs poll jitter without merging two separate
	 * deaths of the same champion.
	 */
	for (const d of
		outnumbered || stranded ?
			[]
		:	[...input.deadEnemies].sort((a, b) => b.respawnSec - a.respawnSec)) {
		// He was there. Telling him about a kill he just made is a readback, not scouting.
		if (d.killedByMe) continue
		/*
		 * Same rule as the window, priced the same way: what is left of the respawn when he can
		 * actually use it, which is after his own respawn AND after the sentence has been said.
		 * The draft exists only to measure the sentence — see the window above.
		 */
		const downText = (n: number): string => `${d.champion} is down ${n} seconds — their camps are free`
		const pipe = heardBy(downText(Math.round(d.respawnSec - dead)))
		const left = Math.round(d.respawnSec - Math.max(dead, pipe))
		if (left < DEATH_WORTH_SAYING_SEC) continue
		// An enemy respawning inside the sentence can make a free camp a 2v1 — see `outnumberedIn`.
		if (outnumberedIn(pipe)) continue
		const id = `${d.champion}@${Math.round((input.nowSec + d.respawnSec) / 2)}`
		if (mem.announcedDeaths.has(id)) continue
		/*
		 * Phrased as the WINDOW, never as the news.
		 *
		 * "Renekton just died" narrates something he watched happen two seconds ago on his own
		 * screen — it spends the one sentence she gets per turn telling him what he already knows.
		 * The part he cannot see without holding TAB is how long it lasts, and the part worth
		 * saying is what it buys. So the death is the premise of the sentence, not its point.
		 */
		/*
		 * Phrased by ROLE, because the same sentence is not true of everyone.
		 *
		 * "20 seconds without Seraphine — their side of the map is short one" was said out loud
		 * about an enemy SUPPORT. A support dying does not open their jungle; the enemy jungler
		 * dying is the only death that reliably does, and it is the only one worth that sentence.
		 * One template applied to ten champions is how a coach stops sounding like it is watching.
		 */
		/*
		 * ONLY the enemy jungler's death earns a sentence.
		 *
		 * Simulated over a full game, "X is down 28 seconds" was six of the coach's lines — and it
		 * is a readout: the kill feed announced it, the scoreboard shows the timer. What it is NOT
		 * is a decision, for any of the four who are not racing him. The jungler's death is the one
		 * that changes what he should do next, because it is the one that frees a jungle.
		 *
		 * The others still count toward a WINDOW ("two of them are dead"), which is a different
		 * fact about a number he cannot see at a glance. They just no longer each get a line.
		 */
		if (!d.isJungler) continue
		deaths.push({
			/*
			 * The number he will SEE when he hears it, not the one on the scoreboard now.
			 *
			 * MEASURED: "Briar is down 25 seconds" had 18 left by its own last syllable and "Zed is
			 * down 13 seconds" had 7 — the second is under the floor this rule has always had, so it
			 * is no longer said at all. A countdown that was true when it was computed and false
			 * when it is heard is the same failure as a stale fact, and it is arithmetic.
			 */
			text: downText(left),
			/*
			 * The SAME subject as a window, which is the point.
			 *
			 * "Karthus is down 22 seconds" and "2 of them are dead" are two rules, and to the man
			 * hearing them they are one topic: somebody is dead. Replayed over a real game they
			 * landed at 14:04, 14:28 and 14:53 — three lines about who was down inside fifty
			 * seconds, none of which repeated a rule. Sharing a subject is what stops that.
			 */
			subject: "downed",
			tier: "expiring",
			commit: () => mem.announcedDeaths.add(id)
		})
	}

	/*
	 * An objective coming back is the most schedulable thing a jungler gets — it is the one fact
	 * that says where to be in thirty seconds rather than what just happened. Only inside a window
	 * where saying it changes anything: an objective back in four minutes is not news.
	 */
	const soon = (label: string, sec: number | null) => {
		if (sec === null || sec > OBJECTIVE_HORIZON_SEC || sec < 0) return
		const key = hash(`${label}@${Math.round((input.nowSec + sec) / 30)}`)
		if (mem.announcedEvents.has(key)) return
		/*
		 * Objective timers are on his HUD, so they are rate-limited hard. Five drake calls in one
		 * game was measured, and a timer he can read is the definition of a readout — it earns a
		 * line when it is about to matter, not every time it comes round.
		 */
		if (input.nowSec - mem.lastObjectiveAtSec < OBJECTIVE_CALL_COOLDOWN_SEC) return
		const commit = () => {
			mem.announcedEvents.add(key)
			mem.lastObjectiveAtSec = input.nowSec
		}
		/*
		 * "Up NOW" is never touched by the frame, in either direction.
		 *
		 * The frame's contribution is "start walking", and there is nothing to start when the thing
		 * has already spawned — the call has become the most valuable five seconds of information in
		 * the game and it goes out wherever he is standing. So the picture may only modify the
		 * ADVANCE WARNING, which keeps the highest-stakes line on this route independent of a channel
		 * that is right 94 times in 100.
		 */
		const upNow = (): void => {
			rest.push({ text: `${label} is up NOW`, subject: "objectives", tier: "expiring", commit })
		}
		if (sec <= 5) {
			upNow()
			return
		}
		const side = OBJECTIVE_SIDE[label]
		if (frame !== null && side !== undefined && (frame === "topside" || frame === "botside")) {
			/*
			 * ALREADY THERE, so the timer is withheld — the gate, in the other direction.
			 *
			 * MEASURED (`scripts/probe-attention.ts`, four recorded games replayed through this
			 * function at the shipped twenty-second turn): of 66 lines offered across those games,
			 * only 9 could not have been obtained by looking at his own screen, and **32 of the 66
			 * were a window or an objective timer whose entire point is WHERE HE SHOULD BE, said by a
			 * coach with no idea where he is**. Standing in the drake pit and being told drake is
			 * back in forty seconds is that failure exactly: the timer is on his HUD and he is
			 * looking at the pit.
			 *
			 * WITHHELD, not demoted — the lesson recorded three times in this file is that ordering
			 * is a suggestion to a model and the contents of the list are not. And withheld costs
			 * nothing durable: `commit` never runs, so `OBJECTIVE_CALL_COOLDOWN_SEC` is not spent and
			 * the same objective is still callable the moment he walks away from it. The predicted
			 * effect of this branch is not fewer objective calls but the same three or four a game,
			 * landing when they are a rotation instead of when they are a readout.
			 */
			if (frame === side) return
			/*
			 * THE FRAME'S ONE SENTENCE, and it is a modifier rather than a claim of its own.
			 *
			 * "Looks like you're" is not politeness. His half of the map was right on 17 of 18
			 * hand-scored reads and two reads of one picture agreed on 56 of 60 pairs, so roughly one
			 * line in fifteen is about somewhere he is not — and the review pipeline's rule for
			 * exactly this situation is that an interpolated position is hedged in prose and never
			 * laundered into a fact. A hedge also degrades honestly when it is wrong: a man who is
			 * already botside hears "looks like you're topside", knows better, and discards one
			 * clause. He does not walk anywhere.
			 *
			 * The subject stays `objectives` — the SAME subject as the plain timer. That is deliberate
			 * and it is what makes "three map facts in a row" impossible by construction: the frame
			 * never gets a topic of its own to stack, so it inherits the whole budget this file
			 * already spends on not talking about objectives twice.
			 */
			/*
			 * The hedge survives the cut and the wiring around it does not.
			 *
			 * Was `... and it looks like you're topside — start walking down now`: 21 syllables and
			 * a measured 5.15 seconds, the longest line this file ships, on a route whose whole
			 * purpose is to be acted on by walking. "It", "and", "start" and "now" carry nothing —
			 * an objective timer is already a statement about when — while "looks like you're" is
			 * the 94%-accurate read admitting what it is, and stays word for word.
			 */
			const rotateText = (n: number): string =>
				`${label} is back in ${n} seconds — looks like you're ${frame}, walk ${
					side === "botside" ? "down" : "up"
				}`
			/*
			 * Priced from its OWN draft rather than from the plain timer's: this is still the
			 * longest line the file ships, and a number meant to be acted on by walking is the last
			 * one that should be quoted from before the walking could have started.
			 */
			const left = Math.round(sec - heardBy(rotateText(Math.round(sec))))
			if (left <= 5) {
				upNow()
				return
			}
			rotate.push({
				text: rotateText(left),
				subject: "objectives",
				tier: "expiring",
				commit
			})
			return
		}
		/*
		 * No usable read, or he is mid or in base: exactly the line this route has always said.
		 * `mid` is not a rotation because it is not a wrong place to be — he is a walk from both
		 * pits, and telling a man in the middle of the map to start walking names no direction.
		 */
		const plain = (n: number): string => `${label} is back in ${n} seconds`
		/*
		 * MEASURED: at a turn provider's latency "Drake is back in 48 seconds" was 35 by the time
		 * it landed, and "back in 24" was 12 — a timer he can read off his own HUD, quoted wrong.
		 * Saying the figure he will see costs nothing and is the whole difference between a call
		 * and a contradiction of the number in front of him.
		 */
		const left = Math.round(sec - heardBy(plain(Math.round(sec))))
		if (left <= 5) {
			upNow()
			return
		}
		rest.push({
			text: plain(left),
			subject: "objectives",
			tier: "expiring",
			commit
		})
	}
	soon("Baron", input.baronBackInSec)
	soon("Drake", input.drakeBackInSec)
	soon("Herald", input.heraldBackInSec)

	// A window outranks everything but praise: it is the most actionable thing a jungler gets.
	/*
	 * Praise goes LAST, below everything, including single deaths.
	 *
	 * A dragon, a baron and a multi-kill are all announced by the game itself — full-screen banner
	 * and a sound cue — so saying them adds no information at all. Their value is warmth, not
	 * news, and warmth must never cost a fact: a judge found the coach spending its one
	 * interruption congratulating him on a banner he was watching, on a tick that also carried
	 * "12 camps behind your own pace", the only thing on screen he could not see.
	 *
	 * So praise still happens, but only when nothing else is on offer. That is most of the time
	 * it matters anyway — the moment after a fight is usually quiet.
	 */
	/*
	 * THE GLOBAL BUDGET. Everything above decides what is TRUE; this decides whether he hears it.
	 *
	 * Two rules, and both are about the coach rather than about any one fact:
	 *
	 *   1. a floor since the last thing said, by tier — see MIN_GAP_SEC and ROUTINE_GAP_SEC;
	 *   2. the subject of the last thing said may not be the subject of this one.
	 *
	 * The second replaces the old `lastLedWithDeath` flag, which only ever guarded deaths, and it
	 * is the rule the bad transcript needed: six of nine lines were about how much he had cleared,
	 * produced by three separate generators, and a per-generator flag cannot see that at all.
	 *
	 * Both lift on the CLOCK and not on a quiet turn — see the note where they are written, at the
	 * bottom of this function. That is the reverse of what the death flag did, and the reversal is
	 * what makes the rule reachable at a twenty-second cadence.
	 */
	const sinceLast =
		mem.lastOfferedAtSec === 0 ? Number.POSITIVE_INFINITY : input.nowSec - mem.lastOfferedAtSec
	/**
	 * Is this line about a MOMENT rather than about how the game stands?
	 *
	 * Decided per fact rather than per tier, because `tier` answers a different question: it says
	 * how loudly a fact may cut into the rate limit, not how long it stays true. Losing Baron is an
	 * `interrupt` and it shapes the next three minutes; a fight he missed is an `interrupt` and it
	 * is over in seconds. So `expiring` plus the fight, and nothing else.
	 *
	 * Measured over four recorded games, expiring facts are 34% stale at a turn provider's latency
	 * and 77% at nine seconds, against 18% for standing facts at both. The fight half of this
	 * predicate is not in that corpus — no fight line was offered in the four games — and is here
	 * on the same evidence that put fights in the event-shaped group: 40% stale at one second,
	 * 88% at nine.
	 */
	const reactive = (f: Fact): boolean => f.tier === "expiring" || f.subject === "fight"

	const allowed = (f: Fact): boolean => {
		/*
		 * THE TIER GATE, and it is first because it is structural rather than a rate.
		 *
		 * A turn-based provider is several seconds behind by construction — the sentence is written
		 * and paid for before its first syllable — so it must not be TRUSTED not to pick the
		 * reactive line, it must not be OFFERED one. Every measurement in this file says the same
		 * thing about ordering: it is a suggestion to a model, and the contents of the list are not.
		 *
		 * This is the one rule here that makes the socket structurally different from every other
		 * provider rather than merely faster.
		 */
		if (path === "turn" && reactive(f)) return false
		// An enemy Baron and a fight he missed are worth cutting in on anything. Both are rare,
		// both are announce-once, and staying quiet about either to protect a rate is absurd.
		if (f.tier === "interrupt") return true
		/*
		 * The same subject may not follow itself inside ROUTINE_GAP_SEC.
		 *
		 * Bounded by time rather than strictly back-to-back, because the coach is asked for facts
		 * every twenty seconds and is silent on most of those turns: a rule that only looked at the
		 * immediately preceding OFFER would treat two lines four minutes apart as consecutive, and
		 * two minutes of silence is not a stretch of nagging. Two minutes is the same figure the
		 * standing floor uses, and it means the worst case for any one topic is two lines in four
		 * minutes rather than the six he actually got.
		 */
		if (mem.lastSubjects.includes(f.subject) && sinceLast < ROUTINE_GAP_SEC) return false
		if (sinceLast < MIN_GAP_SEC) return false
		return f.tier !== "standing" || sinceLast >= ROUTINE_GAP_SEC
	}

	/*
	 * ONE FACT PER SUBJECT IN THE LIST, not merely across turns.
	 *
	 * This is the fix for the contradiction, and it is the same rule as the alternation above
	 * applied inside a single turn. A list carrying both "Briar is 14 CS up on you" and "you're 20
	 * CS down on your own pace" hands the model two different baselines for the same subject in one
	 * message, and what came back was a blend of the two: "your 20 farm is not pacing to match your
	 * average of 30", then twenty-five seconds later "your 20 farm is not pacing to match your 28
	 * CS average". Same CS, two averages, and no single line in any block ever said either pair.
	 * Three facts are worth offering only if they are three different topics.
	 */
	const distinct = (facts: Fact[]): Fact[] => {
		const seen = new Set<FactSubject>()
		const out: Fact[] = []
		for (const f of facts) {
			if (seen.has(f.subject)) continue
			seen.add(f.subject)
			out.push(f)
		}
		return out
	}

	/*
	 * After a death has been offered, deaths are REMOVED from the next turn, not merely demoted.
	 *
	 * Demoting was tried and measured. With a death anywhere in the list the model reached for it
	 * regardless of order: 57% of spoken lines were the identical death sentence, including turns
	 * where "1393g sitting unspent" and "12 camps behind your own pace" sat above it. Ordering is
	 * a suggestion to a model; the contents of the list are not. That is now the general rule for
	 * every subject, in `allowed`.
	 */
	const ranked = [
		...fight,
		...ownDeath,
		...restraint,
		...windows,
		...build,
		...race,
		...objectives,
		...participation,
		...rest,
		...money,
		...farm,
		...deaths.slice(0, 1),
		...praise
	].filter(allowed)

	/*
	 * A live window is offered ALONE.
	 *
	 * Ranking it first was not enough: a judge found the coach picking a farm stat over "2 of them
	 * are dead — you have about 10s", the single most actionable fact in the transcript, spent on
	 * a number that would be equally true thirty seconds later. When something expires in seconds
	 * and everything else does not, there is no choice worth offering.
	 */
	/*
	 * A lost Baron or Herald is offered ALONE, and it silences everything else while it is fresh.
	 *
	 * The same argument as the window above, in the other direction. Losing Baron is the largest
	 * thing that happens in a game of League; offering it alongside a farm number invites the model
	 * to pick the farm number, and it did — "oh deer, your farm is slightly behind", seconds after
	 * the enemy took Baron. During the quiet window the ONLY things that may be said are the loss
	 * itself and anything that expires in seconds; if neither exists, saying nothing is correct.
	 */
	const alone = (facts: Fact[]): Fact[] => facts.filter(allowed).slice(0, 1)
	const soleFight = alone(fight)
	const soleRestraint = alone(restraint)
	const soleLost = alone(lost)
	const soleWindow = alone(windows)
	/*
	 * A rotation call is offered ALONE too, and it sits exactly here for two separate reasons.
	 *
	 * BELOW the disaster blackout, because a forty-second advance warning is not something that
	 * expires in seconds, and the rule that survived losing Baron to a farm reminder is that during
	 * the blackout only the loss itself and the genuinely fleeting may be said.
	 *
	 * ALONE and above the general list, because everything measured in this file says a place-and-
	 * time instruction loses to a number when the two are offered together: the model took a farm
	 * stat over "2 of them are dead — you have about 10 seconds", and took a death sentence over an
	 * explicit unspent-gold line 57% of the time when both were in the list. A rotation is the only
	 * line the coach has that is about the next thirty seconds of walking, so it does not share.
	 */
	const soleRotate = alone(rotate)
	const out =
		// Kills still landing: nothing at all, from any source. The module's own rule.
		input.fight?.quiet ? []
		: soleFight.length > 0 ? soleFight
		: soleRestraint.length > 0 ? soleRestraint
		: soleLost.length > 0 ? soleLost
		: soleWindow.length > 0 ? soleWindow
		: disaster ? []
		: soleRotate.length > 0 ? soleRotate
		: distinct(ranked).slice(0, MAX_FACTS)

	/*
	 * Memory is written HERE, for the facts that were actually offered, and nowhere else.
	 *
	 * A fact held back by the floor has not been said, so it must not be marked as said — otherwise
	 * the budget silently deletes facts instead of delaying them, and the rarest and best lines are
	 * exactly the ones a floor is most likely to land on.
	 */
	for (const f of out) f.commit?.()

	/*
	 * NOT cleared by a silent turn. This is the opposite of what the flag it replaces did, and the
	 * reversal is the difference between the rule working and not.
	 *
	 * The old flag had no expiry, so silence had to clear it or a game with nothing else to report
	 * would never mention a second death. This one expires on the clock instead — see `allowed` —
	 * and clearing it on silence made it almost unreachable: the coach is asked for facts every
	 * twenty seconds and has nothing on most of them, so ONE quiet turn between two lines was
	 * enough to let the same subject straight back through. Measured on a real game, two "two of
	 * them are dead" lines forty-nine seconds apart survived the subject bar for exactly that
	 * reason.
	 */
	if (out.length > 0) {
		mem.lastSubjects = out.map(f => f.subject)
		mem.lastOfferedAtSec = input.nowSec
	}
	return out.map(f => f.text)
}
