/**
 * VARIANT "terse-facts" — the smallest payload that can still produce the round-2 useful lines.
 *
 * ## The hypothesis
 *
 * The shipped `trusted` brief is a few thousand characters of rendered state. Round 2 on game
 * 5639406342 got 10 useful lines out of 37, and 20 of the 37 were true-but-useless — the coach
 * reciting his own HUD back at him. The claim tested here is that **most of the payload is noise
 * the model has to wade through**, and that the useful lines survive a payload under 600
 * characters.
 *
 * The target is not "less data for its own sake". It is the measured shape of every useful line in
 * round 2: a WINDOW (an objective clock or a death timer), WHERE the contest will be, and WHETHER
 * HE CAN BE THERE. So the cut keeps exactly those three joins and throws away everything that is
 * not one of them.
 *
 * ## What is IN, and why each earns its characters
 *
 * - **the clock**, because every other figure here is relative to it;
 * - **him** — level, HP, mana, gold, score, CS. He is looking at all of it on his HUD, so it is
 *   cheap for him and near-worthless as a line; it is here because it is the input to "can he be
 *   there", not because it is worth saying;
 * - **where the minimap reader put him**, with the age of the read. The only position source that
 *   exists (1.8% median error, 7/8 exact zone) and the WHERE leg of every useful line;
 * - **the counterpart's level, whether he is dead and for how long, and what he just bought.**
 *   Level is 94.5% exact for enemies and items are exact once seen. His CS is NOT here and cannot
 *   be derived from anything here — the feed's figure is a visibility counter (70 against a true
 *   183) and both lines a human has ever marked FALSE in this app were that number;
 * - **who is dead right now, on both sides, with their timers.** Exact for everyone, not
 *   fog-gated. This is the other kind of WINDOW;
 * - **the last handful of events with their ages**, because "Kayn just got Herald" is the half of
 *   the best line this app has produced that no state table can supply;
 * - **NEXT** — each epic's spawn clock joined to `reachFromLive`, i.e. how long the walk is and
 *   whether he beats the spawn. This is the WHETHER HE CAN BE THERE leg, computed in TypeScript;
 * - **his own CS average**, but only within a minute of a checkpoint the game has actually passed.
 *
 * ## What is OUT, and what that is a bet on
 *
 * Out: the full ten-player roster table, every ally's level and score, ward scores, summoner
 * spells, declared roles, full item lists, item price sums, the whole scrolling event log, the
 * game-so-far narrative, his own combat stats, his own ability ranks, the delta section, and the
 * record of what the coach has already said.
 *
 * The last one is the sharpest bet in this file and it is a bet AGAINST a measured fault:
 * repetition (three drake lines in 19 seconds, 56% near-duplicates across 144 shipped lines) is
 * exactly what the "what you have already said" section exists to suppress, and this variant
 * deletes it. If terse-facts repeats itself more than the incumbent, that section is load-bearing
 * and this is the file that proved it.
 *
 * ## What this file does NOT do
 *
 * It computes facts; it never selects a subject, names a cadence, or tells the model when to
 * speak. Every section is rendered whenever its data exists and omitted only when the data does
 * not. The one exception is the character cap, which drops whole sections from the bottom of a
 * fixed priority order when a turn overflows — that is a length rule, not a subject rule, and the
 * runner prints every drop it made.
 *
 * The champion knowledge is accepted as an input (the live path has it) and deliberately NOT
 * rendered into the payload: `coachTurn` already puts the complete markdown in the SYSTEM
 * instruction, where it is static for the whole game. Putting it in the turn payload would pay for
 * the same bytes every turn and would make a 600-character budget meaningless.
 *
 * ## Running it
 *
 *     node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *       scripts/variants/terse-facts.ts            # print the ten payloads, call nothing
 *     ... scripts/variants/terse-facts.ts --run    # send the ten to gemini-3.6-flash with frames
 *
 * `--run` makes ten paid calls through `coachTurn`, so the system prompt is the shipped
 * TRUSTED_PROMPT and cannot have been varied by this file.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { projectTick } from "../../src/analysis/live-events.ts"
import type { LiveTick, TickEvent, TickPlayer } from "../../src/analysis/live-events.ts"
import { reachFromLive } from "../../src/analysis/reach-live.ts"
import type { ReachPosition } from "../../src/analysis/reach-live.ts"
import type { Reach } from "../../src/analysis/reachability.ts"
import type { LiveAllGameData } from "../../src/shared/schema/live.ts"
import { dragonPhrase } from "../../src/shared/dragons.ts"
import { coachTurn } from "../../src/review/live-providers.ts"

/* ============================================================== the inputs */

