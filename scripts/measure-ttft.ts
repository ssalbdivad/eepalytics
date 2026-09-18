/**
 * What a turn-based coach actually costs him in WAITING — and whether a cached prefix and a
 * streamed answer change which models are eligible for a live game.
 *
 * ## The question, and why the old answer is not the answer
 *
 * The stored comparison of five models measured TIME TO FULL ANSWER on a buffered request with the
 * whole system prompt re-sent every turn. On that measurement Opus is 6.3s and disqualified, and
 * the app has therefore never run anything but a flash model on the socket. Two things in that
 * sentence are properties of HOW WE CALL the model rather than of the model:
 *
 *   1. the system instruction — persona, prompt, his champion's prose, the counterpart's, the role
 *      file — is about 33,000 characters, static for a whole game, and was re-sent on every turn.
 *      Both vendors cache prefixes. Nobody here had ever used it.
 *   2. the answer was BUFFERED. `speechSynthesis` was handed a finished sentence, so the first
 *      syllable landed after the last token was paid for. Streaming the first clause into the voice
 *      moves that clock without changing a word of what is said.
 *
 * This script measures both, paired, on real payloads from a real game.
 *
 * ## What it sends
 *
 * Real turns, from a benchable window on disk (`scripts/lib/stream.ts`) — the trusted brief for
 * that instant and, on the frame arms, the journal frame he was actually looking at. Every arm gets
 * the SAME turn in the same order, and the arm order is rotated inside each turn, so a difference
 * between two arms cannot be a difference between two moments of the afternoon. That is the
 * interleaving `scripts/frame-value.ts` established and the reason its null result is believable.
 *
 * ## The three axes, each an ablation against the shipped behaviour
 *
 *   - `cache`   — a `cache_control` breakpoint on the system block (Anthropic). The `nocache` arm
 *                 is the shipped behaviour. Google's caching is IMPLICIT and already on: its
 *                 `nocache` arm cannot turn anything off, so its cache figures are an observation
 *                 and are reported as one.
 *   - `stream`  — token streaming, with `SpeechChunker` deciding when a voice could start. The
 *                 buffered arm is the shipped behaviour.
 *   - `effort`  — `low` against the vendor default. Every model here defaults to thinking and
 *                 thinking is the wall; an arm run at a different effort from its rivals is
 *                 measuring effort, so it is pinned per arm and printed in every table.
 *
 * ## What it refuses to do
 *
 * It does not judge a line. Nothing here says whether the coaching was any good, and no number in
 * its output may be quoted as if it did — the judge disagrees with itself on about 16% of identical
 * lines, which is larger than most of the effects this script can see. Latency and tokens are
 * cheap to measure and honest; quality is neither, and `scripts/bench-stream.ts` is where that
 * question belongs.
 *
 * Usage:
 *   node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *     scripts/measure-ttft.ts [--turns 6] [--window <id>] [--arms a,b] [--frames] [--dry]
 */

import { readFileSync, writeFileSync } from "node:fs"
import { buildStream, discoverBenchable, median } from "./lib/stream.ts"
import { coachSystemPrompt, coachTurn, providerKey, providerById } from "../src/review/live-providers.ts"
import type { CoachEffort, ProviderId } from "../src/review/live-providers.ts"
import { DATA_DIR } from "../src/shared/constants.ts"

/* ============================================================== the arms */

interface Arm {
	id: string
	provider: ProviderId
	model: string
	effort: CoachEffort
	cache: boolean
	stream: boolean
	frame: boolean
	/** $ per million input / output tokens, for the cost table. Cache reads are 0.1x input. */
	priceIn: number
	priceOut: number
}

/**
 * Prices are per million tokens, from each vendor's published rate at the time of the run, and they
 * are DATA in this file rather than a lookup: a stored run must still be readable when the rate
 * card has moved, and a run whose costs were computed from a table that has since changed is a run
 * nobody can check.
 *
 * Anthropic: cache WRITE is 1.25x input, cache READ is 0.1x input.
 * Google: implicit cache hits are billed at 0.1x input on the flash models.
 */
