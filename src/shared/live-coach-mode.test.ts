/**
 * The two claims `live-coach-mode.ts` rests on, and neither is about arithmetic.
 *
 * 1. **The shipped cite-or-quiet prompt IS the measured one.** The whole reason to change the
 *    coach's architecture tonight is a run over 363 real samples in which one specific wording
 *    spoke on 94 of 102 turns with zero fabrications. A prompt that has since been "improved" by
 *    a paragraph is a prompt that was never measured, and the run stops justifying it — silently,
 *    because a reworded prompt still looks exactly like the one in the results file. So the text
 *    is asserted byte-for-byte against `src/review/ablation-arms.ts`, which holds that run's arms as frozen data.
 *
 * 2. **The block surgery still finds the fence.** Every replacement is a literal string lifted out
 *    of `renderState`. If that function is edited — it is owned elsewhere and it moves — a
 *    `String.replace` that no longer matches does not throw, it does nothing: the shipped coach
 *    would keep receiving `never say this unless it also appears in the list below` while the
 *    settings page told him the fence was off. That failure is invisible in production and cheap
 *    to catch here, so every `from` is checked against real rendered output.
 */

import { type } from "arktype"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { test } from "node:test"
import { ABLATION_ARMS as ARMS, ablationChampionKnowledge as championKnowledge } from "../review/ablation-arms.ts"
import { legacyClauseSection } from "../knowledge/legacy-clauses.ts"
import { fullKnowledge } from "../review/live-knowledge-full.ts"
import { parseChampionClauses } from "./champion-advice.ts"
import {
	CITE_BLOCK_REPAIRS,
	CITE_PERSONA,
	CITE_RULE,
	DEFAULT_LIVE_COACH_MODE,
	LIST_HINT,
	LIVE_COACH_MODES,
	TRUSTED_KNOWLEDGE_HEADING,
	TRUSTED_CLOSE,
	TRUSTED_PROMPT,
	downLine,
	liveCoachSystemPrompt,
	renderBlockForMode,
	renderChampionKnowledge
} from "./live-coach-mode.ts"
import { LIVE_COACH_SYSTEM_PROMPT } from "./live-prompt.ts"
import { renderState } from "./live-state.ts"
import type { VisionState } from "./live-state.ts"
import { DEFAULT_SETTINGS, SettingsPatch } from "./schema/settings.ts"

const state = (over: Partial<VisionState> = {}): VisionState => ({
	clock: "9:40",
	me: { champion: "Lillia", level: 8, k: 2, d: 1, a: 3, cs: 88, gold: 1017 },
	pace: { cs: 88, expected: 96, exact: true, source: "your own average: 96" },
	pronounce: [],
	counterpart: { champion: "Briar", level: 9 },
	allies: [{ champion: "Urgot", level: 8, k: 0, d: 0, a: 0 }],
	enemies: [{ champion: "Ornn", level: 9, k: 1, d: 0, a: 2 }],
	recentEvents: [],
	unseen: ["Briar is down 27 seconds — their camps are free", "1017 gold sitting unspent"],
	...over
})

const FULL = state()
const EMPTY = state({ unseen: [] })

/* ------------------------------------------------ the prompt is the measured one */

test("the shipped cite-or-quiet prompt is the ablation's arm, byte for byte", () => {
	const arm = ARMS.find(a => a.id === "cite-or-quiet")
	assert.ok(arm, "the ablation no longer has a cite-or-quiet arm")
	// A champion with no knowledge file, so the arm's own text is all that comes back.
	assert.equal(`${CITE_PERSONA}${CITE_RULE}`, arm.system("zzznotachampion"))
})

test("the shipped prompt is the measured text plus the delta, and nothing else", () => {
	const shipped = liveCoachSystemPrompt({ mode: "cite-or-quiet" })
	assert.equal(shipped.startsWith(`${CITE_PERSONA}${CITE_RULE}`), true)
	// Everything appended is the reviewable delta, not a quiet reword of the measured half.
	assert.equal(shipped.length > `${CITE_PERSONA}${CITE_RULE}`.length, true)
})

