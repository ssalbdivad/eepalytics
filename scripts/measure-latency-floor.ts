/**
 * THE LATENCY FLOOR — where the seconds between a state change and the first syllable actually go.
 *
 *     node --env-file-if-exists=.env --experimental-strip-types --no-warnings=ExperimentalWarning \
 *       scripts/measure-latency-floor.ts --games all --level big-calls
 *     ... scripts/measure-latency-floor.ts --games 5639406342 --socket 10   # COSTS MONEY
 *
 * ## Why this file exists
 *
 * Every latency number this repo quotes is one of two things: `bench-stream.ts`'s `latencyMs`,
 * which is send-to-`turnComplete` (the END of generation, by which time audio has been playing for
 * most of it), or the regression in `web/lib/geminiLive.ts` that set `THREAD_MAX_TURNS`. Neither
 * is the number the player experiences, and `bench-stream.ts` says so in its own header: "nothing
 * in production has ever timestamped the first PCM chunk, so this file does not pretend to know
 * when he started hearing the line."
 *
 * This file times the first PCM chunk. It also decomposes the half of the budget that is ours —
 * the detector's beat, the ground-truth build, the payload render — which nothing has ever
 * measured at all, because every stored measurement starts at `ws.send`.
 *
 * ## Two phases, and only the second one costs anything
 *
 * **`compute`** (default, free, no network, no LCU) replays the recorded `allgamedata` in
 * `data/live-samples/` through the daemon's own functions — `projectTick`, `observeTick`,
 * `dueTurn`, `coach-memory.observe`, `reachFromLive`, `buildBrief`, `buildDelta` — and times each
 * one with `performance.now()`. It also answers the three questions the budget turns on:
 *
 *   - HOW MUCH OF THE PAYLOAD IS NEW. Every turn re-renders the world; a delta protocol is only
 *     worth building if what changed is small. Measured line-for-line, both between consecutive
 *     TURNS (the shipped schedule) and between consecutive SAMPLES (~5s apart, the ceiling a
 *     faster protocol could reach).
 *   - WHAT IS STATIC FOR THE WHOLE GAME. A line identical in every full brief of a game is a line
 *     that could ride once in the system instruction, where the socket does not re-bill it.
 *   - WHAT SPECULATION WOULD BUY AND COST. An objective's spawn is the one thing about the future
 *     this feed knows exactly (`nextOpeningSec`), so a turn could be STARTED before the window
 *     opens. The cost of being early is that the payload is stale by exactly that much, and that
 *     is measurable: build the brief at t-D and at t and count the lines that differ.
 *
 * **`socket`** (`--socket N`, opt-in, real money) opens ONE real Gemini Live socket, sends N real
 * replayed payloads, and timestamps four instants per turn: send, first PCM chunk, first
 * transcript fragment, `turnComplete`. The first of those is the number that has never existed.
 * It prints the count of paid calls before making any.
 *
 * ## What it corroborates rather than claims
 *
 * `scripts/socket-bake.ts` found that no bench in this repo sends `generationConfig.speechConfig`,
 * which the browser does, and that the incumbent then produces a transcript and NO AUDIO. That is
 * their finding; this file confirms it on a much bigger paired sample — 29 real turns of one game
 * with the field and 29 without, same payloads, same order — and prices what it did to every stored
 * latency number: 29 of 29 mute at `turnComplete` p50 772ms against 0 of 29 mute at p50 8,940ms.
 * The runs are `data/eval/latency-floor-socket-{incumbent,novoice}-20260918.json` and the mute arm
 * is reachable as `--novoice` so the pair stays re-derivable.
 *
 * ## What this file deliberately does NOT do
 *
 *   - IT NEVER TOUCHES THE LCU. The daemon is running and he plays at any hour. Every input is a
 *     file on disk. The `/api/live/tick` and `/api/live/ground-truth` hops are measured as their
 *     COMPUTE plus a separately-measured loopback RTT against an LCU-free route, never by calling
 *     the real ones.
 *   - It does not edit the live path, and it imports the shipped functions rather than copies, so
 *     a change to the brief changes this measurement on the next run.
 *   - It does not measure `speechSynthesis` onset or the browser's canvas JPEG encode. Neither is
 *     reachable from Node and neither has ever been measured; they are reported as UNMEASURED
 *     rather than estimated, because an estimate in a budget table reads exactly like a
 *     measurement.
 *
 * ## Reading the output
 *
 * Every cell is p50 / p95 over the stated n, and n is per-call, not per-game. A compute stage
 * measured at 0.4ms p50 over 12,000 calls is not a candidate for optimisation and the table says
 * so by printing it beside the 1,261ms the model takes.
 */

import { writeFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import { buildStream, discoverBenchable, median } from "./lib/stream.ts"
import type { BuiltStream, StreamWindow } from "./lib/stream.ts"
import {
	dueTurn,
	newEventWatch,
	nextOpeningSec,
	objectiveStates,
	observeTick,
	projectTick
} from "../src/analysis/live-events.ts"
import type { SpeakLevel } from "../src/analysis/live-events.ts"
import { reachFromLive } from "../src/analysis/reach-live.ts"
import {
	cpSeenAt,
	deathsSeen,
	newMemory,
	observe,
	renderGameSoFar,
	renderSaid
} from "../src/analysis/coach-memory.ts"
import type { MemoryState } from "../src/analysis/coach-memory.ts"
import { buildBrief, buildDelta } from "../src/shared/live-brief.ts"
import { socketSystemPrompt } from "../src/server/routes/live.ts"
import { fullKnowledge } from "../src/review/live-knowledge-full.ts"
import { GEMINI_LIVE_MODEL, mintGeminiToken } from "../src/review/gemini-live.ts"
import type { LiveAllGameData } from "../src/shared/schema/live.ts"

/* ============================================================ small statistics */

const pct = (xs: readonly number[], p: number): number => {
	if (xs.length === 0) return 0
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.min(s.length - 1, Math.floor(s.length * p))]!
}
const mean = (xs: readonly number[]): number =>
	xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length

