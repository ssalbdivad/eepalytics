/**
 * The digit rule is the whole fence, so it is tested harder than anything else here.
 *
 * The mechanism this replaces breached within a day: a general benchmark renderer validated the
 * FORM of a rule and never its SUBJECT, so "his flash is usually back in thirty seconds" rendered
 * and was spoken aloud. A mechanism that can express a number about the game can express a wrong
 * one, so this mechanism cannot express a number at all.
 *
 * The other two things this file exists to hold down:
 *
 *   - the ROTATION actually rotates. Proved by simulating a real thirty-minute game through the
 *     real `buildFacts` with the real cooldown constants, not by argument. The previous attempt's
 *     argument was wrong: its clock-derived index collided with `FARM_COOLDOWN_SEC` and said one
 *     clause three times while never speaking a third at all. That collision is asserted below as
 *     a fact about arithmetic, so nobody re-derives it.
 *   - the SHIPPED files load. A clause the parser drops is worse than no clause, because the file
 *     looks like progress and the coach says nothing new. The last section reads
 *     `knowledge/champions/*.md` off disk and fails on any line that looks like a clause and did
 *     not arrive in the parse.
 */

import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { FARM_COOLDOWN_SEC, buildFacts, newFactMemory } from "../analysis/live-facts.ts"
import { speechDurationSec } from "../analysis/timeliness.ts"
import type { FactInput } from "../analysis/live-facts.ts"
import {
	ADVICE_KINDS,
	CLAUSE_LINE,
	firstOf,
	mergeClauses,
	newAdviceCursor,
	parseChampionAdvice,
	parseChampionClauses,
	resetAdviceCursor,
	rotatingAdvice,
	withAdvice
} from "./champion-advice.ts"
import type { AdviceKind, ChampionAdvice, ChampionClauses } from "./champion-advice.ts"

const wrap = (body: string): string => `intro prose\n\n## Live coaching\n\n${body}\n\n## After\n\nmore`

describe("parseChampionAdvice", () => {
	it("reads clauses for the kinds it knows", () => {
		const a = parseChampionAdvice(wrap("race-behind: finish the route you started\ndeath: you have no dash"))
		deepStrictEqual(a, { "race-behind": "finish the route you started", death: "you have no dash" })
	})

	it("REJECTS any clause containing a digit", () => {
		// The benchmark vector, in both of its shapes.
		const a = parseChampionAdvice(wrap("race-behind: a good Lillia finishes by 3:15\nrestraint: his flash is back in 30 seconds"))
		deepStrictEqual(a, {})
	})

	it("rejects a digit anywhere in the clause, not just at the start", () => {
		strictEqual(parseChampionAdvice(wrap("death: speed will not save you past level 6")).death, undefined)
	})

	it("ignores kinds it does not know, rather than trusting the file", () => {
		strictEqual(Object.keys(parseChampionAdvice(wrap("ward-score: place more wards"))).length, 0)
	})

	it("survives a malformed line, losing only that clause", () => {
		const a = parseChampionAdvice(wrap("this line has no separator\nbuild: itemise into what they built"))
		deepStrictEqual(a, { build: "itemise into what they built" })
	})

	it("stops at the next heading so it cannot swallow the file", () => {
		const md = "## Live coaching\n\nrace-behind: keep the route going\n\n## Other\n\ndeath: should not load"
		strictEqual(parseChampionAdvice(md).death, undefined)
	})

	it("returns nothing when the section is absent", () => {
		deepStrictEqual(parseChampionAdvice("# Notes\n\nprose only"), {})
	})

	it("still takes the first clause when a kind offers several", () => {
		// The pre-rotation surface, unchanged: every existing caller keeps its old behaviour.
		const md = wrap("death: the first one\ndeath: the second one")
		deepStrictEqual(parseChampionAdvice(md), { death: "the first one" })
	})
})