/**
 * One accepted minimap read, exactly as `data/eval/minimap-track/*.json` stores it.
 *
 * `null` is a real and common answer — the reader refused 44% of its looks and those refusals were
 * right. A refusal is rendered as an explicit "position unknown" rather than as silence, because
 * the largest measured fault in round 2 was the model inventing a position whenever the payload
 * said nothing about one (4 of 7 false lines, once placing Kayn topside while Kayn was on the
 * screenshot next to him). Saying "unknown" is a fact about the reader; it is not an instruction.
 */
export interface TerseFix {
	/** Game clock of the PICTURE, not of the turn. */
	tSec: number
	label: string
	coarse: string
	pct: { left: number; top: number }
	/** Unidentified enemy rings the reader saw. Never a champion name — it cannot tell them apart. */
	enemyLabels: string[]
	activity: string
}

export interface TerseBaselines {
	/** `cs@10`, `cs@14`, `cs@20` -> the MEAN over his recent finished games. Never a median. */
	[key: string]: { mean: number; n: number } | undefined
}

export interface TerseState {
	/** The raw `allgamedata` for this instant. */
	raw: LiveAllGameData
	/** The sample before it, for what the counterpart bought. `null` on the first turn. */
	prev: LiveAllGameData | null
	/** The minimap track entry nearest this clock, or `null` when the reader refused. */
	fix: TerseFix | null
	baselines: TerseBaselines | null
	/**
	 * Accepted because the live path has it; deliberately unused. See the header — it belongs in
	 * the system instruction, not in a payload with a 600-character budget.
	 */
	championKnowledge?: string
}

export interface TerseOptions {
	/** Hard cap. Sections are dropped from the bottom of the priority order until the text fits. */
	maxChars?: number
	/** How far back an event may be and still be called recent. */
	eventWindowSec?: number
	/** How close to a checkpoint his average may be quoted. */
	checkpointWindowSec?: number
	/** Filled in with the section names the cap dropped, for the runner to print. */
	dropped?: string[]
}

export const DEFAULT_MAX_CHARS = 600
const DEFAULT_EVENT_WINDOW_SEC = 35
const DEFAULT_CHECKPOINT_WINDOW_SEC = 60
/** Never more than this many recent events, whatever the cap allows. */
const MAX_EVENTS = 3

/* ============================================================== small helpers */

const clockOf = (sec: number): string => {
	const s = Math.max(0, Math.round(sec))
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 100) : 0)

/** The counterpart: the enemy the client itself declared JUNGLE. It has named exactly one per team. */
const counterpartOf = (tick: LiveTick): TickPlayer | null => {
	const enemies = tick.players.filter(p => p.team !== tick.me.team)
	return enemies.find(p => p.position.toUpperCase() === "JUNGLE") ?? null
}

const championOf = (tick: LiveTick, name: string | null): string =>
	name === null ? "?" : (tick.players.find(p => p.name === name)?.champion ?? name)

