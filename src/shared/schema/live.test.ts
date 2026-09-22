/**
 * The ground-truth boundary, replayed against every game this machine has ever recorded.
 *
 * ## Why this test is a corpus replay and not a fixture
 *
 * On 2026-09-19 this schema threw away 363 consecutive polls — a whole Arena game and the tail of
 * a practice-tool game — because `allPlayers[].runes` arrived as `null` where an optional key had
 * been declared, and because one practice-tool row sent `items` as an object. Nothing in the suite
 * noticed, and nothing could have: every fixture in this repo was hand-written from Summoner's
 * Rift, which is the one mode the feed was already known to agree with.
 *
 * `data/live-samples/` holds the raw client JSON of every game the daemon has sampled. It is the
 * only thing on the machine that is a statement about what the client REALLY sends. So the test is
 * the corpus: every sampled payload must validate, and a future edit that narrows the schema under
 * real data fails here rather than eighteen minutes into a game.
 *
 * ## The corpus is survivorship-biased and that is the point of saying so
 *
 * `daemon/supervisor.ts` records what `LiveClient.allGameData()` RETURNED, and that call used to
 * return `null` on any schema error. So a sample the schema rejected was never written down: the
 * corpus can only ever contain payloads the schema of the day accepted, and a full replay of it
 * necessarily reports 100%. Measured before any change in this session, on the unmodified schema:
 *
 *     20,067 samples, 20,067 validated, 0 rejected, 0 torn
 *
 * That number proves the schema does not reject what it has already accepted. It cannot prove the
 * schema accepts what the client sends, and the 363 lost polls are the proof that it did not. So
 * this file carries BOTH halves: the corpus replay below, and — further down — the two real faults
 * from the journal, reproduced by taking a recorded payload and putting back exactly the value the
 * journal says arrived. That is still built from recorded data; only the one field the log names
 * is changed, and the log line it must reproduce is quoted beside it.
 */

import { ok, strictEqual } from "node:assert/strict"
import { createReadStream, existsSync, readdirSync } from "node:fs"
import { createInterface } from "node:readline"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { LiveAllGameData, MAX_TOLERANCE_ROUNDS, parseAllGameData } from "./live.ts"

const SAMPLE_DIR = fileURLToPath(new URL("../../../data/live-samples", import.meta.url))

/**
 * Parse one line in every `STRIDE`, plus the first and last of every file.
 *
 * Cost, measured on this machine on 2026-09-22 with
 * `node --experimental-strip-types --test src/shared/schema/live.test.ts`: the corpus is 95 files,
 * 20,067 samples and 629 MB, and replaying ALL of it makes this file take **11.3s**, which is more
 * than the rest of the suite and is how a test gets commented out. At `STRIDE = 7` it checks
 * **2,982** samples and the file takes **5.1s**.
 *
 * The coverage that matters is not reduced by the stride, because every fault this boundary has
 * ever had was a property of a GAME (a mode that sends `runes: null` on every poll) or of a PHASE
 * (the last fourteen seconds of a game), never of one poll in the middle of a file. Both ends of
 * every file are always parsed, for the second of those reasons.
 *
 * `LIVE_CORPUS_FULL=1 pnpm test` replays all 20,067 and is what to run after touching the schema.
 */
const STRIDE = 7
const FULL = process.env.LIVE_CORPUS_FULL === "1"

interface Replay {
	files: number
	checked: number
	lines: number
	/** Payloads the strict validator refused outright. Must be zero. */
	rejected: { file: string; line: number; summary: string }[]
	/** Payloads that needed a field removed to pass. Must be zero on recorded data. */
	repaired: { file: string; line: number; paths: string[] }[]
	torn: number
	/** `player.items=array` -> how many rows. The shape census, so a change in the feed is visible. */
	shapes: Map<string, number>
	rosterSizes: Map<number, number>
	playerRows: number
}

const shapeOf = (v: unknown): string =>
	v === undefined ? "absent"
	: v === null ? "null"
	: Array.isArray(v) ? "array"
	: typeof v === "object" ? "object"
	: typeof v

