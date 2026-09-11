/**
 * How many times would the coach have been asked?
 *
 * Replays the raw `allgamedata` samples the daemon recorded during a real game through
 * `analysis/live-events.ts` and counts the turns it would have produced, against the turns the
 * fixed timer produces over the same wall clock. The point of the event-driven coach is that there
 * are not 85 things worth saying in a game of League, and this is where that claim is checked
 * rather than asserted.
 *
 * The samples are the SUPERVISOR's poll, every five seconds of game clock, not the browser's — a
 * game played with the page closed is the one a measurement most wants. Replaying at 5s slightly
 * understates the resource-threshold events (a health bar can cross and recover inside one sample)
 * and slightly overstates detection latency against the browser's own faster tick; it does not move
 * the event counts, which come from a cumulative event log and from state that persists.
 *
 * `--graded` answers the other question, and it is the one the second cut was made on: of the 23
 * turns that were actually run through the socket and read line by line, which ones would still be
 * asked? A cut that removes volume is easy; a cut that removes the turns that produced useless
 * lines while keeping the ones that produced useful ones is the only thing worth shipping, and this
 * is where that is checked rather than asserted.
 *
 *   node --experimental-strip-types scripts/bench-events.ts [--file <ndjson>] [--heartbeat 180]
 *   node --experimental-strip-types scripts/bench-events.ts --graded
 *   node --experimental-strip-types scripts/bench-events.ts --base     # the pre-fourth-cut schedule
 */

import { createReadStream } from "node:fs"
import { readdirSync } from "node:fs"
import { createInterface } from "node:readline"
import { join } from "node:path"
import {
	commitTurn,
	dueTurn,
	newEventWatch,
	observeTick,
	projectTick,
	HEARTBEAT_SEC,
	type LiveEventKind
} from "../src/analysis/live-events.ts"

const SAMPLES = "data/live-samples"

const argOf = (flag: string): string | null => {
	const i = process.argv.indexOf(flag)
	return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null
}

const files =
	argOf("--file") !== null ?
		[argOf("--file")!]
	:	readdirSync(SAMPLES)
			.filter(f => f.endsWith(".ndjson"))
			.map(f => join(SAMPLES, f))

const heartbeatSec = Number(argOf("--heartbeat") ?? HEARTBEAT_SEC)

/**
 * `--base` replays the schedule as it stood BEFORE the fourth cut, so the trade it makes can be
 * re-derived from these samples rather than read out of a note.
 *
 * Two instrument knobs, both declared for exactly this: `settleSec: 0` removes the settle and the
 * heartbeat's yield, and `standingSilenceSec: Infinity` removes the standing-opportunity ask.
 * Nothing else differs, so a diff of the two turn lists is the whole change.
 */
const base = process.argv.includes("--base")
const watchOpts = base ? { standingSilenceSec: Infinity } : {}
const turnOpts = base ? { settleSec: 0 } : {}

/**
 * THE GRADED RUN, transcribed — one row per turn that was actually spoken.
 *
 * These are the 23 turns of `data/eval/stream-kayn-events-20260910.json`: a stride-3 subsample of
 * the 67 the detector raised over game 5639406342, sent through the real Gemini Live socket. The
 * clocks and the causes are read out of that file. The VERDICTS are not in it — they are the
 * hand reading of the 23 lines that the second cut was made on, five useful, twelve true and
 * useless, six false, and they are written here rather than recomputed because a judgement of
 * whether a line was worth hearing is not something this repo can or should derive.
 *
 * The run file is the evidence and it is never rewritten. If the grading is ever redone, add rows;
 * do not edit these.
 */