describe("parseChampionClauses", () => {
	it("keeps EVERY clause for a kind, in file order", () => {
		const md = wrap("death: leave before you are committed\ndeath: speed is not a dash\nbuild: buy at the clear")
		deepStrictEqual(parseChampionClauses(md), {
			death: ["leave before you are committed", "speed is not a dash"],
			build: ["buy at the clear"]
		})
	})

	it("applies the digit rule PER CLAUSE, so one bad variant does not cost the good ones", () => {
		/*
		 * The failure this prevents is quiet: with a whole-kind rejection, one careless "level 6"
		 * in the third variant would take the two correct clauses down with it and the coach would
		 * go silent on that kind for the champion.
		 */
		const md = wrap("death: leave before you are committed\ndeath: your escape is speed past level 6\ndeath: no dash means no exit")
		deepStrictEqual(parseChampionClauses(md).death, [
			"leave before you are committed",
			"no dash means no exit"
		])
	})

	it("drops an exact duplicate, because a rotation that repeats itself is not one", () => {
		const md = wrap("death: the same clause\ndeath: the same clause\ndeath: a different one")
		deepStrictEqual(parseChampionClauses(md).death, ["the same clause", "a different one"])
	})

	it("reads a bulleted list as readily as a plain one", () => {
		deepStrictEqual(parseChampionClauses(wrap("- death: leave early\n* death: no dash")).death, [
			"leave early",
			"no dash"
		])
	})

	it("does not mistake prose containing a colon for a clause", () => {
		// `_default.md` really does open with "Kept deliberately plain: a generic clause ...".
		const md = wrap("Kept deliberately plain: a generic clause that fits any jungler.\ndeath: leave early")
		deepStrictEqual(parseChampionClauses(md), { death: ["leave early"] })
	})
})

describe("mergeClauses", () => {
	const roleDefault: ChampionClauses = {
		death: ["check with a ward before you cross"],
		"farm-behind": ["a full clear beats a gank that is not ready"]
	}

	it("overrides a kind the champion file speaks to, and keeps the rest", () => {
		const merged = mergeClauses(roleDefault, { death: ["your escape is speed"] })
		deepStrictEqual(merged, {
			death: ["your escape is speed"],
			"farm-behind": ["a full clear beats a gank that is not ready"]
		})
	})

	it("does not blend the two, because a specific clause diluted by a generic one is worse", () => {
		const merged = mergeClauses(roleDefault, { death: ["a", "b"] })
		deepStrictEqual(merged.death, ["a", "b"])
	})

	it("is the fix for a champion file with no Live coaching section at all", () => {
		/*
		 * `championNote()` only falls back to `_default.md` when NO file matches, so before this a
		 * champion file without the section turned champion advice OFF for that champion — having
		 * a file was strictly worse than having none. Three of the four shipped files were in
		 * exactly that state.
		 */
		const merged = mergeClauses(roleDefault, parseChampionClauses("# Trundle\n\nprose only"))
		deepStrictEqual(merged, roleDefault)
	})

	it("copies rather than aliasing, so a later merge cannot mutate an earlier layer", () => {
		const merged = mergeClauses(roleDefault)
		merged.death!.push("mutated")
		deepStrictEqual(roleDefault.death, ["check with a ward before you cross"])
	})
})

describe("rotatingAdvice", () => {
	const clauses: ChampionClauses = { death: ["one", "two", "three"], build: ["only"] }

	it("with no cursor is byte-identical to the old surface", () => {
		const md = wrap("death: one\ndeath: two\nbuild: only")
		deepStrictEqual({ ...rotatingAdvice(parseChampionClauses(md)) }, parseChampionAdvice(md))
		deepStrictEqual({ ...rotatingAdvice(clauses) }, firstOf(clauses))
	})

	it("hands out the next clause on each new view", () => {
		const cursor = newAdviceCursor()
		const said = [0, 1, 2, 3].map(() => rotatingAdvice(clauses, cursor).death)
		deepStrictEqual(said, ["one", "two", "three", "one"])
	})

	it("advances a kind at most once per view, however many times it is read", () => {
		/*
		 * `buildFacts` reads `advice.death` twice for one death — once in the guard that decides
		 * whether there is anything to say, once in the body that says it. One firing must cost one
		 * step, or a champion with three death clauses would skip one every time.
		 */
		const cursor = newAdviceCursor()
		const view = rotatingAdvice(clauses, cursor)
		strictEqual(view.death, "one")
		strictEqual(view.death, "one")
		strictEqual(view.death, "one")
		strictEqual(rotatingAdvice(clauses, cursor).death, "two")
	})

	it("rotates each kind independently — an unread kind does not advance", () => {
		const cursor = newAdviceCursor()
		rotatingAdvice(clauses, cursor).death
		rotatingAdvice(clauses, cursor).death
		strictEqual(rotatingAdvice(clauses, cursor).build, "only")
		strictEqual(cursor.fired["farm-behind"], undefined)
		strictEqual(rotatingAdvice(clauses, cursor).death, "three")
	})

	it("leaves a kind with no clauses absent, so `withAdvice` still no-ops", () => {
		const view = rotatingAdvice({ death: [] }, newAdviceCursor())
		strictEqual(view.death, undefined)
		strictEqual(withAdvice("Kayn is 23 CS up on you", view["race-behind"]), "Kayn is 23 CS up on you")
	})

	it("starts the next game at the top of the rotation", () => {
		const cursor = newAdviceCursor()
		rotatingAdvice(clauses, cursor).death
		rotatingAdvice(clauses, cursor).death
		resetAdviceCursor(cursor)
		strictEqual(rotatingAdvice(clauses, cursor).death, "one")
	})
})

