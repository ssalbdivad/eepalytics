/**
 * Champion knowledge for the LIVE coach: what goes in, and when it is sent.
 *
 * ## Why the live coach had none
 *
 * `knowledge/champions/*.md` has existed for the whole life of the review path — `review/watch.ts`
 * loads it, `shared/matchup-prompt.ts` loads it for champ select — and the live coach loaded
 * nothing. So mid-game she could only read facts back, which is the failure the owner named:
 * *"analysis is way too shallow and useless stuff i can see in the game"*.
 *
 * ## WHERE it goes, and the trade-off that decided it
 *
 * There are two places a static block of text can live in a Gemini Live session:
 *
 * 1. **`systemInstruction`, at socket setup.** Sent once, never re-billed per turn, and the model
 *    treats it as standing instruction rather than as this turn's input. It is the obviously
 *    cheaper option and it is the wrong one here, for a reason that is structural rather than
 *    aesthetic: **the socket is opened at champion select** (see `web/components/ScreenCoach.tsx`
 *    — setup and the token mint are deliberately paid for during the draft so she is live before
 *    the loading screen ends), and at that instant :2999 answers nothing at all. There is no
 *    roster, no champion and no counterpart to look up. Filling `systemInstruction` would mean
 *    either coaching without notes for the first game, or tearing the socket down and rebuilding
 *    it once the champions are known — dropping a live connection mid-clear to deliver a document
 *    that could simply have ridden along with the next turn.
 *
 * 2. **The per-turn ground-truth block.** Fresh, always correct about who is actually in the
 *    game, and it costs tokens on every turn it appears in.
 *
 * So: the per-turn block, but **sent on one turn in every N**, not on all of them. The two notes
 * run about 4 KB together — roughly a thousand tokens against a turn that is otherwise a JPEG and
 * half a kilobyte of facts. At a 20-second heartbeat that is ~90 turns in a thirty-minute game,
 * and paying it every turn would roughly double the text budget of the whole feature to re-send a
 * document that has not changed since the loading screen.
 *
 * ## Why it is re-sent at all, rather than exactly once
 *
 * Two reasons, one certain and one hedged.
 *
 * - **Certain: a reconnect is a new context.** The token expires after about thirty minutes and
 *   the ladder in `geminiLive.ts` mints another and reconnects — mid-game, by design. The new
 *   socket knows nothing about what the old one was told. That is why the caller passes a session
 *   id that changes on every completed setup rather than the daemon assuming one game is one
 *   context.
 * - **Hedged: Live sessions slide their context window.** Long sessions drop the oldest turns, and
 *   a dossier that has been evicted looks exactly like a dossier that is working — the coach just
 *   quietly goes back to generic. I could not measure the eviction point, so this re-sends every
 *   `KNOWLEDGE_REFRESH_SEC` of game clock, which costs about three extra insertions per game and
 *   removes a silent failure mode. If someone later measures that the window holds, raising this
 *   constant is the whole change.
 *
 * ## The fence, unchanged
 *
 * Same rule as `review/prompt.ts` and `shared/matchup-prompt.ts`: notes shape the JUDGEMENT and
 * never become a number, a timer, an event or a claim about what happened. Numbers come from the
 * client-derived block only. What is new here is the second test — see `renderKnowledge` — because
 * knowledge without it makes the output *worse*, not better.
 *
 * PURE and browser-safe. The reading of markdown off disk is `knowledge/index.ts` (node only).
 */

/** One champion's notes, already loaded and stripped of front matter. */
export interface LiveNote {
	champion: string
	text: string
}

/** How the enemy jungler was identified — `analysis/live-roles.ts` decides, this only says it. */
export type LiveJunglerBasis = "position" | "smite"

export interface LiveKnowledge {
	myChampion: string
	/** Notes for his champion, or null when `knowledge/champions/` has none for it. */
	mine: LiveNote | null
	enemyJungler: { champion: string; basis: LiveJunglerBasis } | null
	/** Notes for the enemy jungler, or null. */
	theirs: LiveNote | null
}