const replayCorpus = async (): Promise<Replay> => {
	const out: Replay = {
		files: 0,
		checked: 0,
		lines: 0,
		rejected: [],
		repaired: [],
		torn: 0,
		shapes: new Map(),
		rosterSizes: new Map(),
		playerRows: 0
	}
	const bump = (k: string): void => {
		out.shapes.set(k, (out.shapes.get(k) ?? 0) + 1)
	}
	const files = readdirSync(SAMPLE_DIR).filter(f => f.endsWith(".ndjson")).sort()
	for (const file of files) {
		out.files += 1
		// The last line of a file is held back and parsed at EOF: the practice-tool `items` fault
		// lived entirely in the final fourteen seconds of its game.
		let held: { line: string; n: number } | null = null
		let n = 0
		const rl = createInterface({
			input: createReadStream(`${SAMPLE_DIR}/${file}`),
			crlfDelay: Infinity
		})
		const check = (line: string, at: number): void => {
			out.checked += 1
			let sample: { data: unknown }
			try {
				sample = JSON.parse(line) as { data: unknown }
			} catch {
				// A process killed mid-append leaves a torn last line. Counted, never fatal.
				out.torn += 1
				return
			}
			const strict = LiveAllGameData(sample.data)
			const parsed = parseAllGameData(sample.data)
			if (!parsed.ok) out.rejected.push({ file, line: at, summary: parsed.summary })
			else if (parsed.dropped.length > 0)
				out.repaired.push({ file, line: at, paths: parsed.dropped.map(d => d.path) })
			// The strict validator and the tolerant one must agree on data that is already good,
			// or the tolerant path is quietly doing something to every payload in a real game.
			if (strict instanceof Error === false && parsed.ok) strictEqual(parsed.data, sample.data)
			const d = (sample.data ?? {}) as Record<string, unknown>
			for (const k of ["gameData", "activePlayer", "allPlayers", "events"])
				bump(`top.${k}=${shapeOf(d[k])}`)
			const players = Array.isArray(d.allPlayers) ? (d.allPlayers as Record<string, unknown>[]) : []
			out.rosterSizes.set(players.length, (out.rosterSizes.get(players.length) ?? 0) + 1)
			for (const p of players) {
				out.playerRows += 1
				for (const k of ["championName", "team", "level", "isDead", "items", "runes", "scores", "summonerSpells"])
					bump(`player.${k}=${shapeOf(p[k])}`)
			}
		}
		for await (const line of rl) {
			if (line.trim() === "") continue
			out.lines += 1
			// The previous line is checked now, so the LAST one can always be checked at EOF
			// whatever the stride landed on.
			if (held !== null && (FULL || held.n % STRIDE === 0)) check(held.line, held.n)
			held = { line, n }
			n += 1
		}
		if (held !== null) check(held.line, held.n)
	}
	return out
}

/**
 * ONE pass over the corpus, shared by every assertion that needs it.
 *
 * Measured: the walk costs 3.6s at `STRIDE = 7` and the file asked for it twice, so the suite paid
 * 8.3s to read the same 629 MB twice over. Memoising it is the difference between a test that runs
 * on every commit and one that gets commented out.
 */
let corpus: Promise<Replay> | null = null
const recordedCorpus = (): Promise<Replay> => (corpus ??= replayCorpus())

