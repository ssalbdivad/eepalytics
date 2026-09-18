/**
 * The COMPLETE champion + role knowledge, for the full-knowledge live coach. NODE ONLY.
 *
 * ## Why this exists next to `live-coach-knowledge.ts` rather than replacing it
 *
 * The two shipped modes — `fenced` and `cite-or-quiet` — both deliver champion knowledge as
 * digit-free half-sentences keyed by fact kind, and that shape was measured: it is what those
 * arms were given, and their stored runs mean nothing if the input changes underneath them.
 * So nothing here touches them. This is a third door.
 *
 * ## What was measured, and what it cost
 *
 * `knowledge/champions/lillia.md` was 6800 characters. `liveChampionKnowledge("Lillia")` handed
 * the model 2566 of them, as 27 tagged fragments, because `parseChampionClauses` REJECTS any
 * clause containing a digit and keeps only the lines under `## Live coaching`. Every mana figure,
 * every route, every item, every "why" was stripped at load time. The `(kind)` tags then labelled
 * each fragment for the ranked-list mechanism, which the shipped mode no longer runs. The model
 * was receiving numberless half-sentences addressed to a machine that was not listening — which
 * is the whole answer to "why am I barely getting anything Lillia-specific".
 *
 * So: no clause parsing, no digit rejection, no fact-kind keying, no ranked list. The complete
 * prose goes in, and the model judges what is worth saying.
 *
 * ## It goes in the SYSTEM INSTRUCTION, once
 *
 * This text is static for a whole game — his champion, the counterpart's champion, the role file.
 * Gemini Live is a socket with a system instruction sent at setup, and the measured advantage of
 * that arm is latency (p50 1.15s against 2.05s for the next best and 7.9s for Gemini over HTTPS).
 * Static context sent once costs that latency nothing; the same bytes in every turn's payload
 * would cost it on every turn. Size is therefore not the constraint here — accuracy is.
 *
 * ## The one thing that IS filtered, and why
 *
 * A champion file may still carry a trailing `## Live coaching` section of tagged clauses, because
 * the two older modes read it and it must stay on disk byte-identical. Those lines are addressed
 * to a parser, not to a reader — `race-behind: your clear only gets faster...` in the middle of
 * prose is noise at best and a format instruction at worst. So everything from that heading
 * onward is dropped. That is a formatting cut, not a fence: nothing above it is filtered at all.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { KNOWLEDGE_DIR, championKey } from "../knowledge/index.ts"

/** Everything before the first `\n---` is the file's own provenance header, not coaching prose. */
const stripHeader = (raw: string): string => {
	const split = raw.indexOf("\n---")
	return (split === -1 ? raw : raw.slice(split + 4)).trim()
}

/** Every heading drops one level, so the section heading this module adds is the file's top. */
const demoteHeadings = (text: string): string => text.replace(/^(#+)(\s)/gm, "#$1$2")

/** See the note above: the tagged clause block belongs to the older modes' parser. */
const stripClauseSection = (text: string): string => {
	const at = text.search(/^##+\s*Live coaching\s*$/im)
	return at === -1 ? text : text.slice(0, at).trim()
}

/**
 * A knowledge file's prose, or `null` when it is not on disk.
 *
 * Missing is the normal case, not a failure — most champions have no file, and a coach with no
 * notes must still coach. Deliberately no `_default.md` fallback: that file is written as tagged
 * clauses for the ranked list, so falling back to it would put exactly the noise this module
 * exists to remove back into the prompt.
 */
const readKnowledge = (...segments: string[]): string | null => {
	try {
		const raw = readFileSync(join(KNOWLEDGE_DIR, ...segments), "utf8")
		const text = demoteHeadings(stripClauseSection(stripHeader(raw)))
		return text === "" ? null : text
	} catch {
		return null
	}
}

/**
 * The complete knowledge block for one game: his champion, the enemy jungler's, and the role file.
 *
 * Concatenated under headings the model can navigate, in the order it should weight them — his own
 * champion first, because that is the one every line is about.
 */
export const fullKnowledge = (opts: {
	champion: string
	counterpart?: string | null
	/*
	 * Whether `knowledge/general/jungle.md` rides along. TRUE everywhere the app runs.
	 *
	 * It exists for one experiment and it is a BOOLEAN rather than a string for the same reason
	 * `champion` is a name: a caller may withhold a section that the app itself sometimes has no
	 * material for, and may not write one. The 2026-09-11 knowledge ablation could only withhold
	 * the two CHAMPION sections, because those are keyed by a name and an absent name is a state
	 * the client reaches on its own; the role file has no name to withhold, so measuring whether
	 * it buys anything needed this flag. Nothing in `src/` passes it.
	 */
	role?: boolean
}): string => {
	const parts: string[] = []

	const own = opts.champion ? readKnowledge("champions", `${championKey(opts.champion)}.md`) : null
	if (own) parts.push(`# YOUR CHAMPION: ${opts.champion}\n\n${own}`)

	// The counterpart's file is loaded only when the client has actually told us who he is; guessing
	// a counterpart would put a whole matchup section in the prompt about a champion not in the game.
	const vs = opts.counterpart ? readKnowledge("champions", `${championKey(opts.counterpart)}.md`) : null
	if (vs) parts.push(`# THE ENEMY JUNGLER: ${opts.counterpart}\n\n${vs}`)

	const general = opts.role === false ? null : readKnowledge("general", "jungle.md")
	if (general) parts.push(`# THE ROLE\n\n${general}`)

	return parts.join("\n\n---\n\n")
}
