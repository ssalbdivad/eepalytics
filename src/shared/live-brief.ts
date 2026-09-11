/**
 * The FULL data brief: everything the Live Client Data API knows, rendered for the model.
 *
 * This replaces the thin ground-truth block for the `full-brief` coach mode. The thin block was
 * built to stop hallucination and it did — but graded over a real game, 52 blinded lines came back
 * 8% useful and 50% generic, because a coach given six facts and 380 lines of prohibitions can only
 * recite the six facts. The bet here is the opposite one: hand over EVERYTHING the feed contains,
 * timestamped and delta'd, and let the model judge. Nothing in this file tells it what to say or
 * when to say it. The only editorial content is true statements about the feed's own properties.
 *
 * Pure and browser-safe: no fs, no db, no network. The renderer is deterministic so the brief can
 * be diffed across samples and replayed by the benches.
 *
 * Sized for Gemini Live, which is the arm worth optimising for (1.15s p50 against 2.05s for the
 * next-fastest and 20.5s for the slowest). Static context belongs in the socket's system
 * instruction; THIS is the per-turn payload, so it stays a few thousand characters, not tens.
 */
import { dragonPhrase } from "./dragons.ts"
import { drakeStakes, orderStakes, stakesClause } from "./objective-stakes.ts"
import type { Stake } from "./objective-stakes.ts"

/*
 * PRONUNCIATIONS ARE NOT RENDERED HERE, AND THAT IS THE FIX, NOT AN OMISSION.
 *
 * Zero of the 715 ground-truth blocks of game 5639406342 carried a pronunciation section and every
 * champion name in that game came out free-styled, so the obvious repair is to render the guide in
 * this file. It is the wrong repair. The guide's first life WAS a line in the per-turn block, and
 * the model read the respellings out loud — *"BRY-er is still at 0 CS"*, to the player, repeatedly.
 * That was not disobedience: this payload is CONTENT, every line in it is a fact the coach may
 * speak, and a line shaped like data gets treated as data.
 *
 * Its home is the SYSTEM INSTRUCTION, where `renderPronunciationGuide` (`shared/pronounce.ts`) puts
 * it and where `src/server/routes/live.ts` now calls it. That agent owns the guide's content and
 * placement; this comment is the named marker so the next reader who notices the block has no
 * respellings finds the reason before re-introducing the regression.
 */


/* ================================================================ input / output */

export interface BriefInput {
	/** A raw `allgamedata` payload from the Live Client Data API. Unknown on purpose: torn and
	 * half-written payloads reach this from a real socket, and the answer to those is `null`. */
	raw: unknown
	gameTimeSec: number
	/** An earlier sample, for the deltas. Absent is normal (first turn); the brief says so. */
	previous?: { raw: unknown; gameTimeSec: number } | null
	/** `analysis.Baseline`-shaped: `Record<string, { mean, n, ... }>`. Loosely read. */
	baseline?: unknown
	/**
	 * A coarse read of the picture that rides with this turn, already worded by the caller as a read
	 * of a picture ("topside blue jungle, from the minimap, 2s old"). It is rendered verbatim inside
	 * NOW and nowhere else. This file computes nothing from pixels; if the caller has no read, or a
	 * low-confidence one, it passes nothing and NOW simply says less.
	 */
	where?: string | null
	/**
	 * The SAME read, structured, so the joins can be computed instead of asked for.
	 *
	 * `where` is prose and prose can only be printed. A prospective join needs the read as data: to
	 * say "drake is up and you are in base" something has to compare the pit's side with his, and a
	 * model asked to do that from a sentence in one section and a timer in another did not do it —
	 * across the 62 lines of game 5639406342 not one joined his position to an objective clock,
	 * while the post-game pack, whose joins were done in TypeScript, produced its best items that way.
	 *
	 * Optional and independent of `where`: a caller with only prose keeps the prose, and NEXT then
	 * renders the timers without the position clause rather than guessing at one. Typed structurally
	 * (a plain union of four strings, not `review/frame-read.ts`'s `Coarse`) because `shared/` may
	 * not import `review/`; the caller passes `coarseOf(read.you)` straight in and the two agree by
	 * construction.
	 */
	at?: PositionFix | null
	/**
	 * The last game clock at which ANYTHING on the enemy jungler's row moved — his level, his farm
	 * counter, his item list.
	 *
	 * The only age an enemy figure has. His row freezes while he is out of vision and jumps when he
	 * is seen again, so every level and every item is a last-known value and this is how old it is.
	 * It needs a record across samples and this file holds two, so the caller owns it:
	 * `coach-memory.ts`'s `cpSeen`. Null renders as "no age this turn" rather than as freshness.
	 */
	counterpartSeenSec?: number | null
	/**
	 * The game clock from which the caller has actually been WATCHING the feed, or null.
	 *
	 * `counterpartSeenSec` is null in two opposite situations and the difference between them is
	 * this number. Early in a game it means the row has genuinely never updated — it is still the
	 * loading-screen default. Later it usually means the WATCHER is new: `coach-memory.ts` can only
	 * report a change it saw happen, so a memory rebuilt mid-game by a daemon restart or a roster
	 * change reports a perfectly live row as never having moved.
	 *
	 * Without it `counterpartClause` printed the GAME clock as the age of its own ignorance —
	 * "his row has NEVER moved in 7m23s" after 43 seconds of watching, verbatim, on a replay of the
	 * real samples with the memory started at 400s. `coach-memory.ts`'s `observedFrom`.
	 */
	counterpartWatchedFromSec?: number | null
	/**
	 * What the coach has ALREADY said this game, newest last, each line already carrying its clock
	 * and, where the caller can support it, the change observed since. Facts only — this file adds
	 * a header and no instruction. Owned by the caller (`coach-memory.ts`); the brief only renders
	 * it, because the model's own turns come back as audio and the thread cannot hold them.
	 */
	said?: string[] | string | null
	/**
	 * THE GAME SO FAR: the accumulated beat log, already rendered and budgeted by the caller.
	 *
	 * The client's own `events.Events` array scrolls, and `newEventsBlock` only ever carries the
	 * gap since the last look, so without this a kill leaves the thread forever the moment the
	 * client stops sending it — at 6:42 of the stored run the payload held three events from the
	 * last 37 seconds and the Hextech drake taken at 6:04 had already fallen out. Owned by
	 * `coach-memory.ts` for the same reason `said` is: `shared/` may not import `analysis/`.
	 */
	narrative?: string | null
	/**
	 * HOW FAR HE IS FROM EACH PIT, IN SECONDS — computed by `analysis/reachability.ts`.
	 *
	 * The third input of the unit of value, and the only one of the three no HUD shows him. He can
	 * read the drake timer off his own screen and he can see his own champion; he cannot see that the
	 * pit is nineteen seconds away. Every one of the ten lines graded useful on game 5639406342 was
	 * a window crossed with a place crossed with whether he could BE there, and this is the third of
	 * those crossings.
	 *
	 * Passed in rather than computed here for the same reason `said` and `narrative` are: the
	 * arithmetic needs `analysis/`'s map math and `shared/` may not import `analysis/`. The type is
	 * structural — `analysis/reachability.ts`'s `Reach` satisfies it by construction, and the two
	 * agree without this file importing that one.
	 *
	 * Matched to objective lines BY LABEL, so a caller that renames an objective loses the clause on
	 * that line and keeps the turn. Absent is the normal early state and renders as nothing.
	 */
	reach?: readonly ReachLine[] | null
	/**
	 * Whether to print the invariant `WHAT THIS FEED IS` block. Default `true`, so every existing
	 * caller and both stored runs keep the section they were graded with. A socket whose system
	 * instruction already states the same nine facts passes `false` and stops paying 1,190
	 * characters a turn for them.
	 */
	feedNotes?: boolean
}

/**
 * One read of the picture, as data.
 *
 * Everything here is a read of PIXELS and nothing is from the feed, which has no coordinates for
 * anybody. The renderer says so on every line it appears in; this shape carries no confidence field
 * because the caller is expected to pass nothing at all rather than pass a read it does not trust —
 * the fence in `review/read-minimap.ts` refuses 45 of 101 reads on the recorded game and is right
 * to, and a fence whose refusals still reach the payload as a low-confidence value is not a fence.
 */
export interface PositionFix {
	/**
	 * The zone as PROSE, already resolved for the side he is on. Rendered verbatim.
	 *
	 * "own blue-side jungle (top)", "enemy red-side jungle (bot)" — both halves, and both halves
	 * are load-bearing. The absolute half ("blue-side") is what the PICTURE settled: the minimap
	 * does not rotate, so blue's base is bottom-left in every frame whoever is playing, and it is
	 * the only thing a read of pixels can honestly assert. The ownership word ("own" / "enemy") is
	 * what the sentence MEANS, and it comes from the live feed's `ORDER`/`CHAOS`, one layer up in
	 * `server/routes/live.ts` where the team id is known.
	 *
	 * This doc used to say ABSOLUTE, never "your jungle", and the route minted the label with
	 * `zoneLabel` to match. On a red-side game — 8 of the 20 recorded games here — `You: blue-side
	 * jungle (top)` is a man standing in the ENEMY jungle, and nothing else in this payload settles
	 * it: the full brief says `side CHAOS` with no CHAOS-is-red mapping anywhere and the delta
	 * carries no side at all. So the one distinction a jungler's whole death-location coaching
	 * turns on was left for the model to guess, and half the time the guess inverts. See
	 * `zoneLabelForTeam` in `review/frame-read.ts` for the flip and `pictureFix` for the caller.
	 */
	label: string
	/** The granularity a jungler's decision turns on; `review/frame-read.ts`'s `Coarse`, structurally. */
	coarse: "topside" | "botside" | "mid" | "base"
	/** The game clock of the PICTURE, not of this turn. The gap between them is the read's age. */
	atSec: number
	/**
	 * Whether this read is still a statement about the PRESENT, or only about the past.
	 *
	 * The caller decides, because the boundary is `analysis/live-facts.ts`'s `FRAME_FRESH_SEC` and
	 * `shared/` may not import `analysis/` — copying the constant in here would make a second
	 * definition of the app's one freshness rule, which is exactly the drift `pictureFix`
	 * delegating to `pictureLine` exists to avoid. See `server/routes/live.ts`.
	 *
	 * `"now"` is the ten-second window: measured over 454 frame-to-event pairs in the 94 stored
	 * games, the coarse half still holds on 92.3% of them, so the present tense is a fact.
	 * `"last-known"` is older than that and is rendered in the PAST tense with its age — true at
	 * any age, and left for the model to weigh rather than gated away, because the turns with no
	 * fresher read are the REACTIVE ones and they are the turns where position decides the
	 * sentence. Absent means `"now"`: every caller that had no concept of this was passing a read
	 * taken on the turn.
	 */
	asOf?: "now" | "last-known"
	/**
	 * The other icons on the same picture, as absolute zone labels.
	 *
	 * ANONYMOUS on purpose. The minimap reader returns enemy dots with no identity — it cannot tell
	 * Kayn's icon from Singed's — so these are rendered as "an enemy icon", never as a champion.
	 * Naming one would be the exact failure the reader's own fence exists to stop: 16 of its
	 * refusals on the recorded game were the model pointing at a red-ringed Singed and calling it him.
	 */
	enemies?: readonly string[]
}

/**
 * One objective's reachability, as data. `analysis/reachability.ts`'s `Reach`, structurally.
 *
 * Everything here is arithmetic over three things: a position (a read of a PICTURE), the map's own
 * pit coordinates, and `activePlayer.championStats.moveSpeed`. Nothing in it is a judgement, and
 * there is deliberately no `verdict` field — whether a 14-second walk is worth taking against a
 * 39-second clock is the decision, and the decision is the model's.
 */
export interface ReachLine {
	/** Must match the objective's label in NEXT verbatim; that is the join. */
	label: string
	/** Where the walk starts. `fountain` means he is dead and starts from his own base. */
	origin: "minimap" | "fountain" | null
	/** Age of the position read, seconds. `null` for a fountain origin, which has no age. */
	ageSec: number | null
	/** Straight-line units to the pit. A FLOOR on the walked path — walls and jungle make it longer. */
	units: number | null
	/** How far in ANY direction he could have gone since the read: `age * speed`. Zero when dead. */
	driftUnits: number
	/** False when the drift is at least the distance: the read no longer bounds the answer. */
	constrained: boolean
	/** Units per second, instantaneous and buff-inclusive. Rendered, never laundered into "his speed". */
	speed: number | null
	/** Seconds before he can move at all: 0 alive, the respawn timer dead. */
	delaySec: number
	etaMinSec: number | null
	etaMaxSec: number | null
	marginMinSec: number | null
	marginMaxSec: number | null
	/** Seconds until the objective is up. Negative means it is already standing. */
	windowSec: number
}

export interface LiveBrief {
	text: string
	chars: number
	me: string
	counterpart: string | null
	roster: string[]
	/** Per-section character counts, in the order they were rendered. Reporting, not content. */
	sections?: Array<{ name: string; chars: number }>
}

/* ================================================================ narrowing */

const rec = (v: unknown): Record<string, unknown> | null =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)

/* ================================================================ formatting */

