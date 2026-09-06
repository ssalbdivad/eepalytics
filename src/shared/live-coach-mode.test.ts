/**
 * The two claims `live-coach-mode.ts` rests on, and neither is about arithmetic.
 *
 * 1. **The shipped cite-or-quiet prompt IS the measured one.** The whole reason to change the
 *    coach's architecture tonight is a run over 363 real samples in which one specific wording
 *    spoke on 94 of 102 turns with zero fabrications. A prompt that has since been "improved" by
 *    a paragraph is a prompt that was never measured, and the run stops justifying it — silently,
 *    because a reworded prompt still looks exactly like the one in the results file. So the text
 *    is asserted byte-for-byte against `scripts/ablate-autonomy.ts`'s own `ARMS` export.
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
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { ARMS, championKnowledge } from "../../scripts/ablate-autonomy.ts"
import { isBannedDirective } from "../analysis/directive.ts"
import { parseChampionClauses } from "./champion-advice.ts"
import {
	CITE_BLOCK_REPAIRS,
	CITE_PERSONA,
	CITE_RULE,
	DEFAULT_LIVE_COACH_MODE,
	LIVE_COACH_MODES,
	downLine,
	liveCoachSystemPrompt,
	renderBlockForMode,
	renderChampionKnowledge,
	withoutBannedClauses
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
	counterpart: { champion: "Briar", cs: 111, level: 9 },
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

test("champion knowledge renders exactly as the ablation rendered it", () => {
	const md = readFileSync("knowledge/champions/lillia.md", "utf8")
	assert.equal(renderChampionKnowledge("Lillia", parseChampionClauses(md)), championKnowledge("Lillia"))
})

test("champion knowledge reaches the prompt and carries no digits", () => {
	const md = readFileSync("knowledge/champions/lillia.md", "utf8")
	const knowledge = renderChampionKnowledge("Lillia", parseChampionClauses(md))
	assert.equal(knowledge.length > 0, true, "lillia.md parsed to nothing — the clause format moved")
	assert.equal(liveCoachSystemPrompt({ mode: "cite-or-quiet", championKnowledge: knowledge }).endsWith(knowledge), true)
	// The one rule that keeps this honest by construction rather than by obedience.
	const clauses = knowledge.split("\n").filter(l => l.startsWith("- ("))
	for (const c of clauses) assert.equal(/[0-9]/.test(c), false, `a digit reached the prompt: ${c}`)
})

test("the briefing's champion menu does not contain the orders the briefing bans", () => {
	const md = readFileSync("knowledge/champions/lillia.md", "utf8")
	const knowledge = renderChampionKnowledge("Lillia", parseChampionClauses(md))
	const clause = (l: string): string => l.replace(/^- \([^)]*\) /, "")
	const all = knowledge.split("\n").filter(l => l.startsWith("- ("))
	// The hole this closes: half of Lillia's own menu IS the three banned orders, verbatim.
	assert.equal(
		all.some(l => isBannedDirective(clause(l))),
		true,
		"nothing in the menu classifies as banned — either the file or the classifier moved"
	)
	const briefing = liveCoachSystemPrompt({ mode: "briefing", championKnowledge: knowledge })
	for (const l of all)
		assert.equal(
			briefing.includes(l),
			!isBannedDirective(clause(l)),
			`the briefing prompt ${isBannedDirective(clause(l)) ? "still offers" : "dropped"}: ${l}`
		)
	// The kinds survive the cut: race-behind loses two of four clauses and keeps two.
	assert.equal(withoutBannedClauses(knowledge).includes("(race-behind)"), true)
})

test("the two measured control arms keep the menu they were measured with", () => {
	const md = readFileSync("knowledge/champions/lillia.md", "utf8")
	const knowledge = renderChampionKnowledge("Lillia", parseChampionClauses(md))
	assert.equal(liveCoachSystemPrompt({ mode: "cite-or-quiet", championKnowledge: knowledge }).endsWith(knowledge), true)
	assert.equal(liveCoachSystemPrompt({ mode: "fenced", championKnowledge: knowledge }), LIVE_COACH_SYSTEM_PROMPT)
})

test("a menu whose every clause is banned renders no section rather than an empty heading", () => {
	const allBanned = renderChampionKnowledge("Nobody", {
		"race-behind": ["your clear only gets faster while it keeps running, so finish the whole route"],
		"fight-lost": ["your damage arrives over time, so take the long fights with room to kite"]
	} as never)
	assert.equal(withoutBannedClauses(allBanned), "")
	assert.equal(withoutBannedClauses(""), "")
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
	for (const fact of ["88 CS against 96", "111 CS", "1017 gold", "Briar", "Urgot", "Ornn", "Clock 9:40"])
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

test("the briefing is the default and every mode is accepted by the schema", () => {
	assert.equal(DEFAULT_LIVE_COACH_MODE, "briefing")
	assert.equal(DEFAULT_SETTINGS.liveCoachMode, "briefing")
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
	assert.deepEqual(LIVE_COACH_MODES.map(m => m.id).sort(), ["briefing", "cite-or-quiet", "fenced"])
})
