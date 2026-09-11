/**
 * Two pieces of arithmetic the tournament said were missing from the objective section, and one
 * ordering decision. Pure, browser-safe, no I/O — `live-brief.ts` calls it and nothing else does.
 *
 * ## Why this file exists at all
 *
 * Twelve prompt variants were run over ten hand-chosen moments of game 5639406342 and graded by
 * three independent judges. The judges did not agree on which variant won — two of them named
 * different winners, and the variant one ranked first the other ranked sixth — but they agreed on
 * two properties of the payload, and both of those properties are arithmetic, not wording.
 *
 * ### 1. A STANDING objective outranks a SPAWNING one, and the renderer was saying the opposite
 *
 * `nextBlock` emitted its four objective lines in a fixed order — Drake, Voidgrubs, Herald, Baron —
 * and `fit` drops from the END of that list. So the line the model read first was always the drake,
 * whatever else was on the map.
 *
 * At 17:56 of the graded game the Rift Herald had been STANDING, untaken, for 2 minutes 57 seconds,
 * and the enemy jungler took it five seconds later. The drake was 45 seconds from spawning. The
 * payload carried both facts and put the drake first. ELEVEN OF TWELVE VARIANTS said "drake in
 * forty-five seconds"; not one named the Herald. The twelfth said nothing.
 *
 * That is not twelve models making the same mistake. It is one ordering decision, made here, being
 * obeyed twelve times — and it is the clearest single result in the tournament because the variants
 * differed in every other respect and still all did this.
 *
 * The two facts are also not equally available to him. A SPAWN CLOCK IS ON HIS MINIMAP: the game
 * draws the next drake timer where he can see it, and every variant said it because every variant
 * could have said it in any game at any clock. HOW LONG SOMETHING HAS BEEN STANDING FREE is drawn
 * nowhere — the client shows that the objective is up, never that nobody has wanted it for three
 * minutes. Under the app's own two tests (`AGENTS.md`: not-visible, not-generic) the standing age
 * passes both and the spawn clock fails the first.
 *
 * So `orderStakes` sorts standing before spawning, oldest-standing first, then soonest-spawning.
 * It changes no line's TEXT and adds no line. It decides which one survives `fit` and which one the
 * model reads first. Nothing here says the standing objective should be spoken about — a coach that
 * reads both lines and picks the spawn is making a judgement, which is its job. What it may no
 * longer do is pick the spawn because the standing line was fourth.
 *
 * ### 2. SOUL POINT, which is derivable and was never derived
 *
 * The event log carries `DragonType` and `KillerName` on every `DragonKill`, and the roster carries
 * every player's team, so each team's drake count is exact arithmetic over a channel graded as the
 * strongest in the feed. A team on three drakes makes the NEXT drake the soul drake, and after a
 * soul the next spawn is Elder, not another elemental.
 *
 * Five of the twelve variants said "soul" at 23:50 and the value judge counted every one of them as
 * useful; the truth judge's citation for its own winner's best line is "enemy on three drakes so
 * the next one is soul — every number derived, none guessed." They were deriving it from the same
 * event log this function reads. Deriving it here means it is right every time instead of most
 * times, and it means the model spends its sentence on the decision rather than on the counting —
 * which is the one thing `TRUSTED_PROMPT` says has failed every time it has been tried.
 *
 * It also fixes a respawn error nobody had hit yet: the Elder's timer is 360 seconds, not 300, so
 * every drake clock this app would have printed after a soul was taken was a minute early.
 */

/** The API's own word for a drake, off `DragonKill.DragonType`. */
export interface DrakeTake {
	/** Game clock of the take, in seconds. */
	tSec: number
	/** `KillerName`, matched against the roster by the caller. */
	killerName: string
	/** Raw `DragonType` — "Fire", "Air", "Hextech". Absent on a torn payload. */
	type: string | null
}

/** How many drakes each side holds, and what the next one therefore is. */
export interface DrakeStakes {
	yours: number
	theirs: number
	/**
	 * What the NEXT drake to spawn is worth.
	 *
	 * - `"soul-yours"` / `"soul-theirs"` — one side is on three, so the next one ends the elementals.
	 * - `"elder"` — a soul is already taken; every drake after it is the Elder.
	 * - `"normal"` — an ordinary elemental drake.
	 */
	next: "normal" | "soul-yours" | "soul-theirs" | "elder"
	/** Seconds from a take to the next spawn. 300 for an elemental, 360 for the Elder. */
	respawnSec: number
}

