/**
 * Does the coach keep asking a question it has already answered?
 *
 *     node --experimental-strip-types scripts/measure-retirement.ts
 *     node --experimental-strip-types scripts/measure-retirement.ts --turn 20 --out data/eval/retirement.json
 *
 * ## Why this file exists
 *
 * Four models judged the briefing blind and all four named the same fault in different words: the
 * block's monotone fact used to be *you are ahead of Briar on CS* — true on every turn of all four
 * recorded games — and it is now *an objective is up or coming*, true on almost every turn of any
 * game. Opus: "the subject changed; the metronome did not." 43 of 72 sonnet lines were the dragon,
 * and the soul/baron pair switched on at 19:42 and was still being read out at 36:43.
 *
 * A judge run costs money and needs a model. This does not: it replays the four recorded games
 * through the daemon's OWN path (`buildLiveStateForBench` -> `buildLiveState` -> `buildFacts` and
 * `objectiveSchedule`) and counts what the context OFFERS, because the coach may only speak from
 * what it is offered. It cannot tell you whether a line was useful. It can tell you, exactly,
 * whether the same subject was put in front of the model twice running and how long the longest
 * unbroken run of one subject was — which is the shape of the fault every judge described.
 *
 * One module instance per game, by import query, because `routes/live.ts` keeps its fact memory at
 * module scope: replaying four games through one import carries game one's rate limits into game
 * two. Same trick and same reason as `scripts/measure-staleness.ts`.
 *
 * ## What counts as a "line offered"
 *
 * Both halves of the context, because both reach him as speech:
 *
 *   - every entry the schedule renders, labelled `objective:<name>` — the model reads these out
 *     directly, and that is where the metronome now lives;
 *   - every fact `buildFacts` ranks, labelled from `analysis/timeliness.ts`'s premise parser, which
 *     is the same lexical classifier `scripts/measure-staleness.ts` uses for tiers.
 *
 * Within a turn they are counted in block order — schedule first, then the ranked list — because
 * that is the order they are read in.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { DATA_DIR } from "../src/shared/constants.ts"
import { premiseOf } from "../src/analysis/timeliness.ts"
import type { PremiseKind } from "../src/analysis/timeliness.ts"
import type { VisionState } from "../src/shared/live-state.ts"
import { baselineFromRows, perGameMetrics } from "../src/analysis/index.ts"
import { loadCorpus } from "../src/daemon/corpus.ts"

const arg = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}

/**
 * A rendered fact, reduced to what the man hearing it would call the subject.
 *
 * Deliberately COARSER than `FactSubject`: he does not hear "the farm-pace fact" and "the
 * counterpart-CS fact", he hears someone talking about his farm again — the same argument
 * `live-facts.ts` makes where it defines `FactSubject`, applied one level further.
 */
const SUBJECT: Record<PremiseKind, string> = {
	window: "downed",
	"jungler-down": "downed",
	"objective-timer": "objective-timer",
	"objective-lost": "objective-lost",
	fight: "fight",
	gold: "gold",
	race: "farm",
	"farm-pace": "farm",
	levels: "levels",
	"objective-count": "objectives",
	"kill-share": "kill-share",
	build: "build",
	praise: "praise",
	"my-death": "your-death",
	unknown: "unknown"
}

interface Offer {
	game: string
	atSec: number
	subject: string
	text: string
	/** `schedule` or `ranked` — which half of the context it came from. */
	from: "schedule" | "ranked"
}

/**
 * The two numbers, computed PER SUBJECT over the sequence of turns.
 *
 * Not over the flattened list of offers: a turn hands the model three or four items at once and
 * they are all different, so an adjacency count over the flat list reports almost no repetition
 * while the same objective sits in every single block. The fault the judges named is a subject that
 * is in front of him on turn after turn — "the soul/baron pair switched on at 19:42 and was still
 * being read out at 36:43, eighteen turns later" — so the unit is the TURN.
 *
 * `sameTwiceRunning` counts every offer that repeats a subject the previous turn already carried.
 * `longest` is the longest unbroken run of turns carrying one subject.
 */
const runs = (
	turns: string[][]
): { sameTwiceRunning: number; longest: number; longestSubject: string; bySubject: Map<string, { turns: number; longest: number }> } => {
	let sameTwiceRunning = 0
	const bySubject = new Map<string, { turns: number; longest: number }>()
	const run = new Map<string, number>()
	for (let i = 0; i < turns.length; i++) {
		const here = new Set(turns[i] ?? [])
		const before = new Set(i > 0 ? (turns[i - 1] ?? []) : [])
		for (const s of here) {
			const n = (run.get(s) ?? 0) * (before.has(s) ? 1 : 0) + 1
			run.set(s, n)
			if (before.has(s)) sameTwiceRunning++
			const rec = bySubject.get(s) ?? { turns: 0, longest: 0 }
			rec.turns++
			if (n > rec.longest) rec.longest = n
			bySubject.set(s, rec)
		}
		for (const s of run.keys()) if (!here.has(s)) run.set(s, 0)
	}
	let longest = 0
	let longestSubject = ""
	for (const [s, rec] of bySubject)
		if (rec.longest > longest) {
			longest = rec.longest
			longestSubject = s
		}
	return { sameTwiceRunning, longest, longestSubject, bySubject }
}