const GRADED: Array<{ clock: string; atSec: number; asked: string; verdict: "useful" | "useless" | "false" }> = [
	{ clock: "0:00", atSec: 0.04, asked: "game.start", verdict: "useless" },
	{ clock: "2:06", atSec: 126.9, asked: "level.spike", verdict: "false" },
	{ clock: "3:44", atSec: 224.2, asked: "fight.resolved", verdict: "useless" },
	{ clock: "6:46", atSec: 406, asked: "level.spike", verdict: "false" },
	{ clock: "7:47", atSec: 467, asked: "counterpart.seen", verdict: "false" },
	{ clock: "8:18", atSec: 498, asked: "respawn.self", verdict: "useful" },
	{ clock: "9:25", atSec: 565, asked: "resource.low", verdict: "useless" },
	{ clock: "10:32", atSec: 632, asked: "fight.resolved", verdict: "useless" },
	{ clock: "11:57", atSec: 717, asked: "resource.low", verdict: "useless" },
	{ clock: "12:58", atSec: 778, asked: "resource.low", verdict: "useless" },
	{ clock: "13:16", atSec: 796, asked: "objective.window", verdict: "useless" },
	{ clock: "14:41", atSec: 881, asked: "fight.resolved", verdict: "useless" },
	{ clock: "15:54", atSec: 954, asked: "fight.resolved", verdict: "false" },
	{ clock: "17:38", atSec: 1058, asked: "fight.resolved", verdict: "useful" },
	{ clock: "18:08", atSec: 1088, asked: "counterpart.unseen", verdict: "useful" },
	{ clock: "19:16", atSec: 1156, asked: "fight.resolved+objective.window", verdict: "useless" },
	{ clock: "20:53", atSec: 1253, asked: "death.counterpart", verdict: "useful" },
	{ clock: "23:01", atSec: 1381, asked: "heartbeat", verdict: "false" },
	{ clock: "24:20", atSec: 1460, asked: "resource.low", verdict: "useless" },
	{ clock: "24:51", atSec: 1491, asked: "fight.resolved", verdict: "useless" },
	{ clock: "25:39", atSec: 1539, asked: "death.counterpart", verdict: "useless" },
	{ clock: "26:22", atSec: 1582, asked: "objective.taken+item.completed", verdict: "useful" },
	{ clock: "28:12", atSec: 1692, asked: "death.counterpart+respawn.self", verdict: "false" }
]

/** The samples the graded run replayed. `--graded` is about this one game and no other. */
const GRADED_FILE = join(SAMPLES, "js-mtvxb5f4-f81a-t29817812.ndjson")

/** Every turn today's detector raises over one sample file, in order. */
const replay = async (
	file: string,
	hb: number
): Promise<Array<{ atSec: number; why: string; heartbeat: boolean }>> => {
	const watch = newEventWatch()
	const out: Array<{ atSec: number; why: string; heartbeat: boolean }> = []
	const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
	for await (const line of rl) {
		if (line.trim() === "") continue
		let parsed: { data?: unknown }
		try {
			parsed = JSON.parse(line) as { data?: unknown }
		} catch {
			continue
		}
		const tick = projectTick(parsed.data as never)
		if (!tick) continue
		watch.pending.push(...observeTick(watch, tick, watchOpts))
		const reason = dueTurn(watch, tick.gameTimeSec, { heartbeatSec: hb, ...turnOpts })
		if (!reason) continue
		commitTurn(watch, reason, tick.gameTimeSec)
		out.push({
			atSec: tick.gameTimeSec,
			why: reason.heartbeat ? "heartbeat" : reason.events.map(e => e.kind).join("+"),
			heartbeat: reason.heartbeat
		})
	}
	return out
}

