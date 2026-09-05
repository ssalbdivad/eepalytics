/**
 * The genericness probe: could this line have come from a different game?
 *
 * ## Why
 *
 * `coach-score.ts` measures whether a line is TRUE and has been at ceiling for months. The
 * transcript the owner quit on scored perfectly on it and was worthless. So this drives the
 * forced-choice instrument in `src/analysis/discriminability.ts`: hide the block the coach was
 * holding among K-1 plausible decoys and ask a blind judge which one produced the line. Chance is
 * 1/K, the interval is Wilson, and every trial is run twice — verbatim and with every number in
 * the line masked. **The gap between those two is the measurement**: a line identifiable only
 * through its digits is a HUD readout, not a read.
 *
 * ## What it measured
 *
 * Nine transcript lines against nine written to be specific, k=5, judge `gemini-3.6-flash`, decoys
 * from four whole recorded games. Within-game, verbatim, BOTH sets score 9/9. Mask the digits and
 * the transcript falls to 4/9 (44%, CI [19, 73]) while the control holds at 8/9 (89%, CI [56, 98]).
 * The empirical null — same option sets, lines shuffled onto the wrong ones — was 29/98 = 30%, so
 * the masked transcript is not distinguishable from noise.
 *
 * The cross-game arm is saturated (85-100% everywhere) and worth little on its own: naming the
 * enemy jungler pins a line to a roster, and it was the mask on that arm which first exposed that
 * the transcript's "BRY-er" is a pronunciation respelling, not a champion name, so the name mask
 * silently missed it until the vocabulary learned the respellings too.
 *
 * ## Where the states come from
 *
 * `data/live-samples/*.ndjson` — the supervisor's verbatim `allgamedata` every ~5s of game clock —
 * replayed through the daemon's own `buildLiveStateForBench`, so the block under test is
 * byte-identical to the one the coach held. It is the same rule `bench-providers` follows and for
 * the same reason: a harness that rebuilds the block differently is measuring a different coach.
 *
 * Two things this replay does that the raw helper does not:
 *
 * - **One module instance per game.** `routes/live.ts` keeps its fact memory at module scope
 *   (right for a daemon with one user and one game), and `buildLiveStateForBench` cannot reset it,
 *   so replaying four games through one import would carry game one's rate limits into game two.
 *   A cache-busting `?g=<game>` on the import gives each game its own memory.
 * - **A real farm baseline.** `buildLiveStateForBench` hardcodes `baseline: null`, which renders
 *   the block's `Farm baseline:` line as "NONE". The transcript under test quotes that line
 *   ("your average of 42"), so a replay without it would make those lines untraceable for a
 *   reason that has nothing to do with the lines. `--no-pace` turns it off to show the difference.
 *
 * ## Usage
 *
 *     node --experimental-strip-types scripts/probe-generic.ts --lines transcript,specific
 *     node --experimental-strip-types scripts/probe-generic.ts --lines generated --generate 40
 *     node --experimental-strip-types scripts/probe-generic.ts --lines all --out data/eval/generic.json
 *
 *     --samples <dir>     default `$DATA_DIR/live-samples`
 *     --games a,b         default every `split-*.ndjson` found
 *     --lines <sets>      transcript | specific | generated | all      (default transcript,specific)
 *     --lines-file <path> a JSON array of {id, text, stateId, tag} to score instead of generating
 *     --generate N        how many coach lines to make for the `generated` set (default 32)
 *     --coach <model>     model that SPEAKS, for `generated` (default the gemini-http default)
 *     --judge <model>     model that IDENTIFIES (default gemini-3.6-flash)
 *     --k N               options per trial; chance is 1/N (default 5)
 *     --masks a,b         none | digits | digits+names (default all three)
 *     --pools a,b         within-game | cross-game (default both)
 *     --concurrency N     parallel judge calls (default 6)
 *     --no-scramble       skip the empirical null
 *     --no-pace           leave the farm baseline out of the block
 *     --seed s            everything about the draw is a pure function of this
 *     --out <path>        write the full report, every trial and every answer
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { baselineFromRows, perGameMetrics } from "../src/analysis/index.ts"
import {
	buildTrials,
	positionBias,
	runTrials,
	scrambleTrials,
	summarize
} from "../src/analysis/discriminability.ts"
import type {
	Cell,
	Judge,
	Judgement,
	LineUnderTest,
	MaskMode,
	StateCard,
	Trial
} from "../src/analysis/discriminability.ts"
import { paceReading } from "../src/analysis/live-coach.ts"
import { loadCorpus } from "../src/daemon/corpus.ts"
import { coachTurn, providerById, providerKey } from "../src/review/live-providers.ts"
import { DATA_DIR } from "../src/shared/constants.ts"
import { parsePronunciations } from "../src/shared/pronounce.ts"
import { renderState } from "../src/shared/live-state.ts"
import type { VisionState } from "../src/shared/live-state.ts"

/* ================================================================ flags */