test("fenced mode is what ships today, unchanged", () => {
	assert.equal(liveCoachSystemPrompt({ mode: "fenced" }), LIVE_COACH_SYSTEM_PROMPT)
	assert.equal(liveCoachSystemPrompt({ mode: "fenced", championKnowledge: "ignored" }), LIVE_COACH_SYSTEM_PROMPT)
})

/*
 * The clause corpus moved from `knowledge/champions/*.md` into `knowledge/legacy-clauses.ts` on
 * 2026-09-18, frozen byte for byte, because the markdown was model-authored and one of its
 * sentences was measurably false. `legacyClauseSection` is the AS-MEASURED text, which is what
 * these two tests are about: they pin that the renderer the ablation ran still produces the
 * ablation's bytes.
 */
test("champion knowledge renders exactly as the ablation rendered it", () => {
	const section = legacyClauseSection("lillia")
	assert.equal(renderChampionKnowledge("Lillia", parseChampionClauses(section)), championKnowledge("Lillia"))
})

test("champion knowledge reaches the prompt and carries no digits", () => {
	const section = legacyClauseSection("lillia")
	const knowledge = renderChampionKnowledge("Lillia", parseChampionClauses(section))
	assert.equal(knowledge.length > 0, true, "the frozen Lillia section parsed to nothing — the clause format moved")
	assert.equal(liveCoachSystemPrompt({ mode: "cite-or-quiet", championKnowledge: knowledge }).endsWith(knowledge), true)
	// The one rule that keeps this honest by construction rather than by obedience.
	const clauses = knowledge.split("\n").filter(l => l.startsWith("- ("))
	for (const c of clauses) assert.equal(/[0-9]/.test(c), false, `a digit reached the prompt: ${c}`)
})

/* ---------------------------------------------------------- the block surgery */

test("every repair still matches what renderState actually emits", () => {
	const full = renderState(FULL)
	const empty = renderState(EMPTY)
	for (const r of CITE_BLOCK_REPAIRS)
		assert.equal(
			full.includes(r.from) || empty.includes(r.from),
			true,
			`renderState no longer contains, so this repair silently does nothing: ${JSON.stringify(r.from)}`
		)
})

test("fenced mode gets renderState byte for byte", () => {
	assert.equal(renderBlockForMode(FULL, "fenced"), renderState(FULL))
	assert.equal(renderBlockForMode(EMPTY, "fenced"), renderState(EMPTY))
})

test("cite mode removes the fence's instructions and keeps every fact", () => {
	const out = renderBlockForMode(FULL, "cite-or-quiet")
	assert.equal(out.includes("CONTEXT ONLY"), false, "the farm baseline is still gagged")
	assert.equal(out.includes("prefer these"), false, "the list still reads as a menu")
	assert.equal(out.includes("take every timer from the list below"), false)
	// Nothing above the list was touched: the figures are all still there, verbatim.
	for (const fact of ["88 CS against 96", "1017 gold", "Briar", "Urgot", "Ornn", "Clock 9:40"])
		assert.equal(out.includes(fact), true, `the surgery took a fact with it: ${fact}`)
	for (const u of FULL.unseen) assert.equal(out.includes(u), true, `ranked fact lost: ${u}`)
})

test("an empty ranked list stops being an order to shut up", () => {
	const out = renderBlockForMode(EMPTY, "cite-or-quiet")
	assert.equal(out.includes("the correct answer is PASS"), false)
	assert.equal(out.includes("Nothing is ranked right now"), true)
	// The fenced block keeps the instruction, because it is a measured arm.
	assert.equal(renderBlockForMode(EMPTY, "fenced").includes("the correct answer is PASS"), true)
})

/* ------------------------------------------------------------- who is down */

test("the block names who is dead, so the alive count is not a thing to guess from", () => {
	const s = state({
		allies: [{ champion: "Urgot", dead: true }, { champion: "Taliyah" }],
		enemies: [{ champion: "Ornn" }, { champion: "Briar", dead: true, respawnSec: 27 }]
	})
	const out = renderBlockForMode(s, "cite-or-quiet")
	assert.equal(out.includes("Theirs: Briar."), true)
	assert.equal(out.includes("Yours: Urgot."), true)
	assert.equal(out.includes("Anyone not named here is alive."), true)
	// It sits under the count it exists to disambiguate.
	const lines = out.split("\n")
	const at = lines.findIndex(l => l.startsWith("Alive right now:"))
	assert.equal(lines[at + 1]?.startsWith("Down right now"), true)
})