/** Item display names a player is holding, from the raw feed — `TickPlayer` only counts them. */
const itemsOf = (raw: LiveAllGameData | null, name: string): string[] => {
	const all = (raw as { allPlayers?: unknown } | null)?.allPlayers
	if (!Array.isArray(all)) return []
	for (const row of all) {
		const p = row as Record<string, unknown>
		const who = (p.riotIdGameName ?? p.summonerName ?? p.riotId) as string | undefined
		if (who !== name) continue
		const items = Array.isArray(p.items) ? p.items : []
		return items
			.map(i => (i as { displayName?: unknown }).displayName)
			.filter((n): n is string => typeof n === "string")
	}
	return []
}

/** What appeared in his slots since the previous sample. Names, never prices — prices are junk. */
const gainedItems = (prev: LiveAllGameData | null, now: LiveAllGameData, name: string): string[] => {
	if (prev === null) return []
	const before = itemsOf(prev, name)
	const after = itemsOf(now, name)
	const pool = [...before]
	const out: string[] = []
	for (const it of after) {
		const at = pool.indexOf(it)
		if (at === -1) out.push(it)
		else pool.splice(at, 1)
	}
	return out
}

/** One event, in the fewest words that still carry who did what to whom. */
const describeEvent = (tick: LiveTick, e: TickEvent, now: number): string | null => {
	const age = Math.max(0, Math.round(now - e.atSec))
	const at = `${clockOf(e.atSec)} (${age}s ago)`
	const killer = championOf(tick, e.killer)
	if (e.name === "ChampionKill") return `${at} ${killer} killed ${championOf(tick, e.victim)}`
	// `dragonPhrase`, because the API says "Earth" and every human being on the planet says
	// "Mountain". A coach saying "Earth drake" out loud is instantly a coach who is not watching.
	if (e.name === "DragonKill") return `${at} ${killer} took ${dragonPhrase(e.dragonType)}`
	if (e.name === "HeraldKill") return `${at} ${killer} took Rift Herald`
	if (e.name === "BaronKill") return `${at} ${killer} took Baron`
	if (e.name === "HordeKill") return `${at} ${killer} took a voidgrub`
	if (e.name === "TurretKilled") return `${at} ${killer} took a turret`
	if (e.name === "InhibKilled") return `${at} ${killer} took an inhibitor`
	return null
}

/**
 * Past this, an objective is a date on a calendar rather than a thing to walk to, and the walk
 * arithmetic is meaningless because he will have moved several times before it lands.
 */
const REACH_HORIZON_SEC = 150

/**
 * The reach row as one clause: the window, the walk, and the slack between them.
 *
 * **No verdict, deliberately.** An earlier draft of this file printed "you beat it", and on the
 * 17:56 turn it printed it off a `moveSpeed` of 552 — his fountain-boost speed, read while he was
 * standing in base, which decays the moment he leaves it. `etaMin` is documented in
 * `reachability.ts` as a FLOOR on a straight line through walls; dressing a floor as a verdict is
 * exactly the "spoken as a read, written as a measurement" failure. So the window and the walk are
 * both printed, the walk is labelled a floor, and the comparison is left to the model.
 *
 * An objective that is ALREADY STANDING gets no slack figure at all: `windowSec - eta` for
 * something already up is a large negative number that reads as "too late" when the true answer is
 * "it is sitting there".
 */
const describeReach = (r: Reach): string => {
	const up = r.windowSec <= 0
	/*
	 * "STANDING, untaken for 64s" rather than "up 64s", and the extra characters are the cheapest
	 * ones in this file. Run 1 of this variant rendered "Drake up 64s" and gemini-3.6-flash read it
	 * as "dragon in a minute" — TWICE, at 6:04 and again at 13:28, i.e. two of the three clearly
	 * false lines in the run came from one ambiguous preposition. A payload compressed to the point
	 * where a timer's SIGN is inferable rather than stated is not terse, it is broken.
	 */
	const when = up ? `STANDING, untaken for ${Math.round(-r.windowSec)}s` : `in ${Math.round(r.windowSec)}s`
	if (!up && r.windowSec > REACH_HORIZON_SEC) return `${r.label} ${when}`
	if (r.etaMinSec === null || r.etaMaxSec === null) return `${r.label} ${when}, walk unknown`
	const walk = `${Math.round(r.etaMinSec)}-${Math.round(r.etaMaxSec)}s walk floor`
	if (up) return `${r.label} ${when}, ${walk}`
	const spare = r.marginMinSec === null ? null : Math.round(r.marginMinSec)
	const slack = spare === null ? "" : spare >= 0 ? `, ${spare}s spare` : `, ${-spare}s short`
	return `${r.label} ${when}, ${walk}${slack}`
}

