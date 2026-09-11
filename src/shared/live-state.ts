/**
 * The one definition of "what is true" during a live game.
 *
 * Pure and browser-safe on purpose. It is rendered into the prompt the live coach is given, it is
 * served to the page by `GET /api/live/ground-truth`, and the benches replay it from recorded
 * samples to score prompt changes. One shape for every consumer — a second copy is a copy that
 * drifts, and the whole point of this block is that the model can trust it.
 *
 * Note on scope: this is the THIN block the two ranked modes (`fenced`, `cite-or-quiet`) are given.
 * The default `trusted` mode is handed `shared/live-brief.ts` instead, which is a superset.
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

**The ten champions above are the only champions in this game.** Never name any other. Never
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
