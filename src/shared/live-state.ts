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

import { renderKnowledge } from "./live-knowledge.ts"
import type { LiveJunglerBasis, LiveKnowledge } from "./live-knowledge.ts"

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
 * what the score is. So the picture is used for *where things are*, and this is used for *what is
 * true*. That is the same rule the rest of the app already follows: never derive a fact you can
 * simply be told.
 */
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
		cs?: number
		dead?: boolean
		respawnSec?: number
		/**
		 * HIS inventory, by display name. Nobody else's.
		 *
		 * The live client publishes a full item list for every player and the post-game timeline
		 * this app otherwise lives on has no purchases at all, so this is the one surface where a
		 * spending decision can be discussed without inventing anything. It is deliberately his
		 * alone: a coach that can read one side's items and not the other's would grade the enemy
		 * build from nothing, which is the exact failure `shared/matchup-prompt.ts` refuses runes
		 * for. Prices, purchase times and build order are still absent and still unsayable.
		 */
		items?: string[]
	}
	allies: VisionStatePlayer[]
	enemies: VisionStatePlayer[]
	/**
	 * The enemy jungler — the one identity that makes a champion note actionable.
	 *
	 * `basis` is carried because the two ways of knowing are not equally strong (see
	 * `analysis/live-roles.ts`): a declared position may be asserted, a lone Smite may only be
	 * hedged. Undefined means nothing identified one, which is different from "there isn't one".
	 */
	theirJungler?: { champion: string; basis: LiveJunglerBasis } | null
	/**
	 * Champion notes for the two junglers, on the turns that carry them.
	 *
	 * Null on most turns by design — `shared/live-knowledge.ts` explains why this rides in the
	 * per-turn block at all and why it is re-sent periodically rather than once.
	 */
	knowledge?: LiveKnowledge | null
	/**
	 * The one question this turn has to answer, from `analysis/live-decision.ts`.
	 *
	 * Null when the fact list is empty, which is also when the answer is PASS.
	 */
	decision?: string | null
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

/** "Lillia" or "looks like Lillia" — the hedge belongs to the weaker basis, every time. */
const junglerLine = (j: { champion: string; basis: LiveJunglerBasis }): string =>
	j.basis === "position" ?
		`Their jungler: ${j.champion} (the client published his position — you may say this plainly).`
	:	`Their jungler: ${j.champion}, identified by his Smite alone because nobody declared a position this queue. Say "looks like"; do not assert it.`

/** The authoritative block. Everything in it came from the client, not from the picture. */
export const renderState = (s: VisionState): string => {
	const me = s.me
	const hp = me.hp !== undefined && me.maxHp !== undefined ? `${Math.round(me.hp)}/${Math.round(me.maxHp)} HP` : ""
	return `## Ground truth (from the game client — these are FACTS, the screenshot is not)

Clock ${s.clock}.

You: ${me.champion}${me.level ? ` lv${me.level}` : ""} ${me.k ?? 0}/${me.d ?? 0}/${me.a ?? 0}${
		me.cs !== undefined ? `, ${me.cs} CS` : ""
	}${hp ? `, ${hp}` : ""}${me.gold !== undefined ? `, ${Math.round(me.gold)}g` : ""}${
		me.dead ? `, DEAD${me.respawnSec ? ` (respawn ${Math.round(me.respawnSec)}s)` : ""}` : ""
	}${
		me.items && me.items.length > 0 ?
			`

His items right now: ${me.items.join(" · ")}. That is his complete inventory and it is HIS ONLY — you
cannot see anyone else's. You do not know what anything cost, what order it was bought in, or when.`
		:	""
	}

Your team: ${s.allies.map(line).join(" · ") || "unknown"}

Enemy team: ${s.enemies.map(line).join(" · ") || "unknown"}
${s.theirJungler ? `\n${junglerLine(s.theirJungler)}\n` : ""}
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

Use the screenshot for **where things are** — positions, who is grouped, what is happening on
screen. Use this block for **what is true**.${
		s.knowledge ? `\n\n${renderKnowledge(s.knowledge)}` : ""
	}${
		/*
		 * The question goes LAST, on purpose.
		 *
		 * Everything above it is evidence; this is the only line that says what to do with it. The
		 * previous design ended on the fact list and got exactly what it asked for — the top fact,
		 * read back. Ending on the question is the cheapest available way to make the last thing
		 * the model reads be a decision rather than a number.
		 */
		s.decision ?
			`

## The one decision — ANSWER it, never read it back

${s.decision}

Answer it in one spoken sentence, using the facts above and what you know about these two
champions. Do not repeat the question, do not say "the decision is", and do not answer it with a
fact he can already see. If the honest answer is that nothing needs deciding, say PASS.`
		:	""
	}`
}
