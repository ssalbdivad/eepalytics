/**
 * probe-arc — replay the recorded games through `analysis/arc.ts` and print what it WOULD have
 * said, and when.
 *
 * ## Why a probe and not a test
 *
 * `arc.ts` is arithmetic and its unit test pins the arithmetic. What a unit test cannot tell you is
 * whether a field is worth having: a gate that fires on every tick of every game produces the CS
 * nag with a new subject, and a gate that fires once in four games is an anecdote wearing a
 * headline's clothes. Both look like a passing test. So this walks all four recorded games poll by
 * poll — the daemon's own verbatim `allgamedata`, ~6s of game clock apart — and reports, per game:
 *
 *   - how many ticks each `ArcLineKind` was live for, and on how many DISTINCT occasions;
 *   - the first time each fired, with the sentence it would have produced;
 *   - the coverage of the quantisation-bound fields, which is the honest ceiling on the derivative.
 *
 * Read the per-game columns, not the total. A field that fires in one game of four is not the
 * headline it looks like, and the table is laid out to make that impossible to miss.
 *
 * ## Usage
 *
 *     node --experimental-strip-types scripts/probe-arc.ts
 *     node --experimental-strip-types scripts/probe-arc.ts --games split-03 --window 90
 *     node --experimental-strip-types scripts/probe-arc.ts --lines            # every line, in order
 *
 * Options:
 *   --games <a,b>   sample files to replay (default split-01,split-02,split-03,split-04)
 *   --dir <path>    where the .ndjson live (default $DATA_DIR/live-samples)
 *   --window <sec>  the derivative window (default `ARC_WINDOW_SEC`)
 *   --lines         print every line as it would have been spoken, with its clock
 *   --every <n>     evaluate one tick in n (default 1 — the whole stream)
 *   --insight       score every distinct arc line on `analysis/insight.ts`, the OTHER track's
 *                   instrument, which was built and thresholded without seeing this file
 */

import fs from "node:fs"
import path from "node:path"
import { ARC_WINDOW_SEC, arcLines, buildArc } from "../src/analysis/arc.ts"
import type { Arc, ArcLine, ArcLineKind, ArcSample } from "../src/analysis/arc.ts"
import { scoreInsight } from "../src/analysis/insight.ts"
import type { LiveAllGameData } from "../src/shared/schema/live.ts"

const flag = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}
const has = (name: string): boolean => process.argv.includes(`--${name}`)

const DATA_DIR = process.env.DATA_DIR ?? "data"
const DIR = flag("dir", path.join(DATA_DIR, "live-samples"))
const GAMES = flag("games", "split-01,split-02,split-03,split-04").split(",")
const WINDOW = Number(flag("window", String(ARC_WINDOW_SEC)))
const EVERY = Math.max(1, Number(flag("every", "1")))

