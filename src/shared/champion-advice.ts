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
 *
 * ## Several clauses per kind, and why the rotation is not on the clock
 *
 * One fixed clause per kind means the identical half-sentence every single time that kind fires,
 * and the farm kind fires four or five times in a game. That sameness is the thing the player
 * quit on: nine lines in four minutes, six of them about farm, each true and each the same shape.
 *
 * So a file may offer SEVERAL clauses per kind and they are rotated. The rotation index is the
 * COUNT OF FIRINGS OF THAT KIND, carried in an `AdviceCursor` the caller owns — deliberately not
 * the game clock. A clock-derived index was tried and measured wrong: `Math.floor(secs / 60) % 3`
 * against `FARM_COOLDOWN_SEC = 180` lands every firing on the same residue, so over a real game
 * the farm kind fired at 8:00, 11:00 and 14:00 and said the SAME clause three times while a third
 * variant was never spoken at all. A rotation whose period shares a factor with the cooldown does
 * not rotate; it just looks like it does. `champion-advice.test.ts` simulates that exact game and
 * asserts both halves of it.
 *
 * ## How the cursor is advanced without `live-facts.ts` knowing about it
 *
 * `buildFacts` reads `input.advice?.[kind]` at exactly the moment a fact of that kind is rendered
 * into a line, and nowhere else — that read IS the firing. `rotatingAdvice` therefore returns a
 * VIEW whose properties are getters: reading one picks the next clause for that kind and advances
 * the shared cursor. The view is built fresh for each `buildFacts` call and memoises within
 * itself, so a kind advances at most once per turn no matter how many times it is read (the death
 * kind is read twice — once in its guard, once in its body — and one firing must cost one step).
 *
 * That keeps the whole mechanism inside this file: the ranker is untouched, and a caller that
 * passes no cursor gets a plain object of first clauses, byte-identical to the old behaviour.
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
	"farm-behind",
	/*
	 * The two kinds the ranker gained when it stopped being starved.
	 *
	 * Both name a fact the client settles and neither can supply its own instruction: "Baron has
	 * been standing for two minutes" and "three of your five deaths are Briar" are true, off his
	 * screen, and say nothing about what to do in the next thirty seconds. That gap is what a
	 * clause is for, and it is why it must stay digit-free — the number is the client's half.
	 */
	"objective-uncontested",
	/*
	 * TWO KINDS, not one, and the split is the difference between advice that fits and advice that
	 * reads as a non sequitur. "Three of your five deaths are Briar" wants a boundary he can hold
	 * himself; "Briar has killed your Urgot six times" wants a place he should go and cover. One
	 * shared rotation produced *"Briar has killed your Urgot 5 times — stop taking that one alone"*,
	 * which is addressed to the wrong person.
	 */
	"nemesis",
	"matchup"
] as const

export type AdviceKind = (typeof ADVICE_KINDS)[number]

/**
 * One clause per kind — what `buildFacts` consumes.
 *
 * The shape never changed, which is why the ranker did not have to. What changed is that the
 * string on the other side of the key may now be chosen fresh each turn.
 */
export type ChampionAdvice = Partial<Record<AdviceKind, string>>

/** Every clause a file offers for each kind, in the order it wrote them. */
export type ChampionClauses = Partial<Record<AdviceKind, string[]>>

/** Anything with a digit in it is a claim about the game, and claims come from the client. */
const HAS_DIGIT = /\d/

/**
 * A line in the section that is TRYING to be a clause: one lowercase token, a colon, some text.
 *
 * Deliberately narrower than "contains a colon", because the prose around the clauses contains
 * colons too ("Kept deliberately plain: a generic clause that fits any jungler"). A single
 * hyphenated lowercase token before the colon is the clause shape and nothing else in these files
 * looks like it. `champion-advice.test.ts` uses the same rule against the SHIPPED files to prove
 * that every line which looks like a clause actually loaded — knowledge the parser silently drops
 * is worse than no knowledge, because it reads as progress.
 */
export const CLAUSE_LINE = /^[-*]?\s*([a-z][a-z_-]*)\s*:\s*(.*)$/

/**
 * Read EVERY clause in the `## Live coaching` block of a champion note, per kind.
 *
 * Forgiving by design — the file is edited by hand between games — but strict about the one thing
 * that matters. A malformed line costs one clause; a clause with a number costs nothing because it
 * never loads. An exact duplicate is dropped, because two identical variants in a rotation is a
 * rotation that stutters.
 */
