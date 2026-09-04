/**
 * Champion knowledge, attached to a fact the client already proved.
 *
 * ## The split, and why this is the only safe shape
 *
 * A line has two halves. The NUMBER half comes off the client and is exact: "Kayn is 23 CS up on
 * you". The ADVICE half is what a one-trick would tell you to do about it, and no client can
 * supply that — it is champion knowledge, and it is the entire difference between a dashboard and
 * a coach.
 *
 * The previous attempt at this shipped a general "benchmark" renderer and it breached the fence
 * within a day: the guard validated the FORM of a benchmark and never its SUBJECT, so a rule
 * meaning "his flash is usually back in thirty seconds" rendered and the socket spoke it aloud.
 * Summoner cooldowns are unknowable. The lesson is not "guard harder", it is that a mechanism
 * which can express a number about the game can express a WRONG number about the game.
 *
 * ## So advice may not contain a digit. At all.
 *
 * `parseChampionAdvice` REJECTS any clause containing a number, and there is no path around it.
 * That single rule kills the entire class:
 *
 *   accepted  "your clear accelerates as it chains, so finish the route you started"
 *   rejected  "a good Lillia has finished the route by 3:15"     (a benchmark about him)
 *   rejected  "his flash is back in 30 seconds"                  (unknowable)
 *
 * Every figure he hears still comes from the block, exactly as before. Knowledge shapes the fix
 * and never becomes a claim — the same rule the post-game reviewer has always followed, which
 * AGENTS.md states as "it shapes the fix, never the numbers".
 *
 * ## Keyed by what just happened
 *
 * Prose in a prompt produces generic truths — "Viego resets on takedowns, be careful" — because
 * nothing ties it to the moment. These clauses are looked up BY FACT KIND, so the champion note
 * only ever speaks when the client has already established the situation it is about.
 */

/** The situations a champion note may speak to. A closed set: unknown keys are ignored. */
export const ADVICE_KINDS = [
	"race-behind",
	"race-ahead",
	"restraint",
	"fight-lost",
	"fight-absent",
	"death",
	"build",
	"farm-behind"
] as const

export type AdviceKind = (typeof ADVICE_KINDS)[number]

export type ChampionAdvice = Partial<Record<AdviceKind, string>>

/** Anything with a digit in it is a claim about the game, and claims come from the client. */
const HAS_DIGIT = /\d/

/**
 * Read the `## Live coaching` block out of a champion note.
 *
 * Forgiving by design — the file is edited by hand between games — but strict about the one thing
 * that matters. A malformed line costs one clause; a clause with a number costs nothing because it
 * never loads.
 */
export const parseChampionAdvice = (markdown: string): ChampionAdvice => {
	const out: ChampionAdvice = {}
	const start = markdown.indexOf("## Live coaching")
	if (start < 0) return out
	const rest = markdown.slice(start)
	// Stops at the next heading, so the section cannot swallow the rest of the file.
	const end = rest.indexOf("\n## ", 1)
	const body = end < 0 ? rest : rest.slice(0, end)

	for (const raw of body.split("\n")) {
		const line = raw.trim()
		if (line === "" || line.startsWith("#")) continue
		const at = line.indexOf(":")
		if (at <= 0) continue
		const key = line.slice(0, at).trim().replace(/^[-*]\s*/, "") as AdviceKind
		const clause = line.slice(at + 1).trim()
		if (!ADVICE_KINDS.includes(key)) continue
		if (clause === "" || HAS_DIGIT.test(clause)) continue
		if (out[key] === undefined) out[key] = clause
	}
	return out
}

/**
 * Attach the advice to a fact, as one sentence.
 *
 * The number leads, because it is the part that is checkable and the part he cannot see. The
 * advice follows, because it is the part he can act on. If there is no note for this champion the
 * fact is returned untouched — a coach with no champion knowledge says the true thing plainly,
 * which is what it has always done.
 */
export const withAdvice = (fact: string, clause: string | undefined): string => {
	if (!clause) return fact
	let trimmed = fact.replace(/[.\s]+$/, "")
	/*
	 * Some facts already END on a generic instruction — the fight module's lines close with "so
	 * back off and catch up". Appending champion advice to those gives two instructions in one
	 * breath: "that fight was 0 for 2 without you, so back off and catch up — your case for
	 * existing is being somewhere they are not, so get on the map before the next one starts."
	 *
	 * The champion clause is the more specific of the two and it is the one worth keeping, so the
	 * generic tail is dropped when there is something better to put there. The FACT is never
	 * touched; only an instruction we are about to replace with a better instruction.
	 */
	const tail = trimmed.search(/,\s+so\s/)
	if (tail > 0) trimmed = trimmed.slice(0, tail)
	return `${trimmed} — ${clause}`
}
