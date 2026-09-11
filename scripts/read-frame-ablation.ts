/**
 * What did the frame/no-frame ablation actually say, and does the picture change the coaching?
 *
 * ## The question this still answers, and why it needs a file of its own
 *
 * `data/eval/` holds four runs in one shape — `{ kind: "e2e-real-game-run", results: [...] }` —
 * written by `scripts/e2e-real-game.ts`. That script was deleted on 2026-09-11 because
 * `bench-stream.ts` supersedes it as an INSTRUMENT: e2e-real-game replayed ONE frozen fixture of
 * one game through one provider, and bench-stream replays the raw recorded samples of any game at
 * every model at once, pairs each state with the journal frame for that same instant, and carries
 * a `+noframe` twin of any arm — the same ablation, wider, on states nobody had to freeze first.
 *
 * Deleting its READER was not on. The standing rule here is that a stored measurement is never
 * deleted or rewritten and every run in `data/eval/` stays re-scorable, and those four files
 * became unreadable the moment their writer left the tree. This is the reader that was owed, on
 * the same principle as `scripts/rescore-runs.ts` for the runs `eval-live.ts` left behind.
 *
 * ## What it prints, and the one table to read
 *
 * Frames exist for only part of a game — in the frozen fixture, 0:02 to 6:43 of a 36:49 game — so
 * the whole-run table compares laning phase against a whole game and is NOT an arm comparison.
 * The table to read is the one restricted to the checkpoints both arms answered, and under it the
 * pair-by-pair ablation with its control: a model at its default temperature paraphrases ITSELF,
 * so a frame arm that differs from the text arm no more than the text arm differs from a second
 * sample of itself is a frame that is not being read.
 *
 * It cannot re-run the model, and that is deliberate rather than a gap. The turns in these files
 * came off a frozen fixture that can no longer be rebuilt; replaying them would reproduce the
 * instrument, not the measurement. To ask a model a new question, use `bench-stream.ts`.
 *
 * Usage:
 *     node --experimental-strip-types scripts/read-frame-ablation.ts data/eval/run-judge-A.json
 *     node --experimental-strip-types scripts/read-frame-ablation.ts --all
 *
 *     --all   every file in data/eval/ carrying `kind: "e2e-real-game-run"`, newest last
 *
 * NODE ONLY. Reads stored files only; makes no network call and spends nothing.
 */

import { readFileSync, readdirSync } from "node:fs"
import { DATA_DIR } from "../src/shared/constants.ts"
import { MIN_SIGNIFICANT, numbersIn } from "../src/analysis/coach-score.ts"
import type { LineScore } from "../src/analysis/coach-score.ts"

const pct = (k: number, n: number): string => (n === 0 ? "  -  " : `${((100 * k) / n).toFixed(0).padStart(3)}%`)

export interface PairComparison {
	pairs: number
	/** Neither said anything — PASS, or nothing at all. */
	bothQuiet: number
	oneSpoke: number
	/** Of those, how many were the FIRST-listed arm speaking alone. */
	onlyFirstSpoke: number
	bothSpoke: number
	identical: number
	sameSubject: number
	/** The same set of significant figures, so a paraphrase does not read as a new claim. */
	sameNumbers: number
	contentDiffered: number
}

/**
 * How two arms differ, over the checkpoints they share.
 *
 * Word-for-word equality is the wrong measure on its own and the first real run of this harness
 * showed why: 2 of 3 frame/no-frame pairs differed, and both differences were pure paraphrase off
 * the SAME single ranked fact — "be where they are before the next one starts" against "group up
 * before the next one starts". A model at its default temperature does that to itself.
 *
 * So content is compared as well: the coarse subject, and the set of significant figures cited
 * (`numbersIn` normalises "two for zero" to `2 0`, which matters here because the frame arm
 * happened to spell its numbers out). Two lines that cite the same figures about the same subject
 * are the same coaching, however differently worded.
 *
 * A pair where either turn FAILED is dropped from the comparison entirely and does not reach
 * `pairs` — a provider error is not a difference between the arms. The failures are still in the
 * file and still in the summary above.
 */