const ARMS: readonly Arm[] = [
	// --- the direct test of his hypothesis: the strongest model, made as fast as it can be ---
	{ id: "opus5-low-cache-stream", provider: "anthropic", model: "claude-opus-5", effort: "low", cache: true, stream: true, frame: false, priceIn: 5, priceOut: 25 },
	{ id: "opus5-low-nocache-stream", provider: "anthropic", model: "claude-opus-5", effort: "low", cache: false, stream: true, frame: false, priceIn: 5, priceOut: 25 },
	{ id: "opus5-low-cache-buffered", provider: "anthropic", model: "claude-opus-5", effort: "low", cache: true, stream: false, frame: false, priceIn: 5, priceOut: 25 },
	{ id: "opus5-default-cache-stream", provider: "anthropic", model: "claude-opus-5", effort: "default", cache: true, stream: true, frame: false, priceIn: 5, priceOut: 25 },

	// --- the one most likely to ship: strong, cheap, and already close to the socket ---
	{ id: "sonnet5-low-cache-stream", provider: "anthropic", model: "claude-sonnet-5", effort: "low", cache: true, stream: true, frame: false, priceIn: 2, priceOut: 10 },
	{ id: "sonnet5-low-nocache-stream", provider: "anthropic", model: "claude-sonnet-5", effort: "low", cache: false, stream: true, frame: false, priceIn: 2, priceOut: 10 },
	{ id: "sonnet5-low-cache-buffered", provider: "anthropic", model: "claude-sonnet-5", effort: "low", cache: true, stream: false, frame: false, priceIn: 2, priceOut: 10 },

	// --- the floor, and the post-game writer measured here only to show why it is post-game ---
	{ id: "haiku45-low-cache-stream", provider: "anthropic", model: "claude-haiku-4-5", effort: "low", cache: true, stream: true, frame: false, priceIn: 1, priceOut: 5 },
	{ id: "fable51-low-cache-stream", provider: "anthropic", model: "claude-fable-5-1", effort: "low", cache: true, stream: true, frame: false, priceIn: 10, priceOut: 50 },

	// --- Gemini's turn path: the shipped default, and three releases newer ---
	{ id: "g38flash-low-stream", provider: "gemini-http", model: "gemini-3.8-flash", effort: "low", cache: true, stream: true, frame: false, priceIn: 0.75, priceOut: 3.75 },
	{ id: "g38flash-low-buffered", provider: "gemini-http", model: "gemini-3.8-flash", effort: "low", cache: true, stream: false, frame: false, priceIn: 0.75, priceOut: 3.75 },
	{ id: "g36flash-default-stream", provider: "gemini-http", model: "gemini-3.6-flash", effort: "default", cache: true, stream: true, frame: false, priceIn: 0.3, priceOut: 2.5 },

	// --- what a picture costs on this path, paired against the same arm without one ---
	{ id: "sonnet5-low-cache-stream+frame", provider: "anthropic", model: "claude-sonnet-5", effort: "low", cache: true, stream: true, frame: true, priceIn: 2, priceOut: 10 },
	{ id: "g38flash-low-stream+frame", provider: "gemini-http", model: "gemini-3.8-flash", effort: "low", cache: true, stream: true, frame: true, priceIn: 0.75, priceOut: 3.75 }
]

/* ============================================================== one record */

interface Record_ {
	arm: string
	provider: string
	model: string
	effort: CoachEffort
	cacheRequested: boolean
	stream: boolean
	frame: boolean
	windowId: string
	gameId: string
	turn: number
	atSec: number
	clock: string
	/** 1-based: the first call of an arm WRITES the cache, so it is not a cached call. */
	call: number
	ok: boolean
	reason?: string
	text: string
	latencyMs: number
	ttftMs: number | null
	speakableMs: number | null
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	systemChars: number
	payloadChars: number
}

/* ============================================================== statistics */

const quantile = (xs: readonly number[], q: number): number => {
	if (xs.length === 0) return 0
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.min(s.length - 1, Math.floor(q * s.length))]!
}