/** Game-clock seconds between re-insertions of the dossier. See the header for why it re-sends. */
export const KNOWLEDGE_REFRESH_SEC = 480

/** What the daemon remembers about what a given socket has already been told. */
export interface BriefLedger {
	sessionId: string
	/** `"Lillia vs Trundle"` — a champion swap between games must re-brief. */
	pair: string
	atClockSec: number
}

/** The pair key. Exported so the caller cannot spell it differently from `shouldBrief`. */
export const knowledgePair = (k: LiveKnowledge): string =>
	`${k.myChampion} vs ${k.enemyJungler?.champion ?? "unknown"}`

/**
 * Does THIS turn carry the dossier?
 *
 * A fresh session id, a different champion pair, or a long-enough gap since the last insertion.
 * `last` is whatever the daemon recorded for the previous turn, or null at the very start.
 */
export const shouldBrief = (
	last: BriefLedger | null,
	next: { sessionId: string; pair: string; clockSec: number }
): boolean =>
	last === null ||
	last.sessionId !== next.sessionId ||
	last.pair !== next.pair ||
	/*
	 * `>=` against an absolute difference: the game clock only goes forward within a session, but
	 * a new game starts it again at zero, and a coach that refuses to brief because "the clock went
	 * backwards" is a coach with no notes for a whole game.
	 */
	Math.abs(next.clockSec - last.atClockSec) >= KNOWLEDGE_REFRESH_SEC

/**
 * The dossier section, or "" when there is nothing to say about either champion.
 *
 * The fence is restated here rather than only in the system prompt, and that is deliberate: this
 * text arrives in the same turn as the facts, minutes after the system prompt, and the rule that
 * matters most is the one sitting next to the material it governs.
 */
export const renderKnowledge = (k: LiveKnowledge): string => {
	if (!k.mine && !k.theirs) return ""

	const basis =
		k.enemyJungler === null ? ""
		: k.enemyJungler.basis === "position" ?
			`The client published his position, so **${k.enemyJungler.champion} is their jungler** — you may say so.`
		:	`Nobody declared a position this queue, so ${k.enemyJungler.champion} is their jungler on the strength of his Smite alone. Say "looks like", never assert it.`

	return `## How these two champions work — JUDGEMENT ONLY, never a number

This is editable markdown from \`knowledge/champions/\`. **Nothing in it was measured from this
game.** It exists to tell you what the facts above MEAN, and it is fenced hard:

- It shapes the decision. It never becomes a stat, a timer, an event, or a claim about what
  anybody is doing. Every figure you say still comes from the ground-truth block.
- If it disagrees with the block, **the block wins.**
- Absorb it. Never quote it, never attribute it, never say "the notes say".
- **Knowledge alone is not coaching.** "Viego resets on takedowns, so be careful in fights" is
  true, and it could have been said in any game he has ever played — that sentence is noise
  wearing a coach's voice. The same knowledge multiplied by the state in front of you is the
  product: *"Viego just ulted bot — no reset for 90 seconds, take his red now."* If your line
  does not need BOTH the note and today's facts, it is not worth saying.
${basis === "" ? "" : `\n${basis}\n`}
${
		k.mine ?
			`### ${k.mine.champion} — what he is playing\n\n${k.mine.text}`
		:	`### ${k.myChampion} — no notes on file\n\nThere are no notes for ${k.myChampion}. Coach the role and the numbers, and improvise nothing about the kit: inventing champion knowledge to fill the gap is the same failure as inventing a stat.`
	}

${
		k.theirs ?
			`### ${k.theirs.champion} — the jungler he is racing\n\nSame fence. This shapes what he should be wary of; it is never a claim about what that player is doing right now.\n\n${k.theirs.text}`
		: k.enemyJungler ?
			`### ${k.enemyJungler.champion} — no notes on file\n\nThere are no notes for ${k.enemyJungler.champion}. Say nothing about his kit, his clear or his spikes.`
		:	`### No enemy jungler identified\n\nNothing in the client says which of them is the jungler, so there is no counterpart to reason about. Do not guess one.`
	}`
}
