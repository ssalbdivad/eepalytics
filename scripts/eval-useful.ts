/**
 * Is the live coach USEFUL? One command, six axes, over a real recorded game.
 *
 *     node --experimental-strip-types scripts/eval-useful.ts --game split-03 --turns 30
 *
 * ## Why this exists
 *
 * Nine lines, four minutes, and he turned the coach off. Every line was true. `coach-score.ts`
 * scored the set perfectly, because correctness is the only thing this app has ever measured and
 * correctness was already at ceiling. Months of tuning moved a number with nowhere left to go.
 *
 * From first principles a line is useful iff it CHANGES WHAT HE DOES, FOR THE BETTER, AT A MOMENT
 * WHEN HE CAN STILL ACT — six axes, of which one was measured. `analysis/useful.ts` holds the
 * assembly and the thresholds; this file is the DRIVER, and everything it does is chosen so the
 * thing measured is the thing shipped:
 *
 *   - states come from `data/live-samples/*.ndjson`, the raw `allgamedata` the daemon recorded
 *     every five seconds of a real game;
 *   - the block comes from `buildLiveStateForBench`, which is the daemon's own `buildLiveState`;
 *   - the ranked facts are that call's `state.unseen`, i.e. `buildFacts`, with its real memory —
 *     which is why the replay steps EVERY turn from the start of the game even when only a window
 *     of them is sent. The rate limiting is state, and a replay that skips turns has a different
 *     coach's memory;
 *   - the sentence comes from `coachTurn` in `review/live-providers.ts`, where the system prompt is
 *     not a parameter, so a comparison cannot have accidentally varied the prompt too;
 *   - the latency used for the timeliness axis is the REAL `latencyMs` that call took.
 *
 * A harness that tests a copy tests nothing. There is no reimplementation here of anything that
 * ships, with one exception, marked and explained: `coachStateFrom` below.
 *
 * ## What it prints, and in what order
 *
 * THE SENTENCES FIRST. Every bug this instrument exists to catch survived a green percentage, so
 * the report leads with the worst five lines and the best five, quoted in full with their clock and
 * the reason, and only then gives the table. A reader who stops after ten seconds should have read
 * the coach's own words and not a number.
 *
 * Every rate carries n and a Wilson 95% interval, and `--compare` says outright when two runs are
 * not distinguishable. Small n has embarrassed this project before.
 *
 * ## The full run is written to disk and never overwritten
 *
 * `data/eval/useful-<stamp>.json` carries the arguments, every block, every ranked list, every
 * sentence and every verdict, so a run can be re-scored against a changed threshold without paying
 * the model again, and so two runs weeks apart can be compared.
 *
 * ## Arguments
 *
 *     --game <id>        a file in data/live-samples (default split-03; "latest" for newest)
 *     --turns N          how many turns to actually send to the model (default 30)
 *     --from SEC         game clock to start sending at (default 0; the ranker is stepped from 0 either way)
 *     --every SEC        turn cadence in game-clock seconds (default 20, the shipped middle setting)
 *     --provider <id>    mock | gemini-http | anthropic | openai | kimi | glm (default gemini-http)
 *     --model <id>       free text, as everywhere in this app
 *     --frame <path>     a JPEG to send with every turn (off by default — see the note at `FRAME`)
 *     --judge [model]    also run the forced-choice genericness arm (costs one call per line)
 *     --compare <file>   a previous useful-*.json to compare this run against
 *     --out <file>       where to write (default data/eval/useful-<stamp>.json)
 *     --lines            print every line, not only the worst and best five
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { DATA_DIR } from "../src/shared/constants.ts"
import { renderState } from "../src/shared/live-state.ts"
import type { VisionState } from "../src/shared/live-state.ts"
import { buildLiveStateForBench } from "../src/server/routes/live.ts"
import { coachTurn, providerById } from "../src/review/live-providers.ts"
import type { ProviderId } from "../src/review/live-providers.ts"
import {
	AXES,
	clockOf,
	compareRuns,
	scoreTranscript,
	worstFirst,
	bestFirst
} from "../src/analysis/useful.ts"
import type { LineVerdict, TranscriptVerdict, UsefulInput } from "../src/analysis/useful.ts"
import { speechDurationSec, stateAt } from "../src/analysis/timeliness.ts"
import type { CoachState } from "../src/analysis/timeliness.ts"
import {
	buildTrials,
	runTrials,
	positionBias,
	summarize
} from "../src/analysis/discriminability.ts"
import type { Judge, LineUnderTest, StateCard } from "../src/analysis/discriminability.ts"
import type { Interval } from "../src/analysis/coach-score.ts"

/* ================================================================== arguments */

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : fallback
}
const has = (name: string): boolean => argv.includes(`--${name}`)

