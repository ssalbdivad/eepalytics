/**
 * DID RE-AIMING THE PERSONA CHANGE THE REVIEW? A vs B on the same real games, no judge in the
 * primary number.
 *
 * ## What is under test
 *
 * Commit `0859e35` rewrote Part 2 of `AGENTS.md` — which `src/review/prompt.ts` loads verbatim as
 * the post-game system prompt — to aim the coach at the two things `scripts/what-wins.ts` measured
 * to separate his wins from his losses over 138 of his own ranked games: deaths between 10:00 and
 * 15:00, and the early objective ledger. It WITHDREW the standing order to name every death in the
 * enemy jungle, DEMOTED vision from a pillar to a citation, and REMOVED unspent gold as a defect
 * signal. Nobody had checked that any of that reaches the OUTPUT.
 *
 * ## The one thing that varies
 *
 * Only the SYSTEM prompt. Both arms get the same game, the same `buildGameDigest`, the same
 * rendered pack, the same intensity, the same model, the same output schema, and the run asserts
 * it: `userSha` is a sha256 of the user turn and it is recorded per game, identical across arms by
 * construction because it is computed once and sent twice. The old persona comes out of git
 * (`git show <ref>:AGENTS.md`) through the SHIPPED extractor, `extractPersona`, so an arm cannot
 * differ from what the app would have loaded that day.
 *
 * ## Question 1 is mechanical and has no model in it
 *
 * An item is classified from its own STRUCTURED fields — `category`, `tSec`, `momentIds` — joined
 * to the digest's moments, whose ids encode kind and clock (`g<gameId>-<kind>-<tSec>`). No prose is
 * read for the primary counts:
 *
 *   windowDeath     category "deaths" AND some anchor falls in [600, 900)
 *   earlyObjective  category "objectives" AND some anchor is at or before 600
 *   onTarget        either of the two
 *
 * where an item's ANCHORS are its own `tSec` plus the `tSec` of every moment it cites. Both of the
 * re-aimed persona's own worked examples land inside this definition — example D is `deaths` at
 * tSec 738 and example B is `objectives` at tSec 512 — which is the check that the classifier is
 * measuring the thing the prompt asks for rather than a proxy for it.
 *
 * The DENOMINATOR is reported two ways, because a share cannot move where the material does not
 * exist: over all items, and over only the games that HAVE a death moment in the window (or an
 * objective at or before 10:00). A game with no death between 10:00 and 15:00 cannot produce an
 * on-window item however the prompt is worded, and averaging it in understates both arms equally
 * while making the ceiling invisible.
 *
 * Keyword counts are SECONDARY and every regex is printed into the run file beside its count, so a
 * reader can disagree with a pattern and recount. They are the only way to see the three things the
 * commit removed, because "unspent gold" and "died in their jungle" have no structured field.
 *
 * ## Question 2 is the shipped parser
 *
 * Every arm's raw answer goes through `buildReview` with `allowlistOf(digest)` — the same call the
 * daemon makes — and the run counts `ParseWarning`s by code per arm. `unknown-moment-id`,
 * `unknown-metric-key`, `fabricated-citations` and `baseline-mismatch` are the four that mean a
 * number was invented; the rest are budget and shape. A longer prompt that made the coach sloppier
 * about citations would show up here and nowhere else.
 *
 * ## Question 3 is graded BLIND and is reported as a null unless the intervals separate
 *
 * `--judge` re-reads a finished run, pools both arms' items per game with the arm labels stripped
 * and the ids randomised under a seed, shows the judge the same digest the coach saw, and asks for
 * a verdict per item. This repo has retracted three headline claims that were inside noise, so the
 * report prints Wilson intervals and `separated()`, and says "null" when they overlap.
 *
 * ## What this CANNOT tell you
 *
 * It is one model per run over N games, and item counts per review are small, so the interval on a
 * share is wide. It does not measure whether the re-aimed items are RIGHT about his games — that is
 * `what-wins.ts`'s question and it was answered before the prompt was written. And a share moving
 * is not by itself a good thing: it is evidence that the prompt is the cause, which is the only
 * thing that was ever in doubt.
 *
 *   node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *     scripts/persona-ab.ts [--games 20] [--provider gemini-http] [--model gemini-3.6-flash]
 *                           [--old-ref 0859e35^] [--out data/eval/persona-ab-<date>.json]
 *   node ... scripts/persona-ab.ts --read  data/eval/persona-ab-<date>.json   (no model, no bill)
 *   node ... scripts/persona-ab.ts --judge data/eval/persona-ab-<date>.json
 *                           [--judge-provider anthropic] [--judge-model claude-sonnet-5]
 *                           [--judge-out data/eval/<name>.json]
 *
 * THE DB CONNECTION IS READ ONLY. The daemon may be running; nothing here may disturb it.
 */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { useDb } from "../src/db/index.ts"