const argv = process.argv.slice(2)
const flag = (name: string, fallback = ""): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : fallback
}
const has = (name: string): boolean => argv.includes(`--${name}`)
const list = (name: string, fallback: string): string[] =>
	flag(name, fallback)
		.split(",")
		.map(s => s.trim())
		.filter(s => s !== "")

const SAMPLES = flag("samples", `${DATA_DIR}/live-samples`)
const JUDGE_MODEL = flag("judge", "gemini-3.6-flash")
const COACH_MODEL = flag("coach", "")
const K = Number(flag("k", "5"))
const MASKS = list("masks", "none,digits,digits+names") as MaskMode[]
const POOLS = list("pools", "within-game,cross-game") as ("within-game" | "cross-game")[]
const CONCURRENCY = Number(flag("concurrency", "6"))
const SEED = flag("seed", "generic-v1")
const GENERATE = Number(flag("generate", "32"))
const LINES_FILE = flag("lines-file", "")
const OUT = flag("out", "")
const WITH_PACE = !has("no-pace")
const WITH_SCRAMBLE = !has("no-scramble")
/**
 * How far a cross-game decoy's clock may sit from the truth's.
 *
 * 150s rather than the module's 90s default because only ~20 of a game's ~300 ticks carry a ranked
 * fact list and a decoy has to match the truth on that. At 90s three of eighteen lines could not be
 * given four plausible cross-game decoys at all and were REFUSED — a skipped line is a line the
 * measurement says nothing about, which is worse than a decoy two and a half minutes off in a game
 * that runs thirty-six.
 */
const CROSS_TOL = Number(flag("clock-tolerance", "150"))

/* ================================================================ states */

/**
 * Every sample of one game, as a block.
 *
 * The whole game is kept, not only the fact-bearing ticks: decoys are drawn from here, and a pool
 * restricted to the ~20 ticks that carry a fact would make every option in a trial a moment the
 * coach would have spoken at — a much easier and much less honest question.
 */
const cardsFor = async (game: string, baseline: ReturnType<typeof baselineFromRows> | null) => {
	const mod = (await import(`../src/server/routes/live.ts?g=${game}`)) as typeof import("../src/server/routes/live.ts")
	const raw = readFileSync(`${SAMPLES}/${game}.ndjson`, "utf8").split("\n")
	const cards: StateCard[] = []
	for (const l of raw) {
		if (l.trim() === "") continue
		const o = JSON.parse(l) as { gameTime: number; data: unknown }
		const tSec = Math.round(o.gameTime)
		const s = mod.buildLiveStateForBench(o.data, o.gameTime)
		if (!s) continue
		if (baseline) attachPace(s, tSec, baseline)
		cards.push({
			id: `${game}@${String(tSec).padStart(4, "0")}`,
			game,
			tSec,
			block: renderState(s),
			hasFacts: s.unseen.length > 0
		})
	}
	return cards
}

/**
 * Put his rolling farm average back into the block.
 *
 * Same call the daemon makes (`paceReading` over `baselineFromRows(perGameMetrics(loadCorpus))`),
 * just applied after the fact because the bench helper hardcodes a null baseline and this script
 * does not own that file. It restores the `Farm baseline:` line only; the RANKED list was already
 * computed without it, so farm-shaped facts are still missing from `unseen`. Stated here because a
 * reader comparing this to a live transcript would otherwise not know.
 */