/* ================================================== the one reimplementation */

const OBJECTIVE_EVENTS = new Set(["DragonKill", "BaronKill", "HeraldKill"])
const DRAGON_RESPAWN_SEC = 300
const BARON_RESPAWN_SEC = 360
const HERALD_RESPAWN_SEC = 360

interface RawSample {
	atMs: number
	gameTime: number
	data: unknown
}

/**
 * The recorded client payload, untyped on purpose.
 *
 * `schema/live.ts` types what the app CONSUMES; a recorded sample is whatever the client wrote on
 * the patch it was running, and a harness that refuses to parse an old sample because a field
 * moved would throw away the only real games on disk. `buildLiveStateForBench` does the same thing
 * one line later with its own cast.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const lastEventTime = (d: Any, name: string, respawn: number, now: number): number | null => {
	const ev: Any[] = d?.events?.Events ?? []
	for (let i = ev.length - 1; i >= 0; i--)
		if (ev[i].EventName === name && ev[i].EventTime !== undefined)
			return Math.round(ev[i].EventTime + respawn - now)
	return null
}

/**
 * The raw sample as the STALENESS check needs it.
 *
 * This is the only thing in this file that restates logic the daemon owns, and it is deliberate:
 * `timeliness.ts` must be able to check a premise against a state the RANKER did not produce, or
 * it is checking the ranker's opinion of the world against itself. Structurally `CoachState` is a
 * subset of `FactInput`, so the two agree by construction on every field that matters; what is not
 * shared is the derivation, which is the point.
 *
 * `pace` is null for the same reason `buildLiveStateForBench` leaves it null: a recorded sample
 * carries the client's facts and not his rolling average, so the two CS rules are structurally
 * absent from any replay. That is a real hole in this instrument and it is stated in the report
 * rather than hidden — six of the nine lines he quit on were exactly those rules.
 */
export const coachStateFrom = (row: RawSample): CoachState | null => {
	const d = row.data as Any
	const id = d?.activePlayer?.riotId ?? d?.activePlayer?.summonerName ?? ""
	const me = (d?.allPlayers ?? []).find((p: Any) => (p.riotId ?? p.summonerName ?? "") === id)
	if (!me) return null
	const mine = me.team
	const others = (d.allPlayers ?? []).filter((p: Any) => p !== me)
	const enemies = others.filter((p: Any) => p.team !== mine)
	// Declared position first, Smite second — the same order `live.ts` uses, and for the same reason.
	const jungler =
		enemies.find((p: Any) => (p.position ?? "").toUpperCase() === "JUNGLE") ??
		enemies.find((p: Any) =>
			[
				p.summonerSpells?.summonerSpellOne?.displayName,
				p.summonerSpells?.summonerSpellTwo?.displayName
			].some((n: string) => (n ?? "").toLowerCase() === "smite")
		)
	const now = row.gameTime
	let mineN = 0
	let theirs = 0
	for (const e of (d.events?.Events ?? []) as Any[]) {
		if (!OBJECTIVE_EVENTS.has(e.EventName)) continue
		const k = (d.allPlayers ?? []).find(
			(p: Any) => p.riotId === e.KillerName || p.summonerName === e.KillerName
		)
		if (!k) continue
		if (k.team === mine) mineN += 1
		else theirs += 1
	}
	return {
		nowSec: now,
		meDeadForSec: me.isDead ? (me.respawnTimer ?? 0) : null,
		deadEnemies: enemies
			.filter((p: Any) => p.isDead && (p.respawnTimer ?? 0) > 0)
			.map((p: Any) => ({
				champion: p.championName ?? "an enemy",
				respawnSec: p.respawnTimer ?? 0,
				isJungler: (p.position ?? "").toUpperCase() === "JUNGLE"
			})),
		currentGold: d.activePlayer?.currentGold ?? null,
		pace: null,
		myCs: me.scores?.creepScore,
		meLevel: me.level,
		counterpart:
			jungler ?
				{ champion: jungler.championName, cs: jungler.scores?.creepScore, level: jungler.level }
			:	null,
		counterpartItems: ((jungler?.items ?? []) as Any[])
			.filter(i => !i.consumable && (i.price ?? 0) >= 2000 && i.displayName)
			.map(i => i.displayName as string),
		objectiveCount: { mine: mineN, theirs },
		enemyObjectives: ((d.events?.Events ?? []) as Any[])
			.filter(e => OBJECTIVE_EVENTS.has(e.EventName))
			.filter(e => {
				const k = (d.allPlayers ?? []).find(
					(p: Any) => (p.riotId ?? p.summonerName) === e.KillerName
				)
				// An unresolvable killer counts for nobody, never against him.
				return k ? k.team !== mine : false
			})
			.map(e => ({ name: e.EventName as string, atSec: (e.EventTime ?? 0) as number })),
		alliesAlive:
			(me.isDead ? 0 : 1) + others.filter((p: Any) => p.team === mine && !p.isDead).length,
		enemiesAlive: enemies.filter((p: Any) => !p.isDead).length,
		drakeBackInSec: lastEventTime(d, "DragonKill", DRAGON_RESPAWN_SEC, now),
		baronBackInSec: lastEventTime(d, "BaronKill", BARON_RESPAWN_SEC, now),
		heraldBackInSec: lastEventTime(d, "HeraldKill", HERALD_RESPAWN_SEC, now),
		killSecs: ((d.events?.Events ?? []) as Any[])
			.filter(e => e.EventName === "ChampionKill")
			.map(e => (e.EventTime ?? 0) as number)
	}
}