export const comparePairs = (pairs: readonly (readonly [TurnResult, TurnResult])[]): PairComparison => {
	const out: PairComparison = {
		pairs: 0,
		bothQuiet: 0,
		oneSpoke: 0,
		onlyFirstSpoke: 0,
		bothSpoke: 0,
		identical: 0,
		sameSubject: 0,
		sameNumbers: 0,
		contentDiffered: 0
	}
	const sig = (t: string): string =>
		[...new Set(numbersIn(t).filter(n => n >= MIN_SIGNIFICANT))].sort((a, b) => a - b).join(",")
	for (const [a, b] of pairs) {
		if (!a.ok || !b.ok) continue
		out.pairs++
		const aq = a.silent || a.empty
		const bq = b.silent || b.empty
		if (aq && bq) {
			out.bothQuiet++
			continue
		}
		if (aq !== bq) {
			out.oneSpoke++
			if (bq) out.onlyFirstSpoke++
			continue
		}
		out.bothSpoke++
		const same = a.text.trim() === b.text.trim()
		if (same) out.identical++
		if (a.subject === b.subject) out.sameSubject++
		if (sig(a.text) === sig(b.text)) out.sameNumbers++
		if (!same && (a.subject !== b.subject || sig(a.text) !== sig(b.text))) out.contentDiffered++
	}
	return out
}


export interface TurnResult {
	id: string
	tSec: number
	clock: string
	sampleLine: number
	/** `frame` or `no-frame`. The two arms of the ablation. */
	arm: "frame" | "no-frame"
	/** 1-based, so repeats of the same arm at the same checkpoint stay distinguishable. */
	attempt: number
	frameSent: boolean
	framePath: string | null
	frameSkewSec: number | null
	frameBytes: number | null
	/** The block that went to the model, re-rendered by the shipped path this run. */
	block: string
	/** False when the re-render differs from the frozen fixture — see `--allow-block-drift`. */
	blockMatchesFixture: boolean
	facts: string[]
	roster: string[]
	provider: string
	model: string
	ok: boolean
	text: string
	latencyMs: number
	reason: string | null
	/** PASS. Not the same as empty — see `coach-score.ts`. */
	silent: boolean
	empty: boolean
	subject: string
	score: LineScore | null
}


/**
 * What came back, in the units he experiences.
 *
 * The rates are here because they are the cheap part, and the SENTENCES are here because for weeks
 * the rates were the only thing anyone looked at and they said the coach was fine. A talkativeness
 * figure cannot show that every line was about gold; only reading the lines can.
 */
