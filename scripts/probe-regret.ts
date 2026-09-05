/**
 * probe-regret — did the live coach point at what actually mattered?
 *
 * ## The question this answers, and why nothing else in the repo answers it
 *
 * `analysis/coach-score.ts` asks whether a line is TRUE. The coach is at ceiling there and has
 * been for months, which is exactly the problem: the nine-line transcript the owner quit on
 * scores perfectly on it. Six of those nine lines were about farm, none needed the screenshot,
 * and the whole set could have been pasted onto a different game.
 *
 * This probe asks the other question. It replays a real recorded game, takes the ranked facts the
 * shipped coach actually held at each poll, and compares them against what HAPPENED NEXT —
 * computed by `analysis/hindsight.ts` from the client's own event feed, which is knowledge no
 * live model can have and every real coach does.
 *
 * ## The rule that keeps this honest
 *
 * Hindsight is not fairness. The ground-truth block carries no position for anybody, so most
 * deaths in a real game are genuinely unforeseeable from what the coach was handed. A metric that
 * punished the coach for not prophesying them would drive the confident guessing this whole app
 * exists to prevent. So `hindsight.ts` classifies every consequence as `block`, `frame-only` or
 * `none`, **only `block` is scored**, and this report prints all three so the size of the silence
 * is visible. A low coverage number is a claim about the coach. A large `none` bucket is a claim
 * about the data. They must never be added together.
 *
 * ## Two measures, deliberately kept apart
 *
 * - **Mechanical** — `MECHANICAL_LINKS` in `hindsight.ts`: a crude fact-kind to consequence-kind
 *   table. Blind to whether the line was the RIGHT one, reproducible forever, and the number a
 *   regression can be caught on.
 * - **Judged** (`--judge`) — a real model asked whether the line pointed at the thing, or at
 *   something that would plausibly have prevented or enabled it. This is where the meaning lives
 *   and it is not checkable, which is why it never replaces the number above it.
 *
 * ## What is treated as "what the coach said"
 *
 * The TOP-RANKED FACT. The model may only speak from the list `buildFacts` produces, and the
 * `mock` provider in `review/live-providers.ts` exists on exactly this reasoning — it echoes the
 * first ranked fact and is "what the coach would say if the model contributed nothing at all".
 * Scoring the list would flatter the coach by giving it three guesses; scoring the top of it is
 * the honest floor. The whole ranked list is reported alongside so the gap is visible.
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/probe-regret.ts \
 *     [--samples data/live-samples/split-03.ndjson] [--horizons 30,60,90] \
 *     [--exclude <gameId>] [--judge] [--judge-model gemini-3.6-flash] [--judge-limit 24] \
 *     [--out report.json] [--verbose]
 *
 * Reads only. Never touches the League client, never writes to the database.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import {
	consequencesAfter,
	factKind,
	HORIZONS,
	links,
	linksKind,
	regretAt,
	SITUATION_LEAD_SEC as SITUATION_LEAD,
	timelineFromSamples
} from "../src/analysis/hindsight.ts"
import type { Consequence, FactKind, Timeline } from "../src/analysis/hindsight.ts"

/* ---------------------------------------------------------------- arguments */

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback
}
const flag = (name: string): boolean => argv.includes(`--${name}`)

/**
 * Comma-separated, because one game is an anecdote.
 *
 * The coverage number moves by seventeen points between the four recorded games (15% to 32%), so
 * a run over a single stream can be read as either a crisis or a quibble depending which one was
 * picked. The totals line at the bottom is the number worth quoting, and it says its n.
 */
const SAMPLES = arg("samples", "data/live-samples/split-03.ndjson")
	.split(",")
	.map(f => f.trim())
	.filter(f => f !== "")
const HORIZON_LIST = arg("horizons", HORIZONS.join(","))
	.split(",")
	.map(n => Number(n.trim()))
	.filter(n => Number.isFinite(n) && n > 0)
const EXCLUDE = Number(arg("exclude", "0"))
const JUDGE_MODEL = arg("judge-model", "gemini-3.6-flash")
const JUDGE_LIMIT = Number(arg("judge-limit", "24"))

/* -------------------------------------------------------------- the replay */