describe("the live schema against every recorded game", () => {
	it("has a corpus to replay at all", () => {
		// Loud on purpose. A silently empty corpus turns every assertion below into a no-op, and
		// this repo has already lost a corpus once to a routine restart — see `isRecorderFile` in
		// `daemon/live-sampler.ts`. A skipped test would have hidden that too.
		ok(
			existsSync(SAMPLE_DIR),
			`${SAMPLE_DIR} is missing. This test IS the corpus; without it the live schema is unverified.`
		)
		ok(
			readdirSync(SAMPLE_DIR).filter(f => f.endsWith(".ndjson")).length > 0,
			`${SAMPLE_DIR} holds no .ndjson samples. The live schema is unverified.`
		)
	})

	it("validates every sampled payload, with nothing repaired", async () => {
		const r = await recordedCorpus()
		// Named counts in the failure message: a regression here has to say WHICH game and field.
		strictEqual(
			r.rejected.length,
			0,
			`rejected ${r.rejected.length} recorded payloads: ${JSON.stringify(r.rejected.slice(0, 5))}`
		)
		strictEqual(
			r.repaired.length,
			0,
			`the tolerant parse had to remove fields from ${r.repaired.length} recorded payloads, which means the schema no longer matches what the client sent: ${JSON.stringify(r.repaired.slice(0, 5))}`
		)
		strictEqual(r.torn, 0, `${r.torn} torn lines — a sample file was truncated`)
		/*
		 * A LOW floor, deliberately, and not an equality.
		 *
		 * Measured 2026-09-22: 95 files, 20,067 lines, 2,982 checked at STRIDE 7, 195,817 player
		 * rows in the full corpus. None of those may be asserted, because this directory is not
		 * stable in either direction — it grows with every game he plays, and `pruneSamples` in
		 * `daemon/live-sampler.ts` evicts oldest-first once it crosses 600 MB, which it has done
		 * and which cost this repo two whole measured games. The job of these three numbers is only
		 * to catch a corpus that has gone EMPTY, because an empty corpus turns every assertion in
		 * this file into a no-op that passes.
		 */
		ok(r.files >= 10, `only ${r.files} sample files`)
		ok(r.checked >= 500, `only ${r.checked} samples checked of ${r.lines}`)
		ok(r.playerRows >= 5_000, `only ${r.playerRows} player rows`)
	})

	it("reports what the feed actually sends, so a shape change is visible rather than fatal", async () => {
		const r = await recordedCorpus()
		const rows = r.playerRows
		/*
		 * Every one of these was counted over the whole corpus on 2026-09-22 — 20,067 samples,
		 * 195,817 player rows — and every one is at 100%:
		 *
		 *   player.runes=object 195,817   player.scores=object 195,817
		 *   player.items=array  195,817 (4,461 of them empty)
		 *   player.championName / team / level / isDead / summonerSpells  195,817 each
		 *
		 * They are asserted as INVARIANTS rather than printed, because each one is a promise some
		 * consumer relies on: `rosterKey` needs `championName` on every row or the game identity
		 * moves, and `truthFromRaw` counts `isDead` across the roster to fence a minimap read.
		 */
		for (const k of ["championName", "team", "level", "isDead", "items", "runes", "scores", "summonerSpells"]) {
			const shapes = [...r.shapes].filter(([key]) => key.startsWith(`player.${k}=`))
			strictEqual(
				shapes.length,
				1,
				`player.${k} arrives in more than one shape in the corpus: ${JSON.stringify(shapes)}`
			)
		}
		strictEqual(r.shapes.get("player.championName=string"), rows)
		strictEqual(r.shapes.get("player.items=array"), rows)
		strictEqual(r.shapes.get("player.runes=object"), rows)
		/*
		 * A SHORT ROSTER IS NORMAL and the tolerance argument leans on it. Measured over the whole
		 * corpus: 19,510 samples carry ten rows, 501 carry one, 54 carry four and 2 carry none.
		 * Those were all fed to the coach and rendered without incident, which is why removing a
		 * field from a row is not a novel state for anything downstream.
		 */
		ok((r.rosterSizes.get(10) ?? 0) > 0, "no ten-player samples")
		ok([...r.rosterSizes.keys()].some(n => n < 10), `every sampled roster is full: ${JSON.stringify([...r.rosterSizes])}`)
	})
})

/* --------------------------------------------------------- the two faults from the journal */

const aRecordedPayload = async (): Promise<Record<string, unknown>> => {
	const files = readdirSync(SAMPLE_DIR).filter(f => f.endsWith(".ndjson")).sort()
	for (const file of files.reverse()) {
		const rl = createInterface({
			input: createReadStream(`${SAMPLE_DIR}/${file}`),
			crlfDelay: Infinity
		})
		for await (const line of rl) {
			if (line.trim() === "") continue
			const sample = JSON.parse(line) as { data: Record<string, unknown> }
			rl.close()
			if (Array.isArray(sample.data.allPlayers) && sample.data.allPlayers.length >= 2)
				return sample.data
		}
	}
	throw new Error(`no recorded payload with a roster in ${SAMPLE_DIR}`)
}

