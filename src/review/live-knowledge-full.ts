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
 * So the prose is gone and this module reads the COMMITTED context tree instead —
 * `knowledge/context/`, written by `scripts/generate-context.ts` out of the fetched table, one file
 * per champion and one per role, every line carrying its own URL, wiki revision and fetch date.
 * Nothing reaches the model that a source did not say, and nothing is rendered while the app runs:
 * this file is now a thin, kept-for-its-name wrapper over `knowledge/champion-context.ts`, whose
 * entire job is to read two files and join them.
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
 * `knowledge/context/roles/jungle.md` is not champion knowledge — it is role judgment, true whoever
 * he locked in, and no endpoint publishes it either. It is still model-authored and it is still
 * unsourced, so the file OPENS with the line saying so, rather than being labelled on the way past.
 * That move matters: a caveat added at runtime is a caveat nobody reviewing the repo ever sees.
 * Deleting it is a live option; it is kept because nothing in it is a claim about a champion, which
 * is the class of error that was actually measured. The other four roles have a file too, and each
 * one says there is nothing to say.
 */

import { composeKnowledge } from "../knowledge/champion-context.ts"
export { SECTION_HEADINGS } from "../knowledge/champion-context.ts"

/**
 * The complete knowledge block for one game: his champion, the enemy jungler's, and the role file.
 *
 * Every byte of this is now read off disk. `composeKnowledge` picks the files and joins them with
 * the three frozen headings, and this function survives as the name the rest of the app and the
 * arms in `compare-arms.ts` already call — retiring the name would retire the arm.
 *
 * The composition itself is unchanged and was verified byte for byte against the renderer it
 * replaced before the renderer left the runtime path.
 */
export const fullKnowledge = (opts: {
	champion: string
	counterpart?: string | null
	/*
	 * Whether the role file rides along. TRUE everywhere the app runs.
	 *
	 * It exists for one experiment and it is a BOOLEAN rather than a string for the same reason
	 * `champion` is a name: a caller may withhold a section that the app itself sometimes has no
	 * material for, and may not write one. The 2026-09-11 knowledge ablation could only withhold
	 * the two CHAMPION sections, because those are keyed by a name and an absent name is a state
	 * the client reaches on its own; the role file has no name to withhold, so measuring whether
	 * it buys anything needed this flag. Nothing in `src/` passes it.
	 */
	role?: boolean
}): string => composeKnowledge(opts)