/**
 * Rebuild the ranked list the coach held at every poll.
 *
 * Goes through the daemon's OWN `buildLiveStateForBench`, which calls the daemon's own
 * `buildFacts` with the daemon's own module-level memory — so the cooldowns, the announce-once
 * sets and the "a death may not lead two turns running" rule all apply exactly as they did in the
 * game. A second reconstruction here would be measuring a lookalike of the coach.
 */
const replay = async (
	rows: { gameTime: number; data: unknown }[]
): Promise<{ atSec: number; facts: string[]; clock: string }[]> => {
	const { buildLiveStateForBench } = await import("../src/server/routes/live.ts")

	/*
	 * The farm baseline, from his real corpus with the replayed game excluded.
	 *
	 * Load-bearing rather than tidy: with no baseline, `pace` is null, and `buildFacts` cannot
	 * emit a farm line AT ALL. Measuring the coach's farm habit against a run where farm was
	 * structurally impossible would produce a flattering number about the exact complaint that
	 * started this probe. Excluded from its own baseline, because otherwise the game being
	 * replayed sets the average it is compared to.
	 */
	let baseline: unknown = null
	try {
		const { loadCorpus } = await import("../src/daemon/corpus.ts")
		const { baselineFromRows, perGameMetrics } = await import("../src/analysis/index.ts")
		const corpus = loadCorpus(20, EXCLUDE > 0 ? { excludeGameId: EXCLUDE } : {})
		if (corpus.length > 0) baseline = baselineFromRows(perGameMetrics(corpus))
	} catch (e) {
		console.error(`! no farm baseline (${(e as Error).message}) — farm facts cannot fire`)
	}
	if (baseline === null) console.error("! no farm baseline available; farm facts cannot fire")

	const out: { atSec: number; facts: string[]; clock: string }[] = []
	for (const row of rows) {
		const st = buildLiveStateForBench(row.data, row.gameTime, baseline as never)
		if (!st) continue
		out.push({ atSec: row.gameTime, facts: st.unseen, clock: st.clock })
	}
	return out
}

/* ------------------------------------------------------------- aggregation */

/** A consequence, deduped across the many overlapping windows it appears in. */
interface Distinct {
	key: string
	kind: Consequence["kind"]
	atSec: number
	weight: number
	evidence: string
	/**
	 * The BEST foresight it ever had in its own lead-up.
	 *
	 * A consequence is judged foreseeable if there was ANY instant inside the horizon before it
	 * where the block carried a precursor — that is the window in which a coach could have said
	 * something. Taking the foresight at a single arbitrary instant would make the answer depend
	 * on poll alignment.
	 */
	best: Consequence["foresight"]
	because: string
	/** Ticks in its lead-up where a ranked fact mechanically linked to it. */
	spokenTo: { atSec: number; fact: string; top: boolean }[]
	/**
	 * How many ticks in its lead-up the coach had ANYTHING to offer.
	 *
	 * Separates the two failures, which need opposite fixes: zero means the coach was silent and
	 * had no material, which is a gap in `buildFacts`; a positive number with an empty `spokenTo`
	 * means it had material and ranked the wrong thing first, which is a gap in the ordering.
	 */
	offered: number
	/**
	 * Ticks AFTER it landed where a linked fact was offered — the readout case.
	 *
	 * Split out because "the coach never mentioned it" and "the coach mentioned it once it was
	 * already gone" are opposite diagnoses with opposite fixes, and a single coverage number
	 * cannot tell them apart. Measured on the reference game they are not close: every enemy
	 * objective the coach spoke about, it spoke about afterwards.
	 */
	spokenAfter: { atSec: number; fact: string }[]
}

const rank = { block: 2, "frame-only": 1, none: 0 } as const

const clock = (sec: number): string =>
	`${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`