test("the down line never carries a respawn timer", () => {
	// Measured twice: given `DEAD (14s)` beside a name the coach read the timer back after it had
	// expired, and given a bare `DEAD` it invented one. Names answer "who"; the ranked list owns
	// "for how long".
	const s = state({ enemies: [{ champion: "Briar", dead: true, respawnSec: 27 }] })
	assert.equal(/[0-9]/.test(downLine(s)), false, "a digit reached the down line")
	assert.equal(downLine(s).includes("27"), false)
})

test("nobody dead says so plainly rather than leaving a gap to fill", () => {
	assert.equal(downLine(state()).includes("nobody"), true)
	assert.equal(/[0-9]/.test(downLine(state())), false)
})

test("his own death is named as his", () => {
	const s = state({ me: { champion: "Lillia", dead: true, respawnSec: 12 } })
	assert.equal(downLine(s).includes("you (Lillia)"), true)
})

test("the fenced block never grows a down line", () => {
	const s = state({ enemies: [{ champion: "Briar", dead: true, respawnSec: 27 }] })
	assert.equal(renderBlockForMode(s, "fenced").includes("Down right now"), false)
})

/* ----------------------------------------------------------------- the setting */

test("trusted is the default and every mode is accepted by the schema", () => {
	assert.equal(DEFAULT_LIVE_COACH_MODE, "trusted")
	assert.equal(DEFAULT_SETTINGS.liveCoachMode, "trusted")
	for (const m of LIVE_COACH_MODES) {
		const patch = SettingsPatch({ liveCoachMode: m.id })
		assert.equal(patch instanceof type.errors, false, `the schema rejects a mode the picker offers: ${m.id}`)
		assert.deepEqual(patch, { liveCoachMode: m.id })
	}
	assert.equal(SettingsPatch({ liveCoachMode: "whatever" }) instanceof type.errors, true)
})

test("every mode in the picker carries its own number", () => {
	// The argument for the option he is NOT on has to be visible too, or this is marketing.
	for (const m of LIVE_COACH_MODES) {
		assert.equal(m.label.length > 0, true)
		assert.equal(m.blurb.length > 40, true)
		assert.equal(/[0-9]/.test(m.evidence), true, `${m.id} claims something with no figure behind it`)
	}
	assert.deepEqual(LIVE_COACH_MODES.map(m => m.id).sort(), ["cite-or-quiet", "fenced", "trusted"])
})

/* -------------------------------------------------------------------- trusted */

/**
 * `trusted` is added BESIDE the measured arms, never over them.
 *
 * The two tests above already pin each measured prompt to `src/review/ablation-arms.ts`, which is
 * where a reword would do its damage. This one pins the thing those cannot see: that adding a mode
 * did not change what the other two RETURN. A stored run only keeps justifying a default while the
 * repo can still emit the exact bytes that were scored.
 */
test("adding trusted left both measured modes byte-identical", () => {
	assert.equal(liveCoachSystemPrompt({ mode: "fenced" }), LIVE_COACH_SYSTEM_PROMPT)
	assert.equal(liveCoachSystemPrompt({ mode: "cite-or-quiet" }), `${CITE_PERSONA}${CITE_RULE}${LIST_HINT}`)
	assert.equal(
		liveCoachSystemPrompt({ mode: "cite-or-quiet", championKnowledge: "\n\nK" }),
		`${CITE_PERSONA}${CITE_RULE}${LIST_HINT}\n\nK`
	)
	assert.equal(renderBlockForMode(FULL, "fenced"), renderState(FULL))
})