const mmss = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`

const load = (game: string): ArcSample[] => {
	const file = game.endsWith(".ndjson") ? game : path.join(DIR, `${game}.ndjson`)
	return fs
		.readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(l => l.length > 0)
		.map(l => JSON.parse(l) as { gameTime: number; data: LiveAllGameData })
		.map(r => ({ atSec: r.gameTime, data: r.data }))
}

const KINDS: ArcLineKind[] = [
	"stall",
	"race-move",
	"absent",
	"dying",
	"soul",
	"dragon-run",
	"nemesis",
	"level-move",
	"gold-rot",
	"objective-drought"
]

interface GameReport {
	game: string
	ticks: number
	lastSec: number
	me: string
	counterpart: string | null
	/** Ticks each kind was live for. */
	live: Record<string, number>
	/** Distinct episodes: a run of consecutive ticks counts once. */
	episodes: Record<string, number>
	first: Record<string, { atSec: number; text: string }>
	/** Coverage of the interval-bounded derivative fields. */
	farmCertain: number
	raceCertain: number
	stallSuppressed: number
	withArc: number
	raceOpening: number
	raceClosing: number
	/** Every stall episode seen, whether or not it was allowed to speak. */
	stalls: { atSec: number; sinceSec: number; forSec: number; explained: boolean; during: string }[]
}

const report = (game: string): GameReport => {
	const all = load(game)
	const r: GameReport = {
		game,
		ticks: 0,
		lastSec: all[all.length - 1]?.atSec ?? 0,
		me: "",
		counterpart: null,
		live: {},
		episodes: {},
		first: {},
		farmCertain: 0,
		raceCertain: 0,
		stallSuppressed: 0,
		withArc: 0,
		raceOpening: 0,
		raceClosing: 0,
		stalls: []
	}
	const wasLive: Record<string, boolean> = {}
	for (let i = 0; i < all.length; i += EVERY) {
		const arc: Arc | null = buildArc(all.slice(0, i + 1), { windowSec: WINDOW })
		if (!arc) continue
		r.ticks++
		r.me = arc.me
		r.counterpart = arc.counterpart
		if (arc.farm && arc.farm.mine.atLeast > 0) r.farmCertain++
		if (arc.race?.moved) r.raceCertain++
		if (arc.stall?.explained) r.stallSuppressed++
		if (arc.race?.moved === "opening") r.raceOpening++
		if (arc.race?.moved === "closing") r.raceClosing++
		if (arc.stall && !r.stalls.some(x => x.sinceSec === arc.stall!.sinceSec))
			r.stalls.push({
				atSec: arc.nowSec,
				sinceSec: arc.stall.sinceSec,
				forSec: arc.stall.forSec,
				explained: arc.stall.explained,
				during: `${arc.stall.during.kills}k/${arc.stall.during.deaths}d/${arc.stall.during.objectives}o`
			})
		const lines: ArcLine[] = arcLines(arc)
		if (lines.length > 0) r.withArc++
		const seen = new Set(lines.map(l => l.kind))
		for (const l of lines) {
			r.live[l.kind] = (r.live[l.kind] ?? 0) + 1
			if (!wasLive[l.kind]) r.episodes[l.kind] = (r.episodes[l.kind] ?? 0) + 1
			r.first[l.kind] ??= { atSec: arc.nowSec, text: l.text }
			if (has("lines")) console.log(`  ${mmss(arc.nowSec)}  [${l.kind}] ${l.text}`)
		}
		for (const k of KINDS) wasLive[k] = seen.has(k)
	}
	return r
}

const pad = (s: string, n: number): string => s.padEnd(n)
const padl = (s: string, n: number): string => s.padStart(n)

const reports: GameReport[] = []
for (const g of GAMES) {
	if (has("lines")) console.log(`\n===== ${g}`)
	reports.push(report(g))
}

console.log(`\n# probe-arc — window ${WINDOW}s, every ${EVERY} poll\n`)
console.log(pad("game", 10) + padl("polls", 7) + padl("length", 8) + "  me / enemy jungler")
for (const r of reports)
	console.log(
		pad(r.game, 10) + padl(String(r.ticks), 7) + padl(mmss(r.lastSec), 8) + `  ${r.me} vs ${r.counterpart ?? "?"}`
	)

console.log(`\n## Ticks each line was LIVE for (episodes in brackets)\n`)
console.log(pad("kind", 14) + reports.map(r => padl(r.game.replace("split-", "s"), 14)).join("") + padl("games", 7))
for (const k of KINDS) {
	const cells = reports.map(r => {
		const n = r.live[k] ?? 0
		return padl(n === 0 ? "-" : `${n} (${r.episodes[k] ?? 0})`, 14)
	})
	const games = reports.filter(r => (r.live[k] ?? 0) > 0).length
	console.log(pad(k, 14) + cells.join("") + padl(`${games}/${reports.length}`, 7))
}