/**
 * The two-sided sign test, exact.
 *
 * Paired latency is noisy and skewed, so the honest test on N turns is how often one arm beat the
 * other, not how far apart their means are. Ties are DROPPED, which is the standard treatment and
 * also the conservative one here.
 */
const signTest = (a: readonly number[], b: readonly number[]): { wins: number; n: number; p: number } => {
	let wins = 0
	let n = 0
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (a[i] === b[i]) continue
		n += 1
		if (a[i]! < b[i]!) wins += 1
	}
	if (n === 0) return { wins: 0, n: 0, p: 1 }
	const choose = (nn: number, k: number): number => {
		let r = 1
		for (let i = 0; i < k; i++) r = (r * (nn - i)) / (i + 1)
		return r
	}
	let tail = 0
	const lo = Math.min(wins, n - wins)
	for (let k = 0; k <= lo; k++) tail += choose(n, k)
	const p = Math.min(1, (2 * tail) / 2 ** n)
	return { wins, n, p }
}

/* ============================================================== the run */

const argv = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
	const at = argv.indexOf(`--${name}`)
	return at === -1 || at === argv.length - 1 ? fallback : argv[at + 1]!
}
const has = (name: string): boolean => argv.includes(`--${name}`)

/**
 * Re-read stored runs and print the tables again, pooling them.
 *
 * A run costs real money, so the reporting must be separable from the calling — every stored run
 * stays re-derivable, and a later question ("what did the frame arms do?") is answered from the
 * bytes on disk rather than by spending the bill again. Pooling several runs is how n grows: each
 * one is internally paired (same turns, same order), and the paired differences concatenate.
 */
const readRuns = (paths: readonly string[]): { records: Record_[]; arms: Arm[] } => {
	const records: Record_[] = []
	const arms = new Map<string, Arm>()
	for (const [runIndex, path] of paths.entries()) {
		const d = JSON.parse(readFileSync(path, "utf8")) as { records: Record_[]; arms: Arm[] }
		for (const a of d.arms) arms.set(a.id, a)
		// Turn numbers repeat across runs, and the pairing keys on them — so a pooled record is
		// keyed by (run, turn) or run two silently overwrites run one's pairs.
		for (const r of d.records) records.push({ ...r, turn: r.turn + runIndex * 100000 })
	}
	return { records, arms: [...arms.values()] }
}