/* ============================================================== the renderer */

/**
 * The payload. One line per section, `KEY value` so a model can find a section by name without a
 * heading costing a whole line of budget.
 */
export const renderVariant = (state: TerseState, opts: TerseOptions = {}): string => {
	const tick = projectTick(state.raw)
	if (tick === null) return ""
	const now = tick.gameTimeSec
	const max = opts.maxChars ?? DEFAULT_MAX_CHARS
	const eventWindow = opts.eventWindowSec ?? DEFAULT_EVENT_WINDOW_SEC
	const checkpointWindow = opts.checkpointWindowSec ?? DEFAULT_CHECKPOINT_WINDOW_SEC

	/* --- him. The WHERE leg, plus the inputs to the walk. */
	const me = tick.me
	const where =
		state.fix === null ?
			"position unknown (the minimap reader refused this look)"
		:	`${state.fix.label}, ${state.fix.activity}, read ${Math.max(0, Math.round(now - state.fix.tSec))}s ago`
	const mana = me.manaType === "MANA" ? ` ${pct(me.mana, me.maxMana)}%mana` : ""
	const youLine =
		me.dead ?
			`YOU ${me.champion} L${me.level} DEAD ${Math.round(me.respawn)}s ${Math.round(me.gold)}g ${me.kills}/${me.deaths}/${me.assists} ${me.cs}cs`
		:	`YOU ${me.champion} L${me.level} ${pct(me.hp, me.maxHp)}%hp${mana} ${Math.round(me.gold)}g ${me.kills}/${me.deaths}/${me.assists} ${me.cs}cs — ${where}`

	/* --- the counterpart. Level, timer, and what he just bought. Never his CS. */
	const cp = counterpartOf(tick)
	const bought = cp ? gainedItems(state.prev, state.raw, cp.name) : []
	const cpLine =
		cp === null ? null : (
			`HIM ${cp.champion} L${cp.level} ${cp.dead ? `DEAD ${Math.round(cp.respawn)}s` : "alive"} ${cp.kills}/${cp.deaths}/${cp.assists}${bought.length > 0 ? ` — just bought ${bought.join(", ")}` : ""}`
		)

	/* --- every corpse on the map, with its timer. The other kind of window. */
	const corpses = tick.players
		.filter(p => p.dead && p.name !== me.name)
		.sort((a, b) => a.respawn - b.respawn)
		.map(p => `${p.champion} ${Math.round(p.respawn)}s${p.team === me.team ? " (yours)" : ""}`)
	const downLine = corpses.length > 0 ? `DOWN ${corpses.join(", ")}` : null

	/* --- what just happened. His and the counterpart's first, then the rest, newest first. */
	const recent = tick.events
		.filter(e => now - e.atSec <= eventWindow && e.atSec <= now)
		.sort((a, b) => b.atSec - a.atSec)
	const mine = recent.filter(
		e =>
			e.killer === me.name ||
			e.victim === me.name ||
			(cp !== null && (e.killer === cp.name || e.victim === cp.name)) ||
			e.name === "DragonKill" ||
			e.name === "BaronKill" ||
			e.name === "HeraldKill"
	)
	const rest = recent.filter(e => !mine.includes(e))
	const eventLines = [...mine, ...rest]
		.map(e => describeEvent(tick, e, now))
		.filter((s): s is string => s !== null)
		.slice(0, MAX_EVENTS)
	const justLine = eventLines.length > 0 ? `JUST ${eventLines.join(" · ")}` : null

	/* --- his own average, only at a checkpoint the game has actually passed. */
	let baseLine: string | null = null
	for (const minute of [10, 14, 20]) {
		const at = minute * 60
		if (now < at || now - at > checkpointWindow) continue
		const stat = state.baselines?.[`cs@${minute}`]
		if (!stat) continue
		baseLine = `PACE ${me.cs}cs at ${minute}:00 against your own ${minute}-minute average of ${stat.mean.toFixed(1)} (mean of ${stat.n} games)`
	}

	/* --- forward. The only section that points at something that has not happened. */
	const read: ReachPosition | null =
		state.fix === null ? null : { pct: state.fix.pct, atSec: state.fix.tSec }
	const reach = reachFromLive({ raw: state.raw, nowSec: now, read })
	const nextLine =
		reach.length > 0 ? `NEXT ${reach.map(describeReach).join(" · ")}` : null

	/* --- the unidentified rings. A position for SOMEBODY, and the reader cannot say who. */
	const rings =
		state.fix !== null && state.fix.enemyLabels.length > 0 ?
			`RINGS (unidentified enemy dots, same ${Math.max(0, Math.round(now - state.fix.tSec))}s-old read) ${state.fix.enemyLabels.join(", ")}`
		:	null

	/*
	 * Priority, highest first. The cap drops from the BOTTOM, so what survives an overflowing turn
	 * is the three legs of a useful line and nothing else.
	 */
	const sections: { name: string; text: string }[] = [
		{ name: "clock", text: clockOf(now) },
		{ name: "you", text: youLine },
		...(cpLine ? [{ name: "him", text: cpLine }] : []),
		...(downLine ? [{ name: "down", text: downLine }] : []),
		...(justLine ? [{ name: "just", text: justLine }] : []),
		...(nextLine ? [{ name: "next", text: nextLine }] : []),
		...(rings ? [{ name: "rings", text: rings }] : []),
		...(baseLine ? [{ name: "pace", text: baseLine }] : [])
	]

	const dropped = opts.dropped ?? []
	const kept = [...sections]
	const render = (rows: typeof sections): string => rows.map(r => r.text).join("\n")
	while (render(kept).length > max && kept.length > 2) {
		const gone = kept.pop()
		if (gone) dropped.push(gone.name)
	}
	return render(kept)
}