import { DB_PATH } from "../src/shared/constants.ts"
import { separated, wilson } from "../src/analysis/coach-score.ts"
import { mcnemar, shuffled } from "./lib/stats.ts"

const args = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
	const i = args.indexOf(`--${name}`)
	return i === -1 ? fallback : (args[i + 1] ?? fallback)
}
const has = (name: string): boolean => args.includes(`--${name}`)

const JUDGE_RUN = has("judge") ? arg("judge", "") : ""
const READ_RUN = has("read") ? arg("read", "") : ""
const GAMES = Number(arg("games", "20"))
const PROVIDER = arg("provider", "gemini-http")
const MODEL = arg("model", "gemini-3.6-flash")
const OLD_REF = arg("old-ref", "0859e35^")
const NEW_REF = arg("new-ref", "") // empty = the working tree's AGENTS.md, i.e. what ships today
const SEED = Number(arg("seed", "20260919"))
const STAMP = new Date().toISOString().slice(0, 10).replaceAll("-", "")
const OUT = arg("out", `data/eval/persona-ab-${STAMP}.json`)
const JUDGE_PROVIDER = arg("judge-provider", "anthropic")
const JUDGE_MODEL = arg("judge-model", "claude-sonnet-5")
const JUDGE_OUT = arg("judge-out", "")

/* ─────────────────────────────────────────────────────── the classifier */

/**
 * The window `what-wins.ts` measured, in seconds. 600-900 is 10:00 to 15:00, half-open at the top
 * so a death at exactly 15:00 belongs to the later block, the same convention the measurement used.
 */
export const WINDOW_LO = 600
export const WINDOW_HI = 900
/** "Early" for the objective ledger. The measured row is the ledger BY 10:00. */
export const EARLY_HI = 600

/**
 * Keyword patterns for the three things the commit REMOVED or DEMOTED. Printed into the run file
 * with their counts: they are secondary evidence and a reader who dislikes a pattern can recount
 * from `items[]`, which carries every item's full text.
 */
export const PATTERNS = {
	unspentGold: /unspent|sitting on (?:\d|gold|\$)|gold (?:in|burning) (?:your|his) pocket|banked gold|hoard(?:ing)? gold/i,
	// `jungle\b` and not `jungle`, because "the enemy JUNGLER" is a person and this pattern is
	// looking for a PLACE. The zone labels the digest prints ("enemy blue-side jungle (top)") and
	// the looser forms a coach actually writes ("enemy blue jungle") both have to land, and his
	// OWN half must not: an earlier version matched neither "enemy blue jungle" nor "their red
	// jungle" and would have undercounted the withdrawn advice.
	enemyJungle:
		/\b(?:enemy|their)\b\s+(?:(?:red|blue)[- ]?side\s+|(?:red|blue)\s+)?jungle\b|\btheir (?:raptors|krugs|gromp|wolves|blue|red)\b|\b(?:enemy|their) half\b/i,
	visionWord: /\bvision\b|\bward(?:s|ed|ing)?\b|\bsweeper\b|control ward/i,
	earlyLedgerWord: /\bgrub(?:s)?\b|voidgrub|rift herald|\bherald\b|\bdrake\b|\bdragon\b/i,
	windowPhrase: /\b1[0-4]:\d\d\b|\b10:00[^.]{0,60}15:00\b|between (?:ten|10) and (?:fifteen|15)/i
} as const

export interface ItemRecord {
	arm: string
	gameId: number
	index: number
	title: string
	fix: string
	body: string
	severity: string
	category: string
	impact: string
	actionability: string
	confidence: string
	tSec: number | null
	momentIds: string[]
	metricKeys: string[]
	anchors: number[]
	windowDeath: boolean
	earlyObjective: boolean
	onTarget: boolean
	hits: Record<string, boolean>
}

/** `g<gameId>-<kind>-<tSec>` — the moment id is the join key AND it carries the clock. */
const momentClock = (moments: { id: string; tSec: number; kind: string }[], id: string): { tSec: number; kind: string } | null => {
	const m = moments.find(x => x.id === id)
	return m ? { tSec: m.tSec, kind: m.kind } : null
}

