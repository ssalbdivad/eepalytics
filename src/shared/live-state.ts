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
		/** From the client's own lobby assignment, not inferred. See `VisionStateRole`. */
		role?: VisionStateRole
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
		 * What he is actually holding, in the client's own words.
		 *
		 * It is on his own HUD, so it is never a line to speak — it is what makes a line about
		 * what to buy NEXT possible at all. Without it the coach cannot say anything about a
		 * build, which is half of what a live coach is for.
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
	 * The position the client reports, as a word.
	 *
	 * Undefined when the client did not say — queues that assign no role send an empty string,
	 * and a guessed role is exactly the kind of confident wrong call the block exists to stop.
	 */
	role?: VisionStateRole
	level?: number
	k?: number
	d?: number
	a?: number
	cs?: number
	dead?: boolean
	respawnSec?: number
	/**
	 * Only ever populated for the enemy jungler.
	 *
	 * Ten inventories is a wall of text on every single turn and a model given a wall of text
	 * skims it. His counterpart's build is the one that changes his decisions — whether to take
	 * the 1v1, whether to contest, what he is about to be hit by.
	 */
	items?: VisionStateItem[]
}

/** The five positions, spelled the way a coach says them out loud. */
export type VisionStateRole = "top" | "jungle" | "mid" | "bot" | "support"

/**
 * One held item, named by the client and never by us.
 *
 * `justBought` is the delta that makes the fact worth carrying at all: a static list is a
 * scoreboard, but "he just finished that" is a power change with a clock on it, and it is the
 * difference between "Viego resets on takedowns, be careful" and something only true right now.
 */
