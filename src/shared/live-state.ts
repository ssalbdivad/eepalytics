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
	pace: { cs: number; expected: number; exact: boolean; source: string } | null
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
	return `## Ground truth (from the game client — these are FACTS, the screenshot is not)

Clock ${s.clock}.

You: ${me.champion}${me.level ? ` lv${me.level}` : ""} ${me.k ?? 0}/${me.d ?? 0}/${me.a ?? 0}${
		me.cs !== undefined ? `, ${me.cs} CS` : ""
	}${hp ? `, ${hp}` : ""}${me.gold !== undefined ? `, ${Math.round(me.gold)}g` : ""}${
		me.dead ? `, DEAD${me.respawnSec ? ` (respawn ${Math.round(me.respawnSec)}s)` : ""}` : ""
	}

Farm baseline: ${
		s.pace ?
			`${s.pace.cs} CS against ${s.pace.expected}, ${s.pace.source}${s.pace.exact ? "" : " (approximate)"}`
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

Use the screenshot for **where things are** — positions, who is grouped, what is happening on
screen. Use this block for **what is true**.`
}