/* ==================================================================== replay */

export interface Turn {
	atSec: number
	state: VisionState
	block: string
	offered: string[]
	roster: string[]
	aliases: string[]
	sent: boolean
}

/**
 * Step the shipped ranker over the whole game, in order, at the turn cadence.
 *
 * EVERY turn from the start of the game is stepped even when only a window is sent to a model,
 * because `buildFacts` mutates a module-scoped memory: what may be said now depends on what was
 * said forty seconds ago, on how many gold lines have already been spent this game, and on which
 * deaths have already been announced. A replay that starts in the middle is a different coach.
 */
export const replay = (rows: readonly RawSample[], everySec: number, fromSec: number, turns: number): Turn[] => {
	const out: Turn[] = []
	let nextAt = 0
	let sent = 0
	for (const row of rows) {
		if (row.gameTime < nextAt) continue
		nextAt = row.gameTime + everySec
		const state = buildLiveStateForBench(row.data, row.gameTime)
		// A sample that cannot make a state — the loading screen, a torn line — is skipped, never faked.
		if (!state) continue
		const wanted = row.gameTime >= fromSec && sent < turns
		if (wanted) sent += 1
		out.push({
			atSec: row.gameTime,
			state,
			block: renderState(state),
			offered: state.unseen,
			roster: [
				state.me.champion,
				...state.allies.map(p => p.champion),
				...state.enemies.map(p => p.champion)
			].filter(c => c !== ""),
			aliases: state.pronounce.map(p => p.say),
			sent: wanted
		})
	}
	return out
}

/* ================================================================ the judge */

const geminiJudge = async (model: string): Promise<Judge> => {
	const keyPath = `${DATA_DIR}/gemini.key`
	if (!existsSync(keyPath)) throw new Error(`--judge needs a key at ${keyPath}`)
	const key = readFileSync(keyPath, "utf8").trim()
	const { createGoogleGenerativeAI } = await import("@ai-sdk/google")
	const { generateText } = await import("ai")
	const handle = createGoogleGenerativeAI({ apiKey: key })(model)
	return async (prompt: string) => {
		// Generous, because a tight cap TRUNCATES a reasoning model rather than shortening it, and
		// a truncated answer is reported as judge failure and quietly shrinks n.
		const r = await generateText({ model: handle, prompt, maxOutputTokens: 2048 })
		return r.text ?? ""
	}
}

/* ================================================================ formatting */

