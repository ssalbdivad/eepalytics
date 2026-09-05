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
const SUBJECT: Record<PremiseKind["kind"], string> = {
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

const runs = (subjects: string[]): { sameTwiceRunning: number; longest: number; longestSubject: string } => {
	let sameTwiceRunning = 0
	let run = 0
	let longest = 0
	let longestSubject = ""
	for (let i = 0; i < subjects.length; i++) {
		if (i > 0 && subjects[i] === subjects[i - 1]) {
			sameTwiceRunning++
			run++
		} else run = 1
		if (run > longest) {
			longest = run
			longestSubject = subjects[i]!
		}
	}
	return { sameTwiceRunning, longest, longestSubject }
}

const main = async (): Promise<void> => {
	const turnSec = Number(arg("turn", "20"))
	const out = arg("out", "")
	const dir = `${DATA_DIR}/live-samples`
	const games = readdirSync(dir).filter(f => /^split-\d+\.ndjson$/.test(f)).sort()

	const offers: Offer[] = []
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

		const mine: Offer[] = []
		let turns = 0
		let last = -1e9
		for (const row of rows) {
			if (row.gameTime - last < turnSec) continue
			last = row.gameTime
			const state: VisionState | null = mod.buildLiveStateForBench(row.data, row.gameTime)
			if (!state) continue
			turns++
			for (const o of state.schedule ?? []) {
				if (o.retired) continue
				mine.push({
					game,
					atSec: row.gameTime,
					subject: `objective:${o.name}`,
					from: "schedule",
					text: `${o.name} ${o.state} ${o.sec}s`
				})
			}
			for (const text of state.unseen)
				mine.push({ game, atSec: row.gameTime, subject: SUBJECT[premiseOf(text).kind], from: "ranked", text })
		}
		offers.push(...mine)

		const r = runs(mine.map(o => o.subject))
		const sched = mine.filter(o => o.from === "schedule").length
		const counts = new Map<string, number>()
		for (const o of mine) counts.set(o.subject, (counts.get(o.subject) ?? 0) + 1)
		const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
		perGame.push({
			game,
			turns,
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

	const all = runs(offers.map(o => o.subject))
	console.log(
		`\n  TOTAL     ${String(perGame.reduce((n, g) => n + (g.turns as number), 0)).padStart(5)} ${String(
			offers.length
		).padStart(7)} ${String(offers.filter(o => o.from === "schedule").length).padStart(5)} ${String(
			offers.filter(o => o.from === "ranked").length
		).padStart(6)} ${String(all.sameTwiceRunning).padStart(9)}`
	)

	const counts = new Map<string, number>()
	for (const o of offers) counts.set(o.subject, (counts.get(o.subject) ?? 0) + 1)
	console.log("\n## every subject, pooled\n")
	for (const [s, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]))
		console.log(`  ${s.padEnd(24)} ${String(n).padStart(4)}  ${((100 * n) / offers.length).toFixed(1)}%`)

	if (out !== "") {
		if (!existsSync(`${DATA_DIR}/eval`)) mkdirSync(`${DATA_DIR}/eval`, { recursive: true })
		writeFileSync(out, JSON.stringify({ turnSec, perGame, offers }, null, "\t"))
		console.log(`\nwrote ${out}`)
	}
}

if (import.meta.main) await main()