export const summarize = (file: RunFile): void => {
	const arms = [...new Set(file.results.map(r => r.arm))].sort()
	const perMin = (spoke: number, turns: number): string =>
		turns === 0 ? "-" : ((spoke / turns) * (60_000 / file.turnCadenceMs)).toFixed(1)

	const armTable = (rows: TurnResult[]): void => {
		console.log("arm        turns  failed  silent  empty   spoke   lines/min   median ms   faults")
		for (const arm of arms) {
			const a = rows.filter(r => r.arm === arm)
			if (a.length === 0) continue
			const okRows = a.filter(r => r.ok)
			const spoke = okRows.filter(r => !r.silent && !r.empty)
			const lat = a.map(r => r.latencyMs).sort((x, y) => x - y)
			const faults = okRows.filter(r => (r.score?.faults.length ?? 0) > 0).length
			console.log(
				`${arm.padEnd(9)} ${String(a.length).padStart(6)}  ` +
					`${String(a.length - okRows.length).padStart(6)}  ` +
					`${pct(okRows.filter(r => r.silent).length, okRows.length)}   ` +
					`${pct(okRows.filter(r => r.empty).length, okRows.length)}  ` +
					`${pct(spoke.length, okRows.length)}   ` +
					`${perMin(spoke.length, okRows.length).padStart(9)}   ` +
					`${String(lat[Math.floor(lat.length / 2)] ?? 0).padStart(9)}   ` +
					`${String(faults).padStart(6)}`
			)
		}
	}
	const mixLine = (rows: TurnResult[]): void => {
		const subjects = [...new Set(rows.filter(r => r.ok && !r.silent && !r.empty).map(r => r.subject))]
		for (const arm of arms) {
			const spoke = rows.filter(r => r.arm === arm && r.ok && !r.silent && !r.empty)
			const mix = subjects
				.map(s => ({ s, n: spoke.filter(r => r.subject === s).length }))
				.filter(x => x.n > 0)
				.sort((a, b) => b.n - a.n)
			console.log(`  ${arm.padEnd(9)} ${mix.map(x => `${x.s} ${x.n}`).join("  ") || "(said nothing)"}`)
		}
	}

	console.log(`\n${"=".repeat(96)}\nWHAT CAME BACK  ${file.provider} ${file.model}\n`)
	console.log("EVERY TURN — the whole game, as the coach would have experienced it")
	armTable(file.results)
	console.log(
		`\n(lines/min assumes the shipped ${file.turnCadenceMs / 1000}s turn cadence from ` +
			`DEFAULT_TURN_MS in src/web/lib/geminiLive.ts)`
	)
	console.log("\nWHAT IT TALKED ABOUT")
	mixLine(file.results)

	/*
	 * The two arms again, restricted to the checkpoints they SHARE — and this table is the one to
	 * read, not the one above.
	 *
	 * Frames exist only from 0:02 to 6:43 of a 36:49 game, so the frame arm runs on 42 early-game
	 * instants and the no-frame arm on all 140. Measured on the first full run, the top table read
	 * "frame 93% silent, no-frame 84% silent", which looks like the picture making the coach
	 * quieter and is nothing of the kind: it is laning phase against the whole game. On the shared
	 * 42 both arms were 93%. A rate compared across different halves of a game is not a comparison.
	 */
	const pairedIds = new Set(file.results.filter(r => r.arm === "frame").map(r => r.id))
	if (pairedIds.size > 0 && pairedIds.size < new Set(file.results.map(r => r.id)).size) {
		const shared = file.results.filter(r => pairedIds.has(r.id))
		console.log(
			`\nTHE SAME ${pairedIds.size} CHECKPOINTS, BOTH ARMS — the only fair arm-vs-arm comparison\n` +
				`(frames exist only from ${file.results.find(r => r.arm === "frame")?.clock ?? "?"} to ` +
				`${[...file.results].reverse().find(r => r.arm === "frame")?.clock ?? "?"}; the rows above ` +
				`compare laning phase against a whole game)`
		)
		armTable(shared)
		mixLine(shared)
	}

	/* -- the ablation, pair by pair ------------------------------------------- */
	const frameRows = file.results.filter(r => r.arm === "frame")
	if (frameRows.length > 0) {
		/*
		 * Pair two sets of turns by checkpoint.
		 *
		 * `sameAttempt` is the difference between the experiment and its control. The two ARMS are
		 * paired within one attempt, because they were sent back to back and share everything but
		 * the picture. The control pairs one arm against ITSELF across two attempts, so it must
		 * ignore the attempt number or it would match nothing — which it silently did on the first
		 * version of this code, printing a control of zero pairs that looked like a real result.
		 */
		const pairsFor = (
			a: TurnResult[],
			b: TurnResult[],
			sameAttempt: boolean
		): [TurnResult, TurnResult][] => {
			const key = (r: TurnResult): string => (sameAttempt ? `${r.id}#${r.attempt}` : r.id)
			const bi = new Map(b.map(r => [key(r), r]))
			const out: [TurnResult, TurnResult][] = []
			for (const x of a) {
				const y = bi.get(key(x))
				if (y && x !== y) out.push([x, y])
			}
			return out
		}
		const noFrameRows = file.results.filter(r => r.arm === "no-frame")
		const table = (label: string, pairs: [TurnResult, TurnResult][]): void => {
			const cmp = comparePairs(pairs)
			console.log(`  ${label}`)
			console.log(`    pairs compared             ${cmp.pairs}`)
			console.log(`    both stayed quiet          ${cmp.bothQuiet}`)
			console.log(`    one spoke, one did not     ${cmp.oneSpoke}  (first-listed arm only: ${cmp.onlyFirstSpoke})`)
			console.log(`    both spoke                 ${cmp.bothSpoke}`)
			console.log(`      word for word identical  ${cmp.identical}`)
			console.log(`      same subject             ${cmp.sameSubject}`)
			console.log(`      same numbers cited       ${cmp.sameNumbers}`)
			console.log(`      differed in CONTENT      ${cmp.contentDiffered}`)
			// A zero here is not a result, it is a broken join. The first version of the control
			// keyed on the attempt number and matched nothing, and printed a clean table of zeroes.
			if (cmp.pairs === 0) console.log("    ^ NO COMPARABLE PAIRS — this table is not a result")
		}
		console.log("\nTHE ABLATION  (same block, same prompt, same model; only the picture differs)")
		table("frame vs no-frame", pairsFor(frameRows, noFrameRows, true))

		/*
		 * The control, and without it the ablation is unreadable.
		 *
		 * Measured on the first real run of this harness: 2 of 3 frame/no-frame pairs "differed",
		 * and both differences were paraphrase — "be where they are" against "group up", off the
		 * same single ranked fact. A model at its default temperature differs from ITSELF that
		 * much. So the honest question is not whether the frame arm differs from the text arm, it
		 * is whether it differs MORE than the text arm differs from a second sample of itself.
		 *
		 * Needs --repeats 2 or more, because that is where a second sample of the same arm comes
		 * from. Said plainly rather than skipped silently.
		 */
		if (file.repeats > 1) {
			const byAttempt = (rows: TurnResult[], n: number): TurnResult[] =>
				rows.filter(r => r.attempt === n)
			table(
				"\n  CONTROL: no-frame vs no-frame, two samples of the SAME arm",
				pairsFor(byAttempt(noFrameRows, 1), byAttempt(noFrameRows, 2), false)
			)
		} else {
			console.log(
				"\n  NO CONTROL RUN. A model at its default temperature paraphrases itself, so a" +
					"\n  difference above is not yet evidence the picture was read. Re-run with --repeats 2" +
					"\n  to get the no-frame-vs-no-frame control this needs."
			)
		}
		console.log(
			"\n  A frame arm that differs from the text arm no more than the text arm differs from" +
				"\n  ITSELF is a frame that is not being read. Whether a difference is an IMPROVEMENT is" +
				"\n  not a question this can answer — run --judge against the labels."
		)
	}

	/* -- the sentences -------------------------------------------------------- */
	console.log(`\n${"=".repeat(96)}\nTHE ACTUAL SENTENCES\n`)
	const byCp = new Map<string, TurnResult[]>()
	for (const r of file.results) byCp.set(r.id, [...(byCp.get(r.id) ?? []), r])
	for (const [id, rows] of [...byCp].sort((a, b) => a[1][0]!.tSec - b[1][0]!.tSec)) {
		console.log(`${id}  ${rows[0]!.clock}   facts: ${rows[0]!.facts.length === 0 ? "(none — PASS is correct)" : rows[0]!.facts.map(f => `"${f}"`).join(" | ")}`)
		for (const r of rows) {
			const faults = r.score?.faults ?? []
			const said =
				!r.ok ? `FAILED ${r.reason ?? "unknown"}`
				: r.silent ? "PASS"
				: r.empty ? "(nothing came back at all)"
				: r.text.replace(/\s+/g, " ")
			console.log(
				`   ${r.arm.padEnd(8)} ${said}${faults.length > 0 ? `   [${faults.join(", ")}]` : ""}`
			)
		}
	}

	const failed = file.results.filter(r => !r.ok)
	if (failed.length > 0) {
		console.log(`\n${failed.length} TURNS FAILED — these are in the file too, never dropped:`)
		const why = new Map<string, number>()
		for (const f of failed) why.set(f.reason ?? "unknown", (why.get(f.reason ?? "unknown") ?? 0) + 1)
		for (const [reason, n] of [...why].sort((a, b) => b[1] - a[1]))
			console.log(`  ${String(n).padStart(4)}x  ${reason}`)
	}
	const drifted = file.results.filter(r => !r.blockMatchesFixture)
	if (drifted.length > 0)
		console.log(
			`\nWARNING: ${drifted.length} turns ran on a block that does NOT match the frozen fixture ` +
				`(--allow-block-drift). Do not compare this run against one that did.`
		)
}


