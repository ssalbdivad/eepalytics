/**
 * The champion's own knowledge, loaded for the live coach. NODE ONLY.
 *
 * `shared/live-coach-mode.ts` deliberately cannot do this itself: it is imported by the browser
 * socket in `web/lib/geminiLive.ts`, so it may not touch the filesystem. It renders clauses; this
 * finds them.
 *
 * ## Why the live coach needs a second door for this
 *
 * The FENCED coach receives champion knowledge through the ranked list — `withAdvice` glues a
 * clause onto a fact that `buildFacts` already decided to offer, so the knowledge only ever speaks
 * once the client has established the situation. That is the mechanism that stops
 * *"Viego is your jungle counterpart so watch for his ganks"*: prose in a prompt has nothing tying
 * it to the moment.
 *
 * CITE-OR-QUIET has no ranked list to hang a clause on, so the clauses go in the prompt. What
 * keeps that safe is not the delivery, it is the PARSER: `parseChampionClauses` refuses any clause
 * containing a digit, so nothing that arrives this way can become a number. It can shape the fix
 * and it cannot become a claim. This is the same text the ablation's unfenced arms were given, and
 * they fabricated nothing in 132 spoken lines.
 *
 * ## No `_default.md` merge, on purpose
 *
 * `buildLiveState` merges the role defaults UNDER the champion's clauses, per fact kind, because a
 * champion file that says nothing about deaths would otherwise leave the fenced coach with nothing
 * to say about deaths. That merge is a property of the LIST — it exists so that every fact KIND
 * still finds a clause. There are no kinds here; there is one block of prose. Matching the arm
 * that was actually measured is worth more than the extra sentences, and
 * `live-coach-knowledge.test.ts` asserts the two are byte-identical.
 */

import { championNote } from "../knowledge/index.ts"
import { parseChampionClauses } from "../shared/champion-advice.ts"
import { renderChampionKnowledge } from "../shared/live-coach-mode.ts"

/**
 * The digit-free clauses for a champion, rendered for the prompt, or `""`.
 *
 * Empty is the normal case and not a failure: a champion with no note gets a coach that reasons
 * from the block alone, which is what it did for this app's whole life.
 */
export const liveChampionKnowledge = (championName: string): string => {
	const note = championNote(championName)
	// `isDefault` means no file matched this champion — the measured arm found nothing there either.
	if (!note || note.isDefault) return ""
	return renderChampionKnowledge(championName, parseChampionClauses(note.text))
}