const pct = (i: Interval): string => `${(100 * i.p).toFixed(0)}%`
const ciOf = (i: Interval): string => `[${(100 * i.lo).toFixed(0)}, ${(100 * i.hi).toFixed(0)}]`
const pad = (s: string, w: number): string => (s.length >= w ? s : s + " ".repeat(w - s.length))
const padL = (s: string, w: number): string => (s.length >= w ? s : " ".repeat(w - s.length) + s)

/** Wrap a quoted sentence so a long line does not run off a terminal. */
const wrap = (text: string, width: number, indent: string): string => {
	const words = text.split(/\s+/)
	const rows: string[] = []
	let row = ""
	for (const w of words) {
		if (row === "") row = w
		else if (`${row} ${w}`.length <= width) row = `${row} ${w}`
		else {
			rows.push(row)
			row = w
		}
	}
	if (row !== "") rows.push(row)
	return rows.map((r, i) => (i === 0 ? r : indent + r)).join("\n")
}

const AXIS_MARK: Record<string, string> = { pass: "ok", fail: "FAIL", unmeasured: "--" }

/** One line, quoted, with the clock and every axis that has something to say about it. */
const printLine = (l: LineVerdict): void => {
	console.log(`  ${padL(l.clock, 6)}  "${wrap(l.text, 92, " ".repeat(11))}"`)
	const heads = AXES.filter(a => l.axes[a] !== "unmeasured")
	console.log(
		`          ${l.topic}/${l.screen}${l.rankTaken === null ? "" : l.rankTaken < 0 ? " · OFF-LIST" : ` · rank ${l.rankTaken + 1}`} · ` +
			heads.map(a => `${a} ${AXIS_MARK[l.axes[a]]}`).join(" · ")
	)
	for (const a of AXES) {
		if (l.axes[a] !== "fail") continue
		console.log(`          ${a}: ${l.notes[a]}`)
	}
}

const printReport = (
	v: TranscriptVerdict,
	meta: { game: string; provider: string; model: string; everySec: number; turnsSent: number; window: string; frame: boolean },
	all: boolean
): void => {
	const line = "─".repeat(96)
	console.log(`\n${line}`)
	console.log(
		`eval-useful · ${meta.game} · ${meta.provider}/${meta.model} · every ${meta.everySec}s · ${meta.turnsSent} turns over ${meta.window}${meta.frame ? " · with frame" : " · block only"}`
	)
	console.log(line)

	if (v.lines.length === 0) {
		console.log("\nThe coach said NOTHING on any turn. That is a result, not an error — but there is nothing to score.")
		return
	}

	const ordered = worstFirst(v.lines)
	console.log(`\nTHE WORST ${Math.min(5, ordered.length)} LINES\n`)
	for (const l of ordered.slice(0, 5)) printLine(l)

	const best = bestFirst(v.lines)
	console.log(`\nTHE BEST ${Math.min(5, best.length)} LINES\n`)
	for (const l of best.slice(0, 5)) printLine(l)

	if (all) {
		console.log("\nEVERY LINE, IN ORDER\n")
		for (const l of v.lines) printLine(l)
	}

	console.log("\nWHAT HE HEARD\n")
	console.log(
		`  ${v.spoken} lines in ${(v.spanSec / 60).toFixed(1)} minutes = ${v.linesPerMin.toFixed(2)}/min` +
			`   (the shipped design point after the readout gates is 0.40/min)`
	)
	console.log(`  spoke on ${v.spoken} of ${meta.turnsSent} turns; ${meta.turnsSent - v.spoken} silent`)
	console.log(
		`  subjects: ${v.topics.map(t => `${t.topic} ${t.n} (${(100 * t.share).toFixed(0)}%)`).join(" · ")}`
	)

	/*
	 * Said before the table, not after it. A reader who takes a percentage off a table of eight
	 * lines and quotes it has been misled by the layout, and small n has embarrassed this project
	 * before. Ten is where a Wilson interval on a mid-range rate first gets under about 60 points
	 * wide, which is the point at which it starts to be worth reading at all.
	 */
	if (v.spoken < 10)
		console.log(
			`\n  NOTE: only ${v.spoken} spoken lines. Every interval below is wide enough to cover almost any claim —\n` +
				"  read the sentences above, and do not compare two runs on numbers this thin."
		)

	console.log("\nTHE SIX AXES\n")
	console.log(`  ${pad("axis", 15)}${pad("pass", 9)}${pad("rate", 7)}${pad("95% CI", 12)}what a pass means`)
	for (const axis of AXES) {
		const r = v.rates[axis]
		const i = r.interval
		console.log(
			`  ${pad(axis, 15)}${pad(i.n === 0 ? "--" : `${i.k}/${i.n}`, 9)}${pad(i.n === 0 ? "" : pct(i), 7)}${pad(i.n === 0 ? "not measured" : ciOf(i), 12)}${r.meaning}`
		)
	}
	console.log(
		`\n  ${pad("on his HUD", 15)}${pad(`${v.hud.interval.k}/${v.hud.interval.n}`, 9)}${pad(v.hud.interval.n === 0 ? "" : pct(v.hud.interval), 7)}${pad(v.hud.interval.n === 0 ? "" : ciOf(v.hud.interval), 12)}${v.hud.meaning}`
	)
	console.log(
		`  ${pad("near-duplicate", 15)}${pad(`${v.nearDuplicate.interval.k}/${v.nearDuplicate.interval.n}`, 9)}${pad(pct(v.nearDuplicate.interval), 7)}${pad(ciOf(v.nearDuplicate.interval), 12)}${v.nearDuplicate.meaning}`
	)
	console.log(
		`  ${pad("vague order", 15)}${pad(`${v.vague.interval.k}/${v.vague.interval.n}`, 9)}${pad(pct(v.vague.interval), 7)}${pad(ciOf(v.vague.interval), 12)}${v.vague.meaning}`
	)

	console.log("\nPROBLEMS\n")
	if (v.problems.length === 0) console.log("  none — every threshold cleared")
	for (const p of v.problems) console.log(`  - ${p}`)
	console.log(`\nVERDICT: ${v.verdict.toUpperCase()}`)

	/*
	 * Stated every run, not tucked in a caveats file. `buildLiveStateForBench` passes no baseline,
	 * so the two CS-against-his-own-average rules cannot fire in ANY replay — and those rules were
	 * six of the nine lines that made him quit. A green farm-pace column here would be an artefact.
	 */
	console.log(
		"\nBLIND SPOT: a replay carries no rolling baseline, so `pace` is null and the two farm-versus-his-own-average\n" +
			"rules cannot fire here at all. They were most of the transcript he quit on. This run says nothing about them."
	)
}