describe("the faults that cost a game", () => {
	it("accepts runes: null on every row — the Arena shape", async () => {
		/*
		 * 2026-09-19 21:47:55 to 21:59:55, game 5645348275, queue 1750 / CHERRY / map 30:
		 *
		 *   WARN [lcu] allgamedata did not match its schema; ignoring.
		 *   allPlayers[0].runes must be an object (was null)
		 *   ... allPlayers[17].runes must be an object (was null)
		 *
		 * 356 polls, eighteen rows each, the entire game. The value is put back onto a REAL
		 * recorded payload rather than typed out as a fixture, so what is under test is the actual
		 * roster the client sends with one field set to what the client actually set it to.
		 */
		const data = await aRecordedPayload()
		const broken = structuredClone(data)
		for (const p of broken.allPlayers as Record<string, unknown>[]) p.runes = null
		const parsed = parseAllGameData(broken)
		ok(parsed.ok, `rejected: ${parsed.ok ? "" : parsed.summary}`)
		// Not merely accepted — accepted with nothing removed, because the key is `unknown` now.
		strictEqual(parsed.dropped.length, 0)
		strictEqual((parsed.data.allPlayers ?? []).length, (data.allPlayers as unknown[]).length)
	})

	it("keeps the lobby when one row's items arrive as an object", async () => {
		/*
		 * 2026-09-19 21:42:26 to 21:42:39, game 5645344114 (PRACTICETOOL), the last fourteen
		 * seconds of the game, seven consecutive polls:
		 *
		 *   allPlayers[1].items must be an array (was object)
		 *
		 * One row, one field. It used to cost the whole payload.
		 */
		const data = await aRecordedPayload()
		const broken = structuredClone(data)
		const rows = broken.allPlayers as Record<string, unknown>[]
		rows[1]!.items = {}
		const parsed = parseAllGameData(broken)
		ok(parsed.ok, `rejected: ${parsed.ok ? "" : parsed.summary}`)
		strictEqual(parsed.dropped.length, 1)
		strictEqual(parsed.dropped[0]!.path, "allPlayers[1].items")
		strictEqual(parsed.dropped[0]!.expected, "an array")
		strictEqual(parsed.dropped[0]!.actual, "{}")
		// The log line has to name a player, not an array index.
		const row = (data.allPlayers as Record<string, unknown>[])[1]!
		strictEqual(parsed.dropped[0]!.who, `${String(row.championName)} (${String(row.team)})`)
		// Everything else on that row survives, and every other row is untouched.
		const kept = (parsed.data.allPlayers ?? [])[1]!
		strictEqual(kept.items, undefined)
		strictEqual(kept.championName, row.championName)
		strictEqual(kept.level, row.level)
		strictEqual(kept.isDead, row.isDead)
		strictEqual((parsed.data.allPlayers ?? []).length, rows.length)
	})

	it("does not move the roster key, which is the app's game identity", async () => {
		/*
		 * The whole reason tolerance is per FIELD and not per ROW. `rosterKey` in
		 * `server/routes/live.ts` joins `championName` across `allPlayers`, and when it changes
		 * `observeLiveSample` throws the coach's memory away and `resetFrameState()` runs. A
		 * dropped row would have done that twice per fault episode — once going, once coming back.
		 */
		const data = await aRecordedPayload()
		const key = (d: { allPlayers?: { championName?: string }[] }): string =>
			(d.allPlayers ?? []).map(p => p.championName ?? "?").join("|")
		const broken = structuredClone(data)
		const rows = broken.allPlayers as Record<string, unknown>[]
		rows[1]!.items = {}
		rows[0]!.scores = "no"
		const parsed = parseAllGameData(broken)
		ok(parsed.ok)
		strictEqual(parsed.dropped.length, 2)
		strictEqual(key(parsed.data), key(data as { allPlayers?: { championName?: string }[] }))
	})

	it("never mutates the payload it was handed", async () => {
		// `daemon/live-sampler.ts` records what comes back out, and a caller may still want to see
		// what arrived. The repair works on a clone.
		const data = await aRecordedPayload()
		const broken = structuredClone(data)
		;(broken.allPlayers as Record<string, unknown>[])[1]!.items = {}
		const parsed = parseAllGameData(broken)
		ok(parsed.ok)
		strictEqual(
			JSON.stringify((broken.allPlayers as Record<string, unknown>[])[1]!.items),
			"{}"
		)
	})
})