const main = async (): Promise<void> => {
	const read = flag("read", "")
	if (read !== "") {
		const paths = read.split(",")
		const { records, arms } = readRuns(paths)
		console.log(`\n  pooled ${paths.length} run(s), ${records.length} calls\n`)
		report(records, arms)
		return
	}
	const turnsWanted = Number(flag("turns", "6"))
	const only = flag("arms", "")
	const arms = ARMS.filter(a => {
		if (only !== "" && !only.split(",").includes(a.id)) return false
		// A frame arm is only meaningful when the window actually has paired frames, and only when
		// asked for: a picture is billed on every one of these calls.
		if (a.frame && !has("frames")) return false
		return providerKey(providerById(a.provider)!) !== null
	})
	if (arms.length === 0) throw new Error("no arms — check --arms and the key files under data/")

	const { paired } = discoverBenchable()
	const wanted = flag("window", "")
	const window = wanted === "" ? paired[0] : paired.find(w => w.id === wanted)
	if (!window) throw new Error(`no paired window ${wanted === "" ? "at all" : wanted}`)

	const stream = buildStream(window, {
		everySec: 20,
		fromSec: 0,
		turns: turnsWanted,
		requireFrame: has("frames"),
		schedule: "events",
		// Named out loud, every time: a replay that does not say which schedule it replays is the bug.
		level: "commentary"
	})
	const turns = stream.turns.filter(t => t.brief !== "").slice(0, turnsWanted)
	if (turns.length === 0) throw new Error("the window produced no payloads")

	const champion = window.champion
	const counterpart = turns[0]!.counterpart ?? null
	const systemChars = coachSystemPrompt({ champion, counterpart }).length

	console.log(`\n  window ${window.id}  game ${window.gameId}  ${champion} vs ${counterpart ?? "?"}`)
	console.log(`  ${turns.length} real turns · system prompt ${systemChars.toLocaleString()} chars · ${arms.length} arms`)
	console.log(`  payload ${median(turns.map(t => t.brief.length)).toLocaleString()} chars (median)`)
	if (has("dry")) {
		for (const a of arms) console.log(`   ${a.id}`)
		return
	}

	const records: Record_[] = []
	const calls = new Map<string, number>()

	for (const [i, t] of turns.entries()) {
		// Rotate the arm order inside the turn, so no arm is always first and no arm is always
		// paying for a cold connection.
		const order = arms.map((_, k) => arms[(k + i) % arms.length]!)
		for (const arm of order) {
			const call = (calls.get(arm.id) ?? 0) + 1
			calls.set(arm.id, call)
			const r = await coachTurn({
				provider: arm.provider,
				model: arm.model,
				blockText: t.brief,
				mode: "trusted",
				champion,
				counterpart,
				cache: arm.cache,
				effort: arm.effort,
				...(arm.frame && t.frameB64 ? { frameJpegBase64: t.frameB64 } : {}),
				...(arm.stream ? { onDelta: () => {} } : {})
			})
			records.push({
				arm: arm.id,
				provider: arm.provider,
				model: arm.model,
				effort: arm.effort,
				cacheRequested: r.cacheRequested ?? false,
				stream: arm.stream,
				frame: arm.frame && t.frameB64 !== null,
				windowId: window.id,
				gameId: window.gameId,
				turn: t.index,
				atSec: t.atSec,
				clock: t.clock,
				call,
				ok: r.ok,
				...(r.reason ? { reason: r.reason } : {}),
				text: r.text,
				latencyMs: r.latencyMs,
				ttftMs: r.ttftMs ?? null,
				speakableMs: r.speakableMs ?? null,
				inputTokens: r.usage?.inputTokens ?? 0,
				outputTokens: r.usage?.outputTokens ?? 0,
				cacheReadTokens: r.usage?.cacheReadTokens ?? 0,
				cacheWriteTokens: r.usage?.cacheWriteTokens ?? 0,
				systemChars,
				payloadChars: t.brief.length
			})
			const last = records[records.length - 1]!
			console.log(
				`  ${t.clock}  ${last.arm.padEnd(30)} ${last.ok ? "" : "FAILED "}` +
					`total ${String(last.latencyMs).padStart(6)}ms  ` +
					`ttft ${String(last.ttftMs ?? "-").padStart(6)}  ` +
					`say ${String(last.speakableMs ?? "-").padStart(6)}  ` +
					`in ${String(last.inputTokens).padStart(6)} (cached ${String(last.cacheReadTokens).padStart(6)})  ` +
					`out ${String(last.outputTokens).padStart(4)}` +
					(last.ok ? "" : `  ${String(last.reason).slice(0, 120)}`)
			)
		}
	}

	const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13)
	const path = `${DATA_DIR}/eval/ttft-${stamp}.json`
	writeFileSync(
		path,
		JSON.stringify(
			{
				kind: "ttft",
				at: new Date().toISOString(),
				window: window.id,
				gameId: window.gameId,
				champion,
				counterpart,
				schedule: "events",
				level: "commentary",
				mode: "trusted",
				turns: turns.map(t => ({ index: t.index, atSec: t.atSec, clock: t.clock, chars: t.brief.length })),
				systemChars,
				arms,
				records
			},
			null,
			2
		)
	)
	report(records, arms)
	console.log(`\n  written: ${path}\n`)
}

/* ============================================================== the tables */