const attachPace = (s: VisionState, tSec: number, baseline: ReturnType<typeof baselineFromRows>) => {
	s.pace = paceReading({
		live: {
			gameTimeSec: tSec,
			championName: s.me.champion,
			cs: s.me.cs ?? 0,
			deaths: s.me.d ?? 0,
			kills: s.me.k ?? 0,
			assists: s.me.a ?? 0,
			level: s.me.level ?? 0,
			observed: { dragonSec: null, baronSec: null, heraldSec: null }
		},
		baseline,
		focus: []
	})
}

/** The card nearest a wanted clock. Samples land ~5s apart, so this is never far. */
const at = (cards: readonly StateCard[], game: string, tSec: number): StateCard => {
	const inGame = cards.filter(c => c.game === game)
	if (inGame.length === 0) throw new Error(`no cards for ${game}`)
	return inGame.reduce((best, c) =>
		Math.abs(c.tSec - tSec) < Math.abs(best.tSec - tSec) ? c : best
	)
}

/* ================================================================ the line sets */

/**
 * The nine lines the owner quit on, verbatim, with the instant each was said.
 *
 * They are from `split-03` and the reconstruction is tight rather than assumed. His CS arrives
 * from this client rounded to the nearest ten, and the transcript quotes both the CS and the
 * rolling average: at 250s the current baseline returns expected 28 with him on 20 CS, and at 265s
 * it returns 30 with him on 20 — which are exactly the pairs in lines 7 and 6. Two independent
 * coincidences of that kind do not happen; the game, the minute and the baseline all check out.
 *
 * Where a line names no figure that moves ("BRY-er is still at 0 CS" was true for six minutes) it
 * is pinned to the LAST instant at which it held — the most favourable reading available to it.
 * If a line still cannot be traced from its best-case state, that is not an artefact of the
 * pinning.
 */
const TRANSCRIPT_LINES: { id: string; text: string; game: string; tSec: number; note: string }[] = [
	{
		id: "T1-drake",
		text: "That is a tough one, but they took Hextech drake.",
		game: "split-03",
		tSec: 365,
		note: "the only Hextech in this game; the event is in the block"
	},
	{
		id: "T2-farm40",
		text: "Nice work clearing, your 40 farm is just behind your average of 42.",
		game: "split-03",
		tSec: 375,
		note: "40 CS spans 322-426s; expected 42 lands at ~375s"
	},
	{
		id: "T3-farm37",
		text: "Awesome clear, you are farming above your average of 37 right now.",
		game: "split-03",
		tSec: 325,
		note: "expected 37 lands at ~325s, where he is on 40 CS"
	},
	{
		id: "T4-race30",
		text: "You are 30 CS up on BRY-er, so keep the route moving.",
		game: "split-03",
		tSec: 292,
		note: "he is 30, Briar 0; last such instant before he reaches 40"
	},
	{
		id: "T5-briar0",
		text: "BRY-er is still at 0 CS, so farm your camps to keep building this lead.",
		game: "split-03",
		tSec: 353,
		note: "true from 0s to 353s — pinned to the last instant it held"
	},
	{
		id: "T6-pace30",
		text: "Try to pick up the pace, your 20 farm is not pacing to match your average of 30.",
		game: "split-03",
		tSec: 265,
		note: "20 CS and expected 30 coincide only here"
	},
	{
		id: "T7-pace28",
		text: "Try to pick it up, your 20 farm is not pacing to match your 28 CS average.",
		game: "split-03",
		tSec: 250,
		note: "20 CS and expected 28 coincide only here"
	},
	{
		id: "T8-lead20",
		text: "Look at that farm lead, you have 20 CS to BRY-er 0 CS.",
		game: "split-03",
		tSec: 255,
		note: "he is 20, Briar 0: 170-267s"
	},
	{
		id: "T9-up20",
		text: "Great job on that clear, you are 20 CS up on BRY-er.",
		game: "split-03",
		tSec: 267,
		note: "same 20-0 window, last instant"
	}
]

/**
 * Lines written by hand to be specific, as the positive control.
 *
 * Every one is anchored to a fact that fires exactly ONCE in its game, so within-game
 * identification is possible in principle even with the digits gone. That is the point of the
 * control: if these do not beat the transcript, the instrument is broken and its numbers about the
 * transcript mean nothing.
 *
 * They are deliberately NOT flattering: two of them (S5, S8) are almost the same sentence about
 * two different games, which is exactly the case the name mask should destroy.
 */
