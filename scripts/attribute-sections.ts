/**
 * WHICH PART OF THE PAYLOAD PRODUCED THE LINE.
 *
 * ## The question
 *
 * Every measurement this campaign has made asks whether a SPOKEN LINE was useful. None asks which
 * part of the ~10,000-character payload the line came out of. That matters because the payload is
 * not free: it is prompt tokens on every turn, it is latency, and it is the attention of a model
 * that has to read past a section before it reaches one that matters. A section that has never
 * produced a useful line in three thousand graded lines is a cost with no measured return.
 *
 * ## The instrument, and what it can and cannot see
 *
 * There is no model in this file. For every graded line it joins the line back to the exact payload
 * the coach was holding, cuts that payload into CHANNELS (a section, or a labelled group of lines
 * inside one), and attributes the line to channels three independent ways:
 *
 *  - **exclusive number provenance.** Every integer in the line is normalised with the shipped
 *    `normalizeNumbers` (so "twenty seconds" is 20) and looked up in each channel. A number that
 *    appears in EXACTLY ONE channel is exclusive evidence that the line read that channel. This is
 *    the strongest signal here and it is also the sparsest: most integers appear in four channels.
 *  - **phrase signature.** A channel is the only place in the payload where certain wording lives
 *    — the reach clause is the only source of "you can be there before it spawns", the baselines
 *    the only source of "your own average". Hand-authored, listed in `SIGNATURES`, auditable.
 *  - **subject.** What the sentence is ABOUT, by keyword. Independent of whether a number matched,
 *    so it covers the lines that carry no figure at all.
 *
 * **What it cannot see:** a line that draws on a channel without quoting anything exclusive to it
 * is invisible to provenance and visible only to subject. So a channel's exclusive-attribution
 * count is a FLOOR on its use, never a count of it, and the three views are reported separately
 * rather than added. A channel can also be USED WITHOUT BEING SPOKEN — the roster tables may be
 * what stops a line rather than what causes one, and nothing here measures a line that was not
 * said. Both limits are restated in the output.
 *
 * Usage:
 *   node --experimental-strip-types scripts/attribute-sections.ts \
 *     --pairs corpus.json=judged.json[,...] --out data/eval/section-yield-YYYYMMDD.json
 */

import { readFileSync, writeFileSync } from "node:fs"
import { blockFigures, championsNamed, normalizeNumbers, unitsAgree, wilson } from "../src/analysis/coach-score.ts"
import type { Figure } from "../src/analysis/coach-score.ts"

/* ======================================================= the channels */

/** A labelled slice of the payload: a whole section, or a group of lines inside one. */
export interface Channel {
	id: string
	/** Human label for the report. */
	what: string
	text: string
	chars: number
}

const NEXT_HEAD = "NEXT —"

/** Where the event log stops being the present and starts being history. */
export const EVENT_RECENT_SEC = 180

/** Split one NEXT objective bullet into the CLOCK half and the REACHABILITY half. */
const splitReach = (line: string): { clock: string; reach: string } => {
	/* `- Drake (bot side): up at 41:57, in 1m14s. Drakes: you 0, them 5. You: DEAD for 16s more …` */
	const at = line.indexOf(" You: ")
	if (at < 0) return { clock: line, reach: "" }
	return { clock: line.slice(0, at), reach: line.slice(at) }
}

