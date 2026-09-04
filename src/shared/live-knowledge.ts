/**
 * Champion knowledge for the LIVE coach — what he is playing, who he is against, and the fence.
 *
 * ## Why this exists at all
 *
 * The live coach had no knowledge source wired to it. Given ten champion names and nothing else,
 * it produced the SHAPE of coaching with nothing inside it — the line the user quoted back was
 * *"Viego is your jungle counterpart so watch for his ganks."* True in every game ever played,
 * which is another way of saying it is worth nothing. A gap does not produce silence; it produces
 * plausible filler, the same mechanism that made an earlier version invent farm baselines.
 *
 * ## The rule that makes knowledge safe here
 *
 * Knowledge is a MULTIPLIER on state, never a thing to say on its own:
 *
 *     generic   "Viego resets on takedowns, be careful in fights."
 *     specific  "Viego just ulted bot — no reset for 90 seconds, take his red now."
 *
 * The second sentence is only sayable because a fact in this turn's block met a fact about the
 * champion. Neither factor is worth saying alone. The prompt states that as a rule; this module
 * supplies the knowledge factor and `live-state.ts` supplies the state factor.
 *
 * ## WHERE IT GOES, and why it is not in the system prompt
 *
 * Three placements were possible and only one works:
 *
 *  1. **System prompt at socket setup.** Cheapest — one copy, never repeated. Impossible: the
 *     socket opens at ChampSelect (`ScreenCoach.tsx`), minutes before :2999 answers, so at setup
 *     time neither champion is known. Gemini Live cannot amend a system instruction after
 *     `setup`, so a placeholder there stays a placeholder for the whole game.
 *  2. **Every turn, inside the ground-truth block.** Freshest, and far too expensive. The two
 *     notes for his real matchup are 3,348 + 1,667 bytes, about 1.3k tokens. A Live session bills
 *     the ACCUMULATED context each turn, so re-sending them on a 20s heartbeat across a
 *     30-minute game adds ~1.3k of growth per turn and compounds in every turn after it — for
 *     text that cannot change, because nobody re-picks their champion mid-game.
 *  3. **Once per socket, on the first turn that has a game.** What this ships. The session keeps
 *     the thread, so it is said once and stays in context; it costs one turn's worth of tokens
 *     and it is sent at the first moment the champions are actually known. A reconnect opens a
 *     new session and re-sends it (`geminiLive.ts` clears the key on `setupComplete`).
 *
 * The per-turn block still carries the STATE half of every matchup line — who their jungler is,
 * his level against the player's — because that half genuinely changes every twenty seconds.
 *
 * PURE and browser-safe. Reading the markdown is `src/knowledge/index.ts` (NODE ONLY); this only
 * decides what the coach is told about it.
 */

import type { LivePlayer } from "./schema/live.ts"

export interface ChampionKnowledge {
	champion: string
	/** The note body, verbatim from `knowledge/champions/<key>.md`. */
	text: string
}

/**
 * How confident we are that this is really their jungler.
 *
 * `declared` is the live client's own `position` field, which the schema header flags as reliable
 * — unlike `timeline.lane` from match history, which mislabels 4 of 10 players. `smite` is the
 * fallback for queues where nobody declares a position, and is the same inference
 * `analysis/roles.ts` uses (exactly one Smite holder per team in 44/44 team-games measured).
 */
export type CounterpartBasis = "declared" | "smite"

export interface LiveKnowledge {
	/** Notes for the champion he is playing, or null when none are on file. */
	me: ChampionKnowledge | null
	/** Notes for the enemy jungler, or null when he could not be identified or has none. */
	counterpart: (ChampionKnowledge & { basis: CounterpartBasis }) | null
}

export interface Counterpart {
	player: LivePlayer
	basis: CounterpartBasis
}

/**
 * The client's `position` as a word a coach would say, or undefined when it published none.
 *
 * Undefined rather than "unknown": an absent role tag is how the block tells the model it may not
 * name that champion's lane at all, and a printed "unknown" is a string a model will happily
 * reason around.
 */