const SPECIFIC_LINES: { id: string; text: string; game: string; tSec: number }[] = [
	{
		id: "S1-levelgap",
		text: "You are two levels down on Briar right now, so decline the even fight and take your own camps instead.",
		game: "split-03",
		tSec: 762
	},
	{
		id: "S2-herald",
		text: "They have Herald and a free tower charge, so get back to your top tower before it walks in.",
		game: "split-03",
		tSec: 939
	},
	{
		id: "S3-killshare",
		text: "Briar is in far more of his team's kills than you are, so start moving to the next fight before it opens.",
		game: "split-03",
		tSec: 1464
	},
	{
		id: "S4-baron",
		text: "They just took Baron, so do not fight in the open for the next three minutes, clear the side wave instead.",
		game: "split-03",
		tSec: 1995
	},
	{
		id: "S5-killshare-k",
		text: "Karthus is in far more of his team's kills than you are, so leave the camp and be early to the next fight.",
		game: "split-01",
		tSec: 1151
	},
	{
		id: "S6-levelgap-k",
		text: "You are two levels down on Karthus, so you have no burst and no dash and the even fight is not yours.",
		game: "split-01",
		tSec: 1292
	},
	{
		id: "S7-baron-02",
		text: "They have Baron, so hold the side lane and do not contest anything in the open until it runs out.",
		game: "split-02",
		tSec: 1884
	},
	{
		id: "S8-killshare-t",
		text: "Tryndamere is in far more of his team's kills than you are, so get to the next fight before it starts.",
		game: "split-04",
		tSec: 604
	},
	{
		id: "S9-herald-04",
		text: "They have Herald and a free tower charge, so cover your top tower right now.",
		game: "split-04",
		tSec: 1068
	}
]

/**
 * Lines the SHIPPED coach produces, right now, for states in these games.
 *
 * The hand-written sets are a calibration; this is the actual reading. Text only — no frame — so
 * the number is about what the block supports, and so one arm's line cannot be more specific than
 * another's because it happened to get a better screenshot.
 */
const generateLines = async (cards: readonly StateCard[], n: number): Promise<LineUnderTest[]> => {
	const provider = providerById("gemini-http")!
	if (!providerKey(provider)) throw new Error(`no key at ${DATA_DIR}/${provider.keyFile}`)
	const speaking = cards.filter(c => c.hasFacts)
	const step = Math.max(1, Math.floor(speaking.length / n))
	const picked = speaking.filter((_, i) => i % step === 0).slice(0, n)
	const out: LineUnderTest[] = []
	for (const c of picked) {
		const r = await coachTurn({
			provider: "gemini-http",
			...(COACH_MODEL ? { model: COACH_MODEL } : {}),
			blockText: c.block
		})
		const text = r.text.trim()
		// PASS is a real and correct answer from this coach, and it is not a line to score.
		if (!r.ok || text === "" || /^pass\b/i.test(text)) continue
		out.push({ id: `G-${c.id}`, text, stateId: c.id, tag: "generated" })
		process.stderr.write(`  ${c.id}  ${text.slice(0, 90)}\n`)
	}
	return out
}

/* ================================================================ the judge */

const geminiJudge = async (model: string): Promise<Judge> => {
	const path = `${DATA_DIR}/gemini.key`
	if (!existsSync(path)) throw new Error(`no Gemini key at ${path}`)
	const key = readFileSync(path, "utf8").trim()
	const { createGoogleGenerativeAI } = await import("@ai-sdk/google")
	const { generateText } = await import("ai")
	const handle = createGoogleGenerativeAI({ apiKey: key })(model)
	return async prompt => {
		/*
		 * A generous token budget for a one-letter answer, deliberately.
		 *
		 * Measured elsewhere in this repo: a tight `maxOutputTokens` does not shorten a reasoning
		 * model, it truncates it mid-thought, and a truncated answer here parses as "no letter" —
		 * which would be reported as judge failure and quietly shrink n.
		 */
		const r = await generateText({ model: handle, prompt, maxOutputTokens: 2048 })
		return r.text
	}
}