const aggregate = (
	tl: Timeline,
	spoken: { atSec: number; facts: string[] }[],
	horizonSec: number
) => {
	const byKey = new Map<string, Distinct>()
	/** Speaking ticks, for the precision half of the measure. */
	const lines: {
		atSec: number
		facts: string[]
		foreseeable: number
		linked: number
		topHit: boolean
		target: Consequence | null
	}[] = []

	for (const tick of spoken) {
		const r = regretAt(tl, tick.atSec, tick.facts, horizonSec)
		for (const c of r.all) {
			const key = `${c.kind}@${Math.round(c.atSec)}`
			const prev = byKey.get(key)
			const entry: Distinct = prev ?? {
				key,
				kind: c.kind,
				atSec: c.atSec,
				weight: c.weight,
				evidence: c.evidence,
				best: c.foresight,
				because: c.because,
				spokenTo: [],
				spokenAfter: [],
				offered: 0
			}
			if (tick.facts.length > 0) entry.offered += 1
			if (rank[c.foresight] > rank[entry.best]) {
				entry.best = c.foresight
				entry.because = c.because
			}
			if (c.foresight === "block")
				for (const [i, f] of tick.facts.entries())
					if (links(f, c)) entry.spokenTo.push({ atSec: tick.atSec, fact: f, top: i === 0 })
			byKey.set(key, entry)
		}
		if (tick.facts.length > 0)
			lines.push({
				atSec: tick.atSec,
				facts: tick.facts,
				foreseeable: r.foreseeable.length,
				linked: r.linked.length,
				topHit: r.topHitTarget,
				target: r.target
			})
	}

	/*
	 * Consequences are enumerated from the SPEAKING ticks above, which would miss any that fell
	 * entirely inside a silence. So the full game is walked once more at the sampler's own
	 * interval to complete the denominator — a consequence nobody was ever offered a fact about
	 * is precisely the interesting case, and leaving it out would inflate coverage.
	 */
	for (const t of tl.ticks) {
		for (const c of consequencesAfter(tl, t.atSec, horizonSec)) {
			const key = `${c.kind}@${Math.round(c.atSec)}`
			const prev = byKey.get(key)
			if (!prev) {
				byKey.set(key, {
					key,
					kind: c.kind,
					atSec: c.atSec,
					weight: c.weight,
					evidence: c.evidence,
					best: c.foresight,
					because: c.because,
					spokenTo: [],
					spokenAfter: [],
					offered: 0
				})
			} else if (rank[c.foresight] > rank[prev.best]) {
				prev.best = c.foresight
				prev.because = c.because
			}
		}
	}

	/*
	 * The backward pass. Forward windows can only ever find a fact spoken BEFORE the thing, which
	 * is the right definition of coverage and the wrong way to notice a readout — so the ticks
	 * after each consequence are scanned separately.
	 */
	for (const c of byKey.values())
		for (const tick of spoken) {
			if (tick.atSec <= c.atSec || tick.atSec > c.atSec + horizonSec) continue
			for (const f of tick.facts)
				if (linksKind(f, c.kind)) c.spokenAfter.push({ atSec: tick.atSec, fact: f })
		}

	const all = [...byKey.values()].sort((a, b) => a.atSec - b.atSec)
	return { all, lines }
}

/* ------------------------------------------------------------------- judge */

/**
 * The judged half. A real model, because arguing about what it would say is not a measurement.
 *
 * Deliberately NOT `coachTurn`: that path fixes the live coach's own system prompt as a
 * non-parameter, which is right for a provider comparison and useless for grading. This is a
 * plain generateContent call with a rubric, and it never sees the frame — it is grading the
 * CHOICE of fact, not the picture.
 */