export const classify = (
	item: {
		title: string
		fix: string
		body: string
		severity: string
		category?: string
		impact: string
		actionability: string
		confidence: string
		tSec: number | null
		momentIds: string[]
		metricKeys: string[]
	},
	moments: { id: string; tSec: number; kind: string }[],
	arm: string,
	gameId: number,
	index: number
): ItemRecord => {
	const cited = item.momentIds.map(id => momentClock(moments, id)).filter(m => m !== null)
	const anchors = [...(item.tSec === null ? [] : [item.tSec]), ...cited.map(c => c.tSec)]
	const category = item.category ?? ""
	const text = `${item.title}\n${item.fix}\n${item.body}`

	const windowDeath = category === "deaths" && anchors.some(a => a >= WINDOW_LO && a < WINDOW_HI)
	const earlyObjective = category === "objectives" && anchors.some(a => a <= EARLY_HI)

	const hits: Record<string, boolean> = {}
	for (const [name, re] of Object.entries(PATTERNS)) hits[name] = re.test(text)

	return {
		arm,
		gameId,
		index,
		title: item.title,
		fix: item.fix,
		body: item.body,
		severity: item.severity,
		category,
		impact: item.impact,
		actionability: item.actionability,
		confidence: item.confidence,
		tSec: item.tSec,
		momentIds: item.momentIds,
		metricKeys: item.metricKeys,
		anchors,
		windowDeath,
		earlyObjective,
		onTarget: windowDeath || earlyObjective,
		hits
	}
}

/* ─────────────────────────────────────────────────────────── reporting */

const share = (k: number, n: number): string => {
	const w = wilson(k, n)
	return `${((w.p * 100) || 0).toFixed(0)}% [${(w.lo * 100).toFixed(0)}-${(w.hi * 100).toFixed(0)}] ${k}/${n}`
}

interface ArmSummary {
	arm: string
	reviews: number
	failedReviews: number
	items: number
	windowDeath: number
	earlyObjective: number
	onTarget: number
	onTargetWhereAvailable: { k: number; n: number }
	categories: Record<string, number>
	tSecBuckets: Record<string, number>
	patternHits: Record<string, number>
	warnings: Record<string, number>
	citationWarnings: number
	meanItemsPerReview: number
	meanTitleChars: number
	meanBodyChars: number
	promptChars: number
	usage: { inputTokens: number; outputTokens: number }
	latencyMsTotal: number
}

const summarise = (
	arm: string,
	items: ItemRecord[],
	reviews: { gameId: number; ok: boolean; warnings: { code: string }[]; availWindow: boolean; availEarlyObj: boolean }[],
	promptChars: number,
	usage: { inputTokens: number; outputTokens: number },
	latencyMsTotal: number
): ArmSummary => {
	const categories: Record<string, number> = {}
	const tSecBuckets: Record<string, number> = { "<10:00": 0, "10:00-15:00": 0, ">=15:00": 0, "no tSec": 0 }
	const patternHits: Record<string, number> = {}
	for (const k of Object.keys(PATTERNS)) patternHits[k] = 0
	const warnings: Record<string, number> = {}

	for (const it of items) {
		categories[it.category || "(none)"] = (categories[it.category || "(none)"] ?? 0) + 1
		const b =
			it.tSec === null ? "no tSec"
			: it.tSec < WINDOW_LO ? "<10:00"
			: it.tSec < WINDOW_HI ? "10:00-15:00"
			: ">=15:00"
		tSecBuckets[b] = (tSecBuckets[b] ?? 0) + 1
		for (const [k, v] of Object.entries(it.hits)) if (v) patternHits[k] = (patternHits[k] ?? 0) + 1
	}
	for (const r of reviews) for (const w of r.warnings) warnings[w.code] = (warnings[w.code] ?? 0) + 1

	// The denominator that respects the ceiling: only games where the digest HOLDS the material.
	const availGames = new Set(reviews.filter(r => r.availWindow || r.availEarlyObj).map(r => r.gameId))
	const availItems = items.filter(i => availGames.has(i.gameId))

	const CITATION_CODES = new Set(["unknown-moment-id", "unknown-metric-key", "fabricated-citations", "baseline-mismatch"])

	return {
		arm,
		reviews: reviews.filter(r => r.ok).length,
		failedReviews: reviews.filter(r => !r.ok).length,
		items: items.length,
		windowDeath: items.filter(i => i.windowDeath).length,
		earlyObjective: items.filter(i => i.earlyObjective).length,
		onTarget: items.filter(i => i.onTarget).length,
		onTargetWhereAvailable: { k: availItems.filter(i => i.onTarget).length, n: availItems.length },
		categories,
		tSecBuckets,
		patternHits,
		warnings,
		citationWarnings: Object.entries(warnings)
			.filter(([c]) => CITATION_CODES.has(c))
			.reduce((a, [, n]) => a + n, 0),
		meanItemsPerReview: items.length / Math.max(1, reviews.filter(r => r.ok).length),
		meanTitleChars: items.reduce((a, i) => a + i.title.length, 0) / Math.max(1, items.length),
		meanBodyChars: items.reduce((a, i) => a + i.body.length, 0) / Math.max(1, items.length),
		promptChars,
		usage,
		latencyMsTotal
	}
}