/** Run the judge over chunks in parallel, through the module's own runner so there is one path. */
const runPooled = async (trials: readonly Trial[], judge: Judge, width: number) => {
	const chunks: Trial[][] = Array.from({ length: width }, () => [])
	trials.forEach((t, i) => chunks[i % width]!.push(t))
	let done = 0
	const results = await Promise.all(
		chunks.map(c =>
			runTrials(c, judge, () => {
				done++
				if (done % 10 === 0) process.stderr.write(`  ${done}/${trials.length}\n`)
			})
		)
	)
	return results.flat()
}

/* ================================================================ reporting */

const pct = (x: number) => `${(x * 100).toFixed(0)}%`

const table = (cells: readonly Cell[]) => {
	const rows = cells.map(c => [
		c.tag || "-",
		c.pool,
		c.mask,
		`${c.hits}/${c.n}`,
		pct(c.accuracy),
		`[${pct(c.interval.lo)}, ${pct(c.interval.hi)}]`,
		pct(c.chance),
		c.aboveChance ? "yes" : "no",
		c.unparsed > 0 ? String(c.unparsed) : ""
	])
	const head = ["set", "pool", "mask", "hits", "acc", "95% CI", "chance", "> chance?", "unparsed"]
	const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)))
	const line = (r: string[]) => r.map((v, i) => v.padEnd(widths[i]!)).join("  ")
	console.log(line(head))
	console.log(widths.map(w => "-".repeat(w)).join("  "))
	for (const r of rows) console.log(line(r))
}

/* ================================================================ main */

