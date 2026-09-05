/**
 * What the coach has already said this game — the one thing it has never been able to see.
 *
 * PLACEHOLDER HEADER — rewritten once the sweep below is measured.
 */

import { normalizeNumbers } from "./coach-score.ts"
import type { FactSubject } from "./live-facts.ts"

export type SaidSubject = FactSubject | "other"

export const SAID_SUBJECTS: { id: SaidSubject; re: RegExp }[] = [
	{ id: "your-death", re: /\b(you (?:are |'re )?dead|you die|respawn in|you spawn|back up in)\b/i },
	{ id: "downed", re: /\b(is down|are down|down for|dead for|respawn)\b/i },
	{ id: "objective-lost", re: /\b(they took|enemy took|just took|gone|lost the)\b.{0,24}\b(drake|dragon|baron|herald|grub|tower|turret)\b/i },
	{ id: "objectives", re: /\b(drake|dragon|baron|nashor|herald|grub|scuttle|tower|turret|inhibitor|plate|pit)\b/i },
	{ id: "fight", re: /\b(fight|trade|skirmish|teamfight|duel|collapse|dive|kill(?:ed|ing|s)?|first blood|die[ds]?)\b/i },
	{ id: "gold", re: /\bgold\b|\b(recall|back and buy|shop|spend)\b/i },
	{ id: "farm", re: /\b(cs|farm|camps?|clear|route|gromp|wolves|raptors|krugs|buff|jungle)\b/i },
	{ id: "levels", re: /\blevel\b/i },
	{ id: "build", re: /\b(legendary|completed|bought|component|mythic|finished (?:his|her|their))\b/i },
	{ id: "kill-share", re: /\b(participation|kill share|involved in)\b/i },
	{ id: "praise", re: /\b(nice|great|lovely|beautiful|well done|love (?:it|that)|proud|there we go)\b/i }
]

const STOPWORDS = new Set(
	`a an and are as at be been before but by can cant cannot could did do does doing dont for from
	 get go got had has have he her here him his how i if in into is it its just like me more most
	 my no not now of off on once only or other our out over own re s so some still such t than
	 that the their them then there these they this those through to too up us very was we were
	 what when where which while who why will with would you your youre yours youve ll ve m d`
		.split(/\s+/)
		.filter(Boolean)
)

const clean = (line: string): string =>
	normalizeNumbers(line).toLowerCase().replace(/[’']/g, "'").replace(/[—–]/g, " — ")

const words = (text: string): string[] => text.split(/[^a-z0-9']+/).filter(Boolean)

export const contentWords = (line: string): string[] => [
	...new Set(words(clean(line)).filter(w => !STOPWORDS.has(w.replace(/'s$/, "")) && !/^\d+$/.test(w)))
]

const CLAUSE_BREAK = /\s+—\s+|\s*[,;:.]\s+|\s+so\s+|\s+then\s+|\s+but\s+|\s+while\s+/

const IMPERATIVES = `take start keep go get walk push back recall buy spend clear finish full stop
	don't dont never hold ward path route rotate contest give leave stay come move run drop hit
	smite steal cross farm reset use pick head grab commit answer avenge`
	.split(/\s+/)
	.filter(Boolean)

const LEADING_FILLER = ["so", "then", "and", "but", "or", "instead", "now", "just", "please", "maybe"]

/** The clause he is meant to ACT on: the first that opens on an instruction. */
export const actionClause = (line: string): string | null => {
	for (const c of clean(line).split(CLAUSE_BREAK)) {
		const ws = words(c).filter((w, i) => !(i === 0 && LEADING_FILLER.includes(w)))
		if (ws.length === 0) continue
		for (const head of ws.slice(0, 2)) if (IMPERATIVES.includes(head)) return c.trim()
	}
	return null
}

/** The clause that carries the CLAIM: everything before the action, or the whole line. */
export const premiseClause = (line: string): string => {
	const t = clean(line)
	const action = actionClause(line)
	if (action === null) return t
	const i = t.indexOf(action)
	const head = i > 0 ? t.slice(0, i).trim() : ""
	return head.length > 0 ? head : t
}

export const subjectOfSaid = (text: string): SaidSubject =>
	SAID_SUBJECTS.find(s => s.re.test(text))?.id ?? "other"

/**
 * Subjects whose FIRST appearance in a game is news by itself.
 *
 * An event either happened or it did not, so the first line about one cannot be a restatement. A
 * value in the snapshot — his farm, his level — is present on every single turn, so "the first
 * line about it" is a property of the coach's wording rather than of the game.
 */
export const NOVEL_SUBJECTS: readonly SaidSubject[] = [
	"fight",
	"objectives",
	"objective-lost",
	"downed",
	"your-death",
	"gold",
	"build",
	"kill-share"
]

/** EVERY subject the sentence touches, not just the one its premise is about. */
export const subjectsIn = (text: string): SaidSubject[] =>
	SAID_SUBJECTS.filter(s => s.re.test(text)).map(s => s.id)

/**
 * WHAT HE WAS TOLD TO DO, as an intent rather than as words.
 *
 * Measured, and this is the whole reason the key is not lexical: over the 38 lines Opus 5 spoke in
 * `data/eval/model-opus5.json`, the instruction "keep clearing" was given under 14 distinct head
 * phrasings — "keep route rolling", "keep route running", "start route don't", "take every camp",
 * "full route don't", "full clear start", "go straight next", "keep hitting raptors", "keep
 * unbroken", "so keep route", "so walk full", "get base start", "leave fountain", "grab leash
 * commit". A key built from the words counts fourteen different instructions. He heard one.
 *
 * First match wins, so the order is the specificity order: counter-jungling names a camp and is a
 * different decision from clearing your own, and it says "clear" in the same breath.
 */
export const DIRECTIVE_INTENTS: { id: string; re: RegExp }[] = [
	{ id: "recall", re: /\b(recall|reset|take the back|go back|back and buy|back,|\bback\b(?= and)|head back)/i },
	{ id: "buy", re: /\b(buy|spend|shop|purchase|pick up (?:a|an|your))\b/i },
	{ id: "objective", re: /\b(drake|dragon|herald|grub|baron|nashor|scuttle|pit|plate|tower|turret)\b/i },
	{ id: "ward", re: /\b(ward|vision|sweep|trinket)\b/i },
	{ id: "gank", re: /\b(gank|dive|collapse|rotate|go help|come (?:to|for)|pressure (?:top|mid|bot))\b/i },
	{ id: "counter-jungle", re: /\b(his|her|their|enemy)\b.{0,16}\b(jungle|camps?|blue|red|raptors|gromp|krugs|wolves)\b|\bcounter[- ]?jungle\b/i },
	{ id: "avoid", re: /\b(don'?t|do not|never|stop|avoid|stay (?:out|away|home)|leave (?:him|her|it) alone)\b/i },
	{ id: "keep-clearing", re: /\b(route|clear|camps?|farm|jungle|raptors|gromp|krugs|wolves|buff|leash)\b/i },
	{ id: "reposition", re: /\b(walk|guard|cover|hover|entrance|river|lane|mid|top|bot|side)\b/i },
	{ id: "fight", re: /\b(fight|trade|group|engage|take the|contest)\b/i }
]

/**
 * The instruction, stripped of everything that varies turn to turn.
 *
 * Falls back to the literal head words when no intent matches, so an instruction this vocabulary
 * has never seen still gets a memory rather than a blank one that collides with every other blank.
 */
export const directiveKey = (line: string, champions: readonly string[] = []): string => {
	const action = actionClause(line)
	if (action === null) return ""
	const intent = DIRECTIVE_INTENTS.find(d => d.re.test(action))
	if (intent) return intent.id
	const lower = new Set(champions.map(c => c.toLowerCase()))
	const ws = words(action).filter(w => !/^\d+$/.test(w) && !lower.has(w.replace(/'s$/, "")))
	const head = ws[0] ?? ""
	const rest = ws.slice(1).filter(w => !STOPWORDS.has(w.replace(/'s$/, "")))
	return [head, ...rest.slice(0, 2)].join(" ")
}

export interface SaidLimits {
	wordingOverlap: number
	wordingLookbackSec: number
	directiveCooldownSec: number
	directiveBudget: number
	subjectBudget: number
	subjectWindowSec: number
	subjectCooldownSec: number
	/** However novel a line's subject, this much shared wording is the same sentence. */
	verbatimOverlap: number
}

export const SAID_LIMITS: SaidLimits = {
	wordingOverlap: 0.5,
	wordingLookbackSec: 240,
	directiveCooldownSec: 300,
	directiveBudget: 2,
	subjectBudget: 3,
	subjectWindowSec: 300,
	subjectCooldownSec: 90,
	verbatimOverlap: 0.8
}

export interface SaidSnapshot {
	gold?: number
	cs?: number
	level?: number
	deaths?: number
}

export interface SaidLine {
	tSec: number
	line: string
	subject: SaidSubject
	/** Every subject the sentence touched, so novelty is asked of the whole line. */
	touched: SaidSubject[]
	directive: string
	content: string[]
	at: SaidSnapshot
}

export interface SaidMemory {
	lines: SaidLine[]
	champions: string[]
}

export const newSaidMemory = (champions: readonly string[] = []): SaidMemory => ({
	lines: [],
	champions: [...champions]
})

export const resetSaidMemory = (mem: SaidMemory, champions: readonly string[] = []): void => {
	Object.assign(mem, newSaidMemory(champions))
}

export const isSilent = (line: string): boolean => {
	const t = line.trim()
	return t === "" || /^pass\b/i.test(t)
}

const overlap = (a: readonly string[], b: readonly string[]): number => {
	if (a.length === 0 || b.length === 0) return 0
	const set = new Set(b)
	let shared = 0
	for (const w of a) if (set.has(w)) shared++
	return shared / Math.min(a.length, b.length)
}

export type SaidRepeat = "wording" | "directive" | "subject-spent" | null

export interface SaidVerdict {
	repeat: boolean
	reason: SaidRepeat
	/** The earlier line it restates, when there is one. */
	of: SaidLine | null
	why: string
}

export const analyseSaid = (mem: SaidMemory, line: string, tSec: number): SaidLine => ({
	tSec,
	line: line.trim(),
	subject: subjectOfSaid(premiseClause(line)),
	touched: subjectsIn(clean(line)),
	directive: directiveKey(line, mem.champions),
	content: contentWords(line),
	at: {}
})

export const judgeSaid = (
	mem: SaidMemory,
	line: string,
	tSec: number,
	limits: SaidLimits = SAID_LIMITS
): SaidVerdict => {
	if (isSilent(line)) return { repeat: false, reason: null, of: null, why: "said nothing" }
	const now = analyseSaid(mem, line, tSec)

	let worst = 0
	let worstOf: SaidLine | null = null
	for (const prev of mem.lines) {
		if (tSec - prev.tSec > limits.wordingLookbackSec) continue
		const sim = overlap(now.content, prev.content)
		if (sim > worst) {
			worst = sim
			worstOf = prev
		}
	}
	const verbatim = worst >= limits.verbatimOverlap && worstOf !== null
	const heard = new Set(mem.lines.flatMap(p => p.touched))
	const fresh = now.touched.filter(t => !heard.has(t) && NOVEL_SUBJECTS.includes(t))
	if (fresh.length > 0 && !verbatim)
		return { repeat: false, reason: null, of: null, why: `first line of the game about ${fresh.join(", ")}` }

	if (worst >= limits.wordingOverlap && worstOf)
		return {
			repeat: true,
			reason: "wording",
			of: worstOf,
			why: `${Math.round(worst * 100)}% of its content words are in a line said at ${worstOf.tSec} seconds`
		}

	if (now.directive !== "") {
		const same = mem.lines.filter(p => p.directive === now.directive)
		const last = same.at(-1)
		if (last && tSec - last.tSec <= limits.directiveCooldownSec)
			return {
				repeat: true,
				reason: "directive",
				of: last,
				why: `he was told "${now.directive}" ${Math.round(tSec - last.tSec)} seconds ago`
			}
		if (same.length >= limits.directiveBudget)
			return {
				repeat: true,
				reason: "directive",
				of: same.at(-1) ?? null,
				why: `he has been told "${now.directive}" ${same.length} times this game`
			}
	}

	const sameSubject = mem.lines.filter(p => p.subject === now.subject)
	const recent = sameSubject.filter(p => tSec - p.tSec <= limits.subjectWindowSec)
	if (recent.length >= limits.subjectBudget)
		return {
			repeat: true,
			reason: "subject-spent",
			of: recent.at(-1) ?? null,
			why: `${now.subject} has had ${recent.length} lines in the last ${Math.round(limits.subjectWindowSec / 60)} minutes`
		}
	const lastOnSubject = sameSubject.at(-1)
	if (lastOnSubject && tSec - lastOnSubject.tSec <= limits.subjectCooldownSec)
		return {
			repeat: true,
			reason: "subject-spent",
			of: lastOnSubject,
			why: `${now.subject} was raised ${Math.round(tSec - lastOnSubject.tSec)} seconds ago`
		}

	return { repeat: false, reason: null, of: null, why: "new" }
}

export const rememberSaid = (
	mem: SaidMemory,
	line: string,
	tSec: number,
	at: SaidSnapshot = {}
): SaidLine | null => {
	if (isSilent(line)) return null
	const entry = { ...analyseSaid(mem, line, tSec), at }
	mem.lines.push(entry)
	return entry
}