const report = (records: readonly Record_[], arms: readonly Arm[]): void => {
	const byArm = (id: string): Record_[] => records.filter(r => r.arm === id && r.ok)

	console.log(`\n  ── per arm ────────────────────────────────────────────────────────────────`)
	console.log(
		`  ${"arm".padEnd(30)}${"n".padStart(3)}${"spoke".padStart(7)}${"ttft p50".padStart(10)}` +
			`${"say p50".padStart(9)}${"total p50".padStart(11)}${"cache hit".padStart(11)}${"$/turn".padStart(10)}`
	)
	for (const a of arms) {
		const rs = byArm(a.id)
		if (rs.length === 0) {
			const failed = records.filter(r => r.arm === a.id)
			console.log(`  ${a.id.padEnd(30)}  0  ALL FAILED: ${String(failed[0]?.reason).slice(0, 90)}`)
			continue
		}
		// The first call of an arm writes the cache; steady state is every call after it, which is
		// what a game looks like after the first turn.
		const warm = rs.filter(r => r.call > 1)
		const cost = (r: Record_): number => {
			const fresh = Math.max(0, r.inputTokens - r.cacheReadTokens - r.cacheWriteTokens)
			return (
				(fresh * a.priceIn +
					r.cacheReadTokens * a.priceIn * 0.1 +
					r.cacheWriteTokens * a.priceIn * 1.25 +
					r.outputTokens * a.priceOut) /
				1e6
			)
		}
		const hit = warm.length === 0 ? 0 : median(warm.map(r => r.cacheReadTokens))
		/*
		 * SPOKE, and it is not decoration: an arm that answers PASS has no first syllable, and a
		 * median taken over the turns where it did speak would report a fast coach that is in fact a
		 * silent one. claude-haiku-4-5 is exactly that case in the run this column was added for.
		 * A streamed arm is counted as having spoken when a speakable fragment left the chunker; a
		 * buffered arm when the text was not the silence token.
		 */
		const spoke = rs.filter(r =>
			r.stream ? r.speakableMs !== null : r.text.trim() !== "" && !/^pass\b/i.test(r.text.trim())
		).length
		console.log(
			`  ${a.id.padEnd(30)}${String(rs.length).padStart(3)}${`${spoke}/${rs.length}`.padStart(7)}` +
				`${fmt(median(rs.map(r => r.ttftMs ?? 0))).padStart(10)}` +
				`${fmt(median(rs.map(r => r.speakableMs ?? 0))).padStart(9)}` +
				`${fmt(median(rs.map(r => r.latencyMs))).padStart(11)}` +
				`${String(hit).padStart(11)}` +
				`${("$" + (warm.length === 0 ? 0 : warm.reduce((s, r) => s + cost(r), 0) / warm.length).toFixed(4)).padStart(10)}`
		)
	}

	console.log(`\n  ── paired ablations (same turns, same order) ──────────────────────────────`)
	const pairs: [string, string, string][] = [
		["cache", "opus5-low-cache-stream", "opus5-low-nocache-stream"],
		["cache", "sonnet5-low-cache-stream", "sonnet5-low-nocache-stream"],
		["stream", "opus5-low-cache-stream", "opus5-low-cache-buffered"],
		["stream", "sonnet5-low-cache-stream", "sonnet5-low-cache-buffered"],
		["stream", "g38flash-low-stream", "g38flash-low-buffered"],
		["effort", "opus5-low-cache-stream", "opus5-default-cache-stream"],
		["frame", "sonnet5-low-cache-stream+frame", "sonnet5-low-cache-stream"],
		["frame", "g38flash-low-stream+frame", "g38flash-low-stream"]
	]
	for (const [axis, aId, bId] of pairs) {
		const a = byArm(aId)
		const b = byArm(bId)
		if (a.length === 0 || b.length === 0) continue
		// Pair strictly by turn, so a failed call on one arm drops the pair rather than shifting it.
		const turnsBoth = a.map(r => r.turn).filter(t => b.some(r => r.turn === t))
		const av = turnsBoth.map(t => a.find(r => r.turn === t)!)
		const bv = turnsBoth.map(t => b.find(r => r.turn === t)!)
		/*
		 * A BUFFERED arm's first syllable is its whole answer: nothing can be spoken until the last
		 * token lands. So the fair paired quantity is `speakableMs` where the arm streamed and the
		 * full latency where it did not — which is exactly the comparison the stream axis is making.
		 */
		const speak = (rs: Record_[]): number[] => rs.map(r => r.speakableMs ?? r.latencyMs)
		const st = signTest(speak(av), speak(bv))
		const dIn = median(av.map(r => r.inputTokens)) - median(bv.map(r => r.inputTokens))
		console.log(
			`  ${axis.padEnd(7)}${aId.padEnd(30)} vs ${bId.padEnd(30)}` +
				` first-syllable ${fmt(median(speak(av)))} vs ${fmt(median(speak(bv)))}` +
				`  faster on ${st.wins}/${st.n}, p=${st.p.toFixed(3)}` +
				`  input tokens ${dIn >= 0 ? "+" : ""}${dIn}`
		)
	}

	console.log(`\n  ── against the socket ─────────────────────────────────────────────────────`)
	console.log(`  the shipped Gemini Live socket answers at p50 1150ms and speaks natively.`)
	for (const a of arms) {
		const rs = byArm(a.id)
		if (rs.length === 0) continue
		/*
		 * Over the turns where it actually SPOKE, and that qualification is load-bearing.
		 *
		 * The first version of this table took `speakableMs ?? latencyMs`, and claude-haiku-4-5 came
		 * out at 822ms with the label "BEATS the socket" — while answering PASS on 6 of 6 turns. It
		 * was the latency of saying nothing. An arm that never speaks has no time to first syllable
		 * and the honest report is its silence, not a fast number.
		 */
		const said = rs.filter(r => r.speakableMs !== null).map(r => r.speakableMs!)
		if (said.length === 0) {
			// A buffered arm has no first-syllable clock of its own: the first syllable IS the whole
			// answer, which is the entire reason the streaming axis exists. An arm that streamed and
			// still said nothing is a different statement and gets a different line.
			const why =
				a.stream ?
					`SPOKE ON 0 of ${rs.length} turns — no first syllable to report`
				:	`buffered: the first syllable is the whole answer, p50 ${fmt(median(rs.map(r => r.latencyMs)))}`
			console.log(`  ${a.id.padEnd(30)} ${why}`)
			continue
		}
		const say = median(said)
		console.log(
			`  ${a.id.padEnd(30)} first syllable p50 ${fmt(say)}  p90 ${fmt(quantile(said, 0.9))}  ` +
				`(spoke ${said.length}/${rs.length})  ` +
				(say <= 1150 ? "BEATS the socket" : say <= 2000 ? "usable" : "too slow to ship live")
		)
	}
	/*
	 * COST PER GAME, which is the only form of the cost number he can act on.
	 *
	 * Two schedules, because the app ships one and every stored measurement was taken on the other:
	 * `big-calls` asks 8.5 times in a 28-minute game and is the default; `commentary` asks 30.4 and
	 * is what every run in `data/eval/` was replayed at. Quoting one without naming it is how a
	 * cost claim becomes unfalsifiable.
	 */
	console.log(`\n  ── cost per 28-minute game ────────────────────────────────────────────────`)
	console.log(`  ${"arm".padEnd(30)}${"big-calls (8.5 asks)".padStart(22)}${"commentary (30.4)".padStart(20)}`)
	for (const a of arms) {
		const warm = byArm(a.id).filter(r => r.call > 1)
		if (warm.length === 0) continue
		const per =
			warm.reduce((sum, r) => {
				const fresh = Math.max(0, r.inputTokens - r.cacheReadTokens - r.cacheWriteTokens)
				return (
					sum +
					(fresh * a.priceIn +
						r.cacheReadTokens * a.priceIn * 0.1 +
						r.cacheWriteTokens * a.priceIn * 1.25 +
						r.outputTokens * a.priceOut) /
						1e6
				)
			}, 0) / warm.length
		console.log(
			`  ${a.id.padEnd(30)}${("$" + (per * 8.5).toFixed(3)).padStart(22)}${("$" + (per * 30.4).toFixed(3)).padStart(20)}`
		)
	}

	console.log(
		`\n  POWER: n is at most one call per arm per turn on ONE game. These separate 0.5s from 3s\n` +
			`  and they do NOT separate 1.0s from 1.3s. No line here is a quality claim: nothing in\n` +
			`  this script judged a single sentence.\n`
	)
}

const fmt = (ms: number): string => (ms === 0 ? "-" : `${Math.round(ms)}ms`)

await main()