const main = async () => {
	const games =
		list("games", "").length > 0 ?
			list("games", "")
		:	readdirSync(SAMPLES)
				.filter(f => f.startsWith("split-") && f.endsWith(".ndjson"))
				.map(f => f.replace(/\.ndjson$/, ""))
				.sort()
	if (games.length < 2)
		throw new Error(`cross-game decoys need at least two games; found ${games.length} in ${SAMPLES}`)

	const baseline = WITH_PACE ? baselineFromRows(perGameMetrics(loadCorpus(30))) : null
	const cards: StateCard[] = []
	for (const g of games) cards.push(...(await cardsFor(g, baseline)))
	const withFacts = cards.filter(c => c.hasFacts).length
	console.log(
		`${cards.length} states from ${games.length} games (${withFacts} carry a ranked fact list), farm baseline ${
			baseline ? "attached" : "OFF"
		}`
	)

	const roster = [
		...new Set(
			cards.flatMap(c => [
				...(c.block.match(/(?<=Your team: |Enemy team: )[^\n]+/g) ?? []).flatMap(l =>
					l.split(" · ").map(p => p.split(" ")[0]!)
				),
				c.block.match(/(?<=^You: )\w+/m)?.[0] ?? "",
				c.block.match(/(?<=Enemy jungler right now: )\w+/)?.[0] ?? ""
			])
		)
	].filter(n => n !== "")

	/*
	 * The respellings count as champion names, and leaving them out silently broke the name mask.
	 *
	 * Measured: the transcript says "BRY-er", which is `knowledge/pronunciations.md`'s respelling of
	 * Briar leaking out of a prompt it should never have been in. A vocabulary built from the
	 * client's spellings does not contain it, so `digits+names` left the enemy jungler's name
	 * standing in eight of nine transcript lines and the cross-game arm read 88% when the roster had
	 * supposedly been hidden.
	 */
	const vocabulary = [
		...roster,
		...(existsSync("knowledge/pronunciations.md") ?
			parsePronunciations(readFileSync("knowledge/pronunciations.md", "utf8")).map(p => p.say)
		:	[])
	]

	const want = list("lines", "transcript,specific")
	const all = want.includes("all")
	const lines: LineUnderTest[] = []
	if (all || want.includes("transcript"))
		lines.push(
			...TRANSCRIPT_LINES.map(l => ({
				id: l.id,
				text: l.text,
				stateId: at(cards, l.game, l.tSec).id,
				tag: "transcript"
			}))
		)
	if (all || want.includes("specific"))
		lines.push(
			...SPECIFIC_LINES.map(l => ({
				id: l.id,
				text: l.text,
				stateId: at(cards, l.game, l.tSec).id,
				tag: "handwritten-specific"
			}))
		)
	if (all || want.includes("generated")) {
		console.log(`generating ${GENERATE} coach lines…`)
		lines.push(...(await generateLines(cards, GENERATE)))
	}
	/*
	 * Lines already spoken, replayed rather than re-generated.
	 *
	 * Generation is the slow and expensive half — a coach turn is a long prompt against a shared,
	 * rate-limited key, and it took thirty times longer than a judge call on the night this was
	 * written. Separating the two means a set of real lines can be re-scored under a different k, a
	 * different judge or a different mask without paying for the model to say them again, and it is
	 * the only way to score lines that came off an actual game rather than out of this script.
	 */
	if (LINES_FILE !== "") {
		const loaded = JSON.parse(readFileSync(LINES_FILE, "utf8")) as LineUnderTest[]
		for (const l of loaded) {
			if (!cards.some(c => c.id === l.stateId))
				throw new Error(`${LINES_FILE}: line ${l.id} points at ${l.stateId}, which is not in this corpus`)
			lines.push({ ...l, tag: l.tag ?? "from-file" })
		}
		console.log(`loaded ${loaded.length} lines from ${LINES_FILE}`)
	}
	console.log(`${lines.length} lines under test, ${vocabulary.length} champions in the vocabulary`)

	const trials: Trial[] = []
	const skipped = []
	for (const pool of POOLS) {
		const r = buildTrials({
			lines,
			cards,
			pool,
			masks: MASKS,
			k: K,
			championNames: vocabulary,
			clockToleranceSec: CROSS_TOL,
			seed: SEED
		})
		trials.push(...r.trials)
		skipped.push(...r.skipped)
	}
	for (const s of skipped) console.log(`skipped ${s.lineId} (${s.pool}): ${s.reason}`)
	console.log(`${trials.length} trials, k=${K}, chance ${pct(1 / K)}, judge ${JUDGE_MODEL}`)

	const judge = await geminiJudge(JUDGE_MODEL)
	const judgements = await runPooled(trials, judge, CONCURRENCY)

	console.log("")
	table(summarize(judgements))
	console.log(`\nposition chosen: ${positionBias(judgements).join(" / ")} (A..${"ABCDE"[K - 1]})`)

	let nullJudgements: Judgement[] = []
	if (WITH_SCRAMBLE) {
		console.log("\nempirical null — same option sets, lines shuffled onto the wrong ones:")
		nullJudgements = await runPooled(scrambleTrials(trials, `${SEED}:null`), judge, CONCURRENCY)
		const cells = summarize(nullJudgements)
		const n = cells.reduce((a, c) => a + c.n, 0)
		const hits = cells.reduce((a, c) => a + c.hits, 0)
		console.log(`  ${hits}/${n} = ${pct(hits / n)} against a ${pct(1 / K)} chance`)
	}

	console.log("\nmisses, real arm:")
	for (const j of judgements)
		if (!j.correct)
			console.log(
				`  ${j.trial.lineId} ${j.trial.pool}/${j.trial.mask}: chose ${
					j.choice === null ? "nothing" : `${"ABCDEFGH"[j.choice]} (t=${j.trial.options[j.choice]!.tSec}s ${j.trial.options[j.choice]!.game})`
				}, truth t=${j.trial.options[j.trial.answerIndex]!.tSec}s — "${j.trial.prompt}"`
			)

	if (OUT) {
		writeFileSync(
			OUT,
			JSON.stringify(
				{
					at: new Date().toISOString(),
					seed: SEED,
					k: K,
					judge: JUDGE_MODEL,
					games,
					pace: Boolean(baseline),
					cells: summarize(judgements),
					nullCells: summarize(nullJudgements),
					positionBias: positionBias(judgements),
					skipped,
					judgements: judgements.map(j => ({
						line: j.trial.lineId,
						tag: j.trial.tag,
						pool: j.trial.pool,
						mask: j.trial.mask,
						prompt: j.trial.prompt,
						raw: j.trial.rawLine,
						options: j.trial.options.map(o => o.id),
						answer: j.trial.answerIndex,
						choice: j.choice,
						correct: j.correct
					}))
				},
				null,
				2
			)
		)
		console.log(`\nwrote ${OUT}`)
	}
}

await main()