describe("what the tolerant parse still refuses", () => {
	it("rejects a payload whose event rows lose a required key", async () => {
		/*
		 * `EventID` is required and is the dedupe key for the entire event feed. Removing it is
		 * not a degradation, it is a silent duplicate every poll. This is terminal by CONSTRUCTION
		 * rather than by a list of required names: the key is removed once, fails again as
		 * missing, is no longer present to remove, no progress is made, and the payload is
		 * rejected. A required key added to this schema later is covered without anyone editing
		 * this test.
		 */
		const data = await aRecordedPayload()
		const broken = structuredClone(data)
		broken.events = { Events: [{ EventID: "one", EventName: "GameStart" }] }
		const parsed = parseAllGameData(broken)
		strictEqual(parsed.ok, false)
		ok(!parsed.ok && parsed.summary.includes("EventID"), parsed.ok ? "" : parsed.summary)
	})

	it("charges a bad array ELEMENT to the array's own key", async () => {
		/*
		 * `items[2]` being a string is not a removable element: splicing it out renumbers the list,
		 * and a renumbered item list is a different claim about his build rather than a smaller
		 * one. The `items` key goes instead, and the log has to carry BOTH paths, because "we do
		 * not have his items" and "one of his item rows was a string" are different sentences.
		 */
		const data = await aRecordedPayload()
		const broken = structuredClone(data)
		const rows = broken.allPlayers as Record<string, unknown>[]
		const target = rows.findIndex(p => Array.isArray(p.items) && (p.items as unknown[]).length > 2)
		ok(target >= 0, "no recorded row with three items — pick a later sample")
		;(rows[target]!.items as unknown[])[2] = "Liandry's, probably"
		const parsed = parseAllGameData(broken)
		ok(parsed.ok, parsed.ok ? "" : parsed.summary)
		strictEqual(parsed.dropped.length, 1)
		strictEqual(parsed.dropped[0]!.path, `allPlayers[${target}].items`)
		strictEqual(parsed.dropped[0]!.errorPath, `allPlayers[${target}].items[2]`)
		strictEqual(parsed.dropped[0]!.actual, `"Liandry's, probably"`)
		// The row survives with everything but its items, and no other row is touched.
		strictEqual((parsed.data.allPlayers ?? [])[target]!.items, undefined)
		strictEqual(
			(parsed.data.allPlayers ?? [])[target]!.championName,
			(data.allPlayers as Record<string, unknown>[])[target]!.championName
		)
		strictEqual((parsed.data.allPlayers ?? []).length, rows.length)
	})

	it("drops the event list rather than the game when an event row is malformed", async () => {
		/*
		 * The one case where walking up to the array's key drops something large, and the reason
		 * it is safe: `daemon/supervisor.ts` and `daemon/journal.ts` both call `allGameData()`
		 * with no `eventID`, so the feed re-sends the WHOLE event list on every poll two seconds
		 * later. Losing one poll's copy of a cumulative list costs nothing the next poll does not
		 * return; losing the payload costs the roster, the clock and the sample.
		 */
		const data = await aRecordedPayload()
		const broken = structuredClone(data)
		broken.events = { Events: [{ EventID: 0, EventName: "GameStart" }, "someone died"] }
		const parsed = parseAllGameData(broken)
		ok(parsed.ok, parsed.ok ? "" : parsed.summary)
		strictEqual(parsed.dropped.length, 1)
		strictEqual(parsed.dropped[0]!.path, "events.Events")
		strictEqual(parsed.dropped[0]!.errorPath, "events.Events[1]")
		strictEqual(parsed.data.events?.Events, undefined)
		// The half that matters is still there.
		strictEqual((parsed.data.allPlayers ?? []).length, (data.allPlayers as unknown[]).length)
	})

	it("rejects a player ROW that is not an object, rather than dropping it", async () => {
		// Walking up from `allPlayers[3]` reaches `allPlayers`, a top-level section, which is
		// blocked — so the row-drop this design refused cannot come back in through the array rule.
		const data = await aRecordedPayload()
		const broken = structuredClone(data)
		;(broken.allPlayers as unknown[])[1] = "Kayn, allegedly"
		const parsed = parseAllGameData(broken)
		strictEqual(parsed.ok, false)
		strictEqual(parsed.dropped.length, 0)
	})

	it("rejects an error that names a container rather than a field", async () => {
		// `allPlayers` not being an array names nothing removable — there is no key whose absence
		// would make this a valid payload, and guessing one would be inventing a lobby.
		const data = await aRecordedPayload()
		const parsed = parseAllGameData({ ...data, allPlayers: "ten players" })
		strictEqual(parsed.ok, false)
	})

	it("converges in one round on the real faults, and is bounded on anything else", async () => {
		// The bound exists so a pathological payload cannot spin; it is not an expectation.
		ok(MAX_TOLERANCE_ROUNDS >= 2 && MAX_TOLERANCE_ROUNDS <= 8)
		const data = await aRecordedPayload()
		const broken = structuredClone(data)
		for (const p of broken.allPlayers as Record<string, unknown>[]) {
			p.items = {}
			p.scores = 3
			p.level = "four"
		}
		const parsed = parseAllGameData(broken)
		ok(parsed.ok)
		strictEqual(parsed.dropped.length, (data.allPlayers as unknown[]).length * 3)
		// Every row still has its champion, so the roster key is still the roster key.
		for (const p of parsed.data.allPlayers ?? []) ok(typeof p.championName === "string")
	})

	it("survives junk without throwing", () => {
		for (const junk of [null, undefined, 3, "x", [], true])
			ok(typeof parseAllGameData(junk).ok === "boolean", JSON.stringify(junk))
	})
})
