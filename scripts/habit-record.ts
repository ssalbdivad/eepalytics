/**
 * THE HABIT, PRINTED — the tracker's own numbers, from the CLI, with no server and no model.
 *
 *     node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/habit-record.ts
 *       [--games 20] [--habit survive-10-15|early-objectives] [--all] [--out <file.json>]
 *
 * `--out` writes the record as JSON, which is how a baseline gets frozen: the habit tracker's
 * whole claim is that a rate MOVES, and a rate that was never written down before the tracker
 * shipped cannot be shown to have moved afterwards. `data/eval/habit-baseline-20260918.json` is
 * the ship-day record and, like everything in that directory, it is never rewritten — a later
 * comparison writes a NEW file beside it.
 *
 * Every number the card shows comes from `analysis/habit.ts`, which is pure, so this script and
 * the screen cannot disagree — and the record is re-derivable from the stored timelines forever,
 * which is the standing rule for anything this campaign measures. Read-only: it opens the
 * database with `readOnly: true` and touches no blob it does not parse.
 */

import { writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { useDb } from "../src/db/index.ts"
import { loadHabitRecord } from "../src/db/habit.ts"
import { evidenceSentence, HABITS, habitDef, HABIT_LIMIT } from "../src/analysis/habit.ts"
import { DB_PATH } from "../src/shared/constants.ts"

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}

useDb(new DatabaseSync(DB_PATH, { readOnly: true }))

const games = Number(arg("games", "20"))
const chosen =
	process.argv.includes("--all") ? HABITS : [habitDef(arg("habit", "survive-10-15"))]

const out = arg("out", "")
const written: unknown[] = []

const clock = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ")

for (const def of chosen) {
	const r = loadHabitRecord(def, games)
	console.log(`\n=== ${def.goal}`)
	console.log(`    ${def.label}`)
	console.log(`\n${r.note}`)
	console.log(`streak: ${r.streak} ${def.cleanLabel} in a row`)
	if (r.change) console.log(`change: ${r.change.note}`)
	console.log(`\nWHY THIS ONE: ${def.why}`)
	console.log(`EVIDENCE:     ${evidenceSentence(def)}`)
	console.log(`CAVEAT:       ${def.evidence.caveat}`)
	console.log(`LIMIT:        ${HABIT_LIMIT}`)
	console.log(`\n  ${"when".padEnd(17)}${"champion".padEnd(14)}${"W/L".padEnd(5)}value  verdict`)
	for (const g of r.games) {
		const verdict =
			g.clean === null ? `— ${g.excluded}`
			: g.clean ? def.cleanLabel
			: def.dirtyLabel
		console.log(
			`  ${clock(g.createdMs).padEnd(17)}${g.championName.padEnd(14)}${(g.win ? "W" : "L").padEnd(5)}${String(g.value ?? "—").padEnd(7)}${verdict}`
		)
	}
	console.log(`\ncounted ${r.counted} of ${r.games.length} games in the window`)
	written.push({ ...r, evidenceSentence: evidenceSentence(def), limit: HABIT_LIMIT })
}

if (out !== "") {
	writeFileSync(
		out,
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				script: "scripts/habit-record.ts",
				window: games,
				queue: "ranked solo (420) only — the population the measurement was taken on",
				records: written
			},
			null,
			"\t"
		) + "\n"
	)
	console.log(`\nwrote ${out}`)
}