/* ======================================================================= main */

/**
 * The run file, as it sits on disk.
 *
 * Declared here rather than validated with ArkType on purpose: these four files are FROZEN, the
 * shape is whatever the writer wrote in September 2026, and a schema added afterwards would be a
 * new opinion about an old measurement. The reader only reads.
 */
export interface RunFile {
	kind: "e2e-real-game-run"
	stamp: string
	fixture: string
	gameId: string
	provider: string
	model: string
	promptSha256: string
	shippedProvider: string
	turnCadenceMs: number
	baselineGames: number
	repeats: number
	notes: string[]
	results: TurnResult[]
}

export const isFrameAblationRun = (path: string): boolean => {
	try {
		return (JSON.parse(readFileSync(path, "utf8")) as { kind?: string }).kind === "e2e-real-game-run"
	} catch {
		return false
	}
}

const main = (): void => {
	const argv = process.argv.slice(2)
	const dir = `${DATA_DIR}/eval`
	const paths =
		argv[0] === "--all" ?
			readdirSync(dir)
				.filter(f => f.endsWith(".json"))
				.map(f => `${dir}/${f}`)
				.filter(isFrameAblationRun)
				.sort()
		: argv.filter(a => !a.startsWith("--"))
	if (paths.length === 0)
		throw new Error("usage: read-frame-ablation.ts <run.json> | --all")
	for (const p of paths) {
		const file = JSON.parse(readFileSync(p, "utf8")) as RunFile
		if (file.kind !== "e2e-real-game-run")
			throw new Error(`${p} is not an e2e-real-game-run — kind is ${String(file.kind)}`)
		console.log(`\n${"#".repeat(96)}\n# ${p}  ${file.stamp}  game ${file.gameId}  prompt sha ${file.promptSha256.slice(0, 12)}`)
		summarize(file)
	}
}

if (import.meta.main) main()