/** Riot's own numbers. Named rather than inlined because the Elder's is the one this app had wrong. */
export const DRAKE_RESPAWN_SEC = 300
export const ELDER_RESPAWN_SEC = 360
/** Drakes one team must hold before the next spawn is the soul drake. */
export const SOUL_AT = 3

/**
 * Count the drakes and decide what the next one is.
 *
 * `isMine` answers "was this killer on my team", because this file has no roster. A killer the
 * caller cannot place — a name that is not on `allPlayers`, which happens on a torn payload — is
 * counted for NEITHER side rather than guessed onto one, so an unresolvable take can understate a
 * soul point but can never invent one.
 */
export const drakeStakes = (takes: readonly DrakeTake[], isMine: (killerName: string) => boolean | null): DrakeStakes => {
	let yours = 0
	let theirs = 0
	for (const t of takes) {
		const mine = isMine(t.killerName)
		if (mine === true) yours++
		else if (mine === false) theirs++
	}
	/*
	 * ELDER IS DECIDED BY THE COUNT, NOT BY THE TYPE STRING.
	 *
	 * `DragonType` on the soul-granting take is still an elemental word — the fourth drake of the
	 * graded game reads "Hextech", not "Elder" — so a type test would never fire. The count is what
	 * the game itself uses and it is exact here.
	 */
	const soulTaken = yours > SOUL_AT || theirs > SOUL_AT
	const next: DrakeStakes["next"] =
		soulTaken ? "elder"
		: yours === SOUL_AT ? "soul-yours"
		: theirs === SOUL_AT ? "soul-theirs"
		: "normal"
	return {
		yours,
		theirs,
		next,
		respawnSec: next === "elder" ? ELDER_RESPAWN_SEC : DRAKE_RESPAWN_SEC
	}
}

/**
 * The clause that rides on the drake's own line: who holds what, and what the next one is worth.
 *
 * Stated as a count of takes rather than as a verdict. "They are on 3" is a number off the event
 * log; "you are losing the drake race" is a judgement, and judgements are the model's.
 */
export const stakesClause = (s: DrakeStakes): string => {
	const held = `Drakes: you ${s.yours}, them ${s.theirs}.`
	return (
		s.next === "soul-yours" ? `${held} You are on ${SOUL_AT}, so this next one is YOUR soul.`
		: s.next === "soul-theirs" ? `${held} They are on ${SOUL_AT}, so this next one is THEIR soul.`
		: s.next === "elder" ? `${held} A soul is already taken, so every drake from here is the Elder.`
		: held
	)
}

/**
 * One objective line, with what `orderStakes` needs to rank it.
 *
 * `standingSinceSec` is the clock the thing became takeable, and it is what makes a line standing;
 * `spawnsAtSec` is the clock it will become takeable. Exactly one of the two is a number on any
 * given line, and a line with neither (a counted-out voidgrub row, the empty-horizon sentence) sorts
 * last without needing a rule of its own.
 */
export interface Stake {
	text: string
	standingSinceSec: number | null
	spawnsAtSec: number | null
}

/**
 * Standing first, oldest standing first; then spawning, soonest first; then everything else.
 *
 * A stable sort over a list that is never longer than five, so the cost is nothing and the order of
 * equals is the order the caller wrote them in.
 */
export const orderStakes = (stakes: readonly Stake[]): Stake[] => {
	const rank = (s: Stake): number => (s.standingSinceSec !== null ? 0 : s.spawnsAtSec !== null ? 1 : 2)
	return [...stakes].sort((a, b) => {
		const ra = rank(a)
		const rb = rank(b)
		if (ra !== rb) return ra - rb
		// Standing: the one that has been free longest leads. Spawning: the one that lands soonest.
		if (ra === 0) return a.standingSinceSec! - b.standingSinceSec!
		if (ra === 1) return a.spawnsAtSec! - b.spawnsAtSec!
		return 0
	})
}