console.log(`\n## The quantisation ceiling — what the client's rounding leaves provable\n`)
console.log(pad("measure", 26) + reports.map(r => padl(r.game.replace("split-", "s"), 12)).join(""))
const pct = (n: number, d: number): string => (d === 0 ? "-" : `${Math.round((100 * n) / d)}%`)
console.log(
	pad("farm gain provable", 26) + reports.map(r => padl(pct(r.farmCertain, r.ticks), 12)).join("")
)
console.log(pad("race move provable", 26) + reports.map(r => padl(pct(r.raceCertain, r.ticks), 12)).join(""))
console.log(pad("ticks with any arc line", 26) + reports.map(r => padl(pct(r.withArc, r.ticks), 12)).join(""))
console.log(
	pad("stalls vetoed by events", 26) + reports.map(r => padl(String(r.stallSuppressed), 12)).join("")
)
console.log(pad("race gap opening / closing", 26) + reports.map(r => padl(`${r.raceOpening} / ${r.raceClosing}`, 12)).join(""))

console.log(`\n## Every stall episode, spoken or vetoed\n`)
for (const r of reports)
	for (const st of r.stalls)
		console.log(
			`  ${r.game}  flat from ${mmss(st.sinceSec)}, seen at ${mmss(st.atSec)} after ${st.forSec}s, during ${st.during}  ${st.explained ? "VETOED" : "spoken"}`
		)

if (has("insight")) {
	/*
	 * The cross-check that matters, on an instrument this file did not write.
	 *
	 * `analysis/insight.ts` scores a spoken line on four axes and reports that ZERO of the 144 lines
	 * two real models produced from the ground-truth block had a premise that left the instant. Every
	 * distinct line below passes that axis — which is the thesis, measured by somebody else's ruler.
	 *
	 * It does NOT reach `insight`, and that is the correct result rather than a disappointment: the
	 * instrument's other two axes ask for an ACTION ("take your own raptors"), and an arc line is a
	 * premise on purpose. Appending one flips the verdict — measured, on the stall line:
	 *
	 *     "...at most 9 CS in 3:21."                                    2/4  filler
	 *     "...at most 9 CS in 3:21. Take your own raptors and finish
	 *      the route before you cross river again."                     4/4  INSIGHT
	 *
	 * The `repeat` verdicts are also real and are a warning to the consumer, not a defect in the
	 * fact: these are templates, so a second firing of the same kind reads as the same sentence. The
	 * arc supplies the premise; the model phrases it and `live-facts.ts` decides when it may be said
	 * at all.
	 */
	console.log(`\n## Scored on analysis/insight.ts — the other track's instrument\n`)
	console.log(pad("game", 10) + padl("lines", 7) + padl("beyond-instant", 16) + padl("mean /4", 9) + "  needs")
	for (const r of reports) {
		const all = load(r.game)
		const champions = (all[all.length - 1]?.data.allPlayers ?? []).map(p => p.championName ?? "")
		const seen = new Set<string>()
		const texts: string[] = []
		for (let i = 0; i < all.length; i += EVERY) {
			const arc = buildArc(all.slice(0, i + 1), { windowSec: WINDOW })
			if (!arc) continue
			for (const l of arcLines(arc))
				if (!seen.has(l.text)) {
					seen.add(l.text)
					texts.push(l.text)
				}
		}
		const scored = texts.map(line => scoreInsight({ line, champions, earlier: [] }))
		const beyond = scored.filter(s => s.beyondInstant.pass).length
		const needs = new Set(scored.flatMap(s => s.needs))
		console.log(
			pad(r.game, 10) +
				padl(String(scored.length), 7) +
				padl(`${beyond}/${scored.length}`, 16) +
				padl((scored.reduce((a, s) => a + s.score, 0) / Math.max(1, scored.length)).toFixed(2), 9) +
				`  ${[...needs].join(", ")}`
		)
	}
}

console.log(`\n## First firing of each line, per game\n`)
for (const r of reports) {
	console.log(`### ${r.game}`)
	const rows = KINDS.filter(k => r.first[k]).map(k => `  ${mmss(r.first[k]!.atSec)}  [${k}] ${r.first[k]!.text}`)
	console.log(rows.length > 0 ? rows.join("\n") : "  (nothing fired)")
}
