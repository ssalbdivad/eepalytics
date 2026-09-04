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
		/** `JGL` in every game on record, but read from the client rather than assumed. */
		role?: string
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
		 * What he already owns.
		 *
		 * NOT for saying out loud — his item bar is on his screen permanently, and reading it
		 * back is the "second HUD" failure this block exists to avoid. It is here as a
		 * CONSTRAINT: the difference between "buy Liandry's into their two tanks" and telling
		 * him to buy the item already sitting in slot two.
		 */
		items?: VisionStateItem[]
	}
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
	/**
	 * `TOP|JGL|MID|ADC|SUP`, from the live client's `position`.
	 *
	 * The one place in this app where a role may be trusted. `participants[].timeline.lane` in
	 * match history labels 4 junglers in 10 as JUNGLE and is banned everywhere else, but the
	 * running game reports the slot each player actually queued for. It is worth its ~20 tokens
	 * because without it the coach cannot identify the enemy jungler — the one enemy whose
	 * position, level and build change what a jungler should do next.
	 */
	role?: string
	level?: number
	k?: number
	d?: number
	a?: number
	/** Enemy CS is on the scoreboard, not the HUD; against his own it is the jungle race. */
	cs?: number
	dead?: boolean
	respawnSec?: number
	/**
	 * Carried for the enemy jungler only. Five inventories is 90 tokens a turn of material for a
	 * sentence about one champion, and the counterpart is the one whose build decides whether a
	 * 1v1 at the scuttle is a fight or a death.
	 */
	items?: VisionStateItem[]
	/**
	 * Summoner spells as the client names them. WHICH, never whether they are up: the live API
	 * carries no cooldowns, and a coach who says "his Flash is down" sends him into a dive that
	 * does not work.
	 */
	spells?: string[]
	/** The enemy jungler. Set from `position`, or from carrying Smite when position is blank. */
	counterpart?: boolean
}

/**
 * One inventory slot, named the way the client names it.
 *
 * Never an item id: a number in an item list is an invitation for a model to translate it, and a
 * translated id is a fabricated item wearing a real one's clothes.
 */