const printComparison = (a: TranscriptVerdict, b: TranscriptVerdict, aName: string, bName: string): void => {
	console.log(`\nCOMPARISON  A = ${aName}   B = ${bName}\n`)
	console.log(`  ${pad("axis", 15)}${pad("A", 16)}${pad("B", 16)}verdict`)
	for (const c of compareRuns(a, b)) {
		const fa = c.a.n === 0 ? "--" : `${c.a.k}/${c.a.n} ${pct(c.a)}`
		const fb = c.b.n === 0 ? "--" : `${c.b.k}/${c.b.n} ${pct(c.b)}`
		console.log(`  ${pad(c.axis, 15)}${pad(fa, 16)}${pad(fb, 16)}${c.verdict}`)
	}
	console.log(
		`\n  lines/min  A ${a.linesPerMin.toFixed(2)}   B ${b.linesPerMin.toFixed(2)}` +
			`     top subject  A ${a.topics[0]?.topic ?? "-"} ${(100 * (a.topics[0]?.share ?? 0)).toFixed(0)}%   B ${b.topics[0]?.topic ?? "-"} ${(100 * (b.topics[0]?.share ?? 0)).toFixed(0)}%`
	)
}

/* ===================================================================== main */

const main = async (): Promise<void> => {
	const game = arg("game", "split-03")
	const everySec = Number(arg("every", "20"))
	const turns = Number(arg("turns", "30"))
	const fromSec = Number(arg("from", "0"))
	const provider = arg("provider", "gemini-http") as ProviderId
	const model = arg("model", "")
	/*
	 * OFF by default, and that is a measurement decision rather than laziness. The journal frames
	 * on disk belong to specific instants; sending one taken at a different moment would put a
	 * picture of a different situation in front of the model, which is a different experiment with
	 * a worse name. Pass `--frame` deliberately, or run the vision question through the probe that
	 * owns it.
	 */
	const framePath = arg("frame", "")
	const judgeModel = has("judge") ? arg("judge", "gemini-3.6-flash") : ""
	const comparePath = arg("compare", "")

	const p = providerById(provider)
	if (!p) throw new Error(`no provider called ${provider}`)

	const { readSamples, sampledGames } = await import("../src/daemon/live-sampler.ts")
	const id = game === "latest" ? (sampledGames()[0]?.gameId ?? "") : game
	if (id === "") throw new Error("no live samples on disk — play a game with the daemon running")
	const rows = readSamples(id) as RawSample[]
	if (rows.length === 0)
		throw new Error(`no samples for ${id} in ${DATA_DIR}/live-samples (have: ${sampledGames().map(g => g.gameId).join(", ")})`)

	/* -- the state stream, for the staleness check ------------------------------ */
	const states: CoachState[] = []
	for (const row of rows) {
		const s = coachStateFrom(row)
		if (s) states.push(s)
	}

	/* -- the shipped ranker, stepped over the whole game ------------------------ */
	const all = replay(rows, everySec, fromSec, turns)
	const toSend = all.filter(t => t.sent)
	if (toSend.length === 0) throw new Error(`no turns to send (game is ${rows.length} samples, --from ${fromSec})`)

	const frame =
		framePath === "" ? undefined : readFileSync(framePath).toString("base64")

	console.log(
		`${id}: ${rows.length} samples, ${all.length} turns at ${everySec}s, sending ${toSend.length} ` +
			`(${clockOf(toSend[0]!.atSec)}–${clockOf(toSend[toSend.length - 1]!.atSec)}) to ${provider}${model === "" ? "" : `/${model}`}`
	)

	/* -- the real provider ------------------------------------------------------ */
	const inputs: UsefulInput[] = []
	const records: Record<string, unknown>[] = []
	let failures = 0
	for (const [n, t] of toSend.entries()) {
		const r = await coachTurn({
			provider,
			...(model === "" ? {} : { model }),
			...(frame === undefined ? {} : { frameJpegBase64: frame }),
			blockText: t.block
		})
		if (!r.ok) {
			failures += 1
			console.error(`  ! ${clockOf(t.atSec)} ${r.reason ?? "provider failed"}`)
		}
		const latencySec = r.latencyMs / 1000
		const input: UsefulInput = {
			text: r.text,
			atSec: t.atSec,
			latencySec,
			offered: t.offered,
			block: t.block,
			roster: t.roster,
			me: t.state.me.champion,
			champions: t.roster,
			aliases: t.aliases,
			stateAtT: stateAt(states, t.atSec, 6),
			stateAtEnd: null
		}
		inputs.push(input)
		records.push({
			atSec: t.atSec,
			clock: clockOf(t.atSec),
			ok: r.ok,
			reason: r.reason ?? null,
			text: r.text,
			latencyMs: r.latencyMs,
			model: r.model,
			frameSent: r.frameSent,
			offered: t.offered,
			block: t.block
		})
		process.stdout.write(
			`\r  ${n + 1}/${toSend.length}  ${clockOf(t.atSec)}  ${r.text === "" ? "(nothing)" : r.text.slice(0, 60)}`.padEnd(100)
		)
	}
	process.stdout.write("\n")

	/*
	 * The end-state is filled in only now, because it depends on how long the sentence took to say,
	 * which depends on the sentence. `stateAt` returns null past its tolerance and the axis then
	 * reports `unknown` and is EXCLUDED from the denominator rather than counted fresh.
	 */
	const withEnds: UsefulInput[] = inputs.map(i => {
		const endSec = i.atSec + i.latencySec + speechDurationSec(i.text)
		return { ...i, stateAtEnd: stateAt(states, endSec, 6) }
	})

	/* -- the optional forced-choice arm ------------------------------------------ */
	let judgeSummary: unknown = null
	const identified = new Map<number, boolean>()
	if (judgeModel !== "") {
		const cards: StateCard[] = all.map(t => ({
			id: `${id}@${t.atSec}`,
			game: id,
			tSec: t.atSec,
			block: t.block,
			hasFacts: t.offered.length > 0
		}))
		const spoken = withEnds
			.map((i, idx) => ({ i, idx }))
			.filter(({ i }) => i.text.replace(/[^A-Za-z]/g, "").toLowerCase() !== "" && i.text.replace(/[^A-Za-z]/g, "").toLowerCase() !== "pass")
		const lines: LineUnderTest[] = spoken.map(({ i, idx }) => ({
			id: String(idx),
			text: i.text,
			stateId: `${id}@${i.atSec}`,
			tag: "run"
		}))
		/*
		 * BOTH masks, and only the verbatim one feeds the axis.
		 *
		 * The axis asks what he actually heard, digits included, so `none` is the arm that answers
		 * it. `digits` is run alongside because the two together are the finding: measured on the
		 * transcript he quit on, nine lines were identifiable 9/9 verbatim and 4/9 with the numbers
		 * masked, against an empirical null of 30% — i.e. the sentences carried no specificity of
		 * their own and the digits were doing all of the work. A report that showed only one of
		 * those numbers would be misleading whichever one it picked.
		 */
		const built = buildTrials({
			lines,
			cards,
			pool: "within-game",
			masks: ["none", "digits"],
			championNames: toSend[0]?.roster ?? [],
			seed: `useful:${id}`
		})
		if (built.skipped.length > 0)
			console.error(`  judge: ${built.skipped.length} lines had no plausible decoys and were REFUSED, not given easy ones`)
		const judge = await geminiJudge(judgeModel)
		const judgements = await runTrials(built.trials, judge)
		for (const j of judgements)
			if (j.choice !== null && j.trial.mask === "none")
				identified.set(Number(j.trial.lineId), j.correct)
		judgeSummary = {
			model: judgeModel,
			cells: summarize(judgements),
			positionBias: positionBias(judgements),
			skipped: built.skipped
		}
		console.log(
			`  judge ${judgeModel}: ` +
				summarize(judgements)
					.map(
						c =>
							`${c.mask} ${c.hits}/${c.n} (chance ${(100 * c.chance).toFixed(0)}%${c.aboveChance ? ", above chance" : ", NOT above chance"})`
					)
					.join("  ")
		)
	}

	const scored = withEnds.map((i, idx) =>
		identified.has(idx) ? { ...i, identified: identified.get(idx)! } : i
	)

	/* -- score, print, keep ------------------------------------------------------- */
	const verdict = scoreTranscript(scored)
	printReport(
		verdict,
		{
			game: id,
			provider,
			model: records[0]?.model as string ?? model,
			everySec,
			turnsSent: toSend.length,
			window: `${clockOf(toSend[0]!.atSec)}–${clockOf(toSend[toSend.length - 1]!.atSec)}`,
			frame: frame !== undefined
		},
		has("lines")
	)
	if (failures > 0) console.log(`\n  ${failures} of ${toSend.length} provider calls FAILED and are scored as silence.`)

	if (comparePath !== "") {
		const prev = JSON.parse(readFileSync(comparePath, "utf8")) as { inputs: UsefulInput[] }
		printComparison(scoreTranscript(prev.inputs), verdict, comparePath, "this run")
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
	const out = arg("out", `${DATA_DIR}/eval/useful-${stamp}.json`)
	mkdirSync(`${DATA_DIR}/eval`, { recursive: true })
	if (existsSync(out)) throw new Error(`${out} already exists — every measurement is kept, nothing is overwritten`)
	writeFileSync(
		out,
		JSON.stringify(
			{
				ranAt: new Date().toISOString(),
				argv,
				game: id,
				provider,
				model: records[0]?.model ?? model,
				everySec,
				fromSec,
				turnsSent: toSend.length,
				frame: framePath === "" ? null : framePath,
				samples: rows.length,
				failures,
				/*
				 * Everything needed to re-score without paying the model again — INCLUDING the two
				 * client states, because a run saved without them can never have its timeliness
				 * axis re-checked and `--compare` would silently report it as "not measured".
				 */
				inputs: scored,
				records,
				judge: judgeSummary,
				thresholds: verdict.thresholds,
				verdict: verdict.verdict,
				problems: verdict.problems,
				linesPerMin: verdict.linesPerMin,
				spanSec: verdict.spanSec,
				topics: verdict.topics,
				rates: Object.fromEntries(AXES.map(a => [a, verdict.rates[a].interval])),
				hud: verdict.hud.interval,
				nearDuplicate: verdict.nearDuplicate.interval,
				vague: verdict.vague.interval,
				lines: verdict.lines.map(l => ({ ...l, staleness: l.staleness }))
			},
			null,
			"\t"
		)
	)
	console.log(`\nwrote ${out}`)
}

if (import.meta.main) await main()