const judgeBatch = async (
	items: { clock: string; said: string; others: string[]; mattered: string[] }[]
): Promise<{ verdict: string; why: string }[]> => {
	const key = readFileSync("data/gemini.key", "utf8").trim()
	const rubric = `You are grading a live League of Legends voice coach for a jungle main, one line at a time.

For each case you get: the ONE sentence the coach chose to say at that instant, the other facts it
could have said instead, and — with hindsight it did not have — what actually happened in the next
seconds. Only consequences the coach COULD have known about from its data are listed; it has no
positions for anybody, so it cannot see a gank coming.

Grade the CHOICE, not the wording. For each case answer:
  "hit"     — the line pointed straight at one of the things that mattered.
  "related" — the line did not name it, but acting on the line would plausibly have prevented or
              enabled one of them.
  "miss"    — the line was about something else entirely.

Return ONLY a JSON array, one object per case in order, each {"verdict":"hit|related|miss","why":"under 15 words"}.
No markdown fences, no prose.`

	const payload = items
		.map(
			(it, i) =>
				`CASE ${i + 1} (clock ${it.clock})\nCOACH SAID: ${it.said}\nCOULD ALSO HAVE SAID: ${
					it.others.length > 0 ? it.others.join(" | ") : "(nothing else)"
				}\nWHAT MATTERED NEXT: ${it.mattered.join(" | ")}`
		)
		.join("\n\n")

	const res = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${JUDGE_MODEL}:generateContent`,
		{
			method: "POST",
			headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ parts: [{ text: `${rubric}\n\n${payload}\n` }] }],
				generationConfig: { temperature: 0 }
			})
		}
	)
	if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
	const body = (await res.json()) as {
		candidates?: { content?: { parts?: { text?: string }[] } }[]
	}
	const text = (body.candidates?.[0]?.content?.parts ?? [])
		.map(p => p.text ?? "")
		.join("")
		.trim()
	/*
	 * A reasoning model wraps JSON in fences about half the time and there is no honest way to
	 * stop it, so the fences are stripped rather than the answer being thrown away. A truncated
	 * body is reported as a judge failure, never quietly treated as a miss.
	 */
	const cleaned = text.replace(/^```(?:json)?/, "").replace(/```$/, "").trim()
	const parsed = JSON.parse(cleaned) as { verdict: string; why: string }[]
	if (!Array.isArray(parsed)) throw new Error("judge did not return an array")
	return parsed
}

/* -------------------------------------------------------------------- main */

interface Totals {
	events: number
	foreseeable: number
	covered: number
	readoutOnly: number
	neither: number
	polls: number
	speaking: number
}

/** One recorded game: replay it, score it, print its section, and hand back the numbers. */
const runOne = async (
	file: string,
	report: Record<string, unknown>,
	judgeCases: { clock: string; said: string; others: string[]; mattered: string[] }[]
): Promise<Record<number, Totals>> => {
	if (!existsSync(file)) throw new Error(`no sample stream at ${file}`)
	const rows = readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map(l => JSON.parse(l) as { gameTime: number; data: unknown })
	const tl = timelineFromSamples(rows)
	const spoken = await replay(rows)

	console.log(`\n=== ${file} ===`)
	console.log(
		`${tl.ticks.length} polls, ${tl.events.length} events, ${tl.me}, ${clock(
			tl.ticks[tl.ticks.length - 1]?.atSec ?? 0
		)} long`
	)
	const speaking = spoken.filter(s => s.facts.length > 0)
	console.log(
		`the coach had something to offer at ${speaking.length} of ${spoken.length} polls (${pct(
			speaking.length,
			spoken.length
		)})`
	)

	/* What it actually offered, by kind. This is the owner's complaint, quantified. */
	const kinds = new Map<FactKind, number>()
	for (const s of speaking) {
		const k = factKind(s.facts[0]!)
		kinds.set(k, (kinds.get(k) ?? 0) + 1)
	}
	console.log("\ntop-ranked fact, by kind:")
	for (const [k, n] of [...kinds.entries()].sort((a, b) => b[1] - a[1]))
		console.log(`  ${String(n).padStart(4)}  ${pct(n, speaking.length).padStart(4)}  ${k}`)

	const totals: Record<number, Totals> = {}
	const perFile: Record<string, unknown> = {}

	for (const h of HORIZON_LIST) {
		const { all, lines } = aggregate(tl, spoken, h)

		/*
		 * SPLIT BY KIND, and this is not presentation — it is the difference between a number that
		 * means something and one that does not.
		 *
		 * `race-lost` / `race-won` are CONTINUOUS STATE, re-derived at every poll: over a
		 * 90-second horizon one drifting CS gap produces eighteen overlapping "consequences", so
		 * folding them into a single total buries the game's actual events under farm arithmetic —
		 * the exact complaint that started this probe, reproduced inside the instrument built to
		 * measure it. Events are counted as events. Swings are counted separately and named.
		 */
		const isSwing = (k: string): boolean => k === "race-lost" || k === "race-won"
		const events = all.filter(c => !isSwing(c.kind))
		const swings = all.filter(c => isSwing(c.kind))

		/*
		 * TWO buckets here, not three, and the reason matters.
		 *
		 * The three-way `block` / `frame-only` / `none` split is a property of a (moment,
		 * consequence) PAIR, and it is reported that way further down. Rolled up to a consequence
		 * it degenerates: the sampler polls every five seconds, so every consequence has a tick
		 * within five seconds of it and is therefore at least `frame-only` by construction.
		 * Printing a `none` column here would print a structural zero and read as a finding.
		 */
		const scored = events.filter(c => c.best === "block")
		const unscored = events.filter(c => c.best !== "block")
		const covered = scored.filter(c => c.spokenTo.length > 0)
		const coveredTop = scored.filter(c => c.spokenTo.some(s => s.top))
		const silent = scored.filter(c => c.offered === 0)
		const afterOnly = scored.filter(c => c.spokenTo.length === 0 && c.spokenAfter.length > 0)
		const neither = scored.filter(c => c.spokenTo.length === 0 && c.spokenAfter.length === 0)

		console.log(`\n--- horizon ${h}s ---`)
		console.log(
			`${events.length} consequential EVENTS (kills, deaths, objectives, fights) + ${swings.length} continuous state swings`
		)
		console.log(
			`  foreseeable from the block  ${String(scored.length).padStart(4)}  (the only ones scored)`
		)
		console.log(
			`  not foreseeable, not scored ${String(unscored.length).padStart(
				4
			)}  (at best forming inside the last ${SITUATION_LEAD} seconds)`
		)
		console.log(
			`AHEAD OF IT:   ${String(covered.length).padStart(4)} (${pct(
				covered.length,
				scored.length
			)})  a linked fact was on offer before it happened; RANKED FIRST for ${coveredTop.length}`
		)
		console.log(
			`ONLY AFTER IT: ${String(afterOnly.length).padStart(4)} (${pct(
				afterOnly.length,
				scored.length
			)})  mentioned only once it had already happened${
				afterOnly.length > 0 ?
					` — e.g. ${afterOnly
						.slice(0, 2)
						.map(c => `${clock(c.atSec)} ${c.evidence} (said at ${clock(c.spokenAfter[0]!.atSec)})`)
						.join("; ")}`
				:	""
			}`
		)
		console.log(
			`NEVER AT ALL:  ${String(neither.length).padStart(4)} (${pct(
				neither.length,
				scored.length
			)})  never mentioned either side of it; ${silent.length} of those had a wholly silent lead-up`
		)

		/*
		 * How many facts were on the table at once.
		 *
		 * The prompt lets the model choose from a ranked list of up to three, but nearly every
		 * branch in `buildFacts` returns `slice(0, 1)` — measured on the reference game the "list"
		 * was one item 50 times out of 52. That makes AHEAD OF IT and RANKED FIRST the same
		 * number, and it means the ranking is not choosing between candidates; it is deciding
		 * whether to speak at all.
		 */
		const offers = new Map<number, number>()
		for (const l of lines) offers.set(l.facts.length, (offers.get(l.facts.length) ?? 0) + 1)
		console.log(
			`  the list held ${[...offers.entries()]
				.sort((a, b) => a[0] - b[0])
				.map(([n, c]) => `${n} fact${n === 1 ? "" : "s"} ${c} times`)
				.join(", ")}`
		)

		console.log(`  by kind:`)
		const kindRows = new Map<string, { n: number; fore: number; cov: number; top: number }>()
		for (const c of all) {
			const r = kindRows.get(c.kind) ?? { n: 0, fore: 0, cov: 0, top: 0 }
			r.n += 1
			if (c.best === "block") {
				r.fore += 1
				if (c.spokenTo.length > 0) r.cov += 1
				if (c.spokenTo.some(s => s.top)) r.top += 1
			}
			kindRows.set(c.kind, r)
		}
		for (const [k, r] of [...kindRows.entries()].sort((a, b) => b[1].fore - a[1].fore))
			console.log(
				`    ${k.padEnd(15)} ${String(r.n).padStart(4)} happened  ${String(r.fore).padStart(
					4
				)} foreseeable  ${String(r.cov).padStart(4)} pointed at first  ${String(r.top).padStart(
					4
				)} ranked first`
			)

		/*
		 * The per-MOMENT three-way, which is where the classification is meaningful and is the
		 * honest answer to "how much of what mattered could it have known".
		 */
		let bl = 0
		let fr = 0
		let nn = 0
		for (const t of tl.ticks)
			for (const c of consequencesAfter(tl, t.atSec, h)) {
				if (isSwing(c.kind)) continue
				if (c.foresight === "block") bl += 1
				else if (c.foresight === "frame-only") fr += 1
				else nn += 1
			}
		const seen = bl + fr + nn
		console.log(
			`  across all ${tl.ticks.length} polls, of everything consequential in the next ${h}s: ${pct(
				bl,
				seen
			)} had a precursor in the block, ${pct(fr, seen)} only in the picture, ${pct(
				nn,
				seen
			)} nowhere at all`
		)

		const missed = scored.filter(c => c.spokenTo.length === 0).sort((a, b) => b.weight - a.weight)
		if (missed.length > 0) {
			console.log(`\n  biggest foreseeable moments nobody was pointed at:`)
			for (const m of missed.slice(0, 8))
				console.log(
					`    ${clock(m.atSec).padStart(6)}  ${m.evidence}  [${m.because}]${
						m.offered === 0 ?
							"  (coach said nothing at all)"
						:	`  (offered ${m.offered} other facts)`
					}`
				)
		}

		perFile[String(h)] = {
			events: events.length,
			swings: swings.length,
			foreseeable: scored.length,
			notForeseeable: unscored.length,
			covered: covered.length,
			coveredTop: coveredTop.length,
			readoutOnly: afterOnly.length,
			/* `neither` duplicates `neverMentioned` under the name `Totals` uses, because a child
			 * process's report is read back as `Totals` by the parent that spawned it. */
			neverMentioned: neither.length,
			neither: neither.length,
			polls: tl.ticks.length,
			speaking: speaking.length,
			silentThrough: silent.length,
			perMoment: { block: bl, frameOnly: fr, none: nn },
			byKind: Object.fromEntries(kindRows),
			missed: missed.map(m => ({
				atSec: Math.round(m.atSec),
				evidence: m.evidence,
				because: m.because,
				offered: m.offered
			}))
		}
		totals[h] = {
			events: events.length,
			foreseeable: scored.length,
			covered: covered.length,
			readoutOnly: afterOnly.length,
			neither: neither.length,
			polls: tl.ticks.length,
			speaking: speaking.length
		}

		if (flag("verbose"))
			for (const l of lines)
				console.log(
					`  ${clock(l.atSec).padStart(6)}  ${l.topHit ? "HIT " : "    "}${l.facts[0]}  ->  ${
						l.target ? l.target.evidence : "(nothing foreseeable)"
					}`
				)
	}

	/* Judge cases are pooled across games and graded in one call at the end. Always collected —
	 * it costs nothing, and a child process (see `main`) must hand them up whether or not IT was
	 * the process that will do the judging. */
	{
		const h = HORIZON_LIST[1] ?? HORIZON_LIST[0]!
		for (const s of speaking) {
			const r = regretAt(tl, s.atSec, s.facts, h)
			/*
			 * EVENTS ONLY in what the judge is shown, and this is not a detail.
			 *
			 * A drifting CS gap is "foreseeable" at literally every poll, so leaving the swings in
			 * the list let a farm line be graded a hit for pointing at a farm number — the
			 * instrument agreeing with the coach because both were looking at the same tedious
			 * fact. Measured, that scored 11 hits of 21 with six of them CS lines. Judge the choice
			 * against what actually happened on the map; the swings are in the table above, where
			 * they can be read without being mistaken for coaching.
			 */
			const mattered = r.foreseeable.filter(c => c.kind !== "race-lost" && c.kind !== "race-won")
			if (mattered.length === 0) continue
			judgeCases.push({
				clock: `${clock(s.atSec)} ${file.replace(/^.*\//, "")}`,
				said: s.facts[0]!,
				others: s.facts.slice(1),
				mattered: mattered.slice(0, 4).map(c => `${clock(c.atSec)} ${c.evidence}`)
			})
		}
	}

	;(report.games as Record<string, unknown>)[file] = perFile
	report.cases = judgeCases
	return totals
}

