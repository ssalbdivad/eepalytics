/**
 * judge-corpus — grade every line a `bench-stream --games ...` run spoke, blinded, and report the
 * rates PER GAME as well as pooled.
 *
 * ## Why this is not `frame-value.ts --rejudge`
 *
 * That judge grades a line against its own real SCREENSHOT, so it only runs on a paired window and
 * only on frame-value's own run shape. Thirteen of this corpus's seventeen games have no frames at
 * all — the browser was closed and the daemon's own poll recorded the game anyway — and those are
 * the games that carry thirteen different enemy junglers, which is the only real test the champion
 * knowledge has ever had. Refusing to grade them because there is no picture would be measuring the
 * four games we already over-measured.
 *
 * So this grades against the PAYLOAD alone: the block the coach actually held, stored verbatim in
 * the run file. That is a weaker judge and the report says so — `contradicted-by-picture` is not a
 * verdict it can reach, so its `false` rate is a FLOOR, not the truth.
 *
 * ## Blinding, and why it is not optional here
 *
 * Every percentage this project has produced from a judge that knew what it was grading has later
 * had to be walked back. So: the arm label is stripped, the lines are shuffled with a seeded
 * generator whose seed is written into the output, and the judge is a different model family from
 * the coach that spoke. The key from opaque id back to (arm, game, clock) is rejoined by code after
 * the verdicts come back, never by a reader.
 *
 * ## Per game, not only pooled
 *
 * Pooling hides the game where it fell apart, and a 43-minute game raises about twice the turns of
 * a 24-minute one and would otherwise carry twice the vote silently. The per-game rows are printed
 * without intervals on purpose — on a 25-line game the interval covers almost any claim — and the
 * Wilson interval is on the pooled row, where it means something.
 *
 * Usage:
 *     node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *       scripts/judge-corpus.ts <run.json> [--judge anthropic] [--judge-model <id>] [--batch 8]
 *
 * NODE ONLY. Reads a stored run and never writes to it: the verdicts go to a NEW file beside it.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { modelHandleFor, providerById, providerKey } from "../src/review/live-providers.ts"
import { wilson } from "../src/analysis/coach-score.ts"
import type { Interval } from "../src/analysis/coach-score.ts"

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : fallback
}
const runPath = argv.find(a => !a.startsWith("--") && a.endsWith(".json"))
if (!runPath) throw new Error("usage: judge-corpus.ts <run.json> [--judge anthropic]")

const judgeProvider = arg("judge", "anthropic")
const judgeModelArg = arg("judge-model", "")
const batchSize = Number(arg("batch", "8"))
const seed = Number(arg("seed", "20260911"))

type Verdict = "useful" | "generic" | "unverifiable" | "false"

interface Record_ {
	arm: string
	windowId: string
	atSec: number
	clock: string
	text: string | null
	error: string | null
	payload: string
}
interface Window_ {
	id: string
	gameId: string
	champion: string
	counterpart?: string | null
	kind?: string
	gameDurationSec?: number
}
interface RunFile {
	windows: Window_[]
	records: Record_[]
}

/** mulberry32 — the same generator `blind-judge.ts` and `frame-value.ts` use, for the same reason. */
const shuffled = <T,>(items: readonly T[], s: number): T[] => {
	let a = s >>> 0
	const rand = (): number => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
	const out = [...items]
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1))
		;[out[i], out[j]] = [out[j]!, out[i]!]
	}
	return out
}

const JUDGE_SYSTEM = `You are grading single sentences a live League of Legends coach said out loud to a jungle
main, mid-game, while he was playing.

For each candidate you are given the game clock and the ground-truth payload the app computed from
the game client at that instant. You are NOT given a screenshot, so judge only against the payload:
if a sentence depends on something only a picture could settle, that is "unverifiable", not "false".

Return one verdict per candidate:

  "false"        it contradicts the payload, or it asserts something no channel here could know
                 (a champion not in the payload, a number not in it, an enemy's position, a
                 cooldown, a summoner spell timer). This is the only fatal verdict.
  "unverifiable" it may be true and nothing in the payload can check it.
  "generic"      true and checkable, but it would read identically in a different game or five
                 minutes earlier in this one.
  "useful"       true, specific to this instant, and it names something he can DO in the next
                 thirty seconds.

Reply with JSON only: {"grades":[{"id":"A","verdict":"...","why":"under 20 words"}]}`

type Candidate = { id: string; arm: string; windowId: string; clock: string; text: string; payload: string }

const judgeBatch = async (
	handle: Awaited<ReturnType<typeof modelHandleFor>>,
	lines: readonly Candidate[]
): Promise<Map<string, { verdict: Verdict; why: string }>> => {
	const { generateText } = await import("ai")
	const prompt = lines
		.map(
			l =>
				`### Candidate ${l.id}\nGame clock ${l.clock}.\n\nGround-truth payload:\n\n${l.payload}\n\n` +
				`Sentence: ${l.text}`
		)
		.join("\n\n---\n\n")
	const res = await generateText({
		model: handle,
		system: JUDGE_SYSTEM,
		prompt,
		// 8000 for the same reason frame-value.ts uses 8000: a tight cap truncates a reasoning model
		// mid-object and silently drops every line in the batch.
		maxOutputTokens: 8000
	})
	const raw = (res.text ?? "").trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim()
	const parsed = JSON.parse(raw) as { grades?: { id?: string; verdict?: string; why?: string }[] }
	const out = new Map<string, { verdict: Verdict; why: string }>()
	for (const g of parsed.grades ?? []) {
		if (!g.id) continue
		out.set(g.id, {
			verdict: (["useful", "generic", "unverifiable", "false"].includes(g.verdict ?? "") ?
				g.verdict
			:	"unverifiable") as Verdict,
			why: String(g.why ?? "").slice(0, 160)
		})
	}
	return out
}