/* ============================================================== the runner */

/*
 * Everything below is the bench for this one file: the ten fixed moments of game 5639406342,
 * rendered and sent. It is here rather than in a second file so the variant is one file, as the
 * tournament asked.
 */

const GAME_ID = 5639406342
const SESSION = "js-mtvxb5f4-f81a"
const SAMPLES = `/home/ssalb/eepalytics/data/live-samples/${SESSION}-t29817812.ndjson`
const TRACK = `/home/ssalb/eepalytics/data/eval/minimap-track/${SESSION}.json`
const PACK = `/home/ssalb/eepalytics/data/eval/pack-${GAME_ID}.json`

/** The ten moments every variant in this tournament is measured on. */
export const MOMENTS_SEC = [260, 364, 443, 522, 699, 808, 857, 1076, 1156, 1430]

interface SampleRow {
	atMs: number
	gameTime: number
	data: LiveAllGameData
}

const loadSamples = (): SampleRow[] =>
	readFileSync(SAMPLES, "utf8")
		.split("\n")
		.filter(l => l.trim() !== "")
		.map(l => JSON.parse(l) as SampleRow)

interface TrackEntry {
	tSec: number
	ok: boolean
	framePath: string
	read: {
		you: { pct: { left: number; top: number }; label: string; coarse: string } | null
		enemies: { label: string }[]
		activity: string
	} | null
}

