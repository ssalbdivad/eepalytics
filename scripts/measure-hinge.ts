/**
 * THE TEN-TO-FIFTEEN WINDOW: what precedes a death there that this feed can see, and what an ask
 * inside it costs.
 *
 * `scripts/what-wins.ts` found that **nothing he personally does before 10:00 separates his wins
 * from his losses**, and that the first thing of his that does is a death between 10:00 and 15:00 —
 * 70% [56-80] over 53 clean games against 38% [28-48] over 85, the only personal metric at any
 * checkpoint that survives the team-gold control (OR 0.63 per SD [0.43-0.93], p 0.018). That put
 * one question to the schedule, and this script is the whole of the answer to it:
 *
 *   1. **Is there a death precursor in the live feed?** Four shapes were proposed — he is low and
 *      the counterpart is unaccounted for, he is deep with no vision, two enemies are unlocated
 *      while he is in their half, his escape is on cooldown. Three of those are not computable at
 *      all and the fourth is measured backwards. `--precursors` prints the table.
 *   2. **What does the window actually get today, and what would one more ask cost?**
 *      `--coverage` and `--trade` replay the real detector — `observeTick` / `dueTurn` /
 *      `commitTurn`, the same three calls the browser makes — over the 28-game corpus at every
 *      speak level, with the hinge ask on and off, and diff the turn CLOCKS rather than the counts,
 *      because a count hides a swap.
 *
 * ## What it refuses to do
 *
 * It consults no model and grades no line. A turn the corpus's stored runs never took has no line
 * to judge, and every one of the hinge asks measured here is at an instant no stored run took, so
 * nothing in this file says whether the added question produces a good sentence. That is stated in
 * the output rather than estimated, exactly as `scripts/measure-asks.ts` states its `new instants`.
 *
 * It also makes no causal claim. Nothing here says a line at 12:30 prevents a death. The finding it
 * acts on is observational on one player and the intervention is an ALLOCATION of attention: if the
 * coach is asked about eight times in a game and one five-minute stretch is the only stretch whose
 * outcome survives the scoreboard control, that stretch should not be able to pass in silence.
 *
 *   node --experimental-strip-types scripts/measure-hinge.ts [--precursors] [--coverage] [--trade]
 *                                                            [--corpus <file>] [--out <file>]
 *
 * With no flag it runs all three.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { wilson } from "../src/analysis/coach-score.ts"
import {
	askPolicy,
	commitTurn,
	contestableObjective,
	counterpartOf,
	dueTurn,
	HINGE_FROM_SEC,
	HINGE_SILENCE_SEC,
	HINGE_TO_SEC,
	newEventWatch,
	observeTick,
	projectTick,
	SPEAK_LEVELS,
	type LiveTick,
	type SpeakLevel
} from "../src/analysis/live-events.ts"
import type { LiveAllGameData } from "../src/shared/schema/live.ts"

const arg = (flag: string, fallback: string): string => {
	const i = process.argv.indexOf(flag)
	return i < 0 ? fallback : (process.argv[i + 1] ?? fallback)
}

const CORPUS = arg("--corpus", "data/eval/integrate3-corpus-20260912.json")
const OUT = arg("--out", "")
/** The gate under test. Defaults to what ships, so a bare run describes the coach he has. */
const GATE = Number(arg("--gate", String(HINGE_SILENCE_SEC)))
const only = ["--precursors", "--coverage", "--trade"].filter(f => process.argv.includes(f))
const wants = (what: string): boolean => only.length === 0 || only.includes(`--${what}`)

/** How far ahead of a tick a death still counts as the thing that tick preceded. */
const HORIZON_SEC = 25
/** How far back the health bar is compared, to tell "low" from "being killed right now". */
const BAR_WINDOW_SEC = 12
/** A drop of this much of his bar inside `BAR_WINDOW_SEC` means the fight is already happening. */
const BAR_FALLING = 0.1

const corpus = JSON.parse(readFileSync(CORPUS, "utf8")) as {
	windows: { id: string; sampleFile: string; champion: string; counterpart: string | null }[]
}