const main = async (): Promise<void> => {
	const turnSec = Number(arg("turn", "20"))
	const out = arg("out", "")
	const dir = `${DATA_DIR}/live-samples`
	const games = readdirSync(dir).filter(f => /^split-\d+\.ndjson$/.test(f)).sort()

	const offers: Offer[] = []
	const allTurns: string[][] = []
	const perGame: Record<string, unknown>[] = []

	for (const file of games) {
		const game = file.replace(".ndjson", "")
		const mod = (await import(
			`../src/server/routes/live.ts?retirement=${game}`
		)) as typeof import("../src/server/routes/live.ts")
		const rows = readFileSync(`${dir}/${file}`, "utf8")
			.split("\n")
			.filter(l => l.trim() !== "")
			.map(l => JSON.parse(l) as { atMs: number; gameTime: number; data: unknown })

		/*
		 * HIS FARM BASELINE, as the daemon would have held it DURING this game.
		 *
		 * Without one `pace` is null, and the whole farm-and-race family of facts — the family this
		 * app's repetition problem was originally about — cannot fire at all. A replay with no
		 * baseline reports zero farm lines and looks like a coach that has stopped nagging about
		 * farm, which would be a flattering lie about this change.
		 *
		 * Games created AFTER the recording are excluded, the same rule and the same reason as
		 * `scripts/build-fixture.ts`: letting the future set the average produces a number that
		 * never existed at the time.
		 */
		const startedMs = rows[0]?.atMs ?? 0
		const corpus = loadCorpus(200)
			.filter(e => startedMs === 0 || Number(e.row.gameCreationMs) < startedMs)
			.slice(0, 20)
		const baseline = corpus.length > 0 ? baselineFromRows(perGameMetrics(corpus)) : null

		const mine: Offer[] = []
		const turnSubjects: string[][] = []
		let turns = 0
		let last = -1e9
		for (const row of rows) {
			if (row.gameTime - last < turnSec) continue
			last = row.gameTime
			const state: VisionState | null = mod.buildLiveStateForBench(row.data, row.gameTime, baseline)
			if (!state) continue
			turns++
			const here: string[] = []
			turnSubjects.push(here)
			for (const o of state.schedule ?? []) {
				if (o.retired) continue
				here.push(`objective:${o.name}`)
				mine.push({
					game,
					atSec: row.gameTime,
					subject: `objective:${o.name}`,
					from: "schedule",
					text: `${o.name} ${o.state} ${o.sec}s`
				})
			}
			for (const text of state.unseen) {
				here.push(SUBJECT[premiseOf(text).kind])
				mine.push({ game, atSec: row.gameTime, subject: SUBJECT[premiseOf(text).kind], from: "ranked", text })
			}
		}
		offers.push(...mine)

		const r = runs(turnSubjects)
		allTurns.push(...turnSubjects, [])
		const sched = mine.filter(o => o.from === "schedule").length
		const counts = new Map<string, number>()
		for (const o of mine) counts.set(o.subject, (counts.get(o.subject) ?? 0) + 1)
		const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
		perGame.push({
			game,
			turns,
			baselineGames: corpus.length,
			offered: mine.length,
			schedule: sched,
			ranked: mine.length - sched,
			sameTwiceRunning: r.sameTwiceRunning,
			longestRun: r.longest,
			longestSubject: r.longestSubject,
			top: top.map(([s, n]) => `${s} ${n}`).join(", ")
		})
	}

	console.log(`## ${offers.length} context items offered over ${games.length} games at ${turnSec}s turns\n`)
	console.log(
		`  ${"game".padEnd(9)} ${"turns".padStart(5)} ${"offered".padStart(7)} ${"sched".padStart(5)} ${"ranked".padStart(6)} ${"2-running".padStart(9)} ${"longest".padStart(7)}  top subjects`
	)
	for (const g of perGame)
		console.log(
			`  ${String(g.game).padEnd(9)} ${String(g.turns).padStart(5)} ${String(g.offered).padStart(7)} ${String(
				g.schedule
			).padStart(5)} ${String(g.ranked).padStart(6)} ${String(g.sameTwiceRunning).padStart(9)} ${`${g.longestRun}×${String(
				g.longestSubject
			).replace("objective:", "")}`.padStart(7)}  ${g.top}`
		)

	const all = runs(allTurns)
	console.log(
		`\n  TOTAL     ${String(perGame.reduce((n, g) => n + (g.turns as number), 0)).padStart(5)} ${String(
			offers.length
		).padStart(7)} ${String(offers.filter(o => o.from === "schedule").length).padStart(5)} ${String(
			offers.filter(o => o.from === "ranked").length
		).padStart(6)} ${String(all.sameTwiceRunning).padStart(9)}`
	)

	console.log("\n## every subject, pooled — turns it was offered on, and its longest unbroken run\n")
	const total = allTurns.length
	for (const [s, rec] of [...all.bySubject.entries()].sort((a, b) => b[1].turns - a[1].turns))
		console.log(
			`  ${s.padEnd(24)} ${String(rec.turns).padStart(4)} turns  ${((100 * rec.turns) / total).toFixed(1).padStart(5)}% of turns   longest run ${rec.longest}`
		)

	if (out !== "") {
		if (!existsSync(`${DATA_DIR}/eval`)) mkdirSync(`${DATA_DIR}/eval`, { recursive: true })
		writeFileSync(out, JSON.stringify({ turnSec, perGame, offers }, null, "\t"))
		console.log(`\nwrote ${out}`)
	}
}

if (import.meta.main) await main()