/** A stage of the budget: a name, every timing observed, and where it runs. */
interface Stage {
	name: string
	where: "daemon" | "browser" | "network" | "model"
	ms: number[]
}
const stages = new Map<string, Stage>()
const timed = <T>(name: string, where: Stage["where"], fn: () => T): T => {
	const t0 = performance.now()
	const out = fn()
	const dt = performance.now() - t0
	const s = stages.get(name) ?? { name, where, ms: [] }
	s.ms.push(dt)
	stages.set(name, s)
	return out
}

/* ============================================================ line arithmetic */

/**
 * Lines that carry information, which is not every line.
 *
 * Blank lines and bare `##` headings are structure: counting them as "unchanged" would inflate the
 * static fraction with the payload's own furniture, and the furniture is exactly the part a delta
 * protocol drops for free. So they are excluded from every denominator here and the count of them
 * is reported separately, because a payload that is 12% furniture is itself a finding.
 */
const infoLines = (text: string): string[] =>
	text
		.split("\n")
		.map(l => l.trim())
		.filter(l => l !== "" && !/^#{1,6}\s/.test(l) && l !== "---")

/**
 * The same line with every NUMBER blanked — the difference between "the world changed" and "the
 * clock ticked", which is the whole of the delta question.
 *
 * The brief bakes an age into almost every line it renders: `- 10:45 (1m30s ago) Kayn took a
 * voidgrub` is byte-different on every single turn for the rest of the game, although the event it
 * describes has not moved and its absolute clock is printed right there. A novelty figure computed
 * on the raw bytes therefore measures the renderer's choice of wording, not the game. Both are
 * reported here, and the gap between them is the size of the prize.
 */
const maskNumbers = (l: string): string => l.replace(/\d+/g, "#")
const structuralLines = (text: string): string[] => infoLines(text).map(maskNumbers)

/**
 * The brief's own sections, which are blank-line-separated blocks whose first line opens on an
 * ALL-CAPS run — `NOW`, `NEXT — what is coming…`, `EVENT LOG, newest first…`, `YOU — Lillia, JUNGLE`.
 *
 * Named by that run alone, so `YOU — Lillia, JUNGLE, level 8` and `YOU — Lillia, JUNGLE, level 11`
 * are the same section rather than two. A block with no such opener keeps the previous section's
 * name, because the brief continues a section across blank lines in two places.
 */
const sectionOf = (text: string): { name: string; body: string }[] => {
	const out: { name: string; body: string }[] = []
	for (const block of text.split(/\n\s*\n/)) {
		const b = block.trim()
		if (b === "") continue
		const head = /^([A-Z][A-Z0-9 '\u2019]{2,})/.exec(b.split("\n")[0]!.trim())
		const name = head ? head[1]!.trim() : (out[out.length - 1]?.name ?? "(unnamed)")
		out.push({ name, body: b })
	}
	/* Two blocks under one name — the team rows — are one section. */
	const merged = new Map<string, string>()
	for (const s of out) merged.set(s.name, (merged.get(s.name) ?? "") + s.body)
	return [...merged].map(([name, body]) => ({ name, body }))
}

interface Novelty {
	/** Lines in the new payload that are byte-identical to a line in the old one. */
	kept: number
	/** Lines in the new payload that are not. */
	fresh: number
	/** Characters carried by the fresh lines. */
	freshChars: number
	totalChars: number
}
const noveltyOf = (oldLines: readonly string[], nowLines: readonly string[]): Novelty => {
	const old = new Set(oldLines)
	let kept = 0
	let fresh = 0
	let freshChars = 0
	let totalChars = 0
	for (const l of nowLines) {
		totalChars += l.length
		if (old.has(l)) kept += 1
		else {
			fresh += 1
			freshChars += l.length
		}
	}
	return { kept, fresh, freshChars, totalChars }
}
const structuralNovelty = (prev: string, now: string): Novelty =>
	noveltyOf(structuralLines(prev), structuralLines(now))
const novelty = (prev: string, now: string): Novelty => {
	const old = new Set(infoLines(prev))
	let kept = 0
	let fresh = 0
	let freshChars = 0
	let totalChars = 0
	for (const l of infoLines(now)) {
		totalChars += l.length
		if (old.has(l)) kept += 1
		else {
			fresh += 1
			freshChars += l.length
		}
	}
	return { kept, fresh, freshChars, totalChars }
}

/* ============================================================ the compute phase */

interface GameResult {
	gameId: string
	windowId: string
	champion: string
	durationSec: number
	samples: number
	turns: number
	/** Full brief and delta sizes, in characters, as the shipped protocol emits them. */
	briefChars: number[]
	deltaChars: number[]
	/** Turn-to-turn novelty on the real schedule. */
	turnNovelty: Novelty[]
	/** Sample-to-sample novelty (~5s apart) on the FULL brief — the protocol ceiling. */
	sampleNovelty: Novelty[]
	/** The same, with every digit masked: what changed that was not a clock. */
	sampleStructural: Novelty[]
	turnStructural: Novelty[]
	/** Turns the shipped path would have blocked on a minimap read before building anything. */
	proactiveTurns: number
	/** Per-section mean characters, and how often the section changed at all between samples. */
	sections: Map<string, { chars: number[]; changed: number; seen: number }>
	/** Fraction of full-brief information characters identical in EVERY turn of this game. */
	staticChars: number
	staticLines: number
	meanFullChars: number
	furnitureChars: number
	/** For each turn: how many seconds of warning `nextOpeningSec` had already given. */
	lead: (number | null)[]
	/** Speculating D seconds early: fraction of the brief's lines that would have been wrong. */
	speculation: Map<number, Novelty[]>
	speculationStructural: Map<number, Novelty[]>
	rawBytes: number[]
	parseMs: number[]
}

const SPECULATE_SEC = [3, 5, 10, 20, 45]

const runGame = (w: StreamWindow, level: SpeakLevel, verbose: boolean): GameResult | null => {
	let stream: BuiltStream
	try {
		stream = buildStream(w, {
			everySec: 20,
			fromSec: 0,
			turns: 9999,
			requireFrame: false,
			schedule: "events",
			level
		})
	} catch (e) {
		if (verbose) console.log(`  ${w.id}: ${(e as Error).message}`)
		return null
	}
	const samples = stream.samples ?? []
	if (samples.length < 10) return null

	/* ---- the detector's beat: what a 2-second look costs in CPU ---- */
	const watch = newEventWatch()
	for (const s of samples) {
		const tick = timed("projectTick", "daemon", () => projectTick(s.raw as LiveAllGameData))
		if (tick === null) continue
		timed("observeTick", "browser", () => {
			watch.pending.push(...observeTick(watch, tick, { level }))
		})
		timed("dueTurn", "browser", () =>
			dueTurn(watch, tick.gameTimeSec, { inFlight: false, level })
		)
		timed("objectiveStates+lookahead", "browser", () =>
			nextOpeningSec(watch, objectiveStates(tick), tick.gameTimeSec)
		)
	}

	/* ---- the per-sample pass: memory, reach, and a FULL brief at every instant ----
	 *
	 * The full brief at every sample is what the static-fraction and the speculation questions are
	 * both asked of. It is NOT what the app sends — the app sends one full brief and then deltas —
	 * so it is kept strictly separate from `deltaChars` below. */
	let memory: MemoryState = newMemory()
	let previous: { raw: unknown; gameTimeSec: number } | null = null
	const fullAt: { atSec: number; lines: string[]; text: string }[] = []
	const sections = new Map<string, { chars: number[]; changed: number; seen: number }>()
	let lastSectionText = new Map<string, string>()
	for (const s of samples) {
		memory = timed("coach-memory.observe", "daemon", () =>
			observe(memory, s.raw, s.gameTimeSec)
		)
		const reach = timed("reachFromLive", "daemon", () =>
			reachFromLive({ raw: s.raw as LiveAllGameData, nowSec: s.gameTimeSec, read: null })
		)
		const built = timed("buildBrief (full)", "daemon", () =>
			buildBrief({
				raw: s.raw,
				gameTimeSec: s.gameTimeSec,
				previous,
				baseline: stream.baseline,
				where: null,
				at: null,
				reach,
				counterpartSeenSec: cpSeenAt(memory),
				deathsSeen: deathsSeen(memory),
				counterpartWatchedFromSec: memory.observedFrom,
				said: renderSaid(memory, s.gameTimeSec).split("\n").slice(1),
				narrative: renderGameSoFar(memory, s.gameTimeSec, 380),
				feedNotes: false
			})
		)
		previous = { raw: s.raw, gameTimeSec: s.gameTimeSec }
		if (built) {
			fullAt.push({ atSec: s.gameTimeSec, lines: infoLines(built.text), text: built.text })
			/* Section churn: a section whose bytes are identical to last sample's is a section a
			 * delta protocol would send nothing for. */
			const now = new Map<string, string>()
			for (const sec of sectionOf(built.text)) {
				now.set(sec.name, sec.body)
				const e = sections.get(sec.name) ?? { chars: [], changed: 0, seen: 0 }
				e.chars.push(sec.body.length)
				e.seen += 1
				const was = lastSectionText.get(sec.name)
				if (was !== undefined && was !== sec.body) e.changed += 1
				sections.set(sec.name, e)
			}
			lastSectionText = now
		}
	}

	/* ---- what never changed all game ---- */
	const counts = new Map<string, number>()
	for (const f of fullAt) for (const l of new Set(f.lines)) counts.set(l, (counts.get(l) ?? 0) + 1)
	let staticChars = 0
	let staticLines = 0
	for (const [l, n] of counts)
		if (n === fullAt.length) {
			staticChars += l.length
			staticLines += 1
		}
	const meanFullChars = mean(fullAt.map(f => f.lines.reduce((a, l) => a + l.length, 0)))
	const furnitureChars = mean(
		fullAt.map(f => f.text.length - f.lines.reduce((a, l) => a + l.length, 0))
	)

	/* ---- sample-to-sample novelty: the ceiling a delta protocol could reach ---- */
	const sampleNovelty: Novelty[] = []
	const sampleStructural: Novelty[] = []
	for (let i = 1; i < fullAt.length; i++) {
		sampleNovelty.push(novelty(fullAt[i - 1]!.text, fullAt[i]!.text))
		sampleStructural.push(structuralNovelty(fullAt[i - 1]!.text, fullAt[i]!.text))
	}

	/* ---- speculation: what firing D seconds early would have got wrong ---- */
	const nearestFull = (atSec: number) => {
		let best: (typeof fullAt)[number] | null = null
		for (const f of fullAt) {
			if (f.atSec > atSec) break
			best = f
		}
		return best
	}
	const speculation = new Map<number, Novelty[]>()
	const speculationStructural = new Map<number, Novelty[]>()
	for (const d of SPECULATE_SEC) {
		speculation.set(d, [])
		speculationStructural.set(d, [])
	}
	for (const f of fullAt)
		for (const d of SPECULATE_SEC) {
			const early = nearestFull(f.atSec - d)
			if (early === null || early.atSec === f.atSec) continue
			speculation.get(d)!.push(novelty(f.text, early.text))
			speculationStructural.get(d)!.push(structuralNovelty(f.text, early.text))
		}

	/* ---- the SHIPPED protocol: one full brief, then deltas, timed ---- */
	const RESYNC_AFTER_SEC = 90
	let memory2: MemoryState = newMemory()
	let prev2: { raw: unknown; gameTimeSec: number } | null = null
	let cursor = 0
	let turnsSent = 0
	let lastAtSec = 0
	const briefChars: number[] = []
	const deltaChars: number[] = []
	const turnNovelty: Novelty[] = []
	const turnStructural: Novelty[] = []
	let proactiveTurns = 0
	const lead: (number | null)[] = []
	let lastPayload = ""
	const watch2 = newEventWatch()
	for (const t of stream.turns) {
		while (cursor < samples.length && samples[cursor]!.gameTimeSec <= t.atSec) {
			const smp = samples[cursor]!
			memory2 = observe(memory2, smp.raw, smp.gameTimeSec)
			cursor += 1
		}
		const tick = projectTick(t.raw as LiveAllGameData)
		if (tick !== null) {
			observeTick(watch2, tick, { level })
			const open = nextOpeningSec(watch2, objectiveStates(tick), t.atSec)
			lead.push(open === null ? null : open - t.atSec)
		} else lead.push(null)
		const reach = reachFromLive({
			raw: t.raw as LiveAllGameData,
			nowSec: t.atSec,
			read: null
		})
		const common = {
			raw: t.raw,
			gameTimeSec: t.atSec,
			previous: prev2,
			baseline: stream.baseline,
			where: null,
			at: null,
			reach,
			counterpartSeenSec: cpSeenAt(memory2),
			deathsSeen: deathsSeen(memory2),
			counterpartWatchedFromSec: memory2.observedFrom,
			said: renderSaid(memory2, t.atSec).split("\n").slice(1),
			narrative: renderGameSoFar(memory2, t.atSec, 380)
		}
		const full = turnsSent === 0 || t.atSec - lastAtSec > RESYNC_AFTER_SEC
		const built =
			full ?
				timed("buildBrief (shipped turn)", "daemon", () =>
					buildBrief({ ...common, feedNotes: false })
				)
			:	timed("buildDelta (shipped turn)", "daemon", () => buildDelta(common))
		prev2 = { raw: t.raw, gameTimeSec: t.atSec }
		if (!built) continue
		turnsSent += 1
		lastAtSec = t.atSec
		if (full) briefChars.push(built.text.length)
		else deltaChars.push(built.text.length)
		if (t.readMinimap) proactiveTurns += 1
		if (lastPayload !== "") {
			turnNovelty.push(novelty(lastPayload, built.text))
			turnStructural.push(structuralNovelty(lastPayload, built.text))
		}
		lastPayload = built.text
	}

	/* ---- what the daemon pays to parse one :2999 payload ---- */
	const rawBytes: number[] = []
	const parseMs: number[] = []
	for (let i = 0; i < samples.length; i += Math.max(1, Math.floor(samples.length / 30))) {
		const json = JSON.stringify(samples[i]!.raw)
		rawBytes.push(Buffer.byteLength(json))
		const t0 = performance.now()
		JSON.parse(json)
		parseMs.push(performance.now() - t0)
	}

	return {
		gameId: w.gameId,
		windowId: w.id,
		champion: w.champion,
		durationSec: w.gameDurationSec ?? 0,
		samples: samples.length,
		turns: stream.turns.length,
		briefChars,
		deltaChars,
		turnNovelty,
		turnStructural,
		sampleNovelty,
		sampleStructural,
		proactiveTurns,
		sections,
		staticChars,
		staticLines,
		meanFullChars,
		furnitureChars,
		lead,
		speculation,
		speculationStructural,
		rawBytes,
		parseMs
	}
}

/* ============================================================ the socket phase */

interface SocketTurn {
	index: number
	atSec: number
	payloadChars: number
	kind: string
	/** send -> first PCM chunk. THE number nothing in this repo has ever recorded. */
	ttfaMs: number | null
	/** send -> first `outputTranscription` fragment. */
	ttftMs: number | null
	/** send -> `turnComplete`. Comparable with `bench-stream.ts`'s `latencyMs`. */
	completeMs: number | null
	audioChunks: number
	text: string
	error: string | null
}

/** The shipped voice. `web/lib/geminiLive.ts`'s `VOICE`; a different one is a different measurement. */
const VOICE = "Leda"

const runSocket = async (
	w: StreamWindow,
	level: SpeakLevel,
	turns: number,
	model: string,
	thinkingLevel: string | null,
	/**
	 * `--novoice` drops `speechConfig`, which is the configuration every OTHER bench in this repo
	 * sends. It is kept as an ARM rather than deleted so the paired comparison stays re-derivable:
	 * see `scripts/socket-bake.ts`, which found the field missing, and the run pair
	 * `data/eval/latency-floor-socket-{incumbent,novoice}-20260918.json`.
	 */
	noVoice: boolean
): Promise<{ setupMs: number; mintMs: number; openMs: number; systemChars: number; rows: SocketTurn[] }> => {
	const stream = buildStream(w, {
		everySec: 20,
		fromSec: 0,
		turns: 9999,
		requireFrame: false,
		schedule: "events",
		level
	})
	const samples = stream.samples ?? []
	const wanted = stream.turns.slice(0, turns)
	const system = socketSystemPrompt({
		mode: "trusted",
		championKnowledge: fullKnowledge({
			champion: w.champion,
			counterpart: stream.turns.find(t => t.counterpart !== null)?.counterpart ?? null
		})
	})

	const t0 = performance.now()
	const minted = await mintGeminiToken()
	const mintMs = performance.now() - t0
	if (!minted.ok) throw new Error(`token: ${minted.error}`)

	const RESYNC_AFTER_SEC = 90
	let memory: MemoryState = newMemory()
	let previous: { raw: unknown; gameTimeSec: number } | null = null
	let cursor = 0
	let turnsSent = 0
	let lastAtSec = 0
	const payloadFor = (t: (typeof wanted)[number]): { text: string; kind: string } => {
		while (cursor < samples.length && samples[cursor]!.gameTimeSec <= t.atSec) {
			memory = observe(memory, samples[cursor]!.raw, samples[cursor]!.gameTimeSec)
			cursor += 1
		}
		const reach = reachFromLive({ raw: t.raw as LiveAllGameData, nowSec: t.atSec, read: null })
		const common = {
			raw: t.raw,
			gameTimeSec: t.atSec,
			previous,
			baseline: stream.baseline,
			where: null,
			at: null,
			reach,
			counterpartSeenSec: cpSeenAt(memory),
			deathsSeen: deathsSeen(memory),
			counterpartWatchedFromSec: memory.observedFrom,
			said: renderSaid(memory, t.atSec).split("\n").slice(1),
			narrative: renderGameSoFar(memory, t.atSec, 380)
		}
		const full = turnsSent === 0 || t.atSec - lastAtSec > RESYNC_AFTER_SEC
		const built = full ? buildBrief({ ...common, feedNotes: false }) : buildDelta(common)
		previous = { raw: t.raw, gameTimeSec: t.atSec }
		if (!built) return { text: "", kind: "none" }
		turnsSent += 1
		lastAtSec = t.atSec
		return { text: built.text, kind: full ? "brief" : "delta" }
	}

	return await new Promise((resolve, reject) => {
		const openedAt = performance.now()
		const ws = new WebSocket(
			`${minted.value.wsUrl}?access_token=${encodeURIComponent(minted.value.token)}`
		)
		let openMs = 0
		let setupMs = 0
		const rows: SocketTurn[] = []
		const queue = [...wanted]
		let cur: { at: number; t: (typeof wanted)[number]; sent: { text: string; kind: string } } | null = null
		let ttfa: number | null = null
		let ttft: number | null = null
		let chunks = 0
		let partial = ""
		let timer: ReturnType<typeof setTimeout> | null = null
		const done = () => {
			if (timer) clearTimeout(timer)
			try {
				ws.close(1000)
			} catch {
				/* already closed */
			}
			resolve({ setupMs, mintMs, openMs, systemChars: system.length, rows })
		}
		const next = () => {
			const t = queue.shift()
			if (t === undefined) return done()
			const sent = payloadFor(t)
			if (sent.text === "") return next()
			cur = { at: performance.now(), t, sent }
			ttfa = null
			ttft = null
			chunks = 0
			partial = ""
			ws.send(
				JSON.stringify({
					clientContent: {
						turns: [{ role: "user", parts: [{ text: sent.text }] }],
						turnComplete: true
					}
				})
			)
			if (timer) clearTimeout(timer)
			timer = setTimeout(() => {
				if (cur)
					rows.push({
						index: cur.t.index,
						atSec: cur.t.atSec,
						payloadChars: cur.sent.text.length,
						kind: cur.sent.kind,
						ttfaMs: null,
						ttftMs: null,
						completeMs: null,
						audioChunks: 0,
						text: "",
						error: "no answer in 40s"
					})
				done()
			}, 40_000)
			return undefined
		}
		ws.onopen = () => {
			openMs = performance.now() - openedAt
			ws.send(
				JSON.stringify({
					setup: {
						model,
						/*
						 * BYTE-FOR-BYTE THE SHIPPED SETUP — `web/lib/geminiLive.ts`, and the voice is
						 * not decoration.
						 *
						 * Measured while writing this file: with `speechConfig` omitted, the incumbent
						 * `gemini-3.1-flash-live-preview` answers some turns with an
						 * `outputTranscription` and NO audio parts at all — 0 chunks, `turnComplete`
						 * in ~340ms, a coach that produces words nobody can hear. Three probes
						 * without it went 20 / 0 / 11 audio chunks; three with it went 25 / 19 / 24.
						 * A latency measured on a turn that generated no audio is not the latency of
						 * this product, so the setup is copied rather than approximated.
						 */
						generationConfig: {
							responseModalities: ["AUDIO"],
							...(noVoice ?
								{}
							:	{ speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } } }),
							...(thinkingLevel === null ? {} : { thinkingConfig: { thinkingLevel } })
						},
						outputAudioTranscription: {},
						inputAudioTranscription: {},
						systemInstruction: { parts: [{ text: system }] }
					}
				})
			)
		}
		ws.onerror = () => reject(new Error("socket error"))
		ws.onclose = ev => {
			if (rows.length < wanted.length && timer) {
				clearTimeout(timer)
				timer = null
				resolve({ setupMs, mintMs, openMs, systemChars: system.length, rows })
			}
			if (ev.code !== 1000 && rows.length === 0) reject(new Error(`closed ${ev.code} ${ev.reason}`))
		}
		ws.onmessage = async ev => {
			const m = JSON.parse(
				typeof ev.data === "string" ? ev.data : await (ev.data as Blob).text()
			) as {
				setupComplete?: unknown
				serverContent?: {
					turnComplete?: boolean
					outputTranscription?: { text?: string }
					modelTurn?: { parts?: { text?: string; inlineData?: { mimeType?: string } }[] }
				}
			}
			if (m.setupComplete) {
				setupMs = performance.now() - openedAt
				next()
				return
			}
			const sc = m.serverContent
			if (!sc || !cur) return
			if (sc.outputTranscription?.text) {
				if (ttft === null) ttft = performance.now() - cur.at
				partial += sc.outputTranscription.text
			}
			for (const p of sc.modelTurn?.parts ?? []) {
				if (p.text) {
					if (ttft === null) ttft = performance.now() - cur.at
					partial += p.text
				}
				if (p.inlineData) {
					// THE INSTANT HE STARTS HEARING IT. Nothing in this repo has recorded this before.
					if (ttfa === null) ttfa = performance.now() - cur.at
					chunks += 1
				}
			}
			if (sc.turnComplete) {
				rows.push({
					index: cur.t.index,
					atSec: cur.t.atSec,
					payloadChars: cur.sent.text.length,
					kind: cur.sent.kind,
					ttfaMs: ttfa,
					ttftMs: ttft,
					completeMs: performance.now() - cur.at,
					audioChunks: chunks,
					text: partial.trim(),
					error: null
				})
				console.log(
					`  turn ${rows.length} ${cur.t.clock} ${cur.sent.kind} ${cur.sent.text.length}c  ` +
						`first-audio ${ttfa === null ? "—" : `${Math.round(ttfa)}ms`}  ` +
						`complete ${Math.round(performance.now() - cur.at)}ms  ${chunks} chunks`
				)
				cur = null
				next()
			}
		}
	})
}

/* ============================================================ report */

const fmt = (n: number, d = 0): string => n.toFixed(d)
const pad = (s: string, n: number) => s.padEnd(n)
const padL = (s: string, n: number) => s.padStart(n)

const main = async () => {
	const argv = process.argv.slice(2)
	const arg = (k: string): string | null => {
		const i = argv.indexOf(k)
		return i === -1 ? null : (argv[i + 1] ?? null)
	}
	const level = (arg("--level") ?? "big-calls") as SpeakLevel
	const which = arg("--games") ?? "all"
	const socketTurns = Number(arg("--socket") ?? "0")
	const socketModel = arg("--model") ?? GEMINI_LIVE_MODEL
	const out = arg("--out")

	const { paired, textOnly } = discoverBenchable()
	const all = [...paired, ...textOnly]
	const pick =
		which === "all" ? all
		: which === "paired" ? paired
		: all.filter(w => which.split(",").includes(w.gameId) || which.split(",").includes(w.id))
	if (pick.length === 0) {
		console.log("no games matched")
		return
	}

	if (socketTurns > 0) {
		const w = pick[0]!
		console.log(
			`\nSOCKET PHASE — ${socketTurns} PAID turns on ${socketModel}${argv.includes("--novoice") ? " WITHOUT speechConfig" : ""}, game ${w.gameId} (${w.champion}).\n`
		)
		const r = await runSocket(w, level, socketTurns, socketModel, arg("--thinking"), argv.includes("--novoice"))
		const ok = r.rows.filter(x => x.ttfaMs !== null)
		console.log(`\n  token mint ${fmt(r.mintMs)}ms · socket open ${fmt(r.openMs)}ms · setupComplete ${fmt(r.setupMs)}ms`)
		console.log(`  system instruction ${r.systemChars} chars, sent ONCE at setup`)
		console.log(
			`  first audio   p50 ${fmt(pct(ok.map(x => x.ttfaMs!), 0.5))}ms  p95 ${fmt(pct(ok.map(x => x.ttfaMs!), 0.95))}ms  n=${ok.length}`
		)
		const mute = r.rows.filter(x => x.audioChunks === 0 && x.error === null)
		console.log(
			`  MUTE TURNS (a transcript came back and NO audio did): ${mute.length} of ${r.rows.length}` +
				(mute.length === 0 ? "" : " — he heard nothing on those")
		)
		console.log(
			`  turnComplete  p50 ${fmt(pct(r.rows.filter(x => x.completeMs !== null).map(x => x.completeMs!), 0.5))}ms  ` +
				`p95 ${fmt(pct(r.rows.filter(x => x.completeMs !== null).map(x => x.completeMs!), 0.95))}ms`
		)
		console.log("\n  turn  clock-ish  payload  first-audio  transcript  complete")
		for (const x of r.rows)
			console.log(
				`  ${padL(String(x.index), 4)}  ${padL(fmt(x.atSec), 9)}  ${padL(`${x.payloadChars}c`, 7)}  ` +
					`${padL(x.ttfaMs === null ? "—" : `${fmt(x.ttfaMs)}ms`, 11)}  ` +
					`${padL(x.ttftMs === null ? "—" : `${fmt(x.ttftMs)}ms`, 10)}  ` +
					`${padL(x.completeMs === null ? "—" : `${fmt(x.completeMs)}ms`, 8)}`
			)
		if (out) writeFileSync(out, JSON.stringify({ kind: "socket", model: socketModel, ...r }, null, 2))
		return
	}

	console.log(`\nreplaying ${pick.length} game(s) at level=${level} — no network, no LCU\n`)
	const results: GameResult[] = []
	for (const w of pick) {
		const r = runGame(w, level, true)
		if (r === null) continue
		results.push(r)
		process.stdout.write(
			`  ${pad(r.gameId, 11)} ${pad(r.champion, 8)} ${padL(String(r.samples), 4)} samples ${padL(String(r.turns), 3)} turns\n`
		)
	}

	/* ---- the compute table ---- */
	console.log("\n\nCOMPUTE BUDGET — every stage the app runs itself, per call\n")
	console.log(`  ${pad("stage", 28)} ${pad("runs", 8)} ${padL("p50", 9)} ${padL("p95", 9)} ${padL("max", 9)}`)
	const order = [
		"projectTick",
		"observeTick",
		"dueTurn",
		"objectiveStates+lookahead",
		"coach-memory.observe",
		"reachFromLive",
		"buildBrief (full)",
		"buildBrief (shipped turn)",
		"buildDelta (shipped turn)"
	]
	for (const name of order) {
		const s = stages.get(name)
		if (!s) continue
		console.log(
			`  ${pad(s.name, 28)} ${pad(s.where, 8)} ${padL(`${fmt(pct(s.ms, 0.5), 2)}ms`, 9)} ` +
				`${padL(`${fmt(pct(s.ms, 0.95), 2)}ms`, 9)} ${padL(`${fmt(Math.max(...s.ms), 1)}ms`, 9)}   n=${s.ms.length}`
		)
	}
	const allRaw = results.flatMap(r => r.rawBytes)
	const allParse = results.flatMap(r => r.parseMs)
	console.log(
		`  ${pad("JSON.parse(allgamedata)", 28)} ${pad("daemon", 8)} ${padL(`${fmt(pct(allParse, 0.5), 2)}ms`, 9)} ` +
			`${padL(`${fmt(pct(allParse, 0.95), 2)}ms`, 9)} ${padL(`${fmt(Math.max(...allParse), 1)}ms`, 9)}   n=${allParse.length}`
	)
	console.log(
		`\n  the :2999 payload itself is ${fmt(pct(allRaw, 0.5) / 1024, 1)} KB p50 / ${fmt(pct(allRaw, 0.95) / 1024, 1)} KB p95`
	)

	/* ---- the payload table ---- */
	const briefs = results.flatMap(r => r.briefChars)
	const deltas = results.flatMap(r => r.deltaChars)
	const tn = results.flatMap(r => r.turnNovelty)
	const sn = results.flatMap(r => r.sampleNovelty)
	const tns = results.flatMap(r => r.turnStructural)
	const sns = results.flatMap(r => r.sampleStructural)
	console.log("\n\nPAYLOAD — what is sent, and how much of it is new\n")
	console.log(`  full brief         p50 ${padL(fmt(pct(briefs, 0.5)), 6)}c  p95 ${padL(fmt(pct(briefs, 0.95)), 6)}c   n=${briefs.length}`)
	console.log(`  delta              p50 ${padL(fmt(pct(deltas, 0.5)), 6)}c  p95 ${padL(fmt(pct(deltas, 0.95)), 6)}c   n=${deltas.length}`)
	const freshPctTurn = tn.map(n => (n.totalChars === 0 ? 0 : (100 * n.freshChars) / n.totalChars))
	const freshPctSample = sn.map(n => (n.totalChars === 0 ? 0 : (100 * n.freshChars) / n.totalChars))
	console.log(
		`\n  turn-to-turn: ${fmt(mean(freshPctTurn), 1)}% of the payload's information characters are NEW ` +
			`(p50 ${fmt(pct(freshPctTurn, 0.5), 1)}%, p95 ${fmt(pct(freshPctTurn, 0.95), 1)}%, n=${tn.length})`
	)
	console.log(
		`  sample-to-sample (~5s, FULL brief): ${fmt(mean(freshPctSample), 1)}% new ` +
			`(p50 ${fmt(pct(freshPctSample, 0.5), 1)}%, p95 ${fmt(pct(freshPctSample, 0.95), 1)}%, n=${sn.length})`
	)
	const sPctTurn = tns.map(n => (n.totalChars === 0 ? 0 : (100 * n.freshChars) / n.totalChars))
	const sPctSample = sns.map(n => (n.totalChars === 0 ? 0 : (100 * n.freshChars) / n.totalChars))
	console.log(
		`\n  WITH EVERY NUMBER MASKED — what changed that was not a clock:\n` +
			`    turn-to-turn      ${fmt(mean(sPctTurn), 1)}% (was ${fmt(mean(freshPctTurn), 1)}%)\n` +
			`    sample-to-sample  ${fmt(mean(sPctSample), 1)}% (was ${fmt(mean(freshPctSample), 1)}%)`
	)
	console.log(
		`    so ${fmt(mean(freshPctSample) - mean(sPctSample), 1)} points of the payload's per-sample churn is ages ticking on lines\n` +
			`    whose content did not move. That is a rendering choice, not a fact about the game.`
	)
	/* ---- where the bytes live, and which of them move ---- */
	const secAgg = new Map<string, { chars: number[]; changed: number; seen: number }>()
	for (const r of results)
		for (const [k, v] of r.sections) {
			const e = secAgg.get(k) ?? { chars: [], changed: 0, seen: 0 }
			e.chars.push(...v.chars)
			e.changed += v.changed
			e.seen += v.seen
			secAgg.set(k, e)
		}
	const rows = [...secAgg].filter(([, v]) => v.seen > 20).sort((a, b) => mean(b[1].chars) - mean(a[1].chars))
	console.log("\n  the full brief, by section — mean chars, and how often the bytes moved between samples\n")
	console.log(`  ${pad("section", 34)} ${padL("chars", 7)} ${padL("share", 7)} ${padL("moved", 7)}`)
	const totalMean = rows.reduce((a, [, v]) => a + mean(v.chars), 0)
	for (const [k, v] of rows.slice(0, 14))
		console.log(
			`  ${pad(k.slice(0, 34), 34)} ${padL(fmt(mean(v.chars)), 7)} ${padL(`${fmt((100 * mean(v.chars)) / Math.max(1, totalMean), 1)}%`, 7)} ` +
				`${padL(`${fmt((100 * v.changed) / Math.max(1, v.seen), 0)}%`, 7)}`
		)
	console.log(
		`\n  proactive turns (the shipped path AWAITS a minimap read in front of these): ` +
			`${results.reduce((a, r) => a + r.proactiveTurns, 0)} of ${results.reduce((a, r) => a + r.turns, 0)}`
	)
	const staticShare = results.map(r => (r.meanFullChars === 0 ? 0 : (100 * r.staticChars) / r.meanFullChars))
	console.log(
		`\n  identical in EVERY full brief of the game: ${fmt(mean(staticShare), 1)}% of information characters ` +
			`(median game ${fmt(median(staticShare), 1)}%, ${fmt(mean(results.map(r => r.staticLines)), 1)} lines)`
	)
	console.log(
		`  structural furniture (blank lines and headings): ${fmt(mean(results.map(r => r.furnitureChars)), 0)} chars per full brief`
	)

	/* ---- speculation ---- */
	console.log("\n\nSPECULATION — firing the turn D seconds early, and what goes stale\n")
	console.log(
		`  ${pad("D", 6)} ${padL("chars wrong", 13)} ${padL("not-a-clock", 13)}  n     (right column masks every number)`
	)
	for (const d of SPECULATE_SEC) {
		const rows = results.flatMap(r => r.speculation.get(d) ?? [])
		const srows = results.flatMap(r => r.speculationStructural.get(d) ?? [])
		if (rows.length === 0) continue
		const cw = rows.map(n => (n.totalChars === 0 ? 0 : (100 * n.freshChars) / n.totalChars))
		const sw = srows.map(n => (n.totalChars === 0 ? 0 : (100 * n.freshChars) / n.totalChars))
		console.log(
			`  ${pad(`${d}s`, 6)} ${padL(`${fmt(mean(cw), 1)}%`, 13)} ${padL(`${fmt(mean(sw), 1)}%`, 13)}  ${rows.length}`
		)
	}
	const leads = results.flatMap(r => r.lead).filter((x): x is number => x !== null && x > 0)
	const allTurns = results.reduce((a, r) => a + r.turns, 0)
	console.log(
		`\n  turns with a known future objective window: ${leads.length} of ${allTurns} ` +
			`(${fmt((100 * leads.length) / Math.max(1, allTurns), 0)}%), ` +
			`warning p50 ${fmt(median(leads))}s, p95 ${fmt(pct(leads, 0.95))}s`
	)

	/* ---- the budget, assembled ---- */
	const stage = (n: string, q: number) => pct(stages.get(n)?.ms ?? [0], q)
	const ours50 =
		stage("projectTick", 0.5) +
		stage("observeTick", 0.5) +
		stage("dueTurn", 0.5) +
		stage("coach-memory.observe", 0.5) +
		stage("reachFromLive", 0.5) +
		stage("buildBrief (shipped turn)", 0.5)
	const ours95 =
		stage("projectTick", 0.95) +
		stage("observeTick", 0.95) +
		stage("dueTurn", 0.95) +
		stage("coach-memory.observe", 0.95) +
		stage("reachFromLive", 0.95) +
		stage("buildBrief (shipped turn)", 0.95)
	console.log("\n\nTHE BUDGET — state change to first syllable, socket path\n")
	console.log(`  ${pad("component", 40)} ${padL("p50", 10)} ${padL("p95", 10)}   where it comes from`)
	const row = (n: string, a: string, b: string, src: string) =>
		console.log(`  ${pad(n, 40)} ${padL(a, 10)} ${padL(b, 10)}   ${src}`)
	row("detector beat (nothing has looked yet)", "1000ms", "1900ms", "EVENT_TICK_MS=2000, uniform wait")
	row("settle clock", "0ms", "0ms", "SETTLE_SEC=12 fires on 11 of 631 turns")
	row("all of our own arithmetic", `${fmt(ours50, 2)}ms`, `${fmt(ours95, 2)}ms`, `six stages, n=${stages.get("projectTick")?.ms.length ?? 0}`)
	row("two loopback hops + LCU interop", "7ms", "12ms", "1.2ms loopback x2 (n=20) + 2.3ms interop")
	row("awaited minimap read", "0-1239ms", "0-2615ms", "route docblock, 101 reads; skipped when the watcher is fresh")
	row("grabFrame (canvas -> JPEG)", "UNMEASURED", "UNMEASURED", "browser only; never measured")
	row("send -> FIRST AUDIO", "855ms", "1069ms", "--socket 30, n=29, shipped setup")
	console.log(
		`\n  ${pad("TOTAL, no minimap read", 40)} ${padL(`${fmt(1000 + ours50 + 7 + 855)}ms`, 10)} ${padL(`${fmt(1900 + ours95 + 12 + 1069)}ms`, 10)}`
	)
	console.log(
		`  ${pad("TOTAL, with one", 40)} ${padL(`${fmt(1000 + ours50 + 7 + 1239 + 855)}ms`, 10)} ${padL(`${fmt(1900 + ours95 + 12 + 2615 + 1069)}ms`, 10)}`
	)
	console.log(
		`\n  THE FLOOR if the beat went to 500ms and the read came off the path: ` +
			`${fmt(250 + ours50 + 7 + 855)}ms p50. The model is ${fmt((100 * 855) / (250 + ours50 + 7 + 855))}% of it,\n` +
			`  and every line of TypeScript this app runs per turn is ${fmt(ours50, 1)}ms of it.`
	)

	if (out) {
		writeFileSync(
			out,
			JSON.stringify(
				{
					kind: "compute",
					ranAt: new Date().toISOString(),
					argv,
					level,
					games: results.map(r => ({
						...r,
						sections: Object.fromEntries([...r.sections].map(([k, v]) => [k, { meanChars: mean(v.chars), changed: v.changed, seen: v.seen }])),
						speculation: Object.fromEntries([...r.speculation].map(([k, v]) => [k, v])),
						speculationStructural: Object.fromEntries(
							[...r.speculationStructural].map(([k, v]) => [k, v])
						)
					})),
					stages: [...stages.values()].map(s => ({
						name: s.name,
						where: s.where,
						n: s.ms.length,
						p50: pct(s.ms, 0.5),
						p95: pct(s.ms, 0.95),
						max: Math.max(...s.ms)
					}))
				},
				null,
				2
			)
		)
		console.log(`\nwrote ${out}`)
	}
}

void main()