/**
 * The proof, over the real ranker.
 *
 * A thirty-minute game at the daemon's own five-second poll, with a farm deficit that stays open
 * and CS that keeps climbing, is the case the player actually quit on: six of his nine lines were
 * about farm. `buildFacts` gates that kind on `FARM_COOLDOWN_SEC` and on his CS having moved, so
 * this drives the real constants rather than a lookalike.
 */
describe("the rotation, simulated over a real game", () => {
	const FARM_LINE = / CS down on your own pace/
	const FIRST_FIRE_SEC = 8 * 60

	const clauses: ChampionClauses = {
		"farm-behind": ["variant one", "variant two", "variant three"]
	}

	const tick = (nowSec: number, advice: ChampionAdvice): FactInput => {
		// Climbing CS with a fixed deficit: the gap is always worth saying, and his CS moves enough
		// between mentions to clear the "has anything actually changed" gate.
		const cs = 70 + Math.round(((nowSec - FIRST_FIRE_SEC) / 60) * 7)
		return {
			nowSec,
			meDeadForSec: null,
			deadEnemies: [],
			currentGold: null,
			pace: { cs, expected: cs + 25, exact: true },
			counterpart: null,
			advice,
			enemyObjectives: [],
			myEvents: [],
			alliesAlive: 5,
			enemiesAlive: 5,
			drakeBackInSec: null,
			baronBackInSec: null,
			heraldBackInSec: null
		}
	}

	/** Replay the game and return every farm line spoken, with the clock it was spoken at. */
	const replay = (): { atSec: number; line: string }[] => {
		const mem = newFactMemory()
		const cursor = newAdviceCursor()
		const said: { atSec: number; line: string }[] = []
		for (let t = FIRST_FIRE_SEC; t <= 30 * 60; t += 5) {
			// A fresh view per turn over one cursor — exactly what `routes/live.ts` builds.
			for (const line of buildFacts(tick(t, rotatingAdvice(clauses, cursor)), mem))
				if (FARM_LINE.test(line)) said.push({ atSec: t, line })
		}
		return said
	}

	/*
	 * These used to assert that farm fires at least three times in a game. It no longer does: the
	 * ranker was deliberately quietened this session (offers per minute 0.80 -> 0.48 over five real
	 * games, CS-or-farm as the opening fact 46 -> 7), which is a product win and makes a cadence
	 * assumption the wrong thing for a rotation test to rest on.
	 *
	 * So the guarantee is stated without reference to how often a kind fires: whatever the ranker
	 * offers, no two consecutive firings of a kind say the same thing, and the mechanism itself is
	 * exercised directly.
	 */
	it("never says the same thing twice running, however often the kind fires", () => {
		const said = replay().map(s => s.line)
		for (let i = 1; i < said.length; i++)
			ok(said[i] !== said[i - 1], `repeated verbatim at firing ${i}: ${said[i]}`)
	})

	it("rotates through every variant when a kind is read repeatedly", () => {
		// The mechanism, driven directly: reading a kind is what advances it, so N reads of a kind
		// with N clauses must produce all N, in order, and then wrap.
		const cursor = newAdviceCursor()
		const variants = clauses["farm-behind"]!
		const seen: string[] = []
		for (let i = 0; i < variants.length * 2; i++)
			seen.push(rotatingAdvice(clauses, cursor)["farm-behind"] ?? "")
		strictEqual(new Set(seen).size, variants.length, `stranded a variant: ${JSON.stringify(seen)}`)
		deepStrictEqual(seen.slice(0, variants.length), variants)
		deepStrictEqual(seen.slice(variants.length), variants, "did not wrap cleanly")
	})

	it("attaches the clause behind the number rather than replacing it", () => {
		const said = replay().map(s => s.line)
		ok(said.length > 0, "the ranker offered no farm line at all")
		for (const line of said) {
			ok(/^you're \d+ CS down on your own pace/.test(line), `the number is not first: ${line}`)
			ok(
				clauses["farm-behind"]!.some(c => line.endsWith(` — ${c}`)),
				`not one of the shipped clauses: ${line}`
			)
		}
	})

	it("is why the index is the firing count and NOT the clock", () => {
		/*
		 * The previous attempt used `Math.floor(secs / 60) % variants`. The farm kind fires every
		 * `FARM_COOLDOWN_SEC`, and 180 seconds is exactly three minutes, so with three variants
		 * every firing lands on the same residue: it said one clause three times and never spoke a
		 * third at all. This is arithmetic, not a judgement call, so it is asserted rather than
		 * argued.
		 */
		/*
		 * Asserted from the COOLDOWN, not from a replay. The ranker was quietened this session and
		 * a synthetic constant deficit no longer fires farm three times, but the collision is a
		 * property of the arithmetic and holds whenever it does fire on its cooldown.
		 */
		const fired = [0, 1, 2].map(i => FIRST_FIRE_SEC + i * FARM_COOLDOWN_SEC)
		const byClock = fired.map(sec => Math.floor(sec / 60) % 3)
		strictEqual(new Set(byClock).size, 1, `the clock index would have varied: ${byClock}`)
		const byCount = fired.map((_, i) => i % 3)
		strictEqual(new Set(byCount).size, 3)
	})
})

/**
 * The guard that would have caught the silent loss.
 *
 * Work on these files has already been done once and reverted, and the tell was not a failing
 * test — it was a passing one over an empty directory. So this reads the SHIPPED markdown off
 * disk and fails when a line that looks like a clause did not arrive in the parse. Knowledge the
 * parser drops is worse than none, because the file reads as progress and the coach says nothing
 * new.
 */
describe("the shipped champion files", () => {
	const CHAMPIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../../knowledge/champions")

	/**
	 * How long a clause may be, in characters.
	 *
	 * Measured: the first attempt at multiple variants pushed the median SPOKEN line from 88 to
	 * 123 characters and the longest to 154 — around twelve seconds of speech, from a coach
	 * specified to say one sentence roughly a second behind the game. A clause that cannot be said
	 * briefly is not ready. The longest clause shipping today is 92.
	 */
	const MAX_CLAUSE_CHARS = 110

	const files = readdirSync(CHAMPIONS)
		.filter(f => f.endsWith(".md"))
		.sort()

	/** The `## Live coaching` block of a file, sliced the same way the parser slices it. */
	const section = (md: string): string => {
		const start = md.indexOf("## Live coaching")
		if (start < 0) return ""
		const rest = md.slice(start)
		const end = rest.indexOf("\n## ", 1)
		return end < 0 ? rest : rest.slice(0, end)
	}

	it("has files to check at all", () => {
		// A directory that has been emptied must fail loudly rather than pass vacuously — that is
		// precisely how a night of this work went missing without a red test.
		ok(files.includes("_default.md"), "`_default.md` is missing")
		ok(files.length > 1, "no champion files on disk")
	})

	for (const file of files)
		describe(file, () => {
			const md = readFileSync(join(CHAMPIONS, file), "utf8")
			const lines = section(md)
				.split("\n")
				.map(l => l.trim())
				.filter(l => l !== "" && !l.startsWith("#"))
				.map(l => CLAUSE_LINE.exec(l))
				.filter((m): m is RegExpExecArray => m !== null)
			const loaded = parseChampionClauses(md)

			it("names only fact kinds the coach actually has", () => {
				for (const m of lines)
					ok(
						(ADVICE_KINDS as readonly string[]).includes(m[1]!),
						`"${m[1]}:" is not a fact kind — it will never be spoken. Kinds: ${ADVICE_KINDS.join(", ")}`
					)
			})

			it("writes no digit into a clause, which would be refused at load", () => {
				for (const m of lines)
					ok(
						!/\d/.test(m[2]!),
						`"${m[1]}: ${m[2]}" contains a number and is silently dropped. Numbers come from the client.`
					)
			})

			it("LOADS every line that looks like a clause", () => {
				for (const m of lines) {
					const kind = m[1] as AdviceKind
					const clause = m[2]!.trim()
					ok(
						loaded[kind]?.includes(clause),
						`"${kind}: ${clause}" is in the file and did NOT load. A dropped clause reads as progress and changes nothing.`
					)
				}
			})

			it("keeps every clause sayable in one breath", () => {
				for (const m of lines)
					ok(
						m[2]!.trim().length <= MAX_CLAUSE_CHARS,
						`"${m[1]}" is ${m[2]!.trim().length} chars, over ${MAX_CLAUSE_CHARS}: ${m[2]}`
					)
			})

			it("keeps the SPOKEN line sayable, which is the quantity he actually hears", () => {
				/*
				 * The cap above measures the clause. He hears the whole sentence — the fact stem the
				 * client proved, then the clause. Measuring only the clause let the spoken line grow
				 * without anything noticing: 32 of 126 rendered lines were over the cap, longest 132,
				 * while every clause passed.
				 *
				 * The budget is per KIND, because the stems differ enormously. `farm-behind` spends
				 * about forty characters ("you're roughly 18 CS down on your own pace") before the
				 * clause even starts, and it is the most frequently fired kind, so its clauses have
				 * to be the shortest in every file.
				 *
				 * Speech, not characters, is the real constraint: measured on real TTS this session,
				 * a line runs 1.18 + 0.189 x syllables seconds. A 140-character sentence is about
				 * six seconds, said by a coach specified to speak roughly one second behind the game.
				 */
				const STEM: Record<string, string> = {
					"race-behind": "Briar is roughly 18 CS up on you",
					"race-ahead": "you're roughly 18 CS up on Briar",
					restraint: "you're 2 levels down on Briar",
					"fight-lost": "that fight was 1 for 3",
					"fight-absent": "that fight was 0 for 2 without you",
					death: "",
					build: "Briar just finished Stridebreaker",
					"farm-behind": "you're roughly 18 CS down on your own pace"
				}
				/*
				 * The ceiling is in SECONDS, not characters, because seconds are the constraint.
				 * `speechDurationSec` is the fit measured on real TTS this session (1.18 + 0.189 x
				 * syllables, R2 0.895, n=24), so this asserts the thing the player experiences
				 * rather than a proxy for it.
				 *
				 * Where it sits today, measured over all 126 shipped combinations: median 6.5s,
				 * p90 7.2s, max 7.8s — against 3.4s for the bare `farm-behind` stem. **Champion
				 * advice roughly DOUBLES the time she is talking.** That is a real trade and it is
				 * pinned here rather than left to drift: 8.0s is a ceiling that permits today and
				 * catches the next clause that runs long.
				 */
				const MAX_SPOKEN_SEC = 8
				const over: string[] = []
				for (const m of lines) {
					const kind = m[1]!.trim()
					const stem = STEM[kind]
					if (stem === undefined) continue
					const spoken = withAdvice(stem, m[2]!.trim())
					const sec = speechDurationSec(spoken)
					if (sec > MAX_SPOKEN_SEC) over.push(`${sec.toFixed(1)}s: ${spoken}`)
				}
				ok(over.length === 0, `over ${MAX_SPOKEN_SEC}s spoken:\n${over.join("\n")}`)
			})

			it("still has something to say for every kind once merged with the role default", () => {
				/*
				 * The real surface is the merge, not the file — which is what makes a champion file
				 * with no Live coaching section harmless again rather than a silencer.
				 */
				const merged =
					file === "_default.md" ?
						loaded
					:	mergeClauses(parseChampionClauses(readFileSync(join(CHAMPIONS, "_default.md"), "utf8")), loaded)
				for (const kind of ADVICE_KINDS)
					ok((merged[kind]?.length ?? 0) > 0, `nothing to say for "${kind}"`)
			})
		})

	it("has a role default for every kind, since that is what the merge falls back on", () => {
		const roleDefault = parseChampionClauses(readFileSync(join(CHAMPIONS, "_default.md"), "utf8"))
		for (const kind of ADVICE_KINDS)
			ok((roleDefault[kind]?.length ?? 0) > 0, `_default.md has no clause for "${kind}"`)
	})

	it("rotates the SHIPPED Lillia clauses through the real ranker, merged as production merges them", () => {
		/*
		 * The production configuration end to end: `_default.md` under `lillia.md`, merged per
		 * kind, rotated on the firing count, driven by the real `buildFacts` over the same
		 * thirty-minute game. This is the composition `routes/live.ts` builds every turn, and it is
		 * the one the player hears — the synthetic simulation above proves the mechanism, this
		 * proves the thing actually shipping.
		 */
		const clauses = mergeClauses(
			parseChampionClauses(readFileSync(join(CHAMPIONS, "_default.md"), "utf8")),
			parseChampionClauses(readFileSync(join(CHAMPIONS, "lillia.md"), "utf8"))
		)
		const mem = newFactMemory()
		const cursor = newAdviceCursor()
		const said: string[] = []
		for (let t = 8 * 60; t <= 30 * 60; t += 5) {
			const cs = 70 + Math.round(((t - 8 * 60) / 60) * 7)
			for (const line of buildFacts(
				{
					nowSec: t,
					meDeadForSec: null,
					deadEnemies: [],
					currentGold: null,
					pace: { cs, expected: cs + 25, exact: true },
					counterpart: null,
					advice: rotatingAdvice(clauses, cursor),
					enemyObjectives: [],
					myEvents: [],
					alliesAlive: 5,
					enemiesAlive: 5,
					drakeBackInSec: null,
					baronBackInSec: null,
					heraldBackInSec: null
				},
				mem
			))
				if (/ CS down on your own pace/.test(line)) said.push(line)
		}
		/*
		 * No lower bound on the COUNT. The ranker was quietened deliberately this session, so how
		 * often farm fires is a product decision that may keep moving; what must never move is that
		 * consecutive firings differ and every line is a shipped clause.
		 */
		ok(said.length >= 1, "the shipped configuration offered no farm line at all")
		for (let i = 1; i < said.length; i++)
			ok(said[i] !== said[i - 1], `repeated verbatim at firing ${i}: ${said[i]}`)
		strictEqual(
			new Set(said).size,
			Math.min(said.length, clauses["farm-behind"]!.length),
			`the shipped farm lines repeated:\n${said.join("\n")}`
		)
	})

	it("rotates the shipped clauses rather than repeating one", () => {
		// Whatever the files hold, a kind with several clauses must actually cycle through them.
		const cursor = newAdviceCursor()
		for (const file of files) {
			const clauses = parseChampionClauses(readFileSync(join(CHAMPIONS, file), "utf8"))
			for (const kind of ADVICE_KINDS) {
				const list = clauses[kind]
				if (!list || list.length < 2) continue
				resetAdviceCursor(cursor)
				const said = list.map(() => rotatingAdvice(clauses, cursor)[kind])
				strictEqual(new Set(said).size, list.length, `${file} "${kind}" repeated: ${said.join(" | ")}`)
				notStrictEqual(said[0], said[1])
			}
		}
	})
})

describe("withAdvice", () => {
	it("puts the number first and the advice second", () => {
		strictEqual(
			withAdvice("Kayn is 23 CS up on you.", "finish the route you started"),
			"Kayn is 23 CS up on you — finish the route you started"
		)
	})

	it("drops a generic tail rather than stacking two instructions", () => {
		// The fight module's lines close on their own advice; the champion clause is the better of
		// the two, and one breath does not hold both.
		strictEqual(
			withAdvice(
				"that fight was 0 for 2 without you, so back off and catch up",
				"get on the map before the next one starts"
			),
			"that fight was 0 for 2 without you — get on the map before the next one starts"
		)
	})

	it("keeps a fact that merely contains the word so", () => {
		strictEqual(
			withAdvice("Kayn is 23 CS up on you", "finish the route"),
			"Kayn is 23 CS up on you — finish the route"
		)
	})

	it("returns the fact untouched when the champion has no note", () => {
		strictEqual(withAdvice("Kayn is 23 CS up on you", undefined), "Kayn is 23 CS up on you")
	})
})
