/**
 * How the coach should say a champion's name out loud.
 *
 * ## Why this exists
 *
 * The live coach speaks through a native-audio model: it pronounces the text it produces, and
 * champion names are mostly invented words. It says a great many of them wrongly — "insanely
 * wrong", in the player's words — and a name he cannot recognise makes an otherwise correct
 * sentence useless, because he does not know who it is about.
 *
 * ## Respelling, not replacement
 *
 * The guide is given to the model as a SAY-IT-LIKE-THIS list; the model still writes the normal
 * spelling in its text. That keeps the on-screen transcript readable — "Kha'Zix", not "kah-ZIKS" —
 * while the audio comes out right. Substituting the respelling into the facts themselves would fix
 * the sound and corrupt the log, and the log is what makes the coach auditable.
 *
 * ## Only the names in this game
 *
 * The table has a hundred entries and the block is rebuilt every turn, so sending all of it would
 * be a hundred lines of tokens per turn to fix at most ten names. `pronunciationsFor` filters to
 * the roster, and to the roster's mispronounced half at that: a name with no entry is one the model
 * already says correctly, and silence about it is the correct instruction.
 *
 * Browser-safe: pure functions over data. The table itself is loaded from
 * `knowledge/pronunciations.md` by the daemon and handed in, so the player can correct a
 * respelling that sounds wrong without touching code.
 */

export interface Pronunciation {
	/** As the client spells it, and as the transcript should show it. */
	name: string
	/** As it should be said. Capitals mark the stressed syllable. */
	say: string
}

/**
 * Parse the editable markdown table.
 *
 * Deliberately forgiving: `Name = respelling`, anything else ignored. The file is meant to be
 * edited mid-session by someone who just heard a name mangled, so a stray heading, a blank line or
 * a note to self must never break the coach. A malformed line loses one pronunciation; a parser
 * that throws loses the whole game's audio.
 */
export const parsePronunciations = (markdown: string): Pronunciation[] => {
	const out: Pronunciation[] = []
	const seen = new Set<string>()
	for (const raw of markdown.split("\n")) {
		const line = raw.trim()
		if (line === "" || line.startsWith("#") || line.startsWith(">") || line.startsWith("-")) continue
		const at = line.indexOf(" = ")
		if (at <= 0) continue
		const name = line.slice(0, at).trim()
		const say = line.slice(at + 3).trim()
		// A respelling identical to the name teaches nothing and costs a line in every block.
		if (name === "" || say === "" || say === name) continue
		const key = name.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		out.push({ name, say })
	}
	return out
}

/**
 * The entries worth sending for one game's roster.
 *
 * Matching is case- and punctuation-insensitive because the client's spelling and a hand-edited
 * markdown file will not agree forever: "Kha'Zix" versus "KhaZix" versus "Kha'zix" should all find
 * the same row rather than silently sending nothing, which would look exactly like the feature
 * working.
 */
const key = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "")

export const pronunciationsFor = (
	names: readonly string[],
	table: readonly Pronunciation[]
): Pronunciation[] => {
	const wanted = new Set(names.map(key))
	const out: Pronunciation[] = []
	const used = new Set<string>()
	for (const p of table) {
		const k = key(p.name)
		if (!wanted.has(k) || used.has(k)) continue
		used.add(k)
		out.push(p)
	}
	return out
}

/** The line that goes in the block. Empty when every name in the game is already said correctly. */
export const renderPronunciations = (entries: readonly Pronunciation[]): string =>
	entries.length === 0 ?
		""
	:	`Say these names like this (write them normally, just pronounce them this way): ${entries
			.map(p => `${p.name} = ${p.say}`)
			.join(" · ")}`