export const clock = (sec: number): string => {
	const s = Math.max(0, Math.floor(sec))
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** "13s" / "2m11s". */
const dur = (sec: number): string => {
	const s = Math.max(0, Math.round(sec))
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`
}

/** "13s ago" / "2m11s ago". Every event carries one — see the event log's comment. */
const age = (sec: number): string => `${dur(sec)} ago`

const r0 = (n: number): string => String(Math.round(n))
const r1 = (n: number): string => (Math.round(n * 10) / 10).toFixed(1)
const signed = (n: number): string => (n > 0 ? `+${r0(n)}` : r0(n))

/* ================================================================ players */

interface Item {
	name: string
	/** Read and kept for the readers; NEVER rendered and never summed. See the note below `Player`. */
	price: number
	count: number
	consumable: boolean
}

interface Player {
	name: string
	champion: string
	team: string
	position: string
	level: number
	kills: number
	deaths: number
	assists: number
	cs: number
	ward: number
	dead: boolean
	respawn: number
	items: Item[]
	spells: string[]
}

const readItems = (v: unknown): Item[] =>
	arr(v)
		.map(raw => {
			const it = rec(raw)
			if (!it) return null
			return {
				name: str(it.displayName) ?? "?",
				price: num(it.price) ?? 0,
				count: num(it.count) ?? 1,
				consumable: it.consumable === true
			}
		})
		.filter((i): i is Item => i !== null)

const readPlayer = (raw: unknown): Player | null => {
	const p = rec(raw)
	if (!p) return null
	const champion = str(p.championName)
	if (!champion) return null
	const scores = rec(p.scores) ?? {}
	const spells = rec(p.summonerSpells) ?? {}
	const spellName = (k: string): string | null => str(rec(spells[k])?.displayName ?? null)
	return {
		name: str(p.riotIdGameName) ?? str(p.summonerName) ?? champion,
		champion,
		team: str(p.team) ?? "?",
		position: str(p.position) ?? "",
		level: num(p.level) ?? 0,
		kills: num(scores.kills) ?? 0,
		deaths: num(scores.deaths) ?? 0,
		assists: num(scores.assists) ?? 0,
		cs: num(scores.creepScore) ?? 0,
		ward: num(scores.wardScore) ?? 0,
		dead: p.isDead === true,
		respawn: num(p.respawnTimer) ?? 0,
		items: readItems(p.items),
		spells: [spellName("summonerSpellOne"), spellName("summonerSpellTwo")].filter(
			(s): s is string => s !== null
		)
	}
}

/**
 * The enemy jungler: the counterpart he is actually racing, and the player whose numbers he cannot
 * read off his own HUD.
 *
 * `position` comes from the LIVE feed, which is a different source from the post-game
 * `timeline.lane`/`.role` this repo does not trust (4/10 mislabelled). Smite is the fallback and
 * the tiebreak, because a jungler without Smite is not a jungler.
 */
const findCounterpart = (players: Player[], me: Player): Player | null => {
	const enemies = players.filter(p => p.team !== me.team)
	return (
		enemies.find(p => p.position === "JUNGLE") ??
		enemies.find(p => p.spells.some(s => s.toLowerCase().includes("smite"))) ??
		null
	)
}

/*
 * `goldSpent` USED TO LIVE HERE and is deleted. It summed `item.price` and the brief printed the
 * result as "Gold he has spent on those items", for him and for the enemy jungler both.
 *
 * It is off by a factor of three to five and always the same way. Audited against the post-game
 * truth for game 5639406342: the sum recovers 0.27 of the gold actually spent — 3,626g read against
 * 15,278g truly earned — because `price` is the SHOP price of the row as it now stands, so a
 * component that has been consumed into a legendary contributes its own small number and the
 * legendary contributes the upgrade cost only. Liandry's Torment reads 800 on a ~3,000g item;
 * Hubris reads 750. Both figures are in the recorded samples, both were rendered, and a number that
 * confident and that wrong is worse than no number: "he has only spent 1,900 gold" is a false
 * statement about the man he is racing, and it is checkable by nobody.
 *
 * Item IDENTITY is exact and survives. That is what the counterpart comparison uses now.
 */

/** Names only. Prices are not rendered anywhere in this file — see above. */
const itemLine = (p: Player): string =>
	p.items.length === 0 ? "no items" : p.items.map(i => `${i.name}${i.count > 1 ? ` x${i.count}` : ""}`).join(", ")

/** Trinkets, wards and consumables churn on every back and are not what a build comparison is about. */
const CHURN = /Trinket|Ward|Potion|Refillable|Elixir|Biscuit|Lens/i

/**
 * What a player is actually BUILDING: the shop rows, without the trinket and the consumables.
 *
 * `consumable` is the client's own flag and is trusted; the name pattern catches the trinket, which
 * is not flagged. The count is rendered beside the names because "three items to your five" is the
 * comparison a jungler makes at a glance and summing prices to get there is the thing that lied.
 */
const shopItems = (p: Player): Item[] => p.items.filter(i => !i.consumable && !CHURN.test(i.name))

const buildLine = (p: Player): string => {
	const kit = shopItems(p)
	return kit.length === 0 ? "nothing built yet" : `${kit.length} — ${kit.map(i => i.name).join(", ")}`
}

const deadTag = (p: Player): string => (p.dead ? ` DEAD, respawns in ${r0(p.respawn)}s` : "")

/* ================================================================ the counterpart, without the CS race
 *
 * ## The enemy jungler's CS is a VISIBILITY COUNTER, and this app said it out loud for a year
 *
 * The Live Client Data API does not report the enemy jungler's farm. It reports how much of his
 * farm YOUR CLIENT WITNESSED, and it floors that to ten on top. Measured against the post-game
 * timeline for game 5639406342, Kayn's true CS against what the feed said:
 *
 *     minute      feed   truth   his real lead   what the coach told him
 *      5:00          0      32              -4                     +28
 *     10:00         20      58             +10                     +48
 *     14:00         30      84              -4                     +50
 *     20:00         50     125              -4                     +71
 *     25:00         60     156              -4                     +92
 *     28:00         70     183             -18                     +95
 *
 * He was LEVEL ON FARM for the whole game and was told he was up 71, then up 92, and told to "keep
 * stealing Kayn's farm". Both of the two FALSE cards in the blinded post-game grading of that game
 * are this one field. It under-reports by 2.6x by the end and the error grows monotonically,
 * because it is a count of sightings and a jungler is mostly unseen.
 *
 * `csGap` does not save it. `csGap` widens an interval for the FLOORING, which is a rounding error
 * of at most nine; this is a systematic omission of a hundred and thirteen. A rounding-aware
 * comparison of a number that is not the quantity it is named after is a careful arithmetic on a
 * false premise, and it renders as "you are at least +30 on farm", which reads as measured.
 *
 * So the CS race is gone. Not hedged, not widened, not demoted to low confidence: a comparison
 * between his CS and the counterpart's is not rendered anywhere in this file, in any section, in
 * either mode. The two fields that survive the audit take its place.
 *
 * ## What replaces it
 *
 * LEVEL. Exact for him always; for enemies 94.5% exact over this game and 93.5-97.0% across
 * fourteen, worst error -2, every error transient. It is the same race — a jungler who is two
 * levels down lost the same race a jungler who is fifty CS down lost — and it is a number he cannot
 * read off his own HUD without clicking the enemy portrait.
 *
 * ITEMS. Identity and count are exact once a player has been seen; before first sighting the list
 * is EMPTY, and empty means unseen, not unbought — so an empty list is rendered as "nothing seen
 * yet", never as "he has bought nothing". Their PRICES are not rendered; see `goldSpent`'s grave.
 *
 * Both carry "as last seen at M:SS", because the enemy rows freeze while the player is out of
 * vision. That marker is the difference between a fact and a claim about right now.
 */

/**
 * The level race and the build race, in one clause, with the staleness on the front.
 *
 * `seenAtSec` is the last game clock at which anything on the counterpart's row moved, which is the
 * only age any enemy figure has. The caller owns it because it needs a record across samples and
 * this file holds two — `coach-memory.ts`'s `cpSeen` is that record. Absent, the clause simply does
 * not claim a time, which is the honest degradation.
 */
/**
 * How long a never-updated counterpart row is allowed to pass without comment.
 *
 * Under this, "no age" is true and unremarkable — nothing has had time to change. Over it, a row
 * that has never moved is a fact about the client's vision, and the strongest one in the payload.
 * Thirty seconds is the first camp: by then a jungler has levelled and a row still reading level 1
 * is frozen, not current.
 */
const NEVER_SEEN_GRACE_SEC = 30

/**
 * How old the counterpart's row is, in one clause, in the two lengths the payload has room for.
 *
 * A null `seenAtSec` has TWO meanings and they are opposites, so this must not render one phrase.
 *
 * Early in a game it means the row has NEVER updated — every figure on it is still the loading
 * screen's default, level 1 with no items, and it will read that way until his client is first
 * seen. At 2:06 of game 5639406342 the coach read "Kayn: alive, lvl 1 — 2 levels BELOW you ... his
 * row carries no age this turn" and said "you are two whole levels up on Kayn". The post-game
 * timeline has him at level 2. One of those levels was fog rendered as fact.
 *
 * Later a null usually means the WATCHER is new rather than the row frozen, because the caller can
 * only report a change it saw happen. THE ROW IS CHECKED BEFORE THE CLAIM IS MADE for exactly that
 * reason: "still your client's defaults" was asserted from the ABSENCE of an observation, and on a
 * replay with the memory started at 400s it rendered beside `lvl 5 ... Build: 3 to your 3 —
 * Scorchclaw Pup, Long Sword, Long Sword`, telling the model to discard a real level gap because a
 * level-5 row with three items was a default. A row that carries a level above 1 or any item is
 * evidence about the client that beats the absence of a sighting, so it gets the honest sentence
 * instead: the age is unknown to this session.
 *
 * `NEVER_SEEN_GRACE_SEC` is the only judgement here: for the first few seconds of a game the row
 * genuinely IS current, because nothing has had time to change, and warning about it then is noise.
 *
 * KEPT SHORT DELIBERATELY, in both forms. The first version of the long one ran to 200 characters
 * and the delta's cap paid for it by truncating from the bottom, which evicted WHAT YOU HAVE
 * ALREADY SAID — the section this file's own comments warn is the one that gets evicted. A warning
 * that costs the coach its memory is not a net gain, and the test suite caught it.
 */
const rowAge = (
	c: Player,
	now: number,
	seenAtSec: number | null,
	watchedFromSec: number | null,
	short = false
): string => {
	if (seenAtSec !== null)
		return short ?
				`row ${dur(now - seenAtSec)} old`
			:	`anything on his row last moved at ${clock(seenAtSec)} (${age(now - seenAtSec)})`
	if (now <= NEVER_SEEN_GRACE_SEC) return short ? "row age n/a" : "his row carries no age this turn"
	/*
	 * The watch's own age, never the game clock. `dur(now)` reported twenty minutes of not having
	 * been there as twenty minutes of a frozen row; a caller that cannot say when it started
	 * watching gets no duration at all rather than a borrowed one.
	 */
	const watched = watchedFromSec === null ? null : Math.max(0, now - watchedFromSec)
	const looking = watched === null ? "" : ` in ${dur(watched)} of watching`
	// A level above 1 or any item is the row refuting the claim in the same sentence.
	const looksDefault = c.level <= 1 && shopItems(c).length === 0
	if (looksDefault)
		return short ?
				"row still at defaults"
			:	`his row has NEVER moved${looking} and still reads the loading-screen default, so this level is not a gap`
	return short ?
			"row age unknown"
		:	`his row has not moved${looking}, but it is above its defaults, so it moved before this session started watching and its true age is UNKNOWN — do not read this level as current`
}

const counterpartClause = (
	me: Player,
	c: Player,
	now: number,
	seenAtSec: number | null,
	watchedFromSec: number | null,
	/** True on the FULL brief, which is sent once a game and is the one payload with room. */
	full: boolean
): string => {
	const dLevel = me.level - c.level
	const race =
		dLevel === 0 ? "level with you"
		: dLevel > 0 ? `${dLevel} level${dLevel === 1 ? "" : "s"} BELOW you`
		: `${-dLevel} level${dLevel === -1 ? "" : "s"} ABOVE you`
	const kit = shopItems(c)
	const mine = shopItems(me)
	const build =
		kit.length === 0 ?
			"Build: nothing of his has been seen yet — an empty item list means unseen, not unbought"
		:	`Build: ${kit.length} to your ${mine.length} — ${kit.map(i => i.name).join(", ")}`
	/*
	 * THE RACE AND THE SCORE ARE NOT REPEATED HERE, and the row's age is only spelled out when it
	 * is the DANGEROUS kind.
	 *
	 * NOW renders `Counterpart Kayn: alive, lvl 8 — level with you, 3/2/1 (row 0s old)` two lines
	 * above this one in every payload both modes produce, so a second copy of the level gap, the
	 * K/D/A and the age was about 105 characters a turn of the same words — and inside a fixed cap
	 * a duplicated fact is paid for by whatever falls off the bottom, which this file has already
	 * watched be the memory twice. What is kept here is what NOW does not carry and what a decision
	 * about a pit actually consumes: the build, and the long-form age ONLY when `rowAge` has
	 * something to warn about (a row that has never moved, or one whose true age is unknown to this
	 * session). When the age is a plain number NOW's six-word form is the whole fact.
	 *
	 * "His death and respawn are live" rides only while he IS dead, which is the turn it argues
	 * about. On an alive turn it was 31 characters explaining the trustworthiness of a figure that
	 * was not being printed.
	 */
	/*
	 * The long age rides on the full brief always, and on a DELTA only when it is the warning
	 * rather than the number. A null `seenAtSec` is the dangerous case `rowAge` was written for and
	 * it keeps its sentence in both modes; a row with a real age has already been printed six words
	 * long in NOW, two lines above, and this was the second copy.
	 */
	const age = full || seenAtSec === null ? ` ${rowAge(c, now, seenAtSec, watchedFromSec)}.` : ""
	const live = c.dead || full ? "His death and respawn are live;" : ""
	return `${c.champion}: ${c.dead ? `DEAD, back in ${r0(c.respawn)}s` : "alive"}, lvl ${c.level} — ${race}.${full ? ` ${c.kills}/${c.deaths}/${c.assists}.` : ""} ${build}.${live === "" ? "" : ` ${live}`}${age}`
}

/**
 * Which pit an objective take puts a player at. Fixed map geometry, and the only thing an
 * objective event says about anybody's position.
 *
 * The sides are `DRAKE_SIDE` and `BARON_SIDE`, the same two constants NEXT labels its objective
 * lines with — which is exactly why `counterpartWhere` has to say out loud that those labels are
 * the pit's side and not his. See its comment for the line that was said without it.
 */
const pitOf = (eventName: string): string | null =>
	eventName === "DragonKill" ? `the drake pit (${DRAKE_SIDE})`
	: eventName === "HordeKill" ? `the voidgrub pit (${BARON_SIDE})`
	: eventName === "HeraldKill" ? `the Herald pit (${BARON_SIDE})`
	: eventName === "BaronKill" ? `the Baron pit (${BARON_SIDE})`
	: null

/** A victim's declared role, named as whose it is. The feed labels one of each role per team. */
const roleOf = (me: Player, p: Player | undefined): string => {
	const side = p === undefined ? "" : p.team === me.team ? "your" : "their"
	const role =
		p === undefined ? ""
		: p.position === "TOP" ? "TOP"
		: p.position === "MIDDLE" ? "MID"
		: p.position === "BOTTOM" || p.position === "UTILITY" ? "BOT lane"
		: p.position === "JUNGLE" ? "JUNGLE"
		: ""
	return role === "" ? "" : ` (${side} ${role})`
}

/**
 * WHERE THE ENEMY JUNGLER IS — stated as the absence it is, on every single turn.
 *
 * ## The failure
 *
 * At 11:39 of game 5639406342 the coach said *"Kayn is topside getting grubs"*. Kayn was on the
 * screenshot, next to him, in the bot river. Nothing in that payload was false: it carried
 * `- 10:45 (54s ago) Kayn took a voidgrub` in the event log and `- Voidgrubs (top side): 3 taken`
 * in NEXT, and the model crossed a 54-second-old event with a PIT's side and rendered the result
 * in the present tense as a position. Four of the seven false lines in that run are this move.
 *
 * A gap is an invitation, and this app has one answer to it that has ever worked: state the
 * absence as a fact, in the section where the temptation lives, every turn. `ROSTER_NO_CONDITION`
 * did it for the health column, `buildBrief` does it for the counterpart's farm figure, and this
 * does it for the one field a jungler most wants and the one this app can never have.
 *
 * ## What it says, and why each clause is there
 *
 * - **Not in this payload.** The blunt statement. There is no position for him anywhere: not in
 *   the feed, which has no coordinates for anyone, and not from the reader, which cannot name him.
 * - **The icons above are unlabelled.** Rendered only when the picture had enemy icons on it,
 *   because otherwise it refers to nothing. The minimap reader returns enemy dots with no identity
 *   — 16 of its refusals on this game were the model pointing at a red-ringed Singed and calling
 *   it him — so a red icon is evidence about a patch of ground and never about Kayn.
 * - **Each objective line's side is the PIT's side.** The clause aimed straight at 11:39. `NEXT`
 *   labels every objective with the half of the map its pit sits on, and that label was read as a
 *   statement about the jungler who last touched it.
 * - **The two things that DO place him, in the past, each with its clock and its age.** His last
 *   objective take and his last kill are the only place-shaped facts the feed has about him, and
 *   both of them are about a moment that has gone. Rendered as a time with a place attached rather
 *   than a place with a time attached, because the tense is the whole difference between the ten
 *   useful lines of that run and this one: *"Kayn just took that drake bot side, so he's there"*
 *   at 7:23 was useful and TRUE at 7:23; the same sentence about a 54-second-old grub was not.
 *
 * It is a statement about the payload's own contents. It names no subject, forbids nothing and
 * tells the model neither what to say nor when — a coach that works out from the event log where
 * the enemy jungler probably is, and says it in the voice of a guess, is doing its job.
 */
/**
 * How old a place-shaped fact about him may be and still be rendered.
 *
 * The same two minutes `FIGHT_STALE_SEC` uses, for the same reason: past that it is history, the
 * narrative already carries it, and it is 70 characters of a payload that has a cap. A five-minute
 * old kill says nothing about where anyone is, and a stale line in a section headed by an absence
 * is exactly the kind of thing that gets read forward into the present tense — which is the failure
 * this whole block exists to answer.
 */
const PLACED_STALE_SEC = 120

const counterpartWhere = (s: Scene, c: Player, at: PositionFix | null | undefined): string => {
	const icons =
		(at?.enemies ?? []).length > 0 ?
			" the enemy icons above are unlabelled so none is known to be his,"
		:	""
	const placed: string[] = []
	const mine = s.events
		.filter(e => str(e.raw.KillerName) === c.name && s.now - e.t <= PLACED_STALE_SEC)
		.sort((a, b) => a.t - b.t)
	const obj = mine.filter(e => pitOf(e.name) !== null).at(-1)
	if (obj !== undefined)
		placed.push(`${clock(obj.t)} (${age(s.now - obj.t)}) at ${pitOf(obj.name)}, taking it`)
	const kill = mine.filter(e => e.name === "ChampionKill").at(-1)
	if (kill !== undefined) {
		const victim = s.players.find(p => p.name === str(kill.raw.VictimName))
		placed.push(
			`${clock(kill.t)} (${age(s.now - kill.t)}) wherever the kill on ${s.who(kill.raw.VictimName)}${roleOf(s.me, victim)} happened`
		)
	}
	return `WHERE ${c.champion.toUpperCase()} IS: not in this payload — nothing here carries a position for him,${icons} and each objective line's side is the PIT's, not his. ${
		placed.length === 0 ?
			`Nothing has placed him anywhere in the last ${dur(PLACED_STALE_SEC)}.`
		:	`He WAS: ${placed.join("; ")}.`
	}`
}

/* ================================================================ events */

interface Ev {
	name: string
	t: number
	raw: Record<string, unknown>
}

const readEvents = (data: Record<string, unknown>): Ev[] => {
	const holder = rec(data.events)
	return arr(holder?.Events)
		.map(raw => {
			const e = rec(raw)
			const name = e && str(e.EventName)
			const t = e && num(e.EventTime)
			return e && name && t !== null ? { name, t, raw: e } : null
		})
		.filter((e): e is Ev => e !== null)
}

/** Event participants are SUMMONER names, not champion names, so every line gets mapped. */
const namer = (players: Player[]) => {
	const byName = new Map(players.map(p => [p.name, p]))
	return (raw: unknown): string => {
		const s = str(raw)
		if (!s) return "someone"
		const p = byName.get(s)
		if (p) return p.champion
		if (s.startsWith("Minion_") || s.startsWith("Turret_")) return "minions/turret"
		return s
	}
}

const describeEvent = (e: Ev, who: (v: unknown) => string): string | null => {
	const k = e.raw
	const assists = arr(k.Assisters).map(who)
	const withAssists = assists.length > 0 ? ` (assists: ${assists.join(", ")})` : ""
	switch (e.name) {
		case "ChampionKill":
			return `${who(k.KillerName)} killed ${who(k.VictimName)}${withAssists}`
		case "FirstBlood":
			return `first blood to ${who(k.Recipient)}`
		case "DragonKill":
			return `${who(k.KillerName)} took ${dragonPhrase(str(k.DragonType))}${
				k.Stolen === "True" ? " (STOLEN)" : ""
			}${withAssists}`
		case "HordeKill":
			return `${who(k.KillerName)} took a voidgrub${withAssists}`
		case "HeraldKill":
			return `${who(k.KillerName)} took Rift Herald${withAssists}`
		case "BaronKill":
			return `${who(k.KillerName)} took Baron${k.Stolen === "True" ? " (STOLEN)" : ""}${withAssists}`
		case "TurretKilled":
			return `${who(k.KillerName)} destroyed a turret${withAssists}`
		case "InhibKilled":
			return `${who(k.KillerName)} destroyed an inhibitor${withAssists}`
		case "Multikill":
			return `${who(k.KillerName)} multikill x${num(k.KillStreak) ?? 2}`
		case "Ace":
			return `ACE for ${str(k.AcingTeam) ?? "a team"} (${who(k.Acer)})`
		case "MinionsSpawning":
		case "GameStart":
		case "FirstBrick":
			return null
		default:
			return e.name
	}
}

/* ================================================================ objectives */

/** Standard respawn intervals. Stated as the schedule they are, not as an observation. */
const DRAKE_RESPAWN_SEC = 300
const BARON_RESPAWN_SEC = 360

/*
 * FIXED SPAWN TIMES, RE-DERIVED FROM THE 94 STORED TIMELINES. See `live-brief-schedule.test.ts`,
 * which recomputes every one of these from `data/blobs` and fails if a patch moves it.
 *
 * These are rules of the map, not readings from the feed — the feed carries no spawn clock at all,
 * only kills after the fact. They are here because the gap was otherwise filled by the model: at
 * 6:05 of a graded run it said "Voidgrubs are spawning in a minute", which was false and turned the
 * best-informed line in that run into its only fabrication. A schedule the brief does not state is
 * a schedule the model will invent.
 *
 * ## Two of them were WRONG, and being stated made that worse
 *
 * `GRUBS_SPAWN_SEC` was 300 and `HERALD_SPAWN_SEC` was 840, from an older patch. Against every
 * ELITE_MONSTER_KILL in the corpus (gameVersion 16.17 and 16.18): 279 HORDE kills, earliest 8:06,
 * p5 8:16, none earlier; 89 RIFTHERALD kills, earliest 15:27, p5 15:32, none earlier. So grubs
 * spawn at 8:00 and Herald at 15:00, and the pit is EMPTY for the minute between the grubs leaving
 * and Herald arriving — which is why the old "they leave at 14:00, when Rift Herald takes it" was
 * two errors in one clause.
 *
 * Replayed through `buildDelta` on the recorded samples of game 5639406342, the old numbers put
 * `- Voidgrubs (top side): UP since 5:00 and untouched by anyone for 2m30s.` in NEXT at 7:29 — the
 * grubs did not exist, and the first one died at 10:22 — and `- Rift Herald (top side): UP since
 * 14:00 and untaken for 30s.` at 14:30, an hour of game clock before the one that was actually
 * killed at 18:02. NEXT is rank 0 and is never dropped, so every game carried a false grub claim
 * from 2:30 to 8:00 and a false Herald claim from 14:00 to 15:00.
 *
 * `BARON_SPAWN_SEC` and the first drake check out on the same corpus: earliest BARON_NASHOR kill
 * 20:49 and earliest DRAGON 5:33, so 20:00 and 5:00 stand.
 *
 * Only values that have held steady across current League go in as numbers. Anything that moves
 * between patches is rendered as prose that says so, and anything not known is rendered as
 * "not known" — an invented schedule is the exact bug this is fixing.
 */
const GRUBS_SPAWN_SEC = 480
/** Latest HORDE kill in the corpus is 13:13, so nothing here contradicts the 14:00 despawn. */
const GRUBS_GONE_SEC = 840
const HERALD_SPAWN_SEC = 900
/**
 * WHEN THE RIFT HERALD LEAVES — measured, because without it this file claimed one that was not there.
 *
 * The grubs had a despawn gate from the day they were written and the Herald never did, so an
 * untaken Herald was rendered as STANDING for the rest of the game. On the paired stream of game
 * 5639409343 nobody took it, and the payload said "Rift Herald (top side): UP since 15:00 and
 * untaken for 8m58s" at 23:58 — four minutes after it had left the map. Seven turns of that run
 * carried the sentence, and `orderStakes` then put it at the TOP of every one of them, because a
 * standing objective outranks a spawning one and nothing was bounding how long it could stand.
 * The coach ignored it on all seven, which was correct, and the ordering it was ignoring was mine.
 *
 * The number is the corpus's, not the patch notes'. Across all 96 stored timelines there are 91
 * RIFTHERALD kills: the earliest is 15:27, and THIRTEEN of them land on exactly 19:45 with two
 * frame-rounded stragglers at 19:48 and 19:51. A pile-up that size at one clock is the despawn
 * being recorded as a kill, which is the same shape `GRUBS_GONE_SEC` was measured from.
 */
const HERALD_GONE_SEC = 1185
/**
 * The first drake, which used to have no gate at all — see `nextBlock`.
 *
 * Earliest first-drake kill across the 94 stored games is 5:33, then 5:34 and 5:42, so it spawns at
 * 5:00. Before this constant existed NEXT said "none taken, the first is still standing" from 0:00,
 * which is false for the first five minutes of every game.
 */
const DRAKE_FIRST_SPAWN_SEC = 300
const BARON_SPAWN_SEC = 1200

/** "5:00, in 43s" / "5:00, which has passed (47s ago)" — a clock, never a bare countdown. */
const spawnPhrase = (at: number, now: number): string =>
	at > now ?
		`${clock(at)}, in ${dur(at - now)}`
	:	`${clock(at)}, which has passed (${age(now - at)})`

const objectiveBlock = (
	events: Ev[],
	players: Player[],
	me: Player,
	now: number,
	who: (v: unknown) => string
): string[] => {
	const teamOf = new Map(players.map(p => [p.name, p.team]))
	const side = (killer: unknown): "ours" | "theirs" | "unknown" => {
		const t = teamOf.get(str(killer) ?? "")
		return t === undefined ? "unknown" : t === me.team ? "ours" : "theirs"
	}
	const drakes = events.filter(e => e.name === "DragonKill")
	const ours = drakes.filter(e => side(e.raw.KillerName) === "ours")
	const theirs = drakes.filter(e => side(e.raw.KillerName) === "theirs")
	const listing = (list: Ev[]): string =>
		list.length === 0 ? "none"
		:	list.map(e => `${dragonPhrase(str(e.raw.DragonType))} at ${clock(e.t)}`).join(", ")

	const grubs = events.filter(e => e.name === "HordeKill")
	const herald = events.filter(e => e.name === "HeraldKill")
	const barons = events.filter(e => e.name === "BaronKill")
	const towers = events.filter(e => e.name === "TurretKilled")

	const lastDrake = drakes.at(-1) ?? null
	/*
	 * The same first-drake gate `nextBlock` has, for the same reason. This line used to read "no
	 * drake taken yet, so the first one is still standing" from 0:00, and the first drake spawns at
	 * 5:00 — earliest kill across the 94 stored games is 5:33 — so it was false for the opening
	 * five minutes of every game, in the section the model is told holds the map's own schedule.
	 */
	const nextDrake =
		lastDrake === null ?
			DRAKE_FIRST_SPAWN_SEC > now ?
				`the first drake spawns at ${clock(DRAKE_FIRST_SPAWN_SEC)}, in ${r0(DRAKE_FIRST_SPAWN_SEC - now)}s; none has been taken`
			:	`the first drake has been up since ${clock(DRAKE_FIRST_SPAWN_SEC)} (${age(now - DRAKE_FIRST_SPAWN_SEC)}) and none has been taken`
		:	(() => {
				const up = lastDrake.t + DRAKE_RESPAWN_SEC
				return up <= now ?
						`next drake has been up since ${clock(up)} (${age(now - up)})`
					:	`next drake spawns at ${clock(up)}, in ${r0(up - now)}s (standard ${clock(DRAKE_RESPAWN_SEC)} respawn)`
			})()
	const lastBaron = barons.at(-1) ?? null
	const nextBaron =
		lastBaron === null ? null : (
			(() => {
				const up = lastBaron.t + BARON_RESPAWN_SEC
				return up <= now ?
						`Baron has been up again since ${clock(up)}`
					:	`Baron respawns at ${clock(up)}, in ${r0(up - now)}s (standard ${clock(BARON_RESPAWN_SEC)} respawn)`
			})()
		)

	const lines = [
		`Drakes YOUR team: ${listing(ours)}`,
		`Drakes ENEMY team: ${listing(theirs)}`,
		nextDrake,
		`Voidgrubs: first spawn ${spawnPhrase(GRUBS_SPAWN_SEC, now)}. ${
			grubs.length === 0 ?
				now < GRUBS_SPAWN_SEC ? "None taken; none have spawned yet."
				: now >= GRUBS_GONE_SEC ? "None taken, and they are gone from the map now."
				: "None taken so far this game."
			:	`Taken: ${grubs.map(e => `${who(e.raw.KillerName)} at ${clock(e.t)}`).join(", ")} (${grubs.length} killed).`
		} They leave the pit at ${clock(GRUBS_GONE_SEC)} and Rift Herald arrives at ${clock(HERALD_SPAWN_SEC)}, so the pit is empty in between. How long after a set is cleared the next set spawns is a patch value that has moved, so it is NOT stated here — do not put a number on it.`,
		`Rift Herald: spawn ${spawnPhrase(HERALD_SPAWN_SEC, now)}. ${
			herald.length === 0 ?
				now < HERALD_SPAWN_SEC ? "Not taken; not up yet."
				:	"Not taken."
			:	`Taken by ${herald.map(e => `${who(e.raw.KillerName)} at ${clock(e.t)}`).join(", ")}.`
		}`,
		/*
		 * SCUTTLE HAS NO NUMBER HERE, and that is a demotion rather than an oversight.
		 *
		 * It used to render `first spawn 3:15`, from a `SCUTTLE_SPAWN_SEC` constant that nothing in
		 * this repo can check: the live feed logs no scuttle kill and the post-game timeline has no
		 * scuttle event either, so the corpus that caught the grub and Herald errors is silent on
		 * this one. Two of the four constants that WERE checkable turned out to be a patch behind.
		 * A number nobody can re-derive, sitting in the section the model is told to trust, is the
		 * next one of those waiting to happen — so it goes out as prose, which is the treatment
		 * this block already gives the grub respawn cadence for the same reason.
		 */
		`Scuttle crabs: one in each river, first pair a few minutes in. The exact spawn clock and the respawn cadence are patch values this app cannot check — the live feed logs no scuttle kill at all and neither does the post-game timeline — so no scuttle time is stated here and which crabs are up right now is NOT KNOWN. Do not put a number on it.`,
		`Baron Nashor: spawn ${spawnPhrase(BARON_SPAWN_SEC, now)}. ${
			barons.length === 0 ?
				now < BARON_SPAWN_SEC ? "Not taken; not up yet."
				:	"Not taken."
			:	`Taken by ${barons.map(e => `${who(e.raw.KillerName)} at ${clock(e.t)}`).join(", ")}.`
		}`,
		`Turrets down: ${towers.length} total (this feed names the turret but not reliably which side, so the count is the honest figure)`
	]
	if (nextBaron !== null) lines.push(nextBaron)
	return lines
}

/* ================================================================ deltas */

interface Moves {
	dCs: number
	dGold: number
	dHp: number
	dMana: number
	dLevel: number
	dItems: number
}

/**
 * What the deltas IMPLY he is doing. Said as an inference from the numbers, because that is exactly
 * what it is — the feed carries no position and no action. This exists because the coach twice told
 * him to "go take the far camps" while his own CS and gold were ticking, i.e. while he was already
 * mid-camp. Nothing else in the payload says what he is doing right now, which is why it is the
 * first thing NOW says and no longer the last line of the seventh section.
 *
 * Two branches are worded as ambiguity rather than as findings, and both were measured wrong in the
 * graded window:
 *
 * - Every player's CS is floored to a multiple of ten, so a jungler mid-clear reads a delta of 0 for
 *   most of a clear and reads 0 ABSOLUTE for the whole first two minutes. Nine of twelve graded
 *   briefs therefore ended on "gold rose with no CS, so it is passive income or a kill/assist share,
 *   not farming" while the frames showed him on the Blue Sentinel, on Gromp and on a bot-side camp.
 *   The numbers genuinely cannot separate those; the line now says so instead of picking.
 * - Before minions meet, gold falling while items appear is the STARTING purchase. At 0:36 the old
 *   branch read "he just backed and bought" for a man who had never left the fountain, and the coach
 *   said "Good back for the seedling."
 */
const doingPhrases = (me: Player, m: Moves, now: number, wasDead = false): string[] => {
	if (me.dead) return [`he is DEAD and respawns in ${r0(me.respawn)}s`]
	/*
	 * A RESPAWN, before anything else, because otherwise it is narrated as a heal.
	 *
	 * `dHp > 100` was reached by a man walking out of the fountain exactly as it is by a man
	 * recalling, and nothing here consulted the previous sample's death state. Verified on
	 * split-03: 6 of the 9 respawn-crossing turns opened `HP is climbing, so he is healing,
	 * recalling or out of combat` while SINCE read `HP 0->2935`, and nowhere in the payload did it
	 * say he had died. The prompt tells the model to read the opening words first, so the top of
	 * the payload is exactly where a death got converted into a recall.
	 */
	if (wasDead) return ["he was DEAD at the last look and has respawned since"]
	const out: string[] = []
	if (m.dCs > 0 && m.dGold > 0)
		out.push("his CS and gold are both ticking, so he is mid-clear on a camp or wave right now")
	else if (m.dGold > 0 && m.dCs === 0)
		out.push(
			"gold rose with CS flat, and a whole camp fits inside one floored CS step — farming and passive income read alike here"
		)
	else if (m.dGold < -300 && m.dItems > 0)
		out.push(
			now < 90 ?
				"gold dropped and items appeared before the first wave, so that is the starting purchase, not a back"
			:	"gold dropped and an item appeared, so he just backed and bought"
		)
	else if (m.dCs === 0 && m.dGold <= 0)
		out.push("no CS and no gold movement, so he is walking, warding, waiting or fighting — not farming")
	if (m.dMana < -60) out.push("mana fell sharply, so abilities are going out")
	else if (m.dMana > 60) out.push("mana is regenerating, so he is not casting")
	if (m.dHp < -100) out.push("he is taking real damage")
	else if (m.dHp > 100 && m.dGold >= 0) out.push("HP is climbing, so he is healing, recalling or out of combat")
	if (m.dLevel > 0) out.push("he just levelled")
	return out
}

const deltaBlock = (
	me: Player,
	prevMe: Player | null,
	meNow: { gold: number; hp: number; mana: number },
	mePrev: { gold: number; hp: number; mana: number } | null,
	players: Player[],
	prevPlayers: Player[],
	elapsed: number,
	now: number,
	counterpart: Player | null
): string[] => {
	if (prevMe === null || mePrev === null)
		return [
			"No previous sample: this is the first look at this game, so nothing below is a change — it is all a first reading."
		]
	const out: string[] = [`Compared with ${r0(elapsed)}s ago:`]

	const dCs = me.cs - prevMe.cs
	const dGold = meNow.gold - mePrev.gold
	const dHp = meNow.hp - mePrev.hp
	const dMana = meNow.mana - mePrev.mana
	const dLevel = me.level - prevMe.level
	const dItems = me.items.length - prevMe.items.length
	out.push(
		`YOU: CS ${prevMe.cs}->${me.cs} (${signed(dCs)}), gold in hand ${r0(mePrev.gold)}->${r0(meNow.gold)} (${signed(dGold)}), HP ${r0(mePrev.hp)}->${r0(meNow.hp)}, mana ${r0(mePrev.mana)}->${r0(meNow.mana)}, level ${prevMe.level}->${me.level}, items ${prevMe.items.length}->${me.items.length}, K/D/A ${prevMe.kills}/${prevMe.deaths}/${prevMe.assists}->${me.kills}/${me.deaths}/${me.assists}`
	)

	const byName = new Map(prevPlayers.map(p => [p.name, p]))
	for (const p of players) {
		if (p.name === me.name) continue
		const q = byName.get(p.name)
		if (!q) continue
		const bits: string[] = []
		/* Not for the counterpart: his CS row is a sightings counter, so a move in it is news about
		 * VISION and not about farm, and rendered as `CS 30->40` it reads as farm. See
		 * `counterpartClause`. */
		if (p.cs !== q.cs && p.name !== counterpart?.name) bits.push(`CS ${q.cs}->${p.cs}`)
		if (p.level !== q.level) bits.push(`level ${q.level}->${p.level}`)
		if (p.deaths !== q.deaths) bits.push(`DIED (${q.deaths}->${p.deaths})`)
		if (p.kills !== q.kills) bits.push(`killed someone (${q.kills}->${p.kills})`)
		if (p.items.length !== q.items.length) {
			const bought = p.items.filter(i => !q.items.some(j => j.name === i.name))
			bits.push(
				bought.length > 0 ?
					`BOUGHT ${bought.map(i => `${i.name} (${i.price}g)`).join(", ")}`
				:	`items ${q.items.length}->${p.items.length}`
			)
		}
		if (bits.length > 0) out.push(`${p.champion}: ${bits.join("; ")}`)
	}

	/* The `doing` inference is rendered by NOW, at the top of the payload, and repeated here so the
	 * full brief keeps every sentence it had. */
	const doing = doingPhrases(me, { dCs, dGold, dHp, dMana, dLevel, dItems }, now, prevMe.dead)
	if (doing.length > 0) out.push(`Inference from those deltas: ${doing.join("; ")}.`)
	return out
}

/* ================================================================ baselines */

const BASELINE_KEYS: Array<[string, string]> = [
	["cs@10", "CS at 10:00"],
	["cs@14", "CS at 14:00"],
	["cs@20", "CS at 20:00"],
	["csPerMin", "CS per minute"],
	["goldPerMin", "gold per minute"],
	["killParticipation", "kill participation %"],
	["visionPerMin", "vision score per minute"],
	["deaths", "deaths per game"],
	["kda", "KDA"]
]

const baselineBlock = (baseline: unknown, now: number): string[] => {
	const b = rec(baseline)
	if (!b) return ["No baselines were supplied with this turn, so there is nothing to compare him against."]
	const lines: string[] = []
	for (const [key, label] of BASELINE_KEYS) {
		// The checkpoint baselines only mean anything once the game has passed the checkpoint.
		if (key === "cs@10" && now < 600) continue
		if (key === "cs@14" && now < 840) continue
		if (key === "cs@20" && now < 1200) continue
		const stat = rec(b[key])
		const mean = stat && num(stat.mean)
		const n = (stat && num(stat.n)) ?? null
		if (mean === null || mean === undefined) lines.push(`${label}: no baseline for this checkpoint`)
		else lines.push(`${label}: his own average is ${r1(mean)}${n !== null ? ` over ${r0(n)} games` : ""}`)
	}
	return lines.length > 0 ? lines : ["No baseline checkpoints have been reached yet this game."]
}

/**
 * Only the checkpoint baselines, and only once the game has reached them.
 *
 * `baselineBlock` is the full brief's section and most of it is fixed for the game — his CS/min,
 * his gold/min, his KDA — so re-sending it every turn would be the same waste the delta exists to
 * stop. The three CS checkpoints are different: each becomes sayable exactly once, at 10:00, 14:00
 * and 20:00, and the only full brief of a game is built before any of them. This is the line that
 * makes "your own average is 18 at this minute" reachable at all.
 */
const checkpointBaselines = (baseline: unknown, now: number): string | null => {
	const b = rec(baseline)
	if (!b) return null
	const due: Array<[string, string]> = [
		["cs@10", "CS at 10:00"],
		["cs@14", "CS at 14:00"],
		["cs@20", "CS at 20:00"]
	].filter(([key]) => (key === "cs@10" ? now >= 600 : key === "cs@14" ? now >= 840 : now >= 1200)) as Array<
		[string, string]
	>
	const lines: string[] = []
	for (const [key, label] of due) {
		const stat = rec(b[key])
		const mean = stat && num(stat.mean)
		const n = (stat && num(stat.n)) ?? null
		if (mean !== null && mean !== undefined)
			lines.push(`${label}: his own average is ${r1(mean)}${n !== null ? ` over ${r0(n)} games` : ""}`)
	}
	return lines.length === 0 ? null : ["HIS OWN BASELINES, AT THE CHECKPOINTS THIS GAME HAS PASSED", ...lines].join("\n")
}

/* ================================================================ the scene */

/**
 * Everything both renderings need, read off the pair of samples exactly once. `buildBrief` and
 * `buildDelta` are two views of THIS, not two parsers — a delta that reads the payload differently
 * from the brief it is supposed to be an update to is a delta that can contradict its own baseline.
 */
interface Scene {
	data: Record<string, unknown>
	stats: Record<string, unknown>
	now: number
	me: Player
	counterpart: Player | null
	players: Player[]
	teammates: Player[]
	enemies: Player[]
	events: Ev[]
	who: (v: unknown) => string
	hp: number
	maxHp: number
	mana: number
	maxMana: number
	gold: number
	abilityLevels: string
	csPerMin: number
	prevPlayers: Player[]
	prevMe: Player | null
	mePrev: { gold: number; hp: number; mana: number } | null
	/** The previous sample's game clock, or `null` on the first look. */
	prevSec: number | null
	elapsed: number
	moves: Moves | null
}

const readScene = (input: BriefInput): Scene | null => {
	const data = rec(rec(input.raw)?.data ?? input.raw)
	if (!data) return null
	const active = rec(data.activePlayer)
	if (!active) return null
	const players = arr(data.allPlayers)
		.map(readPlayer)
		.filter((p): p is Player => p !== null)
	if (players.length === 0) return null

	/* `activePlayer` carries no champion name; it is joined to `allPlayers` by riot id. */
	const myRiotId = str(active.riotId)
	const myName = str(active.riotIdGameName) ?? (myRiotId !== null ? myRiotId.split("#")[0] : null)
	const me = players.find(p => p.name === myName) ?? null
	if (!me) return null

	const now = input.gameTimeSec
	const stats = rec(active.championStats) ?? {}
	const hp = num(stats.currentHealth) ?? 0
	const maxHp = num(stats.maxHealth) ?? 0
	const mana = num(stats.resourceValue) ?? 0
	const maxMana = num(stats.resourceMax) ?? 0
	const gold = num(active.currentGold) ?? 0
	const abilities = rec(active.abilities) ?? {}
	const abilityLevels = ["Q", "W", "E", "R"]
		.map(k => `${k}${num(rec(abilities[k])?.abilityLevel) ?? 0}`)
		.join(" ")

	const counterpart = findCounterpart(players, me)

	/* previous sample, parsed the same way so the deltas compare like with like */
	const prevData = input.previous ? rec(rec(input.previous.raw)?.data ?? input.previous.raw) : null
	const prevPlayers = prevData ?
		arr(prevData.allPlayers)
			.map(readPlayer)
			.filter((p): p is Player => p !== null)
	:	[]
	const prevMe = prevPlayers.find(p => p.name === me.name) ?? null
	const prevActive = prevData ? rec(prevData.activePlayer) : null
	const prevStats = prevActive ? (rec(prevActive.championStats) ?? {}) : null
	const mePrev =
		prevStats && prevActive ?
			{
				gold: num(prevActive.currentGold) ?? 0,
				hp: num(prevStats.currentHealth) ?? 0,
				mana: num(prevStats.resourceValue) ?? 0
			}
		:	null

	return {
		data,
		stats,
		now,
		me,
		counterpart,
		players,
		teammates: players.filter(p => p.team === me.team && p.name !== me.name),
		enemies: players.filter(p => p.team !== me.team && p.name !== counterpart?.name),
		events: readEvents(data),
		who: namer(players),
		hp,
		maxHp,
		mana,
		maxMana,
		gold,
		abilityLevels,
		csPerMin: now > 0 ? (me.cs / now) * 60 : 0,
		prevPlayers,
		prevMe,
		mePrev,
		prevSec: input.previous ? input.previous.gameTimeSec : null,
		elapsed: now - (input.previous?.gameTimeSec ?? now),
		moves:
			prevMe && mePrev ?
				{
					dCs: me.cs - prevMe.cs,
					dGold: gold - mePrev.gold,
					dHp: hp - mePrev.hp,
					dMana: mana - mePrev.mana,
					dLevel: me.level - prevMe.level,
					dItems: me.items.length - prevMe.items.length
				}
			:	null
	}
}

/* ================================================================ NOW — the situation */

const pct = (a: number, b: number): string => `${r0(b > 0 ? (a / b) * 100 : 0)}%`

/* ================================================================ his own bars, and the two words they were turned into
 *
 * ## A percentage on its own gets editorialised, and the editorial is what is spoken
 *
 * At 19:16 of game 5639406342 the payload said `HP 57%, mana 28%` and the coach said "you are too
 * hurt and have no mana left, so you must retreat". Both halves are a REAL number restated as a
 * wrong one: 57% of his 2,714 health is 1,547 HP, and 28% of his 1,015 mana is 284 mana, which is
 * not "no mana left" by any reading. Nothing in the payload contradicted either word, because the
 * payload contained neither the amount nor any sense of where the number sat.
 *
 * So a bar renders as three things instead of one. The FRACTION, which is what he can see on his
 * own HUD. The AMOUNT, because "284 of 1,015" is the sentence "no mana left" cannot survive being
 * written next to. And the BAND, but only when the value is actually inside it.
 *
 * ## The band is the app's OWN measured threshold, not a new judgement
 *
 * `HP_LOW_BAND` and `MANA_LOW_BAND` are the numbers `analysis/live-events.ts` fires `resource.low`
 * on — the point this app has already decided "changes what he can do". At 19:16 neither had
 * fired: 57% is nearly twice the health band and 28% is above the mana band, so the app's own
 * detector considered that state unremarkable while the coach called it a retreat. Printing the
 * band the detector uses is therefore not a new opinion, it is the payload agreeing with the rest
 * of the program.
 *
 * They are duplicated rather than imported because `shared/` may not import `analysis/`, and the
 * repo already has the pattern for that: `live-brief-schedule.test.ts` pins the objective
 * constants across the same fence. `live-brief.test.ts` pins these two the same way and fails the
 * moment the detector moves one.
 *
 * ## What is NOT rendered: what the number BUYS
 *
 * The obvious next step is "284 mana is two camps' worth of Q", and it cannot be taken. Ability
 * mana costs are not in this feed at all, and `knowledge/champions/lillia.md` deliberately omits
 * them — its own "Deliberate omissions" section says a remembered number would be fiction — while
 * `champion-advice.ts` refuses any clause containing a digit. So there is no non-inventing source
 * for the conversion, and a casts-remaining figure would be exactly the class of number that
 * mechanism exists to make impossible. The amount and the band are what can be said.
 */
export const HP_LOW_BAND = 0.3
export const MANA_LOW_BAND = 0.2

/** "mana 28% (284 of 1015)", or "mana 12% (122 of 1015, LOW — under 20%)". */
const bar = (label: string, cur: number, max: number, low: number): string => {
	const frac = max > 0 ? cur / max : 0
	const band = frac <= low ? `, LOW — under ${r0(low * 100)}%` : ""
	return `${label} ${pct(cur, max)} (${r0(cur)} of ${r0(max)}${band})`
}

/**
 * The per-turn short form of the roster's missing column, rendered in NOW beside the bars it is
 * about.
 *
 * `ROSTER_NO_CONDITION` states it in full where the rows are, and the full brief is sent once a
 * game. The measured invention was on a DELTA, which has no roster section at all, so the fact has
 * to ride somewhere that is present on every turn of both modes — and NOW is the only such
 * section. Placed next to HIS bars because that is where the contrast is legible: these numbers
 * exist, and they are the only ones that do.
 */
const ONLY_HIS = "Yours are the only HP, mana and gold in this feed"

/* ================================================================ the roster's missing column
 *
 * ## "Drave and Lulu are low from that fight"
 *
 * Said at 7:47 of game 5639406342, four seconds after `- 7:43 Lulu killed Xayah (assists: Kayn,
 * Draven)` arrived in the payload. Neither enemy's health is in this feed. Neither enemy's health
 * has EVER been in this feed: the Live Client Data API puts `championStats` — every bar, every
 * resource, every defensive stat — under `activePlayer` and nowhere else, and an `allPlayers` row
 * carries exactly `championName`, `isBot`, `isDead`, `items`, `level`, `position`, `runes`,
 * `scores` (assists, creepScore, deaths, kills, wardScore), `summonerSpells`, `team` and the skin
 * fields. Verified against the recorded samples for this game; there is no health key to read.
 *
 * So the model was not misreading a number. It was filling a hole, and the hole was the shape of a
 * roster table with a health column missing from it. That is the same failure as the enemy
 * jungler's farm figure and it gets the same answer, which is the only answer this file has ever
 * found to work: STATE THE ABSENCE AS A FACT OF THE FEED, in the section where the temptation is,
 * rather than write a rule telling the model not to say it.
 *
 * It rides on BOTH roster sections rather than once. The measured invention named two ENEMIES, and
 * an ally's row tempts the mirror sentence — "your bot lane is low, go dive with them" — just as
 * hard. A hundred and seventy characters twice, paid once per game in the full brief, against a
 * false sentence about two named people.
 *
 * `ONLY_HIS` is the per-turn short form, on NOW, because the delta has no roster section at all
 * and 7:47 was a delta.
 */
const ROSTER_NO_CONDITION =
	"These rows carry level, K/D/A, CS, ward score, items and DEAD/alive, and nothing else. No health, mana or gold for anybody but him exists anywhere in this feed, so whether one of these players is low, hurt or out of mana is NOT knowable here — only the picture can show it."

/**
 * The first thing in the payload, and the reason for the redesign.
 *
 * The brief used to open on a roster table whose first bulleted line was, verbatim,
 * `- Urgot (TOP, lvl 1) 0/0/0, 0 CS, ward score 0.0. Items: no items`. A model reads top-down, so it
 * was reading a table where it should have been reading a situation, and across two graded runs not
 * one of thirty-six lines ever used a lane state. Meanwhile the single most situational sentence in
 * the whole payload — the inference about what he is doing right now — was the LAST line of the
 * seventh section.
 *
 * Nothing here is new data and nothing is ranked. Same facts, in the order a decision consumes them:
 * the clock, him, the man he is racing, what the picture shows if the caller has a read of it, and
 * what the numbers say he is doing.
 */
const situation = (
	s: Scene,
	where: string | null | undefined,
	at: PositionFix | null | undefined,
	seenAtSec: number | null,
	watchedFromSec: number | null
): string => {
	const bits: string[] = []
	/*
	 * HIS OWN ALIVENESS IS THE FIRST THING IN THE PAYLOAD, and it used to be the fifth clause of the
	 * first sentence.
	 *
	 * At 28:12 of game 5639406342 the coach said "you are all still dead". He was at 100% HP with
	 * the word `alive` sitting in the same sentence, four commas in, between his level and his
	 * health — and the NEXT section below listed four dead team-mates and the enemy jungler on one
	 * line, which is the list the word "all" came from. Every fact needed to refuse that sentence
	 * was present and none of it was placed where a reader meets it first.
	 *
	 * His death, his HP and his mana are the three most authoritative numbers in the whole feed:
	 * exact, unfogged, his own. So they open the payload as their own sentence, in capitals, before
	 * the champion row — not because a rule forbids the sentence, but because there is nowhere left
	 * to write it. `nextBlock`'s down-list names him too, for the same reason.
	 *
	 * While he is DEAD the bars are not printed at all. A corpse reads 0 HP and 0 mana in this feed
	 * — `analysis/live-events.ts` clears its own bands on respawn for exactly that reason — so
	 * "HP 0%" on a dead man is an artefact, and an artefact next to the word DEAD is how "you have
	 * no health left" gets said about a man in the fountain.
	 */
	bits.push(
		s.me.dead ?
			`${clock(s.now)}. YOU ARE DEAD — ${r0(s.me.respawn)}s until you are up. (A corpse reads 0 HP and 0 mana in this feed, so neither bar is printed while you are down.)`
		:	`${clock(s.now)}. YOU ARE ALIVE, ${bar("HP", s.hp, s.maxHp, HP_LOW_BAND)}, ${bar("mana", s.mana, s.maxMana, MANA_LOW_BAND)}. ${ONLY_HIS}.`
	)
	bits.push(
		`${s.me.champion} (${s.me.position || "role unlabelled"}) lvl ${s.me.level}, ${r0(s.gold)}g in hand, ${s.me.kills}/${s.me.deaths}/${s.me.assists}, ${s.me.cs} CS (${r1(s.csPerMin)}/min).`
	)
	const c = s.counterpart
	/*
	 * The counterpart, compared on LEVEL and BUILD and on nothing else.
	 *
	 * This clause used to read `you are at least +30 on farm`, from `csGap` over two floored CS
	 * figures. One of those figures is not a CS count — it is a count of the enemy jungler's farm
	 * that this client HAPPENED TO WITNESS — so the interval was careful arithmetic on a false
	 * premise. See the `counterpartClause` block comment for the measured table; the short version
	 * is that the sentence this line used to produce was wrong by up to 95 CS and it is the source
	 * of both FALSE cards in the blinded grading of game 5639406342.
	 */
	/*
	 * THE SHORT FORM here, the full clause in NEXT.
	 *
	 * Both sections wanting the counterpart is not a coincidence — he is the whole comparison — but
	 * rendering the clause twice cost 220 duplicated characters a turn, and inside a 1,500-character
	 * cap a duplicated fact is paid for by whatever falls off the bottom, which was the memory. NOW
	 * gets the race in six words; NEXT gets the build and the row's age, because that is where a
	 * decision about a pit consumes them.
	 */
	/*
	 * THE ROW'S AGE RIDES HERE TOO, in six words.
	 *
	 * The full clause lives in NEXT, and that used to be the only copy — which made the marker
	 * conditional on an objective being inside the horizon. This is the section that carries the
	 * LEVEL COMPARISON, and a level comparison with no age beside it is verbatim the shape that
	 * produced the FALSE line at 2:06: "Kayn: alive, lvl 1 — 2 levels BELOW you", said out loud
	 * about a jungler the post-game timeline has at level 2. Six words next to the number beats a
	 * paragraph two sections away, and the long form is still in NEXT for a decision that needs it.
	 */
	bits.push(
		c === null ? "This feed labels no enemy jungler this game."
		:	`Counterpart ${c.champion}: ${c.dead ? `DEAD, back in ${r0(c.respawn)}s` : "alive"}, lvl ${c.level} — ${
				c.level === s.me.level ? "level with you"
				: s.me.level > c.level ? `${s.me.level - c.level} below you`
				: `${c.level - s.me.level} above you`
			}, ${c.kills}/${c.deaths}/${c.assists} (${rowAge(c, s.now, seenAtSec, watchedFromSec, true)}).`
	)
	/*
	 * ONE position, ONE line — and the caller no longer has to know that.
	 *
	 * `where` is the prose form of the minimap read and `at` is the same read as data, rendered by
	 * `prospectHead` as `You: <zone>, Ns old.` The route passes BOTH, because both gates are the
	 * same `pictureLine` call, and the comment that used to sit here said prose wins when both
	 * arrive — which nothing implemented. Verified in the real 2:06 payload: `Picture: his own icon
	 * read botside on the minimap 0s ago …` and `You: blue-side jungle (bot), 0s old` in one brief,
	 * about 120 duplicated characters. Inside a fixed cap a duplicated fact is paid for by whatever
	 * falls off the bottom, which is the memory — rebuilt with `at` alone, the 11:39 and 14:05
	 * deltas came out 80 and 157 characters smaller and fitted more of `said`.
	 *
	 * So the suppression happens HERE, where both are in scope, rather than in a rule the callers
	 * have to remember. NEXT now always renders, so `at` being non-null does mean the position was
	 * printed — that was not true while `nextBlock` could return null.
	 */
	if (at == null && str(where ?? null) !== null) bits.push(`Picture: ${where}.`)
	if (s.moves === null) bits.push("First look at this game, so nothing here is a change yet.")
	else {
		const doing = doingPhrases(s.me, s.moves, s.now, s.prevMe?.dead === true)
		if (doing.length > 0) bits.push(`Over the last ${r0(s.elapsed)}s: ${doing.join("; ")}.`)
	}
	return ["NOW", bits.join(" ")].join("\n")
}

/* ================================================================ the full brief */

export const buildBrief = (input: BriefInput): LiveBrief | null => {
	const s = readScene(input)
	if (!s) return null
	const { me, counterpart, now } = s
	const seen = input.counterpartSeenSec ?? null
	const watchedFrom = input.counterpartWatchedFromSec ?? null

	const playerLine = (p: Player): string =>
		`- ${p.champion} (${p.position || "role unlabelled"}, lvl ${p.level}) ${p.kills}/${p.deaths}/${p.assists}, ${p.cs} CS, ward score ${r1(p.ward)}${deadTag(p)}. Items: ${itemLine(p)}`

	const eventLines = s.events
		.slice()
		.sort((a, b) => b.t - a.t)
		.map(e => {
			const text = describeEvent(e, s.who)
			return text === null ? null : `- ${clock(e.t)} (${age(now - e.t)}) ${text}`
		})
		.filter((l): l is string => l !== null)

	const sections: string[] = []

	/* The situation, before any table. See `situation`. `where` reaches this path too: a resync
	 * happens when the thread is EMPTY, which is an argument for more context, not less. */
	sections.push(situation(s, input.where, input.at, seen, watchedFrom))

	/*
	 * The prospective joins ride SECOND, above every table, for the same reason the situation rides
	 * first: a model reads top-down, and the fact worth acting on is the objective that has not
	 * happened yet. The full brief keeps its OBJECTIVES section further down — that one is the map's
	 * schedule and its epistemics, paid once at the opening of a game; this one is the decision.
	 */
	sections.push(nextBlock(s, input.at, seen, watchedFrom, input.reach, true))
	const joins = joinsBlock(s)
	if (joins !== null) sections.push(joins)

	sections.push(`GAME CLOCK ${clock(now)}. ${str(rec(s.data.gameData)?.gameMode) ?? "CLASSIC"} on Summoner's Rift.`)

	sections.push(
		[
			`YOU — ${me.champion}, ${me.position || "role unlabelled"}, level ${me.level}, side ${me.team}`,
			/*
			 * ALIVE OR DEAD, FIRST LINE OF THE SECTION. It used to be the LAST line of nine, below
			 * the item list, as the four words `He is alive.` At 28:12 of game 5639406342 that
			 * section said `He is alive.` and the coach said "you are all still dead" anyway. A fact
			 * that decides whether a sentence may be written at all does not go at the bottom of a
			 * table, and it is not four quiet words.
			 */
			me.dead ?
				`HE IS DEAD RIGHT NOW and respawns in ${r0(me.respawn)}s. The HP and mana below are a corpse reading 0 and are not a reading of anything.`
			:	`HE IS ALIVE RIGHT NOW. The HP and mana below are exact, his own, and the only ones in this feed.`,
			`K/D/A ${me.kills}/${me.deaths}/${me.assists}. CS ${me.cs} (${r1(s.csPerMin)}/min). Ward score ${r1(me.ward)}.`,
			/* Amount, fraction and the app's own low band — see `bar` for the two words 57% and 28% were turned into. */
			`${bar("HP", s.hp, s.maxHp, HP_LOW_BAND)}. ${bar("MANA", s.mana, s.maxMana, MANA_LOW_BAND)}, regen ${r1(num(s.stats.resourceRegenRate) ?? 0)}/5s.`,
			`Gold in hand ${r0(s.gold)}. (What he has SPENT is not in this payload for anybody — the item rows carry a price that recovers about a quarter of it, so no total is rendered.)`,
			`AP ${r0(num(s.stats.abilityPower) ?? 0)}, AD ${r0(num(s.stats.attackDamage) ?? 0)}, ability haste ${r0(num(s.stats.abilityHaste) ?? 0)}, armour ${r0(num(s.stats.armor) ?? 0)}, MR ${r0(num(s.stats.magicResist) ?? 0)}, move speed ${r0(num(s.stats.moveSpeed) ?? 0)}, attack range ${r0(num(s.stats.attackRange) ?? 0)}.`,
			`Ability ranks: ${s.abilityLevels}.`,
			`Summoners: ${me.spells.join(", ") || "unknown"}.`,
			`Items: ${itemLine(me)}. Build (trinket and consumables excluded): ${buildLine(me)}.`
		].join("\n")
	)

	sections.push(
		counterpart === null ?
			"ENEMY JUNGLER — this feed does not label one this game."
		:	[
				`ENEMY JUNGLER — ${counterpart.champion}, level ${counterpart.level}, ${counterpart.kills}/${counterpart.deaths}/${counterpart.assists}`,
				`Ward score ${r1(counterpart.ward)}. Summoners: ${counterpart.spells.join(", ") || "unknown"}.${deadTag(counterpart)}`,
				`Items: ${itemLine(counterpart)}.`,
				/*
				 * THE ROW'S AGE, ONCE — and it is in NEXT, not here.
				 *
				 * `prospectHead` prints the full clause because that is where a decision about a pit
				 * consumes it, and its own comment says it moved there "rather than in NOW"
				 * specifically to stop a 220-character duplication. This copy was left behind, so
				 * the real 2:06 brief carried the identical ~200-character sentence twice. NOW
				 * carries the six-word form beside the level comparison; NEXT carries the long one.
				 * This section keeps the raw fields, which is what a table is for.
				 */
				`His level and item list are LAST-KNOWN values off a fog-gated row — NEXT prints how old they are, and NOW prints the short form.`,
				/*
				 * HIS CS IS NOT PRINTED, and the absence is stated so the gap is not filled in.
				 *
				 * Measured: the model invents a schedule the brief does not state — at 6:05 of a
				 * graded run it said "Voidgrubs are spawning in a minute" with no grub line in its
				 * payload. A silently missing number behaves the same way. This sentence costs 180
				 * characters once per game and it is the only thing standing between the model and
				 * a farm comparison it will otherwise reconstruct out of the roster rows.
				 */
				`His farm figure is deliberately NOT in this payload. This feed reports the enemy jungler's CS as a count of what your own client witnessed, not as his farm — measured against the post-game truth for one full game it read 70 where the truth was 183. Do not compare his farm with yours; the level and the build above are the race that is real.`
			].join("\n")
	)

	sections.push([`YOUR TEAM (besides you)`, ROSTER_NO_CONDITION, ...s.teammates.map(playerLine)].join("\n"))
	sections.push([`ENEMY TEAM (besides their jungler)`, ROSTER_NO_CONDITION, ...s.enemies.map(playerLine)].join("\n"))

	sections.push(
		[
			"EVENT LOG, newest first. Every line carries the game clock it happened at and how long ago that was.",
			...(eventLines.length > 0 ? eventLines : ["- nothing has happened yet this game"])
		].join("\n")
	)

	sections.push(
		["WHAT CHANGED SINCE THE LAST LOOK", ...deltaBlock(me, s.prevMe, { gold: s.gold, hp: s.hp, mana: s.mana }, s.mePrev, s.players, s.prevPlayers, s.elapsed, now, counterpart)].join("\n")
	)

	/*
	 * The memory rides on the FULL path too, and this is the turn that needs it most.
	 *
	 * The resync branch used to pass neither, so the two `brief` turns of the stored run were the
	 * only two payloads with no record of what had already been said — and the second of them was
	 * mid-game at 5:22 with six lines already spoken. What came out of it was
	 * "You are smashing Briar on farm", the fourth farm-shaped line of the run, from the one turn
	 * where the coach's own anti-repetition record was withheld. A resync fires precisely because
	 * the thread is empty; withholding the history there is backwards.
	 */
	const narrative = narrativeBlock(input.narrative)
	if (narrative !== null) sections.push(narrative)

	const said = saidBlock(input.said)
	if (said !== null) sections.push(said)

	sections.push(["OBJECTIVES", ...objectiveBlock(s.events, s.players, me, now, s.who)].join("\n"))

	sections.push(["HIS OWN BASELINES", ...baselineBlock(input.baseline, now)].join("\n"))

	/*
	 * Properties of the feed, not instructions about speech. Everything here has been checked
	 * against the recorded samples: 3630 CS readings across a real game, every one a multiple of
	 * ten; levels 1 through 20 all observed, so levels are NOT quantised the way CS is.
	 *
	 * On a socket every one of these nine bullets is already in the system instruction, which is
	 * paid once, so `feedNotes: false` drops 1,190 characters a turn that say nothing new. It
	 * defaults to ON so the two stored runs and every existing caller keep what they were graded on.
	 */
	if (input.feedNotes !== false)
		sections.push(
			[
				"WHAT THIS FEED IS",
				"- Every player's CS is floored to a multiple of ten, so a reported 40 means somewhere in 40-49. Verified across 57,070 readings with zero exceptions. For him, his team and the enemy LANERS that floor is the only error and the figure is otherwise his farm.",
				"- The enemy JUNGLER's CS is a different thing wearing the same name: it counts only the farm your own client witnessed. Over one full recorded game it read 0 / 20 / 30 / 50 / 60 / 70 at five-minute marks where the truth was 32 / 58 / 84 / 125 / 156 / 183. It is not rendered anywhere in this payload and no comparison may be built from it.",
				"- Levels are exact for him and his team, and 94.5% exact for enemies over that game (93.5-97.0% across fourteen), worst error two levels and every error transient. This is the counterpart race that is real.",
				"- Nobody's health, mana or gold is reported except his own. The Live Client Data API puts all three under `activePlayer` and nowhere else: an ally's row and an enemy's row carry level, K/D/A, CS, ward score, items and whether the player is DEAD, and carry no bars at all. That anyone else is low, hurt or out of mana is not a thing this feed can say.",
				"- Nobody's current gold is reported except his own. What anyone has SPENT is NOT knowable: summing the item rows' prices recovers 0.27 of the gold truly earned, because a component consumed into a legendary contributes only its own row. No spend total appears in this payload.",
				"- Item lists are what a player is HOLDING now, and the names are exact. An enemy's empty list means he has not been SEEN, not that he has bought nothing.",
				"- There are no positions anywhere in this feed. It contains no coordinates for anyone, including him. Any position in this payload came from READING THE MINIMAP and says so on its own line, with its age.",
				"- There are no cooldowns and no summoner-spell timers.",
				"- Ward score is a score, not a ward map: it says nothing about where anything was placed.",
				"- The screenshot accompanying this brief is a real look at his screen. What is plainly visible on it — who is on screen, what he is attacking, his own bars, the chat, the kill banners, the minimap pings — is readable. What is off screen is not in the picture and not in this brief."
			].join("\n")
		)

	const text = sections.join("\n\n")
	return {
		text,
		chars: text.length,
		me: me.champion,
		counterpart: counterpart?.champion ?? null,
		roster: s.players.map(p => p.champion),
		sections: sections.map(sec => ({ name: sec.split("\n")[0]!.slice(0, 40), chars: sec.length }))
	}
}

/* ================================================================ the delta */

/**
 * What the coach has already said, rendered and nothing more.
 *
 * The caller owns the text; this adds a header and stops. No "vary it", no "he ignored you", no
 * cadence — any pressure toward variety lives in the system prompt, and a rule about what to say
 * would make this a guardrail. What it buys is a sentence that was previously inexpressible: the
 * model cannot say "you are STILL low on mana, back NOW" unless something records that it already
 * mentioned mana, and the socket's thread cannot, because its own turns come back as audio and are
 * drowned by twelve near-identical dumps.
 */
const saidBlock = (said: BriefInput["said"], budget = Infinity): string | null => {
	const lines = (Array.isArray(said) ? said : typeof said === "string" ? said.split("\n") : [])
		.map(l => l.trim())
		.filter(l => l.length > 0)
	if (lines.length === 0) return null
	/*
	 * BUDGETED HERE as well as by the caller, and from the TAIL, because the newest lines are the
	 * ones anti-repetition needs. The caller owning the budget was not enough: this section had
	 * rank 0 and no cap of its own, its rows grow as verdicts are appended, and from about 3:00 of
	 * the stored run it plateaued above `DELTA_HARD_CAP` and evicted CLOCKS from every remaining
	 * turn of the game. A section that can starve its neighbours has to be able to say no itself.
	 *
	 * WHOLE ROWS, never whole lines. A row is `<clock> "<what was said>"` optionally followed by an
	 * indented `-> <verdict>` continuation, and cutting between the two leaves an orphaned verdict
	 * attached to nothing — which is the "half a sentence about a game reads as a whole fact about
	 * a different one" failure `fit` was written to avoid, and it appeared verbatim in a bench
	 * payload as a bare `-> NOT OBSERVED — ward score unchanged at 0.0`.
	 */
	const rows: string[][] = []
	for (const line of lines) {
		if (/^->/.test(line) && rows.length > 0) rows.at(-1)!.push(line)
		else rows.push([line])
	}
	const kept: string[] = []
	let used = "WHAT YOU HAVE ALREADY SAID THIS GAME".length
	for (const row of [...rows].reverse()) {
		const size = row.reduce((n, l) => n + l.length + 1, 0)
		if (kept.length > 0 && used + size > budget) break
		kept.unshift(...row)
		used += size
	}
	return ["WHAT YOU HAVE ALREADY SAID THIS GAME", ...kept].join("\n")
}

/**
 * The accumulated history, rendered by the caller and fitted here.
 *
 * The caller owns the TEXT — `shared/` may not import `analysis/` — but the budget is enforced on
 * this side for the same reason `saidBlock`'s is: a caller-owned section that can grow past the cap
 * is a section that silently evicts the objective clocks. Oldest beats go first; the header line is
 * kept whatever happens.
 */
const narrativeBlock = (narrative: BriefInput["narrative"], budget = Infinity): string | null => {
	const lines = (narrative ?? "").split("\n").filter(l => l.trim() !== "")
	if (lines.length === 0) return null
	const [head, ...rest] = lines
	const kept: string[] = []
	let used = head!.length
	for (const line of [...rest].reverse()) {
		if (used + line.length + 1 > budget) break
		kept.unshift(line)
		used += line.length + 1
	}
	/*
	 * A HEADING WITH NO ROWS IS A LIE, so it is not sent.
	 *
	 * Under a tight budget every row can fail to fit and this returned the bare
	 * `THE GAME SO FAR (accumulated, not a fresh reading)` — 49 characters asserting that a game
	 * whose narrative had thirty beats in it had nothing in it. Observed in the 17:56 payload of
	 * game 5639406342, where it was the only thing that fitted.
	 */
	if (kept.length === 0 && rest.length > 0) return null
	return [head!, ...kept].join("\n")
}

/** Keeps whole lines while a section stays inside its budget. What does not fit is dropped, never
 * cut mid-sentence — half a sentence about a game reads as a whole fact about a different one. */
const fit = (lines: string[], budget: number): string[] => {
	const out: string[] = []
	let used = 0
	for (const line of lines) {
		if (out.length > 0 && used + line.length + 1 > budget) break
		out.push(line)
		used += line.length + 1
	}
	return out
}

/** `CS 70` when it did not move, `CS 70->90 (+20)` when it did. See `sinceBlock`. */
const move = (label: string, to: string | number, d: number): string =>
	d === 0 ? label : `${label}->${to} (${signed(d)})`

/** His own transitions since the last look. One line, and the only thing in the payload the thread
 * structurally cannot already hold. */
const sinceBlock = (s: Scene): string => {
	if (s.prevMe === null || s.mePrev === null || s.moves === null)
		return ["SINCE THE LAST LOOK", "First look at this game: everything above is a reading, not a change."].join("\n")
	const m = s.moves
	/* `HP 0->2935` is a death and a respawn, not a heal; unlabelled it is just arithmetic, and the
	 * NOW line above has the same guard for the same reason. */
	const respawned = s.prevMe.dead && !s.me.dead ? " He was DEAD at the last look, so the health line is a respawn." : ""
	const kda =
		s.prevMe.kills !== s.me.kills || s.prevMe.deaths !== s.me.deaths || s.prevMe.assists !== s.me.assists
	return [
		"SINCE THE LAST LOOK",
		/*
		 * A field that did not move is printed ONCE, not as `70->70 (0)`.
		 *
		 * Every value is still here — this is a compression, not a filter, and "nothing moved" is
		 * itself information a jungler's coach needs. But at a six-second beat most of these are
		 * flat, and the unchanged half of this line ran about 55 characters of `X->X (0)` a turn.
		 * Measured on the 13:34 payload of game 5639406342, those 55 characters are the difference
		 * between the memory section fitting under the cap and being dropped entirely.
		 */
		`Over ${dur(s.elapsed)} — ${[
			move(`CS ${s.prevMe.cs}`, s.me.cs, m.dCs),
			move(`gold ${r0(s.mePrev.gold)}`, r0(s.gold), m.dGold),
			move(`HP ${r0(s.mePrev.hp)}`, r0(s.hp), m.dHp),
			move(`mana ${r0(s.mePrev.mana)}`, r0(s.mana), m.dMana),
			move(`lvl ${s.prevMe.level}`, s.me.level, m.dLevel),
			move(`items ${s.prevMe.items.length}`, s.me.items.length, m.dItems),
			`K/D/A ${s.prevMe.kills}/${s.prevMe.deaths}/${s.prevMe.assists}${kda ? `->${s.me.kills}/${s.me.deaths}/${s.me.assists}` : ""}`
		].join(", ")}.${respawned}`
	].join("\n")
}

/**
 * Only the TAIL of the event log — and never at the cost of the events that matter most.
 *
 * The full log is thread memory, and only what happened since the last look is news. But after the
 * opening turn THIS IS THE ONLY PLACE AN EVENT EVER APPEARS, because the next turn filters on
 * `e.t > prevSec` — so an event dropped here is gone from the thread forever.
 *
 * It was dropping them from the wrong end. The lines were sorted NEWEST first and then fitted to
 * 200 characters, so a busy window lost the OPENING of the fight. Measured over split-03 at a 25s
 * turn cadence, 72 delta turns: 23 events dropped across 12 turns, every one of them a fight
 * window. In the shipped run at 6:42 it silently deleted his own death — `6:15 Briar killed you`
 * and `6:19 you assisted the kill on Briar` fell off the 200-char break while three chatter kills
 * survived, leaving the single most important fact to a jungle coach present only as
 * `K/D/A 0/0/0->0/1/1` in the SINCE line. At 29:59 it printed two teammate-on-teammate kills and
 * dropped HIS OWN KILL ON THE ENEMY JUNGLER.
 *
 * Two changes, both about which end gets cut. Events involving HIM or the COUNTERPART are fitted
 * FIRST, so a byte cap can only ever cost chatter; and rendering is oldest-first so `fit` truncates
 * the tail rather than the head. The budget is raised because this is the one section that carries
 * deaths, drakes and barons, and the delta had 1,500 characters of headroom it was not using.
 */
const NEW_EVENTS_BUDGET = 420

const newEventsBlock = (s: Scene): string | null => {
	if (s.prevSec === null) return null
	const fresh = s.events.filter(e => e.t > s.prevSec!)
	const line = (e: Ev): string | null => {
		const text = describeEvent(e, s.who)
		return text === null ? null : `- ${clock(e.t)} (${age(s.now - e.t)}) ${text}`
	}
	/* Him or the man he is racing, read off the RAW participants: `describeEvent` renders his own
	 * name as "you", so a test against the rendered string would be a test against prose. */
	const involvesHim = (e: Ev): boolean => {
		const names = [
			str(e.raw.KillerName),
			str(e.raw.VictimName),
			...arr(e.raw.Assisters).map(a => str(a))
		].filter((n): n is string => n !== null)
		return names.some(n => n === s.me.name || (s.counterpart !== null && n === s.counterpart.name))
	}
	/* An objective is a fact about the game and never chatter, whoever took it. */
	const OBJECTIVE = new Set(["DragonKill", "BaronKill", "HeraldKill", "HordeKill"])
	const priority = (e: Ev): number => (involvesHim(e) || OBJECTIVE.has(e.name) ? 0 : 1)
	const rendered = fresh
		.map(e => ({ e, text: line(e) }))
		.filter((x): x is { e: Ev; text: string } => x.text !== null)
	const ordered = [...rendered].sort((a, b) => priority(a.e) - priority(b.e) || b.e.t - a.e.t)
	const kept = new Set(fit(ordered.map(x => x.text), NEW_EVENTS_BUDGET))
	const lines = rendered
		.filter(x => kept.has(x.text))
		.sort((a, b) => a.e.t - b.e.t)
		.map(x => x.text)
	if (lines.length === 0) return null
	return ["NEW SINCE THE LAST LOOK", ...lines].join("\n")
}

/**
 * One terse row per player who moved, and the counterpart always.
 *
 * Filtering by WHICH rows moved saves almost nothing — at a 30s beat a median of 8 of 10 players
 * move. What saves is what each row CARRIES: a full `playerLine` is about 110 characters because of
 * its item list, and a delta row is about 35. Items are 63% of the roster's bytes and change on a
 * median of 0 players per six-second beat, so an item name appears in the turn it appears in and a
 * held item is never re-listed.
 *
 * The counterpart keeps a row even when nothing moved, because a vanishing row reads as an absent
 * jungler and an absent jungler is the thing this coach exists to talk about.
 */
const movedBlock = (s: Scene): string | null => {
	if (s.prevPlayers.length === 0) return null
	const byName = new Map(s.prevPlayers.map(p => [p.name, p]))
	const rows: string[] = []
	let counterpartRow: string | null = null
	for (const p of s.players) {
		if (p.name === s.me.name) continue
		const q = byName.get(p.name)
		const isCounterpart = s.counterpart !== null && p.name === s.counterpart.name
		const bits: string[] = []
		if (q) {
			/* Never for the counterpart — a move in his CS row is news about VISION, not farm, and
			 * `CS 30->40` reads as farm. See `counterpartClause`. */
			if (p.cs !== q.cs && !isCounterpart) bits.push(`CS ${q.cs}->${p.cs}`)
			if (p.level !== q.level) bits.push(`lvl ${q.level}->${p.level}`)
			if (p.deaths !== q.deaths) bits.push(`DIED (${q.deaths}->${p.deaths})`)
			if (p.kills !== q.kills) bits.push(`killed someone (${q.kills}->${p.kills})`)
			if (p.assists !== q.assists) bits.push(`assist (${q.assists}->${p.assists})`)
			if (p.dead !== q.dead) bits.push(p.dead ? `DEAD, back in ${r0(p.respawn)}s` : "respawned")
			const bought = p.items.filter(i => !q.items.some(j => j.name === i.name))
			if (bought.length > 0) bits.push(`BOUGHT ${bought.map(i => i.name).join(", ")}`)
			else if (p.items.length !== q.items.length) bits.push(`items ${q.items.length}->${p.items.length}`)
		}
		if (bits.length === 0) {
			if (!isCounterpart) continue
			counterpartRow = `${p.champion} (counterpart): no change — lvl ${p.level}, ${p.kills}/${p.deaths}/${p.assists}, ${shopItems(p).length} items${deadTag(p)}`
			continue
		}
		const row = `${p.champion}${isCounterpart ? " (counterpart)" : ""}: ${bits.join("; ")}`
		if (isCounterpart) counterpartRow = row
		else rows.push(row)
	}
	const ordered = [...(counterpartRow === null ? [] : [counterpartRow]), ...rows]
	if (ordered.length === 0) return null
	return ["MOVED", ...fit(ordered, 320)].join("\n")
}

/* ================================================================ NEXT — the prospective join
 *
 * ## The one thing the live coach could not do, and the reason it lost 68% to 8%
 *
 * The post-game review of game 5639406342 was graded 68% useful across five models; the live coach
 * on the same game was graded 0/10, "generic and often hilariously wrong". Decomposing the gap, the
 * biggest single component is not hindsight. It is that the post-game pack's best items are JOINS —
 * an objective crossed with a position crossed with a state — and every one of them has a
 * forward-looking twin the live schedule already supports:
 *
 *     post-game, backwards:  "Cloud fell at 13:41 while you were in base."
 *     live, forwards:        "Cloud in 45s — you are in base with 100g."
 *
 * The same three facts. The backwards one cannot be said at 13:34 and the forwards one can, and at
 * 13:34 of that game every part of it was already in the payload: the drake timer was in CLOCKS,
 * the position was in NOW as prose, the gold was in NOW as a number. The model joined none of them,
 * on any of 62 turns. That is the lesson of decomposition #5 — the pack's power is that TYPESCRIPT
 * did the joins and handed the model a SELECTION problem. Asking a model with about a second to
 * derive a join across four sections is asking it to do the part it is worst at.
 *
 * So this section is the join, computed. It replaces CLOCKS, which carried the same timers with
 * nothing attached to them, and it costs about as much because the state clause is written once at
 * the head rather than once per line.
 *
 * ## Distance and travel time ARE computed now — and the old refusal was right at the time
 *
 * This header used to say "no distance and no travel time", on the grounds that the read was a
 * COARSE ZONE and a number of seconds derived from a zone name would be invented. That argument was
 * correct about its own input and is now obsolete about ours: `review/read-minimap.ts` returns the
 * icon's POSITION, in the same minimap percentages `shared/map.ts`'s `fromMinimapPct` inverts, and a
 * distance between two points is arithmetic rather than invention.
 *
 * So `analysis/reachability.ts` computes it and `reachClause` below renders it, ON THE OBJECTIVE'S
 * OWN LINE rather than in a section of its own. That placement is the whole point: the ten useful
 * lines of game 5639406342 were one object — a window, a place, and whether he could be there — and
 * splitting the third fact into its own paragraph would hand the model exactly the join it failed
 * to make on 62 consecutive turns.
 *
 * Three things keep it honest, and each of them can delete the number:
 *
 *   - the straight line is a FLOOR and says so (measured: p95 of observed
 *     displacement / (gap x move speed) is 0.97 across 39 read-pairs, so the floor is attainable
 *     and inflating it by a detour factor would wrongly rule out pits he can reach);
 *   - the read's AGE becomes a drift circle, and when the drift exceeds the distance the clause
 *     stops quoting a number and says the read is too old to bound it. A position read is only
 *     informative about a trip that is LONGER than the read is old — that rule is derived, not
 *     picked, and at the 15s read cadence of the recorded game it holds on 27% of turns against 88%
 *     at the browser's 5s journal beat;
 *   - DEATH replaces the read entirely: a corpse walks from the fountain, at a respawn clock the
 *     feed states exactly, so that origin has no age and no drift.
 */

/** Which side of the map each objective sits on. Fixed map geometry, not a reading. */
const DRAKE_SIDE = "bot side"
const BARON_SIDE = "top side"

/** How far ahead an objective is worth a line. Beyond this it is a fact about the map, not a decision. */
const PROSPECT_HORIZON_SEC = 150

/**
 * "in 45s" / "up since 12:19, untaken 1m15s" — the two shapes a prospect ever has, as a `Stake` so
 * `orderStakes` can rank it.
 *
 * The TEXT of both shapes is unchanged from when this returned a string. What moved is that the
 * line now carries which of the two it is, as a number, so the ordering is arithmetic instead of
 * the order the four calls happen to appear in below. See `shared/objective-stakes.ts` for the
 * measurement that made the old order indefensible.
 */
const prospect = (label: string, side: string, atSec: number, now: number, standingNote: string): Stake | null => {
	if (atSec > now + PROSPECT_HORIZON_SEC) return null
	return atSec > now ?
			{
				text: `- ${label} (${side}): up at ${clock(atSec)}, in ${dur(atSec - now)}.`,
				standingSinceSec: null,
				spawnsAtSec: atSec
			}
		:	{
				text: `- ${label} (${side}): UP since ${clock(atSec)} and ${standingNote} for ${dur(now - atSec)}.`,
				standingSinceSec: atSec,
				spawnsAtSec: null
			}
}

/**
 * Where he is, what he has, and who is standing near the pits — the clause every prospect shares.
 *
 * Written ONCE at the head instead of once per line. The alternative was measured on the same
 * states: repeating position and state on three objective lines costs about 300 characters a turn
 * inside a 1,500-character cap, and the section that gets evicted to pay for it is the memory.
 */
const prospectHead = (
	s: Scene,
	at: PositionFix | null | undefined,
	seenAtSec: number | null,
	watchedFromSec: number | null,
	full: boolean
): string[] => {
	const out: string[] = []
	/*
	 * The epistemics are in the HEADER, once, and the line itself is short. "a read of a picture,
	 * not something this feed knows" is 52 characters and it is the same 52 characters every turn of
	 * every game; a property of the channel belongs where a property is paid for once.
	 */
	/*
	 * ALIVE or DEAD leads here too, and the bars carry their amounts.
	 *
	 * This clause and NOW's opening sentence are the two places his own condition is stated, and
	 * both used to open on a bare percentage with the word `alive` nowhere in sight — NOW buried it
	 * mid-sentence and this one omitted it entirely unless he was dead. "You are all still dead",
	 * said at 28:12 while he stood at full health, was written against a payload in exactly that
	 * shape.
	 *
	 * The AMOUNTS stay in NOW and are not repeated here. NOW sits two lines above this one in every
	 * payload both modes produce, and this file has paid for a duplicated fact before: 220 characters
	 * of repeated counterpart clause, inside a fixed cap, evicted the memory. One word of state is
	 * the addition; the bars keep the shape they had.
	 */
	/*
	 * AND WHAT HE HAS BUILT, BY NAME — the one asymmetry in this payload that was inviting invention.
	 *
	 * The counterpart's clause has named HIS items on every turn since it was written ("Build: 4 to
	 * your 6 — Scorchclaw Pup, Hubris, ..."). The player's own items appeared only in the full
	 * brief's YOU section, which a delta does not carry, so on a delta turn this payload told the
	 * model how many items he had and never which. Twenty-two of the 28 turns of the graded run of
	 * game 5639406342 were deltas, and the coach filled the gap three times with real League items
	 * he did not own:
	 *
	 *   13:28  "You're back up with full mana and your Sorcerer's Shoes"   (Gluttonous Greaves)
	 *   15:24  "You're fresh off a back with your Haunting Guise"          (Morgana's, not his)
	 *   17:50  "You've completed your Cosmic Drive component"              (he built Riftmaker)
	 *
	 * None of those is a hallucinated NAME — they are all real items, which is what makes them
	 * unfalsifiable to a listener and worthless to a player. This app learned the rule once already
	 * with the farm baseline: a gap is an invitation, and the fix is to state the fact rather than
	 * to forbid the sentence.
	 *
	 * `shopItems`, so it is the same list the counterpart's "to your N" counts. The trinket and the
	 * consumables are left out for the same reason they are left out of his.
	 */
	const mine = shopItems(s.me)
	const build = mine.length === 0 ? "nothing built yet" : mine.map(i => i.name).join(", ")
	const state =
		s.me.dead ?
			`DEAD for ${r0(s.me.respawn)}s more, ${r0(s.gold)}g, holding ${build}`
		:	`ALIVE, ${pct(s.hp, s.maxHp)} HP, ${pct(s.mana, s.maxMana)} mana, ${r0(s.gold)}g, holding ${build}`
	/*
	 * TWO TENSES, ONE LINE — and the tense is the CALLER's call, never this file's guess at an age.
	 *
	 * A read taken on the turn is a statement about the present and is written as one. A read
	 * carried forward from an earlier turn is a statement about the PAST, and putting it in the
	 * present tense would be the same class of error as the pronoun that handed the player's own
	 * position to the enemy jungler three times in one game: specific, confident, and wrong in a way
	 * that sends him somewhere. So the past-tense form says WAS, says how long ago, and says he may
	 * have moved — and then stops, because what to do with a 22-second-old position is a judgement
	 * and this file does not make judgements.
	 *
	 * NOT ONE THIRD-PERSON WORD IN EITHER FORM. This payload addresses him as "you" and names
	 * exactly one other person, the enemy jungler, so ANY third-person phrasing here has a genuinely
	 * ambiguous referent — and the coach resolved that ambiguity the wrong way on three of the seven
	 * turns that carried a position in the graded run of game 5639406342, the last of them sending
	 * him into a Baron the enemy jungler was standing in. A test pins this line against a pronoun
	 * list; it is not a style preference.
	 */
	out.push(
		at ?
			`${
				at.asOf === "last-known" ?
					`You WERE at ${at.label} — the last read of YOUR own icon, ${dur(Math.max(0, s.now - at.atSec))} ago, so not where you are now and never where anyone else is.`
				:	`You: ${at.label}, ${dur(Math.max(0, s.now - at.atSec))} old.`
			} ${state}.${
				(at.enemies ?? []).length > 0 ?
					` Enemy icons on that same picture, unidentified: ${at.enemies!.join(", ")}.`
				:	""
			}`
		:	/*
			 * THE ABSENCE, NAMED LOUDER THAN THE LINE IT REPLACED — and naming the three sentences
			 * that were written into it.
			 *
			 * At 13:28 of game 5639406342 this exact branch rendered, verbatim, and the coach said
			 * *"now that you're full mana and have finished kiting towards your topside"*. He was
			 * standing in his own fountain. The old sentence said "Nothing in this payload says
			 * where you are" and it was not enough, because the invention was not a bare position:
			 * it was a DIRECTION and a FINISHED ACTION, neither of which that sentence refuses by
			 * name, and it arrived as a subordinate clause in front of the state figures, which is
			 * where a reader skims.
			 *
			 * So the absence leads, in capitals, and it lists what is not here: where he is, which
			 * way he is going, and what he has just done. Those are the three shapes the four
			 * invented-position lines of that run actually took.
			 */
			`You: WHERE YOU ARE IS NOT IN THIS PAYLOAD. There is no usable position — either nothing has read your icon this game or the last read is too old to say which half you are on. Nothing here says where you are, which way you are walking, or which camps you have just cleared. ${state}.`
	)
	/*
	 * The counterpart's OBJECTIVE-relevant state only — not the whole clause, which NOW already
	 * carries. Sending both cost 220 duplicated characters a turn inside a 1,500-character cap, and
	 * what those characters evicted was the memory. What an objective decision needs from him is
	 * whether he can be at the pit: his death and his respawn timer, which are read straight off the
	 * feed and are NOT fog-gated, and his level. "Kayn DEAD, back in 24s" against "drake in 45s" is
	 * the single most decidable pair in this payload.
	 */
	/*
	 * The counterpart in FULL here rather than in NOW, because this is where a decision about a pit
	 * consumes him. His death and his respawn are read straight off the feed and are not fog-gated,
	 * so "Kayn DEAD, back in 24s" against "drake in 45s" is the most decidable pair in this payload;
	 * his level and his build are the race that replaced the CS race, and the age on the end is what
	 * makes them safe to quote.
	 *
	 * The enemy ICONS ride on the position line above, ANONYMOUS. "Whether his counterpart was last
	 * seen near it" is the clause a jungler wants and the minimap reader cannot supply it — its
	 * enemy dots have no identity, and 16 of its refusals on the recorded game were the model
	 * pointing at a red-ringed Singed and calling it him. What it can supply is which patches of
	 * ground had red icons on them, which settles whether the pit is contested without naming anyone.
	 */
	if (s.counterpart !== null) {
		out.push(counterpartClause(s.me, s.counterpart, s.now, seenAtSec, watchedFromSec, full))
		/*
		 * AND WHERE HE IS NOT, on every turn, immediately under the clause that describes him.
		 *
		 * Placed here rather than beside the objective lines because this is where the temptation
		 * is: the reader has just been handed his level, his build and his respawn, and the one
		 * column that table has never had is the one a jungler reaches for. See `counterpartWhere`
		 * for the line that filled it at 11:39.
		 */
		out.push(counterpartWhere(s, s.counterpart, at))
	}
	return out
}

/* ---------------------------------------------------------------- reachability
 *
 * The clause that turns a timer into a decidable pair. See the section header above for why it
 * lives on the objective's own line and what may delete it.
 */

/** Rounded to the nearest hundred. The reader's own position error is a few hundred units; digits
 * below that are noise wearing the costume of precision. */
const units = (n: number): string => `${Math.round(n / 100) * 100} units`

/**
 * Whether he beats the spawn, stated as the range the read allows and nothing more.
 *
 * Both margins positive means he is there first however the uncertainty falls; both negative means
 * he is not; a straddle is a straddle and is written as one. No word in here says what to do about
 * it — "you have time" is arithmetic, "so go" is a decision.
 */
const marginPhrase = (minSec: number, maxSec: number): string => {
	if (Math.round(minSec) === Math.round(maxSec))
		return minSec >= 0 ?
				`you are there ${dur(minSec)} before it spawns`
			:	`you are there ${dur(-minSec)} after it spawns`
	if (minSec >= 0) return `you are there ${dur(minSec)}-${dur(maxSec)} before it spawns`
	if (maxSec < 0) return `you are there ${dur(-maxSec)}-${dur(-minSec)} after it spawns`
	return `you are somewhere between ${dur(maxSec)} early and ${dur(-minSec)} late`
}

/**
 * The clause appended to one objective line, or null when this payload cannot say anything.
 *
 * Null is a real and frequent answer and it renders as SILENCE on that line rather than as a hedge:
 * the head already states whether a position is known at all, and repeating "we don't know where you
 * are" once per objective would spend a third of NEXT's budget saying nothing three times.
 */
const reachClause = (r: ReachLine | undefined): string | null => {
	if (r === undefined) return null
	if (!r.constrained || r.units === null || r.speed === null || r.etaMinSec === null || r.etaMaxSec === null)
		return null
	/*
	 * THE DEAD FORM IS THE CERTAIN ONE, so it is written without a range and without an age.
	 *
	 * `DEAD 22s, then 6300 units from your fountain` is two exact figures off the feed and a
	 * constant off the map. It is the single most decidable sentence this section can produce, and
	 * it is the one turn where the coach knows more about his position than he is thinking about.
	 */
	/*
	 * BOTH FLOORS IN ONE CLAUSE, because there are two and quoting one of them would imply the
	 * number is tighter than it is. The straight line ignores walls, terrain and the jungle, so the
	 * walk is longer; and `moveSpeed` is the reading at THIS INSTANT, buffs included — across the
	 * recorded game it ran 333 (Lillia's base) to 847, and 61% of his alive samples sat above 1.2x
	 * base. A sentence that said only "straight line" would leave the model free to treat a
	 * boots-and-passive number as his travelling speed.
	 */
	const FLOOR = "Floor: the line ignores walls and the speed is this instant's."
	const travel = `${units(r.units)} at your ${r0(r.speed)} move speed right now`
	const margin =
		r.windowSec <= 0 || r.marginMinSec === null || r.marginMaxSec === null ?
			null
		:	marginPhrase(r.marginMinSec, r.marginMaxSec)
	if (r.origin === "fountain")
		return ` You: DEAD for ${r0(r.delaySec)}s, then ${travel} from your fountain — ${dur(r.etaMinSec)} from now at the earliest${margin === null ? "" : `, so ${margin}`}. ${FLOOR}`
	const eta =
		Math.round(r.etaMinSec) === Math.round(r.etaMaxSec) ?
			dur(r.etaMinSec)
		:	`${dur(r.etaMinSec)}-${dur(r.etaMaxSec)}`
	return ` You: ${eta} away — ${travel}, off a read ${dur(r.ageSec ?? 0)} old${margin === null ? "" : `, so ${margin}`}. ${FLOOR}`
}

/**
 * The one-line replacement for every clause, when the read is too old to bound ANY of the pits.
 *
 * Said once because the reason is the same for all of them — one read, one age, one drift circle.
 * It is also the section's own account of why it went quiet, which matters: a reachability clause
 * that appears on some turns and not others, with no reason given, reads as the app having nothing
 * to say rather than as the read having expired.
 */
const reachSilenceNote = (rs: readonly ReachLine[]): string | null => {
	const withOrigin = rs.filter(r => r.origin !== null && r.driftUnits > 0)
	if (withOrigin.length === 0) return null
	const r = withOrigin[0]!
	/*
	 * IT NAMES THE PITS IT CHECKED. "further than any of them was" was written when this note fired
	 * off whatever rows arrived, and on a real turn of the recorded game it rendered beside a single
	 * checked objective while claiming something about all of them — a small overclaim, and this
	 * file's whole argument is that a small overclaim is what a coach gets caught on.
	 */
	const named = withOrigin.map(x => x.label).join(" and ")
	return `Distance to ${named}: NOT COMPUTABLE this turn. That position read is ${dur(r.ageSec ?? 0)} old and at ${r0(r.speed ?? 0)} move speed you could have covered ${units(r.driftUnits)} since — more than the distance from it to ${withOrigin.length > 1 ? "either pit" : "that pit"}.`
}

const nextBlock = (
	s: Scene,
	at: PositionFix | null | undefined,
	seenAtSec: number | null,
	watchedFromSec: number | null,
	reach?: readonly ReachLine[] | null,
	/** True on the FULL brief only. See `counterpartClause`: it decides how much of him repeats. */
	full = false
): string => {
	const now = s.now
	const lines: string[] = []

	/*
	 * THE FIRST DRAKE GOES THROUGH `prospect` LIKE THE OTHER THREE.
	 *
	 * It used to be the one objective with no spawn gate: with no `DragonKill` in the log it pushed
	 * `- Drake (bot side): none taken, the first is still standing.` from 0:00, and the replay of
	 * the recorded game renders exactly that at 1:18 and 2:06. The first drake spawns at 5:00
	 * (earliest kill across the 94 stored games is 5:33), so that sentence was false for the first
	 * five minutes of every game — the window in which a jungler is most likely to path for it.
	 */
	/*
	 * COLLECTED, THEN ORDERED — see `shared/objective-stakes.ts`.
	 *
	 * These four calls stay in schedule order because that is the order a reader of this file
	 * expects to find them in. `orderStakes` below decides which one the MODEL reads first, and it
	 * ranks a standing objective above a spawning one regardless of which was written here. The two
	 * orders were the same thing until it was measured that they must not be.
	 */
	const stakes: Stake[] = []

	const drakes = s.events.filter(e => e.name === "DragonKill")
	const lastDrake = drakes.at(-1) ?? null
	/*
	 * WHO HOLDS WHAT, AND WHAT THE NEXT ONE IS WORTH — off the event log, which is the strongest
	 * channel in this feed and the only one that carries `DragonType` and `KillerName`.
	 *
	 * `isMine` resolves the killer through the roster this brief already read. A name that is not on
	 * it returns null and is counted for neither side: an unresolvable take may understate a soul
	 * point, and may never invent one.
	 */
	const stak = drakeStakes(
		drakes.map(e => ({
			tSec: e.t,
			killerName: str(e.raw.KillerName) ?? "",
			type: str(e.raw.DragonType)
		})),
		killer => {
			const p = s.players.find(x => x.name === killer)
			return p === undefined ? null : p.team === s.me.team
		}
	)
	/*
	 * The Elder's respawn is 360 seconds and every other drake's is 300. Using one constant for both
	 * put every post-soul drake clock a full minute early — untriggered so far only because no
	 * recorded game reached a second Elder.
	 */
	const drakeAt = lastDrake === null ? DRAKE_FIRST_SPAWN_SEC : lastDrake.t + stak.respawnSec
	const drakeLine = prospect("Drake", DRAKE_SIDE, drakeAt, now, "untaken")
	if (drakeLine !== null)
		stakes.push({ ...drakeLine, text: `${drakeLine.text} ${stakesClause(stak)}` })

	const grubs = s.events.filter(e => e.name === "HordeKill")
	if (now < GRUBS_GONE_SEC) {
		const line =
			grubs.length === 0 ?
				prospect("Voidgrubs", BARON_SIDE, GRUBS_SPAWN_SEC, now, "untouched by anyone")
			:	/*
				 * A counted-out row is neither standing nor spawning, so it sorts last on its own
				 * without a rule. It is history with a clock on it, which is exactly where it belongs
				 * once somebody has taken them.
				 */
				{
					text: `- Voidgrubs (${BARON_SIDE}): ${grubs.length} taken, last at ${clock(grubs.at(-1)!.t)}.`,
					standingSinceSec: null,
					spawnsAtSec: null
				}
		if (line !== null) stakes.push(line)
	}

	const herald = s.events.filter(e => e.name === "HeraldKill")
	/*
	 * The same despawn gate the grubs have had all along. Past 19:45 an untaken Herald is not a
	 * standing objective, it is a thing that left — see `HERALD_GONE_SEC`.
	 */
	if (herald.length === 0 && now < HERALD_GONE_SEC) {
		const line = prospect("Rift Herald", BARON_SIDE, HERALD_SPAWN_SEC, now, "untaken")
		if (line !== null) stakes.push(line)
	}

	const barons = s.events.filter(e => e.name === "BaronKill")
	const lastBaron = barons.at(-1) ?? null
	const baronAt = lastBaron === null ? BARON_SPAWN_SEC : lastBaron.t + BARON_RESPAWN_SEC
	const baronLine = prospect("Baron", BARON_SIDE, baronAt, now, "untaken")
	if (baronLine !== null) stakes.push(baronLine)

	for (const st of orderStakes(stakes)) lines.push(st.text)

	/*
	 * Deaths and respawn timers are NOT fog-gated and are read, not extrapolated — audited exact for
	 * him, his team and the enemy alike. So this is the hardest fact in the payload and it belongs
	 * beside the timers rather than in a roster row: a pit with three of them down is a different
	 * decision from the same pit thirty seconds later.
	 */
	/*
	 * THE LIST SAYS WHERE HE IS IN IT, because a list he is not named in reads as a list he is in.
	 *
	 * At 28:12 of game 5639406342 this line read `- Down right now: Urgot back in 19s, Yone back in
	 * 10s, Xayah back in 42s, Morgana back in 3s, Kayn back in 48s.` — four team-mates and the
	 * enemy jungler — and the coach said "you are all still dead". He was at 100% HP. The filter
	 * already excluded him and that exclusion was invisible: five names and no sixth is not a
	 * statement that the sixth is standing. So the line states it.
	 */
	/*
	 * AND WHOSE SIDE EACH ONE IS ON, because a bare list of names is counted as the enemy team.
	 *
	 * At 16:55 of game 5639406342 this line read `- Down right now (NOT you — you are ALIVE): Yone
	 * back in 15s, Draven back in 9s, Lulu back in 23s.` Yone is HIS OWN MID. The coach said "with
	 * three enemies dead including Kayn's support, secure this Rift Herald immediately" — a
	 * miscount of two enemies as three, and the whole call rested on it, while the frame showed him
	 * mid-trade with Kayn. That is the most dangerous line the run produced and it is not a
	 * fabrication: every name was real and the payload never said which team any of them was on.
	 *
	 * The roster sections below do carry DEAD on each row, in team blocks — but they are two
	 * thousand characters away and absent from a delta entirely, and this compact line is the one
	 * the objective clocks sit beside. So the team rides with the name, here, where it is read.
	 */
	const down = s.players.filter(p => p.dead && p.name !== s.me.name)
	if (down.length > 0)
		lines.push(
			`- Down right now (${s.me.dead ? `and YOU, for ${r0(s.me.respawn)}s more` : "NOT you — you are ALIVE"}): ${down
				.map(
					p =>
						`${p.champion} (${p.team === s.me.team ? "YOUR team" : "ENEMY"}) back in ${r0(p.respawn)}s`
				)
				.join(", ")}.`
		)

	/*
	 * THE HEAD IS THE SECTION; THE OBJECTIVE LINES ARE ITS CONTENT — so an empty horizon does not
	 * delete the block.
	 *
	 * This used to `return null` when nothing was inside `PROSPECT_HORIZON_SEC`, which took the
	 * position line, his state and the counterpart's clause out with it. Measured across all 14
	 * recorded games that was 0-12.3% of delta turns, all of them mid or late game, and on those
	 * turns the payload carried a level comparison with no age on it anywhere — the exact shape that
	 * produced the FALSE line at 2:06. Gating the first drake behind its 5:00 spawn made it worse
	 * still: before that change something was always inside the horizon at 0:00, and after it the
	 * OPENING BRIEF of every game was one of the turns with no head.
	 *
	 * So the head always renders, and an empty horizon SAYS it is empty. Stating it costs one line
	 * and it is the same argument the spawn constants are here for: a schedule the brief does not
	 * state is one the model will invent, and "no objective line this turn" is not "no objective".
	 */
	/*
	 * NOT A BULLET. Every `- ` line in this section is an objective, and a reader — human, model or
	 * the bench's own `mock` control, which speaks the block's first `- ` line verbatim — treats the
	 * first one as the thing to act on. An empty horizon is a statement ABOUT the list, so it is
	 * written as one.
	 */
	if (lines.length === 0)
		lines.push(`Nothing on the objective schedule is inside the next ${dur(PROSPECT_HORIZON_SEC)}.`)

	/*
	 * REACHABILITY RIDES ON THE OBJECTIVE'S OWN LINE — the join, in one sentence, not two sections.
	 *
	 * Matched by the label `prospect` put at the head of the line, which is why the match is a
	 * prefix test on `- ${label} (` rather than a substring search: "Drake" appears inside the
	 * counterpart's build and inside the narrative, and a substring match would have stapled a
	 * travel time onto a sentence about an item.
	 */
	const reaches = reach ?? []
	let clauses = 0
	let noteChars = 0
	/*
	 * MATCHED rows only, everywhere below. A row whose label NEXT did not render this turn — a drake
	 * beyond the horizon, a renamed objective — is not evidence of anything about the objectives that
	 * ARE on screen, and counting it would let a single unmatched row push out "not computable this
	 * turn" onto a payload whose every rendered objective had a perfectly good number.
	 */
	const matched: ReachLine[] = []
	if (reaches.length > 0) {
		for (let i = 0; i < lines.length; i++) {
			const r = reaches.find(x => lines[i]!.startsWith(`- ${x.label} (`))
			if (r === undefined) continue
			matched.push(r)
			const c = reachClause(r)
			if (c !== null) {
				lines[i] = lines[i]! + c
				clauses++
			}
		}
		/*
		 * Only when NOTHING could be quoted. A turn where one pit is bounded and another is not says
		 * what it knows and stays silent on the rest — the note is an account of total silence, and
		 * printing it beside a clause that did quote a number would contradict the clause.
		 */
		if (clauses === 0 && matched.length > 0) {
			const note = reachSilenceNote(matched)
			if (note !== null) {
				/*
				 * IN WITH THE OBJECTIVES, NOT AFTER THE CORPSE LIST — because `fit` drops from the END.
				 * Appended, this note sat behind `- Down right now (...)` and at 19:10 of game
				 * 5639406342 it was silently evicted by the 340-character budget, which made a turn
				 * that HAD an account of its own silence look like a turn that had nothing to say.
				 */
				const downAt = lines.findIndex(l => l.startsWith("- Down right now"))
				lines.splice(downAt === -1 ? lines.length : downAt, 0, note)
				noteChars = note.length
			}
		}
	}

	/*
	 * The budget grows only when a clause was actually written. `fit` drops from the END, so a
	 * fixed budget would have made the reachability clause on the LAST objective pay for the first
	 * two — which silently deletes the baron clause on exactly the turns baron decides the game.
	 */
	const budget = NEXT_BUDGET + clauses * REACH_BUDGET_PER_CLAUSE + noteChars
	return ["NEXT — what is coming, joined to where you are and what you have. The position line is a read of a PICTURE, not a feed value.", ...prospectHead(s, at, seenAtSec, watchedFromSec, full), ...fit(lines, budget)].join("\n")
}

/** The objective lines only; the head is never dropped, because a timer with no state beside it is CLOCKS again. */
const NEXT_BUDGET = 340

/**
 * What one reachability clause is allowed to add. Measured on the recorded game: the longest form
 * the renderer emits — the dead one, with a margin — is 188 characters, and the alive form runs
 * 150-175. Paid per clause WRITTEN, so a turn with no usable read costs nothing.
 */
const REACH_BUDGET_PER_CLAUSE = 230

/* ================================================================ JOINS — the rest of the pairings
 *
 * Decomposition #3: pair every fact with the thing that makes it matter, in TypeScript, so the
 * model's job is to pick one rather than to derive one.
 *
 * Everything here is arithmetic over fields the audit passed, and every one of them is a figure he
 * cannot read off his own screen — which is the test that separates a line worth saying from a line
 * that recites his HUD. He cannot sum his team's kills to get his own participation, he cannot
 * count who was in the fight that just happened, and he certainly cannot remember which objectives
 * were standing when he died ninety seconds ago.
 */

/** Kills inside this gap of each other are one fight. Nothing in the feed marks a fight; this is the join. */
const FIGHT_GAP_SEC = 20

/** A fight older than this is history and the narrative already has it. */
const FIGHT_STALE_SEC = 120

const joinsBlock = (s: Scene): string | null => {
	const out: string[] = []
	const kills = s.events.filter(e => e.name === "ChampionKill").sort((a, b) => a.t - b.t)

	/* --- kill participation, his and the counterpart's. Exact: kills and assists are audited at
	 * 99-100% for every player, and the sum is the only place either figure becomes a rate. */
	const mine = s.players.filter(p => p.team === s.me.team)
	const theirs = s.players.filter(p => p.team !== s.me.team)
	const teamKills = mine.reduce((n, p) => n + p.kills, 0)
	const enemyKills = theirs.reduce((n, p) => n + p.kills, 0)
	if (teamKills > 0) {
		const c = s.counterpart
		const his =
			c === null || enemyKills === 0 ? "" : (
				` ${c.champion} is in ${c.kills + c.assists} of their ${enemyKills} (${pct(c.kills + c.assists, enemyKills)}).`
			)
		out.push(
			`- Kill participation: you are in ${s.me.kills + s.me.assists} of your team's ${teamKills} kills (${pct(s.me.kills + s.me.assists, teamKills)}).${his}`
		)
	}

	/* --- the last fight, and whether he was in it. `fights.ts` does this to the post-game timeline;
	 * this is the same cluster over the live event feed, which carries every kill with its clock. */
	if (kills.length > 0) {
		const last = kills.at(-1)!
		if (s.now - last.t <= FIGHT_STALE_SEC) {
			const cluster: Ev[] = [last]
			for (let i = kills.length - 2; i >= 0; i--) {
				if (cluster[0]!.t - kills[i]!.t > FIGHT_GAP_SEC) break
				cluster.unshift(kills[i]!)
			}
			const teamOf = new Map(s.players.map(p => [p.name, p.team]))
			const oursKilled = cluster.filter(e => teamOf.get(str(e.raw.KillerName) ?? "") === s.me.team).length
			const inIt = cluster.some(e =>
				[str(e.raw.KillerName), str(e.raw.VictimName), ...arr(e.raw.Assisters).map(a => str(a))].includes(s.me.name)
			)
			const span = cluster.length === 1 ? clock(last.t) : `${clock(cluster[0]!.t)}-${clock(last.t)}`
			out.push(
				`- Last fight ${span} (${age(s.now - last.t)}): ${oursKilled} for you, ${cluster.length - oursKilled} for them, and you were ${inIt ? "in it" : "NOT in it"}.`
			)
		}
	}

	/*
	 * --- his last death crossed with what was standing when it happened.
	 *
	 * The post-game pack's best card, computed forwards from a schedule the brief already holds. A
	 * death is expensive in proportion to what was open, and nothing on his screen tells him what
	 * was open ninety seconds ago.
	 */
	const myDeath = s.events
		.filter(e => e.name === "ChampionKill" && str(e.raw.VictimName) === s.me.name)
		.sort((a, b) => a.t - b.t)
		.at(-1)
	if (myDeath) {
		const t = myDeath.t
		const open: string[] = []
		const drakeUp = s.events.filter(e => e.name === "DragonKill" && e.t < t).at(-1)
		if (drakeUp === undefined || drakeUp.t + DRAKE_RESPAWN_SEC <= t) open.push("drake")
		if (t >= HERALD_SPAWN_SEC && !s.events.some(e => e.name === "HeraldKill" && e.t < t)) open.push("Rift Herald")
		/*
		 * Grubs are the one entry here that needs a KILL check as well as a window, and it was the
		 * one entry without one. A set is cleared in pieces, and once any of it is down this feed
		 * cannot say how much is left — the log carries `HordeKill` events and no set size. So the
		 * claim is made only while the pit is untouched, which is the same rule drake, Herald and
		 * Baron already follow. Without it a death at 13:00 was reported as "voidgrubs standing at
		 * the time" three minutes after three of them had been killed.
		 */
		if (t >= GRUBS_SPAWN_SEC && t < GRUBS_GONE_SEC && !s.events.some(e => e.name === "HordeKill" && e.t < t))
			open.push("voidgrubs")
		if (t >= BARON_SPAWN_SEC && !s.events.some(e => e.name === "BaronKill" && e.t < t)) open.push("Baron")
		out.push(
			`- Your last death ${clock(t)} (${age(s.now - t)}) to ${s.who(myDeath.raw.KillerName)}: ${
				open.length === 0 ? "no objective was standing at the time" : `${open.join(" and ")} standing at the time`
			}.`
		)
	}

	if (out.length === 0) return null
	return ["JOINS — computed here so you do not have to derive them", ...fit(out, JOINS_BUDGET)].join("\n")
}

const JOINS_BUDGET = 320

/**
 * The ceiling on ONE delta, and it was sized for a schedule this app no longer runs.
 *
 * 1500 was tuned against a 6-20 second beat, where a turn covered almost nothing and the fixed
 * sections were most of it. The event schedule replaced that: on the recorded game 5639406342 it
 * raises 67 turns across 28 minutes rather than the 282 a 6-second beat would, so the gaps between
 * turns are 40-100 seconds and each delta has 5-15x as much world to describe. The rank-0 core —
 * NOW, NEXT, SINCE, NEW SINCE — grew into the whole budget, and everything below it starved: over
 * the 66 deltas of that replay the anti-repetition memory reached the model on 16 turns, MOVED on
 * 3, and THE GAME SO FAR on 8. MOVED is where "what the enemy jungler just BOUGHT" appears, and
 * the memory is the countermeasure to a measured 56% near-duplicate rate.
 *
 * 2000 is the same argument the schedule itself was made on, run the other way: 67 turns at 2000
 * characters is 134,000 characters a game against the 423,000 that 282 turns at 1500 would have
 * cost. Fewer questions, each worth more — spending a third as much on a payload that now has to
 * carry a minute and a half of game is the cheaper half of that trade, not an indulgence.
 *
 * It is a cap on what is SENT. It names no fact, forbids no subject and imposes no cadence, so it
 * is not a guardrail — and every section it makes room for is one the coach was already supposed
 * to have.
 *
 * ## 2000 -> 2300, and the measurement that says a bigger payload is free
 *
 * `counterpartWhere` and the louder absence line add about 300 characters to every delta, and at
 * 2000 they were paid for by the sections that yield. Replayed over the 38 stored turns of game
 * 5639406342 (`data/eval/stream-kayn-events2-20260910.json`, reproduced byte-identically first, so
 * the comparison is against the payloads that were actually graded):
 *
 *     cap    memory   MOVED   JOINS      (turns of 38 carrying the section)
 *     2000      21      17      31       as it shipped, without the absence lines
 *     2000      10       6      16       with them — the memory halved
 *     2300      25      17      33       with them, and better than it shipped
 *
 * The memory is the countermeasure to the fault that is now the largest one in the transcript —
 * 20 of 37 lines true-but-useless, three drake lines in 19 seconds — so paying for the absence
 * statements out of it would have traded one measured fault for a worse one.
 *
 * The cap is a COST control and never a latency one, and that is measured rather than assumed. Over
 * the same 38 turns, latency regressed on turn index AND payload size together gives 64.5ms per
 * turn of thread (t = 12.3) and -0.011ms per character (t = -0.2, the wrong sign); over the 23-turn
 * run it is 20.4ms per turn and +0.0014ms per character. So 300 more characters a turn is somewhere
 * between three milliseconds saved and half a millisecond spent, and the thing that actually made
 * the coach slow is in `web/lib/geminiLive.ts`. In tokens it is about 20,000 characters over a
 * 67-turn game, which is a rounding error against the frame each of those turns already carries.
 */
/**
 * ## 2300 -> 3100, because the position work put three new rank-0 facts inside the same cap
 *
 * The journal-beat watcher gave nearly every turn a position, and a position brings the reach
 * clauses with it; the payload also names his own build now, and the down-list names each player's
 * team. All three are rank 0 — they cannot yield — so at 2300 they were paid for out of the memory,
 * which is the countermeasure to the fault that is currently the largest one in the transcript.
 *
 * MEASURED by rendering the 21 delta turns of game 5639406342 at five caps, with the beat supply
 * and the new facts in place (`--arms mock`, so nothing but the renderer moved):
 *
 *     cap    memory   JOINS   MOVED   mean delta
 *     2300      4       10       3      2,178      <- the memory all but gone
 *     2500     10       17       6      2,408      <- back to what round 3 shipped
 *     2700     16       20       9      2,599
 *     3100     20       21      12      2,935      <- here
 *     3400     21       21      18      3,132
 *
 * 3100 and not 3400 because the last 300 characters buy one memory row and six MOVED blocks, and
 * MOVED is a roster of everyone's purchases — the most true-but-useless material in the payload,
 * and dilution is the fault this is trying not to feed. The memory is the opposite: it is the only
 * section that makes a line LESS likely to be said.
 */
export const DELTA_HARD_CAP = 3100

/**
 * What the two caller-owned sections may take out of a delta before their oldest rows drop.
 *
 * Sized against the measured payloads: a delta runs 1.0-1.7 KB, NOW and SINCE and the events take
 * about 700 of it, and CLOCKS and MOVED want 470 between them. These two get what is left, and
 * neither may spend the other's.
 */
const SAID_BUDGET = 380
const NARRATIVE_BUDGET = 380

/** Under this there is no room for even one row, so the section is not asked for at all. */
const MEMORY_FLOOR = 120

/**
 * The most MOVED may hold back from the two sections that yield to it.
 *
 * Measured on the recorded game the block runs 76-157 characters on a normal turn; 280 covers the
 * busy ones without letting a five-kill window's worth of rows push the memory out. A block bigger
 * than this is not reserved for at all — it competes for the remainder like everything else.
 */
const MOVED_RESERVE = 280

/**
 * The per-turn update, for every turn after the opening one (and after every resync, which re-sends
 * the full brief).
 *
 * Measured against the twelve graded turns of game 5635467422: the full brief ran 4,003 characters
 * at 0:05, 4,638 at 1:12, 4,733 at 4:03 and 6,165 at 8:07 — 56,688 across the window, of which
 * 24,445 (43%) was byte-identical to the turn immediately before. The largest fixed block,
 * `WHAT THIS FEED IS`, was 1,190 characters and changed never. So the expensive part of the payload
 * was the part that changed least, and this sends only what a thread cannot already hold.
 *
 * ## Every section has a budget, because one without a budget evicts the others
 *
 * The memory sections arrive as rendered text from a caller that grows them, and `said` was
 * originally given rank 0 and NO budget of its own. Its rows grow as verdict text is appended, so
 * from about 3:00 of the stored run the payload plateaued ABOVE the cap and the eviction loop
 * dropped CLOCKS and then MOVED from every remaining turn — permanently, not transiently. A
 * same-instant A/B in that run has the mock arm rendering [NOW, SINCE, NEW SINCE, SAID, MOVED,
 * CLOCKS] at 182.6s and the gemini arm rendering [NOW, SINCE, NEW SINCE, SAID]. What was evicted is
 * verbatim `Voidgrubs: up at 5:00, in 26s.` and every enemy's purchases — precisely the facts a
 * coach can say that he cannot see. The coach then improvised about grubs at 5:22 and 6:05 with the
 * grub timer removed from its payload.
 *
 * So the caller-owned sections are fitted before they are ranked, and CLOCKS now outranks MOVED:
 * a timer nobody can see beats a roster row, and MOVED's own rows are already the cheapest thing
 * here to lose.
 *
 * The cap is on what is SENT. It names no fact, forbids no subject and imposes no cadence, so it is
 * not a guardrail.
 */
export const buildDelta = (input: BriefInput): LiveBrief | null => {
	const s = readScene(input)
	if (!s) return null

	/* rank 0 never drops; higher ranks drop first, highest first. */
	const parts: Array<{ text: string; rank: number }> = []
	const seen = input.counterpartSeenSec ?? null
	const watchedFrom = input.counterpartWatchedFromSec ?? null
	parts.push({ text: situation(s, input.where, input.at, seen, watchedFrom), rank: 0 })
	/*
	 * NEXT is RANK 0, which is the whole point of this revision.
	 *
	 * It is the section that replaced CLOCKS, and CLOCKS was rank 1 — droppable — for a good reason
	 * at the time: it was 150 characters of bare timers and the memory sections were the ones being
	 * starved. That trade is off now. NEXT is not a timer, it is the objective crossed with his
	 * position and his gold and his counterpart's respawn, which is the join the post-game pack won
	 * on and the join the model demonstrably will not make for itself. If something has to be
	 * dropped to fit it, the memory drops: the memory is anti-repetition and this is the decision.
	 */
	parts.push({ text: nextBlock(s, input.at, seen, watchedFrom, input.reach), rank: 0 })
	parts.push({ text: sinceBlock(s), rank: 0 })
	const events = newEventsBlock(s)
	if (events !== null) parts.push({ text: events, rank: 0 })
	const joins = joinsBlock(s)
	if (joins !== null) parts.push({ text: joins, rank: 1 })
	/*
	 * The baselines, which the delta carried NOT AT ALL.
	 *
	 * `buildDelta` never took them, and the only full brief of a game is built at ~0:05, where
	 * `baselineBlock` skips cs@10/cs@14/cs@20 because the clock has not reached the checkpoint.
	 * Confirmed in the stored run: both brief turns print six baselines and not one CS checkpoint,
	 * and every delta prints none. So his farm baselines — "12 CS at 8:00 against your own average
	 * of 18", the app's signature coaching move — were unreachable for a whole game under the
	 * shipped default, while the prompt told the model that an absent baseline means he has not
	 * played enough games for one to exist. Only the CHECKPOINT lines ride here, and only once the
	 * game has passed them: the rest are in the opening brief and do not change.
	 */
	const checkpoints = checkpointBaselines(input.baseline, s.now)
	if (checkpoints !== null) parts.push({ text: checkpoints, rank: 1 })

	/*
	 * ## The three tail sections are SIZED to what is left, not ranked and dropped
	 *
	 * They used to be rank 2, 3 and 4 with fixed 380-character budgets, and the eviction loop threw
	 * them away whole. With NEXT and JOINS in the payload the fixed sections come to about 1,200
	 * characters, so a 380-character `said` no longer fits and the loop deleted the entire memory —
	 * every turn, for the rest of the game. That is the same all-or-nothing failure that once lost
	 * CLOCKS from 3:00 onward, with the ranks the other way up.
	 *
	 * Both of these renderers already know how to drop their OLDEST rows to a budget. So the budget
	 * becomes whatever the cap has left after the sections that cannot yield, split in rank order,
	 * and a section only vanishes when there is genuinely no room for its newest row. One line of
	 * "what you already said" is most of the anti-repetition value; nought lines is none of it.
	 *
	 * `MEMORY_FLOOR` exists because `saidBlock` and `narrativeBlock` both keep their newest row
	 * whatever the budget says — correctly, since a header with no rows is a lie about an empty
	 * memory. Below the floor they are not asked at all.
	 */
	const fixedSize = parts.reduce((n, p) => n + p.text.length, 0) + (parts.length - 1) * 2
	let room = DELTA_HARD_CAP - fixedSize
	/*
	 * FITS OR IT IS NOT SENT. Both renderers keep their newest row whatever budget they are given —
	 * correctly, since a header with no rows is a lie about an empty memory — so a section asked for
	 * with 40 characters of room comes back at 150 and the backstop loop below deletes it again.
	 * That is the all-or-nothing behaviour this replaced, returning by the back door.
	 */
	const spend = (text: string | null): void => {
		if (text === null || text.length + 2 > room) return
		parts.push({ text, rank: 5 })
		room -= text.length + 2
	}
	/*
	 * MOVED IS RESERVED FOR RATHER THAN SPENT LAST, because last is never.
	 *
	 * It is the cheapest section here and it was the one that never arrived: over the 66 deltas of
	 * the recorded game it appeared 3 times at the old cap and 16 at this one, always losing the
	 * remainder to `said` and `narrative`, which take up to 380 each and shrink gracefully. MOVED
	 * does not shrink gracefully — it is whole rows or nothing — and it is where "what the enemy
	 * jungler just BOUGHT" appears, which `TRUSTED_PROMPT` promises the model by name and which is
	 * the loudest counterpart signal the app has now that his farm figure is gone.
	 *
	 * So its own size is held back before the two that yield, capped so a chaotic turn cannot let
	 * ten changed rows evict the memory instead. If it does not fit inside the reserve it is not
	 * sent, and the reserve is released to the sections below.
	 */
	const moved = movedBlock(s)
	const reserved = moved !== null && moved.length + 2 <= MOVED_RESERVE ? moved.length + 2 : 0
	room -= reserved
	spend(room >= MEMORY_FLOOR ? saidBlock(input.said, Math.min(SAID_BUDGET, room - 2)) : null)
	spend(room >= MEMORY_FLOOR ? narrativeBlock(input.narrative, Math.min(NARRATIVE_BUDGET, room - 2)) : null)
	room += reserved
	if (moved !== null) spend(moved)

	/* The backstop, for the case where the sections that cannot yield are themselves over the cap. */
	const kept = parts.slice()
	const size = (): number => kept.reduce((n, p) => n + p.text.length, 0) + (kept.length - 1) * 2
	while (size() > DELTA_HARD_CAP) {
		const worst = kept.reduce((a, b) => (b.rank > a.rank ? b : a))
		if (worst.rank === 0) break
		kept.splice(kept.indexOf(worst), 1)
	}

	const text = kept.map(p => p.text).join("\n\n")
	return {
		text,
		chars: text.length,
		me: s.me.champion,
		counterpart: s.counterpart?.champion ?? null,
		roster: s.players.map(p => p.champion),
		sections: kept.map(p => ({ name: p.text.split("\n")[0]!.slice(0, 40), chars: p.text.length }))
	}
}