test("trusted appends the caller's knowledge whole, with no parsing and no digit filter", () => {
	/*
	 * The bug this mode exists to fix: 6,800 characters of champion knowledge arrived as 2,566 of
	 * numberless fragments, because the clause parser drops every clause carrying a digit. Whatever
	 * the caller hands over goes through whole.
	 *
	 * The knowledge is the FETCHED block now rather than a file of prose, and that is the point of
	 * asking for it through `fullKnowledge` here: this test's job is that the mode does not parse,
	 * filter or truncate what it is given, whatever that happens to be, and it would pass vacuously
	 * against a constant.
	 */
	const md = fullKnowledge({ champion: "Lillia", counterpart: "Briar" })
	assert.equal(md.length > 0, true, "the fetched knowledge block is empty — champion-table.ts moved")
	const out = liveCoachSystemPrompt({ mode: "trusted", championKnowledge: md })
	assert.equal(out.startsWith(TRUSTED_PROMPT), true)
	assert.equal(out.includes(md), true)
	assert.equal(out.includes(TRUSTED_KNOWLEDGE_HEADING), true)
	assert.equal(liveCoachSystemPrompt({ mode: "trusted" }), `${TRUSTED_PROMPT}${TRUSTED_CLOSE}`)
})

/**
 * The close is LAST, and that is the whole of the change it makes.
 *
 * Measured on the assembled prompt for the game this app is benched on: before it, the single
 * mention of PASS sat 43% of the way into 48,112 characters with 27,573 characters of champion
 * notes after it, and the socket declined on 0 of 241 recorded turns. An instruction that is only
 * reachable through two champion guides is an instruction the model reads once and then reads
 * twenty thousand characters of things to say. So the test is positional, not textual: the knowledge
 * may grow to any size and this section still comes after it.
 */
test("the close is the last instruction, after the champion knowledge", () => {
	const md = fullKnowledge({ champion: "Lillia", counterpart: "Briar" })
	const out = liveCoachSystemPrompt({ mode: "trusted", championKnowledge: md })
	assert.equal(out.endsWith(TRUSTED_CLOSE), true)
	assert.equal(out.indexOf(md) < out.indexOf(TRUSTED_CLOSE), true)
	// It names what the two replies DO and never when to use either: no frequency, no trigger, no
	// subject. A word from that family appearing here is the fence coming back in a new place.
	for (const banned of ["often", "usually", "most turns", "only when", "unless", "should"])
		assert.equal(
			TRUSTED_CLOSE.toLowerCase().includes(banned),
			false,
			`the close became a rule about when: ${banned}`
		)
})

/**
 * The audit, as an assertion rather than as a claim in a commit message.
 *
 * Every string here is a guardrail the owner asked to be removed twice, and each one is quoted
 * from the prompt it was removed from. A future edit that reintroduces the phrasing — the empty
 * list, the citation gate, the screen prohibition — fails here instead of quietly turning the
 * fence back on inside a mode named "trusted".
 */
test("the trusted prompt carries no fence", () => {
	for (const banned of [
		"ranked list",
		"the correct answer is PASS",
		"must appear verbatim",
		"you may not say",
		"never describe what he can see",
		"context, not a source",
		"ONE sentence"
	])
		assert.equal(TRUSTED_PROMPT.includes(banned), false, `a guardrail survived the audit: ${banned}`)
	// The honest half is still there: the data facts, and the refusal to assert the unknowable.
	for (const kept of ["floored to a multiple of ten", "COMBINE cost", "no coordinates", "PASS"])
		assert.equal(TRUSTED_PROMPT.includes(kept), true, `the honest half was cut too: ${kept}`)
})

/* --------------------------------------------- the re-aim, and its arithmetic */