/* ══════════════════════════════════════════════════════════ the judge */

interface JudgedItem {
	blindId: string
	useful: boolean
	supported: boolean
	reason: string
}

export const JUDGE_INSTRUCTIONS = `You are grading coaching items written about ONE League of Legends game by a
jungle player. You are shown the same digest the coach was shown, then a numbered list of items. The
items come from two different coaches in a randomised order and NOTHING tells you which is which;
do not guess, and do not let item order influence you.

For EACH item return two independent verdicts.

"useful" — would this change what he does in his next game? It is useful only if it names something
specific to THIS game, ends on a change he could actually make, and would NOT read identically
pasted onto a different game. An item that is true and generic is NOT useful. An item that restates
the scoreline is NOT useful.

"supported" — is every figure, timestamp and zone in it present in the digest above? An item that
cites a number the digest does not contain is not supported, even if the number is plausible.

Return ONE JSON object and nothing else:
{"verdicts":[{"blindId":"...","useful":true,"supported":true,"reason":"under 20 words"}]}
Return exactly one verdict per item, using the blindId given.`

/**
 * The stored run, as written. Every number the report prints is in here, which is the point:
 * `--read` reprints a finished run with no model consulted and no bill, so a figure quoted in
 * AGENTS.md can be re-derived a month later from the file it names.
 */
export interface StoredRun {
	ranAt: string
	provider: string
	model: string
	oldRef: string
	newRef: string
	personaChars: Record<string, number>
	intensity: number
	games: {
		gameId: number
		win: boolean
		availWindow: boolean
		availEarlyObj: boolean
	}[]
	summaries: ArmSummary[]
	pairedOnTarget: { aOnly: number; bOnly: number; both: number; neither: number; p: number }
	items: ItemRecord[]
}

export const printReport = (run: StoredRun): void => {
	const s = (arm: string): ArmSummary => {
		const f = run.summaries.find(x => x.arm === arm)
		if (!f) throw new Error(`no summary ${arm}`)
		return f
	}
	const wins = run.games.filter(g => g.win).length
	console.log(
		`\n${run.games.length} real games (ranked solo, jungle, >=15:00): ${wins} won, ${run.games.length - wins} lost. ` +
			`${run.games.filter(g => g.availWindow).length} have a death in 10:00-15:00; ` +
			`${run.games.filter(g => g.availEarlyObj).length} have an objective by 10:00.`
	)
	console.log(
		`arms: OLD = AGENTS.md@${run.oldRef} (${s("old").promptChars} chars) · NEW = ${run.newRef} ` +
			`(${s("new").promptChars} chars) · both on ${run.provider}/${run.model} · intensity ${run.intensity}\n`
	)

	console.log(`                                OLD                        NEW`)
	const row = (label: string, k: (x: ArmSummary) => number, n: (x: ArmSummary) => number) =>
		console.log(`${label.padEnd(30)}  ${share(k(s("old")), n(s("old"))).padEnd(24)}   ${share(k(s("new")), n(s("new")))}`)
	row("items on the 10-15 window", x => x.windowDeath, x => x.items)
	row("items on the early ledger", x => x.earlyObjective, x => x.items)
	row("ON TARGET (either)", x => x.onTarget, x => x.items)
	row("on target, games w/ material", x => x.onTargetWhereAvailable.k, x => x.onTargetWhereAvailable.n)
	row("items mentioning unspent gold", x => x.patternHits.unspentGold ?? 0, x => x.items)
	row("items naming the enemy jungle", x => x.patternHits.enemyJungle ?? 0, x => x.items)
	row("category = vision", x => x.categories.vision ?? 0, x => x.items)
	row("items citing an invented id", x => x.citationWarnings, x => x.items)

	console.log(
		`\nreviews ok: old ${s("old").reviews}/${s("old").reviews + s("old").failedReviews}, ` +
			`new ${s("new").reviews}/${s("new").reviews + s("new").failedReviews} · ` +
			`items/review: old ${s("old").meanItemsPerReview.toFixed(1)}, new ${s("new").meanItemsPerReview.toFixed(1)}`
	)
	for (const arm of ["old", "new"]) {
		console.log(
			`\n${arm} categories: ${Object.entries(s(arm).categories).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}`
		)
		console.log(`${arm} tSec:       ${Object.entries(s(arm).tSecBuckets).map(([k, v]) => `${k} ${v}`).join(" · ")}`)
		const w = Object.entries(s(arm).warnings).sort((a, b) => b[1] - a[1])
		console.log(`${arm} warnings:   ${w.length === 0 ? "none" : w.map(([k, v]) => `${k} ${v}`).join(" · ")}`)
	}
	const pr = run.pairedOnTarget
	console.log(
		`\npaired over the ${pr.aOnly + pr.bOnly + pr.both + pr.neither} games with the material: the arm produced >=1 ` +
			`on-target item — only old ${pr.aOnly}, only new ${pr.bOnly}, both ${pr.both}, neither ${pr.neither}, p ${pr.p.toFixed(4)}`
	)
}