const pct = (k: number, n: number): string => (n === 0 ? "  —  " : `${Math.round((100 * k) / n)}%`)
const band = (i: Interval): string => `[${Math.round(i.lo * 100)}-${Math.round(i.hi * 100)}]`

const main = async (): Promise<void> => {
	const run = JSON.parse(readFileSync(runPath, "utf8")) as RunFile
	const byWindow = new Map(run.windows.map(w => [w.id, w]))

	const spoken = run.records.filter(r => r.error === null && (r.text ?? "").trim() !== "")
	const candidates: Candidate[] = shuffled(spoken, seed).map((r, i) => ({
		id: `L${i}`,
		arm: r.arm,
		windowId: r.windowId,
		clock: r.clock,
		text: r.text!.trim(),
		payload: r.payload
	}))

	const p = providerById(judgeProvider)
	if (!p) throw new Error(`no provider called ${judgeProvider}`)
	const key = providerKey(p)
	if (!key) throw new Error(`no key for ${judgeProvider} — put one in data/${p.keyFile}`)
	const handle = await modelHandleFor(p, key, judgeModelArg || p.defaultModel)

	const batches = Math.ceil(candidates.length / batchSize)
	console.log(
		`${spoken.length} spoken line(s) across ${run.windows.length} game(s), ` +
			`shuffled with seed ${seed} and stripped of their arm label.\n` +
			`about to spend ${batches} judge call(s) on ${judgeProvider}/${judgeModelArg || p.defaultModel}\n`
	)

	const verdicts = new Map<string, { verdict: Verdict; why: string }>()
	for (let i = 0; i < candidates.length; i += batchSize) {
		const slice = candidates.slice(i, i + batchSize)
		let got: Map<string, { verdict: Verdict; why: string }> | null = null
		for (let attempt = 0; attempt < 2 && got === null; attempt++) {
			try {
				got = await judgeBatch(handle, slice)
			} catch (e) {
				console.log(`  batch ${1 + i / batchSize} failed${attempt === 0 ? ", retrying" : " twice, dropped"}: ${e}`)
			}
		}
		for (const [id, v] of got ?? []) verdicts.set(id, v)
		process.stdout.write(`\r  judged ${verdicts.size}/${candidates.length}`)
	}
	console.log("")

	/* ------------------------------------------------------------ the report */
	const rows: { gameId: string; label: string; n: number; useful: number; false_: number; generic: number }[] = []
	for (const w of run.windows) {
		const mine = candidates.filter(c => c.windowId === w.id && verdicts.has(c.id))
		if (mine.length === 0) continue
		const v = (k: Verdict) => mine.filter(c => verdicts.get(c.id)!.verdict === k).length
		rows.push({
			gameId: w.gameId,
			label: `${w.champion} vs ${w.counterpart ?? "?"}${w.kind === "paired" ? "" : " (text)"}`,
			n: mine.length,
			useful: v("useful"),
			false_: v("false"),
			generic: v("generic")
		})
	}

	console.log("\nPER GAME — no interval on purpose; these rows are a SPREAD, the interval is pooled below\n")
	console.log("  gameId       matchup                          judged  useful   false  generic")
	for (const r of rows)
		console.log(
			`  ${r.gameId}  ${r.label.padEnd(32)} ${String(r.n).padStart(5)}  ` +
				`${pct(r.useful, r.n).padStart(5)}  ${pct(r.false_, r.n).padStart(6)}  ${pct(r.generic, r.n).padStart(6)}`
		)

	const n = rows.reduce((a, r) => a + r.n, 0)
	const u = rows.reduce((a, r) => a + r.useful, 0)
	const f = rows.reduce((a, r) => a + r.false_, 0)
	const g = rows.reduce((a, r) => a + r.generic, 0)
	console.log(
		`\nPOOLED  ${n} lines   useful ${u}/${n} ${pct(u, n)} ${band(wilson(u, n))}   ` +
			`false ${f}/${n} ${pct(f, n)} ${band(wilson(f, n))}   generic ${g}/${n} ${pct(g, n)} ${band(wilson(g, n))}`
	)
	console.log(
		`\nThe judge saw NO screenshot, so "contradicted-by-picture" is not a verdict it could reach.\n` +
			`Read this false rate as a FLOOR.`
	)

	const out = runPath.replace(/\.json$/, `-judged.json`)
	writeFileSync(
		out,
		JSON.stringify(
			{
				of: runPath,
				ranAt: new Date().toISOString(),
				judge: `${judgeProvider}/${judgeModelArg || p.defaultModel}`,
				seed,
				note: "Graded against the stored payload only — no screenshot. The false rate is a floor.",
				perGame: rows,
				pooled: { n, useful: u, false: f, generic: g },
				lines: candidates
					.filter(c => verdicts.has(c.id))
					.map(c => ({
						id: c.id,
						arm: c.arm,
						windowId: c.windowId,
						clock: c.clock,
						text: c.text,
						...verdicts.get(c.id)!
					}))
			},
			null,
			2
		)
	)
	console.log(`\nwrote ${out}  (${runPath} is unchanged)`)
}

await main()