/**
 * `## What his own 138 games say…` — the section added 2026-09-22, and the three things it rests on.
 *
 * ## Why it exists
 *
 * The POST-GAME persona (Part 2 of AGENTS.md) was re-aimed at the two things `scripts/what-wins.ts`
 * measured to separate his wins from his losses, and the re-aim was scored: on-target items went
 * from 6% [3-13] to 38% [29-48], paired 25-of-30 games against 6, McNemar p 0.0000038
 * (`data/eval/persona-ab-20260919-flash.json`). The LIVE persona never got any of it, and his own
 * machine shows the cost. Of the nine lines the shipped coach spoke in game 5645995390 on
 * 2026-09-20 — re-read this session out of `data/logs/live-transcript.jsonl` — TWO were
 * "you have nearly two thousand gold in your pocket, so take a quick recall" and "you have over two
 * thousand gold, so recall now, spend it". That is 22% of everything it said to him that game spent
 * on a figure his own 138 ranked games measure as pointing the OTHER WAY: he carries 1023 gold
 * unspent on average in the games he WINS against 778 in the ones he loses.
 *
 * ## The line this section may not cross, and how these tests hold it
 *
 * Nothing may tell the live model WHAT to say or WHEN — the empty ranked list is the gag this whole
 * architecture was built to remove, and re-introducing it through prose would be worse than the
 * fence, because prose fails no test. So the section is written in the register of the FIELD AUDIT
 * further up the same prompt: graded properties with their sample sizes attached, about the player
 * instead of about the feed. `the re-aim is knowledge and not a fence` below pins that register
 * mechanically, the way the `TRUSTED_CLOSE` test pins its own.
 *
 * ## And every figure in it recomputes
 *
 * The other failure mode is quieter and it is the one this repo keeps catching: a figure copied
 * from a prose summary rather than from the run. Writing this section caught two — AGENTS.md says
 * "136 of them Lillia" where the stored features say 134 (134 Lillia, 3 Gwen, 1 Brand), and "78
 * candidate features" where the run holds 77 rows. Both were about to be copied into the prompt. So
 * every count and every rate in the section is RE-DERIVED here from the NEWEST `what-wins-*.json`
 * on disk — today `what-wins-20260918.json` — and asserted to appear in the text. A future edit
 * that rounds a number, and a future re-run of `what-wins.ts` that moves one, both fail loudly here
 * instead of shipping a wrong statistic to a coach that is told to absorb this section and never
 * attribute it.
 */
const REAIM_HEADING = "## What his own 138 games say about which of these numbers moved the result"
const REAIM_NEXT = "## Your read is yours, and it should sound like one"

const reaimSection = (): string => {
	const a = TRUSTED_PROMPT.indexOf(REAIM_HEADING)
	const b = TRUSTED_PROMPT.indexOf(REAIM_NEXT)
	assert.equal(a >= 0, true, "the re-aim section is gone from TRUSTED_PROMPT")
	assert.equal(b > a, true, "the re-aim section no longer sits before the read section")
	return TRUSTED_PROMPT.slice(a, b)
}

interface WhatWinsGame {
	win: boolean
	championName: string
	meanGoldInHand: number
	"deaths@10-15": number
	earlyObjectiveDiffBy10: number
}
interface WhatWinsRun {
	nGames: number
	nWon: number
	nLost: number
	rows: {
		key: string
		auc: { point: number }
		q: number
		separates: boolean
		control: string
		controlled: { metricP: number } | null
	}[]
	features: WhatWinsGame[]
}

/**
 * The NEWEST `what-wins` run on disk, not a pinned filename.
 *
 * Deliberate, and it is the difference between a test that notices and a test that reassures. If
 * `scripts/what-wins.ts` is ever re-run — he keeps playing, so it will be — it writes a new dated
 * file beside the old one. A test pinned to `what-wins-20260918.json` would keep passing forever
 * against a measurement nobody uses any more, while the prompt quoted its figures at the coach as
 * current. Reading the latest means a re-measurement fails HERE, in one place, with the two files
 * named, instead of shipping silently.
 */
const whatWins = (): { run: WhatWinsRun; file: string } => {
	const dir = new URL("../../data/eval/", import.meta.url)
	const files = readdirSync(dir)
		.filter(f => /^what-wins-\d{8}\.json$/.test(f))
		.sort()
	assert.equal(
		files.length > 0,
		true,
		"no what-wins run in data/eval — the trusted prompt quotes figures that nothing here can now " +
			"re-derive. Regenerate with `node --experimental-strip-types scripts/what-wins.ts`, then " +
			"reconcile every figure in the re-aim section against the new file before shipping it again."
	)
	const file = files[files.length - 1]!
	return { run: JSON.parse(readFileSync(new URL(file, dir), "utf8")) as WhatWinsRun, file }
}