/* ═════════════════════════════════════════════════════════════ main */

const runJudge = async (): Promise<void> => {
	const run = JSON.parse(readFileSync(JUDGE_RUN, "utf8")) as {
		items: ItemRecord[]
		userPrompts: Record<string, string>
		arms: { arm: string }[]
	}
	const { modelHandleFor, providerById, providerKey } = await import("../src/review/live-providers.ts")
	const { generateText } = await import("ai")
	const p = providerById(JUDGE_PROVIDER)
	if (!p) throw new Error(`no provider ${JUDGE_PROVIDER}`)
	const key = providerKey(p)
	if (!key) throw new Error(`no key for ${JUDGE_PROVIDER}`)
	const handle = await modelHandleFor(p, key, JUDGE_MODEL)

	const byGame = new Map<number, ItemRecord[]>()
	for (const it of run.items) byGame.set(it.gameId, [...(byGame.get(it.gameId) ?? []), it])

	const verdicts: (ItemRecord & { useful: boolean; supported: boolean; reason: string })[] = []
	/** Per game: how many items went up and how many verdicts came back. A judge that drops a game is data. */
	const coverage: { gameId: number; itemsSent: number; verdicts: number; note: string }[] = []
	let gi = 0
	for (const [gameId, items] of byGame) {
		gi++
		// One shuffle per game under the seed, so the blind ids are reproducible from the run file.
		const pool = shuffled(items, SEED + gameId)
		const blind = pool.map((it, i) => ({ it, blindId: `x${i + 1}` }))
		const listing = blind
			.map(b => `${b.blindId}. TITLE: ${b.it.title}\n    FIX: ${b.it.fix}\n    BODY: ${b.it.body}`)
			.join("\n\n")
		const digest = run.userPrompts[String(gameId)] ?? ""
		let text = ""
		try {
			const r = await generateText({
				model: handle,
				messages: [
					{
						role: "user",
						content: `${JUDGE_INSTRUCTIONS}\n\n===== THE DIGEST THE COACH WAS SHOWN =====\n${digest}\n\n===== THE ITEMS =====\n${listing}`
					}
				],
				/*
				 * 32000 AND NOT 8000, and the difference is the whole first judging run.
				 *
				 * At 8000 `claude-sonnet-5` came back with `finishReason: "length"`, 8000 output
				 * tokens and an EMPTY string on 11 of 30 games: it spent the entire budget on
				 * extended thinking and never reached the JSON. That is the failure AGENTS.md
				 * already names — "a tight `maxOutputTokens` does not shorten a reasoning model,
				 * it TRUNCATES it" — and the run that hit it is kept as
				 * `…-judged-claude-sonnet-5.json`, judging only the 19 games that survived, with
				 * this one beside it rather than over it.
				 */
				maxOutputTokens: 32000
			})
			text = r.text
			if (r.finishReason === "length")
				console.error(`game ${gameId}: judge hit the output cap (${r.usage?.outputTokens ?? "?"} tokens)`)
		} catch (e) {
			coverage.push({ gameId, itemsSent: items.length, verdicts: 0, note: `call failed: ${e instanceof Error ? e.message : String(e)}` })
			console.error(`game ${gameId} judge FAILED: ${e instanceof Error ? e.message : String(e)}`)
			continue
		}
		const start = text.indexOf("{")
		const end = text.lastIndexOf("}")
		let parsed: { verdicts?: JudgedItem[] } | null = null
		try {
			parsed = start === -1 ? null : (JSON.parse(text.slice(start, end + 1)) as { verdicts?: JudgedItem[] })
		} catch {
			parsed = null
		}
		if (!parsed?.verdicts) {
			coverage.push({ gameId, itemsSent: items.length, verdicts: 0, note: "no parsable verdicts" })
			console.error(`game ${gameId}: judge returned no parsable verdicts`)
			continue
		}
		coverage.push({ gameId, itemsSent: items.length, verdicts: parsed.verdicts.length, note: "" })
		for (const v of parsed.verdicts) {
			const b = blind.find(x => x.blindId === v.blindId)
			if (!b) continue
			verdicts.push({ ...b.it, useful: v.useful === true, supported: v.supported === true, reason: String(v.reason ?? "") })
		}
		console.error(`game ${gi}/${byGame.size} ${gameId}: ${parsed.verdicts.length} verdicts`)
	}

	const arms = [...new Set(verdicts.map(v => v.arm))]
	const lines: string[] = []
	const wilsons: Record<string, ReturnType<typeof wilson>> = {}
	for (const a of arms) {
		const mine = verdicts.filter(v => v.arm === a)
		wilsons[a] = wilson(mine.filter(v => v.useful).length, mine.length)
		lines.push(
			`${a.padEnd(10)} useful ${share(mine.filter(v => v.useful).length, mine.length).padEnd(24)} ` +
				`supported ${share(mine.filter(v => v.supported).length, mine.length)}`
		)
	}
	const [a0, a1] = arms
	const sep = a0 && a1 && wilsons[a0] && wilsons[a1] ? separated(wilsons[a0], wilsons[a1]) : false
	const judgeOut = JUDGE_OUT !== "" ? JUDGE_OUT : JUDGE_RUN.replace(/\.json$/, `-judged-${JUDGE_MODEL}.json`)
	writeFileSync(
		judgeOut,
		`${JSON.stringify({ judgeProvider: JUDGE_PROVIDER, judgeModel: JUDGE_MODEL, seed: SEED, ranAt: new Date().toISOString(), separated: sep, coverage, verdicts }, null, "\t")}\n`
	)
	console.log(`judged ${coverage.filter(c => c.verdicts > 0).length} of ${coverage.length} games; ${coverage.filter(c => c.verdicts === 0).length} produced nothing parsable`)
	console.log(lines.join("\n"))
	console.log(
		sep ? "\nThe Wilson intervals SEPARATE."
		: `\nThe Wilson intervals OVERLAP: this is a NULL on quality, not a win for either arm.`
	)
	console.log(`wrote ${judgeOut}`)
}