export const channelsOf = (payload: string): Channel[] => {
	const out: Channel[] = []
	const add = (id: string, what: string, text: string) => {
		if (text.trim() === "") return
		const found = out.find(c => c.id === id)
		if (found) {
			found.text += "\n" + text
			found.chars = found.text.length
		} else out.push({ id, what, text, chars: text.length })
	}

	for (const section of payload.split("\n\n")) {
		const head = section.split("\n")[0] ?? ""
		if (head === "NOW") add("now", "NOW — the one-paragraph situation", section)
		else if (head.startsWith(NEXT_HEAD)) {
			for (const line of section.split("\n").slice(1)) {
				if (line.startsWith("You: ")) add("next.you", "NEXT: his own position + state line", line)
				else if (line.startsWith("WHERE ")) add("next.wherehe", "NEXT: where the counterpart is (usually: NOT KNOWN)", line)
				else if (line.startsWith("- Down right now")) add("next.down", "NEXT: who is dead right now", line)
				else if (line.startsWith("- ")) {
					const { clock, reach } = splitReach(line)
					add("next.objclock", "NEXT: objective clocks (up at / in Xs)", clock)
					add("next.reach", "NEXT: reachability — seconds from him to the pit", reach)
				} else add("next.counterpart", "NEXT: the counterpart's row, with its age", line)
			}
		} else if (head.startsWith("JOINS")) add("joins", "JOINS — kill participation, last fight", section)
		else if (head.startsWith("GAME CLOCK")) add("clock", "GAME CLOCK", section)
		else if (head.startsWith("YOU —")) add("you.table", "YOU — the full stat table", section)
		else if (head.startsWith("ENEMY JUNGLER")) add("cp.table", "ENEMY JUNGLER — the full counterpart table", section)
		else if (head.startsWith("YOUR TEAM")) add("team.ally", "YOUR TEAM roster", section)
		else if (head.startsWith("ENEMY TEAM")) add("team.enemy", "ENEMY TEAM roster", section)
		else if (head.startsWith("EVENT LOG")) {
			/*
			 * SPLIT BY AGE, because the tail is where this instrument lies to itself.
			 *
			 * The log is the densest source of digits in the payload — every line carries a clock
			 * and an age — so a naive "which channel uniquely owns this integer" test hands it
			 * credit for figures it had nothing to do with. Measured: of the 41 lines whose figure
			 * only the log carried, EVERY sampled one matched an age digit of an unrelated kill
			 * ("forty seconds" against `5m30s ago`). Units are required below; the age split is the
			 * second guard, and the old half is reported separately rather than dropped.
			 */
			for (const line of section.split("\n")) {
				if (!line.startsWith("- ")) continue
				const m = line.match(/^- \d+:\d\d \((?:(\d+)m)?(\d+)s ago\)/)
				const age = m === null ? 0 : (m[1] !== undefined ? Number(m[1]) * 60 : 0) + Number(m[2])
				if (age <= EVENT_RECENT_SEC) add("events.recent", `EVENT LOG, at most ${EVENT_RECENT_SEC}s old`, line)
				else add("events.old", `EVENT LOG, older than ${EVENT_RECENT_SEC}s`, line)
			}
		}
		else if (head.startsWith("WHAT CHANGED")) add("delta", "WHAT CHANGED SINCE THE LAST LOOK", section)
		else if (head.startsWith("THE GAME SO FAR")) add("narrative", "THE GAME SO FAR — accumulated narrative", section)
		else if (/^[A-Z' ]+, LAST SEEN/.test(head)) add("narrative.lastseen", "…, LAST SEEN — the counterpart's staleness block", section)
		else if (head.startsWith("WHAT YOU HAVE ALREADY SAID")) add("memory", "WHAT YOU HAVE ALREADY SAID — the anti-repetition memory", section)
		else if (head.startsWith("OBJECTIVES")) add("objectives", "OBJECTIVES — the map's schedule and its epistemics", section)
		else if (head.startsWith("HIS OWN BASELINES")) add("baselines", "HIS OWN BASELINES", section)
		else if (head.startsWith("WHAT THIS FEED IS")) add("feednotes", "WHAT THIS FEED IS — the feed's own properties", section)
		else add("other:" + head.slice(0, 24), "unclassified: " + head.slice(0, 40), section)
	}
	return out
}

/* ======================================================= phrase signatures */

/**
 * Wording that exists in exactly one channel of the payload and survives paraphrase into speech.
 *
 * Each entry is checked against the SPOKEN line. They are deliberately narrow: a signature that
 * fires on a common word would hand a channel credit for every line in the corpus.
 */
export const SIGNATURES: { channel: string; re: RegExp; why: string }[] = [
	{ channel: "next.reach", re: /\b(you (?:can|could|will) be there|seconds? (?:away|out) from|you'?re? (?:only )?\d+ ?s(?:ec|econds)? from|before it spawns|get there (?:in|before)|you are \d+s? from|walk(?:ing)? (?:there|over) (?:in|now)|arrive)/i, why: "only the reach clause joins him to a pit in seconds" },
	{ channel: "baselines", re: /\b(your (?:own )?(?:average|baseline|usual|norm)|you (?:usually|normally|average)|per[- ]game average|your season)/i, why: "only HIS OWN BASELINES carries an average" },
	{ channel: "memory", re: /\b(again|like I said|as I said|I (?:already )?(?:told|said)|earlier I|still)\b/i, why: "self-reference implies the said-list" },
	{ channel: "joins", re: /\b(kill participation|you (?:were|are) (?:not )?in \d+ of|last fight|that fight (?:bought|cost)|participation)/i, why: "only JOINS computes participation and the last trade" },
	{ channel: "delta", re: /\b(since (?:the )?last|in the last \d+ ?(?:s|sec|seconds|minute)|just (?:gained|lost|spent)|changed since)/i, why: "only WHAT CHANGED carries a since-last-look delta" },
	{ channel: "next.reach", re: /\bfrom (?:your|the) fountain\b/i, why: "the fountain leg exists only in the reach clause" },
	{ channel: "objectives", re: /\b(soul ?point|a soul is|elder)\b/i, why: "soul state is only in OBJECTIVES and the drake clock line" },
	{ channel: "team.enemy", re: /\b(their (?:top|mid|bot|adc|support)|enemy (?:top|mid|bot|adc|support)) /i, why: "only the enemy roster names their laners' state" },
	{ channel: "team.ally", re: /\byour (?:top|mid|bot|adc|support)\b/i, why: "only the ally roster names his laners' state" },
	{ channel: "you.table", re: /\b(ability haste|move ?speed|armou?r|magic resist|attack range|your (?:AP|AD)\b)/i, why: "the stat line exists nowhere else" },
	{ channel: "cp.table", re: /\b(ward score|his (?:flash|smite)|summoner spells?)\b/i, why: "ward score and spells are table-only" },
	{ channel: "feednotes", re: /\b(this feed|the client (?:does not|cannot)|not (?:in|knowable from) (?:this|the) (?:feed|payload)|I can'?t see)\b/i, why: "the epistemics come from the feed notes" },
	{ channel: "next.wherehe", re: /\b(where he is|you don'?t know where|nobody has seen|not been seen|unseen for)\b/i, why: "only the WHERE line states his position is unknown" }
]

/* ======================================================= subject classes */

const OBJ = /\b(drake|dragon|baron|nashor|herald|grub|voidgrub|scuttle|crab|soul|elder)\b/i

export const subjectOf = (text: string, cp: string | null, roster: readonly string[]): string[] => {
	const subs: string[] = []
	const t = text
	if (OBJ.test(t)) subs.push("objective")
	if (/\b(you (?:can|could) be there|seconds? away|before it spawns|you'?re \d+s from|get there)\b/i.test(t)) subs.push("reachability")
	if (cp !== null && championsNamed(t, [cp]).length > 0) subs.push("counterpart")
	if (/\b(level(?:s)? (?:up|\d)|out ?level|level with|lvl)\b/i.test(t)) subs.push("level")
	if (/\b(mana|hp|health|low on|full hp|heal)\b/i.test(t)) subs.push("own-resource")
	if (/\b(gold|back|recall|shop|buy|spend|item|build|component|legendary)\b/i.test(t)) subs.push("gold-items")
	if (/\b(dead|died|respawn|down for|corpse|died \d)\b/i.test(t)) subs.push("death-clock")
	if (/\b(cs|farm|camps?|clear|minion|wave)\b/i.test(t)) subs.push("farm")
	if (/\b(ward|vision|warded|blind)\b/i.test(t)) subs.push("vision")
	const others = championsNamed(t, roster.filter(r => r !== cp))
	if (others.length > 0) subs.push("roster")
	if (subs.length === 0) subs.push("none")
	return subs
}

/* ======================================================= the join */

interface Line {
	id: string
	arm: string
	windowId: string
	index: number
	rep: number
	atSec: number
	clock: string
	text: string
	verdict: string
	why?: string
}

interface Rec {
	arm: string
	windowId: string
	index: number
	rep: number
	payload?: string
	payloadChars?: number
	latencyMs?: number
	text?: string
	frameSent?: boolean
}

const key = (r: { arm: string; windowId: string; index: number; rep: number }) =>
	`${r.arm}|${r.windowId}|${r.index}|${r.rep}`

const digitsOf = (text: string): Set<number> => {
	const out = new Set<number>()
	for (const m of text.matchAll(/\d+/g)) out.add(Number(m[0]))
	return out
}

/** Integers in the spoken line, normalised for spoken number words, deduped, order kept. */
const spokenNumbers = (text: string): number[] => [
	...new Set([...normalizeNumbers(text).matchAll(/\d+/g)].map(m => Number(m[0])))
]

export interface Tally {
	id: string
	what: string
	/** Turns whose payload carried this channel at all. */
	present: number
	charsSum: number
	charsMax: number
	exclusiveUseful: number
	exclusiveFalse: number
	exclusiveOther: number
	/** Shared-number credit, split evenly among the channels that could have supplied the figure. */
	fracUseful: number
	fracFalse: number
	/** Integers this channel carries that NO other channel in the same payload carries. */
	uniqueNumsSum: number
	numsSum: number
	sigUseful: number
	sigFalse: number
	soleExclusiveUseful: number
	soleExclusiveFalse: number
	examplesUseful: string[]
	examplesFalse: string[]
}

const main = () => {
	const argv = process.argv.slice(2)
	const arg = (name: string): string | null => {
		const i = argv.indexOf(name)
		return i < 0 ? null : (argv[i + 1] ?? null)
	}
	const pairs = (arg("--pairs") ?? "").split(",").filter(p => p !== "")
	const out = arg("--out") ?? "data/eval/section-yield.json"
	if (pairs.length === 0) throw new Error("--pairs corpus.json=judged.json")

	const tallies = new Map<string, Tally>()
	const tally = (id: string, what: string): Tally => {
		let t = tallies.get(id)
		if (t === undefined) {
			t = {
				id, what, present: 0, charsSum: 0, charsMax: 0,
				exclusiveUseful: 0, exclusiveFalse: 0, exclusiveOther: 0,
				fracUseful: 0, fracFalse: 0, uniqueNumsSum: 0, numsSum: 0,
				sigUseful: 0, sigFalse: 0, soleExclusiveUseful: 0, soleExclusiveFalse: 0,
				examplesUseful: [], examplesFalse: []
			}
			tallies.set(id, t)
		}
		return t
	}

	const perCorpus: Record<string, unknown>[] = []
	const subjectTally = new Map<string, { useful: number; false_: number; other: number }>()
	const lineRows: Record<string, unknown>[] = []
	let turns = 0
	let payloadCharsSum = 0

	for (const pair of pairs) {
		const [corpusPath, judgedPath] = pair.split("=")
		if (corpusPath === undefined || judgedPath === undefined) throw new Error("bad pair " + pair)
		const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
			records: Rec[]
			windows: { id: string; counterpart?: string | null; gameId: string }[]
		}
		const judged = JSON.parse(readFileSync(judgedPath, "utf8")) as { lines: Line[] }
		const byKey = new Map<string, Rec>()
		/* Older judged files (2026-09-11) carry no index/rep, only windowId + clock + the text. */
		const byText = new Map<string, Rec>()
		const byClock = new Map<string, Rec>()
		for (const r of corpus.records) {
			if (r.payload === undefined) continue
			byKey.set(key(r), r)
			const c = (r as { clock?: string }).clock ?? ""
			if (r.text !== undefined) byText.set(`${r.arm}|${r.windowId}|${c}|${r.text.trim()}`, r)
			byClock.set(`${r.arm}|${r.windowId}|${c}`, r)
		}
		const cpOf = new Map(corpus.windows.map(w => [w.id, w.counterpart ?? null]))

		let matched = 0
		let unmatched = 0
		const corpusCounts = { useful: 0, false_: 0, other: 0 }

		/* Cost side: every payload in the corpus, spoken or not. */
		for (const r of corpus.records) {
			if (r.payload === undefined || r.arm === "mock") continue
			turns++
			payloadCharsSum += r.payload.length
			const cs = channelsOf(r.payload)
			const numsBy = cs.map(c => ({ id: c.id, nums: digitsOf(c.text) }))
			for (const c of cs) {
				const t = tally(c.id, c.what)
				t.present++
				t.charsSum += c.chars
				t.charsMax = Math.max(t.charsMax, c.chars)
				const mine = numsBy.find(x => x.id === c.id)!.nums
				t.numsSum += mine.size
				let uniq = 0
				for (const n of mine) if (!numsBy.some(x => x.id !== c.id && x.nums.has(n))) uniq++
				t.uniqueNumsSum += uniq
			}
		}

		for (const line of judged.lines) {
			const rec =
				byKey.get(key(line)) ??
				byText.get(`${line.arm}|${line.windowId}|${line.clock}|${(line.text ?? "").trim()}`) ??
				byClock.get(`${line.arm}|${line.windowId}|${line.clock}`)
			if (rec === undefined || rec.payload === undefined) {
				unmatched++
				continue
			}
			matched++
			const verdict = line.verdict
			const bucket = verdict === "useful" ? "useful" : verdict === "false" ? "false_" : "other"
			corpusCounts[bucket]++

			const chans = channelsOf(rec.payload)
			/*
			 * UNIT-AWARE. `coach-score` already measured what happens without this: a brief carries
			 * some three hundred integers, so almost any round figure finds a match somewhere, and
			 * a provenance test that ignores units attributes lines to whichever channel has the
			 * most digits. A figure whose unit cannot be read from the text around it is skipped
			 * entirely rather than treated as a wildcard.
			 */
			/*
			 * THE EVENT LOG NEEDS A SECOND GATE, and without it this instrument reports a fiction.
			 *
			 * Every event line is `- 21:40 (5m30s ago) Zed killed Lillia`, so the log alone carries
			 * some seventy seconds-figures a turn from its own ages. Unit agreement does not help:
			 * `30` in `5m30s ago` IS a seconds figure. Checked by hand on the first twelve lines the
			 * unit-only test credited to the log, TWELVE were this coincidence — "Rammus is down for
			 * forty seconds" matched `5m30s ago` on an unrelated kill five minutes earlier.
			 *
			 * So an event line may only supply a figure when the spoken sentence also NAMES somebody
			 * or something that line names. That is the weakest join that rules the coincidence out,
			 * and it is still generous: it cannot tell a citation from a sentence that happens to be
			 * about the same champion.
			 */
			const roster0 = ((corpus.windows.find(w => w.id === line.windowId) as { roster?: string[] } | undefined)?.roster ?? []) as string[]
			const said = new Set([
				...championsNamed(line.text, roster0),
				...[...line.text.matchAll(/\b(drake|dragon|baron|herald|grub|turret|tower|inhibitor)\b/gi)].map(m => m[1]!.toLowerCase())
			])
			/*
			 * THE GATE IS APPLIED TO EVERY CHANNEL, not only the log, and that symmetry is the
			 * point. Gating only the section under suspicion would depress exactly the number the
			 * conclusion rests on. A line that names NOBODY — `Gold in hand 619`, `Drake (bot
			 * side): up at 5:00` — is always allowed, because its figure belongs to the situation
			 * rather than to a person; a line that names somebody may only supply a figure when the
			 * spoken sentence names them too.
			 */
			const ENTITY = /\b(drake|dragon|baron|herald|grub|turret|tower|inhibitor)\b/gi
			const gatedFigs = (text: string): Figure[] => {
				const out: Figure[] = []
				for (const l of text.split("\n")) {
					const body = l.replace(/^- \d+:\d\d \((?:\d+m)?\d+s ago\) /, "")
					const names = new Set<string>([
						...championsNamed(body, roster0),
						...[...body.matchAll(ENTITY)].map(m => m[1]!.toLowerCase())
					])
					if (names.size > 0 && ![...names].some(n => said.has(n))) continue
					out.push(...blockFigures(l))
				}
				return out
			}
			const nums = chans.map(c => ({ c, figs: gatedFigs(c.text) }))
			const spokenFigs = blockFigures(normalizeNumbers(line.text))
			const exclusive = new Map<string, number[]>()
			const shared: number[] = []
			for (const fig of spokenFigs) {
				const n = fig.value
				if (fig.unit === "unknown") continue
				if (n < 10 && fig.unit !== "level") continue
				const owners = nums.filter(x => x.figs.some(f => f.value === n && unitsAgree(fig.unit, f.unit))).map(x => x.c.id)
				if (owners.length === 1) {
					const id = owners[0]!
					exclusive.set(id, [...(exclusive.get(id) ?? []), n])
				} else if (owners.length > 1) {
					shared.push(n)
					for (const id of owners) {
						const t = tallies.get(id)
						if (t === undefined) continue
						if (bucket === "useful") t.fracUseful += 1 / owners.length
						else if (bucket === "false_") t.fracFalse += 1 / owners.length
					}
				}
			}
			const sigs = new Set<string>()
			for (const s of SIGNATURES) if (s.re.test(line.text) && chans.some(c => c.id === s.channel)) sigs.add(s.channel)

			for (const [id, ns] of exclusive) {
				const t = tallies.get(id)
				if (t === undefined) continue
				if (bucket === "useful") {
					t.exclusiveUseful++
					if (exclusive.size === 1) {
						t.soleExclusiveUseful++
						if (t.examplesUseful.length < 4) t.examplesUseful.push(`${line.clock} [${ns.join(",")}] ${line.text.slice(0, 150)}`)
					}
				} else if (bucket === "false_") {
					t.exclusiveFalse++
					if (exclusive.size === 1) {
						t.soleExclusiveFalse++
						if (t.examplesFalse.length < 4) t.examplesFalse.push(`${line.clock} [${ns.join(",")}] ${line.text.slice(0, 150)}`)
					}
				} else t.exclusiveOther++
			}
			for (const id of sigs) {
				const t = tallies.get(id)
				if (t === undefined) continue
				if (bucket === "useful") t.sigUseful++
				else if (bucket === "false_") t.sigFalse++
			}

			const cp = cpOf.get(line.windowId) ?? null
			const roster = (corpus.windows.find(w => w.id === line.windowId) as { roster?: string[] } | undefined)?.roster ?? []
			for (const s of subjectOf(line.text, cp, roster)) {
				const st = subjectTally.get(s) ?? { useful: 0, false_: 0, other: 0 }
				st[bucket]++
				subjectTally.set(s, st)
			}

			lineRows.push({
				corpus: judgedPath,
				id: line.id,
				windowId: line.windowId,
				clock: line.clock,
				verdict,
				text: line.text,
				exclusive: Object.fromEntries(exclusive),
				shared,
				signatures: [...sigs],
				subjects: subjectOf(line.text, cp, roster),
				payloadChars: rec.payload.length
			})
		}
		perCorpus.push({ corpus: judgedPath, matched, unmatched, ...corpusCounts })
	}

	const rows = [...tallies.values()]
		.map(t => ({
			...t,
			meanChars: t.present === 0 ? 0 : Math.round(t.charsSum / t.present),
			fracUseful: Number(t.fracUseful.toFixed(1)),
			fracFalse: Number(t.fracFalse.toFixed(1)),
			uniqueNumFraction: t.numsSum === 0 ? 0 : Number((t.uniqueNumsSum / t.numsSum).toFixed(3)),
			uniqueNumsPerTurn: t.present === 0 ? 0 : Number((t.uniqueNumsSum / t.present).toFixed(2)),
			shareOfPayload: payloadCharsSum === 0 ? 0 : Number((t.charsSum / payloadCharsSum).toFixed(4)),
			usefulPerKChar: t.charsSum === 0 ? 0 : Number(((t.soleExclusiveUseful * 1000) / (t.charsSum / 1000)).toFixed(2)),
			falseShare:
				t.soleExclusiveUseful + t.soleExclusiveFalse === 0 ? null
				: Number((t.soleExclusiveFalse / (t.soleExclusiveUseful + t.soleExclusiveFalse)).toFixed(3)),
			falseWilson:
				t.soleExclusiveUseful + t.soleExclusiveFalse === 0 ? null
				: wilson(t.soleExclusiveFalse, t.soleExclusiveUseful + t.soleExclusiveFalse)
		}))
		.sort((a, b) => b.charsSum - a.charsSum)

	const report = {
		ranAt: new Date().toISOString(),
		what: "Per-channel attribution of every graded live line to the part of the payload it drew on.",
		limits: [
			"RETRACTED, and the retraction is the most important line in this file: EXCLUSIVE NUMBER PROVENANCE DOES NOT WORK ON THIS PAYLOAD and no channel ranking here may be quoted from it. A brief carries ~300 integers and the EVENT LOG alone contributes a clock and an age per line, so a spoken figure finds a coincidental sole owner constantly. Checked by hand: of the first ten lines this credited to `events.old`, TEN were the coach rounding an objective clock — \"dragon in forty seconds\" against a `40` inside an unrelated event's age, while the real source said 39s and so did not match. Tightening the gate moved `events.old` from 183 sole-exclusive useful lines to 4 and back to 184; a measure that moves by 45x on the definition of its own gate is measuring the gate. Read `present`, `meanChars`, `shareOfPayload` and `uniqueNumFraction` — which are computed from payloads alone and need no attribution — plus the SIGNATURE and SUBJECT columns, which are exact string tests on what was actually said.",
			"`uniqueNumFraction` is REDUNDANCY, not worthlessness. A section every one of whose figures appears elsewhere can still be the section the model reads; ordering and framing are not measured here. Only an ablation decides that, which is what `bench-stream --arms <p>+cut-<preset>` is for.",
			"Exclusive attribution is a FLOOR on use: a line that quotes nothing unique to a channel is invisible to it.",
			"A channel may be used to SUPPRESS a line; nothing here measures a line that was not said.",
			"The corpora are not independent — integrate2/3/4 replay the same 28 games through successive payload versions.",
			"Verdicts are one model judge (anthropic/claude-sonnet-5) which disagrees with itself on ~16% of identical lines."
		],
		turnsWithPayload: turns,
		payloadCharsMean: turns === 0 ? 0 : Math.round(payloadCharsSum / turns),
		perCorpus,
		channels: rows,
		subjects: Object.fromEntries([...subjectTally.entries()].sort((a, b) => b[1].useful - a[1].useful))
	}
	writeFileSync(out, JSON.stringify(report, null, "\t"))
	writeFileSync(out.replace(/\.json$/, "-lines.json"), JSON.stringify(lineRows))

	const pad = (s: string, n: number) => s.padEnd(n).slice(0, n)
	console.log(`turns with payload ${turns}, mean payload ${report.payloadCharsMean} chars`)
	console.log(perCorpus.map(c => JSON.stringify(c)).join("\n"))
	console.log("")
	console.log(pad("channel", 19) + pad("pres%", 7) + pad("meanCh", 8) + pad("%pay", 6) + pad("uniqN", 7) + pad("solU", 6) + pad("solF", 6) + pad("fracU", 7) + pad("fracF", 7) + pad("sigU", 6) + pad("sigF", 6) + "false%")
	for (const r of rows)
		console.log(
			pad(r.id, 19) + pad(((r.present / turns) * 100).toFixed(0) + "%", 7) + pad(String(r.meanChars), 8) +
			pad((r.shareOfPayload * 100).toFixed(1), 6) + pad(r.uniqueNumsPerTurn.toFixed(1), 7) + pad(String(r.soleExclusiveUseful), 6) +
			pad(String(r.soleExclusiveFalse), 6) + pad(r.fracUseful.toFixed(1), 7) + pad(r.fracFalse.toFixed(1), 7) + pad(String(r.sigUseful), 6) + pad(String(r.sigFalse), 6) +
			(r.falseShare === null ? "-" : (r.falseShare * 100).toFixed(0) + "%")
		)
	console.log("\nsubjects:", JSON.stringify(report.subjects))
	console.log("\nwrote", out)
}

main()