/** Whole-percent point estimate, the way the section writes its rates out. */
const pct = (k: number, n: number): number => Math.round((k / n) * 100)

test("every figure the re-aim quotes about his own games recomputes from the stored run", () => {
	// `file` is named in the failure messages below, because "the prompt says 134" is only half of
	// a bug report — which run disagrees with it is the other half.
	const { run, file } = whatWins()
	const s = reaimSection()
	const f = run.features
	assert.equal(f.length, run.nGames)

	/* -- the corpus -- */
	const lillia = f.filter(g => g.championName === "Lillia").length
	for (const fact of [`${run.nGames} games`, `${run.nWon} won and ${run.nLost} lost`, `${lillia} of them on Lillia`])
		assert.equal(s.includes(fact), true, `the section no longer states, or misstates: ${fact}`)
	// 77, not the 78 that AGENTS.md's prose says. Spelled out, because the prompt spells it out.
	assert.equal(run.rows.length, 77, `${file} holds ${run.rows.length} rows — the section says seventy-seven`)
	assert.equal(s.includes("seventy-seven candidates"), true)

	/* -- the two separators, as the split win rates the section prints -- */
	const clean = f.filter(g => g["deaths@10-15"] === 0)
	const died = f.filter(g => g["deaths@10-15"] > 0)
	assert.equal(s.includes(`${clean.filter(g => g.win).length} won of ${clean.length}`), true)
	assert.equal(s.includes(`${died.filter(g => g.win).length} won of ${died.length}`), true)
	assert.equal(pct(clean.filter(g => g.win).length, clean.length), 70)
	assert.equal(pct(died.filter(g => g.win).length, died.length), 38)

	const ahead = f.filter(g => g.earlyObjectiveDiffBy10 > 0)
	const notAhead = f.filter(g => g.earlyObjectiveDiffBy10 <= 0)
	assert.equal(s.includes(`${ahead.filter(g => g.win).length} won of ${ahead.length}`), true)
	assert.equal(s.includes(`${notAhead.filter(g => g.win).length} won of ${notAhead.length}`), true)
	assert.equal(pct(ahead.filter(g => g.win).length, ahead.length), 64)
	assert.equal(pct(notAhead.filter(g => g.win).length, notAhead.length), 38)
	// Both rates are written as words, so the model has nothing quotable to read back at him.
	for (const word of ["seventy percent", "thirty-eight percent", "sixty-four percent"])
		assert.equal(s.includes(word), true, `a rate stopped being spelled out: ${word}`)
	for (const digits of ["70%", "38%", "64%", "70 percent", "64 percent"])
		assert.equal(s.includes(digits), false, `a win rate became a quotable figure: ${digits}`)

	/* -- unspent gold: the defect signal that points the other way -- */
	const mean = (xs: WhatWinsGame[]): number =>
		Math.round(xs.reduce((a, g) => a + g.meanGoldInHand, 0) / xs.length)
	assert.equal(s.includes(`${mean(f.filter(g => g.win))} gold on average`), true)
	assert.equal(s.includes(`against ${mean(f.filter(g => !g.win))}`), true)
	assert.equal(mean(f.filter(g => g.win)) > mean(f.filter(g => !g.win)), true, "the direction flipped")

	/*
	 * -- the early null, and the exact twelve rows the sentence is a claim about --
	 *
	 * Written out rather than derived from a filter, because the sentence names them in prose and a
	 * filter that silently gained a row would keep passing while the prompt described eleven.
	 */
	const early = [
		"cs@10",
		"gold@10",
		"csPerMin@0-10",
		"xpPerMin@0-10",
		"deathsBy@10",
		"firstBackMin",
		"csDiffVsJgl@10",
		"goldDiffVsJgl@10",
		"xpDiffVsJgl@10",
		"levelDiffVsJgl@10",
		"enemyHalfShare@0-10",
		"enemyCampShare@0-10"
	]
	assert.equal(early.length, 12, "the sentence says all twelve")
	assert.equal(s.includes("all twelve"), true)
	const aucs = early.map(k => {
		const row = run.rows.find(r => r.key === k)
		assert.ok(row, `what-wins no longer has the row the prompt describes: ${k}`)
		assert.equal(row.separates, false, `${k} now separates — the prompt's early-null claim is stale`)
		return row.auc.point
	})
	// The prompt writes the band to two places, so the pin is the ROUNDED band and not the raw one.
	assert.equal((Math.round(Math.min(...aucs) * 100) / 100).toFixed(2), "0.44", `floor moved: ${Math.min(...aucs)}`)
	assert.equal((Math.round(Math.max(...aucs) * 100) / 100).toFixed(2), "0.58", `ceiling moved: ${Math.max(...aucs)}`)
	assert.equal(s.includes("between 0.44 and 0.58"), true)

	/*
	 * "the only personal figure at any checkpoint in the whole table that survives the scoreboard
	 * control" — the strongest sentence in the section, so it is the one most worth pinning. The
	 * control is the two-term logistic against his team's gold at 10:00; `control: "his"` is the
	 * run's own flag for a metric HE owns, as opposed to one his team shares or one that is the
	 * scoreboard. Exactly one of them clears p 0.05, and it is the death window.
	 */
	const controlled = run.rows.filter(r => r.controlled !== null)
	const personal = controlled.filter(r => r.control === "his")
	assert.equal(controlled.length, 34, `${file}: the section says thirty-four rows went through the control`)
	assert.equal(s.includes("thirty-four\nrows that are knowable at a checkpoint"), true)
	assert.equal(personal.length, 15, `${file}: the section says fifteen of them are figures HE owns`)
	assert.equal(s.includes("the fifteen figures HE owns"), true)
	assert.deepEqual(
		personal.filter(r => r.controlled!.metricP < 0.05).map(r => r.key),
		["deaths@10-15"],
		`${file}: the set of personal metrics surviving the scoreboard control moved — the section says it is exactly one`
	)

	const team = run.rows.find(r => r.key === "teamGoldDiff@10")
	assert.ok(team)
	assert.equal(team.auc.point.toFixed(2), "0.74")
	assert.equal(s.includes("does separate, at 0.74"), true)
})