export const parseChampionClauses = (markdown: string): ChampionClauses => {
	const out: ChampionClauses = {}
	const start = markdown.indexOf("## Live coaching")
	if (start < 0) return out
	const rest = markdown.slice(start)
	// Stops at the next heading, so the section cannot swallow the rest of the file.
	const end = rest.indexOf("\n## ", 1)
	const body = end < 0 ? rest : rest.slice(0, end)

	for (const raw of body.split("\n")) {
		const line = raw.trim()
		if (line === "" || line.startsWith("#")) continue
		const m = CLAUSE_LINE.exec(line)
		if (!m) continue
		const key = m[1] as AdviceKind
		const clause = m[2]!.trim()
		if (!ADVICE_KINDS.includes(key)) continue
		if (clause === "" || HAS_DIGIT.test(clause)) continue
		const list = (out[key] ??= [])
		if (!list.includes(clause)) list.push(clause)
	}
	return out
}

/** The first clause of each kind — the whole surface, before rotation existed. */
export const firstOf = (clauses: ChampionClauses): ChampionAdvice => {
	const out: ChampionAdvice = {}
	for (const kind of ADVICE_KINDS) {
		const first = clauses[kind]?.[0]
		if (first !== undefined) out[kind] = first
	}
	return out
}

/**
 * The old surface, unchanged: one clause per kind, first one wins.
 *
 * Still exported and still the default, so any caller that has not been taught about rotation
 * behaves exactly as it did.
 */
export const parseChampionAdvice = (markdown: string): ChampionAdvice =>
	firstOf(parseChampionClauses(markdown))

/**
 * Layer champion clauses over the role defaults, PER KIND.
 *
 * This is the fix for a bug that made having a champion file strictly worse than having none:
 * `championNote()` only falls back to `_default.md` when NO file matches, so a champion file
 * without a `## Live coaching` section — which was true of three of the four shipped files —
 * turned champion advice off entirely for that champion rather than falling back to the role
 * advice. Merging per kind means a file can say nothing about deaths and still get the role's
 * death clause.
 *
 * A kind is OVERRIDDEN rather than appended to. A specific clause diluted by a generic one in the
 * same rotation is a coach that says the useful thing every other time.
 */
export const mergeClauses = (...layers: ChampionClauses[]): ChampionClauses => {
	const out: ChampionClauses = {}
	for (const layer of layers)
		for (const kind of ADVICE_KINDS) {
			const list = layer[kind]
			if (list && list.length > 0) out[kind] = [...list]
		}
	return out
}

/**
 * How many times each kind has fired this game. The rotation index, and nothing else.
 *
 * Owned by the caller and reset on the same boundary as `FactMemory`, so game two does not
 * inherit game one's place in the rotation.
 */
export interface AdviceCursor {
	fired: Partial<Record<AdviceKind, number>>
}

export const newAdviceCursor = (): AdviceCursor => ({ fired: {} })

export const resetAdviceCursor = (cursor: AdviceCursor): void => {
	cursor.fired = {}
}

/**
 * A per-turn view of the clauses, which rotates as it is read.
 *
 * Build one per `buildFacts` call and hand it in as `input.advice`. With no cursor this is
 * `firstOf` and there is no rotation at all — the pre-rotation behaviour, for callers that have
 * no notion of a game to count firings within.
 */
export const rotatingAdvice = (clauses: ChampionClauses, cursor?: AdviceCursor): ChampionAdvice => {
	if (!cursor) return firstOf(clauses)
	const view: ChampionAdvice = {}
	/*
	 * Memoised for the life of this view, i.e. for one turn.
	 *
	 * `buildFacts` reads `advice.death` twice for a single death — once to decide whether there is
	 * anything to say, once to say it — and the build kind is read once per newly completed item.
	 * One firing must cost one step of the rotation, so the second read of a turn returns what the
	 * first one picked.
	 */
	const picked: Partial<Record<AdviceKind, string>> = {}
	for (const kind of ADVICE_KINDS) {
		const list = clauses[kind]
		if (!list || list.length === 0) continue
		Object.defineProperty(view, kind, {
			enumerable: true,
			configurable: true,
			get: () => {
				const already = picked[kind]
				if (already !== undefined) return already
				const n = cursor.fired[kind] ?? 0
				cursor.fired[kind] = n + 1
				const clause = list[n % list.length]!
				picked[kind] = clause
				return clause
			}
		})
	}
	return view
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