export interface VisionStateItem {
	/** `displayName` exactly as the client wrote it, or `item <id>` when it sent no name. */
	name: string
	/** Slot 6. Reported by the client, not inferred from the name. */
	trinket?: boolean
	/** New since the previous read of this player. Never set on the first sight of them. */
	justBought?: boolean
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
 * An inventory, or the honest statement that there is not one.
 *
 * "nothing bought yet" rather than an omitted line, for the same reason the empty fact list is
 * named out loud below: a missing section is a gap, and a model fills a gap.
 */
const itemList = (items: VisionStateItem[] | undefined): string =>
	items && items.length > 0 ?
		items
			.map(i => `${i.name}${i.trinket ? " (trinket)" : ""}${i.justBought ? " (just bought)" : ""}`)
			.join(", ")
	:	"nothing bought yet"

/**
 * The builds section: his, and his counterpart's.
 *
 * Every line in here was chosen because it CHANGES A DECISION rather than because it is true:
 *
 *   - his own items are on his HUD, and are here so that "spend it on X" is sayable at all;
 *   - the enemy jungler's items, level and farm are behind the scoreboard key — he is not looking
 *     at them, and they decide whether the 1v1 he is about to take is a good one;
 *   - the camp gap against that jungler is computed here because the prompt forbids the model
 *     doing arithmetic on the block, so a difference it is expected to use has to be handed over
 *     already worked out.
 *
 * Deliberately NOT here: summoner spells (no cooldowns are published, so it invites exactly the
 * "Flash is up" claim the prompt bans), runes, and the other eight inventories.
 */
const builds = (s: VisionState): string | null => {
	/*
	 * No inventory at all is NOT an empty inventory.
	 *
	 * `undefined` means nobody read one this tick — the eval harness reconstructs states from
	 * post-game timelines, which carry no purchases at all. Printing "nothing bought yet" there
	 * would tell the model a 24-minute jungler owns nothing, which is a fabricated fact handed
	 * over by the very block that exists to prevent them.
	 */
	if (s.me.items === undefined) return null
	/*
	 * An enemy jungler is only rendered when an inventory was actually read FOR HIM. The role
	 * alone is not enough: when two enemies claim the jungle the identification is refused and no
	 * inventory is attached, and printing "holding: nothing bought yet" for a man at minute 20
	 * would be a fabricated fact wearing the block's own authority.
	 */
	const jungler = s.enemies.find(p => p.role === "jungle" && p.items !== undefined)
	const mine = `Your items: ${itemList(s.me.items)}`
	if (!jungler) return mine
	const gap =
		s.me.cs !== undefined && jungler.cs !== undefined ?
			(() => {
				const d = s.me.cs - jungler.cs
				return d === 0 ? ", dead level with you on camps"
					: d > 0 ? `, ${d} camps behind you`
					: `, ${-d} camps ahead of you`
			})()
		:	""
	return `${mine}
${jungler.champion} (their jungler)${jungler.level ? ` lv${jungler.level}` : ""}${
		jungler.cs !== undefined ? `, ${jungler.cs} CS${gap}` : ""
	} — holding: ${itemList(jungler.items)}`
}

/*
 * Why the block spends three lines fencing the purchase mark.
 *
 * `scripts/probe-live-builds.ts`, run against the real socket: two turns after the block marked
 * one item "(just bought)", the coach said the enemy jungler "just bought" a different item that
 * nothing had marked. The phrase itself leaked out of the block and attached to whatever looked
 * newest — the same failure as a stale respawn timer, and it survived every other check. The
 * fence removed it on the two runs after.
 *
 * The evidence lives here rather than in the block because naming the champions and items it
 * happened to involve would put words in the prompt that are not in the player's game — which is
 * the exact failure (a champion named who was not in the game) this file exists to prevent.
 */

/** The authoritative block. Everything in it came from the client, not from the picture. */
export const renderState = (s: VisionState): string => {
	const me = s.me
	/*
	 * A PERCENTAGE, not `412/1830`.
	 *
	 * His health gates every aggressive suggestion there is, and the prompt forbids the model
	 * doing arithmetic on this block — so a ratio it would have to divide is a number it cannot
	 * use. The percentage is the decision-relevant form and it is computed here, where it is
	 * checkable. Dropping the raw figure also removes a readback hook: "you survived with 411
	 * health" is a line about something already on his screen.
	 */
	const hp =
		me.hp !== undefined && me.maxHp !== undefined && me.maxHp > 0 ?
			`${Math.round((me.hp / me.maxHp) * 100)}% HP`
		:	""
	return `## Ground truth (from the game client — these are FACTS, the screenshot is not)

Clock ${s.clock}.

You: ${me.champion}${me.role ? ` (${me.role})` : ""}${me.level ? ` lv${me.level}` : ""} ${me.k ?? 0}/${me.d ?? 0}/${me.a ?? 0}${
		me.cs !== undefined ? `, ${me.cs} CS` : ""
	}${hp ? `, ${hp}` : ""}${me.gold !== undefined ? `, ${Math.round(me.gold)}g` : ""}${
		me.dead ? `, DEAD${me.respawnSec ? ` (respawn ${Math.round(me.respawnSec)}s)` : ""}` : ""
	}

Your team: ${s.allies.map(line).join(" · ") || "unknown"}

Enemy team: ${s.enemies.map(line).join(" · ") || "unknown"}

Alive right now: ${1 + s.allies.filter(p => !p.dead).length - (s.me.dead ? 1 : 0)} of yours against ${s.enemies.filter(p => !p.dead).length} of theirs.
${s.recentEvents.length > 0 ? `
Just happened: ${s.recentEvents.join("; ")}` : ""}

${
		builds(s) ?
			`### Builds — REASON from these, never read one out

${builds(s)}

Complete inventories, item for item, in the client's own words: never say anyone HAS an item that
is not on them, what one cost, or when it was bought. "(just bought)" is true only where THIS
message writes it, and only until the next one. Advising what to buy or finish NEXT is fine.

Use them to make a line you were ALREADY going to say SPECIFIC, never a line of their own: what
the gold he is holding FINISHES, or how a fight or a window sits against the enemy jungler's build.`
		:	`### No build data this tick

Nobody's items could be read. You know nothing about what anyone is holding or has bought — say
nothing about builds at all.`
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
downscaled screenshot accurately, and you do not need to, because they are right here.

Use the screenshot for **where things are** — positions, who is grouped, what is happening on
screen. Use this block for **what is true**.`
}