/**
 * The register test: this is a PROPERTY OF THE PLAYER, stated the way the feed audit states a
 * property of a field. It is not a subject list, a ban or a menu.
 *
 * Every banned string below is the shape the fence takes when it comes back as prose — a second
 * person told what to do or what not to mention. The section is allowed to say a CLAIM would be
 * false (that is what the enemy-CS section does, and it is the only kind of correction that has
 * ever worked here); it is not allowed to say a SUBJECT is closed. If a later edit cannot make its
 * point without one of these, that edit is the change this repo refuses and it belongs in a report
 * rather than in the prompt.
 */
test("the re-aim is knowledge and not a fence", () => {
	const s = reaimSection().toLowerCase()
	for (const banned of [
		"do not ",
		"don't ",
		"never say",
		"never mention",
		"never talk",
		"always say",
		"always mention",
		"you may not",
		"you must",
		"instead of",
		"avoid ",
		"prefer ",
		"should ",
		"only when",
		"only if",
		"make sure",
		"focus on",
		"talk about",
		"stick to",
		"priority",
		"prioritise",
		"prioritize"
	])
		assert.equal(s.includes(banned), false, `the re-aim became a rule about what to say: ${banned}`)
	// And it says out loud that it is none of those things, in the prompt rather than only here.
	for (const kept of ["a subject to cover", "yours to decide"])
		assert.equal(reaimSection().includes(kept), true, `the section stopped disclaiming itself: ${kept}`)
})

/**
 * WHERE it sits, which is the difference between knowledge and a nag.
 *
 * It is inside `TRUSTED_PROMPT`, so it rides ONCE in the system instruction for a whole game and is
 * cached with it — the cache breakpoint on that block is measured in `data/eval/ttft-2026091818*.json`
 * and AGENTS.md quotes it at about 15,500 of 20,000 prompt tokens read back; this run did not
 * re-measure it. Putting the same sentences in the per-turn payload would re-bill them every turn
 * AND would be the harness deciding what the turn is about, which is the one thing the payload may
 * not do. The measured arms must not see it at all.
 */