const loadTrack = (): TrackEntry[] =>
	(JSON.parse(readFileSync(TRACK, "utf8")) as { entries: TrackEntry[] }).entries

const nearest = <T,>(rows: T[], at: number, key: (r: T) => number): T | null => {
	let best: T | null = null
	let bestGap = Infinity
	for (const r of rows) {
		const gap = Math.abs(key(r) - at)
		if (gap < bestGap) {
			bestGap = gap
			best = r
		}
	}
	return best
}

/**
 * The most recent ACCEPTED read at or before this clock, within a staleness bound.
 *
 * At or before, never after: a read from the future is a fact the live coach could not have had.
 * The bound is the reader's own cadence plus slack — past it, "unknown" is the honest render.
 */
const READ_STALE_SEC = 25
const fixFor = (track: TrackEntry[], at: number): TerseFix | null => {
	let best: TrackEntry | null = null
	for (const e of track) {
		if (!e.ok || !e.read?.you) continue
		if (e.tSec > at || at - e.tSec > READ_STALE_SEC) continue
		if (best === null || e.tSec > best.tSec) best = e
	}
	if (best === null || !best.read?.you) return null
	return {
		tSec: best.tSec,
		label: best.read.you.label,
		coarse: best.read.you.coarse,
		pct: best.read.you.pct,
		enemyLabels: best.read.enemies.map(e => e.label),
		activity: best.read.activity
	}
}

interface PackFrame {
	tSec: number
	path: string
}

const main = async (): Promise<void> => {
	const run = process.argv.includes("--run")
	const samples = loadSamples()
	const track = loadTrack()
	const pack = JSON.parse(readFileSync(PACK, "utf8")) as {
		baselines: { stats: TerseBaselines }
		frames: PackFrame[]
	}

	const out: {
		clock: string
		tSec: number
		chars: number
		dropped: string[]
		payload: string
		frame: string | null
		text?: string
		latencyMs?: number
	}[] = []

	for (const at of MOMENTS_SEC) {
		const row = nearest(samples, at, s => s.gameTime)
		if (!row) continue
		const idx = samples.indexOf(row)
		const prev = idx > 0 ? samples[idx - 1]!.data : null
		const dropped: string[] = []
		const payload = renderVariant(
			{
				raw: row.data,
				prev,
				fix: fixFor(track, at),
				baselines: pack.baselines.stats,
				championKnowledge: ""
			},
			{ dropped }
		)
		const frame = nearest(pack.frames, at, f => f.tSec)
		out.push({
			clock: clockOf(at),
			tSec: at,
			chars: payload.length,
			dropped,
			payload,
			frame: frame ? frame.path : null
		})
	}

	for (const o of out) {
		console.log(`\n===== ${o.clock} — ${o.chars} chars${o.dropped.length > 0 ? ` (dropped: ${o.dropped.join(", ")})` : ""}`)
		console.log(o.payload)
	}

	if (!run) {
		console.log("\n(no --run: nothing was called)")
		return
	}

	for (const o of out) {
		const frameB64 = o.frame ? readFileSync(o.frame).toString("base64") : undefined
		const res = await coachTurn({
			provider: "gemini-http",
			model: "gemini-3.6-flash",
			mode: "trusted",
			champion: "Lillia",
			counterpart: "Kayn",
			blockText: o.payload,
			frameJpegBase64: frameB64
		})
		o.text = res.ok ? res.text.trim() : `ERROR ${res.reason ?? ""}`
		o.latencyMs = res.latencyMs
		console.log(`${o.clock}  ${String(o.latencyMs).padStart(6)}ms  ${o.text}`)
	}

	const dest = process.env.TERSE_OUT ?? "/tmp/terse-facts-run.json"
	writeFileSync(dest, JSON.stringify({ game: GAME_ID, variant: "terse-facts", turns: out }, null, 2))
	console.log(`\nwrote ${dest}`)
}

if (process.argv[1]?.endsWith("terse-facts.ts")) await main()
