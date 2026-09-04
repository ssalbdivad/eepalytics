/**
 * Champion knowledge in the only shape a live coach can use it: **a lookup keyed by state.**
 *
 * ## Why this is a table and not the markdown
 *
 * `knowledge/champions/*.md` is prose, and prose is what the REVIEW coach wants — it has a
 * thousand words and a minute to think. Dropping the same prose into the live prompt produces
 * the failure that is worse than silence, because it *sounds* like coaching:
 *
 *     "Viego is your jungle counterpart so watch for his ganks."
 *     "Viego resets on takedowns, so be careful in teamfights."
 *
 * Both are true. Both could have been said in any game he has ever played, at any minute of it.
 * A live line has to survive two tests, and champion prose fails the second one every time:
 *
 *   1. **NOT VISIBLE** — could he have got it by looking at his own screen right now?
 *   2. **NOT GENERIC** — could this exact sentence have been said in a different game, or five
 *      minutes ago in this one?
 *
 * So knowledge is not offered as background. It is indexed by the state it applies to, and
 * `buildFacts` looks it up only once the state is TRUE. Knowledge answers "what does THIS state
 * imply?", never "what is this champion like?". The measured half of the sentence comes from the
 * client; this supplies the half that says what to do about it. That is the same fence the review
 * coach already runs under (`AGENTS.md`): champion notes shape the fix, never the numbers.
 *
 * ## The fence, restated for this file
 *
 * Every string here is an IMPERATIVE and contains **no number, no timer, no champion name and no
 * claim about what happened**. If a string in this table ever carries a figure it has become a
 * fabricated stat, because nothing here was measured from his game.
 *
 * ## Where the content comes from
 *
 * Each entry is derived from that champion's file in `knowledge/champions/`, which carries its
 * own `source:` and `patch:` header. Nothing here is model recall: if a claim is not in the
 * markdown, it does not belong in the table. Adding a champion is a data edit — write the file,
 * then add the entry.
 */

/**
 * `Bel'Veth` -> `belveth`, `Dr. Mundo` -> `drmundo`.
 *
 * Deliberately a copy of `championKey` in `src/knowledge/index.ts` rather than an import:
 * that module reads the filesystem, and `src/analysis/` does no I/O.
 */
const key = (name: string): string => name.toLowerCase().replace(/[^a-z]/g, "")

/**
 * One champion's answers, each keyed by the state that makes it the right thing to say.
 *
 * Every field is the ACT half of a spoken line — `buildFacts` pairs it with a measured hook. A
 * field is never spoken on its own, because on its own it is exactly the generic truth this file
 * exists to prevent.
 */
export interface Playbook {
	champion: string
	/** He is measurably behind his own camp pace. */
	behindPace: string
	/** He is measurably ahead of it. */
	aheadPace: string
	/** The enemy jungler is dead, and he is NOT behind his own pace: the invade is on. */
	junglerDown: string
	/**
	 * The enemy jungler is dead and he IS behind his own pace.
	 *
	 * A separate answer because counter-jungling is only correct when both conditions hold —
	 * knowing where the enemy jungler is AND not being behind on your own camps (`AGENTS.md`).
	 * With one of the two failing, the free window is a full clear, not an invade.
	 */
	junglerDownFarm: string
	/** He is two or more levels up on the enemy jungler. */
	levelUp: string
	/** He is two or more levels down on the enemy jungler. */
	levelDown: string
	/** Two or more enemies are dead for long enough to use. */
	windowUse: string
	/** An objective is coming back and he is outnumbered on the map. */
	concede: string
	/** An objective is coming back and the numbers are not against him. */
	beforeObjective: string
	/** Gold is sitting unspent and there is a gap before the next objective. */
	back: string
}

/**
 * The answers available with no champion notes on file.
 *
 * Role fundamentals only — camps, tempo, objectives, death location. Never a claim about a kit,
 * a spike or a clear, which is the same rule `knowledge/champions/_default.md` states for the
 * review coach. Improvising champion knowledge to fill the gap is inventing, exactly as much as
 * inventing a number is.
 */
export const DEFAULT_PLAYBOOK: Playbook = {
	champion: "",
	behindPace: "finish your clear before you look at a lane",
	aheadPace: "keep the route running and take the free side camps",
	junglerDown: "his camps are free — take them and be back on your own side before he is",
	junglerDownFarm: "take your own camps at full speed while he cannot contest them",
	levelUp: "this is the fight he cannot answer, so look for it",
	levelDown: "do not take the even duel — farm through it",
	windowUse: "take the objective or their camps now, not a fight you have to walk to",
	concede: "give it up and take the camps on the far side instead",
	beforeObjective: "be at the pit with your camps already done, not walking to it",
	back: "back now and be there with it spent"
}

/**
 * Per-champion overrides.
 *
 * Only `lillia` today, because she is the champion on record in every game — and a wrong entry is
 * worse than a missing one, since the default is honest role coaching rather than silence.
 */
const PLAYBOOKS: Record<string, Playbook> = {
	/*
	 * From `knowledge/champions/lillia.md` (patch 16.17, op.gg jungle-paths + jungler.gg).
	 *
	 * The three claims used here, all stated there: her clear accelerates as it chains, so a
	 * BROKEN route costs her more than a slow one; she is weak in an early even fight and farming
	 * through it is correct play; the ultimate wants the passive already applied, so it rewards
	 * poking a target first rather than opening with it.
	 */
	lillia: {
		...DEFAULT_PLAYBOOK,
		champion: "Lillia",
		behindPace: "finish the route before you look at a lane — the back half of her clear is the fast half",
		aheadPace: "keep the route running and take the free side camps instead of forcing a duel",
		levelUp: "look for the pick, and poke first so the passive is already on before you ult",
		levelDown: "do not take the even duel — farm through it, she wins the long game not the coin flip",
		concede: "give it up and take the camps on the far side instead — you move faster than they do"
	}
}

/** The table for a champion, falling back to role-only fundamentals. Never null. */
export const playbookFor = (championName: string | null | undefined): Playbook =>
	PLAYBOOKS[key(championName ?? "")] ?? DEFAULT_PLAYBOOK