test("the re-aim rides in the trusted system instruction and nowhere else", () => {
	const trusted = liveCoachSystemPrompt({ mode: "trusted" })
	assert.equal(trusted.includes(REAIM_HEADING), true)
	// ONCE. A duplicated paste is silent otherwise, and the model would be handed the same
	// measurement twice with nothing saying which copy is current.
	assert.equal(trusted.split(REAIM_HEADING).length - 1, 1, "the re-aim heading appears more than once")
	assert.equal(liveCoachSystemPrompt({ mode: "fenced" }).includes(REAIM_HEADING), false)
	assert.equal(liveCoachSystemPrompt({ mode: "cite-or-quiet" }).includes(REAIM_HEADING), false)
	// It is a section of the persona, not a section of a turn's facts.
	assert.equal(renderBlockForMode(FULL, "trusted").includes("138 games"), false)
})

/**
 * The A/B that judged the re-aim was a NULL, and this test exists so the null cannot rot.
 *
 * `TRUSTED_PROMPT`'s own doc comment prints a five-row table off
 * `data/eval/live-persona-ab-20260922-judged.json` — 30 of his own games, 886 lines, coach
 * `claude-sonnet-5`, fabrication scored mechanically and `useful` graded blind by `claude-opus-5`
 * with the arm labels stripped. A table in a comment is exactly the kind of claim this repo has
 * had to retract before, so the counts are recomputed here from the stored grades.
 *
 * It is UNCONDITIONAL on purpose. A version that skipped when the file was missing would turn
 * "somebody pruned the evidence" into a green suite with an unbacked table still sitting in the
 * prompt's comment, which is the failure mode the whole file is written against.
 *
 * What it does NOT assert is that the arms differ, because they do not: on-target 102 against 101,
 * useful 163 against 169, fabricated 10 against 13, every interval overlapping. If a later run
 * finds an effect, the right move is a NEW file beside this one and a new row here — never an edit
 * to these counts.
 */
test("the re-aim's A/B is still on disk and is still the null the comment prints", () => {
	const dir = new URL("../../data/eval/", import.meta.url)
	/*
	 * `data/` is gitignored, so this file is a local artefact exactly like every other run AGENTS.md
	 * cites. If it is gone, the table in `TRUSTED_PROMPT`'s comment is standing on nothing — which is
	 * a real defect and is why this throws rather than skipping. The three scripts that produce it
	 * and the commands that drive them are in `data/eval/live-persona-ab-20260922.md`.
	 */
	const judged = JSON.parse(readFileSync(new URL("live-persona-ab-20260922-judged.json", dir), "utf8")) as {
		coachModel: string
		judgeModel: string
		lines: { arm: string; gameId: string; atSec: number; subject: string | null; useful: boolean | null; fabricated: boolean }[]
	}
	assert.equal(judged.coachModel, "claude-sonnet-5")
	// The judge is NOT the coach's model. See the self-preference measurement in AGENTS.md.
	assert.equal(judged.judgeModel, "claude-opus-5")
	assert.notEqual(judged.judgeModel, judged.coachModel)
	assert.equal(judged.lines.length, 886)
	assert.equal(new Set(judged.lines.map(l => l.gameId)).size, 30)

	const onTarget = (l: (typeof judged.lines)[number]): boolean =>
		(l.subject === "early-objective" && l.atSec < 600) ||
		(l.subject === "survival" && l.atSec >= 600 && l.atSec < 900)
	const count = (arm: string) => {
		const a = judged.lines.filter(l => l.arm === arm)
		return {
			lines: a.length,
			onTarget: a.filter(onTarget).length,
			gold: a.filter(l => l.subject === "unspent-gold").length,
			useful: a.filter(l => l.useful === true).length,
			fabricated: a.filter(l => l.fabricated).length
		}
	}
	assert.deepEqual(count("shipped"), { lines: 443, onTarget: 102, gold: 7, useful: 163, fabricated: 10 })
	assert.deepEqual(count("aimed"), { lines: 443, onTarget: 101, gold: 5, useful: 169, fabricated: 13 })
})
