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
	allies: VisionStatePlayer[]
	enemies: VisionStatePlayer[]
	/**
	 * Objective and kill events from the last `RECENT_EVENT_WINDOW_SEC`, already phrased.
	 * Newest last.
	 *
	 * The window is not decoration. This list is headed "Just happened", and it used to be the
	 * last six events with no bound on age at all — so in a quiet stretch it presented a kill from
	 * four minutes ago as news, which is a false claim the coach would have had no way to catch.
	 * Now that fights are something the coach is asked to talk about, an event's AGE is part of
	 * what makes it worth a sentence.
	 */
	recentEvents: string[]
	/**
	 * Their jungler — the one enemy this player is actually racing.
	 *
	 * Null when the client did not publish enough to identify him, which is a state and not a
	 * gap to fill: the coach's standing rule is that it never guesses who plays which role.
	 * `enemyJungler()` in `live-knowledge.ts` decides, from the live client's `position` field
	 * (reliable, unlike match history's `timeline.lane`) or from a lone Smite.
	 *
	 * This is the STATE half of every matchup line. The champion notes are static and are sent
	 * once per session; his level, his score and whether he is on the map are not, so they are
	 * here, every turn, where the knowledge has something to multiply with.
	 */
	counterpart?: {
		champion: string
		basis: "declared" | "smite"
		level?: number
		k?: number
		d?: number
		a?: number
	} | null
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

/**
 * How far back an event may be and still be printed under "Just happened".
 *
 * One turn is 20 seconds, so a bound of two turns keeps a fight visible across the turn that
 * follows it — which is where the useful line usually is, since what a fight BOUGHT is only clear
 * once it has stopped — without letting a four-minute-old kill be reported as news.
 */
export const RECENT_EVENT_WINDOW_SEC = 45

export interface VisionStatePlayer {
	champion: string
	/**
	 * The lane the CLIENT declared for this player ("top", "jungle", …), or undefined.
	 *
	 * Only ever the live client's own `position` field, which its schema header marks reliable —
	 * never inferred, never carried over from match history, whose `timeline.lane` mislabels 4 of
	 * 10 players. Undefined in queues where nobody declares one, and the coach's rule is then the
	 * old one: name the champion, never a role it was not told.
	 */
	role?: string
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
	`${p.champion}${p.role ? ` (${p.role})` : ""}${p.level ? ` lv${p.level}` : ""} ${p.k ?? 0}/${p.d ?? 0}/${p.a ?? 0}`

/**
 * Their jungler, and the one comparison that decides most jungle decisions: his level against
 * the player's.
 *
 * Both numbers are on the scoreboard, which is to say behind a key the player is not holding
 * during a fight or a clear — so this passes the "could he have got it by looking at his screen"
 * test, while "you are level 8" on its own does not.
 *
 * The basis is printed because it changes what may be SAID. A declared position is the client's
 * own answer; a lone Smite is an inference that has held everywhere it was checked and is still
 * an inference, so the coach hedges it rather than asserting it.
 */
const counterpartLine = (s: VisionState): string => {
	const c = s.counterpart
	if (!c) return "Their jungler: not identified — the client did not publish enough to say who it is."
	const score = `${c.k ?? 0}/${c.d ?? 0}/${c.a ?? 0}`
	/*
	 * The GAP is computed here, in words, because the model got it wrong when it was not.
	 *
	 * Measured: the block said "he is lv14, you are lv13" and the coach said "avoid him being 2
	 * levels up". One subtraction, stated as a measurement, wrong. That is the same failure the
	 * "never do arithmetic on the block" rule already covers, and the reliable fix is the one this
	 * app uses everywhere else — compute it in TypeScript and leave the model nothing to do but
	 * phrase it.
	 */
	const gap =
		c.level !== undefined && s.me.level !== undefined ? c.level - s.me.level : null
	const levels =
		gap === null ? ""
		: gap === 0 ? ` — level with you at ${c.level}`
		: gap > 0 ? ` — he is lv${c.level} and you are lv${s.me.level}, so he is ${gap === 1 ? "one level" : `${gap} levels`} up on you`
		: ` — he is lv${c.level} and you are lv${s.me.level}, so you are ${gap === -1 ? "one level" : `${-gap} levels`} up on him`
	return `Their jungler: ${c.champion} ${score}${levels}.${
		c.basis === "smite" ?
			" (Identified by Smite alone — nobody declared a position this queue, so say \"looks like their jungler\", not \"their jungler\".)"
		:	""
	}`
}

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

Your team: ${s.allies.map(line).join(" · ") || "unknown"}

Enemy team: ${s.enemies.map(line).join(" · ") || "unknown"}

${counterpartLine(s)}

Alive right now: ${1 + s.allies.filter(p => !p.dead).length - (s.me.dead ? 1 : 0)} of yours against ${s.enemies.filter(p => !p.dead).length} of theirs.
${s.recentEvents.length > 0 ? `
Just happened (within the last ${RECENT_EVENT_WINDOW_SEC}s): ${s.recentEvents.join("; ")}` : ""}${
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

There is no ranked fact worth interrupting him for at this instant. Unless the video shows
something plain and urgent, the correct answer is PASS.${
				/*
				 * A live fight is the ONE case where an empty ranked list is not the end of it.
				 *
				 * The ranked list is built by `analysis/live-facts.ts` and does not carry kills at
				 * all, so through a nine-mark run over a game with six kills inside one 45-second
				 * window, the coach PASSed on every fight it was shown — correctly, by the rule it
				 * had. Naming the exception here rather than only in the system prompt matters:
				 * this section is the last thing it reads before answering, and a blanket "the
				 * correct answer is PASS" three lines above the fight is what it obeys.
				 *
				 * Deliberately narrow: champion kills only (a turret is not a decision), and only
				 * when it yields one thing to do in the next thirty seconds. Otherwise, PASS.
				 */
				s.recentEvents.some(e => e.includes("killed")) ?
					`

**Except:** champions died in the last ${RECENT_EVENT_WINDOW_SEC} seconds — see "Just happened"
above. If ONE of those lines points at ONE thing to do in the next thirty seconds, say that.
Otherwise PASS.

Use a "Just happened" line the way it is written, naming the champions it names. **Do not count
them, do not add them up, and do not summarise them.** "Three of yours just died", "your team is
gone" and "they just aced you" are all things a first draft of this said off these lines, and all
three were wrong — the first two are arithmetic on a 45-second window that says nothing about who
is standing now, and the third is a word for something the block would have told you about.
"Alive right now" above is the only count of the living there is.`
				:	""
			}`
	}

**The ten champions above are the only champions in this game.** Never name any other. Never
give a number that is not in this block, and take every timer from the list below rather than
inferring one — you cannot read health bars, gold or scores off a
downscaled screenshot accurately, and you do not need to, because they are right here.

Use the screenshot for **where things are** — positions, who is grouped, what is happening on
screen. Use this block for **what is true**.`
}