/**
 * The ndjson reader. Deliberately NOT `scripts/lib/stream.ts`'s `readVerbatim`: that one opens the
 * SQLite journal to pair frames and this script needs none of it, so a machine with no database can
 * still re-derive every number below from the sample files alone.
 */
const samplesOf = (file: string): unknown[] => {
	const out: unknown[] = []
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim() === "") continue
		try {
			out.push((JSON.parse(line) as { data?: unknown }).data)
		} catch {
			/* a torn tail line from a killed daemon. Skipped and not faked. */
		}
	}
	return out
}

const ticksOf = (file: string): LiveTick[] => {
	const out: LiveTick[] = []
	for (const data of samplesOf(file)) {
		const tick = projectTick(data as LiveAllGameData)
		if (tick !== null) out.push(tick)
	}
	return out
}

const pct = (k: number, n: number): string => {
	if (n === 0) return "     —"
	const ci = wilson(k, n)
	return `${((100 * k) / n).toFixed(0)}% [${(100 * ci.lo).toFixed(0)}-${(100 * ci.hi).toFixed(0)}]`
}

/** Rounds the SECONDS before splitting, so 779.6 prints 13:00 rather than 12:60. */
const clock = (sec: number): string => {
	const s = Math.round(sec)
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

const report: Record<string, unknown> = { ranAt: new Date().toISOString(), corpus: CORPUS }

/* ============================================================ 1. the precursors */

/**
 * One alive tick inside the hinge window, as much of it as the feed honestly knows.
 *
 * Everything here comes off `allgamedata` and nothing is inferred from a position, because there
 * are no positions: `allPlayers` carries no coordinates for anyone, ally or enemy. That is why
 * three of the four proposed precursors have no row in the table below rather than a null one.
 */
interface Obs {
	game: string
	atSec: number
	/** His own bar. The one resource the feed states exactly, and the one thing he cannot miss. */
	hpFrac: number
	/** How much of it he has lost in the last `BAR_WINDOW_SEC` — "low" against "being killed". */
	hpFall: number
	/** How long he has been continuously under 40%, which is the ACTIONABLE reading of low. */
	lowForSec: number
	manaFrac: number
	/** Seconds since anything about the counterpart's row moved. See `TickPlayer.seenCs`. */
	cpStaleSec: number
	cpDead: boolean
	enemiesDown: number
	windowOpen: boolean
	/** Seconds until his next death, or null when he does not die again this game. */
	deadInSec: number | null
}

const observe = (): { rows: Obs[]; deaths: Map<string, number[]> } => {
	const rows: Obs[] = []
	const deaths = new Map<string, number[]>()
	for (const w of corpus.windows) {
		const ticks = ticksOf(w.sampleFile)
		const mine: number[] = []
		for (let i = 1; i < ticks.length; i += 1)
			if (ticks[i]!.me.deaths > ticks[i - 1]!.me.deaths) mine.push(ticks[i]!.gameTimeSec)
		deaths.set(w.id, mine)
		let cpSeenAt: number | null = null
		let lowSince: number | null = null
		const bar: { t: number; f: number }[] = []
		let prev: LiveTick | null = null
		for (const tick of ticks) {
			const now = tick.gameTimeSec
			const cp = counterpartOf(tick)
			const cpPrev = prev === null ? null : counterpartOf(prev)
			if (cp !== null) {
				/* The same eight fields `observeTick` watches, so "stale" means here what it means there. */
				const moved =
					cpPrev === null ||
					cp.level !== cpPrev.level ||
					cp.seenCs !== cpPrev.seenCs ||
					cp.itemCount !== cpPrev.itemCount ||
					cp.dead !== cpPrev.dead ||
					cp.kills !== cpPrev.kills ||
					cp.deaths !== cpPrev.deaths ||
					cp.assists !== cpPrev.assists
				if (moved || cpSeenAt === null) cpSeenAt = now
			}
			const hpFrac = tick.me.maxHp > 0 ? tick.me.hp / tick.me.maxHp : 1
			bar.push({ t: now, f: hpFrac })
			while (bar.length > 1 && now - bar[0]!.t > BAR_WINDOW_SEC) bar.shift()
			if (tick.me.dead) {
				lowSince = null
				prev = tick
				continue
			}
			lowSince = hpFrac < 0.4 ? (lowSince ?? now) : null
			rows.push({
				game: w.id,
				atSec: now,
				hpFrac,
				hpFall: bar[0]!.f - hpFrac,
				lowForSec: lowSince === null ? 0 : now - lowSince,
				manaFrac:
					tick.me.manaType === "MANA" && tick.me.maxMana > 0 ?
						tick.me.mana / tick.me.maxMana
					:	1,
				cpStaleSec: cpSeenAt === null ? 0 : now - cpSeenAt,
				cpDead: cp?.dead === true,
				enemiesDown: tick.players.filter(p => p.team !== tick.me.team && p.dead).length,
				windowOpen: contestableObjective(tick) !== null,
				deadInSec: mine.find(d => d > now) === undefined ? null : mine.find(d => d > now)! - now
			})
			prev = tick
		}
	}
	return { rows, deaths }
}

const precursors = (rows: Obs[], deaths: Map<string, number[]>): void => {
	const inWindow = rows.filter(r => r.atSec >= HINGE_FROM_SEC && r.atSec < HINGE_TO_SEC)
	const died = (r: Obs): boolean => r.deadInSec !== null && r.deadInSec <= HORIZON_SEC
	const inWindowDeaths = [...deaths].flatMap(([g, ds]) =>
		ds.filter(d => d >= HINGE_FROM_SEC && d < HINGE_TO_SEC).map(d => `${g}:${Math.round(d)}`)
	)
	const base = inWindow.filter(died).length / inWindow.length

	console.log(
		`\nPRECURSORS — ${inWindow.length} alive ticks inside ${clock(HINGE_FROM_SEC)}-${clock(
			HINGE_TO_SEC
		)} over ${corpus.windows.length} games, ${inWindowDeaths.length} of his deaths in the window,` +
			` base hazard(${HORIZON_SEC}s) ${(100 * base).toFixed(1)}%`
	)
	console.log(
		`${"predicate at a tick".padEnd(42)}${"ticks".padStart(6)}${"hazard".padStart(15)}${"else".padStart(8)}${"fires/game".padStart(11)}${"deaths caught".padStart(15)}`
	)

	const table: Record<string, unknown>[] = []
	const row = (label: string, pred: (r: Obs) => boolean): void => {
		const yes = inWindow.filter(pred)
		const no = inWindow.filter(r => !pred(r))
		const ky = yes.filter(died).length
		/* Dedupe to one fire per `HORIZON_SEC`, so a predicate true for a minute is not sixty fires. */
		let fires = 0
		const caught = new Set<string>()
		for (const w of corpus.windows) {
			let last = -Infinity
			for (const r of yes.filter(r => r.game === w.id))
				if (r.atSec - last >= HORIZON_SEC * 2) {
					fires += 1
					last = r.atSec
					for (const d of deaths.get(w.id) ?? [])
						if (d >= r.atSec && d - r.atSec <= HORIZON_SEC && d >= HINGE_FROM_SEC && d < HINGE_TO_SEC)
							caught.add(`${w.id}:${Math.round(d)}`)
				}
		}
		console.log(
			`${label.padEnd(42)}${String(yes.length).padStart(6)}${pct(ky, yes.length).padStart(15)}${(
				(100 * no.filter(died).length) /
				(no.length || 1)
			)
				.toFixed(1)
				.padStart(7)}%${(fires / corpus.windows.length).toFixed(2).padStart(11)}${`${caught.size} of ${inWindowDeaths.length}`.padStart(15)}`
		)
		table.push({
			predicate: label,
			ticks: yes.length,
			hazard: ky / (yes.length || 1),
			hazardCI: wilson(ky, yes.length),
			elseHazard: no.filter(died).length / (no.length || 1),
			firesPerGame: fires / corpus.windows.length,
			deathsCaught: caught.size,
			deathsInWindow: inWindowDeaths.length
		})
	}

	row("his HP under 40%", r => r.hpFrac < 0.4)
	row("  ... and his bar is FALLING", r => r.hpFrac < 0.4 && r.hpFall >= BAR_FALLING)
	row("  ... and his bar is STEADY", r => r.hpFrac < 0.4 && r.hpFall < BAR_FALLING)
	row("  ... and low for 10s or more", r => r.hpFrac < 0.4 && r.lowForSec >= 10)
	row("his mana under 20%", r => r.manaFrac < 0.2)
	row("counterpart's row stale 45s+", r => r.cpStaleSec >= 45)
	row("counterpart's row stale 75s+", r => r.cpStaleSec >= 75)
	row("low and counterpart unaccounted", r => r.hpFrac < 0.4 && r.cpStaleSec >= 45 && !r.cpDead)
	row("four or more enemies up", r => r.enemiesDown <= 1)
	row("all five enemies up", r => r.enemiesDown === 0)
	row("window open and four enemies up", r => r.windowOpen && r.enemiesDown <= 1)

	/*
	 * THE BASE-RATE CHECK THAT REFUTES THE PROPOSED CONJUNCTION.
	 *
	 * `data/eval/CLIMB-COACH-20260918.md` proposed `window.contested` on the post-game finding that
	 * 87% of his 125 deaths in this window happen with four or five enemies not on a respawn clock.
	 * A share of deaths is only a signal beside the share of everything else.
	 */
	const near = inWindow.filter(r => r.deadInSec !== null && r.deadInSec <= 10)
	const upNear = near.filter(r => r.enemiesDown <= 1).length
	const upAll = inWindow.filter(r => r.enemiesDown <= 1).length
	console.log(
		`\n  four-or-more-enemies-up is a BASE RATE: ${pct(upNear, near.length)} of the ${near.length} ticks` +
			` within 10s of a death, against ${pct(upAll, inWindow.length)} of all ${inWindow.length} window ticks.`
	)
	console.log(
		"  NOT COMPUTABLE from this feed, and therefore absent from the table rather than null in it:" +
			"\n    his position, and so anything about being deep or in their half — `allPlayers` carries no coordinates" +
			"\n    where any enemy is — same field, same absence" +
			"\n    his summoner cooldowns — the feed carries spell NAMES and no timers"
	)
	report.precursors = {
		windowTicks: inWindow.length,
		deathsInWindow: inWindowDeaths.length,
		baseHazard: base,
		horizonSec: HORIZON_SEC,
		table,
		baseRateCheck: {
			nearDeathTicks: near.length,
			nearDeathFourUp: upNear,
			allWindowFourUp: upAll
		}
	}
}

/* ============================================================ 2 and 3. the schedule */

interface Turn {
	atSec: number
	kinds: string[]
}

const replay = (
	file: string,
	level: SpeakLevel,
	hingeOff: boolean
): { turns: Turn[]; lastSampleSec: number } => {
	const watch = newEventWatch()
	const turns: Turn[] = []
	let lastSampleSec = 0
	for (const tick of ticksOf(file)) {
		lastSampleSec = tick.gameTimeSec
		watch.pending.push(
			...observeTick(watch, tick, {
				level,
				hingeSilenceSec: hingeOff ? Infinity : GATE
			})
		)
		const reason = dueTurn(watch, tick.gameTimeSec, {
			level,
			heartbeatSec: askPolicy(level).heartbeatSec
		})
		if (reason === null) continue
		commitTurn(watch, reason, tick.gameTimeSec)
		turns.push({
			atSec: tick.gameTimeSec,
			kinds:
				reason.heartbeat ? ["heartbeat"] : reason.events.filter(e => e.asks).map(e => e.kind)
		})
	}
	/*
	 * THE GAME'S LENGTH IS THE LAST SAMPLE, never the last TURN. A quiet level can stop asking four
	 * minutes before the nexus falls, and dividing by the last turn's clock would then report a
	 * shorter game and a higher rate — which is how a per-28-minute figure comes out 9.2 where the
	 * stored measurement of the same schedule says 8.5.
	 */
	return { turns, lastSampleSec }
}

const LEVELS: SpeakLevel[] = ["big-calls", "key-moments", "commentary"]

const coverage = (): void => {
	console.log(
		`\nWHAT THE WINDOW GETS TODAY — the detector replayed over ${corpus.windows.length} games, hinge ask OFF`
	)
	const out: Record<string, unknown>[] = []
	for (const level of LEVELS) {
		let asks = 0
		let games = 0
		let none = 0
		const gaps: number[] = []
		const kinds = new Map<string, number>()
		for (const w of corpus.windows) {
			const { turns, lastSampleSec } = replay(w.sampleFile, level, true)
			if (lastSampleSec < HINGE_TO_SEC) continue
			games += 1
			const inWindow = turns.filter(t => t.atSec >= HINGE_FROM_SEC && t.atSec < HINGE_TO_SEC)
			asks += inWindow.length
			if (inWindow.length === 0) none += 1
			for (const t of inWindow) for (const k of new Set(t.kinds)) kinds.set(k, (kinds.get(k) ?? 0) + 1)
			const marks = [HINGE_FROM_SEC, ...inWindow.map(t => t.atSec), HINGE_TO_SEC]
			for (let i = 1; i < marks.length; i += 1) gaps.push(marks[i]! - marks[i - 1]!)
		}
		gaps.sort((a, b) => a - b)
		console.log(
			`  ${level.padEnd(12)} ${games} games reach ${clock(HINGE_TO_SEC)}   ${(asks / games).toFixed(2)} asks/game in the window   ` +
				`${none} games with NONE   median gap ${gaps[Math.floor(gaps.length / 2)]?.toFixed(0)}s   longest ${gaps.at(-1)?.toFixed(0)}s`
		)
		console.log(
			`               ${[...kinds]
				.sort((a, b) => b[1] - a[1])
				.map(([k, n]) => `${k} ${n}`)
				.join(", ")}`
		)
		out.push({
			level,
			gamesReaching: games,
			asksPerGame: asks / games,
			gamesWithNone: none,
			medianGapSec: gaps[Math.floor(gaps.length / 2)] ?? null,
			longestGapSec: gaps.at(-1) ?? null,
			kinds: Object.fromEntries(kinds)
		})
	}
	report.coverage = out
}

/**
 * The trade, written as the turn CLOCKS that differ rather than as a count, because a count hides a
 * swap — the same rule the fourth cut's own test states.
 */
const trade = (): void => {
	console.log(
		`\nTHE TRADE — hinge ask ON against OFF, gate ${GATE}s, ${corpus.windows.length} games`
	)
	const out: Record<string, unknown>[] = []
	for (const level of LEVELS) {
		const gained: string[] = []
		const lost: string[] = []
		const moved: string[] = []
		let games = 0
		let firedIn = 0
		const at: number[] = []
		for (const w of corpus.windows) {
			const off = replay(w.sampleFile, level, true).turns
			const on = replay(w.sampleFile, level, false).turns
			games += 1
			const offAt = new Set(off.map(t => t.atSec.toFixed(2)))
			const onAt = new Set(on.map(t => t.atSec.toFixed(2)))
			for (const t of on)
				if (!offAt.has(t.atSec.toFixed(2))) gained.push(`${w.id}@${clock(t.atSec)} ${t.kinds.join("+")}`)
			for (const t of off) if (!onAt.has(t.atSec.toFixed(2))) lost.push(`${w.id}@${clock(t.atSec)}`)
			/* A turn present in both but carrying different asks — the swap a count would hide. */
			const offKinds = new Map(off.map(t => [t.atSec.toFixed(2), t.kinds.join("+")]))
			for (const t of on) {
				const was = offKinds.get(t.atSec.toFixed(2))
				if (was !== undefined && was !== t.kinds.join("+"))
					moved.push(`${w.id}@${clock(t.atSec)} ${was} -> ${t.kinds.join("+")}`)
			}
			const hinge = on.filter(t => t.kinds.includes("hinge.silence"))
			if (hinge.length > 0) firedIn += 1
			for (const h of hinge) at.push(h.atSec)
		}
		at.sort((a, b) => a - b)
		/*
		 * THE SAME TRADE COUNTED THE WAY HE HEARS IT: asks inside the window, per game, by kind.
		 * A turn "lost" to the settle is not a question lost — it went out merged with another —
		 * and only this table can tell the two apart.
		 */
		const kindDelta = new Map<string, number>()
		let winOff = 0
		let winOn = 0
		let reach = 0
		/* Whole-game asks and minutes, so the per-28-minute figure in `SPEAK_LEVELS` stays derivable. */
		let allOff = 0
		let allOn = 0
		let minutes = 0
		for (const w of corpus.windows) {
			const offRun = replay(w.sampleFile, level, true)
			const off = offRun.turns
			const on = replay(w.sampleFile, level, false).turns
			allOff += off.length
			allOn += on.length
			minutes += offRun.lastSampleSec / 60
			if (offRun.lastSampleSec < HINGE_TO_SEC) continue
			reach += 1
			const inWin = (ts: Turn[]): Turn[] =>
				ts.filter(t => t.atSec >= HINGE_FROM_SEC && t.atSec < HINGE_TO_SEC)
			winOff += inWin(off).length
			winOn += inWin(on).length
			for (const t of inWin(off)) for (const k of t.kinds) kindDelta.set(k, (kindDelta.get(k) ?? 0) - 1)
			for (const t of inWin(on)) for (const k of t.kinds) kindDelta.set(k, (kindDelta.get(k) ?? 0) + 1)
		}
		const per28 = (n: number): string => ((28 * n) / (minutes / corpus.windows.length)).toFixed(2)
		console.log(
			`  ${level.padEnd(12)} whole game, per 28 minutes: ${per28(allOff / corpus.windows.length)} -> ${per28(
				allOn / corpus.windows.length
			)} asks (corpus mean ${(minutes / corpus.windows.length).toFixed(1)} min)`
		)
		console.log(
			`  ${level.padEnd(12)} in-window asks/game ${(winOff / reach).toFixed(2)} -> ${(winOn / reach).toFixed(2)} over ${reach} games; per-kind change ` +
				([...kindDelta].filter(([, n]) => n !== 0).map(([k, n]) => `${k} ${n > 0 ? "+" : ""}${n}`).join(", ") ||
					"none")
		)
		console.log(
			`  ${level.padEnd(12)} fires in ${String(firedIn).padStart(2)}/${games} games (${(at.length / games).toFixed(2)}/game)   ` +
				`turns gained ${gained.length}   turns LOST ${lost.length}   turns whose asks changed ${moved.length}`
		)
		if (at.length > 0)
			console.log(
				`               it lands ${clock(at[0]!)} to ${clock(at.at(-1)!)}, median ${clock(at[Math.floor(at.length / 2)]!)}`
			)
		if (lost.length > 0) console.log(`               LOST: ${lost.join(" | ")}`)
		if (moved.length > 0) console.log(`               CHANGED: ${moved.join(" | ")}`)
		out.push({
			level,
			gamesFiring: firedIn,
			games,
			perGame: at.length / games,
			firesAtSec: at,
			turnsGained: gained.length,
			turnsLost: lost,
			turnsChanged: moved,
			gainedDetail: gained
		})
	}
	console.log(
		"\n  Every gained turn is an instant no stored run ever took, so NOTHING here says what the added" +
			"\n  question produces. It says what it costs and what it moves, and it moves nothing."
	)
	report.gateSec = GATE
	report.trade = out
	report.speakLevels = SPEAK_LEVELS.map(l => ({ id: l.id, kinds: l.policy.kinds }))
}

/* ============================================================ run */

if (wants("precursors")) {
	const { rows, deaths } = observe()
	precursors(rows, deaths)
}
if (wants("coverage")) coverage()
if (wants("trade")) trade()

if (OUT !== "") {
	writeFileSync(OUT, `${JSON.stringify(report, null, "\t")}\n`)
	console.log(`\nwrote ${OUT}`)
}