const main = async () => {
	const report: Record<string, unknown> = { samples: SAMPLES, games: {}, totals: {} }
	const judgeCases: { clock: string; said: string; others: string[]; mattered: string[] }[] = []
	const summed: Record<number, Totals> = {}

	const add = (t: Record<number, Totals>): void => {
		for (const [h, v] of Object.entries(t)) {
			const acc = summed[Number(h)] ?? {
				events: 0,
				foreseeable: 0,
				covered: 0,
				readoutOnly: 0,
				neither: 0,
				polls: 0,
				speaking: 0
			}
			for (const k of Object.keys(acc) as (keyof Totals)[]) acc[k] += v[k]
			summed[Number(h)] = acc
		}
	}

	if (SAMPLES.length === 1) {
		add(await runOne(SAMPLES[0]!, report, judgeCases))
	} else {
		/*
		 * ONE CHILD PROCESS PER GAME, and this is a correctness requirement, not tidiness.
		 *
		 * `buildFacts`'s rate-limiting memory lives at MODULE scope in `routes/live.ts` and is
		 * cleared inside `buildLiveState` only when there is no game — a branch
		 * `buildLiveStateForBench` returns before ever reaching, because it bails on a null sample
		 * first. So a second game replayed in the same process inherits game one's announce-once
		 * sets and cooldowns and is structurally quieter.
		 *
		 * Measured, replaying these four games in one process collapsed 148 speaking polls to 65
		 * and moved the headline from 24% to 17%. That is not a small distortion, it is most of
		 * the coach, and `scripts/bench-providers.ts --from-samples` shares the same exported
		 * entry point — so anything that replays more than one game through it has the same
		 * problem. A fresh process is the only reset available from outside the module.
		 */
		const dir = mkdtempSync(`${tmpdir()}/probe-regret-`)
		for (const [i, file] of SAMPLES.entries()) {
			const out = `${dir}/${i}.json`
			const child = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--no-warnings=ExperimentalWarning",
					process.argv[1]!,
					"--samples",
					file,
					"--horizons",
					HORIZON_LIST.join(","),
					"--exclude",
					String(EXCLUDE),
					...(flag("verbose") ? ["--verbose"] : []),
					"--out",
					out
				],
				{ stdio: ["ignore", "inherit", "inherit"] }
			)
			if (child.status !== 0) throw new Error(`replay of ${file} failed`)
			const sub = JSON.parse(readFileSync(out, "utf8")) as {
				games: Record<string, Record<string, Totals>>
				cases: typeof judgeCases
			}
			;(report.games as Record<string, unknown>)[file] = sub.games[file]
			judgeCases.push(...sub.cases)
			const t: Record<number, Totals> = {}
			for (const [h, v] of Object.entries(sub.games[file] ?? {})) t[Number(h)] = v as Totals
			add(t)
		}
	}

	if (SAMPLES.length > 1) {
		console.log(`\n=== TOTALS over ${SAMPLES.length} games ===`)
		for (const [h, t] of Object.entries(summed))
			console.log(
				`  horizon ${h}s: ${t.polls} polls, spoke at ${t.speaking}; ${t.events} events, ${
					t.foreseeable
				} foreseeable — AHEAD ${t.covered} (${pct(t.covered, t.foreseeable)}), ONLY AFTER ${
					t.readoutOnly
				} (${pct(t.readoutOnly, t.foreseeable)}), NEVER ${t.neither} (${pct(
					t.neither,
					t.foreseeable
				)})`
			)
	}
	report.totals = summed

	/* ------------------------------------------------------------- judged */

	if (flag("judge") && judgeCases.length > 0) {
		/*
		 * Evenly spaced rather than the first N. The first N would all come from the early game,
		 * where the only facts that exist are farm ones — the sample would agree with the
		 * complaint by construction.
		 */
		const step = Math.max(1, Math.ceil(judgeCases.length / JUDGE_LIMIT))
		const picked = judgeCases.filter((_, i) => i % step === 0).slice(0, JUDGE_LIMIT)
		console.log(`\n--- judged (${JUDGE_MODEL}, ${picked.length} of ${judgeCases.length} cases) ---`)
		try {
			const verdicts = await judgeBatch(picked)
			const tally = new Map<string, number>()
			for (const [i, v] of verdicts.entries()) {
				tally.set(v.verdict, (tally.get(v.verdict) ?? 0) + 1)
				console.log(
					`  ${picked[i]?.clock.padStart(18)}  ${v.verdict.padEnd(8)} ${picked[i]?.said.slice(0, 58)}`
				)
				console.log(`          ${v.why}`)
			}
			console.log(
				`\n  ${[...tally.entries()].map(([k, n]) => `${k} ${n}/${verdicts.length}`).join(", ")}`
			)
			report.judged = { model: JUDGE_MODEL, cases: picked, verdicts }
		} catch (e) {
			// A judge failure is reported, never silently counted as a miss.
			console.error(`! judge failed: ${(e as Error).message}`)
			report.judged = { model: JUDGE_MODEL, error: (e as Error).message }
		}
	}

	const out = arg("out", "")
	if (out !== "") {
		writeFileSync(out, `${JSON.stringify(report, null, "\t")}\n`)
		console.log(`\nwrote ${out}`)
	}
}

const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`)

await main()