export interface VisionStateItem {
	name: string
	/** Stacking consumables. Omitted when 1. */
	count?: number
	/** Appeared in this player's inventory within the last `ITEM_NEW_SEC` seconds. */
	isNew?: boolean
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
	`${p.role ? `${p.role} ` : ""}${p.champion}${p.level ? ` lv${p.level}` : ""} ${p.k ?? 0}/${p.d ?? 0}/${p.a ?? 0}`

/**
 * An inventory, exhaustively, in slot order.
 *
 * `NEW` is the whole reason items are in this block at all: a static list is background colour
 * ("Viego resets on takedowns, be careful in fights" — true in every game he has ever played),
 * while a list with a change in it is a decision ("Viego just finished his Dirk").
 */
const items = (list: VisionStateItem[], markNew: boolean): string =>
	list
		.map(i => `${i.name}${i.count && i.count > 1 ? ` x${i.count}` : ""}${markNew && i.isNew ? " (NEW)" : ""}`)
		.join(", ")

/**
 * The gaps against his counterpart, computed HERE and phrased as one clause.
 *
 * The model is forbidden arithmetic on the block precisely so that a comparison like this cannot
 * be improvised, which means the block has to hand it over already done. Same direction reads as
 * one fact ("1 level and 14 CS ahead of you") because it is one: he is behind in the race.
 */
const gapClause = (me: VisionState["me"], jg: VisionStatePlayer): string => {
	const parts: { text: string; ahead: boolean }[] = []
	const add = (mine: number | undefined, theirs: number | undefined, unit: string) => {
		if (mine === undefined || theirs === undefined || theirs === mine) return
		parts.push({ text: `${Math.abs(theirs - mine)} ${unit}`, ahead: theirs > mine })
	}
	add(me.level, jg.level, "level")
	add(me.cs, jg.cs, "CS")
	if (parts.length === 0) return ""
	if (parts.length === 2 && parts[0]!.ahead === parts[1]!.ahead)
		return `${parts[0]!.text} and ${parts[1]!.text} ${parts[0]!.ahead ? "ahead of" : "behind"} you`
	return parts.map(p => `${p.text} ${p.ahead ? "ahead of" : "behind"} you`).join(", ")
}

/**
 * The enemy jungler, at the length he deserves.
 *
 * This is the one enemy a jungler is racing, and every figure here needs the scoreboard opened
 * mid-game to read — his level, his farm, his build. What it unlocks, concretely: whether to
 * contest the next scuttle (his level and items against yours), whether to invade (what he just
 * bought), and what to build (what he is building into you). None of it is on the HUD, and all
 * of it changes the next decision rather than describing the last one.
 */
const counterpartSection = (s: VisionState): string => {
	const jg = s.enemies.find(p => p.counterpart)
	if (!jg) return ""
	const gaps = gapClause(s.me, jg)
	return `

### The enemy jungler — the one he is racing

${jg.champion}${jg.level ? ` lv${jg.level}` : ""} ${jg.k ?? 0}/${jg.d ?? 0}/${jg.a ?? 0}${
		jg.cs !== undefined ? `, ${jg.cs} CS` : ""
	}${gaps === "" ? "" : ` — ${gaps}`}.${
		jg.spells && jg.spells.length > 0 ?
			`
Summoners: ${jg.spells.join(" + ")}. You know WHICH spells he took and NEVER whether they are up.`
		:	""
	}${
		jg.items && jg.items.length > 0 ?
			`
Carrying: ${items(jg.items, true)}.`
		:	""
	}`
}

/** The authoritative block. Everything in it came from the client, not from the picture. */
export const renderState = (s: VisionState): string => {
	const me = s.me
	const hp = me.hp !== undefined && me.maxHp !== undefined ? `${Math.round(me.hp)}/${Math.round(me.maxHp)} HP` : ""
	const jg = s.enemies.find(p => p.counterpart)
	/*
	 * The delta, said once more on its own line.
	 *
	 * The inline `(NEW)` marker is the fact; this is salience. A model scanning six comma-separated
	 * item names skips a parenthetical, and the purchase is the only part of an inventory that is
	 * news — worth its ~12 tokens, and only emitted on the turns where something actually changed.
	 *
	 * ENEMY purchases only. He watched himself buy his own item thirty seconds ago; telling him
	 * about it is the readback failure ("your farm is 130 against your 135 average" — true, useless)
	 * wearing an item's clothes. His own inventory is carried for what it rules OUT.
	 */
	const bought = (jg?.items ?? []).filter(i => i.isNew).map(i => `${jg!.champion} picked up ${i.name}`)
	const anyItems = (me.items?.length ?? 0) > 0 || (jg?.items?.length ?? 0) > 0
	return `## Ground truth (from the game client — these are FACTS, the screenshot is not)

Clock ${s.clock}.

You: ${me.role ? `${me.role} ` : ""}${me.champion}${me.level ? ` lv${me.level}` : ""} ${me.k ?? 0}/${me.d ?? 0}/${me.a ?? 0}${
		me.cs !== undefined ? `, ${me.cs} CS` : ""
	}${hp ? `, ${hp}` : ""}${me.gold !== undefined ? `, ${Math.round(me.gold)}g` : ""}${
		me.dead ? `, DEAD${me.respawnSec ? ` (respawn ${Math.round(me.respawnSec)}s)` : ""}` : ""
	}

Your team: ${s.allies.map(line).join(" · ") || "unknown"}

Enemy team: ${s.enemies.map(line).join(" · ") || "unknown"}

Alive right now: ${1 + s.allies.filter(p => !p.dead).length - (s.me.dead ? 1 : 0)} of yours against ${s.enemies.filter(p => !p.dead).length} of theirs.
${s.recentEvents.length > 0 ? `
Just happened: ${s.recentEvents.join("; ")}` : ""}${bought.length > 0 ? `
Since the last look: ${bought.join("; ")}.` : ""}${counterpartSection(s)}${
		me.items && me.items.length > 0 ?
			`

### What HE already owns — for reasoning, not for saying

${items(me.items, false)}.

His own item bar is on his screen the whole game, so reading this back to him is not coaching.
It is here so that a suggestion is possible at all: never name an item he is already carrying.`
		:	""
	}${
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
downscaled screenshot accurately, and you do not need to, because they are right here.${
		anyItems ?
			`

**The item lists above are COMPLETE and are the only items anyone is known to have.** If an item
is not written there, he does not have it and neither do they — you may not say it was bought,
finished, nearly finished or about to be. \`NEW\` means it appeared since the last look; without
that marker you do not know when anything was bought. You have no prices and no recipes, so never
say what something costs or what a component builds into.`
		:	""
	}

Use the screenshot for **where things are** — positions, who is grouped, what is happening on
screen. Use this block for **what is true**.`
}
