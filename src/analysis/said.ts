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
	{ id: "downed", re: /\b(is down|are down|down for|dead for|respawn|is dead)\b/i },
	{ id: "objective-lost", re: /\b(they took|enemy took|just took|gone|lost the)\b.{0,24}\b(drake|dragon|baron|herald|grub|tower|turret)\b/i },
	{ id: "objectives", re: /\b(drake|dragon|baron|nashor|herald|grub|scuttle|tower|turret|inhibitor|plate|pit)\b/i },
	{ id: "fight", re: /\b(fight|trade|skirmish|teamfight|duel|collapse|dive|killed|kill|first blood|died)\b/i },
	{ id: "gold", re: /\bgold\b|\b(recall|back and buy|shop|spend)\b/i },
	{ id: "farm", re: /\b(cs|farm|camps?|clear|route|gromp|wolves|raptors|krugs|buff|jungle)\b/i },
	{ id: "levels", re: /\blevel\b/i },
	{ id: "build", re: /\b(item|build|component|finish(?:ed)?)\b/i },
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

/** The instruction, stripped of everything that varies turn to turn. */
export const directiveKey = (line: string, champions: readonly string[] = []): string => {
	const action = actionClause(line)
	if (action === null) return ""
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
	subjectRetireCount: number
	subjectCooldownSec: number
}

export const SAID_LIMITS: SaidLimits = {
	wordingOverlap: 0.5,
	wordingLookbackSec: 240,
	directiveCooldownSec: 300,
	directiveBudget: 2,
	subjectRetireCount: 3,
	subjectCooldownSec: 90
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
	if (sameSubject.length >= limits.subjectRetireCount)
		return {
			repeat: true,
			reason: "subject-spent",
			of: sameSubject.at(-1) ?? null,
			why: `${now.subject} has had ${sameSubject.length} lines this game and is settled`
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