if (process.argv.includes("--graded")) {
	const turns = await replay(GRADED_FILE, heartbeatSec)
	/*
	 * A graded turn SURVIVES only when a turn still fires at the same game clock. 1.5s, not "the
	 * nearest turn": the detector raises turns 30-90 seconds apart and a loose match would score a
	 * neighbouring question as the same one — which it is not, because it is asked about a different
	 * thing at a different moment and the line that comes back is a different line.
	 */
	const tally: Record<string, [number, number]> = { useful: [0, 0], useless: [0, 0], false: [0, 0] }
	for (const g of GRADED) {
		const hit = turns.find(t => Math.abs(t.atSec - g.atSec) <= 1.5)
		tally[g.verdict]![hit ? 0 : 1] += 1
		console.log(
			`${g.clock.padStart(5)}  ${g.verdict.padEnd(7)} ${g.asked.padEnd(32)} -> ${
				hit ? `still asked, as ${hit.why}` : "no longer fires"
			}`
		)
	}
	console.log("")
	for (const [k, [kept, gone]] of Object.entries(tally))
		console.log(`  ${k.padEnd(8)} ${kept} still asked, ${gone} no longer fire`)
	console.log(`
  ${turns.length} turns over the whole game (the graded schedule raised 67)`)
	process.exit(0)
}

/** The two fixed beats this replaces: the shipped default, and the one `trusted` forces. */
const TIMERS = [20, 6]

for (const file of files) {
	const watch = newEventWatch()
	const kinds = new Map<LiveEventKind, number>()
	let turns = 0
	let heartbeats = 0
	let samples = 0
	let first: number | null = null
	let last = 0
	/** Gaps between consecutive turns, for the heartbeat's own justification. */
	const gaps: number[] = []
	let lastTurnAt: number | null = null
	/** Gaps between EVENT-driven turns only — what the heartbeat has to sit above. */
	const eventGaps: number[] = []
	let lastEventTurnAt: number | null = null

	const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
	for await (const line of rl) {
		if (line.trim() === "") continue
		let parsed: { gameTime?: number; data?: unknown }
		try {
			parsed = JSON.parse(line) as { gameTime?: number; data?: unknown }
		} catch {
			continue
		}
		const tick = projectTick(parsed.data as never)
		if (!tick) continue
		samples += 1
		if (first === null) first = tick.gameTimeSec
		last = tick.gameTimeSec
		const fired = observeTick(watch, tick, watchOpts)
		watch.pending.push(...fired)
		const reason = dueTurn(watch, tick.gameTimeSec, { heartbeatSec, ...turnOpts })
		if (!reason) continue
		// `dueTurn` peeks; a replay always "sends", so it commits every turn. See `commitTurn`.
		commitTurn(watch, reason, tick.gameTimeSec)
		turns += 1
		if (reason.heartbeat) heartbeats += 1
		else {
			if (lastEventTurnAt !== null) eventGaps.push(tick.gameTimeSec - lastEventTurnAt)
			lastEventTurnAt = tick.gameTimeSec
		}
		for (const e of reason.events) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1)
		if (lastTurnAt !== null) gaps.push(tick.gameTimeSec - lastTurnAt)
		lastTurnAt = tick.gameTimeSec
	}

	if (samples === 0) continue
	const span = last - (first ?? 0)
	const pct = (xs: number[], p: number): number =>
		xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!
	console.log(`\n${file}`)
	console.log(
		`  ${samples} samples spanning ${Math.round(span)}s (${(span / 60).toFixed(1)} min)`
	)
	for (const t of TIMERS)
		console.log(`  fixed ${t}s timer:      ${Math.round(span / t)} turns`)
	console.log(
		`  events (hb ${heartbeatSec}s):  ${turns} turns  (${turns - heartbeats} on events, ${heartbeats} heartbeat)`
	)
	console.log(
		`  turn gaps: median ${Math.round(pct(gaps, 0.5))}s  p90 ${Math.round(pct(gaps, 0.9))}s  max ${Math.round(Math.max(0, ...gaps))}s`
	)
	console.log(
		`  event-turn gaps: median ${Math.round(pct(eventGaps, 0.5))}s  p90 ${Math.round(pct(eventGaps, 0.9))}s  max ${Math.round(Math.max(0, ...eventGaps))}s`
	)
	const rows = [...kinds.entries()].sort((a, b) => b[1] - a[1])
	console.log(`  ${rows.map(([k, n]) => `${k}=${n}`).join(" ")}`)
}