const runAb = async (): Promise<void> => {
	/* ────────────────────────────────────────────────────── the A/B run */

	// Before anything imports a query module: the singleton must be the read-only handle, or
	// `getDb()` would open a writable connection and run migrations under a live daemon.
	useDb(new DatabaseSync(DB_PATH, { readOnly: true }))

	const { getGame, getParticipants, getMetrics, getMoments, getSettings } = await import("../src/db/queries.ts")
	const { loadTimeline } = await import("../src/daemon/corpus.ts")
	const { buildGameDigest } = await import("../src/daemon/digest.ts")
	const { extractPersona, gamePrompt } = await import("../src/review/prompt.ts")
	const { allowlistOf } = await import("../src/review/digest-contract.ts")
	const { buildReview } = await import("../src/review/parse.ts")
	const { buildGamePack, renderPack } = await import("../src/review/pack.ts")
	const { baselineDuring } = await import("./lib/stream.ts")
	const { ANALYSIS_VERSION } = await import("../src/shared/constants.ts")
	const { modelHandleFor, providerById, providerKey } = await import("../src/review/live-providers.ts")
	const { generateText } = await import("ai")

	const db = new DatabaseSync(DB_PATH, { readOnly: true })
	/*
	 * The population, stated so it can be re-derived: ranked solo (420), jungle, at least fifteen
	 * minutes on the clock, with a stored timeline and with the metrics and moments a digest needs.
	 * Most recent first, because those are the games on the current analysis version.
	 */
	const candidates = db
		.prepare(
			`SELECT g.gameId, g.win, g.championName, g.gameDurationSec
			   FROM game g
			  WHERE g.queueId = 420 AND g.role = 'JGL' AND g.gameDurationSec >= 900
			    AND g.timelineBlob IS NOT NULL
			    AND (SELECT count(*) FROM metric m WHERE m.gameId = g.gameId) > 0
			    AND (SELECT count(*) FROM moment mo WHERE mo.gameId = g.gameId) > 0
			  ORDER BY g.endedAtMs DESC
			  LIMIT ?`
		)
		.all(GAMES) as unknown as { gameId: number | bigint; win: number | bigint; championName: string; gameDurationSec: number | bigint }[]

	const gameIds = candidates.map(c => Number(c.gameId))
	if (gameIds.length === 0) throw new Error("no candidate games")

	const repoRoot = new URL("..", import.meta.url).pathname
	const rawAt = (ref: string): string =>
		ref === "" ?
			readFileSync(`${repoRoot}AGENTS.md`, "utf8")
		:	execFileSync("git", ["show", `${ref}:AGENTS.md`], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })

	const personas = [
		{ arm: "old", persona: extractPersona(rawAt(OLD_REF), `AGENTS.md@${OLD_REF}`), ref: OLD_REF },
		{ arm: "new", persona: extractPersona(rawAt(NEW_REF), NEW_REF === "" ? "AGENTS.md (working tree)" : `AGENTS.md@${NEW_REF}`), ref: NEW_REF === "" ? "(working tree)" : NEW_REF }
	]
	for (const p of personas)
		if (p.persona.source !== "markers")
			throw new Error(`arm ${p.arm}: persona came from ${p.persona.source}, not the COACH markers — refusing to measure a fallback`)

	const provider = providerById(PROVIDER)
	if (!provider) throw new Error(`no provider ${PROVIDER}`)
	const key = providerKey(provider)
	if (!key) throw new Error(`no key for ${PROVIDER} — expected data/${provider.keyFile}`)
	const handle = await modelHandleFor(provider, key, MODEL)

	const settings = getSettings()

	const allItems: ItemRecord[] = []
	const userPrompts: Record<string, string> = {}
	const perArm = new Map<string, { reviews: { gameId: number; ok: boolean; warnings: { code: string }[]; availWindow: boolean; availEarlyObj: boolean }[]; usage: { inputTokens: number; outputTokens: number }; latencyMsTotal: number; promptChars: number }>()
	for (const p of personas) perArm.set(p.arm, { reviews: [], usage: { inputTokens: 0, outputTokens: 0 }, latencyMsTotal: 0, promptChars: p.persona.text.length })

	const gameMeta: {
		gameId: number
		win: boolean
		champion: string
		durationSec: number
		moments: number
		metrics: number
		userSha: string
		availWindow: boolean
		availEarlyObj: boolean
		deathsInWindow: number
		objectivesBy10: number
	}[] = []

	let done = 0
	for (const gameId of gameIds) {
		done++
		const game = getGame(gameId)
		if (!game) continue
		const participants = getParticipants(gameId)
		const timeline = loadTimeline(gameId)
		const { baseline } = baselineDuring(String(gameId))
		const moments = getMoments(gameId)
		const digest = buildGameDigest({
			game,
			participants,
			metrics: getMetrics(gameId),
			moments,
			timeline,
			baseline: baseline ?? undefined,
			hasFrames: false,
			analysisVersion: ANALYSIS_VERSION
		})
		const packText = renderPack(buildGamePack({ game, participants, timeline, frames: [] }))

		/*
		 * THE CEILING. A prompt cannot produce an on-window death item for a game with no death in the
		 * window, so the availability of the material is recorded per game and reported beside the
		 * share. `objectives` here is the digest's own timestamped OBJECTIVES list, which is where the
		 * re-aimed persona tells the coach to count the ledger from.
		 */
		const deathsInWindow = moments.filter(m => m.kind === "death" && m.tSec >= WINDOW_LO && m.tSec < WINDOW_HI).length
		const objectivesBy10 = (digest.objectives ?? []).filter(o => o.tSec <= EARLY_HI).length

		const built = personas.map(p => gamePrompt(digest, { intensity: settings.coachIntensity, model: MODEL, persona: p.persona, pack: packText }))
		const userSha = createHash("sha256").update(built[0]?.user ?? "", "utf8").digest("hex")
		for (const b of built)
			if (createHash("sha256").update(b.user, "utf8").digest("hex") !== userSha)
				throw new Error(`game ${gameId}: the two arms' user turns differ — the experiment is broken`)
		userPrompts[String(gameId)] = built[0]?.user ?? ""

		gameMeta.push({
			gameId,
			win: game.win === true,
			champion: game.championName,
			durationSec: game.gameDurationSec,
			moments: moments.length,
			metrics: digest.metrics.length,
			userSha,
			availWindow: deathsInWindow > 0,
			availEarlyObj: objectivesBy10 > 0,
			deathsInWindow,
			objectivesBy10
		})

		/*
		 * ARM ORDER ALTERNATES per game. The two calls are independent — no thread, no cache carried
		 * between them — but a provider having a bad minute is a real thing, and alternating means a
		 * bad minute cannot land on one arm's games more than the other's.
		 */
		const order = done % 2 === 0 ? [...personas].reverse() : personas
		for (const p of order) {
			const b = built[personas.indexOf(p)]
			if (!b) continue
			const started = Date.now()
			let raw = ""
			let failed: string | null = null
			let usage: { inputTokens?: number; outputTokens?: number } = {}
			try {
				const r = await generateText({
					model: handle,
					system: b.system,
					messages: [{ role: "user", content: b.user }],
					// Generous on purpose: a tight cap truncates a reasoning model rather than shortening it.
					maxOutputTokens: 16000
				})
				raw = r.text
				usage = { inputTokens: r.usage?.inputTokens, outputTokens: r.usage?.outputTokens }
			} catch (e) {
				failed = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
			}
			const latencyMs = Date.now() - started
			const slot = perArm.get(p.arm)
			if (!slot) continue
			slot.latencyMsTotal += latencyMs
			slot.usage.inputTokens += usage.inputTokens ?? 0
			slot.usage.outputTokens += usage.outputTokens ?? 0

			const built2 = failed === null ?
				buildReview({
					raw,
					kind: "game",
					gameId,
					model: MODEL,
					promptHash: b.promptHash,
					allowed: allowlistOf(digest),
					durationSec: game.gameDurationSec,
					maxItems: 10
				})
			:	null

			if (!built2 || !built2.ok) {
				slot.reviews.push({ gameId, ok: false, warnings: built2?.warnings ?? [], availWindow: deathsInWindow > 0, availEarlyObj: objectivesBy10 > 0 })
				console.error(`game ${gameId} arm ${p.arm}: FAILED ${failed ?? (built2 && !built2.ok ? built2.code : "?")}`)
				continue
			}
			slot.reviews.push({ gameId, ok: true, warnings: built2.warnings, availWindow: deathsInWindow > 0, availEarlyObj: objectivesBy10 > 0 })
			built2.value.items.forEach((it, i) =>
				allItems.push(
					classify(
						{
							title: it.title,
							fix: it.fix,
							body: it.body,
							severity: it.severity,
							category: it.category,
							impact: it.impact,
							actionability: it.actionability,
							confidence: it.confidence,
							tSec: it.tSec,
							momentIds: it.momentIds,
							metricKeys: it.metricKeys
						},
						moments.map(m => ({ id: m.id, tSec: m.tSec, kind: m.kind })),
						p.arm,
						gameId,
						i
					)
				)
			)
			console.error(`game ${done}/${gameIds.length} ${gameId} arm ${p.arm}: ${built2.value.items.length} items, ${built2.warnings.length} warnings, ${latencyMs}ms`)
		}
	}

	const summaries = personas.map(p => {
		const slot = perArm.get(p.arm)
		if (!slot) throw new Error("missing arm")
		return summarise(p.arm, allItems.filter(i => i.arm === p.arm), slot.reviews, slot.promptChars, slot.usage, slot.latencyMsTotal)
	})

	/* The paired test: per game, did the arm produce at least one on-target item? */
	const pairs = gameMeta
		.filter(g => g.availWindow || g.availEarlyObj)
		.map(g => ({
			a: allItems.some(i => i.gameId === g.gameId && i.arm === "old" && i.onTarget),
			b: allItems.some(i => i.gameId === g.gameId && i.arm === "new" && i.onTarget)
		}))
	const paired = mcnemar(pairs)

	writeFileSync(
		OUT,
		`${JSON.stringify(
			{
				ranAt: new Date().toISOString(),
				provider: PROVIDER,
				model: MODEL,
				oldRef: OLD_REF,
				newRef: NEW_REF === "" ? "(working tree)" : NEW_REF,
				personaChars: Object.fromEntries(personas.map(p => [p.arm, p.persona.text.length])),
				personaSha: Object.fromEntries(personas.map(p => [p.arm, createHash("sha256").update(p.persona.text, "utf8").digest("hex").slice(0, 16)])),
				intensity: settings.coachIntensity,
				windowLo: WINDOW_LO,
				windowHi: WINDOW_HI,
				earlyHi: EARLY_HI,
				patterns: Object.fromEntries(Object.entries(PATTERNS).map(([k, v]) => [k, v.source])),
				games: gameMeta,
				summaries,
				pairedOnTarget: paired,
				items: allItems,
				userPrompts
			},
			null,
			"\t"
		)}\n`
	)

	printReport(JSON.parse(readFileSync(OUT, "utf8")) as StoredRun)
	console.log(`\nwrote ${OUT}`)

}

if (import.meta.main) {
	// `--read` consults no model and costs nothing: it reprints a finished run from its own file.
	if (READ_RUN !== "") printReport(JSON.parse(readFileSync(READ_RUN, "utf8")) as StoredRun)
	else if (JUDGE_RUN !== "") await runJudge()
	else await runAb()
}
