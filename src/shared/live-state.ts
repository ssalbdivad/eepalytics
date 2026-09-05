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
	/**
	 * Is the thing this line refers to still standing there?
	 *
	 * True for everything computed FROM a kill — the next drake, the next Baron — because the
	 * spawn was derived from the last one being taken, so nobody has touched this one. False for
	 * grubs once any have gone, where the feed says a cluster was worked and cannot say what is
	 * left of it.
	 */
	untaken: boolean
	/** Who has taken this kind of objective so far, when the count is worth carrying. */
	taken?: { mine: number; theirs: number }
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
	grubsSpawnSec: 360,
	/** Grubs leave the map when Herald arrives. */
	grubsDespawnSec: 840,
	heraldSpawnSec: 840,
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
	const add = (name: string, atSec: number, taken?: { mine: number; theirs: number }): void => {
		if (atSec <= tSec) out.push({ name, state: "up", atSec, sec: Math.round(tSec - atSec), untaken: true, taken })
		else out.push({ name, state: "coming", atSec, sec: Math.round(atSec - tSec), untaken: true, taken })
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

	if (tSec < OBJECTIVE_SPAWN.grubsDespawnSec) {
		const grubs = count("grub")
		if (grubs.mine + grubs.theirs === 0) add("Void grubs", OBJECTIVE_SPAWN.grubsSpawnSec)
		else if (tSec >= OBJECTIVE_SPAWN.grubsSpawnSec)
			out.push({
				name: "Void grubs",
				state: "up",
				atSec: OBJECTIVE_SPAWN.grubsSpawnSec,
				sec: Math.round(tSec - OBJECTIVE_SPAWN.grubsSpawnSec),
				untaken: false,
				taken: grubs
			})
	}

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

/** Seconds, said the way a person says them out loud. */
export const spokenDuration = (sec: number): string => {
	if (sec < 60) return `${sec} seconds`
	const m = Math.floor(sec / 60)
	const s = sec % 60
	const mins = `${m} minute${m === 1 ? "" : "s"}`
	return s === 0 ? mins : `${mins} ${s} second${s === 1 ? "" : "s"}`
}

const mmss = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`

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
	const lines = list.map(o => {
		const took =
			o.taken && o.taken.mine + o.taken.theirs > 0 ?
				` Taken so far this game: ${o.taken.mine} by you, ${o.taken.theirs} by them.`
			:	""
		/*
		 * A cluster that has been WORKED never claims to still be standing there.
		 *
		 * The feed says three grubs were taken in each of the four recorded games and never a
		 * second cluster; the patch note number is six. Subtracting one from the other is a count
		 * nobody measured, and "grubs are up" said over an empty pit is a fabrication with a place
		 * attached. So once any have gone, the line asserts only the spawn time and the tally.
		 */
		return o.state === "up" ?
				o.untaken ?
					`- ${o.name}: UP and untaken since ${mmss(o.atSec)}, ${spokenDuration(o.sec)} ago.${took}`
				:	`- ${o.name}: the pit opened at ${mmss(o.atSec)}, ${spokenDuration(o.sec)} ago.${took}`
			:	`- ${o.name} spawns at ${mmss(o.atSec)} — in ${spokenDuration(o.sec)}.${took}`
	})
	return `### What is coming (the map's clock, worked out from the event feed)\n\n${lines.join("\n")}`
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

	if (s.unseen.length > 0)
		sections.push(
			`### Ranked highest by the app right now — a hint, not a menu\n\n${s.unseen.map(u => `- ${u}`).join("\n")}`
		)
	else sections.push(`### Nothing is ranked right now\n\nThe app has no ranked fact to offer at this instant.`)

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
