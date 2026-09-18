/**
 * The COMPLETE champion + role knowledge, for the full-knowledge live coach. NODE ONLY.
 *
 * ## What this used to be, and why it changed on 2026-09-18
 *
 * It read `knowledge/champions/<champion>.md` off disk and pasted the prose whole into the system
 * instruction. Those files were written by a model in a night, they had one provenance header each,
 * and nothing anywhere could tell a sourced sentence from an invented one — `lillia.md` cited
 * "op.gg jungle-paths (16.17)", an endpoint that does not exist and was probed three ways.
 *
 * It was measurably wrong where it mattered most. `lillia.md` said Swirlseed "rolls over terrain,
 * and grants vision of what it rolls past". Riot's own tooltip says the seed "rolls until it hits
 * an enemy or collides with terrain" and the wiki says it "detonates upon hitting an enemy or
 * terrain while on the ground", revealing only the enemies caught in the cone and only for two
 * seconds. That one clause licensed 38% of the champion-specific lines this coach has ever spoken.
 *
 * So the prose is gone and this loader renders the FETCHED table instead, through
 * `knowledge/champion-brief.ts`, which mints one line per claim with that claim's own URL, wiki
 * revision and fetch date in the line. Nothing reaches the model that a source did not say.
 *
 * ## What that costs, honestly
 *
 * Routes, gank conditions, clear tempo, spike timing and what an item purchase implies were roughly
 * half of what those files said, and no source publishes any of it. Those sections do not come back
 * in another form; they are simply absent, and a coach with less to say about a kit is the correct
 * trade against a coach confidently wrong about one. The measurement says the trade is close to
 * free on this path: withholding the champion file entirely moved the live coach by +1.1 points
 * [-2.1, +4.2], p = 0.547, over about 1,730 blind-judged lines.
 *
 * The one channel that can still carry judgment is HIS: `knowledge/owner/<champion>.md`, rendered
 * under a heading that says it has no source. He is the only person in this system who knows
 * whether a route is right.
 *
 * ## It still goes in the SYSTEM INSTRUCTION, once
 *
 * Unchanged, and it is why size is not the constraint here. Gemini Live is a socket whose system
 * instruction is sent at setup, so static context costs the measured latency advantage (p50 1.15s)
 * nothing per turn. Accuracy is the constraint, which is the whole reason for the rewrite.
 *
 * ## The role file is the one piece of prose left, and it is named as such
 *
 * `knowledge/general/jungle.md` is not champion knowledge — it is role judgment, true whoever he
 * locked in, and no endpoint publishes it either. It is still model-authored and it is still
 * unsourced, so it is labelled that way in the block rather than left to read like the fetched
 * lines above it. Deleting it is a live option; it is kept because nothing in it is a claim about a
 * champion, which is the class of error that was actually measured.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { KNOWLEDGE_DIR } from "../knowledge/index.ts"
import { championBriefSync } from "../knowledge/champion-brief.ts"

/** Everything before the first `\n---` is the file's own provenance header, not coaching prose. */
const stripHeader = (raw: string): string => {
	const split = raw.indexOf("\n---")
	return (split === -1 ? raw : raw.slice(split + 4)).trim()
}

/** Every heading drops one level, so the section heading this module adds is the file's top. */
const demoteHeadings = (text: string): string => text.replace(/^(#+)(\s)/gm, "#$1$2")

/** The role file, or `null`. Missing is a normal state; the coach still coaches. */
const readRole = (): string | null => {
	try {
		const text = demoteHeadings(stripHeader(readFileSync(join(KNOWLEDGE_DIR, "general", "jungle.md"), "utf8")))
		return text === "" ? null : text
	} catch {
		return null
	}
}

/**
 * The line that says what the role section is, because the two halves of this block have completely
 * different warrants and a reader who cannot tell them apart will weight them the same.
 */
const ROLE_CAVEAT =
	"NOT FETCHED, unlike everything above it. This section is general jungle judgment written for " +
	"this app; no site publishes it and no source backs it. It is about the ROLE and says nothing " +
	"about any champion's kit. Where it disagrees with a fetched line above, the fetched line wins."

/**
 * The champion's fetched section, as it goes under a heading here. `null` when nothing is on file.
 *
 * `edgeCases` is the one budget decision in this module and it is asymmetric on purpose. HIS
 * champion gets everything, notes included, because every line the coach speaks is about the
 * champion he is playing and the wiki's interaction notes are the layer that decides whether such a
 * line is true. The COUNTERPART gets the same facts without the notes: that section is 60% notes by
 * weight (20,018 of Briar's 34,121 characters), it is measured inert on both paths — 0.13% of 5,347
 * live lines mention it at all — and what a coach needs about the man being raced is his kit and his
 * numbers, not whether his W applies proc damage. Dropping lines can only make the coach know less;
 * it cannot make it wrong, which is why a budget switch is allowed to exist here at all.
 */
const briefFor = (champion: string, edgeCases: boolean): string | null => {
	if (champion === "") return null
	const brief = championBriefSync(champion, { edgeCases })
	return brief ? demoteHeadings(brief.text.trim()) : null
}

/**
 * The complete knowledge block for one game: his champion, the enemy jungler's, and the role file.
 *
 * Concatenated under headings the model can navigate, in the order it should weight them — his own
 * champion first, because that is the one every line is about. The headings are unchanged from the
 * prose era on purpose: `compare-arms.ts` withholds sections by name to measure what each is worth,
 * and renaming them would silently retire those arms.
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

	const own = briefFor(opts.champion, true)
	if (own) parts.push(`# YOUR CHAMPION: ${opts.champion}\n\n${own}`)

	// The counterpart's section is loaded only when the client has actually told us who he is;
	// guessing a counterpart would put a whole matchup section in the prompt about a champion who is
	// not in the game.
	const vs = opts.counterpart ? briefFor(opts.counterpart, false) : null
	if (vs) parts.push(`# THE ENEMY JUNGLER: ${opts.counterpart}\n\n${vs}`)

	const general = opts.role === false ? null : readRole()
	if (general) parts.push(`# THE ROLE\n\n${ROLE_CAVEAT}\n\n${general}`)

	return parts.join("\n\n---\n\n")
}