export const spokenRole = (position: string | undefined): string | undefined =>
	position === "TOP" ? "top"
	: position === "JUNGLE" ? "jungle"
	: position === "MIDDLE" ? "mid"
	: position === "BOTTOM" ? "bot"
	: position === "UTILITY" ? "support"
	: undefined

const hasSmite = (p: LivePlayer): boolean => {
	const s = p.summonerSpells
	return [s?.summonerSpellOne?.displayName, s?.summonerSpellTwo?.displayName].some(
		n => (n ?? "").toLowerCase() === "smite"
	)
}

/**
 * The enemy jungler, or null.
 *
 * Null rather than a guess is the whole point: naming the wrong player as their jungler turns
 * every line built on top of it into a confident falsehood, and the coach's standing instruction
 * is that a wrong call costs more than ten missed good ones. Two enemies holding Smite (it
 * happens) is not an identification, so that returns null too.
 */
export const enemyJungler = (enemies: readonly LivePlayer[]): Counterpart | null => {
	const declared = enemies.filter(p => (p.position ?? "") === "JUNGLE")
	if (declared.length === 1) return { player: declared[0]!, basis: "declared" }
	const smiters = enemies.filter(hasSmite)
	if (smiters.length === 1) return { player: smiters[0]!, basis: "smite" }
	return null
}

/**
 * The one-off knowledge turn. Empty string when there is nothing on file for either champion,
 * which is the honest outcome: `knowledge/champions/` covers four champions today, and a coach
 * that says nothing about a kit she has no notes for is following the same rule the review path
 * already applies to `_default.md`.
 */
export const renderKnowledgePrimer = (k: LiveKnowledge): string => {
	if (!k.me && !k.counterpart) return ""
	return `## HOW THESE TWO CHAMPIONS WORK — background, sent once, NOT measured from this game

Everything in this message is general champion knowledge from notes on file. **None of it was
measured, none of it is a fact about this game, and none of it is a thing to say out loud on its
own.** No numbers here. No timings here. No claims about what anyone has done.

What it is for: turning a fact you are given later into a DECISION. A fact plus this knowledge is
advice. Either one alone is not.

- "Viego is your jungle counterpart so watch for his ganks" — worthless. True in every game ever
  played, sayable at any minute of any of them, and it tells him nothing he did not know in champ
  select. This is the exact line the player complained about. Never say its shape.
- "Viego just ulted bot — no reset for 90 seconds, take his red now" — worth interrupting for,
  because a fact from the block met the knowledge and came out as one decision.

Rules, and they are absolute:

- This never becomes a number, a timer, a stat, or a claim about what happened. Every figure you
  say still comes from the ground-truth block of the turn you say it in.
- If it disagrees with the block, **the block wins** and you drop the note.
- Absorb it. Never quote it, never attribute it, never say "the guide says".
- Never state any of it as a standing fact about a champion. If you cannot point at what is true
  RIGHT NOW that makes it matter, you have nothing to say.${
		k.me ?
			`\n\n### ${k.me.champion} — what he is playing\n\n${k.me.text}`
		:	`\n\n### His champion\n\nNo notes on file for the champion he is playing. Coach the role and the numbers, and say
nothing about his kit — improvising champion knowledge to fill the gap is the same failure as
inventing a stat.`
	}${
		k.counterpart ?
			`\n\n### ${k.counterpart.champion} — the enemy jungler${
				k.counterpart.basis === "smite" ?
					`\n\nNobody declared a position in this queue, so he was identified by **Smite alone**. That
inference has held in every game measured, but it is still an inference: if you build a line on
it, say "looks like their jungler" rather than asserting it.`
				:	""
			}\n\n${k.counterpart.text}`
		:	`\n\n### The enemy jungler\n\nNo notes on file for him, or he could not be identified at all. Say nothing about how he plays.`
	}`
}
